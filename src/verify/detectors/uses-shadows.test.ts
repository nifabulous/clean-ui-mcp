// src/verify/detectors/uses-shadows.test.ts
import { describe, expect, it } from "vitest";
import { createVerifyCtx } from "../ctx.js";
import { fixtureImagePath } from "../__fixtures__/fixtures.js";
import { detect as borders } from "./uses-borders.js";
import { detect } from "./uses-shadows.js";
import type { CorpusEntryT } from "../../schema.js";

function entry(usesShadows: boolean, usesBorders = false): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor: null,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: "sharp",
      usesShadows, usesBorders,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("usesShadows detector", () => {
  it("passes a shadowed card recorded true", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("shadows-card-true"));
    expect((await detect(entry(true), ctx)).verdict).toBe("pass");
  });

  it("contradicts a flat card recorded true", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("shadows-flat-true"));
    expect((await detect(entry(true), ctx)).verdict).toBe("contradicted");
  });

  it("abstains on a solid image recorded true (absence invariant)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("shadows-solid"));
    expect((await detect(entry(true), ctx)).verdict).toBe("abstain");
  });

  it("contradicts a shadowed card recorded false", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("shadows-card-true"));
    expect((await detect(entry(false), ctx)).verdict).toBe("contradicted");
  });

  it("never confuses shadow with border (the pair)", async () => {
    const shadowed = await createVerifyCtx(fixtureImagePath("pair-shadowed-borderless"));
    expect((await borders(entry(true, true), shadowed)).verdict).toBe("contradicted");
    expect((await detect(entry(true), shadowed)).verdict).toBe("pass");

    const stroked = await createVerifyCtx(fixtureImagePath("pair-bordered-flat"));
    expect((await borders(entry(true, true), stroked)).verdict).toBe("pass");
    expect((await detect(entry(true), stroked)).verdict).toBe("contradicted");
  });
});
