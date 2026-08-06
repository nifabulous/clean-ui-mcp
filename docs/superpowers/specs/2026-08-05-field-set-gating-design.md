# Field-set gating: core + enrichment — design

**Status:** design approved, spec under review
**Stage:** 2d of the corpus trust gate program (Stages 1, 2a, 2c shipped in #94/#95/#98).
Split into **2d-1** (this spec — render/echo tools) and **2d-2** (a follow-up spec —
synthesis/aggregation tools that need consumer hardening; scoped at the end).

## Why this exists

The corpus verifier (Stage 2c) writes per-field `provenance.verification` records, but the
tools that would serve those fields gate with a hard AND over their whole field set:
`TrustGatedCorpusReader.passes(entry) = this.fields.every((f) => isVerified(entry, f))`
(`corpus-trust-reader.ts:60-61`). The field sets are large — `get_ui_example` gates **13**
(`server-factory.ts:105`), `compare_ui_examples` **15** (`:121`), `recommend_ui_direction` **10**
(`:137`). Against a corpus whose prose the audit found ~93% defective and whose soft
classifications verify at a lower rate, the probability an entry passes ALL 13 is ~nil, so even
after a full ~3148-call verify run the rich tools serve close to nothing and the corpus stays
dark.

This program splits what the current gate conflates — "what the tool renders" vs "what must be
verified to serve at all" — so the verify run's payoff reaches the flagship tools. **2d-1**
covers the tools that render/echo entry fields directly (a clean projection). **2d-2** covers the
tools that SYNTHESIZE derived output from many entries (`recommend_ui_direction`,
`compare_ui_examples`, `get_color_palette`), which read enrichment fields unguarded
(`design-prompt.ts:85/125/158`, `recommend.ts:65`, `aggregations.ts:125`) and need their input
contracts hardened so a projected (absent) field is skipped, not read — a distinct, heavier body
of work deferred to its own spec.

## Governing invariant

> A tool never emits a field value that is not `isVerified` for that entry. An entry appears in a
> tool only when ALL of that tool's **core** fields are verified. A dropped enrichment field is
> disclosed as unverified — never silently absent, never a stale value.

Fail-closed is preserved exactly: every served field value is still individually `isVerified`.
The change is that an unrelated unverified field no longer withholds a verified one.

**By construction at the reader, net-enforced at the renderer.** The invariant must hold because
the machinery can't emit an unverified value, not because each renderer remembers to check. In
2d-1 this is achieved by (a) reader-level gating on `core` (hard, structural), (b) a single
shared projection helper every render path routes through, and (c) a cross-tool invariant-sweep
test that walks every tool's output and fails if ANY emitted field is `!isVerified` — the
backstop that makes omission mechanical rather than per-renderer discipline. The synthesis tools
that can't yet satisfy this (their consumers read enrichment unguarded) are held at full-AND in
2d-1 and fixed in 2d-2 — they never serve a partial entry in 2d-1, so they can't leak.

## The model: core + enrichment

Every currently-gated field for a tool becomes either **core** (hard-gated: entry omitted from
the tool entirely if any core field is unverified) or **enrichment** (rendered only when
`isVerified` for that entry; omitted+disclosed otherwise). Non-gated metadata (`id`, `image`,
`source`) is untouched.

### 2d-1 tool mapping (this spec)

| Tool | core (hard-gated) | enrichment (render-if-verified) |
|---|---|---|
| `get_ui_example` | `critique` | whatToSteal, antiPatterns, antiPatterns.accessibilityRisks, voice, visual.dominantColors, visual.accentColor, visual.colorRoles, visual.typePairing, visual.spacingDensity, visual.cornerStyle, visual.usesShadows, visual.usesBorders |
| `search_ui_examples` | `critique` | whatToSteal, antiPatterns, categories, styleTags |
| `get_similar_ui_examples` | `critique` | whatToSteal, categories, styleTags, patternType |
| `get_anti_patterns` | `antiPatterns` | — |
| `get_stealable_techniques` | `whatToSteal` | — |
| `list_categories` | `categories` | — |
| `list_styleTags` | `styleTags` | — |
| `list_domainTags` | `domainTags` | — |
| `browse_ui_examples` | `patternType` | — |
| `critique_ui` | `patternType`, `platform` | — |

`critique_ui`'s gated fields are MATCH KEYS for pulling comparison context, not fields rendered
from a corpus entry; matching on an unverified classification would be dishonest, so both stay
core (behaviour identical to today). The single-field tools (`get_anti_patterns`,
`get_stealable_techniques`, `list_*`, `browse_ui_examples`) have `core = [their one field]`,
`enrichment = []` — byte-for-byte unchanged.

Only **three** tools actually gain an enrichment split in 2d-1: `get_ui_example`,
`search_ui_examples`, `get_similar_ui_examples`.

### Deferred to 2d-2 (held at full-AND in 2d-1)

`recommend_ui_direction`, `compare_ui_examples`, `get_color_palette`. In 2d-1 these migrate to the
new two-set constructor as `(fullCurrentSet, [])` — every field core, `enrichment = []` — so their
`passes()` is byte-for-byte the current full-AND and they never render a partial entry. 2d-2 does
their core/enrichment split AND the consumer hardening (`generateBrief`, `contributionNote`,
`collectPalettes`, the compare table) so absent enrichment is skipped, plus projection over
derived output (palette row labels, compare cells, brief clauses). This keeps 2d-1's invariant
true by construction without touching the unguarded synthesis code.

## Architecture (2d-1)

### 1. `TrustGatedCorpusReader(inner, core[], enrichment[])`
- Constructor takes TWO field sets (was one). `enrichment` defaults to `[]`.
- `passes(entry) = core.every((f) => isVerified(entry, f))` — over `core` only.
- Guards preserved: **empty CORE set** is refused (an empty core makes `every([])` vacuously
  true and un-gates every entry — the failure the current empty-set guard at
  `corpus-trust-reader.ts:52-58` catches, now keyed on core); double-wrap refused.
- Read methods still return full `CorpusEntryT` (matching/ranking need the whole entry);
  projection happens at the render boundary via the shared helper below. This keeps the reader's
  typed contract clean — no partial-entry objects flow through it.
- `core`/`enrichment` are exposed as read-only accessors for the message/image-attach consumers
  (see below), replacing the single `fields` accessor.

### 2. `projectForServing(entry, enrichment[]): { served: ServedFields; omitted: string[] }`
A pure, shared helper — the SINGLE place enrichment is dropped, called by every render path.
- For each enrichment field, `isVerified(entry, field)` decides keep vs omit; `served` carries
  only the verified enrichment keys (core + metadata are the renderer's to add), `omitted` lists
  the rest. Omit (absent), never `null` — a `null` could be misread as an empty value; the
  disclosure is the sole "exists but unverified" signal.
- **Nested keys** (`antiPatterns` vs `antiPatterns.accessibilityRisks`, and the `visual.*` leaves)
  are INDEPENDENT verification keys, projected per leaf:
  - `antiPatterns` unverified → the whole `antiPatterns` object is omitted, even if
    `antiPatterns.accessibilityRisks` is verified (no parent, no child); disclose `antiPatterns`.
  - `antiPatterns` verified + `antiPatterns.accessibilityRisks` unverified → serve `antiPatterns`
    with its `accessibilityRisks` section stripped; disclose `antiPatterns.accessibilityRisks`.
  - `visual.*` leaves have no `visual` gate key; each leaf is projected independently and the
    `visual` container renders with whatever leaves verified.

### 3. Per-tool render + disclosure
Each render path builds its response from core + `projectForServing`'s `served` enrichment, and
attaches a **per-entry** disclosure naming the omitted-because-unverified fields.
- **Single-entry** (`get_ui_example`): one disclosure block listing the entry's omitted fields.
- **Multi-entry** (`search_ui_examples`, `get_similar_ui_examples`): disclosure is PER RESULT —
  each rendered entry carries its own omitted list (NOT an aggregate count; the caller must be
  able to tell which result dropped which field). The existing `buildPerFieldDisclosure`
  (`create-ui-spec.ts:1548`) is an aggregate-count shape (`whatToSteal 3/5`) that attributes
  nothing to a specific entry, so it is NOT reused here; 2d-1 defines a compact per-entry list.
  Per-entry lists hold at most 12 field names (the size of the largest enrichment set), so no
  500-char bound applies.
- Response schemas: the enrichment fields these three tools emit become OPTIONAL, and a
  disclosure field is added. (Only these three tools' schemas change in 2d-1.) **Which schemas:**
  the three MCP tools return text content and declare no MCP `outputSchema` (only `critique_ui`
  does), so the change lands on the CANONICAL descriptor `dataSchema`s in `tool-contracts.ts` —
  `ReferenceSummary` (`:291`), `SimilarReference` (`:306`), `FullReference` (`:386`) — plus their
  `makeValidSuccess` fixtures in `__fixtures__/tool-contract-fixtures.ts`. The "schema
  round-trip" test is therefore a canonical-envelope test via `parseToolResult`, not an
  MCP-output test.

## Data flow (2d-1)

```
query
  → inner reader matches the full corpus (ungated)
  → TrustGatedCorpusReader.passes filters to entries whose CORE fields all verify
  → render path calls projectForServing(entry, enrichment) → { served, omitted }
  → emit: core fields + served enrichment + per-entry disclosure(omitted)
```

An entry with a verified `critique` lights up `get_ui_example` immediately with whatever other
fields verified and a disclosure for the rest — instead of needing all 13. `critique` is exactly
what the seeing-Pass-2 re-produce path exists to fix, so the verify run's payoff flows straight to
the flagship read tools.

## Shared consumers of the old `fields` accessor (all updated in 2d-1)

The single `fields` accessor has four consumers the two-set constructor must not break:

- `emptyCorpusMessage` (`server-factory.ts:166`), `unresolvedIdsMessage` (`:194`),
  `corpusEvidenceNote` (`:219`) — reword from "verified for every field this tool serves
  (`fields`)" to "verified for every **core** field this tool serves (`core`)", since core is now
  what gates inclusion. (Enrichment being unverified no longer withholds the entry, so it would be
  wrong to name it as the reason nothing serves.)
- **Image-attach** (`server-factory.ts:388`, `gate.fields.includes(field)`): attach the entry's
  screenshot when **any SERVED field** — a core field, or a verified (non-omitted) enrichment
  field — is `image-confirmed` for that image hash. Concretely, over `verifiedFields(entry)`
  intersected with `core ∪ enrichment`, any field whose record is `image-confirmed` with a
  matching `imageSha256`. This attaches the image iff it genuinely backs something the caller
  sees.

## Error handling

- Empty core set / double-wrap → constructor throws (guards preserved).
- An enrichment field with a malformed/absent record → `isVerified` false → omitted (fail-closed).
- A fully-verified entry → empty `omitted`, empty disclosure — serves everything.

## Testing (2d-1)

- **Reader:** core-only gate — entry with core verified + enrichment unverified → included; core
  unverified → excluded. Empty-core refusal; double-wrap refusal. The deferred synthesis tools
  constructed `(fullSet, [])` behave byte-for-byte as today (a test pins one at full-AND).
- **`projectForServing`:** an entry with **≥2 verified and ≥2 unverified** enrichment fields →
  only verified enrichment in `served`, `omitted` exact, core/metadata untouched. Nested cases:
  parent-fail-drops-child; parent-verified-child-unverified-strips-leaf.
- **Per-tool:** each of the three split tools with a partially-verified entry → core present,
  verified enrichment present, unverified enrichment ABSENT (not null, not stale), per-entry
  disclosure lists the omitted; core-unverified entry excluded entirely. Multi-entry tools:
  disclosure is attributable to the right result.
- **Cross-tool invariant sweep:** one test walks EVERY gated tool's output over a
  partially-verified corpus and asserts no emitted field value is `!isVerified` — the fail-closed
  net. (In 2d-1 the deferred synthesis tools are all-core, so their output is trivially all-core;
  2d-2 extends this sweep to derived output — brief clauses, palette rows, compare cells.)
- **Image-attach:** an entry whose only `image-confirmed` field is a served enrichment field →
  image attaches; an entry whose image-confirmed field is an OMITTED enrichment field → no attach.
- **Schema round-trip:** an entry with omitted enrichment validates against the three tools'
  (now enrichment-optional) response schemas.
- **Corpus isolation:** injected readers + in-memory fixtures only; no test reads/writes the real
  `corpus/entries.json`.

## Out of scope (2d-1)

- **The verify run itself** — operator action, live keys, ~3148 calls; independent of gating.
- **Changing which fields a tool renders** — 2d-1 only splits the existing gated set.
- **`recommend_ui_direction`, `compare_ui_examples`, `get_color_palette`** — deferred to 2d-2
  (below); held at full-AND in 2d-1.

## Stage 2d-2 (follow-up spec, not this plan)

Splits the three synthesis/aggregation tools and hardens their consumers so a projected (absent)
enrichment field is skipped, not read:

- **`recommend_ui_direction`** (core `whatToSteal`): `generateBrief` (`design-prompt.ts`) reads
  `e.visual.typePairing.notes` (`:85/:145`), `e.antiPatterns.antiPatterns` (`:125/:132`),
  `e.styleTags` (`:158`), `e.visual.spacingDensity`, `e.patternType` unguarded; `contributionNote`
  (`recommend.ts:65`) reads `e.visual.colorRoles`/`e.patternType`/`e.voice`/`e.layout`. Each must
  treat an absent enrichment field as "skip that signal" — a real input-contract change
  (compiler-enforced optionality), plus a fixture-based recommendation test (note:
  `tool-trust-gate.test.ts` skips `recommend_ui_direction` because it needs an index, so nothing
  currently exercises this path).
- **`get_color_palette`** (core `visual.colorRoles`, enrichment `patternType`): `collectPalettes`
  (`aggregations.ts:125`) emits `patternType` as a row label AND filters on it (`:32`). Projection
  must be defined over the RESULT, not just the entry: an entry with verified `colorRoles` but
  unverified `patternType` serves the palette row with the label rendered as unverified/omitted +
  a row disclosure; the request filter matches only entries whose `patternType` is verified.
  (Note the deliberate asymmetry vs the search tools, which filter freely on unverified
  `category`/`styleTag` and project only RENDERED values; 2d-2's spec should state why the
  palette filter key gets gated there and not in search — the difference is that `patternType`
  doubles as the row label, so an unverified match would label a row with a value the caller
  never sees verified.)
- **`compare_ui_examples`** (core `critique` both entries): an omitted cell in a `| field | cell |`
  table renders `—` with a per-row disclosure (drop the CELL, never the row — dropping a row would
  hide a verified core).
- The cross-tool invariant sweep extends to cover derived output (brief direction/tokens/
  typography/layout/voice/techniques/avoid, contribution notes, palette rows, compare cells) —
  exactly where an unverified-value leak would live.

## Risks

1. **A render path bypasses `projectForServing`**, leaking an unverified value. Mitigated by the
   cross-tool invariant sweep (a single test asserting no emitted field is unverified, over every
   tool) — the fail-closed net that makes omission mechanical, not per-renderer discipline.
2. **Core chosen too loose** → thin results (an entry served on `critique` alone). Accepted: the
   disclosure names what is missing; thin-but-honest beats withholding a verified critique. A
   future tightening is a config change (move a field enrichment → core).
3. **Deferring the synthesis tools** leaves `recommend`/`compare`/`get_color_palette` dark until
   2d-2. Accepted: they stay exactly as today (full-AND), no regression; the flagship
   `get_ui_example` — the highest-value tool — lights up in 2d-1.
