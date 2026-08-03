import { describe, expect, it } from "vitest";
import { fromCorpusRelativeImagePath, syntheticCorpusPathForUpload, toCorpusRelativePath } from "./paths.js";

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

  it("refuses corpus-relative conversion for an external upload path (the critique_ui bug class)", () => {
    // critique_ui stages uploads in the OS temp dir; the strict guard must
    // reject those for every NORMAL caller, which is why critique failed.
    expect(() => toCorpusRelativePath("/var/folders/xx/critique-ui-abc123.png")).toThrow("Image must live under");
  });

  it("synthesizes a corpus-relative identity for external upload paths", () => {
    const path = syntheticCorpusPathForUpload("/var/folders/xx/critique-ui-abc123.png");
    expect(path).toMatch(/^images-private\/critique-upload-/);
    expect(path).toMatch(/\.png$/);
    // The synthetic path must itself be corpus-relative (round-trips cleanly).
    expect(fromCorpusRelativeImagePath(path)).toContain("corpus/images-private/");
  });
});
