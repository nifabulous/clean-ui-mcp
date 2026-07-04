import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const appHtml = readFileSync(resolve(__dirname, "../..", "index-2.html"), "utf-8");

// Hoisted so both describe blocks share the single browser + server launched in
// the first block's beforeAll. Vitest runs describe blocks in file order.
let browser: Browser | undefined;
let baseUrl = "";
let closeServer: (() => Promise<void>) | undefined;
let openaiConfigured = true;
// Per-batch hash sets for the check-duplicate stub (mirrors the real server's
// in-batch dedup). Cleared per test by clearing the map.
const batchHashes = new Map<string, Set<string>>();

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
      if (url.pathname === "/" || url.pathname === "/index-2.html") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(appHtml);
        return;
      }
      if (url.pathname === "/api/schema") return json(res, 200, schema);
      if (url.pathname === "/api/entries" && req.method === "GET") return json(res, 200, { entries: [] });
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
        return json(res, 201, { path: `images-private/${slug}.png`, width: 1200, height: 800, visibility: "private", hash, dhash: hash.slice(0, 16) });
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
      if (url.pathname === "/api/capture-url" && req.method === "POST") {
        await readBody(req);
        return json(res, 201, { path: "images-private/captured.png", width: 1440, height: 1000, visibility: "private" });
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
        await readBody(req);
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
    await page.goto(baseUrl);
    await page.getByRole("button", { name: "New sample", exact: true }).first().click();

    expect(await page.getByText("Capture or upload a screenshot before saving.").isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "Save" }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "Auto-fill" }).isDisabled()).toBe(true);

    await page.close();
  });

  it("enables auto-fill after upload or URL capture provides an image", async () => {
    openaiConfigured = true;
    const page = await browser.newPage();
    await page.goto(baseUrl);
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
    await page.goto(baseUrl);
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
    await page.goto(baseUrl);
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
    await page.waitForSelector(".status-chip.staged");
    // Auto-fill stays disabled without the key.
    expect(await page.getByRole("button", { name: /Auto-fill all/ }).isDisabled()).toBe(true);
    await page.close();
  });
});

// Module-level teardown: runs once after both describe blocks finish, so the
// shared browser/server (launched in the first block's beforeAll) survive for
// the bulk-import tests that follow it.
afterAll(async () => {
  await browser?.close();
  await closeServer?.();
});
