import { extractAllWcagIds, isWcagCriterion } from "../wcag/registry.js";

export type LegacyRisk = string | {
  element: string;
  risk: string;
  evidence: string;
  confidence: string;
  wcag?: string | string[];
};

export type AccessibilityRiskMigration =
  | { kind: "normalized"; risk: Exclude<LegacyRisk, string> & { wcag: string[] }; wcag: string[] }
  | { kind: "deleted"; rawCitation?: string }
  | { kind: "quarantined"; note: string };

/**
 * Transform one pre-canonical accessibility-risk value. This intentionally
 * accepts decorated citations because it is a one-time legacy migration; live
 * tagger output is constrained separately in sanitizeAccessibilityRisks.
 */
export function transformAccessibilityRisk(risk: LegacyRisk): AccessibilityRiskMigration {
  if (typeof risk === "string") return { kind: "quarantined", note: risk };

  if (Array.isArray(risk.wcag)) {
    const wcag = [...new Set(risk.wcag.map(String))].filter(isWcagCriterion);
    return wcag.length > 0
      ? { kind: "normalized", risk: { ...risk, wcag }, wcag }
      : { kind: "deleted", rawCitation: JSON.stringify(risk.wcag) };
  }

  if (typeof risk.wcag === "string" && risk.wcag.trim()) {
    const wcag = [...new Set(extractAllWcagIds(risk.wcag))].filter(isWcagCriterion);
    return wcag.length > 0
      ? { kind: "normalized", risk: { ...risk, wcag }, wcag }
      : { kind: "deleted", rawCitation: risk.wcag };
  }

  return { kind: "deleted" };
}
