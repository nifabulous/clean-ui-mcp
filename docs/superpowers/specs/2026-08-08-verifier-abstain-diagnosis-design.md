# Verifier Abstain Diagnosis — Design

**Status:** Proposed
**Date:** 2026-08-08
**Scope:** `src/scripts/verify-corpus.ts` telemetry only. Adds a machine-readable
cause to every model-lane abstain and a read-only run mode that can re-measure an
already-processed cohort. Changes no verdict, writes no corpus data.

## Context

The 2026-08-08 cohort run (`npm run verify -- --limit 50 --detectors on`,
`minimax/MiniMax-M3`, verifier-v1) produced 1056 field verdicts. Grouped by
reason string, the six largest buckets (the remainder are per-assertion prose
passes and the two smaller contradiction reasons):

```
298  gate     no recorded value to verify
244  abstain  not positively confirmed
240  pass     positively confirmed against the image
 48  abstain  detector abstained
 14  abstain  model disagreed with itself across two fresh asks
 12  gate     no checkable assertions enumerated — vacuous confirmation refused
```

`not positively confirmed` is the single largest model-lane outcome, and it is a
**constant string**. `decideFieldVerdict` (`src/scripts/verify-corpus.ts:341-343`)
emits it whenever `parsed.confirmed` is false, and `parsed` arrives from
`parseVerifyResponse` via the `failClosed` Proxy
(`src/scripts/verify-corpus.ts:270-281`), which manufactures
`{ confirmed: false, contradicted: false }` for any key not present. Seven
physically distinct situations therefore print one sentence — including an
unparseable whole response, a field the model silently dropped, and a genuine
refusal to confirm.

The model already returns a per-field `reason` string (the prompt requests it,
`src/scripts/verify-corpus.ts:245`), `parseVerifyResponse` already captures it
(`src/scripts/verify-corpus.ts:312`), and `decideFieldVerdict` discards it.

One cause is already measurable from the committed report without a re-run: an
unparseable response makes every field on that entry abstain at once. Three of 48
entries show that signature (`origin-origin-4`, `hume-hume-26`, `anima-anima`),
accounting for 34 of the 256 abstains on model-lane fields — 13%. The other 87%
are per-field
abstains on entries where the model answered other fields normally, so the
dominant cause is per-field and the report cannot name it.

### Why this is the next thing to build

Three rationales for further deterministic-detector work were measured against
the corpus and none survived:

- **Independent contradiction.** The two enabled detectors are not independent
  witnesses. `platform` (`src/verify/detectors/platform.ts:12-23`) recomputes
  `detectPlatform(entry.image.width, entry.image.height)` and compares it to
  `entry.platform` — a pure function of a recorded field checking a record
  derived from that same function. In the cohort, 0 of 50 entries carried a
  recorded `platform`, so it abstained 48/48 and produced no verdicts.
  `visual.dominantColors` compares the extractor's output against a record that
  *is* that extractor's output on the same pixels; `docs/verifier-calibration.md`
  already records this as "100% by construction". Both detect hand-edits to
  `corpus/entries.json`, not measurement error.
- **Coverage.** Deterministic measurement of the five perception fields could
  reach at most 122 of 306 abstains: accentColor 37 + usesShadows 30 +
  spacingDensity 20 + cornerStyle 19 + usesBorders 16. Element-localised
  detection specifically covers 85 of those — `accentColor` is Class B in
  `docs/verifier-calibration.md` and needs a new role rule, not element
  detection. The other 184 abstains are taxonomy, layout, prose, and `platform`.
- **Cost.** Model calls are per entry (verify + re-produce passes ≈ 3.2–3.4),
  not per field, and prose fields always need the model. A detector changes
  which lane writes a verdict, not the call count.

The DOM route is also closed for this corpus: 422 of 787 entries carry
`source.url`, but across only 8 hosts with 1 deep path — they are bare product
origins (`https://alan.com`, `https://mercury.com`), while the screenshots are
internal application screens behind auth. The URL is provenance, not a
reproducible render target.

That leaves the model lane, and its largest bucket is a sentence that means
seven different things. Naming them is a prerequisite for deciding whether the
lane deserves investment at all.

## Governing invariant

> A diagnosis run produces measurement and nothing else: identical verdicts,
> byte-identical `corpus/entries.json`, no schema change.

Every acceptance criterion below is checked against this. The invariant is
load-bearing because the run deliberately re-processes fields the resume
bookkeeping has already marked done — the only thing making that safe is that it
cannot write.

## Design

### 1. Cause taxonomy

Seven mutually exclusive causes, one per real branch in `parseVerifyResponse`:

| cause | branch | meaning |
|---|---|---|
| `response-unparseable` | `JSON.parse` throw, `:289` | whole entry silent |
| `response-not-object` | `:292` | whole entry silent, different cause |
| `field-absent` | `failClosed` Proxy default, `:275` | model answered others, dropped this |
| `field-not-object` | `:294` | key present, value not an object |
| `verdict-missing` | `verdict === undefined` at `:305` | returned `{reason: …}`, no verdict |
| `verdict-unrecognised` | verdict string, not one of three | contract mismatch |
| `model-abstained` | `verdict === "abstain"` | genuine refusal |

The first six are defects with cheap fixes. Only `model-abstained` is evidence
about the model lane's ceiling, and only for it does the model's own `reason`
text exist to be read.

Two further abstains are set directly in `verifyEntry`, bypassing
`decideFieldVerdict`, and are tagged for a complete total:

| cause | site | existing reason text |
|---|---|---|
| `corroboration-split` | `:610-615` | "model disagreed with itself across two fresh asks…" |
| `corroboration-error` | `:594-599` | "model contradiction could not be corroborated: …" |

`verdict-unrecognised` carries the literal offending string. `model-abstained`
carries the model's `reason`. For prose-tier abstains the enumerated assertion
count is carried as a detail — a prose field that listed assertions but confirmed
none is a different situation from one that listed many; it is not a separate
cause because the assertion-empty case already gates
(`:328-330`).

### 2. Code changes

Three additive edits in `src/scripts/verify-corpus.ts`:

1. **`ParsedField` gains `cause?: AbstainCause`**, set at parse time.
   `failClosed` takes the default cause as a parameter (`failClosed(out, cause)`)
   so the Proxy default can report `field-absent` while the two whole-response
   failure sites report their own cause.
2. **`FieldVerdict` gains `cause?: AbstainCause`.** `decideFieldVerdict` sets it
   on abstains and appends the model's `reason` to the reason string when one is
   present. Both `verifyEntry` sites that construct an abstain directly set their
   own cause.
3. **`buildRunReport` emits an abstain-cause breakdown**, alongside the existing
   per-detector lines.

No verdict changes. `"not positively confirmed"` appears once more in the repo,
as a fixture input in `src/scripts/verify-corpus.test.ts:739`; the reason string
for a `model-abstained` abstain becomes `not positively confirmed — <model
reason>`, so that fixture needs no change but the new assertions must not assume
a bare constant.

The cause is **not persisted**. `provenance.verifyAttempts` is `.passthrough()`
(`src/schema.ts:652-655`), so promoting it later is one line, but a diagnosis run
writes nothing.

### 3. Run mode

The cohort's fields are already stamped at `verifier-v1`, and the skip lives in
two places:

- `selectPending` (`:802-821`, called at `:1177`) drops an entry entirely when
  every servable field is processed at this version.
- the per-field `pending` filter (`:447-453`) drops each processed field.

`--dry-run` gates only the corpus write (`:1343`, `:1374`) and neither skip, so
`--dry-run` alone makes zero model calls on this cohort.

A single flag, `--diagnose`, bypasses both skips **and** implies dry-run. One
flag rather than two orthogonal ones so no half-set state exists and the
invariant is directly testable.

```bash
npm run verify -- --limit 50 --detectors on --diagnose
```

Re-runs the same 48-entry cohort — comparable to the committed report and
inclusive of the three total-silence entries. Cost ≈160 model calls; the
re-produce path still fires (a call, not a write).

**Stated limit:** model verdicts flip 14–18% between identical runs
(`src/scripts/verify-corpus.ts:574`). The causes are measured on a fresh run, not
on the exact verdicts in the committed `verify-report.md`. The output is a rate,
not a per-verdict autopsy.

### 4. Pre-registered decision rule

Fixed before the numbers land, so the result cannot be re-litigated after:

- **`model-abstained` < 50% of abstains** → the lane is mostly defects. Fix the
  parser and prompt contract, re-measure. Model-lane investment is cheap and
  justified.
- **≥ 50%, reasons cluster on "cannot determine from one screenshot"** → those
  fields are genuinely unverifiable from a single image. The honest response is
  reclassifying them to the `gated` tier, not asking harder.
- **≥ 50%, reasons cluster on hedging ("appears to be", "likely")** → prompt and
  consensus work has real headroom, and the model-lane harness is worth building.

Reason clustering is a manual read of the collected strings, recorded verbatim in
the output document. No automated clustering.

### 5. Output

New file `docs/verifier-abstain-diagnosis.md`:

- cause breakdown table with counts and percentages
- per-field cause split
- the collected `model-abstained` reason strings, verbatim
- which branch of the decision rule fired, and the resulting decision

Not appended to `docs/verifier-calibration.md`. That file's claims are about
detector calibration against a frozen label set; appending model-lane numbers
would blur what its floors rest on.

### 6. Testing

TDD, failing test first, per project convention:

- seven unit tests on `parseVerifyResponse`, one per cause, each asserting the
  right discriminator from a crafted raw response
- two unit tests on the `verifyEntry` corroboration abstains, asserting
  `corroboration-split` and `corroboration-error`
- one test asserting `--diagnose` leaves `corpus/entries.json` byte-identical
  (corpus-isolated via the existing test-path injection, never the real corpus)
- one test asserting `--diagnose` re-queues an entry whose fields are all stamped
  at the current version — the skip bypass, without which the run measures
  nothing
- one test asserting the report's breakdown block sums to the reported abstain
  count

## Out of scope

- No change to any verdict outcome.
- No corpus writes; no `VERIFIER_VERSION` bump.
- No schema change.
- No prompt change — what to change about the prompt is what this measures.
- No new or re-enabled detectors.
- No corpus backfill for the 298 gated fields. That is the largest number on the
  board (five fields are recorded on ~3% of 787 entries: domainTags 14, mood 22,
  colorScheme 22, components 23, typePairing 0 usable) but it is tagger work, and
  mixing it in would make neither result interpretable.

## Risks

1. **The re-run's verdicts differ from the committed report.** Accepted and
   stated: 14–18% flip rate. The measurement is a rate over a fresh run.
2. **`model-abstained` reasons may be uninformative** (empty strings, or
   restatements of the claim). If so, the decision rule's second and third
   branches cannot be distinguished, and the honest outcome is to record that the
   prompt does not elicit usable reasons — itself a finding about the lane, and a
   cheap prompt fix to test next.
3. **`--diagnose` bypassing resume bookkeeping is the one genuinely dangerous
   part.** It is safe only because the same flag forces dry-run. The
   byte-identical test is the control; it must fail if the two behaviours are
   ever decoupled.
