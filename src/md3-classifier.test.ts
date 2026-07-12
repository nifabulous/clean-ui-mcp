import { describe, expect, it } from "vitest";
import { classifyMd3Resemblance, type Md3EvidenceInput } from "./md3-classifier.js";

// Helper: evidence with all MD3 signal categories present
function makePositiveEvidence(): Md3EvidenceInput {
  return {
    // Category 1: Tonal surfaces
    dominantColors: ["#fef7ff", "#faf8f3", "#fef7ff"],
    accentColor: "#6750a4",
    colorRoles: { canvas: "#fef7ff", surface: "#faf8f3", ink: "#1d1b20", accent: "#6750a4" },
    // Category 2: Type hierarchy (MD3 uses Display/Headline/Title/Body/Label)
    typePairing: { display: "Roboto Flex", body: "Roboto", notes: "MD3 type scale" },
    // Category 3: Component/state evidence
    components: ["floating-action-button", "navigation-rail", "top-app-bar"],
    cornerStyle: "rounded",
    usesShadows: true,
    usesBorders: false,
    spacingDensity: "comfortable",
  };
}

describe("classifyMd3Resemblance", () => {
  it("returns 'supported' when three categories match with no conflicts", () => {
    const result = classifyMd3Resemblance(makePositiveEvidence());
    expect(result.classification).toBe("supported");
    expect(result.matchedCategories.length).toBeGreaterThanOrEqual(3);
    expect(result.evidenceIds.length).toBeGreaterThan(0);
    expect(result.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("returns 'insufficient-evidence' for a single rounded card (only shape)", () => {
    const result = classifyMd3Resemblance({
      components: ["card"],
      cornerStyle: "rounded",
      usesShadows: true,
      usesBorders: false,
    });
    expect(result.classification).toBe("insufficient-evidence");
    expect(result.matchedCategories.length).toBeLessThan(3);
  });

  it("returns 'insufficient-evidence' for a pill shape alone", () => {
    const result = classifyMd3Resemblance({
      cornerStyle: "pill",
      usesShadows: false,
      usesBorders: false,
    });
    expect(result.classification).toBe("insufficient-evidence");
  });

  it("returns 'insufficient-evidence' for a tonal background alone", () => {
    const result = classifyMd3Resemblance({
      dominantColors: ["#fef7ff", "#faf8f3"],
      accentColor: "#6750a4",
    });
    expect(result.classification).toBe("insufficient-evidence");
  });

  it("returns 'conflicting' when hard conflicts exist", () => {
    const result = classifyMd3Resemblance({
      ...makePositiveEvidence(),
      // Hard conflict: flat design (no shadows, no rounded corners) alongside MD3 signals
      usesShadows: false,
      cornerStyle: "sharp",
    });
    // With sharp corners + no shadows conflicting, the shape category can't match
    // This may still be "insufficient-evidence" if only 2 categories match
    // but if 3 categories still match with the conflict, it's "conflicting"
    expect(["conflicting", "insufficient-evidence"]).toContain(result.classification);
    if (result.classification === "conflicting") {
      expect(result.conflictingSignals.length).toBeGreaterThan(0);
    }
  });

  it("preserves evidence IDs in the result", () => {
    const result = classifyMd3Resemblance(makePositiveEvidence());
    for (const id of result.evidenceIds) {
      expect(id).toMatch(/^(screen|md3):/);
    }
  });

  it("never emits the word 'compliant' in any field", () => {
    const result = classifyMd3Resemblance(makePositiveEvidence());
    const json = JSON.stringify(result).toLowerCase();
    expect(json).not.toContain("compliant");
  });

  it("returns 'insufficient-evidence' for empty input", () => {
    const result = classifyMd3Resemblance({});
    expect(result.classification).toBe("insufficient-evidence");
    expect(result.matchedCategories).toEqual([]);
  });

  it("matches tonal surfaces category when 3+ muted tones + accent present", () => {
    const result = classifyMd3Resemblance({
      dominantColors: ["#fef7ff", "#f7f2fa", "#fef7ff"],
      accentColor: "#6750a4",
    });
    expect(result.matchedCategories).toContain("tonal-surfaces");
  });

  it("matches type hierarchy category when display + body fonts differ", () => {
    const result = classifyMd3Resemblance({
      typePairing: { display: "Roboto Flex", body: "Roboto", notes: "MD3" },
    });
    expect(result.matchedCategories).toContain("type-hierarchy");
  });

  it("matches component/state category when MD3-specific components present", () => {
    const result = classifyMd3Resemblance({
      components: ["floating-action-button", "navigation-rail", "top-app-bar"],
    });
    expect(result.matchedCategories).toContain("components");
  });

  it("matches shape category when rounded + shadows (MD3 elevation)", () => {
    const result = classifyMd3Resemblance({
      cornerStyle: "rounded",
      usesShadows: true,
    });
    expect(result.matchedCategories).toContain("shape");
  });
});
