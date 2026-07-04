import { describe, expect, it } from "vitest";
import { isPrivateAddress, orphanedPrivateImagePaths, prepareNewEntryPayload, publicConfigStatus, sameOrigin, uniqueEntryId, validateEntryPayload } from "./ui-server.js";
import type { IncomingMessage } from "node:http";
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

    // public addresses are not flagged
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("1.1.1.1")).toBe(false);
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

  it("accepts a clean entry with no markers anywhere", () => {
    expect(() => validateEntryPayload(baseEntry)).not.toThrow();
  });
});
