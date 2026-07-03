#!/usr/bin/env node
import "../env.js";
/**
 * build-index.ts
 * ───────────────
 * Embeds all corpus entries via Voyage AI and writes corpus/embeddings.json.
 * Run this after adding new entries so the vector search stays in sync.
 *
 * Usage:
 *   npm run build-index
 *
 * Env: VOYAGE_API_KEY  (https://dash.voyageai.com — free tier is sufficient)
 *
 * Incremental by default: only re-embeds entries missing from the current
 * index. Pass --force to re-embed everything (e.g. after changing entryToDocument).
 *
 * Cost estimate: ~$0.00006 per entry at Voyage voyage-4 pricing.
 * 200 entries ≈ $0.01. Safe to run freely.
 */

import { parseArgs } from "node:util";
import { loadCorpus } from "../corpus.js";
import {
  embedDocuments,
  entryToDocument,
  loadIndex,
  saveIndex,
  type EmbeddingIndex,
} from "../embeddings.js";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    force: { type: "boolean", default: false },
    help:  { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(`
Usage: npm run build-index [-- --force]

  --force   Re-embed all entries, even those already in the index.
            Use after changing entryToDocument() in embeddings.ts.
`);
  process.exit(0);
}

if (!process.env.VOYAGE_API_KEY) {
  console.error(`
VOYAGE_API_KEY not set.
Get a free key at https://dash.voyageai.com, add it to .env, then rerun:
  npm run build-index
`);
  process.exit(1);
}

const entries = loadCorpus();
const existing = loadIndex();

// Determine which entries need embedding
const toEmbed = values.force
  ? entries
  : entries.filter((e) => !existing?.entries[e.id]);

if (toEmbed.length === 0) {
  console.log(`✅ Index up to date — all ${entries.length} entries already embedded.`);
  console.log(`   Run with --force to rebuild everything.`);
  process.exit(0);
}

console.log(`Embedding ${toEmbed.length} entries (${entries.length - toEmbed.length} already indexed)…`);

// Build document texts
const texts = toEmbed.map(entryToDocument);

// Embed — logs progress for large batches
const vectors = await embedDocuments(texts);

if (vectors.length !== toEmbed.length) {
  console.error(`API returned ${vectors.length} vectors for ${toEmbed.length} inputs — aborting.`);
  process.exit(1);
}

// Merge into existing index (or start fresh)
const index: EmbeddingIndex = existing && !values.force
  ? existing
  : { version: 1, model: "voyage-4", entries: {} };

for (let i = 0; i < toEmbed.length; i++) {
  index.entries[toEmbed[i].id] = vectors[i];
}

// Remove stale entries (ids no longer in corpus)
const corpusIds = new Set(entries.map((e) => e.id));
for (const id of Object.keys(index.entries)) {
  if (!corpusIds.has(id)) {
    delete index.entries[id];
    console.log(`  Removed stale embedding: ${id}`);
  }
}

saveIndex(index);

const total = Object.keys(index.entries).length;
console.log(`✅ Index saved — ${total} entries embedded.`);
console.log(`   File: corpus/embeddings.json`);
console.log(`   Next: npm start  (server will use vector search automatically)`);
