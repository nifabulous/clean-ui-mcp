/**
 * build-currency.ts — shared logic for detecting a stale compiled build.
 *
 * Extracted out of mcp-smoke.test.ts so that a Vitest `globalSetup` module
 * (which must be ordinary, non-test code — see build-currency-global-setup.ts)
 * can reuse the exact same "newest file under a directory" walk that the smoke
 * test uses to compare `src/` against `dist/`.
 *
 * Why a snapshot, not a live re-scan, is required (the bug this file fixes):
 * `src/references/generated.ts` is a TRACKED, non-test source file that
 * `src/references/generated.test.ts` rewrites mid-suite (write "// drift" then
 * restore original, for its drift-detection assertions). If the build-currency
 * guard re-scans `src/` live at assertion time, its verdict depends on whether
 * that rewrite has happened yet — a real STALE BUILD false alarm that appears
 * or disappears purely based on Vitest's test-file scheduling, with the file's
 * committed CONTENT never having changed. See build-currency-global-setup.ts
 * for how the snapshot is taken before any test file can run.
 */
import { readdirSync, statSync, type Dirent } from "node:fs";
import { resolve } from "node:path";

export interface NewestFileInfo {
  path: string;
  mtimeMs: number;
}

/**
 * The newest mtime (ms) of any file under `dir` whose name satisfies `include`,
 * plus the path that carried it. Returns `null` when the directory does not
 * exist or contains no matching file.
 */
export function newestFile(dir: string, include: (name: string) => boolean): NewestFileInfo | null {
  let newest: NewestFileInfo | null = null;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null; // missing directory — the caller reports it
  }
  for (const entry of entries) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = newestFile(full, include);
      if (nested && (!newest || nested.mtimeMs > newest.mtimeMs)) newest = nested;
      continue;
    }
    if (!entry.isFile() || !include(entry.name)) continue;
    const { mtimeMs } = statSync(full);
    if (!newest || mtimeMs > newest.mtimeMs) newest = { path: full, mtimeMs };
  }
  return newest;
}

/** Emitted sources only: `*.test.ts` is excluded by tsconfig, so it emits nothing. */
export const isEmittedSource = (name: string): boolean =>
  name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".d.ts");

export const isEmittedOutput = (name: string): boolean => name.endsWith(".js");

export const REBUILD_HINT = "Run `npx tsc` (or `npm run build`) and re-run this suite.";

/**
 * Fail loudly when `dist/` is missing or older than `sourceSnapshot`.
 *
 * `sourceSnapshot` MUST be captured before any test file ran (see
 * build-currency-global-setup.ts) — passing a live re-scan of `srcDir` here
 * reintroduces the order-dependent false alarm this module exists to fix.
 *
 * This is a heuristic, not a proof of correctness: erring toward a loud false
 * ALARM over a silent false green is the right trade here, but the mtime
 * comparison has three undocumented false-PASS modes where it stays quiet over
 * a build that does not actually match `src/`:
 *  (a) a source file DELETED from `src/` leaves its stale `dist/*.js` in
 *      place and bumps no `src` mtime — max-src stays older than max-dist, so
 *      the guard is satisfied by a `dist/` containing a module that no longer
 *      exists;
 *  (b) a system clock moved BACKWARD makes a genuinely newer edit carry an
 *      older mtime than the build it should invalidate;
 *  (c) an mtime-PRESERVING restore (e.g. `rsync --times`, some tarball
 *      extractions) changes file content without advancing mtime at all.
 * None of these are proof the compiled server matches `src/` — only that the
 * timestamps did not disagree. The narrower tool-list marker in
 * mcp-smoke.test.ts (the exact 14-name set with `generate_design_prompt`
 * absent) backstops the case that matters most, but does not close the
 * general gap; an exact answer would need a content-hash manifest, which this
 * suite does not maintain.
 */
export function assertCompiledServerIsCurrent(params: {
  srcDir: string;
  distDir: string;
  sourceSnapshot: NewestFileInfo | null;
}): void {
  const { srcDir, distDir, sourceSnapshot } = params;
  if (!sourceSnapshot) {
    throw new Error(`No emitted TypeScript source found under ${srcDir} — cannot verify build currency.`);
  }
  const newestOutput = newestFile(distDir, isEmittedOutput);
  if (!newestOutput) {
    throw new Error(
      `The compiled server is missing: no emitted .js found under ${distDir}. ` +
      `This suite tests the COMPILED artifact, not the TypeScript sources. ${REBUILD_HINT}`,
    );
  }
  if (sourceSnapshot.mtimeMs > newestOutput.mtimeMs) {
    throw new Error(
      `STALE BUILD: the compiled server under test is older than its sources, so this ` +
      `suite would validate a build that no longer matches src/ and report a FALSE GREEN.\n` +
      `  newest source: ${sourceSnapshot.path} (${new Date(sourceSnapshot.mtimeMs).toISOString()})\n` +
      `  newest output: ${newestOutput.path} (${new Date(newestOutput.mtimeMs).toISOString()})\n` +
      `${REBUILD_HINT}`,
    );
  }
}
