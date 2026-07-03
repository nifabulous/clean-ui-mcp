#!/usr/bin/env node
/**
 * review-draft.ts
 * ───────────────
 * Interactive terminal reviewer for corpus/entries-draft.json.
 * Shows each draft entry and lets you approve, edit the critique,
 * skip, or mark as rejected — one at a time.
 *
 * Usage:
 *   npm run review-draft
 *   npm run review-draft -- --draft path/to/other-draft.json
 *
 * After reviewing, run:
 *   npm run commit-draft   → commits all approved entries to corpus
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseArgs } from "node:util";
import type { TaggerOutput } from "../tagger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_DRAFT = resolve(__dirname, "..", "..", "corpus", "entries-draft.json");

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    draft: { type: "string" },
    help:  { type: "boolean", short: "h", default: false },
  },
});

if (args.help) {
  console.log(`Usage: npm run review-draft [-- --draft <path>]`);
  process.exit(0);
}

const DRAFT_PATH = resolve(args.draft ?? DEFAULT_DRAFT);
if (!existsSync(DRAFT_PATH)) {
  console.error(`Draft not found: ${DRAFT_PATH}\nRun npm run bulk-import first.`);
  process.exit(1);
}

type ImportStatus = "draft" | "approved" | "skipped" | "rejected";
type DraftEntry   = TaggerOutput & { _importStatus: ImportStatus };
interface DraftFile { version: 1; exportedAt: string; entries: DraftEntry[]; }

const draft   = JSON.parse(readFileSync(DRAFT_PATH, "utf-8")) as DraftFile;
const pending = draft.entries.filter((e) => e._importStatus === "draft");

if (pending.length === 0) {
  const approved = draft.entries.filter((e) => e._importStatus === "approved").length;
  console.log(`No pending entries. ${approved} already approved — run npm run commit-draft.`);
  process.exit(0);
}

console.log(`\n${pending.length} entries pending review.\n`);

const rl = createInterface({ input, output });
const ask = async (prompt: string, fallback = "") => {
  const a = await rl.question(`  ${prompt}${fallback ? ` [${fallback}]` : ""}: `);
  return a.trim() || fallback;
};
const askMultiline = async (prompt: string) => {
  console.log(`  ${prompt} (end with a line containing only ".")`);
  const lines: string[] = [];
  while (true) {
    const l = await rl.question("  > ");
    if (l.trim() === ".") break;
    lines.push(l);
  }
  return lines.join("\n");
};

async function reviewEntry(entry: DraftEntry, n: number, total: number): Promise<ImportStatus> {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`Entry ${n}/${total}: ${entry.title}`);
  console.log(`  Source:    ${entry.source.productName} — ${entry.source.url}`);
  console.log(`  Image:     ${entry.image.path ?? "(none)"}`);
  console.log(`  Category:  ${entry.categories.join(", ")}`);
  console.log(`  Style:     ${entry.styleTags.join(", ")}`);
  console.log(`  Colors:    ${entry.visual.dominantColors.join(", ")} | accent: ${entry.visual.accentColor ?? "none"}`);
  console.log(`  Type:      ${entry.visual.typePairing.display ?? "?"} / ${entry.visual.typePairing.body ?? "?"}`);
  console.log(`  Spacing:   ${entry.visual.spacingDensity} | Corners: ${entry.visual.cornerStyle}`);
  console.log(`  Shadows: ${entry.visual.usesShadows} | Borders: ${entry.visual.usesBorders}`);
  console.log(`\n  Critique:\n  ${entry.critique.replace("[DRAFT — REWRITE] ", "")}`);
  console.log(`\n  What to steal:`);
  entry.whatToSteal.forEach((t) => console.log(`    - ${t.replace("[DRAFT] ", "")}`));

  console.log(`\n  [a] approve as-is   [e] edit critique/steal   [s] skip (decide later)   [r] reject`);
  const choice = (await rl.question("  → ")).trim().toLowerCase();

  if (choice === "r") return "rejected";
  if (choice === "s") return "draft"; // stays as draft = pending

  if (choice === "e") {
    // Edit mode
    const newTitle = await ask("Title", entry.title);
    entry.title = newTitle;

    const cats = await ask("Categories (comma-separated)", entry.categories.join(", "));
    entry.categories = cats.split(",").map((c) => c.trim()).filter(Boolean) as string[];

    const tags = await ask("Style tags (comma-separated)", entry.styleTags.join(", "));
    entry.styleTags = tags.split(",").map((t) => t.trim()).filter(Boolean) as string[];

    console.log(`\n  Current critique: ${entry.critique.replace("[DRAFT — REWRITE] ", "")}`);
    const rewrite = await ask("Rewrite critique? (Enter to keep)", "");
    if (rewrite) entry.critique = rewrite;
    else entry.critique = entry.critique.replace("[DRAFT — REWRITE] ", "");

    console.log(`\n  Current what-to-steal:\n${entry.whatToSteal.map(t => `    ${t}`).join("\n")}`);
    const rewriteSteal = await ask("Rewrite what-to-steal? (y to rewrite, Enter to clean [DRAFT] markers)", "n");
    if (rewriteSteal.toLowerCase().startsWith("y")) {
      entry.whatToSteal = [];
      const newSteal = await askMultiline("What to steal (one per line):");
      entry.whatToSteal = newSteal.split("\n").map((l) => l.trim()).filter(Boolean);
    } else {
      entry.whatToSteal = entry.whatToSteal.map((t) => t.replace("[DRAFT] ", ""));
    }

    const qa = await ask("Quality score (1-5)", String(entry.qualityScore));
    entry.qualityScore = Math.min(5, Math.max(1, parseInt(qa) || entry.qualityScore));
  }

  // Approve: clean up [DRAFT] markers if editor didn't
  if (choice === "a" || choice === "e") {
    entry.critique   = entry.critique.replace("[DRAFT — REWRITE] ", "");
    entry.whatToSteal = entry.whatToSteal.map((t) => t.replace("[DRAFT] ", ""));
    return "approved";
  }

  return "draft";
}

// ─── main loop ────────────────────────────────────────────────────────────────

async function main() {
  let i = 0;
  for (const entry of pending) {
    i++;
    const status = await reviewEntry(entry, i, pending.length);
    entry._importStatus = status;

    // Persist after every decision so progress isn't lost if interrupted
    writeFileSync(DRAFT_PATH, JSON.stringify(draft, null, 2) + "\n", "utf-8");
  }

  const approved = draft.entries.filter((e) => e._importStatus === "approved").length;
  const skipped  = draft.entries.filter((e) => e._importStatus === "draft").length;
  const rejected = draft.entries.filter((e) => e._importStatus === "rejected").length;

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Review complete:`);
  console.log(`  ✅ Approved: ${approved}`);
  console.log(`  ⏭  Skipped:  ${skipped}`);
  console.log(`  ❌ Rejected: ${rejected}`);

  if (approved > 0) {
    console.log(`\nRun: npm run commit-draft`);
  }

  rl.close();
}

main().catch((err) => { console.error(err); process.exit(1); });
