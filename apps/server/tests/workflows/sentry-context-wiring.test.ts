/**
 * The join between `runSimpleWorkflow` and the Sentry context: an issue body
 * with a link to a Sentry issue gives a `contextSnapshot` with the Sentry data
 * in an untrusted wrapper. `sentry-context.test.ts` covers the fetch and the
 * rendering. This file covers the wiring and the off switch (no token).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
}));

import { executeAgent } from "#src/engine/agent-executor.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";
import { configureWorkflowAssets, clearWorkflowCache } from "#src/workflows/loader.js";
import { runSimpleWorkflow } from "#src/workflows/simple.js";
import type { ExecutorConfig } from "#src/engine/github/profiles.js";

const mockExecuteAgent = vi.mocked(executeAgent);

const WORKFLOW_YAML = `
kind: agent
name: explore
phases:
  - name: plan
    label: Plan
    prompt: prompts/plan.md
`;

const BODY =
  "Sentry Issue: [CWT-WORKER-DV](https://trustlayer-inc.sentry.io/issues/7154094526/?referrer=github_integration)";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lastlight-sentry-wiring-"));
}

function makeConfig(): ExecutorConfig {
  return {
    model: "anthropic/operator-default",
    stateDir: "/tmp",
    sandboxDir: "/tmp/sandboxes",
    sessionsDir: "/tmp/sessions",
    sandbox: "none",
    buildAssets: "repo",
  };
}

describe("the Sentry context reaches the prompt through contextSnapshot", () => {
  let db: StateDb;
  const fetchSpy = vi.fn();

  beforeEach(async () => {
    const root = tmp();
    mkdirSync(join(root, "workflows", "prompts"), { recursive: true });
    writeFileSync(join(root, "workflows", "explore.yaml"), WORKFLOW_YAML);
    writeFileSync(join(root, "workflows", "prompts", "plan.md"), "CONTEXT:\n{{contextSnapshot}}");
    configureWorkflowAssets({ builtInRoot: root, overlayRoot: tmp() });
    clearWorkflowCache();
    db = await makeTestDb();
    mockExecuteAgent.mockResolvedValue({ success: true, output: "done", error: undefined, turns: 1, durationMs: 1 });

    fetchSpy.mockImplementation(async (input: string | URL) => {
      const path = new URL(String(input)).pathname;
      const body = path.endsWith("/events/latest/")
        ? { eventID: "f46744e9", context: { job: { name: "refreshPartyCompliance" } } }
        : { shortId: "CWT-WORKER-DV", title: "MongoServerError", count: "4652" };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    configureWorkflowAssets();
    clearWorkflowCache();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  const run = () =>
    runSimpleWorkflow(
      "explore",
      { owner: "trustlayer", repo: "trustlayer-cwt", issueNumber: 9498, issueTitle: "MongoServerError", issueBody: BODY, sender: "alice" },
      makeConfig(),
      {},
      db,
      { default: "anthropic/operator-default" },
      {},
      "lastlight:bootstrap",
      {},
    );

  const prompt = (): string => mockExecuteAgent.mock.calls[0]![0];

  it("adds the Sentry issue data in an untrusted wrapper when a token is set", async () => {
    vi.stubEnv("SENTRY_AUTH_TOKEN", "tok");

    await run();

    const text = prompt();
    expect(text).toContain("Sentry issue data (the harness fetched it from the Sentry API):");
    expect(text).toContain('<<<USER_CONTENT_UNTRUSTED source="sentry-api">>>');
    expect(text).toContain("### Sentry issue CWT-WORKER-DV");
    expect(text).toContain('"name": "refreshPartyCompliance"');
    // The token is in the request header, never in the prompt.
    expect(text).not.toContain("tok\n");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("sends no request and adds nothing without a token", async () => {
    vi.stubEnv("SENTRY_AUTH_TOKEN", "");

    await run();

    expect(prompt()).not.toContain("Sentry issue data");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not fail the run when Sentry is down", async () => {
    vi.stubEnv("SENTRY_AUTH_TOKEN", "tok");
    fetchSpy.mockRejectedValue(new Error("connect ECONNREFUSED"));

    await run();

    expect(prompt()).toContain("The harness could not fetch this issue: connect ECONNREFUSED");
  });
});
