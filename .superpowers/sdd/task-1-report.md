# Task 1 Report — Two-set `TrustGatedCorpusReader`

**Branch:** `feat/field-set-gating`
**Commit:** `9840b30` — "feat(trust): two-set TrustGatedCorpusReader — core gates, enrichment deferred to renderer"
**Plan:** `docs/superpowers/plans/2026-08-06-field-set-gating-2d1.md` (Task 1)
**Brief:** `.superpowers/sdd/task-1-brief.md`

## What I implemented

In `src/corpus-trust-reader.ts`, replaced the single-set constructor, the `fields`
field, and `passes` (the brief's stated `src/corpus-trust-reader.ts:34-62` range) with
the brief's two-set implementation, verbatim:

- New constructor signature: `(inner: CorpusReader, core: readonly string[], enrichment?: readonly string[])` with `enrichment` defaulting to `[]`.
- Private storage `_core` / `_enrichment`, exposed via read-only getters `core` and `enrichment` (no public setter — read-only accessors).
- Guards preserved: double-wrap refusal unchanged; the empty-set guard now keyed on `core.length === 0` with message "requires at least one core field".
- `passes(entry)` now evaluates `this._core.every(...)` only — enrichment no longer gates inclusion.
- All gated methods (`search`, `searchRanked`, `getById`, `findSimilar`, `entriesForAggregation`, `getImageIndex`) and ungated methods (`refusedForTrust`, `trustPosture`, taxonomy lists, `indexStatus`, `resolveImagePath`) untouched.

Also updated the class doc comment's field-set sentence so the prose matches the
two-set reality: the paragraph now reads "against the CORE fields the tool
hard-gates on (enrichment is projected at the render boundary). An entry is
returned only when EVERY core field in the set is verified — the conservative
reading, and the one that cannot over-serve."

No other files were modified (no `server-factory.ts` change).

## TDD Evidence

### RED

**Command:** `npx vitest run src/corpus-trust-reader.test.ts` (with the five new
tests appended, before implementing).

**Output (abridged):**

```
× exposes core and enrichment as read-only accessors
AssertionError: expected undefined to deeply equal [ 'critique' ]     ← r.core
× refuses an empty CORE set at construction
AssertionError: expected [Function] to throw error matching /at least one core field/i
  Received: "TrustGatedCorpusReader requires at least one field; ..."
Tests  2 failed | 21 passed (23)
```

**Why expected:** the old single-set constructor:
1. had no `core`/`enrichment` accessors (so `r.core` was `undefined`), and
2. threw the old "at least one field" message, failing the new brief's
   `/at least one core field/i` regex.

The other three new tests passed at RED time because vitest transpiles without
type-checking and the old constructor ignored the extra enrichment argument —
not because the behavior existed. They still functioned as design checks, and the
concat were confirmed GREEN after implementation.

### GREEN

**Command:** `npx vitest run src/corpus-trust-reader.test.ts`

**Output:**

```
✓ src/corpus-trust-reader.test.ts (23 tests)
Test Files  1 passed (1)
     Tests  23 passed (23)
```

All 18 pre-existing tests still pass (single-set constructions default
`enrichment` to `[]`, preserving byte-for-byte full-AND behavior) plus the 5 new
core/enrichment tests.

### Reconciliation: pre-existing test's regex (plan-internal inconsistency)

The pre-existing test at `src/corpus-trust-reader.test.ts:228-230`
("refuses an empty field set at construction") originally asserted the old
message via `/at least one field/i`. The plan's new constructor message is
"**at least one core field**"; the regex `/at least one field/i` does NOT match
("core" sits between "one" and "field"). The plan (Global constraints + Task 1
Step 3) mandates the new "core field" message, and the plan's own new test
asserts `/at least one core field/i`. Correct resolution: update the pre-existing
test to the plan's new wording — the error message stays exactly as the brief specifies. Done: `/at least one core field/i`.

## TypeScript

**Command:** `npx tsc --noEmit`

**Not clean:** 4 errors, all in `src/server-factory.ts`:

```
src/server-factory.ts(161,51): error TS2339: Property 'fields' does not exist on type 'TrustGatedCorpusReader'.
src/server-factory.ts(194,30): error TS2339: Property 'fields' does not exist on type 'TrustGatedCorpusReader'.
src/server-factory.ts(219,78): error TS2339: Property 'fields' does not exist on type 'TrustGatedCorpusReader'.
src/server-factory.ts(388,29): error TS2339: Property 'fields' does not exist on type 'TrustGatedCorpusReader'.
```

These are the four `gate.fields` consumers (`emptyCorpusMessage`,
`unresolvedIdsMessage`, `corpusEvidenceNote`, and the image-attach condition in
`registerGetUiExample`). The plan's Global Constraints explicitly scope the
compile gate: "TypeScript must compile (`npx tsc --noEmit`) **after Task 3** and
at the end" — Task 1 ships the reader change that removes `fields`, and Task 3
rewrites those four consumers onto `core`/`enrichment`. This is the expected
intermediate state, not a regression introduced by Task 1. Per the task's "Do
NOT modify any other files" constraint, `server-factory.ts` was left untouched.

## Files changed

- `src/corpus-trust-reader.ts` — two-set constructor + accessors + `passes`; doc-comment field-set sentence.
- `src/corpus-trust-reader.test.ts` — appended 5-test `core/enrichment split (2d-1)` describe block; updated the 1 pre-existing empty-set regex to `at least one core field`.

`git diff --stat`: 2 files, +96/-13.

## Self-review findings

1. **Read-only accessors confirmed non-mutable:** `core`/`enrichment` are getters over `private readonly` backing arrays; no setter exported. The brief's "read-only accessors" requirement holds.
2. **Default `enrichment = []` preserves old single-set semantics:** every existing full-AND construction passes through with `_enrichment = []`, verified by all 18 pre-existing tests remaining green.
3. **Invariant intact:** `passes` still gates on `_core.every(...)` — no way for an unverified core field to pass; the "at least one core field" guard prevents the vacuous-`every` fail-open.
4. **No dangling references to `fields` in the reader itself:** grep for `fields` in `corpus-trust-reader.ts` returns only the new `core`/`enrichment` JSDoc and the `_enrichment`/`core` accessor names. The four lingering `gate.fields` references are exclusively in `server-factory.ts`, owned by Task 3.
5. **Test imports:** `CorpusReader` and `CorpusEntryT` were already imported in the test file; no import additions needed, and none were added.

## Issues / concerns

- The `tsc --noEmit` non-clean state is **by design** for after Task 1 (carryover
  to Task 3). It should be noted in the Task 3 report that Task 3 is the gate
  that restores a clean compile.
- One pre-existing test's regex had to be aligned with the plan's mandated
  message (see "Reconciliation" above). This is a plan-internal inconsistency
  that the plan's own wording resolves; the source error message was not changed.
- Review artifacts: none written. The commit was not blocked by any git review
  hook (commit `9840b30` landed with the `prepare-commit-msg` gates passing;
  no `ZCODE_BYPASS_REVIEW` used). Later branch-level review remains for the
  overall feature per the branch workflow.