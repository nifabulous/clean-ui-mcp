#!/usr/bin/env node
/**
 * dedup-cleanup.ts
 * ────────────────
 * Finds duplicate clusters in the corpus (exact SHA-256 + dHash near-dup),
 * scores each entry by completeness, keeps the winner, and removes the losers.
 *
 * Usage:
 *   npm run dedup-cleanup                        (dry-run — report only)
 *   npm run dedup-cleanup -- --confirm           (apply: remove losers + orphaned images)
 *   npm run dedup-cleanup -- --threshold 15      (wider near-dup window — pHash watch-item)
 *   npm run dedup-cleanup -- --json              (machine-readable output)
 *
 * Apply order (safe): persist the reduced corpus FIRST (snapshot + atomic
 * write), THEN delete orphaned image files. If deletion fails after persist,
 * the worst case is harmless orphan files (clean-orphans collects them later)
 * — never a broken corpus with refs to deleted files.
 */
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { hasDraftMarkers, type CorpusEntryT } from "../schema.js";
import { fromCorpusRelativeImagePath } from "../paths.js";
import { loadCorpusSafe, persistEntries } from "../persistence.js";
import { computeDHash, hammingDistance, DHASH_THRESHOLD, fingerprintFor, type CachedFingerprint } from "../dedup.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const rawArgs = process.argv.slice(2);
const confirm = rawArgs.includes("--confirm");
const jsonOut = rawArgs.includes("--json");
const thresholdIdx = rawArgs.indexOf("--threshold");
const threshold = thresholdIdx >= 0 && rawArgs[thresholdIdx + 1]
  ? Number(rawArgs[thresholdIdx + 1])
  : DHASH_THRESHOLD;

if (Number.isNaN(threshold)) {
  console.error("Invalid --threshold value");
  process.exit(1);
}

/**
 * Score an entry by completeness — higher is better, wins the cluster.
 * Weights favor reviewed + clean + rich entries over drafts + dirty + sparse.
 */
export function completenessScore(entry: CorpusEntryT): number {
  let score = 0;
  // reviewStatus: approved >> draft
  if (entry.reviewStatus === "approved") score += 100;
  // No draft markers = real text, not placeholders
  if (!hasDraftMarkers(entry)) score += 50;
  // Provenance: human > auto-reviewed > auto
  const taggedBy = entry.provenance?.taggedBy;
  if (taggedBy === "human") score += 30;
  else if (taggedBy === "auto-reviewed") score += 20;
  else if (taggedBy === "auto") score += 10;
  // Richer content wins
  score += (entry.critique?.length ?? 0);
  score += (entry.whatToSteal?.length ?? 0) * 5;
  score += (entry.qualityScore ?? 3);
  return score;
}

async function main() {
  const entries = loadCorpusSafe();
  if (entries.length === 0) {
    console.log("Corpus is empty — nothing to dedup.");
    process.exit(0);
  }

  // ── Fingerprint every entry ──────────────────────────────────────────────
  const fps: Array<{ entry: CorpusEntryT; fp: CachedFingerprint | null }> = [];
  for (const entry of entries) {
    const fp = await fingerprintFor(entry);
    fps.push({ entry, fp });
  }

  // ── Cluster via union-find (exact SHA-256 OR dHash Hamming < threshold) ───
  const n = fps.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a: number, b: number): void { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

  // Group by exact SHA-256 first (fast O(n) bucketing for the common case).
  const byHash = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const fp = fps[i].fp;
    if (!fp) continue;
    if (!byHash.has(fp.hash)) byHash.set(fp.hash, []);
    byHash.get(fp.hash)!.push(i);
  }
  for (const indices of byHash.values()) {
    for (let j = 1; j < indices.length; j++) union(indices[0], indices[j]);
  }

  // Near-dup: O(n²) dHash comparison for entries with a valid dHash.
  // For ~1000 entries this is ~500k comparisons — a few seconds.
  const withDhash = fps.map((f, i) => ({ i, dhash: f.fp?.dhash })).filter(x => !!x.dhash);
  for (let a = 0; a < withDhash.length; a++) {
    for (let b = a + 1; b < withDhash.length; b++) {
      if (find(withDhash[a].i) === find(withDhash[b].i)) continue; // already same cluster
      const d = hammingDistance(withDhash[a].dhash!, withDhash[b].dhash!);
      if (d < threshold) union(withDhash[a].i, withDhash[b].i);
    }
  }

  // Collect clusters (only those with >1 member).
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(i);
  }
  const dupClusters = [...clusters.values()].filter(group => group.length > 1);

  if (dupClusters.length === 0) {
    const msg = `No duplicate clusters found (${entries.length} entries, threshold ${threshold}).`;
    if (jsonOut) console.log(JSON.stringify({ entries: entries.length, clusters: 0, removed: 0 }));
    else console.log(msg);
    process.exit(0);
  }

  // ── Score + pick winners ─────────────────────────────────────────────────
  const losers: CorpusEntryT[] = [];
  const report = dupClusters.map(group => {
    const scored = group.map(i => ({ entry: fps[i].entry, score: completenessScore(fps[i].entry) }));
    // Sort by score desc, tie-break newer addedAt wins.
    scored.sort((a, b) => b.score - a.score || (b.entry.addedAt || "").localeCompare(a.entry.addedAt || ""));
    const winner = scored[0];
    const clusterLosers = scored.slice(1);
    losers.push(...clusterLosers.map(s => s.entry));
    return { winner: winner.entry.id, winnerScore: winner.score, losers: clusterLosers.map(s => ({ id: s.entry.id, score: s.score })) };
  });

  // ── Report ───────────────────────────────────────────────────────────────
  if (jsonOut) {
    console.log(JSON.stringify({
      entries: entries.length,
      clusters: dupClusters.length,
      removed: losers.length,
      remaining: entries.length - losers.length,
      threshold,
      details: report,
    }, null, 2));
  } else {
    console.log(`Found ${dupClusters.length} duplicate cluster(s) — ${losers.length} loser(s) to remove (threshold ${threshold}).\n`);
    for (const r of report) {
      console.log(`  KEEP: ${r.winner} (score ${r.winnerScore})`);
      for (const l of r.losers) console.log(`    remove: ${l.id} (score ${l.score})`);
    }
    console.log(`\n${confirm ? "Applying..." : "Dry run — use --confirm to apply."}`);
  }

  if (!confirm) process.exit(0);

  // ── Apply: persist FIRST, delete files SECOND ────────────────────────────
  // P1 fix: if deletion fails after persist, the worst case is harmless orphan
  // files (clean-orphans collects them). Never a corpus referencing deleted files.
  const loserIds = new Set(losers.map(e => e.id));
  const remaining = entries.filter(e => !loserIds.has(e.id));

  if (!jsonOut) console.log(`\nPersisting ${remaining.length} entries (was ${entries.length})…`);
  persistEntries(remaining);

  // P1 fix: only delete loser images that NO remaining entry still references.
  // A winner in the same cluster may share the same image.path (e.g. bulk-import
  // copied the file under different entry IDs but the same corpus-relative path).
  // Deleting it would break the winner's reference. Build a set of all paths the
  // surviving corpus points at, and skip any loser path that's still referenced.
  const remainingImagePaths = new Set(
    remaining.map(e => e.image.path).filter((p): p is string => !!p)
  );
  const loserPathsToDelete = losers
    .map(e => e.image.path)
    .filter((p): p is string => !!p && !remainingImagePaths.has(p));
  const skippedShared = losers.length - loserPathsToDelete.length;

  if (!jsonOut) {
    console.log(`Deleting ${loserPathsToDelete.length} orphaned image(s)…`);
    if (skippedShared > 0) console.log(`  (${skippedShared} loser(s) shared a path with a kept entry — image retained)`);
  }
  let delErrors = 0;
  for (const rel of loserPathsToDelete) {
    try {
      const abs = fromCorpusRelativeImagePath(rel);
      rmSync(abs, { force: false });
    } catch (e) {
      if (!jsonOut) console.error(`  ⚠ Could not delete ${rel}: ${e instanceof Error ? e.message : e}`);
      delErrors++;
    }
  }

  if (jsonOut) {
    // P2 fix: in JSON mode, emit ONE final JSON object. Human logs above were
    // suppressed; errors land in the object, not mixed into stdout.
    console.log(JSON.stringify({
      applied: true,
      entriesBefore: entries.length,
      entriesAfter: remaining.length,
      removed: losers.length,
      clusters: dupClusters.length,
      imagesDeleted: loserPathsToDelete.length,
      imagesSharedRetained: skippedShared,
      deletionErrors: delErrors,
      threshold,
    }, null, 2));
  } else {
    console.log(`\n✅ Removed ${losers.length} duplicate(s) across ${dupClusters.length} cluster(s).`);
    if (delErrors > 0) {
      console.log(`  ${delErrors} image(s) could not be deleted — run npm run clean-orphans later.`);
    }
  }
  if (delErrors > 0) process.exit(1);
}

// Only run the CLI when invoked directly — NOT when imported for testing
// (dedup.test.ts imports completenessScore from this module).
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
