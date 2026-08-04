# Corpus Trust Gate — design spec

**Status:** design, ready for implementation planning
**Supersedes:** C3 Phase 2 (typography) as the next milestone — that phase is
withdrawn, not deferred (see "Withdrawn work" below).
**Reviews:** `/plan-ceo-review` (HOLD_SCOPE, clear) + `/plan-eng-review`
(SCOPE_REDUCED, clear) + `/codex` outside voice (7 findings, all verified, all
folded). Every file:line in this document was verified against the repo on
2026-08-04.

## Governing invariant

> **No corpus-derived value is served unless a human verified that entry against
> its screenshot, and that verification is recorded in a field no machine
> writes.**

Four corollaries, each mechanically testable:

1. A machine-writable field is never a trust signal.
2. An unverified value degrades to `unavailableDecisions` with an honest reason,
   never to a plausible substitute.
3. The identity screen and the trust gate are independent. Trust first, then
   identity. Neither subsumes the other.
4. Retrieval still happens and is still reported. "We found matches and did not
   trust them" is a truthful state and must be distinguishable from "we found
   nothing".

## Why

C3 Phase 1 (PR #93, merged 2026-08-03) began serving corpus design judgment into
six `UiSpec` fields. Measurement afterwards found the corpus does not support it.

### The corpus is 93% defective

Mechanical detectors over all 787 entries:

| defect | count |
|---|---|
| unassessed quality defaults (`3` / `exceptional` / `auto`) | 725 (92%) |
| rail region on a portrait/mobile layout | 90 (11%) |
| `ink`-on-`canvas` contrast < 3:1 | 65 (8%) |
| critique cites a hex absent from every colour field | 65 (8%) |
| role collapse (`surface`==`ink`, `canvas`==`ink`, …) | 81 across five pairs |
| `accentColor` ≠ `colorRoles.accent` | 27 |
| monospace claimed in prose, no mono face recorded | 25 |
| `soft-neumorphic` but `usesShadows: false` | 24 |
| **≥1 substantive defect** | **733 / 787 (93%)** |

Worst single row: `origin-origin-4` has `canvas`, `ink` and `muted` all
`#7c7c7c` — a 1.00:1 contrast palette.

These are a floor, not a ceiling. A vision audit of two entries found both
critiques wholly fabricated while tripping no detector:

- **`alan-alan-ios-screens-32-…`** — a portrait phone lens-pricing screen with no
  nav rail. Its critique claims "the left rail being a fixed-narrow vertical nav
  … keeps comparison tables at full reading width **on desktop**", and
  `whatToSteal[0]` says "Pin a fixed-narrow vertical nav to the left". That row
  is served today as a `techniques[]` entry.
- **`stackai-stackai-web-screens-13-…`** — a white-canvas, single-sans agent
  builder. Its critique claims "deep plum-gray `#403c44` for the primary canvas …
  color-coded connection lines in `#90b5e8` and `#a5d4b2` … avoids a blinding
  white canvas". Neither hex appears anywhere in the entry or the image.

### Root cause 1 — the critique pass never sees the screenshot

`tagger.ts:3026` passes `null` where the image goes: `null, // no image — pure
reasoning from facts`. Every `critique` / `whatToSteal` / `antiPatterns` /
`voice` row in the corpus was written from Pass 1's extraction alone, with the
palette stripped (`critiqueSafeExtraction`, `tagger.ts:1127`).

Alan is not hallucination from nothing. Pass 1 extracted
`layout.regions: [primary-nav, main-canvas]` and `colorRoles.surface: #a8c8aa`
for a white screen; Pass 2 reasoned *correctly* from a wrong premise. StackAI is
the other mode: with the palette hidden, Pass 2 invented one.

Attaching the image is **not sufficient on its own**. `tagger.ts:1042` instructs
"treat every value below as fact, do not re-derive or contradict it", and
`validateCritiqueComponentClaims` (`tagger.ts:1776`, called at `:3049` and
`:3211`) scrubs prose naming anything absent from Pass 1's components. That is
Stage 2 work and is out of scope here.

### Root cause 2 — no human sign path exists

- `provenance.taggedBy: "auto-reviewed"` is **machine-stamped**. `ui/app.js:1375`
  and `:1488` flip `auto` → `auto-reviewed` on save; `ui/classic-app.js:635`
  *defaults* the dropdown to it.
- `reviewedBy`: 0/787. `taggedBy: "human"`: 0/787.
- 10 of the 12 `auto-reviewed` entries still carry the tagger's placeholder title
  `"— (add descriptive subtitle)"`.
- `reviewStatus` is `approved` on 787/787 — the field carries no information.

So **zero entries satisfy the invariant today, and no code path can produce
one.** That is deliberate: this spec ships the gate; the sign path that lets
entries pass it is Stage 3 of the program track.

### The governance bar was already written, and was bypassed

`TODOS.md` → "Provenance governance flip (serve signed prose)" states it:
*"auto only on facts; critique/anti-pattern prose flips to trusted only after
human sign"*, trigger *"when the first human-signed entry class exists"*, and it
records *"the corpus has zero human provenance"*. Phase 1 served auto-tagged
prose anyway. The metric that drove it — "6 of 13 sections filled" — rewarded
serving more rows regardless of truth, so it improved as the product got more
confidently wrong.

## Scope

**This spec covers the gate only.** Stages 2–5 (tagger fix, gold set, sign path,
re-tag, index rebuild) are a tracked program with their own specs, written after
the gate shows what serving at zero verified entries actually looks like.

### Design

New module `src/corpus-trust.ts`:

```ts
export function isVerifiedByHuman(entry: CorpusEntryT): boolean
```

Named for what it checks. It gates every corpus-derived value, not only prose,
so a narrower name would lie.

Predicate — fail-closed, and it consults exactly two fields:

| condition | verdict |
|---|---|
| `provenance.reviewedBy` present AND `provenance.taggedBy === "human-verified"` | verified |
| `provenance` absent (298 entries) | not verified |
| `taggedBy: "auto"` (477) | not verified |
| `taggedBy: "auto-reviewed"` (12) | not verified — machine-stamped |
| `reviewStatus` | **never consulted**, in any combination |

`"human-verified"` is a value no current code path writes. That is the point: the
gate cannot be satisfied by accident, and Stage 3 has to introduce the write
deliberately.

### Where the gate applies

Filter **once**, at the top of `createUiSpecDeterministic`:

```
matchedEntries ──▶ filter(isVerifiedByHuman) ──▶ trustedEntries
                                                      │
        ┌─────────────────────────────────────────────┤
        ▼            ▼            ▼           ▼       ▼
   techniques   antiPatterns   voice    a11y    components /
   whatToSteal                                  responsive /
                                                designDirection group-B
                                                      │
                                                      ▼
                                          screenProse (identity, unchanged)
                                                      │
                                                      ▼
                                                   served
```

Every selector reads `trustedEntries` and never `matchedEntries`. One filter, not
seven guards — the `designDirection` group-B composition (mood,
`typePairing.notes`, critique) is a separate code path from the six selectors and
is exactly the site a per-loop guard forgets.

`colorTokens` and `layoutRegions` derive from `SanitizedEvidence`, not
`matchedEntries`, so they need their own gate keyed on the same predicate.

### What is gated

Everything corpus-derived: `techniques`, `antiPatterns`, `contentVoiceGuidance`,
`accessibilityConstraints`, `componentInventory`, `responsiveBehavior`,
`colorTokens`, `layoutRegions`, and the corpus signals folded into
`designDirection`.

The model path needs no prose gate — `create-ui-spec-model.ts:37` takes
`sanitizedEvidence` only and `:101` calls `buildPrompt(request,
sanitizedEvidence)`, never `matchedEntries`. Gating the structured facts closes
its exposure to bad extraction.

### Day-one output, concretely

With zero verified entries, `create_ui_spec` returns the caller's brief restated
under the recipe lane, plus acceptance criteria and recipe scaffolding.
`designDirection` loses its `(evidence-N)` citation. Every gated field carries an
`unavailableDecisions` row. This is the **default** path and therefore the
best-tested one.

Three consequences that must ship with it:

1. **Five array fields need new `unavailableDecisions` rows.** `techniques`,
   `antiPatterns`, `componentInventory`, `responsiveBehavior` and
   `accessibilityConstraints` currently fall back to the recipe's fixed-empty
   arrays (`create-ui-spec.ts:1120-1145`) with no reason row. Gated without a
   row, they are indistinguishable from "the corpus had nothing to say".
2. **`colorTokens` gating must revert `colorTokenAuthority` to `editorial` and
   drop its corpus-evidence citedDecision** (`create-ui-spec.ts:983-993`,
   `:1157`). Otherwise the spec claims corpus authority for a null value.
3. **`evidence[]` rows stay but are marked untrusted**, and no `citedDecision`
   may cite `authorityLanes.corpusEvidence`. Retrieval genuinely happened;
   claiming it grounded anything would be false.

### Disclosure

The response reports a verified-source count, so a caller can see the grounding
is thin rather than inferring it from absence.

### No feature flag

A flag whose off-position re-enables serving fabrications is a footgun, and this
repo's flag convention (flag-off equals current behaviour byte-for-byte) would
oblige keeping the fabrication path alive and tested as the off-position.
Rollback is a code revert, which is fully reversible.

### Corpus health gate

The eight defect detectors written during this investigation move into
`doctor.ts` as a standing check, so corpus regressions surface without a
one-off script.

## Tests

The zero-verified path is the default, so it gets the deepest coverage.

- `isVerifiedByHuman` — one case per row of the predicate table, including
  `reviewStatus: "approved"` combined with each `taggedBy` value, asserting it
  changes nothing.
- Zero verified entries: every gated field empty or null, every one carrying an
  `unavailableDecisions` row, `colorTokenAuthority === "editorial"`, no
  `citedDecision` citing the corpus lane, `designDirection` carrying no
  `evidence-N`.
- Some verified entries: prose returns for those entries only, proving the gate
  is a **filter and not an off switch**. Requires a fixture entry stamped
  `human-verified` — no real corpus entry qualifies.
- Trust and identity are independent: a `human-verified` entry whose prose names
  a product is still dropped by `screenProse`.
- **Regression, CRITICAL:** `full-corpus-leak-sweep.test.ts` and the C3 suites
  assert the current served posture. They are updated in the same change, not
  after.
- `doctor.ts` detector tests, using the synthetic corpus already built for the
  leak sweep.

## NOT in scope

- **Tagger fix** (image to Pass 2, the do-not-contradict instruction, scrubber
  behaviour, palette stripping) — Stage 2.
- **Gold set** (~50 entries, vision-model labelled with the image attached, human
  spot-check) — Stage 2. No new privacy exposure: Pass 1 already sends these
  screenshots to a vision provider.
- **Human sign path** — Stage 3. `review-draft.ts` is already ~70% of it: an
  interactive per-entry reviewer that prompts for a real `qualityScore`
  (`:138`) and prints `entry.image.path` (`:83`) without opening it. It needs
  three additions: display the screenshot, write the unforgeable stamp, and
  target existing corpus entries rather than only `entries-draft.json`.
- **Re-tag** — Stage 4, and blocked: `commit-draft.ts:115` skips ids already in
  the corpus, so a 787-entry re-tag through that flow commits zero entries. An
  overwrite path must be built, with a pre-run snapshot held outside the rolling
  keep-20 in `corpus/.snapshots`. Note `corpus/entries.json` is gitignored
  (`.gitignore:35`) — there is no git-history rollback.
- **Index rebuild** — Stage 5. `entryToDocument` leads with `critique` +
  `whatToSteal` (`embeddings.ts:267`, `:286`) and `:15` names content-staleness,
  so any re-tag invalidates the vector index.
- **Quality-default cleanup** — Stage 5, after a downstream-consumer audit of the
  725 rows asserting `qualityScore: 3` / `exceptional`.
- **`accessibilityRisks`, `motionGuidance`, real font families** — all need
  `domSignals` from a live re-crawl. Only 422/787 entries have a `source.url` and
  0/787 persist `domSignals`. Separate follow-up: stop discarding `domSignals` on
  capture.

## Withdrawn work

**C3 Phase 2 (typography) is withdrawn, not deferred.** `TypographyTokens` cannot
be filled honestly from this corpus:

- 275/787 entries carry `typePairing.display` + `body` (the spec's "35%").
- **93% of those record the same family twice** — 208 are `Inter + Inter`.
- Only 19 entries record two distinct faces; 13 are `SF Pro Display + SF Pro Text`.
- Only 6 of 93 products carry any pairing.
- **0 of 12 eval briefs** reach three pairing-carrying entries under real
  retrieval, which is top-3 by rank with `patternType` dedupe
  (`create-ui-spec.ts:509`) — not the "product-diverse five" the docblock at
  `:12` still claims. That docblock is stale and should be fixed; it misled this
  investigation's first measurement.

**C3 Phase 3 (derived colour) is blocked** on a trustworthy `colorRoles`.

## Stale TODOS to reconcile

- **"C3 Phase 1: cap the synthesized direction length"** — implemented in
  `2ab7ffe`. Remove it; a stale TODO invites the work twice.
- **"Corpus schema: mono role for typography"** — keep, annotated with the
  withdrawal measurement above.
- **"Phase 2" is overloaded** — it names both the typography phase and a
  2026-07-27 "Phase 2 hardening" TODO holding five open P2 findings. Rename.

## Risks

1. **Signing may never scale.** If the verified set stalls at a few dozen entries,
   served output stays thin indefinitely. The gate makes this visible instead of
   hidden; it does not solve it. Stage 3 must measure signing throughput
   (entries per hour) because every served row depends on it.
2. **A tagger validated on 50 gold entries and applied to 737 unseen ones is
   still unverified at scale** — the failure this program exists to fix. Signing
   is what closes it, so Stage 4 before Stage 3 is wasted spend.
3. **The product question stays open.** If serving corpus judgment requires a
   human to verify 787 entries, it is worth asking whether the deterministic path
   should serve only machine-verifiable structured facts. This spec does not
   settle that; it stops the bleeding so the question can be answered without a
   clock running.
