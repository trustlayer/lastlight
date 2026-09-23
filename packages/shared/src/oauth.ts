/**
 * OAuth credential management for LLM providers that authenticate with a
 * subscription login instead of a static API key — ChatGPT Plus/Pro (Codex),
 * Claude Pro/Max, and GitHub Copilot.
 *
 * pi-ai (`@earendil-works/pi-ai/oauth`) owns the actual OAuth flows, token
 * refresh, and credential→apiKey conversion; this module is the thin Last
 * Light layer on top:
 *   - a single on-disk credential store (`auth.json`, same JSON shape pi-ai's
 *     own CLI writes) resolved under `$STATE_DIR` so the CLI (writer) and the
 *     running harness (reader) agree on one path,
 *   - `resolveOAuthApiKey()` — refresh-if-expired + persist rotated creds +
 *     return a usable key, used by the in-process chat path,
 *   - `updateAuthMap()` — every read-modify-write of the store, under the
 *     lock that pi also takes (see "The store lock" below),
 *   - the model-prefix → provider-id map and the sandbox env-var route so the
 *     chat and sandbox executors can both find the right credential.
 *
 * Two consumption seams, and the sandbox seam has three routes:
 *   - **chat** (in-process pi-ai) — passes `apiKey` in the stream options, so
 *     ALL three OAuth providers work, Codex included.
 *   - **sandbox** (agentic-pi) — has no apiKey option. It reads the credential
 *     store through `--auth-file`, or a provider token from the environment:
 *       1. in-process backends (`gondolin`, `none`) get the host store path,
 *       2. the `docker` backend gets the same store as `/data/auth.json`,
 *          because the harness state dir is mounted there,
 *       3. a container backend that mounts no store (`smol`) needs the env var
 *          from `oauthEnvVarForProvider` — `ANTHROPIC_OAUTH_TOKEN` or
 *          `COPILOT_GITHUB_TOKEN`. Codex has no env var, so only route 1 and
 *          route 2 carry it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import type {
  AuthInteraction,
  ProviderAuthInteraction,
  OAuthAuth,
  OAuthCredential,
  OAuthCredentials,
} from "@earendil-works/pi-ai";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { OAUTH_PROVIDERS, oauthProviderByModelPrefix, oauthProviderById } from "./providers.js";

/** Stored form — pi-ai's CLI tags each entry with `type: "oauth"`; we match it. */
export type StoredCredentials = OAuthCredentials & { type?: string };
export type AuthMap = Record<string, StoredCredentials>;

/** OAuth providers that CANNOT fall back to an API key — login is mandatory. */
export const OAUTH_ONLY_PROVIDERS: ReadonlySet<string> = new Set(
  OAUTH_PROVIDERS.filter((p) => p.oauthOnly).map((p) => p.id),
);

/** OAuth provider id backing a model spec, or undefined if it's API-key based. */
export function oauthProviderIdForModel(spec: string): string | undefined {
  const prefix = spec.includes("/") ? spec.slice(0, spec.indexOf("/")) : spec;
  return oauthProviderByModelPrefix(prefix)?.id;
}

/**
 * The env var pi-ai reads inside a sandbox for a provider's OAuth token, when
 * one exists. Returns undefined for providers with no env-var route (Codex).
 * Such a provider still authenticates wherever the credential store reaches:
 * the in-process backends and `docker`. It fails only on a container backend
 * that mounts no store (`smol`).
 */
export function oauthEnvVarForProvider(id: string): string | undefined {
  return oauthProviderById(id)?.sandboxEnvVar ?? undefined;
}

/**
 * Resolve the credential-store path. Precedence:
 *   1. explicit argument (a caller-computed path),
 *   2. `LASTLIGHT_AUTH_FILE` (hard override),
 *   3. `<stateDir | $STATE_DIR | ./data>/auth.json`.
 * The CLI writes here and the harness reads here, so both must agree; passing
 * the harness's resolved `stateDir` keeps them aligned even if the process cwd
 * differs.
 */
export function resolveAuthFile(explicit?: string, stateDir?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.LASTLIGHT_AUTH_FILE) return resolve(process.env.LASTLIGHT_AUTH_FILE);
  return resolve(stateDir || process.env.STATE_DIR || "data", "auth.json");
}

export function loadAuthMap(file?: string, stateDir?: string): AuthMap {
  const path = resolveAuthFile(file, stateDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as AuthMap) : {};
  } catch {
    return {};
  }
}

/**
 * Write the whole store WITHOUT the lock. A concurrent writer can lose its
 * change, so use {@link updateAuthMap} for a read-modify-write.
 */
export function saveAuthMap(map: AuthMap, file?: string, stateDir?: string): void {
  const path = resolveAuthFile(file, stateDir);
  mkdirSync(dirname(path), { recursive: true });
  // Mode 0600 — the file holds long-lived refresh tokens.
  writeFileSync(path, JSON.stringify(map, null, 2), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// The store lock.
//
// pi writes the same `auth.json`: in-process for the `gondolin` and `none`
// backends, and inside the guest for `docker`. pi rotates a refresh token under
// a lock (`FileAuthStorageBackend` in @earendil-works/pi-coding-agent), so this
// module takes the SAME lock with the same options. The lock is the directory
// `<store>.lock`, which proper-lockfile creates next to the store. The host and
// a docker guest see the store at different paths (`<state dir>/auth.json`
// and `/data/auth.json`), but both paths name one directory, so they get one
// lock. Without the lock, a writer that read the store before another writer
// rotated a token puts the spent token back.
// ---------------------------------------------------------------------------

/** pi's value: a lock older than this is stale, and a waiter stops at it. */
const AUTH_LOCK_STALE_MS = 30_000;
/** pi's cap on one retry delay. */
const AUTH_LOCK_MAX_DELAY_MS = 2_000;
/**
 * A refresh runs while this process holds the lock, and a waiter gives up after
 * {@link AUTH_LOCK_STALE_MS}. pi uses the same limit.
 */
const OAUTH_REFRESH_TIMEOUT_MS = 15_000;
/** Refresh a token that expires in less than this (pre-empts clock skew). */
const OAUTH_REFRESH_MARGIN_MS = 60_000;

async function acquireAuthLock(
  path: string,
  onCompromised: (err: Error) => void,
): Promise<() => Promise<void>> {
  const deadline = Date.now() + AUTH_LOCK_STALE_MS;
  for (let retry = 0; ; retry++) {
    try {
      return await lockfile.lock(path, {
        realpath: false,
        retries: 0,
        stale: AUTH_LOCK_STALE_MS,
        onCompromised,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      const remainingMs = deadline - Date.now();
      if (code !== "ELOCKED" || remainingMs <= 0) throw err;
      const baseDelayMs = Math.min(10 * 2 ** retry, AUTH_LOCK_MAX_DELAY_MS / 2);
      await sleep(Math.min(Math.round(baseDelayMs * (1 + Math.random())), remainingMs));
    }
  }
}

/**
 * Parse the store for a write. Unlike {@link loadAuthMap}, this throws on a
 * store it cannot read: a write that starts from `{}` deletes every login.
 */
function readAuthMapForWrite(path: string): AuthMap {
  const raw = readFileSync(path, "utf8").replace(/^﻿/, "");
  if (!raw.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`The credential store ${path} does not contain a JSON object`);
  }
  return parsed as AuthMap;
}

/**
 * Read, change and write the store under the lock that pi also takes. `fn`
 * gets the current store, read inside the lock. It returns the value for the
 * caller, and `next` when the store must change. Without `next`, nothing is
 * written.
 *
 * @throws when the lock stays busy for {@link AUTH_LOCK_STALE_MS}, when another
 * process takes a stale lock, or when the store is not valid JSON.
 */
export async function updateAuthMap<T>(
  fn: (current: AuthMap) => Promise<{ result: T; next?: AuthMap }> | { result: T; next?: AuthMap },
  file?: string,
  stateDir?: string,
): Promise<T> {
  const path = resolveAuthFile(file, stateDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // proper-lockfile needs no file, but pi creates one before it locks. `wx`
  // fails when the file exists, so this never overwrites a store.
  try {
    writeFileSync(path, "{}", { flag: "wx", mode: 0o600 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
  }
  let compromised: Error | undefined;
  const release = await acquireAuthLock(path, (err) => {
    compromised = err;
  });
  try {
    const { result, next } = await fn(readAuthMapForWrite(path));
    if (compromised) throw compromised;
    if (next !== undefined) writeFileSync(path, JSON.stringify(next, null, 2), { mode: 0o600 });
    return result;
  } finally {
    // A compromised lock can fail to release. The error above is the one to report.
    await release().catch(() => undefined);
  }
}

export function hasOAuthCredentials(id: string, file?: string, stateDir?: string): boolean {
  return !!loadAuthMap(file, stateDir)[id];
}

export interface OAuthKeyResult {
  apiKey: string;
  credentials: OAuthCredentials;
}

function expiresSoon(credential: StoredCredentials): boolean {
  return typeof credential.expires === "number" && credential.expires < Date.now() + OAUTH_REFRESH_MARGIN_MS;
}

/**
 * Resolve a usable API key for an OAuth provider from stored credentials,
 * refreshing an expired token and persisting the rotated credentials back to
 * the store. Returns null when nothing is stored for `id`. Throws only if a
 * refresh actually fails (expired refresh token, revoked grant) — callers
 * should surface that as "re-run login".
 *
 * The refresh uses double-checked locking, as pi does. A read without the lock
 * finds a valid token in the usual case, and nothing is written. Otherwise the
 * function takes the lock, reads the store again, and refreshes only when the
 * token still expires soon. Another process can have rotated it meanwhile.
 */
export async function resolveOAuthApiKey(
  id: string,
  file?: string,
  stateDir?: string,
): Promise<OAuthKeyResult | null> {
  const oauthAuth = resolveOAuthAuth(id);
  if (!oauthAuth) return null;
  return resolveOAuthApiKeyWith(id, oauthAuth, resolveAuthFile(file, stateDir));
}

/**
 * The core of {@link resolveOAuthApiKey}, with the provider's OAuth flow as an
 * argument. Tests give a fake `refresh` here: pi-ai creates a new provider
 * object on each call, so there is no instance to spy on.
 */
export async function resolveOAuthApiKeyWith(
  id: string,
  oauthAuth: Pick<OAuthAuth, "refresh" | "toAuth">,
  path: string,
): Promise<OAuthKeyResult | null> {
  // No store: do not create one. The orchestrator passes `--auth-file` only
  // for a store that exists.
  if (!existsSync(path)) return null;

  // A read without the lock can see a write of pi in progress, which does not
  // parse. Then the entry is missing here, and the locked read below decides.
  const unlocked = loadAuthMap(path)[id];
  const credential =
    unlocked && !expiresSoon(unlocked)
      ? unlocked
      : await updateAuthMap<StoredCredentials | undefined>(async (current) => {
          const stored = current[id];
          if (!stored) return { result: undefined };
          if (!expiresSoon(stored)) return { result: stored };
          const refreshed = await oauthAuth.refresh(
            stored as OAuthCredential,
            AbortSignal.timeout(OAUTH_REFRESH_TIMEOUT_MS),
          );
          // Persist the rotated credentials so the next refresh chains from the
          // new token rather than re-using a spent one.
          const next: StoredCredentials = { ...refreshed, type: "oauth" };
          return { result: next, next: { ...current, [id]: next } };
        }, path);
  if (!credential) return null;

  // Cast: stored credentials match OAuthCredential shape (type: "oauth" + refresh/access/expires).
  const auth = await oauthAuth.toAuth(credential as OAuthCredential);
  if (!auth.apiKey) return null;
  return { apiKey: auth.apiKey, credentials: credential };
}

// ---------------------------------------------------------------------------
// Adapters for the removed pi-ai `getOAuthApiKey` / `getOAuthProvider` /
// `getOAuthProviders` functions. pi-ai@0.80.10 replaced the old callback-based
// OAuth surface with a new `OAuthAuth` / `AuthInteraction` interface. We
// implement the old shape here so callers in this repo keep working unchanged.
// ---------------------------------------------------------------------------

/** Map a pi-ai provider id to its OAuthAuth implementation (lazily instantiated). */
function resolveOAuthAuth(id: string): OAuthAuth | undefined {
  switch (id) {
    case "anthropic":
      return anthropicProvider().auth.oauth;
    case "github-copilot":
      return githubCopilotProvider().auth.oauth;
    case "openai-codex":
      return openaiCodexProvider().auth.oauth;
    default:
      return undefined;
  }
}

/**
 * Adapt the old `OAuthLoginCallbacks` shape to the new `AuthInteraction`
 * interface expected by `OAuthAuth.login()`.
 */
function adaptToAuthInteraction(callbacks: OAuthLoginCallbacks): ProviderAuthInteraction {
  return {
    // pi-ai 0.83 made `signal` REQUIRED on the provider-facing interaction (and
    // on `refresh`). The old callback surface leaves it optional, so fall back
    // to a controller nobody aborts — that is exactly the previous behaviour
    // (no cancellation), rather than inventing a timeout the caller never asked
    // for.
    signal: callbacks.signal ?? new AbortController().signal,
    notify(event) {
      if (event.type === "auth_url") {
        callbacks.onAuth({ url: event.url, instructions: event.instructions });
      } else if (event.type === "device_code") {
        callbacks.onDeviceCode({
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          intervalSeconds: event.intervalSeconds,
          expiresInSeconds: event.expiresInSeconds,
        });
      } else if (event.type === "progress") {
        callbacks.onProgress?.(event.message);
      }
      // "info" events have no old-API equivalent — silently drop.
    },
    async prompt(p) {
      if (p.type === "select") {
        const result = await callbacks.onSelect({
          message: p.message,
          options: [...p.options],
        });
        return result ?? "";
      }
      if (p.type === "manual_code" && callbacks.onManualCodeInput) {
        return await callbacks.onManualCodeInput();
      }
      return await callbacks.onPrompt({
        message: p.message,
        placeholder: p.placeholder,
      });
    },
  };
}

/** Shape of the provider object the old `getOAuthProvider` API returned. */
export interface LegacyOAuthProvider {
  readonly id: string;
  readonly name: string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
}

/** Returns all OAuth providers in the old callback-surface shape. */
export function getOAuthProviders(): LegacyOAuthProvider[] {
  return OAUTH_PROVIDERS.map((spec) => ({
    id: spec.id,
    name: spec.displayName,
    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const oauthAuth = resolveOAuthAuth(spec.id);
      if (!oauthAuth) throw new Error(`OAuth flow not available for provider: ${spec.id}`);
      return oauthAuth.login(adaptToAuthInteraction(callbacks));
    },
  }));
}

/** Returns the named OAuth provider, or undefined when unknown. */
export function getOAuthProvider(id: string): LegacyOAuthProvider | undefined {
  const spec = OAUTH_PROVIDERS.find((p) => p.id === id);
  if (!spec) return undefined;
  return {
    id: spec.id,
    name: spec.displayName,
    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const oauthAuth = resolveOAuthAuth(spec.id);
      if (!oauthAuth) throw new Error(`OAuth flow not available for provider: ${spec.id}`);
      return oauthAuth.login(adaptToAuthInteraction(callbacks));
    },
  };
}
