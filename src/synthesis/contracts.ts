/**
 * synthesis/contracts.ts — Zod schema for structured critique output.
 *
 * Schema version 1.0. The MCP tool returns both a legacy Markdown text (for
 * backward compatibility) and a structuredContent object matching this schema
 * (for structured consumers). Both are derived from the same gated result.
 */
import { z } from "zod";

export const CRITIQUE_SCHEMA_VERSION = "1.0" as const;

// ─── enums ────────────────────────────────────────────────────────────────────

export const ClaimBasis = z.enum([
  "visible",        // directly observable in the screenshot
  "inferred",       // plausible but not directly proven
  "dom-grounded",   // DOM signal confirms it
  "editorial",      // editorial reference supports it
]);
export type ClaimBasisT = z.infer<typeof ClaimBasis>;

// ─── structured finding types ──────────────────────────────────────────────────

export const VisualSlopFinding = z.object({
  pattern: z.string(),                 // e.g. "centered hero on gradient"
  basis: ClaimBasis,                   // how the claim is supported
  evidence: z.array(z.string()).min(1), // evidence IDs
  exception: z.string().optional(),     // legitimate exception if applicable
});
export type VisualSlopFindingT = z.infer<typeof VisualSlopFinding>;

export const MotionGuidance = z.object({
  basis: ClaimBasis,
  evidence: z.array(z.string()).min(1),
  note: z.string(),
  reference: z.string().optional(), // ref: ID for editorial basis
});
export type MotionGuidanceT = z.infer<typeof MotionGuidance>;

export const StructuredRecommendation = z.object({
  observation: z.string(),
  impact: z.string(),
  recommendation: z.string(),
  evidence: z.array(z.string()).min(1), // evidence IDs — must be valid
  basis: ClaimBasis.default("visible"),
});
export type StructuredRecommendationT = z.infer<typeof StructuredRecommendation>;

export const StructuredAccessibilityRisk = z.object({
  element: z.string(),
  risk: z.string(),
  evidence: z.string(), // single evidence ID
  wcag: z.array(z.string()).min(1),
  basis: ClaimBasis.default("visible"),
});
export type StructuredAccessibilityRiskT = z.infer<typeof StructuredAccessibilityRisk>;

export const AppliedReference = z.object({
  id: z.string(),
  version: z.number().int(),
  purpose: z.string(),
});
export type AppliedReferenceT = z.infer<typeof AppliedReference>;

// ─── top-level structured critique schema ──────────────────────────────────────

export const StructuredCritique = z.object({
  schemaVersion: z.literal(CRITIQUE_SCHEMA_VERSION),
  platform: z.string(),
  retrievalMode: z.string(),
  fallbackUsed: z.boolean(),
  coverage: z.string(),
  summary: z.string(),
  observations: z.array(z.string()),
  recommendations: z.array(StructuredRecommendation),
  accessibilityRisks: z.array(StructuredAccessibilityRisk),
  visualSlop: z.array(VisualSlopFinding).default([]),
  motion: z.array(MotionGuidance).default([]),
  appliedReferences: z.array(AppliedReference).default([]),
  evidenceIds: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  md3: z.object({
    classification: z.enum(["supported", "insufficient-evidence", "conflicting"]),
    matchedCategories: z.array(z.string()),
    evidenceIds: z.array(z.string()),
    confidence: z.number(),
  }).optional(),
});
export type StructuredCritiqueT = z.infer<typeof StructuredCritique>;
