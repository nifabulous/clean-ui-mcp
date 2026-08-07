// src/verify/detectors/platform.ts
import type { CorpusEntryT } from "../../schema.js";
import { detectPlatform } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import type { DetectorResult } from "../detector-types.js";

export function canAffirm(): boolean {
  return true;
}

/** Recomputed from RECORDED data — provable, no pixels, no image hash. */
export async function detect(entry: CorpusEntryT, _ctx: VerifyCtx): Promise<DetectorResult> {
  const width = entry.image?.width ?? null;
  const height = entry.image?.height ?? null;
  const recorded = entry.platform ?? null;
  if (width === null || height === null || recorded === null) {
    return { verdict: "abstain", measured: null, confidence: 0.5, reason: "image dimensions or recorded platform missing" };
  }
  const recomputed = detectPlatform(width, height);
  return recomputed === recorded
    ? { verdict: "pass", measured: recomputed, confidence: 1, reason: `detectPlatform(${width}, ${height}) matches` }
    : { verdict: "contradicted", measured: recomputed, confidence: 0, reason: `detectPlatform gives ${recomputed}, recorded ${recorded}` };
}
