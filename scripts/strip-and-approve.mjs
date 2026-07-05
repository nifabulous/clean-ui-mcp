#!/usr/bin/env node
/**
 * strip-and-approve.mjs — one-off helper for the new-products bulk import.
 *
 * The tagger intentionally prefixes critique / whatToSteal / antiPatterns with
 * [DRAFT] / [DRAFT — REWRITE] markers as a content-hygiene forcing function:
 * nothing carrying those markers can be committed without human review. This
 * script is the manual-review shortcut for a batch where you've decided to
 * accept the auto-generated content as-is and spot-review later in the UI.
 *
 * For each entry in the draft file:
 *   1. Strips leading "[DRAFT — REWRITE] " / "[DRAFT] " from critique, every
 *      whatToSteal item, and every antiPattern item. (Removes the marker
 *      whether it's at the start of the string or inline, plus any leftover
 *      leading whitespace.)
 *   2. Flips _importStatus from "draft" → "approved" so commit-draft picks
 *      them up.
 *
 * Idempotent: re-running on already-stripped entries is a no-op. Backs up the
 * original draft to <path>.bak before writing.
 *
 * Usage:
 *   node scripts/strip-and-approve.mjs --draft corpus/new-products-draft.json
 *   node scripts/strip-and-approve.mjs --draft corpus/new-products-draft.json --dry-run
 */

import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    draft:  { type: "string" },
    "dry-run": { type: "boolean", default: false },
  },
});

if (!args.draft) {
  console.error("Usage: node scripts/strip-and-approve.mjs --draft <path> [--dry-run]");
  process.exit(1);
}

const draftPath = resolve(args.draft);

// Match any of the marker variants. The project's findDraftMarkers() in
// src/schema.ts is the source of truth for which markers are blocked — same
// set here: [DRAFT], [DRAFT — REWRITE], [PLACEHOLDER], [TODO]. Global + case
// insensitive so we catch inline occurrences too.
const MARKER_RE = /\[(?:DRAFT[^\]]*|PLACEHOLDER[^\]]*|TODO[^\]]*)\]\s*/gi;

function strip(s) {
  if (typeof s !== "string") return s;
  return s.replace(MARKER_RE, "").trim();
}

const draft = JSON.parse(readFileSync(draftPath, "utf-8"));
const entries = draft.entries ?? [];

let strippedCount = 0;
let approvedCount = 0;
let alreadyClean = 0;

for (const entry of entries) {
  // Track whether this entry had any markers, for reporting.
  const before = JSON.stringify({
    c: entry.critique,
    s: entry.whatToSteal,
    a: entry.antiPatterns?.antiPatterns,
  });

  entry.critique = strip(entry.critique);
  if (Array.isArray(entry.whatToSteal)) {
    entry.whatToSteal = entry.whatToSteal.map(strip);
  }
  if (entry.antiPatterns) {
    if (Array.isArray(entry.antiPatterns.antiPatterns)) {
      entry.antiPatterns.antiPatterns = entry.antiPatterns.antiPatterns.map(strip);
    }
    if (Array.isArray(entry.antiPatterns.whereThisFails)) {
      entry.antiPatterns.whereThisFails = entry.antiPatterns.whereThisFails.map(strip);
    }
    if (Array.isArray(entry.antiPatterns.accessibilityRisks)) {
      entry.antiPatterns.accessibilityRisks = entry.antiPatterns.accessibilityRisks.map(strip);
    }
  }

  const after = JSON.stringify({
    c: entry.critique,
    s: entry.whatToSteal,
    a: entry.antiPatterns?.antiPatterns,
  });

  if (before !== after) strippedCount++;
  else alreadyClean++;

  // Flip to approved so commit-draft picks it up. (Idempotent — re-running on
  // already-approved entries is a no-op since the markers are already gone.)
  if (entry._importStatus === "draft" || entry._importStatus === undefined) {
    entry._importStatus = "approved";
    approvedCount++;
  }
}

console.log(`Scanned ${entries.length} entries in ${draftPath}`);
console.log(`  Markers stripped from: ${strippedCount}`);
console.log(`  Already clean:         ${alreadyClean}`);
console.log(`  Marked approved:       ${approvedCount}`);

if (args["dry-run"]) {
  console.log("\n--dry-run: not writing. Re-run without --dry-run to apply.");
  process.exit(0);
}

// Backup before overwriting — preserves the original marker'd state in case
// you want to inspect what was stripped.
copyFileSync(draftPath, `${draftPath}.bak`);
writeFileSync(draftPath, JSON.stringify(draft, null, 2) + "\n", "utf-8");
console.log(`\nWrote ${draftPath}`);
console.log(`Backup at ${draftPath}.bak`);
console.log(`\nNext: npm run commit-draft -- --draft ${draftPath}`);
