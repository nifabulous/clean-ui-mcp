# Post-Diagnosis Verifier Follow-up — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the two decisions the abstain diagnosis pre-registered, now
that the element-box probe has closed element detection: reclassify the
single-image-ceiling fields to the `gated` tier, and fix the prompt contract's
verdict-missing defect. Plus the documentation closures both runs committed to.

**Architecture:** Three workstreams on the verifier lane, run SEQUENTIALLY —
A and B both edit `src/scripts/verify-corpus.ts`, and A shortens the very prompt
B2 measures, so running them in parallel would confound the result (see
"Ordering"). Workstream A
moves three fields in `TIER_BY_FIELD` (`src/scripts/verify-corpus.ts:78-113`)
to `gated`, which the existing machinery already handles correctly (gated fields
never keep entries queued, never persist markers, and the three target detectors
are `disabled: true` so the detector lane cannot bypass the tier). Workstream B
strengthens the prose verdict contract in `buildVerifyPrompt` and re-measures
the cohort read-only. Workstream C closes the documentation. The two feature
branches integrate first so the re-measurement runs against the merged state.

**Tech Stack:** TypeScript (ES modules), vitest, `--diagnose` dry-run CLI.

## Global Constraints

Copied from the diagnosis plan and still binding.

- **Governing invariant:** any run produces measurement and nothing else — no
  corpus writes, no schema change. Every diagnosis re-run is `--diagnose`
  (implies dry-run) and the corpus hash is checked before and after.
- **Verdict logic invariant:** for a field that stays in the lane, no verdict
  moves. Tier reclassification is the point of Workstream A, not an invariant
  violation: it changes which fields are IN the lane.
- TDD: failing test first, then implementation, then commit. Every task.
- Review artifact after every task: `.zcode/scripts/write-review-artifact`
  (`--type task`); the branch gate blocks the next commit without it.
- Known test baseline (measured on `fb055fa` and unchanged since): `tagger`
  Gemini thinking-config drift and `mcp-smoke` server-startup timeout are
  environmental; `wiring-verification` and `ui-browser` time out under full-suite
  load but pass in isolation. A new failure in any other file is this work's.
- Worktree environment for re-measurement (Task B2): the worktree `.env` must
  route pass 2 to minimax (`AUTO_TAG_PROVIDER_CRITIQUE=minimax` — the env
  default NIM/DeepSeek endpoint is text-only), `verify-report.md` and
  `corpus/entries.json` copied from the main checkout, and
  `corpus/images-private/*` symlinked. All local-only, never committed.

## Context — why this plan exists

### The diagnosis result (2026-08-08, 50-entry cohort, dry-run)

488 pass / 5 contradicted / 283 abstain / 324 gated / 0 fail. Of 233 model-lane
abstains: **215 model-abstained, 16 corroboration-split, 2 verdict-unrecognised**.
Zero defect causes as final verdicts.

Rule 1 (defect causes at n ≥ 10) fired for none. Rule 2 (reason-text) fired in
both branches:

1. **Single-image ceiling** — `visual.accentColor` (39 abstains),
   `visual.colorRoles` (12), `visual.usesShadows` (25): reasons say exact hex
   values and subtle elevation cannot be verified from one screenshot. 76 of
   215. The honest response is reclassifying to `gated`, or measuring with
   pixels.
2. **Hedging with specific evidence** — the soft/taxonomy fields: prompt and
   consensus work has real headroom.

Also measured: **50 prose `firstCause` verdict-missing** — the initial combined
ask frequently drops the verdict key for prose fields, masked by the re-produce
pass. That is a prompt contract defect with a cheap fix.

### The probe result (2026-08-08, 46-image set)

No rung passed the 70% bar. UIED techniques 52.2% (best, under-detects),
classical CV 23.9% (finds text), deki-yolo 19.6% (right objects, wrong
boundaries), OmniParser 0.0% (right count, wrong positions), Florence-2 0.0%
(page regions), Moondream 0.0% (one box per image). Under the pre-registered
rule, **element detection closes here**. Consequence for this plan:

- The four pixel detectors (`usesBorders`, `usesShadows`, `spacingDensity`,
  `cornerStyle`) cannot be rescued by any proposer tried. `usesShadows` is in
  the single-image ceiling cluster above, and the probe cannot help it either —
  it is unrescuable by both routes.
- `accentColor` stays **Class B** at **85, not 122** — no rung distinguishes
  interactable elements. The diagnosis spec's open question is resolved.

### Serving semantics, verified in code (the ground for Workstream A)

- `isVerified` ignores `verifierVersion` (`src/scripts/verify-corpus.ts:1082`),
  so a field reclassified to `gated` keeps serving its existing verification
  records; only NEW verification stops.
- Gated fields are excluded from `selectPending` (`:896`) and the per-entry
  pending filter (`:515`), so they never keep an entry queued; `resumeMarkers`
  skips them (`:1073`), so nothing persists.
- Synthesis projections omit enrichment fields that are not verified
  (`src/synthesis-projection.ts:76`), so an unverified gated field stops being
  served in synthesis output.
- The three target fields' detectors are `disabled: true`
  (`src/verify/detector-registry.ts:33-44`), so the detector lane cannot bypass
  the tier. If one is ever re-enabled, that is a deliberate contradiction to
  resolve, not a silent interaction.

## File Structure

| file | responsibility | change |
|---|---|---|
| `src/scripts/verify-corpus.ts` | tier table, prompt builder | modify (A1, B1) |
| `src/scripts/verify-corpus.test.ts` | tests | modify (A1, A2, B1) |
| `src/synthesis-projection.test.ts` | projection omission | modify (A2 pin) |
| `docs/verifier-abstain-diagnosis.md` | re-measurement appendix | modify (B2) |
| `docs/superpowers/specs/2026-08-08-verifier-abstain-diagnosis-design.md` | accentColor closure | modify (C1) |
| `docs/verifier-calibration.md` | probe outcome record | modify (C2) |

## Workstream D (first, prerequisite) — integrate the two feature branches

The follow-up measures the model lane after BOTH branches land, so the
measurement reflects the integrated state.

- [ ] **Step 1: Merge `feat/verifier-abstain-diagnosis` and
  `feat/element-box-probe` into `feat/deterministic-detectors`** (disjoint
  files: `src/scripts/verify-corpus.*` vs `eval/element-box-probe/*` plus one
  doc each — no conflicts expected; resolve any doc conflicts by keeping both).
- [ ] **Step 2: Create the follow-up worktree from the merged base** and copy
  the untracked run inputs (report, corpus, `.env` with minimax critique,
  image symlinks) per the Global Constraints above.

## Workstream A — gated reclassification

Reclassify the three single-image-ceiling fields to `gated`. This is the
diagnosis's Rule 2 branch 1 decision, now stronger because the probe closed the
alternative route for `usesShadows`.

### Task A1: Move accentColor, colorRoles, usesShadows to gated

**Files:** `src/scripts/verify-corpus.ts`, `src/scripts/verify-corpus.test.ts`

- [ ] **Step 1: Write the failing tests**

  - `tierForField("visual.accentColor") === "gated"` (same for
    `visual.colorRoles`, `visual.usesShadows`) — update the existing
    tier-classification table test instead of adding a parallel one.
  - A `verifyEntry` test with a `callVision` spy asserting **no vision call is
    made** for an entry whose only pending fields are the three reclassified
    ones — the gating must stop the model spend, which is the point.
  - A `selectPending` test: an entry whose only unprocessed fields are gated is
    **not re-queued** (the convergence guarantee).

- [ ] **Step 2: Run to verify they fail**

  `npx vitest run src/scripts/verify-corpus.test.ts -t "gated reclassification"`
  — expect FAIL on the new assertions (fields are not gated today).

- [ ] **Step 3: Implement**

  In `TIER_BY_FIELD` (`src/scripts/verify-corpus.ts:78-113`), move
  `visual.accentColor`, `visual.colorRoles`, and `visual.usesShadows` to
  `"gated"` and reorder the table so the three sit with `responsiveBehavior`.

- [ ] **Step 4: Soften the gate reason string so it stops contradicting the
  records that keep serving**

  `decideFieldVerdict` emits one shared reason for every gated field
  (`src/scripts/verify-corpus.ts:324`):

  ```ts
  return { field, verdict: "gate", reason: "no single screenshot can confirm this claim" };
  ```

  That is an absolute claim about confirmability, and it is **true for
  `responsiveBehavior`** — no one screenshot shows responsive behaviour. It is
  NOT true for the three fields arriving here: 28 entries carry
  `image-confirmed` verification records for them (A3 Step 2), each asserting
  that a single screenshot *did* confirm the claim. Ship the string unchanged
  and the lane serves 28 records its own gate reason calls impossible.

  Replace it with a statement about the LANE'S POLICY rather than about
  confirmability, which is true of all four gated fields and contradicts nothing:

  ```ts
  return { field, verdict: "gate", reason: "this field is not verified from a single screenshot" };
  ```

  Add a test asserting the new string, and grep for the old literal before
  changing it — `verify-corpus.test.ts` may pin it in a report fixture, the same
  way `"not positively confirmed"` was pinned at `:739`.

  This is deliberately a wording change, not a behaviour change: the verdict
  stays `gate` and no field moves. It exists so the served reason is not a claim
  the corpus falsifies 28 times.
  No other production change. The disabled detectors, `selectPending`, pending
  filter, and `resumeMarkers` already handle gated fields correctly.

- [ ] **Step 4: Run the new tests, then the full file, then typecheck**

  `npx vitest run src/scripts/verify-corpus.test.ts` (expect all pass, including
  the characterization guard — tier changes do not touch `decideFieldVerdict`)
  and `npx tsc --noEmit` (clean).

- [ ] **Step 5: Commit and write the task artifact**

  ```bash
  git add src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts
  git commit -m "feat(verify): reclassify the single-image-ceiling fields to gated

The abstain diagnosis measured 76 of 215 model-lane abstains on fields whose
reasons say the value cannot be verified from one screenshot: accentColor,
colorRoles, usesShadows. The element-box probe closed the pixel-measurement
route (no rung passed, including for usesShadows). Asking the model again on
these fields spends calls to produce a known abstain; gating them stops the
spend, keeps existing verification records serving (isVerified ignores
verifierVersion), and lets the queue converge."
  .zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
    --base-sha $(git rev-parse HEAD^) --head-sha $(git rev-parse HEAD) \
    --branch feat/verifier-abstain-followup
  ```

### Task A2: Pin the serving consequence

**Files:** `src/synthesis-projection.test.ts` (or the projection's existing
test file), no production change.

- [ ] **Step 1: Write the tests**

  - A previously-verified `accentColor` record still passes `isVerified` after
    the reclassification (records outlive tiers).
  - Synthesis projection **omits** an unverified `visual.accentColor` from
    enrichment, and **keeps** a verified one.

- [ ] **Step 2: Run, commit, artifact** (tests should pass immediately — they
  pin existing behavior; the commit is `test(verify): pin serving semantics of
  reclassified gated fields`).

### Task A3: Document the decision

**Files:** `docs/verifier-abstain-diagnosis.md`

- [ ] **Step 1: Add a decision note** under Rule 2: the three fields were
  reclassified to `gated` on 2026-08-08 with their measured abstain counts
  (39/12/25), the probe's closure as the reason `usesShadows` is not waiting on
  element detection, and the serving consequence (records keep serving, new
  verification stops, synthesis omits the unverified).
- [ ] **Step 2: State how many records keep serving, measured not asserted.**
  Counted against the live corpus on 2026-08-08: **28 verification records
  across 787 entries** — `accentColor` 9, `colorRoles` 0, `usesShadows` 19.
  (Also present and unaffected: 11 `colorRoles` dataQuality findings and 111
  `verifyAttempts` markers across the three.)

  The number is what makes "keep them serving" the right call rather than an
  assumption: 28 of 787 is 3.6%, so revoking would destroy legitimately earned
  records to fix a contradiction almost nobody encounters. Had it been 300, the
  call would go the other way. A reader deserves the number, not the conclusion.
- [ ] **Step 3: Commit** (`docs(verify): record the gated reclassification`).

## Workstream B — prompt contract fix

### Task B1: Require the verdict key on the prose initial ask

**Files:** `src/scripts/verify-corpus.ts` (`buildVerifyPrompt`), tests

- [ ] **Step 1: Write the failing test**

  Assert the built prompt for a prose field contains an explicit clause that the
  `verdict` key is REQUIRED for every enumerated field, with the exact enum
  (`confirmed | contradicted | abstain`) — today the prose line only says
  "return 'assertions': [] and 'confirmed': false" for the empty case, which is
  why the initial ask can drop the verdict key (50 `firstCause` verdict-missing).

- [ ] **Step 2: Implement**

  In `buildVerifyPrompt` (`src/scripts/verify-corpus.ts:242-251`), extend the
  prose line (or the shared preamble) with:

  > For EVERY field you enumerate, return the "verdict" key with exactly one of
  > "confirmed" | "contradicted" | "abstain". A field you addressed without a
  > verdict key is a contract violation.

  No parse or decision change — the parser already classifies a missing verdict
  as `verdict-missing`; the fix is at the source.

- [ ] **Step 3: Run the full file and typecheck, commit, artifact**
  (`fix(verify): require the verdict key on the prose initial ask`).

### Task B2: Re-measure the cohort and record the delta

**Files:** `docs/verifier-abstain-diagnosis.md`

- [ ] **Step 1: Snapshot the corpus hash**, then run the same diagnosis command
  as the original (`--detectors on --diagnose --only-ids` with the 50 ids;
  cost ≈160 model calls, minimax both passes).
- [ ] **Step 2: Verify the corpus hash is unchanged** (the invariant).
- [ ] **Step 3: Apply the pre-registered decision rule.** Fixed BEFORE the run,
  because verdicts flip 14-18% between identical runs and 50 prose
  `verdict-missing` out of ~200 prose asks is 25% — a result of 30 would be
  genuinely ambiguous and would otherwise get argued about instead of decided.

  | `verdict-missing` after the fix | verdict |
  |---|---|
  | **≤ 10** | fixed — keep the clause |
  | **11-24** | inconclusive — do NOT claim success; second run or a different hypothesis |
  | **≥ 25** | not fixed — the cause is not prompt phrasing; revert the clause or keep it only if separately justified |

- [ ] **Step 4: Append a "Prompt contract fix — re-measurement" section** to the
  diagnosis doc: before/after counts, which band fired, and the new `Abstain
  causes` block verbatim. The denominator is UNCHANGED from the baseline —
  Workstream A has not landed yet, which is the point of this ordering.
- [ ] **Step 5: Commit** (`docs(verify): prompt contract re-measurement`).

## Workstream C — documentation closure

### Task C1: Close the accentColor open question in the spec

**Files:** `docs/superpowers/specs/2026-08-08-verifier-abstain-diagnosis-design.md`

- [ ] **Step 1: Update the "Parallel track" section**: the probe answered the
  interactable-element question in the negative (no rung distinguishes
  interactable elements; OmniParser's weights carry exactly one class, `icon`),
  so `accentColor` stays Class B and the addressable abstain set is **85, not
  122** — resolved, not open. Mark the parallel track as closed by the probe.
- [ ] **Step 2: Commit** (`docs(spec): close the accentColor open question`).

### Task C2: Record the probe outcome in the calibration doc

**Files:** `docs/verifier-calibration.md`

- [ ] **Step 1: Add a dated note** to the "What this changes" section: the
  element-localised prerequisite was probed on 2026-08-08 (six proposers, no
  rung passed, UIED 52.2% best) and element detection closed under its
  pre-registered rule; the four detectors remain disabled; the calibration
  claims ("Class A and Class C need element-localised measurement") stand but
  the prerequisite is not satisfiable with the proposers tried.
- [ ] **Step 2: Commit** (`docs(verify): record the element-box probe outcome`).

## Ordering — sequential on one branch, B1 before A

**Corrected 2026-08-08.** An earlier draft called A and B1 independent and
offered parallel worktrees. They are not independent, for a reason that would
have silently corrupted B2's result.

**The confound.** `buildVerifyPrompt` skips gated fields
(`src/scripts/verify-corpus.ts:231`, `if (tier === "gated") continue;`), so
Workstream A REMOVES three field lines from the combined ask — roughly 15% of a
typical ~20-line prompt. Workstream B's entire hypothesis is that the model drops
verdict keys *because the combined ask is long*. Land A first and B2 cannot
separate "the new clause worked" from "the prompt got shorter": two changes to
one input, one measurement.

**The stale-baseline problem.** The 50 `verdict-missing` figure was measured on
the CURRENT lane configuration. Land A first and that baseline describes a lane
that no longer exists, so the before/after comparison has no valid "before".

**They also share a file** — `TIER_BY_FIELD` at `:78-113` and
`buildVerifyPrompt` at `:224-248` are both in `src/scripts/verify-corpus.ts`.
Parallel worktrees on one module buy nothing once the work must be sequenced.

Required order:

1. **Workstream D** — integrate the two feature branches (prerequisite).
2. **Task B1** — the prompt clause.
3. **Task B2** — re-measure. Baseline is still valid; the only changed input is
   the clause, so the delta is attributable to it.
4. **Workstream A** — gated reclassification.
5. **Workstream C** — any point after D.

A-first is also viable but costs a second run (~320 calls total): land A,
re-baseline, land B1, re-measure. B1-first gets a clean attribution for one run.
A's own justification is the single-image ceiling, not prompt length, so its
effect does not need separate measurement.

## Self-review

- **Diagnosis coverage:** Rule 2 branch 1 → Workstream A; Rule 2 branch 2
  (hedging → prompt/consensus headroom) → Workstream B1 is the prompt half; the
  consensus half (a second ask) is deliberately NOT included — it needs its own
  cost/benefit decision and is recorded as out of scope here.
- **Probe coverage:** the probe's own follow-ups (recall check with labelled
  container boxes; the deki+3a hybrid) are recorded in `docs/element-box-probe.md`
  and intentionally not re-opened here — the line is closed under its rule.
- **Serving safety:** verified in code (isVerified version-agnostic, disabled
  detectors, gated exclusion in selectPending/resumeMarkers) and pinned by Task
  A2 tests.
- **Not covered, deliberately:** no detector re-enablement, no corpus backfill
  (298 gates), no consensus-ask work, no schema change, no `VERIFIER_VERSION`
  bump (tier changes are code, not records).

## Review amendments (2026-08-08)

None yet — this plan is the first revision of the follow-up.

### Amendments from the cross-branch review (2026-08-08, second round)

Three changes, one of which would have corrupted a measurement:

1. **Ordering: A and B1 are NOT independent; B1 now runs first.**
   `buildVerifyPrompt` skips gated fields (`:231`), so Workstream A removes three
   lines from the combined ask — ~15% of a ~20-line prompt. Workstream B's
   hypothesis is that the model drops verdict keys *because the ask is long*, so
   A-then-B2 could not separate the clause's effect from the shortening. The
   50-verdict-missing baseline was also measured on the current lane, so
   A-first would leave the comparison with no valid "before". They share a file
   besides. Sequential, B1 → B2 → A, one branch.
2. **B2 gets a pre-registered decision rule** (≤10 fixed / 11-24 inconclusive /
   ≥25 not fixed). Verdicts flip 14-18% between identical runs and the baseline
   is 25% of prose asks, so a mid-range result would be argued rather than
   decided.
3. **A1 softens the gate reason string.** The shared gated reason, "no single
   screenshot can confirm this claim", is true of `responsiveBehavior` but false
   of the three arriving fields — 28 entries carry `image-confirmed` records for
   them. Replaced with a policy statement ("this field is not verified from a
   single screenshot") that is true of all four. A3 now states the 28 measured
   against the live corpus, because that number is what makes "keep them
   serving" a decision rather than an assumption.

