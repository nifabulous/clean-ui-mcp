#!/usr/bin/env node
import "../env.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns";
import { imageSize } from "image-size";
import { chromium } from "playwright";
import { Corpus, CorpusEntry, Category, StyleTag, PatternType, SpacingDensity, CornerStyle, ImageVisibility, findDraftMarkers, type CorpusEntryT } from "../schema.js";
import { CORPUS_ROOT, PRIVATE_IMAGE_DIR, PROJECT_ROOT, fromCorpusRelativeImagePath, toCorpusRelativePath } from "../paths.js";
import { tagImage } from "../tagger.js";
import { getEnvStatus, type EnvStatus } from "../env.js";

const PORT = Number(process.env.CLEAN_UI_PORT ?? 3131);
const ENTRIES_PATH = resolve(CORPUS_ROOT, "entries.json");
const APP_PATH = resolve(PROJECT_ROOT, "index-2.html");
const MAX_BODY_BYTES = 20 * 1024 * 1024;

function loadEntries(): CorpusEntryT[] {
  const raw = JSON.parse(readFileSync(ENTRIES_PATH, "utf-8"));
  return Corpus.parse(raw).entries;
}

function saveEntries(entries: CorpusEntryT[]): void {
  const corpus = Corpus.parse({ version: 2, entries });
  writeFileSync(ENTRIES_PATH, `${JSON.stringify(corpus, null, 2)}\n`, "utf-8");
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
  if (/429|rate_limit|quota/i.test(message)) return "Vision provider rate limit or quota was reached. Try again later or use another key.";
  if (/model|not found|unsupported/i.test(message)) return "The vision model was rejected. Check the model name in .env and restart the app.";
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

  sendJson(res, 201, {
    path: toCorpusRelativePath(absolutePath),
    width: dimensions.width ?? null,
    height: dimensions.height ?? null,
    visibility: "private",
    hash,
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
    const payload = await readJson(req) as { hash?: string; width?: number; height?: number; path?: string };
    const hash = payload.hash ?? "";
    const w = payload.width ?? 0;
    const h = payload.height ?? 0;

    let exactMatch: string | null = null;
    let nearMatch: string | null = null;

    // Build a hash map of all corpus entry images for exact matching.
    for (const entry of entries) {
      if (!entry.image.path) continue;
      try {
        const fullPath = fromCorpusRelativeImagePath(entry.image.path);
        if (!existsSync(fullPath)) continue;
        const imgData = readFileSync(fullPath);
        const entryHash = createHash("sha256").update(imgData).digest("hex");

        if (entryHash === hash) { exactMatch = entry.id; break; }

        // Near-duplicate: same dimensions + same aspect ratio (within 2px tolerance).
        if (!nearMatch && w > 0 && h > 0 && entry.image.width && entry.image.height) {
          const dimMatch = Math.abs(entry.image.width - w) <= 2 && Math.abs(entry.image.height - h) <= 2;
          if (dimMatch) nearMatch = entry.id;
        }
      } catch { /* skip unreadable images */ }
    }

    if (exactMatch) {
      sendJson(res, 200, { duplicate: true, type: "exact", match: exactMatch });
    } else if (nearMatch) {
      sendJson(res, 200, { duplicate: true, type: "near", match: nearMatch });
    } else {
      sendJson(res, 200, { duplicate: false, type: null, match: null });
    }
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
    };

    if (!payload.imagePath || !payload.productName) {
      sendJson(res, 400, { error: "imagePath and productName are required" });
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
        productName: payload.productName,
        url: payload.url || null,
        id: payload.id,
      });
      sendJson(res, 200, { entry });
    } catch (error) {
      sendJson(res, 400, { error: explainTagError(error) });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/entries") {
    try {
      const entry = prepareNewEntryPayload(await readJson(req), entries);
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
  server.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EADDRINUSE") {
      console.error(`Port ${PORT} is already in use. The curator may already be running at http://localhost:${PORT}.`);
      console.error(`Stop the old process or set CLEAN_UI_PORT in .env to use another port.`);
      process.exit(1);
    }
    throw error;
  });

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`clean-ui curator running at http://localhost:${PORT}`);
  });
}
