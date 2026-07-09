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
 */
import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Corpus } from "./schema.js";
import type { CorpusEntryT } from "./schema.js";
import { CORPUS_ROOT } from "./paths.js";

export const ENTRIES_PATH = resolve(CORPUS_ROOT, "entries.json");
export const SEED_PATH = resolve(CORPUS_ROOT, "seed.json");
export const SNAPSHOT_DIR = resolve(CORPUS_ROOT, ".snapshots");
export const SNAPSHOT_KEEP = 20; // keep the 20 most recent timestamped snapshots

/** Return snapshot paths newest-first (by embedded epoch), or [] if none. */
export function listSnapshots(): string[] {
  try {
    return readdirSync(SNAPSHOT_DIR)
      .filter((f) => /^entries-\d+\.json$/.test(f))
      .map((f) => resolve(SNAPSHOT_DIR, f))
      .sort((a, b) => {
        // entries-<epoch>.json — sort by the embedded epoch, desc.
        const ta = Number(a.match(/entries-(\d+)\.json$/)?.[1] ?? 0);
        const tb = Number(b.match(/entries-(\d+)\.json$/)?.[1] ?? 0);
        return tb - ta;
      });
  } catch { return []; }
}

/** Parse a JSON corpus file, or null if missing/corrupt/unparseable. */
export function tryReadCorpus(path: string): CorpusEntryT[] | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return Corpus.parse(raw).entries;
  } catch { return null; }
}

/**
 * Load the corpus with snapshot fallback. Primary file first; if missing/corrupt,
 * fall back to the newest readable snapshot (and restore the primary from it so
 * subsequent reads are clean). If no snapshot either, start empty rather than
 * crash. This is the only load path that survives a bad overwrite.
 */
export function loadCorpusSafe(): CorpusEntryT[] {
  const primary = tryReadCorpus(ENTRIES_PATH);
  if (primary) return primary;
  for (const snap of listSnapshots()) {
    const recovered = tryReadCorpus(snap);
    if (recovered) {
      console.error(`[corpus] entries.json unreadable — recovered ${recovered.length} entries from ${snap}. Restoring primary.`);
      try { writeAtomic(ENTRIES_PATH, `${JSON.stringify({ version: 2, entries: recovered }, null, 2)}\n`); } catch { /* best-effort */ }
      return recovered;
    }
  }
  // No primary, no snapshot — fall back to the shipped seed so a fresh clone is
  // usable (an agent can call search and get a real response). The seed is a
  // minimal schema example; the curator's real corpus lives in entries.json,
  // which is gitignored (it references private images + screenshot metadata).
  const seed = tryReadCorpus(SEED_PATH);
  if (seed) {
    console.error(`[corpus] entries.json not found — using seed.json (${seed.length} entries). Your working corpus is built via the UI/CLI.`);
    return seed;
  }
  console.error("[corpus] entries.json unreadable, no snapshots, no seed — starting empty.");
  return [];
}

/** Write `content` to `path` atomically: temp file + rename. */
export function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path); // atomic on POSIX and Windows
}

/** Write a timestamped raw corpus snapshot. Errors intentionally propagate. */
export function writeRawSnapshot(content: string): void {
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const stamped = resolve(SNAPSHOT_DIR, `entries-${Date.now()}.json`);
  writeAtomic(stamped, content.endsWith("\n") ? content : `${content}\n`);
  const all = listSnapshots();
  if (all.length > SNAPSHOT_KEEP) {
    for (const stale of all.slice(SNAPSHOT_KEEP)) unlinkSync(stale);
  }
}

/** Keep a rolling timestamped snapshot of the corpus. */
export function writeSnapshot(entries: CorpusEntryT[]): void {
  try {
    writeRawSnapshot(JSON.stringify({ version: 2, entries }, null, 2));
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
 */
export function persistEntries(entries: CorpusEntryT[]): string {
  const corpus = Corpus.parse({ version: 2, entries });
  // Snapshot BEFORE the overwrite, so a failure mid-write leaves the prior
  // state recoverable. Then atomic-write the primary.
  writeSnapshot(entries);
  const serialized = `${JSON.stringify(corpus, null, 2)}\n`;
  writeAtomic(ENTRIES_PATH, serialized);
  return serialized;
}
