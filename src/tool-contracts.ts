/**
 * Executable Zod contracts for the 12-tool MCP surface.
 *
 * This module is canonical: TypeScript types use `z.infer`, the design spec
 * documents these schemas, and Tasks 6–9 consume them rather than redefining.
 */
import { z } from "zod";
import { TOOL_CATALOG } from "./tool-catalog.js";

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
 * The retrieval state of a tool result. `modality` describes the query
 * modality, not every internal candidate source. Image retrieval is
 * `mode: "vector", modality: "image"`, never an undeclared `image-vector`
 * mode. `fallbackUsed` is true only when an alternate path produced the
 * returned result.
 */
export const RetrievalState = z
  .object({
    mode: RetrievalMode,
    modality: RetrievalModality,
    fallbackUsed: z.boolean(),
    fallbackReason: FallbackReason.optional(),
    attemptedModes: z.array(RetrievalMode).optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
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

    // "vector" with "missing-index" is contradictory (if index is missing,
    // vector mode couldn't have produced results)
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
  });

/** Pure check for whether a combination is allowed, outside Zod parse. */
export function isAllowedRetrievalState(state: {
  mode: string;
  modality: string;
  fallbackUsed: boolean;
  fallbackReason?: string;
}): boolean {
  return RetrievalState.safeParse(state).success;
}

// ===========================================================================
// Evidence
// ===========================================================================

export const Evidence = z
  .object({
    referenceId: z.string().min(1),
    claim: z.string().min(1),
    field: z.string().min(1),
    /** visible = directly observable in the screenshot; inferred = derived. */
    type: z.enum(["visible", "inferred"]),
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
  });

// ===========================================================================
// Inferred types
// ===========================================================================

export type RetrievalModeT = z.infer<typeof RetrievalMode>;
export type RetrievalModalityT = z.infer<typeof RetrievalModality>;
export type FallbackReasonT = z.infer<typeof FallbackReason>;
export type RetrievalStateT = z.infer<typeof RetrievalState>;
export type EvidenceT = z.infer<typeof Evidence>;
export type ToolErrorT = z.infer<typeof ToolError>;
export type ToolResultEnvelopeT = z.infer<typeof ToolResultEnvelope>;
