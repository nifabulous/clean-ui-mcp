# Roadmap

Prioritized by leverage and cost. Items marked ✅ are shipped; 🟡 are next;
🔴 are deferred. Run `npm run corpus-stats` for live corpus totals and coverage.

---

## ✅ Shipped

### Schema v2
- `patternType` (required, 21-value enum) — primary pattern classification
- `antiPatterns` (required) — structured: mistakes avoided + where it fails + a11y
- `layout` (optional) — machine-readable wireframe `{form, regions[]}`
- `voice` (optional) — `{tone, examples, avoid}` microcopy dimension
- `qualityTier` — `exceptional` (default) / `cautionary`
- `visual.colorRoles` — paste-ready CSS token set
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
- Platform-aware extraction: portrait mobile removes desktop side rails and
  their layout regions; web removes mobile bottom navigation; tablet remains
  intentionally unfiltered
- Critique grounding: immediate and deferred critique consume normalized
  extraction facts, while raw model output remains audit-only

### Workflow state
- `reviewStatus: "draft" | "approved"` schema field (optional, defaults approved)
- MCP search hides drafts by default; surface with `reviewStatus:"draft"` or `"any"`
- `findSimilarEntries` excludes drafts (a draft shouldn't surface as "similar to")
- Aggregation tools (anti-patterns, palettes, techniques, browse) exclude drafts too
- Curator UI: review-state toggle in the form, draft chip in list + detail
- Properly separates content hygiene ([DRAFT] marker gate) from workflow state
- **Decision: approved-by-default.** Tagger output and bulk imports land as
  approved — solo fast-curation workflow trusts the tagger and reviews inline.
  reviewStatus is opt-in for entries that need a second look, not a tax on every
  import. Revisit if a second curator joins or tagger quality drops.
- `provenance: { taggedBy: human|auto|auto-reviewed, reviewedBy? }` — tracks how
  fields were produced. Tagger marks `auto`; PUT handler flips to `auto-reviewed`
  on human edit; CLI marks `human`. corpus-stats surfaces the split. Optional,
  defaults absent (existing entries show as "unknown" — no migration).

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
- `get_anti_patterns(patternType?)` — consensus mistakes to avoid, ranked by
  how many entries raise each
- `get_color_palette(patternType?, styleTag?)` — paste-ready token sets grouped
  by accent hue band
- `get_stealable_techniques(patternType?, styleTag?)` — techniques deduped by
  theme, browsed by pattern/style
- `browse_ui_examples(styleTag?)` — what's in the corpus by pattern (count,
  top products, exemplar) — discovery before search

### Curator dashboard
- Three-zone shell (left nav + card canvas + right detail rail)
- Library, New sample, Bulk import, Coverage views
- Color token strip, layout wireframe, voice block in right rail
- Real-time validation with centralized draft-hygiene gate
- SSRF guard, loopback binding, same-origin CORS
- Recovery surface (`/api/health` + snapshot count on stats page)
- Split into `ui/styles.css` + `ui/app.js` + slim HTML shell (was 1931 lines,
  now 57 + 426 + 1450), served via path-traversal-guarded `/static/*` route

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

### Anti-pattern quality lint at validation time
`corpus-stats` has a reporting-only vague-phrase lint. Promote it to a
validation-time gate (separate from the critique banned-phrase list) so generic
filler ("avoid clutter," "keep it clean") is caught at save, not at report time.
The list should grow as real offenders are spotted. Prevents quality erosion as
volume increases and review time per entry drops.

### `qualityScore` vs `qualityTier` definition
Unresolved. For a cautionary entry, does `qualityScore` mean "how bad the design
is" or "how instructive the example is"? Decide in one sentence and document it
in the schema before scaling past solo curation to avoid inconsistent tagging.

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

---

## 🔴 Deferred (needs new infrastructure or scale)

### Design signals expansion (prove-then-expand)
- **Typography stack** — `{display, body, mono, weights, tracking}` as a real
  CSS-ready block (not just font names).
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
  onboarding" as a one-call loadable brief. Revisit once
  `generate_design_prompt` proves the synthesis pattern.

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

- **Enrichment fields:** components, domain tags, color scheme, mood, industry,
  and responsive behavior remain sparse; improve them through staged retagging.
- **Thin patterns:** prioritize calculator, notifications, and command-palette
  examples while maintaining full pattern coverage.
- **Product names:** rerun `npm run migrate-untitled` when new imports leave
  canonical names unresolved.
- **Cautionary entries:** keep growing the collection only with genuinely
  instructive failures.
