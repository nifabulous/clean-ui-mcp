# Corpus tagging program

This is the operating contract for improving the corpus without turning model
agreement into false ground truth.

## Goals

1. **Stop new guesses.** Missing or unsupported model values stay absent; they
   do not become `dashboard`, `minimal`, fabricated colors, or an exceptional
   quality tier.
2. **Keep evidence attached.** DOM signals are image-hash bound, Pass 2 can see
   the image for new/retagged entries, and field verification survives only when
   the claim is unchanged.
3. **Govern vocabulary.** Unknown categories, styles, components, domains, and
   patterns are quarantined as candidates. They are not canonical taxonomy until
   a curator promotes them deliberately.
4. **Measure before replacing.** A shadow run is immutable and non-mutating;
   labels explicitly say `present`, `none`, or `abstain`, and every label is
   bound to the exact entry image hash.
5. **Serve supported claims only.** Drafts and unverified fields are excluded
   from trust-gated serving and trusted semantic retrieval. Rebuild the index
   after an accepted batch.
6. **Migrate in small, reversible batches.** Exact-ID promotion requires the
   original entry hash, validates the corpus schema, revokes stale verification,
   and leaves the changed entry in draft review.

## Current state

- Safety, OOV quarantine, image/DOM binding, trusted retrieval, shadow diff,
  gold scoring, and exact-ID promotion are implemented.
- `npm run retag-shadow -- --provider <provider>` produces an immutable run under
  `eval/retag-runs/`; it never writes `corpus/`. Add `--gold <labels.json>` to
  bind independent labels to image hashes and write field metrics into the run.
- `npm run retag-promote -- --run <run-dir> --decisions <decisions.json> --out <artifact.json>`
  applies only exact-ID reviewed fields to a draft output artifact. It requires
  the run's persisted `scores.json` to contain an independent gold evaluation,
  verifies candidate/image hashes again, and refuses to overwrite or write
  inside `corpus/`; installing that artifact remains a separate reviewed
  persistence action. `reviewerId` is an audit/process identity for now, not a
  cryptographic signature; signed reviewer identities remain deferred.
- `src/retag-eval.ts` is the scoring contract. It intentionally has no labels in
  the repository: model-generated labels are not silently promoted to truth.
- No corpus-wide retag is authorized until independent gold labels exist and
  the canary gates pass.
- `typePairing` remains a capture-lane field. Existing screenshot-only rows are
  structurally unfillable; future captures must persist DOM font evidence.
- New tagging computes `colorScheme` from image luminance and abstains near the
  threshold; it never falls back to the model. To measure the existing corpus
  without writing it, run `npm run color-scheme-audit -- --out
  /tmp/color-scheme-audit.json`. The report is image-hash-bound and separates
  new proposals, unchanged values, conflicts, abstentions, missing images, and
  decode errors. It records the detector version and 256px sampling bound,
  validates its runtime artifact schema, and reads the exact bytes it hashes.
  These are deterministic candidate measurements, not ground truth: the
  threshold and abstention margin still require colorScheme gold labels before
  any corpus-wide fill. Filling the existing corpus remains a separate,
  calibration-gated migration.
- Build the private human calibration packet with
  `npm run color-scheme-calibrate -- packet --audit <audit.json> --corpus
  corpus/entries.json --json <packet.json> --html <packet.html> --size 12`.
  Reviewers enter their own reviewer ID first, then label only `light`, `dark`,
  or evidence-based `abstain`. Drafts are stored per reviewer, and the packet
  page withholds the existing corpus value, the detector's prediction, and the
  measured luma so a label cannot be anchored to either source. Evaluate a
  completed submission with `color-scheme-calibrate evaluate`. The evaluator
  re-derives the cohort from the audit, so a hand-picked set of easy rows is
  refused; it binds the packet, audit, submission, and current image bytes, and
  emits `pass`, `fail`, or `insufficient` plus a `promotionEligible` flag.
  Promotion reads `promotionEligible`, not `status`: `status` honours whatever
  `--minimum-labels` and `--minimum-accuracy` the caller passed, while
  `promotionEligible` is derived against the fixed floor of 12 scored labels at
  accuracy 1. Even `promotionEligible: true` is evidence for a later reviewed
  promotion, not an automatic corpus write.
- Every calibration artifact is written in one canonical JSON form, so
  `sha256sum <packet|report>.json` reproduces the digest the artifact records
  and the provenance is checkable without this codebase.
- **First calibration run failed the detector, 2026-08-10.** Packet
  `1110270c94eb4f686e7393427a97b9f5a6ebc97ad8a2df124be9bd1f1d439ce4` (12 rows,
  audit `cd6c2ac5106224a0b4bd2e6730e9355e45227982ff76152dc2e78d38bbde13bc`),
  reviewer `Gold`: `status: fail`, `accuracy: 0.75`, 9 agreed / 3 disagreed,
  0 abstained, `promotionEligible: false`. **All three disagreements were
  detector errors, reviewed against the screenshots.** `colorScheme` fill from
  `color-scheme-v1` is blocked pending a redesigned estimator. Two failure modes:
  - *Content, not chrome.* Two light-mode iOS screens (white nav, white product
    card, indigo primary button) each carry a near-black photographic modal
    covering most of the frame. Median luma 0.00 and 1.21, classified `dark`. A
    whole-frame median grades the dominant pixels; `colorScheme` is meant to
    describe the canvas and surface theme. Not an alpha artifact: those PNGs
    carry alpha, but flattening on white or black yields identical luma, so the
    black pixels are opaque.
  - *Chromatic background, not dark neutral.* A marketing page of white text on
    saturated blue measured 91.35 and classified `dark`. Luma alone cannot
    separate a dark neutral canvas from a vivid hue.
  Both modes landed **outside** the abstention band (`|luma - 110| < 12`, so
  98-122), meaning the detector was confident and wrong rather than uncertain.
  The audit abstained 0 times across all 787 entries.
- **What that run does and does not establish.** It ranks; it does not verdict.
  Every human label was `light`, so the trivial baseline `return "light"` scores
  **12/12** on the same packet against the detector's **9/12**: the only human
  evidence in existence puts `color-scheme-v1` below a one-line constant. It
  cannot show the detector is sound either, because 12 rows deliberately
  stratified toward the hardest cases give a Wilson 95% interval of roughly
  0.47-0.92 and no dark-class labels at all. Read it as "not fit to be the field
  value", not as a measured accuracy for the corpus.
- **Consequence, shipped.** `src/tagger.ts` no longer overwrites the vision
  model's `colorScheme` with the detector's answer. The detection is still
  recorded in the run report as evidence. This matters beyond the corpus:
  `src/decision-lab.ts` lists `colorScheme` in `CITABLE_EXTRACTION_KEYS` and
  performs no `isVerified` check, so before this change the detector's answer was
  cited into synthesis prompts with no verification gate at all.
- **A field only reaches a consumer with a verification record.**
  `isVerified` (`src/corpus-trust.ts:154`) returns false without
  `provenance.verification[field]`. Of 787 entries, 22 carry a `colorScheme`
  value and **10** carry a valid record, so 10 serve it. Filling the 765 empty
  rows from detector output would therefore change nothing for any caller unless
  the migration also wrote verification records, and writing those from detector
  output is the trust laundering `src/verification-carry.ts` exists to prevent.
  That is the real reason the fill is blocked, and it is stronger than the
  accuracy argument.
- **That run also cannot speak to dark detection.** Every human label was
  `light`, so the report's confusion matrix reads
  `expectedLight {light: 9, dark: 3}, expectedDark {light: 0, dark: 0}`. A
  packet whose gold labels are single-class carries no evidence about the other
  class, and a *passing* run of the same shape would have been equally
  uninformative. Cohort strata are derived from detector luma, which cannot
  guarantee human-confirmed dark rows. Judging a replacement estimator needs a
  cohort with gold labels in both classes.
- **Those three entries are now label-contaminated.** `Alan iOS Screens 77`,
  `Alan iOS Screens 78`, and the Cowrywise mobile section have their human
  labels recorded above and must be excluded from any future blind calibration
  packet. They remain useful as named regression cases for a replacement
  estimator.
- The current full-corpus decision is recorded and corpus-hash-bound in
  [retag-disposition-v1.json](/Users/olaniyi.oladokun/Downloads/clean-ui-mcp/docs/retag-disposition-v1.json).
  Validate it with `npm run retag-disposition`; regenerate only after an
  intentional corpus change with `npm run retag-disposition -- --write`.

## Worktree workflow

Each workstream gets its own branch and worktree. Agents may work in parallel
when their file sets are independent:

```bash
git worktree add .worktrees/<name> -b codex/<name> HEAD
cd .worktrees/<name>
npm run typecheck:contracts
npx vitest run <focused-tests>
```

Before integration, review the branch diff, run the focused and contract tests,
then cherry-pick the single commit onto the integration branch. Never share a
mutable corpus write between worktrees. The canonical corpus is changed only
by an explicitly reviewed promotion batch.

## Required sequence

```text
independent gold labels
  → frozen baseline and field floors
  → deterministic colorScheme calibration packet and gate
  → immutable shadow run
  → human review / exact-ID decisions
  → 25-entry canary + restore rehearsal
  → batches with snapshot, schema check, index rebuild, doctor
  → final audit or explicit deferral
```

If a field misses its floor, keep the existing value and record the field as
deferred or fill-only. Do not lower the floor just to make a model pass.
