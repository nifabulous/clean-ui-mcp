import { describe, expect, it } from "vitest";
import { inferPatternType, migrateAntiPatterns, TODO_PLACEHOLDER, type V1Entry } from "./migrate-v1-to-v2.js";

describe("v1→v2 migration: patternType inference", () => {
  it("picks the first category that is a valid patternType", () => {
    expect(inferPatternType({ id: "x", categories: ["empty-state", "onboarding"] })).toBe("empty-state");
    expect(inferPatternType({ id: "x", categories: ["dashboard", "data-table"] })).toBe("dashboard");
    expect(inferPatternType({ id: "x", categories: ["pricing", "marketing-hero"] })).toBe("pricing");
  });

  it("falls back to dashboard when no category maps", () => {
    expect(inferPatternType({ id: "x", categories: [] })).toBe("dashboard");
  });
});

describe("v1→v2 migration: antiPatterns restructure", () => {
  it("lifts existing whatToAvoidHere content into antiPatterns", () => {
    const entry: V1Entry = {
      id: "x",
      categories: ["dashboard"],
      whatToAvoidHere: ["Avoids heavy shadows for depth — uses color steps instead."],
    };
    const result = migrateAntiPatterns(entry);
    expect(result.antiPatterns).toEqual(["Avoids heavy shadows for depth — uses color steps instead."]);
    expect(result.whereThisFails).toEqual([]);
    expect(result.accessibilityRisks).toEqual([]);
  });

  it("fills a TODO placeholder when whatToAvoidHere is missing or empty", () => {
    expect(migrateAntiPatterns({ id: "x", categories: ["dashboard"] }).antiPatterns).toEqual([TODO_PLACEHOLDER]);
    expect(migrateAntiPatterns({ id: "x", categories: ["dashboard"], whatToAvoidHere: [] }).antiPatterns).toEqual([TODO_PLACEHOLDER]);
    expect(migrateAntiPatterns({ id: "x", categories: ["dashboard"], whatToAvoidHere: ["short"] }).antiPatterns).toEqual([TODO_PLACEHOLDER]);
  });
});
