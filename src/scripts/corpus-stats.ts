#!/usr/bin/env node
/**
 * corpus-stats.ts — coverage, staleness, and quality reporting
 *
 * Usage:
 *   npm run corpus-stats
 *   npm run corpus-stats -- --json
 *   npm run corpus-stats -- --stale-months 9
 *   npm run corpus-stats -- --min-count 3
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PatternType, Category, StyleTag } from "../schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "..", "..", "corpus", "entries.json");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const staleMonths = Number(getArg("--stale-months") ?? 12);
const minCount = Number(getArg("--min-count") ?? 3);

function getArg(flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

// Full enum values from schema.ts (the source of truth)
const FULL_PATTERN_TYPES = PatternType.options;
const FULL_CATEGORIES = Category.options;
const FULL_STYLE_TAGS = StyleTag.options;

interface Entry {
  id: string;
  patternType?: string;
  categories?: string[];
  styleTags?: string[];
  qualityTier?: string;
  source?: { lastVerified?: string; capturedAt?: string };
  antiPatterns?: { antiPatterns?: string[] };
}

const VAGUE_PHRASES = [
  "avoid clutter", "keep it clean", "keep it simple", "don't overdo it",
  "be consistent", "avoid confusion", "too busy", "too much going on",
  "not intuitive", "bad ux", "poor ux",
];
const MIN_WORDS = 8;

function lintAntiPattern(text: string): string[] {
  const issues: string[] = [];
  const lower = text.toLowerCase();
  for (const phrase of VAGUE_PHRASES) {
    if (lower.includes(phrase)) issues.push(`generic filler: "${phrase}"`);
  }
  if (text.trim().split(/\s+/).length < MIN_WORDS) {
    issues.push(`too short (<${MIN_WORDS} words) to be specific`);
  }
  return issues;
}

function countBy(entries: Entry[], getter: (e: Entry) => string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const e of entries) for (const val of getter(e)) counts[val] = (counts[val] ?? 0) + 1;
  return counts;
}

function computeGaps(counts: Record<string, number>, fullEnum: readonly string[], minCount: number) {
  const zero: string[] = [];
  const belowThreshold: { value: string; count: number }[] = [];
  for (const val of fullEnum) {
    const c = counts[val] ?? 0;
    if (c === 0) zero.push(val);
    else if (c < minCount) belowThreshold.push({ value: val, count: c });
  }
  belowThreshold.sort((a, b) => a.count - b.count);
  return { zero, belowThreshold };
}

const raw = readFileSync(CORPUS_PATH, "utf-8");
const corpus = JSON.parse(raw);
const entries: Entry[] = corpus.entries;

const patternTypeCounts = countBy(entries, (e) => (e.patternType ? [e.patternType] : []));
const categoryCounts = countBy(entries, (e) => e.categories ?? []);
const styleTagCounts = countBy(entries, (e) => e.styleTags ?? []);
const qualityTierCounts = countBy(entries, (e) => (e.qualityTier ? [e.qualityTier] : []));

const patternTypeGaps = computeGaps(patternTypeCounts, FULL_PATTERN_TYPES, minCount);
const categoryGaps = computeGaps(categoryCounts, FULL_CATEGORIES, minCount);
const styleTagGaps = computeGaps(styleTagCounts, FULL_STYLE_TAGS, minCount);

const staleCutoff = new Date();
staleCutoff.setMonth(staleCutoff.getMonth() - staleMonths);
const staleEntries = entries
  .map((e) => ({ id: e.id, dateStr: e.source?.lastVerified ?? e.source?.capturedAt }))
  .filter((e) => e.dateStr && new Date(e.dateStr) < staleCutoff)
  .sort((a, b) => (a.dateStr! < b.dateStr! ? -1 : 1));

const antiPatternIssues: { id: string; text: string; issues: string[] }[] = [];
for (const e of entries) {
  for (const text of e.antiPatterns?.antiPatterns ?? []) {
    const issues = lintAntiPattern(text);
    if (issues.length) antiPatternIssues.push({ id: e.id, text, issues });
  }
}

const report = {
  totalEntries: entries.length,
  distribution: { patternType: patternTypeCounts, categories: categoryCounts, styleTags: styleTagCounts, qualityTier: qualityTierCounts },
  coverageGaps: { patternType: patternTypeGaps, categories: categoryGaps, styleTags: styleTagGaps },
  staleness: { cutoffMonths: staleMonths, staleCount: staleEntries.length, staleEntries },
  antiPatternQuality: { flaggedCount: antiPatternIssues.length, flagged: antiPatternIssues },
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const hr = () => console.log("─".repeat(70));
  const ct = (c: Record<string, number>) => Object.entries(c).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`  ${k.padEnd(24)}${v}`));

  hr();
  console.log(`corpus-stats — ${report.totalEntries} entries`);
  hr();
  console.log("\n📊 patternType"); ct(patternTypeCounts);
  console.log("\n📊 qualityTier"); ct(qualityTierCounts);
  console.log("\n📊 categories"); ct(categoryCounts);
  console.log("\n📊 styleTags"); ct(styleTagCounts);
  hr();
  console.log("\n🕳️  Coverage gaps (against full schema enum)");
  console.log("  patternType — zero:", patternTypeGaps.zero.length ? patternTypeGaps.zero.join(", ") : "(none — full coverage)");
  console.log("  patternType — thin:", styleTagGaps.belowThreshold.length ? patternTypeGaps.belowThreshold.map((g) => `${g.value} (${g.count})`).join(", ") : "(none)");
  console.log("  categories — zero:", categoryGaps.zero.length ? categoryGaps.zero.join(", ") : "(none — full coverage)");
  console.log("  styleTags — zero:", styleTagGaps.zero.length ? styleTagGaps.zero.join(", ") : "(none — full coverage)");
  hr();
  console.log(`\n🕰️  Staleness (cutoff: ${staleMonths}mo) — ${staleEntries.length} stale`);
  staleEntries.slice(0, 15).forEach((e) => console.log(`    ${e.id}  (${e.dateStr})`));
  hr();
  console.log(`\n🚩 Anti-pattern lint — ${antiPatternIssues.length} flagged`);
  antiPatternIssues.slice(0, 15).forEach((f) => { console.log(`  [${f.id}] "${f.text}"`); f.issues.forEach((i) => console.log(`      → ${i}`)); });
  hr();
}
