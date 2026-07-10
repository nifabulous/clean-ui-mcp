import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { assembleEvidence, classifyCoverage, gateCitations, synthesize, renderDecisionBrief, analyzeDecision, type ExtractedScreen, type SynthesisOutput, type EvidenceBundle } from "./decision-lab.js";
import type { DecisionT } from "./schema.js";
import { tagImage } from "./tagger.js";
import { searchRanked } from "./corpus.js";

vi.mock("./tagger.js", () => ({
  tagImage: vi.fn(),
  hasCritiqueKey: vi.fn(() => true),
  activeProviderName: vi.fn(() => "openai"),
  activeModelName: vi.fn(() => "test-model"),
}));
vi.mock("./corpus.js", () => ({
  searchRanked: vi.fn(),
}));

function makeDecision(): DecisionT {
  return {
    id: "test-decision",
    title: "Test",
    createdAt: "2026-07-10",
    updatedAt: "2026-07-10",
    context: { targetUser: "new users", businessGoal: "clarity", primaryKpi: "signups" },
    scope: "screen",
    directions: [
      { id: "dir-a", name: "A", screens: [{ id: "s1", order: 0, source: "upload", imageRef: "images-private/decisions/a.png" }] },
      { id: "dir-b", name: "B", screens: [{ id: "s2", order: 0, source: "upload", imageRef: "images-private/decisions/b.png" }] },
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

describe("synthesize (mocked provider)", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.AUTO_TAG_PROVIDER = "openai";
    delete process.env.AUTO_TAG_PROVIDER_EXTRACTION;
    delete process.env.AUTO_TAG_PROVIDER_CRITIQUE;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it("makes one API call and returns gated synthesis output", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      const response = JSON.stringify({
        directionRubrics: [{
          directionId: "dir-a",
          scores: [{
            dimension: "visual-hierarchy", score: 4, rationale: "Clear hierarchy",
            evidence: ["dir-a:s1:patternType"],
          }],
        }],
        perspectives: [],
        experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G1"] },
        tradeoffs: [{ description: "T", evidence: ["dir-a:s1:patternType"] }],
      });
      return new Response(JSON.stringify({ output_text: response }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const decision = makeDecision();
    const bundle: EvidenceBundle = {
      evidenceIds: ["dir-a:s1:patternType"],
      catalog: [{ id: "dir-a:s1:patternType", description: "[A] patternType: landing-page" }],
      corpusItems: [],
    };
    const result = await synthesize(decision, bundle);
    expect(callCount).toBe(1);
    expect(result.output.directionRubrics[0].scores).toHaveLength(1);
    expect(result.gateDrops).toBe(0);
  });

  it("retries once when the first response has uncited scores", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      const raw = callCount === 1
        ? { directionRubrics: [{ directionId: "dir-a", scores: [{ dimension: "visual-hierarchy", score: 4, rationale: "R", evidence: ["bogus"] }] }], perspectives: [], experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] }, tradeoffs: [{ description: "T", evidence: ["bogus"] }] }
        : { directionRubrics: [{ directionId: "dir-a", scores: [{ dimension: "visual-hierarchy", score: 4, rationale: "R", evidence: ["dir-a:s1:patternType"] }] }], perspectives: [], experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] }, tradeoffs: [{ description: "T", evidence: ["dir-a:s1:patternType"] }] };
      return new Response(JSON.stringify({ output_text: JSON.stringify(raw) }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const decision = makeDecision();
    const bundle: EvidenceBundle = {
      evidenceIds: ["dir-a:s1:patternType"],
      catalog: [{ id: "dir-a:s1:patternType", description: "[A] patternType: landing-page" }],
      corpusItems: [],
    };
    const result = await synthesize(decision, bundle);
    expect(callCount).toBe(2);
    expect(result.gateRetries).toBe(1);
  });
});

describe("renderDecisionBrief", () => {
  it("renders coverage label and pre-launch caveat", () => {
    const decision = makeDecision();
    const output: SynthesisOutput = {
      directionRubrics: [{ directionId: "dir-a", scores: [{ dimension: "visual-hierarchy", score: 4, rationale: "Clear", evidence: ["dir-a:s1:patternType"] }] }],
      perspectives: [{ lens: "new-user", directionId: "dir-a", reaction: "Clear", observations: [{ note: "Good CTA", evidence: ["dir-a:s1:patternType"] }], concern: "X", confidence: "medium", questionForUsers: "Q?" }],
      experimentBrief: { hypothesis: "Direction A yields more signups", successMetric: "Trial start rate", guardrails: ["Bounce rate < 60%"] },
      tradeoffs: [{ description: "A is clearer but B is more on-brand", evidence: ["dir-a:s1:patternType"] }],
    };
    const md = renderDecisionBrief(decision, output, { coverage: "limited", corpusEntryCount: 3 });
    expect(md).toContain("# Decision brief");
    expect(md).toContain("limited");
    expect(md).not.toContain("Lean");  // no Lean in increment 1
    expect(md).toContain("pre-launch");
    expect(md).toContain("Experiment brief");
  });

  it("does not render a Lean callout", () => {
    const decision = makeDecision();
    const output: SynthesisOutput = {
      directionRubrics: [], perspectives: [],
      experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] },
      tradeoffs: [],
    };
    const md = renderDecisionBrief(decision, output, { coverage: "strong", corpusEntryCount: 10 });
    expect(md.toLowerCase()).not.toContain("recommend");
    expect(md.toLowerCase()).not.toContain("lean toward");
  });
});

describe("analyzeDecision", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.mocked(tagImage).mockResolvedValue({
      patternType: "landing-page", categories: ["marketing-hero"], components: [],
      _raw: { extraction: { patternType: "landing-page", categories: ["marketing-hero"], components: [] } },
    } as any);
    vi.mocked(searchRanked).mockResolvedValue([
      { entry: { id: "stripe-pricing", patternType: "pricing", critique: "Clean", categories: ["pricing"] }, score: 0.8, searchMode: "vector" },
    ]);
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("extracts, retrieves, assembles, synthesizes, and returns an analysis", async () => {
    globalThis.fetch = vi.fn(async () => {
      const response = JSON.stringify({
        directionRubrics: [{ directionId: "dir-a", scores: [{ dimension: "visual-hierarchy", score: 4, rationale: "R", evidence: ["dir-a:s1:patternType"] }] }],
        perspectives: [],
        experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] },
        tradeoffs: [{ description: "T", evidence: ["corpus:stripe-pricing"] }],
      });
      return new Response(JSON.stringify({ output_text: response }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const decision = makeDecision();
    const result = await analyzeDecision(decision);
    expect(result.analysis.status).toBe("analyzed");
    expect(result.analysis.evidenceCoverage).toBe("limited");  // 1 corpus entry
    expect(result.analysis.corpusEntryCount).toBe(1);
    expect(result.analysis.directionRubrics[0].scores[0].dimension).toBe("visual-hierarchy");
    expect(result.brief).toContain("Decision brief");
    expect(tagImage).toHaveBeenCalledTimes(2);  // once per screen
    expect(searchRanked).toHaveBeenCalled();
  });
});
