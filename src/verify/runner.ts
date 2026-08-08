// src/verify/runner.ts
import type { CorpusEntryT } from "../schema.js";
import type { VerifyCtx } from "./ctx.js";
import {
  inBand,
  recordedFor,
  type DetectorEntry,
  type DetectorResult,
  type DetectorVerdict,
} from "./detector-types.js";
import { detectorRegistry } from "./detector-registry.js";

export interface RunDetectorsOutcome {
  passes: string[];
  contradicted: string[];
  abstained: string[];
  /**
   * The raw DetectorResult per EVALUATED field — carries the measured
   * evidence and the detector's specific reason. The corpus writes otherwise
   * drop both (dataQuality.measured stayed null and the reason degraded to
   * "detector contradiction"), which made the suspect report unable to say
   * WHAT was measured against WHAT.
   */
  results: Record<string, DetectorResult>;
}

/**
 * The runner-enforced caps. The band wins; a contradiction-only `pass` is a
 * downgrade; a certifying `pass` on a non-affirmable value is a downgrade.
 */
export function capVerdict(det: DetectorEntry, result: DetectorResult, recorded: unknown): DetectorVerdict {
  if (inBand(det.confidenceBand, result.confidence)) return "abstain";
  if (result.verdict !== "pass") return result.verdict;
  if (det.category === "contradiction-only") return "abstain";
  if (!det.canAffirm(recorded)) return "abstain";
  return "pass";
}

/**
 * Runs every registered detector. `detectors: false` runs ONLY the two
 * pre-existing deterministic fields (platform, dominantColors) — everything
 * else returns to the vision pending list, byte-identical to today.
 */
export async function runDetectors(
  entry: CorpusEntryT,
  ctx: VerifyCtx,
  opts: { detectors?: boolean } = {},
): Promise<RunDetectorsOutcome> {
  const detectors = opts.detectors ?? true;
  const outcome: RunDetectorsOutcome = { passes: [], contradicted: [], abstained: [], results: {} };
  for (const [field, det] of Object.entries(detectorRegistry)) {
    if (det.disabled) continue;
    if (!detectors && field !== "platform" && field !== "visual.dominantColors") continue;
    const recorded = recordedFor(entry, field);
    let result: DetectorResult;
    try {
      result = await det.detect(entry, ctx);
    } catch (err) {
      outcome.abstained.push(field);
      continue;
    }
    outcome.results[field] = result;
    const verdict = capVerdict(det, result, recorded);
    if (verdict === "pass") outcome.passes.push(field);
    else if (verdict === "contradicted") outcome.contradicted.push(field);
    else outcome.abstained.push(field);
  }
  return outcome;
}
