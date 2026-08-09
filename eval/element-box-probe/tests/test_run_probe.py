from __future__ import annotations

import json

import pytest

from rubric import ImageScore
from run_probe import format_metrics_row, format_scores_row, rung_verdict

FIELDS = ("visual.usesBorders", "visual.usesShadows", "visual.cornerStyle", "visual.spacingDensity")


def _score(ok: bool) -> ImageScore:
    return ImageScore(
        box_count=20, aligned_fraction=1.0 if ok else 0.0, clear_fraction=1.0 if ok else 0.0,
        median_area_ratio=0.01 if ok else 0.0,
        check1_count=True, check2_alignment=ok, check3_margin=ok, check4_area=ok,
    )


def _rows(per_field_ok: dict[str, int], per_field_total: int = 10):
    rows = []
    for f in FIELDS:
        if f not in per_field_ok:
            continue  # a field with no rows exercises the missing-field path
        ok = per_field_ok[f]
        for i in range(per_field_total):
            rows.append((f"{f}-{i}", f, _score(i < ok)))
    return rows


def test_a_rung_passes_only_above_both_bars() -> None:
    v = rung_verdict(_rows({f: 8 for f in FIELDS}))
    assert v.global_fraction == pytest.approx(0.8)
    assert v.passed is True


def test_a_rung_below_the_global_bar_fails() -> None:
    v = rung_verdict(_rows({f: 6 for f in FIELDS}))
    assert v.global_fraction == pytest.approx(0.6)
    assert v.passed is False


def test_a_rung_clearing_the_global_bar_but_missing_one_field_fails() -> None:
    # 9,9,9,4 of 10 -> global 0.775 (over 0.70) but one field at 0.40.
    ok = {f: 9 for f in FIELDS}
    ok["visual.cornerStyle"] = 4
    v = rung_verdict(_rows(ok))
    assert v.global_fraction > 0.70
    assert v.by_field["visual.cornerStyle"] == pytest.approx(0.4)
    assert v.passed is False


def test_the_verdict_names_which_checks_failed_and_how_often() -> None:
    rows = _rows({f: 0 for f in FIELDS})
    v = rung_verdict(rows)
    assert v.failing_checks["check2_alignment"] == 40
    assert v.failing_checks["check1_count"] == 0


def test_an_empty_row_set_fails_rather_than_dividing_by_zero() -> None:
    v = rung_verdict([])
    assert v.passed is False
    assert v.global_fraction == 0.0
    assert v.missing_fields == list(FIELDS)


def test_a_field_with_no_rows_is_reported_missing_not_failed() -> None:
    ok = {f: 8 for f in FIELDS if f != "visual.cornerStyle"}
    v = rung_verdict(_rows(ok))
    assert v.missing_fields == ["visual.cornerStyle"]
    assert v.passed is False
    assert "visual.cornerStyle" not in v.by_field


def test_metrics_row_shape_has_run_id_and_all_box_fields() -> None:
    from rubric import BoxMetrics
    row = json.loads(format_metrics_row(
        "run-1", "e1", "aa", "visual.usesBorders", "classical",
        BoxMetrics(box=(0, 0, 10, 10)),
    ))
    assert row["runId"] == "run-1"
    assert row["entryId"] == "e1"
    assert set(row) >= {"box", "edge_offsets", "edge_magnitudes",
                        "outside_clearances", "area_ratio", "boundary_edges"}


def test_scores_row_keeps_rung_first_and_run_id_last() -> None:
    s = _score(True)
    row = format_scores_row("run-1", "classical", "e1", "visual.usesBorders", s).split("\t")
    assert row[0] == "classical"  # Task 7's `cut -f1 | uniq -c` grouping depends on this
    assert row[-1] == "run-1"
    assert len(row) == 12


def test_run_rung_continues_past_a_failing_entry(tmp_path) -> None:
    # A single image/proposer failure must not abort the run: the failed entry
    # is reported and excluded, the rest are measured, and no partial row for
    # the failed entry reaches the outputs.
    from pathlib import Path

    import numpy as np
    from PIL import Image

    from run_probe import run_rung

    img_a = tmp_path / "a.png"
    img_b = tmp_path / "b.png"
    Image.fromarray(np.full((100, 100), 240, dtype=np.uint8)).save(img_a)
    Image.fromarray(np.full((100, 100), 240, dtype=np.uint8)).save(img_b)
    resolved = {"a": (img_a, "aa"), "b": (img_b, "bb")}

    def flaky(_gray: np.ndarray) -> list:
        raise RuntimeError("ocr boom")

    def good(_gray: np.ndarray) -> list:
        return [(10, 10, 60, 60)]

    metrics = tmp_path / "m.jsonl"
    scores = tmp_path / "s.tsv"
    with metrics.open("w") as mo, scores.open("w") as so:
        s = run_rung(flaky, ["a\taa\tvisual.usesBorders"], resolved, "r1", "flaky", mo, so)
        assert [e for e, _ in s.failed] == ["a"]
        assert s.scores == []

        s2 = run_rung(
            good,
            ["a\taa\tvisual.usesBorders", "b\tbb\tvisual.usesShadows"],
            resolved, "r1", "good", mo, so,
        )
        assert [x[0] for x in s2.scores] == ["a", "b"]
        assert s2.failed == []

    assert metrics.read_text().count("\n") == 2  # one box per good entry, none for the failure
    assert scores.read_text().count("\n") == 2


def test_run_ids_from_two_runs_in_the_same_second_differ() -> None:
    # runId is the dedup key for append-mode outputs. At second resolution two
    # runs in the same second share an id and the committed data cannot be
    # separated by run.
    from run_probe import new_run_id
    assert new_run_id() != new_run_id()


def test_metrics_row_pins_the_full_schema_not_a_subset() -> None:
    # The committed metrics accumulated 14/15/16-key rows across runs and no test
    # caught it, because the shape test asserted a SUBSET of keys.
    import json as _json
    from rubric import BoxMetrics
    from run_probe import METRICS_ROW_KEYS, format_metrics_row
    row = _json.loads(format_metrics_row("r", "e", "sha", "f", "m", BoxMetrics(box=(0, 0, 1, 1))))
    assert set(row) == set(METRICS_ROW_KEYS)
