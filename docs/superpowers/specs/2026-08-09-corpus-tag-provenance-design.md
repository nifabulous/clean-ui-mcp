# Stop authoring guesses — schema nullability + authoring-time strip

**Date:** 2026-08-09
**Branch:** `feat/deterministic-detectors`
**Status:** ready to implement (Tasks 1–2 only)

## Scope

This spec covers **goal 2** only: stop future additions entering with unverified
or guessed tags. Two tasks, both small, both independently revertable, neither
touching a stored value in the existing 787.

**Goal 1 — repairing the existing corpus — is deliberately not here.** The
`colorScheme` detector and its 765-value fill, the `typePairing` measurement, and
the shadow retag diff moved to
`docs/superpowers/specs/2026-08-09-colorscheme-fill-design.md`. Round 3 of review
put 13 of 16 findings on that work: it writes 765 served values with no gate tying
the write to its own calibration outcome, restales 765 embedding documents, has no
rollback, and its label plan is unsatisfiable as specified. It needs its own
design, and it is sequenced after the retag diff, not before.

## Review history

Three rounds. Round 1: 16 P1s from codex, three of them false factual claims in
the spec. Round 2: 14, of which 11 real — all traceable to one mechanism (an
admission gate), each fix spawning another mechanism needing its own integrity
check. Round 3: 16 real across codex and an eng review, 13 on the fill.

The response each round was structural, not a patch: round 3 cut the gate, and
this round cuts the fill. What survives is the part where every finding is now
concrete.

### Round-3 findings addressed here

| Finding | Fix |
|---|---|
| Task 2's mechanism cannot reach 2 of its 3 authoring sites — `add-entry`'s gated values are **human prompt answers** (`add-entry.ts:335-336`), and the UI POST body is assembled in the browser (`ui/app.js:1309-1313`) | Strip applies to the **assembled entry at creation**, not to tagger output. Task 2 design. |
| `null` is invalid for `colorRoles` and `responsiveBehavior` — optional, not nullable | Clear-mode derived from the schema per field, verified by runtime probe. Task 2 design. |
| A future gated field that can express neither null nor absence would produce an invalid entry (`visual.typePairing` is a required object) | `stripGatedFields` **throws at module init** for any gated field that cannot express absence. Converts the finding into a guard. Task 2 AC 3. |
| Refusing `provenance.verification` breaks the update path, which legitimately round-trips one | Refusal is **create-only**. Task 2 AC 7. |
| `TIER_BY_FIELD` lives in a CLI module no library file imports | Moves to `src/corpus-trust.ts`, re-exported from `verify-corpus.ts` so existing test imports keep working. Task 2, step 0. |
| Task 1's consumer list missed 7 readers, listed one that needs no change, and the resulting AC was vacuous | Every reader enumerated and **classified** fix / already-safe. An allowlist entry alone cannot satisfy the test. Task 1 AC 4-6. |
| `verify-corpus.ts:193-194` renders a null `usesShadows` as `"no shadows are used"` into a verifier prompt | Added to the fix list; returns `null` (skip the claim), not the negative string. Task 1. |
| Line drift (`embeddings.ts:328-330` → the ternary is `:329`; the build-breaking type is `:301`) | Corrected below. |

### Live bugs found during review — recorded, not fixed here

1. **`stampProvenance` destroys verification records on every UI save.**
   `src/scripts/ui-server.ts:161-175` rebuilds `provenance` from four keys
   (`taggedBy`, `capture`, `reviewedBy`, `taggedAt`); the schema declares seven —
   `verification`, `verifyAttempts` and `dataQuality` are dropped. Called at
   `:2145` (create), `:2189` (auto-retag), `:2265` (update). Editing any of the 50
   entries carrying records silently discards them. Fail-closed, so no false
   trust — but it destroys evidence that cost vision calls. Out of scope; own fix.
2. **The stale `36` in `eval/backfill-pilot/measure-luminance.mjs:18-19`.** The
   64×64 path it runs reports 35 below 110; the native path the detectors run
   reports 36. Both numbers are correct for their path and neither is labelled.
   Belongs with the fill spec.

## Governing invariant

**No authoring pass may write a value it cannot have known, and no authoring pass
may write its own verification record.**

Corollaries, checked against both tasks:

1. **Absence must be expressible before it can be written.** Task 1 exists
   entirely to satisfy this for `usesShadows`; a runtime probe confirms the field
   can currently express neither `null` nor omission.
2. **Absence must never render as a negative claim.** A null `usesShadows`
   surfacing as "No shadows" fabricates exactly the claim this spec removes.
3. **Only the verifier writes verification records.**
4. **No stored value in the existing 787 changes.** Both tasks are
   authoring-and-type only. Removing wrong values that serve today is the open
   decision at the end, unresolved on purpose.
5. **Trust is revoked by evidence, never by policy.** `isVerified` ignores
   `verifierVersion` (`src/corpus-trust.ts:75`) and keeps doing so.

## Task 1 — make `null` legal for `usesShadows`

### Why only this field

Of the four fields `TIER_BY_FIELD` declares `"gated"`
(`src/scripts/verify-corpus.ts:121-124`), a runtime probe against the compiled
schema shows three can already express absence:

| gated field | `isNullable()` | `isOptional()` | clear mode |
|---|---|---|---|
| `visual.accentColor` | true | false | `null` |
| `visual.colorRoles` | false | true | omit |
| `responsiveBehavior` | false | true | omit |
| `visual.usesShadows` | **false** | **false** | **neither — blocked** |

So the migration is one line: `src/schema.ts:434`, `usesShadows: z.boolean()` →
`z.boolean().nullable()`. `usesBorders`, `cornerStyle` and `spacingDensity` stay
required — they are model-verifiable and authoring keeps writing them.

(For reference, `visual.typePairing` is also neither — a required object. It is
not gated today. If it is ever gated, Task 2's init guard fires.)

### Type-only; no value changes

All 787 entries carry a boolean `usesShadows`, so `entryToDocument`
(`src/embeddings.ts:329`) produces byte-identical strings and
`corpus/embeddings.json` does not go stale. Only new entries carry null.

### Consumers, enumerated and classified

Enumeration is mechanical (`grep -rn usesShadows src/`), and every non-test
production reader is classified. **A reader may not be listed as already-safe
without the classification being asserted** — that is what made round 2's version
vacuous.

**Must fix — renders absence as a claim (corollary 2):**

| site | current | problem |
|---|---|---|
| `src/embeddings.ts:329` | `usesShadows ? "Uses shadows for depth." : "No shadows; depth via other means."` | null → the false string, into the embedding text |
| `src/scripts/verify-corpus.ts:194` | `v?.usesShadows === true ? "soft shadows are used" : "no shadows are used"` | null → the negative claim, into a verifier prompt. Return `null` to skip the claim. Unreachable today (gated fields are skipped at `:247-256`) but `claimForField` has seven other call sites |
| `src/server-factory.ts:387` | `Shadows: ${entry.visual.usesShadows ? "yes" : "no"}` | null → `"no"` |
| `src/server-factory.ts:668` | same ternary, omitted-field table | null → `"no"` |

**Must fix — type, or the build breaks:**

- `src/embeddings.ts:301` — the parameter type
- `src/tool-contracts.ts` and `src/create-ui-spec-contracts.ts` —
  `z.boolean().optional()` rejects null; becomes `.nullable().optional()`
- `src/tagger.ts` — types `usesShadows: boolean` and coalesces an absent model
  answer to `false`. The coalesce is this spec's bug in miniature: an absent
  answer became a positive claim. Removed; type widens.

**Must fix — display only, no fabrication:**

- `src/scripts/review-draft.ts:91` — `Shadows: ${entry.visual.usesShadows}` is raw
  interpolation, so null renders `"null"`. Not a fabricated claim; still wrong to
  show. Classified display-only so the AC is not satisfied by it.

**Already safe — asserted, not assumed:**

- `src/md3-classifier.ts` — types `boolean | null`, compares `=== true` / `=== false`
- `src/synthesis/context.ts` — types `boolean | null`, guards `!= null`
- `src/create-ui-spec-deterministic.ts` — guards `typeof … === "boolean"`
- `src/c3/safe-aggregator.ts:180-181`, `src/scripts/doctor-helpers.ts:529`,
  `src/create-ui-spec.ts:677`, `src/server-factory.ts:1115`,
  `src/decision-lab.ts:47`, `src/critique-ui.ts` — pass-through or key-name only

### Acceptance criteria

1. `usesShadows: z.boolean().nullable()`. **Never `.default(null)`** — decision D17
   (`src/schema.ts:440`): `persistEntries` round-trips every entry through
   `Corpus.parse → JSON.stringify`, so a default mutates untouched entries on any
   unrelated write.
2. No stored value changes: a test hashes all 787 `usesShadows` values before and
   after and asserts equality.
3. `corpus/embeddings.json` needs no rebuild: a test regenerates
   `entryToDocument` for all 787 and asserts byte-identical output.
4. Each **must-fix** site has an explicit null branch, and a test asserts null
   renders neither the false string nor the negative claim — per site, not once.
   `verify-corpus.ts:194` returns `null`.
5. Both Zod output contracts accept null.
6. A test greps `src/` for non-test production `usesShadows` readers and fails on
   any reader absent from a declared map of `fix` / `already-safe` / `display-only`
   — and for every `already-safe` entry, asserts the null-safety it claims
   (`=== true` / `!= null` / `typeof` guard present). Allowlisting a bug cannot
   satisfy it.
7. `tsc` clean; full suite green.

## Task 2 — authoring writes absence on gated fields

### Step 0 — move the declaration

`TIER_BY_FIELD`, `tierForField` and `VerifierTier` move from
`src/scripts/verify-corpus.ts` to `src/corpus-trust.ts`, which already owns the
trust contract (`VERIFICATION_METHODS`, `SERVABLE_FIELD_KEYS`).
`verify-corpus.ts` **re-exports all three** so existing test imports
(`verify-corpus.test.ts:3-5`) keep working.

Required because nothing in the library imports that CLI module today, and Task 2
needs the declaration from the authoring sites. `corpus-trust.ts` is documented
"PURE AND SYNCHRONOUS BY DESIGN … performs no I/O" (`:10-11`) and is on the serving
path — a literal table is the only thing allowed to land there. **No detector or
`sharp` import may follow it**; import direction is detector → trust, never the
reverse.

### The mechanism

```
GATED_FIELDS        derived from explicit TIER_BY_FIELD entries === "gated"
clearModeFor(field) derived from the schema: nullable → null, optional → omit,
                    neither → throw at module init
stripGatedFields(entry) -> entry with every gated field cleared
```

Two derivations, no hand-maintained second table. Gate a field in future and both
the strip set and its clear mode follow automatically.

**Read `TIER_BY_FIELD` directly; never call `tierForField()`.** That function
returns `"gated"` as the *default* for unclassified fields, so deriving the strip
set from it would clear every field not yet in the table.

### Where it applies — the round-3 correction

Round 2 applied it to tagger output. That is wrong at two of three sites:

- `src/scripts/add-entry.ts:335-336` — the persisted `usesShadows` is a **human
  prompt answer**: `askBool("Uses shadows?", !!taggedVisual?.usesShadows)`.
  Stripping tagger output only changes the wizard's default, and `askBool` returns
  `boolean`, never null.
- `src/scripts/ui-server.ts:2156` (`POST /api/entries`) receives an opaque client
  body; the tagger→entry merge happens in the browser (`ui/app.js:1309-1313`).
  There is no tagger output to strip server-side.

So it applies to the **assembled entry, immediately before persist, at creation
sites only**:

| site | what it is |
|---|---|
| `src/scripts/add-entry.ts:452` | wizard → corpus |
| `src/scripts/commit-draft.ts:170` | draft → corpus (covers `bulk-import.ts:152`, which writes drafts) |
| `src/scripts/ui-server.ts:2145` | `POST /api/entries`, create |

**Not** in `persistEntries`. That function also serves `verify-corpus` record
writes, `dedup-cleanup` and `restore-corpus` — stripping there would clear the
existing 787's values on the next unrelated write, violating corollary 4.

**Not on update or retag.** `ui-server.ts:2189` (`/api/auto-retag`) and `:2265`
(`PUT`) mutate existing entries; clearing their values is the open decision at the
end of this spec, not a side effect of this task.

`add-entry` also stops **asking** the gated questions. Prompting a human for
`usesShadows` is corollary 1 with a human in the loop — the wizard cannot make a
screenshot answer a question the screenshot does not answer.

### No entry arrives pre-verified

Creation sites refuse an entry carrying a `provenance.verification` map, naming
the keys found. Only `verify-corpus.ts` writes records (corollary 3).

Create-only, per round 3: the `PUT` path legitimately round-trips a stored map for
the 50 entries that have one. (Note it does not actually reach persist today —
`stampProvenance` drops it first. That is the live bug recorded above, and fixing
it is what makes this refusal's create/update split load-bearing rather than
theoretical.)

### The provenance lie

`src/scripts/add-entry.ts:409` stamps `provenance: { taggedBy: "human" }` and
`reviewStatus: "approved"` on an entry whose fields came from the vision tagger at
`:172`. With gated fields cleared, the rest are still model-authored and
`taggedBy` must say so.

### Acceptance criteria

0. `TIER_BY_FIELD` / `tierForField` / `VerifierTier` live in `corpus-trust.ts`;
   `verify-corpus.ts` re-exports all three; `verify-corpus.test.ts` passes
   unchanged. A test asserts no production module under `src/` outside
   `src/scripts/` imports from `src/scripts/verify-corpus.ts`, and that
   `corpus-trust.ts` imports nothing from `src/verify/`.
1. `GATED_FIELDS` derives from explicit `"gated"` entries. A test asserts adding a
   gated entry extends the set with no code change, and that an unclassified field
   is **not** included.
2. `clearModeFor` derives from the schema: `null` for nullable, omit for
   optional-only.
3. Module init **throws** for a gated field that can express neither, naming it. A
   test asserts the throw (using `visual.typePairing`, which is exactly that
   shape).
4. `stripGatedFields` clears all four: `usesShadows` → null, `accentColor` → null,
   `colorRoles` → omitted, `responsiveBehavior` → omitted. The result parses
   against `CorpusEntry`.
5. All three creation sites apply it. A test per site asserts an entry assembled
   with `usesShadows: true` and `accentColor: "#3d1ae0"` persists with both
   cleared.
6. `add-entry` no longer prompts for gated fields; `tagger.ts` no longer coalesces
   `usesShadows` to `false`.
7. Creation sites refuse an incoming `provenance.verification`, naming the keys. A
   test asserts the refusal, and asserts the **update** path is not refused.
8. A test asserts no production module except `verify-corpus.ts` writes a
   `provenance.verification` record.
9. `add-entry` stops claiming `taggedBy: "human"` for tagger-authored fields.
10. Existing entries untouched: a test persists a loaded fixture through
    `persistEntries` and asserts byte-identical output, proving the strip is not on
    that path (corollary 4).
11. End-to-end: an entry added through each creation site serves no gated field —
    `isVerified` false and the value absent. This is the AC that proves goal 2,
    and it is a behaviour assertion, not a count.

## Testing

- Corpus isolation throughout: test-path injection
  (`setCorpusForTesting`, `setDecisionsPathsForTesting`), never the real
  `corpus/entries.json`.
- New exports need a production caller or a `src/wiring-verification.test.ts`
  allowlist entry with a reason. Note that test excludes `src/scripts/`, so
  anything added there is unguarded — hand-trace it in the branch review.
- Task 1's value-hash and embedding-text tests read the real corpus **read-only**;
  they assert equality, they do not write.

## Risks

1. **Null falls through to a false branch in a consumer.** The whole point of
   corollary 2. Mitigated by AC 4 (per-site assertion) and AC 6 (the grep test
   that will not accept an allowlist entry in place of a fix). Round 2's
   hand-written list missed 7 readers, which is why enumeration is mechanical.
2. **Task 2 lands before Task 1 and produces invalid entries.** The probe shows
   `usesShadows` can express neither null nor absence today, so `stripGatedFields`
   would throw at init. That is the designed failure — loud, not silent — but the
   task order is a hard dependency, not a preference.
3. **The strip reaches a non-creation path.** Would clear the existing 787.
   Mitigated by AC 10's byte-identical `persistEntries` assertion.
4. **New entries carry nulls where old ones did not**, so the corpus becomes mixed.
   This is intended, and it is what AC 11 asserts is safe end-to-end.

## Open decision — not made here

Neither task removes the measured-wrong values already serving. `usesShadows` is
recorded on 787/787 and measured 6/10 wrong on hand labels (n=10, directional):

- **(a) Leave all 787.** No re-embed, no served-output change. The field keeps
  serving at that error rate, and since it is `gated`, nothing will ever verify it.
- **(b) Clear `usesShadows` where unverified** — the ~768 entries with no
  verification record; the 19 with records keep their values. Requires an
  embeddings rebuild (`embeddings.ts:329` reads the field).

Recommendation: **(b)**. 60% wrong is worse than absent, and no lane will ever
adjudicate the other 768. `accentColor` at 5/11 wrong is too thin to act on until
the retag diff lands.

Corpus owner's call, deliberately open. **No task in this spec achieves the repair
goal** — Tasks 1–2 stop new bad data and make absence expressible; only this
decision removes wrong values that serve today.

## Out of scope

- The `colorScheme` detector, its 765-value fill, the `typePairing` measurement and
  the shadow retag diff — `2026-08-09-colorscheme-fill-design.md`.
- `claimHash` (value-bound verification records). Needed before any retag that
  **overwrites**. Requirements are recorded in the fill spec so the deferral loses
  nothing.
- The `stampProvenance` trust-map wipe and the stale luminance comment — both
  recorded above.
- `mood`: no controlled vocabulary, so no value is falsifiable.
- Consensus fill for `components` / `domainTags`: needs a gold set first, and the
  parked-disagreement queue (~800–1,500 tags) sized before running.
