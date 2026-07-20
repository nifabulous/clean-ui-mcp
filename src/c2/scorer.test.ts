import { describe, expect, it } from "vitest";
import {
  C2DeterministicScoreSchema,
  type C2CandidateArtifact,
} from "./candidate-contracts.js";
import type { C2CaseBrief, C2DecisionLabel } from "./case-contracts.js";
import type { C2ConditionInput } from "./condition-contracts.js";
import { scoreC2Candidate, type ScoreC2CandidateInput } from "./scorer.js";

const SHA_64 = "a".repeat(64);
const ARTIFACT_ID = "c2-candidate-stablecoin-home-v1";
const RUN_ID = "run-stablecoin-brief-only-001";
const RUN_OUTPUT_SHA = SHA_64;
const SCORER_SHA = SHA_64;

// ─────────────────────────────────────────────────────────────────────────────
// Complete C2 fixture. The candidate, brief, label, and condition input all
// agree: every required screen/state/mobile rule is present, every required
// decision id is carried, every required acceptance criterion is present, all
// cited evidence is supplied, every lane is permitted, no forbidden text leaks,
// and the provenance hash matches the condition input's inputSha256.
// ─────────────────────────────────────────────────────────────────────────────

function completeBrief(): C2CaseBrief {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-case-brief",
    artifactId: "c2-brief-stablecoin-home",
    caseId: "stablecoin-home",
    caseVersion: 1,
    family: "product",
    stratum: "saas-dashboard",
    title: "Stablecoin home dashboard brief",
    productContext: "Reserve-backed stablecoin wallet home.",
    users: ["wallet-holder", "compliance-reviewer"],
    jobs: ["see-balance", "understand-reserve-backing"],
    platform: "responsive-web",
    requiredJourneys: ["open-home", "drill-into-reserves"],
    constraints: ["constraint.a11y-contrast-floor"],
    requiredScreens: [
      {
        id: "screen.home",
        states: ["state.loading", "state.empty"],
        mobileRules: ["mobile.bottom-tab"],
      },
    ],
    sourceSnapshotRef: null,
  };
}

function completeLabel(): C2DecisionLabel {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-decision-label",
    artifactId: "c2-label-stablecoin-home",
    caseId: "stablecoin-home",
    caseVersion: 1,
    labelVersion: 2,
    requiredSections: [
      "globalDirection",
      "screenBlueprints",
      "sourceDecisions",
      "authorityLanes",
      "acceptanceCriteria",
      "assumptions",
      "accessibilityAndRecovery",
      "provenance",
    ],
    requiredDecisionIds: ["decision.audience-hierarchy"],
    requiredAcceptanceCriteria: ["criterion.home-renders-loading-state"],
    permittedAuthorityLanes: ["retain", "adapt", "reject"],
    validEvidenceIds: ["evidence.business-hierarchy"],
    goldEvidenceIds: ["evidence.business-hierarchy"],
    forbiddenClaims: ["claim.icon-only", "claim.pixel-perfect"],
    privateMarkers: ["token.stablecoin-internal-secret"],
    rubricAnchors: [
      {
        dimension: "product-appropriateness",
        score1: "s1",
        score3: "s3",
        score5: "s5",
      },
      {
        dimension: "cross-screen-coherence",
        score1: "s1",
        score3: "s3",
        score5: "s5",
      },
      {
        dimension: "implementation-clarity",
        score1: "s1",
        score3: "s3",
        score5: "s5",
      },
      {
        dimension: "originality",
        score1: "s1",
        score3: "s3",
        score5: "s5",
      },
      {
        dimension: "accessibility-and-failure-states",
        score1: "s1",
        score3: "s3",
        score5: "s5",
      },
      {
        dimension: "evidence-discipline",
        score1: "s1",
        score3: "s3",
        score5: "s5",
      },
    ],
    adjudicationNotes: ["note.pilot-scope"],
  };
}

// Brief-only's evidence array is empty by contract. A brief-grounded decision
// cites no corpus evidence; its `evidenceIds` MUST therefore be empty too, or
// the scorer would flag the citations as unresolved.
function completeCandidateObject(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-candidate-design",
    artifactId: ARTIFACT_ID,
    caseId: "stablecoin-home",
    globalDirection: {
      summary: "Lead with the reserve-backed stability story.",
      principles: ["principle.trust-first", "principle.clarity"],
    },
    screenBlueprints: [
      {
        id: "screen.home",
        summary: "Stablecoin home dashboard.",
        requiredStates: ["state.loading", "state.empty"],
        mobileRules: ["mobile.bottom-tab"],
        accessibility: ["a11y.contrast-aaa"],
        failureAndRecovery: ["failure.offline-retry"],
        inspectedUrls: ["https://example.com/reference/home"],
      },
    ],
    sourceDecisions: [
      {
        id: "decision.audience-hierarchy",
        lane: "retain",
        rationale: "Audience hierarchy remains the canonical ordering.",
        evidenceIds: [],
      },
    ],
    authorityLanes: {
      retain: ["decision.audience-hierarchy"],
      adapt: [],
      reject: [],
    },
    acceptanceCriteria: [
      {
        id: "criterion.home-renders-loading-state",
        statement: "Home must render a loading state before data resolves.",
      },
    ],
    assumptions: ["assumption.pilot-scope"],
    accessibilityAndRecovery: ["a11y.focus-trap", "recovery.retry-bounded"],
    provenance: { conditionInputSha256: SHA_64 },
  };
}

function briefOnlyCondition(): C2ConditionInput {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-condition-input",
    artifactId: "c2-condition-input-brief-only",
    casePackageRef: {
      artifactId: "c2-package-stablecoin-home",
      path: "eval/c2/stablecoin-home/package.json",
      sha256: SHA_64,
    },
    briefRef: {
      artifactId: "c2-brief-stablecoin-home",
      path: "eval/c2/stablecoin-home/brief.json",
      sha256: SHA_64,
    },
    sourceSnapshotRefs: [],
    inputSha256: SHA_64,
    condition: "brief-only",
    evidence: [],
    corpusSha256: null,
    retrievalIndexSha256: null,
    retrieval: null,
  } as C2ConditionInput;
}

export function completeInput(): ScoreC2CandidateInput {
  return {
    artifactId: ARTIFACT_ID,
    runId: RUN_ID,
    runOutputSha256: RUN_OUTPUT_SHA,
    scorerSha256: SCORER_SHA,
    candidate: completeCandidateObject(),
    brief: completeBrief(),
    label: completeLabel(),
    conditionInput: briefOnlyCondition(),
  };
}

/**
 * Apply a named mutation to a fresh complete fixture. Each mutation isolates a
 * single closure rule so the corresponding score field flips independently.
 */
function mutate(name: string): ScoreC2CandidateInput {
  const base = completeInput();
  switch (name) {
    case "missing-required-state": {
      // Drop a brief-required state from the blueprint's requiredStates.
      const candidate = structuredClone(base.candidate) as Record<string, unknown>;
      const blueprints = candidate.screenBlueprints as Array<Record<string, unknown>>;
      blueprints[0] = {
        ...blueprints[0],
        requiredStates: ["state.loading"], // "state.empty" dropped
      };
      return { ...base, candidate };
    }
    case "missing-mobile-rule": {
      // The candidate already carries `mobile.bottom-tab`, so the only way to
      // isolate the missing-mobile-rule closure is to tighten the brief so it
      // requires a DIFFERENT rule (`mobile.sticky-cta`) the candidate does not
      // carry. The candidate is left untouched.
      const brief = { ...base.brief };
      brief.requiredScreens = [
        {
          id: "screen.home",
          states: ["state.loading", "state.empty"],
          mobileRules: ["mobile.bottom-tab", "mobile.sticky-cta"],
        },
      ];
      return { ...base, brief };
    }
    case "missing-decision-id": {
      // Drop the required decision entirely.
      const candidate = structuredClone(base.candidate) as Record<string, unknown>;
      candidate.sourceDecisions = [
        {
          id: "decision.other",
          lane: "retain",
          rationale: "A non-required decision.",
          evidenceIds: [],
        },
      ];
      candidate.authorityLanes = {
        retain: ["decision.other"],
        adapt: [],
        reject: [],
      };
      return { ...base, candidate };
    }
    case "ghost-evidence": {
      // Cite exactly one evidence id that is NOT in the supplied condition
      // input. Under brief-only the supplied evidence set is empty, so citing
      // the single ghost id yields unresolvedEvidenceCount === 1 (isolating the
      // mutation to one count).
      const candidate = structuredClone(base.candidate) as Record<string, unknown>;
      candidate.sourceDecisions = [
        {
          id: "decision.audience-hierarchy",
          lane: "retain",
          rationale: "Audience hierarchy remains the canonical ordering.",
          evidenceIds: ["evidence.ghost-unsupplied"],
        },
      ];
      return { ...base, candidate };
    }
    case "wrong-lane": {
      // Use a lane the label does not permit (label permits all three, so shrink
      // the label to adapt-only and keep the decision on retain).
      const label = { ...base.label, permittedAuthorityLanes: ["adapt"] };
      return { ...base, label };
    }
    case "nested-private-marker": {
      // Inject a private marker deep inside a blueprint summary so the canonical
      // serialization must catch it (mutation: countForbiddenText).
      const candidate = structuredClone(base.candidate) as Record<string, unknown>;
      const blueprints = candidate.screenBlueprints as Array<Record<string, unknown>>;
      blueprints[0] = {
        ...blueprints[0],
        summary: "Dashboard summary leaks token.stablecoin-internal-secret here.",
      };
      return { ...base, candidate };
    }
    case "wrong-input-hash": {
      // Condition input hash no longer matches candidate provenance.
      const conditionInput = {
        ...base.conditionInput,
        inputSha256: "b".repeat(64),
      } as C2ConditionInput;
      return { ...base, conditionInput };
    }
    default:
      throw new Error(`unknown mutation: ${name}`);
  }
}

describe("scoreC2Candidate: closure mutations", () => {
  it("scores the complete fixture as complete: true", () => {
    expect(scoreC2Candidate(completeInput()).complete).toBe(true);
  });

  it("mutation: missing-required-state → complete false", () => {
    expect(scoreC2Candidate(mutate("missing-required-state")).complete).toBe(false);
  });

  it("mutation: missing-mobile-rule → complete false", () => {
    expect(scoreC2Candidate(mutate("missing-mobile-rule")).complete).toBe(false);
  });

  it("mutation: missing-decision-id → requiredDecisionCoverage < 1", () => {
    expect(
      scoreC2Candidate(mutate("missing-decision-id")).requiredDecisionCoverage,
    ).toBeLessThan(1);
  });

  it("mutation: ghost-evidence → unresolvedEvidenceCount 1", () => {
    expect(scoreC2Candidate(mutate("ghost-evidence")).unresolvedEvidenceCount).toBe(1);
  });

  it("mutation: wrong-lane → unsupportedClaimCount 1", () => {
    expect(scoreC2Candidate(mutate("wrong-lane")).unsupportedClaimCount).toBe(1);
  });

  it("mutation: nested-private-marker → forbiddenDisclosureCount 1", () => {
    expect(
      scoreC2Candidate(mutate("nested-private-marker")).forbiddenDisclosureCount,
    ).toBe(1);
  });

  it("mutation: wrong-input-hash → provenanceMismatch true", () => {
    expect(scoreC2Candidate(mutate("wrong-input-hash")).provenanceMismatch).toBe(true);
  });
});

describe("scoreC2Candidate: condition-aware citations", () => {
  it("brief-only accepts a brief-grounded decision with no corpus citations", () => {
    const input = completeInput();
    const score = scoreC2Candidate(input);
    expect(score.complete).toBe(true);
    expect(score.unresolvedEvidenceCount).toBe(0);
  });

  it("brief-only rejects a decision that cites unsupplied evidence", () => {
    // The ghost-evidence mutation cites exactly one unsupplied id, so the
    // unresolved count is 1 (not the number of citations on the decision).
    const input = mutate("ghost-evidence");
    const score = scoreC2Candidate(input);
    expect(score.complete).toBe(false);
    expect(score.unresolvedEvidenceCount).toBe(1);
  });

  it("grounded condition accepts only supplied evidence ids", () => {
    // Switch the same complete candidate onto a current-grounded condition input
    // that DOES supply the cited evidence. Citing a supplied id is fine; citing
    // an unsupplied one is still flagged.
    const base = completeInput();
    const grounded = {
      ...base.conditionInput,
      condition: "current-grounded",
      evidence: [
        {
          id: "evidence.business-hierarchy",
          authorityLane: "retain",
          sourceType: "corpus-entry",
          sourceArtifactId: "corpus.stablecoin-research",
          sourceSha256: SHA_64,
          contentSha256: SHA_64,
          rank: 1,
          score: 0.92,
        },
      ],
      corpusSha256: SHA_64,
      retrievalIndexSha256: SHA_64,
      retrieval: {
        query: "stablecoin home hierarchy",
        configurationSha256: SHA_64,
        rankedResult: [
          {
            entryId: "corpus.stablecoin-research",
            rank: 1,
            score: 0.92,
            contentSha256: SHA_64,
          },
        ],
        selectedEntryIds: ["corpus.stablecoin-research"],
      },
    } as unknown as C2ConditionInput;

    // The candidate must now actually cite the supplied evidence id to prove
    // the grounded path accepts supplied evidence.
    const candidate = structuredClone(base.candidate) as Record<string, unknown>;
    candidate.sourceDecisions = [
      {
        id: "decision.audience-hierarchy",
        lane: "retain",
        rationale: "Audience hierarchy remains the canonical ordering.",
        evidenceIds: ["evidence.business-hierarchy"],
      },
    ];

    const ok = scoreC2Candidate({ ...base, candidate, conditionInput: grounded });
    expect(ok.unresolvedEvidenceCount).toBe(0);
    expect(ok.complete).toBe(true);

    // And citing an UNSUPPLIED id under the grounded condition still flags.
    const badCandidate = structuredClone(candidate) as Record<string, unknown>;
    (badCandidate.sourceDecisions as Array<Record<string, unknown>>)[0].evidenceIds = [
      "evidence.unsupplied",
    ];
    const bad = scoreC2Candidate({ ...base, candidate: badCandidate, conditionInput: grounded });
    expect(bad.unresolvedEvidenceCount).toBe(1);
    expect(bad.complete).toBe(false);
  });
});

describe("scoreC2Candidate: schema boundary", () => {
  it("throws before scoring when a blueprint has an empty accessibility array", () => {
    const input = completeInput();
    const candidate = structuredClone(input.candidate) as Record<string, unknown>;
    (candidate.screenBlueprints as Array<Record<string, unknown>>)[0].accessibility = [];
    expect(() => scoreC2Candidate({ ...input, candidate })).toThrow();
  });

  it("throws before scoring when a blueprint has an empty failureAndRecovery array", () => {
    const input = completeInput();
    const candidate = structuredClone(input.candidate) as Record<string, unknown>;
    (candidate.screenBlueprints as Array<Record<string, unknown>>)[0].failureAndRecovery = [];
    expect(() => scoreC2Candidate({ ...input, candidate })).toThrow();
  });

  it("succeeds and normalizes an empty inspectedUrls array to []", () => {
    const input = completeInput();
    const candidate = structuredClone(input.candidate) as Record<string, unknown>;
    (candidate.screenBlueprints as Array<Record<string, unknown>>)[0].inspectedUrls = [];
    const score = scoreC2Candidate({ ...input, candidate });
    // The scorer parses the candidate through the schema, so the normalized []
    // survives; the candidate parses and scoring proceeds to completion.
    expect(score.complete).toBe(true);
  });

  it("binds the run/scorer provenance fields onto the returned score", () => {
    const score = scoreC2Candidate(completeInput());
    expect(score.artifactId).toBe(ARTIFACT_ID);
    expect(score.runId).toBe(RUN_ID);
    expect(score.runOutputSha256).toBe(RUN_OUTPUT_SHA);
    expect(score.scorerSha256).toBe(SCORER_SHA);
    expect(score.schemaVersion).toBe("1.0");
    expect(score.artifactType).toBe("c2-deterministic-score");
  });

  it("returns a score that round-trips through C2DeterministicScoreSchema", () => {
    const score = scoreC2Candidate(completeInput());
    expect(C2DeterministicScoreSchema.safeParse(score).success).toBe(true);
  });
});

// Reference the imports so they remain part of the public surface even if a
// future refactor moves types around.
export type { C2CandidateArtifact };
