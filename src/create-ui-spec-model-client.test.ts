import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTextModelWithMetadata } from "./tagger.js";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function buildOpenAICompatBody(content: string) {
  return {
    choices: [{ message: { content } }],
    model: "openai-pinned",
    usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 },
  };
}

function buildClaudeBody(content: string) {
  return {
    model: "claude-pinned",
    content: [{ type: "text", text: content }],
    usage: { input_tokens: 9, output_tokens: 4 },
  };
}

function buildGeminiBody(content: string) {
  return {
    candidates: [{ content: { parts: [{ text: content }] }, finishReason: "STOP" }],
    usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 },
  };
}

describe("callTextModelWithMetadata pinned endpoint handling", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "ambient-openai-key";
    process.env.ANTHROPIC_API_KEY = "ambient-anthropic-key";
    process.env.GEMINI_API_KEY = "ambient-gemini-key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(originalEnv)) {
      process.env[key] = originalEnv[key];
    }
    for (const key of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY"]) {
      if (!(key in originalEnv)) delete process.env[key];
    }
  });

  it("pins the explicit endpoint for OpenAI-compatible, Claude, and Gemini requests", async () => {
    const requests: Array<{ url: string; headers: Record<string, string>; body: Record<string, unknown> }> = [];
    const responses = [
      buildOpenAICompatBody("openai-candidate"),
      buildClaudeBody("claude-candidate"),
      buildGeminiBody("gemini-candidate"),
    ];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      requests.push({ url: String(input), headers, body });
      const response = responses.shift();
      return new Response(JSON.stringify(response), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await callTextModelWithMetadata({
      prompt: "proposal-only",
      endpoint: {
        provider: "openai",
        baseUrl: "https://pinned.example/v1",
        apiKey: "request-key",
        model: "openai-pinned",
      },
      maxOutputTokens: 256,
      maxAttempts: 1,
    });
    await callTextModelWithMetadata({
      prompt: "proposal-only",
      endpoint: {
        provider: "claude",
        baseUrl: "https://pinned.example/v1/messages",
        apiKey: "request-key",
        model: "claude-pinned",
      },
      maxOutputTokens: 256,
      maxAttempts: 1,
    });
    await callTextModelWithMetadata({
      prompt: "proposal-only",
      endpoint: {
        provider: "gemini",
        baseUrl: "https://pinned.example/v1beta/models",
        apiKey: "request-key",
        model: "gemini-pinned",
      },
      maxOutputTokens: 256,
      maxAttempts: 1,
    });

    expect(requests).toHaveLength(3);

    expect(requests[0].headers.authorization).toBe("Bearer request-key");
    expect(requests[0].url.startsWith("https://pinned.example/")).toBe(true);
    expect(JSON.stringify(requests[0])).not.toContain("ambient-openai-key");
    expect(JSON.stringify(requests[0])).not.toContain("ambient-anthropic-key");
    expect(JSON.stringify(requests[0])).not.toContain("ambient-gemini-key");

    expect(requests[1].headers["x-api-key"]).toBe("request-key");
    expect(requests[1].url.startsWith("https://pinned.example/")).toBe(true);
    expect(JSON.stringify(requests[1])).not.toContain("ambient-openai-key");
    expect(JSON.stringify(requests[1])).not.toContain("ambient-anthropic-key");
    expect(JSON.stringify(requests[1])).not.toContain("ambient-gemini-key");

    expect(requests[2].headers["x-goog-api-key"]).toBe("request-key");
    expect(requests[2].url.startsWith("https://pinned.example/")).toBe(true);
    expect(JSON.stringify(requests[2])).not.toContain("ambient-openai-key");
    expect(JSON.stringify(requests[2])).not.toContain("ambient-anthropic-key");
    expect(JSON.stringify(requests[2])).not.toContain("ambient-gemini-key");
  });

  it("keeps the current Claude default endpoint when baseUrl is undefined", async () => {
    const urls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify(buildClaudeBody("claude-candidate")), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await callTextModelWithMetadata({
      prompt: "proposal-only",
      endpoint: {
        provider: "claude",
        apiKey: "request-key",
        model: "claude-pinned",
      },
      maxOutputTokens: 256,
      maxAttempts: 1,
    });

    expect(urls).toEqual(["https://api.anthropic.com/v1/messages"]);
  });

  it("fails closed on a blank explicit Claude apiKey without sending a request", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch should not run");
    }) as unknown as typeof fetch;

    await expect(callTextModelWithMetadata({
      prompt: "proposal-only",
      endpoint: {
        provider: "claude",
        baseUrl: "https://pinned.example/v1/messages",
        apiKey: "",
        model: "claude-pinned",
      },
      maxOutputTokens: 256,
      maxAttempts: 1,
    })).rejects.toThrow(/api|key|ANTHROPIC/i);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fails closed on a missing explicit Claude apiKey without sending a request", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch should not run");
    }) as unknown as typeof fetch;

    await expect(callTextModelWithMetadata({
      prompt: "proposal-only",
      endpoint: {
        provider: "claude",
        baseUrl: "https://pinned.example/v1/messages",
        model: "claude-pinned",
      },
      maxOutputTokens: 256,
      maxAttempts: 1,
    })).rejects.toThrow(/api|key|ANTHROPIC/i);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("fails closed on a missing explicit Gemini apiKey without sending a request", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch should not run");
    }) as unknown as typeof fetch;

    await expect(callTextModelWithMetadata({
      prompt: "proposal-only",
      endpoint: {
        provider: "gemini",
        baseUrl: "https://pinned.example/v1beta/models",
        model: "gemini-pinned",
      },
      maxOutputTokens: 256,
      maxAttempts: 1,
    })).rejects.toThrow(/api|key|GEMINI/i);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("makes one failed pinned request without switching provider or model", async () => {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return new Response(JSON.stringify({ error: "bad key" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await expect(callTextModelWithMetadata({
      prompt: "proposal-only",
      endpoint: {
        provider: "gemini",
        baseUrl: "https://pinned.example/v1beta/models",
        apiKey: "request-key",
        model: "gemini-pinned",
      },
      maxOutputTokens: 256,
      maxAttempts: 1,
    })).rejects.toThrow();

    expect(requests).toHaveLength(1);
    expect(requests[0].url.startsWith("https://pinned.example/")).toBe(true);
    expect(requests[0].url).toContain("gemini-pinned");
    expect(requests.some((request) => request.url.includes("anthropic.com"))).toBe(false);
    expect(requests.some((request) => JSON.stringify(request.body).includes("claude"))).toBe(false);
  });

  it("rejects a pinned Claude seed because the provider cannot honor it", async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error("fetch should not run");
    }) as unknown as typeof fetch;

    await expect(callTextModelWithMetadata({
      prompt: "proposal-only",
      endpoint: {
        provider: "claude",
        baseUrl: "https://pinned.example/v1/messages",
        apiKey: "request-key",
        model: "claude-pinned",
      },
      maxOutputTokens: 256,
      maxAttempts: 1,
      seed: 7,
    })).rejects.toThrow(/seed/i);

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
