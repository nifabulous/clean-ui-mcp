import { describe, expect, it } from "vitest";
import type { CorpusEntryT } from "../schema.js";
import { computeRestoreDiff, epochFromName, findDuplicateIds } from "./restore-corpus.js";

// restore-corpus's CLI shell (arg parsing, process.exit, disk writes) is thin;
// the load-bearing logic is the diff computation + integrity checks, which are
// exported as pure functions and tested here directly. The disk-touching flow
// (--list, actual restore) is verified manually against the real snapshot dir.

function entry(id: string): CorpusEntryT {
  return {
    id, title: `${id} sample`, patternType: "dashboard",
    categories: ["dashboard"], styleTags: ["minimal"],
    source: { productName: "Test", url: null, capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "", width: null, height: null },
    visual: { dominantColors: ["#ffffff", "#111111"], accentColor: null, typePairing: { display: null, body: null, notes: "n" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true },
    critique: "This interface uses a direct visual hierarchy to make scanning feel calm and predictable.",
    whatToSteal: ["Use quiet grouping and consistent spacing to make dense interfaces easier to scan."],
    antiPatterns: { antiPatterns: ["Avoids heavy card shadows; uses background-color steps for depth."], whereThisFails: [], accessibilityRisks: [] },
    qualityScore: 4, addedAt: "2026-07-01",
  } as CorpusEntryT;
}

describe("restore-corpus logic", () => {
  describe("computeRestoreDiff", () => {
    it("reports added and removed ids between current and target", () => {
      const current = [entry("a"), entry("b"), entry("c")];
      const target = [entry("a"), entry("b"), entry("d")];
      const diff = computeRestoreDiff(current, target);
      expect(diff.currentCount).toBe(3);
      expect(diff.targetCount).toBe(3);
      expect(diff.removed).toEqual(["c"]);
      expect(diff.added).toEqual(["d"]);
    });

    it("reports no id-level changes when the sets are identical", () => {
      const diff = computeRestoreDiff([entry("a"), entry("b")], [entry("a"), entry("b")]);
      expect(diff.added).toEqual([]);
      expect(diff.removed).toEqual([]);
    });

    it("flags a target that shrinks the corpus (the dangerous restore direction)", () => {
      // Restoring an older snapshot over a larger current corpus is the exact
      // scenario this CLI exists to make safe — the diff must surface the loss.
      const current = Array.from({ length: 10 }, (_, i) => entry(`e${i}`));
      const target = [entry("e0"), entry("e1")];
      const diff = computeRestoreDiff(current, target);
      expect(diff.removed.length).toBe(8);
      expect(diff.added).toEqual([]);
    });
  });

  describe("findDuplicateIds", () => {
    it("returns an empty array when all ids are unique", () => {
      expect(findDuplicateIds([entry("a"), entry("b"), entry("c")])).toEqual([]);
    });

    it("lists ids that appear more than once (corruption red flag)", () => {
      // Each repeat is reported, so [a,b,a,b,a] → a (2nd), b (2nd), a (3rd).
      const dupes = findDuplicateIds([entry("a"), entry("b"), entry("a"), entry("b"), entry("a")]);
      expect(new Set(dupes)).toEqual(new Set(["a", "b"]));
      expect(dupes.length).toBe(3); // three repeat occurrences
    });
  });

  describe("epochFromName", () => {
    it("extracts the embedded timestamp from an entries-<epoch>.json name", () => {
      expect(epochFromName("entries-1783185372810.json")).toBe(1783185372810);
    });

    it("returns 0 for a name that doesn't match the pattern", () => {
      expect(epochFromName("backup.json")).toBe(0);
      expect(epochFromName("entries-notanumber.json")).toBe(0);
    });
  });
});
