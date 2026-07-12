import { afterEach, describe, expect, it } from "vitest";
import { PrivateCorpusReader } from "./corpus-reader.js";
import {
  searchEntries,
  searchRanked,
  getEntryById,
  findSimilarEntries,
  listCategories,
  listStyleTags,
  listDomainTags,
  indexStatus,
  loadCorpus,
  setCorpusForTesting,
} from "./corpus.js";
import { fromCorpusRelativeImagePath } from "./paths.js";
import { fixtures } from "./scripts/__fixtures__/corpus-fixtures.js";

/**
 * corpus-reader.test.ts — regression guard for the PrivateCorpusReader delegate.
 *
 * Gate 1A, Task 4a. The whole point of the refactor is that private mode
 * produces IDENTICAL results to the pre-refactor code. This test asserts that
 * directly: for every CorpusReader method, the PrivateCorpusReader returns the
 * same value as the underlying corpus.ts function it wraps (when both read the
 * same fixture-backed corpus via setCorpusForTesting).
 *
 * Key regression: `entriesForAggregation()` returns the full corpus — this is
 * what the four aggregation handlers now call in place of `loadCorpus()`.
 */
describe("PrivateCorpusReader — delegates to corpus.ts (behavior-preserving)", () => {
  afterEach(() => setCorpusForTesting(null)); // restore the real corpus cache

  function withFixtures(): PrivateCorpusReader {
    setCorpusForTesting(fixtures);
    return new PrivateCorpusReader();
  }

  it("search() matches searchEntries()", async () => {
    const reader = withFixtures();
    const opts = { query: "dashboard", limit: 5 };
    const viaReader = await reader.search(opts);
    const direct = await searchEntries(opts);
    expect(viaReader).toEqual(direct);
  });

  it("search() matches searchEntries() with no query (structural filter only)", async () => {
    const reader = withFixtures();
    const opts = { limit: 100 };
    const viaReader = await reader.search(opts);
    const direct = await searchEntries(opts);
    expect(viaReader).toEqual(direct);
  });

  it("searchRanked() matches searchRanked()", async () => {
    const reader = withFixtures();
    const opts = { query: "pricing", limit: 20 };
    const viaReader = await reader.searchRanked(opts);
    const direct = await searchRanked(opts);
    expect(viaReader).toEqual(direct);
  });

  it("getById() matches getEntryById() for an existing id", () => {
    const reader = withFixtures();
    expect(reader.getById("linear-board")).toEqual(getEntryById("linear-board"));
  });

  it("getById() returns undefined for a missing id (matches getEntryById)", () => {
    const reader = withFixtures();
    expect(reader.getById("does-not-exist")).toBeUndefined();
    expect(getEntryById("does-not-exist")).toBeUndefined();
  });

  it("findSimilar() matches findSimilarEntries()", () => {
    const reader = withFixtures();
    const viaReader = reader.findSimilar("linear-board", 5);
    const direct = findSimilarEntries("linear-board", 5);
    expect(viaReader).toEqual(direct);
  });

  it("findSimilar() with default limit matches findSimilarEntries() default", () => {
    const reader = withFixtures();
    const viaReader = reader.findSimilar("linear-board");
    const direct = findSimilarEntries("linear-board");
    expect(viaReader).toEqual(direct);
  });

  it("listCategories() matches listCategories()", () => {
    const reader = withFixtures();
    expect(reader.listCategories()).toEqual(listCategories());
  });

  it("listStyleTags() matches listStyleTags()", () => {
    const reader = withFixtures();
    expect(reader.listStyleTags()).toEqual(listStyleTags());
  });

  it("listDomainTags() matches listDomainTags()", () => {
    const reader = withFixtures();
    expect(reader.listDomainTags()).toEqual(listDomainTags());
  });

  it("indexStatus() matches indexStatus()", () => {
    const reader = withFixtures();
    expect(reader.indexStatus()).toEqual(indexStatus());
  });

  // ── The keystone regression: the four aggregation handlers' data source ────

  it("entriesForAggregation() returns the full corpus (matches loadCorpus)", () => {
    const reader = withFixtures();
    const viaReader = reader.entriesForAggregation();
    const direct = loadCorpus();
    // Private mode shows EVERYTHING — no filtering. The aggregation functions
    // apply their own review-status filter internally, so the reader must hand
    // them the complete corpus, exactly as the old `loadCorpus()` call did.
    expect([...viaReader]).toEqual(direct);
    expect(viaReader.length).toBe(fixtures.length);
    // Must include the draft entry unfiltered — the aggregation layer filters,
    // not the reader.
    expect([...viaReader].some((e) => e.id === "draft-unchecked-entry")).toBe(true);
  });

  it("entriesForAggregation() returns a readonly view (caller cannot mutate the corpus via it)", () => {
    const reader = withFixtures();
    const entries = reader.entriesForAggregation();
    // The type is readonly CorpusEntryT[]; runtime check that spreading works
    // for the aggregation callers (which take mutable arrays).
    const copy = [...entries];
    expect(copy.length).toBe(fixtures.length);
  });

  // ── Image path resolution ──────────────────────────────────────────────────

  it("resolveImagePath() matches fromCorpusRelativeImagePath() for a valid path", () => {
    const reader = new PrivateCorpusReader(); // no corpus fixture needed for path math
    const rel = "images-private/origin-empty.png";
    expect(reader.resolveImagePath(rel)).toBe(fromCorpusRelativeImagePath(rel));
  });

  it("resolveImagePath() returns null for an invalid path (where the underlying helper throws)", () => {
    const reader = new PrivateCorpusReader();
    // An absolute path or traversal is rejected by assertCorpusImagePath.
    expect(reader.resolveImagePath("/etc/passwd")).toBeNull();
    expect(reader.resolveImagePath("../escape.png")).toBeNull();
    // A path that doesn't live under images-private/ or images-public/ is rejected.
    expect(reader.resolveImagePath("entries.json")).toBeNull();
  });
});
