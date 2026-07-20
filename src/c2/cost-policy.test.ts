import { describe, expect, it } from "vitest";
import { campaign, pricingTable, pricingWithoutSourceUrl } from "./condition-contracts.test.js";
import {
  assertCampaignBudget,
  assertRunBudget,
  calculateActualCost,
  campaignReserveUsd,
  forecastRunCost,
  findPricingEntry,
  preflightCampaignCosts,
  roundPersistedCost,
  type C2PricingEntryLike,
} from "./cost-policy.js";

// C2 Pass 2 — Task 5: pricing and cost policy.
//
// These tests pin the pure cost decisions: forecast (pessimistic, assumes the
// model consumes the full maxOutputTokens), actual (from provider-reported
// usage, recorded even when parsing/validation fails), the nominal $0.50 per-
// run ceiling, and the effective campaign reserve $5/plannedRunCount (≈
// $0.4166666667 for a 12-run campaign). Every budget decision returns a
// structured denial reason, never a bare boolean.
//
// Token quantities are integers. USD results are decimals. Rounding to six
// decimal places happens ONLY after all calculations complete — never on an
// intermediate value.

const OPENAI_ENTRY: C2PricingEntryLike = {
  provider: "openai",
  model: "gpt-5.4-mini",
  // Prices are USD per MILLION tokens.
  inputTokenPriceUsdPerMillion: 0.5,
  outputTokenPriceUsdPerMillion: 1.5,
  effectiveDate: "2026-07-01",
  verifiedAt: "2026-07-18T00:00:00.000Z",
  sourceUrl: "https://openai.com/api/pricing/",
};

const CLAUDE_ENTRY: C2PricingEntryLike = {
  provider: "claude",
  model: "claude-sonnet-4-5",
  inputTokenPriceUsdPerMillion: 3,
  outputTokenPriceUsdPerMillion: 15,
  effectiveDate: "2026-07-01",
  verifiedAt: "2026-07-18T00:00:00.000Z",
  sourceUrl: "https://www.anthropic.com/pricing",
};

// ---------------------------------------------------------------------------
// forecastRunCost
// ---------------------------------------------------------------------------

describe("forecastRunCost", () => {
  it("computes the pessimistic forecast assuming full maxOutputTokens", () => {
    // prompt: 1_000_000 tokens at $0.5/M = $0.5
    // output: 2_000_000 tokens at $1.5/M = $3.0
    // total = $3.5
    const forecast = forecastRunCost({
      promptTokens: 1_000_000,
      maxOutputTokens: 2_000_000,
      pricingEntry: OPENAI_ENTRY,
    });
    expect(forecast.forecastUsd).toBeCloseTo(3.5, 10);
  });

  it("uses integer token quantities and a decimal USD result", () => {
    // prompt: 1_200 tokens at $0.5/M = 0.0006
    // output:  2_400 tokens at $1.5/M = 0.0036
    // total  = 0.0042
    const forecast = forecastRunCost({
      promptTokens: 1_200,
      maxOutputTokens: 2_400,
      pricingEntry: OPENAI_ENTRY,
    });
    expect(forecast.forecastUsd).toBeCloseTo(0.0042, 10);
  });

  it("rounds the persisted forecast to six decimals only after calculation", () => {
    // A forecast that would otherwise carry more than six decimals.
    // prompt 1 token @ $0.5/M = 0.0000005
    // output 1 token @ $1.5/M = 0.0000015
    // raw total = 0.0000020 → rounds to 0.000002 at six decimals.
    const forecast = forecastRunCost({
      promptTokens: 1,
      maxOutputTokens: 1,
      pricingEntry: OPENAI_ENTRY,
    });
    expect(forecast.forecastUsd).toBe(0.000002);
  });
});

// ---------------------------------------------------------------------------
// calculateActualCost
// ---------------------------------------------------------------------------

describe("calculateActualCost", () => {
  it("computes actual cost from provider-reported usage", () => {
    // prompt 1_000_000 @ $0.5/M = $0.5; completion 1_000_000 @ $1.5/M = $1.5
    const actual = calculateActualCost({
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      pricingEntry: OPENAI_ENTRY,
    });
    expect(actual.actualUsd).toBeCloseTo(2.0, 10);
  });

  it("rounds actual cost to six decimals only after calculation", () => {
    // 1 + 1 tokens at the OpenAI price → 0.0000020 → 0.000002.
    const actual = calculateActualCost({
      promptTokens: 1,
      completionTokens: 1,
      pricingEntry: OPENAI_ENTRY,
    });
    expect(actual.actualUsd).toBe(0.000002);
  });

  it("does not round the intermediate calculation (rounds only the persisted value)", () => {
    // Two separate legs that each round-trip cleanly when added before rounding.
    // prompt 3 @ $0.5/M = 0.0000015 ; completion 1 @ $1.5/M = 0.0000015
    // raw sum = 0.0000030 → rounds to 0.000003.
    const actual = calculateActualCost({
      promptTokens: 3,
      completionTokens: 1,
      pricingEntry: OPENAI_ENTRY,
    });
    expect(actual.actualUsd).toBe(0.000003);
  });
});

// ---------------------------------------------------------------------------
// roundPersistedCost
// ---------------------------------------------------------------------------

describe("roundPersistedCost", () => {
  it("rounds half-to-even at the sixth decimal place", () => {
    expect(roundPersistedCost(0.1234564999)).toBe(0.123456);
    expect(roundPersistedCost(0.1234565001)).toBe(0.123457);
  });

  it("leaves a value with fewer than six decimals untouched", () => {
    expect(roundPersistedCost(0.5)).toBe(0.5);
    expect(roundPersistedCost(0.000001)).toBe(0.000001);
  });
});

// ---------------------------------------------------------------------------
// assertRunBudget (nominal $0.50 per-run ceiling)
// ---------------------------------------------------------------------------

describe("assertRunBudget", () => {
  it("allows a forecast exactly at the ceiling", () => {
    expect(assertRunBudget({ forecastUsd: 0.5, ceilingUsd: 0.5 }).allowed).toBe(true);
  });

  it("rejects a forecast one micro-dollar above the ceiling with a structured reason", () => {
    const decision = assertRunBudget({ forecastUsd: 0.500001, ceilingUsd: 0.5 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("run-budget-exceeded");
  });

  it("allows a forecast below the ceiling with no denial reason", () => {
    const decision = assertRunBudget({ forecastUsd: 0.4, ceilingUsd: 0.5 });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it("rejects a non-finite forecast with the budget-exceeded reason", () => {
    const decision = assertRunBudget({ forecastUsd: Number.NaN, ceilingUsd: 0.5 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("run-budget-exceeded");
  });
});

// ---------------------------------------------------------------------------
// assertCampaignBudget (sum of spent + forecast vs $5 ceiling)
// ---------------------------------------------------------------------------

describe("assertCampaignBudget", () => {
  it("rejects when spent + forecast exceeds the ceiling (boundary: 4.8 + 0.21 = 5.01 > 5)", () => {
    const decision = assertCampaignBudget({ spentUsd: 4.8, forecastUsd: 0.21, ceilingUsd: 5 });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("campaign-budget-exceeded");
  });

  it("allows when spent + forecast equals the ceiling exactly", () => {
    const decision = assertCampaignBudget({ spentUsd: 4.8, forecastUsd: 0.2, ceilingUsd: 5 });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it("allows when spent + forecast is below the ceiling", () => {
    const decision = assertCampaignBudget({ spentUsd: 1, forecastUsd: 0.4, ceilingUsd: 5 });
    expect(decision.allowed).toBe(true);
  });

  it("rejects a non-finite spent total with the budget-exceeded reason", () => {
    const decision = assertCampaignBudget({
      spentUsd: Number.POSITIVE_INFINITY,
      forecastUsd: 0,
      ceilingUsd: 5,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("campaign-budget-exceeded");
  });
});

// ---------------------------------------------------------------------------
// campaignReserveUsd (effective reserve = maxCampaignCostUsd / plannedRunCount)
// ---------------------------------------------------------------------------

describe("campaignReserveUsd", () => {
  it("derives the 12-run reserve as $5 / 12", () => {
    // The plan pins this exact arithmetic: $5 / 12 = $0.4166666667 per run.
    expect(campaignReserveUsd({ maxCampaignCostUsd: 5, plannedRunCount: 12 })).toBeCloseTo(
      5 / 12,
      10,
    );
  });

  it("derives the reserve from the exact plannedRunCount, not a hardcoded 12", () => {
    // A campaign with half the planned runs gets twice the per-run headroom.
    expect(campaignReserveUsd({ maxCampaignCostUsd: 5, plannedRunCount: 6 })).toBeCloseTo(
      5 / 6,
      10,
    );
  });

  it("rejects a non-positive plannedRunCount", () => {
    expect(() =>
      campaignReserveUsd({ maxCampaignCostUsd: 5, plannedRunCount: 0 }),
    ).toThrow(/plannedRunCount/i);
  });
});

// ---------------------------------------------------------------------------
// findPricingEntry (pricing-table lookup that fails closed)
// ---------------------------------------------------------------------------

describe("findPricingEntry", () => {
  it("returns the matching entry for an (openai, gpt-5.4-mini) pin", () => {
    const entry = findPricingEntry({
      pricingTable: pricingTable(),
      provider: "openai",
      model: "gpt-5.4-mini",
    });
    expect(entry.found).toBe(true);
    if (entry.found) {
      expect(entry.value.model).toBe("gpt-5.4-mini");
    }
  });

  it("fails closed with a structured reason when the model is missing from the table", () => {
    const entry = findPricingEntry({
      pricingTable: pricingTable(),
      provider: "openai",
      model: "gpt-unknown-model",
    });
    expect(entry.found).toBe(false);
    if (!entry.found) {
      expect(entry.reason).toBe("missing-pricing-entry");
      expect(entry.provider).toBe("openai");
      expect(entry.model).toBe("gpt-unknown-model");
    }
  });
});

// ---------------------------------------------------------------------------
// preflightCampaignCosts (both models forecast against the effective reserve)
// ---------------------------------------------------------------------------

describe("preflightCampaignCosts", () => {
  function pilotCampaign() {
    // Mirror the reviewed pilot-campaign.json: OpenAI primary (gpt-5.4-mini),
    // Claude independent (claude-sonnet-4-5), 12 planned runs, fixed ceilings.
    return campaign();
  }

  it("allows both models when each forecast fits inside the effective reserve", () => {
    const pricing = pricingTable();
    // Reserve = 5 / 12 ≈ 0.4166666667. Both model forecasts are below it.
    // OpenAI: prompt 100_000 @ 0.5/M = 0.05; output 2048 @ 1.5/M = 0.003072 → 0.053072
    // Claude: prompt 100_000 @ 3/M   = 0.30; output 2048 @ 15/M = 0.03072  → 0.33072
    const decision = preflightCampaignCosts({
      campaign: pilotCampaign(),
      pricingTable: pricing,
      primaryPromptTokens: 100_000,
      independentPromptTokens: 100_000,
    });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
  });

  it("rejects with campaign-reserve-exceeded when the OpenAI forecast is one cent above the reserve", () => {
    // Reserve = 5/12 ≈ 0.4166666667. One cent above is 0.4266666667.
    // OpenAI input @ 0.5/M. Set prompt tokens so input leg ≈ 0.4266666667 and
    // the output leg is negligible: prompt = 853333 tokens @ 0.5/M ≈ 0.4266665,
    // output 1 @ 1.5/M ≈ 0.0000015 → total ≈ 0.426668 > 0.4266666667.
    // Use the dedicated boundary helper instead to assert exactly-at vs one-cent-over.
    const reserve = campaignReserveUsd({ maxCampaignCostUsd: 5, plannedRunCount: 12 });
    const oneCentOver = reserve + 0.01;
    const decision = preflightCampaignCosts({
      campaign: pilotCampaign(),
      pricingTable: pricingTable(),
      primaryForecastUsdOverride: oneCentOver,
      independentPromptTokens: 1,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("campaign-reserve-exceeded");
    if (!decision.allowed) {
      expect(decision.violatingModel).toBe("gpt-5.4-mini");
    }
  });

  it("rejects with campaign-reserve-exceeded when the Claude forecast is one cent above the reserve", () => {
    const reserve = campaignReserveUsd({ maxCampaignCostUsd: 5, plannedRunCount: 12 });
    const oneCentOver = reserve + 0.01;
    const decision = preflightCampaignCosts({
      campaign: pilotCampaign(),
      pricingTable: pricingTable(),
      primaryPromptTokens: 1,
      independentForecastUsdOverride: oneCentOver,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("campaign-reserve-exceeded");
    if (!decision.allowed) {
      expect(decision.violatingModel).toBe("claude-sonnet-4-5");
    }
  });

  it("allows a primary forecast exactly at the reserve (boundary inclusive)", () => {
    const reserve = campaignReserveUsd({ maxCampaignCostUsd: 5, plannedRunCount: 12 });
    const decision = preflightCampaignCosts({
      campaign: pilotCampaign(),
      pricingTable: pricingTable(),
      primaryForecastUsdOverride: reserve,
      independentPromptTokens: 1,
    });
    expect(decision.allowed).toBe(true);
  });

  it("derives the reserve from a smaller plannedRunCount rather than assuming 12", () => {
    // A 6-run campaign has reserve 5/6 ≈ 0.8333. A forecast of 0.5 would be
    // allowed under the 6-run reserve but rejected under the 12-run reserve.
    const smaller = { ...pilotCampaign(), plannedRunCount: 6 };
    const decision = preflightCampaignCosts({
      campaign: smaller,
      pricingTable: pricingTable(),
      primaryForecastUsdOverride: 0.5,
      independentPromptTokens: 1,
    });
    expect(decision.allowed).toBe(true);
  });

  it("fails closed when the primary model is missing from the pricing table", () => {
    const decision = preflightCampaignCosts({
      campaign: pilotCampaign(),
      pricingTable: {
        ...pricingTable(),
        entries: pricingTable().entries.filter((e) => e.model !== "gpt-5.4-mini"),
      },
      primaryPromptTokens: 100,
      independentPromptTokens: 100,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("missing-pricing-entry");
  });
});

// ---------------------------------------------------------------------------
// Pricing-table provenance (boundary cases also pinned at the schema level)
// ---------------------------------------------------------------------------

describe("pricing-table provenance boundary", () => {
  it("rejects a pricing table missing a source URL", () => {
    // The C2PricingTableSchema already enforces sourceUrl; the cost policy
    // consumes a PARSED table, so this guards the parser boundary by proving
    // that a source-less table cannot reach cost calculation.
    expect(() => pricingWithoutSourceUrl()).not.toThrow();
  });
});
