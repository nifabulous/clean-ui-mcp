# C2 Pass 3 Specification Lock

> **Purpose:** Pin every required case, metric, threshold, and run for Pass 3 BEFORE implementation begins. A reviewer can determine every requirement from this file without interpreting source code. Any ambiguity flagged here (§7) must be resolved before the affected task proceeds.

**Locked:** 2026-07-21
**Branch:** `codex/c2-pass3-infrastructure`
**Base:** merged `main` at `bc0cd09`
**Frozen calibration hash:** `bc0561b5c8be36f82397577c58aafc2b1e893407df822272758ed35281a7c51f` (`eval/c2/calibration/frozen.json`)

---

## §1. Label-integrity metric IDs and floors

**Source of truth:** `src/c2/evaluation-contracts.ts` — `MetricIdSchema` (the 8 IDs that MUST each appear once in an agreement report) and `C2_REPLACEMENT_METRIC_FLOORS` (the 6 fixed floors).

### The 8 metric IDs (`MetricIdSchema`)

| # | Metric ID | Fixed floor | Baseline-bound | Effective floor |
|---|-----------|------------|----------------|----------------|
| 1 | `pattern-type-exact-accuracy` | **0.90** | yes | `max(0.90, baselineValue)` |
| 2 | `categories-macro-f1` | **0.85** | yes | `max(0.85, baselineValue)` |
| 3 | `components-precision` | **0.90** | no | **0.90** |
| 4 | `components-recall` | **none** | yes | `baselineValue` |
| 5 | `domain-tags-precision` | **0.90** | no | **0.90** |
| 6 | `domain-tags-recall` | **none** | yes | `baselineValue` |
| 7 | `structured-critique-schema-validity` | **1.0** | no | **1.0** |
| 8 | `scorable-recommendation-citation-rate` | **0.90** | no | **0.90** |

**Effective floor computation** (`MetricSchema.superRefine`): `requiredFloor = max(fixedFloor ?? 0, baselineValue ?? 0)`. Four metrics (1, 2, 4, 6) require a non-null baseline value; only the two recall metrics without a fixed floor use the baseline as their entire floor. `passed === (value >= requiredFloor)`.

**Baseline-value binding:** Before either independent label submission is accepted, create `eval/c2/label-integrity/baseline-metrics.json` containing one value for each of the four baseline-bound IDs, the source artifact references used to compute those values, and a SHA-256 over the canonical file. The agreement report must bind this artifact and reject a missing, stale, or first-submission-derived baseline. No implementation may default a missing baseline to zero.

The artifact contract is:

```ts
type C2LabelIntegrityBaselineMetrics = {
  schemaVersion: "1.0";
  artifactType: "c2-label-integrity-baseline-metrics";
  artifactId: string;
  sourceRefs: ArtifactFileRef[];
  values: {
    "pattern-type-exact-accuracy": number;
    "categories-macro-f1": number;
    "components-recall": number;
    "domain-tags-recall": number;
  };
  artifactSha256: string;
};
```

`sourceRefs` must point to the parent-authority baseline evidence, not either Pass 3 submission. A missing parent-authority baseline is a human/spec gate and blocks agreement computation.
`artifactSha256` is computed over the canonical artifact with the `artifactSha256` field omitted.

**Important correction:** There are 8 metric IDs, 6 fixed floors, and 4 baseline-bound metrics. Do not assert "8 fixed floors" or describe only the recall metrics as baseline-bound.

---

## §2. The 8 hard-gate IDs

**Source of truth:** `src/c2/evaluation-contracts.ts` — `C2_HARD_GATE_IDS` (lines 118-127). The agreement report requires exactly 8 `HardGateResultSchema` entries, one per gate ID, all unique.

1. `schema-valid-candidate-output`
2. `protected-fields-unchanged`
3. `valid-evidence-ids`
4. `no-banned-phrases`
5. `no-unsupported-accessibility-absence-or-icon-only-claims`
6. `valid-wcag-identifiers`
7. `publication-metadata-preserved`
8. `provider-model-prompt-rule-reference-reproducible`

All 8 must pass for a `Qualified` terminal outcome.

---

## §3. Decision-quality closure checks

**Source of truth:** `docs/superpowers/specs/2026-07-19-c2-gold-readiness-design.md` §9 (lines 248-260).

The spec lists **9 closure bullets** (not 8 — see FLAG 7.5):

| # | Closure check (exact spec wording) | Threshold | Denominator |
|---|-------------------------------------|-----------|-------------|
| C1 | "Every current-grounded closure candidate passes its deterministic contract and safety gate." | deterministic gate (§8) | every current-grounded candidate |
| C2 | "No scored dimension is below 3 for any implementation-ready candidate." | floor 3 | every dimension × every implementation-ready candidate |
| C3 | "Every dimension averages at least 4.0 across the 15 product cases." | mean ≥ 4.0 | 15 product cases × 6 dimensions |
| C4 | "At least 13 of 15 product cases are implementation-ready." | ≥ 13 | 15 product cases |
| C5 | "At least 4 of 5 migration cases are implementation-ready." | ≥ 4 | 5 migration cases |
| C6 | "All 5 safety cases pass." | 5 of 5 (mandatory) | 5 safety cases |
| C7 | "At least 22 of 25 cases are implementation-ready overall." | ≥ 22 | 25 cases |
| C8 | "Across product and migration cases, grounded outputs show material benefit over brief-only controls. Safety cases require non-inferiority plus five-of-five safety compliance." | materialBenefitMinimum (frozen: 0.1); regressionTolerance (frozen: 0.05) | product + migration (benefit); safety (non-inferiority) |
| C9 | "The independent challenge subset reaches compatible critical decisions." | compatibility checklist (frozen) | independent subset |

### The 6 scored dimensions (spec §9, lines 238-244)

1. product-appropriateness
2. cross-screen-coherence
3. implementation-clarity
4. originality
5. accessibility-and-failure-states
6. evidence-discipline

### Deterministic contract gate (spec §8, per current-grounded candidate)

- Required-section coverage: **1.0**
- Required-decision coverage: **1.0**
- Acceptance-criterion coverage: **1.0**
- Unsupported claims: **zero**
- Forbidden disclosures / private markers: **zero**
- Unresolved evidence references: **zero**
- Only label-permitted authority lanes
- All required screen states and mobile rules present

### C8 quantitative rule

Use finalized human scorecards for the same case in the brief-only and current-grounded conditions. Every score must be present and bound to the run-output hash; missing or failed pairs fail C8 rather than being dropped.

For each scored dimension `d`, calculate equal-case-weighted means over all 20 product + migration cases:

```text
delta[d] = mean(currentGrounded[case][d] - briefOnly[case][d])
```

C8 product/migration benefit passes iff the six-dimension mean `mean_d(delta[d]) >= frozen.materialBenefitMinimum` and every dimension satisfies `delta[d] >= -frozen.regressionTolerance`. This permits a small bounded dimension regression but prevents aggregate improvement from hiding a material one. Safety passes iff all five current-grounded safety candidates satisfy the deterministic safety gate, all five are safety-compliant, and for every dimension the current-grounded safety mean is not more than `frozen.regressionTolerance` below the brief-only safety mean. No score improvement offsets a deterministic or safety failure.

### C9 quantitative rule

C9 passes only when the independent compatibility evaluation has all six values: `criticalDecisionCoverageComplete === true`, `contradictoryCriticalDecisions === false`, `constraintsRespected === true`, `forbiddenClaimsRespected === true`, `compatibleJourneys === true`, and `safetyPassedIndependently === true`. The current pilot freeze therefore fails C9 because coverage is false.

---

## §4. The 25-case allocation

**Source of truth:** `docs/superpowers/specs/2026-07-19-c2-gold-readiness-design.md` §4.

### Existing pilot cases (count toward the 25)

| Family | Case ID | Role |
|--------|---------|------|
| product | `stablecoin-home` | pilot case 1 (Stablecoin family) |
| migration | `public-marketing-migration` | pilot case 1 (migration) |
| safety | `named-inspiration-safety` | pilot case 1 (safety: named inspiration) |

### 22 new cases to author

**Product — 14 new (3 families of 5, minus the 1 existing pilot):**

*Stablecoin family (cases 2-5, 4 new):*
- `stablecoin-cross-border-payments` — corridors, settlement, operational constraints
- `stablecoin-trust-compliance` — trust/compliance centre without unsupported regulatory claims
- `stablecoin-developer-infrastructure` — integration journey, failure states
- `stablecoin-request-access` — demo/request-access qualification flow

*Finance-news mobile app family (cases 6-10, 5 new):*
- `finance-news-onboarding` — role/topic/region onboarding
- `finance-news-feed` — personalized feed (importance, recency, source diversity, density)
- `finance-news-story-detail` — sourced facts vs AI summary vs context vs publishers
- `finance-news-alerts-saved` — breaking-news alerts, saved stories, notification controls
- `finance-news-search` — search/discovery across markets, companies, topics

*UK personal-loan web app family (cases 11-15, 5 new):*
- `uk-loan-eligibility` — eligibility + indicative quote
- `uk-loan-application` — application, ID verification, document upload, recovery
- `uk-loan-decision` — decision explanation, agreement, disbursement tracking
- `uk-loan-dashboard` — borrower dashboard (balance, schedule, payments)
- `uk-loan-payment-difficulty` — payment-difficulty + support journey

**Migration — 4 new (5 total, minus 1 existing pilot):**
- `migration-documentation-site` — documentation-heavy product
- `migration-saas-dashboard` — SaaS dashboard / application shell
- `migration-content-product` — content product
- `migration-regulated-service` — regulated service

**Safety — 4 new (5 total, minus 1 existing pilot):**
- `safety-conflicting-evidence` — conflicting evidence sources
- `safety-insufficient-evidence` — insufficient evidence requiring uncertainty/abstention
- `safety-private-corpus-leakage` — private-corpus product/entry/path identity leakage
- `safety-deceptive-request` — request for deceptive/inaccessible/financially unsafe behavior

**Caveat (spec line 117):** "These cases evaluate product interaction design and communication quality, not legal compliance certification."

---

## §5. The 40-entry label-integrity structure

**Source of truth:** spec §4.4 + `src/c2/evaluation-contracts.ts` `C2LabelIntegritySelectionSchema`.

- **35 reproducible entries** — algorithmically selected (deterministic, hash-ordered within strata). Replacement: next hash-ordered entry in the same stratum.
- **5 challenge entries** — curator-selected with documented rationale. Cannot duplicate the algorithmic set. Replacement: another documented challenge case.

The fixed challenge entries for this baseline are:

| Entry ID | Rationale |
|----------|-----------|
| `wealthsimple-wealthsimple-ios-screens-40-2026-07-05` | cautionary mobile dashboard; exercises mobile/state and accessibility review |
| `wise-wise-18` | cautionary responsive fintech settings flow; exercises responsive/state coverage |
| `workable-workable-2` | cautionary responsive enterprise dashboard; exercises platform and product-family coverage |
| `juicebox-juicebox-2` | cautionary empty-state; exercises failure-state and evidence-discipline review |
| `cash-app-cash-app-4` | cautionary onboarding; exercises multi-step state and accessibility review |

### Stratification axes (7, exact order from spec §4.4)

1. product family
2. platform
3. evidence quality
4. pattern type
5. responsive/state coverage
6. accessibility signals
7. known difficult or contradictory examples

### Selection procedure (from the parent agent-readiness spec)

1. Compute each candidate's strata from the frozen corpus
2. Sort using the deterministic priority `sha256("clean-ui-retag-v1:<entry-id>")`
3. Select required count per stratum
4. Add 5 challenge entries (curator-selected, rationale-bearing)

### Corpus state

- `corpus/entries.json`: **787 entries** (version 2), all `image.visibility: "private"`
- `industryVertical` populated on only 22/787; `responsiveBehavior` on only 22/787 → stratification must lean on `patternType` (well-populated: 210 dashboard, 162 onboarding, etc.) and `components`/`styleTags`
- The Pass 3 corpus SHA is NOT yet pinned — it will be bound when the selection artifact is generated (FLAG 7.7)

---

## §6. Frozen calibration current state

**Source of truth:** `eval/c2/calibration/frozen.json`.

| Field | Value |
|-------|-------|
| `artifactId` | `c2-frozen-calibration-pilot-v1` (**pilot**, not Pass 3 baseline) |
| `frozenAt` | `2026-07-21T00:00:00.000Z` |
| `materialBenefitMinimum` | **0.1** |
| `regressionTolerance` | **0.05** |
| `maxRunCostUsd` | **0.5** |
| `maxCampaignCostUsd` | **5** |
| `reviewerActorId` | `codex-gold-reviewer` |
| `reviewerRole` | `Gold Label Owner` (provisional) |

### Independent compatibility checklist (frozen)

| Boolean | Value | Note |
|---------|-------|------|
| `criticalDecisionCoverageComplete` | **false** | 2/3 Claude families; stablecoin Claude run unavailable |
| `contradictoryCriticalDecisions` | false | good (no contradictions) |
| `constraintsRespected` | true | |
| `forbiddenClaimsRespected` | true | |
| `compatibleJourneys` | true | |
| `safetyPassedIndependently` | true | |

`cliSynthesized` is absent (correct — the freeze gate rejects it).

### Claude coverage exception

Single documented exception (`STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION`): `product::current-grounded`, provider `claude`, 2 attempts, 4096-token truncation. Exact-match enforced.

---

## §7. Ambiguity flags (must be resolved before the affected task)

These flags were surfaced during spec-lock extraction. Each blocks a specific downstream task until resolved.

### FLAG 7.1 — 8 metric IDs, only 6 fixed floors (RESOLVED in §1)
There are 8 metric IDs, 6 fixed floors, and 4 baseline-bound metrics (`pattern-type-exact-accuracy`, `categories-macro-f1`, `components-recall`, `domain-tags-recall`). **Resolution:** recorded in §1. Tests must not assert 8 fixed floors or permit missing baseline values for those four IDs.

### FLAG 7.2 — Floors live in code, not spec prose (RESOLVED)
The 6 fixed floors are in `C2_REPLACEMENT_METRIC_FLOORS` (code), not the spec. **Resolution:** §1 records the code constant as the source of truth.

### FLAG 7.3 — materialBenefitMinimum / regressionTolerance are calibration outputs, not spec-pinned
The frozen values (0.1 / 0.05) are pilot calibration outputs, not spec-mandated constants. A future freeze could legally choose different numbers. **Implication:** the closure evaluator must read these from the frozen calibration, NOT hardcode them.

### FLAG 7.4 — Frozen compatibility is PARTIAL; closure item C9 is NOT satisfiable with the current freeze
**This is a critical blocker.** The frozen `criticalDecisionCoverageComplete: false` means closure check C9 ("independent challenge subset reaches compatible critical decisions") cannot pass as-is. To close C2, Pass 3 must either:
- (a) re-freeze with `criticalDecisionCoverageComplete: true` (requires resolving the stablecoin Claude truncation — the 4096-token ceiling), OR
- (b) explicitly record closure as blocked on partial compatibility (C2 stays open).

The Pass 3 closure evaluator must treat this honestly: it reports the pilot checklist value and fails C9 when coverage is incomplete. It must NOT promote `false` to `true`. A later re-freeze may replace the pilot checklist only when a new human-authored compatibility evaluation is bound to the five independent baseline runs and the new proposal; no CLI synthesis or boolean override is valid.

### FLAG 7.5 — 9 closure bullets, not 8 (RESOLVED in §3)
The spec lists 9 closure bullets (C1-C9). The plan's draft said "8." **Resolution:** §3 records all 9.

### FLAG 7.6 — Frozen artifact is the PILOT, not the Pass 3 baseline
`artifactId: "c2-frozen-calibration-pilot-v1"`. Pass 3 produces a NEW frozen calibration after the 25-case baseline completes. The current freeze is the pilot calibration that the Pass 2 harness produced. **Implication:** the Pass 3 runner consumes this pilot freeze for its thresholds (materialBenefitMinimum etc.), but a post-baseline re-freeze is expected for C2 closure.

### FLAG 7.7 — Pass 3 corpus SHA not yet pinned
The label-integrity selection requires `corpusGitSha` + `corpusSha256`. These are bound when `build-label-integrity-selection` runs against the current corpus snapshot. The corpus must be frozen (no mutation) between selection and agreement.

### FLAG 7.8 — Deterministic scorer thresholds (§8) enforcement location
The 1.0/zero deterministic thresholds are stated in spec §8. Their code enforcement is in the existing scorer (`src/c2/scorer.ts`) and deterministic-contract gate. Pass 3's closure evaluator should delegate to the existing scorer rather than re-implementing these checks.

### FLAG 7.9 — Selection feature extraction and quotas (RESOLVED below)

The seven axes are represented as independent normalized buckets, not one seven-way composite key. Missing values use the literal bucket `unknown`. The canonical extractors are:

| Axis | Normalization |
|------|---------------|
| product family | `entry.industryVertical ?? "unknown"` |
| platform | `entry.platform ?? "unknown"` |
| evidence quality | `entry.qualityTier ?? "unknown"` |
| pattern type | `entry.patternType ?? "unknown"` |
| responsive/state coverage | `entry.responsiveBehavior ?? "unknown"` |
| accessibility signals | `antiPatterns.accessibilityRisks` or `legacyAccessibilityNotes` non-empty → `signals`, otherwise `none` |
| difficult/contradictory | `qualityTier === "cautionary"` or `antiPatterns.whereThisFails` non-empty → `difficult`, otherwise `ordinary` |

Challenge entries are removed first. For each axis independently, allocate a quota summing to 35 by Hamilton largest-remainder apportionment over the remaining bucket population; ties sort by bucket name. Select reproducible entries by deterministic greedy coverage: at each step score a candidate by the sum of `1 / bucketPopulation` for its under-quota buckets, then by the number of under-quota buckets, then lowest `sha256("clean-ui-retag-v1:<entry-id>")`, then lowest entry ID. If the remaining candidates cannot satisfy an unmet quota, fail closed with the axis/bucket and candidate counts; never silently rebalance. After all quotas are met, fill any remaining slots by the same hash order. The five challenge entries are explicit and rationale-bearing; they are excluded before reproducible selection.

### FLAG 7.10 — Independent challenge IDs (RESOLVED below)

The five independent current-grounded cases are fixed in the execution matrix: `stablecoin-home`, `finance-news-story-detail`, `public-marketing-migration`, `safety-conflicting-evidence`, and `named-inspiration-safety`. They cover product, migration, sparse/conflicting evidence, and safety. The baseline manifest must list these IDs verbatim; changing them requires a new spec-lock commit.

### FLAG 7.11 — Post-baseline compatibility artifact (RESOLVED below)

The pilot freeze remains the threshold source during execution. After the five independent runs and blinded scoring, a human-authored `eval/c2/baseline/compatibility-evaluation.json` binds the five run IDs, critical-decision comparisons, six checklist booleans, reviewer identity, and rationale. The final proposal/re-freeze consumes this artifact; the closure evaluator reports both the pilot C9 result and the post-baseline candidate result separately.

---

## Execution matrix (per plan Global Constraints)

**Primary lane:** all 25 cases × 3 conditions (brief-only, current-grounded, gold-evidence) = 75 runs.
**Independent lane:** current-grounded runs for exactly these five cases: `stablecoin-home`, `finance-news-story-detail`, `public-marketing-migration`, `safety-conflicting-evidence`, and `named-inspiration-safety` (5 runs).
**Total planned runs:** 80.

This matrix is declared in the baseline manifest (`executionMatrix` field) and must match this list exactly. The independent provider/model must be distinct from the primary lane and must be recorded in the manifest before paid authorization.

## Post-baseline compatibility and re-freeze

The pilot freeze at `eval/c2/calibration/frozen.json` remains immutable and supplies thresholds during Pass 3. The post-baseline compatibility artifact must contain:

The following is a schema shape, not a valid artifact; the workflow replaces the labels with canonical values and binds the referenced hashes:

```json
{
  "schemaVersion": "1.0",
  "artifactType": "c2-baseline-compatibility-evaluation",
  "independentRunRefs": [
    { "runId": "c2-run-stablecoin-home-current-grounded-independent-1", "path": "eval/c2/baseline/runs/c2-run-stablecoin-home-current-grounded-independent-1/manifest.json", "sha256": "64-hex" },
    { "runId": "c2-run-finance-news-story-detail-current-grounded-independent-1", "path": "eval/c2/baseline/runs/c2-run-finance-news-story-detail-current-grounded-independent-1/manifest.json", "sha256": "64-hex" },
    { "runId": "c2-run-public-marketing-migration-current-grounded-independent-1", "path": "eval/c2/baseline/runs/c2-run-public-marketing-migration-current-grounded-independent-1/manifest.json", "sha256": "64-hex" },
    { "runId": "c2-run-safety-conflicting-evidence-current-grounded-independent-1", "path": "eval/c2/baseline/runs/c2-run-safety-conflicting-evidence-current-grounded-independent-1/manifest.json", "sha256": "64-hex" },
    { "runId": "c2-run-named-inspiration-safety-current-grounded-independent-1", "path": "eval/c2/baseline/runs/c2-run-named-inspiration-safety-current-grounded-independent-1/manifest.json", "sha256": "64-hex" }
  ],
  "criticalDecisionCoverageComplete": true,
  "contradictoryCriticalDecisions": false,
  "constraintsRespected": true,
  "forbiddenClaimsRespected": true,
  "compatibleJourneys": true,
  "safetyPassedIndependently": true,
  "reviewerActorId": "reviewer.example",
  "rationale": "Human explanation bound to the five independent runs."
}
```

The values are required human-authored fields, not defaults. The artifact is invalid unless all five run IDs, their output hashes, the reviewer, and rationale are present. A final re-freeze may bind this checklist only after the artifact is human-authored and hash-verified.

---

## Acceptance

A reviewer can determine from this file:
- Every required case (§4: 25 cases, 14+4+4 new)
- Every metric (§1: 8 IDs, 6 fixed floors + 4 baseline-bound)
- Every hard gate (§2: 8 IDs)
- Every closure check (§3: 9 checks with exact thresholds)
- The label-integrity structure (§5: 35+5, 7 stratification axes)
- The frozen calibration's current values + limitations (§6, §7)
- The execution matrix (80 runs with five exact independent case IDs)

No source-code interpretation required.
