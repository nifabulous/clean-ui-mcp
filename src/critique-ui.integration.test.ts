/**
 * Integration tests for critique_ui.
 *
 * These tests hit real external APIs (Voyage for image embeddings, OpenAI for
 * the vision tagger) and are gated behind RUN_LIVE_INTEGRATION=1 + API keys.
 * Normal `npm test` never runs them — no cost, no rate-limits.
 *
 * To run: RUN_LIVE_INTEGRATION=1 npm test
 * Requires: OPENAI_API_KEY + IMAGE_EMBEDDING_API_KEY + IMAGE_EMBEDDING_PROVIDER=voyage
 *
 * The E2E test is hermetic: uses setCorpusForTesting with a temporary fixture
 * corpus, not the developer's real corpus/entries.json.
 */
import { describe, expect, it, afterEach, beforeAll } from "vitest";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { setCorpusForTesting } from "./corpus.js";

const RUN_LIVE = process.env.RUN_LIVE_INTEGRATION === "1"
  && !!process.env.IMAGE_EMBEDDING_API_KEY
  && !!process.env.OPENAI_API_KEY
  && process.env.IMAGE_EMBEDDING_PROVIDER === "voyage";

const LIVE_OPENAI_MODEL = process.env.LIVE_INTEGRATION_OPENAI_MODEL ?? "gpt-5.4-nano";

function openAiEndpointOverride() {
  return {
    provider: "openai" as const,
    baseUrl: "",
    apiKey: process.env.OPENAI_API_KEY!,
    model: LIVE_OPENAI_MODEL,
  };
}

const FIXTURE_DIR = resolve(import.meta.dirname ?? __dirname, "..", "eval", "critique-fixtures");
const DESKTOP_IMG = resolve(FIXTURE_DIR, "desktop-dashboard.png");

// ─── Voyage protocol contract test ────────────────────────────────────────────

(RUN_LIVE ? describe : describe.skip)("Voyage multimodal embeddings API contract", () => {
  it("returns a non-empty finite vector for a real image", async () => {
    const { createImageEmbeddingProvider } = await import("./image-embeddings.js");
    const provider = createImageEmbeddingProvider();
    expect(provider).not.toBeNull();

    const imgData = readFileSync(DESKTOP_IMG);
    const vec = await provider!.embedImage({ data: imgData, mimeType: "image/png" });

    expect(vec.length).toBeGreaterThan(0);
    expect(vec.every((v) => Number.isFinite(v))).toBe(true);
  }, 30_000); // 30s timeout — real API call

  it("vector dimension matches across calls (deterministic)", async () => {
    const { createImageEmbeddingProvider } = await import("./image-embeddings.js");
    const provider = createImageEmbeddingProvider()!;

    const imgData = readFileSync(DESKTOP_IMG);
    const vec1 = await provider.embedImage({ data: imgData, mimeType: "image/png" });
    const vec2 = await provider.embedImage({ data: imgData, mimeType: "image/png" });

    expect(vec1.length).toBe(vec2.length);
  }, 60_000); // 2 API calls

  // I2 fix: verify the actual request body shape sent to the API, not just
  // the response. This is the test that would have caught the request-shape
  // bug (sending { type: "image" } instead of { content: [{ type: "image_base64" }] }).
  it("sends the correct request body shape to the Voyage API", async () => {
    const { createImageEmbeddingProvider } = await import("./image-embeddings.js");
    const provider = createImageEmbeddingProvider()!;

    // Spy on fetch to capture the outgoing request body
    const originalFetch = globalThis.fetch;
    let capturedBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) capturedBody = JSON.parse(String(init.body));
      return originalFetch(_input, init);
    }) as typeof fetch;

    try {
      const imgData = readFileSync(DESKTOP_IMG);
      await provider.embedImage({ data: imgData, mimeType: "image/png" });

      // Assert the request shape matches Voyage's documented multimodal API format
      expect(capturedBody).not.toBeNull();
      const body = capturedBody!;
      expect(body).toHaveProperty("inputs");
      expect(body).toHaveProperty("model");

      const inputs = body.inputs as unknown[];
      expect(inputs.length).toBe(1);
      const input0 = inputs[0] as Record<string, unknown>;
      expect(input0).toHaveProperty("content");
      const content = input0.content as Array<Record<string, unknown>>;
      expect(content.length).toBe(1);
      expect(content[0].type).toBe("image_base64");
      expect(content[0].image_base64).toMatch(/^data:image\/png;base64,/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }, 30_000);
});

// ─── End-to-end critique pipeline (hermetic) ──────────────────────────────────

(RUN_LIVE ? describe : describe.skip)("critique_ui end-to-end (hermetic fixtures)", () => {
  // Build a temporary fixture corpus — no dependence on corpus/entries.json.
  // These entries reference the synthetic fixture images in eval/critique-fixtures/.
  beforeAll(() => {
    setCorpusForTesting([
      {
        id: "fixture-dashboard-1",
        title: "Fixture Dashboard",
        patternType: "dashboard",
        platform: "web",
        reviewStatus: "approved",
        qualityScore: 3,
        qualityTier: "exceptional",
        image: { visibility: "private", path: null, width: 1280, height: 800 },
        critique: "Clean dashboard with good information hierarchy.",
        whatToSteal: ["Sidebar + main canvas layout"],
        antiPatterns: { antiPatterns: [], whereThisFails: [], accessibilityRisks: [] },
        categories: ["dashboard"],
        styleTags: ["minimal"],
        components: ["sidebar-nav", "kpi-card"],
        domainTags: ["analytics"],
        visual: {
          spacingDensity: "moderate",
          cornerStyle: "slight-round",
          usesShadows: false,
          usesBorders: true,
        },
        layout: { form: "sidebar+main", regions: [] },
        addedAt: "2026-01-01",
        provenance: { taggedBy: "fixture" },
      },
    ] as never);
  });

  afterEach(async () => {
    setCorpusForTesting(null);
    // Reset the image index override — await the import so the reset
    // completes before the next test starts (was fire-and-forget).
    const { setImageIndexForTesting } = await import("./image-index.js");
    setImageIndexForTesting(null);
  });

  it("every recommendation has at least one valid evidence ID", async () => {
    const { validateCritiqueUiInput, withValidatedImageFile, toNormalizedTaggerFacts } = await import("./critique-ui.js");
    const { retrieveCritiqueEvidence } = await import("./critique-retrieval.js");
    const { createImageEmbeddingProvider } = await import("./image-embeddings.js");
    const { loadImageIndex, setImageIndexForTesting, hashForImage } = await import("./image-index.js");
    type ImageEmbeddingIndex = import("./image-index.js").ImageEmbeddingIndex;
    const { buildCritiqueEvidence, synthesizeCritique, gateCritique } = await import("./critique-synthesis.js");
    const { tagImage } = await import("./tagger.js");
    const { hasVisionKey } = await import("./tagger.js");

    if (!hasVisionKey()) return;

    // Read the fixture image
    const imgData = readFileSync(DESKTOP_IMG);
    const imgBase64 = imgData.toString("base64");

    const validation = validateCritiqueUiInput({
      image: { data: imgBase64, mimeType: "image/png" },
      productContext: "A KPI tracking dashboard",
      platform: "web",
    });
    expect(validation.valid).toBe(true);
    if (!validation.valid) return;

    // Extract facts via tagger
    const tagged = await withValidatedImageFile(validation.input, async (imagePath) => {
      return tagImage({
        imagePath,
        productName: "Dashboard",
        url: null,
        imageDetail: "low",
        extractionOnly: true,
        extractionOverride: openAiEndpointOverride(),
      });
    });
    const extraction = toNormalizedTaggerFacts(tagged);
    const platform = validation.input.platform ?? tagged.platform ?? "web";

    // I1 fix: build a hermetic fixture image index by embedding the fixture
    // images with the real provider, then inject via setImageIndexForTesting.
    // This avoids reading the developer's real corpus/image-embeddings.json.
    const imageProvider = createImageEmbeddingProvider();
    if (imageProvider) {
      const fixtureVec = await imageProvider.embedImage({ data: imgData, mimeType: "image/png" });
      const fixtureIndex: ImageEmbeddingIndex = {
        version: 1,
        model: imageProvider.model,
        dimension: fixtureVec.length,
        entries: {
          "fixture-dashboard-1": { vector: fixtureVec, hash: hashForImage(imgData) },
        },
      };
      setImageIndexForTesting(fixtureIndex);
    }

    const imageIndex = imageProvider ? loadImageIndex(imageProvider.model) : null;

    const retrieval = await retrieveCritiqueEvidence({
      imageProvider,
      imageData: imgData,
      imageMimeType: "image/png",
      extraction,
      productContext: validation.input.productContext,
      platform,
      imageIndex,
    });

    // Synthesize critique
    const evidence = buildCritiqueEvidence(extraction, retrieval, validation.input.productContext);
    const evidenceIds = evidence.map((e) => e.id);
    const draft = await synthesizeCritique(evidence, {
      productContext: validation.input.productContext,
      platform,
      providerOverride: "openai",
      endpointOverride: openAiEndpointOverride(),
    });
    const gated = gateCritique(draft, evidenceIds);

    // Core assertion: every actionable recommendation must cite valid evidence.
    // The gate CAN return zero recommendations when evidence is weak — that's fine.
    // But any recommendation that survives MUST have evidence.
    for (const rec of gated.recommendations) {
      expect(rec.evidence.length).toBeGreaterThan(0);
      // Every cited evidence ID must be in the valid set
      for (const eid of rec.evidence) {
        expect(evidenceIds).toContain(eid);
      }
    }
  }, 60_000);
});
