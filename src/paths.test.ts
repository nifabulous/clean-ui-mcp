import { describe, expect, it } from "vitest";
import { fromCorpusRelativeImagePath } from "./paths.js";

describe("corpus image paths", () => {
  it("allows images-private and images-public paths", () => {
    expect(fromCorpusRelativeImagePath("images-private/example.png")).toContain("corpus/images-private/example.png");
    expect(fromCorpusRelativeImagePath("images-public/example.png")).toContain("corpus/images-public/example.png");
  });

  it("rejects non-image corpus paths", () => {
    expect(() => fromCorpusRelativeImagePath("entries.json")).toThrow("Invalid corpus image path");
  });

  it("rejects traversal paths", () => {
    expect(() => fromCorpusRelativeImagePath("images-private/../entries.json")).toThrow("Invalid corpus image path");
  });
});
