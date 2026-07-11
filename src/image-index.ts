/**
 * image-index.ts — separate image-embedding index infrastructure.
 *
 * Completely independent from the text embedding index (embeddings.ts / Voyage
 * voyage-4 / corpus/embeddings.json). Lives at corpus/image-embeddings.json
 * with its own model name, dimension validation, and version field.
 *
 * The text index loader rejects any model that isn't "voyage-4" and any
 * dimension that isn't 1024. A different multimodal model would be silently
 * rejected as stale — so this module has its own loader that validates against
 * the index's own model/dimension, not Voyage's.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const IMAGE_INDEX_PATH = join(__dirname, "..", "corpus", "image-embeddings.json");

export interface ImageIndexedEntry {
  vector: number[];
  hash: string; // SHA-256 of the image file bytes — detects content drift
}

export interface ImageEmbeddingIndex {
  version: 1;
  model: string;
  dimension: number;
  entries: Record<string, ImageIndexedEntry>;
}

export interface ImageIndexStatus {
  exists: boolean;
  model: string | null;
  dimension: number | null;
  entryCount: number;
  path: string;
}

/** Check if the image index file exists on disk. */
export function imageIndexExists(): boolean {
  return existsSync(IMAGE_INDEX_PATH);
}

/** Report the current image-index status for UI/diagnostics. */
export function imageIndexStatus(): ImageIndexStatus {
  if (!existsSync(IMAGE_INDEX_PATH)) {
    return { exists: false, model: null, dimension: null, entryCount: 0, path: IMAGE_INDEX_PATH };
  }
  try {
    const raw = JSON.parse(readFileSync(IMAGE_INDEX_PATH, "utf-8"));
    return {
      exists: true,
      model: raw.model ?? null,
      dimension: raw.dimension ?? null,
      entryCount: Object.keys(raw.entries ?? {}).length,
      path: IMAGE_INDEX_PATH,
    };
  } catch {
    return { exists: false, model: null, dimension: null, entryCount: 0, path: IMAGE_INDEX_PATH };
  }
}

/**
 * Load the image index. Returns null if the file doesn't exist or is stale
 * (wrong model/dimension). Never loads or overwrites corpus/embeddings.json.
 */
export function loadImageIndex(expectedModel: string, expectedDimension: number): ImageEmbeddingIndex | null {
  if (!existsSync(IMAGE_INDEX_PATH)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(IMAGE_INDEX_PATH, "utf-8"));
  } catch {
    console.error("[image-index] Failed to parse image-embeddings.json — ignoring.");
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const idx = raw as Partial<ImageEmbeddingIndex>;
  if (idx.version !== 1) {
    console.error(`[image-index] Version mismatch: expected 1, got ${idx.version}. Ignoring.`);
    return null;
  }
  if (idx.model !== expectedModel) {
    console.error(`[image-index] Model mismatch: expected "${expectedModel}", got "${idx.model}". Ignoring.`);
    return null;
  }
  if (idx.dimension !== expectedDimension) {
    console.error(`[image-index] Dimension mismatch: expected ${expectedDimension}, got ${idx.dimension}. Ignoring.`);
    return null;
  }
  return idx as ImageEmbeddingIndex;
}

/** Save the image index atomically. */
export function saveImageIndex(index: ImageEmbeddingIndex): void {
  writeFileSync(IMAGE_INDEX_PATH, JSON.stringify(index, null, 2) + "\n");
}

/** Hash image file bytes to detect content drift. */
export function hashForImage(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Compute cosine similarity between two vectors. */
export function cosine(a: number[], b: number[]): number {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}
