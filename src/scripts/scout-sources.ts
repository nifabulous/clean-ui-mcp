#!/usr/bin/env node
import "../env.js";
/**
 * scout-sources.ts — web-discovery agent for the clean-ui corpus.
 *
 * Finds real product UIs worth adding to the corpus, targeted at coverage
 * gaps, and hands them to the existing capture pipeline. It is the front
 * half of:
 *
 *   scout-sources → sources-scouted.json → npm run capture-batch →
 *   tagger/review → commit-draft → corpus/entries.json
 *
 * What the scout actually does:
 *
 *   1. Gap analysis — reads corpus/entries.json and ranks under-represented
 *      patternType / category / styleTag / industryVertical values.
 *   2. Candidate generation — asks the configured text model (callTextModel,
 *      same provider abstraction as the tagger) for real product URLs that
 *      fill the gaps. Gallery/aggregator sites and ToS-forbidden archives
 *      (Mobbin, Dribbble, Behance, Awwwards, ...) are banned IN CODE
 *      (isBannedAggregatorHost, enforced in parseCandidates), not just asked of
 *      the model; the corpus only stores real product UIs.
 *   3. Verification — per candidate: SSRF guard (assertSafeNavigationTarget,
 *      same rule as capture), robots.txt hard gate (isAllowedByRobots, same
 *      rule as capture), reachability + <title>/<meta> extraction with
 *      per-hop redirect SSRF checks.
 *   4. Dedupe — against existing corpus entries by URL, hostname, and product
 *      name, plus anything already accepted in this run.
 *   5. Vision scoring — screenshots each surviving candidate (desktop
 *      viewport, private dir) and asks the configured vision model
 *      (callVisionModel) to judge suitability for the targeted gap. Skippable
 *      with --no-vision.
 *   6. Output — capture-batch-compatible sources-scouted.json + a curator
 *      report (scout-report.md) + full details (scout-details.json).
 *
 * Sourcing rules from docs/SOURCING.md apply: everything the scout touches is
 * private — screenshots land in corpus/images-private/ (gitignored) and the
 * emitted sources carry no redistribution rights claims.
 */

import { mkdirSync, promises as fs, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { callTextModel, callVisionModel, type Provider, type EndpointOverride } from "../tagger.js";
import { assertSafeNavigationTarget, installSsrfGuard } from "../ssrf.js";
import { isAllowedByRobots, captureSlug } from "./capture.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..", "..");
const DEFAULT_CORPUS_PATH = resolve(REPO_ROOT, "corpus", "entries.json");
const PRIVATE_IMAGE_DIR = resolve(REPO_ROOT, "corpus", "images-private");

// ============================================================
// Types
// ============================================================

export type CorpusEntry = {
  patternType?: string | null;
  categories?: string[] | null;
  styleTags?: string[] | null;
  industryVertical?: string | null;
  source?: { productName?: string | null; url?: string | null };
};

export type GapDimension = "patternType" | "category" | "styleTag" | "industryVertical";

export type GapTarget = {
  dimension: GapDimension;
  value: string;
  count: number;
};

export type Candidate = {
  url: string;
  sourceName: string;
  rationale: string;
  expectedPattern?: string;
  expectedCategories?: string[];
  expectedStyleTags?: string[];
  cautionary?: boolean;
};

export type Verification = {
  url: string;
  sourceName: string;
  reachable: boolean;
  status: number | null;
  finalUrl: string | null;
  title: string | null;
  description: string | null;
  robotsAllowed: boolean;
  screenshotPath: string | null;
  error: string | null;
};

export type SuitabilityScore = {
  url: string;
  suitability: number;
  verdict: "suitable" | "unsuitable" | "uncertain";
  matchesGap: boolean;
  reasons: string[];
  proposedPattern?: string;
  proposedCategories?: string[];
  proposedStyleTags?: string[];
  cautionary: boolean;
  raw: string;
};

export type ScoutCliOptions = {
  limit: number;
  maxCandidates: number;
  patterns: string[];
  categories: string[];
  styles: string[];
  industries: string[];
  candidatesFile: string | null;
  noVision: boolean;
  dryRun: boolean;
  outDir: string;
  runId: string;
  provider: string | null;
  visionProvider: string | null;
  corpusPath: string;
};

/**
 * True only for a 2xx status. A 3xx without a Location, or the
 * redirect-loop-exhausted response `fetchWithHopGuard` returns, is NOT
 * reachable — the page never answered. Treating 300-399 as reachable would let
 * metadata-only mode accept a malformed redirect as a page.
 */
export function isReachableStatus(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

/**
 * Metadata-only acceptance gate. A page is acceptable without vision scoring
 * only when it is reachable, robots allows capture, AND its head yielded a
 * title — a binary 200 (PDF/image) has no `<title>`, so it cannot pass as a
 * UI page in metadata-only mode.
 */
export function metadataAcceptable(verification: Verification): boolean {
  return verification.reachable && verification.robotsAllowed && verification.title !== null;
}

// ============================================================
// Pure helpers (unit-tested)
// ============================================================

/** Normalize a hostname for dedupe: lowercase, strip www., strip port. */
export function normalizeHost(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return u.hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

/** Normalize a URL for exact-match dedupe: origin + pathname, no trailing slash. */
export function normalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    let path = u.pathname;
    if (path === "/") path = "";
    else if (path.endsWith("/")) path = path.slice(0, -1);
    return `${u.hostname.replace(/^www\./, "").toLowerCase()}${path}`;
  } catch {
    return rawUrl.trim().toLowerCase();
  }
}

/**
 * Rank coverage gaps from corpus entries, ascending by count (rarest first).
 * `targets` restrict the result to explicitly requested dimension/value pairs
 * (still reported with their corpus count) when given.
 */
export function computeGaps(
  entries: CorpusEntry[],
  targets: Array<{ dimension: GapDimension; value: string }> = [],
): GapTarget[] {
  const count = (pred: (e: CorpusEntry) => boolean): number => entries.filter(pred).length;

  const byPattern = new Map<string, number>();
  const byCategory = new Map<string, number>();
  const byStyle = new Map<string, number>();
  const byIndustry = new Map<string, number>();

  for (const e of entries) {
    if (e.patternType) byPattern.set(e.patternType, (byPattern.get(e.patternType) ?? 0) + 1);
    for (const c of e.categories ?? []) byCategory.set(c, (byCategory.get(c) ?? 0) + 1);
    for (const s of e.styleTags ?? []) byStyle.set(s, (byStyle.get(s) ?? 0) + 1);
    if (e.industryVertical) byIndustry.set(e.industryVertical, (byIndustry.get(e.industryVertical) ?? 0) + 1);
  }

  const collect = (dimension: GapDimension, counts: Map<string, number>, values?: string[]): GapTarget[] => {
    const source = values ?? [...counts.keys()];
    return source
      .map((value) => ({ dimension, value, count: counts.get(value) ?? count((e) => {
        if (dimension === "patternType") return e.patternType === value;
        if (dimension === "category") return (e.categories ?? []).includes(value);
        if (dimension === "styleTag") return (e.styleTags ?? []).includes(value);
        return e.industryVertical === value;
      }) }));
  };

  const patternValues = targets.filter((t) => t.dimension === "patternType").map((t) => t.value);
  const categoryValues = targets.filter((t) => t.dimension === "category").map((t) => t.value);
  const styleValues = targets.filter((t) => t.dimension === "styleTag").map((t) => t.value);
  const industryValues = targets.filter((t) => t.dimension === "industryVertical").map((t) => t.value);

  const patterns = collect("patternType", byPattern, patternValues.length ? patternValues : undefined);
  const categories = collect("category", byCategory, categoryValues.length ? categoryValues : undefined);
  const styles = collect("styleTag", byStyle, styleValues.length ? styleValues : undefined);
  const industries = collect("industryVertical", byIndustry, industryValues.length ? industryValues : undefined);

  const all = [...patterns, ...categories, ...styles, ...industries];
  const targetKey = (t: GapTarget): string => `${t.dimension}:${t.value}`;
  const targeted = new Set(targets.map((t) => `${t.dimension}:${t.value}`));
  return all.sort((a, b) => {
    const aTarget = targeted.has(targetKey(a)) ? 0 : 1;
    const bTarget = targeted.has(targetKey(b)) ? 0 : 1;
    return aTarget - bTarget || a.count - b.count || a.dimension.localeCompare(b.dimension) || a.value.localeCompare(b.value);
  });
}

/** Distinct product names + hosts already in the corpus — fed to the model as an avoid-list. */
export function existingCorpusIdentity(entries: CorpusEntry[]): { products: string[]; hosts: string[] } {
  const products = new Set<string>();
  const hosts = new Set<string>();
  for (const e of entries) {
    if (e.source?.productName) products.add(e.source.productName.trim());
    if (e.source?.url) hosts.add(normalizeHost(e.source.url));
  }
  return { products: [...products].sort((a, b) => a.localeCompare(b)), hosts: [...hosts].sort() };
}

/** Build the candidate-generation prompt. Pure and deterministic given inputs. */
export function buildGenerationPrompt(args: {
  gaps: GapTarget[];
  existing: { products: string[]; hosts: string[] };
  maxCandidates: number;
  patterns: string[];
  categories: string[];
  styles: string[];
}): string {
  const gapLines = args.gaps.map((g) => `- ${g.dimension} "${g.value}" — ${g.count} entry/ies`).join("\n");
  const avoid = [...args.existing.hosts, ...args.existing.products].slice(0, 80).join(", ");
  return `You are the discovery agent for a curated corpus of exceptional real-product UI examples.

The corpus stores screenshots + structured critiques of real product screens. It currently has
under-represented areas we want to fill. Ranked by scarcity:

${gapLines}

Your job: propose ${args.maxCandidates} real, publicly reachable product URLs that plausibly exemplify
one or more of those gaps. Prefer products whose UI is genuinely good (or, for cautionary entries,
genuinely instructive in its badness) — not generic templates.

Rules:
- Return ONLY a JSON array. No markdown fences, no prose before or after, no extra keys.
- Each item: {"url": "...", "sourceName": "...", "rationale": "...", "expectedPattern": "...",
  "expectedCategories": ["..."], "expectedStyleTags": ["..."], "cautionary": false}
- "expectedPattern" must be one of: ${args.patterns.join(", ")}.
- "expectedCategories" and "expectedStyleTags" must use values from these vocabularies:
  categories: ${args.categories.join(", ")}; styleTags: ${args.styles.join(", ")}.
- "rationale" is 1-2 sentences naming the specific UI decision the page showcases and which gap it fills.
- Use the exact homepage or the most relevant public section URL (e.g. /pricing, /dashboard demo). Never
  invent URLs — only propose URLs you are confident exist.
- NEVER propose gallery/aggregator/curation sites (Mobbin, Dribbble, Behance, Awwwards, Land-book,
  siteinspire, landing page collections). Real products only.
- NEVER propose a site that forbids automated collection in its ToS.
- Mark genuinely-bad-but-instructive examples (dense enterprise pricing, cluttered portals) with
  "cautionary": true — the corpus has a cautionary tier.
- Avoid these existing corpus domains/products: ${avoid}.`;
}

/**
 * Aggregator / gallery hosts the corpus must not source from — a ToS and
 * redistribution boundary (docs/SOURCING.md), not a quality one. Registrable
 * domains only; the match below also covers every subdomain.
 */
const BANNED_AGGREGATOR_HOSTS: ReadonlySet<string> = new Set([
  "mobbin.com", "dribbble.com", "behance.net", "awwwards.com", "land-book.com",
  "pinterest.com", "muzli.com", "collectui.com", "pttrns.com", "uigarage.net",
]);

/**
 * True when a URL's host is (or is a subdomain of) a banned aggregator.
 *
 * Enforced in code, not just in the prompt: a model that ignores the ban and a
 * hand-authored candidate file both reach {@link parseCandidates}, so this is the
 * one gate. Robust to the obvious evasions — the host is lowercased, a trailing
 * dot is stripped, the port is ignored (URL parsing drops it from `hostname`),
 * and a subdomain is matched by suffix — so `App.Mobbin.com.:443` is caught.
 * An unparseable URL returns false: it is not a KNOWN aggregator, and
 * verifyCandidate still SSRF- and robots-gates it before any fetch.
 */
export function isBannedAggregatorHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  for (const banned of BANNED_AGGREGATOR_HOSTS) {
    if (host === banned || host.endsWith(`.${banned}`)) return true;
  }
  return false;
}

/**
 * Parse the model's candidate JSON, tolerating markdown fences and dropping
 * invalid entries (bad URL, empty name) with a reason. Returns kept + dropped.
 */
export function parseCandidates(raw: string): { kept: Candidate[]; dropped: Array<{ raw: unknown; reason: string }> } {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    // Some models wrap the array in prose even when told not to — try to salvage
    // the first JSON array-like span.
    const match = stripped.match(/\[\s*\{[\s\S]*\}\s*\]/);
    if (!match) return { kept: [], dropped: [{ raw, reason: "response was not parseable JSON" }] };
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return { kept: [], dropped: [{ raw, reason: "response was not parseable JSON" }] };
    }
  }
  if (!Array.isArray(parsed)) return { kept: [], dropped: [{ raw: parsed, reason: "top-level JSON was not an array" }] };

  const kept: Candidate[] = [];
  const dropped: Array<{ raw: unknown; reason: string }> = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      dropped.push({ raw: item, reason: "item is not an object" });
      continue;
    }
    const url = typeof (item as { url?: unknown }).url === "string" ? (item as { url: string }).url.trim() : "";
    const sourceName = typeof (item as { sourceName?: unknown }).sourceName === "string" ? (item as { sourceName: string }).sourceName.trim() : "";
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      dropped.push({ raw: item, reason: `invalid URL: ${url || "(missing)"}` });
      continue;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      dropped.push({ raw: item, reason: `non-http(s) URL: ${url}` });
      continue;
    }
    // The aggregator ban is enforced here, not merely stated in the generation
    // prompt. The prompt asks the model not to propose Mobbin/Dribbble/etc., but
    // a model can ignore it and a hand-authored --candidates-file bypasses the
    // prompt entirely — both funnel through this parser, so this is the choke
    // point. The corpus stores only real product UIs (ToS + redistribution).
    if (isBannedAggregatorHost(parsedUrl.toString())) {
      dropped.push({ raw: item, reason: `banned aggregator host: ${parsedUrl.hostname}` });
      continue;
    }
    if (!sourceName) {
      dropped.push({ raw: item, reason: `missing sourceName for ${url}` });
      continue;
    }
    const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    const strs = (v: unknown): string[] | undefined => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean) : undefined;
    kept.push({
      url: parsedUrl.toString(),
      sourceName,
      rationale: str((item as { rationale?: unknown }).rationale) ?? "",
      expectedPattern: str((item as { expectedPattern?: unknown }).expectedPattern),
      expectedCategories: strs((item as { expectedCategories?: unknown }).expectedCategories),
      expectedStyleTags: strs((item as { expectedStyleTags?: unknown }).expectedStyleTags),
      cautionary: Boolean((item as { cautionary?: unknown }).cautionary),
    });
  }
  return { kept, dropped };
}

/** Load a hand-authored candidate file (LLM-free mode). */
export async function parseCandidatesFile(path: string): Promise<{ kept: Candidate[]; dropped: Array<{ raw: unknown; reason: string }> }> {
  const text = await fs.readFile(path, "utf8");
  return parseCandidates(text);
}

/**
 * Dedupe candidates against corpus entries and against prior/current sources.
 * Drop rules: exact normalized URL, same hostname, same product name
 * (case-insensitive).
 */
export function dedupeCandidates(
  candidates: Candidate[],
  entries: CorpusEntry[],
  priorSources: Array<{ url: string; sourceName: string }> = [],
): { kept: Candidate[]; dropped: Array<{ candidate: Candidate; reason: string }> } {
  const seenUrls = new Set<string>();
  const seenHosts = new Set<string>();
  const seenProducts = new Set<string>();

  for (const e of entries) {
    if (e.source?.url) {
      seenUrls.add(normalizeUrl(e.source.url));
      seenHosts.add(normalizeHost(e.source.url));
    }
    if (e.source?.productName) seenProducts.add(e.source.productName.trim().toLowerCase());
  }
  for (const s of priorSources) {
    if (s.url) {
      seenUrls.add(normalizeUrl(s.url));
      seenHosts.add(normalizeHost(s.url));
    }
    if (s.sourceName) seenProducts.add(s.sourceName.trim().toLowerCase());
  }

  const kept: Candidate[] = [];
  const dropped: Array<{ candidate: Candidate; reason: string }> = [];
  for (const c of candidates) {
    const normUrl = normalizeUrl(c.url);
    const host = normalizeHost(c.url);
    const product = c.sourceName.trim().toLowerCase();
    if (seenUrls.has(normUrl)) {
      dropped.push({ candidate: c, reason: `exact URL already in corpus/prior sources: ${c.url}` });
      continue;
    }
    if (seenHosts.has(host)) {
      dropped.push({ candidate: c, reason: `domain already in corpus/prior sources: ${host}` });
      continue;
    }
    if (seenProducts.has(product)) {
      dropped.push({ candidate: c, reason: `product name already in corpus/prior sources: ${c.sourceName}` });
      continue;
    }
    seenUrls.add(normUrl);
    seenHosts.add(host);
    seenProducts.add(product);
    kept.push(c);
  }
  return { kept, dropped };
}

/** Capture-batch-compatible source entry (subset of capture.ts SourceConfig). */
export type CaptureSource = {
  url: string;
  sourceName: string;
  skipAutoConsent?: boolean;
  note?: string;
};

/** Build the capture-batch array from accepted candidates, preserving scout rationale. */
export function buildCaptureSources(
  accepted: Array<{ candidate: Candidate; score?: SuitabilityScore | null }>,
): CaptureSource[] {
  const sources: CaptureSource[] = accepted.map(({ candidate, score }) => {
    const tags: string[] = [];
    if (candidate.expectedPattern) tags.push(`expectedPattern=${candidate.expectedPattern}`);
    if (candidate.expectedCategories?.length) tags.push(`expectedCategories=${candidate.expectedCategories.join("+")}`);
    if (candidate.expectedStyleTags?.length) tags.push(`expectedStyleTags=${candidate.expectedStyleTags.join("+")}`);
    if (candidate.cautionary) tags.push("cautionary");
    if (score?.verdict) tags.push(`scoutVerdict=${score.verdict}(${score.suitability}/5)`);
    const tagLine = tags.length ? ` [${tags.join(", ")}]` : "";
    const note = (candidate.rationale ? `${candidate.rationale}` : "") + tagLine;
    return {
      url: candidate.url,
      sourceName: candidate.sourceName,
      skipAutoConsent: candidate.cautionary ? true : undefined,
      note: note.trim() || undefined,
    };
  });
  return sources;
}

/** Acceptance rule — a score passes when the model calls it suitable at 3+. */
export function decideAcceptance(score: SuitabilityScore): { accepted: boolean; reason: string } {
  if (score.verdict === "suitable" && score.suitability >= 3) {
    return { accepted: true, reason: `suitable (${score.suitability}/5)` };
  }
  if (score.verdict === "unsuitable") {
    return { accepted: false, reason: `unsuitable (${score.suitability}/5)` };
  }
  return { accepted: false, reason: `uncertain (${score.suitability}/5) — manual review` };
}

export function slugify(input: string): string {
  return captureSlug(input) || "candidate";
}

// ============================================================
// Runtime: verification, screenshots, vision scoring
// ============================================================

async function fetchWithHopGuard(url: string, maxHops = 5): Promise<Response> {
  let current = url;
  let res: Response;
  for (let hop = 0; ; hop++) {
    await assertSafeNavigationTarget(current);
    res = await fetch(current, {
      redirect: "manual",
      headers: { "user-agent": "clean-ui-scout/0.1 (+corpus discovery; contact: local)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (!location || hop >= maxHops) return res;
      current = new URL(location, current).toString();
      continue;
    }
    return res;
  }
}

/**
 * Read at most `maxBytes` of a response body, then abort the stream. Bounds
 * memory against a model-proposed URL that returns a huge body — `res.text()`
 * would buffer the whole thing before any slice.
 */
export async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  // A null-body response has no content to read — `res.text()` would buffer
  // whatever follows unbounded, defeating the cap. Nothing to extract from.
  if (!body) return "";
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.length;
        if (total >= maxBytes) break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(concatBytes(chunks)).slice(0, maxBytes);
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

function extractMeta(html: string): { title: string | null; description: string | null } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const descMatch = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  return {
    title: (titleMatch?.[1] ?? ogTitle?.[1] ?? "").trim().slice(0, 200) || null,
    description: (descMatch?.[1] ?? "").trim().slice(0, 300) || null,
  };
}

export async function verifyCandidate(candidate: Candidate): Promise<Verification> {
  const base: Verification = {
    url: candidate.url,
    sourceName: candidate.sourceName,
    reachable: false,
    status: null,
    finalUrl: null,
    title: null,
    description: null,
    robotsAllowed: false,
    screenshotPath: null,
    error: null,
  };
  try {
    await assertSafeNavigationTarget(candidate.url);
  } catch (err) {
    base.error = `SSRF/URL guard: ${err instanceof Error ? err.message : String(err)}`;
    return base;
  }
  try {
    base.robotsAllowed = await isAllowedByRobots(candidate.url);
  } catch (err) {
    base.error = `robots.txt check failed: ${err instanceof Error ? err.message : String(err)}`;
    return base;
  }
  if (!base.robotsAllowed) {
    base.error = "robots.txt disallows capture";
    return base;
  }
  try {
    const res = await fetchWithHopGuard(candidate.url);
    base.status = res.status;
    base.finalUrl = res.url;
    if (!isReachableStatus(res.status)) {
      base.error = `HTTP ${res.status ?? "unknown"}`;
      return base;
    }
    // Only the first 64 KB is ever used (title/meta live in the head), so read
    // at most that plus a small margin instead of buffering the whole body. A
    // model-proposed URL returning a multi-GB response would otherwise OOM the
    // curator process — `await res.text()` buffers it all before the slice.
    const text = await readCapped(res, 96 * 1024);
    const meta = extractMeta(text.slice(0, 64 * 1024));
    base.title = meta.title;
    base.description = meta.description;
    base.reachable = true;
    return base;
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
    return base;
  }
}

async function captureScreenshot(url: string, outPath: string): Promise<boolean> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      deviceScaleFactor: 1,
      colorScheme: "light",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    // SSRF guard on EVERY navigation and subresource, installed BEFORE goto —
    // exactly as capture.ts does (`:986`, `:1203`). This is a SEPARATE request
    // from verifyCandidate's fetch: Chromium re-resolves DNS and follows
    // redirects itself, so a candidate that answered 200 to the scout's fetch
    // could still 302 headless-Chrome to http://169.254.169.254/ (cloud
    // metadata) or http://localhost, or embed an internal subresource, and the
    // response would render into the screenshot on disk. No allowed-local-origin
    // is passed: candidate URLs are model-supplied, never operator-chosen, so
    // nothing local is legitimate here.
    await installSsrfGuard(page);
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: outPath as `${string}.png` });
    await context.close();
    return true;
  } finally {
    await browser.close();
  }
}

export function buildScoringPrompt(args: {
  candidate: Candidate;
  verification: Verification;
  gaps: GapTarget[];
}): string {
  const targetLines = args.gaps.map((g) => `- ${g.dimension} "${g.value}" (${g.count} in corpus)`).join("\n");
  const expected = args.candidate.expectedPattern ?? "any";
  return `You are a design curator for a corpus of exceptional real-product UI screenshots.
This screenshot was proposed to fill these corpus gaps:
${targetLines}

Proposal: ${args.candidate.sourceName} (${args.candidate.url})
Proposed pattern: ${expected}
Page title: ${args.verification.title ?? "unknown"}
Description: ${args.verification.description ?? "none"}

Judge whether this page is worth adding to the corpus as a real, instructive UI example.
The corpus values SPECIFIC design decisions (what works, what to avoid) — a page qualifies if it
clearly demonstrates at least one notable UI pattern, not if it merely exists.

Return ONLY valid JSON, no markdown fences, no extra keys:
{
  "suitability": <1-5>,
  "verdict": "suitable" | "unsuitable" | "uncertain",
  "matchesGap": <true|false>,
  "reasons": ["<1-3 concrete reasons based on what you see>"],
  "proposedPattern": "<one of the target pattern values, or the closest real one>",
  "proposedCategories": ["<closest categories>"],
  "proposedStyleTags": ["<closest style tags>"],
  "cautionary": <true|false>
}
Score guidance: 5 = exceptional exemplar of the gap; 4 = solid, worth capturing; 3 = acceptable,
has at least one stealable decision; 2 = generic/weak; 1 = not a real UI page or unusable.
Use "cautionary": true for genuinely bad-but-instructive pages (they belong in the cautionary tier).`;
}

export function parseScore(url: string, raw: string): SuitabilityScore | null {
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  const suitability = Number(p.suitability);
  const verdict = p.verdict;
  if (![1, 2, 3, 4, 5].includes(suitability) || !["suitable", "unsuitable", "uncertain"].includes(String(verdict))) {
    return null;
  }
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
  const strs = (v: unknown): string[] | undefined => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean) : undefined;
  return {
    url,
    suitability,
    verdict: verdict as SuitabilityScore["verdict"],
    matchesGap: p.matchesGap === true,
    reasons: strs(p.reasons) ?? [],
    proposedPattern: str(p.proposedPattern),
    proposedCategories: strs(p.proposedCategories),
    proposedStyleTags: strs(p.proposedStyleTags),
    cautionary: p.cautionary === true,
    raw: raw.trim().slice(0, 500),
  };
}

// ============================================================
// Report + file output
// ============================================================

export function buildReport(args: {
  gaps: GapTarget[];
  generated: Candidate[];
  dropped: Array<{ candidate: Candidate; reason: string }>;
  verified: Array<{ candidate: Candidate; verification: Verification }>;
  rejected: Array<{ candidate: Candidate; score: SuitabilityScore }>;
  uncertain: Array<{ candidate: Candidate; score: SuitabilityScore }>;
  accepted: Array<{ candidate: Candidate; verification: Verification; score: SuitabilityScore | null }>;
  generatedDropped: Array<{ raw: unknown; reason: string }>;
  noVision: boolean;
  runId: string;
}): string {
  const lines: string[] = [];
  lines.push(`# Scout report — ${args.runId}`);
  lines.push("");
  lines.push(`Mode: ${args.noVision ? "metadata-only (--no-vision)" : "vision-scored"}`);
  lines.push("");
  lines.push("## Targeted gaps");
  lines.push("");
  for (const g of args.gaps) lines.push(`- ${g.dimension} **${g.value}** — ${g.count} in corpus`);
  lines.push("");
  lines.push(`## Accepted (${args.accepted.length}) → sources-scouted.json`);
  lines.push("");
  for (const { candidate, verification, score } of args.accepted) {
    lines.push(`### ${candidate.sourceName} — ${candidate.url}`);
    lines.push(`- Rationale: ${candidate.rationale || "(none given)"}`);
    lines.push(`- Verified: HTTP ${verification.status ?? "n/a"}, title="${verification.title ?? "n/a"}"`);
    if (score) {
      lines.push(`- Scout verdict: ${score.verdict} ${score.suitability}/5, matchesGap=${score.matchesGap}`);
      for (const r of score.reasons) lines.push(`  - ${r}`);
    }
    lines.push("");
  }
  if (!args.accepted.length) lines.push("(none)");
  lines.push("");
  lines.push(`## Uncertain — manual review (${args.uncertain.length})`);
  lines.push("");
  for (const { candidate, score } of args.uncertain) {
    lines.push(`- ${candidate.sourceName} (${candidate.url}) — ${score.verdict} ${score.suitability}/5: ${score.reasons.join("; ") || "no reasons"}`);
  }
  if (!args.uncertain.length) lines.push("(none)");
  lines.push("");
  lines.push(`## Rejected by vision (${args.rejected.length})`);
  lines.push("");
  for (const { candidate, score } of args.rejected) {
    lines.push(`- ${candidate.sourceName} (${candidate.url}) — ${score.verdict} ${score.suitability}/5: ${score.reasons.join("; ") || "no reasons"}`);
  }
  if (!args.rejected.length) lines.push("(none)");
  lines.push("");
  lines.push(`## Dropped before scoring (${args.dropped.length})`);
  lines.push("");
  for (const { candidate, reason } of args.dropped) lines.push(`- ${candidate.sourceName} (${candidate.url}) — ${reason}`);
  if (!args.dropped.length) lines.push("(none)");
  lines.push("");
  if (args.generatedDropped.length) {
    lines.push(`## Generation-time drops (${args.generatedDropped.length})`);
    lines.push("");
    for (const { raw, reason } of args.generatedDropped) {
      const preview = typeof raw === "string" ? raw.slice(0, 120) : JSON.stringify(raw).slice(0, 120);
      lines.push(`- ${reason}: ${preview}`);
    }
    lines.push("");
  }
  lines.push("## Next steps");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run capture-batch -- sources-scouted.json");
  lines.push("npm run review-draft");
  lines.push("npm run commit-draft");
  lines.push("```");
  return lines.join("\n");
}

// ============================================================
// CLI
// ============================================================

function usage(): string {
  return `
Usage: node dist/scripts/scout-sources.js [options]

Discovery agent for the clean-ui corpus. Generates candidate product URLs from
coverage gaps, verifies + dedupes them, vision-scores suitability, and writes
capture-batch-ready sources-scouted.json.

Options:
  --limit <n>             max accepted sources (default 10)
  --max-candidates <n>    cap on LLM-generated candidates (default 12)
  --pattern <p>           target a patternType (repeatable)
  --category <c>          target a category (repeatable)
  --style <s>             target a styleTag (repeatable)
  --industry <i>          target an industryVertical (repeatable)
  --candidates-file <p>   skip LLM generation; load candidates from a JSON file
  --no-vision             skip screenshots + vision scoring (metadata-only)
  --dry-run               stop after gap analysis + candidate generation
  --out <dir>             output directory (default: repo root)
  --run-id <id>           run id used in output filenames (default: timestamp)
  --provider <p>          generation provider override
  --vision-provider <p>   vision-scoring provider override
  --corpus <path>         corpus entries.json path (default: corpus/entries.json)
  -h, --help              show this help
`;
}

function parseCli(argv: string[]): ScoutCliOptions {
  const { values } = parseArgs({
    args: argv,
    options: {
      "limit": { type: "string" },
      "max-candidates": { type: "string" },
      "pattern": { type: "string", multiple: true },
      "category": { type: "string", multiple: true },
      "style": { type: "string", multiple: true },
      "industry": { type: "string", multiple: true },
      "candidates-file": { type: "string" },
      "no-vision": { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      "out": { type: "string" },
      "run-id": { type: "string" },
      "provider": { type: "string" },
      "vision-provider": { type: "string" },
      "corpus": { type: "string" },
      "help": { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    console.log(usage());
    process.exit(0);
  }
  const num = (v: string | undefined, fallback: number): number => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
  };
  return {
    limit: num(values.limit, 10),
    maxCandidates: num(values["max-candidates"], 12),
    patterns: values.pattern ?? [],
    categories: values.category ?? [],
    styles: values.style ?? [],
    industries: values.industry ?? [],
    candidatesFile: values["candidates-file"] ?? null,
    noVision: values["no-vision"] === true,
    dryRun: values["dry-run"] === true,
    outDir: values.out ? resolve(process.cwd(), values.out) : REPO_ROOT,
    runId: values["run-id"] ?? new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14),
    provider: values.provider ?? null,
    visionProvider: values["vision-provider"] ?? null,
    corpusPath: values.corpus ? resolve(process.cwd(), values.corpus) : DEFAULT_CORPUS_PATH,
  };
}

async function loadCorpus(path: string): Promise<CorpusEntry[]> {
  const raw = JSON.parse(await fs.readFile(path, "utf8")) as { entries?: CorpusEntry[] };
  return Array.isArray(raw.entries) ? raw.entries : [];
}

/** Resolve provider + endpoint override from SCOUT_* env (generation) or SCOUT_VISION_* (scoring). */
function resolveModelConfig(prefix: "SCOUT" | "SCOUT_VISION"): {
  provider: Provider | undefined;
  endpoint: EndpointOverride | undefined;
} {
  const provider = (process.env[`${prefix}_PROVIDER`] ?? "").trim();
  const baseUrl = (process.env[`${prefix}_BASE_URL`] ?? "").trim();
  const apiKey = (process.env[`${prefix}_API_KEY`] ?? "").trim();
  const model = (process.env[`${prefix}_MODEL`] ?? "").trim();
  const valid: Provider[] = ["openai", "claude", "gemini", "mistral", "minimax", "grok"];
  if (provider && valid.includes(provider as Provider)) {
    // Only the OpenAI-compatible branch honors a pinned {baseUrl, apiKey, model}
    // triple (validateEndpointOverride rejects it for claude/gemini/...). For
    // other providers, pass the provider name alone and let env resolve the model.
    const endpoint: EndpointOverride | undefined = baseUrl || apiKey || model
      ? provider === "openai"
        ? { provider, baseUrl: baseUrl || undefined, apiKey: apiKey || undefined, model: model || undefined }
        : undefined
      : undefined;
    return { provider: provider as Provider, endpoint };
  }
  return { provider: undefined, endpoint: undefined };
}

async function generateCandidates(args: {
  gaps: GapTarget[];
  existing: { products: string[]; hosts: string[] };
  maxCandidates: number;
  patterns: string[];
  categories: string[];
  styles: string[];
  provider: string | null;
}): Promise<{ kept: Candidate[]; dropped: Array<{ raw: unknown; reason: string }>; attempts: number }> {
  const prompt = buildGenerationPrompt({
    gaps: args.gaps,
    existing: args.existing,
    maxCandidates: args.maxCandidates,
    patterns: args.patterns,
    categories: args.categories,
    styles: args.styles,
  });
  const cfg = resolveModelConfig("SCOUT");
  const provider = (args.provider as Provider | null) ?? cfg.provider;
  let attempts = 0;
  let last: string | null = null;
  for (let i = 0; i < 2; i++) {
    attempts++;
    const raw = await callTextModel(prompt, provider, i === 0 ? undefined : "Your previous response was not valid JSON. Return ONLY the JSON array, no markdown fences, no prose.", cfg.endpoint);
    last = raw;
    const parsed = parseCandidates(raw);
    if (parsed.kept.length > 0) {
      return { kept: parsed.kept, dropped: parsed.dropped, attempts };
    }
  }
  return { kept: [], dropped: last ? [{ raw: last, reason: "both attempts unparseable" }] : [{ raw: null, reason: "no model response" }], attempts };
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  const entries = await loadCorpus(opts.corpusPath);
  console.log(`[scout] corpus: ${entries.length} entries`);

  const targets: Array<{ dimension: GapDimension; value: string }> = [
    ...opts.patterns.map((value) => ({ dimension: "patternType" as const, value })),
    ...opts.categories.map((value) => ({ dimension: "category" as const, value })),
    ...opts.styles.map((value) => ({ dimension: "styleTag" as const, value })),
    ...opts.industries.map((value) => ({ dimension: "industryVertical" as const, value })),
  ];
  const gaps = computeGaps(entries, targets);
  console.log("[scout] top gaps:");
  for (const g of gaps.slice(0, 12)) console.log(`  - ${g.dimension} ${g.value} (${g.count})`);

  const existing = existingCorpusIdentity(entries);

  // 1. Candidates
  let candidates: Candidate[] = [];
  let generatedDropped: Array<{ raw: unknown; reason: string }> = [];
  if (opts.candidatesFile) {
    const parsed = await parseCandidatesFile(opts.candidatesFile);
    candidates = parsed.kept;
    generatedDropped = parsed.dropped;
    console.log(`[scout] loaded ${candidates.length} candidates from ${opts.candidatesFile}`);
  } else {
    const gen = await generateCandidates({
      gaps: gaps.slice(0, 16),
      existing,
      maxCandidates: opts.maxCandidates,
      patterns: [...new Set([...opts.patterns, ...gaps.filter((g) => g.dimension === "patternType").slice(0, 6).map((g) => g.value)])],
      categories: [...new Set([...opts.categories, ...gaps.filter((g) => g.dimension === "category").slice(0, 6).map((g) => g.value)])],
      styles: [...new Set([...opts.styles, ...gaps.filter((g) => g.dimension === "styleTag").slice(0, 6).map((g) => g.value)])],
      provider: opts.provider,
    });
    candidates = gen.kept;
    generatedDropped = gen.dropped;
    console.log(`[scout] generated ${candidates.length} candidates (${gen.attempts} attempt(s))`);
  }

  // 2. Dedupe
  const deduped = dedupeCandidates(candidates, entries);
  console.log(`[scout] dedupe: kept ${deduped.kept.length}, dropped ${deduped.dropped.length}`);
  for (const d of deduped.dropped.slice(0, 10)) console.log(`  drop: ${d.candidate.sourceName} — ${d.reason}`);

  if (opts.dryRun) {
    const report = buildReport({
      gaps,
      generated: candidates,
      generatedDropped,
      dropped: deduped.dropped,
      verified: [],
      rejected: [],
      uncertain: [],
      accepted: [],
      noVision: true,
      runId: opts.runId,
    });
    mkdirSync(opts.outDir, { recursive: true });
    writeFileSync(resolve(opts.outDir, `scout-report-${opts.runId}.md`), report);
    console.log(`[scout] dry-run complete — report at ${resolve(opts.outDir, `scout-report-${opts.runId}.md`)}`);
    console.log(`[scout] generated candidates (not verified): ${deduped.kept.map((c) => `${c.sourceName} ${c.url}`).join(" | ")}`);
    return;
  }

  // 3. Verify
  const verified: Array<{ candidate: Candidate; verification: Verification }> = [];
  const droppedBeforeScoring: Array<{ candidate: Candidate; reason: string }> = [];
  for (const candidate of deduped.kept) {
    const v = await verifyCandidate(candidate);
    if (v.reachable && v.robotsAllowed) {
      verified.push({ candidate, verification: v });
    } else {
      droppedBeforeScoring.push({ candidate, reason: v.error ?? "verification failed" });
    }
  }
  console.log(`[scout] verified ${verified.length}/${deduped.kept.length}`);

  // 4. Screenshot + vision score (unless --no-vision)
  const accepted: Array<{ candidate: Candidate; verification: Verification; score: SuitabilityScore | null }> = [];
  const rejected: Array<{ candidate: Candidate; score: SuitabilityScore }> = [];
  const uncertain: Array<{ candidate: Candidate; score: SuitabilityScore }> = [];

  if (opts.noVision) {
    for (const { candidate, verification } of verified) {
      if (accepted.length >= opts.limit) break;
      if (!metadataAcceptable(verification)) {
        droppedBeforeScoring.push({
          candidate,
          reason: "metadata-only mode requires an extracted title (non-HTML page?)",
        });
        continue;
      }
      accepted.push({ candidate, verification, score: null });
    }
  } else {
    const scoutDir = join(PRIVATE_IMAGE_DIR, "scout", opts.runId);
    mkdirSync(scoutDir, { recursive: true });
    const cfg = resolveModelConfig("SCOUT_VISION");
    const visionProvider = (opts.visionProvider as Provider | null) ?? cfg.provider;
    for (const { candidate, verification } of verified.slice(0, opts.limit)) {
      const imagePath = join(scoutDir, `${slugify(candidate.sourceName)}.png`);
      let screenshotOk = false;
      try {
        screenshotOk = await captureScreenshot(candidate.url, imagePath);
      } catch (err) {
        console.log(`[scout] screenshot failed for ${candidate.sourceName}: ${err instanceof Error ? err.message : String(err)}`);
      }
      verification.screenshotPath = screenshotOk ? imagePath : null;
      if (!screenshotOk) {
        droppedBeforeScoring.push({ candidate, reason: "screenshot failed — skipped vision scoring" });
        continue;
      }
      const prompt = buildScoringPrompt({ candidate, verification, gaps });
      let score: SuitabilityScore | null = null;
      try {
        let raw = await callVisionModel(prompt, imagePath, visionProvider, undefined, cfg.endpoint, "low");
        score = parseScore(candidate.url, raw);
        if (!score) {
          raw = await callVisionModel(
            prompt,
            imagePath,
            visionProvider,
            "Your previous response was not valid JSON. Return ONLY the JSON object, no markdown fences.",
            cfg.endpoint,
            "low",
          );
          score = parseScore(candidate.url, raw);
        }
      } catch (err) {
        console.log(`[scout] vision scoring failed for ${candidate.sourceName}: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!score) {
        droppedBeforeScoring.push({ candidate, reason: "vision scoring returned no usable verdict" });
        continue;
      }
      const decision = decideAcceptance(score);
      if (decision.accepted) {
        accepted.push({ candidate, verification, score });
        console.log(`[scout] accept ${candidate.sourceName} — ${decision.reason}`);
      } else if (score.verdict === "unsuitable") {
        rejected.push({ candidate, score });
        console.log(`[scout] reject ${candidate.sourceName} — ${decision.reason}`);
      } else {
        uncertain.push({ candidate, score });
        console.log(`[scout] uncertain ${candidate.sourceName} — ${decision.reason}`);
      }
    }
  }

  // 5. Output
  mkdirSync(opts.outDir, { recursive: true });
  const sources = buildCaptureSources(accepted);
  const sourcesPath = resolve(opts.outDir, "sources-scouted.json");
  const detailsPath = resolve(opts.outDir, "scout-details.json");
  const reportPath = resolve(opts.outDir, `scout-report-${opts.runId}.md`);
  writeFileSync(sourcesPath, JSON.stringify(sources, null, 2) + "\n");
  writeFileSync(detailsPath, JSON.stringify({
    runId: opts.runId,
    gaps,
    accepted: accepted.map(({ candidate, verification, score }) => ({ candidate, verification, score })),
    rejected,
    uncertain,
    droppedBeforeScoring,
    dedupedDropped: deduped.dropped,
    generatedDropped,
  }, null, 2) + "\n");
  const report = buildReport({
    gaps,
    generated: candidates,
    generatedDropped,
    dropped: [...deduped.dropped, ...droppedBeforeScoring],
    verified,
    rejected,
    uncertain,
    accepted,
    noVision: opts.noVision,
    runId: opts.runId,
  });
  writeFileSync(reportPath, report);
  console.log(`\n[scout] accepted ${accepted.length}, rejected ${rejected.length}, uncertain ${uncertain.length}`);
  console.log(`[scout] sources → ${sourcesPath}`);
  console.log(`[scout] report  → ${reportPath}`);
  console.log(`[scout] details → ${detailsPath}`);
  console.log("\nNext: npm run capture-batch -- sources-scouted.json");
}

const isMain = (() => {
  const here = process.argv[1] && resolve(process.argv[1]);
  const me = fileURLToPath(import.meta.url);
  return here === me;
})();

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
