#!/usr/bin/env node

import { request as httpRequest, createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_ENTRY = resolve(REPO_ROOT, "dist/scripts/ui-server.js");
const PROVIDER_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_API_KEY_CRITIQUE",
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "XAI_API_KEY",
  "VOYAGE_API_KEY",
];

// These are the classes of private identity this route must never publish. The
// response-scoped ids (`evidence-<n>`) are intentionally not included here.
const PRIVATE_RESPONSE_MARKERS = [
  /\bcorpus-[a-z0-9][a-z0-9_-]*/i,
  /(?:^|[/\\])images-private(?:[/\\]|$)/i,
];
const ALLOW_PENDING_INTENT = process.argv.includes("--allow-pending-intent");
const INTENT_GATE_MESSAGE = "intent fields are not available yet; land Stream 1 S2 before running dogfood";

const INTENT_BRIEF = {
  productContext: "A local settings screen for two-factor setup",
  constraints: ["AA contrast", "primary action always visible"],
  colorIntent: {
    accentPreference: "light blue",
    mood: "calm",
    contrastFloor: "AA",
  },
  typeIntent: {
    voice: "clear and direct",
    density: "compact",
  },
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.once("error", rejectPort);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => rejectPort(new Error("could not determine a free loopback port")));
        return;
      }
      probe.close(() => resolvePort(address.port));
    });
  });
}

async function request(baseUrl, path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(5_000),
  });
  const text = await response.text();
  let json = null;
  try {
    json = text.length > 0 ? JSON.parse(text) : null;
  } catch {
    // Callers can still assert the status and inspect only safe shape facts.
  }
  const result = { status: response.status, text, json };
  assertNoPrivateBody(result, `${init.method ?? "GET"} ${path}`);
  return result;
}

function assertNoPrivateBody(response, label) {
  for (const marker of PRIVATE_RESPONSE_MARKERS) {
    assert(!marker.test(response.text), `private response marker found in ${label}`);
  }
}

function rawRequest(port, options) {
  return new Promise((resolveResponse, rejectResponse) => {
    const client = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: options.path,
        method: options.method ?? "GET",
        headers: options.headers,
        setHost: false,
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          text += chunk;
        });
        response.on("end", () => {
          const result = { status: response.statusCode ?? 0, text, json: null };
          try {
            result.json = text.length > 0 ? JSON.parse(text) : null;
          } catch {
            // Keep the raw text for a status-only security assertion.
          }
          assertNoPrivateBody(result, `${options.method ?? "GET"} ${options.path}`);
          resolveResponse(result);
        });
      },
    );
    client.once("error", rejectResponse);
    client.end(options.body ?? "");
  });
}

async function startServer() {
  assert(existsSync(SERVER_ENTRY), "dist is missing; run npm run build before dogfood");

  const port = await freePort();
  const environment = { ...process.env, C2_NO_DOTENV: "1", CLEAN_UI_PORT: String(port) };
  for (const key of PROVIDER_KEYS) delete environment[key];

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    env: environment,
    stdio: "ignore",
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  try {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (exited) throw new Error("ui server exited before becoming ready");
      try {
        const ready = await request(baseUrl, "/api/csrf");
        if (ready.status === 200) {
          return {
            baseUrl,
            port,
            stop: () => stopProcess(child, () => exited),
          };
        }
      } catch {
        // The child may still be binding. Keep the bounded readiness loop.
      }
      await sleep(150);
    }
    throw new Error("ui server did not become ready within 30 seconds");
  } catch (error) {
    await stopProcess(child, () => exited);
    throw error;
  }
}

async function stopProcess(child, hasExited) {
  if (!hasExited() && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise((resolveExit) => child.once("exit", resolveExit));
    child.kill("SIGTERM");
    await Promise.race([ended, sleep(5_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

function parseNonce(response) {
  assert(response.status === 200, "csrf nonce request was not accepted");
  const nonce = response.json?.nonce;
  assert(typeof nonce === "string" && /^[0-9a-f]{64}$/.test(nonce), "csrf response had an invalid nonce");
  return nonce;
}

function jsonHeaders(nonce, extra = {}) {
  return {
    "content-type": "application/json",
    "x-clean-ui-csrf": nonce,
    ...extra,
  };
}

async function postJson(baseUrl, nonce, body, extraHeaders = {}) {
  return request(baseUrl, "/api/create-ui-spec", {
    method: "POST",
    headers: jsonHeaders(nonce, extraHeaders),
    body: JSON.stringify(body),
  });
}

function requireEnvelope(response) {
  if (response.status === 400 && response.json?.error?.code === "INVALID_INPUT") {
    throw new Error(INTENT_GATE_MESSAGE);
  }
  assert(response.status === 200, "valid create_ui_spec brief was not accepted");
  assert(response.json !== null && typeof response.json === "object", "create_ui_spec response was not JSON");
  return response.json;
}

async function run() {
  const server = await startServer();
  try {
    const nonce = parseNonce(await request(server.baseUrl, "/api/csrf"));

    // The no-model route must honor both caller constraints and structured intent
    // once S2 is present; this is the primary end-to-end dogfood brief.
    let intentPending = false;
    let first;
    try {
      first = requireEnvelope(await postJson(server.baseUrl, nonce, INTENT_BRIEF));
      assert(first.spec?.context?.colorIntent?.accentPreference === "light blue", "color intent was not honored in spec.context");
      assert(first.spec?.context?.typeIntent?.density === "compact", "type intent was not honored in spec.context");
      assert(
        first.spec?.acceptanceCriteria?.some((criterion) => criterion.subject === "AA contrast"),
        "caller constraint was not honored as an acceptance criterion",
      );
    } catch (error) {
      if (!ALLOW_PENDING_INTENT || !(error instanceof Error) || error.message !== INTENT_GATE_MESSAGE) {
        throw error;
      }
      intentPending = true;
      // Before S2 lands, still exercise the route and determinism checks with the
      // already-supported portion of the same brief. The default command remains
      // strict; this mode is only for parallel-worker progress.
      first = requireEnvelope(
        await postJson(server.baseUrl, nonce, {
          productContext: INTENT_BRIEF.productContext,
          constraints: INTENT_BRIEF.constraints,
        }),
      );
    }

    // Repeat the same semantic request after the timestamp has advanced. The
    // semantic identity must hold while timestamp-bearing hashes vary.
    await sleep(20);
    const second = requireEnvelope(
      await postJson(
        server.baseUrl,
        nonce,
        intentPending
          ? { productContext: INTENT_BRIEF.productContext, constraints: INTENT_BRIEF.constraints }
          : INTENT_BRIEF,
      ),
    );
    assert(first.semanticSpecSha256 === second.semanticSpecSha256, "semantic hash changed for identical inputs");
    assert(first.specSha256 !== second.specSha256, "spec hash did not change with generation time");

    // CSRF and origin guards run before body parsing or the producer.
    const noCsrf = await request(server.baseUrl, "/api/create-ui-spec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ productContext: "A valid brief without a csrf header" }),
    });
    assert(noCsrf.status === 403, "missing csrf was not refused");
    assert(noCsrf.json?.code === "CSRF_REQUIRED", "missing csrf did not return the typed refusal");

    const wrongOriginNonce = await request(server.baseUrl, "/api/csrf", {
      headers: { origin: "http://evil.example" },
    });
    assert(wrongOriginNonce.status === 403, "cross-origin nonce request was not refused");

    const wrongOrigin = await postJson(server.baseUrl, nonce, INTENT_BRIEF, {
      origin: "http://evil.example",
    });
    assert(wrongOrigin.status === 403, "cross-origin create_ui_spec request was not refused");

    const invalidJson = await request(server.baseUrl, "/api/create-ui-spec", {
      method: "POST",
      headers: jsonHeaders(nonce),
      body: "not-json-with-a-caller-token",
    });
    assert(invalidJson.status === 400, "malformed JSON was not refused");
    assert(!invalidJson.text.includes("not-json-with-a-caller-token"), "malformed request bytes were echoed");

    const invalidBrief = await postJson(server.baseUrl, nonce, { productContext: "tiny" });
    assert(invalidBrief.status === 400, "schema-invalid brief was not refused");
    assert(!invalidBrief.text.includes("tiny"), "invalid brief text was echoed");

    const credentialed = await postJson(server.baseUrl, nonce, { productContext: "A valid brief with a credential" }, {
      authorization: "Bearer local-test-token",
    });
    assert(credentialed.status === 400, "credentialed request was not refused");
    assert(!credentialed.text.includes("local-test-token"), "credential value was echoed");

    const hostileHost = await rawRequest(server.port, {
      path: "/api/csrf",
      headers: { host: "evil.example", origin: "http://evil.example" },
    });
    assert(hostileHost.status === 403, "non-loopback Host was not refused");

    console.log(
      intentPending
        ? "dogfood-createuispec: PASS (S2 pending; rerun without --allow-pending-intent after S2)"
        : "dogfood-createuispec: PASS",
    );
  } finally {
    await server.stop();
  }
}

run().catch((error) => {
  console.error(`dogfood-createuispec: FAIL: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
});
