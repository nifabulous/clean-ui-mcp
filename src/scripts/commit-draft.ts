#!/usr/bin/env node
/**
 * commit-draft.ts
 * ───────────────
 * Reads corpus/entries-draft.json and commits all entries marked
 * "approved" into corpus/entries.json.
 *
 * Usage:
 *   npm run commit-draft
 *   npm run commit-draft -- --draft path/to/other-draft.json
 *   npm run commit-draft -- --dry-run   (preview without writing)
 *
 * After committing, approved entries are marked "committed" in the
 * draft file so re-running is safe (idempotent).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execSync } from "node:child_process";
import { Corpus, CorpusEntry, findDraftMarkers } from "../schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT  = resolve(__dirname, "..", "..", "corpus");
const CORPUS_PATH  = resolve(CORPUS_ROOT, "entries.json");
const DEFAULT_DRAFT = resolve(CORPUS_ROOT, "entries-draft.json");

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    draft:    { type: "string" },
    "dry-run": { type: "boolean", default: false },
    help:     { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  console.log(`Usage: npm run commit-draft [-- --draft <path>] [-- --dry-run]`);
  process.exit(0);
}

const DRAFT_PATH = resolve(args.draft ?? DEFAULT_DRAFT);
if (!existsSync(DRAFT_PATH)) {
  console.error(`Draft not found: ${DRAFT_PATH}`);
  process.exit(1);
}

type ImportStatus = "draft" | "approved" | "skipped" | "rejected" | "committed";
interface DraftEntry { _importStatus: ImportStatus; [k: string]: unknown; }
interface DraftFile  { version: 1; exportedAt: string; entries: DraftEntry[]; }

const draft    = JSON.parse(readFileSync(DRAFT_PATH, "utf-8")) as DraftFile;
const approved = draft.entries.filter((e) => e._importStatus === "approved");

if (approved.length === 0) {
  console.log("No approved entries in draft. Run npm run review-draft first.");
  process.exit(0);
}

// Load + parse existing corpus
const corpusRaw = JSON.parse(readFileSync(CORPUS_PATH, "utf-8"));
const corpus    = Corpus.parse(corpusRaw);
const existingIds = new Set(corpus.entries.map((e) => e.id));

// Validate each approved entry against the full schema before writing anything
const toCommit: typeof corpus.entries = [];
const errors: string[] = [];

for (const raw of approved) {
  // Strip draft-only fields
  const { _importStatus, _raw, ...entryData } = raw as Record<string, unknown>;
  const result = CorpusEntry.safeParse(entryData);

  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    errors.push(`${(entryData as { id?: string }).id ?? "?"}: ${issues}`);
    continue;
  }

  const dirtyFields = findDraftMarkers(result.data);
  if (dirtyFields.length) {
    errors.push(`${result.data.id}: contains draft/placeholder marker in ${dirtyFields.join(", ")}`);
    continue;
  }

  if (existingIds.has(result.data.id)) {
    console.log(`  ⚠  Already in corpus, skipping: ${result.data.id}`);
    continue;
  }

  toCommit.push(result.data);
}

if (errors.length > 0) {
  console.error(`\n${errors.length} entries failed schema validation:\n`);
  errors.forEach((e) => console.error(`  ❌ ${e}`));
  console.error(`\nFix these in ${DRAFT_PATH} and re-run.`);
  if (toCommit.length === 0) process.exit(1);
  console.error(`\nProceeding with ${toCommit.length} valid entries…\n`);
}

if (args["dry-run"]) {
  console.log(`Dry run — would commit ${toCommit.length} entries:`);
  toCommit.forEach((e) => console.log(`  + ${e.id} (${e.qualityScore}/5)`));
  process.exit(0);
}

// Write to corpus
corpus.entries.push(...toCommit);
writeFileSync(CORPUS_PATH, JSON.stringify(corpus, null, 2) + "\n", "utf-8");

// Mark committed in draft (idempotent re-runs won't double-commit)
for (const raw of approved) {
  const d = raw as DraftEntry;
  const id = (d as { id?: string }).id;
  if (toCommit.some((e) => e.id === id)) {
    d._importStatus = "committed";
  }
}
writeFileSync(DRAFT_PATH, JSON.stringify(draft, null, 2) + "\n", "utf-8");

console.log(`✅ Committed ${toCommit.length} entries to corpus.`);
toCommit.forEach((e) => console.log(`  + ${e.id}`));

// Run validator to confirm corpus is still healthy
console.log("\nValidating corpus…");
try {
  execSync("npm run validate-corpus", {
    cwd: resolve(__dirname, "..", ".."),
    stdio: "inherit",
  });
} catch {
  console.error("❌ Validator failed — check corpus/entries.json.");
  process.exit(1);
}

console.log("\nNext: npm run build-index  (to update vector search)");
