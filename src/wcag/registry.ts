/**
 * WCAG 2.2 criterion registry — canonical ID validation and title lookup.
 *
 * The corpus stores accessibility-risk citations as bare canonical IDs
 * (e.g. "1.4.3"). This module is the single source of truth for which IDs
 * exist and what their human-readable titles are. Titles are never persisted
 * on risks — they are looked up at display time so a registry refresh can fix
 * a title without a corpus edit.
 *
 * Referential integrity only: a valid ID proves the cited criterion EXISTS in
 * WCAG 2.2, not that a screenshot violates it. The evidence/contrast/pixel
 * gates in the tagger remain the authority on whether a risk is real.
 */
import { WCAG_2_2, type WcagCriterion } from "./wcag-2.2.js";

/**
 * IDs removed in WCAG 2.2. The W3C JSON retains them historically but marks them
 * obsolete. Since the corpus accepts WCAG 2.2 as the sole citation version, a
 * removed criterion is treated as non-citable. 4.1.1 Parsing was the sole SC
 * removed in the 2.0→2.2 transition.
 */
const OBSOLETE_IDS = new Set(["4.1.1"]);

/** Active (non-obsolete) WCAG 2.2 criteria — the citable set. */
const ACTIVE = Object.freeze(WCAG_2_2.filter((c) => !OBSOLETE_IDS.has(c.id)));

/** ID → criterion, for O(1) membership and title lookup. */
const BY_ID = new Map<string, WcagCriterion>(ACTIVE.map((c) => [c.id, c]));

/** Bare numeric WCAG ID (e.g. "1.4.3", "2.4.7"). */
const ID_PATTERN = /^\d+\.\d+\.\d+$/;

/**
 * Extract a bare canonical ID from a citation string that may be:
 *  - already a bare ID: "1.4.3"
 *  - a titled citation: "1.4.3 Contrast (Minimum)"
 *  - a comma-joined multi-citation: "1.4.1 Use of Color, 2.4.7 Focus Visible"
 *
 * Returns null if no leading numeric ID is found. Does NOT validate that the
 * extracted ID exists in the registry — call isWcagCriterion() for that.
 */
export function extractWcagId(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const m = raw.match(/(\d+\.\d+\.\d+)/);
  return m ? m[1] : null;
}

/**
 * Split a citation string into its constituent bare IDs, handling the
 * comma-joined multi-citation form that older corpus entries use
 * ("1.4.1 Use of Color, 2.4.7 Focus Visible" → ["1.4.1", "2.4.7"]).
 */
export function extractAllWcagIds(raw: string): string[] {
  if (typeof raw !== "string") return [];
  return (raw.match(/\d+\.\d+\.\d+/g) ?? []).map((s) => s);
}

/** True iff `id` is a bare numeric WCAG 2.2 success-criterion ID that exists. */
export function isWcagCriterion(id: string): boolean {
  return typeof id === "string" && ID_PATTERN.test(id) && BY_ID.has(id);
}

/**
 * Look up the canonical title for an ID (e.g. "1.4.3" → "Contrast (Minimum)").
 * Returns undefined for unknown IDs — callers should guard with isWcagCriterion.
 */
export function getWcagTitle(id: string): string | undefined {
  return BY_ID.get(id)?.title;
}

/** The W3C level (A / AA / AAA) for a criterion, or undefined if unknown. */
export function getWcagLevel(id: string): string | undefined {
  return BY_ID.get(id)?.level;
}

/**
 * Format an ID for display, appending the registry title:
 * "1.4.3" → "1.4.3 Contrast (Minimum)". Falls back to the bare ID if the
 * title is unknown (so display never breaks on an unrecognized ID).
 */
export function formatWcagCitation(id: string): string {
  const title = getWcagTitle(id);
  return title ? `${id} ${title}` : id;
}

/** All active (non-obsolete) canonical WCAG 2.2 criteria (frozen, read-only). */
export function allWcagCriteria(): readonly WcagCriterion[] {
  return ACTIVE;
}
