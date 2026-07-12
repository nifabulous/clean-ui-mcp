import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { retrieveCritiqueEvidence } from "./critique-retrieval.js";
import type { CorpusReader } from "./corpus-reader.js";

/**
 * Mock image-index module — retrieval uses `cosine` to rank image-index
 * vectors against the query vector. Still module-mocked because retrieval
 * depends on the index shape, not on corpus access (which now comes through
 * the injected reader).
 */
vi.mock("./image-index.js", () => ({
  loadImageIndex: vi.fn(() => null),
  cosine: vi.fn((a: number[], b: number[]) => 0.5),
}));

/**
 * Build a fresh mock CorpusReader for each test. The reader's methods are
 * vi.fn()s so individual tests can override return values (mirroring the old
 * per-test vi.mocked(loadCorpus).mockReturnValue pattern). Default returns
 * mirror the old top-of-file mock: a 2-entry approved corpus + 2 ranked
 * results.
 */
function makeReader(overrides: { corpus?: any[]; ranked?: any[] } = {}): CorpusReader & {
  searchRanked: ReturnType<typeof vi.fn>;
  entriesForAggregation: ReturnType<typeof vi.fn>;
} {
  const corpus = overrides.corpus ?? [
    { id: "e1", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Dashboard A" },
    { id: "e2", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Dashboard B" },
  ];
  const ranked = overrides.ranked ?? [
    { entry: { id: "e1", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Dashboard A" }, score: 0.9 },
    { entry: { id: "e2", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Dashboard B" }, score: 0.85 },
  ];
  return {
    search: vi.fn(async () => ranked.map((r) => r.entry)) as never,
    searchRanked: vi.fn(async () => ranked) as never,
    getById: vi.fn((id: string) => corpus.find((e) => e.id === id)) as never,
    findSimilar: vi.fn(() => []) as never,
    listCategories: vi.fn(() => []) as never,
    listStyleTags: vi.fn(() => []) as never,
    listDomainTags: vi.fn(() => []) as never,
    indexStatus: vi.fn(() => ({ indexed: 0, total: corpus.length, hasIndex: false, missing: corpus.length, stale: 0, contentStale: 0 })) as never,
    entriesForAggregation: vi.fn(() => corpus) as never,
    resolveImagePath: vi.fn(() => null) as never,
  } as never;
}

describe("retrieveCritiqueEvidence", () => {
  let reader: ReturnType<typeof makeReader>;

  beforeEach(() => {
    reader = makeReader();
  });
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("falls back to structured retrieval when no image provider", async () => {
    const result = await retrieveCritiqueEvidence({
      reader,
      imageProvider: null,
      imageData: null,
      extraction: { patternType: "dashboard" },
      productContext: "A KPI dashboard",
      platform: "web",
      imageIndex: null,
    });
    expect(result.mode).toBe("structured-fallback");
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.fallbackUsed).toBe(true);
  });

  it("falls back when image provider exists but index is empty", async () => {
    const result = await retrieveCritiqueEvidence({
      reader,
      imageProvider: { name: "voyage", model: "voyage-multimodal-3", embedImage: async () => [1] },
      imageData: Buffer.from("fake"),
      extraction: { patternType: "dashboard" },
      productContext: "A KPI dashboard",
      platform: "web",
      imageIndex: null,
    });
    expect(result.mode).toBe("structured-fallback");
    expect(result.fallbackUsed).toBe(true);
  });

  it("uses image retrieval when provider + index are available", async () => {
    const result = await retrieveCritiqueEvidence({
      reader,
      imageProvider: { name: "voyage", model: "voyage-multimodal-3", embedImage: async () => [0.1, 0.2] },
      imageData: Buffer.from("fake"),
      extraction: { patternType: "dashboard" },
      productContext: "A KPI dashboard",
      platform: "web",
      imageIndex: {
        version: 1,
        model: "voyage-multimodal-3",
        dimension: 2,
        entries: {
          e1: { vector: [0.1, 0.2], hash: "abc" },
          e2: { vector: [0.3, 0.4], hash: "def" },
        },
      },
    });
    expect(result.mode).toBe("image");
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.fallbackUsed).toBe(false);
  });

  it("never returns more than 5 entries", async () => {
    const result = await retrieveCritiqueEvidence({
      reader,
      imageProvider: null,
      imageData: null,
      extraction: { patternType: "dashboard" },
      productContext: "A KPI dashboard",
      platform: "web",
      imageIndex: null,
    });
    expect(result.entries.length).toBeLessThanOrEqual(5);
  });

  it("filters stale drafts before limiting image candidates", async () => {
    reader = makeReader({
      corpus: [
        ...Array.from({ length: 12 }, (_, i) => ({ id: `draft-${i}`, patternType: "dashboard", platform: "web", reviewStatus: "draft", title: `Draft ${i}` })),
        { id: "approved-1", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Approved" },
      ],
    });
    const result = await retrieveCritiqueEvidence({
      reader,
      imageProvider: { name: "voyage", model: "m", embedImage: async () => [1] },
      imageData: Buffer.from("fake"),
      imageMimeType: "image/png",
      extraction: { patternType: "dashboard" },
      platform: "web",
      imageIndex: {
        version: 1, model: "m", dimension: 1,
        entries: Object.fromEntries([
          ...Array.from({ length: 12 }, (_, i) => [`draft-${i}`, { vector: [1], hash: "" }]),
          ["approved-1", { vector: [0.9], hash: "" }],
        ]),
      },
    });
    expect(result.mode).toBe("image");
    expect(result.entries.map((e) => e.id)).toContain("approved-1");
  });

  // ─── Edge-case tests (proportional to bug classes) ──────────────────────────

  it("returns empty entries with coverage 'none' when searchRanked has no matches", async () => {
    reader = makeReader({ ranked: [] });
    const result = await retrieveCritiqueEvidence({
      reader,
      imageProvider: null,
      imageData: null,
      extraction: { patternType: "nonexistent" },
      productContext: "A product with no corpus match",
      platform: "web",
      imageIndex: null,
    });
    expect(result.entries.length).toBe(0);
    expect(result.coverage).toBe("none");
    expect(result.mode).toBe("structured-fallback");
  });

  it("falls back to structured when image index has no entries", async () => {
    const result = await retrieveCritiqueEvidence({
      reader,
      imageProvider: { name: "voyage", model: "m", embedImage: async () => [1] },
      imageData: Buffer.from("fake"),
      imageMimeType: "image/png",
      extraction: { patternType: "dashboard" },
      platform: "web",
      imageIndex: { version: 1, model: "m", dimension: 1, entries: {} },
    });
    expect(result.mode).toBe("structured-fallback");
    expect(result.fallbackUsed).toBe(true);
  });

  it("falls back to structured when embedImage throws", async () => {
    const result = await retrieveCritiqueEvidence({
      reader,
      imageProvider: { name: "voyage", model: "m", embedImage: async () => { throw new Error("API timeout"); } },
      imageData: Buffer.from("fake"),
      imageMimeType: "image/png",
      extraction: { patternType: "dashboard" },
      platform: "web",
      imageIndex: {
        version: 1, model: "m", dimension: 1,
        entries: { e1: { vector: [1], hash: "x" } },
      },
    });
    expect(result.mode).toBe("structured-fallback");
    expect(result.fallbackUsed).toBe(true);
  });

  it("filters orphaned image-index entries (id not in corpus)", async () => {
    reader = makeReader({
      corpus: [
        { id: "real-1", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Real" },
      ],
    });
    const result = await retrieveCritiqueEvidence({
      reader,
      imageProvider: { name: "voyage", model: "m", embedImage: async () => [1] },
      imageData: Buffer.from("fake"),
      imageMimeType: "image/png",
      extraction: { patternType: "dashboard" },
      platform: "web",
      imageIndex: {
        version: 1, model: "m", dimension: 1,
        entries: {
          "orphaned-1": { vector: [1], hash: "x" }, // not in corpus → filtered
          "real-1": { vector: [0.9], hash: "y" },   // in corpus → kept
        },
      },
    });
    expect(result.mode).toBe("image");
    expect(result.entries.map((e) => e.id)).toContain("real-1");
    expect(result.entries.map((e) => e.id)).not.toContain("orphaned-1");
  });

  it("filters entries demoted from approved to draft after indexing", async () => {
    reader = makeReader({
      corpus: [
        { id: "demoted", patternType: "dashboard", platform: "web", reviewStatus: "draft", title: "Was Approved" },
        { id: "still-approved", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Still Good" },
      ],
    });
    const result = await retrieveCritiqueEvidence({
      reader,
      imageProvider: { name: "voyage", model: "m", embedImage: async () => [1] },
      imageData: Buffer.from("fake"),
      imageMimeType: "image/png",
      extraction: { patternType: "dashboard" },
      platform: "web",
      imageIndex: {
        version: 1, model: "m", dimension: 1,
        entries: {
          "demoted": { vector: [1], hash: "x" },         // was approved at indexing time, now draft
          "still-approved": { vector: [0.9], hash: "y" },
        },
      },
    });
    expect(result.mode).toBe("image");
    expect(result.entries.map((e) => e.id)).toContain("still-approved");
    expect(result.entries.map((e) => e.id)).not.toContain("demoted");
  });

  it("falls back gracefully with empty corpus", async () => {
    reader = makeReader({ corpus: [], ranked: [] });
    const result = await retrieveCritiqueEvidence({
      reader,
      imageProvider: { name: "voyage", model: "m", embedImage: async () => [1] },
      imageData: Buffer.from("fake"),
      imageMimeType: "image/png",
      extraction: { patternType: "dashboard" },
      platform: "web",
      imageIndex: {
        version: 1, model: "m", dimension: 1,
        entries: { "ghost": { vector: [1], hash: "x" } },
      },
    });
    // Image index has entries but none are in corpus → falls through to structured
    // Structured also returns empty → coverage "none"
    expect(result.entries.length).toBe(0);
  });

  it("applies platform penalty after approved filtering", async () => {
    reader = makeReader({
      corpus: [
        { id: "web-1", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Web A" },
        { id: "mobile-1", patternType: "dashboard", platform: "mobile", reviewStatus: "approved", title: "Mobile A" },
      ],
    });
    // Override the cosine mock to return distinct scores per entry vector so the
    // platform penalty has real differentiation to work with.
    const { cosine } = await import("./image-index.js");
    vi.mocked(cosine).mockImplementation((_a: number[], b: number[]) => {
      // b is the entry vector — return the first element as the score
      return b[0] ?? 0.5;
    });

    const result = await retrieveCritiqueEvidence({
      reader,
      imageProvider: { name: "voyage", model: "m", embedImage: async () => [1] },
      imageData: Buffer.from("fake"),
      imageMimeType: "image/png",
      extraction: { patternType: "dashboard" },
      platform: "web",
      imageIndex: {
        version: 1, model: "m", dimension: 1,
        entries: {
          "web-1": { vector: [0.8], hash: "x" },
          "mobile-1": { vector: [0.95], hash: "y" }, // higher raw score but wrong platform
        },
      },
    });
    expect(result.mode).toBe("image");
    // Both survive approved filtering, but web-1 should be ranked above mobile-1
    // because mobile-1's score is halved (0.95 * 0.5 = 0.475 < 0.8)
    const ids = result.entries.map((e) => e.id);
    expect(ids).toContain("web-1");
    expect(ids).toContain("mobile-1");
    expect(ids.indexOf("web-1")).toBeLessThan(ids.indexOf("mobile-1"));
  });

  it("falls back when query vector dimension doesn't match index dimension", async () => {
    const result = await retrieveCritiqueEvidence({
      reader,
      imageProvider: { name: "voyage", model: "m", embedImage: async () => [1, 2, 3] }, // dim 3
      imageData: Buffer.from("fake"),
      imageMimeType: "image/png",
      extraction: { patternType: "dashboard" },
      platform: "web",
      imageIndex: {
        version: 1, model: "m", dimension: 1024, // mismatch: 3 vs 1024
        entries: { e1: { vector: new Array(1024).fill(0), hash: "x" } },
      },
    });
    expect(result.mode).toBe("structured-fallback");
    expect(result.fallbackUsed).toBe(true);
  });
});
