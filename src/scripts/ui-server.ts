#!/usr/bin/env node
import "../env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns";
import sharp from "sharp";
import { imageSize } from "image-size";
import { chromium } from "playwright";
import { Corpus, CorpusEntry, Category, StyleTag, PatternType, SpacingDensity, CornerStyle, ImageVisibility, findDraftMarkers, type CorpusEntryT } from "../schema.js";
import { CORPUS_ROOT, PRIVATE_IMAGE_DIR, PROJECT_ROOT, fromCorpusRelativeImagePath, toCorpusRelativePath } from "../paths.js";
import { tagImage, generateCritique } from "../tagger.js";
import { getEnvStatus, type EnvStatus } from "../env.js";

const PORT = Number(process.env.CLEAN_UI_PORT ?? 3131);
const ENTRIES_PATH = resolve(CORPUS_ROOT, "entries.json");
const APP_PATH = resolve(PROJECT_ROOT, "index-2.html");
const MAX_BODY_BYTES = 20 * 1024 * 1024;

// ─── perceptual hashing (dHash) for near-duplicate detection ─────────────────

/**
 * Compute a 64-bit dHash (difference hash) of an image using sharp.
 * Resizes to 9×8 grayscale, compares adjacent horizontal pixels, produces
 * a hex string. Two images of the same page (different scroll/compression)
 * produce hashes that differ by only a few bits.
 */
async function computeDHash(imagePath: string): Promise<string> {
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
function hammingDistance(a: string, b: string): number {
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
const DHASH_THRESHOLD = 8;

// ─── durability: atomic writes + rolling snapshots ──────────────────────────
// Why this exists: a single `git checkout -- entries.json` or a buggy overwrite
// used to be enough to lose every entry the UI had committed but not yet pushed.
// The fixes below make that class of loss recoverable WITHOUT a database:
//   1. Atomic write: serialize to a temp file, fs.rename over the real one. A
//      crash mid-write (or a half-written buffer) leaves the prior file intact.
//   2. Rolling snapshots: every save also keeps the last N versions plus a
//      timestamped copy in corpus/.snapshots/ (gitignored). loadEntries falls
//      back to the newest snapshot if the primary file is missing or corrupt,
//      so a bad overwrite or a destructive git command is fully recoverable.
const SNAPSHOT_DIR = resolve(CORPUS_ROOT, ".snapshots");
const SNAPSHOT_KEEP = 20; // keep the 20 most recent timestamped snapshots

/** Return snapshot paths newest-first (by mtime), or [] if none. */
function listSnapshots(): string[] {
  try {
    return readdirSync(SNAPSHOT_DIR)
      .filter((f) => /^entries-\d+\.json$/.test(f))
      .map((f) => resolve(SNAPSHOT_DIR, f))
      .sort((a, b) => {
        // entries-<epoch>.json — sort by the embedded epoch, desc.
        const ta = Number(a.match(/entries-(\d+)\.json$/)?.[1] ?? 0);
        const tb = Number(b.match(/entries-(\d+)\.json$/)?.[1] ?? 0);
        return tb - ta;
      });
  } catch { return []; }
}

/** Parse a JSON corpus file, or null if missing/corrupt/unparseable. */
function tryReadCorpus(path: string): CorpusEntryT[] | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8"));
    return Corpus.parse(raw).entries;
  } catch { return null; }
}

function loadEntries(): CorpusEntryT[] {
  // Primary file first.
  const primary = tryReadCorpus(ENTRIES_PATH);
  if (primary) return primary;
  // Primary missing/corrupt — fall back to the newest snapshot so the workbench
  // stays usable and committed data survives a bad overwrite or git checkout.
  for (const snap of listSnapshots()) {
    const recovered = tryReadCorpus(snap);
    if (recovered) {
      console.error(`[corpus] entries.json unreadable — recovered ${recovered.length} entries from ${snap}. Restoring primary.`);
      // Restore the primary from the snapshot so subsequent reads are clean.
      try { writeAtomic(ENTRIES_PATH, `${JSON.stringify({ version: 2, entries: recovered }, null, 2)}\n`); } catch { /* best-effort */ }
      return recovered;
    }
  }
  // No primary, no snapshot — start empty (fresh corpus) rather than crash.
  console.error("[corpus] entries.json unreadable and no snapshots found — starting empty.");
  return [];
}

/** Write `content` to `path` atomically: temp file + rename. */
function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content, "utf-8");
  renameSync(tmp, path); // atomic on POSIX and Windows
}

/** Keep a rolling timestamped snapshot of the corpus. */
function writeSnapshot(entries: CorpusEntryT[]): void {
  try {
    mkdirSync(SNAPSHOT_DIR, { recursive: true });
    const stamped = resolve(SNAPSHOT_DIR, `entries-${Date.now()}.json`);
    writeAtomic(stamped, `${JSON.stringify({ version: 2, entries }, null, 2)}\n`);
    // Prune to the most recent SNAPSHOT_KEEP.
    const all = listSnapshots();
    if (all.length > SNAPSHOT_KEEP) {
      try { for (const stale of all.slice(SNAPSHOT_KEEP)) unlinkSync(stale); } catch { /* best-effort */ }
    }
  } catch (err) {
    console.error("[corpus] snapshot write failed (non-fatal):", err instanceof Error ? err.message : err);
  }
}

function saveEntries(entries: CorpusEntryT[]): void {
  const corpus = Corpus.parse({ version: 2, entries });
  // Snapshot BEFORE the overwrite, so even a failure mid-write leaves the
  // prior state recoverable. Then atomic-write the primary.
  writeSnapshot(entries);
  writeAtomic(ENTRIES_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
  // The corpus changed — rebuild the dHash cache so stale/removed entries don't
  // poison future duplicate checks, and new entries are matched immediately.
  void rebuildDHashCache(entries);
}

// ─── persisted dHash cache ───────────────────────────────────────────────────
// Why: the old check-duplicate path re-read + re-hash EVERY corpus image from
// disk on EACH check (O(n) disk reads per request). For a 200-entry corpus
// during a 100-image bulk import that's 20,000 reads. This cache holds the
// SHA-256 + dHash per entry id, loaded once at startup and rebuilt on mutation.
const DHASH_CACHE_PATH = resolve(CORPUS_ROOT, ".dhash-cache.json");
type CachedFingerprint = { hash: string; dhash: string; path: string };
const dhashCache = new Map<string, CachedFingerprint>();
let dhashCacheLoaded = false;

function loadDHashCache(): void {
  if (dhashCacheLoaded) return;
  dhashCacheLoaded = true;
  try {
    const raw = JSON.parse(readFileSync(DHASH_CACHE_PATH, "utf-8")) as Record<string, CachedFingerprint>;
    for (const [id, fp] of Object.entries(raw)) {
      if (fp && typeof fp.hash === "string" && typeof fp.dhash === "string") dhashCache.set(id, fp);
    }
  } catch { /* missing/corrupt cache — rebuild lazily */ }
}

function persistDHashCache(): void {
  const obj: Record<string, CachedFingerprint> = {};
  for (const [id, fp] of dhashCache) obj[id] = fp;
  try { writeFileSync(DHASH_CACHE_PATH, JSON.stringify(obj, null, 2), "utf-8"); } catch { /* best-effort */ }
}

/** Recompute fingerprints for every corpus entry with an image. Called on save. */
async function rebuildDHashCache(entries: CorpusEntryT[]): Promise<void> {
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
async function fingerprintFor(entry: CorpusEntryT): Promise<CachedFingerprint | null> {
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

// ─── in-batch dedup ──────────────────────────────────────────────────────────
// Bulk import used to check each upload only against the COMMITTED corpus, so
// the first near-dup passed (corpus had none) and so did the second (the first
// was merely staged). This map tracks sibling uploads within one bulk run so a
// later upload in the SAME batch is matched against earlier ones too.
// Keyed by batchId; each value is an ordered list of {hash, dhash, filename}.
const batchFingerprints = new Map<string, Array<{ hash: string; dhash: string; filename: string }>>();

function registerBatchFingerprint(batchId: string, fp: { hash: string; dhash: string; filename: string }): void {
  const list = batchFingerprints.get(batchId);
  if (list) list.push(fp); else batchFingerprints.set(batchId, [fp]);
}
function clearBatch(batchId: string): void { batchFingerprints.delete(batchId); }

/**
 * Local-origin guard.
 *
 * The curator app is served by this same server and accessed at
 * http://localhost:PORT. No cross-origin caller (another website open in a
 * browser tab, a remote script, etc.) has any legitimate reason to call these
 * endpoints — several of them mutate the corpus on disk or launch a browser.
 *
 * We therefore send NO `Access-Control-Allow-Origin` header by default. A
 * cross-origin browser fetch will be blocked from reading the response by the
 * same-origin policy, and we additionally reject mutations whose Origin is not
 * the app itself. This turns the previous `allow: *` into a closed surface.
 */
export function sameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients (curl, node fetch) have no Origin
  const host = req.headers.host;
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const body = await readBody(req);
  return body ? JSON.parse(body) : {};
}

function parseUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? `localhost:${PORT}`}`);
}

function entryIssues(error: unknown): string[] {
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: Array<{ path: Array<string | number>; message: string }> }).issues.map(
      (issue) => `${issue.path.join(".") || "entry"}: ${issue.message}`,
    );
  }
  return [error instanceof Error ? error.message : String(error)];
}

export function validateEntryPayload(payload: unknown): CorpusEntryT {
  const result = CorpusEntry.safeParse(payload);
  if (!result.success) {
    throw Object.assign(new Error("Entry validation failed"), { issues: result.error.issues });
  }
  // Draft-hygiene gate: reject entries carrying [DRAFT]/[PLACEHOLDER]/[TODO]
  // markers anywhere in their text fields. Uses the centralized check so the
  // rule is identical to validate-corpus and commit-draft.
  const dirty = findDraftMarkers(result.data);
  if (dirty.length) {
    throw Object.assign(new Error("Entry contains draft markers"), {
      issues: dirty.map((f) => ({ path: [f], message: `remove the [DRAFT]/[PLACEHOLDER]/[TODO] marker from ${f} before saving` })),
    });
  }
  return result.data;
}

function imageRequiredForNewEntry(payload: unknown): void {
  if (
    !payload ||
    typeof payload !== "object" ||
    !("image" in payload) ||
    !payload.image ||
    typeof payload.image !== "object" ||
    !("path" in payload.image) ||
    typeof payload.image.path !== "string" ||
    payload.image.path.trim() === ""
  ) {
    throw Object.assign(new Error("New app-created entries must include a captured or uploaded screenshot."), {
      issues: [{ path: ["image", "path"], message: "Capture or upload a screenshot before saving." }],
    });
  }
}

function stats(entries: CorpusEntryT[]) {
  const avgQuality = entries.length
    ? entries.reduce((sum, entry) => sum + entry.qualityScore, 0) / entries.length
    : 0;
  return {
    total: entries.length,
    avgQuality,
    withImages: entries.filter((entry) => !!entry.image.path).length,
    publicImages: entries.filter((entry) => entry.image.visibility !== "private").length,
    privateImages: entries.filter((entry) => entry.image.visibility === "private" && !!entry.image.path).length,
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "sample";
}

export function uniqueEntryId(entry: { id?: string; title?: string; source?: { productName?: string } }, entries: CorpusEntryT[]): string {
  const existingIds = new Set(entries.map((candidate) => candidate.id));
  const base = slugify(entry.id || `${entry.source?.productName ?? ""}-${entry.title ?? ""}`);
  let id = base;
  let counter = 2;
  while (existingIds.has(id)) {
    id = `${base}-${counter}`;
    counter++;
  }
  return id;
}

export function prepareNewEntryPayload(payload: unknown, entries: CorpusEntryT[]): CorpusEntryT {
  imageRequiredForNewEntry(payload);
  const raw = { ...(payload as Record<string, unknown>) };
  raw.id = uniqueEntryId(raw as { id?: string; title?: string; source?: { productName?: string } }, entries);
  return validateEntryPayload(raw);
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
export async function findDuplicateAtCommit(entry: CorpusEntryT, entries: CorpusEntryT[]): Promise<{ match: string; type: "exact" | "near" } | null> {
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

export function orphanedPrivateImagePaths(files: string[], entries: CorpusEntryT[]): string[] {
  const referenced = new Set(
    entries
      .map((entry) => entry.image.path)
      .filter((path): path is string => !!path && path.startsWith("images-private/")),
  );
  return files
    .filter((path) => path.startsWith("images-private/"))
    .filter((path) => !referenced.has(path))
    .sort();
}

function privateImagePaths(): string[] {
  if (!existsSync(PRIVATE_IMAGE_DIR)) return [];
  return readdirSync(PRIVATE_IMAGE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => `images-private/${entry.name}`);
}

function explainCaptureError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/Timeout/i.test(message)) {
    return "Capture timed out. The page may require login, keep network requests open, or be blocked by a cookie/CAPTCHA wall.";
  }
  if (/Executable doesn't exist|browserType.launch/i.test(message)) {
    return "Chromium is not installed for Playwright. Run `npx playwright install chromium`, then restart the app.";
  }
  return message || "URL capture failed";
}

function explainTagError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|invalid_api_key|Incorrect API key/i.test(message)) return "The vision provider rejected the API key. Check your .env keys and restart the app.";
  if (/429|rate_limit|quota|RESOURCE_EXHAUSTED/i.test(message)) return "Vision provider rate limit or quota was reached. Try again later or use another key.";
  // Specific Gemini/OpenAI stop causes — surface these before the broad model
  // check, since a truncated JSON shows up as non-JSON and got mislabeled as a
  // generic "unusable draft" (the actual cause was MAX_TOKENS truncation).
  if (/MAX_TOKENS|truncat/i.test(message)) return "The response was truncated before the JSON finished. The model's output cap is too low for this screenshot — raise MAX_OUTPUT_TOKENS in src/tagger.ts.";
  if (/SAFETY|blocked the request|blockReason/i.test(message)) return "The vision provider blocked this image (safety filter). Try a different screenshot.";
  if (/stopped early/i.test(message)) return message; // already user-facing, includes the finishReason
  if (/models\/.+is not found|model.*not found|not supported|unsupported/i.test(message)) return "The vision model was rejected. Check the model name in .env and restart the app.";
  if (/non-JSON/i.test(message)) return "The vision provider returned an unusable draft. Try Auto-fill again, or use a clearer screenshot.";
  return message || "Auto-fill failed";
}

export function publicConfigStatus(status: EnvStatus = getEnvStatus()) {
  const anyVisionKey = status.openaiKeyConfigured || status.anthropicKeyConfigured || status.geminiKeyConfigured;
  // Resolve the effective provider + model for each pass (mirrors tagger.resolveProvider).
  const extractionProvider = process.env.AUTO_TAG_PROVIDER_EXTRACTION ?? process.env.AUTO_TAG_PROVIDER ?? "openai";
  const critiqueProvider = process.env.AUTO_TAG_PROVIDER_CRITIQUE ?? process.env.AUTO_TAG_PROVIDER ?? "openai";
  const extractionModel = extractionProvider === "claude" ? (process.env.CLAUDE_AUTO_TAG_MODEL ?? "claude-haiku-4-5")
    : extractionProvider === "gemini" ? (process.env.GEMINI_AUTO_TAG_MODEL ?? "gemini-2.5-flash")
    : (process.env.OPENAI_AUTO_TAG_MODEL ?? "gpt-5.4-nano");
  const critiqueModel = critiqueProvider === "claude" ? (process.env.CLAUDE_AUTO_TAG_MODEL ?? "claude-haiku-4-5")
    : critiqueProvider === "gemini" ? (process.env.GEMINI_AUTO_TAG_MODEL ?? "gemini-2.5-flash")
    : (process.env.OPENAI_AUTO_TAG_MODEL ?? "gpt-5.4-nano");
  return {
    openaiKeyConfigured: status.openaiKeyConfigured,
    anthropicKeyConfigured: status.anthropicKeyConfigured,
    geminiKeyConfigured: status.geminiKeyConfigured,
    visionKeyConfigured: anyVisionKey,
    autoTagProvider: status.autoTagProvider,
    extractionProvider,
    critiqueProvider,
    extractionModel,
    critiqueModel,
    voyageKeyConfigured: status.voyageKeyConfigured,
    openaiAutoTagModel: status.openaiAutoTagModel,
    cleanUiPort: status.cleanUiPort,
    envFileLoaded: status.envFileLoaded,
  };
}

function mimeFor(path: string): string {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  return "image/jpeg";
}

/**
 * Reject URL-capture targets that point at private, loopback, link-local, or
 * cloud-metadata addresses. The capture route launches a real browser on the
 * operator's machine using their network, so without this check any web page
 * open in a tab could ask the curator to screenshot internal services or
 * http://169.254.169.254/... and read the resulting file path back.
 *
 * Resolves the hostname and inspects every resolved address. Rejects if any
 * resolved address is non-public. Allows non-browser local clients to keep
 * working on localhost targets (the common dev case) by whitelisting
 * `localhost`/`127.0.0.1` hostnames explicitly when the request has no
 * cross-origin Origin.
 */
export function isPrivateAddress(ip: string): boolean {
  // IPv4
  if (/^(10\.|192\.168\.|169\.254\.)/.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^127\./.test(ip)) return true;
  if (/^0\./.test(ip)) return true;
  // IPv6
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  return false;
}

async function assertSafeCaptureTarget(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Use a valid source URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http and https URLs can be captured");
  }
  // Cloud-metadata hostname is a known SSRF target regardless of DNS.
  const md = /metadata\.google\.internal|169\.254\.169\.254/i;
  if (md.test(parsed.hostname)) {
    throw new Error("Capture target resolves to a blocked metadata or private address");
  }
  // Explicit localhost hostname is the common dev case — allow it.
  const explicitLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(parsed.hostname);
  if (!explicitLocal) {
    await new Promise<void>((resolveCheck, rejectCheck) => {
      lookup(parsed.hostname, { all: true }, (err, addresses) => {
        if (err) {
          rejectCheck(new Error(`Could not resolve host: ${parsed.hostname}`));
          return;
        }
        const bad = addresses.map((a) => a.address).find(isPrivateAddress);
        if (bad) {
          rejectCheck(new Error("Capture target resolves to a blocked metadata or private address"));
          return;
        }
        resolveCheck();
      });
    });
  }
  return parsed;
}

async function handleUpload(req: IncomingMessage, res: ServerResponse) {
  const payload = await readJson(req) as {
    filename?: string;
    dataUrl?: string;
    slug?: string;
  };

  if (!payload.dataUrl || !payload.filename) {
    sendJson(res, 400, { error: "filename and dataUrl are required" });
    return;
  }

  const match = payload.dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|webp));base64,(.+)$/);
  if (!match) {
    sendJson(res, 400, { error: "Only PNG, JPEG, and WebP images are supported" });
    return;
  }

  mkdirSync(PRIVATE_IMAGE_DIR, { recursive: true });
  const originalExt = extname(payload.filename).toLowerCase();
  const ext = [".png", ".jpg", ".jpeg", ".webp"].includes(originalExt) ? originalExt : ".png";
  const base = slugify(payload.slug || payload.filename.replace(/\.[^.]+$/, ""));
  let absolutePath = resolve(PRIVATE_IMAGE_DIR, `${base}${ext}`);
  let counter = 2;
  while (existsSync(absolutePath)) {
    absolutePath = resolve(PRIVATE_IMAGE_DIR, `${base}-${counter}${ext}`);
    counter++;
  }

  const data = Buffer.from(match[2], "base64");
  writeFileSync(absolutePath, data);
  const dimensions = imageSize(data);
  const hash = createHash("sha256").update(data).digest("hex");
  let dhash = "";
  try { dhash = await computeDHash(absolutePath); } catch { /* sharp may fail on tiny/invalid images */ }

  sendJson(res, 201, {
    path: toCorpusRelativePath(absolutePath),
    width: dimensions.width ?? null,
    height: dimensions.height ?? null,
    visibility: "private",
    hash,
    dhash,
  });
}

async function handleCaptureUrl(req: IncomingMessage, res: ServerResponse) {
  const payload = await readJson(req) as {
    url?: string;
    slug?: string;
    width?: number;
    height?: number;
  };

  if (!payload.url) {
    sendJson(res, 400, { error: "url is required" });
    return;
  }

  let sourceUrl: URL;
  try {
    sourceUrl = await assertSafeCaptureTarget(payload.url);
  } catch (error) {
    sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid source URL" });
    return;
  }

  mkdirSync(PRIVATE_IMAGE_DIR, { recursive: true });
  const base = slugify(payload.slug || sourceUrl.hostname);
  let absolutePath = resolve(PRIVATE_IMAGE_DIR, `${base}.png`);
  let counter = 2;
  while (existsSync(absolutePath)) {
    absolutePath = resolve(PRIVATE_IMAGE_DIR, `${base}-${counter}.png`);
    counter++;
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({
      viewport: {
        width: Math.min(1920, Math.max(800, Number(payload.width) || 1440)),
        height: Math.min(1600, Math.max(600, Number(payload.height) || 1000)),
      },
      deviceScaleFactor: 1,
    });
    await page.goto(sourceUrl.toString(), { waitUntil: "networkidle", timeout: 45_000 });
    await page.screenshot({ path: absolutePath, fullPage: false });
  } finally {
    await browser.close();
  }

  const data = readFileSync(absolutePath);
  const dimensions = imageSize(data);
  sendJson(res, 201, {
    path: toCorpusRelativePath(absolutePath),
    width: dimensions.width ?? null,
    height: dimensions.height ?? null,
    visibility: "private",
  });
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const entries = loadEntries();

  if (req.method === "GET" && url.pathname === "/api/schema") {
    sendJson(res, 200, {
      categories: Category.options,
      styleTags: StyleTag.options,
      patternTypes: PatternType.options,
      spacingDensities: SpacingDensity.options,
      cornerStyles: CornerStyle.options,
      imageVisibilities: ImageVisibility.options,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/config") {
    sendJson(res, 200, publicConfigStatus());
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/entries") {
    sendJson(res, 200, { entries });
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    sendJson(res, 200, stats(entries));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/image") {
    const path = url.searchParams.get("path");
    if (!path) {
      sendText(res, 400, "Missing image path");
      return;
    }
    try {
      const fullPath = fromCorpusRelativeImagePath(path);
      if (!existsSync(fullPath)) {
        sendText(res, 404, "Image not found");
        return;
      }
      res.writeHead(200, { "content-type": mimeFor(fullPath), "cache-control": "no-store" });
      res.end(readFileSync(fullPath));
    } catch (error) {
      sendText(res, 400, error instanceof Error ? error.message : "Invalid image path");
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/upload-image") {
    await handleUpload(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/check-duplicate") {
    const payload = await readJson(req) as { hash?: string; dhash?: string; width?: number; height?: number; path?: string; batchId?: string; filename?: string };
    const newHash = payload.hash ?? "";
    const newDhash = payload.dhash ?? "";
    const batchId = payload.batchId ?? "";

    let exactMatch: string | null = null;
    let nearMatch: string | null = null;
    let batchMatch: string | null = null;

    // ── Level 1 + 2 against the committed corpus (cache-backed, no per-image re-reads).
    // Two signals only: exact SHA-256, and perceptual dHash (Hamming < threshold).
    // Dimensions are NOT evidence (two unrelated full-viewport shots share them).
    for (const entry of entries) {
      if (!entry.image.path) continue;
      const fp = await fingerprintFor(entry);
      if (!fp) continue;
      if (fp.hash === newHash) { exactMatch = entry.id; break; }
      if (!nearMatch && newDhash && hammingDistance(newDhash, fp.dhash) < DHASH_THRESHOLD) {
        nearMatch = entry.id;
      }
    }

    // ── Level 3: in-batch dedup. Compare against siblings already staged in the
    // SAME bulk run. This is the fix for "near-dups went through" — the old code
    // only saw the committed corpus, so the 2nd..Nth near-dup in a batch all
    // passed because the 1st was merely staged, not committed.
    if (!exactMatch && !nearMatch && batchId) {
      const siblings = batchFingerprints.get(batchId) ?? [];
      for (const sib of siblings) {
        if (newHash && sib.hash === newHash) { batchMatch = sib.filename; break; }
        if (newDhash && hammingDistance(newDhash, sib.dhash) < DHASH_THRESHOLD) { batchMatch = sib.filename; break; }
      }
    }

    // If this upload is unique, register it so later siblings in the same batch
    // can match against it. (Only when a batchId is supplied — single-entry flow
    // passes none and skips batch dedup entirely.)
    if (!exactMatch && !nearMatch && !batchMatch && batchId && newHash && payload.filename) {
      registerBatchFingerprint(batchId, { hash: newHash, dhash: newDhash, filename: payload.filename });
    }

    if (exactMatch) {
      sendJson(res, 200, { duplicate: true, type: "exact", match: exactMatch });
    } else if (nearMatch) {
      sendJson(res, 200, { duplicate: true, type: "near", match: nearMatch });
    } else if (batchMatch) {
      sendJson(res, 200, { duplicate: true, type: "batch-near", match: batchMatch });
    } else {
      sendJson(res, 200, { duplicate: false, type: null, match: null });
    }
    return;
  }

  // Clear the in-batch fingerprint set when a bulk run ends (client signals it).
  if (req.method === "POST" && url.pathname === "/api/check-duplicate/clear-batch") {
    const payload = await readJson(req) as { batchId?: string };
    if (payload.batchId) clearBatch(payload.batchId);
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/capture-url") {
    try {
      await handleCaptureUrl(req, res);
    } catch (error) {
      sendJson(res, 400, { error: explainCaptureError(error) });
    }
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/orphans") {
    const orphans = orphanedPrivateImagePaths(privateImagePaths(), entries);
    sendJson(res, 200, { orphans, count: orphans.length });
    return;
  }

  if (req.method === "DELETE" && url.pathname === "/api/orphans") {
    const orphans = orphanedPrivateImagePaths(privateImagePaths(), entries);
    for (const path of orphans) {
      unlinkSync(fromCorpusRelativeImagePath(path));
    }
    sendJson(res, 200, { deleted: orphans, count: orphans.length });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auto-tag") {
    const payload = await readJson(req) as {
      imagePath?: string;
      productName?: string;
      url?: string | null;
      id?: string;
      imageDetail?: "low" | "high";
      extractionOnly?: boolean;
    };

    if (!payload.imagePath) {
      sendJson(res, 400, { error: "imagePath is required" });
      return;
    }

    if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
      sendJson(res, 400, { error: "No vision provider key set. Add OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY to .env, then restart npm run ui." });
      return;
    }

    try {
      const imagePath = fromCorpusRelativeImagePath(payload.imagePath);
      const entry = await tagImage({
        imagePath,
        // productName is optional — when absent/empty, the tagger has the vision
        // model read the product name off the screenshot. A missing name must
        // not block import: the upload (expensive) has already happened.
        productName: (payload.productName || "").trim(),
        url: payload.url || null,
        id: payload.id,
        // Bulk passes imageDetail:"low" + extractionOnly:true to cut token cost:
        // cheap extraction pass now, critique deferred to /api/auto-critique.
        imageDetail: payload.imageDetail,
        extractionOnly: payload.extractionOnly === true,
      });
      sendJson(res, 200, { entry });
    } catch (error) {
      sendJson(res, 400, { error: explainTagError(error) });
    }
    return;
  }

  // Deferred Pass 2: fills critique/steals/antiPatterns on a row staged
  // extraction-only. No image re-sent — Pass 2 reasons from the saved extraction.
  if (req.method === "POST" && url.pathname === "/api/auto-critique") {
    const payload = await readJson(req) as { productName?: string; extraction?: Record<string, unknown> };

    if (!payload.extraction) {
      sendJson(res, 400, { error: "extraction is required (pass the entry's _raw.extraction)" });
      return;
    }
    if (!process.env.OPENAI_API_KEY && !process.env.ANTHROPIC_API_KEY && !process.env.GEMINI_API_KEY) {
      sendJson(res, 400, { error: "No vision provider key set. Add OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY to .env, then restart npm run ui." });
      return;
    }

    try {
      const result = await generateCritique((payload.productName || "").trim(), payload.extraction);
      sendJson(res, 200, { critique: result });
    } catch (error) {
      sendJson(res, 400, { error: explainTagError(error) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/entries") {
    try {
      const entry = prepareNewEntryPayload(await readJson(req), entries);
      // Commit-time dedup gate — the authoritative check. The client dedups at
      // upload, but the corpus can change between stage and commit, and batch
      // tracking isn't bulletproof. Reject here with 409 so the client can mark
      // the row as a duplicate rather than a generic error.
      const dup = await findDuplicateAtCommit(entry, entries);
      if (dup) {
        sendJson(res, 409, { error: `Duplicate image (${dup.type}) of an existing entry: ${dup.match}`, duplicate: true, type: dup.type, match: dup.match });
        return;
      }
      saveEntries([...entries, entry]);
      sendJson(res, 201, { entry });
    } catch (error) {
      sendJson(res, 400, { error: "Entry validation failed", issues: entryIssues(error) });
    }
    return;
  }

  const entryMatch = url.pathname.match(/^\/api\/entries\/([^/]+)$/);
  if (entryMatch) {
    const id = decodeURIComponent(entryMatch[1]);
    const index = entries.findIndex((entry) => entry.id === id);
    if (index === -1) {
      sendJson(res, 404, { error: `Entry not found: ${id}` });
      return;
    }

    if (req.method === "PUT") {
      try {
        const entry = validateEntryPayload(await readJson(req));
        if (entry.id !== id) {
          sendJson(res, 400, { error: "Entry id cannot be changed during update" });
          return;
        }
        entries[index] = entry;
        saveEntries(entries);
        sendJson(res, 200, { entry });
      } catch (error) {
        sendJson(res, 400, { error: "Entry validation failed", issues: entryIssues(error) });
      }
      return;
    }

    if (req.method === "DELETE") {
      entries.splice(index, 1);
      saveEntries(entries);
      sendJson(res, 200, { ok: true });
      return;
    }
  }

  sendJson(res, 404, { error: "Not found" });
}

const server = createServer(async (req, res) => {
  try {
    // Same-origin guard. The app is served from this server; no legitimate
    // caller is cross-origin. A missing Origin (non-browser clients) is allowed
    // through; a present-but-mismatched Origin is rejected.
    if (!sameOrigin(req)) {
      // For CORS preflight from a disallowed origin, respond 204 with no
      // ACAO header — the browser will not permit the actual request.
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      sendJson(res, 403, { error: "Cross-origin requests are not allowed" });
      return;
    }

    // Same-origin preflight: allow the methods/headers the app actually uses.
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": `http://${req.headers.host}`,
        "access-control-allow-methods": "GET,POST,PUT,DELETE,OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      });
      res.end();
      return;
    }

    const url = parseUrl(req);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index-2.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(APP_PATH, "utf-8"));
      return;
    }

    sendText(res, 404, "Not found");
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error instanceof Error ? error.message : "Internal server error" });
  }
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Eagerly load the dHash cache so the first duplicate check doesn't pay the
  // rehash cost. Rebuilds async if missing/stale; non-blocking.
  loadDHashCache();

  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. The curator may already be running at http://localhost:${PORT}.`);
      console.error(`Stop the old process or set CLEAN_UI_PORT in .env to use another port.`);
      process.exit(1);
    }
    throw error;
  });

  // Bind to the IPv6 wildcard so the listener accepts BOTH stacks — ::1 AND
  // 127.0.0.1 (via IPv4-mapped addresses, since ipv6only defaults to false).
  // Pinning 127.0.0.1 caused "page won't load" on hosts where the browser
  // resolves localhost to ::1 first and gets connection-refused with no IPv4
  // fallback. Outbound SSRF protection (the corpus's own guard) is unaffected.
  server.listen(PORT, "::", () => {
    console.log(`clean-ui curator running at http://localhost:${PORT}`);
  });
}
