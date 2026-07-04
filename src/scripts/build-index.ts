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

// Merge into existing index (or start fresh)
const index: EmbeddingIndex = existing && !values.force
  ? existing
  : { version: 1, model: "voyage-4", entries: {} };

// Embed in checkpoints of CHUNK entries each, saving the index after every
// chunk. A rate-limit failure at entry 300 keeps the first 300 — re-running
// picks up where it left off (incremental mode skips already-indexed ids).
// embedDocuments handles per-batch retry/backoff internally; this adds
// crash-resilience on top.
const CHUNK = 100;
let embedded = 0;
for (let start = 0; start < toEmbed.length; start += CHUNK) {
  const chunk = toEmbed.slice(start, start + CHUNK);
  const texts = chunk.map(entryToDocument);
  const vectors = await embedDocuments(texts);
  if (vectors.length !== chunk.length) {
    console.error(`API returned ${vectors.length} vectors for ${chunk.length} inputs — aborting at chunk ${start}.`);
    console.error(`Index saved with ${Object.keys(index.entries).length} entries so far. Re-run to continue.`);
    saveIndex(index);
    process.exit(1);
  }
  for (let i = 0; i < chunk.length; i++) {
    index.entries[chunk[i].id] = vectors[i];
  }
  saveIndex(index); // checkpoint
  embedded += chunk.length;
  console.log(`  ${embedded}/${toEmbed.length} embedded — index saved (${Object.keys(index.entries).length} total)`);
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
