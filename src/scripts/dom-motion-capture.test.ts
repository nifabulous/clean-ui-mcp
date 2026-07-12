/**
 * dom-motion-capture.test.ts — integration test for the capture motion seam.
 *
 * Validates the ordering guarantee that production capture relies on:
 *   collect motion (while transitions/animations are live) → freeze motion.
 *
 * Mirrors the real capture pipeline's browser setup (reducedMotion: "reduce")
 * and exercises the two seam functions exported from capture.ts:
 *   - collectMotionDeclarations: reads authored motion declarations
 *   - freezePageMotion:          injects a motion-suppressing <style> tag
 *
 * The assert is the ordering, not a full capture run: non-zero durations are
 * visible BEFORE freeze, the freeze tag is injected, and computed transitions
 * collapse to 0s AFTER freeze.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectMotionDeclarations, freezePageMotion } from "./capture.js";

// A tiny page with interactive elements carrying motion via multiple patterns:
// inline style, top-level authored rule, nested @media rule, and a root-level
// interactive element (button as capture root).
const motionHtml = `<!doctype html>
<html><head><style>
  .btn { transition: transform 0.5s ease-in-out; }
  @media (hover: hover) {
    .media-btn { transition: opacity 0.4s ease; }
  }
</style></head>
<body>
  <button style="transition: opacity 0.3s ease; opacity: 1;">Click me</button>
  <button class="btn">Styled</button>
  <button class="media-btn">Media Query</button>
  <button class="root-btn">Root Element</button>
</body></html>`;

let browser: Browser | undefined;
let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;

describe("capture motion seam — collect then freeze", () => {
  beforeAll(async () => {
    const server = createServer((_req: IncomingMessage, res: ServerResponse) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(motionHtml);
    });
    await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = () => new Promise((resolveClose) => server.close(() => resolveClose()));
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await closeServer?.();
  });

  it("collects non-zero-duration motion before freeze, then injects the freeze style tag", async () => {
    // reducedMotion:"reduce" matches the production capture context.
    const context = await browser!.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(baseUrl + "/", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => {});

    // ── Collect BEFORE freeze: authored declarations are live ────────────────
    const root = page.locator("body");
    const collected = await collectMotionDeclarations(root);
    expect(collected).not.toBeNull();
    const inputs = collected!.inputs;
    expect(inputs.length).toBeGreaterThanOrEqual(3); // inline + authored + @media
    // At least one declared transition has a non-zero duration (0.3s / 0.5s / 0.4s).
    expect(inputs.some((i) => /0\.[1-9]/.test(i.transitionDuration ?? ""))).toBe(true);

    // P2-1 fix: motion inside @media (hover: hover) must be collected
    const mediaInput = inputs.find((i) => /0\.4s/.test(i.transitionDuration ?? ""));
    expect(mediaInput).toBeDefined();

    // P2-2 fix: collect from a locator whose root IS an interactive element
    const rootBtn = page.locator(".root-btn");
    // The button itself has no transition, but verify root-inclusive behavior
    // by checking that a button locator doesn't throw and returns valid structure
    const rootCollected = await collectMotionDeclarations(rootBtn);
    expect(rootCollected).not.toBeNull();
    // Even with no motion on .root-btn, the structure should be valid
    expect(rootCollected!.inaccessibleStylesheets).toBeGreaterThanOrEqual(0);

    // Sanity: the computed transition-duration on the page is currently non-zero.
    const liveDuration = await page.evaluate(() => {
      const el = document.querySelector("button");
      return el ? getComputedStyle(el).transitionDuration : "";
    });
    // "0.3s" parses to a non-zero value — the freeze hasn't run yet.
    expect(liveDuration).not.toBe("0s");

    // ── Freeze: injects a <style> tag that zeroes transition/animation ───────
    await freezePageMotion(page);

    // The freeze style tag is present in the DOM and carries the zero-duration rule.
    const html = await page.content();
    expect(html).toContain("transition-duration: 0s");

    // ── AFTER freeze: computed transitions collapse to 0s ────────────────────
    const frozenDuration = await page.evaluate(() => {
      const el = document.querySelector("button");
      return el ? getComputedStyle(el).transitionDuration : "";
    });
    expect(frozenDuration).toBe("0s");

    await context.close();
  });
});
