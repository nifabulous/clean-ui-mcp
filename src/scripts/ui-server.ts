#!/usr/bin/env node
import "../env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, unlinkSync, readdirSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
// SSRF guard extracted to ../ssrf.ts (shared with the CLI capture path).
// The dns.lookup import that lived here previously moved with it.
import sharp from "sharp";
import { imageSize } from "image-size";
import { chromium } from "playwright";
import { Corpus, CorpusEntry, Category, StyleTag, Component, DomainTag, PatternType, SpacingDensity, CornerStyle, ImageVisibility, BusinessGoal, findDraftMarkers, type CorpusEntryT } from "../schema.js";
import { CORPUS_ROOT, PRIVATE_IMAGE_DIR, PROJECT_ROOT, fromCorpusRelativeImagePath, listImageFilesRecursive, toCorpusRelativePath } from "../paths.js";
import { checkDuplicateUpload, clearDuplicateBatch, computeDHash, loadDHashCache, rebuildDHashCache, findDuplicateAtCommit } from "../dedup.js";
import { tagImage, generateCritique, hasVisionKey, hasCritiqueKey, activeModelName, activeProviderName } from "../tagger.js";
import type { CaptureMeta, DomSignals } from "./capture.js";
import { captureCandidatesForSource, isAllowedByRobots } from "./capture.js";
import { getEnvStatus, type EnvStatus } from "../env.js";
import {
  ENTRIES_PATH, SNAPSHOT_DIR, SNAPSHOT_KEEP,
  listSnapshots, tryReadCorpus, loadCorpusSafe, writeAtomic, writeSnapshot,
} from "../persistence.js";

const PORT = Number(process.env.CLEAN_UI_PORT ?? 3131);
const APP_PATH = resolve(PROJECT_ROOT, "index-2.html");
const STATIC_DIR = resolve(PROJECT_ROOT, "ui"); // extracted CSS/JS lives here
const MAX_BODY_BYTES = 20 * 1024 * 1024;

// ─── perceptual hashing (dHash) + duplicate detection ───────────────────────
// Dedup policy lives in ../dedup.ts so HTTP, CLI commit, and cleanup tools share
// one threshold/cache/batch registry. This file only owns request/response glue.

// ─── durability: atomic writes + rolling snapshots ──────────────────────────
// The disk primitives (writeAtomic, writeSnapshot, listSnapshots, tryReadCorpus,
// loadCorpusSafe) live in ../persistence.ts. These thin wrappers keep the
// dHash-cache coupling local to the running UI server.

/** Load entries with snapshot fallback (delegates to persistence.loadCorpusSafe). */
function loadEntries(): CorpusEntryT[] {
  return loadCorpusSafe();
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

// ─── provider allowlist (shared by auto-tag, auto-critique, auto-retag) ──────
// Must include "minimax" — the auto-retag handler previously omitted it,
// silently dropping a UI-selected MiniMax critique provider.
const VALID_PROVIDERS = ["openai", "claude", "gemini", "mistral", "minimax"] as const;
type ValidProvider = (typeof VALID_PROVIDERS)[number];

function parseProvider(v: unknown): ValidProvider | undefined {
  return typeof v === "string" && (VALID_PROVIDERS as readonly string[]).includes(v) ? v as ValidProvider : undefined;
}

/**
 * Stamp provenance with an auto-tag timestamp, preserving ALL existing fields
 * (especially capture metadata and reviewedBy). Fixes the line-1203 bug where
 * `entry.provenance = { taggedBy, reviewedBy }` wiped capture on PUT.
 *
 * Semantics:
 *   - POST /api/entries (new auto entry): taggedBy="auto", taggedAt=today
 *   - POST /api/auto-retag (re-tag): taggedBy stays "auto", taggedAt=today
 *   - PUT /api/entries/:id (human edit): flips to auto-reviewed, does NOT advance taggedAt
 */
export function stampProvenance(
  entry: CorpusEntryT,
  today: string,
  mode: "auto" | "auto-reviewed",
  opts: { advanceTaggedAt?: boolean } = {},
): void {
  const prior = entry.provenance;
  entry.provenance = {
    taggedBy: mode,
    // Preserve existing capture + reviewedBy — never replace.
    capture: prior?.capture,
    reviewedBy: prior?.reviewedBy,
    // Advance taggedAt only on auto-tag/retag/new auto-reviewed save, NOT on later human edits.
    taggedAt: mode === "auto" || opts.advanceTaggedAt ? today : prior?.taggedAt,
  };
}

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

// Server-side draft-marker stripper. Mirrors the classic workbench's
// stripDraftMarker: removes "[DRAFT — …] ", "[DRAFT] ", "[PLACEHOLDER] ",
// "[TODO] " prefixes from any string. The tagger emits these as editing
// affordances; /api/auto-retag strips them so a fresh retag lands as clean
// text (the user rewrites later) — without weakening the draft-hygiene gate
// that applies to manual edits via PUT.
const DRAFT_PREFIX_RE = /\[(?:DRAFT|PLACEHOLDER|TODO)[^\]]*\]\s*/gi;
function stripDraftPrefix(s: string): string {
  return typeof s === "string" ? s.replace(DRAFT_PREFIX_RE, "") : s;
}
/** Strip draft markers from a single a11y risk — handles legacy strings and structured objects. */
function stripDraftFromRisk(risk: CorpusEntryT["antiPatterns"]["accessibilityRisks"][number]): typeof risk {
  if (typeof risk === "string") return stripDraftPrefix(risk);
  return {
    ...risk,
    element: stripDraftPrefix(risk.element),
    risk: stripDraftPrefix(risk.risk),
    evidence: stripDraftPrefix(risk.evidence),
    ...(risk.wcag ? { wcag: stripDraftPrefix(risk.wcag) } : {}),
  };
}
function stripDraftMarkersFromEntry(entry: CorpusEntryT): CorpusEntryT {
  const e = { ...entry };
  e.critique = stripDraftPrefix(e.critique);
  e.whatToSteal = e.whatToSteal.map(stripDraftPrefix);
  if (e.antiPatterns) {
    e.antiPatterns = {
      antiPatterns: e.antiPatterns.antiPatterns.map(stripDraftPrefix),
      whereThisFails: e.antiPatterns.whereThisFails.map(stripDraftPrefix),
      accessibilityRisks: e.antiPatterns.accessibilityRisks.map(stripDraftFromRisk),
    };
  }
  if (e.voice) {
    e.voice = {
      tone: stripDraftPrefix(e.voice.tone),
      examples: e.voice.examples.map(stripDraftPrefix),
      avoid: e.voice.avoid.map(stripDraftPrefix),
    };
  }
  if (e.businessRationale) {
    e.businessRationale = {
      ...e.businessRationale,
      targetUser: stripDraftPrefix(e.businessRationale.targetUser),
      rationale: stripDraftPrefix(e.businessRationale.rationale),
    };
  }
  return e;
}

// ─── DOM signals reader ─────────────────────────────────────────────────────
// Reads the dom-signals.json sidecar for a batch-captured image. Only batch
// captures (images under images-private/captures/{batchId}/) have signals;
// Add-flow captures skip extraction (undefined signalsMap). Promoted entries
// whose image path was flattened by promoteTempImage also lose the batch
// linkage — readDomSignalsForImage returns null for those, and the tagger
// falls back to pixel-guessing (no regression — same as before DOM signals).
//
// NOTE: hasDomSignals on CaptureMeta is NOT persisted on corpus entries, so
// we always attempt the read rather than using it as a fast-path skip.
const domSignalsCache = new Map<string, Record<string, DomSignals> | null>();

function readDomSignalsForImage(corpusRelativeImagePath: string): DomSignals | null {
  // Only paths under captures/{batchId}/ can have a dom-signals.json sidecar.
  // Path looks like: images-private/captures/{batchId}/{captureId}.png
  const match = corpusRelativeImagePath.match(/^images-private\/captures\/([^/]+)\/(.+)$/);
  if (!match) return null;
  const [, batchId, captureIdWithExt] = match;
  const captureId = captureIdWithExt.replace(/\.[^.]+$/, ""); // strip .png/.jpg

  // Cache the parsed sidecar per batch dir (read once, not per image).
  let sidecar = domSignalsCache.get(batchId);
  if (sidecar === undefined) {
    const sidecarPath = resolve(CORPUS_ROOT, "images-private", "captures", batchId, "dom-signals.json");
    if (!existsSync(sidecarPath)) {
      domSignalsCache.set(batchId, null);
      return null;
    }
    try {
      sidecar = JSON.parse(readFileSync(sidecarPath, "utf-8")) as Record<string, DomSignals>;
      domSignalsCache.set(batchId, sidecar);
    } catch {
      domSignalsCache.set(batchId, null);
      return null;
    }
  }
  if (!sidecar) return null;
  return sidecar[captureId] ?? null;
}

export function validateEntryPayload(payload: unknown): CorpusEntryT {
  const result = CorpusEntry.safeParse(payload);
  if (!result.success) {
    throw Object.assign(new Error("Entry validation failed"), { issues: result.error.issues });
  }
  // Isolated group-member crops do not carry enough product/page context for
  // honest business-intent inference. Normalize the pilot field away at the
  // save boundary, where capture provenance is actually available.
  if (result.data.provenance?.capture?.mode === "group-member") {
    result.data.businessRationale = undefined;
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

function slugify(value: string, fallback = "sample"): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return slug || fallback;
}

export function normalizeEntryIdForRename(value: string): string {
  return slugify(value, "");
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

// findDuplicateAtCommit now lives in ../dedup.ts — re-exported here for backward
// compat with existing tests/callers that import from ui-server. The canonical
// import path is ../dedup.js; new code should import from there directly.
export { findDuplicateAtCommit } from "../dedup.js";

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
  // Recursively walk private dir so nested bulk-import batches
  // (images-private/new-products-batch/Mercury Web Screens/…) are visible to
  // the orphan check. The earlier flat readdirSync missed nested files.
  return listImageFilesRecursive(PRIVATE_IMAGE_DIR, "images-private/");
}

// ─── capture-batch triage ──────────────────────────────────────────────────
// The batch capture pipeline (capture.ts) writes one folder per batch under
// corpus/images-private/captures/{batchId}/, each holding {captureId}.png,
// manifest.json (CaptureMeta[]), and triage.json ({captureId: status}). The
// classic workbench's triage view reviews these: promote → creates a corpus
// entry stamped with capture provenance; reject → marks triage.json; cleanup →
// deletes the batch dir ONLY when nothing is still pending. Every filesystem
// hop is gated through the helpers below so untrusted batchId/captureId can't
// escape the captures root (the safety gate the plan review flagged).

const CAPTURES_DIR = resolve(PRIVATE_IMAGE_DIR, "captures");
const TRIAGE_STATUSES = ["pending", "promoted", "rejected"] as const;
type TriageStatus = (typeof TRIAGE_STATUSES)[number];

/**
 * Slug-safety check for untrusted ids that name a path segment under captures/.
 * Rejects anything other than [a-z0-9-] so `/`, `\`, `..`, and spaces can never
 * reach the path joins. This is the path-traversal guard for /api/capture-triage
 * and /api/capture-cleanup — paired with the resolves-within-root check in
 * resolveBatchDir so a cleverly-formed-but-symlinked id is still contained.
 */
function isSlugSafe(value: string): boolean {
  return typeof value === "string" && value.length > 0 && /^[a-z0-9-]+$/.test(value);
}

/**
 * Resolve a batchId to an absolute path under CAPTURES_DIR and assert the
 * resolved path stays within that root. Throws on traversal/escape.
 */
function resolveBatchDir(batchId: string): string {
  if (!isSlugSafe(batchId)) {
    throw Object.assign(new Error("Invalid batchId"), { statusCode: 400 });
  }
  const root = resolve(CAPTURES_DIR);
  const batchDir = resolve(root, batchId);
  // Reject anything that escapes the captures root (defence-in-depth on top of
  // the slug check — covers symlink edge cases the regex alone wouldn't catch).
  if (batchDir !== root && !batchDir.startsWith(root + "/")) {
    throw Object.assign(new Error("Invalid batchId"), { statusCode: 400 });
  }
  return batchDir;
}

type CaptureBatchItem = {
  id: string;
  sourceName: string;
  captureMode: string;
  viewport: string;
  imagePath: string;
  status: string;
  // Capture provenance surfaced to the UI so the promote action can stamp
  // them onto the new entry's provenance.capture. Without these the promoted
  // entry got sourceUrl:"" + selectorPath:"" — silently dropping the very
  // metadata the capture pipeline exists to record.
  sourceUrl?: string;
  selectorPath?: string;
  capturedAt?: string;
};

type CaptureBatchSummary = {
  batchId: string;
  capturedAt: string;
  total: number;
  pending: number;
  promoted: number;
  rejected: number;
  items: CaptureBatchItem[];
};

/**
 * Walk the capture batches under corpus/images-private/captures and summarize
 * each from its manifest.json + triage.json. Newer batches first (batchId is a
 * timestamp in batch mode, so lexical sort == newest-first). Batches missing
 * their manifest are skipped — they're not from this pipeline.
 */
export function listCaptureBatches(): CaptureBatchSummary[] {
  if (!existsSync(CAPTURES_DIR)) return [];
  const out: CaptureBatchSummary[] = [];
  for (const name of readdirSync(CAPTURES_DIR, { withFileTypes: true })) {
    if (!name.isDirectory() || !isSlugSafe(name.name)) continue;
    const batchDir = join(CAPTURES_DIR, name.name);
    const manifestPath = join(batchDir, "manifest.json");
    const triagePath = join(batchDir, "triage.json");
    if (!existsSync(manifestPath)) continue;
    let manifest: CaptureMeta[] = [];
    let triage: Record<string, string> = {};
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as CaptureMeta[];
    } catch { continue; /* corrupt manifest — skip */ }
    try {
      triage = existsSync(triagePath) ? JSON.parse(readFileSync(triagePath, "utf-8")) : {};
    } catch { triage = {}; }
    let pending = 0, promoted = 0, rejected = 0;
    const items: CaptureBatchItem[] = manifest.map((m) => {
      const status = triage[m.id] === "promoted" ? "promoted" : triage[m.id] === "rejected" ? "rejected" : "pending";
      if (status === "promoted") promoted++;
      else if (status === "rejected") rejected++;
      else pending++;
      return {
        id: m.id,
        sourceName: m.sourceName,
        captureMode: m.captureMode,
        viewport: m.viewport,
        imagePath: m.imagePath,
        status,
        sourceUrl: m.sourceUrl,
        selectorPath: m.selectorPath,
        capturedAt: m.capturedAt,
      };
    });
    // capturedAt: newest capture in the batch (manifest writes per-item ISO
    // timestamps); fall back to the dir name (timestamp) if absent.
    const capturedAt = manifest.map((m) => m.capturedAt).filter(Boolean).sort().at(-1) ?? name.name;
    out.push({ batchId: name.name, capturedAt, total: items.length, pending, promoted, rejected, items });
  }
  // Newest first — batchId is a timestamp, lexical sort = chronological.
  out.sort((a, b) => (a.batchId < b.batchId ? 1 : a.batchId > b.batchId ? -1 : 0));
  return out;
}

/**
 * Update one capture's status in a batch's triage.json. batchId + captureId
 * are slug-checked + resolves-within-root; status is validated against the
 * closed set. Returns the updated triage map.
 */
export function setTriageStatus(batchId: string, captureId: string, status: TriageStatus): Record<string, string> {
  const batchDir = resolveBatchDir(batchId);
  if (!isSlugSafe(captureId)) {
    throw Object.assign(new Error("Invalid captureId"), { statusCode: 400 });
  }
  const triagePath = join(batchDir, "triage.json");
  if (!existsSync(batchDir) || !existsSync(triagePath)) {
    throw Object.assign(new Error("Batch not found"), { statusCode: 404 });
  }
  let triage: Record<string, string> = {};
  try { triage = JSON.parse(readFileSync(triagePath, "utf-8")); } catch { triage = {}; }
  triage[captureId] = status;
  writeFileSync(triagePath, JSON.stringify(triage, null, 2));
  return triage;
}

/**
 * Delete a batch directory, but ONLY when triage.json has zero pending entries.
 * This is the safety gate — without it the cleanup button would happily eat
 * private screenshots the curator hadn't reviewed yet. Throws 409 with a count
 * when pending items remain.
 */
export function cleanupBatch(batchId: string): { deleted: string } {
  const batchDir = resolveBatchDir(batchId);
  if (!existsSync(batchDir)) {
    throw Object.assign(new Error("Batch not found"), { statusCode: 404 });
  }
  const triagePath = join(batchDir, "triage.json");
  let triage: Record<string, string> = {};
  if (existsSync(triagePath)) {
    try { triage = JSON.parse(readFileSync(triagePath, "utf-8")); } catch { triage = {}; }
  }
  const pending = Object.values(triage).filter((s) => s === "pending").length;
  if (pending > 0) {
    throw Object.assign(new Error(`${pending} item(s) still pending triage — promote or reject them first`), { statusCode: 409 });
  }
  rmSync(batchDir, { recursive: true, force: false });
  return { deleted: batchId };
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
  // Vision gate counts ONLY extraction-capable keys. OPENAI_API_KEY_CRITIQUE is
  // text-only (NIM/DeepSeek critique split) and must NOT satisfy this gate —
  // otherwise the UI advertises auto-tagging and then fails at extraction.
  // status.openaiKeyConfigured reflects OPENAI_API_KEY (the bare key).
  const hasOpenAIExtraction = status.openaiKeyConfigured || !!process.env.OPENAI_API_KEY_EXTRACTION;
  // MiniMax M3 is native multimodal (unlike Mistral), so it counts as vision-capable.
  const anyVisionKey = !!(hasOpenAIExtraction || status.anthropicKeyConfigured || status.geminiKeyConfigured || status.minimaxKeyConfigured);
  // Resolve the effective provider + model for each pass via the SAME logic
  // Resolve the EFFECTIVE provider + model for each pass via the SAME logic
  // tagger.ts uses. activeProviderName() runs resolveProvider() (which applies
  // the Mistral-can't-do-extraction fallback, key-presence checks, etc.), so
  // the UI shows what will ACTUALLY run — not the raw env value. Raw env reads
  // here previously made the UI display "mistral" for extraction even though
  // the resolver correctly falls back to a vision provider at runtime.
  const extractionProvider = activeProviderName("extraction");
  const critiqueProvider = activeProviderName("critique");
  const extractionModel = activeModelName("extraction");
  const critiqueModel = activeModelName("critique");
  return {
    openaiKeyConfigured: status.openaiKeyConfigured,
    anthropicKeyConfigured: status.anthropicKeyConfigured,
    geminiKeyConfigured: status.geminiKeyConfigured,
    mistralKeyConfigured: status.mistralKeyConfigured,
    minimaxKeyConfigured: status.minimaxKeyConfigured,
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
 * SSRF guard for URL capture — extracted to ../ssrf.ts so the CLI capture
 * path (npm run capture, npm run capture-batch) and this UI route share one
 * rule. A drift here would silently re-enable SSRF on whichever path fell
 * out of sync, which is the worst-case failure mode.
 *
 * Re-exported from here for backward-compat with any caller that imported
 * isPrivateAddress from ui-server. The thin assertSafeCaptureTarget wrapper
 * preserves the UI's friendlier "Use a valid source URL" parse-error wording.
 */
export { isPrivateAddress } from "../ssrf.js";
import { assertSafeCaptureTarget as assertSafeCaptureTargetShared } from "../ssrf.js";

async function assertSafeCaptureTarget(rawUrl: string): Promise<URL> {
  try {
    return await assertSafeCaptureTargetShared(rawUrl);
  } catch (err) {
    // Re-wrap the bare "Invalid URL" message as the UI's friendlier wording so
    // existing toasts/error displays don't change. Other errors (DNS, private
    // address, bad protocol) pass through with their already-user-facing text.
    if (err instanceof Error && err.message === "Invalid URL") {
      throw new Error("Use a valid source URL");
    }
    throw err;
  }
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

/**
 * Detect + capture multiple candidates from one URL, using the SAME detection
 * pipeline as the batch CLI (consent, anchors, recursive oversized, group
 * members, dedup, viewport loop). Writes candidate PNGs into a temp batch dir
 * under captures/add-{batchId}/. No manifest.json/triage.json — so the dir is
 * invisible to listCaptureBatches (which requires manifest.json) and the
 * #/capture triage page. The Add flow promotes selected candidates to permanent
 * paths at save time (see promoteTempImage /api/entries extension).
 */
async function handleCaptureCandidates(req: IncomingMessage, res: ServerResponse) {
  const payload = await readJson(req) as { url?: string; slug?: string };
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
  const allowed = await isAllowedByRobots(sourceUrl.toString());
  if (!allowed) {
    sendJson(res, 400, { error: "robots.txt disallows capturing this URL" });
    return;
  }

  // batchId for Add-flow temp captures. Prefixed "add-" so /api/capture-cleanup-temp
  // (which only deletes add-* dirs) can distinguish them from real CLI batches,
  // and so listCaptureBatches (which requires manifest.json) ignores them.
  const batchId = `add-${new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14)}`;
  const batchDir = resolve(CAPTURES_DIR, batchId);
  mkdirSync(batchDir, { recursive: true });

  const sourceName = slugify(payload.slug || sourceUrl.hostname);
  const browser = await chromium.launch({ headless: true });
  let candidates: CaptureMeta[];
  try {
    candidates = await captureCandidatesForSource(
      browser,
      { url: sourceUrl.toString(), sourceName },
      batchDir,
      batchId,
      new Map(),
      undefined, // no signalsMap — Add flow skips DOM-signal extraction entirely (no sidecar consumer; avoids paying the evaluate cost per candidate).
    );
  } finally {
    await browser.close();
  }

  sendJson(res, 201, { batchId, candidates });
}

/**
 * Promote a temp capture candidate to a permanent flat path under
 * images-private/. Called from the /api/entries POST handler when an incoming
 * entry's image.path points at captures/add-{batchId}/...png. Copies (not
 * moves — the temp dir may hold other candidates still being triaged) and
 * returns the new corpus-relative path. Slug-checked + resolves-within-root on
 * both source and destination.
 *
 * Returns { path, width, height } so the caller can rewrite entry.image before
 * saveEntries. Throws with .statusCode on path-traversal or missing source.
 */
export function promoteTempImage(tempPath: string, permanentSlug: string): { path: string; width: number; height: number } {
  // Source must live under CAPTURES_DIR and start with captures/add-.
  const absTemp = fromCorpusRelativeImagePath(tempPath);
  const capturesRoot = resolve(CAPTURES_DIR);
  if (!absTemp.startsWith(capturesRoot + "/")) {
    throw Object.assign(new Error("Temp image must live under captures/"), { statusCode: 400 });
  }
  const relUnderCaptures = absTemp.slice(capturesRoot.length + 1);
  if (!relUnderCaptures.startsWith("add-")) {
    // Not an Add-flow temp image — leave it alone (could be a real batch path
    // from CLI capture, which has its own lifecycle). Return the path as-is.
    return { path: tempPath, width: 0, height: 0 };
  }
  if (!existsSync(absTemp)) {
    throw Object.assign(new Error(`Temp image not found: ${tempPath}`), { statusCode: 404 });
  }
  // Destination: flat images-private/{slug}.png, collision-avoided.
  const ext = extname(absTemp).toLowerCase() || ".png";
  let base = slugify(permanentSlug) || "capture";
  let destAbs = resolve(PRIVATE_IMAGE_DIR, `${base}${ext}`);
  let n = 2;
  while (existsSync(destAbs)) {
    destAbs = resolve(PRIVATE_IMAGE_DIR, `${base}-${n}${ext}`);
    n++;
  }
  const data = readFileSync(absTemp);
  writeFileSync(destAbs, data); // copy, not rename — temp dir holds other candidates
  const dimensions = imageSize(data);
  return {
    path: toCorpusRelativePath(destAbs),
    width: dimensions.width ?? 0,
    height: dimensions.height ?? 0,
  };
}

async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL) {
  const entries = loadEntries();

  if (req.method === "GET" && url.pathname === "/api/schema") {
    sendJson(res, 200, {
      categories: Category.options,
      styleTags: StyleTag.options,
      components: Component.options,
      domainTags: DomainTag.options,
      colorSchemes: ["light", "dark"],
      responsiveBehaviors: ["responsive", "fixed-width", "adaptive"],
      patternTypes: PatternType.options,
      spacingDensities: SpacingDensity.options,
      cornerStyles: CornerStyle.options,
      imageVisibilities: ImageVisibility.options,
      businessGoals: BusinessGoal.options,
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

  // Corpus recovery surface — exposes snapshot count + newest timestamp so the
  // curator UI can show "your work is recoverable" without plumbing snapshot
  // logic into the main endpoints. Read-only; the actual restore is a CLI.
  if (req.method === "GET" && url.pathname === "/api/health") {
    const snaps = listSnapshots();
    const newestEpoch = snaps.length ? Number(snaps[0].match(/entries-(\d+)\.json$/)?.[1] ?? 0) : 0;
    sendJson(res, 200, {
      entryCount: entries.length,
      snapshotCount: snaps.length,
      newestSnapshotEpoch: newestEpoch || null,
      newestSnapshotAgeMs: newestEpoch ? Date.now() - newestEpoch : null,
    });
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
    sendJson(res, 200, await checkDuplicateUpload(payload, entries));
    return;
  }

  // Clear the in-batch fingerprint set when a bulk run ends (client signals it).
  if (req.method === "POST" && url.pathname === "/api/check-duplicate/clear-batch") {
    const payload = await readJson(req) as { batchId?: string };
    if (payload.batchId) clearDuplicateBatch(payload.batchId);
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

  // ── capture-batch triage ──
  // GET /api/capture-batches — list capture batches (manifest + triage summary).
  if (req.method === "GET" && url.pathname === "/api/capture-batches") {
    sendJson(res, 200, { batches: listCaptureBatches() });
    return;
  }

  // POST /api/capture-triage { batchId, captureId, status } — update one item.
  if (req.method === "POST" && url.pathname === "/api/capture-triage") {
    const payload = await readJson(req) as { batchId?: string; captureId?: string; status?: string };
    const status = payload.status as TriageStatus;
    if (!TRIAGE_STATUSES.includes(status)) {
      sendJson(res, 400, { error: "status must be one of: pending, promoted, rejected" });
      return;
    }
    try {
      const triage = setTriageStatus(payload.batchId ?? "", payload.captureId ?? "", status);
      sendJson(res, 200, { ok: true, triage });
    } catch (error) {
      const code = (error as { statusCode?: number }).statusCode ?? 400;
      sendJson(res, code, { error: error instanceof Error ? error.message : "Triage update failed" });
    }
    return;
  }

  // POST /api/capture-cleanup { batchId } — delete a batch dir, but only when
  // no item is still pending (the safety gate for private screenshots).
  if (req.method === "POST" && url.pathname === "/api/capture-cleanup") {
    const payload = await readJson(req) as { batchId?: string };
    try {
      const result = cleanupBatch(payload.batchId ?? "");
      sendJson(res, 200, result);
    } catch (error) {
      const code = (error as { statusCode?: number }).statusCode ?? 400;
      sendJson(res, code, { error: error instanceof Error ? error.message : "Cleanup failed" });
    }
    return;
  }

  // POST /api/capture-candidates { url, slug? } — multi-candidate detection
  // for the Add-entry flow. Returns { batchId, candidates }. Distinct from
  // /api/capture-url (single full-viewport shot, classic workbench) so the
  // classic flow keeps its exact response shape.
  if (req.method === "POST" && url.pathname === "/api/capture-candidates") {
    try {
      await handleCaptureCandidates(req, res);
    } catch (error) {
      sendJson(res, 400, { error: explainCaptureError(error) });
    }
    return;
  }

  // POST /api/capture-cleanup-temp { batchId } — delete an Add-flow temp batch
  // dir (captures/add-*, no triage). Unlike /api/capture-cleanup there is NO
  // pending-items safety gate — these candidates are picked-or-discarded
  // client-side, not triaged. Only deletes dirs matching ^add-.
  if (req.method === "POST" && url.pathname === "/api/capture-cleanup-temp") {
    const payload = await readJson(req) as { batchId?: string };
    const batchId = payload.batchId ?? "";
    if (!batchId.startsWith("add-") || !isSlugSafe(batchId)) {
      sendJson(res, 400, { error: "batchId must be an add-* temp batch id" });
      return;
    }
    try {
      const batchDir = resolveBatchDir(batchId);
      if (!existsSync(batchDir)) {
        sendJson(res, 404, { error: `Batch not found: ${batchId}` });
        return;
      }
      rmSync(batchDir, { recursive: true, force: true });
      sendJson(res, 200, { deleted: batchId });
    } catch (error) {
      const code = (error as { statusCode?: number }).statusCode ?? 400;
      sendJson(res, code, { error: error instanceof Error ? error.message : "Cleanup failed" });
    }
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
      critiqueProvider?: string;
    };

    if (!payload.imagePath) {
      sendJson(res, 400, { error: "imagePath is required" });
      return;
    }

    // hasVisionKey (shared with the tagger) honors OPENAI_API_KEY_EXTRACTION /
    // _CRITIQUE too — a split-provider setup using only OPENAI_API_KEY_CRITIQUE
    // (NIM/DeepSeek for critique + real OpenAI for extraction) was falsely
    // rejected by the bare OPENAI_API_KEY check.
    if (!hasVisionKey()) {
      sendJson(res, 400, { error: "No vision provider key set. Add OPENAI_API_KEY (or OPENAI_API_KEY_EXTRACTION / _CRITIQUE for split-provider setups), ANTHROPIC_API_KEY, or GEMINI_API_KEY to .env, then restart npm run ui." });
      return;
    }

    try {
      const imagePath = fromCorpusRelativeImagePath(payload.imagePath);
      const entry = await tagImage({
        imagePath,
        productName: (payload.productName || "").trim(),
        url: payload.url || null,
        id: payload.id,
        imageDetail: payload.imageDetail,
        extractionOnly: payload.extractionOnly === true,
        // Per-call critique provider from the SPA dropdown (undefined → env/peak routing).
        critiqueProvider: parseProvider(payload.critiqueProvider),
        // DOM signals from the capture sidecar (null for non-batch images — no regression).
        domSignals: readDomSignalsForImage(payload.imagePath),
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
    const payload = await readJson(req) as { productName?: string; extraction?: Record<string, unknown>; domSignals?: DomSignals; critiqueProvider?: string };

    if (!payload.extraction) {
      sendJson(res, 400, { error: "extraction is required (pass the entry's _raw.extraction)" });
      return;
    }
    if (!hasCritiqueKey()) {
      sendJson(res, 400, { error: "No provider key set. Critique needs at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or MISTRAL_API_KEY in .env, then restart npm run ui." });
      return;
    }

    try {
      const result = await generateCritique((payload.productName || "").trim(), payload.extraction, parseProvider(payload.critiqueProvider), payload.domSignals ?? undefined);
      sendJson(res, 200, { critique: result });
    } catch (error) {
      sendJson(res, 400, { error: explainTagError(error) });
    }
    return;
  }

  // Bulk re-tag primitive: re-run extraction + critique on a SAVED entry,
  // overwriting categories/critique/tier etc. while preserving identity
  // (id, source, image, platform, addedAt, provenance). Used by the dashboard's
  // bulk "Re-tag" action to fix miscategorization and refresh critiques across
  // many entries. Provider is overridable per call (no env mutation races).
  if (req.method === "POST" && url.pathname === "/api/auto-retag") {
    const payload = await readJson(req) as {
      id?: string;
      extractionProvider?: string;
      critiqueProvider?: string;
    };

    if (!payload.id) {
      sendJson(res, 400, { error: "id is required" });
      return;
    }
    const entry = entries.find((e) => e.id === payload.id);
    if (!entry) {
      sendJson(res, 404, { error: `Entry not found: ${payload.id}` });
      return;
    }
    // Pinned check BEFORE the vision-key gate — protected entries should skip
    // cleanly regardless of runtime provider config, not surface key errors.
    if (entry.pinned) {
      sendJson(res, 200, { ok: false, skipped: true, reason: "pinned" });
      return;
    }
    if (!entry.image.path) {
      sendJson(res, 200, { ok: false, skipped: true, reason: "no image" });
      return;
    }
    if (!hasVisionKey()) {
      sendJson(res, 400, { error: "No vision provider key set. Add OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY to .env, then restart npm run ui." });
      return;
    }
    // Validate provider values using the shared allowlist (includes "minimax").
    const extractionProvider = parseProvider(payload.extractionProvider);
    const critiqueProvider = parseProvider(payload.critiqueProvider);

    try {
      const imagePath = fromCorpusRelativeImagePath(entry.image.path);
      const tagged = await tagImage({
        imagePath,
        productName: entry.source.productName,
        url: entry.source.url,
        id: entry.id,
        imageDetail: "high",
        extractionProvider,
        critiqueProvider,
        // DOM signals from the capture sidecar (null for promoted entries whose
        // path was flattened — no regression, falls back to pixel-guessing).
        domSignals: readDomSignalsForImage(entry.image.path),
      });

      // Merge: tagged output REPLACES content fields; identity fields preserved.
      // Title: keep the existing unless it's the placeholder template.
      const isPlaceholderTitle = /^\S+ — \(add descriptive subtitle\)/.test(entry.title);
      const merged: CorpusEntryT = {
        ...entry, // preserves id, source, image, platform, addedAt, provenance, reviewStatus
        title: isPlaceholderTitle ? tagged.title : entry.title,
        patternType: tagged.patternType as CorpusEntryT["patternType"],
        patternDiscovery: (tagged.patternDiscovery ?? undefined) as CorpusEntryT["patternDiscovery"],
        categories: tagged.categories as CorpusEntryT["categories"],
        styleTags: tagged.styleTags as CorpusEntryT["styleTags"],
        components: tagged.components as CorpusEntryT["components"],
        domainTags: (tagged.domainTags?.length ? tagged.domainTags : undefined) as CorpusEntryT["domainTags"],
        colorScheme: (tagged.colorScheme || undefined) as CorpusEntryT["colorScheme"],
        industryVertical: (tagged.industryVertical || undefined) as CorpusEntryT["industryVertical"],
        responsiveBehavior: (tagged.responsiveBehavior || undefined) as CorpusEntryT["responsiveBehavior"],
        mood: (tagged.mood || undefined) as CorpusEntryT["mood"],
        visual: tagged.visual as CorpusEntryT["visual"],
        critique: tagged.critique,
        whatToSteal: tagged.whatToSteal,
        antiPatterns: tagged.antiPatterns as CorpusEntryT["antiPatterns"],
        layout: (tagged.layout ?? undefined) as CorpusEntryT["layout"],
        voice: (tagged.voice ?? undefined) as CorpusEntryT["voice"],
        businessRationale: (tagged.businessRationale ?? undefined) as CorpusEntryT["businessRationale"],
        qualityTier: tagged.qualityTier as CorpusEntryT["qualityTier"],
        qualityScore: tagged.qualityScore,
      };

      // Strip the tagger's [DRAFT]/[DRAFT — REWRITE] editing prefixes before
      // validation — a bulk retag is meant to land fresh, clean text the user
      // rewrites later, not [DRAFT]-gated text that the validator rejects.
      const cleaned = stripDraftMarkersFromEntry(merged);
      const validated = validateEntryPayload(cleaned);
      // Retag advances taggedAt — the content was freshly re-extracted.
      stampProvenance(validated, new Date().toISOString().slice(0, 10), "auto");
      const idx = entries.findIndex((e) => e.id === payload.id);
      entries[idx] = validated;
      saveEntries(entries);
      sendJson(res, 200, { ok: true, entry: validated });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: explainTagError(error) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/entries") {
    let promotedPermanentPath: string | null = null;
    try {
      const entry = prepareNewEntryPayload(await readJson(req), entries);
      // Commit-time dedup gate — the authoritative check. The client dedups at
      // upload, but the corpus can change between stage and commit, and batch
      // tracking isn't bulletproof. Reject here with 409 so the client can mark
      // the row as a duplicate rather than a generic error. Done BEFORE the
      // temp→permanent copy so a duplicate never leaves an orphan permanent file.
      const dup = await findDuplicateAtCommit(entry, entries);
      if (dup) {
        sendJson(res, 409, { error: `Duplicate image (${dup.type}) of an existing entry: ${dup.match}`, duplicate: true, type: dup.type, match: dup.match });
        return;
      }
      // Promote-on-save: if the entry's image.path points at an Add-flow temp
      // capture (captures/add-*/...png), copy it to a permanent flat path and
      // rewrite entry.image.path. The temp file stays (the temp dir holds other
      // candidates still being triaged); only the permanent copy is referenced
      // by the saved entry, so later /api/capture-cleanup-temp can never touch
      // a referenced image.
      if (entry.image.path && entry.image.path.includes("captures/add-")) {
        const promoted = promoteTempImage(entry.image.path, entry.id);
        if (promoted.path !== entry.image.path) {
          promotedPermanentPath = fromCorpusRelativeImagePath(promoted.path);
          entry.image.path = promoted.path;
          if (promoted.width) entry.image.width = promoted.width;
          if (promoted.height) entry.image.height = promoted.height;
        }
      }
      // Stamp taggedAt for newly saved tagger-origin entries. The SPA flips
      // auto → auto-reviewed before save, so both values mean "fresh auto-tag".
      if (entry.provenance?.taggedBy === "auto" || entry.provenance?.taggedBy === "auto-reviewed") {
        const today = new Date().toISOString().slice(0, 10);
        stampProvenance(entry, today, entry.provenance.taggedBy, { advanceTaggedAt: true });
      }
      saveEntries([...entries, entry]);
      sendJson(res, 201, { entry });
    } catch (error) {
      // Rollback: if we copied temp→permanent but saveEntries then threw, delete
      // the orphan permanent copy. The temp file is intact (we copied, didn't
      // move) so the user can retry.
      if (promotedPermanentPath) {
        try { unlinkSync(promotedPermanentPath); } catch { /* best-effort */ }
      }
      sendJson(res, 400, { error: "Entry validation failed", issues: entryIssues(error) });
    }
    return;
  }

  // ── Rename endpoint: id-only, no image file rename ─────────────────────────
  // The image is served by entry.image.path (a string lookup), not by id, so
  // renaming the id does NOT require renaming the image file on disk.
  const renameMatch = url.pathname.match(/^\/api\/entries\/([^/]+)\/rename$/);
  if (renameMatch && req.method === "POST") {
    const oldId = decodeURIComponent(renameMatch[1]);
    const index = entries.findIndex((e) => e.id === oldId);
    if (index === -1) {
      sendJson(res, 404, { error: `Entry not found: ${oldId}` });
      return;
    }
    const payload = await readJson(req) as { newId?: string };
    const rawNewId = (payload.newId || "").trim();
    if (!rawNewId) {
      sendJson(res, 400, { error: "newId is required" });
      return;
    }
    const newId = normalizeEntryIdForRename(rawNewId);
    if (!newId) {
      sendJson(res, 400, { error: "newId must contain at least one letter or number" });
      return;
    }
    if (newId === oldId) {
      sendJson(res, 400, { error: "New id is the same as the current id" });
      return;
    }
    if (entries.some((e) => e.id === newId)) {
      sendJson(res, 409, { error: `An entry with id "${newId}" already exists` });
      return;
    }
    // Update only the id — image.path stays as-is (lookup is by path string).
    entries[index] = { ...entries[index], id: newId };
    saveEntries(entries);
    sendJson(res, 200, { ok: true, entry: entries[index] });
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
        // Provenance flip: a human editing an auto-tagged entry upgrades it to
        // "auto-reviewed" (the tagger produced the draft, a human approved the
        // edits). Don't downgrade an already-human or already-reviewed entry.
        // PRESERVE all existing provenance fields (capture, taggedAt, reviewedBy)
        // — the prior code replaced provenance entirely, wiping capture metadata.
        const prior = entries[index];
        if (prior && prior.provenance?.taggedBy === "auto") {
          stampProvenance(entry, prior.provenance?.taggedAt ?? new Date().toISOString().slice(0, 10), "auto-reviewed");
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

    // Static assets — extracted CSS/JS served from ui/. Path-traversal guarded:
    // resolve under STATIC_DIR, reject anything that escapes it (.., absolute).
    if (req.method === "GET" && url.pathname.startsWith("/static/")) {
      const rel = url.pathname.slice("/static/".length);
      if (rel.includes("..") || rel.startsWith("/")) {
        sendText(res, 400, "Bad static path");
        return;
      }
      const abs = resolve(STATIC_DIR, rel);
      if (!abs.startsWith(STATIC_DIR) || !existsSync(abs)) {
        sendText(res, 404, "Not found");
        return;
      }
      res.writeHead(200, { "content-type": mimeFor(abs), "cache-control": "no-store" });
      res.end(readFileSync(abs));
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index-2.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(APP_PATH, "utf-8"));
      return;
    }

    // Classic workbench — the form + bulk-import flows. The new SPA links here
    // for those surfaces. Served from index-classic.html (parallel to APP_PATH).
    if (req.method === "GET" && url.pathname === "/index-classic.html") {
      const classicPath = resolve(PROJECT_ROOT, "index-classic.html");
      if (!existsSync(classicPath)) { sendText(res, 404, "classic view not found"); return; }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(readFileSync(classicPath, "utf-8"));
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
