/**
 * Migration logic tests for the WCAG ID migration.
 *
 * Tests the transformation logic in isolation against synthetic anti-pattern
 * payloads, covering: titled IDs, comma-joined multi-citations, the uncited
 * structured non-risk (deleted), legacy strings (quarantined), and idempotency.
 */
import { describe, it, expect } from "vitest";
import { extractAllWcagIds, isWcagCriterion } from "../wcag/registry.js";

/**
 * The core per-risk transform extracted from migrate-wcag-ids.ts.
 * Mirrors the script's logic so we can test it without touching the corpus.
 */
type LegacyRisk = string | {
  element: string;
  risk: string;
  evidence: string;
  confidence: string;
  wcag?: string | string[];
};

function transformRisk(risk: LegacyRisk): {
  kind: "normalized" | "deleted" | "quarantined";
  wcag?: string[];
  note?: string;
} {
  if (typeof risk === "string") return { kind: "quarantined", note: risk };

  const wcagRaw = risk.wcag;

  if (Array.isArray(wcagRaw)) {
    const valid = [...new Set(wcagRaw.map(String))].filter((id) => isWcagCriterion(id));
    if (valid.length === 0) return { kind: "deleted" };
    return { kind: "normalized", wcag: valid };
  }

  if (typeof wcagRaw === "string" && wcagRaw.trim()) {
    const ids = [...new Set(extractAllWcagIds(wcagRaw))].filter((id) => isWcagCriterion(id));
    if (ids.length === 0) return { kind: "deleted" };
    return { kind: "normalized", wcag: ids };
  }

  // Structured object with no wcag at all — the non-risk case.
  return {
    kind: "deleted",
  };
}

describe("WCAG ID migration — per-risk transform", () => {
  it("normalizes a titled citation to bare IDs", () => {
    const result = transformRisk({
      element: "status dot", risk: "color only", evidence: "red/green dots beside rows",
      confidence: "visible", wcag: "1.4.3 Contrast (Minimum)",
    });
    expect(result.kind).toBe("normalized");
    expect(result.wcag).toEqual(["1.4.3"]);
  });

  it("splits comma-joined multi-citation", () => {
    const result = transformRisk({
      element: "status", risk: "color + focus", evidence: "dots and no focus ring",
      confidence: "visible", wcag: "1.4.1 Use of Color, 2.4.7 Focus Visible",
    });
    expect(result.kind).toBe("normalized");
    expect(result.wcag).toEqual(["1.4.1", "2.4.7"]);
  });

  it("deduplicates repeated IDs", () => {
    const result = transformRisk({
      element: "x", risk: "y", evidence: "z with visible detail",
      confidence: "visible", wcag: ["1.4.1", "1.4.1"],
    });
    expect(result.wcag).toEqual(["1.4.1"]);
  });

  it("keeps a pre-migrated array (idempotency input shape)", () => {
    const result = transformRisk({
      element: "x", risk: "y", evidence: "z with visible detail",
      confidence: "visible", wcag: ["1.4.3"],
    });
    expect(result.kind).toBe("normalized");
    expect(result.wcag).toEqual(["1.4.3"]);
  });

  it("quarantines a legacy string", () => {
    const result = transformRisk("[inferred] sidebar: contrast may be low");
    expect(result.kind).toBe("quarantined");
    expect(result.note).toContain("sidebar");
  });

  it("deletes the uncited structured non-risk (workable-workable-2 case)", () => {
    // This is the actual record: its own evidence says "no risk is confirmed."
    const result = transformRisk({
      element: "Status dots on timeline events",
      risk: "Color is used to differentiate status but is accompanied by a text label; this is likely accessible.",
      evidence: "Each timeline event shows a colored circle and a text label — no risk is confirmed.",
      confidence: "inferred",
    });
    expect(result.kind).toBe("deleted");
  });

  it("deletes a structured risk whose citation yields no valid IDs", () => {
    const result = transformRisk({
      element: "x", risk: "y", evidence: "z with visible detail",
      confidence: "visible", wcag: "9.9.9 Nonexistent",
    });
    expect(result.kind).toBe("deleted");
  });

  it("deletes a post-migration array with only invalid IDs", () => {
    const result = transformRisk({
      element: "x", risk: "y", evidence: "z with visible detail",
      confidence: "visible", wcag: ["9.9.9"],
    });
    expect(result.kind).toBe("deleted");
  });
});

describe("WCAG ID migration — idempotency", () => {
  it("a normalized risk survives a second transform unchanged", () => {
    const first = transformRisk({
      element: "x", risk: "y", evidence: "z with visible detail",
      confidence: "visible", wcag: "1.4.1 Use of Color",
    });
    expect(first.kind).toBe("normalized");
    // Second pass: the wcag is now an array (the post-migration shape).
    const second = transformRisk({
      element: "x", risk: "y", evidence: "z with visible detail",
      confidence: "visible", wcag: first.wcag,
    });
    expect(second.kind).toBe("normalized");
    expect(second.wcag).toEqual(first.wcag);
  });
});
