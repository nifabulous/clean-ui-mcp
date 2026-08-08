# Disputed-verdict benchmark

Raw data behind the numbers in
`docs/superpowers/specs/2026-08-07-deterministic-detectors-design.md` ("Why this
exists"): 28 disputed claims from the corpus-verifier benchmark, each labelled
with four models' verdicts (sonnet5, haiku45, gpt54mini, minimax).

- Source: `/tmp/disputes.tsv`, dated 2026-08-06 (file mtime), 224 lines.
- Columns: `entry`, `field`, then one column per model; cell values are
  `pass` / `fail` verdicts.
- Methodology gaps to fill when the frozen labelled ground-truth set work
  (TODOS.md) starts: exact prompts, provider routing, image hashes for the 28
  entries, and the hand labels for these claims. Until then the file is the
  raw record, not a labelled set.

## Data loss (2026-08-08) — the raw rows are gone

**`eval/verdicts/disputes.tsv` does not exist in this repo, and the original
at `/tmp/disputes.tsv` no longer exists either.** The benchmark run predates
the deterministic-detectors branch; the file was never committed before
`/tmp` was cleared. This is exactly the loss the spec's benchmark-provenance
note warned about: "or the numbers cannot be reproduced and the benchmark is
lost."

What survives (committed):

- The figures the benchmark produced, as prose in the spec's "Why this
  exists" section: 5/28 flips (18%) between two byte-identical runs, 4/28
  flips at pinned `temperature: 0` (14%), ~62% best accuracy, the 3.6-point
  same-model-twice gap, 11/28 unsupported.
- The 82 real-screenshot human labels at `eval/verdicts/labels.jsonl`
  (the calibration set from the plan's Task 13B, same JSONL labelling
  contract the frozen ground-truth TODO defines).
- The detector calibration numbers derived from those labels
  (`docs/verifier-calibration.md`).

**Recovery path:** re-run the 28-claim comparison (entry ids, fields, and the
four-model verdict protocol as recorded in the spec) and commit the result as
`eval/verdicts/disputes.tsv` with this README's column contract. Until then,
treat any citation of the 5/28 or 11/28 figures as prose, not evidence, and
do not invent rows to fill the file — a fabricated benchmark is worse than a
documented gap.

**Why the file exists with no rows:** honesty. An empty-but-claimed TSV and a
missing TSV are the same file; the difference is whether the gap is visible.
It is visible here, in the plan's Task 1, and in TODOS.md's frozen-set TODO.
