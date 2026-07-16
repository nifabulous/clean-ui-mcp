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
import { validateEnvelopeRetrieval, validateEvidenceReferences, type RetrievalPolicy, type FallbackReason as IntegrityFallbackReason } from "./tool-contract-integrity.js";

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
  "community-edition", "provider-error", "no-image-evidence",
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

export function isAllowedRetrievalState(s: Record<string, unknown>): boolean {
  return RetrievalState.safeParse(s).success;
}

// --- Evidence ---

export const EvidenceKind = z.enum([
  "corpus-observation", "screen-observation", "dom-signal",
  "machine-rule", "editorial-guidance",
]);
export const EvidenceBasis = z.enum([
  "visible", "inferred", "dom-grounded", "editorial",
]);

export const Evidence = z.object({
  id: z.string().min(1).trim(),
  referenceId: z.string().min(1).trim().optional(),
  kind: EvidenceKind,
  summary: z.string().min(1).trim(),
  basis: EvidenceBasis,
}).strict().superRefine((val, ctx) => {
  if (val.kind === "corpus-observation" && !val.referenceId)
    ctx.addIssue({ code: "custom", message: "corpus-observation requires referenceId", path: ["referenceId"] });
  if (val.kind === "corpus-observation" && (val.basis === "editorial" || val.basis === "dom-grounded"))
    ctx.addIssue({ code: "custom", message: "corpus-observation basis must be visible or inferred", path: ["basis"] });
  if (val.kind === "screen-observation" && (val.basis === "editorial" || val.basis === "dom-grounded"))
    ctx.addIssue({ code: "custom", message: "screen-observation basis must be visible or inferred", path: ["basis"] });
  if (val.kind === "dom-signal" && (val.basis === "editorial" || val.basis === "inferred"))
    ctx.addIssue({ code: "custom", message: "dom-signal basis must be dom-grounded or visible", path: ["basis"] });
  if (val.kind === "editorial-guidance" && val.basis !== "editorial")
    ctx.addIssue({ code: "custom", message: "editorial-guidance basis must be editorial", path: ["basis"] });
  if (val.kind === "machine-rule" && (val.basis === "visible" || val.basis === "dom-grounded"))
    ctx.addIssue({ code: "custom", message: "machine-rule basis must be inferred or editorial", path: ["basis"] });
});

// Evidence array with unique-ID enforcement
const EvidenceArray = z.array(Evidence).superRefine((arr, ctx) => {
  const seen = new Set<string>();
  arr.forEach((e, i) => {
    if (seen.has(e.id))
      ctx.addIssue({ code: "custom", message: `duplicate evidence id "${e.id}"`, path: [i, "id"] });
    seen.add(e.id);
  });
});

// --- Typed warnings ---

const WarningBase = z.object({
  code: z.string().min(1),
  message: z.string().min(1).trim(),
}).strict();

function makeWarningSchema<const T extends readonly string[]>(codes: T) {
  return z.array(z.object({
    code: z.enum(codes),
    message: z.string().min(1).trim(),
  }).strict());
}

// --- Typed errors (discriminated union with code↔retryable binding) ---

export const ToolErrorUnion = z.discriminatedUnion("code", [
  z.object({ code: z.literal("NOT_FOUND"), message: z.string().min(1).trim(), retryable: z.literal(false) }).strict(),
  z.object({ code: z.literal("INDEX_UNAVAILABLE"), message: z.string().min(1).trim(), retryable: z.literal(true) }).strict(),
  z.object({ code: z.literal("PROVIDER_ERROR"), message: z.string().min(1).trim(), retryable: z.literal(true) }).strict(),
  z.object({ code: z.literal("INVALID_INPUT"), message: z.string().min(1).trim(), retryable: z.literal(false) }).strict(),
]);

const ERROR_RETRYABLE: Record<string, boolean> = {
  NOT_FOUND: false, INVALID_INPUT: false,
  INDEX_UNAVAILABLE: true, PROVIDER_ERROR: true,
};

function makeErrorSchema<const T extends readonly string[]>(codes: T) {
  // Build error schema with code↔retryable binding via superRefine
  // (Zod discriminatedUnion with mapped variants loses literal types; superRefine is cleaner)
  return z.object({
    code: z.enum(codes),
    message: z.string().min(1).trim(),
    retryable: z.boolean(),
  }).strict().superRefine((val, ctx) => {
    const expected = ERROR_RETRYABLE[val.code];
    if (expected !== undefined && val.retryable !== expected)
      ctx.addIssue({ code: "custom", message: `error code "${val.code}" must have retryable: ${expected}`, path: ["retryable"] });
  });
}

// ===========================================================================
// 2. Shared result-row sub-schemas
// ===========================================================================

const SourceRef = z.object({
  productName: z.string().min(1).trim(),
  url: z.string().nullable(),
  imageAvailable: z.boolean(),
}).strict();

const ReferenceSummary = z.object({
  id: z.string().min(1).trim(),
  title: z.string().min(1).trim(),
  product: z.string().min(1).trim(),
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
  id: z.string().min(1).trim(),
  title: z.string().min(1).trim(),
  product: z.string().min(1).trim(),
  patternType: z.string().min(1),
  categories: z.array(z.string()),
  styleTags: z.array(z.string()),
  score: z.number(),
  basis: z.string().min(1),
  critique: z.string(),
  techniques: z.array(z.string()),
}).strict();

const ComparisonRow = z.object({
  id: z.string().min(1).trim(),
  title: z.string().min(1).trim(),
  product: z.string().min(1).trim(),
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
  id: z.string().min(1).trim(),
  title: z.string().min(1).trim(),
  product: z.string().min(1).trim(),
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
  product: z.string().min(1).trim(),
  sourceId: z.string().min(1).trim(),
  patternType: z.string().min(1),
}).strict();

const TechniqueRow = z.object({
  text: z.string().min(1).trim(),
  source: z.object({ id: z.string().min(1).trim(), product: z.string().min(1).trim() }).strict(),
}).strict();

const AntiPatternRow = z.object({
  text: z.string().min(1).trim(),
  sourceIds: z.array(z.string().min(1)),
  count: z.number().int(),
}).strict();

const FullReference = z.object({
  id: z.string().min(1).trim(),
  title: z.string().min(1).trim(),
  product: z.string().min(1).trim(),
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
    id: z.string().min(1).trim(),
    subject: z.string().min(1).trim(),
    assertion: AcceptanceAssertion,
    expectedOutcome: z.string().min(1).trim(),
    verifier: z.literal("axe"),
    priority: AcceptancePriority,
    evidenceIds: z.array(z.string()),
  }).strict(),
  z.object({
    id: z.string().min(1).trim(),
    subject: z.string().min(1).trim(),
    assertion: AcceptanceAssertion,
    expectedOutcome: z.string().min(1).trim(),
    verifier: z.literal("playwright"),
    priority: AcceptancePriority,
    evidenceIds: z.array(z.string()),
    selector: z.string().min(1),
  }).strict(),
  z.object({
    id: z.string().min(1).trim(),
    subject: z.string().min(1).trim(),
    assertion: AcceptanceAssertion,
    expectedOutcome: z.string().min(1).trim(),
    verifier: z.literal("static-analysis"),
    priority: AcceptancePriority,
    evidenceIds: z.array(z.string()),
    command: z.string().min(1),
  }).strict(),
  z.object({
    id: z.string().min(1).trim(),
    subject: z.string().min(1).trim(),
    assertion: AcceptanceAssertion,
    expectedOutcome: z.string().min(1).trim(),
    verifier: z.literal("manual"),
    priority: AcceptancePriority,
    evidenceIds: z.array(z.string()),
    manualSteps: z.array(z.string().min(1)).min(1),
  }).strict(),
]);

const CitedDecision = z.object({
  id: z.string().min(1).trim(),
  field: z.string().min(1).trim(),
  authority: z.enum(["team-design-system", "project-constraint", "corpus-evidence", "editorial"]),
  evidenceIds: z.array(z.string()),
  readiness: z.enum(["available", "proposed", "unavailable"]),
  sourceId: z.string().optional(),
}).strict();

const DesignSystemIdentity = z.object({
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
  name: z.string().min(1).trim(),
  type: z.string().min(1).trim(),
  components: z.array(z.string()),
  responsive: z.array(z.string()),
}).strict();

const ComponentEntry = z.object({
  name: z.string().min(1).trim(),
  pattern: z.string().min(1).trim(),
  sourceId: z.string().optional(),
}).strict();

const TechniqueEntry = z.object({
  text: z.string().min(1).trim(),
  sourceIds: z.array(z.string()),
}).strict();

const AntiPatternEntry = z.object({
  text: z.string().min(1).trim(),
  sourceIds: z.array(z.string()),
}).strict();

const UnavailableDecision = z.object({
  field: z.string().min(1).trim(),
  reason: z.string().min(1).trim(),
}).strict();

const SpecContext = z.object({
  productContext: z.string().min(1).trim(),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  implementationFramework: z.string().optional(),
  designSystem: DesignSystemIdentity.optional(),
  constraints: z.array(z.string().min(1).trim()).default([]),
}).strict();

export const UiSpec = z.object({
  specVersion: z.literal("1.0"),
  context: SpecContext,
  designDirection: z.string().min(1).trim(),
  rejectedDefaults: z.array(z.string()),
  layoutRegions: z.array(LayoutRegion),
  responsiveBehavior: z.array(z.string()),
  componentInventory: z.array(ComponentEntry),
  colorTokens: ColorTokens.nullable(),
  colorTokenAuthority: TokenAuthority,
  typographyTokens: TypographyTokens.nullable(),
  typographyTokenAuthority: TokenAuthority,
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
      ctx.addIssue({ code: "custom", message: `citedDecision "${cd.id}" sourceId "${cd.sourceId}" not in citedReferences`, path: ["citedDecisions"] });
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

const IdInput = z.object({ id: z.string().min(1).trim() }).strict();
const SimilarInput = z.object({ id: z.string().min(1).trim(), limit: z.number().int().min(1).max(20).default(5) }).strict();
const CompareInput = z.object({
  ids: z.array(z.string().min(1).trim()).min(2).max(3).refine(a => new Set(a).size === a.length, "ids must be unique"),
  responseFormat: z.enum(["concise", "detailed"]).optional(),
}).strict();

export const CreateUiSpecInput = z.object({
  productContext: z.string().min(8).trim(),
  referenceIds: z.array(z.string().min(1).trim()).max(5).default([])
    .refine(a => new Set(a).size === a.length, "referenceIds must be unique"),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  implementationFramework: z.string().optional(),
  serializationFormat: z.enum(["brief", "tokens"]).default("brief"),
  designSystem: DesignSystemIdentity.optional(),
  constraints: z.array(z.string().min(1).trim()).default([]),
}).strict();

const PlanInput = z.object({
  productContext: z.string().min(8).trim(),
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
  field: z.string().min(1).trim(), value: z.string().min(1).trim(),
  // plan has no designSystem context, so team-design-system authority is not available here
  authority: z.enum(["project-constraint", "corpus-evidence", "editorial"]),
  evidenceIds: z.array(z.string()),
}).strict();

const PlanDataSchema = z.object({
  direction: z.string().min(1).trim(),
  rejectedDefaults: z.array(z.string()),
  recommendation: z.string().min(1).trim(),
  rationale: z.string().min(1).trim(),
  evidenceContributions: z.array(z.string()),
  structuredDecisions: z.array(PlanDecision),
}).strict();

// ===========================================================================
// 6-7. TOOL_DESCRIPTORS — one colocated entry per tool
// ===========================================================================

// Helper: all evidence kinds for synthesis tools
const ALL_SYNTHESIS_KINDS = ["corpus-observation", "machine-rule", "editorial-guidance"] as const;
const CRITIQUE_KINDS = ["corpus-observation", "screen-observation", "dom-signal", "machine-rule", "editorial-guidance"] as const;

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
  readonly evidenceKinds: readonly string[];
  readonly warningSchema: z.ZodType;
  readonly errorSchema: z.ZodType;
  extractRefs: (data: unknown) => string[];
  countResults: (data: unknown) => number;
  refineData?: (data: unknown, ctx: z.RefinementCtx) => void;
  /** Envelope-level refinement — has access to warnings, evidence, referenceIds. */
  refineEnvelope?: (val: { data: unknown; warnings: unknown[]; referenceIds: string[]; evidence?: unknown[]; retrievalInfo?: { mode: string; fallbackUsed: boolean } }, ctx: z.RefinementCtx) => void;
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
      { mode: "structured-fallback", modality: "metadata", fallbackReasons: ["missing-index", "incompatible-index", "missing-provider-key", "community-edition", "provider-error"] },
      { mode: "none", modality: "none" },
    ],
    allowedAttemptedModes: ["hybrid", "vector", "keyword", "structured-fallback"],
    evidenceKinds: [],
    warningSchema: makeWarningSchema(["sparseCoverage", "keywordFallback"]),
    errorSchema: makeErrorSchema(["NOT_FOUND", "PROVIDER_ERROR"]),
    extractRefs: (d) => {
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
    extractRefs: (d) => { const id = (d as { id?: string })?.id; return id ? [id] : []; },
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
      { mode: "structured-fallback", modality: "metadata", fallbackReasons: ["missing-index", "incompatible-index", "missing-provider-key", "provider-error"] },
      { mode: "none", modality: "none" },
    ],
    allowedAttemptedModes: ["vector", "structured-fallback"],
    evidenceKinds: [],
    warningSchema: makeWarningSchema(["keywordFallback", "sparseCoverage"]),
    errorSchema: makeErrorSchema(["NOT_FOUND", "PROVIDER_ERROR"]),
    extractRefs: (d) => {
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
    extractRefs: (d) => (d as { foundIds?: string[] })?.foundIds ?? [],
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
    extractRefs: () => [],
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
    extractRefs: (d) => {
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
      { mode: "structured-fallback", modality: "metadata", fallbackReasons: ["missing-index", "incompatible-index", "missing-provider-key", "provider-error"] },
      { mode: "none", modality: "none" },
    ],
    allowedAttemptedModes: ["hybrid", "keyword", "structured-fallback"],
    evidenceKinds: [...ALL_SYNTHESIS_KINDS],
    warningSchema: makeWarningSchema(["sparseCoverage", "insufficientCorpusEvidence", "noCorpusIndex"]),
    errorSchema: makeErrorSchema(["PROVIDER_ERROR"]),
    extractRefs: (d) => (d as { evidenceContributions?: string[] })?.evidenceContributions ?? [],
    countResults: (d) => (d as { direction?: unknown })?.direction ? 1 : 0,
    refineEnvelope: (val, ctx) => {
      const evidenceIds = new Set<string>(((val.evidence as Array<{ id?: string }> | undefined)?.map(e => e.id).filter((x): x is string => !!x)) ?? []);
      const data = val.data as { structuredDecisions?: Array<{ evidenceIds?: string[] }> };
      for (const sd of data.structuredDecisions ?? []) {
        for (const eid of sd.evidenceIds ?? []) {
          if (!evidenceIds.has(eid))
            ctx.addIssue({ code: "custom", message: `structuredDecision evidenceId "${eid}" not in envelope evidence`, path: ["data", "structuredDecisions"] });
        }
      }
    },
  },
  {
    name: "create_ui_spec",
    rendererKey: "spec",
    hasEvidence: true,
    legacyNames: ["generate_design_prompt"],
    inputSchema: CreateUiSpecInput,
    dataSchema: UiSpec,
    retrieval: [{ mode: "none", modality: "none" }],
    allowedAttemptedModes: [],
    evidenceKinds: [...ALL_SYNTHESIS_KINDS],
    warningSchema: makeWarningSchema(["sparseCoverage", "insufficientCorpusEvidence", "motionEvidenceUnavailable"]),
    errorSchema: makeErrorSchema(["INVALID_INPUT"]),
    extractRefs: (d) => (d as { citedReferences?: string[] })?.citedReferences ?? [],
    countResults: (d) => (d as { specVersion?: unknown })?.specVersion ? 1 : 0,
    refineEnvelope: (val, ctx) => {
      const data = val.data as {
        acceptanceCriteria?: Array<{ id?: string; evidenceIds?: string[] }>;
        citedDecisions?: Array<{ id?: string; evidenceIds?: string[]; sourceId?: string }>;
        provenance?: { evidenceIds?: string[]; sourceReferences?: string[] };
        citedReferences?: string[];
        authorityLanes?: { corpusEvidence?: string[]; machineRules?: string[]; editorialGuidance?: string[] };
        techniques?: Array<{ sourceIds?: string[] }>;
        antiPatterns?: Array<{ sourceIds?: string[] }>;
        componentInventory?: Array<{ sourceId?: string }>;
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
      // Check duplicate citedReferences
      const citedRefs = data?.citedReferences ?? [];
      if (new Set(citedRefs).size !== citedRefs.length)
        ctx.addIssue({ code: "custom", message: "citedReferences must be unique", path: ["data", "citedReferences"] });
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
      for (const cd of data?.citedDecisions ?? []) {
        if (cd.sourceId !== undefined && !citedSet.has(cd.sourceId))
          ctx.addIssue({ code: "custom", message: `citedDecision "${cd.id}" sourceId "${cd.sourceId}" not in citedReferences`, path: ["data", "citedDecisions"] });
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
      // Check techniques sourceIds against citedReferences
      for (const tech of data?.techniques ?? []) {
        for (const sid of tech.sourceIds ?? []) {
          if (!citedSet.has(sid))
            ctx.addIssue({ code: "custom", message: `technique sourceId "${sid}" not in citedReferences`, path: ["data", "techniques"] });
        }
      }
      // Check antiPatterns sourceIds against citedReferences
      for (const ap of data?.antiPatterns ?? []) {
        for (const sid of ap.sourceIds ?? []) {
          if (!citedSet.has(sid))
            ctx.addIssue({ code: "custom", message: `antiPattern sourceId "${sid}" not in citedReferences`, path: ["data", "antiPatterns"] });
        }
      }
      // Check componentInventory sourceId against citedReferences
      for (const comp of data?.componentInventory ?? []) {
        if (comp.sourceId !== undefined && !citedSet.has(comp.sourceId))
          ctx.addIssue({ code: "custom", message: `component sourceId "${comp.sourceId}" not in citedReferences`, path: ["data", "componentInventory"] });
      }
      // provenance.evidenceIds must match envelope evidence IDs exactly (derived echo, not authority)
      const provEvIds = data?.provenance?.evidenceIds ?? [];
      if (new Set(provEvIds).size !== provEvIds.length)
        ctx.addIssue({ code: "custom", message: "provenance.evidenceIds must be unique", path: ["data", "provenance"] });
      const provenanceEvIds = new Set(provEvIds);
      if (provenanceEvIds.size !== knownEvidence.size || ![...provenanceEvIds].every(id => knownEvidence.has(id)))
        ctx.addIssue({ code: "custom", message: "provenance.evidenceIds must exactly match envelope evidence IDs", path: ["data", "provenance"] });
      // provenance.sourceReferences must match citedReferences exactly
      const sourceRefs = new Set(data?.provenance?.sourceReferences ?? []);
      if (sourceRefs.size !== citedSet.size || ![...sourceRefs].every(id => citedSet.has(id)))
        ctx.addIssue({ code: "custom", message: "provenance.sourceReferences must exactly match citedReferences", path: ["data", "provenance"] });
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
    extractRefs: (d) => {
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
    extractRefs: (d) => {
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
    extractRefs: (d) => {
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
      { mode: "structured-fallback", modality: "metadata", fallbackReasons: ["missing-index", "incompatible-index", "missing-provider-key", "provider-error", "no-image-evidence"] },
      { mode: "none", modality: "none" },
    ],
    allowedAttemptedModes: ["vector", "structured-fallback"],
    evidenceKinds: [...CRITIQUE_KINDS],
    warningSchema: makeWarningSchema(["insufficientCorpusEvidence", "providerDegraded"]),
    errorSchema: makeErrorSchema(["PROVIDER_ERROR", "INVALID_INPUT"]),
    extractRefs: (d) => ((d as { appliedReferences?: Array<{ id?: string }> })?.appliedReferences ?? []).map(r => r.id).filter((x): x is string => !!x),
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
export type ToolResultByName<N extends ToolName> = z.infer<(typeof ToolResultSchemas)[N]>;

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

function makeEnvelope(desc: ToolDescriptor): z.ZodType {
  return z.object({
    tool: z.literal(desc.name),
    schemaVersion: z.literal("1.0"),
    status: z.enum(["ok", "error"]),
    summary: z.string().min(1).trim(),
    data: desc.dataSchema.nullable(),
    referenceIds: z.array(z.string().min(1)),
    retrieval: RetrievalState,
    warnings: desc.warningSchema,
    // Non-evidence tools must not include the evidence property at all (not even [])
    evidence: desc.hasEvidence ? EvidenceArray : z.never().optional(),
    error: desc.errorSchema.optional(),
  }).strict().superRefine((val, ctx) => {
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
    }
    // 2b. Retrieval-capable tools: mode "none" on success requires resultCount 0
    // (none-only tools like get/compare/taxonomy legitimately have none+count 1)
    const isRetrievalCapable = desc.retrieval.length > 1 || (desc.retrieval.length === 1 && desc.retrieval[0]!.mode !== "none");
    if (val.status === "ok" && isRetrievalCapable && val.retrieval.mode === "none" && val.retrieval.resultCount > 0)
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

      // 6. reference set equality (allow repeated referenced IDs in data, compare as sets)
      const dataRefs = desc.extractRefs(val.data);
      const dataSet = new Set(dataRefs);
      // Do NOT reject duplicate dataRefs — aggregation rows may share source IDs.
      // Only reject duplicates for primary-ID tools (search/similar results, get id, compare entries)
      const primaryIdTools = ["search_ui_references", "find_similar_ui_references", "get_ui_reference", "compare_ui_references"];
      if (primaryIdTools.includes(desc.name) && dataSet.size !== dataRefs.length)
        ctx.addIssue({ code: "custom", message: "data contains duplicate primary IDs", path: ["data"] });
      const refSet = new Set(val.referenceIds);
      if (dataSet.size !== refSet.size || ![...dataSet].every(id => refSet.has(id))) {
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
            ctx.addIssue({ code: "custom", message: `evidence referenceId "${ev.referenceId}" not in referenceIds`, path: ["evidence", i, "referenceId"] });
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

export const ToolResultSchemas = Object.fromEntries(
  TOOL_DESCRIPTORS.map(d => [d.name, makeEnvelope(d)]),
) as { [N in ToolName]: ReturnType<typeof makeEnvelope> };

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
