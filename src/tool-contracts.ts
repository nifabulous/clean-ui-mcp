/**
 * Canonical tool contracts — descriptor-driven architecture.
 *
 * Governing invariant: Every accepted or rejected MCP result is determined by
 * one canonical per-tool Zod schema. Documentation, types, validation,
 * reference extraction, counts, warnings and errors derive from the same
 * descriptor. parseToolResult() is a thin dispatcher with no independent
 * integrity logic.
 *
 * Build order in this file:
 * 1. Shared Zod building blocks (enums, retrieval, evidence, warnings, errors)
 * 2. Shared result-row sub-schemas
 * 3. UiSpec sub-schemas + complete UiSpec
 * 4. Per-tool input schemas (12)
 * 5. Per-tool data schemas (12)
 * 6. Per-tool warning/error schemas
 * 7. TOOL_DESCRIPTORS array (one entry per tool)
 * 8. Derived: TOOL_CATALOG, ToolName, schema maps, ToolResultSchemas (via makeEnvelope)
 * 9. parseToolResult — thin dispatcher
 */
import { z } from "zod";
import { createHash } from "node:crypto";
import { PatternType, Category, StyleTag } from "./schema.js";
import { CRITIQUE_UI_INPUT_SCHEMA, StructuredCritique } from "./synthesis/contracts.js";
import { validateEnvelopeRetrieval, validateEvidenceReferences, unique, sameSet, type RetrievalPolicy, type FallbackReason as IntegrityFallbackReason } from "./tool-contract-integrity.js";

// ===========================================================================
// 1. Shared building blocks
// ===========================================================================

// --- Retrieval state ---

export const RetrievalMode = z.enum([
  "hybrid", "vector", "keyword", "structured-fallback", "none",
]);
export const RetrievalModality = z.enum([
  "text", "image", "metadata", "none",
]);
export const FallbackReason = z.enum([
  "missing-index", "incompatible-index", "missing-provider-key",
  "community-edition", "provider-error", "no-image-evidence", "no-results",
]);

const ALLOWED_MODE_MODALITY: Record<string, readonly string[]> = {
  none: ["none"],
  keyword: ["text", "metadata"],
  vector: ["text", "image"],
  hybrid: ["text"],
  "structured-fallback": ["metadata"],
};

export const RetrievalState = z.object({
  mode: RetrievalMode,
  modality: RetrievalModality,
  resultCount: z.number().int().nonnegative(),
  fallbackUsed: z.boolean(),
  attemptedCount: z.number().int().nonnegative(),
  fallbackReason: FallbackReason.optional(),
  attemptedModes: z.array(RetrievalMode),
}).strict().superRefine((val, ctx) => {
  const allowed = ALLOWED_MODE_MODALITY[val.mode];
  if (allowed && !allowed.includes(val.modality))
    ctx.addIssue({ code: "custom", message: `mode "${val.mode}" cannot have modality "${val.modality}"`, path: ["modality"] });
  if (val.fallbackUsed && val.fallbackReason === undefined)
    ctx.addIssue({ code: "custom", message: "fallbackUsed requires fallbackReason", path: ["fallbackReason"] });
  if (!val.fallbackUsed && val.fallbackReason !== undefined)
    ctx.addIssue({ code: "custom", message: "fallbackReason requires fallbackUsed", path: ["fallbackUsed"] });
  if (val.mode === "none" && val.fallbackUsed)
    ctx.addIssue({ code: "custom", message: "'none' cannot have fallback", path: ["mode"] });
  if (val.mode === "vector" && val.fallbackReason === "missing-index")
    ctx.addIssue({ code: "custom", message: "'vector' with 'missing-index' is contradictory", path: ["mode"] });
  if (val.mode === "structured-fallback" && !val.fallbackUsed)
    ctx.addIssue({ code: "custom", message: "'structured-fallback' requires fallbackUsed", path: ["fallbackUsed"] });
  // attemptedCount must equal attemptedModes length
  if (val.attemptedCount !== val.attemptedModes.length)
    ctx.addIssue({ code: "custom", message: `attemptedCount (${val.attemptedCount}) must equal attemptedModes length (${val.attemptedModes.length})`, path: ["attemptedCount"] });
  // NOTE: attemptedModes MAY be non-empty when fallbackUsed is false — terminal errors
  // record failed attempts without claiming a fallback produced results.
  // Duplicate/none/current-mode checks run ALWAYS (not just on fallback)
  if (val.attemptedModes.length > 0) {
    if (val.attemptedModes.includes("none"))
      ctx.addIssue({ code: "custom", message: "attemptedModes cannot contain 'none'", path: ["attemptedModes"] });
    if (val.attemptedModes.includes(val.mode))
      ctx.addIssue({ code: "custom", message: "attemptedModes cannot contain current mode", path: ["attemptedModes"] });
    if (new Set(val.attemptedModes).size !== val.attemptedModes.length)
      ctx.addIssue({ code: "custom", message: "attemptedModes cannot have duplicates", path: ["attemptedModes"] });
  }
  if (val.fallbackUsed) {
    if (val.attemptedModes.length === 0)
      ctx.addIssue({ code: "custom", message: "fallback requires non-empty attemptedModes", path: ["attemptedModes"] });
  }
});

/**
 * The safe public model-execution states a model-lane tool may project.
 * Mirrors the `state` discriminants of ModelExecutionSchema in
 * create-ui-spec-model-contracts.ts; a sync test in tool-contracts.test.ts
 * pins the two enums to the same member set. `null` means "no model ran".
 * No provider data (key, URL, response bytes, request id) is representable.
 */
export const ModelExecutionStateSchema = z.enum([
  "invalid-configuration",
  "call-failed",
  "proposal-rejected",
  "persistence-failed",
  "succeeded",
]);

export function isAllowedRetrievalState(s: Record<string, unknown>): boolean {
  return RetrievalState.safeParse(s).success;
}

// --- Evidence ---

export const EvidenceKind = z.enum([
  "corpus-observation", "screen-observation", "dom-signal",
  "machine-rule", "editorial-guidance",
  // C3 producer vocabulary — mirrors EvidenceKindSchema in
  // create-ui-spec-contracts.ts. `public-reference` is an explicit
  // user-supplied input; `recipe-system` is the deterministic operator-authored
  // recipe, which grounds editorial-authority decisions and is never a corpus
  // observation.
  "public-reference", "recipe-system",
]);
export const EvidenceBasis = z.enum([
  "visible", "inferred", "dom-grounded", "editorial",
  // C3 producer vocabulary — mirrors EvidenceBasisSchema in
  // create-ui-spec-contracts.ts. `aggregate` is derived from structure/counts
  // rather than a single visible source; `user-supplied` is the only
  // public-input basis.
  "aggregate", "user-supplied",
]);

/**
 * The response-scoped public evidence-ID shape. Mirrors `EvidenceIdSchema` in
 * create-ui-spec-contracts.ts: corpus observations and public references both
 * receive a fresh, response-local `evidence-N` id so no upstream corpus
 * identity ever reaches public output.
 *
 * This pattern separates the two ID domains mechanically. A value matching it
 * is a PUBLIC EVIDENCE ID and may never appear as a `referenceId` (which is
 * always a safe public reference), and vice versa.
 *
 * BOTH directions are enforced, in two places. The shared `Evidence` schema
 * below refuses this shape in `referenceId` for every evidence tool. The
 * positive direction — an evidence-ID position must POSITIVELY match this
 * pattern, so a filesystem path, a source URL or a raw corpus ID cannot sit
 * there — is enforced for create_ui_spec by the structural leaf-value gate
 * (`findUnsafeCreateUiSpecLeaves`), which applies it at every evidence-ID
 * position at once rather than field by field.
 */
const RESPONSE_SCOPED_EVIDENCE_ID = /^evidence-[0-9]+$/;

/**
 * Explicit kind-to-basis allowlist. This replaces the previous per-kind
 * deny-lists, which would have silently admitted the two new C3 bases
 * (`aggregate`, `user-supplied`) on every legacy kind. Each legacy row is the
 * exact complement of its old deny-list, so legacy behavior is unchanged.
 */
const EVIDENCE_KIND_BASES: Record<string, readonly string[]> = {
  "corpus-observation": ["visible", "inferred"],
  "screen-observation": ["visible", "inferred"],
  "dom-signal": ["dom-grounded", "visible"],
  "editorial-guidance": ["editorial"],
  "machine-rule": ["inferred", "editorial"],
  // C3 kinds: the producer emits exactly one basis for each.
  "public-reference": ["user-supplied"],
  "recipe-system": ["aggregate"],
};

export const Evidence = z.object({
  id: z.string().trim().min(1),
  referenceId: z.string().trim().min(1).optional(),
  kind: EvidenceKind,
  summary: z.string().trim().min(1),
  basis: EvidenceBasis,
}).strict().superRefine((val, ctx) => {
  const allowedBases = EVIDENCE_KIND_BASES[val.kind];
  if (allowedBases && !allowedBases.includes(val.basis))
    ctx.addIssue({ code: "custom", message: `${val.kind} basis must be ${allowedBases.join(" or ")}`, path: ["basis"] });

  const responseScoped = RESPONSE_SCOPED_EVIDENCE_ID.test(val.id);

  if (val.kind === "corpus-observation") {
    if (responseScoped) {
      // A response-scoped corpus observation carries NO public citation — the
      // same rule create-ui-spec-contracts.ts enforces on `publicReference`.
      // Attaching one would either leak a corpus identity or falsely claim the
      // private entry is publicly citable.
      if (val.referenceId !== undefined)
        ctx.addIssue({ code: "custom", message: "response-scoped corpus-observation must not carry referenceId", path: ["referenceId"] });
    } else if (!val.referenceId) {
      // Legacy (non-response-scoped) corpus rows keep their original requirement.
      ctx.addIssue({ code: "custom", message: "corpus-observation requires referenceId", path: ["referenceId"] });
    }
  }
  // A public reference is exactly that: the safe public citation is mandatory.
  if (val.kind === "public-reference" && !val.referenceId)
    ctx.addIssue({ code: "custom", message: "public-reference requires referenceId", path: ["referenceId"] });
  // The recipe is operator content, not a user/public citation.
  if (val.kind === "recipe-system" && val.referenceId !== undefined)
    ctx.addIssue({ code: "custom", message: "recipe-system must not carry referenceId", path: ["referenceId"] });
  // ID-domain separation: a public evidence ID may never be substituted for a
  // safe public reference ID.
  if (val.referenceId !== undefined && RESPONSE_SCOPED_EVIDENCE_ID.test(val.referenceId))
    ctx.addIssue({ code: "custom", message: "referenceId must be a safe public reference, not a response-scoped evidence ID", path: ["referenceId"] });
});

// Evidence array with unique-ID enforcement
const EvidenceArray = z.array(Evidence).superRefine((arr, ctx) => {
  const seen = new Set<string>();
  arr.forEach((e, i) => {
    if (seen.has(e.id))
      ctx.addIssue({ code: "custom", message: `duplicate evidence id at evidence[${i}].id (value withheld)`, path: [i, "id"] });
    seen.add(e.id);
  });
});

// --- Typed warnings ---

const WarningBase = z.object({
  code: z.string().min(1),
  message: z.string().trim().min(1),
}).strict();

function makeWarningSchema<const T extends readonly string[]>(codes: T) {
  return z.array(z.object({
    code: z.enum(codes),
    message: z.string().trim().min(1),
  }).strict());
}

// --- Typed errors (literal-variant union with code↔retryable binding) ---
//
// Each application error code is a single Zod object variant where BOTH `code`
// and `retryable` are literal — so the binding is enforced at the TYPE level
// (a `NOT_FOUND` with `retryable:true` is a compile error) AND at runtime (the
// literal schema rejects it during parse). makeErrorSchema(codes) selects the
// requested variants and returns a Zod union over them. Tools with no
// application errors use z.never().optional().

const NonEmptyText = z.string().trim().min(1);

const ERROR_VARIANTS = {
  NOT_FOUND: z.object({ code: z.literal("NOT_FOUND"), message: NonEmptyText, retryable: z.literal(false) }).strict(),
  INDEX_UNAVAILABLE: z.object({ code: z.literal("INDEX_UNAVAILABLE"), message: NonEmptyText, retryable: z.literal(true) }).strict(),
  PROVIDER_ERROR: z.object({ code: z.literal("PROVIDER_ERROR"), message: NonEmptyText, retryable: z.literal(true) }).strict(),
  INVALID_INPUT: z.object({ code: z.literal("INVALID_INPUT"), message: NonEmptyText, retryable: z.literal(false) }).strict(),
} as const;

export const ToolErrorUnion = z.discriminatedUnion("code", [
  ERROR_VARIANTS.NOT_FOUND,
  ERROR_VARIANTS.INDEX_UNAVAILABLE,
  ERROR_VARIANTS.PROVIDER_ERROR,
  ERROR_VARIANTS.INVALID_INPUT,
]);

const ERROR_RETRYABLE: Record<string, boolean> = {
  NOT_FOUND: false, INVALID_INPUT: false,
  INDEX_UNAVAILABLE: true, PROVIDER_ERROR: true,
};
export { ERROR_RETRYABLE };

// Union of all error code literals — used to constrain makeErrorSchema's input.
type ErrorCode = keyof typeof ERROR_VARIANTS;

/**
 * Build a per-tool error schema as a literal-variant union. `code` AND
 * `retryable` are literal per variant, so the inferred TS type is a precise
 * discriminated union (e.g. `{ code: "NOT_FOUND"; retryable: false } | ...`).
 * Codes appear in the union in the order given, preserving deterministic docs
 * output. A single code yields that variant directly (no union wrapper).
 */
function makeErrorSchema<const T extends readonly ErrorCode[]>(codes: T) {
  if (codes.length === 0) return z.never().optional();
  const variants = codes.map(c => ERROR_VARIANTS[c]);
  if (variants.length === 1) return variants[0]!;
  return z.union([variants[0]!, variants[1]!, ...variants.slice(2)]);
}

// ===========================================================================
// 2. Shared result-row sub-schemas
// ===========================================================================

const SourceRef = z.object({
  productName: z.string().trim().min(1),
  url: z.string().nullable(),
  imageAvailable: z.boolean(),
}).strict();

const ReferenceSummary = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  product: z.string().trim().min(1),
  patternType: z.string().min(1),
  categories: z.array(z.string()),
  styleTags: z.array(z.string()),
  qualityScore: z.number().int(),
  qualityTier: z.string(),
  source: SourceRef,
  critique: z.string(),
  topTechniques: z.array(z.string()),
  antiPatterns: z.array(z.string()),
}).strict();

const SimilarReference = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  product: z.string().trim().min(1),
  patternType: z.string().min(1),
  categories: z.array(z.string()),
  styleTags: z.array(z.string()),
  score: z.number(),
  basis: z.string().min(1),
  critique: z.string(),
  techniques: z.array(z.string()),
}).strict();

const ComparisonRow = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  product: z.string().trim().min(1),
  patternType: z.string(),
  categories: z.array(z.string()),
  styleTags: z.array(z.string()),
  platform: z.string(),
  layout: z.string(),
  accent: z.string(),
  density: z.string(),
  corners: z.string(),
  quality: z.string(),
  critiqueAngle: z.string(),
  topTechnique: z.string(),
  antiPatterns: z.array(z.string()),
  whereItFails: z.string(),
  accessibility: z.string(),
}).strict();

const TaxonomyList = z.object({
  count: z.number().int().nonnegative(),
  values: z.array(z.string().min(1)),
}).strict();

const PatternGroupExemplar = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  product: z.string().trim().min(1),
  qualityScore: z.number().int(),
  critique: z.string(),
}).strict();

const PatternGroup = z.object({
  patternType: z.string().min(1),
  count: z.number().int().nonnegative(),
  topProducts: z.array(z.string()),
  exemplar: PatternGroupExemplar,
}).strict();

const PaletteTokens = z.object({
  canvas: z.string().min(1),
  surface: z.string().min(1),
  ink: z.string().min(1),
  muted: z.string().nullable(),
  accent: z.string().min(1),
}).strict();

const PaletteRecord = z.object({
  tokens: PaletteTokens,
  accentHue: z.number(),
  product: z.string().trim().min(1),
  sourceId: z.string().trim().min(1),
  patternType: z.string().min(1),
}).strict();

const TechniqueRow = z.object({
  text: z.string().trim().min(1),
  source: z.object({ id: z.string().trim().min(1), product: z.string().trim().min(1) }).strict(),
}).strict();

const AntiPatternRow = z.object({
  text: z.string().trim().min(1),
  sourceIds: z.array(z.string().min(1)),
  count: z.number().int(),
}).strict();

const FullReference = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  product: z.string().trim().min(1),
  patternType: z.string(),
  categories: z.array(z.string()),
  styleTags: z.array(z.string()),
  qualityScore: z.number().int(),
  qualityTier: z.string(),
  platform: z.string(),
  layout: z.string(),
  accentColor: z.string().nullable(),
  dominantColors: z.array(z.string()),
  colorRoles: z.object({
    canvas: z.string().nullable(),
    surface: z.string().nullable(),
    ink: z.string().nullable(),
    muted: z.string().nullable(),
    accent: z.string().nullable(),
  }).nullable(),
  typePairing: z.object({
    display: z.string().nullable(),
    body: z.string().nullable(),
    notes: z.string().optional(),
  }).nullable(),
  spacingDensity: z.string(),
  cornerStyle: z.string(),
  usesShadows: z.boolean(),
  usesBorders: z.boolean(),
  critique: z.string(),
  techniques: z.array(z.string()),
  antiPatterns: z.array(z.string()),
  whereThisFails: z.array(z.string()),
  accessibility: z.array(z.object({
    element: z.string(),
    risk: z.string(),
    wcag: z.array(z.string()),
  }).strict()),
  businessRationale: z.object({
    businessGoal: z.string().nullable(),
    targetUser: z.string().nullable(),
    rationale: z.string().nullable(),
    confirmed: z.boolean(),
  }).nullable().optional(),
  voice: z.object({
    tone: z.string().nullable(),
    examples: z.array(z.string()),
    avoid: z.array(z.string()),
  }).nullable().optional(),
  source: SourceRef,
  imageAvailable: z.boolean(),
}).strict();

// Critique data — strict mirror of StructuredCritique minus schemaVersion
const CritiqueDataSchema = z.object({
  platform: z.string(),
  retrievalMode: z.string(),
  fallbackUsed: z.boolean(),
  coverage: z.string(),
  summary: z.string(),
  observations: z.array(z.string()),
  recommendations: z.array(z.object({
    observation: z.string(),
    impact: z.string(),
    recommendation: z.string(),
    evidence: z.array(z.string()).min(1),
    basis: z.enum(["visible", "inferred", "dom-grounded", "editorial"]),
  }).strict()),
  accessibilityRisks: z.array(z.object({
    element: z.string(),
    risk: z.string(),
    evidence: z.string(),
    wcag: z.array(z.string()).min(1),
    basis: z.enum(["visible", "inferred", "dom-grounded", "editorial"]),
  }).strict()),
  visualSlop: z.array(z.object({
    pattern: z.string(),
    basis: z.enum(["visible", "inferred", "dom-grounded"]),
    evidence: z.array(z.string()).min(1),
    exception: z.string().optional(),
  }).strict()),
  motion: z.array(z.object({
    basis: z.enum(["visible", "inferred", "dom-grounded", "editorial"]),
    evidence: z.array(z.string()).min(1),
    note: z.string(),
    reference: z.string().optional(),
  }).strict()),
  appliedReferences: z.array(z.object({
    id: z.string(),
    version: z.number().int(),
    purpose: z.string(),
  }).strict()),
  evidenceIds: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  md3: z.object({
    classification: z.enum(["supported", "insufficient-evidence", "conflicting"]),
    matchedCategories: z.array(z.string()),
    conflictingSignals: z.array(z.object({
      category: z.string(),
      evidenceId: z.string(),
      detail: z.string(),
    }).strict()),
    evidenceIds: z.array(z.string()),
    confidence: z.number(),
  }).strict().optional(),
}).strict();

// ===========================================================================
// 3. UiSpec sub-schemas + complete UiSpec
// ===========================================================================

const TokenAuthority = z.enum([
  "team-design-system", "project-constraint", "corpus-evidence", "editorial", "mixed",
]);

const AcceptanceAssertion = z.enum([
  "exists", "equals", "uses-token", "meets-contrast",
  "keyboard-operable", "has-accessible-name", "responsive-at", "motion-respects-preference",
]);
const AcceptancePriority = z.enum(["must", "should"]);

const AcceptanceCriterion = z.discriminatedUnion("verifier", [
  z.object({
    id: z.string().trim().min(1),
    subject: z.string().trim().min(1),
    assertion: AcceptanceAssertion,
    expectedOutcome: z.string().trim().min(1),
    verifier: z.literal("axe"),
    priority: AcceptancePriority,
    evidenceIds: z.array(z.string()),
  }).strict(),
  z.object({
    id: z.string().trim().min(1),
    subject: z.string().trim().min(1),
    assertion: AcceptanceAssertion,
    expectedOutcome: z.string().trim().min(1),
    verifier: z.literal("playwright"),
    priority: AcceptancePriority,
    evidenceIds: z.array(z.string()),
    selector: z.string().min(1),
  }).strict(),
  z.object({
    id: z.string().trim().min(1),
    subject: z.string().trim().min(1),
    assertion: AcceptanceAssertion,
    expectedOutcome: z.string().trim().min(1),
    verifier: z.literal("static-analysis"),
    priority: AcceptancePriority,
    evidenceIds: z.array(z.string()),
    command: z.string().min(1),
  }).strict(),
  z.object({
    id: z.string().trim().min(1),
    subject: z.string().trim().min(1),
    assertion: AcceptanceAssertion,
    expectedOutcome: z.string().trim().min(1),
    verifier: z.literal("manual"),
    priority: AcceptancePriority,
    evidenceIds: z.array(z.string()),
    manualSteps: z.array(z.string().min(1)).min(1),
  }).strict(),
]);

const CitedDecision = z.object({
  id: z.string().trim().min(1),
  field: z.string().trim().min(1),
  authority: z.enum(["team-design-system", "project-constraint", "corpus-evidence", "editorial"]),
  evidenceIds: z.array(z.string()),
  readiness: z.enum(["available", "proposed", "unavailable"]),
  sourceId: z.string().optional(),
}).strict();

export const DesignSystemIdentitySchema = z.object({
  status: z.enum(["none", "identified"]),
  registry: z.string().optional(),
  library: z.string().optional(),
}).strict().superRefine((val, ctx) => {
  // status "identified" requires at least registry or library
  if (val.status === "identified" && !val.registry && !val.library)
    ctx.addIssue({ code: "custom", message: "status 'identified' requires registry or library", path: ["status"] });
  // status "none" must not carry registry/library
  if (val.status === "none" && (val.registry || val.library))
    ctx.addIssue({ code: "custom", message: "status 'none' must not include registry or library", path: ["status"] });
});
export type DesignSystemIdentity = z.infer<typeof DesignSystemIdentitySchema>;

const ColorTokens = z.object({
  primary: z.string().min(1),
  surface: z.string().min(1),
  ink: z.string().min(1),
  muted: z.string().min(1),
  accent: z.string().min(1),
}).strict();

const TypographyTokens = z.object({
  heading: z.string().min(1),
  body: z.string().min(1),
  mono: z.string().min(1),
}).strict();

const ModelProposalTokenValue = z.string().trim().min(1).max(200);

const ModelProposalColorTokens = z.object({
  primary: ModelProposalTokenValue,
  surface: ModelProposalTokenValue,
  ink: ModelProposalTokenValue,
  muted: ModelProposalTokenValue,
  accent: ModelProposalTokenValue,
}).strict();

const ModelProposalTypographyTokens = z.object({
  heading: ModelProposalTokenValue,
  body: ModelProposalTokenValue,
  mono: ModelProposalTokenValue,
}).strict();

/**
 * Bounded model-authored suggestions. These values are semantic artifact
 * content, but they remain visibly separate from the accepted token fields and
 * carry no evidence or authority controls that could promote them.
 */
export const ModelProposalSchema = z.object({
  status: z.literal("proposal-only"),
  disclaimer: z.literal("Proposal only; not accepted into token authority."),
  // 1000, not 4000. The 4000 bound grew out of a 6%-overshoot apology in the
  // other direction — but the REAL live failure was a ~5000-char single-line
  // designDirection causing the model to lose nesting track and emit a stray
  // "}", so the bound is now SHRUNK to shrink the malformation surface. 1000
  // chars is still a full paragraph. Still bounded, still strict, still
  // rejected past the cap. (UiSpec's OWN designDirection below carries no max
  // at all — that path is caller-authored, not model-authored.)
  // CAP 2500, PROMPT SAYS 1000 — DELIBERATELY DIFFERENT NUMBERS.
  //
  // Live claude-sonnet-4-5 overshoots whatever length it is told, and the ratio
  // GROWS as the instruction tightens: told 2000 it wrote 2118 (+6%), told 4000
  // it wrote 5010 (+25%), told 1000 it wrote 1549 (+55%). The model has a
  // natural length for this content and clamps toward it.
  //
  // So the prompt number and the schema cap do different jobs. The prompt's
  // 1000 is the LEVER that pulls generated length down — and pulling it down is
  // what killed the stray-brace derail, which only ever appeared on ~5000-char
  // single-line values. The schema's 2500 is the BOUND, set above the measured
  // overshoot so an honest answer is not rejected for being 549 chars over a
  // number the model was never able to hit. Setting both to 1000 rejected every
  // live call for a well-formed proposal.
  // 2500, RAISED FROM 2000 ON MEASURED DATA — and deliberately still not the
  // prompt's figure. An 8-brief live campaign put the worst case at 1629 chars
  // (81% of a 2000 cap, 371 to spare); the longest answer came from the SHORTEST
  // brief ("A login screen."), so brief complexity does not bound this and the
  // margin could not be reasoned about, only measured. Raising the BOUND cannot
  // reintroduce the stray-brace derail, because generated length is driven by
  // the prompt figure, which stays at 1000. What it buys is not throwing away a
  // well-formed 2100-char proposal — a false rejection costs an entire
  // generation, and the derail only ever appeared around 5000.
  designDirection: z.string().trim().min(1).max(2_500),
  colorTokens: ModelProposalColorTokens.optional(),
  typographyTokens: ModelProposalTypographyTokens.optional(),
  // EVERY CAP IS 2.5x ITS PROMPT FIGURE. One rule, not three tuned numbers.
  //
  // Two live campaigns (20 runs) measured how far the model overruns whatever
  // length the prompt states:
  //
  //   designDirection  prompt 1000 -> observed max 1629  (1.63x)
  //   motionNotes[]    prompt  250 -> observed max  460  (1.84x)
  //   voice            prompt  500 -> observed max  727  (1.45x)
  //
  // Tuning caps one at a time just moves the bottleneck: raising
  // designDirection from 2000 to 2500 left motionNotes at 92% of ITS cap on the
  // very next campaign, and the worst case came from "Make it better." — vague
  // briefs elaborate MORE, so input size cannot bound this. 2.5x sits above the
  // worst ratio yet measured (1.84x) with room, and applies uniformly so the
  // next field to creep is already covered.
  //
  // Raising bounds is safe; the prompt figures are unchanged, and those are what
  // drive generated length and what killed the stray-brace derail.
  motionNotes: z.array(z.string().trim().min(1).max(625)).max(8).default([]),
  contentVoiceGuidance: z.string().trim().min(1).max(1_250).optional(),
}).strict();
export type ModelProposal = z.infer<typeof ModelProposalSchema>;

const MotionGuidance = z.object({
  notes: z.array(z.string()),
  evidenceUnavailable: z.boolean(),
}).strict();

const AuthorityLanes = z.object({
  corpusEvidence: z.array(z.string()),
  machineRules: z.array(z.string()),
  editorialGuidance: z.array(z.string()),
}).strict();

const LayoutRegion = z.object({
  name: z.string().trim().min(1),
  type: z.string().trim().min(1),
  components: z.array(z.string()),
  responsive: z.array(z.string()),
}).strict();

const ComponentEntry = z.object({
  name: z.string().trim().min(1),
  pattern: z.string().trim().min(1),
  sourceId: z.string().optional(),
}).strict();

const TechniqueEntry = z.object({
  text: z.string().trim().min(1),
  sourceIds: z.array(z.string()),
}).strict();

const AntiPatternEntry = z.object({
  text: z.string().trim().min(1),
  sourceIds: z.array(z.string()),
}).strict();

const UnavailableDecision = z.object({
  field: z.string().trim().min(1),
  reason: z.string().trim().min(1),
}).strict();

/**
 * Structured design intent supplied by the CALLER. Never inferred from prose,
 * never upgraded to corpus evidence, never synthesized into tokens. Mirrors
 * MotionIntentSchema's discipline: explicit, bounded, `.strict()`.
 *
 * SCOPE: intent is RECORDED, not materialized. A caller saying "light blue"
 * has not supplied the five required ColorTokens members; synthesizing them
 * from a mood word would be invention. `colorTokens`/`typographyTokens` stay
 * `null` under the deterministic recipe regardless of intent.
 *
 * These live here rather than in create-ui-spec-contracts.ts because
 * {@link SpecContext} below must reference them and that module imports this
 * one, not the reverse.
 */
/**
 * Every member is optional, which without this refinement makes `{}` legal — and
 * an empty intent object is not intent. The producer would record it in
 * `spec.context`, feed it into `semanticSpecSha256`, and the site would render an
 * empty "Design intent" panel. Refusing beats normalizing it away: silently
 * dropping a key the caller sent is the quiet rewrite the honesty invariant
 * exists to prevent, and `{}` is far likelier a caller-side serialization bug
 * than a deliberate statement of "no intent". Omit the key instead.
 */
function statesSomething(value: Record<string, unknown>): boolean {
  return Object.values(value).some((member) => member !== undefined);
}

export const ColorIntentSchema = z.object({
  accentPreference: z.string().trim().min(1).max(120).optional(),
  mood: z.string().trim().min(1).max(120).optional(),
  contrastFloor: z.enum(["AA", "AAA"]).optional(),
}).strict().refine(statesSomething, {
  // No identifier or path in the text — SafeErrorMessage is absolute.
  message: "colorIntent must state at least one preference; omit it entirely to state none",
});

export const TypeIntentSchema = z.object({
  voice: z.string().trim().min(1).max(120).optional(),
  density: z.enum(["compact", "regular", "spacious"]).optional(),
}).strict().refine(statesSomething, {
  message: "typeIntent must state at least one preference; omit it entirely to state none",
});

const SpecContext = z.object({
  productContext: z.string().trim().min(1),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  implementationFramework: z.string().optional(),
  designSystem: DesignSystemIdentitySchema.optional(),
  constraints: z.array(z.string().trim().min(1)).default([]),
  // Caller-supplied design intent. Present only when the caller supplied it;
  // this is the ONE place intent surfaces, so it reaches semanticSpecSha256
  // (which hashes the whole spec) and therefore artifactId.
  colorIntent: ColorIntentSchema.optional(),
  typeIntent: TypeIntentSchema.optional(),
}).strict();

export const UiSpec = z.object({
  specVersion: z.literal("1.0"),
  context: SpecContext,
  designDirection: z.string().trim().min(1),
  rejectedDefaults: z.array(z.string()),
  layoutRegions: z.array(LayoutRegion),
  responsiveBehavior: z.array(z.string()),
  componentInventory: z.array(ComponentEntry),
  colorTokens: ColorTokens.nullable(),
  colorTokenAuthority: TokenAuthority,
  typographyTokens: TypographyTokens.nullable(),
  typographyTokenAuthority: TokenAuthority,
  modelProposal: ModelProposalSchema.optional(),
  interactions: z.array(z.string()),
  motionGuidance: MotionGuidance,
  accessibilityConstraints: z.array(z.string()),
  contentVoiceGuidance: z.string().optional(),
  techniques: z.array(TechniqueEntry),
  antiPatterns: z.array(AntiPatternEntry),
  frameworkNotes: z.string().optional(),
  unavailableDecisions: z.array(UnavailableDecision),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
  citedReferences: z.array(z.string()),
  citedDecisions: z.array(CitedDecision),
  authorityLanes: AuthorityLanes,
  provenance: z.object({
    generatedAt: z.string().datetime(),
    toolVersion: z.string().min(1),
    sourceReferences: z.array(z.string()),
    evidenceIds: z.array(z.string()),
  }).strict(),
}).strict().superRefine((val, ctx) => {
  // Unique unavailableDecisions fields
  const decisionFields = val.unavailableDecisions.map(d => d.field);
  if (new Set(decisionFields).size !== decisionFields.length)
    ctx.addIssue({ code: "custom", message: "unavailableDecisions fields must be unique", path: ["unavailableDecisions"] });
  // Proposal-only output cannot coexist with accepted root token values or
  // non-editorial root authority. Existing null-token refinements below still
  // require the matching unavailableDecision rows.
  if (val.modelProposal !== undefined) {
    if (val.colorTokens !== null)
      ctx.addIssue({ code: "custom", message: "modelProposal requires root colorTokens to remain unavailable", path: ["colorTokens"] });
    if (val.colorTokenAuthority !== "editorial")
      ctx.addIssue({ code: "custom", message: "modelProposal requires root colorTokenAuthority 'editorial'", path: ["colorTokenAuthority"] });
    if (val.typographyTokens !== null)
      ctx.addIssue({ code: "custom", message: "modelProposal requires root typographyTokens to remain unavailable", path: ["typographyTokens"] });
    if (val.typographyTokenAuthority !== "editorial")
      ctx.addIssue({ code: "custom", message: "modelProposal requires root typographyTokenAuthority 'editorial'", path: ["typographyTokenAuthority"] });
  }
  // Null colorTokens requires colorTokenAuthority "editorial" and an exact unavailableDecision
  if (val.colorTokens === null) {
    if (val.colorTokenAuthority !== "editorial")
      ctx.addIssue({ code: "custom", message: "null colorTokens requires colorTokenAuthority 'editorial'", path: ["colorTokenAuthority"] });
    if (!val.unavailableDecisions.some(d => d.field === "colorTokens"))
      ctx.addIssue({ code: "custom", message: "null colorTokens requires an unavailableDecision with field 'colorTokens'", path: ["unavailableDecisions"] });
  } else {
    // Non-null colorTokens must NOT have an unavailableDecision for colorTokens
    if (val.unavailableDecisions.some(d => d.field === "colorTokens"))
      ctx.addIssue({ code: "custom", message: "available colorTokens must not have an unavailableDecision for 'colorTokens'", path: ["unavailableDecisions"] });
  }
  // Null typographyTokens requires typographyTokenAuthority "editorial" and exact unavailableDecision
  if (val.typographyTokens === null) {
    if (val.typographyTokenAuthority !== "editorial")
      ctx.addIssue({ code: "custom", message: "null typographyTokens requires typographyTokenAuthority 'editorial'", path: ["typographyTokenAuthority"] });
    if (!val.unavailableDecisions.some(d => d.field === "typographyTokens"))
      ctx.addIssue({ code: "custom", message: "null typographyTokens requires an unavailableDecision with field 'typographyTokens'", path: ["unavailableDecisions"] });
  } else {
    if (val.unavailableDecisions.some(d => d.field === "typographyTokens"))
      ctx.addIssue({ code: "custom", message: "available typographyTokens must not have an unavailableDecision for 'typographyTokens'", path: ["unavailableDecisions"] });
  }
  // mixed authority for color requires >1 distinct non-editorial authority among color-token citedDecisions
  if (val.colorTokenAuthority === "mixed") {
    const colorAuthorities = new Set(
      val.citedDecisions
        .filter(d => (d.field === "colorTokens" || d.field.startsWith("color-")) && d.authority !== "editorial")
        .map(d => d.authority),
    );
    if (colorAuthorities.size < 2)
      ctx.addIssue({ code: "custom", message: "'mixed' color authority requires color citedDecisions with >1 distinct non-editorial authority", path: ["colorTokenAuthority"] });
  }
  // mixed authority for typography (scoped to exact field identifiers)
  if (val.typographyTokenAuthority === "mixed") {
    const typeAuthorities = new Set(
      val.citedDecisions
        .filter(d => (d.field === "typographyTokens" || d.field.startsWith("typography-")) && d.authority !== "editorial")
        .map(d => d.authority),
    );
    if (typeAuthorities.size < 2)
      ctx.addIssue({ code: "custom", message: "'mixed' typography authority requires typography citedDecisions with >1 distinct non-editorial authority", path: ["typographyTokenAuthority"] });
  }
  // motion: exact field identifier, not substring
  if (val.motionGuidance.evidenceUnavailable) {
    if (!val.unavailableDecisions.some(d => d.field === "motion"))
      ctx.addIssue({ code: "custom", message: "motionGuidance.evidenceUnavailable requires an unavailableDecision with field 'motion'", path: ["unavailableDecisions"] });
  } else {
    if (val.unavailableDecisions.some(d => d.field === "motion"))
      ctx.addIssue({ code: "custom", message: "available motion must not have an unavailableDecision for 'motion'", path: ["unavailableDecisions"] });
  }
  // Authority prerequisites for each citedDecision
  const hasConstraints = (val.context as Record<string, unknown>)?.constraints !== undefined
    && Array.isArray((val.context as Record<string, unknown>)?.constraints)
    && ((val.context as Record<string, unknown>).constraints as unknown[]).length > 0;
  for (const cd of val.citedDecisions) {
    if (cd.authority === "team-design-system" && val.context.designSystem?.status !== "identified")
      ctx.addIssue({ code: "custom", message: `citedDecision "${cd.id}" has team-design-system authority but designSystem is not identified`, path: ["citedDecisions"] });
    if (cd.authority === "project-constraint" && !hasConstraints)
      ctx.addIssue({ code: "custom", message: `citedDecision "${cd.id}" has project-constraint authority but context has no constraints`, path: ["citedDecisions"] });
    if (cd.authority === "corpus-evidence" && !cd.evidenceIds.some(eid => val.authorityLanes.corpusEvidence.includes(eid)))
      ctx.addIssue({ code: "custom", message: `citedDecision "${cd.id}" has corpus-evidence authority but no evidence in corpusEvidence lane`, path: ["citedDecisions"] });
    if (cd.authority === "editorial" && !cd.evidenceIds.some(eid => val.authorityLanes.editorialGuidance.includes(eid)))
      ctx.addIssue({ code: "custom", message: `citedDecision "${cd.id}" has editorial authority but no evidence in editorialGuidance lane`, path: ["citedDecisions"] });
  }
  // Token-level team-design-system requires identified design system
  const hasTeamToken = val.colorTokenAuthority === "team-design-system" || val.typographyTokenAuthority === "team-design-system";
  if (hasTeamToken && val.context.designSystem?.status !== "identified")
    ctx.addIssue({ code: "custom", message: "team-design-system token authority requires context.designSystem.status 'identified'", path: ["context", "designSystem"] });
  // Token-level project-constraint requires context constraints
  const hasConstraintToken = val.colorTokenAuthority === "project-constraint" || val.typographyTokenAuthority === "project-constraint";
  if (hasConstraintToken && !hasConstraints)
    ctx.addIssue({ code: "custom", message: "project-constraint token authority requires context.constraints to be non-empty", path: ["context", "constraints"] });
  // citedDecision.sourceId must be in citedReferences
  const refSet = new Set(val.citedReferences);
  for (const cd of val.citedDecisions) {
    if (cd.sourceId !== undefined && !refSet.has(cd.sourceId))
      ctx.addIssue({ code: "custom", message: `citedDecisions[].sourceId not in citedReferences (value withheld)`, path: ["citedDecisions"] });
  }
});

// ===========================================================================
// 4. Per-tool input schemas
// ===========================================================================

export const SearchInput = z.object({
  query: z.string().optional(), category: Category.optional(), styleTag: StyleTag.optional(),
  patternType: PatternType.optional(), minQuality: z.number().min(1).max(5).optional(),
  qualityTier: z.enum(["exceptional", "cautionary"]).optional(),
  reviewStatus: z.enum(["approved", "draft", "any"]).optional(),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  limit: z.number().int().min(1).max(20).default(5),
  responseFormat: z.enum(["concise", "detailed"]).optional(),
}).strict();

const IdInput = z.object({ id: z.string().trim().min(1) }).strict();
const SimilarInput = z.object({ id: z.string().trim().min(1), limit: z.number().int().min(1).max(20).default(5) }).strict();
const CompareInput = z.object({
  ids: z.array(z.string().trim().min(1)).min(2).max(3).refine(a => new Set(a).size === a.length, "ids must be unique"),
  responseFormat: z.enum(["concise", "detailed"]).optional(),
}).strict();

// ---------------------------------------------------------------------------
// create_ui_spec transport input.
//
// Every field except `outputFormat` is a pass-through to
// `CreateUiSpecRequestSchema` (create-ui-spec-contracts.ts) and MUST carry the
// CORE bounds, so transport input that parses here cannot be rejected later by
// the producer. `outputFormat` is adapter-local: it selects which validated
// rendering the transport returns and never reaches the core request.
//
// `target` and `motionIntents` are MIRRORS of `WebTargetId` and
// `MotionIntentSchema` from design-target-contracts.ts rather than imports:
// that module imports `UiSpec` from this one, so importing it back would create
// an evaluation cycle whose TDZ failure depends on which module loads first.
// The mirrors are pinned by a mechanical JSON-Schema drift gate in
// tool-contracts.test.ts ("every core request field is mirrored with identical
// bounds"), so divergence fails the suite instead of passing silently.
// ---------------------------------------------------------------------------
const CreateUiSpecTargetId = z.enum(["neutral-web", "astro-react", "astro-vue"]);

const CreateUiSpecMotionIntent = z.object({
  id: z.string().min(1),
  trigger: z.string().min(1),
  properties: z.array(z.string()),
  durationToken: z.string().min(1),
  easingToken: z.string().min(1),
  interruptible: z.boolean(),
  reducedMotion: z.string().min(1),
}).strict();

export const CreateUiSpecInput = z.object({
  productContext: z.string().trim().min(8).max(8_000),
  referenceIds: z.array(z.string().trim().min(1).max(200)).max(5).default([])
    .refine(a => new Set(a).size === a.length, "referenceIds must be unique"),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  implementationFramework: z.string().trim().min(1).max(120).optional(),
  designSystem: DesignSystemIdentitySchema.optional(),
  constraints: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
  target: CreateUiSpecTargetId.optional(),
  motionIntents: z.array(CreateUiSpecMotionIntent).max(8).default([]),
  // Reuses the canonical schema objects rather than hand-mirroring them: both
  // the core request and this transport input read the same definition, so the
  // two drift gates below have nothing to catch.
  colorIntent: ColorIntentSchema.optional(),
  typeIntent: TypeIntentSchema.optional(),
  /** Adapter-local presentation selection — never part of the core request. */
  outputFormat: z.enum(["markdown", "json"]).default("markdown"),
}).strict();

const PlanInput = z.object({
  productContext: z.string().trim().min(8),
  category: Category.optional(), styleTag: StyleTag.optional(),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  qualityTier: z.enum(["exceptional", "cautionary"]).default("exceptional"),
  framework: z.enum(["brief", "tokens"]).optional(),
  count: z.number().int().min(1).max(5).default(3),
}).strict();

const AntiPatternInput = z.object({
  patternType: PatternType.optional(), category: Category.optional(),
  limit: z.number().int().min(1).max(20).default(10),
}).strict();

const PaletteInput = z.object({
  patternType: PatternType.optional(), styleTag: StyleTag.optional(),
  limit: z.number().int().min(1).max(20).default(10),
}).strict();

const TechniqueInput = z.object({
  patternType: PatternType.optional(), styleTag: StyleTag.optional(),
  limit: z.number().int().min(1).max(30).default(15),
}).strict();

// ===========================================================================
// 5. Per-tool data schemas
// ===========================================================================

const PlanDecision = z.object({
  field: z.string().trim().min(1), value: z.string().trim().min(1),
  // plan has no designSystem context, so team-design-system authority is not available here
  authority: z.enum(["project-constraint", "corpus-evidence", "editorial"]),
  evidenceIds: z.array(z.string()),
}).strict();

const PlanDataSchema = z.object({
  direction: z.string().trim().min(1),
  rejectedDefaults: z.array(z.string()),
  recommendation: z.string().trim().min(1),
  rationale: z.string().trim().min(1),
  evidenceContributions: z.array(z.string()),
  structuredDecisions: z.array(PlanDecision),
}).strict();

// ===========================================================================
// 6-7. TOOL_DESCRIPTORS — one colocated entry per tool
// ===========================================================================

// Helper: all evidence kinds for synthesis tools
const ALL_SYNTHESIS_KINDS = ["corpus-observation", "machine-rule", "editorial-guidance"] as const;
const CRITIQUE_KINDS = ["corpus-observation", "screen-observation", "dom-signal", "machine-rule", "editorial-guidance"] as const;
/**
 * The exact evidence vocabulary the create_ui_spec adapter can project from the
 * producer's validated SanitizedEvidence rows: sanitized corpus observations,
 * explicit public references, and the operator-authored recipe. The producer
 * emits no machine-rule or editorial-guidance rows, so neither is accepted.
 */
const CREATE_UI_SPEC_KINDS = ["corpus-observation", "public-reference", "recipe-system"] as const;
/**
 * Evidence kinds that can ground an `editorial`-authority citedDecision.
 * `recipe-system` is the operator-authored deterministic recipe, documented in
 * create-ui-spec-contracts.ts as grounding editorial-authority decisions and
 * never corpus-evidence decisions.
 */
const EDITORIAL_AUTHORITY_KINDS: readonly string[] = ["editorial-guidance", "recipe-system"];

/**
 * The ONLY safe public reference shape create_ui_spec may publish: the opaque
 * SHA-256 digest of the requester's own token, built by the core as
 * `ref-${sha256Hex(...)}` (src/create-ui-spec.ts). Requiring this positively —
 * rather than merely rejecting the response-scoped `evidence-N` shape — is what
 * makes a raw corpus entry ID, a source URL, an image path or any other
 * filesystem path inexpressible in this tool's public reference positions.
 *
 * DELIBERATELY NOT a shared-envelope rule: legacy retrieval tools
 * (search_ui_references, get_ui_reference, browse_ui_patterns, the research
 * aggregations) publish real corpus entry IDs in `referenceIds`, so this shape
 * is enforced only inside the create_ui_spec descriptor's refineEnvelope.
 */
const SAFE_PUBLIC_REFERENCE_ID = /^ref-[0-9a-f]{64}$/;

// ===========================================================================
// The create_ui_spec structural leaf-value gate
// ===========================================================================
//
// WHY THIS EXISTS (and why it is not another per-position check).
//
// Three review rounds on the Task 1 migration each found the same leak class on
// a different axis: round 1 found four of eight reference positions guarded,
// round 2 found one of two branches guarded, round 3 found one of two ID domains
// guarded. Every instance had the same mechanism — a MEMBERSHIP rule written
// where a SHAPE rule was needed, in a hand-maintained list of coordinates over
// {reference domain, evidence domain} x {shape, transitive membership} x {field}.
// A field added by a later task is unprotected by default in that design.
//
// This gate inverts the default. It walks EVERY string leaf reachable under
// `data`, `referenceIds` and `evidence`, classifies each leaf by its normalized
// POSITION, and rejects anything it does not recognize. Adding a field to
// `UiSpec` without classifying its position here fails the suite — which is the
// property none of the three per-position fixes had.
//
// Three classes, and only three:
//   * public evidence ID    — must match RESPONSE_SCOPED_EVIDENCE_ID
//   * safe public reference — must match SAFE_PUBLIC_REFERENCE_ID
//   * free text             — arbitrary, and ONLY at an allowlisted position
//
// The two ID domains stay separate BY CONSTRUCTION: each position demands its
// own shape, so an `evidence-N` in a reference position and a `ref-<sha256>` in
// an evidence-ID position are both rejected. The domains are never unioned.
//
// SCOPED TO create_ui_spec. The legacy retrieval tools publish real corpus entry
// IDs in `referenceIds` and non-response-scoped evidence IDs, so the gate is
// attached to this one descriptor (see `gateResultLeaves`), never to
// `makeEnvelope` for all tools.

/** A normalized leaf position: array indices collapse to `[]`. */
type LeafPosition = string;

/**
 * Positions holding a PUBLIC EVIDENCE ID. Every one is also membership-checked
 * against the envelope's `evidence[].id` set elsewhere; membership guarantees
 * the positions agree, this set guarantees the agreed value is safe.
 */
const CREATE_UI_SPEC_EVIDENCE_ID_LEAVES: ReadonlySet<LeafPosition> = new Set<LeafPosition>([
  "evidence[].id",
  "data.provenance.evidenceIds[]",
  "data.authorityLanes.corpusEvidence[]",
  "data.authorityLanes.machineRules[]",
  "data.authorityLanes.editorialGuidance[]",
  "data.citedDecisions[].evidenceIds[]",
  "data.acceptanceCriteria[].evidenceIds[]",
  // Moved from the safe-reference domain in C3 Phase 1. These cite the
  // response-scoped evidence-N of the corpus entry a technique came from, not
  // a ref-<sha256> digest. Verified before the move: no producer populated
  // sourceIds, so no existing value changes meaning.
  "data.techniques[].sourceIds[]",
  "data.antiPatterns[].sourceIds[]",
]);

/**
 * Positions holding a SAFE PUBLIC REFERENCE — the core's opaque
 * `ref-${sha256Hex(...)}` digest (src/create-ui-spec.ts). These are the six
 * reference-carrying positions enumerated by the round-2 review.
 */
const CREATE_UI_SPEC_SAFE_REFERENCE_LEAVES: ReadonlySet<LeafPosition> = new Set<LeafPosition>([
  "referenceIds[]",
  "data.citedReferences[]",
  "data.provenance.sourceReferences[]",
  "evidence[].referenceId",
  "data.citedDecisions[].sourceId",
  "data.componentInventory[].sourceId",
]);

/**
 * The FREE-TEXT ALLOWLIST: the only positions where an arbitrary string is
 * permitted. Each entry carries the reason arbitrary text is safe there, so a
 * reviewer can audit the whole free-text surface in one place. Nothing outside
 * this record (and the two ID sets above) may hold a string at all.
 *
 * Two recurring reasons, stated per entry rather than by group so an added entry
 * cannot inherit a justification it does not deserve:
 *   (a) CLOSED VOCABULARY — the Zod schema pins the value to a literal or enum,
 *       so "arbitrary" is a formality; the gate simply does not re-encode it.
 *   (b) PROSE — recipe-owned (operator-authored) or requester-owned text that is
 *       descriptive, carries no identity, and is not a corpus projection. The
 *       core bounds every one of these at the producer
 *       (create-ui-spec-contracts.ts); the corpus-derived path additionally
 *       passes SanitizedEvidence, which forbids private identity fields.
 */
/**
 * Exported so a guard test can assert the ANNOTATION TEXT itself is truthful.
 * `classifyCreateUiSpecLeaf` returns immediately for the `free-text` class, so
 * nothing at runtime ever reads these strings — which means an annotation that
 * says "recipe-owned" over a position now carrying caller prose is an authority
 * claim no code path can falsify. See create-ui-spec-intent-guards.test.ts.
 */
export const CREATE_UI_SPEC_FREE_TEXT_LEAVES: Readonly<Record<LeafPosition, string>> = {
  // --- closed vocabularies (reason a) ---
  "data.specVersion": "closed z.literal(\"1.0\")",
  "data.context.platform": "closed enum web|mobile|tablet",
  "data.context.designSystem.status": "closed enum none|identified",
  "data.colorTokenAuthority": "closed TokenAuthority enum",
  "data.typographyTokenAuthority": "closed TokenAuthority enum",
  "data.acceptanceCriteria[].assertion": "closed AcceptanceAssertion enum",
  "data.acceptanceCriteria[].verifier": "closed discriminator literal",
  "data.acceptanceCriteria[].priority": "closed must|should enum",
  "data.context.colorIntent.contrastFloor": "closed AA|AAA enum, caller-selected",
  "data.context.typeIntent.density": "closed compact|regular|spacious enum, caller-selected",
  "data.citedDecisions[].authority": "closed authority enum",
  "data.citedDecisions[].readiness": "closed available|proposed|unavailable enum",
  "evidence[].kind": "closed EvidenceKind enum",
  "evidence[].basis": "closed EvidenceBasis enum",
  "data.provenance.generatedAt": "z.string().datetime() — a timestamp, no identity",
  // --- model-generated proposal content; never accepted into authority ---
  "data.modelProposal.status": "closed proposal-only literal for model-generated content; never accepted into token authority",
  "data.modelProposal.disclaimer": "fixed proposal disclaimer for model-generated content; never accepted into token authority",
  "data.modelProposal.designDirection": "model-generated proposal text; never accepted into token authority",
  "data.modelProposal.motionNotes[]": "model-generated proposal motion text; never accepted into token authority",
  "data.modelProposal.contentVoiceGuidance": "model-generated proposal voice text; never accepted into token authority",
  "data.modelProposal.colorTokens.primary": "model-generated proposal color value; never accepted into token authority",
  "data.modelProposal.colorTokens.surface": "model-generated proposal color value; never accepted into token authority",
  "data.modelProposal.colorTokens.ink": "model-generated proposal color value; never accepted into token authority",
  "data.modelProposal.colorTokens.muted": "model-generated proposal color value; never accepted into token authority",
  "data.modelProposal.colorTokens.accent": "model-generated proposal color value; never accepted into token authority",
  "data.modelProposal.typographyTokens.heading": "model-generated proposal font-family value; never accepted into token authority",
  "data.modelProposal.typographyTokens.body": "model-generated proposal font-family value; never accepted into token authority",
  "data.modelProposal.typographyTokens.mono": "model-generated proposal font-family value; never accepted into token authority",
  // --- requester-owned prose, echoed back to its own author (reason b) ---
  "data.context.productContext": "the caller's own brief, echoed back to the caller; never corpus-derived",
  "data.context.implementationFramework": "caller-supplied framework name",
  "data.context.designSystem.registry": "caller-supplied design-system registry name",
  "data.context.designSystem.library": "caller-supplied design-system library name",
  "data.context.constraints[]": "caller-supplied constraint prose",
  "data.context.colorIntent.accentPreference": "caller-supplied colour intent, echoed back to its own author; never corpus-derived and never materialized into colorTokens",
  "data.context.colorIntent.mood": "caller-supplied colour intent, echoed back to its own author; never corpus-derived and never materialized into colorTokens",
  "data.context.typeIntent.voice": "caller-supplied typography intent, echoed back to its own author; never corpus-derived and never materialized into typographyTokens",
  "data.designDirection": "the caller's own brief restated when no corpus entry matched (recipe lane), or a corpus-grounded direction sentence built from structuredFacts pluralities plus identity-screened corpus signals (style tags, categories, mood, color scheme, type notes, critique) and citing the matched evidence ids; never model output (a model proposal lives at data.modelProposal.designDirection)",
  // --- recipe/operator-owned prose: descriptive, carries no identity (reason b) ---
  "data.rejectedDefaults[]": "recipe-owned prose naming a rejected default",
  "data.layoutRegions[].name": "recipe-owned region label",
  "data.layoutRegions[].type": "recipe-owned region type label",
  "data.layoutRegions[].components[]": "recipe-owned component label",
  "data.layoutRegions[].responsive[]": "recipe-owned responsive-behavior prose",
  "data.responsiveBehavior[]": "recipe-owned responsive-behavior prose",
  "data.componentInventory[].name": "recipe-owned component label",
  "data.componentInventory[].pattern": "recipe-owned pattern label",
  "data.colorTokens.primary": "a color value, not an identity",
  "data.colorTokens.surface": "a color value, not an identity",
  "data.colorTokens.ink": "a color value, not an identity",
  "data.colorTokens.muted": "a color value, not an identity",
  "data.colorTokens.accent": "a color value, not an identity",
  "data.typographyTokens.heading": "a font-family name, not an identity",
  "data.typographyTokens.body": "a font-family name, not an identity",
  "data.typographyTokens.mono": "a font-family name, not an identity",
  "data.interactions[]": "recipe-owned interaction prose",
  "data.motionGuidance.notes[]": "recipe-owned motion prose",
  "data.accessibilityConstraints[]": "corpus-derived accessibility-risk prose, identity-screened",
  "data.contentVoiceGuidance": "corpus-derived voice prose (tone/avoid/examples), identity-screened; examples capped at 3 per response, 20-140 chars, data-only strings rejected",
  "data.techniques[].text": "corpus-derived technique prose, identity-screened and capped at 5 per response; its citation lives in sourceIds (response-scoped evidence ids)",
  "data.antiPatterns[].text": "corpus-derived anti-pattern prose, identity-screened and capped at 5 per response; its citation lives in sourceIds (response-scoped evidence ids)",
  "data.frameworkNotes": "recipe-owned framework prose",
  "data.unavailableDecisions[].field": "names a UiSpec field, response-local",
  "data.unavailableDecisions[].reason": "recipe-owned reason prose",
  "data.acceptanceCriteria[].id": "response-local criterion label from the recipe, or the response-local `caller-constraint-<n>` label",
  "data.acceptanceCriteria[].subject": "recipe-owned subject label, or the caller's own constraint text for `caller-constraint-*` rows",
  "data.acceptanceCriteria[].expectedOutcome": "recipe-owned expectation prose, or prose wrapping the caller's own constraint text for `caller-constraint-*` rows",
  "data.acceptanceCriteria[].selector": "recipe-owned DOM selector for the playwright verifier",
  "data.acceptanceCriteria[].command": "recipe-owned verification command for the static-analysis verifier; operator-authored, never a corpus projection",
  "data.acceptanceCriteria[].manualSteps[]": "recipe-owned manual verification steps, or steps wrapping the caller's own constraint text for `caller-constraint-*` rows",
  "data.citedDecisions[].id": "response-local decision label from the recipe",
  "data.citedDecisions[].field": "names a UiSpec field, response-local",
  "data.provenance.toolVersion": "the recipe version string (e.g. c3-fallback-v1)",
  // Production-reachable since Task 2: the ONE projection
  // (`projectSanitizedEvidenceToMcpEvidence` in create-ui-spec-contracts.ts)
  // carries this value through from a core SanitizedEvidence row and re-parses
  // BOTH sides — SanitizedEvidenceSchema in, shared `Evidence` out.
  //
  // ENFORCED, and by which layer. `SanitizedEvidenceSchema` (create-ui-spec-
  // contracts.ts) is the enforcing layer for all three of these, at construction
  // AND again on the projection's inbound re-parse:
  //   1. length — `z.string().trim().min(1).max(500)`;
  //   2. no private identity FIELD — `.strict()` refuses
  //      privateCorpusId/sourceUrl/screenshot/corpusId on the row;
  //   3. no private CONTENT in this string — the schema's superRefine rejects the
  //      row when `containsPrivateMarker(summary)` holds (private corpus id
  //      markers, `.c2-private/`, `/corpus/private/`, `images-private/`) or when
  //      the summary matches SafeErrorMessage's PATH_OR_URL_PATTERN (any path
  //      separator, `://`, `node_modules`, `dist/`, `private`, `corpus-`).
  // The leaf gate itself checks NOTHING here — "free-text" returns immediately —
  // so (3) is the reason a poisoned summary cannot reach this position, not the
  // gate.
  //
  // INTENDED, not enforced (stated in those words deliberately): that the value is
  // recipe-owned TEMPLATE text. Today it is, by producer convention — the only
  // three sources are `buildCorpusObservationSummary` (a fixed template over the
  // closed StructuredFacts allowlist), the frozen recipe row's own string, and the
  // fixed explicit-reference string.
  // Nothing prevents a future builder from interpolating a corpus-derived value
  // that happens to carry none of the screened markers (e.g. a title fragment).
  // The screen bounds the leak CLASS; provenance is still the builder's
  // responsibility, and a new summary builder must be reviewed as such.
  "evidence[].summary": "SanitizedEvidence summary — bounded at 500 chars, refused a private identity field by .strict(), and content-screened for private-corpus markers, paths and urls by SanitizedEvidenceSchema's superRefine; that it is recipe-owned template prose is a producer convention, not an enforced bound",
};

/** The three classes. There is no fourth, and there is no default. */
type CreateUiSpecLeafClass = "public-evidence-id" | "safe-public-reference" | "free-text";

function classifyCreateUiSpecLeaf(position: LeafPosition): CreateUiSpecLeafClass | undefined {
  if (CREATE_UI_SPEC_EVIDENCE_ID_LEAVES.has(position)) return "public-evidence-id";
  if (CREATE_UI_SPEC_SAFE_REFERENCE_LEAVES.has(position)) return "safe-public-reference";
  if (Object.prototype.hasOwnProperty.call(CREATE_UI_SPEC_FREE_TEXT_LEAVES, position)) return "free-text";
  return undefined;
}

/**
 * One rejected leaf. `message` NEVER reproduces the offending value: the
 * envelope is refused, so an error string that repeated a private path would be
 * the only channel through which that path still reached the caller.
 */
export interface UnsafeResultLeaf {
  /** The normalized position (array indices as `[]`) — stable across indices. */
  readonly position: LeafPosition;
  /** The concrete Zod issue path, with real indices. */
  readonly path: PropertyKey[];
  /** Position-naming, value-free message. */
  readonly message: string;
}

/**
 * Depth beyond which the walker refuses rather than recurses. `UiSpec` is a
 * closed, finite-depth object (its deepest string leaf is four keys down), so
 * exceeding this means the value is not the shape the gate was written for —
 * and the fail-closed answer is to reject, not to stop looking.
 */
const MAX_LEAF_DEPTH = 12;

/**
 * The gate. Walks every string leaf under `data`, `referenceIds` and `evidence`
 * and returns one entry per leaf that is not provably safe.
 *
 * Pure: it takes the three roots and returns violations, so it can be exercised
 * directly against a SIMULATED future field (which `.strict()` makes
 * unreachable through the schema) as well as through the envelope.
 */
export function findUnsafeCreateUiSpecLeaves(roots: {
  data: unknown;
  referenceIds: unknown;
  evidence: unknown;
}): UnsafeResultLeaf[] {
  const found: UnsafeResultLeaf[] = [];

  const checkString = (value: string, position: LeafPosition, path: PropertyKey[]): void => {
    switch (classifyCreateUiSpecLeaf(position)) {
      case "public-evidence-id":
        if (!RESPONSE_SCOPED_EVIDENCE_ID.test(value))
          found.push({ position, path, message: `${position} must be a response-scoped public evidence ID (evidence-N); the offending value is withheld from this message` });
        return;
      case "safe-public-reference":
        if (!SAFE_PUBLIC_REFERENCE_ID.test(value))
          found.push({ position, path, message: `${position} must be a safe public reference ID (ref-<sha256>); the offending value is withheld from this message` });
        return;
      case "free-text":
        return;
      default:
        // FAIL CLOSED. A string at a position nobody classified is refused, so a
        // field added by a later task cannot publish anything until its position
        // is deliberately declared above.
        found.push({ position, path, message: `${position} is not a classified create_ui_spec output position — declare it as a public evidence ID, a safe public reference, or explicit free text before it can be published; the offending value is withheld from this message` });
    }
  };

  const visit = (value: unknown, position: LeafPosition, path: PropertyKey[], depth: number): void => {
    if (depth > MAX_LEAF_DEPTH) {
      found.push({ position, path, message: `${position} exceeds the maximum inspected depth for create_ui_spec output` });
      return;
    }
    if (typeof value === "string") { checkString(value, position, path); return; }
    if (Array.isArray(value)) {
      value.forEach((item, i) => visit(item, `${position}[]`, [...path, i], depth + 1));
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const [key, child] of Object.entries(value as Record<string, unknown>))
        visit(child, `${position}.${key}`, [...path, key], depth + 1);
      return;
    }
    // numbers, booleans, null and undefined carry no text and cannot leak.
  };

  visit(roots.data, "data", ["data"], 0);
  visit(roots.referenceIds, "referenceIds", ["referenceIds"], 0);
  visit(roots.evidence, "evidence", ["evidence"], 0);
  return found;
}

// ===========================================================================
// The create_ui_spec CITATION-CONSISTENCY predicate
// ===========================================================================
//
// WHY IT IS A STANDALONE EXPORT AND NOT SIX INLINE CHECKS.
//
// These six rules lived inline in the create_ui_spec descriptor's
// `refineEnvelope` below. `refineEnvelope` is invoked from `makeEnvelope`, which
// only `parseToolResult` reaches — so they ran on the MCP transport and on NO
// screen of the loopback HTTP route (create-ui-spec-http.ts), which serves the
// persisted `DesignArtifactEnvelope` itself and therefore cannot use
// `parseToolResult` at all. Every input the six read is present in the body that
// route serves, so `POST /api/create-ui-spec` could return a design handoff whose
// `techniques[].sourceIds`, `antiPatterns[].sourceIds`,
// `componentInventory[].sourceId` or `provenance.sourceReferences` disagreed with
// `citedReferences` — refused over MCP, served with 200 to a browser. Two
// independent reviewers rated that P1.
//
// The ID-SHAPE half of that asymmetry was already closed by giving the HTTP
// adapter the same leaf gate above. This closes the CITATION half the same way:
// ONE implementation, called from both transports, so a rule cannot be enforced
// on one surface and not the other. It is a PREDICATE, not a refinement — it
// takes a value and returns violations, with no dependency on zod, on the tool
// envelope, or on which transport is asking. Each transport then does what it
// does with a violation: `refineEnvelope` turns it into a zod issue at
// `["data", ...specPath]`; the HTTP adapter throws and serves nothing.
//
// IT VALIDATES AND REFUSES. It never rewrites, reorders or normalizes anything —
// which is what makes it compatible with the adjudicated constraint that the HTTP
// surface serves the persisted envelope byte-identically. On the success path it
// returns `[]` and changes no byte.
//
// SCOPE. Exactly the four rules, no more: uniqueness of `citedReferences`,
// membership of `componentInventory[].sourceId` in `citedReferences`, uniqueness
// of `provenance.sourceReferences`, and set-equality of
// `provenance.sourceReferences` with `citedReferences`. ID SHAPE is the leaf
// gate's job (above). Evidence-ID membership — including
// `techniques[].sourceIds[]` / `antiPatterns[].sourceIds[]`, which moved to the
// evidence-id domain in C3 Phase 1 (Task 2) — evidence-KIND authority and the
// lane rules stay in `refineEnvelope`, because they read the tool envelope's
// `evidence[]` rows — which do not exist on the HTTP surface, so they are
// structurally inapplicable there rather than missing.

/** The four rules, as stable ids. A transport may name these in a refusal. */
export type CreateUiSpecCitationRule =
  | "citedReferences-unique"
  | "componentInventory-sourceId-cited"
  | "provenance-sourceReferences-unique"
  | "provenance-sourceReferences-match-citedReferences";

/**
 * One citation-consistency violation. Like {@link UnsafeResultLeaf}, `message`
 * NEVER reproduces the offending value: both transports refuse the response, so
 * an error string that repeated the value would be the only channel through which
 * it still reached a caller.
 */
export interface CreateUiSpecCitationInconsistency {
  /** Which of the four rules failed — stable, value-free, safe to publish. */
  readonly rule: CreateUiSpecCitationRule;
  /**
   * The path of the offending field RELATIVE TO THE SPEC (no transport prefix),
   * so each transport can map it into its own coordinate space — `refineEnvelope`
   * prefixes `"data"`, the HTTP adapter has no prefix to add.
   */
  readonly specPath: readonly PropertyKey[];
  /**
   * The position-naming, value-free message. Byte-identical to what the four
   * inline checks emitted before the extraction, because the MCP issue messages
   * are a published contract that the drift gates pin.
   */
  readonly message: string;
}

/**
 * The predicate. Pure: takes a (possibly malformed, possibly untrusted) value and
 * returns one entry per citation-consistency violation.
 *
 * TOLERANT OF A MALFORMED SHAPE, DELIBERATELY. The HTTP adapter runs this on the
 * RAW re-parsed served bytes, BEFORE `parseDesignArtifactEnvelope` has vouched for
 * the shape, so a non-object `spec` or a non-array `techniques` must not make it
 * throw. It reports nothing in that case and the envelope schema — which runs
 * immediately afterwards on both transports — is what refuses a malformed shape.
 * That keeps the overall gate fail-closed without this function having to
 * duplicate the schema.
 */
export function findCreateUiSpecCitationInconsistencies(
  spec: unknown,
): CreateUiSpecCitationInconsistency[] {
  const found: CreateUiSpecCitationInconsistency[] = [];
  const data = spec as
    | {
        citedReferences?: unknown;
        techniques?: unknown;
        antiPatterns?: unknown;
        componentInventory?: unknown;
        provenance?: { sourceReferences?: unknown };
      }
    | null
    | undefined;
  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

  const citedRefs = asArray(data?.citedReferences);
  const citedSet = new Set(citedRefs);
  if (citedSet.size !== citedRefs.length)
    found.push({
      rule: "citedReferences-unique",
      specPath: ["citedReferences"],
      message: "citedReferences must be unique",
    });

  for (const comp of asArray(data?.componentInventory)) {
    const sourceId = (comp as { sourceId?: unknown } | null)?.sourceId;
    if (sourceId !== undefined && !citedSet.has(sourceId))
      found.push({
        rule: "componentInventory-sourceId-cited",
        specPath: ["componentInventory"],
        message: "componentInventory[].sourceId not in citedReferences (value withheld)",
      });
  }

  // The dedup check runs BEFORE the set compare — the Set-based comparison below
  // collapses duplicates, so without this it would silently accept [ref, ref].
  const sourceRefsRaw = asArray(data?.provenance?.sourceReferences);
  const sourceRefs = new Set(sourceRefsRaw);
  if (sourceRefs.size !== sourceRefsRaw.length)
    found.push({
      rule: "provenance-sourceReferences-unique",
      specPath: ["provenance"],
      message: "provenance.sourceReferences must be unique",
    });
  if (sourceRefs.size !== citedSet.size || ![...sourceRefs].every((id) => citedSet.has(id)))
    found.push({
      rule: "provenance-sourceReferences-match-citedReferences",
      specPath: ["provenance"],
      message: "provenance.sourceReferences must exactly match citedReferences",
    });

  return found;
}

/**
 * Prose rows for the §5.5 per-tool contract reference. These mirror the
 * authoritative human wording in the design spec; the mechanical renderer in
 * tool-contract-docs.ts emits them verbatim. Keep concise and factual — do not
 * invent contract facts not already stated by the schema or spec.
 */
export interface ToolContractDocs {
  /** Human-readable input field summary (e.g. "query?, category?, ..."). */
  readonly input: string;
  /** Shape of the success `data` payload, naming the key fields. */
  readonly successData: string;
  /** Empty-result contract (n/a for single-id lookups). */
  readonly empty: string;
  /** Partial-result contract (warnings / degraded coverage). */
  readonly partial: string;
  /** resultCount semantics, as prose. */
  readonly resultCount: string;
  /** referenceIds semantics, as prose. */
  readonly referenceIds: string;
}

export interface ToolDescriptor {
  readonly name: string;
  readonly rendererKey: string;
  readonly hasEvidence: boolean;
  readonly legacyNames: readonly string[];
  readonly inputSchema: z.ZodType;
  readonly dataSchema: z.ZodType;
  readonly retrieval: readonly { mode: string; modality: string; fallbackReasons?: readonly string[] }[];
  /** Allowed attempted-mode values for terminal errors and fallback records. */
  readonly allowedAttemptedModes: readonly string[];
  /**
   * Retrieval-capable tools normally cannot report `mode: "none"` with a
   * positive `resultCount` — for a search-shaped tool that combination claims
   * results that nothing retrieved. Set this ONLY for a tool whose single result
   * artifact exists independently of automatic retrieval, so `none/none` with
   * one artifact is the truthful state (create_ui_spec's explicit-reference
   * path: the requester supplied the references, so no retrieval ran).
   *
   * Omitted (or false) preserves the original rule exactly.
   */
  readonly allowNoneWithPositiveResult?: boolean;
  /**
   * Tools whose result may carry a model-execution state. Set ONLY for a tool
   * with a model lane. Omitted (or false) keeps the original key set exactly.
   */
  readonly hasModelExecutionState?: boolean;
  readonly evidenceKinds: readonly string[];
  readonly warningSchema: z.ZodType;
  readonly errorSchema: z.ZodType;
  /**
   * The literal error codes this tool may emit, as a readonly tuple. This is
   * the TYPE-LEVEL source for per-tool error inference (the `errorSchema`
   * field is typed `z.ZodType` for structural use and would widen the literal
   * `retryable` binding). Order is preserved for deterministic docs output.
   */
  readonly errorCodes: readonly ErrorCode[];
  /** Authoritative §5.5 prose rows — drives renderToolContractReference(). */
  readonly contractDocs: ToolContractDocs;
  /**
   * Extract PRIMARY IDs from `data` — keys that must be unique across the
   * result (e.g. search result row IDs, browse patternType, compare entry IDs).
   * Duplicate non-empty primary IDs are rejected by the envelope validator.
   * Return `[]` for tools whose rows only reference (not own) their IDs.
   */
  extractPrimaryIds: (data: unknown) => readonly string[];
  /**
   * Extract REFERENCED IDs from `data` — IDs that rows cite but do not own
   * (e.g. sourceIds across aggregation rows). A single referenced ID MAY
   * legitimately appear in multiple rows; duplicates are collapsed before the
   * reference-set-equality check. Compared as a set against `referenceIds`.
   */
  extractReferenceIds: (data: unknown) => readonly string[];
  countResults: (data: unknown) => number;
  refineData?: (data: unknown, ctx: z.RefinementCtx) => void;
  /** Envelope-level refinement — has access to warnings, evidence, referenceIds. */
  refineEnvelope?: (val: { data: unknown; warnings: unknown[]; referenceIds: string[]; evidence?: unknown[]; retrievalInfo?: { mode: string; fallbackUsed: boolean } }, ctx: z.RefinementCtx) => void;
  /**
   * Structural leaf-value gate over every string leaf under `data`,
   * `referenceIds` and `evidence`. Unlike `refineData`/`refineEnvelope` (rules
   * 12-13, which only run on the success branch) this is invoked on EVERY
   * branch, before any status branch is entered — no branch condition can skip
   * it. Returns one entry per unsafe or UNCLASSIFIED leaf; makeEnvelope turns
   * each into an issue verbatim, so the gate owns the message wording and can
   * guarantee no offending value is echoed.
   */
  readonly gateResultLeaves?: (roots: { data: unknown; referenceIds: unknown; evidence: unknown }) => readonly UnsafeResultLeaf[];
}

export const TOOL_DESCRIPTORS = [
  {
    name: "search_ui_references",
    rendererKey: "search",
    hasEvidence: false,
    legacyNames: ["search_ui_examples"],
    inputSchema: SearchInput,
    dataSchema: z.object({ results: z.array(ReferenceSummary) }).strict(),
    retrieval: [
      { mode: "hybrid", modality: "text" },
      { mode: "vector", modality: "text" },
      { mode: "keyword", modality: "text", fallbackReasons: ["missing-index", "incompatible-index", "missing-provider-key", "provider-error"] },
      { mode: "keyword", modality: "metadata", fallbackReasons: ["missing-index", "incompatible-index", "missing-provider-key", "provider-error"] },
      { mode: "structured-fallback", modality: "metadata", fallbackReasons: ["missing-index", "incompatible-index", "missing-provider-key", "community-edition", "provider-error", "no-results"] },
      { mode: "none", modality: "none" },
    ],
    allowedAttemptedModes: ["hybrid", "vector", "keyword", "structured-fallback"],
    evidenceKinds: [],
    warningSchema: makeWarningSchema(["sparseCoverage", "keywordFallback"]),
    errorSchema: makeErrorSchema(["NOT_FOUND", "PROVIDER_ERROR"]),
    errorCodes: ["NOT_FOUND", "PROVIDER_ERROR"],
    contractDocs: {
      input: "query?, category?, styleTag?, patternType?, minQuality (1-5)?, qualityTier?, reviewStatus?, platform?, limit (1-20, default 5)?, responseFormat?",
      successData: "`results: ReferenceSummary[]` — each with id, title, product, patternType, categories, styleTags, qualityScore, qualityTier, source (productName, url required-but-nullable, imageAvailable), critique excerpt, topTechniques, antiPatterns",
      empty: "`results: []`, retrieval none, resultCount 0, summary guidance",
      partial: "sparseCoverage / keywordFallback typed warnings on degraded retrieval",
      resultCount: "`results.length`",
      referenceIds: "unique `result.id` values",
    },
    extractPrimaryIds: (d) => {
      const r = (d as { results?: Array<{ id?: string }> })?.results ?? [];
      return r.map(e => e.id).filter((x): x is string => !!x);
    },
    extractReferenceIds: (d) => {
      const r = (d as { results?: Array<{ id?: string }> })?.results ?? [];
      return r.map(e => e.id).filter((x): x is string => !!x);
    },
    countResults: (d) => (d as { results?: unknown[] })?.results?.length ?? 0,
  },
  {
    name: "get_ui_reference",
    rendererKey: "reference",
    hasEvidence: false,
    legacyNames: ["get_ui_example"],
    inputSchema: IdInput,
    dataSchema: FullReference,
    retrieval: [{ mode: "none", modality: "none" }],
    allowedAttemptedModes: [],
    evidenceKinds: [],
    warningSchema: makeWarningSchema([]),
    errorSchema: makeErrorSchema(["NOT_FOUND"]),
    errorCodes: ["NOT_FOUND"],
    contractDocs: {
      input: "id (required)",
      successData: "full reference record: id, title, product, patternType, categories, styleTags, qualityScore, qualityTier, platform, layout, visual attributes, accessibility, critique, techniques, antiPatterns, source, image availability",
      empty: "n/a — single-id lookup",
      partial: "n/a — single-id lookup",
      resultCount: "1 on success, 0 on error",
      referenceIds: "`[id]` on success, `[]` on error",
    },
    extractPrimaryIds: (d) => { const id = (d as { id?: string })?.id; return id ? [id] : []; },
    extractReferenceIds: (d) => { const id = (d as { id?: string })?.id; return id ? [id] : []; },
    countResults: (d) => (d as { id?: unknown })?.id ? 1 : 0,
  },
  {
    name: "find_similar_ui_references",
    rendererKey: "similar",
    hasEvidence: false,
    legacyNames: ["get_similar_ui_examples"],
    inputSchema: SimilarInput,
    dataSchema: z.object({ results: z.array(SimilarReference) }).strict(),
    retrieval: [
      { mode: "vector", modality: "text" },
      { mode: "structured-fallback", modality: "metadata", fallbackReasons: ["missing-index", "incompatible-index", "missing-provider-key", "community-edition", "provider-error", "no-results"] },
      { mode: "none", modality: "none" },
    ],
    allowedAttemptedModes: ["vector", "structured-fallback"],
    evidenceKinds: [],
    warningSchema: makeWarningSchema(["keywordFallback", "sparseCoverage"]),
    errorSchema: makeErrorSchema(["NOT_FOUND", "PROVIDER_ERROR"]),
    errorCodes: ["NOT_FOUND", "PROVIDER_ERROR"],
    contractDocs: {
      input: "id (required), limit (1-20, default 5)?",
      successData: "`results: SimilarReference[]` — each with id, title, product, patternType, categories, styleTags, score, basis, critique, techniques",
      empty: "`results: []` when no index or source not found",
      partial: "keywordFallback / sparseCoverage typed warnings on degraded retrieval",
      resultCount: "`results.length`",
      referenceIds: "unique `result.id` values",
    },
    extractPrimaryIds: (d) => {
      const r = (d as { results?: Array<{ id?: string }> })?.results ?? [];
      return r.map(e => e.id).filter((x): x is string => !!x);
    },
    extractReferenceIds: (d) => {
      const r = (d as { results?: Array<{ id?: string }> })?.results ?? [];
      return r.map(e => e.id).filter((x): x is string => !!x);
    },
    countResults: (d) => (d as { results?: unknown[] })?.results?.length ?? 0,
  },
  {
    name: "compare_ui_references",
    rendererKey: "compare",
    hasEvidence: false,
    legacyNames: ["compare_ui_examples"],
    inputSchema: CompareInput,
    dataSchema: z.object({
      entries: z.array(ComparisonRow),
      foundIds: z.array(z.string()),
      missingIds: z.array(z.string()),
    }).strict(),
    retrieval: [{ mode: "none", modality: "none" }],
    allowedAttemptedModes: [],
    evidenceKinds: [],
    warningSchema: makeWarningSchema(["partialResult"]),
    errorSchema: makeErrorSchema(["NOT_FOUND"]),
    errorCodes: ["NOT_FOUND"],
    contractDocs: {
      input: "ids (required, 2-3 unique), responseFormat?",
      successData: "`entries: ComparisonRow[]`, `foundIds`, `missingIds` — each row with id, title, product, patternType, categories, styleTags, platform, layout, accent, density, corners, quality, critiqueAngle, topTechnique, antiPatterns, whereItFails, accessibility",
      empty: "n/a — all IDs missing is an error (NOT_FOUND), not an empty success",
      partial: "`missingIds` non-empty + typed partialResult warning when some IDs not found",
      resultCount: "`foundIds.length`",
      referenceIds: "`foundIds`",
    },
    extractPrimaryIds: (d) => (d as { entries?: Array<{ id?: string }> })?.entries?.map(e => e.id).filter((x): x is string => !!x) ?? [],
    extractReferenceIds: (d) => (d as { foundIds?: string[] })?.foundIds ?? [],
    countResults: (d) => (d as { foundIds?: unknown[] })?.foundIds?.length ?? 0,
    refineData: (d, ctx) => {
      const data = d as { foundIds?: string[]; missingIds?: string[]; entries?: Array<{ id?: string }> };
      const found = data.foundIds ?? [];
      const missing = data.missingIds ?? [];
      // Unique foundIds
      if (new Set(found).size !== found.length)
        ctx.addIssue({ code: "custom", message: "foundIds must be unique", path: ["foundIds"] });
      // Unique missingIds
      if (new Set(missing).size !== missing.length)
        ctx.addIssue({ code: "custom", message: "missingIds must be unique", path: ["missingIds"] });
      // Disjoint
      const overlap = found.filter(id => missing.includes(id));
      // foundIds must be non-empty (all-missing is an error, not a success)
      if (found.length === 0)
        ctx.addIssue({ code: "custom", message: "foundIds must be non-empty (all-missing must be an error)", path: ["foundIds"] });
      if (overlap.length > 0)
        ctx.addIssue({ code: "custom", message: `IDs in both foundIds and missingIds: ${overlap.join(", ")}`, path: ["foundIds"] });
      // entries IDs must exactly equal foundIds (same set, same count)
      const entryIds = (data.entries ?? []).map(e => e.id).filter((x): x is string => !!x);
      if (entryIds.length !== found.length || !entryIds.every(id => found.includes(id)))
        ctx.addIssue({ code: "custom", message: "entries IDs must exactly match foundIds", path: ["entries"] });
      // partialResult warning required when missingIds is nonempty
      // (checked at envelope level via refineEnvelope)
    },
    refineEnvelope: (val, ctx) => {
      const data = val.data as { missingIds?: string[] };
      const missing = data?.missingIds ?? [];
      const warnings = val.warnings as Array<{ code?: string }>;
      const hasPartial = warnings.some(w => w.code === "partialResult");
      if (missing.length > 0 && !hasPartial)
        ctx.addIssue({ code: "custom", message: "missingIds nonempty requires partialResult warning", path: ["warnings"] });
      if (missing.length === 0 && hasPartial)
        ctx.addIssue({ code: "custom", message: "partialResult warning requires nonempty missingIds", path: ["warnings"] });
    },
  },
  {
    name: "get_ui_taxonomy",
    rendererKey: "taxonomy",
    hasEvidence: false,
    legacyNames: ["list_categories", "list_style_tags", "list_domain_tags"],
    inputSchema: z.object({}).strict(),
    dataSchema: z.object({
      patternTypes: TaxonomyList, categories: TaxonomyList, styleTags: TaxonomyList,
      components: TaxonomyList.optional(), domainTags: TaxonomyList.optional(),
    }).strict(),
    retrieval: [{ mode: "none", modality: "none" }],
    allowedAttemptedModes: [],
    evidenceKinds: [],
    warningSchema: makeWarningSchema([]),
    errorSchema: makeErrorSchema([]),
    errorCodes: [],
    contractDocs: {
      input: "none",
      successData: "`patternTypes`, `categories`, `styleTags` (each `{count, values}`), optional `components`, `domainTags`",
      empty: "n/a — always returns the taxonomy",
      partial: "n/a",
      resultCount: "0 (not a search tool)",
      referenceIds: "`[]`",
    },
    extractPrimaryIds: () => [],
    extractReferenceIds: () => [],
    countResults: () => 0,
    refineData: (d, ctx) => {
      const data = d as Record<string, { count?: number; values?: string[] } | undefined>;
      for (const [key, list] of Object.entries(data)) {
        if (!list) continue;
        // count must equal unique values length
        if (list.count !== undefined && list.values !== undefined) {
          const unique = new Set(list.values);
          if (list.count !== unique.size)
            ctx.addIssue({ code: "custom", message: `${key}.count (${list.count}) must equal unique values length (${unique.size})`, path: [key, "count"] });
          if (unique.size !== list.values.length)
            ctx.addIssue({ code: "custom", message: `${key}.values contains duplicates`, path: [key, "values"] });
        }
      }
    },
  },
  {
    name: "browse_ui_patterns",
    rendererKey: "browse",
    hasEvidence: false,
    legacyNames: ["browse_ui_examples"],
    inputSchema: z.object({ styleTag: StyleTag.optional() }).strict(),
    dataSchema: z.object({ patterns: z.array(PatternGroup) }).strict(),
    retrieval: [{ mode: "none", modality: "none" }],
    allowedAttemptedModes: [],
    evidenceKinds: [],
    warningSchema: makeWarningSchema(["sparseCoverage"]),
    errorSchema: makeErrorSchema([]),
    errorCodes: [],
    contractDocs: {
      input: "styleTag?",
      successData: "`patterns: PatternGroup[]` — each with patternType, count, topProducts (array), exemplar (id, title, product, qualityScore, critique)",
      empty: "`patterns: []`",
      partial: "sparseCoverage typed warning on thin coverage",
      resultCount: "number of rows returned (`patterns.length`)",
      referenceIds: "exemplar IDs",
    },
    extractPrimaryIds: (d) => {
      const p = (d as { patterns?: Array<{ patternType?: string }> })?.patterns ?? [];
      return p.map(g => g.patternType).filter((x): x is string => !!x);
    },
    extractReferenceIds: (d) => {
      const p = (d as { patterns?: Array<{ exemplar?: { id?: string } }> })?.patterns ?? [];
      return p.map(g => g.exemplar?.id).filter((x): x is string => !!x);
    },
    countResults: (d) => (d as { patterns?: unknown[] })?.patterns?.length ?? 0,
  },
  {
    name: "plan_ui_direction",
    rendererKey: "plan",
    hasEvidence: true,
    legacyNames: ["recommend_ui_direction"],
    inputSchema: PlanInput,
    dataSchema: PlanDataSchema,
    retrieval: [
      { mode: "hybrid", modality: "text" },
      { mode: "keyword", modality: "text", fallbackReasons: ["missing-index", "incompatible-index", "missing-provider-key", "provider-error"] },
      { mode: "keyword", modality: "metadata", fallbackReasons: ["missing-index", "incompatible-index", "missing-provider-key", "provider-error"] },
      { mode: "structured-fallback", modality: "metadata", fallbackReasons: ["missing-index", "incompatible-index", "missing-provider-key", "community-edition", "provider-error", "no-results"] },
      { mode: "none", modality: "none" },
    ],
    allowedAttemptedModes: ["hybrid", "keyword", "structured-fallback"],
    evidenceKinds: [...ALL_SYNTHESIS_KINDS],
    warningSchema: makeWarningSchema(["sparseCoverage", "insufficientCorpusEvidence", "noCorpusIndex"]),
    errorSchema: makeErrorSchema(["PROVIDER_ERROR"]),
    errorCodes: ["PROVIDER_ERROR"],
    contractDocs: {
      input: "productContext (required, min 8), category?, styleTag?, platform?, qualityTier? (default exceptional), framework? (brief/tokens), count (1-5, default 3)?",
      successData: "`direction`, `rejectedDefaults`, `recommendation`, `rationale`, `evidenceContributions`, `structuredDecisions`",
      empty: "n/a — absence of index degrades through fallback, not an empty success",
      partial: "sparseCoverage / insufficientCorpusEvidence / noCorpusIndex typed warnings on sparse results",
      resultCount: "1 when a complete plan artifact exists, otherwise 0",
      referenceIds: "grounding entry IDs (`evidenceContributions`)",
    },
    extractPrimaryIds: () => [],
    extractReferenceIds: (d) => (d as { evidenceContributions?: string[] })?.evidenceContributions ?? [],
    countResults: (d) => (d as { direction?: unknown })?.direction ? 1 : 0,
    refineEnvelope: (val, ctx) => {
      const knownEvidence = new Set<string>(((val.evidence as Array<{ id?: string }> | undefined)?.map(e => e.id).filter((x): x is string => !!x)) ?? []);
      const data = val.data as { structuredDecisions?: Array<{ evidenceIds?: string[] }> };
      // Membership + within-list dedup + empty/whitespace checks in one call.
      const sdRefs = (data.structuredDecisions ?? []).flatMap((sd, i) =>
        [{ path: ["data", "structuredDecisions", i, "evidenceIds"] as PropertyKey[], ids: sd.evidenceIds ?? [] }]);
      validateEvidenceReferences(knownEvidence, sdRefs, ctx);
    },
  },
  {
    name: "create_ui_spec",
    rendererKey: "spec",
    hasEvidence: true,
    legacyNames: ["generate_design_prompt"],
    inputSchema: CreateUiSpecInput,
    dataSchema: UiSpec,
    // The producer's real states: automatic retrieval is keyword/metadata; zero
    // matches are the structured fallback with the honest "no-results" reason;
    // explicit references run no retrieval at all (none/none). hybrid/text is
    // the enriched primary path. The adapter reports the producer's actual
    // state — it never normalizes one state into another.
    retrieval: [
      { mode: "hybrid", modality: "text" },
      { mode: "keyword", modality: "metadata" },
      { mode: "structured-fallback", modality: "metadata", fallbackReasons: ["no-results"] },
      { mode: "none", modality: "none" },
    ],
    allowedAttemptedModes: ["keyword"],
    // none/none carries one spec artifact on the explicit-reference path.
    allowNoneWithPositiveResult: true,
    // The model lane projects its safe execution state; no other tool does.
    hasModelExecutionState: true,
    // Exactly the kinds the adapter can project from validated SanitizedEvidence.
    evidenceKinds: [...CREATE_UI_SPEC_KINDS],
    warningSchema: makeWarningSchema(["sparseCoverage", "insufficientCorpusEvidence", "motionEvidenceUnavailable", "authorityConflict"]),
    // Core INVALID_INPUT maps to the non-retryable MCP INVALID_INPUT; core
    // RETRIEVAL_UNAVAILABLE maps to the existing retryable PROVIDER_ERROR. No
    // new transport error code, and no raw core message is exposed.
    errorSchema: makeErrorSchema(["INVALID_INPUT", "PROVIDER_ERROR"]),
    errorCodes: ["INVALID_INPUT", "PROVIDER_ERROR"],
    contractDocs: {
      input: "productContext (required, min 8, max 8000), referenceIds? (max 5, each max 200), platform?, implementationFramework? (max 120), designSystem?, constraints? (max 12, each max 500), target? (neutral-web | astro-react | astro-vue), motionIntents? (max 8, structured), outputFormat (markdown | json, default markdown)?",
      successData: "see §5.4 — UiSpec with layoutRegions, colorTokens, typographyTokens, acceptanceCriteria (verifiers: axe, playwright, static-analysis, manual), citedReferences, citedDecisions, authorityLanes, provenance",
      empty: "n/a — synthesis produces one spec artifact or errors",
      partial: "sparseCoverage / insufficientCorpusEvidence / motionEvidenceUnavailable typed warnings; zero automatic matches are reported as structured-fallback/metadata with fallbackReason \"no-results\"; null tokens require editorial authority + unavailableDecision",
      resultCount: "1 when a complete spec artifact exists, otherwise 0",
      referenceIds: "`citedReferences` only — safe public reference IDs. Response-scoped evidence IDs (`evidence-N`) are a separate domain and never appear here",
    },
    extractPrimaryIds: () => [],
    // The structural leaf-value gate: every string leaf under data/referenceIds/
    // evidence must be a classified position, and must satisfy that position's
    // shape. Attached here (not in makeEnvelope) because the legacy retrieval
    // tools legitimately publish raw corpus entry IDs and non-response-scoped
    // evidence IDs.
    gateResultLeaves: findUnsafeCreateUiSpecLeaves,
    // ONLY citedReferences. Evidence IDs live in a separate domain (provenance,
    // authority lanes, evidence rows) and must never become referenceIds.
    extractReferenceIds: (d) => (d as { citedReferences?: string[] })?.citedReferences ?? [],
    countResults: (d) => (d as { specVersion?: unknown })?.specVersion ? 1 : 0,
    refineEnvelope: (val, ctx) => {
      const data = val.data as {
        acceptanceCriteria?: Array<{ id?: string; evidenceIds?: string[] }>;
        citedDecisions?: Array<{ id?: string; evidenceIds?: string[]; sourceId?: string }>;
        provenance?: { evidenceIds?: string[]; sourceReferences?: string[] };
        citedReferences?: string[];
        authorityLanes?: { corpusEvidence?: string[]; machineRules?: string[]; editorialGuidance?: string[] };
        // `techniques` and `antiPatterns` are read here ONLY for their
        // sourceIds evidence membership (moved to the evidence-id domain in C3
        // Phase 1 Task 2); their prose fields are free-text leaves and are not
        // validated here. `componentInventory` is deliberately absent: the only
        // rule that reads it is the citation-consistency predicate, which
        // `findCreateUiSpecCitationInconsistencies` owns for both transports
        // (see the delegation at the end of this block).
        techniques?: Array<{ sourceIds?: string[] }>;
        antiPatterns?: Array<{ sourceIds?: string[] }>;
        motionGuidance?: { evidenceUnavailable?: boolean };
      };
      // Motion warning coupling: evidenceUnavailable ↔ motionEvidenceUnavailable
      const motionUnavailable = data.motionGuidance?.evidenceUnavailable === true;
      const hasMotionWarn = (val.warnings as Array<{ code?: string }>).some(w => w.code === "motionEvidenceUnavailable");
      if (motionUnavailable && !hasMotionWarn)
        ctx.addIssue({ code: "custom", message: "motionGuidance.evidenceUnavailable requires motionEvidenceUnavailable warning", path: ["warnings"] });
      if (!motionUnavailable && hasMotionWarn)
        ctx.addIssue({ code: "custom", message: "motionEvidenceUnavailable warning requires motionGuidance.evidenceUnavailable", path: ["warnings"] });
      // Authoritative evidence set: envelope evidence ONLY (not provenance)
      const knownEvidence = new Set<string>();
      for (const e of (val.evidence as Array<{ id?: string }> | undefined) ?? [])
        if (e.id) knownEvidence.add(e.id);
      // Cited references set
      const citedSet = new Set(data?.citedReferences ?? []);
      const citedRefs = data?.citedReferences ?? [];
      // NOTE: `citedReferences` UNIQUENESS is no longer checked here. It is one of
      // the four CITATION-CONSISTENCY rules now owned by the shared predicate
      // `findCreateUiSpecCitationInconsistencies` (above), which BOTH transports
      // call — see the delegation at the end of this block. The message and path it
      // emits are byte-identical to what this line emitted.
      // ID-domain separation: citedReferences (and therefore the envelope's
      // referenceIds, which must equal them as sets) hold safe PUBLIC REFERENCE
      // ids only. A response-scoped public evidence id substituted here would
      // conflate the two domains.
      // Beyond that, a public reference must POSITIVELY be a safe public
      // reference: the core's opaque `ref-<sha256>` digest. Anything else — a raw
      // corpus entry ID, a source URL, an image or filesystem path — is refused
      // here so it can never be expressed in this tool's success-envelope
      // reference positions, even if a projection bug upstream tries to publish
      // it. (The status "error" branch has its own, narrower guard: see the
      // "status error requires empty evidence" check above, which is what makes
      // this positive claim true for the error branch too — by forbidding
      // evidence outright rather than by re-running this check.) The offending
      // value is NOT echoed into the issue message: the message would itself
      // become output carrying the path.
      //
      // TASK 1b: these three per-position checks are now ALSO covered, on every
      // branch and in all eight reference positions, by the structural leaf gate
      // (`findUnsafeCreateUiSpecLeaves`, rule 0 in makeEnvelope). They are kept
      // deliberately, not left by oversight: the gate reports "position X must be
      // a safe public reference", while these distinguish the two ID domains in
      // the message ("...is a response-scoped evidence ID, not a public reference
      // ID"), which is diagnostically different information. Removing them would
      // need an equivalence proof the gate cannot give.
      citedRefs.forEach((ref, i) => {
        if (RESPONSE_SCOPED_EVIDENCE_ID.test(ref))
          ctx.addIssue({ code: "custom", message: `citedReference "${ref}" is a response-scoped evidence ID, not a public reference ID`, path: ["data", "citedReferences", i] });
        else if (!SAFE_PUBLIC_REFERENCE_ID.test(ref))
          ctx.addIssue({ code: "custom", message: `citedReferences[${i}] is not a safe public reference ID (expected ref-<sha256>)`, path: ["data", "citedReferences", i] });
      });
      val.referenceIds.forEach((ref, i) => {
        if (RESPONSE_SCOPED_EVIDENCE_ID.test(ref))
          ctx.addIssue({ code: "custom", message: `referenceId "${ref}" is a response-scoped evidence ID, not a public reference ID`, path: ["referenceIds", i] });
        else if (!SAFE_PUBLIC_REFERENCE_ID.test(ref))
          ctx.addIssue({ code: "custom", message: `referenceIds[${i}] is not a safe public reference ID (expected ref-<sha256>)`, path: ["referenceIds", i] });
      });
      // Every evidence row's public citation is checked at the row level too:
      // rule 10 only ties it to referenceIds (set membership), which would pass a
      // whole envelope whose referenceIds are themselves unsafe. (The shared
      // Evidence schema separately refuses the `evidence-N` shape here.)
      ((val.evidence as Array<{ referenceId?: string }> | undefined) ?? []).forEach((e, i) => {
        if (e.referenceId !== undefined && !SAFE_PUBLIC_REFERENCE_ID.test(e.referenceId))
          ctx.addIssue({ code: "custom", message: `evidence[${i}].referenceId is not a safe public reference ID (expected ref-<sha256>)`, path: ["evidence", i, "referenceId"] });
      });
      // Check acceptance criteria evidenceIds (membership + dedup) — whole-array form
      const acRefs = (data?.acceptanceCriteria ?? []).map((ac, i) =>
        ({ path: ["data", "acceptanceCriteria", i, "evidenceIds"] as PropertyKey[], ids: ac.evidenceIds ?? [] }),
      );
      validateEvidenceReferences(knownEvidence, acRefs, ctx);
      // Check citedDecisions evidenceIds (membership + dedup) — whole-array form
      const cdRefs = (data?.citedDecisions ?? []).map((cd, i) =>
        ({ path: ["data", "citedDecisions", i, "evidenceIds"] as PropertyKey[], ids: cd.evidenceIds ?? [] }),
      );
      validateEvidenceReferences(knownEvidence, cdRefs, ctx);
      // Check techniques/antiPatterns sourceIds (membership + dedup). These
      // positions moved from the safe-reference domain to the evidence-id
      // domain in C3 Phase 1 (Task 2): they cite the response-scoped
      // evidence-N of the corpus entry a technique came from, not a
      // ref-<sha256> digest, so membership is against the envelope's evidence
      // rows rather than citedReferences. The shape half is the leaf gate's
      // job (evidence-N); this is the membership half.
      const techRefs = (data?.techniques ?? []).map((t, i) =>
        ({ path: ["data", "techniques", i, "sourceIds"] as PropertyKey[], ids: t.sourceIds ?? [] }),
      );
      const apRefs = (data?.antiPatterns ?? []).map((a, i) =>
        ({ path: ["data", "antiPatterns", i, "sourceIds"] as PropertyKey[], ids: a.sourceIds ?? [] }),
      );
      validateEvidenceReferences(knownEvidence, [...techRefs, ...apRefs], ctx);
      for (const cd of data?.citedDecisions ?? []) {
        if (cd.sourceId !== undefined && !citedSet.has(cd.sourceId))
          ctx.addIssue({ code: "custom", message: `citedDecisions[].sourceId not in citedReferences (value withheld)`, path: ["data", "citedDecisions"] });
      }
      // Check authorityLanes evidence IDs (membership + dedup)
      const lanes = data?.authorityLanes;
      if (lanes) {
        validateEvidenceReferences(knownEvidence, [
          { path: ["data", "authorityLanes", "corpusEvidence"], ids: lanes.corpusEvidence ?? [] },
          { path: ["data", "authorityLanes", "machineRules"], ids: lanes.machineRules ?? [] },
          { path: ["data", "authorityLanes", "editorialGuidance"], ids: lanes.editorialGuidance ?? [] },
        ], ctx);
      }
      // --- R4: Evidence-kind authority prerequisites. ---
      // The envelope evidence[] array is the authority for evidence KINDS. The
      // authorityLanes are a partition of evidence IDs, but a lying partition
      // (e.g. an editorial-guidance-kind evidence item placed in the corpusEvidence
      // lane) must NOT authorize a corpus-evidence decision. For each citedDecision,
      // verify BOTH that at least one referenced evidence item has the kind matching
      // the claimed authority AND that the referenced evidence ID sits in the lane
      // matching that authority. The lane-membership checks in UiSpec.superRefine
      // cover the lane side; here we verify the kind side and the lane/kind agreement
      // (a corpus-observation item placed in the editorial lane is an inconsistency).
      const evidenceKindById = new Map<string, string>();
      for (const e of (val.evidence as Array<{ id?: string; kind?: string }> | undefined) ?? [])
        if (e.id) evidenceKindById.set(e.id, e.kind ?? "");
      const corpusLane = new Set(lanes?.corpusEvidence ?? []);
      const editorialLane = new Set(lanes?.editorialGuidance ?? []);
      for (const cd of (data?.citedDecisions as Array<{ id?: string; authority?: string; evidenceIds?: string[] }> | undefined) ?? []) {
        const evIds = cd.evidenceIds ?? [];
        if (cd.authority === "corpus-evidence") {
          // At least one referenced evidence item must be kind corpus-observation.
          const hasCorpusKind = evIds.some(eid => evidenceKindById.get(eid) === "corpus-observation");
          if (!hasCorpusKind)
            ctx.addIssue({ code: "custom", message: `citedDecision "${cd.id}" has corpus-evidence authority but no referenced evidence of kind corpus-observation`, path: ["data", "citedDecisions"] });
          // Lane/kind consistency: every referenced corpus-observation evidence must
          // sit in the corpusEvidence lane (a corpus item in the editorial lane is an
          // inconsistent partition).
          for (const eid of evIds) {
            if (evidenceKindById.get(eid) === "corpus-observation" && !corpusLane.has(eid))
              ctx.addIssue({ code: "custom", message: `citedDecision "${cd.id}" references a corpus-observation evidence ID (position citedDecisions[].evidenceIds[], value withheld) that is not in the corpusEvidence lane`, path: ["data", "citedDecisions"] });
          }
        } else if (cd.authority === "editorial") {
          // At least one referenced evidence item must carry an editorial-grounding
          // kind (editorial-guidance, or the operator-authored recipe-system).
          const hasEditorialKind = evIds.some(eid => EDITORIAL_AUTHORITY_KINDS.includes(evidenceKindById.get(eid) ?? ""));
          if (!hasEditorialKind)
            ctx.addIssue({ code: "custom", message: `citedDecision "${cd.id}" has editorial authority but no referenced evidence of kind ${EDITORIAL_AUTHORITY_KINDS.join(" or ")}`, path: ["data", "citedDecisions"] });
          // Lane/kind consistency: every referenced editorial-grounding evidence
          // must sit in the editorialGuidance lane.
          for (const eid of evIds) {
            const kind = evidenceKindById.get(eid);
            if (kind !== undefined && EDITORIAL_AUTHORITY_KINDS.includes(kind) && !editorialLane.has(eid))
              ctx.addIssue({ code: "custom", message: `citedDecision "${cd.id}" references a ${kind} evidence ID (position citedDecisions[].evidenceIds[], value withheld) that is not in the editorialGuidance lane`, path: ["data", "citedDecisions"] });
            // Corpus-lane agreement, the mirror of the corpus-evidence branch: a
            // corpus observation may never CO-ground an editorial decision. Having
            // one editorial-grounding row present is not a licence to also cite
            // corpus-derived evidence under editorial authority — that is exactly
            // the laundering direction the R4 checks exist to prevent, and it is
            // rejected regardless of which lane the corpus row sits in.
            if (kind === "corpus-observation")
              ctx.addIssue({ code: "custom", message: `citedDecision "${cd.id}" has editorial authority but references a corpus-observation evidence ID (position citedDecisions[].evidenceIds[], value withheld)`, path: ["data", "citedDecisions"] });
          }
        }
      }
      // Lane partition integrity: corpus-derived evidence never belongs in the
      // editorialGuidance lane, whether or not any decision cites it. The real
      // producer partitions the recipe row and public references into that lane
      // and corpus observations into corpusEvidence (src/create-ui-spec.ts).
      for (const eid of editorialLane) {
        if (evidenceKindById.get(eid) === "corpus-observation")
          ctx.addIssue({ code: "custom", message: `a corpus-observation evidence ID must not be partitioned into the editorialGuidance lane (position authorityLanes.editorialGuidance[], value withheld)`, path: ["data", "authorityLanes", "editorialGuidance"] });
      }
      // --- R4 Part C: same-field conflicting authority lanes require an
      // authorityConflict warning. Two citedDecisions for the SAME exact field
      // but DIFFERENT authority constitute a conflict; the artifact must declare
      // an authorityConflict warning. A spurious authorityConflict warning with no
      // underlying conflict is also rejected. ---
      const conflictFields = new Set<string>();
      const fieldAuthorities = new Map<string, Set<string>>();
      for (const cd of (data?.citedDecisions as Array<{ field?: string; authority?: string }> | undefined) ?? []) {
        if (!cd.field || !cd.authority) continue;
        let auths = fieldAuthorities.get(cd.field);
        if (!auths) { auths = new Set<string>(); fieldAuthorities.set(cd.field, auths); }
        auths.add(cd.authority);
      }
      for (const [field, auths] of fieldAuthorities) {
        if (auths.size > 1) conflictFields.add(field);
      }
      const warnings = val.warnings as Array<{ code?: string }>;
      const hasConflictWarn = warnings.some(w => w.code === "authorityConflict");
      if (conflictFields.size > 0 && !hasConflictWarn)
        ctx.addIssue({ code: "custom", message: `citedDecisions have conflicting authority lanes for field(s): ${[...conflictFields].join(", ")} — requires authorityConflict warning`, path: ["warnings"] });
      if (conflictFields.size === 0 && hasConflictWarn)
        ctx.addIssue({ code: "custom", message: "authorityConflict warning present but no citedDecisions have conflicting authority lanes", path: ["warnings"] });
      // provenance.evidenceIds must match envelope evidence IDs exactly (derived echo, not authority)
      const provEvIds = data?.provenance?.evidenceIds ?? [];
      if (new Set(provEvIds).size !== provEvIds.length)
        ctx.addIssue({ code: "custom", message: "provenance.evidenceIds must be unique", path: ["data", "provenance"] });
      const provenanceEvIds = new Set(provEvIds);
      if (provenanceEvIds.size !== knownEvidence.size || ![...provenanceEvIds].every(id => knownEvidence.has(id)))
        ctx.addIssue({ code: "custom", message: "provenance.evidenceIds must exactly match envelope evidence IDs", path: ["data", "provenance"] });
      // --- The FOUR CITATION-CONSISTENCY rules, delegated to the SHARED predicate. ---
      // `citedReferences` uniqueness, the `componentInventory[].sourceId`
      // membership rule, and both `provenance.sourceReferences` rules used to be
      // written out inline here. They
      // now come from `findCreateUiSpecCitationInconsistencies`, which the loopback
      // HTTP adapter (create-ui-spec-http.ts) also calls — that is the whole point
      // of the extraction: `refineEnvelope` is reachable only through
      // `parseToolResult`, so anything written inline here is an MCP-only rule, and
      // these four read nothing but fields the HTTP surface also publishes.
      //
      // The messages and the `["data", ...]` paths are byte-identical to the inline
      // versions; only the emission ORDER changed (the four are now contiguous, so
      // `citedReferences must be unique` is reported after the evidence rules rather
      // than before them). No test asserts a cross-rule ordering, and every poison
      // whose message list is asserted exactly produces a single issue.
      for (const violation of findCreateUiSpecCitationInconsistencies(val.data)) {
        ctx.addIssue({ code: "custom", message: violation.message, path: ["data", ...violation.specPath] });
      }
    },
  },
  {
    name: "research_ui_anti_patterns",
    rendererKey: "anti-patterns",
    hasEvidence: false,
    legacyNames: ["get_anti_patterns"],
    inputSchema: AntiPatternInput,
    dataSchema: z.object({ results: z.array(AntiPatternRow) }).strict(),
    retrieval: [{ mode: "none", modality: "none" }],
    allowedAttemptedModes: [],
    evidenceKinds: [],
    warningSchema: makeWarningSchema(["sparseCoverage"]),
    errorSchema: makeErrorSchema([]),
    errorCodes: [],
    contractDocs: {
      input: "patternType?, category?, limit (1-20, default 10)?",
      successData: "`results: AntiPatternRow[]` — each with text, sourceIds, count",
      empty: "`results: []`",
      partial: "sparseCoverage typed warning on thin coverage",
      resultCount: "number of rows returned (`results.length`)",
      referenceIds: "unique sourceIds across all rows",
    },
    extractPrimaryIds: () => [],
    extractReferenceIds: (d) => {
      const r = (d as { results?: Array<{ sourceIds?: string[] }> })?.results ?? [];
      return r.flatMap(e => e.sourceIds ?? []);
    },
    countResults: (d) => (d as { results?: unknown[] })?.results?.length ?? 0,
  },
  {
    name: "research_ui_palettes",
    rendererKey: "palettes",
    hasEvidence: false,
    legacyNames: ["get_color_palette"],
    inputSchema: PaletteInput,
    dataSchema: z.object({ results: z.array(PaletteRecord) }).strict(),
    retrieval: [{ mode: "none", modality: "none" }],
    allowedAttemptedModes: [],
    evidenceKinds: [],
    warningSchema: makeWarningSchema(["sparseCoverage"]),
    errorSchema: makeErrorSchema([]),
    errorCodes: [],
    contractDocs: {
      input: "patternType?, styleTag?, limit (1-20, default 10)?",
      successData: "`results: PaletteRecord[]` — each with tokens (canvas, surface, ink, muted, accent), accentHue, product, sourceId, patternType",
      empty: "`results: []`",
      partial: "sparseCoverage typed warning on thin coverage",
      resultCount: "number of rows returned (`results.length`)",
      referenceIds: "unique sourceId values",
    },
    extractPrimaryIds: () => [],
    extractReferenceIds: (d) => {
      const r = (d as { results?: Array<{ sourceId?: string }> })?.results ?? [];
      return r.map(e => e.sourceId).filter((x): x is string => !!x);
    },
    countResults: (d) => (d as { results?: unknown[] })?.results?.length ?? 0,
  },
  {
    name: "research_ui_techniques",
    rendererKey: "techniques",
    hasEvidence: false,
    legacyNames: ["get_stealable_techniques"],
    inputSchema: TechniqueInput,
    dataSchema: z.object({ results: z.array(TechniqueRow) }).strict(),
    retrieval: [{ mode: "none", modality: "none" }],
    allowedAttemptedModes: [],
    evidenceKinds: [],
    warningSchema: makeWarningSchema(["sparseCoverage"]),
    errorSchema: makeErrorSchema([]),
    errorCodes: [],
    contractDocs: {
      input: "patternType?, styleTag?, limit (1-30, default 15)?",
      successData: "`results: TechniqueRow[]` — each with text, source (id, product)",
      empty: "`results: []`",
      partial: "sparseCoverage typed warning on thin coverage",
      resultCount: "number of rows returned (`results.length`)",
      referenceIds: "unique source IDs",
    },
    extractPrimaryIds: () => [],
    extractReferenceIds: (d) => {
      const r = (d as { results?: Array<{ source?: { id?: string } }> })?.results ?? [];
      return r.map(e => e.source?.id).filter((x): x is string => !!x);
    },
    countResults: (d) => (d as { results?: unknown[] })?.results?.length ?? 0,
  },
  {
    name: "critique_ui",
    rendererKey: "critique",
    hasEvidence: true,
    legacyNames: [],
    inputSchema: CRITIQUE_UI_INPUT_SCHEMA,
    dataSchema: CritiqueDataSchema,
    retrieval: [
      { mode: "vector", modality: "image" },
      { mode: "structured-fallback", modality: "metadata", fallbackReasons: ["missing-index", "incompatible-index", "missing-provider-key", "community-edition", "provider-error", "no-image-evidence", "no-results"] },
      { mode: "none", modality: "none" },
    ],
    allowedAttemptedModes: ["vector", "structured-fallback"],
    evidenceKinds: [...CRITIQUE_KINDS],
    warningSchema: makeWarningSchema(["insufficientCorpusEvidence", "providerDegraded"]),
    errorSchema: makeErrorSchema(["PROVIDER_ERROR", "INVALID_INPUT"]),
    errorCodes: ["PROVIDER_ERROR", "INVALID_INPUT"],
    contractDocs: {
      input: "image_data (required), image_mime_type (required), product_context?, platform?, framework? — reuses `CRITIQUE_UI_INPUT_SCHEMA` from `synthesis/contracts.ts`",
      successData: "reuses `StructuredCritique` fields: observations, recommendations, accessibilityRisks, visualSlop, motion, appliedReferences, evidenceIds, confidence, md3?",
      empty: "n/a — synthesis produces one critique artifact or errors",
      partial: "insufficientCorpusEvidence / providerDegraded typed warnings; may include screen-observation and dom-signal evidence",
      resultCount: "1 when a complete critique artifact exists, otherwise 0",
      referenceIds: "appliedReference IDs",
    },
    extractPrimaryIds: () => [],
    extractReferenceIds: (d) => ((d as { appliedReferences?: Array<{ id?: string }> })?.appliedReferences ?? []).map(r => r.id).filter((x): x is string => !!x),
    countResults: (d) => (d as { summary?: unknown })?.summary ? 1 : 0,
    refineEnvelope: (val, ctx) => {
      const evidenceIds = new Set<string>(((val.evidence as Array<{ id?: string }> | undefined)?.map(e => e.id).filter((x): x is string => !!x)) ?? []);
      const data = val.data as {
        retrievalMode?: string;
        fallbackUsed?: boolean;
        evidenceIds?: string[];
        appliedReferences?: Array<{ id?: string; version?: number; purpose?: string }>;
        recommendations?: Array<{ evidence?: string[] }>;
        accessibilityRisks?: Array<{ evidence?: string }>;
        visualSlop?: Array<{ evidence?: string[] }>;
        motion?: Array<{ evidence?: string[]; reference?: string }>;
        md3?: { evidenceIds?: string[]; conflictingSignals?: Array<{ evidenceId?: string }> };
      };
      // Reconcile data.retrievalMode with envelope retrieval.mode
      if (data.retrievalMode !== undefined && data.retrievalMode !== val.retrievalInfo?.mode)
        ctx.addIssue({ code: "custom", message: `data.retrievalMode "${data.retrievalMode}" must match envelope retrieval mode`, path: ["data"] });
      // Reconcile data.fallbackUsed with envelope fallback
      if (data.fallbackUsed !== undefined && data.fallbackUsed !== val.retrievalInfo?.fallbackUsed)
        ctx.addIssue({ code: "custom", message: "data.fallbackUsed must match envelope fallback state", path: ["data"] });
      // Check duplicate appliedReferences IDs
      const appliedIds = (data.appliedReferences ?? []).map(r => r.id).filter(Boolean) as string[];
      if (new Set(appliedIds).size !== appliedIds.length)
        ctx.addIssue({ code: "custom", message: "appliedReferences must have unique IDs", path: ["data", "appliedReferences"] });
      // Check top-level evidenceIds match envelope evidence exactly
      const critiqueEvIds = new Set(data.evidenceIds ?? []);
      if (critiqueEvIds.size !== evidenceIds.size || ![...critiqueEvIds].every(id => evidenceIds.has(id)))
        ctx.addIssue({ code: "custom", message: "data.evidenceIds must exactly match envelope evidence IDs", path: ["data"] });
      // Check all nested evidence paths (membership + dedup) via shared validator
      validateEvidenceReferences(evidenceIds, [
        ...(data.recommendations ?? []).flatMap((rec, i) =>
          [{ path: ["data", "recommendations", i, "evidence"] as PropertyKey[], ids: rec.evidence ?? [] }]),
        ...(data.accessibilityRisks ?? []).map((risk, i) =>
          ({ path: ["data", "accessibilityRisks", i, "evidence"] as PropertyKey[], ids: risk.evidence ? [risk.evidence] : [] })),
        ...(data.visualSlop ?? []).flatMap((vs, i) =>
          [{ path: ["data", "visualSlop", i, "evidence"] as PropertyKey[], ids: vs.evidence ?? [] }]),
        ...(data.motion ?? []).flatMap((m, i) =>
          [{ path: ["data", "motion", i, "evidence"] as PropertyKey[], ids: m.evidence ?? [] }]),
        { path: ["data", "md3", "evidenceIds"] as PropertyKey[], ids: data.md3?.evidenceIds ?? [] },
        ...(data.md3?.conflictingSignals ?? []).map((cs, i) =>
          ({ path: ["data", "md3", "conflictingSignals", i, "evidenceId"] as PropertyKey[], ids: cs.evidenceId ? [cs.evidenceId] : [] })),
      ], ctx);
      // Check motion.reference ref:<id> form
      const refIds = new Set(val.referenceIds);
      for (const m of data.motion ?? []) {
        if (m.reference && m.reference.startsWith("ref:")) {
          const refId = m.reference.slice(4);
          if (!refIds.has(refId))
            ctx.addIssue({ code: "custom", message: `motion reference "${m.reference}" not found in referenceIds`, path: ["data", "motion"] });
        }
      }
    },
  },
] as const satisfies readonly ToolDescriptor[];

// ===========================================================================
// 8. Derived values
// ===========================================================================

export const TOOL_CATALOG = Object.freeze(
  TOOL_DESCRIPTORS.map(d => d.name),
) as readonly ToolName[];

export type ToolName = (typeof TOOL_DESCRIPTORS)[number]["name"];

export const LEGACY_TO_BETA_MAP: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    TOOL_DESCRIPTORS.flatMap(d => d.legacyNames.map(l => [l, d.name] as const)),
  ),
);

export const REMOVED_TOOL_NAMES: readonly string[] = Object.freeze(
  Array.from(new Set(TOOL_DESCRIPTORS.flatMap(d => d.legacyNames))).sort(),
);

export const ALLOWED_RETRIEVAL_STATES: Readonly<Record<string, readonly { mode: string; modality: string }[]>> = Object.freeze(
  Object.fromEntries(TOOL_DESCRIPTORS.map(d => [d.name, d.retrieval] as const)),
);

// Exact-keyed schema maps — preserve per-tool literal type inference
type DescriptorEntry = (typeof TOOL_DESCRIPTORS)[number];
type DescriptorFor<N extends ToolName> = Extract<DescriptorEntry, { name: N }>;

export type ToolInputSchemaMap = { [N in ToolName]: DescriptorFor<N>["inputSchema"] };
export type ToolDataSchemaMap = { [N in ToolName]: DescriptorFor<N>["dataSchema"] };

export const ToolInputSchemas = Object.fromEntries(
  TOOL_DESCRIPTORS.map(d => [d.name, d.inputSchema]),
) as ToolInputSchemaMap;

export const ToolDataSchemas = Object.fromEntries(
  TOOL_DESCRIPTORS.map(d => [d.name, d.dataSchema]),
) as ToolDataSchemaMap;

export type ToolInputByName<N extends ToolName> = z.infer<ToolInputSchemaMap[N]>;
export type ToolDataByName<N extends ToolName> = z.infer<ToolDataSchemaMap[N]>;

/**
 * Per-tool error variant map. Each tool's literal `errorCodes` tuple selects
 * the precise discriminated-union of `{ code, message, retryable }` variants,
 * with `code` AND `retryable` as literals (e.g. NOT_FOUND ⇒ retryable:false).
 * Derived from `DescriptorFor<N>["errorCodes"]` (the type-level source) rather
 * than the `z.ZodType`-widened `errorSchema`, so the literal binding survives.
 */
type ErrorVariantForCode<C extends ErrorCode> = z.infer<(typeof ERROR_VARIANTS)[C]>;
type ErrorVariantUnion<N extends ToolName> =
  DescriptorFor<N>["errorCodes"] extends readonly [infer Only extends ErrorCode]
    ? ErrorVariantForCode<Only>
    : DescriptorFor<N>["errorCodes"] extends readonly [infer A extends ErrorCode, ...infer Rest extends ErrorCode[]]
      ? ErrorVariantForCode<A | Rest[number]>
      : never;
export type ToolErrorByName<N extends ToolName> = ErrorVariantUnion<N>;

/**
 * Per-tool result type. The `error` field is overridden with the literal
 * `ToolErrorByName<N>` union (optional) so that, e.g.,
 * `ToolResultByName<"get_ui_reference">["error"]` carries `retryable: false`
 * for NOT_FOUND — `retryable: true` is a compile error. The rest of the
 * envelope (status/data/retrieval/warnings/evidence) comes from the
 * descriptor-derived `ToolResultSchemaMap[N]`.
 */
export type ToolResultByName<N extends ToolName> =
  Omit<z.infer<ToolResultSchemaMap[N]>, "error"> & { error?: ToolErrorByName<N> };

export function getToolDataSchema(tool: string): z.ZodType | undefined {
  return (ToolDataSchemas as Record<string, z.ZodType>)[tool];
}

export function getToolEvidenceRequired(tool: string): boolean {
  return TOOL_DESCRIPTORS.find(d => d.name === tool)?.hasEvidence ?? false;
}

// --- Canonical catalog digest ---

export const CATALOG_DIGEST: string = createHash("sha256").update(
  JSON.stringify(
    TOOL_DESCRIPTORS.map(d => ({
      name: d.name, rendererKey: d.rendererKey, hasEvidence: d.hasEvidence,
      legacyNames: [...d.legacyNames],
    })),
  ),
).digest("hex");

/**
 * Build a RetrievalPolicy from a descriptor's retrieval array + allowedAttemptedModes.
 * Per-state fallback reasons are descriptor-owned (each retrieval entry carries its own
 * fallbackReasons array). Primary states have no fallbackReasons (undefined/empty).
 */
function buildRetrievalPolicy(desc: ToolDescriptor): RetrievalPolicy {
  return {
    states: desc.retrieval.map(r => ({
      mode: r.mode as never,
      modality: r.modality as never,
      fallbackReasons: (r.fallbackReasons ?? []) as never[],
    })),
    attemptedModes: desc.allowedAttemptedModes as never[],
  };
}

// ===========================================================================
// makeEnvelope — ONE canonical per-tool Zod schema with ALL refinements
// ===========================================================================

function makeEnvelope<const D extends ToolDescriptor>(desc: D) {
  return z.object({
    tool: z.literal(desc.name),
    schemaVersion: z.literal("1.0"),
    status: z.enum(["ok", "error"]),
    summary: z.string().trim().min(1),
    data: desc.dataSchema.nullable(),
    referenceIds: z.array(z.string().min(1)),
    retrieval: RetrievalState,
    warnings: desc.warningSchema,
    // Non-evidence tools must not include the evidence property at all (not even [])
    evidence: desc.hasEvidence ? EvidenceArray : z.never().optional(),
    modelExecutionState: desc.hasModelExecutionState
      ? ModelExecutionStateSchema.nullable()
      : z.never().optional(),
    error: desc.errorSchema.optional(),
  }).strict().superRefine((val, ctx) => {
    // 0. Structural leaf-value gate. Runs FIRST and OUTSIDE every status branch,
    // so neither the ok nor the error branch can skip it and no future branch
    // condition can either. Fail-closed: an unclassified string position is
    // rejected. On the error branch `data` is null and both containers are
    // forced empty (rules 2/2b below), so the walk finds nothing there — but it
    // still runs, which is what keeps that branch closed if a container rule is
    // ever relaxed.
    if (desc.gateResultLeaves) {
      for (const leaf of desc.gateResultLeaves({
        data: val.data,
        referenceIds: val.referenceIds,
        evidence: val.evidence,
      })) {
        ctx.addIssue({ code: "custom", message: leaf.message, path: leaf.path });
      }
    }
    // 1. status ok → non-null data, no error
    if (val.status === "ok") {
      if (val.data === null)
        ctx.addIssue({ code: "custom", message: 'status "ok" requires non-null data', path: ["data"] });
      if (val.error !== undefined)
        ctx.addIssue({ code: "custom", message: 'status "ok" must not have error', path: ["error"] });
    }
    // 2. status error → null data, error present, resultCount 0
    if (val.status === "error") {
      if (val.data !== null)
        ctx.addIssue({ code: "custom", message: 'status "error" requires null data', path: ["data"] });
      if (val.error === undefined)
        ctx.addIssue({ code: "custom", message: 'status "error" requires error', path: ["error"] });
      if (val.retrieval.resultCount !== 0)
        ctx.addIssue({ code: "custom", message: 'status "error" requires resultCount 0', path: ["retrieval", "resultCount"] });
      // Error envelopes must have empty referenceIds
      if (val.referenceIds.length > 0)
        ctx.addIssue({ code: "custom", message: 'status "error" requires empty referenceIds', path: ["referenceIds"] });
      // Error envelopes must have empty evidence. Rules 4-13 below (including
      // refineEnvelope, the safe-public-reference checks and the per-tool
      // evidenceKinds check) only run when status is "ok" — without this check
      // an error envelope's evidence array would be a second, unguarded channel
      // for a private path, a source URL, a raw corpus ID or an out-of-vocabulary
      // evidence kind. Every existing error fixture already uses evidence: [],
      // so this is non-breaking.
      if (desc.hasEvidence && val.evidence && val.evidence.length > 0)
        ctx.addIssue({ code: "custom", message: 'status "error" requires empty evidence', path: ["evidence"] });
    }
    // 2b. Retrieval-capable tools: mode "none" on success requires resultCount 0
    // (none-only tools like get/compare/taxonomy legitimately have none+count 1)
    const isRetrievalCapable = desc.retrieval.length > 1 || (desc.retrieval.length === 1 && desc.retrieval[0]!.mode !== "none");
    if (val.status === "ok" && isRetrievalCapable && desc.allowNoneWithPositiveResult !== true
      && val.retrieval.mode === "none" && val.retrieval.resultCount > 0)
      ctx.addIssue({ code: "custom", message: "retrieval-capable tool cannot have mode none with positive resultCount on success", path: ["retrieval"] });
    // 3. Retrieval eligibility + fallback truth + attempted-mode policy
    // Delegate to the shared integrity validator for complete checks
    validateEnvelopeRetrieval(
      val.status,
      {
        mode: val.retrieval.mode,
        modality: val.retrieval.modality,
        resultCount: val.retrieval.resultCount,
        fallbackUsed: val.retrieval.fallbackUsed,
        attemptedCount: val.retrieval.attemptedCount,
        fallbackReason: val.retrieval.fallbackReason,
        attemptedModes: val.retrieval.attemptedModes,
      },
      buildRetrievalPolicy(desc),
      ctx,
    );

    if (val.status === "ok" && val.data !== null) {
      // 4. resultCount
      const expected = desc.countResults(val.data);
      if (val.retrieval.resultCount !== expected)
        ctx.addIssue({ code: "custom", message: `resultCount: claims ${val.retrieval.resultCount}, actual ${expected}`, path: ["retrieval", "resultCount"] });

      // 5. unique referenceIds
      if (new Set(val.referenceIds).size !== val.referenceIds.length)
        ctx.addIssue({ code: "custom", message: "referenceIds must be unique", path: ["referenceIds"] });

      // 6. Descriptor-driven primary/reference ID separation.
      // PRIMARY IDs are keys owned by rows (search result ids, browse patternType,
      // compare entry ids, get record id) and must be unique across the result.
      // REFERENCED IDs are cited-but-not-owned (sourceIds across aggregation rows);
      // a single referenced ID MAY legitimately appear in multiple rows, so dups
      // are collapsed via unique() before the set comparison against referenceIds.
      const primaryIds = desc.extractPrimaryIds(val.data);
      const primarySet = new Set(primaryIds);
      if (primarySet.size !== primaryIds.length)
        ctx.addIssue({ code: "custom", message: "data contains duplicate primary IDs", path: ["data"] });

      const dataRefs = unique([...desc.extractReferenceIds(val.data)]);
      if (!sameSet(dataRefs, val.referenceIds)) {
        ctx.addIssue({ code: "custom", message: "referenceIds must exactly match data IDs (as sets)", path: ["referenceIds"] });
      }

      // 7. evidence eligibility already enforced by schema shape
      // 8. unique evidence IDs already enforced by EvidenceArray
      // 9. evidence kind per tool
      if (desc.hasEvidence && val.evidence) {
        for (let i = 0; i < val.evidence.length; i++) {
          const ev = val.evidence[i]!;
          if (!desc.evidenceKinds.includes(ev.kind))
            ctx.addIssue({ code: "custom", message: `evidence kind "${ev.kind}" not allowed for ${desc.name}`, path: ["evidence", i, "kind"] });
          // 10. evidence referenceId membership
          if (ev.referenceId && !val.referenceIds.includes(ev.referenceId))
            ctx.addIssue({ code: "custom", message: `evidence[${i}].referenceId not in referenceIds (value withheld)`, path: ["evidence", i, "referenceId"] });
        }
        // 11. empty evidence requires insufficientCorpusEvidence warning
        if (val.evidence.length === 0) {
          const hasInsufficiency = (val.warnings as Array<{ code?: string }>).some(w => w.code === "insufficientCorpusEvidence" || w.code === "sparseCoverage");
          if (!hasInsufficiency)
            ctx.addIssue({ code: "custom", message: "empty evidence requires insufficientCorpusEvidence or sparseCoverage warning", path: ["warnings"] });
        }
      }

      // 12. per-tool data refinement
      if (desc.refineData) desc.refineData(val.data, ctx);

      // 13. per-tool envelope refinement (warnings, evidence cross-checks)
      if (desc.refineEnvelope) desc.refineEnvelope(
        { data: val.data, warnings: val.warnings as unknown[], referenceIds: val.referenceIds, evidence: val.evidence as unknown[] | undefined, retrievalInfo: { mode: val.retrieval.mode, fallbackUsed: val.retrieval.fallbackUsed } },
        ctx,
      );
    }
  });
}

// Exact-keyed result-schema map — each entry carries its per-tool literal
// envelope type (makeEnvelope is generic over the descriptor). This preserves
// per-tool inference of `data`, `error`, `warnings`, etc., so
// ToolResultByName<N> resolves to the REAL envelope instead of collapsing to
// `unknown` (the prior bug from annotating makeEnvelope's return as z.ZodType).
export type ToolResultSchemaMap = { [N in ToolName]: ReturnType<typeof makeEnvelope<DescriptorFor<N>>> };

export const ToolResultSchemas = Object.fromEntries(
  TOOL_DESCRIPTORS.map(d => [d.name, makeEnvelope(d)]),
) as ToolResultSchemaMap;

// ===========================================================================
// 9. parseToolResult — thin dispatcher
// ===========================================================================

export interface ParseResult { ok: boolean; errors: string[] }

export function parseToolResult(raw: unknown): ParseResult {
  const tool = (raw as Record<string, unknown> | null)?.tool;
  if (!tool || typeof tool !== "string" || !(tool in ToolResultSchemas))
    return { ok: false, errors: [`unknown tool "${tool ?? ""}"`] };
  const schema = (ToolResultSchemas as Record<string, z.ZodType>)[tool]!;
  const parse = schema.safeParse(raw);
  return parse.success
    ? { ok: true, errors: [] }
    : { ok: false, errors: parse.error.issues.map((i: { path: PropertyKey[]; message: string }) => `${i.path.join(".")}: ${i.message}`) };
}

// ===========================================================================
// Types
// ===========================================================================

export type RetrievalModeT = z.infer<typeof RetrievalMode>;
export type RetrievalModalityT = z.infer<typeof RetrievalModality>;
export type FallbackReasonT = z.infer<typeof FallbackReason>;
export type RetrievalStateT = z.infer<typeof RetrievalState>;
export type EvidenceKindT = z.infer<typeof EvidenceKind>;
export type EvidenceBasisT = z.infer<typeof EvidenceBasis>;
export type EvidenceT = z.infer<typeof Evidence>;
export type ToolErrorT = z.infer<typeof ToolErrorUnion>;
export type UiSpecT = z.infer<typeof UiSpec>;
export type CreateUiSpecInputT = z.infer<typeof CreateUiSpecInput>;
export type AcceptanceCriterionT = z.infer<typeof AcceptanceCriterion>;
export type CitedDecisionT = z.infer<typeof CitedDecision>;
