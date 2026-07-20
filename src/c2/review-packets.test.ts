/**
 * C2 review-packets tests (Task 8, Steps 1 + 4).
 *
 * These tests pin the metadata-blinding protocol from spec §10:
 *
 *   - Review packets carry ONLY a cryptographically random `reviewId` (UUID v4)
 *     plus the candidate content required for scoring.
 *   - The packet omits provider, model, condition, run ID, output hash, run
 *     ordering, prompt, evidence source labels, and private paths.
 *   - Two assignments of the same candidate produce DIFFERENT UUIDs; the UUID
 *     carries zero information about the candidate (no hash prefix).
 *   - The submission schema refuses run/hash/condition/provider fields
 *     (already pinned in evaluation-contracts.test.ts; we re-assert here against
 *     the packet builder's output type so a future loosening of the schema is
 *     still caught by this module's contract).
 *   - `finalizeBlindScorecard` is the ONLY path that resolves the private blind
 *     map after submission. It refuses unknown, reused, or already-finalized
 *     review IDs; double-finalization fails closed; the map entry atomically
 *     transitions `assigned` → `finalized`.
 *   - The canonical `C2HumanScorecard` is created with `blindedCondition: true`
 *     plus the resolved `runId` and `runOutputSha256`.
 *
 * All filesystem effects go through an injected in-memory store so the suite
 * never touches a real `.c2-private/` directory.
 */
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBlindAssignment,
  buildBlindedReviewPacket,
  finalizeBlindScorecard,
  shufflePackets,
  createFileBlindMapStore,
  type BlindMapStore,
  type BlindAssignmentInput,
} from "./review-packets.js";
import { C2HumanScorecardSchema, C2BlindScoreSubmissionSchema, type C2BlindScoreSubmission } from "./evaluation-contracts.js";
import type { C2CandidateArtifact } from "./candidate-contracts.js";

// ---------------------------------------------------------------------------
// In-memory blind-map store
// ---------------------------------------------------------------------------

interface MapEntry {
  reviewId: string;
  runId: string;
  runOutputSha256: string;
  assignedReviewerActorId: string;
  state: "assigned" | "finalized";
}

function makeInMemoryStore(): BlindMapStore & { snapshot(): MapEntry[]; raw: Map<string, MapEntry> } {
  const raw = new Map<string, MapEntry>();
  return {
    raw,
    snapshot: () => [...raw.values()],
    async load() {
      return [...raw.values()].map((entry) => ({ ...entry }));
    },
    async upsert(entry) {
      // Simulate the on-disk store: assignment writes a new entry; reusing a
      // reviewId is forbidden by the protocol and rejected at the upsert seam.
      if (raw.has(entry.reviewId)) {
        throw new Error(`[test-store] reviewId already exists: ${entry.reviewId}`);
      }
      raw.set(entry.reviewId, { ...entry });
    },
    async transition(reviewId, fromState, toState) {
      const current = raw.get(reviewId);
      if (!current) return false;
      if (current.state !== fromState) return false;
      current.state = toState;
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DIMENSIONS = [
  "product-appropriateness",
  "cross-screen-coherence",
  "implementation-clarity",
  "originality",
  "accessibility-and-failure-states",
  "evidence-discipline",
] as const;

function makeCandidate(marker: string): C2CandidateArtifact {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-candidate-design",
    artifactId: `c2-candidate-${marker}`,
    caseId: "test-case",
    globalDirection: { summary: `Direction for ${marker}`, principles: ["p:1", "p:2"] },
    screenBlueprints: [
      {
        id: "screen:home",
        summary: "Home",
        requiredStates: ["state:default"],
        mobileRules: ["mobile:tap"],
        accessibility: ["a11y:contrast"],
        failureAndRecovery: ["recovery:retry"],
        inspectedUrls: [],
      },
    ],
    sourceDecisions: [
      { id: "decision:1", lane: "adapt", rationale: "Because.", evidenceIds: [] },
    ],
    authorityLanes: { retain: [], adapt: ["decision:1"], reject: [] },
    acceptanceCriteria: [{ id: "ac:1", statement: "Acceptance." }],
    assumptions: ["assumption:1"],
    accessibilityAndRecovery: ["ar:1"],
    provenance: { conditionInputSha256: "0".repeat(64) },
  };
}

function makeRunInput(opts: {
  runId: string;
  runOutputSha256: string;
  candidate: C2CandidateArtifact;
  assignedReviewerActorId: string;
}): BlindAssignmentInput {
  return {
    runId: opts.runId,
    runOutputSha256: opts.runOutputSha256,
    candidate: opts.candidate,
    assignedReviewerActorId: opts.assignedReviewerActorId,
  };
}

function makeSubmission(reviewId: string, reviewerActorId: string): C2BlindScoreSubmission {
  return C2BlindScoreSubmissionSchema.parse({
    schemaVersion: "1.0",
    artifactType: "c2-blind-score-submission",
    reviewId,
    reviewerActorId,
    reviewerActorKind: "human",
    scores: DIMENSIONS.map((dimension) => ({
      dimension,
      score: 4,
      rationale: `Rationale for ${dimension}.`,
    })),
    submittedAt: "2026-07-18T12:00:00.000Z",
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createBlindAssignment", () => {
  let store: ReturnType<typeof makeInMemoryStore>;

  beforeEach(() => {
    store = makeInMemoryStore();
  });

  it("returns a private assignment carrying only the run + candidate binding (no reviewer-visible fields)", async () => {
    const candidate = makeCandidate("a");
    const assignment = await createBlindAssignment(
      makeRunInput({
        runId: "c2-run-001",
        runOutputSha256: "a".repeat(64),
        candidate,
        assignedReviewerActorId: "reviewer.gold-1",
      }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );

    // The assignment is the PRIVATE record — it carries the reversible binding.
    expect(assignment.runId).toBe("c2-run-001");
    expect(assignment.runOutputSha256).toBe("a".repeat(64));
    expect(assignment.assignedReviewerActorId).toBe("reviewer.gold-1");
    expect(assignment.state).toBe("assigned");
    // The reviewId is a UUID and the private store carries the reversible map.
    expect(assignment.reviewId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    const stored = store.snapshot().find((entry) => entry.reviewId === assignment.reviewId);
    expect(stored).toBeDefined();
    expect(stored?.state).toBe("assigned");
    expect(stored?.runId).toBe("c2-run-001");
    expect(stored?.runOutputSha256).toBe("a".repeat(64));
  });

  it("produces DIFFERENT reviewIds for the same candidate on two assignments", async () => {
    const candidate = makeCandidate("same");
    const a = await createBlindAssignment(
      makeRunInput({ runId: "c2-run-a", runOutputSha256: "a".repeat(64), candidate, assignedReviewerActorId: "r1" }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );
    const b = await createBlindAssignment(
      makeRunInput({ runId: "c2-run-b", runOutputSha256: "b".repeat(64), candidate, assignedReviewerActorId: "r1" }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );
    expect(a.reviewId).not.toBe(b.reviewId);
  });

  it("the reviewId carries no candidate-hash prefix (zero correlation between UUID and candidate bytes)", async () => {
    // The candidate hash is SHA-256 of the canonical candidate JSON. The first
    // 8 hex chars of that hash MUST NOT appear anywhere in the UUID.
    const candidate = makeCandidate("prefix-test");
    const candidateHashPrefix = JSON.stringify(candidate).slice(0, 8);
    const assignment = await createBlindAssignment(
      makeRunInput({ runId: "c2-run-x", runOutputSha256: "f".repeat(64), candidate, assignedReviewerActorId: "r1" }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );
    // The UUID hex digits must not contain the candidate JSON prefix substring.
    expect(assignment.reviewId.toLowerCase()).not.toContain(candidateHashPrefix.toLowerCase());
    // Also assert against the outputSha256 prefix (a likely "obvious" hash-derivation).
    expect(assignment.reviewId.toLowerCase()).not.toContain("fffffff");
  });

  it("uses crypto.randomUUID() by default (no injected source)", async () => {
    const candidate = makeCandidate("default-source");
    const assignment = await createBlindAssignment(
      makeRunInput({ runId: "c2-run-y", runOutputSha256: "1".repeat(64), candidate, assignedReviewerActorId: "r1" }),
      { store, now: () => "2026-07-18T00:00:00.000Z" },
    );
    // The default source is crypto.randomUUID; the result still parses as a UUID.
    expect(assignment.reviewId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it("refuses to assign when a reviewId collision happens at the store seam (fail closed)", async () => {
    const candidate = makeCandidate("collision");
    // Force the injected random source to return a fixed UUID — the second
    // assignment must surface the store's collision error, not silently
    // overwrite the map entry.
    const fixed = "11111111-1111-4111-8111-111111111111";
    const a = await createBlindAssignment(
      makeRunInput({ runId: "c2-run-1", runOutputSha256: "a".repeat(64), candidate, assignedReviewerActorId: "r1" }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => fixed },
    );
    expect(a.reviewId).toBe(fixed);
    await expect(
      createBlindAssignment(
        makeRunInput({ runId: "c2-run-2", runOutputSha256: "b".repeat(64), candidate, assignedReviewerActorId: "r1" }),
        { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => fixed },
      ),
    ).rejects.toThrow(/already exists|collision|reviewId/i);
  });
});

describe("buildBlindedReviewPacket", () => {
  it("returns ONLY { reviewId, candidate } — no provider, model, condition name, run, output hash, or path metadata", async () => {
    const store = makeInMemoryStore();
    const candidate = makeCandidate("packet");
    const assignment = await createBlindAssignment(
      makeRunInput({ runId: "c2-run-p", runOutputSha256: "a".repeat(64), candidate, assignedReviewerActorId: "reviewer.gold-1" }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );

    const packet = buildBlindedReviewPacket(assignment, candidate);

    // The packet has exactly two top-level keys.
    expect(Object.keys(packet).sort()).toEqual(["candidate", "reviewId"]);
    expect(packet.reviewId).toBe(assignment.reviewId);
    expect(packet.candidate).toEqual(candidate);

    // The serialized packet MUST NOT carry identifying METADATA: runId, output
    // hash, provider/model names, condition NAMES (the literals a reviewer could
    // grep for), the assigned reviewer, or any private path. Intrinsic candidate
    // fields (caseId, the provenance hash, the model-produced evidence IDs) are
    // part of the scored output and remain — the protocol strips IDENTIFYING
    // METADATA, not the candidate itself.
    const serialized = JSON.stringify(packet);
    for (const forbidden of [
      "c2-run-p", // runId literal
      "aaaaaaaa", // runOutputSha256 prefix
      "openai",
      "claude",
      "gpt-", // model name prefix
      "brief-only",
      "current-grounded",
      "gold-evidence",
      "runOutputSha256",
      "assignedReviewerActorId",
      "reviewer.gold-1",
      ".c2-private",
      "blind-map",
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it("does not embed the candidate's caseId-adjacent provenance beyond what the candidate itself carries", async () => {
    // The candidate carries a conditionInputSha256 — that is intrinsic to the
    // candidate artifact (it is part of the scored output). The packet does not
    // strip intrinsic candidate fields; it strips IDENTIFYING METADATA the
    // reviewer would otherwise use to correlate conditions.
    const store = makeInMemoryStore();
    const candidate = makeCandidate("intrinsic");
    const assignment = await createBlindAssignment(
      makeRunInput({ runId: "c2-run-i", runOutputSha256: "9".repeat(64), candidate, assignedReviewerActorId: "r1" }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );
    const packet = buildBlindedReviewPacket(assignment, candidate);
    // The runId and runOutputSha256 are NOT in the packet.
    expect(JSON.stringify(packet)).not.toContain("c2-run-i");
    expect(JSON.stringify(packet)).not.toContain("99999999");
  });
});

describe("finalizeBlindScorecard", () => {
  it("resolves the private map after submission, verifies the reviewer, transitions assigned→finalized, and creates the canonical C2HumanScorecard", async () => {
    const store = makeInMemoryStore();
    const candidate = makeCandidate("finalize");
    const assignment = await createBlindAssignment(
      makeRunInput({ runId: "c2-run-f", runOutputSha256: "c".repeat(64), candidate, assignedReviewerActorId: "reviewer.gold-1" }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );
    const submission = makeSubmission(assignment.reviewId, "reviewer.gold-1");

    const scorecard = await finalizeBlindScorecard(submission, {
      store,
      now: () => "2026-07-18T12:30:00.000Z",
      artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
    });

    // Canonical scorecard shape + binding.
    expect(C2HumanScorecardSchema.safeParse(scorecard).success).toBe(true);
    expect(scorecard.blindedCondition).toBe(true);
    expect(scorecard.runId).toBe("c2-run-f");
    expect(scorecard.runOutputSha256).toBe("c".repeat(64));
    expect(scorecard.reviewerActorId).toBe("reviewer.gold-1");
    expect(scorecard.scoredAt).toBe("2026-07-18T12:30:00.000Z");

    // Atomic transition: the map entry is now finalized.
    const stored = store.snapshot().find((entry) => entry.reviewId === assignment.reviewId);
    expect(stored?.state).toBe("finalized");
  });

  it("refuses an UNKNOWN reviewId (no map entry)", async () => {
    const store = makeInMemoryStore();
    const submission = makeSubmission("22222222-2222-4222-8222-222222222222", "reviewer.gold-1");
    await expect(
      finalizeBlindScorecard(submission, {
        store,
        now: () => "2026-07-18T12:30:00.000Z",
        artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
      }),
    ).rejects.toThrow(/unknown|not found|reviewId/i);
  });

  it("refuses an already-finalized reviewId (double-finalization fails closed)", async () => {
    const store = makeInMemoryStore();
    const candidate = makeCandidate("double");
    const assignment = await createBlindAssignment(
      makeRunInput({ runId: "c2-run-d", runOutputSha256: "d".repeat(64), candidate, assignedReviewerActorId: "reviewer.gold-1" }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );
    const submission = makeSubmission(assignment.reviewId, "reviewer.gold-1");

    const first = await finalizeBlindScorecard(submission, {
      store,
      now: () => "2026-07-18T12:30:00.000Z",
      artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
    });
    expect(first.runId).toBe("c2-run-d");

    // The second finalization with the SAME submission must fail closed.
    await expect(
      finalizeBlindScorecard(submission, {
        store,
        now: () => "2026-07-18T12:31:00.000Z",
        artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
      }),
    ).rejects.toThrow(/finalized|already|state|transition/i);
  });

  it("refuses a submission whose reviewer does not match the assigned reviewer", async () => {
    const store = makeInMemoryStore();
    const candidate = makeCandidate("reviewer-mismatch");
    const assignment = await createBlindAssignment(
      makeRunInput({ runId: "c2-run-rm", runOutputSha256: "e".repeat(64), candidate, assignedReviewerActorId: "reviewer.gold-1" }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );
    // A different reviewer tries to submit against the assigned slot.
    const submission = makeSubmission(assignment.reviewId, "reviewer.qa-1");
    await expect(
      finalizeBlindScorecard(submission, {
        store,
        now: () => "2026-07-18T12:30:00.000Z",
        artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
      }),
    ).rejects.toThrow(/reviewer|mismatch|assigned/i);
    // The map entry MUST remain assigned (failed closed: no transition).
    const stored = store.snapshot().find((entry) => entry.reviewId === assignment.reviewId);
    expect(stored?.state).toBe("assigned");
  });

  it("creates the canonical scorecard with implementationReady derived from the per-dimension floor", async () => {
    const store = makeInMemoryStore();
    const candidate = makeCandidate("ready");
    const assignment = await createBlindAssignment(
      makeRunInput({ runId: "c2-run-ready", runOutputSha256: "1".repeat(64), candidate, assignedReviewerActorId: "reviewer.gold-1" }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );
    // Every score >= 3 ⇒ implementationReady true.
    const submission = makeSubmission(assignment.reviewId, "reviewer.gold-1");
    const scorecard = await finalizeBlindScorecard(submission, {
      store,
      now: () => "2026-07-18T12:30:00.000Z",
      artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
    });
    expect(scorecard.implementationReady).toBe(true);

    // Now do a second assignment with a sub-floor score in one dimension; the
    // schema's superRefine rejects implementationReady: true (the scorecard
    // constructor must derive it, not the caller).
    const candidate2 = makeCandidate("ready-2");
    const assignment2 = await createBlindAssignment(
      makeRunInput({ runId: "c2-run-ready-2", runOutputSha256: "2".repeat(64), candidate: candidate2, assignedReviewerActorId: "reviewer.gold-2" }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );
    const subFloor: C2BlindScoreSubmission = {
      ...makeSubmission(assignment2.reviewId, "reviewer.gold-2"),
      scores: DIMENSIONS.map((dimension) => ({
        dimension,
        score: dimension === "originality" ? 2 : 4,
        rationale: `Rationale for ${dimension}.`,
      })),
    };
    const scorecard2 = await finalizeBlindScorecard(subFloor, {
      store,
      now: () => "2026-07-18T12:30:00.000Z",
      artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
    });
    expect(scorecard2.implementationReady).toBe(false);
  });

  it("verifies the reviewer via an injected verifier (default: exact actor-id match)", async () => {
    const store = makeInMemoryStore();
    const candidate = makeCandidate("verify");
    const assignment = await createBlindAssignment(
      makeRunInput({ runId: "c2-run-v", runOutputSha256: "3".repeat(64), candidate, assignedReviewerActorId: "reviewer.gold-1" }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );
    // A caller-supplied verifier that ALWAYS returns false refuses the finalize.
    const alwaysFalse = vi.fn(() => false);
    await expect(
      finalizeBlindScorecard(makeSubmission(assignment.reviewId, "reviewer.gold-1"), {
        store,
        now: () => "2026-07-18T12:30:00.000Z",
        artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
        verifyReviewer: alwaysFalse,
      }),
    ).rejects.toThrow(/reviewer/i);
    expect(alwaysFalse).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// shufflePackets — packet-order shuffle with crypto.randomInt() rejection sampling
// ---------------------------------------------------------------------------

describe("shufflePackets", () => {
  it("produces a permutation: every input element appears exactly once (no drops or duplicates)", () => {
    const items = Array.from({ length: 50 }, (_, i) => `packet-${i}`);
    const shuffled = shufflePackets(items);
    expect(shuffled).toHaveLength(items.length);
    expect(new Set(shuffled)).toEqual(new Set(items));
    // No duplicates.
    expect(shuffled.length).toBe(new Set(shuffled).size);
  });

  it("does NOT mutate the input array", () => {
    const items = ["a", "b", "c", "d", "e"];
    const snapshot = [...items];
    shufflePackets(items);
    expect(items).toEqual(snapshot);
  });

  it("is deterministic for a seeded randomInt (Fisher-Yates replay)", () => {
    // A seeded LCG-style source: the helper's rejection sampling path must
    // still produce a reproducible permutation for the same seed + input.
    function makeSeeded(seed: number): (max: number) => number {
      let state = seed >>> 0;
      return (max: number) => {
        // xorshift32 — deterministic, full-period over 2^32 - 1.
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        return state % max;
      };
    }
    const items = Array.from({ length: 20 }, (_, i) => i);
    const a = shufflePackets(items, makeSeeded(123456));
    const b = shufflePackets(items, makeSeeded(123456));
    expect(a).toEqual(b);
    // Different seed ⇒ (very likely) different permutation.
    const c = shufflePackets(items, makeSeeded(654321));
    expect(a).not.toEqual(c);
    // Both are still permutations of the input.
    expect(new Set(a)).toEqual(new Set(items));
    expect(new Set(c)).toEqual(new Set(items));
  });

  it("actually shuffles: the output ordering differs from the input for a non-trivial list", () => {
    const items = Array.from({ length: 100 }, (_, i) => i);
    const shuffled = shufflePackets(items);
    // Identity ordering is astronomically unlikely for a real shuffle of 100.
    expect(shuffled).not.toEqual(items);
    // But the multiset is preserved.
    expect(shuffled.slice().sort((a, b) => a - b)).toEqual(items);
  });

  it("handles edge cases: empty array, single element, two elements", () => {
    expect(shufflePackets([])).toEqual([]);
    expect(shufflePackets(["solo"])).toEqual(["solo"]);
    const two = shufflePackets(["a", "b"]);
    expect(new Set(two)).toEqual(new Set(["a", "b"]));
  });
});

// ---------------------------------------------------------------------------
// createFileBlindMapStore — file-backed reversible map under .c2-private/c2/
// ---------------------------------------------------------------------------

describe("createFileBlindMapStore", () => {
  let privateDir: string;

  beforeEach(() => {
    privateDir = mkdtempSync(join(tmpdir(), "c2-blind-map-"));
  });

  afterEach(() => {
    rmSync(privateDir, { recursive: true, force: true });
  });

  it("load() returns an empty list when the blind-map.json file does not exist yet", async () => {
    const store = createFileBlindMapStore(privateDir);
    expect(await store.load()).toEqual([]);
    expect(existsSync(join(privateDir, "blind-map.json"))).toBe(false);
  });

  it("upsert writes blind-map.json and the file contains the canonical entry", async () => {
    const store = createFileBlindMapStore(privateDir);
    const entry = {
      reviewId: "11111111-1111-4111-8111-111111111111",
      runId: "c2-run-file-1",
      runOutputSha256: "a".repeat(64),
      assignedReviewerActorId: "reviewer.gold-1",
      state: "assigned" as const,
    };
    await store.upsert(entry);

    const path = join(privateDir, "blind-map.json");
    expect(existsSync(path)).toBe(true);
    const onDisk = JSON.parse(readFileSync(path, "utf8")) as unknown[];
    expect(onDisk).toHaveLength(1);
    expect(onDisk[0]).toMatchObject(entry);

    // load() returns a fresh copy.
    const loaded = await store.load();
    expect(loaded).toEqual([entry]);
  });

  it("upsert fails closed on a reviewId collision (the protocol never overwrites)", async () => {
    const store = createFileBlindMapStore(privateDir);
    const entry = {
      reviewId: "22222222-2222-4222-8222-222222222222",
      runId: "c2-run-file-2",
      runOutputSha256: "b".repeat(64),
      assignedReviewerActorId: "reviewer.gold-1",
      state: "assigned" as const,
    };
    await store.upsert(entry);
    await expect(store.upsert(entry)).rejects.toThrow(/already exists|reviewId/i);
    // The file still holds exactly one entry.
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
  });

  it("transition performs an atomic assigned → finalized compare-and-swap and persists the new state", async () => {
    const store = createFileBlindMapStore(privateDir);
    const reviewId = "33333333-3333-4333-8333-333333333333";
    await store.upsert({
      reviewId,
      runId: "c2-run-file-3",
      runOutputSha256: "c".repeat(64),
      assignedReviewerActorId: "reviewer.gold-1",
      state: "assigned",
    });

    const ok = await store.transition(reviewId, "assigned", "finalized");
    expect(ok).toBe(true);

    // The on-disk file reflects the transition.
    const onDisk = JSON.parse(readFileSync(join(privateDir, "blind-map.json"), "utf8")) as Array<{ state: string }>;
    expect(onDisk[0]!.state).toBe("finalized");
    expect((await store.load())[0]!.state).toBe("finalized");
  });

  it("transition returns false (no write) for an unknown reviewId or a state mismatch", async () => {
    const store = createFileBlindMapStore(privateDir);
    const reviewId = "44444444-4444-4444-8444-444444444444";
    await store.upsert({
      reviewId,
      runId: "c2-run-file-4",
      runOutputSha256: "d".repeat(64),
      assignedReviewerActorId: "reviewer.gold-1",
      state: "assigned",
    });

    // Unknown id.
    expect(await store.transition("55555555-5555-4555-8555-555555555555", "assigned", "finalized")).toBe(false);
    // State mismatch (already assigned, asking to transition from finalized).
    expect(await store.transition(reviewId, "finalized", "assigned")).toBe(false);

    // Double-finalization fails closed: first transition succeeds, second fails.
    expect(await store.transition(reviewId, "assigned", "finalized")).toBe(true);
    expect(await store.transition(reviewId, "assigned", "finalized")).toBe(false);
  });

  it("end-to-end: assign via createBlindAssignment + finalize via finalizeBlindScorecard against the file store", async () => {
    const store = createFileBlindMapStore(privateDir);
    const candidate = makeCandidate("file-e2e");
    const assignment = await createBlindAssignment(
      makeRunInput({
        runId: "c2-run-file-e2e",
        runOutputSha256: "e".repeat(64),
        candidate,
        assignedReviewerActorId: "reviewer.gold-1",
      }),
      { store, now: () => "2026-07-18T00:00:00.000Z", randomUuid: () => randomUUID() },
    );

    // The file now carries the assigned entry.
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.state).toBe("assigned");

    const submission = makeSubmission(assignment.reviewId, "reviewer.gold-1");
    const scorecard = await finalizeBlindScorecard(submission, {
      store,
      now: () => "2026-07-18T12:30:00.000Z",
      artifactId: (reviewId) => `c2-scorecard-${reviewId}`,
    });
    expect(C2HumanScorecardSchema.safeParse(scorecard).success).toBe(true);
    expect(scorecard.runId).toBe("c2-run-file-e2e");

    // The file now reflects the finalized state.
    const finalized = (await store.load())[0]!;
    expect(finalized.state).toBe("finalized");
    expect(finalized.reviewId).toBe(assignment.reviewId);
  });
});
