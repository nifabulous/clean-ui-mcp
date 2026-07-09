# Roadmap

Last updated: 2026-07-09. Reflects the state of `main` at 787 entries.

---

## Shipped

### Corpus & schema

- **787 entries** with schema support for 21 pattern types, 31 component types,
  15 domain tags, 35 cautionary examples
- **Rich schema** with 27+ fields per entry: patternType, categories, styleTags,
  components, domainTags, colorScheme, industryVertical, responsiveBehavior,
  mood, visual attributes (colors, colorRoles, typePairing, spacing, corners,
  shadows, borders), critique, whatToSteal, antiPatterns (mistakes +
  where-fails + evidence-backed a11y risks), voice, layout wireframe,
  businessRationale, patternDiscovery, qualityTier/score, provenance,
  reviewStatus
- **Draft hygiene gate** — centralized `[DRAFT]`/`[PLACEHOLDER]`/`[TODO]` marker
  rejection across validator, commit-draft, UI save, and browser validation

### Tagging pipeline

- **Two-pass vision tagger** — extraction (vision + facts) + critique (reasoning
  + writing), with banned-phrase enforcement and observation-first grounding
- **5 providers** — OpenAI, Claude, Gemini (vision); Mistral, DeepSeek
  (text-only critique). Split-provider mode with per-pass overrides.
- **DOM signals** — batch captures extract computed styles, accessibility
  metrics, structure, and copy. Injected as VERIFIED GROUND TRUTH into both
  passes (bodyFont override, a11y checklist, contrastRatio).
- **v2 critique prompt** — behavioral insight (not pixel description), named
  user types, 5-point a11y checklist, 2+ anti-patterns with "what was rejected"
  framing, mood extraction. Tuned via 3 A/B rounds (DeepSeek vs Claude).
- **Categorization calibration** — prompt nudges toward under-represented
  patterns (chat-interface, pricing, command-palette, calculator)
- **Claim-grounded critique** — critique prompt strips deterministic palette
  injection, requires observation-backed claims, and drops unsupported
  accessibility risks rather than preserving speculative findings
- **Pattern discovery lane** — extraction can persist
  `patternDiscovery.suggestedPatternType` for screens that do not fit the
  closed enum; `npm run pattern-discovery` summarizes candidates before enum
  promotion
- **Cautionary tier calibration** — sharpened prompt: "exceptional means worth
  learning from, not flawless; cautionary is rare"
- **Adaptive detail** — low-detail extraction re-runs at high when weak
- **Deferred critique** — extraction-only mode for cheap bulk staging
- **Provider override threading** — per-call provider selection without env
  mutation races

### Capture pipeline

- **Batch capture** — Playwright/Chromium, multi-viewport (desktop + mobile),
  section/group/anchor detection, consent-modal handling, robots.txt check
- **DOM signals extraction** — eager (while locator alive), 3s timeout
  (Promise.race), capped copy (20×200 chars), best-effort (never blocks capture)
- **Error isolation** — one bad URL doesn't abort the batch
- **Perceptual-hash dedup** — aHash (capture), dHash (upload + commit), SHA-256
  (exact), persisted `.dhash-cache.json`
- **DOM-signals sidecar** — `dom-signals.json` written alongside manifest +
  triage

### Curator dashboard

- **SPA architecture** — sidebar + main canvas + detail rail
- **Multi-select** — checkbox selection + "Select all matching" (filter-driven,
  across all pages)
- **Bulk tier actions** — promote/reject to exceptional/cautionary
- **Bulk re-tag** — `/api/auto-retag` with per-run provider picker, live progress
- **Zip import** — client-side extraction (fflate), recursive nested zips
- **In-batch dedup** — catches sibling duplicates during bulk import
- **Classic workbench** — bulk import triage, capture batch review, deferred
  critique queue
- **Entry rename** — id-only rename endpoint and UI affordance; image filenames
  stay unchanged during day-to-day curation

### Durability & trust

- **Atomic writes** — temp + rename; crash-safe
- **Rolling snapshots** — last 20 timestamped copies, auto-recovery on corrupt
- **`restore-corpus` CLI** — `--list`, `--dry-run`, `--latest`, `--snapshot`
- **Entry-count drift floor** — `expectedMinEntries` config
- **Index drift detection** — missing/stale vector reporting
- **Commit-draft dedup gate** — CLI path now has the same dedup as the UI

### Search & retrieval

- **Semantic vector search** — Voyage AI embeddings, cosine similarity
- **Embedding reweighting** — design characteristics (pattern, style, components,
  colors, layout) emphasized over product identity. Fixes product-clustering in
  `get_similar_ui_examples`.
- **Keyword fallback** — when no Voyage key set
- **12 MCP tools** — search, get, similar, compare, browse, recommend, generate,
  list-categories, list-style-tags, anti-patterns, color-palette, stealable-
  techniques
- **Enhanced compare table** — platform, layout, accent, a11y risks, quality tier
- **Placeholder title cleanup** — in all MCP tool output

### Dedup tooling

- **`src/dedup.ts`** — extracted module (dHash, SHA-256, findDuplicateAtCommit,
  cache management). Shared by UI server + CLI scripts.
- **`dedup-cleanup` CLI** — find duplicate clusters, score by completeness,
  keep winner, remove losers. Dry-run default, `--threshold`, `--json` output.
- **Three dedup layers** — upload-time, in-batch, commit-time

### Infrastructure

- **251 tests** across 16 files (vitest unit + Playwright browser)
- **CI** — build + validate + test on every PR
- **`.env` override fix** — file always wins over stale shell env vars
- **Sources file** — `sources-cautionary.json` with 12 cautionary capture targets

---

## Next

### Operational (content, not code)

- **Bulk re-tag the existing corpus** — 787 entries are missing components,
  domainTags, colorScheme, mood, industryVertical, responsiveBehavior, and
  accessibilityRisks. The bulk re-tag tool is built and ready; this is the
  single highest-ROI action. Run dedup-cleanup first, smoke retag, run
  `npm run pattern-discovery`, promote real pattern gaps, then re-tag and
  rebuild the embeddings index.
- **Run dedup-cleanup** — the corpus likely has duplicate clusters from
  auto-capture batches. Clean before re-tagging so you don't pay to re-tag dupes.
- **Capture under-represented patterns** — command-palette (2), pricing (4),
  notifications (5), chat-interface (6). Build targeted `sources.json` files.
- **Refresh cautionary sourcing** — pending capture triage has been cleared
  locally; the next content task is targeted recapture for under-represented
  cautionary patterns.

### Code improvements (lower priority)

- **Dedup the dedup** — `ui-server.ts` still has its own copy of the dHash/
  SHA-256 functions alongside the extracted `dedup.ts`. Should import from
  `dedup.ts` and delete the local copies.
- **MCP `list_domain_tags` tool** — agents consuming the MCP can't discover the
  domain vocabulary. Add alongside `list_categories` / `list_style_tags`.
- **`entryTextFields` should include `domainTags`** — currently doesn't;
  domainTags are enum-constrained so it's not a bug, but inconsistent.
- **`corpus-stats` extension** — add domainTags, components, colorScheme, mood,
  industryVertical to the distribution + coverage-gap report.

---

## Deferred

- **Image filename normalization** — if filesystem tidiness starts to matter,
  add a separate maintenance script such as
  `npm run normalize-image-filenames -- --dry-run`. Keep day-to-day entry
  renames scoped to `entry.id`; do not rename image files as part of the normal
  rename flow.
- **pHash (DCT-based perceptual hash)** — more robust than dHash against
  compression artifacts and minor color shifts. Not needed today (the 90+
  duplicate clusters are all byte-identical or d=0 — a gate-bypass bug, not
  an algorithm failure). Add as a second signal alongside dHash when the
  dedup-cleanup tool with `--threshold 15` starts surfacing clusters that
  `--threshold 8` missed.
- **Voyage rerank (`rerank-2`)** — cross-encoder reranking over cosine top-K.
  Biggest search-quality jump. Same key you already have. ~1 hour to implement.
- **Database migration (SQLite/Postgres)** — JSON + snapshots is working at
  787 entries. The `corpus.ts` seam is ready. Trigger: low thousands of
  entries, concurrent multi-curator writes, or transactional multi-row commits.
- **CLIP-style visual embeddings** — image+text in the same space for
  "find UIs that look like this one" regardless of critique text. Most novel
  addition, most work.
- **Animation/transitions** — can't be captured from a static screenshot.
  Would require video capture or interaction recording.
- **Additional providers** — Pixtral (vision), Llama, Groq. The 5 current
  providers cover the space; provider churn is real but adding more isn't the
  bottleneck.
