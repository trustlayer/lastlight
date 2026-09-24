/**
 * Sentry context for the agent's context snapshot.
 *
 * The Sentry integration for GitHub writes an issue body with a short stack
 * trace only ("N additional frame(s) were not displayed"). The data that
 * explains an error is often in the Sentry event: the full stack, the extra
 * data (for example the queue job), the tags, the breadcrumbs, the trace id.
 *
 * The harness fetches this data on the HOST, before the run starts, and puts
 * it in `contextSnapshot`. The Sentry token stays in the harness process. It
 * never goes into a sandbox, so an agent cannot read it or use it for other
 * requests. The token goes only to `SENTRY_API_URL` (default
 * `https://sentry.io`). A link in the issue selects the organization and the
 * issue id only, never the host.
 *
 * Configuration (environment of the harness):
 *   - `SENTRY_AUTH_TOKEN` — a token with `event:read` (and `project:read`).
 *     Without it, this module does nothing.
 *   - `SENTRY_API_URL`    — optional, for a self-hosted Sentry or a region URL.
 *   - `SENTRY_ORGS`       — optional comma-separated list of organization
 *     slugs. When set, the harness ignores links to other organizations.
 *
 * A failure never fails the run. The harness logs a warning and writes a line
 * in the context that says which link it could not fetch, and why.
 */

import { logger } from "../logging/logger.js";

const log = logger("sentry-context");

const DEFAULT_API_URL = "https://sentry.io";
const DEFAULT_TIMEOUT_MS = 10_000;
/** The maximum length of the text for all issues together. */
const DEFAULT_MAX_CHARS = 40_000;
/** The maximum number of Sentry issues that one run fetches. */
const DEFAULT_MAX_ISSUES = 3;
const MAX_BREADCRUMBS = 30;
/** The maximum length of one JSON block (extra data, contexts, breadcrumb data). */
const MAX_JSON_CHARS = 6_000;

export interface SentryContextOptions {
  token: string;
  apiUrl: string;
  /** Lower-case organization slugs to accept. Empty accepts all. */
  orgs: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxChars?: number;
  maxIssues?: number;
}

/** Read the options from the environment. `undefined` when no token is set. */
export function sentryOptionsFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): SentryContextOptions | undefined {
  const token = env.SENTRY_AUTH_TOKEN?.trim();
  if (!token) return undefined;
  return {
    token,
    apiUrl: (env.SENTRY_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, ""),
    orgs: (env.SENTRY_ORGS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}

export interface SentryIssueRef {
  org: string;
  /** The numeric group id or the short id (for example `CWT-WORKER-DV`). */
  issueId: string;
  url: string;
}

// `https://<org>.sentry.io/issues/<id>/` and
// `https://sentry.io/organizations/<org>/issues/<id>/`. The slug and the id
// have a strict charset, because both go into the path of an API request.
const SUBDOMAIN_RE = /https:\/\/([a-z0-9][a-z0-9-]*)\.sentry\.io\/issues\/([A-Za-z0-9-]+)/g;
const PATH_RE = /https:\/\/sentry\.io\/organizations\/([a-z0-9][a-z0-9-]*)\/issues\/([A-Za-z0-9-]+)/g;

/** Find the links to Sentry issues in a text, without duplicates, in order. */
export function findSentryIssueRefs(text: string, orgs: string[] = []): SentryIssueRef[] {
  const found: Array<SentryIssueRef & { index: number }> = [];
  for (const re of [SUBDOMAIN_RE, PATH_RE]) {
    for (const m of text.matchAll(re)) {
      const org = m[1].toLowerCase();
      // `us.sentry.io`, `de.sentry.io` are region hosts, not organizations.
      if (org === "us" || org === "de" || org === "www") continue;
      if (orgs.length > 0 && !orgs.includes(org)) continue;
      found.push({ org, issueId: m[2], url: m[0], index: m.index ?? 0 });
    }
  }
  found.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const refs: SentryIssueRef[] = [];
  for (const { index: _index, ...ref } of found) {
    const key = `${ref.org}/${ref.issueId.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

/**
 * Fetch the Sentry issues that the text links to, and render them. Returns ""
 * when the text has no link to a Sentry issue.
 */
export async function fetchSentryContext(text: string, opts: SentryContextOptions): Promise<string> {
  const refs = findSentryIssueRefs(text, opts.orgs);
  if (refs.length === 0) return "";
  const maxIssues = opts.maxIssues ?? DEFAULT_MAX_ISSUES;
  const sections: string[] = [];
  for (const ref of refs.slice(0, maxIssues)) {
    try {
      const { issue, event } = await fetchIssueAndLatestEvent(ref, opts);
      sections.push(renderSentryIssue(ref, issue, event));
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err);
      log.warn("Could not fetch the Sentry issue", { url: ref.url, reason });
      sections.push(`### Sentry issue ${ref.url}\n\nThe harness could not fetch this issue: ${reason}`);
    }
  }
  if (refs.length > maxIssues) {
    sections.push(
      `The issue links to ${refs.length} Sentry issues. The harness fetched the first ${maxIssues} only.`,
    );
  }
  return truncate(sections.join("\n\n"), opts.maxChars ?? DEFAULT_MAX_CHARS);
}

type Json = Record<string, unknown>;

async function fetchIssueAndLatestEvent(
  ref: SentryIssueRef,
  opts: SentryContextOptions,
): Promise<{ issue: Json; event: Json }> {
  const base = `${opts.apiUrl}/api/0/organizations/${encodeURIComponent(ref.org)}`;
  let groupId = ref.issueId;
  if (!/^\d+$/.test(groupId)) {
    // A short id. The issue endpoints take the numeric group id only.
    const resolved = await getJson(`${base}/shortids/${encodeURIComponent(groupId)}/`, opts);
    const id = resolved.groupId;
    if (typeof id !== "string" && typeof id !== "number") {
      throw new Error(`Sentry did not resolve the short id ${ref.issueId}`);
    }
    groupId = String(id);
  }
  const issue = await getJson(`${base}/issues/${groupId}/`, opts);
  const event = await getJson(`${base}/issues/${groupId}/events/latest/`, opts);
  return { issue, event };
}

async function getJson(url: string, opts: SentryContextOptions): Promise<Json> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${opts.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!res.ok) {
    // The status only. A response body can echo the request, and the path is
    // enough to find the problem.
    throw new Error(`HTTP ${res.status} from ${new URL(url).pathname}`);
  }
  const body: unknown = await res.json();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`Unexpected response from ${new URL(url).pathname}`);
  }
  return body as Json;
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Render one issue and its latest event as Markdown. Exported for tests. */
export function renderSentryIssue(ref: SentryIssueRef, issue: Json, event: Json): string {
  const out: string[] = [];
  const project = (issue.project as Json | undefined)?.slug;
  out.push(`### Sentry issue ${str(issue.shortId) || ref.issueId}${project ? ` (project ${str(project)})` : ""}`);
  out.push(
    list([
      ["URL", str(issue.permalink) || ref.url],
      ["Title", str(issue.title)],
      ["Culprit", str(issue.culprit)],
      ["Status", str(issue.status)],
      ["Level", str(issue.level)],
      ["Events", str(issue.count)],
      ["Users", str(issue.userCount)],
      ["First seen", str(issue.firstSeen)],
      ["Last seen", str(issue.lastSeen)],
    ]),
  );

  out.push(`#### Latest event ${str(event.eventID)}`);
  const release = event.release as Json | string | null | undefined;
  out.push(
    list([
      ["Date", str(event.dateCreated)],
      ["Release", typeof release === "string" ? release : str(release?.version)],
      ["Message", str(event.message)],
    ]),
  );

  const tags = Array.isArray(event.tags) ? (event.tags as Json[]) : [];
  if (tags.length > 0) {
    out.push("Tags:\n" + tags.map((t) => `- ${str(t.key)}: ${str(t.value)}`).join("\n"));
  }

  const entries = Array.isArray(event.entries) ? (event.entries as Json[]) : [];
  for (const entry of entries) {
    const data = (entry.data ?? {}) as Json;
    if (entry.type === "exception") out.push(renderException(data));
    else if (entry.type === "message" && str(data.formatted)) out.push(`Message:\n${fence(str(data.formatted))}`);
    else if (entry.type === "request") out.push(renderRequest(data));
    else if (entry.type === "breadcrumbs") out.push(renderBreadcrumbs(data));
  }

  const extra = event.context as Json | undefined;
  if (extra && Object.keys(extra).length > 0) out.push(`Extra data:\n${jsonBlock(extra)}`);
  const contexts = event.contexts as Json | undefined;
  if (contexts && Object.keys(contexts).length > 0) out.push(`Contexts:\n${jsonBlock(contexts)}`);

  return out.filter(Boolean).join("\n\n");
}

function renderException(data: Json): string {
  const values = Array.isArray(data.values) ? (data.values as Json[]) : [];
  const parts: string[] = [];
  for (const value of values) {
    const mechanism = value.mechanism as Json | undefined;
    const handled = mechanism && typeof mechanism.handled === "boolean" ? ` (handled: ${mechanism.handled})` : "";
    parts.push(`Exception: ${str(value.type)}: ${str(value.value)}${handled}`);
    const frames = Array.isArray((value.stacktrace as Json | undefined)?.frames)
      ? ((value.stacktrace as Json).frames as Json[])
      : [];
    if (frames.length === 0) continue;
    // Sentry stores the frames with the oldest call first.
    const lines = ["Frames, the most recent call last:"];
    for (const frame of frames) {
      const file = str(frame.filename) || str(frame.absPath) || str(frame.module) || "?";
      const pos = [str(frame.lineNo), str(frame.colNo)].filter(Boolean).join(":");
      lines.push(`  at ${str(frame.function) || "?"} (${file}${pos ? `:${pos}` : ""})${frame.inApp ? " [in app]" : ""}`);
      // Source lines for the application frames only. Library frames add
      // length and seldom help.
      if (frame.inApp && Array.isArray(frame.context)) {
        for (const pair of frame.context as unknown[]) {
          if (!Array.isArray(pair) || pair.length < 2) continue;
          const marker = String(pair[0]) === str(frame.lineNo) ? ">" : " ";
          lines.push(`    ${marker} ${String(pair[0]).padStart(5)} | ${String(pair[1])}`);
        }
      }
    }
    parts.push(fence(lines.join("\n")));
  }
  return parts.join("\n\n");
}

function renderRequest(data: Json): string {
  // Method and URL only. The headers and the cookies can hold credentials.
  const line = [str(data.method), str(data.url)].filter(Boolean).join(" ");
  return line ? `Request: ${line}` : "";
}

function renderBreadcrumbs(data: Json): string {
  const values = Array.isArray(data.values) ? (data.values as Json[]) : [];
  if (values.length === 0) return "";
  const last = values.slice(-MAX_BREADCRUMBS);
  const lines = last.map((b) => {
    const head = [str(b.timestamp), str(b.level), str(b.category)].filter(Boolean).join(" ");
    const extra = b.data && typeof b.data === "object" ? ` ${truncate(JSON.stringify(b.data), 500)}` : "";
    return `- ${head}${str(b.message) ? `: ${str(b.message)}` : ""}${extra}`;
  });
  const skipped = values.length - last.length;
  return `Breadcrumbs${skipped > 0 ? ` (the last ${last.length} of ${values.length})` : ""}:\n${lines.join("\n")}`;
}

function list(rows: Array<[string, string]>): string {
  return rows
    .filter(([, v]) => v)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join("\n");
}

function jsonBlock(value: unknown): string {
  return fence(truncate(JSON.stringify(value, null, 2), MAX_JSON_CHARS), "json");
}

function fence(body: string, lang = ""): string {
  // A fence longer than any backtick run in the body, so the body cannot close it.
  const longest = Math.max(2, ...Array.from(body.matchAll(/`+/g), (m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang}\n${body}\n${f}`;
}

function str(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n[truncated: ${text.length - max} more characters]`;
}
