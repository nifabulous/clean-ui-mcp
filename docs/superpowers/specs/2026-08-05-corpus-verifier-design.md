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
       platform        → detectPlatform(w,h) === recorded?   → measured
       dominantColors  → extract top-N from pixels, match?    → measured
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

The fabrication risk is FACTUAL assertion, not aesthetic judgment. Three field
classes, three meanings:

| class | fields | "verified" means | tier |
|---|---|---|---|
| **Re-derivable** | `platform`, `visual.dominantColors` | the recorded value is independently recomputed from image/data and matches | `measured` (no model) |
| **Factual claim** | `visual.colorRoles`, `layout`, `components`, `visual.usesShadows`, `visual.usesBorders`, `visual.typePairing` | a precise assertion ("canvas=#fff; a left nav rail exists; a mono face is used") the vision pass CONFIRMS true, adversarially | `image-confirmed` |
| **Factual claim (a11y)** | `antiPatterns.accessibilityRisks` | each recorded risk names an element and a WCAG criterion; the vision pass confirms the risk is genuinely present (e.g. the cited text really is low-contrast) | `image-confirmed` |
| **Prose over facts** | `critique`, `whatToSteal`, `antiPatterns`, `voice` | extract the prose's factual assertions (named colours, regions, components) and confirm EACH; image-confirm the field only if every checkable assertion holds | `image-confirmed` |
| **Soft classification** | `mood`, `colorScheme`, `visual.spacingDensity`, `visual.cornerStyle`, `styleTags`, `categories`, `domainTags`, `patternType` | the vision pass affirms the classification adversarially; softer than a hard fact, so a higher unverifiable rate is expected and accepted | `image-confirmed` |
| **Not verifiable from one image** | `responsiveBehavior` | a single screenshot cannot show how a layout responds across viewports; there is no evidence to confirm it against | stays **gated** |

`visual.accentColor` is measurable-adjacent (a saturated minority colour is hard to
extract reliably), so it is treated as a **factual claim** confirmed against the
image rather than re-derived — the honest tier, given extraction unreliability.

`responsiveBehavior` is called out deliberately: it describes cross-viewport
behaviour, and the corpus stores one screenshot per entry, so nothing in the
evidence can confirm it. It stays unverified and therefore gated — the honest
outcome, not an oversight. A future re-capture stage that records multiple
viewports could grant it; this stage cannot.

All 23 keys in `SERVABLE_FIELD_KEYS` are classified above (20 verifiable across the
first four rows, plus `visual.accentColor` in prose text, plus `responsiveBehavior`
which is deliberately never granted). A key added to the servable set later must be
added here too, or it is silently unverifiable.

Subjective words ("restrained", "elegant") are never checked: they are not the
fabrication risk and are not true-or-false. Only a critique's checkable factual
content gates it.

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
- **Sample before the full run.** Verify a stratified sample by eye against the
  actual images before spending 787 entries of model budget, and compare the
  dry-run verdicts to human judgment on that sample.
- **Idempotent + resumable.** The run records progress so an interrupted 787-entry
  pass resumes without re-verifying completed entries.
- **The doctor is the standing check.** After a run, `doctor.js` reports the
  verified-per-field counts and any `verification-malformed` / `verification-orphan-key`
  / `verified-hash-stale` finding — the same detectors shipped in 2a.

## Out of scope

- **Re-capture / DOM signals.** 782 of 787 entries are manual uploads with no DOM.
  A `measured`-from-live-DOM tier (computed styles for colorRoles, typePairing,
  borders) would need re-visiting source URLs and recording DOM — a separate,
  larger effort. This stage measures only what the pixels and recorded numbers
  give: `platform` and `dominantColors`.
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
