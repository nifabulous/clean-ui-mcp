import { describe, expect, it } from "vitest";
import type { CorpusEntryT } from "./schema.js";
import { aggregateAntiPatterns, collectPalettes, collectTechniques, browseByPattern, hueBand } from "./aggregations.js";

function entry(overrides: Partial<CorpusEntryT> & { id: string }): CorpusEntryT {
  return {
    title: `${overrides.id} sample`, patternType: "dashboard",
    categories: ["dashboard"], styleTags: ["minimal"],
    source: { productName: "Test", url: null, capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "", width: null, height: null },
    visual: { dominantColors: ["#ffffff", "#111111"], accentColor: null, typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true },
    critique: "Calm hierarchy.",
    whatToSteal: ["Use quiet grouping and consistent spacing."],
    antiPatterns: { antiPatterns: ["Avoid heavy card shadows for depth."], whereThisFails: [], accessibilityRisks: [] },
    qualityScore: 4, qualityTier: "exceptional", addedAt: "2026-07-01",
    ...overrides,
  } as CorpusEntryT;
}

describe("aggregateAntiPatterns", () => {
  it("dedups near-identical anti-patterns and ranks by consensus", () => {
    const results = aggregateAntiPatterns([
      entry({ id: "a", antiPatterns: { antiPatterns: ["Avoid heavy card shadows for depth — use background-color steps of the same hue instead."], whereThisFails: [], accessibilityRisks: [] } }),
      entry({ id: "b", antiPatterns: { antiPatterns: ["Avoid heavy card shadows for depth — use background-color steps of the same hue, not box-shadow."], whereThisFails: [], accessibilityRisks: [] } }),
      entry({ id: "c", antiPatterns: { antiPatterns: ["Don't use 1px borders everywhere."], whereThisFails: [], accessibilityRisks: [] } }),
    ], {});
    // The two shared-50+-char-prefix "heavy card shadows" variants collapse → count 2.
    expect(results.length).toBe(2);
    expect(results[0].count).toBe(2);
    expect(results[0].text.toLowerCase()).toContain("heavy card shadows");
    expect(results[0].sources).toEqual(["a", "b"]);
  });

  it("respects the patternType filter", () => {
    const results = aggregateAntiPatterns([
      entry({ id: "a", patternType: "modal", antiPatterns: { antiPatterns: ["modal mistake"], whereThisFails: [], accessibilityRisks: [] } }),
      entry({ id: "b", patternType: "dashboard", antiPatterns: { antiPatterns: ["dashboard mistake"], whereThisFails: [], accessibilityRisks: [] } }),
    ], { patternType: "modal" });
    expect(results.length).toBe(1);
    expect(results[0].text).toBe("modal mistake");
  });

  it("returns empty for a category with no entries", () => {
    expect(aggregateAntiPatterns([], {})).toEqual([]);
  });
});

describe("collectPalettes", () => {
  it("filters to entries with colorRoles and tags accent hue", () => {
    const results = collectPalettes([
      entry({ id: "a", visual: { accentColor: null, dominantColors: [], typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true, colorRoles: { canvas: "#ffffff", surface: "#f8f8f8", ink: "#111111", muted: "#888888", accent: "#3b82f6" } } }), // blue
      entry({ id: "b", visual: { accentColor: null, dominantColors: [], typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true, colorRoles: { canvas: "#ffffff", surface: "#f8f8f8", ink: "#111111", muted: "#888888", accent: "#ef4444" } } }), // red
      entry({ id: "c" }), // no colorRoles — skipped
    ], {});
    expect(results.length).toBe(2);
    // Sorted ascending by hue: red (~0) before blue (~217).
    expect(results[0].tokens.accent).toBe("#ef4444");
    expect(hueBand(results[0].accentHue)).toBe("red");
    expect(results[1].tokens.accent).toBe("#3b82f6");
    expect(hueBand(results[1].accentHue)).toBe("blue");
  });

  it("sorts by accent hue for visual grouping", () => {
    const results = collectPalettes([
      entry({ id: "a", visual: { accentColor: null, dominantColors: [], typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true, colorRoles: { canvas: "#fff", surface: "#f8f8f8", ink: "#111", muted: "#888", accent: "#7c3aed" } } }), // purple ~265
      entry({ id: "b", visual: { accentColor: null, dominantColors: [], typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true, colorRoles: { canvas: "#fff", surface: "#f8f8f8", ink: "#111", muted: "#888", accent: "#ef4444" } } }), // red ~0
    ], {});
    expect(results[0].id).toBe("b"); // red (hue 0) before purple (hue 265)
    expect(results[1].id).toBe("a");
  });
});

describe("collectTechniques", () => {
  it("dedups by first 50 chars and keeps variety up to limit", () => {
    const results = collectTechniques([
      entry({ id: "a", whatToSteal: ["Use hairline borders at 10% opacity for structural separation work instead of visible frame borders.", "Reserve accent hue for a single component class (e.g., active toggles only)."] }),
      entry({ id: "b", whatToSteal: ["Use hairline borders at 10% opacity for structural separation work — they read as dividers, not frames."] }), // shares 50+ char prefix → deduped
      entry({ id: "c", whatToSteal: ["Italicize microcopy to add personality without adding visual weight."] }),
    ], {}, 10);
    expect(results.length).toBe(3); // 3 unique after dedup (hairline×2 collapse, italic, reserve)
    expect(results.every((r) => r.source.id && r.source.product)).toBe(true);
  });

  it("respects the limit", () => {
    const results = collectTechniques([
      entry({ id: "a", whatToSteal: ["technique one that is long enough to be distinct from others here."] }),
      entry({ id: "b", whatToSteal: ["technique two that is also long enough to be distinct from others."] }),
    ], {}, 1);
    expect(results.length).toBe(1);
  });
});

describe("browseByPattern", () => {
  it("groups by patternType, counts, and picks the highest-quality exemplar", () => {
    const results = browseByPattern([
      entry({ id: "a", patternType: "dashboard", qualityScore: 4, source: { productName: "Linear", url: null, capturedAt: "2026-07-01", capturedBy: "self" } }),
      entry({ id: "b", patternType: "dashboard", qualityScore: 5, source: { productName: "Linear", url: null, capturedAt: "2026-07-01", capturedBy: "self" } }),
      entry({ id: "c", patternType: "modal", qualityScore: 3, source: { productName: "Stripe", url: null, capturedAt: "2026-07-01", capturedBy: "self" } }),
    ]);
    expect(results[0].patternType).toBe("dashboard"); // 2 entries, ranks first
    expect(results[0].count).toBe(2);
    expect(results[0].exemplar.id).toBe("b"); // higher qualityScore
    expect(results[0].products).toContain("Linear");
    expect(results[1].patternType).toBe("modal");
  });

  it("scopes to a styleTag when provided", () => {
    const results = browseByPattern([
      entry({ id: "a", patternType: "dashboard", styleTags: ["minimal"] }),
      entry({ id: "b", patternType: "dashboard", styleTags: ["brutalist"] }),
    ], { styleTag: "brutalist" });
    expect(results.length).toBe(1);
    expect(results[0].count).toBe(1);
  });
});

describe("hueBand", () => {
  it("maps hues to human-readable band names", () => {
    expect(hueBand(0)).toBe("red");
    expect(hueBand(220)).toBe("blue");
    expect(hueBand(140)).toBe("green");
    expect(hueBand(280)).toBe("purple");
    expect(hueBand(30)).toBe("orange");
  });
});
