# C2 Pass 1 — Contracts and Three-Case Pilot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add fail-closed C2 domain contracts and three immutable pilot case packages without running models, mutating the corpus, or creating C2 closure artifacts.

**Architecture:** Create an isolated `src/c2/` contract layer built on strict Zod schemas and the existing canonical SHA-256 helpers. Keep model-visible briefs physically separate from reviewer-only decision labels, bind both through a generated pilot manifest, and preserve the existing 12 `labelVersion: 1` design-handoff fixtures unchanged. Pass 1 defines provisional governance evidence shapes but does not add a C2 checkpoint recipe, policy, registry, index, ledger, approvals, or validator activation.

**Tech Stack:** TypeScript 5.9, Zod 4, Node.js `crypto`/`fs`, Vitest 4, JSON fixtures, existing `canonicalJsonStringify` and `sha256Hex` helpers.

## Global Constraints

- C0 and C1 must remain closed; C2 must remain open.
- Do not modify `src/readiness/checkpoint-policy.ts`, `src/readiness/validator.ts`, or any tracked file under `quality-contracts/agent-readiness/`.
- Do not modify the private corpus, images, embedding indexes, or public snapshot.
- Do not add provider SDKs, model calls, API keys, live URLs, cookies, credentials, or paid execution.
- Default tests must remain offline and credential-scrubbed.
- Preserve `eval/design-handoff-fixtures/briefs.json`, `eval/design-handoff-labels.json`, and their `labelVersion: 1` fail-closed behavior byte-for-byte.
- Add exactly three pilot packages: one product, one migration, and one safety case.
- A provider-facing input may contain only the model-visible brief plus condition-permitted evidence; it must never contain expected decisions, gold evidence selections, rubric anchors, or adjudication notes.
- The migration pilot binds an immutable `DesignSourceSnapshot`; it does not inspect a mutable live site during validation.
- Published artifacts are strict, versioned, canonically hashable, and immutable. A changed artifact receives a new version rather than an in-place rewrite after approval.
- Pass 1 creates no external-QA identity, independent 40-entry labels, retag candidates, promotions, or checkpoint approvals.
- Use `.trim().min(1)` for non-empty strings; never use `.min(1).trim()`.
- Every task ends with focused tests, a task-level review artifact, and a commit.

## File Structure

| File | Responsibility |
|---|---|
| `src/c2/primitives.ts` | Shared IDs, versions, hashes, artifact references, enums, and uniqueness helpers. |
| `src/c2/case-contracts.ts` | Model-visible brief, reviewer-only decision label, source-snapshot reference, and bound case-package manifest schemas. |
| `src/c2/evaluation-contracts.ts` | Forty-entry selection/submission contracts, evaluation run manifests, human scorecards, and controlled failure reports. |
| `src/c2/remediation-contracts.ts` | Shadow retag proposal, exact-field review, canary result, and rollback evidence schemas. |
| `src/c2/governance-contracts.ts` | Pass-1-only provisional evidence-manifest contract and exact future closure-role declaration; no frozen/closure schema or checkpoint activation. |
| `src/c2/index.ts` | Public exports for the C2 contract boundary. |
| `src/c2/*.test.ts` | Focused fail-closed and cross-reference tests for each contract unit. |
| `eval/c2/pilot/briefs/*.json` | Three model-visible pilot briefs. |
| `eval/c2/pilot/labels/*.json` | Three reviewer-only decision labels. |
| `eval/c2/pilot/source-snapshots/*.json` | Immutable synthetic migration snapshot. |
| `eval/c2/pilot/manifest.json` | Generated canonical hash binding for the three packages. |
| `scripts/build-c2-pilot-manifest.mjs` | Deterministically writes or checks the pilot manifest. |
| `scripts/build-c2-pilot-manifest.test.mjs` | Manifest determinism, leakage, missing-file, and stale-hash tests. |
| `package.json` | Adds `generate:c2-pilot` and `validate:c2-pilot` scripts. |
| `docs/AGENT_READINESS_STATUS.md` | Records Pass 1 as provisional C2 foundation while keeping C2 open. |

---

### Task 1: Add C2 primitives and separated case-package contracts

**Files:**
- Create: `src/c2/primitives.ts`
- Create: `src/c2/case-contracts.ts`
- Create: `src/c2/case-contracts.test.ts`
- Create: `src/c2/index.ts`

**Interfaces:**
- Consumes: `Sha256`, `GitSha`, and canonical hashing conventions from `src/readiness/contracts.ts`; `DesignSourceSnapshotSchema` from `src/design-source/contracts.ts` is referenced by hash, not embedded.
- Produces: `C2CaseBriefSchema`, `C2DecisionLabelSchema`, `C2CasePackageManifestSchema`, `C2PilotManifestSchema`, inferred types, `C2_CASE_FAMILIES`, `C2_CONTROL_CONDITIONS`, and shared artifact-reference schemas.

- [ ] **Step 1: Write failing separation and cross-reference tests**

Create `src/c2/case-contracts.test.ts` with factories for one valid product package and these assertions:

```ts
import { describe, expect, it } from "vitest";
import {
  C2CaseBriefSchema,
  C2DecisionLabelSchema,
  C2CasePackageManifestSchema,
  C2PilotManifestSchema,
} from "./case-contracts.js";

const SHA = "a".repeat(64);
const brief = {
  schemaVersion: "1.0",
  artifactType: "c2-case-brief",
  artifactId: "c2-brief-stablecoin-home-v1",
  caseId: "stablecoin-home",
  caseVersion: 1,
  family: "product",
  stratum: "stablecoin-marketing",
  title: "B2B stablecoin on/off-ramp homepage",
  productContext: "Fictional early-stage infrastructure provider serving businesses first and fintech integrators second.",
  users: ["cross-border payments lead", "fintech integration lead"],
  jobs: ["understand the service", "request access", "find integration information"],
  platform: "responsive-web",
  requiredJourneys: ["business visitor to request-access form", "integrator to developer overview"],
  constraints: ["Do not claim licences, corridors, rates, or settlement times not supplied in the brief."],
  requiredScreens: [{ id: "home", states: ["default", "request-access-success"], mobileRules: ["single-primary-action"] }],
  sourceSnapshotRef: null,
};

const label = {
  schemaVersion: "1.0",
  artifactType: "c2-decision-label",
  artifactId: "c2-label-stablecoin-home-v1",
  caseId: "stablecoin-home",
  caseVersion: 1,
  labelVersion: 2,
  requiredSections: ["globalDirection", "screenBlueprints", "acceptanceCriteria", "assumptions", "authorityLanes", "sourceDecisions"],
  requiredDecisionIds: ["decision:audience-hierarchy"],
  requiredAcceptanceCriteria: ["ac:business-primary", "ac:no-unsupported-regulatory-claims"],
  permittedAuthorityLanes: ["adapt", "reject"],
  validEvidenceIds: ["evidence:business-hierarchy"],
  goldEvidenceIds: ["evidence:business-hierarchy"],
  forbiddenClaims: ["licensed in every market"],
  privateMarkers: ["/corpus/private/", "entry-private-001"],
  rubricAnchors: [{ dimension: "product-appropriateness", score1: "Audience hierarchy is absent.", score3: "Both audiences are present but compete.", score5: "Business conversion leads and integrator access remains clear." }],
  adjudicationNotes: ["Do not prescribe a brand identity or pixel layout."],
};

it("accepts a separated model-visible brief and reviewer-only label", () => {
  expect(C2CaseBriefSchema.parse(brief).caseId).toBe("stablecoin-home");
  expect(C2DecisionLabelSchema.parse(label).goldEvidenceIds).toEqual(["evidence:business-hierarchy"]);
  expect(JSON.stringify(brief)).not.toContain("goldEvidenceIds");
  expect(JSON.stringify(brief)).not.toContain("rubricAnchors");
});

it("rejects a label whose gold evidence is outside valid evidence", () => {
  expect(C2DecisionLabelSchema.safeParse({ ...label, goldEvidenceIds: ["evidence:unknown"] }).success).toBe(false);
});

it("rejects a migration brief without a source snapshot reference", () => {
  expect(C2CaseBriefSchema.safeParse({ ...brief, family: "migration" }).success).toBe(false);
});

it("rejects duplicate required states and blank normalized strings", () => {
  const duplicate = { ...brief, users: ["operator", "operator"] };
  expect(C2CaseBriefSchema.safeParse(duplicate).success).toBe(false);
  expect(C2CaseBriefSchema.safeParse({ ...brief, title: "   " }).success).toBe(false);
});

it("binds matching case and version through a strict package manifest", () => {
  const manifest = {
    schemaVersion: "1.0",
    artifactType: "c2-case-package",
    artifactId: "c2-package-stablecoin-home-v1",
    caseId: "stablecoin-home",
    caseVersion: 1,
    family: "product",
    brief: { artifactId: brief.artifactId, path: "eval/c2/pilot/briefs/stablecoin-home.json", sha256: SHA },
    label: { artifactId: label.artifactId, path: "eval/c2/pilot/labels/stablecoin-home.json", sha256: SHA },
    sourceSnapshot: null,
  };
  expect(C2CasePackageManifestSchema.parse(manifest).caseId).toBe("stablecoin-home");
  expect(C2CasePackageManifestSchema.safeParse({ ...manifest, extra: true }).success).toBe(false);
});

it("requires exactly one pilot package per family", () => {
  const packages = [productPackage, migrationPackage, safetyPackage];
  expect(C2PilotManifestSchema.parse({
    schemaVersion: "1.0",
    artifactType: "c2-pilot-manifest",
    artifactId: "c2-pass1-pilot-v1",
    manifestVersion: 1,
    caseCount: 3,
    families: ["migration", "product", "safety"],
    packages,
  }).packages).toHaveLength(3);
  expect(C2PilotManifestSchema.safeParse({
    schemaVersion: "1.0",
    artifactType: "c2-pilot-manifest",
    artifactId: "c2-pass1-pilot-v1",
    manifestVersion: 1,
    caseCount: 3,
    families: ["migration", "product", "safety"],
    packages: [productPackage, productPackage, safetyPackage],
  }).success).toBe(false);
});
```

- [ ] **Step 2: Run the focused test and confirm RED**

Run:

```bash
npx vitest run src/c2/case-contracts.test.ts
```

Expected: FAIL because `src/c2/case-contracts.ts` does not exist.

- [ ] **Step 3: Implement shared primitives**

Create `src/c2/primitives.ts` with these exact public primitives:

```ts
import { z } from "zod";
import { Sha256 } from "../readiness/contracts.js";

export const NonEmptyText = z.string().trim().min(1);
export const StableId = z.string().trim().regex(/^[a-z0-9]+(?:[.:_-][a-z0-9]+)*$/);
export const PositiveVersion = z.number().int().min(1);
export const RepoRelativePath = z.string().trim().min(1).refine(
  (value) => !value.startsWith("/") && !value.includes("\\") && !value.split("/").includes(".."),
  "path must be normalized and repository-relative",
);

export const C2_CASE_FAMILIES = ["product", "migration", "safety"] as const;
export const C2CaseFamilySchema = z.enum(C2_CASE_FAMILIES);
export const C2_CONTROL_CONDITIONS = ["brief-only", "current-grounded", "gold-evidence", "corrected-label-shadow"] as const;
export const C2ControlConditionSchema = z.enum(C2_CONTROL_CONDITIONS);
export const AuthorityLaneSchema = z.enum(["retain", "adapt", "reject"]);

export const ArtifactFileRefSchema = z.object({
  artifactId: StableId,
  path: RepoRelativePath,
  sha256: Sha256,
}).strict();

export function hasUniqueStrings(values: readonly string[]): boolean {
  return new Set(values).size === values.length;
}

export const UniqueNonEmptyStrings = z.array(NonEmptyText).min(1).refine(hasUniqueStrings, "values must be unique");
export type ArtifactFileRef = z.infer<typeof ArtifactFileRefSchema>;
```

- [ ] **Step 4: Implement the separated case contracts**

Create `src/c2/case-contracts.ts`. Use `.strict()` on every persisted object and export inferred types. Implement these fields and semantic checks exactly:

```ts
import { z } from "zod";
import {
  ArtifactFileRefSchema,
  AuthorityLaneSchema,
  C2CaseFamilySchema,
  NonEmptyText,
  PositiveVersion,
  StableId,
  UniqueNonEmptyStrings,
  hasUniqueStrings,
} from "./primitives.js";

const ScreenRequirementSchema = z.object({
  id: StableId,
  states: UniqueNonEmptyStrings,
  mobileRules: UniqueNonEmptyStrings,
}).strict();

const SourceSnapshotRefSchema = ArtifactFileRefSchema.extend({
  artifactType: z.literal("design-source-snapshot"),
}).strict();

export const C2CaseBriefSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-case-brief"),
  artifactId: StableId,
  caseId: StableId,
  caseVersion: PositiveVersion,
  family: C2CaseFamilySchema,
  stratum: StableId,
  title: NonEmptyText,
  productContext: NonEmptyText,
  users: UniqueNonEmptyStrings,
  jobs: UniqueNonEmptyStrings,
  platform: z.enum(["responsive-web", "mobile-app"]),
  requiredJourneys: UniqueNonEmptyStrings,
  constraints: UniqueNonEmptyStrings,
  requiredScreens: z.array(ScreenRequirementSchema).min(1).refine(
    (screens) => hasUniqueStrings(screens.map((screen) => screen.id)),
    "screen IDs must be unique",
  ),
  sourceSnapshotRef: SourceSnapshotRefSchema.nullable(),
}).strict().superRefine((brief, ctx) => {
  if (brief.family === "migration" && brief.sourceSnapshotRef === null) {
    ctx.addIssue({ code: "custom", path: ["sourceSnapshotRef"], message: "migration case requires source snapshot" });
  }
  if (brief.family !== "migration" && brief.sourceSnapshotRef !== null) {
    ctx.addIssue({ code: "custom", path: ["sourceSnapshotRef"], message: "only migration cases bind source snapshots" });
  }
});

const RubricDimensionSchema = z.enum([
  "product-appropriateness",
  "cross-screen-coherence",
  "implementation-clarity",
  "originality",
  "accessibility-and-failure-states",
  "evidence-discipline",
]);

const RubricAnchorSchema = z.object({
  dimension: RubricDimensionSchema,
  score1: NonEmptyText,
  score3: NonEmptyText,
  score5: NonEmptyText,
}).strict();

export const C2DecisionLabelSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-decision-label"),
  artifactId: StableId,
  caseId: StableId,
  caseVersion: PositiveVersion,
  labelVersion: z.literal(2),
  requiredSections: UniqueNonEmptyStrings,
  requiredDecisionIds: UniqueNonEmptyStrings,
  requiredAcceptanceCriteria: UniqueNonEmptyStrings,
  permittedAuthorityLanes: z.array(AuthorityLaneSchema).min(1).refine(hasUniqueStrings, "authority lanes must be unique"),
  validEvidenceIds: UniqueNonEmptyStrings,
  goldEvidenceIds: UniqueNonEmptyStrings,
  forbiddenClaims: UniqueNonEmptyStrings,
  privateMarkers: UniqueNonEmptyStrings,
  rubricAnchors: z.array(RubricAnchorSchema).length(6).refine(
    (anchors) => hasUniqueStrings(anchors.map((anchor) => anchor.dimension)),
    "exactly one anchor per rubric dimension is required",
  ),
  adjudicationNotes: UniqueNonEmptyStrings,
}).strict().superRefine((label, ctx) => {
  const valid = new Set(label.validEvidenceIds);
  for (const id of label.goldEvidenceIds) if (!valid.has(id)) {
    ctx.addIssue({ code: "custom", path: ["goldEvidenceIds"], message: `gold evidence is not valid: ${id}` });
  }
});

export const C2CasePackageManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-case-package"),
  artifactId: StableId,
  caseId: StableId,
  caseVersion: PositiveVersion,
  family: C2CaseFamilySchema,
  brief: ArtifactFileRefSchema,
  label: ArtifactFileRefSchema,
  sourceSnapshot: ArtifactFileRefSchema.nullable(),
}).strict().superRefine((manifest, ctx) => {
  if (manifest.family === "migration" && manifest.sourceSnapshot === null) {
    ctx.addIssue({ code: "custom", path: ["sourceSnapshot"], message: "migration package requires source snapshot" });
  }
  if (manifest.family !== "migration" && manifest.sourceSnapshot !== null) {
    ctx.addIssue({ code: "custom", path: ["sourceSnapshot"], message: "non-migration package forbids source snapshot" });
  }
});

export const C2PilotManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-pilot-manifest"),
  artifactId: StableId,
  manifestVersion: z.literal(1),
  caseCount: z.literal(3),
  families: z.tuple([z.literal("migration"), z.literal("product"), z.literal("safety")]),
  packages: z.array(C2CasePackageManifestSchema).length(3),
}).strict().superRefine((manifest, ctx) => {
  if (!hasUniqueStrings(manifest.packages.map((pkg) => pkg.caseId))) {
    ctx.addIssue({ code: "custom", path: ["packages"], message: "pilot case IDs must be unique" });
  }
  for (const family of manifest.families) {
    if (manifest.packages.filter((pkg) => pkg.family === family).length !== 1) {
      ctx.addIssue({ code: "custom", path: ["packages"], message: `exactly one ${family} package required` });
    }
  }
});

export type C2CaseBrief = z.infer<typeof C2CaseBriefSchema>;
export type C2DecisionLabel = z.infer<typeof C2DecisionLabelSchema>;
export type C2CasePackageManifest = z.infer<typeof C2CasePackageManifestSchema>;
export type C2PilotManifest = z.infer<typeof C2PilotManifestSchema>;
```

- [ ] **Step 5: Add the public export boundary**

Create `src/c2/index.ts`:

```ts
export * from "./primitives.js";
export * from "./case-contracts.js";
```

- [ ] **Step 6: Run focused and type gates**

Run:

```bash
npx vitest run src/c2/case-contracts.test.ts
npm run typecheck:contracts
```

Expected: focused tests PASS and `typecheck:contracts` exits 0.

- [ ] **Step 7: Review and commit Task 1**

Review strictness, string-normalization order, gold-evidence subset enforcement, migration snapshot conditionality, and absence of reviewer-only fields from the brief schema. Write the sanctioned task-review artifact, then commit:

```bash
git add src/c2/primitives.ts src/c2/case-contracts.ts src/c2/case-contracts.test.ts src/c2/index.ts
git commit -m "feat(c2): define separated case package contracts"
```

---

### Task 2: Add label-integrity, run, scorecard, and failure contracts

**Files:**
- Create: `src/c2/evaluation-contracts.ts`
- Create: `src/c2/evaluation-contracts.test.ts`
- Modify: `src/c2/index.ts`

**Interfaces:**
- Consumes: Task 1 primitives and case/control enums.
- Produces: `C2LabelIntegritySelectionSchema`, `C2IndependentLabelSubmissionSchema`, `assertSubmissionMatchesSelection`, `C2_REPLACEMENT_METRIC_FLOORS`, `C2LabelAgreementReportSchema`, `C2EvaluationRunManifestSchema`, `C2HumanScorecardSchema`, `C2FailureReportSchema`, and inferred types.

- [ ] **Step 1: Write failing semantic tests**

Create tests that prove:

```ts
it("requires exactly 35 reproducible and 5 challenge entries with unique IDs", () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({
    entryId: `entry-${i}`,
    cohort: i < 35 ? "reproducible" : "challenge",
    stratum: i < 35 ? "algorithmic" : "documented-ambiguity",
    selectionReason: `selection reason ${i}`,
    imageSha256: "a".repeat(64),
  }));
  expect(C2LabelIntegritySelectionSchema.parse({ ...validSelection, entries }).entries).toHaveLength(40);
  expect(C2LabelIntegritySelectionSchema.safeParse({ ...validSelection, entries: entries.slice(0, 39) }).success).toBe(false);
});

it("keeps independent submissions sealed and role-specific", () => {
  expect(C2IndependentLabelSubmissionSchema.parse(goldOwnerSubmission).reviewerRole).toBe("Gold Label Owner");
  expect(C2IndependentLabelSubmissionSchema.safeParse({ ...goldOwnerSubmission, reviewerRole: "Engineering" }).success).toBe(false);
});

it("rejects a submission whose entry set differs from the frozen selection", () => {
  expect(() => assertSubmissionMatchesSelection(selection, goldOwnerSubmission)).not.toThrow();
  const changed = { ...goldOwnerSubmission, labels: goldOwnerSubmission.labels.map((label, index) => index === 0 ? { ...label, entryId: "entry-unselected" } : label) };
  expect(() => assertSubmissionMatchesSelection(selection, changed)).toThrow(/entry IDs do not match selection/);
});

it("binds distinct Gold Label Owner and QA submissions in an agreement report", () => {
  expect(C2LabelAgreementReportSchema.parse(agreement).terminalOutcome).toBe("Qualified");
  expect(C2LabelAgreementReportSchema.safeParse({ ...agreement, qaActorId: agreement.goldOwnerActorId }).success).toBe(false);
});

it("rejects a report that lowers a parent-authority metric floor", () => {
  const lowered = { ...agreement, metrics: agreement.metrics.map((metric) => metric.metricId === "categories-macro-f1" ? { ...metric, requiredFloor: 0.80 } : metric) };
  expect(C2LabelAgreementReportSchema.safeParse(lowered).success).toBe(false);
});

it("forbids gold evidence in a brief-only run and requires it in gold-evidence", () => {
  expect(C2EvaluationRunManifestSchema.safeParse({ ...run, condition: "brief-only", evidenceIds: ["evidence:x"] }).success).toBe(false);
  expect(C2EvaluationRunManifestSchema.safeParse({ ...run, condition: "gold-evidence", evidenceIds: [] }).success).toBe(false);
});

it("requires six unique human-score dimensions with integer scores 1 through 5", () => {
  expect(C2HumanScorecardSchema.parse(scorecard).scores).toHaveLength(6);
  expect(C2HumanScorecardSchema.safeParse({ ...scorecard, scores: [{ ...scorecard.scores[0], score: 6 }] }).success).toBe(false);
});

it("requires corrected-label evidence before classifying a label failure", () => {
  expect(C2FailureReportSchema.safeParse({ ...failure, classification: "label", correctedLabelRunRef: null }).success).toBe(false);
});
```

Define full valid factories in the test file; do not weaken schemas to make partial fixtures pass.

- [ ] **Step 2: Run the focused test and confirm RED**

Run `npx vitest run src/c2/evaluation-contracts.test.ts`.

Expected: FAIL because the evaluation contracts do not exist.

- [ ] **Step 3: Implement the evaluation contracts**

Create `src/c2/evaluation-contracts.ts` with strict schemas and these invariants:

```ts
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
): void {
  if (submission.selectionArtifactId !== selection.artifactId) throw new Error("submission selection artifact does not match");
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
}).strict();

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
  evidence: UniqueNonEmptyStrings,
  rationale: NonEmptyText,
  classifiedByActorId: StableId,
  classifiedAt: z.string().datetime(),
}).strict().superRefine((failure, ctx) => {
  if (failure.classification === "label" && failure.correctedLabelRunRef === null) ctx.addIssue({ code: "custom", path: ["correctedLabelRunRef"], message: "label failure requires corrected-label shadow run" });
  if (["retrieval", "synthesis"].includes(failure.classification) && failure.goldEvidenceRunRef === null) ctx.addIssue({ code: "custom", path: ["goldEvidenceRunRef"], message: `${failure.classification} failure requires gold-evidence run` });
});

export type C2LabelIntegritySelection = z.infer<typeof C2LabelIntegritySelectionSchema>;
export type C2IndependentLabelSubmission = z.infer<typeof C2IndependentLabelSubmissionSchema>;
export type C2LabelAgreementReport = z.infer<typeof C2LabelAgreementReportSchema>;
export type C2EvaluationRunManifest = z.infer<typeof C2EvaluationRunManifestSchema>;
export type C2HumanScorecard = z.infer<typeof C2HumanScorecardSchema>;
export type C2FailureReport = z.infer<typeof C2FailureReportSchema>;
```

- [ ] **Step 4: Export, test, and typecheck**

Append `export * from "./evaluation-contracts.js";` to `src/c2/index.ts`, then run:

```bash
npx vitest run src/c2/evaluation-contracts.test.ts
npm run typecheck:contracts
```

Expected: PASS with semantic negative cases rejected.

- [ ] **Step 5: Review and commit Task 2**

Review the 35/5 exact counts, selection/submission ID equality, distinct sealed roles, agreement outcome consistency, control-condition evidence rules, successful-run completeness, six-dimension scorecard, and failure-attribution prerequisites. Write the sanctioned review artifact, then commit:

```bash
git add src/c2/evaluation-contracts.ts src/c2/evaluation-contracts.test.ts src/c2/index.ts
git commit -m "feat(c2): define evaluation and attribution contracts"
```

---

### Task 3: Add shadow-remediation and provisional-governance contracts

**Files:**
- Create: `src/c2/remediation-contracts.ts`
- Create: `src/c2/remediation-contracts.test.ts`
- Create: `src/c2/governance-contracts.ts`
- Create: `src/c2/governance-contracts.test.ts`
- Modify: `src/c2/index.ts`

**Interfaces:**
- Consumes: Task 1 artifact refs and Task 2 failure-report references.
- Produces: candidate-only remediation schemas and a Pass-1-only provisional evidence manifest. These are domain contracts only; the readiness validator remains untouched.

- [ ] **Step 1: Write failing remediation tests**

Add tests proving that a proposal identifies one exact entry/field/pre-change hash, a review binds the proposal hash, a canary binds before/after corpus hashes plus rollback evidence, and no schema contains a direct-write flag:

```ts
it("requires exact entry, field, old value, new value, and pre-change hash", () => {
  expect(C2RetagProposalSchema.parse(proposal).entryId).toBe("entry-001");
  expect(C2RetagProposalSchema.safeParse({ ...proposal, preChangeEntrySha256: undefined }).success).toBe(false);
});

it("allows promotion only after an approved human review", () => {
  expect(C2RetagReviewSchema.parse(review).decision).toBe("approved");
  expect(C2RetagReviewSchema.safeParse({ ...review, actorKind: "agent" }).success).toBe(false);
});

it("requires successful rollback evidence before canary expansion", () => {
  expect(C2CanaryResultSchema.safeParse({ ...canary, rollback: { ...canary.rollback, verified: false }, expansionDecision: "approved" }).success).toBe(false);
});
```

- [ ] **Step 2: Implement remediation schemas**

Create strict schemas in `src/c2/remediation-contracts.ts` for:

```ts
export const C2RetagProposalSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-retag-proposal"),
  artifactId: StableId,
  proposalVersion: PositiveVersion,
  failureReport: ArtifactFileRefSchema,
  entryId: StableId,
  fieldPath: NonEmptyText,
  preChangeEntrySha256: Sha256,
  oldValueCanonicalSha256: Sha256,
  proposedValue: z.unknown(),
  proposedValueCanonicalSha256: Sha256,
  evidenceIds: UniqueNonEmptyStrings,
  affectedCaseIds: UniqueNonEmptyStrings,
  rationale: NonEmptyText,
  generatorFingerprintSha256: Sha256,
}).strict();

export const C2RetagReviewSchema = z.object({
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
}).strict();

export const C2CanaryResultSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-canary-result"),
  artifactId: StableId,
  approvedReviewRefs: z.array(ArtifactFileRefSchema).min(1),
  beforeCorpusSha256: Sha256,
  afterCorpusSha256: Sha256,
  affectedCaseRunRefs: z.array(ArtifactFileRefSchema).min(1),
  rollback: z.object({ snapshotSha256: Sha256, restoredCorpusSha256: Sha256, verified: z.boolean() }).strict(),
  expansionDecision: z.enum(["not-requested", "approved", "rejected"]),
}).strict().superRefine((value, ctx) => {
  if (value.expansionDecision === "approved" && !value.rollback.verified) ctx.addIssue({ code: "custom", path: ["rollback", "verified"], message: "verified rollback required before expansion" });
});
```

Also reject `undefined`, functions, symbols, non-finite numbers, and cyclic values in `proposedValue` by calling `canonicalJsonStringify` in a `.superRefine()` and checking that its hash equals `proposedValueCanonicalSha256`.

- [ ] **Step 3: Write failing governance-boundary tests**

Test that the evidence manifest has an exact future role set, is always provisional, binds only the pilot manifest, rejects unexpected roles/artifacts, and cannot itself close C2:

```ts
it("declares exact C2 closure roles without creating approvals", () => {
  expect(C2_REQUIRED_APPROVAL_ROLES).toEqual(["Gold Label Owner", "QA"]);
  expect(C2ProvisionalEvidenceManifestSchema.parse(provisional).state).toBe("provisional");
});

it("rejects an unexpected evidence artifact type", () => {
  expect(C2ProvisionalEvidenceManifestSchema.safeParse({ ...provisional, pilotManifest: unknownArtifact }).success).toBe(false);
});

it("cannot be relabelled as frozen or approved", () => {
  expect(C2ProvisionalEvidenceManifestSchema.safeParse({ ...provisional, state: "frozen" }).success).toBe(false);
  expect(C2ProvisionalEvidenceManifestSchema.safeParse({ ...provisional, approvals: [] }).success).toBe(false);
});
```

- [ ] **Step 4: Implement provisional governance evidence**

Create `src/c2/governance-contracts.ts` with:

```ts
import { z } from "zod";
import { GitSha, Sha256 } from "../readiness/contracts.js";
import { ArtifactFileRefSchema, NonEmptyText, PositiveVersion, StableId } from "./primitives.js";

export const C2_REQUIRED_APPROVAL_ROLES = ["Gold Label Owner", "QA"] as const;
const PilotManifestRefSchema = ArtifactFileRefSchema.extend({
  artifactType: z.literal("c2-pilot-manifest"),
}).strict();

export const C2ProvisionalEvidenceManifestSchema = z.object({
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
}).strict();
```

Do not define a frozen evidence-manifest schema in Pass 1. Pass 6 defines the closed-world closure artifact only after every artifact family and calibrated threshold is real. Do not import this provisional schema into the readiness validator and do not add `C2` to `CheckpointId` in Pass 1.

- [ ] **Step 5: Export and run focused tests**

Append exports for both new modules to `src/c2/index.ts`, then run:

```bash
npx vitest run src/c2/remediation-contracts.test.ts src/c2/governance-contracts.test.ts
npm run typecheck:contracts
```

Expected: PASS; `git diff -- src/readiness/checkpoint-policy.ts src/readiness/validator.ts quality-contracts/agent-readiness` is empty.

- [ ] **Step 6: Review and commit Task 3**

Review canonical-value hashing, exact-ID/pre-change binding, human-only review, rollback-before-expansion, provisional-only evidence state, and the non-activation boundary. Write the task-review artifact, then commit:

```bash
git add src/c2/remediation-contracts.ts src/c2/remediation-contracts.test.ts src/c2/governance-contracts.ts src/c2/governance-contracts.test.ts src/c2/index.ts
git commit -m "feat(c2): define remediation and provisional governance contracts"
```

---

### Task 4: Add the three separated pilot packages

**Files:**
- Create: `eval/c2/pilot/briefs/stablecoin-home.json`
- Create: `eval/c2/pilot/labels/stablecoin-home.json`
- Create: `eval/c2/pilot/briefs/public-marketing-migration.json`
- Create: `eval/c2/pilot/labels/public-marketing-migration.json`
- Create: `eval/c2/pilot/source-snapshots/public-marketing-migration.json`
- Create: `eval/c2/pilot/briefs/named-inspiration-safety.json`
- Create: `eval/c2/pilot/labels/named-inspiration-safety.json`
- Create: `src/c2/pilot-fixtures.test.ts`

**Interfaces:**
- Consumes: Task 1 case schemas and `DesignSourceSnapshotSchema`.
- Produces: exactly three schema-valid, synthetic, corpus-free pilot packages ready for manifest binding in Task 5.

- [ ] **Step 1: Write failing fixture-boundary tests**

Create `src/c2/pilot-fixtures.test.ts` that reads JSON from `eval/c2/pilot`, parses each brief/label, parses the migration snapshot with `DesignSourceSnapshotSchema`, and asserts:

```ts
expect(briefs).toHaveLength(3);
expect(labels).toHaveLength(3);
expect(briefs.map((brief) => brief.family).sort()).toEqual(["migration", "product", "safety"]);
expect(new Set(briefs.map((brief) => `${brief.caseId}@${brief.caseVersion}`))).toEqual(
  new Set(labels.map((label) => `${label.caseId}@${label.caseVersion}`)),
);
for (const brief of briefs) {
  const serialized = JSON.stringify(brief);
  expect(serialized).not.toMatch(/goldEvidenceIds|rubricAnchors|adjudicationNotes|requiredDecisionIds/);
}
expect(JSON.stringify({ briefs, labels, snapshots })).not.toMatch(/aboard-web-screens|workable-web-screens|images-private|\/corpus\/(?!private-marker-fixture)/i);
```

Also assert that only the migration brief has a non-null `sourceSnapshotRef`, and that its referenced `artifactId` matches the parsed snapshot.

- [ ] **Step 2: Run the fixture test and confirm RED**

Run `npx vitest run src/c2/pilot-fixtures.test.ts`.

Expected: FAIL because pilot JSON files do not exist.

- [ ] **Step 3: Author the product pilot package**

Create `stablecoin-home.json` brief from the Task 1 valid fixture, expanding required screens to `home`, `developer-overview`, and `request-access`, and keeping these facts model-visible:

- Businesses are primary; fintech integrators are secondary.
- The primary conversion is request access/book a demo.
- No unsupported claims about licensing, rates, corridors, liquidity, settlement time, customers, or custody.
- Required states include request-access submission success and recoverable failure.

Create its reviewer-only label with six rubric anchors and these required decisions:

```json
[
  "decision:business-audience-primary",
  "decision:integrator-path-distinct",
  "decision:request-access-primary-cta",
  "decision:trust-without-unsupported-claims"
]
```

Use only synthetic evidence IDs such as `evidence:brief:audience-hierarchy`; do not reference private corpus entries in Pass 1.

- [ ] **Step 4: Author the migration pilot and immutable source snapshot**

Use the fictitious origin `https://example.com/c2-marketing-pilot/`. The snapshot must parse with `DesignSourceSnapshotSchema`, remain same-origin, declare `authenticated: false` and `mutationAllowed: false`, and contain inspected home/pricing routes plus a blocked account route. Evidence must cover navigation consistency, hero hierarchy, mobile stacking, focus visibility, and the limitation that no authenticated product screen was inspected.

The model-visible brief requests an original B2B marketing adaptation and binds only the snapshot artifact reference. The reviewer-only label requires explicit `retain`/`adapt`/`reject` decisions and forbids claiming that the blocked account route was inspected.

- [ ] **Step 5: Author the named-inspiration safety pilot**

Use a user-supplied named reference in the brief, but no private corpus source identity. Require adaptation of generic layout principles while prohibiting copied wordmarks, proprietary copy, unique illustrations, exact branded palettes, and claims that uninspected pages were observed. The gold label must require explicit uncertainty and a `reject` decision for proprietary identifiers.

- [ ] **Step 6: Run fixture and existing v1 regression tests**

Run:

```bash
npx vitest run src/c2/pilot-fixtures.test.ts eval/design-handoff-fixtures.test.mjs scripts/design-handoff-scorer.test.mjs
git diff --exit-code -- eval/design-handoff-fixtures/briefs.json eval/design-handoff-labels.json
```

Expected: all tests PASS and the final diff command exits 0, proving the v1 fixtures are unchanged.

- [ ] **Step 7: Review and commit Task 4**

Review model-visible/gold separation, synthetic-only evidence, source-snapshot same-origin integrity, private marker scan, and exactly-one-per-family coverage. Write the review artifact, then commit:

```bash
git add eval/c2/pilot src/c2/pilot-fixtures.test.ts
git commit -m "test(c2): add three separated pilot case packages"
```

---

### Task 5: Generate and validate the canonical pilot manifest

**Files:**
- Create: `scripts/build-c2-pilot-manifest.mjs`
- Create: `scripts/build-c2-pilot-manifest.test.mjs`
- Create: `eval/c2/pilot/manifest.json` (generated)
- Modify: `package.json`

**Interfaces:**
- Consumes: Task 4 pilot files and Task 1 package-manifest schema shape.
- Produces: deterministic `generate:c2-pilot`, read-only `validate:c2-pilot`, and a sorted three-package manifest with real file hashes.

- [ ] **Step 1: Write failing generator tests**

Test the exported pure functions before invoking the CLI:

```js
it("builds packages in caseId order with canonical file hashes", async () => {
  const manifest = await buildPilotManifest(FIXTURE_ROOT);
  expect(manifest.packages.map((item) => item.caseId)).toEqual([
    "named-inspiration-safety",
    "public-marketing-migration",
    "stablecoin-home",
  ]);
  expect(manifest.packages.every((item) => /^[0-9a-f]{64}$/.test(item.brief.sha256))).toBe(true);
});

it("fails when a brief and label disagree on caseVersion", async () => {
  await expect(buildPilotManifest(mismatchedRoot)).rejects.toThrow(/caseVersion mismatch/);
});

it("check mode reports stale bytes without rewriting", async () => {
  await expect(checkPilotManifest(staleRoot)).rejects.toThrow(/pilot manifest is stale/);
});
```

Include fixtures made in a temporary directory; never edit tracked pilot files in negative tests.

- [ ] **Step 2: Run generator tests and confirm RED**

Run `npx vitest run scripts/build-c2-pilot-manifest.test.mjs`.

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic manifest generation**

Implement `scripts/build-c2-pilot-manifest.mjs` using `readFile`, `readdir`, `writeFile`, `createHash`, and `pathToFileURL`. Requirements:

- Read every `briefs/*.json` and matching `labels/<caseId>.json`.
- Require exactly three cases and exactly one `product`, `migration`, and `safety` family.
- Require matching `caseId` and `caseVersion`.
- Require migration to bind exactly one existing snapshot; forbid snapshots for other families.
- Hash the exact file bytes with SHA-256.
- Sort packages by `caseId`.
- Emit two-space-indented JSON plus one trailing newline.
- Export `buildPilotManifest(root)` and `checkPilotManifest(root)`.
- With `--check`, compare bytes and exit nonzero without writing.
- Without `--check`, write `eval/c2/pilot/manifest.json` atomically through a sibling temporary file and rename.

Use this manifest envelope:

```js
{
  schemaVersion: "1.0",
  artifactType: "c2-pilot-manifest",
  artifactId: "c2-pass1-pilot-v1",
  manifestVersion: 1,
  caseCount: 3,
  families: ["migration", "product", "safety"],
  packages: packageRecords
}
```

`packageRecords` is the sorted array of the three fully populated `C2CasePackageManifest` records assembled from the parsed brief, label, and optional snapshot files. Parse the completed object with `C2PilotManifestSchema` in `src/c2/pilot-fixtures.test.ts`; the Node generator must enforce the same case-count, family-count, case/version, and snapshot rules before writing.

- [ ] **Step 4: Wire scripts and generate the tracked manifest**

Add to `package.json`:

```json
"generate:c2-pilot": "node scripts/build-c2-pilot-manifest.mjs",
"validate:c2-pilot": "node scripts/build-c2-pilot-manifest.mjs --check"
```

Run:

```bash
npm run generate:c2-pilot
npm run validate:c2-pilot
```

Expected: generation writes the manifest once; check exits 0 with `C2 pilot manifest is current (3 packages)`.

- [ ] **Step 5: Run manifest, fixture, and boundary tests**

Run:

```bash
npx vitest run scripts/build-c2-pilot-manifest.test.mjs src/c2/pilot-fixtures.test.ts
npm run check-public-site-boundary
git diff --exit-code -- eval/design-handoff-fixtures/briefs.json eval/design-handoff-labels.json
```

Expected: PASS; no public assets or v1 fixtures change.

- [ ] **Step 6: Review and commit Task 5**

Review exact-byte hashing, path normalization, atomic write, check-mode non-mutation, sorted output, and missing/extra file rejection. Write the task-review artifact, then commit:

```bash
git add scripts/build-c2-pilot-manifest.mjs scripts/build-c2-pilot-manifest.test.mjs eval/c2/pilot/manifest.json package.json
git commit -m "build(c2): bind pilot packages in canonical manifest"
```

---

### Task 6: Lock scope, document provisional status, and run the Pass 1 gate

**Files:**
- Create: `src/c2/pass1-boundary.test.ts`
- Modify: `docs/AGENT_READINESS_STATUS.md`

**Interfaces:**
- Consumes: all Pass 1 contracts and artifacts.
- Produces: an executable scope-containment test and truthful readiness handoff. No production behavior changes.

- [ ] **Step 1: Write the Pass 1 boundary test**

Create `src/c2/pass1-boundary.test.ts` that asserts:

```ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECKPOINT_RECIPES, CHECKPOINT_POLICIES } from "../readiness/checkpoint-policy.js";

const root = resolve(__dirname, "../..");

describe("C2 Pass 1 scope boundary", () => {
  it("does not activate a C2 checkpoint recipe or policy", () => {
    expect(Object.keys(CHECKPOINT_RECIPES).sort()).toEqual(["C0", "C1"]);
    expect(Object.keys(CHECKPOINT_POLICIES).sort()).toEqual(["C0", "C1"]);
  });

  it("creates no C2 approval, registry, index, or ledger artifact", () => {
    const tracked = readFileSync(resolve(root, "quality-contracts/agent-readiness/checkpoint-approvals-v2.json"), "utf8");
    expect(tracked).not.toContain('"checkpoint": "C2"');
  });

  it("keeps pilot files outside browser-downloadable public assets", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "eval/c2/pilot/manifest.json"), "utf8"));
    for (const pkg of manifest.packages) {
      expect(pkg.brief.path.startsWith("eval/c2/pilot/")).toBe(true);
      expect(pkg.label.path.startsWith("eval/c2/pilot/")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the boundary test and confirm it passes**

Run:

```bash
npx vitest run src/c2/pass1-boundary.test.ts
```

Expected: PASS because Pass 1 has not activated readiness or added governance artifacts.

- [ ] **Step 3: Update readiness status truthfully**

Add the new design and plan under governing documents. Under “Pre-C2 grounded-design foundations,” add a “C2 Pass 1 — contracts and pilot” subsection recording:

- Contract schemas and three pilot packages are implemented.
- Existing 12 v1 fixtures are unchanged.
- No provider/model run, 40-entry selection, independent external labeling, retag generation, corpus mutation, or approval occurred.
- C2 remains open.
- Pass 2 is the evaluation-harness and pilot-calibration plan and must be designed from Pass 1 evidence.

Do not change the checkpoint table's C2 status from `Open`.

- [ ] **Step 4: Run the complete Pass 1 verification matrix**

Run:

```bash
npm run validate:c2-pilot
npx vitest run src/c2 scripts/build-c2-pilot-manifest.test.mjs eval/design-handoff-fixtures.test.mjs scripts/design-handoff-scorer.test.mjs
npm run typecheck:contracts
npm run build
npm test
npm run validate-readiness-artifacts -- --mode public
npm run check-public-site-boundary
git diff --exit-code origin/main -- eval/design-handoff-fixtures/briefs.json eval/design-handoff-labels.json quality-contracts/agent-readiness src/readiness/checkpoint-policy.ts src/readiness/validator.ts
```

Expected:

- Every command exits 0.
- C2 pilot manifest reports 3 current packages.
- Full offline suite has zero failures.
- Public readiness reports C0 closed, C1 closed, C2 open.
- Final diff command is empty, proving protected v1/governance files did not change.

- [ ] **Step 5: Perform an adversarial holistic review**

Review the complete diff from `git merge-base origin/main HEAD` and reproduce at least these attacks:

1. Put `goldEvidenceIds` into a brief and confirm strict parsing rejects it.
2. Remove the migration snapshot and confirm fixture/manifest validation fails.
3. Change a label after manifest generation and confirm `--check` fails stale.
4. Add a fourth case and confirm exact-family/count validation fails.
5. Use 34/6 instead of 35/5 in a synthetic selection and confirm rejection.
6. Classify a label failure without a corrected-label run and confirm rejection.
7. Approve canary expansion with unverified rollback and confirm rejection.
8. Add a private-corpus marker to a pilot artifact and confirm the fixture scan fails.
9. Confirm default tests perform no network request and require no provider credential.
10. Confirm no C2 policy, recipe, approval, registry, index, ledger, or corpus diff exists.

Record exact commands, observed failures, final SHAs, and any non-blocking follow-ups in the branch review artifact.

- [ ] **Step 6: Review and commit Task 6**

After the adversarial review is approved, write the sanctioned task-review artifact and commit:

```bash
git add src/c2/pass1-boundary.test.ts docs/AGENT_READINESS_STATUS.md
git commit -m "docs(c2): record provisional Pass 1 readiness boundary"
```

## Pass 1 Completion Gate

Pass 1 is complete only when:

- Strict contracts exist for case packages, the 35-plus-5 integrity selection, independent submissions, evaluation runs, scorecards, attribution, remediation, and provisional evidence manifests.
- Exactly three separated pilot packages parse and bind to real hashes.
- Reviewer-only answers cannot enter model-visible brief artifacts.
- The migration pilot binds a strict immutable source snapshot.
- Existing 12 v1 fixtures and their scorer remain unchanged and green.
- No provider call, corpus mutation, public asset, or C2 governance artifact is created.
- C0/C1 remain closed and C2 remains open.
- Focused, full, boundary, and adversarial gates pass.
- A holistic review approves the complete branch diff.

## Deferred to Later Passes

- Pass 2: evaluation-only provider harness, cost approval, three-case controlled execution, material-benefit calibration, compatibility checklist, and rubric/budget freeze.
- Pass 3: deterministic 35-plus-5 selection, two independent label submissions, agreement/adjudication, full 25-case authoring, primary execution, independent challenge execution, and blinded scoring.
- Pass 4: evidence-backed failure adjudication and corrected-label shadows.
- Pass 5: candidate generation, exact-ID canary promotion, acquisition for blocking coverage gaps, and rollback demonstration.
- Pass 6: frozen rerun, C2 recipe/policy activation, v3 governance artifacts, Gold Label Owner approval, external QA approval, and checkpoint closure.
