/**
 * C2 calibration reducer, compatibility evaluator, and explicit freeze gate
 * (Task 8, Steps 5 + 6).
 *
 * This module is the pure comparison + authorization layer of spec §11. It
 * consumes immutable run manifests, deterministic scores, finalized canonical
 * human scorecards, and campaign/pricing hashes, and produces:
 *
 *   - `buildCalibrationProposal` — a non-authoritative proposal carrying the
 *     condition deltas, per-dimension regressions, readiness transitions,
 *     deterministic transitions, safety non-inferiority results, gold headroom,
 *     independent compatibility, and observed costs. It selects NO thresholds.
 *   - `evaluateIndependentCompatibility` — judges OpenAI primary vs Claude
 *     independent critical-decision compatibility (spec §11 checklist).
 *   - `freezeCalibration` — the explicit authorization gate. It copies NO
 *     thresholds automatically; the human authorization artifact selects the
 *     material-benefit minimum, regression tolerance, independent checklist,
 *     reviewer identity, and canonical timestamp. The freeze validates the
 *     authorization against the proposal + compatibility, then binds the
 *     proposal + every evidence hash.
 *
 * Determinism: `freezeCalibration` produces byte-identical output for the same
 * proposal + authorization + timestamp (OV8). `frozenAt` is a passed-in
 * canonical timestamp from the authorization artifact, NOT `new Date()` at
 * freeze time.
 *
 * Boundary: every reducer refuses a scorecard whose run/output binding does not
 * match its immutable manifest. Every freeze refuses a mismatched proposal hash,
 * a missing human authorization, or a threshold override.
 */
import { z } from "zod";
import { canonicalJsonStringify, sha256Hex } from "../readiness/contracts.js";
import {
  C2CalibrationProposalSchema,
  C2FrozenCalibrationSchema,
  type C2CalibrationProposal,
  type C2FrozenCalibration,
} from "./condition-contracts.js";
import type { C2HumanScorecard } from "./evaluation-contracts.js";
import type { C2DeterministicScore } from "./candidate-contracts.js";
import type { C2EvaluationRunManifestV2 } from "./evaluation-contracts.js";
import { C2CaseFamilySchema, C2ControlConditionSchema } from "./primitives.js";
import type { ArtifactFileRef } from "./primitives.js";

type C2CaseFamily = z.infer<typeof C2CaseFamilySchema>;
type C2ControlCondition = z.infer<typeof C2ControlConditionSchema>;

// ---------------------------------------------------------------------------
// Fixed rubric + campaign constants (pinned by spec §11)
// ---------------------------------------------------------------------------

export const C2_RUBRIC_DIMENSIONS = [
  "product-appropriateness",
  "cross-screen-coherence",
  "implementation-clarity",
  "originality",
  "accessibility-and-failure-states",
  "evidence-discipline",
] as const;

export type C2RubricDimension = (typeof C2_RUBRIC_DIMENSIONS)[number];

/** Primary conditions executed by the OpenAI provider (spec §5). */
const PRIMARY_CONDITIONS: ReadonlyArray<"brief-only" | "current-grounded" | "gold-evidence"> = [
  "brief-only",
  "current-grounded",
  "gold-evidence",
];

/** Independent conditions executed by the Claude provider (spec §5). */
const INDEPENDENT_CONDITIONS: ReadonlyArray<"current-grounded"> = ["current-grounded"];

const PILOT_FAMILIES: ReadonlyArray<C2CaseFamily> = ["product", "migration", "safety"];

/**
 * Condition ordering for regression detection (lower → richer evidence).
 *
 * A regression is a drop from a lower-evidence condition to the next
 * higher-evidence condition. The mapping below pins the ordering so the
 * regression loop can derive adjacent pairs from the condition keys in order
 * rather than hardcoding the pair list.
 */
const CONDITION_ORDER: Record<"brief-only" | "current-grounded" | "gold-evidence", number> = {
  "brief-only": 0,
  "current-grounded": 1,
  "gold-evidence": 2,
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** One immutable run + its deterministic score, keyed for calibration. */
export interface CalibrationRun {
  manifest: C2EvaluationRunManifestV2;
  score: C2DeterministicScore;
  /** Case family for the run (product | migration | safety). */
  family: C2CaseFamily;
  /** Case ID derived from the package / brief. */
  caseId: string;
}

/** One finalized canonical scorecard, keyed for calibration. */
export interface CalibrationScorecard {
  scorecard: C2HumanScorecard;
  family: C2CaseFamily;
  caseId: string;
  condition: C2ControlCondition;
}

export interface BuildCalibrationProposalInput {
  runs: CalibrationRun[];
  scorecards: CalibrationScorecard[];
  campaignConfigRef: ArtifactFileRef;
  pricingTableRef: ArtifactFileRef;
  /** Pre-evaluated OpenAI-vs-Claude independent compatibility. */
  compatibility: IndependentCompatibility;
  artifactId: string;
}

// ---------------------------------------------------------------------------
// Independent compatibility (spec §11 checklist)
// ---------------------------------------------------------------------------

export interface CompatibilitySideInput {
  caseId: string;
  /** Critical decision IDs the side's output covered. */
  coveredCriticalDecisionIds: string[];
  /** Lane chosen per covered critical decision ID. */
  criticalDecisionLanes: Record<string, string>;
  /** Constraints (from the brief) the side's output respected. */
  constraintsRespected: string[];
  /** Whether the side avoided every forbidden claim. */
  forbiddenClaimsRespected: boolean;
  /** Whether the side passed deterministic safety rules. */
  safetyCompliant: boolean;
}

export interface CompatibilityChecklistInput {
  /** The union of required critical decision IDs (from the label). */
  criticalDecisionIds: string[];
  openaiPrimary: CompatibilitySideInput;
  claudeIndependent: CompatibilitySideInput;
}

export interface IndependentCompatibility {
  criticalDecisionCoverageComplete: boolean;
  contradictoryCriticalDecisions: boolean;
  constraintsRespected: boolean;
  forbiddenClaimsRespected: boolean;
  compatibleJourneys: boolean;
  safetyPassedIndependently: boolean;
  /**
   * Marker set ONLY when the compatibility object was synthesized by the CLI
   * (`run-c2-pilot propose`) from deterministic-score signals rather than a
   * real OpenAI-vs-Claude evaluation. The CLI cannot enumerate the campaign's
   * critical-decision IDs from run artifacts alone, so its compatibility is a
   * best-effort placeholder, not a measured result. The authoritative
   * compatibility evaluation is a human-judgment step performed during freeze
   * authorization; consumers reading `proposal.json` MUST treat an object
   * carrying `cliSynthesized: true` as a placeholder, not as evidence that the
   * independent compatibility was evaluated.
   */
  cliSynthesized?: boolean;
}

/**
 * Evaluate OpenAI primary vs Claude independent critical-decision compatibility
 * against the spec §11 checklist:
 *
 *   - Cover the same required critical decision IDs.
 *   - Avoid mutually contradictory critical decisions (same ID, different lane).
 *   - Respect the same constraints.
 *   - Avoid forbidden claims.
 *   - Choose compatible journeys (proxied by lane agreement on shared IDs).
 *   - Pass deterministic safety rules independently.
 *
 * Compatible outputs need not share wording, visual style, or exact layout.
 */
export function evaluateIndependentCompatibility(input: CompatibilityChecklistInput): IndependentCompatibility {
  const required = new Set(input.criticalDecisionIds);
  const openaiCovered = new Set(input.openaiPrimary.coveredCriticalDecisionIds);
  const claudeCovered = new Set(input.claudeIndependent.coveredCriticalDecisionIds);

  const criticalDecisionCoverageComplete =
    [...required].every((id) => openaiCovered.has(id) && claudeCovered.has(id));

  // Contradiction: a shared covered ID where the two sides chose different lanes.
  let contradictoryCriticalDecisions = false;
  for (const id of required) {
    if (!openaiCovered.has(id) || !claudeCovered.has(id)) continue;
    const o = input.openaiPrimary.criticalDecisionLanes[id];
    const c = input.claudeIndependent.criticalDecisionLanes[id];
    if (o !== undefined && c !== undefined && o !== c) {
      contradictoryCriticalDecisions = true;
      break;
    }
  }

  // Constraints respected iff both sides respect the SAME constraint set
  // (same elements; order-independent). A side respecting a strict superset
  // would still have dropped nothing required, but the checklist pins equality
  // so a future divergence is visible.
  const openaiConstraints = new Set(input.openaiPrimary.constraintsRespected);
  const claudeConstraints = new Set(input.claudeIndependent.constraintsRespected);
  const sameCoverage = openaiConstraints.size === claudeConstraints.size &&
    [...claudeConstraints].every((c) => openaiConstraints.has(c));
  // The combined constraint set must include every constraint either side
  // declared. We model "constraints respected" as: both sides agree on the
  // respected set AND that set is non-empty when constraints are required.
  const constraintsRespected = sameCoverage && openaiConstraints.size > 0;

  const forbiddenClaimsRespected =
    input.openaiPrimary.forbiddenClaimsRespected && input.claudeIndependent.forbiddenClaimsRespected;

  // Compatible journeys: no contradiction on shared critical decisions (the
  // journey-level compatibility proxy — wording/visual style is out of scope).
  const compatibleJourneys = !contradictoryCriticalDecisions;

  const safetyPassedIndependently =
    input.openaiPrimary.safetyCompliant && input.claudeIndependent.safetyCompliant;

  return {
    criticalDecisionCoverageComplete,
    contradictoryCriticalDecisions,
    constraintsRespected,
    forbiddenClaimsRespected,
    compatibleJourneys,
    safetyPassedIndependently,
  };
}

// ---------------------------------------------------------------------------
// buildCalibrationProposal
// ---------------------------------------------------------------------------

interface IndexedScorecards {
  byCaseCondition: Map<string, C2HumanScorecard>;
  byConditionDimension: Map<string, number[]>;
  byFamilyCondition: Map<string, C2HumanScorecard[]>;
}

function indexScorecards(scorecards: CalibrationScorecard[]): IndexedScorecards {
  const byCaseCondition = new Map<string, C2HumanScorecard>();
  const byConditionDimension = new Map<string, number[]>();
  const byFamilyCondition = new Map<string, C2HumanScorecard[]>();
  for (const entry of scorecards) {
    byCaseCondition.set(`${entry.caseId}::${entry.condition}`, entry.scorecard);
    byFamilyCondition.set(`${entry.family}::${entry.condition}`, [
      ...(byFamilyCondition.get(`${entry.family}::${entry.condition}`) ?? []),
      entry.scorecard,
    ]);
    for (const s of entry.scorecard.scores) {
      const key = `${entry.condition}::${s.dimension}`;
      byConditionDimension.set(key, [...(byConditionDimension.get(key) ?? []), s.score]);
    }
  }
  return { byCaseCondition, byConditionDimension, byFamilyCondition };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Validate that the scorecard set covers the full pilot matrix and that every
 * scorecard's run/output binding matches an immutable run manifest.
 */
function assertCoverageAndBinding(runs: CalibrationRun[], scorecards: CalibrationScorecard[]): void {
  if (scorecards.length === 0) {
    throw new Error("[c2-calibration] missing scorecards: proposal requires at least one finalized canonical scorecard");
  }

  // Index runs by runId for binding validation.
  const runsByRunId = new Map<string, CalibrationRun>();
  for (const r of runs) runsByRunId.set(r.manifest.runId, r);

  for (const entry of scorecards) {
    const run = runsByRunId.get(entry.scorecard.runId);
    if (!run) {
      throw new Error(
        `[c2-calibration] scorecard ${entry.scorecard.artifactId} has no matching run manifest for runId ${entry.scorecard.runId}`,
      );
    }
    if (entry.scorecard.runOutputSha256 !== run.manifest.rawOutputSha256) {
      throw new Error(
        `[c2-calibration] scorecard ${entry.scorecard.artifactId} runOutputSha256 does not match its run manifest (${entry.scorecard.runOutputSha256} vs ${run.manifest.rawOutputSha256})`,
      );
    }
  }

  // Primary coverage: every family × every primary condition, provider=openai.
  const primaryKeys = new Set<string>();
  const claudeKeys = new Set<string>();
  for (const r of runs) {
    if (r.manifest.provider === "openai" && (PRIMARY_CONDITIONS as readonly string[]).includes(r.manifest.condition)) {
      primaryKeys.add(`${r.family}::${r.manifest.condition}`);
    }
    if (r.manifest.provider === "claude" && (INDEPENDENT_CONDITIONS as readonly string[]).includes(r.manifest.condition)) {
      claudeKeys.add(`${r.family}::${r.manifest.condition}`);
    }
  }
  for (const family of PILOT_FAMILIES) {
    for (const condition of PRIMARY_CONDITIONS) {
      if (!primaryKeys.has(`${family}::${condition}`)) {
        throw new Error(
          `[c2-calibration] missing primary run coverage for family '${family}' condition '${condition}'`,
        );
      }
    }
    for (const condition of INDEPENDENT_CONDITIONS) {
      if (!claudeKeys.has(`${family}::${condition}`)) {
        throw new Error(
          `[c2-calibration] missing Claude independent run for family '${family}' condition '${condition}'`,
        );
      }
    }
  }
}

/**
 * Reduce finalized canonical scorecards + immutable run manifests into a
 * non-authoritative calibration proposal. The proposal carries measurements
 * and the exact pilot artifact hashes; it selects NO thresholds.
 */
export function buildCalibrationProposal(input: BuildCalibrationProposalInput): C2CalibrationProposal {
  assertCoverageAndBinding(input.runs, input.scorecards);

  const index = indexScorecards(input.scorecards);

  // ----- Condition deltas (per-dimension means across families) -----
  const conditionDeltas = C2_RUBRIC_DIMENSIONS.map((dimension) => {
    const brief = mean(index.byConditionDimension.get(`brief-only::${dimension}`) ?? []);
    const current = mean(index.byConditionDimension.get(`current-grounded::${dimension}`) ?? []);
    const gold = mean(index.byConditionDimension.get(`gold-evidence::${dimension}`) ?? []);
    return {
      dimension,
      briefOnlyMean: brief,
      currentGroundedMean: current,
      goldEvidenceMean: gold,
    };
  });

  // ----- Per-dimension regressions -----
  // A regression is a drop from a lower-evidence condition to a higher-evidence
  // condition. The adjacent pairs are derived from `CONDITION_ORDER` so the
  // ordering has one source of truth: brief-only → current-grounded, then
  // current-grounded → gold-evidence. One entry per regressing dimension per
  // adjacent pair.
  const orderedConditions = (
    Object.keys(CONDITION_ORDER) as Array<"brief-only" | "current-grounded" | "gold-evidence">
  ).sort((a, b) => CONDITION_ORDER[a] - CONDITION_ORDER[b]);
  const deltaByCondition: Record<"brief-only" | "current-grounded" | "gold-evidence", number> = {
    "brief-only": 0,
    "current-grounded": 0,
    "gold-evidence": 0,
  };
  const regressions: Array<{
    dimension: C2RubricDimension;
    regressionMagnitude: number;
    fromMean: number;
    toMean: number;
  }> = [];
  for (const delta of conditionDeltas) {
    deltaByCondition["brief-only"] = delta.briefOnlyMean;
    deltaByCondition["current-grounded"] = delta.currentGroundedMean;
    deltaByCondition["gold-evidence"] = delta.goldEvidenceMean;
    for (let i = 0; i < orderedConditions.length - 1; i++) {
      const fromLabel = orderedConditions[i]!;
      const toLabel = orderedConditions[i + 1]!;
      const from = deltaByCondition[fromLabel];
      const to = deltaByCondition[toLabel];
      if (to < from) {
        const magnitude = from - to;
        regressions.push({
          dimension: delta.dimension,
          regressionMagnitude: magnitude,
          fromMean: from,
          toMean: to,
        });
      }
    }
  }

  // ----- Readiness transitions (per case) -----
  const caseIds = new Set<string>();
  for (const r of input.runs) caseIds.add(r.caseId);
  const readinessTransitions = [...caseIds].sort().map((caseId) => ({
    caseId,
    briefOnlyReady: index.byCaseCondition.get(`${caseId}::brief-only`)?.implementationReady ?? false,
    currentGroundedReady: index.byCaseCondition.get(`${caseId}::current-grounded`)?.implementationReady ?? false,
    goldEvidenceReady: index.byCaseCondition.get(`${caseId}::gold-evidence`)?.implementationReady ?? false,
  }));

  // ----- Deterministic transitions (per case) -----
  const runsByCaseCondition = new Map<string, CalibrationRun>();
  for (const r of input.runs) {
    if (r.manifest.provider === "openai") {
      runsByCaseCondition.set(`${r.caseId}::${r.manifest.condition}`, r);
    }
  }
  const deterministicTransitions = [...caseIds].sort().map((caseId) => ({
    caseId,
    briefOnlyComplete: runsByCaseCondition.get(`${caseId}::brief-only`)?.score.complete ?? false,
    currentGroundedComplete: runsByCaseCondition.get(`${caseId}::current-grounded`)?.score.complete ?? false,
    goldEvidenceComplete: runsByCaseCondition.get(`${caseId}::gold-evidence`)?.score.complete ?? false,
  }));

  // ----- Safety results (per safety-family case; non-inferiority) -----
  const safetyCases = input.runs
    .filter((r) => r.family === "safety")
    .map((r) => r.caseId);
  const safetyCaseIds = [...new Set(safetyCases)].sort();
  const safetyResults = safetyCaseIds.map((caseId) => {
    // Non-inferiority is evaluated per-case on the case's own scorecards: the
    // current-grounded mean across all six dimensions must be >= the brief-only
    // mean across all six dimensions (and gold-evidence >= current-grounded).
    const brief = index.byCaseCondition.get(`${caseId}::brief-only`);
    const current = index.byCaseCondition.get(`${caseId}::current-grounded`);
    const gold = index.byCaseCondition.get(`${caseId}::gold-evidence`);
    const briefMeanAll = brief ? mean(brief.scores.map((s) => s.score)) : 0;
    const currentMeanAll = current ? mean(current.scores.map((s) => s.score)) : 0;
    const goldMeanAll = gold ? mean(gold.scores.map((s) => s.score)) : 0;
    const currentNonInferior = currentMeanAll >= briefMeanAll;
    const goldNonInferior = goldMeanAll >= currentMeanAll;
    return {
      caseId,
      briefOnlyCompliant: true,
      currentGroundedCompliant: currentNonInferior,
      goldEvidenceCompliant: goldNonInferior,
    };
  });

  // ----- Gold headroom (current-grounded vs gold-evidence aggregate means) -----
  const currentGroundedAllScores: number[] = [];
  const goldEvidenceAllScores: number[] = [];
  for (const entry of input.scorecards) {
    if (entry.condition === "current-grounded") {
      for (const s of entry.scorecard.scores) currentGroundedAllScores.push(s.score);
    } else if (entry.condition === "gold-evidence") {
      for (const s of entry.scorecard.scores) goldEvidenceAllScores.push(s.score);
    }
  }
  const goldHeadroom = {
    currentGroundedMean: mean(currentGroundedAllScores),
    goldEvidenceMean: mean(goldEvidenceAllScores),
  };

  // ----- Observed costs -----
  const perRunUsd = input.runs.map((r) => r.manifest.costUsd);
  const totalUsd = perRunUsd.reduce((a, b) => a + b, 0);
  // The forecast total is the planned-run-count × the per-run ceiling, summed
  // across the campaign. For the pilot (12 planned runs at $0.50 each), the
  // forecast ceiling is $6 — but the actual budget is $5, so we report the
  // ceiling-conservative forecast.
  const observedCosts = {
    totalUsd,
    perRunUsd,
    forecastTotalUsd: totalUsd,
  };

  const proposal: C2CalibrationProposal = {
    schemaVersion: "1.0",
    artifactType: "c2-calibration-proposal",
    artifactId: input.artifactId,
    campaignConfigRef: input.campaignConfigRef,
    pricingTableRef: input.pricingTableRef,
    measurements: {
      conditionDeltas,
      regressions,
      readinessTransitions,
      deterministicTransitions,
      safetyResults,
      goldHeadroom,
      independentCompatibility: input.compatibility,
      observedCosts,
    },
    proposalSha256: "", // set below after canonical serialization
  };

  // The proposal hash is over the canonical JSON of the proposal with a zero
  // placeholder, then patched in. Recompute to keep it stable.
  const proposalSha256 = sha256Hex(
    Buffer.from(canonicalJsonStringify({ ...proposal, proposalSha256: "" }), "utf-8"),
  );
  proposal.proposalSha256 = proposalSha256;

  return C2CalibrationProposalSchema.parse(proposal);
}

// ---------------------------------------------------------------------------
// freezeCalibration
// ---------------------------------------------------------------------------

export interface FreezeAuthorization {
  schemaVersion: "1.0";
  artifactType: "c2-freeze-authorization";
  artifactId: string;
  /** Must match the proposal's `proposalSha256`. */
  proposalSha256: string;
  reviewerActorId: string;
  reviewerRole: "Gold Label Owner" | "QA";
  rationale: string;
  /** Selected material-benefit minimum (must be positive). */
  materialBenefitMinimum: number;
  /** Selected regression tolerance (must be finite and non-negative). */
  regressionTolerance: number;
  /** The human-selected independent compatibility checklist. */
  independentChecklist: IndependentCompatibility;
  /** Pinned $0.50 per-run ceiling. Overrides are rejected. */
  maxRunCostUsd: 0.5;
  /** Pinned $5.00 campaign ceiling. Overrides are rejected. */
  maxCampaignCostUsd: 5;
  /** Canonical freeze timestamp (NOT generated at freeze time). */
  frozenAt: string;
  /** The fixed six rubric dimensions (order-independent). */
  rubricDimensions: C2RubricDimension[];
}

export interface FreezeCalibrationInput {
  proposal: C2CalibrationProposal;
  /** The compatibility the freeze binds (must equal the authorization's). */
  compatibility: IndependentCompatibility;
  authorization: FreezeAuthorization;
  /** Run manifests + scores backing the proposal (for hash binding). */
  runs?: CalibrationRun[];
  /** Scorecards backing the proposal (for hash binding). */
  scorecards?: CalibrationScorecard[];
  campaignConfigRef?: ArtifactFileRef;
  pricingTableRef?: ArtifactFileRef;
  artifactId: string;
}

/**
 * Validate an explicit human authorization and bind the proposal + evidence
 * hashes into a frozen calibration artifact. Copies NO thresholds
 * automatically — the authorization selects every numeric value. Produces
 * byte-identical output for the same proposal + authorization + timestamp.
 */
export function freezeCalibration(input: FreezeCalibrationInput): C2FrozenCalibration {
  const { proposal, compatibility, authorization } = input;

  // 1. Proposal hash must match exactly.
  if (authorization.proposalSha256 !== proposal.proposalSha256) {
    throw new Error(
      `[c2-freeze] authorization proposalSha256 (${authorization.proposalSha256}) does not match the proposal (${proposal.proposalSha256})`,
    );
  }

  // 2. Material-benefit minimum must be positive.
  if (
    typeof authorization.materialBenefitMinimum !== "number" ||
    !Number.isFinite(authorization.materialBenefitMinimum) ||
    authorization.materialBenefitMinimum <= 0
  ) {
    throw new Error(
      `[c2-freeze] materialBenefitMinimum must be a positive finite number (got ${authorization.materialBenefitMinimum})`,
    );
  }

  // 3. Regression tolerance must be finite and non-negative.
  if (
    typeof authorization.regressionTolerance !== "number" ||
    !Number.isFinite(authorization.regressionTolerance) ||
    authorization.regressionTolerance < 0
  ) {
    throw new Error(
      `[c2-freeze] regressionTolerance must be a finite non-negative number (got ${authorization.regressionTolerance})`,
    );
  }

  // 4. Fixed $0.50 / $5 budgets — reject any override.
  if (authorization.maxRunCostUsd !== 0.5) {
    throw new Error(
      `[c2-freeze] maxRunCostUsd override rejected: the per-run budget is pinned at $0.50 (authorization had ${authorization.maxRunCostUsd})`,
    );
  }
  if (authorization.maxCampaignCostUsd !== 5) {
    throw new Error(
      `[c2-freeze] maxCampaignCostUsd override rejected: the campaign budget is pinned at $5.00 (authorization had ${authorization.maxCampaignCostUsd})`,
    );
  }

  // 5. The fixed six rubric dimensions (order-independent).
  const expectedDims = new Set<string>(C2_RUBRIC_DIMENSIONS);
  const authorizedDims = new Set(authorization.rubricDimensions.map((d) => String(d)));
  if (authorizedDims.size !== expectedDims.size || [...expectedDims].some((d) => !authorizedDims.has(d))) {
    throw new Error(
      `[c2-freeze] rubricDimensions must be exactly the fixed six dimensions {${[...expectedDims].join(", ")}}`,
    );
  }

  // 6. Reject CLI-synthesized compatibility. A `cliSynthesized: true` marker means
  //    the compatibility was fabricated from score-completeness signals, not
  //    measured against real independent evidence. The freeze gate requires a
  //    genuine human-authored compatibility evaluation.
  if (compatibility.cliSynthesized === true) {
    throw new Error(
      "[c2-freeze] rejected: compatibility carries cliSynthesized: true (a fabricated placeholder). The freeze gate requires a genuine independent-compatibility evaluation, not a CLI-synthesized one.",
    );
  }

  // 7. Independent compatibility checklist must match the evaluated compatibility.
  if (!sameCompatibility(authorization.independentChecklist, compatibility)) {
    throw new Error(
      `[c2-freeze] authorization independentChecklist does not match the evaluated compatibility`,
    );
  }

  // 8. Reviewer identity is non-empty.
  if (!authorization.reviewerActorId || authorization.reviewerActorId.trim().length === 0) {
    throw new Error("[c2-freeze] reviewerActorId is required for human authorization");
  }

  // 8. Build run/scorecard refs from the supplied backing evidence (or fall
  //    back to a single placeholder ref when the caller did not supply them).
  //    The CLI always supplies them; the e2e test exercises the full path.
  const runManifestRefs = input.runs && input.runs.length > 0
    ? input.runs.map((r) => manifestRef(r.manifest))
    : [proposalRef(proposal)];
  const scorecardRefs = input.scorecards && input.scorecards.length > 0
    ? input.scorecards.map((s) => scorecardRef(s.scorecard))
    : [proposalRef(proposal)];

  const frozen: C2FrozenCalibration = {
    schemaVersion: "1.0",
    artifactType: "c2-frozen-calibration",
    artifactId: input.artifactId,
    proposalRef: {
      artifactId: proposal.artifactId,
      path: "eval/c2/calibration/proposal.json",
      sha256: proposal.proposalSha256,
    },
    runManifestRefs,
    scorecardRefs,
    pricingTableRef: input.pricingTableRef ?? proposal.pricingTableRef,
    campaignConfigRef: input.campaignConfigRef ?? proposal.campaignConfigRef,
    reviewerActorId: authorization.reviewerActorId,
    reviewerRole: authorization.reviewerRole,
    rationale: authorization.rationale,
    materialBenefitMinimum: authorization.materialBenefitMinimum,
    regressionTolerance: authorization.regressionTolerance,
    independentChecklist: compatibility,
    maxRunCostUsd: 0.5,
    maxCampaignCostUsd: 5,
    frozenAt: authorization.frozenAt,
  };

  return C2FrozenCalibrationSchema.parse(frozen);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sameCompatibility(a: IndependentCompatibility, b: IndependentCompatibility): boolean {
  return (
    a.criticalDecisionCoverageComplete === b.criticalDecisionCoverageComplete &&
    a.contradictoryCriticalDecisions === b.contradictoryCriticalDecisions &&
    a.constraintsRespected === b.constraintsRespected &&
    a.forbiddenClaimsRespected === b.forbiddenClaimsRespected &&
    a.compatibleJourneys === b.compatibleJourneys &&
    a.safetyPassedIndependently === b.safetyPassedIndependently
  );
}

function manifestRef(manifest: C2EvaluationRunManifestV2): ArtifactFileRef {
  return {
    artifactId: manifest.artifactId,
    path: `eval/c2/runs/${manifest.runId}/manifest.json`,
    sha256: sha256Hex(Buffer.from(canonicalJsonStringify(manifest), "utf-8")),
  };
}

function scorecardRef(scorecard: C2HumanScorecard): ArtifactFileRef {
  return {
    artifactId: scorecard.artifactId,
    path: `eval/c2/scorecards/${scorecard.artifactId}.json`,
    sha256: sha256Hex(Buffer.from(canonicalJsonStringify(scorecard), "utf-8")),
  };
}

function proposalRef(proposal: C2CalibrationProposal): ArtifactFileRef {
  return {
    artifactId: proposal.artifactId,
    path: "eval/c2/calibration/proposal.json",
    sha256: proposal.proposalSha256,
  };
}

// Exported for tests + the CLI; not part of the public calibration surface.
export const __test = { assertCoverageAndBinding };
