#!/usr/bin/env node
// Gzip bundle-budget gate for the public site (spec §12: initial JS < 150KB gz,
// excluding the lazy Playground/Evidence chunks).
//
// What counts as "initial JS": the JavaScript the browser MUST download to render
// the first route (homepage / install). That is exactly the set of <script> tags
// Vite emits into dist/index.html — i.e. the entry chunk plus any module-preload
// polyfill. The lazy chunks (PlaygroundPage-*.js, EvidencePage-*.js,
// EvidenceImage-*.js) are reachable only through dynamic import() and are NEVER
// referenced from index.html, so by construction they are excluded.
//
// Two discovery strategies, in order of preference:
//   1. dist/.vite/manifest.json — if the build emits it (build.manifest: true),
//      use the non-dynamic `src` entries. Dynamic-import chunks are flagged
//      isEntry=false + isDynamicEntry=true in the manifest, so they are filtered.
//   2. dist/index.html — parse the emitted <script type="module" src="..."> tags.
//      This is the actual contract the browser sees on first paint and is robust
//      to manifest being disabled (the current vite.config.ts does not enable it).
//
// Either way, the result is the set of .js files that load on initial navigation.
// We gzip each one (zlib.gzipSync, level 9) and sum the bytes; exit non-zero when
// the total exceeds 150 * 1024 = 153600 bytes.

import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = resolve(__dirname, "..", "site", "dist");
const INDEX_HTML = resolve(DIST_DIR, "index.html");
const MANIFEST = resolve(DIST_DIR, ".vite", "manifest.json");

const BUDGET_BYTES = 150 * 1024; // 153600

/**
 * Resolve an asset href from index.html (which is base-path prefixed, e.g.
 * `/clean-ui-mcp/assets/index-Abc.js`) to an absolute path under dist/. We strip
 * the base path and any leading slash so the remainder maps to dist/<rel>.
 */
function resolveAssetHref(href) {
  // Drop query/fragment if present.
  const clean = href.split(/[?#]/)[0];
  // Remove a leading base path. The build base is "/clean-ui-mcp/" but we don't
  // hard-code it; instead strip everything up to and including the first
  // "/assets/" or "/entries/" segment boundary, falling back to a plain
  // leading-slash strip.
  const assetsIdx = clean.indexOf("/assets/");
  if (assetsIdx >= 0) {
    return resolve(DIST_DIR, "assets", clean.slice(assetsIdx + "/assets/".length));
  }
  const rel = clean.startsWith("/") ? clean.slice(1) : clean;
  return resolve(DIST_DIR, rel);
}

/**
 * Strategy 1: read the Vite manifest and collect non-dynamic JS entry files.
 * Returns null when no manifest exists (so the caller falls back to HTML).
 */
function collectFromManifest() {
  if (!existsSync(MANIFEST)) return null;
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf-8"));
  const files = [];
  for (const value of Object.values(manifest)) {
    if (!value || typeof value !== "object") continue;
    // Dynamic-import chunks (the lazy Playground/Evidence/EvidenceImage) are
    // explicitly flagged. Skip them — they must not count against the initial
    // budget. CSS entries are also excluded (the budget is for JS).
    if (value.isDynamicEntry === true) continue;
    if (!value.file) continue;
    if (!value.file.endsWith(".js")) continue;
    files.push(resolve(DIST_DIR, value.file));
  }
  return files;
}

/**
 * Strategy 2: parse index.html and collect every <script src> it references.
 * This is the literal initial-load contract: whatever the browser fetches on
 * first paint. Lazy chunks never appear here.
 */
function collectFromIndexHtml() {
  if (!existsSync(INDEX_HTML)) {
    throw new Error(
      `site/dist/index.html not found. Run \`npm run site:build\` before the budget check.`,
    );
  }
  const html = readFileSync(INDEX_HTML, "utf-8");
  const files = [];
  // Match <script ... src="..."> tags. Vite emits type="module" entry scripts;
  // we take every src regardless of type so a preload polyfill is included too.
  const scriptRe = /<script\b[^>]*\bsrc="([^"]+)"/gi;
  let match;
  while ((match = scriptRe.exec(html)) !== null) {
    const src = match[1];
    if (!src) continue;
    // Only local assets. (No external scripts are expected, but guard anyway.)
    if (/^https?:\/\//i.test(src)) continue;
    files.push(resolveAssetHref(src));
  }
  if (files.length === 0) {
    throw new Error(
      `No <script src> tags found in ${INDEX_HTML}. The build may be misconfigured.`,
    );
  }
  return files;
}

function main() {
  let files = collectFromManifest();
  let source = "manifest";
  if (!files || files.length === 0) {
    files = collectFromIndexHtml();
    source = "index.html";
  }

  // De-duplicate (a chunk could theoretically be referenced twice).
  const unique = Array.from(new Set(files));

  let total = 0;
  const rows = [];
  for (const abs of unique) {
    if (!existsSync(abs)) {
      throw new Error(`Referenced asset not found on disk: ${abs}`);
    }
    const raw = readFileSync(abs);
    const gz = gzipSync(raw, { level: 9 });
    total += gz.length;
    rows.push({ file: abs.replace(DIST_DIR + "/", ""), raw: raw.length, gz: gz.length });
  }

  const limitKb = (BUDGET_BYTES / 1024).toFixed(0);
  const totalKb = (total / 1024).toFixed(2);
  const pct = ((total / BUDGET_BYTES) * 100).toFixed(1);

  const breakdown = rows
    .map((r) => `  ${r.file.padEnd(40)} raw ${(r.raw / 1024).toFixed(2).padStart(8)}KB  gz ${(r.gz / 1024).toFixed(2).padStart(7)}KB`)
    .join("\n");

  process.stdout.write(
    `site initial-js gzip budget (discovery: ${source}, ${rows.length} file(s))\n` +
      `${breakdown}\n` +
      `total: ${totalKb} KB gz (${total} bytes) of ${limitKb} KB (${pct}% of budget)\n`,
  );

  if (total > BUDGET_BYTES) {
    process.stderr.write(
      `\nFAIL: initial JS gzip total ${total} bytes exceeds the ${BUDGET_BYTES} byte (${limitKb} KB) budget.\n` +
        `Move more code behind dynamic import() (lazy routes), or trim a dependency.\n`,
    );
    process.exit(1);
  }
  process.stdout.write("PASS: within budget.\n");
}

main();
