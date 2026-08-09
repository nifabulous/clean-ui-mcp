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


def with_soft_card(gray: np.ndarray, x0: int, y0: int, x1: int, y1: int,
                   fill: int = 250, border: int = 236, width: int = 1) -> np.ndarray:
    """A card the way real UIs draw them: near-white fill, 1px light-grey border
    on an off-white canvas. The contrast step is ~4-14 grey levels, far below
    Canny's 50/150 hysteresis — this is the object rung 1 provably cannot see."""
    out = gray.copy()
    out[y0:y1, x0:x1] = fill
    out[y0:y1, x0:x0 + width] = border
    out[y0:y1, x1 - width:x1] = border
    out[y0:y0 + width, x0:x1] = border
    out[y1 - width:y1, x0:x1] = border
    return out


def with_text_run(gray: np.ndarray, x0: int, y0: int, n: int = 8,
                  glyph_w: int = 10, gap: int = 4, h: int = 14,
                  value: int = 40) -> np.ndarray:
    """A word: n dark glyph-shaped marks in a row. Rung 1 boxes these."""
    out = gray.copy()
    for i in range(n):
        x = x0 + i * (glyph_w + gap)
        out[y0:y0 + h, x:x + glyph_w] = value
    return out
