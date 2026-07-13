import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, copyFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { transformForValidation } from "./validate-public-pipeline.js";

describe("validate-public-pipeline — transformForValidation", () => {
  it("adds a placeholder publication block to an entry without one", () => {
    const entry = {
      id: "test-1",
      image: { visibility: "private", path: "images-private/test.png", width: 100, height: 100 },
    } as Record<string, unknown>;
    const result = transformForValidation(entry);
    expect(result.publication).toBeDefined();
    expect((result.publication as { visibility: string }).visibility).toBe("public");
    expect((result.publication as { clearance: string }).clearance).toBe("approved");
    expect((result.publication as { evidenceRef: string }).evidenceRef).toBe("pipeline-validation-harness");
  });

  it("rewrites images-private/ path to images-public/ and sets public-own", () => {
    const entry = {
      id: "test-2",
      image: { visibility: "private", path: "images-private/foo/bar.png", width: 100, height: 100 },
    } as Record<string, unknown>;
    const result = transformForValidation(entry);
    const img = result.image as { visibility: string; path: string };
    expect(img.visibility).toBe("public-own");
    expect(img.path).toBe("images-public/foo/bar.png");
  });

  it("does NOT mutate the original entry (shallow copy)", () => {
    const entry = {
      id: "test-3",
      image: { visibility: "private", path: "images-private/test3.png", width: 100, height: 100 },
    } as Record<string, unknown>;
    const result = transformForValidation(entry);
    // Original is unchanged
    expect((entry.image as { visibility: string }).visibility).toBe("private");
    expect((entry.image as { path: string }).path).toBe("images-private/test3.png");
    expect(entry.publication).toBeUndefined();
    // Transformed has the new values
    expect((result.image as { visibility: string }).visibility).toBe("public-own");
    expect(result.publication).toBeDefined();
  });
});
