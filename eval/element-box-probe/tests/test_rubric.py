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


def test_a_stronger_neighbouring_edge_does_not_mask_the_boxs_own_edge() -> None:
    # The defect real screenshots exposed. The box's left edge sits on a real
    # 240->40 step, but a DARKER neighbour 5px outside produces a stronger
    # 240->0 step inside the same +/-6px window. Taking the offset of the
    # strongest gradient reports -5.5 and calls an aligned edge misaligned.
    gray = with_rect(blank(), 100, 80, 200, 160)
    gray[80:160, 93:95] = 0  # stronger competing edge, 5px outside
    [m] = measure_boxes(gray, [(100, 80, 200, 160)])
    assert m.edge_offsets[0] is not None
    assert abs(m.edge_offsets[0]) <= ALIGN_TOLERANCE_PX
    assert m.edges_aligned == 4


def test_the_pre_registered_strongest_gradient_offset_is_still_recorded() -> None:
    # The amended measurement must not destroy the number the spec originally
    # declared — both go to metrics.jsonl so the original verdict stays derivable.
    gray = with_rect(blank(), 100, 80, 200, 160)
    gray[80:160, 93:95] = 0
    [m] = measure_boxes(gray, [(100, 80, 200, 160)])
    assert m.edge_offsets_strongest[0] == pytest.approx(-5.5)


def test_a_flat_container_has_low_interior_edge_density() -> None:
    # A filled card: the box interior is one colour, so almost no interior pixel
    # sits on a gradient. This is what usesBorders/cornerStyle can measure in.
    gray = with_rect(blank(), 100, 80, 200, 160)
    [m] = measure_boxes(gray, [(100, 80, 200, 160)])
    assert m.interior_edge_density < 0.10


def test_a_text_run_has_high_interior_edge_density() -> None:
    # A word-shaped blob: vertical strokes every few px. The classical proposer
    # boxes these and the alignment check scores them as aligned, because a
    # word's bbox really does sit on strong edges — but no border, shadow or
    # corner can be measured inside one.
    gray = blank()
    for x in range(100, 200, 6):
        gray[80:160, x:x + 3] = 40
    [m] = measure_boxes(gray, [(100, 80, 200, 160)])
    assert m.interior_edge_density > 0.20
