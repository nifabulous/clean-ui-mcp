import { describe, expect, it } from "vitest";
import { cosine, hashForImage } from "./image-index.js";

describe("image-index utilities", () => {
  it("cosine returns 1 for identical vectors", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
  });

  it("cosine returns 0 for orthogonal vectors", () => {
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("cosine returns -1 for opposite vectors", () => {
    expect(cosine([1, 0], [-1, 0])).toBeCloseTo(-1);
  });

  it("cosine handles zero vector safely", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });

  it("hashForImage produces a stable hex string", () => {
    const h1 = hashForImage(Buffer.from("test"));
    const h2 = hashForImage(Buffer.from("test"));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashForImage differs for different inputs", () => {
    const h1 = hashForImage(Buffer.from("a"));
    const h2 = hashForImage(Buffer.from("b"));
    expect(h1).not.toBe(h2);
  });
});
