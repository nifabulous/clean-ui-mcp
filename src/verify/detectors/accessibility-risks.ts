// src/verify/detectors/accessibility-risks.ts
// culori ships no type declarations (TS7016); usage is typed at the call site.
// @ts-expect-error — no bundled or @types declaration exists for culori.
import { wcagContrast } from "culori";
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import type { DetectorResult } from "../detector-types.js";

/** Contradiction-only: contrast arithmetic can disprove a listed risk, never confirm the field. */
export function canAffirm(): boolean {
  return false;
}

// Contrast criteria, read from the REQUIRED canonical `wcag[]` array — never from
// the risk prose. Measured over the real corpus: 2 of 11 risks name a contrast
// criterion in `wcag[]`; ZERO name one in the prose, and zero carry two hexes
// anywhere. A prose-parsing detector abstains on 11 of 11 forever.
const CONTRAST_CRITERIA: Record<string, number> = { "1.4.3": 4.5, "1.4.11": 3.0 };
const CLEAR_MARGIN = 0.5; // must comfortably clear the threshold to contradict

/**
 * Which colorRoles pair a risk's `element` refers to. The risks carry no hexes,
 * so the pair must come from the recorded roles; an element we cannot map is
 * abstained rather than guessed.
 */
function rolePairFor(element: string): { fg: "ink" | "muted" | "accent"; bg: "canvas" } | null {
  const e = element.toLowerCase();
  if (/\b(muted|secondary|placeholder|caption|hint)\b/.test(e)) return { fg: "muted", bg: "canvas" };
  if (/\b(button|link|cta|action)\b/.test(e)) return { fg: "accent", bg: "canvas" };
  if (/\b(text|body|label|heading|title|paragraph)\b/.test(e)) return { fg: "ink", bg: "canvas" };
  return null;
}

export async function detect(entry: CorpusEntryT, _ctx: VerifyCtx): Promise<DetectorResult> {
  const risks = entry.antiPatterns?.accessibilityRisks ?? [];
  if (risks.length === 0) {
    return { verdict: "abstain", measured: null, confidence: 0.5, reason: "no recorded accessibility risks" };
  }
  const roles = entry.visual?.colorRoles ?? null;
  for (const r of risks) {
    // `wcag` is required and canonical (schema.ts:232); a risk may list up to 3.
    const criterion = (r.wcag ?? []).find((w) => w in CONTRAST_CRITERIA);
    if (criterion === undefined) continue;
    const pair = rolePairFor(r.element ?? "");
    if (pair === null || roles === null) continue;
    const fg = (roles as Record<string, string | null | undefined>)[pair.fg];
    const bg = (roles as Record<string, string | null | undefined>)[pair.bg];
    // `muted` is nullable (schema.ts:419-425) — an absent side is unverifiable.
    if (!fg || !bg) continue;
    const ratio = wcagContrast(fg, bg);
    if (typeof ratio !== "number" || Number.isNaN(ratio)) continue;
    const threshold = CONTRAST_CRITERIA[criterion];
    if (ratio >= threshold + CLEAR_MARGIN) {
      return {
        verdict: "contradicted",
        measured: { element: r.element, criterion, fg, bg, ratio },
        confidence: 0,
        reason: `listed ${criterion} risk on "${r.element}" is arithmetically false: ${pair.fg} ${fg} on ${pair.bg} ${bg} is ${ratio.toFixed(2)}:1, clearing ${threshold}:1`,
      };
    }
  }
  return {
    verdict: "abstain", measured: null, confidence: 0.5,
    reason: "no listed contrast risk was disproven (no contrast criterion in wcag[], no resolvable role pair, or the ratio is genuinely low)",
  };
}
