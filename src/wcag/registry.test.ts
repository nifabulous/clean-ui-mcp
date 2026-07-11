import { describe, it, expect } from "vitest";
import {
  isWcagCriterion,
  getWcagTitle,
  extractAllWcagIds,
} from "./registry.js";

describe("isWcagCriterion", () => {
  it("accepts known IDs", () => {
    expect(isWcagCriterion("1.1.1")).toBe(true);
    expect(isWcagCriterion("1.4.3")).toBe(true);
    expect(isWcagCriterion("2.4.7")).toBe(true);
    expect(isWcagCriterion("4.1.3")).toBe(true);
  });

  it("rejects non-existent IDs", () => {
    expect(isWcagCriterion("9.9.9")).toBe(false);
    expect(isWcagCriterion("1.1.4")).toBe(false);
    expect(isWcagCriterion("0.0.0")).toBe(false);
  });

  it("rejects malformed input", () => {
    expect(isWcagCriterion("1.4")).toBe(false);
    expect(isWcagCriterion("abc")).toBe(false);
    expect(isWcagCriterion("")).toBe(false);
    expect(isWcagCriterion("1.4.1 Use of Color")).toBe(false); // title-bearing, not bare
  });

  it("does NOT accept 4.1.1 Parsing (removed in WCAG 2.2)", () => {
    expect(isWcagCriterion("4.1.1")).toBe(false);
  });
});

describe("getWcagTitle", () => {
  it("returns the canonical title for a known ID", () => {
    expect(getWcagTitle("1.4.3")).toBe("Contrast (Minimum)");
    expect(getWcagTitle("1.4.1")).toBe("Use of Color");
    expect(getWcagTitle("1.1.1")).toBe("Non-text Content");
  });

  it("returns undefined for unknown IDs", () => {
    expect(getWcagTitle("9.9.9")).toBeUndefined();
  });
});

describe("extractAllWcagIds", () => {
  it("handles comma-joined multi-citation", () => {
    expect(extractAllWcagIds("1.4.1 Use of Color, 2.4.7 Focus Visible")).toEqual(["1.4.1", "2.4.7"]);
  });

  it("returns a single-element array for a single citation", () => {
    expect(extractAllWcagIds("1.4.3 Contrast (Minimum)")).toEqual(["1.4.3"]);
  });

  it("returns empty array for no matches", () => {
    expect(extractAllWcagIds("no ids here")).toEqual([]);
  });
});
