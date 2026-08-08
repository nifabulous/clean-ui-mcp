// src/verify/detectors/dominant-colors.ts
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import { extractQuantizedColors } from "../../tagger.js";
import type { DetectorResult } from "../detector-types.js";

export function canAffirm(): boolean {
  return true;
}

/** Recomputed from the PIXELS via Vibrant — image-confirmed, bound to the bytes. */
export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const recordedColors = entry.visual?.dominantColors ?? null;
  if (recordedColors === null || recordedColors.length === 0) {
    return { verdict: "abstain", measured: null, confidence: 0.5, reason: "no recorded dominantColors" };
  }
  const extracted = await extractQuantizedColors(ctx.imagePath);
  const extractedSet = new Set(extracted);
  const missing = recordedColors.filter((c) => !extractedSet.has(c.toLowerCase()));
  return missing.length === 0
    ? { verdict: "pass", measured: extracted, confidence: 1, reason: "recorded colors all present in the extracted set" }
    : { verdict: "contradicted", measured: missing, confidence: 0, reason: `recorded colors absent from extraction: ${missing.join(", ")}` };
}
