/**
 * The Sentry context of the context snapshot (`src/engine/sentry-context.ts`).
 * The harness fetches a linked Sentry issue on the host, so the agent sees the
 * full event and the Sentry token stays out of the sandbox.
 *
 * `fetch` is a stub that answers from a map of URL paths and records each
 * request, so the tests can check which host received the token.
 */
import { describe, expect, it } from "vitest";
import {
  fetchSentryContext,
  findSentryIssueRefs,
  sentryOptionsFromEnv,
  type SentryContextOptions,
} from "../../src/engine/sentry-context.js";

const ISSUE = {
  id: "7154094526",
  shortId: "CWT-WORKER-DV",
  title: "MongoServerError: Write conflict during plan execution",
  culprit: "Connection.onMessage(mongodb.lib.cmap:connection)",
  permalink: "https://trustlayer-inc.sentry.io/issues/7154094526/",
  status: "unresolved",
  level: "error",
  count: "4652",
  userCount: 0,
  firstSeen: "2025-12-30T17:43:17.421Z",
  lastSeen: "2026-09-24T14:13:01.000Z",
  project: { slug: "cwt-worker" },
};

const EVENT = {
  eventID: "f46744e9c6454661a1dc9cfcee391e06",
  dateCreated: "2026-09-24T14:13:01.180Z",
  release: { version: "v26-39.f9265d3091" },
  tags: [
    { key: "environment", value: "production" },
    { key: "server_name", value: "trustlayer-cwt-worker-compliance-f9c48ffb9-z9prv" },
  ],
  entries: [
    {
      type: "exception",
      data: {
        values: [
          {
            type: "MongoServerError",
            value: "Write conflict during plan execution",
            mechanism: { type: "generic", handled: true },
            stacktrace: {
              frames: [
                {
                  function: "refreshPartyCompliance",
                  filename: "/app/src/jobs/compliance.ts",
                  lineNo: 42,
                  colNo: 7,
                  inApp: true,
                  context: [
                    [41, "  const party = await parties.findOne(q);"],
                    [42, "  await parties.updateOne(q, update);"],
                  ],
                },
                {
                  function: "Connection.onMessage",
                  filename: "mongodb/lib/cmap/connection.js",
                  lineNo: 231,
                  colNo: 30,
                  inApp: false,
                  context: [[231, "callback(new error_1.MongoServerError(document));"]],
                },
              ],
            },
          },
        ],
      },
    },
    { type: "request", data: { method: "POST", url: "https://api.example/x", headers: [["Cookie", "secret-cookie"]] } },
    {
      type: "breadcrumbs",
      data: {
        values: Array.from({ length: 35 }, (_, i) => ({
          timestamp: `2026-09-24T14:12:${String(i).padStart(2, "0")}Z`,
          level: "info",
          category: "mongodb",
          message: `crumb-${i}`,
        })),
      },
    },
  ],
  context: { job: { name: "refreshPartyCompliance", queueQualifiedName: "bull:compliance", attemptsMade: 1 } },
  contexts: { trace: { trace_id: "7b17d131d50242d6bc3f7e41e04a898a" } },
};

interface Call {
  url: string;
  auth: string | null;
}

function stubFetch(routes: Record<string, { status?: number; body: unknown }>, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, auth: headers.get("Authorization") });
    const route = routes[new URL(url).pathname];
    if (!route) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(route.body), { status: route.status ?? 200 });
  }) as typeof fetch;
}

const ROUTES = {
  "/api/0/organizations/trustlayer-inc/issues/7154094526/": { body: ISSUE },
  "/api/0/organizations/trustlayer-inc/issues/7154094526/events/latest/": { body: EVENT },
  "/api/0/organizations/trustlayer-inc/shortids/CWT-WORKER-DV/": { body: { groupId: "7154094526" } },
};

function opts(calls: Call[], extra: Partial<SentryContextOptions> = {}): SentryContextOptions {
  return { token: "tok", apiUrl: "https://sentry.io", orgs: [], fetchImpl: stubFetch(ROUTES, calls), ...extra };
}

const BODY =
  "Sentry Issue: [CWT-WORKER-DV](https://trustlayer-inc.sentry.io/issues/7154094526/?referrer=github_integration)\n\n```\nMongoServerError ...\n```";

describe("sentryOptionsFromEnv", () => {
  it("is off without a token", () => {
    expect(sentryOptionsFromEnv({})).toBeUndefined();
    expect(sentryOptionsFromEnv({ SENTRY_AUTH_TOKEN: "  " })).toBeUndefined();
  });

  it("reads the token, the API URL and the organizations", () => {
    expect(
      sentryOptionsFromEnv({ SENTRY_AUTH_TOKEN: "t", SENTRY_API_URL: "https://us.sentry.io/", SENTRY_ORGS: "A, b" }),
    ).toEqual({ token: "t", apiUrl: "https://us.sentry.io", orgs: ["a", "b"] });
    expect(sentryOptionsFromEnv({ SENTRY_AUTH_TOKEN: "t" })?.apiUrl).toBe("https://sentry.io");
  });
});

describe("findSentryIssueRefs", () => {
  it("finds both link forms, in order, without duplicates", () => {
    const text = [
      "https://sentry.io/organizations/acme/issues/111/",
      "https://trustlayer-inc.sentry.io/issues/CWT-WORKER-DV/",
      "https://trustlayer-inc.sentry.io/issues/cwt-worker-dv/?x=1",
    ].join(" ");
    expect(findSentryIssueRefs(text).map((r) => `${r.org}/${r.issueId}`)).toEqual([
      "acme/111",
      "trustlayer-inc/CWT-WORKER-DV",
    ]);
  });

  it("ignores region hosts and organizations that are not in the list", () => {
    const text = "https://us.sentry.io/issues/1/ https://other.sentry.io/issues/2/ https://acme.sentry.io/issues/3/";
    expect(findSentryIssueRefs(text, ["acme"]).map((r) => r.issueId)).toEqual(["3"]);
  });

  it("does not match a host that only ends like a Sentry host", () => {
    expect(findSentryIssueRefs("https://evil.example/https:/x.sentry.io.evil/issues/1")).toEqual([]);
  });
});

describe("fetchSentryContext", () => {
  it("returns an empty string and sends no request when the text has no link", async () => {
    const calls: Call[] = [];
    expect(await fetchSentryContext("no link here", opts(calls))).toBe("");
    expect(calls).toEqual([]);
  });

  it("renders the issue and the full latest event", async () => {
    const calls: Call[] = [];
    const text = await fetchSentryContext(BODY, opts(calls));

    expect(text).toContain("### Sentry issue CWT-WORKER-DV (project cwt-worker)");
    expect(text).toContain("- Events: 4652");
    expect(text).toContain("- Release: v26-39.f9265d3091");
    expect(text).toContain("- server_name: trustlayer-cwt-worker-compliance-f9c48ffb9-z9prv");
    expect(text).toContain("Exception: MongoServerError: Write conflict during plan execution (handled: true)");
    // Every frame, oldest first, with the source lines of the in-app frame only.
    expect(text).toContain("at refreshPartyCompliance (/app/src/jobs/compliance.ts:42:7) [in app]");
    expect(text).toContain(">    42 |   await parties.updateOne(q, update);");
    expect(text).toContain("at Connection.onMessage (mongodb/lib/cmap/connection.js:231:30)");
    expect(text).not.toContain("callback(new error_1.MongoServerError(document));");
    // The extra data holds the queue job, which the GitHub issue body does not show.
    expect(text).toContain('"queueQualifiedName": "bull:compliance"');
    expect(text).toContain('"trace_id": "7b17d131d50242d6bc3f7e41e04a898a"');
    // The last 30 breadcrumbs.
    expect(text).toContain("Breadcrumbs (the last 30 of 35)");
    expect(text).toContain("crumb-34");
    expect(text).not.toMatch(/crumb-4$/m);
    // The request line only: no headers, no cookies.
    expect(text).toContain("Request: POST https://api.example/x");
    expect(text).not.toContain("secret-cookie");
  });

  it("sends the token to the configured API host only", async () => {
    const calls: Call[] = [];
    await fetchSentryContext(BODY, opts(calls));
    expect(calls.length).toBe(2);
    for (const c of calls) {
      expect(new URL(c.url).origin).toBe("https://sentry.io");
      expect(c.auth).toBe("Bearer tok");
    }
  });

  it("resolves a short id to the group id", async () => {
    const calls: Call[] = [];
    const text = await fetchSentryContext("https://trustlayer-inc.sentry.io/issues/CWT-WORKER-DV/", opts(calls));
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      "/api/0/organizations/trustlayer-inc/shortids/CWT-WORKER-DV/",
      "/api/0/organizations/trustlayer-inc/issues/7154094526/",
      "/api/0/organizations/trustlayer-inc/issues/7154094526/events/latest/",
    ]);
    expect(text).toContain("### Sentry issue CWT-WORKER-DV");
  });

  it("writes a line for an issue that it cannot fetch, and keeps the others", async () => {
    const calls: Call[] = [];
    const text = await fetchSentryContext(
      `https://acme.sentry.io/issues/999/ ${BODY}`,
      opts(calls),
    );
    expect(text).toContain(
      "The harness could not fetch this issue: HTTP 404 from /api/0/organizations/acme/issues/999/",
    );
    expect(text).toContain("### Sentry issue CWT-WORKER-DV");
  });

  it("fetches the first issues only, and says so", async () => {
    const calls: Call[] = [];
    const text = await fetchSentryContext(
      "https://a.sentry.io/issues/1/ https://b.sentry.io/issues/2/ https://c.sentry.io/issues/3/",
      opts(calls, { maxIssues: 2 }),
    );
    expect(calls.map((c) => new URL(c.url).pathname.split("/")[4])).toEqual(["a", "b"]);
    expect(text).toContain("The issue links to 3 Sentry issues. The harness fetched the first 2 only.");
  });

  it("truncates a long text", async () => {
    const calls: Call[] = [];
    const text = await fetchSentryContext(BODY, opts(calls, { maxChars: 200 }));
    expect(text.length).toBeLessThan(300);
    expect(text).toMatch(/\[truncated: \d+ more characters\]$/);
  });

  it("gives a fence longer than any backtick run in the data", async () => {
    const event = { ...EVENT, entries: [{ type: "message", data: { formatted: "a ```` b" } }] };
    const calls: Call[] = [];
    const text = await fetchSentryContext(BODY, {
      ...opts(calls),
      fetchImpl: stubFetch(
        { ...ROUTES, "/api/0/organizations/trustlayer-inc/issues/7154094526/events/latest/": { body: event } },
        calls,
      ),
    });
    expect(text).toContain("`````\na ```` b\n`````");
  });
});
