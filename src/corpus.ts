import { statSync } from "node:fs";
import { type CorpusEntryT } from "./schema.js";
import { loadIndex, embedQuery, cosine, entryToDocument, hashForDocument, indexExists, voyageRerank } from "./embeddings.js";
import { loadCorpusSafe, entriesPath } from "./persistence.js";

let cached: CorpusEntryT[] | null = null;
// mtime (in ms) of entries.json at the time `cached` was populated. Used to
// detect external edits (curator save, CLI tool, restore) so a long-running
// process — the MCP server — re-reads instead of serving stale entries forever.
let cachedMtimeMs: number | null = null;
// File size of entries.json at the time `cached` was populated. Paired with
// cachedMtimeMs as a two-part cache key so a restore-corpus that sets an OLDER
// mtime (or two saves in the same mtime tick) still invalidates the cache —
// the bytes differ, so the size differs.
let cachedSize: number | null = null;
// True ONLY when a fixture array was injected via setCorpusForTesting. Fixture
// overrides must never be invalidated by the real corpus's mtime — that would
// make fixture-based tests flaky depending on whether entries.json happens to
// exist on disk on the dev machine running them.
let testOverride = false;

/**
 * Stat entries.json's mtime. Returns null when the file can't be stat'd
 * (missing/unreadable); in that case the cache can't be validated against a
 * concrete mtime and the load below falls through to loadCorpusSafe, whose
 * own fallback chain decides what to serve.
 *
 * Uses the test-overridable `entriesPath()` accessor (NOT the ENTRIES_PATH
 * module-load constant) so setCorpusRootForTesting redirects this stat too.
 *
 * Cache key is mtimeMs + size, not mtimeMs alone: a `restore-corpus` that
 * copies an older file can set an mtime older than the cached one (stale
 * cache served indefinitely under mtime-only equality), and two saves in the
 * same mtime tick have the same mtimeMs. Size disambiguates both — a restored
 * older file differs in size, and a same-tick second save changes the bytes.
 */
function entriesCacheKey(): { mtimeMs: number; size: number } | null {
  try { const s = statSync(entriesPath()); return { mtimeMs: s.mtimeMs, size: s.size }; } catch { return null; }
}

/**
 * Load + validate the corpus via the hardened persistence path (loadCorpusSafe),
 * with an mtime-based cache. This consolidation (Gate 1A) means the MCP server —
 * every tool here calls loadCorpus — gets the SAME safety property as the
 * curator UI: missing/corrupt files fall back read-only to snapshot/seed rather
 * than silently rewriting the primary, and an unsupported-newer version fails
 * visibly instead of being masked as a parse error.
 *
 * Caching: the result is memoized per process, BUT the memo is invalidated when
 * entries.json's mtime advances. This fixes the bug where a long-running MCP
 * server never saw curator/CLI edits — the cache used to live forever. A single
 * stat() per call is negligible compared to the JSON parse it avoids on a hit.
 *
 * Fixture overrides (setCorpusForTesting with a non-null array) bypass the disk
 * entirely and are never invalidated by mtime — tests that inject fixtures need
 * stability, not disk re-reads.
 */
export function loadCorpus(): CorpusEntryT[] {
  // Fixture override: never invalidated by disk mtimes. This keeps the existing
  // fixture-based test suite stable regardless of whether the dev machine has
  // a real corpus/entries.json on disk.
  if (testOverride && cached) return cached;
  const key = entriesCacheKey();
  if (cached && key !== null && key.mtimeMs === cachedMtimeMs && key.size === cachedSize) return cached;
  cached = loadCorpusSafe().entries;
  cachedMtimeMs = key?.mtimeMs ?? null;
  cachedSize = key?.size ?? null;
  return cached;
}

/**
 * Test-only injection point. Overrides the corpus cache so tests can exercise
 * getEntryById/listCategories/etc. against fixtures instead of the mutable
 * production entries.json. Never call this from production code.
 *
 * Passing a non-null array enables `testOverride` — subsequent loadCorpus()
 * calls return the fixture array without re-reading disk or checking mtimes,
 * so fixture-based tests stay deterministic even when a real entries.json
 * exists on disk. Passing null clears the override and returns to disk-backed
 * loading (used by the cache-invalidation test, which writes to a tmp dir).
 */
export function setCorpusForTesting(entries: CorpusEntryT[] | null): void {
  cached = entries;
  cachedMtimeMs = null;
  cachedSize = null;
  testOverride = entries !== null;
}

export interface SearchOptions {
  query?:        string;
  category?:     string;
  styleTag?:     string;
  minQuality?:   number;
  qualityTier?:  string;
  platform?:     "web" | "mobile" | "tablet";
  /** "approved" (default) hides drafts; "draft" surfaces only drafts; "any" shows both. */
  reviewStatus?: "draft" | "approved" | "any";
  limit?:        number;
  /** Opt-in rerank via Voyage rerank-2.5 cross-encoder. Default: off. */
  rerank?:       boolean;
}

export interface SearchResult {
  entry:       CorpusEntryT;
  score:       number;
  searchMode:  "vector" | "keyword" | "hybrid";
}

// ─── structural filter (shared by searchRanked + PublicCorpusReader) ──────────

/**
 * Apply the structural filters (category/styleTag/minQuality/qualityTier/
 * platform/reviewStatus) to an entries array. Shared between `searchRanked`
 * (private reader, live corpus) and `PublicCorpusReader.structurallyFiltered`
 * (public reader, snapshot entries) so the two paths cannot drift. Takes the
 * entries as a parameter — never touches the global cache.
 */
export function applyStructuralFilters(entries: readonly CorpusEntryT[], opts: SearchOptions): CorpusEntryT[] {
  return entries.filter((e) => {
    if (opts.category    && !e.categories.includes(opts.category as never))  return false;
    if (opts.styleTag    && !e.styleTags.includes(opts.styleTag as never))   return false;
    if (opts.minQuality  && e.qualityScore < opts.minQuality)                return false;
    if (opts.qualityTier && e.qualityTier !== opts.qualityTier)              return false;
    if (opts.platform    && e.platform !== opts.platform)                    return false;
    // Workflow state: hide drafts unless the caller explicitly asks for them.
    // "approved" (default/omitted) → only approved; "draft" → only drafts;
    // "any" → both. This prevents half-finished entries from leaking into
    // retrieval results.
    const statusFilter = opts.reviewStatus ?? "approved";
    if (statusFilter === "approved" && e.reviewStatus === "draft") return false;
    if (statusFilter === "draft" && e.reviewStatus !== "draft") return false;
    return true;
  });
}

// ─── keyword search (fallback when no index exists) ───────────────────────────

/**
 * Keyword-only scorer. Self-contained: takes the entries array as an argument
 * and never touches the global corpus cache or the embedding index, so it can
 * be reused by readers that operate on a different data source (the public
 * snapshot reader — Task 4b — calls this directly against the snapshot's
 * entries to provide keyword search with NO access to the private embedding
 * index, which would otherwise leak private entry counts + similarity scores).
 *
 * Behavior: structural filters (category/styleTag/minQuality/qualityTier/
 * platform/reviewStatus) are applied by the CALLER before passing `entries`;
 * this function only scores the query against the already-filtered set.
 */
export function keywordSearch(entries: CorpusEntryT[], opts: SearchOptions): SearchResult[] {
  const q = opts.query?.toLowerCase().trim();
  const terms = q
    ? q.split(/[^a-z0-9#]+/).map((t) => t.trim()).filter((t) => t.length >= 2)
    : [];

  return entries
    .map((e) => {
      let score = e.qualityScore;
      if (q) {
        const title = e.title.toLowerCase();
        const categories = e.categories.join(" ").toLowerCase();
        const styleTags = e.styleTags.join(" ").toLowerCase();
        const components = (e.components ?? []).join(" ").toLowerCase();
        const domainTags = (e.domainTags ?? []).join(" ").toLowerCase();
        const extraAttrs = [
          e.colorScheme, e.industryVertical, e.responsiveBehavior, e.mood,
        ].filter(Boolean).join(" ").toLowerCase();
        const visual = [
          ...e.visual.dominantColors,
          e.visual.accentColor,
          e.visual.spacingDensity,
          e.visual.cornerStyle,
          e.visual.typePairing.display,
          e.visual.typePairing.body,
          e.visual.typePairing.notes,
        ].filter(Boolean).join(" ").toLowerCase();
        const body = [
          e.patternType,
          e.critique,
          ...e.whatToSteal,
          ...e.antiPatterns.antiPatterns,
          ...e.antiPatterns.whereThisFails,
          e.businessRationale?.businessGoal,
          e.businessRationale?.targetUser,
          e.businessRationale?.rationale,
          e.source.productName,
        ].join(" ").toLowerCase();
        const haystack = `${title} ${categories} ${styleTags} ${components} ${domainTags} ${extraAttrs} ${visual} ${body}`;

        let matched = false;
        if (haystack.includes(q)) {
          score += 4;
          matched = true;
        }

        for (const term of terms) {
          if (title.includes(term)) {
            score += 3;
            matched = true;
          }
          if (categories.includes(term)) {
            score += 2.5;
            matched = true;
          }
          if (styleTags.includes(term)) {
            score += 2.5;
            matched = true;
          }
          if (components.includes(term)) {
            score += 2.25;
            matched = true;
          }
          if (domainTags.includes(term)) {
            score += 2.5;
            matched = true;
          }
          if (extraAttrs.includes(term)) {
            score += 2;
            matched = true;
          }
          if (visual.includes(term)) {
            score += 1.5;
            matched = true;
          }
          if (body.includes(term)) {
            score += 1;
            matched = true;
          }
        }

        if (!matched) return { entry: e, score: -1, searchMode: "keyword" as const };
      }
      return { entry: e, score, searchMode: "keyword" as const };
    })
    .filter((r) => r.score >= 0);
}

// ─── vector search (when index present) ──────────────────────────────────────

async function vectorSearch(
  entries: CorpusEntryT[],
  query: string,
  opts: SearchOptions,
): Promise<SearchResult[]> {
  const index = loadIndex();

  // If index is missing or stale, fall back gracefully
  if (!index) return keywordSearch(entries, opts);

  const queryVec = await embedQuery(query);

  return entries.map((e) => {
    const docVec = index.entries[e.id]?.vector;
    if (!docVec) {
      // Entry not yet indexed — reuse the keyword scorer so multi-token queries
      // still surface it. Previously this did doc.includes(q) (whole-query
      // substring), which dropped unindexed entries from any multi-word query.
      return keywordSearch([e], { query, ...opts })[0]
        ?? { entry: e, score: 0, searchMode: "keyword" as const };
    }
    // Cosine similarity in [-1, 1]; scale to [0, 2] then weight by quality
    const similarity = cosine(queryVec, docVec);        // raw semantic match
    const score      = similarity * 10 + e.qualityScore * 0.5; // quality as mild tiebreaker
    return { entry: e, score, searchMode: "vector" as const };
  });
}

// ─── hybrid fusion ────────────────────────────────────────────────────────────

/**
 * Normalize scores within a path to [0,1] via min-max scaling.
 * If all scores are equal, returns 0.5 for each (neutral).
 */
function normalizeScores(results: SearchResult[]): SearchResult[] {
  if (!results.length) return results;
  const scores = results.map((r) => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;
  if (range === 0) return results.map((r) => ({ ...r, score: 0.5 }));
  return results.map((r) => ({ ...r, score: (r.score - min) / range }));
}

/**
 * Fuse vector and keyword results into a single ranked list.
 * Scores are normalized to [0,1] within each path, then combined with a
 * vector-weighted blend (0.6 vector + 0.4 keyword). An entry scored by both
 * paths gets the combined score; an entry scored by only one path gets its
 * normalized score (the missing path contributes 0).
 */
function fuseResults(vector: SearchResult[], keyword: SearchResult[]): SearchResult[] {
  const normVec = normalizeScores(vector);
  const normKw = normalizeScores(keyword);
  const byId = new Map<string, SearchResult>();
  // Vector pass: weighted 0.6
  for (const r of normVec) {
    byId.set(r.entry.id, { ...r, score: r.score * 0.6, searchMode: "hybrid" as const });
  }
  // Keyword pass: weighted 0.4 — adds to existing vector score or creates new entry
  for (const r of normKw) {
    const existing = byId.get(r.entry.id);
    if (existing) {
      existing.score += r.score * 0.4;
    } else {
      byId.set(r.entry.id, { ...r, score: r.score * 0.4, searchMode: "hybrid" as const });
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score);
}

// ─── main search entrypoint ───────────────────────────────────────────────────

/**
 * Run the search pipeline and return the full ranked result list (entries +
 * scores + search mode), before slicing. Exposed so callers that need the
 * scores or want their own selection logic (e.g. recommend_ui_direction's
 * diversity-aware picker) can get the raw ranking.
 */
export async function searchRanked(opts: SearchOptions): Promise<SearchResult[]> {
  const entries = loadCorpus();

  // Structural filters always apply regardless of search mode.
  const filtered = applyStructuralFilters(entries, opts);

  let results: SearchResult[];

  if (opts.query && indexExists() && process.env.VOYAGE_API_KEY) {
    // Hybrid path: run both vector and keyword, then fuse.
    // Each path scores differently (keyword: weighted bonuses; vector: cosine*10),
    // so we normalize each to [0,1] before combining with a vector-weighted blend.
    const vectorResults = await vectorSearch(filtered, opts.query!, opts);
    const keywordResults = keywordSearch(filtered, opts);
    results = fuseResults(vectorResults, keywordResults);
  } else {
    if (opts.query && indexExists() && !process.env.VOYAGE_API_KEY) {
      console.error("[clean-ui-mcp] VOYAGE_API_KEY not set — falling back to keyword search.");
    }
    results = keywordSearch(filtered, opts);
  }

  // ── Optional rerank (Voyage rerank-2.5 cross-encoder) ─────────────────────
  // Opt-in via SearchOptions.rerank. Gated behind VOYAGE_API_KEY. Takes the
  // top-30 fused/keyword results, reranks them against the query, and returns
  // the reranked top-K followed by the remaining tail (preserving fused scores).
  // If rerank fails (rate limit, network), falls back to the pre-rerank scores.
  if (opts.rerank && opts.query && process.env.VOYAGE_API_KEY && results.length > 5) {
    results.sort((a, b) => b.score - a.score);
    const rerankPool = results.slice(0, 30);
    const tail = results.slice(30);
    const documents = rerankPool.map((r) => entryToDocument(r.entry));
    const reranked = await voyageRerank(opts.query, documents);
    if (reranked) {
      // Replace the pool with reranked order, using relevance scores.
      const rerankedResults = reranked.map((rr: { index: number; relevanceScore: number }) => ({
        ...rerankPool[rr.index],
        score: rr.relevanceScore,
      }));
      // Deterministic merge: reranked pool first (already sorted by relevance
      // from voyageRerank), then remaining tail in its pre-rerank order.
      // Return directly — do NOT re-sort across different score scales.
      return [...rerankedResults, ...tail];
    }
  }

  return results.sort((a, b) => b.score - a.score);
}

/** The primary search entry point — returns entries (no scores), sliced to limit. */
export async function searchEntries(opts: SearchOptions): Promise<CorpusEntryT[]> {
  const limit = opts.limit ?? 5;
  return (await searchRanked(opts)).slice(0, limit).map((r) => r.entry);
}

// ─── similar-by-entry-id (vector cosine over the existing index) ─────────────

export interface SimilarResult {
  entry:  CorpusEntryT;
  score:  number; // cosine similarity in [-1, 1]; higher = more similar
}

/**
 * Find entries similar to a given source entry by vector cosine similarity.
 * Requires the embedding index (`npm run build-index`). Pure data layer —
 * the MCP tool in server.ts wraps this with formatting + error messages.
 *
 * Returns an empty array (not a throw) when the index is missing or the source
 * entry isn't indexed yet, so callers can surface a helpful message.
 */
export function findSimilarEntries(id: string, limit = 5): SimilarResult[] {
  const index = loadIndex();
  if (!index) return []; // caller tells the user to run build-index

  const sourceVec = index.entries[id]?.vector;
  if (!sourceVec) return []; // source entry not indexed

  const entries = loadCorpus();
  const results: SimilarResult[] = [];

  for (const e of entries) {
    if (e.id === id) continue; // exclude the source itself
    if (e.reviewStatus === "draft") continue; // drafts don't surface as similar
    const docVec = index.entries[e.id]?.vector;
    if (!docVec) continue; // skip unindexed entries rather than scoring them 0
    results.push({ entry: e, score: cosine(sourceVec, docVec) });
  }

  return results.sort((a, b) => b.score - a.score).slice(0, limit);
}

// ─── helpers ─────────────────────────────────────────────────────────────────

export function getEntryById(id: string): CorpusEntryT | undefined {
  return loadCorpus().find((e) => e.id === id);
}

export function listCategories(): string[] {
  const set = new Set<string>();
  for (const e of loadCorpus()) for (const c of e.categories) set.add(c);
  return [...set].sort();
}

export function listStyleTags(): string[] {
  const set = new Set<string>();
  for (const e of loadCorpus()) for (const s of e.styleTags) set.add(s);
  return [...set].sort();
}

export function listDomainTags(): string[] {
  const set = new Set<string>();
  for (const e of loadCorpus()) for (const d of (e.domainTags ?? [])) set.add(d);
  return [...set].sort();
}

export interface IndexStatus {
  indexed: number;       // entries that have a vector in the index
  total: number;         // total corpus entries
  hasIndex: boolean;     // is an embeddings.json present and loadable
  missing: number;       // entries with no vector (need build-index)
  stale: number;         // vectors whose id is no longer in the corpus (orphans)
  contentStale: number;  // indexed entries whose content hash changed since embedding
}

/**
 * Report index coverage + drift. The index can fall out of sync with the corpus
 * in three ways, all of which degrade search quality silently:
 *   - `missing`:       entry added since last build-index, no vector yet
 *   - `stale`:         vector whose id was removed from the corpus (orphan)
 *   - `contentStale`:  entry's title/critique/tags changed after it was embedded
 *                       (the vector still points at the OLD text — detected via
 *                       the per-entry content hash stored in v2 indexes)
 */
export function indexStatus(): IndexStatus {
  const entries = loadCorpus();
  const index   = loadIndex();
  if (!index) return { indexed: 0, total: entries.length, hasIndex: false, missing: entries.length, stale: 0, contentStale: 0 };
  const entryIds = new Set(entries.map((e) => e.id));
  const stale = Object.keys(index.entries).filter((id) => !entryIds.has(id)).length;
  let indexed = 0;
  let contentStale = 0;
  for (const e of entries) {
    const rec = index.entries[e.id];
    if (!rec) continue;
    indexed += 1;
    // v1 indexes load with hash:"" (unknown) — count as content-stale so the
    // doctor surfaces them and the next incremental build re-embeds.
    const currentHash = hashForDocument(entryToDocument(e));
    if (!rec.hash || rec.hash !== currentHash) contentStale += 1;
  }
  return { indexed, total: entries.length, hasIndex: true, missing: entries.length - indexed, stale, contentStale };
}
