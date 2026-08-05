# Per-field verification — design

**Status:** implemented
**Stage:** 2a of the corpus trust gate program (Stage 1 shipped in #94, `c6b73ba`)

## Why this exists

Stage 1 shipped `isVerified(entry)` — a single boolean per entry. Stage 2's design
work found that shape is wrong, and found it before any entry carried a record, so
the correction is free.

**The defect.** One verification record un-gates *every* field on an entry. The
evidence layer Stage 2b will build can genuinely measure colour roles, contrast and
aspect ratio from pixels. It cannot measure whether "the sidebar groups metrics by
row" is true of an image. So Stage 2 will routinely produce entries that are
`measured` on colour and unverifiable on prose — and today, writing one `measured`
record for such an entry un-gates the prose too.

That re-opens the exact hole Stage 1 closed. `alan-alan-ios-screens-5-2026-07-05`
describes a left navigation rail on a 1179×2556 portrait phone screenshot; a
measured colour record on that entry would serve the phantom rail again, now
carrying a trust label.

The plan for Stage 1 warned about this class in a different place — "granting trust
from these checks would re-ship the same fabrication class with a trust label
attached" (`plans/2026-08-04-corpus-trust-gate.md`, Task 5), written about the
doctor's detectors. The reasoning was applied to the detectors and missed for the
record itself.

**This is a correction to code that shipped on 2026-08-04, not a change of mind.**
Its diff will read as churn against `main`; that is expected.

## Governing invariant

Unchanged from Stage 1, but now enforceable at the granularity it always implied:

> A corpus-derived value is servable only when it is grounded in evidence that can
> be checked. An unverifiable assertion is never served.

The operative word is **value**, not entry. An entry is not a unit of truth: it is
a bag of claims with different evidence available for each. Verification must
attach where the claim is.

## The record

`provenance.verification` becomes a map from **field key** to its own record.

```ts
verification?: {
  [fieldKey: string]: {
    method: string;              // VERIFICATION_METHODS is the authority
    verifiedAt: string;
    verifierVersion: string;
    imageSha256?: string;        // required when method is "image-confirmed"
  };
};
```

The per-record shape is unchanged from Stage 1 — same four fields, same
`.passthrough()` forward-compatibility, same `imageSha256` rule. Only the nesting
changes.

`method` stays a plain string with unknown keys passing through. A corpus written
by a newer verifier must remain *readable* by an older build even when its tiers are
not *trusted*: readability and trust are different questions, and only trust is
fail-closed.

The consequence of getting this wrong differs by mode, and both are bad:

- **Public mode** throws — `corpus-reader.ts:332` raises on a failed parse, so one
  unreadable record makes the whole corpus unavailable.
- **Private mode**, the default, is worse and quieter. A schema-invalid corpus
  decodes as `corrupt`, which `fromDecodeResult` maps to `null`
  (`persistence.ts:138-139`), and the caller **silently falls back to a snapshot or
  the seed**. An older build reading a newer corpus would not error; it would serve
  stale data and say nothing.

Stage 1's review flagged the private-mode path and the note was never corrected.
It is recorded here because the per-field map widens the surface: ten keys per entry
is ten chances for an unknown shape to arrive from a newer verifier.

Since the map's *keys* are open by construction, an unknown key is already
tolerated. The rule that matters is that an unknown key must read as **not
verified** rather than as an error — which the fail-closed predicate gives for free.

### Field keys

Keys are corpus field paths, because that is what a claim is about. The servable
set, derived from what `createUiSpecDeterministic`, the evidence projection, and
the MCP tools actually read:

| key | serves |
|---|---|
| `visual.colorRoles` | `colorTokens`, `get_color_palette` |
| `visual.accentColor` | evidence-summary accent clause (`create-ui-spec.ts:680` → `buildCorpusObservationSummary`), `get_ui_example` Accent row, `compare_ui_examples` accent row |
| `visual.dominantColors` | `get_ui_example` dominant-colours row |
| `visual.spacingDensity` `visual.cornerStyle` `visual.usesShadows` `visual.usesBorders` | direction structured clauses (`create-ui-spec-deterministic.ts:304-324`), evidence summary, `get_ui_example` / `compare_ui_examples` visual rows |
| `visual.typePairing` | direction typography clause, evidence-summary pairing clause |
| `layout` | `layoutRegions`, `responsiveBehavior` form clause |
| `critique` | direction critique clause; critique rendering in `search_ui_examples`, `get_ui_example`, `get_similar_ui_examples`, `compare_ui_examples` |
| `whatToSteal` | `techniques`, `get_stealable_techniques`; steal rows in `search_ui_examples`, `get_similar_ui_examples`, `compare_ui_examples` |
| `antiPatterns` | `antiPatterns`, `get_anti_patterns`; anti-pattern rows in `search_ui_examples`, `compare_ui_examples`, `get_ui_example` |
| `antiPatterns.accessibilityRisks` | `accessibilityConstraints` (fed from `entry.antiPatterns?.accessibilityRisks`, `create-ui-spec-deterministic.ts:496-506` — a distinct claim from `antiPatterns`, with its own evidence); a11y rows in `compare_ui_examples`, `get_ui_example` |
| `voice` | `contentVoiceGuidance`, `get_ui_example` Voice section |
| `components` | `componentInventory` |
| `responsiveBehavior` | `responsiveBehavior` mode clause |
| `patternType` | structuredFacts `pattern`, `compare_ui_examples` / `browse_ui_examples` rendering, palette/anti-pattern scope rendering, critique retrieval |
| `platform` | `compare_ui_examples` platform row, critique retrieval |
| `styleTags` `categories` `mood` `colorScheme` | direction group-B signals, `list_style_tags` / `list_categories`, tag rows in `search_ui_examples` / `compare_ui_examples` |
| `domainTags` | `list_domain_tags` |

An absent key is not verified. There is no wildcard key and no "all" key: a
verifier that wants to attest to ten fields writes ten records. This is deliberate
— a single key meaning "everything" would recreate the defect this spec exists to
fix, and a verifier is never in a position to check ten different claims with one
piece of evidence.

The table is the contract between the verifier (Stage 2b/2c) and the gate: every
served field must be reachable through exactly one key. A field with no key is
permanently withheld with no error, which is the silent over-gating failure this
program exists to eliminate. `accessibilityConstraints` was that case before its
row, and the four visual-structure keys were that case for the direction's
structured clauses until this revision (`create-ui-spec-deterministic.ts:304-324`
serves density/corners/shadows/borders and the first draft of this table carried
no key for them). A sweep of the served selectors AND the MCP tools' render
surfaces against the table is part of the implementation plan (one selector or
render position with no key = a plan bug).

## The predicate

```ts
export function isVerified(entry: CorpusEntryT, field: string): boolean
export function verifiedFields(entry: CorpusEntryT): ReadonlySet<string>
```

`isVerified` gains a required second parameter. Making it required rather than
optional is the point: every call site must state which claim it is asking about,
and a site that cannot name its field has not understood what it is gating. An
optional parameter defaulting to "any field" would let all 18 existing call sites
compile unchanged and silently keep the current wrong behaviour.

Fail-closed rules per record are unchanged: no provenance, no verification, no
record under that key, an unrecognised `method`, or an `image-confirmed` record
with no `imageSha256` all read false.

`verifiedFields` exists for the sites that need the set rather than a single answer
(the per-tool field-set wiring in `createServer`, doctor's per-key reporting, and
the `unassessed-quality` exemption).

`trustedEvidenceIdsOf` gains a required field parameter too — the evidence-id
bridge is built per field (§ `createUiSpecDeterministic`).

## How each consumer changes

### `createUiSpecDeterministic` — per-field selectors behind the same shadow

The Stage 1 structural property holds: the ungated parameter is `allMatchedEntries`
and the body cannot reach it. What changes is that the body no longer has one
trusted list. Instead:

```ts
const verifiedFor = (field: string) => allMatchedEntries.filter((m) => isVerified(m.entry, field));
```

Each selector asks for the field it serves — `verifiedFor("whatToSteal")` for
techniques, `verifiedFor("voice")` for the voice composition. The shadowing still
prevents access to ungated data; naming the field is explicit at each selector,
which is right, because each selector is the only place that knows which field it
reads.

`colorTokens` and `layoutRegions` come from `SanitizedEvidence` rows rather than
entries, so they keep the Stage 1 evidence-id bridge — but the bridge is now built
per field: `trustedEvidenceIdsOf(matched, "visual.colorRoles")`.

**Threshold consequence.** The three-contributor `colorTokens` guard counts entries
verified *for `visual.colorRoles`*, not entries verified for anything. Counting the
latter would derive a palette from entries whose colour was never checked — the
over-claim the program exists to stop.

**The direction's structured clauses.** The density/corners/shadows/borders clauses
(`create-ui-spec-deterministic.ts:304-324`) read structuredFacts projected from
`visual.spacingDensity`, `visual.cornerStyle`, `visual.usesShadows` and
`visual.usesBorders` — four claims with four keys in the table. Each clause is a
per-field selector over its own key, the same shape as the prose selectors.

**The evidence projection strips per field.** `sanitizeCorpusObservation`
(`create-ui-spec.ts:662`) projects an entry's fields into structuredFacts and then
builds the row's summary from them. The projection becomes per-field: a fact is
projected only when its key is verified for that entry, the summary is regenerated
from the surviving facts (the template is recipe-owned over the facts, so stripping
the facts strips the summary mechanically), and a row whose facts are all stripped
is dropped.

One stripped projection feeds BOTH consumers of these rows:

- **The model lane.** The `create-ui-spec.ts:274-279` filter — Stage 1's row-level
  `trustedEvidenceIdsOf` narrowing of what the model sees — is superseded by the
  strip: the model sees exactly the grounded facts, never more. The recipe/system
  row carries no corpus claim and passes through untouched, so Stage 1's
  zero-verified state (recipe row only, no corpus grounding) is preserved.
- **The served `evidence[]`.** Stage 1's note that the served evidence rows stay
  ungated (response-scoped, no authority claim) is superseded for their CONTENT:
  the rows stay response-scoped and carry no authority claim, but their facts and
  summary are corpus-derived values, and the invariant does not distinguish by
  channel.

### `TrustGatedCorpusReader` — gate per tool, at wiring time

`search`, `getById`, `findSimilar` and `entriesForAggregation` return whole entries
to tools that then render a subset of fields. A per-field predicate needs a policy
here, and there are two candidates:

1. **Redact unverified fields from the returned entry.** Correct in principle, but
   the corpus schema has required fields (`critique`, `whatToSteal`), so stripping
   them produces a value that no longer parses as a `CorpusEntryT`. It would force
   a projection type through every tool handler.
2. **Parameterize the reader with the fields the tool serves.** Each registration
   in `createServer` constructs a reader gated on the field set that tool renders:

   ```ts
   registerGetStealableTechniques(server, new TrustGatedCorpusReader(reader, ["whatToSteal"]));
   registerGetColorPalette(server, new TrustGatedCorpusReader(reader, ["visual.colorRoles", "patternType"]));
   ```

**Option 2 is chosen.** It keeps Stage 1's structural property — one filter per
tool, declared at wiring time in `createServer` rather than scattered through
handler bodies — while making the field set explicit and reviewable in one place.
An entry is returned only when *every* field in the set is verified, which is the
conservative reading and the one that cannot over-serve.

`trustPosture()` and `refusedForTrust()` report against the reader's own field set,
so a tool's honest "0 of 787" message stays true for the claim that tool makes.

The double-wrap guard added after review stays — Option 2 constructs several
gated readers, each over the UNGATED reader, and the guard still refuses a gated
reader wrapping a gated reader.

**The field sets.** Each registration's set is exactly the keys of the keyed
fields that tool renders — never wider (over-gating, Risk 2) and never narrower
(over-serving). The initial assignment, from the render-surface sweep against the
field-key table:

| tool | field set |
|---|---|
| `search_ui_examples` | `critique`, `whatToSteal`, `antiPatterns`, `categories`, `styleTags` |
| `get_ui_example` | `critique`, `whatToSteal`, `antiPatterns`, `antiPatterns.accessibilityRisks`, `voice`, `visual.dominantColors`, `visual.accentColor`, `visual.colorRoles`, `visual.typePairing`, `visual.spacingDensity`, `visual.cornerStyle`, `visual.usesShadows`, `visual.usesBorders` |
| `get_similar_ui_examples` | `critique`, `whatToSteal`, `categories`, `styleTags`, `patternType` |
| `compare_ui_examples` | `critique`, `whatToSteal`, `antiPatterns`, `antiPatterns.accessibilityRisks`, `categories`, `styleTags`, `patternType`, `platform`, `layout`, `visual.accentColor`, `visual.colorRoles`, `visual.spacingDensity`, `visual.cornerStyle`, `visual.usesShadows`, `visual.usesBorders` |
| `recommend_ui_direction` | `whatToSteal`, `antiPatterns`, `voice`, `visual.colorRoles`, `visual.typePairing`, `visual.spacingDensity`, `visual.cornerStyle`, `layout`, `patternType`, `styleTags` (the `design-prompt.ts` reads) |
| `get_anti_patterns` | `antiPatterns` |
| `get_color_palette` | `visual.colorRoles`, `patternType` |
| `get_stealable_techniques` | `whatToSteal` |
| `browse_ui_examples` | `patternType` |
| `critique_ui` | `patternType`, `platform` (the CritiqueEntry projection, `critique-retrieval.ts:133-140`) |

Keyless render positions — identity, editorial prose, editorial judgment — enter
no set and must not render (§ Keyless fields). The whole-entry sets are
deliberately broad: the conservative rule binds `get_ui_example` and
`compare_ui_examples` to comprehensive verification, so they stay silent longest.
That is the cost of the reading that cannot over-serve.

`getImageIndex` applies the same rule as every other reader method: an entry's
vector is kept only when the entry is verified for every field in the reader's
set. `critique_ui`'s image index therefore narrows to entries verified for
`patternType` and `platform` — the claims its corpus lane actually renders — so
the gate cannot leak through pixels what it refuses by prose.

### Keyless fields — identity, editorial prose, editorial judgment

Some rendered fields are claims no evidence tier can verify. Three classes:

- **Identity** — `source.productName`, `source.url`, the entry `id`, the `title`.
  The id is identity because id slugs embed the product name
  (`alan-alan-ios-screens-5-2026-07-05`); the title is identity because
  `cleanTitle` falls back to productName (`server-factory.ts:49-52`) and titles
  routinely lead with the product. The precedent this extends already withheld
  both: `get_stealable_techniques` serves "WITHOUT the source product name or
  entry id" (`server-factory.ts`).
- **Editorial prose** — `businessRationale`, `antiPatterns.whereThisFails`.
  Judgment about business context and failure modes; no tier can check either
  against an artifact.
- **Editorial judgment** — `qualityScore`, `qualityTier`. Curation opinion, not
  a design claim with evidence.

They are NEVER part of any field set, and a tool that passes the gate never
renders them. The content fields render; these are redacted at render, identical
in shape to `get_stealable_techniques`' identity screen. Under Option 2 there is
no other reading: a field set containing a keyless field can never pass (nothing
can verify it), and a set excluding it renders a value that was never checked.

This widens Stage 1's identity rule, and the widening SUPERSEDES a documented
Stage 1 decision — `server-factory.ts:780-783` says the retrieval tools "DO
print names and ids by design… they answer 'what is in the corpus'". That
contract is unsatisfiable under Option 2, and "what is in the corpus" is exactly
the assertion the gate cannot ground. It is recorded here because reviewers will
see the render changes as churn against Stage 1's documented behaviour.

Every tool that currently renders a keyless field redacts it:
`search_ui_examples` (`:257-259`), `get_ui_example` (`:313-314`),
`get_similar_ui_examples` (`:490-497`), `compare_ui_examples` (`:541`),
`recommend_ui_direction` (`recommend.ts:106`), `get_color_palette` (`:741`),
`get_anti_patterns` (`:705` — the entry ids in its citations),
`browse_ui_examples` (`:819`), and `critique_ui`'s CritiqueEntry projection
(`critique-retrieval.ts:133-140`). Consequences the plan owns: `browse_ui_examples`'
Top-products/Exemplar columns disappear whole (what remains is the per-pattern
count), and headers built from titles are rebuilt from keyed fields
(patternType + categories) or dropped.

**Public mode redacts too.** The published snapshot ARTIFACT still carries its
source fields — publication is the operator's redistribution decision about the
file — but the MCP serving surface is gated identically in both modes; the
invariant does not branch on mode. Landing consequences: `get_ui_example`'s
description stops promising the source URL, the "(view live at URL)" fallback
text goes, and the public-contract suite is unaffected — for these tools it
asserts absence, which is all it ever asserted.

**Image bytes.** `get_ui_example`'s image attachment serves pixels, and a
`measured` record grounds DOM facts, not pixels (`corpus-trust.ts:42-44` says
exactly this). An image attaches only when the entry carries an `image-confirmed`
record covering at least one field in the tool's set whose `imageSha256` matches
the served file. A measured-only entry renders text without bytes, even where its
visibility would allow them.

Testing consequence: the both-directions test per tool above must assert the
CONTENT renders and the KEYLESS fields do not — a verified-content entry returned
by any of these tools must not leak `productName`, `url`, id or title anywhere in
the served bytes.

### The taxonomy methods

`listCategories`/`listStyleTags`/`listDomainTags` currently recompute from entries
verified at all (`corpus-trust-reader.ts:127`, `:134`, `:141`, added in `f6fc17c`).
They become gated on the field each vocabulary is drawn from — `categories`,
`styleTags`, `domainTags` respectively — so a label is advertised only when the
entry's own tagging of that label was checked.

### `doctor.ts`

`unassessed-quality` (`doctor-helpers.ts:521`) currently exempts an entry with any
verification record. It becomes: exempt when `verifiedFields(entry)` is non-empty.
The detector's claim is "this entry was never assessed" — the tagger's placeholder
quality read as a judgment — and any valid record under any servable key refutes
it: a verifier visited the entry. This is the one site where any-key suffices,
because it is a curation nag, not a serve gate: the fail-closed field precision
the serve path demands does not apply, and `qualityScore`/`qualityTier` are
keyless editorial judgment (§ Keyless fields) that no record attests to directly.
The `verification-malformed` and
`verified-image-missing`/`verified-hash-stale` detectors iterate the record map and
report per key, so one malformed record among ten names the key that is wrong.

A new detector, `verification-orphan-key`, reports a record written under a key that
is not in the servable set — a verifier writing keys nothing reads is a silent
no-op, and the current code would not notice.

### The disclosure warning

Both `create-ui-spec.ts` call sites count entries verified for anything, and both
become per-field:

- `:1500` (the disclosure warning) becomes a per-field count, and the warning
  message names what was and was not verified rather than reporting one number
  that averages incomparable things.
- `:1108` feeds the `unavailableDecisions` gatedReason rows (`:1123-1129`). Today
  ONE shared message uses the anything-verified count for all five gated fields;
  per-field, each row counts the entries verified for THAT field — "Only X of Y
  matched entries carry a recorded verification, and those recorded nothing
  servable for this field" gets its own X per field. A count that is right for
  `whatToSteal` can be wrong for `voice` in the same response — the cross-field
  case again.

## Testing

The Stage 1 test discipline carries over, with the failure modes review found:

- **Both directions per field.** For each servable key: verified serves, unverified
  withholds. A one-direction test passes with the feature simply broken.
- **Keyless redaction, both directions, per tool.** Every tool named in
  § Keyless fields: a verified-content entry renders its content;
  `source.productName`, `source.url`, the entry id and the title appear nowhere
  in the served bytes (the redaction is a rendering property, not a trust field).
- **The cross-field case is the new one, and it is the reason this spec exists.**
  An entry verified for `visual.colorRoles` and NOT for `critique` must serve the
  palette and withhold the critique, in the same response. This is the test that
  fails today and cannot be written against an entry-level predicate.
- **Cross-field evidence-row strip.** An entry verified for `visual.colorRoles`
  only yields an evidence row whose structuredFacts and summary carry the colour
  facts and NOT the layout/typography facts, and the model lane sees the same
  stripped row. Both directions: the verified fact present, the unverified ones
  absent, in one row.
- **Per-field disclosure counts.** The `:1500` warning and the `:1108`
  gatedReason rows report per-field counts: an entry verified for `whatToSteal`
  only counts toward the `whatToSteal` row and no other.
- **Mutation-verified.** Patching `isVerified` to `return true` must fail tests
  across every consumer. Measured on `main` at `c6b73ba` (2026-08-05): **51 tests
  fail** under that mutation. This change must not regress below 51, and should
  exceed it — the cross-field cases are new tests that the mutation also kills.
  (An earlier figure of 35 came from a reviewer's measurement before the taxonomy
  gating in `f6fc17c` and the round-2 fix tests landed; 51 is the current number.)
- **Fixtures unverified by default**, matching production and the fail-closed
  default. Serving tests opt in per field.
- **Schema tests parse through real Zod**, never `as unknown as CorpusEntryT` — the
  seam where Stage 1's forward-compatibility claim was false and its test could not
  see it.
- **No test asserts presence alone.** A record's existence is not the claim; the
  claim is that the right field serves and the wrong one does not.

## Out of scope

- **The evidence bundle** (Stage 2b) and **the retag/verifier** (Stage 2c). This
  spec changes only the shape trust is recorded and read in. It writes no records.
- **The gate's granularity, not the served posture's byte-identity.** Zero entries
  carry a record before this change and zero carry one after, so nothing
  corpus-derived serves — but the served `evidence[]` is NOT byte-identical:
  Stage 1 served corpus-observation rows whose summaries interpolated unverified
  facts, and the strip drops every such row on day one (the served array shrinks
  from `[recipe, corpus-1, ...]` to `[recipe]`). This is the intended tightening
  — those rows were corpus-derived values, and the invariant does not distinguish
  by channel. `retrieval.resultCount` keeps counting retrieved observations (its
  documented meaning) and the `insufficientCorpusEvidence` warning explains the
  gap. The remaining day-one artifacts are static: the rewritten tool
  descriptions, the removal of the source-URL promise text, and the keyless
  render redactions (§ Keyless fields).
- **Redaction/projection types** for partially-verified entries. Rejected above;
  revisit only if per-tool field sets prove too coarse in 2c.

## Risks

1. **A required second parameter touches 18 call sites.** That is the intent — each
   must state its field — but a mechanical rename would let a site pass a
   plausible-looking wrong field and compile. Every site's field choice needs
   review against what that site actually serves, not just a green build.
2. **Per-tool field sets can be wrong in the safe direction and look right.** A set
   that is too broad over-gates: the tool serves nothing and the honest message
   still renders, so nothing fails. Only a both-directions test per tool catches it,
   which is why they are mandatory above.
3. **Whole-entry tools bind to broad sets.** `get_ui_example`'s set is 13 keys and
   `compare_ui_examples`' is 15: an entry serves there only when it is
   comprehensively verified. That is the conservative reading's cost — these tools
   stay silent longest — and Risk 2's safe-direction failure is their PERMANENT
   state until Stage 2c writes broad records. If that proves too coarse in 2c, the
   rejected projection type is the revisit path.
4. **Keyless redaction supersedes a documented Stage 1 contract.** The retrieval
   tools lose titles, quality rows, source lines and id citations when entries
   start passing the gate — a visible behaviour change against
   `server-factory.ts:780-783`, argued in § Keyless fields. The both-directions
   redaction tests are the only thing that keeps the supersession honest.
5. **`colorTokens`' threshold is the subtle one.** It must count entries verified
   for `visual.colorRoles`. Counting any-field-verified entries would pass every
   test that does not specifically mix fields.
6. **This lands on `main` one day after Stage 1.** Reviewers will see two large
   diffs over the same code. The commit message and this spec carry the reason.
