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
