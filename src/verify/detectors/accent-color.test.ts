// src/verify/detectors/accent-color.test.ts
import { describe, expect, it } from "vitest";
import { createVerifyCtx } from "../ctx.js";
import { fixtureImagePath } from "../__fixtures__/fixtures.js";
import { detect } from "./accent-color.js";
import type { CorpusEntryT } from "../../schema.js";

function entry(accentColor: string | null): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: "sharp",
      usesShadows: false, usesBorders: false,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("accentColor detector", () => {
  it("passes when the recorded hex is the largest non-background colour", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("accent-primary-true"));
    const r = await detect(entry("#2563eb"), ctx);
    expect(r.verdict).toBe("pass");
  });

  it("contradicts a hex absent from the image", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("accent-primary-true"));
    const r = await detect(entry("#dc2626"), ctx);
    expect(r.verdict).toBe("contradicted");
  });

  it("abstains on a 2px speck (below the area floor)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("accent-primary-speck"));
    const r = await detect(entry("#2563eb"), ctx);
    expect(r.verdict).toBe("abstain");
  });

  it("abstains when present but not the largest colour (role unconfirmed)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("accent-primary-secondary"));
    const r = await detect(entry("#2563eb"), ctx);
    expect(r.verdict).toBe("abstain");
  });

  it("contradicts a recorded hex equal to the background", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("accent-bg-equal"));
    const r = await detect(entry("#f5f5f5"), ctx);
    expect(r.verdict).toBe("contradicted");
  });

  it("abstains on a malformed hex (unparseable, not disproven)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("accent-primary-true"));
    const r = await detect(entry("blue"), ctx);
    expect(r.verdict).toBe("abstain");
  });
});
