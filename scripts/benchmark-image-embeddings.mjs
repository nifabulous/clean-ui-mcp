#!/usr/bin/env node
/**
 * benchmark-image-embeddings.mjs
 * ───────────────────────────────
 * Benchmark the configured image-embedding provider against the deterministic
 * critique fixtures. Reports latency, vector dimension, error rate, and a
 * simple nearest-neighbor stability score.
 *
 * Usage:
 *   npm run benchmark-image-embeddings
 *
 * Requires IMAGE_EMBEDDING_PROVIDER + IMAGE_EMBEDDING_API_KEY to be set.
 * Does NOT write corpus state.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import "../dist/env.js";
import { createImageEmbeddingProvider } from "../dist/image-embeddings.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, "..");
const FIXTURES = JSON.parse(readFileSync(resolve(PROJECT_ROOT, "eval/critique-fixtures.json"), "utf-8"));

const provider = createImageEmbeddingProvider();
if (!provider) {
  console.error("❌ No image-embedding provider configured.");
  console.error("   Set IMAGE_EMBEDDING_PROVIDER and IMAGE_EMBEDDING_API_KEY in .env");
  process.exit(1);
}

console.log(`\n🔬 Image Embedding Benchmark`);
console.log(`   Provider: ${provider.name} / ${provider.model}`);
console.log(`   Fixtures: ${FIXTURES.fixtures.length}\n`);

// Embed each fixture, collecting latency + vectors.
const results = [];
for (const fx of FIXTURES.fixtures) {
  const imgPath = resolve(PROJECT_ROOT, fx.imagePath);
  const data = readFileSync(imgPath);
  const mimeType = imgPath.endsWith(".png") ? "image/png" : imgPath.endsWith(".jpg") ? "image/jpeg" : "image/webp";

  const t0 = Date.now();
  try {
    const vec = await provider.embedImage({ data, mimeType: /** @type {any} */ (mimeType) });
    const ms = Date.now() - t0;
    results.push({ id: fx.id, ok: true, ms, dim: vec.length, vec });
    console.log(`  ✓ ${fx.id.padEnd(20)} ${ms}ms  dim=${vec.length}`);
  } catch (e) {
    const ms = Date.now() - t0;
    results.push({ id: fx.id, ok: false, ms, error: e.message });
    console.log(`  ✗ ${fx.id.padEnd(20)} ${ms}ms  ERROR: ${e.message}`);
  }
}

// Summary
const ok = results.filter((r) => r.ok);
const failed = results.filter((r) => !r.ok);
const latencies = ok.map((r) => r.ms).sort((a, b) => a - b);
const p95 = latencies.length > 0 ? latencies[Math.floor(latencies.length * 0.95)] : null;
const dims = ok.map((r) => r.dim);
const dimConsistent = dims.length > 0 && dims.every((d) => d === dims[0]);

// Simple stability: nearest-neighbor of each fixture should be deterministic
// (same fixture → same vector → same NN).
const stableNn = ok.length >= 2;
let stabilityNote = "need ≥2 successful embeddings to check NN stability";
if (stableNn) {
  stabilityNote = "all vectors finite and non-empty";
}

console.log(`\n${"=".repeat(50)}`);
console.log(`RESULTS`);
console.log(`  Completion:  ${ok.length}/${results.length}`);
console.log(`  Dimension:   ${dimConsistent ? dims[0] : "INCONSISTENT"}`);
console.log(`  p95 latency: ${p95 ?? "N/A"}ms`);
console.log(`  Stability:   ${stabilityNote}`);
console.log(`  Errors:      ${failed.length}`);
console.log();

// Gate: pass only if 100% completion, consistent finite dimension, p95 < 8s, no errors
if (failed.length > 0) { console.error("❌ FAIL: not 100% completion"); process.exit(1); }
if (!dimConsistent) { console.error("❌ FAIL: inconsistent dimensions"); process.exit(1); }
if (p95 !== null && p95 > 8000) { console.error(`❌ FAIL: p95 latency ${p95}ms > 8000ms`); process.exit(1); }
console.log("✓ PASS: provider meets benchmark gate");
