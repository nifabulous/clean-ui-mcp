import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeTaggerPayload, tagImage, extractQuantizedColors } from "./tagger.js";
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

describe("extractQuantizedColors (node-vibrant)", () => {
  // Use a real corpus screenshot so node-vibrant has real pixels to work with.
  // Falls back to a synthetic image if the corpus screenshot isn't present.
  const realImage = join(PRIVATE_IMAGE_DIR, "sample-5.png");
  const testDir = join(PRIVATE_IMAGE_DIR, "__quantized-test");
  const testImage = existsSync(realImage) ? realImage : join(testDir, "shot.png");

  beforeEach(() => {
    if (!existsSync(realImage)) {
      mkdirSync(testDir, { recursive: true });
      writeFileSync(testImage, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFeAJ5fVqRtwAAAABJRU5ErkJggg==", "base64"));
    }
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("returns hex strings, not throws", async () => {
    const swatches = await extractQuantizedColors(testImage);
    expect(swatches.length).toBeGreaterThan(0);
    expect(swatches.every((s) => /^#[0-9a-fA-F]{6}$/.test(s))).toBe(true);
  });
});

describe("tagImage two-pass request shape", () => {
  const originalFetch = globalThis.fetch;
  const testDir = join(PRIVATE_IMAGE_DIR, "__tagger2-test");
  const testImage = join(testDir, "shot.png");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(testImage, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFeAJ5fVqRtwAAAABJRU5ErkJggg==", "base64"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("makes two API calls — Pass 1 with image (detail:high), Pass 2 text-only", async () => {
    const calls: Array<{ body: { max_output_tokens?: number; input?: Array<{ content?: Array<Record<string, unknown>> }> } }> = [];
    let callCount = 0;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ body });
      callCount++;
      // Pass 1 returns extraction JSON; Pass 2 returns critique JSON.
      const response = callCount === 1
        ? JSON.stringify({
            patternType: "dashboard", categories: ["dashboard"], styleTags: ["minimal"],
            dominantColors: ["#ffffff", "#111111"], accentColor: null,
            displayFont: null, bodyFont: null, spacingDensity: "moderate", cornerStyle: "slight-round",
            usesShadows: false, usesBorders: true,
          })
        : JSON.stringify({
            observations: ["a", "b", "c", "d", "e"],
            typographyNotes: "notes",
            draftCritique: "This design uses hairline borders at low contrast to do structural work without the visual weight of heavier lines, so the eye reads grouping without noticing the borders. It rejects the common default of 1px black borders, which read as frames rather than separators.",
            draftWhatToSteal: ["Use hairline borders at 10% opacity for structural separation instead of visible frame borders."],
            draftAntiPatterns: ["Avoids card shadows for depth — uses background-color steps of the same hue so surfaces stay flat."],
            qualityTier: "exceptional",
          });
      return new Response(JSON.stringify({ output_text: response }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await tagImage({ imagePath: testImage, productName: "Test", url: null });

    // Two calls made
    expect(calls.length).toBe(2);

    // Pass 1: has image input + detail high
    const pass1Image = calls[0].body.input?.[1]?.content?.find((c) => c.type === "input_image");
    expect(pass1Image?.detail).toBe("high");

    // Pass 2: no image input
    const pass2Image = calls[1].body.input?.[1]?.content?.find((c) => c.type === "input_image");
    expect(pass2Image).toBeUndefined();

    // Both passes: token budget adequate
    expect(calls[0].body.max_output_tokens).toBeGreaterThanOrEqual(2500);
    expect(calls[1].body.max_output_tokens).toBeGreaterThanOrEqual(2500);
  });

  it("routes to the Claude endpoint when AUTO_TAG_PROVIDER=claude", async () => {
    process.env.AUTO_TAG_PROVIDER = "claude";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    const fetchUrls: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      fetchUrls.push(url);
      // Return the Claude response shape (content[].text), not OpenAI's output_text.
      const json = JSON.stringify({ patternType: "dashboard", categories: ["dashboard"], styleTags: ["minimal"], draftCritique: "test", draftWhatToSteal: ["x"], draftAntiPatterns: ["y"], qualityTier: "exceptional", typographyNotes: "n", observations: ["a","b","c","d","e"], voiceTone: "", voiceExamples: [], voiceAvoid: [] });
      return new Response(JSON.stringify({ content: [{ type: "text", text: json }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try {
      await tagImage({ imagePath: testImage, productName: "Test", url: null });
    } catch { /* may fail on parse, we only care about the URL routing */ }

    expect(fetchUrls.some((u) => u.includes("anthropic.com"))).toBe(true);
    expect(fetchUrls.some((u) => u.includes("openai.com"))).toBe(false);

    delete process.env.AUTO_TAG_PROVIDER;
    delete process.env.ANTHROPIC_API_KEY;
  });
});
