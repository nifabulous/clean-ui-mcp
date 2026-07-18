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
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SITE_ROOT = resolve(__dirname, "..");
const DIST_INDEX = resolve(SITE_ROOT, "dist", "index.html");

// A real entry id from the shipped snapshot. Resolved synchronously at module
// load so the evidence-route assertion has a concrete target without a network
// round-trip. The snapshot is committed to the repo, so this id is stable.
const SAMPLE_EVIDENCE_ID = readFirstEntryId();

function readFirstEntryId(): string {
  // Read the source snapshot (same bytes the build copies into dist/) so the id
  // is correct even before a fresh build. The parser in public-entry.ts rejects
  // malformed entries, so any shipped entry is safe to deep-link.
  const snapshotPath = resolve(SITE_ROOT, "public", "snapshot.json");
  const payload = JSON.parse(readFileSync(snapshotPath, "utf-8")) as {
    entries?: Array<{ id?: unknown }>;
  };
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const found = entries.find((entry) => typeof entry?.id === "string" && entry.id.length > 0);
  if (!found || typeof found.id !== "string") {
    throw new Error("site-browser test setup: snapshot has no usable entry id");
  }
  return found.id;
}

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
      const text = chunk.toString();
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

  it("serves /clean-ui-mcp/playground as a client route (no 404, no asset 404)", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const response = await page.goto(`${baseUrl}playground`);
    expect(response?.status()).toBe(200);
    // Direct nav to a client route must not 404 — index.html is served and the
    // SPA router mounts /playground. Wait for the lazy Playground chunk to land.
    expect(await rootH1Text(page)).toMatch(/search the critiqued corpus/i);
    expect(failedOf(ctx)).toEqual([]);
    await ctx.close();
  }, 30_000);

  it("serves an evidence route (/clean-ui-mcp/evidence/<id>) without 404", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const response = await page.goto(`${baseUrl}evidence/${SAMPLE_EVIDENCE_ID}`);
    expect(response?.status()).toBe(200);
    // Wait for the lazy Evidence chunk + the snapshot (2.4MB) to parse. The
    // evidence header H1 carries the entry title; the screenshot <img> must also
    // resolve (no 404 on the image asset). Give a generous timeout: the snapshot
    // fetch + parse + MiniSearch-free lookup can take several seconds cold.
    await page.waitForSelector("h1", { timeout: 30_000 });
    await page.waitForSelector("figure img", { timeout: 15_000 });
    // Confirm the image actually loaded (network status, not just present).
    const imgOk = await page.evaluate(() => {
      const img = document.querySelector("figure img") as HTMLImageElement | null;
      return img ? img.complete && img.naturalWidth > 0 : false;
    });
    expect(imgOk).toBe(true);
    expect(failedOf(ctx)).toEqual([]);
    await ctx.close();
  }, 45_000);

  it("does not 404 on any script, style, snapshot, or image across a navigation journey", async () => {
    // Drive a full journey: home -> playground -> evidence. All asset classes
    // (entry JS, lazy chunks, snapshot.json, the entry PNG) must resolve.
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await page.goto(baseUrl);
    await rootH1Text(page);

    await page.goto(`${baseUrl}playground`);
    await rootH1Text(page);

    await page.goto(`${baseUrl}evidence/${SAMPLE_EVIDENCE_ID}`);
    await page.waitForSelector("figure img", { timeout: 30_000 });

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

  it("announces the result count through a polite live region on the Playground", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}playground`);
    await rootH1Text(page);
    // The result-count region (.playground__count) carries role=status +
    // aria-live=polite and announces the number of matches ONCE the snapshot
    // has loaded and the search index has run. While loading, a SEPARATE
    // role=status region (AsyncState) shows "Loading…" — so we must target the
    // count element specifically (not the generic [role=status], whose .first()
    // would resolve against the loading region and read "Loading…" too early).
    const count = page.locator(".playground__count[role='status'][aria-live='polite']");
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
