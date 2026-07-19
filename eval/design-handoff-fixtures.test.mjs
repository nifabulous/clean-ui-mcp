import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// P1 #2 (PR #35 review): the shipped gold briefs and labels were never exercised
// by the gate. `design-handoff-scorer.test.mjs` uses an inline GOLD_LABEL, so
// CI stayed green no matter what happened to the real eval/*.json files. This
// suite loads the checked-in artifacts and enforces:
//   - both files parse as JSON with the expected top-level shape
//   - exactly 12 briefs and 12 labels
//   - 1:1 id matching between briefs and labels (no dupes, no orphans)
//   - the 12 expected strata are all present
//   - each label has the scorer's required fields (so a label the scorer would
//     reject as malformed fails here, not just silently at score time)
//   - every label's requiredDecisions and validEvidenceIds reconcile: required
//     decision ids must be a subset of validEvidenceIds (a decision with no
//     backing evidence can never be supported).
//
// If the artifacts drift, duplicate ids, lose labels, or become incompatible
// with the scorer, THIS test fails — not just an inline synthetic.

const __dirname = dirname(fileURLToPath(import.meta.url));
const LABELS_PATH = resolve(__dirname, "design-handoff-labels.json");
const BRIEFS_PATH = resolve(__dirname, "design-handoff-fixtures", "briefs.json");

const labelsDoc = JSON.parse(readFileSync(LABELS_PATH, "utf8"));
const briefsDoc = JSON.parse(readFileSync(BRIEFS_PATH, "utf8"));

// The scorer requires these label fields to be arrays (see isValidGoldLabel in
// scripts/design-handoff-scorer.mjs) plus the scalars/enum it validates.
const REQUIRED_LABEL_ARRAY_FIELDS = [
  "requiredSections",
  "requiredDecisions",
  "requiredAcceptanceCriteria",
  "forbiddenClaims",
  "privateMarkers",
  "validEvidenceIds",
];
const REQUIRED_LABEL_SCALAR_FIELDS = ["id", "stratum", "labelVersion", "sourceCoverageExpectation"];
const VALID_COVERAGE_EXPECTATIONS = new Set(["low", "moderate", "well-supported"]);

const EXPECTED_STRATA = new Set([
  "marketing",
  "saas-dashboard",
  "fintech",
  "mobile",
  "onboarding",
  "dense-operations",
  "sparse-evidence",
  "conflicting-references",
  "inaccessible-url",
  "multi-page-public-site",
  "cookie-banner",
  "derivative-named-reference",
]);

describe("design-handoff gold fixtures (eval/*.json integrity)", () => {
  it("both files have the expected top-level shape", () => {
    expect(briefsDoc.briefVersion).toBe(1);
    expect(Array.isArray(briefsDoc.briefs)).toBe(true);
    expect(labelsDoc.labelVersion).toBe(1);
    expect(Array.isArray(labelsDoc.labels)).toBe(true);
  });

  it("contains exactly 12 briefs and 12 labels", () => {
    expect(briefsDoc.briefs).toHaveLength(12);
    expect(labelsDoc.labels).toHaveLength(12);
  });

  it("has unique brief ids and unique label ids", () => {
    const briefIds = briefsDoc.briefs.map((b) => b.id);
    const labelIds = labelsDoc.labels.map((l) => l.id);
    expect(new Set(briefIds).size).toBe(12);
    expect(new Set(labelIds).size).toBe(12);
  });

  it("matches briefs to labels 1:1 by id (no orphans on either side)", () => {
    const briefIds = new Set(briefsDoc.briefs.map((b) => b.id));
    const labelIds = new Set(labelsDoc.labels.map((l) => l.id));
    for (const id of briefIds) expect(labelIds).toContain(id);
    for (const id of labelIds) expect(briefIds).toContain(id);
  });

  it("covers all 12 expected strata, with each brief matching its label's stratum", () => {
    const labelByStratum = new Map(labelsDoc.labels.map((l) => [l.id, l.stratum]));
    const seenStrata = new Set();
    for (const brief of briefsDoc.briefs) {
      const labelStratum = labelByStratum.get(brief.id);
      expect(labelStratum).toBe(brief.stratum); // brief and its label agree on stratum
      seenStrata.add(brief.stratum);
    }
    for (const expected of EXPECTED_STRATA) {
      expect(seenStrata, `missing stratum: ${expected}`).toContain(expected);
    }
    expect(seenStrata.size).toBe(12);
  });

  it("every label has the fields the scorer requires (malformed labels fail here)", () => {
    for (const label of labelsDoc.labels) {
      for (const field of REQUIRED_LABEL_SCALAR_FIELDS) {
        expect(label[field], `label ${label.id} missing ${field}`).toBeTruthy();
      }
      for (const field of REQUIRED_LABEL_ARRAY_FIELDS) {
        expect(Array.isArray(label[field]), `label ${label.id}.${field} must be an array`).toBe(true);
      }
      expect(
        VALID_COVERAGE_EXPECTATIONS.has(label.sourceCoverageExpectation),
        `label ${label.id} has invalid sourceCoverageExpectation`,
      ).toBe(true);
      expect(typeof label.motionDomGrounded, `label ${label.id}.motionDomGrounded must be boolean`).toBe("boolean");
    }
  });

  it("each label's requiredDecisions reconcile with its validEvidenceIds", () => {
    // A required decision id with no backing evidence can never be supported,
    // which would make the label unsatisfiable. Required decision ids must be a
    // subset of validEvidenceIds so a well-designed output CAN score complete.
    for (const label of labelsDoc.labels) {
      const valid = new Set(label.validEvidenceIds);
      for (const decisionId of label.requiredDecisions) {
        expect(
          valid.has(decisionId),
          `label ${label.id}: required decision ${decisionId} is not in validEvidenceIds`,
        ).toBe(true);
      }
    }
  });

  it("each brief's sourceMaterial ids are a subset of its label's validEvidenceIds", () => {
    // The brief declares the source material available; the label's permitted
    // evidence set must cover it, or a faithful design could never satisfy the
    // label. brief.sourceMaterial is an array of {id, kind, note} objects —
    // extract the id from each before reconciling.
    const labelById = new Map(labelsDoc.labels.map((l) => [l.id, l]));
    for (const brief of briefsDoc.briefs) {
      const label = labelById.get(brief.id);
      const valid = new Set(label.validEvidenceIds);
      const sourceEntries = Array.isArray(brief.sourceMaterial) ? brief.sourceMaterial : [];
      for (const entry of sourceEntries) {
        const srcId = entry && typeof entry === "object" ? entry.id : entry;
        expect(
          valid.has(srcId),
          `brief ${brief.id}: sourceMaterial id ${srcId} is not in its label's validEvidenceIds`,
        ).toBe(true);
      }
    }
  });
});
