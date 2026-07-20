import { describe, expect, it } from "vitest";
import { C2CandidateArtifactSchema, C2DeterministicScoreSchema } from "./candidate-contracts.js";

const SHA_64 = "a".repeat(64);

function screenBlueprint(overrides: Record<string, unknown> = {}) {
  return {
    id: "screen.home",
    summary: "Stablecoin home dashboard.",
    requiredStates: ["state.loading", "state.empty"],
    mobileRules: ["mobile.bottom-tab"],
    accessibility: ["a11y.contrast-aaa"],
    failureAndRecovery: ["failure.offline-retry"],
    inspectedUrls: ["https://example.com/reference/home"],
    ...overrides,
  };
}

function sourceDecision(overrides: Record<string, unknown> = {}) {
  return {
    id: "decision.audience-hierarchy",
    lane: "retain",
    rationale: "Audience hierarchy remains the canonical ordering.",
    evidenceIds: ["evidence.business-hierarchy"],
    ...overrides,
  };
}

function acceptanceCriterion(overrides: Record<string, unknown> = {}) {
  return {
    id: "criterion.home-renders-loading-state",
    statement: "Home must render a loading state before data resolves.",
    ...overrides,
  };
}

export function validCandidate() {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-candidate-design",
    artifactId: "c2-candidate-stablecoin-home-v1",
    caseId: "stablecoin-home",
    globalDirection: {
      summary: "Lead with the reserve-backed stability story.",
      principles: ["principle.trust-first", "principle.clarity"],
    },
    screenBlueprints: [screenBlueprint()],
    sourceDecisions: [sourceDecision()],
    authorityLanes: {
      retain: ["decision.audience-hierarchy"],
      adapt: [],
      reject: [],
    },
    acceptanceCriteria: [acceptanceCriterion()],
    assumptions: ["assumption.pilot-scope"],
    accessibilityAndRecovery: ["a11y.focus-trap", "recovery.retry-bounded"],
    provenance: { conditionInputSha256: SHA_64 },
  };
}

export function validScore() {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-deterministic-score",
    artifactId: "c2-score-stablecoin-home-v1",
    runId: "run-001",
    runOutputSha256: SHA_64,
    scorerSha256: SHA_64,
    complete: true,
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

describe("C2CandidateArtifactSchema", () => {
  it("parses a complete valid candidate", () => {
    expect(C2CandidateArtifactSchema.safeParse(validCandidate()).success).toBe(true);
  });

  it("rejects a reviewer-only label smuggled onto the candidate", () => {
    expect(
      C2CandidateArtifactSchema.safeParse({ ...validCandidate(), reviewerLabel: {} }).success,
    ).toBe(false);
  });

  it("rejects an empty accessibility array on a screen blueprint", () => {
    const candidate = {
      ...validCandidate(),
      screenBlueprints: [
        { ...validCandidate().screenBlueprints[0], accessibility: [] },
      ],
    };
    expect(C2CandidateArtifactSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects an empty failureAndRecovery array on a screen blueprint", () => {
    const candidate = {
      ...validCandidate(),
      screenBlueprints: [
        { ...validCandidate().screenBlueprints[0], failureAndRecovery: [] },
      ],
    };
    expect(C2CandidateArtifactSchema.safeParse(candidate).success).toBe(false);
  });

  it("accepts an empty inspectedUrls array and defaults missing inspectedUrls to []", () => {
    const withEmpty = {
      ...validCandidate(),
      screenBlueprints: [
        { ...validCandidate().screenBlueprints[0], inspectedUrls: [] },
      ],
    };
    expect(C2CandidateArtifactSchema.safeParse(withEmpty).success).toBe(true);

    const { inspectedUrls: _removed, ...withoutField } = validCandidate().screenBlueprints[0];
    const omitted = { ...validCandidate(), screenBlueprints: [{ ...withoutField }] };
    const parsed = C2CandidateArtifactSchema.safeParse(omitted);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.screenBlueprints[0].inspectedUrls).toEqual([]);
    }
  });

  it("rejects duplicate screen blueprint IDs", () => {
    const candidate = {
      ...validCandidate(),
      screenBlueprints: [screenBlueprint({ id: "screen.dup" }), screenBlueprint({ id: "screen.dup" })],
    };
    expect(C2CandidateArtifactSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects duplicate source decision IDs", () => {
    const candidate = {
      ...validCandidate(),
      sourceDecisions: [
        sourceDecision({ id: "decision.dup" }),
        sourceDecision({ id: "decision.dup" }),
      ],
    };
    expect(C2CandidateArtifactSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects duplicate acceptance criteria IDs", () => {
    const candidate = {
      ...validCandidate(),
      acceptanceCriteria: [
        acceptanceCriterion({ id: "criterion.dup" }),
        acceptanceCriterion({ id: "criterion.dup" }),
      ],
    };
    expect(C2CandidateArtifactSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects duplicate evidence IDs within a single decision", () => {
    const candidate = {
      ...validCandidate(),
      sourceDecisions: [
        sourceDecision({ evidenceIds: ["evidence.dup", "evidence.dup"] }),
      ],
    };
    expect(C2CandidateArtifactSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects an unknown authority lane", () => {
    const candidate = {
      ...validCandidate(),
      sourceDecisions: [sourceDecision({ lane: "invent" })],
    };
    expect(C2CandidateArtifactSchema.safeParse(candidate).success).toBe(false);
  });

  it("rejects an unknown top-level field via strict parsing", () => {
    expect(
      C2CandidateArtifactSchema.safeParse({ ...validCandidate(), surpriseField: 1 }).success,
    ).toBe(false);
  });

  it("rejects a malformed condition-input provenance hash", () => {
    const candidate = {
      ...validCandidate(),
      provenance: { conditionInputSha256: "not-a-sha" },
    };
    expect(C2CandidateArtifactSchema.safeParse(candidate).success).toBe(false);
  });

  it("requires at least one screen blueprint, decision, and acceptance criterion", () => {
    expect(
      C2CandidateArtifactSchema.safeParse({ ...validCandidate(), screenBlueprints: [] }).success,
    ).toBe(false);
    expect(
      C2CandidateArtifactSchema.safeParse({ ...validCandidate(), sourceDecisions: [] }).success,
    ).toBe(false);
    expect(
      C2CandidateArtifactSchema.safeParse({ ...validCandidate(), acceptanceCriteria: [] }).success,
    ).toBe(false);
  });
});

describe("C2DeterministicScoreSchema", () => {
  it("parses a complete score", () => {
    expect(C2DeterministicScoreSchema.safeParse(validScore()).success).toBe(true);
  });

  it("rejects a coverage value outside [0,1]", () => {
    expect(
      C2DeterministicScoreSchema.safeParse({ ...validScore(), requiredSectionCoverage: 1.5 }).success,
    ).toBe(false);
  });

  it("rejects a negative count", () => {
    expect(
      C2DeterministicScoreSchema.safeParse({ ...validScore(), unsupportedClaimCount: -1 }).success,
    ).toBe(false);
  });

  it("rejects an unknown field via strict parsing", () => {
    expect(
      C2DeterministicScoreSchema.safeParse({ ...validScore(), bonusField: true }).success,
    ).toBe(false);
  });
});
