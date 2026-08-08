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
are per-field abstains on entries where the model answered other fields normally,
so the dominant cause is per-field and the report cannot name it.

### Why this is the next thing to build

Three rationales for further deterministic-detector work were measured against
the corpus. None of them justifies building element detection *ahead of* this
diagnosis:

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
  detection covers 85 of those for certain, and the remaining 37 (`accentColor`,
  Class B) only if a screen parser can identify the primary interactive element —
  open, see "Parallel track". The other 184 abstains are taxonomy, layout, prose,
  and `platform`.
- **Cost.** Model calls are per entry (verify + re-produce passes ≈ 3.2–3.4),
  not per field, and prose fields always need the model. A detector changes
  which lane writes a verdict, not the call count.

The DOM route is also closed for this corpus: 422 of 787 entries carry
`source.url`, but across only 8 hosts with 1 deep path — they are bare product
origins (`https://alan.com`, `https://mercury.com`), while the screenshots are
internal application screens behind auth. The URL is provenance, not a
reproducible render target.

So the model lane is where the addressable volume is, and its largest bucket is a
sentence that means seven different things. Naming them is a prerequisite for
deciding whether the lane deserves investment — and it also sizes the element
detection question rather than replacing it. If the abstains are mostly defects,
the model lane improves for near-zero cost and element detection's marginal value
falls. If they are genuine "cannot determine from one screenshot", element
detection becomes *more* attractive, because that is exactly the case where a
pixel measurement beats asking the model again. The box-quality probe (see
"Parallel track") runs alongside and is gated by neither outcome.

## Governing invariant

> A diagnosis run produces measurement and nothing else: no verdict LOGIC
> changes, `corpus/entries.json` is byte-identical, no schema change.

"No verdict logic changes" is the precise claim — not that a diagnosis run
reproduces the committed report's verdicts. It cannot: the model flips 14–18%
between identical runs. What must hold is that for a given parsed response, every
branch returns the same verdict it returns today; only the reason string and the
new `cause`/`site` fields differ.

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

#### Call site

An entry makes up to three vision calls — the combined initial ask (`:554`), the
per-field corroboration ask (`:585-588`), and the post-re-produce re-verify
(`:655`). A bare `response-unparseable` on a field does not say which one failed,
and they have different fixes. Every cause therefore carries a `site` of
`initial` | `corroborate` | `reverify`.

#### Prose fields get two causes

`decideFieldVerdict` runs twice for a prose field that first abstained: once on
the recorded value, then again on the re-produced value (`:662`). The second
call's cause is the one that survives into the verdict, so recording only it
would hide every first-ask cause behind a re-produce that failed for a different
reason. Prose abstains carry `cause` (final) and `firstCause` (the initial ask).
The breakdown table reports both columns; only `cause` is counted in the total,
so the total still equals the abstain count.

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

**`--limit` cannot select the cohort.** `main` slices `selectPending(...)` by
`--limit` (`:1177`). With the skip bypassed, `selectPending` returns every entry
carrying an image path in corpus order, so `--limit 50` takes the first 50 in
that order — which is **not** the cohort. Measured: 0 of 50 positional matches
between the committed report's entries and the first 50 with-image entries, and
2 entries differ in set membership. The original run's cohort was the first 50
*unprocessed* entries at that moment; that set is not reconstructible from an
order-plus-count.

`--diagnose` therefore takes an explicit id list, `--only-ids`, seeded from the
committed report:

```bash
npm run verify -- --detectors on --diagnose \
  --only-ids "$(grep '^## ' verify-report.md | cut -c4- | paste -sd, -)"
```

Order-independent, exactly reproducible, and the comparison to the committed
report is like-for-like. An id in the list that is not in the corpus fails
loudly rather than being silently skipped — the same rule `--retriage` already
applies to entry ids (`:1188-1189`). Cost ≈160 model calls; the re-produce path
still fires (a call, not a write).

**Stated limit:** model verdicts flip 14–18% between identical runs
(`src/scripts/verify-corpus.ts:574`). The causes are measured on a fresh run over
the same entries, not on the exact verdicts in the committed
`verify-report.md` — a field that abstained there may pass here and vice versa.
The output is a cause breakdown of *this run's* abstains, whose count will not
equal 244. It is a rate, not a per-verdict autopsy of the committed report.

### 4. Pre-registered decision rule

Fixed before the numbers land, so the result cannot be re-litigated after.

The earlier draft of this rule branched on whether `model-abstained` was above or
below 50% of abstains. That was wrong: it made two independent questions share
one threshold, and it made a cheap fix wait on a share it does not depend on.
Fixing a parser defect is worth doing at any rate. The rule is therefore two
independent rules.

**Rule 1 — defects (absolute, share-independent).** Any of the six defect causes
with **n ≥ 10** in this run is fixed, whatever fraction of abstains it
represents. Ten is the point at which a cause is not a one-entry fluke on a
48-entry cohort; the fixes (parser branch, prompt contract) are hours, so the bar
is deliberately low. Causes below 10 are recorded and left.

**Rule 2 — lane headroom (reason-text, count-independent).** Read the collected
`model-abstained` reason strings and classify each:

- clusters on **"cannot determine from one screenshot"** → those fields are
  genuinely unverifiable from a single image. The honest response is
  reclassifying them to the `gated` tier, not asking harder.
- clusters on **hedging** ("appears to be", "likely") → prompt and consensus work
  has real headroom, and the model-lane harness is worth building.
- **reasons are empty or restate the claim** → the prompt does not elicit usable
  reasons. That is itself a finding, and a cheap prompt fix to test next.

The two rules can both fire. Neither is conditional on the other.

Reason clustering is a manual read of the collected strings, recorded verbatim in
the output document. No automated clustering.

### 5. Output

New file `docs/verifier-abstain-diagnosis.md`:

- cause breakdown table with counts and percentages, split by call site
  (`initial` / `corroborate` / `reverify`)
- per-field cause split
- for prose fields, the `firstCause` column beside `cause`
- the collected `model-abstained` reason strings, verbatim
- which rules fired (Rule 1 per cause, Rule 2 per cluster) and the resulting
  decisions
- the exact `--only-ids` list used, so the run is re-executable

Not appended to `docs/verifier-calibration.md`. That file's claims are about
detector calibration against a frozen label set; appending model-lane numbers
would blur what its floors rest on.

### 6. Testing

TDD, failing test first, per project convention:

- one characterization test over the full `(tier × parsed-state)` matrix
  asserting `decideFieldVerdict` returns the same `verdict` for every
  combination it returns today — the direct check on the governing invariant,
  written before any other change so it fails if the taxonomy work moves a branch
- seven unit tests on `parseVerifyResponse`, one per cause, each asserting the
  right discriminator from a crafted raw response
- two unit tests on the `verifyEntry` corroboration abstains, asserting
  `corroboration-split` and `corroboration-error`
- one test asserting `--diagnose` leaves `corpus/entries.json` byte-identical
  (corpus-isolated via the existing test-path injection, never the real corpus)
- one test asserting `--diagnose` re-queues an entry whose fields are all stamped
  at the current version — the skip bypass, without which the run measures
  nothing
- one test asserting `--only-ids` selects exactly the listed entries **in a
  corpus whose first-N-by-order set differs from the id list** — the fixture has
  to be built so an order-based selection would fail it, or the test passes
  against the bug it exists to catch
- one test asserting an id absent from the corpus fails loudly
- one test per call site asserting the `site` tag (`initial`, `corroborate`,
  `reverify`)
- one test asserting a prose field carries both `cause` and `firstCause` when the
  two asks fail for different reasons
- one test asserting the report's breakdown block sums to the reported abstain
  count, counting `cause` only (never `firstCause` — double-counting prose is the
  obvious way this table goes wrong)

## Parallel track — element-detection box quality

Runs alongside this spec, gated by neither. It answers one question this spec
cannot: **would a screen parser produce boxes good enough for the four detectors
that need element localisation?**

Not in this spec because it has a different risk profile — an external model
dependency and unverified claims about model behaviour — and folding it in would
put both behind one review cycle.

Scope: run a screen parser over ~20 pinned corpus screenshots, save the boxes as
overlay images, and judge by eye whether the boxes are the things
`cornerStyle` / `spacingDensity` / `usesBorders` / `usesShadows` would need to
measure. No integration, no lane, no verdicts.

Three things it must settle before any element-detection spec is written:

1. **Model family.** Moondream and Florence-2 are trained on natural-image
   corpora; UI screenshots are out of distribution for generic object detection,
   and the expected failure is boxes labelled `screen` / `text` / `monitor`
   rather than `card` / `button` / `input`. The relevant family is a screen
   parser finetuned on interactable UI elements. This is a belief, not a
   measurement — the probe is what turns it into one.
2. **Whether `accentColor` is in reach.** `docs/verifier-calibration.md` files it
   as Class B, needing a role rule rather than element detection, and the
   candidate rule named there is a whole-image statistic. But the accent is
   typically the primary button's fill, so a parser that finds interactable
   elements may address it directly. If it does, the reachable abstain set is
   122, not 85.
3. **What "deterministic" would then mean.** Pinned weights plus greedy decode is
   *reproducible*, not *recomputable*. A neural box proposer is still an
   independent witness — a different model from the vision lane — but the lane's
   premise changes, and that has to be stated explicitly rather than absorbed
   quietly.

**The probe script is committed, not throwaway.** The Class A analysis was
corrected once and cannot be checked a third time because its harness was
discarded (`docs/verifier-calibration.md`, "Harness was throwaway — the numbers
below are the artifact"). The entry ids are pinned in the script and the overlay
images are committed, so the next person can disagree with the judgement by
looking at the same pictures.

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
