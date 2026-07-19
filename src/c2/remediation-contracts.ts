/**
 * C2 shadow-remediation contracts.
 *
 * Strict Zod schemas for the shadow remediation track that runs alongside the
 * frozen gold corpus. These artifacts let an agent propose a retag against a
 * label-classified failure, a human approve or reject that proposal, and a
 * canary run report on the before/after corpus with verified rollback. Nothing
 * here mutates the closed gold corpus: a retag is only ever a *proposal* until
 * a human review promotes it, and promotion to a full corpus expansion requires
 * a verified rollback snapshot.
 */
import { z } from "zod";
import { Sha256, canonicalJsonStringify, sha256Hex } from "../readiness/contracts.js";
import {
  ArtifactFileRefSchema,
  NonEmptyText,
  PositiveVersion,
  StableId,
  UniqueNonEmptyStrings,
} from "./primitives.js";
import type { C2FailureReport } from "./evaluation-contracts.js";

export const C2RetagProposalSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.literal("c2-retag-proposal"),
    artifactId: StableId,
    proposalVersion: PositiveVersion,
    failureReport: ArtifactFileRefSchema,
    failureClassification: z.literal("label"),
    entryId: StableId,
    fieldPath: z
      .string()
      .trim()
      .regex(
        /^(patternType|categories|components|domainTags|visualFields|groundedClaimIds|accessibilityEvidenceIds|critiqueQuality)(?:\.[a-zA-Z0-9_-]+)*$/,
      ),
    preChangeEntrySha256: Sha256,
    oldValueCanonicalSha256: Sha256,
    proposedValue: z.unknown(),
    proposedValueCanonicalSha256: Sha256,
    evidenceIds: UniqueNonEmptyStrings,
    affectedCaseIds: UniqueNonEmptyStrings,
    rationale: NonEmptyText,
    generatorFingerprintSha256: Sha256,
  })
  .strict()
  .superRefine((value, ctx) => {
    // Verify the proposed value's canonical hash matches. Catch canonicalization
    // errors (undefined, functions, symbols, non-finite numbers, cycles) and
    // report as a schema issue rather than throwing from parsing.
    try {
      const canonical = canonicalJsonStringify(value.proposedValue);
      const expected = sha256Hex(new TextEncoder().encode(canonical));
      if (expected !== value.proposedValueCanonicalSha256) {
        ctx.addIssue({
          code: "custom",
          path: ["proposedValueCanonicalSha256"],
          message: "proposed value canonical hash does not match proposedValue",
        });
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        path: ["proposedValue"],
        message:
          "proposed value cannot be canonically serialized (contains undefined, function, symbol, non-finite, or cyclic value)",
      });
    }
  });

export const C2RetagReviewSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.literal("c2-retag-review"),
    artifactId: StableId,
    proposalArtifactId: StableId,
    proposalSha256: Sha256,
    actorId: StableId,
    actorKind: z.literal("human"),
    decision: z.enum(["approved", "rejected"]),
    rationale: NonEmptyText,
    reviewedAt: z.string().datetime(),
  })
  .strict();

export const C2CanaryResultSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.literal("c2-canary-result"),
    artifactId: StableId,
    approvedReviewRefs: z.array(ArtifactFileRefSchema).min(1),
    beforeCorpusSha256: Sha256,
    afterCorpusSha256: Sha256,
    affectedCaseRunRefs: z.array(ArtifactFileRefSchema).min(1),
    rollback: z
      .object({ snapshotSha256: Sha256, restoredCorpusSha256: Sha256, verified: z.boolean() })
      .strict(),
    expansionDecision: z.enum(["not-requested", "approved", "rejected"]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expansionDecision === "approved" && !value.rollback.verified) {
      ctx.addIssue({
        code: "custom",
        path: ["rollback", "verified"],
        message: "verified rollback required before expansion",
      });
    }
  });

/**
 * Bind a retag proposal to the failure it claims to remediate.
 *
 * Throws when the proposal does not reference the failure artifact, when the
 * failure is not label-classified, or when the proposed entry, case, or field
 * is not within the failure's declared affected set.
 */
export function assertProposalMatchesFailure(
  proposal: z.infer<typeof C2RetagProposalSchema>,
  failure: C2FailureReport,
): void {
  if (proposal.failureReport.artifactId !== failure.artifactId)
    throw new Error("proposal does not reference the failure artifact");
  if (failure.classification !== "label")
    throw new Error("retag proposal requires a label-classified failure");
  if (!proposal.affectedCaseIds.includes(failure.caseId))
    throw new Error("failure case is not in the proposal's affected cases");
  if (!failure.affectedEntryIds.includes(proposal.entryId))
    throw new Error("proposed entry is not in the failure's affected entries");
  if (!failure.affectedFieldPaths.includes(proposal.fieldPath))
    throw new Error("proposed field is not in the failure's affected fields");
}

export type C2RetagProposal = z.infer<typeof C2RetagProposalSchema>;
export type C2RetagReview = z.infer<typeof C2RetagReviewSchema>;
export type C2CanaryResult = z.infer<typeof C2CanaryResultSchema>;
