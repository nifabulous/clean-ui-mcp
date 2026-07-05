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

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { PatternType, Category, StyleTag } from "../schema.js";
import { indexStatus } from "../corpus.js";
import { allImageFiles } from "../paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "..", "..", "corpus", "entries.json");
const SEED_PATH = resolve(__dirname, "..", "..", "corpus", "seed.json");

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
  reviewStatus?: string;
  provenance?: { taggedBy?: string; reviewedBy?: string; capture?: { mode?: string; viewport?: string } };
  source?: { productName?: string; lastVerified?: string; capturedAt?: string };
  antiPatterns?: { antiPatterns?: string[] };
  image?: { visibility?: string; path?: string | null; width?: number | null; height?: number | null };
  voice?: { tone?: string };
  layout?: { form?: string };
  critique?: string;
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

// Fall back to seed.json on a fresh clone (entries.json is gitignored).
const corpusPath = existsSync(CORPUS_PATH) ? CORPUS_PATH : SEED_PATH;
const raw = readFileSync(corpusPath, "utf-8");
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

// ── image references (orphans + missing files, split by visibility tier) ─────
// Referenced = entries that point at an image path. Orphan = private image
// files on disk that no entry references. Missing = entries whose path doesn't
// resolve to a real file (broken reference). Walked recursively so nested
// bulk-import batches (images-private/new-products-batch/…) are counted.
//
// Missing files split into public vs private because the failure modes differ:
//   - missingPublic  → broken committed asset, CI-blocking, real bug
//   - missingPrivate → gitignored, expected-absent on fresh checkouts, not a bug
// Conflating them flooded the lint with false positives whenever someone ran
// corpus-stats without their local images-private/ populated.
const referencedPaths = new Set(entries.map((e) => e.image?.path).filter((p): p is string => !!p));
const allDiskFiles = allImageFiles();
const orphanFiles = [...allDiskFiles].filter((f) => !referencedPaths.has(f)).sort();
const missingFiles = [...referencedPaths].filter((p) => !allDiskFiles.has(p)).sort();
const missingPublic = missingFiles.filter((p) => p.startsWith("images-public/")).sort();
const missingPrivate = missingFiles.filter((p) => p.startsWith("images-private/")).sort();

// ── quality metrics (coverage of optional-but-valuable fields) ───────────────
const productCounts = countBy(entries, (e) => (e.source?.productName ? [e.source.productName] : []));
const withVoice = entries.filter((e) => e.voice?.tone && e.voice.tone.trim()).length;
const withLayout = entries.filter((e) => e.layout?.form && e.layout.form.trim()).length;
// Two image metrics with different meanings:
//   - withImageResolvable  → path is set AND the file exists on disk (the real
//                            coverage number; what the UI will actually render)
//   - withImagePath        → path string is set, ignoring existence (the old
//                            behavior, kept for comparison — surfaces entries
//                            whose path points nowhere)
const withImageResolvable = entries.filter((e) => {
  const p = e.image?.path;
  return !!p && allDiskFiles.has(p);
}).length;
const withImagePath = entries.filter((e) => !!e.image?.path).length;
const withCapture = entries.filter((e) => !!e.provenance?.capture).length;
const critiqueLengths = entries.map((e) => (e.critique ?? "").length).filter((n) => n > 0);
const avgCritiqueLength = critiqueLengths.length ? Math.round(critiqueLengths.reduce((a, b) => a + b, 0) / critiqueLengths.length) : 0;

// ── provenance split (how much was auto-tagged vs human-authored vs reviewed) ─
const provenanceCounts = countBy(entries, (e) => {
  const t = e.provenance?.taggedBy;
  return t ? [t] : ["unknown"]; // pre-field entries have no provenance
});
const draftCount = entries.filter((e) => e.reviewStatus === "draft").length;

const report = {
  totalEntries: entries.length,
  distribution: { patternType: patternTypeCounts, categories: categoryCounts, styleTags: styleTagCounts, qualityTier: qualityTierCounts, product: productCounts },
  coverageGaps: { patternType: patternTypeGaps, categories: categoryGaps, styleTags: styleTagGaps },
  staleness: { cutoffMonths: staleMonths, staleCount: staleEntries.length, staleEntries },
  antiPatternQuality: { flaggedCount: antiPatternIssues.length, flagged: antiPatternIssues },
  indexCoverage: { indexed: index.indexed, total: index.total, hasIndex: index.hasIndex, missing: index.missing, stale: index.stale, contentStale: index.contentStale },
  imageReferences: {
    referencedCount: referencedPaths.size,
    orphanCount: orphanFiles.length,
    missingCount: missingFiles.length,
    orphans: orphanFiles.slice(0, 20),
    // Public missing = broken committed asset (CI-blocking). Full list — these
    // are real bugs and there shouldn't be many.
    missingPublic,
    // Private missing = expected-absent on fresh checkouts (gitignored). Capped
    // at 20 because a missing images-private/ dir produces hundreds of these.
    missingPrivate: missingPrivate.slice(0, 20),
    missingPrivateCount: missingPrivate.length,
    // Kept for backward-compat consumers; superseded by the split above.
    missing: missingFiles.slice(0, 20),
  },
  quality: {
    voiceCoverage: entries.length ? Math.round((withVoice / entries.length) * 100) : 0,
    layoutCoverage: entries.length ? Math.round((withLayout / entries.length) * 100) : 0,
    // imageAvailability now means "path resolves to a real file" — the old
    // "path string present" behavior moves to imageReferenceRate for comparison.
    imageAvailability: entries.length ? Math.round((withImageResolvable / entries.length) * 100) : 0,
    imageReferenceRate: entries.length ? Math.round((withImagePath / entries.length) * 100) : 0,
    captureProvenance: entries.length ? Math.round((withCapture / entries.length) * 100) : 0,
    avgCritiqueLength,
  },
  provenance: { taggedBy: provenanceCounts, drafts: draftCount },
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
  console.log("  patternType — thin:", patternTypeGaps.belowThreshold.length ? patternTypeGaps.belowThreshold.map((g) => `${g.value} (${g.count})`).join(", ") : "(none)");
  console.log("  categories — zero:", categoryGaps.zero.length ? categoryGaps.zero.join(", ") : "(none — full coverage)");
  console.log("  styleTags — zero:", styleTagGaps.zero.length ? styleTagGaps.zero.join(", ") : "(none — full coverage)");
  hr();
  console.log(`\n🕰️  Staleness (cutoff: ${staleMonths}mo) — ${staleEntries.length} stale`);
  staleEntries.slice(0, 15).forEach((e) => console.log(`    ${e.id}  (${e.dateStr})`));
  hr();
  console.log(`\n🚩 Anti-pattern lint — ${antiPatternIssues.length} flagged`);
  antiPatternIssues.slice(0, 15).forEach((f) => { console.log(`  [${f.id}] "${f.text}"`); f.issues.forEach((i) => console.log(`      → ${i}`)); });
  hr();
  // Index coverage — drift detection (missing, stale, content-stale).
  console.log(`\n🔍 Index coverage`);
  if (report.indexCoverage.hasIndex) {
    const parts = [
      `indexed: ${report.indexCoverage.indexed}/${report.indexCoverage.total}`,
      `missing: ${report.indexCoverage.missing}`,
      `stale: ${report.indexCoverage.stale}`,
      `content-stale: ${report.indexCoverage.contentStale}`,
    ];
    console.log(`  ${parts.join("  ·  ")}`);
    if (report.indexCoverage.missing > 0 || report.indexCoverage.stale > 0 || report.indexCoverage.contentStale > 0) {
      console.log(`  ⚠ index is out of date — run \`npm run build-index\``);
    }
  } else {
    console.log("  no index — run `npm run build-index` to enable semantic vector search");
  }
  hr();
  // Image references — orphans + missing files, split by visibility tier.
  console.log(`\n🖼️  Image references`);
  console.log(`  referenced: ${report.imageReferences.referencedCount}  ·  orphans: ${report.imageReferences.orphanCount}  ·  missing: ${report.imageReferences.missingCount}`);
  if (report.imageReferences.orphanCount > 0) {
    console.log(`  orphan files (cleanup: \`npm run clean-orphans -- --dry-run\`):`);
    report.imageReferences.orphans.forEach((f) => console.log(`    ${f}`));
  }
  // Public missing = broken committed asset. Full list — these are real bugs.
  if (report.imageReferences.missingPublic.length > 0) {
    console.log(`\n  🚨 Broken public image references (CI-blocking):`);
    report.imageReferences.missingPublic.forEach((f) => console.log(`    ${f}`));
  }
  // Private missing = expected on fresh checkout (gitignored). Capped summary.
  if (report.imageReferences.missingPrivateCount > 0) {
    console.log(`\n  ⚠ Missing private images (expected on fresh checkout — ${report.imageReferences.missingPrivateCount} total, showing first ${report.imageReferences.missingPrivate.length}):`);
    report.imageReferences.missingPrivate.forEach((f) => console.log(`    ${f}`));
  }
  hr();
  // Quality metrics — coverage of optional-but-valuable fields.
  console.log(`\n📈 Quality coverage`);
  console.log(`  voice:   ${report.quality.voiceCoverage}% have voice.tone`);
  console.log(`  layout:  ${report.quality.layoutCoverage}% have layout.form`);
  console.log(`  images:  ${report.quality.imageAvailability}% resolvable · ${report.quality.imageReferenceRate}% reference a path`);
  console.log(`  capture: ${report.quality.captureProvenance}% from the capture pipeline`);
  console.log(`  critique: avg ${report.quality.avgCritiqueLength} chars`);
  if (report.provenance.drafts) console.log(`  drafts:  ${report.provenance.drafts} hidden from MCP search`);
  console.log(`\n  provenance (how the fields were produced):`);
  Object.entries(provenanceCounts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${k.padEnd(24)}${v}`));
  console.log(`\n  top products:`);
  Object.entries(productCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log(`    ${k.padEnd(24)}${v}`));
  hr();
}
