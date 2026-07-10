import { Corpus, findDraftMarkers } from "../schema.js";
import { findVagueAntiPatterns } from "../content-lint.js";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fromCorpusRelativePath } from "../paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, "..", "..", "corpus", "entries.json");
const SEED_PATH = join(__dirname, "..", "..", "corpus", "seed.json");
const CONFIG_PATH = join(__dirname, "..", "..", "corpus", ".corpus-config.json");

// Curator runs this against their working entries.json; CI runs it on a fresh
// clone where entries.json is gitignored. Fall back to seed so CI validates the
// schema example instead of crashing on a missing file.
const corpusPath = existsSync(CORPUS_PATH) ? CORPUS_PATH : SEED_PATH;
const raw = readFileSync(corpusPath, "utf-8");
const result = Corpus.safeParse(JSON.parse(raw));

if (!result.success) {
  console.error("❌ Corpus validation failed:\n");
  for (const issue of result.error.issues) {
    console.error(`  ${issue.path.join(".")}: ${issue.message}`);
  }
  process.exit(1);
}

const entries = result.data!.entries;
const ids = new Set<string>();
const dupes: string[] = [];
const hygieneErrors: string[] = [];
const hygieneWarnings: string[] = [];

for (const e of entries) {
  if (ids.has(e.id)) dupes.push(e.id);
  ids.add(e.id);

  // [DRAFT]/[PLACEHOLDER] in critique/steal are hard errors — never ship.
  // [TODO] (migration placeholders in anti-patterns) is a WARNING — visible
  // nudge to backfill, but doesn't block the corpus since the migrator fills
  // them intentionally for entries that had no prior anti-pattern content.
  const dirtyFields = findDraftMarkers(e);
  if (dirtyFields.length) {
    hygieneErrors.push(`${e.id}: contains draft/placeholder marker in ${dirtyFields.join(", ")}`);
  }

  // Vague-phrase lint: generic filler is a hard error — caught at save, but this
  // is the CI backstop for entries that slipped through or were hand-edited.
  const vague = findVagueAntiPatterns(e);
  if (vague.length) {
    for (const v of vague) {
      hygieneErrors.push(`${e.id}: generic filler in ${v.field} (${v.issues.join("; ")})`);
    }
  }

  if (e.image.visibility !== "private" && e.image.path) {
    const fullPath = fromCorpusRelativePath(e.image.path);
    if (!existsSync(fullPath)) {
      hygieneErrors.push(`${e.id}: public image file not found at ${e.image.path}`);
    }
  }

  // Staleness: warn when the source hasn't been verified recently. Falls back
  // to capturedAt when lastVerified is absent. >12 months = stale risk.
  const verifyDate = e.source.lastVerified ?? e.source.capturedAt;
  const monthsSince = (Date.now() - new Date(verifyDate).getTime()) / (1000 * 60 * 60 * 24 * 30);
  if (monthsSince > 12) {
    hygieneWarnings.push(`${e.id}: source last verified ${verifyDate} (${Math.round(monthsSince)}mo ago) — re-check it still matches before relying on it`);
  }
}

if (dupes.length > 0) {
  console.error(`❌ Duplicate entry ids found: ${dupes.join(", ")}`);
  process.exit(1);
}

if (hygieneErrors.length > 0) {
  console.error("❌ Corpus hygiene checks failed:\n");
  for (const error of hygieneErrors) {
    console.error(`  ${error}`);
  }
  process.exit(1);
}

console.log(`✅ Corpus valid — ${entries.length} entries, ${ids.size} unique ids.`);

const privateCount = entries.filter((e) => e.image.visibility === "private").length;
const publicCount = entries.length - privateCount;
console.log(`   ${publicCount} with redistributable images, ${privateCount} metadata/critique-only.`);

// ── entry-count drift check ──────────────────────────────────────────────────
// Each curator encodes their own floor in corpus/.corpus-config.json (gitignored,
// local-only). If the count drops below it, shout — a bad restore or overwrite
// is the most common way to silently lose work. Non-fatal (warns, doesn't exit
// non-zero) so it never blocks CI, but it's impossible to miss.
if (existsSync(CONFIG_PATH)) {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as { expectedMinEntries?: number };
    if (typeof cfg.expectedMinEntries === "number" && entries.length < cfg.expectedMinEntries) {
      console.log(``);
      console.log(`⚠  ENTRY COUNT DROPPED: expected ≥${cfg.expectedMinEntries}, found ${entries.length}.`);
      console.log(`   This may indicate a bad restore or overwrite. Recover with:`);
      console.log(`     npm run restore-corpus -- --list   # see available snapshots`);
      console.log(`     npm run restore-corpus -- --latest # restore the newest`);
    }
  } catch { /* config unreadable — skip the check, not worth failing on */ }
}

if (hygieneWarnings.length > 0) {
  console.log(`\n⚠  ${hygieneWarnings.length} backfill warning(s) — non-blocking:`);
  for (const warning of hygieneWarnings) {
    console.log(`  ${warning}`);
  }
}
