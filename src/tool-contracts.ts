/**
 * Executable Zod contracts for the 12-tool MCP surface.
 *
 * Canonical source: §5.3–5.5 of the design spec.
 * This module is the single executable definition; Tasks 6–9 consume it.
 *
 * Architecture:
 * - TOOL_DEFINITIONS is the descriptor (from tool-catalog.ts)
 * - Input/data/result/retrieval/evidence schemas are all derived from or
 *   colocated with the descriptor
 * - One canonical envelope factory enforces all cross-field invariants
 * - No z.unknown() placeholder remains in externally visible contracts
 */
import { z } from "zod";
import { TOOL_CATALOG, TOOL_DEFINITIONS, type ToolName } from "./tool-catalog.js";
import { PatternType, Category, StyleTag } from "./schema.js";

// ===========================================================================
// Retrieval state matrix
// ===========================================================================

export const RetrievalMode = z.enum(["hybrid", "vector", "keyword", "structured-fallback", "none"]);
export const RetrievalModality = z.enum(["text", "image", "metadata", "none"]);
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
  fallbackReason: FallbackReason.optional(),
  attemptedModes: z.array(RetrievalMode).optional(),
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
  // structured-fallback is inherently a fallback mode — requires fallbackUsed=true
  if (val.mode === "structured-fallback" && !val.fallbackUsed)
    ctx.addIssue({ code: "custom", message: "'structured-fallback' requires fallbackUsed", path: ["fallbackUsed"] });
  if (val.fallbackUsed) {
    if (!val.attemptedModes || val.attemptedModes.length === 0)
      ctx.addIssue({ code: "custom", message: "fallback requires non-empty attemptedModes", path: ["attemptedModes"] });
    else {
      if (val.attemptedModes.includes("none"))
        ctx.addIssue({ code: "custom", message: "attemptedModes cannot contain 'none'", path: ["attemptedModes"] });
      if (new Set(val.attemptedModes).size !== val.attemptedModes.length)
        ctx.addIssue({ code: "custom", message: "attemptedModes cannot have duplicates", path: ["attemptedModes"] });
    }
  }
});

export function isAllowedRetrievalState(s: Record<string, unknown>): boolean {
  return RetrievalState.safeParse(s).success;
}

// Per-tool allowed retrieval (mode × modality pairs)
export const ALLOWED_RETRIEVAL_STATES: Readonly<Record<string, readonly { mode: string; modality: string }[]>> = Object.freeze({
  search_ui_references: [{mode:"hybrid",modality:"text"},{mode:"vector",modality:"text"},{mode:"keyword",modality:"text"},{mode:"keyword",modality:"metadata"},{mode:"structured-fallback",modality:"metadata"},{mode:"none",modality:"none"}],
  get_ui_reference: [{mode:"none",modality:"none"}],
  find_similar_ui_references: [{mode:"vector",modality:"text"},{mode:"vector",modality:"image"},{mode:"keyword",modality:"metadata"},{mode:"structured-fallback",modality:"metadata"},{mode:"none",modality:"none"}],
  compare_ui_references: [{mode:"none",modality:"none"}],
  get_ui_taxonomy: [{mode:"structured-fallback",modality:"metadata"},{mode:"none",modality:"none"}],
  browse_ui_patterns: [{mode:"keyword",modality:"metadata"},{mode:"structured-fallback",modality:"metadata"},{mode:"none",modality:"none"}],
  plan_ui_direction: [{mode:"hybrid",modality:"text"},{mode:"vector",modality:"text"},{mode:"keyword",modality:"text"},{mode:"structured-fallback",modality:"metadata"},{mode:"none",modality:"none"}],
  create_ui_spec: [{mode:"none",modality:"none"}],
  research_ui_anti_patterns: [{mode:"keyword",modality:"metadata"},{mode:"structured-fallback",modality:"metadata"},{mode:"none",modality:"none"}],
  research_ui_palettes: [{mode:"keyword",modality:"metadata"},{mode:"structured-fallback",modality:"metadata"},{mode:"none",modality:"none"}],
  research_ui_techniques: [{mode:"keyword",modality:"metadata"},{mode:"structured-fallback",modality:"metadata"},{mode:"none",modality:"none"}],
  critique_ui: [{mode:"vector",modality:"image"},{mode:"vector",modality:"text"},{mode:"structured-fallback",modality:"metadata"},{mode:"none",modality:"none"}],
});

function isRetrievalAllowedForTool(tool: string, mode: string, modality: string): boolean {
  return ALLOWED_RETRIEVAL_STATES[tool]?.some(a => a.mode === mode && a.modality === modality) ?? false;
}

// ===========================================================================
// Evidence — discriminated lanes
// ===========================================================================

export const EvidenceKind = z.enum(["corpus-observation", "screen-observation", "dom-signal", "machine-rule", "editorial-guidance"]);
export const EvidenceBasis = z.enum(["visible", "inferred", "dom-grounded", "editorial"]);

export const Evidence = z.object({
  id: z.string().min(1),
  referenceId: z.string().min(1).optional(),
  kind: EvidenceKind,
  summary: z.string().min(1),
  basis: EvidenceBasis,
}).strict().superRefine((val, ctx) => {
  if (val.kind === "corpus-observation" && !val.referenceId)
    ctx.addIssue({ code: "custom", message: "corpus-observation requires referenceId", path: ["referenceId"] });
  if (val.kind === "screen-observation" && (val.basis === "editorial" || val.basis === "dom-grounded"))
    ctx.addIssue({ code: "custom", message: "screen-observation basis must be visible or inferred", path: ["basis"] });
  if (val.kind === "dom-signal" && (val.basis === "editorial" || val.basis === "inferred"))
    ctx.addIssue({ code: "custom", message: "dom-signal basis must be dom-grounded or visible", path: ["basis"] });
  if (val.kind === "editorial-guidance" && val.basis !== "editorial")
    ctx.addIssue({ code: "custom", message: "editorial-guidance basis must be editorial", path: ["basis"] });
  if (val.kind === "machine-rule" && val.basis === "visible")
    ctx.addIssue({ code: "custom", message: "machine-rule basis cannot be visible", path: ["basis"] });
});

// ===========================================================================
// Tool error
// ===========================================================================

export const ToolError = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  retryable: z.boolean(),
}).strict();

// ===========================================================================
// Per-tool input schemas
// ===========================================================================

const SearchInput = z.object({
  query: z.string().optional(), category: Category.optional(), styleTag: StyleTag.optional(),
  patternType: PatternType.optional(), minQuality: z.number().min(1).max(5).optional(),
  qualityTier: z.enum(["exceptional", "cautionary"]).optional(),
  reviewStatus: z.enum(["approved", "draft", "any"]).optional(),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  responseFormat: z.enum(["concise", "detailed"]).optional(),
}).strict();

const IdInput = z.object({ id: z.string().min(1) }).strict();
const CompareInput = z.object({ ids: z.array(z.string().min(1)).min(2).max(3), responseFormat: z.enum(["concise", "detailed"]).optional() }).strict();

const PlanInput = z.object({
  productContext: z.string().min(8),
  category: Category.optional(), styleTag: StyleTag.optional(),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  qualityTier: z.enum(["exceptional", "cautionary"]).optional(),
  framework: z.enum(["brief", "tokens"]).optional(),
  count: z.number().int().min(1).max(5).optional(),
}).strict();

const CreateUiSpecInput = z.object({
  productContext: z.string().min(8),
  referenceIds: z.array(z.string().min(1)).max(5).default([]),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  implementationFramework: z.string().optional(),
  serializationFormat: z.enum(["brief", "tokens"]).optional(),
  designSystem: z.string().optional(),
  constraints: z.array(z.string()).optional(),
}).strict();

const ResearchInput = z.object({
  patternType: PatternType.optional(), category: Category.optional(), styleTag: StyleTag.optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict();

const ResearchTechniquesInput = z.object({
  patternType: PatternType.optional(), styleTag: StyleTag.optional(),
  limit: z.number().int().min(1).max(30).optional(), // legacy default 15
}).strict();

// Critique reuses the canonical schema from synthesis/contracts.ts
// Importing it here to avoid maintaining a duplicate
import { CRITIQUE_UI_INPUT_SCHEMA } from "./synthesis/contracts.js";

export const ToolInputSchemas = {
  search_ui_references: SearchInput,
  get_ui_reference: IdInput,
  find_similar_ui_references: IdInput.extend({ limit: z.number().int().min(1).max(20).optional() }).strict(),
  compare_ui_references: CompareInput,
  get_ui_taxonomy: z.object({}).strict(),
  browse_ui_patterns: z.object({ styleTag: StyleTag.optional() }).strict(),
  plan_ui_direction: PlanInput,
  create_ui_spec: CreateUiSpecInput,
  research_ui_anti_patterns: ResearchInput,
  research_ui_palettes: ResearchInput,
  research_ui_techniques: ResearchTechniquesInput,
  critique_ui: CRITIQUE_UI_INPUT_SCHEMA,
} satisfies Record<ToolName, z.ZodType>;

// ===========================================================================
// Per-tool data schemas — complete typed, no z.unknown()
// ===========================================================================

// Shared sub-schemas
const SourceRef = z.object({ productName: z.string(), url: z.string().nullable() }).strict();
const ReferenceSummary = z.object({
  id: z.string().min(1), product: z.string(), patternType: z.string(),
  categories: z.array(z.string()), styleTags: z.array(z.string()),
  qualityScore: z.number().int(), qualityTier: z.string(),
  source: SourceRef, critique: z.string(), topTechniques: z.array(z.string()),
}).strict();

const TaxonomyList = z.object({ count: z.number().int().nonnegative(), values: z.array(z.string().min(1)) }).strict();
const AcceptanceCriterion = z.object({
  id: z.string().min(1), subject: z.string().min(1), assertion: z.string().min(1),
  expectedOutcome: z.string().min(1),
  verifier: z.enum(["manual", "playwright", "static", "axe"]),
  priority: z.enum(["must", "should", "could"]),
  evidenceIds: z.array(z.string()),
  manualSteps: z.array(z.string()).optional(),
  selector: z.string().optional(),
  command: z.string().optional(),
}).strict();
const CitedDecision = z.object({
  id: z.string().min(1), field: z.string().min(1),
  authority: z.enum(["team-design-system", "project-constraint", "corpus-evidence", "editorial"]),
  evidenceIds: z.array(z.string()),
  readiness: z.enum(["available", "proposed", "unavailable"]),
  sourceId: z.string().optional(),
}).strict();
const ColorTokens = z.object({
  primary: z.string().min(1), surface: z.string().min(1),
  ink: z.string().min(1), muted: z.string().min(1), accent: z.string().min(1),
}).strict();
const TypographyTokens = z.object({ heading: z.string().min(1), body: z.string().min(1), mono: z.string().min(1) }).strict();
const TokenAuthority = z.enum(["team-design-system", "project-constraint", "corpus-evidence", "editorial"]);
const MotionGuidance = z.object({ notes: z.array(z.string()), evidenceUnavailable: z.boolean() }).strict();
const AuthorityLanes = z.object({
  corpusEvidence: z.array(z.string()), machineRules: z.array(z.string()), editorialGuidance: z.array(z.string()),
}).strict();
const LayoutRegion = z.object({
  name: z.string().min(1), type: z.string().min(1),
  components: z.array(z.string()), responsive: z.array(z.string()).default([]),
}).strict();
const ComponentEntry = z.object({
  name: z.string().min(1), pattern: z.string().min(1), source: z.string().optional(),
}).strict();
const TechniqueEntry = z.object({
  text: z.string().min(1), sourceIds: z.array(z.string()),
}).strict();
const AntiPatternEntry = z.object({
  text: z.string().min(1), sourceIds: z.array(z.string()),
}).strict();
const UnavailableDecision = z.object({ field: z.string().min(1), reason: z.string().min(1) }).strict();
const SpecContext = z.object({
  productContext: z.string().min(1),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  implementationFramework: z.string().optional(),
  designSystem: z.string().optional(),
}).strict();

// UiSpec — the complete versioned artifact
export const UiSpec = z.object({
  specVersion: z.literal("1.0"),
  context: SpecContext,
  designDirection: z.string().min(1),
  rejectedDefaults: z.array(z.string()),
  layoutRegions: z.array(LayoutRegion),
  responsiveBehavior: z.array(z.string()),
  componentInventory: z.array(ComponentEntry),
  colorTokens: ColorTokens,
  colorTokenAuthority: TokenAuthority,
  typographyTokens: TypographyTokens,
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
  provenance: z.object({ generatedAt: z.string().datetime(), toolVersion: z.string().min(1) }).strict(),
}).strict();

// Critique data — reuses StructuredCritique minus schemaVersion
const StructuredRec = z.object({
  observation: z.string(), impact: z.string(), recommendation: z.string(),
  evidence: z.array(z.string()).min(1), basis: z.enum(["visible", "inferred", "dom-grounded", "editorial"]).default("visible"),
}).strict();
const AccessibilityRisk = z.object({
  element: z.string(), risk: z.string(), evidence: z.string(),
  wcag: z.array(z.string()).min(1), basis: z.enum(["visible", "inferred", "dom-grounded", "editorial"]).default("visible"),
}).strict();
const VisualSlop = z.object({
  pattern: z.string(), basis: z.enum(["visible", "inferred", "dom-grounded"]),
  evidence: z.array(z.string()).min(1), exception: z.string().optional(),
}).strict();
const MotionGuide = z.object({
  basis: z.enum(["visible", "inferred", "dom-grounded", "editorial"]),
  evidence: z.array(z.string()).min(1), note: z.string(), reference: z.string().optional(),
}).strict();
const AppliedRef = z.object({ id: z.string(), version: z.number().int(), purpose: z.string() }).strict();

const CritiqueDataSchema = z.object({
  critique: z.string().min(1),
  observations: z.array(z.string()),
  recommendations: z.array(StructuredRec),
  accessibilityRisks: z.array(AccessibilityRisk),
  visualSlop: z.array(VisualSlop).default([]),
  motion: z.array(MotionGuide).default([]),
  appliedReferences: z.array(AppliedRef).default([]),
  evidenceIds: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  md3: z.object({
    classification: z.enum(["supported", "insufficient-evidence", "conflicting"]),
    matchedCategories: z.array(z.string()),
    conflictingSignals: z.array(z.object({ category: z.string(), evidenceId: z.string(), detail: z.string() }).strict()).default([]),
    evidenceIds: z.array(z.string()),
    confidence: z.number(),
  }).strict().optional(),
}).strict();

// Compare row
const ComparisonRow = z.object({
  id: z.string().min(1), product: z.string(), patternType: z.string(),
  categories: z.array(z.string()), styleTags: z.array(z.string()),
  platform: z.string(), layout: z.string(), accent: z.string(),
  density: z.string(), corners: z.string(), quality: z.string(),
  critiqueAngle: z.string(), topTechnique: z.string(),
  antiPatterns: z.array(z.string()), accessibility: z.string(),
}).strict();

// Pattern group (browse)
const PatternGroup = z.object({
  patternType: z.string().min(1), count: z.number().int().nonnegative(),
  topProducts: z.array(z.string()),
  exemplar: z.object({ id: z.string().min(1), product: z.string(), critique: z.string() }).strict(),
}).strict();

// Plan data
const PlanDataSchema = z.object({
  direction: z.string().min(1),
  rejectedDefaults: z.array(z.string()),
  recommendation: z.string(),
  rationale: z.string(),
  evidenceContributions: z.array(z.string()),
}).strict();

// Research rows
const AntiPatternRow = z.object({ text: z.string().min(1), sourceIds: z.array(z.string()), count: z.number().int() }).strict();
const PaletteRecord = z.object({
  tokens: ColorTokens, accentHue: z.string(), product: z.string(), sourceId: z.string().min(1),
}).strict();
const TechniqueRow = z.object({ text: z.string().min(1), source: z.object({ id: z.string().min(1), product: z.string() }).strict() }).strict();
const SimilarReference = z.object({
  id: z.string().min(1), product: z.string(), patternType: z.string(),
  score: z.number(), basis: z.string(),
}).strict();

// Full reference record (get_ui_reference)
const FullReference = z.object({
  id: z.string().min(1), title: z.string(), product: z.string(),
  patternType: z.string(), categories: z.array(z.string()), styleTags: z.array(z.string()),
  qualityScore: z.number().int(), qualityTier: z.string(), platform: z.string(),
  layout: z.string(), accent: z.string(), density: z.string(), corners: z.string(),
  critique: z.string(), techniques: z.array(z.string()), antiPatterns: z.array(z.string()),
  source: SourceRef, imageAvailable: z.boolean(),
}).strict();

export const ToolDataSchemas = {
  search_ui_references: z.object({ results: z.array(ReferenceSummary) }).strict(),
  get_ui_reference: FullReference,
  find_similar_ui_references: z.object({ results: z.array(SimilarReference) }).strict(),
  compare_ui_references: z.object({
    entries: z.array(ComparisonRow), foundIds: z.array(z.string()), missingIds: z.array(z.string()),
  }).strict(),
  get_ui_taxonomy: z.object({
    patternTypes: TaxonomyList, categories: TaxonomyList, styleTags: TaxonomyList,
    components: TaxonomyList.optional(), domainTags: TaxonomyList.optional(),
  }).strict(),
  browse_ui_patterns: z.object({ patterns: z.array(PatternGroup) }).strict(),
  plan_ui_direction: PlanDataSchema,
  create_ui_spec: UiSpec,
  research_ui_anti_patterns: z.object({ results: z.array(AntiPatternRow) }).strict(),
  research_ui_palettes: z.object({ results: z.array(PaletteRecord) }).strict(),
  research_ui_techniques: z.object({ results: z.array(TechniqueRow) }).strict(),
  critique_ui: CritiqueDataSchema,
} satisfies Record<ToolName, z.ZodType>;

export function getToolDataSchema(tool: string): z.ZodType | undefined {
  return ToolDataSchemas[tool as keyof typeof ToolDataSchemas];
}
export function getToolEvidenceRequired(tool: string): boolean {
  return TOOL_DEFINITIONS.find(d => d.name === tool)?.hasEvidence ?? false;
}

// ===========================================================================
// Canonical envelope factory — one source of cross-field invariants
// ===========================================================================

const SCREEN_TOOLS = new Set(["critique_ui"]);

function envelopeSuperRefine(tool: string) {
  return (val: { status: string; data: unknown; error?: unknown; evidence?: unknown[]; warnings: string[] }, ctx: z.RefinementCtx) => {
    const evRequired = getToolEvidenceRequired(tool);
    if (val.status === "ok") {
      if (val.data === null) ctx.addIssue({ code: "custom", message: 'status "ok" requires non-null data', path: ["data"] });
      if (val.error !== undefined) ctx.addIssue({ code: "custom", message: 'status "ok" must not have error', path: ["error"] });
      if (evRequired && val.evidence === undefined) ctx.addIssue({ code: "custom", message: `tool requires evidence array`, path: ["evidence"] });
    }
    if (val.status === "error") {
      if (val.data !== null) ctx.addIssue({ code: "custom", message: 'status "error" requires null data', path: ["data"] });
      if (val.error === undefined) ctx.addIssue({ code: "custom", message: 'status "error" requires error', path: ["error"] });
    }
    if (val.evidence !== undefined && !evRequired)
      ctx.addIssue({ code: "custom", message: `tool is not an evidence tool`, path: ["evidence"] });
    // Empty evidence requires insufficiency warning
    if (evRequired && val.status === "ok" && val.evidence !== undefined && val.evidence.length === 0) {
      if (val.warnings.length === 0)
        ctx.addIssue({ code: "custom", message: "empty evidence requires at least one warning", path: ["warnings"] });
    }
  };
}

function makeToolEnvelope(tool: ToolName, dataSchema: z.ZodType) {
  const evRequired = getToolEvidenceRequired(tool);
  return z.object({
    tool: z.literal(tool),
    schemaVersion: z.literal("1.0"),
    status: z.enum(["ok", "error"]),
    summary: z.string(),
    data: dataSchema.nullable(),
    referenceIds: z.array(z.string()),
    retrieval: RetrievalState,
    warnings: z.array(z.string()),
    evidence: evRequired ? z.array(Evidence) : z.array(Evidence).optional(),
    error: ToolError.optional(),
  }).strict().superRefine(envelopeSuperRefine(tool));
}

export const ToolResultSchemas = {
  search_ui_references: makeToolEnvelope("search_ui_references", ToolDataSchemas.search_ui_references),
  get_ui_reference: makeToolEnvelope("get_ui_reference", ToolDataSchemas.get_ui_reference),
  find_similar_ui_references: makeToolEnvelope("find_similar_ui_references", ToolDataSchemas.find_similar_ui_references),
  compare_ui_references: makeToolEnvelope("compare_ui_references", ToolDataSchemas.compare_ui_references),
  get_ui_taxonomy: makeToolEnvelope("get_ui_taxonomy", ToolDataSchemas.get_ui_taxonomy),
  browse_ui_patterns: makeToolEnvelope("browse_ui_patterns", ToolDataSchemas.browse_ui_patterns),
  plan_ui_direction: makeToolEnvelope("plan_ui_direction", ToolDataSchemas.plan_ui_direction),
  create_ui_spec: makeToolEnvelope("create_ui_spec", ToolDataSchemas.create_ui_spec),
  research_ui_anti_patterns: makeToolEnvelope("research_ui_anti_patterns", ToolDataSchemas.research_ui_anti_patterns),
  research_ui_palettes: makeToolEnvelope("research_ui_palettes", ToolDataSchemas.research_ui_palettes),
  research_ui_techniques: makeToolEnvelope("research_ui_techniques", ToolDataSchemas.research_ui_techniques),
  critique_ui: makeToolEnvelope("critique_ui", ToolDataSchemas.critique_ui),
} satisfies Record<ToolName, z.ZodType>;

// ===========================================================================
// parseToolResult — full integrity validation
// ===========================================================================

export interface ParseResult { ok: boolean; errors: string[] }

export function parseToolResult(raw: unknown): ParseResult {
  const errors: string[] = [];
  const env = raw as Record<string, unknown> | null;
  if (!env || typeof env !== "object") return { ok: false, errors: ["not an object"] };

  const tool = env.tool as string;
  // 1. Per-tool schema
  if (tool && tool in ToolResultSchemas) {
    const schema = ToolResultSchemas[tool as ToolName];
    const parse = schema.safeParse(raw);
    if (!parse.success)
      return { ok: false, errors: parse.error.issues.map(i => `${i.path.join(".")}: ${i.message}`) };
  }

  const status = env.status, data = env.data as Record<string, unknown> | null;
  const retrieval = env.retrieval as Record<string, unknown> | undefined;
  const referenceIds = env.referenceIds as string[] | undefined;
  const evidence = env.evidence as Array<Record<string, unknown>> | undefined;
  const warnings = env.warnings as string[] | undefined;

  // 2. Per-tool retrieval
  if (tool && retrieval && !isRetrievalAllowedForTool(tool, retrieval.mode as string, retrieval.modality as string))
    errors.push(`retrieval: tool "${tool}" cannot use ${retrieval.mode}/${retrieval.modality}`);

  // 3. resultCount vs actual
  if (status === "ok" && data && retrieval) {
    const actual = countResults(tool, data);
    if (actual !== null && actual !== retrieval.resultCount)
      errors.push(`resultCount: claims ${retrieval.resultCount}, actual ${actual}`);
  }

  // 4. Unique referenceIds
  if (referenceIds && new Set(referenceIds).size !== referenceIds.length)
    errors.push("referenceIds: contains duplicates");

  // 5. Unique evidence IDs
  if (evidence) {
    const ids = evidence.map(e => e.id);
    if (new Set(ids).size !== ids.length) errors.push("evidence: IDs must be unique");
  }

  // 6. Evidence kind per tool
  if (tool && evidence) {
    for (const ev of evidence) {
      const kind = ev.kind as string;
      if ((kind === "screen-observation" || kind === "dom-signal") && !SCREEN_TOOLS.has(tool))
        errors.push(`evidence: "${tool}" cannot emit ${kind}`);
    }
  }

  // 7. Empty evidence requires warning (broadened — any non-empty warnings array)
  if (status === "ok" && tool && getToolEvidenceRequired(tool) && evidence !== undefined && evidence.length === 0) {
    if (!warnings || warnings.length === 0) errors.push("evidence: empty array requires warning");
  }

  return { ok: errors.length === 0, errors };
}

function countResults(tool: string, data: Record<string, unknown>): number | null {
  const listTools = ["search_ui_references", "find_similar_ui_references", "research_ui_anti_patterns", "research_ui_palettes", "research_ui_techniques"];
  if (listTools.includes(tool)) {
    const r = data.results as unknown[]; return r ? r.length : null;
  }
  if (tool === "compare_ui_references") { const e = data.entries as unknown[]; return e ? e.length : null; }
  if (tool === "browse_ui_patterns") { const p = data.patterns as unknown[]; return p ? p.length : null; }
  if (tool === "get_ui_reference") return data.id ? 1 : 0;
  return null;
}

// ===========================================================================
// Generic envelope (for internal validation)
// ===========================================================================

export const ToolResultEnvelope = z.object({
  tool: z.enum(TOOL_CATALOG as [string, ...string[]]),
  schemaVersion: z.literal("1.0"),
  status: z.enum(["ok", "error"]),
  summary: z.string(),
  data: z.unknown().nullable(),
  referenceIds: z.array(z.string()),
  retrieval: RetrievalState,
  warnings: z.array(z.string()),
  evidence: z.array(Evidence).optional(),
  error: ToolError.optional(),
}).strict();

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
export type ToolErrorT = z.infer<typeof ToolError>;
export type UiSpecT = z.infer<typeof UiSpec>;
export type ToolResultEnvelopeT = z.infer<typeof ToolResultEnvelope>;
