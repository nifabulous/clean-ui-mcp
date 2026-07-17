import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { existsSync, readdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = resolve(__dirname, "..");
export const CORPUS_ROOT = resolve(PROJECT_ROOT, "corpus");
export const PRIVATE_IMAGE_DIR = resolve(CORPUS_ROOT, "images-private");
export const PUBLIC_IMAGE_DIR = resolve(CORPUS_ROOT, "images-public");

// Test-only override for the private-image dir. Tests that exercise the
// capture/promote/orphan/dedup pipelines used to write under the REAL
// corpus/images-private/ (because fromCorpusRelativeImagePath resolves against
// the static CORPUS_ROOT, and ui-server.ts captured PRIVATE_IMAGE_DIR at module
// load into CAPTURES_DIR — T-REV-4). Production callers MUST use
// privateImageDir() so the override takes effect at use time, never at import.
let privateImageDirOverride: string | null = null;
/** Test-only: redirect private-image writes to a tmp dir. Pass null to clear. */
export function setPrivateImageDirForTesting(dir: string | null): void {
  privateImageDirOverride = dir;
}
/**
 * Use-time resolution of the private-image dir. Returns the override when set
 * (tests), otherwise the real PRIVATE_IMAGE_DIR. Production callers should
 * prefer this over the bare const so the test seam can redirect them.
 */
export function privateImageDir(): string {
  return privateImageDirOverride ?? PRIVATE_IMAGE_DIR;
}
/**
 * Public snapshots — the directory-atomic export target. Each snapshot lives in
 * its own subdirectory (`<snapshot-id>/`) containing manifest.json, entries.json,
 * and the images-public/ tree. Snapshots are produced by the exporter
 * (src/publication/exporter.ts) and consumed by the PublicCorpusReader (Task 4b).
 */
export const PUBLIC_SNAPSHOT_DIR = resolve(CORPUS_ROOT, "public-snapshots");

/**
 * Recursively list image files under a directory, returning corpus-relative
 * paths (forward-slash separated, e.g. "images-private/new-products-batch/
 * Alan iOS Screens/Alan iOS Screens 1.png").
 *
 * The earlier safeListDir() used a flat readdirSync, so any image stored under
 * a subdirectory (bulk-import batches nest files by source folder) was invisible
 * to the doctor's orphan/missing check AND to clean-orphans — the doctor
 * reported false-missing refs, and clean-orphans would have deleted files that
 * were actually referenced via nested paths. This walks the tree properly.
 */
export function listImageFilesRecursive(dir: string, prefix: string): string[] {
  if (!existsSync(dir)) return [];
  let out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix + entry.name;
    if (entry.isDirectory()) {
      out = out.concat(listImageFilesRecursive(resolve(dir, entry.name), rel + "/"));
    } else {
      out.push(rel);
    }
  }
  return out;
}

/** All image files (private + public) as corpus-relative paths. */
export function allImageFiles(): Set<string> {
  return new Set([
    ...listImageFilesRecursive(PRIVATE_IMAGE_DIR, "images-private/"),
    ...listImageFilesRecursive(PUBLIC_IMAGE_DIR, "images-public/"),
  ]);
}

export function toCorpusRelativePath(path: string): string {
  const absolute = resolve(path);
  // Honor the test-only override: an absolute tmp path written under
  // privateImageDir() (tmp) must round-trip back to an "images-private/..."
  // string so the rest of the corpus pipeline (which keys off that prefix)
  // still recognizes it. Without this, toCorpusRelativePath would compute a
  // "../../tmp/..." relative path and reject it.
  if (privateImageDirOverride) {
    const relToOverride = relative(privateImageDirOverride, absolute).split(sep).join("/");
    if (!relToOverride.startsWith("..") && !relToOverride.startsWith("/")) {
      return `images-private/${relToOverride}`;
    }
  }
  const relativePath = relative(CORPUS_ROOT, absolute).split(sep).join("/");

  if (
    relativePath.startsWith("..") ||
    relativePath.startsWith("/") ||
    (!relativePath.startsWith("images-private/") && !relativePath.startsWith("images-public/"))
  ) {
    throw new Error(`Image must live under ${PRIVATE_IMAGE_DIR} or ${PUBLIC_IMAGE_DIR}: ${path}`);
  }

  return relativePath;
}

export function fromCorpusRelativePath(path: string): string {
  if (path.includes("..") || path.startsWith("/")) {
    throw new Error(`Invalid corpus-relative path: ${path}`);
  }
  // Honor the test-only private-image override so tests that write images
  // under a tmp dir (setPrivateImageDirForTesting) get the same tmp path back
  // from this resolver — otherwise the override would only redirect writers
  // (privateImageDir()) while readers (fromCorpusRelativeImagePath) kept
  // pointing at the real corpus, splitting the test fixture in two.
  if (privateImageDirOverride && path.startsWith("images-private/")) {
    return resolve(privateImageDirOverride, path.slice("images-private/".length));
  }
  return resolve(CORPUS_ROOT, path);
}

export function assertCorpusImagePath(path: string): void {
  if (
    path.includes("..") ||
    path.startsWith("/") ||
    (!path.startsWith("images-private/") && !path.startsWith("images-public/"))
  ) {
    throw new Error(`Invalid corpus image path: ${path}`);
  }
}

export function fromCorpusRelativeImagePath(path: string): string {
  assertCorpusImagePath(path);
  return fromCorpusRelativePath(path);
}
