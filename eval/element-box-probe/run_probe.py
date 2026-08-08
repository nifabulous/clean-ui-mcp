"""Run a rung over the pinned probe set and emit raw metrics plus a score table.

Reads corpus images. Writes ONLY to this directory (metrics.jsonl, scores.tsv)
and to out/ (overlays, untracked). Never touches the corpus.

Every row carries a runId so re-running a rung appends a distinguishable row set
instead of silently duplicating the previous run's numbers.
"""
from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass, field as dc_field
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

from build_entries import ELEMENT_FIELDS
from proposers import PROPOSERS
from rubric import BoxMetrics, ImageScore, score_image

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
GLOBAL_PASS_FRACTION = 0.70
PER_FIELD_PASS_FRACTION = 0.60
CHECK_NAMES = ("check1_count", "check2_alignment", "check3_margin", "check4_area")


@dataclass
class RungVerdict:
    passed: bool
    global_fraction: float
    by_field: dict[str, float] = dc_field(default_factory=dict)
    failing_checks: dict[str, int] = dc_field(default_factory=dict)
    missing_fields: list[str] = dc_field(default_factory=list)


def rung_verdict(scores: list[tuple[str, str, ImageScore]]) -> RungVerdict:
    """A rung passes only above BOTH bars, with every field present.

    The per-field floor exists because the follow-up detector measurement is
    per-field: a rung that clears the global bar while missing one field's
    images is reported as failing that field, not as passing on average. A field
    with ZERO rows is missing, not failed at 0.0: the two have different causes
    (no labelled images vs a proposer that missed every one).
    """
    if not scores:
        return RungVerdict(passed=False, global_fraction=0.0, missing_fields=list(ELEMENT_FIELDS))

    def all_ok(s: ImageScore) -> bool:
        return all(getattr(s, name) for name in CHECK_NAMES)

    global_fraction = sum(1 for _, _, s in scores if all_ok(s)) / len(scores)

    by_field: dict[str, float] = {}
    missing_fields: list[str] = []
    for f in ELEMENT_FIELDS:
        rows = [s for _, field_name, s in scores if field_name == f]
        if not rows:
            missing_fields.append(f)
            continue
        by_field[f] = (sum(1 for s in rows if all_ok(s)) / len(rows))

    failing_checks = {
        name: sum(1 for _, _, s in scores if not getattr(s, name)) for name in CHECK_NAMES
    }

    passed = (
        not missing_fields
        and global_fraction >= GLOBAL_PASS_FRACTION
        and all(v >= PER_FIELD_PASS_FRACTION for v in by_field.values())
    )
    return RungVerdict(passed, global_fraction, by_field, failing_checks, missing_fields)


def format_metrics_row(run_id: str, entry_id: str, sha: str, field_name: str,
                       method: str, m: BoxMetrics) -> str:
    """One metrics.jsonl row. The schema is pinned here so re-judgment parses
    committed rows without guessing — see the spec's review decisions."""
    return json.dumps({
        "runId": run_id, "entryId": entry_id, "imageSha256": sha, "field": field_name,
        "method": method, **asdict(m),
    })


def format_scores_row(run_id: str, method: str, entry_id: str, field_name: str,
                      s: ImageScore) -> str:
    """One scores.tsv row. Column 1 is deliberately the rung: Task 7's
    `cut -f1 | sort | uniq -c` groups by rung. runId is the LAST column."""
    return "\t".join([
        method, entry_id, field_name,
        *(str(getattr(s, n)) for n in CHECK_NAMES),
        f"{s.box_count}", f"{s.aligned_fraction:.4f}",
        f"{s.clear_fraction:.4f}", f"{s.median_area_ratio:.6f}",
        run_id,
    ])


def render_overlay(gray: np.ndarray, boxes: list, out_path: Path) -> None:
    """Draw proposed boxes on a copy of the image. Untracked, local inspection."""
    rgb = Image.fromarray(gray).convert("RGB")
    draw = ImageDraw.Draw(rgb)
    for x0, y0, x1, y1 in boxes:
        draw.rectangle((x0, y0, x1 - 1, y1 - 1), outline=(255, 40, 40), width=2)
    rgb.save(out_path)


def resolve_image_paths(labels_path: Path) -> dict[str, tuple[Path, str]]:
    """entryId -> (imagePath, imageSha256). Paths are resolved, never committed."""
    out: dict[str, tuple[Path, str]] = {}
    for line in labels_path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        out.setdefault(row["entryId"], (Path(row["imagePath"]), row["imageSha256"]))
    return out


def load_grey(path: Path) -> np.ndarray:
    return np.asarray(Image.open(path).convert("L"), dtype=np.uint8)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rung", required=True, help="proposer key, e.g. classical")
    parser.add_argument("--overlays", action="store_true", help="render out/ PNGs (untracked)")
    args = parser.parse_args()

    proposer = PROPOSERS[args.rung]
    run_id = datetime.now(timezone.utc).isoformat(timespec="seconds")
    resolved = resolve_image_paths(REPO_ROOT / "eval" / "verdicts" / "labels.jsonl")

    scores: list[tuple[str, str, ImageScore]] = []
    metrics_path = HERE / "metrics.jsonl"
    scores_path = HERE / "scores.tsv"
    missing: list[str] = []

    with metrics_path.open("a") as metrics_out, scores_path.open("a") as scores_out:
        for line in (HERE / "entries.txt").read_text().splitlines():
            if not line.strip():
                continue
            entry_id, sha, field_name = line.split("\t")
            if entry_id not in resolved:
                missing.append(entry_id)
                continue
            path, _ = resolved[entry_id]
            if not path.exists():
                missing.append(entry_id)
                continue
            gray = load_grey(path)
            boxes = proposer(gray)
            score, box_metrics = score_image(gray, boxes)
            scores.append((entry_id, field_name, score))
            if args.overlays:
                overlay_path = HERE / "out" / f"{entry_id}-{args.rung}.png"
                overlay_path.parent.mkdir(exist_ok=True)
                render_overlay(gray, boxes, overlay_path)
            for m in box_metrics:
                metrics_out.write(
                    format_metrics_row(run_id, entry_id, sha, field_name, args.rung, m) + "\n",
                )
            scores_out.write(
                format_scores_row(run_id, args.rung, entry_id, field_name, score) + "\n",
            )

    verdict = rung_verdict(scores)
    # A silently shrunk probe set would read as a cleaner result than it is.
    if missing:
        print(f"MISSING {len(missing)} images (excluded from the denominator): {', '.join(missing)}")
    print(json.dumps(asdict(verdict), indent=2))
    return 0 if verdict.passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
