/**
 * Executable Zod contracts for the 12-tool MCP surface.
 *
 * This module is canonical: TypeScript types use `z.infer`, the design spec
 * documents these schemas, and Tasks 6–9 consume them rather than redefining.
 */
import { z } from "zod";
import { TOOL_CATALOG, TOOL_DEFINITIONS, type ToolName } from "./tool-catalog.js";

// ===========================================================================
// Retrieval state matrix (§5.3 amendment)
// ===========================================================================

export const RetrievalMode = z.enum([
  "hybrid",
  "vector",
  "keyword",
  "structured-fallback",
  "none",
]);

export const RetrievalModality = z.enum([
  "text",
  "image",
  "metadata",
  "none",
]);

export const FallbackReason = z.enum([
  "missing-index",
  "incompatible-index",
  "missing-provider-key",
  "community-edition",
  "provider-error",
  "no-image-evidence",
]);

/**
 * Allowed mode × modality combinations.
 * - none: only none modality (no retrieval happened)
 * - keyword: text or metadata (keyword search operates on text/metadata)
 * - vector: text or image (vector search covers text and image embeddings)
 * - hybrid: text only (hybrid = vector+keyword text fusion)
 * - structured-fallback: metadata only (taxonomy/rule-based, no embeddings)
 */
const ALLOWED_MODE_MODALITY: Record<string, readonly string[]> = {
  none: ["none"],
  keyword: ["text", "metadata"],
  vector: ["text", "image"],
  hybrid: ["text"],
  "structured-fallback": ["metadata"],
};

/**
 * The retrieval state of a tool result.
 *
 * `modality` describes the query modality, not every internal candidate source.
 * Image retrieval is `mode: "vector", modality: "image"`, never an undeclared
 * `image-vector` mode. `fallbackUsed` is true only when an alternate path
 * produced the returned result. `resultCount` is the number of results returned.
 * `attemptedModes` records the preferred paths tried before fallback.
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
      ctx.addIssue({
        code: "custom",
        message: `mode "${val.mode}" cannot have modality "${val.modality}"`,
        path: ["modality"],
      });
    }

    // fallbackUsed ↔ fallbackReason consistency
    if (val.fallbackUsed && val.fallbackReason === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "fallbackUsed true requires fallbackReason",
        path: ["fallbackReason"],
      });
    }
    if (!val.fallbackUsed && val.fallbackReason !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "fallbackReason requires fallbackUsed true",
        path: ["fallbackUsed"],
      });
    }

    // "none" mode cannot have fallback
    if (val.mode === "none" && val.fallbackUsed) {
      ctx.addIssue({
        code: "custom",
        message: "'none' mode cannot have fallbackUsed",
        path: ["mode"],
      });
    }

    // "vector" with "missing-index" is contradictory
    if (val.mode === "vector" && val.fallbackReason === "missing-index") {
      ctx.addIssue({
        code: "custom",
        message: "'vector' mode with 'missing-index' is contradictory",
        path: ["mode"],
      });
    }

    // "structured-fallback" must have a fallbackReason
    if (val.mode === "structured-fallback" && val.fallbackReason === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "'structured-fallback' requires a fallbackReason",
        path: ["fallbackReason"],
      });
    }

    // Fallback requires attemptedModes (must record what was tried)
    if (val.fallbackUsed && val.attemptedModes === undefined) {
      ctx.addIssue({
        code: "custom",
        message: "fallbackUsed true requires attemptedModes",
        path: ["attemptedModes"],
      });
    }
  });

/** Pure check for whether a combination is allowed, outside Zod parse. */
export function isAllowedRetrievalState(state: {
  mode: string;
  modality: string;
  fallbackUsed: boolean;
  resultCount?: number;
  fallbackReason?: string;
  attemptedModes?: string[];
}): boolean {
  return RetrievalState.safeParse(state).success;
}

// ===========================================================================
// Evidence — approved model (§5.3)
// ===========================================================================

export const EvidenceKind = z.enum([
  "corpus-observation",
  "screen-observation",
  "dom-signal",
  "machine-rule",
  "editorial-guidance",
]);

export const EvidenceBasis = z.enum([
  "visible",
  "inferred",
  "dom-grounded",
  "editorial",
]);

/**
 * Claim-level evidence. `id` is response-scoped (not a stable corpus ID).
 * `referenceId` is optional — present when the evidence cites a corpus entry.
 */
export const Evidence = z
  .object({
    id: z.string().min(1),
    referenceId: z.string().min(1).optional(),
    kind: EvidenceKind,
    summary: z.string().min(1),
    basis: EvidenceBasis,
  })
  .strict();

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
// Per-tool data schemas
// ===========================================================================

/**
 * Strict output-data schemas for each tool. These define the shape of `data`
 * in the ToolResultEnvelope. Each tool returns a different data shape.
 */

// Search results share a common entry shape
const SearchResultEntry = z.object({
  id: z.string().min(1),
  product: z.string().optional(),
  patternType: z.string().optional(),
  score: z.number().optional(),
}).strict();

const SearchData = z.object({
  results: z.array(SearchResultEntry),
}).strict();

// Reference detail
const ReferenceData = z.object({
  id: z.string().min(1),
}).catchall(z.unknown()).strict();

// Similar results
const SimilarData = z.object({
  results: z.array(SearchResultEntry),
}).strict();

// Comparison
const ComparisonEntry = z.object({
  id: z.string().min(1),
}).catchall(z.unknown()).strict();

const CompareData = z.object({
  entries: z.array(ComparisonEntry),
}).strict();

// Taxonomy (consolidated three lists)
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

// Browse patterns
const PatternGroupEntry = z.object({
  patternType: z.string().min(1),
  count: z.number().int().nonnegative(),
}).strict();

const BrowseData = z.object({
  patterns: z.array(PatternGroupEntry),
}).strict();

// Plan direction — synthesis output
const PlanData = z.object({
  direction: z.string().min(1),
}).catchall(z.unknown()).strict();

// Create UI spec — the primary build artifact
const UiSpecData = z.object({
  designDirection: z.string().min(1),
  sections: z.array(z.unknown()),
}).catchall(z.unknown()).strict();

// Research aggregations (anti-patterns, palettes, techniques)
const ResearchEntry = z.object({
  id: z.string().min(1),
}).catchall(z.unknown()).strict();

const ResearchData = z.object({
  results: z.array(ResearchEntry),
}).strict();

// Critique
const CritiqueData = z.object({
  critique: z.string().min(1),
}).catchall(z.unknown()).strict();

export const ToolDataSchemas = {
  search_ui_references: SearchData,
  get_ui_reference: ReferenceData,
  find_similar_ui_references: SimilarData,
  compare_ui_references: CompareData,
  get_ui_taxonomy: TaxonomyData,
  browse_ui_patterns: BrowseData,
  plan_ui_direction: PlanData,
  create_ui_spec: UiSpecData,
  research_ui_anti_patterns: ResearchData,
  research_ui_palettes: ResearchData,
  research_ui_techniques: ResearchData,
  critique_ui: CritiqueData,
} as const;

/** Get the data schema for a tool. */
export function getToolDataSchema(tool: string): z.ZodType | undefined {
  return ToolDataSchemas[tool as keyof typeof ToolDataSchemas];
}

/** Whether this tool must include an evidence array in its result. */
export function getToolEvidenceRequired(tool: string): boolean {
  const def = TOOL_DEFINITIONS.find((d) => d.name === tool);
  return def?.hasEvidence ?? false;
}

// ===========================================================================
// Common envelope
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
    // status: "ok" requires non-null data and no error
    if (val.status === "ok") {
      if (val.data === null) {
        ctx.addIssue({
          code: "custom",
          message: 'status "ok" requires non-null data',
          path: ["data"],
        });
      }
      if (val.error !== undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'status "ok" must not have an error',
          path: ["error"],
        });
      }
    }

    // status: "error" requires null data and an error
    if (val.status === "error") {
      if (val.data !== null) {
        ctx.addIssue({
          code: "custom",
          message: 'status "error" requires null data',
          path: ["data"],
        });
      }
      if (val.error === undefined) {
        ctx.addIssue({
          code: "custom",
          message: 'status "error" requires an error object',
          path: ["error"],
        });
      }
    }

    // Evidence eligibility: only evidence tools may include evidence
    const evidenceRequired = getToolEvidenceRequired(val.tool);
    if (val.evidence !== undefined && !evidenceRequired) {
      ctx.addIssue({
        code: "custom",
        message: `tool "${val.tool}" is not an evidence tool and must not include evidence`,
        path: ["evidence"],
      });
    }

    // Evidence tools must include the evidence array (even if empty)
    if (evidenceRequired && val.status === "ok" && val.evidence === undefined) {
      ctx.addIssue({
        code: "custom",
        message: `tool "${val.tool}" requires an evidence array (may be empty with a warning)`,
        path: ["evidence"],
      });
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
