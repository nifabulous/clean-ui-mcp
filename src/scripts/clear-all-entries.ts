#!/usr/bin/env node
/**
 * clear-all-entries — one-time bulk-clearance script for local validation.
 *
 * Marks every entry in corpus/entries.json as publication-eligible and moves
 * its image from images-private/ to images-public/. Intended for LOCAL
 * PIPELINE VALIDATION ONLY — the public snapshot produced from this is
 * gitignored and never committed. Before any real distribution (Gate 2 npm
 * or Gate 3 hosted), each entry must be individually rights-reviewed.
 *
 * Usage:
 *   npx tsx src/scripts/clear-all-entries.ts           # clear all
 *   npx tsx src/scripts/clear-all-entries.ts --dry-run # preview without changes
 *
 * What "clear" means here:
 *   - image.visibility → "public-own"
 *   - image.path → images-public/<same-filename>
 *   - physical file moved from images-private/ to images-public/
 *   - publication block set to {visibility:"public", clearance:"approved",
 *     rightsBasis:"owned", evidenceRef:"local-validation", reviewedAt: today,
 *     reviewedBy:"bulk-clear-local-validation"}
 *
 * The rightsBasis:"owned" claim is a PLACEHOLDER for local validation. Each
 * entry must be individually re-reviewed before any real publication.
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "..", "..", "corpus", "entries.json");
const CORPUS_ROOT = resolve(__dirname, "..", "..", "corpus");
const PRIVATE_DIR = resolve(CORPUS_ROOT, "images-private");
const PUBLIC_DIR = resolve(CORPUS_ROOT, "images-public");

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
const DRY_RUN = process.argv.includes("--dry-run");

const today = new Date().toISOString().slice(0, 10);

const PLACEHOLDER_PUBLICATION = {
  visibility: "public" as const,
  clearance: "approved" as const,
  rightsBasis: "owned" as const,
  evidenceRef: "local-validation",
  reviewedAt: today,
  reviewedBy: "bulk-clear-local-validation",
};

export function clearEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const cleared = { ...entry };

  // Set the publication block
  cleared.publication = { ...PLACEHOLDER_PUBLICATION };

  // Update image visibility + path
  const oldPath = (cleared.image as { path: string | null }).path;
  if (oldPath && oldPath.startsWith("images-private/")) {
    const filename = oldPath.replace(/^images-private\//, "");
    (cleared.image as { visibility: string; path: string }).visibility = "public-own";
    (cleared.image as { visibility: string; path: string }).path = `images-public/${filename}`;
  } else if (oldPath && oldPath.startsWith("images-public/")) {
    // Already public — just ensure visibility is set
    (cleared.image as { visibility: string }).visibility = "public-own";
  } else {
    // Link-only entry (path is null) — set visibility, no file to move
    (cleared.image as { visibility: string }).visibility = "public-own";
  }

  return cleared;
}

if (isMain) {
  if (!existsSync(CORPUS_PATH)) {
    console.error(`entries.json not found at ${CORPUS_PATH}`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf-8"));
  const entries: Record<string, unknown>[] = raw.entries ?? raw;
  console.log(`Clearing ${entries.length} entries${DRY_RUN ? " (DRY RUN)" : ""}...`);

  let moved = 0;
  let alreadyPublic = 0;
  let linkOnly = 0;
  let notFound = 0;
  const clearedEntries = entries.map((entry) => {
    // Capture the ORIGINAL path BEFORE clearEntry (which rewrites it).
    // clearEntry does a shallow {...entry} copy, so entry.image is the same
    // reference as cleared.image — capturing here avoids the mutation race.
    const originalPath = (entry.image as { path: string | null }).path;
    const cleared = clearEntry(entry);
    if (!DRY_RUN) {
      if (originalPath && originalPath.startsWith("images-private/")) {
        const filename = originalPath.replace(/^images-private\//, "");
        const src = resolve(PRIVATE_DIR, filename);
        const dst = resolve(PUBLIC_DIR, filename);
        if (existsSync(src)) {
          mkdirSync(dirname(dst), { recursive: true });
          renameSync(src, dst);
          moved++;
        } else {
          console.warn(`  ⚠ file not found: ${src} (path in entry but missing on disk)`);
          notFound++;
        }
      } else if (originalPath && originalPath.startsWith("images-public/")) {
        alreadyPublic++;
      } else {
        linkOnly++;
      }
    }
    return cleared;
  });

  if (!DRY_RUN) {
    const output = JSON.stringify({ version: 2, entries: clearedEntries }, null, 2) + "\n";
    writeFileSync(CORPUS_PATH, output, "utf-8");
  }

  console.log(`\nDone${DRY_RUN ? " (dry run — no changes)" : ""}:`);
  console.log(`  ${clearedEntries.length} entries cleared`);
  console.log(`  ${moved} images moved images-private/ → images-public/`);
  console.log(`  ${alreadyPublic} already in images-public/`);
  console.log(`  ${linkOnly} link-only entries (no image file)`);
  if (!DRY_RUN) {
    console.log(`\n⚠ PLACEHOLDER rightsBasis:"owned" — re-review before any real publication.`);
    console.log(`  The public snapshot is gitignored and local-only until Gate 2/3.`);
  }
}
