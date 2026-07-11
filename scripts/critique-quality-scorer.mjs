/**
 * critique-quality-scorer.mjs — deterministic offline scorer for critique output.
 *
 * Scores a StructuredCritique against gold labels WITHOUT requiring any
 * provider credentials. Measures: schema validity, citation rate, unknown
 * evidence IDs, banned phrases, forbidden claims, motion policy violations,
 * empty evidence, invalid WCAG IDs, and overall pass/fail.
 *
 * Exported for testing via `export function scoreCritiqueQuality(output, label)`.
 */
import { BANNED_PHRASES } from "../dist/references/generated.js";
import { isWcagCriterion } from "../dist/wcag/registry.js";

/**
 * @typedef {Object} GoldLabel
 * @property {string} id
 * @property {string[]} requiredEvidencePrefixes - e.g. ["screen:"]
 * @property {string[]} forbiddenClaims - strings that must not appear in summary/observations
 * @property {string} motionPolicy - "no-dom-motion" | "dom-motion-optional" | "dom-motion-required"
 * @property {string} md3Expectation - "not-applicable" | "insufficient-evidence" | "supported"
 * @property {number} labelVersion
 */

/**
 * @typedef {Object} ScoreResult
 * @property {boolean} schemaValid
 * @property {number} citationRate - fraction of recs with at least one valid evidence ID
 * @property {string[]} unknownEvidenceIds - evidence IDs in recs not in the valid set
 * @property {number} bannedPhraseCount - banned phrases found in summary + observations
 * @property {number} forbiddenClaimCount - forbidden claims found in summary
 * @property {number} motionPolicyViolations
 * @property {number} emptyEvidenceRiskCount - a11y risks with empty evidence
 * @property {number} invalidWcagCount - a11y risks with non-canonical WCAG IDs
 * @property {boolean} overallPass
 */

// C3 fix: use the canonical WCAG registry validator instead of a loose regex.
// The regex accepted hallucinated IDs like 9.9.9 and the obsolete 4.1.1;
// isWcagCriterion() rejects both.

/**
 * Score a structured critique output against gold labels.
 * Pure function — no I/O, no network, no credentials.
 *
 * @param {Record<string, unknown>} output - the StructuredCritique
 * @param {GoldLabel} label - the gold label for this fixture
 * @returns {ScoreResult}
 */
export function scoreCritiqueQuality(output, label) {
  const result = {
    schemaValid: false,
    citationRate: 0,
    unknownEvidenceIds: [],
    bannedPhraseCount: 0,
    forbiddenClaimCount: 0,
    motionPolicyViolations: 0,
    emptyEvidenceRiskCount: 0,
    invalidWcagCount: 0,
    overallPass: false,
  };

  // ── Schema validity ──────────────────────────────────────────────────────
  if (!output || typeof output !== "object") return result;
  if (output.schemaVersion !== "1.0") return result;
  if (!Array.isArray(output.recommendations)) return result;
  if (!Array.isArray(output.observations)) return result;
  if (!Array.isArray(output.accessibilityRisks)) return result;
  result.schemaValid = true;

  const validEvidenceSet = new Set(Array.isArray(output.evidenceIds) ? output.evidenceIds : []);

  // ── Citation rate + unknown evidence ──────────────────────────────────────
  let recsWithValidEvidence = 0;
  for (const rec of output.recommendations) {
    const evidence = Array.isArray(rec.evidence) ? rec.evidence : [];
    const hasValid = evidence.some((id) => validEvidenceSet.has(id));
    if (hasValid) recsWithValidEvidence++;
    for (const id of evidence) {
      if (!validEvidenceSet.has(id)) {
        result.unknownEvidenceIds.push(id);
      }
    }
  }
  result.citationRate = output.recommendations.length > 0
    ? recsWithValidEvidence / output.recommendations.length
    : 1.0; // no recs → no citation failure

  // ── Banned phrases in summary + observations ───────────────────────────────
  const proseText = [
    typeof output.summary === "string" ? output.summary.toLowerCase() : "",
    ...output.observations.filter((o) => typeof o === "string").map((o) => o.toLowerCase()),
  ].join(" \n ");
  for (const phrase of BANNED_PHRASES) {
    if (proseText.includes(phrase)) result.bannedPhraseCount++;
  }

  // ── Forbidden claims in summary AND observations (I7 fix) ────────────────────
  const summaryLower = typeof output.summary === "string" ? output.summary.toLowerCase() : "";
  const obsLower = output.observations.filter((o) => typeof o === "string").map((o) => o.toLowerCase()).join(" \n ");
  for (const claim of label.forbiddenClaims) {
    const claimLower = claim.toLowerCase();
    if (summaryLower.includes(claimLower) || obsLower.includes(claimLower)) result.forbiddenClaimCount++;
  }

  // ── Motion policy ──────────────────────────────────────────────────────────
  const motion = Array.isArray(output.motion) ? output.motion : [];
  if (label.motionPolicy === "no-dom-motion" && motion.length > 0) {
    result.motionPolicyViolations = motion.length;
  }

  // ── Accessibility risk quality (I6 fix: guard non-string evidence) ───────────
  for (const risk of output.accessibilityRisks) {
    const evidenceStr = typeof risk.evidence === "string" ? risk.evidence.trim() : "";
    if (!evidenceStr) {
      result.emptyEvidenceRiskCount++;
    }
    const wcag = Array.isArray(risk.wcag) ? risk.wcag : [];
    for (const id of wcag) {
      if (!isWcagCriterion(id)) result.invalidWcagCount++;
    }
  }

  // ── Overall pass (I4 fix: unknown evidence IDs now gate) ──────────────────────
  result.overallPass = result.schemaValid
    && result.citationRate === 1.0
    && result.unknownEvidenceIds.length === 0
    && result.bannedPhraseCount === 0
    && result.forbiddenClaimCount === 0
    && result.motionPolicyViolations === 0
    && result.emptyEvidenceRiskCount === 0
    && result.invalidWcagCount === 0;

  return result;
}
