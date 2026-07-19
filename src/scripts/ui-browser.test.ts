import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
// The SPA (index-2.html) is the specimen-ledger browser; the form + bulk
// import flows live in the classic workbench (index-classic.html + classic-*).
// Both shells are loaded below — classic-flow tests point at /index-classic.html,
// SPA tests point at /.
const classicHtml = readFileSync(resolve(__dirname, "../..", "index-classic.html"), "utf-8");
const spaHtml = readFileSync(resolve(__dirname, "../..", "index-2.html"), "utf-8");

// Hoisted so both describe blocks share the single browser + server launched in
// the first block's beforeAll. Vitest runs describe blocks in file order.
let browser: Browser | undefined;
let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;
let openaiConfigured = true;
// Per-batch hash sets for the check-duplicate stub (mirrors the real server's
// in-batch dedup). Cleared per test by clearing the map.
const batchHashes = new Map<string, Set<string>>();
let lastEntryPost: any = null;
let lastAutoCritiquePost: any = null;

const schema = {
  categories: ["dashboard", "pricing"],
  styleTags: ["minimal", "dense-data"],
  patternTypes: ["dashboard", "pricing", "empty-state", "data-table"],
  spacingDensities: ["compact", "moderate", "spacious"],
  cornerStyles: ["sharp", "slight-round", "pill", "mixed"],
  imageVisibilities: ["private", "public-thumb", "public-own"],
};

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolveBody(body));
  });
}

describe("curator app browser smoke", () => {
  beforeAll(async () => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/index-classic.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(classicHtml);
        return;
      }
      if (url.pathname === "/" || url.pathname === "/index-2.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(spaHtml);
        return;
      }
      // Serve the extracted CSS/JS from ui/ — mirrors the production /static/* route.
      if (url.pathname.startsWith("/static/")) {
        const rel = url.pathname.slice("/static/".length);
        const abs = resolve(__dirname, "../..", "ui", rel);
        if (existsSync(abs)) {
          const mime = abs.endsWith(".css") ? "text/css" : abs.endsWith(".js") ? "text/javascript" : "application/octet-stream";
          res.writeHead(200, { "content-type": `${mime}; charset=utf-8` });
          res.end(readFileSync(abs));
          return;
        }
      }
      if (url.pathname === "/api/schema") return json(res, 200, schema);
      if (url.pathname === "/api/entries" && req.method === "GET") return json(res, 200, { entries: [] });
      if (url.pathname === "/api/health") return json(res, 200, { entryCount: 0, snapshotCount: 0, newestSnapshotEpoch: 0, newestSnapshotAgeMs: 0 });
      if (url.pathname === "/api/stats") return json(res, 200, { total: 0, avgQuality: 0, withImages: 0 });
      if (url.pathname === "/api/orphans" && req.method === "GET") return json(res, 200, { orphans: [], count: 0 });
      if (url.pathname === "/api/config") {
        return json(res, 200, {
          openaiKeyConfigured: openaiConfigured,
          anthropicKeyConfigured: false,
          geminiKeyConfigured: false,
          visionKeyConfigured: openaiConfigured,
          autoTagProvider: "openai",
          extractionProvider: "openai",
          critiqueProvider: "openai",
          extractionModel: "gpt-5.4-nano",
          critiqueModel: "gpt-5.4-nano",
          voyageKeyConfigured: false,
          openaiAutoTagModel: "gpt-5.4-nano",
          cleanUiPort: 3131,
          envFileLoaded: openaiConfigured,
        });
      }
      if (url.pathname === "/api/upload-image" && req.method === "POST") {
        const body = JSON.parse(await readBody(req) || "{}");
        // Echo a unique path per filename so bulk tests can distinguish rows.
        const slug = String(body.slug || body.filename || "upload").replace(/[^a-z0-9-]/gi, "-");
        // Hash the actual image bytes (not the slug) so two uploads of the SAME
        // file content collide — mirrors the real handleUpload (SHA-256 of bytes)
        // and lets the in-batch dedup test exercise identical-byte siblings.
        const b64 = String(body.dataUrl || "").split(",")[1] ?? "";
        const hash = createHash("sha256").update(b64).digest("hex");
        return json(res, 201, { path: `images-private/${slug}.png`, width: 1200, height: 800, visibility: "private", hash, dhash: hash.slice(0, 16), capturedAt: "2026-07-06T04:23:45.000Z" });
      }
      if (url.pathname === "/api/check-duplicate" && req.method === "POST") {
        const body = JSON.parse(await readBody(req) || "{}");
        // Mirror the real server's in-batch dedup: when a batchId is supplied,
        // remember each accepted upload's hash and flag later siblings that
        // match one already in the same batch. Tests assert on this behavior.
        if (body.batchId && body.hash) {
          const set = batchHashes.get(body.batchId) ?? new Set();
          if (set.has(body.hash)) {
            return json(res, 200, { duplicate: true, type: "batch-near", match: body.filename ?? "sibling" });
          }
          set.add(body.hash);
          batchHashes.set(body.batchId, set);
        }
        return json(res, 200, { duplicate: false, type: null, match: null });
      }
      if (url.pathname === "/api/capture-candidates" && req.method === "POST") {
        const body = JSON.parse(await readBody(req) || "{}");
        return json(res, 201, {
          batchId: "add-test-batch",
          candidates: [
            {
              id: "candidate-a",
              imagePath: "images-private/candidate-a.png",
              width: 1200,
              height: 800,
              sourceUrl: body.url || "https://example.com",
              sourceName: "Example",
              captureMode: "section",
              viewport: "desktop",
              capturedAt: "2026-07-06T01:23:45.000Z",
            },
            {
              id: "candidate-b",
              imagePath: "images-private/candidate-b.png",
              width: 390,
              height: 844,
              sourceUrl: body.url || "https://example.com",
              sourceName: "Example",
              captureMode: "viewport",
              viewport: "mobile",
              capturedAt: "2026-07-06T02:23:45.000Z",
            },
          ],
        });
      }
      if (url.pathname === "/api/capture-url" && req.method === "POST") {
        await readBody(req);
        return json(res, 201, { path: "images-private/captured.png", width: 1440, height: 1000, visibility: "private", capturedAt: "2026-07-06T03:23:45.000Z" });
      }
      if (url.pathname === "/api/auto-tag" && req.method === "POST") {
        const body = JSON.parse(await readBody(req) || "{}");
        // When extractionOnly is requested (bulk flow), return placeholder
        // critique + a _raw.extraction block the client echoes back to
        // /auto-critique. Mirrors the real tagger's two-stage contract.
        const extractionOnly = body.extractionOnly === true;
        const baseEntry = {
          id: "draft",
          title: "Tagged sample",
          patternType: "dashboard",
          categories: ["dashboard"],
          styleTags: ["minimal"],
          platform: "mobile",
          source: { productName: "Mock", url: null, capturedAt: "2026-07-02", capturedBy: "self" },
          image: { visibility: "private", path: "images-private/draft.png", width: 1200, height: 800 },
          visual: {
            dominantColors: ["#ffffff", "#111111"],
            accentColor: null,
            typePairing: { display: null, body: null, notes: "notes" },
            spacingDensity: "moderate",
            cornerStyle: "slight-round",
            usesShadows: false,
            usesBorders: true,
          },
          qualityScore: 3,
          addedAt: "2026-07-02",
        };
        if (extractionOnly) {
          return json(res, 200, { entry: {
            ...baseEntry,
            critique: "[DRAFT — critique deferred] Run 'Generate critique' to draft this.",
            whatToSteal: ["[DRAFT — critique deferred]"],
            antiPatterns: { antiPatterns: ["[DRAFT — critique deferred]"], whereThisFails: [], accessibilityRisks: [] },
            _raw: { extraction: { patternType: "dashboard", categories: ["dashboard"] }, extractionOnly: true },
          }});
        }
        // Full (non-bulk) path: critique is long enough to pass the 80-char minimum.
        return json(res, 200, { entry: {
          ...baseEntry,
          critique: "[DRAFT — REWRITE] This is a long enough draft critique to clear the schema minimum length for testing.",
          whatToSteal: ["[DRAFT] A concrete copyable technique a developer could apply directly."],
          antiPatterns: {
            antiPatterns: ["[DRAFT] Avoids drop shadows; uses background-color steps for depth."],
            whereThisFails: [],
            accessibilityRisks: [],
          },
        }});
      }
      if (url.pathname === "/api/auto-critique" && req.method === "POST") {
        lastAutoCritiquePost = JSON.parse(await readBody(req) || "{}");
        return json(res, 200, { critique: {
          critique: "[DRAFT — REWRITE] This is a long enough draft critique to clear the schema minimum length for testing.",
          whatToSteal: ["[DRAFT] A concrete copyable technique a developer could apply directly."],
          antiPatterns: {
            antiPatterns: ["[DRAFT] Avoids drop shadows; uses background-color steps for depth."],
            whereThisFails: [],
            accessibilityRisks: [],
          },
          qualityTier: "exceptional",
          qualityScore: 3,
          typographyNotes: "notes",
        }});
      }
      if (url.pathname === "/api/entries" && req.method === "POST") {
        const body = JSON.parse(await readBody(req) || "{}");
        lastEntryPost = body;
        if ("lastVerified" in (body.source || {}) && !/^\d{4}-\d{2}-\d{2}$/.test(body.source.lastVerified)) {
          return json(res, 422, { error: "source.lastVerified: Expected YYYY-MM-DD" });
        }
        // Mirror the real server's draft-hygiene gate (findDraftMarkers): a
        // payload that still carries [DRAFT]/[PLACEHOLDER]/[TODO] in any text
        // field must be rejected with 422 — this is the exact regression that
        // let deferred-critique rows commit markered text for a long time.
        const textFields = [
          body.critique, ...(body.whatToSteal || []),
          ...((body.antiPatterns?.antiPatterns) || []), ...((body.antiPatterns?.whereThisFails) || []), ...((body.antiPatterns?.accessibilityRisks) || []),
          body.voice?.tone, ...((body.voice?.examples) || []), ...((body.voice?.avoid) || []),
        ];
        const dirty = (textFields as string[]).filter((t) => typeof t === "string" && /\[(?:DRAFT|PLACEHOLDER|TODO\b)/i.test(t));
        if (dirty.length) return json(res, 422, { error: "Entry contains draft markers", issues: [{ message: "remove the [DRAFT]/[PLACEHOLDER]/[TODO] marker" }] });
        const entry = { ...body, id: body.id || "committed-1" };
        return json(res, 201, { entry });
      }
      if (url.pathname === "/api/image") {
        res.writeHead(200, { "content-type": "image/png" });
        res.end(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFeAJ5fVqRtwAAAABJRU5ErkJggg==", "base64"));
        return;
      }
      return json(res, 404, { error: "not found" });
    });
    await new Promise<void>((resolveListen) => server.listen(0, resolveListen));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server did not start");
    baseUrl = `http://127.0.0.1:${address.port}`;
    closeServer = () => new Promise((resolveClose) => server.close(() => resolveClose()));
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  // NOTE: browser/server teardown is a top-level afterAll below, so the shared
  // browser stays alive across BOTH describe blocks (the bulk-import block runs
  // after this one and needs the same browser instance).

  it("requires an image before saving a new sample", async () => {
    openaiConfigured = true;
    const page = await browser.newPage();
    await page.goto(baseUrl + "/index-classic.html");
    await page.getByRole("button", { name: "New sample", exact: true }).first().click();

    expect(await page.getByText("Capture or upload a screenshot before saving.").isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Save" }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Auto-fill" }).isDisabled()).toBe(true);

    await page.close();
  });

  it("enables auto-fill after upload or URL capture provides an image", async () => {
    openaiConfigured = true;
    const page = await browser.newPage();
    await page.goto(baseUrl + "/index-classic.html");
    await page.locator("#newBtn").click();
    await page.getByLabel("Product").fill("Origin");

    await page.setInputFiles("#imageFile", {
      name: "sample.png",
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFeAJ5fVqRtwAAAABJRU5ErkJggg==", "base64"),
    });
    // The mock derives the stored path from the slug (product/title/filename),
    // so uploading with product "Origin" lands at images-private/origin.png.
    await page.waitForSelector("text=images-private/origin.png");
    expect(await page.getByText("Image ready: images-private/origin.png").isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Auto-fill" }).isEnabled()).toBe(true);

    await page.getByLabel("Source URL").fill("https://example.com");
    await page.getByRole("button", { name: "Pull one screenshot from Source URL" }).click();
    await page.waitForSelector("text=images-private/captured.png");
    expect(await page.getByText("Image ready: images-private/captured.png").isVisible()).toBe(true);

    await page.close();
  });

  it("explains .env setup when the vision key is missing", async () => {
    openaiConfigured = false;
    const page = await browser.newPage();
    await page.goto(baseUrl + "/index-classic.html");
    await page.locator("#newBtn").click();

    expect(await page.getByText("Auto-fill needs a vision provider key").isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Auto-fill" }).isDisabled()).toBe(true);

    await page.close();
  });
});

describe("bulk import", () => {
  // Shares the browser + mock server launched by the first describe block's
  // beforeAll (hoisted to module scope). Vitest runs describe blocks in file
  // order, so both are initialized before these tests run.
  const png1x1 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFeAJ5fVqRtwAAAABJRU5ErkJggg==";
  // A second, genuinely-different 1x1 PNG (red pixel). The in-batch dedup flags
  // identical bytes within one bulk run, so tests that stage two distinct rows
  // must use two distinct images — not two copies of png1x1.
  const png1x1Red = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC";

  async function newBulkPage(): Promise<Page> {
    if (!browser) throw new Error("browser not initialized");
    const page = await browser.newPage();
    await page.goto(baseUrl + "/index-classic.html");
    await page.getByRole("button", { name: "Bulk import" }).click();
    await page.waitForSelector("text=Stage → Auto-fill → Commit");
    return page;
  }

  it("renders the bulk tab with all action buttons disabled on an empty queue", async () => {
    const page = await newBulkPage();
    expect(await page.getByText("No files staged yet").isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: /Auto-fill all/ }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: /Commit ready/ }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Clear queue" }).isDisabled()).toBe(true);
    expect(await page.locator("#bulkFileInput").getAttribute("multiple")).not.toBeNull();
    await page.close();
  });

  it("stages one row per uploaded file and infers product from filename", async () => {
    openaiConfigured = true;
    const page = await newBulkPage();
    await page.fill("#bulkDefaultProduct", "TestCo");

    await page.locator("#bulkFileInput").setInputFiles([
      { name: "linear__board.png", mimeType: "image/png", buffer: Buffer.from(png1x1, "base64") },
      { name: "random-screen.png", mimeType: "image/png", buffer: Buffer.from(png1x1Red, "base64") },
    ]);

    await page.waitForSelector("text=linear__board.png");
    await page.waitForSelector("text=random-screen.png");

    expect(await page.locator(".bulk-row").count()).toBe(2);
    // Filename prefix `linear__` → "Linear" via KNOWN_PRODUCTS; generic → batch default.
    // Order is nondeterministic (uploads run in a concurrency pool), so assert
    // the set of inferred products, not their sequence.
    const products = await page.locator("[data-bulk-product]").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(products.sort()).toEqual(["Linear", "TestCo"]);
    // Both staged; auto-fill now enabled.
    expect(await page.locator(".status-chip.staged").count()).toBe(2);
    expect(await page.getByRole("button", { name: /Auto-fill all/ }).isDisabled()).toBe(false);
    await page.close();
  });

  it("flags identical files in the same batch as near-duplicates", async () => {
    // Two byte-identical files uploaded in one run: the second must be caught
    // by in-batch dedup (the old code only checked the corpus, so both leaked).
    batchHashes.clear();
    const page = await newBulkPage();
    await page.locator("#bulkFileInput").setInputFiles([
      { name: "dup-a.png", mimeType: "image/png", buffer: Buffer.from(png1x1, "base64") },
      { name: "dup-b.png", mimeType: "image/png", buffer: Buffer.from(png1x1, "base64") },
    ]);
    // Only the first stages; the second lands as an error row (batch-near).
    await page.waitForSelector(".status-chip.staged");
    await page.waitForSelector(".status-chip.error");
    expect(await page.locator(".status-chip.staged").count()).toBe(1);
    expect(await page.locator(".status-chip.error").count()).toBe(1);
    expect(await page.locator(".bulk-row .err").first().innerText()).toMatch(/near-dup in this batch/i);
    await page.close();
  });

  it("auto-fills staged rows into tagged drafts when the OpenAI key is present", async () => {
    openaiConfigured = true;
    const page = await newBulkPage();
    await page.fill("#bulkDefaultProduct", "TestCo");
    await page.locator("#bulkFileInput").setInputFiles([
      { name: "stripe__pricing.png", mimeType: "image/png", buffer: Buffer.from(png1x1, "base64") },
    ]);
    await page.waitForSelector(".status-chip.staged");

    // Bulk auto-fill is now two-stage: extraction (cheap, deferred critique),
    // then 'Generate critique' (Pass 2). Rows land in 'extraction' first.
    await page.getByRole("button", { name: /Auto-fill all/ }).click();
    await page.waitForSelector(".status-chip.extraction", { timeout: 5000 });
    expect(await page.locator(".status-chip.extraction").count()).toBe(1);
    // Commit is gated on tagged rows — extraction-only rows are not committable.
    expect(await page.getByRole("button", { name: /Commit ready/ }).isDisabled()).toBe(true);

    // Now run deferred critique → row flips to 'tagged' (committable).
    await page.getByRole("button", { name: /Generate critique/ }).click();
    await page.waitForSelector(".status-chip.tagged", { timeout: 5000 });
    expect(await page.locator(".status-chip.tagged").count()).toBe(1);
    expect(await page.getByRole("button", { name: /Commit ready/ }).isDisabled()).toBe(false);
    expect(lastAutoCritiquePost.platform).toBe("mobile");

    // Regression: deferred-critique rows MUST commit cleanly. The critique
    // endpoint prepends [DRAFT — REWRITE]/[DRAFT] markers to every field; if the
    // client doesn't strip them on merge, the server's hygiene gate rejects the
    // commit (422) and the row flips to 'error' — wasting the vision tokens.
    // Commit succeeds → the queue drains (committed rows are dropped) and a
    // success toast appears. The failure mode is the row flipping to 'error'
    // instead, so assert that never happens.
    await page.getByRole("button", { name: /Commit ready/ }).click();
    // Either the committed chip flashes, or the queue empties. Both are success.
    await page.waitForFunction(() => {
      const chips = document.querySelectorAll(".status-chip");
      const errs = document.querySelectorAll(".status-chip.error").length;
      const empty = document.body.textContent?.includes("No files staged yet");
      return errs > 0 || (empty === true) || Array.from(chips).some((c) => c.textContent?.includes("Committed"));
    }, { timeout: 5000 });
    expect(await page.locator(".status-chip.error").count()).toBe(0);
    await page.close();
  });

  it("blocks auto-fill when the OpenAI key is missing", async () => {
    openaiConfigured = false;
    const page = await newBulkPage();
    await page.fill("#bulkDefaultProduct", "TestCo");
    await page.locator("#bulkFileInput").setInputFiles([
      { name: "sample.png", mimeType: "image/png", buffer: Buffer.from(png1x1, "base64") },
    ]);
    await page.waitForSelector(".status-chip.staged", { timeout: 8000 });
    // Auto-fill stays disabled without the key.
    expect(await page.getByRole("button", { name: /Auto-fill all/ }).isDisabled()).toBe(true);
    await page.close();
  }, 15000);
});

// ─── SPA (specimen ledger) smoke ────────────────────────────────────────────
// The new index-2.html shell is a hash-routed SPA. These tests confirm the
// shell boots, the overview renders KPIs from /api/entries + /api/health, and
// hash routes swap the #pages content without a full reload. The classic
// flows above cover form + bulk; this block covers the new surfaces.
describe("specimen-ledger SPA", () => {
  it("boots the overview with a KPI strip + sidebar nav", async () => {
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/");
    // The SPA injects a KPI strip into #pages on boot. Wait for the entry-count KPI.
    await page.waitForSelector("#pages .kpi, #pages [class*='kpi']", { timeout: 5000 });
    const navItems = await page.locator("#navScroll a, #navScroll [data-nav]").count();
    expect(navItems).toBeGreaterThan(0);
    // Detail rail is hidden on boot.
    const railDisplay = await page.evaluate(() => {
      const r = document.getElementById("detailRail");
      return r ? r.style.display : "absent";
    });
    expect(railDisplay === "none" || railDisplay === "" || railDisplay === "absent").toBe(true);
    await page.close();
  });

  it("hash-routes between pages without a full reload", async () => {
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/#/entries");
    await page.waitForSelector("#pageTitle");
    const entriesTitle = await page.locator("#pageTitle").textContent();
    expect(entriesTitle?.toLowerCase()).toContain("entri");

    // Navigate to settings via hash — same document, no network nav.
    await page.evaluate(() => { location.hash = "/settings"; });
    await page.waitForFunction(() => /settings/i.test(document.getElementById("pageTitle")?.textContent || ""), null, { timeout: 3000 });
    const settingsTitle = await page.locator("#pageTitle").textContent();
    expect(settingsTitle?.toLowerCase()).toContain("setting");
    await page.close();
  });

  it("renders the SPA add-entry flow with a capture form (no longer a redirect)", async () => {
    // The #/add route used to be a placeholder linking out to the classic
    // workbench; it's now a real capture/upload → auto-fill → save flow in the
    // SPA itself. Verify the form is present (URL input + capture button),
    // and that the old redirect link is gone.
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/#/add");
    // The capture form's URL input is the canonical selector for "the SPA add
    // flow mounted." waitForSelector with a timeout beats a flake-y assert.
    await page.waitForSelector("#addCaptureForm input[name='url']", { timeout: 5000 });
    const urlInput = await page.locator("#addCaptureForm input[name='url']").count();
    expect(urlInput).toBe(1);
    // The capture button should also be present.
    const captureBtn = await page.locator("#addCaptureForm button[type='submit']").count();
    expect(captureBtn).toBe(1);
    // The old redirect link to /index-classic.html should NOT be in #/add anymore.
    const oldRedirect = await page.locator("#pages a[href='/index-classic.html']").count();
    expect(oldRedirect).toBe(0);
    await page.close();
  });

  it("uses a workbench rail for candidate selection and auto-fill actions", async () => {
    openaiConfigured = true;
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/#/add");
    await page.fill("#addCaptureForm input[name='url']", "https://example.com");
    await page.locator("#addCaptureForm button[type='submit']").click();
    await page.waitForSelector(".candidate-specimen");

    expect(await page.locator(".add-workbench").count()).toBe(1);
    expect(await page.locator(".add-session-rail").count()).toBe(1);
    expect(await page.locator(".candidate-specimen").count()).toBe(2);

    await page.locator("[data-candidate-pick='0']").check();
    expect(await page.locator(".add-session-rail").innerText()).toMatch(/1\s+SELECTED/i);
    await page.getByRole("button", { name: /Auto-fill selected/ }).click();
    await page.waitForSelector("[data-candidate-review='0']");
    expect(await page.locator(".add-session-rail").innerText()).toMatch(/1\s+TAGGED/i);
    await page.close();
  });

  it("lets a curator preview a candidate before choosing it for auto-fill", async () => {
    openaiConfigured = true;
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/#/add");
    await page.fill("#addCaptureForm input[name='url']", "https://example.com");
    await page.locator("#addCaptureForm button[type='submit']").click();
    await page.waitForSelector(".candidate-specimen");

    const firstCard = page.locator(".candidate-specimen").first();
    expect(await firstCard.locator("button", { hasText: /Preview/ }).count()).toBe(1);
    await firstCard.locator("button", { hasText: /Preview/ }).click();
    await page.waitForSelector("#candPreview[aria-modal='true']");
    expect(await page.locator("#candPreview").innerText()).toContain("candidate-a");
    await page.locator("#candPrevSelect").check();
    expect(await page.locator(".add-session-rail").innerText()).toMatch(/1\s+SELECTED/i);
    await page.close();
  });

  it("keeps single-entry save inside the review sheet during candidate review", async () => {
    openaiConfigured = true;
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/#/add");
    await page.fill("#addCaptureForm input[name='url']", "https://example.com");
    await page.locator("#addCaptureForm button[type='submit']").click();
    await page.waitForSelector(".candidate-specimen");
    await page.locator("[data-candidate-pick='0']").check();
    await page.getByRole("button", { name: /Auto-fill selected/ }).click();
    await page.waitForSelector("[data-candidate-review='0']");
    await page.locator("[data-candidate-review='0']").click();
    await page.waitForSelector(".review-sheet");

    expect(await page.locator(".review-sheet button[type='submit']", { hasText: /Save entry/ }).count()).toBe(1);
    expect(await page.locator(".add-session-rail button", { hasText: /Save entry/ }).count()).toBe(0);
    expect(await page.locator(".add-session-rail").innerText()).toContain("Back to queue");
    await page.close();
  });

  it("saves a reviewed candidate without sending an empty lastVerified date", async () => {
    openaiConfigured = true;
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/#/add");
    await page.fill("#addCaptureForm input[name='url']", "https://example.com");
    await page.locator("#addCaptureForm button[type='submit']").click();
    await page.waitForSelector(".candidate-specimen");
    await page.locator("[data-candidate-pick='0']").check();
    await page.getByRole("button", { name: /Auto-fill selected/ }).click();
    await page.waitForSelector("[data-candidate-review='0']");
    await page.locator("[data-candidate-review='0']").click();
    await page.waitForSelector(".review-sheet");

    lastEntryPost = null;
    await page.locator(".review-sheet button[type='submit']").click();
    for (let i = 0; i < 50 && lastEntryPost === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(lastEntryPost).not.toBeNull();
    expect(lastEntryPost.source.capturedAt).toBe("2026-07-06");
    expect(lastEntryPost.source.lastVerified).toBeUndefined();
    expect(await page.locator(".add-session-rail").innerText()).not.toContain("source.lastVerified");
    await page.close();
  });

  it("saves uploaded screenshots with the upload capture date", async () => {
    openaiConfigured = true;
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/#/add");
    await page.locator("#addSwitchUpload").click();
    await page.locator("#addFileInput").setInputFiles({
      name: "uploaded.png",
      mimeType: "image/png",
      buffer: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFeAJ5fVqRtwAAAABJRU5ErkJggg==", "base64"),
    });
    await page.waitForSelector("text=images-private/uploaded-png.png");
    await page.getByRole("button", { name: /Auto-fill fields/ }).click();
    await page.waitForSelector(".review-sheet");

    lastEntryPost = null;
    await page.locator(".review-sheet button[type='submit']").click();
    for (let i = 0; i < 50 && lastEntryPost === null; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(lastEntryPost).not.toBeNull();
    expect(lastEntryPost.source.capturedAt).toBe("2026-07-06");
    await page.close();
  });

  it("uses mobile artifact-before-session ordering and exposes progress live text", async () => {
    const page = await browser!.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseUrl + "/#/add");
    await page.waitForSelector(".add-workbench");

    const order = await page.locator(".source-strip, .add-artifact, .add-session-rail").evaluateAll((els) => els.map((el) => Array.from(el.classList).join(" ")));
    expect(order[0]).toContain("source-strip");
    expect(order[1]).toContain("add-artifact");
    expect(order[2]).toContain("add-session-rail");
    expect(await page.locator("#addProgressLive[aria-live='polite']").count()).toBe(1);
    await page.close();
  });

  it("still routes #/bulk to the classic workbench (bulk flow unchanged)", async () => {
    // Bulk import is intentionally NOT rebuilt in the SPA — it stays a link to
    // the classic workbench where the queue-with-status flow already lives.
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/#/bulk");
    await page.waitForSelector("#pages a[href='/index-classic.html#bulk']");
    await page.close();
  });
});

// ─── Shared theme tokens + true dark/light behavior ──────────────────────────
// The curator dashboard must now sit on the SAME neutral token contract the
// public site uses (docs/design-system.md §2): light = pale cool canvas
// #f3f6fb, dark = TRUE neutral charcoal #111113 (no navy/violet/green/neon
// tint), an explicit choice persists across reload, and the resolved theme is
// applied before first paint so there's no flash. These tests pin all four.
describe("curator shared theme tokens", () => {
  it("defaults to light theme and the pale cool canvas when the OS prefers light", async () => {
    const page = await browser!.newPage({ colorScheme: "light" });
    await page.goto(baseUrl + "/");
    // Wait for the SPA shell to mount before asserting on <html>.
    await page.waitForSelector("#app");
    expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
    const canvas = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim().toLowerCase(),
    );
    expect(canvas).toBe("#f3f6fb");
    await page.close();
  });

  it("defaults to dark theme when the OS prefers dark and no explicit choice exists", async () => {
    const page = await browser!.newPage({ colorScheme: "dark" });
    await page.goto(baseUrl + "/");
    await page.waitForSelector("#app");
    expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
    const canvas = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim().toLowerCase(),
    );
    expect(canvas).toBe("#111113");
    await page.close();
  });

  it("persists an explicit neutral dark theme across reload", async () => {
    const page = await browser!.newPage({ colorScheme: "light" });
    await page.goto(baseUrl + "/");
    await page.waitForSelector("#app");
    // The toggle's accessible name reflects the theme it will switch TO.
    await page.getByRole("button", { name: /switch to dark theme/i }).click();
    expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
    // After the choice, the label must flip to offer switching back to light.
    await page.reload();
    await page.waitForSelector("#app");
    expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
    const canvas = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim().toLowerCase(),
    );
    expect(canvas).toBe("#111113");
    // The toggle's name now offers the inverse action.
    expect(await page.getByRole("button", { name: /switch to light theme/i }).isVisible()).toBe(true);
    await page.close();
  });

  it("persists an explicit neutral light theme when chosen from a dark OS", async () => {
    const page = await browser!.newPage({ colorScheme: "dark" });
    await page.goto(baseUrl + "/");
    await page.waitForSelector("#app");
    await page.getByRole("button", { name: /switch to light theme/i }).click();
    await page.reload();
    await page.waitForSelector("#app");
    expect(await page.locator("html").getAttribute("data-theme")).toBe("light");
    const canvas = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim().toLowerCase(),
    );
    expect(canvas).toBe("#f3f6fb");
    await page.close();
  });

  it("dark canvas is exactly the neutral charcoal with no blue/green tint", async () => {
    // Spec §5.3: "No navy, violet, green, or neon tint applied to the base
    // theme." The dark --canvas MUST equal #111113 exactly — assert the
    // computed value rather than a substring so any tint (e.g. #111118, #121318)
    // fails loudly.
    const page = await browser!.newPage({ colorScheme: "dark" });
    await page.goto(baseUrl + "/");
    await page.waitForSelector("#app");
    const canvas = await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue("--canvas").trim().toLowerCase(),
    );
    expect(canvas).toBe("#111113");
    await page.close();
  });

  it("exposes a testable window.cleanUiTheme controller", async () => {
    const page = await browser!.newPage({ colorScheme: "light" });
    await page.goto(baseUrl + "/");
    await page.waitForSelector("#app");
    const api = await page.evaluate(() => {
      const t = (window as any).cleanUiTheme;
      if (!t) return null;
      return { hasGet: typeof t.getTheme === "function", hasSet: typeof t.setTheme === "function", hasClear: typeof t.clearTheme === "function" };
    });
    expect(api).not.toBeNull();
    expect(api?.hasGet).toBe(true);
    expect(api?.hasSet).toBe(true);
    expect(api?.hasClear).toBe(true);
    await page.close();
  });
});

// ─── Dashboard shell + navigation (Task 2) ──────────────────────────────────
// Spec §7.1 (persistent application shell): semantic landmarks, a skip link,
// the active route's aria-current, a global search + quick Add, and a mobile
// drawer with the full focus-management contract. These tests pin the shell
// contract WITHOUT touching dashboard home content (Task 3), library detail
// (Task 4), or curation modules (Task 5). All 12 route IDs are preserved.
describe("dashboard shell and navigation", () => {
  it("renders semantic header, nav, and main landmarks", async () => {
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/");
    await page.waitForSelector("#app main");
    // Three required landmarks (header wraps the top bar; nav is the primary
    // navigation; main holds #pages).
    expect(await page.locator("header").count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator("nav").count()).toBeGreaterThanOrEqual(1);
    expect(await page.locator("main").count()).toBeGreaterThanOrEqual(1);
    await page.close();
  });

  it("exposes a skip link to #main as the first focusable element", async () => {
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/");
    await page.waitForSelector("#app main");
    // The first Tab-reachable element must be the skip link.
    await page.keyboard.press("Tab");
    const active = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return { tag: el?.tagName ?? "", href: el?.getAttribute("href") ?? "", text: el?.textContent?.trim() ?? "" };
    });
    expect(active.tag.toLowerCase()).toBe("a");
    expect(active.href).toBe("#main");
    expect(/skip/i.test(active.text)).toBe(true);
    await page.close();
  });

  it("marks the active route's nav link with aria-current=page", async () => {
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/#/entries");
    await page.waitForSelector("#pageTitle");
    const current = await page
      .locator('#navScroll a[aria-current="page"]')
      .getAttribute("data-route");
    expect(current).toBe("entries");
    // Navigate to a different route and confirm the marker moves with it.
    await page.evaluate(() => { location.hash = "/sources"; });
    await page.waitForFunction(
      () => document.querySelector('#navScroll a[aria-current="page"]')?.getAttribute("data-route") === "sources",
      null,
      { timeout: 3000 },
    );
    await page.close();
  });

  it("shows a visible Dashboard label while keeping the overview route id", async () => {
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/#/overview");
    await page.waitForSelector("#pageTitle");
    // The display label reads "Dashboard" but the link still targets #/overview.
    const navLink = page.locator('#navScroll a[data-route="overview"]');
    expect(await navLink.getAttribute("href")).toBe("#/overview");
    expect((await navLink.textContent())?.toLowerCase()).toContain("dashboard");
    await page.close();
  });

  it("preserves all twelve route ids in the navigation", async () => {
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/");
    await page.waitForSelector("#navScroll");
    const ids = await page.locator('#navScroll a[data-route]').evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.route),
    );
    // The hash router, links, and existing state depend on these EXACT ids.
    expect(ids.sort()).toEqual(
      ["overview", "entries", "add", "bulk", "sources", "capture", "search", "embeddings", "compare", "quality", "settings", "decision-lab"].sort(),
    );
    await page.close();
  });

  it("exposes a global search control with an accessible label", async () => {
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/");
    await page.waitForSelector("#globalSearch");
    // Accessible name via <label for> or aria-label/aria-labelledby.
    const input = page.locator("#globalSearch");
    const labelled = await input.evaluate((el) => {
      const i = el as HTMLInputElement;
      const byId = i.id ? !!document.querySelector(`label[for="${i.id}"]`) : false;
      return byId || !!i.getAttribute("aria-label") || !!i.getAttribute("aria-labelledby");
    });
    expect(labelled).toBe(true);
    await page.close();
  });

  it("surfaces a quick Add entry action in the shell", async () => {
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/");
    await page.waitForSelector("#app");
    expect(await page.getByRole("button", { name: /add entry/i }).first().isVisible()).toBe(true);
    await page.close();
  });

  it("announces route changes via a live region", async () => {
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/#/overview");
    await page.waitForSelector("#pageTitle");
    const live = await page.evaluate(() => {
      const el = document.getElementById("routeAnnounce");
      if (!el) return null;
      return { aria: el.getAttribute("aria-live"), atomic: el.getAttribute("aria-atomic") };
    });
    expect(live).not.toBeNull();
    expect(["polite", "assertive"]).toContain(live!.aria);
    // Navigate and confirm the live region reflects the new route.
    await page.evaluate(() => { location.hash = "/entries"; });
    await page.waitForFunction(
      () => /entri/i.test(document.getElementById("routeAnnounce")?.textContent || ""),
      null,
      { timeout: 3000 },
    );
    await page.close();
  });

  it("makes the sidebar a modal drawer on a narrow viewport with the full focus contract", async () => {
    const page = await browser!.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseUrl + "/");
    await page.waitForSelector("#app");

    const drawer = page.locator("#navScroll");
    // Closed by default: not modal.
    expect(await drawer.getAttribute("aria-modal")).toBeNull();

    // Open via the mobile menu trigger.
    await page.getByRole("button", { name: /^menu$/i }).first().click();
    await page.waitForFunction(
      () => document.getElementById("navScroll")?.getAttribute("aria-modal") === "true",
      null,
      { timeout: 3000 },
    );
    expect(await drawer.getAttribute("role")).toBe("dialog");

    // Focus is contained within the drawer while open.
    await page.keyboard.press("Tab");
    const focusInside = await page.evaluate(() => {
      const d = document.getElementById("navScroll")!;
      return d.contains(document.activeElement);
    });
    expect(focusInside).toBe(true);

    // Escape closes and returns focus to the menu trigger.
    const trigger = page.getByRole("button", { name: /^menu$/i }).first();
    await trigger.evaluate((el) => el.setAttribute("data-test-trigger", "true"));
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => document.getElementById("navScroll")?.getAttribute("aria-modal") !== "true",
      null,
      { timeout: 3000 },
    );
    // Focus must have moved back to the trigger that opened the drawer.
    const focusOnTrigger = await page.evaluate(
      () => (document.activeElement as HTMLElement | null)?.getAttribute("data-test-trigger") === "true",
    );
    expect(focusOnTrigger).toBe(true);
    await page.close();
  });

  it("closes the drawer on backdrop click and on route change", async () => {
    const page = await browser!.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseUrl + "/");
    await page.waitForSelector("#app");
    await page.getByRole("button", { name: /^menu$/i }).first().click();
    await page.waitForFunction(
      () => document.getElementById("navScroll")?.getAttribute("aria-modal") === "true",
      null,
      { timeout: 3000 },
    );
    // Backdrop click closes.
    await page.locator("#backdrop").click();
    await page.waitForFunction(
      () => document.getElementById("navScroll")?.getAttribute("aria-modal") !== "true",
      null,
      { timeout: 3000 },
    );
    // Re-open, then a route change must also close it.
    await page.getByRole("button", { name: /^menu$/i }).first().click();
    await page.waitForFunction(
      () => document.getElementById("navScroll")?.getAttribute("aria-modal") === "true",
      null,
      { timeout: 3000 },
    );
    await page.evaluate(() => { location.hash = "/entries"; });
    await page.waitForFunction(
      () => document.getElementById("navScroll")?.getAttribute("aria-modal") !== "true",
      null,
      { timeout: 3000 },
    );
    await page.close();
  });

  it("preserves the navigation landmark's accessible name across an open→close cycle", async () => {
    // closeSidebar previously removed aria-label entirely, so after one mobile
    // open/close the nav landmark was unnamed on every subsequent desktop/tablet
    // state. The label must be restored to its original "Primary" value.
    const page = await browser!.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseUrl + "/");
    await page.waitForSelector("#app");
    // Sanity: starts named.
    expect(await page.locator("#navScroll").getAttribute("aria-label")).toBe("Primary");
    // Open → temporarily relabeled to "Primary navigation" (dialog context).
    await page.getByRole("button", { name: /^menu$/i }).first().click();
    await page.waitForFunction(
      () => document.getElementById("navScroll")?.getAttribute("aria-modal") === "true",
      null,
      { timeout: 3000 },
    );
    expect(await page.locator("#navScroll").getAttribute("aria-label")).toBe("Primary navigation");
    // Close → label MUST be restored, not removed.
    await page.locator("#backdrop").click();
    await page.waitForFunction(
      () => document.getElementById("navScroll")?.getAttribute("aria-modal") !== "true",
      null,
      { timeout: 3000 },
    );
    const labelAfterClose = await page.locator("#navScroll").getAttribute("aria-label");
    expect(labelAfterClose).toBe("Primary");
    await page.close();
  });

  it("keeps a mobile bottom nav limited to Dashboard, Entries, Add, and More", async () => {
    const page = await browser!.newPage();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(baseUrl + "/");
    await page.waitForSelector(".bottom-bar");
    const labels = await page.locator(".bottom-bar button").evaluateAll((els) =>
      els.map((e) => (e.textContent || "").trim().toLowerCase()),
    );
    // Exactly four quick actions: dashboard, entries, add, more.
    expect(labels).toEqual(["dashboard", "entries", "add", "more"]);
    await page.close();
  });

  it("updates the top-bar page title and description per route", async () => {
    const page = await browser!.newPage();
    await page.goto(baseUrl + "/#/overview");
    await page.waitForSelector("#pageTitle");
    const overviewTitle = await page.locator("#pageTitle").textContent();
    expect(overviewTitle?.toLowerCase()).toContain("dashboard");
    const overviewDesc = await page.locator("#pageDesc").textContent();
    expect(overviewDesc!.length).toBeGreaterThan(0);
    await page.close();
  });
});

// Module-level teardown: runs once after all describe blocks finish, so the
// shared browser/server (launched in the first block's beforeAll) survive for
// every test that follows it.
afterAll(async () => {
  await browser?.close();
  await closeServer?.();
});
