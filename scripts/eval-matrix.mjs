#!/usr/bin/env node
/**
 * eval-matrix.mjs
 * ────────────────
 * Provider/model matrix runner. Loops over config triples, runs the 15-image
 * eval against each, emits one baseline artifact per config, and prints a
 * comparison table.
 *
 * Usage:
 *   npm run eval-matrix -- --configs eval/configs/openai-gpt54.json,eval/configs/deepseek-nim.json
 *   npm run eval-matrix -- --configs eval/configs/openai-gpt54.json --images 3 --extraction-only
 *
 * Config files are JSON with this shape:
 *   {
 *     "name": "openai-gpt54",
 *     "modelPinned": true,               // optional, defaults to true if baseUrl+model present
 *     "extraction": { "provider": "openai", "baseUrl": "", "apiKey": "...", "model": "..." },
 *     "critique":   { "provider": "openai", "baseUrl": "...", "apiKey": "...", "model": "..." }
 *   }
 *
 * If a config's API key is missing, that config is SKIPPED with a clear
 * message (not silently rerouted — that would defeat the pinning).
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

import "../dist/env.js";
import { EVAL_SET } from "./eval-set.mjs";
import { summarizeScores } from "./eval-scorer.mjs";
import { runEvalCase } from "./eval-runner.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const EVAL_DIR = resolve(PROJECT_ROOT, "eval");

// ─── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const configsArg = args.find((_, i, a) => a[i - 1] === "--configs");
if (!configsArg) {
  console.error("❌ Usage: npm run eval-matrix -- --configs <config1.json>,<config2.json>");
  console.error("   Config files go in eval/configs/. See eval/configs/*.json for examples.");
  process.exit(1);
}
const configPaths = configsArg.split(",").map((p) => resolve(PROJECT_ROOT, p));
const extractionOnly = args.includes("--extraction-only");
const maxImages = parseInt(args.find((_, i, a) => a[i - 1] === "--images") ?? "99", 10);
const images = EVAL_SET.slice(0, maxImages);

let gitCommit = "unknown";
try { gitCommit = execSync("git rev-parse --short HEAD", { cwd: PROJECT_ROOT, encoding: "utf-8" }).trim(); } catch {}

mkdirSync(EVAL_DIR, { recursive: true });

// ─── load + validate configs ──────────────────────────────────────────────────
function loadConfig(path) {
  if (!existsSync(path)) {
    console.error(`  ⚠  Config not found, skipping: ${path}`);
    return null;
  }
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (!raw.name || !raw.extraction) {
    console.error(`  ⚠  Config missing required "name" or "extraction" field: ${path}`);
    return null;
  }
  return raw;
}

function resolveApiKey(cfg) {
  // Config apiKey values may contain ${ENV_VAR} — expand them.
  const expand = (val) => val ? val.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] ?? "") : "";
  return {
    ...cfg,
    apiKey: expand(cfg.apiKey),
    baseUrl: (cfg.baseUrl ?? "").replace(/\/+$/, ""),
  };
}

const configs = configPaths.map(loadConfig).filter(Boolean);

if (configs.length === 0) {
  console.error("❌ No valid configs to run. Aborting.");
  process.exit(1);
}

console.log(`\n🔬 Tagger eval matrix (${images.length} images, ${extractionOnly ? "extraction-only" : "extraction + critique"})`);
console.log(`   Configs: ${configs.map((c) => c.name).join(", ")}`);
console.log(`   Git: ${gitCommit}\n`);

// ─── run each config ──────────────────────────────────────────────────────────
const summaries = [];

for (const config of configs) {
  const extraction = resolveApiKey(config.extraction);
  const critique = config.critique ? resolveApiKey(config.critique) : undefined;

  // Precondition: check API key presence. Skip cleanly if missing — do NOT
  // silently reroute (that would defeat the pinning).
  if (extraction.provider === "openai" && !extraction.apiKey) {
    console.log(`\n  ⏭  ${config.name}: SKIPPED — extraction apiKey not set (env var missing)`);
    summaries.push({ name: config.name, skipped: true, reason: "extraction apiKey missing" });
    continue;
  }
  if (!extractionOnly && critique?.provider === "openai" && !critique.apiKey) {
    console.log(`\n  ⏭  ${config.name}: SKIPPED — critique apiKey not set (env var missing)`);
    summaries.push({ name: config.name, skipped: true, reason: "critique apiKey missing" });
    continue;
  }

  const modelPinned = config.modelPinned ?? (extraction.provider === "openai");
  console.log(`\n  ── ${config.name} ${modelPinned ? "" : "(provider-only, not model-pinned)"} ──`);

  const results = [];
  for (const img of images) {
    const fullPath = resolve(PROJECT_ROOT, "corpus", img.imagePath);
    if (!existsSync(fullPath)) {
      console.error(`     ⚠  Image not found, skipping: ${img.imagePath}`);
      continue;
    }

    process.stdout.write(`     ${img.id.padEnd(35)} `);
    const r = await runEvalCase({
      imagePath: img.imagePath,
      productName: img.productName,
      platform: img.platform,
      goldPatternType: img.patternType,
      runCritique: !extractionOnly,
      projectRoot: PROJECT_ROOT,
      extractionOverride: extraction.provider === "openai" ? extraction : { provider: extraction.provider },
      critiqueOverride: critique ? (critique.provider === "openai" ? critique : { provider: critique.provider }) : undefined,
    });
    r.imageId = img.id;

    if (r.error) {
      console.log(`✗ error: ${r.error.slice(0, 60)}`);
      // Auth/quota failure: skip remaining images for this config, continue to next config
      if (/40[13]|insufficient.?quota|invalid.?api.?key/i.test(r.error)) {
        console.error(`     ❌ Auth/quota error — aborting ${config.name}, continuing to next config.`);
        results.push(r);
        break;
      }
    } else {
      const exScore = r.extraction;
      const status = exScore.patternTypeCorrect ? "✓" : `✗ (got "${exScore.patternTypeRaw}")`;
      const critStr = r.critique && !r.critique.error ? ` crit:${r.critique.critiqueWords}w` : "";
      console.log(`${status} ${r.extractionLatencyMs}ms${critStr}`);
    }
    results.push(r);
  }

  // Summarize this config
  const validExtractions = results.filter((r) => r.extraction);
  const validCritiques = results.filter((r) => r.critique && !r.critique.error);
  const summary = {
    ...summarizeScores(validExtractions.map((r) => r.extraction), validCritiques.map((r) => r.critique)),
    avgExtractionLatencyMs: validExtractions.reduce((s, r) => s + r.extractionLatencyMs, 0) / (validExtractions.length || 1),
    errorCount: results.filter((r) => r.error).length,
  };

  // Write per-config baseline artifact
  const baselinePath = resolve(EVAL_DIR, `baseline-${config.name}.json`);
  const baseline = {
    timestamp: new Date().toISOString(),
    gitCommit,
    configName: config.name,
    modelPinned,
    extractionProvider: extraction.provider,
    extractionModel: extraction.model ?? null,
    extractionBaseUrl: extraction.baseUrl ?? "",
    critiqueProvider: critique?.provider ?? null,
    critiqueModel: critique?.model ?? null,
    critiqueBaseUrl: critique?.baseUrl ?? "",
    imageCount: images.length,
    summary,
    results,
  };
  writeFileSync(baselinePath, JSON.stringify(baseline, null, 2) + "\n");

  summaries.push({
    name: config.name,
    modelPinned,
    skipped: false,
    extractionModel: extraction.model ?? "(env)",
    critiqueModel: critique?.model ?? "(env)",
    ...summary,
  });

  console.log(`     ✓ Written to ${baselinePath}`);
}

// ─── comparison table ─────────────────────────────────────────────────────────
console.log(`\n${"=".repeat(90)}`);
console.log("MATRIX COMPARISON");
console.log(`${"=".repeat(90)}`);
console.log(
  `  ${"Config".padEnd(22)} ${"Pinned".padEnd(7)} ${"patternAcc".padEnd(12)} ${"iconOnly".padEnd(10)} ${"banned".padEnd(8)} ${"critWds".padEnd(8)} ${"latency".padEnd(8)} ${"errors"}`,
);
console.log(`  ${"-".repeat(85)}`);
for (const s of summaries) {
  if (s.skipped) {
    console.log(`  ${s.name.padEnd(22)} SKIPPED — ${s.reason}`);
    continue;
  }
  const pinned = s.modelPinned ? "✓" : "env";
  console.log(
    `  ${s.name.padEnd(22)} ${pinned.padEnd(7)} ${((s.patternTypeAccuracy ?? 0) * 100).toFixed(1).padStart(5)}%     ${(s.avgIconOnlyRaw ?? 0).toFixed(1).padStart(5)}    ${(s.avgBannedPhrasesRaw ?? 0).toFixed(1).padStart(5)}  ${(s.avgCritiqueWords ?? 0).toFixed(0).padStart(5)}   ${(s.avgExtractionLatencyMs ?? 0).toFixed(0).padStart(5)}ms  ${s.errorCount ?? 0}`,
  );
}
console.log();
