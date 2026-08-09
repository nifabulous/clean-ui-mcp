# Element-Box Probe — Design

**Status:** Proposed
**Date:** 2026-08-08
**Scope:** A measurement probe under `eval/element-box-probe/`. Answers one
question and builds no product. Reads corpus images, writes only to its own
output directory. No detector change, no verdict, no corpus write.

Runs alongside `2026-08-08-verifier-abstain-diagnosis-design.md` and is gated by
neither it nor its result.

## The question

> Would a box proposer produce boxes the four element-dependent detectors could
> measure **inside**?

Not "are the boxes semantically correct" (is this a card, a button, a nav?).
Only whether they are geometrically usable: does a box edge sit on a real element
edge, is there room outside it, is it a container rather than a glyph.

## Context

`docs/verifier-calibration.md` diagnoses five disabled pixel detectors into three
classes. Class A (`usesBorders`, `usesShadows`) and Class C (`spacingDensity`,
`cornerStyle`) converge on one prerequisite: measurement localised to detected
element boundaries, instead of ratios counted across the whole image. The
specific failures:

- `spacingDensity`: the connected-component pass finds **400–1400 components with
  median size 1.0–1.9px and median gap 1–4px** — it is segmenting antialiasing
  and texture, so `gapRatio` measures pixel noise. Decisive 67% of the time and
  17% accurate.
- `cornerStyle`: `consistency` is **0.000** on most real entries. The detector
  has no notion of *which* element's corners to measure.
- `usesBorders` / `usesShadows`: whole-image edge-population ratios. On a
  1200–1920px screenshot the edge population is dominated by text, so `thinRatio`
  measures typographic density.

Boxes are the missing input in all four. No threshold fixes any of them.

### Why a classical baseline is rung 1, not a footnote

The diagnosis says connected components at the **wrong scale** fail. It does not
say classical CV fails. Median component size 1.0–1.9px means the pass segmented
antialiasing — nobody has run contour or MSER extraction at container scale with
text suppression on these images. If that clears the rubric, no model is needed
and the entire dependency question is moot.

The baseline is also the reference the model rungs need. Without it, "the boxes
look plausible" is measured against nothing.

## Governing invariant

> The probe reads pixels and writes only to `eval/element-box-probe/out/`. No
> corpus read-modify-write, no detector change, no verdict, no lane.

## Probe set

All **46** distinct images in `eval/verdicts/labels.jsonl` that carry a label for
one of the four element-dependent fields. Verified: all 46 exist on disk.

Not a sample of 20. Running 46 costs the same order as 20 on a local method, it
removes a sampling decision, and it is exactly the set a follow-up measurement
would score against — so if the probe passes, the detector work can be scored
against existing labels with **zero new labelling**.

Known property of that set: no image carries more than one field's label, so
coverage is ~10–12 images per field, not 46 per field.

## Rubric

Four checks per image. All arithmetic — no eyeballing decides pass/fail.

| # | check | serves | criterion |
|---|---|---|---|
| 1 | count sanity | `spacingDensity` | `5 ≤ boxes ≤ 200` |
| 2 | boundary alignment | `usesBorders`, `cornerStyle` | ≥60% of boxes have ≥3 of 4 edges aligned |
| 3 | outside margin | `usesShadows` | ≥50% of boxes have ≥8px clear outside ≥1 edge |
| 4 | element-not-glyph | all four | median box area ≥ 0.1% of image area |

**Check 2 detail.** For each box edge, sample three lines perpendicular to it
spanning ±6px — at the edge midpoint and 10–15% from each corner — take the
maximum absolute luminance gradient along each line, and record the offset of
the maximum from the box boundary. An edge is aligned when `|offset| ≤ 3px` on
the midpoint and the corner-adjacent samples and the gradient magnitude exceeds
the image's median edge magnitude. The corner-adjacent samples are deliberate: a
box whose edges align but whose corners are shaved inward passes midpoint-only
sampling while `cornerStyle` measures background at the corners, so the corners
are part of the alignment check. Rationale: `cornerStyle` needs the corner arc
inside the crop and `usesBorders` needs a boundary ring sample to cross the
stroke — a box loose by 10px samples background on both.

> **AMENDED DURING EXECUTION (2026-08-08).** Check 2 as declared above — "the
> offset of the MAXIMUM gradient" within ±6px — measured 20.4% of edges aligned
> on real screenshots, with a degenerate offset distribution (median = p75 = p90
> = max = 5.50px, piled against the sampling window edge). Within 6px of a box
> edge a dense UI usually contains OTHER elements' edges, and `argmax` picks
> whichever is strongest rather than the box's own, so an aligned edge reads as
> misaligned.
>
> The implemented rubric asks the question this section's own sentence states:
> is there a gradient beating the noise floor AT the boundary? That measures
> 49.8% of edges. Both are on disk — `edge_offsets` carries the amended
> measurement and `edge_offsets_strongest` the pre-declared one — so the original
> verdict stays derivable from `metrics.jsonl` without a re-run.
>
> The text above is deliberately NOT rewritten: it is what was pre-registered,
> and erasing it would erase the thing that made amending it defensible. Full
> reasoning and both verdict tables in `docs/element-box-probe.md`.

**Check 3 detail.** 8px is the low end of a typical web shadow blur at 1x. A
shadow lives *outside* the boundary, so a box packed against a neighbour has its
shadow region occupied by that neighbour.

**Check 4 detail.** On a 1920×1200 image, 0.1% is ~2300px, about 48×48. A glyph
box is roughly 10×14 = 140px = 0.006%. The check separates containers from
characters.

**Boundary boxes.** Boxes touching an image edge (navbars, sidebars, full-bleed
heroes) make the ±6px sample and the outside-margin sample run off-image. The
rules, pre-declared: for check 2, the perpendicular line is clamped to the image
and the off-image portion is excluded from the gradient window (recorded as a
`boundary` flag in metrics.jsonl); for check 3, an image-boundary edge is
ineligible as the "≥1 edge" — the shadow region is outside the viewport and the
follow-up detector cannot measure it either — and a box whose edges are all at
the image boundary is excluded from check 3's denominator with a `boundary`
flag. The flags are raw metrics, so the choice stays re-judgeable.

### These thresholds are pre-declared guesses

Every number above was chosen before running anything, from the failure
magnitudes in the diagnosis. Some will be wrong.

Mitigation, and the reason it is stated here rather than discovered later: the
probe records the **raw metric distribution** for every box on every image, not
just the pass/fail. A threshold that turns out to be badly placed can be
re-judged from the committed numbers without re-running anything.

This is the direct lesson from the Class A analysis, which was corrected once and
cannot be checked a third time because its harness was discarded
(`docs/verifier-calibration.md`: "Harness was throwaway — the numbers below are
the artifact").

## The ladder

Run cheapest rung first. Stop at the first rung that passes.

1. **Classical CV.** Contour / MSER extraction at container scale with text
   suppression. Dependencies are plain Python plus one small pinned CV library
   (`opencv-python` or `scikit-image`) in `requirements.txt` — no model download
   and no external service, but the repo has no CV tooling today, so this is a
   new pinned dependency, not existing runtime.
2. **Small local VLM.** Florence-2 (`<REGION_PROPOSAL>`, `<OD>`) and Moondream 2
   detect, via a pinned `uv` venv on python3.12 (both `python3.11` and
   `python3.12` are present on this machine; the default `python3` is 3.14, which
   torch does not support).
3. **Screen parser.** A detector finetuned on interactable UI elements
   (OmniParser-style), subject to obtainability and licence.

**Pass condition for a rung:** ≥70% of the 46 images pass all four checks, AND
each of the four fields' own images (10–12 per field) pass at ≥60%. The
follow-up detector measurement is per-field, so a rung that clears the global
bar but misses one field's images is reported as failing that field rather than
passing on a global average.

**On failure, record which check failed.** That is the useful output of a failed
rung — it states what the next rung has to supply. A rung failing only check 1
(too many boxes) is a different situation from one failing check 2 (boxes not on
edges), and only the second is a reason to reach for a model.

### Expected failure mode for rung 2, stated in advance

Moondream and Florence-2 are trained on natural-image corpora. UI screenshots are
plausibly out of distribution for generic object detection, and the expected
result is boxes labelled `screen` / `text` / `monitor` rather than element-scale
boxes — which would show up as a check 1 or check 4 failure. This is a belief,
not a measurement; the probe is what turns it into one. It is written down now so
that if it happens it counts as a prediction confirmed, and if it does not the
belief is retired.

## Deliverables

Committed:

- `eval/element-box-probe/probe.py` — the runner, all rungs
- `eval/element-box-probe/requirements.txt` — pinned, `uv`-resolvable
- `eval/element-box-probe/entries.txt` — the 46 entry ids + sha256, pinned
  (image paths are resolved at runtime from `eval/verdicts/labels.jsonl`, which
  already maps entryId → imagePath; absolute machine paths are never committed)
- `eval/element-box-probe/metrics.jsonl` — one row per (method, image, box):
  `entryId`, `imageSha256`, `method`, `rung`, box `[x0,y0,x1,y1]`, and every raw
  metric behind the four checks (`boxCount`, per-edge
  `maxGradientOffset`/`maxGradientMagnitude`, `outsideClearances`,
  `boxAreaRatio`, `boundary` flags). The schema is pinned here so the
  re-judgment path parses committed rows without guessing at field names.
- `eval/element-box-probe/scores.tsv` — the 46 × 4 × N pass/fail table
- `docs/element-box-probe.md` — one page: which rung passed, which checks failed
  where, and the resulting decision

Not committed:

- `eval/element-box-probe/out/` — overlay PNGs, for local human inspection only.

**Why overlays are not committed.** They are private corpus screenshots with
boxes drawn on them. `corpus/` is excluded in `.git/info/exclude` and
`corpus/images-private/*` is gitignored — 453MB of private images that have never
entered git. Committing overlays would push that image content into the repo.
Box *coordinates* are geometry rather than pixels and carry the same exposure as
`eval/verdicts/labels.jsonl`, which already commits image paths and sha256
hashes; those are committed, the pixels are not.

`eval/*` is gitignored with an explicit allowlist, so each committed path above
needs its own `!` negation line. The existing comment at `.gitignore:64` records
that a missing negation once made `git add eval/verdicts/...` silently no-op and
nearly lost the only copy of a benchmark — so the negations are part of the work,
not an afterthought, and the plan must verify each file is actually tracked after
adding it.

## Testing

All four checks get synthetic-image unit tests, TDD with the probe: one known
element per fixture (a bordered card, a shadowed card, a glyph, a
boundary-touching box), each asserting both the pass/fail and the raw metric
values, plus one golden fixture run over a tiny committed canvas. The ladder's
pass/fail arithmetic is tested the same way. The probe's arithmetic is what
decides the rungs, and the calibration harness already demonstrated what a
throwaway measurement path costs this repo (`docs/verifier-calibration.md`:
"Harness was throwaway — the numbers below are the artifact").

## Out of scope

- No detector rewrite, no re-enabling of any disabled detector.
- No verdicts, no trust records, no corpus writes.
- No integration: no sidecar wired into the verifier, no lane, no MCP surface.
- No accuracy measurement against the labels. The probe measures whether boxes
  are *measurable in*, not whether a detector built on them would be *right*.

## Risks

1. **The rubric can rule out but not rule in.** A proposer can pass all four
   checks and a detector built on it still be inaccurate — geometric usability is
   necessary, not sufficient. Passing means "worth building the detector and
   scoring it against the 46 labels"; failing means "do not".
2. **Thresholds are guesses.** Mitigated by committing raw metrics, above.
3. **Rung 2 needs a ~1–2GB model download** and CPU inference on macOS arm64.
   Fine for 46 images; noted so it is not a surprise.
4. **Rung 3 may be unobtainable** on licence or availability grounds. If so the
   probe reports rungs 1–2 and says rung 3 was not run — it does not silently
   present a two-rung ladder as complete.
5. **`accentColor` is not covered by this rubric.** It is Class B and needs a
   role rule, not element localisation — though if a rung produces
   *interactable-element* boxes specifically, the accent is typically the primary
   button's fill and the field may come into reach. That would raise the
   addressable abstain set from 85 to 122. The probe records whether any rung
   distinguishes interactive elements, but does not test the role rule.

## Review decisions (2026-08-08)

Folded from the eng review of this spec: corner-adjacent sampling in check 2;
boundary-box rules for checks 2 and 3; the per-field pass floor (≥60% per field
alongside the global 70%); `entries.txt` pinned by entryId/sha256; the
metrics.jsonl row schema; the rung-1 dependency wording; and the synthetic-image
test plan. Thresholds remain pre-declared guesses; the raw metrics stay the
source of truth for re-judgment.
