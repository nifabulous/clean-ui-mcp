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

// NOTE: the previous aggregatePatternHistogram helper was removed as dead code
// (YAGNI) — it had zero production call sites and was exercised only by its own
// unit test. The c3-fallback-v1 recipe emits zero-evidence arrays, so no
// pattern histogram is computed. If a later milestone grounds decisions in
// corpus patterns, reintroduce the helper alongside its production caller.

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

// NOTE: the previous buildRationale helper was removed as dead code (YAGNI) —
// it had zero production call sites (the c3-fallback-v1 recipe emits its own
// recipe-owned text directly) and was exercised only by its own unit test. The
// recipe's assembly-rule notes are read inline where needed.

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
