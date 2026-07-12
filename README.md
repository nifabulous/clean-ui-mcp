# clean-ui-mcp

An MCP server exposing a curated corpus of exceptional UI examples — not a
component library, a **taste** library. Each entry pairs a real-world UI
screenshot with a written critique (what makes it work, what to steal, what to
avoid), structured visual attributes (color roles, type pairing, spacing),
a machine-readable layout wireframe, a visible-component taxonomy, a
business-domain classification, an optional voice/microcopy analysis, an
emotional mood register, and a quality tier.

The point isn't to hand an AI components to assemble — there are good tools for
that already (shadcn, Figma MCP, magic-mcp). The point is to give it *specific,
real, well-explained examples* to ground "make it clean" requests in something
other than the statistical average of training data (the "AI slop" failure mode).

> **Live corpus:** run `npm run corpus-stats` for current entry, coverage, and
> quality metrics. The schema and retrieval API evolve independently of corpus
> size, so this command is the source of truth for live totals.

---

## Table of contents

- [What makes this different](#what-makes-this-different)
- [Quick start](#quick-start)
- [Connect to an MCP client](#connect-to-an-mcp-client)
- [Configuration (.env)](#configuration-env)
- [The corpus schema](#the-corpus-schema)
- [Curator dashboard](#curator-dashboard)
- [Two-pass auto-fill tagger](#two-pass-auto-fill-tagger)
- [Multi-provider support](#multi-provider-support)
- [DOM signals extraction](#dom-signals-extraction)
- [Bulk re-tag](#bulk-re-tag)
- [Dedup](#dedup)
- [MCP tools (14)](#mcp-tools-14)
- [Decision Lab](#decision-lab)
- [Skill — agent workflow](#skill--agent-workflow)
- [Adding entries](#adding-entries)
- [Batch capture pipeline](#batch-capture-pipeline)
- [Bulk import workflow](#bulk-import-workflow)
- [Corpus trust & recovery](#corpus-trust--recovery)
- [Analytics](#analytics)
- [Migrations](#migrations)
- [Tagger evaluation loop](#tagger-evaluation-loop)
- [Project structure](#project-structure)
- [npm scripts reference](#npm-scripts-reference)
- [Testing](#testing)
- [Why JSON instead of a database](#why-json-instead-of-a-database)
- [Status](#status)

---

## What makes this different

Screenshot libraries have scale (Mobbin: 621k screenshots). They have zero of
seven things this corpus leads with:

1. **Anti-patterns** *(required)* — structured "what common mistake does this
   design avoid." The single biggest differentiator. No screenshot library has
   an editorial stance; this one does.
2. **Cautionary entries** — genuinely bad examples with a critique of *why* they
   fail, flagged via `qualityTier: "cautionary"` (45 in the corpus today). Mobbin
   can't do this at all.
3. **Layout wireframes** — `{ form, regions: [{role, width}] }` per entry, so
   an agent can consume page *structure* programmatically, not just read prose
   when layout is the teachable part of the screen.
4. **Color role tokens** — `colorRoles: {canvas, surface, ink, muted, accent}`,
   a paste-ready CSS `:root` token set, not a bare hex list.
5. **Voice/microcopy** — `voice: {tone, examples, avoid}` captures the writing
   voice, not just the visual design. "Good afternoon, Sam" vs
   "Dashboard" is a design decision.
6. **Component taxonomy** — visible UI parts (`sidebar-nav`, `bottom-nav`,
   `action-list`, `kpi-card`, `donut-chart`, `pricing-card`,
   `kanban-board`, etc.) separate from design-pattern categories. Enables
   "show me dashboards with donut charts" without inferring a product shell.
7. **Domain tags** — 15-value enum (`billing`, `security`, `team-management`,
   `integrations`, etc.) capturing the business/product context of the page.
   A billing page is correctly tagged `categories:["settings","dashboard"]` —
   domain tags let you answer "show me billing screens."

Plus a **two-pass vision tagger** that extracts facts (deterministic color
quantization via node-vibrant + DOM signals) and writes critiques
(observation-grounded reasoning with banned-phrase enforcement and
WCAG-criterion-cited accessibility risks) — across five providers, with an
optional split-provider mode for best quality per cost.

---

## Quick start

```bash
git clone https://github.com/nifabulous/clean-ui-mcp.git
cd clean-ui-mcp
npm install
npx playwright install chromium   # browser engine for capture + browser tests
cp .env.example .env      # then edit .env — add at least one vision provider key
npm run build
npm test
npm run ui                # open http://localhost:3131
```

**Minimum to run the MCP server:** nothing. With no keys at all, the server
starts and serves keyword search over the shipped corpus. Add a vision key only
when you want Auto-fill. Add a Voyage key only when you want semantic vector
search.

**Recommended for the full experience:**
- One vision provider key (OpenAI, Anthropic, or Google) for Auto-fill.
- A Voyage API key for semantic vector search (free tier sufficient).

---

## Connect to an MCP client

After `npm run build`, point any MCP-compatible client at the server:

```json
{
  "mcpServers": {
    "clean-ui": {
      "command": "node",
      "args": ["/absolute/path/to/clean-ui-mcp/dist/server.js"]
    }
  }
}
```

Drop this into your client's config file — `claude_desktop_config.json` for
Claude Desktop, `.mcp.json` for Claude Code, or the equivalent for whichever
MCP client you use. The server speaks stdio and exposes the 14 tools listed
under [MCP tools](#mcp-tools-14).

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
CLAUDE_AUTO_TAG_MODEL=claude-sonnet-4-5

# Google Gemini
GEMINI_API_KEY=
GEMINI_AUTO_TAG_MODEL=gemini-3.5-flash

# Mistral Large (critique-only — no vision; OpenAI-compatible API)
MISTRAL_API_KEY=
MISTRAL_BASE_URL=https://api.mistral.ai/v1   # or a compatible gateway
MISTRAL_AUTO_TAG_MODEL=mistral-large-latest

# ─── Split-provider mode (recommended for best quality per cost) ────────────
# Use different providers for each pass of the two-pass tagger:
#   Extraction (Pass 1): vision + speed → Gemini Flash or OpenAI
#   Critique (Pass 2): reasoning + writing → Claude Sonnet or DeepSeek
#AUTO_TAG_PROVIDER_EXTRACTION=gemini
#AUTO_TAG_PROVIDER_CRITIQUE=claude

# ─── OpenAI-compatible endpoints (DeepSeek, NIM, OpenRouter, Together) ──────
#OPENAI_BASE_URL_CRITIQUE=https://api.deepseek.com
#OPENAI_API_KEY_CRITIQUE=sk-...
#OPENAI_AUTO_TAG_MODEL_CRITIQUE=deepseek-v4-pro

# ─── Optional tuning ────────────────────────────────────────────────────────
#DEBUG_TAGGER=1             # per-call provider config + token usage to stderr
#OPENAI_THINKING_DISABLED=1 # forces thinking OFF (NIM etc)

# ─── Semantic search ────────────────────────────────────────────────────────
VOYAGE_API_KEY=

# ─── Server ─────────────────────────────────────────────────────────────────
CLEAN_UI_PORT=3131
```

**Auto-fallback:** if the selected provider's key is missing, the tagger
automatically falls back to whichever key IS present. The `.env` file always
overrides stale shell env vars (so you never need to `unset` anything).

**Capability gates:** the system knows which providers can do what — Mistral
and DeepSeek are text-only and cannot run the vision extraction pass.
`hasVisionKey()` and `hasCritiqueKey()` enforce the right gate at each endpoint.

---

## The corpus schema

One entry = one exceptional (or cautionary) UI example. Read `src/schema.ts`
for the full Zod definition — it is the single source of truth.

### Classification fields

| Field | Type | Purpose |
|---|---|---|
| `patternType` | enum (21) | The ONE primary pattern (`dashboard`, `pricing`, `auth`, `command-palette`, `calculator`, ...) |
| `patternDiscovery` | object? | Persisted open-vocabulary suggestion lane: `{ suggestedPatternType, currentPatternType }`, summarized by `npm run pattern-discovery` before enum promotion |
| `categories` | enum[] (1-4) | Multi-tag design-pattern classifier |
| `styleTags` | enum[] (1-4) | Aesthetic direction (`minimal`, `dense-data`, `editorial`, `brutalist`, ...) |
| `components` | enum[] (0-10) | Visible UI building blocks (`sidebar-nav`, `bottom-nav`, `action-list`, `kpi-card`, `donut-chart`, `data-table`, ...) |
| `domainTags` | enum[] (0-4) | Business/product context (`billing`, `security`, `integrations`, ...) — 15 values |
| `platform` | enum | `web` \| `mobile` \| `tablet` — auto-detected from screenshot dimensions |
| `colorScheme` | enum | `light` \| `dark` — page-level theme |
| `industryVertical` | string | Industry inference (`fintech`, `devtools`, `healthcare`, ...) |
| `responsiveBehavior` | enum | `responsive` \| `fixed-width` \| `adaptive` |

### Visual attributes

| Field | Type | Purpose |
|---|---|---|
| `visual.dominantColors` | hex[] (1-6) | Deterministically extracted via node-vibrant |
| `visual.accentColor` | hex? | Primary interactive/brand color |
| `visual.colorRoles` | object? | `{ canvas, surface, ink, muted, accent }` — paste-ready CSS tokens |
| `visual.typePairing` | object | `{ display, body, notes }` — font names + hierarchy reasoning |
| `visual.spacingDensity` | enum | `compact` \| `moderate` \| `spacious` |
| `visual.cornerStyle` | enum | `sharp` \| `slight-round` \| `pill` \| `mixed` |
| `visual.usesShadows` | boolean | Depth via shadow? |
| `visual.usesBorders` | boolean | Structure via borders? |

### Editorial fields (the actual IP)

| Field | Type | Purpose |
|---|---|---|
| `critique` | string (min 80) | Why this is here. DECISION + EFFECT + REJECTION structure. |
| `whatToSteal` | string[] (min 1) | Concrete, copyable techniques with reasoning + when-NOT-to-use |
| `antiPatterns` | object | `{ antiPatterns[], whereThisFails[], accessibilityRisks[], legacyAccessibilityNotes[] }`; a11y risks are structured `{ element, risk, evidence, confidence, wcag: string[] }` with required canonical WCAG 2.2 IDs; legacy uncited notes are retained but excluded from search |
| `mood` | string? | Emotional register ("playful", "clinical", "authoritative") |
| `voice` | object? | `{ tone, examples[], avoid[] }` — microcopy analysis |
| `layout` | object? | Machine-readable wireframe: `{ form, regions: [{role, width}] }` |
| `businessRationale` | object? | `{ businessGoal, targetUser, rationale, confirmed }` — product-intent inference |

### Quality & workflow

| Field | Type | Purpose |
|---|---|---|
| `qualityTier` | enum | `exceptional` (default) or `cautionary` |
| `qualityScore` | number (1-5) | Curator rating, for ranking |
| `reviewStatus` | enum | `approved` (default) or `draft` — drafts hidden from MCP search |
| `provenance` | object? | `{ taggedBy, reviewedBy?, capture? }` — who/what produced the fields |
| `source.lastVerified` | date? | Staleness tracking |

### Draft hygiene

Entries containing `[DRAFT]`, `[PLACEHOLDER]`, or `[TODO]` markers in any text
field are rejected at validation. The centralized `findDraftMarkers()` +
`findVagueAntiPatterns()` gates run in three write-time paths (the ui-server
save endpoint, the commit-draft script, and the add-entry CLI) and the
validate-corpus CI backstop. Bulk-import writes pre-review drafts that are
gated at commit time by design — drafts may carry `[DRAFT]` markers until a
curator promotes them. One rule, enforced at every path to the committed corpus.

---

## Curator dashboard

```bash
npm run ui    # → http://localhost:3131
```

### Views

- **Library** — browse entries as gallery cards or a list. Visual attributes,
  color tokens, layout wireframe, voice, and mood in the detail rail.
- **Add entry** — capture from URL (Playwright) or upload, Auto-fill (two-pass
  vision AI), review, save. Real-time validation.
- **Bulk import** — drop files or `.zip` archives, auto-fill all with deferred
  critique, review queue, commit ready entries. In-batch dedup catches
  duplicates before they reach the corpus.
- **Coverage** — category/style/component/domain distribution, orphaned-image
  cleanup.

### Dashboard features

- **Multi-select** — checkbox selection across pages + "Select all matching"
  (filter-driven bulk selection across the entire corpus)
- **Bulk tier actions** — promote/reject selected entries to exceptional/cautionary
- **Bulk re-tag** — re-run the full tagger (vision + critique) on selected
  entries with a per-run provider picker, live progress indicator
- **Zip import** — drop `.zip` files; recursive extraction of nested zips
- **DOM-signal-aware** — entries tagged from batch captures carry computed
  font/contrast/a11y ground truth
- **Durability surface** — snapshot count and recovery info on the stats page
- **SSRF guard** — URL capture rejects private/loopback/cloud-metadata addresses

---

## Two-pass auto-fill tagger

The tagger uses a **two-pass architecture** for maximum quality. The two passes
are separate API calls and can run on different providers.

### Pass 1: Extraction (vision + facts)
- **Colors:** deterministic pixel quantization via `node-vibrant` — the model
  never guesses hex values.
- **DOM signals:** when available from batch capture, computed `fontFamily`,
  `contrastRatio`, `accessibility` signals, and `structure` are injected as
  VERIFIED GROUND TRUTH (same pattern as quantized colors). Body font is
  overridden post-hoc from the DOM's `fontFamily`.
- **Structure:** patternType, categories, styleTags, components, domainTags,
  colorScheme, industryVertical, responsiveBehavior, spacing, corners,
  shadows/borders, colorRoles, layout regions, platform (auto-detected).
- **Platform scoping:** portrait mobile strips desktop side rails and their
  layout regions; web strips mobile bottom navigation; tablet stays unfiltered
  because its layout is ambiguous.
- **Categorization calibration:** prompt nudges the model toward
  commonly-missed patterns (chat-interface, pricing, command-palette,
  calculator).
- **Pattern discovery lane:** when a screen does not fit the closed enum, the
  extraction pass can persist `patternDiscovery.suggestedPatternType` for later
  aggregation instead of silently falling back to `dashboard`.

### Pass 2: Critique (reasoning + writing)
- **Text-only** (no image) — reasons from Pass 1's platform-normalized facts +
  DOM a11y ground truth. Raw model extraction is retained only as audit data.
- **Observation-first:** must list 5 specific design decisions (with examples
  of good vs generic observations) before critiquing.
- **DECISION + EFFECT + REJECTION:** every claim names the specific choice, the
  behavioral/user-experience outcome, and what conventional default it rejects.
- **User specificity:** must name the affected user type ("returning users"
  not just "users").
- **Accessibility evidence gate:** new a11y risks must name the element, risk,
  confidence, WCAG criterion, and concrete visible/DOM evidence. Unsupported or
  palette-only risks are dropped instead of preserved as speculative critique.
- **Palette stripping:** deterministic colors stay in extraction; the critique
  pass does not receive the full palette, which prevents hex values from being
  promoted into fake components or status chips.
- **Banned-phrase enforcement:** generic phrases are listed in the prompt AND
  enforced as a post-hoc code-level gate with one retry.
- **Mood extraction:** emotional register read from colors/type/copy/whitespace.

### Quality bar

```
Bad:  "Uses a clean layout with good spacing."
Good: "Hairline borders at low contrast do structural work without the visual
       weight of 1px black lines; the eye reads grouping without noticing the
       borders. Rejects the common default of visible frame borders."
```

### Reliability

- **Transient retry:** 502/503/504 responses retry with exponential backoff.
- **429 handling:** per-provider retry hints (Gemini's `retryDelay`, OpenAI/
  Anthropic's `Retry-After` header, NIM fallback wait).
- **Adaptive detail:** low-detail extraction re-runs at high if the result is
  weak (blank patternType, no categories, "Untitled" name).
- **Deferred-critique mode:** run extraction now, defer critique to on-demand;
  it applies the staged entry's platform before building the text-only prompt.

---

## Multi-provider support

Supported provider modes, each with independent model overrides:

| Provider | Vision? | Key env var | Default model |
|---|---|---|---|
| OpenAI | ✅ | `OPENAI_API_KEY` | `gpt-5.4-nano` |
| Anthropic Claude | ✅ | `ANTHROPIC_API_KEY` | `claude-sonnet-4-5` |
| Google Gemini | ✅ | `GEMINI_API_KEY` | `gemini-3.5-flash` |
| Mistral Large | ❌ (text-only) | `MISTRAL_API_KEY` | `mistral-large-latest` |
| MiniMax M3 | ✅ | `MINIMAX_API_KEY` | `MiniMax-M3` |
| OpenAI-compatible critique (DeepSeek) | ❌ (text-only) | `OPENAI_API_KEY_CRITIQUE` | `deepseek-v4-pro` |

### Split-provider mode (recommended)

```bash
# Gemini Flash for extraction (fast vision), Claude Sonnet for critique (deep writing)
AUTO_TAG_PROVIDER_EXTRACTION=gemini
AUTO_TAG_PROVIDER_CRITIQUE=claude

# Or: OpenAI for extraction, DeepSeek V4 Pro for critique (cheaper)
AUTO_TAG_PROVIDER_EXTRACTION=openai
AUTO_TAG_PROVIDER_CRITIQUE=openai
OPENAI_BASE_URL_CRITIQUE=https://api.deepseek.com
OPENAI_API_KEY_CRITIQUE=sk-...
OPENAI_AUTO_TAG_MODEL_CRITIQUE=deepseek-v4-pro
```

Mistral and DeepSeek are text-only — they're automatically blocked from the
extraction pass with a console warning + fallback to a vision provider. The
`hasVisionKey()` / `hasCritiqueKey()` capability gates enforce the right check
at each endpoint.

When DeepSeek is configured as the critique provider, peak-hour routing can
automatically send critique to MiniMax, or Claude as a fallback, unless an
explicit provider override is supplied.

---

## DOM signals extraction

Batch captures extract DOM-level ground truth alongside each screenshot:

- **Computed styles:** `fontFamily`, `fontSize`, `fontWeight`, `borderRadius`,
  `boxShadow`, `color`, `background`
- **Accessibility:** `contrastRatio` (computed from real fg/bg luminance),
  `headingLevels`, `imagesMissingAlt`, `unlabeledInteractive`, `hasSkipLink`
- **Structure:** `display`, `flexDirection`, `gridTemplateColumns`, `gap`
- **Copy:** on-screen text (headings, buttons, links) — capped at 20 items × 200 chars

Written to a `dom-signals.json` sidecar (id-keyed, always written even if empty).
The tagger lazy-loads this and injects it as VERIFIED GROUND TRUTH into both
passes — extraction gets computed styles/structure, critique gets the a11y
signals (contrastRatio, unlabeledInteractive, imagesMissingAlt).

The copy array is **never** injected into the prompt (prompt-injection safety).

---

## Bulk re-tag

Re-run the full tagger (extraction + critique) on saved entries to fix
miscategorization, populate new schema fields, and refresh critiques:

1. **Library** → filter (e.g. search "wealthsimple" or filter to `cautionary`)
2. **"Select all matching"** — selects across all pages, honoring active filters
3. **Bulk bar** → pick a provider from the dropdown
4. **Re-tag** — confirm → live progress indicator → entries re-tagged

The re-tag endpoint (`/api/auto-retag`) re-runs `tagImage` with the chosen
provider, overwriting content fields while preserving identity (id, source,
image, platform, addedAt, provenance). Draft markers are stripped before
validation so fresh retags land clean.

Provider is overridable per call (no env mutation races). DOM signals are
read from the sidecar when the image is from a batch capture.

---

## Dedup

Three layers of duplicate detection:

| Layer | Method | Where | Catches |
|---|---|---|---|
| **Upload-time** | SHA-256 exact + dHash near-dup (Hamming <8) | `/api/check-duplicate` | Re-uploads before staging |
| **In-batch** | Same SHA-256/dHash across siblings in one bulk run | `enqueueFiles` | Same-image siblings in one batch |
| **Commit-time** | `findDuplicateAtCommit` — SHA-256 + dHash against corpus + already-committed siblings | `POST /entries` + `commit-draft.ts` | Stale upload-time check, prior-batch dupes |

**Dedup cleanup tool:** `npm run dedup-cleanup` finds duplicate clusters in the
existing corpus, scores each entry by completeness (reviewStatus, draft markers,
provenance, critique length, quality), keeps the winner, removes losers.
Dry-run by default; `--confirm` to apply. `--threshold N` to widen the
near-dup window. `--json` for machine-readable output.

```bash
npm run dedup-cleanup -- --dry-run        # report only (default)
npm run dedup-cleanup -- --confirm         # apply: remove losers + orphaned images
npm run dedup-cleanup -- --threshold 15    # wider near-dup window
```

The dedup module (`src/dedup.ts`) is extracted from the UI server so CLI
scripts can reuse it without importing the HTTP server.

---

## MCP tools (14)

All tools are read-only over the corpus, organized into three tiers:
**retrieval**, **synthesis**, and **aggregation**.

### Retrieval

| Tool | Purpose |
|---|---|
| `search_ui_examples(query?, category?, styleTag?, qualityTier?, minQuality?, reviewStatus?, platform?, limit?)` | Primary entry point. Free-text + structural filters. Vector search when index exists, keyword fallback. |
| `get_ui_example(id)` | Full detail for one entry: critique, steals, anti-patterns, a11y risks, voice, mood, color roles, layout, components, domain tags, provenance, and image. |
| `get_similar_ui_examples(id, limit?)` | Ranks by vector cosine similarity. Embeddings weighted by design characteristics (pattern, style, components, colors), not product identity. |
| `compare_ui_examples(ids)` | 2-3 id comparison table: pattern, style, platform, layout, accent, density, quality tier, critique angle, top steal, anti-patterns, a11y risks. Placeholder titles auto-cleaned. |
| `list_categories()` / `list_style_tags()` / `list_domain_tags()` | Discover valid filter values. |
| `browse_ui_examples(styleTag?)` | Discovery: what's in the corpus grouped by patternType. |

### Synthesis

| Tool | Purpose |
|---|---|
| `recommend_ui_direction(productContext, count?, category?, qualityTier?, platform?, framework?)` | "Design advisor." Embeds your description, finds relevant entries with product diversity, synthesizes a direction. Deterministic — no LLM call. |
| `generate_design_prompt(ids, framework?, context?)` | Synthesize a design brief across 2-5 specific ids. Paste-ready color tokens, typography, layout, voice, techniques, anti-patterns. `framework:"tokens"` for JSON. |

### Aggregation

| Tool | Purpose |
|---|---|
| `get_anti_patterns(patternType?, category?, limit?)` | Consensus "what NOT to do" across matching entries, ranked by frequency. |
| `get_color_palette(patternType?, styleTag?, limit?)` | Paste-ready color token sets grouped by accent hue band. |
| `get_stealable_techniques(patternType?, styleTag?, limit?)` | Copyable techniques across a category, deduped by theme. |

### Screenshot critique

| Tool | Purpose |
|---|---|
| `critique_ui(image_data, image_mime_type, product_context?, platform?)` | Upload a UI screenshot (bounded base64, max 10 MiB) and receive a grounded critique with cited recommendations. Extracts structured facts via the vision tagger, retrieves similar approved corpus examples, and synthesizes an observation-grounded critique. Falls back to structured-only retrieval when image embeddings are unavailable. Image bytes are never logged. |

All tools exclude drafts by default.

---

## Decision Lab

The Decision Lab is a comparative UI analysis tool accessible from the curator
dashboard (`/#/decision-lab`). It takes 2-3 screenshots of your product, tags
them via the two-pass vision tagger, retrieves structurally similar corpus
examples, and synthesizes a cited comparative brief — grounded in corpus
evidence, not free-form LLM opinion.

### How it works

Three layers mirror the tagger's architecture:

1. **Evidence assembly** (pure) — flattens tagger extractions + corpus
   retrievals into a cited evidence bundle with stable IDs.
2. **Comparative synthesis** (LLM call) — a constrained comparative rubric fed
   ONLY the assembled evidence.
3. **Citation gate** (post-hoc runtime gate) — drops rubric scores and
   observations that don't cite assembled evidence, with one retry.

Decisions are stored in a separate `corpus/decisions.json` sidecar, independent
from the curated corpus. The UI renders the brief as formatted markdown with
three views: setup (add screens + context), builder (edit the analysis), and
report (rendered brief with cited evidence).

### Running it

```bash
npm run ui                # start the dashboard
# navigate to http://localhost:3131/#/decision-lab
```

---

## Skill — `clean-ui-design`

The repo ships a companion skill (`skill/clean-ui-design/`) that orchestrates
the MCP tools into an agent workflow: search → read → compare → synthesize, with
a strict quality bar against generic AI output.

```bash
cp -r skill/clean-ui-design ~/.zcode/skills/
```

The skill enforces the same anti-slop guardrails the tagger does: banned
phrases, DECISION + EFFECT + REJECTION structure, anti-patterns as first-class.

---

## Adding entries

### Via the curator app (recommended)

`npm run ui` → Add entry → upload/capture → Auto-fill → review → Save.

### Via the terminal

```bash
# Single screenshot
npm run capture -- --url "https://linear.app" --slug "linear-landing-2026"
npm run add-entry -- --image corpus/images-private/linear-landing-2026.png \
  --product "Linear" --url "https://linear.app"
npm run validate-corpus
npm run build-index
```

### Manual

Add a JSON object to `corpus/entries.json` following the shape in
`src/schema.ts`. Run `npm run validate-corpus` before committing.

**Read `docs/SOURCING.md` first** — it covers the image-visibility tiers and
legal/sourcing rules.

---

## Batch capture pipeline

```bash
npm run capture-batch -- sources.json
```

Reads a `sources.json` describing sites, walks each page detecting
landmarks/sections/repeated-groups, captures screenshots at desktop + mobile
viewports, deduplicates via perceptual hash (aHash), and writes a batch folder
under `corpus/images-private/captures/{batchId}/`:

```
{captureId}.png        one per detected section
manifest.json          CaptureMeta[] (with hasDomSignals flag)
triage.json            { [captureId]: "pending" } for the review UI
dom-signals.json       { [captureId]: DomSignals } page-derived ground truth
```

**DOM signals:** computed styles, accessibility metrics, structure, and copy
extracted via `locator.evaluate()` while the element handle is alive. 3s
timeout (Promise.race), best-effort (failures return null, never block
capture). Copy is capped at 20 items × 200 chars.

**Error isolation:** one bad URL (DNS failure, timeout) doesn't abort the
batch — failures log an error and produce 0 candidates, the batch continues.

**Robots.txt:** checked before navigation — disallowed URLs are skipped.

---

## Bulk import workflow

```bash
# Terminal flow
npm run bulk-import -- --folder corpus/images-private/batch-01
npm run review-draft      # interactive approval
npm run commit-draft      # writes approved entries (with dedup gate)
```

Or via the dashboard: Bulk import tab → drop files or `.zip` → Auto-fill all
(extraction-only + deferred critique) → Generate critique → Commit ready.

**Zip support:** `.zip` files are extracted client-side (fflate), including
nested zips. `__MACOSX/` metadata and dotfiles are filtered.

**Dedup:** every file checked against the corpus + batch siblings before
staging, and again at commit time.

---

## Corpus trust & recovery

- **Atomic writes** — temp file + rename; crash mid-write can't corrupt.
- **Rolling snapshots** — last 20 timestamped copies in `corpus/.snapshots/`
  (gitignored). Auto-recovery if primary goes missing/corrupt.
- **`npm run restore-corpus`** — `--list`, `--dry-run`, `--latest`,
  `--snapshot <name>`. A restore snapshots the current state first.
- **Entry-count drift floor** — set `expectedMinEntries` in
  `corpus/.corpus-config.json`; `validate-corpus` and `doctor` warn if below.
- **Index drift detection** — `indexStatus()` reports missing, orphaned, and
  content-stale vectors. `npm run build-index` incrementally repairs changed or
  missing entries and removes orphaned vectors; use `-- --force` only after
  changing the embedding document format.

```bash
npm run doctor                       # full health check
npm run restore-corpus -- --list     # see available snapshots
npm run restore-corpus -- --latest   # restore the newest
npm run clean-orphans -- --dry-run   # find unreferenced images
npm run build-index                  # repair semantic-search index drift
```

---

## Analytics

- **`npm run corpus-stats`** — distribution by pattern/category/style/component,
  coverage gaps, source staleness, quality metrics, provenance split, business
  rationale coverage, and image availability (path resolves on disk, not just
  string set).
- **`npm run query-stats`** — retrieval analytics over `corpus/query-log.jsonl`:
  dead result ids, demand-vs-supply gaps, most-used filters.

---

## Migrations

```bash
npm run migrate              # v1 → v2: patternType + antiPatterns
npm run migrate-layout       # layout field for dashboards
npm run migrate-untitled     # product name canonicalization
npm run migrate-platform     # platform from screenshot dimensions
npm run migrate-wcag-ids     # accessibility risks → canonical WCAG 2.2 IDs
```

All idempotent — safe to re-run.

### `migrate-wcag-ids` — canonical WCAG citations

Migrates accessibility risks to require canonical WCAG 2.2 success-criterion IDs
(`wcag: ["1.4.3"]`). Three transformations:

1. **Normalize** — title-bearing citations (`"1.4.3 Contrast (Minimum)"`) are
   parsed to bare IDs (`["1.4.3"]`), validated against the vendored WCAG 2.2
   registry, and deduplicated.
2. **Delete** — uncited structured objects that are self-described non-risks
   (their own evidence confirms no risk) are removed, not assigned a citation.
3. **Quarantine** — legacy free-text strings move to
   `antiPatterns.legacyAccessibilityNotes`, a retained human-review backlog that
   is excluded from MCP retrieval and semantic embeddings.

The WCAG 2.2 registry is vendored at `src/wcag/wcag-2.2.ts` (pinned from the W3C
machine-readable export). Titles are never persisted on risks — they are looked
up at display time via `formatAccessibilityRisk`, so a registry refresh can fix a
title without a corpus edit. Note: 4.1.1 Parsing was removed in WCAG 2.2 and is
not citable.

Referential integrity only: a valid citation proves the referenced criterion
*exists* in WCAG 2.2, not that a screenshot violates it. The evidence, contrast,
and pixel-measurement gates remain the authority on whether a risk is real.

---

## Project structure

```
clean-ui-mcp/
├── corpus/
│   ├── entries.json            # the corpus (schema v2)
│   ├── seed.json               # minimal shipped sample
│   ├── embeddings.json         # Voyage AI vectors (gitignored)
│   ├── query-log.jsonl         # MCP query log for analytics
│   ├── .snapshots/             # rolling backups (gitignored)
│   ├── .dhash-cache.json       # dedup fingerprint cache (gitignored)
│   ├── images-private/         # gitignored — local research images
│   │   └── captures/           # batch capture output
│   └── images-public/          # committed — redistribution-cleared thumbnails
├── src/
│   ├── schema.ts               # Zod schema (the data model)
│   ├── corpus.ts               # load / search / similar / compare
│   ├── server.ts               # MCP server: 14 tools
│   ├── design-prompt.ts        # generate_design_prompt synthesis
│   ├── recommend.ts            # recommend_ui_direction synthesis
│   ├── aggregations.ts         # anti-patterns / palettes / techniques / browse
│   ├── embeddings.ts           # Voyage AI client + cosine + index I/O
│   ├── persistence.ts          # atomic writes + snapshots
│   ├── dedup.ts                # dHash + SHA-256 + findDuplicateAtCommit
│   ├── env.ts                  # .env loading + provider config
│   ├── tagger.ts               # two-pass vision tagger (6 providers)
│   ├── decision-lab.ts         # comparative UI analysis engine (evidence + citation gate)
│   ├── decisions.ts            # Decision Lab persistence (decisions.json sidecar)
│   ├── ssrf.ts                 # SSRF guard
│   ├── paths.ts                # corpus-path validation
│   ├── wcag/                   # vendored WCAG 2.2 registry + helpers
│   │   ├── wcag-2.2.ts         # pinned W3C snapshot (86 active criteria)
│   │   └── registry.ts         # isWcagCriterion, getWcagTitle, ID parsing
│   ├── content-lint.ts          # vague-phrase hard gate + word-count warning
│   └── scripts/
│       ├── ui-server.ts        # curator dashboard server
│       ├── capture.ts          # Playwright capture (single + batch)
│       ├── dedup-cleanup.ts    # find + remove corpus duplicates
│       ├── validate-corpus.ts  # standalone validator
│       ├── build-index.ts      # embed all entries
│       ├── add-entry.ts        # interactive terminal wizard
│       ├── bulk-import.ts      # batch ingest
│       ├── review-draft.ts     # interactive draft reviewer
│       ├── commit-draft.ts     # commit drafts (with dedup gate)
│       ├── corpus-stats.ts     # distribution + coverage report
│       ├── pattern-discovery.ts # aggregate suggested pattern gaps
│       ├── query-stats.ts      # retrieval analytics
│       ├── doctor.ts           # health check
│       ├── restore-corpus.ts   # snapshot recovery
│       ├── clean-orphans.ts    # delete unreferenced images
│       └── migrate-*.ts        # schema migrations
├── ui/
│   ├── app.js                  # SPA dashboard frontend
│   ├── classic-app.js          # classic workbench (bulk import + triage)
│   └── styles.css              # dashboard styles
├── index-2.html                # dashboard HTML shell
├── skill/clean-ui-design/      # companion agent skill
├── sources-cautionary.json     # cautionary-tier capture targets
├── docs/SOURCING.md            # legal/sourcing rules
├── mcp-config.example.json     # MCP client config example
└── .github/workflows/ci.yml    # CI: build + validate + test
```

---

## Reference integrity and machine rules

The skill's reference Markdown files (`skill/clean-ui-design/references/*.md`) are
editorial guidance for the critique synthesis prompt. They are validated against a
checked-in manifest with SHA-256 hashes and version numbers.

### Authored vs generated files

| File | Type | Description |
|------|------|-------------|
| `skill/clean-ui-design/references/manifest.json` | Authored | Declares each reference file with hash, license, version |
| `skill/clean-ui-design/references/machine-rules.json` | Authored | Canonical source for all enforcement patterns (regexes, phrase lists) |
| `src/references/generated.ts` | Generated | Compiled from `machine-rules.json` — never hand-edit |
| `src/references/loader.ts` | Authored | Validates manifest integrity at load time |

### Build generation

`npm run build` runs `generate-references` before `tsc`, regenerating `generated.ts`
from `machine-rules.json`. If the generated file drifts (someone edits the JSON
without regenerating), `npm run validate-references` catches it via the `--check` flag.

### Version-bump policy

When a reference file's content changes, its SHA-256 hash changes, which requires
incrementing the `version` field in `manifest.json`. The loader's version-policy
validation enforces this: changed hash without version bump → validation failure.

### MCP structured output

The `critique_ui` tool returns both a legacy Markdown text (`content[0].text`) and
a `structuredContent` object matching the `StructuredCritique` schema (version 1.0).
Consumers that read only `content[0].text` get the full critique; structured
consumers get typed findings with evidence IDs, claim bases, and provenance.

### Critique-quality scoring

`npm run test:critique-quality` is the offline deterministic gate — it runs the
scorer and the eval-scorer tests against the gold labels with no network or
provider keys required. For live provider baselines across the eval matrix, use
`npm run eval-matrix -- --configs eval/configs/<lane>.json` (requires provider
keys + `RUN_LIVE_INTEGRATION=1`).

---

## npm scripts reference

| Script | What it does |
|---|---|
| `npm run build` | TypeScript → `dist/` |
| `npm start` | Start the MCP server (stdio) |
| `npm run ui` | Build + start curator dashboard at `http://localhost:3131` |
| `npm test` | All tests (vitest unit + Playwright browser) |
| `npm run validate-corpus` | Validate entries.json against schema + hygiene |
| `npm run build-index` | Incrementally embed missing/changed entries and remove orphaned Voyage vectors |
| `npm run capture` | Single screenshot via Playwright |
| `npm run capture-batch` | Crawl a website, capture many sections + DOM signals |
| `npm run add-entry` | Interactive entry wizard |
| `npm run tag-image` | Run the vision tagger on one image |
| `npm run pattern-discovery` | Summarize persisted suggested pattern types before adding new enum values |
| `npm run bulk-import` | Batch ingest from a folder |
| `npm run review-draft` | Review bulk-import drafts |
| `npm run commit-draft` | Commit approved drafts (dedup-gated) |
| `npm run dedup-cleanup` | Find + remove corpus duplicates |
| `npm run corpus-stats` | Distribution, coverage, quality metrics |
| `npm run query-stats` | Retrieval analytics |
| `npm run doctor` | Full health check |
| `npm run restore-corpus` | Snapshot recovery |
| `npm run clean-orphans` | Delete unreferenced images |
| `npm run migrate` | Schema migrations (all idempotent) |
| `npm run migrate-wcag-ids` | Accessibility risks → canonical WCAG 2.2 IDs |
| `npm run eval-baseline` | Tagger eval: score raw output against gold labels, write/diff baseline |
| `npm run eval-matrix` | Provider/model matrix: loop over config triples, emit per-config baselines + comparison table |
| `npm run build-image-index` | Embed approved corpus images into the image-embedding index (requires image-embedding provider configured) |
| `npm run benchmark-image-embeddings` | Benchmark the configured image-embedding provider against the critique fixtures |

---

## Testing

533 tests across 39 files: vitest unit tests (schema, corpus, tagger, tagger
contract, WCAG registry, embeddings, dedup, design-prompt, recommend,
aggregations, decision lab, eval scorer, critique-ui, image-embeddings,
image-index, critique-retrieval, critique-synthesis, dom-motion, md3-classifier,
synthesis context/contracts/render, wiring verification) + Playwright browser
tests (dashboard flows, bulk import, capture, candidate review, DOM motion).

```bash
npm test                 # all tests
npx vitest run           # unit tests only
```

CI runs on every PR: `npm ci` → Playwright install → `build` → `validate-corpus` → `test`.

---

## Tagger evaluation loop

The tagger is a two-pass vision pipeline whose prompt and provider config change
over time. The eval loop provides a **scored, repeatable baseline** so every
prompt or provider change can be diffed against a recorded result — instead of
eyeballing outputs and guessing whether they got better.

### Why it scores raw output, not sanitized output

Scoring sanitized output against the sanitizer's own rules is a tautology — the
pass rate is 100% by construction. The eval scores **raw pre-sanitize model
output** (`_raw.extraction`, `_raw.critique`) for the things the gates catch:
patternType misclassification, icon-only hallucinations, pixel measurements,
banned phrases. A prompt change that reduces these counts is a real improvement.

### The 15-image stratified set

`scripts/eval-set.mjs` defines a fixed set covering 8 patterns (dashboard,
pricing, calculator, auth, landing-page, data-table, command-palette, mobile),
each with a hand-verified gold `patternType` label. The set is stratified so a
single-pattern regression (e.g. calculator detection breaking) is detectable.

### Running the eval

```bash
npm run eval-baseline                                  # full run, writes eval/baseline.json
npm run eval-baseline -- --extraction-only             # skip critique (faster)
npm run eval-baseline -- --images 5                    # limit to first 5 images
npm run eval-baseline -- --diff eval/baseline.json     # re-run, compare to saved baseline
```

Requires a vision provider key. The output records per-image scores
(patternType correctness, raw hallucination counts, latency) plus a summary
(accuracy %, average banned-phrase count, average latency). The `--diff` mode
flags regressions: any metric that moved in the wrong direction.

**Determinism:** every baseline run pins explicit `{provider, baseUrl,
apiKey, model}` overrides resolved from env at startup. This bypasses
peak-hour routing (the production DeepSeek→MiniMax auto-swap) so `--diff`
comparisons are stable across wall-clock time. Production tagging keeps
peak-hour routing unchanged — the bypass is eval-only.

### Provider/model matrix

```bash
npm run eval-matrix -- --configs eval/configs/openai-gpt54.json,eval/configs/deepseek-nim.json
```

Runs the same 15-image eval against each config triple, writes one
`eval/baseline-{name}.json` per config, and prints a comparison table
with accuracy, hallucination counts, latency, and errors side by side.
Config files live in `eval/configs/` — see `openai-gpt54.json`,
`deepseek-nim.json`, and `claude.json` for examples.

**Two comparison classes:**

- **Fully-pinned lanes** (`modelPinned: true`) — OpenAI-compatible endpoints
  where the full `{provider, baseUrl, apiKey, model}` triple is pinned per
  run. Reproducible across machines and wall-clock time. This is what answers
  the DeepSeek V4 Pro vs GPT-5.4 question.
- **Provider-only lanes** (`modelPinned: false`) — provider is pinned but
  model resolves from env (`CLAUDE_AUTO_TAG_MODEL`, `GEMINI_AUTO_TAG_MODEL`).
  Reproducible only if you also pin the model env var. Extending the override
  path to these providers is a follow-up.

If a config's API key is missing, that config is skipped with a clear message
(not silently rerouted — that would defeat the pinning). The matrix uses the
same scorer (`scoreExtraction`/`scoreCritique`) as `eval-baseline` — no
parallel truth model.

### What a regression looks like

- **patternType accuracy drops** — a prompt change broke detection for a pattern
- **avg banned phrases rises** — the model is emitting more generic filler pre-gate
- **avg icon-only count rises** — more hallucinated "no visible labels" claims
- **avg critique words drops** — critiques became shorter/more generic

### Deferred

Gold labels for components/domainTags/colorRoles, Promptfoo harness (revisit
after CLI matrix settles the provider/model decision), ScreenSpot IoU,
token-usage capture.

---

## Why JSON instead of a database

At ~1,000 entries (and realistically up to a few thousand), a single JSON file
is easier to diff, review in PRs, and hand-edit than a database, with zero
native dependencies. `src/corpus.ts` is the only file that knows how entries
are stored — swap it for SQLite/Postgres later without touching `server.ts`.

---

## Status

Active development with a growing retag-readiness pipeline. See the
[roadmap](ROADMAP.md), and run `npm run corpus-stats` for current corpus totals.
Contributions welcome: new entries, new patterns, new providers, better
critiques.
