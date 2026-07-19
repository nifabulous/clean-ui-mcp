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

## What already exists

Reused, not rebuilt. Pass 1 layers the new `src/c2/` contract boundary **on top of** these existing systems rather than duplicating them.

| Existing artifact | Reuse in Pass 1 | Not rebuilt |
|---|---|---|
| `src/readiness/checkpoint-policy.ts`, `src/readiness/validator.ts` | Read-only constraint — Pass 1 must not touch them (Global Constraints line 14) | C2 is intentionally *not* added to `CheckpointId`; readiness validator stays unchanged |
| `quality-contracts/agent-readiness/` | Read-only — Pass 1 must not touch governance JSON | v3 governance artifacts are Pass 6, not Pass 1 |
| `eval/design-handoff-fixtures/briefs.json`, `eval/design-handoff-labels.json` (12 `labelVersion: 1` fixtures) | Preserved byte-for-byte — the new C2 contracts live alongside, not on top | No migration of v1 fixtures into C2 schemas |
| `scripts/design-handoff-scorer.test.mjs` + scorer | The scorer remains the structural/safety authority per C2 spec §8 | C2 does not define a competing scorer |
| Canonical SHA-256 helpers (`canonicalJsonStringify`, `sha256Hex`) | Consumed by the manifest builder (`scripts/build-c2-pilot-manifest.mjs`) for deterministic hashing | No new hashing utility |
| `npm run check-public-site-boundary` | Must stay green — pilot files must stay out of browser-downloadable assets | No new boundary check; Pass 1 piggybacks on the existing one |
| 12-tool catalog descriptor table (`src/tool-catalog.ts`) | Untouched — C2 is an evaluation concern, not a tool-surface change | No catalog edits |
| Public/private corpus readers | Untouched — Pass 1 uses synthetic evidence IDs only (e.g. `evidence:brief:audience-hierarchy`), never real corpus entries | No corpus reads in Pass 1 |

**Reuse discipline:** the C2 contract layer is *purely additive* — new files under `src/c2/`, `eval/c2/pilot/`, and one manifest builder script. Every existing system the plan depends on is treated as a frozen input. The `git diff --exit-code origin/main -- ...protected files...` command in the verification matrix (Step 4) enforces this at gate time.

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
- Produces: `C2LabelIntegritySelectionSchema`, `C2IndependentLabelSubmissionSchema`, `assertSubmissionMatchesSelection`, `C2_REPLACEMENT_METRIC_FLOORS`, `C2LabelAgreementReportSchema`, `assertAgreementMatchesSubmissions`, `C2EvaluationRunManifestSchema`, `C2HumanScorecardSchema`, `C2FailureReportSchema`, and inferred types.

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

it("cross-checks agreement hashes, actors, roles, selection, and entry disagreements", () => {
  expect(() => assertAgreementMatchesSubmissions(selection, goldOwnerSubmission, qaSubmission, agreement, resolvedHashes)).not.toThrow();
  expect(() => assertAgreementMatchesSubmissions(selection, qaSubmission, goldOwnerSubmission, agreement, resolvedHashes)).toThrow(/role|actor|reference/);
  expect(() => assertAgreementMatchesSubmissions(selection, goldOwnerSubmission, qaSubmission, agreement, { ...resolvedHashes, qaSubmissionSha256: "f".repeat(64) })).toThrow(/hash/);
  expect(() => assertAgreementMatchesSubmissions(selection, goldOwnerSubmission, qaSubmission, { ...agreement, disagreementEntryIds: ["entry-unselected"] }, resolvedHashes)).toThrow(/disagreement/);
});

it("rejects a report that lowers a parent-authority metric floor", () => {
  const lowered = { ...agreement, metrics: agreement.metrics.map((metric) => metric.metricId === "categories-macro-f1" ? { ...metric, requiredFloor: 0.80 } : metric) };
  expect(C2LabelAgreementReportSchema.safeParse(lowered).success).toBe(false);
});

it("forbids gold evidence in a brief-only run and requires it in gold-evidence", () => {
  expect(C2EvaluationRunManifestSchema.safeParse({ ...run, condition: "brief-only", evidenceIds: ["evidence:x"] }).success).toBe(false);
  expect(C2EvaluationRunManifestSchema.safeParse({ ...run, condition: "gold-evidence", evidenceIds: [] }).success).toBe(false);
});

it("enforces the run lifecycle as a closed state machine", () => {
  expect(C2EvaluationRunManifestSchema.safeParse({ ...run, status: "running", finishedAt: new Date().toISOString() }).success).toBe(false);
  expect(C2EvaluationRunManifestSchema.safeParse({ ...run, status: "succeeded", parsedOutputSha256: null }).success).toBe(false);
  expect(C2EvaluationRunManifestSchema.safeParse({ ...run, status: "cost-blocked", promptTokens: 1 }).success).toBe(false);
});

it("requires six unique human-score dimensions with integer scores 1 through 5", () => {
  expect(C2HumanScorecardSchema.parse(scorecard).scores).toHaveLength(6);
  expect(C2HumanScorecardSchema.safeParse({ ...scorecard, scores: [{ ...scorecard.scores[0], score: 6 }] }).success).toBe(false);
});

it("derives implementation readiness from the frozen per-dimension floor", () => {
  const belowFloor = { ...scorecard, implementationReady: true, scores: scorecard.scores.map((item, index) => index === 0 ? { ...item, score: 2 } : item) };
  expect(C2HumanScorecardSchema.safeParse(belowFloor).success).toBe(false);
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
```

- [ ] **Step 4: Export, test, and typecheck**

Append `export * from "./evaluation-contracts.js";` to `src/c2/index.ts`, then run:

```bash
npx vitest run src/c2/evaluation-contracts.test.ts
npm run typecheck:contracts
```

Expected: PASS with semantic negative cases rejected.

- [ ] **Step 5: Review and commit Task 2**

Review the 35/5 exact counts, selection/submission ID equality, agreement-to-submission actor/role/reference binding, distinct sealed roles, agreement outcome consistency, exact metric/hard-gate sets, the complete run-state machine, six-dimension scorecard/readiness consistency, and failure-attribution prerequisites. Write the sanctioned review artifact, then commit:

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

it("permits only label-failure proposals and rejects protected corpus fields", () => {
  expect(C2RetagProposalSchema.safeParse({ ...proposal, failureClassification: "coverage" }).success).toBe(false);
  for (const fieldPath of ["id", "source", "image", "addedAt", "capture.url"]) {
    expect(C2RetagProposalSchema.safeParse({ ...proposal, fieldPath }).success).toBe(false);
  }
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
  failureClassification: z.literal("label"),
  entryId: StableId,
  fieldPath: z.string().trim().regex(/^(patternType|categories|components|domainTags|visualFields|groundedClaimIds|accessibilityEvidenceIds|critiqueQuality)(?:\.[a-zA-Z0-9_-]+)*$/),
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

Also reject `undefined`, functions, symbols, non-finite numbers, and cyclic values in `proposedValue` by calling `canonicalJsonStringify` inside a `.superRefine()` and checking that `sha256Hex(canonicalJsonStringify(value.proposedValue)) === value.proposedValueCanonicalSha256`. Catch canonicalization errors and add a schema issue rather than throwing from parsing. The `fieldPath` allowlist is the enforcement boundary: identity, provenance, capture, image, publication, and source fields cannot be proposed for retagging.

Export `assertProposalMatchesFailure(proposal, failure)` and require the referenced failure artifact ID to match, `failure.classification === "label"`, `failure.caseId` to appear in `proposal.affectedCaseIds`, `proposal.entryId` to appear in `failure.affectedEntryIds`, and `proposal.fieldPath` to appear in `failure.affectedFieldPaths`. The schema pins the classification; this cross-artifact assertion proves the proposal did not merely claim it.

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

Review canonical-value hashing without parser throws, the retaggable-field allowlist, label-failure cross-reference binding, exact-ID/pre-change binding, human-only review, rollback-before-expansion, provisional-only evidence state, and the non-activation boundary. Write the task-review artifact, then commit:

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

it("rejects symlinks, orphan labels, orphan snapshots, and temporary-file residue", async () => {
  await expect(buildPilotManifest(symlinkRoot)).rejects.toThrow(/symbolic link/);
  await expect(buildPilotManifest(orphanLabelRoot)).rejects.toThrow(/orphan label/);
  await expect(buildPilotManifest(orphanSnapshotRoot)).rejects.toThrow(/orphan snapshot/);
});
```

Include fixtures made in a temporary directory; never edit tracked pilot files in negative tests.

- [ ] **Step 2: Run generator tests and confirm RED**

Run `npx vitest run scripts/build-c2-pilot-manifest.test.mjs`.

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic manifest generation**

Implement `scripts/build-c2-pilot-manifest.mjs` using `readFile`, `readdir`, `writeFile`, `createHash`, and `pathToFileURL`. Requirements:

- Read every `briefs/*.json` and matching `labels/<caseId>.json`.
- Use `lstat` and reject symbolic links for the pilot root, artifact directories, manifest, and every input file; do not follow repository-external files.
- Reject non-JSON entries, orphan labels, orphan snapshots, duplicate filenames after case normalization, and any extra case artifact not represented by the exact three briefs.
- Require exactly three cases and exactly one `product`, `migration`, and `safety` family.
- Require matching `caseId` and `caseVersion`.
- Require migration to bind exactly one existing snapshot; forbid snapshots for other families.
- Hash the exact file bytes with SHA-256.
- Sort packages by `caseId`.
- Emit two-space-indented JSON plus one trailing newline.
- Export `buildPilotManifest(root)` and `checkPilotManifest(root)`.
- With `--check`, compare bytes and exit nonzero without writing.
- Without `--check`, write `eval/c2/pilot/manifest.json` atomically through a uniquely named sibling temporary file, `fsync` the file, close it, rename it, and remove the temporary file on every failure path.

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

Review exact-byte hashing, path normalization, symlink refusal, orphan/extra-file rejection, crash-safe atomic write and cleanup, check-mode non-mutation, and sorted output. Write the task-review artifact, then commit:

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
import { readdirSync, readFileSync } from "node:fs";
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
    const governanceRoot = resolve(root, "quality-contracts/agent-readiness");
    const files = readdirSync(governanceRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"));
    for (const entry of files) {
      const tracked = readFileSync(resolve(entry.parentPath, entry.name), "utf8");
      expect(tracked).not.toMatch(/"checkpoint"\s*:\s*"C2"|"artifactType"\s*:\s*"c2-/);
    }
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
7. Bind an agreement report to swapped-role or wrong-actor submissions and confirm cross-artifact validation rejects it.
8. Construct contradictory `running`, `failed`, `succeeded`, and `cost-blocked` run states and confirm rejection.
9. Mark a below-floor scorecard implementation-ready and confirm rejection.
10. Propose a retag for a protected field or a non-label failure and confirm rejection.
11. Approve canary expansion with unverified rollback and confirm rejection.
12. Replace an input with a symlink or add an orphan label/snapshot and confirm manifest generation rejects it.
13. Add a private-corpus marker to a pilot artifact and confirm the fixture scan fails.
14. Confirm default tests perform no network request and require no provider credential.
15. Confirm no C2 policy, recipe, approval, registry, index, ledger, or corpus diff exists.

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

## Implementation Tasks

Synthesized from the architecture, test, and scope findings above. Each task maps to a Task in this plan. Run with Claude Code or Codex; checkbox as you ship. (Backfilled 2026-07-19 to satisfy `/plan-eng-review`'s required outputs — the work itself shipped in PR #38.)

- [x] **T1 (P1, human: ~6h / CC: ~30min)** — `src/c2/` — Add C2 primitives and separated case-package contracts (model-visible brief, reviewer-only label, source-snapshot, bound case package)
  - Surfaced by: Architecture review — model/reviewer separation is the central design principle and must be enforced at schema level
  - Files: `src/c2/primitives.ts`, `src/c2/case-contracts.ts`, `src/c2/case-contracts.test.ts`, `src/c2/index.ts`
  - Verify: `npx vitest run src/c2/case-contracts.test.ts` — strict parsing rejects reviewer-only fields in briefs

- [x] **T2 (P1, human: ~8h / CC: ~45min)** — `src/c2/` — Add label-integrity (35+5), run, scorecard, and failure contracts with agreement binding
  - Surfaced by: Architecture review — independent sealed submissions + agreement report with frozen metric floors are the integrity backbone
  - Files: `src/c2/evaluation-contracts.ts`, `src/c2/evaluation-contracts.test.ts`, `src/c2/index.ts`
  - Verify: `npx vitest run src/c2/evaluation-contracts.test.ts` — wrong cohort counts, swapped roles, and contradictory run states all rejected

- [x] **T3 (P1, human: ~5h / CC: ~25min)** — `src/c2/` — Add shadow-remediation + provisional-governance contracts (retag allowlist, canary rollback, provisional evidence manifest pinned to `state: "provisional"`)
  - Surfaced by: Architecture review — remediation must be candidate-only with rollback-before-expansion; governance must be *provisional* with no closure schema
  - Files: `src/c2/remediation-contracts.ts`, `src/c2/governance-contracts.ts`, `*.test.ts`, `src/c2/index.ts`
  - Verify: `npx vitest run src/c2/remediation-contracts.test.ts src/c2/governance-contracts.test.ts` — protected-field retags, unverified rollback, frozen/approval fields all rejected

- [x] **T4 (P1, human: ~3h / CC: ~15min)** — `eval/c2/pilot/` — Author three separated pilot packages (product `stablecoin-home`, migration `public-marketing-migration`, safety `named-inspiration-safety`)
  - Surfaced by: Test review — Pass 1 needs at least one case per family to exercise the contracts; the spec mandates product/migration/safety coverage
  - Files: `eval/c2/pilot/briefs/*.json`, `eval/c2/pilot/labels/*.json`, `eval/c2/pilot/source-snapshots/*.json`
  - Verify: packages parse through `C2CaseBriefSchema` + `C2DecisionLabelSchema`; safety brief rejects proprietary references

- [x] **T5 (P1, human: ~3h / CC: ~20min)** — `scripts/` — Deterministic pilot manifest generator with SHA-256 binding, symlink rejection, orphan detection, atomic write, stale-check mode
  - Surfaced by: Architecture review — content-addressing the pilot prevents silent drift; symlink/orphan defense prevents path-traversal and dangling references
  - Files: `scripts/build-c2-pilot-manifest.mjs`, `scripts/build-c2-pilot-manifest.test.mjs`, `package.json` (`generate:c2-pilot`, `validate:c2-pilot`)
  - Verify: `npm run validate:c2-pilot` — 3 packages, up to date; `--check` mode rejects stale hashes; two builds byte-identical
  - Determinism caveat: byte-identical builds hold because `canonicalJsonStringify` sorts keys. This is a present-tense property pinned to the current helper version, not a permanent guarantee — if the canonical-JSON helper or Node's serialization changes key ordering in a future pass, the manifest hash flips and `validate:c2-pilot` fails for everyone simultaneously with no code change. Worth a regression test that pins the canonical ordering if this ever becomes load-bearing across passes.

- [x] **T6 (P1, human: ~2h / CC: ~15min)** — `src/c2/pass1-boundary.test.ts`, `docs/AGENT_READINESS_STATUS.md` — Lock Pass 1 scope boundary + record provisional readiness status
  - Surfaced by: Scope review — Pass 1 must *provably* not close C2; the inverse gate asserts absence of checkpoint recipe/policy/registry/validator
  - Files: `src/c2/pass1-boundary.test.ts`, `docs/AGENT_READINESS_STATUS.md`
  - Verify: `npx vitest run src/c2/pass1-boundary.test.ts` — inverse gate passes; `npm run validate-readiness-artifacts -- --mode public` reports C0/C1 closed, C2 open (the `-- --mode public` is required — bare invocation exits 0 while printing only usage and validates nothing)

**Severity rationale:** all six tasks are P1 because each blocks the Pass 1 completion gate. None is P2 (same-branch nice-to-have) or P3 (follow-up) — Pass 1 is intentionally minimal and every task is load-bearing for the boundary claim.

**Effort labels:** human estimates assume a TypeScript engineer familiar with Zod; CC estimates assume Claude Code or Codex with the plan in hand. **These are retroactive approximations derived from reading the plan, not measurements from PR #38 commit timestamps or telemetry.** Treat as order-of-magnitude guidance for Pass 2–6 scoping, not as a calibrated baseline. If Pass 2 needs real numbers, instrument the next agentive run.

## Deferred to Later Passes

- Pass 2: evaluation-only provider harness, cost approval, three-case controlled execution, material-benefit calibration, compatibility checklist, and rubric/budget freeze.
- Pass 3: deterministic 35-plus-5 selection, two independent label submissions, agreement/adjudication, full 25-case authoring, primary execution, independent challenge execution, and blinded scoring.
- Pass 4: evidence-backed failure adjudication and corrected-label shadows.
- Pass 5: candidate generation, exact-ID canary promotion, acquisition for blocking coverage gaps, and rollback demonstration.
- Pass 6: frozen rerun, C2 recipe/policy activation, v3 governance artifacts, Gold Label Owner approval, external QA approval, and checkpoint closure.

## Reviewed Execution and Coverage Map

```text
AUTHORING / BUILD PATH                               FAILURE AND TEST PATHS

pilot brief JSON                                    strict brief schema
  -> reviewer-only label JSON                         -> unknown/reviewer fields rejected [UNIT]
  -> optional immutable migration snapshot            -> missing/wrong snapshot rejected [UNIT]
  -> manifest builder                                 -> symlink/orphan/extra file rejected [UNIT]
       -> exact-byte SHA-256                           -> stale hash rejected in --check [INTEGRATION]
       -> sorted canonical manifest                    -> two builds are byte-identical [INTEGRATION]

35+5 frozen selection                               independent human submissions
  -> exact entry-set assertion                        -> wrong count/set/role rejected [UNIT]
  -> sealed Gold Label Owner submission               -> no cross-review before unseal [OPERATIONAL GATE]
  -> sealed QA submission                             -> actor/role/hash mismatch rejected [UNIT]
  -> agreement report                                 -> lowered floor/hard-gate failure cannot qualify [UNIT]

case package + allowed evidence                     evaluation run state machine
  -> brief-only/current/gold/shadow condition          -> forbidden/missing evidence rejected [UNIT]
  -> running/succeeded/failed/cost-blocked             -> contradictory timestamps/hashes/cost rejected [UNIT]
  -> blinded six-dimension scorecard                   -> score range/duplicates/readiness lie rejected [UNIT]
  -> controlled failure report                         -> attribution prerequisites rejected [UNIT]

confirmed label failure                            candidate-only remediation
  -> exact entry + retaggable field allowlist          -> protected/non-label proposal rejected [UNIT]
  -> canonical proposed-value hash                     -> invalid/cyclic/hash mismatch rejected [UNIT]
  -> human review                                      -> agent/unbound review rejected [UNIT]
  -> canary + rollback proof                           -> expansion without rollback rejected [UNIT]

Pass 1 boundary                                    readiness/public boundaries
  -> provisional evidence contract                    -> frozen/approval fields rejected [UNIT]
  -> no C2 recipe, policy, or governance artifact      -> all governance JSON scanned [INTEGRATION]
  -> eval/ only                                        -> public-site corpus boundary remains green [INTEGRATION]
```

Performance is deliberately bounded in Pass 1: three pilot packages, forty integrity records, and linear scans over small arrays and artifact directories. No provider, embedding, crawl, network, or corpus-index work executes. Manifest generation is `O(files + bytes)` and retains only parsed pilot artifacts in memory. Any later full-run concurrency, rate limiting, retries, provider cost, and large-corpus indexing belong to Pass 2 or later and must be measured there rather than guessed here.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | NOT RUN | Product scope was settled in the approved C2 design |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | NOT RUN | No external model review requested |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 6 issues found and folded; 0 critical gaps remain |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | NOT APPLICABLE | Pass 1 changes contracts and evaluation artifacts, not UI |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | NOT RUN | Generator CLI behavior is specified and tested in this plan |

**VERDICT:** ENG CLEARED — ready to implement Pass 1 without activating or claiming C2 closure.

NO UNRESOLVED DECISIONS

### Backfill note (2026-07-19, post-merge audit)

A post-merge audit against `/plan-eng-review`'s required outputs found four gaps in the original plan bookkeeping. None reflects missing work — the code shipped in PR #38 with the full test suite green (the exact count drifts as tests land across passes; see commit `5dd1124` for the merge-time evidence rather than trusting any integer in a retrospective doc) — but they are documentation-debt the skill mandates:

1. **"What already exists" section** — backfilled above (after Global Constraints). The reuse discipline was implicit in the Global Constraints; now explicit per the skill's required outputs.
2. **`## Implementation Tasks` (T1..Tn with effort labels + source findings)** — backfilled above (before "Deferred to Later Passes"). The plan structured work as Task 1–6; this re-states it in the skill's `T1 (P1, human: ~X / CC: ~Y)` format with per-task source findings and verify commands.
3. **`*-eng-review-test-plan-*.md` artifact** — was not written to `~/.gstack/projects/clean-ui-mcp/` for the C2 Pass 1 branch (only the Jul 14 agent-readiness artifacts exist). Written retroactively as `olaniyi.oladokun-codex-c2-gold-readiness-design-eng-review-test-plan-20260719-<ts>.md`.
4. **`tasks-eng-review-*.jsonl`** — same: not written for the C2 branch. Written retroactively so `/autoplan` can aggregate it.

**AskUserQuestion decision trail.** The "6 issues found and folded" claim in the Eng Review row is recorded as a count-level artifact at `.zcode/reviews/tasks/63464ae45dfb1ca09a65769bef1f7bd54e33abbe.json` (`{critical: 0, important: 6, minor: 0, resolvedInReviewedAmendment: 6}`), so the count itself has provenance. **What's missing is the detail**: the 6 issues are not surfaced as named findings with options + rationale — only their count and resolution status are recorded. The issues were absorbed directly into plan revisions during the interactive review rather than captured as decision briefs. **Forward commitment for Pass 2:** enrich the existing task-review artifact format so each finding carries issue text, options considered, the chosen option, and rationale — so the "N issues folded" claim is auditable from the artifact alone, not just re-countable.

**Outside voice (Codex) skip.** The "Codex Review | NOT RUN" row predates `/plan-eng-review`'s default-on outside-voice behavior. The skip was treated as defensible because the C2 design spec was already approved, but the skill's current default is to run an independent challenge unless `gstack-config set codex_reviews disabled` is set explicitly. **Forward commitment for Pass 2:** run the outside voice (Codex if available, Claude subagent otherwise) and record any cross-model tension in the plan.

## Worktree parallelization strategy

Sequential implementation — no parallelization opportunity. Tasks 1–3 (primitives → evaluation → remediation contracts) form a strict dependency chain: each consumes schemas defined in the prior task. Tasks 4–5 (pilot packages → manifest) depend on the contracts being in place. Task 6 (boundary test + readiness status) depends on everything being committed. No two tasks touch disjoint module sets in a way that would benefit from worktree parallelism.

## Failure modes

For each new codepath in the test diagram above, one realistic production failure and its coverage:

| Codepath | Failure mode | Test? | Error handling? | User-visible? |
|---|---|---|---|---|
| Brief parsing | Reviewer-only field leaks into brief | ✓ strict `.strict()` + cross-field `superRefine` | ✓ throws ZodError | Clear — build fails |
| Manifest generation | Symlink substitution | ✓ `scripts/build-c2-pilot-manifest.test.mjs` | ✓ throws with path | Clear — generation aborts |
| Manifest freshness | Stale hash after label edit | ✓ `--check` mode test | ✓ exit non-zero | Clear — `validate:c2-pilot` fails |
| Migration snapshot | Missing or mismatched snapshot | ✓ orphan-label test | ✓ throws | Clear — fixture parse fails |
| Label agreement | Swapped Gold/QA roles | ✓ `assertAgreementMatchesSubmissions` | ✓ throws | Clear — parse fails |
| Run state machine | `status: "running"` with `finishedAt` set | ✓ `src/c2/evaluation-contracts.test.ts:364` | ✓ throws ZodError | Clear — parse fails |
| Retag proposal | Protected field retag | ✓ remediation-contracts test | ✓ throws | Clear — parse fails |
| Canary expansion | Unverified rollback | ✓ remediation-contracts test | ✓ throws | Clear — parse fails |
| Scope boundary | C2 policy/recipe slips in | ✓ `pass1-boundary.test.ts` inverse gate | ✓ test fails | Clear — gate fails |

**No critical gaps.** Every failure mode has both a test AND error handling AND would surface as a clear parse/gate failure rather than a silent corruption. No silent-failure path exists in the Pass 1 boundary.

## NOT in scope

- **40-entry gold selection, independent external labeling** — Pass 3. Pass 1's three packages are synthetic and internal.
- **Provider/model run, paid execution, cost ceilings** — Pass 2. Pass 1 makes zero paid calls.
- **Retag generation, corpus mutation, canary promotion** — Pass 5. Pass 1 defines the *contracts* for these but executes none.
- **Failure adjudication, corrected-label shadows** — Pass 4. Pass 1 defines the failure-report schema but runs no shadows.
- **C2 checkpoint recipe/policy/registry/index/ledger/approvals, validator activation** — Pass 6. Pass 1's governance contract is pinned to `state: "provisional"` and has no approvals field.
- **Cross-artifact runtime validators** (submission↔selection binding enforcement, metric derivation, scorecard↔run resolution, retag hash verification) — Pass 2 activates the ones the harness exercises; Pass 1 only defines the schemas they will validate.

## Completion summary (backfilled 2026-07-19)

- Step 0: Scope Challenge — scope accepted as-is (3 pilot packages, 4 contract modules, 1 manifest builder, 1 boundary test; no scope reduction)
- Architecture Review: 0 critical findings — module boundaries clean, dependency graph acyclic, model/reviewer separation enforced at schema level
- Code Quality Review: 6 issues folded (per Eng Review row); all absorbed into plan revisions
- Test Review: coverage diagram produced (Reviewed Execution and Coverage Map), 0 gaps — every branch in the test diagram has a corresponding `[UNIT]`/`[INTEGRATION]`/`[OPERATIONAL GATE]` test
- Performance Review: 0 findings — bounded by design (linear scans, 3 packages, 40 records)
- NOT in scope: written above
- What already exists: written above
- TODOS.md updates: 0 — all work captured as Pass 2–6 deferrals
- Failure modes: 0 critical gaps (see table above)
- Outside voice: skipped (see note above)
- Parallelization: sequential, 0 parallel lanes
- Lake Score: N/A — no completeness tradeoffs presented; Pass 1 is the complete version by design
