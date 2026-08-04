import { describe, expect, it } from "vitest";
import { TrustGatedCorpusReader } from "./corpus-trust-reader.js";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";

const VERIFICATION = {
  method: "image-confirmed",
  verifiedAt: "2026-08-04",
  verifierVersion: "v1",
  imageSha256: "a".repeat(64),
};

function entry(id: string, verified: boolean): CorpusEntryT {
  return {
    id,
    source: { productName: `product-${id}` },
    whatToSteal: [`${id} technique`],
    ...(verified ? { provenance: { taggedBy: "auto", verification: VERIFICATION } } : {}),
  } as unknown as CorpusEntryT;
}

const V = entry("verified-1", true);
const U = entry("unverified-1", false);
const ALL = [V, U];

function innerReader(): CorpusReader {
  return {
    search: async () => ALL,
    searchRanked: async () => ALL.map((e, i) => ({ entry: e, score: 5 - i, searchMode: "keyword" as const })),
    getById: (id: string) => ALL.find((e) => e.id === id),
    findSimilar: () => ALL.map((e) => ({ entry: e, score: 1 })),
    listCategories: () => ["dashboard"],
    listStyleTags: () => ["minimal"],
    listDomainTags: () => ["analytics"],
    indexStatus: () => ({ indexed: 0, total: ALL.length, hasIndex: false, missing: 0, stale: 0, contentStale: 0 }),
    entriesForAggregation: () => ALL,
    resolveImagePath: () => null,
  } as unknown as CorpusReader;
}

describe("TrustGatedCorpusReader", () => {
  it("drops unverified entries from search", async () => {
    const r = new TrustGatedCorpusReader(innerReader());
    expect((await r.search({} as never)).map((e) => e.id)).toEqual(["verified-1"]);
  });

  it("drops unverified entries from searchRanked", async () => {
    const r = new TrustGatedCorpusReader(innerReader());
    expect((await r.searchRanked({} as never)).map((x) => x.entry.id)).toEqual(["verified-1"]);
  });

  it("refuses getById for an unverified entry", () => {
    const r = new TrustGatedCorpusReader(innerReader());
    expect(r.getById("verified-1")?.id).toBe("verified-1");
    expect(r.getById("unverified-1")).toBeUndefined();
  });

  it("drops unverified entries from findSimilar", () => {
    const r = new TrustGatedCorpusReader(innerReader());
    expect(r.findSimilar("verified-1", 5).map((x) => x.entry.id)).toEqual(["verified-1"]);
  });

  it("drops unverified entries from entriesForAggregation", () => {
    const r = new TrustGatedCorpusReader(innerReader());
    expect(r.entriesForAggregation().map((e) => e.id)).toEqual(["verified-1"]);
  });

  it("gates taxonomy vocabularies to verified entries", () => {
    const verified = {
      ...V,
      categories: ["dashboard"],
      styleTags: ["minimal"],
      domainTags: ["analytics"],
    };
    const unverified = {
      ...U,
      categories: ["pricing"],
      styleTags: ["dark"],
      domainTags: ["crypto"],
    };
    const all = [verified, unverified];
    const inner = {
      ...innerReader(),
      entriesForAggregation: () => all,
      listCategories: () => ["dashboard", "pricing"],
      listStyleTags: () => ["minimal", "dark"],
      listDomainTags: () => ["analytics", "crypto"],
    } as unknown as CorpusReader;
    const r = new TrustGatedCorpusReader(inner);
    // A label carried only by an unverified entry must not seed filters.
    expect(r.listCategories()).toEqual(["dashboard"]);
    expect(r.listStyleTags()).toEqual(["minimal"]);
    expect(r.listDomainTags()).toEqual(["analytics"]);
  });

  it("distinguishes a refused entry from a missing one", () => {
    // getById answers undefined for both, so a caller that reports "no entry
    // found" would assert non-existence about an entry that exists. This is how a
    // tool tells the two apart without serving the entry.
    const r = new TrustGatedCorpusReader(innerReader());
    expect(r.refusedForTrust("unverified-1")).toBe(true);
    expect(r.refusedForTrust("verified-1")).toBe(false);
    expect(r.refusedForTrust("no-such-entry")).toBe(false);
  });

  it("serves nothing when no entry is verified — the day-one corpus", async () => {
    const inner = {
      ...innerReader(),
      search: async () => [U],
      searchRanked: async () => [{ entry: U, score: 5, searchMode: "keyword" as const }],
      getById: () => U,
      findSimilar: () => [{ entry: U, score: 1 }],
      entriesForAggregation: () => [U],
    } as unknown as CorpusReader;
    const r = new TrustGatedCorpusReader(inner);
    expect(await r.search({} as never)).toEqual([]);
    expect(await r.searchRanked({} as never)).toEqual([]);
    expect(r.getById("unverified-1")).toBeUndefined();
    expect(r.findSimilar("x", 5)).toEqual([]);
    expect(r.entriesForAggregation()).toEqual([]);
    // Still distinguishable from a missing entry.
    expect(r.refusedForTrust("unverified-1")).toBe(true);
  });

  it("reports the trust posture so a caller can tell gated from empty", () => {
    const r = new TrustGatedCorpusReader(innerReader());
    expect(r.trustPosture()).toEqual({ verified: 1, total: 2 });
  });

  it("gates taxonomy vocabularies and passes index counters straight through", () => {
    const r = new TrustGatedCorpusReader(innerReader());
    // The inner reader's own listCategories returns ["dashboard"], but neither
    // fixture entry carries labels, so the gated recompute yields nothing — the
    // pass-through value is deliberately ignored. Index counters stay ungated.
    expect(r.listCategories()).toEqual([]);
    expect(r.indexStatus().total).toBe(2);
  });
});

describe("TrustGatedCorpusReader — the image-embedding route", () => {
  it("drops unverified entries' vectors so critique_ui cannot cite them", async () => {
    // The gate must not hold for prose while leaking through pixels: critique_ui
    // ranks visual similarity through this index, so an ungated index would let
    // an unverified entry become cited critique evidence by the vector route.
    const inner = {
      ...innerReader(),
      getImageIndex: async () => ({
        dimension: 3,
        entries: {
          "verified-1": { vector: [1, 0, 0], hash: "h1" },
          "unverified-1": { vector: [0, 1, 0], hash: "h2" },
        },
      }),
    } as unknown as CorpusReader;
    const index = await new TrustGatedCorpusReader(inner).getImageIndex();
    expect(Object.keys(index!.entries)).toEqual(["verified-1"]);
    expect(index!.dimension).toBe(3);
  });

  it("passes a null index through unchanged", async () => {
    const inner = { ...innerReader(), getImageIndex: async () => null } as unknown as CorpusReader;
    expect(await new TrustGatedCorpusReader(inner).getImageIndex()).toBeNull();
  });
});

describe("TrustGatedCorpusReader — guards that must not fail open", () => {
  it("refuses to double-wrap", () => {
    // A double wrap makes trustPosture() see an already-filtered corpus and
    // report verified === total, which silently reverts every honest
    // "0 of N carry a verification" message to "no matches for those filters".
    const once = new TrustGatedCorpusReader(innerReader());
    expect(() => new TrustGatedCorpusReader(once)).toThrow(/already gating/i);
  });
});
