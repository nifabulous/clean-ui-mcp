#!/usr/bin/env node
import "./env.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { appendFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  searchEntries,
  searchRanked,
  getEntryById,
  listCategories,
  listStyleTags,
  indexStatus,
  findSimilarEntries,
} from "./corpus.js";
import { Category, StyleTag } from "./schema.js";
import { generateBrief, renderBrief } from "./design-prompt.js";
import { buildRecommendation, renderRecommendation } from "./recommend.js";
import { readFileSync, existsSync } from "node:fs";
import { fromCorpusRelativeImagePath } from "./paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUERY_LOG_PATH = resolve(__dirname, "..", "corpus", "query-log.jsonl");

/** Append-only query log for retrieval analytics (query-stats.ts). Never throws. */
async function logQuery(params: { query?: string; category?: string; styleTag?: string; qualityTier?: string }, resultIds: string[]): Promise<void> {
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
      limit: z.number().int().min(1).max(20).optional().describe("Max results, default 5"),
    },
  },
  async ({ query, category, styleTag, minQuality, qualityTier, limit }) => {
    const results = await searchEntries({ query, category, styleTag, minQuality, qualityTier, limit });

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

    const summary = results
      .map((e) => {
        const hasImage = e.image.visibility !== "private" && e.image.path;
        return [
          `### ${e.title}  (id: ${e.id})`,
          `Categories: ${e.categories.join(", ")} | Style: ${e.styleTags.join(", ")}`,
          `Quality: ${e.qualityScore}/5 | Source: ${e.source.productName}${e.source.url ? ` (${e.source.url})` : ""}`,
          `Image available via get_ui_example: ${hasImage ? "yes" : "no (metadata/critique only)"}`,
          ``,
          `Critique: ${e.critique}`,
          ``,
          `What to steal:`,
          ...e.whatToSteal.map((t) => `  - ${t}`),
          e.antiPatterns.antiPatterns.length
            ? `Anti-patterns (mistakes avoided):\n${e.antiPatterns.antiPatterns.map((t) => `  - ${t}`).join("\n")}`
            : "",
        ]
          .filter(Boolean)
          .join("\n");
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
      `# ${entry.title}`,
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
    const drift = status.hasIndex && status.missing > 0 ? ` · ${status.missing} missing${status.stale ? `, ${status.stale} stale` : ""} — run \`npm run build-index\`` : "";
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
      `Entries similar to **${source.title}** (${id}), ranked by semantic similarity:`,
      ``,
      ...results.map((r) => {
        const pct = Math.round(Math.max(0, r.score) * 100);
        return [
          `### ${r.entry.title}  (id: ${r.entry.id}) — ${pct}% similar`,
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

    const header = `| Field | ${found.map((e) => cell(e.title)).join(" | ")} |`;
    const divider = `| --- | ${found.map(() => "---").join(" | ")} |`;
    const rows = [
      `| id | ${found.map((e) => cell(e.id)).join(" | ")} |`,
      `| patternType | ${found.map((e) => e.patternType).join(" | ")} |`,
      `| categories | ${found.map((e) => cell(e.categories.join(", "))).join(" | ")} |`,
      `| styleTags | ${found.map((e) => cell(e.styleTags.join(", "))).join(" | ")} |`,
      `| density / corners | ${found.map((e) => `${e.visual.spacingDensity} / ${e.visual.cornerStyle}`).join(" | ")} |`,
      `| shadows / borders | ${found.map((e) => `${e.visual.usesShadows ? "yes" : "no"} / ${e.visual.usesBorders ? "yes" : "no"}`).join(" | ")} |`,
      `| quality | ${found.map((e) => `${e.qualityScore}/5`).join(" | ")} |`,
      `| critique angle | ${found.map((e) => firstSentence(e.critique)).join(" | ")} |`,
      `| top steal | ${found.map((e) => top(e.whatToSteal)).join(" | ")} |`,
      `| anti-patterns | ${found.map((e) => top(e.antiPatterns.antiPatterns)).join(" | ")} |`,
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
      "entries to look at; use generate_design_prompt when you already have ids.",
    inputSchema: {
      productContext: z.string().min(8).describe("What you're building, in natural language (e.g. 'a pricing page for a developer tool with a generous free tier')"),
      count: z.number().min(1).max(5).optional().describe("How many entries to ground the recommendation in (default 3, max 5)"),
      category: Category.optional().describe("Scope the search to a specific UI category"),
      framework: z.enum(["brief", "tokens"]).optional().describe("Output shape: 'brief' (markdown, default) or 'tokens' (JSON)"),
    },
  },
  async ({ productContext, count, category, framework }) => {
    void logQuery({ query: `recommend_ui_direction:${productContext.slice(0, 80)}`, category }, []);
    const status = indexStatus();
    if (!status.hasIndex) {
      return { content: [{ type: "text", text: "The embedding index hasn't been built. Run `npm run build-index` to enable recommendations." }], isError: true };
    }
    // Over-fetch (limit 20) so the diversity picker has a real pool to choose from;
    // searchEntries would already slice to the final count and starve the picker.
    const results = await searchRanked({ query: productContext, category: category as string | undefined, limit: 20 });
    if (!results.length) {
      return { content: [{ type: "text", text: `No corpus entries matched "${productContext}". Try a different description or broader terms.` }] };
    }
    const rec = buildRecommendation(results, { productContext, count, category: category as string | undefined, framework: framework ?? "brief" });
    return { content: [{ type: "text", text: renderRecommendation(rec) }] };
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
