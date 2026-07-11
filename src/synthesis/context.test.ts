import { describe, expect, it } from "vitest";
import {
  buildSynthesisContext,
  registerVisualEvidence,
  type SynthesisContext,
} from "./context.js";
import type { RetrievalResult } from "../critique-retrieval.js";
import type { CritiqueEvidence } from "../critique-ui.js";

// Helper: minimal retrieval result for testing
function makeRetrieval(entries: Array<{ id: string; title?: string; patternType?: string }> = []): RetrievalResult {
  return {
    entries: entries.map((e) => ({ id: e.id, score: 0.8, title: e.title, patternType: e.patternType })),
    mode: "structured-fallback" as const,
    fallbackUsed: true,
    coverage: "moderate" as const,
  };
}

// Helper: extraction facts from the tagger
function makeExtraction(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: ["sidebar-nav", "kpi-card"],
    domainTags: ["analytics"],
    layoutForm: "sidebar+main",
    spacingDensity: "moderate",
    cornerStyle: "slight-round",
    usesShadows: false,
    usesBorders: true,
    ...overrides,
  };
}

describe("buildSynthesisContext", () => {
  it("produces three separated lanes: evidence, rules, guidance", () => {
    const ctx = buildSynthesisContext({
      extraction: makeExtraction(),
      retrieval: makeRetrieval([{ id: "e1", title: "Dashboard A" }]),
      productContext: "A KPI dashboard",
    });

    expect(ctx).toHaveProperty("evidence");
    expect(ctx).toHaveProperty("rules");
    expect(ctx).toHaveProperty("guidance");

    expect(Array.isArray(ctx.evidence)).toBe(true);
    expect(ctx.evidence.length).toBeGreaterThan(0);
    expect(ctx.rules).toBeDefined();
    expect(ctx.guidance).toBeDefined();
  });

  it("creates screen: evidence IDs from extraction facts", () => {
    const ctx = buildSynthesisContext({
      extraction: makeExtraction(),
      retrieval: makeRetrieval(),
    });
    const ids = ctx.evidence.map((e) => e.id);
    expect(ids).toContain("screen:patternType");
    expect(ids).toContain("screen:components");
    expect(ids).toContain("screen:layoutForm");
  });

  it("creates corpus: evidence IDs from retrieval entries", () => {
    const ctx = buildSynthesisContext({
      extraction: makeExtraction(),
      retrieval: makeRetrieval([{ id: "abc-123", title: "Dashboard A", patternType: "dashboard" }]),
    });
    expect(ctx.evidence.some((e) => e.id === "corpus:abc-123")).toBe(true);
  });

  it("does not include editorial IDs in the evidence lane", () => {
    const ctx = buildSynthesisContext({
      extraction: makeExtraction(),
      retrieval: makeRetrieval(),
    });
    // Evidence should only have screen: and corpus: IDs
    for (const e of ctx.evidence) {
      expect(e.id).toMatch(/^(screen|corpus):/);
    }
  });

  it("registers visual evidence for colors, shadows, borders, and type pairing", () => {
    const extraction = makeExtraction({
      dominantColors: ["#ffffff", "#111111"],
      accentColor: "#0066cc",
      usesShadows: false,
      usesBorders: true,
      typePairing: { display: null, body: null, notes: "Clean sans-serif pairing" },
    });
    const ctx = buildSynthesisContext({
      extraction,
      retrieval: makeRetrieval(),
    });
    const ids = ctx.evidence.map((e) => e.id);
    expect(ids).toContain("screen:visual:colors");
    expect(ids).toContain("screen:visual:accentColor");
    expect(ids).toContain("screen:visual:usesShadows");
    expect(ids).toContain("screen:visual:usesBorders");
    expect(ids).toContain("screen:visual:typePairing");
  });

  it("caps array detail lengths to prevent prompt bloat", () => {
    const extraction = makeExtraction({
      components: Array.from({ length: 50 }, (_, i) => `component-${i}`),
    });
    const ctx = buildSynthesisContext({
      extraction,
      retrieval: makeRetrieval(),
    });
    const comp = ctx.evidence.find((e) => e.id === "screen:components");
    expect(comp).toBeDefined();
    // Detail should be truncated, not the full 50-item list
    expect(comp!.detail!.split(", ").length).toBeLessThan(50);
  });

  it("builds rules lane from generated machine rules", () => {
    const ctx = buildSynthesisContext({
      extraction: makeExtraction(),
      retrieval: makeRetrieval(),
    });
    // Rules lane should contain the canonical banned phrases and detector info
    expect(ctx.rules.bannedPhrases).toContain("clean layout");
    expect(ctx.rules.detectors).toBeDefined();
  });

  it("builds guidance lane from selected references", () => {
    const ctx = buildSynthesisContext({
      extraction: makeExtraction(),
      retrieval: makeRetrieval(),
    });
    // Guidance lane should contain reference descriptors
    expect(ctx.guidance).toBeDefined();
    expect(Array.isArray(ctx.guidance)).toBe(true);
  });
});

describe("registerVisualEvidence", () => {
  it("returns evidence for available visual fields", () => {
    const evidence = registerVisualEvidence({
      dominantColors: ["#ffffff", "#111111"],
      accentColor: "#0066cc",
      usesShadows: false,
      usesBorders: true,
      typePairing: { display: null, body: null, notes: "Sans-serif" },
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
    });
    const ids = evidence.map((e) => e.id);
    expect(ids).toContain("screen:visual:colors");
    expect(ids).toContain("screen:visual:usesBorders");
  });

  it("skips fields that are null or undefined", () => {
    const evidence = registerVisualEvidence({
      dominantColors: ["#ffffff"],
      accentColor: null,
      usesShadows: false,
      usesBorders: true,
      typePairing: null,
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
    });
    const ids = evidence.map((e) => e.id);
    expect(ids).not.toContain("screen:visual:accentColor");
    expect(ids).not.toContain("screen:visual:typePairing");
  });
});
