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


import pytest


@pytest.mark.slow
@pytest.mark.parametrize("key", ["florence2", "moondream"])
def test_model_proposers_are_registered_with_the_same_signature(key: str) -> None:
    assert key in PROPOSERS
    assert callable(PROPOSERS[key])


@pytest.mark.slow
@pytest.mark.parametrize("key", ["florence2", "moondream"])
def test_model_proposers_return_integer_boxes_within_image_bounds(key: str) -> None:
    gray = with_stroked_rect(blank(w=400, h=300), 100, 80, 300, 220)
    boxes = PROPOSERS[key](gray)
    h, w = gray.shape
    for x0, y0, x1, y1 in boxes:
        assert all(isinstance(v, int) for v in (x0, y0, x1, y1))
        assert 0 <= x0 < x1 <= w and 0 <= y0 < y1 <= h


# --- Rung 3a: UIED's two techniques -----------------------------------------

def test_rung1_provably_cannot_see_a_soft_edged_card() -> None:
    # The premise of rung 3a. If this ever fails, the gap it was built to close
    # no longer exists and the extra machinery is unjustified.
    from tests.fixtures import with_soft_card
    gray = with_soft_card(blank(w=600, h=400, value=246), 100, 80, 400, 300)
    boxes = propose_classical(gray)
    matched = [
        b for b in boxes
        if abs(b[0] - 100) <= 3 and abs(b[1] - 80) <= 3
        and abs(b[2] - 400) <= 3 and abs(b[3] - 300) <= 3
    ]
    assert matched == []


def test_uied_finds_the_soft_edged_card_rung1_misses() -> None:
    from tests.fixtures import with_soft_card
    from proposers import propose_uied
    gray = with_soft_card(blank(w=600, h=400, value=246), 100, 80, 400, 300)
    boxes = propose_uied(gray)
    matched = [
        b for b in boxes
        if abs(b[0] - 100) <= 3 and abs(b[1] - 80) <= 3
        and abs(b[2] - 400) <= 3 and abs(b[3] - 300) <= 3
    ]
    assert matched, f"soft card not found; got {boxes}"


def test_uied_drops_components_overlapping_a_text_box() -> None:
    # UIED's rule: discard a component overlapping a detected text block >= 90%.
    from proposers import _drop_text_overlaps
    card = (100, 80, 400, 300)
    word = (120, 100, 220, 118)
    text_boxes = [(118, 98, 222, 120)]
    kept = _drop_text_overlaps([card, word], text_boxes, threshold=0.9)
    assert card in kept
    assert word not in kept


def test_text_overlap_keeps_a_container_that_merely_contains_text() -> None:
    # A card with a label inside must NOT be dropped: the card's own area is
    # mostly not text, even though a text box sits within it.
    from proposers import _drop_text_overlaps
    card = (100, 80, 400, 300)
    kept = _drop_text_overlaps([card], [(120, 100, 220, 118)], threshold=0.9)
    assert kept == [card]


def test_registry_exposes_the_uied_proposer() -> None:
    from proposers import PROPOSERS, propose_uied
    assert PROPOSERS["uied"] is propose_uied


@pytest.mark.slow
def test_omniparser_is_registered_and_returns_contract_boxes() -> None:
    from tests.fixtures import with_soft_card
    from proposers import PROPOSERS
    assert "omniparser" in PROPOSERS
    gray = with_soft_card(blank(w=600, h=400, value=246), 100, 80, 400, 300)
    boxes = PROPOSERS["omniparser"](gray)
    h, w = gray.shape
    for x0, y0, x1, y1 in boxes:
        assert all(isinstance(v, int) for v in (x0, y0, x1, y1))
        assert 0 <= x0 < x1 <= w and 0 <= y0 < y1 <= h
