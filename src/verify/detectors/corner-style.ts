// src/verify/detectors/corner-style.ts
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import { ensureRaw } from "../ctx.js";
import {
  inBand,
  recordedFor,
  type ConfidenceBand,
  type DetectorResult,
} from "../detector-types.js";
import { cornerMeasure, largestComponent } from "./pixels.js";

/** Declared here; the registry references this value (single source of truth). */
export const confidenceBand: ConfidenceBand = { low: 0.25, high: 0.75 };
const BOUNDARY_MARGIN = 2; // px; inside this distance of a bucket boundary -> band

const AFFIRMABLE = new Set(["sharp", "slight-round", "pill"]);

export function canAffirm(recorded: unknown): boolean {
  return typeof recorded === "string" && AFFIRMABLE.has(recorded);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const recorded = recordedFor(entry, "visual.cornerStyle");
  if (!canAffirm(recorded)) {
    return {
      verdict: "abstain", measured: recorded, confidence: 0.5,
      reason: "mixed (or unaffirmable) corner style cannot be certified by a single-radius measurement",
    };
  }
  const raw = await ensureRaw(ctx);
  const box = largestComponent(raw);
  if (!box || box.area < 64) {
    return { verdict: "abstain", measured: null, confidence: 0.5, reason: "no measurable component" };
  }
  const m = cornerMeasure(raw, box);
  if (m.consistency < 0.7) {
    return { verdict: "abstain", measured: m, confidence: 0.5, reason: "corners disagree (consistency below 0.7)" };
  }
  const distanceToBoundary = Math.min(Math.abs(m.radius - 2), Math.abs(m.radius - 20));
  const confidence = clamp01(0.5 - 0.5 * (distanceToBoundary / BOUNDARY_MARGIN));
  if (inBand(confidenceBand, confidence)) {
    return { verdict: "abstain", measured: m, confidence, reason: `radius ${m.radius.toFixed(1)}px is inside the bucket boundary band` };
  }
  const measured = m.radius <= 2 ? "sharp" : m.radius <= 20 ? "slight-round" : "pill";
  return measured === recorded
    ? { verdict: "pass", measured: m, confidence, reason: `measured ${measured} (radius ${m.radius.toFixed(1)}px) matches recorded ${recorded}` }
    : { verdict: "contradicted", measured: m, confidence, reason: `measured ${measured} (radius ${m.radius.toFixed(1)}px), recorded ${recorded}` };
}
