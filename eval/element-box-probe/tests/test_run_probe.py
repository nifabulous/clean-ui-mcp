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
