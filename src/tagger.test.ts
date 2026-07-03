import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeTaggerPayload, tagImage } from "./tagger.js";
import { PRIVATE_IMAGE_DIR } from "./paths.js";

describe("tagger sanitization", () => {
  it("keeps only schema-safe values from model output", () => {
    const sanitized = sanitizeTaggerPayload({
      categories: ["dashboard", "made-up"],
      styleTags: ["minimal", "nope"],
      dominantColors: ["#ABCDEF", "blue", "#111111"],
      accentColor: "red",
      spacingDensity: "huge",
      cornerStyle: "pill",
      usesShadows: "yes",
      usesBorders: false,
      draftCritique: "Specific draft critique.",
      draftWhatToSteal: ["Use a clear spacing rhythm."],
    });

    expect(sanitized.categories).toEqual(["dashboard"]);
    expect(sanitized.styleTags).toEqual(["minimal"]);
    expect(sanitized.dominantColors).toEqual(["#abcdef", "#111111"]);
    expect(sanitized.accentColor).toBeNull();
    expect(sanitized.spacingDensity).toBe("moderate");
    expect(sanitized.cornerStyle).toBe("pill");
    expect(sanitized.usesShadows).toBe(false);
    expect(sanitized.usesBorders).toBe(false);
  });

  it("supplies useful defaults for unusable model output", () => {
    const sanitized = sanitizeTaggerPayload({});

    expect(sanitized.categories).toEqual(["dashboard"]);
    expect(sanitized.styleTags).toEqual(["minimal"]);
    expect(sanitized.dominantColors).toEqual(["#ffffff", "#111111"]);
    expect(sanitized.draftCritique.length).toBeGreaterThan(80);
    expect(sanitized.draftWhatToSteal[0].length).toBeGreaterThan(10);
  });
});

describe("tagImage request shape", () => {
  // Regression guard: 'low' detail + 1200-token cap produced shallow, truncated
  // "what to steal" output. These two values are the quality floor for drafts.
  const originalFetch = globalThis.fetch;
  const testDir = join(PRIVATE_IMAGE_DIR, "__tagger-test");
  const testImage = join(testDir, "shot.png");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    // 1x1 PNG — the bytes don't matter; fetch is mocked before they're read.
    writeFileSync(testImage, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFeAJ5fVqRtwAAAABJRU5ErkJggg==", "base64"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("sends high image detail and a non-truncating output budget", async () => {
    let capturedBody: { max_output_tokens?: number; input?: Array<{ content?: Array<Record<string, unknown>> }> } | null = null;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({
      output_text: JSON.stringify({
        categories: ["dashboard"], styleTags: ["minimal"],
        dominantColors: ["#ffffff"], accentColor: null,
        displayFont: null, bodyFont: null, typographyNotes: "x",
        spacingDensity: "moderate", cornerStyle: "slight-round",
        usesShadows: false, usesBorders: true,
        draftCritique: "Specific enough critique to pass validation length checks without being padded out.",
        draftWhatToSteal: ["One concrete technique a developer could copy directly into their own work."],
      }),
    }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    // Wrap to capture the POST body.
    const realMock = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body ?? "{}"));
      return realMock(input, init);
    }) as typeof fetch;

    await tagImage({ imagePath: testImage, productName: "Test", url: null });

    const imageInput = capturedBody?.input?.[1]?.content?.find((c) => c.type === "input_image");
    expect(capturedBody?.max_output_tokens).toBeGreaterThanOrEqual(2500);
    expect(imageInput?.detail).toBe("high");
  });
});
