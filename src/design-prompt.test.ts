import { describe, expect, it } from "vitest";
import type { CorpusEntryT } from "./schema.js";
import { generateBrief, renderBrief, renderBriefMarkdown, renderBriefTokens } from "./design-prompt.js";

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

// ---------------------------------------------------------------------------
// Task 7 regression — the adapter layer (Tasks 1–5) MUST NOT change the
// legacy generate_design_prompt output. An omitted target never becomes React,
// Astro, Tailwind, or any other adapter vocabulary. These tests pin the legacy
// brief + tokens bytes against silent drift introduced by the handoff layer.
// ---------------------------------------------------------------------------

describe("legacy brief output regression (Task 7)", () => {
  it("generateBrief returns the legacy DesignBrief shape with no adapter fields", () => {
    const brief = generateBrief([entry({ id: "a" }), entry({ id: "b" })], { ids: ["a", "b"] });
    // The exact legacy field set — no profileId, target, handoffVersion, etc.
    expect(Object.keys(brief).sort()).toEqual(
      [
        "avoid",
        "colorTokens",
        "context",
        "direction",
        "framework",
        "layout",
        "sources",
        "techniques",
        "typography",
        "voice",
      ],
    );
    // The framework field defaults to "brief" when omitted.
    expect(brief.framework).toBe("brief");
  });

  it("legacy markdown is unchanged when no target is specified", () => {
    const brief = generateBrief([entry({ id: "a" })], { ids: ["a"] });
    const md = renderBriefMarkdown(brief);
    // The legacy brief header is the only H1 — no DESIGN.md frontmatter leaked in.
    expect(md.startsWith("# Design brief")).toBe(true);
    expect(md).not.toContain("---");
    // No adapter vocabulary leaks into the legacy brief.
    expect(md).not.toMatch(/\breact\b/i);
    expect(md).not.toMatch(/\bastro\b/i);
    expect(md).not.toMatch(/\btailwind\b/i);
    expect(md).not.toMatch(/\bisland\b/i);
    expect(md).not.toMatch(/\bvue\b/i);
    expect(md).not.toMatch(/handoff_version/);
    expect(md).not.toMatch(/target_profile/);
    expect(md).not.toMatch(/@astrojs\//);
    expect(md).not.toMatch(/client:load/);
  });

  it("omitted target produces no React/Astro/Tailwind assumption in tokens output", () => {
    const brief = generateBrief([entry({ id: "a" })], { ids: ["a"], framework: "tokens" });
    const out = renderBriefTokens(brief);
    const parsed = JSON.parse(out);
    // Legacy tokens shape: no profile, no install dependencies, no island.
    expect(parsed).not.toHaveProperty("target_profile");
    expect(parsed).not.toHaveProperty("handoff_version");
    expect(parsed).not.toHaveProperty("dependency_manifest");
    expect(parsed).not.toHaveProperty("island_strategy");
    // The tokens payload remains the legacy color/spacing/typography/voice shape.
    expect(parsed.tokens.color.accent).toBeDefined();
    // No adapter vocabulary anywhere in the rendered bytes.
    expect(out).not.toMatch(/\breact\b/i);
    expect(out).not.toMatch(/\bastro\b/i);
    expect(out).not.toMatch(/\btailwind\b/i);
    expect(out).not.toMatch(/\bisland\b/i);
  });

  it("the existing generateBrief function still works identically across repeated calls", () => {
    // Determinism: the same entries + input must produce byte-identical output.
    const a = JSON.stringify(
      generateBrief([entry({ id: "a" }), entry({ id: "b" })], {
        ids: ["a", "b"],
        context: "a pricing page for a fintech",
      }),
    );
    const b = JSON.stringify(
      generateBrief([entry({ id: "a" }), entry({ id: "b" })], {
        ids: ["a", "b"],
        context: "a pricing page for a fintech",
      }),
    );
    expect(a).toBe(b);
  });

  it("renderBrief dispatch is unchanged (markdown by default, JSON for tokens)", () => {
    const briefMd = generateBrief([entry({ id: "a" })], { ids: ["a"] });
    expect(renderBrief(briefMd)).toBe(renderBriefMarkdown(briefMd));
    const briefJson = generateBrief([entry({ id: "a" })], { ids: ["a"], framework: "tokens" });
    expect(renderBrief(briefJson)).toBe(renderBriefTokens(briefJson));
    // The two outputs are distinct shapes.
    expect(renderBrief(briefMd)).not.toBe(renderBrief(briefJson));
  });
});
