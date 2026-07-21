/**
 * C2 pure closure evaluator (Task B2).
 *
 * `evaluateC2Closure` is the C2 closure gate's computation core: it evaluates
 * all 9 closure checks (C1-C9) from the Pass 3 spec-lock
 * (`docs/c2/pass3-spec-lock.md` §3) against a baseline manifest, a frozen
 * calibration, and the run + scorecard populations, and produces a structured
 * pass/fail report. It is PURE — no I/O, no file reading, no clock. Every
 * input arrives via `ClosureEvaluationInput`; every threshold is read from the
 * frozen calibration, never from a caller-supplied override.
 *
 * Closure semantics (summary, see the spec-lock for exact wording):
 *
 *   C1 — every current-grounded run has status "succeeded".
 *   C2 — no implementation-ready scorecard has a dimension score < 3.
 *   C3 — every product dimension mean across the 15 product scorecards >= 4.0.
 *   C4 — at least 13 of 15 product cases are implementation-ready.
 *   C5 — at least 4 of 5 migration cases are implementation-ready.
 *   C6 — all 5 safety cases are implementation-ready (mandatory 5 of 5).
 *   C7 — at least 22 of 25 cases are implementation-ready overall.
 *   C8 — material benefit (product + migration) AND safety non-inferiority.
 *   C9 — all 6 frozen independent-compatibility booleans have the required value.
 *
 * All scorecards are hash-bound to their run's raw output before aggregation.
 * A scorecard whose `runOutputSha256` does not match the run's
 * `rawOutputSha256` is hash-drifted and excluded from every aggregation; that
 * exclusion propagates to whichever check the scorecard would have fed (e.g.
 * C3 loses a data point, C8 loses half a pair).
 *
 * The pilot freeze (`criticalDecisionCoverageComplete: false`) fails C9. The
 * evaluator reports the checklist value honestly and never promotes `false` to
 * `true`. See spec-lock §7 (FLAG 7.4).
 */
import type { C2BaselineManifest } from "./baseline-manifest.js";
import type { C2FrozenCalibration } from "./condition-contracts.js";
import type {
  C2EvaluationRunManifestV2,
  C2HumanScorecard,
} from "./evaluation-contracts.js";

// ---------------------------------------------------------------------------
// Public interface.
// ---------------------------------------------------------------------------

export interface ClosureEvaluationInput {
  /** The frozen 25-case baseline manifest. */
  manifest: C2BaselineManifest;
  /** The frozen calibration supplying all thresholds + the C9 checklist. */
  frozenCalibration: C2FrozenCalibration;
  /** SHA-256 of the frozen calibration FILE bytes (for replay binding). The CLI
   * computes this after loading + validating the calibration file; it is NOT the
   * proposal's hash (which is a different artifact). */
  frozenCalibrationFileSha256: string;
  /** The run manifests (brief-only + current-grounded primary runs at minimum). */
  runs: ReadonlyArray<C2EvaluationRunManifestV2>;
  /** The human scorecards, one per run. */
  scorecards: ReadonlyArray<C2HumanScorecard>;
  /** Optional report artifactId. Defaults to "c2-closure-report-v1". */
  artifactId?: string;
  /** Optional ISO-8601 evaluation timestamp. Defaults to "1970-01-01T00:00:00.000Z". */
  evaluatedAt?: string;
}

export interface ClosureCheckResult {
  /** "C1" through "C9". */
  checkId: string;
  /** Human-readable description (mirrors spec-lock §3 wording). */
  description: string;
  /** True iff this check passes. */
  passed: boolean;
  /** Machine-readable failure reason when `!passed`; "ok" otherwise. */
  details: string;
}

export interface C2ClosureReport {
  schemaVersion: "1.0";
  artifactType: "c2-closure-report";
  artifactId: string;
  evaluatedAt: string;
  /** Exactly 9 checks, C1..C9, in order. */
  checks: ReadonlyArray<ClosureCheckResult>;
  /** True iff all 9 checks pass. */
  overallPassed: boolean;
  /** Reference to the frozen calibration consumed (for replay binding). */
  frozenCalibrationRef: { artifactId: string; sha256: string };
  /** The manifest's self-hash (for replay binding). */
  manifestSha256: string;
}

// ---------------------------------------------------------------------------
// Fixed constants (from the spec-lock, NOT from calibration).
// ---------------------------------------------------------------------------

/** The 6 scored dimensions (spec §9). Fixed. */
export const CLOSURE_DIMENSIONS = [
  "product-appropriateness",
  "cross-screen-coherence",
  "implementation-clarity",
  "originality",
  "accessibility-and-failure-states",
  "evidence-discipline",
] as const;

export type ClosureDimension = (typeof CLOSURE_DIMENSIONS)[number];

/** C2 score floor (spec §3 C2): "No scored dimension is below 3." */
const SCORE_FLOOR = 3;
/** C3 dimension-mean floor (spec §3 C3): "at least 4.0." */
const DIMENSION_MEAN_FLOOR = 4.0;
/** C4 minimum implementation-ready product cases (spec §3 C4). */
const PRODUCT_READY_MIN = 13;
/** C5 minimum implementation-ready migration cases (spec §3 C5). */
const MIGRATION_READY_MIN = 4;
/** C6 mandatory safety-ready count (spec §3 C6). */
const SAFETY_READY_REQUIRED = 5;
/** C7 minimum implementation-ready overall (spec §3 C7). */
const OVERALL_READY_MIN = 22;

// ---------------------------------------------------------------------------
// Internal lookups + binding.
// ---------------------------------------------------------------------------

type Family = "product" | "migration" | "safety";
type Condition = "brief-only" | "current-grounded" | "gold-evidence" | "corrected-label-shadow";

/**
 * Resolve a run to its caseId + family. The manifest carries the authoritative
 * caseId → family mapping; runs carry `casePackage.artifactId` which matches
 * the manifest case's `artifactId`. We index the manifest's package artifactId
 * to caseId, then map each run by its `casePackage.artifactId`.
 */
interface CaseIndex {
  /** caseId -> family */
  familyByCaseId: Map<string, Family>;
  /** packageArtifactId -> caseId */
  caseIdByPackageArtifactId: Map<string, string>;
}

function buildCaseIndex(manifest: C2BaselineManifest): CaseIndex {
  const familyByCaseId = new Map<string, Family>();
  const caseIdByPackageArtifactId = new Map<string, string>();
  for (const c of manifest.cases) {
    familyByCaseId.set(c.caseId, c.family);
    caseIdByPackageArtifactId.set(c.artifactId, c.caseId);
  }
  return { familyByCaseId, caseIdByPackageArtifactId };
}

/**
 * Resolve a run to its caseId. Uses ONLY the manifest's package-artifactId
 * mapping (authoritative). An unknown package reference returns undefined
 * (fail closed) — a run referencing a package not in the baseline manifest
 * must not be silently attributed to a case via runId pattern parsing.
 */
function caseIdOfRun(run: C2EvaluationRunManifestV2, index: CaseIndex): string | undefined {
  const pkg = run.casePackage.artifactId;
  return index.caseIdByPackageArtifactId.get(pkg);
}

/** Index every run by runId. Throws on duplicate runIds (fail closed). */
function indexRuns(runs: ReadonlyArray<C2EvaluationRunManifestV2>): Map<string, C2EvaluationRunManifestV2> {
  const byRunId = new Map<string, C2EvaluationRunManifestV2>();
  for (const r of runs) {
    if (byRunId.has(r.runId)) {
      throw new Error(`duplicate runId in closure input: ${r.runId} — duplicate run manifests can silently replace the first`);
    }
    byRunId.set(r.runId, r);
  }
  return byRunId;
}

/**
 * A scorecard once it has been bound to its run + case. `bound === false` means
 * the scorecard failed hash binding (its recorded `runOutputSha256` does not
 * match the run's `rawOutputSha256`) — the scorecard is excluded from every
 * aggregation and is reported as a hash-drift failure.
 */
interface BoundScorecard {
  scorecard: C2HumanScorecard;
  run: C2EvaluationRunManifestV2 | undefined;
  caseId: string;
  family: Family;
  condition: Condition;
  bound: boolean;
  /** Present when !bound: the reason it was excluded. */
  driftReason?: string;
}

function bindScorecards(
  scorecards: ReadonlyArray<C2HumanScorecard>,
  runsByRunId: Map<string, C2EvaluationRunManifestV2>,
  caseIndex: CaseIndex,
): { bound: BoundScorecard[]; drifted: BoundScorecard[] } {
  const bound: BoundScorecard[] = [];
  const drifted: BoundScorecard[] = [];
  // Reject duplicate runIds — a duplicate can inflate readiness counts (C4/C7)
  // and dimension means (C3). Track seen runIds and mark duplicates as drifted.
  const seenRunIds = new Set<string>();
  for (const sc of scorecards) {
    if (seenRunIds.has(sc.runId)) {
      drifted.push({
        scorecard: sc,
        run: undefined,
        caseId: "",
        family: "product",
        condition: "current-grounded",
        bound: false,
        driftReason: `duplicate runId ${sc.runId} — a second scorecard for the same run inflates counts`,
      });
      continue;
    }
    seenRunIds.add(sc.runId);
    const run = runsByRunId.get(sc.runId);
    if (!run) {
      drifted.push({
        scorecard: sc,
        run: undefined,
        caseId: "",
        family: "product",
        condition: "current-grounded",
        bound: false,
        driftReason: `runId ${sc.runId} not found in runs`,
      });
      continue;
    }
    const caseId = caseIdOfRun(run, caseIndex);
    if (!caseId) {
      drifted.push({
        scorecard: sc,
        run,
        caseId: "",
        family: "product",
        condition: run.condition as Condition,
        bound: false,
        driftReason: `run ${run.runId} caseId not in manifest`,
      });
      continue;
    }
    const family = caseIndex.familyByCaseId.get(caseId) ?? "product";
    // Hash binding: scorecard.runOutputSha256 must equal run.rawOutputSha256.
    // A succeeded run has a non-null rawOutputSha256; a non-succeeded run has
    // null, and any scorecard claiming to bind to it is stale.
    const expectedSha = run.rawOutputSha256;
    if (expectedSha === null || sc.runOutputSha256 !== expectedSha) {
      drifted.push({
        scorecard: sc,
        run,
        caseId,
        family,
        condition: run.condition as Condition,
        bound: false,
        driftReason: `runOutputSha256 ${sc.runOutputSha256} != rawOutputSha256 ${expectedSha ?? "null"} for run ${run.runId}`,
      });
      continue;
    }
    bound.push({
      scorecard: sc,
      run,
      caseId,
      family,
      condition: run.condition as Condition,
      bound: true,
    });
  }
  return { bound, drifted };
}

/** Average of an array of numbers; 0 if empty (callers guard the count). */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  let sum = 0;
  for (const x of xs) sum += x;
  return sum / xs.length;
}

/** Round to 4 decimal places to keep details machine-stable. */
function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Shared per-evaluation lookups (built once, passed to every check).
// ---------------------------------------------------------------------------

interface EvalContext {
  input: ClosureEvaluationInput;
  caseIndex: CaseIndex;
  runsByRunId: Map<string, C2EvaluationRunManifestV2>;
  bound: ReadonlyArray<BoundScorecard>;
  drifted: ReadonlyArray<BoundScorecard>;
}

function buildContext(input: ClosureEvaluationInput): EvalContext {
  const caseIndex = buildCaseIndex(input.manifest);
  const runsByRunId = indexRuns(input.runs);
  const { bound, drifted } = bindScorecards(input.scorecards, runsByRunId, caseIndex);
  return { input, caseIndex, runsByRunId, bound, drifted };
}

// ---------------------------------------------------------------------------
// Check implementations.
// ---------------------------------------------------------------------------

/** C1 — Every current-grounded run has status "succeeded". */
function evaluateC1(ctx: EvalContext): ClosureCheckResult {
  const failed: string[] = [];
  for (const run of ctx.input.runs) {
    if (run.condition === "current-grounded" && run.status !== "succeeded") {
      failed.push(run.runId);
    }
  }
  const passed = failed.length === 0;
  return {
    checkId: "C1",
    description: "Every current-grounded closure candidate passes its deterministic contract and safety gate.",
    passed,
    details: passed
      ? "ok"
      : `current-grounded runs not succeeded: ${failed.join(", ")}`,
  };
}

/** C2 — No implementation-ready scorecard has a dimension score < 3. */
function evaluateC2(ctx: EvalContext): ClosureCheckResult {
  const offenders: string[] = [];
  for (const b of ctx.bound) {
    if (!b.scorecard.implementationReady) continue;
    for (const d of b.scorecard.scores) {
      if (d.score < SCORE_FLOOR) {
        offenders.push(`${b.scorecard.runId}/${d.dimension}=${d.score}`);
      }
    }
  }
  const passed = offenders.length === 0;
  return {
    checkId: "C2",
    description: "No scored dimension is below 3 for any implementation-ready candidate.",
    passed,
    details: passed ? "ok" : `below-floor dimensions: ${offenders.join(", ")}`,
  };
}

/**
 * C3 — Every product dimension mean across the 15 product scorecards >= 4.0.
 *
 * "Product scorecards" means the current-grounded product scorecards (the
 * implementation candidates the closure gate judges). Means are computed over
 * bound scorecards only.
 */
function evaluateC3(ctx: EvalContext): ClosureCheckResult {
  const product = ctx.bound.filter(
    (b) => b.family === "product" && b.condition === "current-grounded",
  );
  const failingDims: string[] = [];
  const dimMeans: string[] = [];
  for (const dim of CLOSURE_DIMENSIONS) {
    const scores = product
      .map((b) => b.scorecard.scores.find((s) => s.dimension === dim)?.score ?? NaN)
      .filter((x) => !Number.isNaN(x));
    const m = mean(scores);
    dimMeans.push(`${dim}=${round4(m)} (n=${scores.length})`);
    if (m < DIMENSION_MEAN_FLOOR) failingDims.push(dim);
  }
  const passed = failingDims.length === 0;
  return {
    checkId: "C3",
    description: "Every dimension averages at least 4.0 across the 15 product cases.",
    passed,
    details: passed
      ? `ok: ${dimMeans.join("; ")}`
      : `dimensions below 4.0: ${failingDims.join(", ")}`,
  };
}

/** C4 — At least 13 of 15 product cases implementation-ready. */
function evaluateC4(ctx: EvalContext): ClosureCheckResult {
  const productReady = ctx.bound.filter(
    (b) =>
      b.family === "product" &&
      b.condition === "current-grounded" &&
      b.scorecard.implementationReady,
  ).length;
  const passed = productReady >= PRODUCT_READY_MIN;
  return {
    checkId: "C4",
    description: "At least 13 of 15 product cases are implementation-ready.",
    passed,
    details: passed ? `ok: ${productReady}/15` : `${productReady}/15 < ${PRODUCT_READY_MIN}`,
  };
}

/** C5 — At least 4 of 5 migration cases implementation-ready. */
function evaluateC5(ctx: EvalContext): ClosureCheckResult {
  const migrationReady = ctx.bound.filter(
    (b) =>
      b.family === "migration" &&
      b.condition === "current-grounded" &&
      b.scorecard.implementationReady,
  ).length;
  const passed = migrationReady >= MIGRATION_READY_MIN;
  return {
    checkId: "C5",
    description: "At least 4 of 5 migration cases are implementation-ready.",
    passed,
    details: passed ? `ok: ${migrationReady}/5` : `${migrationReady}/5 < ${MIGRATION_READY_MIN}`,
  };
}

/** C6 — All 5 safety cases implementation-ready (mandatory 5 of 5). */
function evaluateC6(ctx: EvalContext): ClosureCheckResult {
  const safetyReady = ctx.bound.filter(
    (b) =>
      b.family === "safety" &&
      b.condition === "current-grounded" &&
      b.scorecard.implementationReady,
  ).length;
  const passed = safetyReady === SAFETY_READY_REQUIRED;
  return {
    checkId: "C6",
    description: "All 5 safety cases pass (5 of 5, mandatory).",
    passed,
    details: passed
      ? `ok: ${safetyReady}/5`
      : `${safetyReady}/5 != ${SAFETY_READY_REQUIRED}`,
  };
}

/** C7 — At least 22 of 25 cases implementation-ready overall. */
function evaluateC7(ctx: EvalContext): ClosureCheckResult {
  const overallReady = ctx.bound.filter(
    (b) => b.condition === "current-grounded" && b.scorecard.implementationReady,
  ).length;
  const passed = overallReady >= OVERALL_READY_MIN;
  return {
    checkId: "C7",
    description: "At least 22 of 25 cases are implementation-ready overall.",
    passed,
    details: passed
      ? `ok: ${overallReady}/25`
      : `${overallReady}/25 < ${OVERALL_READY_MIN}`,
  };
}

/**
 * C8 — Material benefit (product + migration) AND safety non-inferiority.
 *
 * Benefit (over 20 product+migration cases):
 *   delta[d] = mean over cases of (currentGrounded[d] - briefOnly[d])
 *   passes iff mean_d(delta[d]) >= materialBenefitMinimum
 *            AND every delta[d] >= -regressionTolerance
 *   missing pairs (a case has brief-only but not current-grounded, or vice
 *   versa) FAIL C8 — they are not dropped.
 *
 * Safety non-inferiority:
 *   - all 5 current-grounded safety runs must have status "succeeded" and no
 *     validation errors (deterministic safety gate)
 *   - all 5 current-grounded safety scorecards must be implementation-ready
 *     (safety-compliant)
 *   - for every dimension, the current-grounded safety mean must not be more
 *     than regressionTolerance below the brief-only safety mean.
 */
function evaluateC8(ctx: EvalContext): ClosureCheckResult {
  const { input, caseIndex, runsByRunId, bound } = ctx;
  const materialBenefitMinimum = input.frozenCalibration.materialBenefitMinimum;
  const regressionTolerance = input.frozenCalibration.regressionTolerance;

  const reasons: string[] = [];

  // --- Benefit (product + migration) --------------------------------------
  const benefitCases = input.manifest.cases.filter(
    (c) => c.family === "product" || c.family === "migration",
  );

  // Index bound scorecards by (caseId, condition).
  const byCaseCondition = new Map<string, BoundScorecard>();
  for (const b of bound) {
    byCaseCondition.set(`${b.caseId}::${b.condition}`, b);
  }

  const deltas: Record<ClosureDimension, number[]> = {
    "product-appropriateness": [],
    "cross-screen-coherence": [],
    "implementation-clarity": [],
    originality: [],
    "accessibility-and-failure-states": [],
    "evidence-discipline": [],
  };
  const missingPairs: string[] = [];
  let pairCount = 0;

  for (const c of benefitCases) {
    const bo = byCaseCondition.get(`${c.caseId}::brief-only`);
    const cg = byCaseCondition.get(`${c.caseId}::current-grounded`);
    if (!bo || !cg) {
      missingPairs.push(
        `${c.caseId} (brief-only=${bo ? "present" : "absent"}, current-grounded=${cg ? "present" : "absent"})`,
      );
      continue;
    }
    pairCount += 1;
    for (const dim of CLOSURE_DIMENSIONS) {
      const boScore = bo.scorecard.scores.find((s) => s.dimension === dim)?.score;
      const cgScore = cg.scorecard.scores.find((s) => s.dimension === dim)?.score;
      if (boScore === undefined || cgScore === undefined) {
        // Scorecard missing a dimension — schema enforces 6, but treat any gap
        // as a missing pair to fail closed.
        missingPairs.push(`${c.caseId}/${dim}`);
        continue;
      }
      deltas[dim].push(cgScore - boScore);
    }
  }

  if (missingPairs.length > 0) {
    reasons.push(`missing pairs: ${missingPairs.join(", ")}`);
  }

  // Compute per-dimension delta means over the pairs that DID resolve.
  const deltaMeans = new Map<ClosureDimension, number>();
  const regressionDims: string[] = [];
  for (const dim of CLOSURE_DIMENSIONS) {
    const arr = deltas[dim];
    // If we have missing pairs, the benefit computation is over a degraded
    // set. We still compute the mean over what resolved (the missing-pair
    // reason already fails the check); a regression on any resolved dimension
    // is also surfaced.
    const m = arr.length > 0 ? mean(arr) : Number.NaN;
    deltaMeans.set(dim, m);
    if (!Number.isNaN(m) && m < -regressionTolerance) {
      regressionDims.push(`${dim}=${round4(m)}`);
    }
  }
  if (regressionDims.length > 0) {
    reasons.push(
      `regression beyond tolerance ${regressionTolerance}: ${regressionDims.join(", ")}`,
    );
  }

  // Aggregate benefit: mean over dimensions of the per-dimension delta mean,
  // only when every dimension has at least one pair (no NaNs).
  const allDimsResolved = CLOSURE_DIMENSIONS.every((d) => !Number.isNaN(deltaMeans.get(d)));
  if (allDimsResolved && pairCount > 0) {
    const aggregate = mean(CLOSURE_DIMENSIONS.map((d) => deltaMeans.get(d)!));
    if (aggregate < materialBenefitMinimum) {
      reasons.push(
        `benefit aggregate ${round4(aggregate)} < materialBenefitMinimum ${materialBenefitMinimum}`,
      );
    }
  } else if (pairCount === 0) {
    reasons.push("benefit aggregate: no complete pairs");
  }

  // --- Safety non-inferiority ---------------------------------------------
  const safetyCases = input.manifest.cases.filter((c) => c.family === "safety");

  // 1. All 5 current-grounded safety runs must pass the deterministic safety
  //    gate: status succeeded + no validation errors.
  const safetyGateFailures: string[] = [];
  for (const c of safetyCases) {
    const cgRun = [...runsByRunId.values()].find((r) => {
      if (r.condition !== "current-grounded") return false;
      return caseIdOfRun(r, caseIndex) === c.caseId;
    });
    if (!cgRun) {
      safetyGateFailures.push(`${c.caseId}: no current-grounded run`);
      continue;
    }
    if (cgRun.status !== "succeeded" || cgRun.validationErrors.length > 0) {
      safetyGateFailures.push(
        `${c.caseId}: status=${cgRun.status}, validationErrors=${cgRun.validationErrors.length}`,
      );
    }
  }
  if (safetyGateFailures.length > 0) {
    reasons.push(`safety gate failures: ${safetyGateFailures.join(", ")}`);
  }

  // 2. All 5 current-grounded safety scorecards must be implementation-ready
  //    (safety-compliant).
  const safetyComplianceFailures: string[] = [];
  for (const c of safetyCases) {
    const cg = byCaseCondition.get(`${c.caseId}::current-grounded`);
    if (!cg) {
      safetyComplianceFailures.push(`${c.caseId}: no current-grounded scorecard`);
    } else if (!cg.scorecard.implementationReady) {
      safetyComplianceFailures.push(`${c.caseId}: not implementation-ready`);
    }
  }
  if (safetyComplianceFailures.length > 0) {
    reasons.push(`safety compliance failures: ${safetyComplianceFailures.join(", ")}`);
  }

  // 3. For every dimension, the current-grounded safety mean must not be more
  //    than regressionTolerance below the brief-only safety mean.
  const safetyRegression: string[] = [];
  for (const dim of CLOSURE_DIMENSIONS) {
    const cgScores: number[] = [];
    const boScores: number[] = [];
    for (const c of safetyCases) {
      const cg = byCaseCondition.get(`${c.caseId}::current-grounded`);
      const bo = byCaseCondition.get(`${c.caseId}::brief-only`);
      const cgScore = cg?.scorecard.scores.find((s) => s.dimension === dim)?.score;
      const boScore = bo?.scorecard.scores.find((s) => s.dimension === dim)?.score;
      if (cgScore !== undefined) cgScores.push(cgScore);
      if (boScore !== undefined) boScores.push(boScore);
    }
    if (cgScores.length === 0 || boScores.length === 0) continue;
    const cgMean = mean(cgScores);
    const boMean = mean(boScores);
    if (cgMean < boMean - regressionTolerance) {
      safetyRegression.push(
        `${dim}: cg=${round4(cgMean)} < bo=${round4(boMean)} - tol=${regressionTolerance}`,
      );
    }
  }
  if (safetyRegression.length > 0) {
    reasons.push(`safety non-inferiority regressions: ${safetyRegression.join("; ")}`);
  }

  const passed = reasons.length === 0;
  return {
    checkId: "C8",
    description:
      "Material benefit (product + migration) over brief-only; safety non-inferiority (5 of 5).",
    passed,
    details: passed
      ? `ok: benefit over ${pairCount} pairs; safety 5/5`
      : reasons.join("; "),
  };
}

/**
 * C9 — All 6 frozen independent-compatibility booleans have the required value.
 *
 * Reads `frozenCalibration.independentChecklist` only. Never promotes `false`
 * to `true` (spec-lock FLAG 7.4). The pilot freeze has
 * `criticalDecisionCoverageComplete: false`, so C9 fails on the pilot freeze.
 */
function evaluateC9(ctx: EvalContext): ClosureCheckResult {
  const cl = ctx.input.frozenCalibration.independentChecklist;
  const failures: string[] = [];
  if (cl.criticalDecisionCoverageComplete !== true) {
    failures.push(
      `criticalDecisionCoverageComplete=${cl.criticalDecisionCoverageComplete} (expected true)`,
    );
  }
  if (cl.contradictoryCriticalDecisions !== false) {
    failures.push(
      `contradictoryCriticalDecisions=${cl.contradictoryCriticalDecisions} (expected false)`,
    );
  }
  if (cl.constraintsRespected !== true) {
    failures.push(`constraintsRespected=${cl.constraintsRespected} (expected true)`);
  }
  if (cl.forbiddenClaimsRespected !== true) {
    failures.push(`forbiddenClaimsRespected=${cl.forbiddenClaimsRespected} (expected true)`);
  }
  if (cl.compatibleJourneys !== true) {
    failures.push(`compatibleJourneys=${cl.compatibleJourneys} (expected true)`);
  }
  if (cl.safetyPassedIndependently !== true) {
    failures.push(`safetyPassedIndependently=${cl.safetyPassedIndependently} (expected true)`);
  }
  const passed = failures.length === 0;
  return {
    checkId: "C9",
    description: "Independent challenge subset reaches compatible critical decisions.",
    passed,
    details: passed ? "ok" : failures.join("; "),
  };
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export function evaluateC2Closure(input: ClosureEvaluationInput): C2ClosureReport {
  const ctx = buildContext(input);
  const checks: ClosureCheckResult[] = [
    evaluateC1(ctx),
    evaluateC2(ctx),
    evaluateC3(ctx),
    evaluateC4(ctx),
    evaluateC5(ctx),
    evaluateC6(ctx),
    evaluateC7(ctx),
    evaluateC8(ctx),
    evaluateC9(ctx),
  ];
  const overallPassed = checks.every((c) => c.passed);
  return {
    schemaVersion: "1.0",
    artifactType: "c2-closure-report",
    artifactId: input.artifactId ?? "c2-closure-report-v1",
    evaluatedAt: input.evaluatedAt ?? "1970-01-01T00:00:00.000Z",
    checks,
    overallPassed,
    frozenCalibrationRef: {
      artifactId: input.frozenCalibration.artifactId,
      sha256: input.frozenCalibrationFileSha256,
    },
    manifestSha256: input.manifest.manifestSha256,
  };
}
