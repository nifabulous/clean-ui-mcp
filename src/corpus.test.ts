import { describe, expect, it } from "vitest";
import { getEntryById, listCategories, listStyleTags, searchEntries, findSimilarEntries } from "./corpus.js";

describe("corpus search", () => {
  it("loads known entries by id", () => {
    const entry = getEntryById("linear-issue-board-grouped");

    expect(entry?.source.productName).toBe("Linear");
  });

  it("lists categories and style tags present in the corpus", () => {
    expect(listCategories()).toContain("pricing");
    expect(listStyleTags()).toContain("dense-data");
  });

  it("finds entries with token-based keyword search", async () => {
    const results = await searchEntries({ query: "dark dense data", limit: 1 });

    expect(results[0]?.id).toBe("linear-issue-board-grouped");
  });

  it("combines structural filters with keyword search", async () => {
    const results = await searchEntries({
      query: "plan table",
      category: "pricing",
      minQuality: 5,
      limit: 5,
    });

    expect(results.map((entry) => entry.id)).toContain("stripe-pricing-page-2025");
  });
});

describe("findSimilarEntries", () => {
  it("returns ranked results (or empty) without throwing, regardless of index state", () => {
    // The index may or may not exist depending on whether build-index was run.
    // The contract: never throw — return results or [] gracefully.
    const results = findSimilarEntries("linear-issue-board-grouped", 5);
    expect(Array.isArray(results)).toBe(true);
    // If results exist, they must exclude the source entry and be score-descending.
    if (results.length > 0) {
      expect(results.every((r) => r.entry.id !== "linear-issue-board-grouped")).toBe(true);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    }
  });

  it("returns empty for an id that's not in the index", () => {
    expect(findSimilarEntries("nonexistent-id", 3)).toEqual([]);
  });
});
