#!/usr/bin/env node
import "../env.js";
/**
 * capture.ts
 * ───────────
 * Screenshot a live URL and save to corpus/images-private/.
 * Chains naturally into the add-entry workflow:
 *
 *   npm run capture -- --url "https://linear.app" --slug "linear-board-2026"
 *   npm run add-entry -- --image corpus/images-private/linear-board-2026.png \
 *     --product "Linear" --url "https://linear.app"
 *
 * Requires Chrome/Chromium installed on your system.
 * Set CHROME_PATH env var if it's not in a standard location.
 *
 * Options:
 *   --url        URL to screenshot (required)
 *   --slug       Output filename stem, saved as corpus/images-private/<slug>.png
 *   --width      Viewport width in px (default: 1440)
 *   --height     Viewport height in px (default: 900)
 *   --full-page  Capture full scrollable page, not just viewport (default: false)
 *   --delay      Wait ms after load before capturing (default: 2000)
 *   --selector   CSS selector to screenshot a specific element instead of full page
 *   --dark       Set prefers-color-scheme: dark before capturing
 */

import puppeteer from "puppeteer-core";
import { existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = resolve(__dirname, "..", "..", "corpus", "images-private");

// ─── args ─────────────────────────────────────────────────────────────────────

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

Options:
  --url         URL to screenshot (required)
  --slug        Output filename stem (required) — saved as <slug>.png
  --width       Viewport width px (default: 1440)
  --height      Viewport height px (default: 900)
  --full-page   Capture full scrollable page (default: false)
  --delay       Wait ms after load (default: 2000)
  --selector    CSS selector to screenshot specific element
  --dark        Use dark color scheme

CHROME_PATH env var: path to Chrome/Chromium binary if not auto-detected.

Example:
  npm run capture -- --url "https://linear.app" --slug "linear-landing-2026"
  npm run capture -- --url "https://vercel.com/dashboard" --slug "vercel-dashboard-dark" --dark
`);
  process.exit(1);
}

// ─── find Chrome ─────────────────────────────────────────────────────────────

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((p): p is string => !!p && existsSync(p));

if (CHROME_CANDIDATES.length === 0) {
  console.error(`
No Chrome/Chromium found. Install it or set CHROME_PATH env var to the binary.
  On macOS:  brew install --cask chromium
  On Ubuntu: sudo apt install chromium-browser
`);
  process.exit(1);
}

const chromePath = CHROME_CANDIDATES[0];
console.error(`Using browser: ${chromePath}`);

// ─── capture ─────────────────────────────────────────────────────────────────

mkdirSync(OUTPUT_DIR, { recursive: true });

// Sanitize the slug so an untrusted --slug value (e.g. "../../etc/foo")
// cannot write outside images-private/. Mirrors slugify() in ui-server.ts.
// toCorpusRelativePath in add-entry.ts would reject a traversal path
// downstream too, but constraining it at the write site is defense in depth.
function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-") || "capture";
}

const safeSlug = slugify(values.slug!);
const outputPath = resolve(OUTPUT_DIR, `${safeSlug}.png`);
const width  = parseInt(values.width  ?? "1440");
const height = parseInt(values.height ?? "900");
const delay  = parseInt(values.delay  ?? "2000");

console.error(`Launching browser…`);

const browser = await puppeteer.launch({
  executablePath: chromePath,
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-gpu",
  ],
});

try {
  const page = await browser.newPage();

  // Viewport + device scale
  await page.setViewport({ width, height, deviceScaleFactor: 2 }); // 2x = retina-quality

  // Dark mode if requested
  if (values.dark) {
    await page.emulateMediaFeatures([
      { name: "prefers-color-scheme", value: "dark" },
    ]);
  }

  // Block ads/trackers that would slow things down or add noise
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["font", "image", "stylesheet", "script"].includes(type)) {
      req.continue();
    } else if (type === "media") {
      req.abort(); // block video autoplay
    } else {
      req.continue();
    }
  });

  console.error(`Navigating to ${values.url}…`);
  await page.goto(values.url!, { waitUntil: "networkidle2", timeout: 30_000 });

  // Extra delay for JS-rendered UIs, animations to settle, etc.
  if (delay > 0) {
    console.error(`Waiting ${delay}ms for render to settle…`);
    await new Promise((r) => setTimeout(r, delay));
  }

  // Screenshot
  if (values.selector) {
    const element = await page.$(values.selector);
    if (!element) {
      console.error(`Selector not found: ${values.selector}`);
      await browser.close();
      process.exit(1);
    }
    await element.screenshot({ path: outputPath as `${string}.png` });
  } else {
    await page.screenshot({
      path: outputPath as `${string}.png`,
      fullPage: values["full-page"],
    });
  }

  console.error(`✅ Saved: ${outputPath}`);
  console.log(outputPath); // stdout: just the path, for chaining in scripts
} finally {
  await browser.close();
}
