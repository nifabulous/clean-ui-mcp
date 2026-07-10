# Decision Lab — Increment 1 (Decision Brief) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first Decision Lab increment — a single-screen decision brief: a user uploads 2-3 competing screenshots, states their goal, and receives evidence-grounded per-direction arguments, cited accessibility risks, corpus evidence with honest coverage labeling, fixed simulated perspectives, and an experiment brief. No Lean callout, no multi-screen flows, no Figma, no MCP tools — those are later increments.

**Architecture:** Reuse the existing two-pass tagger for extraction (`tagImage` with `extractionOnly: true`). A new standalone module (`src/decision-lab.ts`) holds the one new LLM call — a constrained comparative synthesis — plus a runtime citation gate that drops uncited rubric scores/perspective observations with one retry (mirroring the tagger's banned-phrase gate and `sanitizeAccessibilityRisks` evidence gate). Persistence is a `decisions.json` sidecar reusing the existing atomic-write + rolling-snapshot primitives. Decisions are persisted independently from corpus entries.

**Tech Stack:** TypeScript, Zod, Vitest, node-vibrant (via existing tagger), the existing `callModel` provider abstraction, JSON file persistence.

**Design reference:** `docs/superpowers/specs/2026-07-10-decision-lab-design.md`

**Key decisions locked in plan review:**
- Comparative synthesis lives in a standalone module (`src/decision-lab.ts`), not in the 2430-line `tagger.ts`.
- Unsupported-claim enforcement is a **runtime gate + one retry** (not prompt-only), matching the project's enforce-don't-just-measure discipline.
- Lean is **disabled** in this increment — no recommendation callout ships until the eval-defined gates pass (increment 3).
- Flow scope (`scope: "flow"`) and Figma source (`source: "figma"`) exist in the schema for forward-compatibility but the validator **rejects** them in increment 1.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/schema.ts` | Add `Decision`, `Direction`, `DecisionScreen`, `DecisionContext`, `DecisionAnalysis` schemas + enums | Modify |
| `src/schema.test.ts` | Decision schema validation tests | Modify |
| `src/decisions.ts` | Decision persistence: `loadDecisionsSafe`, `saveDecision`, `getDecisionById`, `listDecisions`, `createDecision`. Mirrors `corpus.ts` + `persistence.ts`. | Create |
| `src/decisions.test.ts` | Decision persistence tests | Create |
| `src/decision-lab.ts` | Evidence assembly (pure) + comparative synthesis (LLM call) + citation gate + brief rendering. Mirrors `tagger.ts` (LLM call) + `design-prompt.ts` (rendering). | Create |
| `src/decision-lab.test.ts` | Evidence assembly, citation gate, rendering tests (pure); synthesis request/response shape (mocked `fetch`) | Create |
| `src/scripts/ui-server.ts` | Decision CRUD routes + analysis endpoint + decision-image upload | Modify |
| `ui/app.js` | Decision Lab SPA view: setup → upload → report → evidence detail | Modify |
| `index-2.html` | Decision Lab nav entry | Modify |

---

### Task 1: Decision schema and enums

**Files:**
- Modify: `src/schema.ts` (append after the `Corpus` wrapper at line ~553)
- Test: `src/schema.test.ts`

- [ ] **Step 1: Write the failing schema tests**

Add to `src/schema.test.ts`:

```ts
import { Decision, DecisionAnalysis, EvidenceCoverage } from "./schema.js";

describe("Decision schema", () => {
  const validContext = {
    targetUser: "First-time visitors",
    businessGoal: "Make the value prop clear in 10 seconds",
    primaryKpi: "Trial starts",
  };

  it("accepts a minimal valid single-screen decision", () => {
    const result = Decision.safeParse({
      id: "choose-homepage-direction",
      title: "Choose the homepage direction",
      createdAt: "2026-07-10",
      updatedAt: "2026-07-10",
      context: validContext,
      scope: "screen",
      directions: [
        {
          id: "dir-a",
          name: "Hero with product screenshot",
          screens: [{ id: "scr-1", order: 0, source: "upload", imageRef: "corpus/images-private/decisions/shot.png" }],
        },
        {
          id: "dir-b",
          name: "Bold headline + CTA",
          screens: [{ id: "scr-2", order: 0, source: "upload", imageRef: "corpus/images-private/decisions/shot2.png" }],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("requires at least two directions", () => {
    const result = Decision.safeParse({
      id: "lonely",
      title: "T",
      createdAt: "2026-07-10",
      updatedAt: "2026-07-10",
      context: validContext,
      scope: "screen",
      directions: [
        { id: "dir-a", name: "A", screens: [{ id: "scr-1", order: 0, source: "upload", imageRef: "x.png" }] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects more than three directions", () => {
    const directions = [0, 1, 2, 3].map((i) => ({
      id: `dir-${i}`, name: `D${i}`,
      screens: [{ id: `scr-${i}`, order: 0, source: "upload" as const, imageRef: "x.png" }],
    }));
    const result = Decision.safeParse({
      id: "too-many", title: "T", createdAt: "2026-07-10", updatedAt: "2026-07-10",
      context: validContext, scope: "screen", directions,
    });
    expect(result.success).toBe(false);
  });

  it("requires at least one screen per direction", () => {
    const result = Decision.safeParse({
      id: "empty-dir", title: "T", createdAt: "2026-07-10", updatedAt: "2026-07-10",
      context: validContext, scope: "screen",
      directions: [
        { id: "dir-a", name: "A", screens: [] },
        { id: "dir-b", name: "B", screens: [{ id: "scr-1", order: 0, source: "upload", imageRef: "x.png" }] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects flow scope in increment 1", () => {
    const result = Decision.safeParse({
      id: "flow-not-yet", title: "T", createdAt: "2026-07-10", updatedAt: "2026-07-10",
      context: validContext, scope: "flow",
      directions: [
        { id: "dir-a", name: "A", screens: [{ id: "s1", order: 0, source: "upload", imageRef: "x.png" }] },
        { id: "dir-b", name: "B", screens: [{ id: "s2", order: 0, source: "upload", imageRef: "y.png" }] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects figma source in increment 1", () => {
    const result = Decision.safeParse({
      id: "figma-not-yet", title: "T", createdAt: "2026-07-10", updatedAt: "2026-07-10",
      context: validContext, scope: "screen",
      directions: [
        { id: "dir-a", name: "A", screens: [{ id: "s1", order: 0, source: "figma", imageRef: "x.png" }] },
        { id: "dir-b", name: "B", screens: [{ id: "s2", order: 0, source: "upload", imageRef: "y.png" }] },
      ],
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/schema.test.ts`
Expected: FAIL — `Decision` is not exported from schema.

- [ ] **Step 3: Add the Decision schemas to `src/schema.ts`**

Append after the `Corpus` wrapper (after line ~553), before the draft-hygiene helpers section:

```ts
// ─── Decision Lab (increment 1: single-screen decision brief) ──────────────────

/** Scope of the comparison. Increment 1 supports "screen" only; "flow" is
 *  reserved for a later increment and rejected by the validator. */
export const DecisionScope = z.enum(["screen", "flow"]);

/** Workflow state of a decision's analysis. */
export const DecisionStatus = z.enum(["draft", "analyzing", "analyzed", "failed"]);

/** Where a screen image came from. Increment 1 supports "upload" only; "figma"
 *  is reserved for a later increment and rejected by the validator. */
export const ScreenSource = z.enum(["upload", "figma"]);

/** Honest corpus-evidence labeling. Shown separately from analysis confidence. */
export const EvidenceCoverage = z.enum(["strong", "limited", "unavailable"]);

export const DecisionContext = z.object({
  targetUser: z.string().min(1),
  businessGoal: z.string().min(1),
  primaryKpi: z.string().min(1),
  platform: Platform.optional(),
  constraints: z.string().optional(),
});

/** One rubric dimension scored for a direction. Every score must cite at least
 *  one evidence id — enforced by the citation gate in decision-lab.ts. */
export const RubricDimension = z.enum([
  "goal-alignment",
  "visual-hierarchy",
  "cognitive-load",
  "copy-clarity",
  "consistency",
]);

export const RubricScore = z.object({
  dimension: RubricDimension,
  /** 1-5 scale. Null means the evidence was insufficient to score this dimension. */
  score: z.number().int().min(1).max(5).nullable(),
  rationale: z.string().min(1),
  /** Evidence ids (assembled-evidence keys) that justify this score. */
  evidence: z.array(z.string()).min(1),
});

/** One of the four fixed simulated perspectives. */
export const Perspective = z.object({
  lens: z.enum(["new-user", "returning-power-user", "accessibility-first", "growth-pm"]),
  directionId: z.string(),
  reaction: z.string().min(1),
  observations: z.array(z.object({
    note: z.string().min(1),
    evidence: z.array(z.string()).min(1),
  })).max(3),
  concern: z.string().min(1),
  confidence: z.enum(["high", "medium", "low"]),
  questionForUsers: z.string().min(1),
});

export const ExperimentBrief = z.object({
  hypothesis: z.string().min(1),
  successMetric: z.string().min(1),
  guardrails: z.array(z.string()).min(1),
});

/** A decision-relevant trade-off surfaced by the comparison. */
export const Tradeoff = z.object({
  description: z.string().min(1),
  evidence: z.array(z.string()).min(1),
});

export const DecisionScreen = z.object({
  id: z.string(),
  order: z.number().int().min(0),
  source: ScreenSource,
  imageRef: z.string(),
  /** Present when source is "figma" (post-MVP). */
  figma: z.object({
    fileKey: z.string(),
    nodeId: z.string(),
    frameName: z.string(),
  }).optional(),
  /** The tagger extraction output (Pass 1), stored as an opaque record.
   *  Consumed by the synthesis as assembled evidence. */
  tagging: z.record(z.string(), z.unknown()).optional(),
});

export const Direction = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  screens: z.array(DecisionScreen).min(1),
});

export const DecisionAnalysis = z.object({
  status: DecisionStatus,
  providerMetadata: z.object({
    extractionProvider: z.string(),
    synthesisProvider: z.string(),
    model: z.string().string(),
  }).optional(),
  analyzedAt: IsoDate.optional(),
  directionRubrics: z.array(z.object({
    directionId: z.string(),
    scores: z.array(RubricScore),
  })),
  tradeoffs: z.array(Tradeoff).min(1).max(3),
  evidenceCoverage: EvidenceCoverage,
  corpusEntryCount: z.number().int().min(0),
  perspectives: z.array(Perspective),
  experimentBrief: ExperimentBrief,
});

export const Decision = z.object({
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase kebab-case id"),
  title: z.string().min(1),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  context: DecisionContext,
  /** Increment 1: must be "screen". The enum includes "flow" for forward
   *  compatibility, but the refines below reject it until the flow increment. */
  scope: DecisionScope,
  directions: z.array(Direction).min(2).max(3),
  analysis: DecisionAnalysis.optional(),
}).superRefine((val, ctx) => {
  if (val.scope === "flow") {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Multi-screen flow comparison is not yet supported", path: ["scope"] });
  }
  for (const dir of val.directions) {
    for (const screen of dir.screens) {
      if (screen.source === "figma") {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Figma import is not yet supported — upload screenshots instead", path: ["directions", dir.id, "screens", screen.id, "source"] });
      }
    }
  }
});

export type DecisionT = z.infer<typeof Decision>;
export type DirectionT = z.infer<typeof Direction>;
export type DecisionScreenT = z.infer<typeof DecisionScreen>;
export type DecisionContextT = z.infer<typeof DecisionContext>;
export type DecisionAnalysisT = z.infer<typeof DecisionAnalysis>;
export type RubricScoreT = z.infer<typeof RubricScore>;
export type PerspectiveT = z.infer<typeof Perspective>;
export type ExperimentBriefT = z.infer<typeof ExperimentBrief>;
export type TradeoffT = z.infer<typeof Tradeoff>;
export type EvidenceCoverageT = z.infer<typeof EvidenceCoverage>;

/** Container for decisions.json, mirroring the Corpus wrapper. */
export const Decisions = z.object({
  version: z.literal(1),
  decisions: z.array(Decision),
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/schema.test.ts`
Expected: PASS — all new Decision schema tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/schema.ts src/schema.test.ts
git commit -m "feat(decision-lab): Decision schema with scope/source gating"
```

---

### Task 2: Decision persistence (`decisions.json` sidecar)

**Files:**
- Create: `src/decisions.ts`
- Create: `src/decisions.test.ts`

- [ ] **Step 1: Write the failing persistence tests**

Create `src/decisions.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createDecision, getDecisionById, listDecisions, saveDecision, setDecisionsForTesting, DECISIONS_PATH } from "./decisions.js";

const TMP_DIR = resolve(process.cwd(), "tmp-decisions-test");

describe("decision persistence", () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true });
    setDecisionsForTesting(null);
  });
  afterEach(() => {
    setDecisionsForTesting(null);
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
    saveDecision(old);
    saveDecision(newer);
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/decisions.test.ts`
Expected: FAIL — module `./decisions.js` not found.

- [ ] **Step 3: Implement `src/decisions.ts`**

Create `src/decisions.ts`:

```ts
/**
 * decisions.ts — Decision Lab persistence.
 *
 * Mirrors corpus.ts (module-level cache + test injection) and persistence.ts
 * (atomic writes + rolling snapshots). Decisions live in a separate
 * decisions.json sidecar, independent from the curated corpus.
 */
import { resolve } from "node:path";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { writeAtomic } from "./persistence.js";
import {
  Decisions,
  type DecisionT,
  type DecisionContextT,
  type DecisionScope,
} from "./schema.js";

const PROJECT_ROOT = resolve(import.meta.dirname ?? __dirname, "..");
const CORPUS_ROOT = resolve(PROJECT_ROOT, "corpus");
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
      try { rmSyncOld(resolve(DECISION_SNAPSHOT_DIR, old)); } catch { /* best-effort */ }
    }
  } catch { /* snapshots are best-effort */ }
}

/** Wrapper to avoid importing rmSync at top level just for the trim path. */
function rmSyncOld(path: string): void {
  // Node 14+ has rmSync; this is isolated for clarity.
  eval("require")("node:fs").rmSync(path, { force: true });
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
    scope: input.scope as DecisionScope,
    directions: [],
  };
}

/** Upsert a decision by id. Updates updatedAt. */
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/decisions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decisions.ts src/decisions.test.ts
git commit -m "feat(decision-lab): decisions.json persistence with atomic writes + snapshots"
```

---

### Task 3: Evidence assembly (pure function)

Evidence assembly is the deterministic step between extraction and synthesis. It takes tagger output (Pass 1) for each screen, retrieves corpus examples, and produces a flat evidence bundle the synthesis prompt consumes. This is a **pure function** — testable without API calls.

**Files:**
- Create: `src/decision-lab.ts` (start the module with this pure function)
- Create: `src/decision-lab.test.ts`

- [ ] **Step 1: Write the failing evidence-assembly tests**

Create `src/decision-lab.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assembleEvidence, classifyCoverage, type ExtractedScreen } from "./decision-lab.js";
import type { DecisionT } from "./schema.js";

function makeDecision(): DecisionT {
  return {
    id: "test-decision",
    title: "Test",
    createdAt: "2026-07-10",
    updatedAt: "2026-07-10",
    context: { targetUser: "new users", businessGoal: "clarity", primaryKpi: "signups" },
    scope: "screen",
    directions: [
      { id: "dir-a", name: "A", screens: [{ id: "s1", order: 0, source: "upload", imageRef: "a.png" }] },
      { id: "dir-b", name: "B", screens: [{ id: "s2", order: 0, source: "upload", imageRef: "b.png" }] },
    ],
  };
}

describe("assembleEvidence", () => {
  it("assigns stable evidence ids to each tagger fact and corpus example", () => {
    const decision = makeDecision();
    const screens: Record<string, ExtractedScreen> = {
      s1: {
        extraction: { patternType: "landing-page", categories: ["marketing-hero"], components: [] },
      },
      s2: {
        extraction: { patternType: "landing-page", categories: ["marketing-hero"], components: ["action-list"] },
      },
    };
    const bundle = assembleEvidence(decision, screens, []);
    // Each tagger fact gets an evidence id like "dir-a:s1:patternType"
    expect(bundle.evidenceIds).toContain("dir-a:s1:patternType");
    expect(bundle.evidenceIds).toContain("dir-b:s2:components");
    // Corpus examples get ids like "corpus:some-entry-id"
    expect(bundle.evidenceIds.filter((e) => e.startsWith("corpus:"))).toEqual([]);
  });

  it("includes corpus examples with their entry ids", () => {
    const decision = makeDecision();
    const screens: Record<string, ExtractedScreen> = {
      s1: { extraction: { patternType: "landing-page", categories: [], components: [] } },
      s2: { extraction: { patternType: "landing-page", categories: [], components: [] } },
    };
    const corpus = [
      { id: "stripe-pricing", patternType: "pricing", critique: "Clean tiers", categories: ["pricing"] },
    ];
    const bundle = assembleEvidence(decision, screens, corpus);
    expect(bundle.evidenceIds).toContain("corpus:stripe-pricing");
  });
});

describe("classifyCoverage", () => {
  it("returns 'strong' when >= 5 corpus entries are retrieved", () => {
    expect(classifyCoverage(5)).toBe("strong");
    expect(classifyCoverage(10)).toBe("strong");
  });
  it("returns 'limited' when 1-4 entries are retrieved", () => {
    expect(classifyCoverage(1)).toBe("limited");
    expect(classifyCoverage(4)).toBe("limited");
  });
  it("returns 'unavailable' when 0 entries are retrieved", () => {
    expect(classifyCoverage(0)).toBe("unavailable");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/decision-lab.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement evidence assembly in `src/decision-lab.ts`**

Create `src/decision-lab.ts`:

```ts
/**
 * decision-lab.ts — the Decision Lab analysis engine.
 *
 * Three layers:
 * 1. assembleEvidence (pure) — flattens tagger extractions + corpus retrievals
 *    into a cited evidence bundle with stable ids.
 * 2. buildComparativeSynthesis (LLM call) — the one new model call. Constrained
 *    comparative rubric fed ONLY assembled evidence.
 * 3. gateCitations (post-hoc runtime gate) — drops rubric scores and perspective
 *    observations that don't cite assembled evidence, with one retry.
 *
 * Mirrors tagger.ts (LLM call + post-hoc gate) and design-prompt.ts (pure synthesis + rendering).
 */
import type { DecisionT, EvidenceCoverageT } from "./schema.js";

/** A screen's Pass-1 tagger extraction (the `tagging` field on DecisionScreen). */
export interface ExtractedScreen {
  extraction: Record<string, unknown>;
}

/** A retrieved corpus example for evidence grounding. */
export interface CorpusEvidenceItem {
  id: string;
  patternType?: string;
  critique?: string;
  categories?: string[];
}

/** The assembled evidence bundle passed to the synthesis prompt. */
export interface EvidenceBundle {
  /** All stable evidence ids the synthesis may cite. */
  evidenceIds: string[];
  /** Human-readable evidence catalog (id → description) for the prompt. */
  catalog: { id: string; description: string }[];
  /** The corpus items, retained for the report. */
  corpusItems: CorpusEvidenceItem[];
}

/** The fields from a tagger extraction worth citing as evidence. */
const CITABLE_EXTRACTION_KEYS = [
  "patternType", "categories", "styleTags", "components", "domainTags",
  "colorScheme", "spacingDensity", "cornerStyle", "usesShadows", "usesBorders",
  "colorRoles", "dominantColors", "accentColor",
];

/**
 * Flatten tagger extractions + corpus retrievals into a cited evidence bundle.
 * Pure — no I/O, no API calls. Each evidence item gets a stable id so the
 * synthesis and the citation gate can reference it deterministically.
 */
export function assembleEvidence(
  decision: DecisionT,
  screens: Record<string, ExtractedScreen>,
  corpus: CorpusEvidenceItem[],
): EvidenceBundle {
  const catalog: { id: string; description: string }[] = [];
  const evidenceIds: string[] = [];

  for (const direction of decision.directions) {
    for (const screen of direction.screens) {
      const extracted = screens[screen.id]?.extraction;
      if (!extracted) continue;
      for (const key of CITABLE_EXTRACTION_KEYS) {
        const value = extracted[key];
        if (value === undefined || value === null) continue;
        const isEmpty = Array.isArray(value) ? value.length === 0 : value === "";
        if (isEmpty) continue;
        const id = `${direction.id}:${screen.id}:${key}`;
        const description = formatEvidenceValue(direction.name, key, value);
        evidenceIds.push(id);
        catalog.push({ id, description });
      }
    }
  }

  const corpusItems: CorpusEvidenceItem[] = [];
  for (const item of corpus) {
    const id = `corpus:${item.id}`;
    evidenceIds.push(id);
    catalog.push({ id, description: `Corpus: ${item.id} (${item.patternType ?? "unknown"}) — ${item.critique?.slice(0, 100) ?? ""}` });
    corpusItems.push(item);
  }

  return { evidenceIds, catalog, corpusItems };
}

function formatEvidenceValue(directionName: string, key: string, value: unknown): string {
  const valStr = Array.isArray(value) ? value.join(", ") : String(value);
  return `[${directionName}] ${key}: ${valStr}`;
}

/**
 * Classify corpus evidence coverage. Shown SEPARATELY from analysis confidence,
 * per the design. Drives the honest "limited corpus evidence" labeling.
 */
export function classifyCoverage(corpusEntryCount: number): EvidenceCoverageT {
  if (corpusEntryCount >= 5) return "strong";
  if (corpusEntryCount >= 1) return "limited";
  return "unavailable";
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/decision-lab.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decision-lab.ts src/decision-lab.test.ts
git commit -m "feat(decision-lab): pure evidence assembly with stable cited ids"
```

---

### Task 4: Citation gate (runtime enforcement)

The post-hoc gate that drops uncited rubric scores and perspective observations, mirroring the tagger's banned-phrase gate. Pure function — testable without API calls.

**Files:**
- Modify: `src/decision-lab.ts` (add `gateCitations`)
- Modify: `src/decision-lab.test.ts`

- [ ] **Step 1: Write the failing gate tests**

Add to `src/decision-lab.test.ts`:

```ts
import { gateCitations, type SynthesisOutput } from "./decision-lab.js";

const validEvidenceIds = ["dir-a:s1:patternType", "corpus:stripe-pricing", "dir-b:s2:components"];

describe("gateCitations", () => {
  it("keeps rubric scores whose evidence ids are all valid", () => {
    const output: SynthesisOutput = {
      directionRubrics: [{
        directionId: "dir-a",
        scores: [{
          dimension: "visual-hierarchy",
          score: 4,
          rationale: "Clear F-pattern",
          evidence: ["dir-a:s1:patternType"],
        }],
      }],
      perspectives: [],
      experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] },
      tradeoffs: [{ description: "T", evidence: ["dir-a:s1:patternType"] }],
    };
    const result = gateCitations(output, validEvidenceIds);
    expect(result.dropped).toBe(0);
    expect(result.output.directionRubrics[0].scores).toHaveLength(1);
  });

  it("drops rubric scores that cite a non-existent evidence id", () => {
    const output: SynthesisOutput = {
      directionRubrics: [{
        directionId: "dir-a",
        scores: [
          { dimension: "visual-hierarchy", score: 4, rationale: "Good", evidence: ["dir-a:s1:patternType"] },
          { dimension: "cognitive-load", score: 3, rationale: "Maybe", evidence: ["made-up-id"] },
        ],
      }],
      perspectives: [],
      experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] },
      tradeoffs: [{ description: "T", evidence: ["dir-a:s1:patternType"] }],
    };
    const result = gateCitations(output, validEvidenceIds);
    expect(result.dropped).toBe(1);
    expect(result.output.directionRubrics[0].scores).toHaveLength(1);
    expect(result.output.directionRubrics[0].scores[0].dimension).toBe("visual-hierarchy");
  });

  it("drops perspective observations with uncited evidence", () => {
    const output: SynthesisOutput = {
      directionRubrics: [{ directionId: "dir-a", scores: [{ dimension: "goal-alignment", score: 4, rationale: "R", evidence: ["dir-a:s1:patternType"] }] }],
      perspectives: [{
        lens: "new-user",
        directionId: "dir-a",
        reaction: "Clear",
        observations: [
          { note: "Good CTA", evidence: ["corpus:stripe-pricing"] },
          { note: "Speculation", evidence: ["invented-id"] },
        ],
        concern: "X",
        confidence: "medium",
        questionForUsers: "Q?",
      }],
      experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] },
      tradeoffs: [{ description: "T", evidence: ["dir-a:s1:patternType"] }],
    };
    const result = gateCitations(output, validEvidenceIds);
    expect(result.dropped).toBe(1);
    expect(result.output.perspectives[0].observations).toHaveLength(1);
  });

  it("drops tradeoffs with uncited evidence", () => {
    const output: SynthesisOutput = {
      directionRubrics: [{ directionId: "dir-a", scores: [{ dimension: "goal-alignment", score: 4, rationale: "R", evidence: ["dir-a:s1:patternType"] }] }],
      perspectives: [],
      experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] },
      tradeoffs: [{ description: "bad", evidence: ["nope"] }],
    };
    const result = gateCitations(output, validEvidenceIds);
    expect(result.dropped).toBe(1);
    expect(result.output.tradeoffs).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/decision-lab.test.ts`
Expected: FAIL — `gateCitations` and `SynthesisOutput` not exported.

- [ ] **Step 3: Implement the gate**

Add to `src/decision-lab.ts` (after `classifyCoverage`):

```ts
/** The raw synthesis output shape (what the model returns). */
export interface SynthesisOutput {
  directionRubrics: {
    directionId: string;
    scores: {
      dimension: string;
      score: number | null;
      rationale: string;
      evidence: string[];
    }[];
  }[];
  perspectives: {
    lens: string;
    directionId: string;
    reaction: string;
    observations: { note: string; evidence: string[] }[];
    concern: string;
    confidence: string;
    questionForUsers: string;
  }[];
  experimentBrief: { hypothesis: string; successMetric: string; guardrails: string[] };
  tradeoffs: { description: string; evidence: string[] }[];
}

export interface GateResult {
  output: SynthesisOutput;
  /** Number of scores/observations/tradeoffs dropped for uncited evidence. */
  dropped: number;
}

/**
 * Post-hoc citation gate. Drops any rubric score, perspective observation, or
 * tradeoff whose evidence array references an id not in the assembled evidence
 * bundle. Mirrors the tagger's banned-phrase gate and sanitizeAccessibilityRisks
 * evidence gate — enforce, don't just measure.
 *
 * Returns the cleaned output + a dropped count (for retry decisions and logging).
 */
export function gateCitations(output: SynthesisOutput, validEvidenceIds: string[]): GateResult {
  const valid = new Set(validEvidenceIds);
  let dropped = 0;

  const directionRubrics = output.directionRubrics.map((rubric) => ({
    directionId: rubric.directionId,
    scores: rubric.scores.filter((score) => {
      const ok = score.evidence.length > 0 && score.evidence.every((e) => valid.has(e));
      if (!ok) dropped++;
      return ok;
    }),
  }));

  const perspectives = output.perspectives.map((p) => {
    const observations = p.observations.filter((obs) => {
      const ok = obs.evidence.length > 0 && obs.evidence.every((e) => valid.has(e));
      if (!ok) dropped++;
      return ok;
    });
    return { ...p, observations };
  });

  const tradeoffs = output.tradeoffs.filter((t) => {
    const ok = t.evidence.length > 0 && t.evidence.every((e) => valid.has(e));
    if (!ok) dropped++;
    return ok;
  });

  return { output: { directionRubrics, perspectives, experimentBrief: output.experimentBrief, tradeoffs }, dropped };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/decision-lab.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decision-lab.ts src/decision-lab.test.ts
git commit -m "feat(decision-lab): runtime citation gate drops uncited scores/observations"
```

---

### Task 5: Comparative synthesis (LLM call)

The one new model call. Builds the constrained prompt from assembled evidence, calls the provider, parses the response, runs the citation gate with one retry. This reuses the provider-call pattern from `tagger.ts` but is its own function (not in tagger.ts).

**Files:**
- Modify: `src/decision-lab.ts` (add `buildSynthesisPrompt`, `callSynthesis`, `synthesize`)
- Modify: `src/decision-lab.test.ts` (mocked `fetch` request/response shape test)

- [ ] **Step 1: Write the failing synthesis test (mocked fetch)**

Add to `src/decision-lab.test.ts`:

```ts
import { vi, beforeEach, afterEach } from "vitest";
import { synthesize } from "./decision-lab.js";

describe("synthesize (mocked provider)", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    process.env.AUTO_TAG_PROVIDER = "openai";
    delete process.env.AUTO_TAG_PROVIDER_EXTRACTION;
    delete process.env.AUTO_TAG_PROVIDER_CRITIQUE;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = { ...originalEnv };
  });

  it("makes one API call and returns gated synthesis output", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      const response = JSON.stringify({
        directionRubrics: [{
          directionId: "dir-a",
          scores: [{
            dimension: "visual-hierarchy", score: 4, rationale: "Clear hierarchy",
            evidence: ["dir-a:s1:patternType"],
          }],
        }],
        perspectives: [],
        experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G1"] },
        tradeoffs: [{ description: "T", evidence: ["dir-a:s1:patternType"] }],
      });
      return new Response(JSON.stringify({ output_text: response }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const decision = makeDecision();
    const bundle: EvidenceBundle = {
      evidenceIds: ["dir-a:s1:patternType"],
      catalog: [{ id: "dir-a:s1:patternType", description: "[A] patternType: landing-page" }],
      corpusItems: [],
    };
    const result = await synthesize(decision, bundle);
    expect(callCount).toBe(1);
    expect(result.output.directionRubrics[0].scores).toHaveLength(1);
    expect(result.gateDrops).toBe(0);
  });

  it("retries once when the first response has uncited scores", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async () => {
      callCount++;
      const raw = callCount === 1
        ? { directionRubrics: [{ directionId: "dir-a", scores: [{ dimension: "visual-hierarchy", score: 4, rationale: "R", evidence: ["bogus"] }] }], perspectives: [], experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] }, tradeoffs: [{ description: "T", evidence: ["bogus"] }] }
        : { directionRubrics: [{ directionId: "dir-a", scores: [{ dimension: "visual-hierarchy", score: 4, rationale: "R", evidence: ["dir-a:s1:patternType"] }] }], perspectives: [], experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] }, tradeoffs: [{ description: "T", evidence: ["dir-a:s1:patternType"] }] };
      return new Response(JSON.stringify({ output_text: JSON.stringify(raw) }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const decision = makeDecision();
    const bundle: EvidenceBundle = {
      evidenceIds: ["dir-a:s1:patternType"],
      catalog: [{ id: "dir-a:s1:patternType", description: "[A] patternType: landing-page" }],
      corpusItems: [],
    };
    const result = await synthesize(decision, bundle);
    expect(callCount).toBe(2);
    expect(result.gateRetries).toBe(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/decision-lab.test.ts`
Expected: FAIL — `synthesize` not exported.

- [ ] **Step 3: Implement the synthesis call**

Add to `src/decision-lab.ts`:

```ts
import { hasCritiqueKey, activeProviderName, activeModelName } from "./tagger.js";

/** Build the constrained comparative-synthesis prompt. */
export function buildSynthesisPrompt(decision: DecisionT, bundle: EvidenceBundle): string {
  const lines: string[] = [];
  lines.push("You are a product-design decision analyst. You produce a pre-launch DECISION BRIEF.");
  lines.push("");
  lines.push("## Decision context");
  lines.push(`- Title: ${decision.title}`);
  lines.push(`- Target user: ${decision.context.targetUser}`);
  lines.push(`- Business goal: ${decision.context.businessGoal}`);
  lines.push(`- Primary KPI: ${decision.context.primaryKpi}`);
  if (decision.context.platform) lines.push(`- Platform: ${decision.context.platform}`);
  if (decision.context.constraints) lines.push(`- Constraints: ${decision.context.constraints}`);
  lines.push("");
  lines.push("## Directions");
  for (const dir of decision.directions) {
    lines.push(`### ${dir.name} (id: ${dir.id})`);
    if (dir.description) lines.push(dir.description);
  }
  lines.push("");
  lines.push("## Assembled evidence (you may ONLY cite these ids)");
  lines.push("Every rubric score, perspective observation, and tradeoff MUST reference at least one evidence id from this list. Scores or observations citing any other id will be REJECTED.");
  lines.push("");
  for (const item of bundle.catalog) {
    lines.push(`- ${item.id}: ${item.description}`);
  }
  lines.push("");
  lines.push("## Required output (JSON only)");
  lines.push("Return a JSON object with this shape:");
  lines.push("{");
  lines.push('  "directionRubrics": [{ "directionId": "dir-a", "scores": [{ "dimension": "visual-hierarchy", "score": 1-5-or-null, "rationale": "...", "evidence": ["valid-id"] }] }],');
  lines.push('  "perspectives": [{ "lens": "new-user|returning-power-user|accessibility-first|growth-pm", "directionId": "dir-a", "reaction": "...", "observations": [{ "note": "...", "evidence": ["valid-id"] }], "concern": "...", "confidence": "high|medium|low", "questionForUsers": "..." }],');
  lines.push('  "experimentBrief": { "hypothesis": "...", "successMetric": "...", "guardrails": ["..."] },');
  lines.push('  "tradeoffs": [{ "description": "...", "evidence": ["valid-id"] }]');
  lines.push("}");
  lines.push("");
  lines.push("Rules:");
  lines.push("- Score dimensions: goal-alignment, visual-hierarchy, cognitive-load, copy-clarity, consistency.");
  lines.push("- Generate one perspective per lens, per direction that warrants it.");
  lines.push("- Produce 1-3 tradeoffs.");
  lines.push("- A score of null means insufficient evidence — prefer null over guessing.");
  lines.push("- Do NOT produce a recommendation or 'winner'. This is a brief, not a verdict.");
  lines.push("- Do NOT claim statistical significance. This is pre-launch guidance.");
  return lines.join("\n");
}

export interface SynthesizeResult {
  output: SynthesisOutput;
  gateDrops: number;
  gateRetries: number;
  provider: string;
  model: string;
}

/** Call the model. Mirrors tagger.ts callModel for OpenAI-compatible shape. */
async function callSynthesisModel(prompt: string): Promise<string> {
  const model = activeModelName() ?? "gpt-4o";
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: 4000,
    }),
  });
  if (!resp.ok) throw new Error(`Synthesis provider returned ${resp.status}: ${await resp.text()}`);
  const data = await resp.json() as { output_text?: string; choices?: { message?: { content?: string } }[] };
  // Support both response formats (output_text like the tagger, or choices[].message.content)
  return data.output_text ?? data.choices?.[0]?.message?.content ?? "";
}

/**
 * Run the constrained comparative synthesis with citation gating.
 * Calls the model, gates the output, retries once if any items were dropped.
 */
export async function synthesize(decision: DecisionT, bundle: EvidenceBundle): Promise<SynthesizeResult> {
  if (!hasCritiqueKey()) {
    throw new Error("No provider key set for Decision Lab synthesis. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY.");
  }
  const prompt = buildSynthesisPrompt(decision, bundle);
  const provider = activeProviderName() ?? "openai";
  const model = activeModelName() ?? "unknown";

  let lastOutput: SynthesisOutput | null = null;
  let lastDrops = 0;
  let retries = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await callSynthesisModel(prompt + (attempt === 1 ? "\n\nNOTE: Your previous response contained scores/observations citing evidence ids that do not exist. Re-issue using ONLY ids from the assembled evidence list." : ""));
    const parsed = parseSynthesisJSON(raw);
    if (!parsed) throw new Error("Synthesis provider returned unparseable JSON.");
    const gated = gateCitations(parsed, bundle.evidenceIds);
    lastOutput = gated.output;
    lastDrops = gated.dropped;
    if (gated.dropped === 0) break;
    retries = attempt + 1;
  }

  return { output: lastOutput!, gateDrops: lastDrops, gateRetries: retries, provider, model };
}

/** Parse the model's JSON response, tolerant of markdown fences. */
function parseSynthesisJSON(raw: string): SynthesisOutput | null {
  try {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
    return JSON.parse(cleaned) as SynthesisOutput;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/decision-lab.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decision-lab.ts src/decision-lab.test.ts
git commit -m "feat(decision-lab): comparative synthesis LLM call with citation-gate retry"
```

---

### Task 6: Decision brief rendering

Renders the synthesis output as a markdown brief, mirroring `renderBriefMarkdown` from `design-prompt.ts`. Includes coverage labeling and the pre-launch caveat. Pure function.

**Files:**
- Modify: `src/decision-lab.ts` (add `renderDecisionBrief`)
- Modify: `src/decision-lab.test.ts`

- [ ] **Step 1: Write the failing render tests**

Add to `src/decision-lab.test.ts`:

```ts
import { renderDecisionBrief } from "./decision-lab.js";

describe("renderDecisionBrief", () => {
  it("renders coverage label and pre-launch caveat", () => {
    const decision = makeDecision();
    const output: SynthesisOutput = {
      directionRubrics: [{ directionId: "dir-a", scores: [{ dimension: "visual-hierarchy", score: 4, rationale: "Clear", evidence: ["dir-a:s1:patternType"] }] }],
      perspectives: [{ lens: "new-user", directionId: "dir-a", reaction: "Clear", observations: [{ note: "Good CTA", evidence: ["dir-a:s1:patternType"] }], concern: "X", confidence: "medium", questionForUsers: "Q?" }],
      experimentBrief: { hypothesis: "Direction A yields more signups", successMetric: "Trial start rate", guardrails: ["Bounce rate < 60%"] },
      tradeoffs: [{ description: "A is clearer but B is more on-brand", evidence: ["dir-a:s1:patternType"] }],
    };
    const md = renderDecisionBrief(decision, output, { coverage: "limited", corpusEntryCount: 3 });
    expect(md).toContain("# Decision brief");
    expect(md).toContain("limited");
    expect(md).not.toContain("Lean");  // no Lean in increment 1
    expect(md).toContain("pre-launch");
    expect(md).toContain("Experiment brief");
  });

  it("does not render a Lean callout", () => {
    const decision = makeDecision();
    const output: SynthesisOutput = {
      directionRubrics: [], perspectives: [],
      experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] },
      tradeoffs: [],
    };
    const md = renderDecisionBrief(decision, output, { coverage: "strong", corpusEntryCount: 10 });
    expect(md.toLowerCase()).not.toContain("recommend");
    expect(md.toLowerCase()).not.toContain("lean toward");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/decision-lab.test.ts`
Expected: FAIL — `renderDecisionBrief` not exported.

- [ ] **Step 3: Implement the renderer**

Add to `src/decision-lab.ts`:

```ts
import type { EvidenceCoverageT } from "./schema.js";

/** Render the decision brief as markdown. Mirrors renderBriefMarkdown. */
export function renderDecisionBrief(
  decision: DecisionT,
  output: SynthesisOutput,
  meta: { coverage: EvidenceCoverageT; corpusEntryCount: number },
): string {
  const lines: string[] = [];
  lines.push("# Decision brief");
  lines.push(`\n*${decision.title} — ${decision.context.businessGoal}*\n`);

  // ── Coverage label (honest, separate from confidence) ──
  lines.push(`## Corpus evidence coverage: ${meta.coverage}`);
  lines.push(`Grounded in ${meta.corpusEntryCount} corpus entr${meta.corpusEntryCount === 1 ? "y" : "ies"}.`);
  if (meta.coverage === "limited") {
    lines.push("**Limited corpus evidence** — this brief leads with screen observations and validation questions.");
  } else if (meta.coverage === "unavailable") {
    lines.push("**No corpus evidence available** for this pattern — analysis is based on screen observations only.");
  }
  lines.push("");

  // ── Per-direction rubrics ──
  for (const rubric of output.directionRubrics) {
    const direction = decision.directions.find((d) => d.id === rubric.directionId);
    lines.push(`## ${direction?.name ?? rubric.directionId}`);
    if (rubric.scores.length === 0) {
      lines.push("*No rubric dimensions could be scored from the available evidence.*\n");
      continue;
    }
    for (const score of rubric.scores) {
      const val = score.score === null ? "insufficient evidence" : `${score.score}/5`;
      lines.push(`- **${score.dimension}**: ${val} — ${score.rationale} _(evidence: ${score.evidence.join(", ")})_`);
    }
    lines.push("");
  }

  // ── Trade-offs ──
  if (output.tradeoffs.length) {
    lines.push("## Key trade-offs");
    output.tradeoffs.forEach((t, i) => lines.push(`${i + 1}. ${t.description} _(evidence: ${t.evidence.join(", ")})_`));
    lines.push("");
  }

  // ── Simulated perspectives ──
  if (output.perspectives.length) {
    lines.push("## Simulated perspectives");
    lines.push("*These are simulated reactions, not user research. Validate with real users.*\n");
    for (const p of output.perspectives) {
      const direction = decision.directions.find((d) => d.id === p.directionId);
      lines.push(`### ${lensLabel(p.lens)} — ${direction?.name ?? p.directionId}`);
      lines.push(`**Reaction:** ${p.reaction}`);
      lines.push(`**Confidence:** ${p.confidence}`);
      if (p.observations.length) {
        lines.push("**Observations:**");
        for (const obs of p.observations) lines.push(`- ${obs.note} _(evidence: ${obs.evidence.join(", ")})_`);
      }
      lines.push(`**Concern:** ${p.concern}`);
      lines.push(`**Validate with users:** ${p.questionForUsers}\n`);
    }
  }

  // ── Experiment brief ──
  lines.push("## Experiment brief");
  lines.push(`- **Hypothesis:** ${output.experimentBrief.hypothesis}`);
  lines.push(`- **Success metric:** ${output.experimentBrief.successMetric}`);
  lines.push(`- **Guardrails:** ${output.experimentBrief.guardrails.join("; ")}`);
  lines.push("");

  // ── Pre-launch caveat ──
  lines.push("---");
  lines.push("*This is a pre-launch decision brief. It predicts likely strengths, risks, and research hypotheses. It is not statistically valid A/B-test results — that requires production traffic and experiment data.*");

  return lines.join("\n");
}

function lensLabel(lens: string): string {
  const map: Record<string, string> = {
    "new-user": "New user",
    "returning-power-user": "Returning/power user",
    "accessibility-first": "Accessibility-first user",
    "growth-pm": "Growth-minded PM",
  };
  return map[lens] ?? lens;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/decision-lab.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decision-lab.ts src/decision-lab.test.ts
git commit -m "feat(decision-lab): decision brief renderer with coverage labeling + caveat"
```

---

### Task 7: Full analysis pipeline orchestration

Ties together: validate → extract (tagger) → retrieve corpus → assemble evidence → synthesize → gate → persist analysis. This is the function the UI and (later) MCP tool call.

**Files:**
- Modify: `src/decision-lab.ts` (add `analyzeDecision`)
- Modify: `src/decision-lab.test.ts`

- [ ] **Step 1: Write the failing pipeline test**

Add to `src/decision-lab.test.ts`:

```ts
import { analyzeDecision } from "./decision-lab.js";
import { tagImage } from "./tagger.js";
import { searchRanked } from "./corpus.js";

vi.mock("./tagger.js", () => ({
  tagImage: vi.fn(),
  hasCritiqueKey: vi.fn(() => true),
  activeProviderName: vi.fn(() => "openai"),
  activeModelName: vi.fn(() => "test-model"),
}));
vi.mock("./corpus.js", () => ({
  searchRanked: vi.fn(),
}));

describe("analyzeDecision", () => {
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.mocked(tagImage).mockResolvedValue({
      patternType: "landing-page", categories: ["marketing-hero"], components: [],
      _raw: { extraction: { patternType: "landing-page", categories: ["marketing-hero"], components: [] } },
    } as any);
    vi.mocked(searchRanked).mockResolvedValue([
      { entry: { id: "stripe-pricing", patternType: "pricing", critique: "Clean", categories: ["pricing"] }, score: 0.8, searchMode: "vector" },
    ]);
  });

  it("extracts, retrieves, assembles, synthesizes, and returns an analysis", async () => {
    const decision = makeDecision();
    globalThis.fetch = vi.fn(async () => {
      const response = JSON.stringify({
        directionRubrics: [{ directionId: "dir-a", scores: [{ dimension: "visual-hierarchy", score: 4, rationale: "R", evidence: ["dir-a:s1:patternType"] }] }],
        perspectives: [],
        experimentBrief: { hypothesis: "H", successMetric: "M", guardrails: ["G"] },
        tradeoffs: [{ description: "T", evidence: ["corpus:stripe-pricing"] }],
      });
      return new Response(JSON.stringify({ output_text: response }), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;

    const analysis = await analyzeDecision(decision);
    expect(analysis.status).toBe("analyzed");
    expect(analysis.evidenceCoverage).toBe("limited");  // 1 corpus entry
    expect(analysis.corpusEntryCount).toBe(1);
    expect(analysis.directionRubrics[0].scores[0].dimension).toBe("visual-hierarchy");
    expect(tagImage).toHaveBeenCalledTimes(2);  // once per screen
    expect(searchRanked).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/decision-lab.test.ts`
Expected: FAIL — `analyzeDecision` not exported.

- [ ] **Step 3: Implement the pipeline**

Add to `src/decision-lab.ts`:

```ts
import { tagImage } from "./tagger.js";
import { searchRanked } from "./corpus.js";
import type { DecisionAnalysisT } from "./schema.js";

export interface AnalyzeResult {
  analysis: DecisionAnalysisT;
  brief: string;
}

/**
 * Full Decision Lab analysis pipeline:
 * 1. Extract visual/layout/component/a11y signals via the existing tagger (extractionOnly).
 * 2. Retrieve relevant corpus examples from decision context + extracted signals.
 * 3. Assemble evidence into a cited bundle.
 * 4. Run the constrained comparative synthesis with citation gating.
 * 5. Classify corpus coverage honestly.
 * 6. Render the decision brief.
 */
export async function analyzeDecision(decision: DecisionT): Promise<AnalyzeResult> {
  // ── Step 1: Extraction via existing tagger ──
  const screens: Record<string, ExtractedScreen> = {};
  const extractionProvider = activeProviderName() ?? "openai";
  for (const direction of decision.directions) {
    for (const screen of direction.screens) {
      const tagged = await tagImage({
        imagePath: screen.imageRef,
        productName: direction.name,
        extractionOnly: true,
      });
      screens[screen.id] = {
        extraction: (tagged._raw?.extraction as Record<string, unknown>) ?? {
          patternType: tagged.patternType,
          categories: tagged.categories,
          components: tagged.components,
        },
      };
    }
  }

  // ── Step 2: Corpus retrieval ──
  const query = `${decision.context.businessGoal} ${decision.context.primaryKpi} ${decision.context.targetUser}`;
  const searchResults = await searchRanked({ query, limit: 10 });
  const corpusEvidence: CorpusEvidenceItem[] = searchResults.slice(0, 8).map((r) => ({
    id: r.entry.id,
    patternType: r.entry.patternType,
    critique: r.entry.critique,
    categories: r.entry.categories,
  }));

  // ── Step 3: Assemble evidence ──
  const bundle = assembleEvidence(decision, screens, corpusEvidence);

  // ── Step 4: Synthesize ──
  const synth = await synthesize(decision, bundle);

  // ── Step 5: Classify coverage ──
  const coverage = classifyCoverage(corpusEvidence.length);

  // ── Step 6: Build analysis record + render brief ──
  const analysis: DecisionAnalysisT = {
    status: "analyzed",
    providerMetadata: {
      extractionProvider,
      synthesisProvider: synth.provider,
      model: synth.model,
    },
    analyzedAt: new Date().toISOString().slice(0, 10),
    directionRubrics: synth.output.directionRubrics.map((r) => ({
      directionId: r.directionId,
      scores: r.scores.map((s) => ({
        dimension: s.dimension as DecisionAnalysisT["directionRubrics"][0]["scores"][0]["dimension"],
        score: s.score,
        rationale: s.rationale,
        evidence: s.evidence,
      })),
    })),
    tradeoffs: synth.output.tradeoffs,
    evidenceCoverage: coverage,
    corpusEntryCount: corpusEvidence.length,
    perspectives: synth.output.perspectives as DecisionAnalysisT["perspectives"],
    experimentBrief: synth.output.experimentBrief,
  };

  const brief = renderDecisionBrief(decision, synth.output, { coverage, corpusEntryCount: corpusEvidence.length });

  return { analysis, brief };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/decision-lab.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/decision-lab.ts src/decision-lab.test.ts
git commit -m "feat(decision-lab): full analysis pipeline (extract → retrieve → synthesize → gate)"
```

---

### Task 8: UI server routes

Add decision CRUD routes + analysis endpoint + decision-image upload to `ui-server.ts`, mirroring the existing entries pattern.

**Files:**
- Modify: `src/scripts/ui-server.ts`
- Test: manual (browser tests in Task 9 cover the endpoints)

- [ ] **Step 1: Add imports**

At the top of `src/scripts/ui-server.ts`, add to the import block:

```ts
import { createDecision, saveDecision, getDecisionById, listDecisions } from "../decisions.js";
import { analyzeDecision } from "../decision-lab.js";
import { tagImage } from "../tagger.js";
```

- [ ] **Step 2: Add `GET /api/decisions` route**

In `handleApi`, before the `PUT/DELETE /api/entries/:id` match (around line 1287), insert:

```ts
if (req.method === "GET" && url.pathname === "/api/decisions") {
  sendJson(res, 200, { decisions: listDecisions() });
  return;
}
```

- [ ] **Step 3: Add `POST /api/decisions` route (create)**

```ts
if (req.method === "POST" && url.pathname === "/api/decisions") {
  const payload = await readJson(req) as {
    title?: string; targetUser?: string; businessGoal?: string;
    primaryKpi?: string; scope?: string; platform?: string; constraints?: string;
  };
  if (!payload.title || !payload.targetUser || !payload.businessGoal || !payload.primaryKpi) {
    sendJson(res, 400, { error: "title, targetUser, businessGoal, and primaryKpi are required" });
    return;
  }
  const decision = createDecision({
    title: payload.title,
    targetUser: payload.targetUser,
    businessGoal: payload.businessGoal,
    primaryKpi: payload.primaryKpi,
    scope: (payload.scope === "flow" ? "flow" : "screen") as "screen" | "flow",
    ...(payload.platform ? { platform: payload.platform as "web" | "mobile" | "tablet" } : {}),
    ...(payload.constraints ? { constraints: payload.constraints } : {}),
  });
  saveDecision(decision);
  sendJson(res, 200, { decision });
  return;
}
```

- [ ] **Step 4: Add `GET /api/decisions/:id` route**

```ts
const decisionMatch = url.pathname.match(/^\/api\/decisions\/([^/]+)$/);
if (req.method === "GET" && decisionMatch) {
  const decision = getDecisionById(decisionMatch[1]);
  if (!decision) { sendJson(res, 404, { error: "Decision not found" }); return; }
  sendJson(res, 200, { decision });
  return;
}
```

- [ ] **Step 5: Add `PUT /api/decisions/:id` route (update directions/screens)**

```ts
if (req.method === "PUT" && decisionMatch) {
  const existing = getDecisionById(decisionMatch[1]);
  if (!existing) { sendJson(res, 404, { error: "Decision not found" }); return; }
  const payload = await readJson(req) as { directions?: unknown };
  const updated = { ...existing, ...(payload.directions ? { directions: payload.directions } : {}) };
  saveDecision(updated);
  sendJson(res, 200, { decision: updated });
  return;
}
```

- [ ] **Step 6: Add `POST /api/decisions/:id/analyze` route**

```ts
const analyzeMatch = url.pathname.match(/^\/api\/decisions\/([^/]+)\/analyze$/);
if (req.method === "POST" && analyzeMatch) {
  const decision = getDecisionById(analyzeMatch[1]);
  if (!decision) { sendJson(res, 404, { error: "Decision not found" }); return; }
  if (decision.directions.length < 2) {
    sendJson(res, 400, { error: "Add at least two directions with at least one screen each before analyzing." });
    return;
  }
  for (const dir of decision.directions) {
    if (dir.screens.length === 0) {
      sendJson(res, 400, { error: `Direction "${dir.name}" has no screens.` });
      return;
    }
  }
  try {
    const { analysis, brief } = await analyzeDecision(decision);
    const updated = { ...decision, analysis };
    saveDecision(updated);
    sendJson(res, 200, { decision: updated, brief });
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : "Analysis failed" });
  }
  return;
}
```

- [ ] **Step 7: Add `POST /api/decision-upload-image` route (mirrors `/api/upload-image`)**

```ts
if (req.method === "POST" && url.pathname === "/api/decision-upload-image") {
  const payload = await readJson(req) as { filename?: string; dataUrl?: string };
  if (!payload.filename || !payload.dataUrl) {
    sendJson(res, 400, { error: "filename and dataUrl are required" });
    return;
  }
  const match = payload.dataUrl.match(/^data:image\/(png|jpeg|jpg|webp);base64,(.+)$/i);
  if (!match) {
    sendJson(res, 400, { error: "dataUrl must be a base64 image (png/jpeg/webp)" });
    return;
  }
  const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const slug = payload.filename.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "screen";
  const dir = resolve(CORPUS_ROOT, "images-private", "decisions");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  let filename = `${slug}.${ext}`;
  let counter = 1;
  while (existsSync(resolve(dir, filename))) filename = `${slug}-${counter++}.${ext}`;
  const fullPath = resolve(dir, filename);
  writeFileSync(fullPath, Buffer.from(match[2], "base64"));
  sendJson(res, 200, { path: `corpus/images-private/decisions/${filename}` });
  return;
}
```

- [ ] **Step 8: Build and verify the server compiles**

Run: `npm run build`
Expected: compiles with no errors.

- [ ] **Step 9: Commit**

```bash
git add src/scripts/ui-server.ts
git commit -m "feat(decision-lab): UI server routes — CRUD, analyze, image upload"
```

---

### Task 9: Dashboard SPA — Decision Lab views

Add the Decision Lab route to the curator dashboard with the four views: setup → upload → report → evidence detail. This task modifies the frontend SPA.

**Files:**
- Modify: `index-2.html` (add nav entry)
- Modify: `ui/app.js` (add Decision Lab views + client logic)

- [ ] **Step 1: Add Decision Lab nav entry to `index-2.html`**

Add a nav button to the left navigation, alongside Library / Add entry / Bulk import / Coverage:

```html
<button class="nav-item" data-view="decision-lab">Decision Lab</button>
```

- [ ] **Step 2: Add the Decision Lab view container**

In the main content area of `index-2.html`, add:

```html
<div id="view-decision-lab" class="view hidden">
  <div id="decision-lab-setup">
    <h2>Decision Lab</h2>
    <p class="muted">Compare two or three competing designs before you ship. Get an evidence-grounded brief — not a verdict.</p>
    <form id="decision-setup-form">
      <label>Title <input type="text" name="title" placeholder="Choose the homepage direction" required></label>
      <label>Target user <input type="text" name="targetUser" placeholder="First-time visitors" required></label>
      <label>Business goal <input type="text" name="businessGoal" placeholder="Make the value prop clear in 10s" required></label>
      <label>Primary KPI <input type="text" name="primaryKpi" placeholder="Trial starts" required></label>
      <label>Platform
        <select name="platform"><option value="">Any</option><option value="web">Web</option><option value="mobile">Mobile</option><option value="tablet">Tablet</option></select>
      </label>
      <label>Constraints (optional) <input type="text" name="constraints" placeholder="Must use existing color system"></label>
      <button type="submit">Create decision</button>
    </form>
  </div>

  <div id="decision-lab-builder" class="hidden">
    <h2 id="decision-title"></h2>
    <div id="directions-grid"></div>
    <button id="add-direction-btn">Add direction</button>
    <button id="analyze-btn">Analyze</button>
  </div>

  <div id="decision-lab-report" class="hidden">
    <div id="report-content"></div>
    <button id="export-brief-btn">Export brief</button>
  </div>
</div>
```

- [ ] **Step 3: Add Decision Lab client logic to `ui/app.js`**

Append to `ui/app.js`:

```js
// ─── Decision Lab ───────────────────────────────────────────────────────────

let currentDecision = null;

function showDecisionLab() {
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-decision-lab').classList.remove('hidden');
  document.getElementById('decision-lab-setup').classList.remove('hidden');
  document.getElementById('decision-lab-builder').classList.add('hidden');
  document.getElementById('decision-lab-report').classList.add('hidden');
}

document.getElementById('decision-setup-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const resp = await fetch('/api/decisions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      title: form.title.value, targetUser: form.targetUser.value,
      businessGoal: form.businessGoal.value, primaryKpi: form.primaryKpi.value,
      platform: form.platform.value || undefined, constraints: form.constraints.value || undefined,
      scope: 'screen',
    }),
  });
  const data = await resp.json();
  if (data.error) { alert(data.error); return; }
  currentDecision = data.decision;
  renderBuilder();
});

function renderBuilder() {
  document.getElementById('decision-lab-setup').classList.add('hidden');
  document.getElementById('decision-lab-builder').classList.remove('hidden');
  document.getElementById('decision-title').textContent = currentDecision.title;
  const grid = document.getElementById('directions-grid');
  grid.innerHTML = '';
  currentDecision.directions.forEach((dir, i) => {
    grid.insertAdjacentHTML('beforeend', renderDirectionCard(dir, i));
  });
  bindUploadHandlers();
}

function renderDirectionCard(dir, index) {
  const label = String.fromCharCode(65 + index); // A, B, C
  const screens = dir.screens.map(s => `<img src="/static/placeholder" data-ref="${s.imageRef}" style="max-width:200px">`).join('');
  return `<div class="direction-card" data-direction-id="${dir.id}">
    <h3>Direction ${label}: <input type="text" value="${dir.name}" onchange="renameDirection('${dir.id}', this.value)"></h3>
    <div class="screens">${screens}</div>
    <label class="upload-btn">Upload screen
      <input type="file" accept="image/png,image/jpeg,image/webp" data-direction-id="${dir.id}" class="screen-upload">
    </label>
  </div>`;
}

function bindUploadHandlers() {
  document.querySelectorAll('.screen-upload').forEach(input => {
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const resp = await fetch('/api/decision-upload-image', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ filename: file.name, dataUrl: reader.result }),
        });
        const data = await resp.json();
        if (data.error) { alert(data.error); return; }
        // Add screen to direction
        const dir = currentDecision.directions.find(d => d.id === input.dataset.directionId);
        dir.screens.push({ id: `scr-${Date.now()}`, order: dir.screens.length, source: 'upload', imageRef: data.path });
        await persistDecision();
        renderBuilder();
      };
      reader.readAsDataURL(file);
    };
  });
}

async function persistDecision() {
  const resp = await fetch(`/api/decisions/${currentDecision.id}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ directions: currentDecision.directions }),
  });
  const data = await resp.json();
  if (data.decision) currentDecision = data.decision;
}

document.getElementById('add-direction-btn')?.addEventListener('click', async () => {
  if (currentDecision.directions.length >= 3) { alert('Maximum 3 directions.'); return; }
  currentDecision.directions.push({
    id: `dir-${Date.now()}`, name: 'New direction', screens: [],
  });
  await persistDecision();
  renderBuilder();
});

document.getElementById('analyze-btn')?.addEventListener('click', async () => {
  if (currentDecision.directions.length < 2) { alert('Add at least two directions.'); return; }
  const btn = document.getElementById('analyze-btn');
  btn.textContent = 'Analyzing…';
  btn.disabled = true;
  try {
    const resp = await fetch(`/api/decisions/${currentDecision.id}/analyze`, { method: 'POST' });
    const data = await resp.json();
    if (data.error) { alert(data.error); return; }
    currentDecision = data.decision;
    renderReport(data.brief);
  } finally {
    btn.textContent = 'Analyze';
    btn.disabled = false;
  }
});

function renderReport(briefMarkdown) {
  document.getElementById('decision-lab-builder').classList.add('hidden');
  document.getElementById('decision-lab-report').classList.remove('hidden');
  // Render markdown as preformatted (the brief is markdown text)
  document.getElementById('report-content').innerHTML = `<pre class="decision-brief">${escapeHtml(briefMarkdown)}</pre>`;
}

document.getElementById('export-brief-btn')?.addEventListener('click', () => {
  const brief = document.querySelector('.decision-brief')?.textContent ?? '';
  const blob = new Blob([brief], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${currentDecision.id}-brief.md`;
  a.click();
});

window.renameDirection = async (id, name) => {
  const dir = currentDecision.directions.find(d => d.id === id);
  if (dir) { dir.name = name; await persistDecision(); }
};
```

- [ ] **Step 4: Wire the nav button**

In the nav-handler section of `ui/app.js` (where other `data-view` clicks are bound), add:

```js
if (target === 'decision-lab') showDecisionLab();
```

- [ ] **Step 5: Build and run the dashboard**

Run: `npm run build && npm run ui`
Expected: dashboard opens at localhost:3131, Decision Lab nav item is visible.

- [ ] **Step 6: Commit**

```bash
git add index-2.html ui/app.js
git commit -m "feat(decision-lab): dashboard SPA — setup, upload, report, export"
```

---

### Task 10: Full verification

**Files:**
- Verify only

- [ ] **Run the full build**

Run: `npm run build`
Expected: compiles with no errors.

- [ ] **Run the full test suite**

Run: `npm test`
Expected: all tests pass, including the new Decision Lab tests.

- [ ] **Validate that no corpus changes leaked**

Run: `git diff corpus/entries.json`
Expected: no changes (Decision Lab persists to `decisions.json`, not `entries.json`).

- [ ] **Inspect the diff and report unrelated pre-existing files separately**

The working tree started with modified `src/schema.test.ts` and `src/tagger.test.ts`. Confirm those changes (if retained) are unrelated to Decision Lab and report them separately from this feature's diff.

- [ ] **Manual smoke test**

1. `npm run ui` → open Decision Lab
2. Create a decision (title, target user, goal, KPI)
3. Add two directions, upload one screenshot each
4. Click Analyze → verify the brief renders with coverage label, rubric scores with evidence citations, perspectives, experiment brief, and the pre-launch caveat
5. Verify NO Lean/recommendation callout appears
6. Export the brief

---

## Self-Review

**Spec coverage** (increment 1 scope from the design):
- ✅ Decision model + uploaded screenshots + single-screen comparison → Tasks 1, 2, 8, 9
- ✅ Per-screen tagging (extraction-only) → Task 7 (calls `tagImage` with `extractionOnly: true`)
- ✅ Evidence-grounded comparative arguments → Tasks 3, 5
- ✅ Corpus retrieval with honest coverage labeling → Tasks 3, 6
- ✅ Fixed simulated perspectives → Task 5 (prompt requires them), Task 6 (renders them)
- ✅ Experiment brief → Tasks 5, 6
- ✅ Evidence traces / explainability → Task 4 (citation gate enforces linkage)
- ✅ Cited accessibility risks (not a score) → extraction-only preserves tagger a11y risks; rubric uses accessibility-first perspective, no numeric a11y score
- ✅ Report export → Task 9
- ✅ Lean disabled → Task 6 explicitly tests no Lean/recommendation
- ✅ scope: "flow" and source: "figma" rejected → Task 1 superRefine
- ✅ Cost bound (one synthesis call, extraction reuse) → Task 7
- ✅ Pre-launch caveat → Task 6

**Placeholder scan:** No TBD/TODO placeholders. Every code step contains complete code.

**Type consistency:** `SynthesisOutput` (Task 4/5) → consumed by `analyzeDecision` (Task 7) → `DecisionAnalysisT` mapping → `renderDecisionBrief` (Task 6). Evidence ids (`dir-x:screens-y:field`, `corpus:id`) consistent across assembly (Task 3), gate (Task 4), synthesis prompt (Task 5), and rendering (Task 6).

**Out of increment-1 scope (correctly deferred):** MCP tools, Figma import, multi-screen flow, Lean callout, eval set.
