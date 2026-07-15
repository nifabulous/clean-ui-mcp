/**
 * Executable Zod contracts for the 12-tool MCP surface.
 *
 * This module is canonical: TypeScript types use `z.infer`, the design spec
 * documents these schemas, and Tasks 6–9 consume them rather than redefining.
 *
 * Every tool has descriptor-keyed input, data, and complete envelope schemas
 * so the MCP outputSchema can advertise the real contract, not z.unknown().
 */
import { z } from "zod";
import {
  TOOL_CATALOG,
  TOOL_DEFINITIONS,
  type ToolName,
} from "./tool-catalog.js";
import { PatternType, Category, StyleTag } from "./schema.js";

// ===========================================================================
// Retrieval state matrix (§5.3 amendment)
// ===========================================================================

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

/** Allowed mode × modality combinations (exhaustive). */
const ALLOWED_MODE_MODALITY: Record<string, readonly string[]> = {
  none: ["none"],
  keyword: ["text", "metadata"],
  vector: ["text", "image"],
  hybrid: ["text"],
  "structured-fallback": ["metadata"],
};

export const RetrievalState = z
  .object({
    mode: RetrievalMode,
    modality: RetrievalModality,
    fallbackUsed: z.boolean(),
    resultCount: z.number().int().nonnegative(),
    fallbackReason: FallbackReason.optional(),
    attemptedModes: z.array(RetrievalMode).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    const allowed = ALLOWED_MODE_MODALITY[val.mode];
    if (allowed && !allowed.includes(val.modality)) {
      ctx.addIssue({ code: "custom", message: `mode "${val.mode}" cannot have modality "${val.modality}"`, path: ["modality"] });
    }
    if (val.fallbackUsed && val.fallbackReason === undefined) {
      ctx.addIssue({ code: "custom", message: "fallbackUsed true requires fallbackReason", path: ["fallbackReason"] });
    }
    if (!val.fallbackUsed && val.fallbackReason !== undefined) {
      ctx.addIssue({ code: "custom", message: "fallbackReason requires fallbackUsed true", path: ["fallbackUsed"] });
    }
    if (val.mode === "none" && val.fallbackUsed) {
      ctx.addIssue({ code: "custom", message: "'none' mode cannot have fallbackUsed", path: ["mode"] });
    }
    if (val.mode === "vector" && val.fallbackReason === "missing-index") {
      ctx.addIssue({ code: "custom", message: "'vector' mode with 'missing-index' is contradictory", path: ["mode"] });
    }
    if (val.mode === "structured-fallback" && val.fallbackReason === undefined && val.fallbackUsed) {
      ctx.addIssue({ code: "custom", message: "'structured-fallback' fallback requires a fallbackReason", path: ["fallbackReason"] });
    }
    if (val.fallbackUsed) {
      if (val.attemptedModes === undefined) {
        ctx.addIssue({ code: "custom", message: "fallbackUsed true requires attemptedModes", path: ["attemptedModes"] });
      } else {
        if (val.attemptedModes.length === 0) {
          ctx.addIssue({ code: "custom", message: "attemptedModes must be non-empty", path: ["attemptedModes"] });
        }
        if (val.attemptedModes.includes("none")) {
          ctx.addIssue({ code: "custom", message: "attemptedModes must not contain 'none'", path: ["attemptedModes"] });
        }
        if (new Set(val.attemptedModes).size !== val.attemptedModes.length) {
          ctx.addIssue({ code: "custom", message: "attemptedModes must not contain duplicates", path: ["attemptedModes"] });
        }
      }
    }
  });

export function isAllowedRetrievalState(state: {
  mode: string; modality: string; fallbackUsed: boolean;
  resultCount?: number; fallbackReason?: string; attemptedModes?: string[];
}): boolean {
  return RetrievalState.safeParse(state).success;
}

// ===========================================================================
// Per-tool allowed retrieval states
// ===========================================================================

export interface ToolRetrievalState { mode: string; modality: string }

/**
 * Allowed retrieval states per tool. Critique_ui includes vector+image
 * because it has an image-embedding retrieval path for the uploaded screenshot.
 */
export const ALLOWED_RETRIEVAL_STATES: Readonly<Record<string, readonly ToolRetrievalState[]>> = Object.freeze({
  search_ui_references: [
    { mode: "hybrid", modality: "text" },
    { mode: "vector", modality: "text" },
    { mode: "keyword", modality: "text" },
    { mode: "keyword", modality: "metadata" },
    { mode: "structured-fallback", modality: "metadata" },
    { mode: "none", modality: "none" },
  ],
  get_ui_reference: [
    { mode: "structured-fallback", modality: "metadata" },
    { mode: "none", modality: "none" },
  ],
  find_similar_ui_references: [
    { mode: "vector", modality: "text" },
    { mode: "vector", modality: "image" },
    { mode: "keyword", modality: "metadata" },
    { mode: "structured-fallback", modality: "metadata" },
    { mode: "none", modality: "none" },
  ],
  compare_ui_references: [
    { mode: "structured-fallback", modality: "metadata" },
    { mode: "none", modality: "none" },
  ],
  get_ui_taxonomy: [
    { mode: "structured-fallback", modality: "metadata" },
    { mode: "none", modality: "none" },
  ],
  browse_ui_patterns: [
    { mode: "structured-fallback", modality: "metadata" },
    { mode: "keyword", modality: "metadata" },
    { mode: "none", modality: "none" },
  ],
  plan_ui_direction: [
    { mode: "hybrid", modality: "text" },
    { mode: "vector", modality: "text" },
    { mode: "keyword", modality: "text" },
    { mode: "structured-fallback", modality: "metadata" },
    { mode: "none", modality: "none" },
  ],
  create_ui_spec: [
    { mode: "structured-fallback", modality: "metadata" },
    { mode: "none", modality: "none" },
  ],
  research_ui_anti_patterns: [
    { mode: "keyword", modality: "metadata" },
    { mode: "structured-fallback", modality: "metadata" },
    { mode: "none", modality: "none" },
  ],
  research_ui_palettes: [
    { mode: "keyword", modality: "metadata" },
    { mode: "structured-fallback", modality: "metadata" },
    { mode: "none", modality: "none" },
  ],
  research_ui_techniques: [
    { mode: "keyword", modality: "metadata" },
    { mode: "structured-fallback", modality: "metadata" },
    { mode: "none", modality: "none" },
  ],
  critique_ui: [
    { mode: "vector", modality: "image" },
    { mode: "vector", modality: "text" },
    { mode: "structured-fallback", modality: "metadata" },
    { mode: "none", modality: "none" },
  ],
});

function isRetrievalAllowedForTool(tool: string, state: { mode: string; modality: string }): boolean {
  const allowed = ALLOWED_RETRIEVAL_STATES[tool];
  if (!allowed) return false;
  return allowed.some((a) => a.mode === state.mode && a.modality === state.modality);
}

/** Tools that operate on a screenshot and can emit screen/DOM evidence. */
const SCREEN_TOOLS = new Set(["critique_ui"]);
/** Tools that synthesize from corpus references and emit corpus/editorial evidence. */
const SYNTHESIS_TOOLS = new Set(["plan_ui_direction", "create_ui_spec", "critique_ui"]);

// ===========================================================================
// Evidence — approved model with discriminated lanes
// ===========================================================================

export const EvidenceKind = z.enum([
  "corpus-observation", "screen-observation", "dom-signal",
  "machine-rule", "editorial-guidance",
]);

export const EvidenceBasis = z.enum([
  "visible", "inferred", "dom-grounded", "editorial",
]);

/**
 * Claim-level evidence with discriminated semantic constraints:
 * - corpus-observation requires referenceId
 * - screen-observation requires visible or inferred basis (not editorial/dom-grounded)
 * - dom-signal requires dom-grounded or visible basis
 * - editorial-guidance requires editorial basis
 * - machine-rule requires editorial basis (rules come from references, not observation)
 */
export const Evidence = z
  .object({
    id: z.string().min(1),
    referenceId: z.string().min(1).optional(),
    kind: EvidenceKind,
    summary: z.string().min(1),
    basis: EvidenceBasis,
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.kind === "corpus-observation" && val.referenceId === undefined) {
      ctx.addIssue({ code: "custom", message: "corpus-observation requires referenceId", path: ["referenceId"] });
    }
    if (val.kind === "screen-observation" && (val.basis === "editorial" || val.basis === "dom-grounded")) {
      ctx.addIssue({ code: "custom", message: "screen-observation basis must be 'visible' or 'inferred'", path: ["basis"] });
    }
    if (val.kind === "dom-signal" && (val.basis === "editorial" || val.basis === "inferred")) {
      ctx.addIssue({ code: "custom", message: "dom-signal basis must be 'dom-grounded' or 'visible'", path: ["basis"] });
    }
    if (val.kind === "editorial-guidance" && val.basis !== "editorial") {
      ctx.addIssue({ code: "custom", message: "editorial-guidance basis must be 'editorial'", path: ["basis"] });
    }
    if (val.kind === "machine-rule" && val.basis === "visible") {
      ctx.addIssue({ code: "custom", message: "machine-rule basis cannot be 'visible'", path: ["basis"] });
    }
  });

// ===========================================================================
// Tool error
// ===========================================================================

export const ToolError = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
  })
  .strict();

// ===========================================================================
// UiSpec — complete versioned create_ui_spec output (§5.4)
// ===========================================================================

const ColorTokens = z.object({
  primary: z.string().min(1),
  surface: z.string().min(1),
  ink: z.string().min(1),
  muted: z.string().min(1),
}).strict();

const TypographyTokens = z.object({
  heading: z.string().min(1),
  body: z.string().min(1),
  mono: z.string().min(1),
}).strict();

/** Authority for token decisions. */
const TokenAuthority = z.enum([
  "team-design-system",   // existing team design system
  "project-constraint",   // explicit approved project constraints
  "corpus-evidence",      // cited corpus proposals
  "editorial",            // editorial defaults
]).describe("Decision authority for token values — higher wins per §5.4");

const MotionGuidance = z.object({
  notes: z.array(z.string()),
  evidenceUnavailable: z.boolean(),
}).strict();

const AuthorityLanes = z.object({
  corpusEvidence: z.array(z.string()),
  machineRules: z.array(z.string()),
  editorialGuidance: z.array(z.string()),
}).strict();

const AcceptanceCriterion = z.object({
  criterion: z.string().min(1),
  type: z.enum(["visual", "accessibility", "behavioral", "content"]),
}).strict();

/** Context identity for the spec — what was asked for. */
const SpecContext = z.object({
  productContext: z.string().min(1),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  framework: z.string().optional(),
  designSystem: z.string().optional(),
}).strict();

/**
 * The complete versioned UiSpec returned by create_ui_spec.
 * Spec version allows evolution without breaking existing artifacts.
 */
export const UiSpec = z.object({
  specVersion: z.literal("1.0"),
  context: SpecContext,
  designDirection: z.string().min(1),
  rejectedDefaults: z.array(z.string()),
  layoutRegions: z.array(z.unknown()),
  responsiveBehavior: z.array(z.string()).default([]),
  componentInventory: z.array(z.unknown()),
  colorTokens: ColorTokens,
  colorTokenAuthority: TokenAuthority,
  typographyTokens: TypographyTokens,
  typographyTokenAuthority: TokenAuthority,
  interactions: z.array(z.string()).default([]),
  motionGuidance: MotionGuidance,
  accessibilityConstraints: z.array(z.string()),
  contentVoiceGuidance: z.string().optional(),
  techniques: z.array(z.unknown()),
  antiPatterns: z.array(z.unknown()),
  frameworkNotes: z.string().optional(),
  unavailableDecisions: z.array(z.object({
    field: z.string().min(1),
    reason: z.string().min(1),
  }).strict()).default([]),
  acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
  citedReferences: z.array(z.string()),
  authorityLanes: AuthorityLanes,
  provenance: z.object({
    generatedAt: z.string().datetime(),
    toolVersion: z.string().min(1),
  }).strict(),
}).strict();

// ===========================================================================
// Per-tool input schemas
// ===========================================================================

const SearchInput = z.object({
  query: z.string().optional(),
  category: Category.optional(),
  styleTag: StyleTag.optional(),
  patternType: PatternType.optional(),
  minQuality: z.number().min(1).max(5).optional(),
  qualityTier: z.enum(["exceptional", "cautionary"]).optional(),
  reviewStatus: z.enum(["approved", "draft", "any"]).optional(),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  limit: z.number().int().min(1).max(20).optional(),
  responseFormat: z.enum(["concise", "detailed"]).optional(),
}).strict();

const IdInput = z.object({ id: z.string().min(1) }).strict();
const CompareInput = z.object({ ids: z.array(z.string().min(1)).min(2).max(3), responseFormat: z.enum(["concise", "detailed"]).optional() }).strict();
const EmptyInput = z.object({}).strict();

const PlanInput = z.object({
  productContext: z.string().min(1),
  category: Category.optional(),
  styleTag: StyleTag.optional(),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  framework: z.string().optional(),
  count: z.number().int().min(1).max(5).optional(),
}).strict();

/** create_ui_spec allows zero references for the sparse/editorial-only case. */
const CreateUiSpecInput = z.object({
  productContext: z.string().min(1),
  references: z.array(z.string().min(1)).default([]),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  framework: z.string().optional(),
  designSystem: z.string().optional(),
  constraints: z.array(z.string()).optional(),
}).strict();

const ResearchInput = z.object({
  patternType: PatternType.optional(),
  styleTag: StyleTag.optional(),
  category: Category.optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict();

/** Critique input matches the existing CRITIQUE_UI_INPUT_SCHEMA including framework. */
const CritiqueInput = z.object({
  image_data: z.string().min(1),
  image_mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  product_context: z.string().optional(),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  framework: z.string().optional().describe("Design framework hint (e.g. 'md3')"),
}).strict();

export const ToolInputSchemas = {
  search_ui_references: SearchInput,
  get_ui_reference: IdInput,
  find_similar_ui_references: IdInput.extend({ limit: z.number().int().min(1).max(20).optional() }).strict(),
  compare_ui_references: CompareInput,
  get_ui_taxonomy: EmptyInput,
  browse_ui_patterns: z.object({ styleTag: StyleTag.optional() }).strict(),
  plan_ui_direction: PlanInput,
  create_ui_spec: CreateUiSpecInput,
  research_ui_anti_patterns: ResearchInput,
  research_ui_palettes: ResearchInput,
  research_ui_techniques: ResearchInput,
  critique_ui: CritiqueInput,
} satisfies Record<ToolName, z.ZodType>;

// ===========================================================================
// Per-tool data schemas
// ===========================================================================

const SearchResultEntry = z.object({ id: z.string().min(1), product: z.string().optional(), patternType: z.string().optional(), score: z.number().optional() }).strict();
const SearchData = z.object({ results: z.array(SearchResultEntry) }).strict();
const ReferenceData = z.object({ id: z.string().min(1) }).catchall(z.unknown()).strict();
const SimilarData = z.object({ results: z.array(SearchResultEntry) }).strict();
const ComparisonEntry = z.object({ id: z.string().min(1) }).catchall(z.unknown()).strict();
const CompareData = z.object({ entries: z.array(ComparisonEntry) }).strict();
const TaxonomyList = z.object({ count: z.number().int().nonnegative(), values: z.array(z.string().min(1)) }).strict();
const TaxonomyData = z.object({ patternTypes: TaxonomyList, categories: TaxonomyList, styleTags: TaxonomyList, components: TaxonomyList.optional(), domainTags: TaxonomyList.optional() }).strict();
const PatternGroupEntry = z.object({ patternType: z.string().min(1), count: z.number().int().nonnegative() }).strict();
const BrowseData = z.object({ patterns: z.array(PatternGroupEntry) }).strict();
const PlanData = z.object({ direction: z.string().min(1) }).catchall(z.unknown()).strict();
const ResearchEntry = z.object({ id: z.string().min(1) }).catchall(z.unknown()).strict();
const ResearchData = z.object({ results: z.array(ResearchEntry) }).strict();
const CritiqueData = z.object({ critique: z.string().min(1) }).catchall(z.unknown()).strict();

export const ToolDataSchemas = {
  search_ui_references: SearchData,
  get_ui_reference: ReferenceData,
  find_similar_ui_references: SimilarData,
  compare_ui_references: CompareData,
  get_ui_taxonomy: TaxonomyData,
  browse_ui_patterns: BrowseData,
  plan_ui_direction: PlanData,
  create_ui_spec: UiSpec,
  research_ui_anti_patterns: ResearchData,
  research_ui_palettes: ResearchData,
  research_ui_techniques: ResearchData,
  critique_ui: CritiqueData,
} satisfies Record<ToolName, z.ZodType>;

export function getToolDataSchema(tool: string): z.ZodType | undefined {
  return ToolDataSchemas[tool as keyof typeof ToolDataSchemas];
}

export function getToolEvidenceRequired(tool: string): boolean {
  const def = TOOL_DEFINITIONS.find((d) => d.name === tool);
  return def?.hasEvidence ?? false;
}

// ===========================================================================
// Descriptor-keyed complete envelope schemas (for MCP outputSchema)
// ===========================================================================

/**
 * Build a complete per-tool envelope schema with typed data.
 * This is what the MCP outputSchema should advertise.
 */
function makeToolEnvelopeSchema(tool: ToolName, dataSchema: z.ZodType) {
  const evidenceRequired = getToolEvidenceRequired(tool);
  return z.object({
    tool: z.literal(tool),
    schemaVersion: z.literal("1.0"),
    status: z.enum(["ok", "error"]),
    summary: z.string(),
    data: dataSchema.nullable(),
    referenceIds: z.array(z.string()),
    retrieval: RetrievalState,
    warnings: z.array(z.string()),
    evidence: evidenceRequired ? z.array(Evidence) : z.array(Evidence).optional(),
    error: ToolError.optional(),
  }).strict();
}

export const ToolResultSchemas = {
  search_ui_references: makeToolEnvelopeSchema("search_ui_references", SearchData),
  get_ui_reference: makeToolEnvelopeSchema("get_ui_reference", ReferenceData),
  find_similar_ui_references: makeToolEnvelopeSchema("find_similar_ui_references", SimilarData),
  compare_ui_references: makeToolEnvelopeSchema("compare_ui_references", CompareData),
  get_ui_taxonomy: makeToolEnvelopeSchema("get_ui_taxonomy", TaxonomyData),
  browse_ui_patterns: makeToolEnvelopeSchema("browse_ui_patterns", BrowseData),
  plan_ui_direction: makeToolEnvelopeSchema("plan_ui_direction", PlanData),
  create_ui_spec: makeToolEnvelopeSchema("create_ui_spec", UiSpec),
  research_ui_anti_patterns: makeToolEnvelopeSchema("research_ui_anti_patterns", ResearchData),
  research_ui_palettes: makeToolEnvelopeSchema("research_ui_palettes", ResearchData),
  research_ui_techniques: makeToolEnvelopeSchema("research_ui_techniques", ResearchData),
  critique_ui: makeToolEnvelopeSchema("critique_ui", CritiqueData),
} satisfies Record<ToolName, z.ZodType>;

// ===========================================================================
// parseToolResult — full validation with result integrity
// ===========================================================================

export interface ParseResult { ok: boolean; errors: string[] }

export function parseToolResult(raw: unknown): ParseResult {
  const errors: string[] = [];

  const env = raw as Record<string, unknown> | null;
  if (!env || typeof env !== "object") {
    return { ok: false, errors: ["not an object"] };
  }

  const tool = env.tool as string | undefined;

  // 1. Use descriptor-keyed schema for structural validation
  if (tool && tool in ToolResultSchemas) {
    const schema = ToolResultSchemas[tool as ToolName];
    const parse = schema.safeParse(raw);
    if (!parse.success) {
      return { ok: false, errors: parse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    }
  } else {
    // Fall back to generic envelope for unknown tools
    const parse = ToolResultEnvelope.safeParse(raw);
    if (!parse.success) {
      return { ok: false, errors: parse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`) };
    }
  }

  const status = env.status as string;
  const data = env.data as Record<string, unknown> | null;
  const retrieval = env.retrieval as Record<string, unknown> | undefined;
  const referenceIds = env.referenceIds as string[] | undefined;
  const evidence = env.evidence as Array<Record<string, unknown>> | undefined;

  // 2. Per-tool retrieval state
  if (tool && retrieval && !isRetrievalAllowedForTool(tool, { mode: retrieval.mode as string, modality: retrieval.modality as string })) {
    errors.push(`retrieval: tool "${tool}" cannot use mode "${retrieval.mode}" + modality "${retrieval.modality}"`);
  }

  // 3. resultCount must match actual data length (for list-returning tools)
  if (status === "ok" && data && retrieval && tool) {
    const claimedCount = retrieval.resultCount as number;
    const actualCount = countResults(tool, data);
    if (actualCount !== null && actualCount !== claimedCount) {
      errors.push(`resultCount: claims ${claimedCount} but data has ${actualCount} results`);
    }
  }

  // 4. referenceIds must be unique
  if (referenceIds && new Set(referenceIds).size !== referenceIds.length) {
    errors.push("referenceIds: contains duplicates");
  }

  // 5. Evidence IDs must be unique
  if (evidence) {
    const evIds = evidence.map((e) => e.id);
    if (new Set(evIds).size !== evIds.length) {
      errors.push("evidence: IDs must be unique");
    }
  }

  // 6. Evidence kind constraints per tool
  if (tool && evidence) {
    for (const ev of evidence) {
      const kind = ev.kind as string;
      // Only screen tools (critique_ui) can emit screen-observation or dom-signal
      if ((kind === "screen-observation" || kind === "dom-signal") && !SCREEN_TOOLS.has(tool)) {
        errors.push(`evidence: tool "${tool}" cannot emit ${kind} evidence (only critique_ui can)`);
      }
    }
  }

  // 7. Empty evidence insufficiency warning
  if (status === "ok" && tool && getToolEvidenceRequired(tool)) {
    if (evidence !== undefined && evidence.length === 0) {
      const warnings = (env.warnings as string[]) || [];
      const hasWarning = warnings.length > 0;
      if (!hasWarning) {
        errors.push("evidence: empty evidence array requires at least one warning");
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

/** Count actual results in tool data for resultCount verification. */
function countResults(tool: string, data: Record<string, unknown>): number | null {
  if (tool === "search_ui_references" || tool === "find_similar_ui_references" ||
      tool === "research_ui_anti_patterns" || tool === "research_ui_palettes" ||
      tool === "research_ui_techniques") {
    const results = data.results as unknown[] | undefined;
    return results ? results.length : null;
  }
  if (tool === "compare_ui_references") {
    const entries = data.entries as unknown[] | undefined;
    return entries ? entries.length : null;
  }
  if (tool === "browse_ui_patterns") {
    const patterns = data.patterns as unknown[] | undefined;
    return patterns ? patterns.length : null;
  }
  // Single-reference tools: count is 0 or 1
  if (tool === "get_ui_reference") return data.id ? 1 : 0;
  if (tool === "get_ui_taxonomy" || tool === "plan_ui_direction" ||
      tool === "create_ui_spec" || tool === "critique_ui") return null; // not count-based
  return null;
}

// ===========================================================================
// Generic envelope (for internal validation without per-tool data)
// ===========================================================================

export const ToolResultEnvelope = z
  .object({
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
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.status === "ok") {
      if (val.data === null) ctx.addIssue({ code: "custom", message: 'status "ok" requires non-null data', path: ["data"] });
      if (val.error !== undefined) ctx.addIssue({ code: "custom", message: 'status "ok" must not have an error', path: ["error"] });
    }
    if (val.status === "error") {
      if (val.data !== null) ctx.addIssue({ code: "custom", message: 'status "error" requires null data', path: ["data"] });
      if (val.error === undefined) ctx.addIssue({ code: "custom", message: 'status "error" requires an error object', path: ["error"] });
    }
    const evRequired = getToolEvidenceRequired(val.tool);
    if (val.evidence !== undefined && !evRequired) {
      ctx.addIssue({ code: "custom", message: `tool "${val.tool}" is not an evidence tool`, path: ["evidence"] });
    }
    if (evRequired && val.status === "ok" && val.evidence === undefined) {
      ctx.addIssue({ code: "custom", message: `tool "${val.tool}" requires an evidence array`, path: ["evidence"] });
    }
  });

// ===========================================================================
// Inferred types
// ===========================================================================

export type RetrievalModeT = z.infer<typeof RetrievalMode>;
export type RetrievalModalityT = z.infer<typeof RetrievalModality>;
export type FallbackReasonT = z.infer<typeof FallbackReason>;
export type RetrievalStateT = z.infer<typeof RetrievalState>;
export type EvidenceKindT = z.infer<typeof EvidenceKind>;
export type EvidenceBasisT = z.infer<typeof EvidenceBasis>;
export type EvidenceT = z.infer<typeof Evidence>;
export type ToolErrorT = z.infer<typeof ToolError>;
export type ToolResultEnvelopeT = z.infer<typeof ToolResultEnvelope>;
export type UiSpecT = z.infer<typeof UiSpec>;
