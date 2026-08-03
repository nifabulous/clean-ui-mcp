import { describe, expect, it } from "vitest";
import { createUiSpecDeterministic } from "./create-ui-spec-deterministic.js";

function observation(id: string, facts: Record<string, unknown>): never {
  return { id, kind: "corpus-observation", basis: "visible", summary: "derived", structuredFacts: facts } as never;
}

const REQUEST = { productContext: "Internal analytics workspace for finance operators", constraints: [], motionIntents: [] } as never;

describe("createUiSpecDeterministic", () => {
  it("synthesizes direction, token plurality, and layout regions from matched facts", () => {
    const evidence = [
      observation("evidence-2", {
        pattern: "dashboard", spacingDensity: "compact", cornerStyle: "slight-round",
        usesShadows: false, usesBorders: true, accentColor: "#2563eb",
        colorRoles: { canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
        layoutForm: "three-column", layoutRoles: ["primary-nav", "main-canvas", "detail-rail"],
      }),
      observation("evidence-3", {
        pattern: "dashboard", spacingDensity: "compact", cornerStyle: "sharp",
        usesShadows: false, usesBorders: true,
        colorRoles: { canvas: "#f8fafc", surface: "#ffffff", ink: "#0f172a", muted: "#64748b", accent: "#1d4ed8" },
      }),
      observation("evidence-4", {
        pattern: "data-table", spacingDensity: "compact", cornerStyle: "slight-round",
        usesShadows: false, usesBorders: true,
        colorRoles: { canvas: "#f8fafc", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
      }),
    ] as never;

    const out = createUiSpecDeterministic(evidence, REQUEST);

    expect(out.designDirection).toContain("evidence-2");
    expect(out.designDirection).toContain("compact");
    // UiSpec primary and accent both resolve to the corpus accent plurality
    // (the corpus records ONE interactive color; the vocabulary split is a
    // documented mapping, not an invention).
    expect(out.colorTokens).toEqual({
      primary: "#2563eb", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb",
    });
    expect(out.layoutRegions.map((r) => r.name)).toEqual(["primary-nav", "main-canvas", "detail-rail"]);
    expect(out.responsiveBehavior).toContain("form: three-column");
  });

  it("returns nulls and empty arrays when no corpus observation matched", () => {
    const out = createUiSpecDeterministic([], REQUEST);
    expect(out.designDirection).toBeNull();
    expect(out.colorTokens).toBeNull();
    expect(out.layoutRegions).toEqual([]);
  });

  it("never populates tokens from fewer than three contributing entries", () => {
    const evidence = [
      observation("evidence-2", { pattern: "dashboard", colorRoles: { canvas: "#fff", surface: "#fff", ink: "#111", muted: "#666", accent: "#2563eb" } }),
      observation("evidence-3", { pattern: "dashboard" }),
    ] as never;
    expect(createUiSpecDeterministic(evidence, REQUEST).colorTokens).toBeNull();
  });

  it("never fabricates default tokens when no entry has colorRoles", () => {
    const evidence = [
      observation("evidence-2", { pattern: "dashboard", spacingDensity: "compact" }),
      observation("evidence-3", { pattern: "dashboard", spacingDensity: "compact" }),
      observation("evidence-4", { pattern: "dashboard", spacingDensity: "compact" }),
    ] as never;
    expect(createUiSpecDeterministic(evidence, REQUEST).colorTokens).toBeNull();
  });

  it("never fabricates muted when every matched entry has a null muted role", () => {
    // `muted` is the ONLY nullable role in the corpus shape (schema.ts), so it
    // is the one field the `withRoles.length >= 3` guard cannot protect: the
    // null-filter can empty the array while three entries still contribute
    // colorRoles, and a `?? "#888888"` default would invent a token nothing
    // derived. Measured base rate: 20 of 688 entries with colorRoles carry a
    // null muted, and retrieval returns SIMILAR entries, so the three matches
    // are not independent draws.
    const roles = (accent: string) => ({
      canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: null, accent,
    });
    const evidence = [
      observation("evidence-2", { pattern: "dashboard", colorRoles: roles("#2563eb") }),
      observation("evidence-3", { pattern: "data-table", colorRoles: roles("#2563eb") }),
      observation("evidence-4", { pattern: "forms", colorRoles: roles("#2563eb") }),
    ] as never;
    expect(createUiSpecDeterministic(evidence, REQUEST).colorTokens).toBeNull();
  });

  it("still populates tokens when at least three entries carry a non-null muted", () => {
    const withMuted = (accent: string) => ({
      canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent,
    });
    const evidence = [
      observation("evidence-2", { pattern: "dashboard", colorRoles: withMuted("#2563eb") }),
      observation("evidence-3", { pattern: "data-table", colorRoles: withMuted("#2563eb") }),
      observation("evidence-4", { pattern: "forms", colorRoles: { ...withMuted("#2563eb"), muted: null } }),
      observation("evidence-5", { pattern: "modal", colorRoles: withMuted("#2563eb") }),
    ] as never;
    expect(createUiSpecDeterministic(evidence, REQUEST).colorTokens).toEqual({
      primary: "#2563eb", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb",
    });
  });

  it("populates regions but not a form claim when layoutForm is absent", () => {
    const evidence = [
      observation("evidence-2", {
        pattern: "dashboard",
        layoutRoles: ["primary-nav", "main-canvas"],
      }),
    ] as never;
    const out = createUiSpecDeterministic(evidence, REQUEST);
    expect(out.layoutRegions.map((r) => r.name)).toEqual(["primary-nav", "main-canvas"]);
    // No form string may be fabricated when the corpus entry carries none.
    expect(out.responsiveBehavior).toEqual([]);
  });
});
