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
const POLICY_VERSION = "c3-model-proposal-v2";
const RESPONSE_SCOPED_EVIDENCE_ID_RE = /\bevidence-[0-9]+\b/;
const SOURCE_PRIVATE_ID_RE = /\bsource-private-[A-Za-z0-9_-]+\b/;
const GENERIC_URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/\S+/i;
const BARE_HOST_URL_RE =
  /\b(?:www\.)?[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+(?:\/[^\s)]*)/i;
const UNIX_PATH_RE = /(^|[\s(])(?:\/|\.{1,2}\/|~\/)[^\s)]+/;
const WINDOWS_UNC_PATH_RE = /(^|[\s(])\\\\[^\\/\s)]+\\[^\\/\s)]+(?:\\[^\s)]*)?/;
const WINDOWS_PATH_RE = /(^|[\s(])[A-Za-z]:\\[^\s)]+/;

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

  if (containsUnsafeCallerText(request)) {
    return fallback("proposal-rejected");
  }

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
    parsedJson = JSON.parse(unwrapExactCodeFence(modelResult.content.trim()));
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
      // Bounds are restated at top level because a per-field note was not enough:
      // a live claude-sonnet-4-5 run overshot a stated limit by 6%. Exceeding ANY bound discards everything.
      hardLimits: {
        designDirection: "4000 characters maximum",
        contentVoiceGuidance: "1000 characters maximum",
        motionNotes: "8 entries maximum, 500 characters each",
        onExceeding: "the entire proposal is discarded and the caller receives no proposal at all",
      },
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
    // TYPES AND BOUNDS, not just field names. The v1 policy listed names only
    // ("required: designDirection"), and a live Claude run answered with
    // designDirection as a nested OBJECT — schema-legal-looking, schema-invalid,
    // rejected. A model cannot honor a bound it was never told.
    outputShape: {
      status: 'string, exactly "proposal-only"',
      disclaimer: `string, exactly ${JSON.stringify(FIXED_DISCLAIMER)}`,
      designDirection:
        "REQUIRED. A single plain string. NOT an object, NOT an array. HARD LIMIT 4000 characters — "
        + "overshooting discards the whole proposal. Be concise; "
        + "prefer the decision over the rationale.",
      colorTokens:
        "optional object with exactly these string keys: primary, surface, ink, muted, accent. Omit the key entirely rather than sending a partial object.",
      typographyTokens:
        "optional object with exactly these string keys: heading, body, mono. Omit the key entirely rather than sending a partial object.",
      motionNotes: "optional array of at most 8 plain strings, each 1-500 characters",
      contentVoiceGuidance: "optional plain string, 1-1000 characters",
      unknownKeys: "forbidden — any key not listed above causes the whole proposal to be rejected",
    },
  });
}

/**
 * Unwrap a payload that is ENTIRELY one fenced code block, and nothing else.
 *
 * The response policy tells the model to send bare JSON, and a live
 * claude-sonnet-4-5 run wrapped it in ```json anyway — so every real call was
 * rejected before the schema ever ran. Restating the instruction more loudly is
 * not a fix; models fence JSON.
 *
 * THIS IS NOT LENIENT RECOVERY, which the design rightly forbids. There is no
 * substring search, no "find the first {", no brace matching. The content must
 * begin with a fence line and end with a closing fence, and only that exact
 * wrapper is removed; the inside still has to parse as strict JSON and still has
 * to satisfy the schema, the disclaimer overwrite, and the private-marker sweep.
 * Anything else — prose before the fence, two fences, an unterminated fence — is
 * returned untouched and fails `JSON.parse` exactly as it does today.
 */
function unwrapExactCodeFence(content: string): string {
  if (!content.startsWith("```") || !content.endsWith("```")) return content;
  const firstNewline = content.indexOf("\n");
  if (firstNewline === -1) return content;
  // The opening line may only be a fence plus an optional language tag.
  if (!/^```[A-Za-z0-9_-]*$/.test(content.slice(0, firstNewline).trimEnd())) return content;
  const inner = content.slice(firstNewline + 1, content.length - 3);
  // A second fence anywhere inside means this is not one single block.
  if (inner.includes("```")) return content;
  return inner.trim();
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

function containsUnsafeCallerText(value: unknown): boolean {
  if (typeof value === "string") {
    return containsPrivateMarker(value) || looksLikeGenericUrlOrPath(value);
  }
  if (Array.isArray(value)) return value.some(containsUnsafeCallerText);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsUnsafeCallerText);
  }
  return false;
}

function looksLikeGenericUrlOrPath(value: string): boolean {
  return GENERIC_URL_RE.test(value)
    || BARE_HOST_URL_RE.test(value)
    || UNIX_PATH_RE.test(value)
    || WINDOWS_UNC_PATH_RE.test(value)
    || WINDOWS_PATH_RE.test(value);
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
