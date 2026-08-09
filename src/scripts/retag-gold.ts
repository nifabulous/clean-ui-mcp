#!/usr/bin/env node
/**
 * Build and validate the human gold-label packet for retag fields.
 *
 * This command never changes corpus/entries.json. `packet` creates a private
 * image-bound template from the frozen C2 selection; `validate` checks a human
 * submission against that selection and the current image bytes.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { C2LabelIntegritySelectionSchema, type C2LabelIntegritySelection } from "../c2/evaluation-contracts.js";
import {
  RETAG_GOLD_FIELDS,
  RetagGoldSelectionSchema,
  RetagGoldSubmissionSchema,
  buildRetagGoldPacket,
  toGoldLabels,
  validateRetagGoldPair,
  validateRetagGoldSubmission,
  type RetagGoldSelection,
  type RetagGoldSubmission,
} from "../retag-gold.js";

type CorpusEntry = {
  id: string;
  image?: { path?: string };
};

const DEFAULT_SELECTION = "eval/c2/label-integrity/selection.json";
const DEFAULT_CORPUS = "corpus/entries.json";

function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function loadCorpus(path: string): Map<string, CorpusEntry> {
  const parsed = readJson(path) as { entries?: CorpusEntry[] };
  if (!parsed || !Array.isArray(parsed.entries)) throw new Error(`corpus must contain an entries array: ${path}`);
  return new Map(parsed.entries.map((entry) => [entry.id, entry]));
}

function imagePathFor(corpusPath: string, entry: CorpusEntry): string {
  const rel = entry.image?.path;
  if (!rel) throw new Error(`entry ${entry.id} has no image.path`);
  const corpusRoot = resolve(dirname(corpusPath));
  const imagePath = resolve(corpusRoot, rel);
  if (imagePath !== corpusRoot && !imagePath.startsWith(corpusRoot + sep)) throw new Error(`image path escapes corpus root for ${entry.id}`);
  if (!existsSync(imagePath)) throw new Error(`image file not found for ${entry.id}: ${imagePath}`);
  return imagePath;
}

export function buildGoldSelection(c2: C2LabelIntegritySelection, selectionBytes: Buffer, corpusPath: string): RetagGoldSelection {
  const corpus = loadCorpus(corpusPath);
  const entries = c2.entries.map((selected) => {
    const entry = corpus.get(selected.entryId);
    if (!entry) throw new Error(`selection names unknown corpus entry ${selected.entryId}`);
    const imagePath = imagePathFor(corpusPath, entry);
    const actual = sha256(readFileSync(imagePath));
    if (actual !== selected.imageSha256) throw new Error(`current image hash mismatch for ${selected.entryId}: expected ${selected.imageSha256}, got ${actual}`);
    return {
      entryId: selected.entryId,
      imageSha256: selected.imageSha256,
      cohort: selected.cohort,
      stratum: selected.stratum,
      imagePath: imagePath.replace(`${resolve(dirname(corpusPath))}${sep}`, ""),
    };
  });
  return RetagGoldSelectionSchema.parse({
    schemaVersion: "1.0",
    artifactType: "retag-gold-selection",
    artifactId: "retag-gold-selection-v1",
    selectionArtifactId: c2.artifactId,
    selectionSha256: sha256(selectionBytes),
    fields: [...RETAG_GOLD_FIELDS],
    entries,
  });
}

function currentImageHashes(selection: RetagGoldSelection, corpusPath: string): Map<string, string> {
  const corpus = loadCorpus(corpusPath);
  return new Map(selection.entries.map((selected) => {
    const entry = corpus.get(selected.entryId);
    if (!entry) throw new Error(`selection names unknown corpus entry ${selected.entryId}`);
    return [selected.entryId, sha256(readFileSync(imagePathFor(corpusPath, entry)))];
  }));
}

function outputJson(path: string, value: unknown): void {
  const absolute = resolve(path);
  const corpusRoot = resolve("corpus");
  if (absolute === corpusRoot || absolute.startsWith(corpusRoot + sep)) throw new Error("gold artifacts must not be written inside corpus/");
  mkdirSync(dirname(absolute), { recursive: true });
  if (existsSync(absolute)) throw new Error(`refusing to overwrite existing artifact: ${absolute}`);
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  console.log(`wrote ${absolute}`);
}

export function validateSubmissionFile(submission: unknown, selection: RetagGoldSelection, corpusPath: string): RetagGoldSubmission {
  const parsed = RetagGoldSubmissionSchema.parse(submission);
  validateRetagGoldSubmission(parsed, selection, currentImageHashes(selection, corpusPath));
  return parsed;
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      selection: { type: "string", default: DEFAULT_SELECTION },
      corpus: { type: "string", default: DEFAULT_CORPUS },
      out: { type: "string" },
      submission: { type: "string" },
      "peer-submission": { type: "string" },
    },
  });
  const mode = positionals[0];
  if (mode !== "packet" && mode !== "validate") throw new Error("usage: retag-gold packet --out <private.json> | validate --submission <reviewer.json>");
  const selectionPath = resolve(values.selection ?? DEFAULT_SELECTION);
  const corpusPath = resolve(values.corpus ?? DEFAULT_CORPUS);
  const selectionBytes = readFileSync(selectionPath);
  const c2 = C2LabelIntegritySelectionSchema.parse(JSON.parse(selectionBytes.toString("utf8")));
  const selection = buildGoldSelection(c2, selectionBytes, corpusPath);
  if (mode === "packet") {
    if (!values.out) throw new Error("packet mode requires --out; use a private path outside corpus/");
    outputJson(values.out, buildRetagGoldPacket(selection));
    return;
  }
  if (!values.submission) throw new Error("validate mode requires --submission");
  const submissionPath = resolve(values.submission);
  const submission = validateSubmissionFile(readJson(submissionPath), selection, corpusPath);
  if (values["peer-submission"]) {
    const peer = validateSubmissionFile(readJson(resolve(values["peer-submission"])), selection, corpusPath);
    validateRetagGoldPair(submission, peer, selection);
  }
  const goldLabels = toGoldLabels(submission);
  if (values.out) outputJson(values.out, submission);
  console.log(`retag gold submission valid: ${goldLabels.length} entries, ${RETAG_GOLD_FIELDS.length} fields, selection ${selection.selectionSha256}`);
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
