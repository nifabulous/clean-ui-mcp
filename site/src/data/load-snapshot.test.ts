import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPublicSnapshot } from "./load-snapshot";
import { parsePublicEntry, parsePublicSnapshot } from "./public-entry";
import type { PublicSnapshotInput } from "./public-entry";

// Vite replaces import.meta.env.BASE_URL statically; in vitest it resolves to
// "/". The parser and loader read the same value, so we compute the expected
// base prefix once and reuse it across assertions.
const BASE_URL = import.meta.env.BASE_URL;
function entriesPrefix(): string {
  return `${BASE_URL.endsWith("/") ? BASE_URL : `${BASE_URL}/`}entries/`;
}

// Canonical fixture used across the suite. Mirrors the actual snapshot entry
// shape described in the plan (imagePath is a public-safe basename like
// "sample-5.png").
function baseFixture(): Record<string, unknown> {
  return {
    id: "sample",
    title: "Origin",
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal", "editorial"],
    qualityTier: "exceptional",
    qualityScore: 3,
    critique: "The left sidebar pairs a 12px icon above each label.",
    whatToSteal: ["Place a 12px icon above each navigation label."],
    antiPatterns: ["Avoids using multiple accent colors across chart series."],
    dominantColors: ["#384c67", "#2ba0f5"],
    colorRoles: { canvas: "#a8b4cf", surface: "#5573ac", ink: "#384c67" },
    accent: "#2ba0f5",
    critiqueExcerpt: "Short critique.",
    steal: ["Steal one."],
    avoid: ["Avoid one."],
    imagePath: "sample-5.png",
    source: { productName: "Origin", url: "https://example.com/origin" },
  };
}

function snapshotWith(entries: Array<Record<string, unknown>>): PublicSnapshotInput {
  return {
    count: entries.length,
    generatedAt: "2026-07-18T00:00:00.000Z",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    entries,
  };
}

describe("parsePublicEntry", () => {
  it("adapts a valid row to the narrow public shape", () => {
    const entry = parsePublicEntry(baseFixture());
    expect(entry.id).toBe("sample");
    expect(entry.title).toBe("Origin");
    expect(entry.patternType).toBe("dashboard");
    expect(entry.categories).toEqual(["dashboard"]);
    expect(entry.styleTags).toEqual(["minimal", "editorial"]);
    expect(entry.qualityTier).toBe("exceptional");
    expect(entry.qualityScore).toBe(3);
    expect(entry.source).toEqual({ productName: "Origin", url: "https://example.com/origin" });
    // imagePath is mapped to the public base URL only after safe-path validation.
    expect(entry.imageUrl).toBe(`${entriesPrefix()}sample-5.png`);
  });

  it("does not mutate the source row", () => {
    const input = baseFixture();
    const snapshot = { ...input };
    parsePublicEntry(input);
    expect(input).toEqual(snapshot);
  });

  it("rejects rows missing a required string field", () => {
    const malformed = baseFixture();
    delete (malformed as Record<string, unknown>).title;
    expect(() => parsePublicEntry(malformed)).toThrow();
  });

  it("rejects rows with the wrong type for a required field", () => {
    const malformed = baseFixture();
    (malformed as Record<string, unknown>).qualityScore = "high";
    expect(() => parsePublicEntry(malformed)).toThrow();
  });

  it("rejects rows where categories is not an array of strings", () => {
    const malformed = baseFixture();
    (malformed as Record<string, unknown>).categories = "dashboard";
    expect(() => parsePublicEntry(malformed)).toThrow();
  });

  it("rejects private image paths", () => {
    const malformed = baseFixture();
    (malformed as Record<string, unknown>).imagePath = "images-private/x.png";
    expect(() => parsePublicEntry(malformed)).toThrow(/safe public image path/i);
  });

  it("rejects absolute paths", () => {
    const malformed = baseFixture();
    (malformed as Record<string, unknown>).imagePath = "/etc/passwd";
    expect(() => parsePublicEntry(malformed)).toThrow(/safe public image path/i);
  });

  it("rejects parent-directory traversal", () => {
    const malformed = baseFixture();
    (malformed as Record<string, unknown>).imagePath = "../secret.png";
    expect(() => parsePublicEntry(malformed)).toThrow(/safe public image path/i);
  });

  it("rejects URL schemes", () => {
    const malformed = baseFixture();
    (malformed as Record<string, unknown>).imagePath = "http://evil.example/x.png";
    expect(() => parsePublicEntry(malformed)).toThrow(/safe public image path/i);
  });

  it("rejects file: URL schemes", () => {
    const malformed = baseFixture();
    (malformed as Record<string, unknown>).imagePath = "file:///etc/passwd";
    expect(() => parsePublicEntry(malformed)).toThrow(/safe public image path/i);
  });

  it("rejects empty image paths", () => {
    const malformed = baseFixture();
    (malformed as Record<string, unknown>).imagePath = "";
    expect(() => parsePublicEntry(malformed)).toThrow(/safe public image path/i);
  });

  it("rejects paths containing a query or fragment", () => {
    const withQuery = baseFixture();
    (withQuery as Record<string, unknown>).imagePath = "sample.png?steal=1";
    expect(() => parsePublicEntry(withQuery)).toThrow(/safe public image path/i);

    const withFragment = baseFixture();
    (withFragment as Record<string, unknown>).imagePath = "sample.png#x";
    expect(() => parsePublicEntry(withFragment)).toThrow(/safe public image path/i);
  });
});

describe("parsePublicSnapshot", () => {
  it("adapts a full snapshot and preserves filter facets", () => {
    const snap = parsePublicSnapshot(snapshotWith([baseFixture()]));
    expect(snap.count).toBe(1);
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0].id).toBe("sample");
    expect(snap.categories).toEqual(["dashboard"]);
    expect(snap.styleTags).toEqual(["minimal"]);
  });

  it("rejects when count does not match entries.length", () => {
    const input = snapshotWith([baseFixture()]);
    input.count = 99;
    expect(() => parsePublicSnapshot(input)).toThrow();
  });

  it("rejects when a single row fails parser validation", () => {
    const bad = baseFixture();
    (bad as Record<string, unknown>).imagePath = "images-private/x.png";
    expect(() => parsePublicSnapshot(snapshotWith([baseFixture(), bad]))).toThrow(
      /safe public image path/i,
    );
  });
});

describe("loadPublicSnapshot", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No BASE_URL stubbing: Vite statically replaces import.meta.env.BASE_URL,
    // so the loader reads whatever value vitest resolves (here, "/"). We
    // assert against that same value below.
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetchOk(payload: unknown): void {
    globalThis.fetch = vi.fn(
      async (): Promise<Response> =>
        ({
          ok: true,
          status: 200,
          json: async () => payload,
        }) as Response,
    );
  }

  it("fetches the snapshot, validates count, and adapts entries", async () => {
    mockFetchOk(snapshotWith([baseFixture()]));
    const snap = await loadPublicSnapshot();
    expect(snap.entries).toHaveLength(1);
    expect(snap.entries[0].imageUrl).toBe(`${entriesPrefix()}sample-5.png`);
    const expectedFetchUrl = `${BASE_URL.endsWith("/") ? BASE_URL : `${BASE_URL}/`}snapshot.json`;
    expect(globalThis.fetch).toHaveBeenCalledWith(expectedFetchUrl);
  });

  it("throws when the network response is not ok", async () => {
    globalThis.fetch = vi.fn(
      async (): Promise<Response> =>
        ({ ok: false, status: 500, statusText: "Server Error" }) as Response,
    );
    await expect(loadPublicSnapshot()).rejects.toThrow();
  });

  it("throws when the payload count disagrees with entries", async () => {
    const payload = snapshotWith([baseFixture()]);
    payload.count = 7;
    mockFetchOk(payload);
    await expect(loadPublicSnapshot()).rejects.toThrow();
  });
});
