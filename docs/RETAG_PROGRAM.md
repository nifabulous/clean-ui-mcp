# Corpus tagging program

This is the operating contract for improving the corpus without turning model
agreement into false ground truth.

## Goals

1. **Stop new guesses.** Missing or unsupported model values stay absent; they
   do not become `dashboard`, `minimal`, fabricated colors, or an exceptional
   quality tier.
2. **Keep evidence attached.** DOM signals are image-hash bound, Pass 2 can see
   the image for new/retagged entries, and field verification survives only when
   the claim is unchanged.
3. **Govern vocabulary.** Unknown categories, styles, components, domains, and
   patterns are quarantined as candidates. They are not canonical taxonomy until
   a curator promotes them deliberately.
4. **Measure before replacing.** A shadow run is immutable and non-mutating;
   labels explicitly say `present`, `none`, or `abstain`, and every label is
   bound to the exact entry image hash.
5. **Serve supported claims only.** Drafts and unverified fields are excluded
   from trust-gated serving and trusted semantic retrieval. Rebuild the index
   after an accepted batch.
6. **Migrate in small, reversible batches.** Exact-ID promotion requires the
   original entry hash, validates the corpus schema, revokes stale verification,
   and leaves the changed entry in draft review.

## Current state

- Safety, OOV quarantine, image/DOM binding, trusted retrieval, shadow diff,
  gold scoring, and exact-ID promotion are implemented.
- `npm run retag-shadow -- --provider <provider>` produces an immutable run under
  `eval/retag-runs/`; it never writes `corpus/`. Add `--gold <labels.json>` to
  bind independent labels to image hashes and write field metrics into the run.
- `npm run retag-promote -- --run <run-dir> --decisions <decisions.json> --out <artifact.json>`
  applies only exact-ID reviewed fields to a draft output artifact. It requires
  the run's persisted `scores.json` to contain an independent gold evaluation,
  verifies candidate/image hashes again, and refuses to overwrite or write
  inside `corpus/`; installing that artifact remains a separate reviewed
  persistence action. `reviewerId` is an audit/process identity for now, not a
  cryptographic signature; signed reviewer identities remain deferred.
- `src/retag-eval.ts` is the scoring contract. It intentionally has no labels in
  the repository: model-generated labels are not silently promoted to truth.
- No corpus-wide retag is authorized until independent gold labels exist and
  the canary gates pass.
- `typePairing` remains a capture-lane field. Existing screenshot-only rows are
  structurally unfillable; future captures must persist DOM font evidence.
- New tagging computes `colorScheme` from image luminance and abstains near the
  threshold; it never falls back to the model. Filling the existing corpus is a
  separate, calibration-gated migration and is intentionally still deferred.
- The current full-corpus decision is recorded and corpus-hash-bound in
  [retag-disposition-v1.json](/Users/olaniyi.oladokun/Downloads/clean-ui-mcp/docs/retag-disposition-v1.json).
  Validate it with `npm run retag-disposition`; regenerate only after an
  intentional corpus change with `npm run retag-disposition -- --write`.

## Worktree workflow

Each workstream gets its own branch and worktree. Agents may work in parallel
when their file sets are independent:

```bash
git worktree add .worktrees/<name> -b codex/<name> HEAD
cd .worktrees/<name>
npm run typecheck:contracts
npx vitest run <focused-tests>
```

Before integration, review the branch diff, run the focused and contract tests,
then cherry-pick the single commit onto the integration branch. Never share a
mutable corpus write between worktrees. The canonical corpus is changed only
by an explicitly reviewed promotion batch.

## Required sequence

```text
independent gold labels
  → frozen baseline and field floors
  → immutable shadow run
  → human review / exact-ID decisions
  → 25-entry canary + restore rehearsal
  → batches with snapshot, schema check, index rebuild, doctor
  → final audit or explicit deferral
```

If a field misses its floor, keep the existing value and record the field as
deferred or fill-only. Do not lower the floor just to make a model pass.
