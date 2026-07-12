#!/usr/bin/env node
/**
 * doctor.ts — one-command project health check.
 *
 * Runs a checklist across the whole project and reports PASS/WARN/FAIL per
 * check. Exits non-zero only on FAIL (things that block the corpus or the build).
 * WARNs are informational — the project still works, but something's worth attention.
 *
 * Usage:
 *   npm run doctor
 *   npm run doctor -- --json
 */
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { hasDraftMarkers } from "../schema.js";
import { indexStatus } from "../corpus.js";
import { CORPUS_ROOT, allImageFiles } from "../paths.js";
import { ENTRIES_PATH, SNAPSHOT_DIR, listSnapshots, tryReadCorpus } from "../persistence.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(CORPUS_ROOT, ".corpus-config.json");
const args = process.argv.slice(2);
const asJson = args.includes("--json");

type Status = "PASS" | "WARN" | "FAIL";
interface Check { name: string; status: Status; detail: string; }

const checks: Check[] = [];

// ── 1. TypeScript compiles ───────────────────────────────────────────────────
try {
  execFileSync("npx", ["tsc", "--noEmit"], { encoding: "utf-8", stdio: "pipe", cwd: resolve(__dirname, "..", "..") });
  checks.push({ name: "TypeScript compiles", status: "PASS", detail: "tsc --noEmit clean" });
} catch (e) {
  const err = e as { stdout?: string; stderr?: string };
  const out = (err.stdout || err.stderr || "").trim().slice(0, 300);
  checks.push({ name: "TypeScript compiles", status: "FAIL", detail: out || "tsc failed" });
}

// ── 2. Corpus validates (schema + draft hygiene) ─────────────────────────────
// The doctor is the one tool that must NEVER crash on a broken corpus — it's
// what a developer reaches for when something is wrong. tryReadCorpus returns
// null for missing/corrupt files but THROWS on unsupported-newer (a {version:3}
// file is fatal by design, so the loader doesn't silently mask it). Catch both
// outcomes here and surface them as a FAIL row with an actionable detail,
// rather than letting the throw escape as a stack trace.
let entries: import("../schema.js").CorpusEntryT[] | null = null;
try {
  entries = tryReadCorpus(ENTRIES_PATH)?.entries ?? null;
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  checks.push({ name: "Corpus validates", status: "FAIL", detail: `entries.json: ${msg}` });
}
if (!entries) {
  if (!checks.some((c) => c.name === "Corpus validates")) {
    checks.push({ name: "Corpus validates", status: "FAIL", detail: `entries.json unreadable — run \`npm run restore-corpus -- --latest\`` });
  }
} else {
  const dirtyDraft = entries.filter((e) => hasDraftMarkers(e));
  const ids = new Set<string>();
  const dupes: string[] = [];
  for (const e of entries) { if (ids.has(e.id)) dupes.push(e.id); ids.add(e.id); }
  if (dupes.length) {
    checks.push({ name: "No duplicate ids", status: "FAIL", detail: `${dupes.length} duplicate id(s): ${dupes.slice(0, 5).join(", ")}` });
  } else {
    checks.push({ name: "No duplicate ids", status: "PASS", detail: `${ids.size} unique ids` });
  }
  if (dirtyDraft.length) {
    checks.push({ name: "Corpus validates", status: "FAIL", detail: `${dirtyDraft.length} entr${dirtyDraft.length === 1 ? "y" : "ies"} carry draft markers` });
  } else {
    checks.push({ name: "Corpus validates", status: "PASS", detail: `${entries.length} entries, schema-clean` });
  }
}

// ── 3. Entry-count drift (if .corpus-config.json present) ────────────────────
if (existsSync(CONFIG_PATH) && entries) {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { expectedMinEntries?: number };
    if (typeof cfg.expectedMinEntries === "number" && entries.length < cfg.expectedMinEntries) {
      checks.push({ name: "Entry count ≥ expected", status: "WARN", detail: `found ${entries.length}, expected ≥${cfg.expectedMinEntries} — possible bad restore (run \`npm run restore-corpus -- --list\`)` });
    } else {
      checks.push({ name: "Entry count ≥ expected", status: "PASS", detail: `${entries.length} ≥ ${cfg.expectedMinEntries ?? "?"}` });
    }
  } catch { /* config unreadable — skip */ }
}

// ── 4. Snapshot freshness ───────────────────────────────────────────────────
const snaps = listSnapshots();
if (!snaps.length) {
  checks.push({ name: "Snapshots available", status: entries && entries.length ? "WARN" : "PASS", detail: "no snapshots — first save will create one" });
} else {
  const newestEpoch = Number(snaps[0].match(/entries-(\d+)\.json$/)?.[1] ?? 0);
  const ageDays = Math.round((Date.now() - newestEpoch) / 86400000);
  if (ageDays > 7) {
    checks.push({ name: "Snapshot freshness", status: "WARN", detail: `${snaps.length} snapshots, newest is ${ageDays}d old — start the UI to refresh` });
  } else {
    checks.push({ name: "Snapshot freshness", status: "PASS", detail: `${snaps.length} snapshots, newest ${ageDays}d old` });
  }
}

// ── 5. Image references (orphans + missing) ─────────────────────────────────
// Walks the image dirs RECURSIVELY (bulk-import batches nest files by source
// folder, e.g. images-private/new-products-batch/Mercury Web Screens/…). An
// earlier flat readdirSync missed nested files entirely, surfacing false
// "missing" warnings for refs that actually resolved and undercounting orphans.
if (entries) {
  const referenced = new Set(entries.map((e) => e.image.path).filter((p): p is string => !!p));
  const diskFiles = allImageFiles();
  const orphanCount = [...diskFiles].filter((f) => !referenced.has(f)).length;
  const missingCount = [...referenced].filter((p) => !diskFiles.has(p)).length;
  if (missingCount > 0) {
    checks.push({ name: "Image references resolve", status: "WARN", detail: `${missingCount} entr${missingCount === 1 ? "y" : "ies"} point at missing image files` });
  } else {
    checks.push({ name: "Image references resolve", status: "PASS", detail: `${referenced.size} referenced, all present` });
  }
  if (orphanCount > 0) {
    checks.push({ name: "No orphaned images", status: "WARN", detail: `${orphanCount} unreferenced file(s) — run \`npm run clean-orphans -- --dry-run\`` });
  } else {
    checks.push({ name: "No orphaned images", status: "PASS", detail: "no orphans" });
  }
}

// ── 6. Index coverage (drift) ────────────────────────────────────────────────
// Skip when the corpus is unreadable — indexStatus() reparses entries.json via
// loadCorpus() and would throw on corruption. The doctor is most needed during
// exactly that scenario, so it must not crash there.
//
// Three drift directions are surfaced: missing (no vector), stale (orphan
// vector), and contentStale (vector present but the entry's title/critique/
// tags changed after it was embedded — detected via the per-entry content hash
// in v2 indexes). contentStale is the silent one: search still returns the
// entry, but against stale text. Incremental build-index re-embeds these.
if (!entries) {
  checks.push({ name: "Search index", status: "WARN", detail: "skipped — corpus unreadable; restore first (run `npm run restore-corpus -- --latest`)" });
} else {
  const index = indexStatus();
  if (!index.hasIndex) {
    checks.push({ name: "Search index", status: "WARN", detail: "no index — keyword search only (run `npm run build-index`)" });
  } else if (index.missing > 0 || index.stale > 0 || index.contentStale > 0) {
    const parts = [
      index.missing > 0 ? `${index.missing} missing` : null,
      index.stale > 0 ? `${index.stale} stale` : null,
      index.contentStale > 0 ? `${index.contentStale} content-stale` : null,
    ].filter(Boolean).join(" · ");
    checks.push({ name: "Search index", status: "WARN", detail: `${index.indexed}/${index.total} indexed · ${parts} — run \`npm run build-index\`` });
  } else {
    checks.push({ name: "Search index", status: "PASS", detail: `${index.indexed}/${index.total} indexed, no drift` });
  }
}

// ── 7. Env / provider status ─────────────────────────────────────────────────
const providers = [
  process.env.OPENAI_API_KEY && "OpenAI",
  process.env.ANTHROPIC_API_KEY && "Claude",
  process.env.GEMINI_API_KEY && "Gemini",
].filter(Boolean) as string[];
const voyage = !!process.env.VOYAGE_API_KEY;
if (!providers.length) {
  checks.push({ name: "Vision provider key", status: "WARN", detail: "no vision key set — Auto-fill won't work" });
} else {
  checks.push({ name: "Vision provider key", status: "PASS", detail: providers.join(", ") });
}
if (!voyage) {
  checks.push({ name: "Voyage key (vector index)", status: "WARN", detail: "VOYAGE_API_KEY not set — build-index needs it for embeddings" });
} else {
  checks.push({ name: "Voyage key (vector index)", status: "PASS", detail: "set" });
}

// ── 8. Capture Chromium (Playwright) ──────────────────────────────────────────
// Playwright exposes the Chromium executable path lazily — wrap in try/catch
// because requiring playwright at module load runs its install-time browser
// download in some setups.
let chromiumPath: string | null = null;
try {
  const chromium = await import("playwright");
  chromiumPath = (chromium as any).chromium?.executablePath?.() ?? null;
} catch { /* playwright not installed yet */ }

if (chromiumPath && existsSync(chromiumPath)) {
  checks.push({ name: "Capture Chromium", status: "PASS", detail: "Playwright Chromium installed — `npm run capture` ready" });
} else {
  checks.push({ name: "Capture Chromium", status: "WARN", detail: "Playwright Chromium not found — run `npx playwright install chromium` to enable `npm run capture`" });
}

// ── report ───────────────────────────────────────────────────────────────────
const failed = checks.filter((c) => c.status === "FAIL");
const warned = checks.filter((c) => c.status === "WARN");

if (asJson) {
  console.log(JSON.stringify({ checks, summary: { pass: checks.filter((c) => c.status === "PASS").length, warn: warned.length, fail: failed.length, exit: failed.length ? 1 : 0 } }, null, 2));
} else {
  const icon = (s: Status) => s === "PASS" ? "✅" : s === "WARN" ? "⚠️ " : "❌";
  console.log("clean-ui-mcp doctor\n" + "═".repeat(50));
  const maxName = Math.max(...checks.map((c) => c.name.length));
  for (const c of checks) {
    console.log(`${icon(c.status)} ${c.name.padEnd(maxName + 2)} ${c.detail}`);
  }
  console.log("═".repeat(50));
  console.log(`${checks.length - failed.length - warned.length} pass · ${warned.length} warn · ${failed.length} fail`);
  if (failed.length) console.log(`\n❌ ${failed.length} FAIL — fix before relying on the corpus.`);
  else if (warned.length) console.log(`\n⚠️  ${warned.length} warning(s) — project works, but address these.`);
  else console.log(`\n✅ All checks pass.`);
}

process.exit(failed.length ? 1 : 0);
