import { describe, expect, it } from "vitest";
import { canonicalHash } from "./retag-diff.js";
import { promoteAccepted } from "./retag-promote.js";
import type { CorpusEntryT } from "./schema.js";

function entry(overrides: Partial<CorpusEntryT> = {}): CorpusEntryT {
  return {
    id: "sample",
    title: "Sample",
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    domainTags: [],
    source: { productName: "Sample", url: null, capturedAt: "2026-08-09", capturedBy: "self" },
    image: { visibility: "private", path: "images-private/sample.png", width: 100, height: 100 },
    platform: "web",
    visual: {
      dominantColors: ["#ffffff"], accentColor: null,
      typePairing: { display: null, body: null, notes: "" },
      spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: null, usesBorders: true,
    },
    critique: "A sufficiently long critique that describes the visible design decisions in this sample.",
    whatToSteal: ["Use the sample's visible grouping to reduce scanning effort."],
    antiPatterns: { antiPatterns: ["Avoid mixing unrelated actions in one control group."], whereThisFails: [], accessibilityRisks: [] },
    qualityTier: "exceptional",
    qualityScore: 4,
    addedAt: "2026-08-09",
    provenance: { taggedBy: "auto", verification: { categories: { method: "image-confirmed", verifiedAt: "2026-08-09", verifierVersion: "v1", imageSha256: "a".repeat(64) } } },
    ...overrides,
  } as CorpusEntryT;
}

describe("retag promotion", () => {
  it("promotes exact selected fields, revokes changed verification, and leaves a draft", () => {
    const before = entry();
    const after = promoteAccepted(
      [before],
      [{ entryId: before.id, baselineHash: canonicalHash(before), candidate: { ...before, categories: ["settings"] } }],
      [{ entryId: before.id, baselineHash: canonicalHash(before), fields: ["categories"], reviewerId: "curator", decidedAt: "2026-08-09T12:00:00Z" }],
    )[0]!;
    expect(after.categories).toEqual(["settings"]);
    expect(after.reviewStatus).toBe("draft");
    expect(after.provenance?.verification?.categories).toBeUndefined();
    expect(after.image).toEqual(before.image);
  });

  it("refuses stale runs and invalid taxonomy values before returning anything", () => {
    const before = entry();
    expect(() => promoteAccepted(
      [before],
      [{ entryId: before.id, baselineHash: "stale", candidate: { ...before, categories: ["settings"] } }],
      [{ entryId: before.id, baselineHash: "stale", fields: ["categories"], reviewerId: "curator", decidedAt: "2026-08-09T12:00:00Z" }],
    )).toThrow(/stale baseline/);
    expect(() => promoteAccepted(
      [before],
      [{ entryId: before.id, baselineHash: canonicalHash(before), candidate: { ...before, categories: ["invented-domain"] } }],
      [{ entryId: before.id, baselineHash: canonicalHash(before), fields: ["categories"], reviewerId: "curator", decidedAt: "2026-08-09T12:00:00Z" }],
    )).toThrow(/schema validation/);
  });
});
