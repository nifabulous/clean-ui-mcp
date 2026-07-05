#!/usr/bin/env node
/**
 * migrate-platform.ts
 * ───────────────────
 * Backfills the `platform` field (web/mobile/tablet) on existing entries from
 * their image dimensions. The field is new and optional; existing entries have
 * no platform set. This populates it deterministically via detectPlatform() so
 * the corpus is immediately searchable by platform.
 *
 * Idempotent: skips entries that already have a platform set. --dry-run previews.
 *
 * Usage:
 *   npm run migrate-platform
 *   npm run migrate-platform -- --dry-run
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Corpus, detectPlatform } from "../schema.js";

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
  console.log(`Usage: npm run migrate-platform [-- --dry-run]
  --dry-run   Preview the platform assignments without writing.`);
  process.exit(0);
}

const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf-8"));
const parsed = Corpus.safeParse(raw);
if (!parsed.success) {
  console.error("Corpus validation failed — fix entries.json before migrating.");
  process.exit(1);
}

const entries = parsed.data.entries;
let fixed = 0;
const counts: Record<string, number> = { web: 0, mobile: 0, tablet: 0 };

for (const entry of entries) {
  if (entry.platform) continue; // idempotent — skip already-set
  const platform = detectPlatform(entry.image.width, entry.image.height);
  entry.platform = platform;
  counts[platform] = (counts[platform] ?? 0) + 1;
  fixed += 1;
}

console.log(`Entries without platform: ${fixed} of ${entries.length}`);
console.log(`Assigned: ${counts.web} web · ${counts.mobile} mobile · ${counts.tablet} tablet`);

if (values["dry-run"]) {
  console.log("\n--dry-run: no changes written.");
  process.exit(0);
}

// Re-validate the whole corpus after mutation, then write.
const recheck = Corpus.safeParse({ version: 2, entries });
if (!recheck.success) {
  console.error("Post-migration validation failed — aborting write:", recheck.error.issues.slice(0, 3));
  process.exit(1);
}
writeFileSync(CORPUS_PATH, JSON.stringify({ version: 2, entries }, null, 2) + "\n", "utf-8");
console.log(`\n✅ Wrote ${entries.length} entries to ${CORPUS_PATH}.`);
