# C2 Pass 3 Execution and Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete C2 Pass 3 by resolving the Claude compatibility gap, satisfying the independent label-integrity gate, executing and scoring the frozen 25-case baseline, and closing C2 only when every required gate passes.

**Architecture:** Treat Claude remediation, label integrity, and decision-quality execution as separate evidence-producing workstreams. Reuse the existing C2 harness, baseline manifest, blinded-scorecard machinery, and fail-closed closure evaluator; do not create a second provider runner or mutate the corpus. A new calibration may be frozen only from hash-bound evidence and a human authorization artifact.

**Tech Stack:** TypeScript, Zod, Vitest, existing `executeC2Run` harness, `run-c2-pilot.ts`, `run-c2-baseline.ts`, SHA-256 artifact binding, private `.c2-private/` evidence storage, and the committed artifacts under `eval/c2/`.

## Global Constraints

- C2 remains open until both the 40-entry label-integrity gate and the 25-case decision-quality gate pass.
- C9 must remain false while `criticalDecisionCoverageComplete` is false; no CLI flag or exception may promote it to true.
- The pilot is exactly 12 runs; the Pass 3 baseline is exactly 80 runs: 25 cases × 3 primary conditions plus 5 current-grounded independent runs.
- Per-run cost ceiling is `$0.50`; campaign ceiling is `$5.00`; pricing must be fresh and exact for the pinned provider/model.
- No corpus mutation, retagging, public export of private evidence, Pass 4 work, or C2 closure occurs in this plan.
- Every paid attempt receives an immutable terminal manifest, raw-output hash where available, provider telemetry, cost, and an audit-log entry.
- Retries use new run IDs with predecessor binding; never overwrite a terminal run or silently exclude a failed attempt.
- Human-authored compatibility checklists and freeze authorizations are authoritative; CLI-synthesized compatibility remains non-authoritative.
- Default verification commands make zero paid provider calls.

## Current Baseline and Existing Artifacts

The following are already merged and must be consumed, not rebuilt:

- `eval/c2/baseline/manifest.json` — 25 cases with 15 product, 5 migration, and 5 safety cases.
- `eval/c2/baseline/{briefs,labels,evidence}/` — reviewed case packages.
- `eval/c2/calibration/frozen.json` — pilot calibration with partial Claude coverage.
- `eval/c2/label-integrity/selection.json` — deterministic 35 + 5 selection.
- `src/c2/harness.ts`, `src/c2/closure-evaluator.ts`, `src/c2/label-agreement.ts`, and the Pass 2 blinded review machinery.

The following are known prerequisites and must be resolved before the corresponding paid gate:

- `eval/c2/label-integrity/baseline-metrics.json` is still required from the parent authority.
- Two independent human labelers are required: Gold Label Owner and an external QA actor.
- The pilot frozen artifact records `STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION`; the missing stablecoin Claude run must be regenerated before C9 can pass.
- `src/scripts/run-c2-baseline.ts` currently has explicit `NOT IMPLEMENTED` paths for baseline preparation and paid execution; those paths must be completed before authorization.

### Strategic external risks

- If the parent authority never supplies `eval/c2/label-integrity/baseline-metrics.json`, the label-integrity gate cannot be evaluated and C2 remains open. No local estimate or submission-derived substitute is permitted.
- If the reviewed Claude remediation still truncates the stablecoin candidate after the existing thinking-disable fix, C9 remains blocked. The failure must be preserved and escalated as a provider-capacity blocker; the plan does not authorize indefinite retries or unbounded token increases.

## Workstream A: Claude Remediation and Pilot Re-freeze

### Task A1: Lock a reviewed Claude remediation configuration

**Files:**
- Modify: `eval/c2/config/pilot-campaign.json`
- Modify: `eval/c2/config/pricing.json`
- Test: `src/c2/condition-contracts.test.ts`
- Test: `src/scripts/run-c2-pilot.test.ts`

**Interfaces:** Reuse `C2CampaignConfigSchema`, `C2PricingTableSchema`, and `C2PinnedModelRequest`; do not add a second model-call API.

- [ ] Choose the approved Claude model/configuration that can return the stablecoin candidate without the 4096-token truncation. Set the independent lane's `maxOutputTokens` to `8192` (or a provider-confirmed higher effective ceiling) while leaving the OpenAI lane unchanged.
- [ ] Treat the config edit as a new campaign artifact: changing `pilot-campaign.json` changes its SHA-256 and invalidates the existing frozen calibration's campaign-config binding. The required recovery path is A2's new campaign evidence followed by A3's human-authorized re-freeze; never edit the old frozen artifact in place to conceal the drift.
- [ ] Preserve the Pass 2 thinking-disable behavior from commit `905fdb6` in the C2 provider request path; 8192 is justified as a bounded capacity increase after thinking tokens were removed, not as an unbounded prompt-tuning loop.
- [ ] Update the pricing entry so its `provider` and `model` exactly match the selected independent lane, with a current `verifiedAt` and authoritative source URL. Reject a config/pricing model mismatch in the test fixture.
- [ ] Add a test that parses the remediation config and asserts: provider is `claude`, independent output ceiling is at least `8192`, primary output ceiling is unchanged, campaign limits remain `0.5` and `5`, and all 12 matrix fields remain pinned.
- [ ] Add a test that `findPricingEntry` resolves the exact selected Claude model and rejects stale or differently named pricing entries.
- [ ] Run:

```bash
npm test -- --run src/c2/condition-contracts.test.ts src/scripts/run-c2-pilot.test.ts
npm run typecheck:contracts
```

**Acceptance:** The remediation config and pricing table are schema-valid, exact-model-bound, fresh, and preserve the reviewed matrix and cost caps.

### Task A2: Re-run the pilot with the reviewed configuration

**Files:**
- Create privately: `.c2-private/c2/remediation/`
- Create privately: `.c2-private/c2/attic/<timestamp>/`
- Create evidence: `eval/c2/runs/<runId>/` only after explicit authorization
- Modify: none of the historical pilot artifacts in place

- [ ] Run the offline gates before any paid command:

```bash
npm test -- --run --exclude src/scripts/dom-motion-capture.test.ts
npm run build
npx tsx src/scripts/run-c2-pilot.ts prepare --config eval/c2/config/pilot-campaign.json --pricing eval/c2/config/pricing.json
```

- [ ] Move the prior pilot run directories and scorecards to the private attic with a manifest listing their original paths and SHA-256 hashes. Do not delete or overwrite them.
- [ ] Obtain explicit authorization naming the new config hash, pricing hash, 12-run matrix, `$5` campaign cap, and bounded retry policy.
- [ ] Run the reviewed CLI's full matrix; do not create a targeted one-off runner:

```bash
C2_NETWORK_AUDIT=.c2-private/c2/remediation/network-audit.json \
npx tsx src/scripts/run-c2-pilot.ts run \
  --config eval/c2/config/pilot-campaign.json \
  --pricing eval/c2/config/pricing.json \
  --paid
```

- [ ] Verify exactly 12 terminal outcomes, 12 audit entries for attempted provider calls, no campaign stop, no run over `$0.50`, and total spend under `$5.00`.
- [ ] Confirm the stablecoin current-grounded Claude run has a complete parsed candidate, valid score, non-null output hash, and completion tokens below the configured ceiling. If it truncates again, stop and preserve the failure; do not increase the ceiling or retry indefinitely.

**Acceptance:** The stablecoin Claude run succeeds under the reviewed configuration, all evidence is immutable and hash-bound, and the old partial campaign remains preserved as historical evidence.

### Task A3: Re-score and re-freeze the pilot calibration

**Files:**
- Create: `eval/c2/scorecards/blinded-packets/` and private blind map
- Create: `eval/c2/scorecards/` finalized scorecards
- Modify: `eval/c2/calibration/proposal.json`
- Modify: `eval/c2/calibration/frozen.json`
- Create privately: `.c2-private/c2/freeze-authorization.json`
- Test: `src/c2/calibration.e2e.test.ts`

- [ ] Generate fresh blinded packets from the new run directories; do not reuse scorecards bound to old output hashes.
- [ ] Have the Gold Label Owner score every successful packet, then finalize through `scripts/finalize-blind-scorecards.mts`; verify each scorecard binds the new run/output hash.
- [ ] Run proposal and freeze using the actual run and scorecard directories:

```bash
npx tsx src/scripts/run-c2-pilot.ts propose --runs eval/c2/runs
npx tsx src/scripts/run-c2-pilot.ts freeze \
  --proposal eval/c2/calibration/proposal.json \
  --authorization .c2-private/c2/freeze-authorization.json \
  --runs eval/c2/runs
npx tsx src/scripts/run-c2-pilot.ts validate --calibration eval/c2/calibration/frozen.json
```

- [ ] The human authorization must explicitly state whether all three Claude families are measured. `criticalDecisionCoverageComplete` may become `true` only if the new product run and the existing migration/safety evidence satisfy the human checklist.
- [ ] Re-freeze twice with identical proposal, evidence, authorization, and timestamp; compare bytes and SHA-256 exactly.

**Acceptance:** The new frozen artifact binds the remediation config, pricing, all actual run manifests, all scorecards, and a human-authored compatibility checklist. If coverage is still incomplete, the frozen artifact must remain partial and C9 remains blocked.

### Task A4: Rebind the Pass 3 manifest to the new frozen calibration

**Files:**
- Modify: `eval/c2/baseline/manifest.json`
- Modify: `src/scripts/build-baseline-manifest.mjs` only if its generator cannot accept the new calibration ref
- Test: `src/c2/baseline-manifest.test.ts`

- [ ] Replace `frozenCalibrationRef.sha256` with the actual SHA-256 of the newly frozen calibration file and preserve the canonical calibration artifact path.
- [ ] Recompute the baseline manifest self-hash with the existing generator; do not edit the self-hash manually.
- [ ] Run the generator and validator twice, then compare the manifest bytes:

```bash
npm run generate:c2-baseline
npm run validate:c2-baseline
npm run validate:c2-baseline
```

- [ ] Verify every case-package ref remains unchanged and only the intended calibration binding/self-hash changed.

**Acceptance:** The 25-case manifest and the new frozen calibration bind each other by exact file hash, while the manifest remains 25 cases with 15/5/5 family counts.

## Workstream B: Label-Integrity Human Gate

### Task B1: Obtain baseline metrics and external QA

**Files:**
- Create: `eval/c2/label-integrity/baseline-metrics.json`
- Test: `src/c2/label-agreement.test.ts`

- [ ] Obtain the parent-authority values and source refs for the four baseline-bound metrics: `pattern-type-exact-accuracy`, `categories-macro-f1`, `components-recall`, and `domain-tags-recall`.
- [ ] Validate the artifact schema, source hashes, canonical ordering, and SHA-256; reject missing, stale, or locally invented values.
- [ ] Register an external QA actor with a distinct actor ID from the Gold Label Owner and role exactly `QA`.

**Acceptance:** The baseline metrics are auditable and the two labeler identities are distinct before either submission is accepted.

### Task B2: Collect, validate, and adjudicate independent labels

**Files:**
- Create privately: `.c2-private/c2/labeling/gold-submission.json`
- Create privately: `.c2-private/c2/labeling/qa-submission.json`
- Create: `eval/c2/label-integrity/agreement-report.json`
- Create: `eval/c2/label-integrity/adjudication.json` only if disagreements exist

- [ ] Deliver the same frozen `eval/c2/label-integrity/selection.json` to both labelers without sharing answers.
- [ ] Collect exactly 40 labels per submission and validate selection hash, entry IDs, canonical order, actor identity, role, and sealed timestamp using `src/scripts/collect-label-submissions.mts`.
- [ ] Compute all eight metrics with `computeLabelAgreement`; require every hard gate and every baseline-bound comparison to pass.
- [ ] If labels disagree, preserve both independent submissions, record disagreements, then create a separately bound adjudication artifact. Never rewrite either independent submission.

**Acceptance:** Workstream B's label portion is `Qualified` only with two valid independent submissions, a complete agreement report, and any required adjudication recorded separately.

## Workstream C: Complete and Prove the 25-Case Baseline Runner

### Task C0: Author and bind migration source snapshots

**Files:**
- Create: `eval/c2/baseline/source-snapshots/migration-content-product.json`
- Create: `eval/c2/baseline/source-snapshots/migration-documentation-site.json`
- Create: `eval/c2/baseline/source-snapshots/migration-regulated-service.json`
- Create: `eval/c2/baseline/source-snapshots/migration-saas-dashboard.json`
- Modify: `eval/c2/baseline/manifest.json`
- Test: `src/c2/baseline-manifest.test.ts`

- [ ] Obtain the four approved migration source snapshots from the parent-authorized source records. These files must use the repository's existing source-snapshot schema, include provenance/source IDs and content hashes, and contain only approved non-private content; “author” means author the descriptor from an approved source, never invent source content.
- [ ] Record the authorizing actor and source artifact refs in the private evidence ledger before changing any tracked manifest bytes.
- [ ] Validate each snapshot through the existing source-snapshot schema and boundary scanner, compute its exact SHA-256, and replace only the corresponding all-zero staged hash in the manifest.
- [ ] Regenerate the manifest self-hash and run `npm run validate:c2-baseline` twice.
- [ ] If an approved snapshot cannot be obtained, mark the case as an explicit external blocker and do not proceed to paid preparation; do not delete the case or silently downgrade the matrix.

**Acceptance:** All four migration snapshot refs exist, are content-addressed, boundary-clean, and resolve during offline preparation.

### Task C1: Implement baseline condition preparation

**Files:**
- Modify: `src/scripts/run-c2-baseline.ts:392-449`
- Test: `src/scripts/run-c2-baseline.test.ts`

- [ ] Load every case package from `eval/c2/baseline/manifest.json` and verify each brief, label, evidence descriptor, and optional migration snapshot hash before resolving inputs.
- [ ] Reuse `resolveConditionInput` from `src/c2/condition-resolver.ts` for all 25 × 3 conditions; write only private condition-input descriptors and private evidence payloads.
- [ ] Normalize every durable `conditionInputRef.path` to the logical `eval/c2/...` path while keeping the descriptor itself private.
- [ ] Add tests for all 75 primary inputs, migration snapshot failures, stale artifact refs, deterministic repeated preparation, and zero egress.
- [ ] Run:

```bash
npm test -- --run src/scripts/run-c2-baseline.test.ts src/c2/condition-resolver.test.ts
npx tsx src/scripts/run-c2-baseline.ts prepare \
  --manifest eval/c2/baseline/manifest.json \
  --calibration eval/c2/calibration/frozen.json
```

**Acceptance:** Preparation resolves all declared inputs or fails with a specific artifact error; it never makes a provider call and never mutates the corpus.

### Task C2: Implement the baseline paid execution matrix

**Files:**
- Modify: `src/scripts/run-c2-baseline.ts:451-544`
- Modify: `src/c2/harness.ts` only if a reusable exported helper is required
- Test: `src/scripts/run-c2-baseline.test.ts`

- [ ] Load the frozen calibration and enforce its file hash before any provider call.
- [ ] Resolve the frozen calibration's `campaignConfigRef` and `pricingTableRef` to tracked files and verify both file hashes before any provider call. Read only the pinned lane/model, sampling, API-key environment names, pricing, and cost ceilings from those files; do not use their pilot `cases`, `conditions`, or `plannedRunCount` for the baseline matrix.
- [ ] Build each `ExecuteC2RunRequest` from the manifest's case package, prepared condition input, the frozen config's exact provider/model lane, fresh pricing entry, and frozen cost ceilings. Take the 75-primary + 5-independent matrix exclusively from `C2BaselineManifest.executionMatrix`.
- [ ] Reuse `executeC2Run`; do not duplicate prompt building, provider calls, scoring, cost accounting, audit logging, or immutable writes.
- [ ] Use the manifest's exact independent IDs: `stablecoin-home`, `finance-news-story-detail`, `public-marketing-migration`, `safety-conflicting-evidence`, and `named-inspiration-safety`.
- [ ] Add tests proving 75 primary + 5 independent planned runs, namespaced IDs, predecessor binding on retries, campaign-stop behavior, zero egress without `--paid`, and no writes outside the baseline/private roots.
- [ ] Run the dry-run preflight and require an explicit human authorization record before `--paid`.

**Acceptance:** The runner executes exactly the manifest-pinned 80-run matrix, records every terminal result, and exits non-zero on campaign stop, stale calibration, or budget failure.

### Task C3: Make baseline scorecard generation canonical

**Files:**
- Modify: `src/scripts/run-c2-baseline.ts:546-581`
- Modify or reuse: `scripts/create-blinded-review-packets.mts`
- Test: `src/scripts/run-c2-baseline.test.ts`, `src/c2/review-packets.test.ts`

- [ ] Replace the scorecards stub with a baseline-aware invocation of the existing blinded packet generator.
- [ ] Ensure packets contain only `reviewId` and candidate data; keep provider, model, condition, family, and case mapping private.
- [ ] Require one scorecard per successful scored run and preserve terminal failures in provenance without fabricating scorecards.
- [ ] Test packet count, metadata absence, map hash binding, duplicate finalization rejection, and output-hash drift rejection.

**Acceptance:** The baseline produces reviewable blinded packets without exposing lane or case metadata and finalization remains atomic and fail-closed.

### Task C4: Add the post-baseline compatibility contract

**Files:**
- Create: `src/c2/baseline-compatibility.ts`
- Test: `src/c2/baseline-compatibility.test.ts`
- Create: `eval/c2/baseline/compatibility-evaluation.template.json`

**Interface:**

```ts
export interface C2BaselineCompatibilityEvaluation {
  schemaVersion: "1.0";
  artifactType: "c2-baseline-compatibility-evaluation";
  artifactId: string;
  independentRunRefs: ReadonlyArray<ArtifactFileRef>; // exactly five manifest refs
  checklist: IndependentCompatibility; // must not carry cliSynthesized
  reviewerActorId: string;
  rationale: string;
  evaluatedAt: string;
}

export function validateBaselineCompatibility(
  input: unknown,
  expectedIndependentRunRefs: ReadonlyArray<ArtifactFileRef>,
): C2BaselineCompatibilityEvaluation;
```

- [ ] Require exactly the five manifest-pinned independent run IDs and output hashes from `C2BaselineManifest.executionMatrix.independentCaseIds`.
- [ ] Require all six checklist booleans, a distinct human reviewer ID, a non-empty rationale, and an ISO-8601 timestamp.
- [ ] Reject `cliSynthesized`, missing product/migration/safety coverage, duplicate run refs, stale output hashes, and provider/model mismatches.
- [ ] Test valid human evidence, missing product coverage, tampered hash, synthesized checklist, duplicate refs, and reordered refs.

**Acceptance:** The compatibility artifact is the only accepted post-baseline compatibility input; no score completeness or CLI synthesis can create it.

## Workstream D: Execute, Score, and Evaluate Pass 3

### Task D1: Authorize and execute the 80-run campaign

**Files:**
- Create only after authorization: `eval/c2/baseline/runs/`
- Create privately: `.c2-private/c2/baseline/`
- Create: `.c2-private/c2/baseline/paid-authorization.json`

- [ ] Verify Task A4's re-bound calibration/manifest pair and Task B2's label-gate prerequisites before spending budget.
- [ ] Verify Task C0's four migration snapshots and the baseline manifest self-hash before spending budget.
- [ ] Run the offline preflight and record planned count, independent IDs, frozen calibration hash, forecast, per-run ceiling, campaign cap, and pricing freshness.
- [ ] Obtain explicit authorization for 80 paid runs and the declared bounded retry policy.
- [ ] Run the baseline CLI with `--paid`, preserving every terminal manifest and audit record.
- [ ] Stop immediately on stale refs, calibration drift, a budget stop, or an unexpected matrix shape.

**Acceptance:** The campaign has a complete, hash-bound terminal outcome for every attempted matrix slot and remains within the frozen budget.

### Task D2: Human scorecards and compatibility evaluation

**Files:**
- Create: `eval/c2/baseline/scorecards/`
- Create: `eval/c2/baseline/compatibility-evaluation.json`
- Create privately: `eval/c2/baseline/blind-map/`

- [ ] Generate blinded packets and have the Gold Label Owner score all required successful candidates against the six rubric dimensions.
- [ ] Finalize scorecards through the canonical blind-map transition; bind every scorecard to its run and raw output hash.
- [ ] Author the six-boolean OpenAI-vs-Claude compatibility checklist for the five independent runs. Include a rationale and exact run/output refs; never set `cliSynthesized`.
- [ ] Mark compatibility incomplete if any independent run is unavailable or incompatible; do not infer coverage from score completeness.

**Acceptance:** All human evidence is independently authored, schema-valid, hash-bound, and reproducible from the private map and durable artifacts.

### Task D3: Run closure evaluation and decide C2 status

**Files:**
- Modify: `src/c2/closure-evaluator.ts` only for proven decision-quality gaps found by tests
- Test: `src/c2/closure-evaluator.test.ts`
- Create: `src/c2/pass3-closure-gate.ts`
- Test: `src/c2/pass3-closure-gate.test.ts`
- Create: `eval/c2/baseline/closure-report.json`
- Create: `eval/c2/calibration/proposal.json`
- Modify: `eval/c2/calibration/frozen.json` only after human authorization

- **Interfaces:**

```ts
export interface Pass3ClosureGateInput {
  decisionQuality: C2ClosureReport;
  labelIntegrity: C2LabelAgreementReport;
  compatibility: C2BaselineCompatibilityEvaluation;
  frozenCalibration: C2FrozenCalibration;
}

export interface Pass3ClosureGateReport {
  overallPassed: boolean;
  labelIntegrityPassed: boolean;
  decisionQualityPassed: boolean;
  criticalDecisionCoverageComplete: boolean;
  failures: ReadonlyArray<{
    gate: "label-integrity" | "decision-quality" | "compatibility";
    reason: string;
  }>;
}

export function evaluatePass3Closure(input: Pass3ClosureGateInput): Pass3ClosureGateReport;
```

- [ ] Run `evaluateC2Closure` over the baseline manifest, frozen calibration, 80-run evidence, and scorecards.
- [ ] Keep `evaluateC2Closure` responsible for the nine decision-quality checks only: current-grounded quality, score floor, product dimensions, product count, migration count, safety count, overall result, material benefit/non-inferiority, and compatibility evidence as defined by the frozen calibration.
- [ ] Implement `evaluatePass3Closure` as the separate final reducer that combines the decision-quality report, independent label-agreement report, and human-authored five-run compatibility artifact. It must not infer label or compatibility success from score completeness.
- [ ] Confirm duplicate runs, hash drift, missing family coverage, partial compatibility, and rounding-boundary cases fail closed.
- [ ] Resolve every `baselineMetricsRef` in the label-agreement report and verify its file hash and four required metric IDs before accepting `labelIntegrityPassed`; a schema-valid but stale or missing baseline-metrics artifact must fail closed.
- [ ] First run a diagnostic closure pass that evaluates C1-C8 and records C9 as blocked when the current frozen checklist is partial; this pass must not claim closure or trigger a freeze.
- [ ] Validate the human-authored compatibility artifact, then build a post-baseline proposal from actual evidence and obtain a new human freeze authorization with the new six-boolean checklist.
- [ ] Freeze the post-baseline calibration deterministically, update `eval/c2/baseline/manifest.json` to bind the new frozen file hash, and rerun manifest validation.
- [ ] Rerun the complete C1-C9 closure evaluation against the post-baseline frozen calibration. Invoke `evaluatePass3Closure` only after this second pass.
- [ ] If any gate fails, write the failure reason and preserve C2 as open; do not relax thresholds or alter the frozen pilot artifact.

**Acceptance:** C2 closes only when label integrity is `Qualified`, decision quality is `Passed`, and `criticalDecisionCoverageComplete === true`. Otherwise the report is an explicit blocked result.

## Commit and Review Sequence

1. `chore(c2): lock Claude remediation configuration and pricing` — Task A1.
2. `data(c2): bind approved migration source snapshots` — Task C0.
3. `feat(c2): complete baseline condition preparation` — Task C1.
4. `feat(c2): complete baseline execution and scorecard wiring` — Tasks C2–C4.
5. `evidence(c2): record Claude remediation campaign and pilot re-freeze` — Tasks A2–A4, only after paid authorization.
6. `evidence(c2): record independent label agreement` — Tasks B1–B2, only after both human submissions.
7. `evidence(c2): record authorized 25-case baseline` — Tasks D1–D2, only after paid authorization and human scoring.
8. `feat(c2): evaluate and freeze Pass 3 closure` — Task D3, only if all gates pass.
9. A separate post-C2 plan/PR for C3 product capabilities.

Every commit receives a task review; the branch receives a holistic review before push. Evidence commits must never contain secrets, private raw responses, blind maps, or unapproved human submissions.

## Verification Checklist

- [ ] `npm test -- --run --exclude src/scripts/dom-motion-capture.test.ts` passes with zero paid calls.
- [ ] `npm run build` passes.
- [ ] Claude remediation tests prove the configured ceiling reaches the provider request body.
- [ ] Pilot re-freeze is byte-identical and binds the actual remediation evidence.
- [ ] Label agreement rejects same-actor, mismatched-selection, stale-baseline, duplicate-ID, and reordered submissions.
- [ ] Baseline preparation resolves 75 primary inputs deterministically and privately.
- [ ] Baseline preflight reports exactly 80 planned runs and the five independent IDs.
- [ ] Paid execution records every terminal outcome, cost, telemetry, and audit line.
- [ ] Blinded packets contain no provider, model, family, case, or condition metadata.
- [ ] Closure report covers C1–C9 and exits non-zero when any gate fails.
- [ ] A partial Claude result is never promoted to complete compatibility.
- [ ] No corpus mutation, retagging, Pass 4 work, or premature C2 closure occurs.
