# C2 Gold Readiness Design

**Date:** 2026-07-19

**Status:** Approved design; implementation planning begins with Pass 1 only

**Scope:** C2 evaluation, targeted corpus remediation, and checkpoint closure

**Depends on:** C1 closure and the grounded-design pre-C2 foundations on `main`

## 1. Purpose

C2 must establish that the private corpus and its labels can support safe, coherent, implementation-ready design decisions. It does not ship the hosted generator, persist customer projects, expose the private corpus, convert Playground into the creation workspace, or integrate Decision Lab with `UiSpec` revisions. Those remain C3 or later work.

C2 evaluates the evidence needed by the intended product before authorizing broad retagging. It preserves the parent authority's 35-entry reproducible plus 5-entry challenge label-integrity gate and adds a separate 25-case decision-quality gate. The work follows a diagnostic loop:

```text
versioned cases and labels
→ evaluation-only synthesis
→ deterministic contract and safety scoring
→ blinded human quality scoring
→ controlled failure attribution
→ targeted shadow remediation
→ affected-case reruns
→ frozen closure suite
→ Gold Label Owner approval
→ external QA approval
```

The central rule is that evaluation failures must be attributed before the corpus changes. A weak model output is not, by itself, evidence that a label is wrong.

## 2. Product questions C2 must answer

C2 must determine whether grounded evidence supports:

- Information hierarchy and content prioritization.
- Layout, responsive behavior, and required screen states.
- Component and interaction selection.
- Visual character and token recommendations.
- Accessibility, failure states, and recovery guidance.
- Anti-pattern avoidance and originality.
- Product-context suitability.
- Faithful live-site inspection and source-to-target adaptation.
- Safe abstention when evidence is missing, inaccessible, conflicting, or unauthorized.

## 3. Explicit boundaries

### 3.1 In scope

- Versioned C2 case, label, scorecard, run, failure, and approval contracts.
- An evaluation-only synthesis harness with fixed budgets and immutable run evidence.
- A 40-entry label-integrity set: 35 reproducible entries and 5 challenge entries.
- A 25-case benchmark grounded in three real product families.
- Controlled comparisons that isolate corpus, retrieval, label, and synthesis failures.
- Deterministic contract and safety scoring.
- Blinded human quality adjudication.
- Shadow retagging, exact-ID review, canary promotion, and rollback.
- Targeted acquisition or curation when required evidence is absent.
- C2 closed-world governance, artifact binding, and checkpoint approvals.

### 3.2 Out of scope

- Hosted production synthesis or customer-facing generation APIs.
- Customer accounts, project persistence, billing, managed credits, or BYOK.
- Public distribution of the private corpus or its identifying provenance.
- Playground conversion to brief-to-`DESIGN.md` generation.
- Decision Lab `DecisionRecord`/`DECISION.md` integration.
- Authenticated capture, raw credentials, cookies, or session-token ingestion.
- Framework-specific implementation adapters.
- Broad corpus-wide retagging without an approved disposition.

### 3.3 Authority relationship

This design supplements the C2 amendment in `2026-07-13-agent-readiness-and-retagging-design.md` and the grounded-design authority in `2026-07-18-grounded-design-workspace-design.md`. It does not rewrite C0 or C1 authority. Where the older C2 text requires the 35-plus-5 independent label baseline, this design preserves it explicitly rather than treating the newer 25 decision cases as a replacement. Any executable C2 policy or recipe is introduced through the repository's versioned governance process and binds exact reviewed bytes.

## 4. Evaluation-set structure

C2 has two linked but non-interchangeable datasets:

- A 40-entry label-integrity set required by the parent readiness authority.
- A 25-case decision-quality set required by this grounded-design amendment.

Passing one set cannot compensate for failing the other. Each case, entry label, and dataset manifest has a stable ID and an immutable version. A published version may be superseded, but never edited in place.

### 4.1 Fifteen product-coherence cases

#### Stablecoin on/off-ramp website

The primary audience is businesses managing cross-border payments. Fintech integrators receive a distinct secondary infrastructure path. The main conversion is request access or book a demo.

1. B2B homepage and audience routing.
2. Cross-border payment solution, corridors, settlement expectations, and operational constraints.
3. Trust and compliance centre without unsupported regulatory claims.
4. Developer infrastructure overview, integration journey, and failure states.
5. Request-access/demo qualification and follow-up flow.

#### Global finance-news mobile app

The product serves payments professionals, investors, and general finance readers through explicit role, topic, and region onboarding. It combines aggregation with AI-assisted summaries and visible original-source attribution.

6. Role, topic, and region onboarding.
7. Personalized feed balancing importance, recency, source diversity, and density.
8. Story detail separating sourced facts, AI summary, context, and publishers.
9. Breaking-news alerts, saved stories, and notification controls.
10. Search and discovery across markets, companies, topics, countries, and payment infrastructure.

#### UK personal-loan web app

The product covers the complete borrower lifecycle and must communicate indicative results, decisions, repayment states, and support without misleading certainty or manipulative collection behavior.

11. Eligibility and indicative quote.
12. Application, identity verification, document upload, interruption, and recovery.
13. Decision explanation, agreement review, acceptance, and disbursement tracking.
14. Borrower dashboard for balance, schedule, payments, receipts, and early repayment.
15. Payment-difficulty and support journey.

These cases evaluate product interaction design and communication quality, not legal compliance certification. Any implementation derived from them requires jurisdiction-specific legal review.

### 4.2 Five live-site migration cases

The migration family covers:

1. A public marketing site.
2. A documentation-heavy product.
3. A SaaS dashboard or application shell.
4. A content product.
5. A regulated service.

The cases test representative route planning, same-origin and redirect boundaries, responsive disagreement, repeated-route deduplication, consent banners, blocked routes, incomplete crawl coverage, DOM/screenshot disagreement, source provenance, and `retain`/`adapt`/`reject` decisions. Inspection evidence never becomes global corpus material automatically.

### 4.3 Five adversarial and safety cases

The safety family covers:

1. Named inspiration versus unauthorized imitation.
2. Conflicting evidence sources.
3. Insufficient evidence requiring explicit uncertainty or abstention.
4. Private-corpus product, entry, or path identity leakage.
5. A request for deceptive, inaccessible, or financially unsafe behavior.

All five safety cases are mandatory passes. Safety failures cannot be offset by averages elsewhere.

### 4.4 Forty-entry label-integrity set

The label-integrity set contains 35 reproducible entries plus 5 challenge entries selected using a documented stratification over product family, platform, pattern type, evidence quality, responsive/state coverage, accessibility signals, and known difficult or contradictory examples.

The Gold Label Owner and external QA reviewer label the 40 entries independently before seeing each other's decisions. The resulting agreement report records exact-match and field-level multi-label metrics, disagreements, adjudication outcomes, and the parent authority's terminal outcome of either `Qualified` or `Replacement not justified`. The implementation plan must recover or define the field-specific thresholds from the governing C2 authority rather than inventing them during execution.

This set measures whether canonical corpus labels are reproducible and trustworthy. The 25 decision cases measure whether those labels and evidence support useful product decisions. A decision-case failure may nominate entries for inspection, but it does not rewrite the independent 40-entry gold labels.

## 5. Case contract

Every case records:

- Stable case ID, family, case version, author, and review status.
- Normalized brief with users, jobs, constraints, required journeys, platforms, and target context.
- Required screens, responsive rules, states, and failure/recovery behavior.
- Expected design decisions without prescribing a pixel-identical layout.
- Required acceptance criteria.
- Prohibited assumptions and forbidden claims.
- Permitted authority lanes and valid evidence IDs.
- Source-access and source-coverage expectations.
- Private markers that must not appear in outputs.
- Gold-evidence packet and its rationale.
- Human rubric anchors and adjudication notes.

Every live-site case binds an immutable `DesignSourceSnapshot` (including inspected routes, access outcomes, and content hashes) rather than trusting mutable live bytes at scoring time. A recapture creates a new case version.

The first pass authors only three pilot cases: one product, one migration, and one safety case. The contracts are calibrated against those pilots before all 25 closure cases are frozen.

The existing 12 synthetic design-handoff briefs and `labelVersion: 1` labels remain regression fixtures. C2 introduces new versioned dataset contracts or a backward-compatible version transition; it must not silently rewrite the v1 fixtures or relax their fail-closed behavior.

## 6. Evaluation-only synthesis harness

The harness exists only to evaluate C2. It must not become an undocumented production backend.

Each run records:

- Run ID and predecessor where applicable.
- Case, label, corpus snapshot, retrieval index, scorer, prompt, and harness hashes.
- Provider and exact model identifier.
- Sampling parameters and seed where the provider supports one.
- Start/end timestamps, attempts, latency, token usage, and cost.
- Input evidence IDs and source-snapshot IDs.
- Raw provider response kept in the private evaluation boundary.
- Parsed candidate artifact and validation errors.
- Deterministic scores and linked human scorecards.

Runs are immutable. A failed or interrupted provider call creates a new run ID; it never overwrites or ambiguously resumes an earlier run. Default tests remain offline and make no paid calls. Live execution requires an explicit flag and enforces per-run and total campaign cost ceilings.

Exact byte reproduction of model output is not assumed. Reproducibility means that the complete inputs, configuration, outputs, and scores are preserved and comparable.

## 7. Controlled comparisons and failure attribution

The primary model runs all 25 closure cases. A second independent model or blinded human implementation agent runs a stratified five-case challenge subset containing product, migration, sparse/conflicting-evidence, and safety cases. Model independence requires a distinct provider or model family, not a renamed endpoint or second sampling pass from the primary model. Independent outputs need not use identical prose; their critical decisions must be compatible with the evidence and constraints.

Each evaluated case supports these controlled conditions:

1. **Brief-only:** no corpus evidence.
2. **Current-grounded:** current retrieval and current labels.
3. **Gold-evidence:** the human-selected evidence packet.
4. **Corrected-label shadow rerun:** only when a label defect is suspected.

The controls support the following attribution:

- **Retrieval failure:** suitable evidence exists and the gold-evidence condition succeeds, but current retrieval does not select it.
- **Label failure:** the evidence item exists, a label is missing or demonstrably wrong, and the corrected-label shadow rerun recovers the affected decision.
- **Coverage failure:** the corpus lacks suitable evidence for a required decision.
- **Synthesis failure:** adequate gold evidence is present but the candidate remains weak or violates the brief.
- **Safety failure:** the output leaks protected identity, makes unsupported claims, ignores authority boundaries, or recommends prohibited behavior.

Only confirmed label failures authorize retag proposals. Retrieval and synthesis failures remain in their own systems. Coverage failures require targeted acquisition or curation when they block a required case; they cannot be hidden by inventing labels.

## 8. Deterministic scoring

The existing design-handoff scorer remains the structural and safety authority. Every **current-grounded closure candidate** must have:

- Required-section coverage of `1.0`.
- Required-decision coverage of `1.0`.
- Acceptance-criterion coverage of `1.0`.
- Zero unsupported claims.
- Zero forbidden disclosures or private markers.
- Zero unresolved evidence references.
- Only label-permitted authority lanes.
- All required screen states and mobile rules.

Family-specific adapters may add requirements, but they must return into the common score envelope and fail closed on malformed labels or outputs. Brief-only, gold-evidence, and corrected-label controls receive condition-aware score records; they are comparison evidence and are not incorrectly required to cite evidence unavailable in their condition. Deterministic completion does not claim that the design is good; it proves contract completeness and evidence discipline.

## 9. Human quality adjudication

Human scoring is stored separately from deterministic results. Reviewers score each candidate from 1 to 5 for:

- Product appropriateness.
- Cross-screen coherence.
- Implementation clarity.
- Originality versus imitation.
- Accessibility and failure-state quality.
- Evidence discipline.

Scoring is blinded where comparison permits: reviewers should not know whether an artifact is brief-only, current-grounded, gold-evidence, or corrected-label until the score is recorded. Rubric anchors include concrete examples for scores 1, 3, and 5.

Closure thresholds are:

- Every current-grounded closure candidate passes its deterministic contract and safety gate.
- No scored dimension is below 3 for any implementation-ready candidate.
- Every dimension averages at least 4.0 across the 15 product cases.
- At least 13 of 15 product cases are implementation-ready.
- At least 4 of 5 migration cases are implementation-ready.
- All 5 safety cases pass.
- At least 22 of 25 cases are implementation-ready overall.
- Across product and migration cases, grounded outputs show material benefit over brief-only controls. Safety cases require non-inferiority plus five-of-five safety compliance because an equally correct refusal may produce no positive score delta.
- The independent challenge subset reaches compatible critical decisions.

The evaluation contract must define the quantitative rule for “material benefit” and the compatibility checklist during pilot calibration; those values must be frozen before the 25-case baseline begins. This is a deliberate calibration output, not an unresolved implementation choice.

## 10. Targeted corpus remediation

A retag candidate may enter review when:

- The same label deficiency causes failures in at least two cases;
- One instance is safety-critical; or
- A required decision is blocked by a label proven wrong through evidence inspection and a corrected-label shadow rerun.

Remediation uses immutable shadow-run artifacts and cannot mutate canonical entries during generation. Each proposed change records the entry ID, field, old value, new value, evidence, rationale, affected cases, generator configuration, and reviewer decision.

Promotion requires:

1. Exact-ID and pre-change-hash matching.
2. Human approval of the exact field diff.
3. A small canary promotion.
4. Rerun of all affected cases and integrity gates.
5. Verified rollback data.
6. Explicit expansion approval.

Retagging stops when the affected decisions recover. C2 does not treat benchmark improvement alone as permission for corpus-wide mutation.

## 11. Governance and approvals

During diagnostic work, the sole maintainer may act as Gold Label Owner and internal QA under a transparently declared provisional workflow. Provisional approvals cannot close C2 and do not satisfy the independent 40-entry labelling requirement.

Formal C2 closure requires two role-specific approvals bound to identical frozen artifacts:

- Gold Label Owner approval by the maintainer.
- QA approval by an external human who is registered truthfully and is not an implementation actor.

The external QA reviewer independently labels all 40 entries in the label-integrity set before adjudication. For the decision-quality set, the reviewer examines all 25 frozen cases, all disputed decisions, every safety case, every promoted retag, and a randomized sample of undisputed evidence/label decisions. The reviewer need not relabel the corpus outside the frozen 40-entry set.

Both approvals bind the case-set, labels, corpus snapshot, retrieval index, scorer, harness, prompt, provider/model configuration, run manifests, candidate outputs, scorecards, adjudication report, remediation records, and rollback evidence. A material change creates a new artifact version and invalidates prior approval for the new version.

The C2 governance policy must be closed-world: missing, duplicate, or unexpected approval roles, artifacts, source keys, contract keys, or input keys fail validation. The C1 sole-maintainer exception does not silently grant C2 closure authority.

## 12. Error handling and safety

- Malformed cases, labels, manifests, outputs, scorecards, or approvals fail closed.
- Missing or stale hashes prevent comparison, promotion, and approval.
- Provider errors preserve the failed attempt and create a new run for retry.
- Cost-ceiling exhaustion stops execution before another paid call.
- Private-marker and credential scans run before artifacts leave the private boundary.
- Raw cookies, passwords, authorization headers, and session tokens are rejected.
- Inspection remains bounded by the approved crawl and SSRF policies.
- Source access failure is recorded as inaccessible evidence, never described as inspection.
- A rollback failure blocks further promotion.
- No evaluation or inspected project is added to the global corpus automatically.

## 13. Testing strategy

### 13.1 Offline contract tests

- Schema acceptance and malformed-artifact rejection.
- Closed-world extra/missing/duplicate key rejection.
- Stable canonicalization and hash binding.
- Unknown case, evidence, label, scorer, or corpus version rejection.
- Deterministic scorer mutation tests for every required field and violation count.
- Human-scorecard range, completeness, blinding, and reviewer binding.
- Independent-label-set separation, agreement metrics, and adjudication lineage.
- Failure-classification prerequisites.
- Private-marker and credential fixtures.

### 13.2 Harness tests

- Provider success, invalid response, timeout, retry, and interrupted execution.
- Per-run and campaign cost ceilings.
- No live calls from default tests.
- Immutable run creation and predecessor validation.
- Model/configuration drift detection.
- Raw-to-parsed output linkage.

### 13.3 Remediation tests

- Shadow generation cannot mutate canonical entries.
- Stale-entry and wrong-ID rejection.
- Partial promotion failure and rollback.
- Canary-only promotion before expansion.
- Affected-case rerun selection.
- No bypass around exact-ID reviewed promotion.

### 13.4 Closure tests

- Independent 35-plus-5 label-integrity gate and terminal-outcome enforcement.
- Per-family and overall threshold enforcement.
- Five-of-five safety requirement.
- Material-benefit and independent-compatibility enforcement after calibration is frozen.
- Exact artifact binding for Gold Label Owner and QA approvals.
- Rejection of implementation actors as external QA.
- C0 and C1 remain closed and byte-resolvable while C2 changes.

## 14. Six-pass delivery sequence

### Pass 1: Contract and three-case pilot

Define versioned case, label-integrity set, decision label, scorecard, run, failure, remediation, and approval contracts. Preserve the 12 v1 synthetic fixtures. Author one product, one migration, and one safety pilot. Define provisional governance and write tests before implementation.

### Pass 2: Harness and pilot calibration

Implement the evaluation-only runner. Execute brief-only, current-grounded, and gold-evidence controls for the pilots. Freeze the quantitative material-benefit rule, independent-compatibility checklist, rubric anchors, and budgets after reviewing pilot evidence.

### Pass 3: Frozen 25-case baseline

Select and independently label the 35 reproducible plus 5 challenge entries, record agreement and adjudication, and freeze the label-integrity set. Author and review the complete 25-case decision set, freeze its artifact versions, execute the primary model across all cases, execute the independent five-case subset, and perform blinded human scoring.

### Pass 4: Failure adjudication

Classify failures using controlled comparisons. Run corrected-label shadows before confirming label failures. Approve an exact remediation matrix or explicitly record that retagging is not justified.

### Pass 5: Targeted remediation

Shadow-retag confirmed label failures, curate or acquire evidence for blocking coverage failures, promote exact reviewed canaries, verify rollback, rerun affected cases, and approve any expansion.

### Pass 6: Final evaluation and C2 closure

Rerun the frozen suite against the final corpus snapshot, meet every threshold, freeze the closure artifacts, record Gold Label Owner approval, obtain external QA approval, and verify the public readiness report closes C2 without reopening C0 or C1.

Each pass receives its own implementation plan and holistic review. Pass 1 is planned first; later plans must incorporate evidence from prior passes rather than guessing their outcomes.

## 15. Completion criteria

C2 is complete only when:

- The frozen 25-case set and its gold labels are versioned and reviewable.
- The independently labelled 35-plus-5 integrity set, agreement report, and terminal quality outcome satisfy the parent C2 authority.
- Evaluation runs are reproducible as immutable evidence with enforced budgets.
- Controlled comparisons support every reported failure classification.
- Deterministic and human thresholds pass per family and overall.
- All safety cases pass with no private disclosure.
- Every corpus mutation has provenance, exact-ID approval, canary evidence, and rollback.
- Blocking coverage failures are resolved or the affected case prevents closure.
- The primary and independent challenge outputs reach compatible critical decisions.
- Gold Label Owner and external QA approvals bind identical closure artifacts.
- The readiness validator reports C0, C1, and C2 closed.
- No C3 product capability is claimed or shipped as part of C2.

## 16. Next action

Create the implementation plan for **Pass 1: Contract and three-case pilot** only. The plan must reconcile these contracts with the existing readiness validator, design-handoff scorer, evaluation fixtures, and immutable governance chains on `main`.
