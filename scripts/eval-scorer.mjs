/**
 * Raw-output scorer for the tagger evaluation loop.
 *
 * Scores the RAW pre-sanitize model output — NOT the sanitized result. This is
 * the non-circular layer: it counts what the model TRIED to emit before the
 * gates caught it. A prompt change that reduces these counts is a real
 * improvement; scoring sanitized output would be a tautology (100% by
 * construction).
 *
 * Two functions:
 * - scoreExtraction(rawExtraction, goldPatternType): patternType correctness
 *   + pre-gate hallucination counts on extraction prose
 * - scoreCritique(rawCritique): pre-gate hallucination counts on critique prose
 *
 * The regexes mirror the tagger's internal gates (src/tagger.ts lines 75-98,
 * 107-111) so the counts are directly comparable to what the sanitizer drops.
 */

// ─── hallucination detectors (copied EXACTLY from src/tagger.ts to avoid drift) ─
// These count what the model WOULD emit before the gates catch it. The regexes
// must match the tagger's sanitizer exactly — if you change one, change both.
// See tagger.ts lines 77-98 (UNLABELED_CONTROL_RISK), 75 (PIXEL_MEASUREMENT),
// 107-111 (BANNED_PHRASES).
const UNLABELED_CONTROL = new RegExp(
  "\\bicon[\\s-]*only" +
  "|icons?\\s+(?:alone|symbols?\\s+alone)" +
  "|icons?\\s+without\\s+(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|represented\\s+(?:solely\\s+)?by\\s+icons?" +
  "|(?:icon|glyph|symbol|button|control)\\s+with\\s+(?:no|without)\\s+(?:a\\s+)?(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|(?:icon|glyph|symbol|button|control)\\s+(?:has|have|having)\\s+no\\s+(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|(?:icon|glyph|symbol|button|control)\\s+lack(?:s|ing)?\\s+(?:a\\s+)?(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|no\\s+(?:visible\\s+)?(?:text\\s+)?labels?\\s+(?:beside|next to|on|for|is visible)" +
  "|no\\s+(?:visible\\s+)?(?:text\\s+)?labels?\\s+(?:are\\s+)?visible" +
  "|(?:has|have)\\s+no\\s+(?:accompanying\\s+)?(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|no\\s+accompanying\\s+(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|lack(?:s|ing)?\\s+(?:an?\\s+|a\\s+)?(?:accompanying\\s+)?(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|no\\s+(?:visible\\s+)?accessible\\s+name" +
  "|unlabeled\\s+(?:icon|button|control|nav)" +
  "|rel(?:iance|ies|y)\\s+on\\s+(?:memorized\\s+)?(?:icon\\s+)?shapes?" +
  "|\\bnaked\\s+icons?\\b" +
  "|lacks?\\s+(?:an?\\s+)?accessible\\s+name" +
  "|without\\s+(?:an?\\s+)?accessible\\s+name" +
  "\\b",
  "i",
);
const PIXEL_MEASUREMENT = /\b\d+(?:\.\d+)?\s*-?\s*(?:px|pixel[s]?|pt|rem|em)\b/i;
const BANNED_PHRASES = [
  "clean layout", "modern design", "user-friendly", "intuitive", "sleek",
  "minimalist", "good spacing", "nice typography", "visually appealing",
  "easy to use", "well-organized", "polished look",
];

function countMatches(text, regex) {
  if (!text || typeof text !== "string") return 0;
  return (text.match(new RegExp(regex.source, "gi")) || []).length;
}

function countBannedPhrases(text) {
  if (!text || typeof text !== "string") return 0;
  const lower = text.toLowerCase();
  return BANNED_PHRASES.filter((p) => lower.includes(p)).length;
}

/**
 * Flatten all prose fields from a raw model JSON blob into one string.
 * Works for both extraction and critique raw output shapes.
 */
function flattenProse(obj) {
  if (!obj || typeof obj !== "object") return "";
  const parts = [];
  if (typeof obj.draftCritique === "string") parts.push(obj.draftCritique);
  if (typeof obj.critique === "string") parts.push(obj.critique);
  if (Array.isArray(obj.draftWhatToSteal)) parts.push(...obj.draftWhatToSteal.filter((s) => typeof s === "string"));
  if (Array.isArray(obj.whatToSteal)) parts.push(...obj.whatToSteal.filter((s) => typeof s === "string"));
  if (obj.draftAntiPatterns && Array.isArray(obj.draftAntiPatterns)) parts.push(...obj.draftAntiPatterns.filter((s) => typeof s === "string"));
  if (obj.antiPatterns) {
    if (Array.isArray(obj.antiPatterns)) parts.push(...obj.antiPatterns.filter((s) => typeof s === "string"));
    if (Array.isArray(obj.antiPatterns.antiPatterns)) parts.push(...obj.antiPatterns.antiPatterns.filter((s) => typeof s === "string"));
    if (obj.antiPatterns.accessibilityRisks && Array.isArray(obj.antiPatterns.accessibilityRisks)) {
      for (const r of obj.antiPatterns.accessibilityRisks) {
        if (r && typeof r === "object") {
          if (typeof r.risk === "string") parts.push(r.risk);
          if (typeof r.evidence === "string") parts.push(r.evidence);
        }
      }
    }
  }
  if (obj.businessRationale && typeof obj.businessRationale.rationale === "string") parts.push(obj.businessRationale.rationale);
  if (typeof obj.typographyNotes === "string") parts.push(obj.typographyNotes);
  if (Array.isArray(obj.draftAccessibilityRisks)) {
    for (const r of obj.draftAccessibilityRisks) {
      if (r && typeof r === "object") {
        if (typeof r.risk === "string") parts.push(r.risk);
        if (typeof r.evidence === "string") parts.push(r.evidence);
      }
    }
  }
  return parts.join(" \n ");
}

/**
 * Score the RAW pre-sanitize extraction JSON against the gold label.
 *
 * @param {Record<string, unknown>} rawExtraction - the _raw.extraction blob
 * @param {string} goldPatternType - the hand-verified correct patternType
 * @returns {{ patternTypeCorrect: boolean, patternTypeRaw: string, iconOnlyRaw: number, pixelRaw: number, bannedPhrasesRaw: number }}
 */
export function scoreExtraction(rawExtraction, goldPatternType) {
  if (!rawExtraction || typeof rawExtraction !== "object") {
    return { patternTypeCorrect: false, patternTypeRaw: "", iconOnlyRaw: 0, pixelRaw: 0, bannedPhrasesRaw: 0 };
  }
  const prose = flattenProse(rawExtraction);
  const patternTypeRaw = typeof rawExtraction.patternType === "string" ? rawExtraction.patternType.trim() : "";
  return {
    patternTypeCorrect: patternTypeRaw === goldPatternType,
    patternTypeRaw,
    iconOnlyRaw: countMatches(prose, UNLABELED_CONTROL),
    pixelRaw: countMatches(prose, PIXEL_MEASUREMENT),
    bannedPhrasesRaw: countBannedPhrases(prose),
  };
}

/**
 * Score the RAW pre-scrub critique JSON for pre-gate hallucination counts.
 *
 * @param {Record<string, unknown>} rawCritique - the _raw.critique blob
 * @returns {{ bannedPhrasesRaw: number, iconOnlyRaw: number, pixelRaw: number, a11yRiskCount: number, critiqueWords: number }}
 */
export function scoreCritique(rawCritique) {
  if (!rawCritique || typeof rawCritique !== "object") {
    return { bannedPhrasesRaw: 0, iconOnlyRaw: 0, pixelRaw: 0, a11yRiskCount: 0, critiqueWords: 0 };
  }
  const prose = flattenProse(rawCritique);
  const draftCritique = typeof rawCritique.draftCritique === "string" ? rawCritique.draftCritique : "";
  const a11yRisks = Array.isArray(rawCritique.draftAccessibilityRisks) ? rawCritique.draftAccessibilityRisks : [];
  return {
    bannedPhrasesRaw: countBannedPhrases(prose),
    iconOnlyRaw: countMatches(prose, UNLABELED_CONTROL),
    pixelRaw: countMatches(prose, PIXEL_MEASUREMENT),
    a11yRiskCount: a11yRisks.length,
    critiqueWords: draftCritique.trim().split(/\s+/).filter(Boolean).length,
  };
}

/**
 * Summarize a set of per-image scores into baseline metrics.
 * @param {Array} extractionScores - array of scoreExtraction results
 * @param {Array} critiqueScores - array of scoreCritique results
 * @returns {object} summary with averages
 */
export function summarizeScores(extractionScores, critiqueScores) {
  const n = extractionScores.length || 1;
  const patternTypeAccuracy = extractionScores.filter((s) => s.patternTypeCorrect).length / n;
  const avgIconOnlyRaw = extractionScores.reduce((sum, s) => sum + s.iconOnlyRaw, 0) / n;
  const avgBannedPhrasesRaw = critiqueScores.reduce((sum, s) => sum + s.bannedPhrasesRaw, 0) / (critiqueScores.length || 1);
  const avgCritiqueWords = critiqueScores.reduce((sum, s) => sum + s.critiqueWords, 0) / (critiqueScores.length || 1);
  return { patternTypeAccuracy, avgIconOnlyRaw, avgBannedPhrasesRaw, avgCritiqueWords };
}
