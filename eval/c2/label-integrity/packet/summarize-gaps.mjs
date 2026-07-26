#!/usr/bin/env node
// Merges the vocabulary-gap reports from both reviewers into one ranked
// shortlist for a corpus-enrichment pass.
//
//   node eval/c2/label-integrity/packet/summarize-gaps.mjs gaps-a.json gaps-b.json [--json]
//
// Accepts either the `--gaps` output of validate-reviewer-file.mjs or a raw
// reviewer export (it will read `vocabularyGaps` from the latter).
//
// Ranking: proposals both reviewers independently asked for are the strong
// signal — the same convergence rule the repo applies to review findings. A
// single-reviewer flag is worth reading but is one person's judgement.
import fs from "node:fs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const files = args.filter((a) => !a.startsWith("--"));

if (files.length < 1) {
  console.error("usage: summarize-gaps.mjs <gaps-a.json> [gaps-b.json ...] [--json]");
  process.exit(2);
}

/** Loose match so "bottom nav", "bottom-nav" and "Bottom Nav" converge. */
const norm = (s) => s.toLowerCase().trim().replace(/[\s_]+/g, "-").replace(/-+/g, "-");

const proposals = new Map(); // "field::wanted" -> {field, wanted, reviewers:Set, entryIds:Set, notes:[]}

for (const file of files) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const gaps = raw.gaps ?? raw.vocabularyGaps ?? [];
  const reviewer = raw.reviewer ?? file;
  if (!Array.isArray(gaps)) {
    console.error(`${file}: no gaps array found`);
    process.exit(1);
  }
  for (const gap of gaps) {
    const key = `${gap.field}::${norm(gap.wanted)}`;
    if (!proposals.has(key)) {
      proposals.set(key, {
        field: gap.field,
        wanted: norm(gap.wanted),
        reviewers: new Set(),
        entryIds: new Set(),
        notes: [],
      });
    }
    const p = proposals.get(key);
    p.reviewers.add(reviewer);
    p.entryIds.add(gap.entryId);
    if (gap.note) p.notes.push(`${reviewer}: ${gap.note}`);
  }
}

const ranked = [...proposals.values()]
  .map((p) => ({
    field: p.field,
    wanted: p.wanted,
    reviewerCount: p.reviewers.size,
    reviewers: [...p.reviewers].sort(),
    entryCount: p.entryIds.size,
    entryIds: [...p.entryIds].sort(),
    notes: p.notes,
    converged: p.reviewers.size > 1,
  }))
  .sort((a, b) =>
    b.reviewerCount - a.reviewerCount ||
    b.entryCount - a.entryCount ||
    a.field.localeCompare(b.field) ||
    a.wanted.localeCompare(b.wanted));

if (asJson) {
  console.log(JSON.stringify({ sources: files, proposals: ranked }, null, 2));
  process.exit(0);
}

if (!ranked.length) {
  console.log("No vocabulary gaps flagged. The closed lists covered all 40 entries.");
  process.exit(0);
}

const converged = ranked.filter((p) => p.converged);
const single = ranked.filter((p) => !p.converged);

console.log(`${ranked.length} distinct proposal(s) from ${files.length} reviewer file(s)\n`);

const show = (p) =>
  console.log(
    `  ${p.field.padEnd(16)} ${p.wanted.padEnd(24)} ` +
    `${p.reviewerCount} reviewer(s), ${p.entryCount} entr${p.entryCount === 1 ? "y" : "ies"}`,
  );

if (converged.length) {
  console.log(`CONVERGED — both reviewers independently wanted these (${converged.length}):`);
  converged.forEach(show);
  console.log();
}
if (single.length) {
  console.log(`SINGLE REVIEWER — read, but weaker evidence (${single.length}):`);
  single.forEach(show);
  console.log();
}

const notes = ranked.filter((p) => p.notes.length);
if (notes.length) {
  console.log("Notes:");
  for (const p of notes) {
    console.log(`  ${p.field} / ${p.wanted}`);
    for (const n of p.notes) console.log(`    ${n}`);
  }
  console.log();
}

console.log("Adding any of these changes the vocabulary. Do not apply mid-labeling —");
console.log("it invalidates passes already done. Note also that widening components or");
console.log("domainTags lowers their baseline, and those two floors have no fixed minimum.");
