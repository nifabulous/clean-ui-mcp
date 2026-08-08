# Element-Box Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Find out whether any box proposer produces boxes the four element-dependent detectors could measure inside, cheapest method first, and stop at the first one that works.

**Architecture:** A standalone Python probe under `eval/element-box-probe/`. One module proposes boxes (three interchangeable methods behind one function signature), one module scores boxes against four arithmetic checks, one runner joins them over a pinned image set and emits per-box raw metrics plus a pass/fail table. Nothing imports the TypeScript codebase and nothing writes to the corpus. The rungs are run in order and the ladder stops at the first pass.

**Tech Stack:** Python 3.12 via `uv`, Pillow + NumPy for pixel access, OpenCV for rung 1, PyTorch + Transformers for rung 2 (rung-2 dependencies are a separate extras file, so rung 1 needs no model stack). Tests with pytest.

## Global Constraints

Copied verbatim from `docs/superpowers/specs/2026-08-08-element-box-probe-design.md`.

- **Governing invariant:** the probe reads pixels and writes only to `eval/element-box-probe/out/`. No corpus read-modify-write, no detector change, no verdict, no lane.
- Probe set is all **46** distinct images in `eval/verdicts/labels.jsonl` carrying a label for one of the four element-dependent fields (`visual.usesBorders`, `visual.usesShadows`, `visual.cornerStyle`, `visual.spacingDensity`).
- **Rubric, four checks per image:** (1) `5 ≤ boxes ≤ 200`; (2) ≥60% of boxes have ≥3 of 4 edges aligned; (3) ≥50% of boxes have ≥8px clear outside ≥1 edge; (4) median box area ≥ 0.1% of image area.
- **Check 2 sampling:** three perpendicular lines per edge spanning ±6px — at the edge midpoint and at 10–15% in from each corner. An edge is aligned when `|offset| ≤ 3px` on the midpoint **and** the corner-adjacent samples, and the gradient magnitude exceeds the image's median edge magnitude.
- **Boundary boxes:** for check 2 the perpendicular line is clamped to the image and the off-image portion is excluded from the gradient window, recorded as a `boundary` flag. For check 3 an image-boundary edge is ineligible as the "≥1 edge", and a box whose edges are all at the image boundary is excluded from check 3's denominator with a `boundary` flag.
- **Rung pass condition:** ≥70% of the 46 images pass all four checks, **and** each of the four fields' own images pass at ≥60%. A rung clearing the global bar but missing one field is reported as failing that field.
- Thresholds are pre-declared guesses. The probe records the **raw metric distribution** for every box on every image so a badly-placed threshold is re-judgeable from committed numbers without a re-run.
- Overlay PNGs are **not committed** — they are private corpus screenshots. Box coordinates are.
- `eval/*` is gitignored with an explicit allowlist; each committed path needs its own `!` negation, and each must be verified as actually tracked after adding.
- TDD: failing test first, then implementation, then commit. Every task.
- Review artifact after every task, before the next commit (`CLAUDE.md`). The git hook blocks otherwise.

### The TypeScript suite is deliberately not run on this branch

This branch adds Python and one `.gitignore` block. It compiles no TypeScript and imports nothing from `src/`, so `npm test` measures nothing about it. Its gate is `pytest` over `eval/element-box-probe/tests/`.

Recorded so the omission is a decision rather than a gap: `npm test` is **not green at this branch point** either — 3 failed files of 164 on `fb055fa` (`src/mcp-smoke.test.ts` stale-build, `src/tagger.test.ts:1042` Gemini thinking-config drift, `src/readiness/tracked-artifacts-readiness.test.ts:435`/`:468` corpus-hash-mismatch). If a reviewer runs the TS suite here anyway, those three are the pre-existing baseline, not this branch's doing.

---

## File Structure

| file | responsibility |
|---|---|
| `eval/element-box-probe/README.md` | how to run it, what the outputs mean |
| `eval/element-box-probe/requirements.txt` | rung-1 dependencies, pinned |
| `eval/element-box-probe/requirements-rung2.txt` | rung-2 model stack, pinned, separate so rung 1 never pulls torch |
| `eval/element-box-probe/pytest.ini` | registers the `slow` marker so rung-2 model tests stay out of the default suite |
| `eval/element-box-probe/entries.txt` | the 46 `entryId<TAB>imageSha256` rows, pinned |
| `eval/element-box-probe/build_entries.py` | regenerates `entries.txt` from `labels.jsonl` |
| `eval/element-box-probe/proposers.py` | box proposers — one signature, three implementations |
| `eval/element-box-probe/rubric.py` | the four checks and the per-box raw metrics |
| `eval/element-box-probe/run_probe.py` | the runner: resolve images, propose, score, emit |
| `eval/element-box-probe/tests/test_rubric.py` | synthetic-fixture tests for all four checks |
| `eval/element-box-probe/tests/test_run_probe.py` | ladder arithmetic and output-shape tests |
| `eval/element-box-probe/tests/fixtures.py` | synthetic canvas builders |
| `docs/element-box-probe.md` | the result: which rung passed, which checks failed where, the decision |

`proposers.py` and `rubric.py` are split because they are the two independently-testable halves: the rubric is pure geometry over an image plus a box list and can be tested against synthetic canvases with known answers, while a proposer is an integration point with an external library. Keeping them apart means rung 2's dependency never enters the rubric's test path.

---

### Task 1: Scaffold, dependency split, and the gitignore negations

Nothing measures yet. This task exists because the gitignore negations are the single riskiest mechanical step in the probe and doing them last means discovering at the end that the artifacts were never tracked.

**Files:**
- Create: `eval/element-box-probe/README.md`, `requirements.txt`, `requirements-rung2.txt`, `tests/__init__.py`
- Modify: `.gitignore`

**Interfaces:**
- Produces: a runnable venv and a tracked directory. No code consumed by later tasks.

- [ ] **Step 1: Create the directory, the requirements files, and pytest.ini**

```bash
mkdir -p eval/element-box-probe/tests
```

`eval/element-box-probe/requirements.txt`:

```
# Rung 1 only. Deliberately excludes the model stack so the classical baseline
# can run with no torch download — see requirements-rung2.txt.
numpy==2.1.3
pillow==11.0.0
opencv-python-headless==4.10.0.84
pytest==8.3.4
```

`eval/element-box-probe/requirements-rung2.txt`:

```
# Rung 2 only. Layered ON TOP of requirements.txt, never instead of it.
-r requirements.txt
torch==2.5.1
transformers==4.46.3
einops==0.8.0
timm==1.0.11
```

`eval/element-box-probe/pytest.ini`:

```
[pytest]
markers =
    slow: rung-2 model tests that load weights; excluded from the default suite
```

- [ ] **Step 2: Create the venv and install rung-1 dependencies**

```bash
cd eval/element-box-probe
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.txt
.venv/bin/python -c "import cv2, numpy, PIL; print('rung1 ok')"
```

Expected: `rung1 ok`.

The system `python3` is 3.14, which torch does not support. `--python 3.12` is not optional.

- [ ] **Step 3: Add the gitignore negations**

Append to `.gitignore`, immediately after the existing `eval/` allowlist block (around `:90`):

```
# Element-box probe (docs/superpowers/specs/2026-08-08-element-box-probe-design.md).
# Sources, pinned inputs and NUMERIC outputs are tracked; `out/` is not — it holds
# overlay renders of private corpus screenshots, and corpus/images-private/* has
# never entered git.
!eval/element-box-probe/
eval/element-box-probe/*
!eval/element-box-probe/README.md
!eval/element-box-probe/requirements.txt
!eval/element-box-probe/requirements-rung2.txt
!eval/element-box-probe/pytest.ini
!eval/element-box-probe/entries.txt
!eval/element-box-probe/build_entries.py
!eval/element-box-probe/proposers.py
!eval/element-box-probe/rubric.py
!eval/element-box-probe/run_probe.py
!eval/element-box-probe/metrics.jsonl
!eval/element-box-probe/scores.tsv
!eval/element-box-probe/tests/
eval/element-box-probe/tests/*
!eval/element-box-probe/tests/*.py
```

`.venv/` and `out/` are covered by the `eval/element-box-probe/*` line and have no negation, which is the intent.

- [ ] **Step 4: Prove each intended path is actually tracked, and each excluded one is not**

```bash
touch eval/element-box-probe/{entries.txt,build_entries.py,proposers.py,rubric.py,run_probe.py,metrics.jsonl,scores.tsv}
touch eval/element-box-probe/tests/test_rubric.py
mkdir -p eval/element-box-probe/out && touch eval/element-box-probe/out/dummy.png
for f in README.md requirements.txt requirements-rung2.txt pytest.ini entries.txt build_entries.py proposers.py rubric.py run_probe.py metrics.jsonl scores.tsv tests/test_rubric.py; do
  git check-ignore -q "eval/element-box-probe/$f" && echo "IGNORED (BAD): $f" || echo "tracked ok: $f"
done
git check-ignore -q eval/element-box-probe/out/dummy.png && echo "out/ ignored ok" || echo "out/ TRACKED (BAD)"
git check-ignore -q eval/element-box-probe/.venv && echo ".venv ignored ok" || echo ".venv TRACKED (BAD)"
rm eval/element-box-probe/out/dummy.png
```

Expected: eleven `tracked ok` lines, `out/ ignored ok`, `.venv ignored ok`. Any `BAD` line means a negation is missing or ordered wrong — fix it before continuing. `.gitignore:64` records that a missing negation once made `git add eval/verdicts/...` silently no-op and nearly lost the only copy of a benchmark.

- [ ] **Step 5: Confirm the check is not being masked by local-only state**

```bash
git check-ignore -v eval/element-box-probe/entries.txt || echo "not ignored (correct)"
git check-ignore -v corpus/images-private
```

Expected: the first prints nothing (or `not ignored (correct)`); the second names `.gitignore`, not `.git/info/exclude`. `.git/info/exclude` carries a blanket `corpus` on this machine that does **not** travel to a fresh clone — if a rule you rely on resolves to `info/exclude`, it does not exist for anyone else.

- [ ] **Step 6: Write the README**

`eval/element-box-probe/README.md`:

```markdown
# Element-box probe

Answers one question: would a box proposer produce boxes the four
element-dependent detectors (`visual.usesBorders`, `visual.usesShadows`,
`visual.cornerStyle`, `visual.spacingDensity`) could measure *inside*?

Not "are the boxes semantically correct". Only whether they are geometrically
usable. Design: `docs/superpowers/specs/2026-08-08-element-box-probe-design.md`.

## Run

    uv venv --python 3.12 .venv
    uv pip install --python .venv/bin/python -r requirements.txt
    .venv/bin/python run_probe.py --rung 1

Rung 2 additionally needs `-r requirements-rung2.txt` (~1-2GB of model weights).

## Outputs

| path | tracked | contents |
|---|---|---|
| `metrics.jsonl` | yes | one row per (method, image, box) — coordinates, every raw metric, and the runId that produced it |
| `scores.tsv` | yes | per (method, image) the four check results |
| `out/` | **no** | overlay PNGs, local inspection only |

`out/` is untracked because overlays are private corpus screenshots with boxes
drawn on them. Coordinates are geometry, not pixels, and carry the same exposure
as `eval/verdicts/labels.jsonl`, which already commits paths and hashes.

## Thresholds

Pre-declared guesses, from the failure magnitudes in
`docs/verifier-calibration.md`. `metrics.jsonl` holds the raw distributions, so a
badly-placed threshold can be re-judged without re-running anything.
```

- [ ] **Step 7: Commit**

```bash
git add .gitignore eval/element-box-probe/README.md eval/element-box-probe/requirements.txt eval/element-box-probe/requirements-rung2.txt eval/element-box-probe/pytest.ini
git status --porcelain eval/element-box-probe/
git commit -m "chore(probe): scaffold the element-box probe with tracked-artifact negations

eval/* is gitignored with an explicit allowlist, so every committed probe path
needs its own negation line. Doing this first rather than last: .gitignore:64
records that a missing negation once made \`git add eval/verdicts/...\` silently
no-op and nearly lost the only copy of a benchmark.

Rung-2 dependencies are a separate requirements file so the classical baseline
runs with no torch download. out/ and .venv/ are deliberately left ignored —
overlays are private corpus screenshots."
```

`git status --porcelain` before the commit must list the four files as added. If a file is missing from that list, the negation did not take.

- [ ] **Step 8: Write the task review artifact**

```bash
.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
  --base-sha $(git rev-parse HEAD^) --head-sha $(git rev-parse HEAD) \
  --branch feat/element-box-probe
```

---

### Task 2: Pin the probe set

**Files:**
- Create: `eval/element-box-probe/build_entries.py`, `eval/element-box-probe/entries.txt`
- Test: `eval/element-box-probe/tests/test_entries.py`

**Interfaces:**
- Produces:
  - `ELEMENT_FIELDS: tuple[str, ...]` — the four field names
  - `build_entries(labels_path: Path) -> list[tuple[str, str, str]]` — `(entryId, imageSha256, field)` rows, sorted by `entryId`, deduplicated on `entryId`
  - `entries.txt` — TSV, `entryId<TAB>imageSha256<TAB>field`, no header

Absolute machine paths are never committed. `entries.txt` pins ids and hashes; `run_probe.py` (Task 5) resolves paths from `labels.jsonl` at runtime.

- [ ] **Step 1: Write the failing test**

`eval/element-box-probe/tests/test_entries.py`:

```python
import json
from pathlib import Path

from build_entries import ELEMENT_FIELDS, build_entries


def test_selects_only_element_dependent_fields(tmp_path: Path) -> None:
    labels = tmp_path / "labels.jsonl"
    labels.write_text("\n".join(json.dumps(row) for row in [
        {"entryId": "a", "imagePath": "/x/a.png", "imageSha256": "aa", "field": "visual.usesBorders"},
        {"entryId": "b", "imagePath": "/x/b.png", "imageSha256": "bb", "field": "visual.accentColor"},
        {"entryId": "c", "imagePath": "/x/c.png", "imageSha256": "cc", "field": "visual.cornerStyle"},
    ]) + "\n")
    rows = build_entries(labels)
    assert [r[0] for r in rows] == ["a", "c"]


def test_deduplicates_on_entry_id_keeping_the_first_field(tmp_path: Path) -> None:
    labels = tmp_path / "labels.jsonl"
    labels.write_text("\n".join(json.dumps(row) for row in [
        {"entryId": "a", "imagePath": "/x/a.png", "imageSha256": "aa", "field": "visual.usesBorders"},
        {"entryId": "a", "imagePath": "/x/a.png", "imageSha256": "aa", "field": "visual.usesShadows"},
    ]) + "\n")
    rows = build_entries(labels)
    assert len(rows) == 1
    assert rows[0] == ("a", "aa", "visual.usesBorders")


def test_output_is_sorted_by_entry_id(tmp_path: Path) -> None:
    labels = tmp_path / "labels.jsonl"
    labels.write_text("\n".join(json.dumps(row) for row in [
        {"entryId": "z", "imagePath": "/x/z.png", "imageSha256": "zz", "field": "visual.usesBorders"},
        {"entryId": "a", "imagePath": "/x/a.png", "imageSha256": "aa", "field": "visual.usesBorders"},
    ]) + "\n")
    assert [r[0] for r in build_entries(labels)] == ["a", "z"]


def test_the_four_element_fields_are_exactly_these() -> None:
    assert set(ELEMENT_FIELDS) == {
        "visual.usesBorders", "visual.usesShadows",
        "visual.cornerStyle", "visual.spacingDensity",
    }
```

- [ ] **Step 2: Run to verify it fails**

```bash
cd eval/element-box-probe && .venv/bin/python -m pytest tests/test_entries.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'build_entries'`.

- [ ] **Step 3: Implement `build_entries.py`**

```python
"""Pin the probe set from the frozen label file.

Committed as `entries.txt` (entryId + sha256 only). Image paths in
labels.jsonl are absolute machine paths and are never committed; run_probe.py
resolves them at runtime.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ELEMENT_FIELDS: tuple[str, ...] = (
    "visual.usesBorders",
    "visual.usesShadows",
    "visual.cornerStyle",
    "visual.spacingDensity",
)


def build_entries(labels_path: Path) -> list[tuple[str, str, str]]:
    """(entryId, imageSha256, field) for each distinct entry with an element label."""
    seen: dict[str, tuple[str, str, str]] = {}
    for line in labels_path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row["field"] not in ELEMENT_FIELDS:
            continue
        if row["entryId"] in seen:
            continue
        seen[row["entryId"]] = (row["entryId"], row["imageSha256"], row["field"])
    return [seen[k] for k in sorted(seen)]


if __name__ == "__main__":
    repo_root = Path(__file__).resolve().parents[2]
    rows = build_entries(repo_root / "eval" / "verdicts" / "labels.jsonl")
    out = Path(__file__).with_name("entries.txt")
    out.write_text("".join(f"{a}\t{b}\t{c}\n" for a, b, c in rows))
    print(f"wrote {len(rows)} entries to {out}", file=sys.stderr)
```

- [ ] **Step 4: Run the tests**

```bash
.venv/bin/python -m pytest tests/test_entries.py -v
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Generate `entries.txt` and check the count**

```bash
.venv/bin/python build_entries.py
wc -l entries.txt
cut -f3 entries.txt | sort | uniq -c
```

Expected: **46** lines. The per-field counts should total 46 with roughly 10–12 each.

If the count is not 46, stop and report the actual number rather than adjusting the spec to match. The spec's 46 was measured on 2026-08-08; a different number means `labels.jsonl` changed, and every per-field floor in the rubric was sized against 10–12 images per field.

- [ ] **Step 6: Commit**

```bash
git add eval/element-box-probe/build_entries.py eval/element-box-probe/entries.txt eval/element-box-probe/tests/test_entries.py
git status --porcelain eval/element-box-probe/
git commit -m "feat(probe): pin the 46-image probe set from the frozen labels

Ids and sha256 only. labels.jsonl carries absolute machine paths; committing
those would break on any other checkout, so run_probe.py resolves paths at
runtime and entries.txt pins identity.

Deduplicated on entryId: no image in the label set carries more than one
element-field label, so the field column records which field each image was
labelled for, and the per-field pass floors are computed against it."
```

- [ ] **Step 7: Write the task review artifact**

```bash
.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
  --base-sha $(git rev-parse HEAD^) --head-sha $(git rev-parse HEAD) \
  --branch feat/element-box-probe
```

---

### Task 3: The rubric — four checks over synthetic fixtures

The largest task, and the one carrying the probe's whole claim to being arithmetic rather than eyeballed. It runs on synthetic canvases with known answers; no corpus image is read.

**Files:**
- Create: `eval/element-box-probe/rubric.py`, `eval/element-box-probe/tests/fixtures.py`, `eval/element-box-probe/tests/test_rubric.py`

**Interfaces:**
- Produces:
  - `Box = tuple[int, int, int, int]` — `(x0, y0, x1, y1)`, half-open on `x1`/`y1`
  - `@dataclass BoxMetrics` — `box`, `edge_offsets: list[float | None]`, `edge_magnitudes: list[float]`, `edges_aligned: int`, `outside_clearances: list[float | None]`, `max_clearance: float`, `area_ratio: float`, `boundary_edges: list[bool]`, `all_edges_boundary: bool`
  - `@dataclass ImageScore` — `check1_count`, `check2_alignment`, `check3_margin`, `check4_area`, each `bool`; plus `box_count: int`, `aligned_fraction: float`, `clear_fraction: float`, `median_area_ratio: float`
  - `measure_boxes(gray: np.ndarray, boxes: list[Box]) -> list[BoxMetrics]`
  - `score_image(gray: np.ndarray, boxes: list[Box]) -> tuple[ImageScore, list[BoxMetrics]]`
  - Constants: `MIN_BOXES = 5`, `MAX_BOXES = 200`, `ALIGN_TOLERANCE_PX = 3`, `ALIGN_SAMPLE_SPAN_PX = 6`, `MIN_ALIGNED_EDGES = 3`, `ALIGNED_BOX_FRACTION = 0.60`, `MIN_CLEARANCE_PX = 8`, `CLEAR_BOX_FRACTION = 0.50`, `MIN_MEDIAN_AREA_RATIO = 0.001`, `CORNER_INSET_FRACTION = 0.125`

- [ ] **Step 1: Write the fixtures**

`eval/element-box-probe/tests/fixtures.py`:

```python
"""Synthetic canvases with known geometry. No corpus image is ever read here."""
from __future__ import annotations

import numpy as np


def blank(w: int = 400, h: int = 300, value: int = 240) -> np.ndarray:
    return np.full((h, w), value, dtype=np.uint8)


def with_rect(gray: np.ndarray, x0: int, y0: int, x1: int, y1: int, value: int = 40) -> np.ndarray:
    """Filled rectangle with a hard edge — the alignment check's ideal case."""
    out = gray.copy()
    out[y0:y1, x0:x1] = value
    return out


def with_stroked_rect(gray: np.ndarray, x0: int, y0: int, x1: int, y1: int,
                      value: int = 40, width: int = 2) -> np.ndarray:
    """Hollow rectangle — a bordered card, filled with the canvas colour."""
    out = gray.copy()
    out[y0:y1, x0:x0 + width] = value
    out[y0:y1, x1 - width:x1] = value
    out[y0:y0 + width, x0:x1] = value
    out[y1 - width:y1, x0:x1] = value
    return out
```

- [ ] **Step 2: Write the failing tests**

`eval/element-box-probe/tests/test_rubric.py`:

```python
from __future__ import annotations

import numpy as np
import pytest

from tests.fixtures import blank, with_rect, with_stroked_rect
from rubric import (
    ALIGN_TOLERANCE_PX, MAX_BOXES, MIN_BOXES,
    measure_boxes, score_image,
)


def test_check1_rejects_too_few_boxes() -> None:
    gray = blank()
    score, _ = score_image(gray, [(10, 10, 60, 60)] * (MIN_BOXES - 1))
    assert score.check1_count is False


def test_check1_rejects_too_many_boxes() -> None:
    gray = blank()
    score, _ = score_image(gray, [(10, 10, 20, 20)] * (MAX_BOXES + 1))
    assert score.check1_count is False


def test_check1_accepts_a_plausible_count() -> None:
    gray = blank()
    score, _ = score_image(gray, [(10, 10, 60, 60)] * 20)
    assert score.check1_count is True


def test_a_box_exactly_on_a_hard_edge_aligns_on_all_four_edges() -> None:
    gray = with_rect(blank(), 100, 80, 200, 160)
    [m] = measure_boxes(gray, [(100, 80, 200, 160)])
    assert m.edges_aligned == 4
    assert all(o is not None and abs(o) <= ALIGN_TOLERANCE_PX for o in m.edge_offsets)


def test_a_box_loose_by_ten_pixels_aligns_on_no_edge() -> None:
    gray = with_rect(blank(), 100, 80, 200, 160)
    [m] = measure_boxes(gray, [(90, 70, 210, 170)])
    assert m.edges_aligned == 0


def test_a_stroked_card_aligns_the_same_as_a_filled_one() -> None:
    # usesBorders needs the boundary ring to cross the stroke; a hollow rect
    # must not read as unaligned just because its interior matches the canvas.
    gray = with_stroked_rect(blank(), 100, 80, 200, 160)
    [m] = measure_boxes(gray, [(100, 80, 200, 160)])
    assert m.edges_aligned == 4


def test_corners_shaved_inward_fail_alignment_even_when_midpoints_align() -> None:
    # An L-shaped element: the box's edge midpoints sit on real edges, but the
    # top-right corner region is background. cornerStyle would measure nothing
    # there, so the corner-adjacent samples must catch it.
    gray = with_rect(blank(), 100, 80, 200, 160)
    gray[80:110, 170:200] = 240  # knock out the top-right corner
    [m] = measure_boxes(gray, [(100, 80, 200, 160)])
    assert m.edges_aligned < 4


def test_check2_needs_sixty_percent_of_boxes_aligned() -> None:
    gray = with_rect(blank(), 100, 80, 200, 160)
    aligned = (100, 80, 200, 160)
    loose = (10, 10, 90, 70)  # empty canvas region, no edge to find
    score, _ = score_image(gray, [aligned] * 6 + [loose] * 4)
    assert score.aligned_fraction == pytest.approx(0.6)
    assert score.check2_alignment is True

    score, _ = score_image(gray, [aligned] * 5 + [loose] * 5)
    assert score.check2_alignment is False


def test_an_isolated_box_has_clearance_on_every_side() -> None:
    gray = blank()
    [m] = measure_boxes(gray, [(100, 80, 200, 160)])
    assert m.max_clearance >= 8


def test_two_boxes_four_pixels_apart_have_no_clearance_on_the_shared_side() -> None:
    gray = blank(w=400, h=300)
    metrics = measure_boxes(gray, [(100, 80, 200, 160), (204, 80, 300, 160)])
    # left box's RIGHT clearance is 4px, below the 8px floor
    assert metrics[0].outside_clearances[2] == pytest.approx(4)


def test_a_box_flush_against_the_image_edge_marks_that_edge_boundary() -> None:
    gray = blank(w=400, h=300)
    [m] = measure_boxes(gray, [(0, 0, 100, 100)])
    assert m.boundary_edges[0] is True   # left
    assert m.boundary_edges[1] is True   # top
    assert m.boundary_edges[2] is False  # right
    assert m.all_edges_boundary is False


def test_a_full_bleed_box_is_excluded_from_check3_denominator() -> None:
    gray = blank(w=400, h=300)
    full_bleed = (0, 0, 400, 300)
    isolated = (100, 100, 200, 200)
    score, metrics = score_image(gray, [full_bleed] + [isolated] * 9)
    assert metrics[0].all_edges_boundary is True
    # 9 eligible boxes, all clear -> 1.0, NOT 9/10
    assert score.clear_fraction == pytest.approx(1.0)


def test_check4_rejects_glyph_scale_boxes() -> None:
    gray = blank(w=1920, h=1200)
    glyph = (10, 10, 20, 24)  # 140px of 2_304_000 = 0.006%
    score, _ = score_image(gray, [glyph] * 20)
    assert score.check4_area is False


def test_check4_accepts_container_scale_boxes() -> None:
    gray = blank(w=1920, h=1200)
    container = (10, 10, 110, 110)  # 10_000px = 0.43%
    score, _ = score_image(gray, [container] * 20)
    assert score.check4_area is True


def test_metrics_are_recorded_even_when_a_check_fails() -> None:
    # The raw distribution is the re-judgment path; a failing check must not
    # short-circuit its own measurement.
    gray = with_rect(blank(), 100, 80, 200, 160)
    [m] = measure_boxes(gray, [(90, 70, 210, 170)])
    assert m.edges_aligned == 0
    assert len(m.edge_offsets) == 4
    assert len(m.edge_magnitudes) == 4
    assert m.area_ratio > 0
```

- [ ] **Step 3: Run to verify they fail**

```bash
.venv/bin/python -m pytest tests/test_rubric.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'rubric'`.

- [ ] **Step 4: Implement `rubric.py`**

```python
"""The four checks, and the raw metrics behind them.

Thresholds are PRE-DECLARED GUESSES sized from the failure magnitudes in
docs/verifier-calibration.md. Every raw number is recorded per box so a
badly-placed threshold is re-judgeable from committed output without a re-run.
"""
from __future__ import annotations

import statistics
from dataclasses import dataclass, field as dc_field

import numpy as np

Box = tuple[int, int, int, int]  # (x0, y0, x1, y1), half-open on x1/y1

MIN_BOXES = 5
MAX_BOXES = 200
ALIGN_TOLERANCE_PX = 3
ALIGN_SAMPLE_SPAN_PX = 6
MIN_ALIGNED_EDGES = 3
ALIGNED_BOX_FRACTION = 0.60
MIN_CLEARANCE_PX = 8
CLEAR_BOX_FRACTION = 0.50
MIN_MEDIAN_AREA_RATIO = 0.001
CORNER_INSET_FRACTION = 0.125  # midpoint of the spec's 10-15% band

# Edge order is fixed everywhere: left, top, right, bottom.
EDGE_NAMES = ("left", "top", "right", "bottom")


@dataclass
class BoxMetrics:
    box: Box
    edge_offsets: list[float | None] = dc_field(default_factory=list)
    edge_magnitudes: list[float] = dc_field(default_factory=list)
    edges_aligned: int = 0
    outside_clearances: list[float | None] = dc_field(default_factory=list)
    max_clearance: float = 0.0
    area_ratio: float = 0.0
    boundary_edges: list[bool] = dc_field(default_factory=list)
    all_edges_boundary: bool = False


@dataclass
class ImageScore:
    box_count: int
    aligned_fraction: float
    clear_fraction: float
    median_area_ratio: float
    check1_count: bool
    check2_alignment: bool
    check3_margin: bool
    check4_area: bool


def _median_edge_magnitude(gray: np.ndarray) -> float:
    """The image's own noise floor: a gradient must beat this to count."""
    gx = np.abs(np.diff(gray.astype(np.float64), axis=1))
    gy = np.abs(np.diff(gray.astype(np.float64), axis=0))
    return float(np.median(np.concatenate([gx.ravel(), gy.ravel()])))


def _sample_offsets(gray: np.ndarray, edge_index: int, box: Box) -> tuple[list[float | None], float, bool]:
    """Three perpendicular samples per edge: midpoint and both corner-adjacent.

    Returns (offsets, max magnitude across samples, whether the edge is clamped
    by the image boundary). An offset is the distance from the box boundary to
    the strongest gradient along the sample line, positive OUTWARD.
    """
    x0, y0, x1, y1 = box
    h, w = gray.shape
    horizontal = edge_index in (1, 3)  # top / bottom
    length = (x1 - x0) if horizontal else (y1 - y0)
    inset = max(1, int(round(length * CORNER_INSET_FRACTION)))
    if horizontal:
        positions = [x0 + inset, (x0 + x1) // 2, x1 - inset]
        edge_coord = y0 if edge_index == 1 else y1 - 1
    else:
        positions = [y0 + inset, (y0 + y1) // 2, y1 - inset]
        edge_coord = x0 if edge_index == 0 else x1 - 1

    lo = edge_coord - ALIGN_SAMPLE_SPAN_PX
    hi = edge_coord + ALIGN_SAMPLE_SPAN_PX + 1
    limit = h if horizontal else w
    clamped_lo, clamped_hi = max(0, lo), min(limit, hi)
    boundary = clamped_lo != lo or clamped_hi != hi

    offsets: list[float | None] = []
    magnitudes: list[float] = []
    for p in positions:
        p = int(np.clip(p, 0, (w - 1) if horizontal else (h - 1)))
        line = gray[clamped_lo:clamped_hi, p] if horizontal else gray[p, clamped_lo:clamped_hi]
        if line.size < 2:
            offsets.append(None)
            magnitudes.append(0.0)
            continue
        grad = np.abs(np.diff(line.astype(np.float64)))
        idx = int(np.argmax(grad))
        # +0.5: a diff at index i sits BETWEEN samples i and i+1.
        offsets.append(float(clamped_lo + idx + 0.5 - edge_coord))
        magnitudes.append(float(grad[idx]))
    return offsets, (max(magnitudes) if magnitudes else 0.0), boundary


def _clearances(box: Box, others: list[Box], shape: tuple[int, int]) -> list[float | None]:
    """Distance from each edge to the nearest other box on that side.

    An image-boundary edge is INELIGIBLE (None): the shadow region is outside
    the viewport, so the follow-up detector could not measure it either.
    """
    x0, y0, x1, y1 = box
    h, w = shape
    at_boundary = (x0 <= 0, y0 <= 0, x1 >= w, y1 >= h)
    best: list[float] = [float(x0), float(y0), float(w - x1), float(h - y1)]
    for ox0, oy0, ox1, oy1 in others:
        vertical_overlap = not (oy1 <= y0 or oy0 >= y1)
        horizontal_overlap = not (ox1 <= x0 or ox0 >= x1)
        if vertical_overlap and ox1 <= x0:
            best[0] = min(best[0], float(x0 - ox1))
        if vertical_overlap and ox0 >= x1:
            best[2] = min(best[2], float(ox0 - x1))
        if horizontal_overlap and oy1 <= y0:
            best[1] = min(best[1], float(y0 - oy1))
        if horizontal_overlap and oy0 >= y1:
            best[3] = min(best[3], float(oy0 - y1))
    return [None if at_boundary[i] else best[i] for i in range(4)]


def measure_boxes(gray: np.ndarray, boxes: list[Box]) -> list[BoxMetrics]:
    h, w = gray.shape
    image_area = float(h * w)
    noise_floor = _median_edge_magnitude(gray)
    out: list[BoxMetrics] = []
    for i, box in enumerate(boxes):
        m = BoxMetrics(box=box)
        for edge_index in range(4):
            offsets, magnitude, boundary = _sample_offsets(gray, edge_index, box)
            # The edge's recorded offset is the WORST of the three samples: a box
            # whose midpoint aligns but whose corners are shaved is not aligned.
            usable = [o for o in offsets if o is not None]
            worst = max(usable, key=abs) if usable else None
            m.edge_offsets.append(worst)
            m.edge_magnitudes.append(magnitude)
            m.boundary_edges.append(boundary)
            aligned = (
                worst is not None
                and abs(worst) <= ALIGN_TOLERANCE_PX
                and magnitude > noise_floor
                and all(o is not None and abs(o) <= ALIGN_TOLERANCE_PX for o in offsets)
            )
            if aligned:
                m.edges_aligned += 1
        x0, y0, x1, y1 = box
        m.all_edges_boundary = x0 <= 0 and y0 <= 0 and x1 >= w and y1 >= h
        m.outside_clearances = _clearances(box, [b for j, b in enumerate(boxes) if j != i], (h, w))
        eligible = [c for c in m.outside_clearances if c is not None]
        m.max_clearance = max(eligible) if eligible else 0.0
        m.area_ratio = ((x1 - x0) * (y1 - y0)) / image_area
        out.append(m)
    return out


def score_image(gray: np.ndarray, boxes: list[Box]) -> tuple[ImageScore, list[BoxMetrics]]:
    metrics = measure_boxes(gray, boxes)
    n = len(boxes)

    aligned = sum(1 for m in metrics if m.edges_aligned >= MIN_ALIGNED_EDGES)
    aligned_fraction = (aligned / n) if n else 0.0

    # Full-bleed boxes leave check 3's denominator: every edge is off-viewport.
    eligible = [m for m in metrics if not m.all_edges_boundary]
    clear = sum(1 for m in eligible if m.max_clearance >= MIN_CLEARANCE_PX)
    clear_fraction = (clear / len(eligible)) if eligible else 0.0

    median_area = statistics.median([m.area_ratio for m in metrics]) if metrics else 0.0

    return ImageScore(
        box_count=n,
        aligned_fraction=aligned_fraction,
        clear_fraction=clear_fraction,
        median_area_ratio=median_area,
        check1_count=MIN_BOXES <= n <= MAX_BOXES,
        check2_alignment=aligned_fraction >= ALIGNED_BOX_FRACTION,
        check3_margin=clear_fraction >= CLEAR_BOX_FRACTION,
        check4_area=median_area >= MIN_MEDIAN_AREA_RATIO,
    ), metrics
```

- [ ] **Step 5: Run the tests**

```bash
.venv/bin/python -m pytest tests/test_rubric.py -v
```

Expected: PASS, 15 tests.

If `test_a_stroked_card_aligns_the_same_as_a_filled_one` fails, the gradient window is finding the stroke's inner edge rather than its outer one — widen the assertion to accept an offset within the stroke width, and record the stroke width in `metrics.jsonl`. Do **not** loosen `ALIGN_TOLERANCE_PX`; that would silently weaken the check for every box.

- [ ] **Step 6: Commit**

```bash
git add eval/element-box-probe/rubric.py eval/element-box-probe/tests/
git commit -m "feat(probe): the four rubric checks with raw per-box metrics

Pass/fail is arithmetic, not eyeballed. Every raw number behind a check is
recorded per box so a pre-declared threshold that turns out badly placed can be
re-judged from committed output — the Class A analysis was corrected once and
cannot be checked a third time because its harness was discarded.

Two rules that only matter on real screenshots are tested against synthetic
fixtures: an edge is aligned only when the corner-adjacent samples align too (a
box whose midpoints sit on edges but whose corners are shaved would pass
midpoint-only sampling while cornerStyle measures background), and a full-bleed
box leaves check 3's denominator rather than counting as a failure, because its
shadow region is outside the viewport."
```

- [ ] **Step 7: Write the task review artifact**

```bash
.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
  --base-sha $(git rev-parse HEAD^) --head-sha $(git rev-parse HEAD) \
  --branch feat/element-box-probe
```

---

### Task 4: Rung 1 — the classical proposer

**Files:**
- Create: `eval/element-box-probe/proposers.py`, `eval/element-box-probe/tests/test_proposers.py`

**Interfaces:**
- Produces:
  - `Proposer = Callable[[np.ndarray], list[Box]]` — takes greyscale, returns boxes
  - `propose_classical(gray: np.ndarray) -> list[Box]`
  - `PROPOSERS: dict[str, Proposer]` keyed `"classical"` (rungs 2–3 register here in Task 6)

- [ ] **Step 1: Write the failing tests**

`eval/element-box-probe/tests/test_proposers.py`:

```python
from __future__ import annotations

from tests.fixtures import blank, with_stroked_rect
from proposers import PROPOSERS, propose_classical


def test_finds_a_single_stroked_card() -> None:
    gray = with_stroked_rect(blank(w=400, h=300), 100, 80, 300, 220)
    boxes = propose_classical(gray)
    assert len(boxes) >= 1
    x0, y0, x1, y1 = max(boxes, key=lambda b: (b[2] - b[0]) * (b[3] - b[1]))
    assert abs(x0 - 100) <= 3 and abs(y0 - 80) <= 3
    assert abs(x1 - 300) <= 3 and abs(y1 - 220) <= 3


def test_suppresses_text_scale_components() -> None:
    # Twelve glyph-sized marks plus one card. Text suppression must keep the
    # card and drop the glyphs: the current detector's failure is 400-1400
    # components of median size 1.0-1.9px.
    gray = with_stroked_rect(blank(w=400, h=300), 100, 80, 300, 220)
    for i in range(12):
        gray[250:262, 10 + i * 14: 20 + i * 14] = 30
    boxes = propose_classical(gray)
    assert len(boxes) <= 4


def test_returns_no_boxes_on_a_blank_canvas() -> None:
    assert propose_classical(blank()) == []


def test_registry_exposes_the_classical_proposer() -> None:
    assert PROPOSERS["classical"] is propose_classical
```

- [ ] **Step 2: Run to verify they fail**

```bash
.venv/bin/python -m pytest tests/test_proposers.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'proposers'`.

- [ ] **Step 3: Implement `propose_classical`**

```python
"""Box proposers. One signature, one entry per rung.

Rung 1 is classical CV and is deliberately first: docs/verifier-calibration.md
blames component SCALE (median component 1.0-1.9px means the pass segmented
antialiasing), not classical CV as a technique. If rung 1 clears the rubric, no
model is needed and the dependency question does not arise.
"""
from __future__ import annotations

from typing import Callable

import cv2
import numpy as np

Box = tuple[int, int, int, int]
Proposer = Callable[[np.ndarray], list[Box]]

# Container scale, not glyph scale. A body glyph is ~10x14px; the smallest UI
# container worth measuring (a chip, a small button) is ~40x20.
MIN_BOX_W = 40
MIN_BOX_H = 20
MAX_AREA_FRACTION = 0.95  # a box covering the whole canvas is the canvas


def propose_classical(gray: np.ndarray) -> list[Box]:
    """Contour extraction at container scale, with text-scale components removed."""
    h, w = gray.shape
    # A morphological close at container scale merges glyph runs into blobs that
    # the size filter then drops, instead of emitting one box per character.
    edges = cv2.Canny(gray, 50, 150)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, kernel)
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

    boxes: list[Box] = []
    for contour in contours:
        x, y, bw, bh = cv2.boundingRect(contour)
        if bw < MIN_BOX_W or bh < MIN_BOX_H:
            continue
        if (bw * bh) / float(w * h) > MAX_AREA_FRACTION:
            continue
        boxes.append((x, y, x + bw, y + bh))
    return boxes


PROPOSERS: dict[str, Proposer] = {"classical": propose_classical}
```

- [ ] **Step 4: Run the tests**

```bash
.venv/bin/python -m pytest tests/test_proposers.py -v
```

Expected: PASS, 4 tests.

`test_finds_a_single_stroked_card` may return a box offset by 1–2px — Canny fires on the stroke, and `boundingRect` covers the stroke's outer extent. The ±3px tolerance is deliberately the same as `ALIGN_TOLERANCE_PX`. If the offset exceeds 3px, the proposer is systematically off and the constant to change is in `propose_classical`, not in the rubric.

- [ ] **Step 5: Commit**

```bash
git add eval/element-box-probe/proposers.py eval/element-box-probe/tests/test_proposers.py
git commit -m "feat(probe): rung 1, contour extraction at container scale

The diagnosis blames component scale, not classical CV: median component size of
1.0-1.9px means the existing pass segmented antialiasing. This one closes edges
at container scale first so glyph runs merge into blobs the size filter drops,
then keeps only boxes at least 40x20 — a body glyph is about 10x14.

Rung 1 exists to possibly make rungs 2-3 unnecessary, and to be the reference
they are judged against. Without it, 'the boxes look plausible' compares to
nothing."
```

- [ ] **Step 6: Write the task review artifact**

```bash
.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
  --base-sha $(git rev-parse HEAD^) --head-sha $(git rev-parse HEAD) \
  --branch feat/element-box-probe
```

---

### Task 5: The runner, the ladder arithmetic, and rung 1's result

**Files:**
- Create: `eval/element-box-probe/run_probe.py`, `eval/element-box-probe/tests/test_run_probe.py`
- Create (generated): `eval/element-box-probe/metrics.jsonl`, `eval/element-box-probe/scores.tsv`

**Interfaces:**
- Consumes: `build_entries.ELEMENT_FIELDS`, `rubric.score_image`, `proposers.PROPOSERS`.
- Produces:
  - `resolve_image_paths(labels_path: Path) -> dict[str, tuple[Path, str]]` — `entryId -> (path, sha256)`
  - `rung_verdict(scores: list[tuple[str, str, ImageScore]]) -> RungVerdict` — `(entryId, field, score)` rows in, verdict out
  - `@dataclass RungVerdict` — `passed: bool`, `global_fraction: float`, `by_field: dict[str, float]`, `failing_checks: dict[str, int]`, `missing_fields: list[str]`
  - `format_metrics_row(run_id, entry_id, sha, field, method, m) -> str` and `format_scores_row(run_id, method, entry_id, field, s) -> str` — the pinned output schemas, pure so tests can target them
  - `render_overlay(gray, boxes, out_path)` — draws boxes onto out/ PNGs when `--overlays` is passed

- [ ] **Step 1: Write the failing tests for the ladder arithmetic**

`eval/element-box-probe/tests/test_run_probe.py`:

```python
from __future__ import annotations

import json

import pytest

from rubric import ImageScore
from run_probe import format_metrics_row, format_scores_row, rung_verdict

FIELDS = ("visual.usesBorders", "visual.usesShadows", "visual.cornerStyle", "visual.spacingDensity")


def _score(ok: bool) -> ImageScore:
    return ImageScore(
        box_count=20, aligned_fraction=1.0 if ok else 0.0, clear_fraction=1.0 if ok else 0.0,
        median_area_ratio=0.01 if ok else 0.0,
        check1_count=True, check2_alignment=ok, check3_margin=ok, check4_area=ok,
    )


def _rows(per_field_ok: dict[str, int], per_field_total: int = 10):
    rows = []
    for f in FIELDS:
        if f not in per_field_ok:
            continue  # a field with no rows exercises the missing-field path
        ok = per_field_ok[f]
        for i in range(per_field_total):
            rows.append((f"{f}-{i}", f, _score(i < ok)))
    return rows


def test_a_rung_passes_only_above_both_bars() -> None:
    v = rung_verdict(_rows({f: 8 for f in FIELDS}))
    assert v.global_fraction == pytest.approx(0.8)
    assert v.passed is True


def test_a_rung_below_the_global_bar_fails() -> None:
    v = rung_verdict(_rows({f: 6 for f in FIELDS}))
    assert v.global_fraction == pytest.approx(0.6)
    assert v.passed is False


def test_a_rung_clearing_the_global_bar_but_missing_one_field_fails() -> None:
    # 9,9,9,4 of 10 -> global 0.775 (over 0.70) but one field at 0.40.
    ok = {f: 9 for f in FIELDS}
    ok["visual.cornerStyle"] = 4
    v = rung_verdict(_rows(ok))
    assert v.global_fraction > 0.70
    assert v.by_field["visual.cornerStyle"] == pytest.approx(0.4)
    assert v.passed is False


def test_the_verdict_names_which_checks_failed_and_how_often() -> None:
    rows = _rows({f: 0 for f in FIELDS})
    v = rung_verdict(rows)
    assert v.failing_checks["check2_alignment"] == 40
    assert v.failing_checks["check1_count"] == 0


def test_an_empty_row_set_fails_rather_than_dividing_by_zero() -> None:
    v = rung_verdict([])
    assert v.passed is False
    assert v.global_fraction == 0.0
    assert v.missing_fields == list(FIELDS)


def test_a_field_with_no_rows_is_reported_missing_not_failed() -> None:
    ok = {f: 8 for f in FIELDS if f != "visual.cornerStyle"}
    v = rung_verdict(_rows(ok))
    assert v.missing_fields == ["visual.cornerStyle"]
    assert v.passed is False
    assert "visual.cornerStyle" not in v.by_field


def test_metrics_row_shape_has_run_id_and_all_box_fields() -> None:
    from rubric import BoxMetrics
    row = json.loads(format_metrics_row(
        "run-1", "e1", "aa", "visual.usesBorders", "classical",
        BoxMetrics(box=(0, 0, 10, 10)),
    ))
    assert row["runId"] == "run-1"
    assert row["entryId"] == "e1"
    assert set(row) >= {"box", "edge_offsets", "edge_magnitudes",
                        "outside_clearances", "area_ratio", "boundary_edges"}


def test_scores_row_keeps_rung_first_and_run_id_last() -> None:
    s = _score(True)
    row = format_scores_row("run-1", "classical", "e1", "visual.usesBorders", s).split("\t")
    assert row[0] == "classical"  # Task 7's `cut -f1 | uniq -c` grouping depends on this
    assert row[-1] == "run-1"
    assert len(row) == 12
```

- [ ] **Step 2: Run to verify they fail**

```bash
.venv/bin/python -m pytest tests/test_run_probe.py -v
```

Expected: FAIL — `ModuleNotFoundError: No module named 'run_probe'`.

- [ ] **Step 3: Implement `run_probe.py`**

```python
"""Run a rung over the pinned probe set and emit raw metrics plus a score table.

Reads corpus images. Writes ONLY to this directory (metrics.jsonl, scores.tsv)
and to out/ (overlays, untracked). Never touches the corpus.

Every row carries a runId so re-running a rung appends a distinguishable row set
instead of silently duplicating the previous run's numbers.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass, field as dc_field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from build_entries import ELEMENT_FIELDS
from proposers import PROPOSERS
from rubric import BoxMetrics, ImageScore, score_image

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
GLOBAL_PASS_FRACTION = 0.70
PER_FIELD_PASS_FRACTION = 0.60
CHECK_NAMES = ("check1_count", "check2_alignment", "check3_margin", "check4_area")


@dataclass
class RungVerdict:
    passed: bool
    global_fraction: float
    by_field: dict[str, float] = dc_field(default_factory=dict)
    failing_checks: dict[str, int] = dc_field(default_factory=dict)
    missing_fields: list[str] = dc_field(default_factory=list)


def rung_verdict(scores: list[tuple[str, str, ImageScore]]) -> RungVerdict:
    """A rung passes only above BOTH bars, with every field present.

    The per-field floor exists because the follow-up detector measurement is
    per-field: a rung that clears the global bar while missing one field's
    images is reported as failing that field, not as passing on average. A field
    with ZERO rows is missing, not failed at 0.0: the two have different causes
    (no labelled images vs a proposer that missed every one).
    """
    if not scores:
        return RungVerdict(passed=False, global_fraction=0.0, missing_fields=list(ELEMENT_FIELDS))

    def all_ok(s: ImageScore) -> bool:
        return all(getattr(s, name) for name in CHECK_NAMES)

    global_fraction = sum(1 for _, _, s in scores if all_ok(s)) / len(scores)

    by_field: dict[str, float] = {}
    missing_fields: list[str] = []
    for f in ELEMENT_FIELDS:
        rows = [s for _, field_name, s in scores if field_name == f]
        if not rows:
            missing_fields.append(f)
            continue
        by_field[f] = (sum(1 for s in rows if all_ok(s)) / len(rows))

    failing_checks = {
        name: sum(1 for _, _, s in scores if not getattr(s, name)) for name in CHECK_NAMES
    }

    passed = (
        not missing_fields
        and
        global_fraction >= GLOBAL_PASS_FRACTION
        and all(v >= PER_FIELD_PASS_FRACTION for v in by_field.values())
    )
    return RungVerdict(passed, global_fraction, by_field, failing_checks, missing_fields)


def format_metrics_row(run_id: str, entry_id: str, sha: str, field_name: str,
                       method: str, m: BoxMetrics) -> str:
    """One metrics.jsonl row. The schema is pinned here so re-judgment parses
    committed rows without guessing — see the spec's review decisions."""
    return json.dumps({
        "runId": run_id, "entryId": entry_id, "imageSha256": sha, "field": field_name,
        "method": method, **asdict(m),
    })


def format_scores_row(run_id: str, method: str, entry_id: str, field_name: str,
                      s: ImageScore) -> str:
    """One scores.tsv row. Column 1 is deliberately the rung: Task 7's
    `cut -f1 | sort | uniq -c` groups by rung. runId is the LAST column."""
    return "\t".join([
        method, entry_id, field_name,
        *(str(getattr(s, n)) for n in CHECK_NAMES),
        f"{s.box_count}", f"{s.aligned_fraction:.4f}",
        f"{s.clear_fraction:.4f}", f"{s.median_area_ratio:.6f}",
        run_id,
    ])


def render_overlay(gray: np.ndarray, boxes: list, out_path: Path) -> None:
    """Draw proposed boxes on a copy of the image. Untracked, local inspection."""
    rgb = Image.fromarray(gray).convert("RGB")
    draw = ImageDraw.Draw(rgb)
    for x0, y0, x1, y1 in boxes:
        draw.rectangle((x0, y0, x1 - 1, y1 - 1), outline=(255, 40, 40), width=2)
    rgb.save(out_path)


def resolve_image_paths(labels_path: Path) -> dict[str, tuple[Path, str]]:
    """entryId -> (imagePath, imageSha256). Paths are resolved, never committed."""
    out: dict[str, tuple[Path, str]] = {}
    for line in labels_path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        out.setdefault(row["entryId"], (Path(row["imagePath"]), row["imageSha256"]))
    return out


def load_grey(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("L"), dtype=np.uint8)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rung", required=True, help="proposer key, e.g. classical")
    parser.add_argument("--overlays", action="store_true", help="render out/ PNGs (untracked)")
    args = parser.parse_args()

    proposer = PROPOSERS[args.rung]
    run_id = datetime.now(timezone.utc).isoformat(timespec="seconds")
    resolved = resolve_image_paths(REPO_ROOT / "eval" / "verdicts" / "labels.jsonl")

    scores: list[tuple[str, str, ImageScore]] = []
    metrics_path = HERE / "metrics.jsonl"
    scores_path = HERE / "scores.tsv"
    missing: list[str] = []

    with metrics_path.open("a") as metrics_out, scores_path.open("a") as scores_out:
        for line in (HERE / "entries.txt").read_text().splitlines():
            if not line.strip():
                continue
            entry_id, sha, field_name = line.split("\t")
            if entry_id not in resolved:
                missing.append(entry_id)
                continue
            path, _ = resolved[entry_id]
            if not path.exists():
                missing.append(entry_id)
                continue
            gray = load_grey(path)
            boxes = proposer(gray)
            score, box_metrics = score_image(gray, boxes)
            scores.append((entry_id, field_name, score))
            if args.overlays:
                overlay_path = HERE / "out" / f"{entry_id}-{args.rung}.png"
                overlay_path.parent.mkdir(exist_ok=True)
                render_overlay(gray, boxes, overlay_path)
            for m in box_metrics:
                metrics_out.write(
                    format_metrics_row(run_id, entry_id, sha, field_name, args.rung, m) + "\n",
                )
            scores_out.write(
                format_scores_row(run_id, args.rung, entry_id, field_name, score) + "\n",
            )

    verdict = rung_verdict(scores)
    # A silently shrunk probe set would read as a cleaner result than it is.
    if missing:
        print(f"MISSING {len(missing)} images (excluded from the denominator): {', '.join(missing)}")
    print(json.dumps(asdict(verdict), indent=2))
    return 0 if verdict.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: Run the tests**

```bash
.venv/bin/python -m pytest tests/ -m "not slow" -v
```

Expected: PASS, 31 tests across all four test files (4 entries + 15 rubric + 4
proposers + 8 runner). The `-m "not slow"` keeps the rung-2 model tests out of
the default gate; they run explicitly in Task 6.

- [ ] **Step 5: Run rung 1 over the real probe set**

The invariant to check is the tree the probe actually reads. `run_probe.py` never
opens `corpus/entries.json`; it resolves images from `labels.jsonl`, whose
`imagePath` values are absolute into the **main checkout**
(`/Users/…/clean-ui-mcp/corpus/images-private/…`). Copying `entries.json` into
the worktree and hashing that copy would verify a file the probe never touches —
a check that cannot fail, which reads as verification while proving nothing.

```bash
MAIN=/Users/olaniyi.oladokun/Downloads/clean-ui-mcp
cd eval/element-box-probe
# Snapshot the tree the probe genuinely reads, in the checkout it reads it from.
shasum -a 256 "$MAIN/corpus/entries.json" > /tmp/probe-corpus-before.txt
find "$MAIN/corpus/images-private" -type f -newermt '1 minute ago' | wc -l > /tmp/probe-images-before.txt
.venv/bin/python run_probe.py --rung classical --overlays
# 1. The main checkout's corpus file is untouched.
shasum -a 256 "$MAIN/corpus/entries.json" | diff - /tmp/probe-corpus-before.txt && echo "CORPUS FILE UNCHANGED"
# 2. No private image was written (read-only opens leave mtime alone).
test "$(find "$MAIN/corpus/images-private" -type f -newermt '2 minutes ago' | wc -l)" -eq 0 && echo "IMAGES UNWRITTEN"
# 3. The probe wrote ONLY inside its own directory.
cd ../.. && git status --porcelain | grep -v '^?? eval/element-box-probe/' | grep -v '^ M eval/element-box-probe/' || echo "NO WRITES OUTSIDE THE PROBE DIR"
cd eval/element-box-probe && wc -l metrics.jsonl scores.tsv
```

Expected: a JSON verdict, `CORPUS FILE UNCHANGED`, `IMAGES UNWRITTEN`, `NO WRITES OUTSIDE THE PROBE DIR`, and non-empty outputs. Exit code 1 from `run_probe.py` means the rung failed the rubric — that is a **result**, not an error, and the ladder continues to Task 6.

If any image is reported `MISSING`, record the count and the ids. Do not quietly proceed on a shrunk denominator.

- [ ] **Step 6: Commit the rung-1 result**

```bash
git add eval/element-box-probe/run_probe.py eval/element-box-probe/tests/test_run_probe.py eval/element-box-probe/metrics.jsonl eval/element-box-probe/scores.tsv
git status --porcelain eval/element-box-probe/
git commit -m "feat(probe): the runner, the two-bar ladder verdict, and rung 1's numbers

A rung passes only above BOTH bars: 70% of images globally AND 60% within each of
the four fields' own images. The per-field floor exists because the follow-up
detector measurement is per-field — a rung clearing the global bar while missing
one field would otherwise pass on an average that hides the field it cannot
serve.

metrics.jsonl carries every raw number per box, so the pre-declared thresholds
can be re-judged without re-running. Missing images are printed with their ids
rather than silently shrinking the denominator."
```

`git status --porcelain` must list `metrics.jsonl` and `scores.tsv` as added. If it does not, the Task 1 negations are wrong — fix them before proceeding, not after.

- [ ] **Step 7: Write the task review artifact**

```bash
.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
  --base-sha $(git rev-parse HEAD^) --head-sha $(git rev-parse HEAD) \
  --branch feat/element-box-probe
```

- [ ] **Step 8: Ladder stop check**

If `verdict.passed` is `true`, **stop the ladder**. Skip Task 6 entirely and go to Task 7 — no model is needed, and installing one to confirm a question already answered spends a download to learn nothing.

If `false`, record which checks failed and continue to Task 6. Which check failed is the useful output: a check-1 failure (too many boxes) is a different situation from a check-2 failure (boxes not on edges), and only the second is a reason to reach for a model.

---

### Task 6: Rung 2 — small local VLMs

**Skip this task entirely if Task 5 step 8 said stop.**

**Files:**
- Modify: `eval/element-box-probe/proposers.py`
- Modify: `eval/element-box-probe/tests/test_proposers.py`

**Interfaces:**
- Consumes: `Proposer`, `PROPOSERS` from Task 4.
- Produces: `PROPOSERS` gains `"florence2"` and `"moondream"`.

- [ ] **Step 1: Install the rung-2 stack**

```bash
cd eval/element-box-probe
uv pip install --python .venv/bin/python -r requirements-rung2.txt
.venv/bin/python -c "import torch; print(torch.__version__, torch.backends.mps.is_available())"
```

Expected: a version and a boolean. ~1–2GB of weights download on first model load, not here.

- [ ] **Step 2: Write the failing test for the shared contract**

Both proposers must satisfy the same contract as rung 1, so the runner needs no per-rung branching. Add to `tests/test_proposers.py`:

```python
import pytest

from proposers import PROPOSERS


@pytest.mark.slow
@pytest.mark.parametrize("key", ["florence2", "moondream"])
def test_model_proposers_are_registered_with_the_same_signature(key: str) -> None:
    assert key in PROPOSERS
    assert callable(PROPOSERS[key])


@pytest.mark.slow
@pytest.mark.parametrize("key", ["florence2", "moondream"])
def test_model_proposers_return_integer_boxes_within_image_bounds(key: str) -> None:
    from tests.fixtures import blank, with_stroked_rect
    gray = with_stroked_rect(blank(w=400, h=300), 100, 80, 300, 220)
    boxes = PROPOSERS[key](gray)
    h, w = gray.shape
    for x0, y0, x1, y1 in boxes:
        assert all(isinstance(v, int) for v in (x0, y0, x1, y1))
        assert 0 <= x0 < x1 <= w and 0 <= y0 < y1 <= h
```

These are marked slow (registered in `pytest.ini`) and excluded from the default
suite via `-m "not slow"` in Tasks 5 and 7. Run them explicitly:

```bash
.venv/bin/python -m pytest tests/test_proposers.py -k "model_proposers" -v
```

- [ ] **Step 3: Implement both proposers**

Append to `proposers.py`:

```python
import functools

# Model proposers convert a task-token / detect response into the same Box list
# rung 1 returns, so run_probe.py needs no per-rung branching.

_FLORENCE_ID = "microsoft/Florence-2-base"
_MOONDREAM_ID = "vikhyatk/moondream2"


@functools.lru_cache(maxsize=1)
def _florence():
    import torch
    from transformers import AutoModelForCausalLM, AutoProcessor
    model = AutoModelForCausalLM.from_pretrained(
        _FLORENCE_ID, trust_remote_code=True, torch_dtype=torch.float32,
    ).eval()
    processor = AutoProcessor.from_pretrained(_FLORENCE_ID, trust_remote_code=True)
    return model, processor


def propose_florence2(gray: np.ndarray) -> list[Box]:
    """Florence-2 <REGION_PROPOSAL>, mapped onto the shared Box contract."""
    from PIL import Image
    model, processor = _florence()
    image = Image.fromarray(gray).convert("RGB")
    task = "<REGION_PROPOSAL>"
    inputs = processor(text=task, images=image, return_tensors="pt")
    generated = model.generate(
        input_ids=inputs["input_ids"], pixel_values=inputs["pixel_values"],
        max_new_tokens=1024, num_beams=3, do_sample=False,
    )
    text = processor.batch_decode(generated, skip_special_tokens=False)[0]
    parsed = processor.post_process_generation(text, task=task, image_size=image.size)
    return _to_boxes(parsed.get(task, {}).get("bboxes", []), gray.shape)


@functools.lru_cache(maxsize=1)
def _moondream():
    from transformers import AutoModelForCausalLM, AutoTokenizer
    model = AutoModelForCausalLM.from_pretrained(_MOONDREAM_ID, trust_remote_code=True).eval()
    tokenizer = AutoTokenizer.from_pretrained(_MOONDREAM_ID)
    return model, tokenizer


def propose_moondream(gray: np.ndarray) -> list[Box]:
    """Moondream detect, mapped onto the shared Box contract."""
    from PIL import Image
    model, _ = _moondream()
    image = Image.fromarray(gray).convert("RGB")
    result = model.detect(image, "user interface element")
    w, h = image.size
    raw = [
        [o["x_min"] * w, o["y_min"] * h, o["x_max"] * w, o["y_max"] * h]
        for o in result.get("objects", [])
    ]
    return _to_boxes(raw, gray.shape)


def _to_boxes(raw: list, shape: tuple[int, int]) -> list[Box]:
    """Clamp, integerise, and drop degenerate boxes. Shared by both models."""
    h, w = shape
    out: list[Box] = []
    for item in raw:
        x0, y0, x1, y1 = (int(round(float(v))) for v in item[:4])
        x0, x1 = max(0, min(x0, w)), max(0, min(x1, w))
        y0, y1 = max(0, min(y0, h)), max(0, min(y1, h))
        if x1 > x0 and y1 > y0:
            out.append((x0, y0, x1, y1))
    return out


PROPOSERS["florence2"] = propose_florence2
PROPOSERS["moondream"] = propose_moondream
```

If either model's API differs from the above at the pinned `transformers` version, fix the call to match the installed library and **record the change in `docs/element-box-probe.md`**. A proposer that silently returns `[]` because a response key was renamed would be indistinguishable from a model that found nothing, and the second is a real result while the first is a bug.

- [ ] **Step 4: Run both rungs over the probe set**

```bash
.venv/bin/python run_probe.py --rung florence2 --overlays
.venv/bin/python run_probe.py --rung moondream --overlays
shasum -a 256 "$MAIN/corpus/entries.json" | diff - /tmp/probe-corpus-before.txt && echo "CORPUS FILE UNCHANGED"
```

Expected: two verdicts appended to `metrics.jsonl`/`scores.tsv`, corpus unchanged.

The spec predicts these fail check 1 or check 4 — natural-image training, so boxes at `screen`/`monitor` scale rather than element scale. If they do, that is a prediction confirmed and belongs in the write-up as such. If they do not, retire the belief explicitly rather than leaving it in the spec.

- [ ] **Step 5: Commit**

```bash
git add eval/element-box-probe/proposers.py eval/element-box-probe/tests/test_proposers.py eval/element-box-probe/metrics.jsonl eval/element-box-probe/scores.tsv
git commit -m "feat(probe): rung 2, Florence-2 and Moondream behind the rung-1 contract

Both map their task-token / detect output onto the same Box list rung 1 returns,
so the runner needs no per-rung branching and the rubric is identical across
rungs — which is the point of running the classical baseline first.

Boxes are clamped to image bounds and degenerate ones dropped in shared code, so
a model returning out-of-frame coordinates is a recorded metric rather than an
exception in the rubric."
```

- [ ] **Step 6: Write the task review artifact**

```bash
.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
  --base-sha $(git rev-parse HEAD^) --head-sha $(git rev-parse HEAD) \
  --branch feat/element-box-probe
```

---

### Task 7: The write-up and the decision

**Files:**
- Create: `docs/element-box-probe.md`

- [ ] **Step 1: Assemble the per-rung table**

```bash
cd eval/element-box-probe
cut -f1 scores.tsv | sort | uniq -c
```

Expected: one row group per rung that was run, each with the probe-set size.

- [ ] **Step 2: Write `docs/element-box-probe.md`**

Include, in this order:

1. **The verdict, first line.** Which rung passed, or that none did. Everything else is support.
2. Probe set: the count actually measured, and any `MISSING` ids excluded, with the reason.
3. Per-rung table: global fraction, the four per-field fractions, and the failing-check counts.
4. For each failed rung, **which check failed** — a check-1 failure is a different situation from a check-2 failure, and only the second is a reason to reach for a model.
5. Rung 3 status. If a screen parser was not obtainable on licence or availability grounds, say so explicitly. Do not present a two-rung ladder as a complete one.
6. Whether any rung distinguished *interactable* elements, which is what decides whether `accentColor` moves the addressable abstain set from 85 to 122.
7. The rung-2 prediction: confirmed, or retired.
8. **The decision.** Passing means "worth building the detector and scoring it against the 46 labels". Failing means "do not". The rubric rules out; it does not rule in — a proposer can pass all four checks and a detector built on it still be inaccurate.
9. Any threshold that looks badly placed in hindsight, with the `metrics.jsonl` distribution that shows it. Re-judging from committed numbers is allowed and expected; silently moving a threshold and re-running is not.

- [ ] **Step 3: Commit**

```bash
git add docs/element-box-probe.md
git commit -m "docs(probe): which rung passed and what it decides

The rubric rules out but does not rule in: geometric usability is necessary, not
sufficient, so a pass means 'worth building the detector and scoring it against
the 46 labels' rather than 'this will work'."
```

- [ ] **Step 4: Branch review and push**

```bash
cd eval/element-box-probe && .venv/bin/python -m pytest tests/ -m "not slow" -v && cd ../..
.zcode/scripts/write-review-artifact --type branch --result approved --reviewer agent \
  --base-sha fb055fa --head-sha $(git rev-parse HEAD) \
  --branch feat/element-box-probe
git push -u origin feat/element-box-probe
```

The branch gate rejects an artifact whose `headSha` is not `git rev-parse HEAD`, so write it after the last commit.

---

## Self-review

**Spec coverage.** The question → Task 7 step 2 item 1. Probe set of 46 → Task 2. Rubric checks 1–4 → Task 3. Check-2 corner-adjacent sampling → Task 3 (`_sample_offsets` samples three positions; `measure_boxes` takes the worst). Boundary-box rules → Task 3 (`boundary_edges`, `all_edges_boundary`, `_clearances` returning `None` at image edges, full-bleed excluded from check 3's denominator). Pre-declared thresholds + raw metrics → Task 3 constants and `metrics.jsonl` in Task 5. Ladder rungs 1–3 → Tasks 4, 6, and Task 7 item 5. Two-bar pass condition → Task 5 `rung_verdict`. On-failure record which check → Task 5 `failing_checks`, Task 7 item 4. Rung-2 prediction → Task 6 step 4, Task 7 item 7. Deliverables → Tasks 1, 2, 5. Overlays untracked → Task 1 negations, verified in step 4. `eval/*` negations → Task 1 steps 3–5. Testing → Tasks 2–5. Risks 1, 4, 5 → Task 7 items 8, 5, 6.

**Rung 3 has no implementation task, deliberately.** The spec makes it conditional on obtainability and licence, which cannot be resolved before rungs 1–2 report. Writing a task for a model that may not be usable would be a placeholder. Task 7 item 5 requires its status be stated rather than omitted.

**Type consistency.** `Box = tuple[int, int, int, int]` is declared in `rubric.py` (Task 3) and re-declared identically in `proposers.py` (Task 4) so the two modules stay independent — they are structurally identical aliases, not two different shapes. `ImageScore` is produced by `score_image` (Task 3) and consumed by `rung_verdict` (Task 5) with the same four `checkN_*` attribute names used in `CHECK_NAMES`. `PROPOSERS` is created in Task 4 and extended in place in Task 6. `ELEMENT_FIELDS` is declared in Task 2 and consumed in Task 5.

**One risk this plan adds beyond the spec.** Task 6's model call signatures are written against the pinned `transformers` version but have not been executed. Step 3 requires that any deviation be fixed *and recorded*, because a proposer silently returning `[]` after an API rename is indistinguishable from a model that found nothing — and only the latter is a result.

## Review amendments (2026-08-08)

Folded from the eng review of this plan:

- `pytest.ini` added (registers `slow`) with its gitignore negation; the rung-2
  model tests are `@pytest.mark.slow`, and the default suites in Tasks 5 and 7
  run with `-m "not slow"`.
- `from fixtures import` corrected to `from tests.fixtures import` (pytest
  prepend import mode with `tests/__init__.py` does not put `tests/` on
  sys.path).
- `metrics.jsonl`/`scores.tsv` rows carry a `runId` (last TSV column, so
  `cut -f1` still groups by rung); the row schemas are pinned by the pure
  `format_metrics_row`/`format_scores_row` functions, with output-shape tests.
- `--overlays` is implemented (`render_overlay` draws boxes to `out/`).
- `rung_verdict` distinguishes a missing field (zero rows) from a failing one,
  reporting `missing_fields` and failing the rung when any field is absent.
- Task 5 step 5 checks the tree the probe actually reads (the MAIN checkout's
  corpus), not a copy of a file it never opens. Superseded 2026-08-08.
