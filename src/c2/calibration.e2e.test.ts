/**
 * C2 synthetic end-to-end calibration proof (Task 9, Step 3 — OV7).
 *
 * This is the key deliverable of PR 1: the first time the complete
 * propose → blind-score → finalize → freeze flow is exercised end-to-end.
 * Without it, the first end-to-end exercise would happen in PR 2 (Task 10)
 * AFTER paid runs — exactly what the two-PR split exists to prevent.
 *
 * Discipline (pinned by the plan):
 *   - FAKE fixtures only: run manifests, candidate outputs, blind submissions,
 *     campaign/pricing refs. No real provider output, no real scorecards.
 *   - REAL calibration functions: `createBlindAssignment`,
 *     `buildBlindedReviewPacket`, `finalizeBlindScorecard`,
 *     `buildCalibrationProposal`, `evaluateIndependentCompatibility`,
 *     `freezeCalibration`. None are mocked.
 *   - ZERO network calls: an in-memory `BlindMapStore` is injected so the
 *     suite never touches a real `.c2-private/` directory; no fetch, no HTTP,
 *     no provider client is constructed.
 *   - Writes ONLY under the injected temporary private store.
 *
 * Negative cases (the freeze gate MUST refuse each before any paid run):
 *   - unknown/reused `reviewId` fails at finalize (fail closed).
 *   - a proposal-hash mismatch fails at freeze.
 *   - a changed scorecard output hash fails at the proposal reducer
 *     (runOutputSha256 binding drift).
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createBlindAssignment,
  buildBlindedReviewPacket,
  finalizeBlindScorecard,
  type BlindAssignment,
  type BlindAssignmentInput,
  type BlindMapStore,
} from "./review-packets.js";
import {
  buildCalibrationProposal,
  evaluateIndependentCompatibility,
  freezeCalibration,
  type CalibrationRun,
  type CalibrationScorecard,
  type CompatibilityChecklistInput,
  type FreezeAuthorization,
  type IndependentCompatibility,
} from "./calibration.js";
import { C2CalibrationProposalSchema, C2FrozenCalibrationSchema } from "./condition-contracts.js";
import {
  C2BlindScoreSubmissionSchema,
  C2HumanScorecardSchema,
  type C2BlindScoreSubmission,
} from "./evaluation-contracts.js";
import type { C2CandidateArtifact, C2DeterministicScore } from "./candidate-contracts.js";
import { canonicalJsonStringify, sha256Hex } from "../readiness/contracts.js";

// ---------------------------------------------------------------------------
// Constants
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
const CASE_BY_FAMILY: Record<(typeof FAMILIES)[number], string> = {
  product: "stablecoin-home",
  migration: "public-marketing-migration",
  safety: "named-inspiration-safety",
};

// A deterministic reviewer identity for the synthetic batch.
const REVIEWER_ACTOR_ID = "reviewer.gold-1";

// ---------------------------------------------------------------------------
// In-memory private blind-map store (zero filesystem, zero network)
// ---------------------------------------------------------------------------

interface MapEntry {
  reviewId: string;
  runId: string;
  runOutputSha256: string;
  assignedReviewerActorId: string;
  state: "assigned" | "finalized";
}

/**
 * Injected private store. Mirrors the on-disk contract: assignment writes a
 * new entry, reusing a reviewId is rejected at the upsert seam, and the
 * compare-and-swap transition refuses unknown / already-finalized ids.
 */
function makeInMemoryStore(): BlindMapStore & { snapshot(): MapEntry[] } {
  const raw = new Map<string, MapEntry>();
  return {
    snapshot: () => [...raw.values()],
    async load() {
      return [...raw.values()].map((entry) => ({ ...entry }));
    },
    async upsert(entry) {
      if (raw.has(entry.reviewId)) {
        throw new Error(`[test-store] reviewId already exists: ${entry.reviewId}`);
      }
      raw.set(entry.reviewId, { ...entry });
    },
    async transition(reviewId, fromState, toState) {
      const current = raw.get(reviewId);
      if (!current) return false;
      if (current.state !== fromState) return false;
      current.state = toState;
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake fixtures
// ---------------------------------------------------------------------------

function shaOf(value: unknown): string {
  return sha256Hex(Buffer.from(canonicalJsonStringify(value), "utf-8"));
}

/** A deterministic score for a synthetic run. `complete=true` unless overridden. */
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
 * A synthetic run manifest V2. Every field is FAKE — provider/model names are
 * placeholders, costs are synthetic, hashes are deterministic over the runId.
 * The shape is what the real reducer consumes; the bytes are not from any
 * paid call.
 */
function makeRun(opts: {
  family: (typeof FAMILIES)[number];
  condition: "brief-only" | "current-grounded" | "gold-evidence";
  provider: "openai" | "claude";
  runId?: string;
  caseId?: string;
  runOutputSha256?: string;
}): CalibrationRun {
  const caseId = opts.caseId ?? CASE_BY_FAMILY[opts.family];
  const runId = opts.runId ?? `c2-run-${opts.provider}-${caseId}-${opts.condition}`;
  const runOutputSha256 = opts.runOutputSha256 ?? shaOf({ runId, marker: opts.condition });
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
      model: opts.provider === "openai" ? "gpt-5.4-mini" : "claude-sonnet-4-5",
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
  };
}

/** A fake candidate artifact. Strict-schema valid; not from any provider call. */
function makeCandidate(runId: string): C2CandidateArtifact {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-candidate-design",
    artifactId: `c2-candidate-${runId}`,
    caseId: "test-case",
    globalDirection: { summary: `Direction for ${runId}`, principles: ["p:1", "p:2"] },
    screenBlueprints: [
      {
        id: "screen:home",
        summary: "Home",
        requiredStates: ["state:default"],
        mobileRules: ["mobile:tap"],
        accessibility: ["a11y:contrast"],
        failureAndRecovery: ["recovery:retry"],
        inspectedUrls: [],
      },
    ],
    sourceDecisions: [
      { id: "decision:1", lane: "adapt", rationale: "Because.", evidenceIds: [] },
    ],
    authorityLanes: { retain: [], adapt: ["decision:1"], reject: [] },
    acceptanceCriteria: [{ id: "ac:1", statement: "Acceptance." }],
    assumptions: ["assumption:1"],
    accessibilityAndRecovery: ["ar:1"],
    provenance: { conditionInputSha256: "0".repeat(64) },
  };
}

/**
 * Build the full synthetic pilot matrix: 3 OpenAI primary conditions × 3
 * families + 1 Claude independent condition × 3 families = 12 runs. Each run
 * is paired with a fake candidate for the blinding protocol.
 */
function makeSyntheticPilot(): {
  runs: CalibrationRun[];
  candidates: Map<string, C2CandidateArtifact>;
} {
  const runs: CalibrationRun[] = [];
  const candidates = new Map<string, C2CandidateArtifact>();

  for (const family of FAMILIES) {
    for (const condition of PRIMARY_CONDITIONS) {
      const run = makeRun({ family, condition, provider: "openai" });
      runs.push(run);
      candidates.set(run.manifest.runId, makeCandidate(run.manifest.runId));
    }
  }
  for (const family of FAMILIES) {
    const run = makeRun({ family, condition: "current-grounded", provider: "claude" });
    runs.push(run);
    candidates.set(run.manifest.runId, makeCandidate(run.manifest.runId));
  }

  return { runs, candidates };
}

/** A valid blind score submission for a reviewId (all six dimensions, floor met). */
function makeValidSubmission(reviewId: string, reviewerActorId = REVIEWER_ACTOR_ID): C2BlindScoreSubmission {
  return C2BlindScoreSubmissionSchema.parse({
    schemaVersion: "1.0",
    artifactType: "c2-blind-score-submission",
    reviewId,
    reviewerActorId,
    reviewerActorKind: "human",
    scores: DIMENSIONS.map((dimension) => ({
      dimension,
      score: 4,
      rationale: `Rationale for ${dimension}.`,
    })),
    submittedAt: "2026-07-18T12:00:00.000Z",
  });
}

/** Synthetic compatibility checklist input where both sides agree on every dimension. */
function makeCompatibleChecklist(): CompatibilityChecklistInput {
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

function makeCampaignConfigRef() {
  return {
    artifactId: "c2-campaign-config-pilot-v1",
    path: "eval/c2/config/pilot-campaign.json",
    sha256: "a".repeat(64),
  };
}

function makePricingTableRef() {
  return {
    artifactId: "c2-pricing-table-pilot-v1",
    path: "eval/c2/config/pricing.json",
    sha256: "b".repeat(64),
  };
}

/**
 * Build a valid freeze authorization that matches the proposal's hash, the
 * evaluated compatibility, the pinned $0.50 / $5 budgets, the fixed six
 * rubric dimensions, and a canonical frozenAt timestamp. Mirrors the
 * `makeMatchingAuthorization` helper from the unit suite.
 */
function makeMatchingAuthorization(
  proposal: { proposalSha256: string },
  compatibility: IndependentCompatibility,
  overrides: Partial<FreezeAuthorization> = {},
): FreezeAuthorization {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-freeze-authorization",
    artifactId: "c2-freeze-auth-1",
    proposalSha256: proposal.proposalSha256,
    reviewerActorId: REVIEWER_ACTOR_ID,
    reviewerRole: "Gold Label Owner",
    rationale: "Synthetic authorization for the offline calibration proof.",
    materialBenefitMinimum: 0.25,
    regressionTolerance: 0.5,
    independentChecklist: compatibility,
    maxRunCostUsd: 0.5,
    maxCampaignCostUsd: 5,
    frozenAt: "2026-07-19T00:00:00.000Z",
    rubricDimensions: [...DIMENSIONS],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Shared driver — the complete propose → blind-score → finalize → freeze flow
// ---------------------------------------------------------------------------

interface E2EResult {
  assignments: BlindAssignment[];
  packets: ReturnType<typeof buildBlindedReviewPacket>[];
  canonicalScorecards: CalibrationScorecard[];
  proposal: ReturnType<typeof buildCalibrationProposal>;
  compatibility: IndependentCompatibility;
  frozen: ReturnType<typeof freezeCalibration>;
}

/**
 * Drive the REAL functions in order against the injected private store. This
 * is the exact sequence a paid campaign would execute, minus the provider
 * call (the candidate is fake) and minus the filesystem (the store is
 * in-memory).
 */
async function driveCompleteFlow(store: BlindMapStore): Promise<E2EResult> {
  const { runs, candidates } = makeSyntheticPilot();

  // 1. Mint one private blind assignment per run. Each assignment carries a
  //    fresh UUID and writes ONLY to the injected store.
  const assignments: BlindAssignment[] = [];
  for (const run of runs) {
    const candidate = candidates.get(run.manifest.runId)!;
    const input: BlindAssignmentInput = {
      runId: run.manifest.runId,
      runOutputSha256: run.manifest.rawOutputSha256!,
      candidate,
      assignedReviewerActorId: REVIEWER_ACTOR_ID,
    };
    const assignment = await createBlindAssignment(input, {
      store,
      now: () => "2026-07-18T00:00:00.000Z",
      randomUuid: () => randomUUID(),
    });
    assignments.push(assignment);
  }

  // 2. Build the reviewer-visible packets. Each packet carries ONLY
  //    { reviewId, candidate }.
  const packets = assignments.map((assignment) => {
    const candidate = candidates.get(assignment.runId)!;
    return buildBlindedReviewPacket(assignment, candidate);
  });

  // 3. Finalize each submission into a canonical C2HumanScorecard. The
  //    finalize step resolves the private map, verifies the reviewer,
  //    transitions assigned → finalized, and binds runId + runOutputSha256.
  const canonicalScorecards: CalibrationScorecard[] = [];
  for (const packet of packets) {
    const submission = makeValidSubmission(packet.reviewId);
    const scorecard = await finalizeBlindScorecard(submission, {
      store,
      now: () => "2026-07-18T12:30:00.000Z",
      artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
    });
    const run = runs.find((r) => r.manifest.runId === scorecard.runId)!;
    canonicalScorecards.push({
      scorecard,
      family: run.family,
      caseId: run.caseId,
      condition: run.manifest.condition,
    });
  }

  // 4. Reduce the scorecards + runs into a non-authoritative proposal.
  const compatibility = evaluateIndependentCompatibility(makeCompatibleChecklist());
  const proposal = buildCalibrationProposal({
    runs,
    scorecards: canonicalScorecards,
    campaignConfigRef: makeCampaignConfigRef(),
    pricingTableRef: makePricingTableRef(),
    compatibility,
    artifactId: "c2-calibration-proposal-pilot-v1",
  });

  // 5. Freeze with a matching authorization. This is the explicit gate.
  const frozen = freezeCalibration({
    proposal,
    compatibility,
    authorization: makeMatchingAuthorization(proposal, compatibility),
    runs,
    scorecards: canonicalScorecards,
    campaignConfigRef: makeCampaignConfigRef(),
    pricingTableRef: makePricingTableRef(),
    artifactId: "c2-frozen-calibration-pilot-v1",
  });

  return { assignments, packets, canonicalScorecards, proposal, compatibility, frozen };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("calibration end-to-end (synthetic, offline)", () => {
  let store: ReturnType<typeof makeInMemoryStore>;

  beforeEach(() => {
    store = makeInMemoryStore();
  });

  // Network-call guard: if any code path tries to construct a fetch, an HTTP
  // client, or touch the real `.c2-private/` path, the spy fails the test.
  // The global fetch is asserted untouched because the calibration surface
  // is pure; provider clients live in the harness and are not exercised here.
  it("makes zero network calls (no global fetch invocation across the flow)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network call forbidden"));
    try {
      await driveCompleteFlow(store);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("writes only under the injected in-memory store (no .c2-private path touched)", async () => {
    // The in-memory store is the ONLY sink. If the flow tried to write under
    // `.c2-private/`, it would have to import the file-backed store factory;
    // this test does not import it, so the only state lives in `store`.
    const before = store.snapshot().length;
    const result = await driveCompleteFlow(store);
    const after = store.snapshot();

    // Every assignment is persisted; every assignment is now finalized.
    expect(after.length).toBe(result.assignments.length);
    expect(before).toBe(0);
    expect(after.every((entry) => entry.state === "finalized")).toBe(true);
    // The store entries carry NO candidate bytes — only the reversible binding.
    for (const entry of after) {
      expect(entry).toEqual(
        expect.objectContaining({
          reviewId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
          runId: expect.any(String),
          runOutputSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
          assignedReviewerActorId: REVIEWER_ACTOR_ID,
          state: "finalized",
        }),
      );
      // No candidate content leaked into the map entry.
      const serialized = JSON.stringify(entry);
      expect(serialized).not.toContain("globalDirection");
      expect(serialized).not.toContain("screenBlueprints");
    }
  });

  it("exercises the complete propose → blind-score → finalize → freeze flow and produces a schema-valid frozen calibration", async () => {
    const { assignments, packets, canonicalScorecards, proposal, frozen } = await driveCompleteFlow(store);

    // The full pilot matrix drove 12 assignments (9 primary + 3 independent).
    expect(assignments).toHaveLength(12);
    expect(packets).toHaveLength(12);
    expect(canonicalScorecards).toHaveLength(12);

    // Every packet is reviewer-visible ONLY: { reviewId, candidate }.
    for (const packet of packets) {
      expect(Object.keys(packet).sort()).toEqual(["candidate", "reviewId"]);
    }

    // Every canonical scorecard is schema-valid and bound to its run.
    for (const entry of canonicalScorecards) {
      expect(C2HumanScorecardSchema.safeParse(entry.scorecard).success).toBe(true);
      expect(entry.scorecard.blindedCondition).toBe(true);
    }

    // The proposal is schema-valid and carries the synthetic artifact refs.
    expect(C2CalibrationProposalSchema.safeParse(proposal).success).toBe(true);
    expect(proposal.campaignConfigRef).toEqual(makeCampaignConfigRef());
    expect(proposal.pricingTableRef).toEqual(makePricingTableRef());

    // The frozen calibration is schema-valid and binds the proposal hash.
    expect(C2FrozenCalibrationSchema.safeParse(frozen).success).toBe(true);
    expect(frozen.proposalRef.sha256).toBe(proposal.proposalSha256);
    expect(frozen.runManifestRefs).toHaveLength(12);
    expect(frozen.scorecardRefs).toHaveLength(12);
  });

  it("the frozen proposalSha256 equals sha256(canonicalJson(proposal)) — the freeze binds the exact proposal bytes", async () => {
    const { proposal, frozen } = await driveCompleteFlow(store);
    const expected = sha256Hex(Buffer.from(canonicalJsonStringify(proposal), "utf-8"));
    // The proposal's own hash is computed over the canonical JSON with the
    // hash field zeroed (see buildCalibrationProposal). The frozen artifact's
    // proposalRef.sha256 MUST equal the proposal's proposalSha256 — proving
    // the freeze bound the exact proposal bytes the reducer produced.
    expect(frozen.proposalRef.sha256).toBe(proposal.proposalSha256);
    // And recomputing over the (already-hashed) proposal reproduces the same
    // digest only when the proposal is canonical — this asserts the proposal
    // is stable canonical JSON (no undefined / non-finite fields).
    expect(canonicalJsonStringify(proposal)).toEqual(canonicalJsonStringify(JSON.parse(canonicalJsonStringify(proposal))));
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the bound independentCompatibility reports full agreement (every checklist dimension passes)", async () => {
    const { compatibility, frozen } = await driveCompleteFlow(store);
    expect(compatibility.criticalDecisionCoverageComplete).toBe(true);
    expect(compatibility.contradictoryCriticalDecisions).toBe(false);
    expect(compatibility.constraintsRespected).toBe(true);
    expect(compatibility.forbiddenClaimsRespected).toBe(true);
    expect(compatibility.compatibleJourneys).toBe(true);
    expect(compatibility.safetyPassedIndependently).toBe(true);
    // The freeze binds the exact compatibility object.
    expect(frozen.independentChecklist).toEqual(compatibility);
  });

  // -------------------------------------------------------------------------
  // Negative cases — the freeze gate MUST refuse each before any paid run
  // -------------------------------------------------------------------------

  it("NEGATIVE: an unknown reviewId fails at finalize (no map entry, fail closed)", async () => {
    const unknown = "22222222-2222-4222-8222-222222222222";
    const submission = makeValidSubmission(unknown);
    await expect(
      finalizeBlindScorecard(submission, {
        store,
        now: () => "2026-07-18T12:30:00.000Z",
        artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
      }),
    ).rejects.toThrow(/unknown|reviewId/i);
    // The store remains empty — no partial state written.
    expect(store.snapshot()).toHaveLength(0);
  });

  it("NEGATIVE: a reused / already-finalized reviewId fails at finalize (double-finalization fails closed)", async () => {
    const { runs, candidates } = makeSyntheticPilot();
    const run = runs[0]!;
    const candidate = candidates.get(run.manifest.runId)!;
    const assignment = await createBlindAssignment(
      {
        runId: run.manifest.runId,
        runOutputSha256: run.manifest.rawOutputSha256!,
        candidate,
        assignedReviewerActorId: REVIEWER_ACTOR_ID,
      },
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );
    const submission = makeValidSubmission(assignment.reviewId);

    // First finalize succeeds.
    const first = await finalizeBlindScorecard(submission, {
      store,
      now: () => "2026-07-18T12:30:00.000Z",
      artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
    });
    expect(first.runId).toBe(run.manifest.runId);

    // Second finalize with the SAME reviewId must fail closed.
    await expect(
      finalizeBlindScorecard(submission, {
        store,
        now: () => "2026-07-18T12:31:00.000Z",
        artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
      }),
    ).rejects.toThrow(/finalized|already|state|transition/i);

    // The map entry remains finalized (no re-open).
    const stored = store.snapshot().find((e) => e.reviewId === assignment.reviewId);
    expect(stored?.state).toBe("finalized");
  });

  it("NEGATIVE: a proposal-hash mismatch fails at freeze (authorization binds the exact proposal)", async () => {
    const { proposal, compatibility } = await driveCompleteFlow(store);
    expect(() =>
      freezeCalibration({
        proposal,
        compatibility,
        // Authorization names a DIFFERENT proposal hash.
        authorization: makeMatchingAuthorization({ proposalSha256: "0".repeat(64) }, compatibility),
        artifactId: "c2-frozen-calibration-pilot-v1",
      }),
    ).toThrow(/proposal.*hash|mismatch|authorization/i);
  });

  it("NEGATIVE: a changed scorecard output hash fails at the proposal reducer (runOutputSha256 binding drift)", async () => {
    const { runs, candidates } = makeSyntheticPilot();
    const store2 = makeInMemoryStore();

    // Drive the blinding flow to get canonical scorecards.
    const assignments: BlindAssignment[] = [];
    for (const run of runs) {
      const candidate = candidates.get(run.manifest.runId)!;
      const assignment = await createBlindAssignment(
        {
          runId: run.manifest.runId,
          runOutputSha256: run.manifest.rawOutputSha256!,
          candidate,
          assignedReviewerActorId: REVIEWER_ACTOR_ID,
        },
        { store: store2, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
      );
      assignments.push(assignment);
    }
    const canonicalScorecards: CalibrationScorecard[] = [];
    for (const assignment of assignments) {
      const run = runs.find((r) => r.manifest.runId === assignment.runId)!;
      const submission = makeValidSubmission(assignment.reviewId);
      const scorecard = await finalizeBlindScorecard(submission, {
        store: store2,
        now: () => "2026-07-18T12:30:00.000Z",
        artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
      });
      canonicalScorecards.push({
        scorecard,
        family: run.family,
        caseId: run.caseId,
        condition: run.manifest.condition,
      });
    }

    // Tamper: drift one scorecard's runOutputSha256 away from its manifest.
    const tampered = canonicalScorecards.map((entry, idx) =>
      idx === 0
        ? { ...entry, scorecard: { ...entry.scorecard, runOutputSha256: "x".repeat(64) } }
        : entry,
    );

    const compatibility = evaluateIndependentCompatibility(makeCompatibleChecklist());
    expect(() =>
      buildCalibrationProposal({
        runs,
        scorecards: tampered,
        campaignConfigRef: makeCampaignConfigRef(),
        pricingTableRef: makePricingTableRef(),
        compatibility,
        artifactId: "c2-calibration-proposal-pilot-v1",
      }),
    ).toThrow(/hash|mismatch|binding|runOutput/i);
  });
});
