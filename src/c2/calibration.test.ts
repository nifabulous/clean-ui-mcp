/**
 * C2 calibration reducer tests (Task 8, Steps 1, 2, 5, 6).
 *
 * These tests pin the pure comparison reducer (spec §11) and the explicit
 * freeze gate. The proposal carries measurements (mean deltas, per-dimension
 * regressions, readiness transitions, deterministic transitions, safety
 * non-inferiority, gold headroom, primary-vs-independent compatibility,
 * observed costs) but selects NO thresholds. The freeze validates the human
 * authorization's selected thresholds, binds the proposal + evidence hashes, and
 * produces a byte-identical re-freeze for the same authorization + timestamp.
 *
 * Adversarial freeze-negative tests cover every concrete rejection in plan
 * Step 2:
 *   - missing scorecards
 *   - changed candidate hashes (output hash drift between scorecard + manifest)
 *   - missing family/provider coverage
 *   - proposal missing any required primary run
 *   - Claude set missing any pilot family
 *   - threshold overrides (CLI-style fields the authorization must not accept)
 *   - proposal-hash mismatch
 *   - absent human authorization
 */
import { describe, expect, it, beforeEach } from "vitest";
import {
  buildCalibrationProposal,
  evaluateIndependentCompatibility,
  freezeCalibration,
  STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION,
  __test,
  type CalibrationRun,
  type CalibrationScorecard,
  type ClaudeCoverageException,
  type CompatibilityChecklistInput,
  type FreezeAuthorization,
  type IndependentCompatibility,
} from "./calibration.js";
import { C2CalibrationProposalSchema, C2FrozenCalibrationSchema } from "./condition-contracts.js";
import type { C2HumanScorecard } from "./evaluation-contracts.js";
import type { C2DeterministicScore } from "./candidate-contracts.js";
import { canonicalJsonStringify, sha256Hex } from "../readiness/contracts.js";

// ---------------------------------------------------------------------------
// Dimension + family constants
// ---------------------------------------------------------------------------

const DIMENSIONS = [
  "product-appropriateness",
  "cross-screen-coherence",
  "implementation-clarity",
  "originality",
  "accessibility-and-failure-states",
  "evidence-discipline",
] as const;

const FAMILIES = ["product", "migration", "safety"] as const;
const PRIMARY_CONDITIONS = ["brief-only", "current-grounded", "gold-evidence"] as const;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CASE_BY_FAMILY: Record<(typeof FAMILIES)[number], string> = {
  product: "stablecoin-home",
  migration: "named-inspiration-migration",
  safety: "public-marketing-safety",
};

function shaOf(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJsonStringify(value), "utf-8"));
}

/** A deterministic score for a run. `complete=true` unless overridden. */
function makeScore(runId: string, runOutputSha256: string, complete = true): C2DeterministicScore {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-deterministic-score",
    artifactId: `c2-score-${runId}`,
    runId,
    runOutputSha256,
    scorerSha256: "s".repeat(64),
    complete,
    requiredSectionCoverage: 1,
    requiredDecisionCoverage: 1,
    acceptanceCriterionCoverage: 1,
    missingScreenRequirements: [],
    unsupportedClaimCount: 0,
    forbiddenDisclosureCount: 0,
    unresolvedEvidenceCount: 0,
    provenanceMismatch: false,
  };
}

/**
 * A canonical human scorecard bound to a run + output hash. The `scores` array
 * accepts per-dimension overrides so a test can construct regressions or
 * deltas cleanly.
 */
function makeScorecard(opts: {
  runId: string;
  runOutputSha256: string;
  reviewerActorId?: string;
  scores?: Partial<Record<(typeof DIMENSIONS)[number], number>>;
  implementationReady?: boolean;
}): C2HumanScorecard {
  const scores = DIMENSIONS.map((dimension) => ({
    dimension,
    score: opts.scores?.[dimension] ?? 4,
    rationale: `Rationale for ${dimension}.`,
  }));
  const allMeetsFloor = scores.every((s) => s.score >= 3);
  return {
    schemaVersion: "1.0",
    artifactType: "c2-human-scorecard",
    artifactId: `c2-scorecard-${opts.runId}`,
    runId: opts.runId,
    runOutputSha256: opts.runOutputSha256,
    reviewerActorId: opts.reviewerActorId ?? "reviewer.gold-1",
    reviewerActorKind: "human",
    blindedCondition: true,
    scores,
    implementationReady: opts.implementationReady ?? allMeetsFloor,
    scoredAt: "2026-07-18T12:30:00.000Z",
  };
}

function makeRun(opts: {
  family: (typeof FAMILIES)[number];
  condition: "brief-only" | "current-grounded" | "gold-evidence";
  provider: "openai" | "claude";
  runId?: string;
  caseId?: string;
  runOutputSha256?: string;
  /**
   * The on-disk directory name. Defaults to `runId` (the common case). Override
   * to a different value to exercise the fallback-run case where the directory
   * is suffixed but the manifest's runId is canonical.
   */
  runDir?: string;
}): CalibrationRun {
  const caseId = opts.caseId ?? CASE_BY_FAMILY[opts.family];
  const runId = opts.runId ?? `c2-run-${opts.provider}-${caseId}-${opts.condition}`;
  const runOutputSha256 = opts.runOutputSha256 ?? shaOf({ runId, marker: opts.condition });
  const runDir = opts.runDir ?? runId;
  return {
    manifest: {
      schemaVersion: "2.0",
      artifactType: "c2-evaluation-run",
      artifactId: `c2-run-manifest-${runId}`,
      runId,
      predecessorRunId: null,
      casePackage: {
        artifactId: `c2-package-${caseId}-v1`,
        path: "eval/c2/pilot/manifest.json",
        sha256: "a".repeat(64),
      },
      condition: opts.condition,
      corpusSha256: opts.condition === "brief-only" ? null : "c".repeat(64),
      retrievalIndexSha256: opts.condition === "brief-only" ? null : "i".repeat(64),
      promptSha256: "p".repeat(64),
      harnessGitSha: "g".repeat(40),
      provider: opts.provider,
      model: opts.provider === "openai" ? "gpt-5.4-mini" : "claude-pinned",
      samplingParameters: { temperature: 0.2 },
      evidenceIds: opts.condition === "brief-only" ? [] : ["evidence:1"],
      startedAt: "2026-07-18T10:00:00.000Z",
      finishedAt: "2026-07-18T10:01:00.000Z",
      status: "succeeded",
      inputSha256: "n".repeat(64),
      rawOutputSha256: runOutputSha256,
      parsedOutputSha256: "q".repeat(64),
      promptTokens: 120,
      completionTokens: 80,
      costUsd: 0.04,
      conditionInputRef: {
        artifactId: `c2-condition-input-${caseId}-${opts.condition}`,
        path: `eval/c2/runs/${runId}/input.json`,
        sha256: "d".repeat(64),
      },
      scorerRef: {
        artifactId: "c2-scorer-v1",
        path: "src/c2/scorer.ts",
        sha256: "s".repeat(64),
      },
      attemptCount: 1,
      providerLatencyMs: 432,
      terminalReason: "succeeded",
      validationErrors: [],
      sourceSnapshotIds: opts.family === "migration" ? ["design-source-snapshot-1"] : [],
    },
    score: makeScore(runId, runOutputSha256),
    caseId,
    family: opts.family,
    runDir,
  };
}

/** Build the full pilot matrix: 3 OpenAI primary conditions × 3 families + 1
 * Claude independent condition × 3 families. Scorecards carry per-condition
 * deltas so the reducer can compute non-trivial measurements. */
function makeFullPilotMatrix(): {
  runs: CalibrationRun[];
  scorecards: CalibrationScorecard[];
} {
  const runs: CalibrationRun[] = [];
  const scorecards: CalibrationScorecard[] = [];

  for (const family of FAMILIES) {
    for (const condition of PRIMARY_CONDITIONS) {
      const run = makeRun({ family, condition, provider: "openai" });
      runs.push(run);
      // Score deltas: brief-only baseline 3.5, current-grounded 4.0,
      // gold-evidence 4.5 (per-dimension). One dimension regresses for the
      // safety family's brief-only baseline so the reducer can detect it.
      const scoreOverrides: Partial<Record<(typeof DIMENSIONS)[number], number>> =
        condition === "brief-only"
          ? { "product-appropriateness": 3, "cross-screen-coherence": 3, "implementation-clarity": 4, originality: 4, "accessibility-and-failure-states": 4, "evidence-discipline": 3 }
          : condition === "current-grounded"
            ? { "product-appropriateness": 4, "cross-screen-coherence": 4, "implementation-clarity": 4, originality: 4, "accessibility-and-failure-states": 4, "evidence-discipline": 4 }
            : { "product-appropriateness": 5, "cross-screen-coherence": 4, "implementation-clarity": 5, originality: 4, "accessibility-and-failure-states": 4, "evidence-discipline": 5 };
      scorecards.push({
        scorecard: makeScorecard({
          runId: run.manifest.runId,
          runOutputSha256: run.manifest.rawOutputSha256!,
          scores: scoreOverrides,
        }),
        caseId: run.caseId,
        family: run.family,
        condition: run.manifest.condition,
      });
    }
  }

  // Independent lane: Claude current-grounded for every family.
  for (const family of FAMILIES) {
    const run = makeRun({ family, condition: "current-grounded", provider: "claude" });
    runs.push(run);
    scorecards.push({
      scorecard: makeScorecard({
        runId: run.manifest.runId,
        runOutputSha256: run.manifest.rawOutputSha256!,
        reviewerActorId: "reviewer.qa-1",
      }),
      caseId: run.caseId,
      family: run.family,
      condition: run.manifest.condition,
    });
  }

  return { runs, scorecards };
}

function makeCompatibilityInput(): CompatibilityChecklistInput {
  return {
    criticalDecisionIds: ["decision:1", "decision:2", "decision:3"],
    openaiPrimary: {
      caseId: "stablecoin-home",
      coveredCriticalDecisionIds: ["decision:1", "decision:2", "decision:3"],
      criticalDecisionLanes: { "decision:1": "adapt", "decision:2": "retain", "decision:3": "reject" },
      constraintsRespected: ["constraint:1", "constraint:2"],
      forbiddenClaimsRespected: true,
      safetyCompliant: true,
    },
    claudeIndependent: {
      caseId: "stablecoin-home",
      coveredCriticalDecisionIds: ["decision:1", "decision:2", "decision:3"],
      criticalDecisionLanes: { "decision:1": "adapt", "decision:2": "retain", "decision:3": "reject" },
      constraintsRespected: ["constraint:1", "constraint:2"],
      forbiddenClaimsRespected: true,
      safetyCompliant: true,
    },
  };
}

function refOf(artifact: { artifactId: string; path: string; sha256: string }) {
  return { artifactId: artifact.artifactId, path: artifact.path, sha256: artifact.sha256 };
}

function makeMatchingAuthorization(proposalSha256: string, overrides: Partial<FreezeAuthorization> = {}): FreezeAuthorization {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-freeze-authorization",
    artifactId: "c2-freeze-auth-1",
    proposalSha256,
    reviewerActorId: "reviewer.gold-1",
    reviewerRole: "Gold Label Owner",
    rationale: "Approved material-benefit minimum and regression tolerance for the pilot.",
    materialBenefitMinimum: 0.25,
    regressionTolerance: 0.5,
    independentChecklist: {
      criticalDecisionCoverageComplete: true,
      contradictoryCriticalDecisions: false,
      constraintsRespected: true,
      forbiddenClaimsRespected: true,
      compatibleJourneys: true,
      safetyPassedIndependently: true,
    },
    maxRunCostUsd: 0.5,
    maxCampaignCostUsd: 5,
    frozenAt: "2026-07-19T00:00:00.000Z",
    rubricDimensions: [...DIMENSIONS],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildCalibrationProposal — pure comparison reduction
// ---------------------------------------------------------------------------

describe("buildCalibrationProposal", () => {
  let matrix: ReturnType<typeof makeFullPilotMatrix>;
  let campaignConfigRef: { artifactId: string; path: string; sha256: string };
  let pricingTableRef: { artifactId: string; path: string; sha256: string };

  beforeEach(() => {
    matrix = makeFullPilotMatrix();
    campaignConfigRef = {
      artifactId: "c2-campaign-config-pilot-v1",
      path: "eval/c2/config/pilot-campaign.json",
      sha256: "a".repeat(64),
    };
    pricingTableRef = {
      artifactId: "c2-pricing-table-pilot-v1",
      path: "eval/c2/config/pricing.json",
      sha256: "b".repeat(64),
    };
  });

  function proposalInputs(overrides: { runs?: CalibrationRun[]; scorecards?: CalibrationScorecard[] } = {}) {
    return {
      runs: overrides.runs ?? matrix.runs,
      scorecards: overrides.scorecards ?? matrix.scorecards,
      campaignConfigRef,
      pricingTableRef,
      compatibility: evaluateIndependentCompatibility(makeCompatibilityInput()),
      artifactId: "c2-calibration-proposal-pilot-v1",
    };
  }

  it("produces a schema-valid proposal carrying all measurement sections + artifact hashes", () => {
    const proposal = buildCalibrationProposal(proposalInputs());
    expect(C2CalibrationProposalSchema.safeParse(proposal).success).toBe(true);
    expect(proposal.campaignConfigRef).toEqual(campaignConfigRef);
    expect(proposal.pricingTableRef).toEqual(pricingTableRef);
    expect(proposal.measurements.conditionDeltas).toHaveLength(DIMENSIONS.length);
    expect(proposal.measurements.regressions).toBeInstanceOf(Array);
    expect(proposal.measurements.readinessTransitions.length).toBeGreaterThan(0);
    expect(proposal.measurements.deterministicTransitions.length).toBeGreaterThan(0);
    expect(proposal.measurements.safetyResults.length).toBeGreaterThan(0);
    expect(proposal.measurements.goldHeadroom).toBeDefined();
    expect(proposal.measurements.independentCompatibility).toBeDefined();
    expect(proposal.measurements.observedCosts).toBeDefined();
  });

  it("computes per-dimension current-grounded minus brief-only deltas", () => {
    const proposal = buildCalibrationProposal(proposalInputs());
    const delta = proposal.measurements.conditionDeltas.find(
      (d) => d.dimension === "product-appropriateness",
    );
    expect(delta).toBeDefined();
    // brief-only mean = 3, current-grounded mean = 4 across the 3 families.
    expect(delta!.briefOnlyMean).toBeCloseTo(3, 5);
    expect(delta!.currentGroundedMean).toBeCloseTo(4, 5);
    expect(delta!.goldEvidenceMean).toBeCloseTo(5, 5);
  });

  it("detects a per-dimension regression when a higher-condition mean drops below a lower-condition mean", () => {
    // Inject a regression: drop originality on current-grounded below brief-only.
    const scorecards = matrix.scorecards.map((entry) => {
      if (entry.condition === "current-grounded" && entry.family === "product") {
        const sc = entry.scorecard;
        return {
          ...entry,
          scorecard: {
            ...sc,
            scores: sc.scores.map((s) => (s.dimension === "originality" ? { ...s, score: 2 } : s)),
            implementationReady: false,
          },
        };
      }
      return entry;
    });
    const proposal = buildCalibrationProposal(proposalInputs({ scorecards }));
    const regression = proposal.measurements.regressions.find((r) => r.dimension === "originality");
    expect(regression).toBeDefined();
    expect(regression!.regressionMagnitude).toBeGreaterThan(0);
  });

  it("reports an implementation-readiness transition when brief-only is not ready but current-grounded is", () => {
    const scorecards = matrix.scorecards.map((entry) => {
      if (entry.family === "product" && entry.condition === "brief-only") {
        return {
          ...entry,
          scorecard: {
            ...entry.scorecard,
            scores: entry.scorecard.scores.map((s) => ({ ...s, score: 2 })),
            implementationReady: false,
          },
        };
      }
      return entry;
    });
    const proposal = buildCalibrationProposal(proposalInputs({ scorecards }));
    const transition = proposal.measurements.readinessTransitions.find(
      (t) => t.caseId === CASE_BY_FAMILY.product,
    );
    expect(transition).toBeDefined();
    expect(transition!.briefOnlyReady).toBe(false);
    expect(transition!.currentGroundedReady).toBe(true);
  });

  it("reports safety non-inferiority: current-grounded mean >= brief-only mean for the safety family", () => {
    const proposal = buildCalibrationProposal(proposalInputs());
    const safetyResult = proposal.measurements.safetyResults.find(
      (r) => r.caseId === CASE_BY_FAMILY.safety,
    );
    expect(safetyResult).toBeDefined();
    // Non-inferiority: current-grounded >= brief-only for every safety scorecard.
    expect(safetyResult!.currentGroundedCompliant).toBe(true);
  });

  it("reports gold-evidence minus current-grounded headroom", () => {
    const proposal = buildCalibrationProposal(proposalInputs());
    // goldEvidenceMean (4.666...) > currentGroundedMean (4.0) ⇒ positive headroom.
    expect(proposal.measurements.goldHeadroom.goldEvidenceMean).toBeGreaterThan(
      proposal.measurements.goldHeadroom.currentGroundedMean,
    );
  });

  it("rejects a scorecard whose runOutputSha256 does not match its run manifest", () => {
    const tampered = matrix.scorecards.map((entry) => {
      if (entry.condition === "brief-only" && entry.family === "product") {
        return {
          ...entry,
          scorecard: { ...entry.scorecard, runOutputSha256: "x".repeat(64) },
        };
      }
      return entry;
    });
    expect(() => buildCalibrationProposal(proposalInputs({ scorecards: tampered }))).toThrow(
      /hash|mismatch|binding|runOutput/i,
    );
  });

  it("rejects a scorecard that has no matching run manifest", () => {
    const orphan: CalibrationScorecard = {
      ...matrix.scorecards[0]!,
      scorecard: { ...matrix.scorecards[0]!.scorecard, runId: "c2-run-ghost" },
    };
    expect(() => buildCalibrationProposal(proposalInputs({ scorecards: [orphan] }))).toThrow(
      /no matching|manifest|run|orphan/i,
    );
  });

  it("the proposal carries NO thresholds (no materialBenefitMinimum, no regressionTolerance)", () => {
    const proposal = buildCalibrationProposal(proposalInputs());
    const serialized = canonicalJsonStringify(proposal);
    expect(serialized).not.toContain("materialBenefitMinimum");
    expect(serialized).not.toContain("regressionTolerance");
    expect(serialized).not.toContain("maxRunCostUsd");
    expect(serialized).not.toContain("frozenAt");
  });

  // -------------------------------------------------------------------------
  // Claude coverage exception — fail-closed relaxation for ONE documented pair
  // -------------------------------------------------------------------------

  /**
   * Build the pilot matrix missing ONLY the product::current-grounded Claude
   * run (the documented stablecoin-home truncation gap). All 9 primary runs +
   * the safety and migration Claude current-grounded runs are present.
   */
  function matrixMissingProductClaude(): {
    runs: CalibrationRun[];
    scorecards: CalibrationScorecard[];
  } {
    const runs = matrix.runs.filter(
      (r) => !(r.manifest.provider === "claude" && r.family === "product" && r.manifest.condition === "current-grounded"),
    );
    const scorecards = matrix.scorecards.filter(
      (s) => !(s.family === "product" && s.condition === "current-grounded" && matrix.runs.find((r) => r.manifest.runId === s.scorecard.runId)?.manifest.provider === "claude"),
    );
    return { runs, scorecards };
  }

  it("permits the documented exception for the exact missing Claude pair (product::current-grounded)", () => {
    const { runs, scorecards } = matrixMissingProductClaude();
    // The documented exception is honored — assertCoverageAndBinding must NOT throw.
    expect(() =>
      __test.assertCoverageAndBinding(runs, scorecards, [STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION]),
    ).not.toThrow();
  });

  it("still throws when the documented pair is missing and no exception is supplied", () => {
    const { runs, scorecards } = matrixMissingProductClaude();
    expect(() => __test.assertCoverageAndBinding(runs, scorecards, [])).toThrow(
      /missing Claude independent run for family 'product'/,
    );
  });

  it("still throws when the exception targets the wrong family (mismatched exception)", () => {
    const { runs, scorecards } = matrixMissingProductClaude();
    const wrongFamily: ClaudeCoverageException = {
      ...STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION,
      family: "migration",
    };
    expect(() => __test.assertCoverageAndBinding(runs, scorecards, [wrongFamily])).toThrow(
      /missing Claude independent run for family 'product'/,
    );
  });

  it("still throws when an unrelated Claude pair is also missing (exception excuses only product)", () => {
    // Drop BOTH product::current-grounded AND migration::current-grounded Claude runs.
    const runs = matrix.runs.filter(
      (r) => !(r.manifest.provider === "claude" && r.manifest.condition === "current-grounded"),
    );
    const scorecards = matrix.scorecards.filter(
      (s) => !(s.condition === "current-grounded" && matrix.runs.find((r) => r.manifest.runId === s.scorecard.runId)?.manifest.provider === "claude"),
    );
    // The exception only excuses product::current-grounded; migration still fails.
    expect(() =>
      __test.assertCoverageAndBinding(runs, scorecards, [STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION]),
    ).toThrow(/missing Claude independent run for family 'migration'/);
  });

  // -------------------------------------------------------------------------
  // Exact-match exception (P2): every field — family, condition, provider,
  // reason, attempts, evidenceRefs — must match the canonical constant. A
  // crafted exception with the right structural identity (family + condition +
  // provider) but a tampered reason/attempts/evidenceRefs must NOT pass the
  // coverage gate.
  // -------------------------------------------------------------------------

  it("rejects a tampered reason: same family/condition/provider but a different reason string fails closed", () => {
    const { runs, scorecards } = matrixMissingProductClaude();
    const tampered: ClaudeCoverageException = {
      ...STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION,
      reason: "A completely different reason that does not match the documented truncation incident.",
    };
    expect(() => __test.assertCoverageAndBinding(runs, scorecards, [tampered])).toThrow(
      /missing Claude independent run for family 'product'/,
    );
  });

  it("rejects a tampered attempts count: same family/condition/provider/reason but a different attempts number fails closed", () => {
    const { runs, scorecards } = matrixMissingProductClaude();
    const tampered: ClaudeCoverageException = {
      ...STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION,
      attempts: STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION.attempts + 1,
    };
    expect(() => __test.assertCoverageAndBinding(runs, scorecards, [tampered])).toThrow(
      /missing Claude independent run for family 'product'/,
    );
  });

  it("rejects tampered evidenceRefs: same identity but a different evidenceRefs array fails closed", () => {
    const { runs, scorecards } = matrixMissingProductClaude();
    const tampered: ClaudeCoverageException = {
      ...STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION,
      evidenceRefs: ["a-different-evidence-ref"],
    };
    expect(() => __test.assertCoverageAndBinding(runs, scorecards, [tampered])).toThrow(
      /missing Claude independent run for family 'product'/,
    );
  });

  it("rejects evidenceRefs with an extra entry (right prefix but a superset array fails closed)", () => {
    const { runs, scorecards } = matrixMissingProductClaude();
    const tampered: ClaudeCoverageException = {
      ...STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION,
      evidenceRefs: [...STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION.evidenceRefs, "extra-ref"],
    };
    expect(() => __test.assertCoverageAndBinding(runs, scorecards, [tampered])).toThrow(
      /missing Claude independent run for family 'product'/,
    );
  });

  it("rejects evidenceRefs with a reordered array (same entries, different order fails closed — order is part of the binding)", () => {
    const { runs, scorecards } = matrixMissingProductClaude();
    const tampered: ClaudeCoverageException = {
      ...STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION,
      evidenceRefs: [...STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION.evidenceRefs].reverse(),
    };
    expect(() => __test.assertCoverageAndBinding(runs, scorecards, [tampered])).toThrow(
      /missing Claude independent run for family 'product'/,
    );
  });

  it("primary coverage stays strict — a Claude exception does NOT excuse a missing primary run", () => {
    // Drop a primary run (product::brief-only).
    const runs = matrix.runs.filter(
      (r) => !(r.manifest.provider === "openai" && r.family === "product" && r.manifest.condition === "brief-only"),
    );
    const scorecards = matrix.scorecards.filter(
      (s) => !(s.family === "product" && s.condition === "brief-only"),
    );
    expect(() =>
      __test.assertCoverageAndBinding(runs, scorecards, [STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION]),
    ).toThrow(/missing primary run coverage/);
  });

  it("records honored Claude coverage exceptions on the proposal", () => {
    const { runs, scorecards } = matrixMissingProductClaude();
    const proposal = buildCalibrationProposal({
      runs,
      scorecards,
      campaignConfigRef,
      pricingTableRef,
      compatibility: evaluateIndependentCompatibility(makeCompatibilityInput()),
      artifactId: "c2-calibration-proposal-pilot-v1",
      claudeCoverageExceptions: [STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION],
    });
    expect(proposal.claudeCoverageExceptions).toHaveLength(1);
    expect(proposal.claudeCoverageExceptions[0]?.family).toBe("product");
    expect(proposal.claudeCoverageExceptions[0]?.condition).toBe("current-grounded");
    expect(proposal.claudeCoverageExceptions[0]?.provider).toBe("claude");
    // The default (no exceptions supplied) is an empty array.
    const fullProposal = buildCalibrationProposal(proposalInputs());
    expect(fullProposal.claudeCoverageExceptions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// evaluateIndependentCompatibility — OpenAI primary vs Claude independent
// ---------------------------------------------------------------------------

describe("evaluateIndependentCompatibility", () => {
  it("returns a fully-compatible checklist when both sides cover, agree, respect constraints, and pass safety", () => {
    const result = evaluateIndependentCompatibility(makeCompatibilityInput());
    expect(result.criticalDecisionCoverageComplete).toBe(true);
    expect(result.contradictoryCriticalDecisions).toBe(false);
    expect(result.constraintsRespected).toBe(true);
    expect(result.forbiddenClaimsRespected).toBe(true);
    expect(result.compatibleJourneys).toBe(true);
    expect(result.safetyPassedIndependently).toBe(true);
  });

  it("flags incomplete critical-decision coverage", () => {
    const input = makeCompatibilityInput();
    input.openaiPrimary.coveredCriticalDecisionIds = ["decision:1"];
    const result = evaluateIndependentCompatibility(input);
    expect(result.criticalDecisionCoverageComplete).toBe(false);
  });

  it("flags contradictory critical decisions (same ID, different lane)", () => {
    const input = makeCompatibilityInput();
    input.claudeIndependent.criticalDecisionLanes = {
      ...input.claudeIndependent.criticalDecisionLanes,
      "decision:1": "reject", // openai had "adapt"
    };
    const result = evaluateIndependentCompatibility(input);
    expect(result.contradictoryCriticalDecisions).toBe(true);
  });

  it("flags a constraint respected by one side but not the other", () => {
    const input = makeCompatibilityInput();
    input.claudeIndependent.constraintsRespected = ["constraint:1"];
    const result = evaluateIndependentCompatibility(input);
    expect(result.constraintsRespected).toBe(false);
  });

  it("flags a forbidden-claim or safety violation on either side", () => {
    const input = makeCompatibilityInput();
    input.openaiPrimary.forbiddenClaimsRespected = false;
    const result = evaluateIndependentCompatibility(input);
    expect(result.forbiddenClaimsRespected).toBe(false);
    // Safety fails independently when either side's safetyCompliant is false.
    input.claudeIndependent.safetyCompliant = false;
    const result2 = evaluateIndependentCompatibility(input);
    expect(result2.safetyPassedIndependently).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// freezeCalibration — explicit authorization + byte-identical re-freeze
// ---------------------------------------------------------------------------

describe("freezeCalibration", () => {
  let matrix: ReturnType<typeof makeFullPilotMatrix>;
  let campaignConfigRef: { artifactId: string; path: string; sha256: string };
  let pricingTableRef: { artifactId: string; path: string; sha256: string };

  beforeEach(() => {
    matrix = makeFullPilotMatrix();
    campaignConfigRef = {
      artifactId: "c2-campaign-config-pilot-v1",
      path: "eval/c2/config/pilot-campaign.json",
      sha256: "a".repeat(64),
    };
    pricingTableRef = {
      artifactId: "c2-pricing-table-pilot-v1",
      path: "eval/c2/config/pricing.json",
      sha256: "b".repeat(64),
    };
  });

  function buildProposal(runs: CalibrationRun[] = matrix.runs, scorecards: CalibrationScorecard[] = matrix.scorecards) {
    return buildCalibrationProposal({
      runs,
      scorecards,
      campaignConfigRef,
      pricingTableRef,
      compatibility: evaluateIndependentCompatibility(makeCompatibilityInput()),
      artifactId: "c2-calibration-proposal-pilot-v1",
    });
  }

  it("produces a schema-valid frozen calibration binding the proposal + run/scorecard/pricing/campaign hashes + selected thresholds", () => {
    const proposal = buildProposal();
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    const frozen = freezeCalibration({
      proposal,
      compatibility,
      authorization: makeMatchingAuthorization(proposal.proposalSha256),
      artifactId: "c2-frozen-calibration-pilot-v1",
    });
    expect(C2FrozenCalibrationSchema.safeParse(frozen).success).toBe(true);
    expect(frozen.proposalRef.sha256).toBe(proposal.proposalSha256);
    expect(frozen.materialBenefitMinimum).toBe(0.25);
    expect(frozen.regressionTolerance).toBe(0.5);
    expect(frozen.frozenAt).toBe("2026-07-19T00:00:00.000Z");
    expect(frozen.maxRunCostUsd).toBe(0.5);
    expect(frozen.maxCampaignCostUsd).toBe(5);
  });

  it("re-freeze with the SAME authorization + timestamp produces byte-identical output (OV8)", () => {
    const proposal = buildProposal();
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    const a = freezeCalibration({
      proposal,
      compatibility,
      authorization: makeMatchingAuthorization(proposal.proposalSha256),
      artifactId: "c2-frozen-calibration-pilot-v1",
    });
    const b = freezeCalibration({
      proposal,
      compatibility,
      authorization: makeMatchingAuthorization(proposal.proposalSha256),
      artifactId: "c2-frozen-calibration-pilot-v1",
    });
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  it("a DIFFERENT timestamp intentionally produces a different artifact hash", () => {
    const proposal = buildProposal();
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    const a = freezeCalibration({
      proposal,
      compatibility,
      authorization: makeMatchingAuthorization(proposal.proposalSha256),
      artifactId: "c2-frozen-calibration-pilot-v1",
    });
    const b = freezeCalibration({
      proposal,
      compatibility,
      authorization: makeMatchingAuthorization(proposal.proposalSha256, { frozenAt: "2026-07-20T00:00:00.000Z" }),
      artifactId: "c2-frozen-calibration-pilot-v1",
    });
    expect(canonicalJsonStringify(a)).not.toBe(canonicalJsonStringify(b));
  });

  // -------------------------------------------------------------------------
  // Freeze-negative tests (plan Step 2)
  // -------------------------------------------------------------------------

  it("rejects an authorization whose proposal hash does not match the proposal", () => {
    const proposal = buildProposal();
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    expect(() =>
      freezeCalibration({
        proposal,
        compatibility,
        authorization: makeMatchingAuthorization("0".repeat(64)),
        artifactId: "c2-frozen-calibration-pilot-v1",
      }),
    ).toThrow(/proposal.*hash|mismatch|authorization/i);
  });

  it("rejects a missing scorecard set (proposal reduced from no scorecards)", () => {
    expect(() =>
      buildCalibrationProposal({
        runs: matrix.runs,
        scorecards: [],
        campaignConfigRef,
        pricingTableRef,
        compatibility: evaluateIndependentCompatibility(makeCompatibilityInput()),
        artifactId: "c2-calibration-proposal-pilot-v1",
      }),
    ).toThrow(/scorecard|empty|missing/i);
  });

  it("rejects a proposal missing any required primary run (one family missing)", () => {
    const trimmed = matrix.runs.filter((r) => r.manifest.condition !== "brief-only" || r.family !== "safety");
    expect(() =>
      buildCalibrationProposal({
        runs: trimmed,
        scorecards: matrix.scorecards.filter((s) => s.family !== "safety" || s.condition !== "brief-only"),
        campaignConfigRef,
        pricingTableRef,
        compatibility: evaluateIndependentCompatibility(makeCompatibilityInput()),
        artifactId: "c2-calibration-proposal-pilot-v1",
      }),
    ).toThrow(/primary|coverage|family|missing|run/i);
  });

  it("rejects a proposal missing a Claude independent run for any pilot family", () => {
    const trimmed = matrix.runs.filter((r) => !(r.manifest.provider === "claude" && r.family === "safety"));
    expect(() =>
      buildCalibrationProposal({
        runs: trimmed,
        scorecards: matrix.scorecards.filter((s) => !(s.family === "safety" && s.condition === "current-grounded" && matrix.runs.find((r) => r.manifest.runId === s.scorecard.runId)?.manifest.provider === "claude")),
        campaignConfigRef,
        pricingTableRef,
        compatibility: evaluateIndependentCompatibility(makeCompatibilityInput()),
        artifactId: "c2-calibration-proposal-pilot-v1",
      }),
    ).toThrow(/independent|claude|family|coverage|missing/i);
  });

  it("rejects a non-positive material-benefit minimum (must be > 0)", () => {
    const proposal = buildProposal();
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    expect(() =>
      freezeCalibration({
        proposal,
        compatibility,
        authorization: makeMatchingAuthorization(proposal.proposalSha256, { materialBenefitMinimum: 0 }),
        artifactId: "c2-frozen-calibration-pilot-v1",
      }),
    ).toThrow(/material|benefit|positive|minimum/i);
  });

  it("rejects a non-finite or negative regression tolerance", () => {
    const proposal = buildProposal();
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    expect(() =>
      freezeCalibration({
        proposal,
        compatibility,
        // JSON cannot carry NaN; simulate via an explicit negative value.
        authorization: makeMatchingAuthorization(proposal.proposalSha256, { regressionTolerance: -0.1 }),
        artifactId: "c2-frozen-calibration-pilot-v1",
      }),
    ).toThrow(/regression|tolerance|negative|finite/i);
  });

  it("rejects a threshold override (the authorization tries to override the $0.50 run budget)", () => {
    const proposal = buildProposal();
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    expect(() =>
      freezeCalibration({
        proposal,
        compatibility,
        authorization: makeMatchingAuthorization(proposal.proposalSha256, { maxRunCostUsd: 1.0 as unknown as 0.5 }),
        artifactId: "c2-frozen-calibration-pilot-v1",
      }),
    ).toThrow(/budget|0\.5|max.*cost|override/i);
  });

  it("rejects a non-matching rubric-dimension set (the authorization's dimensions do not match the fixed six)", () => {
    const proposal = buildProposal();
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    expect(() =>
      freezeCalibration({
        proposal,
        compatibility,
        authorization: makeMatchingAuthorization(proposal.proposalSha256, {
          rubricDimensions: [...DIMENSIONS].slice(0, 5),
        }),
        artifactId: "c2-frozen-calibration-pilot-v1",
      }),
    ).toThrow(/rubric|dimension|six|6/i);
  });

  it("rejects a compatibility checklist that does not match the evaluated compatibility", () => {
    const proposal = buildProposal();
    // Authorize an incompatible checklist while the proposal's evaluation is compatible.
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    expect(() =>
      freezeCalibration({
        proposal,
        compatibility,
        authorization: makeMatchingAuthorization(proposal.proposalSha256, {
          independentChecklist: {
            ...compatibility,
            criticalDecisionCoverageComplete: false,
          },
        }),
        artifactId: "c2-frozen-calibration-pilot-v1",
      }),
    ).toThrow(/compatibility|checklist|mismatch/i);
  });

  it("rejects an absent human authorization (empty reviewerActorId)", () => {
    const proposal = buildProposal();
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    // An empty reviewerActorId is the "no human authorization" case — the freeze
    // gate must refuse the freeze with an actionable message naming the field.
    expect(() =>
      freezeCalibration({
        proposal,
        compatibility,
        authorization: makeMatchingAuthorization(proposal.proposalSha256, {
          reviewerActorId: "",
        }),
        artifactId: "c2-frozen-calibration-pilot-v1",
      }),
    ).toThrow(/reviewerActorId|required|authorization|human/i);
  });

  it("rejects a whitespace-only reviewerActorId (treats it as absent authorization)", () => {
    const proposal = buildProposal();
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    expect(() =>
      freezeCalibration({
        proposal,
        compatibility,
        authorization: makeMatchingAuthorization(proposal.proposalSha256, {
          reviewerActorId: "   ",
        }),
        artifactId: "c2-frozen-calibration-pilot-v1",
      }),
    ).toThrow(/reviewerActorId|required|authorization|human/i);
  });

  it("rejects CLI-synthesized compatibility at freeze time (fabricated placeholder)", () => {
    const proposal = buildProposal();
    // Build a compatibility marked cliSynthesized: true (the CLI's propose
    // command fabricates this from score-completeness signals). The freeze gate
    // must reject it because it's not a genuine independent evaluation.
    const synthesizedCompatibility: IndependentCompatibility = {
      ...evaluateIndependentCompatibility(makeCompatibilityInput()),
      cliSynthesized: true,
    };
    expect(() =>
      freezeCalibration({
        proposal,
        compatibility: synthesizedCompatibility,
        authorization: makeMatchingAuthorization(proposal.proposalSha256),
        artifactId: "c2-frozen-calibration-pilot-v1",
      }),
    ).toThrow(/cliSynthesized|fabricated|placeholder|genuine/i);
  });

  // -------------------------------------------------------------------------
  // P1: frozen calibration binds the ACTUAL run + scorecard evidence
  // (not the proposal placeholder). The CLI's runFreeze MUST pass real runs +
  // scorecards into freezeCalibration; otherwise both runManifestRefs and
  // scorecardRefs collapse to a single placeholder ref pointing at proposal.json
  // (gitignored), and the frozen artifact cannot be audited against the 11 run
  // manifests + 11 scorecards.
  // -------------------------------------------------------------------------

  it("freezeCalibration with real runs + scorecards binds every run manifest + scorecard (NOT the proposal placeholder)", () => {
    const runs = matrix.runs;
    const scorecards = matrix.scorecards;
    const proposal = buildProposal(runs, scorecards);
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    const frozen = freezeCalibration({
      proposal,
      compatibility,
      authorization: makeMatchingAuthorization(proposal.proposalSha256),
      runs,
      scorecards,
      artifactId: "c2-frozen-calibration-pilot-v1",
    });

    // All runs bound — one ref per run, no placeholder collapse.
    expect(frozen.runManifestRefs).toHaveLength(runs.length);
    // All scorecards bound — one ref per scorecard, no placeholder collapse.
    expect(frozen.scorecardRefs).toHaveLength(scorecards.length);

    // The refs' artifactId / path / sha256 must match the ACTUAL run manifests
    // + scorecards — NOT the proposal.json placeholder. The path uses runDir
    // (the on-disk directory name), not runId.
    const expectedRunRefs = runs.map((r) => refOf({
      artifactId: r.manifest.artifactId,
      path: `eval/c2/runs/${r.runDir}/manifest.json`,
      sha256: sha256Hex(Buffer.from(canonicalJsonStringify(r.manifest), "utf-8")),
    }));
    expect(frozen.runManifestRefs).toEqual(expectedRunRefs);

    const expectedScorecardRefs = scorecards.map((s) => refOf({
      artifactId: s.scorecard.artifactId,
      path: `eval/c2/scorecards/${s.scorecard.artifactId}.json`,
      sha256: sha256Hex(Buffer.from(canonicalJsonStringify(s.scorecard), "utf-8")),
    }));
    expect(frozen.scorecardRefs).toEqual(expectedScorecardRefs);

    // None of the refs may point at the proposal.json placeholder path.
    for (const ref of frozen.runManifestRefs) {
      expect(ref.path).not.toBe("eval/c2/calibration/proposal.json");
    }
    for (const ref of frozen.scorecardRefs) {
      expect(ref.path).not.toBe("eval/c2/calibration/proposal.json");
    }
  });

  it("freezeCalibration WITHOUT runs + scorecards falls back to the proposal placeholder (documents the P1 gap)", () => {
    const proposal = buildProposal();
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    const frozen = freezeCalibration({
      proposal,
      compatibility,
      authorization: makeMatchingAuthorization(proposal.proposalSha256),
      artifactId: "c2-frozen-calibration-pilot-v1",
    });
    // The fallback path: both refs collapse to a single proposal.json ref.
    // This is the pre-P1 behavior; the test pins it so the contrast with the
    // real-evidence path above is explicit.
    expect(frozen.runManifestRefs).toHaveLength(1);
    expect(frozen.scorecardRefs).toHaveLength(1);
    expect(frozen.runManifestRefs[0]!.path).toBe("eval/c2/calibration/proposal.json");
    expect(frozen.scorecardRefs[0]!.path).toBe("eval/c2/calibration/proposal.json");
  });

  // -------------------------------------------------------------------------
  // P2: manifestRef uses run.runDir (the actual on-disk directory) for the ref
  // path — NOT manifest.runId. A fallback run's directory is suffixed
  // `-fallback` while its manifest.runId carries the canonical (un-suffixed)
  // identifier; using runId for the path would point at the wrong directory
  // and the frozen ref would fail to resolve in a fresh clone. This test
  // reproduces the exact fallback-run shape observed in the pilot: a run whose
  // directory name differs from its manifest.runId.
  // -------------------------------------------------------------------------

  it("freezeCalibration uses run.runDir (not manifest.runId) for the ref path — fallback-run case", () => {
    // Build the full pilot matrix, then RE-PLACE the migration product family's
    // current-grounded primary run with a fallback variant: its directory name
    // is suffixed `-fallback` while its manifest.runId is the canonical form.
    const matrixRuns = matrix.runs;
    const matrixScorecards = matrix.scorecards;

    // The canonical runId the fallback manifest reports (matches what the
    // scorecard binds via runId). The fallback directory is suffixed.
    const fallbackRunId = "c2-run-openai-named-inspiration-migration-current-grounded-primary-1";
    const fallbackRunDir = `${fallbackRunId}-fallback`;
    const fallbackOutputSha = shaOf({ runId: fallbackRunId, marker: "fallback-output" });

    // Replace the migration current-grounded openai run with a fallback whose
    // runDir differs from its manifest.runId.
    const runs = matrixRuns.map((r) => {
      if (
        r.family === "migration" &&
        r.manifest.provider === "openai" &&
        r.manifest.condition === "current-grounded"
      ) {
        return makeRun({
          family: "migration",
          condition: "current-grounded",
          provider: "openai",
          runId: fallbackRunId,
          runDir: fallbackRunDir,
          runOutputSha256: fallbackOutputSha,
        });
      }
      return r;
    });

    // The matching scorecard must bind the fallback runId + output hash.
    const scorecards = matrixScorecards.map((s) => {
      if (
        s.family === "migration" &&
        s.condition === "current-grounded" &&
        matrixRuns.find((r) => r.manifest.runId === s.scorecard.runId)?.manifest.provider === "openai"
      ) {
        return {
          ...s,
          scorecard: makeScorecard({
            runId: fallbackRunId,
            runOutputSha256: fallbackOutputSha,
          }),
        };
      }
      return s;
    });

    const proposal = buildProposal(runs, scorecards);
    const compatibility = evaluateIndependentCompatibility(makeCompatibilityInput());
    const frozen = freezeCalibration({
      proposal,
      compatibility,
      authorization: makeMatchingAuthorization(proposal.proposalSha256),
      runs,
      scorecards,
      artifactId: "c2-frozen-calibration-pilot-v1",
    });

    // Find the fallback run's ref. It MUST point at the `-fallback` directory
    // (runDir), NOT the canonical runId directory. Using runId would point at
    // the FAILED run's directory (which has no score.json) and the ref would
    // fail to resolve.
    const fallbackRef = frozen.runManifestRefs.find(
      (ref) => ref.artifactId === `c2-run-manifest-${fallbackRunId}`,
    );
    expect(fallbackRef).toBeDefined();
    expect(fallbackRef!.path).toBe(`eval/c2/runs/${fallbackRunDir}/manifest.json`);
    // The path must NOT match the canonical runId directory (the bug case).
    expect(fallbackRef!.path).not.toBe(`eval/c2/runs/${fallbackRunId}/manifest.json`);
    // The sha256 must bind the fallback manifest's canonical JSON — so path
    // and hash agree (the original bug was path=runId dir, hash=fallback
    // manifest).
    expect(fallbackRef!.sha256).toBe(
      sha256Hex(
        Buffer.from(
          canonicalJsonStringify(
            runs.find((r) => r.runDir === fallbackRunDir)!.manifest,
          ),
          "utf-8",
        ),
      ),
    );

    // No ref anywhere in the frozen artifact may point at the canonical runId
    // directory (the failed-run path). Every ref must use a runDir.
    for (const ref of frozen.runManifestRefs) {
      expect(ref.path).not.toBe(`eval/c2/runs/${fallbackRunId}/manifest.json`);
    }
  });
});
