/**
 * Perceptual hashing + near-duplicate detection for the corpus.
 *
 * Extracted from ui-server.ts so CLI scripts (commit-draft, dedup-cleanup)
 * can reuse the dedup gate without importing the HTTP server (which pulls
 * in playwright + tagger + capture). Mirrors the persistence.ts precedent.
 *
 * ─── pHash watch-item (NOT built today) ────────────────────────────────────
 * The capture pipeline's recursive/group-member cropping can produce section
 * captures at slightly different boundaries of the same content — near-dupes
 * at dHash distance 9–15 that dHash structurally misses (gradient-based,
 * resize-sensitive) and DCT-based pHash catches (low-frequency tolerant).
 *
 * Today's corpus has zero such cases (the 90+ duplicate clusters are all
 * byte-identical or d=0 — a gate-bypass bug, not an algorithm failure).
 *
 * TRIGGER: run `npm run dedup-cleanup -- --threshold 15` periodically. If new
 * clusters appear that `--threshold 8` missed, add pHash as a second signal
 * here. The DCT-based pHash (resize 32×32 grayscale → DCT → top-left 8×8
 * excluding DC → median threshold → 64-bit) would layer alongside dHash, not
 * replace it — both signals must agree for a duplicate call.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import sharp from "sharp";
import { CORPUS_ROOT, fromCorpusRelativeImagePath } from "./paths.js";
import type { CorpusEntryT } from "./schema.js";

// ─── dHash (difference hash) ────────────────────────────────────────────────

/**
 * Compute a 64-bit dHash (difference hash) of an image using sharp.
 * Resizes to 9×8 grayscale, compares adjacent horizontal pixels, produces
 * a hex string. Two images of the same page (different scroll/compression)
 * produce hashes that differ by only a few bits.
 */
export async function computeDHash(imagePath: string): Promise<string> {
  const data = await sharp(imagePath)
    .greyscale()
    .resize(9, 8, { fit: "fill" })
    .raw()
    .toBuffer();

  // Compare each pixel with its right neighbor → 64 bits.
  let hash = 0n;
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 8; col++) {
      const left = data[row * 9 + col];
      const right = data[row * 9 + col + 1];
      hash = (hash << 1n) | (BigInt(left > right ? 1 : 0));
    }
  }
  return hash.toString(16).padStart(16, "0");
}

/** Hamming distance between two hex hashes (number of differing bits). */
export function hammingDistance(a: string, b: string): number {
  const bigA = BigInt("0x" + a);
  const bigB = BigInt("0x" + b);
  let xor = bigA ^ bigB;
  let count = 0;
  while (xor) { count += Number(xor & 1n); xor >>= 1n; }
  return count;
}

// <8 bits different out of 64 = near-duplicate. Tuned from corpus data: the
// median distance between random pairs is ~25, and genuine same-shot variants
// (recompression, tiny crops) cluster at 0–7. 8–11 was catching same-*page*
// shots that differ by scroll/layout — too loose, caused false positives. The
// prior "same dimensions" fallback (Level 3) was removed for the same reason.
export const DHASH_THRESHOLD = 8;

// ─── persisted dHash cache (module-private state) ───────────────────────────
// Why: the old check-duplicate path re-read + re-hash EVERY corpus image from
// disk on EACH check (O(n) disk reads per request). For a 200-entry corpus
// during a 100-image bulk import that's 20,000 reads. This cache holds the
// SHA-256 + dHash per entry id, loaded once at startup and rebuilt on mutation.
//
// The Map + loaded flag stay MODULE-PRIVATE — only the functions below touch
// them, so cache state is never a public mutation surface.
const DHASH_CACHE_PATH = resolve(CORPUS_ROOT, ".dhash-cache.json");
export type CachedFingerprint = { hash: string; dhash: string; path: string };
const dhashCache = new Map<string, CachedFingerprint>();
let dhashCacheLoaded = false;

export function loadDHashCache(): void {
  if (dhashCacheLoaded) return;
  dhashCacheLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(DHASH_CACHE_PATH, "utf-8")) as Record<string, CachedFingerprint>;
    for (const [id, fp] of Object.entries(raw)) {
      if (fp && typeof fp.hash === "string" && typeof fp.dhash === "string") dhashCache.set(id, fp);
    }
  } catch { /* missing/corrupt cache — rebuild lazily */ }
}

export function persistDHashCache(): void {
  const obj: Record<string, CachedFingerprint> = {};
  for (const [id, fp] of dhashCache) obj[id] = fp;
  try { writeFileSync(DHASH_CACHE_PATH, JSON.stringify(obj, null, 2), "utf-8"); } catch { /* best-effort */ }
}

/** Recompute fingerprints for every corpus entry with an image. Called on save. */
export async function rebuildDHashCache(entries: CorpusEntryT[]): Promise<void> {
  const next = new Map<string, CachedFingerprint>();
  for (const entry of entries) {
    if (!entry.image.path) continue;
    try {
      const fullPath = fromCorpusRelativeImagePath(entry.image.path);
      if (!existsSync(fullPath)) continue;
      const hash = createHash("sha256").update(readFileSync(fullPath)).digest("hex");
      const dhash = await computeDHash(fullPath).catch(() => "");
      if (dhash) next.set(entry.id, { hash, dhash, path: entry.image.path });
    } catch { /* skip unreadable */ }
  }
  dhashCache.clear();
  for (const [id, fp] of next) dhashCache.set(id, fp);
  persistDHashCache();
}

/** Get a fingerprint for one entry, computing + caching on first access (lazy). */
export async function fingerprintFor(entry: CorpusEntryT): Promise<CachedFingerprint | null> {
  loadDHashCache();
  if (!entry.image.path) return null;
  const cached = dhashCache.get(entry.id);
  if (cached && cached.path === entry.image.path) return cached;
  try {
    const fullPath = fromCorpusRelativeImagePath(entry.image.path);
    if (!existsSync(fullPath)) return null;
    const hash = createHash("sha256").update(readFileSync(fullPath)).digest("hex");
    const dhash = await computeDHash(fullPath).catch(() => "");
    if (!dhash) return null;
    const fp: CachedFingerprint = { hash, dhash, path: entry.image.path };
    dhashCache.set(entry.id, fp);
    persistDHashCache();
    return fp;
  } catch { return null; }
}

/**
 * Commit-time duplicate gate. The client dedups at UPLOAD time (against the
 * corpus + batch siblings), but that check can go stale: a sibling committed
 * between stage and commit, a prior batch left a near-identical shot, or the
 * batch tracking missed a case. The commit endpoint is the single point where
 * the corpus actually mutates, so this is the authoritative gate.
 *
 * Computes the incoming image's SHA-256 + dHash and compares against every
 * committed entry. Returns the matched entry id + type, or null if unique.
 * Uses the same dhash cache + threshold as /api/check-duplicate for consistency.
 */
export async function findDuplicateAtCommit(
  entry: CorpusEntryT,
  entries: CorpusEntryT[],
): Promise<{ match: string; type: "exact" | "near" } | null> {
  if (!entry.image.path) return null;
  const fullPath = fromCorpusRelativeImagePath(entry.image.path);
  if (!existsSync(fullPath)) return null; // can't fingerprint a missing image
  const incomingHash = createHash("sha256").update(readFileSync(fullPath)).digest("hex");
  // dHash can fail on unusual/encoded PNGs (sharp's libpng); the exact SHA-256
  // check must still run, so don't bail when dHash is unavailable — just skip
  // the near-dup comparison for that image.
  const incomingDhash = await computeDHash(fullPath).catch(() => "");
  loadDHashCache();
  for (const existing of entries) {
    if (existing.id === entry.id) continue; // self (PUT path)
    if (!existing.image.path) continue;
    const fp = await fingerprintFor(existing);
    if (!fp) continue;
    if (fp.hash === incomingHash) return { match: existing.id, type: "exact" };
    if (incomingDhash && fp.dhash && hammingDistance(incomingDhash, fp.dhash) < DHASH_THRESHOLD) return { match: existing.id, type: "near" };
  }
  return null;
}
