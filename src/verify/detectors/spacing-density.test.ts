// src/verify/detectors/spacing-density.test.ts
import { describe, expect, it } from "vitest";
import { createVerifyCtx } from "../ctx.js";
import { fixtureImagePath } from "../__fixtures__/fixtures.js";
import { detect } from "./spacing-density.js";
import type { CorpusEntryT } from "../../schema.js";

function entry(spacingDensity: string): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor: null,
      typePairing: { display: null, body: null },
      spacingDensity: spacingDensity as CorpusEntryT["visual"]["spacingDensity"],
      cornerStyle: "sharp", usesShadows: false, usesBorders: false,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("spacingDensity detector", () => {
  it("passes compact / moderate / spacious grids", async () => {
    const compact = await createVerifyCtx(fixtureImagePath("spacing-compact-true"));
    const moderate = await createVerifyCtx(fixtureImagePath("spacing-moderate-true"));
    const spacious = await createVerifyCtx(fixtureImagePath("spacing-spacious-true"));
    expect((await detect(entry("compact"), compact)).verdict).toBe("pass");
    expect((await detect(entry("moderate"), moderate)).verdict).toBe("pass");
    expect((await detect(entry("spacious"), spacious)).verdict).toBe("pass");
  });

  it("contradicts a mismatched density", async () => {
    const compact = await createVerifyCtx(fixtureImagePath("spacing-compact-true"));
    expect((await detect(entry("spacious"), compact)).verdict).toBe("contradicted");
  });

  it("abstains on a single-element image rather than reporting a zero gap", async () => {
    const single = await createVerifyCtx(fixtureImagePath("spacing-single"));
    expect((await detect(entry("moderate"), single)).verdict).toBe("abstain");
  });
});
