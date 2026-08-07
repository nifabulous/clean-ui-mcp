// src/verify/detectors/corner-style.test.ts
import { describe, expect, it } from "vitest";
import { createVerifyCtx } from "../ctx.js";
import { fixtureImagePath } from "../__fixtures__/fixtures.js";
import { detect } from "./corner-style.js";
import type { CorpusEntryT } from "../../schema.js";

function entry(cornerStyle: string): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor: null,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: cornerStyle as CorpusEntryT["visual"]["cornerStyle"],
      usesShadows: false, usesBorders: false,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("cornerStyle detector", () => {
  it("maps radii onto the schema vocabulary (no square/rounded values)", async () => {
    const sharp = await createVerifyCtx(fixtureImagePath("corner-sharp-true"));
    const slight = await createVerifyCtx(fixtureImagePath("corner-slight-true"));
    const pill = await createVerifyCtx(fixtureImagePath("corner-pill-true"));
    expect((await detect(entry("sharp"), sharp)).verdict).toBe("pass");
    expect((await detect(entry("slight-round"), slight)).verdict).toBe("pass");
    expect((await detect(entry("pill"), pill)).verdict).toBe("pass");
  });

  it("abstains on a band-boundary radius (2px — exactly sharp/slight)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("corner-band"));
    expect((await detect(entry("slight-round"), ctx)).verdict).toBe("abstain");
  });

  it("abstains on recorded mixed — never affirmable", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("corner-mixed"));
    expect((await detect(entry("mixed"), ctx)).verdict).toBe("abstain");
  });

  it("contradicts a mismatched bucket", async () => {
    const sharp = await createVerifyCtx(fixtureImagePath("corner-sharp-true"));
    expect((await detect(entry("pill"), sharp)).verdict).toBe("contradicted");
  });
});
