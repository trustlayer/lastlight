/**
 * The OAuth route of the one-shot helper (`chat()` in `src/engine/llm.ts`),
 * which the classifier, the screener and the digest use. A deployment with
 * only OAuth logins had no API key, so every classifier call failed with
 * "OPENAI_API_KEY not set" and each comment was routed as `chat`.
 *
 * pi-ai is mocked: `getModel` returns a stub and `completeSimple` records its
 * arguments. Only `resolveOAuthApiKey` is stubbed on the oauth module, so the
 * prefix-to-provider map and the OAuth-only rule under test are the real ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { PROVIDER_ENV_KEYS } from "lastlight-shared/providers";

const completeSimpleSpy = vi.fn();
vi.mock("@earendil-works/pi-ai/compat", () => ({
  getModel: (provider: string, id: string) => ({ provider, id, api: "faux", baseUrl: "x" }),
  completeSimple: (...args: unknown[]) => completeSimpleSpy(...args),
}));

const resolveOAuthApiKeySpy = vi.fn();
vi.mock("#src/engine/oauth.js", async (importActual) => {
  const actual = await importActual<typeof import("#src/engine/oauth.js")>();
  return { ...actual, resolveOAuthApiKey: (...a: unknown[]) => resolveOAuthApiKeySpy(...a) };
});

const { chat } = await import("#src/engine/llm.js");

function assistant(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
  return {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "ignored" },
      { type: "text", text },
    ],
    stopReason: "stop",
    ...extra,
  } as unknown as AssistantMessage;
}

const MESSAGES = [
  { role: "system" as const, content: "classify" },
  { role: "user" as const, content: "@bot review this" },
];

describe("chat with an OAuth login", () => {
  const ORIGINAL_ENV = { ...process.env };
  let fetchSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    for (const key of PROVIDER_ENV_KEYS) delete process.env[key];
    completeSimpleSpy.mockReset();
    resolveOAuthApiKeySpy.mockReset();
    resolveOAuthApiKeySpy.mockResolvedValue(null);
    fetchSpy = vi.spyOn(globalThis, "fetch");
  });
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
  });

  it("sends a Codex model through pi-ai with the stored token", async () => {
    resolveOAuthApiKeySpy.mockResolvedValue({ apiKey: "codex-token", credentials: {} });
    completeSimpleSpy.mockResolvedValue(assistant("INTENT: review"));

    const out = await chat("openai-codex/gpt-5.6-luna", MESSAGES, { maxTokens: 2048 });

    expect(out).toBe("INTENT: review");
    expect(resolveOAuthApiKeySpy).toHaveBeenCalledWith("openai-codex", undefined, undefined);
    expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
    const [model, context, opts] = completeSimpleSpy.mock.calls[0];
    expect(model).toMatchObject({ provider: "openai-codex", id: "gpt-5.6-luna" });
    expect(context.systemPrompt).toBe("classify");
    expect(context.messages).toEqual([expect.objectContaining({ role: "user", content: "@bot review this" })]);
    expect(opts).toMatchObject({ apiKey: "codex-token", maxTokens: 2048 });
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails with the login command for a Codex model without a login", async () => {
    await expect(chat("openai-codex/gpt-5.6-luna", MESSAGES)).rejects.toThrow(
      /needs an OAuth login\. Run: lastlight oauth login openai-codex/,
    );
    expect(completeSimpleSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the Anthropic login before an API key, as the chat runner does", async () => {
    process.env.ANTHROPIC_API_KEY = "api-key";
    resolveOAuthApiKeySpy.mockResolvedValue({ apiKey: "sk-ant-oat-token", credentials: {} });
    completeSimpleSpy.mockResolvedValue(assistant("INJECTION: NO"));

    await expect(chat("anthropic/claude-haiku-4-5", MESSAGES)).resolves.toBe("INJECTION: NO");

    expect(completeSimpleSpy.mock.calls[0][2]).toMatchObject({ apiKey: "sk-ant-oat-token", maxTokens: 256 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("keeps the API-key path for Anthropic without a login", async () => {
    process.env.ANTHROPIC_API_KEY = "api-key";
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(chat("anthropic/claude-haiku-4-5", MESSAGES)).resolves.toBe("ok");

    expect(completeSimpleSpy).not.toHaveBeenCalled();
    expect((fetchSpy.mock.calls[0][1] as RequestInit).headers).toMatchObject({ "x-api-key": "api-key" });
  });

  it("does not look for a login for an API-key provider", async () => {
    process.env.OPENAI_API_KEY = "k";
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(chat("openai/gpt-4o-mini", MESSAGES)).resolves.toBe("ok");

    expect(resolveOAuthApiKeySpy).not.toHaveBeenCalled();
  });

  it("throws the provider error that pi-ai returns in the message", async () => {
    resolveOAuthApiKeySpy.mockResolvedValue({ apiKey: "t", credentials: {} });
    completeSimpleSpy.mockResolvedValue(
      assistant("", { stopReason: "error", errorMessage: "400 usage limit reached" }),
    );

    await expect(chat("openai-codex/gpt-5.6-luna", MESSAGES)).rejects.toThrow(
      "openai-codex api: 400 usage limit reached",
    );
    // A 4xx is not transient, so there is no retry.
    expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
  });

  it("retries once when pi-ai returns a transient error", async () => {
    resolveOAuthApiKeySpy.mockResolvedValue({ apiKey: "t", credentials: {} });
    completeSimpleSpy
      .mockResolvedValueOnce(assistant("", { stopReason: "error", errorMessage: "429 rate limited" }))
      .mockResolvedValueOnce(assistant("INTENT: chat"));

    await expect(chat("openai-codex/gpt-5.6-luna", MESSAGES)).resolves.toBe("INTENT: chat");
    expect(completeSimpleSpy).toHaveBeenCalledTimes(2);
  });

  it("fails the call and does not use an API key when the refresh fails", async () => {
    process.env.ANTHROPIC_API_KEY = "api-key";
    resolveOAuthApiKeySpy.mockRejectedValue(new Error("invalid_grant"));

    await expect(chat("anthropic/claude-haiku-4-5", MESSAGES)).rejects.toThrow("invalid_grant");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
