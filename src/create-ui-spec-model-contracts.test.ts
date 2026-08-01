import { describe, expect, it } from "vitest";
import {
  ModelArtifactRecordSchema,
  ModelExecutionSchema,
  ModelGenerationParametersSchema,
  PinnedModelEndpointSchema,
} from "./create-ui-spec-model-contracts.js";
import { ModelProposalSchema } from "./tool-contracts.js";
import { canonicalJsonStringify, sha256Hex } from "./readiness/contracts.js";

const sha = (char: string) => char.repeat(64);

function validProposal() {
  return ModelProposalSchema.parse({
    status: "proposal-only",
    disclaimer: "Proposal only; not accepted into token authority.",
    designDirection: "Use a focused workspace with restrained emphasis.",
    colorTokens: {
      primary: "#2563eb",
      surface: "#ffffff",
      ink: "#111827",
      muted: "#6b7280",
      accent: "#f59e0b",
    },
    typographyTokens: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
    motionNotes: ["Keep view transitions brief and interruptible."],
    contentVoiceGuidance: "Direct, calm, and concise.",
  });
}

function hashCanonical(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJsonStringify(value), "utf-8"));
}

function validRecord(): Record<string, unknown> {
  const proposal = validProposal();
  const parameters = {
    temperature: 0,
    maxOutputTokens: 4096,
    maxAttempts: 1,
    seed: null,
  };
  return {
    recordVersion: "1.0",
    artifactId: `uispec-${sha("a")}`,
    specSha256: sha("b"),
    semanticSpecSha256: sha("c"),
    proposalSha256: hashCanonical(proposal),
    promptSha256: sha("e"),
    parametersSha256: hashCanonical(parameters),
    proposal,
    provider: "openai",
    model: "gpt-5-mini",
    endpointOrigin: "https://api.openai.com",
    parameters,
    usage: { promptTokens: 420, completionTokens: 180 },
    attempts: 1,
    latencyMs: 640,
    storedAt: "2026-08-01T12:00:00.000Z",
    retention: "until-explicit-delete",
  };
}

describe("PinnedModelEndpointSchema", () => {
  it("accepts a complete HTTPS endpoint tuple", () => {
    expect(PinnedModelEndpointSchema.parse({
      provider: "claude",
      baseUrl: "https://pinned.example/v1/messages",
      apiKey: "request-key",
      model: "claude-pinned",
    })).toEqual({
      provider: "claude",
      baseUrl: "https://pinned.example/v1/messages",
      apiKey: "request-key",
      model: "claude-pinned",
    });
  });

  it("rejects partial, insecure, blank, and extended endpoint tuples", () => {
    const valid = {
      provider: "openai",
      baseUrl: "https://pinned.example/v1",
      apiKey: "request-key",
      model: "gpt-pinned",
    };
    const invalid = [
      { ...valid, apiKey: undefined },
      { ...valid, apiKey: "" },
      { ...valid, baseUrl: "http://pinned.example/v1" },
      { ...valid, provider: "fallback-provider" },
      { ...valid, model: " ".repeat(2) },
      { ...valid, requestHeaders: { authorization: "secret" } },
    ];
    for (const endpoint of invalid) {
      expect(PinnedModelEndpointSchema.safeParse(endpoint).success).toBe(false);
    }
  });
});

describe("ModelGenerationParametersSchema", () => {
  const fixed = { temperature: 0, maxOutputTokens: 4096, maxAttempts: 1, seed: null };

  it("accepts exactly the first-slice generation parameters", () => {
    expect(ModelGenerationParametersSchema.parse(fixed)).toEqual(fixed);
  });

  it("rejects parameter drift and unknown controls", () => {
    expect(ModelGenerationParametersSchema.safeParse({ ...fixed, temperature: 0.1 }).success).toBe(false);
    expect(ModelGenerationParametersSchema.safeParse({ ...fixed, maxOutputTokens: 8192 }).success).toBe(false);
    expect(ModelGenerationParametersSchema.safeParse({ ...fixed, maxAttempts: 2 }).success).toBe(false);
    expect(ModelGenerationParametersSchema.safeParse({ ...fixed, seed: 42 }).success).toBe(false);
    expect(ModelGenerationParametersSchema.safeParse({ ...fixed, topP: 1 }).success).toBe(false);
  });
});

describe("ModelExecutionSchema", () => {
  it.each([
    "invalid-configuration",
    "call-failed",
    "proposal-rejected",
    "persistence-failed",
  ] as const)("accepts the safe %s state without diagnostics", (state) => {
    expect(ModelExecutionSchema.parse({ state })).toEqual({ state });
  });

  it("accepts bounded succeeded metadata", () => {
    expect(ModelExecutionSchema.safeParse({
      state: "succeeded",
      provider: "gemini",
      model: "gemini-pinned",
      promptSha256: sha("a"),
      parametersSha256: sha("b"),
      reproducibility: "conditional",
    }).success).toBe(true);
  });

  it("does not define a not-configured state", () => {
    expect(ModelExecutionSchema.safeParse({ state: "not-configured" }).success).toBe(false);
  });

  it("rejects provider diagnostics and malformed succeeded metadata", () => {
    const succeeded = {
      state: "succeeded",
      provider: "openai",
      model: "gpt-pinned",
      promptSha256: sha("a"),
      parametersSha256: sha("b"),
      reproducibility: "conditional",
    };
    expect(ModelExecutionSchema.safeParse({ state: "call-failed", providerErrorBody: "secret" }).success).toBe(false);
    expect(ModelExecutionSchema.safeParse({ ...succeeded, promptSha256: "bad" }).success).toBe(false);
    expect(ModelExecutionSchema.safeParse({ ...succeeded, reproducibility: "deterministic" }).success).toBe(false);
    expect(ModelExecutionSchema.safeParse({ ...succeeded, apiKey: "secret" }).success).toBe(false);
  });
});

describe("ModelArtifactRecordSchema", () => {
  it("accepts a validated proposal with safe execution history", () => {
    const parsed = ModelArtifactRecordSchema.parse(validRecord());
    expect(parsed.proposal.status).toBe("proposal-only");
    expect(parsed.retention).toBe("until-explicit-delete");
    expect(parsed.endpointOrigin).toBe("https://api.openai.com");
  });

  it("binds the proposal and fixed parameters to their hashes", () => {
    const proposalMismatch = validRecord();
    proposalMismatch.proposalSha256 = sha("f");
    expect(ModelArtifactRecordSchema.safeParse(proposalMismatch).success).toBe(false);

    const parametersMismatch = validRecord();
    parametersMismatch.parametersSha256 = sha("f");
    expect(ModelArtifactRecordSchema.safeParse(parametersMismatch).success).toBe(false);
  });

  it("stores an origin only, without endpoint credentials, paths, or query data", () => {
    for (const endpointOrigin of [
      "https://user:pass@api.example.com",
      "https://api.example.com/v1",
      "https://api.example.com?key=secret",
      "http://api.example.com",
    ]) {
      expect(ModelArtifactRecordSchema.safeParse({ ...validRecord(), endpointOrigin }).success).toBe(false);
    }
  });

  it("rejects raw prompts, responses, credentials, headers, and provider error bodies", () => {
    for (const [field, value] of [
      ["rawPrompt", "private prompt"],
      ["rawResponse", "provider body"],
      ["apiKey", "secret"],
      ["credential", "secret"],
      ["requestHeaders", { authorization: "secret" }],
      ["providerErrorBody", "private diagnostics"],
    ] as const) {
      expect(ModelArtifactRecordSchema.safeParse({ ...validRecord(), [field]: value }).success).toBe(false);
    }
  });

  it("bounds normalized usage, attempts, latency, timestamps, and retention", () => {
    expect(ModelArtifactRecordSchema.safeParse({ ...validRecord(), usage: { promptTokens: -1, completionTokens: 1 } }).success).toBe(false);
    expect(ModelArtifactRecordSchema.safeParse({ ...validRecord(), attempts: 2 }).success).toBe(false);
    expect(ModelArtifactRecordSchema.safeParse({ ...validRecord(), latencyMs: -1 }).success).toBe(false);
    expect(ModelArtifactRecordSchema.safeParse({ ...validRecord(), storedAt: "yesterday" }).success).toBe(false);
    expect(ModelArtifactRecordSchema.safeParse({ ...validRecord(), retention: "temporary" }).success).toBe(false);
  });
});
