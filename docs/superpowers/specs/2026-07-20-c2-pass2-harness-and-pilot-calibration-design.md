# C2 Pass 2 Harness and Pilot Calibration Design

**Status:** Approved design

**Date:** 2026-07-20

**Scope:** C2 evaluation-only harness, three-case pilot execution, and frozen calibration protocol

**Depends on:** C2 Pass 1 contracts and pilot packages on `main`; C0 and C1 remaining closed

## 1. Goal and boundary

Pass 2 builds the evaluation-only machinery needed to run the three Pass 1 pilot cases under controlled conditions, preserve immutable run evidence, score candidates deterministically and through blinded human review, and freeze the calibration required before the 25-case C2 baseline begins.

Pass 2 does not close C2. It does not authorize retagging, mutate the corpus, implement the hosted generator, convert Playground into the creation workspace, integrate Decision Lab with `UiSpec` revisions, or ship any C3 product capability.

The primary provider is OpenAI. The independent provider is Claude. Live execution uses a maximum forecast of **$0.50 per run** and **$5.00 per campaign**.

## 2. Architectural decision

Pass 2 uses a TypeScript-first evaluation system next to the existing C2 contracts. It does not fork the image-oriented `scripts/eval-runner.mjs`, adapt C2 labels into the incompatible v1 scorer shape, or refactor every existing evaluation runner into a generic framework.

The system has three layers:

1. A thin campaign CLI coordinates reviewed configurations and explicit paid execution.
2. A C2 run engine resolves condition inputs, invokes one pinned model call, preserves immutable artifacts, and applies deterministic scoring.
3. A calibration reducer compares runs and produces a reviewable proposal that an explicit human action may promote to a frozen calibration artifact.

The core modules live under `src/c2/` so they can consume the strict Zod contracts directly. The CLI lives under `src/scripts/`. Pure evaluation logic remains independently testable and contains no implicit network access.

## 3. Module boundaries

The implementation introduces these focused units:

- `src/c2/candidate-contracts.ts`: strict candidate design artifact and deterministic score contracts.
- `src/c2/condition-contracts.ts`: condition-input, evidence-record, campaign-configuration, calibration-proposal, and frozen-calibration contracts.
- `src/c2/prompt-builder.ts`: pure prompt assembly from a model-visible brief and resolved condition input.
- `src/c2/scorer.ts`: pure C2-native deterministic scoring against the candidate, brief, reviewer-only label, and condition input.
- `src/c2/cost-policy.ts`: pricing-table validation, token-to-cost calculation, conservative forecasting, and run/campaign budget decisions.
- `src/c2/condition-resolver.ts`: resolves brief-only, current-grounded, and gold-evidence inputs and binds their exact bytes.
- `src/c2/harness.ts`: immutable single-run state machine with injected model, clock, ID, and filesystem dependencies; it consumes a resolved condition input and does not perform retrieval.
- `src/c2/calibration.ts`: pure comparison reducer and explicit freeze validation.
- `src/scripts/run-c2-pilot.ts`: thin CLI for offline preparation, paid execution, proposal generation, and approved freezing.

`src/tagger.ts` gains an additive metadata-returning text-call API. The existing `callTextModel(): Promise<string>` signature and behavior remain intact as a compatibility wrapper.

The resolver and harness have an explicit seam. `condition-resolver.ts` owns standalone, deterministic materialization of a condition input through an injected corpus reader and filesystem boundary; it performs no provider call and can be run during offline campaign preparation. `harness.ts` consumes an already resolved condition input and owns paid-call authorization, network execution, immutable run state, parsing, and scoring.

## 4. Candidate artifact

Pass 2 defines a strict C2 candidate artifact rather than scoring undocumented JSON or claiming that an evaluation artifact is a production `UiSpec`.

The candidate records:

- A global design direction.
- One blueprint for every required screen.
- Required states and mobile rules per blueprint.
- Structured decisions keyed by the label's `requiredDecisionIds`.
- Acceptance criteria keyed by the label's required acceptance-criterion IDs.
- Assumptions.
- Authority lane, rationale, and evidence references for every evidence-derived decision.
- Accessibility behavior and failure/recovery behavior.
- Provenance binding the exact condition-input hash.

The parser is strict. Missing required structure, unknown fields, malformed identifiers, duplicate IDs, invalid authority lanes, or a mismatched provenance hash fail validation. A parser or validation failure cannot produce a successful deterministic score.

## 5. Condition-input artifacts

Pass 1 labels name valid and gold evidence IDs but do not bind those IDs to actual model-visible evidence payloads. Pass 2 therefore creates a condition-input artifact for every case and condition before any paid call.

Each condition input records:

- The case-package artifact and hash.
- The control condition.
- The model-visible brief artifact and hash.
- Ordered evidence records with stable ID, authority lane, source type, model-visible content, and source hash.
- Corpus and retrieval-index hashes when retrieval is involved.
- Retrieval query, configuration, complete ranked result, and selected result for current-grounded runs.
- Source-snapshot references and hashes for migration cases.
- A canonical `inputSha256` over all model-visible inputs and their ordering.

### 5.1 Brief-only

The model receives the brief only. Evidence IDs are empty and corpus and retrieval-index hashes are null. Constraints in the brief remain visible because they are user requirements, not reviewer-only gold information.

### 5.2 Current-grounded

The repository already has a structured text fallback: `retrieveCritiqueEvidence()` builds a text query and delegates to `CorpusReader.searchRanked()` when image retrieval is unavailable. Pass 2 reuses that existing `CorpusReader.searchRanked()` capability through a C2-specific adapter; it does not build a new text-search engine, use image embeddings for text-only pilot briefs, seed a separate pilot corpus, or treat Pass 1's synthetic evidence IDs as corpus pointers.

The adapter derives a deterministic query only from the model-visible brief and runs it against a content-addressed snapshot of the production corpus and its text-search configuration. Every selected result becomes a condition evidence record with a stable `corpus:<entry-id>` ID, rank, score, model-visible content, and exact content hash. Brief-derived evidence remains separately identified with `brief:<id>` records. The condition input preserves the complete ranked result and supplies only the selected model-visible evidence to the model.

Gold evidence IDs, rubric anchors, expected decisions, acceptance criteria, prohibitions, and adjudication notes cannot influence the query, ranking, selection, or prompt. The deterministic scorer validates citations against the resolved condition-input evidence universe rather than pretending `C2DecisionLabel.validEvidenceIds` contains retrievable corpus addresses. Weak, irrelevant, or empty production retrieval remains valid pilot evidence of a retrieval or coverage gap; the resolver must not hide it by injecting hand-curated current-grounded results.

### 5.3 Gold-evidence

The resolver uses a separately reviewed evidence packet that binds each selected ID to exact content and provenance. The label identifies which IDs are gold, but the runner resolves model-visible bytes only through the evidence packet. Missing, duplicated, unresolvable, or hash-mismatched evidence fails before a provider call.

Prompt construction accepts only a model-visible brief and a resolved condition input. It does not accept a full case package or reviewer-only label, reducing the chance of gold leakage by construction.

## 6. Run lifecycle and immutability

A run follows this sequence:

1. Validate case-package and referenced artifact hashes.
2. Resolve and freeze the condition input.
3. Validate exact provider, exact model, pricing table, credentials, and paid authorization.
4. Conservatively forecast the call cost and apply both budgets.
5. Atomically write a new running manifest.
6. Make exactly one logical pinned provider call, allowing only bounded transport-level retry attempts.
7. Store the raw provider response inside the private evaluation boundary.
8. Parse and strictly validate the candidate artifact.
9. Finalize the run manifest with output hashes, telemetry, cost, and terminal status.
10. Load the reviewer-only label after generation and write a linked deterministic score artifact.

Runs are immutable. Provider retry exhaustion, malformed output, validation failure, manual rerun, or corrected-label shadow execution creates a new run ID. When one run follows another attempt for the same case, condition, and configuration, `predecessorRunId` points to the prior run. No command overwrites or ambiguously resumes a prior run.

Pass 1 introduced the initial `C2EvaluationRunManifestSchema` with `schemaVersion: "1.0"`, but it produced no persisted run manifests. Pass 2 preserves that reviewed contract as `C2EvaluationRunManifestV1Schema` and retains `C2EvaluationRunManifestSchema` as a compatibility alias to V1. It adds `C2EvaluationRunManifestV2Schema` for new runs because the governing C2 design requires fields absent from the initial contract, including condition-input and scorer references, explicit attempt count and provider latency, source-snapshot IDs, detailed terminal reasons, and validation errors. Pass 2 writes only V2 manifests; strict tests keep both schemas readable and prevent a V1 artifact from being represented as V2.

## 7. Model execution and telemetry

The additive API has the conceptual form:

```ts
callTextModelWithMetadata(request: TextModelRequest): Promise<ModelCallResult>
```

It returns content, resolved provider, exact model, prompt tokens, completion tokens, attempts, total latency, provider request ID when available, and auditable raw usage fields. Existing `callTextModel()` delegates to it and returns only `result.content`.

OpenAI and Claude adapters must report exact model identity and normalized usage. The C2 path forbids ambient provider fallback, peak-hour routing, renamed endpoints masquerading as independent providers, and silent model substitution. If the provider omits usable final token accounting, the live run fails closed.

Retries are limited to transient transport failures, HTTP 429, and provider 5xx responses. Malformed model output is not repaired or retried inside the same run. Every billable attempt observable through provider telemetry contributes to the run's token and cost totals.

## 8. Cost controls

Live execution requires all of:

- The `--paid` CLI flag.
- A reviewed campaign configuration file.
- Exact provider and model identifiers.
- A versioned, hash-bound pricing table.
- Required credentials present during preflight.
- A maximum forecast of $0.50 per run.
- A maximum total campaign cost of $5.00.

Before each call, the cost policy forecasts prompt cost plus the configured maximum output. If the forecast exceeds the run ceiling or remaining campaign budget, the runner records `cost-blocked` and makes no provider request.

After a call, the policy calculates actual cost from provider-reported usage and the pinned pricing table. Actual cost is recorded even when parsing or validation fails. If actual run cost exceeds $0.50, the run terminates with `run-budget-exceeded` and the campaign stops. The campaign also stops before another request whenever the conservative forecast cannot fit inside the remaining $5.00.

Pricing-table entries identify provider, model, input-token price, output-token price, effective date, verification timestamp, and authoritative source URL. Live execution requires every used entry to have been verified no more than 30 days before the campaign starts. Unknown, duplicate, older, non-finite, or source-less pricing fails closed.

## 9. Deterministic scoring

`scoreC2Candidate(candidate, brief, label, conditionInput)` is pure and condition-aware. It enforces:

- Every required section is structurally non-empty.
- Every brief-required screen, state, and mobile rule is present.
- Every required decision ID is present.
- Every required acceptance criterion is present.
- Every cited evidence ID exists in the run's condition input.
- Every evidence-derived decision uses a label-permitted authority lane and a non-empty rationale.
- No forbidden claim or private marker appears anywhere in the serialized candidate.
- No inspected claim names an inaccessible or uninspected route.
- Candidate provenance exactly matches the condition-input hash.

Brief-only candidates may make brief-grounded decisions without corpus citations. Current-grounded and gold-evidence candidates may cite only evidence supplied in their condition inputs. Gold labels never expand the candidate's evidence universe. Only current-grounded results can become C2 closure candidates.

The v1 design-handoff scorer remains unchanged and continues to score its 12 synthetic `labelVersion: 1` regression fixtures. Pass 2 does not translate C2 v2 labels into v1 fields because doing so would invent or conflate decision, evidence, state, and mobile-rule semantics.

## 10. Human scoring and blinding

Human quality evaluation remains separate from deterministic scoring. Reviewers score the existing six dimensions from 1 to 5:

- Product appropriateness.
- Cross-screen coherence.
- Implementation clarity.
- Originality versus imitation.
- Accessibility and failure-state quality.
- Evidence discipline.

Review packets hide condition names, provider names, model names, and run ordering until the scorecard is submitted. Each scorecard binds the exact run-output hash. Changing or replacing a candidate invalidates its prior scorecard.

The deterministic scorer proves contract completeness and evidence discipline. Human scoring judges design quality. Neither result substitutes for the other.

## 11. Calibration

The calibration reducer computes, without choosing policy:

- Per-dimension current-grounded minus brief-only deltas.
- Six-dimension mean delta.
- Implementation-readiness transitions.
- Deterministic pass/fail transitions.
- Regressed dimensions.
- Safety violations.
- Gold-evidence minus current-grounded headroom.
- Primary-versus-independent compatibility results.
- Observed and forecast cost distributions.

The calibration proposal contains these measurements and the exact pilot artifact hashes. It is not automatically authoritative.

The frozen material-benefit rule must use this predeclared structure:

- Product and migration cases require a positive minimum mean-score improvement over brief-only controls.
- Improvement in one dimension cannot conceal a material regression in another.
- A deterministic failure cannot be offset by human-score improvement.
- Safety cases require non-inferiority plus complete safety compliance rather than a positive score delta.

Pilot review selects and records the numeric minimum and regression tolerance. The frozen artifact records the selected values, rationale, reviewer, and proposal hash. Pass 2 creates and validates this artifact but does not yet consume it as a closure gate. Pass 3's 25-case runner must accept only the reviewed frozen-artifact hash at startup and expose no CLI threshold overrides.

The frozen independent-compatibility checklist requires the OpenAI primary result and Claude independent result to:

- Cover the same required critical decision IDs.
- Avoid mutually contradictory critical decisions.
- Respect the same constraints and prohibited claims.
- Choose compatible journeys and failure/recovery behavior.
- Pass deterministic safety rules independently.

Compatible outputs need not share wording, visual style, or exact layout.

## 12. Failure model

Every attempted or blocked run has one unambiguous terminal outcome. Detailed terminal reasons include:

- `provider-failed`
- `parse-failed`
- `validation-failed`
- `cost-blocked`
- `run-budget-exceeded`
- `campaign-stopped`

These reasons may refine backward-readable high-level states, but cannot turn a failed or blocked run into a successful one. A provider response followed by parsing failure still records tokens and cost. A blocked run records zero attempts, zero tokens, zero cost, and no output hashes.

## 13. Private boundary and artifact portability

Raw responses, parsed candidates, detailed evidence payloads, and full condition inputs remain under a gitignored private run directory. Durable manifests, deterministic scores, calibration proposals, and frozen calibration artifacts may be committed only after a boundary check proves they contain hashes and permitted metadata rather than prompt text, evidence content, raw output, credentials, authorization headers, private corpus paths, or private markers.

Campaign configuration stores environment-variable names, never secret values. Provider error bodies are scrubbed before persistence because upstream systems may echo request material. Logs show identifiers, hashes, statuses, timings, and costs, never prompt or response bodies.

Every artifact write uses a temporary file, writes through the opened descriptor, flushes and closes it, atomically renames it, and removes the temporary file on any failure.

## 14. Implementation slices

### Slice A: contracts and scorer

Introduce the candidate, condition-input, score, run v2, calibration-proposal, and frozen-calibration contracts and implement C2-native deterministic scoring. This slice has no network access.

### Slice B: prompt, telemetry, and cost policy

Implement pure prompt assembly and cost decisions. Add the metadata-returning model API while preserving `callTextModel()` compatibility. Test with fake provider responses, fake clocks, and no paid calls.

### Slice C: condition resolution and immutable runner

Implement condition resolution, retrieval injection, run lifecycle, atomic private writes, boundary validation, and the CLI. Default invocation remains offline.

### Slice D: pilot execution and calibration freeze

After Slices A through C pass review:

1. Generate and inspect all condition inputs offline.
2. Execute all three pilot cases under brief-only, current-grounded, and gold-evidence with the primary provider.
3. Execute all three pilot cases with Claude so the independent run covers the product, migration, and safety families.
4. Produce blinded review packets.
5. Record human scorecards.
6. Generate the calibration proposal.
7. Review material benefit, compatibility, rubric usefulness, and observed cost.
8. Freeze the calibration only after explicit human approval.
9. Regenerate and validate the frozen artifact twice with byte-identical results.

## 15. Verification strategy

Unit and adversarial tests must cover:

- Strict schemas, unknown fields, malformed identifiers, duplicate IDs, and cross-artifact mismatches.
- Screen, state, mobile-rule, decision, acceptance-criterion, lane, citation, provenance, forbidden-claim, and private-marker enforcement.
- Reviewer-only label data never entering prompt construction.
- Gold IDs never influencing current-grounded retrieval.
- Exact provider and model pinning with no fallback.
- OpenAI and Claude token normalization and attempt aggregation.
- Missing usage, unknown pricing, non-finite pricing, missing price provenance, and pricing verified more than 30 days before execution.
- $0.50 run blocking and $5.00 campaign blocking before egress.
- Cost preservation when parsing or validation fails after a paid response.
- Source-snapshot binding for migration cases.
- Atomic-write cleanup, immutable run IDs, predecessor chains, and overwrite rejection.
- Offline-by-default CLI behavior and zero network calls without every paid precondition.
- Secret, private-corpus, prompt, evidence, and response exclusion from durable artifacts and logs.
- A dedicated v1 scorer golden-regression test loads all 12 existing labels, deterministically constructs a satisfiable candidate plus fixed failure mutations for each label, scores them with the unchanged v1 scorer, and compares the complete result matrix to a committed baseline. Any scorer or fixture drift fails with a per-case diff.

Pass 2's completion gate requires:

- Focused C2 tests and adversarial tests pass.
- The full root test suite passes.
- Typecheck and build pass.
- The public/private boundary check passes.
- C0 and C1 remain closed and C2 remains open.
- Default tests and commands make no paid or network calls.
- No private response or corpus payload is committed.
- Every pilot artifact and score is hash-resolvable.
- The frozen calibration regenerates byte-identically.
- No Pass 3 retagging or C3 product capability is introduced.

## 16. Pass 2 completion definition

Pass 2 is complete when the reviewed harness can reproduce the three-condition pilot campaign within its budgets, all pilot inputs and outputs are immutably bound, deterministic and blinded human results are preserved, primary and independent compatibility is evaluated, and an explicitly approved calibration artifact is frozen for the later 25-case baseline.

This outcome establishes an evaluation protocol. It does not close C2 and does not establish that retagging is justified.
