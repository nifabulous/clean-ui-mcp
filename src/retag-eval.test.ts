import { describe, expect, it } from "vitest";
import { assertGoldBindings, evaluateGold, type GoldLabel } from "./retag-eval.js";

const labels: GoldLabel[] = [
  {
    entryId: "one",
    imageSha256: "hash-one",
    fields: {
      categories: { status: "present", value: ["dashboard"] },
      components: { status: "none" },
      patternType: { status: "abstain" },
    },
  },
  {
    entryId: "two",
    imageSha256: "hash-two",
    fields: {
      categories: { status: "present", value: ["dashboard"] },
      components: { status: "present", value: ["chart"] },
    },
  },
];

describe("retag evaluation", () => {
  it("scores explicit none and present labels without counting abstentions", () => {
    const result = evaluateGold(labels, [
      { id: "one", categories: ["dashboard"], components: [] },
      { id: "two", categories: ["settings"], components: ["chart", "card"] },
    ]);
    expect(result.fields.categories).toMatchObject({
      labelled: 2,
      abstained: 0,
      exact: 1,
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 1,
    });
    expect(result.fields.components).toMatchObject({
      labelled: 2,
      exact: 1,
      truePositives: 1,
      falsePositives: 1,
      falseNegatives: 0,
    });
    expect(result.fields.patternType).toMatchObject({ labelled: 0, abstained: 1, exactAccuracy: null });
  });

  it("does not count a missing prediction as an exact none", () => {
    const result = evaluateGold([
      { entryId: "missing", imageSha256: "hash-missing", fields: { components: { status: "none" } } },
      { entryId: "present", imageSha256: "hash-present", fields: { components: { status: "present", value: ["card"] } } },
    ], []);
    expect(result.missingPredictions).toEqual(["missing", "present"]);
    expect(result.fields.components).toMatchObject({
      labelled: 2,
      exact: 0,
      truePositives: 0,
      falsePositives: 0,
      falseNegatives: 1,
    });
  });

  it("rejects duplicate, unknown, and stale image bindings", () => {
    expect(() => assertGoldBindings(
      [{ entryId: "one", imageSha256: "wrong", fields: {} }],
      [{ id: "one" }],
      () => "hash-one",
    )).toThrow(/image hash mismatch/);
    expect(() => assertGoldBindings(
      [labels[0]!, labels[0]!],
      [{ id: "one" }],
      () => "hash-one",
    )).toThrow(/duplicate/);
  });
});
