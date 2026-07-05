#!/usr/bin/env node
/**
 * clean-orphans.ts — delete private image files no entry references.
 *
 * Bulk import + restore + delete can leave unreferenced screenshots on disk.
 * This CLI finds and removes them. Default is --dry-run (lists only); you must
 * pass --confirm to actually delete.
 *
 * Usage:
 *   npm run clean-orphans                    # dry-run: list orphans (no deletion)
 *   npm run clean-orphans -- --confirm       # delete the orphans
 *   npm run clean-orphans -- --confirm --json # delete, report as json
 */
import { rmSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Corpus } from "../schema.js";
import { CORPUS_ROOT, listImageFilesRecursive, PRIVATE_IMAGE_DIR, PUBLIC_IMAGE_DIR } from "../paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "..", "..", "corpus", "entries.json");
const args = process.argv.slice(2);
const confirm = args.includes("--confirm");
const asJson = args.includes("--json");

/** List files referenced by entries, plus files on disk in both image dirs. */
function orphanInventory() {
  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf-8"));
  const entries = Corpus.safeParse(raw);
  if (!entries.success) {
    throw new Error(`Corpus validation failed — fix entries.json before cleaning orphans.`);
  }
  const referenced = new Set(
    entries.data.entries
      .map((e) => e.image.path)
      .filter((p): p is string => !!p && p.startsWith("images-private/")),
  );
  // Recursively walk private + public dirs so nested bulk-import batches
  // (images-private/new-products-batch/Mercury Web Screens/…) are accounted
  // for. The earlier flat readdirSync missed these and would have deleted
  // files that were actually referenced via nested paths.
  const privateFiles = listImageFilesRecursive(PRIVATE_IMAGE_DIR, "images-private/");
  const publicFiles = listImageFilesRecursive(PUBLIC_IMAGE_DIR, "images-public/");
  // Only private orphans are deletable (public images may be hot-linked).
  const orphans = privateFiles.filter((f) => !referenced.has(f)).sort();
  return { orphans, referencedCount: referenced.size, privateTotal: privateFiles.length, publicTotal: publicFiles.length };
}

const inv = orphanInventory();

if (!confirm) {
  if (asJson) {
    console.log(JSON.stringify({ dryRun: true, orphans: inv.orphans, count: inv.orphans.length, referenced: inv.referencedCount, privateTotal: inv.privateTotal }, null, 2));
  } else {
    console.log(`Orphan scan (dry-run — no files deleted)`);
    console.log(`  referenced: ${inv.referencedCount}  ·  private on disk: ${inv.privateTotal}  ·  orphans: ${inv.orphans.length}`);
    if (inv.orphans.length) {
      console.log(`\n  Orphaned files:`);
      inv.orphans.forEach((f) => console.log(`    ${f}`));
      console.log(`\n  Delete with: npm run clean-orphans -- --confirm`);
    } else {
      console.log(`\n  No orphans — nothing to clean. ✅`);
    }
  }
  process.exit(0);
}

// ── confirm path: delete ─────────────────────────────────────────────────────
let deleted = 0;
const errors: string[] = [];
for (const rel of inv.orphans) {
  const abs = resolve(CORPUS_ROOT, rel);
  try { rmSync(abs, { force: false }); deleted += 1; }
  catch (e) { errors.push(`${rel}: ${e instanceof Error ? e.message : e}`); }
}

if (asJson) {
  console.log(JSON.stringify({ deleted, errors, remaining: inv.orphans.length - deleted }, null, 2));
} else {
  console.log(`Deleted ${deleted} orphan${deleted === 1 ? "" : "s"}${inv.privateTotal - inv.privateTotal + deleted ? "" : ""}.`);
  if (errors.length) {
    console.log(`\n  ${errors.length} error(s):`);
    errors.forEach((e) => console.log(`    ${e}`));
  }
}
process.exit(errors.length ? 1 : 0);
