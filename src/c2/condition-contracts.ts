/**
 * C2 condition-input, evidence, campaign, pricing, calibration-proposal, and
 * frozen-calibration contracts.
 *
 * These contracts pin the inputs to a paid model call (condition input,
 * evidence records, campaign config, pricing table) and the artifacts a
 * calibration review produces (a non-authoritative proposal, then an explicitly
 * authorized frozen calibration). They are the contract foundation for every
 * downstream Pass 2 task (scorer, prompt-builder, harness, calibration).
 *
 * This module IMPORTS primitives from `./primitives.js`, the control-condition
 * enum from `./primitives.js`, and SHA primitives from
 * `../readiness/contracts.js`. It does NOT re-export any of them, so the C2
 * barrel can re-export both this module and the primitive modules without a
 * name collision.
 */
import { z } from "zod";
import { Sha256 } from "../readiness/contracts.js";
import {
  ArtifactFileRefSchema,
  AuthorityLaneSchema,
  C2ControlConditionSchema,
  NonEmptyText,
  StableId,
  UniqueNonEmptyStrings,
  hasUniqueStrings,
} from "./primitives.js";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Pinned model + campaign
// ---------------------------------------------------------------------------

const C2PinnedModelSchema = z
  .object({
    // "openai" is the OpenAI provider; "claude" is provider shorthand for
    // Anthropic's Claude model family (per the C2 spec, "OpenAI is the primary
    // provider; Claude is the independent provider"). Adding a new provider or
    // a non-Claude Anthropic model requires extending this enum.
    provider: z.enum(["openai", "claude"]),
    model: NonEmptyText,
    // Environment-variable NAME only — never a secret value.
    apiKeyEnv: NonEmptyText,
    maxOutputTokens: z.number().int().positive(),
    samplingParameters: z.record(
      StableId,
      z.union([z.string(), z.number().finite(), z.boolean()]),
    ),
  })
  .strict();

export const C2CampaignConfigSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.literal("c2-campaign-config"),
    artifactId: StableId,
    primary: C2PinnedModelSchema,
    independent: C2PinnedModelSchema,
    // Fixed $0.50 per-run and $5 per-campaign ceilings (pinned literals).
    maxRunCostUsd: z.literal(0.5),
    maxCampaignCostUsd: z.literal(5),
    maxAttempts: z.number().int().min(1).max(3),
    cases: UniqueNonEmptyStrings,
    conditions: z.tuple([
      z.literal("brief-only"),
      z.literal("current-grounded"),
      z.literal("gold-evidence"),
    ]),
    independentConditions: z.tuple([z.literal("current-grounded")]),
    plannedRunCount: z.literal(12),
    retrievalMode: z.literal("keyword-only"),
  })
  .strict();

// ---------------------------------------------------------------------------
// Evidence records
// ---------------------------------------------------------------------------

export const C2EvidenceRecordSchema = z
  .object({
    id: StableId,
    authorityLane: AuthorityLaneSchema,
    sourceType: z.enum(["brief-fragment", "corpus-entry", "source-snapshot"]),
    sourceArtifactId: StableId,
    sourceSha256: Sha256,
    contentSha256: Sha256,
    // Rank is null for non-ranked sources (brief fragments, snapshots). Ranked
    // corpus entries use a positive integer rank.
    rank: z.number().int().positive().nullable(),
    score: z.number().finite().nullable(),
  })
  .strict();

const RankedResultEntrySchema = z
  .object({
    entryId: StableId,
    rank: z.number().int().positive(),
    score: z.number().finite(),
    contentSha256: Sha256,
  })
  .strict();

const RetrievalMetadataSchema = z
  .object({
    query: NonEmptyText,
    configurationSha256: Sha256,
    rankedResult: z.array(RankedResultEntrySchema),
    selectedEntryIds: z.array(StableId),
  })
  .strict();

const SourceSnapshotRefSchema = z
  .object({
    artifactId: StableId,
    path: NonEmptyText,
    sha256: Sha256,
  })
  .strict();

// ---------------------------------------------------------------------------
// Condition inputs (discriminated by condition)
//
// Each variant pins the model-visible evidence shape for its control condition.
// Brief-only forbids evidence and corpus metadata. Current-grounded requires
// corpus metadata plus a complete ranked result and at least one selected entry.
// Gold-evidence requires a bound packet whose resolved gold IDs all map to
// evidence records.
// ---------------------------------------------------------------------------

const ConditionInputBaseSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.literal("c2-condition-input"),
    artifactId: StableId,
    casePackageRef: ArtifactFileRefSchema,
    briefRef: ArtifactFileRefSchema,
    sourceSnapshotRefs: z.array(SourceSnapshotRefSchema),
    // Canonical hash over all model-visible inputs and their ordering.
    inputSha256: Sha256,
  })
  .strict();

const BriefOnlyConditionInputSchema = ConditionInputBaseSchema.extend({
  condition: z.literal("brief-only"),
  // Brief-only forbids evidence; the empty array is the only legal value.
  evidence: z.array(C2EvidenceRecordSchema).max(0),
  corpusSha256: z.null(),
  retrievalIndexSha256: z.null(),
  retrieval: z.null(),
}).strict();

const CurrentGroundedConditionInputSchema = ConditionInputBaseSchema.extend({
  condition: z.literal("current-grounded"),
  evidence: z.array(C2EvidenceRecordSchema).min(1),
  corpusSha256: Sha256,
  retrievalIndexSha256: Sha256,
  retrieval: RetrievalMetadataSchema,
}).strict();

const GoldEvidenceConditionInputSchema = ConditionInputBaseSchema.extend({
  condition: z.literal("gold-evidence"),
  evidence: z.array(C2EvidenceRecordSchema).min(1),
  corpusSha256: Sha256,
  retrievalIndexSha256: Sha256,
  retrieval: z.null(),
  goldPacketRef: ArtifactFileRefSchema,
  resolvedGoldIds: z.array(StableId).min(1),
}).strict();

export const C2ConditionInputSchema = z
  .discriminatedUnion("condition", [
    BriefOnlyConditionInputSchema,
    CurrentGroundedConditionInputSchema,
    GoldEvidenceConditionInputSchema,
  ])
  .superRefine((input, ctx) => {
    const evidenceIds = input.evidence.map((entry) => entry.id);
    if (!hasUniqueStrings(evidenceIds)) {
      ctx.addIssue({ code: "custom", path: ["evidence"], message: "evidence IDs must be unique" });
    }

    if (input.condition === "current-grounded") {
      const ranked = input.retrieval.rankedResult;
      const ranks = ranked.map((entry) => entry.rank);
      if (new Set(ranks).size !== ranks.length) {
        ctx.addIssue({ code: "custom", path: ["retrieval", "rankedResult"], message: "ranked result ranks must be unique" });
      }
      const rankedIds = ranked.map((entry) => entry.entryId);
      if (new Set(rankedIds).size !== rankedIds.length) {
        ctx.addIssue({ code: "custom", path: ["retrieval", "rankedResult"], message: "ranked result entry IDs must be unique" });
      }
      if (input.retrieval.selectedEntryIds.length === 0) {
        ctx.addIssue({ code: "custom", path: ["retrieval", "selectedEntryIds"], message: "current-grounded run must select at least one ranked entry" });
      }
      const selected = new Set(input.retrieval.selectedEntryIds);
      for (const id of selected) {
        if (!ranked.some((entry) => entry.entryId === id)) {
          ctx.addIssue({ code: "custom", path: ["retrieval", "selectedEntryIds"], message: "selected entry must appear in the complete ranked result" });
        }
      }
    }

    if (input.condition === "gold-evidence") {
      const evidence = new Set(input.evidence.map((entry) => entry.id));
      for (const goldId of input.resolvedGoldIds) {
        if (!evidence.has(goldId)) {
          ctx.addIssue({ code: "custom", path: ["resolvedGoldIds"], message: `gold evidence not resolved against supplied evidence: ${goldId}` });
        }
      }
      if (!hasUniqueStrings(input.resolvedGoldIds)) {
        ctx.addIssue({ code: "custom", path: ["resolvedGoldIds"], message: "resolved gold IDs must be unique" });
      }
    }
  });

// ---------------------------------------------------------------------------
// Pricing table
//
// Each entry pins provider, model, USD-per-million-token input/output prices,
// an effective date, a verification timestamp, and an authoritative source
// URL. Reject unknown/duplicate/non-finite/source-less pricing, and reject any
// entry verified more than 30 days before the campaign starts.
// ---------------------------------------------------------------------------

const C2PricingEntrySchema = z
  .object({
    // "openai" is the OpenAI provider; "claude" is provider shorthand for
    // Anthropic's Claude model family (per the C2 spec, "OpenAI is the primary
    // provider; Claude is the independent provider"). Adding a new provider or
    // a non-Claude Anthropic model requires extending this enum.
    provider: z.enum(["openai", "claude"]),
    model: NonEmptyText,
    inputTokenPriceUsdPerMillion: z.number().finite().nonnegative(),
    outputTokenPriceUsdPerMillion: z.number().finite().nonnegative(),
    effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "effective date must be YYYY-MM-DD"),
    verifiedAt: z.string().datetime(),
    sourceUrl: z.string().url(),
  })
  .strict();

export const C2PricingTableSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.literal("c2-pricing-table"),
    artifactId: StableId,
    campaignStartsAt: z.string().datetime(),
    entries: z.array(C2PricingEntrySchema).min(1),
  })
  .strict()
  .superRefine((table, ctx) => {
    const keys = table.entries.map((entry) => `${entry.provider}:${entry.model}`);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: "custom", path: ["entries"], message: "pricing entries must be unique by provider and model" });
    }
    const campaignStartMs = Date.parse(table.campaignStartsAt);
    for (let index = 0; index < table.entries.length; index += 1) {
      const entry = table.entries[index];
      const verifiedMs = Date.parse(entry.verifiedAt);
      if (verifiedMs < campaignStartMs - THIRTY_DAYS_MS) {
        ctx.addIssue({
          code: "custom",
          path: ["entries", index, "verifiedAt"],
          message: "pricing entry verified more than 30 days before campaign start",
        });
      }
    }
  });

// ---------------------------------------------------------------------------
// Calibration proposal
//
// The proposal carries the measurements (condition deltas, regressions,
// readiness transitions, safety results, gold headroom, compatibility, costs)
// and the exact pilot artifact hashes. It does NOT select thresholds; the
// freeze step records the selected material-benefit minimum and regression
// tolerance.
// ---------------------------------------------------------------------------

const RubricDimensionEnum = z.enum([
  "product-appropriateness",
  "cross-screen-coherence",
  "implementation-clarity",
  "originality",
  "accessibility-and-failure-states",
  "evidence-discipline",
]);

const ConditionDeltaSchema = z
  .object({
    dimension: RubricDimensionEnum,
    briefOnlyMean: z.number().finite(),
    currentGroundedMean: z.number().finite(),
    goldEvidenceMean: z.number().finite(),
  })
  .strict();

const RegressionSchema = z
  .object({
    dimension: RubricDimensionEnum,
    regressionMagnitude: z.number().finite().nonnegative(),
    fromMean: z.number().finite(),
    toMean: z.number().finite(),
  })
  .strict();

const ReadinessTransitionSchema = z
  .object({
    caseId: StableId,
    briefOnlyReady: z.boolean(),
    currentGroundedReady: z.boolean(),
    goldEvidenceReady: z.boolean(),
  })
  .strict();

const DeterministicTransitionSchema = z
  .object({
    caseId: StableId,
    briefOnlyComplete: z.boolean(),
    currentGroundedComplete: z.boolean(),
    goldEvidenceComplete: z.boolean(),
  })
  .strict();

const SafetyResultSchema = z
  .object({
    caseId: StableId,
    briefOnlyCompliant: z.boolean(),
    currentGroundedCompliant: z.boolean(),
    goldEvidenceCompliant: z.boolean(),
  })
  .strict();

const GoldHeadroomSchema = z
  .object({
    currentGroundedMean: z.number().finite(),
    goldEvidenceMean: z.number().finite(),
  })
  .strict();

const IndependentCompatibilitySchema = z
  .object({
    criticalDecisionCoverageComplete: z.boolean(),
    contradictoryCriticalDecisions: z.boolean(),
    constraintsRespected: z.boolean(),
    forbiddenClaimsRespected: z.boolean(),
    compatibleJourneys: z.boolean(),
    safetyPassedIndependently: z.boolean(),
  })
  .strict();

const ObservedCostsSchema = z
  .object({
    totalUsd: z.number().finite().nonnegative(),
    perRunUsd: z.array(z.number().finite().nonnegative()),
    forecastTotalUsd: z.number().finite().nonnegative(),
  })
  .strict();

const CalibrationMeasurementsSchema = z
  .object({
    conditionDeltas: z.array(ConditionDeltaSchema),
    regressions: z.array(RegressionSchema),
    readinessTransitions: z.array(ReadinessTransitionSchema),
    deterministicTransitions: z.array(DeterministicTransitionSchema),
    safetyResults: z.array(SafetyResultSchema),
    goldHeadroom: GoldHeadroomSchema,
    independentCompatibility: IndependentCompatibilitySchema,
    observedCosts: ObservedCostsSchema,
  })
  .strict();

export const C2CalibrationProposalSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.literal("c2-calibration-proposal"),
    artifactId: StableId,
    campaignConfigRef: ArtifactFileRefSchema,
    pricingTableRef: ArtifactFileRefSchema,
    measurements: CalibrationMeasurementsSchema,
    proposalSha256: Sha256,
  })
  .strict();

// ---------------------------------------------------------------------------
// Frozen calibration
//
// Binds proposal, run, scorecard, pricing, campaign, and reviewer hashes plus
// the selected material-benefit minimum, regression tolerance, and the
// independent-compatibility checklist. Rejects any CLI-style override fields
// (everything not in the canonical shape fails strict parsing). The fixed
// $0.50 / $5 budgets are pinned literals. `frozenAt` is a canonical timestamp
// the freeze command passes in, so a second freeze of the same proposal with
// the same authorization and timestamp regenerates byte-identical bytes.
// ---------------------------------------------------------------------------

export const C2FrozenCalibrationSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    artifactType: z.literal("c2-frozen-calibration"),
    artifactId: StableId,
    proposalRef: ArtifactFileRefSchema,
    runManifestRefs: z.array(ArtifactFileRefSchema).min(1),
    scorecardRefs: z.array(ArtifactFileRefSchema).min(1),
    pricingTableRef: ArtifactFileRefSchema,
    campaignConfigRef: ArtifactFileRefSchema,
    reviewerActorId: StableId,
    reviewerRole: z.enum(["Gold Label Owner", "QA"]),
    rationale: NonEmptyText,
    materialBenefitMinimum: z.number().finite().positive(),
    regressionTolerance: z.number().finite().nonnegative(),
    independentChecklist: IndependentCompatibilitySchema,
    maxRunCostUsd: z.literal(0.5),
    maxCampaignCostUsd: z.literal(5),
    frozenAt: z.string().datetime(),
  })
  .strict();

export type C2ConditionInput = z.infer<typeof C2ConditionInputSchema>;
export type C2EvidenceRecord = z.infer<typeof C2EvidenceRecordSchema>;
export type C2CampaignConfig = z.infer<typeof C2CampaignConfigSchema>;
export type C2PricingTable = z.infer<typeof C2PricingTableSchema>;
export type C2CalibrationProposal = z.infer<typeof C2CalibrationProposalSchema>;
export type C2FrozenCalibration = z.infer<typeof C2FrozenCalibrationSchema>;
