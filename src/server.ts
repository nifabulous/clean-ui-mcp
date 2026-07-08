#!/usr/bin/env node
import "./env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  loadCorpus,
  searchEntries,
  searchRanked,
  getEntryById,
  listCategories,
  listStyleTags,
  listDomainTags,
  indexStatus,
  findSimilarEntries,
} from "./corpus.js";
import { Category, StyleTag, PatternType } from "./schema.js";
import { generateBrief, renderBrief } from "./design-prompt.js";
import { buildRecommendation, renderRecommendation } from "./recommend.js";
import { aggregateAntiPatterns, collectPalettes, collectTechniques, browseByPattern, hueBand } from "./aggregations.js";
import { readFileSync, existsSync } from "node:fs";
import { fromCorpusRelativeImagePath } from "./paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUERY_LOG_PATH = resolve(__dirname, "..", "corpus", "query-log.jsonl");

/** Strip placeholder title suffixes so "Product — (add descriptive subtitle)"
 *  shows as just "Product" in MCP tool output. Falls back to productName. */
function cleanTitle(title: string, fallback: string): string {
  const cleaned = title.replace(/\s*—\s*\(add descriptive subtitle\)\s*$/i, "").trim();
  return cleaned || fallback;
}

/** Append-only query log for retrieval analytics (query-stats.ts). Never throws. */
async function logQuery(params: { query?: string; category?: string; styleTag?: string; qualityTier?: string; platform?: string }, resultIds: string[]): Promise<void> {
  const entry = JSON.stringify({ ts: new Date().toISOString(), ...params, resultIds });
  appendFile(QUERY_LOG_PATH, entry + "\n").catch(() => {});
}

const server = new McpServer({
  name: "clean-ui-mcp",
  version: "0.1.0",
});

/**
 * Tool: search_ui_examples
 * The primary entry point. Returns metadata + critique for matching
 * entries — NOT raw images by default, to keep responses small and
 * let the caller decide whether it actually needs the pixels.
 */
server.registerTool(
  "search_ui_examples",
  {
    title: "Search exceptional UI examples",
    description:
      "Search a curated corpus of exceptional UI examples by free-text query, " +
      "category (e.g. 'dashboard', 'pricing', 'empty-state'), or style tag " +
      "(e.g. 'minimal', 'dense-data', 'brutalist'). Returns structured metadata " +
      "and a written critique for each match, explaining what makes the example " +
      "work and what techniques to borrow. Use get_ui_example to fetch the full " +
      "record (and image, if available) for a specific result by id.",
    inputSchema: {
      query: z
        .string()
        .optional()
        .describe("Free-text search, e.g. 'dense data table' or 'pricing page serif'"),
      category: Category.optional().describe("Filter to a specific UI category"),
      styleTag: StyleTag.optional().describe("Filter to a specific style/aesthetic"),
      minQuality: z
        .number()
        .min(1)
        .max(5)
        .optional()
        .describe("Only return examples rated at or above this quality score (1-5)"),
      qualityTier: z
        .enum(["exceptional", "cautionary"])
        .optional()
        .describe("Filter to a quality tier: 'exceptional' (great examples) or 'cautionary' (bad examples worth teaching what NOT to do)"),
      reviewStatus: z
        .enum(["approved", "draft", "any"])
        .optional()
        .describe("Workflow state: 'approved' (default, finished entries), 'draft' (work-in-progress), or 'any' (both). Drafts are hidden from search by default so half-finished entries don't leak into results."),
      platform: z
        .enum(["web", "mobile", "tablet"])
        .optional()
        .describe("Filter to a device class — orthogonal to patternType. Use 'mobile' for phone screenshots, 'web' for desktop. Lets you ask 'mobile onboarding' vs 'web onboarding'."),
      limit: z.number().int().min(1).max(20).optional().describe("Max results, default 5"),
      responseFormat: z.enum(["concise", "detailed"]).optional().describe("Output detail level. 'concise' omits steal items and anti-patterns, truncates critique to ~100 chars — lighter for browsing. 'detailed' (default) returns everything."),
    },
  },
  async ({ query, category, styleTag, minQuality, qualityTier, reviewStatus, platform, limit, responseFormat }) => {
    const results = await searchEntries({ query, category, styleTag, minQuality, qualityTier, reviewStatus: reviewStatus as "draft" | "approved" | "any" | undefined, platform: platform as "web" | "mobile" | "tablet" | undefined, limit });

    // Log for retrieval analytics (query-stats.ts) — never blocks the response.
    logQuery({ query, category, styleTag, qualityTier }, results.map((e) => e.id));

    if (results.length === 0) {
      return {
        content: [
          {
            type: "text",
            text:
              "No matching examples found. Try a broader query, or call " +
              "list_categories / list_style_tags to see available filter values.",
          },
        ],
      };
    }

    const concise = responseFormat === "concise";
    const summary = results
      .map((e) => {
        const hasImage = e.image.visibility !== "private" && e.image.path;
        const lines = [
          `### ${cleanTitle(e.title, e.source.productName)}  (id: ${e.id})`,
          `Categories: ${e.categories.join(", ")} | Style: ${e.styleTags.join(", ")}`,
          `Quality: ${e.qualityScore}/5 | Source: ${e.source.productName}${e.source.url ? ` (${e.source.url})` : ""}`,
        ];
        if (concise) {
          lines.push(`Critique: ${e.critique.slice(0, 120)}${e.critique.length > 120 ? "…" : ""}`);
        } else {
          lines.push(
            `Image available via get_ui_example: ${hasImage ? "yes" : "no (metadata/critique only)"}`,
            ``,
            `Critique: ${e.critique}`,
            ``,
            `What to steal:`,
            ...e.whatToSteal.map((t) => `  - ${t}`),
            e.antiPatterns.antiPatterns.length
              ? `Anti-patterns (mistakes avoided):\n${e.antiPatterns.antiPatterns.map((t) => `  - ${t}`).join("\n")}`
              : "",
          );
        }
        return lines.filter(Boolean).join("\n");
      })
      .join("\n\n---\n\n");

    return {
      content: [{ type: "text", text: summary }],
    };
  },
);

/**
 * Tool: get_ui_example
 * Full detail fetch for one entry, including the image itself when
 * it's cleared for redistribution. This is the only tool that may
 * return image bytes — kept separate from search so a search call
 * never silently balloons in size.
 */
server.registerTool(
  "get_ui_example",
  {
    title: "Get full detail (and image, if available) for one UI example",
    description:
      "Fetch the complete record for a single UI example by id, including " +
      "full visual attributes (colors, type pairing, spacing) and the source " +
      "image if it's cleared for redistribution. If no image is available, " +
      "the response includes the source URL so the example can be viewed there.",
    inputSchema: {
      id: z.string().describe("Entry id, e.g. 'linear-issue-board-grouped'"),
    },
  },
  async ({ id }) => {
    const entry = getEntryById(id);
    if (!entry) {
      return {
        content: [{ type: "text", text: `No entry found with id "${id}".` }],
        isError: true,
      };
    }

    const detail = [
      `# ${cleanTitle(entry.title, entry.source.productName)}`,
      `Source: ${entry.source.productName}${entry.source.url ? ` — ${entry.source.url}` : ""}`,
      entry.qualityTier === "cautionary" ? `Quality tier: **cautionary** (a bad example — critique explains what goes wrong)` : "",
      ``,
      `## Critique`,
      entry.critique,
      ``,
      `## What to steal`,
      ...entry.whatToSteal.map((t) => `- ${t}`),
      ``,
      entry.antiPatterns.antiPatterns.length
        ? `## Anti-patterns (mistakes this design avoids)\n${entry.antiPatterns.antiPatterns.map((t) => `- ${t}`).join("\n")}\n`
        : "",
      entry.antiPatterns.whereThisFails.length
        ? `## Where copying this fails\n${entry.antiPatterns.whereThisFails.map((t) => `- ${t}`).join("\n")}\n`
        : "",
      entry.antiPatterns.accessibilityRisks.length
        ? `## Accessibility risks\n${entry.antiPatterns.accessibilityRisks.map((t) => `- ${t}`).join("\n")}\n`
        : "",
      entry.businessRationale
        ? `## Business rationale\n- Goal: ${entry.businessRationale.businessGoal}\n- Target user: ${entry.businessRationale.targetUser}\n- Rationale: ${entry.businessRationale.rationale}\n- Confirmed: ${entry.businessRationale.confirmed ? "yes" : "no"}\n`
        : "",
      entry.voice
        ? `## Voice\n- Tone: ${entry.voice.tone}\n${entry.voice.examples.map((e) => `- Example: "${e}"`).join("\n")}${entry.voice.avoid.length ? `\n${entry.voice.avoid.map((a) => `- Avoid: ${a}`).join("\n")}` : ""}\n`
        : "",
      `## Visual attributes`,
      `- Dominant colors: ${entry.visual.dominantColors.join(", ")}`,
      `- Accent: ${entry.visual.accentColor ?? "none identified"}`,
      entry.visual.colorRoles
        ? `- Color roles (paste-ready token set): canvas ${entry.visual.colorRoles.canvas}, surface ${entry.visual.colorRoles.surface}, ink ${entry.visual.colorRoles.ink}${entry.visual.colorRoles.muted ? `, muted ${entry.visual.colorRoles.muted}` : ""}, accent ${entry.visual.colorRoles.accent}`
        : "",
      `- Type pairing: ${entry.visual.typePairing.display ?? "?"} / ${entry.visual.typePairing.body ?? "?"}${entry.visual.typePairing.notes ? ` — ${entry.visual.typePairing.notes}` : ""}`,
      `- Spacing density: ${entry.visual.spacingDensity}`,
      `- Corners: ${entry.visual.cornerStyle}`,
      `- Shadows: ${entry.visual.usesShadows ? "yes" : "no"} | Borders: ${entry.visual.usesBorders ? "yes" : "no"}`,
    ]
      .filter(Boolean)
      .join("\n");

    const content: Array<
      | { type: "text"; text: string }
      | { type: "image"; data: string; mimeType: string }
    > = [{ type: "text", text: detail }];

    // Only attach actual image bytes if the entry is cleared for it AND
    // the file is physically present (private-corpus entries on someone
    // else's machine simply won't have the file — handle that gracefully).
    if (entry.image.visibility !== "private" && entry.image.path) {
      const fullPath = fromCorpusRelativeImagePath(entry.image.path);
      if (existsSync(fullPath)) {
        const data = readFileSync(fullPath).toString("base64");
        const ext = entry.image.path.split(".").pop()?.toLowerCase();
        const mimeType =
          ext === "png"   ? "image/png"
          : ext === "webp" ? "image/webp"
          : "image/jpeg";
        content.push({ type: "image", data, mimeType });
      } else {
        content.push({
          type: "text",
          text: `\n(Image file not found locally at ${entry.image.path} — see source URL above.)`,
        });
      }
    } else {
      content.push({
        type: "text",
        text: entry.source.url
          ? `\n(No redistributable image for this entry — view live at ${entry.source.url})`
          : `\n(No redistributable image or source URL for this entry.)`,
      });
    }

    return { content };
  },
);

server.registerTool(
  "list_categories",
  {
    title: "List available UI categories",
    description: "Returns all UI category tags currently present in the corpus, plus the current search mode (vector or keyword).",
    inputSchema: {},
  },
  async () => {
    const status = indexStatus();
    const driftParts = [
      status.missing > 0 ? `${status.missing} missing` : null,
      status.stale > 0 ? `${status.stale} stale` : null,
      status.contentStale > 0 ? `${status.contentStale} content-stale` : null,
    ].filter(Boolean);
    const drift = status.hasIndex && driftParts.length ? ` · ${driftParts.join(", ")} — run \`npm run build-index\`` : "";
    const mode   = status.hasIndex
      ? `vector search active (${status.indexed}/${status.total} entries indexed${drift})`
      : `keyword search only — run \`npm run build-index\` to enable semantic vector search`;
    return {
      content: [{
        type: "text",
        text: `Categories: ${listCategories().join(", ")}\n\nSearch mode: ${mode}`,
      }],
    };
  },
);

server.registerTool(
  "list_style_tags",
  {
    title: "List available style tags",
    description: "Returns all style/aesthetic tags currently present in the corpus.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: listStyleTags().join(", ") }],
  }),
);

server.registerTool(
  "list_domain_tags",
  {
    title: "List available domain tags",
    description: "Returns all business/product domain tags (billing, security, integrations, etc.) currently present in the corpus.",
    inputSchema: {},
  },
  async () => ({
    content: [{ type: "text", text: listDomainTags().join(", ") }],
  }),
);

/**
 * Tool: get_similar_ui_examples
 * Takes an entry id, loads its embedding, returns cosine-ranked similar entries.
 * Requires the vector index (`npm run build-index`); degrades to a clear
 * instruction if the index is missing or the source entry isn't indexed.
 */
server.registerTool(
  "get_similar_ui_examples",
  {
    title: "Find UI examples similar to a given one",
    description:
      "Takes a source entry id and returns the most semantically similar entries " +
      "from the corpus, ranked by vector cosine similarity. Use this to explore " +
      "variations on a pattern (e.g. 'what other empty states do like this one?'). " +
      "Requires the embedding index to be built (run `npm run build-index` if empty).",
    inputSchema: {
      id: z.string().describe("Source entry id, e.g. 'linear-issue-board-grouped'"),
      limit: z.number().int().min(1).max(20).optional().describe("Max results, default 5"),
    },
  },
  async ({ id, limit }) => {
    const source = getEntryById(id);
    if (!source) {
      return { content: [{ type: "text", text: `No entry found with id "${id}".` }], isError: true };
    }

    const results = findSimilarEntries(id, limit ?? 5);
    if (results.length === 0) {
      const status = indexStatus();
      const reason = !status.hasIndex
        ? "the embedding index hasn't been built. Run `npm run build-index` to enable similarity search."
        : status.missing > 0
          ? `the index is out of date — ${status.indexed}/${status.total} entries indexed (${status.missing} missing). Run \`npm run build-index\`.`
          : `this entry (or the others) aren't indexed yet (index covers ${status.indexed}/${status.total}).`;
      return {
        content: [{ type: "text", text: `Can't find similar entries — ${reason}` }],
      };
    }

    const summary = [
      `Entries similar to **${cleanTitle(source.title, source.source.productName)}** (${id}), ranked by semantic similarity:`,
      ``,
      ...results.map((r) => {
        const pct = Math.round(Math.max(0, r.score) * 100);
        return [
          `### ${cleanTitle(r.entry.title, r.entry.source.productName)}  (id: ${r.entry.id}) — ${pct}% similar`,
          `Pattern: ${r.entry.patternType} | Categories: ${r.entry.categories.join(", ")} | Style: ${r.entry.styleTags.join(", ")}`,
          `Critique: ${r.entry.critique}`,
          `What to steal:`,
          ...r.entry.whatToSteal.map((t) => `  - ${t}`),
        ].join("\n");
      }),
    ].join("\n\n---\n\n");

    return { content: [{ type: "text", text: summary }] };
  },
);

/**
 * Tool: compare_ui_examples
 * Takes 2-3 entry ids and returns a structured comparison across the fields
 * the enriched schema makes meaningful — pattern, style, density, critique
 * angle, top steal item, and anti-patterns (the differentiator).
 */
server.registerTool(
  "compare_ui_examples",
  {
    title: "Compare 2-3 UI examples side by side",
    description:
      "Takes 2-3 entry ids and returns a structured comparison table across " +
      "pattern type, categories, style, spacing/corners, the primary critique " +
      "angle, the top stealable technique, and anti-patterns. Use this when " +
      "choosing between approaches or contrasting design decisions.",
    inputSchema: {
      ids: z.array(z.string()).min(2).max(3).describe("2-3 entry ids to compare"),
    },
  },
  async ({ ids }) => {
    const entries = ids.map((id) => getEntryById(id));
    const missing = ids.filter((_, i) => !entries[i]);
    if (missing.length) {
      return { content: [{ type: "text", text: `No entries found for: ${missing.join(", ")}` }], isError: true };
    }
    const found = entries.filter((e): e is NonNullable<typeof e> => !!e);

    const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
    const firstSentence = (s: string) => cell(s.split(/[.!?]/)[0] || s);
    const top = (arr: string[]) => cell(arr[0] ?? "—");
    const header = `| Field | ${found.map((e) => cell(cleanTitle(e.title, e.source.productName))).join(" | ")} |`;
    const divider = `| --- | ${found.map(() => "---").join(" | ")} |`;
    const rows = [
      `| id | ${found.map((e) => cell(e.id)).join(" | ")} |`,
      `| patternType | ${found.map((e) => e.patternType).join(" | ")} |`,
      `| categories | ${found.map((e) => cell(e.categories.join(", "))).join(" | ")} |`,
      `| styleTags | ${found.map((e) => cell(e.styleTags.join(", "))).join(" | ")} |`,
      `| platform | ${found.map((e) => (e as Record<string, unknown>).platform ?? "web").join(" | ")} |`,
      `| layout | ${found.map((e) => e.layout?.form ?? "—").join(" | ")} |`,
      `| accent | ${found.map((e) => e.visual.accentColor ?? e.visual.colorRoles?.accent ?? "—").join(" | ")} |`,
      `| density / corners | ${found.map((e) => `${e.visual.spacingDensity} / ${e.visual.cornerStyle}`).join(" | ")} |`,
      `| shadows / borders | ${found.map((e) => `${e.visual.usesShadows ? "yes" : "no"} / ${e.visual.usesBorders ? "yes" : "no"}`).join(" | ")} |`,
      `| quality | ${found.map((e) => `${e.qualityScore}/5 ${e.qualityTier}`).join(" | ")} |`,
      `| critique angle | ${found.map((e) => firstSentence(e.critique)).join(" | ")} |`,
      `| top steal | ${found.map((e) => top(e.whatToSteal)).join(" | ")} |`,
      `| anti-patterns | ${found.map((e) => top(e.antiPatterns.antiPatterns)).join(" | ")} |`,
      `| a11y risks | ${found.map((e) => top(e.antiPatterns.accessibilityRisks)).join(" | ")} |`,
      `| where it fails | ${found.map((e) => top(e.antiPatterns.whereThisFails)).join(" | ")} |`,
    ];

    return { content: [{ type: "text", text: [header, divider, ...rows].join("\n") }] };
  },
);

/**
 * Tool: generate_design_prompt
 * Synthesize a design brief across 2-5 entries by id. Pure deterministic
 * aggregation over the corpus's curated judgments (colorRoles, typePairing,
 * voice, anti-patterns) — no LLM call, no hallucination. Returns a markdown
 * brief by default, or paste-ready JSON tokens with framework:"tokens".
 */
server.registerTool(
  "generate_design_prompt",
  {
    title: "Generate a design brief from N examples",
    description:
      "Takes 2-5 entry ids and synthesizes a design brief that distills the concrete " +
      "decisions across them — paste-ready color tokens, typography approach, layout " +
      "structure, voice register, techniques to borrow, and anti-patterns to avoid. " +
      "Use this when you want a single actionable direction grounded in specific real " +
      "examples (e.g. 'build me a pricing page like Stripe + Linear'). Each section " +
      "traces back to a specific entry you can inspect with get_ui_example. " +
      "framework:'tokens' returns JSON design tokens instead of markdown.",
    inputSchema: {
      ids: z.array(z.string()).min(2).max(5).describe("2-5 entry ids to synthesize across"),
      framework: z.enum(["brief", "tokens"]).optional().describe("Output shape: 'brief' (markdown, default) or 'tokens' (JSON design tokens)"),
      context: z.string().optional().describe("What you're building, folded into the direction statement (e.g. 'a pricing page for a fintech')"),
    },
  },
  async ({ ids, framework, context }) => {
    void logQuery({ query: `generate_design_prompt:${ids.join(",")}` }, ids);
    const entries = ids.map((id) => getEntryById(id));
    const missing = ids.filter((_, i) => !entries[i]);
    if (missing.length) {
      return { content: [{ type: "text", text: `No entries found for: ${missing.join(", ")}. Use search_ui_examples to find valid ids.` }], isError: true };
    }
    const found = entries.filter((e): e is NonNullable<typeof e> => !!e);
    const brief = generateBrief(found, { ids, framework: framework ?? "brief", context });
    return { content: [{ type: "text", text: renderBrief(brief) }] };
  },
);

/**
 * Tool: recommend_ui_direction
 * The "design advisor." Describe what you're building; it embeds the
 * description, finds the 3-5 most relevant corpus entries (with product
 * diversity so it doesn't return 3 from the same app), and synthesizes a
 * direction citing each. Uses generate_design_prompt's synthesis under the hood.
 */
server.registerTool(
  "recommend_ui_direction",
  {
    title: "Recommend a UI direction from a product description",
    description:
      "Describe what you're building (e.g. 'a calm analytics dashboard for a fintech' " +
      "or 'a playful onboarding flow for a mobile game'). Embeds the description, " +
      "finds the 3-5 most relevant corpus entries with product diversity, and " +
      "synthesizes a design direction citing each one — why it was selected, what " +
      "it contributes, and the concrete decisions to borrow. Requires the embedding " +
      "index (npm run build-index). Use this when you don't know which specific " +
      "entries to look at; use generate_design_prompt when you already have ids. " +
      "Pass qualityTier:'cautionary' to recommend what to AVOID (the corpus's " +
      "cautionary entries are bad examples with critiques of why they fail).",
    inputSchema: {
      productContext: z.string().min(8).describe("What you're building, in natural language (e.g. 'a pricing page for a developer tool with a generous free tier')"),
      count: z.number().min(1).max(5).optional().describe("How many entries to ground the recommendation in (default 3, max 5)"),
      category: Category.optional().describe("Scope the search to a specific UI category"),
      qualityTier: z
        .enum(["exceptional", "cautionary"])
        .optional()
        .describe("Filter to a quality tier. 'exceptional' (default) finds great examples to emulate; 'cautionary' finds bad examples to learn what to AVOID — the synthesis reframes the techniques as pitfalls."),
      platform: z
        .enum(["web", "mobile", "tablet"])
        .optional()
        .describe("Filter to a device class — 'mobile' for phone screenshots, 'web' for desktop. Recommend a direction for a mobile app vs a web app."),
      framework: z.enum(["brief", "tokens"]).optional().describe("Output shape: 'brief' (markdown, default) or 'tokens' (JSON)"),
    },
  },
  async ({ productContext, count, category, qualityTier, platform, framework }) => {
    void logQuery({ query: `recommend_ui_direction:${productContext.slice(0, 80)}`, category, qualityTier, platform }, []);
    const status = indexStatus();
    if (!status.hasIndex) {
      return { content: [{ type: "text", text: "The embedding index hasn't been built. Run `npm run build-index` to enable recommendations." }], isError: true };
    }
    // Over-fetch (limit 20) so the diversity picker has a real pool to choose from;
    // searchEntries would already slice to the final count and starve the picker.
    const results = await searchRanked({ query: productContext, category: category as string | undefined, qualityTier: qualityTier as string | undefined, platform: platform as "web" | "mobile" | "tablet" | undefined, limit: 20 });
    if (!results.length) {
      const scope = qualityTier === "cautionary" ? " cautionary" : "";
      return { content: [{ type: "text", text: `No${scope} corpus entries matched "${productContext}". Try a different description or broader terms.` }] };
    }
    const rec = buildRecommendation(results, { productContext, count, category: category as string | undefined, framework: framework ?? "brief" });
    // Cautionary recommendation: reframe the headline so the agent knows this is
    // "what to avoid," not "what to emulate." The synthesis body still names the
    // techniques, but the framing inverts them to pitfalls.
    const out = qualityTier === "cautionary"
      ? renderRecommendation(rec).replace("# Design recommendation", "# Cautionary recommendation — what to AVOID")
      : renderRecommendation(rec);
    return { content: [{ type: "text", text: out }] };
  },
);

/**
 * Tool: get_anti_patterns
 * Surfaces the "what mistakes to avoid" knowledge — the feature Mobbin can't
 * offer. Aggregates anti-pattern statements across a category, deduped and
 * ranked by consensus. An agent designing a modal can ask "what should I
 * avoid?" and get the consensus mistakes across all modal entries.
 */
server.registerTool(
  "get_anti_patterns",
  {
    title: "Get anti-patterns to avoid for a UI pattern",
    description:
      "Returns the consensus anti-patterns (common UI mistakes to avoid) for a given " +
      "pattern type, aggregated across all matching corpus entries and ranked by how " +
      "many entries raise each one. Each anti-pattern lists its source entries so you " +
      "can trace it back. This is the 'what NOT to do' knowledge that screenshot " +
      "galleries can't offer — use it alongside search_ui_examples when designing a " +
      "specific pattern. Omit patternType to get anti-patterns across the whole corpus.",
    inputSchema: {
      patternType: PatternType.optional().describe("Scope to a UI pattern (e.g. 'modal', 'dashboard'). Omit for corpus-wide."),
      category: Category.optional().describe("Further scope to a category"),
      limit: z.number().min(1).max(20).optional().describe("Max anti-patterns to return (default 10)"),
    },
  },
  async ({ patternType, category, limit }) => {
    const results = aggregateAntiPatterns(loadCorpus(), { patternType: patternType as string | undefined, category: category as string | undefined }, limit ?? 10);
    if (!results.length) {
      const scope = patternType ? ` for patternType '${patternType}'` : "";
      return { content: [{ type: "text", text: `No anti-patterns found${scope}.` }] };
    }
    const lines = [`# Anti-patterns to avoid${patternType ? ` (${patternType})` : ""}\n`];
    results.forEach((r, i) => {
      lines.push(`${i + 1}. **${r.text}**`);
      lines.push(`   _Raised by ${r.count} entr${r.count === 1 ? "y" : "ies"}: ${r.sources.slice(0, 5).map((s) => `\`${s}\``).join(", ")}${r.sources.length > 5 ? `, …+${r.sources.length - 5}` : ""}_\n`);
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

/**
 * Tool: get_color_palette
 * Palette generator from the corpus's colorRoles data. Returns paste-ready
 * token sets grouped by accent hue band, scoped to a pattern/style.
 */
server.registerTool(
  "get_color_palette",
  {
    title: "Get color palettes for a UI pattern or style",
    description:
      "Returns paste-ready color token sets (canvas/surface/ink/muted/accent) from " +
      "corpus entries that have colorRoles, grouped by accent hue band (red, blue, " +
      "green, etc.). Use this when you want real-world palettes for a specific pattern " +
      "('calm palettes for a dashboard') rather than generating from scratch. Each " +
      "palette links back to its source entry. Sorted by accent hue for visual grouping.",
    inputSchema: {
      patternType: PatternType.optional().describe("Scope to a UI pattern"),
      styleTag: StyleTag.optional().describe("Scope to a style (e.g. 'minimal', 'playful')"),
      limit: z.number().min(1).max(20).optional().describe("Max palettes to return (default 10)"),
    },
  },
  async ({ patternType, styleTag, limit }) => {
    const results = collectPalettes(loadCorpus(), { patternType: patternType as string | undefined, styleTag: styleTag as string | undefined }, limit ?? 10);
    if (!results.length) {
      return { content: [{ type: "text", text: "No entries with colorRoles match those filters. Try a broader patternType or styleTag." }] };
    }
    const lines = [`# Color palettes (${results.length})\n`];
    let lastBand = "";
    for (const p of results) {
      const band = hueBand(p.accentHue);
      if (band !== lastBand) { lines.push(`\n## ${band} accents\n`); lastBand = band; }
      lines.push(`**${p.product}** (\`${p.id}\`) — ${p.patternType}`);
      lines.push("```css");
      lines.push(`  --canvas:${p.tokens.canvas}; --surface:${p.tokens.surface}; --ink:${p.tokens.ink}; --muted:${p.tokens.muted ?? "inherit"}; --accent:${p.tokens.accent};`);
      lines.push("```\n");
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

/**
 * Tool: get_stealable_techniques
 * Surfaces the 1600+ stealable techniques, browsed by pattern/style and deduped.
 */
server.registerTool(
  "get_stealable_techniques",
  {
    title: "Get stealable techniques for a UI pattern",
    description:
      "Returns concrete, copyable techniques to borrow from corpus entries, scoped to " +
      "a pattern type and/or style tag. Deduped by theme so you get variety, not " +
      "repeats. Each technique cites its source entry. Use this when you want a " +
      "menu of specific ideas for a pattern ('what can I steal for a dense data " +
      "table?') rather than a synthesized brief (use generate_design_prompt for that).",
    inputSchema: {
      patternType: PatternType.optional().describe("Scope to a UI pattern"),
      styleTag: StyleTag.optional().describe("Scope to a style"),
      limit: z.number().min(1).max(30).optional().describe("Max techniques to return (default 15)"),
    },
  },
  async ({ patternType, styleTag, limit }) => {
    const results = collectTechniques(loadCorpus(), { patternType: patternType as string | undefined, styleTag: styleTag as string | undefined }, limit ?? 15);
    if (!results.length) {
      return { content: [{ type: "text", text: "No techniques found for those filters." }] };
    }
    const lines = [`# Stealable techniques (${results.length})\n`];
    results.forEach((t, i) => {
      lines.push(`${i + 1}. ${t.text}`);
      lines.push(`   _from **${t.source.product}** (\`${t.source.id}\`)_\n`);
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

/**
 * Tool: browse_ui_examples
 * Discovery tool — what's in the corpus, organized by pattern. search_ui_examples
 * needs a query; this lets an agent see what's available before searching.
 */
server.registerTool(
  "browse_ui_examples",
  {
    title: "Browse the corpus by UI pattern",
    description:
      "Summarizes what's in the corpus grouped by patternType — for each pattern, " +
      "the count, top products represented, and the highest-quality exemplar entry. " +
      "Use this to discover what's available before searching (search_ui_examples " +
      "needs a query; this doesn't). Optional styleTag scopes which entries count. " +
      "Pair with get_ui_example on the exemplar id to inspect a strong representative.",
    inputSchema: {
      styleTag: StyleTag.optional().describe("Scope to a style (e.g. 'minimal') to see which patterns have examples in that style"),
    },
  },
  async ({ styleTag }) => {
    const results = browseByPattern(loadCorpus(), { styleTag: styleTag as string | undefined });
    if (!results.length) {
      return { content: [{ type: "text", text: styleTag ? `No entries found with styleTag '${styleTag}'.` : "Corpus is empty." }] };
    }
    const lines = [`# Corpus by pattern (${results.length} patterns represented${styleTag ? `, scoped to '${styleTag}'` : ""})\n`];
    lines.push("| Pattern | Count | Top products | Exemplar |");
    lines.push("| --- | --- | --- | --- |");
    for (const r of results) {
      lines.push(`| ${r.patternType} | ${r.count} | ${r.products.join(", ")} | **${r.exemplar.product}** \`${r.exemplar.id}\` (${r.exemplar.qualityScore}/5) |`);
    }
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("clean-ui-mcp server running on stdio");
}

main().catch((err) => {
  console.error("Fatal error starting clean-ui-mcp:", err);
  process.exit(1);
});
