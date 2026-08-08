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
