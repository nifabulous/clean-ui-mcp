import { describe, expect, it } from "vitest";
import { scoreCritiqueQuality } from "./critique-quality-scorer.mjs";

// Minimal valid structured critique for testing
function makeOutput(overrides = {}) {
  return {
    schemaVersion: "1.0",
    platform: "web",
    retrievalMode: "structured-fallback",
    fallbackUsed: true,
    coverage: "moderate",
    summary: "A dashboard with good structure.",
    observations: ["The sidebar uses a fixed 240px width.", "KPI cards are spaced 16px apart."],
    recommendations: [
      {
        observation: "Low contrast on secondary text",
        impact: "Accessibility",
        recommendation: "Increase contrast ratio",
        evidence: ["screen:visual:usesBorders"],
        basis: "visible",
      },
    ],
    accessibilityRisks: [
      { element: "icon button", risk: "no label", evidence: "screen:components", wcag: ["4.1.2"], basis: "visible" },
    ],
    visualSlop: [],
    motion: [],
    appliedReferences: [],
    evidenceIds: ["screen:patternType", "screen:components", "screen:visual:usesBorders"],
    confidence: "medium",
    ...overrides,
  };
}

const GOLD_LABEL = {
  id: "desktop-dashboard",
  requiredEvidencePrefixes: ["screen:"],
  forbiddenClaims: ["icon-only", "pixel-perfect"],
  motionPolicy: "no-dom-motion",
  md3Expectation: "not-applicable",
  labelVersion: 1,
};

describe("scoreCritiqueQuality", () => {
  it("scores a perfect output with no violations", () => {
    const result = scoreCritiqueQuality(makeOutput(), GOLD_LABEL);
    expect(result.schemaValid).toBe(true);
    expect(result.citationRate).toBe(1.0); // all recs have evidence
    expect(result.bannedPhraseCount).toBe(0);
    expect(result.unknownEvidenceIds).toEqual([]);
    expect(result.forbiddenClaimCount).toBe(0);
    expect(result.overallPass).toBe(true);
  });

  it("detects unknown evidence IDs in recommendations", () => {
    const output = makeOutput({
      recommendations: [{
        observation: "x", impact: "y", recommendation: "z",
        evidence: ["screen:fabricated"], basis: "visible",
      }],
      evidenceIds: ["screen:patternType"],
    });
    const result = scoreCritiqueQuality(output, GOLD_LABEL);
    expect(result.unknownEvidenceIds).toContain("screen:fabricated");
  });

  it("detects banned phrases in the summary", () => {
    const output = makeOutput({ summary: "This design has a clean layout and nice typography." });
    const result = scoreCritiqueQuality(output, GOLD_LABEL);
    expect(result.bannedPhraseCount).toBeGreaterThan(0);
  });

  it("detects forbidden claims", () => {
    const output = makeOutput({ summary: "This is an icon-only design that is pixel-perfect." });
    const result = scoreCritiqueQuality(output, GOLD_LABEL);
    expect(result.forbiddenClaimCount).toBe(2); // "icon-only" + "pixel-perfect"
  });

  it("detects motion claims without DOM grounding", () => {
    const output = makeOutput({
      motion: [{ basis: "editorial", evidence: ["ref:design-engineering"], note: "Smooth animation" }],
    });
    const result = scoreCritiqueQuality(output, GOLD_LABEL);
    // Editorial motion is fine per policy — only DOM-grounded requires dom: evidence
    // But if policy says "no-dom-motion" and motion exists, flag it
    expect(result.motionPolicyViolations).toBe(1);
  });

  it("detects accessibility risks with empty evidence", () => {
    const output = makeOutput({
      accessibilityRisks: [
        { element: "x", risk: "y", evidence: "", wcag: ["1.4.3"], basis: "visible" },
      ],
    });
    const result = scoreCritiqueQuality(output, GOLD_LABEL);
    expect(result.emptyEvidenceRiskCount).toBe(1);
  });

  it("detects non-canonical WCAG IDs", () => {
    const output = makeOutput({
      accessibilityRisks: [
        { element: "x", risk: "y", evidence: "screen:components", wcag: ["9.9.9"], basis: "visible" },
      ],
    });
    const result = scoreCritiqueQuality(output, GOLD_LABEL);
    expect(result.invalidWcagCount).toBe(1);
  });

  it("reports citation rate as fraction of recs with valid evidence", () => {
    const output = makeOutput({
      recommendations: [
        { observation: "a", impact: "b", recommendation: "c", evidence: ["screen:patternType"], basis: "visible" },
        { observation: "d", impact: "e", recommendation: "f", evidence: ["fabricated"], basis: "visible" },
      ],
      evidenceIds: ["screen:patternType"],
    });
    const result = scoreCritiqueQuality(output, GOLD_LABEL);
    expect(result.citationRate).toBe(0.5); // 1 of 2 recs has valid evidence
  });

  it("reports citationRate as 'notScorable' when there are zero recommendations", () => {
    const output = makeOutput({
      recommendations: [],
      accessibilityRisks: [],
    });
    const result = scoreCritiqueQuality(output, GOLD_LABEL);
    expect(result.citationRate).toBe("notScorable");
    // Zero recs = can't verify citation grounding, so the run does not pass.
    expect(result.overallPass).toBe(false);
    expect(result.prefixViolations).toBe(0);
  });

  it("counts a prefix violation when a rec's evidence has no required prefix", () => {
    const output = makeOutput({
      recommendations: [
        // Evidence exists but none starts with the required "screen:" prefix
        { observation: "a", impact: "b", recommendation: "c", evidence: ["corpus:foo"], basis: "visible" },
      ],
      evidenceIds: ["corpus:foo", "screen:patternType"],
    });
    const result = scoreCritiqueQuality(output, GOLD_LABEL);
    expect(result.prefixViolations).toBe(1);
    expect(result.overallPass).toBe(false);
  });

  it("does not count a prefix violation when a rec has no evidence at all", () => {
    const output = makeOutput({
      recommendations: [
        // Empty evidence: skip the prefix check (no evidence to mis-ground)
        { observation: "a", impact: "b", recommendation: "c", evidence: [], basis: "visible" },
      ],
      evidenceIds: ["screen:patternType"],
    });
    const result = scoreCritiqueQuality(output, GOLD_LABEL);
    expect(result.prefixViolations).toBe(0);
  });

  it("passes when every rec's evidence matches a required prefix", () => {
    const output = makeOutput();
    const result = scoreCritiqueQuality(output, GOLD_LABEL);
    expect(result.prefixViolations).toBe(0);
    expect(result.overallPass).toBe(true);
  });
});
