# Element-box probe

Answers one question: would a box proposer produce boxes the four
element-dependent detectors (`visual.usesBorders`, `visual.usesShadows`,
`visual.cornerStyle`, `visual.spacingDensity`) could measure *inside*?

Not "are the boxes semantically correct". Only whether they are geometrically
usable. Design: `docs/superpowers/specs/2026-08-08-element-box-probe-design.md`.

## Run

    uv venv --python 3.12 .venv
    uv pip install --python .venv/bin/python -r requirements.txt
    .venv/bin/python run_probe.py --rung classical

Rung 2 additionally needs `-r requirements-rung2.txt` (~1-2GB of model weights).

## Outputs

| path | tracked | contents |
|---|---|---|
| `metrics.jsonl` | yes | one row per (method, image, box) — coordinates, every raw metric, and the runId that produced it |
| `scores.tsv` | yes | per (method, image) the four check results |
| `out/` | **no** | overlay PNGs, local inspection only |

`out/` is untracked because overlays are private corpus screenshots with boxes
drawn on them. Coordinates are geometry, not pixels, and carry the same exposure
as `eval/verdicts/labels.jsonl`, which already commits paths and hashes.

## Thresholds

Pre-declared guesses, from the failure magnitudes in
`docs/verifier-calibration.md`. `metrics.jsonl` holds the raw distributions, so a
badly-placed threshold can be re-judged without re-running anything.
