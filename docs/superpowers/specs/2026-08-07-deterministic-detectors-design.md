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

## Architecture

`verifyMechanicalFields` becomes a **detector registry**. Fields classified
`mechanical` in `TIER_BY_FIELD` are resolved by a per-field detector instead of
reaching the vision prompt. `verifyEntry` already builds its `pending` list by
filtering out `mechanical` and `gated` tiers, so those fields leave the vision
call automatically — `buildVerifyPrompt`'s logic is untouched and simply
receives fewer fields.

Three new modules:

- **`src/verify/detectors/<field>.ts`** — one per field. Each exports
  `detect(imagePath, recorded) => Promise<DetectorResult>` where
  `DetectorResult = { verdict: "pass" | "contradicted" | "abstain"; measured: unknown; confidence: number; reason: string }`.
  Reads pixels via `sharp.raw()`; colour maths via `culori`. No network, no model.
- **`src/verify/detector-registry.ts`** — field key → `{ detect, category, accuracyFloor, confidenceBand }`. The single place a field's deterministic status is declared. A contract test asserts `TIER_BY_FIELD` and the registry cannot disagree.
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

### Verdict taxonomy

Widens from `pass | fail | gate` to `pass | contradicted | abstain | gate`.
`fail` today means literally `"not positively confirmed"`, conflating disproof
with ignorance.

| Verdict | Meaning | Trust record | Other effect |
| --- | --- | --- | --- |
| `pass` | measurement agrees with the recorded value | `provenance.verification` | served |
| `contradicted` | measurement positively disagrees | none | `provenance.dataQuality` entry with measured-vs-recorded |
| `abstain` | inside the confidence band, below the accuracy floor, or unmeasurable | none | resume marker in `provenance.verifyAttempts` |
| `gate` | no recorded value to check | none | unchanged |

`isVerified` reads only `provenance.verification` and knows nothing about
verdicts, so existing serving callers are unaffected.

## Components

All detectors read raw pixels via `sharp`; colour maths via `culori`.

| Field | Category | Method | Confidence |
| --- | --- | --- | --- |
| `visual.usesBorders` | certifying | Sobel gradient → sharp luminance steps ≤3px wide with no decay tail, in rectilinear runs | High |
| `visual.usesShadows` | certifying | Same gradient field → soft ramps 3–20px wide with monotonic falloff adjacent to an edge. A border is a step; a shadow is a decay | Medium |
| `visual.accentColor` | certifying | Pixel count within a ΔE2000 threshold of the recorded hex; pass on area fraction above a floor and not equal to the background colour | High |
| `visual.cornerStyle` | certifying | Corner-region edge deviation from a right angle, bucketed: 0–2px `square`, 3–8 `slight-round`, 9–20 `rounded`, >20 `pill` | Medium |
| `visual.spacingDensity` | certifying | Connected-component segmentation of non-background regions; median inter-element gap normalised by element size | Low |
| `visual.colorRoles` | **contradiction-only** | Contradicts when a recorded hex is absent from the image entirely, or when `canvas` is measurably not the largest-area colour. Cannot confirm role *assignment* (`ink` vs `muted` needs text detection) | High for contradiction |
| `antiPatterns.accessibilityRisks` | **contradiction-only** | Contradicts when a listed risk names a contrast criterion (WCAG 1.4.3 / 1.4.11) over a resolvable role pair and `culori.wcagContrast` shows the ratio comfortably clears the threshold | High for contradiction |
| `platform` | certifying | *existing* — `detectPlatform(width, height)` recomputed from recorded data; `provable`, no image hash | High |
| `visual.dominantColors` | certifying | *existing* — recorded colours ⊆ `extractQuantizedColors` output | High |

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

The registry declares an `accuracyFloor` per detector. Below it the detector is
disabled — always `abstain` — and CI fails, so a threshold regression cannot
silently resume writing trust records.

### Data-quality reporting

`contradicted` writes `provenance.dataQuality[field] = { measured, recorded, detector, verifierVersion, at }`
— a third sibling map alongside `verification` and `verifyAttempts`. A
`--report-suspect` flag emits a markdown table of entries carrying
contradictions, ranked by count. `doctor.ts` gains a check surfacing the total,
since it already reports corpus-integrity findings.

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
- `platform` and `visual.dominantColors` stay deterministic — they are `mechanical`
  today, so returning them to vision would be a change, not a restoration
- contradiction-only detectors do not run, so no `dataQuality` entries are written

## Data flow

```
verifyEntry(entry, imagePath)
   │
   ▼  (1) detector registry — every registered detector, both categories
runDetectors(entry, imagePath)
   │     registry[field].detect(imagePath, recorded)
   │       -> { verdict, measured, confidence, reason }
   │     confidence inside band         -> abstain (overrides the verdict)
   │     accuracy floor unmet           -> detector disabled, always abstain
   │     contradiction-only computed a pass -> downgraded to abstain
   │                                          (enforced in the runner)
   │
   ├── pass         -> records[field]      (image-confirmed | provable)
   ├── contradicted -> dataQuality[field]  { measured, recorded, detector }
   └── abstain      -> resume marker only
   │
   ▼  (2) pending = servable fields
   │        MINUS (mechanical ∪ gated)              <- certifying fields gone
   │        MINUS fields a contradiction-only detector already contradicted
buildVerifyPrompt(entry, pending)
   │
   ▼  (3) one vision call, positive-affirmation prompt
decideFieldVerdict per field           <- unchanged for remaining fields
   │        NOTE: a contradiction-only field that ABSTAINED arrives here and can
   │        still pass via the model, exactly as today.
   │
   ▼  (4) prose re-produce + re-verify — unchanged, now sampling-pinned
   │
   ▼
{ records, verdicts, dataQuality }
```

Step (1) sits exactly where `verifyMechanicalFields` already ran. Step (2)
already filters `mechanical` out of `pending`; the set simply gets bigger.

### Record-map exclusivity

Three sibling maps under `provenance`. A field appears in at most one, and
writing to one revokes the other two for that field — so a version bump or
re-verify cannot leave a stale trust record beside a fresh contradiction. This
mirrors the pass/fail revocation the merge functions already perform.

| Map | Written by | Read by |
| --- | --- | --- |
| `verification` | `pass` only | `isVerified` → the serving gate |
| `verifyAttempts` | `abstain`, `gate`, model `fail` | resume / queue convergence |
| `dataQuality` | `contradicted` only | suspect report, `doctor` |

### Cost and staleness

**Cost.** Four to five fields leave the vision call per entry
(`usesShadows`, `usesBorders`, `accentColor`, `cornerStyle`, and `spacingDensity`
when it clears its floor), out of roughly 22 — so the verify prompt and its
response shrink by about a fifth. `colorRoles` and `accessibilityRisks` stay in
the vision path because they are contradiction-only. Detectors are local pixel
work: milliseconds, no API calls. The number of model calls per entry is
unchanged; each is smaller, and the fields most responsible for verdict
instability no longer contribute to it.

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
| Detector below its accuracy floor | Disabled at registry level, always `abstain`, CI fails |
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

**Photographic content.** Screenshots containing photos or gradients produce soft
luminance ramps that mimic shadows. This is the main false-positive risk for
`usesShadows` and the reason its confidence is Medium. The real-screenshot
calibration set is the mitigation; if the detector cannot clear its floor there,
it ships disabled and the field stays with vision.

## Testing

**Per-detector unit tests** against committed synthetic fixtures:

- `usesShadows` — 8px-shadowed card → `pass` on `true`; flat card → `contradicted` on `true`; solid colour → `abstain`
- `usesBorders` — 1px-bordered card → `pass`; borderless → `contradicted`; shadowed-but-borderless → `contradicted`
- `accentColor` — `#2563eb` button on `#ffffff` → `pass`; `#dc2626` recorded → `contradicted`; a 2px speck → `abstain` (below area floor)
- `cornerStyle` — radii 0/4/12/28px → `square`/`slight-round`/`rounded`/`pill`; 2.5px → `abstain` (band boundary)
- `spacingDensity` — generated grids at known gaps; the test asserts honest abstention rather than forcing a pass
- `colorRoles` — recorded hex absent from the image → `contradicted`; wrong `canvas` → `contradicted`; fully matching set → `abstain`, **never `pass`** (pins the contradiction-only contract)
- `accessibilityRisks` — a 12:1 pair carrying a 1.4.3 claim → `contradicted`; a genuine 2.1:1 pair → `abstain`, never `pass`; hit-target risk → `abstain`

**The pair that must not be confused.** A dedicated test asserts a
shadowed-borderless card yields `usesBorders: contradicted` *and*
`usesShadows: pass`, and the inverse for a bordered-flat card. Shadow-versus-border
is the highest-risk confusion in the set, and per-detector tests in isolation
would miss it.

**Calibration gate.** `calibration.test.ts` runs every certifying detector over
its **held-out** synthetic set and asserts measured accuracy ≥ its declared
floor. Explicitly not the tune set. This is the mechanism that stops a threshold
regression from silently resuming trust-record writes.

**Registry contract test.** The drift guard, and it is category-aware — a single
"registry ⟺ mechanical" assertion would be wrong, since contradiction-only
detectors deliberately keep their original tier:

- every field classified `mechanical` has a registered **certifying** detector
- every **certifying** detector's field is classified `mechanical`
- every **contradiction-only** detector's field is **not** classified `mechanical`
  (so it still reaches the vision prompt and can still pass)

A field reclassified without a detector would otherwise route to a vision prompt
that no longer expects it; a contradiction-only field wrongly reclassified would
go permanently dark.

**Verdict-taxonomy tests.** `contradicted` writes only `dataQuality`; `abstain`
writes only a resume marker; `pass` writes only `verification`; each write
revokes the other two for that field. Plus a run-report test that a
`contradicted` entry appears in the suspect table.

**Integration.** One `verifyEntry` test with a synthetic image and a mixed entry,
asserting the `callVision` stub receives a `pending` list with the mechanical
fields **absent** — proving step (2) shrank rather than the detectors merely
running in addition. A second run with `--detectors off` asserts the `pending`
list is byte-identical to today's.

**Corpus isolation** throughout: injected readers and generated fixtures only,
never `corpus/entries.json`.

## Risks

1. **`usesShadows` cannot clear its floor on real screenshots.** Photographic content mimics shadow gradients. Mitigated by the real calibration set catching it before merge; the detector then ships disabled and the field stays with vision. Cost is a fixture set and no benefit — not a regression.
2. **Thresholds tuned on synthetic images do not transfer.** The held-out split catches overfitting to the generator; the real set catches overfitting to synthetic-ness. Both are needed, which is why both exist.
3. **The suspect report is ignored.** A `dataQuality` map nobody reads is dead weight. Mitigated by surfacing the count in `doctor.ts`, which is already part of the routine integrity check.
4. **More image-confirmed records mean more staleness churn** on re-capture. Accepted: it is the correct semantics. Flagged so the increase is expected rather than alarming.
5. **`spacingDensity` likely abstains often.** Segmentation is fragile on real UI. The accuracy floor makes this self-limiting — it either earns trust or disables itself — so the downside is wasted effort, not wrong records.

## Out of scope

- **Moondream / local narrow-question verifier.** A separate spec. This work removes most of the fields it would have served, so its scope should be re-decided afterwards.
- **OpenRouter + promptfoo harness, and the frozen labelled ground-truth set.** A separate spec, and a prerequisite for comparing models on the fields that remain subjective (`critique`, `whatToSteal`, `styleTags`, `mood`).
- **Splitting `visual.colorRoles` into per-role verification keys.** Would let `canvas` and `accent` genuinely pass, but touches `SERVABLE_FIELD_KEYS`, the serving gate, and the 2d-1/2d-2 field sets. Its own spec if wanted.
- **Auto-correcting contradicted corpus values.** Deliberately excluded: it would make the verifier a producer and violate producer/verifier independence.
- **Choosing a vision provider.** Left open; this spec reduces how much rides on that choice.
