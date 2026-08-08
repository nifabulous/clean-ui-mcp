// src/verify/detectors/spacing-density.ts
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import { ensureRaw } from "../ctx.js";
import {
  inBand,
  recordedFor,
  type ConfidenceBand,
  type DetectorResult,
} from "../detector-types.js";
import { elementGaps } from "./pixels.js";

const COMPACT_MAX = 1;
const MODERATE_MAX = 2.5;
/** Declared here; the registry references this value (single source of truth). */
export const confidenceBand: ConfidenceBand = { low: 0.25, high: 0.75 };
const BOUNDARY_MARGIN = 0.4; // gapRatio units; inside this distance of a bucket boundary -> band

const AFFIRMABLE = new Set(["compact", "moderate", "spacious"]);

export function canAffirm(recorded: unknown): boolean {
  return typeof recorded === "string" && AFFIRMABLE.has(recorded);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const recorded = recordedFor(entry, "visual.spacingDensity");
  if (!canAffirm(recorded)) {
    return { verdict: "abstain", measured: recorded, confidence: 0.5, reason: "unaffirmable spacingDensity value" };
  }
  const raw = await ensureRaw(ctx);
  const g = elementGaps(raw);
  if (g.count < 2) {
    return { verdict: "abstain", measured: g, confidence: 0.5, reason: "fewer than two elements — a zero gap is not evidence" };
  }
  const boundaries = [COMPACT_MAX, MODERATE_MAX];
  const d = Math.min(...boundaries.map((b) => Math.abs(g.gapRatio - b)));
  const confidence = clamp01(0.5 - 0.5 * (d / BOUNDARY_MARGIN));
  if (inBand(confidenceBand, confidence)) {
    return { verdict: "abstain", measured: g, confidence, reason: `gapRatio ${g.gapRatio.toFixed(2)} is inside the bucket boundary band` };
  }
  const measured = g.gapRatio <= COMPACT_MAX ? "compact" : g.gapRatio <= MODERATE_MAX ? "moderate" : "spacious";
  return measured === recorded
    ? { verdict: "pass", measured: g, confidence, reason: `measured ${measured} (gapRatio ${g.gapRatio.toFixed(2)}) matches recorded ${recorded}` }
    : { verdict: "contradicted", measured: g, confidence, reason: `measured ${measured} (gapRatio ${g.gapRatio.toFixed(2)}), recorded ${recorded}` };
}
