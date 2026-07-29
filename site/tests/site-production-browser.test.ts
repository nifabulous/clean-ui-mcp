// @vitest-environment node
//
// PRODUCTION-SERVER browser suite (C3 Task 7).
//
// WHY THIS EXISTS SEPARATELY FROM site-browser.test.ts. That suite runs against
// `vite preview`, which is a DEVELOPMENT static server. The C3 requirement is that
// the operator-controlled loopback process — the one `npm run ui` starts — serves
// the built site AND `/api/*` from the same origin. `vite preview` cannot be
// evidence for that: it has no `/api/*` at all (which is why the preview suite has
// to intercept those calls), it resolves static paths with Vite's own middleware
// rather than the server's traversal-safe resolver, and it knows nothing about the
// `CLEAN_UI_SITE_DIST` contract. A green preview suite is therefore compatible with
// a completely broken production serving path.
//
// So this suite starts the same SERVER ENTRYPOINT the operator runs —
// `node dist/scripts/ui-server.js`, which is the second half of
// `npm run ui` (`tsc && node dist/scripts/ui-server.js`) — and drives a real
// Chromium against it.
//
// IT IS NOT THE EXACT `npm run ui` INVOCATION, and an earlier revision of this
// header wrongly said it was. Four deliberate differences:
//   - `CLEAN_UI_SITE_DIST=site/dist` is set here; `package.json`'s `ui` script
//     sets nothing, so plain `npm run ui` serves no site at all. The operator's
//     equivalent dogfood form is `CLEAN_UI_SITE_DIST=site/dist npm run ui`
//     (README § "Production suite").
//   - `tsc` is not re-run in-process; `site:test:browser:production` does the
//     build first, and `startProductionServer` fails loudly if the entrypoint is
//     missing rather than serving a stale one.
//   - every provider key is stripped from the child's env, and
//   - `C2_NO_DOTENV=1` is set, because `src/env.ts` auto-loads `.env` with
//     `override: true` at module scope — without it a maintainer's `.env` would
//     re-inject the very credentials this suite asserts never reach the wire.
//     An operator reproducing this fixture by hand needs both: `env -u` for the
//     provider keys and `C2_NO_DOTENV=1`.
// What the suite is evidence for is the server's own behaviour — routing, the
// SPA fallback, `/api/*` ownership, asset resolution — not for the npm script.
//
// It asserts the two properties the route migration in Task 6 put at risk:
//   1. `/clean-ui-mcp/playground` loads the focused C3 composer.
//   2. `/clean-ui-mcp/browse` preserves the corpus-search surface, including its
//      query-string contract.
// Both are asserted through the SPA fallback of the production server, which is a
// different code path from Vite's history fallback.
//
// It additionally asserts that this server really does own `/api/*` (the whole
// point of serving from here rather than a static host) and that the served
// document carries no provider credential — cheap checks that only this fixture
// can make, because only this fixture has a server with an API beside the site.
//
// NO NETWORK, NO PROVIDER. The child process is spawned with every provider key
// cleared and with `C2_NO_DOTENV=1`, so `src/env.ts`'s module-scope `loadEnv()`
// (which uses `override: true`) cannot inject the repo `.env` into it. Without that
// the suite would silently run WITH credentials configured.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const SITE_ROOT = resolve(__dirname, "..");
const REPO_ROOT = resolve(SITE_ROOT, "..");
const DIST_INDEX = resolve(SITE_ROOT, "dist", "index.html");
const SERVER_ENTRY = resolve(REPO_ROOT, "dist", "scripts", "ui-server.js");

/** Provider credentials the child must not have. Cleared explicitly. */
const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_KEY_CRITIQUE",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "XAI_API_KEY",
  "VOYAGE_API_KEY",
] as const;

/**
 * Ask the OS for a free loopback port, then release it.
 *
 * The server reads a FIXED port from `CLEAN_UI_PORT` (default 3131) and logs
 * `http://localhost:${PORT}`, so `CLEAN_UI_PORT=0` would leave the suite unable to
 * learn the real port from the log. Choosing the port here also means the suite
 * never collides with an operator's own `npm run ui` on 3131.
 */
function freePort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => rejectPort(new Error("could not determine a free port")));
        return;
      }
      const { port } = address;
      probe.close(() => resolvePort(port));
    });
  });
}

// Deliberately NOT exported. The fixture is used only by this suite; exporting it
// would add an unconsumed public surface that nothing verifies.
interface ProductionServer {
  readonly baseUrl: string;
  readonly port: number;
  readonly proc: ChildProcess;
  /** Resolves once the process has actually exited. */
  stop(): Promise<void>;
}

/**
 * The spawned child, published the INSTANT it exists — before readiness polling,
 * before `startProductionServer()` resolves.
 *
 * `beforeAll` has a 90s budget. If startup exceeds it, vitest fails the hook and
 * the `server = await startProductionServer()` assignment never happens, so an
 * `afterAll` that could only see `server` would be a no-op while a child holds a
 * listening socket for the rest of the run (the child is not `detached`, so a
 * parent exit does not reap it either). Publishing the handle here — not on
 * resolve — is what makes the child reachable for teardown on EVERY failure mode:
 * throw, reject, and hook timeout alike.
 *
 * `stop()` is idempotent (it returns early once the process has exited or been
 * signalled), so the readiness `catch` calling it and `afterAll` calling it again
 * is safe.
 */
let spawnedServer: ProductionServer | undefined;

/**
 * Start the production loopback server and resolve once it answers.
 *
 * Readiness is a real HTTP 200 for the base path, not a log line: the log is
 * printed from the `listen` callback, so a server that binds and then fails to
 * resolve `site/dist` would look ready. Polling the actual route cannot.
 */
async function startProductionServer(): Promise<ProductionServer> {
  if (!existsSync(SERVER_ENTRY)) {
    throw new Error(
      `${SERVER_ENTRY} is missing. Run \`tsc\` (or \`npm run build\`) before the production browser suite.`,
    );
  }
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}/clean-ui-mcp/`;

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of PROVIDER_KEYS) delete env[key];
  // src/env.ts auto-loads .env with override:true unless this is set.
  env.C2_NO_DOTENV = "1";
  env.CLEAN_UI_PORT = String(port);
  env.CLEAN_UI_SITE_DIST = "site/dist";

  const proc = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output: string[] = [];
  proc.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  proc.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

  let exited: { code: number | null } | undefined;
  proc.once("exit", (code) => {
    exited = { code };
  });

  /**
   * Deterministic shutdown: SIGTERM, then SIGKILL if it is not honored within 5s,
   * and resolve only once the process has actually exited (bounded, so a wedged
   * child cannot hang the hook indefinitely). A leaked child would hold its port
   * and silently poison a later run.
   */
  const stop = async (): Promise<void> => {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    const ended = new Promise<void>((resolveEnded) => proc.once("exit", () => resolveEnded()));
    proc.kill("SIGTERM");
    const escalate = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, 5_000);
    const gaveUp = new Promise<void>((resolveGaveUp) => setTimeout(resolveGaveUp, 15_000));
    await Promise.race([ended, gaveUp]);
    clearTimeout(escalate);
  };

  const handle: ProductionServer = { baseUrl, port, proc, stop };
  // Reachable for teardown from here on — see `spawnedServer` above. This
  // assignment must precede the readiness loop, which is the part that can hang.
  spawnedServer = handle;

  // Readiness is a real HTTP 200, not a log line. Any failure from here on MUST
  // stop the child first: `beforeAll` throwing means `afterAll` never receives a
  // handle to it, so a bare `throw` would leak the process (and its port) for the
  // rest of the run. That is the whole reason this is a try/catch rather than a
  // bare loop.
  try {
    const deadline = Date.now() + 30_000;
    for (;;) {
      if (exited !== undefined) {
        throw new Error(
          `production server exited before becoming ready (code ${exited.code}): ${output.join("")}`,
        );
      }
      try {
        // PER-ATTEMPT TIMEOUT, NOT OPTIONAL. Without a signal, undici's default
        // header/body timeout is 300s, so a child that BINDS the port but never
        // answers (wedged corpus load, saturated machine) parks this `await`
        // forever — the `Date.now() > deadline` check below never executes and the
        // 30s deadline is unreachable. 3s is far above a loopback response time
        // and keeps the deadline the real bound: ~9 attempts, then a clean throw
        // that runs `stop()` instead of a hook timeout that cannot.
        const response = await fetch(baseUrl, { signal: AbortSignal.timeout(3_000) });
        if (response.status === 200) {
          // Drain the body so the socket closes cleanly.
          await response.text();
          break;
        }
      } catch {
        // Not listening yet, or this attempt timed out. Either way, re-check the
        // deadline below rather than retrying unbounded.
      }
      if (Date.now() > deadline) {
        throw new Error(`production server did not become ready: ${output.join("")}`);
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch (error) {
    await stop();
    throw error;
  }

  return handle;
}

let browser: Browser | undefined;
let server: ProductionServer | undefined;
let baseUrl = "";

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
    (ctx as unknown as { __failed: typeof failed }).__failed = failed;
    return ctx;
  });
}

function failedOf(ctx: BrowserContext): Array<{ url: string; status: number }> {
  return (ctx as unknown as { __failed: Array<{ url: string; status: number }> }).__failed;
}

async function rootH1Text(page: Page): Promise<string> {
  await page.waitForSelector("#root h1", { timeout: 15_000 });
  return page
    .locator("#root h1")
    .first()
    .textContent()
    .then((t) => (t ?? "").trim());
}

beforeAll(async () => {
  if (!existsSync(DIST_INDEX) || !readFileSync(DIST_INDEX, "utf-8").includes("/clean-ui-mcp/assets/")) {
    throw new Error(
      "site/dist is stale or missing. Run `npm run site:build` before the production browser suite.",
    );
  }
  server = await startProductionServer();
  baseUrl = server.baseUrl;
  browser = await chromium.launch({ headless: true });
}, 90_000);

afterAll(async () => {
  // EACH RESOURCE IS RELEASED INDEPENDENTLY. Playwright rejects on flaky teardown
  // ("Target closed"), and without the `finally` that rejection propagates out of
  // the hook before the server is stopped — leaking the child and holding its port
  // for the rest of the run, the same leak class as the readiness hang. The server
  // is stopped via `spawnedServer`, not `server`, so it is released even when
  // `beforeAll` never got far enough to assign `server`.
  try {
    await browser?.close();
  } finally {
    await spawnedServer?.stop();
  }
});

describe("production loopback server — built site", () => {
  it("serves the site from CLEAN_UI_SITE_DIST at the base path", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const response = await page.goto(baseUrl);
    expect(response?.status()).toBe(200);
    expect(await rootH1Text(page)).toMatch(/design judgment for ai agents/i);
    expect(failedOf(ctx)).toEqual([]);
    await ctx.close();
  }, 45_000);

  it("loads the C3 composer at /clean-ui-mcp/playground", async () => {
    // The composer route through the PRODUCTION server's SPA fallback and its own
    // static resolver — not Vite's history fallback. The lazy PlaygroundPage chunk
    // must resolve from this origin too, which is what a broken base-path or a
    // traversal-guard that rejects the assets directory would break.
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const response = await page.goto(`${baseUrl}playground`);
    expect(response?.status()).toBe(200);
    expect(await rootH1Text(page)).toMatch(/generate a grounded design handoff/i);
    // The brief field is the composer, not a shell that merely rendered a heading.
    await page.locator("#composer-brief").waitFor({ state: "visible", timeout: 30_000 });
    expect(failedOf(ctx)).toEqual([]);
    await ctx.close();
  }, 60_000);

  it("preserves the search surface at /clean-ui-mcp/browse", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    const response = await page.goto(`${baseUrl}browse`);
    expect(response?.status()).toBe(200);
    expect(await rootH1Text(page)).toMatch(/search the critiqued corpus/i);
    await page.getByLabel(/ask the corpus/i).waitFor({ state: "visible", timeout: 30_000 });
    expect(failedOf(ctx)).toEqual([]);
    await ctx.close();
  }, 60_000);

  it("round-trips the /browse query string through the production server", async () => {
    // Every previously-shared search URL has to survive being served from here.
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
    expect(url).toContain("/browse");
    await ctx.close();
  }, 60_000);

  it("owns /api/* on the same origin as the site", async () => {
    // THE property `vite preview` cannot demonstrate: the composer's API is served
    // by the same process, so the browser's same-origin fetch reaches a real nonce
    // endpoint with no interception at all.
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}playground`);
    await rootH1Text(page);

    const nonce = await page.evaluate(async () => {
      const res = await fetch("/api/csrf");
      if (!res.ok) return { status: res.status, nonce: "" };
      const body = (await res.json()) as { nonce?: unknown };
      return { status: res.status, nonce: typeof body.nonce === "string" ? body.nonce : "" };
    });
    expect(nonce.status).toBe(200);
    expect(nonce.nonce).toMatch(/^[0-9a-f]{64}$/);

    // And the gate is real: the same mutating route refuses a request without it.
    const refused = await page.evaluate(async () => {
      const res = await fetch("/api/create-ui-spec", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ productContext: "a brief long enough to pass the minimum" }),
      });
      return res.status;
    });
    expect(refused).toBe(403);
    await ctx.close();
  }, 60_000);

  it("puts no provider credential in the served document", async () => {
    const ctx = await newTracingContext();
    const page = await ctx.newPage();
    await page.goto(`${baseUrl}playground`);
    await rootH1Text(page);
    const serialized = await page.content();
    for (const marker of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "sk-", "Bearer "]) {
      expect(serialized).not.toContain(marker);
    }
    await ctx.close();
  }, 45_000);
});
