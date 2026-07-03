import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = resolve(__dirname, "..");
export const CORPUS_ROOT = resolve(PROJECT_ROOT, "corpus");
export const PRIVATE_IMAGE_DIR = resolve(CORPUS_ROOT, "images-private");
export const PUBLIC_IMAGE_DIR = resolve(CORPUS_ROOT, "images-public");

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
