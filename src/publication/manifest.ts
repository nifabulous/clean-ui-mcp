import { createHash } from "node:crypto";

/**
 * publication/manifest.ts — the shape of a public snapshot's manifest.json and
 * the hash helpers used to build + verify it.
 *
 * One responsibility: the manifest. The export pipeline (which writes files,
 * copies assets, and does the directory-atomic rename) lives in exporter.ts.
 * This module stays free of filesystem + clock I/O so the hashing is trivially
 * testable in isolation.
 *
 * Integrity story: `entriesSha256` is the SHA-256 of the entries.json FILE BYTES
 * (not a hash-of-hashes), and each asset carries its own SHA-256 + byte count.
 * The exporter re-reads + re-hashes every file before the atomic rename to
 * guarantee the manifest matches bytes-on-disk at commit time.
 */

/**
 * One asset row in the manifest. `path` is the snapshot-relative path the entry's
 * `image.path` references verbatim (e.g. "images-public/foo.png") — no rewriting.
 */
export interface PublicSnapshotAsset {
  /** Snapshot-relative path, e.g. "images-public/foo.png". */
  path: string;
  /** SHA-256 hex digest of the asset file bytes. */
  sha256: string;
  /** File size in bytes. */
  bytes: number;
}

/**
 * manifest.json — the manifest for one public snapshot. Written to
 * `<snapshotDir>/<snapshotId>/manifest.json`.
 *
 *   - `schemaVersion`: the MANIFEST schema version (bump when this shape changes).
 *   - `corpusVersion`: the corpus envelope version the entries were sourced from
 *     (stays 2 — the manifest does not bump the corpus version).
 *   - `snapshotId`: content-derived id (hash of entries + assets) so identical
 *     content is idempotent; the exporter refuses to overwrite an existing id.
 *   - `entriesSha256`: SHA-256 of the entries.json file bytes.
 */
export interface PublicSnapshotManifest {
  schemaVersion: 1;
  corpusVersion: 2;
  snapshotId: string;
  /** ISO 8601 timestamp. */
  generatedAt: string;
  entryCount: number;
  entriesSha256: string;
  assets: PublicSnapshotAsset[];
}

/** SHA-256 hex digest of a Buffer/Uint8Array. */
export function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Derive a content-based snapshot id from the entries hash + asset hashes.
 * Identical eligible content (same entries, same asset bytes) yields the same
 * id, so re-exporting the same corpus is idempotent and the exporter can refuse
 * to overwrite an already-published snapshot.
 *
 * Format: `<entriesSha256[:12]>-<assetsHash[:12]>` — short enough for a
 * directory name, long enough to make collisions infeasible, and stable so two
 * exporters on the same corpus agree.
 */
export function deriveSnapshotId(entriesSha256: string, assets: PublicSnapshotAsset[]): string {
  const assetsHash = sha256(
    Buffer.from(
      assets.map((a) => `${a.path}:${a.sha256}:${a.bytes}`).join("\n"),
      "utf-8",
    ),
  );
  return `${entriesSha256.slice(0, 12)}-${assetsHash.slice(0, 12)}`;
}

/** Serialize a manifest to canonical JSON (2-space, trailing newline). */
export function serializeManifest(manifest: PublicSnapshotManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
