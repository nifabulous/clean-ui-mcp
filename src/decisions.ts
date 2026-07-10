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
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { writeAtomic } from "./persistence.js";
import {
  Decisions,
  type DecisionT,
  type DecisionContextT,
} from "./schema.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = resolve(__dirname, "..", "corpus");
export const DECISIONS_PATH = resolve(CORPUS_ROOT, "decisions.json");
const DECISION_SNAPSHOT_DIR = resolve(CORPUS_ROOT, ".snapshots");
const DECISION_SNAPSHOT_KEEP = 20;

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
  if (!existsSync(DECISIONS_PATH)) {
    cached = [];
    return cached;
  }
  cached = parseDecisions(readFileSync(DECISIONS_PATH, "utf-8"));
  return cached;
}

/** Write a rolling snapshot of the current decisions (best-effort, never throws). */
function writeDecisionSnapshot(decisions: DecisionT[]): void {
  try {
    if (!existsSync(DECISION_SNAPSHOT_DIR)) mkdirSync(DECISION_SNAPSHOT_DIR, { recursive: true });
    const name = `decisions-${Date.now()}.json`;
    writeAtomic(resolve(DECISION_SNAPSHOT_DIR, name), JSON.stringify({ version: 1, decisions }, null, 2));
    // Trim to KEEP
    const snaps = readdirSync(DECISION_SNAPSHOT_DIR)
      .filter((f) => /^decisions-\d+\.json$/.test(f))
      .sort()
      .reverse();
    for (const old of snaps.slice(DECISION_SNAPSHOT_KEEP)) {
      try { rmSync(resolve(DECISION_SNAPSHOT_DIR, old), { force: true }); } catch { /* best-effort */ }
    }
  } catch { /* snapshots are best-effort */ }
}

/** Persist the full decisions array to disk atomically + snapshot. */
export function persistDecisions(decisions: DecisionT[]): void {
  writeDecisionSnapshot(decisions);
  writeAtomic(DECISIONS_PATH, JSON.stringify({ version: 1, decisions }, null, 2));
  cached = decisions;
}

/** Create a new decision shell (no directions yet — added by the UI). */
export function createDecision(input: {
  title: string;
  targetUser: string;
  businessGoal: string;
  primaryKpi: string;
  scope: "screen" | "flow";
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
    scope: input.scope,
    directions: [],
  };
}

/** Upsert a decision by id. Preserves any updatedAt the caller set explicitly;
 *  only stamps today when the decision carries no updatedAt (defensive). This
 *  mirrors how corpus entries preserve their addedAt and lets callers control
 *  ordering (e.g. tests that pin a decision to a fixed date). */
export function saveDecision(decision: DecisionT): void {
  const all = loadDecisionsSafe();
  const idx = all.findIndex((d) => d.id === decision.id);
  if (!decision.updatedAt) {
    decision.updatedAt = new Date().toISOString().slice(0, 10);
  }
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
