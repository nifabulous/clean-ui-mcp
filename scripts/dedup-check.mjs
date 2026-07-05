#!/usr/bin/env node
/**
 * dedup-check.mjs — count how many images in a folder are genuinely NEW
 * vs already in the corpus. Uses the SAME logic as the project's own dedup
 * gate (SHA-256 exact + dHash near-duplicate, threshold 8). READ-ONLY: no
 * API calls, no corpus mutation, no network.
 *
 * Usage:
 *   node scripts/dedup-check.mjs --folder <extracted-images-root>
 *
 * Reports, per top-level subfolder (product) and overall:
 *   - exact dupes   (SHA-256 match — same file already in corpus)
 *   - near dupes    (dHash hamming < 8 — same page, recompressed/recropped)
 *   - NEW           (neither — genuinely needs tagging)
 *
 * Near-dupe matching is O(n*m) over dHashes. For 1086 candidates × ~480 corpus
 * that's ~520k hamming comparisons — a few seconds. Fine for a one-off.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import sharp from "sharp";

const DHASH_THRESHOLD = 8; // mirror src/scripts/ui-server.ts:68

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    folder: { type: "string" },
    corpus: { type: "string", default: "corpus/entries.json" },
    imagedir: { type: "string", default: "corpus/images-private" },
  },
});

if (!args.folder) {
  console.error("Usage: node scripts/dedup-check.mjs --folder <extracted-root>");
  process.exit(1);
}

const ROOT = resolve(args.folder);
const CORPUS_PATH = resolve(args.corpus);
const IMAGE_DIR = resolve(args.imagedir);

// ─── dHash (mirrors ui-server.ts:34) ─────────────────────────────────────────
async function computeDHash(imagePath) {
  const data = await sharp(imagePath).greyscale().resize(9, 8, { fit: "fill" }).raw().toBuffer();
  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col];
      const right = data[row * 9 + col + 1];
      hash = (hash << 1n) | (BigInt(left > right ? 1 : 0));
    }
  }
  return hash.toString(16).padStart(16, "0");
}
function hammingDistance(a, b) {
  let xor = BigInt("0x" + a) ^ BigInt("0x" + b);
  let count = 0;
  while (xor) { count += Number(xor & 1n); xor >>= 1n; }
  return count;
}
function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

// ─── load corpus fingerprints ────────────────────────────────────────────────
console.log(`Loading corpus fingerprints from ${CORPUS_PATH} ...`);
const corpusRaw = JSON.parse(readFileSync(CORPUS_PATH, "utf-8"));
const corpusEntries = Array.isArray(corpusRaw) ? corpusRaw : (corpusRaw.entries ?? []);
console.log(`  ${corpusEntries.length} corpus entries.`);

const corpusFingerprints = [];
for (const entry of corpusEntries) {
  const relPath = entry.image?.path;
  if (!relPath) continue;
  const absPath = resolve(IMAGE_DIR, relPath.replace(/^images-private\//, ""));
  try {
    const hash = sha256(absPath);
    let dhash = null;
    try { dhash = await computeDHash(absPath); } catch { /* sharp fail → exact-only */ }
    corpusFingerprints.push({ id: entry.id, product: entry.source?.productName, hash, dhash });
  } catch {
    // image file missing on disk — skip (can't compare)
  }
}
console.log(`  ${corpusFingerprints.length} corpus images hashed.\n`);

// ─── scan candidate folder ───────────────────────────────────────────────────
function listImages(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...listImages(p));
    else if (/\.(png|jpe?g)$/i.test(name)) out.push(p);
  }
  return out;
}

// Group candidates by their top-level subfolder under ROOT (the per-product
// extraction folders), so the report breaks down overlap by product.
function topFolder(path) {
  const rel = path.slice(ROOT.length + 1);
  return rel.split("/")[0] ?? "(root)";
}

const candidates = listImages(ROOT);
console.log(`Scanning ${candidates.length} candidate images in ${ROOT} ...\n`);

const perFolder = {};
let totalNew = 0, totalExact = 0, totalNear = 0, totalError = 0;

for (let i = 0; i < candidates.length; i++) {
  const path = candidates[i];
  const folder = topFolder(path);
  perFolder[folder] ??= { new: 0, exact: 0, near: 0, error: 0 };

  try {
    const candHash = sha256(path);
    // 1. Exact match
    const exact = corpusFingerprints.find((f) => f.hash === candHash);
    if (exact) {
      perFolder[folder].exact++;
      totalExact++;
      continue;
    }
    // 2. Near match (dHash)
    let candDhash = null;
    try { candDhash = await computeDHash(path); } catch { /* skip */ }
    if (candDhash) {
      const near = corpusFingerprints.find(
        (f) => f.dhash && hammingDistance(candDhash, f.dhash) < DHASH_THRESHOLD
      );
      if (near) {
        perFolder[folder].near++;
        totalNear++;
        continue;
      }
    }
    // 3. Genuinely new
    perFolder[folder].new++;
    totalNew++;
  } catch (err) {
    perFolder[folder].error++;
    totalError++;
  }

  if ((i + 1) % 200 === 0) console.error(`  processed ${i + 1}/${candidates.length} ...`);
}

// ─── report ──────────────────────────────────────────────────────────────────
const rows = Object.entries(perFolder).sort((a, b) => a[0].localeCompare(b[0]));
console.log("Per-product breakdown:");
console.log("  product".padEnd(34) + "new".padStart(6) + "exact".padStart(7) + "near".padStart(6) + "err".padStart(5));
console.log("  " + "─".repeat(56));
for (const [folder, c] of rows) {
  console.log(
    "  " + folder.slice(0, 32).padEnd(34) +
    String(c.new).padStart(6) +
    String(c.exact).padStart(7) +
    String(c.near).padStart(6) +
    String(c.error).padStart(5)
  );
}
console.log("  " + "─".repeat(56));
console.log(
  "  " + "TOTAL".padEnd(34) +
  String(totalNew).padStart(6) +
  String(totalExact).padStart(7) +
  String(totalNear).padStart(6) +
  String(totalError).padStart(5)
);

console.log(`\n=== Genuinely NEW images to tag: ${totalNew} ===`);
console.log(`  Exact dupes (already in corpus, will skip): ${totalExact}`);
console.log(`  Near dupes (same page variant in corpus, will skip): ${totalNear}`);
