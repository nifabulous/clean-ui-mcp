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
    // platform is affirmed from the RECORDED dims (detectPlatform(1280, 720) === "web"),
    // so no vision ask may carry it.
    const e = entry({ image: { width: 1280, height: 720, visibility: "public", path: "corpus/placeholder.png" } });
    await verifyEntry(e, image, deps(prompts));
    const prompt = prompts[0] ?? "";
    expect(prompt).not.toContain("platform");
  });

  it("disabled detectors revert their fields to the vision pending list", async () => {
    const prompts: string[] = [];
    const image = fixtureImagePath("roles-card");
    // Task 13B Step 3 disabled the five pixel detectors; their fields — even
    // affirmable recorded values — go back to the vision path.
    await verifyEntry(entry(), image, deps(prompts));
    const prompt = prompts[0] ?? "";
    expect(prompt).toContain("visual.usesBorders");
    expect(prompt).toContain("visual.cornerStyle");
    // usesShadows was asserted here until 2026-08-08, when it moved to `gated`.
    // A disabled detector reverts a field to the VISION path, but a gated tier
    // outranks that and removes it from the ask entirely — the two rules compose
    // in that order, which is what this now pins.
    expect(prompt).not.toContain("visual.usesShadows");
  });

  it("keeps a non-affirmable recorded false claim in the pending list", async () => {
    const prompts: string[] = [];
    const image = fixtureImagePath("borders-flat-true");
    const e = entry({ visual: { ...entry().visual!, usesShadows: false, usesBorders: false } });
    await verifyEntry(e, image, deps(prompts));
    expect(prompts[0] ?? "").toContain("visual.usesBorders");
    // usesShadows is gated as of 2026-08-08: a non-affirmable recorded claim
    // stays pending only while its field is still asked at all.
    expect(prompts[0] ?? "").not.toContain("visual.usesShadows");
  });

  it("excludes a contradicted field from the vision call", async () => {
    const prompts: string[] = [];
    const image = fixtureImagePath("roles-card");
    // A recorded palette absent from the extracted set (roles-card extracts
    // #f4f4f4/#192e5c/… — never #ff00ff) is a detector contradiction.
    const e = entry({ visual: { ...entry().visual!, dominantColors: ["#ff00ff"] } });
    await verifyEntry(e, image, deps(prompts));
    expect(prompts[0] ?? "").not.toContain("visual.dominantColors");
  });

  it("--detectors off restores the legacy pending list (byte-identical to today)", async () => {
    const prompts: string[] = [];
    const image = fixtureImagePath("roles-card");
    await verifyEntry(entry(), image, { ...deps(prompts), detectors: false });
    const prompt = prompts[0] ?? "";
    expect(prompt).toContain("visual.usesBorders");
    expect(prompt).toContain("visual.cornerStyle");
    // --detectors off restores the legacy DETECTOR behaviour, not the legacy
    // TIER table. usesShadows is gated, so it stays out of the ask under both
    // flag states — the flag governs the detector lane, never the tier.
    expect(prompt).not.toContain("visual.usesShadows");
  });
});
