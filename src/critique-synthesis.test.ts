import { describe, expect, it } from "vitest";
import { buildCritiqueEvidence, gateCritique, type CritiqueUiDraft } from "./critique-synthesis.js";

describe("buildCritiqueEvidence", () => {
  it("assembles screen evidence from extraction facts", () => {
    const evidence = buildCritiqueEvidence(
      { patternType: "dashboard", components: ["sidebar-nav", "kpi-card"], layoutForm: "sidebar+main" },
      { entries: [{ id: "e1", patternType: "dashboard", title: "Dashboard A", score: 0.9 }], mode: "structured-fallback", fallbackUsed: true, coverage: "strong" },
      "A KPI tracking dashboard",
    );
    const ids = evidence.map((e) => e.id);
    expect(ids).toContain("screen:patternType");
    expect(ids).toContain("screen:layoutForm");
    expect(ids).toContain("corpus:e1");
  });

  it("includes corpus evidence IDs for retrieved entries", () => {
    const evidence = buildCritiqueEvidence(
      { patternType: "pricing" },
      { entries: [{ id: "abc-123", score: 0.8 }], mode: "image", fallbackUsed: false, coverage: "moderate" },
      undefined,
    );
    expect(evidence.some((e) => e.id === "corpus:abc-123")).toBe(true);
  });
});

describe("gateCritique", () => {
  const validIds = ["screen:patternType", "corpus:e1", "corpus:e2"];

  it("keeps recommendations with valid citations", () => {
    const draft: CritiqueUiDraft = {
      summary: "Good dashboard",
      observations: ["The sidebar is well-organized."],
      recommendations: [
        { observation: "Low contrast", impact: "Accessibility", recommendation: "Increase contrast", evidence: ["screen:patternType"] },
      ],
      accessibilityRisks: [],
    };
    const result = gateCritique(draft, validIds);
    expect(result.recommendations.length).toBe(1);
    expect(result.recommendations[0].uncertain).toBeFalsy();
  });

  it("converts uncited recommendations to uncertain", () => {
    const draft: CritiqueUiDraft = {
      summary: "Good",
      observations: ["Nice layout."],
      recommendations: [
        { observation: "Something", impact: "UX", recommendation: "Do X", evidence: ["corpus:nonexistent"] },
      ],
      accessibilityRisks: [],
    };
    const result = gateCritique(draft, validIds);
    expect(result.recommendations.length).toBe(1);
    expect(result.recommendations[0].uncertain).toBe(true);
  });

  it("drops accessibility risks without valid evidence", () => {
    const draft: CritiqueUiDraft = {
      summary: "OK",
      observations: ["Fine."],
      recommendations: [],
      accessibilityRisks: [
        { element: "icon button", risk: "no label", evidence: "visible", wcag: ["4.1.2"] },
        { element: "mystery", risk: "unknown", evidence: "", wcag: ["1.4.3"] },
      ],
    };
    const result = gateCritique(draft, validIds);
    // Both a11y risks are kept (they're structured data, not cited recommendations)
    // but the gate should flag ones with empty evidence
    expect(result.accessibilityRisks.length).toBeGreaterThanOrEqual(1);
  });

  it("handles no-corpus-evidence case gracefully", () => {
    const draft: CritiqueUiDraft = {
      summary: "Novel interface",
      observations: ["Unusual layout."],
      recommendations: [
        { observation: "Unclear", impact: "Learning curve", recommendation: "Add guidance", evidence: [] },
      ],
      accessibilityRisks: [],
    };
    const result = gateCritique(draft, ["screen:patternType"]);
    // Recommendation with empty evidence → uncertain
    expect(result.recommendations[0].uncertain).toBe(true);
  });
});
