/**
 * Corpus durability layer — atomic writes + rolling snapshots + safe-load.
 *
 * Extracted from ui-server.ts so CLIs (restore-corpus, doctor) can reuse the
 * snapshot machinery without importing ui-server (which pulls in sharp +
 * playwright). ui-server re-imports these; behavior is unchanged.
 *
 * Why this exists: a single `git checkout -- entries.json` or a buggy overwrite
 * used to be enough to lose every committed entry. These primitives make that
 * class of loss recoverable WITHOUT a database:
 *   1. Atomic write: serialize to a temp file, fs.rename over the real one. A
 *      crash mid-write leaves the prior file intact.
 *   2. Rolling snapshots: every save keeps the last N timestamped copies in
 *      corpus/.snapshots/ (gitignored). loadCorpusSafe falls back to the newest
 *      snapshot if the primary is missing or corrupt.
 *
 * Gate 1A hardening (publication integrity): the fallback chain used to
 * conflate missing/corrupt/unsupported into a single `null`, then silently
 * rewrite the primary from a snapshot or seed — which a later save could
 * persist over the real corpus. Now:
 *   - Files are classified by decodeCorpusFile (missing/current/supported-old/
 *     corrupt/unsupported-newer) before any fallback.
 *   - Snapshot + seed fallbacks are READ-ONLY (writable:false); the primary
 *     is never auto-rewritten by a load.
 *   - unsupported-newer is FATAL — no fallback. A {version:3} file must not be
 *     masked or clobbered.
 *   - persistEntries refuses a read-only LoadedCorpus, structurally preventing
 *     the seed/snapshot → save → clobber path.
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Corpus } from "./schema.js";
import type { CorpusEntryT } from "./schema.js";
import { CORPUS_ROOT as DEFAULT_CORPUS_ROOT } from "./paths.js";
import {
  decodeCorpusFile,
  CURRENT_CORPUS_VERSION,
  type CorpusDecodeResult,
} from "./corpus-version.js";

// ─── paths (test-overridable) ─────────────────────────────────────────────────
// Paths derive from CORPUS_ROOT. Tests override the root via
// setCorpusRootForTesting so the durability suite runs against an isolated temp
// directory and never touches the developer's real entries.json. Production
// callers never mutate this; null means "use the imported default".
//
// The exported `ENTRIES_PATH`/`SEED_PATH`/`SNAPSHOT_DIR` constants reflect the
// production root and are read as values by the scripts (ui-server,
// restore-corpus, doctor, commit-draft). Internal functions in this module
// resolve paths through corpusRoot() at CALL TIME — that's what makes the test
// override actually take effect for loadCorpusSafe/persistEntries/listSnapshots
// (exported `let` bindings would not reliably propagate under vitest's module
// transform, and re-pointing every script call site would be a wide ripple for
// no production benefit — scripts never run under the test seam).
let corpusRootOverride: string | null = null;

function corpusRoot(): string {
  return corpusRootOverride ?? DEFAULT_CORPUS_ROOT;
}

function entriesPath(): string { return resolve(corpusRoot(), "entries.json"); }
function seedPath(): string { return resolve(corpusRoot(), "seed.json"); }
function snapshotDir(): string { return resolve(corpusRoot(), ".snapshots"); }

/** Test-only: redirect the entire durability layer at a temp corpus root. */
export function setCorpusRootForTesting(root: string | null): void {
  corpusRootOverride = root;
}

export const ENTRIES_PATH = resolve(DEFAULT_CORPUS_ROOT, "entries.json");
export const SEED_PATH = resolve(DEFAULT_CORPUS_ROOT, "seed.json");
export const SNAPSHOT_DIR = resolve(DEFAULT_CORPUS_ROOT, ".snapshots");
export const SNAPSHOT_KEEP = 20; // keep the 20 most recent timestamped snapshots

// ─── types ───────────────────────────────────────────────────────────────────

/**
 * Loaded corpus with provenance. Carries enough to let persistence enforce
 * write protection: `writable` is false whenever the entries came from a
 * fallback (snapshot/seed/empty) rather than the primary, so a later
 * persistEntries on that LoadedCorpus throws instead of clobbering real data.
 */
export type LoadedCorpus = {
  entries: CorpusEntryT[];
  /** Where the entries came from. */
  source: "primary" | "snapshot" | "seed" | "empty";
  /** False for snapshot/seed/empty — persistEntries refuses these. */
  writable: boolean;
  /** The corpus-envelope version of the source file (2 today). */
  version: number;
};

/** Return snapshot paths newest-first (by embedded epoch), or [] if none. */
export function listSnapshots(): string[] {
  try {
    const dir = snapshotDir();
    return readdirSync(dir)
      .filter((f) => /^entries-\d+\.json$/.test(f))
      .map((f) => resolve(dir, f))
      .sort((a, b) => {
        // entries-<epoch>.json — sort by the embedded epoch, desc.
        const ta = Number(a.match(/entries-(\d+)\.json$/)?.[1] ?? 0);
        const tb = Number(b.match(/entries-(\d+)\.json$/)?.[1] ?? 0);
        return tb - ta;
      });
  } catch { return []; }
}

/**
 * Read + classify a corpus file. Returns null when the file is missing or
 * unreadable (the historical contract every caller relies on), and throws on
 * unsupported-newer so the caller fails visibly rather than silently falling
 * back. Use decodeCorpusFile directly when you need the full classification.
 *
 * The decoded entries are wrapped as a writable LoadedCorpus (the caller
 * decides provenance — tryReadCorpus itself doesn't know if it's reading the
 * primary, a snapshot, or the seed).
 */
export function tryReadCorpus(path: string): LoadedCorpus | null {
  const result = decodeCorpusFile(path);
  return fromDecodeResult(result);
}

/**
 * Map a decode result to a LoadedCorpus (or throw/return null). Centralizing
 * this keeps the "unsupported-newer is fatal" rule in one place.
 *
 *   missing            → null  (caller may fall back)
 *   current/old        → writable LoadedCorpus
 *   corrupt            → null  (caller may fall back)
 *   unsupported-newer  → THROW (fatal — no fallback)
 */
function fromDecodeResult(result: CorpusDecodeResult): LoadedCorpus | null {
  switch (result.kind) {
    case "missing":
      return null;
    case "corrupt":
      return null;
    case "unsupported-newer":
      throw new Error(
        `[corpus] ${result.path} is version ${result.version}, which this build cannot read `
        + `(current: ${CURRENT_CORPUS_VERSION}). Refusing to fall back — a silent fallback here `
        + `would risk overwriting the newer file. Upgrade clean-ui-mcp to read the unsupported newer version.`,
      );
    case "current":
    case "supported-old":
      return {
        entries: result.entries,
        source: "primary", // provenance refined by loadCorpusSafe based on which file it read
        writable: true,
        version: result.version,
      };
  }
}

/**
 * Load the corpus with the hardened fallback chain. Returns a LoadedCorpus
 * carrying provenance + writability:
 *
 *   1. Primary readable      → source "primary",  writable true.
 *   2. Primary missing/corrupt, newest snapshot readable
 *                            → source "snapshot", writable FALSE. Content is
 *                              recovered but the primary is NOT auto-rewritten
 *                              (that was the bug). An explicit restore-corpus
 *                              call rewrites the primary when intended.
 *   3. No snapshot, seed     → source "seed",     writable FALSE.
 *   4. Nothing               → source "empty",    writable FALSE.
 *
 * `unsupported-newer` is fatal (thrown by tryReadCorpus) regardless of whether
 * a snapshot/seed exists — we never silently mask a future version.
 */
export function loadCorpusSafe(): LoadedCorpus {
  const primary = tryReadCorpus(entriesPath());
  if (primary) {
    return { ...primary, source: "primary" };
  }

  for (const snap of listSnapshots()) {
    const recovered = tryReadCorpus(snap);
    if (recovered) {
      console.error(
        `[corpus] entries.json unreadable — recovered ${recovered.entries.length} entries `
        + `from ${snap}. Primary NOT auto-rewritten; run restore-corpus to persist the recovery.`,
      );
      return { ...recovered, source: "snapshot", writable: false };
    }
  }

  // No primary, no snapshot — fall back to the shipped seed so a fresh clone is
  // usable (an agent can call search and get a real response). The seed is a
  // minimal schema example; the curator's real corpus lives in entries.json,
  // which is gitignored (it references private images + screenshot metadata).
  // READ-ONLY: never restore the primary from the seed.
  const seed = tryReadCorpus(seedPath());
  if (seed) {
    console.error(
      `[corpus] entries.json not found — using seed.json (${seed.entries.length} entries, READ-ONLY). `
      + `Your working corpus is built via the UI/CLI.`,
    );
    return { ...seed, source: "seed", writable: false };
  }

  console.error("[corpus] entries.json unreadable, no snapshots, no seed — starting empty (READ-ONLY).");
  return { entries: [], source: "empty", writable: false, version: CURRENT_CORPUS_VERSION };
}

/** Write `content` to `path` atomically: temp file + rename. */
export function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path); // atomic on POSIX and Windows
}

/** Write a timestamped raw corpus snapshot. Errors intentionally propagate. */
export function writeRawSnapshot(content: string): void {
  const dir = snapshotDir();
  mkdirSync(dir, { recursive: true });
  const stamped = resolve(dir, `entries-${Date.now()}.json`);
  writeAtomic(stamped, content.endsWith("\n") ? content : `${content}\n`);
  const all = listSnapshots();
  if (all.length > SNAPSHOT_KEEP) {
    for (const stale of all.slice(SNAPSHOT_KEEP)) unlinkSync(stale);
  }
}

/**
 * Keep a rolling timestamped snapshot of the corpus.
 *
 * `version` defaults to the current corpus version. Accepting it explicitly
 * (rather than hardcoding 2) means the serialized envelope carries whatever
 * version the writer loaded — no silent version drift across snapshot writes.
 */
export function writeSnapshot(entries: CorpusEntryT[], version: number = CURRENT_CORPUS_VERSION): void {
  try {
    writeRawSnapshot(JSON.stringify({ version, entries }, null, 2));
  } catch (err) {
    console.error("[corpus] snapshot write failed (non-fatal):", err instanceof Error ? err.message : err);
  }
}

/**
 * Persist entries: snapshot the current state, then atomic-write the primary.
 * Returns the serialized corpus string so callers that need it (e.g. for an
 * integrity hash) don't re-serialize. The dHash-cache rebuild is the caller's
 * responsibility (ui-server.saveEntries does it) to keep this module free of
 * sharp/perceptual-hashing deps.
 *
 * WRITE PROTECTION (Gate 1A): pass the LoadedCorpus the caller loaded. If it's
 * not writable (source = snapshot/seed/empty), this throws — structurally
 * preventing the seed/snapshot → save → clobber path that could overwrite a
 * 787-entry working corpus with a 1-entry seed. Callers that legitimately
 * want to write a fresh set of entries (e.g. restore-corpus, commit-draft)
 * pass a writable LoadedCorpus loaded from the primary, or construct one via
 * `writableLoadedCorpus(entries)` when they've already validated that intent.
 *
 * The serialized envelope version comes from `loaded.version` (not a hardcoded
 * 2) so a future version bump flows through automatically.
 */
export function persistEntries(loaded: LoadedCorpus, entries: CorpusEntryT[]): string {
  if (!loaded.writable) {
    throw new Error(
      `[corpus] refusing to persist: LoadedCorpus is READ-ONLY (source: ${loaded.source}). `
      + `Writing would risk overwriting the primary with fallback content. `
      + `Load the primary first, or use restore-corpus for an explicit recovery.`,
    );
  }
  const version = loaded.version;
  const corpus = Corpus.parse({ version, entries });
  // Snapshot BEFORE the overwrite, so a failure mid-write leaves the prior
  // state recoverable. Then atomic-write the primary.
  writeSnapshot(entries, version);
  const serialized = `${JSON.stringify(corpus, null, 2)}\n`;
  writeAtomic(entriesPath(), serialized);
  return serialized;
}

/**
 * Construct a writable LoadedCorpus for callers that have already validated
 * their intent to write the given entries and don't have a primary-loaded
 * corpus to thread through (e.g. restore-corpus overwriting the primary from a
 * chosen snapshot, commit-draft appending approved entries).
 *
 * This is an explicit opt-in to writing — it exists so the write-protect on
 * persistEntries is structural, not just advisory. Prefer passing the
 * LoadedCorpus returned by loadCorpusSafe() when you have one.
 */
export function writableLoadedCorpus(entries: CorpusEntryT[], version: number = CURRENT_CORPUS_VERSION): LoadedCorpus {
  return { entries, source: "primary", writable: true, version };
}
