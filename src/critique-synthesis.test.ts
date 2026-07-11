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

  it("downgrades fabricated-evidence recommendations to observations", () => {
    const draft: CritiqueUiDraft = {
      summary: "Good",
      observations: ["Nice layout."],
      recommendations: [
        { observation: "Something", impact: "UX", recommendation: "Do X", evidence: ["corpus:nonexistent"] },
      ],
      accessibilityRisks: [],
    };
    const result = gateCritique(draft, validIds);
    // I1 fix: fabricated-evidence recs are downgraded to observations, not kept
    expect(result.recommendations.length).toBe(0);
    expect(result.observations.length).toBe(2); // original + downgraded
    expect(result.observations[1]).toMatch(/uncertain/i);
  });

  it("keeps recommendations with at least one valid evidence ID, strips invalid IDs", () => {
    const draft: CritiqueUiDraft = {
      summary: "OK",
      observations: ["Fine."],
      recommendations: [
        { observation: "Low contrast", impact: "A11y", recommendation: "Fix contrast", evidence: ["screen:patternType", "corpus:fabricated"] },
      ],
      accessibilityRisks: [],
    };
    const result = gateCritique(draft, validIds);
    expect(result.recommendations.length).toBe(1);
    expect(result.recommendations[0].evidence).toEqual(["screen:patternType"]); // invalid ID stripped
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
    // Risk with evidence is kept, risk with empty evidence is dropped
    expect(result.accessibilityRisks.length).toBe(1);
    expect(result.accessibilityRisks[0].element).toBe("icon button");
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
    // I1 fix: empty-evidence rec is downgraded to observation, not kept as uncertain rec
    expect(result.recommendations.length).toBe(0);
    expect(result.observations.length).toBe(2); // original + downgraded
  });
});
