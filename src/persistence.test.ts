/**
 * Persistence-layer durability tests — the safety net that was missing when the
 * seed/snapshot → save → clobber bug survived. These run against an isolated
 * temp corpus root (via setCorpusRootForTesting) so they never touch the
 * developer's real entries.json.
 *
 * What's under test (Task 1, Gate 1A):
 *   - loadCorpusSafe recovers from snapshot but does NOT rewrite primary.
 *   - seed fallback is read-only (writable:false) and never restores primary.
 *   - unsupported-newer version is fatal — no silent fallback to seed/snapshot.
 *   - persistEntries refuses a read-only LoadedCorpus (write-protect).
 *   - the test seam (setCorpusForTesting) still works after consolidation.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CorpusEntryT } from "./schema.js";
import { setCorpusRootForTesting, loadCorpusSafe, persistEntries } from "./persistence.js";
import { setCorpusForTesting, getEntryById } from "./corpus.js";
import { fixtures } from "./scripts/__fixtures__/corpus-fixtures.js";

// Schema-valid entry with a chosen id. Built by cloning a real fixture so the
// durability tests exercise genuine Zod validation (not a hand-rolled stub that
// drifts from the schema). The durable layer only parses the envelope, but the
// decoder validates entries too — so they must be schema-clean.
function validEntry(id: string): CorpusEntryT {
  // Override image.path to a schema-valid private path (fixtures[0] leaves it
  // empty, which the in-memory test seam accepts but disk validation rejects).
  return { ...fixtures[0], id, image: { ...fixtures[0].image, path: "images-private/test.png", width: 1280, height: 800 } } as CorpusEntryT;
}

const ENTRIES = "entries.json";
const SEED = "seed.json";
const SNAP_DIR = ".snapshots";

/** Isolated temp corpus root. Each test gets its own so state can't leak. */
class TempCorpus {
  readonly root: string;
  readonly entriesPath: string;
  readonly seedPath: string;
  readonly snapshotDir: string;

  constructor() {
    this.root = mkdtempSync(join(tmpdir(), "corpus-persist-"));
    this.entriesPath = resolve(this.root, ENTRIES);
    this.seedPath = resolve(this.root, SEED);
    this.snapshotDir = resolve(this.root, SNAP_DIR);
  }

  writeEntries(entries: CorpusEntryT[], version = 2): void {
    writeFileSync(this.entriesPath, JSON.stringify({ version, entries }, null, 2), "utf-8");
  }

  /** Write corrupt content (truncated JSON) to primary. */
  writeCorruptPrimary(): void {
    writeFileSync(this.entriesPath, "{ not valid json ]]", "utf-8");
  }

  writeSeed(entries: CorpusEntryT[], version = 2): void {
    writeFileSync(this.seedPath, JSON.stringify({ version, entries }, null, 2), "utf-8");
  }

  writeSnapshotFile(epoch: number, entries: CorpusEntryT[], version = 2): void {
    mkdirSync(this.snapshotDir, { recursive: true });
    writeFileSync(
      resolve(this.snapshotDir, `entries-${epoch}.json`),
      JSON.stringify({ version, entries }, null, 2),
      "utf-8",
    );
  }

  primaryExists(): boolean { return existsSync(this.entriesPath); }
  readPrimaryRaw(): string { return readFileSync(this.entriesPath, "utf-8"); }

  cleanup(): void { rmSync(this.root, { recursive: true, force: true }); }
}

describe("loadCorpusSafe — fallback chain", () => {
  let tmp: TempCorpus;

  beforeEach(() => {
    tmp = new TempCorpus();
    setCorpusRootForTesting(tmp.root);
  });
  afterEach(() => {
    setCorpusRootForTesting(null);
    tmp.cleanup();
  });

  it("corrupt primary + valid snapshot → recovers from snapshot, does NOT rewrite primary", () => {
    const snap = [validEntry("snap-entry-1"), validEntry("snap-entry-2")];
    tmp.writeCorruptPrimary();
    tmp.writeSnapshotFile(1000, snap);

    const loaded = loadCorpusSafe();

    // Recovered the snapshot content...
    expect(loaded.entries.map((e) => e.id)).toEqual(["snap-entry-1", "snap-entry-2"]);
    expect(loaded.source).toBe("snapshot");
    expect(loaded.writable).toBe(false); // snapshot fallback is read-only

    // ...but the (corrupt) primary was NOT auto-rewritten by the load path.
    // A later save that clobbers a real corpus is the bug we're preventing.
    expect(tmp.readPrimaryRaw()).toContain("not valid json");
  });

  it("missing primary + valid seed → returns seed read-only (writable:false), does NOT create entries.json", () => {
    tmp.writeSeed([validEntry("seed-only")]);
    // No primary, no snapshots.

    const loaded = loadCorpusSafe();

    expect(loaded.entries.map((e) => e.id)).toEqual(["seed-only"]);
    expect(loaded.source).toBe("seed");
    expect(loaded.writable).toBe(false);
    expect(tmp.primaryExists()).toBe(false); // no auto-restore from seed
  });

  it("unsupported-newer version → fails visibly, does NOT fall back to seed", () => {
    // Future version on the primary; a seed is present and would be a tempting
    // silent fallback. The loader must surface the future version, not mask it.
    tmp.writeEntries([validEntry("future-1")], 3);
    tmp.writeSeed([validEntry("seed-only")]);

    // Fatal, not silent — assert it throws rather than returns seed.
    expect(() => loadCorpusSafe()).toThrow(/unsupported/i);
  });

  it("valid primary → returns primary read/write (writable:true)", () => {
    tmp.writeEntries([validEntry("real-1"), validEntry("real-2")]);

    const loaded = loadCorpusSafe();

    expect(loaded.source).toBe("primary");
    expect(loaded.writable).toBe(true);
    expect(loaded.version).toBe(2);
  });

  it("missing primary, no snapshot, no seed → empty (writable:false)", () => {
    const loaded = loadCorpusSafe();
    expect(loaded.entries).toEqual([]);
    expect(loaded.source).toBe("empty");
    expect(loaded.writable).toBe(false);
  });
});

describe("persistEntries — write protection", () => {
  let tmp: TempCorpus;

  beforeEach(() => {
    tmp = new TempCorpus();
    setCorpusRootForTesting(tmp.root);
  });
  afterEach(() => {
    setCorpusRootForTesting(null);
    tmp.cleanup();
  });

  it("refuses a read-only LoadedCorpus (snapshot source)", () => {
    tmp.writeCorruptPrimary();
    tmp.writeSnapshotFile(1000, [validEntry("snap-1")]);

    const loaded = loadCorpusSafe(); // writable:false, source:snapshot
    expect(loaded.writable).toBe(false);

    expect(() => persistEntries(loaded, loaded.entries)).toThrow(/writable|read.only/i);
    // Primary must remain untouched.
    expect(tmp.readPrimaryRaw()).toContain("not valid json");
  });

  it("refuses a read-only LoadedCorpus (seed source)", () => {
    tmp.writeSeed([validEntry("seed-1")]);

    const loaded = loadCorpusSafe(); // writable:false, source:seed

    expect(() => persistEntries(loaded, loaded.entries)).toThrow(/writable|read.only/i);
    expect(tmp.primaryExists()).toBe(false);
  });

  it("writes when given a writable LoadedCorpus (primary source)", () => {
    tmp.writeEntries([validEntry("orig-1")]);

    const loaded = loadCorpusSafe();
    expect(loaded.writable).toBe(true);

    const next = [validEntry("orig-1"), validEntry("new-1")];
    persistEntries(loaded, next);

    const after = JSON.parse(tmp.readPrimaryRaw());
    expect(after.entries.map((e: { id: string }) => e.id)).toEqual(["orig-1", "new-1"]);
    expect(after.version).toBe(2);
  });
});

describe("setCorpusForTesting — consolidation regression", () => {
  afterEach(() => setCorpusForTesting(null));

  it("test seam still overrides the corpus cache after consolidation", () => {
    setCorpusForTesting([validEntry("seam-only-entry")]);
    expect(getEntryById("seam-only-entry")).toBeDefined();
    expect(getEntryById("real-anything-else")).toBeUndefined();
  });
});
