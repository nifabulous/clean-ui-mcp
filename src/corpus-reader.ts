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
import { existsSync, readdirSync, readFileSync, statSync, realpathSync, type Dirent } from "node:fs";
import { resolve, relative, sep, join } from "node:path";
import { z } from "zod";
import type { CorpusEntryT } from "./schema.js";
import {
  keywordSearch,
  applyStructuralFilters,
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
import { PublicSnapshotManifestSchema, type PublicSnapshotManifest } from "./publication/manifest.js";
import { CorpusEntry } from "./schema.js";
import { evaluatePublication } from "./publication/policy.js";

export type CorpusMode = "private" | "public";

/**
 * The image-embedding index the critique_ui tool ranks against. Opaque to the
 * reader interface (the concrete shape lives in image-index.ts); only the
 * critique_ui handler + critique-retrieval.ts consume it. `null` means "no
 * index available in this mode" — public mode has no public image-embedding
 * snapshot in Gate 1A, so it returns null and critique_ui falls back to the
 * structured-retrieval path (critique-retrieval.ts:~121) which needs no index.
 */
export interface ReaderImageIndex {
  dimension: number;
  entries: Record<string, { vector: number[]; hash: string }>;
}

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
  /**
   * The image-embedding index for critique_ui's visual-similarity ranking, or
   * null when none is available in this mode.
   *
   * F2 (Gate 1A): the critique_ui tool previously imported `loadImageIndex`
   * directly from ./image-index.js and loaded the GLOBAL index regardless of
   * which reader was injected. In public mode that loaded the PRIVATE corpus's
   * embedding index — a direct leak. Routing the index through the reader makes
   * the reader the single authority: PrivateCorpusReader returns the loaded
   * global index (loaded via a dynamic import so corpus-reader.ts stays free of
   * a static image-index dependency); PublicCorpusReader returns null (no public
   * snapshot index in Gate 1A), and critique_ui degrades to structured
   * retrieval. `providerModel` is the embedding model name the caller's provider
   * uses; loadImageIndex validates the index's stored model against it.
   */
  getImageIndex(providerModel?: string): Promise<ReaderImageIndex | null>;
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

  /**
   * F2 (Gate 1A): the global image-embedding index, loaded on demand. Private
   * mode is the only mode that exposes a corpus image index; this preserves
   * the pre-refactor critique_ui behavior exactly.
   *
   * Loaded via a DYNAMIC import (not a static `import ... from` statement) so
   * the public-import-boundary static check stays satisfied — corpus-reader.ts
   * must not statically wire the image-index module. The import is lazy: the
   * index is only touched when critique_ui actually asks for it, so modes that
   * never call this (every tool except critique_ui) pay nothing.
   *
   * The provider's model name is required because loadImageIndex validates the
   * index's stored model against it (rejects a stale/wrong-model index).
   */
  async getImageIndex(providerModel?: string): Promise<ReaderImageIndex | null> {
    if (!providerModel) return null;
    const { loadImageIndex } = await import("./image-index.js");
    return loadImageIndex(providerModel);
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
  /**
   * The snapshot dir resolved through realpath ONCE (cached) so F4's containment
   * check agrees even on platforms where the snapshot dir is itself a symlink
   * (macOS: $TMPDIR=/var/... → /private/var/...). Falls back to the as-passed
   * path if the dir can't be resolved (the asset check will then report every
   * image as escaping — safe-by-default).
   */
  private readonly realSnapshotRoot: string;
  /** Cached eligible entries from the snapshot's entries.json. Frozen at load. */
  private readonly entries: readonly CorpusEntryT[];

  /**
   * @param snapshotPath absolute path to a committed snapshot directory
   *   (`<snapshotDir>/<snapshotId>/`) containing manifest.json, entries.json,
   *   and the images-public/ tree.
   * @param now OPTIONAL current date as a `YYYY-MM-DD` string, used ONLY for the
   *   publication expiry re-evaluation (NOT for the manifest's `generatedAt`,
   *   which is the snapshot's own creation time). Defaults to today's date in
   *   production. Tests inject a fixed date for determinism.
   *
   * F1 (Gate 1A, round 2): the expiry check MUST use the current date, NOT the
   * snapshot's `generatedAt`. The previous code derived `pubDate` from
   * `manifest.generatedAt.slice(0, 10)`, which meant an entry that expired
   * AFTER the snapshot was created was eligible forever — a snapshot generated
   * Jan 1 with rights expiring Feb 1 was still served in July. The injected
   * `now` fixes this: `evaluatePublication` sees today, so an expired entry is
   * filtered out at load regardless of when the snapshot was built.
   *
   * @throws if the snapshot is missing, unreadable, fails integrity
   *   verification (re-hash mismatch, missing asset), has schema-invalid
   *   manifest/entries, an entryCount mismatch, an asset/path mismatch, or a
   *   publication-policy violation that can't be filtered out.
   *
   * F3 (Gate 1A): a snapshot is an UNTRUSTED input at load time. Integrity
   * hashing proves only self-consistency (files match the manifest hashes), NOT
   * that the manifest/entries are well-formed or that the entries are eligible
   * for publication. A hand-crafted snapshot with private/unapproved entries +
   * recomputed hashes would pass integrity and be served. The load pipeline now:
   *   1. Zod-parse the manifest (rejects malformed manifest shapes; runs before
   *      verifySnapshotIntegrity so the verifier reads validated fields).
   *   2. verifySnapshotIntegrity (re-hash) — unchanged.
   *   3. Zod-parse entries.json (rejects malformed entry shapes).
   *   4. assert manifest.entryCount === entries.length (rejects a lying count).
   *   5. re-run evaluatePublication against each entry (imageExists rooted at
   *      the snapshot dir); EXCLUDE any that fail (filter-and-log). Runs before
   *      the asset cross-check so a private entry's images-private/ path isn't a
   *      false-positive asset violation. Defense-in-depth: the exporter
   *      pre-filters, but a modified/externally-supplied snapshot is re-verified
   *      here so an ineligible entry can never be served.
   *   6. assert asset set consistency (F2, round 2): eligible ⊆ manifest,
   *      manifest ⊆ all-entry-paths (no orphan manifest assets), and manifest
   *      == disk (no unmanifested files, no missing manifest files). Any
   *      discrepancy (orphan manifest asset, unmanifested file on disk, or a
   *      manifest asset whose file is missing) throws. This closes the gap
   *      where a snapshot could carry extra manifest assets or arbitrary files
   *      under images-public/ that no entry references.
   */
  constructor(snapshotPath: string, now?: string) {
    this.snapshotPath = snapshotPath;
    // Resolve the snapshot root through realpath once (F4 containment check).
    try {
      this.realSnapshotRoot = realpathSync(snapshotPath);
    } catch {
      this.realSnapshotRoot = snapshotPath;
    }

    // F1 (round 2): the injected current date for expiry checking. Defaults to
    // today in production; tests pass a fixed date for determinism. Validated as
    // a YYYY-MM-DD string so a bad caller input fails loudly rather than
    // silently comparing garbage lexicographically.
    const nowDate = now ?? new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(nowDate)) {
      throw new Error(
        `[public-reader] 'now' must be a YYYY-MM-DD string (got: ${JSON.stringify(nowDate)})`,
      );
    }

    const entriesPath = resolve(snapshotPath, "entries.json");
    const manifestPath = resolve(snapshotPath, "manifest.json");
    if (!existsSync(entriesPath)) {
      throw new Error(`[public-reader] snapshot missing entries.json: ${entriesPath}`);
    }
    if (!existsSync(manifestPath)) {
      throw new Error(`[public-reader] snapshot missing manifest.json: ${manifestPath}`);
    }

    // ── 1. Integrity: re-hash every file against the manifest ───────────────
    // Parse the manifest with Zod FIRST so verifySnapshotIntegrity reads
    // validated fields (not a type-cast `as PublicSnapshotManifest`). A tampered
    // manifest with a non-hex entriesSha256 would otherwise reach the verifier.
    const manifestParse = PublicSnapshotManifestSchema.safeParse(
      JSON.parse(readFileSync(manifestPath, "utf-8")),
    );
    if (!manifestParse.success) {
      throw new Error(
        `[public-reader] manifest.json failed schema validation: `
        + `${manifestParse.error.message}`,
      );
    }
    const manifest: PublicSnapshotManifest = manifestParse.data;

    // Re-hash every file against the manifest before caching anything. This
    // reuses the exporter's own verifier so a snapshot that fails its own
    // integrity check (tampered, truncated, partial write) is refused at load.
    verifySnapshotIntegrity(snapshotPath, manifest);

    // ── 2. Zod-parse entries.json (reject malformed entry shapes) ───────────
    const entriesParse = z.array(CorpusEntry).safeParse(
      JSON.parse(readFileSync(entriesPath, "utf-8")),
    );
    if (!entriesParse.success) {
      throw new Error(
        `[public-reader] entries.json failed schema validation: `
        + `${entriesParse.error.message}`,
      );
    }
    const parsedEntries: CorpusEntryT[] = entriesParse.data;

    // ── 3. entryCount cross-check (manifest must not lie about its size) ────
    if (manifest.entryCount !== parsedEntries.length) {
      throw new Error(
        `[public-reader] manifest entryCount (${manifest.entryCount}) does not match `
        + `entries.json length (${parsedEntries.length}) — refusing to serve an `
        + `inconsistent snapshot.`,
      );
    }

    // ── 4. Re-evaluate publication eligibility (filter-and-log) ─────────────
    // Run the policy BEFORE the asset cross-check: a private entry legitimately
    // carries an images-private/ path that is (correctly) NOT in the manifest's
    // public assets, so asset-checking it would be a false positive. The policy
    // removes private/unapproved entries first; only the survivors (which must
    // have images-public/ paths) are asset-checked.
    //
    // imageExists is rooted at the SNAPSHOT dir: a public entry's image.path is
    // "images-public/<asset>" which lives at <snapshot>/images-public/<asset>.
    // An entry whose image file is missing from the snapshot fails the policy
    // and is excluded — it can't be served without its redistributable asset.
    //
    // F1 (round 2): the expiry check uses the INJECTED current date (`nowDate`),
    // NOT manifest.generatedAt. Using generatedAt meant an entry that expired
    // after the snapshot was created stayed eligible forever. Now an old
    // snapshot's expired entries are re-evaluated against today at every load.
    const imageExists = (corpusRelPath: string): boolean => {
      const prefix = "images-public/";
      if (!corpusRelPath.startsWith(prefix)) return false;
      return existsSync(resolve(snapshotPath, corpusRelPath));
    };
    const policyEligible: CorpusEntryT[] = [];
    let excluded = 0;
    for (const entry of parsedEntries) {
      const decision = evaluatePublication(entry, { now: nowDate, imageExists });
      if (decision.eligible) {
        policyEligible.push(entry);
      } else {
        excluded++;
      }
    }
    if (excluded > 0) {
      console.error(
        `[public-reader] excluded ${excluded} entr${excluded === 1 ? "y" : "ies"} from `
        + `${snapshotPath} that failed publication re-evaluation (defense-in-depth; `
        + `the exporter should have pre-filtered these).`,
      );
    }

    // ── 5. Asset set consistency (F2, round 2) ─────────────────────────────
    // Three invariants, each closing a gap the original (entries ⊆ manifest)
    // check left open:
    //
    //   (1) eligible ⊆ manifest: every SURVIVING entry's image path is a
    //       declared manifest asset (the original check, kept). Catches an
    //       eligible entry whose image points at an undeclared file.
    //
    //   (2) manifest ⊆ allEntryPaths: every manifest asset is referenced by SOME
    //       entry in entries.json (eligible or not). Catches an ORPHAN MANIFEST
    //       ASSET — a declared asset that NO entry references (e.g. a private
    //       entry's image smuggled into the manifest). An asset referenced by an
    //       ineligible-but-present entry is NOT an orphan: it's the entry's own
    //       image, legitimately declared at export time. This distinction matters
    //       for F1: a time-expired entry is filtered from the SERVED set but its
    //       asset was validly declared — treating it as an orphan would make
    //       every old snapshot (with a since-expired entry) unloadable, defeating
    //       F1's filter-and-log design. The finding's TDD pins the real target:
    //       "an extra manifest asset NOT REFERENCED BY ANY ENTRY."
    //
    //   (3) manifest == disk (EXACT): every manifest asset exists on disk AND
    //       every regular file under <snapshot>/images-public/ is in the manifest.
    //       Catches an UNMANIFESTED FILE (a file riding in the snapshot that no
    //       manifest entry vouches for — would be packaged by a naive npm pack)
    //       and a MISSING FILE (a declared asset whose file was deleted).
    //
    // Any discrepancy throws with the specific extra/missing paths named.

    // (a) ALL parsed entries' image paths (non-null, images-public/...). Used for
    // the orphan-manifest-asset check (2): an asset in the manifest that no
    // entry references is a smuggled file. Ineligible entries are included so a
    // time-expired or unreviewed entry's own asset isn't mis-flagged.
    const allEntryImagePaths = new Set<string>();
    for (const entry of parsedEntries) {
      const imgPath = entry.image.path;
      if (imgPath !== null) {
        allEntryImagePaths.add(imgPath);
      }
    }

    // (a') Eligible entries' image paths — for the eligible ⊆ manifest check (1).
    const eligibleImagePaths = new Set<string>();
    for (const entry of policyEligible) {
      const imgPath = entry.image.path;
      if (imgPath !== null) {
        eligibleImagePaths.add(imgPath);
      }
    }

    // (b) Manifest declared asset paths.
    const manifestAssetPaths = new Set(manifest.assets.map((a) => a.path));

    // (c) Actual regular files under <snapshot>/images-public/ (recursive walk,
    // relativized to "images-public/..."). Directories, symlinks, fifos, etc.
    // are excluded — only regular files count as assets. This mirrors how the
    // exporter populates the asset list (regular files only).
    const onDiskPaths = new Set<string>();
    const imageDir = resolve(snapshotPath, "images-public");
    if (existsSync(imageDir)) {
      const walk = (dir: string): void => {
        let entries: Dirent[];
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return; // unreadable subdir — treat as empty (the set check will flag it).
        }
        for (const ent of entries) {
          const abs = join(dir, ent.name);
          // Use ent.isDirectory()/isFile() off the Dirent when possible; fall
          // back to statSync for platforms/filesystems where the Dirent type
          // is unknown (DT_UNKNOWN). A symlinked directory must be traversed
          // via statSync (not lstatSync) so a legit symlinked subfolder inside
          // images-public/ is still walked — the per-file regular-file check
          // below uses statSync too, staying consistent with resolveImagePath.
          let isDir = false;
          let isFile = false;
          try {
            if (ent.isDirectory()) {
              isDir = true;
            } else if (ent.isFile()) {
              isFile = true;
            } else {
              // DT_UNKNOWN or special type: stat to classify.
              const s = statSync(abs);
              isDir = s.isDirectory();
              isFile = s.isFile();
            }
          } catch {
            // Broken symlink / unreadable — skip (can't be a regular asset).
            continue;
          }
          if (isDir) {
            walk(abs);
          } else if (isFile) {
            const rel = relative(snapshotPath, abs).split(sep).join("/");
            onDiskPaths.add(rel);
          }
        }
      };
      walk(imageDir);
    }

    // Compare and throw with a precise discrepancy report. `missing` computes
    // a − b (elements in a but not in b) — used for subset checks and for naming
    // the extra paths in each direction of the manifest==disk equality check.
    const missing = (a: Set<string>, b: Set<string>): string[] =>
      [...a].filter((p) => !b.has(p)).sort();
    const setEqual = (x: Set<string>, y: Set<string>): boolean =>
      x.size === y.size && [...x].every((p) => y.has(p));

    const failures: string[] = [];

    // (1) eligible ⊆ manifest
    const eligibleNotInManifest = missing(eligibleImagePaths, manifestAssetPaths);
    if (eligibleNotInManifest.length > 0) {
      failures.push(
        `eligible entries reference undeclared assets: ${JSON.stringify(eligibleNotInManifest)}`,
      );
    }

    // (2) manifest ⊆ allEntryPaths (no orphan manifest assets)
    const orphanManifestAssets = missing(manifestAssetPaths, allEntryImagePaths);
    if (orphanManifestAssets.length > 0) {
      failures.push(
        `manifest declares assets referenced by no entry (orphan): ${JSON.stringify(orphanManifestAssets)}`,
      );
    }

    // (3) manifest == disk (exact)
    if (!setEqual(manifestAssetPaths, onDiskPaths)) {
      failures.push(
        `manifest assets ≠ files on disk`
        + ` (manifest-only: ${JSON.stringify(missing(manifestAssetPaths, onDiskPaths))}`
        + `; disk-only: ${JSON.stringify(missing(onDiskPaths, manifestAssetPaths))})`,
      );
    }

    if (failures.length > 0) {
      throw new Error(
        `[public-reader] snapshot asset set mismatch — refusing to serve a snapshot `
        + `whose entries, manifest, and on-disk files disagree: ${failures.join("; ")}.`,
      );
    }

    this.entries = policyEligible;
  }

  /**
   * Apply the structural filters to the snapshot entries via the shared
   * `applyStructuralFilters` helper from corpus.ts. Using the shared helper
   * (rather than a copy) keeps the public and private filter logic identical
   * so they cannot drift on a leak-relevant invariant. The snapshot is already
   * filtered to eligible entries at export time, so this is a pure subset.
   */
  private structurallyFiltered(opts: SearchOptions): CorpusEntryT[] {
    return applyStructuralFilters(this.entries, opts);
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
   * runs keyword-only and returns the same results `search` would. An explicit
   * `opts.rerank` is silently ignored — rerank is an external Voyage API call
   * that would leak entry data, so it is unavailable in public mode.
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

  /**
   * F2 (Gate 1A): NO image-embedding index in public mode. There is no public
   * snapshot index in Gate 1A, and the global index covers the PRIVATE corpus —
   * loading it here would leak private entry vectors + counts into
   * critique_ui's visual-similarity ranking. Returning null routes critique_ui
   * to the structured-retrieval fallback (critique-retrieval.ts:~121), which
   * needs no image index and serves only snapshot entries.
   */
  getImageIndex(_providerModel?: string): Promise<ReaderImageIndex | null> {
    return Promise.resolve(null);
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
   * malformed, the file doesn't exist, OR a symlink escapes the snapshot — the
   * tool handler degrades gracefully to "image not found locally".
   *
   * Containment: only `images-public/...` paths under the snapshot dir are
   * accepted; a `..` traversal or absolute path is rejected.
   *
   * F4 (Gate 1A): the previous version checked the textual path + `existsSync`
   * but NOT the resolved real path. A symlink under `images-public/` could
   * resolve outside the snapshot (e.g. to `images-private/secret.png`), and
   * `existsSync` would happily return true for it. This now mirrors the
   * exporter's `resolveSafeAssetSource` (exporter.ts:101-139): resolve the real
   * path via `realpathSync`, confirm it's contained beneath the snapshot dir,
   * and require it to be a regular file. The snapshot dir itself is resolved
   * through realpath once (cached) so the containment comparison agrees on
   * platforms where the temp dir is itself a symlink (macOS: $TMPDIR=/var/...
   * → /private/var/...). Returns null on ANY failure.
   */
  resolveImagePath(path: string): string | null {
    if (typeof path !== "string" || path.length === 0) return null;
    if (path.includes("..") || path.startsWith("/")) return null;
    // Only the public image tree is served from a snapshot. A path that doesn't
    // live under images-public/ is not part of any public snapshot.
    if (!path.startsWith("images-public/")) return null;
    const abs = resolve(this.snapshotPath, path);
    if (!existsSync(abs)) return null;

    // Resolve the snapshot root through realpath ONCE (cached) so the
    // containment check agrees even on platforms where the snapshot dir is
    // itself a symlink.
    const realRoot = this.realSnapshotRoot;
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      // Broken symlink or otherwise unresolvable → treat as not found.
      return null;
    }
    // Containment: the resolved real path must stay inside the snapshot dir.
    // relative() returns something starting with ".." (or an absolute path on
    // Windows) iff `real` escapes the snapshot root. An empty relative path
    // means real === realRoot (the dir itself, not a file) — reject.
    const relReal = relative(realRoot, real);
    if (relReal === "" || relReal.startsWith("..") || relReal.startsWith(sep)) return null;

    // Must be a regular file (reject directories, fifos, symlinks-to-dirs, etc.).
    try {
      if (!statSync(real).isFile()) return null;
    } catch {
      return null;
    }
    return abs;
  }
}
