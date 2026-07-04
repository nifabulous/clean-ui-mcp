#!/usr/bin/env node
/**
 * migrate-untitled-products.ts
 * ──────────────────────────────
 * Backfills productName for entries the tagger couldn't read a wordmark for
 * (productName came back "Untitled"). The product is recoverable from the image
 * filename stem — these came from Mobbin/bulk-import batches where the filename
 * preserves the product. Maps to the canonical casing the corpus already uses.
 *
 * This is a field-populator, NOT a version bump. Idempotent: skips entries whose
 * productName is already set (not "Untitled"). --dry-run previews without writing.
 *
 * Usage:
 *   npm run migrate-untitled
 *   npm run migrate-untitled -- --dry-run
 *
 * After migrating:
 *   npm run validate-corpus
 *   npm run build-index -- --force   # productName feeds the embedding document
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Corpus } from "../schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "..", "..", "corpus", "entries.json");

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    help:      { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`Usage: npm run migrate-untitled [-- --dry-run]
  --dry-run   Preview the renames without writing.`);
  process.exit(0);
}

// Filename stem → canonical product name (casing matches existing corpus entries).
// Stems are the leading word(s) of the filename before the first separator, e.g.
// "cash-app-taxes-8.png" → "cash" → "Cash App". Add to this map as new clusters appear.
const STEM_TO_PRODUCT: Record<string, string> = {
  cash:      "Cash App",
  aboard:    "Aboard",
  workable:  "Workable",
  juicebox:  "Juicebox",
};

/** Extract the filename stem and map to a product, or null if unrecognized. */
function productFromImagePath(path: string): string | null {
  const match = path.match(/images-private\/([a-z]+)/i);
  if (!match) return null;
  const stem = match[1].toLowerCase();
  return STEM_TO_PRODUCT[stem] ?? null;
}

const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf-8"));
const parsed = Corpus.safeParse(raw);
if (!parsed.success) {
  console.error("Corpus validation failed — fix entries.json before migrating.");
  process.exit(1);
}

const entries = parsed.data.entries;
const toFix = entries.filter((e) => e.source.productName === "Untitled" && e.image.path);
const unmapped: string[] = [];
let fixed = 0;

for (const entry of toFix) {
  const product = productFromImagePath(entry.image.path!);
  if (!product) {
    unmapped.push(`${entry.id} → ${entry.image.path}`);
    continue;
  }
  entry.source.productName = product;
  fixed += 1;
}

console.log(`Untitled entries: ${toFix.length}`);
console.log(`Mapped from filename: ${fixed}`);
if (unmapped.length) {
  console.log(`\n⚠ ${unmapped.length} couldn't be mapped from filename stem (need manual naming):`);
  unmapped.slice(0, 20).forEach((u) => console.log(`  ${u}`));
  if (unmapped.length > 20) console.log(`  …(+${unmapped.length - 20} more)`);
}

if (values["dry-run"]) {
  console.log("\n--dry-run: no changes written.");
  process.exit(0);
}

// Re-validate the whole corpus after mutation, then write atomically.
const recheck = Corpus.safeParse({ version: 2, entries });
if (!recheck.success) {
  console.error("Post-migration validation failed — aborting write:", recheck.error.issues.slice(0, 3));
  process.exit(1);
}
writeFileSync(CORPUS_PATH, JSON.stringify({ version: 2, entries }, null, 2) + "\n", "utf-8");
console.log(`\n✅ Wrote ${entries.length} entries to ${CORPUS_PATH}.`);
console.log("   Next: npm run validate-corpus && npm run build-index -- --force");
