import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { resolve, relative, sep } from "node:path";
import type { CorpusEntryT } from "../schema.js";
import { evaluatePublication } from "./policy.js";
import {
  deriveSnapshotId,
  serializeManifest,
  sha256,
  type PublicSnapshotAsset,
  type PublicSnapshotManifest,
} from "./manifest.js";

/**
 * publication/exporter.ts — the public snapshot export pipeline (Task 3, Gate
 * 1A Publication Integrity).
 *
 * Consumes validated corpus entries, evaluates each for publication eligibility
 * via the (pure) policy evaluator, and produces a DIRECTORY-ATOMIC public
 * snapshot under `<snapshotDir>/<snapshotId>/`:
 *
 *   manifest.json         ← integrity manifest (entry/asset SHA-256s)
 *   entries.json          ← eligible entries only (bare JSON array)
 *   images-public/<asset> ← the raster tree, paths preserved verbatim
 *
 * Why directory-atomic (not file-atomic): a snapshot is a tree of files that
 * must appear together or not at all. `writeAtomic` (persistence.ts) handles a
 * single file; here we stage the whole tree in a sibling `.staging-<pid>-<rand>`
 * dir on the SAME filesystem as the destination, then `renameSync(staging,
 * final)` for an atomic commit. A crash before the rename leaves no visible
 * snapshot — only staging residue, which is never a published snapshot.
 *
 * Defense in depth: the policy evaluator already excludes entries whose image
 * path doesn't start with `images-public/` or whose file is missing. The
 * exporter re-checks BOTH at copy time (path containment + symlink escape), so
 * a bug in the evaluator can't leak a private file into the public snapshot.
 */

/**
 * Inputs to {@link exportPublicSnapshot}. All paths/entries are parameters (not
 * read from global state) so the pipeline is fully testable.
 *
 *   - `corpusEntries`: the full validated corpus (the caller loads it; the
 *     exporter does not read entries.json itself).
 *   - `snapshotDir`: the PARENT directory snapshots live under
 *     (corpus/public-snapshots in production). Each snapshot gets a
 *     `<snapshotId>/` subdirectory.
 *   - `imageRoot`: the SOURCE public image root (corpus/images-public in
 *     production). Assets are copied FROM here into the staging tree preserving
 *     their `images-public/<asset>` relative path.
 *   - `now`: ISO 8601 timestamp for `generatedAt`. Injected for deterministic
 *     tests. The publication-eligibility date (expiry check) is derived from it.
 */
export interface ExportPublicSnapshotInput {
  corpusEntries: CorpusEntryT[];
  snapshotDir: string;
  imageRoot: string;
  now: string; // ISO 8601
}

/** The result of a successful export. */
export interface ExportResult {
  /** The content-derived snapshot id (also the subdirectory name). */
  snapshotId: string;
  /** Absolute path to the committed snapshot directory. */
  snapshotPath: string;
  /** Number of eligible entries written. 0 is a success (empty-eligible). */
  entryCount: number;
  /** Number of asset files copied into the snapshot. */
  assetCount: number;
}

/** The YYYY-MM-DD publication date derived from an ISO 8601 timestamp. */
function isoToDate(iso: string): string {
  // The policy evaluator takes a YYYY-MM-DD `now`. Derive it from the ISO
  // timestamp by taking the first 10 chars (the date portion). This avoids
  // pulling in a date lib and keeps the derivation pure + testable.
  return iso.slice(0, 10);
}

/**
 * Resolve a corpus-relative image path to its absolute source location under
 * `imageRoot`, AFTER symlink resolution, and verify the real path is contained
 * within `imageRoot`. Returns null if the path is missing, escapes the root, or
 * is not a regular file.
 *
 * This is the defense-in-depth gate: even if an entry's `image.path` starts
 * with `images-public/`, a symlink inside the tree could resolve outside it.
 * We refuse to copy any file whose real path leaves `imageRoot`.
 */
function resolveSafeAssetSource(
  corpusRelPath: string,
  imageRoot: string,
): { abs: string; real: string } | null {
  // corpusRelPath looks like "images-public/<asset>". The SOURCE image root is
  // the images-public directory itself, so strip the leading "images-public/"
  // segment to get the path relative to imageRoot.
  const prefix = "images-public/";
  if (!corpusRelPath.startsWith(prefix)) return null;
  const rel = corpusRelPath.slice(prefix.length);
  if (rel.length === 0 || rel.includes("..") || rel.startsWith("/")) return null;

  const abs = resolve(imageRoot, rel);
  if (!existsSync(abs)) return null;

  // Resolve symlinks: the real path must stay inside imageRoot. realpathSync
  // throws on a broken symlink — treat that as "unresolvable."
  let real: string;
  try {
    real = realpathSync(abs);
  } catch {
    return null;
  }

  // Containment check: the resolved real path must live inside imageRoot.
  // relative() returns something starting with ".." (or an absolute path on
  // Windows) iff `real` escapes `imageRoot`. The imageRoot itself is not a
  // valid asset (it's a directory), so reject an empty relative path too.
  const relReal = relative(imageRoot, real);
  if (relReal === "" || relReal.startsWith("..") || relReal.startsWith(sep)) return null;

  // Must be a regular file (reject directories, fifos, etc.).
  try {
    if (!statSync(real).isFile()) return null;
  } catch {
    return null;
  }
  return { abs, real };
}

/**
 * Export a public snapshot. See the module docstring for the full pipeline.
 *
 * Stages: evaluate → stage dir → copy assets → write entries.json → hash →
 * write manifest → verify hashes against bytes-on-disk → atomic rename.
 *
 * Empty-eligible is a SUCCESS (entryCount: 0), not an error. A crash before the
 * final rename leaves no visible snapshot. An existing snapshot id is refused.
 */
export function exportPublicSnapshot(input: ExportPublicSnapshotInput): ExportResult {
  const { corpusEntries, snapshotDir, imageRoot, now } = input;
  const pubDate = isoToDate(now);

  // Resolve the image root through realpath ONCE so the containment check
  // (which compares against the symlink-resolved asset path) agrees with it
  // even on platforms where the temp dir itself is a symlink (macOS:
  // $TMPDIR=/var/... resolves to /private/var/...). If the root doesn't exist
  // yet, fall back to the as-passed path (the eligibility check will then
  // report every image as missing, which is correct).
  const realImageRoot = existsSync(imageRoot) ? realpathSync(imageRoot) : imageRoot;

  // ── 1. Evaluate eligibility ────────────────────────────────────────────────
  // imageExists is a PLAIN existence check for the policy evaluator's
  // `image-file-missing` reason — it answers "does a file exist at this
  // corpus-relative path under the image root?" The traversal/symlink-escape
  // defense is a COPY-TIME concern (below), kept separate so a legitimate
  // missing file reports `image-file-missing` (entry excluded) while a present
  // but escaping file reaches the copy stage and is rejected there.
  const imageExists = (corpusRelPath: string): boolean => {
    const prefix = "images-public/";
    if (!corpusRelPath.startsWith(prefix)) return false;
    const rel = corpusRelPath.slice(prefix.length);
    if (rel.length === 0 || rel.includes("..") || rel.startsWith("/")) return false;
    return existsSync(resolve(realImageRoot, rel));
  };

  const eligible: CorpusEntryT[] = [];
  for (const entry of corpusEntries) {
    const decision = evaluatePublication(entry, { now: pubDate, imageExists });
    if (decision.eligible) eligible.push(entry);
  }

  // Collect the distinct asset paths from eligible entries. An entry's
  // image.path is already "images-public/<asset>"; dedupe so a shared asset is
  // copied + hashed once.
  const assetRelPaths = Array.from(
    new Set(
      eligible
        .map((e) => e.image.path)
        .filter((p): p is string => typeof p === "string" && p.startsWith("images-public/")),
    ),
  );

  // ── 2. Stage dir on the SAME filesystem as the destination ────────────────
  // rename atomicity requires the staging dir to be on the same filesystem as
  // the destination, so we nest it directly under snapshotDir.
  mkdirSync(snapshotDir, { recursive: true });
  const stagingDir = resolve(snapshotDir, `.staging-${process.pid}-${randomBytes(6).toString("hex")}`);
  const stagingImageRoot = resolve(stagingDir, "images-public");
  mkdirSync(stagingImageRoot, { recursive: true });

  try {
    // ── 3. Copy eligible assets, preserving images-public/<asset> structure ──
    const copiedAssets: PublicSnapshotAsset[] = [];
    for (const relPath of assetRelPaths) {
      const src = resolveSafeAssetSource(relPath, realImageRoot);
      if (src === null) {
        // The entry passed the policy evaluator but the asset is now unresolvable
        // (race, or defense-in-depth caught an escape). Refuse to ship it.
        throw new Error(
          `[exporter] asset unresolvable or escapes images-public/: ${relPath}`,
        );
      }
      // Destination preserves the images-public/<asset> structure.
      const destAbs = resolve(stagingDir, relPath);
      mkdirSync(resolve(destAbs, ".."), { recursive: true });
      // Copy from the REAL (symlink-resolved) source so we never copy a symlink
      // itself — only the bytes it points at, and only after the escape check.
      copyFileSync(src.real, destAbs);
      const stat = statSync(destAbs);
      copiedAssets.push({
        path: relPath, // snapshot-relative, schema-valid for the entry
        sha256: sha256(readFileSync(destAbs)),
        bytes: stat.size,
      });
    }

    // ── 4. Write entries.json (eligible only) ──────────────────────────────
    const entriesJson = `${JSON.stringify(eligible, null, 2)}\n`;
    const entriesPath = resolve(stagingDir, "entries.json");
    writeFileSync(entriesPath, entriesJson, "utf-8");

    // ── 5. Build the manifest (hash the entries.json file bytes) ───────────
    const entriesBytes = readFileSync(entriesPath);
    const entriesSha = sha256(entriesBytes);
    const snapshotId = deriveSnapshotId(entriesSha, copiedAssets);
    const finalDir = resolve(snapshotDir, snapshotId);

    // Refuse to overwrite an existing snapshot id. The id is content-derived,
    // so this is the idempotency gate: re-exporting the same eligible corpus
    // is a no-op (caller catches the "already exists" error) rather than a
    // silent overwrite that could race with a concurrent reader.
    if (existsSync(finalDir)) {
      throw new Error(
        `[exporter] snapshot already exists (refusing to overwrite): ${snapshotId}`,
      );
    }

    const manifest: PublicSnapshotManifest = {
      schemaVersion: 1,
      corpusVersion: 2,
      snapshotId,
      generatedAt: now,
      entryCount: eligible.length,
      entriesSha256: entriesSha,
      assets: copiedAssets,
    };
    writeFileSync(resolve(stagingDir, "manifest.json"), serializeManifest(manifest), "utf-8");

    // ── 6. Verify every hash matches bytes on disk BEFORE the rename ───────
    verifySnapshotIntegrity(stagingDir, manifest);

    // ── 7. Directory-atomic commit: rename staging → final ─────────────────
    // renameSync over a non-existent target atomically swaps the whole tree in.
    renameSync(stagingDir, finalDir);

    return {
      snapshotId,
      snapshotPath: finalDir,
      entryCount: eligible.length,
      assetCount: copiedAssets.length,
    };
  } catch (err) {
    // Best-effort cleanup of the staging residue on failure. A crash mid-pipeline
    // leaves a stale staging dir; it is NOT a published snapshot (no <snapshotId>
    // directory exists under snapshotDir), and a future run is unaffected.
    try { rmSync(stagingDir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }
}

/**
 * Re-read every hashed file from the staging dir and confirm the manifest's
 * hashes match the bytes on disk. Called BEFORE the atomic rename so a hash
 * mismatch (e.g. concurrent mutation, disk error) never produces a committed
 * snapshot whose manifest lies about its contents.
 *
 * Throws on any mismatch. Does NOT mutate anything.
 */
export function verifySnapshotIntegrity(snapshotPath: string, manifest: PublicSnapshotManifest): void {
  // entries.json
  const entriesBytes = readFileSync(resolve(snapshotPath, "entries.json"));
  const actualEntriesSha = sha256(entriesBytes);
  if (actualEntriesSha !== manifest.entriesSha256) {
    throw new Error(
      `[exporter] integrity check failed: entries.json sha256 mismatch `
      + `(manifest=${manifest.entriesSha256.slice(0, 12)}, actual=${actualEntriesSha.slice(0, 12)})`,
    );
  }

  // assets
  for (const asset of manifest.assets) {
    const abs = resolve(snapshotPath, asset.path);
    if (!existsSync(abs)) {
      throw new Error(`[exporter] integrity check failed: asset missing on disk: ${asset.path}`);
    }
    const bytes = readFileSync(abs);
    const actualSha = sha256(bytes);
    if (actualSha !== asset.sha256) {
      throw new Error(
        `[exporter] integrity check failed: asset sha256 mismatch for ${asset.path} `
        + `(manifest=${asset.sha256.slice(0, 12)}, actual=${actualSha.slice(0, 12)})`,
      );
    }
    if (bytes.length !== asset.bytes) {
      throw new Error(
        `[exporter] integrity check failed: asset size mismatch for ${asset.path} `
        + `(manifest=${asset.bytes}, actual=${bytes.length})`,
      );
    }
  }
}

// Re-export the manifest type so callers can import everything from exporter.js.
export type { PublicSnapshotManifest, PublicSnapshotAsset };
