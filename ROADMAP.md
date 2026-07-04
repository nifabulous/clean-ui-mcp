# Roadmap

Prioritized by leverage and cost. Items marked ✅ are shipped; 🟡 are next;
🔴 are deferred until the corpus reaches the noted scale.

---

## ✅ Shipped

### Schema v2
- `patternType` (required, 20-value enum) — primary pattern classification
- `antiPatterns` (required) — structured: mistakes avoided + where it fails + a11y
- `layout` (optional) — machine-readable wireframe `{form, regions[]}`
- `voice` (optional) — `{tone, examples, avoid}` microcopy dimension
- `qualityTier` — `exceptional` (default) / `cautionary` (bad examples that teach)
- `visual.colorRoles` — paste-ready CSS token set (canvas/surface/ink/muted/accent)
- `source.lastVerified` — staleness tracking + validator warning

### Tagging pipeline
- Two-pass architecture: deterministic color extraction (node-vibrant) →
  observation-grounded critique with banned-phrase enforcement
- Multi-provider: OpenAI + Claude + Gemini, with split-provider mode
  (e.g. Gemini Flash extraction → Claude Sonnet critique)
- dHash perceptual dedup at bulk import (exact SHA-256 + near-duplicate detection)

### MCP tools (6)
- `search_ui_examples` — vector/keyword search with qualityTier filter
- `get_ui_example` — full detail + image
- `get_similar_ui_examples` — cosine similarity ranking
- `compare_ui_examples` — side-by-side structured comparison
- `list_categories` / `list_style_tags`

### Curator dashboard
- Three-zone shell (left nav + card canvas + right detail rail)
- Library, New sample, Bulk import, Coverage views
- Color token strip, layout wireframe, voice block in right rail
- Real-time validation with centralized draft-hygiene gate
- SSRF guard, loopback binding, same-origin CORS

### Analytics
- `npm run corpus-stats` — distribution, coverage gaps, staleness, anti-pattern lint
- `npm run query-stats` — retrieval analytics, dead entries, demand vs supply
- MCP query logging (`corpus/query-log.jsonl`)

### Infrastructure
- Skill (`clean-ui-design`) for agent workflow orchestration
- CI (GitHub Actions: build + validate + 59 tests with Playwright)
- Centralized `findDraftMarkers()` enforced across all 4 write paths
- Git repo at `github.com/nifabulous/clean-ui-mcp`

---

## 🟡 Next (high leverage, buildable now)

### Provenance field
```ts
provenance: z.object({
  taggedBy: z.enum(["human", "auto", "auto-reviewed"]),
  reviewedBy: z.string().optional(),
}).optional()
```
Cheap to add now, expensive to retrofit later. Once you have hundreds of entries
you'll want to know which were rubber-stamped from the tagger vs actually
reviewed — especially for drift detection and if a second curator joins.

### `reviewStatus: "draft" | "approved"`
The proper fix for draft-state encoding (replacing the string-marker approach).
Block MCP search from returning drafts unless explicitly requested via
`search_ui_examples(qualityTier: "draft")` or a `reviewStatus` filter.
Real schema change — additive, optional, backward-compatible.

### Color backfill on existing entries
3 of 38 entries have `colorRoles`. Running Auto-fill on the other 35 would
populate the paste-ready token sets. This is curation work (review the AI output),
not engineering — but it materially increases the corpus's usefulness for the
"paste CSS tokens" use case.

### Cautionary entries (content)
0 of 38 entries are `qualityTier: "cautionary"`. The schema supports it; no
examples exist yet. Find 3-5 genuinely bad UIs, write critiques of why they fail,
and commit them as cautionary entries. This is the feature Mobbin can't touch.

### Coverage gaps (content)
`npm run corpus-stats` shows 8 patternTypes with zero entries: `modal`, `search`,
`checkout`, `profile`, `mobile-nav`, `notifications`, `command-palette`,
`settings`. Prioritize by what `query-stats` shows is actually demanded once
real usage accumulates.

### Anti-pattern quality lint
`corpus-stats` includes a basic vague-phrase lint, but a dedicated anti-pattern
quality gate (separate from the critique banned-phrase list) should flag generic
filler like "avoid clutter," "keep it clean," "be consistent" at validation time,
not just at reporting time. The list should grow as real offenders are spotted.
Prevents quality erosion as volume increases and review time per entry drops.

### `qualityScore` vs `qualityTier` definition
The overlap between `qualityScore` (1-5) and `qualityTier` (exceptional /
cautionary) is underspecified. Needs a one-sentence definition: for cautionary
entries, does `qualityScore` mean "how bad it is" or "how instructive it is"?
Decide and document before scaling past solo curation to avoid inconsistent
tagging.

### Schema versioning strategy
Decide now: bump schema version per field addition, or batch into v3? Otherwise
migration debt accumulates exactly when corpus size makes migrations expensive
to hand-verify. The v1→v2 migration worked because the corpus was small.

### Draft-hygiene regression test
`findDraftMarkers()` runs in four places (validate-corpus, commit-draft,
ui-server, browser). A regression where someone refactors a route and the check
silently stops firing is invisible. Add a checklist test proving all four call
sites invoke it — not just a claim in the README.

---

## 🔴 Deferred (needs scale or new infrastructure)

### Phase 3 tools (need 100+ entries)
- **`generate_design_prompt(ids, framework?)`** — synthesize a design brief
  across N examples for a specific context. Highest-leverage new tool.
- **`recommend_ui_direction(productContext)`** — takes a product description,
  embeds it, searches, synthesizes a recommendation. The "design advisor" tool.
- **MCP Apps response format** — card grid UI for search results when the client
  supports it, falling back to text.

### Design signals expansion (prove-then-expand)
- **Typography stack** — `{display, body, mono, weights, tracking}` as a real
  CSS-ready block (not just font names). Second-highest designSignals priority
  after colorRoles.
- **Iconography** — `iconStyle` (line/filled/duotone), library, sizingScale,
  colorPairing.
- **Imagery strategy** — `imageStrategy` (photography/illustration/data-viz/none),
  treatment, aspect ratios, placement.
- Each proven individually with real data before adding the next.

### Motion & interaction field
`usesShadows`/`usesBorders` capture static attributes, but "what makes this feel
premium" is often *how it moves*: dropdown scale vs slide, skeleton vs spinner,
hover disclosure. Needs a `motion` dimension: `transitionStyle`,
`loadingPattern`, `hoverDisclosure`. **Cannot auto-extract from static
screenshots** — requires interaction recording or manual prose. Lower priority
until the corpus has motion-rich examples.

### `critique_ui(image, productContext)`
The end-state feature: screenshot your own product, find structurally similar
corpus entries, synthesize a critique. Needs **image embeddings** (separate from
text embeddings). Voyage voyage-4 is text-only; this requires a multimodal
embedding model (CLIP, Gemini multimodal, or two-step vision→text→embed).
Significant new integration.

### Multi-image entries + annotations
`ImageRef` is single-image. Add a `screenshots[]` array supporting desktop/mobile/
state variants, plus an `annotations` field — `{x, y, label, note}[]` rendered as
numbered callouts. The annotation UI is the non-trivial part.

### Collections / design recipes
A `collections.json` sidecar with named groups of entry IDs + a synthesis note.
`get_collection(name)` MCP tool returns the full collection. "Modern fintech
onboarding" as a one-call loadable brief. Low leverage at 38 entries; valuable
at 200+.

### Version history per entry
A `history[]` array with dated snapshots. Low implementation cost (store diffs),
high curation cost (re-capture the same product over time). Only meaningful at
scale with a re-capture workflow.

### Multi-curator / reviewer role
Everything (add-entry, review-draft, commit-draft) assumes one curator. No
`reviewedBy`/`approvedBy` distinction in the schema. If contributors are ever
wanted, add a reviewer/approval role before retrofitting becomes expensive.
`source.capturedBy` exists implicitly but doesn't capture who reviewed or
approved the final entry.

### Index staleness detection
Compare corpus entry ids/hash against `embeddings.json`. Surface "index is stale"
in `list_categories` instead of only "index exists." Cheap to build, but low
priority while the corpus is small and rebuilds are fast.

### Corpus dedup at scale
Beyond the image-level dedup already shipped: near-duplicate *entry* detection
(two entries describing the same UI with different tags), coverage rebalancing
alerts, and staleness dashboards. Analysis tooling, not schema — extend
`corpus-stats` rather than adding fields.
