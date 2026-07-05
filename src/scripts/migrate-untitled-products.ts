#!/usr/bin/env node
/**
 * migrate-untitled-products.ts
 * ──────────────────────────────
 * Backfills two fields the tagger couldn't infer:
 *
 *   1. productName === "Untitled" — recovered from the image filename stem
 *      (Mobbin/bulk-import filenames preserve the product). Maps to the canonical
 *      casing the corpus already uses.
 *   2. title === "Untitled" (or empty) — set from productName. Most untitled
 *      rows already have a correct productName; they just need the title mirrored
 *      so the gallery doesn't show "Untitled" everywhere. When a product has
 *      multiple untitled entries, a counter is appended to disambiguate
 *      ("Cash App", "Cash App 2", "Cash App 3"…) — this is a display label, not
 *      a unique id (the entry id still uniquely identifies the row).
 *
 * This is a field-populator, NOT a version bump. Idempotent: skips entries whose
 * productName AND title are already set. --dry-run previews without writing.
 *
 * Usage:
 *   npm run migrate-untitled
 *   npm run migrate-untitled -- --dry-run
 *
 * After migrating:
 *   npm run validate-corpus
 *   npm run build-index -- --force   # productName + title feed the embedding
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
  wise:      "Wise",
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
const isUntitledTitle = (t: string) => !t || t === "Untitled" || t.toLowerCase() === "untitled";

// Pass 1: backfill productName from the filename stem (only when productName
// itself is "Untitled"). This is the original behavior.
const productNameUntitled = entries.filter((e) => e.source.productName === "Untitled" && e.image.path);
const unmapped: string[] = [];
let productsFixed = 0;

for (const entry of productNameUntitled) {
  const product = productFromImagePath(entry.image.path!);
  if (!product) {
    unmapped.push(`${entry.id} → ${entry.image.path}`);
    continue;
  }
  entry.source.productName = product;
  productsFixed += 1;
}

// Pass 2: backfill title from productName (only when title is "Untitled"/empty).
// Disambiguate siblings within one product with a counter — the id stays unique,
// the title just needs to be a readable gallery label instead of "Untitled".
const titleUntitled = entries.filter((e) => isUntitledTitle(e.title));
const titleCounts: Record<string, number> = {};
let titlesFixed = 0;

for (const entry of titleUntitled) {
  const product = entry.source.productName;
  // Skip if productName is ALSO unknown — can't synthesize a sensible title.
  if (!product || product === "Untitled") continue;
  titleCounts[product] = (titleCounts[product] ?? 0) + 1;
  entry.title = titleCounts[product] === 1 ? product : `${product} ${titleCounts[product]}`;
  titlesFixed += 1;
}

console.log(`productName == "Untitled": ${productNameUntitled.length}`);
console.log(`  mapped from filename:    ${productsFixed}`);
console.log(`title == "Untitled":       ${titleUntitled.length}`);
console.log(`  set from productName:    ${titlesFixed}`);
const stillUntitled = entries.filter((e) => isUntitledTitle(e.title)).length;
if (stillUntitled) {
  console.log(`  still untitled (no productName to mirror): ${stillUntitled}`);
}
if (unmapped.length) {
  console.log(`\n⚠ ${unmapped.length} productName couldn't be mapped from filename stem (need manual naming):`);
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
