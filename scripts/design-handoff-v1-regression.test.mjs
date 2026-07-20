/**
 * design-handoff-v1-regression.test.mjs — v1 scorer regression matrix.
 *
 * Proves the v1 design-handoff scorer (`scoreDesignHandoff`) is unchanged
 * across all 12 v1 labels and a fixed set of failure mutations. The test loads
 * committed synthetic candidates (`eval/design-handoff-v1-candidates.json`),
 * scores each against the matching v1 label, and compares byte-for-byte against
 * the committed baseline (`eval/design-handoff-v1-score-baseline.json`).
 *
 * This test does NOT use C2 schemas — it is a pure v1 gate. Any drift in the
 * v1 scorer surfaces here as the first case/mutation difference.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scoreDesignHandoff } from "./design-handoff-scorer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const labelsFile = JSON.parse(
  readFileSync(join(ROOT, "eval/design-handoff-labels.json"), "utf8"),
);
const candidatesFile = JSON.parse(
  readFileSync(join(ROOT, "eval/design-handoff-v1-candidates.json"), "utf8"),
);
const baselineFile = JSON.parse(
  readFileSync(join(ROOT, "eval/design-handoff-v1-score-baseline.json"), "utf8"),
);

const labels = labelsFile.labels;
const mutations = candidatesFile.mutations;

// Canonical JSON stringify (stable key order) so a key-order drift in the score
// object still compares equal — only the score VALUES are the contract.
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}

describe("design-handoff v1 regression matrix", () => {
  // Sentinel: the committed files must be self-consistent before we trust them.
  it("committed files agree on labelVersion 1 and the same label + mutation set", () => {
    expect(labelsFile.labelVersion).toBe(1);
    expect(candidatesFile.labelVersion).toBe(1);
    expect(baselineFile.labelVersion).toBe(1);
    expect(labels.length).toBe(12);
    for (const label of labels) {
      expect(candidatesFile.candidates[label.id]).toBeDefined();
      expect(baselineFile.scores[label.id]).toBeDefined();
    }
  });

  // One focused test per (label, mutation) so the first failure names the exact
  // case/mutation that drifted — not a single mega-assertion.
  for (const label of labels) {
    describe(`label ${label.id}`, () => {
      for (const mutation of mutations) {
        it(`${mutation} matches the committed baseline`, () => {
          const candidate = candidatesFile.candidates[label.id][mutation];
          const expected = baselineFile.scores[label.id][mutation];
          const actual = scoreDesignHandoff(candidate, label);
          // Byte-identical comparison via canonical JSON; report the first
          // difference if the v1 scorer drifted.
          if (canonical(actual) !== canonical(expected)) {
            throw new Error(
              `v1 scorer drift for label=${label.id} mutation=${mutation}\n` +
                `expected: ${JSON.stringify(expected)}\n` +
                `actual:   ${JSON.stringify(actual)}`,
            );
          }
          expect(canonical(actual)).toBe(canonical(expected));
        });
      }
    });
  }

  // Invariant the baseline alone cannot express: the satisfiable mutation is
  // complete for every label (proves the regression matrix is actually
  // satisfiable, not silently all-failing).
  it("every label's satisfiable candidate scores complete: true", () => {
    for (const label of labels) {
      const score = scoreDesignHandoff(
        candidatesFile.candidates[label.id].satisfiable,
        label,
      );
      expect(score.complete).toBe(true);
    }
  });
});
