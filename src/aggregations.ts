/**
 * aggregations.ts — multi-entry aggregation tools.
 *
 * Four pure functions that surface corpus-wide data the single-entry tools
 * can't: anti-patterns across a category, palettes grouped by hue, stealable
 * techniques deduped by theme, and browse-by-pattern discovery. All operate on
 * an injected entry list (testable with fixtures; the MCP tools pass the real
 * corpus). No I/O, no LLM calls.
 */
import type { CorpusEntryT } from "./schema.js";

// ─── shared filter helper ────────────────────────────────────────────────────

export interface FilterOpts {
  patternType?: string;
  category?: string;
  styleTag?: string;
}

function filterEntries(entries: CorpusEntryT[], opts: FilterOpts): CorpusEntryT[] {
  return entries.filter((e) => {
    if (opts.patternType && e.patternType !== opts.patternType) return false;
    if (opts.category && !e.categories.includes(opts.category as never)) return false;
    if (opts.styleTag && !e.styleTags.includes(opts.styleTag as never)) return false;
    return true;
  });
}

// ─── 1. anti-patterns ────────────────────────────────────────────────────────

export interface AntiPatternResult {
  text: string;
  sources: string[]; // entry ids that raised this pattern
  count: number;
}

/**
 * Aggregate anti-patterns across a category, deduped by first 50 chars (so
 * "Avoid heavy shadows for depth; use color steps" and "Avoid heavy shadows
 * for depth — prefer flat surfaces" collapse into one consensus pattern).
 * Ranked by consensus count — the patterns raised by the most entries first.
 */
export function aggregateAntiPatterns(entries: CorpusEntryT[], opts: FilterOpts, limit = 10): AntiPatternResult[] {
  const filtered = filterEntries(entries, opts);
  const key = (s: string) => s.toLowerCase().slice(0, 50);
  const buckets = new Map<string, { text: string; sources: string[] }>();
  for (const e of filtered) {
    for (const ap of e.antiPatterns.antiPatterns) {
      const k = key(ap);
      const existing = buckets.get(k);
      if (existing) {
        if (!existing.sources.includes(e.id)) existing.sources.push(e.id);
      } else {
        buckets.set(k, { text: ap, sources: [e.id] });
      }
    }
  }
  return [...buckets.values()]
    .map((b) => ({ text: b.text, sources: b.sources, count: b.sources.length }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

// ─── 2. color palettes ───────────────────────────────────────────────────────

export interface PaletteResult {
  id: string;
  product: string;
  patternType: string;
  tokens: { canvas: string; surface: string; ink: string; muted: string | null; accent: string };
  accentHue: number; // 0-360, for grouping (e.g. "blues" = 200-240)
}

/** Convert a hex color to an HSL hue (0-360) for palette grouping. */
function hexToHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0; // achromatic
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return Math.round(h * 360);
}

/** Human-readable hue band name for grouping. */
export function hueBand(hue: number): string {
  if (hue < 15 || hue >= 345) return "red";
  if (hue < 45) return "orange";
  if (hue < 70) return "yellow";
  if (hue < 160) return "green";
  if (hue < 200) return "teal";
  if (hue < 250) return "blue";
  if (hue < 290) return "purple";
  if (hue < 345) return "pink";
  return "red";
}

/**
 * Collect palettes (colorRoles) across a category, tagged with accent hue band
 * so the caller can group by "give me calm blue palettes." Filters to entries
 * that actually have colorRoles. Sorted by accent hue for visual grouping.
 */
export function collectPalettes(entries: CorpusEntryT[], opts: FilterOpts, limit = 10): PaletteResult[] {
  const filtered = filterEntries(entries, opts).filter((e) => e.visual.colorRoles);
  return filtered
    .map((e) => {
      const cr = e.visual.colorRoles!;
      return {
        id: e.id,
        product: e.source.productName,
        patternType: e.patternType,
        tokens: { canvas: cr.canvas, surface: cr.surface, ink: cr.ink, muted: cr.muted, accent: cr.accent },
        accentHue: hexToHue(cr.accent),
      };
    })
    .sort((a, b) => a.accentHue - b.accentHue)
    .slice(0, limit);
}

// ─── 3. stealable techniques ─────────────────────────────────────────────────

export interface TechniqueResult {
  text: string;
  source: { id: string; product: string };
}

/**
 * Collect stealable techniques across a category, deduped by first 50 chars.
 * Unlike anti-patterns (which find consensus), techniques aim for variety —
 * we keep the full deduped list, not just the most common, because each
 * technique is a distinct actionable idea.
 */
export function collectTechniques(entries: CorpusEntryT[], opts: FilterOpts, limit = 15): TechniqueResult[] {
  const filtered = filterEntries(entries, opts);
  const key = (s: string) => s.toLowerCase().slice(0, 50);
  const seen = new Set<string>();
  const out: TechniqueResult[] = [];
  for (const e of filtered) {
    for (const t of e.whatToSteal) {
      const k = key(t);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ text: t, source: { id: e.id, product: e.source.productName } });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// ─── 4. browse by pattern ────────────────────────────────────────────────────

export interface BrowseResult {
  patternType: string;
  count: number;
  products: string[]; // distinct products represented, top 3
  exemplar: { id: string; product: string; title: string; qualityScore: number }; // highest-scored entry
}

/**
 * Summarize what's in the corpus grouped by patternType. For each pattern with
 * enough density (≥1 entry), report count, top products, and the exemplar
 * (highest-quality entry). Optional styleTag filter scopes which entries count.
 */
export function browseByPattern(entries: CorpusEntryT[], opts: { styleTag?: string } = {}): BrowseResult[] {
  const filtered = opts.styleTag ? entries.filter((e) => e.styleTags.includes(opts.styleTag as never)) : entries;
  const byPattern = new Map<string, CorpusEntryT[]>();
  for (const e of filtered) {
    const arr = byPattern.get(e.patternType) ?? [];
    arr.push(e);
    byPattern.set(e.patternType, arr);
  }
  return [...byPattern.entries()]
    .map(([patternType, group]) => {
      const productCounts = new Map<string, number>();
      for (const e of group) productCounts.set(e.source.productName, (productCounts.get(e.source.productName) ?? 0) + 1);
      const products = [...productCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([p]) => p);
      const exemplar = [...group].sort((a, b) => b.qualityScore - a.qualityScore)[0];
      return {
        patternType,
        count: group.length,
        products,
        exemplar: { id: exemplar.id, product: exemplar.source.productName, title: exemplar.title, qualityScore: exemplar.qualityScore },
      };
    })
    .sort((a, b) => b.count - a.count);
}
