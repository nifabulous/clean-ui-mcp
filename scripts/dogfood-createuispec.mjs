#!/usr/bin/env node

import { request as httpRequest, createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
const MODEL_ENV_KEYS = [
  "CREATE_UI_SPEC_MODEL_PROVIDER",
  "CREATE_UI_SPEC_MODEL_BASE_URL",
  "CREATE_UI_SPEC_MODEL_API_KEY",
  "CREATE_UI_SPEC_MODEL_NAME",
];

// This task's dogfood fixture secrets. The API key and fake-provider URL are
// loaded into the ui-server child env (and the store path is its artifact
// root), so the no-secret-in-served-bytes sweep must treat them as private
// markers. The raw-body fixture is the malformed provider response; if any
// served byte ever echoes a raw model body, this catches it.
const DOGFOOD_MODEL_PROVIDER = "openai";
const DOGFOOD_MODEL_NAME = "dogfood-proposal-model";
const DOGFOOD_MODEL_API_KEY = "dogfood-c3-proposal-api-key-7f3a9c";
const RAW_MODEL_BODY_FIXTURE = "not-json-raw-model-body-fixture";
const MODEL_ARTIFACT_STORE_DIRNAME = ".create-ui-spec-model-artifacts";
const MODEL_ARTIFACT_STORE_ROOT = resolve(REPO_ROOT, MODEL_ARTIFACT_STORE_DIRNAME);
const MODEL_PROPOSAL_DISCLAIMER = "Proposal only; not accepted into token authority.";

// These are the classes of private identity this route must never publish. The
// response-scoped ids (`evidence-<n>`) are intentionally not included here.
const PRIVATE_RESPONSE_MARKERS = [
  /\bcorpus-[a-z0-9][a-z0-9_-]*/i,
  /(?:^|[/\\])images-private(?:[/\\]|$)/i,
  new RegExp(escapeRegExp(DOGFOOD_MODEL_API_KEY)),
  new RegExp(escapeRegExp(MODEL_ARTIFACT_STORE_DIRNAME)),
  new RegExp(escapeRegExp(RAW_MODEL_BODY_FIXTURE)),
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

// The proposal fixture is served by the fake provider as the model's raw body
// and is projected into the served envelope as spec.modelProposal, so it must
// carry no corpus ids, paths, or secret words. It satisfies the strict
// ModelProposalSchema: the status literal, the exact disclaimer, bounded
// designDirection, five color tokens, three typography tokens, at most eight
// bounded motion notes, and bounded contentVoiceGuidance.
const PROPOSAL_FIXTURE = {
  status: "proposal-only",
  disclaimer: MODEL_PROPOSAL_DISCLAIMER,
  designDirection:
    "A two-step flow that separates account verification from recovery setup. " +
    "The form stays on a single column so the eye traces one path, and the " +
    "primary action remains visible without scrolling on the smallest " +
    "supported screen. Copy uses short sentences and names each field's " +
    "purpose above the input rather than beside it.",
  colorTokens: {
    primary: "#0b6bcb",
    surface: "#f7fafc",
    ink: "#0f172a",
    muted: "#5b6b7b",
    accent: "#12b3e8",
  },
  typographyTokens: {
    heading: "Inter",
    body: "Inter",
    mono: "JetBrains Mono",
  },
  motionNotes: [
    "Settle the panel 120ms after the last keystroke",
    "Fade the success confirmation instead of sliding it",
    "Keep transitions under 200ms on the constrained surface",
  ],
  contentVoiceGuidance:
    "Direct, plain language that names actions by their effect; no brand voice or technical jargon.",
};
const PROPOSAL_FIXTURE_JSON = JSON.stringify(PROPOSAL_FIXTURE);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sleep(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

async function startServer(extraEnv = {}) {
  assert(existsSync(SERVER_ENTRY), "dist is missing; run npm run build before dogfood");

  const port = await freePort();
  const environment = { ...process.env, C2_NO_DOTENV: "1", CLEAN_UI_PORT: String(port) };
  for (const key of PROVIDER_KEYS) delete environment[key];
  for (const key of MODEL_ENV_KEYS) delete environment[key];
  Object.assign(environment, extraEnv);

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

// A fake OpenAI-compatible provider over TLS with a runtime self-signed cert.
// The ui-server child is spawned with NODE_TLS_REJECT_UNAUTHORIZED=0 so its
// fetch trusts the cert. The base URL must pass the config gate: https, no
// userinfo. Responses omit the model identity so the tagger trusts the pinned
// request model, and carry the usage the C2 fail-closed path requires.
async function startFakeProvider() {
  const tmpDir = mkdtempSync(join(tmpdir(), "c3-model-fake-provider-"));
  try {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
        "-subj", "/CN=localhost",
        "-keyout", join(tmpDir, "key.pem"),
        "-out", join(tmpDir, "cert.pem"),
      ],
      { stdio: "ignore" },
    );
  } catch (error) {
    rmSync(tmpDir, { recursive: true, force: true });
    throw new Error(
      "openssl is required to run dogfood (self-signed cert for the fake model provider); install it or invoke the script from a machine with openssl",
      { cause: error },
    );
  }
  const key = readFileSync(join(tmpDir, "key.pem"));
  const cert = readFileSync(join(tmpDir, "cert.pem"));

  const port = await freePort();
  let behavior = "success";
  let malformedOnceFired = false;
  const server = createHttpsServer({ key, cert }, (req, res) => {
    req.resume();
    const body = fakeProviderBody(behavior, malformedOnceFired);
    if (behavior === "malformed-once" && !malformedOnceFired) malformedOnceFired = true;
    res.writeHead(behavior === "provider-failure" ? 500 : 200, {
      "content-type": "application/json",
    });
    res.end(body);
  });
  await new Promise((resolveReady, rejectReady) => {
    server.once("error", rejectReady);
    server.listen(port, "127.0.0.1", resolveReady);
  });

  return {
    baseUrl: `https://localhost:${port}/v1`,
    setBehavior: (next) => {
      behavior = next;
      malformedOnceFired = false;
    },
    stop: async () => {
      await new Promise((resolveClosed) => server.close(resolveClosed));
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

function fakeProviderBody(behavior, malformedOnceFired) {
  const usage = { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 };
  if (behavior === "provider-failure") {
    return JSON.stringify({ error: "fake provider failure" });
  }
  if (behavior === "malformed" || (behavior === "malformed-once" && !malformedOnceFired)) {
    return JSON.stringify({ choices: [{ message: { content: RAW_MODEL_BODY_FIXTURE } }], usage });
  }
  return JSON.stringify({ choices: [{ message: { content: PROPOSAL_FIXTURE_JSON } }], usage });
}

function storeRecordNames() {
  if (!existsSync(MODEL_ARTIFACT_STORE_ROOT)) return [];
  return readdirSync(MODEL_ARTIFACT_STORE_ROOT)
    .filter((name) => name.endsWith(".json"))
    .sort();
}

function assertStoreEmpty() {
  assert(storeRecordNames().length === 0, "model artifact store is not empty before a model case");
}

function assertStoreHasNoRecords() {
  // Pre-flight guard: the store root is the production location
  // (.create-ui-spec-model-artifacts/ under the repo root). Dogfood must never
  // destroy real operator records, so refuse BEFORE any deletion when the store
  // holds records. A FILE at the path (the persistence-failure case's blocker)
  // is not a store and is not then an operator store.
  if (existsSync(MODEL_ARTIFACT_STORE_ROOT) && lstatSync(MODEL_ARTIFACT_STORE_ROOT).isDirectory()) {
    const records = storeRecordNames();
    assert(
      records.length === 0,
      `refusing to run dogfood against a non-empty model artifact store: ${records.length} record(s) in ${MODEL_ARTIFACT_STORE_ROOT}; move the store aside and rerun`,
    );
  }
}

function resetStore() {
  // Safe ONLY because assertStoreHasNoRecords() ran before the model-lane
  // section: anything the store holds from there on was created by this run and
  // is removed so a run finishes with the store absent.
  rmSync(MODEL_ARTIFACT_STORE_ROOT, { recursive: true, force: true });
}

// The store walker proves a success record exists ONLY under
// .create-ui-spec-model-artifacts/ — no other directory may grow a record.
const STORE_WALK_EXCLUDED_DIRS = new Set([".git", ".zcode", "node_modules", "dist", "site", "corpus"]);

function findArtifactRecordFiles(dir) {
  const hits = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") && entry.name !== MODEL_ARTIFACT_STORE_DIRNAME) continue;
    if (entry.isDirectory()) {
      if (STORE_WALK_EXCLUDED_DIRS.has(entry.name)) continue;
      hits.push(...findArtifactRecordFiles(join(dir, entry.name)));
    } else if (/^uispec-[0-9a-f]{64}\.json$/.test(entry.name)) {
      hits.push(join(dir, entry.name));
    }
  }
  return hits;
}

function assertTokensUnavailable(envelope) {
  assert(envelope.spec?.colorTokens === null, "accepted color tokens became available");
  assert(envelope.spec?.typographyTokens === null, "accepted typography tokens became available");
}

async function run() {
  const server = await startServer();
  let fakeProvider = null;
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

    // The no-config lane must leave the envelope free of any model trace:
    // execution metadata is absent, and the spec carries no proposal.
    assert(first.modelExecution === undefined, "modelExecution present on the no-config lane");
    assert(first.modelExecutionSha256 === undefined, "modelExecutionSha256 present on the no-config lane");
    assert(first.spec?.modelProposal === undefined, "modelProposal present on the no-config lane");
    assertTokensUnavailable(first);
    const baseSemantic = first.semanticSpecSha256;

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
    console.log("dogfood-createuispec: PASS no-config");

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

    // ── Model-lane cases ────────────────────────────────────────────────────
    // Each case spawns its own ui-server with a case-specific env overlay so
    // the model configuration is resolved per case. The fake provider serves
    // scriptable responses; its URL becomes a private response marker.
    assertStoreHasNoRecords();
    resetStore();
    fakeProvider = await startFakeProvider();
    PRIVATE_RESPONSE_MARKERS.push(new RegExp(escapeRegExp(fakeProvider.baseUrl)));

    const baseModelEnv = {
      CREATE_UI_SPEC_MODEL_PROVIDER: DOGFOOD_MODEL_PROVIDER,
      CREATE_UI_SPEC_MODEL_BASE_URL: fakeProvider.baseUrl,
      CREATE_UI_SPEC_MODEL_API_KEY: DOGFOOD_MODEL_API_KEY,
      CREATE_UI_SPEC_MODEL_NAME: DOGFOOD_MODEL_NAME,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    };
    const partialModelEnv = {
      CREATE_UI_SPEC_MODEL_PROVIDER: DOGFOOD_MODEL_PROVIDER,
      CREATE_UI_SPEC_MODEL_BASE_URL: fakeProvider.baseUrl,
      CREATE_UI_SPEC_MODEL_NAME: DOGFOOD_MODEL_NAME,
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
    };

    async function withModelServer(extraEnv, runBody) {
      const modelServer = await startServer(extraEnv);
      try {
        const modelNonce = parseNonce(await request(modelServer.baseUrl, "/api/csrf"));
        return await runBody(modelServer, modelNonce);
      } finally {
        await modelServer.stop();
      }
    }

    // Partial config (provider + base URL + name, no API key) must surface
    // invalid-configuration and keep the deterministic scaffold — never a
    // silent fallback to determinism that pretends no model was intended.
    resetStore();
    assertStoreEmpty();
    await withModelServer(partialModelEnv, async (modelServer, modelNonce) => {
      const envelope = requireEnvelope(await postJson(modelServer.baseUrl, modelNonce, INTENT_BRIEF));
      assert(envelope.modelExecution?.state === "invalid-configuration", "partial config did not surface invalid-configuration");
      assert(envelope.semanticSpecSha256 === baseSemantic, "partial config changed the deterministic scaffold");
      assertTokensUnavailable(envelope);
    });
    assertStoreEmpty();
    console.log("dogfood-createuispec: PASS partial-config");

    // Provider failure: the pinned fake provider answers 500. The envelope
    // must show call-failed, serve the identical deterministic scaffold, and
    // write no record.
    resetStore();
    assertStoreEmpty();
    fakeProvider.setBehavior("provider-failure");
    await withModelServer(baseModelEnv, async (modelServer, modelNonce) => {
      const envelope = requireEnvelope(await postJson(modelServer.baseUrl, modelNonce, INTENT_BRIEF));
      assert(envelope.modelExecution?.state === "call-failed", "provider failure did not surface call-failed");
      assert(envelope.semanticSpecSha256 === baseSemantic, "provider failure changed the deterministic scaffold");
      assertTokensUnavailable(envelope);
    });
    assertStoreEmpty();
    console.log("dogfood-createuispec: PASS provider-failure");

    // Malformed response: the fake provider answers 200 with a non-JSON raw
    // body. The envelope must show proposal-rejected, keep the deterministic
    // scaffold, and write no record.
    resetStore();
    assertStoreEmpty();
    fakeProvider.setBehavior("malformed");
    await withModelServer(baseModelEnv, async (modelServer, modelNonce) => {
      const envelope = requireEnvelope(await postJson(modelServer.baseUrl, modelNonce, INTENT_BRIEF));
      assert(envelope.modelExecution?.state === "proposal-rejected", "malformed response did not surface proposal-rejected");
      assert(envelope.semanticSpecSha256 === baseSemantic, "malformed response changed the deterministic scaffold");
      assertTokensUnavailable(envelope);
    });
    assertStoreEmpty();
    console.log("dogfood-createuispec: PASS malformed-response");

    // Parse-failure retry: with the operator opt-in set, the first generation
    // returns the malformed body and the second succeeds. The record must
    // carry attempts: 2 and the served envelope must show proposal-only with
    // accepted tokens null.
    resetStore();
    assertStoreEmpty();
    fakeProvider.setBehavior("malformed-once");
    await withModelServer({ ...baseModelEnv, CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS: "2" }, async (modelServer, modelNonce) => {
      const envelope = requireEnvelope(await postJson(modelServer.baseUrl, modelNonce, INTENT_BRIEF));
      assert(envelope.modelExecution?.state === "succeeded", "retry did not surface succeeded");
      assert(envelope.spec.modelProposal?.status === "proposal-only", "retry proposal not proposal-only");
      assertTokensUnavailable(envelope);
    });
    const records = readdirSync(MODEL_ARTIFACT_STORE_ROOT);
    assert(records.length === 1, "retry wrote exactly one record");
    const record = JSON.parse(readFileSync(join(MODEL_ARTIFACT_STORE_ROOT, records[0]), "utf8"));
    assert(record.attempts === 2, "retry record did not carry attempts 2");
    console.log("dogfood-createuispec: PASS parse-failure-retry");

    // Persistence failure: a FILE at the store root blocks the store's mkdir.
    // The provider call succeeds, but the record write fails and the envelope
    // must show persistence-failed with the deterministic scaffold restored.
    resetStore();
    writeFileSync(MODEL_ARTIFACT_STORE_ROOT, "blocking store mkdir\n");
    fakeProvider.setBehavior("success");
    await withModelServer(baseModelEnv, async (modelServer, modelNonce) => {
      const envelope = requireEnvelope(await postJson(modelServer.baseUrl, modelNonce, INTENT_BRIEF));
      assert(envelope.modelExecution?.state === "persistence-failed", "blocked store did not surface persistence-failed");
      assert(envelope.semanticSpecSha256 === baseSemantic, "persistence failure changed the deterministic scaffold");
      assertTokensUnavailable(envelope);
    });
    rmSync(MODEL_ARTIFACT_STORE_ROOT, { force: true });
    assertStoreEmpty();
    console.log("dogfood-createuispec: PASS persistence-failure");

    // Successful proposal: full tuple, the fake provider returns a valid
    // proposal. The proposal changes semantic identity, accepted-token
    // positions stay null, exactly one record exists under the store root,
    // and a rerun keeps the same semantic identity without a second record.
    resetStore();
    assertStoreEmpty();
    fakeProvider.setBehavior("success");
    let successEnvelope;
    await withModelServer(baseModelEnv, async (modelServer, modelNonce) => {
      successEnvelope = requireEnvelope(await postJson(modelServer.baseUrl, modelNonce, INTENT_BRIEF));
      assert(successEnvelope.modelExecution?.state === "succeeded", "valid proposal did not surface succeeded");
      assert(successEnvelope.modelExecution.provider === DOGFOOD_MODEL_PROVIDER, "succeeded run reported the wrong provider");
      assert(successEnvelope.modelExecution.model === DOGFOOD_MODEL_NAME, "succeeded run reported the wrong model");
      assert(successEnvelope.spec?.modelProposal?.status === "proposal-only", "proposal status is not proposal-only");
      assert(
        successEnvelope.spec?.modelProposal?.disclaimer === MODEL_PROPOSAL_DISCLAIMER,
        "proposal disclaimer literal changed",
      );
      assert(
        successEnvelope.semanticSpecSha256 !== baseSemantic,
        "a visible proposal did not change the semantic identity",
      );
      assertTokensUnavailable(successEnvelope);

      const records = findArtifactRecordFiles(REPO_ROOT);
      assert(records.length === 1, `artifact record exists outside the store: ${records.join(", ")}`);
      const expectedRecord = join(MODEL_ARTIFACT_STORE_ROOT, `${successEnvelope.artifactId}.json`);
      assert(records[0] === expectedRecord, "artifact record is not at its store path");
      const stored = JSON.parse(readFileSync(expectedRecord, "utf-8"));
      assert(
        stored.semanticSpecSha256 === successEnvelope.semanticSpecSha256,
        "stored record semantic hash does not match the served envelope",
      );

      await sleep(20);
      const rerun = requireEnvelope(await postJson(modelServer.baseUrl, modelNonce, INTENT_BRIEF));
      assert(rerun.semanticSpecSha256 === successEnvelope.semanticSpecSha256, "semantic identity changed on rerun");
      assert(rerun.artifactId === successEnvelope.artifactId, "artifactId changed on rerun");
      assert(storeRecordNames().length === 1, "rerun wrote a duplicate record (first-write-wins violated)");
    });
    assert(storeRecordNames().length === 1, "success run did not leave exactly one record");
    console.log("dogfood-createuispec: PASS successful-proposal");

    console.log(
      intentPending
        ? "dogfood-createuispec: PASS (S2 pending; rerun without --allow-pending-intent after S2)"
        : "dogfood-createuispec: PASS",
    );
  } finally {
    await server.stop();
    if (fakeProvider !== null) await fakeProvider.stop();
    resetStore();
  }
}

run().catch((error) => {
  console.error(`dogfood-createuispec: FAIL: ${error instanceof Error ? error.message : "unknown failure"}`);
  process.exitCode = 1;
});
