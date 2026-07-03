#!/usr/bin/env node
/**
 * migrate-layout-field.ts
 * ─────────────────────────
 * Populates the structured `layout` field (added to CorpusEntry v2) for the
 * dashboard entries, derived from their critique prose.
 *
 * This is a field-populator, NOT a version bump (layout is additive/optional).
 * Idempotent: skips entries that already have a `layout` block.
 *
 * The layouts here were extracted by reading each entry's own critique +
 * whatToSteal text — they are the corpus instructing on its own structure, made
 * machine-readable. This is the field the curator UI is rebuilt from (see the
 * three-zone dashboard shell in index-2.html).
 *
 * Usage:
 *   npm run migrate-layout
 *   npm run migrate-layout -- --dry-run
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Corpus } from "../schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "..", "..", "corpus", "entries.json");

// Layouts derived from each entry's critique prose. Keyed by entry id.
// Source sentence cited in the comment for each.
const LAYOUTS: Record<string, { form: string; regions: Array<{ role: string; width?: string }> }> = {
  // "strong grid: persistent left navigation plus a wide content column with
  //  large chart cards and a right rail of stacked promotional/recap cards"
  //  — plus "three-column dashboard grid (left nav + main cards + right rail)"
  "sample": {
    form: "three-column",
    regions: [
      { role: "summary-strip" },
      { role: "primary-nav", width: "fixed-narrow" },
      { role: "main-canvas", width: "flex" },
      { role: "detail-rail", width: "fixed-wide" },
    ],
  },
  // Same three-column dashboard form; "transactions table" canvas + right rail.
  "origin-origin-2": {
    form: "three-column",
    regions: [
      { role: "summary-strip" },
      { role: "primary-nav", width: "fixed-narrow" },
      { role: "main-canvas", width: "flex" },
      { role: "detail-rail", width: "fixed-wide" },
    ],
  },
  // "left icon sidebar with a wide, card-based main canvas" — nav is icon-only.
  "origin-origin-3": {
    form: "three-column",
    regions: [
      { role: "summary-strip" },
      { role: "icon-nav", width: "fixed-narrow" },
      { role: "main-canvas", width: "flex" },
      { role: "detail-rail", width: "fixed-wide" },
    ],
  },
  // "centered modal-like card dominates with generous padding… rest of app
  //  is dimmed" — modal-overlay form.
  "origin-origin-4": {
    form: "modal-overlay",
    regions: [{ role: "overlay-card", width: "flex" }],
  },
  // "Two-column layout pairs a form card with a large photographic hero panel"
  "origin-origin": {
    form: "two-column",
    regions: [
      { role: "form-panel", width: "flex" },
      { role: "visual-panel", width: "fixed-wide" },
    ],
  },
};

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
    console.log(`Usage: npm run migrate-layout [-- --dry-run]`);
    process.exit(0);
  }

  if (!existsSync(CORPUS_PATH)) {
    console.error(`Corpus not found: ${CORPUS_PATH}`);
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf-8"));
  const corpus = Corpus.parse(raw); // validates before we mutate

  let populated = 0;
  let skipped = 0;
  for (const entry of corpus.entries) {
    if (entry.layout) { skipped++; continue; }
    const layout = LAYOUTS[entry.id];
    if (!layout) continue; // entries without a derived layout stay undefined
    (entry as { layout?: unknown }).layout = layout;
    populated++;
    console.log(`  + ${entry.id}: ${layout.form} (${layout.regions.map((r) => r.role).join(" → ")})`);
  }

  console.log(`\nPopulated layout for ${populated} entr${populated === 1 ? "y" : "ies"}${skipped ? `, skipped ${skipped} (already had layout)` : ""}.`);

  if (populated === 0 && skipped === 0) {
    console.log("No matching entries found. Expected dashboard ids: sample, origin-origin, origin-origin-2, origin-origin-3, origin-origin-4.");
  }

  // Re-validate the mutated corpus before writing.
  Corpus.parse({ version: 2, entries: corpus.entries });

  if (values["dry-run"]) {
    console.log("\nDry run — no changes written.");
    process.exit(0);
  }

  writeFileSync(CORPUS_PATH, JSON.stringify({ version: 2, entries: corpus.entries }, null, 2) + "\n", "utf-8");
  console.log(`\n✅ Wrote layouts to ${CORPUS_PATH}`);
}

export { LAYOUTS };
