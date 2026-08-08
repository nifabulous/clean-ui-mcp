# Element-box probe — result

**Date:** 2026-08-08
**Spec:** `docs/superpowers/specs/2026-08-08-element-box-probe-design.md`
**Evidence:** `eval/element-box-probe/metrics.jsonl`, `eval/element-box-probe/scores.tsv`

## Verdict

**No rung passed.** Classical CV 23.9%, Florence-2 0.0%, Moondream 0.0%, against
a 70% global bar. Rung 3 was not run.

The three fail in different directions, and that is the useful part. Classical CV
finds **text runs** (27.5 boxes/image, interior density 0.586); Florence-2 finds
**page regions** (1.9 boxes/image, median area 51% of the screen); Moondream
finds **one arbitrary element** (1.0 box/image). None returns the thing the
detectors need — a medium-contrast, medium-size container.

Rung 1's shortfall in particular is not a tuning gap: 96% of the boxes it
proposes are text runs, and 93.4% of the boxes the rubric counted as *aligned*
are text runs. It passes what it passes for the wrong reason.

## Probe set

46 images, the full set in `eval/verdicts/labels.jsonl` carrying a label for one
of the four element-dependent fields. Per-field: cornerStyle 12, spacingDensity
12, usesBorders 12, usesShadows 10. Zero images `MISSING` — the denominator is
the full 46 on every run.

## Rung 1 — classical CV

`propose_classical`: Canny(50,150), a 5×5 morphological close, external contours,
then boxes at least 40×20 and under 95% of the canvas.

### What it got right

The count problem the diagnosis blamed is **solved**. Median 20 boxes per image
(min 1, max 106), against the 400–1400 components of median size 1.0–1.9px that
made `spacingDensity` measure pixel noise. `check1_count` failed 3 of 46;
`check3_margin` failed 0 of 46.

That is a real finding: the existing detector's segmentation failure was about
scale, and closing edges at container scale before filtering fixes it.

### What it got wrong

| check | failures / 46 |
|---|---|
| check2_alignment | 32 |
| check4_area | 19 |
| check1_count | 3 |
| check3_margin | 0 |

Global 23.9% (11/46). Per field: usesBorders 0.167, usesShadows 0.200,
cornerStyle 0.250, spacingDensity 0.333. Both bars missed (70% global, 60% per
field), every field.

### The finding the numbers hid

`interior_edge_density` — recorded, never checked — measures the fraction of a
box's interior sitting on a gradient above the image's noise floor. A flat card
reads near 0; a text run reads high. Over rung 1's 1265 boxes:

| | share |
|---|---|
| text-like (density > 0.15) | **96.0%** |
| flat / container-like | 4.0% |
| median interior density | 0.586 |
| of boxes counted ALIGNED, share text-like | **93.4%** |

The overlays show the mechanism directly. On the best-scoring image (0.92
aligned, all four checks passed) the boxes sit on "Your", "product", "story,",
"minutes." — the morphological close merges each word's glyphs into a blob, and
display type at ~60px clears the 40×20 floor easily. `check4_area` cannot catch
it: "minutes." is roughly 200×60 = 0.5% of a 1920×1200 image, five times the
0.001 floor.

On a failing image, both cards — the modal container and the badge card — were
missed entirely. Their edges are soft light grey on white and Canny at 50/150
never fires on them, while "Let's", "choose", "an", "avatar" all got boxes.

The pattern is the inverse of what the detectors need: **high-contrast small
things found, low-contrast large things missed.** `usesBorders`, `usesShadows`
and `cornerStyle` are entirely about the second category.

## A stated limit of the rubric: there is no recall check

All four checks are precision-flavoured. They ask whether the boxes a proposer
returned are geometrically clean; none asks whether the containers were found. A
proposer returning nothing but word-boxes can score well, because a word's
bounding box genuinely does sit on strong luminance edges.

This is the spec's "the rubric can rule out but not rule in" made concrete, and
it is stronger than the spec anticipated: the rubric cannot rule in *even when
the numbers are good*. Any successor to this probe needs a recall term — a
labelled set of container boxes to measure against — not a fifth precision check.

`interior_edge_density` is recorded rather than promoted to a check for the same
reason the check-2 amendment records both measurements: the rubric was
pre-declared, and adding a fifth gate after seeing the data would be
indistinguishable from tuning.

## Amendment: check 2 (2026-08-08)

The spec pre-declared "the offset of the **maximum** gradient" within ±6px of a
box edge. Against real screenshots that measured 20.4% of edges aligned with a
degenerate offset distribution — median = p75 = p90 = **max** = 5.50px, a pile-up
at the sampling window's edge rather than a distribution. Within 6px of any box
edge a dense UI usually contains *other* elements' edges, and `argmax` picks
whichever is strongest rather than the box's own.

Amended to the question check 2's own sentence asks: is there a gradient beating
the image's noise floor **at** the boundary? Measured on identical boxes, 49.8%
of edges versus 20.4%.

| | pre-registered (A) | amended (B) |
|---|---|---|
| global | 2.2% (1/46) | 23.9% (11/46) |
| usesBorders | 0.000 | 0.167 |
| usesShadows | 0.000 | 0.200 |
| cornerStyle | 0.083 | 0.250 |
| spacingDensity | 0.000 | 0.333 |
| check2 failures | 45 | 32 |

Both are on disk: `edge_offsets` carries the amended measurement,
`edge_offsets_strongest` the pre-declared one, so the original verdict stays
derivable from `metrics.jsonl` without re-running. The amendment could not flip
the verdict — it improved the number 11× and rung 1 still fails both bars — which
is what makes it safe to have applied after seeing the data.

**check 4 was NOT amended.** Its 0.001 floor is ~48×48 on a 1920×1200 image, a
real button and 17× a glyph; the definition is sound. The data simply straddles
it (median area ratio per image 0.00108), so it decides 19 images on a near-tie.
That is a fact about this proposer's output, not a threshold to move.

## Rung 2 — small local VLMs

Both map their output onto the same `Box` contract rung 1 returns, so the rubric
is identical across rungs.

### Florence-2 `<REGION_PROPOSAL>`

**BOUNDED RUN: 8 of 46 images.** 174s per image on CPU, so the full set is ~2.2
hours to confirm what the first image already showed. The bound is printed with
the verdict by the runner, and `--limit` exists so it cannot be applied silently.

Global 0.0%. `check1_count` failed **8/8**: 15 boxes over 8 images, 1.9 per
image, against a `MIN_BOXES` floor of 5. Area ratios: 0.995, 0.995, 0.995, 0.995,
0.996, 0.511, 0.494, 0.348, 0.259, 0.192, 0.096, 0.02, 0.002 — the whole screen,
occasionally half of it.

`check4_area` failed **0/8**, which is worth stating plainly: an area floor
designed to reject glyphs is passed effortlessly by a box covering the entire
screen. The check is not wrong; it is one-sided.

### The two rungs fail in opposite directions

`interior_edge_density` separates them cleanly:

| rung | median interior density | what it returns |
|---|---|---|
| classical | 0.586 | text runs — high-contrast, small |
| florence2 | 0.077 | page regions — low-contrast, huge |

Neither returns containers. The gap is precisely in the middle of the two failure
modes: **medium-contrast, medium-size UI containers** — a card whose border is
light grey on white. Classical CV cannot see its edge; Florence-2 does not
resolve below page level.

### Moondream `detect("user interface element")`

**BOUNDED RUN: 4 of 46 images.** Global 0.0%. `check1_count` failed **4/4**:
exactly **one box per image**, area ratios 0.0006, 0.0015, 0.0057, 0.515.

The verdict reports `missing_fields: [visual.usesShadows, visual.spacingDensity]`
rather than scoring them 0.0 — the 4-image bound only covered `usesBorders` and
`cornerStyle`, and a field with zero rows is missing, not failed. **This bound is
too small to be a per-field result** and is not presented as one.

Two operational notes, recorded because a proposer that silently returned `[]`
would be indistinguishable from a model that found nothing:

1. The first attempt died on a Hugging Face CDN error mid-download. Transient
   network failure, not a model outcome.
2. The second died at inference: `torch.cat(): all input tensors must be on the
   same device. Received cpu and mps:0`. moondream2's remote `vision.py` installs,
   at import time, an MPS workaround that returns pooled tensors on `mps`
   unconditionally — it assumes the model is on MPS, and ours is on CPU. Fixed by
   reporting MPS unavailable before the remote module imports (`proposers.py`,
   `_moondream`). The numbers above are from the third, working run.

## All three rungs, side by side

| rung | coverage | boxes/image | median area | median interior density | what it returns |
|---|---|---|---|---|---|
| classical | 46/46 | 27.5 | 0.0010 | **0.586** | text runs |
| florence2 | 8/46 | 1.9 | 0.5112 | **0.077** | page regions |
| moondream | 4/46 | 1.0 | 0.0036 | **0.261** | one arbitrary element |

Every rung fails `check1_count`, for three different reasons. A real screen has
on the order of 10–60 containers; nothing here is close, and the two model rungs
are an order of magnitude under.

The failure modes are not variations on one theme. They bracket the target from
opposite sides — classical CV resolves too fine and keys on contrast (so it finds
glyph runs), the models resolve too coarse (so they find the page). **The thing
none of them returns is the middle: a medium-contrast, medium-size container — a
card with a light-grey border on white.** That is the entire subject matter of
`usesBorders`, `usesShadows` and `cornerStyle`.

## Rung 3 — screen parser

Not run. The spec makes it conditional on obtainability and licence, which could
not be resolved before rungs 1–2 reported. **This is a two-rung ladder, not a
complete one**, and is reported as such rather than presented as exhaustive.

## Interactable elements and `accentColor`

**No rung distinguishes interactable elements.** Classical CV has no notion of
one — it returns contours. Florence-2 `<REGION_PROPOSAL>` returns unlabelled
regions by construction. Moondream was asked for "user interface element"
specifically and returned one untyped box per image.

Consequence: the open question the diagnosis spec recorded is answered in the
negative. `accentColor` stays **Class B**, needing a role rule rather than
element localisation, and the addressable abstain set stays at **85, not 122**.
`docs/superpowers/specs/2026-08-08-verifier-abstain-diagnosis-design.md` should
be updated to close that as resolved rather than open.

## Decision

**Do not build element-localised detectors on any of these proposers.** The spec
is explicit that failing means "do not"; three rungs failed, two of them by an
order of magnitude on box count alone.

What this does and does not establish:

- **It does establish** that the four disabled pixel detectors cannot be rescued
  by any box proposer tried here. `docs/verifier-calibration.md` says Class A and
  Class C "need element-localised measurement, not tuning". That prerequisite is
  not currently satisfiable with off-the-shelf classical CV or a small
  natural-image VLM.
- **It does not establish** that element detection is impossible. It rules out
  three specific proposers, and it names the gap precisely: soft-edged,
  medium-size containers. A UI-finetuned detector (the rung-3 screen parser,
  never obtained) targets exactly that gap and remains untested.
- **It does not rule anything in.** The rubric measures whether boxes are
  geometrically measurable-in, not whether a detector built on them would be
  accurate. Even a passing rung would only have meant "worth building the
  detector and scoring it against the 46 labels".

The strategic reading, for whoever picks this up: the original recommendation
holds and is now better evidenced. Element detection was the third-ranked lever
behind corpus backfill (298 gates) and the model-lane abstain diagnosis (244
abstains). This probe cost a day and moved it further down, not up — the
prerequisite it depends on is harder than "find the elements", it is "find the
elements to ±3px, including the ones with almost no contrast".

## Honest coverage summary

| claim | evidence |
|---|---|
| rung 1 fails | 46/46 images, full probe set |
| rung 2a fails | 8/46, bounded, printed with the verdict |
| rung 2b fails | 4/46, bounded, and covers only 2 of 4 fields |
| rung 3 | **not run** — obtainability and licence unresolved |

This is a **two-rung ladder, not a complete one**, and the model rungs are
bounded samples rather than full-set results. Both bounds were forced by cost
(Florence-2 at 174s/image is ~2.2h for the full set) and both are printed by the
runner with `BOUNDED RUN: N of 46`. The rung-1 result, which carries the load of
the decision, is the full 46.
