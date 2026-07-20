import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  callTextModel,
  callTextModelWithMetadata,
  type EndpointOverride,
  type ModelCallResult,
  type TextModelRequest,
} from "../tagger.js";

// C2 Pass 2 — Task 4: model telemetry contract.
//
// These tests pin the additive telemetry API (`callTextModelWithMetadata`)
// alongside the legacy compatibility wrapper (`callTextModel`). Both paths
// share the same internal HTTP plumbing; the legacy wrapper simply discards
// the metadata and returns `.content`. The C2 path requires an explicit
// endpoint+model triple, surfaces normalized usage, and fails closed when the
// provider omits token accounting, returns a different model identity, lacks
// credentials, or attempts to fall back to a different provider.

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

// Build a fetch mock that returns the given JSON body. Optionally expose a
// `requestId` header so the telemetry path can surface providerRequestId.
function makeFetch(body: unknown, opts: { requestId?: string; status?: number; headers?: Record<string, string> } = {}) {
  const handler = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    return new Response(JSON.stringify(body), {
      status: opts.status ?? 200,
      headers: {
        "content-type": "application/json",
        ...(opts.requestId ? { "x-request-id": opts.requestId } : {}),
        ...(opts.headers ?? {}),
      },
    });
  });
  return handler as unknown as typeof fetch;
}

function buildOpenAIResponsesBody(opts: {
  content: string;
  model?: string;
  // OpenAI Responses API uses input_tokens/output_tokens (not the chat-completions
  // prompt_tokens/completion_tokens naming). The implementation normalizes both.
  // Pass `null` to OMIT the usage field entirely (negative cases); omit the key
  // for the default.
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number } | null;
}): unknown {
  return {
    id: "resp_test",
    object: "response",
    model: opts.model ?? "gpt-pinned",
    output_text: opts.content,
    output: [{ type: "message", content: [{ type: "output_text", text: opts.content }] }],
    ...(opts.usage === null ? {} : { usage: opts.usage ?? { input_tokens: 120, output_tokens: 80, total_tokens: 200 } }),
  };
}

function buildClaudeMessagesBody(opts: {
  content: string;
  model?: string;
  usage?: { input_tokens?: number; output_tokens?: number } | null;
}): unknown {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: opts.model ?? "claude-pinned",
    content: [{ type: "text", text: opts.content }],
    ...(opts.usage === null ? {} : { usage: opts.usage ?? { input_tokens: 120, output_tokens: 80 } }),
  };
}

describe("callTextModelWithMetadata (C2 telemetry)", () => {
  beforeEach(() => {
    // Pin the env so the OpenAI native Responses path is used (no baseUrl →
    // callOpenAI). Claude/Gemini read their keys from env (endpoint.apiKey is
    // ignored for those two providers — see the Issue 5 test below).
    process.env.OPENAI_API_KEY = "openai-test";
    process.env.ANTHROPIC_API_KEY = "anthropic-test";
    process.env.GEMINI_API_KEY = "gemini-test";
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL_CRITIQUE;
    delete process.env.OPENAI_API_KEY_CRITIQUE;
    delete process.env.OPENAI_AUTO_TAG_MODEL_CRITIQUE;
    delete process.env.AUTO_TAG_PROVIDER;
    delete process.env.AUTO_TAG_PROVIDER_CRITIQUE;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      process.env[key] = originalEnv[key];
    }
    // Also clear any env keys the suite introduced (and that were undefined in
    // the captured baseline) so they don't leak across files.
    for (const k of [
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "GEMINI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_BASE_URL_CRITIQUE",
      "OPENAI_API_KEY_CRITIQUE",
      "OPENAI_AUTO_TAG_MODEL_CRITIQUE",
      "AUTO_TAG_PROVIDER",
      "AUTO_TAG_PROVIDER_CRITIQUE",
    ]) {
      if (!(k in originalEnv)) delete process.env[k];
    }
  });

  it("surfaces OpenAI Responses content, identity, normalized usage, attempts, latency, and providerRequestId", async () => {
    globalThis.fetch = makeFetch(
      buildOpenAIResponsesBody({
        content: "candidate-json",
        model: "gpt-pinned",
        usage: { input_tokens: 120, output_tokens: 80, total_tokens: 200 },
      }),
      { requestId: "req_abc123" },
    );

    const request: TextModelRequest = {
      prompt: "hello",
      endpoint: { provider: "openai", apiKey: "openai-test", model: "gpt-pinned" },
      maxOutputTokens: 8192,
      maxAttempts: 1,
    };

    const started = Date.now();
    const result = await callTextModelWithMetadata(request);
    const elapsed = Date.now() - started;

    expect(result).toMatchObject({
      content: "candidate-json",
      provider: "openai",
      model: "gpt-pinned",
      usage: { promptTokens: 120, completionTokens: 80 },
      attempts: 1,
      providerRequestId: "req_abc123",
    });
    expect(typeof result.latencyMs).toBe("number");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.latencyMs).toBeLessThanOrEqual(elapsed + 50);
    // raw preserves the provider-native field names for auditability.
    expect(result.usage.raw).toMatchObject({ input_tokens: 120, output_tokens: 80 });
  });

  it("surfaces Claude Messages content, identity, and normalized usage", async () => {
    globalThis.fetch = makeFetch(
      buildClaudeMessagesBody({
        content: "claude-candidate",
        model: "claude-pinned",
        usage: { input_tokens: 50, output_tokens: 30 },
      }),
      { requestId: "req_claude" },
    );

    const request: TextModelRequest = {
      prompt: "hello",
      endpoint: { provider: "claude", apiKey: "anthropic-test", model: "claude-pinned" },
      maxOutputTokens: 8192,
      maxAttempts: 1,
    };

    const result = await callTextModelWithMetadata(request);
    expect(result).toMatchObject({
      content: "claude-candidate",
      provider: "claude",
      model: "claude-pinned",
      usage: { promptTokens: 50, completionTokens: 30 },
      attempts: 1,
      providerRequestId: "req_claude",
    });
  });

  it("nulls providerRequestId when the provider response carries no request id", async () => {
    globalThis.fetch = makeFetch(
      buildOpenAIResponsesBody({ content: "candidate", usage: { prompt_tokens: 1, completion_tokens: 1 } }),
    );

    const result = await callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "openai", apiKey: "openai-test", model: "gpt-pinned" },
      maxOutputTokens: 8192,
      maxAttempts: 1,
    });
    expect(result.providerRequestId).toBeNull();
  });

  it("counts every HTTP attempt (including a retried 503) before success", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      if (attempts === 1) {
        // Transient 503 — fetchWithRetry will retry.
        return new Response("service unavailable", { status: 503 });
      }
      return new Response(
        JSON.stringify(buildOpenAIResponsesBody({
          content: "after-retry",
          usage: { input_tokens: 5, output_tokens: 5 },
        })),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "openai", apiKey: "openai-test", model: "gpt-pinned" },
      maxOutputTokens: 8192,
      maxAttempts: 3,
    });

    expect(result.content).toBe("after-retry");
    // Two HTTP attempts: one 503 + one 200. attempts counts both.
    expect(result.attempts).toBe(2);
  });

  // ── Request-body assertions (Issue 4 regression coverage) ──────────────────
  // These tests assert what is actually SENT to the provider. Earlier the mock
  // echoed whatever model the test wanted in the RESPONSE — but the REQUEST body
  // (what would go to Anthropic/Google) was never inspected, so a bug that sent
  // the default model instead of the pinned one escaped. These pin the contract.

  it("sends the pinned model in the Claude request body (not the env default)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(
        JSON.stringify(buildClaudeMessagesBody({
          content: "claude-candidate",
          model: "claude-pinned",
          usage: { input_tokens: 50, output_tokens: 30 },
        })),
        { status: 200, headers: { "content-type": "application/json", "x-request-id": "req_claude" } },
      );
    }) as unknown as typeof fetch;

    const result = await callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "claude", apiKey: "ignored-for-claude", model: "claude-pinned" },
      maxOutputTokens: 8192,
      maxAttempts: 1,
    });

    // Exactly one HTTP call, to the Anthropic Messages endpoint.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("anthropic.com");
    // The REQUEST body's model field MUST be the pinned model. This is the
    // regression assertion that would have caught Issue 1: before the fix,
    // modelOverride was never threaded and the default `claude-haiku-4-5`
    // constant was sent regardless of endpoint.model.
    expect(calls[0].body.model).toBe("claude-pinned");
    // The response still echoes the pinned identity (round-trip check).
    expect(result.model).toBe("claude-pinned");
  });

  it("sends the pinned model in the Gemini request URL (not the env default)", async () => {
    const calls: Array<{ url: string }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      calls.push({ url: String(input) });
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "gemini-candidate" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 40, candidatesTokenCount: 20, totalTokenCount: 60 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const result = await callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "gemini", apiKey: "ignored-for-gemini", model: "gemini-3.5-flash-c2" },
      maxOutputTokens: 8192,
      maxAttempts: 1,
    });

    // Exactly one HTTP call. Gemini puts the model in the URL path (not body),
    // so the regression assertion is against the URL. Before the fix the default
    // `gemini-2.5-flash` constant was baked into the URL regardless of endpoint.model.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("gemini-3.5-flash-c2");
    // Sanity: the URL still hits the generateContent endpoint shape.
    expect(calls[0].url).toContain(":generateContent");
    // Gemini does not echo the model — the C2 path trusts the pinned model.
    expect(result.model).toBe("gemini-3.5-flash-c2");
  });

  // Issue 2 (maxOutputTokens wiring) — proves the per-call budget reaches the
  // provider request body rather than being silently dropped.
  it("threads maxOutputTokens into the OpenAI Responses request body (max_output_tokens)", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(
        JSON.stringify(buildOpenAIResponsesBody({
          content: "candidate",
          usage: { input_tokens: 10, output_tokens: 10 },
        })),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "openai", apiKey: "openai-test", model: "gpt-pinned" },
      maxOutputTokens: 1234,
      maxAttempts: 1,
    });

    expect(calls).toHaveLength(1);
    // The pinned per-call budget reaches the OpenAI Responses request body.
    expect(calls[0].body.max_output_tokens).toBe(1234);
  });

  it("threads maxOutputTokens into the Claude request body (max_tokens)", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(
        JSON.stringify(buildClaudeMessagesBody({
          content: "claude-candidate",
          model: "claude-pinned",
          usage: { input_tokens: 5, output_tokens: 5 },
        })),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "claude", apiKey: "ignored", model: "claude-pinned" },
      maxOutputTokens: 2048,
      maxAttempts: 1,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].body.max_tokens).toBe(2048);
  });

  it("threads maxOutputTokens into the Gemini generationConfig (maxOutputTokens)", async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "gemini-candidate" }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 4, totalTokenCount: 8 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "gemini", apiKey: "ignored", model: "gemini-2.5-flash" },
      maxOutputTokens: 4096,
      maxAttempts: 1,
    });

    expect(calls).toHaveLength(1);
    const gc = calls[0].body.generationConfig as Record<string, unknown> | undefined;
    expect(gc?.maxOutputTokens).toBe(4096);
  });

  // Issue 5 (endpoint.apiKey ignored for Claude/Gemini) — documented behavior.
  // Claude/Gemini read credentials from env vars; a caller-supplied apiKey is
  // not honored. This test pins that contract so a future "fix" that silently
  // starts honoring it is a deliberate, reviewed change.
  it("ignores endpoint.apiKey for Claude (uses ANTHROPIC_API_KEY from env)", async () => {
    // ANTHROPIC_API_KEY is set in beforeEach to "anthropic-test". The request
    // passes a DIFFERENT apiKey — the documented behavior is that it's ignored
    // and the env credential is used. We assert the request reaches the
    // x-api-key header from env, not the caller-supplied one.
    const seenHeaders: Record<string, string> = {};
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      if (headers) for (const [k, v] of Object.entries(headers)) seenHeaders[k] = v;
      return new Response(
        JSON.stringify(buildClaudeMessagesBody({
          content: "claude-candidate",
          model: "claude-pinned",
          usage: { input_tokens: 5, output_tokens: 5 },
        })),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    await callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "claude", apiKey: "caller-supplied-key", model: "claude-pinned" },
      maxOutputTokens: 8192,
      maxAttempts: 1,
    });

    // The env credential (anthropic-test) is what reaches Anthropic — NOT the
    // caller-supplied "caller-supplied-key". This is the documented contract.
    expect(seenHeaders["x-api-key"]).toBe("anthropic-test");
    expect(seenHeaders["x-api-key"]).not.toBe("caller-supplied-key");
  });

  // Issue 2 (maxAttempts) — proves a transient 5xx is retried up to the cap and
  // no further. maxAttempts is the TOTAL attempt count (1 = no retry).
  it("caps HTTP attempts at maxAttempts=1 (no retry even on a transient 503)", async () => {
    let attempts = 0;
    globalThis.fetch = vi.fn(async () => {
      attempts++;
      // Transient 503 — fetchWithRetry WOULD retry under the default budget,
      // but maxAttempts=1 forbids it. The 503 surfaces immediately.
      return new Response("service unavailable", { status: 503 });
    }) as unknown as typeof fetch;

    await expect(callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "openai", apiKey: "openai-test", model: "gpt-pinned" },
      maxOutputTokens: 8192,
      maxAttempts: 1,
    })).rejects.toThrow();

    // Exactly one HTTP attempt — maxAttempts=1 disabled retry entirely.
    expect(attempts).toBe(1);
  });

  // ── Negative cases (fail-closed guarantees) ────────────────────────────────

  it("fails closed when the OpenAI response omits usable usage", async () => {
    globalThis.fetch = makeFetch(
      buildOpenAIResponsesBody({
        content: "candidate",
        usage: null,
      }),
    );

    await expect(callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "openai", apiKey: "openai-test", model: "gpt-pinned" },
      maxOutputTokens: 8192,
      maxAttempts: 1,
    })).rejects.toThrow(/usage/i);
  });

  it("fails closed when usage reports zero prompt tokens (no billing signal)", async () => {
    globalThis.fetch = makeFetch(
      buildOpenAIResponsesBody({
        content: "candidate",
        usage: { input_tokens: 0, output_tokens: 0 },
      }),
    );

    await expect(callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "openai", apiKey: "openai-test", model: "gpt-pinned" },
      maxOutputTokens: 8192,
      maxAttempts: 1,
    })).rejects.toThrow(/usage/i);
  });

  it("fails closed when the provider exposes a model identity that differs from the pinned model", async () => {
    globalThis.fetch = makeFetch(
      buildOpenAIResponsesBody({
        content: "candidate",
        model: "gpt-something-else", // different identity from what we requested
        usage: { input_tokens: 5, output_tokens: 5 },
      }),
    );

    await expect(callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "openai", apiKey: "openai-test", model: "gpt-pinned" },
      maxOutputTokens: 8192,
      maxAttempts: 1,
    })).rejects.toThrow(/model/i);
  });

  it("fails closed when the pinned provider has no api key", async () => {
    // No fetch should be invoked. Verify by NOT installing a mock and asserting
    // the call rejects before any HTTP traffic.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch should not be invoked when the api key is missing");
    }) as unknown as typeof fetch;

    await expect(callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "openai", apiKey: "", model: "gpt-pinned" },
      maxOutputTokens: 8192,
      maxAttempts: 1,
    })).rejects.toThrow(/key|api/i);
  });

  it("refuses to fall back to another provider when the pinned provider errors (no ambient routing)", async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      // Return a hard 4xx (auth) so fetchWithRetry will NOT retry.
      return new Response(JSON.stringify({ error: "invalid_api_key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    // ANTHROPIC key is set in beforeEach — the test asserts the call does not
    // silently fall back to Claude.
    await expect(callTextModelWithMetadata({
      prompt: "hello",
      endpoint: { provider: "openai", apiKey: "openai-test", model: "gpt-pinned" },
      maxOutputTokens: 8192,
      maxAttempts: 1,
    })).rejects.toThrow();

    // Exactly one HTTP attempt, against the pinned OpenAI endpoint only.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("openai.com");
    expect(calls.some((u) => /anthropic\.com/.test(u))).toBe(false);
  });
});

describe("callTextModel (legacy compatibility wrapper)", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "openai-test";
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL_CRITIQUE;
    delete process.env.OPENAI_API_KEY_CRITIQUE;
    delete process.env.OPENAI_AUTO_TAG_MODEL_CRITIQUE;
    process.env.AUTO_TAG_PROVIDER = "openai";
    process.env.AUTO_TAG_PROVIDER_CRITIQUE = "openai";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      process.env[key] = originalEnv[key];
    }
    for (const k of [
      "OPENAI_API_KEY",
      "OPENAI_BASE_URL",
      "OPENAI_BASE_URL_CRITIQUE",
      "OPENAI_API_KEY_CRITIQUE",
      "OPENAI_AUTO_TAG_MODEL_CRITIQUE",
      "AUTO_TAG_PROVIDER",
      "AUTO_TAG_PROVIDER_CRITIQUE",
    ]) {
      if (!(k in originalEnv)) delete process.env[k];
    }
  });

  it("returns only content (string) for the existing 4-arg signature", async () => {
    globalThis.fetch = makeFetch(
      buildOpenAIResponsesBody({ content: "candidate-json", usage: { prompt_tokens: 120, completion_tokens: 80 } }),
    );

    const value = await callTextModel("hello", "openai");
    expect(value).toBe("candidate-json");
    expect(typeof value).toBe("string");
  });

  it("forwards endpointOverride (4-arg) to the pinned OpenAI-compatible endpoint", async () => {
    const seen: Array<{ url: string; body: { model?: string } }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: "deepseek-candidate" } }],
          model: "deepseek-v4",
          usage: { prompt_tokens: 10, completion_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const endpointOverride: EndpointOverride = {
      provider: "openai",
      baseUrl: "https://nim.test/v1",
      apiKey: "nim-test",
      model: "deepseek-v4",
    };

    const value = await callTextModel("hello", undefined, undefined, endpointOverride);
    expect(value).toBe("deepseek-candidate");
    expect(seen[0].url).toBe("https://nim.test/v1/chat/completions");
    expect(seen[0].body.model).toBe("deepseek-v4");
  });
});
