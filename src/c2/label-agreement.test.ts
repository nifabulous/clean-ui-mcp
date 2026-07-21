import { describe, expect, it } from "vitest";
import {
  C2LabelAgreementReportSchema,
  C2_HARD_GATE_IDS,
  type C2LabelIntegritySelection,
  type C2IndependentLabelSubmission,
  type C2LabelIntegrityBaselineMetrics,
} from "./evaluation-contracts.js";
import { computeLabelAgreement } from "./label-agreement.js";

// ---------------------------------------------------------------------------
// Constants + fixtures
// ---------------------------------------------------------------------------

const SHA_64 = "a".repeat(64);
const SHA_64_B = "b".repeat(64);
const SELECTION_SHA = "1".repeat(64);
const GOLD_SUBMISSION_SHA = "2".repeat(64);
const QA_SUBMISSION_SHA = "3".repeat(64);
const BASELINE_SHA = "4".repeat(64);
const ADJUDICATION_SHA = "5".repeat(64);

function fileRef(artifactId: string, path: string, sha256: string = SHA_64) {
  return { artifactId, path, sha256 };
}

// ---------------------------------------------------------------------------
// Selection factory — 40 entries (35 reproducible + 5 challenge)
// ---------------------------------------------------------------------------

function makeSelectionEntry(index: number, cohort: "reproducible" | "challenge") {
  return {
    entryId: cohort === "reproducible" ? `entry.repro-${index}` : `entry.chal-${index}`,
    cohort,
    stratum: `stratum-${index}`,
    selectionReason: `Reason for entry ${index} in cohort ${cohort}.`,
    imageSha256: SHA_64,
  };
}

function makeSelection(): C2LabelIntegritySelection {
  const reproducible = Array.from({ length: 35 }, (_, i) => makeSelectionEntry(i, "reproducible"));
  const challenge = Array.from({ length: 5 }, (_, i) => makeSelectionEntry(i, "challenge"));
  return {
    schemaVersion: "1.0",
    artifactType: "c2-label-integrity-selection",
    artifactId: "c2-integrity-selection-v1",
    selectionVersion: 1,
    seed: "clean-ui-retag-v1",
    corpusGitSha: "0".repeat(40),
    corpusSha256: SHA_64,
    entries: [...reproducible, ...challenge],
  };
}

// ---------------------------------------------------------------------------
// Label + submission factories
// ---------------------------------------------------------------------------

function makeLabel(entryId: string, overrides: Partial<Record<string, unknown>> = {}) {
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
    ...overrides,
  };
}

function makeSubmission(
  selection: C2LabelIntegritySelection,
  role: "Gold Label Owner" | "QA",
  actorId: string,
  labelOverrides: Record<string, ReturnType<typeof makeLabel>> = {},
): C2IndependentLabelSubmission {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-independent-label-submission",
    artifactId: `c2-submission-${actorId}-v1`,
    selectionArtifactId: selection.artifactId,
    selectionSha256: SELECTION_SHA,
    submissionVersion: 1,
    actorId,
    actorKind: "human",
    reviewerRole: role,
    sealedAt: "2026-07-18T10:00:00.000Z",
    labels: selection.entries.map((entry) => labelOverrides[entry.entryId] ?? makeLabel(entry.entryId)),
  };
}

// ---------------------------------------------------------------------------
// Baseline-metrics factory
// ---------------------------------------------------------------------------

function makeBaselineMetrics(overrides: Partial<C2LabelIntegrityBaselineMetrics> = {}): C2LabelIntegrityBaselineMetrics {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-label-integrity-baseline-metrics",
    artifactId: "c2-baseline-metrics-v1",
    selectionArtifactId: "c2-integrity-selection-v1",
    selectionSha256: SELECTION_SHA,
    "pattern-type-exact-accuracy": 0.80,
    "categories-macro-f1": 0.75,
    "components-recall": 0.70,
    "domain-tags-recall": 0.65,
    sourceArtifactRefs: [fileRef("c2-parent-baseline-v1", "corpus/c2/integrity/parent-baseline.json")],
    computedAt: "2026-07-18T09:00:00.000Z",
    baselineMetricsSha256: BASELINE_SHA,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Resolved hashes (what a caller would compute over the canonical bytes)
// ---------------------------------------------------------------------------

function makeResolvedHashes() {
  return {
    selectionSha256: SELECTION_SHA,
    goldOwnerSubmissionSha256: GOLD_SUBMISSION_SHA,
    qaSubmissionSha256: QA_SUBMISSION_SHA,
    baselineMetricsSha256: BASELINE_SHA,
    adjudicationSha256: ADJUDICATION_SHA,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("computeLabelAgreement", () => {
  it("returns Qualified when both submissions are identical (all metrics = 1.0, all gates pass)", () => {
    const selection = makeSelection();
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1");
    const baseline = makeBaselineMetrics();

    const report = computeLabelAgreement(
      gold,
      qa,
      selection,
      baseline,
      makeResolvedHashes(),
    );

    expect(report.terminalOutcome).toBe("Qualified");
    expect(report.metrics).toHaveLength(8);
    expect(report.hardGates).toHaveLength(8);
    // All 8 metrics pass with value 1.0 (identical submissions).
    for (const metric of report.metrics) {
      expect(metric.value).toBe(1);
      expect(metric.passed).toBe(true);
    }
    for (const gate of report.hardGates) {
      expect(gate.passed).toBe(true);
    }
    expect(report.disagreementEntryIds).toEqual([]);
    // The report MUST validate through the agreement schema.
    expect(C2LabelAgreementReportSchema.safeParse(report).success).toBe(true);
  });

  it("fails to Qualified when patternType disagrees on enough entries to drop below 0.90", () => {
    const selection = makeSelection();
    // 5 disagreements → 35/40 = 0.875 < 0.90 → pattern-type-exact-accuracy fails.
    const tamperedLabels: Record<string, ReturnType<typeof makeLabel>> = {};
    for (let i = 0; i < 5; i++) {
      const entryId = `entry.repro-${i}`;
      tamperedLabels[entryId] = makeLabel(entryId, { patternType: "pattern.different" });
    }
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1", tamperedLabels);
    const baseline = makeBaselineMetrics();

    const report = computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes());

    expect(report.terminalOutcome).toBe("Replacement not justified");
    const ptea = report.metrics.find((m) => m.metricId === "pattern-type-exact-accuracy")!;
    expect(ptea.value).toBeCloseTo(0.875, 5);
    expect(ptea.passed).toBe(false);
    // The 5 tampered entries must appear in disagreementEntryIds.
    for (let i = 0; i < 5; i++) {
      expect(report.disagreementEntryIds).toContain(`entry.repro-${i}`);
    }
  });

  it("rejects same-actor submissions", () => {
    const selection = makeSelection();
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.same");
    const qa = makeSubmission(selection, "QA", "reviewer.same");
    const baseline = makeBaselineMetrics();

    expect(() =>
      computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes()),
    ).toThrow(/actor|independent/i);
  });

  it("rejects same-role submissions (both Gold Label Owner)", () => {
    const selection = makeSelection();
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "Gold Label Owner", "reviewer.qa-1");
    const baseline = makeBaselineMetrics();

    expect(() =>
      computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes()),
    ).toThrow(/role/i);
  });

  it("rejects submissions whose selectionSha256 disagree", () => {
    const selection = makeSelection();
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa: C2IndependentLabelSubmission = {
      ...makeSubmission(selection, "QA", "reviewer.qa-1"),
      selectionSha256: "f".repeat(64),
    };
    const baseline = makeBaselineMetrics();

    expect(() =>
      computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes()),
    ).toThrow(/selection/);
  });

  it("throws when baseline metrics are missing (cannot compute recall floors)", () => {
    const selection = makeSelection();
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1");

    expect(() =>
      // @ts-expect-error — intentionally passing null baseline.
      computeLabelAgreement(gold, qa, selection, null, makeResolvedHashes()),
    ).toThrow(/baseline/i);
  });

  it("fails to Qualified when a hard gate fails (unsupported accessibility claim)", () => {
    const selection = makeSelection();
    // Trip gate 5 (`no-unsupported-accessibility-absence-or-icon-only-claims`):
    // mention accessibility in visualFields but leave accessibilityEvidenceIds
    // empty. The schema permits an empty array, but the structural gate catches
    // the unsupported claim.
    const tamperedLabels: Record<string, ReturnType<typeof makeLabel>> = {};
    const entryId = "entry.repro-0";
    tamperedLabels[entryId] = {
      ...makeLabel(entryId),
      visualFields: { "field.accessibility": "icon-only navigation" },
      accessibilityEvidenceIds: [],
    };
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1", tamperedLabels);
    const baseline = makeBaselineMetrics();

    const report = computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes());

    expect(report.terminalOutcome).toBe("Replacement not justified");
    const a11yGate = report.hardGates.find(
      (g) => g.gateId === "no-unsupported-accessibility-absence-or-icon-only-claims",
    )!;
    expect(a11yGate.passed).toBe(false);
  });

  it("records entries where any metric-relevant field differs in disagreementEntryIds", () => {
    const selection = makeSelection();
    const tamperedLabels: Record<string, ReturnType<typeof makeLabel>> = {};
    // entry.repro-0: patternType differs.
    tamperedLabels["entry.repro-0"] = makeLabel("entry.repro-0", { patternType: "pattern.other" });
    // entry.repro-1: categories differ (still 1 of 2 overlapping → macro-f1 partial).
    tamperedLabels["entry.repro-1"] = makeLabel("entry.repro-1", { categories: ["layout", "forms"] });
    // entry.repro-2: components differ.
    tamperedLabels["entry.repro-2"] = makeLabel("entry.repro-2", { components: ["sidebar", "footer"] });
    // entry.repro-3: domainTags differ.
    tamperedLabels["entry.repro-3"] = makeLabel("entry.repro-3", { domainTags: ["b2c", "sales"] });

    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1", tamperedLabels);
    const baseline = makeBaselineMetrics();

    const report = computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes());

    expect(report.disagreementEntryIds).toEqual(
      expect.arrayContaining([
        "entry.repro-0",
        "entry.repro-1",
        "entry.repro-2",
        "entry.repro-3",
      ]),
    );
    // No more than these 4.
    expect(report.disagreementEntryIds).toHaveLength(4);
  });

  it("binds the baselineMetricsRef to the supplied baseline-metrics artifact", () => {
    const selection = makeSelection();
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1");
    const baseline = makeBaselineMetrics();

    const report = computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes());

    expect(report.baselineMetricsRef.artifactId).toBe(baseline.artifactId);
    expect(report.baselineMetricsRef.sha256).toBe(BASELINE_SHA);
  });

  it("uses the baseline value (not a fixed floor) for the two recall metrics", () => {
    const selection = makeSelection();
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1");
    // Baseline recall floors at 0.70 and 0.65; identical submissions recall = 1.0.
    const baseline = makeBaselineMetrics({
      "components-recall": 0.70,
      "domain-tags-recall": 0.65,
    });

    const report = computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes());

    const componentsRecall = report.metrics.find((m) => m.metricId === "components-recall")!;
    const domainRecall = report.metrics.find((m) => m.metricId === "domain-tags-recall")!;
    expect(componentsRecall.requiredFloor).toBe(0.70);
    expect(componentsRecall.baselineValue).toBe(0.70);
    expect(domainRecall.requiredFloor).toBe(0.65);
    expect(domainRecall.baselineValue).toBe(0.65);

    // For pattern-type-exact-accuracy (fixed 0.90) and categories-macro-f1 (fixed 0.85),
    // the effective floor is max(fixedFloor, baselineValue).
    const ptea = report.metrics.find((m) => m.metricId === "pattern-type-exact-accuracy")!;
    const macro = report.metrics.find((m) => m.metricId === "categories-macro-f1")!;
    expect(ptea.requiredFloor).toBe(Math.max(0.90, 0.80));
    expect(macro.requiredFloor).toBe(Math.max(0.85, 0.75));
  });

  it("always returns exactly the 8 required hard-gate IDs", () => {
    const selection = makeSelection();
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1");
    const baseline = makeBaselineMetrics();

    const report = computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes());

    const gateIds = report.hardGates.map((g) => g.gateId).sort();
    expect(gateIds).toEqual([...C2_HARD_GATE_IDS].sort());
  });

  // P1/S7: WCAG gate must fire on a malformed (4+ component) identifier. The old
  // implementation used two functionally identical regexes, so the gate was dead
  // code. The new implementation narrows WCAG_WELLFORMED to accept only 1-3
  // numeric components, so "wcag 1.4.3.5" (4 components) is detected by
  // WCAG_PATTERN but rejected by WCAG_WELLFORMED → gate 6 fails → not Qualified.
  it("fails to Qualified when visualFields contains a malformed WCAG identifier (4+ components)", () => {
    const selection = makeSelection();
    const tamperedLabels: Record<string, ReturnType<typeof makeLabel>> = {};
    const entryId = "entry.repro-0";
    tamperedLabels[entryId] = {
      ...makeLabel(entryId),
      visualFields: { "field.conformance": "wcag 1.4.3.5" },
      accessibilityEvidenceIds: ["a11y.contrast"],
    };
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1", tamperedLabels);
    const baseline = makeBaselineMetrics();

    const report = computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes());

    expect(report.terminalOutcome).toBe("Replacement not justified");
    const wcagGate = report.hardGates.find((g) => g.gateId === "valid-wcag-identifiers")!;
    expect(wcagGate.passed).toBe(false);
  });

  // A well-formed WCAG identifier (1-3 components) must NOT trip the gate.
  it("passes the WCAG gate for a well-formed identifier (3 components)", () => {
    const selection = makeSelection();
    const tamperedLabels: Record<string, ReturnType<typeof makeLabel>> = {};
    const entryId = "entry.repro-0";
    tamperedLabels[entryId] = {
      ...makeLabel(entryId),
      visualFields: { "field.conformance": "wcag 1.4.3" },
      accessibilityEvidenceIds: ["a11y.contrast"],
    };
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1", tamperedLabels);
    const baseline = makeBaselineMetrics();

    const report = computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes());

    const wcagGate = report.hardGates.find((g) => g.gateId === "valid-wcag-identifiers")!;
    expect(wcagGate.passed).toBe(true);
  });

  // S6: the banned-phrase list must not misfire on "tbd" inside a legitimate
  // label (e.g. todo-app, TBD-ld-cohort). The narrowed list drops "tbd".
  it("does not trip no-banned-phrases on a label containing the substring 'tbd' (narrowed list)", () => {
    const selection = makeSelection();
    const tamperedLabels: Record<string, ReturnType<typeof makeLabel>> = {};
    const entryId = "entry.repro-0";
    tamperedLabels[entryId] = {
      ...makeLabel(entryId),
      domainTags: ["tbd-app", "productivity"],
    };
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1", tamperedLabels);
    const baseline = makeBaselineMetrics();

    const report = computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes());

    const bannedGate = report.hardGates.find((g) => g.gateId === "no-banned-phrases")!;
    expect(bannedGate.passed).toBe(true);
  });

  // S9: the two roles must not only be distinct, they must be in the canonical
  // order: gold == "Gold Label Owner", qa == "QA". A swapped pair must throw.
  it("rejects submissions with roles in the wrong order (gold=QA, qa=Gold)", () => {
    const selection = makeSelection();
    const gold = makeSubmission(selection, "QA", "reviewer.gold-1");
    const qa = makeSubmission(selection, "Gold Label Owner", "reviewer.qa-1");
    const baseline = makeBaselineMetrics();

    expect(() =>
      computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes()),
    ).toThrow(/role/i);
  });

  // P2: baseline.selectionSha256 must match the resolved selection hash; a
  // baseline computed against a different selection revision is rejected.
  it("throws when baseline.selectionSha256 disagrees with the resolved selection hash", () => {
    const selection = makeSelection();
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1");
    const baseline = makeBaselineMetrics({
      selectionSha256: "f".repeat(64),
    });

    expect(() =>
      computeLabelAgreement(gold, qa, selection, baseline, makeResolvedHashes()),
    ).toThrow(/baseline.selectionSha256|baseline.*selection/i);
  });
});
