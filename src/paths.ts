import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { existsSync, readdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = resolve(__dirname, "..");
export const CORPUS_ROOT = resolve(PROJECT_ROOT, "corpus");
export const PRIVATE_IMAGE_DIR = resolve(CORPUS_ROOT, "images-private");
export const PUBLIC_IMAGE_DIR = resolve(CORPUS_ROOT, "images-public");

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
