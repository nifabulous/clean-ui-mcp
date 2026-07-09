import { describe, it, expect } from "vitest";
import {
  isWcagCriterion,
  getWcagTitle,
  getWcagLevel,
  formatWcagCitation,
  extractWcagId,
  extractAllWcagIds,
  allWcagCriteria,
} from "./registry.js";

describe("WCAG 2.2 registry", () => {
  it("contains 86 active success criteria (WCAG 2.2 minus the removed 4.1.1)", () => {
    expect(allWcagCriteria().length).toBe(86);
  });

  it("is frozen (read-only)", () => {
    expect(Object.isFrozen(allWcagCriteria())).toBe(true);
  });

  it("every criterion has an id, title, and level", () => {
    for (const c of allWcagCriteria()) {
      expect(c.id).toMatch(/^\d+\.\d+\.\d+$/);
      expect(c.title.length).toBeGreaterThan(0);
      expect(["A", "AA", "AAA"]).toContain(c.level);
    }
  });
});

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

describe("getWcagLevel", () => {
  it("returns the conformance level", () => {
    expect(getWcagLevel("1.4.3")).toBe("AA");
    expect(getWcagLevel("1.4.1")).toBe("A");
  });

  it("returns undefined for unknown IDs", () => {
    expect(getWcagLevel("9.9.9")).toBeUndefined();
  });
});

describe("formatWcagCitation", () => {
  it("renders ID + title for display", () => {
    expect(formatWcagCitation("1.4.3")).toBe("1.4.3 Contrast (Minimum)");
    expect(formatWcagCitation("1.4.1")).toBe("1.4.1 Use of Color");
  });

  it("falls back to bare ID for unknown criteria", () => {
    expect(formatWcagCitation("9.9.9")).toBe("9.9.9");
  });
});

describe("extractWcagId", () => {
  it("extracts from a title-bearing citation", () => {
    expect(extractWcagId("1.4.3 Contrast (Minimum)")).toBe("1.4.3");
    expect(extractWcagId("1.4.1 Use of Color")).toBe("1.4.1");
  });

  it("returns a bare ID unchanged", () => {
    expect(extractWcagId("1.4.3")).toBe("1.4.3");
  });

  it("returns null for strings with no numeric ID", () => {
    expect(extractWcagId("color contrast")).toBeNull();
    expect(extractWcagId("")).toBeNull();
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
