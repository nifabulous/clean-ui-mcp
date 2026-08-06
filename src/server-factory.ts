/**
 * server-factory.ts — pure MCP server factory (no side effects on import).
 *
 * Gate 1A, Task 4a (F7). This module exports `createServer(reader)` which
 * constructs an `McpServer`, registers all 14 tools against the injected
 * `CorpusReader`, and returns it. Importing this module does NOT start a
 * server, open stdio, or read any env — that's the job of `server.ts` (the
 * executable entry). Unit + contract tests import THIS module so they can
 * spin up a server in-process without a child process.
 *
 * Behavior-preserving: this is a mechanical extraction of the tool
 * registrations that previously lived at module scope in server.ts. The only
 * change is that every corpus-access call now goes through the injected
 * `reader` instead of the module-level corpus.ts functions:
 *   - searchEntries → reader.search
 *   - searchRanked  → reader.searchRanked
 *   - getEntryById  → reader.getById
 *   - findSimilarEntries → reader.findSimilar
 *   - listCategories/listStyleTags/listDomainTags → reader.list*
 *   - indexStatus   → reader.indexStatus
 *   - loadCorpus() (4 aggregation handlers) → reader.entriesForAggregation()
 *   - fromCorpusRelativeImagePath (get_ui_example) → reader.resolveImagePath
 *
 * Private mode (PrivateCorpusReader) delegates each of these to the same
 * corpus.ts function server.ts called before, so the output is identical.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHash } from "node:crypto";
import { appendFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Category, StyleTag, PatternType, formatAccessibilityRisk, AccessibilityRiskT } from "./schema.js";
import { describeError } from "./errors.js";
import { generateBrief, renderBrief } from "./design-prompt.js";
import { buildRecommendation, renderRecommendation } from "./recommend.js";
import { aggregateAntiPatterns, collectPalettes, collectTechniques, browseByPattern, hueBand } from "./aggregations.js";
import { readFileSync, existsSync } from "node:fs";
import { CRITIQUE_UI_INPUT_SCHEMA, CRITIQUE_UI_OUTPUT_SCHEMA } from "./synthesis/contracts.js";
import { registerCreateUiSpec } from "./create-ui-spec-mcp.js";
import type { CorpusReader } from "./corpus-reader.js";
import { TrustGatedCorpusReader } from "./corpus-trust-reader.js";
import { verifiedFields } from "./corpus-trust.js";
import { projectForServing, renderOmittedDisclosure } from "./serving-projection.js";
import type { CreateUiSpecModelDependency } from "./create-ui-spec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const QUERY_LOG_PATH = resolve(__dirname, "..", "corpus", "query-log.jsonl");

/** Append-only query log for retrieval analytics (query-stats.ts). Never throws. */
async function logQuery(params: { query?: string; category?: string; styleTag?: string; qualityTier?: string; platform?: string }, resultIds: string[]): Promise<void> {
  const entry = JSON.stringify({ ts: new Date().toISOString(), ...params, resultIds });
  appendFile(QUERY_LOG_PATH, entry + "\n").catch(() => {});
}

/**
 * Construct an MCP server with all 14 tools registered against the injected
 * reader. Pure — no stdio, no auto-start, no env reads. The caller (server.ts)
 * is responsible for connecting a transport.
 */
export interface CreateServerOptions {
  readonly createUiSpecModel?: CreateUiSpecModelDependency;
}

// ----- 2d-1 field sets: core (hard-gated) + enrichment (render-if-verified) --
// The SAME constants feed the reader wiring AND the renderers' projection, so
// a tool's declared set can never drift from what its render path projects.
const SEARCH_UI_EXAMPLES_CORE = ["critique"] as const;
const SEARCH_UI_EXAMPLES_ENRICHMENT = ["whatToSteal", "antiPatterns", "categories", "styleTags"] as const;
const GET_UI_EXAMPLE_CORE = ["critique"] as const;
const GET_UI_EXAMPLE_ENRICHMENT = [
  "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks", "voice",
  "visual.dominantColors", "visual.accentColor", "visual.colorRoles",
  "visual.typePairing", "visual.spacingDensity", "visual.cornerStyle",
  "visual.usesShadows", "visual.usesBorders",
] as const;
const GET_SIMILAR_UI_EXAMPLES_CORE = ["critique"] as const;
const GET_SIMILAR_UI_EXAMPLES_ENRICHMENT = ["whatToSteal", "categories", "styleTags", "patternType"] as const;
// Deferred to 2d-2: constructed (fullCurrentSet, []) — byte-for-byte full-AND.
const COMPARE_UI_EXAMPLES_FULL_SET = [
  "critique", "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks",
  "categories", "styleTags", "patternType", "platform", "layout",
  "visual.accentColor", "visual.colorRoles", "visual.spacingDensity",
  "visual.cornerStyle", "visual.usesShadows", "visual.usesBorders",
] as const;
const RECOMMEND_UI_DIRECTION_FULL_SET = [
  "whatToSteal", "antiPatterns", "voice", "visual.colorRoles", "visual.typePairing",
  "visual.spacingDensity", "visual.cornerStyle", "layout", "patternType", "styleTags",
] as const;

export function createServer(
  reader: CorpusReader,
  options: CreateServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "clean-ui-mcp",
    version: "0.1.0",
  });

  // ----- C3 trust gate: every corpus-reading tool -----------------------------
  // A review found the gate held for `create_ui_spec` alone while its siblings
  // served the same fabrications: `get_stealable_techniques` returned an entry's
  // whatToSteal prose verbatim (a left navigation rail described on a 1179x2556
  // portrait phone screenshot) together with `source.product` and `source.id`,
  // the exact identity every other served path withholds; `recommend_ui_direction`
  // and `get_color_palette` invented hexes outright.
  //
  // Gating at the READER rather than in each handler means a tool added later is
  // gated by construction. Day one no entry is verified, so these tools serve
  // nothing corpus-derived — the honest posture, and the one the spec's invariant
  // has claimed all along.
  //
  // `create_ui_spec` keeps the UNGATED reader on purpose: it gates itself
  // (create-ui-spec-deterministic.ts) AND needs the corpus-wide entry list to
  // build the identity screen's denied-name set. Narrowing that set would let an
  // unverified entry's product name stop being screened out of served prose —
  // weakening identity screening in the name of trust.
  // ----- C3 trust gate (Stage 2a): per-tool field sets at wiring time --------
  // Each registration constructs a reader gated on the exact keys of the fields
  // that tool renders — never wider (over-gating) and never narrower
  // (over-serving). The field set is the contract between the verifier (Stage
  // 2b/2c) and the gate, reviewable in one place. `create_ui_spec` keeps the
  // UNGATED reader on purpose: it gates itself (create-ui-spec-deterministic.ts)
  // AND needs the corpus-wide entry list to build the identity screen's
  // denied-name set.
  // `create_ui_spec` keeps the UNGATED reader on purpose: it gates itself
  // (create-ui-spec-deterministic.ts) AND needs the corpus-wide entry list to
  // build the identity screen's denied-name set.
  registerSearchUiExamples(
    server,
    new TrustGatedCorpusReader(reader, SEARCH_UI_EXAMPLES_CORE, SEARCH_UI_EXAMPLES_ENRICHMENT),
  );
  registerGetUiExample(
    server,
    new TrustGatedCorpusReader(reader, GET_UI_EXAMPLE_CORE, GET_UI_EXAMPLE_ENRICHMENT),
  );
  registerListCategories(server, new TrustGatedCorpusReader(reader, ["categories"]));
  registerListStyleTags(server, new TrustGatedCorpusReader(reader, ["styleTags"]));
  registerListDomainTags(server, new TrustGatedCorpusReader(reader, ["domainTags"]));
  registerGetSimilarUiExamples(
    server,
    new TrustGatedCorpusReader(reader, GET_SIMILAR_UI_EXAMPLES_CORE, GET_SIMILAR_UI_EXAMPLES_ENRICHMENT),
  );
  registerCompareUiExamples(
    server,
    new TrustGatedCorpusReader(reader, COMPARE_UI_EXAMPLES_FULL_SET),
  );
  registerCreateUiSpec(server, reader, options.createUiSpecModel);
  registerRecommendUiDirection(
    server,
    new TrustGatedCorpusReader(reader, RECOMMEND_UI_DIRECTION_FULL_SET),
  );
  registerGetAntiPatterns(server, new TrustGatedCorpusReader(reader, ["antiPatterns"]));
  registerGetColorPalette(server, new TrustGatedCorpusReader(reader, ["visual.colorRoles", "patternType"]));
  registerGetStealableTechniques(server, new TrustGatedCorpusReader(reader, ["whatToSteal"]));
  registerBrowseUiExamples(server, new TrustGatedCorpusReader(reader, ["patternType"]));
  registerCritiqueUi(server, new TrustGatedCorpusReader(reader, ["patternType", "platform"]));

  return server;
}

/**
 * The message a corpus-reading tool returns when it has nothing to serve.
 *
 * "No X found for those filters" blames the caller's query. When the real cause
 * is that no entry carries a verification record, that is the same false-reason
 * defect the `create_ui_spec` unavailableDecisions rows had: it sends the caller
 * off to broaden a search that was never the problem. So the message reports the
 * trust posture whenever the reader can state one.
 */
function emptyCorpusMessage(reader: CorpusReader, noun: string): string {
  const gate = reader instanceof TrustGatedCorpusReader ? reader : null;
  const posture = gate === null ? null : gate.trustPosture();
  if (gate !== null && posture !== null && posture.verified < posture.total) {
    return (
      `No ${noun} available: ${posture.verified} of ${posture.total} corpus entries are verified `
      + `for every core field this tool serves (${gate.core.join(", ")}), and corpus content is `
      + `served only from verified entries. This is not a filter problem — broadening the query `
      + `will not change it.`
    );
  }
  return `No ${noun} found for those filters.`;
}

/**
 * The message for ids a corpus tool could not resolve.
 *
 * `getById` answers `undefined` for an entry the trust gate refused, and four
 * tools turned that into "No entry found with id X" about an entry that exists.
 * Withholding an entry is correct; asserting it does not exist is a different
 * claim and an untrue one. So refused ids are reported as refused, and only
 * genuinely absent ids are reported as absent.
 */
function unresolvedIdsMessage(reader: CorpusReader, ids: readonly string[]): string {
  const gate = reader instanceof TrustGatedCorpusReader ? reader : null;
  const refused = gate === null ? [] : ids.filter((id) => gate.refusedForTrust(id));
  const absent = ids.filter((id) => !refused.includes(id));
  const parts: string[] = [];
  if (refused.length > 0 && gate !== null) {
    const posture = gate.trustPosture();
    const one = refused.length === 1;
    parts.push(
      `${one ? "Entry" : "Entries"} ${refused.map((i) => `"${i}"`).join(", ")} `
      + `${one ? "exists" : "exist"} but ${one ? "is" : "are"} not verified for every core field this `
      + `tool serves (${gate.core.join(", ")}), and corpus content is served only from verified `
      + `entries (${posture.verified} of ${posture.total} verified).`,
    );
  }
  if (absent.length > 0) {
    parts.push(`No entry found with id ${absent.map((i) => `"${i}"`).join(", ")}.`);
  }
  return parts.join(" ");
}

/**
 * A disclosure appended to a critique that no corpus entry backed.
 *
 * `critique_ui` is legitimately servable with zero corpus evidence — its findings
 * come from the caller's OWN uploaded screenshot, which is measured, not from
 * corpus prose. But silence about the missing corpus lane reads as "the corpus
 * agreed", so the response says plainly that it did not participate.
 */
function corpusEvidenceNote(reader: CorpusReader, evidenceCount: number): string {
  if (evidenceCount > 0) return "";
  const gate = reader instanceof TrustGatedCorpusReader ? reader : null;
  const posture = gate === null ? null : gate.trustPosture();
  if (posture === null || posture.verified >= posture.total) return "";
  return (
    `\n\n---\n_No corpus evidence backs this critique: ${posture.verified} of ${posture.total} `
    + `corpus entries are verified for every core field this tool serves (${gate!.core.join(", ")}) — `
    + `corpus content is served only from verified entries. Every finding above is grounded in the `
    + `uploaded screenshot alone._`
  );
}

// ─── 1. search_ui_examples ────────────────────────────────────────────────────

function registerSearchUiExamples(server: McpServer, reader: CorpusReader): void {
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
      const results = await reader.search({ query, category, styleTag, minQuality, qualityTier, reviewStatus: reviewStatus as "draft" | "approved" | "any" | undefined, platform: platform as "web" | "mobile" | "tablet" | undefined, limit });

      // Log for retrieval analytics (query-stats.ts) — never blocks the response.
      logQuery({ query, category, styleTag, qualityTier }, results.map((e) => e.id));

      if (results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: emptyCorpusMessage(reader, "matching examples"),
            },
          ],
        };
      }

      const concise = responseFormat === "concise";
      const summary = results
        .map((e) => {
          const projection = projectForServing(e, SEARCH_UI_EXAMPLES_ENRICHMENT);
          const served = (field: string) => projection.served.includes(field);
          const headerParts = [
            served("categories") ? e.categories.join(", ") : "",
            served("styleTags") ? e.styleTags.join(", ") : "",
          ].filter(Boolean).join(" | ");
          const lines: string[] = [];
          if (headerParts) lines.push(`### ${headerParts}`);
          if (concise) {
            lines.push(`Critique: ${e.critique.slice(0, 120)}${e.critique.length > 120 ? "…" : ""}`);
          } else {
            lines.push(
              `Critique: ${e.critique}`,
              ``,
              served("whatToSteal")
                ? ["What to steal:", ...e.whatToSteal.map((t) => `  - ${t}`)].join("\n")
                : "",
              served("antiPatterns") && e.antiPatterns.antiPatterns.length
                ? `Anti-patterns (mistakes avoided):\n${e.antiPatterns.antiPatterns.map((t) => `  - ${t}`).join("\n")}`
                : "",
            );
          }
          lines.push(renderOmittedDisclosure(projection.omitted));
          return lines.filter(Boolean).join("\n");
        })
        .join("\n\n---\n\n");

      return {
        content: [{ type: "text", text: summary }],
      };
    },
  );
}

// ─── 2. get_ui_example ────────────────────────────────────────────────────────

function registerGetUiExample(server: McpServer, reader: CorpusReader): void {
  server.registerTool(
    "get_ui_example",
    {
      title: "Get full detail (and image, if available) for one UI example",
      description:
        "Fetch the complete record for a single UI example by id, including " +
        "full visual attributes (colors, type pairing, spacing) and the source " +
        "image if it is verified against the current file. If no image is " +
        "attached, the response serves the verified record without image bytes.",
      inputSchema: {
        id: z.string().describe("Entry id, e.g. 'linear-issue-board-grouped'"),
      },
    },
    async ({ id }) => {
      const entry = reader.getById(id);
      if (!entry) {
        return {
          content: [{ type: "text", text: unresolvedIdsMessage(reader, [id]) }],
          isError: true,
        };
      }

      const projection = projectForServing(entry, GET_UI_EXAMPLE_ENRICHMENT);
      const served = (field: string) => projection.served.includes(field);
      const visualLines = (): string[] => {
        const lines: string[] = [];
        if (served("visual.dominantColors")) lines.push(`- Dominant colors: ${entry.visual.dominantColors.join(", ")}`);
        if (served("visual.accentColor")) lines.push(`- Accent: ${entry.visual.accentColor ?? "none identified"}`);
        if (served("visual.colorRoles") && entry.visual.colorRoles) {
          const cr = entry.visual.colorRoles;
          lines.push(`- Color roles (paste-ready token set): canvas ${cr.canvas}, surface ${cr.surface}, ink ${cr.ink}${cr.muted ? `, muted ${cr.muted}` : ""}, accent ${cr.accent}`);
        }
        if (served("visual.typePairing") && entry.visual.typePairing) {
          const tp = entry.visual.typePairing;
          lines.push(`- Type pairing: ${tp.display ?? "?"} / ${tp.body ?? "?"}${tp.notes ? ` — ${tp.notes}` : ""}`);
        }
        if (served("visual.spacingDensity")) lines.push(`- Spacing density: ${entry.visual.spacingDensity}`);
        if (served("visual.cornerStyle")) lines.push(`- Corners: ${entry.visual.cornerStyle}`);
        const shadowBorder = [
          served("visual.usesShadows") ? `Shadows: ${entry.visual.usesShadows ? "yes" : "no"}` : "",
          served("visual.usesBorders") ? `Borders: ${entry.visual.usesBorders ? "yes" : "no"}` : "",
        ].filter(Boolean).join(" | ");
        if (shadowBorder) lines.push(`- ${shadowBorder}`);
        return lines.length ? [`## Visual attributes`, ...lines] : [];
      };

      // Output-shape note: sections are folded into single strings and the old
      // trailing blank line is dropped — field-identical, not byte-identical.
      const detail = [
        `## Critique`,
        entry.critique,
        ``,
        served("whatToSteal")
          ? [`## What to steal`, ...entry.whatToSteal.map((t) => `- ${t}`)].join("\n")
          : "",
        served("antiPatterns") && entry.antiPatterns.antiPatterns.length
          ? `## Anti-patterns (mistakes this design avoids)\n${entry.antiPatterns.antiPatterns.map((t) => `- ${t}`).join("\n")}\n`
          : "",
        served("antiPatterns.accessibilityRisks") && entry.antiPatterns.accessibilityRisks.length
          ? `## Accessibility risks\n${entry.antiPatterns.accessibilityRisks.map((r) => `- ${formatAccessibilityRisk(r, { includeEvidence: true })}`).join("\n")}\n`
          : "",
        served("voice") && entry.voice
          ? `## Voice\n- Tone: ${entry.voice.tone}\n${entry.voice.examples.map((e) => `- Example: "${e}"`).join("\n")}${entry.voice.avoid.length ? `\n${entry.voice.avoid.map((a) => `- Avoid: ${a}`).join("\n")}` : ""}\n`
          : "",
        ...visualLines(),
        renderOmittedDisclosure(projection.omitted),
      ]
        .filter(Boolean)
        .join("\n");

      const content: Array<
        | { type: "text"; text: string }
        | { type: "image"; data: string; mimeType: string }
      > = [{ type: "text", text: detail }];

      // Only attach actual image bytes when the entry carries an
      // image-confirmed record covering at least one field in the tool's set
      // whose imageSha256 matches the served file. A `measured` record grounds
      // DOM facts, not pixels — a measured-only entry renders text without
      // bytes, even where visibility would allow them.
      if (entry.image.visibility !== "private" && entry.image.path) {
        const fullPath = reader.resolveImagePath(entry.image.path);
        if (fullPath !== null && existsSync(fullPath)) {
          const bytes = readFileSync(fullPath);
          const data = bytes.toString("base64");
          const sha = createHash("sha256").update(bytes).digest("hex");
          const gate = reader instanceof TrustGatedCorpusReader ? reader : null;
          const imageAttach = gate !== null && [...verifiedFields(entry)].some(
            (field) => (gate.core.includes(field) || gate.enrichment.includes(field))
              && entry.provenance?.verification?.[field]?.method === "image-confirmed"
              && entry.provenance.verification[field].imageSha256 === sha,
          );
          const ext = entry.image.path.split(".").pop()?.toLowerCase();
          const mimeType =
            ext === "png"   ? "image/png"
            : ext === "webp" ? "image/webp"
            : "image/jpeg";
          if (imageAttach) {
            content.push({ type: "image", data, mimeType });
          } else {
            content.push({
              type: "text",
              text: "\n(Image not attached: no image-confirmed verification matching the current file covers a field this tool serves.)",
            });
          }
        } else {
          content.push({ type: "text", text: "\n(Image file not found locally.)" });
        }
      } else {
        content.push({ type: "text", text: "\n(No redistributable image for this entry.)" });
      }

      return { content };
    },
  );
}

// ─── 3. list_categories ───────────────────────────────────────────────────────

function registerListCategories(server: McpServer, reader: CorpusReader): void {
  server.registerTool(
    "list_categories",
    {
      title: "List available UI categories",
      description: "Returns all UI category tags currently present in the corpus, plus the current search mode (vector or keyword).",
      inputSchema: {},
    },
    async () => {
      const status = reader.indexStatus();
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
          text: `Categories: ${reader.listCategories().join(", ")}\n\nSearch mode: ${mode}`,
        }],
      };
    },
  );
}

// ─── 4. list_style_tags ───────────────────────────────────────────────────────

function registerListStyleTags(server: McpServer, reader: CorpusReader): void {
  server.registerTool(
    "list_style_tags",
    {
      title: "List available style tags",
      description: "Returns all style/aesthetic tags currently present in the corpus.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: reader.listStyleTags().join(", ") }],
    }),
  );
}

// ─── 5. list_domain_tags ──────────────────────────────────────────────────────

function registerListDomainTags(server: McpServer, reader: CorpusReader): void {
  server.registerTool(
    "list_domain_tags",
    {
      title: "List available domain tags",
      description: "Returns all business/product domain tags (billing, security, integrations, etc.) currently present in the corpus.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text", text: reader.listDomainTags().join(", ") }],
    }),
  );
}

// ─── 6. get_similar_ui_examples ───────────────────────────────────────────────

function registerGetSimilarUiExamples(server: McpServer, reader: CorpusReader): void {
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
      const source = reader.getById(id);
      if (!source) {
        return { content: [{ type: "text", text: unresolvedIdsMessage(reader, [id]) }], isError: true };
      }

      const results = reader.findSimilar(id, limit ?? 5);
      if (results.length === 0) {
        const status = reader.indexStatus();
        const reason = !status.hasIndex
          ? "the embedding index hasn't been built. Run `npm run build-index` to enable similarity search."
          : status.missing > 0
            ? `the index is out of date — ${status.indexed}/${status.total} entries indexed (${status.missing} missing). Run \`npm run build-index\`.`
            : `this entry (or the others) aren't indexed yet (index covers ${status.indexed}/${status.total}).`;
        return {
          content: [{ type: "text", text: `Can't find similar entries — ${reason}` }],
        };
      }

      const sourceHeader = [source.patternType, source.categories.join(", "), source.styleTags.join(", ")]
        .filter(Boolean)
        .join(" | ");
      const summary = [
        `Entries similar to **${sourceHeader || "corpus example"}**, ranked by semantic similarity:`,
        ``,
        ...results.map((r) => {
          const pct = Math.round(Math.max(0, r.score) * 100);
          const header = [r.entry.patternType, r.entry.categories.join(", "), r.entry.styleTags.join(", ")]
            .filter(Boolean)
            .join(" | ");
          return [
            `### ${header || "corpus example"} — ${pct}% similar`,
            `Critique: ${r.entry.critique}`,
            `What to steal:`,
            ...r.entry.whatToSteal.map((t) => `  - ${t}`),
          ].join("\n");
        }),
      ].join("\n\n---\n\n");

      return { content: [{ type: "text", text: summary }] };
    },
  );
}

// ─── 7. compare_ui_examples ───────────────────────────────────────────────────

function registerCompareUiExamples(server: McpServer, reader: CorpusReader): void {
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
        responseFormat: z.enum(["concise", "detailed"]).optional().describe("Output detail level. 'concise' omits critique angle, steal items, anti-patterns, and a11y rows — lighter for quick comparison. 'detailed' (default) returns all rows."),
      },
    },
    async ({ ids, responseFormat }) => {
      const entries = ids.map((id) => reader.getById(id));
      const missing = ids.filter((_, i) => !entries[i]);
      if (missing.length) {
        return { content: [{ type: "text", text: unresolvedIdsMessage(reader, missing) }], isError: true };
      }
      const found = entries.filter((e): e is NonNullable<typeof e> => !!e);
      const concise = responseFormat === "concise";

      const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const firstSentence = (s: string) => cell(s.split(/[.!?]/)[0] || s);
      const top = (arr: string[]) => cell(arr[0] ?? "—");
      // A11y risks are structured objects with canonical WCAG IDs — format to a string cell.
      const topRisk = (risks: AccessibilityRiskT[]) =>
        cell(risks.length ? formatAccessibilityRisk(risks[0]) : "—");
      const header = `| Field | ${found.map((e) => cell(
        [e.patternType, ...e.categories, ...e.styleTags].filter(Boolean).join(" — ") || "corpus example",
      )).join(" | ")} |`;
      const divider = `| --- | ${found.map(() => "---").join(" | ")} |`;
      const rows = [
        `| categories | ${found.map((e) => cell(e.categories.join(", "))).join(" | ")} |`,
        `| styleTags | ${found.map((e) => cell(e.styleTags.join(", "))).join(" | ")} |`,
        `| platform | ${found.map((e) => (e as Record<string, unknown>).platform ?? "web").join(" | ")} |`,
        `| layout | ${found.map((e) => e.layout?.form ?? "—").join(" | ")} |`,
        `| accent | ${found.map((e) => e.visual.accentColor ?? e.visual.colorRoles?.accent ?? "—").join(" | ")} |`,
        `| density / corners | ${found.map((e) => `${e.visual.spacingDensity} / ${e.visual.cornerStyle}`).join(" | ")} |`,
        `| shadows / borders | ${found.map((e) => `${e.visual.usesShadows ? "yes" : "no"} / ${e.visual.usesBorders ? "yes" : "no"}`).join(" | ")} |`,
        ...(concise ? [] : [
          `| critique angle | ${found.map((e) => firstSentence(e.critique)).join(" | ")} |`,
          `| top steal | ${found.map((e) => top(e.whatToSteal)).join(" | ")} |`,
          `| anti-patterns | ${found.map((e) => top(e.antiPatterns.antiPatterns)).join(" | ")} |`,
          `| a11y risks | ${found.map((e) => topRisk(e.antiPatterns.accessibilityRisks)).join(" | ")} |`,
        ]),
      ];

      return { content: [{ type: "text", text: [header, divider, ...rows].join("\n") }] };
    },
  );
}

// ─── 8. generate_design_prompt — RETAINED, NOT PUBLICLY REGISTERED ────────────
//
// `create_ui_spec` (registered from createServer above) supersedes this tool.
// The registration call was removed from createServer; the function itself is
// kept deliberately, not by oversight:
//   - it is module-private, so it is not a public tool surface and the wiring
//     verification test does not treat it as an export;
//   - `LEGACY_TO_BETA_MAP["generate_design_prompt"]` remains the documented
//     migration row, and this is the behavior that row describes;
//   - the underlying implementation (generateBrief/renderBrief in
//     design-prompt.ts) has other internal callers (recommend.ts) and is
//     unchanged.
// To re-expose it (e.g. behind an operator flag), call it from createServer
// again — do not re-implement it.

function registerGenerateDesignPrompt(server: McpServer, reader: CorpusReader): void {
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
      const entries = ids.map((id) => reader.getById(id));
      const missing = ids.filter((_, i) => !entries[i]);
      if (missing.length) {
        return { content: [{ type: "text", text: `${unresolvedIdsMessage(reader, missing)} Use search_ui_examples to find valid ids.` }], isError: true };
      }
      const found = entries.filter((e): e is NonNullable<typeof e> => !!e);
      const brief = generateBrief(found, { ids, framework: framework ?? "brief", context });
      return { content: [{ type: "text", text: renderBrief(brief) }] };
    },
  );
}

// ─── 9. recommend_ui_direction ────────────────────────────────────────────────

function registerRecommendUiDirection(server: McpServer, reader: CorpusReader): void {
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
        "entries to look at; use create_ui_spec when you want a full evidence-grounded " +
        "spec (layout, tokens, components, acceptance criteria) rather than a direction. " +
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
      const status = reader.indexStatus();
      if (!status.hasIndex) {
        return { content: [{ type: "text", text: "The embedding index hasn't been built. Run `npm run build-index` to enable recommendations." }], isError: true };
      }
      // Over-fetch (limit 20) so the diversity picker has a real pool to choose from;
      // searchEntries would already slice to the final count and starve the picker.
      const results = await reader.searchRanked({ query: productContext, category: category as string | undefined, qualityTier: qualityTier as string | undefined, platform: platform as "web" | "mobile" | "tablet" | undefined, limit: 20 });
      if (!results.length) {
        const scope = qualityTier === "cautionary" ? " cautionary" : "";
        // "Try broader terms" is advice the caller cannot act on when the cause is
        // that nothing is verified, so report the posture instead.
        return { content: [{ type: "text", text: emptyCorpusMessage(reader, `${scope} corpus entries matching "${productContext}"`.trim()) }] };
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
}

// ─── 10. get_anti_patterns ────────────────────────────────────────────────────

function registerGetAntiPatterns(server: McpServer, reader: CorpusReader): void {
  server.registerTool(
    "get_anti_patterns",
    {
      title: "Get anti-patterns to avoid for a UI pattern",
      description:
        "Returns the consensus anti-patterns (common UI mistakes to avoid) for a given " +
        "pattern type, aggregated across all matching corpus entries and ranked by how " +
        "many entries raise each one. This is the 'what NOT to do' knowledge that " +
        "screenshot galleries can't offer — use it alongside search_ui_examples when " +
        "designing a specific pattern. Omit patternType to get anti-patterns across the " +
        "whole corpus.",
      inputSchema: {
        patternType: PatternType.optional().describe("Scope to a UI pattern (e.g. 'modal', 'dashboard'). Omit for corpus-wide."),
        category: Category.optional().describe("Further scope to a category"),
        limit: z.number().min(1).max(20).optional().describe("Max anti-patterns to return (default 10)"),
      },
    },
    async ({ patternType, category, limit }) => {
      const results = aggregateAntiPatterns([...reader.entriesForAggregation()], { patternType: patternType as string | undefined, category: category as string | undefined }, limit ?? 10);
      if (!results.length) {
        const scope = patternType ? ` for patternType '${patternType}'` : "";
        return { content: [{ type: "text", text: emptyCorpusMessage(reader, `anti-patterns${scope}`) }] };
      }
      const lines = [`# Anti-patterns to avoid${patternType ? ` (${patternType})` : ""}\n`];
      results.forEach((r, i) => {
        lines.push(`${i + 1}. **${r.text}**`);
        lines.push(`   _Raised by ${r.count} entr${r.count === 1 ? "y" : "ies"}._\n`);
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}

// ─── 11. get_color_palette ────────────────────────────────────────────────────

function registerGetColorPalette(server: McpServer, reader: CorpusReader): void {
  server.registerTool(
    "get_color_palette",
    {
      title: "Get color palettes for a UI pattern or style",
      description:
        "Returns paste-ready color token sets (canvas/surface/ink/muted/accent) from " +
        "corpus entries that have colorRoles, grouped by accent hue band (red, blue, " +
        "green, etc.). Use this when you want real-world palettes for a specific pattern " +
        "('calm palettes for a dashboard') rather than generating from scratch. Sorted by " +
        "accent hue for visual grouping.",
      inputSchema: {
        patternType: PatternType.optional().describe("Scope to a UI pattern"),
        styleTag: StyleTag.optional().describe("Scope to a style (e.g. 'minimal', 'playful')"),
        limit: z.number().min(1).max(20).optional().describe("Max palettes to return (default 10)"),
      },
    },
    async ({ patternType, styleTag, limit }) => {
      const results = collectPalettes([...reader.entriesForAggregation()], { patternType: patternType as string | undefined, styleTag: styleTag as string | undefined }, limit ?? 10);
      if (!results.length) {
        return { content: [{ type: "text", text: emptyCorpusMessage(reader, "palettes") }] };
      }
      const lines = [`# Color palettes (${results.length})\n`];
      let lastBand = "";
      for (const p of results) {
        const band = hueBand(p.accentHue);
        if (band !== lastBand) { lines.push(`\n## ${band} accents\n`); lastBand = band; }
        lines.push(`**${p.patternType}**`);
        lines.push("```css");
        lines.push(`  --canvas:${p.tokens.canvas}; --surface:${p.tokens.surface}; --ink:${p.tokens.ink}; --muted:${p.tokens.muted ?? "inherit"}; --accent:${p.tokens.accent};`);
        lines.push("```\n");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}

// ─── 12. get_stealable_techniques ─────────────────────────────────────────────

function registerGetStealableTechniques(server: McpServer, reader: CorpusReader): void {
  server.registerTool(
    "get_stealable_techniques",
    {
      title: "Get stealable techniques for a UI pattern",
      description:
        "Returns concrete, copyable techniques to borrow from corpus entries, scoped to " +
        "a pattern type and/or style tag. Deduped by theme so you get variety, not " +
        "repeats. Use this when you want a menu of specific ideas for a pattern " +
        "('what can I steal for a dense data table?') rather than a synthesized spec " +
        "(use create_ui_spec for that).",
      inputSchema: {
        patternType: PatternType.optional().describe("Scope to a UI pattern"),
        styleTag: StyleTag.optional().describe("Scope to a style"),
        limit: z.number().min(1).max(30).optional().describe("Max techniques to return (default 15)"),
      },
    },
    async ({ patternType, styleTag, limit }) => {
      const results = collectTechniques([...reader.entriesForAggregation()], { patternType: patternType as string | undefined, styleTag: styleTag as string | undefined }, limit ?? 15);
      if (!results.length) {
        return { content: [{ type: "text", text: emptyCorpusMessage(reader, "techniques") }] };
      }
      // Served WITHOUT the source product name or entry id.
      //
      // Scoped claim: this is the surface C3 built an identity screen for — the
      // JUDGMENT surface, where prose is presented as advice to copy. Its
      // create_ui_spec equivalent (techniques[].text) is screened and cites only a
      // response-scoped evidence id. The retrieval tools (search_ui_examples,
      // get_ui_example, browse_ui_examples) DO print names and ids by design, and
      // that is a different contract: they answer "what is in the corpus", where
      // the identifier is the useful part of the answer. Advice does not need one.
      const lines = [`# Stealable techniques (${results.length})\n`];
      results.forEach((t, i) => {
        lines.push(`${i + 1}. ${t.text}\n`);
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}

// ─── 13. browse_ui_examples ───────────────────────────────────────────────────

function registerBrowseUiExamples(server: McpServer, reader: CorpusReader): void {
  server.registerTool(
    "browse_ui_examples",
    {
      title: "Browse the corpus by UI pattern",
      description:
        "Summarizes what's in the corpus grouped by patternType — for each pattern, " +
        "the count of matching entries. Use this to discover what's available before " +
        "searching (search_ui_examples needs a query; this doesn't). Optional styleTag " +
        "scopes which entries count.",
      inputSchema: {
        styleTag: StyleTag.optional().describe("Scope to a style (e.g. 'minimal') to see which patterns have examples in that style"),
      },
    },
    async ({ styleTag }) => {
      const results = browseByPattern([...reader.entriesForAggregation()], { styleTag: styleTag as string | undefined });
      if (!results.length) {
        return { content: [{ type: "text", text: emptyCorpusMessage(reader, styleTag ? `entries with styleTag '${styleTag}'` : "entries") }] };
      }
      const lines = [`# Corpus by pattern (${results.length} patterns represented${styleTag ? `, scoped to '${styleTag}'` : ""})\n`];
      lines.push("| Pattern | Count |");
      lines.push("| --- | --- |");
      for (const r of results) {
        lines.push(`| ${r.patternType} | ${r.count} |`);
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  );
}

// ─── 14. critique_ui ──────────────────────────────────────────────────────────

function registerCritiqueUi(server: McpServer, reader: CorpusReader): void {
  server.registerTool(
    "critique_ui",
    {
      title: "Critique a UI screenshot",
      description:
        "Upload a UI screenshot and receive a grounded critique with cited " +
        "recommendations. The tool extracts structured facts via the vision " +
        "tagger, retrieves similar approved corpus examples, and synthesizes " +
        "an observation-grounded critique. Every recommendation cites screenshot " +
        "facts or corpus evidence IDs. Falls back to structured-only retrieval " +
        "when image embeddings are unavailable. Image input is bounded base64 " +
        "(max 10 MiB) — no paths or URLs accepted. No corpus mutation occurs.",
      inputSchema: CRITIQUE_UI_INPUT_SCHEMA,
      outputSchema: CRITIQUE_UI_OUTPUT_SCHEMA,
    },
    async (args) => {
      const t0 = Date.now();
      try {
        // ── Validate input ──────────────────────────────────────────────────────
        const { validateCritiqueUiInput, withValidatedImageFile, toNormalizedTaggerFacts } = await import("./critique-ui.js");
        const validation = validateCritiqueUiInput({
          image: { data: args.image_data, mimeType: args.image_mime_type },
          productContext: args.product_context,
          platform: args.platform,
        });
        if (!validation.valid) {
          return { content: [{ type: "text", text: `❌ Invalid input: ${validation.error}` }], isError: true };
        }
        const input = validation.input;

        // ── Extract facts via the two-pass tagger (extraction only) ──────────────
        const { tagImage } = await import("./tagger.js");
        const tagged = await withValidatedImageFile(input, async (imagePath) => {
          return tagImage({
            imagePath,
            productName: input.productContext ?? "Screenshot",
            url: null,
            imageDetail: "low",
            extractionOnly: true,
            // The upload lives in the OS temp dir, not the corpus. It is
            // transient and never persisted, so the corpus-residency guard is
            // bypassed with a synthetic images-private/ output path.
            allowExternalImagePath: true,
          });
        });

        const extraction = toNormalizedTaggerFacts(tagged);
        const detectedPlatform = input.platform ?? tagged.platform ?? "web";

        // ── Retrieve evidence ─────────────────────────────────────────────────────
        // F2 (Gate 1A): the image-embedding INDEX (the corpus's vectors) MUST come
        // from the injected reader, NOT from a direct loadImageIndex import. The
        // reader is the single authority on what corpus data is visible:
        //   - PrivateCorpusReader loads the global index (current behavior).
        //   - PublicCorpusReader returns null → critique_ui degrades to the
        //     structured-retrieval fallback (critique-retrieval.ts:~121).
        // The previous code imported loadImageIndex unconditionally and loaded the
        // GLOBAL index even in public mode — a direct leak of the private corpus's
        // vectors + entry counts. The imageProvider (input-screenshot embedder) is
        // NOT corpus data and is fine to create in both modes.
        const { retrieveCritiqueEvidence } = await import("./critique-retrieval.js");
        const { createImageEmbeddingProvider } = await import("./image-embeddings.js");

        const imageProvider = createImageEmbeddingProvider();
        const imageIndex = imageProvider
          ? await reader.getImageIndex(imageProvider.model)
          : null;

        const retrieval = await retrieveCritiqueEvidence({
          reader,
          imageProvider,
          imageData: Buffer.from(input.image.data, "base64"),
          imageMimeType: input.image.mimeType,
          extraction,
          productContext: input.productContext,
          platform: detectedPlatform,
          imageIndex,
        });

        // ── Synthesize critique ───────────────────────────────────────────────────
        const { synthesizeCritique, gateCritique } = await import("./critique-synthesis.js");
        const { buildSynthesisContext } = await import("./synthesis/context.js");
        type BuildContextInput = import("./synthesis/context.js").BuildContextInput;
        const { renderCritiqueMarkdown } = await import("./synthesis/render.js");
        const { buildStructuredCritique } = await import("./synthesis/structured-output.js");
        // Screenshot-only calls have no DOM source. This only uses signals injected
        // by trusted internal capture callers, never inferred from pixels.
        const domSignals = extraction.domSignals as { motion?: { signals?: NonNullable<BuildContextInput["motion"]> } | null } | undefined;
        const motionSignals = domSignals?.motion?.signals ?? null;
        const context = buildSynthesisContext({
          extraction, retrieval,
          productContext: input.productContext,
          motion: motionSignals,
        });

        const draft = await synthesizeCritique(context, {
          productContext: input.productContext,
          platform: detectedPlatform,
        });

        const gated = gateCritique(draft, context.evidenceIds, context.guidance.map((guide) => guide.id));

        // ── Build structured critique output ──────────────────────────────────────
        // Task 10: MD3 resemblance classification — only when framework:"md3" is requested
        const md3Classification = args.framework === "md3"
          ? (await import("./md3-classifier.js")).classifyMd3Resemblance({
              dominantColors: Array.isArray(extraction.dominantColors) ? extraction.dominantColors as string[] : undefined,
              accentColor: (extraction.accentColor as string | null | undefined) ?? null,
              typePairing: extraction.typePairing as { display?: string | null; body?: string | null; notes?: string } | null,
              components: Array.isArray(extraction.components) ? extraction.components as string[] : undefined,
              cornerStyle: extraction.cornerStyle as string | null | undefined,
              usesShadows: extraction.usesShadows as boolean | null | undefined,
              usesBorders: extraction.usesBorders as boolean | null | undefined,
              spacingDensity: extraction.spacingDensity as string | null | undefined,
            })
          : undefined;

        const structuredResult = buildStructuredCritique({
          platform: detectedPlatform,
          retrieval,
          gated,
          evidenceIds: context.evidenceIds,
          guidance: context.guidance,
          md3: md3Classification,
        });

        // ── Return both legacy text + structuredContent ───────────────────────────
        return {
          content: [{ type: "text" as const, text: renderCritiqueMarkdown(structuredResult) + corpusEvidenceNote(reader, retrieval.entries.length) }],
          structuredContent: structuredResult,
        };
      } catch (e) {
        // SECURITY: never echo `e.message` — critique runs the tagger, which
        // reads the image file and calls a vision provider, so the error can
        // embed an absolute PATH or a raw provider body. Surface only a safe
        // descriptor (name + errno code).
        return { content: [{ type: "text", text: `❌ Critique failed: ${describeError(e)}` }], isError: true };
      }
    },
  );
}
