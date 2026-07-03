#!/usr/bin/env node
import "../env.js";
/**
 * bulk-import.ts
 * ──────────────
 * Process a folder of screenshots in parallel, tag each one with OpenAI
 * vision, and write a draft JSON file for human review before committing
 * anything to the real corpus.
 *
 * Two modes:
 *
 *  1. FOLDER mode  — discovers all .png/.jpg files in a directory.
 *     Product name and URL are either inferred from filename conventions
 *     or prompted interactively once per file (--interactive).
 *
 *     npm run bulk-import -- --folder corpus/images-private/batch-01
 *
 *  2. MANIFEST mode — reads a JSON manifest describing each screenshot
 *     explicitly (product, url, id, imagePath).
 *
 *     npm run bulk-import -- --manifest import-batch.json
 *
 * Output:
 *   corpus/entries-draft.json  — review + edit this, then run:
 *   npm run review-draft        — interactive reviewer to approve/edit/skip
 *
 * Filename convention for folder mode (avoids needing --interactive):
 *   <product-slug>__<optional-notes>.png
 *   e.g.  linear__issue-board.png  →  product "Linear", url inferred as https://linear.app
 *   The URL map lives in KNOWN_PRODUCTS below — extend it as you go.
 *
 * Options:
 *   --folder       Directory of screenshots to process
 *   --manifest     Path to a JSON manifest file
 *   --out          Output path (default: corpus/entries-draft.json)
 *   --concurrency  Parallel API calls (default: 3, max: 8)
 *   --interactive  Prompt for product/url when not inferrable (folder mode only)
 *   --resume       Skip files already present in the draft output (resume interrupted run)
 *   --force        Re-tag even if already in draft output
 */

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, extname, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { tagImage, type TaggerOutput } from "../tagger.js";
import { toCorpusRelativePath } from "../paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = resolve(__dirname, "..", "..", "corpus");

// ─── known product → URL map  (extend this as you build your corpus) ──────────
// Keyed by slug (lowercase, hyphens) derived from filename prefix before "__"
const KNOWN_PRODUCTS: Record<string, { name: string; url: string }> = {
  "linear":      { name: "Linear",      url: "https://linear.app" },
  "stripe":      { name: "Stripe",      url: "https://stripe.com" },
  "vercel":      { name: "Vercel",      url: "https://vercel.com" },
  "arc":         { name: "Arc",         url: "https://arc.net" },
  "notion":      { name: "Notion",      url: "https://notion.so" },
  "figma":       { name: "Figma",       url: "https://figma.com" },
  "github":      { name: "GitHub",      url: "https://github.com" },
  "raycast":     { name: "Raycast",     url: "https://raycast.com" },
  "craft":       { name: "Craft",       url: "https://craft.do" },
  "loom":        { name: "Loom",        url: "https://loom.com" },
  "retool":      { name: "Retool",      url: "https://retool.com" },
  "planetscale": { name: "PlanetScale", url: "https://planetscale.com" },
  "supabase":    { name: "Supabase",    url: "https://supabase.com" },
  "resend":      { name: "Resend",      url: "https://resend.com" },
  "clerk":       { name: "Clerk",       url: "https://clerk.com" },
};

// ─── types ────────────────────────────────────────────────────────────────────

interface ManifestEntry {
  imagePath:   string;
  productName: string;
  url:         string;
  id?:         string;
}

interface DraftFile {
  version:    1;
  exportedAt: string;
  entries:    Array<TaggerOutput & { _importStatus: "draft" | "approved" | "skipped" | "rejected" | "committed" }>;
}

// ─── args ─────────────────────────────────────────────────────────────────────

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    folder:      { type: "string" },
    manifest:    { type: "string" },
    out:         { type: "string" },
    concurrency: { type: "string", default: "3" },
    interactive: { type: "boolean", default: false },
    resume:      { type: "boolean", default: true },
    force:       { type: "boolean", default: false },
    help:        { type: "boolean", short: "h", default: false },
  },
});

if (args.help || (!args.folder && !args.manifest)) {
  console.log(`
Usage:
  npm run bulk-import -- --folder <dir>
  npm run bulk-import -- --manifest <path>

Options:
  --folder        Directory of .png/.jpg screenshots
  --manifest      JSON manifest: [{ imagePath, productName, url, id? }]
  --out           Output path (default: corpus/entries-draft.json)
  --concurrency   Parallel API calls (default: 3, max: 8)
  --interactive   Prompt for product/url when not inferrable (folder mode)
  --resume        Skip files already in draft output (default: true)
  --force         Re-tag even if already in draft output

Filename convention (folder mode, avoids --interactive):
  <product-slug>__<notes>.png   e.g. linear__issue-board.png
`);
  process.exit(0);
}

if (!process.env.OPENAI_API_KEY) {
  console.error("OPENAI_API_KEY not set. Add it to .env, then rerun this command.");
  process.exit(1);
}

const OUT_PATH    = resolve(args.out ?? join(CORPUS_ROOT, "entries-draft.json"));
const CONCURRENCY = Math.min(8, Math.max(1, parseInt(args.concurrency ?? "3")));

// ─── helpers ──────────────────────────────────────────────────────────────────

function join(...parts: string[]) { return resolve(...parts); }

function inferProduct(filename: string): { name: string; url: string } | null {
  const stem = basename(filename, extname(filename));
  const slug = stem.split("__")[0].toLowerCase().replace(/[^a-z0-9]/g, "-");
  return KNOWN_PRODUCTS[slug] ?? null;
}

function loadDraft(): DraftFile {
  if (existsSync(OUT_PATH)) {
    try { return JSON.parse(readFileSync(OUT_PATH, "utf-8")); } catch {}
  }
  return { version: 1, exportedAt: new Date().toISOString(), entries: [] };
}

function saveDraft(draft: DraftFile) {
  writeFileSync(OUT_PATH, JSON.stringify(draft, null, 2) + "\n", "utf-8");
}

// ─── concurrency pool ─────────────────────────────────────────────────────────

async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
  onDone: (result: T, index: number) => void,
  onError: (err: unknown, index: number) => void,
): Promise<void> {
  const queue = [...tasks.entries()];
  let active  = 0;

  await new Promise<void>((resolve) => {
    function runNext() {
      while (active < limit && queue.length > 0) {
        const [i, task] = queue.shift()!;
        active++;
        task()
          .then((r) => { onDone(r, i); })
          .catch((e) => { onError(e, i); })
          .finally(() => { active--; runNext(); if (active === 0 && queue.length === 0) resolve(); });
      }
    }
    runNext();
    if (tasks.length === 0) resolve();
  });
}

// ─── build work list ──────────────────────────────────────────────────────────

const rl = args.interactive
  ? createInterface({ input, output })
  : null;

async function askInteractive(prompt: string): Promise<string> {
  if (!rl) return "";
  return (await rl.question(`  ${prompt}: `)).trim();
}

async function buildWorkList(): Promise<ManifestEntry[]> {
  // Manifest mode
  if (args.manifest) {
    const raw = JSON.parse(readFileSync(resolve(args.manifest), "utf-8"));
    return (raw as ManifestEntry[]).map((e) => ({
      ...e,
      imagePath: resolve(dirname(resolve(args.manifest!)), e.imagePath),
    }));
  }

  // Folder mode
  const folderPath = resolve(args.folder!);
  const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
  const files      = readdirSync(folderPath)
    .filter((f) => IMAGE_EXTS.has(extname(f).toLowerCase()))
    .map((f) => resolve(folderPath, f));

  if (files.length === 0) {
    console.error(`No images found in ${folderPath}`);
    process.exit(1);
  }

  const entries: ManifestEntry[] = [];

  for (const imagePath of files) {
    const inferred = inferProduct(imagePath);

    if (inferred) {
      entries.push({ imagePath, productName: inferred.name, url: inferred.url });
      continue;
    }

    if (args.interactive && rl) {
      console.log(`\n  📸 ${basename(imagePath)}`);
      const productName = await askInteractive("Product name");
      const url         = await askInteractive("Source URL");
      if (productName && url) {
        entries.push({ imagePath, productName, url });
      } else {
        console.log("  Skipping (no product/url provided).");
      }
    } else {
      console.log(`  ⚠  Can't infer product for ${basename(imagePath)} — skipping. Use --interactive or rename to <product>__<notes>.png`);
    }
  }

  return entries;
}

// ─── main ─────────────────────────────────────────────────────────────────────

const draft    = loadDraft();
const existing = new Set(draft.entries.map((e) => e.image.path));

const workList = await buildWorkList();
rl?.close();

// Filter based on --resume / --force
const toProcess = workList.filter((item) => {
  if (args.force) return true;
  if (args.resume && existing.has(item.imagePath)) {
    console.log(`  ↩  Already in draft, skipping: ${basename(item.imagePath)}`);
    return false;
  }
  if (args.resume && existing.has(toCorpusRelativePath(item.imagePath))) {
    console.log(`  ↩  Already in draft, skipping: ${basename(item.imagePath)}`);
    return false;
  }
  return true;
});

if (toProcess.length === 0) {
  console.log(`\nAll ${workList.length} images already in draft. Use --force to re-tag.`);
  process.exit(0);
}

console.log(`\nProcessing ${toProcess.length} images (${workList.length - toProcess.length} skipped) at concurrency ${CONCURRENCY}…\n`);

const tasks = toProcess.map((item, i) => async () => {
  const label = `[${i + 1}/${toProcess.length}] ${basename(item.imagePath)}`;
  console.log(`  🔍 ${label}`);
  const result = await tagImage(item);
  console.log(`  ✅ ${label} → ${result.categories.join(", ")} | ${result.styleTags.join(", ")}`);
  return result;
});

const results: TaggerOutput[] = [];

await runWithConcurrency(
  tasks,
  CONCURRENCY,
  (result) => results.push(result),
  (err, i) => {
    const item = toProcess[i];
    console.error(`  ❌ Failed: ${basename(item?.imagePath ?? "?")} — ${err}`);
  },
);

// Merge results into draft (replace if --force, append if new)
for (const result of results) {
  const existingIdx = draft.entries.findIndex((e) => e.image.path === result.image.path);
  const withStatus  = { ...result, _importStatus: "draft" as const };
  if (existingIdx >= 0) {
    draft.entries[existingIdx] = withStatus;
  } else {
    draft.entries.push(withStatus);
  }
}

draft.exportedAt = new Date().toISOString();
saveDraft(draft);

const draftCount = draft.entries.filter((e) => e._importStatus === "draft").length;
console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Done.
  Tagged:  ${results.length} new/updated
  Draft:   ${draftCount} entries awaiting review
  File:    ${OUT_PATH}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Next step:
  npm run review-draft    (interactive review + commit to corpus)
  — or edit ${OUT_PATH} manually,
    then run: npm run commit-draft
`);
