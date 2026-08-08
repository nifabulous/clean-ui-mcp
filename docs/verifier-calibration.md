# Verifier calibration — real-screenshot per-field numbers (2026-08-07)

This file is the committed evidence behind every `accuracyFloor` and `disabled`
flag in `src/verify/detector-registry.ts`. The numbers come from the CLI
(`npm run calibrate-detectors`) measured on **82 human-labelled real corpus
screenshots** — the frozen labelled ground-truth set at
`eval/verdicts/labels.jsonl`.

- Date: 2026-08-07 (run `real-calibration-2026-08-07`)
- Labeller: user (judgements made against the images only; detector code and
  output were not consulted while labelling)
- Label-file line count: 82 labels over 80 distinct screenshots (7 fields;
  ≥10 labels per field)
- Per-field contradicted counts: usesShadows 6, usesBorders 2, accentColor 5,
  cornerStyle 1, spacingDensity 0, dominantColors 0, platform 1

## Measured numbers (native resolution, the production path)

| field | n | accuracy | decisive | labels: conf/contra/abstain |
|---|---|---|---|---|
| platform | 12 | **0.917** | 1.000 | 11 / 1 / 0 |
| visual.dominantColors | 12 | **1.000** | 1.000 | 12 / 0 / 0 |
| visual.usesShadows | 10 | 0.000 | 0.100 | 4 / 6 / 0 |
| visual.usesBorders | 12 | 0.000 | 0.000 | 10 / 2 / 0 |
| visual.accentColor | 12 | 0.167 | 0.083 | 6 / 5 / 1 |
| visual.cornerStyle | 12 | 0.333 | 0.250 | 9 / 1 / 2 |
| visual.spacingDensity | 12 | 0.167 | 0.667 | 12 / 0 / 0 |

## Floors declared

Per the plan's Step 3 rule:

- real accuracy ≥ 0.9 **and** decisive ≥ 0.5 → floor `0.85`, enabled
- real accuracy ≥ 0.8 → floor `0.75`, enabled
- anything lower, or decisive < 0.4 → `disabled: true`

| field | decision | floor |
|---|---|---|
| platform | enabled | 0.85 |
| visual.dominantColors | enabled | 0.85 |
| visual.usesShadows | disabled | — |
| visual.usesBorders | disabled | — |
| visual.accentColor | disabled | — |
| visual.cornerStyle | disabled | — |
| visual.spacingDensity | disabled | — |

Disabled fields revert to the vision path (`fieldLeavesVisionForEntry`) — the
corpus keeps the model's verdict for those fields and loses nothing it has
today. The five pixel detectors stay registered (their synthetic held-out gate
still runs) but write no trust records on real entries until they are made
robust to real screenshots.

## Why the five pixel detectors measure so low

The pixel detectors were developed and tuned on 120x90 flat-color synthetic
canvases with absolute-pixel thresholds (component seams, gap bands, corner
radii, background-bucket dominance). Real corpus screenshots are full-
resolution (typically 1200-1920px wide) with photographs, gradients, text,
antialiasing, and multi-colour backgrounds:

- the detectors abstain 33-100% of the time on real images (the threshold
  conditions tuned on flat synthetic canvases rarely hold), and
- where they do decide, they are 0-33% accurate against the human labels.

Downscaling real screenshots to the synthetic scale (120-160px wide, measured
separately) does **not** rescue them: accuracy stays 0-33% for all five fields,
and one detector (usesBorders) got *worse* (it contradicted a borders-present
screenshot). The plan never specified a resolution-normalization step, so the
native-resolution numbers above are the honest measurement of the shipped
code, and production runs the same code path.

Making these detectors robust to real screenshots (scale-relative thresholds,
retuning against the label set) is follow-up work, not a floor decision.

## Measurement notes (honesty disclosures)

1. **Platform harness bug found and fixed during this task.** The CLI built
   calibration fixtures from labels without pixel dimensions, so the dims-based
   platform detector abstained on every real label (0% accuracy *and* 0%
   decisive). The CLI now reads dimensions from the labelled image files
   (`calibration-cli.ts`), and the numbers above reflect the fixed harness.
   Without the fix, the 0% would have looked like a detector failure and
   platform would have been wrongly disabled.
2. **dominantColors is 100% by construction and has 0 contradicted labels.**
   The recorded values are the extractor's own output on the same pixels
   (exact-string match in the detector), so a human labelling against the image
   can only ever confirm them; a contradiction would require the extractor to
   change. The all-confirmed label set is a real blind spot for this field and
   is recorded here rather than hidden.
3. **The plan's "≥2 contradicted per field" guard is not met for four fields**
   (cornerStyle 1, spacingDensity 0, dominantColors 0, platform 1). For the
   five disabled fields this is moot (they are no longer gated). For platform
   and dominantColors it means the enabled fields' numbers rest on thin
   negative evidence; they should gain contradicted labels before the next
   calibration round.
4. `labelledBy: "user"` — the labeller is the repo owner, not a hired or
   algorithmic annotator.
5. `npm run calibrate-detectors` now measures only the two enabled detectors —
   `calibration.ts` skips `disabled` detectors when computing stats, so the
   five disabled fields' numbers above cannot be re-derived from the CLI;
   this file is their only record until the detectors are made robust.

## Cohort run (2026-08-08)

The first representative run from the plan's Task 20 rollout sequence:
`npm run verify -- --limit 50 --detectors on` against the live corpus.
Model minimax/MiniMax-M3 (DeepSeek peak-hour routing kicked in, UTC 02:00) ·
image detail low · sampling pinned `temperature=0 seed=20260806` ·
verifier-v1. 50 entries scanned (48 fresh + 2 already processed at this
version by the warm-up smoke run).

- Verdicts: **420 pass, 18 contradicted, 306 abstain, 312 gated, 2 fail**
  (image-level only — entries with no image path).
- Zero-assertion prose fields: 12.

Per-detector rates (straight from the run report's telemetry lines):

| detector | n | pass | contradicted | abstain |
|---|---|---|---|---|
| visual.dominantColors | 48 | 47 (98%) | 1 (2%) | 0 (0%) |
| visual.colorRoles | 10 | 0 (0%) | 10 (100%) | 0 (0%) |
| platform | 48 | 0 (0%) | 0 (0%) | 48 (100%) |

**Gate check (Task 20 Step 2: stop if a calibrated field's contradiction rate
is far above its Task 13B baseline):** dominantColors 2% vs calibration 0/12 —
one finding, within noise. platform 0% contradicted — 48/48 abstained because
340/787 corpus entries carry no recorded `platform` value (the detector can
only affirm against a recorded value, platform.ts:16). Neither calibrated
field trips the gate; the run is scaled-eligible on that basis.

**Qualitative alarm (no Task 13B baseline exists for it):** the enabled
contradiction-only `visual.colorRoles` lane contradicted **10/10** recorded
palettes. Investigation (2026-08-08): 10/11 findings were the
canvas-is-largest-area rule over-firing on real screenshots — at least one
(origin-origin-4) contradicted a record whose canvas hex matches the actual
background to deltaE 0.4, and the lane was tuned on flat synthetic canvases
with no real-screenshot label set to retune against. **Resolution: the lane
is now `disabled: true` in the registry** (same honest outcome as the five
disabled pixel detectors). It stops writing findings until a real-screenshot
label set for colorRoles exists; the 11 findings already written stand as an
audit trail for triage. The remaining 8 cohort findings were vision
(critique ×2, layout ×3, styleTags, usesBorders, +1). None have been
triaged yet (dismiss/retriage are human actions; the cohort stage is
measurement). `antiPatterns.accessibilityRisks` shares the uncalibrated
status but produced no cohort findings — left enabled, flagged for the same
retune-with-labels follow-up.

**Findings and triage:** 19 `dataQuality` findings total — 11 detector
(10 colorRoles + 1 dominantColors: origin-origin-3, measured `""` vs
recorded `""` — itself a candidate detector edge case) and 8 vision
(critique ×2, layout ×3, styleTags, usesBorders, +1). None have been
triaged yet (dismiss/retriage are human actions; the cohort stage is
measurement). The 10 colorRoles findings are now attributed to the lane's
canvas rule over-firing (see above; lane disabled).

**Fields lit up:** all 50 cohort entries carry `verification` records
(48 fresh + 2 prior); every entry with a contradiction also carries
`dataQuality`. 2/50 entries failed at the image level (no image path).

**Per-entry model calls:** ≈3.2–3.4/entry, derived from verdict counts
(48 × 3 calls [verify + re-produce Pass 1 + Pass 2] + ~10 re-verify asks
for the corroboration path ≈ 154 calls); the run log does not count calls
directly. The pre-detector estimate tool projects a worst case of 4/entry,
so detector lanes do not change the per-entry call count (calls are
per-entry, not per-field) — they change which lane writes the verdict.

---

## Failure diagnosis (2026-08-08)

The "why they measure so low" section above attributed all five failures to
synthetic-vs-real scale. Running each disabled detector over the 82 real labels
and capturing the intermediate measurement — not just the verdict — shows that
is right for only two of them. There are **three distinct failure modes**, and
only one is a tuning problem.

Method: each detector run against its own labels, recording `measured`,
`confidence` and the `reason` that produced the verdict. Read-only; no corpus
writes. (Harness was throwaway — the numbers below are the artifact.)

### Class A — CORRECTED: the metric has no discriminative power

> **This section replaces an earlier, wrong analysis (same day).** The first pass
> grouped samples by LABEL and reported that `usesBorders`/`usesShadows` had real
> signal needing only a retune (11/12 and 9/10 achievable). That was an artifact:
> the physical class is `recorded` COMBINED with label — a `confirmed` on
> `recorded: false` means the feature is **absent**, and four such rows had been
> counted as "present". Regrouped correctly, the conclusion inverts.

`visual.usesBorders`, `visual.usesShadows`. **12/12 and 9/10 abstained** because
the metric landed inside the confidence band — that part stands. But the band is
not what is wrong: regrouped by physical class, the metrics barely separate the
classes at all.

| field | metric | PRESENT | ABSENT | best threshold | majority baseline |
|---|---|---|---|---|---|
| usesBorders | `thinRatio` | 0.307–0.525 (n=7) | 0.193–**0.611** (n=5) | 8/12 = **67%** | 7/12 = 58% |
| usesShadows | `rampRatio` | 0.110–0.402 (n=4) | 0.145–**0.642** (n=6) | 6/10 = **60%** | 6/10 = 60% |

In both fields the **highest metric value in the whole sample belongs to the
ABSENT class** — the metric is anti-correlated at the top end. `usesShadows`
scores exactly its majority-class baseline: the measurement adds nothing over
always answering "absent".

Precisely: the two fields are not equally dead. `usesShadows` is at baseline.
`usesBorders` beats baseline by 9 points (67% vs 58%) — which at n=12 is one or
two samples and well inside noise, so it does not justify retuning, but it is
not the same statement as "no signal". Read the heading as "no signal that this
sample can distinguish from none", and note that the composition also differs:
usesShadows' PRESENT/ABSENT counts coincide with its confirmed/contradicted
counts (4/6) while its class RANGES changed under regrouping, so its membership
changed even though its counts did not.

Why the metrics do not transfer: both are whole-image edge-population ratios. On
a 120x90 synthetic canvas containing one card, `thinRatio` really is "what
fraction of edges are the card's stroke". On a 1200-1920px screenshot the edge
population is dominated by **text**, and text strokes are thin edges — so
`thinRatio` measures typographic density, which is uncorrelated with whether
cards have borders. `rampRatio` has the same problem with antialiasing and
imagery.

**Consequence for the follow-up plan: more labels will not rescue these two.**
The proposed next step ("~10 more contradicted labels each, then retune") was
based on the wrong analysis and would have been wasted labelling effort. A
threshold cannot separate distributions that overlap this thoroughly; these need
a different measurement (border/shadow evidence localised to detected element
boundaries, not counted across the whole image), which puts them in the same
bucket as Class C.

### Class B — the rule itself is wrong for real UI

`visual.accentColor`. Not a threshold problem. Two assumptions that hold on
synthetic canvases and fail on screenshots:

1. **Area floor.** The synthetic accent button is 30x20 of 120x90 = **5.6%** of
   pixels. Real accents measured here are **0.05%–0.84%** (`matchCount/total`:
   332/2304000 … 19423/2304000). Four labels failed as "present but below the
   area floor".
2. **Maximality.** The detector requires the accent to be the largest
   non-background colour cluster. On a real screenshot it almost never is — body
   text, chrome, and imagery all cover more pixels. Four more failed as "present
   but another colour is larger — role unconfirmed".

The maximality rule was added during spec review (to stop mere presence being
read as "this is the accent"). The reasoning was sound — presence is not role —
but the rule it produced does not describe real interfaces. Replacing it needs a
different role signal (e.g. saturation against a desaturated field, or
concentration in interactive-sized clusters), not a lower bar.

### Class C — segmentation finds noise, so the metric is meaningless

`visual.spacingDensity`, `visual.cornerStyle`. These are the ones that answer
confidently and wrongly, which is worse than abstaining.

- **spacingDensity**: on real screenshots the connected-component pass finds
  ~400–1400 components with **median size 1.0–1.9 px and median gap 1–4 px**. It
  is segmenting antialiasing and texture, not UI elements, so `gapRatio`
  (≈0.707 = 1px gap / 1.41px "element") measures pixel noise. That is why it is
  decisive 67% of the time and 17% accurate — the number is real arithmetic over
  meaningless inputs.
- **cornerStyle**: `consistency` is **0.000** on most real entries — the four
  corners of whatever region it measured disagree completely. The detector has no
  notion of *which* element's corners to measure; a synthetic canvas had exactly
  one card, a real screenshot has dozens of rounded things.

Neither is fixable by tuning. Both need actual element detection before any
corner or gap measurement means anything.

### What this changes

- "Scale-relative thresholds" help **nothing**. Class A's metrics do not separate
  the classes at any threshold; Class B needs a new rule; Class C needs element
  detection.
- **Class A and Class C need element-localised measurement**, not tuning — four
  of the five detectors. They converge on the same prerequisite: find the UI
  elements first, then measure their borders / shadows / corners / gaps.
  Whole-image ratios are measuring text and texture. **Class B is the exception:**
  `accentColor` needs a new ROLE rule, and the candidate named in its own section
  (saturation against a desaturated field) is a whole-image statistic that does
  not require element detection. Do not fold it into the same prerequisite —
  though note element detection is not *excluded* for it either: the accent is
  typically the primary button's fill, so a detector that finds interactable
  elements could resolve the role question more directly than a saturation rule.
  Which of the two is right for Class B is open.
- No further labelling is warranted until a detector exists whose metric shows
  separation on the labels already collected.
- Class C detectors are the most dangerous of the five: they are the only ones
  that were confidently wrong rather than silent, and `spacingDensity` was the
  one field whose detector the plan predicted would "self-limit" via abstention.
  It did not — it decided, and it was wrong.
