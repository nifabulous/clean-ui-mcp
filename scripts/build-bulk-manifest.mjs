#!/usr/bin/env node
/**
 * build-bulk-manifest.mjs — generate a --manifest JSON for npm run bulk-import
 * from a folder of screenshots whose filenames don't follow the
 * `<product>__<notes>.png` convention that bulk-import's folder mode requires.
 *
 * Inference: takes the filename stem, matches it against PREFIX_MAP below.
 * PREFIX_MAP keys are lowercase substrings matched against the start of the
 * (lowercased, slugified) stem. The first match wins. Unmatched files are
 * listed and skipped so they don't silently get the wrong product stamp.
 *
 * Usage:
 *   node scripts/build-bulk-manifest.mjs --folder corpus/images-private \
 *     --out corpus/bulk-manifest.json
 *   node scripts/build-bulk-manifest.mjs --folder bulk-test-batch \
 *     --out corpus/bulk-test-manifest.json
 *
 * Then: npm run bulk-import -- --manifest corpus/bulk-test-manifest.json
 */

import { readdirSync, writeFileSync, statSync } from "node:fs";
import { resolve, basename, extname } from "node:path";
import { parseArgs } from "node:util";

// ─── prefix → { name, url } map ──────────────────────────────────────────────
// Order matters: longer/more-specific prefixes first so they win over shorter
// ones (e.g. "hume-ai" before any future "hume"). Keys are matched against the
// slugified filename stem (lowercase, hyphens, no version numbers).
//
// Extend this map as you add products. The URL is what gets stamped into each
// entry's source.url, so be deliberate about it.
const PREFIX_MAP = [
  { prefix: "wise",            name: "Wise",         url: "https://wise.com" },
  { prefix: "cash-app",        name: "Cash App",     url: "https://cash.app" },
  { prefix: "juicebox",        name: "Juicebox",     url: "https://juicebox.money" },
  { prefix: "aboard",          name: "Aboard",       url: "https://aboard.com" },
  { prefix: "workable",        name: "Workable",     url: "https://workable.com" },
  { prefix: "link",            name: "Link",         url: "https://link.co" },
  { prefix: "hume-ai",         name: "Hume AI",      url: "https://hume.ai" },
  { prefix: "origin",          name: "Origin",       url: "https://origin.com" },
  // ⚠️ fey URL not confirmed — fix before relying on these entries.
  { prefix: "fey",             name: "Fey",          url: "https://fey.com" },
  // New products added 2026-07-05 (URLs confirmed with user):
  { prefix: "alan",            name: "Alan",         url: "https://alan.com" },
  { prefix: "arcade",          name: "Arcade",       url: "https://arcade.software" },
  { prefix: "mercury",         name: "Mercury",      url: "https://mercury.com" },
  { prefix: "wealthsimple",    name: "Wealthsimple", url: "https://wealthsimple.com" },
  { prefix: "quicken",         name: "Quicken",      url: "https://quicken.com" },
  { prefix: "stack-ai",        name: "StackAI",      url: "https://stack-ai.com" },
  { prefix: "stackai",         name: "StackAI",      url: "https://stack-ai.com" },
];

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    folder: { type: "string" },
    out:    { type: "string" },
    help:   { type: "boolean", short: "h", default: false },
  },
});

if (args.help || !args.folder) {
  console.log(`Usage:
  node scripts/build-bulk-manifest.mjs --folder <dir> [--out <path>]

Default out: corpus/bulk-manifest.json (next to the folder's parent corpus root,
or ./bulk-manifest.json if not under corpus/).
`);
  process.exit(args.help ? 0 : 1);
}

const folder = resolve(args.folder);
const defaultOut = folder.endsWith("corpus/images-private")
  ? resolve(folder, "..", "bulk-manifest.json")
  : resolve(folder, "bulk-manifest.json");
const out = resolve(args.out ?? defaultOut);

// Slugify a filename stem: lowercase, collapse non-alphanumerics to hyphens,
// strip leading/trailing hyphens, then strip trailing version-ish tokens
// (e.g. "aboard-web-screens-0-2" → "aboard-web-screens"). We only need the
// prefix to match, so trailing numbers/version noise doesn't matter, but
// stripping it makes debugging easier.
function slugifyStem(stem) {
  return stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function inferProduct(filename) {
  const stem = basename(filename, extname(filename));
  const slug = slugifyStem(stem);
  for (const entry of PREFIX_MAP) {
    if (slug.startsWith(entry.prefix)) return entry;
  }
  return null;
}

// Recursively collect image files — supports a flat folder of images OR a
// folder of per-product subfolders (e.g. extracted-zip layout where each zip
// became its own subdirectory).
function listImages(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = resolve(dir, name);
    if (statSync(p).isDirectory()) out.push(...listImages(p));
    else if (/\.(png|jpe?g)$/i.test(name)) out.push(p);
  }
  return out;
}

// ─── scan ────────────────────────────────────────────────────────────────────

const files = listImages(folder).sort();

const manifest = [];
const skipped = [];

for (const f of files) {
  const inferred = inferProduct(f);
  if (inferred) {
    manifest.push({
      imagePath:    f, // already absolute from listImages
      productName:  inferred.name,
      url:          inferred.url,
    });
  } else {
    skipped.push(f);
  }
}

writeFileSync(out, JSON.stringify(manifest, null, 2));

// ─── report ──────────────────────────────────────────────────────────────────

const byProduct = manifest.reduce((acc, m) => {
  acc[m.productName] = (acc[m.productName] ?? 0) + 1;
  return acc;
}, {});

console.log(`Wrote ${manifest.length} entries → ${out}`);
console.log("By product:");
for (const [name, count] of Object.entries(byProduct).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${count.toString().padStart(4)}  ${name}`);
}
if (skipped.length) {
  console.warn(`\n⚠  Skipped ${skipped.length} unmatched file(s):`);
  for (const f of skipped) console.warn(`   ${f}`);
  console.warn("   Add them to PREFIX_MAP in scripts/build-bulk-manifest.mjs.");
}
