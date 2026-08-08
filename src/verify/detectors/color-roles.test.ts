// src/verify/detectors/color-roles.test.ts
import { describe, expect, it } from "vitest";
import { createVerifyCtx } from "../ctx.js";
import { fixtureImagePath } from "../__fixtures__/fixtures.js";
import { detect } from "./color-roles.js";
import type { CorpusEntryT } from "../../schema.js";

const FULL_ROLES = {
  canvas: "#f5f5f5", surface: "#ffffff", ink: "#111111", muted: null, accent: "#2563eb",
};

function entry(colorRoles: CorpusEntryT["visual"]["colorRoles"]): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor: null, colorRoles,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: "sharp",
      usesShadows: false, usesBorders: false,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("colorRoles detector (contradiction-only)", () => {
  it("never passes a fully matching role set — abstains instead", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("roles-card"));
    const r = await detect(entry(FULL_ROLES), ctx);
    expect(r.verdict).toBe("abstain");
  });

  it("contradicts a recorded hex wholly absent from the image", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("roles-card"));
    const r = await detect(entry({ ...FULL_ROLES, ink: "#123456" }), ctx);
    expect(r.verdict).toBe("contradicted");
  });

  it("contradicts a canvas that is not the largest-area colour", async () => {
    // `#111111` on a light card: the claimed canvas is nowhere near the dominant
    // colour, so the claim is positively disproven.
    const ctx = await createVerifyCtx(fixtureImagePath("roles-card"));
    const r = await detect(entry({ ...FULL_ROLES, canvas: "#111111" }), ctx);
    expect(r.verdict).toBe("contradicted");
  });

  it("ABSTAINS on a canvas that is perceptually near the real background", async () => {
    // roles-card's background is #f5f5f5; a recorded canvas of #ffffff is
    // ΔE2000 ≈ 2.0 from it — far below CANVAS_EQUAL (8). Calling that a
    // contradiction would put a false accusation in the human triage queue over
    // a difference nobody can see. An earlier draft asserted `contradicted`
    // here, which the threshold made unreachable; `abstain` is both what the
    // code does and what it SHOULD do.
    const ctx = await createVerifyCtx(fixtureImagePath("roles-card"));
    const r = await detect(entry({ ...FULL_ROLES, canvas: "#ffffff" }), ctx);
    expect(r.verdict).toBe("abstain");
  });

  it("abstains on a malformed hex (unparseable, not disproven)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("roles-card"));
    const r = await detect(entry({ ...FULL_ROLES, accent: "blue" }), ctx);
    expect(r.verdict).toBe("abstain");
  });
});
