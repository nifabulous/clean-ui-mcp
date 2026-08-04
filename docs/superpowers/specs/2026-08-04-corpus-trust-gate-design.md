# Corpus Trust Gate — design spec

**Status:** design, ready for implementation planning
**Supersedes:** C3 Phase 2 (typography) as the next milestone — that phase is
withdrawn, not deferred (see "Withdrawn work" below).
**Reviews:** `/plan-ceo-review` (HOLD_SCOPE, clear) + `/plan-eng-review`
(SCOPE_REDUCED, clear) + `/codex` outside voice (7 findings, all verified, all
folded). Every file:line in this document was verified against the repo on
2026-08-04.

## Governing invariant

> **A corpus-derived value is servable only when it is grounded in evidence that
> can be checked — measured from the page, provable from the data, or confirmed
> against the image by a verifier that actually saw it. An unverifiable assertion
> is never served.**

The invariant is about **evidence class, not verifier identity.** An earlier draft
required a human signature; that was wrong for this product. A gate only a human
can open does not scale to 787 entries, blocks corpus growth, and makes a product
built to give AI agents design judgment depend on the one resource that does not
scale. Verification has to be something an agent can perform.

Five corollaries, each mechanically testable:

1. **Blindness, not model authorship, caused the fabrications.** The critique pass
   was handed no image (`tagger.ts:3026`). Anyone reasoning from facts they cannot
   see produces Alan's phantom left rail. The fix is grounding, not a human.
2. A value whose grounding cannot be named is never served.
3. An unverified value degrades to `unavailableDecisions` with an honest reason,
   never to a plausible substitute.
4. The identity screen and the trust gate are independent. Trust first, then
   identity. Neither subsumes the other.
5. Retrieval still happens and is still reported. "We found matches and did not
   trust them" is a truthful state and must be distinguishable from "we found
   nothing".

### Evidence tiers

| tier | evidence | verifier | today |
|---|---|---|---|
| **measured** | `domSignals` — computed CSS, real contrast ratios, real `fontFamily` | none needed; it is measurement | discarded on 787/787; recapturable for the 422 with a URL |
| **provable** | self-consistency: `canvas`==`ink`, accent disagreement, hex absent from every colour field, rail region on a portrait image, styleTag contradicting a visual boolean | none needed; decidable from the data | detectors written, not yet wired |
| **image-confirmed** | a verifier that saw the screenshot confirms the claim | machine, at corpus scale | does not exist yet |
| **unverifiable** | assertion with nothing behind it | n/a | this is what ships today |

Three of the four tiers need no human. The strongest tier needs no verifier at
all: `domSignals.styles.fontFamily` is not an opinion about the font, it is the
font, and a measured 3.1:1 contrast ratio outranks any number of people agreeing
the text looks readable.

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

### Root cause 2 — nothing records how a value was checked

- `provenance.taggedBy: "auto-reviewed"` is **machine-stamped**. `ui/app.js:1375`
  and `:1488` flip `auto` → `auto-reviewed` on save; `ui/classic-app.js:635`
  *defaults* the dropdown to it.
- `reviewedBy`: 0/787. `taggedBy: "human"`: 0/787.
- 10 of the 12 `auto-reviewed` entries still carry the tagger's placeholder title
  `"— (add descriptive subtitle)"`.
- `reviewStatus` is `approved` on 787/787 — the field carries no information.

The corpus records *who touched* an entry and never *what was checked*. There is
no field saying "this claim was compared against the image", so nothing can
distinguish a grounded value from an invented one.

So **zero entries satisfy the invariant today, and no code path can produce
one.** That is deliberate: this spec ships the gate; the verifier that lets
entries pass it is Stage 2 of the program track, and it is a machine.

### The governance bar was already written, and was bypassed

`TODOS.md` → "Provenance governance flip (serve signed prose)" states it:
*"auto only on facts; critique/anti-pattern prose flips to trusted only after
human sign"*, trigger *"when the first human-signed entry class exists"*, and it
records *"the corpus has zero human provenance"*. Phase 1 served auto-tagged
prose anyway. The metric that drove it — "6 of 13 sections filled" — rewarded
serving more rows regardless of truth, so it improved as the product got more
confidently wrong.

## Scope

**This spec covers the gate only.** Stages 2-5 (the verifier plus the tagger
blindness it shares a root with, `domSignals` persistence, re-tag, index rebuild)
are a tracked program with their own specs, written after the gate shows what
serving at zero verified entries actually looks like.

### Design

New module `src/corpus-trust.ts`:

```ts
export function isVerified(entry: CorpusEntryT): boolean
```

It gates every corpus-derived value, not only prose, so a narrower name would lie.

**Pure, synchronous, no I/O, no injection.** An earlier draft had it take a
`resolveImagePath` so it could answer "does this entry's image still exist".
Verification killed that: `resolveImagePath` validates path *shape* only —
`assertCorpusImagePath` (`paths.ts:132`) rejects `..`, absolute paths and
non-`images-*` prefixes, then returns without touching the filesystem. A non-null
result never meant the file was there.

The right conclusion is not to add an existence check but to drop the question.
**A missing image does not invalidate a past verification.** The record attests
that a claim WAS checked against the image when it existed; deleting the file
later does not make the prose less true, and the caller never sees the screenshot
anyway. Image existence is a corpus-integrity property, not a trust property, so
it belongs with the hash-staleness check in `doctor.ts`.

That leaves the predicate reading nothing but the entry it is handed, which is
also why the gate needs no new plumbing at its call site.

**Also in scope, same change:** correct the stale `create-ui-spec.ts:12` docblock,
which still describes "product-diverse selection of at most five" while `:509`
implements top-3 with `patternType` dedupe. It is three lines, it sits in the file
this change edits, and leaving a known-false claim in place while working around
it is how the last plan went wrong.

The gate reads one new field, `provenance.verification`, which records **how** a
value was checked rather than **who** touched it:

```ts
verification?: {
  method: "measured" | "provable" | "image-confirmed";
  verifiedAt: string;        // ISO date
  verifierVersion: string;   // which verifier, so a bad one is revocable
  imageSha256?: string;      // REQUIRED when method is "image-confirmed"
}
```

`imageSha256` binds an image-confirmed verification to the exact bytes the
verifier saw. **It is optional on the type and mandatory by method**, because the
`measured` tier's evidence comes from the live DOM rather than from pixels —
requiring an image hash there would bind the record to the wrong artifact.
`measured` records bind to their capture instead (see Stage 3, which owns the
`domSignals` shape and its own staleness key).

There is **no persisted image hash in the corpus today.** `schema.ts` has no hash
field on `image` or the entry. The hash function does exist:
`dedup.ts:112` computes `createHash("sha256")` over the file bytes and caches
`{ hash, dhash, path }` per entry id in `corpus/.dhash-cache.json`. That cache is
rebuildable and gitignored, so it is not provenance — but the verifier can reuse
the same helper for free, since it has already read the bytes to send them to the
model. Stage 2 writes the hash; nothing needs a migration.

**The gate does not hash at serve time.** Re-reading up to three PNGs per request
to compare a digest is real I/O on a path that is otherwise pure CPU. Staleness is
enforced where it is cheap instead:

- **write-time invalidation** — a capture or import that replaces an entry's image
  clears `verification`. Same pattern as the content-staleness handling
  `embeddings.ts:15` already documents.
- **`doctor.ts`** re-hashes and reports mismatches, and reports verified entries
  whose image file is missing, as standing health checks.

Predicate — fail-closed, reading only `provenance.verification`:

| condition | verdict |
|---|---|
| `verification` present and `method` in the accepted set | verified |
| `verification` absent (787 entries) | not verified |
| `provenance` absent entirely (298 entries) | not verified |
| `method` unrecognised (forward-compat: a newer verifier's tier) | not verified |
| `method: "image-confirmed"` with `imageSha256` absent | not verified — malformed record |
| `imageSha256` mismatch against bytes on disk | **not consulted** — `doctor.ts` owns it |
| image file missing | **not consulted** — corpus integrity, not trust; `doctor.ts` owns it |
| `taggedBy: "auto"` (477) / `"auto-reviewed"` (12) / absent (298) | **not consulted** — records who, not what |
| `reviewStatus` | **never consulted**, in any combination |

No current code path writes `verification`, so day one nothing passes. That is the
point: the gate cannot be satisfied by accident, and Stage 2 introduces the write
deliberately — from a verifier, not a person.

### Where the gate applies

Filter **once**, at the top of `createUiSpecDeterministic`:

```
matchedEntries ──▶ filter(isVerified) ──▶ trustedEntries
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

`colorTokens` and `layoutRegions` derive from `SanitizedEvidence` rows, not from
`matchedEntries`, so the predicate cannot be applied to them directly — a
sanitized row does not carry its entry. Bridge it through the evidence id:
`matchedEntries` pairs `{ evidenceId, entry }`, so derive
`trustedEvidenceIds = new Set(trustedEntries.map(m => m.evidenceId))` from the
same filter and narrow `observations` to that set before the plurality votes run.
One filter, two derived views, no second predicate.

#### The vote runs over a subset that grows one entry at a time

Narrowing `observations` changes what plurality *means*, and this matters most in
the middle of the program rather than at either end. Two consequences the
implementation has to state, not discover:

1. **Every threshold counts trusted contributors, never matched ones.** The
   existing `colorTokens` guard requires three contributing entries. After the
   gate that must mean three *trusted* entries. Counting matches while voting over
   the trusted subset would derive a token from one verified entry while claiming
   three backed it — a stronger authority claim than the evidence supports, which
   is the exact failure this whole spec exists to stop.
2. **A single newly verified entry can flip a served token.** With three trusted
   entries, verifying a fourth can move the accent plurality, so the same brief
   returns a different palette the next day with no code change. That is correct
   behaviour — the evidence base genuinely changed — but it makes the served
   palette non-reproducible across verification events, so the plan records it
   rather than letting someone later read it as a bug. The existing
   `plurality()` tie rule (`undefined` on a tie) already keeps a 2-2 split from
   silently picking a winner; the new case is a 2-1 becoming 2-2.

Both are cheap to pin and neither is covered by testing only zero-verified and
all-verified.

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
   arrays (`create-ui-spec.ts:1143-1170`) with no reason row. Gated without a
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

**Constraint the implementation plan must satisfy:** the leaf gate is fail-closed
over every served position, so a new field cannot simply be added — it has to be
classified in `tool-contracts.ts` (a count is a numeric leaf, not free text or a
reference) or the gate refuses the whole response. Cheapest compliant option is
reusing an already-classified numeric position rather than introducing one; the
plan picks between those and records why.

### No feature flag

A flag whose off-position re-enables serving fabrications is a footgun, and this
repo's flag convention (flag-off equals current behaviour byte-for-byte) would
oblige keeping the fabrication path alive and tested as the off-position.
Rollback is a code revert, which is fully reversible.

### Corpus health gate

The eight defect detectors written during this investigation move into
`doctor.ts` as a standing check, so corpus regressions surface without a one-off
script.

**Deliberate scope boundary:** in this stage the detectors **report only**. They
do not write `verification: { method: "provable" }` and they do not un-gate any
field, even though the provable tier is decidable today and 54 of 787 entries
carry no detectable defect.

The reason is Alan. Its critique is entirely fabricated and it trips **zero**
mechanical detectors — a self-consistent lie passes every provable check. So
mechanical cleanliness is necessary and not sufficient for prose, and serving the
provable tier before the image-confirmed verifier exists would re-ship the same
class of fabrication with a trust label attached. Granting verification from the
detectors becomes reasonable once the verifier exists to cover what they cannot
see; until then, everything stays off.

## Tests

The zero-verified path is the default, so it gets the deepest coverage.

- `isVerified` — one case per row of the predicate table: `verification` absent,
  each accepted `method`, an unrecognised `method`, `image-confirmed` with
  `imageSha256` absent, an image path that does not resolve, and
  `reviewStatus: "approved"` combined with each `taggedBy` value, asserting none
  of them changes the verdict.
- The gate performs no I/O: `isVerified` is pure and synchronous, so an entry
  whose image file is absent still returns a verdict from its record alone.
  Existence and hash staleness both belong to `doctor.ts`.
- Zero verified entries: every gated field empty or null, every one carrying an
  `unavailableDecisions` row, `colorTokenAuthority === "editorial"`, no
  `citedDecision` citing the corpus lane, `designDirection` carrying no
  `evidence-N`.
- Some verified entries: prose returns for those entries only, proving the gate
  is a **filter and not an off switch**. Requires a fixture entry carrying a
  valid `verification` record — no real corpus entry qualifies.
- Trust and identity are independent: a verified entry whose prose names a
  product is still dropped by `screenProse`.
- **Vote behaviour on the trusted subset**, which zero-verified and all-verified
  cases both miss:
  - three matched entries, one verified → `colorTokens` stays null, because the
    three-contributor guard counts TRUSTED contributors, not matched ones;
  - three matched, three verified, then a fourth verified entry whose accent
    differs → the served accent may change, and a 2-1 plurality becoming 2-2
    yields `undefined` rather than a silent winner;
  - `layoutRegions` derived only from trusted evidence ids, asserting an
    untrusted row cannot contribute a region.
- **Regression, CRITICAL:** `full-corpus-leak-sweep.test.ts` and the C3 suites
  assert the current served posture. They are updated in the same change, not
  after.
- `doctor.ts` detector tests, using the synthetic corpus already built for the
  leak sweep, plus the image-hash staleness check the gate deliberately omits.

## NOT in scope

- **Stage 2 — the verifier, and the tagger blindness it shares a root with.**
  Attach the image to the critique pass, and resolve what `tagger.ts:1042`
  ("treat every value below as fact, do not re-derive or contradict it") and
  `validateCritiqueComponentClaims` (`:1776`) do when the image contradicts the
  extraction. Then one batch pass over the corpus: screenshot plus the entry's
  claims in, per-field verdict out, writing `provenance.verification` for what it
  confirms. 787 calls, unattended, and `imageDetail: "low"` already halves bulk
  image cost.

  **Calibration has known-correct answers before it costs anything.** The two
  entries hand-audited in this investigation are the verifier's acceptance test:
  `alan-alan-ios-screens-32-…` claims a left rail on a screenshot with no rail,
  and `stackai-stackai-web-screens-13-…` claims a dark canvas on a white one. A
  verifier that misses either is broken, and you know that before spending a call
  on the other 785. Add ~30 stratified spot-checks to calibrate the rate, then
  trust it at scale. That audits one machine once — it does not audit 787 entries.

  The same pass runs at ingest, so a 10,000-entry corpus costs the same per entry
  as 787. No step in this program scales with human availability.

- **Stage 3 — persist `domSignals` on capture.** Promoted out of a deferred TODO:
  it is the only tier that needs no verifier at all. Real contrast ratios, real
  `fontFamily`, real computed styles, currently accepted by the tagger and thrown
  away (0/787 persisted). Recapturable for the 422 entries with a `source.url`.
- **Stage 4 — re-tag**, blocked on tooling: `commit-draft.ts:115` skips ids
  already in the corpus, so a 787-entry re-tag through that flow commits zero
  entries. An overwrite path must be built, with a pre-run snapshot held outside
  the rolling keep-20 in `corpus/.snapshots`. Note `corpus/entries.json` is
  gitignored (`.gitignore:35`) — there is no git-history rollback.
- **Stage 5 — index rebuild + quality-default cleanup.** `entryToDocument` leads
  with `critique` + `whatToSteal` (`embeddings.ts:267`, `:286`) and `:15` names
  content-staleness, so any re-tag invalidates the vector index. The 725 rows
  asserting `qualityScore: 3` / `exceptional` get scored or nulled after a
  downstream-consumer audit.
- **`accessibilityRisks` and `motionGuidance`** — need `domSignals` from a live
  re-crawl, so they unblock with Stage 3 for the 422 recapturable entries and
  stay unavailable for the rest.

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
  `:12` still claims. **Fixing that docblock is in scope for this change** (see
  Design); it misled this investigation's first measurement, and a plan that
  documents a stale claim while touching the same file earns the next one.

**C3 Phase 3 (derived colour) is blocked** on a trustworthy `colorRoles`.

## Stale TODOS to reconcile

- **"C3 Phase 1: cap the synthesized direction length"** — implemented in
  `2ab7ffe`. Remove it; a stale TODO invites the work twice.
- **"Corpus schema: mono role for typography"** — keep, annotated with the
  withdrawal measurement above.
- **"Phase 2" is overloaded** — it names both the typography phase and a
  2026-07-27 "Phase 2 hardening" TODO holding five open P2 findings. Rename.

## Risks

1. **The verifier is the single point of trust.** Every served row will depend on
   it, so a systematically wrong verifier reintroduces the failure at scale with a
   trust label attached — worse than today, because today nothing claims to be
   checked. Mitigations, all in Stage 2: the two known fabrications as a hard
   acceptance test, `verifierVersion` recorded per entry so a bad verifier's
   output is revocable in bulk, and the detectors kept running independently so
   provable defects surface even in "verified" rows.
2. **A machine verifier is weaker than a careful human on any single entry.** It
   is far stronger across 787, because the human alternative is that ~700 entries
   are never checked at all. Coverage beats per-item rigor when the per-item rigor
   does not happen. This is the deliberate trade of the whole program.
3. **Nothing serves until Stage 2 lands.** This spec gates every corpus-derived
   field, and the detectors deliberately do not un-gate the provable tier
   (Alan is self-consistent and fabricated). So `create_ui_spec`'s deterministic
   body returns brief plus scaffolding for however long Stage 2 takes. Accepted:
   an empty answer is honest, a confident wrong one is not.
4. **Verification goes stale on re-capture.** `imageSha256` binds a verification
   to one image, so re-capturing a screenshot invalidates it by design. That is
   correct, and it means the verifier must be cheap enough to re-run on changed
   entries rather than a one-time migration.
5. **The tagger fix and the verifier share a root cause and must not diverge.**
   Both exist because the critique pass was blind. If the tagger starts seeing the
   image but the verifier checks against different rules, the two disagree
   permanently. Stage 2 should build them as one change.
