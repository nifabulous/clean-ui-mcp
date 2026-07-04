/**
 * recommend.ts — the "design advisor" entry point.
 *
 * recommend_ui_direction takes a product description, searches the corpus via
 * the embedding index, and synthesizes a direction citing 3-5 entries. It's the
 * natural partner to generate_design_prompt: instead of the user picking ids,
 * the corpus finds the relevant ones, then generateBrief synthesizes across
 * them. Adds product-diversity selection so the recommendation isn't 3 entries
 * from the same product.
 */
import type { CorpusEntryT } from "./schema.js";
import type { SearchResult } from "./corpus.js";
import { generateBrief, renderBrief, type DesignBrief, type BriefFramework } from "./design-prompt.js";

export interface RecommendInput {
  productContext: string;
  /** How many entries to ground the recommendation in (default 3, max 5). */
  count?: number;
  /** Optional structural filter to scope the search. */
  category?: string;
  framework?: BriefFramework;
}

export interface Recommendation {
  /** The synthesized brief across the selected entries. */
  brief: DesignBrief;
  /** Which entries were selected and why (score + rank). */
  rationale: { id: string; product: string; score: number; rank: number; note: string }[];
  /** The product description the user supplied. */
  productContext: string;
}

/**
 * Pick the top results with product diversity. Walks the ranked list and takes
 * each result unless its product already has `maxPerProduct` entries in the
 * selection — this prevents the recommendation being dominated by the most
 * common product in the corpus (e.g. 91 "Untitled" or 77 Cash App entries).
 */
export function pickDiverse(results: SearchResult[], count: number, maxPerProduct = 2): SearchResult[] {
  // Sort defensively (descending by score) so we don't depend on caller ordering.
  const ranked = [...results].sort((a, b) => b.score - a.score);
  const selected: SearchResult[] = [];
  const perProduct = new Map<string, number>();
  for (const r of ranked) {
    if (selected.length >= count) break;
    const product = r.entry.source.productName;
    const have = perProduct.get(product) ?? 0;
    if (have >= maxPerProduct) continue; // skip — already enough from this product
    selected.push(r);
    perProduct.set(product, have + 1);
  }
  // If diversity was too aggressive (small corpus, few products), backfill from
  // the top of the ranked list regardless of product so we hit `count`.
  if (selected.length < count) {
    const have = new Set(selected.map((s) => s.entry.id));
    for (const r of ranked) {
      if (selected.length >= count) break;
      if (!have.has(r.entry.id)) selected.push(r);
    }
  }
  return selected.slice(0, count);
}

/** One-line note on why an entry was selected, based on its strongest field. */
function contributionNote(entry: CorpusEntryT): string {
  if (entry.visual.colorRoles) return `color palette + ${entry.patternType}`;
  if (entry.voice?.tone) return `voice/copy + ${entry.patternType}`;
  if (entry.layout?.regions?.length) return `layout structure (${entry.layout.form})`;
  if (entry.qualityTier === "cautionary") return `cautionary example — ${entry.patternType} done poorly`;
  return `${entry.patternType} with strong critique`;
}

/**
 * Build a recommendation from a ranked search. Pure — the search itself
 * (embedding the product context) happens in the caller so this stays testable
 * with fixture results.
 */
export function buildRecommendation(results: SearchResult[], input: RecommendInput): Recommendation {
  const count = Math.min(Math.max(input.count ?? 3, 1), 5);
  const selected = pickDiverse(results, count);

  const rationale = selected.map((r, i) => ({
    id: r.entry.id,
    product: r.entry.source.productName,
    score: Number(r.score.toFixed(3)),
    rank: i + 1,
    note: contributionNote(r.entry),
  }));

  const brief = generateBrief(selected.map((s) => s.entry), {
    ids: selected.map((s) => s.entry.id),
    framework: input.framework ?? "brief",
    context: input.productContext,
  });

  return { brief, rationale, productContext: input.productContext };
}

/** Render the recommendation as markdown (rationale + the synthesized brief). */
export function renderRecommendation(rec: Recommendation): string {
  const lines: string[] = [];
  lines.push("# Design recommendation");
  lines.push(`\n*For: ${rec.productContext}*\n`);
  lines.push(`Grounded in ${rec.rationale.length} corpus entries, selected for relevance and product diversity:\n`);
  for (const r of rec.rationale) {
    lines.push(`${r.rank}. **${r.product}** (\`${r.id}\`) — ${r.note} (relevance ${r.score})`);
  }
  lines.push("");
  // The brief is the bulk of the output — append its rendered form.
  lines.push(renderBrief(rec.brief));
  return lines.join("\n");
}
