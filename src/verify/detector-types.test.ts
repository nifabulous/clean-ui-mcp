// src/verify/detector-types.test.ts
import { describe, expect, it } from "vitest";
import { inBand, recordedFor } from "./detector-types.js";
import type { CorpusEntryT } from "../schema.js";

function entry(overrides: Partial<CorpusEntryT> = {}): CorpusEntryT {
  return {
    id: "t",
    title: "t",
    patternType: "dashboard",
    colorScheme: "light",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: ["#2563eb"],
      accentColor: "#2563eb",
      colorRoles: { canvas: "#ffffff", surface: "#f5f5f5", ink: "#111111", muted: null, accent: "#2563eb" },
      typePairing: { display: null, body: null },
      spacingDensity: "moderate",
      cornerStyle: "mixed",
      usesShadows: false,
      usesBorders: false,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "",
    whatToSteal: [],
    voice: null,
    mood: null,
    platform: "web",
    qualityScore: 1,
    qualityTier: "exceptional",
    ...overrides,
  } as CorpusEntryT;
}

describe("detector types", () => {
  it("reads the raw recorded value per registry field", () => {
    const e = entry();
    expect(recordedFor(e, "visual.usesShadows")).toBe(false);
    expect(recordedFor(e, "visual.cornerStyle")).toBe("mixed");
    expect(recordedFor(e, "visual.accentColor")).toBe("#2563eb");
    expect(recordedFor(e, "platform")).toBe("web");
    expect(recordedFor(e, "visual.dominantColors")).toEqual(["#2563eb"]);
    expect(recordedFor(e, "antiPatterns.accessibilityRisks")).toEqual([]);
    expect(recordedFor(e, "critique")).toBeNull();
  });

  it("returns null for missing values and unknown fields", () => {
    const e = entry();
    expect(recordedFor(e, "visual.usesShadows")).toBe(false);
    // `visual` is REQUIRED on CorpusEntryT (schema.ts) — the cast is deliberate.
    expect(recordedFor({ ...e, visual: undefined } as CorpusEntryT, "visual.usesShadows")).toBeNull();
    expect(recordedFor(e, "nope")).toBeNull();
  });

  it("treats band edges inclusively", () => {
    expect(inBand({ low: 0.25, high: 0.75 }, 0.25)).toBe(true);
    expect(inBand({ low: 0.25, high: 0.75 }, 0.75)).toBe(true);
    expect(inBand({ low: 0.25, high: 0.75 }, 0.24)).toBe(false);
    expect(inBand({ low: 0.001, high: 0.999 }, 0)).toBe(false);
    expect(inBand({ low: 0.001, high: 0.999 }, 1)).toBe(false);
  });
});
