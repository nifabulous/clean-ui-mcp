// src/verify/detectors/accent-color.ts
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import { ensureRaw } from "../ctx.js";
import {
  inBand,
  recordedFor,
  type ConfidenceBand,
  type DetectorResult,
} from "../detector-types.js";
import { boundaryConfidence, colorStats, deltaE2000, parseHex } from "./pixels.js";

const ACCENT_TOLERANCE = 6;
const BACKGROUND_EQUAL = 4;
const AREA_FLOOR = 0.005;
/** Declared here; the registry references this value (single source of truth). */
export const confidenceBand: ConfidenceBand = { low: 0.25, high: 0.75 };

/** Any recorded hex is affirmable (malformed values abstain inside detect). */
export function canAffirm(recorded: unknown): boolean {
  return typeof recorded === "string";
}

export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const recorded = recordedFor(entry, "visual.accentColor");
  if (typeof recorded !== "string") {
    return { verdict: "abstain", measured: null, confidence: 0.5, reason: "no recorded accent hex" };
  }
  let target: [number, number, number];
  try {
    target = parseHex(recorded);
  } catch (err) {
    return { verdict: "abstain", measured: recorded, confidence: 0.5, reason: `malformed recorded hex: ${String(err)}` };
  }
  const raw = await ensureRaw(ctx);
  const s = colorStats(raw, target, ACCENT_TOLERANCE);
  if (s.matchCount === 0) {
    return { verdict: "contradicted", measured: s, confidence: 0, reason: `recorded ${recorded} is absent from the image` };
  }
  if (deltaE2000(target, s.background) <= BACKGROUND_EQUAL) {
    return { verdict: "contradicted", measured: s, confidence: 0, reason: `recorded ${recorded} equals the background colour` };
  }
  if (s.matchCount < AREA_FLOOR * s.total) {
    return { verdict: "abstain", measured: s, confidence: 0.5, reason: "recorded hex present but below the area floor" };
  }
  // "Other" = every NON-BACKGROUND pixel that is NOT the target match. Using
  // largestNonBg here was a bug: on a single-colour image the largest non-bg
  // bucket IS the target, so share <= 0.5 always and the headline fixture
  // abstained (reproduced: accent-primary-true -> abstain @ conf 0.5).
  const other = Math.max(0, s.total - s.backgroundCount - s.matchCount);
  const share = s.matchCount / (s.matchCount + other);
  const confidence = boundaryConfidence(share, 0.5);
  if (inBand(confidenceBand, confidence)) {
    return { verdict: "abstain", measured: s, confidence, reason: "recorded hex and another colour are near-tied — accent role unconfirmed" };
  }
  if (s.largestNonBg && other > s.matchCount) {
    return { verdict: "abstain", measured: s, confidence, reason: "recorded hex present but another colour is larger — role unconfirmed" };
  }
  return { verdict: "pass", measured: s, confidence, reason: `recorded ${recorded} is the largest non-background colour (${s.matchCount} px)` };
}
