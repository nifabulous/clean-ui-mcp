# Repairing the corpus — deterministic `colorScheme`, the 765-value fill, and what must gate it

**Date:** 2026-08-09
**Status:** NOT ready to implement. Design open on three points named below.
**Split from:** `2026-08-09-corpus-tag-provenance-design.md` (Tasks 1–2, ready)

## Why this is a separate spec

Round 3 of review put **13 of 16 findings** on this work. They were not scattered
AC defects — they were one structural fact: the task bundled a detector, the label
set that calibrates it, and a write of 765 values into the served corpus. The write
is what made everything else dangerous, and it needs a design the previous spec
never gave it.

The three that block implementation:

1. **Nothing gates the fill on its own calibration.** `assertGate`
   (`src/verify/calibration.ts:134-148`) has exactly one consequence — the
   `disabled` flag — and `src/verify/runner.ts:52` (`if (det.disabled) continue;`)
   applies it to the **verify** lane only. The fill is a separate path by design
   (the runner cannot author absent values; see "Why the fill needs its own path").
   So a detector that misses its floor and honestly ships `disabled: true` can
   still write 765 values and 765 `provable` records. That is the largest
   served-output change in either spec, and it is currently ungated.
2. **The label plan is unsatisfiable as written.** Measured on the native path the
   detector actually runs: **36 of 787 images below luma 110**, distributed
   `new-products-batch` 23, `wise-web-screens` 6, `workable-web-screens` 5,
   unmatched 2, and **zero** in `aboard-web-screens`, `cash-app-ios-nov-2025` and
   `juicebox-web-screens`. "≥6 dark per split" and "stratified across the six
   families" cannot both hold, and no rule said which wins.
3. **Class is perfectly confounded with label provenance.** All 22 entries carrying
   a `colorScheme` claim are `light` (native medians 223.8–255.0). So every dark
   label must be a fill-group row whose `recorded` value the labeller writes and
   whose `label` is `"confirmed"` by construction. The per-class gate — the sole
   mitigation for the "detector learns always-light" risk — can therefore only ever
   be evaluated against labeller-authored values, never an independent corpus
   claim.

Point 3 has no clean fix. It is a property of the corpus, not of the plan.

## What is settled

- **`colorScheme` is computed from pixels, not asked of a model.** Both pilot
  models returned identical values on 25/25 (`docs/backfill-model-pilot.md`) — no
  discriminating power in the model lane.
- **The corpus is ~95.6% light**, median luma 253 on the 64×64 script path and
  254.4 on the native path.
- **Detector design.** `src/verify/detectors/color-scheme.ts` reusing `luma()`
  (`src/verify/detectors/pixels.ts:5`) over the buffer `ensureRaw(ctx)` provides;
  median luma against a calibrated threshold; `pass` / `contradicted` / `abstain`
  per `DetectorResult` (`src/verify/detector-types.ts:8-15`). Registry entry keyed
  `colorScheme`, `category: "certifying"`, `canAffirm` accepting only `"light"` and
  `"dark"` (the schema enum, `src/schema.ts:479`).
- **Calibration must run on the production preprocessing path.**
  `eval/backfill-pilot/measure-luminance.mjs` downsamples to 64×64; `ensureRaw`
  feeds `luma()` native-resolution pixels. The two disagree at the threshold by one
  entry (35 vs 36 below 110) — a small, concrete demonstration of why five
  detectors calibrated on synthetic canvases measured 0–33% on real screenshots.
  Declare the threshold from a run of the detector itself.

### The four wiring points the registry alone does not cover

- `recordedFor` (`src/verify/detector-types.ts:39-63`) is a hardcoded switch with
  `default: return null`. Without a `colorScheme` case, `capVerdict`
  (`src/verify/runner.ts:35`) calls `canAffirm(null)` and every verdict caps to
  `abstain`.
- `entryForFixture` (`src/verify/calibration.ts:50-71`) has no `colorScheme`
  branch, and the shared `base` stub hardcodes `colorScheme: "light"` (`:85`), so
  fixtures would score against the stub, not their own value.
- `TIER_BY_FIELD` classifies `colorScheme` as `"soft"`
  (`src/scripts/verify-corpus.ts:101`) — the model lane. Must move.
  **Note:** after Task 2 of the ready spec, this table lives in
  `src/corpus-trust.ts`.
- The method stamp is a ternary at **two** sites (`verify-corpus.ts:528`, `:581`):
  `field === "platform" ? provableRecord(now) : confirmedRecord(imagePath, now)`.
  As written a `colorScheme` pass stamps `image-confirmed`. Replace the hardcoded
  `platform` test with a registry-derived predicate.

### Why the fill needs its own path

The verify runner cannot fill absent values. `recordedFor` returns `null` for an
entry with no `colorScheme`, and `capVerdict` downgrades a certifying `pass` to
`abstain` when `canAffirm(recorded)` is false (`runner.ts:35`). The runner verifies
claims; it does not author them. So the fill reads the detector's measurement
directly, writes only where the field is **absent**, and stamps the record the
verify lane would.

## Open design points — resolve before writing ACs

### 1. What gates the fill

Minimum: the fill imports `detectorRegistry`, refuses when
`detectorRegistry["colorScheme"].disabled` is true, and refuses when
`heldOutLock().floors["colorScheme"]` is absent. Both refusals tested.

Stronger, and probably required given the repo's standing rule that a non-null
count is never a quality measurement: the fill re-scores its own output against
the held-out labels and refuses if it disagrees with any held-out row it would
have filled. "Writes only where absent, and reports the skipped count" is a
presence metric and would pass while writing 765 wrong values.

### 2. Rollback

The fill is the only change in either spec that mutates served data, and
`git revert` does not un-write 765 values or un-stale 10 MB of
`corpus/embeddings.json`. Needs an explicit story: a pre-fill snapshot, a
reversal script, or acceptance that it is one-way. `src/scripts/restore-corpus.ts`
exists and may cover it — unverified.

### 3. Sequencing against the retag diff

The retag diff (below) scopes `colorScheme` "where present". Fill first and "where
present" grows 22 → 787, so the diff compares the model against **the detector's
own output** on 97% of the field. Either the diff runs first, or its `colorScheme`
scope is frozen to an explicit list of the 22 pre-fill ids.

## Requirements carried forward, so the deferral loses nothing

### Labels and splits

- 30 labels, split tune 15 / held-out 15. The floor is declared from held-out only;
  round 2 tuned and judged on the same rows.
- `LabelRecord` (`src/verify/calibration-cli.ts:26-36`) has no `split`. Add it as
  `?: "tune" | "held-out"`, **absent defaults to `"held-out"`** so all 82 existing
  rows keep their current meaning and the two enabled floors are unaffected.
  `:83` currently hardcodes `split: "held-out" as const`.
- `assertGate` **skips any field with no rows** — `if (!f) continue;`
  (`calibration.ts:142`). A detector shipped without labels passes the gate *by not
  being measured*. That is how five disabled detectors reached production.
- Dark-row composition must be stated as 18 light + 12 dark drawn from a native
  pool of 36, with a satisfiable stratification rule (e.g. "≥3 distinct families,
  ≥1 outside `new-products-batch`").
- **The dark-row selection is circular and must say so.** Finding 12 dark entries
  among 787 requires running a luminance measurement first — i.e. selecting the
  sample with the detector's own signal, so dark images the detector misses are
  never sampled and measured dark recall is biased upward.

### Per-class gate — four shape changes, not three

`assertGate` checks overall accuracy and `decisiveRate >= 0.4`
(`calibration.ts:143`); `CalibrationResult.byField` is
`{accuracy, decisiveRate, total, correct, decisive}` (`:44`); `CalibrationRow`
(`:32`) is `{field, id, label, verdict, correct}`.

1. `CalibrationRow` retains the row's class.
2. `byField` gains `byClass: Record<string, {total, correct, decisive}>`.
3. `DetectorEntry` gains `classBalanced?: boolean`; `colorScheme` sets it.
4. `CalibrationRow` also retains `claimSource`, and `byField` gains
   `byClaimSource` — otherwise the corpus-claim and fill groups cannot be scored
   separately, which the deviation below requires.

Must also specify: the per-class threshold, behaviour when a class is missing, and
whether decisive rate is class-gated too.

### The `tune` split needs a runner

`calibration-cli.ts:89` calls `calibrate(manifest, "held-out", …)` and
`calibration.ts:103` filters `if (fixture.split !== split) continue;`. Committing
tune rows without a command that consumes them makes the split write-only.
`calibrate-detectors` needs `--split tune|held-out` (default held-out); the tune
run prints per-threshold accuracy and does **not** call
`assertPassingCalibration`.

### Enabling `colorScheme` breaks three existing lock tests

One commit must handle all four:

- `src/verify/calibration.test.ts:60-74` — asserts `forField.length >= 4` plus a
  `pass` and a `contradicted` for every enabled certifying detector over the
  **synthetic** manifest. `colorScheme` has zero synthetic fixtures → fails on
  enable. Needs fixtures in `src/verify/__fixtures__/generate-detector-fixtures.ts`.
- `calibration.test.ts:51-57` — `expect(entry.accuracyFloor).toBe(locked.floors[field])`;
  `held-out-lock.json` has floors for `platform` and `visual.dominantColors` only.
- `calibration.test.ts:38-48` — adding synthetic fixtures changes `heldOutHash`,
  and that test's message reads "Do not update the lock to make this pass."
  Regeneration is legitimate here because the set *grows*; it is not edited to pass.
  Say so in the commit.
- `labelsHash` over **both splits** plus the declared threshold constant, with a
  canonical payload, a latest-label resolution rule (`supersedes` chains) and a
  runtime enforcement contract. Round 2's held-out-only hash left tune rows and the
  threshold mutable.

### Pixel-derived `provable` records and image staleness

`provable` records carry no `imageSha256`, and `doctor-helpers.ts:613` runs image
checks only for `image-confirmed`, with a comment asserting a `provable` record's
evidence "is the live DOM / the recorded data, not the pixels". That becomes false
for `colorScheme`. So: pixel-derived `provable` records carry `imageSha256`;
`isVerified` requires it for that set; the doctor's condition changes from
`method === "image-confirmed"` to "record carries `imageSha256`", covering both and
still exempting DOM-`measured` records; the comment is corrected in the same change.

**Declare the set as a literal in `corpus-trust.ts`, beside
`VERIFICATION_METHODS`.** That file is documented "PURE AND SYNCHRONOUS BY DESIGN
… performs no I/O" (`:10-11`) and is on the serving path
(`serving-projection.ts:12`, `server-factory.ts:43`, `create-ui-spec.ts:92`);
`detector-registry.ts:3-12` imports every detector, which reaches `sharp` via
`src/verify/ctx.ts:1`. Deriving the set from the registry would pull `sharp` onto
the serving path. Import direction is detector → trust, never the reverse. Put the
contract test in the detector layer.

Note this switch is a **no-op on today's data**: all 380 verification records in
the corpus are `image-confirmed` with `imageSha256` present; zero `measured` and
zero `provable` records exist. The `measured`-exemption test proves nothing about
the corpus and should not be mistaken for coverage.

### The label-contract deviation

`recorded` normally holds the corpus's claim. 765 entries have no `colorScheme`
claim, so those rows carry the human judgement as `recorded` with
`label: "confirmed"` — a detector agreeing scores correct, disagreeing scores
incorrect. This measures fill accuracy through the existing harness instead of
building a second one. The 22 entries with a real claim are labelled normally and
flagged `claimSource: "corpus"`. State plainly that dark accuracy is measured
against labeller-authored values, per open point 3.

### Embeddings

`src/embeddings.ts:321` reads `colorScheme`. Filling 765 changes
`entryToDocument` output for 765 entries, and `src/corpus.ts:491`
(`if (!rec.hash || rec.hash !== currentHash) contentStale += 1`) will report
765/787 content-stale until a rebuild. The rebuild is part of the fill commit, with
an assertion that `contentStale` returns to its pre-fill value.

### `labels.jsonl` carries absolute private paths

`eval/verdicts/labels.jsonl` is tracked and its 82 rows carry paths like
`/Users/…/corpus/images-private/aboard-web-screens-0-2.png`. Adding 30 more repeats
that, and `calibration-cli.ts:50` (`readFileSync(l.imagePath)`) is unguarded, so
`calibrate-detectors` throws ENOENT on any clone with a different absolute path.
Either exempt the file with a stated reason or make `imagePath` corpus-relative
through `paths.ts`; wrap `:50` so a missing image is a named refusal.

### Wiring

`src/wiring-verification.test.ts:34` excludes `src/scripts/`, so the fill script and
`retag-shadow.ts` are exempt from the built-but-unwired check. Hand-trace `main()`
in the branch review.

## Also deferred here

### `typePairing` — measure, gate only

276 entries carry `visual.typePairing.display`, 275 a `body`. **0 verification
records, 0 dataQuality findings.** Tier is `factual`
(`verify-corpus.ts:94`) — the model lane, never run against it. 23 distinct display
fonts, and `Inter` on **209 of 276 (76%)**, which resembles a model's prior more
than 276 independent identifications.

No lane can verify it: font identification from pixels is not deterministic
arithmetic, and the corpus has no DOM — 0 of 787 entries sit under
`images-private/captures/`, and the two `dom-signals.json` sidecars are referenced
by no entry. `domSignals.styles.fontFamily` is the ground truth and exists only for
future captures.

15 labels, `abstain` a legitimate label, rates over **decided** labels only with the
abstain count reported separately. The rule decides **gating only** — nulling 276
values needs a larger sample than n=15, where 8/15 spans roughly 28–79%.

Two corrections to carry:

- **`visual.typePairing` is a required object**, so if it becomes gated,
  Task 2's `stripGatedFields` will throw at init by design. Gating it therefore
  requires making the field expressible-as-absent first — a schema change, not just
  a tier edit.
- **`buildVerifyPrompt` needs no change.** `verify-corpus.ts:247-256` already has
  `const tier = tierForField(field); if (tier === "gated") continue;`, and commit
  `16fb497` touched only the tier table and its test. Gating is one table entry;
  assert the prompt no longer emits the field and `pending` (`:535`) excludes it.

### Shadow retag diff

`src/scripts/retag-shadow.ts` modelled on `src/scripts/backfill-pilot.ts` — **no
write path**, no import of `persistEntries` or `writeAtomic`. 50 entries stratified
across families, `tagImage({ extractionOnly: true })` (`tagger.ts:2828`, flag at
`:115`) so Pass 2 prose is untouched.

**The model cannot be pinned for Gemini through `tagImage`.**
`src/tagger.ts:365-369` states it: for non-OpenAI providers the
`{baseUrl, apiKey, model}` triple "are ignored — the model resolves from env",
and `extractionCfgOverride` (`:2860`) requires `provider === "openai"`. The
`modelOverride` honoured at `:2399` is reached by the C2 call path, not by
`tagImage`. So either set `GEMINI_AUTO_TAG_MODEL` in-process before the call, or
accept provider-only pinning and record the env-resolved model in the report.
Pinning the provider is still mandatory: `AUTO_TAG_PROVIDER_EXTRACTION` is
`minimax`, which failed 13 of 25 calls in the pilot.

Scope is the **populated** fields: `visual.typePairing` (276), `layout` (704),
`patternType`, `categories`, `styleTags`, and `colorScheme` where present — see
open point 3. `visual.usesShadows` (787) and `visual.accentColor` (758) are gated,
so record what the model says but flag it advisory; no lane can adjudicate the
disagreement. `components` (23) and `domainTags` (14) are near-empty — a fill, not
a retag, and part of the consensus work below.

### `claimHash` — value-bound verification records

Needed before any retag that **overwrites** existing values. The fill does not
overwrite, so it is not blocked — but the fill writes 765 `provable` records that
are byte-bound (`imageSha256`) and **not value-bound**, so a later hand-edit of a
filled `colorScheme` keeps a valid-looking record. 765 new instances of the hole
`claimHash` closes. Acceptable only with open point 1's gate in place.

Requirements when built:

- Canonical form: recursive key sort at every depth; array order preserved
  (`dominantColors` is ranked); `undefined` and absent dropped identically; `null`
  retained and distinct from absent.
- **A field→value extraction contract covering all of `SERVABLE_FIELD_KEYS`**,
  which mixes containers (`antiPatterns`) with leaves
  (`antiPatterns.accessibilityRisks`, `visual.typePairing`). `recordedFor` covers
  registry fields only and is not sufficient.
- `claimHash` and any backfill marker `.optional()`, never `.default()` (D17).
- Legacy records with no `claimHash` stay trusted — trust is revoked by evidence,
  not policy.

### Consensus fill for `components` / `domainTags`

Needs a gold set (~10 per field) first. Then: at 5.0–5.9 tags proposed per image
against 4.0 agreed, roughly 1–1.9 per image get parked — **~800–1,500 tags across
787 images** needing human adjudication. The API spend is not the cost; the queue
is. Size it before running.

### The DOM capture lane

`domSignals.styles.fontFamily` is the real answer for `typePairing` on future
entries. Needs `capture.ts` to collect sidecars and entries to live under
`images-private/captures/`.

## Out of scope permanently

- **`visual.dominantColors` independent validation.** Its 12/12 calibration result
  is true by construction — the detector re-runs the tagger's own
  `extractQuantizedColors()`. Reproducibility, not correctness. Validating it needs
  labels not derived from the same computation. The number should stop being cited
  as evidence.
- **`mood`.** No controlled vocabulary, so no value is falsifiable.
- **Prose field retag.** Pass 2 costs a second call per image (~1,574 for the full
  corpus).
- **`assertGate`'s unlabelled-field skip in general.** Refusing to enable *any*
  certifying detector with zero held-out rows is a broader change than this work.
