import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

/**
 * The one corpus-containment guard for image paths.
 *
 * This logic previously existed twice — `assertSafeImagePath` in
 * scripts/color-scheme-audit.ts and `imagePathFor` in
 * scripts/color-scheme-calibrate.ts — and the copies had already diverged: the
 * audit version skipped the containment check entirely when the file did not
 * exist, while the calibration version required existence and always checked. A
 * security guard with two behaviours is one fix away from protecting half the
 * codebase, so the difference is now an explicit option rather than an accident.
 */

/** True when `candidate` is `root` itself or sits underneath it. */
export function isWithin(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + sep);
}

export type CorpusImagePathOptions = {
  /** Throw when the image is missing rather than returning the resolved path. */
  readonly requireExists: boolean;
  /** Prefix used in thrown messages so callers stay distinguishable in logs. */
  readonly label: string;
};

/**
 * Resolve a corpus-relative image path, refusing anything that could read
 * outside the corpus directory. Rejects absolute paths, `.`/`..` segments, and
 * anything not under `images-private/` or `images-public/`, then verifies via
 * realpath that the resolved file has not been symlinked out of the corpus.
 *
 * Returns the realpath when the file exists, otherwise the resolved absolute
 * path (only reachable with `requireExists: false`).
 */
export function assertCorpusImagePath(
  corpusRoot: string,
  relativePath: string,
  options: CorpusImagePathOptions,
): string {
  const segments = relativePath.split(/[\\/]/);
  if (
    isAbsolute(relativePath)
    || segments.some((segment) => segment === "." || segment === "..")
    || (!relativePath.startsWith("images-private/") && !relativePath.startsWith("images-public/"))
  ) {
    throw new Error(`unsafe ${options.label} image path: ${relativePath}`);
  }
  const realCorpusRoot = realpathSync(corpusRoot);
  const absolute = resolve(corpusRoot, relativePath);
  if (!existsSync(absolute)) {
    if (options.requireExists) throw new Error(`${options.label} image is missing: ${absolute}`);
    return absolute;
  }
  const realImage = realpathSync(absolute);
  if (!isWithin(realCorpusRoot, realImage)) {
    throw new Error(`${options.label} image escapes corpus root: ${relativePath}`);
  }
  return realImage;
}
