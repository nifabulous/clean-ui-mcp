// src/verify/runner.test.ts
import { describe, expect, it } from "vitest";
import { fixtureImagePath } from "./__fixtures__/fixtures.js";
import { verifyEntry } from "../scripts/verify-corpus.js";
import type { CorpusEntryT } from "../schema.js";

function entry(overrides: Partial<CorpusEntryT> = {}): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: ["sidebar-nav"],
    layout: { form: "single-column", regions: [{ role: "sidebar" }] },
    visual: {
      dominantColors: ["#f5f5f5", "#2563eb"], accentColor: "#2563eb",
      colorRoles: { canvas: "#f5f5f5", surface: "#ffffff", ink: "#111111", muted: null, accent: "#2563eb" },
      typePairing: { display: "Geist", body: "Geist" },
      spacingDensity: "moderate", cornerStyle: "slight-round",
      usesShadows: true, usesBorders: true,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "A", whatToSteal: ["B"], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
    ...overrides,
  } as CorpusEntryT;
}

function deps(prompts: string[]) {
  return {
    now: () => "2026-08-07",
    callVision: async (prompt: string) => { prompts.push(prompt); return "{}"; },
    reproduce: async (e: CorpusEntryT) => e,
  };
}

describe("verifyEntry with the detector registry", () => {
  it("keeps affirmable mechanical fields out of the vision pending list", async () => {
    const prompts: string[] = [];
    const image = fixtureImagePath("roles-card");
    await verifyEntry(entry(), image, deps(prompts));
    const prompt = prompts[0] ?? "";
    expect(prompt).not.toContain("visual.usesShadows");
    expect(prompt).not.toContain("visual.usesBorders");
    expect(prompt).not.toContain("visual.cornerStyle");
  });

  it("keeps a non-affirmable recorded false claim in the pending list", async () => {
    const prompts: string[] = [];
    const image = fixtureImagePath("borders-flat-true");
    const e = entry({ visual: { ...entry().visual!, usesShadows: false, usesBorders: false } });
    await verifyEntry(e, image, deps(prompts));
    expect(prompts[0] ?? "").toContain("visual.usesShadows");
    expect(prompts[0] ?? "").toContain("visual.usesBorders");
  });

  it("excludes a contradicted field from the vision call", async () => {
    const prompts: string[] = [];
    const image = fixtureImagePath("borders-stroke-true");
    const e = entry({ visual: { ...entry().visual!, usesBorders: false } });
    await verifyEntry(e, image, deps(prompts));
    expect(prompts[0] ?? "").not.toContain("visual.usesBorders");
  });

  it("--detectors off restores the legacy pending list (byte-identical to today)", async () => {
    const prompts: string[] = [];
    const image = fixtureImagePath("roles-card");
    await verifyEntry(entry(), image, { ...deps(prompts), detectors: false });
    const prompt = prompts[0] ?? "";
    expect(prompt).toContain("visual.usesShadows");
    expect(prompt).toContain("visual.usesBorders");
    expect(prompt).toContain("visual.cornerStyle");
  });
});
