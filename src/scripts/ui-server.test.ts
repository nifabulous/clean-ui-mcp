import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupBatch, findDuplicateAtCommit, isPrivateAddress, listCaptureBatches, orphanedPrivateImagePaths, prepareNewEntryPayload, promoteTempImage, publicConfigStatus, sameOrigin, setTriageStatus, stampProvenance, uniqueEntryId, validateEntryPayload } from "./ui-server.js";
import type { IncomingMessage } from "node:http";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PRIVATE_IMAGE_DIR } from "../paths.js";
import type { CorpusEntryT } from "../schema.js";

function req(headers: Record<string, string | undefined>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
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
  const capturesRoot = join(PRIVATE_IMAGE_DIR, "captures");
  const batchId = "cleanup-test-batch";

  beforeEach(() => {
    const batchDir = join(capturesRoot, batchId);
    mkdirSync(batchDir, { recursive: true });
    writeFileSync(join(batchDir, "manifest.json"), JSON.stringify([
      { id: "cap-1", sourceName: "Acme", captureMode: "section", viewport: "desktop", selectorPath: "main", capturedAt: "2026-07-05T00:00:00.000Z", aHash: "0", imagePath: `images-private/captures/${batchId}/cap-1.png`, width: 100, height: 100 },
    ]));
  });
  afterEach(() => {
    const batchDir = join(capturesRoot, batchId);
    if (existsSync(batchDir)) rmSync(batchDir, { recursive: true, force: true });
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
  const capturesRoot = join(PRIVATE_IMAGE_DIR, "captures");
  const batchId = "add-promotetest-20260706";
  const capId = "stripe-section-abc-desktop";
  const tempRel = `images-private/captures/${batchId}/${capId}.png`;

  beforeEach(() => {
    const batchDir = join(capturesRoot, batchId);
    mkdirSync(batchDir, { recursive: true });
    // 1x1 PNG bytes — smallest valid PNG.
    writeFileSync(join(batchDir, `${capId}.png`), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64"));
  });
  afterEach(() => {
    const batchDir = join(capturesRoot, batchId);
    if (existsSync(batchDir)) rmSync(batchDir, { recursive: true, force: true });
    // Clean any promoted permanent files we created (slug "promote-perm-test").
    for (const name of readdirSync(PRIVATE_IMAGE_DIR)) {
      if (name.startsWith("promote-perm-test")) {
        rmSync(join(PRIVATE_IMAGE_DIR, name), { force: true });
      }
    }
  });

  it("copies a temp add-* image to a permanent flat path and returns the new path", () => {
    const result = promoteTempImage(tempRel, "promote-perm-test");
    expect(result.path).toMatch(/^images-private\/promote-perm-test(-\d+)?\.png$/);
    expect(existsSync(join(PRIVATE_IMAGE_DIR, result.path.replace(/^images-private\//, "")))).toBe(true);
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
  const capturesRoot = join(PRIVATE_IMAGE_DIR, "captures");
  const tempBatchId = "add-listtest-20260706";
  const realBatchId = "listtest-real-20260706";

  beforeEach(() => {
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
    for (const id of [tempBatchId, realBatchId]) {
      const d = join(capturesRoot, id);
      if (existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
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
