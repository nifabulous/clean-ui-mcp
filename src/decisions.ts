/**
 * decisions.ts — Decision Lab persistence.
 *
 * Mirrors corpus.ts (module-level cache + test injection) and persistence.ts
 * (atomic writes + rolling snapshots). Decisions live in a separate
 * decisions.json sidecar, independent from the curated corpus.
 *
 * Path resolution mirrors corpus.ts: this file lives in src/, so the corpus
 * directory is one level up. We use fileURLToPath + dirname rather than
 * import.meta.dirname for parity with the rest of the codebase (corpus.ts,
 * embeddings.ts, paths.ts all resolve this way).
 */
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync, renameSync } from "node:fs";
import { writeAtomic } from "./persistence.js";
import {
  Decisions,
  type DecisionT,
  type DecisionContextT,
} from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = resolve(__dirname, "..", "corpus");

/** Default decisions.json location (kept as an export for reference, e.g.
 *  .gitignore documentation). Internal code reads the `decisionsPath` let. */
// Note: decisions.json path is resolved inline where needed; no separate constant needed.

/** Mutable internal paths — overridable via setDecisionsPathsForTesting so
 *  tests can target a temp dir without polluting the real corpus. */
let decisionsPath = resolve(CORPUS_ROOT, "decisions.json");
let decisionSnapshotDir = resolve(CORPUS_ROOT, ".snapshots");
const DECISION_SNAPSHOT_KEEP = 20;

/** Test-only path override. Pass temp dirs to avoid polluting the real corpus. */
export function setDecisionsPathsForTesting(opts: { path?: string; snapshotDir?: string }): void {
  if (opts.path) decisionsPath = opts.path;
  if (opts.snapshotDir) decisionSnapshotDir = opts.snapshotDir;
}

/** Test-only restore to the default corpus paths. */
export function resetDecisionsPathsForTesting(): void {
  decisionsPath = resolve(CORPUS_ROOT, "decisions.json");
  decisionSnapshotDir = resolve(CORPUS_ROOT, ".snapshots");
}

/** Module-level cache (mirrors corpus.ts). */
let cached: DecisionT[] | null = null;

/** Test-only override of the cache (mirrors setCorpusForTesting). */
export function setDecisionsForTesting(decisions: DecisionT[] | null): void {
  cached = decisions;
}

/** Slugify a title into a kebab-case id prefix. */
function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "decision";
}

/** Generate a unique id from title + timestamp.
 *
 *  Uniqueness is explicit: the bare form is `<slug>-<6-char base36 stamp>`. If
 *  that id is already in `existing`, a `-<n>` counter is appended (starting at
 *  2) and walked forward until a free slot is found. This closes two collision
 *  windows the previous stamp-only scheme had:
 *    1. Two same-title creates within the same millisecond (same stamp).
 *    2. The 6-char base36 stamp wraps every ~25 days, so a title created in
 *       two different months could collide even with no concurrency.
 *  Pass the set of ids already in the store so the check is exact. Exported
 *  for direct unit testing of the disambiguation contract. */
export function generateDecisionId(title: string, existing: ReadonlySet<string> = new Set()): string {
  const slug = slugify(title);
  const stamp = Date.now().toString(36).slice(-6);
  let id = `${slug}-${stamp}`;
  for (let n = 2; existing.has(id); n++) id = `${slug}-${stamp}-${n}`;
  return id;
}

/** Parse and validate the decisions.json sidecar.
 *  Returns the decisions array on success, or null if the file is missing,
 *  unreadable, or fails schema validation. Returning null (not []) lets the
 *  caller distinguish "corrupt — try snapshot recovery" from "legitimately
 *  empty", mirroring corpus.ts's tryReadCorpus → null contract. */
function parseDecisions(raw: string): DecisionT[] | null {
  try {
    const parsed = Decisions.parse(JSON.parse(raw));
    return parsed.decisions;
  } catch {
    return null;
  }
}

/** Return the newest parseable decision snapshot, or null if none exist.
 *  Mirrors persistence.ts's listSnapshots: filters `^decisions-(\d+)\.json$`,
 *  sorts by the embedded epoch descending, and returns the first one that
 *  parses. Older/corrupt snapshots are skipped, not fatal. */
function newestValidSnapshot(): DecisionT[] | null {
  let snaps: { name: string; epoch: number }[];
  try {
    snaps = readdirSync(decisionSnapshotDir)
      .filter((f) => /^decisions-(\d+)\.json$/.test(f))
      .map((f) => ({ name: f, epoch: Number(f.match(/^decisions-(\d+)\.json$/)?.[1] ?? 0) }))
      .sort((a, b) => b.epoch - a.epoch);
  } catch {
    return null; // snapshot dir missing/unreadable
  }
  for (const snap of snaps) {
    try {
      const raw = readFileSync(resolve(decisionSnapshotDir, snap.name), "utf-8");
      const parsed = Decisions.parse(JSON.parse(raw));
      return parsed.decisions;
    } catch {
      continue; // this snapshot is corrupt/unreadable — try the next older one
    }
  }
  return null;
}

/** Load decisions from disk with a corrupt-file recovery chain. Mirrors the
 *  corpus hardening (loadCorpusSafe): a corrupt primary must NOT silently wipe
 *  Decision Lab data.
 *
 *   1. cached                       → return cached.
 *   2. primary missing              → cached=[], return.
 *   3. primary parses               → cache, return.
 *   4. primary corrupt (parse fail) → rename the primary aside as
 *      `decisions.json.corrupt-<epoch>` (best-effort, never throws) to
 *      preserve forensic evidence, then recover from the newest valid
 *      snapshot. If no snapshot exists either (true cold start), return [].
 *
 *  The rename happens BEFORE recovery so the corrupt bytes are never
 *  overwritten: persistDecisions writes the primary via writeAtomic, which
 *  would clobber the corrupt file if it were still in place. By the time
 *  persistDecisions runs, the primary path is free (renamed aside) and the
 *  cache holds the recovered set, so the next save persists the recovered
 *  data — not []. */
export function loadDecisionsSafe(): DecisionT[] {
  if (cached) return cached;
  if (!existsSync(decisionsPath)) {
    cached = [];
    return cached;
  }
  const parsed = parseDecisions(readFileSync(decisionsPath, "utf-8"));
  if (parsed) {
    cached = parsed;
    return cached;
  }

  // Primary is present but corrupt — preserve it for forensics before any
  // recovery write can clobber the path. Best-effort: a failed rename must
  // not prevent snapshot recovery or crash the caller.
  try {
    renameSync(decisionsPath, `${decisionsPath}.corrupt-${Date.now()}`);
  } catch {
    /* best-effort — continue to snapshot recovery regardless */
  }
  console.error(
    `[decisions] decisions.json was corrupt — renamed aside for forensics and attempting snapshot recovery.`,
  );

  cached = newestValidSnapshot() ?? [];
  if (cached.length > 0) {
    console.error(`[decisions] recovered ${cached.length} decision(s) from a snapshot.`);
  } else {
    console.error(`[decisions] no valid snapshot found — starting empty.`);
  }
  return cached;
}

/** Write a rolling snapshot of the current decisions (best-effort, never throws). */
function writeDecisionSnapshot(decisions: DecisionT[]): void {
  try {
    if (!existsSync(decisionSnapshotDir)) mkdirSync(decisionSnapshotDir, { recursive: true });
    const name = `decisions-${Date.now()}.json`;
    writeAtomic(resolve(decisionSnapshotDir, name), JSON.stringify({ version: 1, decisions }, null, 2));
    // Trim to KEEP — sort by the embedded epoch numerically (not lexicographically),
    // mirroring persistence.ts's listSnapshots.
    const snaps = readdirSync(decisionSnapshotDir)
      .filter((f) => /^decisions-(\d+)\.json$/.test(f))
      .map((f) => ({ name: f, epoch: Number(f.match(/^decisions-(\d+)\.json$/)?.[1] ?? 0) }))
      .sort((a, b) => b.epoch - a.epoch);
    for (const old of snaps.slice(DECISION_SNAPSHOT_KEEP)) {
      try { rmSync(resolve(decisionSnapshotDir, old.name), { force: true }); } catch { /* best-effort */ }
    }
  } catch { /* snapshots are best-effort */ }
}

/** Persist the full decisions array to disk atomically + snapshot. */
export function persistDecisions(decisions: DecisionT[]): void {
  writeDecisionSnapshot(decisions);
  writeAtomic(decisionsPath, JSON.stringify({ version: 1, decisions }, null, 2));
  cached = decisions;
}

/** Create a new decision shell (no directions yet — added by the UI). */
export function createDecision(input: {
  title: string;
  targetUser: string;
  businessGoal: string;
  primaryKpi: string;
  /** Defaults to "screen"; "flow" is not supported in increment 1 (rejected by
   *  the Decision schema). */
  scope?: "screen";
  platform?: "web" | "mobile" | "tablet";
  constraints?: string;
}): DecisionT {
  const today = new Date().toISOString().slice(0, 10);
  const context: DecisionContextT = {
    targetUser: input.targetUser,
    businessGoal: input.businessGoal,
    primaryKpi: input.primaryKpi,
    ...(input.platform ? { platform: input.platform } : {}),
    ...(input.constraints ? { constraints: input.constraints } : {}),
  };
  return {
    id: generateDecisionId(input.title, new Set(loadDecisionsSafe().map((d) => d.id))),
    title: input.title,
    createdAt: today,
    updatedAt: today,
    context,
    scope: input.scope ?? "screen",
    directions: [],
  };
}

/** Upsert a decision by id. Always bumps updatedAt to today so the list reflects
 *  when a decision was actually edited. Tests that need to pin a timestamp
 *  should write via persistDecisions directly. */
export function saveDecision(decision: DecisionT): void {
  const all = loadDecisionsSafe();
  const idx = all.findIndex((d) => d.id === decision.id);
  decision.updatedAt = new Date().toISOString().slice(0, 10);
  if (idx >= 0) all[idx] = decision;
  else all.push(decision);
  persistDecisions(all);
}

/** Get a single decision by id. */
export function getDecisionById(id: string): DecisionT | undefined {
  return loadDecisionsSafe().find((d) => d.id === id);
}

/** List all decisions, newest-first by updatedAt. */
export function listDecisions(): DecisionT[] {
  return [...loadDecisionsSafe()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
