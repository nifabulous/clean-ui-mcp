import { describe, expect, it } from "vitest";
import {
  RETAG_FIELDS,
  compareEntry,
  compareField,
  familyOf,
  pickStratifiedSample,
  summarize,
} from "./retag-diff.js";

describe("retag diff", () => {
  it("does not score absent values as agreements", () => {
    expect(compareField(undefined, undefined)).toEqual({
      baselinePresent: false,
      candidatePresent: false,
      relation: "absent",
      agrees: null,
    });
    expect(compareField([], ["chart"])).toEqual({
      baselinePresent: false,
      candidatePresent: true,
      relation: "added",
      agrees: null,
    });
    expect(compareField(["chart"], [])).toEqual({
      baselinePresent: true,
      candidatePresent: false,
      relation: "removed",
      agrees: null,
    });
  });

  it("compares arrays as sets while preserving explicit disagreements", () => {
    expect(compareField(["card", "chart"], ["chart", "card"])).toMatchObject({
      relation: "unchanged",
      agrees: true,
    });
    expect(compareField(["card"], ["chart"])).toMatchObject({
      relation: "changed",
      agrees: false,
    });
  });

  it("reports field denominators separately", () => {
    const result = summarize([
      compareEntry(
        { id: "one", source: { productName: "Acme" }, categories: ["dashboard"] },
        { id: "one", source: { productName: "Acme" }, categories: ["dashboard"] },
      ),
      compareEntry(
        { id: "two", source: { productName: "Acme" }, categories: [] },
        { id: "two", source: { productName: "Acme" }, categories: ["settings"] },
      ),
      compareEntry(
        { id: "three", source: { productName: "Beta" }, categories: ["dashboard"] },
        { id: "three", source: { productName: "Beta" }, categories: [] },
      ),
    ]);

    expect(result.categories).toEqual({
      baselinePresent: 2,
      candidatePresent: 2,
      bothPresent: 1,
      unchanged: 1,
      changed: 0,
      added: 1,
      removed: 1,
      disagreementRate: 0,
    });
  });

  it("uses stable product families and stratified deterministic sampling", () => {
    const entries = Array.from({ length: 12 }, (_, i) => ({
      id: `id-${i}`,
      source: { productName: i % 3 === 0 ? "Acme" : i % 3 === 1 ? "Beta" : "Gamma" },
    }));
    expect(familyOf(entries[0])).toBe("acme");
    const first = pickStratifiedSample(entries, 6, "seed").map((entry) => entry.id);
    const second = pickStratifiedSample(entries, 6, "seed").map((entry) => entry.id);
    expect(first).toEqual(second);
    expect(new Set(first.map((id) => entries.find((entry) => entry.id === id)?.source.productName))).toEqual(
      new Set(["Acme", "Beta", "Gamma"]),
    );
  });

  it("keeps the field list closed and reviewable", () => {
    expect(RETAG_FIELDS).toContain("categories");
    expect(RETAG_FIELDS).toContain("components");
    expect(RETAG_FIELDS).not.toContain("id");
  });
});
