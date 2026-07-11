import { describe, expect, it } from "vitest";
import { renderCritiqueMarkdown } from "./render.js";
import type { StructuredCritiqueT } from "./contracts.js";
import { StructuredCritique, CRITIQUE_SCHEMA_VERSION } from "./contracts.js";

// Helper: minimal valid structured critique for testing
function makeCritique(overrides: Partial<StructuredCritiqueT> = {}): StructuredCritiqueT {
  return {
    schemaVersion: CRITIQUE_SCHEMA_VERSION,
    platform: "web",
    retrievalMode: "structured-fallback",
    fallbackUsed: true,
    coverage: "moderate",
    summary: "A functional dashboard with good structure.",
    observations: ["The sidebar uses a fixed-width layout.", "KPI cards are evenly spaced."],
    recommendations: [
      {
        observation: "Low contrast on secondary text",
        impact: "Accessibility — users with low vision may struggle",
        recommendation: "Increase contrast ratio to at least 4.5:1",
        evidence: ["screen:visual:usesBorders"],
        basis: "visible",
      },
    ],
    accessibilityRisks: [
      {
        element: "icon button",
        risk: "no visible text label",
        evidence: "screen:components",
        wcag: ["4.1.2"],
        basis: "visible",
      },
    ],
    visualSlop: [],
    motion: [],
    appliedReferences: [],
    evidenceIds: ["screen:patternType", "screen:components"],
    confidence: "medium",
    ...overrides,
  };
}

describe("StructuredCritique schema", () => {
  it("validates a well-formed critique", () => {
    const result = StructuredCritique.safeParse(makeCritique());
    expect(result.success).toBe(true);
  });

  it("rejects a critique with missing schemaVersion", () => {
    const bad = makeCritique({ schemaVersion: "0.9" as never });
    const result = StructuredCritique.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects recommendations with empty evidence", () => {
    const bad = makeCritique({
      recommendations: [{
        observation: "x", impact: "y", recommendation: "z",
        evidence: [], basis: "visible",
      }],
    });
    const result = StructuredCritique.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("rejects invalid claim basis values", () => {
    const bad = makeCritique({
      recommendations: [{
        observation: "x", impact: "y", recommendation: "z",
        evidence: ["screen:x"], basis: "guess" as never,
      }],
    });
    const result = StructuredCritique.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it("defaults visualSlop, motion, and appliedReferences to empty arrays", () => {
    const minimal = {
      schemaVersion: CRITIQUE_SCHEMA_VERSION,
      platform: "web",
      retrievalMode: "image",
      fallbackUsed: false,
      coverage: "strong",
      summary: "Good design.",
      observations: ["Nice layout."],
      recommendations: [],
      accessibilityRisks: [],
      evidenceIds: ["screen:patternType"],
      confidence: "high" as const,
    };
    const result = StructuredCritique.safeParse(minimal);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.visualSlop).toEqual([]);
      expect(result.data.motion).toEqual([]);
      expect(result.data.appliedReferences).toEqual([]);
    }
  });
});

describe("renderCritiqueMarkdown", () => {
  it("renders summary, observations, and recommendations", () => {
    const md = renderCritiqueMarkdown(makeCritique());
    expect(md).toContain("# UI Critique");
    expect(md).toContain("## Summary");
    expect(md).toContain("A functional dashboard");
    expect(md).toContain("## Observations");
    expect(md).toContain("sidebar uses a fixed-width");
    expect(md).toContain("## Recommendations");
    expect(md).toContain("Increase contrast ratio");
  });

  it("renders accessibility risks with WCAG IDs", () => {
    const md = renderCritiqueMarkdown(makeCritique());
    expect(md).toContain("## Accessibility Risks");
    expect(md).toContain("icon button");
    expect(md).toContain("4.1.2");
  });

  it("includes platform, retrieval mode, coverage, and confidence metadata", () => {
    const md = renderCritiqueMarkdown(makeCritique());
    expect(md).toContain("**Platform:** web");
    expect(md).toContain("**Retrieval mode:** structured-fallback (fallback)");
    expect(md).toContain("**Evidence coverage:** moderate");
    expect(md).toContain("**Confidence:** medium");
  });

  it("renders visual slop findings when present", () => {
    const md = renderCritiqueMarkdown(makeCritique({
      visualSlop: [{
        pattern: "Centered hero on gradient",
        basis: "visible",
        evidence: ["screen:patternType"],
        exception: "intentional brand statement",
      }],
    }));
    expect(md).toContain("## Visual Slop Findings");
    expect(md).toContain("Centered hero on gradient");
    expect(md).toContain("exception");
  });

  it("renders motion guidance when present", () => {
    const md = renderCritiqueMarkdown(makeCritique({
      motion: [{
        basis: "editorial",
        evidence: ["ref:design-engineering"],
        note: "Consider adding subtle transition on hover",
        reference: "ref:design-engineering",
      }],
    }));
    expect(md).toContain("## Motion Guidance");
    expect(md).toContain("subtle transition");
  });

  it("omits empty sections (no visual slop, no motion)", () => {
    const md = renderCritiqueMarkdown(makeCritique());
    expect(md).not.toContain("## Visual Slop Findings");
    expect(md).not.toContain("## Motion Guidance");
  });

  it("includes evidence and basis for each recommendation", () => {
    const md = renderCritiqueMarkdown(makeCritique());
    expect(md).toContain("Evidence: screen:visual:usesBorders");
    expect(md).toContain("Basis: visible");
  });

  it("renders applied references when present", () => {
    const md = renderCritiqueMarkdown(makeCritique({
      appliedReferences: [
        { id: "ref:banned-phrases", version: 1, purpose: "text-quality" },
      ],
    }));
    expect(md).toContain("## Applied References");
    expect(md).toContain("ref:banned-phrases");
  });

  it("renders MD3 resemblance as evidence-backed resemblance rather than compliance", () => {
    const md = renderCritiqueMarkdown(makeCritique({
      md3: {
        classification: "conflicting",
        confidence: 0.67,
        matchedCategories: ["tonal-surfaces", "type-hierarchy"],
        evidenceIds: ["md3:tonal-surfaces", "screen:visual:colors"],
        conflictingSignals: [{
          category: "shape",
          evidenceId: "md3:conflict:flat",
          detail: "The visible corners are flat rather than rounded.",
        }],
      },
    }));
    expect(md).toContain("## MD3 Resemblance");
    expect(md).toContain("Classification: conflicting");
    expect(md).toContain("Confidence: 0.67");
    expect(md).toContain("tonal-surfaces, type-hierarchy");
    expect(md).toContain("md3:tonal-surfaces, screen:visual:colors");
    expect(md).toContain("md3:conflict:flat");
    expect(md).toContain("resembles");
    expect(md).not.toMatch(/MD3 compliance/i);
  });
});
