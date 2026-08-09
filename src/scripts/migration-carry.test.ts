import { describe, expect, it } from "vitest";
import { carryMigrationVerification } from "./migration-carry.js";
import type { CorpusEntryT } from "../schema.js";

const record = (field: string) => ({
  method: "image-confirmed",
  verifiedAt: "2026-08-09",
  verifierVersion: "test",
  imageSha256: `${field}`.padEnd(64, "0"),
});

function entry(overrides: Partial<CorpusEntryT> = {}): CorpusEntryT {
  return {
    id: "sample",
    title: "Sample",
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    source: { productName: "Sample", url: null, capturedAt: "2026-08-09", capturedBy: "self" },
    image: { visibility: "private", path: "images-private/sample.png", width: 100, height: 100 },
    platform: "web",
    visual: {
      dominantColors: ["#ffffff"],
      accentColor: null,
      typePairing: { display: null, body: null, notes: "" },
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
      usesShadows: null,
      usesBorders: true,
    },
    critique: "A sufficiently long critique that describes the visible design decisions in this sample.",
    whatToSteal: ["Use the sample's visible grouping to reduce scanning effort."],
    antiPatterns: { antiPatterns: ["Avoid mixing unrelated actions in one control group."], whereThisFails: [], accessibilityRisks: [] },
    provenance: {
      taggedBy: "auto",
      verification: {
        critique: record("critique"),
        layout: record("layout"),
        platform: record("platform"),
        antiPatterns: record("antiPatterns"),
        "antiPatterns.accessibilityRisks": record("risks"),
      },
    },
    ...overrides,
  };
}

describe("carryMigrationVerification", () => {
  it("drops verification for a newly populated layout while retaining unchanged claims", () => {
    const prior = entry();
    const next = entry({ layout: { form: "single-column", regions: [{ role: "main-canvas" }] } });
    const [out] = carryMigrationVerification([next], [prior]);

    expect(out.provenance?.verification).toMatchObject({ critique: record("critique"), antiPatterns: record("antiPatterns") });
    expect(out.provenance?.verification).not.toHaveProperty("layout");
  });

  it("drops verification when a deterministic platform migration changes the claim", () => {
    const prior = entry({ platform: "tablet" });
    const next = entry({ platform: "mobile" });
    const [out] = carryMigrationVerification([next], [prior]);

    expect(out.provenance?.verification).not.toHaveProperty("platform");
    expect(out.provenance?.verification).toHaveProperty("critique");
  });

  it("drops only the changed accessibility-risk claim when WCAG normalization leaves prose intact", () => {
    const prior = entry({
      antiPatterns: {
        antiPatterns: ["Avoid mixing unrelated actions in one control group."],
        whereThisFails: [],
        accessibilityRisks: [{ element: "button", risk: "The button has weak contrast.", evidence: "Visible button label", confidence: "visible", wcag: ["1.4.3"] }],
      },
    });
    const next = entry({
      antiPatterns: {
        antiPatterns: ["Avoid mixing unrelated actions in one control group."],
        whereThisFails: [],
        accessibilityRisks: [],
      },
    });
    const [out] = carryMigrationVerification([next], [prior]);

    expect(out.provenance?.verification).toHaveProperty("antiPatterns");
    expect(out.provenance?.verification).not.toHaveProperty("antiPatterns.accessibilityRisks");
  });
});
