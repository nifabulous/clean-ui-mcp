# C2 Pass 3: Frozen 25-Case Baseline and Label-Integrity Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the two independent Pass 3 evidence pipelines—40-entry label integrity and the frozen 25-case decision-quality baseline—without mutating the corpus or claiming C2 closure before both gates pass.

**Architecture:** Keep the workstreams separate at the contract, artifact, test, and reporting layers. Reuse the Pass 2 harness and blinded-review machinery, but introduce a distinct 25-case manifest and a pure closure evaluator that consumes only the frozen calibration and committed evidence. Deliver the work as reviewable PRs: offline infrastructure first, reviewed case content second, and paid execution/evidence last.

**Tech Stack:** TypeScript, Zod contracts, Vitest, Node CLI scripts, SHA-256 content addressing, existing `executeC2Run` harness, existing blinded scorecard workflow, and the frozen artifact at `eval/c2/calibration/frozen.json`.

## Global Constraints

- C2 remains open until both Workstream A and Workstream B pass; one cannot compensate for the other.
- The 40-entry gate requires two independent human labelers: Gold Label Owner and an external QA reviewer. A sole maintainer cannot satisfy it.
- No external QA reviewer is currently available; label submission and agreement are therefore a blocked human gate, not a simulated pass.
- The baseline is exactly 25 cases: 15 product, 5 migration, and 5 safety.
- The existing three pilot cases count toward those totals; author exactly 22 new cases: 14 product, 4 migration, and 4 safety.
- The Pass 2 pilot manifest and frozen calibration remain byte-for-byte unchanged.
- The runner reads thresholds only from the frozen calibration; reject CLI threshold overrides.
- No corpus mutation, retagging, Pass 4 work, or C2 closure is permitted in this plan.
- Default tests and verification must make zero paid provider calls.
- The independent execution matrix must be declared in a committed manifest. Do not infer its scope from code. This plan uses the Pass 2-compatible design: primary lane on all 25 cases × 3 conditions, independent lane on the declared 5-case current-grounded subset; change the manifest before implementation if the approved gold-readiness specification requires a different matrix.
- The frozen calibration's `criticalDecisionCoverageComplete: false` remains visible in every report; it is never promoted to `true` by the evaluator.

## Evidence and File Map

### Existing contracts and machinery to reuse

- `src/c2/harness.ts` — immutable run lifecycle and provider/cost controls.
- `src/c2/evaluation-contracts.ts` — V2 run manifests and human scorecards.
- `src/c2/review-packets.ts` — blinded packet and scorecard finalization.
- `src/c2/calibration.ts` — frozen calibration and evidence binding.
- `src/scripts/run-c2-pilot.ts` — Pass 2 campaign CLI and loader patterns.
- `eval/c2/calibration/frozen.json` — sole source of Pass 3 thresholds.

### New durable artifacts

- `eval/c2/baseline/manifest.json` — 25-case content-addressed manifest.
- `eval/c2/baseline/runs/<runId>/` — successful/terminal manifests and scores only after paid authorization.
- `eval/c2/baseline/scorecards/` — finalized blinded scorecards after human review.
- `eval/c2/baseline/closure-report.json` — deterministic threshold report; records pass/fail and partial compatibility.
- `eval/c2/label-integrity/selection.json` — frozen 40-entry selection.
- `eval/c2/label-integrity/agreement-report.json` — written only after two valid independent submissions exist.

### New source files

- `src/c2/baseline-manifest.ts` and `src/c2/baseline-manifest.test.ts`
- `src/c2/closure-evaluator.ts` and `src/c2/closure-evaluator.test.ts`
- `src/c2/label-selection.ts` and `src/c2/label-selection.test.ts`
- `src/c2/label-agreement.ts` and `src/c2/label-agreement.test.ts`
- `src/scripts/build-baseline-manifest.mts`
- `src/scripts/build-label-integrity-selection.mts`
- `src/scripts/collect-label-submissions.mts`
- `src/scripts/run-c2-baseline.ts` and `src/scripts/run-c2-baseline.test.ts`

## Phase 0: Freeze the specification and baseline inventory

### Task 0.1: Verify counts, metric IDs, and execution matrix

**Files:**
- Read: the approved gold-readiness specification §9 and the Pass 2 frozen calibration.
- Create: `docs/c2/pass3-spec-lock.md`

- [ ] Record the exact eight label-integrity metric IDs and their floors from the specification. Do not invent names for the two metrics omitted from the draft.
- [ ] Record the exact eight decision-quality closure checks, their denominators, floors, and rounding rules.
- [ ] Record the 25-case family allocation and the independent-lane matrix explicitly.
- [ ] Record the case inventory: 1 existing product pilot + 14 new product cases; 1 migration pilot + 4 new migration cases; 1 safety pilot + 4 new safety cases.
- [ ] Fail the spec-lock review if any count, metric, threshold, or matrix entry is ambiguous.

**Acceptance:** A reviewer can determine every required case, metric, threshold, and run from the spec-lock file without interpreting source code.

### Task 0.2: Establish the clean baseline branch and offline gate

- [ ] Branch from merged `main` as `codex/c2-pass3-infrastructure`.
- [ ] Run `npm run build` and `npm test -- --run --exclude src/scripts/dom-motion-capture.test.ts`.
- [ ] Verify `sha256(eval/c2/calibration/frozen.json)` and the referenced evidence hashes before any new artifact is generated.
- [ ] Record the command output in the PR description; do not include private raw responses.

**Commit:** `chore(c2): lock pass 3 specification and baseline`.

## Workstream A: 40-entry label-integrity gate

### Task A1: Add the selection contract

**Files:**
- Create: `src/c2/label-selection.ts`
- Test: `src/c2/label-selection.test.ts`

**Interface:**

```ts
export interface LabelSelectionInput {
  entries: ReadonlyArray<CorpusEntryForLabelSelection>;
  seed: "clean-ui-retag-v1";
  strataConfig: LabelStrataConfig;
}

export interface C2LabelIntegritySelection {
  schemaVersion: "1.0";
  artifactType: "c2-label-integrity-selection";
  artifactId: string;
  seed: "clean-ui-retag-v1";
  reproducibleEntryIds: string[]; // exactly 35
  challengeEntries: Array<{ entryId: string; rationale: string }>; // exactly 5
  corpusSnapshotSha256: string;
  selectionSha256: string;
}

export function buildLabelIntegritySelection(input: LabelSelectionInput): C2LabelIntegritySelection;
```

- [ ] Write failing tests for deterministic byte identity, exactly 35 + 5 entries, no duplicates, corpus-snapshot binding, and replacement by the next hash-ordered entry within the same stratum.
- [ ] Define strata from the existing entry fields: pattern type, platform/image dimensions, component density, and evidence quality. Persist the derived stratum for every selected entry so reviewers can audit balance.
- [ ] Sort candidates within each stratum by `sha256("${seed}:${entryId}")`; select the configured quota.
- [ ] Accept the five challenge entries as explicit, rationale-bearing inputs; never silently mix challenge entries into the reproducible 35.
- [ ] Parse the result with a strict Zod schema and canonicalize before hashing.
- [ ] Run `npm test -- --run src/c2/label-selection.test.ts`.

**Commit:** `feat(c2): add deterministic label-integrity selection contract`.

### Task A2: Generate and boundary-check the frozen selection artifact

**Files:**
- Create: `src/scripts/build-label-integrity-selection.mts`
- Create: `eval/c2/label-integrity/selection.json`
- Modify: `package.json` with `generate:c2-label-selection` and `validate:c2-label-selection` scripts.

- [ ] Load the read-only corpus snapshot and the spec-locked strata configuration.
- [ ] Generate `selection.json` atomically after boundary scanning.
- [ ] Add `--check` mode that regenerates in memory and fails on byte drift.
- [ ] Verify all 40 selected IDs exist in the corpus and no private path/raw output is serialized.
- [ ] Run `npm run validate:c2-label-selection` twice and confirm byte-identical output.

**Gate A1:** deterministic, reproducible 40-entry selection; no labels have been fabricated.

### Task A3: Add independent submissions and agreement contracts

**Files:**
- Create: `src/c2/label-agreement.ts`
- Test: `src/c2/label-agreement.test.ts`
- Create: `src/scripts/collect-label-submissions.mts`

**Interface:**

```ts
export type LabelerRole = "Gold Label Owner" | "External QA";

export interface C2IndependentLabelSubmission {
  schemaVersion: "1.0";
  artifactType: "c2-independent-label-submission";
  selectionSha256: string;
  labelerActorId: string;
  labelerRole: LabelerRole;
  entries: ReadonlyArray<C2EntryLabel>; // exactly the 40 selected entries
  submittedAt: string;
}

export function computeLabelAgreement(
  gold: C2IndependentLabelSubmission,
  qa: C2IndependentLabelSubmission,
  thresholds: LabelAgreementThresholds,
): C2LabelAgreementReport;
```

- [ ] Reject submissions with the same actor ID, same role, wrong selection hash, missing entry IDs, duplicate IDs, or non-canonical ordering.
- [ ] Compute the eight spec-locked metrics and their per-metric pass/fail decisions.
- [ ] Return `Qualified` only when every hard gate passes; otherwise return `Replacement not justified` with machine-readable failures.
- [ ] Keep adjudication separate: disagreement must be reported before any adjudicated label is recorded.
- [ ] Test exact agreement, one-metric failure, cross-entry disagreement, tampered selection hash, and same-labeler misuse.
- [ ] The collection script must refuse to synthesize a missing external QA submission.

**Gate A2:** selection and agreement tooling is ready; actual labeling remains blocked until an external QA reviewer is available.

### Task A4: Human labeling gate (blocked)

- [ ] Obtain an external QA reviewer with a distinct actor ID and role.
- [ ] Deliver the same frozen `selection.json` to both labelers independently.
- [ ] Collect two sealed submissions without exposing either labeler's answers to the other.
- [ ] Run agreement; if any hard gate fails, record disagreements and adjudicate under the spec without rewriting the independent submissions.
- [ ] Store only the permitted durable artifacts and keep raw/private workflow data under `.c2-private/`.

**Acceptance:** Workstream A passes only with two valid independent submissions, a complete agreement report, and all hard gates qualified. Until then, C2 closure is prohibited.

## Workstream B: 25-case decision-quality baseline

### Task B1: Add the 25-case manifest contract

**Files:**
- Create: `src/c2/baseline-manifest.ts`
- Test: `src/c2/baseline-manifest.test.ts`

**Interface:**

```ts
export const C2BaselineManifestSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-baseline-manifest"),
  artifactId: z.string(),
  caseCount: z.literal(25),
  familyCounts: z.object({ product: z.literal(15), migration: z.literal(5), safety: z.literal(5) }),
  cases: z.array(C2BaselineCaseRefSchema).length(25),
  executionMatrix: C2ExecutionMatrixSchema,
  frozenCalibrationRef: ArtifactFileRefSchema,
  manifestSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
```

- [ ] Reject duplicate case IDs, wrong family counts, missing gold-evidence bindings, and a calibration ref whose file hash does not match.
- [ ] Validate the execution matrix as data, including the exact independent subset and conditions.
- [ ] Keep this schema separate from `C2PilotManifestSchema`; do not change the three-case pilot contract.
- [ ] Add tests for every count and binding failure.

**Commit:** `feat(c2): add frozen 25-case baseline manifest contract`.

### Task B2: Implement the pure closure evaluator

**Files:**
- Create: `src/c2/closure-evaluator.ts`
- Test: `src/c2/closure-evaluator.test.ts`

**Interface:**

```ts
export interface ClosureEvaluationInput {
  manifest: C2BaselineManifest;
  frozenCalibration: C2FrozenCalibration;
  runs: ReadonlyArray<C2EvaluationRunManifestV2>;
  scorecards: ReadonlyArray<C2HumanScorecard>;
}

export function evaluateC2Closure(input: ClosureEvaluationInput): C2ClosureReport;
```

- [ ] Implement each spec-locked check independently: family implementation-ready counts, overall count, product dimension means, no score below 3, material benefit, regression tolerance, safety non-inferiority, and independent compatibility.
- [ ] Bind every scorecard to its run ID and output hash before aggregating.
- [ ] Use the frozen calibration's material-benefit minimum, regression tolerance, and budget values; reject caller-supplied overrides.
- [ ] Report partial Claude compatibility exactly as frozen (`criticalDecisionCoverageComplete: false`) and make the compatibility check fail/partial according to the spec; never reinterpret it as complete.
- [ ] Test pass, one-threshold-fail, missing-run, duplicate-run, scorecard-hash drift, partial compatibility, and rounding-boundary cases.
- [ ] Run `npm test -- --run src/c2/closure-evaluator.test.ts`.

**Gate B1:** all closure checks compute deterministically on synthetic data and the three Pass 2 pilots without network access.

### Task B3: Build the baseline runner around existing harness primitives

**Files:**
- Create: `src/scripts/run-c2-baseline.ts`
- Test: `src/scripts/run-c2-baseline.test.ts`
- Modify: `src/c2/index.ts` only if the new public contracts need exports.
- Modify: `package.json` with `c2:baseline` and `validate:c2-baseline` scripts.

- [ ] Add `validate`, `prepare`, `run`, `scorecards`, and `closure` subcommands; default to offline behavior.
- [ ] Require `--calibration eval/c2/calibration/frozen.json` and verify its SHA-256 before any provider call.
- [ ] Load the 25-case manifest and refuse mismatched case counts, stale refs, or any threshold flags.
- [ ] Reuse `executeC2Run` and the Pass 2 cost/audit/immutability controls; do not fork provider logic.
- [ ] In offline tests, run against a temporary three-case manifest and synthetic/local run artifacts; assert zero egress and no mutation of `eval/c2/pilot` or corpus files.
- [ ] Add a preflight report showing planned run count, independent subset, forecast cost, and remaining budget before paid execution.

**Gate B2:** runner validates and evaluates the three pilots offline; no paid authorization is implicit.

### Task B4: Author and review the 22 new cases

**Files:**
- Create 14 product packages under `eval/c2/baseline/`.
- Create 4 migration packages under `eval/c2/baseline/`.
- Create 4 safety packages under `eval/c2/baseline/`.
- Create: `scripts/build-baseline-manifest.mjs`.
- Create: `eval/c2/baseline/manifest.json`.

- [ ] Author each case as a brief, reviewer-only decision label, and condition-specific gold-evidence descriptor.
- [ ] Product allocation: 4 additional stablecoin cases, 5 finance-news cases, and 5 UK personal-loan cases (14 new product cases total).
- [ ] Migration allocation: 4 new scenarios complementing the existing public-marketing-migration pilot.
- [ ] Safety allocation: 4 new adversarial scenarios complementing the existing named-inspiration-safety pilot.
- [ ] Ensure each case has unique IDs, explicit family membership, required critical decisions, safety constraints, and evidence bindings.
- [ ] Build the manifest atomically and run `npm run validate:c2-baseline`.
- [ ] Human review must approve briefs, labels, evidence descriptors, and family counts before any paid execution.

**Gate B3:** 25 cases are reviewed, frozen, content-addressed, and the manifest is byte-stable. This gate does not imply Workstream A has passed.

### Task B5: Execute, blind-score, and evaluate the baseline

**Files:**
- Create: `eval/c2/baseline/runs/`, `eval/c2/baseline/scorecards/`, and `eval/c2/baseline/closure-report.json` only after authorization.
- Modify: none of the Pass 2 artifacts.

- [ ] Run `prepare` and review the forecast; stop if any run exceeds the frozen per-run or campaign cap.
- [ ] Obtain explicit authorization for the declared matrix (primary 25 × 3 conditions plus the manifest-declared independent subset).
- [ ] Execute with audit logging and preserve terminal manifests for every attempted run, including bounded retries and failure reasons.
- [ ] Generate blinded review packets with no provider, model, condition, or case metadata.
- [ ] Have the Gold Label Owner score the required packets; finalize scorecards with run/output hash binding.
- [ ] Run the closure evaluator and write `closure-report.json` with every threshold, denominator, result, and failure reason.
- [ ] Do not rerun indefinitely for stochastic failures; use only the retry policy declared in the spec-lock and record exclusions explicitly.

**Gate B4:** decision-quality baseline has a deterministic closure report. It passes only if every B threshold passes and the independent-compatibility limitation is accepted by the governing spec.

## Final C2 closure gate

Create a machine-readable gate report that requires both conditions:

```ts
const canCloseC2 = labelIntegrity.status === "Qualified"
  && decisionQuality.status === "Passed"
  && closureReport.independentCompatibility.criticalDecisionCoverageComplete === true;
```

- [ ] Verify Workstream A has two independent labeler submissions and a qualified agreement report.
- [ ] Verify Workstream B has a passing closure report for all thresholds.
- [ ] Resolve the frozen calibration's current partial Claude coverage or explicitly record closure as blocked; do not silently override it.
- [ ] Obtain the required human authorization for closure.
- [ ] Only then prepare a separate closure/retagging proposal. This plan does not execute that mutation.

## PR and commit sequence

1. `chore(c2): lock pass 3 specification and baseline` — Phase 0.
2. `feat(c2): add deterministic label-integrity selection contract` — Tasks A1–A2.
3. `feat(c2): add independent label agreement tooling` — Task A3.
4. `feat(c2): add frozen 25-case manifest and closure evaluator` — Tasks B1–B2.
5. `feat(c2): add offline baseline runner` — Task B3.
6. `feat(c2): add reviewed 25-case baseline content` — Task B4.
7. `feat(c2): record authorized baseline evidence and closure report` — Task B5, only after paid authorization.
8. A separate closure PR after both independent gates pass.

## Verification checklist

- [ ] `npm run build` passes.
- [ ] `npm test -- --run --exclude src/scripts/dom-motion-capture.test.ts` passes with zero paid calls.
- [ ] Frozen calibration hash and all evidence refs remain valid.
- [ ] Selection is byte-identical for the same corpus snapshot and seed.
- [ ] Agreement rejects same-labeler and mismatched-selection submissions.
- [ ] Baseline manifest is exactly 25 cases with 15/5/5 family counts.
- [ ] Closure evaluator covers every spec-locked threshold and reports partial compatibility honestly.
- [ ] Runner rejects calibration drift and CLI threshold overrides.
- [ ] No corpus mutation, retagging, Pass 4 work, or C2 closure occurred.
- [ ] External QA availability remains an explicit gate, not an implied assumption.
