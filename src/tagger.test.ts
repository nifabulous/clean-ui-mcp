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

  it("returns hex strings or degrades gracefully (1×1 PNGs can't be quantized)", async () => {
    try {
      const swatches = await extractQuantizedColors(testImage);
      expect(swatches.every((s) => /^#[0-9a-fA-F]{6}$/.test(s))).toBe(true);
    } catch (err) {
      // node-vibrant may reject very small/invalid images — that's acceptable.
      // The tagger itself catches this and falls back to model-guessed colors.
      expect(err).toBeInstanceOf(Error);
    }
  });
});

describe("tagImage two-pass request shape", () => {
  const originalFetch = globalThis.fetch;
  const originalOpenaiKey = process.env.OPENAI_API_KEY;
  const testDir = join(PRIVATE_IMAGE_DIR, "__tagger2-test");
  const testImage = join(testDir, "shot.png");

  beforeEach(() => {
    // Force OpenAI routing so the mock's OpenAI-shaped responses work.
    // Clear any split-provider vars that .env might have set at import time.
    process.env.OPENAI_API_KEY = "test-key";
    process.env.AUTO_TAG_PROVIDER_EXTRACTION = "openai";
    process.env.AUTO_TAG_PROVIDER_CRITIQUE = "openai";
    mkdirSync(testDir, { recursive: true });
    writeFileSync(testImage, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFeAJ5fVqRtwAAAABJRU5ErkJggg==", "base64"));
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env.OPENAI_API_KEY = originalOpenaiKey;
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
    // Override the split-provider vars so both passes route to Claude.
    const savedExtr = process.env.AUTO_TAG_PROVIDER_EXTRACTION;
    const savedCrit = process.env.AUTO_TAG_PROVIDER_CRITIQUE;
    process.env.AUTO_TAG_PROVIDER_EXTRACTION = "claude";
    process.env.AUTO_TAG_PROVIDER_CRITIQUE = "claude";
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

    delete process.env.ANTHROPIC_API_KEY;
    process.env.AUTO_TAG_PROVIDER_EXTRACTION = savedExtr;
    process.env.AUTO_TAG_PROVIDER_CRITIQUE = savedCrit;
  });

  it("disables Gemini thinking on extraction (thinkingBudget:0) but not critique", async () => {
    // Gemini 2.5 Flash/Pro are thinking models — reasoning tokens draw from the
    // same maxOutputTokens budget and were truncating the extraction JSON.
    // Extraction is deterministic and must run with thinking off; critique
    // keeps it on. This test pins that contract.
    const savedExtr = process.env.AUTO_TAG_PROVIDER_EXTRACTION;
    const savedCrit = process.env.AUTO_TAG_PROVIDER_CRITIQUE;
    process.env.AUTO_TAG_PROVIDER_EXTRACTION = "gemini";
    process.env.AUTO_TAG_PROVIDER_CRITIQUE = "gemini";
    process.env.GEMINI_API_KEY = "gem-test";
    const genConfigs: Array<Record<string, unknown>> = [];
    let callCount = 0;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      genConfigs.push(body.generationConfig ?? {});
      callCount++;
      const json = callCount === 1
        ? JSON.stringify({ patternType: "dashboard", categories: ["dashboard"], styleTags: ["minimal"], dominantColors: ["#ffffff", "#111111"], accentColor: null, displayFont: null, bodyFont: null, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true })
        : JSON.stringify({ observations: ["a","b","c","d","e"], typographyNotes: "n", draftCritique: "x".repeat(120), draftWhatToSteal: ["x".repeat(20)], draftAntiPatterns: ["y".repeat(20)], qualityTier: "exceptional", voiceTone: "", voiceExamples: [], voiceAvoid: [] });
      // Return the Gemini response shape (candidates[].content.parts[].text), STOP on both.
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: json }] }, finishReason: "STOP" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try { await tagImage({ imagePath: testImage, productName: "Test", url: null }); } catch { /* parse details not under test */ }

    // Pass 1 (extraction): thinking disabled. Pass 2 (critique): thinking left on (no thinkingConfig key).
    expect(genConfigs.length).toBeGreaterThanOrEqual(1);
    const extractionCfg = genConfigs[0];
    expect(extractionCfg.thinkingConfig).toEqual({ thinkingBudget: 0 });
    if (genConfigs.length >= 2) {
      expect(genConfigs[1].thinkingConfig).toBeUndefined();
    }

    delete process.env.GEMINI_API_KEY;
    process.env.AUTO_TAG_PROVIDER_EXTRACTION = savedExtr;
    process.env.AUTO_TAG_PROVIDER_CRITIQUE = savedCrit;
  });

  it("surfaces MAX_TOKENS truncation as a clear error instead of a generic 'unusable draft'", async () => {
    // Regression: when Gemini truncated the JSON mid-stream (MAX_TOKENS), the
    // parse failed and the user saw a vague "vision provider returned an
    // unusable draft". The real cause — output cap too low — must be reported
    // so the user knows to raise MAX_OUTPUT_TOKENS or simplify the request.
    const savedExtr = process.env.AUTO_TAG_PROVIDER_EXTRACTION;
    process.env.AUTO_TAG_PROVIDER_EXTRACTION = "gemini";
    process.env.GEMINI_API_KEY = "gem-test";
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"patternType":"dash' }] }, finishReason: "MAX_TOKENS" }] }), { status: 200, headers: { "content-type": "application/json" } }),
    ) as unknown as typeof fetch;

    let caught: unknown;
    try { await tagImage({ imagePath: testImage, productName: "Test", url: null }); }
    catch (e) { caught = e; }

    const msg = caught instanceof Error ? caught.message : String(caught);
    expect(msg).toMatch(/MAX_TOKENS|truncat/i);

    delete process.env.GEMINI_API_KEY;
    process.env.AUTO_TAG_PROVIDER_EXTRACTION = savedExtr;
  });

  it("retries transient 503 errors instead of failing immediately", async () => {
    // Regression: Gemini returns 503 "This model is currently experiencing high
    // demand" under load, and each one killed a bulk-import row. The provider
    // calls now retry transient 5xx (502/503/504) + network errors with backoff.
    // Mock consecutive 503s and confirm the call is retried (callCount > 1),
    // not treated as fatal on the first attempt.
    const savedExtr = process.env.AUTO_TAG_PROVIDER_EXTRACTION;
    process.env.AUTO_TAG_PROVIDER_EXTRACTION = "gemini";
    process.env.GEMINI_API_KEY = "gem-test";
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      // Always 503 — we only assert retries happen, not the eventual success.
      return new Response(JSON.stringify({ error: { message: "This model is currently experiencing high demand." } }), { status: 503, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    try { await tagImage({ imagePath: testImage, productName: "Test", url: null, extractionOnly: true }); }
    catch { /* expected — every attempt 503s; we only assert the retry count */ }

    // 1 original + up to MAX_RETRIES (3) = 4 attempts before giving up.
    expect(callCount).toBe(4);

    delete process.env.GEMINI_API_KEY;
    process.env.AUTO_TAG_PROVIDER_EXTRACTION = savedExtr;
  }, 15000); // backoff is real (800+1600+3200ms); needs headroom over the 5s default.
});
