# Element-box probe — result

**Date:** 2026-08-08
**Spec:** `docs/superpowers/specs/2026-08-08-element-box-probe-design.md`
**Evidence:** `eval/element-box-probe/metrics.jsonl`, `eval/element-box-probe/scores.tsv`

## Verdict

**No rung passed the 70% bar.** Six proposers measured: **UIED techniques 52.2%**,
classical CV 23.9%, deki-yolo 19.6%, OmniParser 0.0%, Florence-2 0.0%,
Moondream 0.0%.

But the ladder did not merely fail — it converged on one approach and one
remaining obstacle.

**Rung 3a (UIED's techniques) is qualitatively different from the rest.** It is
the only proposer that returns containers: text-like boxes fell 96.0% → 25.5%,
median box area rose 16×, and box-level alignment doubled to 77.0%. Two of the
four fields cleared their per-field floor (`spacingDensity` 0.750, `cornerStyle`
0.667).

**Its remaining failure is a single named thing: under-detection.** All 16
`check1_count` failures are images with fewer than 5 boxes — median 7, against
the 10–60 containers a real screen has. It finds the right kind of object and
too few of them.

**And its blind spot is one field's entire subject matter.** `usesShadows` did
not move a single point (0.200 → 0.200): a white card on a white panel separated
only by a shadow has no colour discontinuity for a uniform-region method to
segment on.

Everything else fails more basically. Classical CV finds **text** (96% of boxes).
OmniParser gets the count right and the positions wrong — `check2_alignment`
failed 46/46, with 79.5% of edges having no qualifying gradient within 3px.
Florence-2 finds **page regions** (median box = 51% of the screen). Moondream
finds **one box per image**.

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

| rung | coverage | boxes/img | median area | density | text-like | boxes aligned | global |
|---|---|---|---|---|---|---|---|
| **uied (3a)** | 46/46 | 8.9 | 0.0167 | 0.098 | 25.5% | **77.0%** | **52.2%** |
| classical | 46/46 | 27.5 | 0.0010 | 0.586 | 96.0% | 38.4% | 23.9% |
| omniparser (3b) | 46/46 | 37.7 | 0.0024 | 0.232 | 71.7% | 12.3% | 0.0% |
| moondream | 4/46 | 1.0 | 0.0036 | 0.261 | 75.0% | 25.0% | 0.0% |
| florence2 | 8/46 | 1.9 | 0.5112 | 0.077 | 13.3% | 13.3% | 0.0% |

Every rung fails `check1_count`, for three different reasons. A real screen has
on the order of 10–60 containers; nothing here is close, and the two model rungs
are an order of magnitude under.

The failure modes are not variations on one theme. They bracket the target from
opposite sides — classical CV resolves too fine and keys on contrast (so it finds
glyph runs), the models resolve too coarse (so they find the page). **The thing
none of them returns is the middle: a medium-contrast, medium-size container — a
card with a light-grey border on white.** That is the entire subject matter of
`usesBorders`, `usesShadows` and `cornerStyle`.

## Rung 3a — UIED's two techniques (46/46)

Ported from [UIED](https://github.com/MulongXie/UIED) (Xie et al., Monash), not
its code: upstream pins Python 3.5 / OpenCV 3.4.2 and calls Google OCR over the
network, and the detector lane must stay local to remain an independent witness.

1. **Uniform-region segmentation** at a soft-edge threshold — Sobel magnitude > 6
   against Canny's 50 floor. Finds elements by colour CONTINUITY rather than edge
   gradient, because a card's interior is uniform even when its border is a ~10
   grey-level step.
2. **Text suppression** — discard components ≥90% covered by OCR-detected text.

A test pins the premise before the fix
(`test_rung1_provably_cannot_see_a_soft_edged_card`): rung 1 cannot find a 1px
light-grey border on off-white, and 3a can.

**This is the best proposer measured, and it changes what is found, not just the
score:**

| | rung 1 | rung 3a |
|---|---|---|
| text-like boxes | 96.0% | **25.5%** |
| median box area | 0.0010 | **0.0167** (16×, container scale) |
| median interior density | 0.586 | **0.098** (flat, not glyph runs) |
| boxes with ≥3 aligned edges | 38.4% | **77.0%** |
| global | 23.9% | **52.2%** |

`spacingDensity` 0.750 and `cornerStyle` 0.667 now clear the 60% per-field floor.
It still **fails** the 70% global bar.

### Its failure is one specific thing: under-detection

All 16 `check1_count` failures are images with FEWER than 5 boxes. Median 7 per
image, against the 10–60 containers a real screen has; zero images exceed 200.
It is no longer finding wrong things — it is finding too few right things.

### And the blind spot is exactly one field's subject matter

`usesShadows` did not move a single point, 0.200 → 0.200. A white card on a white
panel separated **only by a shadow** has no colour discontinuity, so uniform-region
segmentation merges it into the panel. Colour continuity cannot see the thing
`usesShadows` measures. The `aboard-aboard-3` overlay shows it directly: 3a finds
the outer modal container that rung 1 missed entirely, boxes zero text, and misses
the shadow-separated badge card.

## Rung 3b — OmniParser (46/46)

Only `icon_detect` (YOLOv8) is used; the captioner is irrelevant when the probe
wants boxes.

**The weights carry exactly one class: `icon`.** That confirms at the weight level
the objection raised before running — three of the four fields are about
containers, which the model was never trained to emit.

Result: **0.0% global**, and the failure is a single check.

| check | failures / 46 |
|---|---|
| check2_alignment | **46** |
| check1_count | 1 |
| check4_area | 1 |
| check3_margin | 0 |

Right number of boxes (37.7/image), wrong positions. **79.5% of its edges have no
qualifying gradient within 3px of the box at all**, and 71.7% of its boxes are
text-like — the single `icon` class fires on text runs.

This is the mAP-vs-boundary-precision risk, flagged in advance and confirmed: a
detector can score well at IoU 0.5–0.95 and still be useless for measuring a 1px
border. Detection accuracy and boundary precision are different properties.

## Rung 3c — deki-yolo (46/46)

[RasulOs/deki](https://github.com/RasulOs/deki), weights `orasul/deki-yolo`. The
only detector found with an explicit **container** class: `View`, `ImageView`,
`Text`, `Line`. Only `View` is proposed — a test asserts the class exists in the
weights, because that is the entire premise of the rung.

**Global 19.6%** — above OmniParser (0.0%), below classical (23.9%), far below
3a (52.2%). `check2_alignment` failed 36/46; `check1_count` 4; `check3`/`check4` 0.

The container class is real and it helps: edges with no qualifying gradient
within 3px fell from OmniParser's 79.5% to **47.8%**, and box-level alignment rose
12.3% → 43.1%. But **67.5% of its `View` boxes are text-like** on web screenshots.

That is the pre-declared domain-shift risk landing where it was declared. The
model card is titled "Mobile UI Element Detection Model", trained on 486 phone
screenshots with Android SDK class names. On mobile a `View` often wraps a text
block tightly; generalised to 1920×1200 web, it boxes paragraphs.

### The finding that matters: 3a and 3c are complementary

The `aboard-aboard-3` overlay shows it directly. deki finds the left panel, the
right panel, **the shadow-separated badge card that 3a is structurally blind to**,
both buttons and the avatar chip — the right objects. And its boxes are visibly
offset ~15px, with the badge card double-boxed. **Right objects, wrong
boundaries** — the exact inverse of 3a.

Measured over all 46 images (IoU ≥ 0.5 to count as the same object):

| | count |
|---|---|
| found by both | 340 |
| deki-only | 569 |
| uied-only | 144 |

But the deki-only boxes are **78% text-like**. The honest number is that deki
contributes **124 genuinely new containers** on top of uied's 304 — **+41%
container recall**, not the +63% the raw box count implies.

### The hybrid that follows

Neither rung is one tuning pass from passing, but their failures are opposite and
neither is fundamental:

| | recall (finds containers) | precision (±3px boundaries) |
|---|---|---|
| uied (3a) | under-detects — median 7/image | **77.0% aligned** |
| deki (3c) | +41% more containers, incl. shadow-separated | 43.1% aligned |

The obvious next construction is **deki for recall, 3a's gradient machinery for
precision**: take deki's candidate boxes and snap each edge to the nearest
qualifying gradient within a search window, using the `_sample_offsets` code the
rubric already contains. That is a box-refinement pass, not a retraining, and it
requires no web-labelled data.

**Not run.** It is a new proposer, and the pre-registered rule closing this line
had already fired twice by the time the evidence for it existed. It is recorded
here as the best-evidenced next step for whoever reopens the question, not as a
result.

### On making deki work for web

Two routes, in increasing cost:

1. **Box refinement** (above) — no data needed, uses code that exists.
2. **Fine-tune on web screenshots** — needs labelled container boxes on this
   corpus, which is *also* exactly what the rubric's missing recall check needs.
   One labelling effort would serve both, and it is the single artifact whose
   absence limits this probe most.

## Other screen parsers

Not run. This ladder covers classical CV, two general small VLMs, a
literature-standard hybrid, and two UI-finetuned detectors. **It is not
exhaustive** and is reported as such.

## Interactable elements and `accentColor`

**No rung distinguishes interactable elements.** Classical CV has no notion of
one — it returns contours. Florence-2 `<REGION_PROPOSAL>` returns unlabelled
regions by construction. Moondream was asked for "user interface element"
specifically and returned one untyped box per image. UIED's uniform-region pass
is unlabelled by design.

OmniParser was the strongest candidate to change this and does not: its
`icon_detect` weights carry **exactly one class, `icon`** — no interactable-vs-not
distinction at the detection stage, and 71.7% of what it emitted was text.

Consequence: the open question the diagnosis spec recorded is answered in the
negative. `accentColor` stays **Class B**, needing a role rule rather than
element localisation, and the addressable abstain set stays at **85, not 122**.
`docs/superpowers/specs/2026-08-08-verifier-abstain-diagnosis-design.md` should
be updated to close that as resolved rather than open.

## Decision

**Under the pre-registered rule, element detection closes here.** The rule fixed
before rung 3 ran was: if neither 3a nor 3b clears the rubric, the line is closed
and effort returns to corpus backfill (298 gates) and the abstain diagnosis (244
abstains). Neither cleared it. 52.2% against a 70% bar is a fail.

That rule should be honoured rather than renegotiated now that a number came in
higher than expected — "one specific fix away" is exactly what gets said before
another week is spent. What follows is the evidence for whoever revisits it, not
an argument to keep going.

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
| rung 1 fails (23.9%) | 46/46, full probe set |
| rung 3a fails (52.2%) | 46/46, full probe set |
| rung 3b fails (0.0%) | 46/46, full probe set |
| rung 2a fails (0.0%) | 8/46, bounded, printed with the verdict |
| rung 2b fails (0.0%) | 4/46, bounded, covers only 2 of 4 fields |
| other screen parsers | **not run** — the ladder is not exhaustive |

**Three of five rungs are full-set results** — classical, UIED techniques, and
OmniParser, all 46/46. Those three carry the decision. The two general-VLM rungs
are bounded samples (8/46 and 4/46), forced by cost (Florence-2 at 174s/image is
~2.2h for the full set), and both are printed by the runner as
`BOUNDED RUN: N of 46` so a bound can never read as a full result. The 4-image
Moondream bound covers only 2 of the 4 fields, which its verdict reports as
`missing_fields` rather than scoring zero.

**The ladder is not exhaustive.** It covers classical CV, two general small VLMs,
a literature-standard hybrid, and one UI-finetuned detector. Other screen parsers
exist and were not run.
