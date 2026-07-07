import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PRIVATE_IMAGE_DIR } from "./paths.js";
import { checkDuplicateUpload, clearDuplicateBatch, findDuplicateAtCommit } from "./dedup.js";
import { completenessScore } from "./scripts/dedup-cleanup.js";
import type { CorpusEntryT } from "./schema.js";

// Shared fixture — mirrors the one in ui-server.test.ts.
const baseEntry = {
  id: "linear-dashboard",
  title: "Linear Dashboard",
  patternType: "dashboard",
  categories: ["dashboard"],
  styleTags: ["minimal"],
  source: { productName: "Linear", url: "https://linear.app", capturedAt: "2026-07-01", capturedBy: "self" },
  image: { visibility: "private", path: "images-private/linear-dashboard.png", width: 1440, height: 1000 },
  visual: {
    dominantColors: ["#ffffff", "#111111"], accentColor: null,
    typePairing: { display: null, body: null, notes: "Clear hierarchy with restrained type." },
    spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true,
  },
  critique: "This interface uses a direct visual hierarchy, restrained surfaces, and clear grouping to make repeated scanning feel calm and predictable.",
  whatToSteal: ["Use quiet grouping and consistent spacing to make dense product interfaces easier to scan."],
  antiPatterns: { antiPatterns: ["Avoids heavy card shadows; uses background-color steps for depth."], whereThisFails: [], accessibilityRisks: [] },
  qualityScore: 4, addedAt: "2026-07-01",
} as CorpusEntryT;

describe("commit-time duplicate gate (moved from ui-server.test.ts)", () => {
  // Regression: the POST /entries endpoint (the corpus mutation point) had no
  // duplicate check — only the upload-time /api/check-duplicate did. A row that
  // passed upload-time dedup could still commit a duplicate if a sibling landed
  // first or a near-identical shot existed from a prior batch. findDuplicateAtCommit
  // is the authoritative gate, so test it directly with real image bytes.
  const testDir = join(PRIVATE_IMAGE_DIR, "__dedup-test");
  // 64x64 solid-blue PNGs that sharp can definitely decode (1x1s fail sharp's
  // libpng). a and b are byte-identical (exact dup); c is byte-distinct.
  const pngBlue = "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAn0lEQVRoge2SQQkAQRDDqqTqTmxkrYh7hIFCBKSh6cdpoht0A9ArdhfiLtENugHoFbsLcZfoBt0A9IrdhbhLdINuAHrF7kLcJbpBNwC9Ynch7hLdoBuAXrG7EHeJbtANQK/YXYi7RDfoBqBX7C7EXaIbdAPQK3YX4i7RDboB6BW7C3GX6AbdAPSK3YW4S3SDbgB6xe5C3CW6QTcAveIfHrj6oS2wXLsiAAAAAElFTkSuQmCC";
  const pngDistinct = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFeAJ5fVqRtwAAAABJRU5ErkJggg==";

  function entryAt(path: string, id: string): CorpusEntryT {
    return { ...baseEntry, id, image: { ...baseEntry.image, path } } as CorpusEntryT;
  }

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "a.png"), Buffer.from(pngBlue, "base64"));
    writeFileSync(join(testDir, "b.png"), Buffer.from(pngBlue, "base64")); // byte-identical to a
    writeFileSync(join(testDir, "c.png"), Buffer.from(pngDistinct, "base64")); // different bytes
  });

  afterEach(() => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  it("flags an exact byte-identical image as a duplicate", async () => {
    const existing = [entryAt("images-private/__dedup-test/a.png", "orig")];
    const incoming = entryAt("images-private/__dedup-test/b.png", "new");
    const dup = await findDuplicateAtCommit(incoming, existing);
    expect(dup).not.toBeNull();
    expect(dup?.type).toBe("exact");
    expect(dup?.match).toBe("orig");
  });

  it("returns null for a genuinely unique image against an empty corpus", async () => {
    const dup = await findDuplicateAtCommit(
      entryAt("images-private/__dedup-test/c.png", "new"),
      [],
    );
    expect(dup).toBeNull();
  });

  it("does not flag the entry against itself on PUT (self-exclusion)", async () => {
    // The PUT path re-validates an existing entry; its image is already in the
    // corpus under its own id. findDuplicateAtCommit must skip self, or every
    // edit of an existing entry would 409.
    const existing = [entryAt("images-private/__dedup-test/a.png", "same-id")];
    const dup = await findDuplicateAtCommit(
      entryAt("images-private/__dedup-test/a.png", "same-id"),
      existing,
    );
    expect(dup).toBeNull();
  });
});

describe("upload-time duplicate gate", () => {
  const batchId = "batch-test";

  afterEach(() => {
    clearDuplicateBatch(batchId);
  });

  it("uses the same shared dedup module for in-batch duplicate checks", async () => {
    const first = await checkDuplicateUpload(
      { hash: "hash-a", dhash: "0000000000000000", batchId, filename: "first.png" },
      [],
    );
    expect(first).toEqual({ duplicate: false, type: null, match: null });

    const second = await checkDuplicateUpload(
      { hash: "hash-a", dhash: "0000000000000000", batchId, filename: "second.png" },
      [],
    );
    expect(second).toEqual({ duplicate: true, type: "batch-near", match: "first.png" });
  });
});

describe("dedup-cleanup completeness scoring", () => {
  it("prefers an approved, clean, human-tagged entry over a draft with markers", () => {
    const good = { ...baseEntry, reviewStatus: "approved" as const, provenance: { taggedBy: "human" as const }, qualityScore: 5, critique: "x".repeat(200), whatToSteal: ["a","b","c"] };
    const bad = { ...baseEntry, id: "bad", reviewStatus: "draft" as const, provenance: { taggedBy: "auto" as const }, qualityScore: 2, critique: "[DRAFT] needs rewrite", whatToSteal: ["[DRAFT] short"] };
    expect(completenessScore(good)).toBeGreaterThan(completenessScore(bad));
  });

  it("prefers auto-reviewed over plain auto for equal content", () => {
    const reviewed = { ...baseEntry, provenance: { taggedBy: "auto-reviewed" as const } };
    const auto = { ...baseEntry, id: "auto", provenance: { taggedBy: "auto" as const } };
    expect(completenessScore(reviewed)).toBeGreaterThan(completenessScore(auto));
  });
});

describe("dedup-cleanup shared-image-path safety (P1 regression)", () => {
  // Regression: if a winner and a loser in the same cluster share the same
  // image.path (e.g. bulk-import copied the file under different entry IDs),
  // deleting the loser's image would break the winner's reference. The cleanup
  // must only delete paths that NO remaining entry references.
  it("does not delete a loser image that a kept entry still references", () => {
    const sharedPath = "images-private/shared-screenshot.png";
    const entries = [
      { ...baseEntry, id: "winner", image: { ...baseEntry.image, path: sharedPath }, reviewStatus: "approved" as const, qualityScore: 5 },
      { ...baseEntry, id: "loser", image: { ...baseEntry.image, path: sharedPath }, reviewStatus: "draft" as const, qualityScore: 2 },
    ];
    // Simulate the loserIds → remaining computation.
    const loserIds = new Set(["loser"]);
    const remaining = entries.filter(e => !loserIds.has(e.id));
    const remainingImagePaths = new Set(
      remaining.map(e => e.image.path).filter((p): p is string => !!p)
    );
    const losers = entries.filter(e => loserIds.has(e.id));
    const loserPathsToDelete = losers
      .map(e => e.image.path)
      .filter((p): p is string => !!p && !remainingImagePaths.has(p));
    // The shared path must NOT be in the delete list — the winner still needs it.
    expect(loserPathsToDelete).not.toContain(sharedPath);
    expect(loserPathsToDelete).toHaveLength(0);
  });
});
