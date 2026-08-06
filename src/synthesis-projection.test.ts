import { describe, expect, it } from "vitest";
import type { CorpusEntryT } from "./schema.js";
import {
  projectEntryForSynthesis,
  renderCoverageDisclosure,
  PROJECTED_TOP_LEVEL_KEYS,
  type ProjectedEntry,
} from "./synthesis-projection.js";
import {
  COMPARE_UI_EXAMPLES_ENRICHMENT,
  GET_COLOR_PALETTE_ENRICHMENT,
  RECOMMEND_UI_DIRECTION_ENRICHMENT,
} from "./server-factory.js";

const RECORD = { method: "measured", verifiedAt: "2026-08-06", verifierVersion: "v1" };

function entryWith(verifiedFor: readonly string[]): CorpusEntryT {
  const verification: Record<string, unknown> = {};
  for (const field of verifiedFor) verification[field] = RECORD;
  return {
    id: "e1",
    title: "E1",
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    source: { productName: "P", url: null, capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "", width: null, height: null },
    visual: {
      dominantColors: ["#ffffff"],
      accentColor: "#3b82f6",
      colorRoles: { canvas: "#ffffff", surface: "#f8f8f8", ink: "#111111", muted: "#888888", accent: "#3b82f6" },
      typePairing: { display: "Inter", body: "Inter", notes: "Clear hierarchy." },
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
      usesShadows: false,
      usesBorders: true,
    },
    antiPatterns: { antiPatterns: ["Avoid heavy shadows."], whereThisFails: [], accessibilityRisks: [] },
    voice: { tone: "Restrained", examples: ["Hello"], avoid: [] },
    whatToSteal: ["Steal this."],
    qualityScore: 4,
    qualityTier: "exceptional",
    reviewStatus: "approved",
    addedAt: "2026-07-01",
    provenance: { taggedBy: "auto", verification },
  } as unknown as CorpusEntryT;
}

const ALL = [
  "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks", "voice",
  "layout", "patternType", "styleTags", "categories", "platform",
  "visual.colorRoles", "visual.typePairing", "visual.spacingDensity",
  "visual.cornerStyle", "visual.accentColor", "visual.usesShadows",
  "visual.usesBorders",
] as const;

describe("projectEntryForSynthesis", () => {
  it("returns the entry untouched when nothing is omitted (no clone churn)", () => {
    const e = entryWith([...ALL]);
    const p = projectEntryForSynthesis(e, [...ALL]);
    expect(p).toBe(e);
  });

  it("strips unverified top-level enrichment and keeps verified + core", () => {
    const e = entryWith(["whatToSteal", "voice"]);
    const p = projectEntryForSynthesis(e, ["whatToSteal", "voice", "antiPatterns", "patternType"]);
    expect(p.whatToSteal).toEqual(["Steal this."]);
    expect(p.voice?.tone).toBe("Restrained");
    expect(p.antiPatterns).toBeUndefined();
    expect(p.patternType).toBeUndefined();
    expect((p as ProjectedEntry).source.productName).toBe("P");
  });

  it("strips nested visual leaves per key without touching verified leaves", () => {
    const e = entryWith(["visual.colorRoles", "visual.spacingDensity"]);
    const p = projectEntryForSynthesis(e, [
      "visual.colorRoles", "visual.typePairing", "visual.spacingDensity", "visual.cornerStyle",
    ]);
    expect(p.visual?.colorRoles?.accent).toBe("#3b82f6");
    expect(p.visual?.spacingDensity).toBe("moderate");
    expect(p.visual?.typePairing).toBeUndefined();
    expect(p.visual?.cornerStyle).toBeUndefined();
  });

  it("does NOT mutate the source entry or its nested objects", () => {
    const e = entryWith(["visual.colorRoles"]);
    const visualRef = e.visual;
    projectEntryForSynthesis(e, ["visual.colorRoles", "visual.typePairing", "antiPatterns"]);
    expect(e.visual).toBe(visualRef);
    expect(e.visual.typePairing?.display).toBe("Inter");
    expect(e.antiPatterns?.antiPatterns[0]).toBe("Avoid heavy shadows.");
  });

  it("strips the antiPatterns leaf independently of the parent", () => {
    const e = entryWith(["antiPatterns"]);
    const p = projectEntryForSynthesis(e, ["antiPatterns", "antiPatterns.accessibilityRisks"]);
    expect(p.antiPatterns?.antiPatterns).toEqual(["Avoid heavy shadows."]);
    expect(p.antiPatterns?.accessibilityRisks).toBeUndefined();
  });

  it("returns an entry with only core filled when enrichment is empty", () => {
    const e = entryWith(["critique"]);
    const p = projectEntryForSynthesis(e, ["voice", "patternType", "styleTags"]);
    expect(p.voice).toBeUndefined();
    expect(p.patternType).toBeUndefined();
    expect(p.styleTags).toBeUndefined();
  });
});

describe("renderCoverageDisclosure", () => {
  it("returns empty when used equals total", () => {
    expect(renderCoverageDisclosure({ used: 3, total: 3, dropped: [] })).toBe("");
  });

  it("renders K-of-N when partial", () => {
    const d = renderCoverageDisclosure({ used: 1, total: 3, dropped: ["visual.colorRoles"] });
    expect(d).toBe("_Drawn from 1 of 3 verified entries (missing: visual.colorRoles)._");
  });

  it("renders K-of-N with dropped fields named when none used", () => {
    const d = renderCoverageDisclosure({ used: 0, total: 2, dropped: ["voice"] });
    expect(d).toBe("_Drawn from 0 of 2 verified entries (missing: voice)._");
  });
});

describe("whitelist contract — every 2d-2 enrichment key maps to an optionalized slot", () => {
  it("covers the union of the three tools' enrichment sets", () => {
    const union = [
      ...COMPARE_UI_EXAMPLES_ENRICHMENT,
      ...GET_COLOR_PALETTE_ENRICHMENT,
      ...RECOMMEND_UI_DIRECTION_ENRICHMENT,
    ];
    for (const key of union) {
      const top = key.split(".")[0];
      expect(PROJECTED_TOP_LEVEL_KEYS.has(top), `no optionalized slot for ${key}`).toBe(true);
    }
  });
});
