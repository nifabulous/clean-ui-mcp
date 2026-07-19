import { describe, expect, it } from "vitest";
import {
  C2LabelIntegritySelectionSchema,
  C2IndependentLabelSubmissionSchema,
  C2LabelAgreementReportSchema,
  C2EvaluationRunManifestSchema,
  C2HumanScorecardSchema,
  C2FailureReportSchema,
  assertSubmissionMatchesSelection,
  assertAgreementMatchesSubmissions,
  C2_HARD_GATE_IDS,
} from "./evaluation-contracts.js";

const SHA_64 = "a".repeat(64);
const SHA_40 = "b".repeat(40);

function fileRef(artifactId: string, path: string, sha256: string = SHA_64) {
  return { artifactId, path, sha256 };
}

// ---------------------------------------------------------------------------
// Selection factory
// ---------------------------------------------------------------------------

function makeEntry(index: number, cohort: "reproducible" | "challenge") {
  return {
    entryId: cohort === "reproducible" ? `entry.repro-${index}` : `entry.chal-${index}`,
    cohort,
    stratum: `stratum-${index}`,
    selectionReason: `Reason for entry ${index} in cohort ${cohort}.`,
    imageSha256: SHA_64,
  };
}

function makeSelection() {
  const reproducible = Array.from({ length: 35 }, (_, i) => makeEntry(i, "reproducible"));
  const challenge = Array.from({ length: 5 }, (_, i) => makeEntry(i, "challenge"));
  return {
    schemaVersion: "1.0" as const,
    artifactType: "c2-label-integrity-selection" as const,
    artifactId: "c2-integrity-selection-v1",
    selectionVersion: 1,
    seed: "deterministic-seed-2026-07",
    corpusGitSha: SHA_40,
    corpusSha256: SHA_64,
    entries: [...reproducible, ...challenge],
  };
}

// ---------------------------------------------------------------------------
// Submission factory
// ---------------------------------------------------------------------------

function makeLabel(entryId: string) {
  return {
    entryId,
    patternType: "pattern.hero",
    categories: ["navigation", "layout"],
    components: ["header", "footer"],
    domainTags: ["b2b", "marketing"],
    visualFields: { "field.density": "spacious" },
    groundedClaimIds: ["claim.usage"],
    accessibilityEvidenceIds: ["a11y.contrast"],
    critiqueQuality: "acceptable" as const,
    protectedFieldExpectation: "unchanged" as const,
  };
}

function makeSubmission(role: "Gold Label Owner" | "QA", actorId: string) {
  const selection = makeSelection();
  return {
    schemaVersion: "1.0" as const,
    artifactType: "c2-independent-label-submission" as const,
    artifactId: `c2-submission-${actorId}-v1`,
    selectionArtifactId: selection.artifactId,
    selectionSha256: SHA_64,
    submissionVersion: 1,
    actorId,
    actorKind: "human" as const,
    reviewerRole: role,
    sealedAt: "2026-07-18T10:00:00.000Z",
    labels: selection.entries.map((entry) => makeLabel(entry.entryId)),
  };
}

// ---------------------------------------------------------------------------
// Agreement report factory
// ---------------------------------------------------------------------------

function makeMetrics() {
  return [
    { metricId: "pattern-type-exact-accuracy", value: 0.95, baselineValue: 0.80, requiredFloor: 0.90, passed: true },
    { metricId: "categories-macro-f1", value: 0.90, baselineValue: 0.75, requiredFloor: 0.85, passed: true },
    { metricId: "components-precision", value: 0.92, baselineValue: null, requiredFloor: 0.90, passed: true },
    { metricId: "components-recall", value: 0.80, baselineValue: 0.70, requiredFloor: 0.70, passed: true },
    { metricId: "domain-tags-precision", value: 0.91, baselineValue: null, requiredFloor: 0.90, passed: true },
    { metricId: "domain-tags-recall", value: 0.70, baselineValue: 0.65, requiredFloor: 0.65, passed: true },
    { metricId: "structured-critique-schema-validity", value: 1.0, baselineValue: null, requiredFloor: 1.0, passed: true },
    { metricId: "scorable-recommendation-citation-rate", value: 0.95, baselineValue: null, requiredFloor: 0.90, passed: true },
  ];
}

function makeHardGates() {
  return C2_HARD_GATE_IDS.map((gateId) => ({
    gateId,
    passed: true,
    evidence: `Evidence that gate ${gateId} passed.`,
  }));
}

function makeAgreementReport(
  selection: ReturnType<typeof makeSelection>,
  goldOwner: ReturnType<typeof makeSubmission>,
  qa: ReturnType<typeof makeSubmission>,
) {
  return {
    schemaVersion: "1.0" as const,
    artifactType: "c2-label-agreement-report" as const,
    artifactId: "c2-agreement-report-v1",
    selectionRef: fileRef(selection.artifactId, "corpus/c2/integrity/selection.json"),
    goldOwnerSubmissionRef: fileRef(goldOwner.artifactId, "corpus/c2/integrity/gold-owner-submission.json"),
    qaSubmissionRef: fileRef(qa.artifactId, "corpus/c2/integrity/qa-submission.json"),
    goldOwnerActorId: goldOwner.actorId,
    qaActorId: qa.actorId,
    submissionsUnsealedAt: "2026-07-18T11:00:00.000Z",
    metrics: makeMetrics(),
    hardGates: makeHardGates(),
    disagreementEntryIds: [],
    adjudicationRef: fileRef("c2-adjudication-v1", "corpus/c2/integrity/adjudication.json"),
    terminalOutcome: "Qualified" as const,
  };
}

// ---------------------------------------------------------------------------
// Run manifest factory
// ---------------------------------------------------------------------------

function makeRunManifest(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-evaluation-run",
    artifactId: "c2-run-v1",
    runId: "run-001",
    predecessorRunId: null,
    casePackage: fileRef("c2-package-stablecoin-home-v1", "corpus/c2/stablecoin-home/package.json"),
    condition: "gold-evidence",
    corpusSha256: SHA_64,
    retrievalIndexSha256: SHA_64,
    promptSha256: SHA_64,
    harnessGitSha: SHA_40,
    provider: "acme-provider",
    model: "acme-model-7",
    samplingParameters: { temperature: 0.2, top_p: 0.95, seed: 7 },
    evidenceIds: ["evidence.business-hierarchy"],
    startedAt: "2026-07-18T10:00:00.000Z",
    finishedAt: "2026-07-18T10:05:00.000Z",
    status: "succeeded",
    inputSha256: SHA_64,
    rawOutputSha256: SHA_64,
    parsedOutputSha256: SHA_64,
    promptTokens: 1200,
    completionTokens: 800,
    costUsd: 0.42,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scorecard factory
// ---------------------------------------------------------------------------

function makeScorecard(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-human-scorecard",
    artifactId: "c2-scorecard-v1",
    runId: "run-001",
    runOutputSha256: SHA_64,
    reviewerActorId: "reviewer.gold-1",
    reviewerActorKind: "human",
    blindedCondition: true,
    scores: [
      { dimension: "product-appropriateness", score: 4, rationale: "Appropriate." },
      { dimension: "cross-screen-coherence", score: 4, rationale: "Coherent." },
      { dimension: "implementation-clarity", score: 5, rationale: "Clear." },
      { dimension: "originality", score: 3, rationale: "Original." },
      { dimension: "accessibility-and-failure-states", score: 4, rationale: "Accessible." },
      { dimension: "evidence-discipline", score: 5, rationale: "Disciplined." },
    ],
    implementationReady: true,
    scoredAt: "2026-07-18T12:00:00.000Z",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Failure report factory
// ---------------------------------------------------------------------------

function makeFailureReport(overrides: Partial<Record<string, unknown>> = {}) {
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
    affectedFieldPaths: ["labels.categories"],
    evidence: ["evidence.audit-trail"],
    rationale: "A label inconsistency was found and corrected.",
    classifiedByActorId: "reviewer.qa-1",
    classifiedAt: "2026-07-18T13:00:00.000Z",
    ...overrides,
  };
}

describe("C2 evaluation and attribution contracts", () => {
  it("requires exactly 35 reproducible and 5 challenge entries with unique IDs", () => {
    const selection = makeSelection();
    expect(C2LabelIntegritySelectionSchema.safeParse(selection).success).toBe(true);

    const tooFew = { ...selection, entries: selection.entries.slice(0, 39) };
    expect(C2LabelIntegritySelectionSchema.safeParse(tooFew).success).toBe(false);
  });

  it("keeps independent submissions sealed and role-specific", () => {
    const goldOwner = makeSubmission("Gold Label Owner", "reviewer.gold-1");
    expect(C2IndependentLabelSubmissionSchema.safeParse(goldOwner).success).toBe(true);

    const engineering = { ...goldOwner, reviewerRole: "Engineering" };
    expect(C2IndependentLabelSubmissionSchema.safeParse(engineering).success).toBe(false);
  });

  it("rejects a submission whose entry set differs from the frozen selection", () => {
    const selection = makeSelection();
    const goldOwner = makeSubmission("Gold Label Owner", "reviewer.gold-1");
    expect(() => assertSubmissionMatchesSelection(selection, goldOwner)).not.toThrow();

    const swapped = {
      ...goldOwner,
      labels: goldOwner.labels.map((label, index) =>
        index === 0 ? { ...makeLabel("entry.repro-missing"), entryId: "entry.repro-missing" } : label,
      ),
    };
    expect(() => assertSubmissionMatchesSelection(selection, swapped)).toThrow(/entry IDs do not match selection/);
  });

  it("binds distinct Gold Label Owner and QA submissions in an agreement report", () => {
    const selection = makeSelection();
    const goldOwner = makeSubmission("Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission("QA", "reviewer.qa-1");
    const report = makeAgreementReport(selection, goldOwner, qa);
    expect(C2LabelAgreementReportSchema.safeParse(report).success).toBe(true);

    const sameActor = { ...report, qaActorId: report.goldOwnerActorId };
    expect(C2LabelAgreementReportSchema.safeParse(sameActor).success).toBe(false);
  });

  it("cross-checks agreement hashes, actors, roles, selection, and entry disagreements", () => {
    const selection = makeSelection();
    const goldOwner = makeSubmission("Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission("QA", "reviewer.qa-1");
    const report = makeAgreementReport(selection, goldOwner, qa);
    const hashes = {
      selectionSha256: report.selectionRef.sha256,
      goldOwnerSubmissionSha256: report.goldOwnerSubmissionRef.sha256,
      qaSubmissionSha256: report.qaSubmissionRef.sha256,
    };

    expect(() =>
      assertAgreementMatchesSubmissions(selection, goldOwner, qa, report, hashes),
    ).not.toThrow();

    const swappedRoles: typeof goldOwner = { ...qa, reviewerRole: "Gold Label Owner" };
    const swappedGold: typeof goldOwner = { ...goldOwner, reviewerRole: "QA" };
    expect(() =>
      assertAgreementMatchesSubmissions(selection, swappedRoles, swappedGold, report, hashes),
    ).toThrow(/role|actor|reference/);

    const wrongHash = { ...hashes, goldOwnerSubmissionSha256: "c".repeat(64) };
    expect(() =>
      assertAgreementMatchesSubmissions(selection, goldOwner, qa, report, wrongHash),
    ).toThrow(/hash/);

    const unselectedDisagreement: typeof report = {
      ...report,
      disagreementEntryIds: ["entry.missing-1"],
    };
    expect(() =>
      assertAgreementMatchesSubmissions(selection, goldOwner, qa, unselectedDisagreement, hashes),
    ).toThrow(/disagreement/);
  });

  it("rejects a report that lowers a parent-authority metric floor", () => {
    const selection = makeSelection();
    const goldOwner = makeSubmission("Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission("QA", "reviewer.qa-1");
    const report = makeAgreementReport(selection, goldOwner, qa);
    const loweredMetrics = report.metrics.map((metric) =>
      metric.metricId === "categories-macro-f1"
        ? { ...metric, requiredFloor: 0.80, baselineValue: 0.75, passed: true }
        : metric,
    );
    const lowered = { ...report, metrics: loweredMetrics };
    expect(C2LabelAgreementReportSchema.safeParse(lowered).success).toBe(false);
  });

  it("forbids gold evidence in a brief-only run and requires it in gold-evidence", () => {
    const briefOnly = makeRunManifest({
      artifactId: "c2-run-brief-only-v1",
      runId: "run-brief-only",
      condition: "brief-only",
      evidenceIds: [],
      status: "succeeded",
    });
    expect(C2EvaluationRunManifestSchema.safeParse(briefOnly).success).toBe(true);

    const briefOnlyWithEvidence = { ...briefOnly, evidenceIds: ["evidence.business-hierarchy"] };
    expect(C2EvaluationRunManifestSchema.safeParse(briefOnlyWithEvidence).success).toBe(false);

    const goldEvidence = makeRunManifest({
      artifactId: "c2-run-gold-v1",
      runId: "run-gold",
      condition: "gold-evidence",
      evidenceIds: ["evidence.business-hierarchy"],
      status: "succeeded",
    });
    expect(C2EvaluationRunManifestSchema.safeParse(goldEvidence).success).toBe(true);

    const goldEvidenceEmpty = { ...goldEvidence, evidenceIds: [] };
    expect(C2EvaluationRunManifestSchema.safeParse(goldEvidenceEmpty).success).toBe(false);
  });

  it("enforces the run lifecycle as a closed state machine", () => {
    const running = makeRunManifest({
      artifactId: "c2-run-running-v1",
      runId: "run-running",
      condition: "brief-only",
      evidenceIds: [],
      status: "running",
      finishedAt: null,
      rawOutputSha256: null,
      parsedOutputSha256: null,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
    });
    expect(C2EvaluationRunManifestSchema.safeParse(running).success).toBe(true);

    const runningWithFinishedAt = { ...running, finishedAt: "2026-07-18T10:05:00.000Z" };
    expect(C2EvaluationRunManifestSchema.safeParse(runningWithFinishedAt).success).toBe(false);

    const succeeded = makeRunManifest({
      artifactId: "c2-run-succeeded-v1",
      runId: "run-succeeded",
      status: "succeeded",
    });
    expect(C2EvaluationRunManifestSchema.safeParse(succeeded).success).toBe(true);

    const succeededNoParsed = { ...succeeded, parsedOutputSha256: null };
    expect(C2EvaluationRunManifestSchema.safeParse(succeededNoParsed).success).toBe(false);

    const costBlocked = makeRunManifest({
      artifactId: "c2-run-cost-blocked-v1",
      runId: "run-cost-blocked",
      condition: "brief-only",
      evidenceIds: [],
      status: "cost-blocked",
      finishedAt: null,
      rawOutputSha256: null,
      parsedOutputSha256: null,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
    });
    expect(C2EvaluationRunManifestSchema.safeParse(costBlocked).success).toBe(true);

    const costBlockedWithTokens = { ...costBlocked, promptTokens: 1 };
    expect(C2EvaluationRunManifestSchema.safeParse(costBlockedWithTokens).success).toBe(false);

    // failed state: requires finishedAt, forbids parsedOutputSha256, permits rawOutputSha256.
    const failed = makeRunManifest({
      artifactId: "c2-run-failed-v1",
      runId: "run-failed",
      status: "failed",
      finishedAt: "2026-07-18T10:05:00.000Z",
      rawOutputSha256: "a".repeat(64),
      parsedOutputSha256: null,
    });
    expect(C2EvaluationRunManifestSchema.safeParse(failed).success).toBe(true);

    const failedWithParsed = { ...failed, parsedOutputSha256: "b".repeat(64) };
    expect(C2EvaluationRunManifestSchema.safeParse(failedWithParsed).success).toBe(false);

    const failedNoFinish = { ...failed, finishedAt: null };
    expect(C2EvaluationRunManifestSchema.safeParse(failedNoFinish).success).toBe(false);
  });

  it("requires six unique human-score dimensions with integer scores 1 through 5", () => {
    const scorecard = makeScorecard();
    expect(C2HumanScorecardSchema.safeParse(scorecard).success).toBe(true);

    const scoreTooHigh = {
      ...scorecard,
      scores: scorecard.scores.map((s) =>
        s.dimension === "implementation-clarity" ? { ...s, score: 6 } : s,
      ),
    };
    expect(C2HumanScorecardSchema.safeParse(scoreTooHigh).success).toBe(false);
  });

  it("derives implementation readiness from the frozen per-dimension floor", () => {
    const belowFloor = {
      ...makeScorecard(),
      scores: [
        { dimension: "product-appropriateness", score: 2, rationale: "Weak." },
        { dimension: "cross-screen-coherence", score: 4, rationale: "Coherent." },
        { dimension: "implementation-clarity", score: 5, rationale: "Clear." },
        { dimension: "originality", score: 3, rationale: "Original." },
        { dimension: "accessibility-and-failure-states", score: 4, rationale: "Accessible." },
        { dimension: "evidence-discipline", score: 5, rationale: "Disciplined." },
      ],
      implementationReady: true,
    };
    expect(C2HumanScorecardSchema.safeParse(belowFloor).success).toBe(false);
  });

  it("requires corrected-label evidence before classifying a label failure", () => {
    const valid = makeFailureReport();
    expect(C2FailureReportSchema.safeParse(valid).success).toBe(true);

    const noCorrected = { ...valid, correctedLabelRunRef: null };
    expect(C2FailureReportSchema.safeParse(noCorrected).success).toBe(false);
  });
});
