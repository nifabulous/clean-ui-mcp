// src/verify/detectors/uses-borders.test.ts
import { describe, expect, it } from "vitest";
import { createVerifyCtx } from "../ctx.js";
import { fixtureImagePath } from "../__fixtures__/fixtures.js";
import { detect } from "./uses-borders.js";
import type { CorpusEntryT } from "../../schema.js";

function entry(usesBorders: boolean | null): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor: null,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: "sharp",
      usesShadows: false, usesBorders,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("usesBorders detector", () => {
  it("passes a 1px-stroked card recorded true", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("borders-stroke-true"));
    const r = await detect(entry(true), ctx);
    expect(r.verdict).toBe("pass");
  });

  it("contradicts a borderless flat card recorded true", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("borders-flat-true"));
    const r = await detect(entry(true), ctx);
    expect(r.verdict).toBe("contradicted");
  });

  it("abstains on a solid-colour image (absence invariant)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("borders-solid"));
    const r = await detect(entry(true), ctx);
    expect(r.verdict).toBe("abstain");
  });

  it("contradicts a stroked card recorded false (signal found)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("borders-stroke-true"));
    const r = await detect(entry(false), ctx);
    expect(r.verdict).toBe("contradicted");
  });

  it("abstains on a borderless flat card recorded false (absence not evidence)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("borders-flat-true"));
    const r = await detect(entry(false), ctx);
    expect(r.verdict).toBe("abstain");
  });
});
