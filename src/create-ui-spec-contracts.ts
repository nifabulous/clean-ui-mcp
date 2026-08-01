/**
 * create-ui-spec-contracts.ts — the strict C3 artifact contract boundary.
 *
 * Task 1 of the C3 create-ui-spec first slice. This module defines the
 * fail-closed contracts between untrusted producer input and the trusted,
 * re-render-verified design artifact envelope.
 *
 * Layers (each `.strict()`, no `z.unknown()` escape hatches):
 *  - CreateUiSpecRequestSchema  — the core request (separate from the deferred
 *                                  MCP CreateUiSpecInput; presentation adapters
 *                                  own `outputFormat`).
 *  - SanitizedEvidenceSchema    — response-scoped evidence the recipe may cite.
 *                                  Carries NO private identity; corpus
 *                                  observations are referenced only by fresh
 *                                  `evidence-*` IDs.
 *  - CreateUiSpecCandidateSchema— a 15-variant discriminated union over `field`
 *                                  carrying candidate decisions. Structural only;
 *                                  evidence membership is enforced by
 *                                  parseCreateUiSpecCandidate.
 *  - CreateUiSpecErrorSchema    — the core error union with code↔retryable
 *                                  binding and bounded SafeErrorMessage.
 *  - ArtifactMetadataSchema     — the artifact's identity/hash block.
 *  - DesignArtifactEnvelopeSchema — the full envelope (spec + handoff + renderings
 *                                  + hashes + retrieval state + warnings).
 *
 * Public functions:
 *  - sha256Canonical(value)     — canonical-JSON SHA-256 (reuses the two
 *                                  existing helpers; no second hash impl).
 *  - buildSemanticSpecInput(spec) — deep-copies a parsed UiSpec with the
 *                                  provenance.generatedAt sentinel replaced, so
 *                                  semantic identity is timestamp-independent.
 *  - buildArtifactIdentityInput()  — the exact identity object hashed for
 *                                  artifactId (exact-type param; cannot smuggle
 *                                  timestamps/diagnostics).
 *  - parseCreateUiSpecCandidate(raw, allowedEvidenceIds)
 *                                — evidence-aware candidate constructor.
 *  - parseDesignArtifactEnvelope(raw)
 *                                — re-render + re-hash verification; throws on
 *                                  any mismatch.
 *  - projectSanitizedEvidenceToMcpEvidence(rows)
 *                                — the ONE safe projection from core
 *                                  SanitizedEvidence onto the shared MCP
 *                                  `Evidence` rows both transport adapters
 *                                  publish. Fail-closed on both sides; assigns no
 *                                  authority and renders nothing.
 *  - projectRetrievalStateForTransport(envelope)
 *                                — the ONE mapping from the envelope's retrieval
 *                                  metadata onto the transport `retrieval` block.
 *                                  Preserves the producer's real state and
 *                                  re-scopes only `resultCount` to the artifact
 *                                  count the tool descriptor documents.
 *
 * Adapter-facing shape:
 *  - CreateUiSpecAdapterResult   — { envelope, sanitizedEvidence }: what the core
 *                                  hands a transport adapter. Carries NO
 *                                  transport-only presentation field, and the
 *                                  persisted envelope is unchanged in meaning.
 *
 * Reuse: RetrievalState (the state matrix), the existing Sha256 regex, the two
 * canonical hash helpers, and UiSpec 1.0 are all reused unchanged.
 */
import { z } from "zod";
import {
  ColorIntentSchema,
  DesignSystemIdentitySchema,
  Evidence,
  RetrievalState,
  TypeIntentSchema,
  UiSpec,
  type EvidenceT,
  type UiSpecT,
} from "./tool-contracts.js";
import {
  MotionIntentSchema,
  NEUTRAL_WEB_TARGET,
  WebTargetId,
  type WebTargetIdT,
  type WebTargetProfile,
  parseDesignHandoff,
} from "./design-target-contracts.js";
import {
  renderDesignHandoffMarkdown,
  renderDesignHandoffJson,
} from "./design-handoff.js";
import {
  Sha256,
  canonicalJsonStringify,
  sha256Hex,
} from "./readiness/contracts.js";
import { PatternType } from "./schema.js";
import { ModelExecutionSchema } from "./create-ui-spec-model-contracts.js";

// ===========================================================================
// 1. sha256Canonical — canonical-JSON SHA-256 (reuses the two helpers)
// ===========================================================================

/**
 * SHA-256 hex digest of the canonical-JSON encoding of `value`. Composition of
 * the two existing helpers in readiness/contracts.ts — no second hash
 * implementation is introduced.
 */
export function sha256Canonical(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJsonStringify(value), "utf-8"));
}

// ===========================================================================
// 1a. RECIPE_SHA256 — single source of truth for the frozen recipe identity
// ===========================================================================

/**
 * Frozen canonical-JSON SHA-256 of `src/c3/fallback-recipe-v1.json`. Pinned from
 * the checked-in bytes (sorted keys, compact UTF-8). This is the SINGLE source
 * of truth the envelope parser consumes to verify `assemblyRulesSha256`, so the
 * producer, the parser, and the recipe-pinning test can never drift.
 *
 * If the recipe ever changes, recompute via `sha256Canonical(recipe)` (or
 * `sha256Hex(Buffer.from(canonicalJsonStringify(recipe), "utf-8"))`) and replace
 * this literal — the same way `EXPECTED_RECIPE_SHA256`'s comment in
 * `fallback-recipe-v1.test.ts` instructs.
 */
export const RECIPE_SHA256 =
  "4c78f2f261b5d1e988e692d3b32a19762991a4eee0789734a54b3d6029d510f3";

// ===========================================================================
// 1b. CANONICAL_WEB_TARGET_PROFILES — single source of truth for target ids
// ===========================================================================

/**
 * The canonical WebTargetProfile for each closed WebTargetId. This is the SINGLE
 * source of truth consumed by BOTH the producer (which builds the trusted
 * handoff from the profile) AND parseDesignArtifactEnvelope (which reconstructs
 * the profile from the stored id during re-render verification).
 *
 * - `neutral-web` reuses the exported NEUTRAL_WEB_TARGET literal (the documented
 *   default; `parseDesignHandoff` substitutes it when the producer omits the
 *   target).
 * - `astro-react` / `astro-vue` are the canonical capability combinations the
 *   registry (resolveWebTarget) accepts. Both satisfy WebTargetProfileSchema and
 *   pass the registry's capability checks, so the envelope's re-render step
 *   byte-reproduces the producer's renderings.
 *
 * Because the envelope persists ONLY the target id (per the Task 1 handoff
 * shape), every id MUST map to exactly one canonical profile here — otherwise
 * the producer and the envelope parser would diverge and the re-render/
 * re-hash verification would throw.
 */
const ASTRO_REACT_TARGET: WebTargetProfile = {
  id: "astro-react",
  platform: "web",
  siteFramework: "astro",
  runtime: "react",
  styling: "tailwind",
  componentSource: "shadcn",
  motion: "css",
  islandStrategy: "client:visible",
};

const ASTRO_VUE_TARGET: WebTargetProfile = {
  id: "astro-vue",
  platform: "web",
  siteFramework: "astro",
  runtime: "vue",
  styling: "vanilla-css",
  componentSource: "native-html",
  motion: "css",
  islandStrategy: "client:visible",
};

export const CANONICAL_WEB_TARGET_PROFILES: Readonly<Record<WebTargetIdT, WebTargetProfile>> = {
  "neutral-web": { ...NEUTRAL_WEB_TARGET },
  "astro-react": { ...ASTRO_REACT_TARGET },
  "astro-vue": { ...ASTRO_VUE_TARGET },
};

// ===========================================================================
// 2. SafeErrorMessage — operator-safe, bounded error text
// ===========================================================================

/**
 * A bounded, operator-safe message string. Excludes stack traces, file paths,
 * URLs, corpus IDs, and credentials via a `.refine` that rejects path-like and
 * url-like substrings. Keeps error surfaces from leaking private diagnostics.
 */
const PATH_OR_URL_PATTERN = /:\/\/|[/\\]|node_modules|dist\/|private|corpus-/;
export const SafeErrorMessage = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((s) => !PATH_OR_URL_PATTERN.test(s), {
    message: "message must not contain paths, urls, or corpus identifiers",
  });

// ===========================================================================
// 3. CreateUiSpecRequestSchema — the core request contract
// ===========================================================================

/**
 * The core request contract for create-ui-spec. Separate from the deferred MCP
 * CreateUiSpecInput (which owns MCP-only presentation concerns). `outputFormat`
 * is deliberately ABSENT here — presentation adapters own format selection.
 *
 * `target` is optional and passed to the existing handoff parser (canonical
 * neutral-web default applied by that parser). `motionIntents` are structured
 * and never parsed from free-form prose.
 */
export const CreateUiSpecRequestSchema = z
  .object({
    productContext: z.string().trim().min(8).max(8_000),
    referenceIds: z
      .array(z.string().trim().min(1).max(200))
      .max(5)
      .default([])
      .refine((ids) => new Set(ids).size === ids.length),
    platform: z.enum(["web", "mobile", "tablet"]).optional(),
    implementationFramework: z.string().trim().min(1).max(120).optional(),
    designSystem: DesignSystemIdentitySchema.optional(),
    constraints: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
    target: WebTargetId.optional(),
    motionIntents: z.array(MotionIntentSchema).max(8).default([]),
    // Structured design intent. Recorded in `spec.context` (and therefore in
    // semanticSpecSha256 → artifactId); never materialized into tokens, never
    // duplicated onto the handoff or ArtifactIdentityInput as a parallel
    // identity lane — a second copy could drift from what the spec displays.
    colorIntent: ColorIntentSchema.optional(),
    typeIntent: TypeIntentSchema.optional(),
  })
  .strict();
export type CreateUiSpecRequest = z.infer<typeof CreateUiSpecRequestSchema>;

// ===========================================================================
// 4. SanitizedEvidenceSchema — response-scoped, private-marker-free
// ===========================================================================

/**
 * The response-scoped id regex. Corpus observations and public references both
 * receive fresh, response-local ids of this exact shape — no upstream corpus
 * identity ever appears in public output.
 */
export const EvidenceIdSchema = z.string().regex(/^evidence-[0-9]+$/);

/**
 * Closed kind enum for the fallback recipe:
 *  - corpus-observation: a sanitized summary derived from a private corpus
 *    entry. Cited ONLY by its fresh `evidence-*` id; no public sourceId/
 *    sourceUrl/publicReference may be populated.
 *  - public-reference: an explicit, user-supplied or otherwise public input.
 *    May carry `publicReference`.
 *  - recipe-system: the deterministic c3-fallback-v1 recipe itself (operator
 *    content). This is the honest editorial-guidance grounding for the echo-
 *    product-context designDirection and the zero-match structured fallback.
 *    It carries NO `publicReference` (the recipe is operator content, not a
 *    user/public reference) and is NOT a corpus observation. It grounds
 *    editorial-authority decisions, never corpus-evidence decisions.
 */
export const EvidenceKindSchema = z.enum(["corpus-observation", "public-reference", "recipe-system"]);

/**
 * Closed basis enum for the fallback recipe:
 *  - visible: directly observable in the source.
 *  - aggregate: derived from counts/structure across the source.
 *  - user-supplied: provided explicitly by the requester.
 *
 * The recipe-system kind reuses `aggregate`: the recipe is a deterministic
 * aggregate of operator-authored assembly rules (not visible in any single
 * source, not user-supplied). No new basis value is needed.
 */
export const EvidenceBasisSchema = z.enum(["visible", "aggregate", "user-supplied"]);

/**
 * The allowlist of structured-facts keys the fallback recipe may populate.
 * Closed set of bounded fields/counts/booleans — NO free-form prose. Every row
 * is enum- or count-typed so a stray private excerpt cannot sneak in.
 */
const StructuredFactsSchema = z
  .object({
    pattern: PatternType.optional(),
    regionCount: z.number().int().nonnegative().max(50).optional(),
    columnCount: z.number().int().nonnegative().max(20).optional(),
    usesStickyHeader: z.boolean().optional(),
    usesIconography: z.boolean().optional(),
  })
  .strict();

/**
 * A sanitized evidence row. `id` is response-scoped. `summary` is a bounded
 * recipe-owned string (max 500) whose CONTENT is screened for private-corpus
 * markers, paths and urls — it is the one arbitrary string a transport adapter
 * publishes from this row. `structuredFacts` is a closed allowlist.
 * `publicReference` is accepted ONLY for public-reference kind and is screened
 * for private-corpus markers. NO private identity fields
 * (privateCorpusId/sourceUrl/screenshot/corpusId) are allowed; `.strict()` plus
 * the discriminated refinement guarantees it.
 */
export const SanitizedEvidenceSchema = z
  .object({
    id: EvidenceIdSchema,
    kind: EvidenceKindSchema,
    basis: EvidenceBasisSchema,
    summary: z.string().trim().min(1).max(500),
    structuredFacts: StructuredFactsSchema.default({}),
    publicReference: z.string().trim().min(1).max(500).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    // ---- content screen on the published free-text channel -----------------
    //
    // `summary` is the ONE arbitrary string a transport adapter PUBLISHES from a
    // sanitized row (`evidence[].summary`). Nothing downstream screens it: the
    // rows travel BESIDE the envelope, so DesignArtifactEnvelopeSchema's
    // containsPrivateMarker sweep never sees them, and the create_ui_spec leaf
    // gate classifies that position as free text (it returns without a check, by
    // design — the value is recipe-owned template prose). So the content screen
    // has to be here, at construction: the projection's inbound re-parse then
    // inherits it, and an adapter cannot publish an unscreened summary at all.
    //
    // Reuses the two checks that already exist in this module — the shared
    // `containsPrivateMarker` helper (same marker set as the candidate/envelope
    // superRefines and the c3-runtime-probe) and `SafeErrorMessage`'s
    // PATH_OR_URL_PATTERN (paths, urls, corpus-prefixed identifiers). No second,
    // divergent marker list. Messages name the position and withhold the value:
    // the row is refused, so an error echoing the value would be the only channel
    // through which it still reached a caller.
    if (containsPrivateMarker(val.summary)) {
      ctx.addIssue({
        code: "custom",
        message: "summary must not contain private corpus markers",
        path: ["summary"],
      });
    } else if (PATH_OR_URL_PATTERN.test(val.summary)) {
      ctx.addIssue({
        code: "custom",
        message: "summary must not contain paths, urls, or corpus identifiers",
        path: ["summary"],
      });
    }
    // `publicReference` is screened for private markers only. A public URL IS a
    // legitimate value at THIS layer (the field's whole purpose is an explicit
    // public input), and the PUBLISHED channel is separately narrowed to the
    // opaque `ref-<sha256>` digest by projectSanitizedEvidenceToMcpEvidence — so
    // applying the path/url pattern here would forbid a legitimate core value
    // without adding any protection to a published position. A private-corpus
    // marker, by contrast, is never a legitimate public reference.
    if (val.publicReference !== undefined && containsPrivateMarker(val.publicReference)) {
      ctx.addIssue({
        code: "custom",
        message: "publicReference must not contain private corpus markers",
        path: ["publicReference"],
      });
    }
    // corpus-observation MUST NOT carry any public source/citation field.
    if (val.kind === "corpus-observation" && val.publicReference !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "corpus-observation must not populate publicReference",
        path: ["publicReference"],
      });
    }
    // public-reference basis must be user-supplied (the only public-input basis).
    if (val.kind === "public-reference" && val.basis !== "user-supplied") {
      ctx.addIssue({
        code: "custom",
        message: "public-reference basis must be user-supplied",
        path: ["basis"],
      });
    }
    // recipe-system is operator content (the deterministic c3-fallback-v1
    // recipe), NOT a public/user reference. It must NOT carry a publicReference
    // (that would falsely label the recipe as a user/public citation) and it
    // must NOT use the user-supplied basis (the requester supplied nothing).
    // The recipe grounds editorial-authority decisions only.
    if (val.kind === "recipe-system" && val.publicReference !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "recipe-system must not populate publicReference",
        path: ["publicReference"],
      });
    }
    if (val.kind === "recipe-system" && val.basis === "user-supplied") {
      ctx.addIssue({
        code: "custom",
        message: "recipe-system basis must not be user-supplied",
        path: ["basis"],
      });
    }
  });
export type SanitizedEvidence = z.infer<typeof SanitizedEvidenceSchema>;

// ===========================================================================
// 5. CreateUiSpecCandidateSchema — 15-variant discriminated union
// ===========================================================================

/**
 * Bounded rationale shared by every decision variant. Keeps producer prose
 * within an operator-sane limit.
 */
const DecisionRationale = z.string().trim().min(1).max(1_000);
/** Bounded, unique, non-empty decision id. */
const DecisionId = z.string().trim().min(1).max(120);
/** At most 8 response-scoped evidence ids per decision. */
const DecisionEvidenceIds = z.array(EvidenceIdSchema).max(8);
/** Bounded text variant (designDirection/rejectedDefaults/contentVoiceGuidance/frameworkNotes). */
const BoundedTextValue = z.string().trim().min(1).max(2_000);

/** Strict row schemas for the array-of-rows variants. */
const LayoutRegionRow = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.string().trim().min(1).max(120),
    components: z.array(z.string().trim().min(1).max(120)).max(50),
    responsive: z.array(z.string().trim().min(1).max(120)).max(50),
  })
  .strict();

const ComponentEntryRow = z
  .object({
    name: z.string().trim().min(1).max(120),
    pattern: z.string().trim().min(1).max(120),
  })
  .strict();

const TokenRow = z
  .object({
    name: z.string().trim().min(1).max(120),
    value: z.string().trim().min(1).max(120),
    rationale: z.string().trim().min(1).max(500),
  })
  .strict();

const CategoryStatementRow = z
  .object({
    category: z.string().trim().min(1).max(120),
    statement: z.string().trim().min(1).max(500),
  })
  .strict();

const TextRow = z
  .object({
    text: z.string().trim().min(1).max(500),
  })
  .strict();

/**
 * The 15 candidate-decision variants, discriminated on `field`, in this EXACT
 * order. Each variant requires a bounded unique `id`, a bounded `rationale`,
 * and at most 8 `evidenceIds`. Value shapes and limits follow the plan's table.
 */
const CandidateDecisionSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("designDirection"), id: DecisionId, value: BoundedTextValue, rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("rejectedDefaults"), id: DecisionId, value: BoundedTextValue, rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("layoutRegions"), id: DecisionId, value: z.array(LayoutRegionRow).max(12), rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("responsiveBehavior"), id: DecisionId, value: z.array(z.string().trim().min(1).max(500)).max(12), rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("componentInventory"), id: DecisionId, value: z.array(ComponentEntryRow).max(12), rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("colorTokens"), id: DecisionId, value: z.array(TokenRow).max(24), rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("typographyTokens"), id: DecisionId, value: z.array(TokenRow).max(24), rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("interactions"), id: DecisionId, value: z.array(CategoryStatementRow).max(16), rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("motionGuidance"), id: DecisionId, value: z.array(CategoryStatementRow).max(16), rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("accessibilityConstraints"), id: DecisionId, value: z.array(CategoryStatementRow).max(16), rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("contentVoiceGuidance"), id: DecisionId, value: BoundedTextValue, rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("techniques"), id: DecisionId, value: z.array(TextRow).max(12), rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("antiPatterns"), id: DecisionId, value: z.array(TextRow).max(12), rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("frameworkNotes"), id: DecisionId, value: BoundedTextValue, rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
  z.object({ field: z.literal("acceptanceCriteria"), id: DecisionId, value: z.array(z.string().trim().min(1).max(500)).max(12), rationale: DecisionRationale, evidenceIds: DecisionEvidenceIds }).strict(),
]);

/**
 * The candidate envelope. Structural validation only — evidence membership is
 * enforced by parseCreateUiSpecCandidate (the schema itself does not know which
 * evidence ids exist in a given response).
 *
 * Rejects structural Markdown and private-path markers in every string value
 * (defense-in-depth before the evidence-aware parser runs), duplicate decision
 * ids, and more than 32 decisions.
 */
export const CreateUiSpecCandidateSchema = z
  .object({
    candidateVersion: z.literal("1.0"),
    decisions: z.array(CandidateDecisionSchema).max(32),
  })
  .strict()
  .superRefine((val, ctx) => {
    // Reject structural Markdown (headings/fences) anywhere in the candidate.
    for (const s of collectStrings(val)) {
      if (HEADING_RE.test(s) || FENCE_RE.test(s)) {
        ctx.addIssue({
          code: "custom",
          message: "candidate must not contain structural Markdown",
          path: ["decisions"],
        });
        break;
      }
      // Private-corpus markers (shared with the envelope check + runtime probe).
      if (containsPrivateMarker(s)) {
        ctx.addIssue({
          code: "custom",
          message: "candidate must not contain private corpus paths",
          path: ["decisions"],
        });
        break;
      }
    }
    // Reject duplicate decision ids.
    const seen = new Set<string>();
    for (const d of val.decisions) {
      if (seen.has(d.id)) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate decision id "${d.id}"`,
          path: ["decisions"],
        });
        break;
      }
      seen.add(d.id);
    }
  });
export type CreateUiSpecCandidate = z.infer<typeof CreateUiSpecCandidateSchema>;

// ===========================================================================
// 6. CreateUiSpecErrorSchema — core error union with code↔retryable binding
// ===========================================================================

/**
 * The core error union. `code` AND `retryable` are literal per variant so the
 * inferred type is a precise discriminated union. RETRIEVAL_UNAVAILABLE is the
 * only retryable core error; INVALID_INPUT is never retryable.
 */
export const CreateUiSpecErrorSchema = z.discriminatedUnion("code", [
  z
    .object({ code: z.literal("INVALID_INPUT"), message: SafeErrorMessage, retryable: z.literal(false) })
    .strict(),
  z
    .object({ code: z.literal("RETRIEVAL_UNAVAILABLE"), message: SafeErrorMessage, retryable: z.literal(true) })
    .strict(),
]);
export type CreateUiSpecError = z.infer<typeof CreateUiSpecErrorSchema>;

// ===========================================================================
// 7. RetrievalState + Warning — reused from tool-contracts
// ===========================================================================

/**
 * The strict retrieval state. Reuses the EXISTING RetrievalState schema, which
 * already encodes the required state matrix via ALLOWED_MODE_MODALITY:
 *  - automatic keyword results use `keyword/metadata`;
 *  - automatic zero-match uses `structured-fallback/metadata` (+ a sparse
 *    evidence warning emitted by the producer);
 *  - explicit valid/partially valid references use `none/none` (+ bounded
 *    omitted-reference metadata);
 *  - explicit all-missing references and reader/search failures raise typed
 *    retrieval/input errors (CreateUiSpecErrorSchema).
 */
export const RetrievalStateSchema = RetrievalState;

/**
 * Warning schema for the create-ui-spec envelope. Closed code enum matching the
 * create_ui_spec tool's documented warning codes; bounded message.
 */
export const WarningSchema = z
  .object({
    code: z.enum([
      "sparseCoverage",
      "insufficientCorpusEvidence",
      "motionEvidenceUnavailable",
      "authorityConflict",
    ]),
    message: z.string().trim().min(1).max(500),
  })
  .strict();
export type Warning = z.infer<typeof WarningSchema>;

// ===========================================================================
// 8. ArtifactMetadataSchema — identity/hash block
// ===========================================================================

/**
 * The artifact identity/hash block. Every hash is a 64-hex SHA-256. This is the
 * canonical record of what was produced and how it was hashed; the envelope
 * parser re-derives these fields and demands exact equality.
 */
export const ArtifactMetadataSchema = z
  .object({
    producerVersion: z.string().trim().min(1).max(120),
    assemblyRulesSha256: Sha256,
    specSha256: Sha256,
    semanticSpecSha256: Sha256,
    designMarkdownSha256: Sha256,
    designJsonSha256: Sha256,
  })
  .strict();
export type ArtifactMetadata = z.infer<typeof ArtifactMetadataSchema>;

// ===========================================================================
// 9. DesignArtifactEnvelopeSchema — the full envelope
// ===========================================================================

/**
 * The strict handoff representation embedded in the envelope. Because
 * DesignHandoffT is opaque/branded, the envelope stores the handoff inputs
 * (target + motionIntents) and re-derives the trusted handoff at parse time.
 */
const EnvelopeHandoffSchema = z
  .object({
    target: WebTargetId,
    motionIntents: z.array(MotionIntentSchema),
  })
  .strict();

/**
 * The full design artifact envelope. Wraps a validated UiSpec 1.0 with the
 * handoff inputs, both renderings, all hashes, the response-scoped public
 * evidence ids, the retrieval state, and bounded warnings.
 *
 * `specSha256` is over canonical-JSON of the spec; `semanticSpecSha256` is over
 * canonical-JSON of buildSemanticSpecInput(spec) (timestamp-independent); the
 * rendering hashes are over the exact byte strings. The parser re-derives ALL
 * of these and demands exact equality.
 */
export const DesignArtifactEnvelopeSchema = z
  .object({
    artifactVersion: z.literal("1.0"),
    artifactId: z.string().trim().min(1).max(200),
    generatedAt: z.string().datetime(),
    producerVersion: z.string().trim().min(1).max(120),
    assemblyRulesSha256: Sha256,
    spec: UiSpec,
    handoff: EnvelopeHandoffSchema,
    designMarkdown: z.string(),
    designJson: z.string(),
    specSha256: Sha256,
    designMarkdownSha256: Sha256,
    designJsonSha256: Sha256,
    semanticSpecSha256: Sha256,
    modelExecution: ModelExecutionSchema.optional(),
    modelExecutionSha256: Sha256.optional(),
    publicEvidenceIds: z.array(EvidenceIdSchema).min(1),
    retrieval: RetrievalStateSchema,
    warnings: z.array(WarningSchema),
  })
  .strict()
  .superRefine((val, ctx) => {
    // Model execution metadata is optional for backward-compatible deterministic
    // artifacts, but when present it is always paired with its own digest.
    if ((val.modelExecution === undefined) !== (val.modelExecutionSha256 === undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "modelExecution and modelExecutionSha256 must be present together",
        path: [val.modelExecution === undefined ? "modelExecution" : "modelExecutionSha256"],
      });
    }
    // publicEvidenceIds must be unique.
    if (new Set(val.publicEvidenceIds).size !== val.publicEvidenceIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "publicEvidenceIds must be unique",
        path: ["publicEvidenceIds"],
      });
    }
    const provenanceEvidenceIds = val.spec.provenance.evidenceIds;
    if (provenanceEvidenceIds.length !== val.publicEvidenceIds.length || provenanceEvidenceIds.some((id, index) => id !== val.publicEvidenceIds[index])) {
      ctx.addIssue({
        code: "custom",
        message: "publicEvidenceIds must exactly match spec.provenance.evidenceIds",
        path: ["publicEvidenceIds"],
      });
    }
    // Reject distinctive private markers anywhere in the serialized envelope.
    // Uses the shared containsPrivateMarker helper (same set as the candidate
    // superRefine + the c3-runtime-probe PRIVATE_MARKERS list).
    for (const s of collectStrings(val)) {
      if (containsPrivateMarker(s)) {
        ctx.addIssue({
          code: "custom",
          message: "envelope must not contain private corpus markers",
          path: ["designMarkdown"],
        });
        break;
      }
    }
  });
export type DesignArtifactEnvelope = z.infer<typeof DesignArtifactEnvelopeSchema>;

// ===========================================================================
// 9b. The adapter-facing result + the ONE safe evidence projection
// ===========================================================================

/**
 * What a transport adapter receives from the core producer.
 *
 * Two adapters consume this — the MCP adapter and the loopback HTTP adapter —
 * and NEITHER may re-run retrieval, sanitization, assembly or rendering. The
 * core (`createUiSpecForAdapter` in create-ui-spec.ts) stays the sole producer;
 * this shape only PRESERVES what it already validated.
 *
 * `envelope` is the parsed, re-render-verified {@link DesignArtifactEnvelope} —
 * byte-identical to what `createUiSpec()` returns. It deliberately carries NO
 * transport-only presentation field: an adapter's `resultCount`, `summary` or
 * `outputFormat` concerns must never be persisted into the artifact envelope.
 *
 * The envelope's `retrieval` block is CORPUS-SCOPED: `resultCount` there counts
 * retrieved corpus observations. An adapter must NOT publish it unchanged — call
 * {@link projectRetrievalStateForTransport} to obtain the transport block, which
 * preserves the real retrieval state and re-scopes `resultCount` to the artifact
 * count the create_ui_spec descriptor documents.
 *
 * `sanitizedEvidence` is the response-scoped evidence list in response order
 * (`evidence-1`, `evidence-2`, …), each row already parsed through
 * {@link SanitizedEvidenceSchema}. Its ids are exactly `envelope.publicEvidenceIds`
 * in the same order. The envelope stores only the ids because the rows are
 * response-scoped presentation, not part of the persisted artifact's identity.
 */
export interface CreateUiSpecAdapterResult {
  readonly envelope: DesignArtifactEnvelope;
  readonly sanitizedEvidence: readonly SanitizedEvidence[];
}

/**
 * The safe public reference shape — the core's opaque `ref-${sha256Hex(token)}`
 * digest. Mirrors `SAFE_PUBLIC_REFERENCE_ID` in tool-contracts.ts (which is
 * module-private there) and the `evidence[].referenceId` rule in the
 * create_ui_spec structural leaf gate. Kept as a literal here rather than
 * imported so this projection cannot be widened by a change on the other side.
 */
const SAFE_PUBLIC_REFERENCE_DIGEST = /^ref-[0-9a-f]{64}$/;

/**
 * The ONE projection from core {@link SanitizedEvidence} onto the shared MCP
 * {@link Evidence} rows. Every transport that publishes evidence rows calls this;
 * none builds a row by hand.
 *
 * WHICH TRANSPORTS THOSE ARE — stated exactly, because an earlier revision of
 * this line said "both transport adapters call this" and that was false. The MCP
 * adapter calls it (`create-ui-spec-mcp.ts`). The HTTP adapter does NOT, and
 * deliberately: it serves the `DesignArtifactEnvelope` itself, which carries only
 * `publicEvidenceIds` and no evidence rows at all, so there is nothing for this
 * projection to map. `create-ui-spec-http.ts` records the same fact at its own
 * "WHAT NEVER REACHES THIS SURFACE" note. If a third transport ever publishes
 * rows, it calls this — the rule is "no hand-built rows", not "every adapter
 * calls it".
 *
 * What it does, and nothing else:
 *  - `id`, `kind`, `basis`, `summary` are carried through unchanged (strictly: as
 *    {@link SanitizedEvidenceSchema} normalizes them — `summary` is
 *    `z.string().trim()`, so a re-parse CAN trim a hand-built row; every value the
 *    producer emits is already in that normal form). The basis is
 *    NOT re-labelled: a corpus observation stays `visible`, the recipe stays
 *    `aggregate`, an explicit reference stays `user-supplied`. The projection
 *    never upgrades or invents an authority claim — `createUiSpec()` assigns
 *    authority, this function only renames a field.
 *  - `publicReference` → `referenceId`, and ONLY for a `public-reference` row.
 *    The core already forbids `publicReference` on `corpus-observation` and
 *    `recipe-system` rows; this restates that positively so the mapping cannot
 *    become "forward it whenever it happens to be set".
 *  - `structuredFacts` is DROPPED. The shared `Evidence` row has no home for it
 *    and `.strict()` would refuse it; the summary already states those facts in
 *    recipe-owned words.
 *
 * Fail-closed. Every row is re-parsed through {@link SanitizedEvidenceSchema} on
 * the way in (so a hand-built or defective row cannot slip past the core's
 * private-identity rules, and inherits that schema's content screen on `summary`
 * — the one published free-text position) and through {@link Evidence} on the way
 * out. A `publicReference` that is not a safe digest is REFUSED rather than
 * published: the two ID domains (`evidence-N` vs `ref-<sha256>`) are separate, and
 * a URL, filesystem path or raw corpus id in a reference position is exactly the
 * leak the leaf gate exists to stop. A duplicate `id` is refused too — each public
 * evidence id must be represented exactly once. Thrown messages never reproduce
 * the value.
 *
 * @throws Error when a row is not approved sanitized evidence, when two rows share
 * an `id`, when a `public-reference` row lacks a safe digest, or when the projected
 * row is not a valid shared `Evidence` row.
 */
export function projectSanitizedEvidenceToMcpEvidence(
  sanitizedEvidence: readonly SanitizedEvidence[],
): readonly EvidenceT[] {
  const seenIds = new Set<string>();
  return sanitizedEvidence.map((raw, index) => {
    const validated = SanitizedEvidenceSchema.safeParse(raw);
    if (!validated.success) {
      throw new Error(
        `create_ui_spec evidence projection refused evidence[${index}]: not an approved SanitizedEvidence row (values withheld)`,
      );
    }
    const row = validated.data;

    // Each public evidence id must be represented EXACTLY once. `Evidence` is
    // applied per row, so uniqueness lives here (the array-level `EvidenceArray`
    // check is downstream of every adapter that projects rows one at a time).
    if (seenIds.has(row.id)) {
      throw new Error(
        `create_ui_spec evidence projection refused evidence[${index}]: duplicate public evidence id (each id must appear exactly once; the offending value is withheld from this message)`,
      );
    }
    seenIds.add(row.id);

    // Only an explicit public reference may carry a public citation, and only a
    // safe opaque digest counts as one.
    let referenceId: string | undefined;
    if (row.kind === "public-reference") {
      if (row.publicReference === undefined || !SAFE_PUBLIC_REFERENCE_DIGEST.test(row.publicReference)) {
        throw new Error(
          `create_ui_spec evidence projection refused evidence[${index}].referenceId: a public-reference row must carry a safe public reference (ref-<sha256>); the offending value is withheld from this message`,
        );
      }
      referenceId = row.publicReference;
    }

    const projected = {
      id: row.id,
      kind: row.kind,
      summary: row.summary,
      basis: row.basis,
      ...(referenceId !== undefined ? { referenceId } : {}),
    };
    const parsed = Evidence.safeParse(projected);
    if (!parsed.success) {
      throw new Error(
        `create_ui_spec evidence projection produced an invalid shared Evidence row at evidence[${index}] (values withheld)`,
      );
    }
    return parsed.data;
  });
}

/**
 * The ONE mapping from the envelope's retrieval metadata onto the transport
 * `retrieval` block of the **create_ui_spec tool response**.
 *
 * WHO CALLS IT, AND WHO CORRECTLY DOES NOT. An earlier revision of this docblock
 * said "Both call this; neither writes `retrieval: envelope.retrieval`". That was
 * wrong in both halves, and wrong in the module whose job is to stop transport
 * drift, so it is spelled out here:
 *
 *  - **MCP calls this** (`create-ui-spec-mcp.ts`). Its response is the published
 *    create_ui_spec tool contract, whose `resultCount` the descriptor documents as
 *    an ARTIFACT count. Forwarding the envelope's corpus-scoped value there would
 *    contradict the descriptor. Hence the re-scoping below.
 *  - **HTTP does not, and must not.** `create-ui-spec-http.ts` serves the
 *    `DesignArtifactEnvelope` itself (`serializeEnvelope(produced.envelope)`),
 *    verified byte-for-byte against the producer's envelope by
 *    `assertServedBytesAreEnvelope`. Its `retrieval` block IS
 *    `envelope.retrieval`, corpus-scoped, and that is correct: the envelope is a
 *    persisted artifact with its own documented semantics, not a tool response.
 *    Substituting an artifact-scoped `resultCount` there would silently change the
 *    meaning of a persisted field, and the byte-equality assertion would not
 *    object because the value stays schema-legal.
 *
 * SO THE TWO SURFACES REPORT DIFFERENT NUMBERS FOR THE SAME REQUEST — 1 over MCP,
 * the corpus-observation count over HTTP — and both are truthful under their own
 * scoping (see the "envelope block is corpus-scoped, transport block is
 * artifact-scoped" note earlier in this module). This is a difference of
 * DOCUMENT KIND, not a transport inconsistency: there is no request for which the
 * same document reports two values. **Do not "fix" the HTTP adapter by making it
 * call this function.** If the divergence ever needs to close, it closes by
 * changing what the envelope's own field means, which is an artifact-contract
 * change, not an adapter change.
 *
 * WHY IT EXISTS. Two different meanings share the field name `resultCount`:
 *  - `envelope.retrieval.resultCount` counts RETRIEVED CORPUS OBSERVATIONS (3 on
 *    a three-match automatic run, 0 in the zero-match structured fallback);
 *  - the published create_ui_spec contract documents `resultCount` as the
 *    ARTIFACT count — "1 when a complete spec artifact exists, otherwise 0"
 *    (the descriptor's `contractDocs.resultCount` in tool-contracts.ts, enforced
 *    by that descriptor's `countResults`, which reads `data.specVersion`).
 * An adapter that forwards the envelope's value unchanged therefore publishes a
 * number that contradicts its own documented contract. This function is the
 * single place that reconciles them, so Tasks 3 and 5 cannot diverge.
 *
 * WHAT IT PRESERVES. Everything else, verbatim: `mode`, `modality`,
 * `fallbackUsed`, `fallbackReason`, `attemptedCount`, `attemptedModes`. The
 * producer's actual retrieval state (`keyword`/`metadata`,
 * `structured-fallback`/`metadata` with `no-results`, `none`/`none`) is published
 * as it happened — a real state is NEVER normalized to satisfy a descriptor.
 * `resultCount` is the only field re-scoped, and it is re-scoped to the meaning
 * the descriptor documents, derived from the artifact itself
 * (`envelope.spec.specVersion`) rather than from a hardcoded 1.
 *
 * Fail-closed: the result is re-parsed through the shared {@link RetrievalState}
 * (whose superRefine holds the mode/modality and fallback-truth rules), so a
 * mapping that produced a contradictory state would throw rather than publish.
 *
 * @throws Error when the mapped block is not a valid shared `RetrievalState`.
 */
export function projectRetrievalStateForTransport(
  envelope: DesignArtifactEnvelope,
): z.infer<typeof RetrievalStateSchema> {
  const projected = {
    ...envelope.retrieval,
    // Written exactly as the descriptor's countResults computes it, so the two
    // cannot drift. On this path it always evaluates to 1 — a parsed envelope
    // carries a complete UiSpec by construction — and the 0 branch exists because
    // the descriptor's rule, not this function, is the contract: an adapter with
    // no artifact publishes status "error" with data: null, which never reaches
    // here.
    resultCount: envelope.spec.specVersion ? 1 : 0,
  };
  const parsed = RetrievalStateSchema.safeParse(projected);
  if (!parsed.success) {
    throw new Error(
      "create_ui_spec transport retrieval projection produced an invalid RetrievalState (values withheld)",
    );
  }
  return parsed.data;
}

// ===========================================================================
// 10. buildSemanticSpecInput — timestamp-independent semantic identity
// ===========================================================================

/**
 * Deep-copy the parsed `spec` and replace ONLY `provenance.generatedAt` with the
 * fixed schema-valid sentinel. Does NOT omit fields or normalize any other
 * value. The returned plain object's canonical JSON is what gets hashed for
 * `semanticSpecSha256`, so semantic identity is stable across timestamp reruns.
 */
export function buildSemanticSpecInput(spec: UiSpecT): Record<string, unknown> {
  const copy = structuredDeepCopy(spec) as Record<string, unknown>;
  const provenance = (copy.provenance ?? {}) as Record<string, unknown>;
  // Replace only generatedAt; preserve toolVersion/sourceReferences/evidenceIds.
  copy.provenance = {
    ...provenance,
    generatedAt: "1970-01-01T00:00:00.000Z",
  };
  return copy;
}

/**
 * A recursive deep copy that preserves arrays and plain objects. Non-plain
 * objects are preserved by reference only if they're already plain (UiSpecT is
 * JSON-shaped after parsing).
 */
function structuredDeepCopy<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => structuredDeepCopy(v)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) {
      out[key] = structuredDeepCopy((value as Record<string, unknown>)[key]);
    }
    return out as unknown as T;
  }
  return value;
}

// ===========================================================================
// 11. buildArtifactIdentityInput — exact identity object (exact-type param)
// ===========================================================================

/**
 * The exact identity input object whose canonical-JSON hash is the artifactId.
 * The parameter is an EXACT type (not a wide Record), so a caller cannot
 * smuggle in timestamps, provider diagnostics, or renderings — the helper does
 * not silently drop fields.
 */
export interface ArtifactIdentityInput {
  readonly producerVersion: string;
  readonly assemblyRulesSha256: string;
  readonly semanticSpecSha256: string;
  readonly target: z.infer<typeof WebTargetId>;
  readonly motionIntents: z.infer<typeof MotionIntentSchema>[];
}

export function buildArtifactIdentityInput(
  input: ArtifactIdentityInput,
): {
  artifactVersion: "1.0";
  producerVersion: string;
  assemblyRulesSha256: string;
  semanticSpecSha256: string;
  handoffInputs: { target: z.infer<typeof WebTargetId>; motionIntents: z.infer<typeof MotionIntentSchema>[] };
  renderingFormatVersion: "web-1.0";
} {
  return {
    artifactVersion: "1.0",
    producerVersion: input.producerVersion,
    assemblyRulesSha256: input.assemblyRulesSha256,
    semanticSpecSha256: input.semanticSpecSha256,
    handoffInputs: { target: input.target, motionIntents: input.motionIntents },
    renderingFormatVersion: "web-1.0",
  };
}

// ===========================================================================
// 12. parseCreateUiSpecCandidate — evidence-aware candidate constructor
// ===========================================================================

/**
 * Construct a CreateUiSpecCandidate from raw producer input, enforcing evidence
 * membership against the response's `allowedEvidenceIds`.
 *
 *  1. parse structurally with CreateUiSpecCandidateSchema (this also rejects
 *     duplicate decision ids, structural Markdown, and private-path markers);
 *  2. enforce every decision.evidenceId belongs to allowedEvidenceIds;
 *  3. double-check duplicate decision ids (the schema already rejects them,
 *     but we re-verify at the constructor boundary);
 *  4. return the parsed candidate.
 *
 * All thrown errors are bounded, operator-safe strings — never raw producer
 * text or private diagnostics.
 */
export function parseCreateUiSpecCandidate(
  raw: unknown,
  allowedEvidenceIds: ReadonlySet<string>,
): CreateUiSpecCandidate {
  const parsed = CreateUiSpecCandidateSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("invalid create-ui-spec candidate: structural validation failed");
  }
  const candidate = parsed.data;

  // Evidence membership: every cited evidenceId must exist in this response.
  for (const decision of candidate.decisions) {
    for (const eid of decision.evidenceIds) {
      if (!allowedEvidenceIds.has(eid)) {
        throw new Error(
          `invalid create-ui-spec candidate: decision "${decision.id}" cites unbound evidence id "${eid}"`,
        );
      }
    }
  }

  // Defense-in-depth: duplicate decision ids (already rejected structurally).
  const seen = new Set<string>();
  for (const decision of candidate.decisions) {
    if (seen.has(decision.id)) {
      throw new Error(`invalid create-ui-spec candidate: duplicate decision id "${decision.id}"`);
    }
    seen.add(decision.id);
  }

  return candidate;
}

// ===========================================================================
// 13. parseDesignArtifactEnvelope — re-render + re-hash verification
// ===========================================================================

/**
 * Parse and verify a design artifact envelope. Throws a single typed contract
 * error on any mismatch. Returns ONLY a parsed, re-render-verified envelope.
 *
 * Verification steps:
 *  1. validate against DesignArtifactEnvelopeSchema (this validates nested
 *     UiSpec 1.0, the strict handoff fields, retrieval state, warnings, and
 *     private-marker rejection);
 *  2. reconstruct a DesignHandoffT from the parsed spec + handoff target/
 *     motionIntents + the envelope's generatedAt via parseDesignHandoff;
 *  3. recompute specSha256, semanticSpecSha256 (via buildSemanticSpecInput),
 *     the optional modelExecutionSha256, and the two rendering hashes from
 *     re-rendered markdown/json;
 *  4. demand exact equality with the stored hashes AND exact byte-equality of
 *     the re-rendered renderings with the stored fields;
 *  5. re-check publicEvidenceIds uniqueness and private markers (defense in
 *     depth).
 */
export function parseDesignArtifactEnvelope(raw: unknown): DesignArtifactEnvelope {
  const parsed = DesignArtifactEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error("design artifact envelope integrity check failed: schema validation");
  }
  const env = parsed.data;

  // Reconstruct the trusted handoff from the stored spec + handoff target id +
  // motion intents + the envelope's generatedAt. The envelope stores only the
  // WebTargetId (not the full opaque profile), so we resolve the canonical
  // profile from the id; parseDesignHandoff re-validates via the registry.
  const handoff = parseDesignHandoff({
    spec: env.spec,
    target: resolveTargetProfile(env.handoff.target),
    motionIntents: env.handoff.motionIntents,
    generatedAt: env.generatedAt,
  });

  const renderedMarkdown = renderDesignHandoffMarkdown(handoff);
  const renderedJson = renderDesignHandoffJson(handoff);

  // Recompute hashes.
  const specSha = sha256Hex(Buffer.from(canonicalJsonStringify(env.spec), "utf-8"));
  const semanticSha = sha256Canonical(buildSemanticSpecInput(env.spec));
  const modelExecutionSha = env.modelExecution === undefined
    ? undefined
    : sha256Canonical(env.modelExecution);
  const markdownSha = sha256Hex(Buffer.from(renderedMarkdown, "utf-8"));
  const jsonSha = sha256Hex(Buffer.from(renderedJson, "utf-8"));

  // Exact-equality checks against stored values.
  if (env.specSha256 !== specSha) {
    throw new Error("design artifact envelope integrity check failed: specSha256 mismatch");
  }
  if (env.semanticSpecSha256 !== semanticSha) {
    throw new Error("design artifact envelope integrity check failed: semanticSpecSha256 mismatch");
  }
  if (env.modelExecutionSha256 !== modelExecutionSha) {
    throw new Error("design artifact envelope integrity check failed: modelExecutionSha256 mismatch");
  }
  if (env.designMarkdownSha256 !== markdownSha) {
    throw new Error("design artifact envelope integrity check failed: designMarkdownSha256 mismatch");
  }
  if (env.designJsonSha256 !== jsonSha) {
    throw new Error("design artifact envelope integrity check failed: designJsonSha256 mismatch");
  }
  // Exact byte-equality of the stored renderings vs the re-rendered ones.
  if (env.designMarkdown !== renderedMarkdown) {
    throw new Error("design artifact envelope integrity check failed: designMarkdown bytes");
  }
  if (env.designJson !== renderedJson) {
    throw new Error("design artifact envelope integrity check failed: designJson bytes");
  }

  // ----- Identity verification: artifactId + assemblyRulesSha256 -----
  // The assembly-rules hash is a frozen constant (RECIPE_SHA256). Any deviation
  // means the recipe drifted from what the artifact claims to have been
  // assembled with — fail-closed.
  if (env.assemblyRulesSha256 !== RECIPE_SHA256) {
    throw new Error(
      "design artifact envelope integrity check failed: assemblyRulesSha256 does not match the frozen recipe",
    );
  }
  // Recompute the canonical identity the EXACT way the producer does
  // (create-ui-spec.ts buildEnvelope): the typed buildArtifactIdentityInput
  // helper fed artifactVersion/producerVersion/assemblyRulesSha256/
  // semanticSpecSha256 + the stored handoff target/motionIntents +
  // renderingFormatVersion "web-1.0". The stored artifactId MUST equal the
  // recomputed `uispec-<sha256>` — otherwise a self-consistent forged envelope
  // could pass the hash + byte-equality checks with a bogus identity.
  const expectedArtifactId = `uispec-${sha256Canonical(
    buildArtifactIdentityInput({
      producerVersion: env.producerVersion,
      assemblyRulesSha256: env.assemblyRulesSha256,
      semanticSpecSha256: semanticSha,
      target: env.handoff.target,
      motionIntents: env.handoff.motionIntents,
    }),
  )}`;
  if (env.artifactId !== expectedArtifactId) {
    throw new Error(
      "design artifact envelope integrity check failed: artifactId does not match the recomputed identity",
    );
  }

  return env;
}

/**
 * Resolve the canonical WebTargetProfile for a stored target id. The envelope
 * persists only the id (per the plan's handoff shape); the parser reconstructs
 * the full profile from the id via CANONICAL_WEB_TARGET_PROFILES — the SAME
 * registry the producer consumes. This guarantees the re-render/re-hash step
 * byte-reproduces the producer's renderings for neutral-web, astro-react, and
 * astro-vue.
 *
 * WebTargetId is a closed enum, so every valid id has a canonical profile; the
 * throw below is defensive only and should never fire for an envelope whose
 * handoff.target passed EnvelopeHandoffSchema.
 */
function resolveTargetProfile(targetId: z.infer<typeof WebTargetId>): WebTargetProfile {
  const profile = CANONICAL_WEB_TARGET_PROFILES[targetId];
  if (profile === undefined) {
    throw new Error(
      `design artifact envelope integrity check failed: unknown web target id "${targetId}"`,
    );
  }
  return { ...profile };
}

// ===========================================================================
// Helpers: string collection + marker regexes (shared by several schemas)
// ===========================================================================

const HEADING_RE = /^ {0,3}#{1,6}\s/m;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/m;

/**
 * Distinctive substrings that mark a private corpus identity leak (corpus id
 * slug, private image path, private product/url host, private attribution
 * excerpt). These are the SAME markers the c3-runtime-probe fixture injects and
 * scans for, so the candidate + envelope superRefines and the runtime probe all
 * agree on what counts as a leak.
 *
 * NOTE: this is a SEPARATE concern from {@link SafeErrorMessage}'s path/url
 * refine, which is about operator-safe error text (no paths, urls, or corpus-
 * prefixed identifiers) rather than the private-corpus identity markers
 * enumerated here.
 */
export const PRIVATE_MARKERS: readonly string[] = [
  "private-corpus-id",
  ".c2-private/",
  "/corpus/private/",
  "corpus/images-private/",
  "images-private/",
];

/** Regex form of {@link PRIVATE_MARKERS} (private corpus paths). */
const PRIVATE_PATH_RE = /\.c2-private\/|\/corpus\/private\/|corpus\/images-private\//;

/**
 * True if `s` carries any distinctive private-corpus marker. Combines the
 * literal {@link PRIVATE_MARKERS} substring scan with the path-form regex
 * (which catches `/.c2-private/...`, `/corpus/private/...` variants that the
 * literal list also enumerates). Used by the candidate and envelope
 * superRefines so the two checks cannot drift in Phase 2.
 */
export function containsPrivateMarker(s: string): boolean {
  for (const marker of PRIVATE_MARKERS) {
    if (s.includes(marker)) return true;
  }
  return PRIVATE_PATH_RE.test(s);
}

/** Recursively collect ALL string values from an arbitrary object. */
function collectAllStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((v) => collectAllStrings(v));
  if (value !== null && typeof value === "object") {
    return Object.keys(value).flatMap((k) =>
      collectAllStrings((value as Record<string, unknown>)[k]),
    );
  }
  return [];
}

/** Alias used by the candidate/envelope superRefines. */
function collectStrings(value: unknown): string[] {
  return collectAllStrings(value);
}
