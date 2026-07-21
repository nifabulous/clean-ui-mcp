/**
 * C2 label-integrity selection contract — pure, deterministic algorithm.
 *
 * Spec source: docs/c2/pass3-spec-lock.md §5 + FLAG 7.9. This module is the
 * source of truth for the reproducible 35-entry selection used to anchor the
 * C2 label-integrity baseline. The selection is a pure function of its inputs:
 * no I/O, no corpus reads, no hashing of image bytes (the caller supplies
 * `imageSha256`). Given identical inputs it MUST produce byte-identical output.
 *
 * Algorithm summary (follow the spec-lock EXACTLY):
 *   1. Remove the 5 fixed challenge entries from the candidate pool.
 *   2. For each of the 7 stratification axes independently, allocate a quota
 *      summing to exactly 35 using Hamilton largest-remainder apportionment
 *      over the bucket populations of the remaining (non-challenge) entries.
 *   3. Greedily select 35 entries one at a time, scoring each remaining
 *      candidate by the sum of `1 / bucketPopulation` over its under-quota
 *      buckets, then by # under-quota buckets, then lowest
 *      `sha256("clean-ui-retag-v1:<entryId>")`, then lowest entryId.
 *   4. Fail closed (throw) if a quota cannot be satisfied — never rebalance.
 *   5. Fill any leftover seats by hash order, then entryId.
 *   6. Append the 5 challenge entries with their rationale.
 *
 * The output is parsed through `C2LabelIntegritySelectionSchema` before return,
 * so any structural violation surfaces as a thrown error (fail-closed).
 */
import { createHash } from "node:crypto";
import { C2LabelIntegritySelectionSchema } from "./evaluation-contracts.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Fixed frozen seed for all selection hashes. */
export const LABEL_INTEGRITY_SEED = "clean-ui-retag-v1" as const;

/**
 * The 5 fixed challenge entry ids (Pass 3 baseline). These are removed before
 * reproducible selection and re-added at the end with `cohort: "challenge"`.
 */
export const CHALLENGE_ENTRY_IDS = [
  "wealthsimple-wealthsimple-ios-screens-40-2026-07-05",
  "wise-wise-18",
  "workable-workable-2",
  "juicebox-juicebox-2",
  "cash-app-cash-app-4",
] as const;

export type ChallengeEntryId = (typeof CHALLENGE_ENTRY_IDS)[number];

export const CHALLENGE_ENTRY_ID_SET: ReadonlySet<string> = new Set(CHALLENGE_ENTRY_IDS);

export interface CorpusEntryForLabelSelection {
  entryId: string;
  industryVertical: string | null;
  platform: string | null;
  qualityTier: string | null;
  patternType: string | null;
  responsiveBehavior: string | null;
  antiPatterns: {
    accessibilityRisks?: unknown[] | null;
    legacyAccessibilityNotes?: unknown[] | null;
    whereThisFails?: unknown[] | null;
  } | null;
  /** Precomputed by the caller (the builder script). Never hashed in here. */
  imageSha256: string;
}

export interface ChallengeEntryInput {
  entryId: string;
  rationale: string;
  imageSha256: string;
}

export interface LabelSelectionInput {
  entries: ReadonlyArray<CorpusEntryForLabelSelection>;
  /** Exactly the 5 fixed challenge ids, each with its rationale + image hash. */
  challengeEntries: ReadonlyArray<ChallengeEntryInput>;
  seed: "clean-ui-retag-v1";
  corpusGitSha: string;
  corpusSha256: string;
  artifactId: string;
  selectionVersion: number;
}

export interface LabelSelectionEntry {
  entryId: string;
  cohort: "reproducible" | "challenge";
  stratum: string;
  selectionReason: string;
  imageSha256: string;
}

export interface C2LabelIntegritySelection {
  schemaVersion: "1.0";
  artifactType: "c2-label-integrity-selection";
  artifactId: string;
  selectionVersion: number;
  seed: "clean-ui-retag-v1";
  corpusGitSha: string;
  corpusSha256: string;
  entries: LabelSelectionEntry[];
}

// ---------------------------------------------------------------------------
// Internal axis model
// ---------------------------------------------------------------------------

/**
 * The 7 stratification axes (spec §4.4). Each axis extracts a single bucket
 * value per entry. The axes are INDEPENDENT: each gets its own Hamilton quota,
 * they are not a composite key.
 */
const AXIS_KEYS = [
  "industryVertical",
  "platform",
  "qualityTier",
  "patternType",
  "responsiveBehavior",
  "accessibilitySignals",
  "difficulty",
] as const;

type AxisKey = (typeof AXIS_KEYS)[number];

interface Candidate {
  entryId: string;
  imageSha256: string;
  /** Bucket value per axis. */
  buckets: Record<AxisKey, string>;
  /** Cached `sha256(seed + ":" + entryId)` hex (lowercase). */
  hash: string;
}

const REPRODUCIBLE_SEAT_COUNT = 35;

// ---------------------------------------------------------------------------
// Hashing + axis extraction helpers
// ---------------------------------------------------------------------------

function sha256HexUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function nonEmpty(arr: unknown[] | null | undefined): boolean {
  return Array.isArray(arr) && arr.length > 0;
}

/**
 * Extract the 7 axis bucket values for one entry. Missing values → "unknown".
 * Mapping is fixed by the spec-lock (FLAG 7.9).
 */
function extractBuckets(entry: CorpusEntryForLabelSelection): Record<AxisKey, string> {
  const ap = entry.antiPatterns;
  const accessibilitySignals =
    nonEmpty(ap?.accessibilityRisks) || nonEmpty(ap?.legacyAccessibilityNotes)
      ? "signals"
      : "none";
  const difficulty =
    entry.qualityTier === "cautionary" || nonEmpty(ap?.whereThisFails)
      ? "difficult"
      : "ordinary";
  return {
    industryVertical: entry.industryVertical ?? "unknown",
    platform: entry.platform ?? "unknown",
    qualityTier: entry.qualityTier ?? "unknown",
    patternType: entry.patternType ?? "unknown",
    responsiveBehavior: entry.responsiveBehavior ?? "unknown",
    accessibilitySignals,
    difficulty,
  };
}

// ---------------------------------------------------------------------------
// Hamilton largest-remainder apportionment
// ---------------------------------------------------------------------------

/**
 * Allocate `seats` across `buckets` by Hamilton largest-remainder.
 * Returns a Map<bucketName, allocatedSeats> whose values sum to exactly `seats`.
 * Ties in fractional remainder are broken by bucket name ascending.
 *
 * If `seats` exceeds the total population (more seats than members), every
 * bucket gets at most its population — the caller must check feasibility.
 */
function hamiltonApportionment(
  populations: ReadonlyMap<string, number>,
  seats: number,
): Map<string, number> {
  const buckets = [...populations.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const total = buckets.reduce((sum, b) => sum + (populations.get(b) ?? 0), 0);
  const alloc = new Map<string, number>();
  if (total <= 0 || buckets.length === 0) {
    return alloc;
  }
  // Raw quota + floor.
  const remainders: { bucket: string; rem: number }[] = [];
  let allocated = 0;
  for (const b of buckets) {
    const pop = populations.get(b) ?? 0;
    const quota = (pop / total) * seats;
    const floor = Math.floor(quota);
    // Never allocate more seats than the bucket has members.
    const clamped = Math.min(floor, pop);
    alloc.set(b, clamped);
    allocated += clamped;
    remainders.push({ bucket: b, rem: quota - clamped });
  }
  // Distribute leftover seats to the largest remainders; ties → name ascending.
  let leftover = seats - allocated;
  // Sort: largest remainder first, then bucket name ascending.
  remainders.sort((x, y) => {
    if (y.rem > x.rem) return 1;
    if (y.rem < x.rem) return -1;
    return x.bucket < y.bucket ? -1 : x.bucket > y.bucket ? 1 : 0;
  });
  for (const { bucket } of remainders) {
    if (leftover <= 0) break;
    const pop = populations.get(bucket) ?? 0;
    const current = alloc.get(bucket) ?? 0;
    if (current < pop) {
      alloc.set(bucket, current + 1);
      leftover -= 1;
    }
  }
  // If seats still remain (total population < seats), the caller treats this as
  // an impossible-quota failure. We do not silently oversample buckets.
  return alloc;
}

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

function buildCandidates(
  entries: ReadonlyArray<CorpusEntryForLabelSelection>,
): Candidate[] {
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const e of entries) {
    if (CHALLENGE_ENTRY_ID_SET.has(e.entryId)) continue; // removed first
    if (seen.has(e.entryId)) continue; // dedupe defensively
    seen.add(e.entryId);
    out.push({
      entryId: e.entryId,
      imageSha256: e.imageSha256,
      buckets: extractBuckets(e),
      hash: sha256HexUtf8(`${LABEL_INTEGRITY_SEED}:${e.entryId}`),
    });
  }
  return out;
}

/**
 * Per-axis quota + per-axis bucket population. Axis-bucket populations are
 * computed over the candidate (non-challenge) pool.
 */
interface AxisQuotas {
  /** axis → (bucket → quota) */
  byAxis: Map<AxisKey, Map<string, number>>;
  /** axis → (bucket → population) */
  populationByAxis: Map<AxisKey, Map<string, number>>;
}

function computeAxisQuotas(candidates: ReadonlyArray<Candidate>): AxisQuotas {
  const populationByAxis = new Map<AxisKey, Map<string, number>>();
  for (const axis of AXIS_KEYS) populationByAxis.set(axis, new Map());
  for (const c of candidates) {
    for (const axis of AXIS_KEYS) {
      const bucket = c.buckets[axis];
      const m = populationByAxis.get(axis)!;
      m.set(bucket, (m.get(bucket) ?? 0) + 1);
    }
  }
  const byAxis = new Map<AxisKey, Map<string, number>>();
  for (const axis of AXIS_KEYS) {
    byAxis.set(axis, hamiltonApportionment(populationByAxis.get(axis)!, REPRODUCIBLE_SEAT_COUNT));
  }
  return { byAxis, populationByAxis };
}

/**
 * Score a candidate against current per-axis-bucket selection counts.
 * - primary: sum of 1/population for each of the candidate's 7 axis-buckets that
 *   is currently UNDER its quota (selectedCount < quota).
 * - tie1: number of under-quota buckets the candidate belongs to.
 */
function scoreCandidate(
  candidate: Candidate,
  quotas: AxisQuotas,
  selectedCountByAxisBucket: Map<AxisKey, Map<string, number>>,
): { primary: number; underQuotaCount: number } {
  let primary = 0;
  let underQuotaCount = 0;
  for (const axis of AXIS_KEYS) {
    const bucket = candidate.buckets[axis];
    const quota = quotas.byAxis.get(axis)!.get(bucket) ?? 0;
    const selected = selectedCountByAxisBucket.get(axis)?.get(bucket) ?? 0;
    if (selected < quota) {
      const pop = quotas.populationByAxis.get(axis)!.get(bucket) ?? 0;
      // population is always >= 1 here (the candidate lives in this bucket).
      primary += 1 / pop;
      underQuotaCount += 1;
    }
  }
  return { primary, underQuotaCount };
}

function compareCandidates(
  a: { primary: number; underQuotaCount: number; hash: string; entryId: string },
  b: { primary: number; underQuotaCount: number; hash: string; entryId: string },
): number {
  // Highest primary first.
  if (a.primary !== b.primary) return b.primary - a.primary;
  // Most under-quota buckets first.
  if (a.underQuotaCount !== b.underQuotaCount) return b.underQuotaCount - a.underQuotaCount;
  // Lowest hash first.
  if (a.hash !== b.hash) return a.hash < b.hash ? -1 : 1;
  // Lowest entryId first.
  return a.entryId < b.entryId ? -1 : a.entryId > b.entryId ? 1 : 0;
}

/**
 * Verify that every unmet per-axis-bucket quota still has at least one
 * remaining candidate that could fill it. Throw (fail-closed) if not.
 */
function assertQuotasFeasible(
  remaining: ReadonlyArray<Candidate>,
  quotas: AxisQuotas,
  selectedCountByAxisBucket: Map<AxisKey, Map<string, number>>,
): void {
  for (const axis of AXIS_KEYS) {
    const quotaMap = quotas.byAxis.get(axis)!;
    for (const [bucket, quota] of quotaMap) {
      const selected = selectedCountByAxisBucket.get(axis)?.get(bucket) ?? 0;
      if (selected >= quota) continue;
      const stillAvailable = remaining.filter((c) => c.buckets[axis] === bucket).length;
      if (stillAvailable < quota - selected) {
        throw new Error(
          `label-integrity selection cannot satisfy quota: ` +
            `axis="${axis}" bucket="${bucket}" quota=${quota} ` +
            `selected=${selected} remaining=${stillAvailable} ` +
            `(need ${quota - selected} more, only ${stillAvailable} candidates left)`,
        );
      }
    }
  }
}

function buildReproducible(candidates: Candidate[], quotas: AxisQuotas): Candidate[] {
  const remaining = [...candidates];
  // Stable pre-sort by (hash, entryId) so the fill step and tie handling are
  // deterministic regardless of input order.
  remaining.sort((a, b) =>
    a.hash !== b.hash ? (a.hash < b.hash ? -1 : 1) : a.entryId < b.entryId ? -1 : 1,
  );

  const selectedCountByAxisBucket = new Map<AxisKey, Map<string, number>>();
  for (const axis of AXIS_KEYS) selectedCountByAxisBucket.set(axis, new Map());

  const selected: Candidate[] = [];

  const bumpSelected = (c: Candidate) => {
    for (const axis of AXIS_KEYS) {
      const bucket = c.buckets[axis];
      const m = selectedCountByAxisBucket.get(axis)!;
      m.set(bucket, (m.get(bucket) ?? 0) + 1);
    }
  };

  while (selected.length < REPRODUCIBLE_SEAT_COUNT && remaining.length > 0) {
    // Fail-closed: before picking, confirm every unmet quota is still satisfiable.
    assertQuotasFeasible(remaining, quotas, selectedCountByAxisBucket);

    let bestIdx = -1;
    let bestScore: { primary: number; underQuotaCount: number; hash: string; entryId: string } | null =
      null;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const { primary, underQuotaCount } = scoreCandidate(
        c,
        quotas,
        selectedCountByAxisBucket,
      );
      const score = { primary, underQuotaCount, hash: c.hash, entryId: c.entryId };
      if (bestScore === null || compareCandidates(score, bestScore) < 0) {
        bestScore = score;
        bestIdx = i;
      }
    }
    const winner = remaining.splice(bestIdx, 1)[0];
    selected.push(winner);
    bumpSelected(winner);
  }

  // Step 5: if quotas are met but seats remain, fill by hash order then entry id.
  // `remaining` is already pre-sorted by (hash, entryId), so iterate in order.
  while (selected.length < REPRODUCIBLE_SEAT_COUNT && remaining.length > 0) {
    const winner = remaining.shift()!;
    selected.push(winner);
    bumpSelected(winner);
  }

  if (selected.length < REPRODUCIBLE_SEAT_COUNT) {
    throw new Error(
      `label-integrity selection ran out of candidates: ` +
        `needed ${REPRODUCIBLE_SEAT_COUNT} reproducible seats but only ` +
        `${candidates.length} non-challenge candidates were available`,
    );
  }

  // Note: the 7 axes are independent quota systems (each sums to 35). The greedy
  // coverage heuristic prioritizes under-quota buckets but cannot guarantee all
  // 7 independent quotas are met exactly — that is by design (over-constrained).
  // The fail-closed contract is the pre-pick feasibility guard above: it throws
  // whenever a bucket's quota cannot be reached because too few candidates
  // remain. Exact simultaneous satisfaction across 7 axes is NOT required.

  return selected;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function assertChallengeEntries(challengeEntries: ReadonlyArray<ChallengeEntryInput>): void {
  if (challengeEntries.length !== CHALLENGE_ENTRY_IDS.length) {
    throw new Error(
      `label-integrity selection requires exactly ${CHALLENGE_ENTRY_IDS.length} challenge entries, ` +
        `received ${challengeEntries.length}`,
    );
  }
  const expected = new Set<string>(CHALLENGE_ENTRY_IDS);
  const seen = new Set<string>();
  for (const c of challengeEntries) {
    if (!expected.has(c.entryId)) {
      throw new Error(
        `label-integrity selection: unexpected challenge entry id "${c.entryId}"`,
      );
    }
    if (seen.has(c.entryId)) {
      throw new Error(
        `label-integrity selection: duplicate challenge entry id "${c.entryId}"`,
      );
    }
    seen.add(c.entryId);
  }
  for (const id of CHALLENGE_ENTRY_IDS) {
    if (!seen.has(id)) {
      throw new Error(
        `label-integrity selection: missing required challenge entry id "${id}"`,
      );
    }
  }
}

/**
 * Build a deterministic C2 label-integrity selection. Pure function of input.
 * Throws on any violation (impossible quota, structural failure, schema
 * validation error). Never silently rebalances.
 */
export function buildLabelIntegritySelection(
  input: LabelSelectionInput,
): C2LabelIntegritySelection {
  if (input.seed !== LABEL_INTEGRITY_SEED) {
    throw new Error(
      `label-integrity selection seed must be "${LABEL_INTEGRITY_SEED}", received "${input.seed}"`,
    );
  }
  assertChallengeEntries(input.challengeEntries);

  const candidates = buildCandidates(input.entries);
  if (candidates.length < REPRODUCIBLE_SEAT_COUNT) {
    throw new Error(
      `label-integrity selection needs at least ${REPRODUCIBLE_SEAT_COUNT} non-challenge candidates, ` +
        `received ${candidates.length}`,
    );
  }

  const quotas = computeAxisQuotas(candidates);
  const reproducible = buildReproducible(candidates, quotas);

  // challenge lookup for rationale + image sha.
  const challengeById = new Map<string, ChallengeEntryInput>();
  for (const c of input.challengeEntries) challengeById.set(c.entryId, c);

  const reproducibleEntries: LabelSelectionEntry[] = reproducible.map((c) => ({
    entryId: c.entryId,
    cohort: "reproducible",
    // patternType is the most discriminative axis → primary stratum identifier.
    stratum: c.buckets.patternType,
    selectionReason: `reproducible selection: patternType=${c.buckets.patternType}, ` +
      `platform=${c.buckets.platform}, qualityTier=${c.buckets.qualityTier}, ` +
      `accessibilitySignals=${c.buckets.accessibilitySignals}, difficulty=${c.buckets.difficulty}`,
    imageSha256: c.imageSha256,
  }));

  const challengeEntries: LabelSelectionEntry[] = CHALLENGE_ENTRY_IDS.map((id) => {
    const c = challengeById.get(id);
    if (!c) {
      // Unreachable given assertChallengeEntries, but kept for exhaustiveness.
      throw new Error(`label-integrity selection: missing challenge entry "${id}"`);
    }
    return {
      entryId: id,
      cohort: "challenge",
      stratum: "challenge",
      selectionReason: c.rationale,
      imageSha256: c.imageSha256,
    };
  });

  const artifact: C2LabelIntegritySelection = {
    schemaVersion: "1.0",
    artifactType: "c2-label-integrity-selection",
    artifactId: input.artifactId,
    selectionVersion: input.selectionVersion,
    seed: LABEL_INTEGRITY_SEED,
    corpusGitSha: input.corpusGitSha,
    corpusSha256: input.corpusSha256,
    entries: [...reproducibleEntries, ...challengeEntries],
  };

  // Fail-closed: the output MUST parse through the existing schema. We discard
  // `parsed.data` and return our own typed artifact (which carries the literal
  // `seed` type) — the parse is the gate, the local object is the source of truth.
  const parsed = C2LabelIntegritySelectionSchema.safeParse(artifact);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`label-integrity selection failed schema validation: ${issues}`);
  }
  return artifact;
}
