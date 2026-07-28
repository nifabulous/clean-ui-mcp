// @vitest-environment node
//
// Public-site deployment + accessibility smoke tests (spec §13 + §10).
//
// These are true end-to-end checks against a built `site/dist` served by
// `vite preview` at the production base path (/clean-ui-mcp/). They are NOT the
// jsdom component tests — they exercise the real HTTP layer (base-path routing,
// asset resolution, snapshot + image delivery) and real keyboard/focus behavior.
//
// The suite mirrors the curator harness in src/scripts/ui-browser.test.ts:
// one shared Chromium instance + one shared preview server, launched in
// beforeAll and torn down in afterAll. Each test gets its own page (and, where
// viewport/emulation matters, its own context) so one failure cannot cascade.
//
// The node environment override at the top is required because the site
// vitest.config.ts defaults to jsdom (for the component suite). Playwright needs
// to spawn a real browser, so this file opts back into node. We deliberately do
// NOT use jest-dom matchers here (they are jsdom-only); assertions read text and
// attributes directly via Playwright's page/locator APIs + plain vitest expect.

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PRIVATE_MARKERS,
  fallbackArtifact,
  keywordMatchedArtifact,
  type ArtifactFixture,
} from "./create-ui-spec-fixture";

const SITE_ROOT = resolve(__dirname, "..");
const DIST_INDEX = resolve(SITE_ROOT, "dist", "index.html");

// The public corpus bundle is intentionally empty (see
// scripts/check-public-site-boundary.mjs): no entry images or per-entry evidence
// routes are served until a separately cleared collection exists. The browser
// suite therefore no longer deep-links a sample evidence id or asserts that a
// real entry image loads; instead it asserts the safe empty state and that NO
// observed request path escapes into /entries/.
const ENTRIES_PREFIX = "/entries/";

/**
 * Launch `vite preview` on an ephemeral port and resolve once it prints the URL.
 *
 * `--strictPort` + `--port 0` asks the OS for a free port and fails loudly if it
 * can't bind (instead of silently rolling to another port). Vite prints its
 * listening URL to stdout, which we parse.
 */
async function startPreviewServer(): Promise<{ baseUrl: string; proc: ChildProcess }> {
  const proc = spawn(
    process.execPath,
    [
      // Resolve the local vite binary (avoids assuming a global `vite`).
      resolve(SITE_ROOT, "..", "node_modules", "vite", "bin", "vite.js"),
      "preview",
      "--config",
      resolve(SITE_ROOT, "vite.config.ts"),
      "--port",
      "0",
      "--strictPort",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );

  const baseUrl = await new Promise<string>((resolveReady, rejectReady) => {
    let settled = false;
    const onLine = (chunk: Buffer): void => {
      if (settled) return;
      // Vite emits colored output in CI (e.g. a green URL followed by a
      // color-reset sequence). The raw \S+ match captures the trailing ANSI
      // bytes, so endsWith("/clean-ui-mcp") fails and the base path gets
      // appended twice — producing an invalid URL that sinks every browser
      // test. Strip VT control characters before matching. (Node ≥16.20 exposes
      // stripVTControlCharacters; CI runs Node 24.)
      const text = stripVTControlCharacters(chunk.toString());
      // vite preview prints e.g. "  ➜  Local:   http://localhost:4321/clean-ui-mcp/"
      const match = text.match(/https?:\/\/\S+/i);
      if (match) {
        // Normalize to the base path with a trailing slash.
        let url = match[0].replace(/\/+$/, "");
        if (!url.endsWith("/clean-ui-mcp")) url = `${url}/clean-ui-mcp`;
        settled = true;
        cleanup();
        resolveReady(`${url}/`);
      }
    };
    const onError = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectReady(err);
    };
    const onExit = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectReady(new Error(`vite preview exited before becoming ready (code ${code})`));
    };
    const cleanup = (): void => {
      proc.stdout?.off("data", onLine);
      proc.stderr?.off("data", onLine);
      proc.off("error", onError);
      proc.off("exit", onExit);
    };
    proc.stdout?.on("data", onLine);
    proc.stderr?.on("data", onLine);
    proc.on("error", onError);
    proc.on("exit", onExit);
  });

  return { baseUrl, proc };
}

let browser: Browser | undefined;
let baseUrl = "";
let previewProc: ChildProcess | undefined;

// Collect every 4xx/5xx response seen by a context so the "no 404s on assets /
// snapshot / images" assertions can run across a full navigation journey. Tests
// create their own context via newContext() which wires the listener.
function newTracingContext(
  options: Parameters<Browser["newContext"]>[0] = {},
): Promise<BrowserContext> {
  if (!browser) throw new Error("browser not initialized");
  return browser.newContext(options).then((ctx) => {
    const failed: Array<{ url: string; status: number }> = [];
    ctx.on("response", (response) => {
      const status = response.status();
      if (status >= 400) failed.push({ url: response.url(), status });
    });
    // Stash the collector on the context via a closure; expose via a property.
    (ctx as unknown as { __failed: typeof failed }).__failed = failed;
    return ctx;
  });
}

function failedOf(ctx: BrowserContext): Array<{ url: string; status: number }> {
  return (ctx as unknown as { __failed: Array<{ url: string; status: number }> }).__failed;
}

beforeAll(async () => {
  if (!readFileSync(DIST_INDEX, "utf-8").includes("/clean-ui-mcp/assets/")) {
    throw new Error(
      "site/dist is stale or missing. Run `npm run site:build` before the browser suite.",
    );
  }
  const started = await startPreviewServer();
  baseUrl = started.baseUrl;
  previewProc = started.proc;
  browser = await chromium.launch({ headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
  if (previewProc && previewProc.exitCode === null) {
    previewProc.kill("SIGTERM");
  }
});

/** Read the trimmed text of the first H1 in #root. */
async function rootH1Text(page: Page): Promise<string> {
  await page.waitForSelector("#root h1", { timeout: 15_000 });
  return page
    .locator("#root h1")
    .first()
    .textContent()
    .then((t) => (t ?? "").trim());
}

describe("public site — base-path deployment", () => {
  it("serves the homepage at the base path with HTTP 200 and the app root", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const response = await page.goto(baseUrl);
    expect(response?.status()).toBe(200);
    // The homepage H1 is the proof-led hero.
    expect(await rootH1Text(page)).toMatch(/design judgment for ai agents/i);
    // No asset/snapshot/image request failed.
    expect(failedOf(ctx)).toEqual([]);
    await ctx.close();
  });

  it("serves /clean-ui-mcp/playground as the C3 composer (no 404, no asset 404)", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const response = await page.goto(`${baseUrl}playground`);
    expect(response?.status()).toBe(200);
    // Direct nav to a client route must not 404 — index.html is served and the
    // SPA router mounts /playground. Wait for the lazy composer chunk to land.
    expect(await rootH1Text(page)).toMatch(/generate a grounded design handoff/i);
    expect(failedOf(ctx)).toEqual([]);
    await ctx.close();
  }, 30_000);

  it("serves /clean-ui-mcp/browse as the preserved corpus-search surface", async () => {
    // C3 Task 6 moved the search surface here. A 404 or a composer H1 at this
    // route would mean every shared search URL and every evidence back-link broke.
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const response = await page.goto(`${baseUrl}browse`);
    expect(response?.status()).toBe(200);
    expect(await rootH1Text(page)).toMatch(/search the critiqued corpus/i);
    expect(failedOf(ctx)).toEqual([]);
    await ctx.close();
  }, 30_000);

  it("round-trips the /browse query string through a real navigation", async () => {
    // The canonical URL contract (q / category / style / domain / platform) is
    // unchanged by the migration. Loading a fully-populated URL must restore the
    // query into the input and keep every parameter in the address bar.
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}browse?q=pricing&category=pricing&style=minimal&platform=web`);
    await rootH1Text(page);
    const input = page.getByLabel(/ask the corpus/i);
    await input.waitFor({ state: "visible", timeout: 30_000 });
    expect(await input.inputValue()).toBe("pricing");
    const url = page.url();
    for (const param of ["q=pricing", "category=pricing", "style=minimal", "platform=web"]) {
      expect(url).toContain(param);
    }
    // Still on /browse — never redirected into the composer.
    expect(url).toContain("/browse");
    await ctx.close();
  }, 45_000);

  it("forwards a previously-shareable /playground search URL to /browse", async () => {
    // `/playground?q=…` was the canonical shareable corpus-search URL before the
    // migration. Landing on the composer would silently discard every parameter,
    // so those URLs are forwarded with the query intact (review Minor 4).
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const response = await page.goto(`${baseUrl}playground?q=pricing&style=minimal`);
    expect(response?.status()).toBe(200);
    await rootH1Text(page);
    await page.getByLabel(/ask the corpus/i).waitFor({ state: "visible", timeout: 30_000 });

    const url = page.url();
    expect(url).toContain("/browse");
    expect(url).not.toContain("/playground");
    expect(url).toContain("q=pricing");
    expect(url).toContain("style=minimal");
    await ctx.close();
  }, 45_000);

  it("never serves a corpus entry asset (no /entries/ request across the journey)", async () => {
    // The public corpus bundle is intentionally empty until a separately cleared
    // collection exists. Across a home -> browse journey, NO observed request path
    // may start with /entries/ — that prefix is the disclosure boundary.
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await page.goto(baseUrl);
    await rootH1Text(page);

    await page.goto(`${baseUrl}browse`);
    await rootH1Text(page);

    const observed = await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => entry.name),
    );
    const leaking = observed.filter((url) =>
      url.includes(ENTRIES_PREFIX),
    );
    expect(leaking).toEqual([]);
    expect(failedOf(ctx)).toEqual([]);
    await ctx.close();
  }, 60_000);
});

// ─── Accessibility journeys (spec §10) ───────────────────────────────────────
//
// These cover the keyboard + AT contract the design system promises: skip link
// order, mobile-menu focus return, live-region announcement, theme persistence,
// reduced-motion respect, and no horizontal overflow at 320px.

describe("public site — accessibility journeys", () => {
  it("focuses the skip link first when tabbing from the URL bar", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await page.goto(baseUrl);
    await rootH1Text(page);
    // Press Tab from the top of the document. The first focusable element MUST
    // be the skip link (it is the first <a> in the DOM and is revealed on focus).
    await page.keyboard.press("Tab");
    const focused = await page.evaluate(() => {
      const active = document.activeElement;
      return active instanceof HTMLAnchorElement
        ? { tag: "a", text: active.textContent?.trim() ?? "", href: active.getAttribute("href") ?? "" }
        : { tag: active?.tagName?.toLowerCase() ?? "", text: "", href: "" };
    });
    expect(focused.text.toLowerCase()).toMatch(/skip to content/);
    expect(focused.href).toBe("#main-content");
    await ctx.close();
  });

  it("the skip link moves focus into the main landmark", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await page.goto(baseUrl);
    await rootH1Text(page);
    await page.getByRole("link", { name: /skip to content/i }).focus();
    await page.keyboard.press("Enter");
    // The main landmark is focusable (tabIndex={-1}); it should now hold focus.
    await page.waitForFunction(() => document.activeElement?.id === "main-content", null, {
      timeout: 3000,
    });
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("main-content");
    await ctx.close();
  });

  it("returns focus to the menu trigger when Escape closes the mobile menu", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    // Narrow viewport so the mobile disclosure menu is the active nav affordance.
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(baseUrl);
    await rootH1Text(page);

    const toggle = page.getByRole("button", { name: /toggle navigation menu/i });
    await toggle.click();
    expect(await toggle.getAttribute("aria-expanded")).toBe("true");

    // Escape must close the menu AND restore focus to the trigger (so keyboard
    // users aren't stranded at the end of the now-hidden list).
    await page.keyboard.press("Escape");
    expect(await toggle.getAttribute("aria-expanded")).toBe("false");
    await page.waitForFunction(
      () => {
        const active = document.activeElement;
        return active instanceof HTMLButtonElement
          && active.getAttribute("aria-label") === "Toggle navigation menu";
      },
      null,
      { timeout: 3000 },
    );
    await ctx.close();
  });

  it("announces the result count through a polite live region on Browse", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}browse`);
    await rootH1Text(page);
    // The result-count region (.browse__count) carries role=status +
    // aria-live=polite and announces the number of matches ONCE the snapshot
    // has loaded and the search index has run. While loading, a SEPARATE
    // role=status region (AsyncState) shows "Loading…" — so we must target the
    // count element specifically (not the generic [role=status], whose .first()
    // would resolve against the loading region and read "Loading…" too early).
    const count = page.locator(".browse__count[role='status'][aria-live='polite']");
    await count.waitFor({ state: "visible", timeout: 45_000 });
    const text = (await count.textContent()) ?? "";
    expect(text).toMatch(/\d+\s+(result|results)/);
    await ctx.close();
  }, 60_000);

  it("persists the chosen theme across a full reload", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await page.goto(baseUrl);
    await rootH1Text(page);

    // Toggle to a deterministic theme via the accessible control, then verify
    // the dataset flips and survives reload (the bootstrap script in index.html
    // reads localStorage before paint).
    const toggle = page.getByRole("button", { name: /switch to (dark|light) theme/i });
    await toggle.click();
    const afterClick = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
    expect(["light", "dark"]).toContain(afterClick);

    await page.reload();
    await rootH1Text(page);
    const afterReload = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
    expect(afterReload).toBe(afterClick);
    await ctx.close();
  }, 45_000);

  it("respects prefers-reduced-motion (no transition/animation duration > 0)", async () => {
    // Reduced-motion is honored at the CSS layer (shell.css + playground.css).
    // Emulate the preference and assert that no element exposes a perceptible
    // non-zero transition/animation duration in the computed style.
    //
    // Chromium serializes some reduced-motion-zeroed transitions as "1e-06s"
    // (sub-microsecond floating-point residue from CSS-custom-property math),
    // which is not perceptible motion. We parse the duration to seconds and
    // treat anything at or below a 1ms epsilon as zero — that catches real
    // regressions (e.g. a 200ms duration leaking through) while ignoring the
    // serialization noise.
    const ctx = await newTracingContext({ reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.goto(baseUrl);
    await rootH1Text(page);
    const offending = await page.evaluate(() => {
      const sel = "a, button, .theme-toggle, .nav-menu-toggle, .skip-link, .site-nav__link";
      // Parse a CSS time value like "0.2s", "200ms", or "1e-06s" into seconds.
      const toSeconds = (value: string): number => {
        const v = value.trim();
        if (v.endsWith("ms")) return parseFloat(v) / 1000;
        if (v.endsWith("s")) return parseFloat(v);
        return NaN; // keywords like "none"/"auto" — treat as zero motion
      };
      const EPSILON_SECONDS = 0.001; // 1ms — well below any perceptible transition
      const hits: string[] = [];
      document.querySelectorAll(sel).forEach((el) => {
        const cs = window.getComputedStyle(el);
        const td = toSeconds(cs.transitionDuration);
        const ad = toSeconds(cs.animationDuration);
        if (Number.isFinite(td) && td > EPSILON_SECONDS) {
          hits.push(`${el.tagName}: transition-duration ${cs.transitionDuration}`);
        }
        if (Number.isFinite(ad) && ad > EPSILON_SECONDS) {
          hits.push(`${el.tagName}: animation-duration ${cs.animationDuration}`);
        }
      });
      return hits;
    });
    expect(offending).toEqual([]);
    await ctx.close();
  });

  it("does not scroll horizontally at a 320px viewport", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 320, height: 568 });
    await page.goto(baseUrl);
    await rootH1Text(page);
    const overflow = await page.evaluate(() => {
      const doc = document.documentElement;
      return {
        scrollWidth: doc.scrollWidth,
        clientWidth: doc.clientWidth,
      };
    });
    // scrollWidth must not exceed clientWidth (no content off-screen to the right).
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    await ctx.close();
  });
});

// ─── The C3 composer (/playground) ───────────────────────────────────────────
//
// `vite preview` serves static files only, so `/api/*` is intercepted. The
// intercepted bytes are NOT hand-written: create-ui-spec-fixture.ts runs the real
// `handleCreateUiSpecHttp` adapter over an in-memory reader, so the browser
// receives exactly what the loopback route would write — hashes, both renderings
// and all. A hand-written stub is the failure mode this avoids.

const COMPOSER_BRIEF = "A calm analytics dashboard for a fintech operations team";
const NONCE = "0123456789abcdef".repeat(4);

interface ApiStub {
  /** Every intercepted request, in order. */
  readonly hits: Array<{ method: string; path: string; csrf: string | undefined }>;
}

/**
 * Intercept the composer's two API calls. `bodies` is a queue of
 * `{ status, body }` replies for `POST /api/create-ui-spec`; the last entry is
 * reused if the page posts more times than the queue has entries (so an
 * unexpected extra POST is still observable through `hits`).
 */
async function stubApi(
  page: Page,
  bodies: ReadonlyArray<{ status: number; body: string }>,
): Promise<ApiStub> {
  const hits: Array<{ method: string; path: string; csrf: string | undefined }> = [];
  let index = 0;

  await page.route("**/api/csrf", async (route) => {
    const request = route.request();
    hits.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      csrf: request.headers()["x-clean-ui-csrf"],
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json; charset=utf-8",
      body: JSON.stringify({ nonce: NONCE }),
    });
  });

  await page.route("**/api/create-ui-spec", async (route) => {
    const request = route.request();
    hits.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
      csrf: request.headers()["x-clean-ui-csrf"],
    });
    const reply = bodies[Math.min(index, bodies.length - 1)];
    index += 1;
    await route.fulfill({
      status: reply.status,
      contentType: "application/json; charset=utf-8",
      headers: { "cache-control": "no-store" },
      body: reply.body,
    });
  });

  return { hits };
}

/** The composer's live status text. */
function statusText(page: Page): Promise<string> {
  return page
    .locator(".outcome__status[role='status'][aria-live='polite']")
    .textContent()
    .then((t) => (t ?? "").trim());
}

async function openComposer(page: Page): Promise<void> {
  await page.goto(`${baseUrl}playground`);
  await rootH1Text(page);
  await page.locator("#composer-brief").waitFor({ state: "visible", timeout: 30_000 });
}

async function submitBrief(page: Page, brief = COMPOSER_BRIEF): Promise<void> {
  await page.locator("#composer-brief").fill(brief);
  await page.getByRole("button", { name: "Generate handoff" }).click();
}

let matched: ArtifactFixture;
let fallback: ArtifactFixture;

beforeAll(async () => {
  matched = await keywordMatchedArtifact(COMPOSER_BRIEF);
  fallback = await fallbackArtifact(COMPOSER_BRIEF);
}, 60_000);

/**
 * Strings the REAL `DESIGN.md` rendering contains and the composer's own UI never
 * renders — YAML front matter keys and section headers from
 * `renderDesignHandoffMarkdown`. Any control that publishes the handoff bytes into
 * the document puts these in the page, so they are a precise leak probe that does
 * not depend on the seeded corpus entry surfacing anything.
 */
const HANDOFF_ONLY_MARKERS: readonly string[] = [
  "handoff_version:",
  "target_profile:",
  "## Rejected defaults",
  "## Dependency manifest",
  "## Source manifest",
];

describe("public site — C3 composer", () => {
  it("keeps generation disabled until the brief meets the required minimum", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await stubApi(page, [{ status: 200, body: matched.body }]);
    await openComposer(page);

    const generate = page.getByRole("button", { name: "Generate handoff" });
    expect(await generate.isDisabled()).toBe(true);
    expect(await statusText(page)).toMatch(/idle/i);

    await page.locator("#composer-brief").fill("short");
    expect(await generate.isDisabled()).toBe(true);

    await page.locator("#composer-brief").fill(COMPOSER_BRIEF);
    expect(await generate.isDisabled()).toBe(false);
    await ctx.close();
  }, 45_000);

  it("generates a handoff, carrying the CSRF nonce on the POST", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const stub = await stubApi(page, [{ status: 200, body: matched.body }]);
    await openComposer(page);
    await submitBrief(page);

    await page.getByRole("heading", { level: 3, name: /design handoff/i }).waitFor({
      timeout: 30_000,
    });
    // A keyword-matched artifact carries the producer's motion warning but did NOT
    // use the fallback — the label must not claim it did.
    const status = await statusText(page);
    expect(status).toMatch(/warning/i);
    expect(status).not.toMatch(/fallback/i);

    expect(stub.hits.map((h) => `${h.method} ${h.path}`)).toEqual([
      "GET /api/csrf",
      "POST /api/create-ui-spec",
    ]);
    expect(stub.hits[1].csrf).toBe(NONCE);
    await ctx.close();
  }, 60_000);

  it("names a structured-fallback artifact honestly and still offers both downloads", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await stubApi(page, [{ status: 200, body: fallback.body }]);
    await openComposer(page);
    await submitBrief(page);

    await page.getByRole("heading", { level: 3, name: /design handoff/i }).waitFor({
      timeout: 30_000,
    });
    const status = await statusText(page);
    expect(status).toMatch(/deterministic fallback/i);
    expect(status).not.toMatch(/complete design handoff/i);
    expect(status).toMatch(/not a fully model-generated artifact/i);

    expect(await page.getByRole("button", { name: /download DESIGN\.md/i }).isEnabled()).toBe(true);
    expect(await page.getByRole("button", { name: /download DESIGN\.json/i }).isEnabled()).toBe(
      true,
    );
    await ctx.close();
  }, 60_000);

  it("downloads the exact returned bytes — matching hashes, with no second POST", async () => {
    const ctx = await newTracingContext({ acceptDownloads: true });
    const page = await ctx.newPage();
    const stub = await stubApi(page, [{ status: 200, body: matched.body }]);
    await openComposer(page);
    await submitBrief(page);
    await page.getByRole("heading", { level: 3, name: /design handoff/i }).waitFor({
      timeout: 30_000,
    });

    const postsAfterGenerate = stub.hits.filter((h) => h.path === "/api/create-ui-spec").length;
    expect(postsAfterGenerate).toBe(1);

    const envelope = matched.envelope as Record<string, string>;

    for (const [buttonName, filename, expectedBytes, expectedHash] of [
      ["Download DESIGN.md", "DESIGN.md", envelope.designMarkdown, envelope.designMarkdownSha256],
      ["Download DESIGN.json", "DESIGN.json", envelope.designJson, envelope.designJsonSha256],
    ] as const) {
      const [download] = await Promise.all([
        page.waitForEvent("download", { timeout: 30_000 }),
        page.getByRole("button", { name: buttonName, exact: true }).click(),
      ]);
      expect(download.suggestedFilename()).toBe(filename);
      const path = await download.path();
      const saved = readFileSync(path, "utf-8");
      // The saved file is byte-identical to the rendering the response carried…
      expect(saved).toBe(expectedBytes);
      // …and hashes to the digest the server returned with it.
      expect(createHash("sha256").update(saved, "utf-8").digest("hex")).toBe(expectedHash);
    }

    // THE critical property: saving did not regenerate. A second POST would carry
    // a different generatedAt and therefore a different artifact identity.
    expect(stub.hits.filter((h) => h.path === "/api/create-ui-spec").length).toBe(
      postsAfterGenerate,
    );
    await ctx.close();
  }, 90_000);

  it("preserves the brief on a retryable failure and succeeds on retry", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const stub = await stubApi(page, [
      {
        status: 503,
        body: JSON.stringify({
          error: { code: "PROVIDER_ERROR", message: "Assembly unavailable.", retryable: true },
        }),
      },
      { status: 200, body: matched.body },
    ]);
    await openComposer(page);
    await submitBrief(page);

    const retry = page.getByRole("button", { name: /try again/i });
    await retry.waitFor({ timeout: 30_000 });
    // The brief survived the failure.
    expect(await page.locator("#composer-brief").inputValue()).toBe(COMPOSER_BRIEF);
    // The server's own error text is never rendered.
    expect(await page.content()).not.toContain("Assembly unavailable.");

    await retry.click();
    await page.getByRole("heading", { level: 3, name: /design handoff/i }).waitFor({
      timeout: 30_000,
    });
    expect(stub.hits.filter((h) => h.path === "/api/create-ui-spec").length).toBe(2);
    await ctx.close();
  }, 90_000);

  it("gives every composer control a visible focus indicator", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await stubApi(page, [{ status: 200, body: matched.body }]);
    await openComposer(page);
    await page.locator("#composer-brief").fill(COMPOSER_BRIEF);

    // Walk forward from the brief field through the rest of the form and confirm
    // each focused control paints a non-zero outline. `:focus-visible` responds to
    // keyboard focus, so the walk must be real Tab presses.
    // Focus must ARRIVE BY KEYBOARD: `:focus-visible` deliberately does not match
    // a programmatic `.focus()` on every control type, so seeding focus with
    // `.focus()` alone would read `outline: none` and fail vacuously. Stepping back
    // and forward re-enters the field as a real keyboard event.
    await page.locator("#composer-brief").focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const seen: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const info = await page.evaluate(() => {
        const active = document.activeElement as HTMLElement | null;
        if (!active) return null;
        const style = window.getComputedStyle(active);
        return {
          tag: active.tagName.toLowerCase(),
          id: active.id,
          focusVisible: active.matches(":focus-visible"),
          // The design system's normative indicator inside `.site-main` is a 3px
          // translucent halo drawn with box-shadow (shell.css §"Focus ring"),
          // which deliberately replaces the UA outline. Accept either the halo or
          // an outline — what must never happen is NEITHER.
          boxShadow: style.boxShadow,
          outlineStyle: style.outlineStyle,
          outlineWidth: style.outlineWidth,
        };
      });
      if (info === null) break;
      if (["textarea", "select", "input", "button", "summary"].includes(info.tag)) {
        const hasHalo = info.boxShadow !== "none" && info.boxShadow.length > 0;
        const hasOutline = info.outlineStyle !== "none" && parseFloat(info.outlineWidth) > 0;
        seen.push(`${info.tag}#${info.id}`);
        expect(info.focusVisible).toBe(true);
        expect(hasHalo || hasOutline).toBe(true);
      }
      await page.keyboard.press("Tab");
    }
    // The walk actually covered controls (a zero-length walk would pass vacuously).
    expect(seen.length).toBeGreaterThanOrEqual(4);
    await ctx.close();
  }, 60_000);

  it("generates and reads the result by keyboard alone", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await stubApi(page, [{ status: 200, body: matched.body }]);
    await openComposer(page);

    await page.locator("#composer-brief").focus();
    await page.keyboard.type(COMPOSER_BRIEF);
    // Tab to the Generate button and activate it with the keyboard.
    const generate = page.getByRole("button", { name: "Generate handoff" });
    await generate.focus();
    await page.keyboard.press("Enter");

    await page.getByRole("heading", { level: 3, name: /design handoff/i }).waitFor({
      timeout: 30_000,
    });
    // Focus moved into the outcome region rather than being stranded on the
    // now-disabled submit button.
    const focusedClass = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.className ?? "",
    );
    expect(focusedClass).toContain("outcome");
    await ctx.close();
  }, 60_000);

  it("does not scroll horizontally at 320px with a result on screen", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await page.setViewportSize({ width: 320, height: 568 });
    await stubApi(page, [{ status: 200, body: matched.body }]);
    await openComposer(page);
    await submitBrief(page);
    await page.getByRole("heading", { level: 3, name: /design handoff/i }).waitFor({
      timeout: 30_000,
    });

    // The result renders 64-hex digests, which is exactly the content that breaks
    // a naive layout on a narrow viewport.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
    await ctx.close();
  }, 60_000);

  it("puts no private corpus marker in the serialized page, storage, or a console message", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const consoleText: string[] = [];
    page.on("console", (message) => consoleText.push(message.text()));
    await stubApi(page, [{ status: 200, body: matched.body }]);
    await openComposer(page);
    await submitBrief(page);
    await page.getByRole("heading", { level: 3, name: /design handoff/i }).waitFor({
      timeout: 30_000,
    });

    // The seeded corpus entry's private values genuinely passed through the real
    // producer, so this is a check against material that existed on the path.
    const serialized = await page.content();
    const storage = await page.evaluate(() => ({
      local: JSON.stringify(Object.entries(localStorage)),
      session: JSON.stringify(Object.entries(sessionStorage)),
    }));
    const consoleJoined = consoleText.join("\n");

    for (const marker of PRIVATE_MARKERS) {
      expect(serialized).not.toContain(marker);
      expect(storage.local).not.toContain(marker);
      expect(storage.session).not.toContain(marker);
      expect(consoleJoined).not.toContain(marker);
    }
    // Response-scoped evidence ids are aggregated to a count, never listed.
    expect(await page.locator("#root").innerText()).not.toMatch(/evidence-\d/);
    await ctx.close();
  }, 60_000);

  // Review Important 4b. Static, always present, no probe: a hosted copy of this
  // page has no `/api` beside it, and the requirement has to be readable BEFORE
  // the operator writes a brief.
  it("states the local-server requirement before any submission", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await stubApi(page, [{ status: 200, body: matched.body }]);
    await openComposer(page);

    const requirement = await page.locator("[data-testid='playground-requirement']").innerText();
    expect(requirement).toMatch(/npm run ui/);
    expect(requirement).toMatch(/cannot generate/i);
    await ctx.close();
  }, 45_000);

  // Review Important 4a. This is the SHIPPED static-hosting failure path, and it
  // was untested: `GET /api/csrf` resolves to the host's 404 document, which used
  // to be reported as "the local server ... may have restarted".
  it("names the real cause when the origin has no local API at all", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const posts: string[] = [];
    // Exactly what a static host answers for an unknown path.
    await page.route("**/api/csrf", (route) =>
      route.fulfill({ status: 404, contentType: "text/html", body: "<!doctype html>Not found" }),
    );
    await page.route("**/api/create-ui-spec", (route) => {
      posts.push(route.request().method());
      return route.fulfill({ status: 200, contentType: "application/json", body: matched.body });
    });
    await openComposer(page);
    await submitBrief(page);

    await page.waitForFunction(
      () => /npm run ui/.test(document.querySelector(".outcome__status")?.textContent ?? ""),
      undefined,
      { timeout: 30_000 },
    );
    const status = await statusText(page);
    expect(status).not.toMatch(/restarted/i);
    expect(status).toMatch(/own machine/i);
    // The brief never left the browser: there was nothing to send it to.
    expect(posts).toEqual([]);
    // And no artifact was shown.
    expect(await page.getByRole("heading", { level: 3, name: /design handoff/i }).count()).toBe(0);
    await ctx.close();
  }, 60_000);

  // Review Important 2. `designMarkdown` is the SERVER's rendering, not the
  // client's allowlist projection — it carries `spec.context.productContext`,
  // `spec.citedReferences`, the profile's sourceId/URL lines and the technique /
  // anti-pattern / component-inventory text. A copy control whose failure path
  // prints its value into the DOM therefore publishes all of it. This forces the
  // documented failure — Chrome's "Document is not focused" rejection — and then
  // re-runs the marker sweep.
  it("publishes nothing when the clipboard write rejects", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const consoleText: string[] = [];
    page.on("console", (message) => consoleText.push(message.text()));

    // The probe is only meaningful if these strings really are in the bytes.
    for (const marker of HANDOFF_ONLY_MARKERS) {
      expect(matched.envelope.designMarkdown as string).toContain(marker);
    }

    await page.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () => Promise.reject(new Error("Document is not focused")),
        },
      });
    });
    await stubApi(page, [{ status: 200, body: matched.body }]);
    await openComposer(page);
    await submitBrief(page);
    await page.getByRole("heading", { level: 3, name: /design handoff/i }).waitFor({
      timeout: 30_000,
    });

    await page.getByRole("button", { name: /copy markdown/i }).click();
    // Wait for ANY reaction to the rejection — this control's note, or the shared
    // component's value-rendering fallback. Waiting for either is deliberate: it
    // keeps the assertions below (not the wait) the thing that fails if a control
    // that dumps the value is ever wired in here.
    await page.waitForFunction(
      () => document.querySelector(".copy-handoff__note, .copy-action__fallback-value") !== null,
      undefined,
      { timeout: 15_000 },
    );

    const serialized = await page.content();
    for (const marker of [...HANDOFF_ONLY_MARKERS, ...PRIVATE_MARKERS]) {
      expect(serialized).not.toContain(marker);
    }
    expect(consoleText.join("\n")).not.toMatch(/handoff_version|target_profile/);
    // No value-rendering fallback element exists on this surface at all.
    expect(await page.locator(".copy-action__fallback-value").count()).toBe(0);
    // And the control did say something — the operator is not left with a dead button.
    expect(await page.locator(".copy-handoff__note").innerText()).toMatch(
      /clipboard is not available/i,
    );
    // The same bytes are still saveable, which is what the copy note says.
    expect(await page.getByRole("button", { name: /download DESIGN\.md/i }).isEnabled()).toBe(true);
    await ctx.close();
  }, 60_000);
});
