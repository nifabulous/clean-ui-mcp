import { describe, expect, it, vi } from "vitest";
import { createUiSpecModel, type CreateUiSpecModelInput, type CreateUiSpecModelRuntime } from "./create-ui-spec-model.js";
import {
  ModelGenerationParametersSchema,
  PinnedModelEndpointSchema,
} from "./create-ui-spec-model-contracts.js";
import { canonicalJsonStringify, sha256Hex } from "./readiness/contracts.js";

const FIXED_DISCLAIMER = "Proposal only; not accepted into token authority.";

function buildInput(overrides: Partial<CreateUiSpecModelInput> = {}): CreateUiSpecModelInput {
  return {
    request: {
      productContext: "Internal analytics workspace for finance operators.",
      referenceIds: [],
      platform: "web",
      implementationFramework: "React",
      constraints: [
        "Prioritize dense scanability over presentation flair.",
        "Keep states legible in low-contrast office lighting.",
      ],
      target: "neutral-web",
      motionIntents: [],
    },
    sanitizedEvidence: [
      {
        id: "evidence-1",
        kind: "recipe-system",
        basis: "aggregate",
        summary: "Favor compact hierarchy, restrained emphasis, and stable column alignment.",
        structuredFacts: {},
      },
      {
        id: "evidence-2",
        kind: "public-reference",
        basis: "user-supplied",
        summary: "The operator wants quick comparison across dense tables and side panels.",
        structuredFacts: {},
        publicReference: "https://public.example/reference",
      },
    ],
    ...overrides,
  };
}

function buildProposal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "proposal-only",
    disclaimer: FIXED_DISCLAIMER,
    designDirection: "Use a quiet, compact workspace with strong row grouping and careful emphasis.",
    colorTokens: {
      primary: "#2563eb",
      surface: "#ffffff",
      ink: "#111827",
      muted: "#6b7280",
      accent: "#f59e0b",
    },
    typographyTokens: {
      heading: "Inter",
      body: "Inter",
      mono: "JetBrains Mono",
    },
    motionNotes: ["Keep filters and panel transitions brief and interruptible."],
    contentVoiceGuidance: "Direct, calm, and operational.",
    ...overrides,
  };
}

function buildRuntime(
  implementation?: (
    request: Parameters<CreateUiSpecModelRuntime["call"]>[0],
  ) => ReturnType<CreateUiSpecModelRuntime["call"]>,
): CreateUiSpecModelRuntime & { call: ReturnType<typeof vi.fn> } {
  return {
    endpoint: PinnedModelEndpointSchema.parse({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1/responses",
      apiKey: "runtime-secret-key",
      model: "gpt-5-mini",
    }),
    parameters: ModelGenerationParametersSchema.parse({
      temperature: 0,
      maxOutputTokens: 4096,
      maxAttempts: 1,
      seed: null,
    }),
    call: vi.fn(implementation ?? (async () => ({
      content: JSON.stringify(buildProposal()),
      provider: "openai",
      model: "gpt-5-mini",
      usage: {
        promptTokens: 123,
        completionTokens: 45,
        raw: { prompt_tokens: 123, completion_tokens: 45 },
      },
      attempts: 1,
      latencyMs: 789,
      providerRequestId: "req_123",
    }))),
    store: {
      save: vi.fn(async () => {}),
      read: vi.fn(async () => null),
      delete: vi.fn(async () => false),
    },
  };
}

describe("createUiSpecModel prompt boundary", () => {
  it("builds a prompt from caller context, constraints, and sanitized evidence summaries without private runtime material", async () => {
    const runtime = buildRuntime();
    const input = buildInput();

    const result = await createUiSpecModel(input, runtime);

    expect(result.kind).toBe("accepted");
    expect(runtime.call).toHaveBeenCalledTimes(1);
    const [request] = runtime.call.mock.calls[0] as [Parameters<CreateUiSpecModelRuntime["call"]>[0]];
    expect(request.prompt).toContain("Internal analytics workspace for finance operators.");
    expect(request.prompt).toContain("Prioritize dense scanability over presentation flair.");
    expect(request.prompt).toContain("Favor compact hierarchy, restrained emphasis, and stable column alignment.");
    expect(request.prompt).toContain("\"policyVersion\":\"c3-model-proposal-v1\"");
    expect(request.prompt).not.toContain("runtime-secret-key");
    expect(request.prompt).not.toContain("https://api.openai.com/v1/responses");
    expect(request.prompt).not.toContain("evidence-1");
    expect(request.prompt).not.toContain("evidence-2");
    expect(request.prompt).not.toContain("source-private-17");
    expect(request.prompt).not.toContain("private-corpus-id");
    expect(request.prompt).not.toContain("/corpus/private/");
  });

  it("rejects an oversized prompt before the provider call", async () => {
    const runtime = buildRuntime();
    const input = buildInput({
      request: {
        ...buildInput().request,
        productContext: "a".repeat(33_000),
      },
    });

    const result = await createUiSpecModel(input, runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "proposal-rejected" },
    });
    expect(runtime.call).not.toHaveBeenCalled();
  });
});

describe("createUiSpecModel response policy", () => {
  it("accepts valid JSON, preserves bounded metadata, and hashes the exact prompt and parameters", async () => {
    const runtime = buildRuntime();
    const input = buildInput();

    const result = await createUiSpecModel(input, runtime);

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") throw new Error("expected accepted result");

    const [request] = runtime.call.mock.calls[0] as [Parameters<CreateUiSpecModelRuntime["call"]>[0]];
    expect(request.endpoint).toEqual(runtime.endpoint);
    expect(request.maxOutputTokens).toBe(4096);
    expect(request.maxAttempts).toBe(1);
    expect(request.temperature).toBe(0);
    expect(request.seed).toBeUndefined();

    const expectedPromptSha256 = sha256Hex(Buffer.from(request.prompt, "utf-8"));
    const expectedParametersSha256 = sha256Hex(
      Buffer.from(canonicalJsonStringify(runtime.parameters), "utf-8"),
    );
    const expectedProposalSha256 = sha256Hex(
      Buffer.from(canonicalJsonStringify(result.proposal), "utf-8"),
    );

    expect(result.proposal).toEqual(buildProposal());
    expect(result.execution).toEqual({
      state: "succeeded",
      provider: "openai",
      model: "gpt-5-mini",
      promptSha256: expectedPromptSha256,
      parametersSha256: expectedParametersSha256,
      reproducibility: "conditional",
    });
    expect(result.recordInput).toEqual({
      proposalSha256: expectedProposalSha256,
      promptSha256: expectedPromptSha256,
      parametersSha256: expectedParametersSha256,
      proposal: buildProposal(),
      provider: "openai",
      model: "gpt-5-mini",
      endpointOrigin: "https://api.openai.com",
      parameters: runtime.parameters,
      usage: { promptTokens: 123, completionTokens: 45 },
      attempts: 1,
      latencyMs: 789,
    });
    expect(result.recordInput).not.toHaveProperty("providerRequestId");
    expect(result.recordInput).not.toHaveProperty("apiKey");
    expect(result.recordInput).not.toHaveProperty("rawPrompt");
    expect(result.recordInput).not.toHaveProperty("rawResponse");
  });

  it("rejects malformed JSON without recovery", async () => {
    const runtime = buildRuntime(async () => ({
      content: "{",
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 1, completionTokens: 1, raw: { prompt_tokens: 1, completion_tokens: 1 } },
      attempts: 1,
      latencyMs: 10,
      providerRequestId: null,
    }));

    const result = await createUiSpecModel(buildInput(), runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "proposal-rejected" },
    });
  });

  it("rejects fenced JSON without stripping markdown", async () => {
    const runtime = buildRuntime(async () => ({
      content: `\`\`\`json\n${JSON.stringify(buildProposal())}\n\`\`\``,
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 1, completionTokens: 1, raw: { prompt_tokens: 1, completion_tokens: 1 } },
      attempts: 1,
      latencyMs: 10,
      providerRequestId: null,
    }));

    const result = await createUiSpecModel(buildInput(), runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "proposal-rejected" },
    });
  });

  it("rejects trailing prose instead of recovering a JSON substring", async () => {
    const runtime = buildRuntime(async () => ({
      content: `${JSON.stringify(buildProposal())}\nThis is the direction.`,
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 1, completionTokens: 1, raw: { prompt_tokens: 1, completion_tokens: 1 } },
      attempts: 1,
      latencyMs: 10,
      providerRequestId: null,
    }));

    const result = await createUiSpecModel(buildInput(), runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "proposal-rejected" },
    });
  });

  it("rejects unknown keys", async () => {
    const runtime = buildRuntime(async () => ({
      content: JSON.stringify(buildProposal({ extra: "nope" })),
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 1, completionTokens: 1, raw: { prompt_tokens: 1, completion_tokens: 1 } },
      attempts: 1,
      latencyMs: 10,
      providerRequestId: null,
    }));

    const result = await createUiSpecModel(buildInput(), runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "proposal-rejected" },
    });
  });

  it("rejects output above 32 KiB before parsing", async () => {
    const runtime = buildRuntime(async () => ({
      content: JSON.stringify(buildProposal({ designDirection: "a".repeat(33_000) })),
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 1, completionTokens: 1, raw: { prompt_tokens: 1, completion_tokens: 1 } },
      attempts: 1,
      latencyMs: 10,
      providerRequestId: null,
    }));

    const result = await createUiSpecModel(buildInput(), runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "proposal-rejected" },
    });
  });

  it("rejects private markers anywhere in the parsed proposal", async () => {
    const runtime = buildRuntime(async () => ({
      content: JSON.stringify(buildProposal({
        motionNotes: ["Read /.c2-private/model-output.json before applying the palette."],
      })),
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 1, completionTokens: 1, raw: { prompt_tokens: 1, completion_tokens: 1 } },
      attempts: 1,
      latencyMs: 10,
      providerRequestId: null,
    }));

    const result = await createUiSpecModel(buildInput(), runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "proposal-rejected" },
    });
  });

  it("rejects proposal authority escalation", async () => {
    const runtime = buildRuntime(async () => ({
      content: JSON.stringify(buildProposal({
        status: "accepted",
      })),
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 1, completionTokens: 1, raw: { prompt_tokens: 1, completion_tokens: 1 } },
      attempts: 1,
      latencyMs: 10,
      providerRequestId: null,
    }));

    const result = await createUiSpecModel(buildInput(), runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "proposal-rejected" },
    });
  });

  it("rejects an empty proposal object", async () => {
    const runtime = buildRuntime(async () => ({
      content: "{}",
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 1, completionTokens: 1, raw: { prompt_tokens: 1, completion_tokens: 1 } },
      attempts: 1,
      latencyMs: 10,
      providerRequestId: null,
    }));

    const result = await createUiSpecModel(buildInput(), runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "proposal-rejected" },
    });
  });

  it("maps a provider refusal to call-failed without exposing provider diagnostics", async () => {
    const runtime = buildRuntime(async () => {
      throw new Error("401 unauthorized at https://api.openai.com/v1/responses with key sk-secret");
    });

    const result = await createUiSpecModel(buildInput(), runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "call-failed" },
    });
    expect(JSON.stringify(result)).not.toContain("https://api.openai.com");
    expect(JSON.stringify(result)).not.toContain("sk-secret");
  });

  it("maps a provider exception to call-failed", async () => {
    const runtime = buildRuntime(async () => {
      throw new TypeError("socket hang up");
    });

    const result = await createUiSpecModel(buildInput(), runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "call-failed" },
    });
  });

  it("rejects missing usage metadata from the injected runtime", async () => {
    const runtime = buildRuntime(async () => ({
      content: JSON.stringify(buildProposal()),
      provider: "openai",
      model: "gpt-5-mini",
      usage: undefined,
      attempts: 1,
      latencyMs: 10,
      providerRequestId: null,
    } as never));

    const result = await createUiSpecModel(buildInput(), runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "call-failed" },
    });
  });

  it("enforces a single pinned attempt in the request and the reported result", async () => {
    const runtime = buildRuntime(async () => ({
      content: JSON.stringify(buildProposal()),
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 1, completionTokens: 1, raw: { prompt_tokens: 1, completion_tokens: 1 } },
      attempts: 2,
      latencyMs: 10,
      providerRequestId: null,
    }));

    const result = await createUiSpecModel(buildInput(), runtime);

    expect(runtime.call).toHaveBeenCalledTimes(1);
    const [request] = runtime.call.mock.calls[0] as [Parameters<CreateUiSpecModelRuntime["call"]>[0]];
    expect(request.maxAttempts).toBe(1);
    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "call-failed" },
    });
  });
});
