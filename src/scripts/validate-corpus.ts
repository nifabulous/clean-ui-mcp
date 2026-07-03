import { Corpus, findDraftMarkers } from "../schema.js";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fromCorpusRelativePath } from "../paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = join(__dirname, "..", "..", "corpus", "entries.json");

const raw = readFileSync(CORPUS_PATH, "utf-8");
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

if (hygieneWarnings.length > 0) {
  console.log(`\n⚠  ${hygieneWarnings.length} backfill warning(s) — non-blocking:`);
  for (const warning of hygieneWarnings) {
    console.log(`  ${warning}`);
  }
}
