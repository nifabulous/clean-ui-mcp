import { createHash } from "node:crypto";
import { z } from "zod";

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
 *
 * F3 (Gate 1A): the manifest is ALSO parsed with Zod at LOAD time by the
 * PublicCorpusReader. Hashing proves only self-consistency (files match the
 * manifest), NOT that the manifest/entries are well-formed or eligible. A
 * hand-crafted snapshot with recomputed hashes would pass integrity and be
 * served. The Zod schema + `evaluatePublication` re-run at load close that gap
 * (defense-in-depth: the exporter pre-filters, but a modified/externally-
 * supplied snapshot must be re-verified).
 */

/**
 * Zod schema for one asset row. `path` is the snapshot-relative path the entry's
 * `image.path` references verbatim (e.g. "images-public/foo.png") — no rewriting.
 * Used at load to validate a manifest that may have been tampered with after
 * export (the exporter's in-process builder is type-safe, but a snapshot is an
 * untrusted input at load time).
 */
export const PublicSnapshotAssetSchema = z.object({
  /** Snapshot-relative path, e.g. "images-public/foo.png". */
  path: z.string().min(1),
  /** SHA-256 hex digest (64 lowercase hex chars). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  /** File size in bytes (non-negative). */
  bytes: z.number().int().nonnegative(),
});

/**
 * Zod schema for manifest.json. Mirrors the {@link PublicSnapshotManifest}
 * interface exactly (kept in sync manually — the interface predates Zod here and
 * is consumed by the exporter's in-process builder; the schema is the load-time
 * validator). `PublicSnapshotManifestSchema.parse` is what the PublicCorpusReader
 * runs against an untrusted on-disk manifest.
 */
export const PublicSnapshotManifestSchema = z.object({
  schemaVersion: z.literal(1),
  corpusVersion: z.literal(2),
  snapshotId: z.string().min(1),
  /** ISO 8601 timestamp. */
  generatedAt: z.string().min(1),
  entryCount: z.number().int().nonnegative(),
  entriesSha256: z.string().regex(/^[0-9a-f]{64}$/),
  assets: z.array(PublicSnapshotAssetSchema),
});

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
  // Sort by path before hashing so the id is canonical regardless of the order
  // callers accumulated assets in. Without this, two semantically-identical
  // snapshots with entry arrays in different orders would derive different ids,
  // silently breaking idempotency.
  const ordered = [...assets].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const assetsHash = sha256(
    Buffer.from(
      ordered.map((a) => `${a.path}:${a.sha256}:${a.bytes}`).join("\n"),
      "utf-8",
    ),
  );
  return `${entriesSha256.slice(0, 12)}-${assetsHash.slice(0, 12)}`;
}

/** Serialize a manifest to canonical JSON (2-space, trailing newline). */
export function serializeManifest(manifest: PublicSnapshotManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
