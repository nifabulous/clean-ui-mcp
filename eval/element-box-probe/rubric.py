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
    #: Offset of the NEAREST qualifying gradient to the box boundary, per edge.
    #: None when no gradient beating the image's noise floor exists within
    #: ALIGN_TOLERANCE_PX. This is the amended measurement (2026-08-08).
    edge_offsets: list[float | None] = dc_field(default_factory=list)
    #: Offset of the STRONGEST gradient in the +/-ALIGN_SAMPLE_SPAN_PX window —
    #: the measurement the spec originally pre-declared. Kept so the original
    #: verdict stays derivable from committed metrics without a re-run.
    edge_offsets_strongest: list[float | None] = dc_field(default_factory=list)
    edge_magnitudes: list[float] = dc_field(default_factory=list)
    edges_aligned: int = 0
    outside_clearances: list[float | None] = dc_field(default_factory=list)
    max_clearance: float = 0.0
    area_ratio: float = 0.0
    boundary_edges: list[bool] = dc_field(default_factory=list)
    all_edges_boundary: bool = False
    #: Fraction of interior pixels sitting on a gradient above the image's noise
    #: floor. RECORDED, NOT CHECKED — no pass/fail depends on it.
    #:
    #: It exists because the four checks are all precision-flavoured: they ask
    #: whether the boxes found are geometrically clean, never whether the
    #: CONTAINERS were found. A proposer returning nothing but word-boxes can
    #: score well, and rung 1 largely does — a word's bounding box genuinely sits
    #: on strong edges. This separates the two: a flat card reads near 0, a text
    #: run reads high, and no border, shadow or corner is measurable inside the
    #: latter.
    interior_edge_density: float = 0.0


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


def _sample_offsets(
    gray: np.ndarray, edge_index: int, box: Box, noise_floor: float,
) -> tuple[list[float | None], list[float | None], float, bool]:
    """Three perpendicular samples per edge: midpoint and both corner-adjacent.

    Returns (nearest_offsets, strongest_offsets, max magnitude across samples,
    whether the edge is clamped by the image boundary). An offset is the signed
    distance from the box boundary along the sample line, positive OUTWARD.

    AMENDED 2026-08-08. The spec pre-declared "the offset of the MAXIMUM
    gradient" in the window. Run against real screenshots that measured 20.4% of
    edges aligned, with a degenerate offset distribution (median = p75 = p90 =
    max = 5.50px — a pile-up at the window edge, not a distribution): within
    +/-6px of any box edge a dense UI usually contains OTHER elements' edges,
    and argmax picks whichever is strongest, not the box's own. It reported
    misalignment for boxes that were aligned. The amended question is the one
    check 2's own sentence asks — is there a qualifying gradient AT the boundary
    — and it measures 49.8% on identical boxes.

    `strongest_offsets` preserves the pre-declared measurement so the original
    verdict stays derivable from committed metrics without re-running.
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

    nearest: list[float | None] = []
    strongest: list[float | None] = []
    magnitudes: list[float] = []
    for p in positions:
        p = int(np.clip(p, 0, (w - 1) if horizontal else (h - 1)))
        line = gray[clamped_lo:clamped_hi, p] if horizontal else gray[p, clamped_lo:clamped_hi]
        if line.size < 2:
            nearest.append(None)
            strongest.append(None)
            magnitudes.append(0.0)
            continue
        grad = np.abs(np.diff(line.astype(np.float64)))
        # +0.5: a diff at index i sits BETWEEN samples i and i+1.
        offs = np.arange(len(grad), dtype=np.float64) + clamped_lo + 0.5 - edge_coord
        peak = int(np.argmax(grad))
        strongest.append(float(offs[peak]))
        magnitudes.append(float(grad[peak]))
        # The NEAREST gradient to the boundary that beats the image's own noise
        # floor. Ties on distance go to the stronger gradient.
        qualifying = [
            i for i in range(len(grad))
            if abs(offs[i]) <= ALIGN_TOLERANCE_PX and grad[i] > noise_floor
        ]
        if qualifying:
            best = min(qualifying, key=lambda i: (abs(offs[i]), -grad[i]))
            nearest.append(float(offs[best]))
        else:
            nearest.append(None)
    return nearest, strongest, (max(magnitudes) if magnitudes else 0.0), boundary


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


def _interior_edge_density(gray: np.ndarray, box: Box, noise_floor: float) -> float:
    """Fraction of the box interior sitting on a gradient above the noise floor.

    Separates a flat container (near 0) from a text run (high). Measured one
    pixel inside the boundary on every side so the box's own edge is excluded —
    otherwise every box would score at least its own perimeter.
    """
    x0, y0, x1, y1 = box
    inner = gray[y0 + 1:y1 - 1, x0 + 1:x1 - 1]
    if inner.shape[0] < 2 or inner.shape[1] < 2:
        return 0.0
    a = inner.astype(np.float64)
    gx = np.abs(np.diff(a, axis=1))[:-1, :]
    gy = np.abs(np.diff(a, axis=0))[:, :-1]
    if gx.size == 0 or gy.size == 0:
        return 0.0
    return float(np.mean(np.maximum(gx, gy) > max(noise_floor, 1.0)))


def measure_boxes(gray: np.ndarray, boxes: list[Box]) -> list[BoxMetrics]:
    h, w = gray.shape
    image_area = float(h * w)
    noise_floor = _median_edge_magnitude(gray)
    out: list[BoxMetrics] = []
    for i, box in enumerate(boxes):
        m = BoxMetrics(box=box)
        for edge_index in range(4):
            nearest, strongest, magnitude, boundary = _sample_offsets(
                gray, edge_index, box, noise_floor,
            )
            # The edge's recorded offset is the WORST of the three samples: a box
            # whose midpoint aligns but whose corners are shaved is not aligned.
            # A sample with NO qualifying gradient disqualifies the edge outright,
            # which is what makes the shaved-corner case fail.
            aligned = all(o is not None for o in nearest)
            m.edge_offsets.append(max(nearest, key=abs) if aligned else None)
            usable_strongest = [o for o in strongest if o is not None]
            m.edge_offsets_strongest.append(
                max(usable_strongest, key=abs) if usable_strongest else None,
            )
            m.edge_magnitudes.append(magnitude)
            m.boundary_edges.append(boundary)
            if aligned:
                m.edges_aligned += 1
        x0, y0, x1, y1 = box
        m.all_edges_boundary = x0 <= 0 and y0 <= 0 and x1 >= w and y1 >= h
        m.outside_clearances = _clearances(box, [b for j, b in enumerate(boxes) if j != i], (h, w))
        eligible = [c for c in m.outside_clearances if c is not None]
        m.max_clearance = max(eligible) if eligible else 0.0
        m.area_ratio = ((x1 - x0) * (y1 - y0)) / image_area
        m.interior_edge_density = _interior_edge_density(gray, box, noise_floor)
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
