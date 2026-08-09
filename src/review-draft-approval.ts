import { findDraftMarkers, type CorpusEntryT } from "./schema.js";

export type DraftApprovalInput = {
  critique: string;
  whatToSteal: string[];
  antiPatterns: {
    antiPatterns: string[];
    whereThisFails: string[];
    accessibilityRisks: Array<{ element?: string; risk?: string; evidence?: string; wcag?: string[] }>;
    legacyAccessibilityNotes?: string[];
  };
};

export type DraftApprovalResult =
  | { ok: true; critique: string; whatToSteal: string[] }
  | { ok: false; reason: string };

/** Strings emitted by sanitizer/scrubber paths when a human rewrite is still required. */
const KNOWN_PLACEHOLDER_TEXT = new Set([
  "this critique needs a human rewrite grounded in the screenshot.",
  "this critique contained unsupported component claims and needs a human rewrite based on the screenshot.",
  "review the screenshot and extract one concrete interface technique before saving.",
  "review the screenshot and name one common ui mistake this design avoids.",
  "run 'generate critique' to draft this.",
]);

function stripDraftMarkers(value: string): string {
  return value.replace(/\[(?:DRAFT|PLACEHOLDER|TODO\b)[^\]]*\]\s*/gi, "").trim();
}

function isPlaceholder(value: string): boolean {
  return KNOWN_PLACEHOLDER_TEXT.has(value.replace(/\s+/g, " ").trim().toLowerCase());
}

/**
 * Clean a reviewed draft and prove that marker removal did not turn a known
 * fallback into approved prose. The marker scan runs after stripping, so a
 * caller cannot launder a marker by simply approving the entry as-is.
 */
export function approveDraftText(input: DraftApprovalInput): DraftApprovalResult {
  const critique = stripDraftMarkers(input.critique);
  const whatToSteal = input.whatToSteal.map(stripDraftMarkers);
  const candidate = { ...input, critique, whatToSteal } as CorpusEntryT;
  const dirtyFields = findDraftMarkers(candidate);
  if (dirtyFields.length > 0) {
    return { ok: false, reason: `draft markers remain in ${dirtyFields.join(", ")}` };
  }
  const antiPatternText = [
    ...candidate.antiPatterns.antiPatterns,
    ...candidate.antiPatterns.whereThisFails,
    ...candidate.antiPatterns.accessibilityRisks.flatMap((risk) => [risk.element, risk.risk, risk.evidence]),
    ...(candidate.antiPatterns.legacyAccessibilityNotes ?? []),
  ].filter((value): value is string => typeof value === "string");
  if ([critique, ...whatToSteal, ...antiPatternText].some(isPlaceholder)) {
    return { ok: false, reason: "known placeholder fallback requires a human rewrite" };
  }
  return { ok: true, critique, whatToSteal };
}
