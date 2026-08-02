/**
 * Strict contracts for the optional C3 proposal-only model path.
 *
 * Semantic proposal content lives in UiSpec. Public execution metadata lives
 * beside the artifact envelope. The private record keeps only bounded,
 * normalized telemetry and hashes; raw provider material is not representable.
 */
import { z } from "zod";
import { ModelProposalSchema } from "./tool-contracts.js";
import { Sha256, canonicalJsonStringify, sha256Hex } from "./readiness/contracts.js";
import type { Provider } from "./tagger.js";
import { containsPrivateMarker } from "./create-ui-spec-private-markers.js";

export const PROVIDERS = ["openai", "claude", "gemini", "mistral", "minimax", "grok"] as const satisfies readonly Provider[];
const ProviderSchema = z.enum(PROVIDERS);

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.username === ""
      && url.password === ""
      && url.pathname === "/"
      && url.search === ""
      && url.hash === ""
      && url.origin === value;
  } catch {
    return false;
  }
}

function sha256Canonical(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJsonStringify(value), "utf-8"));
}

function containsPrivateMarkerDeep(value: unknown): boolean {
  if (typeof value === "string") return containsPrivateMarker(value);
  if (Array.isArray(value)) return value.some(containsPrivateMarkerDeep);
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some(containsPrivateMarkerDeep);
  }
  return false;
}

/** Complete provider tuple used by the explicit model-call path. */
export const PinnedModelEndpointSchema = z.object({
  provider: ProviderSchema,
  baseUrl: z.string().trim().min(1).max(2_048).refine(isHttpsUrl, {
    message: "baseUrl must be an HTTPS URL",
  }),
  apiKey: z.string().min(1).max(16_384).refine((value) => value.trim().length > 0, {
    message: "apiKey must not be blank",
  }),
  model: z.string().trim().min(1).max(200),
}).strict();
export type PinnedModelEndpoint = z.infer<typeof PinnedModelEndpointSchema>;

/** Fixed first-slice generation controls. Any drift is a contract change. */
export const ModelGenerationParametersSchema = z.object({
  temperature: z.literal(0),
  maxOutputTokens: z.literal(4_096),
  maxAttempts: z.literal(1),
  seed: z.null(),
}).strict();
export type ModelGenerationParameters = z.infer<typeof ModelGenerationParametersSchema>;

const FailedModelExecutionSchema = z.discriminatedUnion("state", [
  z.object({ state: z.literal("invalid-configuration") }).strict(),
  z.object({ state: z.literal("call-failed") }).strict(),
  z.object({ state: z.literal("proposal-rejected") }).strict(),
  z.object({ state: z.literal("persistence-failed") }).strict(),
]);

const SucceededModelExecutionSchema = z.object({
  state: z.literal("succeeded"),
  provider: ProviderSchema,
  model: z.string().trim().min(1).max(200),
  promptSha256: Sha256,
  parametersSha256: Sha256,
  reproducibility: z.literal("conditional"),
}).strict();

/** Safe public execution state. Absence, rather than a variant, means no model. */
export const ModelExecutionSchema = z.union([
  FailedModelExecutionSchema,
  SucceededModelExecutionSchema,
]);
export type ModelExecution = z.infer<typeof ModelExecutionSchema>;

const ModelUsageSchema = z.object({
  promptTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  completionTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();

/**
 * Private retained history for one accepted proposal. `.strict()` makes raw
 * prompts/responses, credentials, request headers, and provider diagnostics
 * unrepresentable. The record binds both retained structured values to hashes.
 */
export const ModelArtifactRecordSchema = z.object({
  recordVersion: z.literal("1.0"),
  artifactId: z.string().regex(/^uispec-[0-9a-f]{64}$/),
  specSha256: Sha256,
  semanticSpecSha256: Sha256,
  proposalSha256: Sha256,
  promptSha256: Sha256,
  parametersSha256: Sha256,
  proposal: ModelProposalSchema,
  provider: ProviderSchema,
  model: z.string().trim().min(1).max(200),
  endpointOrigin: z.string().max(2_048).refine(isHttpsOrigin, {
    message: "endpointOrigin must be an exact HTTPS origin without credentials",
  }),
  parameters: ModelGenerationParametersSchema,
  usage: ModelUsageSchema,
  attempts: z.literal(1),
  latencyMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  storedAt: z.string().datetime(),
  retention: z.literal("until-explicit-delete"),
}).strict().superRefine((record, ctx) => {
  if (containsPrivateMarkerDeep(record.proposal)) {
    ctx.addIssue({
      code: "custom",
      message: "proposal must not contain private corpus markers",
      path: ["proposal"],
    });
  }
  if (record.proposalSha256 !== sha256Canonical(record.proposal)) {
    ctx.addIssue({
      code: "custom",
      message: "proposalSha256 must match the canonical proposal",
      path: ["proposalSha256"],
    });
  }
  if (record.parametersSha256 !== sha256Canonical(record.parameters)) {
    ctx.addIssue({
      code: "custom",
      message: "parametersSha256 must match the canonical generation parameters",
      path: ["parametersSha256"],
    });
  }
});
export type ModelArtifactRecord = z.infer<typeof ModelArtifactRecordSchema>;
