/**
 * Deterministic public search.
 *
 * The Playground indexes the parsed {@link PublicEntry} corpus with MiniSearch,
 * then layers exact filters (categories, styles, domains, platform) on top of
 * the text score. Equal scores are tie-broken by `id.localeCompare` so that
 * URLs, screenshots, and pagination stay stable across reloads.
 *
 * The search state is also the canonical shareable URL — {@link serializeSearchState}
 * and {@link parseSearchState} are exact inverses.
 */

import MiniSearch from "minisearch";
import type { PublicEntry } from "../data/public-entry";

/** A single search hit. The entry is the parsed public record; the score is MiniSearch's. */
export interface SearchResult {
  readonly id: string;
  readonly score: number;
  readonly entry: PublicEntry;
}

/** Exact-match filters layered on top of MiniSearch text scoring. */
export interface SearchFilters {
  /** Categories the result must include (AND across the array). */
  readonly categories: readonly string[];
  /** Style tags the result must include (AND across the array). */
  readonly styles: readonly string[];
  /** Source hostnames the result must match (AND across the array). */
  readonly domains: readonly string[];
  /** Platform tag (e.g. "web", "ios"); `null` means "no platform filter". */
  readonly platform: string | null;
}

/** Full shareable search state — the query plus the filters. */
export interface SearchState extends SearchFilters {
  readonly query: string;
}

export interface SearchController {
  /** Run a search. Returns results sorted by score desc, ties broken by id asc. */
  search(query: string, filters: SearchFilters): SearchResult[];
  /** Re-index after the corpus is replaced (rare; mostly for tests). */
  reset(entries: readonly PublicEntry[]): void;
}

const SEARCH_FIELDS: readonly string[] = [
  "title",
  "productName",
  "critique",
  "steal",
  "avoid",
  "patternType",
  "categories",
  "styleTags",
];

interface IndexedDocument {
  id: string;
  title: string;
  productName: string;
  critique: string;
  steal: string;
  avoid: string;
  patternType: string;
  categories: string;
  styleTags: string;
}

/** Build the MiniSearch document for one entry. Arrays are space-joined per the v1 convention. */
function toDocument(entry: PublicEntry): IndexedDocument {
  return {
    id: entry.id,
    title: entry.title,
    productName: entry.source.productName,
    critique: entry.critique,
    steal: entry.whatToSteal.join(" "),
    avoid: entry.antiPatterns.join(" "),
    patternType: entry.patternType,
    categories: entry.categories.join(" "),
    styleTags: entry.styleTags.join(" "),
  };
}

function hostnameOf(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname;
  } catch {
    return "";
  }
}

/**
 * Returns true when the entry satisfies every active exact filter. Filter
 * values are case-insensitive compared against the entry's lowercased tags
 * (the corpus already stores slugs in lowercase, but lowercasing both sides
 * keeps the search robust against future editor drift).
 */
function matchesFilters(entry: PublicEntry, filters: SearchFilters): boolean {
  const categories = new Set(entry.categories.map((c) => c.toLowerCase()));
  for (const wanted of filters.categories) {
    if (!categories.has(wanted.toLowerCase())) return false;
  }
  const styles = new Set(entry.styleTags.map((s) => s.toLowerCase()));
  for (const wanted of filters.styles) {
    if (!styles.has(wanted.toLowerCase())) return false;
  }
  if (filters.domains.length > 0) {
    const host = hostnameOf(entry.source.url).toLowerCase();
    if (!host) return false;
    for (const wanted of filters.domains) {
      if (!host.endsWith(wanted.toLowerCase())) return false;
    }
  }
  if (filters.platform !== null) {
    const entryPlatform = typeof entry.platform === "string" ? entry.platform : null;
    if (entryPlatform === null) return false;
    if (entryPlatform.toLowerCase() !== filters.platform.toLowerCase()) return false;
  }
  return true;
}

function buildMiniSearch(entries: readonly PublicEntry[]): MiniSearch<IndexedDocument> {
  const ms = new MiniSearch<IndexedDocument>({
    fields: [...SEARCH_FIELDS],
    storeFields: [],
    idField: "id",
    // Short tokens (e.g. "ux") matter for design vocabulary; the corpus is
    // small enough that prefix search is cheap.
    searchOptions: {
      prefix: true,
      fuzzy: 0.1,
      combineWith: "AND",
    },
  });
  ms.addAll(entries.map(toDocument));
  return ms;
}

/**
 * Create a {@link SearchController} over the given entries. Does not mutate the
 * source array; the index is rebuilt on `reset`.
 */
export function createSearch(entries: readonly PublicEntry[]): SearchController {
  let index = buildMiniSearch(entries);
  let corpus = new Map<string, PublicEntry>(entries.map((e) => [e.id, e]));

  return {
    search(query: string, filters: SearchFilters): SearchResult[] {
      const trimmed = query.trim();
      const candidateIds: Array<{ id: string; score: number }> =
        trimmed.length === 0
          ? Array.from(corpus.values()).map((entry) => ({ id: entry.id, score: 0 }))
          : index.search(trimmed).map((hit) => ({ id: hit.id, score: hit.score }));

      const filtered: SearchResult[] = [];
      for (const { id, score } of candidateIds) {
        const entry = corpus.get(id);
        if (!entry) continue;
        if (!matchesFilters(entry, filters)) continue;
        filtered.push({ id, score, entry });
      }

      // Stable ordering: higher score first, then id.localeCompare for ties.
      filtered.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.id.localeCompare(b.id);
      });

      return filtered;
    },
    reset(next: readonly PublicEntry[]): void {
      corpus = new Map(next.map((e) => [e.id, e]));
      index = buildMiniSearch(next);
    },
  };
}

// ---------------------------------------------------------------------------
// URL serialization
// ---------------------------------------------------------------------------

/** Query-string keys for the canonical shareable URL. */
const PARAM_QUERY = "q";
const PARAM_CATEGORY = "category";
const PARAM_STYLE = "style";
const PARAM_DOMAIN = "domain";
const PARAM_PLATFORM = "platform";

/**
 * Serialize a search state into a canonical query string (no leading `?`).
 * Empty filters are dropped so a clean state serializes to the empty string.
 * Array order is preserved because the resulting URL is user-visible and must
 * be stable; round-tripping through {@link parseSearchState} restores it.
 */
export function serializeSearchState(state: SearchState): string {
  const params = new URLSearchParams();
  if (state.query.trim().length > 0) {
    params.set(PARAM_QUERY, state.query);
  }
  for (const category of state.categories) {
    if (category) params.append(PARAM_CATEGORY, category);
  }
  for (const style of state.styles) {
    if (style) params.append(PARAM_STYLE, style);
  }
  for (const domain of state.domains) {
    if (domain) params.append(PARAM_DOMAIN, domain);
  }
  if (state.platform) {
    params.set(PARAM_PLATFORM, state.platform);
  }
  return params.toString();
}

/** Inverse of {@link serializeSearchState}. Accepts either a URLSearchParams or a raw query string. */
export function parseSearchState(input: URLSearchParams | string): SearchState {
  const params =
    typeof input === "string" ? new URLSearchParams(input) : new URLSearchParams(input);
  const query = params.get(PARAM_QUERY) ?? "";
  // getAll preserves insertion order, which matches what serializeSearchState emits.
  const categories = params.getAll(PARAM_CATEGORY);
  const styles = params.getAll(PARAM_STYLE);
  const domains = params.getAll(PARAM_DOMAIN);
  const platform = params.get(PARAM_PLATFORM);
  return {
    query,
    categories,
    styles,
    domains,
    platform,
  };
}
