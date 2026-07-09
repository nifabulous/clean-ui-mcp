#!/usr/bin/env node
/**
 * migrate-v1-to-v2.ts
 * ────────────────────
 * One-shot corpus schema migration: v1 → v2.
 *
 * v2 adds:
 *   - `patternType` (required, single enum) — inferred from categories
 *   - `antiPatterns` (structured object) — replaces the free-text `whatToAvoidHere`
 *
 * Idempotent: detects an already-v2 corpus and exits without changes.
 *
 * Usage:
 *   npm run migrate                # writes the migrated corpus
 *   npm run migrate -- --dry-run   # preview without writing
 *
 * After migrating, backfill the [TODO] anti-pattern placeholders, then:
 *   npm run validate-corpus
 *   npm run build-index -- --force  # patternType + antiPatterns added to embeddings
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "..", "..", "corpus", "entries.json");

// Valid v2 patternType values. A category maps to patternType if it appears here.
// Most categories are themselves valid patternTypes (intentional overlap); the
// only categories that AREN'T valid patternTypes today: none — all 18 Category
// values are present in PatternType. This means category→patternType inference
// is just "first category that's in this set" (which is all of them, so it's
// effectively categories[0]). Kept as an explicit set for safety if the two
// enums ever diverge.
const VALID_PATTERN_TYPES = new Set([
  "dashboard", "landing-page", "pricing", "onboarding", "auth", "settings",
  "search", "checkout", "profile", "marketing-hero", "calculator",
  "data-table", "empty-state", "navigation", "forms", "mobile-nav",
  "notifications", "editor-canvas", "chat-interface", "command-palette", "modal",
]);

export const TODO_PLACEHOLDER = "[TODO — backfill: what common mistake does this design avoid?]";

export interface V1Entry {
  id: string;
  categories: string[];
  whatToAvoidHere?: string[];
  [k: string]: unknown;
}

interface V2AntiPatterns {
  antiPatterns: string[];
  whereThisFails: string[];
  accessibilityRisks: string[];
}

interface V2Entry extends V1Entry {
  patternType: string;
  antiPatterns: V2AntiPatterns;
}

export function inferPatternType(entry: V1Entry): string {
  // First category that's a valid patternType wins. The category array is
  // ordered by salience (the curator picks the most descriptive first), so
  // categories[0] is the right primary pattern in practice.
  for (const c of entry.categories ?? []) {
    if (VALID_PATTERN_TYPES.has(c)) return c;
  }
  // Fallback: shouldn't happen given the current enums overlap fully, but be safe.
  return "dashboard";
}

export function migrateAntiPatterns(entry: V1Entry): V2AntiPatterns {
  const existing = entry.whatToAvoidHere ?? [];
  const meaningful = existing.filter((s) => typeof s === "string" && s.trim().length >= 10);
  return {
    antiPatterns: meaningful.length ? meaningful : [TODO_PLACEHOLDER],
    whereThisFails: [],
    accessibilityRisks: [],
  };
}

function migrateEntry(entry: V1Entry): V2Entry {
  const out = { ...entry } as V2Entry;
  out.patternType = inferPatternType(entry);
  out.antiPatterns = migrateAntiPatterns(entry);
  delete (out as { whatToAvoidHere?: string[] }).whatToAvoidHere;
  return out;
}

// Only run the CLI body when invoked directly, not when imported (e.g. by tests).
const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    help:      { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`Usage: npm run migrate [-- --dry-run]`);
  process.exit(0);
}

if (!existsSync(CORPUS_PATH)) {
  console.error(`Corpus not found: ${CORPUS_PATH}`);
  process.exit(1);
}

const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf-8")) as { version: number; entries: V1Entry[] };

if (raw.version === 2) {
  console.log("Corpus is already v2 — nothing to migrate.");
  process.exit(0);
}

if (raw.version !== 1) {
  console.error(`Unexpected corpus version ${raw.version} — expected 1.`);
  process.exit(1);
}

const migrated: V2Entry[] = raw.entries.map(migrateEntry);
const todoCount = migrated.filter((e) => e.antiPatterns.antiPatterns.includes(TODO_PLACEHOLDER)).length;

console.log(`Migrating ${migrated.length} entries: v1 → v2`);
console.log("  patternType inference + whatToAvoidHere → antiPatterns restructure");
migrated.forEach((e) => console.log(`  ${e.id}: patternType=${e.patternType} | antiPatterns=${e.antiPatterns.antiPatterns.length} item(s)${e.antiPatterns.antiPatterns.includes(TODO_PLACEHOLDER) ? " [TODO placeholder]" : ""}`));
console.log(`\n  ${todoCount} entr${todoCount === 1 ? "y" : "ies"} need anti-pattern backfill (marked [TODO]).`);

if (values["dry-run"]) {
  console.log("\nDry run — no changes written.");
  process.exit(0);
}

writeFileSync(CORPUS_PATH, JSON.stringify({ version: 2, entries: migrated }, null, 2) + "\n", "utf-8");
console.log(`\n✅ Wrote v2 corpus: ${CORPUS_PATH}`);
console.log("Next: backfill [TODO] anti-patterns, then `npm run validate-corpus` and `npm run build-index -- --force`.");
} // end if (isMain)
