/**
 * Tests for the post-baseline compatibility contract (Task C4).
 *
 * `validateBaselineCompatibility` is the ONLY accepted post-baseline
 * compatibility input. It binds exactly the 5 manifest-pinned independent run
 * refs, requires all 6 checklist booleans, a distinct human reviewer ID, a
 * non-empty rationale, and an ISO-8601 timestamp. It rejects CLI-synthesized
 * checklists, mismatched/stale run refs, and any attempt to fabricate
 * compatibility from score completeness.
 *
 * These tests build a valid evaluation programmatically and then mutate one
 * field per failure scenario to pin each rejection rule independently.
 */
import { describe, expect, it } from "vitest";
import {
  validateBaselineCompatibility,
  type C2BaselineCompatibilityEvaluation,
} from "./baseline-compatibility.js";

const SHA64 = "a".repeat(64);

const INDEPENDENT_RUN_REFS = [
  {
    artifactId: "c2-run-manifest-c2-run-baseline-stablecoin-home-current-grounded-independent-1",
    path: "eval/c2/baseline/runs/c2-run-baseline-stablecoin-home-current-grounded-independent-1/manifest.json",
    sha256: "1".repeat(64),
  },
  {
    artifactId: "c2-run-manifest-c2-run-baseline-finance-news-story-detail-current-grounded-independent-1",
    path: "eval/c2/baseline/runs/c2-run-baseline-finance-news-story-detail-current-grounded-independent-1/manifest.json",
    sha256: "2".repeat(64),
  },
  {
    artifactId: "c2-run-manifest-c2-run-baseline-public-marketing-migration-current-grounded-independent-1",
    path: "eval/c2/baseline/runs/c2-run-baseline-public-marketing-migration-current-grounded-independent-1/manifest.json",
    sha256: "3".repeat(64),
  },
  {
    artifactId: "c2-run-manifest-c2-run-baseline-safety-conflicting-evidence-current-grounded-independent-1",
    path: "eval/c2/baseline/runs/c2-run-baseline-safety-conflicting-evidence-current-grounded-independent-1/manifest.json",
    sha256: "4".repeat(64),
  },
  {
    artifactId: "c2-run-manifest-c2-run-baseline-named-inspiration-safety-current-grounded-independent-1",
    path: "eval/c2/baseline/runs/c2-run-baseline-named-inspiration-safety-current-grounded-independent-1/manifest.json",
    sha256: "5".repeat(64),
  },
];

function buildValidEvaluation(): C2BaselineCompatibilityEvaluation {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-baseline-compatibility-evaluation",
    artifactId: "c2-baseline-compatibility-evaluation-v1",
    independentRunRefs: INDEPENDENT_RUN_REFS,
    checklist: {
      criticalDecisionCoverageComplete: true,
      contradictoryCriticalDecisions: false,
      constraintsRespected: true,
      forbiddenClaimsRespected: true,
      compatibleJourneys: true,
      safetyPassedIndependently: true,
    },
    reviewerActorId: "codex-gold-reviewer",
    rationale: "All five independent Claude runs agree with the OpenAI primary runs on critical decisions, constraints, forbidden claims, and the safety cases pass independently.",
    evaluatedAt: "2026-07-22T12:00:00.000Z",
  };
}

describe("validateBaselineCompatibility — acceptance rules", () => {
  it("parses a valid human-authored evaluation", () => {
    const ev = buildValidEvaluation();
    const result = validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS);
    expect(result.artifactType).toBe("c2-baseline-compatibility-evaluation");
    expect(result.independentRunRefs).toHaveLength(5);
    expect(result.checklist.safetyPassedIndependently).toBe(true);
  });

  it("accepts an evaluation whose independent refs match in a different order", () => {
    // The 5 refs are a SET; the human author may list them in any order.
    const ev = buildValidEvaluation();
    ev.independentRunRefs = [...INDEPENDENT_RUN_REFS].reverse();
    const result = validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS);
    expect(result.independentRunRefs).toHaveLength(5);
  });

  it("rejects an evaluation with the wrong number of run refs", () => {
    const ev = buildValidEvaluation();
    // Drop one ref → only 4.
    ev.independentRunRefs = INDEPENDENT_RUN_REFS.slice(0, 4);
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS)).toThrow(/independentRunRefs|exactly 5|count/i);
  });

  it("rejects an evaluation whose run IDs do not match the manifest's", () => {
    const ev = buildValidEvaluation();
    // Swap one ref for a foreign run ID.
    ev.independentRunRefs = [
      ...INDEPENDENT_RUN_REFS.slice(0, 4),
      {
        artifactId: "c2-run-manifest-c2-run-baseline-foreign-case-current-grounded-independent-1",
        path: "eval/c2/baseline/runs/c2-run-baseline-foreign-case-current-grounded-independent-1/manifest.json",
        sha256: "9".repeat(64),
      },
    ];
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS)).toThrow(/independentRunRefs|run id|manifest|mismatch/i);
  });

  it("rejects a tampered run-ref hash", () => {
    const ev = buildValidEvaluation();
    // Mutate the sha256 of one ref so it no longer matches the expected.
    const tampered = [...ev.independentRunRefs];
    tampered[0] = { ...tampered[0]!, sha256: "f".repeat(64) };
    ev.independentRunRefs = tampered;
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS)).toThrow(/sha256|hash|tamper|mismatch/i);
  });

  it("rejects a CLI-synthesized checklist (cliSynthesized: true)", () => {
    const ev = buildValidEvaluation();
    (ev.checklist as { cliSynthesized?: boolean }).cliSynthesized = true;
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS)).toThrow(/cliSynthesized|synthesized/i);
  });

  it("rejects a duplicate run ref", () => {
    const ev = buildValidEvaluation();
    // Duplicate the first ref over the second slot.
    ev.independentRunRefs = [INDEPENDENT_RUN_REFS[0]!, INDEPENDENT_RUN_REFS[0]!, ...INDEPENDENT_RUN_REFS.slice(2)];
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS)).toThrow(/independentRunRefs|duplicate|unique/i);
  });

  it("rejects a missing rationale", () => {
    const ev = buildValidEvaluation();
    (ev as { rationale: string }).rationale = "";
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS)).toThrow(/rationale|non-empty/i);
  });

  it("rejects a missing reviewer ID", () => {
    const ev = buildValidEvaluation();
    (ev as { reviewerActorId: string }).reviewerActorId = "";
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS)).toThrow(/reviewerActorId|non-empty/i);
  });

  it("rejects a non-ISO-8601 evaluatedAt", () => {
    const ev = buildValidEvaluation();
    (ev as { evaluatedAt: string }).evaluatedAt = "not-a-timestamp";
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS)).toThrow(/evaluatedAt|ISO|datetime/i);
  });

  it("rejects a wrong artifactType", () => {
    const ev = buildValidEvaluation();
    (ev as { artifactType: string }).artifactType = "c2-closure-report";
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS)).toThrow(/artifactType/i);
  });

  it("rejects a wrong schemaVersion", () => {
    const ev = buildValidEvaluation();
    (ev as { schemaVersion: string }).schemaVersion = "2.0";
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS)).toThrow(/schemaVersion/i);
  });

  it("rejects a smuggled extra field (strict)", () => {
    const ev = buildValidEvaluation() as Record<string, unknown>;
    ev.smuggled = "extra";
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS)).toThrow(/unrecognized|smuggled|strict/i);
  });

  it("requires all 6 checklist booleans (rejects a missing checklist field)", () => {
    const ev = buildValidEvaluation();
    // Delete one boolean from the checklist.
    delete (ev.checklist as Record<string, boolean>).safetyPassedIndependently;
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS)).toThrow(/checklist|safetyPassedIndependently|required/i);
  });
});

describe("validateBaselineCompatibility — edge cases on refs", () => {
  it("treats refs as content-addressed: same path + sha but different artifactId still mismatches", () => {
    const ev = buildValidEvaluation();
    const mutated = [...ev.independentRunRefs];
    mutated[0] = { ...mutated[0]!, artifactId: "c2-run-manifest-different-id" };
    ev.independentRunRefs = mutated;
    // The match is on the full ref triple (artifactId + path + sha), so a
    // changed artifactId is a mismatch.
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS)).toThrow(/mismatch|run|independentRunRefs/i);
  });

  it("rejects when the expected refs themselves are the wrong count (caller error)", () => {
    const ev = buildValidEvaluation();
    // Caller passes only 4 expected refs — the evaluator still requires the
    // evaluation to match what was passed, and 5 ≠ 4 fails.
    expect(() => validateBaselineCompatibility(ev, INDEPENDENT_RUN_REFS.slice(0, 4))).toThrow(/independentRunRefs|count|exactly/i);
  });

  void SHA64;
});
