/**
 * Executable Zod contracts for the 12-tool MCP surface.
 *
 * This module is canonical: TypeScript types use `z.infer`, the design spec
 * documents these schemas, and Tasks 6–9 consume them rather than redefining.
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

/**
 * The retrieval state of a tool result.
 */
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
    // Mode × modality matrix
    const allowed = ALLOWED_MODE_MODALITY[val.mode];
    if (allowed && !allowed.includes(val.modality)) {
      ctx.addIssue({ code: "custom", message: `mode "${val.mode}" cannot have modality "${val.modality}"`, path: ["modality"] });
    }
    // fallbackUsed ↔ fallbackReason
    if (val.fallbackUsed && val.fallbackReason === undefined) {
      ctx.addIssue({ code: "custom", message: "fallbackUsed true requires fallbackReason", path: ["fallbackReason"] });
    }
    if (!val.fallbackUsed && val.fallbackReason !== undefined) {
      ctx.addIssue({ code: "custom", message: "fallbackReason requires fallbackUsed true", path: ["fallbackUsed"] });
    }
    // none mode cannot have fallback
    if (val.mode === "none" && val.fallbackUsed) {
      ctx.addIssue({ code: "custom", message: "'none' mode cannot have fallbackUsed", path: ["mode"] });
    }
    // vector + missing-index is contradictory
    if (val.mode === "vector" && val.fallbackReason === "missing-index") {
      ctx.addIssue({ code: "custom", message: "'vector' mode with 'missing-index' is contradictory", path: ["mode"] });
    }
    // structured-fallback requires reason
    if (val.mode === "structured-fallback" && val.fallbackReason === undefined) {
      ctx.addIssue({ code: "custom", message: "'structured-fallback' requires a fallbackReason", path: ["fallbackReason"] });
    }
    // Fallback requires non-empty attemptedModes without 'none' or duplicates
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
        const uniq = new Set(val.attemptedModes);
        if (uniq.size !== val.attemptedModes.length) {
          ctx.addIssue({ code: "custom", message: "attemptedModes must not contain duplicates", path: ["attemptedModes"] });
        }
      }
    }
  });

/** Pure check. */
export function isAllowedRetrievalState(state: {
  mode: string; modality: string; fallbackUsed: boolean;
  resultCount?: number; fallbackReason?: string; attemptedModes?: string[];
}): boolean {
  return RetrievalState.safeParse(state).success;
}

// ===========================================================================
// Per-tool allowed retrieval states
// ===========================================================================

export interface ToolRetrievalState {
  mode: string;
  modality: string;
}

/**
 * Allowed retrieval states per tool. Each tool may only produce retrieval
 * states appropriate to its function. This prevents e.g. get_ui_taxonomy
 * claiming image-vector retrieval.
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
    { mode: "structured-fallback", modality: "metadata" },
    { mode: "none", modality: "none" },
  ],
});

function isRetrievalAllowedForTool(tool: string, state: { mode: string; modality: string }): boolean {
  const allowed = ALLOWED_RETRIEVAL_STATES[tool];
  if (!allowed) return false;
  return allowed.some((a) => a.mode === state.mode && a.modality === state.modality);
}

// ===========================================================================
// Evidence — approved model with semantic constraints
// ===========================================================================

export const EvidenceKind = z.enum([
  "corpus-observation", "screen-observation", "dom-signal",
  "machine-rule", "editorial-guidance",
]);

export const EvidenceBasis = z.enum([
  "visible", "inferred", "dom-grounded", "editorial",
]);

/**
 * Claim-level evidence with semantic constraints:
 * - corpus-observation requires referenceId
 * - dom-signal basis must be dom-grounded or visible (not editorial/inferred)
 * - editorial-guidance basis must be editorial (not visible)
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
    // corpus-observation requires referenceId
    if (val.kind === "corpus-observation" && val.referenceId === undefined) {
      ctx.addIssue({ code: "custom", message: "corpus-observation requires referenceId", path: ["referenceId"] });
    }
    // dom-signal must be dom-grounded or visible (not editorial)
    if (val.kind === "dom-signal" && (val.basis === "editorial" || val.basis === "inferred")) {
      ctx.addIssue({ code: "custom", message: "dom-signal basis must be 'dom-grounded' or 'visible'", path: ["basis"] });
    }
    // editorial-guidance basis must be editorial (not visible)
    if (val.kind === "editorial-guidance" && val.basis !== "editorial") {
      ctx.addIssue({ code: "custom", message: "editorial-guidance basis must be 'editorial'", path: ["basis"] });
    }
    // machine-rule basis must be editorial (rules come from reference, not observation)
    if (val.kind === "machine-rule" && val.basis === "visible") {
      ctx.addIssue({ code: "custom", message: "machine-rule basis cannot be 'visible' (rules are not directly observed)", path: ["basis"] });
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
// UiSpec — complete create_ui_spec output (§5.4)
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

const MotionGuidance = z.object({
  notes: z.array(z.string()),
  evidenceUnavailable: z.boolean(),
}).strict();

const AuthorityLanes = z.object({
  corpusEvidence: z.array(z.string()),
  machineRules: z.array(z.string()),
  editorialGuidance: z.array(z.string()),
}).strict();

/**
 * The complete versioned UiSpec returned by create_ui_spec.
 * Encodes all approved fields: design direction, layout, tokens, motion,
 * accessibility, evidence lanes, authority separation, and testable
 * acceptance criteria.
 */
export const UiSpec = z.object({
  designDirection: z.string().min(1),
  rejectedDefaults: z.array(z.string()),
  layoutRegions: z.array(z.unknown()),
  componentInventory: z.array(z.unknown()),
  colorTokens: ColorTokens,
  typographyTokens: TypographyTokens,
  motionGuidance: MotionGuidance,
  accessibilityConstraints: z.array(z.string()),
  contentVoiceGuidance: z.string().optional(),
  techniques: z.array(z.unknown()),
  antiPatterns: z.array(z.unknown()),
  frameworkNotes: z.string().optional(),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  citedReferences: z.array(z.string()),
  authorityLanes: AuthorityLanes,
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

const CompareInput = z.object({
  ids: z.array(z.string().min(1)).min(2).max(3),
  responseFormat: z.enum(["concise", "detailed"]).optional(),
}).strict();

const EmptyInput = z.object({}).strict();

const PlanInput = z.object({
  productContext: z.string().min(1),
  category: Category.optional(),
  styleTag: StyleTag.optional(),
  count: z.number().int().min(1).max(5).optional(),
}).strict();

const CreateUiSpecInput = z.object({
  productContext: z.string().min(1),
  references: z.array(z.string().min(1)).min(1),
  constraints: z.array(z.string()).optional(),
}).strict();

const ResearchInput = z.object({
  patternType: PatternType.optional(),
  styleTag: StyleTag.optional(),
  category: Category.optional(),
  limit: z.number().int().min(1).max(20).optional(),
}).strict();

const CritiqueInput = z.object({
  image_data: z.string().min(1),
  image_mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
  product_context: z.string().optional(),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
}).strict();

export const ToolInputSchemas = {
  search_ui_references: SearchInput,
  get_ui_reference: IdInput,
  find_similar_ui_references: IdInput.extend({ limit: z.number().int().min(1).max(20).optional() }).strict(),
  compare_ui_references: CompareInput,
  get_ui_taxonomy: EmptyInput,
  browse_ui_patterns: z.object({
    styleTag: StyleTag.optional(),
  }).strict(),
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

const SearchResultEntry = z.object({
  id: z.string().min(1),
  product: z.string().optional(),
  patternType: z.string().optional(),
  score: z.number().optional(),
}).strict();

const SearchData = z.object({ results: z.array(SearchResultEntry) }).strict();
const ReferenceData = z.object({ id: z.string().min(1) }).catchall(z.unknown()).strict();
const SimilarData = z.object({ results: z.array(SearchResultEntry) }).strict();
const ComparisonEntry = z.object({ id: z.string().min(1) }).catchall(z.unknown()).strict();
const CompareData = z.object({ entries: z.array(ComparisonEntry) }).strict();

const TaxonomyList = z.object({
  count: z.number().int().nonnegative(),
  values: z.array(z.string().min(1)),
}).strict();

const TaxonomyData = z.object({
  patternTypes: TaxonomyList,
  categories: TaxonomyList,
  styleTags: TaxonomyList,
  components: TaxonomyList.optional(),
  domainTags: TaxonomyList.optional(),
}).strict();

const PatternGroupEntry = z.object({
  patternType: z.string().min(1),
  count: z.number().int().nonnegative(),
}).strict();

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

/** Get the data schema for a tool. */
export function getToolDataSchema(tool: string): z.ZodType | undefined {
  return ToolDataSchemas[tool as keyof typeof ToolDataSchemas];
}

/** Whether this tool must include an evidence array. */
export function getToolEvidenceRequired(tool: string): boolean {
  const def = TOOL_DEFINITIONS.find((d) => d.name === tool);
  return def?.hasEvidence ?? false;
}

// ===========================================================================
// parseToolResult — validates an envelope + per-tool data + evidence + retrieval
// ===========================================================================

export interface ParseResult {
  ok: boolean;
  errors: string[];
}

/**
 * Validate a complete tool result including per-tool data schema enforcement,
 * evidence eligibility, retrieval state, and per-tool retrieval constraints.
 */
export function parseToolResult(raw: unknown): ParseResult {
  const errors: string[] = [];

  // 1. Parse the common envelope shape (without per-tool data)
  const envelopeParse = ToolResultEnvelope.safeParse(raw);
  if (!envelopeParse.success) {
    return {
      ok: false,
      errors: envelopeParse.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }

  const env = envelopeParse.data;

  // 2. For success results, validate data against the per-tool schema
  if (env.status === "ok" && env.data !== null) {
    const dataSchema = getToolDataSchema(env.tool);
    if (dataSchema) {
      const dataParse = dataSchema.safeParse(env.data);
      if (!dataParse.success) {
        errors.push(
          ...dataParse.error.issues.map((i) => `data.${i.path.join(".")}: ${i.message}`),
        );
      }
    }
  }

  // 3. Validate per-tool retrieval state
  if (!isRetrievalAllowedForTool(env.tool, { mode: env.retrieval.mode, modality: env.retrieval.modality })) {
    errors.push(
      `retrieval: tool "${env.tool}" cannot use mode "${env.retrieval.mode}" + modality "${env.retrieval.modality}"`,
    );
  }

  // 4. Evidence insufficiency: empty evidence on an evidence tool requires a warning
  if (env.status === "ok" && getToolEvidenceRequired(env.tool)) {
    if (env.evidence !== undefined && env.evidence.length === 0) {
      const hasInsufficiencyWarning = env.warnings.some((w) =>
        w.toLowerCase().includes("insufficient") || w.toLowerCase().includes("evidence"),
      );
      if (!hasInsufficiencyWarning) {
        errors.push("evidence: empty evidence array requires an insufficiency warning");
      }
    }
  }

  return { ok: errors.length === 0, errors };
}

// ===========================================================================
// Common envelope (shape only — per-tool enforcement via parseToolResult)
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
      if (val.data === null) {
        ctx.addIssue({ code: "custom", message: 'status "ok" requires non-null data', path: ["data"] });
      }
      if (val.error !== undefined) {
        ctx.addIssue({ code: "custom", message: 'status "ok" must not have an error', path: ["error"] });
      }
    }
    if (val.status === "error") {
      if (val.data !== null) {
        ctx.addIssue({ code: "custom", message: 'status "error" requires null data', path: ["data"] });
      }
      if (val.error === undefined) {
        ctx.addIssue({ code: "custom", message: 'status "error" requires an error object', path: ["error"] });
      }
    }
    // Evidence eligibility
    const evidenceRequired = getToolEvidenceRequired(val.tool);
    if (val.evidence !== undefined && !evidenceRequired) {
      ctx.addIssue({ code: "custom", message: `tool "${val.tool}" is not an evidence tool`, path: ["evidence"] });
    }
    if (evidenceRequired && val.status === "ok" && val.evidence === undefined) {
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
