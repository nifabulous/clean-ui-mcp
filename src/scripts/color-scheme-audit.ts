#!/usr/bin/env node
/**
 * Produce a private, image-hash-bound deterministic colorScheme audit.
 * This command never edits corpus/entries.json; `propose` and `conflict`
 * rows are inputs to a later reviewed promotion step.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, resolve, sep } from "node:path";
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

export function buildColorSchemeAuditInputs(entries: readonly RawCorpusEntry[], corpusRoot: string): ColorSchemeAuditInput[] {
  return entries.map((entry) => {
    const entryId = typeof entry.id === "string" && entry.id.length > 0 ? entry.id : "<missing-id>";
    const imagePath = typeof entry.image?.path === "string" && entry.image.path.length > 0 ? entry.image.path : null;
    const absoluteImagePath = imagePath ? resolve(corpusRoot, imagePath) : null;
    return {
      entryId,
      imagePath,
      imageSha256: absoluteImagePath && existsSync(absoluteImagePath) ? sha256(readFileSync(absoluteImagePath)) : null,
      existingColorScheme: entry.colorScheme || null,
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
    detect: (imagePath) => detectColorScheme(resolve(corpusRoot, imagePath)),
  });
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  console.log(`wrote ${outPath}`);
  console.log(`entries=${report.summary.entries} proposed=${report.summary.proposed} unchanged=${report.summary.unchanged} conflicts=${report.summary.conflicts} abstained=${report.summary.abstained} missing=${report.summary.missingImages} errors=${report.summary.errors}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
