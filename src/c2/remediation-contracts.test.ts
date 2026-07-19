import { describe, expect, it } from "vitest";
import { canonicalJsonStringify, sha256Hex } from "../readiness/contracts.js";
import {
  C2RetagProposalSchema,
  C2RetagReviewSchema,
  C2CanaryResultSchema,
  assertProposalMatchesFailure,
} from "./remediation-contracts.js";
import type { C2FailureReport } from "./evaluation-contracts.js";

const SHA_64 = "a".repeat(64);
const SHA_40 = "b".repeat(40);

function fileRef(artifactId: string, path: string, sha256: string = SHA_64) {
  return { artifactId, path, sha256 };
}

function hashOf(value: unknown): string {
  return sha256Hex(new TextEncoder().encode(canonicalJsonStringify(value)));
}

// ---------------------------------------------------------------------------
// Failure report fixture (a label-classified failure that a retag can target)
// ---------------------------------------------------------------------------

function makeFailureReport(): C2FailureReport {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-failure-report",
    artifactId: "c2-failure-v1",
    caseId: "stablecoin-home",
    currentGroundedRunRef: fileRef("c2-run-current-v1", "corpus/c2/runs/current-grounded.json"),
    goldEvidenceRunRef: fileRef("c2-run-gold-v1", "corpus/c2/runs/gold-evidence.json"),
    correctedLabelRunRef: fileRef("c2-run-corrected-v1", "corpus/c2/runs/corrected-label.json"),
    classification: "label",
    affectedDecisionIds: ["decision.audience-hierarchy"],
    affectedEntryIds: ["entry.repro-1"],
    affectedFieldPaths: ["categories"],
    evidence: ["evidence.audit-trail"],
    rationale: "A label inconsistency was found and corrected.",
    classifiedByActorId: "reviewer.qa-1",
    classifiedAt: "2026-07-18T13:00:00.000Z",
  } as C2FailureReport;
}

// ---------------------------------------------------------------------------
// Retag proposal factory
// ---------------------------------------------------------------------------

const PROPOSED_VALUE = ["navigation", "layout"];

function makeRetagProposal(overrides: Partial<Record<string, unknown>> = {}) {
  const failure = makeFailureReport();
  return {
    schemaVersion: "1.0" as const,
    artifactType: "c2-retag-proposal" as const,
    artifactId: "c2-retag-proposal-v1",
    proposalVersion: 1,
    failureReport: fileRef(failure.artifactId, "corpus/c2/failures/label.json"),
    failureClassification: "label" as const,
    entryId: "entry.repro-1",
    fieldPath: "categories",
    preChangeEntrySha256: SHA_64,
    oldValueCanonicalSha256: hashOf(["layout", "navigation"]),
    proposedValue: PROPOSED_VALUE,
    proposedValueCanonicalSha256: hashOf(PROPOSED_VALUE),
    evidenceIds: ["evidence.audit-trail"],
    affectedCaseIds: ["stablecoin-home"],
    rationale: "Categories were misordered and omitted navigation intent.",
    generatorFingerprintSha256: SHA_64,
    ...overrides,
  };
}

function makeReview(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: "1.0" as const,
    artifactType: "c2-retag-review" as const,
    artifactId: "c2-retag-review-v1",
    proposalArtifactId: "c2-retag-proposal-v1",
    proposalSha256: SHA_64,
    actorId: "reviewer.gold-1",
    actorKind: "human" as const,
    decision: "approved" as const,
    rationale: "Correction is faithful to the gold-label evidence.",
    reviewedAt: "2026-07-18T15:00:00.000Z",
    ...overrides,
  };
}

function makeCanary(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: "1.0" as const,
    artifactType: "c2-canary-result" as const,
    artifactId: "c2-canary-result-v1",
    approvedReviewRefs: [fileRef("c2-retag-review-v1", "corpus/c2/reviews/retag.json")],
    beforeCorpusSha256: SHA_64,
    afterCorpusSha256: SHA_64,
    affectedCaseRunRefs: [fileRef("c2-run-canary-v1", "corpus/c2/runs/canary.json")],
    rollback: { snapshotSha256: SHA_64, restoredCorpusSha256: SHA_64, verified: true },
    expansionDecision: "approved" as const,
    ...overrides,
  };
}

describe("C2 remediation contracts", () => {
  it("parses a valid retag proposal, review, and canary result", () => {
    expect(C2RetagProposalSchema.safeParse(makeRetagProposal()).success).toBe(true);
    expect(C2RetagReviewSchema.safeParse(makeReview()).success).toBe(true);
    expect(C2CanaryResultSchema.safeParse(makeCanary()).success).toBe(true);
  });

  it("requires exact entry, field, old value, new value, and pre-change hash", () => {
    expect(C2RetagProposalSchema.safeParse(makeRetagProposal()).success).toBe(true);

    // Missing pre-change entry hash fails.
    const noPreChange = makeRetagProposal();
    delete (noPreChange as { preChangeEntrySha256?: string }).preChangeEntrySha256;
    expect(C2RetagProposalSchema.safeParse(noPreChange).success).toBe(false);

    // Missing old-value hash fails.
    const noOldValue = makeRetagProposal();
    delete (noOldValue as { oldValueCanonicalSha256?: string }).oldValueCanonicalSha256;
    expect(C2RetagProposalSchema.safeParse(noOldValue).success).toBe(false);

    // Missing proposed value fails.
    const noProposed = makeRetagProposal();
    delete (noProposed as { proposedValue?: unknown }).proposedValue;
    expect(C2RetagProposalSchema.safeParse(noProposed).success).toBe(false);

    // Missing entry id fails.
    const noEntry = makeRetagProposal();
    delete (noEntry as { entryId?: string }).entryId;
    expect(C2RetagProposalSchema.safeParse(noEntry).success).toBe(false);

    // Missing field path fails.
    const noField = makeRetagProposal();
    delete (noField as { fieldPath?: string }).fieldPath;
    expect(C2RetagProposalSchema.safeParse(noField).success).toBe(false);
  });

  it("permits only label-failure proposals and rejects protected corpus fields", () => {
    // Non-label failure classification is rejected.
    expect(
      C2RetagProposalSchema.safeParse(makeRetagProposal({ failureClassification: "coverage" })).success,
    ).toBe(false);

    // Every protected corpus field path is rejected by the regex.
    const protectedPaths = ["id", "source", "image", "addedAt", "capture.url"];
    for (const fieldPath of protectedPaths) {
      expect(
        C2RetagProposalSchema.safeParse(makeRetagProposal({ fieldPath })).success,
      ).toBe(false);
    }

    // Allowed retaggable roots still parse.
    expect(
      C2RetagProposalSchema.safeParse(
        makeRetagProposal({ fieldPath: "patternType" }),
      ).success,
    ).toBe(true);
  });

  it("allows promotion only after an approved human review", () => {
    expect(C2RetagReviewSchema.safeParse(makeReview({ decision: "approved" })).success).toBe(true);
    expect(C2RetagReviewSchema.safeParse(makeReview({ decision: "rejected" })).success).toBe(true);

    // An agent reviewer cannot approve.
    expect(
      C2RetagReviewSchema.safeParse(
        makeReview({ actorKind: "agent" as unknown as "human" }),
      ).success,
    ).toBe(false);

    // Unknown decision value fails.
    expect(
      C2RetagReviewSchema.safeParse(
        makeReview({ decision: "auto-approved" as unknown as "approved" }),
      ).success,
    ).toBe(false);
  });

  it("requires successful rollback evidence before canary expansion", () => {
    // Approved expansion with verified rollback parses.
    expect(C2CanaryResultSchema.safeParse(makeCanary()).success).toBe(true);

    // Approved expansion without verified rollback fails.
    const unverified = makeCanary({
      rollback: { snapshotSha256: SHA_64, restoredCorpusSha256: SHA_64, verified: false },
    });
    expect(C2CanaryResultSchema.safeParse(unverified).success).toBe(false);

    // Not-requested expansion is fine even without verified rollback.
    expect(
      C2CanaryResultSchema.safeParse(
        makeCanary({
          rollback: { snapshotSha256: SHA_64, restoredCorpusSha256: SHA_64, verified: false },
          expansionDecision: "not-requested" as const,
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects a proposed value whose canonical hash does not match", () => {
    // A mismatched hash fails.
    const mismatched = makeRetagProposal({
      proposedValueCanonicalSha256: "0".repeat(64),
    });
    expect(C2RetagProposalSchema.safeParse(mismatched).success).toBe(false);

    // A correctly-computed hash passes (sanity check the helper).
    const proposal = makeRetagProposal();
    expect(proposal.proposedValueCanonicalSha256).toBe(hashOf(PROPOSED_VALUE));
  });

  it("assertProposalMatchesFailure binds the proposal to the referenced failure", () => {
    const failure = makeFailureReport();
    const proposal = C2RetagProposalSchema.parse(makeRetagProposal());

    // Matching proposal + failure does not throw.
    expect(() => assertProposalMatchesFailure(proposal, failure)).not.toThrow();

    // Mismatched failure artifact id throws.
    const wrongArtifactId = makeFailureReport();
    wrongArtifactId.artifactId = "c2-failure-other";
    expect(() => assertProposalMatchesFailure(proposal, wrongArtifactId)).toThrow(
      /does not reference the failure artifact/,
    );

    // Wrong classification throws.
    const nonLabel = makeFailureReport();
    nonLabel.classification = "coverage";
    expect(() => assertProposalMatchesFailure(proposal, nonLabel)).toThrow(
      /requires a label-classified failure/,
    );

    // caseId not in affectedCaseIds throws.
    const wrongCase = makeRetagProposal({ affectedCaseIds: ["other-case"] });
    const wrongCaseProposal = C2RetagProposalSchema.parse(wrongCase);
    expect(() => assertProposalMatchesFailure(wrongCaseProposal, failure)).toThrow(
      /not in the proposal's affected cases/,
    );
  });
});
