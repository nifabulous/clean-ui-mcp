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

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PatternType, Category, StyleTag } from "../schema.js";
import { indexStatus } from "../corpus.js";
import { CORPUS_ROOT } from "../paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "..", "..", "corpus", "entries.json");
const PRIVATE_IMAGE_DIR = resolve(CORPUS_ROOT, "images-private");
const PUBLIC_IMAGE_DIR = resolve(CORPUS_ROOT, "images-public");

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
  source?: { productName?: string; lastVerified?: string; capturedAt?: string };
  antiPatterns?: { antiPatterns?: string[] };
  image?: { visibility?: string; path?: string | null; width?: number | null; height?: number | null };
  voice?: { tone?: string };
  layout?: { form?: string };
  critique?: string;
}

/** List filenames in a dir, or [] if it doesn't exist (keeps corpus-stats runnable on a fresh checkout). */
function safeListDir(dir: string): string[] {
  try { return readdirSync(dir).filter((f) => !f.startsWith(".")); }
  catch { return []; }
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

// ── index coverage (drift detection: missing + stale vectors) ────────────────
const index = indexStatus();

// ── image references (orphans + missing files) ───────────────────────────────
// Referenced = entries that point at an image path. Orphan = private image
// files on disk that no entry references. Missing = entries whose path doesn't
// resolve to a real file (broken reference).
const referencedPaths = new Set(entries.map((e) => e.image?.path).filter((p): p is string => !!p));
const privateFiles = safeListDir(PRIVATE_IMAGE_DIR);
const publicFiles = safeListDir(PUBLIC_IMAGE_DIR);
const allDiskFiles = new Set([...privateFiles.map((f) => `images-private/${f}`), ...publicFiles.map((f) => `images-public/${f}`)]);
const orphanFiles = [...allDiskFiles].filter((f) => !referencedPaths.has(f)).sort();
const missingFiles = [...referencedPaths].filter((p) => !allDiskFiles.has(p)).sort();

// ── quality metrics (coverage of optional-but-valuable fields) ───────────────
const productCounts = countBy(entries, (e) => (e.source?.productName ? [e.source.productName] : []));
const withVoice = entries.filter((e) => e.voice?.tone && e.voice.tone.trim()).length;
const withLayout = entries.filter((e) => e.layout?.form && e.layout.form.trim()).length;
const withImage = entries.filter((e) => !!e.image?.path).length;
const critiqueLengths = entries.map((e) => (e.critique ?? "").length).filter((n) => n > 0);
const avgCritiqueLength = critiqueLengths.length ? Math.round(critiqueLengths.reduce((a, b) => a + b, 0) / critiqueLengths.length) : 0;

const report = {
  totalEntries: entries.length,
  distribution: { patternType: patternTypeCounts, categories: categoryCounts, styleTags: styleTagCounts, qualityTier: qualityTierCounts, product: productCounts },
  coverageGaps: { patternType: patternTypeGaps, categories: categoryGaps, styleTags: styleTagGaps },
  staleness: { cutoffMonths: staleMonths, staleCount: staleEntries.length, staleEntries },
  antiPatternQuality: { flaggedCount: antiPatternIssues.length, flagged: antiPatternIssues },
  indexCoverage: { indexed: index.indexed, total: index.total, hasIndex: index.hasIndex, missing: index.missing, stale: index.stale },
  imageReferences: { referencedCount: referencedPaths.size, orphanCount: orphanFiles.length, missingCount: missingFiles.length, orphans: orphanFiles.slice(0, 20), missing: missingFiles.slice(0, 20) },
  quality: {
    voiceCoverage: entries.length ? Math.round((withVoice / entries.length) * 100) : 0,
    layoutCoverage: entries.length ? Math.round((withLayout / entries.length) * 100) : 0,
    imageAvailability: entries.length ? Math.round((withImage / entries.length) * 100) : 0,
    avgCritiqueLength,
  },
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
  // Index coverage — drift detection.
  console.log(`\n🔍 Index coverage`);
  if (report.indexCoverage.hasIndex) {
    console.log(`  indexed: ${report.indexCoverage.indexed}/${report.indexCoverage.total}  ·  missing: ${report.indexCoverage.missing}  ·  stale: ${report.indexCoverage.stale}`);
    if (report.indexCoverage.missing > 0 || report.indexCoverage.stale > 0) {
      console.log(`  ⚠ index is out of date — run \`npm run build-index\``);
    }
  } else {
    console.log("  no index — run `npm run build-index` to enable semantic vector search");
  }
  hr();
  // Image references — orphans + missing files.
  console.log(`\n🖼️  Image references`);
  console.log(`  referenced: ${report.imageReferences.referencedCount}  ·  orphans: ${report.imageReferences.orphanCount}  ·  missing: ${report.imageReferences.missingCount}`);
  if (report.imageReferences.orphanCount > 0) {
    console.log(`  orphan files (cleanup: \`npm run clean-orphans -- --dry-run\`):`);
    report.imageReferences.orphans.forEach((f) => console.log(`    ${f}`));
  }
  if (report.imageReferences.missingCount > 0) {
    console.log(`  ⚠ entries pointing at missing files:`);
    report.imageReferences.missing.forEach((f) => console.log(`    ${f}`));
  }
  hr();
  // Quality metrics — coverage of optional-but-valuable fields.
  console.log(`\n📈 Quality coverage`);
  console.log(`  voice:   ${report.quality.voiceCoverage}% have voice.tone`);
  console.log(`  layout:  ${report.quality.layoutCoverage}% have layout.form`);
  console.log(`  images:  ${report.quality.imageAvailability}% have an image path`);
  console.log(`  critique: avg ${report.quality.avgCritiqueLength} chars`);
  console.log(`\n  top products:`);
  Object.entries(productCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log(`    ${k.padEnd(24)}${v}`));
  hr();
}
