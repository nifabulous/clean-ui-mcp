import json
from pathlib import Path

from build_entries import ELEMENT_FIELDS, build_entries


def test_selects_only_element_dependent_fields(tmp_path: Path) -> None:
    labels = tmp_path / "labels.jsonl"
    labels.write_text("\n".join(json.dumps(row) for row in [
        {"entryId": "a", "imagePath": "/x/a.png", "imageSha256": "aa", "field": "visual.usesBorders"},
        {"entryId": "b", "imagePath": "/x/b.png", "imageSha256": "bb", "field": "visual.accentColor"},
        {"entryId": "c", "imagePath": "/x/c.png", "imageSha256": "cc", "field": "visual.cornerStyle"},
    ]) + "\n")
    rows = build_entries(labels)
    assert [r[0] for r in rows] == ["a", "c"]


def test_deduplicates_on_entry_id_keeping_the_first_field(tmp_path: Path) -> None:
    labels = tmp_path / "labels.jsonl"
    labels.write_text("\n".join(json.dumps(row) for row in [
        {"entryId": "a", "imagePath": "/x/a.png", "imageSha256": "aa", "field": "visual.usesBorders"},
        {"entryId": "a", "imagePath": "/x/a.png", "imageSha256": "aa", "field": "visual.usesShadows"},
    ]) + "\n")
    rows = build_entries(labels)
    assert len(rows) == 1
    assert rows[0] == ("a", "aa", "visual.usesBorders")


def test_output_is_sorted_by_entry_id(tmp_path: Path) -> None:
    labels = tmp_path / "labels.jsonl"
    labels.write_text("\n".join(json.dumps(row) for row in [
        {"entryId": "z", "imagePath": "/x/z.png", "imageSha256": "zz", "field": "visual.usesBorders"},
        {"entryId": "a", "imagePath": "/x/a.png", "imageSha256": "aa", "field": "visual.usesBorders"},
    ]) + "\n")
    assert [r[0] for r in build_entries(labels)] == ["a", "z"]


def test_the_four_element_fields_are_exactly_these() -> None:
    assert set(ELEMENT_FIELDS) == {
        "visual.usesBorders", "visual.usesShadows",
        "visual.cornerStyle", "visual.spacingDensity",
    }
