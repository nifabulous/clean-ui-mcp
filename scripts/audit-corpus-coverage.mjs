#!/usr/bin/env node
/**
 * Field-coverage audit for the deterministic synthesizer. Prints the coverage
 * table over corpus/entries.json and exits 1 when any synthesis floor fails.
 * Usage: node scripts/audit-corpus-coverage.mjs [corpusPath]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const corpusPath = process.argv[2] ?? resolve(process.cwd(), "corpus/entries.json");
const data = JSON.parse(readFileSync(corpusPath, "utf8"));
const entries = Array.isArray(data.entries) ? data.entries : data.entries ?? [];
const n = entries.length;

const count = (pred) => entries.filter(pred).length;
const nonEmpty = (v) => v !== undefined && v !== null && (!Array.isArray(v) ? String(v).trim().length > 0 : v.length > 0);

const rows = [
  ["visual.* (structured fields)", count((e) => Boolean(e.visual))],
  ["visual.colorRoles", count((e) => nonEmpty(e.visual?.colorRoles))],
  ["layout", count((e) => nonEmpty(e.layout))],
  ["voice", count((e) => nonEmpty(e.voice))],
  ["mood", count((e) => nonEmpty(e.mood))],
  ["top-level colorScheme", count((e) => nonEmpty(e.colorScheme))],
  ["whatToSteal / antiPatterns / critique", count((e) => nonEmpty(e.whatToSteal) && nonEmpty(e.antiPatterns) && nonEmpty(e.critique))],
];

console.log(`Coverage audit (${n} entries, ${corpusPath})`);
for (const [field, covered] of rows) {
  console.log(`${field}: ${covered}/${n}`);
}

const FLOORS = { "visual.colorRoles": 600, layout: 600 };
let failed = false;
for (const [field, floor] of Object.entries(FLOORS)) {
  const row = rows.find(([f]) => f === field);
  const covered = row ? row[1] : 0;
  if (covered < floor) {
    console.error(`FAIL: ${field} coverage ${covered} < floor ${floor}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
