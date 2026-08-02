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
const POLICY_VERSION = "c3-model-proposal-v5";
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
  attempts: 1 | 2;
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

  // Parse-failure retry, and nothing else. JSON.parse failures of the
  // UNWRAPPED content are the measured recoverable class (malformed JSON);
  // schema rejections, byte-limit hits, private-marker hits, and call errors
  // are single-attempt, exactly as before. Each generation runs at
  // HTTP-level maxAttempts 1 so the two retry domains do not tangle
  // (fetchWithRetry transient handling is unchanged).
  let attempts: 1 | 2 = 1;
  let totalLatencyMs = 0;
  let usageAccum: ModelRecordInput["usage"] | null = null;

  for (let generation = 1; generation <= parameters.maxAttempts; generation++) {
    attempts = generation as 1 | 2;

    let modelResult: ModelCallResult;
    try {
      modelResult = await runtime.call({
        prompt,
        endpoint,
        maxOutputTokens: parameters.maxOutputTokens,
        maxAttempts: 1,
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

    totalLatencyMs += modelResult.latencyMs;

    const generationUsage = normalizeUsage(modelResult.usage);
    if (!generationUsage) {
      return fallback("call-failed");
    }
    // Summed across generations: the discarded attempt's tokens were billed,
    // and a lane whose purpose is auditability must not drop them.
    const prior: ModelRecordInput["usage"] = usageAccum ?? { promptTokens: 0, completionTokens: 0 };
    usageAccum = {
      promptTokens: prior.promptTokens + generationUsage.promptTokens,
      completionTokens: prior.completionTokens + generationUsage.completionTokens,
    };

    if (byteLength(modelResult.content) > MAX_MODEL_TEXT_BYTES) {
      return fallback("proposal-rejected");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(unwrapExactCodeFence(modelResult.content.trim()));
    } catch {
      // The ONLY retryable failure class: structurally invalid JSON.
      if (generation < parameters.maxAttempts) continue;
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
        usage: usageAccum!,
        attempts,
        latencyMs: totalLatencyMs,
      },
    };
  }

  // Unreachable: maxAttempts is always >= 1 and every iteration returns or
  // continues. Kept so the function's return type is total without a cast.
  return fallback("proposal-rejected");
}

function evidenceSummaries(rows: readonly SanitizedEvidence[]): string[] {
  return rows
    .filter((row) => row.kind !== "recipe-system" && row.summary.trim().length > 0)
    .map((row) => row.summary);
}

function buildPrompt(
  request: CreateUiSpecRequest,
  sanitizedEvidence: readonly SanitizedEvidence[],
): string {
  return canonicalJsonStringify({
    policyVersion: POLICY_VERSION,
    task: "Produce a bounded UI-spec proposal as one JSON object and nothing else. "
      + "Be concise. State each decision once, with one sentence of rationale. "
      + "Drop the DECISION/EFFECT/REJECTS scaffolding where it adds no information.",
    responsePolicy: {
      status: "proposal-only",
      disclaimer: FIXED_DISCLAIMER,
      format: "Return strict JSON only. No markdown fences. No leading or trailing prose.",
      // Bounds are restated at top level because a per-field note was not enough:
      // a live claude-sonnet-4-5 run overshot a stated limit by 6%. Exceeding ANY bound discards everything.
      // These figures MUST mirror outputShape below exactly: a per-field limit is
      // a lever on generated length, and two different numbers for one bound make
      // the model clamp toward the larger one.
      hardLimits: {
        // SHRUNK 4000 -> 1000. A ~5000-char single-line value is exactly where
        // a live model lost nesting track and emitted a stray "}" — so the cap
        // went DOWN, not up. 1000 chars is still a full paragraph of direction.
        designDirection: "1000 characters maximum",
        contentVoiceGuidance: "500 characters maximum",
        motionNotes: "6 entries maximum, 250 characters each",
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
    // Real derived summaries only. recipe-system rows are operator
    // scaffolding, never evidence. Omit the key when nothing real exists —
    // a content-free label is worse than no grounding at all.
    ...(evidenceSummaries(sanitizedEvidence).length > 0
      ? { evidenceSummaries: evidenceSummaries(sanitizedEvidence) }
      : {}),
    // TYPES AND BOUNDS, not just field names. The v1 policy listed names only
    // ("required: designDirection"), and a live Claude run answered with
    // designDirection as a nested OBJECT — schema-legal-looking, schema-invalid,
    // rejected. A model cannot honor a bound it was never told.
    // THE PROMPT NUMBER IS ALWAYS BELOW THE SCHEMA CAP — roughly half.
    //
    // Live claude-sonnet-4-5 overshoots any stated length, and the ratio grows
    // as the instruction tightens: told 2000 it wrote 2118, told 1000 it wrote
    // 1549 (+55%). Stating the cap itself therefore guarantees rejection of
    // otherwise-good proposals — that is exactly how a run was lost on
    // motionNotes after designDirection was fixed. The prompt figure is a LEVER
    // on generated length (shorter output is also what killed the stray-brace
    // derail); the schema figure is the BOUND. They are different jobs and must
    // stay different numbers.
    outputShape: {
      status: 'string, exactly "proposal-only"',
      disclaimer: `string, exactly ${JSON.stringify(FIXED_DISCLAIMER)}`,
      designDirection:
        "REQUIRED. A single plain string. NOT an object, NOT an array. HARD LIMIT 1000 characters — "
        + "overshooting discards the whole proposal. Be concise; "
        + "prefer the decision over the rationale.",
      colorTokens:
        "optional object with exactly these string keys: primary, surface, ink, muted, accent. Omit the key entirely rather than sending a partial object.",
      typographyTokens:
        "optional object with exactly these string keys: heading, body, mono. Omit the key entirely rather than sending a partial object.",
      motionNotes: "optional array of at most 6 plain strings, each at most 250 characters",
      contentVoiceGuidance: "optional plain string, at most 500 characters",
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
  // Operator channel: one concise line per non-success. No prompt, no
  // response bytes, no key material.
  console.error(`[create-ui-spec-model] lane fallback: ${state}`);
  return {
    kind: "fallback",
    execution: ModelExecutionSchema.parse({ state }) as Exclude<ModelExecution, { state: "succeeded" }>,
  };
}
