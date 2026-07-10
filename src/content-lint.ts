/**
 * Content-quality lint for anti-pattern text fields.
 *
 * Two severity levels:
 * - VAGUE PHRASES → hard block at save time (findVagueAntiPatterns). These are
 *   genuinely never high-value anti-pattern statements — "keep it clean,"
 *   "avoid clutter," "bad ux" are the exact slop the corpus exists to reject.
 * - SHORT WORD COUNT → warning only (lintAntiPattern, surfaced by corpus-stats).
 *   A 6-7 word anti-pattern that names a specific technique ("Hairline borders
 *   instead of heavy frame borders") is legitimate. The schema's min(10) chars
 *   already enforces a floor; the word count is a heuristic, not an absolute.
 *
 * Scope: antiPatterns.antiPatterns only. Not critique, whatToSteal, or a11y
 * fields — those are different quality dimensions where phrases may be direct
 * quotes.
 */
import type { CorpusEntryT } from "./schema.js";

export const VAGUE_PHRASES = [
  "avoid clutter", "keep it clean", "keep it simple", "don't overdo it",
  "be consistent", "avoid confusion", "too busy", "too much going on",
  "not intuitive", "bad ux", "poor ux",
] as const;

export const MIN_WORDS = 8;

/**
 * Normalize curly/typographic apostrophes to straight ASCII so the single
 * phrase containing an apostrophe ("don't overdo it") matches regardless of
 * which quote character the author's editor inserted.
 */
function normalizeForMatching(text: string): string {
  return text.toLowerCase().replace(/[\u2018\u2019]/g, "'");
}

/** Report both vague phrases and short word-count for a single text string. */
export function lintAntiPattern(text: string): string[] {
  const issues: string[] = [];
  const lower = normalizeForMatching(text);
  for (const phrase of VAGUE_PHRASES) {
    if (lower.includes(phrase)) issues.push(`generic filler: "${phrase}"`);
  }
  if (text.trim().split(/\s+/).length < MIN_WORDS) {
    issues.push(`too short (<${MIN_WORDS} words)`);
  }
  return issues;
}

/**
 * Find vague phrases in an entry's antiPatterns.antiPatterns — HARD-BLOCK issues.
 * Returns field paths + issue strings. Empty array = clean (safe to save).
 * Does NOT include the short-word-count check (that's a warning, not a block).
 */
export function findVagueAntiPatterns(entry: CorpusEntryT): Array<{ field: string; issues: string[] }> {
  return entry.antiPatterns.antiPatterns
    .map((text, i) => {
      const lower = normalizeForMatching(text);
      const issues = VAGUE_PHRASES
        .filter((p) => lower.includes(p))
        .map((p) => `generic filler: "${p}"`);
      return { field: `antiPatterns.antiPatterns[${i}]`, issues };
    })
    .filter((r) => r.issues.length > 0);
}
