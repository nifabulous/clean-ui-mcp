// src/verify/detectors/color-roles.ts
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import { ensureRaw } from "../ctx.js";
import type { DetectorResult } from "../detector-types.js";
import { colorStats, deltaE2000, parseHex } from "./pixels.js";

const ROLE_TOLERANCE = 8;
const CANVAS_EQUAL = 8;

/** Contradiction-only: this detector can disprove but never grant a pass. */
export function canAffirm(): boolean {
  return false;
}

const ROLES = ["canvas", "surface", "ink", "muted", "accent"] as const;

export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const roles = entry.visual?.colorRoles;
  if (!roles) {
    return { verdict: "abstain", measured: null, confidence: 0.5, reason: "no recorded colorRoles" };
  }
  const raw = await ensureRaw(ctx);
  const checked: string[] = [];
  const skipped: string[] = [];
  for (const role of ROLES) {
    const hex = roles[role];
    if (hex === null || hex === undefined) continue;
    let target: [number, number, number];
    try {
      target = parseHex(hex);
    } catch {
      skipped.push(role);
      continue;
    }
    const s = colorStats(raw, target, ROLE_TOLERANCE);
    if (s.matchCount === 0) {
      return {
        verdict: "contradicted", measured: { role, hex }, confidence: 0,
        reason: `recorded ${role} ${hex} is absent from the image`,
      };
    }
    checked.push(role);
    if (role === "canvas") {
      if (deltaE2000(target, s.background) > CANVAS_EQUAL) {
        return {
          verdict: "contradicted", measured: { role, hex, background: s.background }, confidence: 0,
          reason: `recorded canvas ${hex} is not the largest-area colour (background is ${s.background.join(",")})`,
        };
      }
    }
  }
  if (skipped.length > 0) {
    return { verdict: "abstain", measured: { checked, skipped }, confidence: 0.5, reason: `unparseable role hexes: ${skipped.join(", ")}` };
  }
  return {
    verdict: "abstain", measured: { checked }, confidence: 0.5,
    reason: "all recorded role hexes are present, but presence does not confirm role assignment",
  };
}
