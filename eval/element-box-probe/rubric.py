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
