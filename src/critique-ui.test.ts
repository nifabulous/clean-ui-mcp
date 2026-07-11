import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { validateCritiqueUiInput, withValidatedImageFile, toNormalizedTaggerFacts, MAX_IMAGE_BYTES, type CritiqueUiInput } from "./critique-ui.js";

// A tiny valid PNG (1×1 red pixel) for size/MIME tests.
const TINY_PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

describe("validateCritiqueUiInput", () => {
  it("accepts a valid PNG within size limit", () => {
    const input: CritiqueUiInput = {
      image: { data: TINY_PNG_B64, mimeType: "image/png" },
      productContext: "A dashboard for tracking KPIs",
    };
    const result = validateCritiqueUiInput(input);
    expect(result.valid).toBe(true);
  });

  it("accepts image/jpeg and image/webp", () => {
    for (const mimeType of ["image/jpeg", "image/webp"] as const) {
      const input: CritiqueUiInput = {
        image: { data: TINY_PNG_B64, mimeType },
      };
      expect(validateCritiqueUiInput(input).valid).toBe(true);
    }
  });

  it("rejects unsupported MIME types", () => {
    const input = {
      image: { data: TINY_PNG_B64, mimeType: "image/gif" },
    } as unknown as CritiqueUiInput;
    const result = validateCritiqueUiInput(input);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/mime|gif/i);
  });

  it("rejects missing image", () => {
    const input = { productContext: "test" } as unknown as CritiqueUiInput;
    const result = validateCritiqueUiInput(input);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/image/i);
  });

  it("rejects malformed base64", () => {
    const input: CritiqueUiInput = {
      image: { data: "!!!not-base64!!!", mimeType: "image/png" },
    };
    const result = validateCritiqueUiInput(input);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/base64|decode/i);
  });

  it("rejects payloads over 10 MiB decoded", () => {
    // Build a base64 string whose decoded bytes exceed 10 MiB.
    // 14 MiB of base64 chars → ~10.5 MiB decoded.
    const huge = Buffer.alloc(MAX_IMAGE_BYTES + 1024 * 1024, 0).toString("base64");
    const input: CritiqueUiInput = {
      image: { data: huge, mimeType: "image/png" },
    };
    const result = validateCritiqueUiInput(input);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/size|10.*mib|large/i);
  });

  it("accepts empty productContext (optional field)", () => {
    const input: CritiqueUiInput = {
      image: { data: TINY_PNG_B64, mimeType: "image/png" },
    };
    const result = validateCritiqueUiInput(input);
    expect(result.valid).toBe(true);
  });

  it("accepts optional platform field", () => {
    const input: CritiqueUiInput = {
      image: { data: TINY_PNG_B64, mimeType: "image/png" },
      platform: "mobile",
    };
    const result = validateCritiqueUiInput(input);
    expect(result.valid).toBe(true);
  });

  it("rejects invalid platform values", () => {
    const input = {
      image: { data: TINY_PNG_B64, mimeType: "image/png" },
      platform: "desktop",
    } as unknown as CritiqueUiInput;
    const result = validateCritiqueUiInput(input);
    expect(result.valid).toBe(false);
    expect(result.error).toMatch(/platform/i);
  });
});

describe("withValidatedImageFile", () => {
  const testDir = mkdtempSync(join(tmpdir(), "critique-ui-test-"));

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("writes a temp file, invokes the callback with a path, and cleans up", async () => {
    let receivedPath: string | null = null;
    await withValidatedImageFile(
      { image: { data: TINY_PNG_B64, mimeType: "image/png" } },
      async (imagePath) => {
        receivedPath = imagePath;
        expect(existsSync(imagePath)).toBe(true);
      },
    );
    // After the callback, the temp file should be gone.
    expect(receivedPath).not.toBeNull();
    expect(existsSync(receivedPath!)).toBe(false);
  });

  it("cleans up even when the callback throws", async () => {
    let receivedPath: string | null = null;
    await expect(
      withValidatedImageFile(
        { image: { data: TINY_PNG_B64, mimeType: "image/png" } },
        async (imagePath) => {
          receivedPath = imagePath;
          throw new Error("tagger failure");
        },
      ),
    ).rejects.toThrow("tagger failure");
    expect(existsSync(receivedPath!)).toBe(false);
  });

  it("uses the correct file extension for the MIME type", async () => {
    let ext = "";
    await withValidatedImageFile(
      { image: { data: TINY_PNG_B64, mimeType: "image/jpeg" } },
      async (imagePath) => {
        ext = imagePath.split(".").pop() ?? "";
      },
    );
    expect(ext).toBe("jpg");
  });
});

describe("toNormalizedTaggerFacts", () => {
  it("projects sanitized top-level tagger fields and never forwards _raw", () => {
    const facts = toNormalizedTaggerFacts({
      patternType: "dashboard",
      platform: "mobile",
      categories: ["dashboard"],
      styleTags: ["minimal"],
      components: ["bottom-nav"],
      domainTags: ["finance"],
      layout: { form: "stacked", regions: [{ role: "main" }] },
      visual: { spacingDensity: "comfortable", cornerStyle: "rounded", usesShadows: false, usesBorders: true },
      _raw: { extraction: { components: ["sidebar-nav"], patternType: "dashboard" } },
    });
    expect(facts).toMatchObject({
      patternType: "dashboard",
      platform: "mobile",
      components: ["bottom-nav"],
      layoutForm: "stacked",
    });
    expect(JSON.stringify(facts)).not.toContain("sidebar-nav");
    expect(facts).not.toHaveProperty("_raw");
  });
});
