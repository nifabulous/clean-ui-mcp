# Roadmap

Prioritized by leverage and cost. Items marked ✅ are shipped; 🟡 are next;
🔴 are deferred. Counts are live as of 426 entries — re-derive with
`npm run corpus-stats`.

---

## ✅ Shipped

### Schema v2
- `patternType` (required, 20-value enum) — primary pattern classification
- `antiPatterns` (required) — structured: mistakes avoided + where it fails + a11y
- `layout` (optional) — machine-readable wireframe `{form, regions[]}` (84% coverage)
- `voice` (optional) — `{tone, examples, avoid}` microcopy dimension (95% coverage)
- `qualityTier` — `exceptional` (default) / `cautionary` — 41 cautionary entries exist
- `visual.colorRoles` — paste-ready CSS token set (73% coverage)
- `source.lastVerified` — staleness tracking + validator warning

### Tagging pipeline
- Two-pass architecture: deterministic color extraction (node-vibrant) →
  observation-grounded critique with banned-phrase enforcement
- Multi-provider: OpenAI + Claude + Gemini, with split-provider mode
  (e.g. Gemini Flash extraction → Claude Sonnet critique)
- Gemini thinking disabled on extraction (was burning output budget → truncated JSON)
- Transient 503/502/504 retry with exponential backoff across all providers
- dHash perceptual dedup at bulk import + **commit-time dedup gate** (the
  authoritative check at `POST /entries`, not just at upload)
- Deferred-critique mode (extraction now, critique on demand) halves bulk cost

### MCP tools (12)
- `search_ui_examples` — vector/keyword search with qualityTier filter
- `get_ui_example` — full detail + image
- `get_similar_ui_examples` — cosine similarity ranking
- `compare_ui_examples` — side-by-side structured comparison
- `list_categories` / `list_style_tags`
- `generate_design_prompt(ids, framework?)` — synthesize a design brief across
  2-5 entries (paste-ready color tokens, typography, layout, voice, anti-patterns)
- `recommend_ui_direction(productContext)` — the "design advisor": describe what
  you're building, it embeds + searches + synthesizes with product diversity
- `get_anti_patterns(patternType?)` — consensus mistakes to avoid, the Mobbin-
  can't-offer feature (534 anti-pattern statements, ranked by how many entries
  raise each)
- `get_color_palette(patternType?, styleTag?)` — paste-ready token sets grouped
  by accent hue band (192 distinct accents → palette generator)
- `get_stealable_techniques(patternType?, styleTag?)` — 1690 techniques deduped
  by theme, browsed by pattern/style
- `browse_ui_examples(styleTag?)` — what's in the corpus by pattern (count,
  top products, exemplar) — discovery before search

### Curator dashboard
- Three-zone shell (left nav + card canvas + right detail rail)
- Library, New sample, Bulk import, Coverage views
- Color token strip, layout wireframe, voice block in right rail
- Real-time validation with centralized draft-hygiene gate
- SSRF guard, loopback binding, same-origin CORS
- Recovery surface (`/api/health` + snapshot count on stats page)

### Corpus trust & recovery
- `npm run doctor` — one-command PASS/WARN/FAIL health check
- `npm run restore-corpus` — `--list` / `--latest` / `--snapshot` / `--dry-run`
  with diff (added/removed/duplicate ids) + pre-restore snapshot
- `npm run clean-orphans` — `--dry-run` (default) / `--confirm`
- Entry-count drift check (`corpus/.corpus-config.json` `expectedMinEntries`)
- Atomic writes + rolling snapshots (20) + auto-recover from corrupt primary
- Commit-time dedup gate (SHA-256 + dHash)
- Index drift detection (`missing` + `stale` surfaced everywhere)

### Analytics
- `npm run corpus-stats` — distribution, coverage gaps, staleness, anti-pattern
  lint, **index coverage**, **image references (orphans/missing)**,
  **quality metrics** (voice/layout/image %, top products)
- `npm run query-stats` — retrieval analytics, dead entries, demand vs supply
- MCP query logging (`corpus/query-log.jsonl`)

### Infrastructure
- Durability layer extracted (`src/persistence.ts`) — reusable by CLIs
- Tests decoupled from mutable corpus (fixtures + `setCorpusForTesting`)
- Skill (`clean-ui-design`) for agent workflow orchestration
- CI (GitHub Actions: build + validate + tests with Playwright)
- Centralized `findDraftMarkers()` enforced across all 4 write paths
- Embedding rebuild is incremental + checkpointed + 429-resilient
- Git repo at `github.com/nifabulous/clean-ui-mcp`

---

## 🟡 Next (high leverage, buildable now)

The corpus has crossed the density thresholds several deferred items needed.

### `reviewStatus: "draft" | "approved"`
The proper fix for draft-state encoding, replacing the `[DRAFT]` string-marker
hack. Block MCP search from returning drafts unless explicitly requested. Real
schema change — additive, optional, backward-compatible. At 426 entries the
marker approach is friction; with a second curator it becomes a correctness bug.

### Provenance field
```ts
provenance: z.object({
  taggedBy: z.enum(["human", "auto", "auto-reviewed"]),
  reviewedBy: z.string().optional(),
}).optional()
```
With 426 entries, you've lost track of which were rubber-stamped from the tagger
vs actually reviewed. Cheap to add now (backfill all existing as
`"auto-reviewed"`), expensive to reconstruct later. Especially matters for drift
detection and if a second curator joins.

### Anti-pattern quality lint at validation time
`corpus-stats` has a reporting-only vague-phrase lint. Promote it to a
validation-time gate (separate from the critique banned-phrase list) so generic
filler ("avoid clutter," "keep it clean") is caught at save, not at report time.
The list should grow as real offenders are spotted. Prevents quality erosion as
volume increases and review time per entry drops.

### `qualityScore` vs `qualityTier` definition
Unresolved. With 41 cautionary entries, the question is acute: for a cautionary
entry, does `qualityScore` mean "how bad the design is" or "how instructive the
example is"? Decide in one sentence and document it in the schema before scaling
past solo curation to avoid inconsistent tagging.

### Schema versioning strategy
Decide now: bump schema version per field addition, or batch into v3? Otherwise
migration debt accumulates exactly when corpus size makes migrations expensive
to hand-verify. The v1→v2 migration worked because the corpus was small.

### Draft-hygiene regression test
`findDraftMarkers()` runs in four places (validate-corpus, commit-draft,
ui-server, browser). A regression where a refactor silently stops a check firing
is invisible. Add a checklist test proving all four call sites invoke it.

### Transactional imports
The bulk-import flow has screenshots, drafts, entries, snapshots, and the dedup
cache loosely coordinated. Stage a batch with a manifest, then commit the batch
atomically after validation. Deferred from the recovery cluster — it's a workflow
redesign that deserves focused attention.

### Seed / private corpus split
The repo mixes shareable seed metadata with local private curation. Make it
explicit: `corpus/entries.json` for committed/shareable metadata, a gitignored
private working file for local curation. Reduces accidental overwrites and
makes tests + the public repo cleaner. Deferred from the recovery cluster.

---

## 🔴 Deferred (needs new infrastructure or scale)

### Design signals expansion (prove-then-expand)
- **Typography stack** — `{display, body, mono, weights, tracking}` as a real
  CSS-ready block (not just font names). Second-highest designSignals priority
  after colorRoles (which is now at 73%).
- **Iconography** — `iconStyle` (line/filled/duotone), library, sizingScale.
- **Imagery strategy** — `imageStrategy`, treatment, aspect ratios.
- Each proven individually with real data before adding the next.

### Motion & interaction field
`usesShadows`/`usesBorders` capture static attributes, but "what makes this feel
premium" is often *how it moves*. Needs a `motion` dimension. **Cannot
auto-extract from static screenshots** — requires interaction recording or manual
prose. Lower priority until the corpus has motion-rich examples.

### `critique_ui(image, productContext)`
The end-state feature: screenshot your own product, find structurally similar
corpus entries, synthesize a critique. Needs **image embeddings** (separate from
text embeddings). Voyage voyage-4 is text-only; this requires a multimodal
embedding model. Significant new integration.

### Multi-image entries + annotations
`ImageRef` is single-image. Add a `screenshots[]` array supporting desktop/mobile/
state variants, plus `annotations` — `{x, y, label, note}[]` rendered as numbered
callouts. The annotation UI is the non-trivial part.

### Collections / design recipes
A `collections.json` sidecar with named groups of entry IDs + a synthesis note.
`get_collection(name)` MCP tool returns the full collection. "Modern fintech
onboarding" as a one-call loadable brief. **Valuable at 426 entries now** —
worth revisiting once `generate_design_prompt` proves the synthesis pattern.

### Version history per entry
A `history[]` array with dated snapshots. Low implementation cost (store diffs),
high curation cost (re-capture over time). Only meaningful with a re-capture
workflow.

### Multi-curator / reviewer role
Everything (add-entry, review-draft, commit-draft) assumes one curator. No
`reviewedBy`/`approvedBy` distinction in the schema. If contributors are ever
wanted, add a reviewer/approval role before retrofitting becomes expensive.

### Corpus dedup at scale
Beyond the image-level dedup already shipped: near-duplicate *entry* detection
(two entries describing the same UI with different tags), coverage rebalancing
alerts, staleness dashboards. Analysis tooling, not schema — extend
`corpus-stats`.

---

## Content backfill (curation, not engineering)

These need human judgment, not code:

- **colorRoles**: 73% → finish the last ~115 in normal curation (no longer a
  roadmap blocker)
- **patternType coverage**: 17/20 — only `command-palette` is empty now
- **"Untitled" product name**: 91 entries have product "Untitled" — the tagger
  couldn't read the wordmark. Worth a backfill pass naming them.
- **Cautionary entries**: 41 exist (the Mobbin-can't-touch-this feature) — keep
  growing as you find genuinely instructive bad UIs
