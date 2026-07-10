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
import { readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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
export const DEFAULT_DECISIONS_PATH = resolve(CORPUS_ROOT, "decisions.json");

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

/** Generate a unique id from title + timestamp. */
function generateDecisionId(title: string): string {
  const slug = slugify(title);
  const stamp = Date.now().toString(36).slice(-6);
  return `${slug}-${stamp}`;
}

/** Parse and validate the decisions.json sidecar. Returns [] if missing/corrupt. */
function parseDecisions(raw: string): DecisionT[] {
  try {
    const parsed = Decisions.parse(JSON.parse(raw));
    return parsed.decisions;
  } catch {
    return [];
  }
}

/** Load decisions from disk with fallback to []. Mirrors loadCorpusSafe but
 *  simpler — decisions are regenerable from re-analysis, no seed fallback. */
export function loadDecisionsSafe(): DecisionT[] {
  if (cached) return cached;
  if (!existsSync(decisionsPath)) {
    cached = [];
    return cached;
  }
  cached = parseDecisions(readFileSync(decisionsPath, "utf-8"));
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
    id: generateDecisionId(input.title),
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
