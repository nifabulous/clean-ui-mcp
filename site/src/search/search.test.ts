import { describe, expect, it } from "vitest";
import {
  createSearch,
  parseSearchState,
  serializeSearchState,
  type SearchFilters,
} from "./search";
import type { PublicEntry } from "../data/public-entry";

function entry(overrides: Partial<PublicEntry> & { id: string }): PublicEntry {
  return {
    title: overrides.title ?? "Untitled",
    patternType: overrides.patternType ?? "dashboard",
    categories: overrides.categories ?? [],
    styleTags: overrides.styleTags ?? [],
    qualityTier: overrides.qualityTier ?? "exceptional",
    qualityScore: overrides.qualityScore ?? 3,
    critique: overrides.critique ?? "",
    whatToSteal: overrides.whatToSteal ?? [],
    antiPatterns: overrides.antiPatterns ?? [],
    dominantColors: overrides.dominantColors ?? [],
    colorRoles: overrides.colorRoles,
    imageUrl: overrides.imageUrl ?? "/clean-ui-mcp/entries/sample-5.png",
    source: overrides.source ?? { productName: "Acme", url: "https://example.com" },
    ...overrides,
  } as PublicEntry;
}

const noFilters: SearchFilters = {
  categories: [],
  styles: [],
  domains: [],
  platform: null,
};

describe("createSearch — text relevance", () => {
  it("returns matches ordered by relevance", () => {
    const entries: PublicEntry[] = [
      entry({
        id: "pricing-page",
        title: "Pricing page",
        critique: "Pricing is the hero of this page.",
      }),
      entry({
        id: "dashboard",
        title: "Analytics dashboard",
        critique: "Charts dominate the canvas.",
      }),
    ];
    const search = createSearch(entries);
    const results = search.search("pricing", noFilters);
    expect(results.map((r) => r.id)).toEqual(["pricing-page"]);
  });

  it("returns all entries for an empty query when no filters are set", () => {
    const entries: PublicEntry[] = [
      entry({ id: "a", title: "Alpha" }),
      entry({ id: "b", title: "Beta" }),
    ];
    const search = createSearch(entries);
    const results = search.search("", noFilters);
    expect(results.map((r) => r.id).sort()).toEqual(["a", "b"]);
  });
});

describe("createSearch — filters", () => {
  const entries: PublicEntry[] = [
    entry({
      id: "pricing-web",
      title: "Pricing",
      categories: ["pricing"],
      styleTags: ["minimal"],
      patternType: "pricing",
      source: { productName: "Acme", url: "https://acme.com/pricing" },
    }),
    entry({
      id: "dashboard-mac",
      title: "Dashboard",
      categories: ["dashboard"],
      styleTags: ["editorial"],
      patternType: "dashboard",
      source: { productName: "Beta", url: "https://beta.app/dashboard" },
    }),
    entry({
      id: "pricing-mobile",
      title: "Mobile pricing",
      categories: ["pricing"],
      styleTags: ["minimal"],
      patternType: "pricing",
      source: { productName: "Gamma", url: "https://gamma.io/pricing" },
    }),
  ];

  it("narrows by category", () => {
    const search = createSearch(entries);
    const results = search.search("", { ...noFilters, categories: ["pricing"] });
    expect(results.map((r) => r.id).sort()).toEqual(["pricing-mobile", "pricing-web"]);
  });

  it("narrows by style", () => {
    const search = createSearch(entries);
    const results = search.search("", { ...noFilters, styles: ["editorial"] });
    expect(results.map((r) => r.id)).toEqual(["dashboard-mac"]);
  });

  it("narrows by domain", () => {
    const search = createSearch(entries);
    const results = search.search("", { ...noFilters, domains: ["gamma.io"] });
    expect(results.map((r) => r.id)).toEqual(["pricing-mobile"]);
  });

  it("does NOT match unrelated suffix domains (notacme.com is not acme.com)", () => {
    // A bare endsWith check treats `notacme.com` as a match for `acme.com`.
    // Enforce hostname label boundaries: exact match or a dot-delimited
    // subdomain suffix only. Add a deceptive-suffix entry and confirm it is
    // excluded when filtering for the real domain.
    const withDeceptive = entries.concat([
      entry({ id: "suffix-trap", source: { productName: "NotAcme", url: "https://notacme.com/dashboard" } }),
      entry({ id: "real-subdomain", source: { productName: "AcmeSub", url: "https://shop.acme.com/dashboard" } }),
    ]);
    const search = createSearch(withDeceptive);
    const results = search.search("", { ...noFilters, domains: ["acme.com"] });
    const ids = results.map((r) => r.id);
    expect(ids).toContain("pricing-web"); // the real https://acme.com/pricing entry
    expect(ids).toContain("real-subdomain"); // shop.acme.com is a dot-delimited subdomain
    expect(ids).not.toContain("suffix-trap"); // notacme.com must NOT match
  });

  it("narrows by platform when the entry exposes one", () => {
    const withPlatform = entries.map((e) => ({
      ...e,
      // The current public snapshot has no platform field, so the search must
      // accept that gracefully. When present, the filter narrows the result.
      platform: e.id.endsWith("-mobile") ? "ios" : "web",
    })) as PublicEntry[];
    const search = createSearch(withPlatform);
    const results = search.search("", { ...noFilters, platform: "ios" });
    expect(results.map((r) => r.id)).toEqual(["pricing-mobile"]);
  });

  it("treats an absent platform filter as matching everything", () => {
    const search = createSearch(entries);
    const results = search.search("", { ...noFilters, platform: null });
    expect(results).toHaveLength(entries.length);
  });

  it("combines multiple filters with AND semantics", () => {
    const search = createSearch(entries);
    const results = search.search("", {
      ...noFilters,
      categories: ["pricing"],
      domains: ["acme.com"],
    });
    expect(results.map((r) => r.id)).toEqual(["pricing-web"]);
  });
});

describe("createSearch — stable ordering", () => {
  it("breaks score ties deterministically using id localeCompare", () => {
    // Two entries with identical indexed text but different ids — MiniSearch
    // returns the same score, so the tiebreak must be id.localeCompare.
    const entries: PublicEntry[] = [
      entry({
        id: "zebra",
        title: "Pricing",
        critique: "pricing pricing pricing",
        categories: ["pricing"],
      }),
      entry({
        id: "alpha",
        title: "Pricing",
        critique: "pricing pricing pricing",
        categories: ["pricing"],
      }),
      entry({
        id: "middle",
        title: "Pricing",
        critique: "pricing pricing pricing",
        categories: ["pricing"],
      }),
    ];
    const search = createSearch(entries);
    const results = search.search("pricing", noFilters);
    const ids = results.map((r) => r.id);
    // localeCompare ordering: alpha < middle < zebra
    expect(ids).toEqual(["alpha", "middle", "zebra"]);
    // Scores must be equal so the tiebreak is the only thing deciding order.
    const scores = results.map((r) => r.score);
    expect(new Set(scores).size).toBe(1);
  });

  it("preserves score-descending ordering when scores differ", () => {
    const entries: PublicEntry[] = [
      entry({ id: "a", title: "Pricing pricing pricing", critique: "pricing" }),
      entry({ id: "b", title: "Other", critique: "mentions pricing once" }),
    ];
    const search = createSearch(entries);
    const results = search.search("pricing", noFilters);
    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
    expect(results[0].id).toBe("a");
  });
});

describe("serializeSearchState / parseSearchState", () => {
  it("round-trips shareable filters exactly", () => {
    const state: SearchFilters & { query: string } = {
      query: "pricing",
      categories: ["pricing"],
      styles: ["minimal"],
      domains: [],
      platform: "web",
    };
    expect(parseSearchState(serializeSearchState(state))).toEqual(state);
  });

  it("round-trips an empty query and no filters", () => {
    const state = { query: "", categories: [], styles: [], domains: [], platform: null };
    expect(parseSearchState(serializeSearchState(state))).toEqual(state);
  });

  it("round-trips multiple categories, styles, and domains", () => {
    const state = {
      query: "dashboard",
      categories: ["pricing", "dashboard"],
      styles: ["minimal", "editorial"],
      domains: ["acme.com", "beta.app"],
      platform: null,
    };
    expect(parseSearchState(serializeSearchState(state))).toEqual(state);
  });

  it("produces a canonical, human-readable query string", () => {
    const state = {
      query: "pricing",
      categories: ["pricing"],
      styles: ["minimal"],
      domains: [],
      platform: "web",
    };
    const serialized = serializeSearchState(state);
    // The serialized form must be a plain search string (no leading '?').
    expect(serialized.startsWith("?")).toBe(false);
    expect(serialized).toContain("q=pricing");
    expect(serialized).toContain("category=pricing");
    expect(serialized).toContain("style=minimal");
    expect(serialized).toContain("platform=web");
  });

  it("drops empty filters from the canonical URL", () => {
    const state = { query: "", categories: [], styles: [], domains: [], platform: null };
    expect(serializeSearchState(state)).toBe("");
  });

  it("is the inverse of parse: a hand-written canonical URL parses correctly", () => {
    const params = new URLSearchParams("q=pricing&category=pricing&style=minimal&platform=web");
    const parsed = parseSearchState(params);
    expect(parsed).toEqual({
      query: "pricing",
      categories: ["pricing"],
      styles: ["minimal"],
      domains: [],
      platform: "web",
    });
  });
});
