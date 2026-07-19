/**
 * C2 provisional governance contracts.
 *
 * Declares the exact human approval roles required to close C2 and a strict
 * *provisional* evidence-manifest schema. The provisional manifest deliberately
 * cannot be relabelled as "frozen" and has no approvals field: while C2 is open
 * evidence is collected provisionally, and promotion to a frozen/approved state
 * happens elsewhere (readiness validator), never inline in this artifact.
 */
import { z } from "zod";
import { GitSha, Sha256 } from "../readiness/contracts.js";
import { ArtifactFileRefSchema, NonEmptyText, PositiveVersion, StableId } from "./primitives.js";

/** Roles that must approve before C2 can be closed. */
export const C2_REQUIRED_APPROVAL_ROLES = ["Gold Label Owner", "QA"] as const;

const PilotManifestRefSchema = ArtifactFileRefSchema.extend({
  artifactType: z.literal("c2-pilot-manifest"),
}).strict();

export const C2ProvisionalEvidenceManifestSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.literal("c2-provisional-evidence-manifest"),
    artifactId: StableId,
    manifestVersion: PositiveVersion,
    state: z.literal("provisional"),
    sourceGitSha: GitSha,
    specSha256: Sha256,
    planSha256: Sha256,
    corpusSha256: z.null(),
    retrievalIndexSha256: z.null(),
    requiredApprovalRoles: z.tuple([z.literal("Gold Label Owner"), z.literal("QA")]),
    pilotManifest: PilotManifestRefSchema,
    rationale: NonEmptyText,
  })
  .strict();

export type C2ProvisionalEvidenceManifest = z.infer<
  typeof C2ProvisionalEvidenceManifestSchema
>;
