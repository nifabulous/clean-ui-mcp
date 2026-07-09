/**
 * Migration logic tests for the WCAG ID migration.
 *
 * Tests the transformation logic in isolation against synthetic anti-pattern
 * payloads, covering: titled IDs, comma-joined multi-citations, the uncited
 * structured non-risk (deleted), legacy strings (quarantined), and idempotency.
 */
import { describe, it, expect } from "vitest";
import { transformAccessibilityRisk } from "./wcag-migration.js";

describe("WCAG ID migration — per-risk transform", () => {
  it("normalizes a titled citation to bare IDs", () => {
    const result = transformAccessibilityRisk({
      element: "status dot", risk: "color only", evidence: "red/green dots beside rows",
      confidence: "visible", wcag: "1.4.3 Contrast (Minimum)",
    });
    expect(result.kind).toBe("normalized");
    expect(result.wcag).toEqual(["1.4.3"]);
  });

  it("splits comma-joined multi-citation", () => {
    const result = transformAccessibilityRisk({
      element: "status", risk: "color + focus", evidence: "dots and no focus ring",
      confidence: "visible", wcag: "1.4.1 Use of Color, 2.4.7 Focus Visible",
    });
    expect(result.kind).toBe("normalized");
    expect(result.wcag).toEqual(["1.4.1", "2.4.7"]);
  });

  it("deduplicates repeated IDs", () => {
    const result = transformAccessibilityRisk({
      element: "x", risk: "y", evidence: "z with visible detail",
      confidence: "visible", wcag: ["1.4.1", "1.4.1"],
    });
    expect(result.wcag).toEqual(["1.4.1"]);
  });

  it("keeps a pre-migrated array (idempotency input shape)", () => {
    const result = transformAccessibilityRisk({
      element: "x", risk: "y", evidence: "z with visible detail",
      confidence: "visible", wcag: ["1.4.3"],
    });
    expect(result.kind).toBe("normalized");
    expect(result.wcag).toEqual(["1.4.3"]);
  });

  it("quarantines a legacy string", () => {
    const result = transformAccessibilityRisk("[inferred] sidebar: contrast may be low");
    expect(result.kind).toBe("quarantined");
    expect(result.note).toContain("sidebar");
  });

  it("deletes the uncited structured non-risk (workable-workable-2 case)", () => {
    // This is the actual record: its own evidence says "no risk is confirmed."
    const result = transformAccessibilityRisk({
      element: "Status dots on timeline events",
      risk: "Color is used to differentiate status but is accompanied by a text label; this is likely accessible.",
      evidence: "Each timeline event shows a colored circle and a text label — no risk is confirmed.",
      confidence: "inferred",
    });
    expect(result.kind).toBe("deleted");
  });

  it("deletes a structured risk whose citation yields no valid IDs", () => {
    const result = transformAccessibilityRisk({
      element: "x", risk: "y", evidence: "z with visible detail",
      confidence: "visible", wcag: "9.9.9 Nonexistent",
    });
    expect(result.kind).toBe("deleted");
  });

  it("deletes a post-migration array with only invalid IDs", () => {
    const result = transformAccessibilityRisk({
      element: "x", risk: "y", evidence: "z with visible detail",
      confidence: "visible", wcag: ["9.9.9"],
    });
    expect(result.kind).toBe("deleted");
  });
});

describe("WCAG ID migration — idempotency", () => {
  it("a normalized risk survives a second transform unchanged", () => {
    const first = transformAccessibilityRisk({
      element: "x", risk: "y", evidence: "z with visible detail",
      confidence: "visible", wcag: "1.4.1 Use of Color",
    });
    expect(first.kind).toBe("normalized");
    // Second pass: the wcag is now an array (the post-migration shape).
    const second = transformAccessibilityRisk({
      element: "x", risk: "y", evidence: "z with visible detail",
      confidence: "visible", wcag: first.wcag,
    });
    expect(second.kind).toBe("normalized");
    expect(second.wcag).toEqual(first.wcag);
  });
});
