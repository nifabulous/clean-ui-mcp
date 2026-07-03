# clean-ui-mcp

An MCP server exposing a small, curated corpus of exceptional UI examples —
not a component library, a *taste* library. Each entry pairs a real-world UI
example with a written critique (what makes it work, what to steal, what to
avoid), structured visual attributes (colors, type pairing, spacing), a
machine-readable **layout** wireframe, and an image where one is available.

The point isn't to hand an AI components to assemble — there are good tools for
that already. The point is to give it *specific, real, well-explained examples*
to ground "make it clean" requests in something other than the statistical
average of training data (the "AI slop" failure mode — see `docs/SOURCING.md`
for the design rationale).

## What makes this different from Mobbin

Screenshot libraries have scale (Mobbin: 621k screenshots). They have zero of
three things this corpus leads with:

1. **Anti-patterns** — structured "what common mistake does this design avoid."
   The differentiator. Required on every entry.
2. **A structured layout wireframe** — `{ form, regions: [{role, width}] }` per
   entry, so an agent can consume *structure* programmatically, not just read
   prose. Dashboards get `three-column` with `primary-nav → main-canvas →
   detail-rail`; onboarding gets `two-column`; modals get `modal-overlay`.
3. **A written critique** — the actual IP. Tags and hex codes are cheap to
   scrape; a specific explanation of *why* something works is not.

## Project structure

```
clean-ui-mcp/
├── corpus/
│   ├── entries.json          # the corpus itself — schema v2, start here
│   ├── images-private/       # gitignored, your local research images
│   └── images-public/        # committed, redistribution-cleared thumbnails
├── src/
│   ├── schema.ts              # zod schema — the data model, read this first
│   ├── corpus.ts              # load/search/similar — pure data layer, no MCP
│   ├── server.ts              # MCP server: 6 tools, wires to corpus.ts
│   ├── embeddings.ts          # Voyage AI client + cosine + index I/O
│   ├── tagger.ts              # multi-provider vision auto-tagger (OpenAI/Claude/Gemini)
│   └── scripts/
│       ├── validate-corpus.ts # standalone validator, good for CI/pre-commit
│       ├── migrate-v1-to-v2.ts       # one-shot schema migration (patternType + antiPatterns)
│       ├── migrate-layout-field.ts   # populates the structured layout field
│       ├── capture.ts / add-entry.ts # terminal ingest
│       └── bulk-import.ts / review-draft.ts / commit-draft.ts  # batch ingest
├── index-2.html               # curator dashboard (served by npm run ui)
└── mcp-config.example.json    # example client config (Claude Desktop / Code)
```

## Setup

```bash
npm install
cp .env.example .env
npm run build
npm test
```

Put local keys in `.env`; never paste them into committed files.

**Vision providers (Auto-fill):** any one of OpenAI, Anthropic Claude, or Google
Gemini. Set `AUTO_TAG_PROVIDER` (default `openai`) and the corresponding key. If
the preferred key is missing, auto-falls back to whichever key is present.

**Semantic search:** set `VOYAGE_API_KEY` (falls back to keyword search without it).

## The corpus schema (v2)

One entry = one exceptional UI example. The fields that matter most:

- **`patternType`** *(required)* — the ONE primary pattern (e.g. `dashboard`,
  `empty-state`, `pricing`, `command-palette`). Complements the 1-4 `categories`
  tags. Makes "find 10 great empty states" a first-class query axis.
- **`critique`** *(required, min 80 chars)* — why this is here, in your words.
  The actual value-add; enforced non-trivial so empty/lazy entries fail loudly.
- **`whatToSteal`** *(required)* — concrete, copyable techniques. Not "use a
  hero" (layout ingredient) but "mark a recommended option with a border-color
  change alone, skip the ribbon" (a technique).
- **`antiPatterns`** *(required)* — structured block: `antiPatterns` (mistakes
  avoided, min 1), `whereThisFails` (contexts where copying hurts),
  `accessibilityRisks`. The Mobbin-beating field.
- **`layout`** *(optional)* — a machine-readable wireframe: `{ form, regions[] }`.
  Optional because an entry can be excellent without a documented layout
  (Stripe's value is typographic). Populated when the layout itself is the
  teachable thing.
- **`visual`** — `dominantColors`, `accentColor`, `typePairing`, `spacingDensity`,
  `cornerStyle`, `usesShadows`, `usesBorders`.

Read `src/schema.ts` for the full Zod definition. `docs/SOURCING.md` for the
legal/sourcing rules — read it before adding entries.

## Curator dashboard

Run the local corpus workbench:

```bash
npm run ui
```

Then open `http://localhost:3131`. The dashboard is itself built from the corpus:
it's a three-zone layout (left nav + card-based main canvas + right detail rail)
mirroring the `three-column` form the Origin dashboard entries describe. The
right rail renders each entry's own `layout.regions` back as a mini wireframe —
the product consuming its own structural instruction.

Four views:

- **Library** — browse entries; the selected entry renders as a canvas card with
  critique, steal items, and anti-patterns; visual attributes + layout wireframe
  in the right rail.
- **New sample** — image-first entry creation: capture a screenshot from a URL or
  upload one, then Auto-fill (vision AI drafts the structured fields), review,
  and save. The validator gates save in real time.
- **Bulk import** — drop many screenshots at once; each becomes a staged draft;
  Auto-fill all, review the queue, commit ready entries. Mirrors the terminal
  `bulk-import` flow in the browser.
- **Coverage** — category/style coverage stats and orphaned-image cleanup.

Auto-fill supports three vision providers — set `AUTO_TAG_PROVIDER` and the
matching key in `.env`:

| Provider | `AUTO_TAG_PROVIDER` | Key env var | Default model | Model env var |
|---|---|---|---|---|
| OpenAI (default) | `openai` | `OPENAI_API_KEY` | `gpt-5.4-nano` | `OPENAI_AUTO_TAG_MODEL` |
| Anthropic Claude | `claude` | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` | `CLAUDE_AUTO_TAG_MODEL` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` | `GEMINI_AUTO_TAG_MODEL` |

If the selected provider's key is missing, Auto-fill auto-falls back to whichever
key is present. The two-pass tagger (deterministic color extraction via
node-vibrant + observation-grounded critique) works identically across all three.

**Split-provider mode (recommended):** the two passes are separate API calls and
can use different providers. Extraction (Pass 1) needs vision + speed; critique
(Pass 2) needs reasoning + writing. The best combination for depth is a fast
vision model for extraction and a strong reasoning model for critique:

```bash
# In .env — Gemini Flash extracts facts, Claude Sonnet writes the critique
AUTO_TAG_PROVIDER_EXTRACTION=gemini
GEMINI_AUTO_TAG_MODEL=gemini-2.5-flash
AUTO_TAG_PROVIDER_CRITIQUE=claude
CLAUDE_AUTO_TAG_MODEL=claude-sonnet-4-5
```

Each pass auto-falls back independently if its preferred key is missing. If both
split vars are unset, both fall back to `AUTO_TAG_PROVIDER`.

```bash
cp .env.example .env
# edit .env — add one of: OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY
npm run ui
```

URL capture uses Playwright's bundled Chromium. If capture fails with a browser
install message, run `npx playwright install chromium`.

After adding or changing entries, run:

```bash
npm run validate-corpus
npm run build-index     # refreshes semantic search (needs VOYAGE_API_KEY)
```

## Adding the server to an MCP client

Copy `mcp-config.example.json`'s contents into your client's MCP config,
pointing at the absolute path to `dist/server.js` after building. See that file
for the exact shape.

## Tools exposed

Six tools, all read-only over the corpus:

- **`search_ui_examples(query?, category?, styleTag?, minQuality?, limit?)`** —
  the main entry point. Returns metadata + critique for matches, no images
  (keeps responses small). Uses vector search when an index exists, keyword
  fallback otherwise.
- **`get_ui_example(id)`** — full detail for one entry: critique, steal items,
  anti-patterns, visual attributes, layout, and the image itself if cleared for
  redistribution.
- **`get_similar_ui_examples(id, limit?)`** — takes a source entry id, ranks the
  rest by vector cosine similarity. "What other empty states are like this one?"
  Requires the embedding index.
- **`compare_ui_examples(ids)`** — takes 2-3 ids, returns a structured comparison
  table across patternType, style, density, critique angle, top steal, and
  anti-patterns.
- **`list_categories()`** / **`list_style_tags()`** — discover valid filter values.

## Adding entries to the corpus

1. Read `docs/SOURCING.md` first — it's short and matters.
2. Add a new object to `corpus/entries.json` following the shape in
   `src/schema.ts`. The `critique`, `whatToSteal`, and `antiPatterns` fields are
   the actual value — don't skimp on them.
3. Run `npm run validate-corpus` before committing. It enforces the schema
   (including minimum lengths and a `[DRAFT]`/`[PLACEHOLDER]`/`[TODO]` marker
   check) and catches duplicate ids.

### Assisted ingest (curator app)

The dashboard is the easiest path. The terminal workflow is still available for
batching or scripted capture:

```bash
npm run capture -- --url "https://linear.app" --slug "linear-landing-2026"
npm run add-entry -- --image corpus/images-private/linear-landing-2026.png \
  --product "Linear" --url "https://linear.app"
npm run validate-corpus
npm run build-index
```

For larger batches, place screenshots under `corpus/images-private/` and run:

```bash
npm run bulk-import -- --folder corpus/images-private/batch-01
npm run review-draft
npm run commit-draft
```

The bulk importer infers product/URL from filename conventions
(`<product-slug>__<notes>.png`, e.g. `linear__issue-board.png`); unmatched files
use a batch-level default product name.

Image paths stored in `entries.json` must be corpus-relative, for example
`images-private/example.png` or `images-public/example-thumb.png`. Public images
must live under `images-public/` and include dimensions. Legacy/manual private
entries can still be link-only with `path`, `width`, and `height` set to `null`.

Semantic vector search requires `VOYAGE_API_KEY` in `.env`; without it the server
falls back to token-based keyword search.

## Migrations

The corpus is at **schema v2**. Two migration scripts exist; both are idempotent
and safe to re-run:

```bash
npm run migrate          # v1 → v2: adds patternType + restructures whatToAvoidHere → antiPatterns
npm run migrate-layout   # populates the structured layout field for dashboard entries
```

If you're working from a fresh checkout of a v2 corpus, you don't need to run
either. The validator reports any `[TODO]` anti-pattern placeholders that still
need backfill — non-blocking, but a forcing function for data quality.

## Why JSON instead of a database

At 100-200 entries (and realistically up to a few thousand), a single JSON file
is easier to diff, review in PRs, and hand-edit than a database, and it has zero
native dependencies. `src/corpus.ts` is the only file that knows how entries are
stored — swap it for SQLite/Postgres/a vector store later without touching
`server.ts` if the corpus outgrows this.

## Status

Early scaffold. The corpus starts with a few examples to demonstrate the schema
(including structured layouts on the dashboard entries). Add real curated
entries before relying on this for anything serious.
