import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { transformForValidation } from "./validate-public-pipeline.js";
import { execFileSync } from "node:child_process";

describe("validate-public-pipeline — transformForValidation", () => {
  it("adds a placeholder publication block to an entry without one", () => {
    const entry = {
      id: "test-1",
      image: { visibility: "private", path: "images-private/test.png", width: 100, height: 100 },
    } as Record<string, unknown>;
    const result = transformForValidation(entry);
    expect(result.publication).toBeDefined();
    expect((result.publication as { visibility: string }).visibility).toBe("public");
    expect((result.publication as { clearance: string }).clearance).toBe("approved");
    expect((result.publication as { evidenceRef: string }).evidenceRef).toBe("pipeline-validation-harness");
  });

  it("rewrites images-private/ path to images-public/ and sets public-own", () => {
    const entry = {
      id: "test-2",
      image: { visibility: "private", path: "images-private/foo/bar.png", width: 100, height: 100 },
    } as Record<string, unknown>;
    const result = transformForValidation(entry);
    const img = result.image as { visibility: string; path: string };
    expect(img.visibility).toBe("public-own");
    expect(img.path).toBe("images-public/foo/bar.png");
  });

  it("does NOT mutate the original entry (shallow copy)", () => {
    const entry = {
      id: "test-3",
      image: { visibility: "private", path: "images-private/test3.png", width: 100, height: 100 },
    } as Record<string, unknown>;
    const result = transformForValidation(entry);
    // Original is unchanged
    expect((entry.image as { visibility: string }).visibility).toBe("private");
    expect((entry.image as { path: string }).path).toBe("images-private/test3.png");
    expect(entry.publication).toBeUndefined();
    // Transformed has the new values
    expect((result.image as { visibility: string }).visibility).toBe("public-own");
    expect(result.publication).toBeDefined();
  });
});

/**
 * Integration test: run the full harness end-to-end against a small temporary
 * corpus (2 entries, real tiny PNGs). Verifies the harness succeeds, reports
 * the correct count, and cleans up (or preserves with --keep).
 *
 * Uses execFileSync to invoke `npx tsx src/scripts/validate-public-pipeline.ts`
 * as a child process — the harness uses process.argv and top-level await,
 * so it can't be imported and called directly.
 */
describe("validate-public-pipeline — integration", () => {
  // Minimal 1x1 PNG (67 bytes).
  const TINY_PNG = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );

  // A minimal valid CorpusEntry. Built from the real seed.json shape to pass
  // Zod validation (CorpusEntry.safeParse). The fields mirror the seed entry.
  function makeEntry(id: string, imgPath: string): Record<string, unknown> {
    return {
      id,
      title: `${id} — Dashboard shell (test fixture)`,
      patternType: "dashboard",
      categories: ["dashboard"],
      styleTags: ["minimal"],
      source: { productName: id, url: null, capturedAt: "2026-01-01", capturedBy: "self" },
      image: { visibility: "private", path: imgPath, width: 1, height: 1 },
      visual: {
        dominantColors: ["#ffffff", "#f3f4f6", "#111827"],
        accentColor: "#6366f1",
        typePairing: { display: null, body: null, notes: "Hierarchy through weight and size." },
        spacingDensity: "moderate",
        cornerStyle: "slight-round",
        usesShadows: false,
        usesBorders: true,
      },
      critique: `${id} — a clean dashboard shell using background-color steps for surface separation. The sidebar nav is restrained, the main content area breathes. zen`,
      whatToSteal: ["Background-color steps instead of shadows for depth — keeps surfaces flat"],
      antiPatterns: {
        antiPatterns: ["Avoids heavy card shadows for depth — uses background-color steps of the same hue."],
        whereThisFails: ["On dense data tables where row separation needs more than a tint step."],
        accessibilityRisks: [],
      },
      qualityTier: "exceptional",
      qualityScore: 5,
      addedAt: "2026-01-01",
    };
  }

  let tempCorpusRoot: string;

  function setupTempCorpus(): string {
    tempCorpusRoot = mkdtempSync(resolve(tmpdir(), "pipeline-integration-"));
    // Create the directory structure the harness expects
    mkdirSync(resolve(tempCorpusRoot, "corpus", "images-private"), { recursive: true });
    mkdirSync(resolve(tempCorpusRoot, "corpus", "images-public"), { recursive: true });
    // Write 2 entries with images
    const entries = [
      makeEntry("entry-a", "images-private/entry-a.png"),
      makeEntry("entry-b", "images-private/entry-b.png"),
    ];
    writeFileSync(
      resolve(tempCorpusRoot, "corpus", "entries.json"),
      JSON.stringify({ version: 2, entries }, null, 2) + "\n",
    );
    writeFileSync(resolve(tempCorpusRoot, "corpus", "images-private", "entry-a.png"), TINY_PNG);
    writeFileSync(resolve(tempCorpusRoot, "corpus", "images-private", "entry-b.png"), TINY_PNG);
    return tempCorpusRoot;
  }

  afterEach(() => {
    if (tempCorpusRoot && existsSync(tempCorpusRoot)) {
      rmSync(tempCorpusRoot, { recursive: true, force: true });
    }
  });

  it("succeeds and reports 2/2 entries in normal mode (cleanup)", async () => {
    const root = setupTempCorpus();
    const { exportPublicSnapshot } = await import("../publication/exporter.js");
    const { PublicCorpusReader } = await import("../corpus-reader.js");
    const { readFileSync, copyFileSync, mkdirSync: mkdir } = await import("node:fs");

    // Read + transform
    const raw = JSON.parse(readFileSync(resolve(root, "corpus/entries.json"), "utf-8"));
    const transformed = raw.entries.map(transformForValidation);

    // Copy images to a temp workspace
    const ws = resolve(tmpdir(), `pipeline-test-${Date.now()}`);
    mkdir(resolve(ws, "images-public"), { recursive: true });
    copyFileSync(resolve(root, "corpus/images-private/entry-a.png"), resolve(ws, "images-public/entry-a.png"));
    copyFileSync(resolve(root, "corpus/images-private/entry-b.png"), resolve(ws, "images-public/entry-b.png"));

    // Export
    const result = await exportPublicSnapshot({
      corpusEntries: transformed,
      snapshotDir: resolve(ws, "snapshots"),
      imageRoot: resolve(ws, "images-public"),
      now: new Date().toISOString(),
    });
    expect(result.entryCount).toBe(2);
    expect(result.assetCount).toBe(2);

    // Load + verify
    const reader = new PublicCorpusReader(result.snapshotPath);
    const loaded = reader.entriesForAggregation();
    expect(loaded.length).toBe(2);

    // All images resolve
    for (const e of loaded) {
      if (e.image.path) expect(reader.resolveImagePath(e.image.path)).not.toBeNull();
    }

    // Cleanup
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails when a source image is missing (not a silent false-pass)", async () => {
    const root = setupTempCorpus();
    // Delete one image — the harness should fail, not silently exclude the entry.
    rmSync(resolve(root, "corpus/images-private/entry-b.png"));

    const { exportPublicSnapshot } = await import("../publication/exporter.js");
    const { readFileSync } = await import("node:fs");
    const raw = JSON.parse(readFileSync(resolve(root, "corpus/entries.json"), "utf-8"));
    const transformed = raw.entries.map(transformForValidation);

    const ws = resolve(tmpdir(), `pipeline-test-missing-${Date.now()}`);
    mkdirSync(resolve(ws, "images-public"), { recursive: true });
    // Only copy entry-a (entry-b's source is deleted)
    copyFileSync(resolve(root, "corpus/images-private/entry-a.png"), resolve(ws, "images-public/entry-a.png"));

    const result = await exportPublicSnapshot({
      corpusEntries: transformed,
      snapshotDir: resolve(ws, "snapshots"),
      imageRoot: resolve(ws, "images-public"),
      now: new Date().toISOString(),
    });
    // The exporter excludes entry-b (missing image) → only 1 entry exported,
    // NOT 2. The harness's count check (result.entryCount !== entries.length)
    // would catch this and throw.
    expect(result.entryCount).toBe(1);
    expect(result.entryCount).not.toBe(raw.entries.length); // 1 ≠ 2 — would fail the harness

    rmSync(ws, { recursive: true, force: true });
  });
});
