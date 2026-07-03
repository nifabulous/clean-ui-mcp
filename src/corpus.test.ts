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
  it("returns an empty array (not a throw) when the vector index is missing", () => {
    // No VOYAGE_API_KEY in the test env → no index → graceful empty.
    // This is the contract: callers surface a helpful message, they don't crash.
    const results = findSimilarEntries("linear-issue-board-grouped", 5);
    expect(results).toEqual([]);
  });

  it("returns empty for any id when no index exists", () => {
    expect(findSimilarEntries("nonexistent-id", 3)).toEqual([]);
  });
});
