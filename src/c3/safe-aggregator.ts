/**
 * safe-aggregator.ts — the deterministic, sanitized-only aggregator that backs
 * the c3-fallback-v1 producer.
 *
 * Safety guarantee: every exported function accepts ONLY branded
 * `SanitizedEvidence[]` (+ the parsed request + the checked-in recipe). Raw
 * `CorpusEntryT` is NOT an accepted input type — the type boundary IS the
 * safety guarantee. Sanitizing after raw-corpus synthesis is explicitly out of
 * bounds (the plan forbids calling generateBrief/renderBrief/buildRecommendation
 * on raw CorpusEntry prose here).
 *
 * The aggregator returns closed-vocabulary aggregates plus recipe-owned
 * summaries. It never invents a corpus claim: every value is derived from the
 * recipe's fixed assembly rules or echoed from requester-supplied input.
 */
import type { CreateUiSpecRequest, SanitizedEvidence } from "../create-ui-spec-contracts.js";
import recipe from "./fallback-recipe-v1.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Bounded text limits (mirror the candidate schema so the producer's candidate
// always parses).
// ---------------------------------------------------------------------------

const DESIGN_DIRECTION_MAX = 2_000;
const RATIONALE_MAX = 1_000;

/**
 * The checked-in recipe, typed by structural projection. The producer imports
 * the same JSON; this typed view is what the aggregator reads from.
 */
export interface FallbackRecipe {
  readonly recipeVersion: string;
  readonly assemblyRules: Readonly<Record<string, {
    readonly strategy: string;
    readonly value?: unknown;
    readonly note?: string;
  }>>;
  readonly unavailableDecisions: readonly { readonly field: string; readonly reason: string }[];
  readonly warningCodes: readonly string[];
  readonly allowedEvidenceKinds: readonly string[];
  readonly acceptanceCriteria: readonly {
    readonly id: string;
    readonly subject: string;
    readonly assertion: string;
    readonly expectedOutcome: string;
    readonly verifier: string;
    readonly priority: string;
    readonly evidenceIds: readonly string[];
    readonly manualSteps?: readonly string[];
  }[];
}

/** The imported recipe, re-typed for structural access. */
export const RECIPE: FallbackRecipe = recipe as unknown as FallbackRecipe;

// ---------------------------------------------------------------------------
// Closed-vocabulary aggregation
// ---------------------------------------------------------------------------

/**
 * A pattern-type histogram row. `pattern` comes ONLY from the sanitized
 * evidence's allowlisted `structuredFacts.pattern` field — never from raw
 * corpus prose.
 */
export interface PatternHistogramRow {
  readonly pattern: string;
  readonly count: number;
}

/**
 * Aggregate a closed-vocabulary pattern-type histogram from sanitized evidence.
 * Entries without a `structuredFacts.pattern` are omitted. Output is ordered
 * deterministically: by pattern ascending, then by count descending.
 *
 * Accepts ONLY `SanitizedEvidence[]` — raw `CorpusEntryT[]` is a type error.
 */
export function aggregatePatternHistogram(
  evidence: readonly SanitizedEvidence[],
): PatternHistogramRow[] {
  const counts = new Map<string, number>();
  for (const e of evidence) {
    const pattern = e.structuredFacts?.pattern;
    if (typeof pattern !== "string" || pattern.length === 0) continue;
    counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([pattern, count]) => ({ pattern, count }))
    .sort((a, b) => {
      if (a.pattern !== b.pattern) return a.pattern < b.pattern ? -1 : 1;
      return b.count - a.count;
    });
}

// ---------------------------------------------------------------------------
// Recipe-owned summaries
// ---------------------------------------------------------------------------

/**
 * Build the design-direction summary from the requester's productContext
 * (echo-product-context strategy). The string is bounded to the candidate
 * schema's BoundedTextValue limit so the producer's candidate always parses.
 * Never reads corpus prose.
 */
export function buildDesignDirectionSummary(
  request: Pick<CreateUiSpecRequest, "productContext">,
  _recipe: FallbackRecipe,
): string {
  const ctx = request.productContext.trim();
  return ctx.length <= DESIGN_DIRECTION_MAX ? ctx : ctx.slice(0, DESIGN_DIRECTION_MAX);
}

/**
 * Build a bounded, recipe-owned rationale for a decision field. The rationale
 * is recipe-owned text (never corpus prose); when the recipe carries a note for
 * the field it is used, otherwise a generic deterministic fallback is emitted.
 */
export function buildRationale(field: string, recipe: FallbackRecipe): string {
  const rule = recipe.assemblyRules[field];
  const note = rule?.note?.trim();
  const base = note && note.length > 0
    ? note
    : `Deterministic fallback decision for ${field}; no corpus- or model-derived evidence was invented.`;
  return base.length <= RATIONALE_MAX ? base : base.slice(0, RATIONALE_MAX);
}

/**
 * The fixed-empty/unavailable strategy output for the array-shaped decision
 * fields. Every value is an empty array — the truthful zero-evidence state
 * encoded by the recipe. These never reference a corpus identity.
 */
export interface FixedEmptyArrays {
  readonly rejectedDefaults: readonly never[];
  readonly layoutRegions: readonly never[];
  readonly responsiveBehavior: readonly never[];
  readonly componentInventory: readonly never[];
  readonly interactions: readonly never[];
  readonly accessibilityConstraints: readonly never[];
  readonly techniques: readonly never[];
  readonly antiPatterns: readonly never[];
  readonly citedDecisions: readonly never[];
  readonly citedReferences: readonly never[];
}

/**
 * Emit empty arrays for every fixed-empty/empty-strategy field. The recipe
 * encodes these as the truthful zero-evidence state; the producer maps them
 * into the candidate. No corpus identity is referenced.
 */
export function buildFixedEmptyArrays(_recipe: FallbackRecipe): FixedEmptyArrays {
  return {
    rejectedDefaults: [],
    layoutRegions: [],
    responsiveBehavior: [],
    componentInventory: [],
    interactions: [],
    accessibilityConstraints: [],
    techniques: [],
    antiPatterns: [],
    citedDecisions: [],
    citedReferences: [],
  };
}

/**
 * Generate a recipe-owned evidence summary for a sanitized corpus observation.
 * The summary is built from a FIXED template keyed by the allowlisted
 * structured-facts tokens — never from critique/voice/product-name/url/prose.
 *
 * Template (recipe-owned):
 *   "${pattern} reference with N regions" when regionCount is known,
 *   "${pattern} reference" otherwise.
 *
 * If the sanitized evidence carries no `pattern`, a generic, pattern-free
 * recipe-owned summary is emitted.
 */
export function buildCorpusObservationSummary(evidence: SanitizedEvidence): string {
  const pattern = evidence.structuredFacts?.pattern;
  const regionCount = evidence.structuredFacts?.regionCount;
  if (typeof pattern === "string" && pattern.length > 0) {
    if (typeof regionCount === "number") {
      return `${pattern} reference with ${regionCount} regions`;
    }
    return `${pattern} reference`;
  }
  return "Corpus observation reference";
}
