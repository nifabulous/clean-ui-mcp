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


import functools

# Model proposers convert a task-token / detect response into the same Box list
# rung 1 returns, so run_probe.py needs no per-rung branching.

_FLORENCE_ID = "microsoft/Florence-2-base"
_MOONDREAM_ID = "vikhyatk/moondream2"


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
    """Load Moondream on CPU, with an upstream MPS bug worked around.

    moondream2's remote `vision.py` does, at IMPORT time:

        if torch.backends.mps.is_available():
            def adaptive_avg_pool2d(input, output_size):
                return F.adaptive_avg_pool2d(input.to("cpu"), output_size).to("mps")

    The workaround assumes the model is on MPS. We load on CPU, so the pooled
    tensor comes back on `mps:0` while `global_features` stays on `cpu`, and
    `torch.cat` raises "all input tensors must be on the same device".

    Reporting MPS as unavailable BEFORE the remote module imports is the minimal
    fix: the patch never installs and everything stays on CPU. Recorded here and
    in docs/element-box-probe.md because a proposer that silently returned []
    after a load failure would be indistinguishable from a model that found
    nothing, and only the second is a result.
    """
    import torch
    from transformers import AutoModelForCausalLM, AutoTokenizer
    original = torch.backends.mps.is_available
    torch.backends.mps.is_available = lambda: False
    try:
        model = AutoModelForCausalLM.from_pretrained(
            _MOONDREAM_ID, trust_remote_code=True,
        ).eval()
        tokenizer = AutoTokenizer.from_pretrained(_MOONDREAM_ID)
    finally:
        torch.backends.mps.is_available = original
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


PROPOSERS["florence2"] = propose_florence2
PROPOSERS["moondream"] = propose_moondream


# --- Rung 3a: UIED's two techniques -----------------------------------------
#
# github.com/MulongXie/UIED — "UIED: a hybrid tool for GUI element detection"
# (Xie et al., Monash). Two ideas are ported, not the code: the upstream repo
# pins Python 3.5 / OpenCV 3.4.2 and calls Google OCR over the network.
#
# 1. TEXT SUPPRESSION. Detect text, then discard any component overlapping a
#    text block by >= 90%. Rung 1's measured failure was that 96% of its boxes
#    were text runs and 93.4% of its "aligned" boxes were text.
# 2. UNIFORM-REGION SEGMENTATION. Find elements by colour CONTINUITY rather than
#    edge gradient. Rung 1's other failure was soft grey-on-white cards, whose
#    border step is ~4-14 grey levels — far under Canny's 50/150 hysteresis. A
#    card's INTERIOR is uniform even when its edge is nearly invisible.

SOFT_EDGE_THRESHOLD = 6.0   # Sobel magnitude; Canny's lower hysteresis is 50
MIN_SOLIDITY = 0.70         # a card fills its bbox; a ragged blob does not
TEXT_OVERLAP_DROP = 0.90    # UIED's threshold


def _drop_text_overlaps(
    boxes: list[Box], text_boxes: list[Box], threshold: float = TEXT_OVERLAP_DROP,
) -> list[Box]:
    """Discard a box whose OWN area is >= threshold covered by text.

    Intersection is normalised by the BOX's area, not the text's: a card
    containing a label keeps its box (the label covers little of the card),
    while a box drawn around the label itself is dropped.
    """
    kept: list[Box] = []
    for bx0, by0, bx1, by1 in boxes:
        area = float(max(1, (bx1 - bx0) * (by1 - by0)))
        covered = 0.0
        for tx0, ty0, tx1, ty1 in text_boxes:
            ix = max(0, min(bx1, tx1) - max(bx0, tx0))
            iy = max(0, min(by1, ty1) - max(by0, ty0))
            covered += ix * iy
        if covered / area < threshold:
            kept.append((bx0, by0, bx1, by1))
    return kept


@functools.lru_cache(maxsize=1)
def _ocr_reader():
    import easyocr
    return easyocr.Reader(["en"], gpu=False, verbose=False)


def detect_text_boxes(gray: np.ndarray) -> list[Box]:
    """Text bounding boxes via local OCR. UIED uses Google OCR over the network;
    the detector lane must stay offline and independent, so this is local."""
    try:
        results = _ocr_reader().detect(np.stack([gray] * 3, axis=-1))
    except Exception:
        # An OCR failure must not silently disable text suppression — that would
        # make rung 3a score as rung 1 while claiming to be different.
        raise
    boxes: list[Box] = []
    horizontal = results[0][0] if results and results[0] else []
    for item in horizontal:
        x0, x1, y0, y1 = (int(v) for v in item[:4])
        boxes.append((min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)))
    return boxes


def propose_uied(gray: np.ndarray) -> list[Box]:
    """Uniform-region segmentation at a soft-edge threshold, then text suppression."""
    h, w = gray.shape
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    magnitude = cv2.magnitude(gx, gy)
    # Complement of the edge map: the UNIFORM regions are the elements.
    uniform = (magnitude <= SOFT_EDGE_THRESHOLD).astype(np.uint8)
    count, _labels, stats, _ = cv2.connectedComponentsWithStats(uniform, connectivity=4)

    boxes: list[Box] = []
    for i in range(1, count):
        x, y, bw, bh, area = stats[i]
        if bw < MIN_BOX_W or bh < MIN_BOX_H:
            continue
        if (bw * bh) / float(w * h) > MAX_AREA_FRACTION:
            continue
        if area / float(bw * bh) < MIN_SOLIDITY:
            continue
        boxes.append((int(x), int(y), int(x + bw), int(y + bh)))

    return _drop_text_overlaps(boxes, detect_text_boxes(gray))


PROPOSERS["uied"] = propose_uied


# --- Rung 3b: OmniParser's detection half ------------------------------------
#
# microsoft/OmniParser-v2.0. Only `icon_detect` is used: the probe wants BOXES,
# not the captioner's functional descriptions, and loading a caption model to
# discard its output would spend a download to learn nothing.
#
# Stated risk, from the spec review: OmniParser's objective is INTERACTABLE
# regions ("prediction of whether each screen element is interactable" is the
# v1.5 headline). Three of the four fields this probe serves are about
# CONTAINERS — cards, panels, surfaces — which are not clickable. If it returns
# only interactables, it targets the wrong class, and that is a result rather
# than a bug.

_OMNIPARSER_REPO = "microsoft/OmniParser-v2.0"
_OMNIPARSER_WEIGHTS = "icon_detect/model.pt"
OMNIPARSER_CONF = 0.05  # upstream demo's box_threshold


@functools.lru_cache(maxsize=1)
def _omniparser():
    from huggingface_hub import hf_hub_download
    from ultralytics import YOLO
    return YOLO(hf_hub_download(_OMNIPARSER_REPO, _OMNIPARSER_WEIGHTS))


def propose_omniparser(gray: np.ndarray) -> list[Box]:
    """OmniParser icon_detect (YOLOv8), mapped onto the shared Box contract."""
    model = _omniparser()
    rgb = np.stack([gray] * 3, axis=-1)
    results = model.predict(rgb, conf=OMNIPARSER_CONF, iou=0.7, verbose=False)
    raw: list[list[float]] = []
    for result in results:
        for box in result.boxes:
            raw.append([float(v) for v in box.xyxy[0].tolist()])
    return _to_boxes(raw, gray.shape)


PROPOSERS["omniparser"] = propose_omniparser


# --- Rung 3c: deki-yolo -------------------------------------------------------
#
# github.com/RasulOs/deki — the only detector found with an explicit CONTAINER
# class. OmniParser's icon_detect carries one class ("icon"), which is why 3b
# targeted the wrong objects; deki's four classes are View (general-purpose
# containers), ImageView, Text and Line.
#
# Only `View` is proposed. ImageView/Text/Line are the objects the rubric's
# text-suppression step exists to REMOVE, and three of the four fields this probe
# serves (usesBorders, usesShadows, cornerStyle) are about containers.
#
# Pre-declared risks, recorded before the run so the result cannot be
# re-litigated afterwards:
#   1. DOMAIN SHIFT. The model card is titled "Mobile UI Element Detection
#      Model"; examples are 1080x2178 phone screenshots and the class names are
#      Android SDK vocabulary. This corpus is 1920x1200 WEB screenshots. A
#      failure on box count or alignment is attributable to domain shift and
#      would NOT rule out a web-trained equivalent.
#   2. SMALL TRAINING SET. 486 images trained, 60 tested — the README itself
#      warns its examples "give people a false impression of the accuracy".
#   3. BOUNDARY PRECISION. YOLO optimises IoU 0.5-0.95; the rubric needs +/-3px
#      per edge. Right class does not guarantee right boundary — that distinction
#      is exactly what 3b failed on (46/46 alignment failures at a correct count).
#
# LICENCE: GPL-3.0, repo and weights. Fine here — the probe runs locally and
# distributes nothing, and copyleft obligations attach to distribution. Shipping
# this in the product would be a separate, deliberate licence decision.

_DEKI_REPO = "orasul/deki-yolo"
_DEKI_WEIGHTS = "best.pt"
DEKI_CONF = 0.05          # matched to OMNIPARSER_CONF so the rungs are comparable
DEKI_CONTAINER_CLASS = "View"


@functools.lru_cache(maxsize=1)
def _deki():
    from huggingface_hub import hf_hub_download
    from ultralytics import YOLO
    return YOLO(hf_hub_download(_DEKI_REPO, _DEKI_WEIGHTS))


def propose_deki(gray: np.ndarray) -> list[Box]:
    """deki-yolo, filtered to the View (container) class."""
    model = _deki()
    names = {v: k for k, v in model.names.items()}
    if DEKI_CONTAINER_CLASS not in names:
        # Fail loudly: silently proposing every class would make this rung look
        # like a container detector while measuring text and icons.
        raise RuntimeError(
            f"deki weights have no {DEKI_CONTAINER_CLASS!r} class; got {model.names}",
        )
    wanted = names[DEKI_CONTAINER_CLASS]
    results = model.predict(
        np.stack([gray] * 3, axis=-1), conf=DEKI_CONF, iou=0.7,
        classes=[wanted], verbose=False,
    )
    raw = [[float(v) for v in b.xyxy[0].tolist()] for r in results for b in r.boxes]
    return _to_boxes(raw, gray.shape)


PROPOSERS["deki"] = propose_deki
