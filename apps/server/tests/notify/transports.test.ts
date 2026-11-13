import { describe, it, expect, vi } from "vitest";
import { GitHubTransport, statusCommentMarker } from "#src/notify/transports/github.js";
import { SlackTransport } from "#src/notify/transports/slack.js";
import type { GitHubClient } from "#src/engine/github/github.js";
import type { SlackConnector } from "#src/connectors/slack/connector.js";
import type { ProgressModel } from "#src/notify/types.js";

const MODEL: ProgressModel = {
  title: "build for #18",
  steps: [
    { key: "architect", label: "Architect", status: "done" },
    { key: "executor", label: "Executor", status: "running" },
  ],
};

describe("GitHubTransport", () => {
  it("creates the comment on first publish (storing the id) then edits it", async () => {
    const postComment = vi.fn(async () => 555);
    const updateComment = vi.fn(async () => {});
    const github = { postComment, updateComment } as unknown as GitHubClient;
    const saved: number[] = [];

    const t = new GitHubTransport({
      github, owner: "o", repo: "r", issueNumber: 7, save: (id) => saved.push(id),
    });

    await t.publish("first");
    await t.publish("second");

    expect(postComment).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledWith("o", "r", 7, "first");
    expect(updateComment).toHaveBeenCalledTimes(1);
    expect(updateComment).toHaveBeenCalledWith("o", "r", 555, "second");
    expect(saved).toEqual([555]);
  });

  it("re-attaches to an existing comment id (resume) and only edits", async () => {
    const postComment = vi.fn(async () => 999);
    const updateComment = vi.fn(async () => {});
    const github = { postComment, updateComment } as unknown as GitHubClient;

    const t = new GitHubTransport({ github, owner: "o", repo: "r", issueNumber: 7, commentId: 42 });
    await t.publish("edit me");

    expect(postComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledWith("o", "r", 42, "edit me");
  });

  it("note always posts a fresh comment", async () => {
    const postComment = vi.fn(async () => 1);
    const github = { postComment, updateComment: vi.fn() } as unknown as GitHubClient;
    const t = new GitHubTransport({ github, owner: "o", repo: "r", issueNumber: 7, commentId: 42 });
    await t.note("ping");
    expect(postComment).toHaveBeenCalledWith("o", "r", 7, "ping");
  });

  it("ignores the structured model — posts markdown only", async () => {
    const postComment = vi.fn(async () => 1);
    const updateComment = vi.fn(async () => {});
    const github = { postComment, updateComment } as unknown as GitHubClient;
    const t = new GitHubTransport({ github, owner: "o", repo: "r", issueNumber: 7 });
    await t.publish("body", MODEL);
    expect(postComment).toHaveBeenCalledWith("o", "r", 7, "body");
  });
});

describe("GitHubTransport sticky status comment", () => {
  const MARKER = statusCommentMarker("pr-review");
  const STICKY = { workflow: "pr-review", botLogin: "bot[bot]" };

  it("edits the marked comment of an earlier run instead of posting a new one", async () => {
    const findBotCommentWithMarker = vi.fn(async () => 321);
    const postComment = vi.fn(async () => 1);
    const updateComment = vi.fn(async () => {});
    const github = { findBotCommentWithMarker, postComment, updateComment } as unknown as GitHubClient;
    const saved: number[] = [];
    const t = new GitHubTransport({
      github, owner: "o", repo: "r", issueNumber: 7, sticky: STICKY, save: (id) => saved.push(id),
    });

    await t.publish("first");
    await t.publish("second");

    expect(findBotCommentWithMarker).toHaveBeenCalledTimes(1);
    expect(findBotCommentWithMarker).toHaveBeenCalledWith("o", "r", 7, MARKER, "bot[bot]");
    expect(postComment).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenNthCalledWith(1, "o", "r", 321, `first\n\n${MARKER}`);
    expect(updateComment).toHaveBeenNthCalledWith(2, "o", "r", 321, `second\n\n${MARKER}`);
    expect(saved).toEqual([321]);
  });

  it("posts a marked comment when no earlier one exists", async () => {
    const findBotCommentWithMarker = vi.fn(async () => undefined);
    const postComment = vi.fn(async () => 555);
    const updateComment = vi.fn(async () => {});
    const github = { findBotCommentWithMarker, postComment, updateComment } as unknown as GitHubClient;
    const t = new GitHubTransport({ github, owner: "o", repo: "r", issueNumber: 7, sticky: STICKY });

    await t.publish("first");

    expect(postComment).toHaveBeenCalledWith("o", "r", 7, `first\n\n${MARKER}`);
    expect(updateComment).not.toHaveBeenCalled();
  });

  it("posts a marked comment when the lookup fails", async () => {
    const findBotCommentWithMarker = vi.fn(async () => {
      throw new Error("boom");
    });
    const postComment = vi.fn(async () => 555);
    const github = { findBotCommentWithMarker, postComment, updateComment: vi.fn() } as unknown as GitHubClient;
    const t = new GitHubTransport({ github, owner: "o", repo: "r", issueNumber: 7, sticky: STICKY });

    await t.publish("first");

    expect(postComment).toHaveBeenCalledWith("o", "r", 7, `first\n\n${MARKER}`);
  });

  it("skips the lookup when a resumed run already holds the comment id", async () => {
    const findBotCommentWithMarker = vi.fn(async () => 321);
    const updateComment = vi.fn(async () => {});
    const github = { findBotCommentWithMarker, postComment: vi.fn(), updateComment } as unknown as GitHubClient;
    const t = new GitHubTransport({ github, owner: "o", repo: "r", issueNumber: 7, commentId: 42, sticky: STICKY });

    await t.publish("edit me");

    expect(findBotCommentWithMarker).not.toHaveBeenCalled();
    expect(updateComment).toHaveBeenCalledWith("o", "r", 42, `edit me\n\n${MARKER}`);
  });
});

describe("SlackTransport", () => {
  it("posts the message on first publish (storing the ts) then updates it", async () => {
    const sendMessage = vi.fn(async () => "111.222");
    const updateMessage = vi.fn(async () => {});
    const slack = { sendMessage, updateMessage } as unknown as SlackConnector;
    const saved: string[] = [];

    const t = new SlackTransport({
      slack, channel: "C", thread: "T", save: (ts) => saved.push(ts),
    });

    await t.publish("first");
    await t.publish("second");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("C", "T", "first", undefined);
    expect(updateMessage).toHaveBeenCalledTimes(1);
    expect(updateMessage).toHaveBeenCalledWith("C", "111.222", "second", undefined);
    expect(saved).toEqual(["111.222"]);
  });

  it("renders Block Kit from the model while keeping text as the fallback", async () => {
    // Declared with the real arity so the destructure below is typed — the
    // transport calls `sendMessage(channel, thread, text, blocks)`.
    const sendMessage = vi.fn(
      async (
        _channel: string,
        _thread: string | undefined,
        _text: string,
        _blocks?: unknown[],
      ) => "111.222",
    );
    const updateMessage = vi.fn(async () => {});
    const slack = { sendMessage, updateMessage } as unknown as SlackConnector;

    const t = new SlackTransport({ slack, channel: "C", thread: "T" });
    await t.publish("checklist markdown", MODEL);

    const [, , text, blocks] = sendMessage.mock.calls[0]!;
    expect(text).toBe("checklist markdown"); // text fallback preserved
    expect(Array.isArray(blocks)).toBe(true);
    expect((blocks as unknown[]).length).toBeGreaterThan(0);
    // First block is the header derived from the model title.
    expect((blocks as any[])[0].type).toBe("header");
  });

  it("wants a terminal ping (silent edits, no other signal) unlike GitHub", () => {
    const slack = new SlackTransport({ slack: {} as unknown as SlackConnector, channel: "C", thread: "T" });
    const gh = new GitHubTransport({ github: {} as unknown as GitHubClient, owner: "o", repo: "r", issueNumber: 1 });
    expect(slack.terminalPing).toBe(true);
    expect(gh.terminalPing).toBeFalsy();
  });

  it("re-attaches to an existing ts (resume) and only updates", async () => {
    const sendMessage = vi.fn(async () => "x");
    const updateMessage = vi.fn(async () => {});
    const slack = { sendMessage, updateMessage } as unknown as SlackConnector;

    const t = new SlackTransport({ slack, channel: "C", thread: "T", ts: "900.1" });
    await t.publish("edit");

    expect(sendMessage).not.toHaveBeenCalled();
    expect(updateMessage).toHaveBeenCalledWith("C", "900.1", "edit", undefined);
  });
});
