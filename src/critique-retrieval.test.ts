import { describe, expect, it, vi, afterEach } from "vitest";
import { retrieveCritiqueEvidence } from "./critique-retrieval.js";

// Mock corpus + embeddings to test retrieval in isolation.
vi.mock("./corpus.js", () => ({
  searchRanked: vi.fn(async () => {
    return [
      { entry: { id: "e1", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Dashboard A" }, score: 0.9 },
      { entry: { id: "e2", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Dashboard B" }, score: 0.85 },
    ];
  }),
  loadCorpus: vi.fn(() => [
    { id: "e1", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Dashboard A" },
    { id: "e2", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Dashboard B" },
  ]),
}));

vi.mock("./image-index.js", () => ({
  loadImageIndex: vi.fn(() => null),
  cosine: vi.fn((a: number[], b: number[]) => 0.5),
}));

// ─── helper: generate N mock corpus entries ───────────────────────────────────
function makeMockEntries(n: number, status: "approved" | "draft" = "approved", platform = "web"): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({
    id: `${status}-${i}`,
    patternType: "dashboard",
    platform,
    reviewStatus: status,
    title: `${status} ${i}`,
  }));
}

afterEach(() => {
  // Reset the default mock returns after each test
  const { searchRanked, loadCorpus } = vi.mocked(
    // Import for type only — actual mock is already installed
    {} as typeof import("./corpus.js"),
  );
  vi.clearAllMocks();
});

describe("retrieveCritiqueEvidence", () => {
  it("falls back to structured retrieval when no image provider", async () => {
    const result = await retrieveCritiqueEvidence({
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
    const { loadCorpus } = await import("./corpus.js");
    vi.mocked(loadCorpus).mockReturnValue([
      ...Array.from({ length: 12 }, (_, i) => ({ id: `draft-${i}`, patternType: "dashboard", platform: "web", reviewStatus: "draft", title: `Draft ${i}` })),
      { id: "approved-1", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Approved" },
    ] as never);
    const result = await retrieveCritiqueEvidence({
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
    const { searchRanked } = await import("./corpus.js");
    vi.mocked(searchRanked).mockResolvedValueOnce([]);
    const result = await retrieveCritiqueEvidence({
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
    const { loadCorpus } = await import("./corpus.js");
    vi.mocked(loadCorpus).mockReturnValueOnce([
      { id: "real-1", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Real" },
    ] as never);
    const result = await retrieveCritiqueEvidence({
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
    const { loadCorpus } = await import("./corpus.js");
    vi.mocked(loadCorpus).mockReturnValueOnce([
      { id: "demoted", patternType: "dashboard", platform: "web", reviewStatus: "draft", title: "Was Approved" },
      { id: "still-approved", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Still Good" },
    ] as never);
    const result = await retrieveCritiqueEvidence({
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
    const { loadCorpus, searchRanked } = await import("./corpus.js");
    vi.mocked(loadCorpus).mockReturnValueOnce([] as never);
    vi.mocked(searchRanked).mockResolvedValueOnce([]);
    const result = await retrieveCritiqueEvidence({
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
    const { loadCorpus } = await import("./corpus.js");
    vi.mocked(loadCorpus).mockReturnValueOnce([
      { id: "web-1", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Web A" },
      { id: "mobile-1", patternType: "dashboard", platform: "mobile", reviewStatus: "approved", title: "Mobile A" },
    ] as never);
    // Use real cosine for this test so platform penalty has real scores to work with
    const { cosine: realCosine } = await import("./image-index.js");
    vi.mocked(realCosine).mockRestore();
    vi.doUnmock("./image-index.js");

    // Since the mock is already installed at module level, we need to use real cosine
    // by computing scores ourselves. The mock returns 0.5 for everything, so let's
    // override it to return different values for different vectors.
    vi.mocked(realCosine).mockImplementation((a: number[], b: number[]) => {
      if (b[0] === 0.8) return 0.8;
      if (b[0] === 0.95) return 0.95;
      return 0.5;
    });

    const result = await retrieveCritiqueEvidence({
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
