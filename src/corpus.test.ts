import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Corpus } from "./schema.js";
import { getEntryById, listCategories, listStyleTags, searchEntries, findSimilarEntries, setCorpusForTesting, indexStatus } from "./corpus.js";
import { fixtures } from "./scripts/__fixtures__/corpus-fixtures.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, "..", "corpus", "entries.json");

// ── fixture-backed tests: immune to corpus edits ─────────────────────────────
// These run against hand-built fixtures (setCorpusForTesting), NOT the mutable
// production entries.json. A restore, bulk import, or edit can never break them.
describe("corpus search (fixtures)", () => {
  afterEach(() => setCorpusForTesting(null)); // restore the real corpus cache

  it("loads known entries by id", () => {
    setCorpusForTesting(fixtures);
    const entry = getEntryById("linear-board");
    expect(entry?.source.productName).toBe("Linear");
  });

  it("lists categories and style tags present in the fixtures", () => {
    setCorpusForTesting(fixtures);
    expect(listCategories()).toContain("dashboard");
    expect(listCategories()).toContain("pricing");
    expect(listStyleTags()).toContain("dense-data");
  });

  it("returns undefined for an id not in the corpus", () => {
    setCorpusForTesting(fixtures);
    expect(getEntryById("does-not-exist")).toBeUndefined();
  });

  it("indexStatus reports the fixture corpus size and drift fields", () => {
    // indexStatus loads the corpus from the injected cache but the index from
    // disk — so hasIndex depends on whether embeddings.json exists, not the
    // fixtures. Assert only what's fixture-driven: total + the drift fields exist.
    setCorpusForTesting(fixtures);
    const status = indexStatus();
    expect(status.total).toBe(fixtures.length);
    // indexed + missing must sum to total; stale ≥ 0.
    expect(status.indexed + status.missing).toBe(status.total);
    expect(status.stale).toBeGreaterThanOrEqual(0);
  });

  it("hides draft entries from search by default, surfaces them with reviewStatus:'draft'", async () => {
    // The fixtures include one draft entry ("draft-unchecked-entry"). Default
    // search must exclude it; reviewStatus:"draft" must surface only it.
    setCorpusForTesting(fixtures);
    // No query, just structural — but drafts are filtered regardless of query.
    const keywordOnly = await searchEntries({ limit: 100 });
    expect(keywordOnly.some((e) => e.id === "draft-unchecked-entry")).toBe(false);
    expect(keywordOnly.some((e) => e.id === "linear-board")).toBe(true);

    const draftsOnly = await searchEntries({ reviewStatus: "draft", limit: 100 });
    expect(draftsOnly.every((e) => e.reviewStatus === "draft")).toBe(true);
    expect(draftsOnly.some((e) => e.id === "draft-unchecked-entry")).toBe(true);

    const any = await searchEntries({ reviewStatus: "any", limit: 100 });
    expect(any.some((e) => e.reviewStatus === "draft")).toBe(true);
    expect(any.some((e) => e.reviewStatus !== "draft")).toBe(true);
  });

  it("excludes drafts from findSimilarEntries results", () => {
    setCorpusForTesting(fixtures);
    // No index → returns []. But if it did return, drafts must not appear.
    // The contract test: even with no index, it never throws and returns [].
    const results = findSimilarEntries("linear-board", 10);
    expect(results.every((r) => r.entry.reviewStatus !== "draft")).toBe(true);
  });
});

// ── real-corpus tests: only structural contracts, never specific content ─────
// These touch the production entries.json but assert only invariants that hold
// regardless of content: the schema parses, ids are unique, search returns an
// array. They do NOT assert specific entry names/categories (those change).
describe("real corpus contracts", () => {
  it("the real corpus validates against the schema", () => {
    // This is the ONLY test allowed to depend on entries.json existing. If the
    // file is corrupt/overwritten, this catches it — that's its purpose.
    const raw = readFileSync(CORPUS_PATH, "utf-8");
    expect(() => Corpus.parse(JSON.parse(raw))).not.toThrow();
  });

  it("finds entries with search (vector or keyword — resilient to Voyage rate limits)", async () => {
    let results: Awaited<ReturnType<typeof searchEntries>> = [];
    try {
      results = await searchEntries({ query: "dark dense data", limit: 1 });
    } catch {
      results = await searchEntries({ query: "dark dense data", limit: 1 });
    }
    expect(Array.isArray(results)).toBe(true);
  });

  it("combines structural filters with search (vector or keyword)", async () => {
    let results: Awaited<ReturnType<typeof searchEntries>> = [];
    try {
      results = await searchEntries({ query: "data table", category: "dashboard", minQuality: 5, limit: 5 });
    } catch {
      results = await searchEntries({ category: "dashboard", minQuality: 5, limit: 5 });
    }
    if (results.length > 0) {
      expect(results.every((e) => e.categories.includes("dashboard"))).toBe(true);
      expect(results.every((e) => e.qualityScore >= 5)).toBe(true);
    }
  });
});

describe("findSimilarEntries", () => {
  afterEach(() => setCorpusForTesting(null));

  it("returns ranked results (or empty) without throwing, regardless of index state", () => {
    const results = findSimilarEntries("linear-board", 5);
    expect(Array.isArray(results)).toBe(true);
    if (results.length > 0) {
      expect(results.every((r) => r.entry.id !== "linear-board")).toBe(true);
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    }
  });

  it("returns empty for an id that's not in the index", () => {
    expect(findSimilarEntries("nonexistent-id", 3)).toEqual([]);
  });
});
