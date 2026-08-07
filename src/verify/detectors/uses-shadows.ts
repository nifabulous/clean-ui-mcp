// src/verify/detectors/uses-shadows.ts
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import { ensureRaw } from "../ctx.js";
import {
  inBand,
  recordedFor,
  type ConfidenceBand,
  type DetectorResult,
} from "../detector-types.js";
import { boundaryConfidence, DEGENERATE_COVERAGE, edgeStats } from "./pixels.js";

const SHADOW_THRESHOLD = 0.35;
/**
 * Declared here; the registry references this value. Shadows resolve ~0.75
 * for a genuine shadow and ~0.23 for a flat card, so the abstain band narrows
 * to [0.3, 0.7] (abstains rampRatio in [0.07, 0.63]) — a photo-gradient false
 * positive lands inside it. Validated empirically on the fixture set.
 */
export const confidenceBand: ConfidenceBand = { low: 0.3, high: 0.7 };

/** Certifying for `true` only — an absence claim cannot be affirmed by measurement. */
export function canAffirm(recorded: unknown): boolean {
  return recorded === true;
}

export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const recorded = recordedFor(entry, "visual.usesShadows");
  const raw = await ensureRaw(ctx);
  const s = edgeStats(raw);
  if (s.edgeCoverage < DEGENERATE_COVERAGE) {
    return { verdict: "abstain", measured: s, confidence: 0.5, reason: "no edge content to measure (degenerate image)" };
  }
  const confidence = boundaryConfidence(s.rampRatio, SHADOW_THRESHOLD);
  if (inBand(confidenceBand, confidence)) {
    return { verdict: "abstain", measured: s, confidence, reason: `rampRatio ${s.rampRatio.toFixed(3)} is inside the decision band` };
  }
  const hasShadows = s.rampRatio >= SHADOW_THRESHOLD;
  if (recorded === true) {
    return hasShadows
      ? { verdict: "pass", measured: s, confidence, reason: `monotonic ramps dominate (rampRatio ${s.rampRatio.toFixed(3)})` }
      : { verdict: "contradicted", measured: s, confidence, reason: "no shadow ramps found though shadows are recorded" };
  }
  return hasShadows
    ? { verdict: "contradicted", measured: s, confidence, reason: "shadow ramps found though no shadows are recorded" }
    : { verdict: "abstain", measured: s, confidence: 0.5, reason: "no shadows found; absence is not evidence of absence" };
}
