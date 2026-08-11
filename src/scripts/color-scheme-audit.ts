#!/usr/bin/env node
/**
 * Produce a private, image-hash-bound deterministic colorScheme audit.
 * This command never edits corpus/entries.json; `propose` and `conflict`
 * rows are inputs to a later reviewed promotion step.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { detectColorScheme } from "../color-scheme.js";
import { assertCorpusImagePath, isWithin } from "../corpus-image-paths.js";
import { buildColorSchemeAuditReport, type ColorSchemeAuditInput } from "../color-scheme-audit.js";

type RawCorpusEntry = {
  id?: string;
  image?: { path?: string | null };
  colorScheme?: string | null;
};

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertSafeImagePath(corpusRoot: string, imagePath: string): string {
  // Shared guard: see src/corpus-image-paths.ts. `requireExists: false` keeps the
  // audit's behaviour of tolerating a missing image here — the row is recorded as
  // `missing-image` downstream rather than failing the whole run.
  return assertCorpusImagePath(corpusRoot, imagePath, { requireExists: false, label: "corpus" });
}

function nearestExistingPath(path: string): string {
  let candidate = path;
  while (!existsSync(candidate)) {
    const parent = dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

export function assertSafeOutputPath(corpusRoot: string, outPath: string): string {
  const absoluteOutPath = resolve(outPath);
  const absoluteCorpusRoot = resolve(corpusRoot);
  const realCorpusRoot = realpathSync(corpusRoot);
  if (isWithin(absoluteCorpusRoot, absoluteOutPath)) {
    throw new Error(`--out must be outside the corpus directory (got ${absoluteOutPath})`);
  }
  const existingTarget = existsSync(absoluteOutPath) ? absoluteOutPath : nearestExistingPath(dirname(absoluteOutPath));
  const realTarget = realpathSync(existingTarget);
  if (isWithin(realCorpusRoot, realTarget)) {
    throw new Error(`--out must be outside the corpus directory (got ${absoluteOutPath})`);
  }
  return absoluteOutPath;
}

export function buildColorSchemeAuditInputs(entries: readonly RawCorpusEntry[], corpusRoot: string): ColorSchemeAuditInput[] {
  // Identity and path violations fail closed before a report is written; per-row
  // statuses apply once a row has passed these safety invariants.
  const ids = new Set<string>();
  return entries.map((entry) => {
    const entryId = typeof entry.id === "string" && entry.id.trim().length > 0 ? entry.id : null;
    if (!entryId) throw new Error("missing entry ID in color-scheme audit input");
    if (ids.has(entryId)) throw new Error(`duplicate entry ID in color-scheme audit input: ${entryId}`);
    ids.add(entryId);
    const imagePath = typeof entry.image?.path === "string" && entry.image.path.length > 0 ? entry.image.path : null;
    const absoluteImagePath = imagePath ? assertSafeImagePath(corpusRoot, imagePath) : null;
    return {
      entryId,
      imagePath,
      imageSha256: null,
      existingColorScheme: entry.colorScheme || null,
      loadImage: absoluteImagePath ? () => readFileSync(absoluteImagePath) : undefined,
    };
  });
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      corpus: { type: "string", default: "corpus/entries.json" },
      out: { type: "string" },
    },
  });
  if (!values.out) throw new Error("usage: color-scheme-audit --out <private-report.json>");
  const corpusPath = resolve(values.corpus ?? "corpus/entries.json");
  const corpusRoot = resolve(dirname(corpusPath));
  const outPath = assertSafeOutputPath(corpusRoot, values.out);
  const corpusBytes = readFileSync(corpusPath);
  const parsed = JSON.parse(corpusBytes.toString("utf8")) as { entries?: RawCorpusEntry[] } | RawCorpusEntry[];
  const entries = Array.isArray(parsed) ? parsed : parsed.entries;
  if (!entries) throw new Error(`corpus file has no entries array: ${corpusPath}`);
  const inputs = buildColorSchemeAuditInputs(entries, corpusRoot);
  const report = await buildColorSchemeAuditReport({
    corpusSha256: sha256(corpusBytes),
    entries: inputs,
    generatedAt: new Date().toISOString(),
    detect: (imagePath, imageBytes) => detectColorScheme(imageBytes ?? resolve(corpusRoot, imagePath)),
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(`wrote ${outPath}`);
  console.log(`entries=${report.summary.entries} proposed=${report.summary.proposed} unchanged=${report.summary.unchanged} conflicts=${report.summary.conflicts} abstained=${report.summary.abstained} missing=${report.summary.missingImages} errors=${report.summary.errors}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
