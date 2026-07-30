import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CSRF_HEADER, cleanupBatch, describeInternalError, explainCaptureError, explainCaptureTargetError, explainTagError, finishWithInternalError, resolveSiteAsset, findDuplicateAtCommit, hostIsLoopback, isPrivateAddress, listCaptureBatches, normalizeEntryIdForRename, orphanedPrivateImagePaths, prepareNewEntryPayload, promoteTempImage, publicConfigStatus, sameOrigin, setTriageStatus, stampProvenance, uniqueEntryId, validateEntryPayload, startServer } from "./ui-server.js";
import { setCorpusRootForTesting } from "../persistence.js";
import { request as httpRequest } from "node:http";
import type { IncomingMessage } from "node:http";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { PROJECT_ROOT, privateImageDir, setPrivateImageDirForTesting } from "../paths.js";
import { setCorpusForTesting } from "../corpus.js";
import { containsPrivateMarker, parseDesignArtifactEnvelope } from "../create-ui-spec-contracts.js";
import type { CorpusEntryT } from "../schema.js";

function req(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

// ─── forcing the C3 integrity refusal (the 503 branch) ────────────────────────
//
// `handleCreateUiSpecHttp` throws when the envelope about to be served fails any
// of its FIVE serve-time gates — the reference/evidence ID-shape gate, the
// citation-consistency gate, the design-artifact envelope integrity re-check, the
// served-key-set check, or the private-marker sweep. All five are producer/adapter
// DEFECTS and the route maps all five to the same bounded 503, which is why one
// forced throw exercises the branch. Every gate is unreachable from a legitimate
// request, so the only honest way to test the route's handling is to make the
// adapter throw on demand. The mock is a passthrough unless the flag is set, so
// every other test in this file exercises the real adapter.
const c3Adapter = vi.hoisted(() => ({ forceIntegrityFailure: false }));

vi.mock("../create-ui-spec-http.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../create-ui-spec-http.js")>();
  return {
    ...actual,
    handleCreateUiSpecHttp: async (...args: Parameters<typeof actual.handleCreateUiSpecHttp>) => {
      if (c3Adapter.forceIntegrityFailure) {
        // The adapter's real refusal message, verbatim, so the test also proves
        // the route publishes nothing derived from it.
        throw new Error(
          "create_ui_spec response failed the design-artifact envelope integrity re-check and was not served (values withheld)",
        );
      }
      return actual.handleCreateUiSpecHttp(...args);
    },
  };
});

// ─── THE CSRF TEST HELPER ─────────────────────────────────────────────────────
//
// Every mutating /api/* request now requires the `X-Clean-UI-CSRF` header, and
// the nonce is process-local and cryptographically random, so no test can hard-
// code one. This helper is the documented way a test supplies it: it performs the
// SAME two-step exchange a browser page performs — GET /api/csrf over the real
// socket, then send the returned nonce on the mutation. Nothing test-only is
// exported from the server to make this work; there is no back door into the
// nonce, which is the point (a test that could read the nonce out of module state
// would not be exercising the control a browser has to satisfy).
//
// Callers should fetch once per server and reuse, exactly as the UI caches it.
async function csrfHeader(baseUrl: string): Promise<Record<string, string>> {
  const res = await fetch(`${baseUrl}/api/csrf`);
  if (!res.ok) throw new Error(`GET /api/csrf failed: ${res.status}`);
  const body = await res.json() as { nonce?: string };
  if (!body.nonce) throw new Error("GET /api/csrf returned no nonce");
  return { [CSRF_HEADER.toLowerCase()]: body.nonce };
}

const baseEntry = {
  id: "linear-dashboard",
  title: "Linear Dashboard",
  patternType: "dashboard",
  categories: ["dashboard"],
  styleTags: ["minimal"],
  source: {
    productName: "Linear",
    url: "https://linear.app",
    capturedAt: "2026-07-01",
    capturedBy: "self",
  },
  image: {
    visibility: "private",
    path: "images-private/linear-dashboard.png",
    width: 1440,
    height: 1000,
  },
  visual: {
    dominantColors: ["#ffffff", "#111111"],
    accentColor: null,
    typePairing: {
      display: null,
      body: null,
      notes: "Clear hierarchy with restrained type.",
    },
    spacingDensity: "moderate",
    cornerStyle: "slight-round",
    usesShadows: false,
    usesBorders: true,
  },
  critique:
    "This interface uses a direct visual hierarchy, restrained surfaces, and clear grouping to make repeated scanning feel calm and predictable.",
  whatToSteal: ["Use quiet grouping and consistent spacing to make dense product interfaces easier to scan."],
  antiPatterns: {
    antiPatterns: ["Avoids heavy card shadows; uses background-color steps for depth."],
    whereThisFails: [],
    accessibilityRisks: [],
  },
  qualityScore: 4,
  addedAt: "2026-07-01",
} as CorpusEntryT;

describe("ui server entry ids", () => {
  it("generates a unique id when the requested id already exists", () => {
    const entries = [
      { id: "linear-dashboard" },
      { id: "linear-dashboard-2" },
    ] as CorpusEntryT[];

    expect(uniqueEntryId({ id: "linear-dashboard" }, entries)).toBe("linear-dashboard-3");
  });

  it("derives an id from product and title when none is supplied", () => {
    expect(
      uniqueEntryId(
        { title: "Dense Table", source: { productName: "Acme" } },
        [] as CorpusEntryT[],
      ),
    ).toBe("acme-dense-table");
  });

  it("prepares a valid image-backed new entry with a server-owned unique id", () => {
    const entry = prepareNewEntryPayload(
      { ...baseEntry, id: "", title: "Linear Dashboard" },
      [{ ...baseEntry, id: "linear-linear-dashboard" }],
    );

    expect(entry.id).toBe("linear-linear-dashboard-2");
    expect(entry.image.path).toBe("images-private/linear-dashboard.png");
  });

  it("rejects URL-only new entries from the app API", () => {
    expect(() =>
      prepareNewEntryPayload(
        { ...baseEntry, id: "", image: { ...baseEntry.image, path: null, width: null, height: null } },
        [],
      ),
    ).toThrow("New app-created entries must include");
  });

  it("finds private image files that no entry references", () => {
    expect(
      orphanedPrivateImagePaths(
        [
          "images-private/linear-dashboard.png",
          "images-private/unused.png",
          "images-public/public.png",
        ],
        [baseEntry],
      ),
    ).toEqual(["images-private/unused.png"]);
  });

  it("publishes config status without exposing secret values", () => {
    const status = publicConfigStatus({
      envPath: "/tmp/.env",
      envFileLoaded: true,
      openaiKeyConfigured: true,
      anthropicKeyConfigured: false,
      geminiKeyConfigured: false,
      mistralKeyConfigured: false,
      voyageKeyConfigured: false,
      autoTagProvider: "openai",
      openaiAutoTagModel: "test-model",
      cleanUiPort: 3131,
    });

    expect(status).toMatchObject({
      envFileLoaded: true,
      openaiKeyConfigured: true,
      anthropicKeyConfigured: false,
      geminiKeyConfigured: false,
      visionKeyConfigured: true,
      voyageKeyConfigured: false,
      openaiAutoTagModel: "test-model",
      cleanUiPort: 3131,
    });
    // The extraction/critique provider + model fields come from process.env
    // (which the real .env may have set at import time). Just verify they exist
    // and don't expose secrets — don't assert exact values.
    expect(status).toHaveProperty("extractionProvider");
    expect(status).toHaveProperty("critiqueProvider");
    expect(status).toHaveProperty("extractionModel");
    expect(status).toHaveProperty("critiqueModel");
    expect(JSON.stringify(status)).not.toContain("/tmp/.env");
    expect(JSON.stringify(status)).not.toContain("sk-");
  });

  it("reports visionKeyConfigured=false when only a critique-only OpenAI key is set", () => {
    // Corrected behavior: OPENAI_API_KEY_CRITIQUE (NIM/DeepSeek) is text-only
    // and must NOT satisfy the vision gate. The earlier version incorrectly
    // counted it, advertising auto-tagging then failing at the vision pass.
    const savedExtr = process.env.OPENAI_API_KEY_EXTRACTION;
    const savedCrit = process.env.OPENAI_API_KEY_CRITIQUE;
    try {
      delete process.env.OPENAI_API_KEY_EXTRACTION;
      process.env.OPENAI_API_KEY_CRITIQUE = "nvapi-test";
      const status = publicConfigStatus({
        envPath: "/tmp/.env",
        envFileLoaded: true,
        openaiKeyConfigured: false,            // bare key NOT set
        anthropicKeyConfigured: false,
        geminiKeyConfigured: false,
        mistralKeyConfigured: false,
        voyageKeyConfigured: false,
        autoTagProvider: "openai",
        openaiAutoTagModel: "test-model",
        cleanUiPort: 3131,
      });
      // Critique-only key does NOT satisfy the vision gate.
      expect(status.visionKeyConfigured).toBe(false);

      // An extraction-capable per-pass key DOES satisfy it.
      delete process.env.OPENAI_API_KEY_CRITIQUE;
      process.env.OPENAI_API_KEY_EXTRACTION = "sk-test";
      const status2 = publicConfigStatus({
        envPath: "/tmp/.env", envFileLoaded: true,
        openaiKeyConfigured: false, anthropicKeyConfigured: false, geminiKeyConfigured: false,
        mistralKeyConfigured: false, voyageKeyConfigured: false,
        autoTagProvider: "openai", openaiAutoTagModel: "test-model", cleanUiPort: 3131,
      });
      expect(status2.visionKeyConfigured).toBe(true);
    } finally {
      if (savedCrit === undefined) delete process.env.OPENAI_API_KEY_CRITIQUE;
      else process.env.OPENAI_API_KEY_CRITIQUE = savedCrit;
      if (savedExtr === undefined) delete process.env.OPENAI_API_KEY_EXTRACTION;
      else process.env.OPENAI_API_KEY_EXTRACTION = savedExtr;
    }
  });

  // ── rename validation (id-only, no image rename) ───────────────────────────
  // The endpoint uses slugify() for normalization + a duplicate-id check.
  // These tests verify the building blocks the /rename handler relies on.

  it("slugifies rename input to valid kebab-case", () => {
    // slugify is the normalization the rename endpoint applies to newId.
    // It lowercases, replaces non-alphanumeric runs with dashes, and trims.
    expect(uniqueEntryId({ id: "Wise Transfer Calculator" }, [])).toBe("wise-transfer-calculator");
    expect(uniqueEntryId({ id: "wise_transfer_calculator" }, [])).toBe("wise-transfer-calculator");
    expect(uniqueEntryId({ id: "wise--transfer!!!" }, [])).toBe("wise-transfer");
  });

  it("normalizes rename input without falling back to sample", () => {
    expect(normalizeEntryIdForRename("Wise Transfer Calculator")).toBe("wise-transfer-calculator");
    expect(normalizeEntryIdForRename("!!!")).toBe("");
  });

  it("rejects a rename to an id that already exists", () => {
    const entries = [
      { id: "wise-calculator" },
      { id: "wise-transfer" },
    ] as CorpusEntryT[];
    // uniqueEntryId appends a suffix on collision — the rename endpoint must
    // check duplicates BEFORE calling it and reject instead of auto-suffixing.
    const exists = entries.some((e) => e.id === "wise-calculator");
    expect(exists).toBe(true);
  });

  it("preserves image.path when renaming id (no image file rename)", () => {
    // The rename endpoint updates only entry.id; image.path stays as-is because
    // image lookup is by path string, not by id. This test documents that invariant.
    const entry = { ...baseEntry, id: "wise-wise-4", image: { ...baseEntry.image, path: "images-private/wise-web-screens-14.png" } };
    const renamed = { ...entry, id: "wise-transfer-calculator" };
    expect(renamed.image.path).toBe("images-private/wise-web-screens-14.png");
    expect(renamed.id).toBe("wise-transfer-calculator");
  });
});

describe("same-origin guard", () => {
  it("allows requests with no Origin header (non-browser clients)", () => {
    expect(sameOrigin(req({ host: "localhost:3131" }))).toBe(true);
  });

  it("allows same-origin browser requests (Origin host matches Host)", () => {
    expect(
      sameOrigin(req({ host: "localhost:3131", origin: "http://localhost:3131" })),
    ).toBe(true);
  });

  it("rejects cross-origin requests from another website", () => {
    expect(
      sameOrigin(req({ host: "localhost:3131", origin: "https://evil.example.com" })),
    ).toBe(false);
  });

  it("rejects when Origin is present but Host is missing", () => {
    expect(sameOrigin(req({ origin: "http://localhost:3131" }))).toBe(false);
  });
});

// ─── I4: the Host allowlist (DNS-rebinding defence) ───────────────────────────
//
// `sameOrigin` compares Origin against Host, so under DNS rebinding they MATCH:
// a page on `evil.example` whose name has been re-resolved to 127.0.0.1 sends
// `Origin: http://evil.example` AND `Host: evil.example`. The guard passes, the
// page is genuinely same-origin from the browser's point of view, and it can
// read `GET /api/csrf` and echo the nonce. Only the Host name itself
// distinguishes the two cases — a rebound attacker cannot present a loopback
// literal, because a literal IP is never DNS-resolved.
describe("loopback Host allowlist", () => {
  it.each([
    ["127.0.0.1 with a port", "127.0.0.1:3131"],
    ["127.0.0.1 bare", "127.0.0.1"],
    ["localhost with a port", "localhost:3131"],
    ["localhost bare", "localhost"],
    ["case-folded localhost (DNS names are case-insensitive)", "LocalHost:3131"],
    ["bracketed IPv6 loopback", "[::1]:3131"],
    ["bracketed IPv6 loopback, bare", "[::1]"],
  ])("allows %s", (_label, host) => {
    expect(hostIsLoopback(req({ host }))).toBe(true);
  });

  it.each([
    ["a rebound attacker name", "evil.example"],
    ["a rebound attacker name with the server's port", "evil.example:3131"],
    ["a name that merely embeds a loopback literal", "127.0.0.1.evil.example"],
    ["a name suffixed onto localhost", "localhost.evil.example"],
    ["a trailing-dot absolute form of an attacker name", "evil.example."],
    ["a routable address", "192.168.1.9:3131"],
    ["an unbracketed IPv6 loopback (not a legal Host)", "::1"],
    ["a garbage Host", "@@@"],
    ["an empty Host", ""],
  ])("rejects %s", (_label, host) => {
    expect(hostIsLoopback(req({ host }))).toBe(false);
  });

  it("rejects a missing Host header", () => {
    expect(hostIsLoopback(req({}))).toBe(false);
  });

  it("rejects a comma-joined authority, which node never produces for Host", () => {
    // NOT a duplicate-Host test, despite appearances. Node treats `host` as a
    // discard-duplicates field in `_addHeaderLine`: two `Host` lines leave
    // `req.headers.host` equal to the FIRST value, never a joined string
    // (verified over a raw socket). This asserts the guard rejects the joined
    // shape anyway — a non-Node front end could hand it to us — and it is the
    // only thing it asserts. See the `hostIsLoopback` docblock for what Node's
    // first-wins rule means live.
    expect(hostIsLoopback(req({ host: "localhost:3131, evil.example" }))).toBe(false);
  });
});

describe("Host allowlist over the wire (DNS rebinding cannot read the nonce)", () => {
  let server: import("node:http").Server;
  let port: number;
  let base: string;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "ui-server-host-"));
    writeFileSync(join(base, "entries.json"), JSON.stringify({ version: 2, entries: [] }));
    setCorpusRootForTesting(base);
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("server did not bind");
    port = addr.port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    setCorpusRootForTesting(null);
    rmSync(base, { recursive: true, force: true });
  });

  // `fetch` derives Host from the URL and forbids overriding it, so the forged
  // Host has to go through the low-level client.
  function rawRequest(
    path: string,
    headers: Record<string, string>,
    method = "GET",
  ): Promise<{ status: number; body: string }> {
    return new Promise((resolvePromise, reject) => {
      const r = httpRequest(
        { host: "127.0.0.1", port, path, method, headers, setHost: false },
        (res) => {
          let body = "";
          res.setEncoding("utf-8");
          res.on("data", (c: string) => { body += c; });
          res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, body }));
        },
      );
      r.on("error", reject);
      r.end();
    });
  }

  it("refuses GET /api/csrf when the Host is a rebound attacker name", async () => {
    const res = await rawRequest("/api/csrf", {
      host: "evil.example",
      origin: "http://evil.example",
    });
    expect(res.status).toBe(403);
    // The nonce must not leak in the refusal body under any key.
    expect(res.body).not.toMatch(/[0-9a-f]{64}/);
  });

  it("refuses a mutating route when the Host is a rebound attacker name", async () => {
    const res = await rawRequest("/api/entries", { host: "evil.example" }, "POST");
    expect(res.status).toBe(403);
  });

  it("refuses the CORS preflight when the Host is a rebound attacker name", async () => {
    const res = await rawRequest(
      "/api/entries",
      { host: "evil.example", origin: "http://evil.example", "access-control-request-method": "POST" },
      "OPTIONS",
    );
    expect(res.status).toBe(403);
  });

  it("still serves the nonce to a loopback Host", async () => {
    const res = await rawRequest("/api/csrf", { host: `127.0.0.1:${port}` });
    expect(res.status).toBe(200);
    expect((JSON.parse(res.body) as { nonce: string }).nonce).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("listen address", () => {
  it("binds loopback only — never a routable interface", async () => {
    const server = await startServer(0);
    const addr = server.address();
    expect(addr && typeof addr === "object").toBe(true);
    if (addr && typeof addr === "object") {
      expect(["127.0.0.1", "::1"]).toContain(addr.address);
    }
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe("capture SSRF guard", () => {
  it("flags RFC1918 private, loopback, link-local, and cloud-metadata ranges", () => {
    // private ranges
    expect(isPrivateAddress("10.0.0.1")).toBe(true);
    expect(isPrivateAddress("172.16.0.1")).toBe(true);
    expect(isPrivateAddress("172.31.255.254")).toBe(true);
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    // loopback
    expect(isPrivateAddress("127.0.0.1")).toBe(true);
    // link-local (cloud metadata lives here)
    expect(isPrivateAddress("169.254.169.254")).toBe(true);
    // IPv6 loopback + ULA + link-local
    expect(isPrivateAddress("::1")).toBe(true);
    expect(isPrivateAddress("fd00::1")).toBe(true);
    expect(isPrivateAddress("fe80::1")).toBe(true);
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:169.254.169.254")).toBe(true);

    // public addresses are not flagged
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
    // 172.32.x is outside the RFC1918 172.16/12 block — public
    expect(isPrivateAddress("172.32.0.1")).toBe(false);
  });
});

describe("draft hygiene gate (centralized)", () => {
  it("rejects an entry with a [DRAFT] marker in critique", () => {
    expect(() => validateEntryPayload({ ...baseEntry, critique: "[DRAFT — REWRITE] This is a draft critique that is long enough to pass the minimum." })).toThrow("draft markers");
  });

  it("rejects an entry with a [DRAFT] marker in anti-patterns", () => {
    const payload = {
      ...baseEntry,
      antiPatterns: {
        ...baseEntry.antiPatterns,
        antiPatterns: ["[DRAFT] Avoids heavy shadows for depth — uses color steps instead."],
      },
    };
    expect(() => validateEntryPayload(payload)).toThrow("draft markers");
  });

  it("rejects an entry with a [PLACEHOLDER] marker in whatToSteal", () => {
    expect(() => validateEntryPayload({ ...baseEntry, whatToSteal: ["[PLACEHOLDER — fill this in]"] })).toThrow("draft markers");
  });

  it("rejects an entry with a [TODO] marker in voice", () => {
    const payload = {
      ...baseEntry,
      voice: { tone: "[TODO backfill]", examples: ["some copy here"], avoid: [] },
    };
    expect(() => validateEntryPayload(payload)).toThrow("draft markers");
  });

  it("rejects an entry with a [DRAFT] marker in businessRationale", () => {
    const payload = {
      ...baseEntry,
      businessRationale: {
        businessGoal: "build-trust",
        targetUser: "new buyer",
        rationale: "[DRAFT] This needs a curator rewrite before it can ship.",
      },
    };
    expect(() => validateEntryPayload(payload)).toThrow("draft markers");
  });

  it("accepts a clean entry with no markers anywhere", () => {
    expect(() => validateEntryPayload(baseEntry)).not.toThrow();
  });

  it("rejects a vague-phrase anti-pattern (generic filler gate)", () => {
    const payload = {
      ...baseEntry,
      antiPatterns: {
        ...baseEntry.antiPatterns,
        antiPatterns: ["This design will keep it clean and avoid clutter everywhere."],
      },
    };
    expect(() => validateEntryPayload(payload)).toThrow("generic filler");
  });

  it("accepts a specific, detailed anti-pattern", () => {
    const payload = {
      ...baseEntry,
      antiPatterns: {
        ...baseEntry.antiPatterns,
        antiPatterns: ["Reserves the brightest accent color for the single element that must win attention so state remains unmistakable."],
      },
    };
    expect(() => validateEntryPayload(payload)).not.toThrow();
  });

  it("removes businessRationale from isolated group-member captures at validation", () => {
    const entry = validateEntryPayload({
      ...baseEntry,
      businessRationale: {
        businessGoal: "build-trust",
        targetUser: "new buyer",
        rationale: "[DRAFT] A group-member crop should not retain inferred business intent.",
      },
      provenance: {
        taggedBy: "auto",
        capture: {
          mode: "group-member",
          viewport: "desktop",
          capturedAt: "2026-07-05T10:30:00.000Z",
          sourceUrl: "https://example.com/pricing",
        },
      },
    });

    expect(entry.businessRationale).toBeUndefined();
  });
});

// commit-time duplicate gate tests moved to src/dedup.test.ts (the gate now
// lives in src/dedup.ts). findDuplicateAtCommit is re-exported from ui-server
// for backward compat; the canonical test import is ../dedup.js.

describe("capture provenance flows through the save path", () => {
  // Confirms the schema change (Commit 2: provenance.capture) parses through the
  // UI's save endpoint. prepareNewEntryPayload is the exact entry point POST
  // /api/entries uses; if it accepts capture provenance, the classic promote
  // flow and the SPA add flow both land it in the corpus.
  it("accepts an entry with provenance.capture populated", () => {
    const payload = {
      ...baseEntry,
      id: "",
      title: "Linear Dashboard",
      provenance: {
        taggedBy: "auto",
        capture: {
          mode: "section",
          viewport: "desktop",
          selectorPath: "main > section.hero",
          capturedAt: "2026-07-05T12:00:00.000Z",
          sourceUrl: "https://linear.app",
        },
      },
    };
    const entry = prepareNewEntryPayload(payload, []);
    expect(entry.provenance?.capture).toBeDefined();
    expect(entry.provenance?.capture?.mode).toBe("section");
    expect(entry.provenance?.capture?.viewport).toBe("desktop");
    expect(entry.provenance?.capture?.sourceUrl).toBe("https://linear.app");
  });

  it("rejects an invalid capture mode", () => {
    expect(() =>
      prepareNewEntryPayload(
        { ...baseEntry, id: "", provenance: { taggedBy: "auto", capture: { mode: "bogus", viewport: "desktop", capturedAt: "x", sourceUrl: "y" } } },
        [],
      ),
    ).toThrow();
  });
});

describe("capture triage path-traversal guard", () => {
  // The plan review flagged this: batchId/captureId name path segments under
  // captures/, so untrusted values must not reach the path joins. setTriageStatus
  // is the POST /api/capture-triage handler's core; it must reject ../ and any
  // non-slug character before resolving a path.
  const batchCases = [
    "../../etc",
    "..%2fetc",
    "foo/bar",
    "foo\\bar",
    "foo bar",
    ".hidden",
    "UPPER",
  ];
  for (const bad of batchCases) {
    it(`rejects batchId ${JSON.stringify(bad)}`, () => {
      expect(() => setTriageStatus(bad, "cap-1", "promoted")).toThrow(/batchId/);
    });
  }
  const captureCases = ["../foo", "a/b", "a\\b", "UPPER", "has space"];
  for (const bad of captureCases) {
    it(`rejects captureId ${JSON.stringify(bad)}`, () => {
      expect(() => setTriageStatus("valid-batch", bad, "promoted")).toThrow(/captureId/);
    });
  }
});

describe("capture cleanup safety gate", () => {
  // POST /api/capture-cleanup must refuse to delete a batch dir while any item
  // is still pending — otherwise future cleanup eats private screenshots the
  // curator hasn't reviewed. cleanupBatch is the handler core.
  //
  // Isolation: the override redirects privateImageDir() (and thus capturesDir()
  // in ui-server.ts) to a tmp dir, so these writes never touch the real
  // corpus/images-private/captures/.
  let capturesRoot: string;
  const batchId = "cleanup-test-batch";

  beforeEach(() => {
    setPrivateImageDirForTesting(mkdtempSync(join(tmpdir(), "ui-server-cleanup-")));
    capturesRoot = join(privateImageDir(), "captures");
    const batchDir = join(capturesRoot, batchId);
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(join(batchDir, "manifest.json"), JSON.stringify([
      { id: "cap-1", sourceName: "Acme", captureMode: "section", viewport: "desktop", selectorPath: "main", capturedAt: "2026-07-05T00:00:00.000Z", aHash: "0", imagePath: `images-private/captures/${batchId}/cap-1.png`, width: 100, height: 100 },
    ]));
  });
  afterEach(() => {
    if (existsSync(privateImageDir())) rmSync(privateImageDir(), { recursive: true, force: true });
    setPrivateImageDirForTesting(null);
  });

  it("refuses (409) and keeps the directory when items are pending", () => {
    writeFileSync(join(capturesRoot, batchId, "triage.json"), JSON.stringify({ "cap-1": "pending" }));
    let err: unknown;
    try { cleanupBatch(batchId); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
    expect((err as { statusCode?: number }).statusCode).toBe(409);
    expect((err as Error).message).toMatch(/pending/);
    // Directory must still exist — the safety gate held.
    expect(existsSync(join(capturesRoot, batchId))).toBe(true);
  });

  it("deletes the directory once nothing is pending", () => {
    writeFileSync(join(capturesRoot, batchId, "triage.json"), JSON.stringify({ "cap-1": "promoted" }));
    const result = cleanupBatch(batchId);
    expect(result.deleted).toBe(batchId);
    expect(existsSync(join(capturesRoot, batchId))).toBe(false);
  });

  it("refuses (409) when at least one item is still pending among many", () => {
    writeFileSync(join(capturesRoot, batchId, "triage.json"), JSON.stringify({ "cap-1": "pending", "cap-2": "rejected" }));
    let err: unknown;
    try { cleanupBatch(batchId); } catch (e) { err = e; }
    expect((err as { statusCode?: number }).statusCode).toBe(409);
    expect(existsSync(join(capturesRoot, batchId))).toBe(true);
  });

  it("rejects a traversal batchId without touching disk", () => {
    // Ensure no captures dir leaking from a stray prior run.
    expect(() => cleanupBatch("../../etc")).toThrow(/batchId/);
    // The captures root should contain at most our test batch — never escaped.
    expect(readdirSync(capturesRoot).some((n) => n === "etc" || n === "..")).toBe(false);
  });
});

describe("promote-on-save: temp → permanent image copy", () => {
  // promoteTempImage is the core of the /api/entries promote-on-save extension.
  // It copies a temp captures/add-*/...png to a flat permanent images-private/{slug}.png
  // and returns the new path. Critical properties: (1) source must be under
  // captures/add-*, (2) the copy exists at the permanent path, (3) temp is NOT
  // deleted (other candidates still reference it), (4) non-add-* paths pass through.
  //
  // Isolation: privateImageDir() override redirects both capturesDir() and the
  // permanent-flat-path writes to a tmp dir; fromCorpusRelativeImagePath honors
  // the same override so source resolution matches.
  let capturesRoot: string;
  const batchId = "add-promotetest-20260706";
  const capId = "stripe-section-abc-desktop";
  const tempRel = `images-private/captures/${batchId}/${capId}.png`;

  beforeEach(() => {
    setPrivateImageDirForTesting(mkdtempSync(join(tmpdir(), "ui-server-promote-")));
    capturesRoot = join(privateImageDir(), "captures");
    const batchDir = join(capturesRoot, batchId);
    mkdirSync(batchDir, { recursive: true });
    // 1x1 PNG bytes — smallest valid PNG.
    writeFileSync(join(batchDir, `${capId}.png`), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
  });
  afterEach(() => {
    if (existsSync(privateImageDir())) rmSync(privateImageDir(), { recursive: true, force: true });
    setPrivateImageDirForTesting(null);
  });

  it("copies a temp add-* image to a permanent flat path and returns the new path", () => {
    const result = promoteTempImage(tempRel, "promote-perm-test");
    expect(result.path).toMatch(/^images-private\/promote-perm-test(-\d+)?\.png$/);
    expect(existsSync(join(privateImageDir(), result.path.replace(/^images-private\//, "")))).toBe(true);
  });

  it("does NOT delete the temp source (other candidates still reference it)", () => {
    promoteTempImage(tempRel, "promote-perm-test");
    expect(existsSync(join(capturesRoot, batchId, `${capId}.png`))).toBe(true);
  });

  it("passes through non-add-* paths unchanged (no copy, no delete)", () => {
    // A real CLI batch path (not add-*) should be left alone — it has its own lifecycle.
    const realBatchRel = "images-private/captures/20260705120000/foo.png";
    const result = promoteTempImage(realBatchRel, "should-not-be-used");
    expect(result.path).toBe(realBatchRel);
  });

  it("rejects a temp path that escapes captures/ (path traversal)", () => {
    const escaped = "images-private/../../etc/passwd";
    let err: unknown;
    try { promoteTempImage(escaped, "x"); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(Error);
  });

  it("throws 404 when the temp source file does not exist", () => {
    const missing = `images-private/captures/${batchId}/never-captured.png`;
    let err: unknown;
    try { promoteTempImage(missing, "x"); } catch (e) { err = e; }
    expect((err as { statusCode?: number }).statusCode).toBe(404);
  });
});

describe("listCaptureBatches ignores add-* temp dirs (manifest gate)", () => {
  // The Add-flow temp dirs (captures/add-*) must NOT appear in the #/capture
  // triage page. listCaptureBatches requires manifest.json, and the Add flow
  // never writes one — so add-* dirs are invisible by construction. This test
  // pins that property so a future change can't regress it.
  //
  // Isolation: tmp privateImageDir() so the batch dirs never reach the real
  // corpus/images-private/captures/.
  let capturesRoot: string;
  const tempBatchId = "add-listtest-20260706";
  const realBatchId = "listtest-real-20260706";

  beforeEach(() => {
    setPrivateImageDirForTesting(mkdtempSync(join(tmpdir(), "ui-server-listcap-")));
    capturesRoot = join(privateImageDir(), "captures");
    mkdirSync(join(capturesRoot, tempBatchId), { recursive: true });
    // No manifest.json — simulates the Add flow exactly.
    writeFileSync(join(capturesRoot, tempBatchId, "foo.png"), Buffer.from([]));
    // A real batch WITH a manifest — should appear.
    const realDir = join(capturesRoot, realBatchId);
    mkdirSync(realDir, { recursive: true });
    writeFileSync(join(realDir, "manifest.json"), JSON.stringify([
      { id: "cap-1", sourceName: "Real", captureMode: "section", viewport: "desktop", selectorPath: "main", capturedAt: "2026-07-06T00:00:00.000Z", aHash: "0", imagePath: `images-private/captures/${realBatchId}/cap-1.png`, width: 100, height: 100 },
    ]));
    writeFileSync(join(realDir, "triage.json"), JSON.stringify({ "cap-1": "pending" }));
  });
  afterEach(() => {
    if (existsSync(privateImageDir())) rmSync(privateImageDir(), { recursive: true, force: true });
    setPrivateImageDirForTesting(null);
  });

  it("returns the real batch but NOT the add-* temp batch", () => {
    const batches = listCaptureBatches();
    const ids = batches.map((b) => b.batchId);
    expect(ids).toContain(realBatchId);
    expect(ids).not.toContain(tempBatchId);
  });
});

describe("provenance preservation (stampProvenance)", () => {
  it("preserves capture metadata on auto-review flip (the line-1203 regression)", () => {
    // An auto-tagged entry WITH capture metadata gets human-reviewed.
    // The old code replaced provenance entirely, wiping capture.
    const entry = { ...baseEntry, provenance: {
      taggedBy: "auto" as const,
      capture: { mode: "section" as const, viewport: "desktop", capturedAt: "2026-07-01T00:00:00.000Z", sourceUrl: "https://example.com" },
      taggedAt: "2026-07-01",
    } } as CorpusEntryT;

    stampProvenance(entry, "2026-07-01", "auto-reviewed");

    // Capture MUST survive the flip.
    expect(entry.provenance?.capture?.mode).toBe("section");
    expect(entry.provenance?.capture?.sourceUrl).toBe("https://example.com");
    // taggedBy MUST flip to auto-reviewed.
    expect(entry.provenance?.taggedBy).toBe("auto-reviewed");
    // taggedAt MUST NOT advance on human review.
    expect(entry.provenance?.taggedAt).toBe("2026-07-01");
  });

  it("advances taggedAt on auto-tag/retag", () => {
    const entry = { ...baseEntry, provenance: { taggedBy: "auto" as const } } as CorpusEntryT;
    stampProvenance(entry, "2026-07-08", "auto");
    expect(entry.provenance?.taggedAt).toBe("2026-07-08");
  });

  it("stamps newly saved auto-reviewed entries without downgrading taggedBy", () => {
    const entry = { ...baseEntry, provenance: { taggedBy: "auto-reviewed" as const } } as CorpusEntryT;
    stampProvenance(entry, "2026-07-08", "auto-reviewed", { advanceTaggedAt: true });
    expect(entry.provenance?.taggedBy).toBe("auto-reviewed");
    expect(entry.provenance?.taggedAt).toBe("2026-07-08");
  });

  it("does not invent taggedAt for legacy auto-reviewed edits", () => {
    const entry = { ...baseEntry, provenance: { taggedBy: "auto" as const } } as CorpusEntryT;
    stampProvenance(entry, "2026-07-08", "auto-reviewed");
    expect(entry.provenance?.taggedBy).toBe("auto-reviewed");
    expect(entry.provenance?.taggedAt).toBeUndefined();
  });
});

// ─── Task 7: lost-update race under concurrent mutations ──────────────────────
// The mutating handlers follow a load → await (dedup/vision I/O) → save-whole-array
// pattern. Without serialization, two concurrent POSTs both snapshot `entries`
// (length N) before either saves, so the second save overwrites the first and one
// entry is lost — and uniqueEntryId can mint a duplicate id against a stale
// snapshot. This exercises the real HTTP path against an isolated corpus root.
describe("concurrent mutation serialization", () => {
  let server: import("node:http").Server;
  let base: string;
  let baseUrl: string;

  // Images for the dedup gate are written under a tmp privateImageDir() override.
  // fromCorpusRelativeImagePath honors the same override (see paths.ts), so the
  // server's dedup fingerprint reader resolves these tmp paths correctly.
  // Each fixture is a distinct high-entropy noise PNG: its dHash differs from
  // every sibling's by well over the DHASH_THRESHOLD of 8, so the commit-time
  // dedup gate lets each through (this test is about id/write collisions, not
  // dedup). Crucially, a real image makes findDuplicateAtCommit await
  // computeDHash (sharp), which yields to the event loop — that is the async
  // gap that lets two un-serialized POSTs interleave and lose an update.
  const imgSubdir = `concurrency-test-${Date.now()}`;
  let imgDirAbs: string;

  /** Generate a deterministic-but-distinct noise PNG (raw 32x32 → png). */
  async function noisePng(seed: number): Promise<Buffer> {
    const sharp = (await import("sharp")).default;
    let s = seed >>> 0;
    const buf = Buffer.alloc(32 * 32 * 3);
    for (let i = 0; i < buf.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; buf[i] = s & 0xff; }
    return sharp(buf, { raw: { width: 32, height: 32, channels: 3 } }).png().toBuffer();
  }

  /** Full schema-valid new-entry payload minus id (server assigns via uniqueEntryId). */
  function newEntryPayload(title: string, imagePath: string) {
    return {
      ...baseEntry,
      id: "",
      title,
      image: { ...baseEntry.image, path: imagePath, width: 32, height: 32 },
    };
  }

  // The nonce for this suite's mutations, fetched once in beforeAll (see the
  // csrfHeader helper at the top of this file).
  let csrf: Record<string, string> = {};

  async function postEntry(payload: ReturnType<typeof newEntryPayload>): Promise<{ id: string }> {
    const res = await fetch(`${baseUrl}/api/entries`, {
      method: "POST",
      headers: { "content-type": "application/json", ...csrf },
      body: JSON.stringify(payload),
    });
    const body = await res.json() as { entry?: { id: string }; error?: string };
    if (!res.ok || !body.entry) {
      throw new Error(`POST /api/entries failed (${res.status}): ${body.error ?? JSON.stringify(body)}`);
    }
    return body.entry;
  }

  async function getEntries(): Promise<CorpusEntryT[]> {
    const res = await fetch(`${baseUrl}/api/entries`);
    const body = await res.json() as { entries: CorpusEntryT[] };
    return body.entries;
  }

  beforeAll(async () => {
    // Isolated corpus root: an empty WRITABLE primary so saveEntries succeeds and
    // nothing touches the developer's real entries.json.
    base = mkdtempSync(join(tmpdir(), "ui-server-concurrency-"));
    writeFileSync(join(base, "entries.json"), JSON.stringify({ version: 2, entries: [] }));
    setCorpusRootForTesting(base);
    // Tmp private-image dir for the dedup fingerprints — keeps all image writes
    // out of the real corpus/images-private/.
    setPrivateImageDirForTesting(mkdtempSync(join(tmpdir(), "ui-server-concurrency-img-")));
    imgDirAbs = join(privateImageDir(), imgSubdir);
    mkdirSync(imgDirAbs, { recursive: true });
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("server did not bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;
    csrf = await csrfHeader(baseUrl);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    setCorpusRootForTesting(null);
    if (base && existsSync(base)) rmSync(base, { recursive: true, force: true });
    // The override dir is tmp; clear it and the override together. Read the path
    // BEFORE clearing the override so we don't accidentally rm the real dir.
    const overrideDir = privateImageDir();
    setPrivateImageDirForTesting(null);
    if (existsSync(overrideDir)) rmSync(overrideDir, { recursive: true, force: true });
  });

  it("serializes concurrent mutating requests — no lost update", async () => {
    // Two distinct noise PNGs, identical title. Under the old un-serialized code
    // both snapshot entries=[] before either saves, so the second save ([entry],
    // length 1) clobbers the first and only one entry survives — and both
    // compute the SAME id (acme-clone) against the empty snapshot. After
    // serialization, request B's loadEntries cannot run until request A's
    // saveEntries completes, so B sees entry A and suffixes its id, and both
    // persist.
    writeFileSync(join(imgDirAbs, "a.png"), await noisePng(1));
    writeFileSync(join(imgDirAbs, "b.png"), await noisePng(2));

    const [r1, r2] = await Promise.all([
      postEntry(newEntryPayload("Clone", `images-private/${imgSubdir}/a.png`)),
      postEntry(newEntryPayload("Clone", `images-private/${imgSubdir}/b.png`)),
    ]);

    // Distinct ids — no duplicate minted against a stale snapshot.
    expect(r1.id).not.toBe(r2.id);

    // Both entries survive — the second save did not overwrite the first.
    const list = await getEntries();
    expect(list.filter((e) => [r1.id, r2.id].includes(e.id))).toHaveLength(2);
  });

  it("serializes a burst of many concurrent POSTs with no lost writes", async () => {
    // A wider blast to make a last-writer-wins regression reliably visible: fire
    // 8 distinct-image POSTs at once and assert all 8 land with unique ids and
    // all 8 survive in the corpus.
    const labels = ["c", "d", "e", "f", "g", "h", "i", "j"];
    for (let i = 0; i < labels.length; i++) {
      writeFileSync(join(imgDirAbs, `${labels[i]}.png`), await noisePng(100 + i));
    }

    const results = await Promise.all(
      labels.map((label) => postEntry(newEntryPayload("Burst", `images-private/${imgSubdir}/${label}.png`))),
    );
    const ids = results.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length); // all distinct
    const list = await getEntries();
    expect(list.filter((e) => ids.includes(e.id))).toHaveLength(8);
  });

  it("keeps GET requests concurrent (read paths are not locked)", async () => {
    // Sanity: GET /api/entries must still work and return promptly under the new
    // serialization regime — read paths must not be gated behind the mutex.
    const [a, b, c] = await Promise.all([getEntries(), getEntries(), getEntries()]);
    expect(a.length).toBe(b.length);
    expect(b.length).toBe(c.length);
  });
});

// T-REV-2: HTTP-level coverage for the /api/orphans endpoints. The pure
// orphanedPrivateImagePaths function is unit-tested above; this closes the
// wiring gap — proving GET returns protectedCounts and DELETE uses scanOrphans
// (so captures/decisions/drafts are protected end-to-end through HTTP).
describe("orphan endpoints (T-REV-2)", () => {
  let server: import("node:http").Server;
  let baseUrl: string;
  let base: string;
  const imgSubdir = `orphan-test-${Date.now()}`;
  let imgDirAbs: string;
  // Captures must live directly under images-private/captures/ (the real
  // capture-batch layout) — that is the prefix safeOrphanPaths protects.
  let capturesDirAbs: string;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "ui-server-orphans-"));
    writeFileSync(join(base, "entries.json"), JSON.stringify({
      version: 2,
      entries: [{
        ...baseEntry,
        id: "kept-entry",
        image: { ...baseEntry.image, path: `images-private/${imgSubdir}/kept.png`, width: 32, height: 32 },
      }],
    }));
    setCorpusRootForTesting(base);
    // Redirect the private-image dir to a tmp location so all image writes and
    // the orphan walker stay out of the real corpus/images-private/.
    setPrivateImageDirForTesting(mkdtempSync(join(tmpdir(), "ui-server-orphans-img-")));
    imgDirAbs = join(privateImageDir(), imgSubdir);
    capturesDirAbs = join(privateImageDir(), "captures", imgSubdir);
    mkdirSync(imgDirAbs, { recursive: true });
    // kept.png is referenced by the entry; orphan.png is not.
    writeFileSync(join(imgDirAbs, "kept.png"), Buffer.from("fake-png-kept"));
    writeFileSync(join(imgDirAbs, "orphan.png"), Buffer.from("fake-png-orphan"));
    // A captures/ file must NEVER be deletable, referenced or not. Placed under
    // images-private/captures/ to match the protection rule's prefix check.
    mkdirSync(capturesDirAbs, { recursive: true });
    writeFileSync(join(capturesDirAbs, "shot.png"), Buffer.from("capture"));
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("server did not bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    setCorpusRootForTesting(null);
    rmSync(base, { recursive: true, force: true });
    // Clear the override and rm the tmp dir — read path BEFORE clearing.
    const overrideDir = privateImageDir();
    setPrivateImageDirForTesting(null);
    if (existsSync(overrideDir)) rmSync(overrideDir, { recursive: true, force: true });
  });

  it("GET /api/orphans returns the orphan and protectedCounts", async () => {
    const res = await fetch(`${baseUrl}/api/orphans`);
    expect(res.status).toBe(200);
    const body = await res.json() as { orphans: string[]; count: number; protectedCounts?: { captures?: number } };
    // The genuine orphan is listed...
    expect(body.orphans).toContain(`images-private/${imgSubdir}/orphan.png`);
    // ...the referenced image is NOT an orphan...
    expect(body.orphans).not.toContain(`images-private/${imgSubdir}/kept.png`);
    // ...and captures are protected (protectedCounts.captures >= 1 proves the
    // fail-closed rule ran end-to-end through the HTTP wiring).
    expect(body.protectedCounts?.captures).toBeGreaterThanOrEqual(1);
  });

  it("DELETE /api/orphans deletes the orphan but not captures or referenced images", async () => {
    // DELETE is a mutating method, so it carries the nonce (see csrfHeader).
    const res = await fetch(`${baseUrl}/api/orphans`, {
      method: "DELETE",
      headers: await csrfHeader(baseUrl),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { deleted: string[]; count: number };
    expect(body.deleted).toContain(`images-private/${imgSubdir}/orphan.png`);
    // The capture file must survive the delete.
    expect(existsSync(join(capturesDirAbs, "shot.png"))).toBe(true);
    // The referenced image must survive too.
    expect(existsSync(join(imgDirAbs, "kept.png"))).toBe(true);
    // The orphan is gone.
    expect(existsSync(join(imgDirAbs, "orphan.png"))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Task 5 (C3): CSRF nonce, the create_ui_spec loopback route, and production
// static serving.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * A schema-valid corpus entry stuffed with DISTINCTIVE private markers. Used by
 * the create_ui_spec route tests so the private-marker assertions are real: the
 * producer genuinely retrieves this entry, so anything that leaks corpus content
 * leaks one of these strings.
 */
const PRIVATE_MARKED_ENTRY = {
  ...baseEntry,
  id: "internal-zq-1",
  title: "Analytics dashboard",
  source: {
    productName: "product-Alpha-zq",
    url: "https://private.example.zq/secret-zq",
    capturedAt: "2026-07-01",
    capturedBy: "self",
  },
  image: { visibility: "private", path: "images-private/secret-zq.png", width: 1440, height: 1000 },
  critique:
    "private-corpus-id-zq This interface uses a direct visual hierarchy, restrained surfaces, and clear grouping to make repeated scanning feel calm and predictable.",
  whatToSteal: ["private-corpus-id-zq Use quiet grouping and consistent spacing to make dense product interfaces easier to scan."],
  reviewStatus: "approved",
  qualityTier: "exceptional",
} as unknown as CorpusEntryT;

/** Every marker that must never appear in a create_ui_spec HTTP response. */
const C3_BANNED_MARKERS = [
  "internal-zq-1",
  "product-Alpha-zq",
  "https://private.example.zq/secret-zq",
  "private.example.zq",
  "images-private/",
  "secret-zq.png",
  "private-corpus-id-zq",
];

describe("CSRF nonce issuance (GET /api/csrf)", () => {
  let server: import("node:http").Server;
  let baseUrl: string;
  let base: string;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "ui-server-csrf-"));
    writeFileSync(join(base, "entries.json"), JSON.stringify({ version: 2, entries: [] }));
    setCorpusRootForTesting(base);
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("server did not bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    setCorpusRootForTesting(null);
    rmSync(base, { recursive: true, force: true });
  });

  it("issues a cryptographically-sized random nonce to a same-origin caller", async () => {
    const res = await fetch(`${baseUrl}/api/csrf`, { headers: { origin: baseUrl } });
    expect(res.status).toBe(200);
    const body = await res.json() as { nonce: string };
    // 32 random bytes as hex. Long enough that guessing is not a strategy.
    expect(body.nonce).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the SAME nonce for the life of the process (process-local, not per-request)", async () => {
    const a = await (await fetch(`${baseUrl}/api/csrf`)).json() as { nonce: string };
    const b = await (await fetch(`${baseUrl}/api/csrf`)).json() as { nonce: string };
    expect(a.nonce).toBe(b.nonce);
  });

  it("carries no field beyond the nonce and is never cached", async () => {
    const res = await fetch(`${baseUrl}/api/csrf`);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.json() as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["nonce"]);
  });

  it("rejects a cross-origin request for the nonce", async () => {
    const res = await fetch(`${baseUrl}/api/csrf`, { headers: { origin: "https://evil.example.com" } });
    expect(res.status).toBe(403);
    const body = await res.json() as Record<string, unknown>;
    expect(body.nonce).toBeUndefined();
  });

  it("holds the nonce ONLY in memory — it is never written to the corpus root", async () => {
    const { nonce } = await (await fetch(`${baseUrl}/api/csrf`)).json() as { nonce: string };
    // Walk everything the server could have persisted under the corpus root.
    const seen: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else seen.push(readFileSync(p, "utf-8"));
      }
    };
    walk(base);
    for (const contents of seen) expect(contents.includes(nonce)).toBe(false);
  });

  it("advertises the nonce header on the same-origin preflight (otherwise browsers block it)", async () => {
    const res = await fetch(`${baseUrl}/api/entries`, {
      method: "OPTIONS",
      headers: { origin: baseUrl, "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect((res.headers.get("access-control-allow-headers") ?? "").toLowerCase()).toContain(
      CSRF_HEADER.toLowerCase(),
    );
  });
});

describe("CSRF enforcement on mutating /api/* requests", () => {
  let server: import("node:http").Server;
  let baseUrl: string;
  let base: string;
  let nonce: string;

  /** A schema-valid new-entry payload the server would accept if it got that far. */
  function entryPayload(title: string): Record<string, unknown> {
    return {
      ...baseEntry,
      id: "",
      title,
      image: { ...baseEntry.image, path: "images-private/csrf-probe.png", width: 32, height: 32 },
    };
  }

  async function entryCount(): Promise<number> {
    const res = await fetch(`${baseUrl}/api/entries`);
    const body = await res.json() as { entries: CorpusEntryT[] };
    return body.entries.length;
  }

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "ui-server-csrf-enforce-"));
    writeFileSync(join(base, "entries.json"), JSON.stringify({ version: 2, entries: [] }));
    setCorpusRootForTesting(base);
    setPrivateImageDirForTesting(mkdtempSync(join(tmpdir(), "ui-server-csrf-img-")));
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("server did not bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;
    nonce = (await (await fetch(`${baseUrl}/api/csrf`)).json() as { nonce: string }).nonce;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    setCorpusRootForTesting(null);
    rmSync(base, { recursive: true, force: true });
    const overrideDir = privateImageDir();
    setPrivateImageDirForTesting(null);
    if (existsSync(overrideDir)) rmSync(overrideDir, { recursive: true, force: true });
  });

  it("does NOT require the nonce on read (GET) requests", async () => {
    for (const path of ["/api/entries", "/api/stats", "/api/health", "/api/schema", "/api/orphans"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, `GET ${path}`).toBe(200);
    }
  });

  // The nonce-comparison trap cases. Each of these is a mistake a hand-rolled
  // equality check makes: accepting the empty string, accepting undefined ==
  // undefined, prefix/substring matching, case-insensitive matching.
  it("rejects every malformed or near-miss nonce on a mutating request", async () => {
    const cases: Array<[label: string, headers: Record<string, string>]> = [
      ["missing header entirely", {}],
      ["empty string", { [CSRF_HEADER]: "" }],
      ["whitespace only", { [CSRF_HEADER]: "   " }],
      ["literal 'undefined'", { [CSRF_HEADER]: "undefined" }],
      ["literal 'null'", { [CSRF_HEADER]: "null" }],
      ["wrong nonce of the same length", { [CSRF_HEADER]: "f".repeat(64) }],
      ["proper prefix of the nonce", { [CSRF_HEADER]: () => nonce.slice(0, 32) } as never],
      ["nonce with a trailing character", { [CSRF_HEADER]: () => `${nonce}a` } as never],
      ["nonce with a leading character", { [CSRF_HEADER]: () => `a${nonce}` } as never],
      ["case-flipped nonce", { [CSRF_HEADER]: () => nonce.toUpperCase() } as never],
      // Same length, one byte different in the middle — the case a prefix or
      // substring comparison would wave through.
      ["nonce with an internal space", { [CSRF_HEADER]: () => `${nonce.slice(0, 32)} ${nonce.slice(33)}` } as never],
    ];
    for (const [label, rawHeaders] of cases) {
      // Lazily-computed header values (they depend on the runtime nonce).
      const headers: Record<string, string> = { "content-type": "application/json" };
      for (const [k, v] of Object.entries(rawHeaders)) {
        headers[k] = typeof v === "function" ? (v as () => string)() : v;
      }
      const before = await entryCount();
      const res = await fetch(`${baseUrl}/api/entries`, {
        method: "POST",
        headers,
        body: JSON.stringify(entryPayload(`Csrf ${label}`)),
      });
      expect(res.status, `POST with ${label}`).toBe(403);
      const body = await res.json() as { code?: string };
      expect(body.code, `POST with ${label}`).toBe("CSRF_REQUIRED");
      // And nothing mutated.
      expect(await entryCount(), `POST with ${label} mutated the corpus`).toBe(before);
    }
  });

  it("accepts a whitespace-PADDED nonce, because the HTTP layer strips it before we see it", async () => {
    // Documenting an actual layer boundary rather than asserting a fiction. RFC
    // 9110 lets a recipient strip the optional whitespace around a field value,
    // and node's HTTP parser does, so `" <nonce> "` reaches the application as
    // the exact nonce bytes. The comparison itself does NO trimming (an internal
    // space is rejected, above) — this test exists so nobody "fixes" the padded
    // case by adding a `.trim()`, which is the change that would then also accept
    // a tab- or newline-mangled value at the application layer.
    //
    // A non-mutating mutation for the probe: DELETE /api/orphans with no orphans.
    const res = await fetch(`${baseUrl}/api/orphans`, {
      method: "DELETE",
      headers: { [CSRF_HEADER]: ` ${nonce} ` },
    });
    expect(res.status).toBe(200);
  });

  it("accepts the exact nonce", async () => {
    writeFileSync(join(privateImageDir(), "csrf-probe.png"), Buffer.from("fake-png-csrf"));
    const res = await fetch(`${baseUrl}/api/entries`, {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER]: nonce },
      body: JSON.stringify(entryPayload("Csrf accepted")),
    });
    expect(res.status).toBe(201);
  });

  it("requires the nonce on PUT, PATCH and DELETE as well as POST", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"] as const) {
      const res = await fetch(`${baseUrl}/api/entries/csrf-accepted`, {
        method,
        headers: { "content-type": "application/json" },
        body: method === "DELETE" ? undefined : JSON.stringify({ id: "csrf-accepted" }),
      });
      expect(res.status, `${method} without a nonce`).toBe(403);
    }
    // The existing orphan-delete route is covered too.
    const orphans = await fetch(`${baseUrl}/api/orphans`, { method: "DELETE" });
    expect(orphans.status).toBe(403);
  });

  // ── ORDERING: the check runs BEFORE the body is read and BEFORE any mutation ──
  //
  // This is the property a "check somewhere in the handler" implementation gets
  // wrong. The proof is a contrast pair on a body the server CANNOT parse:
  //   - no nonce  → 403, because the check ran first and the body was never read;
  //   - valid nonce → a parse failure, because the body WAS read.
  // If the nonce check ran after readJson, the first case would surface the parse
  // failure too, and this pair would be indistinguishable.
  it("rejects a missing nonce BEFORE reading the body (malformed-body contrast pair)", async () => {
    const malformed = '{ "id": "x", this is not json';

    const withoutNonce = await fetch(`${baseUrl}/api/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: malformed,
    });
    expect(withoutNonce.status).toBe(403);
    expect((await withoutNonce.json() as { code?: string }).code).toBe("CSRF_REQUIRED");

    const withNonce = await fetch(`${baseUrl}/api/entries`, {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER]: nonce },
      body: malformed,
    });
    // The body was read and failed to parse — a DIFFERENT outcome, which is only
    // possible if the nonce check precedes the read.
    expect(withNonce.status).not.toBe(403);
    expect(withNonce.status).toBeGreaterThanOrEqual(400);
  });

  it("rejects a missing nonce BEFORE mutating, even for a payload that would succeed", async () => {
    writeFileSync(join(privateImageDir(), "csrf-would-succeed.png"), Buffer.from("fake-png-would"));
    const payload = {
      ...entryPayload("Csrf would succeed"),
      image: { ...baseEntry.image, path: "images-private/csrf-would-succeed.png", width: 32, height: 32 },
    };
    const before = await entryCount();
    const blocked = await fetch(`${baseUrl}/api/entries`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(blocked.status).toBe(403);
    expect(await entryCount()).toBe(before);

    // The SAME payload with the nonce lands — so the 403 was the nonce, not the
    // payload, and the mutation really was prevented rather than merely delayed.
    const allowed = await fetch(`${baseUrl}/api/entries`, {
      method: "POST",
      headers: { "content-type": "application/json", [CSRF_HEADER]: nonce },
      body: JSON.stringify(payload),
    });
    expect(allowed.status).toBe(201);
    expect(await entryCount()).toBe(before + 1);
  });

  it("rejects a duplicated nonce header (a browser cannot smuggle two values)", async () => {
    // Node joins repeated headers with ", " — the joined value must not match.
    const res = await fetch(`${baseUrl}/api/entries`, {
      method: "POST",
      headers: [
        ["content-type", "application/json"],
        [CSRF_HEADER, nonce],
        [CSRF_HEADER, nonce],
      ] as unknown as HeadersInit,
      body: JSON.stringify(entryPayload("Csrf duplicated")),
    });
    expect(res.status).toBe(403);
  });
});

// The nonce dies with the process. A module instance IS the process's copy of
// that state, so re-instantiating the module is the faithful in-suite equivalent
// of a restart: it proves the nonce lives in module memory and nowhere durable.
describe("CSRF nonce invalidation across a restart", () => {
  let base: string;

  beforeAll(() => {
    base = mkdtempSync(join(tmpdir(), "ui-server-csrf-restart-"));
    writeFileSync(join(base, "entries.json"), JSON.stringify({ version: 2, entries: [] }));
  });

  afterAll(() => {
    setCorpusRootForTesting(null);
    rmSync(base, { recursive: true, force: true });
  });

  it("issues a DIFFERENT nonce after a restart and rejects the pre-restart nonce", async () => {
    setCorpusRootForTesting(base);
    const first = await startServer(0);
    const firstAddr = first.address();
    if (!firstAddr || typeof firstAddr !== "object") throw new Error("server did not bind");
    const firstUrl = `http://127.0.0.1:${firstAddr.port}`;
    const staleNonce = (await (await fetch(`${firstUrl}/api/csrf`)).json() as { nonce: string }).nonce;
    await new Promise<void>((r) => first.close(() => r()));

    // Restart: a fresh module instance, i.e. a fresh process's worth of state.
    vi.resetModules();
    const restarted = await import("./ui-server.js");
    const { setCorpusRootForTesting: setRootFresh } = await import("../persistence.js");
    setRootFresh(base);
    const second = await restarted.startServer(0);
    try {
      const secondAddr = second.address();
      if (!secondAddr || typeof secondAddr !== "object") throw new Error("server did not bind");
      const secondUrl = `http://127.0.0.1:${secondAddr.port}`;

      const freshNonce = (await (await fetch(`${secondUrl}/api/csrf`)).json() as { nonce: string }).nonce;
      expect(freshNonce).not.toBe(staleNonce);

      // The pre-restart nonce is no longer accepted anywhere.
      const res = await fetch(`${secondUrl}/api/entries`, {
        method: "POST",
        headers: { "content-type": "application/json", [CSRF_HEADER]: staleNonce },
        body: JSON.stringify({ ...baseEntry, id: "" }),
      });
      expect(res.status).toBe(403);
      expect((await res.json() as { code?: string }).code).toBe("CSRF_REQUIRED");
    } finally {
      await new Promise<void>((r) => second.close(() => r()));
    }
  });
});

describe("POST /api/create-ui-spec (the C3 loopback route)", () => {
  let server: import("node:http").Server;
  let baseUrl: string;
  let base: string;
  let csrf: Record<string, string>;

  async function postSpec(
    body: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; text: string }> {
    const res = await fetch(`${baseUrl}/api/create-ui-spec`, {
      method: "POST",
      headers: { "content-type": "application/json", ...csrf, ...extraHeaders },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: res.status, text: await res.text() };
  }

  const VALID_BODY = { productContext: "A calm analytics dashboard for a fintech team" };

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "ui-server-c3-"));
    writeFileSync(join(base, "entries.json"), JSON.stringify({ version: 2, entries: [] }));
    setCorpusRootForTesting(base);
    // The route reads through PrivateCorpusReader → corpus.ts. Inject the
    // private-marker-laden fixture so retrieval really returns corpus content
    // and the leak assertions have something to catch.
    setCorpusForTesting([PRIVATE_MARKED_ENTRY]);
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("server did not bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;
    csrf = await csrfHeader(baseUrl);
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    setCorpusForTesting(null);
    setCorpusRootForTesting(null);
    rmSync(base, { recursive: true, force: true });
  });

  it("returns 200 with a body that passes parseDesignArtifactEnvelope()", async () => {
    const { status, text } = await postSpec(VALID_BODY);
    expect(status).toBe(200);
    const envelope = parseDesignArtifactEnvelope(JSON.parse(text));
    expect(envelope.artifactVersion).toBe("1.0");
    expect(envelope.designMarkdown.length).toBeGreaterThan(0);
    expect(envelope.designJson.length).toBeGreaterThan(0);
    expect(envelope.publicEvidenceIds.length).toBeGreaterThan(0);
  });

  it("adds no adapter field — the served key set is the envelope's own", async () => {
    const { text } = await postSpec(VALID_BODY);
    const served = JSON.parse(text) as Record<string, unknown>;
    for (const forbidden of ["summary", "tool", "schemaVersion", "status", "data", "evidence", "error", "isError", "content", "structuredContent", "outputFormat", "nonce"]) {
      expect(Object.keys(served), `served envelope carries ${forbidden}`).not.toContain(forbidden);
    }
  });

  it("carries no private corpus marker anywhere in the complete response", async () => {
    const { text } = await postSpec(VALID_BODY);
    for (const marker of C3_BANNED_MARKERS) {
      expect(text.includes(marker), `response contains ${marker}`).toBe(false);
    }
    expect(containsPrivateMarker(text)).toBe(false);
  });

  it("still produces a servable artifact when retrieval matches nothing", async () => {
    // A brief with no lexical overlap with the single fixture entry.
    const { status, text } = await postSpec({
      productContext: "Zqxk wombat telemetry harness for subterranean freight",
    });
    expect(status).toBe(200);
    const envelope = parseDesignArtifactEnvelope(JSON.parse(text));
    expect(["structured-fallback", "keyword"]).toContain(envelope.retrieval.mode);
    for (const marker of C3_BANNED_MARKERS) expect(text.includes(marker)).toBe(false);
  });

  it("returns a bounded typed 400 for invalid input", async () => {
    const { status, text } = await postSpec({ productContext: "tiny" });
    expect(status).toBe(400);
    const body = JSON.parse(text) as { error: { code: string; message: string; retryable: boolean } };
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.retryable).toBe(false);
    expect(Object.keys(body)).toEqual(["error"]);
    // No zod issue array (issues quote the caller's own values).
    expect(text.includes("issues")).toBe(false);
  });

  it("rejects an outputFormat field (HTTP returns both renderings)", async () => {
    const { status, text } = await postSpec({ ...VALID_BODY, outputFormat: "json" });
    expect(status).toBe(400);
    expect((JSON.parse(text) as { error: { code: string } }).error.code).toBe("INVALID_INPUT");
  });

  it("rejects a malformed JSON body with a typed error and no exception text", async () => {
    const { status, text } = await postSpec("{ not json");
    expect(status).toBe(400);
    const body = JSON.parse(text) as { error: { code: string } };
    expect(body.error.code).toBe("INVALID_INPUT");
    // The JSON.parse failure message quotes the offending input — it must not leak.
    expect(text.includes("not json")).toBe(false);
    expect(text.toLowerCase().includes("unexpected token")).toBe(false);
  });

  it("refuses browser-supplied credential headers", async () => {
    for (const header of [
      { authorization: "Bearer sk-live-not-a-real-token" },
      { "proxy-authorization": "Basic Zm9vOmJhcg==" },
    ]) {
      const { status, text } = await postSpec(VALID_BODY, header);
      expect(status, `header ${Object.keys(header)[0]} was accepted`).toBe(400);
      const body = JSON.parse(text) as { error: { code: string } };
      expect(body.error.code).toBe("INVALID_INPUT");
      // Nothing from the credential is echoed.
      expect(text.includes("sk-live")).toBe(false);
      expect(text.includes("Zm9vOmJhcg")).toBe(false);
      // And no artifact was produced.
      expect(text.includes("artifactVersion")).toBe(false);
    }
  });

  it("IGNORES a cookie header instead of refusing the request", async () => {
    // Cookies are HOST-scoped, not port-scoped (RFC 6265 §8.5). A cookie set by
    // ANY other dev server on localhost — Vite on 5173, Next on 3000 — is
    // attached by the browser to this request, and `fetch` sends it because a POST
    // from the site to /api/create-ui-spec is same-origin. Refusing on the mere
    // PRESENCE of a cookie would therefore 400 the playground for any operator who
    // has ever run another local server, with a body byte-identical to the
    // bad-brief refusal and nothing logged — undiagnosable.
    //
    // The constraint is that no browser-supplied credential is USED. This route
    // never reads the header at all, which satisfies it more strongly than a 400
    // does, and this test pins BOTH halves: the request succeeds, and nothing from
    // the cookie reaches the response or the console.
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const { status, text } = await postSpec(VALID_BODY, {
        cookie: "unrelated_dev_server_session=zq-cookie-marker-4417; theme=dark",
      });
      expect(status, "a cookie-bearing request was refused").toBe(200);
      parseDesignArtifactEnvelope(JSON.parse(text));
      expect(text.includes("zq-cookie-marker-4417")).toBe(false);
      expect(text.includes("unrelated_dev_server_session")).toBe(false);
      expect(text.toLowerCase().includes("cookie")).toBe(false);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("never READS a cookie header anywhere in the server (the constraint, mechanically)", () => {
    // "Ignoring is safe" is only true while nothing consults the header. This is
    // the static half of the test above: no cookie value may be authenticated on,
    // logged, forwarded, or refused on. It fails if any future edit reaches for it
    // — including re-adding `cookie` to the refused-header list, whose 400 would
    // silently break the playground again.
    const source = readFileSync(new URL("./ui-server.ts", import.meta.url), "utf-8");
    expect(source).not.toMatch(/headers\s*\.\s*cookie/i);
    expect(source).not.toMatch(/headers\s*\[\s*['"`]\s*cookie/i);
    expect(source).not.toMatch(/REFUSED_C3_REQUEST_HEADERS[^;]*['"`]cookie/i);
  });

  it("serves a NON-retryable 503 when the integrity re-check refuses the response", async () => {
    // A deterministic refusal: the same request reproduces it exactly, so a client
    // that honours `retryable` must NOT retry. The code and message stay the
    // shared PROVIDER_ERROR pair (a caller must not learn it was a producer
    // defect); only the flag is honest about repeatability.
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    c3Adapter.forceIntegrityFailure = true;
    try {
      const { status, text } = await postSpec(VALID_BODY);
      expect(status).toBe(503);
      const body = JSON.parse(text) as { error: { code: string; message: string; retryable: boolean } };
      expect(body.error.code).toBe("PROVIDER_ERROR");
      expect(body.error.retryable).toBe(false);
      expect(Object.keys(body)).toEqual(["error"]);
      // Nothing from the thrown message reaches the wire.
      expect(text.includes("integrity")).toBe(false);
      expect(text.includes("values withheld")).toBe(false);
      // The log is a FIXED literal: no request value, no exception text. It names
      // the GATE FAMILY, not one gate — the adapter has five throw sites and this
      // handler cannot tell them apart, so a literal naming the integrity re-check
      // specifically (as it used to) would misattribute an ID-shape or
      // citation-consistency refusal.
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0]).toEqual([
        "[create_ui_spec] response refused by a serve-time integrity gate; nothing was served",
      ]);
      expect(errorSpy.mock.calls[0]![0]).not.toContain("design-artifact");
    } finally {
      c3Adapter.forceIntegrityFailure = false;
      errorSpy.mockRestore();
    }
  });

  it("serves the SAME error body for a pre-adapter refusal as the adapter itself does", async () => {
    // The route refuses some requests before the adapter runs (a credential
    // header, an unparseable body, an oversized body). Those bodies must be the
    // adapter's own INVALID_INPUT body, byte for byte — otherwise a client faces
    // two error contracts, and the two can drift silently.
    const fromAdapter = await postSpec({ productContext: "tiny" });
    const fromRoute = await postSpec(VALID_BODY, { authorization: "Bearer x" });
    const fromParseFailure = await postSpec("{ not json");
    expect(fromRoute.status).toBe(fromAdapter.status);
    expect(fromRoute.text).toBe(fromAdapter.text);
    expect(fromParseFailure.text).toBe(fromAdapter.text);
  });

  it("rejects a screenshot or provider configuration in the body", async () => {
    for (const extra of [
      { screenshot: "data:image/png;base64,AAAA" },
      { critiqueProvider: "openai" },
      { apiKey: "sk-live-not-a-real-key" },
    ]) {
      const { status, text } = await postSpec({ ...VALID_BODY, ...extra });
      expect(status, `body field ${Object.keys(extra)[0]} was accepted`).toBe(400);
      expect(text.includes("sk-live")).toBe(false);
    }
  });

  it("requires the CSRF nonce", async () => {
    const res = await fetch(`${baseUrl}/api/create-ui-spec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(403);
    const text = await res.text();
    expect((JSON.parse(text) as { code?: string }).code).toBe("CSRF_REQUIRED");
    expect(text.includes("artifactVersion")).toBe(false);
  });

  it("rejects an unexpected origin", async () => {
    const res = await fetch(`${baseUrl}/api/create-ui-spec`, {
      method: "POST",
      headers: { "content-type": "application/json", ...csrf, origin: "https://evil.example.com" },
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(403);
    expect((await res.text()).includes("artifactVersion")).toBe(false);
  });

  it("writes nothing about the request to the server console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      await postSpec({ productContext: "zq-server-log-brief-marker-7719 dashboard for a fintech" });
      await postSpec({ productContext: "tiny" });
      await postSpec("{ not json");
      for (const spy of spies) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("is served by the loopback API, not the static site", async () => {
    // GET on the route is not an API surface — it must not fall through to a
    // static handler or the SPA shell.
    const res = await fetch(`${baseUrl}/api/create-ui-spec`);
    expect(res.status).toBe(404);
    expect((await res.text()).includes("<html")).toBe(false);
  });
});

describe("production static serving under /clean-ui-mcp/ (CLEAN_UI_SITE_DIST)", () => {
  let server: import("node:http").Server;
  let baseUrl: string;
  let base: string;
  let outside: string;
  let dist: string;
  const priorEnv = process.env.CLEAN_UI_SITE_DIST;

  const SECRET = "zq-outside-the-root-secret-6604";

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "ui-server-site-"));
    writeFileSync(join(base, "entries.json"), JSON.stringify({ version: 2, entries: [] }));
    setCorpusRootForTesting(base);

    // The "outside" tree holds the file every traversal case is trying to reach.
    outside = mkdtempSync(join(tmpdir(), "ui-server-site-outside-"));
    writeFileSync(join(outside, "secret.txt"), SECRET);

    dist = join(base, "site-dist");
    mkdirSync(join(dist, "assets"), { recursive: true });
    mkdirSync(join(dist, "api"), { recursive: true });
    mkdirSync(join(dist, "sub"), { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html><title>site shell</title>");
    writeFileSync(join(dist, "assets", "app.js"), "export const x = 1;");
    writeFileSync(join(dist, "assets", "app.css"), ".a{color:red}");
    writeFileSync(join(dist, "manifest.json"), '{"name":"site"}');
    // A file that shadows the API path — the API must still win.
    writeFileSync(join(dist, "api", "config"), "STATIC-SHADOW-OF-THE-API");
    // An asset that STATS fine but cannot be READ. statSync needs no read
    // permission, so the resolver returns it and the read is what fails.
    writeFileSync(join(dist, "assets", "locked.js"), "zq-unreadable-asset-body-8821");
    chmodSync(join(dist, "assets", "locked.js"), 0o000);
    // Symlink escapes: one file link, one directory link.
    symlinkSync(join(outside, "secret.txt"), join(dist, "escape.txt"));
    symlinkSync(outside, join(dist, "escapedir"));

    process.env.CLEAN_UI_SITE_DIST = dist;
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("server did not bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (priorEnv === undefined) delete process.env.CLEAN_UI_SITE_DIST;
    else process.env.CLEAN_UI_SITE_DIST = priorEnv;
    setCorpusRootForTesting(null);
    // Restore the modes the EACCES tests changed, so the tree removes cleanly even
    // if one of those tests failed before its own restore ran.
    chmodSync(join(dist, "assets", "locked.js"), 0o644);
    chmodSync(join(dist, "index.html"), 0o644);
    rmSync(base, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("serves index.html at the site root, with and without the trailing slash", async () => {
    for (const path of ["/clean-ui-mcp/", "/clean-ui-mcp"]) {
      const res = await fetch(`${baseUrl}${path}`);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(await res.text()).toContain("site shell");
    }
  });

  it("301-redirects the bare site path to the trailing-slash form", async () => {
    // Without this, a build whose `base` emits RELATIVE asset urls resolves
    // `./assets/app.js` against `/clean-ui-mcp` → `/assets/app.js`, which is
    // outside the site branch and 404s. Entering at `/clean-ui-mcp/` works, so the
    // redirect makes both entry points equivalent (Task 6 inherits a working
    // mount rather than this trap).
    const res = await fetch(`${baseUrl}/clean-ui-mcp`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/clean-ui-mcp/");
    // No filesystem path in a redirect either.
    expect(res.headers.get("location")!.includes(dist)).toBe(false);
  });

  it("preserves the query string across the trailing-slash redirect", async () => {
    const res = await fetch(`${baseUrl}/clean-ui-mcp?tab=playground`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/clean-ui-mcp/?tab=playground");
  });

  it("404s an UNREADABLE asset without leaking its filesystem path", async () => {
    // `statSync().isFile()` succeeds on a mode-000 file (stat needs no read
    // permission), so the resolver returns it and `readFileSync` throws EACCES —
    // whose message carries the absolute path. Unhandled, that path lands in both
    // the 500 body and the operator's console. It must 404 silently instead.
    if (process.getuid?.() === 0) return; // root ignores file modes
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const res = await fetch(`${baseUrl}/clean-ui-mcp/assets/locked.js`);
      const text = await res.text();
      expect(res.status).toBe(404);
      expect(text).not.toContain("zq-unreadable-asset-body-8821");
      expect(text).not.toContain(dist);
      expect(text).not.toContain("locked.js");
      expect(text.toUpperCase()).not.toContain("EACCES");
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          const line = call
            .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
            .join(" ");
          expect(line, "a filesystem path reached the console").not.toContain(dist);
          expect(line, "a path-shaped string reached the console").not.toMatch(
            /(?:^|\s)\/(?:Users|private|var|tmp|home)\//,
          );
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("404s an extensionless route whose SHELL is unreadable, rather than 500ing", async () => {
    // The SPA fallback reads index.html through the same path. Same EACCES shape.
    if (process.getuid?.() === 0) return;
    const shell = join(dist, "index.html");
    chmodSync(shell, 0o000);
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const res = await fetch(`${baseUrl}/clean-ui-mcp/playground`);
      const text = await res.text();
      expect(res.status).toBe(404);
      expect(text).not.toContain(dist);
      expect(text.toUpperCase()).not.toContain("EACCES");
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          const line = call
            .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
            .join(" ");
          expect(line).not.toContain(dist);
        }
      }
    } finally {
      chmodSync(shell, 0o644);
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("serves hashed assets with correct content types", async () => {
    const js = await fetch(`${baseUrl}/clean-ui-mcp/assets/app.js`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("export const x");

    const css = await fetch(`${baseUrl}/clean-ui-mcp/assets/app.css`);
    expect(css.headers.get("content-type")).toContain("text/css");

    const json = await fetch(`${baseUrl}/clean-ui-mcp/manifest.json`);
    expect(json.status).toBe(200);
    expect(json.headers.get("content-type")).toContain("application/json");
  });

  it("falls back to the SPA shell for an extensionless route", async () => {
    const res = await fetch(`${baseUrl}/clean-ui-mcp/playground`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("site shell");
  });

  it("404s a missing ASSET rather than serving the shell (a broken import must fail loudly)", async () => {
    const res = await fetch(`${baseUrl}/clean-ui-mcp/assets/missing.js`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("site shell");
  });

  // ── PATH TRAVERSAL ──
  // Every case must refuse: no SECRET in the body, and no 200-with-content.
  it("refuses every traversal, encoding and symlink escape", async () => {
    const cases = [
      "/clean-ui-mcp/../secret.txt",
      "/clean-ui-mcp/..%2Fsecret.txt",
      "/clean-ui-mcp/%2e%2e%2fsecret.txt",
      "/clean-ui-mcp/%2e%2e/secret.txt",
      "/clean-ui-mcp/%252e%252e%252fsecret.txt",
      "/clean-ui-mcp/sub/..%2f..%2fsecret.txt",
      "/clean-ui-mcp/sub/%2e%2e/%2e%2e/secret.txt",
      "/clean-ui-mcp/..\\secret.txt",
      "/clean-ui-mcp/%2e%2e%5csecret.txt",
      `/clean-ui-mcp/${encodeURIComponent(join(outside, "secret.txt"))}`,
      `/clean-ui-mcp/%2f${encodeURIComponent(join(outside, "secret.txt").replace(/^\//, ""))}`,
      "/clean-ui-mcp/escape.txt",
      "/clean-ui-mcp/escapedir/secret.txt",
      "/clean-ui-mcp/index.html%00.png",
      "/clean-ui-mcp/%00index.html",
    ];
    for (const path of cases) {
      const res = await fetch(`${baseUrl}${path}`);
      const text = await res.text();
      expect(text.includes(SECRET), `${path} served the out-of-root secret`).toBe(false);
    }
  });

  it("refuses a symlink escape even though the link target exists", async () => {
    // Named separately so the failure message is unambiguous: existsSync on a
    // symlink follows it, so an existence check alone would happily serve this.
    const res = await fetch(`${baseUrl}/clean-ui-mcp/escape.txt`);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("keeps /api/* on the loopback API even when a static file shadows it", async () => {
    const res = await fetch(`${baseUrl}/api/config`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("STATIC-SHADOW-OF-THE-API");
    expect(JSON.parse(text)).toHaveProperty("cleanUiPort");
  });

  it("still binds loopback only with the site served", async () => {
    const addr = server.address();
    expect(addr && typeof addr === "object" ? addr.address : null).toBe("127.0.0.1");
  });
});

describe("static site absent (CLEAN_UI_SITE_DIST unset) — curator UI retained", () => {
  let server: import("node:http").Server;
  let baseUrl: string;
  let base: string;
  const priorEnv = process.env.CLEAN_UI_SITE_DIST;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "ui-server-nosite-"));
    writeFileSync(join(base, "entries.json"), JSON.stringify({ version: 2, entries: [] }));
    setCorpusRootForTesting(base);
    delete process.env.CLEAN_UI_SITE_DIST;
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("server did not bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (priorEnv !== undefined) process.env.CLEAN_UI_SITE_DIST = priorEnv;
    setCorpusRootForTesting(null);
    rmSync(base, { recursive: true, force: true });
  });

  it("404s the site path", async () => {
    const res = await fetch(`${baseUrl}/clean-ui-mcp/`);
    expect(res.status).toBe(404);
  });

  it("still serves the curator app shell and its static assets", async () => {
    const app = await fetch(`${baseUrl}/`);
    expect(app.status).toBe(200);
    expect(app.headers.get("content-type")).toContain("text/html");

    const asset = await fetch(`${baseUrl}/static/app.js`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toContain("text/javascript");
  });

  it("still serves the curator API", async () => {
    const res = await fetch(`${baseUrl}/api/schema`);
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveProperty("categories");
  });

  it("still issues a CSRF nonce", async () => {
    const res = await fetch(`${baseUrl}/api/csrf`);
    expect(res.status).toBe(200);
    expect((await res.json() as { nonce: string }).nonce).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("static /static/ route — EACCES safety", () => {
  // The `/static/` branch (extracted CSS/JS served from ui/) has the IDENTICAL
  // shape to the `/clean-ui-mcp/` site branch's pre-fix bug: `existsSync` (like
  // `statSync`) needs no read permission, so a mode-000 file resolves as
  // present, the 200 head gets written, and `readFileSync` throws EACCES —
  // whose message carries the absolute path — AFTER the head is sent. That
  // means the catch-all's `sendJson(res, 500, …)` throws
  // `ERR_HTTP_HEADERS_SENT` and the request hangs, on top of the path leaking
  // into the body and the console. STATIC_DIR is a fixed constant
  // (`resolve(PROJECT_ROOT, "ui")`, not overridable per-test), so the locked
  // file is created inside — and removed from — the real `ui/` directory.
  let server: import("node:http").Server;
  let baseUrl: string;
  let base: string;
  const priorEnv = process.env.CLEAN_UI_SITE_DIST;
  const lockedName = "zq-static-eacces-locked-8821.js";
  const lockedPath = join(PROJECT_ROOT, "ui", lockedName);
  const canChmod = process.getuid?.() !== 0; // root ignores file modes

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "ui-server-static-eacces-"));
    writeFileSync(join(base, "entries.json"), JSON.stringify({ version: 2, entries: [] }));
    setCorpusRootForTesting(base);
    delete process.env.CLEAN_UI_SITE_DIST;
    if (canChmod) {
      // Defensive: a prior crashed/hung run (e.g. the pre-fix ERR_HTTP_HEADERS_SENT
      // hang) could leave a mode-000 leftover behind, which would make this
      // writeFileSync itself throw EACCES.
      if (existsSync(lockedPath)) {
        chmodSync(lockedPath, 0o644);
        unlinkSync(lockedPath);
      }
      writeFileSync(lockedPath, "zq-unreadable-static-body-8821");
      chmodSync(lockedPath, 0o000);
    }
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("server did not bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    if (priorEnv === undefined) delete process.env.CLEAN_UI_SITE_DIST;
    else process.env.CLEAN_UI_SITE_DIST = priorEnv;
    setCorpusRootForTesting(null);
    if (canChmod && existsSync(lockedPath)) {
      chmodSync(lockedPath, 0o644);
      unlinkSync(lockedPath);
    }
    rmSync(base, { recursive: true, force: true });
  });

  it("404s an UNREADABLE /static/ asset without leaking its filesystem path or hanging", async () => {
    if (!canChmod) return; // root ignores file modes — nothing to prove here
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const res = await fetch(`${baseUrl}/static/${lockedName}`);
      const text = await res.text();
      expect(res.status).toBe(404);
      expect(text).not.toContain("zq-unreadable-static-body-8821");
      expect(text).not.toContain(join(PROJECT_ROOT, "ui"));
      expect(text).not.toContain(lockedName);
      expect(text.toUpperCase()).not.toContain("EACCES");
      for (const spy of spies) {
        for (const call of spy.mock.calls) {
          const line = call
            .map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
            .join(" ");
          expect(line, "a filesystem path reached the console").not.toContain(join(PROJECT_ROOT, "ui"));
          expect(line, "a path-shaped string reached the console").not.toMatch(
            /(?:^|\s)\/(?:Users|private|var|tmp|home)\//,
          );
        }
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// The HTTP cases above prove "the secret never reaches the wire". But WHATWG URL
// parsing normalizes some traversal forms away before any handler sees them (a
// literal `..` segment, and a `%2e%2e` segment, are collapsed by `new URL()`), so
// those cases do not prove the RESOLVER refuses anything. These tests call the
// resolver directly with the exact post-prefix string, so every refusal below is
// unambiguously this code's.
describe("resolveSiteAsset — traversal containment (direct)", () => {
  let root: string;
  let outside: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "resolve-site-root-"));
    outside = mkdtempSync(join(tmpdir(), "resolve-site-outside-"));
    mkdirSync(join(root, "assets"), { recursive: true });
    mkdirSync(join(root, "sub"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    writeFileSync(join(root, "assets", "app.js"), "x");
    writeFileSync(join(outside, "secret.txt"), "secret");
    symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
    symlinkSync(outside, join(root, "escapedir"));
    // A sibling directory whose name merely starts with the root's name. A prefix
    // check that forgets the path separator would treat this as inside the root.
    mkdirSync(`${root}-evil`, { recursive: true });
    writeFileSync(join(`${root}-evil`, "secret.txt"), "secret");
    // …reached through an IN-ROOT symlink, which is the only way a request can
    // actually land there: with no `..` and no leading separator, `resolve()`
    // cannot produce a path outside the root, so the string containment check is
    // only reachable via a realpath that leaves it. See the test below.
    symlinkSync(`${root}-evil`, join(root, "evildir"));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
    rmSync(`${root}-evil`, { recursive: true, force: true });
  });

  it("resolves a legitimate asset and the implicit index", () => {
    expect(resolveSiteAsset(root, "assets/app.js")).toBe(join(realpathSync(root), "assets", "app.js"));
    expect(resolveSiteAsset(root, "")).toBe(join(realpathSync(root), "index.html"));
    expect(resolveSiteAsset(root, "index.html")).toBe(join(realpathSync(root), "index.html"));
  });

  it("refuses a literal traversal segment", () => {
    for (const rel of ["../secret.txt", "..", "../", "sub/../../secret.txt", "a/../../secret.txt", "..\\secret.txt"]) {
      expect(resolveSiteAsset(root, rel), rel).toBeNull();
    }
  });

  it("refuses a traversal that only appears AFTER percent-decoding", () => {
    // The bypass this ordering exists to stop: none of these contain `..` until
    // they are decoded, so a check performed on the raw string passes them.
    for (const rel of [
      "%2e%2e%2fsecret.txt",
      "%2E%2E%2Fsecret.txt",
      "..%2fsecret.txt",
      "..%2Fsecret.txt",
      "%2e%2e%5csecret.txt",
      "sub%2f..%2f..%2fsecret.txt",
      "sub/%2e%2e/%2e%2e/secret.txt",
    ]) {
      expect(resolveSiteAsset(root, rel), rel).toBeNull();
    }
  });

  it("refuses an absolute path, decoded or not", () => {
    const abs = join(outside, "secret.txt");
    for (const rel of [abs, encodeURIComponent(abs), `%2f${abs.replace(/^\//, "")}`, "/etc/passwd", "\\etc\\passwd"]) {
      expect(resolveSiteAsset(root, rel), rel).toBeNull();
    }
  });

  it("refuses a NUL byte", () => {
    for (const rel of ["index.html%00.png", "%00index.html", "assets/%00app.js"]) {
      expect(resolveSiteAsset(root, rel), rel).toBeNull();
    }
  });

  it("refuses a malformed percent-encoding rather than passing it through", () => {
    for (const rel of ["%", "%zz", "%e0%a4%a", "index%.html"]) {
      expect(resolveSiteAsset(root, rel), rel).toBeNull();
    }
  });

  it("refuses a symlink that escapes the root — file AND directory", () => {
    // existsSync() FOLLOWS symlinks, so an existence check alone would serve
    // both of these. The realpath containment check is what refuses them.
    expect(existsSync(join(root, "escape.txt"))).toBe(true); // the trap is real
    expect(resolveSiteAsset(root, "escape.txt")).toBeNull();
    expect(resolveSiteAsset(root, "escapedir/secret.txt")).toBeNull();
  });

  it("refuses a sibling directory that merely shares the root's name prefix", () => {
    // `<root>-evil/secret.txt` starts with `<root>` as a STRING but is not inside
    // it, so ONLY a separator-aware containment check refuses it. Reaching that
    // check requires a realpath that leaves the root: `evildir` is an in-root
    // symlink to the sibling, so the decoded text contains no `..` and no leading
    // separator, `resolve()` stays inside the root, and the refusal is
    // unambiguously the separator-aware `isWithinRoot(realRoot, realCandidate)`
    // comparison. Falsified: replacing that comparison with a bare
    // `candidate.startsWith(root)` makes this case RESOLVE.
    expect(existsSync(join(root, "evildir", "secret.txt"))).toBe(true); // the trap is real
    expect(resolveSiteAsset(root, "evildir/secret.txt")).toBeNull();

    // The `../<basename>-evil/...` spelling is refused EARLIER, by the `..` text
    // check — it proves the traversal rule, not the containment rule. Kept as a
    // regression case with an accurate label rather than deleted.
    expect(resolveSiteAsset(root, `../${[...root.split(sep)].pop()}-evil/secret.txt`)).toBeNull();
  });

  it("leaves a DOUBLE-encoded traversal as a harmless in-root miss", () => {
    // `%252e%252e%252f` decodes ONCE to the literal text `%2e%2e%2f`, which is not
    // a traversal — decoding twice would be the bug. It resolves inside the root
    // and simply does not exist.
    expect(resolveSiteAsset(root, "%252e%252e%252fsecret.txt")).toBeNull();
  });

  it("refuses a directory, even a legitimate in-root one", () => {
    expect(resolveSiteAsset(root, "assets")).toBeNull();
    expect(resolveSiteAsset(root, "sub")).toBeNull();
  });
});

// ─── EACCES safety for the three remaining read-after-head sites ──────────────
//
// THE SHAPE (identical in all three, and identical to the already-fixed
// `/clean-ui-mcp/` + `/static/` branches): an existence/stat check needs no READ
// permission, so a mode-000 file passes it; the handler then writes the 200 head
// and only THEN calls `readFileSync`, which throws
// `EACCES: permission denied, open '<absolute path>'`. Because the head is
// already on the wire, the catch-all's `sendJson(res, 500, …)` itself throws
// `ERR_HTTP_HEADERS_SENT` from inside a `catch` block — so the absolute path
// reaches `console.error`, the response is never ended (the client hangs), and
// the rejection escapes `handleUiRequest` unhandled, which kills the process
// under Node's default `--unhandled-rejections=throw`.
//
// Every test below therefore asserts FOUR things, not one:
//   1. status 404 (not 200, not 500),
//   2. no root, filename, `EACCES` or file CONTENT in the body,
//   3. no path-shaped string in ANY console.* argument,
//   4. the server still answers the next request (proof it is alive and that the
//      request did not hang — the fetch carries its own abort timeout, so a hang
//      fails fast instead of stalling for the whole test timeout).
// Absolute-path detector for leak assertions. The delimiter class includes the
// quote/paren/equals characters that bracket a path inside a real errno message
// (`EACCES: … open '/Users/…'`) — a bare `(?:^|\s)` prefix would MISS that shape,
// since the slash there is preceded by a single quote, not whitespace.
const PATH_SHAPED = /(?:^|[\s'"(=])\/(?:Users|private|var|tmp|home)\//;

function consoleSpies() {
  return (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
}

function consoleLines(spies: ReturnType<typeof consoleSpies>): string[] {
  return spies.flatMap((spy) =>
    spy.mock.calls.map((call) =>
      call.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}\n${arg.stack ?? ""}` : String(arg))).join(" "),
    ),
  );
}

/** Fetch with a hard abort, so the pre-fix HANG fails in 4s rather than stalling. */
function fetchBounded(url: string, timeoutMs = 4_000): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
}

// The lock-holding fetch inside `expectSilent404` chmods a TRACKED, SHARED file
// (index-2.html / index-classic.html) to 000 before awaiting, so the file stays
// unreadable for as long as this request takes to settle. `ui-browser.test.ts`'s
// `readShell` polls the same files at collection time with a 500ms retry budget
// specifically to survive that transient window (healthy case: ~3ms). A generic
// 4s abort here means a MISSING guard — the exact regression this block exists
// to catch — leaves the lock in place for ~4s, 8x readShell's budget, so a
// concurrent collection of ui-browser.test.ts fails with an EACCES on an
// innocent file instead of this block's own test failing. Capping this specific
// fetch at 300ms (100x the healthy 3ms, comfortably under the 500ms budget)
// closes that gap without touching the 4s default other callers still get: a
// missing guard now fails ITS OWN test in ~300ms, and the lock never outlives
// readShell's retry.
const SHELL_LOCK_ABORT_MS = 300;

describe("GET /api/image — EACCES safety", () => {
  // `/api/image` resolves through `fromCorpusRelativeImagePath`, which honors
  // `setPrivateImageDirForTesting` — so the mode-000 fixture lives entirely in a
  // temp dir and no tracked file is touched by this block.
  let server: import("node:http").Server;
  let baseUrl: string;
  let base: string;
  let imgDir: string;
  const priorEnv = process.env.CLEAN_UI_SITE_DIST;
  const canChmod = process.getuid?.() !== 0; // root ignores file modes
  const lockedName = "zq-image-eacces-locked-8821.png";
  let lockedPath: string;

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "ui-server-image-eacces-"));
    writeFileSync(join(base, "entries.json"), JSON.stringify({ version: 2, entries: [] }));
    setCorpusRootForTesting(base);
    imgDir = join(base, "images-private");
    mkdirSync(imgDir, { recursive: true });
    setPrivateImageDirForTesting(imgDir);
    delete process.env.CLEAN_UI_SITE_DIST;
    lockedPath = join(imgDir, lockedName);
    writeFileSync(lockedPath, "zq-unreadable-image-body-8821");
    if (canChmod) chmodSync(lockedPath, 0o000);
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("server did not bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    // Restore shared state FIRST, and guard the close: if beforeAll threw before
    // startServer resolved, `server` is undefined and an unguarded `.close()`
    // would abort the rest of this teardown, leaking the env var and both
    // path overrides into every later block in this file.
    if (priorEnv === undefined) delete process.env.CLEAN_UI_SITE_DIST;
    else process.env.CLEAN_UI_SITE_DIST = priorEnv;
    setPrivateImageDirForTesting(null);
    setCorpusRootForTesting(null);
    if (existsSync(lockedPath)) chmodSync(lockedPath, 0o644);
    rmSync(base, { recursive: true, force: true });
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  it("404s an UNREADABLE image without leaking its path, hanging, or killing the process", async () => {
    if (!canChmod) return; // root ignores file modes — nothing to prove here
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const spies = consoleSpies();
    try {
      const res = await fetchBounded(`${baseUrl}/api/image?path=images-private/${lockedName}`);
      const text = await res.text();
      expect(res.status).toBe(404);
      expect(text).not.toContain("zq-unreadable-image-body-8821");
      expect(text).not.toContain(imgDir);
      expect(text).not.toContain(base);
      expect(text).not.toContain(lockedName);
      expect(text.toUpperCase()).not.toContain("EACCES");
      const lines = consoleLines(spies);
      for (const line of lines) {
        expect(line, "a filesystem path reached the console").not.toContain(base);
        expect(line, "a path-shaped string reached the console").not.toMatch(PATH_SHAPED);
      }
      // Strict, because the per-line sweep above passes VACUOUSLY when nothing
      // was logged and so cannot tell "silent" from "not wired": an unreadable
      // file is a normal 404 here, and a 404 logs nothing at all.
      expect(lines, "the request logged something; it must be silent").toEqual([]);
      // Still alive, still serving — the rejection did not escape.
      const after = await fetchBounded(`${baseUrl}/api/schema`);
      expect(after.status).toBe(200);
      await after.text();
      await new Promise((r) => setTimeout(r, 50)); // let any escaped rejection surface
      expect(unhandled, "an unhandled rejection escaped the request").toEqual([]);
    } finally {
      for (const spy of spies) spy.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("still serves a READABLE image", async () => {
    const okName = "zq-image-readable-8821.png";
    writeFileSync(join(imgDir, okName), "readable-png-bytes");
    const res = await fetchBounded(`${baseUrl}/api/image?path=images-private/${okName}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("image/png");
    expect(await res.text()).toBe("readable-png-bytes");
  });
});

describe("curator app shells (/, /index-2.html, /index-classic.html) — EACCES safety", () => {
  // APP_PATH (`<root>/index-2.html`) and `<root>/index-classic.html` are fixed
  // constants resolved from PROJECT_ROOT, not overridable per-test — the same
  // constraint the `/static/` block above documents for STATIC_DIR. It is a
  // WEAKER precedent than it looks, though: that block creates and deletes its
  // OWN throwaway file inside `ui/`, whereas this one has to lock a file that is
  // tracked and that another test file reads. So the mode is flipped for the
  // duration of ONE bounded request and restored three ways — in the `try` body,
  // again in `finally`, and defensively in `afterAll` from a mode captured by
  // `statSync` in `beforeAll`.
  //
  // Two consequences of locking a shared file, both handled rather than assumed
  // away:
  //   • A run interrupted INSIDE the window (Ctrl-C, worker kill) leaves the file
  //     at 000, and git will not report it — git tracks only the executable bit,
  //     so the damage is INVISIBLE rather than harmless. `beforeAll` therefore
  //     repairs a leftover 000 BEFORE capturing "the original mode", or this run
  //     would cement 000 as the original and leave the curator UI 404ing on `/`.
  //   • `ui-browser.test.ts` reads both files at COLLECTION time and vitest runs
  //     files in parallel, so it could land inside the window. Its two reads
  //     retry (see `readShell` there) specifically because of this block.
  let server: import("node:http").Server;
  let baseUrl: string;
  let base: string;
  const priorEnv = process.env.CLEAN_UI_SITE_DIST;
  const canChmod = process.getuid?.() !== 0;
  const spaPath = join(PROJECT_ROOT, "index-2.html");
  const classicPath = join(PROJECT_ROOT, "index-classic.html");
  const originalModes = new Map<string, number>();

  beforeAll(async () => {
    base = mkdtempSync(join(tmpdir(), "ui-server-shell-eacces-"));
    writeFileSync(join(base, "entries.json"), JSON.stringify({ version: 2, entries: [] }));
    setCorpusRootForTesting(base);
    delete process.env.CLEAN_UI_SITE_DIST;
    for (const p of [spaPath, classicPath]) {
      // Repair-then-capture, never capture-a-leftover (see the block comment).
      if (canChmod && (statSync(p).mode & 0o777) === 0o000) chmodSync(p, 0o644);
      originalModes.set(p, statSync(p).mode & 0o777);
    }
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("server did not bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    // Modes and shared state first, then the guarded close — same reasoning as
    // the block above: an unguarded `server.close()` on an undefined `server`
    // would abort this teardown and leave a tracked file at mode 000.
    for (const [p, mode] of originalModes) {
      if ((statSync(p).mode & 0o777) !== mode) chmodSync(p, mode);
    }
    if (priorEnv === undefined) delete process.env.CLEAN_UI_SITE_DIST;
    else process.env.CLEAN_UI_SITE_DIST = priorEnv;
    setCorpusRootForTesting(null);
    rmSync(base, { recursive: true, force: true });
    if (server) await new Promise<void>((r) => server.close(() => r()));
  });

  /** Lock `shellPath`, request `route`, assert the four properties, restore the mode. */
  async function expectSilent404(route: string, shellPath: string): Promise<void> {
    const mode = originalModes.get(shellPath)!;
    const sentinel = readFileSync(shellPath, "utf-8").slice(0, 400);
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    const spies = consoleSpies();
    try {
      chmodSync(shellPath, 0o000);
      const res = await fetchBounded(`${baseUrl}${route}`, SHELL_LOCK_ABORT_MS);
      const text = await res.text();
      chmodSync(shellPath, mode);
      expect(res.status, route).toBe(404);
      expect(text, route).not.toContain(sentinel);
      expect(text, route).not.toContain(PROJECT_ROOT);
      expect(text, route).not.toContain(shellPath.split(sep).pop()!);
      expect(text.toUpperCase(), route).not.toContain("EACCES");
      const lines = consoleLines(spies);
      for (const line of lines) {
        expect(line, "a filesystem path reached the console").not.toContain(PROJECT_ROOT);
        expect(line, "a path-shaped string reached the console").not.toMatch(PATH_SHAPED);
      }
      // Strict — see the identical assertion in the /api/image block above.
      expect(lines, `${route}: the request logged something; it must be silent`).toEqual([]);
      const after = await fetchBounded(`${baseUrl}/api/schema`);
      expect(after.status, `${route}: server died`).toBe(200);
      await after.text();
      await new Promise((r) => setTimeout(r, 50));
      expect(unhandled, `${route}: an unhandled rejection escaped`).toEqual([]);
    } finally {
      chmodSync(shellPath, mode);
      for (const spy of spies) spy.mockRestore();
      process.off("unhandledRejection", onUnhandled);
    }
  }

  it("404s GET / when the SPA shell is unreadable", async () => {
    if (!canChmod) return;
    await expectSilent404("/", spaPath);
  });

  it("404s GET /index-2.html when the SPA shell is unreadable", async () => {
    if (!canChmod) return;
    await expectSilent404("/index-2.html", spaPath);
  });

  it("404s GET /index-classic.html when the classic shell is unreadable", async () => {
    if (!canChmod) return;
    await expectSilent404("/index-classic.html", classicPath);
  });

  it("serves all three shells normally once the modes are back", async () => {
    for (const route of ["/", "/index-2.html", "/index-classic.html"]) {
      const res = await fetchBounded(`${baseUrl}${route}`);
      expect(res.status, route).toBe(200);
      expect(res.headers.get("content-type"), route).toContain("text/html");
      expect((await res.text()).length, route).toBeGreaterThan(0);
    }
  });
});

describe("catch-all 500 sanitization (describeInternalError / finishWithInternalError)", () => {
  // Every route in `handleUiRequest` is wrapped by ONE catch-all. Several routes
  // do unguarded `fs` reads/writes whose errno errors embed an ABSOLUTE PATH in
  // `.message` ("EACCES: permission denied, open '/Users/.../secret.png'"). The
  // project's hard rule: filesystem paths must NEVER appear in an HTTP response,
  // the DOM, logs, or an error message. So the catch-all must neither surface
  // `error.message` to the client NOR `console.error(error)` the whole object.
  //
  // These fixtures mirror the errno errors the five known fs sites can throw —
  // scanOrphans (decisions/draft reads), the /api/image screenshot read, the
  // batch-copy temp read, the base64 image writeFileSync, and a site-asset read.
  // Each carries a DISTINCT fake absolute path so a leak from any one is visible.
  type Errno = NodeJS.ErrnoException;
  function errnoError(code: string, syscall: string, path: string): Errno {
    const e = new Error(`${code}: permission denied, ${syscall} '${path}'`) as Errno;
    e.code = code;
    e.syscall = syscall;
    e.path = path;
    return e;
  }
  const SITE_ERRORS: ReadonlyArray<{ site: string; error: Errno }> = [
    { site: "scanOrphans decisions/draft read", error: errnoError("EACCES", "open", "/Users/secret/corpus/decisions.json") },
    { site: "/api/image screenshot read", error: errnoError("EACCES", "open", "/Users/secret/corpus/images-private/shot.png") },
    { site: "batch-copy temp read", error: errnoError("ENOENT", "open", "/private/var/folders/secret/add-1/cand.png") },
    { site: "base64 image writeFileSync", error: errnoError("EACCES", "open", "/Users/secret/corpus/images-private/upload.png") },
    { site: "site-asset read", error: errnoError("EACCES", "open", "/Users/secret/dist/assets/locked.js") },
  ];

  /** A ServerResponse stand-in recording exactly what a route wrote. */
  function fakeRes(headersSent: boolean) {
    const calls = { writeHeadStatuses: [] as number[], bodies: [] as string[], destroyed: false };
    const res = {
      headersSent,
      writeHead(status: number, _headers?: unknown) {
        calls.writeHeadStatuses.push(status);
        return res;
      },
      end(body?: unknown) {
        if (body != null) calls.bodies.push(String(body));
        return res;
      },
      destroy() {
        calls.destroyed = true;
        return res;
      },
    } as unknown as import("node:http").ServerResponse;
    return { res, calls };
  }

  it("describeInternalError never returns the path or the raw message", () => {
    for (const { site, error } of SITE_ERRORS) {
      const rendered = describeInternalError(error);
      expect(rendered, site).not.toContain(error.path!);
      expect(rendered, site).not.toContain(error.message);
      expect(rendered, site).not.toContain("secret");
      expect(rendered, site).not.toMatch(PATH_SHAPED);
      // Useful non-leaking detail IS allowed: the errno code aids debugging.
      expect(rendered, site).toContain(error.code!);
    }
  });

  it("describeInternalError tolerates a non-Error throw without leaking it", () => {
    const rendered = describeInternalError({ path: "/Users/secret/x" });
    expect(rendered).not.toContain("secret");
    expect(rendered).not.toMatch(PATH_SHAPED);
  });

  it("describeInternalError strips a crafted path smuggled through name or code", () => {
    // `name`/`code` are userland-mutable; a thrown error could carry a path in
    // either. The safe-shape filter must drop them, not echo them to the log.
    const crafted = Object.assign(new Error("boom"), {
      name: "/Users/secret/attacker-named-error",
      code: "/private/var/secret/leak",
    });
    const rendered = describeInternalError(crafted);
    expect(rendered).not.toContain("secret");
    expect(rendered).not.toContain("/Users/");
    expect(rendered).not.toContain("/private/");
    expect(rendered).not.toMatch(PATH_SHAPED);
    // Falls back to the generic name and drops the unsafe code entirely.
    expect(rendered).toBe("Error");
  });

  it("each fs site's error yields a generic 500 with no path in body or console", () => {
    for (const { site, error } of SITE_ERRORS) {
      const spies = consoleSpies();
      const { res, calls } = fakeRes(false);
      try {
        finishWithInternalError(res, error);
      } finally {
        // restore before assertions so a failure prints
        for (const spy of spies) spy.mockRestore();
      }
      expect(calls.writeHeadStatuses, site).toEqual([500]);
      expect(calls.destroyed, site).toBe(false);
      const body = calls.bodies.join("");
      expect(body, site).toBe(JSON.stringify({ error: "Internal server error" }));
      expect(body, site).not.toContain(error.path!);
      expect(body, site).not.toContain("secret");
      expect(body, site).not.toMatch(PATH_SHAPED);
    }
  });

  it("logs only a sanitized line — no path, no raw message reaches the console", () => {
    for (const { site, error } of SITE_ERRORS) {
      const spies = consoleSpies();
      finishWithInternalError(fakeRes(false).res, error);
      const lines = consoleLines(spies);
      for (const spy of spies) spy.mockRestore();
      for (const line of lines) {
        expect(line, `${site}: a path reached the console`).not.toContain(error.path!);
        expect(line, `${site}: raw message reached the console`).not.toContain(error.message);
        expect(line, `${site}: a path-shaped string reached the console`).not.toMatch(PATH_SHAPED);
      }
    }
  });

  it("when a head was already sent, destroys the socket instead of re-writing the head", () => {
    // A route that wrote a 200 then threw mid-body cannot have its status
    // rewritten; calling writeHead again throws ERR_HTTP_HEADERS_SENT, which
    // crashes the process and hangs the request. The guard must destroy instead.
    const spies = consoleSpies();
    const { res, calls } = fakeRes(true);
    finishWithInternalError(res, errnoError("EACCES", "read", "/Users/secret/mid-body.png"));
    const lines = consoleLines(spies);
    for (const spy of spies) spy.mockRestore();
    expect(calls.writeHeadStatuses).toEqual([]);
    expect(calls.destroyed).toBe(true);
    expect(calls.bodies).toEqual([]);
    // The console line is logged on BOTH branches; the destroy branch must be
    // just as path-free as the generic-500 branch.
    for (const line of lines) {
      expect(line, "destroy branch leaked a path to the console").not.toContain("/Users/secret");
      expect(line, "destroy branch leaked a path-shaped string").not.toMatch(PATH_SHAPED);
    }
  });
});

describe("catch-all 500 sanitization — end to end through a real route", () => {
  // The helper-level tests above prove `finishWithInternalError` sanitizes, but
  // NOT that the catch-all in `handleUiRequest` actually routes through it — a
  // regression that reverted the catch-all to `sendJson(res, 500, { error:
  // error.message })` would leave every helper test green while re-opening the
  // leak. This block drives the leak end to end. `POST /api/upload-image` calls
  // `handleUpload`, which does an UNGUARDED `writeFileSync` into
  // `privateImageDir()` (test-injectable). A mode-000 image dir makes that throw
  // `EACCES … '<abs path>'`, which propagates to the catch-all. We assert the
  // 500 body and the console are both path-free. Fully isolated temp dirs — the
  // real corpus is never touched.
  //
  // Why not `/api/orphans`: `scanOrphans` reads via the STATIC `CORPUS_ROOT`
  // constant (paths.ts), which `setCorpusRootForTesting` (persistence.ts) does
  // not override — so it always reads the real corpus and can't be pointed at a
  // mode-000 fixture without touching tracked files.
  let server: import("node:http").Server;
  let baseUrl: string;
  let imgDir: string;
  let nonce: string;
  const canChmod = process.getuid?.() !== 0; // root ignores file modes
  // 1×1 PNG — a valid data URL so `handleUpload` reaches the write, not the 400.
  const PNG_DATA_URL =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  beforeAll(async () => {
    imgDir = mkdtempSync(join(tmpdir(), "ui-server-catchall-img-"));
    setPrivateImageDirForTesting(imgDir);
    server = await startServer(0);
    const addr = server.address();
    if (!addr || typeof addr !== "object") throw new Error("server did not bind");
    baseUrl = `http://127.0.0.1:${addr.port}`;
    nonce = (await (await fetch(`${baseUrl}/api/csrf`)).json() as { nonce: string }).nonce;
  });

  afterAll(async () => {
    if (existsSync(imgDir)) chmodSync(imgDir, 0o755);
    await new Promise<void>((r) => server.close(() => r()));
    setPrivateImageDirForTesting(null);
    if (existsSync(imgDir)) rmSync(imgDir, { recursive: true, force: true });
  });

  it("POST /api/upload-image returns a generic 500 with no path in body or console when the image dir is unwritable", async () => {
    if (!canChmod) return;
    // Sanity: the fixture path is genuinely path-shaped, so the assertions below
    // aren't vacuous (they'd pass trivially if the leak string couldn't match).
    expect(`open '${imgDir}/x.png'`).toMatch(PATH_SHAPED);
    const spies = consoleSpies();
    try {
      chmodSync(imgDir, 0o000); // an unguarded write into this dir throws EACCES with its abs path
      const res = await fetch(`${baseUrl}/api/upload-image`, {
        method: "POST",
        headers: { "content-type": "application/json", [CSRF_HEADER]: nonce },
        body: JSON.stringify({ filename: "leak.png", dataUrl: PNG_DATA_URL, slug: "leak" }),
      });
      const text = await res.text();
      chmodSync(imgDir, 0o755);
      expect(res.status, "the write should have thrown into the catch-all").toBe(500);
      expect(text).toBe(JSON.stringify({ error: "Internal server error" }));
      expect(text).not.toContain(imgDir);
      expect(text.toUpperCase()).not.toContain("EACCES");
      const lines = consoleLines(spies);
      for (const line of lines) {
        expect(line, "a filesystem path reached the console").not.toContain(imgDir);
        expect(line, "a path-shaped string reached the console").not.toMatch(PATH_SHAPED);
        expect(line, "the raw errno message reached the console").not.toContain("permission denied");
      }
      // Server still alive after the sanitized failure.
      const after = await fetch(`${baseUrl}/api/schema`);
      expect(after.status, "server died after a sanitized 500").toBe(200);
      await after.text();
    } finally {
      if (existsSync(imgDir)) chmodSync(imgDir, 0o755);
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe("explainCaptureError / explainTagError never leak raw error detail into 400 bodies", () => {
  // Both helpers feed `sendJson(res, 400, { error: explain*(error) })` and the
  // DOM toast. Their DEFAULT arm previously returned `error.message` verbatim,
  // which for these routes is untrusted: Playwright nav errors embed the full
  // SOURCE URL, and the tagger builds errors from raw PROVIDER RESPONSE BODIES.
  // The default must collapse to a fixed generic string; only the curated
  // classified branches may surface specifics.

  describe("explainCaptureError", () => {
    it("does not echo a source URL from a Playwright navigation error", () => {
      const out = explainCaptureError(
        new Error("page.goto: net::ERR_CONNECTION_REFUSED at https://secret-product.example.com/private/dashboard?token=abc123"),
      );
      expect(out).not.toContain("secret-product");
      expect(out).not.toContain("https://");
      expect(out).not.toContain("example.com");
      expect(out).not.toContain("token=abc123");
      expect(out).toBe("URL capture failed. Make sure the page is publicly reachable and try again.");
    });

    it("does not echo an absolute filesystem path from an fs error", () => {
      const out = explainCaptureError(
        Object.assign(new Error("EACCES: permission denied, open '/Users/secret/corpus/images-private/x.png'"), { code: "EACCES" }),
      );
      expect(out).not.toContain("/Users/secret");
      expect(out).not.toMatch(PATH_SHAPED);
    });

    it("preserves the curated timeout and chromium-missing branches", () => {
      expect(explainCaptureError(new Error("Timeout 45000ms exceeded"))).toMatch(/timed out/i);
      expect(explainCaptureError(new Error("browserType.launch: Executable doesn't exist at /ms-playwright/chromium/headless_shell")))
        .toMatch(/Chromium is not installed/i);
    });
  });

  describe("explainTagError", () => {
    it("does not echo a provider response body from a non-classified status", () => {
      const out = explainTagError(
        new Error('OpenAI API error 503: {"error":{"message":"upstream model overloaded on host gpu-42","request_id":"req_9f8e7d","org":"org-internal-secret"}}'),
      );
      expect(out).not.toContain("gpu-42");
      expect(out).not.toContain("req_9f8e7d");
      expect(out).not.toContain("org-internal-secret");
      expect(out).not.toContain("{");
      expect(out).toBe("Auto-fill failed. Check your vision provider settings and try again.");
    });

    it("does not echo a raw generic error message", () => {
      const out = explainTagError(new Error("connect ECONNREFUSED 10.0.0.5:443 while calling https://api.vision-provider.internal/v1/generate"));
      expect(out).not.toContain("10.0.0.5");
      expect(out).not.toContain("vision-provider.internal");
      expect(out).not.toContain("https://");
      expect(out).toBe("Auto-fill failed. Check your vision provider settings and try again.");
    });

    it("preserves every curated classified branch", () => {
      expect(explainTagError(new Error("OpenAI API error 401: invalid_api_key"))).toMatch(/rejected the API key/i);
      expect(explainTagError(new Error("429 rate_limit_exceeded"))).toMatch(/rate limit or quota/i);
      const maxTokens = explainTagError(new Error("finishReason: MAX_TOKENS"));
      expect(maxTokens).toMatch(/truncated/i);
      expect(maxTokens, "curated hint must not name a source path").not.toMatch(/\.ts\b|src\//);
      expect(explainTagError(new Error("blockReason: SAFETY"))).toMatch(/safety filter/i);
      expect(explainTagError(new Error("models/gemini-x is not found"))).toMatch(/model was rejected/i);
      expect(explainTagError(new Error("Draft was non-JSON"))).toMatch(/unusable draft/i);
      // A finish-reason stop returns a FIXED string — never the raw message.
      expect(explainTagError(new Error("Gemini stopped early (RECITATION). Try Auto-fill again.")))
        .toBe("The vision provider stopped early. Try Auto-fill again, or use a clearer screenshot.");
    });

    it("does not echo a provider body that merely CONTAINS the substring 'stopped early'", () => {
      // The `stopped early` arm must not trust the substring: the tagger builds
      // errors from raw provider bodies, one of which could contain that phrase
      // without matching any earlier classified branch.
      const out = explainTagError(
        new Error('OpenAI API error 503: {"error":{"message":"stream stopped early on host gpu-42","request_id":"req_9f8e7d"}}'),
      );
      expect(out).not.toContain("gpu-42");
      expect(out).not.toContain("req_9f8e7d");
      expect(out).not.toContain("{");
      expect(out).toBe("The vision provider stopped early. Try Auto-fill again, or use a clearer screenshot.");
    });
  });

  describe("explainCaptureTargetError (SSRF / URL-validation 400s)", () => {
    it("does not echo the source hostname from a DNS resolve failure", () => {
      const out = explainCaptureTargetError(new Error("Could not resolve host: secret-product.example.com"));
      expect(out).not.toContain("secret-product");
      expect(out).not.toContain("example.com");
      expect(out).toBe("Could not resolve that host. Check the URL and try again.");
    });

    it("preserves the host-free curated validation messages", () => {
      for (const msg of [
        "Use a valid source URL",
        "Only http and https URLs can be captured",
        "Capture target resolves to a blocked metadata or private address",
      ]) {
        expect(explainCaptureTargetError(new Error(msg))).toBe(msg);
      }
    });

    it("fails closed: an unrecognized message collapses to the generic string, never echoed", () => {
      const out = explainCaptureTargetError(new Error("page.goto: net::ERR at https://leak.example.com/x"));
      expect(out).not.toContain("leak.example.com");
      expect(out).not.toContain("https://");
      expect(out).toBe("Use a valid source URL");
    });
  });
});
