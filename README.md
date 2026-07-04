# clean-ui-mcp

An MCP server exposing a curated corpus of exceptional UI examples — not a
component library, a **taste** library. Each entry pairs a real-world UI
screenshot with a written critique (what makes it work, what to steal, what to
avoid), structured visual attributes (color roles, type pairing, spacing),
a machine-readable layout wireframe, an optional voice/microcopy analysis, and
a quality tier.

The point isn't to hand an AI components to assemble — there are good tools for
that already (shadcn, Figma MCP, magic-mcp). The point is to give it *specific,
real, well-explained examples* to ground "make it clean" requests in something
other than the statistical average of training data (the "AI slop" failure mode).

## What makes this different

Screenshot libraries have scale (Mobbin: 621k screenshots). They have zero of
five things this corpus leads with:

1. **Anti-patterns** *(required)* — structured "what common mistake does this
   design avoid." The single biggest differentiator. No screenshot library has
   editorial stance; this one does.
2. **Cautionary entries** — genuinely bad examples with a critique of *why* they
   fail, flagged via `qualityTier: "cautionary"`. Mobbin can't do this at all.
3. **Layout wireframes** — `{ form, regions: [{role, width}] }` per entry, so
   an agent can consume page *structure* programmatically, not just read prose.
4. **Color role tokens** — `colorRoles: {canvas, surface, ink, muted, accent}`,
   a paste-ready CSS `:root` token set, not a bare hex list.
5. **Voice/microcopy** — `voice: {tone, examples, avoid}` captures the writing
   voice, not just the visual design. "Good afternoon, Sam" vs "Dashboard" is
   a design decision.

Plus a **two-pass vision tagger** that extracts facts (deterministic color
quantization via node-vibrant) and writes critiques (observation-grounded
reasoning with banned-phrase enforcement) — across three providers.

---

## Table of contents

- [Quick start](#quick-start)
- [Configuration (.env)](#configuration-env)
- [The corpus schema (v2)](#the-corpus-schema-v2)
- [Curator dashboard](#curator-dashboard)
- [Two-pass auto-fill tagger](#two-pass-auto-fill-tagger)
- [Multi-provider support](#multi-provider-support)
- [Dedup at bulk import](#dedup-at-bulk-import)
- [MCP tools](#mcp-tools)
- [Adding entries](#adding-entries)
- [Bulk import workflow](#bulk-import-workflow)
- [Migrations](#migrations)
- [Skill (agent workflow)](#skill-agent-workflow)
- [Project structure](#project-structure)
- [npm scripts reference](#npm-scripts-reference)
- [Why JSON instead of a database](#why-json-instead-of-a-database)
- [Status](#status)

---

## Quick start

```bash
git clone https://github.com/nifabulous/clean-ui-mcp.git
cd clean-ui-mcp
npm install
cp .env.example .env      # then edit .env — add at least one vision provider key
npm run build
npm test
npm run ui                # open http://localhost:3131
```

**Minimum to run:** one vision provider key (OpenAI, Anthropic, or Google) for
Auto-fill. Everything else works without keys (keyword search, validation,
browse/edit).

**Recommended:** add a Voyage API key for semantic vector search (free tier
sufficient).

---

## Configuration (.env)

Copy `.env.example` and fill in what you have. Everything is optional except at
least one vision key for Auto-fill.

```bash
# ─── Vision provider (pick one, or use split-provider mode below) ────────────
AUTO_TAG_PROVIDER=openai             # openai | claude | gemini

# OpenAI
OPENAI_API_KEY=
OPENAI_AUTO_TAG_MODEL=gpt-5.4-nano

# Anthropic Claude
ANTHROPIC_API_KEY=
CLAUDE_AUTO_TAG_MODEL=claude-haiku-4-5

# Google Gemini
GEMINI_API_KEY=
GEMINI_AUTO_TAG_MODEL=gemini-2.5-flash

# ─── Split-provider mode (recommended for best quality per cost) ────────────
# Use different providers for each pass of the two-pass tagger:
#   Extraction (Pass 1): vision + speed → Gemini Flash
#   Critique (Pass 2): reasoning + writing → Claude Sonnet
# If unset, both fall back to AUTO_TAG_PROVIDER above.
#AUTO_TAG_PROVIDER_EXTRACTION=gemini
#AUTO_TAG_PROVIDER_CRITIQUE=claude

# ─── Semantic search (optional — falls back to keyword without it) ──────────
VOYAGE_API_KEY=

# ─── Server ─────────────────────────────────────────────────────────────────
CLEAN_UI_PORT=3131
```

**Auto-fallback:** if the selected provider's key is missing, the tagger
automatically falls back to whichever key IS present. You never get a hard
failure unless no key is set at all.

---

## The corpus schema (v2)

One entry = one exceptional (or cautionary) UI example. Read `src/schema.ts`
for the full Zod definition.

### Required fields

| Field | Type | Purpose |
|---|---|---|
| `id` | kebab-case slug | Stable identifier, e.g. `linear-issue-board-2026` |
| `title` | string | Human label |
| `patternType` | enum (20 values) | The ONE primary pattern. Complements `categories`. Enables "find 10 empty states" as a first-class query. |
| `categories` | enum[] (1-4) | Multi-tag classifier: `dashboard`, `pricing`, `empty-state`, `data-table`, etc. |
| `styleTags` | enum[] (1-4) | Aesthetic: `minimal`, `dense-data`, `editorial`, `brutalist`, `warm-tactile`, etc. |
| `source` | object | `productName`, `url`, `capturedAt`, `capturedBy`, `lastVerified?` |
| `image` | object | `visibility` (private/public-thumb/public-own), `path`, `width`, `height` |
| `visual` | object | `dominantColors`, `accentColor`, `colorRoles?`, `typePairing`, `spacingDensity`, `cornerStyle`, `usesShadows`, `usesBorders` |
| `critique` | string (min 80) | Why this is here. The actual value-add. Enforced non-trivial. |
| `whatToSteal` | string[] (min 1) | Concrete, copyable techniques with reasoning. Not layout ingredients. |
| `antiPatterns` | object | `{ antiPatterns: min 1, whereThisFails: [], accessibilityRisks: [] }`. The Mobbin-beating field. |
| `qualityTier` | enum | `exceptional` (default) or `cautionary` (bad example worth teaching what NOT to do) |
| `qualityScore` | number (1-5) | Your rating, for ranking in search |
| `addedAt` | ISO date | When added |

### Optional fields

| Field | Type | Purpose |
|---|---|---|
| `layout` | object | Machine-readable wireframe: `{ form, regions: [{role, width}] }`. Populated when the layout itself is the teachable thing. |
| `voice` | object | `{ tone, examples: [], avoid: [] }`. Microcopy as a first-class dimension. Populate when the writing is notable. |
| `visual.colorRoles` | object | `{ canvas, surface, ink, muted, accent }` — paste-ready CSS token set. |
| `source.lastVerified` | ISO date | Staleness tracking. Validator warns if >12 months old. |

### Layout wireframe

```json
{
  "form": "three-column",
  "regions": [
    { "role": "summary-strip" },
    { "role": "primary-nav", "width": "fixed-narrow" },
    { "role": "main-canvas", "width": "flex" },
    { "role": "detail-rail", "width": "fixed-wide" }
  ]
}
```

Forms: `single-column`, `two-column`, `three-column`, `modal-overlay`.
Roles: `primary-nav`, `icon-nav`, `summary-strip`, `main-canvas`, `detail-rail`,
`form-panel`, `visual-panel`, `overlay-card`.

### Draft hygiene

Entries containing `[DRAFT]`, `[PLACEHOLDER]`, or `[TODO]` markers in any text
field are rejected at validation. The centralized `findDraftMarkers()` check runs
in the validator, the commit-draft script, the server's save endpoint, and the
browser's real-time validation — one rule, enforced everywhere.

---

## Curator dashboard

```bash
npm run ui    # → http://localhost:3131
```

The dashboard is itself built from the corpus — a three-zone layout (left nav +
card-based main canvas + right detail rail) mirroring the `three-column` form
the Origin dashboard entries describe. The right rail renders each entry's own
`layout.regions` back as a mini wireframe.

### Views

- **Library** — browse entries as a canvas card. Right rail: visual attributes,
  color token strip, layout wireframe, voice block. Click entries in the left
  nav to switch.
- **New sample** — image-first entry creation:
  1. Capture a screenshot from a URL (Playwright Chromium) OR upload a file
  2. Auto-fill (two-pass vision AI drafts all structured fields)
  3. Review the draft — edit critique, steal items, anti-patterns
  4. Save (validator gates in real time)
- **Bulk import** — drop many screenshots at once:
  1. Add files (button or drag-drop) — duplicates auto-rejected
  2. Auto-fill all (bounded concurrency, 3 at a time)
  3. Review the queue — click any row to edit in the full form
  4. Commit ready entries to the corpus
- **Coverage** — category/style coverage stats and orphaned-image cleanup.

### Dashboard features

- **Three-zone dashboard shell** (left nav + canvas + right rail) — derived from
  the corpus's own `three-column` layout field
- **Color token strip** — when an entry has `colorRoles`, the right rail renders
  labeled tokens (canvas/surface/ink/muted/accent) with hex values
- **Layout wireframe** — renders `layout.regions` as a visual mini-diagram
- **Voice block** — shows tone, real copy examples, and what to avoid
- **Real-time validation** — the Save button stays disabled until all required
  fields pass, including the draft-marker hygiene check
- **SSRF guard** — URL capture rejects private/loopback/cloud-metadata addresses
- **Loopback binding** — server binds to 127.0.0.1, not the LAN

---

## Two-pass auto-fill tagger

The tagger uses a **two-pass architecture** for maximum quality:

### Pass 1: Extraction (vision + facts)
- **Colors:** deterministic pixel quantization via `node-vibrant` — the model
  never guesses hex values. It maps the extracted swatches to semantic roles.
- **Structure:** patternType, categories, styleTags, spacing, corners,
  shadows/borders, colorRoles, layout regions.
- **Image attached** at `detail: "high"` so the model can resolve in-card
  components, small text, and fine spacing.

### Pass 2: Critique (reasoning + writing)
- **Text-only** (no image) — the model reasons from Pass 1's validated facts.
- **Observation-first:** must list 5 specific, pointable visual elements before
  writing any critique. Grounds reasoning in what's actually on screen.
- **DECISION + EFFECT + REJECTION:** every claim must name the specific choice,
  why it works, and what conventional default it rejects.
- **Banned-phrase enforcement:** 12 generic phrases ("clean layout", "modern
  design", "user-friendly", etc.) are listed in the prompt AND enforced as a
  post-hoc code-level gate. If any slip through, the tagger retries once with
  error feedback before flagging for human review.

### Quality bar

```
Bad:  "Uses a clean layout with good spacing."
Good: "Hairline borders at low contrast do structural work without the visual
       weight of 1px black lines; the eye reads grouping without noticing the
       borders. Rejects the common default of visible frame borders."
```

---

## Multi-provider support

The tagger works with three vision providers. Set `AUTO_TAG_PROVIDER` and the
matching key. Each provider has its own model override:

| Provider | `AUTO_TAG_PROVIDER` | Key env var | Default model | Model override |
|---|---|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-5.4-nano` | `OPENAI_AUTO_TAG_MODEL` |
| Anthropic Claude | `claude` | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` | `CLAUDE_AUTO_TAG_MODEL` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` | `GEMINI_AUTO_TAG_MODEL` |

### Split-provider mode (recommended)

The two passes are separate API calls and can use different providers:

```bash
# Gemini Flash for extraction (fast vision), Claude Sonnet for critique (deep writing)
AUTO_TAG_PROVIDER_EXTRACTION=gemini
AUTO_TAG_PROVIDER_CRITIQUE=claude
```

Each pass auto-falls back independently if its preferred key is missing.

**Per-image cost** (both passes): ~$0.007 with Gemini→Claude split, ~$0.012
with Claude-only. Under a cent either way.

**Provider differences normalized:** system-prompt placement, image encoding
(data-URI vs raw base64), max-tokens location, auth headers, response text
extraction — all handled behind a shared `callModel` signature.

---

## Dedup at bulk import

When you drop files into Bulk Import, each image is checked against the existing
corpus **before** staging — no API calls wasted on duplicates.

| Level | Method | Catches |
|---|---|---|
| **Exact** | SHA-256 hash | Re-uploads of the same file |
| **Near (perceptual)** | dHash — 64-bit fingerprint, Hamming distance <12 | Same page, different scroll/compression/crop |
| **Fallback** | Same dimensions (±2px) | When dHash is unavailable |

Duplicates show as error rows: `Duplicate (exact|near) of "entry-id" — skipped`.

The dHash algorithm: resize to 9×8 grayscale via `sharp`, compare each pixel
with its right neighbor → 64 bits. Two screenshots of the same dashboard at
different scroll positions produce hashes that differ by only a handful of bits.

---

## MCP tools

Six tools, all read-only over the corpus:

### `search_ui_examples(query?, category?, styleTag?, qualityTier?, minQuality?, limit?)`
The main entry point. Returns metadata + critique for matches, no images.
Uses vector search when an index exists (Voyage), keyword fallback otherwise.
`qualityTier` filter: `"exceptional"` (great examples) or `"cautionary"` (bad
examples worth teaching what NOT to do).

### `get_ui_example(id)`
Full detail for one entry: critique, steal items, anti-patterns, voice, color
roles (as a paste-ready token line), visual attributes, layout, and the image
itself if cleared for redistribution.

### `get_similar_ui_examples(id, limit?)`
Takes a source entry id, ranks the rest by vector cosine similarity. "What other
empty states are like this one?" Requires the embedding index.

### `compare_ui_examples(ids)`
Takes 2-3 ids, returns a structured comparison table across patternType, style,
density, critique angle, top steal, and anti-patterns.

### `list_categories()` / `list_style_tags()`
Discover valid filter values. `list_categories` also reports the search mode
(vector active vs keyword-only).

---

## Adding entries

### Via the curator app (recommended)

`npm run ui` → New sample → upload/capture → Auto-fill → review → Save.

### Via the terminal

```bash
# Capture a screenshot
npm run capture -- --url "https://linear.app" --slug "linear-landing-2026"

# Interactive wizard (optionally runs the vision tagger first)
npm run add-entry -- --image corpus/images-private/linear-landing-2026.png \
  --product "Linear" --url "https://linear.app"

# Validate
npm run validate-corpus

# Rebuild the search index
npm run build-index
```

### Manual

Add a JSON object to `corpus/entries.json` following the shape in
`src/schema.ts`. Run `npm run validate-corpus` before committing.

**Read `docs/SOURCING.md` first** — it covers the three image-visibility tiers
(private/public-thumb/public-own) and the legal/sourcing rules.

---

## Bulk import workflow

For adding many entries at once:

```bash
# Terminal flow (batch scripting)
npm run bulk-import -- --folder corpus/images-private/batch-01
npm run review-draft      # interactive approval
npm run commit-draft      # writes approved entries to corpus

# Or via the dashboard: Bulk import tab → drop files → Auto-fill all → Commit ready
```

**Filename convention:** `<product-slug>__<notes>.png` infers product name + URL
from a built-in table (Linear, Stripe, Vercel, etc.). Unmatched files use a
batch-level default product name.

**Dedup:** every file is checked against the corpus before staging (see
[Dedup](#dedup-at-bulk-import)).

---

## Migrations

The corpus is at **schema v2**. Two migration scripts; both idempotent:

```bash
npm run migrate           # v1 → v2: adds patternType + antiPatterns block
npm run migrate-layout    # populates the layout field for dashboard entries
```

Fresh v2 checkouts don't need either. The validator reports any `[TODO]`
placeholders that still need backfill — non-blocking, but a quality forcing
function.

---

## Skill (agent workflow)

A companion skill (`clean-ui-design`) teaches an AI agent **how to use** the
corpus during design work. It orchestrates the MCP tools into a repeatable
workflow:

1. **Search** the corpus for relevant patterns
2. **Read** the top critiques in depth (steal items, anti-patterns, color roles)
3. **Compare** or **find similar** when exploring
4. **Synthesize** a design brief grounded in real examples — not copies of
   screenshots, but extracted structural decisions applied to the user's context

The skill enforces the same anti-slop guardrails: banned phrases, DECISION +
EFFECT + REJECTION structure, anti-patterns as first-class. Install it in your
agent's skill directory alongside the MCP server.

---

## Project structure

```
clean-ui-mcp/
├── corpus/
│   ├── entries.json            # the corpus — schema v2
│   ├── images-private/         # gitignored — your local research images
│   └── images-public/          # committed — redistribution-cleared thumbnails
├── src/
│   ├── schema.ts               # Zod schema + findDraftMarkers (the data model)
│   ├── corpus.ts               # load / search / similar / compare — pure data layer
│   ├── server.ts               # MCP server: 6 tools
│   ├── embeddings.ts           # Voyage AI client + cosine + index I/O
│   ├── env.ts                  # .env loading + provider config
│   ├── tagger.ts               # two-pass vision tagger (OpenAI/Claude/Gemini)
│   ├── paths.ts                # corpus-path validation (traversal guards)
│   └── scripts/
│       ├── ui-server.ts        # curator dashboard server (3-zone shell)
│       ├── validate-corpus.ts  # standalone validator (CI / pre-commit)
│       ├── migrate-v1-to-v2.ts # v1 → v2 schema migration
│       ├── migrate-layout-field.ts # populates layout field
│       ├── capture.ts          # Puppeteer screenshot capture
│       ├── add-entry.ts        # interactive terminal wizard
│       ├── tag-image.ts        # CLI wrapper for the vision tagger
│       ├── bulk-import.ts      # batch ingest (terminal)
│       ├── review-draft.ts     # interactive draft reviewer (terminal)
│       ├── commit-draft.ts     # commit approved drafts to corpus
│       └── build-index.ts      # embed all entries via Voyage AI
├── index-2.html                # curator dashboard UI
├── docs/SOURCING.md            # legal/sourcing rules — read before adding
├── mcp-config.example.json     # example MCP client config
└── .github/workflows/ci.yml    # CI: build + validate + test (with Playwright)
```

---

## npm scripts reference

| Script | What it does |
|---|---|
| `npm run build` | TypeScript → `dist/` |
| `npm start` | Start the MCP server (stdio) |
| `npm run ui` | Build + start the curator dashboard at `http://localhost:3131` |
| `npm test` | Run all tests (vitest + Playwright browser tests) |
| `npm run validate-corpus` | Validate `entries.json` against schema + hygiene checks |
| `npm run build-index` | Embed all entries via Voyage AI (needs `VOYAGE_API_KEY`) |
| `npm run capture` | Screenshot a URL via Puppeteer |
| `npm run add-entry` | Interactive entry wizard (terminal) |
| `npm run tag-image` | Run the vision tagger on one image |
| `npm run bulk-import` | Batch ingest from a folder of screenshots |
| `npm run review-draft` | Review bulk-import drafts interactively |
| `npm run commit-draft` | Commit approved drafts to the corpus |
| `npm run migrate` | v1 → v2 schema migration (patternType + antiPatterns) |
| `npm run migrate-layout` | Populate the layout field for dashboard entries |

---

## Why JSON instead of a database

At 100-200 entries (and realistically up to a few thousand), a single JSON file
is easier to diff, review in PRs, and hand-edit than a database, and it has zero
native dependencies. `src/corpus.ts` is the only file that knows how entries are
stored — swap it for SQLite/Postgres/a vector store later without touching
`server.ts` if the corpus outgrows this.

---

## Status

Active development. The corpus is growing — add real curated entries before
relying on this for production work. Contributions welcome: new entries, new
patterns, new providers, better critiques.
