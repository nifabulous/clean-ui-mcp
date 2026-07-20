/**
 * C2 cost policy — pure forecasting, actual-cost calculation, and budget
 * decisions for the Pass 2 paid pilot.
 *
 * This module consumes the parsed `C2CampaignConfig` and `C2PricingTable`
 * contracts from Task 1 (condition-contracts.ts). All public decisions return
 * structured `{ allowed, reason?, ... }` objects rather than bare booleans, so
 * a denial always carries an unambiguous terminal reason.
 *
 * Two cost notions (spec §8):
 *
 *   - **Forecast** (pre-call, pessimistic): `forecastRunCost` assumes the model
 *     consumes the FULL configured `maxOutputTokens`. This is the worst-case
 *     spend a single call could incur before the campaign stops it.
 *
 *   - **Actual** (post-call, recorded): `calculateActualCost` derives cost from
 *     provider-reported usage (`promptTokens` + `completionTokens`). Actual cost
 *     is recorded even when parsing or validation later fails, so a failed run
 *     still accounts for the paid tokens.
 *
 * Two ceilings (spec §8 + plan OV3):
 *
 *   - **Nominal per-run ceiling** (`maxRunCostUsd: 0.5`): bounds ACTUAL cost
 *     accounting after a call. If actual run cost exceeds it the run terminates
 *     with `run-budget-exceeded`.
 *
 *   - **Effective campaign reserve** (`maxCampaignCostUsd / plannedRunCount` ≈
 *     `$0.4166666667` for a 12-run campaign): bounds FORECASTS before a call.
 *     Reserving less than the nominal $0.50 per call prevents an early
 *     expensive run from making the remaining planned runs impossible to
 *     complete within the $5.00 campaign ceiling. The reserve is derived from
 *     the campaign's exact `plannedRunCount`, never a hardcoded 12.
 *
 * Rounding (spec §8): persisted cost values are rounded to six decimal places
 * ONLY after the calculation completes. Intermediate sums are never rounded.
 */
import type { C2CampaignConfig, C2PricingTable } from "./condition-contracts.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single pricing entry as it appears on the parsed `C2PricingTable`. Exposed
 * as a structural type (not the inferred `C2PricingEntry`) so tests and
 * downstream modules can construct one without importing the Zod schema.
 */
export interface C2PricingEntryLike {
  provider: "openai" | "claude";
  model: string;
  // USD per ONE MILLION tokens (the unit providers publish prices in).
  inputTokenPriceUsdPerMillion: number;
  outputTokenPriceUsdPerMillion: number;
  effectiveDate: string;
  verifiedAt: string;
  sourceUrl: string;
}

/** The set of providers the cost policy knows how to bill. */
export type C2CostProvider = "openai" | "claude";

/** Inputs to a pre-call forecast. */
export interface ForecastRunCostInput {
  /** Prompt token estimate for this run (integer). */
  promptTokens: number;
  /**
   * Configured `maxOutputTokens` for the pinned model. The forecast assumes the
   * model consumes the FULL budget — this is the pessimistic worst case.
   */
  maxOutputTokens: number;
  /** The parsed pricing entry for the pinned (provider, model). */
  pricingEntry: C2PricingEntryLike;
}

/** Output of a pre-call forecast. */
export interface ForecastRunCostResult {
  /** Pessimistic USD cost, rounded to six decimals. */
  forecastUsd: number;
  /** Unrounded forecast (kept for intermediate arithmetic, e.g. reserve sums). */
  rawForecastUsd: number;
}

/** Inputs to a post-call actual-cost calculation. */
export interface CalculateActualCostInput {
  /** Provider-reported prompt token count. */
  promptTokens: number;
  /** Provider-reported completion token count. */
  completionTokens: number;
  /** The parsed pricing entry for the pinned (provider, model). */
  pricingEntry: C2PricingEntryLike;
}

/** Output of a post-call actual-cost calculation. */
export interface CalculateActualCostResult {
  /** Actual USD cost, rounded to six decimals. */
  actualUsd: number;
  /** Unrounded actual cost (kept for intermediate sums, e.g. campaign totals). */
  rawActualUsd: number;
}

/** Inputs to the nominal per-run budget assertion. */
export interface AssertRunBudgetInput {
  /** Pre-call forecast (or post-call actual) USD for this run. */
  forecastUsd: number;
  /** Per-run ceiling (campaign.maxRunCostUsd, pinned to $0.50). */
  ceilingUsd: number;
}

/** Inputs to the campaign-level budget assertion. */
export interface AssertCampaignBudgetInput {
  /** USD already spent in this campaign. */
  spentUsd: number;
  /** USD a prospective run would add (forecast or actual). */
  forecastUsd: number;
  /** Campaign ceiling (campaign.maxCampaignCostUsd, pinned to $5.00). */
  ceilingUsd: number;
}

/** Inputs to the effective-reserve derivation. */
export interface CampaignReserveInput {
  maxCampaignCostUsd: number;
  plannedRunCount: number;
}

/** Structured result of a budget assertion. Never a bare boolean. */
export interface BudgetDecision {
  allowed: boolean;
  reason?: "run-budget-exceeded" | "campaign-budget-exceeded";
}

/** Result of a pricing-table lookup. */
export interface PricingLookupFound {
  found: true;
  value: C2PricingEntryLike;
}
export interface PricingLookupMissing {
  found: false;
  reason: "missing-pricing-entry";
  provider: C2CostProvider;
  model: string;
}
export type PricingLookup = PricingLookupFound | PricingLookupMissing;

/** Inputs to the preflight that forecasts BOTH model lanes against the reserve. */
export interface PreflightCampaignCostsInput {
  campaign: C2CampaignConfig;
  pricingTable: C2PricingTable;
  /** Prompt token estimate for the OpenAI primary lane. */
  primaryPromptTokens: number;
  /** Prompt token estimate for the Claude independent lane. */
  independentPromptTokens: number;
  /**
   * Optional test seam: inject the primary-lane forecast directly instead of
   * deriving it from `pricingTable` + `primaryPromptTokens`. When set, the
   * pricing-table lookup for the primary model is skipped.
   */
  primaryForecastUsdOverride?: number;
  /** Optional test seam for the independent-lane forecast. */
  independentForecastUsdOverride?: number;
}

/** Structured result of the campaign preflight. */
export interface PreflightCampaignCostsAllowed {
  allowed: true;
  /** The effective per-run reserve that was enforced. */
  reserveUsd: number;
  /** OpenAI primary forecast. */
  primaryForecastUsd: number;
  /** Claude independent forecast. */
  independentForecastUsd: number;
}
export interface PreflightCampaignCostsDenied {
  allowed: false;
  /** Terminal reason for the denial. */
  reason: "campaign-reserve-exceeded" | "missing-pricing-entry";
  /**
   * When the denial is a reserve violation, the model whose forecast exceeded
   * the reserve. Absent for a missing-pricing-entry denial (the missing entry
   * is the relevant signal).
   */
  violatingModel?: string;
  /** The effective per-run reserve that was enforced (when computable). */
  reserveUsd?: number;
  /** OpenAI primary forecast (when computable). */
  primaryForecastUsd?: number;
  /** Claude independent forecast (when computable). */
  independentForecastUsd?: number;
}
export type PreflightCampaignCosts =
  | PreflightCampaignCostsAllowed
  | PreflightCampaignCostsDenied;

// ---------------------------------------------------------------------------
// Rounding — six decimals, only after calculation.
// ---------------------------------------------------------------------------

const PERSISTED_COST_DECIMALS = 6;

/**
 * Round a cost value to six decimal places for persistence. Use this ONLY on
 * the final result of a calculation; never on an intermediate sum.
 *
 * Uses the platform's half-up rounding via `Math.round` after scaling, which
 * matches the project's decimal persistence convention. (Math.round rounds
 * half toward positive infinity; for non-negative costs this is half-up.)
 */
export function roundPersistedCost(value: number): number {
  const scale = 10 ** PERSISTED_COST_DECIMALS;
  return Math.round(value * scale) / scale;
}

// ---------------------------------------------------------------------------
// Cost math — normalize provider prices (USD per million tokens) to USD.
// ---------------------------------------------------------------------------

/**
 * Convert a token quantity priced at USD-per-million into a USD amount.
 *
 * Providers publish prices as "USD per 1,000,000 tokens", so dividing the
 * token count by 1,000,000 and multiplying by the per-million price yields the
 * USD spend. The result is NOT rounded here — callers round only the final
 * persisted value.
 */
function tokensToUsd(tokens: number, priceUsdPerMillion: number): number {
  return (tokens / 1_000_000) * priceUsdPerMillion;
}

// ---------------------------------------------------------------------------
// Forecast (pre-call, pessimistic)
// ---------------------------------------------------------------------------

/**
 * Forecast the worst-case USD cost of a single run. The forecast assumes the
 * model consumes the FULL `maxOutputTokens` budget (pessimistic), so a call
 * can never exceed what preflight approved.
 */
export function forecastRunCost(input: ForecastRunCostInput): ForecastRunCostResult {
  const promptCost = tokensToUsd(input.promptTokens, input.pricingEntry.inputTokenPriceUsdPerMillion);
  const outputCost = tokensToUsd(
    input.maxOutputTokens,
    input.pricingEntry.outputTokenPriceUsdPerMillion,
  );
  const raw = promptCost + outputCost;
  return {
    rawForecastUsd: raw,
    forecastUsd: roundPersistedCost(raw),
  };
}

// ---------------------------------------------------------------------------
// Actual (post-call, from provider-reported usage)
// ---------------------------------------------------------------------------

/**
 * Calculate the actual USD cost of a completed run from provider-reported
 * usage. Actual cost is recorded even when parsing or validation later fails,
 * so a failed run still accounts for the paid tokens it consumed.
 */
export function calculateActualCost(input: CalculateActualCostInput): CalculateActualCostResult {
  const promptCost = tokensToUsd(input.promptTokens, input.pricingEntry.inputTokenPriceUsdPerMillion);
  const completionCost = tokensToUsd(
    input.completionTokens,
    input.pricingEntry.outputTokenPriceUsdPerMillion,
  );
  const raw = promptCost + completionCost;
  return {
    rawActualUsd: raw,
    actualUsd: roundPersistedCost(raw),
  };
}

// ---------------------------------------------------------------------------
// Reserve arithmetic — effective per-run ceiling = campaign / plannedRunCount.
// ---------------------------------------------------------------------------

/**
 * Derive the effective per-run reserve from the campaign ceiling and the exact
 * planned run count. The reserve is what preflight checks each forecast
 * against; it is STRICTLY LESS than the nominal $0.50 ceiling so an early
 * expensive run cannot make the remaining runs impossible to complete.
 *
 * For the reviewed pilot (12 planned runs, $5 ceiling) this is `$5 / 12 ≈
 * $0.4166666667`. A campaign with `plannedRunCount: 6` gets `$5 / 6 ≈ $0.8333`.
 */
export function campaignReserveUsd(input: CampaignReserveInput): number {
  if (!Number.isFinite(input.maxCampaignCostUsd) || input.maxCampaignCostUsd < 0) {
    throw new Error(`campaignReserveUsd: maxCampaignCostUsd must be a finite non-negative number`);
  }
  if (!Number.isInteger(input.plannedRunCount) || input.plannedRunCount <= 0) {
    throw new Error(`campaignReserveUsd: plannedRunCount must be a positive integer`);
  }
  // Intentionally NOT rounded: the reserve is compared against unrounded
  // forecasts, and rounding it would shrink or expand the boundary by a
  // sub-cent epsilon. The plan pins the exact $5/12 = 0.4166666667 value.
  return input.maxCampaignCostUsd / input.plannedRunCount;
}

// ---------------------------------------------------------------------------
// Budget assertions — structured denials, never bare booleans.
// ---------------------------------------------------------------------------

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

/**
 * Assert a single run's forecast against the nominal per-run ceiling. Returns
 * `{ allowed, reason }`. A non-finite or negative forecast is treated as a
 * denial — fail closed.
 */
export function assertRunBudget(input: AssertRunBudgetInput): BudgetDecision {
  if (!isFiniteNonNegative(input.forecastUsd) || input.forecastUsd > input.ceilingUsd) {
    return { allowed: false, reason: "run-budget-exceeded" };
  }
  return { allowed: true };
}

/**
 * Assert that `spent + forecast` fits inside the campaign ceiling. Returns
 * `{ allowed, reason }`. The sum is computed on unrounded inputs; a non-finite
 * spent total is treated as a denial.
 */
export function assertCampaignBudget(input: AssertCampaignBudgetInput): BudgetDecision {
  const total = input.spentUsd + input.forecastUsd;
  if (!Number.isFinite(total) || total > input.ceilingUsd) {
    return { allowed: false, reason: "campaign-budget-exceeded" };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Pricing-table lookup
// ---------------------------------------------------------------------------

/**
 * Look up the pricing entry for a pinned (provider, model). Returns a
 * structured missing-entry result rather than throwing, so the caller can
 * surface a deterministic terminal reason.
 */
export function findPricingEntry(input: {
  pricingTable: C2PricingTable;
  provider: C2CostProvider;
  model: string;
}): PricingLookup {
  const match = input.pricingTable.entries.find(
    (entry) => entry.provider === input.provider && entry.model === input.model,
  );
  if (!match) {
    return {
      found: false,
      reason: "missing-pricing-entry",
      provider: input.provider,
      model: input.model,
    };
  }
  return { found: true, value: match };
}

// ---------------------------------------------------------------------------
// Campaign preflight — both model lanes against the effective reserve.
// ---------------------------------------------------------------------------

function forecastForLane(
  campaign: C2CampaignConfig,
  pricingTable: C2PricingTable,
  promptTokens: number,
  model: C2CampaignConfig["primary"],
  override: number | undefined,
):
  | { ok: true; forecastUsd: number }
  | { ok: false; reason: "missing-pricing-entry"; provider: C2CostProvider; model: string } {
  if (override !== undefined) {
    return { ok: true, forecastUsd: override };
  }
  const lookup = findPricingEntry({
    pricingTable,
    provider: model.provider,
    model: model.model,
  });
  if (!lookup.found) {
    return {
      ok: false,
      reason: "missing-pricing-entry",
      provider: lookup.provider,
      model: lookup.model,
    };
  }
  const forecast = forecastRunCost({
    promptTokens,
    maxOutputTokens: model.maxOutputTokens,
    pricingEntry: lookup.value,
  });
  return { ok: true, forecastUsd: forecast.rawForecastUsd };
}

/**
 * Preflight the campaign's two model lanes against the effective per-run
 * reserve. Both the OpenAI primary and the Claude independent forecast are
 * computed at full-prompt + full-`maxOutputTokens`; if EITHER exceeds the
 * reserve the campaign is rejected with `campaign-reserve-exceeded`.
 *
 * The reserve is derived from the campaign's exact `plannedRunCount`, not a
 * hardcoded 12. A missing pricing entry for either model fails closed with
 * `missing-pricing-entry` before any cost comparison.
 */
export function preflightCampaignCosts(input: PreflightCampaignCostsInput): PreflightCampaignCosts {
  const reserveUsd = campaignReserveUsd({
    maxCampaignCostUsd: input.campaign.maxCampaignCostUsd,
    plannedRunCount: input.campaign.plannedRunCount,
  });

  const primary = forecastForLane(
    input.campaign,
    input.pricingTable,
    input.primaryPromptTokens,
    input.campaign.primary,
    input.primaryForecastUsdOverride,
  );
  if (!primary.ok) {
    return {
      allowed: false,
      reason: "missing-pricing-entry",
      reserveUsd,
    };
  }

  const independent = forecastForLane(
    input.campaign,
    input.pricingTable,
    input.independentPromptTokens,
    input.campaign.independent,
    input.independentForecastUsdOverride,
  );
  if (!independent.ok) {
    return {
      allowed: false,
      reason: "missing-pricing-entry",
      reserveUsd,
      primaryForecastUsd: roundPersistedCost(primary.forecastUsd),
    };
  }

  const primaryForecastUsd = roundPersistedCost(primary.forecastUsd);
  const independentForecastUsd = roundPersistedCost(independent.forecastUsd);

  // Compare UNROUNDED forecasts against the UNROUNDED reserve so a sub-cent
  // rounding never flips the boundary. The plan pins exactly-at-limit as
  // allowed (boundary inclusive).
  if (primary.forecastUsd > reserveUsd) {
    return {
      allowed: false,
      reason: "campaign-reserve-exceeded",
      violatingModel: input.campaign.primary.model,
      reserveUsd,
      primaryForecastUsd,
      independentForecastUsd,
    };
  }
  if (independent.forecastUsd > reserveUsd) {
    return {
      allowed: false,
      reason: "campaign-reserve-exceeded",
      violatingModel: input.campaign.independent.model,
      reserveUsd,
      primaryForecastUsd,
      independentForecastUsd,
    };
  }

  return {
    allowed: true,
    reserveUsd,
    primaryForecastUsd,
    independentForecastUsd,
  };
}
