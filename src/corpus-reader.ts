/**
 * corpus-reader.ts — the corpus-access abstraction for the MCP server.
 *
 * Gate 1A, Tasks 4a/4b. Every MCP tool reads the corpus through an injected
 * `CorpusReader` instead of calling the corpus.ts functions directly. This
 * indirection is what lets public mode swap in a `PublicCorpusReader` (which
 * serves only a finalized public snapshot) without touching tool registration.
 *
 * Two implementations:
 *   - `PrivateCorpusReader` (Task 4a): thin delegate to the EXISTING corpus.ts
 *     functions (which read via the consolidated hardened loader). Private mode
 *     preserves current behavior EXACTLY — no intercept/redirect/filter.
 *   - `PublicCorpusReader` (Task 4b): the leak-prevention reader. Loads a
 *     finalized public snapshot (entries.json + manifest.json + images-public/),
 *     verifies its integrity, and serves ONLY the eligible entries in it. No
 *     path from a public-mode tool to the private corpus, the private embedding
 *     index, or private entry counts. Keyword-only search (D19); similarity
 *     unavailable; indexStatus reports only the public total.
 *
 * The reader is constructed once per process (in server.ts's `main()`) and
 * threaded into `createServer(reader)`. Tests import this module and assert the
 * private reader delegates correctly via the `setCorpusForTesting` seam, and
 * that the public reader never leaks private/unapproved data.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { CorpusEntryT } from "./schema.js";
import {
  keywordSearch,
  loadCorpus,
  searchEntries,
  searchRanked,
  getEntryById,
  findSimilarEntries,
  listCategories,
  listStyleTags,
  listDomainTags,
  indexStatus,
  type SearchOptions,
  type SearchResult,
  type SimilarResult,
  type IndexStatus,
} from "./corpus.js";
import { fromCorpusRelativeImagePath } from "./paths.js";
import { verifySnapshotIntegrity } from "./publication/exporter.js";
import type { PublicSnapshotManifest } from "./publication/manifest.js";

export type CorpusMode = "private" | "public";

export interface CorpusReader {
  search(options: SearchOptions): Promise<CorpusEntryT[]>;
  searchRanked(options: SearchOptions): Promise<SearchResult[]>;
  getById(id: string): CorpusEntryT | undefined;
  findSimilar(id: string, limit?: number): SimilarResult[];
  listCategories(): string[];
  listStyleTags(): string[];
  listDomainTags(): string[];
  indexStatus(): IndexStatus;
  /** Full corpus for the four aggregation tools (no filtering — private mode shows everything, matching today). */
  entriesForAggregation(): readonly CorpusEntryT[];
  /** Resolve a corpus-relative image path to an absolute filesystem path (or null if invalid/unresolvable). */
  resolveImagePath(path: string): string | null;
}

/**
 * PrivateCorpusReader — delegates to the existing corpus.ts functions.
 *
 * Private mode is the default and the historical behavior: it reads the full
 * mutable corpus via the hardened persistence path, applies the existing
 * review-status filtering inside search/similar, and returns the full corpus
 * for aggregation. Image paths root at the repo corpus root
 * (`fromCorpusRelativeImagePath`).
 */
export class PrivateCorpusReader implements CorpusReader {
  search(options: SearchOptions): Promise<CorpusEntryT[]> {
    return searchEntries(options);
  }

  searchRanked(options: SearchOptions): Promise<SearchResult[]> {
    return searchRanked(options);
  }

  getById(id: string): CorpusEntryT | undefined {
    return getEntryById(id);
  }

  findSimilar(id: string, limit?: number): SimilarResult[] {
    return findSimilarEntries(id, limit);
  }

  listCategories(): string[] {
    return listCategories();
  }

  listStyleTags(): string[] {
    return listStyleTags();
  }

  listDomainTags(): string[] {
    return listDomainTags();
  }

  indexStatus(): IndexStatus {
    return indexStatus();
  }

  /**
   * The four aggregation handlers (anti-patterns, palettes, techniques,
   * browse-by-pattern) all call this. Private mode returns the FULL corpus —
   * the aggregation functions themselves apply the review-status filter
   * internally (see aggregations.ts `filterEntries`), exactly as they did when
   * server.ts passed `loadCorpus()` directly. No behavior change.
   */
  entriesForAggregation(): readonly CorpusEntryT[] {
    return loadCorpus();
  }

  /**
   * Resolve a corpus-relative image path to an absolute filesystem path.
   * Delegates to the existing `fromCorpusRelativeImagePath`, which validates
   * the path is under images-private/ or images-public/ and roots it at the
   * repo corpus root. Returns null on an invalid path rather than throwing,
   * so the tool handler can degrade gracefully (today's behavior in
   * get_ui_example just relies on existsSync on the resolved path; this keeps
   * the same resolution while giving the caller a safe null for the public
   * reader to override later).
   */
  resolveImagePath(path: string): string | null {
    try {
      return fromCorpusRelativeImagePath(path);
    } catch {
      return null;
    }
  }
}

// ─── PublicCorpusReader (Task 4b) ────────────────────────────────────────────

/**
 * PublicCorpusReader — the leak-prevention reader.
 *
 * Loads a FINALIZED public snapshot (produced by Task 3's exporter) and serves
 * ONLY the entries in it. The snapshot is pre-filtered at export time: the
 * exporter runs the publication policy, so by construction every entry in
 * `entries.json` is eligible. The reader does NOT re-evaluate the policy at
 * runtime (the snapshot IS the filtered set) and never touches the live corpus
 * or its embedding index.
 *
 * Why this matters: in public mode, EVERY MCP tool goes through this reader.
 * There is no path from a public-mode tool to the private corpus, the private
 * embedding index, or private entry counts. The three concrete leak vectors
 * this design closes:
 *
 *   - D19 search: `search`/`searchRanked` do KEYWORD matching only against the
 *     snapshot entries. They never call `searchRanked`/`loadIndex`, which would
 *     disclose private similarity scores + private entry counts.
 *   - `findSimilar`: returns `[]` (matching `findSimilarEntries`'s "no index"
 *     behavior) — vector similarity over the private index is unavailable.
 *   - `indexStatus`: reports `{total: <public count>, hasIndex: false, ...}`,
 *     so the total reflects ONLY the public snapshot size, never the private
 *     corpus count.
 *
 * The constructor verifies the snapshot's integrity (re-hashes entries.json +
 * every asset against the manifest) before serving anything, so a tampered or
 * truncated snapshot fails loudly instead of serving partial data.
 */
export class PublicCorpusReader implements CorpusReader {
  private readonly snapshotPath: string;
  /** Cached eligible entries from the snapshot's entries.json. Frozen at load. */
  private readonly entries: readonly CorpusEntryT[];

  /**
   * @param snapshotPath absolute path to a committed snapshot directory
   *   (`<snapshotDir>/<snapshotId>/`) containing manifest.json, entries.json,
   *   and the images-public/ tree.
   * @throws if the snapshot is missing, unreadable, or fails integrity
   *   verification (re-hash mismatch, missing asset, etc.).
   */
  constructor(snapshotPath: string) {
    this.snapshotPath = snapshotPath;

    const entriesPath = resolve(snapshotPath, "entries.json");
    const manifestPath = resolve(snapshotPath, "manifest.json");
    if (!existsSync(entriesPath)) {
      throw new Error(`[public-reader] snapshot missing entries.json: ${entriesPath}`);
    }
    if (!existsSync(manifestPath)) {
      throw new Error(`[public-reader] snapshot missing manifest.json: ${manifestPath}`);
    }

    const manifest = JSON.parse(
      readFileSync(manifestPath, "utf-8"),
    ) as PublicSnapshotManifest;

    // Re-hash every file against the manifest before caching anything. This
    // reuses the exporter's own verifier so a snapshot that fails its own
    // integrity check (tampered, truncated, partial write) is refused at load.
    verifySnapshotIntegrity(snapshotPath, manifest);

    this.entries = JSON.parse(
      readFileSync(entriesPath, "utf-8"),
    ) as CorpusEntryT[];
  }

  /**
   * Apply the structural filters (category/styleTag/minQuality/qualityTier/
   * platform/reviewStatus) to the snapshot entries. Mirrors the filter block in
   * corpus.ts `searchRanked`, but operates on the snapshot set — never the live
   * corpus. The snapshot is already filtered to eligible entries at export
   * time, so this is a pure subset operation.
   */
  private structurallyFiltered(opts: SearchOptions): CorpusEntryT[] {
    return this.entries.filter((e) => {
      if (opts.category && !e.categories.includes(opts.category as never)) return false;
      if (opts.styleTag && !e.styleTags.includes(opts.styleTag as never)) return false;
      if (opts.minQuality && e.qualityScore < opts.minQuality) return false;
      if (opts.qualityTier && e.qualityTier !== opts.qualityTier) return false;
      if (opts.platform && e.platform !== opts.platform) return false;
      // Workflow state: the snapshot only contains approved entries (drafts are
      // ineligible at export time), so the default "approved" filter is a no-op.
      // Honor an explicit "draft"/"any" for API parity, but in practice the
      // snapshot has no drafts to surface.
      const statusFilter = opts.reviewStatus ?? "approved";
      if (statusFilter === "approved" && e.reviewStatus === "draft") return false;
      if (statusFilter === "draft" && e.reviewStatus !== "draft") return false;
      return true;
    });
  }

  /**
   * KEYWORD-ONLY search (D19). Runs the shared `keywordSearch` scorer against
   * the snapshot entries. Never touches the global embedding index, which
   * covers the PRIVATE corpus — using it would leak private entry counts and
   * similarity scores into public results.
   */
  private keywordRanked(opts: SearchOptions): SearchResult[] {
    return keywordSearch(this.structurallyFiltered(opts), opts)
      .sort((a, b) => b.score - a.score);
  }

  /** Primary search — returns entries (no scores), sliced to limit. */
  search(options: SearchOptions): Promise<CorpusEntryT[]> {
    const limit = options.limit ?? 5;
    const entries = this.keywordRanked(options).slice(0, limit).map((r) => r.entry);
    return Promise.resolve(entries);
  }

  /**
   * Ranked search. In public mode this is identical to `search` (keyword-only,
   * no rerank). The private reader delegates to the global `searchRanked`
   * (which may fuse vector + keyword results); the public reader CANNOT, so it
   * runs keyword-only and returns the same results `search` would.
   */
  searchRanked(options: SearchOptions): Promise<SearchResult[]> {
    return Promise.resolve(this.keywordRanked(options));
  }

  /**
   * Look up an entry by id. Returns `undefined` for any id not in the snapshot —
   * including private entries that exist in the live corpus. There is no path
   * from here to a private entry.
   */
  getById(id: string): CorpusEntryT | undefined {
    return this.entries.find((e) => e.id === id);
  }

  /**
   * Vector similarity is UNAVAILABLE in public mode (D19). The embedding index
   * covers the private corpus; serving similarity through it would leak private
   * neighbors + scores. Returns an empty array, mirroring
   * `findSimilarEntries`'s documented "no index present" behavior so callers
   * surface the same "unavailable" message they already handle.
   */
  findSimilar(_id: string, _limit?: number): SimilarResult[] {
    return [];
  }

  listCategories(): string[] {
    const set = new Set<string>();
    for (const e of this.entries) for (const c of e.categories) set.add(c);
    return [...set].sort();
  }

  listStyleTags(): string[] {
    const set = new Set<string>();
    for (const e of this.entries) for (const s of e.styleTags) set.add(s);
    return [...set].sort();
  }

  listDomainTags(): string[] {
    const set = new Set<string>();
    for (const e of this.entries) for (const d of (e.domainTags ?? [])) set.add(d);
    return [...set].sort();
  }

  /**
   * Report a public-mode index status that does NOT disclose private totals.
   * No vector index exists in public mode, so `hasIndex` is always false and
   * `total` reflects ONLY the public snapshot size — never the private corpus
   * count. The aggregation/similar tool handlers use `hasIndex`/`indexed` to
   * decide whether to offer vector features; both are zeroed here.
   */
  indexStatus(): IndexStatus {
    const total = this.entries.length;
    return {
      indexed: 0,
      total,
      hasIndex: false,
      missing: 0,
      stale: 0,
      contentStale: 0,
    };
  }

  /**
   * The snapshot is already filtered to eligible entries at export time, so no
   * runtime policy filter is needed — return the snapshot's entries directly.
   * This is what the four aggregation handlers iterate.
   */
  entriesForAggregation(): readonly CorpusEntryT[] {
    return this.entries;
  }

  /**
   * Resolve a snapshot-relative image path to an absolute filesystem path,
   * rooted at the SNAPSHOT directory (not the repo corpus root). An entry's
   * `image.path` is `images-public/<asset>`; this maps it to
   * `<snapshotPath>/images-public/<asset>`. Returns null if the path is
   * malformed or the file doesn't exist on disk — the tool handler degrades
   * gracefully to "image not found locally".
   *
   * Containment: only `images-public/...` paths under the snapshot dir are
   * accepted; a `..` traversal or absolute path is rejected.
   */
  resolveImagePath(path: string): string | null {
    if (typeof path !== "string" || path.length === 0) return null;
    if (path.includes("..") || path.startsWith("/")) return null;
    // Only the public image tree is served from a snapshot. A path that doesn't
    // live under images-public/ is not part of any public snapshot.
    if (!path.startsWith("images-public/")) return null;
    const abs = resolve(this.snapshotPath, path);
    if (!existsSync(abs)) return null;
    return abs;
  }
}
