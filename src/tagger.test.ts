import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sanitizeTaggerPayload, tagImage, extractQuantizedColors, hasVisionKey, activeModelName, validateNoIconOnlyClaims, scrubProseIconOnly } from "./tagger.js";
import { PRIVATE_IMAGE_DIR } from "./paths.js";

describe("tagger sanitization", () => {
  it("keeps only schema-safe values from model output", () => {
    const sanitized = sanitizeTaggerPayload({
      categories: ["dashboard", "made-up"],
      styleTags: ["minimal", "nope"],
      components: ["kpi-card", "donut-chart", "made-up-widget"],
      domainTags: ["billing", "usage", "fake-domain"],
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
    expect(sanitized.components).toEqual(["kpi-card", "donut-chart"]);
    expect(sanitized.domainTags).toEqual(["billing", "usage"]);
    expect(sanitized.dominantColors).toEqual(["#abcdef", "#111111"]);
    expect(sanitized.accentColor).toBeNull();
    expect(sanitized.spacingDensity).toBe("moderate");
    expect(sanitized.cornerStyle).toBe("pill");
    expect(sanitized.usesShadows).toBe(false);
    expect(sanitized.usesBorders).toBe(false);
  });

  it("parses structured accessibility risks with confidence and rejects dom-grounded", () => {
    const sanitized = sanitizeTaggerPayload({
      draftAccessibilityRisks: [
        { element: "status chips", risk: "Color-only differentiation invisible to color-blind users", evidence: "8px red/green dots beside Paid and Failed rows with no text status label", confidence: "visible", wcag: "1.4.1" },
        { element: "contrast text", risk: "Low contrast on labels", evidence: "secondary label at #999 on #fff background, computed ratio 2.8:1", confidence: "dom-grounded" },
      ],
    });

    expect(sanitized.draftAccessibilityRisks).toHaveLength(2);
    expect(sanitized.draftAccessibilityRisks[0]).toEqual({
      element: "status chips", risk: "Color-only differentiation invisible to color-blind users",
      evidence: "8px red/green dots beside Paid and Failed rows with no text status label",
      confidence: "visible", wcag: "1.4.1",
    });
    // dom-grounded must be downgraded to inferred — that tag is code-only
    expect(sanitized.draftAccessibilityRisks[1].confidence).toBe("inferred");
  });

  it("drops accessibility risks without evidence", () => {
    const sanitized = sanitizeTaggerPayload({
      draftAccessibilityRisks: [
        { element: "sidebar", risk: "Icon-only controls may lack accessible names.", evidence: "", confidence: "inferred" },
      ],
    });
    expect(sanitized.draftAccessibilityRisks).toEqual([]);
  });

  it("drops icon-only risks when evidence names visible text labels", () => {
    const sanitized = sanitizeTaggerPayload({
      draftAccessibilityRisks: [{
        element: "sidebar icons",
        risk: "Icon-only controls may lack accessible names.",
        evidence: "visible labels: Home, Cards, Transactions, Balance",
        confidence: "inferred",
        wcag: "1.1.1 Non-text Content",
      }],
    });
    expect(sanitized.draftAccessibilityRisks).toEqual([]);
  });

  it("drops ALL model-generated icon-only risks — even with confident absence claims", () => {
    // The model hallucinated "no visible text labels" on Workable where labels
    // were clearly visible. Policy: model-generated icon-only risks are NEVER
    // trusted. Only DOM ground truth (unlabeledInteractive) can produce one,
    // and that is code-injected, not model-generated.
    const sanitized = sanitizeTaggerPayload({
      draftAccessibilityRisks: [{
        element: "sidebar icon-only navigation items",
        risk: "All navigation items in the left sidebar are represented solely by icons with no visible text labels.",
        evidence: "The left sidebar contains 6+ icon buttons with no visible text labels beside them; icons include a house, briefcase, chart, and gear.",
        confidence: "visible",
        wcag: "1.1.1 Non-text Content",
      }],
    });
    // Even with explicit "no visible text labels" — dropped. The model's
    // pixel-only absence claims are too easy to hallucinate.
    expect(sanitized.draftAccessibilityRisks).toEqual([]);

    // Also drops weaker phrasings
    const sanitized2 = sanitizeTaggerPayload({
      draftAccessibilityRisks: [{
        element: "sidebar navigation buttons",
        risk: "Navigation destinations are communicated by icon symbols alone.",
        evidence: "The primary-nav region is described as a vertically stacked set of icon buttons along the left edge.",
        confidence: "inferred",
      }],
    });
    expect(sanitized2.draftAccessibilityRisks).toEqual([]);
  });

  it("drops self-referential evidence (model citing its own extraction output)", () => {
    // Regression: hume-hume-12's a11y evidence said "The component inventory
    // lists 'icon-button' as a standalone element" — reasoning from the prompt
    // (the extraction JSON), not from the screenshot. The model was using its
    // own output as evidence.
    const sanitized = sanitizeTaggerPayload({
      draftAccessibilityRisks: [{
        element: "sidebar icon-button",
        risk: "Icon button lacks an accessible name visible on screen.",
        evidence: "The component inventory lists 'icon-button' as a standalone element.",
        confidence: "inferred",
      }],
    });
    expect(sanitized.draftAccessibilityRisks).toEqual([]);
  });

  it("drops ALL absence-of-label claims on controls — pixels cannot establish absence of an accessible name", () => {
    // The policy is broader than just "icon-only": ANY claim that a control
    // lacks a text label or accessible name is dropped, because the model is
    // inferring absence from pixels. Covers "icon with no text label",
    // "glyph with no label", "unlabeled button", "no accessible name", etc.
    // Only DOM ground truth (unlabeledInteractive) can establish this.
    const sanitized = sanitizeTaggerPayload({
      draftAccessibilityRisks: [
        { element: "send button", risk: "Send action uses a paper-plane icon with no text label.", evidence: "Bottom-right of the chat composer shows a paper-plane glyph inside a circle; no 'Send' text is visible.", confidence: "visible" },
        { element: "close button", risk: "Close control is a glyph with no label.", evidence: "Top-right corner shows an X glyph with no visible text label beside it.", confidence: "visible" },
        { element: "nav items", risk: "Unlabeled buttons in the header.", evidence: "Three icon buttons in the top nav with no accessible name visible.", confidence: "inferred" },
        { element: "action bar", risk: "Controls lack accessible names.", evidence: "The action bar relies on memorized icon shapes for recognition.", confidence: "inferred" },
      ],
    });
    expect(sanitized.draftAccessibilityRisks).toEqual([]);
  });

  it("keeps evidence that describes a visible screenshot detail, not an absence claim", () => {
    // A legitimate color-only risk: names a concrete visible element (status
    // dots) and what it communicates. This is a PRESENCE claim, not an absence
    // claim — it survives the gate.
    const sanitized = sanitizeTaggerPayload({
      draftAccessibilityRisks: [{
        element: "payment status dot",
        risk: "State is communicated by color alone, which color-blind users may miss.",
        evidence: "Small red and green dots beside the Paid and Failed rows, with no text status label.",
        confidence: "visible",
        wcag: "1.4.1 Use of Color",
      }],
    });
    expect(sanitized.draftAccessibilityRisks).toHaveLength(1);
  });

  describe("icon-only prose gate (stops hallucination migrating to prose)", () => {
    it("flags icon-only assertions in critique/whatToSteal/businessRationale", () => {
      const errors = validateNoIconOnlyClaims({
        draftCritique: "The sidebar uses icon-only buttons with no text labels.",
        draftWhatToSteal: ["Use icon-only navigation in a fixed-narrow sidebar to reduce visual load."],
        businessRationale: { rationale: "The icon-only sidebar reduces friction for frequent users." },
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toMatch(/icon-only/i);
    });

    it("does NOT flag contrast/rejection sentences (correct observations)", () => {
      // origin-origin-2 correctly said the sidebar "keeps icons paired with text
      // labels instead of going icon-only" — that's a legitimate observation,
      // not a hallucination.
      const errors = validateNoIconOnlyClaims({
        draftCritique: "The sidebar keeps icons paired with text labels instead of going icon-only.",
        draftWhatToSteal: ["Avoid icon-only navigation when first-time users are common; pair icons with labels."],
      });
      expect(errors).toEqual([]);
    });

    it("scrubs icon-only assertion sentences but preserves contrast sentences", () => {
      const critique = {
        draftCritique: "The sidebar uses icon-only buttons with no text labels. This works for returning users. The sidebar keeps icons paired with text labels instead of going icon-only.",
        draftWhatToSteal: ["Use icon-only navigation for daily-active users."],
        draftAntiPatterns: ["Avoid labeling every icon in the sidebar."],
        typographyNotes: "The lack of labels on icons forces reliance on memorized shapes.",
      };
      scrubProseIconOnly(critique);
      // Assertion sentence removed; contrast sentence + neutral sentence kept.
      expect(critique.draftCritique).not.toContain("icon-only buttons");
      expect(critique.draftCritique).toContain("This works for returning users");
      expect(critique.draftCritique).toContain("instead of going icon-only");
      // whatToSteal assertion entry dropped, but fallback restores a non-empty
      // placeholder so the schema's min(1) constraint isn't violated.
      expect(critique.draftWhatToSteal).toHaveLength(1);
      expect(critique.draftWhatToSteal[0]).toMatch(/Review the screenshot/i);
      // antiPatterns entry has no icon-only claim — kept.
      expect(critique.draftAntiPatterns).toHaveLength(1);
      // typographyNotes assertion sentence removed.
      expect(critique.typographyNotes).not.toContain("memorized shapes");
    });

    it("preserves businessRationale.rationale by stripping only the assertion sentence", () => {
      const critique = {
        draftCritique: "A valid critique with no icon-only claims.",
        draftWhatToSteal: ["A valid technique."],
        draftAntiPatterns: ["A valid avoided mistake."],
        typographyNotes: "Valid notes.",
        businessRationale: {
          businessGoal: "drive-habitual-use",
          targetUser: "daily users",
          rationale: "The icon-only sidebar reduces friction. A second sentence about onboarding.",
          confirmed: false,
        },
      };
      scrubProseIconOnly(critique);
      expect(critique.businessRationale?.rationale).not.toContain("icon-only");
      expect(critique.businessRationale?.rationale).toContain("A second sentence about onboarding");
    });
  });

  it("drops color-only risks when evidence is only a palette color", () => {
    const sanitized = sanitizeTaggerPayload({
      draftAccessibilityRisks: [{
        element: "status chips",
        risk: "Purple is used as the sole status differentiator.",
        evidence: "#7464a4 from dominant color palette",
        confidence: "inferred",
        wcag: "1.4.1 Use of Color",
      }],
    });
    expect(sanitized.draftAccessibilityRisks).toEqual([]);
  });

  it("keeps visible color-only risks with concrete UI evidence", () => {
    const sanitized = sanitizeTaggerPayload({
      draftAccessibilityRisks: [{
        element: "payment status dot",
        risk: "State is communicated by color alone, which color-blind users may miss.",
        evidence: "8px red/green dots beside Paid and Failed rows with no text status label",
        confidence: "visible",
        wcag: "1.4.1 Use of Color",
      }],
    });
    expect(sanitized.draftAccessibilityRisks).toHaveLength(1);
  });

  it("caps non-DOM accessibility risks to two", () => {
    const risks = [1, 2, 3].map((n) => ({
      element: `visible control ${n}`,
      risk: `Risk ${n} with enough specific detail for validation.`,
      evidence: `top-right region ${n} with visible control and label`,
      confidence: "visible",
    }));
    const sanitized = sanitizeTaggerPayload({ draftAccessibilityRisks: risks });
    expect(sanitized.draftAccessibilityRisks).toHaveLength(2);
  });

  it("keeps evidence on structured accessibility risks", () => {
    const sanitized = sanitizeTaggerPayload({
      draftAccessibilityRisks: [{
        element: "payment status dot",
        risk: "State is communicated by color alone.",
        evidence: "8px red/green dots beside Paid and Failed rows",
        confidence: "visible",
      }],
    });
    expect(sanitized.draftAccessibilityRisks[0].evidence).toBe("8px red/green dots beside Paid and Failed rows");
  });

  it("supplies useful defaults for unusable model output", () => {
    const sanitized = sanitizeTaggerPayload({});

    expect(sanitized.categories).toEqual(["dashboard"]);
    expect(sanitized.styleTags).toEqual(["minimal"]);
    expect(sanitized.components).toEqual([]);
    expect(sanitized.dominantColors).toEqual(["#ffffff", "#111111"]);
    expect(sanitized.draftCritique.length).toBeGreaterThan(80);
    expect(sanitized.draftWhatToSteal[0].length).toBeGreaterThan(10);
  });

  it("keeps complete businessRationale objects and drops incomplete ones", () => {
    const complete = sanitizeTaggerPayload({
      businessRationale: {
        businessGoal: "build-trust",
        targetUser: "first-time buyer",
        rationale: "The proof-heavy layout reassures skeptical buyers before they compare plans.",
        confirmed: true,
      },
    });

    expect(complete.businessRationale).toEqual({
      businessGoal: "build-trust",
      targetUser: "first-time buyer",
      rationale: "The proof-heavy layout reassures skeptical buyers before they compare plans.",
      confirmed: true,
    });

    const incomplete = sanitizeTaggerPayload({
      businessRationale: {
        businessGoal: "build-trust",
        targetUser: "first-time buyer",
      },
    });

    expect(incomplete.businessRationale).toBeUndefined();
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

describe("vision provider key detection", () => {
  const original = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_API_KEY_EXTRACTION: process.env.OPENAI_API_KEY_EXTRACTION,
    OPENAI_API_KEY_CRITIQUE: process.env.OPENAI_API_KEY_CRITIQUE,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };

  afterEach(() => {
    for (const key of Object.keys(original) as Array<keyof typeof original>) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("accepts any configured vision provider key, not only OpenAI", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY_EXTRACTION;
    delete process.env.OPENAI_API_KEY_CRITIQUE;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.MINIMAX_API_KEY;

    expect(hasVisionKey()).toBe(false);

    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    expect(hasVisionKey()).toBe(true);

    delete process.env.ANTHROPIC_API_KEY;
    process.env.GEMINI_API_KEY = "gem-test";
    expect(hasVisionKey()).toBe(true);

    delete process.env.GEMINI_API_KEY;
    process.env.MINIMAX_API_KEY = "sk-api-test";
    expect(hasVisionKey()).toBe(true);
  });

  it("recognizes per-pass OpenAI key variants (split-provider setups)", () => {
    // The vision gate must count ONLY extraction-capable keys. A critique-only
    // key (OPENAI_API_KEY_CRITIQUE for NIM/DeepSeek) cannot do vision, so it
    // must NOT satisfy hasVisionKey — otherwise the UI advertises auto-tagging
    // and then fails at the extraction pass.
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY_EXTRACTION;
    delete process.env.OPENAI_API_KEY_CRITIQUE;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.MINIMAX_API_KEY;

    expect(hasVisionKey()).toBe(false);

    // Critique-only key does NOT satisfy the vision gate (corrected behavior).
    process.env.OPENAI_API_KEY_CRITIQUE = "nvapi-test";
    expect(hasVisionKey()).toBe(false);

    // Extraction-capable keys DO satisfy the vision gate.
    delete process.env.OPENAI_API_KEY_CRITIQUE;
    process.env.OPENAI_API_KEY_EXTRACTION = "sk-test";
    expect(hasVisionKey()).toBe(true);

    // Bare OPENAI_API_KEY also satisfies the vision gate (used for both passes).
    delete process.env.OPENAI_API_KEY_EXTRACTION;
    process.env.OPENAI_API_KEY = "sk-proj-test";
    expect(hasVisionKey()).toBe(true);
  });
});

describe("activeModelName per-pass resolution", () => {
  const original = {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_API_KEY_EXTRACTION: process.env.OPENAI_API_KEY_EXTRACTION,
    OPENAI_API_KEY_CRITIQUE: process.env.OPENAI_API_KEY_CRITIQUE,
    OPENAI_AUTO_TAG_MODEL: process.env.OPENAI_AUTO_TAG_MODEL,
    OPENAI_AUTO_TAG_MODEL_EXTRACTION: process.env.OPENAI_AUTO_TAG_MODEL_EXTRACTION,
    OPENAI_AUTO_TAG_MODEL_CRITIQUE: process.env.OPENAI_AUTO_TAG_MODEL_CRITIQUE,
    OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
    OPENAI_BASE_URL_EXTRACTION: process.env.OPENAI_BASE_URL_EXTRACTION,
    OPENAI_BASE_URL_CRITIQUE: process.env.OPENAI_BASE_URL_CRITIQUE,
    AUTO_TAG_PROVIDER: process.env.AUTO_TAG_PROVIDER,
    AUTO_TAG_PROVIDER_EXTRACTION: process.env.AUTO_TAG_PROVIDER_EXTRACTION,
    AUTO_TAG_PROVIDER_CRITIQUE: process.env.AUTO_TAG_PROVIDER_CRITIQUE,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY,
  };

  afterEach(() => {
    for (const key of Object.keys(original) as Array<keyof typeof original>) {
      const value = original[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("reports the per-pass model override, not the OpenAI default", () => {
    // Simulate the DeepSeek-on-NIM-for-critique setup from the bulk-import work:
    // extraction routes to real OpenAI (gpt-5.4-mini), critique routes to NIM
    // (deepseek-v4-pro). Without per-pass resolution, activeModelName("critique")
    // reported "gpt-5.4-mini" — the /api/config status exposed to the UI lied.
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_BASE_URL_EXTRACTION;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.GEMINI_API_KEY;

    process.env.OPENAI_API_KEY = "sk-test";
    process.env.OPENAI_API_KEY_CRITIQUE = "nvapi-test";
    process.env.OPENAI_AUTO_TAG_MODEL = "gpt-5.4-mini";
    process.env.OPENAI_BASE_URL_CRITIQUE = "https://integrate.api.nvidia.com/v1";
    process.env.OPENAI_AUTO_TAG_MODEL_CRITIQUE = "deepseek-ai/deepseek-v4-pro";
    process.env.AUTO_TAG_PROVIDER_EXTRACTION = "openai";
    process.env.AUTO_TAG_PROVIDER_CRITIQUE = "openai";

    expect(activeModelName("extraction")).toBe("gpt-5.4-mini");
    expect(activeModelName("critique")).toBe("deepseek-ai/deepseek-v4-pro");
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
    // Clear per-pass base URL overrides so critique routes through the native
    // Responses API (output_text) that the mock returns, not callOpenAICompatible
    // (chat completions choices[].message.content) that DeepSeek/NIM would use.
    delete process.env.OPENAI_BASE_URL_CRITIQUE;
    delete process.env.OPENAI_API_KEY_CRITIQUE;
    delete process.env.OPENAI_AUTO_TAG_MODEL_CRITIQUE;
    mkdirSync(testDir, { recursive: true, force: true });
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
            components: ["sidebar-nav", "kpi-card", "donut-chart", "line-chart", "report-list"],
            domainTags: ["integrations"],
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
            businessRationale: {
              businessGoal: "reduce-cognitive-load-at-decision-point",
              targetUser: "operations manager",
              rationale: "The restrained grouping helps managers compare dense status data before deciding what needs attention.",
              confirmed: false,
            },
            qualityTier: "exceptional",
          });
      return new Response(JSON.stringify({ output_text: response }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const entry = await tagImage({ imagePath: testImage, productName: "Test", url: null });

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
    expect(entry.businessRationale).toEqual({
      businessGoal: "reduce-cognitive-load-at-decision-point",
      targetUser: "operations manager",
      rationale: "The restrained grouping helps managers compare dense status data before deciding what needs attention.",
      confirmed: false,
    });
    expect(entry.components).toEqual(["sidebar-nav", "kpi-card", "donut-chart", "line-chart", "report-list"]);
    expect(entry.domainTags).toEqual(["integrations"]);
    const pass1Prompt = String(calls[0].body.input?.[1]?.content?.[0]?.text ?? "");
    expect(pass1Prompt).toContain('"components"');
    expect(pass1Prompt).toContain("kpi-card");
    expect(pass1Prompt).toContain('"domainTags"');
    expect(pass1Prompt).toContain('Settings / Integrations');
    expect(pass1Prompt).toContain('domainTags:["integrations"]');
  });

  it("surfaces suggestedPatternType as persisted patternDiscovery metadata", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
      callCount++;
      const response = callCount === 1
        ? JSON.stringify({
            patternType: "dashboard",
            suggestedPatternType: "monitoring-console",
            categories: ["dashboard"],
            styleTags: ["technical-mono"],
            dominantColors: ["#ffffff", "#111111"],
            accentColor: null,
            spacingDensity: "compact",
            cornerStyle: "sharp",
            usesShadows: false,
            usesBorders: true,
          })
        : JSON.stringify({
            observations: ["dense monitoring table", "status rows", "compact filters", "left navigation", "alert counters"],
            typographyNotes: "Compact technical labels prioritize scanning.",
            draftCritique: "The monitoring layout compresses status rows and filters into one scan path, helping operators compare live conditions without moving between separate pages.",
            draftWhatToSteal: ["Keep status rows and filters in the same visual lane when operators must diagnose changing system conditions quickly."],
            draftAntiPatterns: ["Avoid spreading live status across isolated cards when the task is comparison under time pressure."],
            draftAccessibilityRisks: [],
            qualityTier: "exceptional",
          });
      return new Response(JSON.stringify({ output_text: response }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const entry = await tagImage({ imagePath: testImage, productName: "Ops", url: null });

    expect(entry.patternType).toBe("dashboard");
    expect(entry.patternDiscovery).toEqual({
      suggestedPatternType: "monitoring-console",
    });
  });

  it("records the extraction override provider in extraction-only metadata", async () => {
    const priorGeminiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "gemini-test";
    process.env.AUTO_TAG_PROVIDER_EXTRACTION = "gemini";

    try {
      globalThis.fetch = vi.fn(async () => {
        const response = JSON.stringify({
          patternType: "dashboard",
          categories: ["dashboard"],
          styleTags: ["minimal"],
          dominantColors: ["#ffffff", "#111111"],
          accentColor: null,
          spacingDensity: "moderate",
          cornerStyle: "slight-round",
          usesShadows: false,
          usesBorders: true,
        });
        return new Response(JSON.stringify({ output_text: response }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch;

      const entry = await tagImage({
        imagePath: testImage,
        productName: "Ops",
        url: null,
        extractionOnly: true,
        extractionProvider: "openai",
      });

      expect(entry._raw?.extractionProvider).toBe("openai");
    } finally {
      if (priorGeminiKey === undefined) delete process.env.GEMINI_API_KEY;
      else process.env.GEMINI_API_KEY = priorGeminiKey;
    }
  });

  it("overrides bodyFont from DOM signals and injects them into the prompt", async () => {
    const calls: Array<{ body: { input?: Array<{ content?: Array<Record<string, unknown>> }> } }> = [];
    let callCount = 0;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ body });
      callCount++;
      const response = callCount === 1
        ? JSON.stringify({
            patternType: "dashboard", categories: ["dashboard"], styleTags: ["minimal"],
            dominantColors: ["#ffffff", "#111111"], accentColor: null,
            displayFont: null, bodyFont: null, // model didn't guess — DOM signals should override
            spacingDensity: "moderate", cornerStyle: "slight-round",
            usesShadows: false, usesBorders: true,
          })
        : JSON.stringify({
            observations: ["a", "b", "c", "d", "e"],
            typographyNotes: "notes",
            draftCritique: "x".repeat(100),
            draftWhatToSteal: ["a technique"],
            draftAntiPatterns: ["a mistake avoided"],
            qualityTier: "exceptional",
          });
      return new Response(JSON.stringify({ output_text: response }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const entry = await tagImage({
      imagePath: testImage,
      productName: "Test",
      url: null,
      domSignals: {
        styles: {
          fontFamily: "Verdana, Geneva, sans-serif",
          fontSize: "16px", fontWeight: "400", borderRadius: "0px",
          boxShadow: null, color: "rgb(130,130,130)", background: "rgba(0,0,0,0)",
          letterSpacing: "normal",
        },
        accessibility: { contrastRatio: 5.46, headingLevels: [], imagesMissingAlt: 0, unlabeledInteractive: 30, hasSkipLink: false },
        structure: { display: "table-row", flexDirection: "row", gridTemplateColumns: null, gap: null },
      },
    });

    // bodyFont should be overridden from DOM signals (first family name).
    expect(entry.visual.typePairing.body).toBe("Verdana");

    // The extraction prompt should include the DOM-signal ground-truth block.
    const pass1Prompt = String(calls[0].body.input?.[1]?.content?.[0]?.text ?? "");
    expect(pass1Prompt).toContain("VERIFIED DOM SIGNALS");
    expect(pass1Prompt).toContain("Verdana");
  });

  it("calibrates cautionary as a rare severe tier, not any teachable flaw", async () => {
    const calls: Array<{ body: { input?: Array<{ content?: Array<Record<string, unknown>> }> } }> = [];
    let callCount = 0;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ body });
      callCount++;
      const response = callCount === 1
        ? JSON.stringify({
            patternType: "dashboard", categories: ["dashboard"], styleTags: ["dense-data"],
            dominantColors: ["#ffffff", "#111111"], accentColor: null,
            displayFont: null, bodyFont: null, spacingDensity: "compact", cornerStyle: "slight-round",
            usesShadows: false, usesBorders: true,
          })
        : JSON.stringify({
            observations: ["a", "b", "c", "d", "e"],
            typographyNotes: "notes",
            draftCritique: "x".repeat(120),
            draftWhatToSteal: ["x".repeat(20)],
            draftAntiPatterns: ["y".repeat(20)],
            draftAccessibilityRisks: ["Some secondary labels may need contrast review."],
            qualityTier: "exceptional",
          });
      return new Response(JSON.stringify({ output_text: response }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await tagImage({ imagePath: testImage, productName: "Test", url: null });

    const pass2Prompt = String(calls[1].body.input?.[1]?.content?.[0]?.text ?? "");
    expect(pass2Prompt).toContain('Default to "exceptional"');
    expect(pass2Prompt).toContain('Use "cautionary" only when');
    expect(pass2Prompt).toContain("Keep otherwise strong designs exceptional");
    expect(pass2Prompt).not.toContain('Mark "cautionary" when ANY');
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

  it("does not pass palette fields into the critique prompt", async () => {
    const prompts: string[] = [];
    let callCount = 0;
    globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const text = String(body.input?.[1]?.content?.[0]?.text ?? "");
      prompts.push(text);
      callCount++;
      const response = callCount === 1
        ? JSON.stringify({
            patternType: "calculator",
            categories: ["dashboard", "forms"],
            styleTags: ["minimal"],
            components: ["sidebar-nav", "form-controls", "summary-card", "icon-button"],
            domainTags: ["billing"],
            colorScheme: "light",
            industryVertical: "fintech",
            responsiveBehavior: "fixed-width",
            dominantColors: ["#7464a4", "#ffffff", "#16302b"],
            accentColor: "#7464a4",
            colorRoles: { canvas: "#ffffff", surface: "#f8f8f8", ink: "#111111", muted: "#777777", accent: "#7464a4" },
            spacingDensity: "moderate",
            cornerStyle: "slight-round",
            usesShadows: false,
            usesBorders: true,
          })
        : JSON.stringify({
            observations: ["left sidebar includes Home, Cards, Transactions labels", "calculator input area", "computed fee output", "primary action button", "exchange-rate note"],
            typographyNotes: "Specific hierarchy note.",
            draftCritique: "The calculator layout keeps inputs and computed outputs close together, reducing back-and-forth scanning for people comparing transfer cost before committing.",
            draftWhatToSteal: ["Keep numeric inputs adjacent to computed outputs when users are comparing cost before deciding."],
            draftAntiPatterns: ["Avoid separating fee results from the amount input; that forces users to memorize numbers across regions."],
            draftAccessibilityRisks: [],
            qualityTier: "exceptional",
          });
      return new Response(JSON.stringify({ output_text: response }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await tagImage({ imagePath: testImage, productName: "Wise", url: null });

    const pass2Prompt = prompts[1];
    expect(pass2Prompt).not.toContain("dominantColors");
    expect(pass2Prompt).not.toContain("accentColor");
    expect(pass2Prompt).not.toContain("colorRoles");
    expect(pass2Prompt).not.toContain("#7464a4");
  });
});
