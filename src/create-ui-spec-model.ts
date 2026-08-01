import { callTextModelWithMetadata, type ModelCallResult } from "./tagger.js";
import type {
  CreateUiSpecRequest,
  SanitizedEvidence,
} from "./create-ui-spec-contracts.js";
import {
  CreateUiSpecRequestSchema,
  SanitizedEvidenceSchema,
  containsPrivateMarker,
} from "./create-ui-spec-contracts.js";
import {
  ModelExecutionSchema,
  ModelGenerationParametersSchema,
  PinnedModelEndpointSchema,
  type ModelExecution,
  type ModelGenerationParameters,
  type PinnedModelEndpoint,
} from "./create-ui-spec-model-contracts.js";
import type { ModelArtifactStore } from "./model-artifact-store.js";
import { canonicalJsonStringify, sha256Hex } from "./readiness/contracts.js";
import { ModelProposalSchema, type ModelProposal } from "./tool-contracts.js";

const MAX_MODEL_TEXT_BYTES = 32 * 1024;
const FIXED_DISCLAIMER = "Proposal only; not accepted into token authority.";
const POLICY_VERSION = "c3-model-proposal-v1";
const RESPONSE_SCOPED_EVIDENCE_ID_RE = /\bevidence-[0-9]+\b/;
const SOURCE_PRIVATE_ID_RE = /\bsource-private-[A-Za-z0-9_-]+\b/;

export interface CreateUiSpecModelInput {
  request: CreateUiSpecRequest;
  sanitizedEvidence: readonly SanitizedEvidence[];
}

export interface CreateUiSpecModelRuntime {
  endpoint: PinnedModelEndpoint;
  parameters: ModelGenerationParameters;
  call: typeof callTextModelWithMetadata;
  store: ModelArtifactStore;
}

export interface ModelRecordInput {
  proposalSha256: string;
  promptSha256: string;
  parametersSha256: string;
  proposal: ModelProposal;
  provider: PinnedModelEndpoint["provider"];
  model: string;
  endpointOrigin: string;
  parameters: ModelGenerationParameters;
  usage: {
    promptTokens: number;
    completionTokens: number;
  };
  attempts: 1;
  latencyMs: number;
}

export type ModelPathOutcome =
  | {
    kind: "accepted";
    proposal: ModelProposal;
    execution: ModelExecution;
    recordInput: ModelRecordInput;
  }
  | {
    kind: "fallback";
    execution: Exclude<ModelExecution, { state: "succeeded" }>;
  };

export async function createUiSpecModel(
  input: CreateUiSpecModelInput,
  runtime: CreateUiSpecModelRuntime,
): Promise<ModelPathOutcome> {
  const endpointParsed = PinnedModelEndpointSchema.safeParse(runtime.endpoint);
  const parametersParsed = ModelGenerationParametersSchema.safeParse(runtime.parameters);
  if (!endpointParsed.success || !parametersParsed.success) {
    return fallback("invalid-configuration");
  }

  const requestParsed = CreateUiSpecRequestSchema.safeParse(input.request);
  const evidenceParsed = SanitizedEvidenceSchema.array().safeParse(input.sanitizedEvidence);
  if (!requestParsed.success || !evidenceParsed.success) {
    return fallback("proposal-rejected");
  }

  const endpoint = endpointParsed.data;
  const parameters = parametersParsed.data;
  const request = requestParsed.data;
  const sanitizedEvidence = evidenceParsed.data;

  const prompt = buildPrompt(request, sanitizedEvidence);
  if (!isPromptSafe(prompt, endpoint)) {
    return fallback("proposal-rejected");
  }
  if (byteLength(prompt) > MAX_MODEL_TEXT_BYTES) {
    return fallback("proposal-rejected");
  }

  const promptSha256 = sha256Hex(Buffer.from(prompt, "utf-8"));
  const parametersSha256 = sha256Hex(
    Buffer.from(canonicalJsonStringify(parameters), "utf-8"),
  );

  let modelResult: ModelCallResult;
  try {
    modelResult = await runtime.call({
      prompt,
      endpoint,
      maxOutputTokens: parameters.maxOutputTokens,
      maxAttempts: parameters.maxAttempts,
      temperature: parameters.temperature,
    });
  } catch {
    return fallback("call-failed");
  }

  if (
    modelResult.provider !== endpoint.provider
    || modelResult.model !== endpoint.model
    || modelResult.attempts !== 1
    || !Number.isInteger(modelResult.latencyMs)
    || modelResult.latencyMs < 0
  ) {
    return fallback("call-failed");
  }

  const usage = normalizeUsage(modelResult.usage);
  if (!usage) {
    return fallback("call-failed");
  }

  if (byteLength(modelResult.content) > MAX_MODEL_TEXT_BYTES) {
    return fallback("proposal-rejected");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(modelResult.content.trim());
  } catch {
    return fallback("proposal-rejected");
  }

  const proposalParsed = ModelProposalSchema.safeParse(parsedJson);
  if (!proposalParsed.success) {
    return fallback("proposal-rejected");
  }

  const proposal = ModelProposalSchema.parse({
    ...proposalParsed.data,
    status: "proposal-only",
    disclaimer: FIXED_DISCLAIMER,
  });
  if (containsPrivateMarkerDeep(proposal)) {
    return fallback("proposal-rejected");
  }

  const proposalSha256 = sha256Hex(
    Buffer.from(canonicalJsonStringify(proposal), "utf-8"),
  );

  return {
    kind: "accepted",
    proposal,
    execution: ModelExecutionSchema.parse({
      state: "succeeded",
      provider: endpoint.provider,
      model: endpoint.model,
      promptSha256,
      parametersSha256,
      reproducibility: "conditional",
    }),
    recordInput: {
      proposalSha256,
      promptSha256,
      parametersSha256,
      proposal,
      provider: endpoint.provider,
      model: endpoint.model,
      endpointOrigin: new URL(endpoint.baseUrl).origin,
      parameters,
      usage,
      attempts: 1,
      latencyMs: modelResult.latencyMs,
    },
  };
}

function buildPrompt(
  request: CreateUiSpecRequest,
  sanitizedEvidence: readonly SanitizedEvidence[],
): string {
  return canonicalJsonStringify({
    policyVersion: POLICY_VERSION,
    task: "Produce a bounded UI-spec proposal as one JSON object and nothing else.",
    responsePolicy: {
      status: "proposal-only",
      disclaimer: FIXED_DISCLAIMER,
      format: "Return strict JSON only. No markdown fences. No leading or trailing prose.",
      forbidden: [
        "authority escalation",
        "unknown keys",
        "private corpus markers",
        "file paths",
        "endpoint data",
      ],
    },
    callerContext: compactObject({
      productContext: request.productContext,
      platform: request.platform,
      implementationFramework: request.implementationFramework,
      designSystem: request.designSystem,
      target: request.target,
    }),
    intent: compactObject({
      motionIntents: request.motionIntents.length > 0 ? request.motionIntents : undefined,
      colorIntent: request.colorIntent,
      typeIntent: request.typeIntent,
    }),
    constraints: request.constraints,
    evidenceSummaries: sanitizedEvidence.map((row) => row.summary),
    outputShape: {
      required: ["status", "disclaimer", "designDirection"],
      optional: [
        "colorTokens",
        "typographyTokens",
        "motionNotes",
        "contentVoiceGuidance",
      ],
    },
  });
}

function compactObject<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function isPromptSafe(prompt: string, endpoint: PinnedModelEndpoint): boolean {
  if (byteLength(prompt) > MAX_MODEL_TEXT_BYTES) return false;
  if (containsPrivateMarker(prompt)) return false;
  if (RESPONSE_SCOPED_EVIDENCE_ID_RE.test(prompt)) return false;
  if (SOURCE_PRIVATE_ID_RE.test(prompt)) return false;
  if (prompt.includes(endpoint.apiKey)) return false;
  if (prompt.includes(endpoint.baseUrl)) return false;
  return true;
}

function containsPrivateMarkerDeep(value: unknown): boolean {
  if (typeof value === "string") return containsPrivateMarker(value);
  if (Array.isArray(value)) return value.some(containsPrivateMarkerDeep);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsPrivateMarkerDeep);
  }
  return false;
}

function normalizeUsage(
  usage: ModelCallResult["usage"] | undefined,
): ModelRecordInput["usage"] | null {
  if (!usage) return null;
  if (
    !Number.isInteger(usage.promptTokens)
    || usage.promptTokens <= 0
    || !Number.isInteger(usage.completionTokens)
    || usage.completionTokens <= 0
  ) {
    return null;
  }
  return {
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
  };
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf-8");
}

function fallback(
  state: Extract<ModelExecution["state"], "invalid-configuration" | "call-failed" | "proposal-rejected" | "persistence-failed">,
): ModelPathOutcome {
  return {
    kind: "fallback",
    execution: ModelExecutionSchema.parse({ state }) as Exclude<ModelExecution, { state: "succeeded" }>,
  };
}
