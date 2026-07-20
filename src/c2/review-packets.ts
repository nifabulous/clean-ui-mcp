/**
 * C2 metadata-blinded review packets (Task 8, Step 4).
 *
 * The blinding protocol from spec §10 is procedural and system-enforced:
 *
 *   1. After a complete review batch exists, the trusted operator mints one
 *      private assignment per (run, reviewer) pair. Each assignment carries a
 *      cryptographically random `reviewId` produced by `crypto.randomUUID()`.
 *      The reviewId is NOT derived from the candidate hash, the runId, the
 *      output hash, or any condition metadata — it carries zero information
 *      about which condition produced the candidate.
 *
 *   2. `buildBlindedReviewPacket` returns the reviewer-visible artifact: ONLY
 *      `{ reviewId, candidate }`. Provider, model, condition, run ID, output
 *      hash, run ordering, prompt, evidence source labels, and private paths
 *      never reach the packet.
 *
 *   3. The reviewer scores via `C2BlindScoreSubmission` (which the schema
 *      refuses to extend with run/hash/condition/provider fields).
 *
 *   4. `finalizeBlindScorecard` is the ONLY path that resolves the private map
 *      AFTER submission. It verifies the assigned reviewer, atomically
 *      transitions the map entry `assigned` → `finalized`, and creates the
 *      canonical `C2HumanScorecard` bound to `runId` + `runOutputSha256` with
 *      `blindedCondition: true`. Reuse, double-finalization, or an unknown id
 *      fails closed.
 *
 * The guarantee does NOT claim to erase clues inherent in the candidate prose,
 * or to protect against a reviewer who independently opens `.c2-private/`,
 * durable run manifests, or operator logs. The campaign instructions must keep
 * those unavailable during review.
 *
 * The reversible map lives under `.c2-private/c2/blind-map.json` and is the
 * ONLY place the binding is stored. It never appears in durable artifacts,
 * logs, packet filenames beyond the UUID itself, or reviewer-visible output.
 */
import { randomUUID, randomInt as cryptoRandomInt } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  C2BlindScoreSubmissionSchema,
  C2HumanScorecardSchema,
  type C2BlindScoreSubmission,
  type C2HumanScorecard,
} from "./evaluation-contracts.js";
import type { C2CandidateArtifact } from "./candidate-contracts.js";

// ---------------------------------------------------------------------------
// Private blind-map entry + injected store
// ---------------------------------------------------------------------------

/**
 * ONE reversible binding. Lives only in the private blind-map store. The state
 * machine is `assigned` → `finalized`; the transition is monotonic.
 */
export interface BlindMapEntry {
  reviewId: string;
  runId: string;
  runOutputSha256: string;
  assignedReviewerActorId: string;
  state: "assigned" | "finalized";
}

/**
 * Injected store for the private blind map. The default implementation reads
 * and writes `.c2-private/c2/blind-map.json`; tests inject an in-memory store
 * so the suite never touches a real private directory.
 *
 * Contract:
 *   - `load()` returns a fresh copy of every entry (no live references).
 *   - `upsert(entry)` writes a NEW entry. Reusing an existing `reviewId` MUST
 *     throw — the protocol never overwrites a map entry.
 *   - `transition(reviewId, fromState, toState)` performs an atomic
 *     compare-and-swap. Returns true when the current state matches
 *     `fromState` and the transition succeeded; returns false otherwise
 *     (including when the reviewId is unknown). The caller interprets a false
 *     return as a fail-closed error (so a benign "already finalized" and a
 *     malicious "reused id" both refuse the scorecard).
 *
 * Concurrency scope: this store is safe for single-process serial execution
 * only. The compare-and-swap is atomic with respect to the JS event loop (no
 * await between read and write), but NOT across processes or concurrent async
 * flows. The C2 pilot is single-process serial by design — the file-backed
 * implementation makes no cross-process locking guarantee.
 */
export interface BlindMapStore {
  load(): Promise<BlindMapEntry[]>;
  upsert(entry: BlindMapEntry): Promise<void>;
  transition(reviewId: string, fromState: "assigned" | "finalized", toState: "assigned" | "finalized"): Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Private assignment (the reversible binding held by the operator)
// ---------------------------------------------------------------------------

/**
 * The private assignment record returned to the trusted operator. This is the
 * ONLY artifact that joins a `reviewId` to its run + output binding; the
 * reviewer-visible packet (`buildBlindedReviewPacket`) drops every field
 * except `reviewId` and `candidate`.
 */
export interface BlindAssignment {
  reviewId: string;
  runId: string;
  runOutputSha256: string;
  assignedReviewerActorId: string;
  state: "assigned" | "finalized";
}

/** Inputs for one assignment. The candidate is held privately and only its
 * SHA-256-binding-relevant fields enter the map. */
export interface BlindAssignmentInput {
  runId: string;
  runOutputSha256: string;
  candidate: C2CandidateArtifact;
  assignedReviewerActorId: string;
}

/** Reviewer-visible packet. The two fields below are the ONLY fields. */
export interface BlindedReviewPacket {
  reviewId: string;
  candidate: C2CandidateArtifact;
}

// ---------------------------------------------------------------------------
// createBlindAssignment
// ---------------------------------------------------------------------------

export interface CreateBlindAssignmentDeps {
  store: BlindMapStore;
  /** Canonical clock; defaults to `new Date().toISOString()`. */
  now?: () => string;
  /**
   * Source of cryptographic randomness. Defaults to `crypto.randomUUID`.
   * Injected so tests can force collisions deterministically.
   */
  randomUuid?: () => string;
}

/**
 * Mint a private assignment for one (run, reviewer) pair. Generates a fresh
 * `reviewId` via `crypto.randomUUID()` and persists the reversible map entry
 * with `state: "assigned"`. Refuses to overwrite an existing reviewId (fail
 * closed at the store seam).
 */
export async function createBlindAssignment(
  input: BlindAssignmentInput,
  deps: CreateBlindAssignmentDeps,
): Promise<BlindAssignment> {
  if (!input.runId || input.runId.trim().length === 0) {
    throw new Error("[c2-blind] createBlindAssignment requires a non-empty runId");
  }
  if (!input.runOutputSha256 || input.runOutputSha256.trim().length === 0) {
    throw new Error("[c2-blind] createBlindAssignment requires a non-empty runOutputSha256");
  }
  if (!input.assignedReviewerActorId || input.assignedReviewerActorId.trim().length === 0) {
    throw new Error("[c2-blind] createBlindAssignment requires a non-empty assignedReviewerActorId");
  }

  const randomUuid = deps.randomUuid ?? defaultRandomUuid;
  const reviewId = randomUuid();
  if (!UUID_RE.test(reviewId)) {
    throw new Error(`[c2-blind] injected randomUuid did not return a UUID: ${reviewId}`);
  }

  const entry: BlindMapEntry = {
    reviewId,
    runId: input.runId,
    runOutputSha256: input.runOutputSha256,
    assignedReviewerActorId: input.assignedReviewerActorId,
    state: "assigned",
  };
  // upsert throws on a reviewId collision. The candidate never enters the map
  // — only its (runId, runOutputSha256) binding does.
  await deps.store.upsert(entry);
  void input.candidate; // candidate is held privately by the caller; only its hash binding enters the map.
  return { ...entry };
}

// ---------------------------------------------------------------------------
// buildBlindedReviewPacket
// ---------------------------------------------------------------------------

/**
 * Build the reviewer-visible packet from a private assignment + the candidate
 * content. Returns ONLY `{ reviewId, candidate }`. Every other field on the
 * assignment (runId, runOutputSha256, assignedReviewerActorId, state) is
 * intentionally dropped.
 */
export function buildBlindedReviewPacket(
  assignment: BlindAssignment,
  candidate: C2CandidateArtifact,
): BlindedReviewPacket {
  // Destructure to make the field-set assertion explicit at the source: the
  // returned object literal literally names only reviewId and candidate. A
  // future edit that adds a field here must also update the blinding tests.
  const { reviewId } = assignment;
  return { reviewId, candidate };
}

// ---------------------------------------------------------------------------
// finalizeBlindScorecard
// ---------------------------------------------------------------------------

export interface FinalizeBlindScorecardDeps {
  store: BlindMapStore;
  /** Canonical clock for `scoredAt`. Defaults to `new Date().toISOString()`. */
  now?: () => string;
  /**
   * Build the canonical scorecard artifactId from the reviewId. Default:
   * `c2-scorecard-<reviewId>`.
   */
  artifactId?: (reviewId: string) => string;
  /**
   * Verify the submitting reviewer against the assigned reviewer. Default:
   * exact `reviewerActorId` match. The CLI may inject a richer verifier
   * (e.g. an actor-directory lookup) without changing the protocol.
   */
  verifyReviewer?: (submission: C2BlindScoreSubmission, assigned: BlindMapEntry) => boolean;
}

/**
 * Finalize a blind submission into the canonical `C2HumanScorecard`.
 *
 * Steps (every failure refuses the scorecard AND leaves the map entry in its
 * prior state — fail closed):
 *   1. Parse the submission through `C2BlindScoreSubmissionSchema` so a smuggled
 *      run/hash/condition/provider field is rejected by the schema, not by
 *      this reducer.
 *   2. Resolve the private map entry for `submission.reviewId`. Unknown id ⇒
 *      throw.
 *   3. Verify the assigned reviewer matches the submitting reviewer.
 *   4. Atomically transition the map entry `assigned` → `finalized`. A false
 *      return (unknown, reused, or already-finalized) ⇒ throw.
 *   5. Build the canonical `C2HumanScorecard` bound to the resolved runId +
 *      runOutputSha256, with `blindedCondition: true`. Parse through the
 *      schema (which derives `implementationReady` from the per-dimension
 *      floor of 3).
 */
export async function finalizeBlindScorecard(
  submission: C2BlindScoreSubmission,
  deps: FinalizeBlindScorecardDeps,
): Promise<C2HumanScorecard> {
  // 1. Strict parse — refuses smuggled identifying fields.
  const parsed = C2BlindScoreSubmissionSchema.safeParse(submission);
  if (!parsed.success) {
    throw new Error(
      `[c2-blind] finalizeBlindScorecard received a submission that failed C2BlindScoreSubmissionSchema: ${parsed.error.message}`,
    );
  }
  const safe = parsed.data;

  // 2. Resolve the private map.
  const entries = await deps.store.load();
  const entry = entries.find((e) => e.reviewId === safe.reviewId);
  if (!entry) {
    throw new Error(`[c2-blind] finalizeBlindScorecard: unknown reviewId ${safe.reviewId}`);
  }

  // 3. Verify the reviewer.
  const verify = deps.verifyReviewer ?? defaultVerifyReviewer;
  if (!verify(safe, entry)) {
    throw new Error(
      `[c2-blind] finalizeBlindScorecard: reviewer '${safe.reviewerActorId}' does not match the assigned reviewer '${entry.assignedReviewerActorId}' for reviewId ${safe.reviewId}`,
    );
  }

  // 4. Atomic transition. A false return covers unknown (already checked above
  //    but defensively handled), reused, or already-finalized ids.
  const ok = await deps.store.transition(safe.reviewId, "assigned", "finalized");
  if (!ok) {
    throw new Error(
      `[c2-blind] finalizeBlindScorecard: reviewId ${safe.reviewId} could not transition assigned → finalized (unknown, reused, or already finalized)`,
    );
  }

  // 5. Build the canonical scorecard.
  const now = deps.now ?? defaultNow;
  const artifactId = deps.artifactId ?? defaultArtifactId;
  const allMeetsFloor = safe.scores.every((s) => s.score >= 3);
  const scorecard: C2HumanScorecard = {
    schemaVersion: "1.0",
    artifactType: "c2-human-scorecard",
    artifactId: artifactId(safe.reviewId),
    runId: entry.runId,
    runOutputSha256: entry.runOutputSha256,
    reviewerActorId: safe.reviewerActorId,
    reviewerActorKind: "human",
    blindedCondition: true,
    scores: safe.scores,
    implementationReady: allMeetsFloor,
    scoredAt: now(),
  };
  // Parse through the schema. The schema's superRefine re-derives
  // implementationReady from the floor, so a caller cannot lie about it.
  return C2HumanScorecardSchema.parse(scorecard);
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function defaultRandomUuid(): string {
  return randomUUID();
}

function defaultNow(): string {
  return new Date().toISOString();
}

function defaultArtifactId(reviewId: string): string {
  return `c2-scorecard-${reviewId}`;
}

function defaultVerifyReviewer(submission: C2BlindScoreSubmission, assigned: BlindMapEntry): boolean {
  return submission.reviewerActorId === assigned.assignedReviewerActorId;
}

// ---------------------------------------------------------------------------
// shufflePackets — packet-order shuffle with crypto.randomInt() rejection sampling
// ---------------------------------------------------------------------------

/**
 * Shuffle packet order with rejection sampling over `crypto.randomInt()`
 * (spec §10). The shuffle is Fisher-Yates: for `i` from `n-1` down to `1`,
 * pick a uniform index `j ∈ [0, i]` and swap items[i] ↔ items[j].
 *
 * `randomInt(max)` MUST return a uniformly distributed integer in `[0, max)`.
 * The default is `crypto.randomInt`, which already uses rejection sampling
 * internally to avoid modulo bias. To keep the guarantee robust against a
 * caller-supplied source that does NOT do its own rejection sampling, the
 * helper additionally applies rejection sampling on the raw output for every
 * draw: it computes the largest multiple of the bucket size `≤ 2^32`, redraws
 * while the raw value falls in the rejected tail, then reduces modulo `max`.
 * For `crypto.randomInt` (already unbiased) the tail is empty and the loop
 * terminates in one draw.
 *
 * `randomInt` is injected so tests can drive the shuffle deterministically with
 * a seeded source. The helper returns a NEW array; it never mutates the input.
 */
export function shufflePackets<T>(items: readonly T[], randomInt: (max: number) => number = cryptoRandomInt): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    // `i + 1` possible indices in [0, i].
    const j = unbiasedIndex(i + 1, randomInt);
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * Draw a uniform integer in `[0, max)` from `randomInt(2^32)` using rejection
 * sampling. We treat the raw draw as a 32-bit unsigned value (the integer
 * range `crypto.randomInt(max)` already handles internally). The injected
 * `randomInt` is called with `2^32` so the rejection tail is well-defined for
 * any source; if the caller's `randomInt` cannot handle that range it should
 * itself implement the rejection loop, but the contract here is `max ≤ 2^32`.
 *
 * For the default `crypto.randomInt`, we short-circuit and call
 * `randomInt(max)` directly because Node's implementation is already unbiased
 * and that is the documented spec primitive.
 */
function unbiasedIndex(max: number, randomInt: (max: number) => number): number {
  if (max <= 0) return 0;
  if (max === 1) return 0;
  // Default fast path: crypto.randomInt is unbiased via its own rejection
  // sampling. We detect the default by reference so a caller that passes the
  // same function gets the fast path too.
  if (randomInt === cryptoRandomInt) {
    return randomInt(max);
  }
  // General rejection sampling over a 32-bit range. The bucket size is the
  // largest multiple of `max` that fits in 2^32; redraw while the raw value is
  // >= bucketSize (the biased tail). Then reduce modulo `max`.
  const RANGE = 0x100000000; // 2^32
  const bucketSize = Math.floor(RANGE / max);
  const rejectionLimit = bucketSize * max; // values in [bucketSize*max, 2^32) are rejected
  let raw = randomInt(RANGE);
  // Guard against a source that only emits small ints: bounded redraws.
  let attempts = 0;
  while (raw >= rejectionLimit && attempts < 32) {
    raw = randomInt(RANGE);
    attempts++;
  }
  return raw % max;
}

// ---------------------------------------------------------------------------
// createFileBlindMapStore — file-backed reversible map under .c2-private/c2/
// ---------------------------------------------------------------------------

/**
 * File-backed `BlindMapStore`. The reversible map lives ONLY at
 * `<privateDir>/blind-map.json` (default privateDir resolves to
 * `.c2-private/c2`, so the canonical path is `.c2-private/c2/blind-map.json`).
 *
 * Writes are atomic: the new contents are serialized to canonical JSON, written
 * to a temp sibling file, then `rename`d over the target. Reads parse the file
 * if it exists, or return an empty list if it does not. `upsert` fails closed
 * on a `reviewId` collision (the protocol never overwrites a map entry).
 * `transition` performs an atomic compare-and-swap by re-reading, mutating, and
 * re-writing the full file under the same atomic-write discipline.
 *
 * Concurrency scope: this store is safe for single-process serial execution
 * only. The compare-and-swap is atomic with respect to the JS event loop — the
 * `transition` body performs no `await` between `readAll()` and
 * `atomicWrite()`, so no other microtask can interleave a mutation within one
 * process. It is NOT atomic across processes or across concurrent async flows
 * that await between read and write. The C2 pilot is single-process serial by
 * design: a single-process operator holds the only handle to `.c2-private/`,
 * so a single JSON file is the correct granularity and no cross-process
 * locking is provided (or needed).
 */
export function createFileBlindMapStore(privateDir: string): BlindMapStore {
  const targetPath = join(privateDir, "blind-map.json");

  function ensureDir(): void {
    if (!existsSync(privateDir)) {
      mkdirSync(privateDir, { recursive: true });
    }
  }

  function atomicWrite(text: string): void {
    ensureDir();
    const tmp = `${targetPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(tmp, text, "utf8");
    renameSync(tmp, targetPath);
  }

  function readAll(): BlindMapEntry[] {
    if (!existsSync(targetPath)) return [];
    const raw = readFileSync(targetPath, "utf8");
    if (raw.trim().length === 0) return [];
    const parsed = JSON.parse(raw) as BlindMapEntry[];
    if (!Array.isArray(parsed)) {
      throw new Error(`[c2-blind] blind-map.json must contain an array (got ${typeof parsed})`);
    }
    return parsed.map((entry) => ({ ...entry }));
  }

  function serialize(entries: BlindMapEntry[]): string {
    return JSON.stringify(entries);
  }

  return {
    async load(): Promise<BlindMapEntry[]> {
      return readAll();
    },
    async upsert(entry: BlindMapEntry): Promise<void> {
      const entries = readAll();
      if (entries.some((e) => e.reviewId === entry.reviewId)) {
        throw new Error(`[c2-blind] reviewId already exists in blind-map.json: ${entry.reviewId}`);
      }
      entries.push({ ...entry });
      atomicWrite(serialize(entries));
    },
    async transition(reviewId, fromState, toState): Promise<boolean> {
      const entries = readAll();
      const target = entries.find((e) => e.reviewId === reviewId);
      if (!target) return false;
      if (target.state !== fromState) return false;
      target.state = toState;
      atomicWrite(serialize(entries));
      return true;
    },
  };
}
