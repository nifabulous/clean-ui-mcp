import { describe, expect, it } from "vitest";
import type { CorpusEntryT } from "./schema.js";
import type { SearchResult } from "./corpus.js";
import { pickDiverse, buildRecommendation } from "./recommend.js";

// recommend.ts is pure — the embedding/search happens in the MCP caller, so
// these tests pass fixture SearchResult[] directly and verify the diversity
// picker + recommendation builder. No Voyage calls, no index dependency.

function entry(id: string, product: string, score: number, patternType = "dashboard"): SearchResult {
  return {
    score,
    searchMode: "vector",
    entry: {
      id, title: `${product} sample`, patternType,
      categories: ["dashboard"], styleTags: ["minimal"],
      source: { productName: product, url: null, capturedAt: "2026-07-01", capturedBy: "self" },
      image: { visibility: "private", path: "", width: null, height: null },
      visual: { dominantColors: ["#ffffff", "#111111"], accentColor: null, typePairing: { display: null, body: null, notes: "Clear hierarchy with restrained type." }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true, colorRoles: { canvas: "#fff", surface: "#f8f8f8", ink: "#111", muted: "#888", accent: "#3b82f6" } },
      critique: "This interface uses a direct visual hierarchy to make scanning feel calm and predictable.",
      whatToSteal: ["Use quiet grouping and consistent spacing to make dense interfaces easier to scan."],
      antiPatterns: { antiPatterns: ["Avoids heavy card shadows; uses background-color steps for depth."], whereThisFails: [], accessibilityRisks: [] },
      qualityScore: 4, qualityTier: "exceptional", addedAt: "2026-07-01",
    } as CorpusEntryT,
  };
}

describe("pickDiverse", () => {
  it("limits per-product to 2 by default to avoid domination", () => {
    const results = [
      entry("a1", "Cash App", 0.9), entry("a2", "Cash App", 0.89), entry("a3", "Cash App", 0.88),
      entry("b1", "Linear", 0.85), entry("c1", "Stripe", 0.84),
    ];
    const picked = pickDiverse(results, 4);
    const cashCount = picked.filter((p) => p.entry.source.productName === "Cash App").length;
    expect(cashCount).toBe(2); // capped at 2 even though 3 are in the top
    expect(picked.length).toBe(4);
  });

  it("backfills from the top when diversity can't be satisfied", () => {
    // Only one product in the pool — picker should fill to count anyway.
    const results = [entry("a1", "Linear", 0.9), entry("a2", "Linear", 0.85), entry("a3", "Linear", 0.8)];
    const picked = pickDiverse(results, 3);
    expect(picked.length).toBe(3);
  });

  it("respects the requested count", () => {
    const results = Array.from({ length: 10 }, (_, i) => entry(`e${i}`, `P${i}`, 0.9 - i * 0.01));
    expect(pickDiverse(results, 3).length).toBe(3);
    expect(pickDiverse(results, 5).length).toBe(5);
  });

  it("walks in score order (highest first)", () => {
    const results = [entry("low", "A", 0.5), entry("high", "B", 0.95)];
    const picked = pickDiverse(results, 1);
    expect(picked[0].entry.id).toBe("high");
  });
});

describe("buildRecommendation", () => {
  it("produces a rationale entry per selected entry, ranked, with contribution notes", () => {
    const results = [entry("a", "Cash App", 0.92), entry("b", "Linear", 0.88), entry("c", "Stripe", 0.85)];
    const rec = buildRecommendation(results, { productContext: "a calm analytics dashboard", count: 3 });
    expect(rec.rationale.length).toBe(3);
    expect(rec.rationale[0].rank).toBe(1);
    expect(rec.rationale[0].score).toBe(0.92);
    expect(rec.rationale[0].note).toContain("color palette"); // entries have colorRoles
  });

  it("folds the product context into the synthesized brief", () => {
    const rec = buildRecommendation([entry("a", "Linear", 0.9)], { productContext: "a pricing page for a fintech" });
    expect(rec.brief.context).toBe("a pricing page for a fintech");
    expect(rec.brief.direction).toContain("a pricing page for a fintech");
  });

  it("caps count at 5 even if more are requested", () => {
    const results = Array.from({ length: 10 }, (_, i) => entry(`e${i}`, `P${i}`, 0.9 - i * 0.01));
    const rec = buildRecommendation(results, { productContext: "test", count: 99 });
    expect(rec.rationale.length).toBe(5);
  });
});
