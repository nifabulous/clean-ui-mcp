import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
        return json(res, 201, { path: `images-private/${slug}.png`, width: 1200, height: 800, visibility: "private", hash: `hash-${slug}`, dhash: `dhash-${slug}` });
      }
      if (url.pathname === "/api/check-duplicate" && req.method === "POST") {
        await readBody(req);
        return json(res, 200, { duplicate: false, type: null, match: null });
      }
      if (url.pathname === "/api/capture-url" && req.method === "POST") {
        await readBody(req);
        return json(res, 201, { path: "images-private/captured.png", width: 1440, height: 1000, visibility: "private" });
      }
      if (url.pathname === "/api/auto-tag" && req.method === "POST") {
        await readBody(req);
        // Minimal valid tagged entry; critique is long enough to pass the
        // 80-char schema minimum so commit-draft logic would accept it.
        return json(res, 200, { entry: {
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
          critique: "[DRAFT — REWRITE] This is a long enough draft critique to clear the schema minimum length for testing.",
          whatToSteal: ["[DRAFT] A concrete copyable technique a developer could apply directly."],
          antiPatterns: {
            antiPatterns: ["[DRAFT] Avoids drop shadows; uses background-color steps for depth."],
            whereThisFails: [],
            accessibilityRisks: [],
          },
          qualityScore: 3,
          addedAt: "2026-07-02",
        }});
      }
      if (url.pathname === "/api/entries" && req.method === "POST") {
        const body = JSON.parse(await readBody(req) || "{}");
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
      { name: "random-screen.png", mimeType: "image/png", buffer: Buffer.from(png1x1, "base64") },
    ]);

    await page.waitForSelector("text=linear__board.png");
    await page.waitForSelector("text=random-screen.png");

    expect(await page.locator(".bulk-row").count()).toBe(2);
    // Filename prefix `linear__` → "Linear" via KNOWN_PRODUCTS; generic → batch default.
    const products = await page.locator("[data-bulk-product]").evaluateAll((els) => els.map((e) => (e as HTMLInputElement).value));
    expect(products).toEqual(["Linear", "TestCo"]);
    // Both staged; auto-fill now enabled.
    expect(await page.locator(".status-chip.staged").count()).toBe(2);
    expect(await page.getByRole("button", { name: /Auto-fill all/ }).isDisabled()).toBe(false);
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

    await page.getByRole("button", { name: /Auto-fill all/ }).click();
    await page.waitForSelector(".status-chip.tagged", { timeout: 5000 });

    expect(await page.locator(".status-chip.tagged").count()).toBe(1);
    expect(await page.getByRole("button", { name: /Commit ready/ }).isDisabled()).toBe(false);
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
