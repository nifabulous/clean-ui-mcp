#!/usr/bin/env node
/**
 * migrate-wcag-ids.ts
 * ───────────────────
 * Migrate accessibility risks to the canonical WCAG 2.2 ID schema.
 *
 * Before this migration, accessibilityRisks was a union of:
 *   - legacy free-text strings (uncited, from older prompts)
 *   - structured objects with wcag?: string (free-text title-bearing citations)
 *   - structured objects with no wcag at all
 *
 * After this migration:
 *   - accessibilityRisks holds ONLY structured objects with a REQUIRED
 *     wcag: string[] of canonical bare IDs (e.g. ["1.4.3"]).
 *   - legacy free-text notes move to antiPatterns.legacyAccessibilityNotes
 *     (retained for human review, excluded from MCP retrieval + embeddings).
 *
 * Three transformations, applied idempotently:
 *   1. NORMALIZE — the 11 citation-bearing structured risks: extract bare IDs
 *      from title-bearing citations ("1.4.3 Contrast (Minimum)" → ["1.4.3"]),
 *      deduplicate, validate against the vendored WCAG 2.2 registry.
 *   2. DELETE — the 1 uncited structured object (workable-workable-2): its own
 *      evidence says "no risk is confirmed" — it is a non-risk, not a citation
 *      to assign. Deleted, not migrated.
 *   3. QUARANTINE — the 13 legacy strings move to legacyAccessibilityNotes.
 *
 * Idempotent: re-running on already-migrated data is a no-op.
 * --dry-run previews the old→new transformation without writing.
 *
 * Usage:
 *   npm run migrate-wcag-ids
 *   npm run migrate-wcag-ids -- --dry-run
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { writeAtomic, writeRawSnapshot } from "../persistence.js";
import { Corpus } from "../schema.js";
import { transformAccessibilityRisk, type LegacyRisk } from "./wcag-migration.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(__dirname, "..", "..", "corpus", "entries.json");

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    "dry-run": { type: "boolean", default: false },
    help:      { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`Usage: npm run migrate-wcag-ids [-- --dry-run]
  --dry-run   Preview the transformation without writing.`);
  process.exit(0);
}

type AntiPatterns = {
  antiPatterns: string[];
  whereThisFails: string[];
  accessibilityRisks: LegacyRisk[];
  legacyAccessibilityNotes?: string[];
};

const originalSerialized = readFileSync(CORPUS_PATH, "utf-8");
const raw = JSON.parse(originalSerialized);
const entries: Array<{ id: string; antiPatterns?: AntiPatterns }> = raw.entries;

/** Report tallies + per-entry transformation log for the dry-run output. */
interface Report {
  normalized: Array<{ id: string; from: string; to: string[] }>;
  deleted: Array<{ id: string; reason: string }>;
  quarantined: Array<{ id: string; note: string }>;
  invalidCitations: Array<{ id: string; raw: string }>;
  alreadyMigrated: number;
}

const report: Report = { normalized: [], deleted: [], quarantined: [], invalidCitations: [], alreadyMigrated: 0 };

for (const entry of entries) {
  const ap = entry.antiPatterns;
  if (!ap) continue;

  const active: LegacyRisk[] = ap.accessibilityRisks ?? [];
  const legacy: string[] = ap.legacyAccessibilityNotes ?? [];

  const newActive: NonNullable<AntiPatterns["accessibilityRisks"]> = [];

  for (const risk of active) {
    const transformed = transformAccessibilityRisk(risk);
    if (transformed.kind === "quarantined") {
      report.quarantined.push({ id: entry.id, note: transformed.note.slice(0, 70) });
      legacy.push(transformed.note);
      continue;
    }

    if (transformed.kind === "normalized") {
      if (typeof risk !== "string" && typeof risk.wcag === "string") {
        report.normalized.push({ id: entry.id, from: risk.wcag, to: transformed.wcag });
      }
      newActive.push(transformed.risk);
      continue;
    }

    if (transformed.rawCitation) {
      report.invalidCitations.push({ id: entry.id, raw: transformed.rawCitation });
      report.deleted.push({ id: entry.id, reason: "citation yielded no valid WCAG IDs" });
    } else {
      const description = typeof risk === "string" ? "" : risk.risk;
      report.deleted.push({
        id: entry.id,
        reason: description.includes("no risk is confirmed") || description.includes("likely accessible")
          ? "self-described non-risk (evidence confirms no risk)"
          : "structured risk with no wcag citation",
      });
    }
  }

  // If nothing changed for this entry, count as already-migrated.
  const changed =
    newActive.length !== active.length ||
    legacy.length !== (ap.legacyAccessibilityNotes?.length ?? 0) ||
    newActive.some((r, i) => JSON.stringify(r) !== JSON.stringify(active[i]));

  if (!changed && active.every((r) => typeof r !== "string" && Array.isArray(r.wcag))) {
    report.alreadyMigrated++;
  }

  ap.accessibilityRisks = newActive;
  ap.legacyAccessibilityNotes = legacy;
}

// ─── Report ───────────────────────────────────────────────────────────────────
console.log("WCAG ID migration report");
console.log("=".repeat(50));
console.log(`Entries scanned:           ${entries.length}`);
console.log(`Already migrated (no-op):  ${report.alreadyMigrated}`);
console.log(`Normalized (title→IDs):    ${report.normalized.length}`);
console.log(`Deleted (non-risk):        ${report.deleted.length}`);
console.log(`Quarantined (legacy note): ${report.quarantined.length}`);
console.log(`Invalid citations found:   ${report.invalidCitations.length}`);

if (report.normalized.length) {
  console.log("\n─ Normalized citations (title-bearing → bare IDs) ─");
  for (const n of report.normalized) console.log(`  ${n.id}: "${n.from}" → [${n.to.join(", ")}]`);
}
if (report.deleted.length) {
  console.log("\n─ Deleted (non-risks) ─");
  for (const d of report.deleted) console.log(`  ${d.id}: ${d.reason}`);
}
if (report.invalidCitations.length) {
  console.log("\n─ ⚠ Invalid citations (not in WCAG 2.2 registry) ─");
  for (const c of report.invalidCitations) console.log(`  ${c.id}: "${c.raw}"`);
}
if (report.quarantined.length) {
  console.log(`\n─ Quarantined to legacyAccessibilityNotes: ${report.quarantined.length} notes ─`);
  for (const q of report.quarantined.slice(0, 5)) console.log(`  ${q.id}: "${q.note}…"`);
  if (report.quarantined.length > 5) console.log(`  …and ${report.quarantined.length - 5} more`);
}

// ─── Fail-safe: abort if invalid citations were found ─────────────────────────
if (report.invalidCitations.length > 0) {
  console.error(`\n❌ Aborting: ${report.invalidCitations.length} citation(s) did not match the WCAG 2.2 registry.`);
  console.error("   Resolve these manually (assign a valid canonical ID) before re-running.");
  process.exit(1);
}

// Validate the complete post-migration document before preserving or replacing
// anything. The migration can accept legacy input, but its output must satisfy
// the current corpus schema exactly.
const migrated = Corpus.safeParse(raw);
if (!migrated.success) {
  console.error("\n❌ Aborting: migration output does not satisfy the corpus schema.");
  console.error(migrated.error.issues.map((issue) => `   ${issue.path.join(".")}: ${issue.message}`).join("\n"));
  process.exit(1);
}

// ─── Write (or preview) ───────────────────────────────────────────────────────
if (values["dry-run"]) {
  console.log("\n(dry-run — no changes written)");
} else {
  // Preserve the exact original document before overwrite. Unlike UI saves,
  // this migration may begin with a legacy shape that the current schema cannot
  // parse, so it snapshots raw serialized JSON rather than typed entries.
  writeRawSnapshot(originalSerialized);
  writeAtomic(CORPUS_PATH, JSON.stringify(migrated.data, null, 2) + "\n");
  console.log(`\n✓ Wrote ${entries.length} entries to ${CORPUS_PATH}`);
}
