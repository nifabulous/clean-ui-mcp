/**
 * C2 candidate design and deterministic score contracts.
 *
 * The candidate is a strict, model-produced design artifact. It deliberately
 * carries no reviewer-only label fields (gold IDs, rubric anchors, expected
 * decisions, acceptance criteria, prohibitions, or adjudication notes) so that
 * a candidate and its label can be parsed by different code paths and a label
 * leak into the candidate cannot survive strict parsing.
 *
 * This module IMPORTS primitives from `./primitives.js` and SHA primitives
 * from `../readiness/contracts.js`; it does NOT re-export them, so the C2
 * barrel (`src/c2/index.ts`) can `export *` from both modules without a name
 * collision.
 */
import { z } from "zod";
import { Sha256 } from "../readiness/contracts.js";
import {
  AuthorityLaneSchema,
  NonEmptyText,
  StableId,
  UniqueNonEmptyStrings,
  hasUniqueStrings,
} from "./primitives.js";

const C2ScreenBlueprintSchema = z
  .object({
    id: StableId,
    summary: NonEmptyText,
    requiredStates: UniqueNonEmptyStrings,
    mobileRules: UniqueNonEmptyStrings,
    accessibility: UniqueNonEmptyStrings,
    failureAndRecovery: UniqueNonEmptyStrings,
    // Optional inspected-URL metadata. Defaults to an empty array because the
    // scorer does not currently evaluate source-access outcomes; a future label
    // revision may tighten this. See plan OV2.
    inspectedUrls: z.array(z.string().url()).default([]),
  })
  .strict();

const C2CandidateDecisionSchema = z
  .object({
    id: StableId,
    lane: AuthorityLaneSchema,
    rationale: NonEmptyText,
    evidenceIds: z.array(StableId).refine(hasUniqueStrings, "evidence IDs must be unique"),
  })
  .strict();

const C2CandidateCriterionSchema = z.object({ id: StableId, statement: NonEmptyText }).strict();

export const C2CandidateArtifactSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.literal("c2-candidate-design"),
    artifactId: StableId,
    caseId: StableId,
    globalDirection: z
      .object({ summary: NonEmptyText, principles: UniqueNonEmptyStrings })
      .strict(),
    screenBlueprints: z.array(C2ScreenBlueprintSchema).min(1),
    sourceDecisions: z.array(C2CandidateDecisionSchema).min(1),
    authorityLanes: z
      .object({
        retain: z.array(StableId),
        adapt: z.array(StableId),
        reject: z.array(StableId),
      })
      .strict(),
    acceptanceCriteria: z.array(C2CandidateCriterionSchema).min(1),
    assumptions: UniqueNonEmptyStrings,
    accessibilityAndRecovery: UniqueNonEmptyStrings,
    provenance: z.object({ conditionInputSha256: Sha256 }).strict(),
  })
  .strict()
  .superRefine((candidate, ctx) => {
    for (const [path, ids] of [
      ["screenBlueprints", candidate.screenBlueprints.map((item) => item.id)],
      ["sourceDecisions", candidate.sourceDecisions.map((item) => item.id)],
      ["acceptanceCriteria", candidate.acceptanceCriteria.map((item) => item.id)],
    ] as const) {
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: "custom", path: [path], message: `${path} IDs must be unique` });
      }
    }
  });

export const C2DeterministicScoreSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.literal("c2-deterministic-score"),
    artifactId: StableId,
    runId: StableId,
    runOutputSha256: Sha256,
    scorerSha256: Sha256,
    complete: z.boolean(),
    requiredSectionCoverage: z.number().min(0).max(1),
    requiredDecisionCoverage: z.number().min(0).max(1),
    acceptanceCriterionCoverage: z.number().min(0).max(1),
    missingScreenRequirements: z.array(NonEmptyText),
    unsupportedClaimCount: z.number().int().nonnegative(),
    forbiddenDisclosureCount: z.number().int().nonnegative(),
    unresolvedEvidenceCount: z.number().int().nonnegative(),
    provenanceMismatch: z.boolean(),
  })
  .strict();

export type C2CandidateArtifact = z.infer<typeof C2CandidateArtifactSchema>;
export type C2DeterministicScore = z.infer<typeof C2DeterministicScoreSchema>;
