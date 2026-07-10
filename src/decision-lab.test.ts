import { describe, expect, it } from "vitest";
import { assembleEvidence, classifyCoverage, gateCitations, type ExtractedScreen, type SynthesisOutput } from "./decision-lab.js";
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

const validEvidenceIds = ["dir-a:s1:patternType", "corpus:stripe-pricing", "dir-b:s2:components"];

describe("gateCitations", () => {
  it("keeps rubric scores whose evidence ids are all valid", () => {
    const output: SynthesisOutput = {
      directionRubrics: [{
        directionId: "dir-a",
        scores: [{
          dimension: "visual-hierarchy",
          score: 4,
          rationale: "Clear F-pattern",
          evidence: ["dir-a:s1:patternType"],
        }],
      }],
      perspectives: [],
      experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] },
      tradeoffs: [{ description: "T", evidence: ["dir-a:s1:patternType"] }],
    };
    const result = gateCitations(output, validEvidenceIds);
    expect(result.dropped).toBe(0);
    expect(result.output.directionRubrics[0].scores).toHaveLength(1);
  });

  it("drops rubric scores that cite a non-existent evidence id", () => {
    const output: SynthesisOutput = {
      directionRubrics: [{
        directionId: "dir-a",
        scores: [
          { dimension: "visual-hierarchy", score: 4, rationale: "Good", evidence: ["dir-a:s1:patternType"] },
          { dimension: "cognitive-load", score: 3, rationale: "Maybe", evidence: ["made-up-id"] },
        ],
      }],
      perspectives: [],
      experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] },
      tradeoffs: [{ description: "T", evidence: ["dir-a:s1:patternType"] }],
    };
    const result = gateCitations(output, validEvidenceIds);
    expect(result.dropped).toBe(1);
    expect(result.output.directionRubrics[0].scores).toHaveLength(1);
    expect(result.output.directionRubrics[0].scores[0].dimension).toBe("visual-hierarchy");
  });

  it("drops perspective observations with uncited evidence", () => {
    const output: SynthesisOutput = {
      directionRubrics: [{ directionId: "dir-a", scores: [{ dimension: "goal-alignment", score: 4, rationale: "R", evidence: ["dir-a:s1:patternType"] }] }],
      perspectives: [{
        lens: "new-user",
        directionId: "dir-a",
        reaction: "Clear",
        observations: [
          { note: "Good CTA", evidence: ["corpus:stripe-pricing"] },
          { note: "Speculation", evidence: ["invented-id"] },
        ],
        concern: "X",
        confidence: "medium",
        questionForUsers: "Q?",
      }],
      experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] },
      tradeoffs: [{ description: "T", evidence: ["dir-a:s1:patternType"] }],
    };
    const result = gateCitations(output, validEvidenceIds);
    expect(result.dropped).toBe(1);
    expect(result.output.perspectives[0].observations).toHaveLength(1);
  });

  it("drops tradeoffs with uncited evidence", () => {
    const output: SynthesisOutput = {
      directionRubrics: [{ directionId: "dir-a", scores: [{ dimension: "goal-alignment", score: 4, rationale: "R", evidence: ["dir-a:s1:patternType"] }] }],
      perspectives: [],
      experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] },
      tradeoffs: [{ description: "bad", evidence: ["nope"] }],
    };
    const result = gateCitations(output, validEvidenceIds);
    expect(result.dropped).toBe(1);
    expect(result.output.tradeoffs).toHaveLength(0);
  });
});
