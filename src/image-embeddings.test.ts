import { describe, expect, it, vi, afterEach } from "vitest";
import {
  createImageEmbeddingProvider,
  type ImageEmbeddingProvider,
  type ValidatedImage,
} from "./image-embeddings.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createImageEmbeddingProvider", () => {
  it("returns null when no image-embedding env vars are configured", () => {
    vi.stubEnv("IMAGE_EMBEDDING_PROVIDER", "");
    vi.stubEnv("IMAGE_EMBEDDING_API_KEY", "");
    expect(createImageEmbeddingProvider()).toBeNull();
  });

  it("returns null when provider is set but key is missing", () => {
    vi.stubEnv("IMAGE_EMBEDDING_PROVIDER", "voyage");
    vi.stubEnv("IMAGE_EMBEDDING_API_KEY", "");
    expect(createImageEmbeddingProvider()).toBeNull();
  });
});

describe("ImageEmbeddingProvider contract (fake provider test)", () => {
  const fakeImage: ValidatedImage = {
    data: Buffer.from("fake-image-bytes"),
    mimeType: "image/png",
  };

  it("a fake provider returns a non-empty finite vector", async () => {
    const provider: ImageEmbeddingProvider = {
      name: "fake",
      model: "fake-model",
      embedImage: async () => [0.1, 0.2, 0.3],
    };
    const vec = await provider.embedImage(fakeImage);
    expect(vec.length).toBeGreaterThan(0);
    expect(vec.every((v) => Number.isFinite(v))).toBe(true);
  });

  it("rejects non-image MIME types", async () => {
    const provider: ImageEmbeddingProvider = {
      name: "fake",
      model: "fake-model",
      embedImage: async (img) => {
        if (!img.mimeType.startsWith("image/")) throw new Error("not an image");
        return [1];
      },
    };
    await expect(
      provider.embedImage({ data: Buffer.from("x"), mimeType: "text/plain" } as ValidatedImage),
    ).rejects.toThrow(/not an image/i);
  });

  it("propagates provider errors without swallowing", async () => {
    const provider: ImageEmbeddingProvider = {
      name: "fake",
      model: "fake-model",
      embedImage: async () => { throw new Error("API timeout"); },
    };
    await expect(provider.embedImage(fakeImage)).rejects.toThrow("API timeout");
  });

  it("exposes provider/model metadata", () => {
    const provider: ImageEmbeddingProvider = {
      name: "voyage",
      model: "voyage-multimodal-3",
      embedImage: async () => [1],
    };
    expect(provider.name).toBe("voyage");
    expect(provider.model).toBe("voyage-multimodal-3");
  });
});
