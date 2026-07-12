/**
 * corpus-reader.ts — the corpus-access abstraction for the MCP server.
 *
 * Gate 1A, Task 4a. Every MCP tool reads the corpus through an injected
 * `CorpusReader` instead of calling the corpus.ts functions directly. This
 * indirection is what lets Task 4b swap in a `PublicCorpusReader` (which
 * filters by the publication policy) without touching tool registration.
 *
 * THIS FILE implements only the private reader. `PrivateCorpusReader` is a
 * thin delegate: it forwards each method to the EXISTING corpus.ts function
 * (which reads via the consolidated hardened loader from Task 1). Private
 * mode preserves current behavior EXACTLY — it does not intercept, redirect,
 * or filter the load. `entriesForAggregation()` returns the full corpus
 * (matching today's `loadCorpus()` calls in the four aggregation handlers).
 *
 * The reader is constructed once per process (in server.ts's `main()`) and
 * threaded into `createServer(reader)`. Tests import this module and assert
 * the private reader delegates correctly via the `setCorpusForTesting` seam.
 */
import type { CorpusEntryT } from "./schema.js";
import {
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
