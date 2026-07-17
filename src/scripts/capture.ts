#!/usr/bin/env node
import "../env.js";
/**
 * capture.ts — screenshot capture pipeline for clean-ui-mcp
 *
 * Two entry modes from one file:
 *
 *   1. Single-shot (backward-compatible with the old puppeteer script):
 *
 *        npm run capture -- --url "https://linear.app" --slug "linear-landing-2026"
 *
 *      Saves exactly one PNG to corpus/images-private/<slug>.png and prints
 *      just the path to stdout. Preserves the npm run workflow chain:
 *
 *        npm run workflow   # capture → add-entry, plumbed via stdout path
 *
 *   2. Batch (sophisticated website-crawl mode, multiple sections per page):
 *
 *        npm run capture-batch -- sources.json [outDir]
 *
 *      Reads a sources.json describing one or more sites, walks each page
 *      detecting landmarks/sections/repeated-groups, and writes a batch
 *      folder under corpus/images-private/captures/{batchId}/ containing:
 *        - {captureId}.png        one per detected section
 *        - manifest.json          CaptureMeta[] for the tagger to consume
 *        - triage.json            { [captureId]: "pending" } for the review UI
 *        - dom-signals.json       { [captureId]: DomSignals } page-derived ground
 *                                 truth (styles/structure/copy/a11y) extracted at
 *                                 capture time. Private artifact — lazy-loaded by
 *                                 the tagger; not committed to the public corpus.
 *
 * Pipeline rules (every one traces to a specific dry-run finding):
 *   1. robots.txt check (heise.de)               — hard gate, not a warning
 *   2. navigate + settle + lazy-load scroll        — round.ai / cursor.com
 *   3. consent-modal capture + dismissal           — healthline.com
 *   4. anchor-ID boundary scan (bonus signal)       — round.ai
 *   5. Pass A: landmark + anchor sections           — round.ai / cursor.com
 *   6. Pass B: repeated sibling groups (parent-scoped) — round.ai / cursor.com
 *   7. Pass C: recursive descent into oversized sections — cursor.com hero
 *   8. visibility filter throughout                 — healthline.com breakpoints
 *   9. scripted full-screen interactions (optional)  — auth/checkout/modal states
 *  10. dual-viewport pass (desktop + mobile)
 *  11. perceptual-hash dedup before anything touches disk
 *  12. manifest.json + triage.json for the tagger/review pipeline
 *
 * Security: every URL (single-shot and batch) passes through assertSafeCaptureTarget
 * from ../ssrf.ts — the same guard /api/capture-url uses. Without this, any
 * page could ask the curator to screenshot http://169.254.169.254/... and
 * read the resulting file path back.
 */

import { existsSync, mkdirSync, promises as fs, readdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve, dirname, join, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createHash } from "node:crypto";
import { chromium, type Browser, type BrowserContext, type Page, type Locator } from "playwright";
import sharp from "sharp";
import { assertSafeCaptureTarget, assertSafeNavigationTarget, installSsrfGuard, localOriginIfLocal } from "../ssrf.js";
import { normalizeMotionDeclarations, type DomMotionInput } from "../dom-motion.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRIVATE_IMAGE_DIR = resolve(__dirname, "..", "..", "corpus", "images-private");

// ============================================================
// Shared types
// ============================================================

type Viewport = { name: string; width: number; height: number };
// All possible viewports the pipeline knows how to capture. The actual set
// used for a given run is filtered by CAPTURE_VIEWPORTS below — defaults to
// both desktop and mobile, but a curator who only wants one (e.g. just
// desktop while building out the web corpus, deferring mobile until later)
// can set CAPTURE_VIEWPORTS=desktop in .env or the shell environment.
const ALL_VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const VIEWPORTS: Viewport[] = (() => {
  const wanted = (process.env.CAPTURE_VIEWPORTS ?? "desktop,mobile")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const filtered = ALL_VIEWPORTS.filter((v) => wanted.includes(v.name));
  // If the env named zero recognized viewports (typo, etc.), fall back to all
  // rather than silently producing zero captures — that's a confusing failure
  // mode (batch "succeeds" with empty manifest).
  return filtered.length > 0 ? filtered : ALL_VIEWPORTS;
})();

/** A scripted interaction that reveals a full-screen-mode pattern (auth,
 *  checkout, modal, empty-state) that doesn't exist until you cause it.
 *  Auto-discovering "click the signup button" reliably across arbitrary sites
 *  isn't a solved problem, and guessing wrong risks real side effects. */
type ScriptedInteraction = {
  label: string;
  steps: Array<
    | { action: "click"; selector: string }
    | { action: "fill"; selector: string; value: string }
    | { action: "waitFor"; selector: string; timeoutMs?: number }
    | { action: "wait"; ms: number }
  >;
  captureSelector?: string;
};

type SourceConfig = {
  url: string;
  sourceName: string;
  authStatePath?: string;
  interactions?: ScriptedInteraction[];
  skipAutoConsent?: boolean;
};

export type CaptureMode = "section" | "group-member" | "recursive" | "full-screen" | "consent-modal";

/**
 * DOM signals — page-derived context extracted at capture time to give the
 * tagger ground truth beyond the screenshot pixels: computed styles, layout
 * structure, on-screen copy, and accessibility signals. Written to a
 * dom-signals.json sidecar (keyed by capture id); NOT persisted on the manifest
 * (which stays lean). Optional — absent when extraction fails or the capture is
 * an isolated component crop with no product context.
 *
 * Capped to keep the sidecar small and avoid prompt-injection surface:
 * copy items ≤ 20, each ≤ 200 chars; style/structure fields are summaries, not
 * raw CSS. All extraction is best-effort — a failure returns null and never
 * invalidates the screenshot capture.
 */
export type DomSignalStyles = {
  color: string | null;
  background: string | null;
  fontFamily: string | null;
  fontSize: string | null;
  fontWeight: string | null;
  letterSpacing: string | null;
  borderRadius: string | null;
  boxShadow: string | null;
  outline: string | null;
};
export type DomSignalCopyItem = { tag: string; text: string };
export type DomSignalAccessibility = {
  contrastRatio: number | null;       // foreground/background of primary text block
  headingLevels: number[];            // e.g. [1, 2, 2, 3] — order of h1-h6 found
  imagesMissingAlt: number;
  unlabeledInteractive: number;       // buttons/links/inputs with no accessible name
  hasSkipLink: boolean;
};
export type DomSignalStructure = {
  display: string | null;             // primary container display (flex/grid/block)
  flexDirection: string | null;
  gridTemplateColumns: string | null;
  gap: string | null;
  childCount: number;                 // direct children of the captured root
};
export type DomSignals = {
  styles: DomSignalStyles;
  copy: DomSignalCopyItem[];
  accessibility: DomSignalAccessibility;
  structure: DomSignalStructure;
  motion?: DomSignalMotion;
};

export type DomSignalMotion = {
  signals: Array<{
    selector: string;
    property: string;
    durationMs: number;
    delayMs: number;
    iterationCount?: string;
    timingFunction?: string;
  }>;
  coverage: "full" | "partial" | "none";
  inaccessibleStylesheets: number;
  prefersReducedMotion: boolean;
};

export type CaptureMeta = {
  id: string;
  sourceUrl: string;
  sourceName: string;
  captureMode: CaptureMode;
  selectorPath: string;
  viewport: string;
  capturedAt: string;
  aHash: string;
  /** Corpus-relative path under images-private/ — satisfies the schema's
   *  ^(images-private|images-public)/... regex so the entry validates. */
  imagePath: string;
  width: number;
  height: number;
  /** True when a dom-signals.json entry exists for this capture. Set by
   *  runBatchCapture at manifest-write time; not populated per-capture. */
  hasDomSignals?: boolean;
};

const MIN_CAPTURE_AREA = 2500; // 50x50px — secondary guard for small-but-square fragments
// Per-axis floor — catches slivers area alone misses (e.g. a 12×249 bar-chart
// bar passes 2500px² on area but is unusable as a corpus entry). Applied at
// both the detection stage (group members) and the screenshot stage (defense
// in depth, in case live layout differs from detected bounding box by the
// time the screenshot fires).
const MIN_CAPTURE_DIM = 40;
// Group-member candidates (Pass B) — repeated sibling elements like cards in
// a grid. The first run on linear.app produced dozens of <40px icon fragments
// and 12×249 chart-bar slivers because the only filter was a height floor.
// Tightened to: both axes ≥80px AND longest:shortest side ≤8:1. The 80px
// floor matches section-mode's minH exactly — keeps group captures consistent
// with section captures on what counts as "big enough to be a UI unit" and
// drops the small-card group captures that triage had to filter out by hand.
// The 8:1 cap drops thin slivers but (acknowledged trade-off) also drops legit
// wide bars; the latter are rare as group members and triage can recover
// anything important.
const MIN_GROUP_DIM = 80;
const MAX_GROUP_ASPECT = 8;
// Minimum viewport-height fraction for section captures (Pass A). Closes the
// asymmetry in the section filter — width already had a fractional floor
// (vw * 0.5) but height had only a fixed pixel floor (minH=80) plus a
// fractional cap (vh * 2). Without a fractional height floor, a section only
// 11% of viewport tall (e.g. a 1392×112 Vercel announcement bar at desktop)
// passed because it cleared 80px — but a strip that thin isn't a meaningful
// UI section, and triage was rejecting these by hand.
//
// 0.12 empirically validated against the linear.app + vercel.com batch:
// drops the 6 sub-12% captures (small group fragments + thin announcement
// bars) while keeping the 3 captures between 12–25% VH that ARE real
// sections. On a 900px desktop viewport, 0.12 = 108px (above the existing
// 80px fixed floor, which becomes redundant at desktop but stays useful for
// mobile where 12% of 844 = 101px). Applied to section captures only;
// group members already have the 80px floor + 8:1 aspect cap.
const MIN_VH_FRAC = 0.12;
const DEDUP_HAMMING_THRESHOLD = 6; // of 64 bits — near-duplicate cutoff

// ============================================================
// Helpers
// ============================================================

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

/**
 * CSS-escape an identifier for use in a CSS selector, mirroring the browser's
 * `CSS.escape()` for the cases this file produces (anchor IDs read out of
 * href="#..." attributes — often contain dots, colons, brackets, leading
 * digits, or other characters that aren't valid in a bare CSS identifier).
 *
 * Used in NODE code (page.locator(`#${escapeCssId(id)}`)) — the in-page
 * DETECT_SCRIPT still uses the browser-native CSS.escape, which is correct
 * because page.evaluate runs in the browser. The previous version called the
 * browser-only `CSS.escape` here too, which threw a ReferenceError (CSS is
 * undefined outside the browser), got caught at the viewport loop, and
 * silently skipped every section/group/interaction capture for that viewport
 * whenever a page had any anchor ID. Bug surfaced in PR review.
 *
 * Implements the omittable-char + code-point cases from
 * https://www.w3.org/TR/cssom-1/#serialize-an-identifier — sufficient for the
 * DOM-sourced IDs we feed it; not a full implementation of every edge case.
 */
function escapeCssId(id: string): string {
  let out = "";
  for (let i = 0; i < id.length; i++) {
    const ch = id.charCodeAt(i);
    // NULL → replacement; high-surrogate/codepoint → \XXXXXX; control chars → escaped
    if (ch === 0) {
      out += "\uFFFD";
    } else if (ch < 0x20 || ch === 0x7f) {
      out += "\\" + ch.toString(16) + " ";
    } else if (
      (ch >= 0x30 && ch <= 0x39) ||    // 0-9
      (ch >= 0x41 && ch <= 0x5a) ||    // A-Z
      (ch >= 0x61 && ch <= 0x7a) ||    // a-z
      ch === 0x5f || ch === 0x2d       // _ -
    ) {
      // First char must not be a digit (would make an invalid ident); escape it.
      if (i === 0 && ch >= 0x30 && ch <= 0x39) out += "\\" + ch.toString(16) + " ";
      else out += id[i];
    } else {
      // Special-characters that need backslash escaping in a CSS identifier.
      // Hex-escape to be safe across the rest of Unicode.
      out += "\\" + id[i];
    }
  }
  return out;
}

async function aHashOf(buffer: Buffer): Promise<string> {
  // 8x8 grayscale average hash — cheap, dependency-light, sufficient for the
  // near-duplicate problem (repeated card/list captures from Pass B).
  const { data } = await sharp(buffer)
    .resize(8, 8, { fit: "fill" })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const avg = data.reduce((s, v) => s + v, 0) / data.length;
  let bits = "";
  for (const v of data) bits += v > avg ? "1" : "0";
  return BigInt("0b" + bits).toString(16).padStart(16, "0");
}

function hammingHex(a: string, b: string): number {
  let x = BigInt("0x" + a) ^ BigInt("0x" + b);
  let dist = 0;
  while (x > 0n) { dist += Number(x & 1n); x >>= 1n; }
  return dist;
}

// Sanitize an id/batchId so untrusted input can't escape the captures/ dir.
// Mirrors the slugify discipline used by ui-server.ts and the old capture.ts.
function safeId(...parts: string[]): string {
  return parts.map(slug).filter(Boolean).join("-") || "capture";
}

/**
 * Short, filesystem-safe fingerprint for a CSS selector path. Selectors built
 * by cssPath() in DETECT_SCRIPT can chain up to 6 nodes' tag+classes, which
 * slug()'d directly into an id/filename regularly exceeded 200+ characters —
 * broke on extraction (zip/tar "File name too long") and bloated triage.json
 * keys. The full selector is preserved separately as selectorPath in the
 * manifest; the id only needs to be unique and stable, not human-readable.
 */
function selectorFingerprint(selector: string): string {
  return createHash("sha1").update(selector).digest("hex").slice(0, 10);
}

// ============================================================
// 1. robots.txt — hard gate (heise.de)
// ============================================================

async function isAllowedByRobots(targetUrl: string): Promise<boolean> {
  const u = new URL(targetUrl);
  const robotsUrl = `${u.protocol}//${u.host}/robots.txt`;
  let body = "";
  try {
    // SSRF: follow redirects MANUALLY and re-run the navigation guard against
    // each Location header before fetching it. redirect:"follow" previously let
    // a robots.txt 302 to http://169.254.169.254/... through unchecked. We cap
    // at 3 hops; beyond that we treat robots as missing (return true — the
    // existing fail-open default for transient/odd servers). A redirect whose
    // target fails SSRF policy also bails to fail-open: we never fetch it, and
    // the caller's own assertSafeCaptureTarget already gated the capture URL.
    let currentUrl = robotsUrl;
    let res = await fetch(currentUrl, { redirect: "manual" });
    let hops = 0;
    while (res.status >= 300 && res.status < 400 && hops < 3) {
      const location = res.headers.get("location");
      if (!location) break;
      const nextUrl = new URL(location, currentUrl).toString();
      try {
        await assertSafeNavigationTarget(nextUrl);
      } catch {
        // Redirect points at a blocked/private target — refuse to follow.
        return true;
      }
      currentUrl = nextUrl;
      res = await fetch(currentUrl, { redirect: "manual" });
      hops++;
    }
    if (res.status >= 300 && res.status < 400) return true; // too many hops — fail-open
    if (!res.ok) return true;
    body = await res.text();
  } catch {
    return true;
  }
  const lines = body.split("\n").map((l) => l.trim());
  let inWildcard = false;
  const disallows: string[] = [];
  for (const line of lines) {
    if (/^user-agent:\s*\*/i.test(line)) { inWildcard = true; continue; }
    if (/^user-agent:/i.test(line)) { inWildcard = false; continue; }
    if (inWildcard) {
      const m = line.match(/^disallow:\s*(.*)$/i);
      if (m && m[1] !== undefined) disallows.push(m[1].trim());
    }
  }
  const targetPath = u.pathname || "/";
  return !disallows.some((d) => d.length > 0 && targetPath.startsWith(d));
}

// ============================================================
// 3. Consent modal detection (healthline.com)
// ============================================================

const CONSENT_VENDORS: Array<{
  name: string;
  bannerSelector: string;
  acceptSelector: string;
  inIframe?: boolean;
}> = [
  { name: "OneTrust", bannerSelector: "#onetrust-banner-sdk", acceptSelector: "#onetrust-accept-btn-handler" },
  { name: "Cookiebot", bannerSelector: "#CybotCookiebotDialog", acceptSelector: "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll" },
  { name: "Quantcast", bannerSelector: ".qc-cmp2-container", acceptSelector: '.qc-cmp2-summary-buttons button[mode="primary"]' },
  { name: "Sourcepoint", bannerSelector: 'iframe[id^="sp_message_iframe"]', acceptSelector: 'button[title="Accept all"]', inIframe: true },
];

async function captureAndDismissConsent(
  page: Page,
  outDir: string,
  batchId: string,
  source: SourceConfig,
  viewport: Viewport,
  pushIfNew: (m: CaptureMeta) => void,
): Promise<void> {
  for (const vendor of CONSENT_VENDORS) {
    const banner = page.locator(vendor.bannerSelector).first();
    const visible = await banner.isVisible().catch(() => false);
    if (!visible) continue;
    const meta = await captureLocator(banner, outDir, batchId, {
      id: safeId(source.sourceName, "consent", vendor.name),
      sourceUrl: source.url,
      sourceName: source.sourceName,
      captureMode: "consent-modal",
      selectorPath: vendor.bannerSelector,
      viewport: viewport.name,
    });
    if (meta) pushIfNew(meta);
    // Sourcepoint renders the accept button inside an <iframe>; search the top
    // page AND every frame for it. Other vendors' buttons live in the top page.
    const targets: Array<Page | ReturnType<Page["frame"]>> = vendor.inIframe
      ? [page, ...page.frames()]
      : [page];
    for (const target of targets) {
      if (!target) continue;
      const btn = target.locator(vendor.acceptSelector).first();
      if (await btn.isVisible().catch(() => false)) {
        await btn.click().catch(() => {});
        await page.waitForTimeout(400);
        break;
      }
    }
    return;
  }
}

// ============================================================
// 2. Navigate + settle + lazy-load scroll
// ============================================================

async function waitAndLazyLoadPage(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
  // Trigger lazy-loaded content (cursor.com finding: scroll-linked animations
  // would otherwise be captured mid-transition; this pass only forces mount).
  await page.evaluate(async () => {
    const step = window.innerHeight * 0.8;
    let y = 0;
    const max = document.body.scrollHeight;
    while (y < max) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 250));
      y += step;
    }
    window.scrollTo(0, 0);
    await new Promise((r) => setTimeout(r, 250));
  });
}

async function freezePageMotion(page: Page): Promise<void> {
  // Freeze motion so a screenshot doesn't land mid-fade — corrupts the
  // deterministic color quantization the tagger depends on.
  await page.addStyleTag({
    content: `*, *::before, *::after {
      animation-duration: 0s !important;
      animation-delay: 0s !important;
      transition-duration: 0s !important;
      transition-delay: 0s !important;
      scroll-behavior: auto !important;
    }`,
  }).catch(() => {});
  await page.waitForTimeout(300);
}

async function settlePage(page: Page): Promise<void> {
  // Backward-compat wrapper — convenience for callers (e.g. single-shot mode)
  // that don't need to interleave motion collection between the two phases.
  await waitAndLazyLoadPage(page);
  await freezePageMotion(page);
}

// ============================================================
// 4. Anchor-ID boundary scan (round.ai bonus signal)
// ============================================================

async function anchorSectionIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const ids = new Set<string>();
    document.querySelectorAll('header a[href^="#"], nav a[href^="#"]').forEach((a) => {
      const href = a.getAttribute("href") || "";
      const id = href.slice(1);
      if (id && document.getElementById(id)) ids.add(id);
    });
    return [...ids];
  });
}

// ============================================================
// 5–8. Section + group detection
// ============================================================

type Candidate = { selector: string; area: number; height: number };

const DETECT_SCRIPT = `
(function(rootSelector, minWidthFrac, minH, maxHFrac, minVFrac) {
  function cssPath(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && parts.length < 6) {
      let sel = node.tagName.toLowerCase();
      if (node.classList.length) sel += '.' + [...node.classList].slice(0, 2).map(c => CSS.escape(c)).join('.');
      const parent = node.parentElement;
      if (parent) {
        const siblings = [...parent.children].filter(c => c.tagName === node.tagName);
        if (siblings.length > 1) sel += ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')';
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  function isVisible(el) {
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }
  const vw = window.innerWidth, vh = window.innerHeight;
  const root = document.querySelector(rootSelector) || document.body;
  const landmarkSel = 'header, nav, main, section, article, footer, aside, [role="region"], [role="main"], [role="navigation"]';
  const landmarks = [...root.querySelectorAll(landmarkSel)].filter(isVisible);
  function toCandidate(el) {
    const r = el.getBoundingClientRect();
    return { el, selector: cssPath(el), area: r.width * r.height, height: r.height, top: r.top, left: r.left, width: r.width };
  }
  let candidates = landmarks.map(toCandidate).filter(c =>
    c.width >= vw * minWidthFrac
    // Section height: must clear both the fixed pixel floor (minH, kept for
    // backward compat and for unusually short viewports) AND a fraction of the
    // viewport (minVFrac). The fractional floor is the one that does real work
    // — see MIN_VH_FRAC's doc comment for the asymmetry this closes.
    && c.height >= minH
    && c.height >= vh * minVFrac
    && c.height <= vh * maxHFrac
  );
  candidates.sort((a, b) => b.area - a.area);
  const kept = [];
  for (const c of candidates) {
    const containedInKept = kept.some(k => {
      const overlapW = Math.max(0, Math.min(c.left + c.width, k.left + k.width) - Math.max(c.left, k.left));
      const overlapH = Math.max(0, Math.min(c.top + c.height, k.top + k.height) - Math.max(c.top, k.top));
      return (overlapW * overlapH) / c.area > 0.9;
    });
    if (!containedInKept) kept.push(c);
  }
  const groups = [];
  const seenParents = new Set();
  // Exclude everything INSIDE an <svg> from Pass B. Decorative illustrations
  // (Linear's animated icon graphics, for instance) are built from many
  // same-tag <path>/<g> siblings that satisfy the "repeated sibling" test
  // just as well as real card/list grids do, so without this guard the walk
  // below individually captures each path segment of a single icon as its
  // own "group-member" — content-free slivers, not corpus candidates. The
  // outer <svg> itself is still eligible (it's not inside another <svg>), so
  // whole illustrations are still captured as one unit.
  const isInsideSvg = (el) => !!(el.parentElement && el.parentElement.closest('svg'));
  const minGroupDim = %MINGROUPDIM%;
  const maxGroupAspect = %MAXGROUPASPECT%;
  const allEls = [...root.querySelectorAll('*')].filter(el => !isInsideSvg(el));
  for (const el of allEls) {
    const parent = el.parentElement;
    if (!parent || seenParents.has(parent)) continue;
    const sameTagSiblings = [...parent.children].filter(c => c.tagName === el.tagName);
    if (sameTagSiblings.length < 2) continue;
    const sig = (n) => n.tagName + '.' + [...n.classList].sort().join('.');
    const baseSig = sig(el);
    const group = sameTagSiblings.filter(n => sig(n) === baseSig && isVisible(n));
    if (group.length >= 2) {
      seenParents.add(parent);
      const groupCandidates = group.map(toCandidate).filter(c => {
        // Height-only floor (the original check) let thin slivers through —
        // e.g. a single 12x249 bar-chart bar passed minH=80 on height alone.
        // Require both axes to clear a floor, and cap the aspect ratio so an
        // isolated bar/rule/divider can't pass just by being "tall enough".
        if (c.width < minGroupDim || c.height < minGroupDim) return false;
        const longSide = Math.max(c.width, c.height);
        const shortSide = Math.max(1, Math.min(c.width, c.height));
        return longSide / shortSide <= maxGroupAspect;
      });
      if (groupCandidates.length >= 2) groups.push(groupCandidates);
    }
  }
  const oversized = kept.filter(c => c.height > vh * 1.5).map(c => c.selector);
  return {
    sections: kept.map(c => ({ selector: c.selector, area: c.area, height: c.height })),
    groups: groups.map(g => g.map(c => ({ selector: c.selector, area: c.area, height: c.height }))),
    oversized,
  };
})(%ROOT%, %MINW%, %MINH%, %MAXHFRAC%, %MINVHFRAC%)
`;

async function detect(page: Page, rootSelector: string) {
  const script = DETECT_SCRIPT
    .replace("%ROOT%", JSON.stringify(rootSelector))
    .replace("%MINW%", "0.5")
    .replace("%MINH%", "80")
    .replace("%MAXHFRAC%", "2")
    .replace("%MINVHFRAC%", String(MIN_VH_FRAC))
    .replace("%MINGROUPDIM%", String(MIN_GROUP_DIM))
    .replace("%MAXGROUPASPECT%", String(MAX_GROUP_ASPECT));
  return page.evaluate(script) as Promise<{
    sections: Candidate[];
    groups: Candidate[][];
    oversized: string[];
  }>;
}

// ============================================================
// Capture helpers
// ============================================================

// ─── DOM signals extraction ──────────────────────────────────────────────────
// Runs in the browser via locator.evaluate while the element handle is alive
// (right after the screenshot). Extracts computed styles, structure, on-screen
// copy, and accessibility signals — page-derived ground truth the tagger can't
// reliably read from pixels alone. Best-effort + hard-timed: a failure or
// timeout returns null and never invalidates the capture. Capped to keep the
// sidecar small (copy ≤ 20 items × 200 chars) and limit prompt-injection risk.
const DOM_SIGNALS_TIMEOUT_MS = 3000;
const DOM_SIGNALS_MAX_COPY = 20;
const DOM_SIGNALS_MAX_COPY_CHARS = 200;

async function extractDomSignals(locator: Locator): Promise<DomSignals | null> {
  // Race the evaluate against a hard timeout — a pathological page can hang
  // getComputedStyle across many elements. evaluate() has no built-in timeout,
  // so Promise.race is the only way to bound it. The losing promise (the
  // evaluate, if the timer wins) keeps running in the background but its
  // result is discarded; that's acceptable since the locator is about to be
  // dropped anyway. The earlier version awaited evaluate directly and only
  // *appeared* to race — it blocked past the timeout on heavy pages.
  const evaluate = locator.evaluate((root) => {
      const MAX_COPY = 20;
      const MAX_COPY_CHARS = 200;
      const cs = window.getComputedStyle(root);
      // Primary text block = first element with non-trivial text under root.
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let textEl: Element | null = null;
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const el = node as Element;
        const t = (el.textContent || "").trim();
        if (t.length >= 3 && t.length <= 200) { textEl = el; break; }
      }
      const textCs = textEl ? window.getComputedStyle(textEl) : cs;
      const textBgEl = textEl || root;
      // Approximate contrast ratio from fg/bg colors of the primary text block.
      const toRgb = (str: string): [number, number, number] | null => {
        const m = str.match(/rgba?\((\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
        return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
      };
      const relLum = (rgb: [number, number, number]) => {
        const [r, g, b] = rgb.map((c) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); }) as [number, number, number];
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const fg = toRgb(textCs.color);
      const bg = toRgb(textCs.backgroundColor || textCs.background);
      let contrastRatio: number | null = null;
      if (fg && bg) {
        const l1 = relLum(fg), l2 = relLum(bg);
        const lighter = Math.max(l1, l2), darker = Math.min(l1, l2);
        contrastRatio = +((lighter + 0.05) / (darker + 0.05)).toFixed(2);
      }
      // Heading levels (order of h1-h6 found within root).
      const headingLevels: number[] = [];
      root.querySelectorAll("h1,h2,h3,h4,h5,h6").forEach((h) => {
        const lvl = Number(h.tagName[1]);
        if (lvl >= 1 && lvl <= 6) headingLevels.push(lvl);
      });
      // Images missing alt + unlabeled interactive (no accessible name).
      let imagesMissingAlt = 0;
      root.querySelectorAll("img").forEach((img) => { if (!img.hasAttribute("alt")) imagesMissingAlt++; });
      let unlabeledInteractive = 0;
      root.querySelectorAll("button, a, input, [role='button']").forEach((el) => {
        const name = (el.getAttribute("aria-label") || el.getAttribute("title") || (el.textContent || "").trim() || el.getAttribute("placeholder") || "").trim();
        if (!name) unlabeledInteractive++;
      });
      // On-screen copy: headings, buttons, links, role=button.
      const copy: { tag: string; text: string }[] = [];
      const copySel = "h1, h2, h3, h4, h5, h6, button, a, [role='button']";
      root.querySelectorAll(copySel).forEach((el) => {
        if (copy.length >= MAX_COPY) return;
        const text = (el.textContent || "").trim().slice(0, MAX_COPY_CHARS);
        if (text) copy.push({ tag: el.tagName.toLowerCase(), text });
      });
      // Skip link detection.
      const hasSkipLink = !!root.querySelector('a[href^="#"]:is([class*="skip"], [class*="sr-only"])')
        || !!document.querySelector('a[href^="#main"], a[href^="#content"]');
      return {
        styles: {
          color: cs.color || null,
          background: cs.backgroundColor || null,
          fontFamily: cs.fontFamily || null,
          fontSize: cs.fontSize || null,
          fontWeight: cs.fontWeight || null,
          letterSpacing: cs.letterSpacing || null,
          borderRadius: cs.borderRadius || null,
          boxShadow: cs.boxShadow && cs.boxShadow !== "none" ? cs.boxShadow : null,
          outline: cs.outline && cs.outline !== "none" ? cs.outline : null,
        },
        copy,
        accessibility: { contrastRatio, headingLevels, imagesMissingAlt, unlabeledInteractive, hasSkipLink },
        structure: {
          display: cs.display || null,
          flexDirection: cs.flexDirection || null,
          gridTemplateColumns: cs.gridTemplateColumns && cs.gridTemplateColumns !== "none" ? cs.gridTemplateColumns : null,
          gap: cs.gap && cs.gap !== "normal" ? cs.gap : null,
          childCount: root.children.length,
        },
      } as DomSignals;
    }).catch((err: unknown) => {
      console.warn("[dom-signals] extraction failed:", err instanceof Error ? err.message : err);
      return null;
    });
  // Race against a timeout. The timer MUST be cleared when evaluate wins,
  // otherwise every successful extraction logs a false "timed out" warning
  // DOM_SIGNALS_TIMEOUT_MS later — noisy and misleading in batch logs.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<DomSignals | null>((resolve) => {
    timer = setTimeout(() => { console.warn("[dom-signals] extraction timed out"); resolve(null); }, DOM_SIGNALS_TIMEOUT_MS);
  });
  try {
    return await Promise.race([evaluate, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ─── Motion declarations collection ───────────────────────────────────────────
// Reads AUTHORED stylesheet rules (document.styleSheets → cssRules), NOT computed
// styles. Why: the browser context is launched with reducedMotion:"reduce", so
// getComputedStyle reflects the reduced-motion cascade and suppresses transitions
// — useless for detecting what the author actually declared. Authored rules are
// cascade-independent. Collection is scoped per capture-root (the locator's DOM
// subtree) so a cropped capture only carries motion evidence for elements that
// appear in the screenshot. Best-effort: returns null on failure. Cross-origin
// stylesheets throw SecurityError on cssRules access and are counted as
// inaccessible (surfaced as coverage metadata) rather than failing the capture.
type CollectedMotion = {
  inputs: DomMotionInput[];
  prefersReducedMotion: boolean;
  inaccessibleStylesheets: number;
};

async function collectMotionDeclarations(locator: Locator): Promise<CollectedMotion | null> {
  return locator.evaluate((root: Element) => {
    const MAX_ELEMENTS = 50;
    const MOTION_PROPS = [
      "transitionDuration", "transitionProperty", "transitionDelay", "transitionTimingFunction",
      "animationDuration", "animationName", "animationIterationCount", "animationDelay",
      "animationTimingFunction",
    ] as const;
    const interactiveSel =
      "button, a, input, select, textarea, [role='button'], [role='link'], [role='tab'], [onclick], details, summary";
    const selectorHint = (el: Element): string => {
      const tag = el.tagName.toLowerCase();
      const role = el.getAttribute("role");
      const testId = el.getAttribute("data-testid");
      return `${tag}${role ? `[role=${role}]` : ""}${testId ? `[data-testid=${testId}]` : ""}`;
    };

    // Gather authored rules once (page-wide). Matching rule.selectorText against
    // each element later scopes the evidence to the capture root.
    // Recursively walk grouping rules (@media, @supports, @layer, etc.) so
    // motion declarations inside media queries are not missed.
    let inaccessibleStylesheets = 0;
    const ruleStyles: { selectorText: string; style: Record<string, string> }[] = [];
    const walkRules = (rules: CSSRuleList | readonly CSSRule[]): void => {
      for (const rule of Array.from(rules)) {
        const r = rule as unknown as { selectorText?: string; style?: CSSStyleDeclaration; cssRules?: CSSRuleList };
        if (r.style && r.selectorText) {
          const styleRec: Record<string, string> = {};
          for (const prop of MOTION_PROPS) {
            const v = (r.style as unknown as Record<string, string>)[prop];
            if (v) styleRec[prop] = v;
          }
          if (Object.keys(styleRec).length > 0) ruleStyles.push({ selectorText: r.selectorText, style: styleRec });
        }
        // Recurse into grouping rules (@media, @supports, @layer, etc.)
        if (r.cssRules) walkRules(r.cssRules);
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try {
        walkRules(sheet.cssRules);
      } catch {
        // SecurityError on cross-origin sheets — can't read rules.
        inaccessibleStylesheets++;
      }
    }

    // Include root itself if it matches the interactive selector (P2-2 fix).
    const rootEl = root as Element;
    const rootMatches = rootEl.matches ? rootEl.matches(interactiveSel) : false;
    const childElements = Array.from(root.querySelectorAll(interactiveSel));
    // Dedupe root if it also appears in querySelectorAll results
    const elements = (rootMatches ? [rootEl, ...childElements.filter((e) => e !== rootEl)] : childElements).slice(0, MAX_ELEMENTS);
    const inputs: DomMotionInput[] = [];
    for (const el of elements) {
      // Merge authored declarations in document order (later rule wins), then
      // apply inline style overrides (inline has higher specificity). This is a
      // best-effort approximation of the cascade for motion longhands — enough
      // for signal detection, not a full cascade resolver.
      const acc: Record<string, string> = {};
      for (const { selectorText, style } of ruleStyles) {
        try { if (!el.matches(selectorText)) continue; } catch { continue; }
        for (const prop of MOTION_PROPS) {
          const v = style[prop];
          if (v) acc[prop] = v;
        }
      }
      const inline = (el as HTMLElement).style;
      for (const prop of MOTION_PROPS) {
        const v = (inline as unknown as Record<string, string>)[prop];
        if (v) acc[prop] = v;
      }
      if (Object.keys(acc).length === 0) continue; // no motion declared → skip
      inputs.push({ selector: selectorHint(el), ...acc });
    }

    const prefersReducedMotion =
      typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    return { inputs, prefersReducedMotion, inaccessibleStylesheets } as CollectedMotion;
  }).catch((err: unknown) => {
    console.warn("[dom-motion] collection failed:", err instanceof Error ? err.message : err);
    return null;
  });
}

async function captureLocator(
  locator: Locator,
  batchDir: string,
  batchId: string,
  info: { id: string; sourceUrl: string; sourceName: string; captureMode: CaptureMode; selectorPath: string; viewport: string },
  signalsMap?: Map<string, DomSignals>,
  motionRaw?: CollectedMotion | null,
): Promise<CaptureMeta | null> {
  const raw = await locator.screenshot({ timeout: 8000 }).catch(() => null);
  if (!raw) return null;

  // Lossless PNG — palette + max compression shrink file size meaningfully
  // without touching pixel values. Lossy would corrupt color quantization.
  const image = sharp(raw).png({ compressionLevel: 9, palette: true });
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  // Area alone doesn't catch slivers (a 12x249 sliver clears 2500px² on area
  // but is unusable as a corpus entry) — a per-axis floor is the actual guard;
  // area stays as a secondary check for small-but-square fragments the axis
  // floor wouldn't catch (e.g. a 45x45 icon crop).
  if (width < MIN_CAPTURE_DIM || height < MIN_CAPTURE_DIM || width * height < MIN_CAPTURE_AREA) return null;

  const buffer = await image.toBuffer();
  const aHash = await aHashOf(raw);
  const fileName = `${info.id}.png`;
  const absPath = join(batchDir, fileName);
  await fs.writeFile(absPath, buffer);

  // Corpus-relative path. batchDir is .../images-private/captures/{batchId},
  // so the relative form starts with images-private/ — satisfies the schema
  // regex and the validator's path-traversal guard.
  const relPath = `images-private/captures/${batchId}/${fileName}`;

  // Extract DOM signals now — the locator is guaranteed alive (we just screenshotted it).
  // Eager extraction (vs deferred-after-dedup) trades one extra evaluate per
  // rejected duplicate for correctness: a deferred closure would run on a
  // possibly-stale/detached element. The screenshot + sharp encode already
  // dominate per-candidate cost, so one evaluate is negligible. Best-effort;
  // null on failure/timeout. Stored in the sidecar map keyed by id; pushIfNew
  // deletes the entry (along with the PNG) when dedup rejects the capture.
  if (signalsMap) {
    const signals = await extractDomSignals(locator);
    if (signals) {
      // Attach motion signals. motionRaw is collected pre-freeze (authored
      // stylesheet rules are cascade-independent, so reading them before/after
      // the freeze styleTag doesn't matter — but collection must run before the
      // freeze so the in-page evaluate isn't racing the motion-suppressing CSS).
      if (motionRaw) {
        signals.motion = normalizeMotionDeclarations(motionRaw.inputs, {
          inaccessibleStylesheets: motionRaw.inaccessibleStylesheets,
          prefersReducedMotion: motionRaw.prefersReducedMotion,
        });
      }
      signalsMap.set(info.id, signals);
    }
  }

  return {
    ...info,
    aHash,
    width,
    height,
    imagePath: relPath,
    capturedAt: new Date().toISOString(),
  };
}

// ============================================================
// 9. Scripted full-screen interactions
// ============================================================

async function runInteraction(
  page: Page,
  interaction: ScriptedInteraction,
  batchDir: string,
  batchId: string,
  source: SourceConfig,
  viewport: Viewport,
): Promise<CaptureMeta | null> {
  for (const step of interaction.steps) {
    if (step.action === "click") await page.locator(step.selector).first().click({ timeout: 8000 }).catch(() => {});
    else if (step.action === "fill") await page.locator(step.selector).first().fill(step.value).catch(() => {});
    else if (step.action === "waitFor") await page.locator(step.selector).first().waitFor({ timeout: step.timeoutMs ?? 8000 }).catch(() => {});
    else if (step.action === "wait") await page.waitForTimeout(step.ms);
  }
  const target = interaction.captureSelector
    ? page.locator(interaction.captureSelector).first()
    : page.locator("body");
  const visible = await target.isVisible().catch(() => false);
  if (!visible) return null;
  return captureLocator(target, batchDir, batchId, {
    id: safeId(source.sourceName, interaction.label),
    sourceUrl: source.url,
    sourceName: source.sourceName,
    captureMode: "full-screen",
    selectorPath: interaction.captureSelector ?? "body",
    viewport: viewport.name,
  });
}

// ============================================================
// Orchestration: batch capture of one source
// ============================================================

async function captureSource(
  browser: Browser,
  source: SourceConfig,
  batchDir: string,
  batchId: string,
  seenHashes: Map<string, string>,
  signalsMap?: Map<string, DomSignals>,
): Promise<CaptureMeta[]> {
  // SSRF guard — same rule as /api/capture-url. Rejects metadata endpoints,
  // private IPs, and unresolvable hostnames before launching a browser.
  await assertSafeCaptureTarget(source.url);

  const allowed = await isAllowedByRobots(source.url);
  if (!allowed) {
    console.warn(`[skip] robots.txt disallows ${source.url}`);
    return [];
  }

  const results: CaptureMeta[] = [];
  const pushIfNew = (m: CaptureMeta) => {
    for (const [hash] of seenHashes) {
      if (hammingHex(hash, m.aHash) <= DEDUP_HAMMING_THRESHOLD) {
        fs.unlink(join(batchDir, basename(m.imagePath))).catch(() => {});
        signalsMap?.delete(m.id); // drop signals along with the PNG on dedup-reject
        return;
      }
    }
    seenHashes.set(m.aHash, m.imagePath);
    results.push(m);
  };

  for (const viewport of VIEWPORTS) {
    const contextOpts: Parameters<Browser["newContext"]>[0] = {
      viewport: { width: viewport.width, height: viewport.height },
      deviceScaleFactor: 1,
      reducedMotion: "reduce",
    };
    if (source.authStatePath) contextOpts.storageState = source.authStatePath;
    const context: BrowserContext = await browser.newContext(contextOpts);
    const page = await context.newPage();
    // SSRF per-hop guard — installed BEFORE page.goto so server redirects
    // (302→169.254.169.254 etc.) are intercepted and aborted. assertSafeCaptureTarget
    // above only checked the initial URL; this closes the redirect bypass.
    // Pass the local origin so local-dev captures of localhost load.
    await installSsrfGuard(page, localOriginIfLocal(source.url));

    try {
      await page.goto(source.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await waitAndLazyLoadPage(page);

      if (!source.skipAutoConsent) {
        await captureAndDismissConsent(page, batchDir, batchId, source, viewport, pushIfNew);
      }

      const anchorIds = await anchorSectionIds(page);

      // Build the full list of capture targets BEFORE any screenshotting, so the
      // ordering can be: (1) collect motion from every root while motion is still
      // running, (2) freeze motion, (3) screenshot each root while frozen. Motion
      // collection reads AUTHORED stylesheet rules (cascade-independent), so it's
      // unaffected by the freeze — but running it first is the safe, documented
      // contract and keeps the in-page evaluate from racing the suppress CSS.
      type CaptureTarget = {
        locator: Locator;
        info: {
          id: string;
          sourceUrl: string;
          sourceName: string;
          captureMode: CaptureMode;
          selectorPath: string;
          viewport: string;
        };
      };
      const targets: CaptureTarget[] = [];

      const collectFrom = async (rootSelector: string, mode: "section" | "recursive") => {
        const { sections, groups, oversized } = await detect(page, rootSelector);
        for (const sec of sections) {
          const loc = page.locator(sec.selector).first();
          if (!(await loc.isVisible().catch(() => false))) continue;
          targets.push({
            locator: loc,
            info: {
              id: safeId(source.sourceName, mode, selectorFingerprint(sec.selector), viewport.name),
              sourceUrl: source.url,
              sourceName: source.sourceName,
              captureMode: mode,
              selectorPath: sec.selector,
              viewport: viewport.name,
            },
          });
        }
        for (const group of groups) {
          const rep = group[0];
          const loc = page.locator(rep.selector).first();
          if (!(await loc.isVisible().catch(() => false))) continue;
          targets.push({
            locator: loc,
            info: {
              id: safeId(source.sourceName, "group", selectorFingerprint(rep.selector), viewport.name),
              sourceUrl: source.url,
              sourceName: source.sourceName,
              captureMode: "group-member",
              selectorPath: rep.selector,
              viewport: viewport.name,
            },
          });
        }
        for (const bigSelector of oversized) {
          if (bigSelector === rootSelector) continue;
          await collectFrom(bigSelector, "recursive");
        }
      };

      for (const id of anchorIds) {
        // escapeCssId (Node-side) — must NOT use the browser-only CSS.escape
        // here. See escapeCssId's doc comment for why.
        const loc = page.locator(`#${escapeCssId(id)}`).first();
        if (!(await loc.isVisible().catch(() => false))) continue;
        targets.push({
          locator: loc,
          info: {
            id: safeId(source.sourceName, "anchor", id, viewport.name),
            sourceUrl: source.url,
            sourceName: source.sourceName,
            captureMode: "section",
            selectorPath: `#${id}`,
            viewport: viewport.name,
          },
        });
      }

      await collectFrom("body", "section");

      // Pass 1 — collect motion declarations per root (pre-freeze). Keyed by the
      // same capture id captureLocator will use, so the normalized signal can be
      // attached at screenshot time. Best-effort: a null entry just means no
      // motion evidence for that root.
      const motionByRoot = new Map<string, CollectedMotion>();
      for (const target of targets) {
        const motion = await collectMotionDeclarations(target.locator);
        if (motion) motionByRoot.set(target.info.id, motion);
      }

      // Freeze motion now — AFTER all motion collection, BEFORE any screenshot,
      // so screenshots land on a static frame for deterministic color quantization.
      await freezePageMotion(page);

      // Pass 2 — capture each root while frozen. Motion data (collected pre-freeze)
      // is threaded into captureLocator, which normalizes it and attaches it to the
      // signals sidecar entry.
      for (const target of targets) {
        const meta = await captureLocator(
          target.locator, batchDir, batchId, target.info,
          signalsMap, motionByRoot.get(target.info.id) ?? null,
        ).catch(() => null);
        if (meta) pushIfNew(meta);
      }

      for (const interaction of source.interactions ?? []) {
        const meta = await runInteraction(page, interaction, batchDir, batchId, source, viewport);
        if (meta) pushIfNew(meta);
      }
    } catch (err) {
      console.error(`[error] ${source.url} @ ${viewport.name}:`, (err as Error).message);
    } finally {
      await context.close();
    }
  }

  return results;
}

async function runBatchCapture(sources: SourceConfig[], outRoot: string): Promise<void> {
  const batchId = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14);
  const batchDir = join(outRoot, "captures", batchId);
  await fs.mkdir(batchDir, { recursive: true });

  const browser = await chromium.launch();
  const seenHashes = new Map<string, string>();
  const manifest: CaptureMeta[] = [];
  // DOM signals sidecar — keyed by capture id. Populated by captureLocator
  // (eager extraction while the locator is alive); pushIfNew drops rejected
  // entries. Written to dom-signals.json so consumers (tagger) can lazy-load.
  const signalsMap = new Map<string, DomSignals>();

  try {
    for (const source of sources) {
      console.log(`[capture] ${source.sourceName} — ${source.url}`);
      // Isolate per-source failures (DNS resolution, HTTP errors, timeouts) so
      // one bad URL doesn't abort the entire batch and lose all prior captures.
      try {
        const metas = await captureSource(browser, source, batchDir, batchId, seenHashes, signalsMap);
        manifest.push(...metas);
        console.log(`  → ${metas.length} candidate(s) after dedup`);
      } catch (err) {
        console.error(`[error] ${source.url}: ${err instanceof Error ? err.message : err}`);
        console.log(`  → 0 candidate(s) (source failed)`);
      }
    }
  } finally {
    await browser.close();
  }

  // Stamp hasDomSignals on each manifest entry from the signals sidecar map.
  for (const m of manifest) m.hasDomSignals = signalsMap.has(m.id);

  await fs.writeFile(join(batchDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  // triage.json — one "pending" entry per candidate. The classic workbench's
  // promote/reject actions update this; cleanup runs only when no key is pending.
  const triage: Record<string, "pending"> = {};
  for (const m of manifest) triage[m.id] = "pending";
  await fs.writeFile(join(batchDir, "triage.json"), JSON.stringify(triage, null, 2));
  // dom-signals.json — id-keyed DOM signals sidecar. Always written (even if {})
  // so consumers don't need an existence check. Private capture artifact, like
  // triage.json — not committed to the public corpus.
  const signalsObj: Record<string, DomSignals> = {};
  for (const [id, sig] of signalsMap) signalsObj[id] = sig;
  await fs.writeFile(join(batchDir, "dom-signals.json"), JSON.stringify(signalsObj, null, 2));

  const sigCount = Object.keys(signalsObj).length;
  console.log(`\nWrote ${manifest.length} candidates to ${batchDir}/`);
  console.log(`  manifest.json feeds the tagger; triage.json feeds the review UI; dom-signals.json (${sigCount} w/ signals) feeds richer extraction.`);
}

// ============================================================
// Single-shot capture (backward-compat with the old puppeteer script)
// ============================================================

async function runSingleCapture(opts: {
  url: string;
  slug: string;
  width: number;
  height: number;
  fullPage: boolean;
  delay: number;
  selector?: string;
  dark: boolean;
}): Promise<string> {
  // SSRF guard — same rule as batch mode and /api/capture-url.
  await assertSafeCaptureTarget(opts.url);
  if (!(await isAllowedByRobots(opts.url))) {
    throw new Error(`robots.txt disallows ${opts.url}`);
  }

  mkdirSync(PRIVATE_IMAGE_DIR, { recursive: true });
  const safeSlug = slug(opts.slug) || "capture";
  const outputPath = resolve(PRIVATE_IMAGE_DIR, `${safeSlug}.png`);

  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: 2,
      colorScheme: opts.dark ? "dark" : "light",
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    // SSRF per-hop guard — installed BEFORE page.goto so server redirects are
    // intercepted and aborted (same protection as the batch path above).
    // Pass the local origin so local-dev captures of localhost load.
    await installSsrfGuard(page, localOriginIfLocal(opts.url));
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await settlePage(page);
    if (opts.delay > 0) await page.waitForTimeout(opts.delay);

    if (opts.selector) {
      const element = await page.$(opts.selector);
      if (!element) throw new Error(`Selector not found: ${opts.selector}`);
      await element.screenshot({ path: outputPath as `${string}.png` });
    } else {
      await page.screenshot({ path: outputPath as `${string}.png`, fullPage: opts.fullPage });
    }
    await context.close();
    return outputPath;
  } finally {
    await browser.close();
  }
}

// ============================================================
// CLI entry point — dispatches single-shot vs batch
// ============================================================

const isMain = (() => {
  const here = process.argv[1] && resolve(process.argv[1]);
  const me = fileURLToPath(import.meta.url);
  return here === me;
})();

if (isMain) {
  const first = process.argv[2];
  // Batch mode: argv[2] is a path to a .json sources file.
  if (first && !first.startsWith("-") && extname(first).toLowerCase() === ".json") {
    const configPath = first;
    const outDir = process.argv[3] ?? PRIVATE_IMAGE_DIR;
    if (!existsSync(configPath)) {
      console.error(`Sources file not found: ${configPath}`);
      process.exit(1);
    }
    const sources = JSON.parse(await fs.readFile(configPath, "utf-8")) as SourceConfig[];
    runBatchCapture(sources, outDir).catch((err) => {
      console.error(err);
      process.exit(1);
    });
  } else {
    // Single-shot mode — preserve the original puppeteer-script CLI contract.
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        url:        { type: "string" },
        slug:       { type: "string" },
        width:      { type: "string", default: "1440" },
        height:     { type: "string", default: "900" },
        "full-page": { type: "boolean", default: false },
        delay:      { type: "string", default: "2000" },
        selector:   { type: "string" },
        dark:       { type: "boolean", default: false },
        help:       { type: "boolean", short: "h", default: false },
      },
    });
    if (values.help || !values.url || !values.slug) {
      console.error(`
Usage:
  npm run capture -- --url <url> --slug <slug> [options]
  npm run capture-batch -- <sources.json> [outDir]

Single-shot options:
  --url         URL to screenshot (required)
  --slug        Output filename stem (required) — saved as <slug>.png
  --width       Viewport width px (default: 1440)
  --height      Viewport height px (default: 900)
  --full-page   Capture full scrollable page (default: false)
  --delay       Wait ms after load (default: 2000)
  --selector    CSS selector to screenshot specific element
  --dark        Use dark color scheme

Batch mode (sophisticated website crawl):
  Pass a path to a sources.json file describing one or more sites to crawl.
  See captureSource() and SourceConfig for the schema.

Example:
  npm run capture -- --url "https://linear.app" --slug "linear-landing-2026"
  npm run capture-batch -- sources.json
`);
      process.exit(1);
    }
    try {
      const outputPath = await runSingleCapture({
        url: values.url!,
        slug: values.slug!,
        width: parseInt(values.width ?? "1440"),
        height: parseInt(values.height ?? "900"),
        fullPage: values["full-page"],
        delay: parseInt(values.delay ?? "2000"),
        selector: values.selector,
        dark: values.dark,
      });
      console.error(`✅ Saved: ${outputPath}`);
      console.log(outputPath); // stdout: just the path, for chaining
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }
}

export {
  runSingleCapture, runBatchCapture,
  // captureSource is the full candidate-detection pipeline (consent, anchors,
  // recursive oversized, interactions, dedup, viewport loop). Exported so the
  // Add-entry flow's /api/capture-candidates endpoint reuses the SAME detection
  // as the batch CLI — no duplicated heuristics, no drift in tuning constants.
  // Aliased as captureCandidatesForSource to signal its general purpose.
  captureSource as captureCandidatesForSource,
  isAllowedByRobots, slug as captureSlug, escapeCssId, selectorFingerprint,
  MIN_GROUP_DIM, MAX_GROUP_ASPECT, MIN_VH_FRAC, DEDUP_HAMMING_THRESHOLD, VIEWPORTS,
  // Capture seam: collect authored motion declarations from a locator, then
  // freeze motion on a page. Exported for the dom-motion integration test,
  // which validates the collect-before-freeze ordering against a real browser.
  collectMotionDeclarations, freezePageMotion,
};
