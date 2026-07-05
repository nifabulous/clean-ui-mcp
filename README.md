# clean-ui-mcp

An MCP server exposing a curated corpus of exceptional UI examples — not a
component library, a **taste** library. Each entry pairs a real-world UI
screenshot with a written critique (what makes it work, what to steal, what to
avoid), structured visual attributes (color roles, type pairing, spacing),
a machine-readable layout wireframe, an optional voice/microcopy analysis,
and a quality tier.

The point isn't to hand an AI components to assemble — there are good tools for
that already (shadcn, Figma MCP, magic-mcp). The point is to give it *specific,
real, well-explained examples* to ground "make it clean" requests in something
other than the statistical average of training data (the "AI slop" failure mode).

> **Live corpus:** 1,019 entries across 90 products, 20 UI patterns, 45
> cautionary examples, 1,153 anti-pattern statements, and 3,600 stealable
> techniques. Counts drift as the corpus grows — re-derive any time with
> `npm run corpus-stats`.

---

## Table of contents

- [What makes this different](#what-makes-this-different)
- [Quick start](#quick-start)
- [Connect to an MCP client](#connect-to-an-mcp-client)
- [Configuration (.env)](#configuration-env)
- [The corpus schema (v2)](#the-corpus-schema-v2)
- [Curator dashboard](#curator-dashboard)
- [Two-pass auto-fill tagger](#two-pass-auto-fill-tagger)
- [Multi-provider support](#multi-provider-support)
- [Dedup at bulk import](#dedup-at-bulk-import)
- [MCP tools (12)](#mcp-tools-12)
- [Skill — agent workflow](#skill--agent-workflow)
- [Adding entries](#adding-entries)
- [Bulk import workflow](#bulk-import-workflow)
- [Corpus trust & recovery](#corpus-trust--recovery)
- [Analytics](#analytics)
- [Migrations](#migrations)
- [Project structure](#project-structure)
- [npm scripts reference](#npm-scripts-reference)
- [Testing](#testing)
- [Why JSON instead of a database](#why-json-instead-of-a-database)
- [Status](#status)

---

## What makes this different

Screenshot libraries have scale (Mobbin: 621k screenshots). They have zero of
five things this corpus leads with:

1. **Anti-patterns** *(required)* — structured "what common mistake does this
   design avoid." The single biggest differentiator. No screenshot library has
   an editorial stance; this one does.
2. **Cautionary entries** — genuinely bad examples with a critique of *why* they
   fail, flagged via `qualityTier: "cautionary"` (43 in the corpus today). Mobbin
   can't do this at all.
3. **Layout wireframes** — `{ form, regions: [{role, width}] }` per entry, so
   an agent can consume page *structure* programmatically, not just read prose
   (84% coverage).
4. **Color role tokens** — `colorRoles: {canvas, surface, ink, muted, accent}`,
   a paste-ready CSS `:root` token set, not a bare hex list (75% coverage).
5. **Voice/microcopy** — `voice: {tone, examples, avoid}` captures the writing
   voice, not just the visual design (95% coverage). "Good afternoon, Sam" vs
   "Dashboard" is a design decision.

Plus a **two-pass vision tagger** that extracts facts (deterministic color
quantization via node-vibrant) and writes critiques (observation-grounded
reasoning with banned-phrase enforcement) — across three providers, with an
optional split-provider mode for best quality per cost.

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

**Minimum to run the MCP server:** nothing. With no keys at all, the server
starts, falls back to the shipped `corpus/seed.json`, and serves keyword search
over it. Add a vision key only when you want Auto-fill. Add a Voyage key only
when you want semantic vector search.

**Recommended for the full experience:**
- One vision provider key (OpenAI, Anthropic, or Google) for Auto-fill.
- A Voyage API key for semantic vector search (free tier sufficient).

---

## Connect to an MCP client

After `npm run build`, point any MCP-compatible client at the server. Copy
`mcp-config.example.json` and adjust the path:

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
MCP client you use. The server speaks stdio and exposes the 12 tools listed
under [MCP tools](#mcp-tools-12).

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

# ─── Split-provider mode (recommended for best quality per cost) ────────────
# Use different providers for each pass of the two-pass tagger:
#   Extraction (Pass 1): vision + speed → Gemini Flash or OpenAI
#   Critique (Pass 2): reasoning + writing → Claude Sonnet (or DeepSeek on NIM)
# If unset, both fall back to AUTO_TAG_PROVIDER above.
#AUTO_TAG_PROVIDER_EXTRACTION=gemini
#AUTO_TAG_PROVIDER_CRITIQUE=claude

# ─── OpenAI-compatible endpoints (NIM, OpenRouter, Together, Groq, vLLM) ────
# Setting OPENAI_BASE_URL routes OpenAI calls to /v1/chat/completions instead
# of OpenAI's native /v1/responses. Per-pass overrides let extraction and
# critique hit different OpenAI-compatible endpoints. See "Multi-provider
# support" below for a full DeepSeek-on-NIM-for-critique example.
#OPENAI_BASE_URL=https://integrate.api.nvidia.com/v1
#OPENAI_BASE_URL_CRITIQUE=https://integrate.api.nvidia.com/v1
#OPENAI_API_KEY_CRITIQUE=nvapi-...
#OPENAI_AUTO_TAG_MODEL_CRITIQUE=deepseek-ai/deepseek-v4-pro

# ─── Optional tuning ────────────────────────────────────────────────────────
# Set to 1 to print per-call provider config + token usage to stderr.
#DEBUG_TAGGER=1
# Forces thinking OFF for both passes on OpenAI-compatible providers (NIM etc).
#OPENAI_THINKING_DISABLED=1

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
for the full Zod definition — it is the single source of truth and the comments
there explain the design intent behind every field.

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
| `layout` | object | Machine-readable wireframe: `{ form, regions: [{role, width}] }`. Populated when the layout itself is the teachable thing (84% coverage). |
| `voice` | object | `{ tone, examples: [], avoid: [] }`. Microcopy as a first-class dimension (95% coverage). |
| `visual.colorRoles` | object | `{ canvas, surface, ink, muted, accent }` — paste-ready CSS token set (75% coverage). |
| `platform` | enum | `web` \| `mobile` \| `tablet` — device class, orthogonal to patternType. Auto-detected from the screenshot aspect ratio at tag time. Lets the corpus answer "mobile onboarding" vs "web onboarding." |
| `reviewStatus` | enum | `approved` (default) \| `draft` — workflow state. Drafts are hidden from MCP retrieval by default; surface with `reviewStatus:"draft"` or `"any"`. |
| `provenance` | object | `{ taggedBy: "human" \| "auto" \| "auto-reviewed", reviewedBy? }` — who produced the fields and who reviewed them. The tagger marks `auto`; the UI flips to `auto-reviewed` on human edit; the CLI marks `human`. |
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

This is distinct from `reviewStatus`. The marker gate is about *content hygiene*
(text isn't finished); `reviewStatus` is about *workflow state* (text is real but
the entry isn't ready for retrieval). A draft passes the marker gate but stays
out of search results until approved.

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
  4. Save (validator gates in real time, including the draft-marker check)
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
- **Review-state toggle** — mark entries `draft` or `approved` from the form;
  draft chips appear in list + detail views
- **SSRF guard** — URL capture rejects private/loopback/cloud-metadata addresses
- **Loopback binding** — server binds to 127.0.0.1, not the LAN
- **Same-origin CORS** — the API is not exposed cross-origin
- **Recovery surface** — `/api/health` and snapshot count shown on the stats page

The frontend is split into `ui/app.js`, `ui/styles.css`, and a slim
`index-2.html` shell. Static assets are served through a path-traversal-guarded
`/static/*` route.

---

## Two-pass auto-fill tagger

The tagger uses a **two-pass architecture** for maximum quality. The two passes
are separate API calls and can run on different providers (see
[Multi-provider support](#multi-provider-support)).

### Pass 1: Extraction (vision + facts)
- **Colors:** deterministic pixel quantization via `node-vibrant` — the model
  never guesses hex values. It maps the extracted swatches to semantic roles.
- **Structure:** patternType, categories, styleTags, spacing, corners,
  shadows/borders, colorRoles, layout regions, platform (auto-detected from
  aspect ratio).
- **Image attached** at `detail: "high"` so the model can resolve in-card
  components, small text, and fine spacing.

### Pass 2: Critique (reasoning + writing)
- **Text-only** (no image) — the model reasons from Pass 1's validated facts.
- **Observation-first:** must list 5 specific, pointable visual elements before
  writing any critique. Grounds reasoning in what's actually on screen.
- **DECISION + EFFECT + REJECTION:** every claim must name the specific choice,
  why it works, and what conventional default it rejects.
- **Banned-phrase enforcement:** generic phrases ("clean layout", "modern
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

### Reliability

- **Transient retry:** 502/503/504 responses retry with exponential backoff
  across all providers.
- **Gemini thinking disabled** on extraction — it was burning output budget and
  truncating the JSON.
- **Deferred-critique mode:** run extraction now, defer critique to on-demand.
  Halves bulk-import cost when you're staging many images.

---

## Multi-provider support

The tagger works with three vision provider families, plus any OpenAI-compatible
endpoint. Set `AUTO_TAG_PROVIDER` and the matching key. Each provider has its
own model override:

| Provider | `AUTO_TAG_PROVIDER` | Key env var | Default model | Model override |
|---|---|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` | `gpt-5.4-nano` | `OPENAI_AUTO_TAG_MODEL` |
| Anthropic Claude | `claude` | `ANTHROPIC_API_KEY` | `claude-haiku-4-5` | `CLAUDE_AUTO_TAG_MODEL` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | `gemini-2.5-flash` | `GEMINI_AUTO_TAG_MODEL` |
| OpenAI-compatible (NIM, OpenRouter, Together, Groq, vLLM) | `openai` + `OPENAI_BASE_URL` | `OPENAI_API_KEY` | (provider-specific) | `OPENAI_AUTO_TAG_MODEL` |

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

### Split-provider with two OpenAI-compatible endpoints

The OpenAI adapter supports **per-pass overrides** for base URL, API key, and
model — so extraction and critique can hit different OpenAI-compatible
endpoints while both routing through the same adapter. The canonical use case:
real OpenAI for extraction (vision), NVIDIA NIM's DeepSeek V4 Pro for critique
(writing).

```bash
AUTO_TAG_PROVIDER_EXTRACTION=openai
AUTO_TAG_PROVIDER_CRITIQUE=openai

# Extraction: real OpenAI (vision via gpt-5.4-mini) → native /v1/responses
OPENAI_API_KEY=<your real openai key>
OPENAI_AUTO_TAG_MODEL=gpt-5.4-mini

# Critique: NVIDIA NIM DeepSeek V4 Pro → universal /v1/chat/completions
OPENAI_BASE_URL_CRITIQUE=https://integrate.api.nvidia.com/v1
OPENAI_API_KEY_CRITIQUE=nvapi-...
OPENAI_AUTO_TAG_MODEL_CRITIQUE=deepseek-ai/deepseek-v4-pro
```

When `OPENAI_BASE_URL` (or the per-pass variant) is set, the adapter routes to
the universal `/v1/chat/completions` endpoint instead of OpenAI's native
`/v1/responses` — the format every NIM/OpenRouter/Together/Groq/vLLM endpoint
speaks. Without a base URL, real OpenAI keeps the Responses API path (untouched
behavior for existing OpenAI users).

The `chat_template_kwargs.thinking` toggle is sent automatically: ON for the
critique pass (DeepSeek's strength is reasoning), OFF for extraction
(deterministic fields, avoids truncation). Override globally with
`OPENAI_THINKING_DISABLED=1`.

### Gemini 3.5 thinking control

Gemini 3.5 Flash exposes reasoning via `thinkingLevel` (MINIMAL/LOW/MEDIUM/HIGH)
in a separate budget from output tokens. The tagger sets this per pass:

| Pass | `thinkingLevel` | Why |
|---|---|---|
| Extraction | `MINIMAL` | Perception task — no chain-of-thought needed. Preserves speed/cost. |
| Critique | `HIGH` | Deep reasoning is where 3.5 Flash closes the gap on Claude Sonnet for writing. |

If the MINIMAL extraction comes back weak (blank `patternType`, no categories,
"Untitled" name — the same signals the existing low→high detail escalation
uses), it re-runs once at HIGH. Strong first results never pay for the
escalation. The 2.5 thinking model is still supported (`thinkingBudget: 0` on
extraction); the tagger branches on model name.

### Debug logging

Set `DEBUG_TAGGER=1` to print per-call provider config and token usage to
stderr (quiet by default so production logs stay clean):

```
[gemini] model=gemini-3.5-flash pass=extraction thinkingConfig={"thinkingLevel":"MINIMAL"}
[gemini] pass=extraction usage thoughts=? out=249 in=2117
[openai-compat] model=deepseek-ai/deepseek-v4-pro pass=critique base=https://integrate.api.nvidia.com/v1 thinking=true
[openai-compat] pass=critique usage in=1034 out=3426 total=4460
```

### Reliability: retries + 429 handling

- **Transient 5xx / network errors** retry with exponential backoff (502/503/504,
  ECONNRESET, "overloaded"/"high demand").
- **429 rate-limit responses** retry when the provider gives a hint: Gemini's
  `retryDelay: "12s"`, OpenAI/Anthropic's `Retry-After` header, or — for
  hint-less 429s from per-minute quotas (NIM's bare "Too Many Requests") — a
  65s fallback wait that respects the per-minute window.
- **Hard quota errors** (body mentions `quota`/`billing`/`credit`/`depleted`)
  are surfaced to the caller instead of stalling — daily-cap exhaustion
  shouldn't hang the batch.

**Provider differences normalized:** system-prompt placement, image encoding
(data-URI vs raw base64), max-tokens location, auth headers, response text
extraction — all handled behind a shared `callModel` signature.

---

## Dedup at bulk import

When you drop files into Bulk Import, each image is checked against the existing
corpus **before** staging — no API calls wasted on duplicates. The same gate
runs again at commit time (`POST /entries`) so nothing slips through a race.

| Level | Method | Catches |
|---|---|---|
| **Exact** | SHA-256 hash | Re-uploads of the same file |
| **Near (perceptual)** | dHash — 64-bit fingerprint, Hamming distance <12 | Same page, different scroll/compression/crop |
| **Fallback** | Same dimensions (±2px) | When dHash is unavailable |

Duplicates show as error rows: `Duplicate (exact|near) of "entry-id" — skipped`.

The dHash algorithm: resize to 9×8 grayscale via `sharp`, compare each pixel
with its right neighbor → 64 bits. Two screenshots of the same dashboard at
different scroll positions produce hashes that differ by only a handful of bits.
The dHash cache is persisted to `corpus/.dhash-cache.json` so re-imports don't
recompute fingerprints.

---

## MCP tools (12)

All tools are read-only over the corpus, organized into three tiers:
**retrieval** (find + read), **synthesis** (generate a direction), and
**aggregation** (corpus-wide knowledge).

### Retrieval — find and read entries

#### `search_ui_examples(query?, category?, styleTag?, qualityTier?, minQuality?, reviewStatus?, platform?, limit?)`
The primary entry point. Free-text + structural filters. Returns metadata +
critique per match, no images by default (keeps responses small). Uses vector
search when an index exists (Voyage), keyword fallback otherwise. Filters:
- `qualityTier` — `"exceptional"` (default) or `"cautionary"` (bad examples)
- `reviewStatus` — `"approved"` (default), `"draft"` (WIP, hidden by default),
  or `"any"` (both)
- `platform` — `"web"` / `"mobile"` / `"tablet"` — orthogonal to patternType

#### `get_ui_example(id)`
Full detail for one entry: critique, what to steal, anti-patterns, voice, color
roles (paste-ready CSS tokens), visual attributes, layout wireframe, provenance
(how the fields were produced), and the image itself if available. The only tool
that returns image bytes — kept separate from search so a search call never
balloons in size.

#### `get_similar_ui_examples(id, limit?)`
Ranks the rest by vector cosine similarity to one source entry. "What other
empty states are like this one?" Requires the embedding index. Excludes drafts.

#### `compare_ui_examples(ids)`
Takes 2-3 ids, returns a structured comparison table across patternType, style,
density, critique angle, top steal, and anti-patterns. For choosing between
approaches.

#### `list_categories()` / `list_style_tags()`
Discover valid filter values. `list_categories` also reports the search mode
(vector active vs keyword-only) and index drift (`missing` / `stale` counts).

#### `browse_ui_examples(styleTag?)`
Discovery tool — summarizes what's in the corpus grouped by patternType: count,
top products, and the highest-quality exemplar entry per pattern. Use before
searching when you don't yet know what to look for.

### Synthesis — generate a design direction

#### `recommend_ui_direction(productContext, count?, category?, qualityTier?, platform?, framework?)`
The "design advisor." Describe what you're building; it embeds the description,
finds the 3-5 most relevant entries with **product diversity** (won't return 3
from the same app), and synthesizes a direction citing each. Pure deterministic
aggregation — no LLM call, no hallucination. Use when you have a description but
no specific ids. Pass `qualityTier:"cautionary"` to recommend what to AVOID
(reframes the synthesis as pitfalls to avoid, not techniques to emulate).

#### `generate_design_prompt(ids, framework?, context?)`
Synthesize a design brief across 2-5 specific entry ids you already know.
Returns paste-ready color tokens (CSS `:root`), typography approach, layout
structure, voice register, techniques to borrow, and anti-patterns to avoid —
each traced back to a source entry. `framework:"tokens"` returns JSON design
tokens. Use when you have ids (e.g. "build me a pricing page like Stripe +
Linear").

**Recommend vs generate:** `recommend` searches for you (description in,
direction out); `generate` synthesizes from entries you've chosen (ids in, brief
out). If a `recommend` result is strong, pass its cited ids into
`generate_design_prompt` to re-synthesize with a different `context` or
`framework`.

### Aggregation — corpus-wide knowledge

#### `get_anti_patterns(patternType?, category?, limit?)`
Returns the consensus anti-patterns (common UI mistakes to avoid) for a pattern,
aggregated across all matching entries and ranked by how many raise each. Each
lists its source entries. This is the Mobbin-can't-offer feature: the corpus
knows what NOT to do.

#### `get_color_palette(patternType?, styleTag?, limit?)`
Paste-ready color token sets from entries with `colorRoles`, grouped by accent
hue band (red/blue/green/...). Sorted by hue for visual grouping. For "give me
real palettes for a dashboard."

#### `get_stealable_techniques(patternType?, styleTag?, limit?)`
Concrete, copyable techniques across a category, deduped by theme. Each cites
its source entry. For "what can I steal for a dense data table?"

All aggregation tools exclude drafts by default (mirrors search).

---

## Skill — `clean-ui-design`

The repo ships a companion skill (`skill/clean-ui-design/`) that orchestrates
the MCP tools into an agent workflow: search → read → compare → synthesize, with
a strict quality bar against generic AI output. Install it:

```bash
# Copy the skill into your ZCode skills directory
cp -r skill/clean-ui-design ~/.zcode/skills/
```

The skill documents the full 12-tool catalog, the recommend-vs-generate decision
tree, and points to reference files:
- `references/banned-phrases.md` — the anti-slop list (banned phrases + the
  DECISION + EFFECT + REJECTION pattern that replaces them)
- `references/decision-effect-rejection.md` — the critique format with worked
  examples (sloppy vs grounded)
- `agents/` — sub-agent definitions for delegated corpus research

The skill enforces the same anti-slop guardrails the tagger does: banned
phrases, DECISION + EFFECT + REJECTION structure, anti-patterns as first-class.

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

There's also a one-shot `npm run workflow` that chains capture → add-entry for
the common case (configure arguments via the `CAPTURE_ARGS` env var).

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
```

Or via the dashboard: Bulk import tab → drop files → Auto-fill all → Commit ready.

**Filename convention:** `<product-slug>__<notes>.png` infers product name + URL
from a built-in table (Linear, Stripe, Vercel, etc.). Unmatched files use a
batch-level default product name.

**Dedup:** every file is checked against the corpus before staging (see
[Dedup](#dedup-at-bulk-import)) and again at commit time.

**Deferred critique:** Auto-fill can run extraction only and defer the critique
pass — useful when staging a large batch cheaply and reviewing before spending
the critique budget.

---

## Corpus trust & recovery

The corpus is plain JSON — easy to edit and review, but also easy to overwrite
by mistake. A durability layer makes that class of loss recoverable:

- **Atomic writes** — every save goes to a temp file then renames over the
  primary, so a crash mid-write can't corrupt `entries.json`.
- **Rolling snapshots** — every save also keeps the last 20 timestamped copies
  in `corpus/.snapshots/` (gitignored). If the primary goes missing or corrupt,
  the UI auto-recovers from the newest snapshot.
- **`npm run restore-corpus`** — first-class recovery CLI. `--list` to inspect,
  `--dry-run` to see the diff (added/removed ids, duplicate ids, validation
  status), `--latest` or `--snapshot <name>` to restore. A restore snapshots the
  current state first, so a bad restore is itself recoverable.

**Entry-count drift check:** copy `corpus/.corpus-config.example.json` to
`corpus/.corpus-config.json` and set `expectedMinEntries` to your floor. If the
count drops below it, `validate-corpus` and `doctor` shout loudly — the most
common silent-loss signal.

**Index drift detection:** `indexStatus()` reports `missing` (entries with no
vector) and `stale` (vectors for removed entries). The MCP status string,
`corpus-stats`, and `doctor` all surface this — a stale index no longer reports
"active" silently.

```bash
npm run doctor                       # full health check (PASS/WARN/FAIL)
npm run restore-corpus -- --list     # see available snapshots
npm run restore-corpus -- --latest   # restore the newest
npm run clean-orphans -- --dry-run   # find unreferenced images
```

---

## Analytics

Two complementary CLIs turn the corpus and its query log into signal:

- **`npm run corpus-stats`** — distribution by pattern/category/style, coverage
  gaps, source staleness, an anti-pattern vague-phrase lint, index coverage,
  image references (orphans/missing), and quality metrics (voice/layout/image %,
  top products, provenance split). Use this to see what the corpus has and where
  it's thin.
- **`npm run query-stats`** — retrieval analytics over `corpus/query-log.jsonl`.
  Surfaces dead result ids, demand-vs-supply gaps (queries that return little),
  and the most-used filters. Use this to see what people ask for vs what exists.

Every MCP search/recommend call appends a row to the append-only
`corpus/query-log.jsonl` for the analytics tools to read.

---

## Migrations

The corpus is at **schema v2**. Migration scripts are idempotent — safe to
re-run:

```bash
npm run migrate              # v1 → v2: adds patternType + antiPatterns block
npm run migrate-layout       # populates the layout field for dashboard entries
npm run migrate-untitled     # maps "Untitled" product names to canonical slugs
npm run migrate-platform     # backfills platform from screenshot dimensions
```

Fresh v2 checkouts don't need any of these. The validator reports any `[TODO]`
placeholders that still need backfill — non-blocking, but a quality forcing
function.

---

## Project structure

```
clean-ui-mcp/
├── corpus/
│   ├── entries.json            # the corpus — schema v2 (gitignored: private imgs)
│   ├── seed.json               # minimal shipped sample (1 link-only entry)
│   ├── embeddings.json         # Voyage AI vectors (gitignored)
│   ├── query-log.jsonl         # append-only MCP query log for analytics
│   ├── .snapshots/             # rolling snapshots (gitignored)
│   ├── .dhash-cache.json       # perceptual-hash cache for dedup
│   ├── .corpus-config.json     # expectedMinEntries drift floor (you create)
│   ├── images-private/         # gitignored — your local research images
│   └── images-public/          # committed — redistribution-cleared thumbnails
├── src/
│   ├── schema.ts               # Zod schema + findDraftMarkers (the data model)
│   ├── corpus.ts               # load / search / similar / compare — pure data layer
│   ├── server.ts               # MCP server: 12 tools
│   ├── design-prompt.ts        # generate_design_prompt synthesis (pure)
│   ├── recommend.ts            # recommend_ui_direction synthesis (pure)
│   ├── aggregations.ts         # anti-patterns / palettes / techniques / browse
│   ├── embeddings.ts           # Voyage AI client + cosine + index I/O
│   ├── persistence.ts          # atomic writes + snapshots (reused by CLIs)
│   ├── env.ts                  # .env loading + provider config
│   ├── tagger.ts               # two-pass vision tagger (OpenAI/Claude/Gemini)
│   ├── paths.ts                # corpus-path validation (traversal guards)
│   └── scripts/
│       ├── ui-server.ts        # curator dashboard server (3-zone shell)
│       ├── validate-corpus.ts  # standalone validator (CI / pre-commit)
│       ├── build-index.ts      # embed all entries via Voyage AI
│       ├── capture.ts          # Puppeteer screenshot capture
│       ├── add-entry.ts        # interactive terminal wizard
│       ├── tag-image.ts        # CLI wrapper for the vision tagger
│       ├── bulk-import.ts      # batch ingest (terminal)
│       ├── review-draft.ts     # interactive draft reviewer (terminal)
│       ├── commit-draft.ts     # commit approved drafts to corpus
│       ├── corpus-stats.ts     # corpus distribution + coverage report
│       ├── query-stats.ts      # retrieval analytics over the query log
│       ├── doctor.ts           # one-command health check
│       ├── restore-corpus.ts   # snapshot recovery CLI
│       ├── clean-orphans.ts    # delete unreferenced private images
│       ├── migrate-v1-to-v2.ts # v1 → v2 schema migration
│       ├── migrate-layout-field.ts
│       ├── migrate-untitled-products.ts
│       └── migrate-platform.ts
├── ui/
│   ├── app.js                  # curator dashboard frontend logic
│   └── styles.css              # curator dashboard styles
├── index-2.html                # slim dashboard HTML shell
├── skill/clean-ui-design/      # companion agent skill (12-tool workflow)
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
| `npm run dev` | Build + start the MCP server |
| `npm run ui` | Build + start the curator dashboard at `http://localhost:3131` |
| `npm test` | Run all tests (vitest unit + Playwright browser tests) |
| `npm run validate-corpus` | Validate `entries.json` against schema + hygiene checks |
| `npm run build-index` | Embed all entries via Voyage AI (needs `VOYAGE_API_KEY`) |
| `npm run capture` | Screenshot a URL via Puppeteer |
| `npm run add-entry` | Interactive entry wizard (terminal) |
| `npm run workflow` | One-shot capture → add-entry chain (`CAPTURE_ARGS` for capture flags) |
| `npm run tag-image` | Run the vision tagger on one image |
| `npm run bulk-import` | Batch ingest from a folder of screenshots |
| `npm run review-draft` | Review bulk-import drafts interactively |
| `npm run commit-draft` | Commit approved drafts to the corpus |
| `npm run migrate` | v1 → v2 schema migration (patternType + antiPatterns) |
| `npm run migrate-layout` | Populate the layout field for dashboard entries |
| `npm run migrate-untitled` | Map "Untitled" product names to canonical slugs |
| `npm run migrate-platform` | Backfill `platform` from screenshot dimensions |
| `npm run corpus-stats` | Distribution, coverage gaps, staleness, quality metrics |
| `npm run query-stats` | Retrieval analytics over the MCP query log |
| `npm run doctor` | One-command health check: TS, corpus, snapshots, images, index, env |
| `npm run restore-corpus` | Recover from a snapshot (`--list`, `--latest`, `--snapshot`, `--dry-run`) |
| `npm run clean-orphans` | Delete unreferenced private images (`--dry-run` default, `--confirm` to delete) |

**Helper scripts** (in `scripts/`, run with `node scripts/<name>.mjs` — not in `package.json` because they're one-off workflow helpers, not the core build/test pipeline):

| Script | What it does |
|---|---|
| `node scripts/build-bulk-manifest.mjs --folder <dir> --out <path>` | Generate a `--manifest` JSON for `npm run bulk-import` from a folder of screenshots whose filenames don't follow the `<product>__<notes>.png` convention. Infers productName/URL from a built-in prefix map (extend `PREFIX_MAP` as you add products). Recurses subfolders. |
| `node scripts/dedup-check.mjs --folder <dir>` | Read-only count of how many images in a folder are genuinely NEW vs already in the corpus. Uses the project's own SHA-256 + dHash logic. Run before a bulk import to size the work and cost. |
| `node scripts/strip-and-approve.mjs --draft <path>` | Strip `[DRAFT]` markers and flip `_importStatus` to `approved` for a draft file you've decided to commit without per-entry review. Backs up to `<path>.bak` first. Idempotent. |

---

## Testing

Tests are decoupled from the mutable corpus so they don't break when entries
change. Unit tests inject fixtures via `setCorpusForTesting`; browser tests run
against Playwright Chromium.

```bash
npm test                 # vitest unit tests + Playwright browser tests
npx vitest run           # unit tests only
npx vitest run src/design-prompt.test.ts   # one file
```

CI (`.github/workflows/ci.yml`) runs on every PR and push to `main`:
`npm ci` → install Playwright Chromium → `build` → `validate-corpus` → `test`.

Coverage today spans the data model (`schema`, `corpus`, `design-prompt`,
`recommend`, `aggregations`), the tagger, the UI server, and browser flows
through the curator dashboard.

---

## Why JSON instead of a database

At a few hundred entries (and realistically up to a few thousand), a single JSON
file is easier to diff, review in PRs, and hand-edit than a database, and it has
zero native dependencies. `src/corpus.ts` is the only file that knows how
entries are stored — swap it for SQLite/Postgres/a vector store later without
touching `server.ts` if the corpus outgrows this.

---

## Status

Active development. The corpus is growing — add real curated entries before
relying on this for production work. Contributions welcome: new entries, new
patterns, new providers, better critiques.

See [`ROADMAP.md`](./ROADMAP.md) for what's shipped, what's next, and what's
deferred.
