// Cross-validation: the helper script's metric math MUST match production
// computeLabelAgreement (src/c2/label-agreement.ts) to floating-point equality.
//
// This test constructs the same fixtures the production test suite uses, runs
// BOTH computeLabelAgreement and the script's computeFourBaselineMetrics on the
// same gold/qa label arrays, and asserts the four baseline-bound metric values
// are identical. If you ever edit the script's math, this test catches drift.
import { describe, expect, it } from "vitest";
import { writeFileSync, mkdtempSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { computeLabelAgreement } from "../dist/c2/label-agreement.js";
import { computeFourBaselineMetrics, alignByEntryId, extractLabels } from "./compute-baseline-metrics.mjs";

function tmpFile(name) {
  const tmp = mkdtempSync(join(tmpdir(), "cbm-"));
  return join(tmp, name);
}

// --- fixtures (mirror src/c2/label-agreement.test.ts) -----------------------

const SHA_64 = "a".repeat(64);
const SELECTION_SHA = "1".repeat(64);
const GOLD_SUBMISSION_SHA = "2".repeat(64);
const QA_SUBMISSION_SHA = "3".repeat(64);
const BASELINE_SHA = "4".repeat(64);
const ADJUDICATION_SHA = "5".repeat(64);

function fileRef(artifactId, path, sha256 = SHA_64) {
  return { artifactId, path, sha256 };
}

function makeSelectionEntry(index, cohort) {
  return {
    entryId: cohort === "reproducible" ? `entry.repro-${index}` : `entry.chal-${index}`,
    cohort,
    stratum: `stratum-${index}`,
    selectionReason: `Reason for entry ${index} in cohort ${cohort}.`,
    imageSha256: SHA_64,
  };
}

function makeSelection() {
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

function makeLabel(entryId, overrides = {}) {
  return {
    entryId,
    patternType: "pattern.hero",
    categories: ["navigation", "layout"],
    components: ["header", "footer"],
    domainTags: ["b2b", "marketing"],
    visualFields: { "field.density": "spacious" },
    groundedClaimIds: ["claim.usage"],
    accessibilityEvidenceIds: ["a11y.contrast"],
    critiqueQuality: "acceptable",
    protectedFieldExpectation: "unchanged",
    ...overrides,
  };
}

function makeSubmission(selection, role, actorId, labelOverrides = {}) {
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

function makeBaselineMetrics(overrides = {}) {
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

function makeResolvedHashes() {
  return {
    selectionSha256: SELECTION_SHA,
    goldOwnerSubmissionSha256: GOLD_SUBMISSION_SHA,
    qaSubmissionSha256: QA_SUBMISSION_SHA,
    baselineMetricsSha256: BASELINE_SHA,
    adjudicationSha256: ADJUDICATION_SHA,
  };
}

// Helper: run production computeLabelAgreement and extract the four baseline
// metric values keyed by metricId.
function productionMetrics(gold, qa, selection) {
  const report = computeLabelAgreement(gold, qa, selection, makeBaselineMetrics(), makeResolvedHashes());
  const byId = Object.fromEntries(report.metrics.map((m) => [m.metricId, m.value]));
  return {
    "pattern-type-exact-accuracy": byId["pattern-type-exact-accuracy"],
    "categories-macro-f1": byId["categories-macro-f1"],
    "components-recall": byId["components-recall"],
    "domain-tags-recall": byId["domain-tags-recall"],
  };
}

// --- tests ------------------------------------------------------------------

describe("compute-baseline-metrics parity with production computeLabelAgreement", () => {
  it("matches when both submissions are identical (all four = 1.0)", () => {
    const selection = makeSelection();
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1");
    const prod = productionMetrics(gold, qa, selection);
    const script = computeFourBaselineMetrics(gold.labels, qa.labels);
    expect(script["pattern-type-exact-accuracy"]).toBe(prod["pattern-type-exact-accuracy"]);
    expect(script["categories-macro-f1"]).toBe(prod["categories-macro-f1"]);
    expect(script["components-recall"]).toBe(prod["components-recall"]);
    expect(script["domain-tags-recall"]).toBe(prod["domain-tags-recall"]);
    // sanity: identical submissions → all 1.0
    for (const v of Object.values(script)) expect(v).toBe(1);
  });

  it("matches when patternType disagrees on 5 entries (0.875)", () => {
    const selection = makeSelection();
    const overrides = {};
    const disagreeing = selection.entries.slice(0, 5);
    for (const e of disagreeing) {
      overrides[e.entryId] = makeLabel(e.entryId, { patternType: "pattern.different" });
    }
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1", overrides);
    const prod = productionMetrics(gold, qa, selection);
    const script = computeFourBaselineMetrics(gold.labels, qa.labels);
    expect(script["pattern-type-exact-accuracy"]).toBe(prod["pattern-type-exact-accuracy"]);
    expect(script["categories-macro-f1"]).toBe(prod["categories-macro-f1"]);
    expect(script["components-recall"]).toBe(prod["components-recall"]);
    expect(script["domain-tags-recall"]).toBe(prod["domain-tags-recall"]);
    expect(script["pattern-type-exact-accuracy"]).toBeCloseTo(0.875, 10);
  });

  it("matches when categories/components/domainTags diverge across many entries", () => {
    const selection = makeSelection();
    const overrides = {};
    // Diverge categories on 8, components on 6, domainTags on 4, patternType on 3.
    const entries = selection.entries;
    for (const e of entries.slice(0, 8)) overrides[e.entryId] = { ...(overrides[e.entryId] ?? makeLabel(e.entryId)), categories: ["layout", "forms"] };
    for (const e of entries.slice(0, 6)) overrides[e.entryId] = { ...(overrides[e.entryId] ?? makeLabel(e.entryId)), components: ["sidebar", "footer"] };
    for (const e of entries.slice(0, 4)) overrides[e.entryId] = { ...(overrides[e.entryId] ?? makeLabel(e.entryId)), domainTags: ["b2c", "sales"] };
    for (const e of entries.slice(0, 3)) overrides[e.entryId] = { ...(overrides[e.entryId] ?? makeLabel(e.entryId)), patternType: "pattern.other" };
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1", overrides);
    const prod = productionMetrics(gold, qa, selection);
    const script = computeFourBaselineMetrics(gold.labels, qa.labels);
    expect(script["pattern-type-exact-accuracy"]).toBe(prod["pattern-type-exact-accuracy"]);
    expect(script["categories-macro-f1"]).toBe(prod["categories-macro-f1"]);
    expect(script["components-recall"]).toBe(prod["components-recall"]);
    expect(script["domain-tags-recall"]).toBe(prod["domain-tags-recall"]);
    // sanity: not all 1.0 (there is real disagreement)
    expect(script["pattern-type-exact-accuracy"]).toBeLessThan(1);
    expect(script["categories-macro-f1"]).toBeLessThan(1);
  });

  it("matches when qa has empty component/domain sets on some entries (divide-by-zero path)", () => {
    const selection = makeSelection();
    const overrides = {};
    for (const e of selection.entries.slice(0, 10)) {
      overrides[e.entryId] = makeLabel(e.entryId, { components: [], domainTags: [] });
    }
    const gold = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const qa = makeSubmission(selection, "QA", "reviewer.qa-1", overrides);
    const prod = productionMetrics(gold, qa, selection);
    const script = computeFourBaselineMetrics(gold.labels, qa.labels);
    expect(script["components-recall"]).toBe(prod["components-recall"]);
    expect(script["domain-tags-recall"]).toBe(prod["domain-tags-recall"]);
  });
});

describe("alignByEntryId duplicate-entryId guard", () => {
  it("throws when gold has a duplicate entryId (bare-label input path)", () => {
    const selection = makeSelection();
    const labels = selection.entries.map((e) => makeLabel(e.entryId));
    // Duplicate the first entry's entryId on the second entry.
    const dupGold = [...labels];
    dupGold[1] = { ...dupGold[1], entryId: dupGold[0].entryId };
    expect(() => alignByEntryId(dupGold, labels)).toThrow(/duplicate entryId.*entry labels must be unique/);
  });

  it("throws when qa has a duplicate entryId", () => {
    const selection = makeSelection();
    const labels = selection.entries.map((e) => makeLabel(e.entryId));
    const dupQa = [...labels];
    dupQa[2] = { ...dupQa[2], entryId: dupQa[1].entryId };
    expect(() => alignByEntryId(labels, dupQa)).toThrow(/duplicate entryId.*entry labels must be unique/);
  });

  it("does not throw when all entryIds are unique", () => {
    const selection = makeSelection();
    const labels = selection.entries.map((e) => makeLabel(e.entryId));
    expect(() => alignByEntryId(labels, labels)).not.toThrow();
  });

  it("throws when gold and qa label different entryId sets (mismatch)", () => {
    const selection = makeSelection();
    const labels = selection.entries.map((e) => makeLabel(e.entryId));
    // qa is missing entry.repro-0, has an extra entry.repro-99.
    const qaMinus = labels.slice(1);
    const qaPlus = [...qaMinus, makeLabel("entry.repro-99")];
    expect(() => alignByEntryId(labels, qaPlus)).toThrow(/entryId mismatch between files/);
    expect(() => alignByEntryId(labels, qaPlus)).toThrow(/entry\.repro-0/);
    expect(() => alignByEntryId(labels, qaPlus)).toThrow(/entry\.repro-99/);
  });
});

describe("extractLabels input shapes", () => {
  it("parses a full C2IndependentLabelSubmission artifact (validates through schema)", () => {
    const selection = makeSelection();
    const sub = makeSubmission(selection, "Gold Label Owner", "reviewer.gold-1");
    const file = tmpFile("sub.json");
    writeFileSync(file, JSON.stringify(sub));
    const extracted = extractLabels(file);
    expect(extracted).toHaveLength(40);
    expect(extracted[0].entryId).toBe(sub.labels[0].entryId);
  });

  it("parses a bare { labels: [...] } object", () => {
    const selection = makeSelection();
    const labels = selection.entries.map((e) => makeLabel(e.entryId));
    const file = tmpFile("bare-labels.json");
    writeFileSync(file, JSON.stringify({ labels }));
    const extracted = extractLabels(file);
    expect(extracted).toHaveLength(40);
    expect(extracted[0].entryId).toBe(labels[0].entryId);
  });

  it("parses a bare array of labels", () => {
    const selection = makeSelection();
    const labels = selection.entries.map((e) => makeLabel(e.entryId));
    const file = tmpFile("bare-array.json");
    writeFileSync(file, JSON.stringify(labels));
    const extracted = extractLabels(file);
    expect(extracted).toHaveLength(40);
  });

  it("throws on an unrecognized shape", () => {
    const file = tmpFile("bad.json");
    writeFileSync(file, JSON.stringify({ foo: "bar" }));
    expect(() => extractLabels(file)).toThrow(/expected a C2IndependentLabelSubmission artifact/);
  });

  it("rejects a bare label with invalid shape (categories as string, not array)", () => {
    const selection = makeSelection();
    const labels = selection.entries.map((e) => makeLabel(e.entryId));
    // Corrupt one label: categories as a string instead of an array.
    labels[5] = { ...labels[5], categories: "navigation" };
    const file = tmpFile("bad-label.json");
    writeFileSync(file, JSON.stringify({ labels }));
    expect(() => extractLabels(file)).toThrow(/failed EntryLabelSchema/);
  });
});

describe("CLI --json output", () => {
  it("emits the four metrics + counts as machine-readable JSON", () => {
    const selection = makeSelection();
    const labels = selection.entries.map((e) => makeLabel(e.entryId));
    const a = tmpFile("a.json");
    const b = tmpFile("b.json");
    writeFileSync(a, JSON.stringify({ labels }));
    writeFileSync(b, JSON.stringify({ labels }));
    const out = execFileSync("node", [join(process.cwd(), "scripts/compute-baseline-metrics.mjs"), a, b, "--json"], { encoding: "utf-8" });
    const parsed = JSON.parse(out);
    expect(parsed["pattern-type-exact-accuracy"]).toBe(1);
    expect(parsed["categories-macro-f1"]).toBe(1);
    expect(parsed["components-recall"]).toBe(1);
    expect(parsed["domain-tags-recall"]).toBe(1);
    expect(parsed.entryCount).toBe(40);
    expect(parsed.disagreementCount).toBe(0);
  });
});

describe("missing-schema fail-closed", () => {
  it("exits 1 with an actionable error when dist schemas cannot be loaded", () => {
    // The dist import resolves relative to the script file (../dist/...).
    // Copy the script to a temp dir where ../dist/ does not exist, then run it
    // as a subprocess and assert it fails closed with the build hint.
    const tmp = mkdtempSync(join(tmpdir(), "cbm-nodist-"));
    const scriptCopy = join(tmp, "compute-baseline-metrics.mjs");
    copyFileSync(join(process.cwd(), "scripts/compute-baseline-metrics.mjs"), scriptCopy);
    let err;
    try {
      execFileSync("node", [scriptCopy, "/dev/null", "/dev/null"], { encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err.status).toBe(1);
    const stderr = err.stderr || "";
    expect(stderr).toMatch(/cannot load production schemas/i);
    expect(stderr).toMatch(/npm run build|npx tsc/);
  });
});
