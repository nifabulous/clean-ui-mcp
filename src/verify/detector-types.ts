// src/verify/detector-types.ts
import type { CorpusEntryT } from "../schema.js";
import type { VerifyCtx } from "./ctx.js";

export type DetectorVerdict = "pass" | "contradicted" | "abstain";
export type DetectorCategory = "certifying" | "contradiction-only";

export interface DetectorResult {
  verdict: DetectorVerdict;
  /** The value the detector actually measured (for dataQuality + reports). */
  measured: unknown;
  /** 0..1; 0.5 = on the decision boundary. inBand -> abstain (the band wins). */
  confidence: number;
  reason: string;
}

export interface ConfidenceBand {
  low: number;
  high: number;
}

export interface DetectorEntry {
  detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult>;
  category: DetectorCategory;
  /** Held-out synthetic accuracy gate; below it the detector ships disabled. */
  accuracyFloor: number;
  confidenceBand: ConfidenceBand;
  /** Value-dependent certifying: pass is possible only for values this accepts. */
  canAffirm(recorded: unknown): boolean;
  disabled?: boolean;
}

/** True when confidence is inside the band — the band wins over the raw verdict. */
export function inBand(band: ConfidenceBand, confidence: number): boolean {
  return confidence >= band.low && confidence <= band.high;
}

/** The raw recorded value per registry field — what canAffirm and detectors read. */
export function recordedFor(entry: CorpusEntryT, field: string): unknown {
  const v = entry.visual;
  switch (field) {
    case "platform":
      return entry.platform ?? null;
    case "visual.dominantColors":
      return v?.dominantColors ?? null;
    case "visual.usesShadows":
      return v?.usesShadows ?? null;
    case "visual.usesBorders":
      return v?.usesBorders ?? null;
    case "visual.accentColor":
      return v?.accentColor ?? null;
    case "visual.cornerStyle":
      return v?.cornerStyle ?? null;
    case "visual.spacingDensity":
      return v?.spacingDensity ?? null;
    case "visual.colorRoles":
      return v?.colorRoles ?? null;
    case "antiPatterns.accessibilityRisks":
      return entry.antiPatterns?.accessibilityRisks ?? null;
    default:
      return null;
  }
}
