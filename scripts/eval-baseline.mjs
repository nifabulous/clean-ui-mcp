#!/usr/bin/env node
/**
 * eval-baseline.mjs
 * ──────────────────
 * Tagger evaluation baseline runner.
 *
 * Runs the tagger against a fixed 15-image stratified set, scores RAW
 * pre-sanitize output (not the tautological sanitized result), and records
 * a baseline. Re-running with --diff compares against the saved baseline.
 *
 * Two modes:
 *   npm run eval-baseline                      # extraction + critique, write baseline
 *   npm run eval-baseline -- --diff eval/baseline.json   # re-run, compare
 *   npm run eval-baseline -- --extraction-only # skip critique (faster, no critique key needed)
 *   npm run eval-baseline -- --images 5        # limit to first N images
 *
 * Requires a vision provider key (OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY).
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

import "../dist/env.js";
import { tagImage, generateCritique, hasVisionKey, hasCritiqueKey, activeModelName, activeProviderName } from "../dist/tagger.js";
import { EVAL_SET } from "./eval-set.mjs";
import { scoreExtraction, scoreCritique, summarizeScores } from "./eval-scorer.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const EVAL_DIR = resolve(PROJECT_ROOT, "eval");
const DEFAULT_BASELINE = resolve(EVAL_DIR, "baseline.json");

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const wantDiff = args.includes("--diff");
// Bare --diff (no path following) defaults to the standard baseline location.
// Without this, `npm run eval-baseline -- --diff` silently overwrites the baseline.
const diffIdx = args.indexOf("--diff");
const diffPathArg = diffIdx >= 0 ? args[diffIdx + 1] : undefined;
const diffPath = wantDiff
  ? resolve(diffPathArg && !diffPathArg.startsWith("--") ? diffPathArg : DEFAULT_BASELINE)
  : null;
const extractionOnly = args.includes("--extraction-only");
const maxImages = parseInt(args.find((_, i, a) => a[i - 1] === "--images") ?? "99", 10);
const images = EVAL_SET.slice(0, maxImages);

// ─── preconditions ────────────────────────────────────────────────────────────
if (!hasVisionKey()) {
  console.error("❌ No vision provider key set. Need OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY.");
  process.exit(1);
}
if (!extractionOnly && !hasCritiqueKey()) {
  console.error("⚠  No critique key set — falling back to extraction-only mode.");
}
const runCritique = !extractionOnly && hasCritiqueKey();

let gitCommit = "unknown";
try { gitCommit = execSync("git rev-parse --short HEAD", { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim(); } catch {}

console.log(`\n🔬 Tagger eval baseline`);
console.log(`   Images: ${images.length}  |  Extraction: ${activeProviderName("extraction")} / ${activeModelName("extraction")}`);
if (runCritique) console.log(`   Critique: ${activeProviderName("critique")} / ${activeModelName("critique")}`);
console.log(`   Git: ${gitCommit}\n`);

// ─── extraction pass ──────────────────────────────────────────────────────────
const results = [];
const extractionProvider = undefined; // use the configured default

for (const img of images) {
  const fullPath = resolve(PROJECT_ROOT, "corpus", img.imagePath);
  if (!existsSync(fullPath)) {
    console.error(`  ⚠  Image not found, skipping: ${img.imagePath}`);
    continue;
  }

  process.stdout.write(`  ${img.id.padEnd(35)} `);
  const t0 = Date.now();
  try {
    const entry = await tagImage({
      imagePath: fullPath,
      productName: img.productName,
      url: null,
      imageDetail: "low",
      extractionOnly: true,
      extractionProvider,
    });
    const latencyMs = Date.now() - t0;
    const rawExtraction = entry._raw?.extraction ?? {};
    const exScore = scoreExtraction(rawExtraction, img.patternType);

    let critScore = null;
    let critLatencyMs = null;
    if (runCritique) {
      const tc0 = Date.now();
      try {
        const critique = await generateCritique(img.productName, rawExtraction, undefined, undefined, img.platform);
        critLatencyMs = Date.now() - tc0;
        const rawCritique = critique._raw?.critique ?? {};
        critScore = scoreCritique(rawCritique);
      } catch (e) {
        critLatencyMs = Date.now() - tc0;
        console.error(`\n    critique error: ${e.message}`);
      }
    }

    results.push({
      imageId: img.id,
      goldPatternType: img.patternType,
      platform: img.platform,
      extractionModel: entry._raw?.extractionModel ?? activeModelName("extraction"),
      extractionLatencyMs: latencyMs,
      extraction: exScore,
      critique: critScore,
      critiqueLatencyMs: critLatencyMs,
    });

    const status = exScore.patternTypeCorrect ? "✓" : `✗ (got "${exScore.patternTypeRaw}")`;
    const hallucStr = exScore.iconOnlyRaw + exScore.pixelRaw + exScore.bannedPhrasesRaw > 0
      ? ` halluc:${exScore.iconOnlyRaw}i/${exScore.pixelRaw}px/${exScore.bannedPhrasesRaw}b`
      : "";
    const critStr = critScore ? ` crit:${critScore.critiqueWords}w/${critScore.bannedPhrasesRaw}b` : "";
    console.log(`${status} ${latencyMs}ms${hallucStr}${critStr}`);
  } catch (e) {
    const latencyMs = Date.now() - t0;
    console.error(`\n    extraction error: ${e.message}`);
    results.push({ imageId: img.id, goldPatternType: img.patternType, platform: img.platform, error: e.message, extractionLatencyMs: latencyMs });
    // Short-circuit on auth/quota failure — no point retrying 14 more times.
    if (/40[13]|insufficient.?quota|invalid.?api.?key/i.test(e.message)) {
      console.error("\n❌ Authentication or quota error — aborting. Check your API key and quota.");
      process.exit(1);
    }
  }
}

// ─── summarize ────────────────────────────────────────────────────────────────
const validExtractions = results.filter((r) => r.extraction);
const validCritiques = results.filter((r) => r.critique);
const summary = {
  ...summarizeScores(validExtractions.map((r) => r.extraction), validCritiques.map((r) => r.critique)),
  avgExtractionLatencyMs: validExtractions.reduce((s, r) => s + r.extractionLatencyMs, 0) / (validExtractions.length || 1),
  errorCount: results.filter((r) => r.error).length,
};

const baseline = {
  timestamp: new Date().toISOString(),
  gitCommit,
  extractionProvider: activeProviderName("extraction"),
  extractionModel: activeModelName("extraction"),
  critiqueProvider: runCritique ? activeProviderName("critique") : null,
  critiqueModel: runCritique ? activeModelName("critique") : null,
  imageCount: images.length,
  summary,
  results,
};

// ─── diff or write ────────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(60)}`);
console.log(`SUMMARY (${validExtractions.length}/${images.length} succeeded)`);
console.log(`  patternType accuracy:  ${(summary.patternTypeAccuracy * 100).toFixed(1)}%`);
console.log(`  avg icon-only (raw):   ${summary.avgIconOnlyRaw.toFixed(1)}`);
console.log(`  avg banned (raw):      ${summary.avgBannedPhrasesRaw.toFixed(1)}`);
console.log(`  avg critique words:    ${summary.avgCritiqueWords.toFixed(0)}`);
console.log(`  avg extraction latency:${summary.avgExtractionLatencyMs.toFixed(0)}ms`);
if (summary.errorCount) console.log(`  errors:                ${summary.errorCount}`);

if (diffPath && !existsSync(diffPath)) {
  console.error(`\n⚠  Baseline file not found at ${diffPath}`);
  console.error(`   Writing a new baseline instead. Next time, diff against: ${DEFAULT_BASELINE}`);
}
if (diffPath && existsSync(diffPath)) {
  const prev = JSON.parse(readFileSync(diffPath, "utf-8"));
  console.log(`\n${"=".repeat(60)}`);
  console.log(`DIFF vs ${diffPath} (git ${prev.gitCommit})`);
  const metrics = [
    ["patternTypeAccuracy", "%", (v) => (v * 100).toFixed(1)],
    ["avgIconOnlyRaw", "", (v) => v.toFixed(1)],
    ["avgBannedPhrasesRaw", "", (v) => v.toFixed(1)],
    ["avgCritiqueWords", "", (v) => v.toFixed(0)],
    ["avgExtractionLatencyMs", "ms", (v) => v.toFixed(0)],
  ];
  let regressions = 0;
  for (const [key, unit, fmt] of metrics) {
    const oldVal = prev.summary?.[key];
    const newVal = summary[key];
    if (oldVal === undefined || newVal === undefined) continue;
    const delta = newVal - oldVal;
    const arrow = delta > 0 ? "↑" : delta < 0 ? "↓" : "=";
    // For accuracy and critiqueWords: higher is better. For hallucination counts + latency: lower is better.
    const isRegression = (key === "patternTypeAccuracy" || key === "avgCritiqueWords") ? delta < 0 : delta > 0;
    if (isRegression) regressions++;
    const flag = isRegression ? " ⚠ REGRESSION" : "";
    console.log(`  ${key.padEnd(25)} ${fmt(oldVal)}${unit} → ${fmt(newVal)}${unit} (${arrow} ${Math.abs(delta).toFixed(key.includes("Latency") ? 0 : 1)})${flag}`);
  }
  console.log(`\n  ${regressions} regression(s) detected.`);
} else {
  mkdirSync(EVAL_DIR, { recursive: true });
  writeFileSync(DEFAULT_BASELINE, JSON.stringify(baseline, null, 2) + "\n");
  console.log(`\n✓ Baseline written to ${DEFAULT_BASELINE}`);
  console.log(`  Re-run with: npm run eval-baseline -- --diff`);
}
