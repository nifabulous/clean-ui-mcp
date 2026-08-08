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
