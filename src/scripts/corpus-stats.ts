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
import { PatternType, Category, StyleTag, Component, DomainTag } from "../schema.js";
import { lintAntiPattern } from "../content-lint.js";
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
const FULL_COMPONENTS = Component.options;
const FULL_DOMAIN_TAGS = DomainTag.options;

interface Entry {
  id: string;
  patternType?: string;
  categories?: string[];
  styleTags?: string[];
  qualityTier?: string;
  reviewStatus?: string;
  provenance?: { taggedBy?: string; reviewedBy?: string; capture?: { mode?: string; viewport?: string } };
  source?: { productName?: string; lastVerified?: string; capturedAt?: string };
  antiPatterns?: {
    antiPatterns?: string[];
    accessibilityRisks?: Array<{ wcag?: string[] }>;
    legacyAccessibilityNotes?: string[];
  };
  image?: { visibility?: string; path?: string | null; width?: number | null; height?: number | null };
  voice?: { tone?: string };
  layout?: { form?: string };
  businessRationale?: { businessGoal?: string; targetUser?: string; rationale?: string; confirmed?: boolean };
  critique?: string;
  components?: string[];
  domainTags?: string[];
  colorScheme?: string;
  mood?: string;
  industryVertical?: string;
  responsiveBehavior?: string;
  pinned?: boolean;
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
const componentCounts = countBy(entries, (e) => e.components ?? []);
const domainTagCounts = countBy(entries, (e) => e.domainTags ?? []);
const colorSchemeCounts = countBy(entries, (e) => e.colorScheme ? [e.colorScheme] : []);
const moodCounts = countBy(entries, (e) => e.mood ? [e.mood] : []);
const industryCounts = countBy(entries, (e) => e.industryVertical ? [e.industryVertical] : []);
const responsiveCounts = countBy(entries, (e) => e.responsiveBehavior ? [e.responsiveBehavior] : []);
const pinnedCount = entries.filter((e) => e.pinned === true).length;

const patternTypeGaps = computeGaps(patternTypeCounts, FULL_PATTERN_TYPES, minCount);
const categoryGaps = computeGaps(categoryCounts, FULL_CATEGORIES, minCount);
const styleTagGaps = computeGaps(styleTagCounts, FULL_STYLE_TAGS, minCount);
const componentGaps = computeGaps(componentCounts, FULL_COMPONENTS, minCount);
const domainTagGaps = computeGaps(domainTagCounts, FULL_DOMAIN_TAGS, minCount);

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

// ── accessibility risk distribution (active cited risks vs legacy backlog) ───
let activeRisks = 0;
let legacyBacklog = 0;
const wcagFrequency = new Map<string, number>();
for (const e of entries) {
  for (const _r of e.antiPatterns?.accessibilityRisks ?? []) {
    activeRisks++;
    for (const id of _r.wcag ?? []) wcagFrequency.set(id, (wcagFrequency.get(id) ?? 0) + 1);
  }
  legacyBacklog += e.antiPatterns?.legacyAccessibilityNotes?.length ?? 0;
}
const topWcag = [...wcagFrequency.entries()].sort((a, b) => b[1] - a[1]);

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
const withBusinessRationale = entries.filter((e) => e.businessRationale != null);
const confirmedBusinessRationale = withBusinessRationale.filter((e) => e.businessRationale?.confirmed === true);
const businessGoalCounts = countBy(withBusinessRationale, (e) => e.businessRationale?.businessGoal ? [e.businessRationale.businessGoal] : []);
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
const withComponents = entries.filter((e) => (e.components ?? []).length > 0).length;
const withDomainTags = entries.filter((e) => (e.domainTags ?? []).length > 0).length;
const withColorScheme = entries.filter((e) => !!e.colorScheme).length;
const withMood = entries.filter((e) => !!e.mood).length;
const withIndustry = entries.filter((e) => !!e.industryVertical).length;
const withResponsive = entries.filter((e) => !!e.responsiveBehavior).length;
const critiqueLengths = entries.map((e) => (e.critique ?? "").length).filter((n) => n > 0);
const avgCritiqueLength = critiqueLengths.length ? Math.round(critiqueLengths.reduce((a, b) => a + b, 0) / critiqueLengths.length) : 0;
const pct = (n: number) => entries.length ? Math.round((n / entries.length) * 100) : 0;

// ── provenance split (how much was auto-tagged vs human-authored vs reviewed) ─
const provenanceCounts = countBy(entries, (e) => {
  const t = e.provenance?.taggedBy;
  return t ? [t] : ["unknown"]; // pre-field entries have no provenance
});
const draftCount = entries.filter((e) => e.reviewStatus === "draft").length;

const report = {
  totalEntries: entries.length,
  distribution: { patternType: patternTypeCounts, categories: categoryCounts, styleTags: styleTagCounts, qualityTier: qualityTierCounts, product: productCounts, components: componentCounts, domainTags: domainTagCounts, colorScheme: colorSchemeCounts, mood: moodCounts, industryVertical: industryCounts, responsiveBehavior: responsiveCounts },
  coverageGaps: { patternType: patternTypeGaps, categories: categoryGaps, styleTags: styleTagGaps, components: componentGaps, domainTags: domainTagGaps },
  staleness: { cutoffMonths: staleMonths, staleCount: staleEntries.length, staleEntries },
  antiPatternQuality: { flaggedCount: antiPatternIssues.length, flagged: antiPatternIssues },
  accessibilityRisks: { activeCited: activeRisks, legacyBacklog, topCriteria: topWcag },
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
  businessRationale: {
    totalEntries: entries.length,
    withField: withBusinessRationale.length,
    coveragePct: entries.length ? +((withBusinessRationale.length / entries.length) * 100).toFixed(1) : 0,
    confirmedPct: withBusinessRationale.length ? +((confirmedBusinessRationale.length / withBusinessRationale.length) * 100).toFixed(1) : 0,
    goalDistribution: businessGoalCounts,
  },
  quality: {
    voiceCoverage: pct(withVoice),
    layoutCoverage: pct(withLayout),
    // imageAvailability now means "path resolves to a real file" — the old
    // "path string present" behavior moves to imageReferenceRate for comparison.
    imageAvailability: pct(withImageResolvable),
    imageReferenceRate: pct(withImagePath),
    captureProvenance: pct(withCapture),
    avgCritiqueLength,
    componentCoverage: pct(withComponents),
    domainTagCoverage: pct(withDomainTags),
    colorSchemeCoverage: pct(withColorScheme),
    moodCoverage: pct(withMood),
    industryVerticalCoverage: pct(withIndustry),
    responsiveBehaviorCoverage: pct(withResponsive),
  },
  provenance: { taggedBy: provenanceCounts, drafts: draftCount, pinned: pinnedCount },
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
  console.log("\n📊 components (top 15)"); Object.entries(componentCounts).sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log(`  ${k.padEnd(24)}${v}`));
  console.log("\n📊 domainTags"); ct(domainTagCounts);
  console.log("\n📊 colorScheme"); ct(colorSchemeCounts);
  console.log("\n📊 mood (top 10)"); Object.entries(moodCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log(`  ${k.padEnd(24)}${v}`));
  console.log("\n📊 industryVertical (top 10)"); Object.entries(industryCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log(`  ${k.padEnd(24)}${v}`));
  console.log("\n📊 responsiveBehavior"); ct(responsiveCounts);
  hr();
  console.log("\n🕳️  Coverage gaps (against full schema enum)");
  console.log("  patternType — zero:", patternTypeGaps.zero.length ? patternTypeGaps.zero.join(", ") : "(none — full coverage)");
  console.log("  patternType — thin:", patternTypeGaps.belowThreshold.length ? patternTypeGaps.belowThreshold.map((g) => `${g.value} (${g.count})`).join(", ") : "(none)");
  console.log("  categories — zero:", categoryGaps.zero.length ? categoryGaps.zero.join(", ") : "(none — full coverage)");
  console.log("  styleTags — zero:", styleTagGaps.zero.length ? styleTagGaps.zero.join(", ") : "(none — full coverage)");
  console.log("  components — zero:", componentGaps.zero.length ? componentGaps.zero.join(", ") : "(none — full coverage)");
  console.log("  domainTags — zero:", domainTagGaps.zero.length ? domainTagGaps.zero.join(", ") : "(none — full coverage)");
  hr();
  console.log(`\n🕰️  Staleness (cutoff: ${staleMonths}mo) — ${staleEntries.length} stale`);
  staleEntries.slice(0, 15).forEach((e) => console.log(`    ${e.id}  (${e.dateStr})`));
  hr();
  console.log(`\n🚩 Anti-pattern lint — ${antiPatternIssues.length} flagged`);
  antiPatternIssues.slice(0, 15).forEach((f) => { console.log(`  [${f.id}] "${f.text}"`); f.issues.forEach((i) => console.log(`      → ${i}`)); });
  hr();

  // Accessibility risk distribution — active cited risks vs legacy backlog.
  console.log(`\n♿ Accessibility risks — ${activeRisks} active (cited), ${legacyBacklog} legacy (review backlog)`);
  if (topWcag.length) {
    console.log("  Top WCAG criteria:");
    topWcag.slice(0, 8).forEach(([id, n]) => console.log(`    ${id}: ${n}`));
  }
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
  console.log(`  business rationale: ${report.businessRationale.coveragePct}% have field · ${report.businessRationale.confirmedPct}% confirmed`);
  if (Object.keys(report.businessRationale.goalDistribution).length) {
    console.log(`  business goals:`);
    Object.entries(report.businessRationale.goalDistribution).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${k.padEnd(44)}${v}`));
  }
  console.log(`  images:  ${report.quality.imageAvailability}% resolvable · ${report.quality.imageReferenceRate}% reference a path`);
  console.log(`  capture: ${report.quality.captureProvenance}% from the capture pipeline`);
  console.log(`  critique: avg ${report.quality.avgCritiqueLength} chars`);
  console.log(`  components:     ${report.quality.componentCoverage}% have component tags`);
  console.log(`  domainTags:     ${report.quality.domainTagCoverage}% have domain tags`);
  console.log(`  colorScheme:    ${report.quality.colorSchemeCoverage}% have color scheme`);
  console.log(`  mood:           ${report.quality.moodCoverage}% have mood`);
  console.log(`  industry:       ${report.quality.industryVerticalCoverage}% have industry vertical`);
  console.log(`  responsive:     ${report.quality.responsiveBehaviorCoverage}% have responsive behavior`);
  if (report.provenance.drafts) console.log(`  drafts:  ${report.provenance.drafts} hidden from MCP search`);
  console.log(`\n  provenance (how the fields were produced):`);
  Object.entries(provenanceCounts).sort((a, b) => b[1] - a[1]).forEach(([k, v]) => console.log(`    ${k.padEnd(24)}${v}`));
  if (pinnedCount > 0) console.log(`    ${"pinned (protected)".padEnd(24)}${pinnedCount}`);
  console.log(`\n  top products:`);
  Object.entries(productCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).forEach(([k, v]) => console.log(`    ${k.padEnd(24)}${v}`));
  hr();
}
