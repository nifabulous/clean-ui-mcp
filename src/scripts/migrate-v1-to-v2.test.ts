import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setCorpusRootForTesting } from "../persistence.js";
import { inferPatternType, migrateAntiPatterns, runV1ToV2Migration, TODO_PLACEHOLDER, type V1Entry } from "./migrate-v1-to-v2.js";

describe("v1→v2 migration: patternType inference", () => {
  it("picks the first category that is a valid patternType", () => {
    expect(inferPatternType({ id: "x", categories: ["empty-state", "onboarding"] })).toBe("empty-state");
    expect(inferPatternType({ id: "x", categories: ["dashboard", "data-table"] })).toBe("dashboard");
    expect(inferPatternType({ id: "x", categories: ["pricing", "marketing-hero"] })).toBe("pricing");
  });

  it("falls back to dashboard when no category maps", () => {
    expect(inferPatternType({ id: "x", categories: [] })).toBe("dashboard");
  });
});

describe("v1→v2 migration: antiPatterns restructure", () => {
  it("lifts existing whatToAvoidHere content into antiPatterns", () => {
    const entry: V1Entry = {
      id: "x",
      categories: ["dashboard"],
      whatToAvoidHere: ["Avoids heavy shadows for depth — uses color steps instead."],
    };
    const result = migrateAntiPatterns(entry);
    expect(result.antiPatterns).toEqual(["Avoids heavy shadows for depth — uses color steps instead."]);
    expect(result.whereThisFails).toEqual([]);
    expect(result.accessibilityRisks).toEqual([]);
  });

  it("fills a TODO placeholder when whatToAvoidHere is missing or empty", () => {
    expect(migrateAntiPatterns({ id: "x", categories: ["dashboard"] }).antiPatterns).toEqual([TODO_PLACEHOLDER]);
    expect(migrateAntiPatterns({ id: "x", categories: ["dashboard"], whatToAvoidHere: [] }).antiPatterns).toEqual([TODO_PLACEHOLDER]);
    expect(migrateAntiPatterns({ id: "x", categories: ["dashboard"], whatToAvoidHere: ["short"] }).antiPatterns).toEqual([TODO_PLACEHOLDER]);
  });
});

// ─── durability regression: snapshot prior bytes + atomic write ───────────────
// Task 6: every entries.json writer must snapshot the original bytes via
// writeRawSnapshot BEFORE overwriting, and write the primary atomically. This
// proves the v1→v2 migration lands a pre-migration snapshot in the durability
// layer's .snapshots/ dir — so a crash mid-write (or Task 5's recovery) can't
// silently swap in older data without a recoverable prior state on disk.
describe("v1→v2 migration: snapshots prior bytes + writes atomically", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "migrate-v1v2-"));
    setCorpusRootForTesting(root);
  });
  afterEach(() => {
    setCorpusRootForTesting(null);
    rmSync(root, { recursive: true, force: true });
  });

  it("writes a pre-migration snapshot containing the original v1 bytes", () => {
    const entriesPath = resolve(root, "entries.json");
    const snapshotDir = resolve(root, ".snapshots");

    // A minimal v1 corpus: no patternType, free-text whatToAvoidHere.
    const v1Entry: V1Entry = {
      id: "test-dashboard",
      categories: ["dashboard"],
      whatToAvoidHere: ["Avoids heavy shadows for depth — uses color steps instead."],
    };
    const v1Bytes = JSON.stringify({ version: 1, entries: [v1Entry] }, null, 2) + "\n";
    writeFileSync(entriesPath, v1Bytes, "utf-8");

    runV1ToV2Migration(entriesPath);

    // Primary is now v2 (atomic write happened).
    const migrated = JSON.parse(readFileSync(entriesPath, "utf-8"));
    expect(migrated.version).toBe(2);
    expect(migrated.entries[0].patternType).toBe("dashboard");

    // A timestamped snapshot landed in .snapshots/ matching writeRawSnapshot's
    // filename pattern (entries-<epoch>.json).
    mkdirSync(snapshotDir, { recursive: true });
    const snaps = readdirSync(snapshotDir).filter((f) => /^entries-\d+\.json$/.test(f));
    expect(snaps.length).toBeGreaterThanOrEqual(1);

    // The snapshot preserves the PRE-migration (v1) bytes — the recoverable
    // prior state, not the post-migration v2 document.
    const snapContent = JSON.parse(readFileSync(resolve(snapshotDir, snaps[0]), "utf-8"));
    expect(snapContent.version).toBe(1);
    expect(snapContent.entries[0].id).toBe(v1Entry.id);
  });
});
