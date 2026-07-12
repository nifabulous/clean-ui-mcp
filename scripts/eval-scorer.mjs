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
 * The rules are imported from the canonical generated artifact so the counts
 * remain directly comparable to what the sanitizer drops.
 */

import {
  BANNED_PHRASES,
  PIXEL_MEASUREMENT,
  UNLABELED_CONTROL_RISK as UNLABELED_CONTROL,
} from "../dist/references/generated.js";

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

/**
 * Summarize a set of critique-quality scores (from scoreCritiqueQuality) into
 * aggregate metrics.
 *
 * overallPassRate counts ONLY scorable cases (those with >=1 recommendation).
 * notScorable cases (zero recommendations) are reported separately via
 * notScorableCount so they don't get folded into the pass rate. With zero
 * scorable cases overallPassRate is 0, not 1.0 — a vacuously perfect run on
 * unscorable output would be misleading.
 *
 * @param {Array} scores - array of scoreCritiqueQuality results (may include
 *   error stubs; those are filtered out before aggregation)
 * @returns {object} summary with aggregate critique-quality metrics
 */
export function summarizeCritiqueQuality(scores) {
  const valid = scores.filter(s => s && !s.error);
  if (valid.length === 0) return { schemaValidRate: 0, avgCitationRate: 0, overallPassRate: 0, notScorableCount: 0, scorableCount: 0, totalBannedPhrases: 0, totalInvalidWcag: 0, critiqueQualityErrorCount: scores.filter(s => s?.error).length };
  const schemaValid = valid.filter(s => s.schemaValid).length;
  const notScorable = valid.filter(s => s.citationRate === "notScorable");
  const scorable = valid.filter(s => s.citationRate !== "notScorable");
  const passCount = scorable.filter(s => s.overallPass).length;
  const avgCitation = scorable.length > 0
    ? scorable.reduce((sum, s) => sum + (s.citationRate ?? 0), 0) / scorable.length
    : 0;
  const banned = valid.reduce((sum, s) => sum + (s.bannedPhraseCount ?? 0), 0);
  const invalidWcag = valid.reduce((sum, s) => sum + (s.invalidWcagCount ?? 0), 0);
  return {
    schemaValidRate: schemaValid / valid.length,
    avgCitationRate: avgCitation,
    overallPassRate: scorable.length > 0 ? passCount / scorable.length : 0,
    notScorableCount: notScorable.length,
    scorableCount: scorable.length,
    totalBannedPhrases: banned,
    totalInvalidWcag: invalidWcag,
    critiqueQualityErrorCount: scores.filter(s => s?.error).length,
  };
}
