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
import { z } from "zod";
import recipe from "./fallback-recipe-v1.json" with { type: "json" };

// ---------------------------------------------------------------------------
// Bounded text limits (mirror the candidate schema so the producer's candidate
// always parses).
// ---------------------------------------------------------------------------

const DESIGN_DIRECTION_MAX = 2_000;

const CitedDecisionRecipeSchema = z.object({
  field: z.string().trim().min(1),
  authority: z.literal("editorial"),
  evidenceKind: z.literal("recipe-system"),
  note: z.string().trim().min(1).optional(),
}).strict();

/**
 * The checked-in recipe, typed by structural projection. The producer imports
 * the same JSON; this typed view is what the aggregator reads from.
 */
const FallbackRecipeSchema = z.object({
  recipeVersion: z.string().trim().min(1),
  description: z.string().trim().min(1),
  assemblyRules: z.record(z.string(), z.object({
    strategy: z.string().trim().min(1),
    value: z.unknown().optional(),
    note: z.string().trim().min(1).optional(),
  }).strict()),
  unavailableDecisions: z.array(z.object({ field: z.string().trim().min(1), reason: z.string().trim().min(1) }).strict()),
  warningCodes: z.array(z.string().trim().min(1)),
  allowedEvidenceKinds: z.array(z.string().trim().min(1)),
  recipeEvidence: z.object({
    id: z.string().regex(/^evidence-[0-9]+$/),
    kind: z.literal("recipe-system"),
    basis: z.literal("aggregate"),
    summary: z.string().trim().min(1).max(500),
    structuredFacts: z.object({}).strict(),
    note: z.string().trim().min(1).optional(),
  }).strict(),
  acceptanceCriteria: z.array(z.object({
    id: z.string().trim().min(1),
    subject: z.string().trim().min(1),
    assertion: z.string().trim().min(1),
    expectedOutcome: z.string().trim().min(1),
    verifier: z.string().trim().min(1),
    priority: z.string().trim().min(1),
    evidenceIds: z.array(z.string()),
    manualSteps: z.array(z.string()).optional(),
  }).strict()),
}).strict();

export type FallbackRecipe = z.infer<typeof FallbackRecipeSchema>;

/** The imported recipe, re-typed for structural access. */
export const RECIPE: FallbackRecipe = FallbackRecipeSchema.parse(recipe);

/**
 * Read the cited-decision recipe through a narrower runtime contract than the
 * generic assembly-rule map. The producer may only emit recipe/system,
 * editorial-authority decisions in this slice; a changed recipe must fail at
 * load time rather than silently being normalized back to the old behavior.
 */
export function getCitedDecisionRecipe(
  recipe: FallbackRecipe,
): readonly z.infer<typeof CitedDecisionRecipeSchema>[] {
  const rule = recipe.assemblyRules.citedDecisions;
  if (!rule || rule.strategy !== "recipe-editorial") {
    throw new Error("fallback recipe citedDecisions must use recipe-editorial strategy");
  }
  const parsed = z.array(CitedDecisionRecipeSchema).safeParse(rule.value);
  if (!parsed.success || parsed.data.length === 0) {
    throw new Error("fallback recipe must declare at least one cited decision");
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Recipe-owned summaries (the c3-fallback-v1 recipe emits zero-evidence arrays
// and its own recipe-owned text directly — no corpus pattern histogram or
// rationale helper is computed here).
// ---------------------------------------------------------------------------

/**
 * Build the design-direction summary from the requester's productContext
 * (echo-product-context strategy). The string is bounded to the candidate
 * schema's BoundedTextValue limit so the producer's candidate always parses.
 * Never reads corpus prose.
 */
export function buildDesignDirectionSummary(
  request: Pick<CreateUiSpecRequest, "productContext">,
  recipe: FallbackRecipe,
): string {
  if (recipe.assemblyRules.designDirection?.strategy !== "echo-product-context") {
    throw new Error("fallback recipe designDirection must use echo-product-context strategy");
  }
  const ctx = request.productContext.trim();
  return ctx.length <= DESIGN_DIRECTION_MAX ? ctx : ctx.slice(0, DESIGN_DIRECTION_MAX);
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
export function buildFixedEmptyArrays(recipe: FallbackRecipe): FixedEmptyArrays {
  const empty = (field: string): readonly never[] => {
    const rule = recipe.assemblyRules[field];
    return rule?.strategy === "fixed-empty" && Array.isArray(rule.value) ? rule.value as unknown as readonly never[] : [];
  };
  return {
    rejectedDefaults: empty("rejectedDefaults"),
    layoutRegions: empty("layoutRegions"),
    responsiveBehavior: empty("responsiveBehavior"),
    componentInventory: empty("componentInventory"),
    interactions: empty("interactions"),
    accessibilityConstraints: empty("accessibilityConstraints"),
    techniques: empty("techniques"),
    antiPatterns: empty("antiPatterns"),
    citedDecisions: empty("citedDecisions"),
    citedReferences: empty("citedReferences"),
  };
}

/**
 * Generate a recipe-owned evidence summary for a sanitized corpus observation.
 * The summary is built from a FIXED template keyed by the allowlisted
 * structured-facts tokens — never from critique/voice/product-name/url/prose.
 *
 * Template (recipe-owned): a comma-joined sentence of every populated fact —
 * pattern, region count, spacing density, corner style, shadow/border flags,
 * accent color, type pairing, and layout form. If the sanitized evidence
 * carries no facts at all, a generic, pattern-free recipe-owned summary is
 * emitted.
 */
export function buildCorpusObservationSummary(evidence: SanitizedEvidence): string {
  // Defensive: the type-boundary test passes raw entry-shaped objects; the
  // sanitized contract always carries structuredFacts, but the builder must
  // not throw on a missing one.
  const f = evidence.structuredFacts ?? {};
  const parts: string[] = [];
  if (f.pattern) parts.push(`${f.pattern} reference`);
  if (typeof f.regionCount === "number") parts.push(`${f.regionCount} regions`);
  if (f.spacingDensity) parts.push(`${f.spacingDensity} spacing`);
  if (f.cornerStyle) parts.push(`${f.cornerStyle} corners`);
  if (f.usesShadows === true) parts.push("shadows");
  if (f.usesShadows === false) parts.push("no shadows");
  if (f.usesBorders === true) parts.push("borders");
  if (f.usesBorders === false) parts.push("no borders");
  if (f.accentColor) parts.push(`accent ${f.accentColor}`);
  if (f.typePairing) parts.push(f.typePairing);
  if (f.layoutForm) parts.push(`layout ${f.layoutForm}`);
  return parts.length > 0 ? parts.join(", ") : "Corpus observation reference";
}
