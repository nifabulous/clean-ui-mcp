import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// ──────────────────────────────────────────────────────────────────────────
// Public site disclosure boundary.
//
// The central promise of the grounded-design pre-C2 work is that NO private
// corpus material (entries, screenshots, image paths, critiques, source
// identities, embeddings) ever reaches browser-downloadable public assets.
//
// This checker enforces that promise with an ALLOWLIST of sanctioned files
// under site/public/. The earlier version gated only two locations
// (site/public/entries/ and site/public/snapshot.json), so a corpus asset
// placed anywhere else — e.g. site/public/private-corpus.png or
// site/public/data/leak.json — passed the checker and was emitted by the
// bundler unchanged (review P1 #3). An allowlist is fail-closed: anything
// not explicitly sanctioned is rejected, so a future leak cannot slip in
// through an unanticipated path.
//
// The allowlist is intentionally tiny here. The public-site reconstruction
// (a separate PR) adds the real sanctioned assets — robots.txt, sitemap.xml,
// the generated bundle — when that content lands. Until then the only
// sanctioned file is the corpus-free synthetic snapshot.json.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Sanctioned relative paths under site/public/, POSIX-style (forward slashes).
 * Every file under site/public/ MUST appear here to pass the boundary check.
 */
const SANCTIONED_PUBLIC_FILES = new Set([
  "snapshot.json",
]);

/** Normalize a path to POSIX-style relative segments for allowlist matching. */
function toPosixRel(p) {
  return p.split(sep).join("/");
}

/**
 * Walk every file under `site/public/` and confirm each is on the allowlist.
 * Returns the list of files found (for the snapshot check). Throws on any
 * unsanctioned file.
 */
function assertOnlySanctionedFiles(publicRoot) {
  if (!existsSync(publicRoot)) {
    // No public dir yet (e.g. before the public-site reconstruction lands).
    // Nothing to leak — the boundary holds trivially.
    return;
  }
  const entries = readdirSync(publicRoot, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    // Codex P1 #4: `entry.isFile()` is false for symlinks (Dirent reflects the
    // lstat type), so a symlink placed under site/public/ pointing at a private
    // corpus file was skipped entirely — the bundler would still follow it and
    // emit the leak. A sanctioned public directory must not contain symlinks at
    // all (they are an obvious exfiltration vector), so reject them explicitly.
    const entryPath = resolve(publicRoot, entry.parentPath ?? "", entry.name);
    const stat = lstatSync(entryPath);
    if (stat.isSymbolicLink()) {
      const rel = toPosixRel(relative(publicRoot, entryPath));
      throw new Error(
        `site/public/${rel} is a symlink — symlinks are not permitted in the public ` +
          `asset directory (exfiltration vector for private corpus material)`,
      );
    }
    if (!stat.isFile()) continue;
    const rel = toPosixRel(relative(publicRoot, entryPath));
    if (!SANCTIONED_PUBLIC_FILES.has(rel)) {
      throw new Error(
        `site/public/${rel} is not on the sanctioned public-asset allowlist — ` +
          `private corpus material must not reach browser-downloadable public assets`,
      );
    }
  }
}

/**
 * Confirm the synthetic snapshot is corpus-free (count 0, entries []). A
 * browser-downloadable snapshot with real entries would publish the corpus.
 */
function assertCorpusFreeSnapshot(publicRoot) {
  const snapshotPath = resolve(publicRoot, "snapshot.json");
  if (!existsSync(snapshotPath)) return;
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8"));
  if (!Array.isArray(snapshot.entries) || snapshot.entries.length !== 0 || snapshot.count !== 0) {
    throw new Error(
      "site/public/snapshot.json entries must be empty until a separately cleared collection exists",
    );
  }
}

/**
 * @param {string} root — repository root containing site/public/.
 * @returns {{ ok: true }} when the public site carries no corpus material.
 * @throws {Error} when an unsanctioned file or a non-empty snapshot is found.
 */
export function checkPublicSiteBoundary(root) {
  const publicRoot = resolve(root, "site/public");
  assertOnlySanctionedFiles(publicRoot);
  assertCorpusFreeSnapshot(publicRoot);
  return { ok: true };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  checkPublicSiteBoundary(process.cwd());
  process.stdout.write("public site boundary: PASS\n");
}
