import { describe, expect, it, vi } from "vitest";
import { retrieveCritiqueEvidence, type RetrievalResult } from "./critique-retrieval.js";

// Mock corpus + embeddings to test retrieval in isolation.
vi.mock("./corpus.js", () => ({
  searchRanked: vi.fn(async () => {
    return [
      { entry: { id: "e1", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Dashboard A" }, score: 0.9 },
      { entry: { id: "e2", patternType: "dashboard", platform: "web", reviewStatus: "approved", title: "Dashboard B" }, score: 0.85 },
    ];
  }),
}));

vi.mock("./image-index.js", () => ({
  loadImageIndex: vi.fn(() => null), // no index by default
  cosine: vi.fn((a: number[], b: number[]) => 0.5),
}));

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
});
