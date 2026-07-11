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
 * Determinism: every run pins explicit {provider, baseUrl, apiKey, model}
 * overrides resolved from env at startup. This bypasses peak-hour routing
 * (DeepSeek→MiniMax auto-swap) so --diff comparisons are stable across
 * wall-clock time. Production tagging keeps peak-hour routing unchanged.
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
import { hasVisionKey, hasCritiqueKey, activeModelName, activeProviderName } from "../dist/tagger.js";
import { EVAL_SET } from "./eval-set.mjs";
import { summarizeScores } from "./eval-scorer.mjs";
import { runEvalCase, buildEnvOverride } from "./eval-runner.mjs";

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

// ─── pinned endpoint configs (bypass peak-hour routing for determinism) ──────
// Resolve once at startup from env. These overrides reach openaiConfigForPass,
// so the exact {provider, baseUrl, apiKey, model} is pinned for the entire run.
// The same overrides are what the matrix runner (eval-matrix.mjs) loops over.
const extractionOverride = buildEnvOverride("extraction");
const critiqueOverride = buildEnvOverride("critique");

let gitCommit = "unknown";
try { gitCommit = execSync("git rev-parse --short HEAD", { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim(); } catch {}

const pinnedExtractionModel = extractionOverride?.model ?? activeModelName("extraction");
const pinnedCritiqueModel = critiqueOverride?.model ?? activeModelName("critique");

console.log(`\n🔬 Tagger eval baseline (deterministic — peak-hour routing bypassed)`);
console.log(`   Images: ${images.length}  |  Extraction: ${activeProviderName("extraction")} / ${pinnedExtractionModel}`);
if (runCritique) console.log(`   Critique: ${activeProviderName("critique")} / ${pinnedCritiqueModel}`);
console.log(`   Git: ${gitCommit}\n`);

// ─── extraction pass ──────────────────────────────────────────────────────────
const results = [];

for (const img of images) {
  const fullPath = resolve(PROJECT_ROOT, "corpus", img.imagePath);
  if (!existsSync(fullPath)) {
    console.error(`  ⚠  Image not found, skipping: ${img.imagePath}`);
    continue;
  }

  process.stdout.write(`  ${img.id.padEnd(35)} `);
  const r = await runEvalCase({
    imagePath: img.imagePath,
    productName: img.productName,
    platform: img.platform,
    goldPatternType: img.patternType,
    runCritique,
    projectRoot: PROJECT_ROOT,
    imageId: img.id,
    extractionOverride,
    critiqueOverride,
  });
  r.imageId = img.id;

  if (r.error) {
    console.error(`\n    extraction error: ${r.error}`);
    // Short-circuit on auth/quota failure — no point retrying 14 more times.
    if (/40[13]|insufficient.?quota|invalid.?api.?key/i.test(r.error)) {
      console.error("\n❌ Authentication or quota error — aborting. Check your API key and quota.");
      process.exit(1);
    }
  } else {
    const exScore = r.extraction;
    const status = exScore.patternTypeCorrect ? "✓" : `✗ (got "${exScore.patternTypeRaw}")`;
    const hallucStr = exScore.iconOnlyRaw + exScore.pixelRaw + exScore.bannedPhrasesRaw > 0
      ? ` halluc:${exScore.iconOnlyRaw}i/${exScore.pixelRaw}px/${exScore.bannedPhrasesRaw}b`
      : "";
    const critStr = r.critique && !r.critique.error ? ` crit:${r.critique.critiqueWords}w/${r.critique.bannedPhrasesRaw}b` : "";
    console.log(`${status} ${r.extractionLatencyMs}ms${hallucStr}${critStr}`);
  }
  results.push(r);
}

// ─── summarize ────────────────────────────────────────────────────────────────
const validExtractions = results.filter((r) => r.extraction);
// Filter out critique errors — a critique that errored is stored as { error: "..." },
// not a score object. Including it would drag avgBannedPhrasesRaw / avgCritiqueWords
// toward zero (summarizeScores reads missing fields as 0), turning API failures
// into misleadingly good-looking metrics instead of explicit failures.
const validCritiques = results.filter((r) => r.critique && !r.critique.error);
const summary = {
  ...summarizeScores(validExtractions.map((r) => r.extraction), validCritiques.map((r) => r.critique)),
  avgExtractionLatencyMs: validExtractions.reduce((s, r) => s + r.extractionLatencyMs, 0) / (validExtractions.length || 1),
  errorCount: results.filter((r) => r.error).length,
  critiqueErrorCount: results.filter((r) => r.critique?.error).length,
};

const baseline = {
  timestamp: new Date().toISOString(),
  gitCommit,
  extractionProvider: activeProviderName("extraction"),
  extractionModel: pinnedExtractionModel,
  critiqueProvider: runCritique ? activeProviderName("critique") : null,
  critiqueModel: runCritique ? pinnedCritiqueModel : null,
  extractionBaseUrl: extractionOverride?.baseUrl ?? "",
  critiqueBaseUrl: critiqueOverride?.baseUrl ?? "",
  modelPinned: true, // baseline always pins from env at startup (deterministic)
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
if (summary.errorCount) console.log(`  extraction errors:     ${summary.errorCount}`);
if (summary.critiqueErrorCount) console.log(`  critique errors:       ${summary.critiqueErrorCount}`);

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
