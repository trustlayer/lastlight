import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { OAuthAuth, OAuthCredential } from "@earendil-works/pi-ai";
import { resolveOAuthApiKeyWith, updateAuthMap, type AuthMap } from "lastlight-shared/oauth";

// The harness, the CLI and pi all write auth.json. pi rotates a refresh token
// under a proper-lockfile lock (`FileAuthStorageBackend` in
// @earendil-works/pi-coding-agent), and lastlight-shared now takes the same
// lock. These tests hold that lock with pi's options, in this process and in
// a second process, which is what a docker guest is to the host.

const HOUR_MS = 3_600_000;
const repoRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
/** proper-lockfile as lastlight-shared resolves it — apps/server has no direct dependency. */
const properLockfilePath = createRequire(join(repoRoot, "packages/shared/package.json")).resolve("proper-lockfile");
/** The lock options of pi's FileAuthStorageBackend.acquireLockAsync. */
const PI_LOCK_OPTIONS = { realpath: false, retries: 0, stale: 30_000 } as const;

function credential(access: string, expires: number): AuthMap[string] {
  return { type: "oauth", access, refresh: `${access}-refresh`, expires };
}

function fakeOAuth() {
  const refresh = vi.fn(async (current: OAuthCredential) => ({
    ...current,
    access: "refreshed-by-host",
    refresh: "refreshed-by-host-refresh",
    expires: Date.now() + HOUR_MS,
  }));
  const toAuth = vi.fn(async (current: OAuthCredential) => ({ apiKey: current.access }));
  return { refresh, toAuth, auth: { refresh, toAuth } as unknown as Pick<OAuthAuth, "refresh" | "toAuth"> };
}

function readStore(path: string): AuthMap {
  return JSON.parse(readFileSync(path, "utf8")) as AuthMap;
}

/**
 * Start a second process that takes the store lock with pi's options, writes
 * `rotated` to the store after `holdMs`, and releases. Resolves when the child
 * holds the lock; `done` resolves when the child exits.
 */
async function holdLockInOtherProcess(
  store: string,
  rotated: AuthMap,
  holdMs: number,
): Promise<{ done: Promise<number | null> }> {
  const script = `
    const { createRequire } = await import("node:module");
    const { writeFileSync } = await import("node:fs");
    const lockfile = createRequire(process.cwd() + "/")(process.env.PROPER_LOCKFILE);
    const release = await lockfile.lock(process.env.STORE, JSON.parse(process.env.LOCK_OPTIONS));
    process.stdout.write("locked\\n");
    await new Promise((r) => setTimeout(r, Number(process.env.HOLD_MS)));
    writeFileSync(process.env.STORE, process.env.ROTATED, { mode: 0o600 });
    await release();
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...process.env,
      PROPER_LOCKFILE: properLockfilePath,
      STORE: store,
      LOCK_OPTIONS: JSON.stringify(PI_LOCK_OPTIONS),
      HOLD_MS: String(holdMs),
      ROTATED: JSON.stringify(rotated, null, 2),
    },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const done = new Promise<number | null>((res) => child.on("exit", res));
  await new Promise<void>((res, rej) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("locked")) res();
    });
    child.on("exit", (code) => rej(new Error(`lock holder exited early with code ${code}`)));
  });
  return { done };
}

describe("oauth store lock", () => {
  let dir: string;
  let store: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ll-oauth-lock-"));
    store = join(dir, "auth.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("returns a valid token without a refresh and without a write", async () => {
    const content = JSON.stringify({ "openai-codex": credential("valid", Date.now() + HOUR_MS) }, null, 2);
    writeFileSync(store, content, { mode: 0o600 });
    const { refresh, auth } = fakeOAuth();

    const res = await resolveOAuthApiKeyWith("openai-codex", auth, store);

    expect(res?.apiKey).toBe("valid");
    expect(refresh).not.toHaveBeenCalled();
    expect(readFileSync(store, "utf8")).toBe(content);
    expect(existsSync(`${store}.lock`)).toBe(false);
  });

  it("refreshes an expired token once, keeps the other logins, and releases the lock", async () => {
    writeFileSync(
      store,
      JSON.stringify({
        "openai-codex": credential("expired", Date.now() - 1_000),
        anthropic: credential("other-provider", Date.now() + HOUR_MS),
      }),
      { mode: 0o600 },
    );
    const { refresh, auth } = fakeOAuth();

    const res = await resolveOAuthApiKeyWith("openai-codex", auth, store);

    expect(res?.apiKey).toBe("refreshed-by-host");
    expect(refresh).toHaveBeenCalledTimes(1);
    const after = readStore(store);
    expect(after["openai-codex"]).toMatchObject({ type: "oauth", access: "refreshed-by-host" });
    expect(after.anthropic).toMatchObject({ type: "oauth", access: "other-provider" });
    expect(statSync(store).mode & 0o777).toBe(0o600);
    expect(existsSync(`${store}.lock`)).toBe(false);
  });

  it("refreshes once when two callers find the same expired token", async () => {
    writeFileSync(store, JSON.stringify({ "openai-codex": credential("expired", Date.now() - 1_000) }), {
      mode: 0o600,
    });
    const { refresh, auth } = fakeOAuth();

    const [a, b] = await Promise.all([
      resolveOAuthApiKeyWith("openai-codex", auth, store),
      resolveOAuthApiKeyWith("openai-codex", auth, store),
    ]);

    // The second caller waits for the lock, reads the rotated token again, and
    // does not spend the refresh token a second time.
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(a?.apiKey).toBe("refreshed-by-host");
    expect(b?.apiKey).toBe("refreshed-by-host");
  });

  it("uses the token that another process rotated while it waited for the lock", async () => {
    // The sequence of the review: the store has an expired token, the guest
    // (another process) holds the lock and rotates it, and the host resolves
    // the same provider meanwhile. Before the lock, the host refreshed the
    // spent token or wrote its stale copy back over the rotated one.
    writeFileSync(
      store,
      JSON.stringify({
        "openai-codex": credential("expired", Date.now() - 1_000),
        anthropic: credential("other-provider", Date.now() + HOUR_MS),
      }),
      { mode: 0o600 },
    );
    const rotated: AuthMap = {
      "openai-codex": credential("rotated-by-guest", Date.now() + HOUR_MS),
      anthropic: credential("other-provider", Date.now() + HOUR_MS),
    };
    const { done } = await holdLockInOtherProcess(store, rotated, 300);
    const { refresh, auth } = fakeOAuth();

    const res = await resolveOAuthApiKeyWith("openai-codex", auth, store);

    expect(await done).toBe(0);
    expect(refresh).not.toHaveBeenCalled();
    expect(res?.apiKey).toBe("rotated-by-guest");
    expect(readStore(store)["openai-codex"]).toMatchObject({ access: "rotated-by-guest" });
    expect(readStore(store).anthropic).toMatchObject({ access: "other-provider" });
  });

  it("waits for a lock that another process holds before a CLI-style update", async () => {
    writeFileSync(store, JSON.stringify({}), { mode: 0o600 });
    const rotated: AuthMap = { anthropic: credential("rotated-by-guest", Date.now() + HOUR_MS) };
    const { done } = await holdLockInOtherProcess(store, rotated, 300);

    // What `lastlight oauth login openai-codex` does after the browser flow.
    await updateAuthMap(
      (map) => ({ result: undefined, next: { ...map, "openai-codex": credential("login", Date.now() + HOUR_MS) } }),
      store,
    );

    expect(await done).toBe(0);
    const after = readStore(store);
    expect(after.anthropic).toMatchObject({ access: "rotated-by-guest" });
    expect(after["openai-codex"]).toMatchObject({ access: "login" });
  });

  it("returns null and creates no store when the store does not exist", async () => {
    const { refresh, auth } = fakeOAuth();
    await expect(resolveOAuthApiKeyWith("openai-codex", auth, store)).resolves.toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    expect(existsSync(store)).toBe(false);
  });

  it("leaves the store unchanged and releases the lock when the refresh fails", async () => {
    const content = JSON.stringify({ "openai-codex": credential("expired", Date.now() - 1_000) });
    writeFileSync(store, content, { mode: 0o600 });
    const { refresh, auth } = fakeOAuth();
    refresh.mockRejectedValueOnce(new Error("invalid_grant"));

    await expect(resolveOAuthApiKeyWith("openai-codex", auth, store)).rejects.toThrow("invalid_grant");

    expect(readFileSync(store, "utf8")).toBe(content);
    expect(existsSync(`${store}.lock`)).toBe(false);
  });

  it("refuses to write over a store that is not valid JSON", async () => {
    writeFileSync(store, "{ not json", { mode: 0o600 });
    const fn = vi.fn(() => ({ result: undefined, next: {} }));

    await expect(updateAuthMap(fn, store)).rejects.toThrow();

    expect(fn).not.toHaveBeenCalled();
    expect(readFileSync(store, "utf8")).toBe("{ not json");
  });

  it("writes nothing when the update returns no next map", async () => {
    const content = JSON.stringify({ anthropic: credential("kept", Date.now() + HOUR_MS) });
    writeFileSync(store, content, { mode: 0o600 });

    const result = await updateAuthMap((map) => ({ result: Object.keys(map).length }), store);

    expect(result).toBe(1);
    expect(readFileSync(store, "utf8")).toBe(content);
  });
});
