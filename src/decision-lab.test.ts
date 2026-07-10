import { describe, expect, it } from "vitest";
import { assembleEvidence, classifyCoverage, type ExtractedScreen } from "./decision-lab.js";
import type { DecisionT } from "./schema.js";

function makeDecision(): DecisionT {
  return {
    id: "test-decision",
    title: "Test",
    createdAt: "2026-07-10",
    updatedAt: "2026-07-10",
    context: { targetUser: "new users", businessGoal: "clarity", primaryKpi: "signups" },
    scope: "screen",
    directions: [
      { id: "dir-a", name: "A", screens: [{ id: "s1", order: 0, source: "upload", imageRef: "a.png" }] },
      { id: "dir-b", name: "B", screens: [{ id: "s2", order: 0, source: "upload", imageRef: "b.png" }] },
    ],
  };
}

describe("assembleEvidence", () => {
  it("assigns stable evidence ids to each tagger fact and corpus example", () => {
    const decision = makeDecision();
    const screens: Record<string, ExtractedScreen> = {
      s1: {
        extraction: { patternType: "landing-page", categories: ["marketing-hero"], components: [] },
      },
      s2: {
        extraction: { patternType: "landing-page", categories: ["marketing-hero"], components: ["action-list"] },
      },
    };
    const bundle = assembleEvidence(decision, screens, []);
    // Each tagger fact gets an evidence id like "dir-a:s1:patternType"
    expect(bundle.evidenceIds).toContain("dir-a:s1:patternType");
    expect(bundle.evidenceIds).toContain("dir-b:s2:components");
    // Corpus examples get ids like "corpus:some-entry-id"
    expect(bundle.evidenceIds.filter((e) => e.startsWith("corpus:"))).toEqual([]);
  });

  it("includes corpus examples with their entry ids", () => {
    const decision = makeDecision();
    const screens: Record<string, ExtractedScreen> = {
      s1: { extraction: { patternType: "landing-page", categories: [], components: [] } },
      s2: { extraction: { patternType: "landing-page", categories: [], components: [] } },
    };
    const corpus = [
      { id: "stripe-pricing", patternType: "pricing", critique: "Clean tiers", categories: ["pricing"] },
    ];
    const bundle = assembleEvidence(decision, screens, corpus);
    expect(bundle.evidenceIds).toContain("corpus:stripe-pricing");
  });
});

describe("classifyCoverage", () => {
  it("returns 'strong' when >= 5 corpus entries are retrieved", () => {
    expect(classifyCoverage(5)).toBe("strong");
    expect(classifyCoverage(10)).toBe("strong");
  });
  it("returns 'limited' when 1-4 entries are retrieved", () => {
    expect(classifyCoverage(1)).toBe("limited");
    expect(classifyCoverage(4)).toBe("limited");
  });
  it("returns 'unavailable' when 0 entries are retrieved", () => {
    expect(classifyCoverage(0)).toBe("unavailable");
  });
});
