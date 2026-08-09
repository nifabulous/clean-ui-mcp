#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadCorpus } from "../corpus.js";
import { buildDisposition, validateDisposition, sha256 } from "../retag-disposition.js";

const artifactPath = resolve("docs/retag-disposition-v1.json");
const corpusPath = resolve("corpus/entries.json");
const write = process.argv.includes("--write");
const corpusBytes = readFileSync(corpusPath);
const entries = loadCorpus();
const corpusSha256 = sha256(corpusBytes);

if (write) {
  const artifact = buildDisposition(entries, corpusSha256);
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`wrote ${artifactPath}`);
} else {
  if (!existsSync(artifactPath)) throw new Error(`missing ${artifactPath}; run npm run retag-disposition -- --write`);
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as unknown;
  validateDisposition(artifact, entries, corpusSha256);
  console.log(`retag disposition valid: ${entries.length} entries, ${Object.keys((artifact as { fields: object }).fields).length} fields, corpus ${corpusSha256}`);
}
