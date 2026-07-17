import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { createDecision, generateDecisionId, getDecisionById, listDecisions, loadDecisionsSafe, persistDecisions, saveDecision, setDecisionsForTesting, setDecisionsPathsForTesting, resetDecisionsPathsForTesting } from "./decisions.js";
import type { DecisionT } from "./schema.js";

const TMP_DIR = resolve(process.cwd(), "tmp-decisions-test");
const TMP_DECISIONS_PATH = resolve(TMP_DIR, "decisions.json");
const TMP_SNAPSHOT_DIR = resolve(TMP_DIR, ".snapshots");

/** A minimal valid PersistedDecision fixture (matches the lenient Decisions
 *  schema: 0 directions allowed). Built as a plain object — NOT via
 *  createDecision — so assembling a fixture doesn't call loadDecisionsSafe()
 *  and prime the module cache before the test's own load. Reused across the
 *  corrupt-recovery suites. */
function fixtureDecision(id = "fix-1"): DecisionT {
  return {
    id,
    title: "Fixture",
    createdAt: "2026-07-16",
    updatedAt: "2026-07-16",
    context: { targetUser: "u", businessGoal: "g", primaryKpi: "k" },
    scope: "screen",
    directions: [],
  };
}

/** Write a valid decisions snapshot file at epoch `epoch`. */
function writeSnapshotFile(epoch: number, decisions: DecisionT[]): void {
  mkdirSync(TMP_SNAPSHOT_DIR, { recursive: true });
  writeFileSync(
    resolve(TMP_SNAPSHOT_DIR, `decisions-${epoch}.json`),
    JSON.stringify({ version: 1, decisions }, null, 2),
    "utf-8",
  );
}

describe("decision persistence", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    setDecisionsForTesting(null);
    setDecisionsPathsForTesting({ path: TMP_DECISIONS_PATH, snapshotDir: TMP_SNAPSHOT_DIR });
  });
  afterEach(() => {
    setDecisionsForTesting(null);
    resetDecisionsPathsForTesting();
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("creates a decision with generated id and timestamps", () => {
    const decision = createDecision({
      title: "Homepage direction",
      targetUser: "First-time visitors",
      businessGoal: "Clarity in 10s",
      primaryKpi: "Trial starts",
      scope: "screen" as const,
    });
    expect(decision.id).toMatch(/^[a-z0-9]+-[a-z0-9]+/);
    expect(decision.directions).toEqual([]);
    expect(decision.analysis).toBeUndefined();
  });

  it("saves and retrieves a decision by id (in-memory fixture)", () => {
    const decision = createDecision({
      title: "Test", targetUser: "u", businessGoal: "g", primaryKpi: "k", scope: "screen",
    });
    saveDecision(decision);
    const found = getDecisionById(decision.id);
    expect(found?.title).toBe("Test");
  });

  it("lists decisions newest-first by updatedAt", () => {
    const old = createDecision({ title: "Old", targetUser: "u", businessGoal: "g", primaryKpi: "k", scope: "screen" });
    old.updatedAt = "2026-01-01";
    const newer = createDecision({ title: "New", targetUser: "u", businessGoal: "g", primaryKpi: "k", scope: "screen" });
    newer.updatedAt = "2026-07-10";
    // Use persistDecisions directly to preserve explicit timestamps (saveDecision auto-bumps)
    persistDecisions([old, newer]);
    const all = listDecisions();
    expect(all[0].title).toBe("New");
  });

  it("overwrites a decision on re-save (upsert by id)", () => {
    const decision = createDecision({ title: "V1", targetUser: "u", businessGoal: "g", primaryKpi: "k", scope: "screen" });
    saveDecision(decision);
    decision.title = "V2";
    saveDecision(decision);
    expect(listDecisions()).toHaveLength(1);
    expect(getDecisionById(decision.id)?.title).toBe("V2");
  });
});

describe("corrupt decisions.json recovery", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    setDecisionsForTesting(null);
    setDecisionsPathsForTesting({ path: TMP_DECISIONS_PATH, snapshotDir: TMP_SNAPSHOT_DIR });
  });
  afterEach(() => {
    setDecisionsForTesting(null);
    resetDecisionsPathsForTesting();
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("falls back to the newest valid snapshot instead of []", () => {
    // A valid snapshot exists (older epoch)...
    writeSnapshotFile(1000, [fixtureDecision("snap-decision")]);
    // ...and the primary is corrupt.
    writeFileSync(TMP_DECISIONS_PATH, "{corrupt", "utf-8");

    const loaded = loadDecisionsSafe();

    expect(loaded).toHaveLength(1); // recovered from snapshot, not wiped to []
    expect(loaded[0].id).toBe("snap-decision");
  });

  it("preserves the corrupt primary as decisions.json.corrupt-<epoch>", () => {
    writeFileSync(TMP_DECISIONS_PATH, "{corrupt", "utf-8");

    loadDecisionsSafe();

    const preserved = readdirSync(dirname(TMP_DECISIONS_PATH))
      .filter((f) => f.startsWith("decisions.json.corrupt-"));
    expect(preserved).toHaveLength(1);
    // The original corrupt bytes are preserved verbatim — never overwrite evidence.
    expect(readFileSync(resolve(dirname(TMP_DECISIONS_PATH), preserved[0]), "utf-8")).toBe("{corrupt");
    // And the primary path itself no longer holds the corrupt bytes.
    expect(existsSync(TMP_DECISIONS_PATH)).toBe(false);
  });

  it("returns [] only when no snapshot exists either (true cold start)", () => {
    writeFileSync(TMP_DECISIONS_PATH, "{corrupt", "utf-8");
    // No snapshots written to TMP_SNAPSHOT_DIR.

    const loaded = loadDecisionsSafe();

    expect(loaded).toEqual([]);
    // The corrupt file is still preserved for forensics even on cold start.
    const preserved = readdirSync(dirname(TMP_DECISIONS_PATH))
      .filter((f) => f.startsWith("decisions.json.corrupt-"));
    expect(preserved).toHaveLength(1);
  });

  it("recovers the NEWEST snapshot when multiple exist", () => {
    writeSnapshotFile(1000, [fixtureDecision("older-snap")]);
    writeSnapshotFile(2000, [fixtureDecision("newer-snap")]);
    writeFileSync(TMP_DECISIONS_PATH, "{corrupt", "utf-8");

    const loaded = loadDecisionsSafe();

    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe("newer-snap");
  });

  it("does not destroy recovered data on a subsequent save", () => {
    // The original bug: loadDecisionsSafe caches [], then saveDecision persists [].
    writeSnapshotFile(1000, [fixtureDecision("snap-decision")]);
    writeFileSync(TMP_DECISIONS_PATH, "{corrupt", "utf-8");

    // First load recovers from snapshot...
    const recovered = loadDecisionsSafe();
    expect(recovered).toHaveLength(1);

    // ...a subsequent save must persist the recovered set, not [].
    const fresh = createDecision({ title: "Fresh", targetUser: "u", businessGoal: "g", primaryKpi: "k", scope: "screen" });
    saveDecision(fresh);

    // Clear cache + reload from disk to prove the file now holds both.
    setDecisionsForTesting(null);
    const reloaded = loadDecisionsSafe();
    expect(reloaded.map((d) => d.id)).toContain("snap-decision");
    expect(reloaded.map((d) => d.id)).toContain(fresh.id);
  });
});

describe("generateDecisionId collision-proof", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    setDecisionsForTesting(null);
    setDecisionsPathsForTesting({ path: TMP_DECISIONS_PATH, snapshotDir: TMP_SNAPSHOT_DIR });
  });
  afterEach(() => {
    setDecisionsForTesting(null);
    resetDecisionsPathsForTesting();
    if (existsSync(TMP_DIR)) rmSync(TMP_DIR, { recursive: true, force: true });
  });

  it("produces distinct ids for same-title creates (end-to-end via createDecision)", () => {
    // Persist the first decision so its id is in the existing set when the
    // second is generated. The contract: two same-title decisions must never
    // share an id, regardless of millisecond alignment.
    const d1 = createDecision({
      title: "Same Title",
      targetUser: "u",
      businessGoal: "g",
      primaryKpi: "k",
      scope: "screen",
    });
    saveDecision(d1);

    const d2 = createDecision({
      title: "Same Title",
      targetUser: "u",
      businessGoal: "g",
      primaryKpi: "k",
      scope: "screen",
    });

    expect(d2.id).not.toBe(d1.id);
  });

  it("appends a counter when the would-be id is already in the existing set", () => {
    // Deterministic collision: seed the existing set with the exact id the
    // generator would otherwise produce for this title+stamp, then assert the
    // generator disambiguates with -2, -3, ... instead of returning a dup.
    const slug = "same-title";
    const stamp = Date.now().toString(36).slice(-6);
    const baseId = `${slug}-${stamp}`;

    // First collision -> appends -2.
    expect(generateDecisionId("Same Title", new Set([baseId]))).toBe(`${baseId}-2`);
    // Multiple prior collisions -> walks the counter forward.
    expect(generateDecisionId("Same Title", new Set([baseId, `${baseId}-2`, `${baseId}-3`]))).toBe(`${baseId}-4`);
    // No collision -> returns the bare base id.
    expect(generateDecisionId("Same Title", new Set())).toBe(baseId);
  });
});
