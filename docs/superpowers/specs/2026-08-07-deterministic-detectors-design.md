# Deterministic detectors + verdict taxonomy — design

**Status:** designed (pending plan)

## Why this exists

The corpus verifier asks a vision model whether a screenshot supports each
recorded claim. Benchmarking that against hand labels produced three findings
that this spec responds to.

**Verdicts are not reproducible, and no available sampling control fixes it.**
Two runs with byte-identical configuration flipped 5 of 28 disputed verdicts
(18%). Pinning `temperature: 0` reduced that to 4 of 28 (14%) — statistically
indistinguishable. Of the four residual flips, two were `visual.usesShadows`
with temperature pinned: irreducible nondeterminism (batching, MoE routing,
non-associative float accumulation), and the `seed` that might help is rejected
outright by OpenAI's Responses API. The other two were prose fields, explained
by a re-produce pass that this spec also pins (see Folded-in fixes).

**No model was better than a coin flip on the disputed fields.** Best measured
accuracy against hand labels was ~62%, on a sample where a 3.6-point gap between
two "different" models turned out to be the same model run twice. Provider choice
is second-order to the fact that the verdict process itself is unstable.

**A meaningful slice of the corpus may simply be wrong.** 11 of 28 disputed
claims were judged unsupported by their own screenshot. Today that is invisible:
"the image contradicts this" and "I could not tell" both become `fail`, both
stay dark forever, and neither is reported.

The response is not a better model. Several of these fields are **perception
questions with deterministic answers** — whether a card has a drop shadow,
whether a hex appears in an image, whether a contrast ratio clears AA. Those
belong in pixel arithmetic, where the answer is a measurement rather than a
sample.

> **Benchmark provenance.** The figures above — 5/28 flips (18%), 4/28 at
> pinned `temperature: 0` (14%), ~62% best accuracy, the 3.6-point
> same-model-twice gap, 11/28 unsupported — come from the disputed-verdict
> benchmark run. That run's methodology (sample composition, prompts,
> providers, dates, raw verdicts) must be committed under `eval/verdicts/`
> alongside the implementation plan; until then these numbers are prose, not
> evidence — the same standard this spec holds the corpus to.

## Governing invariant

Inherited unchanged from `2026-08-05-corpus-verifier-design.md`:

> A corpus-derived value is servable only when grounded in evidence that can be
> checked — measured from the page, provable from the data, or confirmed against
> the image by a verifier that actually saw it. An unverifiable assertion is never
> served.

Plus its two stage invariants, both still load-bearing here:

1. **The verifier is independent of the producer.** No detector writes to a
   served field. Contradictions are reported, never auto-corrected.
2. **Verification is positive affirmation, not refutation-survival.** "No edges
   detected" is not "no borders present". Absence of a detected signal is
   `abstain`, never `pass`.

### The invariant this spec adds

> A detector may write a trust record only for a field on which it has been
> measured, against data it was not tuned against.

Determinism earns no trust by itself. A miscalibrated threshold fails
*identically* across all 787 entries — systematically and silently — which is
strictly worse than a model that fails randomly. Measurement against held-out
labelled fixtures is what converts determinism into trust.

## Locked decisions

1. **Structure:** extend the existing `mechanical` tier into a detector registry. Not a new parallel tier, and not a pre-pass feeding the vision prompt.
2. **Calibration:** every detector must clear a declared accuracy floor **and** abstain per-image inside a confidence band. Both, not either.
3. **Fixtures:** synthetic (committed, CI) **and** real screenshots (gitignored, calibration). Synthetic is split into disjoint tune and held-out parameter ranges; CI gates on held-out only.
4. **Contradictions** are recorded as data-quality findings for human review. The corpus is never auto-corrected.
5. **`visual.colorRoles` and `antiPatterns.accessibilityRisks` are contradiction-only** — they may contradict but never grant a pass.
6. **Certifying is value-dependent, not field-dependent.** A certifying detector may emit `pass` only for recorded values its `canAffirm(recorded)` predicate accepts; non-affirmable values take contradiction-only behaviour and stay in the vision path (see Two detector categories).
7. **Colour maths dependency.** `culori` (ΔE2000, `wcagContrast`) is added to `package.json` — it is not currently a dependency.

## Architecture

`verifyMechanicalFields` becomes a **detector registry**. Fields classified
`mechanical` in `TIER_BY_FIELD` are resolved by a per-field detector instead of
reaching the vision prompt. `verifyEntry` already builds its `pending` list by
filtering out `mechanical` and `gated` tiers, so those fields leave the vision
call automatically — `buildVerifyPrompt`'s logic is untouched and simply
receives fewer fields.

Three new modules:

- **`src/verify/detectors/<field>.ts`** — one per field. Each exports
  `detect(entry, ctx) => Promise<DetectorResult>` where `ctx` is the entry's
  shared decoded raw buffer — one `sharp.raw()` decode per entry, not one per
  detector — and
  `DetectorResult = { verdict: "pass" | "contradicted" | "abstain"; measured: unknown; confidence: number; reason: string }`.
  Reads pixels via the shared `ctx`; colour maths via `culori`. No network, no model.
- **`src/verify/detector-registry.ts`** — field key → `{ detect, category, accuracyFloor, confidenceBand, canAffirm(recorded), disabled? }`. The single place a field's deterministic status is declared, including which recorded values the detector can affirm and whether it is disabled. A contract test asserts `TIER_BY_FIELD` and the registry cannot disagree, with explicit exceptions for disabled detectors and non-affirmable values.
- **`src/verify/calibration.ts`** — runs a detector over a labelled fixture set and returns measured accuracy. Used by CI (held-out synthetic) and by a calibration script (real screenshots).

### Two detector categories

The distinction is load-bearing, not cosmetic. A verification key covers exactly
one value, so a key whose claim cannot be *fully* checked must never pass — a
pass makes `isVerified` true and the serving path then emits the whole value,
including the parts nothing verified.

| Category | May emit | Tier classification | Rationale |
| --- | --- | --- | --- |
| **Certifying** | `pass`, `contradicted`, `abstain` | reclassified to `mechanical` — leaves the vision path | The detector checks the entire claim the key makes, so the model is redundant. |
| **Contradiction-only** | `contradicted`, `abstain` — never `pass` | **keeps its existing tier** — stays in the vision path | The detector can disprove the claim but cannot confirm it, so the model must still be able to grant the pass. |

**Contradiction-only detectors do not remove their field from the vision call.**
They run as an additional check beside it. Classifying them `mechanical` would
strip them from `pending`, and since they can never emit `pass`, the field would
go permanently dark — a regression against today, where `visual.colorRoles` can
pass via the model. So they run first, and one of two things happens:

- detector contradicts → record the finding and **skip the vision check for that
  field** (the claim is already disproven; spending a model call to ask whether a
  measurably-absent colour is present is waste)
- detector abstains → the field proceeds to the vision prompt exactly as today

**Certifying is value-dependent, not field-dependent.** A certifying detector
may emit `pass` only for recorded values its `canAffirm(recorded)` predicate
accepts. For `usesShadows`/`usesBorders` only `true` is affirmable — the
absence invariant makes "no shadows are used" unaffirmable by measurement —
and for `cornerStyle` only `sharp`/`slight-round`/`pill` are affirmable
(`mixed` is not). A non-affirmable value behaves exactly like a
contradiction-only field: the detector runs first and either contradicts
(finding + skip the vision call) or abstains, in which case the field proceeds
to the vision prompt and can pass via the model, exactly as today. The runner
caps the verdict at `contradicted`/`abstain` when `canAffirm(recorded)` is
false; the detector itself never needs to know. Without this rule,
reclassifying the fields `mechanical` would strip 418 `usesShadows: false`
claims, 276 `usesBorders: false` claims, and 139 `cornerStyle: mixed` claims
from the vision path and permanently darken them — a regression against today,
where the model affirms them.

### Verdict taxonomy

Widens from `pass | fail | gate` to `pass | contradicted | abstain | gate`.
`fail` today means literally `"not positively confirmed"`, conflating disproof
with ignorance.

| Verdict | Meaning | Trust record | Other effect |
| --- | --- | --- | --- |
| `pass` | a detector measurement, or the vision model, agrees with the recorded value | `provenance.verification` | served |
| `contradicted` | a detector measurement **or a model verdict** positively disagrees | none | `provenance.dataQuality` entry with measured-vs-recorded (or the model's cited reason) |
| `abstain` | inside the confidence band, below the accuracy floor, unmeasurable, or a non-affirmable value the model cannot affirm | none | processed-at-version marker in `provenance.verifyAttempts` |
| `gate` | no recorded value to check | none | unchanged |

`isVerified` reads only `provenance.verification` and knows nothing about
verdicts, so existing serving callers are unaffected.

**The vision model gains the `contradicted` option too.** The "the image
contradicts this" vs "I could not tell" distinction that motivates this spec is
not detector-only: `layout`, `components`, `visual.typePairing`, prose, and
soft fields stay with the model, and their contradictions are exactly the kind
of finding that today collapses into `fail`. The verify prompt and its response
schema grow from confirmed/not-confirmed to **confirmed / contradicted /
abstain**, with the same discipline as the detectors: `contradicted` requires
the image to positively disagree with the recorded claim (the prompt says so
explicitly), and uncertainty is `abstain`. A model `contradicted` writes
`dataQuality` and revokes any stale trust record; `abstain` writes a processed
marker and never serves.

## Components

All detectors read raw pixels via `sharp`; colour maths via `culori`.

| Field | Category | Affirmable recorded values | Method | Confidence |
| --- | --- | --- | --- | --- |
| `visual.usesBorders` | certifying | `true` only | Sobel gradient → sharp luminance steps ≤3px wide with no decay tail, in rectilinear runs. `false` claims cannot be affirmed under the absence invariant — they stay in the vision path | High |
| `visual.usesShadows` | certifying | `true` only | Same gradient field → soft ramps 3–20px wide with monotonic falloff adjacent to an edge. A border is a step; a shadow is a decay. `false` claims stay in the vision path | Medium |
| `visual.accentColor` | certifying | any recorded hex | Pixel count within a ΔE2000 threshold of the recorded hex; **pass requires the hex to be the largest non-background colour cluster** above an area floor — presence alone is not "the accent", exactly as the colorRoles rationale argues. Present-but-not-largest → `abstain` (role unconfirmed); hex absent entirely, or equal to the background colour → `contradicted` | High |
| `visual.cornerStyle` | certifying | `sharp`, `slight-round`, `pill` | Corner-region edge deviation from a right angle, bucketed onto the schema vocabulary: 0–2px `sharp`, 3–20px `slight-round`, >20px `pill`. `mixed` is not affirmable — a single-radius measurement can neither affirm nor contradict it, so the field stays in vision | Medium |
| `visual.spacingDensity` | certifying | all enum values | Connected-component segmentation of non-background regions; median inter-element gap normalised by element size | Low |
| `visual.colorRoles` | **contradiction-only** | — | Contradicts when a recorded hex is absent from the image entirely, or when `canvas` is measurably not the largest-area colour. Cannot confirm role *assignment* (`ink` vs `muted` needs text detection) | High for contradiction |
| `antiPatterns.accessibilityRisks` | **contradiction-only** | — | Contradicts when a listed risk names a contrast criterion (WCAG 1.4.3 / 1.4.11) over a resolvable role pair and `culori.wcagContrast` shows the ratio comfortably clears the threshold | High for contradiction |
| `platform` | certifying | any recorded value | *existing* — `detectPlatform(width, height)` recomputed from recorded data; `provable`, no image hash | High |
| `visual.dominantColors` | certifying | any recorded value | *existing* — recorded colours ⊆ `extractQuantizedColors` output | High |

Colour maths uses `culori` (ΔE2000 for the colour detectors, `wcagContrast`
for the a11y detector) — a **new dependency to be added to `package.json`**;
it is not currently in the project. Detectors share one decoded raw buffer per
entry (`ctx` in the signature above) instead of each calling `sharp.raw()` on
the full screenshot: `cornerStyle` and `spacingDensity` both need
connected-component segmentation of the same pixels, and five full decodes per
entry would dominate the local cost.

`platform` and `visual.dominantColors` move into the registry and gain
calibration entries. They are currently trusted without ever having been measured
against a labelled set — the same gap this spec closes for the new detectors.

### Why colorRoles and accessibilityRisks are contradiction-only

**`visual.colorRoles`** is one key holding five sub-values. Confirming a hex
appears somewhere in the image does not verify it is the *ink* colour — the claim
is a role assignment. If `ink` and `muted` were swapped, a presence check passes
and the served paste-ready token set is wrong. Verifying presence and calling the
field confirmed would be exactly the presence-metric failure this project's
conventions forbid. It can, however, contradict: a recorded hex wholly absent
from the image, or a `canvas` that is measurably not the dominant colour, is
demonstrably wrong.

**`antiPatterns.accessibilityRisks`** is one key holding an array. Contrast
arithmetic can check only risks naming a contrast criterion over a resolvable
role pair — a minority. A field passing while unchecked risks ride along would
serve unverified content. But a listed contrast risk that is arithmetically false
is bad data worth surfacing.

### Calibration

Two fixture sets per certifying detector.

**Synthetic, committed** — generated by
`src/verify/__fixtures__/generate-detector-fixtures.ts` using `sharp`, so ground
truth is exact by construction. Split into two disjoint parameter ranges:

- **Tune set** — thresholds may be developed against it. Example: shadow opacity 0.30, corner radii 4px and 12px, accent `#2563eb`.
- **Held-out set** — never consulted while tuning. Disjoint parameters: shadow opacity 0.15 and 0.50, corner radii 6px and 18px, accent `#059669`.

CI gates on **held-out accuracy only**. Gating on the tune set would be circular
— the same data tuning, measuring, and certifying — and would certify nothing.

**Real, gitignored** (`eval/detectors/`) — roughly 10 hand-labelled corpus
screenshots per field, calibrating thresholds and the confidence band against
genuine messiness (photographic content, gradients, compression artefacts). A
script (`npm run calibrate-detectors`) prints an accuracy table; the numbers are
committed as markdown even though the private images cannot be. This number is
reviewed at merge, not asserted in CI, because CI has no access to the images.

The registry declares an `accuracyFloor` per detector and a `disabled` state.
At merge time the floor is set from the real-screenshot calibration; a detector
that cannot clear it on the real set **ships disabled**, its field **reverts to
its pre-detector tier** (`factual`/`soft`, as in `TIER_BY_FIELD` today) and
stays in the vision path — the field is never left `mechanical` with a
detector that can only abstain, which would darken it permanently. CI's
held-out gate skips disabled detectors; for enabled ones it asserts measured
accuracy ≥ the declared floor, so a threshold regression cannot silently resume
writing trust records.

### Frozen labelled ground-truth set

The motivation for this spec (the 28-claim benchmark: 5/28 flips, ~62% ceiling,
11/28 unsupported) and the fields that remain model-verified (`layout`,
`components`, `visual.typePairing`, prose, soft) both need one thing the repo
does not have: a frozen, hand-labelled verdict set that does not move while
detectors and models are compared against it. The labelling run and comparison
harness are a separate spec (tracked in TODOS.md); the fixture format and
labelling contract are defined here, because detector calibration and the
frozen set share the same labelling infrastructure and must not invent two
formats.

**Fixture format.** One JSONL record per labelled claim:

```json
{ "entryId": "…", "imageSha256": "…", "field": "visual.typePairing",
  "claim": "a Söhne + Inter type pairing", "label": "confirmed",
  "notes": "…", "labelledAt": "2026-08-07", "labelledBy": "…" }
```

- `label` ∈ `confirmed | contradicted | abstain` — the same taxonomy as the
  verifier, so a detector or model verdict compares to a label directly.
- The record pins the image bytes by hash, so a re-capture invalidates the
  label instead of silently re-grounding it.
- The set is **frozen**: labels are never edited in place; a correction appends
  a new record with a `supersedes` field. A label that moves mid-comparison
  makes the comparison meaningless.
- The fixture lives under `eval/verdicts/`, committed like any other eval
  artifact.

**Initial scope.** The 28 disputed claims behind this spec's benchmark, plus a
stratified sample of the remaining model-verified fields (~10 per field,
matching the detector calibration sets) so both lanes measure against the same
ground truth.

### Data-quality reporting

`contradicted` — from a detector or the vision model — writes
`provenance.dataQuality[field] = { measured, recorded, source, verifierVersion, at }`
where `source` is the detector name or `"vision"` (with the model's cited
reason), as a third sibling map alongside `verification` and `verifyAttempts`.
A `--report-suspect` flag emits a markdown table of entries carrying
contradictions, ranked by count. The report's hierarchy is fixed so a curator
can act from it alone: per row, **field first**, then measured-vs-recorded
values, then `source` (detector name or `"vision"`), then entry id and title,
ordered by contradiction count across the entry's fields, then by field. The
triage actions — re-capture, re-tag, or dismiss — are taken by the human, never
by the verifier. `doctor.ts` gains a check surfacing the total, since it already
reports corpus-integrity findings.

The verifier never edits a served field. A contradiction is a finding; a human
decides.

### Folded-in fixes

**Pin the re-produce pass.** `sampling` currently reaches `callVisionModel` but
not `tagImage`'s internal Pass 1 / Pass 2, so re-produce output varies run to run
and drags prose verdicts with it — 2 of the 4 residual flips at temperature 0.
`tagImage` gains a `sampling` input threaded to both its `callModel` calls.

**`--detectors off`.** Reclassifying fields changes every run with no way to
reproduce the previous behaviour. The A/B measurement that demonstrates detectors
beat the model needs the old path available, and an operator needs an escape
hatch if a detector misbehaves in production.

With the flag off, behaviour is byte-identical to today, which means precisely:

- the **new** certifying detectors' fields return to the vision `pending` list
  (both the affirmable and non-affirmable recorded values)
- `platform` and `visual.dominantColors` stay deterministic — they are `mechanical`
  today, so returning them to vision would be a change, not a restoration
- contradiction-only detectors do not run, so no `dataQuality` entries are written

## Production rollout

The corpus is dark today — zero of 787 entries carry a verification record, and
every corpus-derived MCP tool serves the honest "0 of 787" message. The
detectors and taxonomy in this spec are machinery; the product outcome is the
surface lighting back up with evidence chains. The rollout sequence is part of
this spec's scope, not a follow-up:

1. **Calibrate on real screenshots.** Run `npm run calibrate-detectors` over the
   gitignored real set; set declared floors and disabled states from the
   numbers (reviewed at merge, per Calibration).
2. **Verify a representative cohort first.** ~50 entries spanning the
   pattern-type, colour-scheme, and corner-style distributions, including the
   recorded-`false` and `mixed` populations the value-dependence rule keeps in
   vision. Inspect `--report-suspect`; publish the measured detector accuracy
   and contradiction count for the cohort before scaling.
3. **Light the first surfaces.** Ship the cohort's verified entries through the
   2d-2 field-set gating so the first corpus-derived tools serve real rows with
   disclosure; the "0 of 787" message becomes a per-cohort count.
4. **Scale the full run** to 787 with a per-entry cost budget (model calls per
   entry — reduced by the certifying fields leaving the vision call) and the
   resume-aware `--limit`/`--dry-run` cadence. Re-runs are incremental:
   processed-at-version markers skip finished fields.

If a detector fails real-set calibration in step 1, it ships disabled with its
field reverted (per Calibration); the cohort run then measures the remaining
detectors honestly instead of hiding the miss.

## Data flow

```
verifyEntry(entry, imagePath)
   │
   ▼  (1) detector registry — every registered detector, both categories
runDetectors(entry, sharedCtx)
   │     registry[field].detect(entry, sharedCtx)
   │       -> { verdict, measured, confidence, reason }
   │     confidence inside band         -> abstain (overrides the verdict)
   │     accuracy floor unmet           -> detector disabled, field reverts to
   │                                       its pre-detector tier (stays in vision)
   │     !canAffirm(recorded)           -> verdict capped at contradicted/abstain
   │                                       (enforced in the runner)
   │     contradiction-only computed a pass -> downgraded to abstain
   │                                          (enforced in the runner)
   │
   ├── pass         -> records[field]      (image-confirmed | provable)
   ├── contradicted -> dataQuality[field]  { measured, recorded, source }
   └── abstain      -> processed marker only
   │
   ▼  (2) pending = servable fields
   │        MINUS (mechanical ∪ gated)   <- affirmable certifying fields gone
   │        MINUS fields whose detector contradicted
   │        (a mechanical field with a NON-affirmable recorded value STAYS —
   │         e.g. usesShadows:false, cornerStyle:mixed)
buildVerifyPrompt(entry, pending)
   │
   ▼  (3) one vision call, three-way prompt: confirmed / contradicted / abstain
decideFieldVerdict per field
   │        NOTE: a contradiction-only field (or non-affirmable value) that
   │        ABSTAINED arrives here and can still pass via the model, as today.
   │        A model `contradicted` writes dataQuality exactly like a detector's.
   │
   ▼  (4) prose re-produce + re-verify — unchanged, now sampling-pinned
   │
   ▼
{ records, verdicts, dataQuality }
```

Step (1) sits exactly where `verifyMechanicalFields` already ran. Step (2)
already filters `mechanical` out of `pending`; the set gets bigger, and the
filter becomes value-aware: a mechanical field whose recorded value
`canAffirm` rejects stays in `pending`.

### Record-map exclusivity

Three sibling maps under `provenance`. A field appears in at most one, and
writing to one revokes the other two for that field — so a version bump or
re-verify cannot leave a stale trust record beside a fresh contradiction. This
mirrors the pass/fail revocation the merge functions already perform.

A processed marker is terminal at its verifier version: `selectPending` skips
marked fields on re-run, so an `abstain` (e.g. from a transient image error)
keeps the field dark until the version bumps — matching today's fail
semantics. "Resume" means the run continues past processed fields, not that
they are retried.

| Map | Written by | Read by |
| --- | --- | --- |
| `verification` | `pass` only (detector or model) | `isVerified` → the serving gate |
| `verifyAttempts` | `abstain`, `gate` (detector or model) | processed-at-version bookkeeping — skipped on re-run until the version bumps (`selectPending`) |
| `dataQuality` | `contradicted` only (detector or model) | suspect report, `doctor` |

### Cost and staleness

**Cost.** For fully-affirmable entries, five fields leave the vision call
(`usesShadows`, `usesBorders`, `accentColor`, `cornerStyle`, and `spacingDensity`
when it clears its floor): the pending field count drops from 20 to 15. That is
a field-count saving, not a token one — these are the cheapest claims in the
prompt (booleans, a hex, two enums), while the prose fields that dominate
tokens stay. The saving is value-conditional: `usesShadows: false` (418
entries), `usesBorders: false` (276), and `cornerStyle: mixed` (139) keep their
fields in the vision call. `colorRoles` and `accessibilityRisks` stay because
they are contradiction-only. Detectors are local pixel work: milliseconds, no
API calls. The number of model calls per entry is unchanged; each is smaller,
and the fields most responsible for verdict instability no longer contribute
to it for the values they can affirm.

**Staleness.** Adding image-confirmed records multiplies `doctor.ts`'s
hash-staleness surface: a re-captured screenshot now invalidates five or more
records at once instead of one. This is correct — pixel measurements should die
with the pixels they measured — but it means re-captures trigger noticeably more
re-verification than before. `platform` is exempt, being `provable` rather than
image-confirmed.

## Error handling and edge cases

Every failure mode resolves to `abstain`, which withholds the field. A detector
never falls back to the model: that would make a field's verdict source
nondeterministic between runs, which is the instability this work removes. A
field is either deterministic or it is not.

| Situation | Behaviour |
| --- | --- |
| Image unreadable, corrupt, or truncated | `abstain`, reason names the file error; other detectors for that entry still run |
| Detector throws | Caught per detector, `abstain` with the error text. One bad detector cannot take down the registry |
| `sharp` cannot decode the format | `abstain` |
| No recorded value for the field | `gate` — nothing to verify |
| Recorded hex malformed (`"blue"`, `#12`) | `abstain`, not `contradicted`. An unparseable claim is unverifiable, not disproven |
| Measurement inside the confidence band | `abstain`, even when the raw verdict was `pass` or `contradicted`. The band wins |
| Detector below its accuracy floor | Disabled at registry level, field tier reverts to its pre-detector tier (stays in vision), always `abstain`, CI held-out gate skips it |
| Certifying detector on a non-affirmable recorded value | Verdict capped at `contradicted`/`abstain` (runner-enforced); on `abstain` the field proceeds to vision and can pass via the model |
| Contradiction-only detector computes a pass | Downgraded to `abstain`. Enforced in the runner, not left to each detector |

**The band overriding `contradicted` matters.** A near-threshold measurement must
not accuse the corpus of being wrong. `dataQuality` entries are meant to be
actionable; a report full of borderline calls would be ignored. Contradiction
requires the measurement to be clearly outside the band.

**Degenerate images.** A solid-colour screenshot has no edges, so
`usesBorders` / `usesShadows` find zero candidates. That is `abstain`, not "no
shadows present" — absence of a detected signal is not evidence of absence, which
the governing invariant forbids. `spacingDensity` on a single-element image
abstains rather than reporting a gap of zero.

This is precisely why `canAffirm(false)` is false: the same absence rule that
makes a signal-free image `abstain` means "no shadows are used" can only be
affirmed by the vision model, never by a detector.

**Photographic content.** Screenshots containing photos or gradients produce soft
luminance ramps that mimic shadows. This is the main false-positive risk for
`usesShadows` and the reason its confidence is Medium. The real-screenshot
calibration set is the mitigation; if the detector cannot clear its floor there,
it ships disabled and its field reverts to its pre-detector tier, staying with
vision.

## Testing

**Per-detector unit tests** against committed synthetic fixtures:

- `usesShadows` — 8px-shadowed card → `pass` on `true`; flat card → `contradicted` on `true`; solid colour → `abstain`; **flat card recorded `false` → detector `abstains` and the field proceeds to vision, where the model can still `pass` it** (pins the value-dependent routing)
- `usesBorders` — 1px-bordered card → `pass`; borderless → `contradicted`; shadowed-but-borderless → `contradicted`; **borderless card recorded `false` → `abstain`, stays in vision**
- `accentColor` — `#2563eb` button on `#ffffff` → `pass`; `#dc2626` recorded → `contradicted`; a 2px speck → `abstain` (below area floor); **a present-but-not-largest hex → `abstain`, never `pass`** (pins the maximality contract)
- `cornerStyle` — radii 0/4/12/28px → `sharp`/`slight-round`/`slight-round`/`pill` (schema vocabulary — there is no `square` or `rounded` value); 2.5px → `abstain` (band boundary); **recorded `mixed` → `abstain`, field stays in vision**
- `spacingDensity` — generated grids at known gaps; the test asserts honest abstention rather than forcing a pass
- `colorRoles` — recorded hex absent from the image → `contradicted`; wrong `canvas` → `contradicted`; fully matching set → `abstain`, **never `pass`** (pins the contradiction-only contract)
- `accessibilityRisks` — a 12:1 pair carrying a 1.4.3 claim → `contradicted`; a genuine 2.1:1 pair → `abstain`, never `pass`; hit-target risk → `abstain`

**The pair that must not be confused.** A dedicated test asserts a
shadowed-borderless card yields `usesBorders: contradicted` *and*
`usesShadows: pass`, and the inverse for a bordered-flat card. Shadow-versus-border
is the highest-risk confusion in the set, and per-detector tests in isolation
would miss it.

**Detector failure modes.** A detector that throws → `abstain` for that field
and the remaining detectors still run (per-detector catch). A disabled detector
at runtime → always `abstain`, and its field is not in `pending`. A
near-threshold measurement whose raw verdict is `contradicted` → `abstain` —
the band overrides a contradiction, keeping `dataQuality` actionable.

**Calibration gate.** `calibration.test.ts` runs every certifying detector over
its **held-out** synthetic set and asserts measured accuracy ≥ its declared
floor — explicitly not the tune set, and **skipping detectors marked disabled**
(whose fields have reverted to their pre-detector tier). This is the mechanism
that stops a threshold regression from silently resuming trust-record writes.

**Registry contract test.** The drift guard, and it is category-aware — a single
"registry ⟺ mechanical" assertion would be wrong, since contradiction-only
detectors deliberately keep their original tier:

- every field classified `mechanical` has a registered **certifying** detector
- every **certifying** detector's field is classified `mechanical`
- every **contradiction-only** detector's field is **not** classified `mechanical`
  (so it still reaches the vision prompt and can still pass)
- every certifying detector declares `canAffirm`, and the value-aware pending
  filter is asserted at the boundary values (`usesShadows: false` stays in
  `pending`; `usesShadows: true` leaves it)
- disabled detectors are exempt from the first two clauses — their field reverts
  to its pre-detector tier, so a disabled certifying detector's field is NOT
  required to be `mechanical`

A field reclassified without a detector would otherwise route to a vision prompt
that no longer expects it; a contradiction-only field wrongly reclassified would
go permanently dark.

**Verdict-taxonomy tests.** `contradicted` writes only `dataQuality`; `abstain`
writes only a processed marker; `pass` writes only `verification`; each write
revokes the other two for that field. A model `contradicted` verdict — from the
three-way prompt — writes `dataQuality` with `source: "vision"` exactly like a
detector's, and a model `abstain` never serves. Plus a run-report test that a
`contradicted` entry appears in the suspect table.

**`dataQuality` validation.** The doctor validates the new map like
`verification`: malformed records, unknown `source`s, and orphan keys are
flagged, so a bad contradiction entry cannot silently sit beside a served field.

**Integration.** One `verifyEntry` test with a synthetic image and a mixed entry,
asserting the `callVision` stub receives a `pending` list with the mechanical
fields **absent** — proving step (2) shrank rather than the detectors merely
running in addition. A second test asserts a non-affirmable recorded value
(`usesShadows: false`) **stays** in the `pending` list. A third asserts a field
the detector contradicted is excluded from both the initial and the re-verify
batches. A second run with `--detectors off` asserts the `pending` list is
byte-identical to today's.

**Corpus isolation** throughout: injected readers and generated fixtures only,
never `corpus/entries.json`.

## Risks

1. **`usesShadows` cannot clear its floor on real screenshots.** Photographic content mimics shadow gradients. Mitigated by the real calibration set catching it before merge; the detector then ships disabled and its field reverts to its pre-detector tier, staying with vision. Cost is a fixture set and no benefit — not a regression.
2. **Thresholds tuned on synthetic images do not transfer.** The held-out split catches overfitting to the generator; the real set catches overfitting to synthetic-ness. Both are needed, which is why both exist.
3. **The suspect report is ignored.** A `dataQuality` map nobody reads is dead weight. Mitigated by surfacing the count in `doctor.ts`, which is already part of the routine integrity check.
4. **More image-confirmed records mean more staleness churn** on re-capture. Accepted: it is the correct semantics. Flagged so the increase is expected rather than alarming.
5. **`spacingDensity` likely abstains often.** Segmentation is fragile on real UI. The accuracy floor makes this self-limiting — it either earns trust or ships disabled with its field back in vision — so the downside is wasted effort, not wrong records.

## Out of scope

- **Moondream / local narrow-question verifier.** A separate spec. This work removes most of the fields it would have served, so its scope should be re-decided afterwards.
- **OpenRouter + promptfoo harness, and the frozen labelled ground-truth set.** The harness and the labelling run are a separate spec (tracked in TODOS.md); the fixture format and labelling contract are defined in this spec (Frozen labelled ground-truth set) so both lanes share one ground truth.
- **Splitting `visual.colorRoles` into per-role verification keys.** Would let `canvas` and `accent` genuinely pass, but touches `SERVABLE_FIELD_KEYS`, the serving gate, and the 2d-1/2d-2 field sets. Its own spec if wanted.
- **Auto-correcting contradicted corpus values.** Deliberately excluded: it would make the verifier a producer and violate producer/verifier independence.
- **Choosing a vision provider.** Left open; this spec reduces how much rides on that choice.
