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
 *
 * Dedup gate: each entry is fingerprinted (SHA-256 exact + dHash near-dup)
 * against the committed corpus AND already-checked siblings in this batch.
 * Duplicates are skipped with a warning — the entry stays "approved" in the
 * draft for investigation. This closes the hole that let byte-identical
 * duplicates enter via bulk import (the UI's POST /api/entries had the gate;
 * this CLI path previously did not).
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { execSync } from "node:child_process";
import { Corpus, CorpusEntry, findDraftMarkers } from "../schema.js";
import { findDuplicateAtCommit } from "../dedup.js";
import { ENTRIES_PATH, persistEntries } from "../persistence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT  = resolve(__dirname, "..", "..", "corpus");
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

async function main() {
  const draft    = JSON.parse(readFileSync(DRAFT_PATH, "utf-8")) as DraftFile;
  const approved = draft.entries.filter((e) => e._importStatus === "approved");

  if (approved.length === 0) {
    console.log("No approved entries in draft. Run npm run review-draft first.");
    process.exit(0);
  }

  // Load + parse existing corpus
  const corpusRaw = JSON.parse(readFileSync(ENTRIES_PATH, "utf-8"));
  const corpus    = Corpus.parse(corpusRaw);
  const existingIds = new Set(corpus.entries.map((e) => e.id));

  // Validate each approved entry against the full schema before writing anything
  const toCommit: typeof corpus.entries = [];
  const errors: string[] = [];
  // Track IDs seen in THIS batch so two approved entries with the same new ID
  // can't both enter toCommit. (The existing corpus check at line below only
  // guards against ids already committed; sibling-vs-sibling within the draft
  // was unguarded.)
  const seenIds = new Set<string>();

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

    if (seenIds.has(result.data.id)) {
      console.log(`  ⚠  Duplicate ID within this batch, skipping: ${result.data.id}`);
      continue;
    }
    seenIds.add(result.data.id);

    toCommit.push(result.data);
  }

  if (errors.length > 0) {
    console.error(`\n${errors.length} entries failed schema validation:\n`);
    errors.forEach((e) => console.error(`  ❌ ${e}`));
    console.error(`\nFix these in ${DRAFT_PATH} and re-run.`);
    if (toCommit.length === 0) process.exit(1);
    console.error(`\nProceeding with ${toCommit.length} valid entries…\n`);
  }

  // ── Dedup gate (the fix) ──────────────────────────────────────────────────
  // Fingerprint each candidate against the committed corpus AND already-checked
  // siblings (incremental comparison catches batch-internal duplicates that the
  // upload-time batchFingerprints map would have caught in the UI flow).
  console.log(`Checking ${toCommit.length} entries for duplicates…`);
  const clean: typeof corpus.entries = [];
  let dupCount = 0;
  for (const candidate of toCommit) {
    const dup = await findDuplicateAtCommit(candidate, [...corpus.entries, ...clean]);
    if (dup) {
      console.log(`  ⚠  Duplicate (${dup.type}) of ${dup.match}, skipping: ${candidate.id}`);
      dupCount++;
    } else {
      clean.push(candidate);
    }
  }
  if (dupCount > 0) {
    console.log(`  ${dupCount} duplicate(s) skipped, ${clean.length} clean.\n`);
  }

  if (args["dry-run"]) {
    console.log(`Dry run — would commit ${clean.length} entries:`);
    clean.forEach((e) => console.log(`  + ${e.id} (${e.qualityScore}/5)`));
    process.exit(0);
  }

  if (clean.length === 0) {
    console.log("Nothing to commit after dedup.");
    process.exit(0);
  }

  // Write to corpus via the durability layer (snapshot + atomic write).
  corpus.entries.push(...clean);
  persistEntries(corpus.entries);

  // Mark committed in draft (idempotent re-runs won't double-commit)
  const committedIds = new Set(clean.map((e) => e.id));
  for (const raw of approved) {
    const d = raw as DraftEntry;
    const id = (d as { id?: string }).id;
    if (id && committedIds.has(id)) {
      d._importStatus = "committed";
    }
  }
  writeFileSync(DRAFT_PATH, JSON.stringify(draft, null, 2) + "\n", "utf-8");

  console.log(`✅ Committed ${clean.length} entries to corpus.`);
  clean.forEach((e) => console.log(`  + ${e.id}`));

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
}

main();
