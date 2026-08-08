"""Pin the probe set from the frozen label file.

Committed as `entries.txt` (entryId + sha256 only). Image paths in
labels.jsonl are absolute machine paths and are never committed; run_probe.py
resolves them at runtime.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ELEMENT_FIELDS: tuple[str, ...] = (
    "visual.usesBorders",
    "visual.usesShadows",
    "visual.cornerStyle",
    "visual.spacingDensity",
)


def build_entries(labels_path: Path) -> list[tuple[str, str, str]]:
    """(entryId, imageSha256, field) for each distinct entry with an element label."""
    seen: dict[str, tuple[str, str, str]] = {}
    for line in labels_path.read_text().splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        if row["field"] not in ELEMENT_FIELDS:
            continue
        if row["entryId"] in seen:
            continue
        seen[row["entryId"]] = (row["entryId"], row["imageSha256"], row["field"])
    return [seen[k] for k in sorted(seen)]


if __name__ == "__main__":
    repo_root = Path(__file__).resolve().parents[2]
    rows = build_entries(repo_root / "eval" / "verdicts" / "labels.jsonl")
    out = Path(__file__).with_name("entries.txt")
    out.write_text("".join(f"{a}\t{b}\t{c}\n" for a, b, c in rows))
    print(f"wrote {len(rows)} entries to {out}", file=sys.stderr)
