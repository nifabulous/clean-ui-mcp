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
    // v3: the output contract SHRINKS the designDirection cap 4000 -> 1000 (a
    // ~5000-char single-line value is where a live model lost nesting track and
    // emitted a stray "}"). The version is hashed into promptSha256, so bumping
    // it is how a prompt change stays honest about not being the v2 prompt.
    expect(request.prompt).toContain("\"policyVersion\":\"c3-model-proposal-v4\"");
    // The bound a live model violated when it was only given a field name.
    expect(request.prompt).toContain("NOT an object, NOT an array");
    // The prompt figure must stay BELOW the schema cap (1000 vs 2000). Stating
    // the cap itself is what rejected live, well-formed proposals.
    expect(request.prompt).toContain("HARD LIMIT 1000 characters");
    expect(request.prompt).toContain("at most 250 characters");
    // Shrink is enforced at the gate the prompt feeds: 4000 is no longer a thing.
    expect(request.prompt).toContain("HARD LIMIT 1000 characters");
    expect(request.prompt).not.toContain("HARD LIMIT 4000 characters");
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

  it("rejects caller-controlled generic urls and path-like text before the provider call", async () => {
    const runtime = buildRuntime();
    const input = buildInput({
      request: {
        ...buildInput().request,
        productContext: "Review the reference at https://notes.example/internal before drafting the workspace.",
        implementationFramework: "Load tokens from /Users/demo/design-system/tokens.json",
        designSystem: {
          status: "identified",
          library: "file://shared/design-system.json",
          registry: "registry path C:\\design\\registry",
        },
        constraints: [
          "Mirror the spacing from https://assets.example/spacing-guide.",
          "Preserve the existing config at ../private/layout.md.",
        ],
      },
    });

    const result = await createUiSpecModel(input, runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "proposal-rejected" },
    });
    expect(runtime.call).not.toHaveBeenCalled();
  });

  it("rejects caller-controlled bare-domain urls before the provider call", async () => {
    const runtime = buildRuntime();
    const input = buildInput({
      request: {
        ...buildInput().request,
        productContext: "Review the reference at example.com/internal before drafting the workspace.",
        implementationFramework: "Mirror the widgets from www.example.com/internal/ui.",
        designSystem: {
          status: "identified",
          library: "shared tokens from design.example.com/foundations",
        },
        constraints: [
          "Follow the spacing notes in assets.example.com/internal/spacing.",
          "Keep the view operational and scan-friendly.",
        ],
      },
    });

    const result = await createUiSpecModel(input, runtime);

    expect(result).toEqual({
      kind: "fallback",
      execution: { state: "proposal-rejected" },
    });
    expect(runtime.call).not.toHaveBeenCalled();
  });

  it("rejects caller-controlled windows unc paths before the provider call", async () => {
    const runtime = buildRuntime();
    const input = buildInput({
      request: {
        ...buildInput().request,
        productContext: "Load the prior design from \\\\server\\share\\design.json before drafting the workspace.",
        implementationFramework: "Keep the app quiet and operational.",
        designSystem: {
          status: "identified",
          library: "Reference \\\\design-host\\tokens\\system.json for parity.",
        },
        constraints: [
          "Preserve the layout notes in \\\\ops-fs\\ui\\layouts\\dense-grid.md.",
          "Keep the view operational and scan-friendly.",
        ],
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

  // CHANGED DELIBERATELY. This test previously pinned fenced JSON as REJECTED.
  // A live claude-sonnet-4-5 run returned ```json-wrapped output despite the
  // response policy saying not to, so every real call failed before the schema
  // ever ran — the lane had never once succeeded against a real provider.
  // Unwrapping ONE exact whole-payload fence is not the lenient recovery the
  // design forbids: the three tests below pin that everything else still fails.
  it("accepts a payload that is entirely one fenced block", async () => {
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

    expect(result.kind).toBe("accepted");
    if (result.kind !== "accepted") return;
    expect(result.proposal.status).toBe("proposal-only");
  });

  it("still rejects prose before a fence, a second fence, or an unterminated fence", async () => {
    const proposal = JSON.stringify(buildProposal());
    const cases: Array<[string, string]> = [
      ["prose then fence", `Here you go:\n\`\`\`json\n${proposal}\n\`\`\``],
      ["two fenced blocks", `\`\`\`json\n${proposal}\n\`\`\`\n\`\`\`json\n${proposal}\n\`\`\``],
      ["unterminated fence", `\`\`\`json\n${proposal}`],
    ];
    for (const [label, content] of cases) {
      const runtime = buildRuntime(async () => ({
        content,
        provider: "openai",
        model: "gpt-5-mini",
        usage: { promptTokens: 1, completionTokens: 1, raw: { prompt_tokens: 1, completion_tokens: 1 } },
        attempts: 1,
        latencyMs: 10,
        providerRequestId: null,
      }));
      const result = await createUiSpecModel(buildInput(), runtime);
      expect(result, `"${label}" must not be recovered`).toEqual({
        kind: "fallback",
        execution: { state: "proposal-rejected" },
      });
    }
  });

  it("rejects a designDirection that is an object rather than a string", async () => {
    // The other half of the live failure: the model answered designDirection as
    // a nested object. The prompt now states the type and bound; the schema is
    // the backstop, and this pins it.
    const runtime = buildRuntime(async () => ({
      content: JSON.stringify({
        ...buildProposal(),
        designDirection: { primaryDecision: "QR code first", rationale: "scanning is faster" },
      }),
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

  it("rejects the derail signature: a long string then a stray root brace", async () => {
    // Live claude-sonnet-4-5 reproduced this deterministically: after an
    // enormous single-line designDirection the model emitted `},` again and a
    // sibling key — structurally invalid JSON, rejected at JSON.parse. This
    // pins the honest behavior: the lane falls back cleanly, it does NOT try to
    // recover a substring and it does NOT mask the failure as a success.
    const strayBrace = `{
      "status": "proposal-only",
      "disclaimer": "${"Proposal only; not accepted into token authority."}",
      "designDirection": "${"x".repeat(5_000)}",
    },                          "contentVoiceGuidance": "ignored sibling",
    "status": "proposal-only"
  }`;
    const runtime = buildRuntime(async () => ({
      content: strayBrace,
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
