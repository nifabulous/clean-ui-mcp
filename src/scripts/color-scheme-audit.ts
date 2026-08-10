#!/usr/bin/env node
/**
 * Produce a private, image-hash-bound deterministic colorScheme audit.
 * This command never edits corpus/entries.json; `propose` and `conflict`
 * rows are inputs to a later reviewed promotion step.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { detectColorScheme } from "../color-scheme.js";
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
  if (isAbsolute(imagePath) || imagePath.includes("..") || (!imagePath.startsWith("images-private/") && !imagePath.startsWith("images-public/"))) {
    throw new Error(`unsafe corpus image path: ${imagePath}`);
  }
  const realCorpusRoot = realpathSync(corpusRoot);
  const absoluteImagePath = resolve(corpusRoot, imagePath);
  if (existsSync(absoluteImagePath)) {
    const realImagePath = realpathSync(absoluteImagePath);
    if (realImagePath !== realCorpusRoot && !realImagePath.startsWith(realCorpusRoot + sep)) throw new Error(`image path escapes corpus root: ${imagePath}`);
  }
  return absoluteImagePath;
}

export function buildColorSchemeAuditInputs(entries: readonly RawCorpusEntry[], corpusRoot: string): ColorSchemeAuditInput[] {
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
  const outPath = resolve(values.out);
  if (outPath === corpusRoot || outPath.startsWith(corpusRoot + sep)) throw new Error(`--out must be outside the corpus directory (got ${outPath})`);
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
