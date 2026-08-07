// src/verify/detectors/uses-borders.ts
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

const BORDER_THRESHOLD = 0.45;
/** Declared here; the registry references this value (single source of truth). */
export const confidenceBand: ConfidenceBand = { low: 0.25, high: 0.75 };

/** Certifying for `true` only: an absence claim cannot be affirmed by measurement. */
export function canAffirm(recorded: unknown): boolean {
  return recorded === true;
}

export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const recorded = recordedFor(entry, "visual.usesBorders");
  const raw = await ensureRaw(ctx);
  const s = edgeStats(raw);
  if (s.edgeCoverage < DEGENERATE_COVERAGE) {
    return { verdict: "abstain", measured: s, confidence: 0.5, reason: "no edge content to measure (degenerate image)" };
  }
  const confidence = boundaryConfidence(s.thinRatio, BORDER_THRESHOLD);
  if (inBand(confidenceBand, confidence)) {
    return { verdict: "abstain", measured: s, confidence, reason: `thinRatio ${s.thinRatio.toFixed(3)} is inside the decision band` };
  }
  const hasBorders = s.thinRatio >= BORDER_THRESHOLD;
  if (recorded === true) {
    return hasBorders
      ? { verdict: "pass", measured: s, confidence, reason: `stroke-like thin edges dominate (thinRatio ${s.thinRatio.toFixed(3)})` }
      : { verdict: "contradicted", measured: s, confidence, reason: "no stroke-like thin edges found though borders are recorded" };
  }
  return hasBorders
    ? { verdict: "contradicted", measured: s, confidence, reason: "stroke-like thin edges found though no borders are recorded" }
    : { verdict: "abstain", measured: s, confidence: 0.5, reason: "no borders found; absence is not evidence of absence" };
}
