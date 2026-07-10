/**
 * Characterization tests for the raw-output scorer.
 *
 * Locks the CURRENT behavior of scoreExtraction / scoreCritique /
 * summarizeScores so the extraction of shared eval orchestration (Task 2)
 * can't silently drift the scoring contract. These tests document what the
 * scorer does today, not what it "should" do — they are a safety net, not a
 * spec.
 */
import { describe, expect, it } from "vitest";
import { scoreExtraction, scoreCritique, summarizeScores } from "./eval-scorer.mjs";

describe("scoreExtraction", () => {
  it("scores patternType correctness against the gold label", () => {
    const score = scoreExtraction({ patternType: "pricing" }, "pricing");
    expect(score.patternTypeCorrect).toBe(true);
    expect(score.patternTypeRaw).toBe("pricing");
  });

  it("flags a mismatched patternType", () => {
    const score = scoreExtraction({ patternType: "dashboard" }, "pricing");
    expect(score.patternTypeCorrect).toBe(false);
    expect(score.patternTypeRaw).toBe("dashboard");
  });

  it("counts icon-only hallucinations in raw prose", () => {
    const score = scoreExtraction(
      { patternType: "dashboard", typographyNotes: "icon-only button with no label" },
      "dashboard",
    );
    expect(score.iconOnlyRaw).toBeGreaterThan(0);
  });

  it("counts pixel-measurement hallucinations in raw prose", () => {
    const score = scoreExtraction(
      { patternType: "dashboard", typographyNotes: "border-radius is 4px and gap is 16px" },
      "dashboard",
    );
    expect(score.pixelRaw).toBeGreaterThanOrEqual(2);
  });

  it("counts banned phrases in raw prose", () => {
    const score = scoreExtraction(
      { patternType: "dashboard", typographyNotes: "clean layout with nice typography" },
      "dashboard",
    );
    expect(score.bannedPhrasesRaw).toBe(2);
  });

  it("returns zeros for null/undefined input", () => {
    expect(scoreExtraction(null, "pricing")).toMatchObject({
      patternTypeCorrect: false,
      patternTypeRaw: "",
      iconOnlyRaw: 0,
      pixelRaw: 0,
      bannedPhrasesRaw: 0,
    });
  });

  it("returns zeros for non-object input", () => {
    expect(scoreExtraction("not an object", "pricing")).toMatchObject({
      patternTypeCorrect: false,
      iconOnlyRaw: 0,
      pixelRaw: 0,
      bannedPhrasesRaw: 0,
    });
  });

  it("handles missing patternType gracefully", () => {
    const score = scoreExtraction({ typographyNotes: "something" }, "pricing");
    expect(score.patternTypeCorrect).toBe(false);
    expect(score.patternTypeRaw).toBe("");
  });
});

describe("scoreCritique", () => {
  it("counts banned phrases, a11y risks, and critique word count", () => {
    const score = scoreCritique({
      draftCritique: "clean layout, nice typography",
      draftAccessibilityRisks: [{ risk: "x" }],
    });
    expect(score.bannedPhrasesRaw).toBe(2);
    expect(score.a11yRiskCount).toBe(1);
    expect(score.critiqueWords).toBe(4);
  });

  it("counts hallucination signals in critique prose fields", () => {
    const score = scoreCritique({
      draftCritique: "the icon-only nav has a 12px radius",
      draftAccessibilityRisks: [{ risk: "icon-only control without label" }],
    });
    expect(score.iconOnlyRaw).toBeGreaterThan(0);
    expect(score.pixelRaw).toBeGreaterThan(0);
    expect(score.a11yRiskCount).toBe(1);
  });

  it("returns zeros for null/undefined input", () => {
    expect(scoreCritique(null)).toMatchObject({
      bannedPhrasesRaw: 0,
      iconOnlyRaw: 0,
      pixelRaw: 0,
      a11yRiskCount: 0,
      critiqueWords: 0,
    });
  });

  it("handles missing draftCritique (word count = 0)", () => {
    const score = scoreCritique({ draftAccessibilityRisks: [] });
    expect(score.critiqueWords).toBe(0);
    expect(score.a11yRiskCount).toBe(0);
  });
});

describe("summarizeScores", () => {
  it("preserves the existing baseline metric math", () => {
    expect(
      summarizeScores(
        [{ patternTypeCorrect: true, iconOnlyRaw: 1, bannedPhrasesRaw: 0 }],
        [{ bannedPhrasesRaw: 2, iconOnlyRaw: 0, pixelRaw: 0, a11yRiskCount: 1, critiqueWords: 42 }],
      ),
    ).toMatchObject({
      patternTypeAccuracy: 1,
      avgIconOnlyRaw: 1,
      avgBannedPhrasesRaw: 2,
      avgCritiqueWords: 42,
    });
  });

  it("computes patternType accuracy as fraction correct", () => {
    const summary = summarizeScores(
      [
        { patternTypeCorrect: true, iconOnlyRaw: 0 },
        { patternTypeCorrect: false, iconOnlyRaw: 2 },
        { patternTypeCorrect: true, iconOnlyRaw: 0 },
      ],
      [],
    );
    expect(summary.patternTypeAccuracy).toBeCloseTo(2 / 3);
    expect(summary.avgIconOnlyRaw).toBeCloseTo(2 / 3);
  });

  it("handles empty extraction arrays without NaN", () => {
    const summary = summarizeScores([], [{ critiqueWords: 10, bannedPhrasesRaw: 0, iconOnlyRaw: 0, pixelRaw: 0, a11yRiskCount: 0 }]);
    expect(summary.patternTypeAccuracy).toBe(0);
    expect(summary.avgIconOnlyRaw).toBe(0);
  });
});
