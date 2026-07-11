import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { validateCritiqueUiInput, withValidatedImageFile, toNormalizedTaggerFacts, MAX_IMAGE_BYTES, type CritiqueUiInput } from "./critique-ui.js";
import type { TaggerInput } from "./tagger.js";
import { CRITIQUE_UI_INPUT_SCHEMA } from "./synthesis/contracts.js";

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

  it("does not expose caller-supplied DOM signals in the public MCP schema", () => {
    const result = CRITIQUE_UI_INPUT_SCHEMA.safeParse({
      image_data: TINY_PNG_B64,
      image_mime_type: "image/png",
      dom_signals: { motion: { signals: [] } },
    });
    expect(result.success).toBe(false);
  });

  it("rejects caller-supplied DOM signals during public request validation", () => {
    const domSignals: NonNullable<TaggerInput["domSignals"]> = {
      styles: { fontFamily: null, fontSize: null, fontWeight: null, borderRadius: null, boxShadow: null, color: null, background: null, letterSpacing: null },
      accessibility: { contrastRatio: null, headingLevels: [], imagesMissingAlt: 0, unlabeledInteractive: 0, hasSkipLink: false },
      structure: { display: null, flexDirection: null, gridTemplateColumns: null, gap: null },
      motion: { signals: [{ selector: "button", property: "opacity", durationMs: 100, delayMs: 0 }], coverage: "full", inaccessibleStylesheets: 0, prefersReducedMotion: false },
    };
    const result = validateCritiqueUiInput({ image: { data: TINY_PNG_B64, mimeType: "image/png" }, dom_signals: domSignals });
    expect(result).toMatchObject({ valid: false });
    if (!result.valid) expect(result.error).toMatch(/dom.?signals|public/i);
  });

  it("rejects malformed or oversized caller DOM motion injection", () => {
    const malformed = validateCritiqueUiInput({
      image: { data: TINY_PNG_B64, mimeType: "image/png" },
      domSignals: { motion: { signals: Array.from({ length: 101 }, () => ({})) } },
    });
    expect(malformed).toMatchObject({ valid: false });
    if (!malformed.valid) expect(malformed.error).toMatch(/dom.?signals|public/i);
  });

  it("rejects caller DOM strings before they can enter a synthesis prompt", () => {
    const valid = validateCritiqueUiInput({
      image: { data: TINY_PNG_B64, mimeType: "image/png" },
      domSignals: {
        styles: { fontFamily: "x".repeat(501), fontSize: null, fontWeight: null, borderRadius: null, boxShadow: null, color: null, background: null, letterSpacing: null },
        accessibility: { contrastRatio: null, headingLevels: [], imagesMissingAlt: 0, unlabeledInteractive: 0, hasSkipLink: false },
        structure: { display: null, flexDirection: null, gridTemplateColumns: null, gap: null },
      },
    });
    expect(valid).toMatchObject({ valid: false });
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
  it("accepts trusted DOM capture only through its explicit internal parameter and never forwards _raw", () => {
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
    }, {
      styles: { fontFamily: null, fontSize: null, fontWeight: null, borderRadius: null, boxShadow: null, color: null, background: null, letterSpacing: null },
      accessibility: { contrastRatio: null, headingLevels: [], imagesMissingAlt: 0, unlabeledInteractive: 0, hasSkipLink: false },
      structure: { display: null, flexDirection: null, gridTemplateColumns: null, gap: null },
      motion: { signals: [{ selector: "button", property: "opacity", durationMs: 200, delayMs: 0 }], coverage: "full", inaccessibleStylesheets: 0, prefersReducedMotion: false },
    });
    expect(facts).toMatchObject({
      patternType: "dashboard",
      platform: "mobile",
      components: ["bottom-nav"],
      layoutForm: "stacked",
      domSignals: expect.objectContaining({ motion: expect.objectContaining({ signals: [expect.objectContaining({ selector: "button" })] }) }),
    });
    expect(JSON.stringify(facts)).not.toContain("sidebar-nav");
    expect(facts).not.toHaveProperty("_raw");
  });
});
