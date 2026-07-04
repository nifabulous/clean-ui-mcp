import { describe, expect, it } from "vitest";
import type { CorpusEntryT } from "./schema.js";
import { generateBrief, renderBrief, renderBriefMarkdown } from "./design-prompt.js";

// generateBrief is a pure deterministic synthesizer — the tests verify it
// extracts the right consensus signals from entries and degrades gracefully
// when fields are missing. The fixtures below mirror the real schema shape.

function entry(overrides: Partial<CorpusEntryT> & { id: string; product?: string }): CorpusEntryT {
  return {
    title: `${overrides.id} sample`,
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    source: { productName: overrides.product ?? "Test", url: null, capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "", width: null, height: null },
    visual: { dominantColors: ["#ffffff", "#111111"], accentColor: null, typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true },
    critique: "This interface uses a direct visual hierarchy to make scanning feel calm and predictable.",
    whatToSteal: ["Use quiet grouping and consistent spacing to make dense interfaces easier to scan."],
    antiPatterns: { antiPatterns: ["Avoids heavy card shadows; uses background-color steps for depth."], whereThisFails: [], accessibilityRisks: [] },
    qualityScore: 4, qualityTier: "exceptional", addedAt: "2026-07-01",
    ...overrides,
  } as CorpusEntryT;
}

describe("generateBrief synthesis", () => {
  it("merges color tokens by plurality across entries with colorRoles", () => {
    const brief = generateBrief([
      entry({ id: "a", visual: { accentColor: null, dominantColors: [], typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true, colorRoles: { canvas: "#fff", surface: "#f8f8f8", ink: "#111", muted: "#888", accent: "#3b82f6" } } }),
      entry({ id: "b", visual: { accentColor: null, dominantColors: [], typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true, colorRoles: { canvas: "#fff", surface: "#f0f0f0", ink: "#111", muted: "#888", accent: "#3b82f6" } } }),
      entry({ id: "c", visual: { accentColor: null, dominantColors: [], typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true, colorRoles: { canvas: "#000", surface: "#111", ink: "#fff", muted: "#999", accent: "#ef4444" } } }),
    ], { ids: ["a", "b", "c"] });
    // Two of three have #fff canvas / #3b82f6 accent → plurality picks those.
    expect(brief.colorTokens.canvas).toBe("#fff");
    expect(brief.colorTokens.accent).toBe("#3b82f6");
  });

  it("falls back to neutral tokens when no entry has colorRoles", () => {
    const brief = generateBrief([entry({ id: "a" }), entry({ id: "b" })], { ids: ["a", "b"] });
    expect(brief.colorTokens.canvas).toBe("#ffffff");
    expect(brief.colorTokens.ink).toBe("#111111");
  });

  it("picks the most detailed (longest) steal per entry as a technique", () => {
    const brief = generateBrief([
      entry({ id: "a", whatToSteal: ["short.", "This is the longer more detailed technique worth borrowing because it explains the reasoning."] }),
      entry({ id: "b", whatToSteal: ["also short.", "Another detailed technique with specific guidance on spacing and rhythm."] }),
    ], { ids: ["a", "b"] });
    expect(brief.techniques.length).toBe(2);
    expect(brief.techniques[0]).toContain("longer more detailed");
    expect(brief.techniques[1]).toContain("specific guidance");
  });

  it("dedups near-identical anti-patterns and ranks by consensus", () => {
    // Two entries share a near-identical anti-pattern (same 50+ char prefix).
    const brief = generateBrief([
      entry({ id: "a", antiPatterns: { antiPatterns: ["Avoid heavy card shadows for depth — use background-color steps of the same hue instead."], whereThisFails: [], accessibilityRisks: [] } }),
      entry({ id: "b", antiPatterns: { antiPatterns: ["Avoid heavy card shadows for depth — use background-color steps of the same hue, not box-shadow."], whereThisFails: [], accessibilityRisks: [] } }),
      entry({ id: "c", antiPatterns: { antiPatterns: ["Don't use 1px borders everywhere."], whereThisFails: [], accessibilityRisks: [] } }),
    ], { ids: ["a", "b", "c"] });
    // The two shared-prefix variants collapse to one; it ranks first (consensus
    // of 2) ahead of the unique border pattern.
    expect(brief.avoid.length).toBe(2);
    expect(brief.avoid[0].toLowerCase()).toContain("heavy card shadows");
  });

  it("synthesizes the direction paragraph and folds in context when supplied", () => {
    const brief = generateBrief([entry({ id: "a", product: "Linear" }), entry({ id: "b", product: "Stripe" })], {
      ids: ["a", "b"],
      context: "a pricing page for a fintech",
    });
    expect(brief.direction).toContain("pricing page for a fintech");
    expect(brief.direction).toContain("Linear");
    expect(brief.direction).toContain("Stripe");
  });

  it("records what each entry contributes based on its strongest field", () => {
    const brief = generateBrief([
      entry({ id: "a", visual: { accentColor: null, dominantColors: [], typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true, colorRoles: { canvas: "#fff", surface: "#f8f8f8", ink: "#111", muted: "#888", accent: "#3b82f6" } } }),
      entry({ id: "b", voice: { tone: "A confident, technical register that respects the reader.", examples: [], avoid: [] } }),
    ], { ids: ["a", "b"] });
    const contributes = brief.sources.map((s) => s.contributes);
    expect(contributes).toContain("color palette");
    expect(contributes).toContain("voice & copy");
  });
});

describe("renderBrief", () => {
  it("renders markdown by default with paste-ready CSS tokens", () => {
    const brief = generateBrief([entry({ id: "a" })], { ids: ["a"] });
    const md = renderBriefMarkdown(brief);
    expect(md).toContain("# Design brief");
    expect(md).toContain(":root");
    expect(md).toContain("--accent");
    expect(md).toContain("## Techniques to borrow");
  });

  it("renders JSON tokens when framework is 'tokens'", () => {
    const brief = generateBrief([entry({ id: "a" })], { ids: ["a"], framework: "tokens" });
    const out = renderBrief(brief);
    const parsed = JSON.parse(out); // must be valid JSON
    expect(parsed.tokens.color.accent).toBeDefined();
    expect(parsed.techniques).toBeInstanceOf(Array);
  });
});
