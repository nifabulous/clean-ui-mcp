# The corpus verifier — design

**Status:** design approved, spec under review
**Stage:** 2c of the corpus trust gate program (Stages 1, 2a shipped in #94/#95; the
scout + `callVisionModel` in #96)

## Why this exists

The trust gate is built and the corpus is dark. `isVerified(entry, field)` reads a
`provenance.verification` record per field; **zero of 787 entries carry one**, so
nothing corpus-derived is served. This stage builds the thing that writes those
records — and in doing so fixes the root cause the whole program traces back to.

**The root cause.** The two-pass tagger's critique pass runs with `null` for the
image (`tagger.ts:3026`) and is told "treat every value below as fact"
(`tagger.ts:1042`). So Pass 2 elaborates confidently on whatever Pass 1 produced,
without ever seeing the screenshot. That is why `alan-alan-ios-screens-5` describes
a left navigation rail on a 1179×2556 portrait phone screenshot. The audit found
this class in 733 of 787 entries.

A verifier that only rubber-stamps the existing corpus would re-ship those
fabrications with a trust label — the exact failure the Stage 1 spec warned about.
So this verifier has two hard properties: it is **independent of the producer**,
and it **positively affirms**, never merely fails to refute.

## Governing invariant

Unchanged, now finally producible:

> A corpus-derived value is servable only when grounded in evidence that can be
> checked — measured from the page, provable from the data, or confirmed against
> the image by a verifier that actually saw it. An unverifiable assertion is never
> served.

Two invariants specific to this stage, both load-bearing:

1. **The verifier is independent of the producer.** The pass that writes a claim
   can never be the pass that certifies it. A model hallucinating while looking at
   the image is still hallucinating; self-certification is exactly the
   machine-stamped `taggedBy: "auto-reviewed"` the gate rejects. Independence means
   a separate call with fresh context and an adversarial prompt.
2. **Verification is positive affirmation, not refutation-survival.** "No detector
   flagged it" is not "confirmed true" — that fallacy is why the corpus is
   defective. The verify prompt must ask the model to CONFIRM the described element
   exists ("is a left navigation rail present? default false"), so a missing
   element returns false. "Failed to find a problem" never grants trust.

## Architecture

One verifier, run per entry, tiered so the cheap independent checks run before any
model call:

```
entry + image (imageSha256 bound)
  1. mechanical checks (free, no model)
       platform        → detectPlatform(w,h) === recorded?   → provable (no hash, data-derived)
       dominantColors  → extract top-N from pixels, match?    → image-confirmed (hash-bound)
  2. verify existing judgment fields (one independent vision pass)
       per field: a precise, checkable claim, adversarially confirmed
         holds → image-confirmed record, prose kept as-is
         fails → marked for re-production
  3. re-produce ONLY the failed fields (the fixed seeing Pass 2)
       replaces the fabricated value with a grounded one
  4. re-verify the re-produced fields (a fresh independent pass)
         holds → image-confirmed
         fails again → leave the field gated (dark), never served
  5. write/merge the per-field verification map onto the entry
```

Steps 3–4 are the recovery path chosen in brainstorming (verify-first, retag only
what fails): accurate hand-edits survive because a field that already passes is
never re-produced; only fabrications are rewritten; cost is a baseline verify per
entry plus a produce+verify pair per failing field, not 2× everything.

## What "verified" means, per field

The fabrication risk is FACTUAL assertion, not aesthetic judgment. Field classes
by evidence tier:

| class | fields | "verified" means | tier |
|---|---|---|---|
| **Re-derivable** | `platform`, `visual.dominantColors` | the recorded value is independently recomputed from the image and matches | split by evidence — see the record-tier note below |
| **Factual claim** | `visual.colorRoles`, `visual.accentColor`, `layout`, `components`, `visual.usesShadows`, `visual.usesBorders`, `visual.typePairing` | a precise assertion ("canvas=#fff; a left nav rail exists; a mono face is used") the vision pass CONFIRMS true, adversarially | `image-confirmed` |
| **Factual claim (a11y)** | `antiPatterns.accessibilityRisks` | each recorded risk names an element and a WCAG criterion; the vision pass confirms the risk is genuinely present (e.g. the cited text really is low-contrast) | `image-confirmed` |
| **Prose over facts** | `critique`, `whatToSteal`, `antiPatterns`, `voice` | extract the prose's factual assertions (named colours, regions, components) and confirm EACH; image-confirm the field only if every checkable assertion holds | `image-confirmed` |
| **Soft classification** | `mood`, `colorScheme`, `visual.spacingDensity`, `visual.cornerStyle`, `styleTags`, `categories`, `domainTags`, `patternType` | the vision pass affirms the classification adversarially; softer than a hard fact, so a higher unverifiable rate is expected and accepted | `image-confirmed` |
| **Not verifiable from one image** | `responsiveBehavior` | a single screenshot cannot show how a layout responds across viewports; there is no evidence to confirm it against | stays **gated** |

`visual.accentColor` is measurable-adjacent (a saturated minority colour is hard to
extract reliably), so it is treated as a **factual claim** confirmed against the
image rather than re-derived — the honest tier, given extraction unreliability.

**Record-tier note - the two re-derivable fields split by evidence, not both
`image-confirmed`.** `visual.dominantColors` is recomputed from the image's
PIXELS (`extractQuantizedColors`), so it carries the same re-capture staleness
risk as any other image-bound value and is recorded `image-confirmed` with
`imageSha256` bound to the exact bytes read. `platform`, by contrast, is
recomputed from the recorded DIMENSIONS (`detectPlatform(width, height)`) — data
already on the entry, not pixel evidence — so it is recorded `provable`, with NO
image hash. "measured" is the tagger's DOM-evidence tier and is used by neither.

The record shape binds `imageSha256` only to `image-confirmed` records, and the
doctor's `verified-hash-stale` / `verified-image-missing` staleness checks run
only for that method (`corpus-trust.ts:85`, and the image-confirmed-gated block
in `doctor-helpers.ts`).
Because `platform` is `provable`, those two checks never see it — a re-capture
that changes an image's dimensions (or a bad backfill) could otherwise leave a
stale `platform` record serving with no flag. The mitigation is a dedicated
doctor detector, `platform-record-stale` (`doctor-helpers.ts`), which
re-derives `detectPlatform` from the entry's recorded dimensions for every
verified `platform` record — of any method — and flags a mismatch. This is a
different check than the hash-staleness pair: it re-runs the recomputation
itself rather than comparing a hash, which is exactly the evidence `provable`
actually rests on.

**Re-derivation semantics.** `visual.dominantColors` reuses the tagger's
deterministic extractor - `extractQuantizedColors(imagePath)` (`tagger.ts:272`),
the same function Pass 1 feeds the recorded values from (the "copy from
quantizedColors verbatim" instruction, `tagger.ts:1070`). Match rule:
order-insensitive set match; every recorded dominant color must appear in the
extracted set exactly, both sides already quantized to the same precision. A
recorded color absent from the extracted set fails the field (stale or
fabricated) and re-production rewrites `dominantColors` from the extractor
output. `platform` recomputes via the shared `detectPlatform(width, height)`
(`schema.ts:184`, the same rule the tagger, backfill and UI use) against the
image's recorded dimensions; disagreement, or missing dimensions, fails the
field and re-production writes the recomputed value.

**`layout` confirmation is over the checkable subset.** `layout.regions` are
wireframe roles (`primary-nav`, `main-canvas`, `detail-rail`), not free-text
claims. The verify prompt must carry the role vocabulary with a one-line visual
description per role and confirm: the region COUNT matches, the layout FORM
(single/multi-column) matches, and each recorded region has a visually distinct
counterpart matching its role description. A recorded region with no visible
counterpart fails the field. Role assignments that are not visually
distinguishable are confirmed only through the count + form check, and the field
is gated when that is the only signal and the count disagrees.

`responsiveBehavior` is called out deliberately: it describes cross-viewport
behaviour, and the corpus stores one screenshot per entry, so nothing in the
evidence can confirm it. It stays unverified and therefore gated — the honest
outcome, not an oversight. A future re-capture stage that records multiple
viewports could grant it; this stage cannot.

All 23 keys in `SERVABLE_FIELD_KEYS` are classified above - 22 verifiable across
the re-derivable, factual-claim, a11y, prose-over-facts and soft-classification
rows, plus `responsiveBehavior`, which is deliberately never granted. A key added
to the servable set later must be added here too, or it is silently unverifiable.

Subjective words ("restrained", "elegant") are never checked: they are not the
fabrication risk and are not true-or-false. Only a critique's checkable factual
content gates it.

**The empty-assertion case is fail-closed.** A prose field whose extracted
checkable-assertion set is EMPTY is NOT granted: "every checkable assertion
holds" is vacuously true over the empty set, and granting on vacuity would
re-open the gate for exactly the prose class this stage exists to close. An empty
set reads as "no checkable content was enumerated", and the field stays gated.
The dry-run must report the zero-assertion rate per prose field as a first-class
number, and the human sample must include zero-assertion entries specifically to
distinguish "genuinely assertion-free" from "extraction missed the assertion" -
a missed assertion is the dangerous direction and halts the run.

## Independence and the cross-model limitation

The re-verify pass (step 4) must be independent of the re-produce pass (step 3):
separate call, fresh context, adversarial prompt. With a single provider,
"independent" is same-model / fresh-context / adversarial — weaker than
cross-model, because a producer and verifier that share a model share blind spots
(both may see the rail that isn't there). This is the exact review-independence
limitation the whole program has carried; it is named here, not hidden. The
verifier is built provider-parameterized so a cross-model verify (produce with A,
verify with B) is a config change, not a rewrite. Using two providers when
available is a recommended future strengthening, out of scope for the first cut.

One verify pass confirms all of an entry's claims in a single call; the claims
share that context, so a scene-level hallucination can co-vary across them.
Positive affirmation bounds this per claim, and step 4's re-verify provides a
second fresh-context look at re-produced fields. If the dry-run sample shows
scene-level co-variation, per-field fresh-context re-asks are the cost option -
the verifier is structured so the verify prompt is per field, making that a loop
change, not a rewrite.

## Data flow and record writing

- **`imageSha256`** binds every `image-confirmed` record to the exact bytes the
  verifier saw, reusing `createHash("sha256").update(readFileSync(path))`
  (`dedup.ts:112`). A later re-capture changes the hash and the doctor's
  `verified-hash-stale` check (already shipped) flags the record — so a stale
  verification cannot silently keep serving.
- **Merge, never clobber.** The verifier writes into
  `provenance.verification[fieldKey]`; existing records under other keys are
  untouched. Re-running the verifier is idempotent for fields that still pass.
- **`verifierVersion`** stamps every record so a prompt/logic change is visible and
  a corpus can be re-verified selectively. `verifiedAt` is the run date.
- The verifier writes to the corpus through the existing persistence path
  (snapshot-backed), never a raw file write; corpus-isolation test injection
  applies as everywhere else.

## Rollout

- **Dry-run first.** A `--dry-run` reports, per entry and field, what tier it would
  grant and why, and writes nothing. The audit's known-bad entries (Alan's rail)
  must show `critique` FAILING; a large pass rate on the first run is a red flag,
  not a success.
- **Sample before the full run.** Verify a stratified sample of 30 entries by eye
  against the actual images (10 known-bad from the audit, 10 typical, 10
  unknown) before spending 787 entries of model budget. Acceptance: at least 95%
  agreement with human verdicts on the sample, and ZERO missed-assertion cases in
  the known-bad strata - a missed assertion in the sample halts the run.
- **Idempotent + resumable.** Resume key is (entry id, field key): a field whose
  record already carries the current `verifierVersion` is skipped. An interrupted
  pass restarts from the first entry without a current-version record, so
  completed fields are never re-verified. Selective re-verification after a
  prompt or logic change scans records for `verifierVersion < N` (or absent) and
  re-runs only those fields.
- **The doctor is the standing check.** After a run, `doctor.js` reports the
  verified-per-field counts and any `verification-malformed` / `verification-orphan-key`
  / `verified-hash-stale` / `platform-record-stale` finding — the 2a detectors plus
  the `platform-record-stale` re-derivation check this stage adds (the standing guard
  for `provable` platform records, which the hash-based staleness checks never see).

## Out of scope

- **Re-capture / DOM signals.** 782 of 787 entries are manual uploads with no DOM.
  A `measured`-from-live-DOM tier (computed styles for colorRoles, typePairing,
  borders) would need re-visiting source URLs and recording DOM — a separate,
  larger effort. This stage re-derives only what the pixels and recorded numbers
  give: `dominantColors` from the pixels (`image-confirmed`) and `platform` from
  the recorded dimensions (`provable`) — neither is the DOM-evidence `measured` tier.
- **Cross-model verify** (produce with A, verify with B) — the verifier is built to
  allow it, but shipping two providers is a follow-up.
- **The per-entry field-set gating decision** flagged by the #95 reviewers
  (`get_ui_example` / `compare` / `recommend` AND-gate their whole set, so an entry
  missing an optional field never passes). Independent of the verifier; tracked
  separately.

## Risks

1. **Same-model producer/verifier share blind spots.** The independence is
   fresh-context, not cross-model. Named above; mitigated by the positive-affirmation
   requirement (a shared blind spot must survive an adversarial "confirm it exists"
   prompt, which is harder than surviving silence) and by the dry-run + human sample
   before trusting the run.
2. **Prose factual-assertion extraction is itself a model step** and can miss an
   assertion (letting a fabrication through) or invent one (gating a good field).
   The dry-run sample calibrates this before the full run; a missed assertion is
   the dangerous direction and the sample must specifically look for it.
3. **Re-production replaces prose.** A field that fails verification is rewritten by
   the seeing Pass 2, losing the original. Non-recoverable in place — but the corpus
   persists through snapshots, so the pre-run state is restorable, and only
   verification-FAILING fields (fabrications by definition) are touched.
4. **Cost.** Baseline one vision call per entry plus a produce+verify pair per
   failing field; with ~93% prose failure this approaches 2–3 vision calls per
   entry across 787. The dry-run reports the projected call count before committing
   to the full run.
5. **A high day-one pass rate is a failure signal, not success.** If the verifier
   confirms most of the known-defective corpus, its bar is too low — investigate
   before writing any record. The audit's counts (733/787 defective) are the
   sanity check the first dry-run is measured against.
