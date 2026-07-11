/**
 * build-image-index.ts — embed approved corpus images into the image index.
 *
 * Analogous to build-index.ts for text embeddings. Reads all approved entries,
 * embeds their images using the configured image-embedding provider, and writes
 * corpus/image-embeddings.json incrementally (skips entries whose image hash
 * hasn't changed).
 *
 * Usage: npm run build-image-index
 */
import "../env.js";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { Corpus } from "../schema.js";
import { fromCorpusRelativeImagePath } from "../paths.js";
import { createImageEmbeddingProvider } from "../image-embeddings.js";
import { loadImageIndex, saveImageIndex, hashForImage, type ImageEmbeddingIndex } from "../image-index.js";

const CORPUS_PATH = resolve(import.meta.dirname ?? __dirname, "..", "..", "corpus", "entries.json");

async function main() {
  const provider = createImageEmbeddingProvider();
  if (!provider) {
    console.error("❌ No image-embedding provider configured.");
    console.error("   Set IMAGE_EMBEDDING_PROVIDER and IMAGE_EMBEDDING_API_KEY in .env");
    process.exit(1);
  }

  if (!existsSync(CORPUS_PATH)) {
    console.error("❌ corpus/entries.json not found. Run the curator workflow first.");
    process.exit(1);
  }

  const raw = JSON.parse(readFileSync(CORPUS_PATH, "utf-8"));
  const corpus = Corpus.parse(raw);
  const entries = Object.values(corpus.entries).filter((e) => e.reviewStatus === "approved");

  console.log(`\n🏗  Building image index`);
  console.log(`   Provider: ${provider.name} / ${provider.model}`);
  console.log(`   Approved entries: ${entries.length}`);

  // Load existing index for incremental skipping. C2 fix: pass the real model
  // name, not a fake one. loadImageIndex validates model and trusts the stored
  // dimension (C1 fix).
  let index: ImageEmbeddingIndex = loadImageIndex(provider.model) ?? {
    version: 1,
    model: provider.model,
    dimension: 0, // learned from the first embed
    entries: {},
  };

  let embedded = 0, skipped = 0, failed = 0;
  for (const entry of entries) {
    const imgPath = entry.image.path ? fromCorpusRelativeImagePath(entry.image.path) : "";
    if (!imgPath || !existsSync(imgPath)) {
      console.error(`  ⚠  Image not found, skipping: ${entry.id}`);
      failed++;
      continue;
    }
    const imgData = readFileSync(imgPath);
    const hash = hashForImage(imgData);

    // Skip if already indexed and hash unchanged (incremental).
    if (index.entries[entry.id]?.hash === hash) {
      skipped++;
      continue;
    }

    try {
      const vec = await provider.embedImage({ data: imgData, mimeType: "image/png" });
      if (index.dimension === 0) {
        index.dimension = vec.length;
      }
      index.entries[entry.id] = { vector: vec, hash };
      embedded++;
      process.stdout.write(`  ✓ ${entry.id.padEnd(30)} (${embedded})\r`);
    } catch (e) {
      console.error(`\n  ✗ ${entry.id}: ${e instanceof Error ? e.message : e}`);
      failed++;
    }
  }

  if (index.dimension === 0 && embedded === 0 && skipped > 0) {
    // All entries were skipped but dimension was never learned (shouldn't happen
    // with a real index, but guard against it).
    console.error("  ⚠  No new embeddings and dimension unknown — index may be incomplete.");
  }

  saveImageIndex(index);
  console.log(`\n\n  ✓ Embedded: ${embedded}  Skipped: ${skipped}  Failed: ${failed}`);
  console.log(`  ✓ Index: ${Object.keys(index.entries).length} entries, dim=${index.dimension}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
