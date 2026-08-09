import { describe, expect, it } from "vitest";
import { approveDraftText } from "./review-draft-approval.js";

function draft(overrides: Partial<Parameters<typeof approveDraftText>[0]> = {}) {
  return {
    critique: "A grounded critique with enough concrete detail about the visible layout and hierarchy.",
    whatToSteal: ["Use the visible grouping to reduce scanning effort."],
    antiPatterns: { antiPatterns: [], whereThisFails: [], accessibilityRisks: [] },
    ...overrides,
  };
}

describe("review draft approval", () => {
  it("rejects markerless critique fallbacks after marker stripping", () => {
    const result = approveDraftText(draft({
      critique: "[DRAFT — REWRITE] This critique needs a human rewrite grounded in the screenshot.",
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/placeholder|rewrite/i);
  });

  it("rejects markerless what-to-steal fallbacks", () => {
    const result = approveDraftText(draft({
      whatToSteal: ["[DRAFT] Review the screenshot and extract one concrete interface technique before saving."],
    }));
    expect(result.ok).toBe(false);
  });

  it("rejects markerless anti-pattern fallbacks", () => {
    const result = approveDraftText(draft({
      antiPatterns: {
        antiPatterns: ["[DRAFT] Review the screenshot and name one common UI mistake this design avoids."],
        whereThisFails: [],
        accessibilityRisks: [],
      },
    }));
    expect(result.ok).toBe(false);
  });

  it("returns cleaned substantive prose for approval", () => {
    const result = approveDraftText(draft({
      critique: "[DRAFT — REWRITE] The compact rail keeps navigation visible while the content hierarchy remains easy to scan.",
      whatToSteal: ["[DRAFT] Keep the primary action visually distinct from secondary controls."],
    }));
    expect(result).toEqual({
      ok: true,
      critique: "The compact rail keeps navigation visible while the content hierarchy remains easy to scan.",
      whatToSteal: ["Keep the primary action visually distinct from secondary controls."],
    });
  });
});
