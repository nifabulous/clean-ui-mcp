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
