#!/usr/bin/env node
/**
 * Materialize an explicitly reviewed shadow-retag batch without mutating the
 * canonical corpus. The output is a v2 corpus document containing draft rows;
 * a separate, reviewed persistence step must install it.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { loadCorpus } from "../corpus.js";
import { promoteAccepted, type PromotionDecision, type RetagCandidate } from "../retag-promote.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    run: { type: "string" },
    decisions: { type: "string" },
    out: { type: "string" },
  },
});

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} is required`);
  return value;
}

const runDir = resolve(required(values.run, "--run"));
const decisionsPath = resolve(required(values.decisions, "--decisions"));
const outPath = resolve(required(values.out, "--out"));
const corpusDir = resolve("corpus");
if (outPath === corpusDir || outPath.startsWith(corpusDir + sep)) {
  throw new Error(`--out must not point inside corpus/ (got ${outPath})`);
}
if (existsSync(outPath)) throw new Error(`refusing to overwrite existing output: ${outPath}`);

const candidatesRaw = JSON.parse(readFileSync(resolve(runDir, "candidates.json"), "utf8")) as unknown;
if (!Array.isArray(candidatesRaw)) throw new Error(`shadow candidates must be a JSON array: ${resolve(runDir, "candidates.json")}`);
const decisionsRaw = JSON.parse(readFileSync(decisionsPath, "utf8")) as unknown;
if (!Array.isArray(decisionsRaw)) throw new Error(`promotion decisions must be a JSON array: ${decisionsPath}`);

const candidates = candidatesRaw.filter((row): row is RetagCandidate => {
  return !!row && typeof row === "object" && "candidate" in row && (row as { candidate?: unknown }).candidate !== undefined;
});
const decisions = decisionsRaw as PromotionDecision[];
const baseline = loadCorpus();
const promoted = promoteAccepted(baseline, candidates, decisions);

writeFileSync(outPath, JSON.stringify({ version: 2, entries: promoted }, null, 2) + "\n");
console.log(`wrote reviewed draft corpus artifact ${outPath} (${decisions.length} decisions, ${promoted.length} entries)`);
