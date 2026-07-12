#!/usr/bin/env node
/**
 * restore-corpus.ts — recover the corpus from a snapshot.
 *
 * The UI server snapshots every save (corpus/.snapshots/, rolling 20). This CLI
 * turns that into a first-class recovery command: inspect, diff, and restore.
 *
 * Usage:
 *   npm run restore-corpus -- --list            list snapshots (counts + ages)
 *   npm run restore-corpus -- --latest          restore the newest snapshot
 *   npm run restore-corpus -- --snapshot <name> restore a specific snapshot
 *   npm run restore-corpus -- --latest --dry-run   show the diff, don't write
 *
 * Before any write, it prints: current → target counts, added/removed ids,
 * duplicate ids (a data-integrity red flag), and Zod validation status. The
 * restore takes a fresh snapshot of the CURRENT state first, so a bad restore is
 * itself recoverable. The dHash cache is invalidated so it rebuilds lazily.
 */
import { existsSync, unlinkSync } from "node:fs";
import { basename, resolve } from "node:path";
import { hasDraftMarkers, type CorpusEntryT } from "../schema.js";
import { ENTRIES_PATH, SNAPSHOT_DIR, listSnapshots, tryReadCorpus, writeSnapshot, persistEntries, writableLoadedCorpus, type LoadedCorpus } from "../persistence.js";
import { CORPUS_ROOT } from "../paths.js";

const DHASH_CACHE_PATH = resolve(CORPUS_ROOT, ".dhash-cache.json");

// ── exported pure logic (unit-tested directly, no subprocess spawning) ───────

/** Parse a --snapshot argument (full path, relative, or bare filename) to an absolute path. */
export function resolveSnapshotArg(arg: string): string {
  if (existsSync(arg)) return resolve(arg);
  const inDir = resolve(SNAPSHOT_DIR, arg);
  if (existsSync(inDir)) return inDir;
  const withExt = resolve(SNAPSHOT_DIR, arg.endsWith(".json") ? arg : `${arg}.json`);
  return withExt; // caller checks existence; returns the most-likely path for error msgs
}

/** Extract the embedded epoch from an entries-<epoch>.json filename. */
export function epochFromName(name: string): number {
  return Number(name.match(/entries-(\d+)\.json$/)?.[1] ?? 0);
}

/** Find duplicate ids in a snapshot — a corruption red flag worth surfacing. */
export function findDuplicateIds(entries: CorpusEntryT[]): string[] {
  const seen = new Set<string>();
  const dupes: string[] = [];
  for (const e of entries) {
    if (seen.has(e.id)) dupes.push(e.id);
    seen.add(e.id);
  }
  return dupes;
}

/**
 * Read a corpus file without throwing. tryReadCorpus returns null for
 * missing/corrupt files but THROWS on unsupported-newer (a {version:3} file is
 * fatal by design). restore-corpus lists/inspects snapshots and the current
 * corpus; a single unsupported-newer file among them must not crash the whole
 * listing. Catch the throw here, log it, and return null so callers treat it as
 * unreadable — the same outcome as a corrupt file. The distinct error message
 * still surfaces on stderr so the user sees WHY it was skipped.
 */
export function safeTryRead(path: string): LoadedCorpus | null {
  try {
    return tryReadCorpus(path);
  } catch (err) {
    console.error(`[restore-corpus] ${err instanceof Error ? err.message : String(err)} — treating as unreadable.`);
    return null;
  }
}

/** The structured diff between current and target — what restore will change. */
export interface RestoreDiff {
  currentCount: number;
  targetCount: number;
  added: string[];       // ids in target but not current
  removed: string[];     // ids in current but not target
  duplicateIds: string[];// ids appearing >1× in target (corruption)
  draftIssues: number;   // entries in target carrying draft markers (non-blocking)
}

/** Compute the restore diff without touching disk (beyond reading the two sets). */
export function computeRestoreDiff(current: CorpusEntryT[], target: CorpusEntryT[]): RestoreDiff {
  const currentIds = new Set(current.map((e) => e.id));
  const targetIds = new Set(target.map((e) => e.id));
  return {
    currentCount: current.length,
    targetCount: target.length,
    added: [...targetIds].filter((id) => !currentIds.has(id)),
    removed: [...currentIds].filter((id) => !targetIds.has(id)),
    duplicateIds: findDuplicateIds(target),
    draftIssues: target.filter((e) => hasDraftMarkers(e)).length,
  };
}

export function ageLabel(epochMs: number): string {
  const mins = Math.round((Date.now() - epochMs) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

// ── CLI entry point (run only when executed directly) ────────────────────────

function getArg(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function printDiff(diff: RestoreDiff, targetLabel: string): void {
  console.log(`\n  target: ${targetLabel} (${basename(targetLabel)})`);
  console.log(`  count:  ${diff.currentCount} → ${diff.targetCount}`);
  if (diff.added.length) console.log(`  added:  ${diff.added.length} id(s) — ${diff.added.slice(0, 8).join(", ")}${diff.added.length > 8 ? `, …(+${diff.added.length - 8})` : ""}`);
  if (diff.removed.length) console.log(`  removed:${diff.removed.length} id(s) — ${diff.removed.slice(0, 8).join(", ")}${diff.removed.length > 8 ? `, …(+${diff.removed.length - 8})` : ""}`);
  if (!diff.added.length && !diff.removed.length) console.log("  no id-level changes (content may still differ)");
  if (diff.duplicateIds.length) console.log(`  ⚠ duplicate ids in target: ${diff.duplicateIds.join(", ")} — restoring will carry the corruption`);
  if (diff.draftIssues) console.log(`  ⚠ ${diff.draftIssues} entr${diff.draftIssues === 1 ? "y" : "ies"} in target carry draft markers (non-blocking)`);
}

function main(): void {
  const args = process.argv.slice(2);
  const wantList = args.includes("--list");
  const wantLatest = args.includes("--latest");
  const dryRun = args.includes("--dry-run");
  const snapshotArg = getArg(args, "--snapshot");

  // ── --list ─────────────────────────────────────────────────────────────────
  if (wantList) {
    const snaps = listSnapshots();
    if (!snaps.length) {
      console.log(`No snapshots found in ${SNAPSHOT_DIR}.`);
      process.exit(0);
    }
    const current = safeTryRead(ENTRIES_PATH)?.entries ?? [];
    console.log(`Current corpus: ${current.length} entries\n`);
    console.log("Snapshots (newest first):");
    for (const snap of snaps) {
      const loaded = safeTryRead(snap);
      const name = basename(snap);
      const count = loaded ? `${loaded.entries.length}` : "UNREADABLE";
      console.log(`  ${name}  ${count.padStart(4)} entries  ${ageLabel(epochFromName(name)).padStart(8)}  ${loaded ? "valid" : "corrupt"}`);
    }
    console.log(`\nRestore with: npm run restore-corpus -- --latest`);
    process.exit(0);
  }

  // ── pick the target snapshot ───────────────────────────────────────────────
  const snaps = listSnapshots();
  if (!snaps.length) {
    console.error(`No snapshots found in ${SNAPSHOT_DIR}. Nothing to restore.`);
    process.exit(1);
  }

  let targetPath: string;
  if (snapshotArg) {
    targetPath = resolveSnapshotArg(snapshotArg);
    if (!existsSync(targetPath)) {
      console.error(`Snapshot not found: ${snapshotArg} (resolved ${targetPath})`);
      console.error(`Available snapshots:\n${snaps.map((s) => "  " + basename(s)).join("\n")}`);
      process.exit(1);
    }
  } else if (wantLatest) {
    targetPath = snaps[0]; // listSnapshots is newest-first
  } else {
    console.error("Specify what to restore: --latest, --snapshot <name>, or --list to see options.");
    process.exit(1);
  }

  const targetLoaded = safeTryRead(targetPath);
  if (!targetLoaded) {
    console.error(`Snapshot is corrupt or unparseable: ${targetPath}`);
    process.exit(1);
  }
  const target = targetLoaded.entries;

  const current = safeTryRead(ENTRIES_PATH)?.entries ?? [];
  const diff = computeRestoreDiff(current, target);
  console.log("Restore plan:");
  printDiff(diff, targetPath);

  if (dryRun) {
    console.log("\n--dry-run: no changes written.");
    process.exit(0);
  }

  // ── restore: snapshot current state first, then write the target ───────────
  // Snapshot the CURRENT state so a mistaken restore is itself recoverable.
  if (current.length) {
    writeSnapshot(current, targetLoaded.version);
    console.log(`\n  ✓ snapshotted current state (${current.length} entries) before overwrite`);
  }

  // Explicit restore: the user chose to overwrite the primary from this
  // snapshot, so wrap the target as a writable LoadedCorpus. This is the
  // sanctioned escape hatch around persistEntries' write-protect — restore is
  // exactly the "I definitely want to write these" case.
  persistEntries(writableLoadedCorpus(target, targetLoaded.version), target);
  console.log(`  ✓ restored ${target.length} entries to ${ENTRIES_PATH}`);

  // Invalidate the dHash cache — restored entries may point at different images,
  // and stale fingerprints would poison future duplicate checks. It rebuilds
  // lazily on the next server start / duplicate check.
  try {
    if (existsSync(DHASH_CACHE_PATH)) {
      unlinkSync(DHASH_CACHE_PATH);
      console.log("  ✓ invalidated dHash cache (will rebuild on next server start)");
    }
  } catch { /* best-effort */ }

  console.log(`\nDone. ${target.length} entries restored. Restart \`npm run ui\` to pick up the change.`);
}

// Run main() only when executed directly (not when imported by tests).
import { fileURLToPath } from "node:url";
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
