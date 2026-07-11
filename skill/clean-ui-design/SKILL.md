---
name: clean-ui-design
description: >-
  Ground UI/frontend design work in a curated corpus of real, critiqued
  examples. Use when the user asks to build, redesign, or improve a UI —
  dashboards, landing pages, pricing, onboarding, auth, empty states, data
  tables, forms, navigation, search, checkout, or any component where "make
  it clean" or "make it modern" is the goal. Searches the clean-ui MCP corpus
  for relevant patterns, reads structured critiques (what to steal, what to
  avoid), and synthesizes a design brief grounded in real examples rather than
  generic AI defaults. Also use when the user wants design feedback, pattern
  research, or to compare UI approaches.
---

# Clean UI Design

Ground design decisions in a curated corpus of real, critiqued UI examples.
The corpus holds structured reasoning — not just screenshots — for each entry:
what makes it work (critique), what to steal (techniques with reasoning), what
to avoid (anti-patterns), color roles (paste-ready tokens), and layout
wireframes (machine-readable regions).

The point: stop producing the statistical average of training data. Start from
specific, real, well-explained examples.

## Prerequisites

The `clean-ui` MCP server must be configured and the corpus built. If
`search_ui_examples` is not available as a tool, tell the user to install:

```bash
git clone <repo> && cd clean-ui-mcp && npm install && npm run build
npm run build-index   # needs VOYAGE_API_KEY — enables semantic search
```

Then add to their MCP client config:
```json
{ "mcpServers": { "clean-ui": { "command": "node", "args": ["/path/to/clean-ui-mcp/dist/server.js"] } } }
```

## Tool catalog (13 tools — three tiers)

### Retrieval — find and read entries
- **`search_ui_examples(query?, category?, styleTag?, qualityTier?, minQuality?, reviewStatus?, limit?)`** — primary entry point. Free-text + structural filters. Returns metadata + critique per match. `qualityTier:"cautionary"` for bad examples; `reviewStatus:"draft"` to see WIP entries (hidden by default).
- **`get_ui_example(id)`** — full record for one entry: critique, what to steal, anti-patterns, color roles, layout, voice, image (if available).
- **`get_similar_ui_examples(id, limit?)`** — cosine-similarity ranking against one entry. For "more like this."
- **`compare_ui_examples(ids)`** — side-by-side structured comparison across 2-3 entries (pattern, density, critique angle, top steal, anti-patterns). For choosing between approaches.
- **`list_categories()` / `list_style_tags()`** — enumerate the corpus's vocab. Call before searching if unsure what filters exist.
- **`browse_ui_examples(styleTag?)`** — discovery: what's in the corpus grouped by patternType (count, top products, exemplar). Use when you don't yet know what to search for.

### Synthesis — generate a design direction
- **`recommend_ui_direction(productContext, count?, category?, qualityTier?, framework?)`** — the "design advisor." Describe what you're building; it embeds the description, finds 3-5 relevant entries with product diversity, and synthesizes a brief. **Use this when the user has a description but no specific ids.** Pass `qualityTier:"cautionary"` to recommend what to AVOID.
- **`generate_design_prompt(ids, framework?, context?)`** — synthesize a brief across 2-5 specific entry ids the user already knows. Returns paste-ready color tokens, typography, layout, voice, techniques, anti-patterns. **Use this when the user has ids** (e.g. "build me a pricing page like Stripe + Linear").

**When to use which:** `recommend_ui_direction` searches for you (description in, direction out); `generate_design_prompt` synthesizes from entries you've already read and chosen (ids in, brief out). If a `recommend` result is strong, you can pass its cited ids into `generate_design_prompt` to re-synthesize with a different `context` or `framework`.

### Aggregation — surface corpus-wide knowledge
- **`get_anti_patterns(patternType?, category?, limit?)`** — consensus mistakes to avoid for a pattern. The Mobbin-can't-offer feature: the corpus knows what NOT to do, ranked by how many entries raise each anti-pattern.
- **`get_color_palette(patternType?, styleTag?, limit?)`** — paste-ready color token sets from entries with `colorRoles`, grouped by accent hue band. For "give me real palettes for a dashboard."
- **`get_stealable_techniques(patternType?, styleTag?, limit?)`** — concrete techniques across a category, deduped by theme. For "what can I steal for a dense data table?"
- **`browse_ui_examples(styleTag?)`** — (also in retrieval) discovery by pattern.

## The workflow

### 1. Discover or search

If the user knows what they want, go straight to `search_ui_examples` with their intent translated to corpus terms (query + category/styleTag filters). If they're exploring, start with `browse_ui_examples` to see what patterns exist, or `recommend_ui_direction` to get a synthesized direction from a description.

### 2. Read the best matches in depth

For the top 2-3 results, call `get_ui_example(id)`. Read carefully:
- **Critique** — the DECISION + EFFECT + REJECTION reasoning. This is the core value. See `references/decision-effect-rejection.md` for the format.
- **What to steal** — concrete, copyable techniques, each with reasoning.
- **Anti-patterns** — read as carefully as the steals; knowing what NOT to do is half the brief.
- **Color roles** — if present, paste-ready CSS tokens. Use directly.
- **Layout** — if present, structured `regions` (page form + component roles).
- **Provenance** — `taggedBy` tells you whether the critique was `human`-authored, `auto` (tagger-generated, unreviewed), or `auto-reviewed` (tagger + human edit). Weight `human`/`auto-reviewed` higher; treat `auto` as a draft to verify.

### 3. Compare or aggregate

- Choosing between directions → `compare_ui_examples([id1, id2, id3])`.
- "What mistakes should I avoid for a modal?" → `get_anti_patterns({ patternType: "modal" })`.
- "Give me palettes for a dashboard" → `get_color_palette({ patternType: "dashboard" })`.
- "Techniques to steal for a data table" → `get_stealable_techniques({ patternType: "data-table" })`.

### 4. Synthesize

If you've read specific entries and want a brief, call `generate_design_prompt(ids, context?)`. If you only have the user's description, call `recommend_ui_direction(productContext)`. **Do not hand-synthesize when these tools exist** — they aggregate consensus (color plurality, anti-pattern frequency) more reliably than reading 3 entries in sequence.

## Workflow state — drafts and review

The corpus has a `reviewStatus` field. Entries default to `approved`; drafts are **hidden from search and aggregation tools by default** so WIP entries don't leak into synthesis. If a user is curating and wants to see their drafts, pass `reviewStatus:"draft"` (or `"any"`) to `search_ui_examples`. Drafts never appear in `recommend_ui_direction`, `get_anti_patterns`, etc., unless explicitly included.

## Quality bar — avoid AI slop

The corpus exists to fight generic AI output. When synthesizing or summarizing, enforce:

- **No banned phrases**: see `references/banned-phrases.md` for the full list. Every claim must name a specific, reproducible decision.
- **DECISION + EFFECT + REJECTION**: for each technique, name the choice, why it works perceptually/functionally, and what conventional default it replaces.
- **Specificity over coverage**: one sharp, correct detail grounded in a real example beats three generic observations that could apply to any UI.
- **Anti-patterns are first-class**: surface what to avoid as prominently as what to steal.

## Do not

- Do NOT copy the screenshots. Do NOT reproduce the visual appearance. Extract the **shared structural decisions** and adapt them.
- Do NOT hand-synthesize a brief when `generate_design_prompt` or `recommend_ui_direction` can do it deterministically.
- Do NOT use banned phrases (see references). They are the signal of generic AI output this corpus exists to replace.
