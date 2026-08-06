# Field-set gating 2d-2 — synthesis + aggregation tools

**Status:** designed (pending plan)

## Context

2d-1 split the three render/echo tools (`get_ui_example`, `search_ui_examples`,
`get_similar_ui_examples`) into core (hard-gated) + enrichment (render-if-verified,
omitted+disclosed). The three synthesis/aggregation tools were deliberately held at
full-AND in 2d-1: `recommend_ui_direction`, `compare_ui_examples`, and
`get_color_palette` were wired as `(fullCurrentSet, [])` — byte-for-byte with the
pre-2d-1 behavior — because their consumers read entry fields directly and would
crash on absent enrichment.

2d-2 makes those consumers absent-enrichment-safe and splits the three tools into
core/enrichment the same way 2d-1 did for the render tools. It also aligns the
retained-but-not-publicly-registered `generate_design_prompt` with the same
contract, since it shares `generateBrief` with `recommend_ui_direction`.

## Governing invariant

Unchanged from 2d-1, verbatim: "A tool never emits a field value that is not
`isVerified` for that entry. An entry appears in a tool only when ALL of that
tool's **core** fields are verified. A dropped enrichment field is disclosed as
unverified — never silently absent, never a stale value."

Extended surface: the invariant now covers **derived output** as well as
direct-echo — brief clauses (direction, tokens, typography, layout, voice,
techniques, avoid), contribution notes, palette rows, and compare cells.

## Locked decisions

1. **Ordering:** `compare_ui_examples` → `get_color_palette` → `recommend_ui_direction`. Ramp complexity; smallest lift first, largest last with lessons from the first two.
2. **`generate_design_prompt`:** gated too, byte-for-byte with `recommend_ui_direction`'s field set. Legacy path stays honest if ever re-registered.
3. **`recommend_ui_direction` tests:** unit tests over `generateBrief` / `contributionNote` with mixed-verification entries + a fixture-driven MCP handler test that injects a reader with a stubbed `searchRanked` (no real embedding index needed).
4. **Disclosure wording:**
   - **Direct-echo** (compare cells, palette rows) reuse 2d-1's `_Unverified fields omitted: X._` verbatim.
   - **Aggregation** (brief clauses) discloses coverage: `_Drawn from ${K} of ${N} verified entries._` per section when K < N.
5. **Mechanism:** ProjectedEntry type + `projectEntryForSynthesis` helper. Compiler-enforced optionality on consumer inputs.

## Architecture

The reader gate is unchanged: `TrustGatedCorpusReader(inner, core, enrichment)`,
gating on `core` only. A new **synthesis-projection layer** sits between the
reader and the pure functions.

### New file: `src/synthesis-projection.ts`

- `type ProjectedEntry` — `Omit<CorpusEntryT, EnrichmentKey> & Partial<Pick<CorpusEntryT, EnrichmentKey>>` where `EnrichmentKey` is the whitelist of 2d-2 enrichment keys (`visual.colorRoles`, `visual.typePairing`, `voice`, `layout`, `patternType`, `styleTags`, `whatToSteal`, `antiPatterns`, `visual.spacingDensity`, `visual.cornerStyle`, `visual.accentColor`, `visual.usesShadows`, `visual.usesBorders`, `visual.dominantColors`, `antiPatterns.accessibilityRisks`). Nested keys mapped to their innermost field.
- `projectEntryForSynthesis(entry: CorpusEntryT, enrichment: readonly string[]): ProjectedEntry` — returns a shallow-cloned entry with unverified enrichment fields removed (nested where relevant).
- `renderCoverageDisclosure({ used, total, dropped }): string` — the K-of-N brief-clause variant. Returns `""` when `used === total`.
- Reuses `renderOmittedDisclosure` from `serving-projection.ts` for direct-echo surfaces.

### Field-set constants (new in `server-factory.ts`)

```ts
const COMPARE_UI_EXAMPLES_CORE = ["critique"] as const;
const COMPARE_UI_EXAMPLES_ENRICHMENT = [
  "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks",
  "categories", "styleTags", "patternType", "platform", "layout",
  "visual.accentColor", "visual.colorRoles", "visual.spacingDensity",
  "visual.cornerStyle", "visual.usesShadows", "visual.usesBorders",
] as const;

const GET_COLOR_PALETTE_CORE = ["visual.colorRoles"] as const;
const GET_COLOR_PALETTE_ENRICHMENT = ["patternType"] as const;

const RECOMMEND_UI_DIRECTION_CORE = ["whatToSteal"] as const;
const RECOMMEND_UI_DIRECTION_ENRICHMENT = [
  "antiPatterns", "voice", "visual.colorRoles", "visual.typePairing",
  "visual.spacingDensity", "visual.cornerStyle", "layout", "patternType", "styleTags",
] as const;

// Same field set as recommend — shared generateBrief.
const GENERATE_DESIGN_PROMPT_CORE = RECOMMEND_UI_DIRECTION_CORE;
const GENERATE_DESIGN_PROMPT_ENRICHMENT = RECOMMEND_UI_DIRECTION_ENRICHMENT;
```

Union(core, enrichment) for each tool equals today's pre-2d-1 full-AND set → byte-for-byte pin for fully-verified entries.

### Handler flow (per tool call)

1. Reader returns entries where **core** verifies (unchanged from 2d-1).
2. Handler calls `projectEntryForSynthesis(entry, ENRICHMENT)` per entry.
3. Handler passes `ProjectedEntry[]` into the refactored pure function.
4. Pure function guards every enrichment access; falls back to today's honest defaults (`"No voice data in the selected entries"`, `"standard content flow"`, etc.) when a field is absent.
5. Handler appends per-entry / per-section disclosures.

## Components

### `compare_ui_examples`

- Reader constructed `(COMPARE_UI_EXAMPLES_CORE, COMPARE_UI_EXAMPLES_ENRICHMENT)`.
- Handler projects each of 2-3 entries.
- Header cell string built from `[patternType, ...categories, ...styleTags]`; each fragment guarded on the projection; if all three unverified, falls back to `"corpus example"`.
- Row cells: unverified field renders `—`; verified renders as today.
- Trailing per-column disclosure block appended below the table (only when at least one column has omissions):

```
_Column disclosures:_
- **entry-a**: unverified fields omitted: styleTags, layout.
- **entry-b**: (all fields verified).
```

- Row-drop is forbidden; a dropped row would hide verified `critique` core.

### `get_color_palette`

- Reader constructed `(GET_COLOR_PALETTE_CORE, GET_COLOR_PALETTE_ENRICHMENT)`.
- `collectPalettes(entries: ProjectedEntry[], opts, limit)` — `PaletteResult.patternType` becomes `string | null` (was `string`).
- **Filter asymmetry:** `filterEntries` matches an entry only when BOTH `entry.patternType === opts.patternType` AND `isVerified(entry, "patternType")`. An unverified `patternType` can't be filtered on because the caller never sees it verified; the request contract requires the corpus to prove the label. This differs from search-tool filters, which project unverified filter keys but don't refuse the request — palette rows publish the filter key as a label, so an unverified match would label a row with a value the caller never sees verified.
- Row renderer: when `p.patternType === null`, the label line is omitted entirely and the row appends `_Pattern label omitted (unverified)._`; when verified, renders `**${p.patternType}**` as today.
- Palette tokens (canvas/surface/ink/muted/accent) always serve — they belong to `colorRoles`, which is core.

### `recommend_ui_direction`

- Reader constructed `(RECOMMEND_UI_DIRECTION_CORE, RECOMMEND_UI_DIRECTION_ENRICHMENT)`.
- `contributionNote(entry: ProjectedEntry): string` — reads guarded; falls through to `"corpus example"` if every distinctive signal is unverified.
- `generateBrief(entries: ProjectedEntry[], input): DesignBrief` — every enrichment read guarded. `.filter(x => x !== undefined)` already tolerates missing values naturally; new guards on direct reads (`typePairing.notes`, `layout.form`, `layout.regions`, `patternType`). Existing fallback strings unchanged.
- `DesignBrief` gains `coverage: Record<Section, { used: number; total: number; droppedFields: string[] }>`. Renderer uses this to append `_Drawn from ${used} of ${total} verified entries._` per section when `used < total`.
- Direction paragraph still constructed but from fallbacks when key signals absent; the K=0-of-N disclosure names the dropped fields.

### `generate_design_prompt` (private)

- Wired with a gated reader identical to `recommend_ui_direction`'s. Same handler flow.
- Not re-registered publicly; internal call sites (if any) get the same invariant.

### Cross-tool invariant sweep

- Extended `TOOL_ARGS` to invoke `recommend_ui_direction`, `get_color_palette`, `compare_ui_examples` with an entry where only core verifies.
- New sentinel fields in `TOOL_MARKER_FIELDS` per tool.
- Sweep asserts: a sentinel value planted in unverified enrichment never appears in the serialized brief text / palette row / compare cell.
- New pin: for a fully-verified fixture, the three tools' output is byte-identical to today (regression net for the refactor).

## Data flow

```
inner CorpusReader
   │
   ▼  (unchanged) search / getById / findSimilar / entriesForAggregation
TrustGatedCorpusReader(core, enrichment)
   │  gates on CORE only → drops entries with any unverified core field
   ▼
handler: raw CorpusEntryT[]
   │  projectEntryForSynthesis(entry, ENRICHMENT) per entry
   ▼
ProjectedEntry[]  (unverified enrichment fields = undefined)
   │
   ▼
pure function: generateBrief / collectPalettes / compareRenderer
   │  guarded reads only; falls back to today's honest defaults
   ▼
{ text output, per-entry omitted list, per-section coverage counts }
   │
   ▼
render + append disclosure(s) → MCP text content
```

**Coverage accounting for brief clauses:** each section (colorTokens,
typography, layout, voice, techniques, avoid) tracks `total = N` (entries
selected) and `used` (entries where that section's driving field verifies). If
`used < total`, append the K-of-N disclosure. If `used === 0`, section falls
back to today's honest default; disclosure names the field.

**Compare per-column accounting:** each entry column tracks
`omitted: string[]` — the enrichment keys projection stripped. Trailing block
emits one line per column with non-empty `omitted`.

**Palette row accounting:** each row tracks whether `patternType` was
verified. Row-level disclosure per row where it wasn't. No aggregate.

**No hidden state.** Projection is pure and per-entry; disclosure counts are
local to the handler.

## Error handling + edge cases

- **Fully-unverified enrichment across every entry:** compare column all `—` + full column disclosure; palette rows all `_Pattern label omitted._`; brief renders with fallback strings + K=0-of-N disclosure per section.
- **`pickDiverse` degeneracy:** if `searchRanked` returned zero results, handler already returns `emptyCorpusMessage` before projection runs. Unchanged path.
- **`plurality([])`:** already returns `undefined`; `entries.map(e => e.visual.spacingDensity).filter(x => x !== undefined)` may be empty → `plurality` returns `undefined` → layout string falls back to today's `"moderate"` default. Same for `cornerStyle`, `patternType`.
- **Empty enrichment set on an entry:** legal — reader gate already passed. Projection yields entry with only core (`critique`, `whatToSteal`, etc.) filled. Rendering exercises fallbacks; no crash.
- **Filter mismatch on unverified `patternType`:** narrows OUT. Rationale: verified-only match keeps filter contract honest.
- **Sweep failure semantics:** hard test failure naming tool + sentinel + entry. No production crash path.
- **`generateBrief` return shape change:** `DesignBrief.coverage` gained; every existing consumer passes the struct through to the renderer.

## Testing

**New test files:**

- `src/synthesis-projection.test.ts` — pure-function tests for `projectEntryForSynthesis` + `renderCoverageDisclosure`. Mirrors `serving-projection.test.ts`. Covers: full projection, empty projection, nested-key strip, coverage disclosure with K<N / K=0 / K=N.
- `src/synthesis-serving.test.ts` — MCP handler tests for the three tools + `generate_design_prompt`. Injected reader + in-memory fixtures; no real index. Structure mirrors `field-set-serving.test.ts`.

**Extended files:**

- `src/design-prompt.test.ts` — `generateBrief` over `ProjectedEntry[]` with mixed verification. Cases: fully-verified byte-for-byte pin; N=3 with one entry missing `visual.colorRoles`; N=3 with all missing `voice.tone`; empty projection (only `whatToSteal` verified).
- `src/recommend.test.ts` — `buildRecommendation` + `contributionNote` with projected entries.
- `src/aggregations.test.ts` — extend `collectPalettes` tests: `patternType: null` on unverified label; filter narrows out unverified `patternType` matches.
- `src/invariant-sweep.test.ts` — extend to cover the three new tools + byte-identical fully-verified pin. **Remove or invert** the existing `"holds the deferred synthesis tools at full-AND — no partial entry serves"` test case; after 2d-2 those tools DO serve partial entries (with disclosure), which is the whole point. Its replacement asserts that a partially-verified entry produces a served response containing a coverage disclosure + no unverified sentinel.

**Test discipline:** every test uses injected readers + in-memory fixtures; no real `corpus/entries.json` reads. No mocks at the `isVerified` boundary — real `provenance.verification` records on fixtures.

**Coverage targets:** every new branch in `generateBrief` (each guarded read) hit by at least one test; sweep asserts sentinel absence across every gated tool for the partial-verification fixture; byte-identical pin covers the invariant for a fully-verified fixture.

**Commands:** `npx vitest run <task files>` per task; `npm test` + `npx tsc --noEmit` at the end.

## Risks

1. **A synthesis pure function reads an enrichment field without a guard.** Mitigated by compiler-enforced optionality on `ProjectedEntry` — TS refuses to compile until every access is guarded. Extended cross-tool invariant sweep is the runtime backstop.
2. **`generateBrief`'s fallback strings feel "empty" when many enrichments dropped.** Accepted: the K-of-N disclosure names what's missing; thin-but-honest beats withholding a valid direction. Callers see coverage counts and can either broaden the query or accept the partial recommendation.
3. **Compare table with 3 entries and heavy omission looks sparse.** Accepted: sparse rendering with per-column disclosure honestly represents the corpus's verified state; the alternative (silently dropping columns or filling in fabrications) is what 2d-1/2d-2 exists to prevent.
4. **`collectPalettes` filter asymmetry surprises callers.** Documented in code comment: `patternType` filter narrows to verified matches only. Rationale: the label ships with the row, and shipping an unverified label would violate the invariant.
5. **`ProjectedEntry` type maintenance drift.** Whitelist of enrichment keys lives in one place (`synthesis-projection.ts`). Adding an enrichment field means one edit; forgetting to add it means the field stays required in `ProjectedEntry`, which fails the projection helper's contract test (which asserts every key in the whitelist is representable).

## Deferred / not in scope

- Structured-output surface for the synthesis tools (they still emit markdown text; contract-only schemas in `tool-contracts.ts` gain no runtime consumers here).
- Filter-key projection for `search_ui_examples` / `get_similar_ui_examples` (2d-1 already ships them; the palette asymmetry is deliberate).
- `critique_ui` corpus lane — its trust posture is already handled by 2d-1 (`patternType` + `platform` core).
- Any changes to `create_ui_spec` — gates itself; separate contract.
