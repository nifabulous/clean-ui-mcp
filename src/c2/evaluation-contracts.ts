import { z } from "zod";
import { GitSha, Sha256 } from "../readiness/contracts.js";
import {
  ArtifactFileRefSchema,
  C2ControlConditionSchema,
  NonEmptyText,
  PositiveVersion,
  StableId,
  UniqueNonEmptyStrings,
  hasUniqueStrings,
} from "./primitives.js";

const IntegrityEntrySchema = z.object({
  entryId: StableId,
  cohort: z.enum(["reproducible", "challenge"]),
  stratum: StableId,
  selectionReason: NonEmptyText,
  imageSha256: Sha256,
}).strict();

export const C2LabelIntegritySelectionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-label-integrity-selection"),
  artifactId: StableId,
  selectionVersion: PositiveVersion,
  seed: NonEmptyText,
  corpusGitSha: GitSha,
  corpusSha256: Sha256,
  entries: z.array(IntegrityEntrySchema).length(40),
}).strict().superRefine((value, ctx) => {
  if (!hasUniqueStrings(value.entries.map((entry) => entry.entryId))) ctx.addIssue({ code: "custom", path: ["entries"], message: "entry IDs must be unique" });
  if (value.entries.filter((entry) => entry.cohort === "reproducible").length !== 35) ctx.addIssue({ code: "custom", path: ["entries"], message: "exactly 35 reproducible entries required" });
  if (value.entries.filter((entry) => entry.cohort === "challenge").length !== 5) ctx.addIssue({ code: "custom", path: ["entries"], message: "exactly 5 challenge entries required" });
});

const EntryLabelSchema = z.object({
  entryId: StableId,
  patternType: StableId,
  categories: UniqueNonEmptyStrings,
  components: UniqueNonEmptyStrings,
  domainTags: UniqueNonEmptyStrings,
  visualFields: z.record(StableId, NonEmptyText),
  groundedClaimIds: UniqueNonEmptyStrings,
  accessibilityEvidenceIds: z.array(StableId),
  critiqueQuality: z.enum(["insufficient", "acceptable", "strong"]),
  protectedFieldExpectation: z.literal("unchanged"),
}).strict();

export const C2IndependentLabelSubmissionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-independent-label-submission"),
  artifactId: StableId,
  selectionArtifactId: StableId,
  selectionSha256: Sha256,
  submissionVersion: PositiveVersion,
  actorId: StableId,
  actorKind: z.literal("human"),
  reviewerRole: z.enum(["Gold Label Owner", "QA"]),
  sealedAt: z.string().datetime(),
  labels: z.array(EntryLabelSchema).length(40),
}).strict().refine((value) => hasUniqueStrings(value.labels.map((label) => label.entryId)), "entry labels must be unique");

export function assertSubmissionMatchesSelection(
  selection: z.infer<typeof C2LabelIntegritySelectionSchema>,
  submission: z.infer<typeof C2IndependentLabelSubmissionSchema>,
  resolvedSelectionSha256?: string,
): void {
  if (submission.selectionArtifactId !== selection.artifactId) throw new Error("submission selection artifact does not match");
  // P2 fix: verify the submission's recorded selection hash matches the actual
  // selection bytes, so a submission cannot remain "valid" against a changed
  // selection revision with the same artifact ID and entry IDs but different
  // image hashes, cohorts, strata, or reasons.
  if (resolvedSelectionSha256 !== undefined && submission.selectionSha256 !== resolvedSelectionSha256) {
    throw new Error("submission selection hash does not match resolved selection");
  }
  const expected = [...selection.entries.map((entry) => entry.entryId)].sort();
  const observed = [...submission.labels.map((label) => label.entryId)].sort();
  if (expected.length !== observed.length || expected.some((id, index) => id !== observed[index])) {
    throw new Error("submission entry IDs do not match selection");
  }
}

export const C2_REPLACEMENT_METRIC_FLOORS = {
  "pattern-type-exact-accuracy": 0.90,
  "categories-macro-f1": 0.85,
  "components-precision": 0.90,
  "domain-tags-precision": 0.90,
  "structured-critique-schema-validity": 1.0,
  "scorable-recommendation-citation-rate": 0.90,
} as const;

const MetricIdSchema = z.enum([
  "pattern-type-exact-accuracy",
  "categories-macro-f1",
  "components-precision",
  "components-recall",
  "domain-tags-precision",
  "domain-tags-recall",
  "structured-critique-schema-validity",
  "scorable-recommendation-citation-rate",
]);

const MetricSchema = z.object({
  metricId: MetricIdSchema,
  value: z.number().min(0).max(1),
  baselineValue: z.number().min(0).max(1).nullable(),
  requiredFloor: z.number().min(0).max(1),
  passed: z.boolean(),
}).strict().superRefine((value, ctx) => {
  const baselineBound = new Set(["pattern-type-exact-accuracy", "categories-macro-f1", "components-recall", "domain-tags-recall"]);
  if (baselineBound.has(value.metricId) && value.baselineValue === null) ctx.addIssue({ code: "custom", path: ["baselineValue"], message: "metric requires frozen baseline" });
  const fixed = C2_REPLACEMENT_METRIC_FLOORS[value.metricId as keyof typeof C2_REPLACEMENT_METRIC_FLOORS];
  const expectedFloor = Math.max(fixed ?? 0, value.baselineValue ?? 0);
  if (value.requiredFloor !== expectedFloor) ctx.addIssue({ code: "custom", path: ["requiredFloor"], message: `required floor must be ${expectedFloor}` });
  if (value.passed !== (value.value >= expectedFloor)) ctx.addIssue({ code: "custom", path: ["passed"], message: "passed must equal value >= required floor" });
});

export const C2_HARD_GATE_IDS = [
  "schema-valid-candidate-output",
  "protected-fields-unchanged",
  "valid-evidence-ids",
  "no-banned-phrases",
  "no-unsupported-accessibility-absence-or-icon-only-claims",
  "valid-wcag-identifiers",
  "publication-metadata-preserved",
  "provider-model-prompt-rule-reference-reproducible",
] as const;

const HardGateResultSchema = z.object({
  gateId: z.enum(C2_HARD_GATE_IDS),
  passed: z.boolean(),
  evidence: NonEmptyText,
}).strict();

export const C2LabelAgreementReportSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-label-agreement-report"),
  artifactId: StableId,
  selectionRef: ArtifactFileRefSchema,
  goldOwnerSubmissionRef: ArtifactFileRefSchema,
  qaSubmissionRef: ArtifactFileRefSchema,
  goldOwnerActorId: StableId,
  qaActorId: StableId,
  submissionsUnsealedAt: z.string().datetime(),
  metrics: z.array(MetricSchema).length(8).refine((metrics) => hasUniqueStrings(metrics.map((metric) => metric.metricId)), "exactly one result per required metric"),
  hardGates: z.array(HardGateResultSchema).length(C2_HARD_GATE_IDS.length).refine((gates) => hasUniqueStrings(gates.map((gate) => gate.gateId)), "exactly one result per hard gate"),
  disagreementEntryIds: z.array(StableId).refine(hasUniqueStrings, "disagreement IDs must be unique"),
  adjudicationRef: ArtifactFileRefSchema,
  terminalOutcome: z.enum(["Qualified", "Replacement not justified"]),
}).strict().superRefine((report, ctx) => {
  if (report.goldOwnerActorId === report.qaActorId) ctx.addIssue({ code: "custom", path: ["qaActorId"], message: "independent actors must be distinct" });
  if (report.terminalOutcome === "Qualified" && (report.hardGates.some((gate) => !gate.passed) || report.metrics.some((metric) => !metric.passed))) ctx.addIssue({ code: "custom", path: ["terminalOutcome"], message: "Qualified requires all floors and hard gates" });
});

export function assertAgreementMatchesSubmissions(
  selection: z.infer<typeof C2LabelIntegritySelectionSchema>,
  goldOwner: z.infer<typeof C2IndependentLabelSubmissionSchema>,
  qa: z.infer<typeof C2IndependentLabelSubmissionSchema>,
  report: z.infer<typeof C2LabelAgreementReportSchema>,
  resolvedHashes: { selectionSha256: string; goldOwnerSubmissionSha256: string; qaSubmissionSha256: string },
): void {
  assertSubmissionMatchesSelection(selection, goldOwner);
  assertSubmissionMatchesSelection(selection, qa);
  if (goldOwner.reviewerRole !== "Gold Label Owner" || qa.reviewerRole !== "QA") throw new Error("submission role mismatch");
  if (goldOwner.actorId !== report.goldOwnerActorId || qa.actorId !== report.qaActorId) throw new Error("agreement actor mismatch");
  if (report.selectionRef.artifactId !== selection.artifactId) throw new Error("agreement selection reference mismatch");
  if (report.goldOwnerSubmissionRef.artifactId !== goldOwner.artifactId || report.qaSubmissionRef.artifactId !== qa.artifactId) throw new Error("agreement submission reference mismatch");
  if (report.selectionRef.sha256 !== resolvedHashes.selectionSha256 || report.goldOwnerSubmissionRef.sha256 !== resolvedHashes.goldOwnerSubmissionSha256 || report.qaSubmissionRef.sha256 !== resolvedHashes.qaSubmissionSha256) throw new Error("agreement artifact hash mismatch");
  const selected = new Set(selection.entries.map((entry) => entry.entryId));
  if (report.disagreementEntryIds.some((entryId) => !selected.has(entryId))) throw new Error("agreement contains an unselected disagreement entry");
}

export const C2EvaluationRunManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-evaluation-run"),
  artifactId: StableId,
  runId: StableId,
  predecessorRunId: StableId.nullable(),
  casePackage: ArtifactFileRefSchema,
  condition: C2ControlConditionSchema,
  corpusSha256: Sha256.nullable(),
  retrievalIndexSha256: Sha256.nullable(),
  promptSha256: Sha256,
  harnessGitSha: GitSha,
  provider: NonEmptyText,
  model: NonEmptyText,
  samplingParameters: z.record(StableId, z.union([z.string(), z.number().finite(), z.boolean()])),
  evidenceIds: z.array(StableId).refine(hasUniqueStrings, "evidence IDs must be unique"),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime().nullable(),
  status: z.enum(["running", "succeeded", "failed", "cost-blocked"]),
  inputSha256: Sha256,
  rawOutputSha256: Sha256.nullable(),
  parsedOutputSha256: Sha256.nullable(),
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  costUsd: z.number().nonnegative(),
}).strict().superRefine((run, ctx) => {
  if (run.condition === "brief-only" && run.evidenceIds.length !== 0) ctx.addIssue({ code: "custom", path: ["evidenceIds"], message: "brief-only run forbids evidence" });
  if (run.condition === "gold-evidence" && run.evidenceIds.length === 0) ctx.addIssue({ code: "custom", path: ["evidenceIds"], message: "gold-evidence run requires evidence" });
  if (run.status === "succeeded" && (!run.finishedAt || !run.rawOutputSha256 || !run.parsedOutputSha256)) ctx.addIssue({ code: "custom", message: "successful run requires finish time and output hashes" });
  if (run.status === "running" && (run.finishedAt || run.rawOutputSha256 || run.parsedOutputSha256)) ctx.addIssue({ code: "custom", message: "running state forbids finish time and output hashes" });
  if (run.status === "failed" && (!run.finishedAt || run.parsedOutputSha256)) ctx.addIssue({ code: "custom", message: "failed state requires finish time and forbids parsed output" });
  if (run.status === "cost-blocked" && (run.finishedAt || run.rawOutputSha256 || run.parsedOutputSha256 || run.promptTokens !== 0 || run.completionTokens !== 0 || run.costUsd !== 0)) ctx.addIssue({ code: "custom", message: "cost-blocked state must record no execution or outputs" });
  if (run.finishedAt && Date.parse(run.finishedAt) < Date.parse(run.startedAt)) ctx.addIssue({ code: "custom", path: ["finishedAt"], message: "finish time cannot precede start time" });
});

const DimensionSchema = z.enum(["product-appropriateness", "cross-screen-coherence", "implementation-clarity", "originality", "accessibility-and-failure-states", "evidence-discipline"]);
const DimensionScoreSchema = z.object({ dimension: DimensionSchema, score: z.number().int().min(1).max(5), rationale: NonEmptyText }).strict();

export const C2HumanScorecardSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-human-scorecard"),
  artifactId: StableId,
  runId: StableId,
  runOutputSha256: Sha256,
  reviewerActorId: StableId,
  reviewerActorKind: z.literal("human"),
  blindedCondition: z.literal(true),
  scores: z.array(DimensionScoreSchema).length(6).refine((scores) => hasUniqueStrings(scores.map((score) => score.dimension)), "dimensions must be unique"),
  implementationReady: z.boolean(),
  scoredAt: z.string().datetime(),
}).strict().superRefine((scorecard, ctx) => {
  const meetsFloor = scorecard.scores.every((item) => item.score >= 3);
  if (scorecard.implementationReady !== meetsFloor) ctx.addIssue({ code: "custom", path: ["implementationReady"], message: "implementationReady must equal every dimension meeting the frozen score floor of 3" });
});

export const C2FailureReportSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-failure-report"),
  artifactId: StableId,
  caseId: StableId,
  currentGroundedRunRef: ArtifactFileRefSchema,
  goldEvidenceRunRef: ArtifactFileRefSchema.nullable(),
  correctedLabelRunRef: ArtifactFileRefSchema.nullable(),
  classification: z.enum(["retrieval", "label", "coverage", "synthesis", "safety"]),
  affectedDecisionIds: UniqueNonEmptyStrings,
  affectedEntryIds: z.array(StableId).refine(hasUniqueStrings, "affected entry IDs must be unique"),
  affectedFieldPaths: z.array(NonEmptyText).refine(hasUniqueStrings, "affected field paths must be unique"),
  evidence: UniqueNonEmptyStrings,
  rationale: NonEmptyText,
  classifiedByActorId: StableId,
  classifiedAt: z.string().datetime(),
}).strict().superRefine((failure, ctx) => {
  if (failure.classification === "label" && failure.correctedLabelRunRef === null) ctx.addIssue({ code: "custom", path: ["correctedLabelRunRef"], message: "label failure requires corrected-label shadow run" });
  if (failure.classification === "label" && (failure.affectedEntryIds.length === 0 || failure.affectedFieldPaths.length === 0)) ctx.addIssue({ code: "custom", message: "label failure requires exact affected entries and fields" });
  if (failure.classification !== "label" && (failure.affectedEntryIds.length !== 0 || failure.affectedFieldPaths.length !== 0)) ctx.addIssue({ code: "custom", message: "only label failures may identify retaggable entries and fields" });
  if (["retrieval", "synthesis"].includes(failure.classification) && failure.goldEvidenceRunRef === null) ctx.addIssue({ code: "custom", path: ["goldEvidenceRunRef"], message: `${failure.classification} failure requires gold-evidence run` });
});

export type C2LabelIntegritySelection = z.infer<typeof C2LabelIntegritySelectionSchema>;
export type C2IndependentLabelSubmission = z.infer<typeof C2IndependentLabelSubmissionSchema>;
export type C2LabelAgreementReport = z.infer<typeof C2LabelAgreementReportSchema>;
export type C2EvaluationRunManifest = z.infer<typeof C2EvaluationRunManifestSchema>;
export type C2HumanScorecard = z.infer<typeof C2HumanScorecardSchema>;
export type C2FailureReport = z.infer<typeof C2FailureReportSchema>;
