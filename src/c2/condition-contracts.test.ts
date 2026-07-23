import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  C2ConditionInputSchema,
  C2EvidenceRecordSchema,
  C2CampaignConfigSchema,
  C2PricingTableSchema,
  C2CalibrationProposalSchema,
  C2FrozenCalibrationSchema,
} from "./condition-contracts.js";
import { findPricingEntry } from "./cost-policy.js";

const SHA_64 = "a".repeat(64);

function fileRef(artifactId: string, path: string, sha256: string = SHA_64) {
  return { artifactId, path, sha256 };
}

function evidenceRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: "evidence.business-hierarchy",
    authorityLane: "retain",
    sourceType: "brief-fragment",
    sourceArtifactId: "c2-brief-stablecoin-home-v1",
    sourceSha256: SHA_64,
    contentSha256: SHA_64,
    rank: null,
    score: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Condition input factories
// ---------------------------------------------------------------------------

function briefOnlyInput() {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-condition-input",
    artifactId: "c2-condition-brief-only-stablecoin-home-v1",
    casePackageRef: fileRef("c2-package-stablecoin-home-v1", "eval/c2/pilot/stablecoin-home/package.json"),
    condition: "brief-only",
    briefRef: fileRef("c2-brief-stablecoin-home-v1", "eval/c2/pilot/stablecoin-home/brief.json"),
    evidence: [],
    corpusSha256: null,
    retrievalIndexSha256: null,
    retrieval: null,
    sourceSnapshotRefs: [],
    inputSha256: SHA_64,
  };
}

function currentGroundedInput() {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-condition-input",
    artifactId: "c2-condition-current-grounded-stablecoin-home-v1",
    casePackageRef: fileRef("c2-package-stablecoin-home-v1", "eval/c2/pilot/stablecoin-home/package.json"),
    condition: "current-grounded",
    briefRef: fileRef("c2-brief-stablecoin-home-v1", "eval/c2/pilot/stablecoin-home/brief.json"),
    evidence: [
      evidenceRecord({
        id: "corpus:entry.stablecoin-home",
        authorityLane: "adapt",
        sourceType: "corpus-entry",
        sourceArtifactId: "corpus-entry.stablecoin-home",
        rank: 1,
        score: 0.91,
      }),
      evidenceRecord({
        id: "brief:constraint.audience",
        sourceType: "brief-fragment",
        rank: null,
        score: null,
      }),
    ],
    corpusSha256: SHA_64,
    retrievalIndexSha256: SHA_64,
    retrieval: {
      query: "stablecoin home audience hierarchy",
      configurationSha256: SHA_64,
      rankedResult: [
        {
          entryId: "corpus-entry.stablecoin-home",
          rank: 1,
          score: 0.91,
          contentSha256: SHA_64,
        },
      ],
      selectedEntryIds: ["corpus-entry.stablecoin-home"],
    },
    sourceSnapshotRefs: [],
    inputSha256: SHA_64,
  };
}

function goldEvidenceInput() {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-condition-input",
    artifactId: "c2-condition-gold-evidence-stablecoin-home-v1",
    casePackageRef: fileRef("c2-package-stablecoin-home-v1", "eval/c2/pilot/stablecoin-home/package.json"),
    condition: "gold-evidence",
    briefRef: fileRef("c2-brief-stablecoin-home-v1", "eval/c2/pilot/stablecoin-home/brief.json"),
    evidence: [
      evidenceRecord({
        id: "gold.evidence.business-hierarchy",
        sourceType: "source-snapshot",
        sourceArtifactId: "gold-packet.stablecoin-home-v1",
      }),
    ],
    corpusSha256: SHA_64,
    retrievalIndexSha256: SHA_64,
    retrieval: null,
    sourceSnapshotRefs: [],
    goldPacketRef: fileRef("gold-packet.stablecoin-home-v1", ".c2-private/c2/gold/stablecoin-home.json"),
    resolvedGoldIds: ["gold.evidence.business-hierarchy"],
    inputSha256: SHA_64,
  };
}

// ---------------------------------------------------------------------------
// Campaign config factory
// ---------------------------------------------------------------------------

function pinnedModel(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai",
    model: "gpt-5.4-mini",
    apiKeyEnv: "OPENAI_API_KEY",
    maxOutputTokens: 2048,
    samplingParameters: { temperature: 0.2, top_p: 0.95, seed: 7 },
    ...overrides,
  };
}

export function campaign() {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-campaign-config",
    artifactId: "c2-campaign-pilot-v1",
    primary: pinnedModel(),
    independent: pinnedModel({
      provider: "claude",
      model: "claude-sonnet-4-5",
      apiKeyEnv: "ANTHROPIC_API_KEY",
    }),
    maxRunCostUsd: 0.5,
    maxCampaignCostUsd: 5,
    maxAttempts: 3,
    cases: ["stablecoin-home", "auth-flow", "safety-reporting"],
    conditions: ["brief-only", "current-grounded", "gold-evidence"],
    independentConditions: ["current-grounded"],
    plannedRunCount: 12,
    retrievalMode: "keyword-only",
  };
}

// ---------------------------------------------------------------------------
// Pricing table factory
// ---------------------------------------------------------------------------

function pricingEntry(overrides: Record<string, unknown> = {}) {
  return {
    provider: "openai",
    model: "gpt-5.4-mini",
    inputTokenPriceUsdPerMillion: 0.5,
    outputTokenPriceUsdPerMillion: 1.5,
    effectiveDate: "2026-07-01",
    verifiedAt: "2026-07-18T00:00:00.000Z",
    sourceUrl: "https://openai.com/api/pricing/",
    ...overrides,
  };
}

export function pricingTable() {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-pricing-table",
    artifactId: "c2-pricing-table-v1",
    campaignStartsAt: "2026-07-20T00:00:00.000Z",
    entries: [
      pricingEntry(),
      pricingEntry({
        provider: "claude",
        model: "claude-sonnet-4-5",
        inputTokenPriceUsdPerMillion: 3,
        outputTokenPriceUsdPerMillion: 15,
        sourceUrl: "https://www.anthropic.com/pricing",
      }),
    ],
  };
}

export function pricingWithoutSourceUrl() {
  const entries = pricingTable().entries.map((entry) => {
    const { sourceUrl: _omit, ...rest } = entry;
    return rest;
  });
  return { ...pricingTable(), entries };
}

// ---------------------------------------------------------------------------
// Calibration proposal factory
// ---------------------------------------------------------------------------

function calibrationMeasurements() {
  return {
    conditionDeltas: [
      { dimension: "product-appropriateness", briefOnlyMean: 3.1, currentGroundedMean: 3.5, goldEvidenceMean: 3.8 },
    ],
    regressions: [],
    readinessTransitions: [
      { caseId: "stablecoin-home", briefOnlyReady: false, currentGroundedReady: true, goldEvidenceReady: true },
    ],
    deterministicTransitions: [
      { caseId: "stablecoin-home", briefOnlyComplete: false, currentGroundedComplete: true, goldEvidenceComplete: true },
    ],
    safetyResults: [
      { caseId: "safety-reporting", briefOnlyCompliant: false, currentGroundedCompliant: true, goldEvidenceCompliant: true },
    ],
    goldHeadroom: { currentGroundedMean: 3.5, goldEvidenceMean: 3.8 },
    independentCompatibility: {
      criticalDecisionCoverageComplete: true,
      contradictoryCriticalDecisions: false,
      constraintsRespected: true,
      forbiddenClaimsRespected: true,
      compatibleJourneys: true,
      safetyPassedIndependently: true,
    },
    observedCosts: { totalUsd: 0.42, perRunUsd: [0.04, 0.05, 0.03], forecastTotalUsd: 0.6 },
  };
}

export function calibrationProposal() {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-calibration-proposal",
    artifactId: "c2-calibration-proposal-pilot-v1",
    campaignConfigRef: fileRef("c2-campaign-pilot-v1", "eval/c2/config/pilot-campaign.json"),
    pricingTableRef: fileRef("c2-pricing-table-v1", "eval/c2/config/pricing.json"),
    measurements: calibrationMeasurements(),
    proposalSha256: SHA_64,
  };
}

// ---------------------------------------------------------------------------
// Frozen calibration factory
// ---------------------------------------------------------------------------

export function frozenCalibration() {
  return {
    schemaVersion: "1.0",
    artifactType: "c2-frozen-calibration",
    artifactId: "c2-frozen-calibration-pilot-v1",
    proposalRef: fileRef("c2-calibration-proposal-pilot-v1", ".c2-private/c2/proposals/pilot.json"),
    runManifestRefs: [fileRef("c2-run-stablecoin-home-v1", "eval/c2/runs/stablecoin-home.json")],
    scorecardRefs: [fileRef("c2-scorecard-stablecoin-home-v1", "eval/c2/scorecards/stablecoin-home.json")],
    pricingTableRef: fileRef("c2-pricing-table-v1", "eval/c2/config/pricing.json"),
    campaignConfigRef: fileRef("c2-campaign-pilot-v1", "eval/c2/config/pilot-campaign.json"),
    reviewerActorId: "reviewer.gold-1",
    reviewerRole: "Gold Label Owner",
    rationale: "Pilot demonstrated a positive, non-regressive material benefit.",
    materialBenefitMinimum: 0.3,
    regressionTolerance: 0.1,
    independentChecklist: {
      criticalDecisionCoverageComplete: true,
      contradictoryCriticalDecisions: false,
      constraintsRespected: true,
      forbiddenClaimsRespected: true,
      compatibleJourneys: true,
      safetyPassedIndependently: true,
    },
    maxRunCostUsd: 0.5,
    maxCampaignCostUsd: 5,
    frozenAt: "2026-07-20T12:00:00.000Z",
  };
}

// ===========================================================================

describe("C2ConditionInputSchema", () => {
  it("parses a valid brief-only input with no evidence and no corpus hashes", () => {
    expect(C2ConditionInputSchema.safeParse(briefOnlyInput()).success).toBe(true);
  });

  it("forbids evidence in a brief-only input", () => {
    expect(
      C2ConditionInputSchema.safeParse({ ...briefOnlyInput(), evidence: [evidenceRecord()] }).success,
    ).toBe(false);
  });

  it("forbids corpus metadata in a brief-only input", () => {
    expect(
      C2ConditionInputSchema.safeParse({ ...briefOnlyInput(), corpusSha256: SHA_64 }).success,
    ).toBe(false);
  });

  it("parses a valid current-grounded input with corpus metadata and complete ranked result", () => {
    expect(C2ConditionInputSchema.safeParse(currentGroundedInput()).success).toBe(true);
  });

  it("requires corpus metadata for current-grounded input", () => {
    expect(
      C2ConditionInputSchema.safeParse({ ...currentGroundedInput(), corpusSha256: null }).success,
    ).toBe(false);
  });

  it("rejects current-grounded input with an empty selected result", () => {
    const input = {
      ...currentGroundedInput(),
      retrieval: { ...currentGroundedInput().retrieval, selectedEntryIds: [] },
    };
    expect(C2ConditionInputSchema.safeParse(input).success).toBe(false);
  });

  it("accepts a current-grounded condition input whose selectedEntryIds match rankedResult entryIds", () => {
    // Regression for the 787-mismatch bug: the resolver was emitting
    // selectedEntryIds with a `corpus:` prefix while rankedResult.entryId was
    // raw, so the schema's superRefine (`entry.entryId === id`) never matched.
    // This characterization test locks in the CORRECT contract at the schema
    // layer: both fields use raw corpus entry IDs. A future resolver regression
    // that re-introduces the prefix mismatch would not be caught directly here,
    // but this test pins the shape the resolver MUST produce to pass validation.
    const input = {
      schemaVersion: "1.0",
      artifactType: "c2-condition-input",
      artifactId: "c2-condition-current-grounded-resolver-output-v1",
      casePackageRef: fileRef("c2-package-stablecoin-home-v1", "eval/c2/pilot/stablecoin-home/package.json"),
      condition: "current-grounded",
      briefRef: fileRef("c2-brief-stablecoin-home-v1", "eval/c2/pilot/stablecoin-home/brief.json"),
      evidence: [
        evidenceRecord({
          id: "corpus:entry-a", // evidence IDs stay corpus:-prefixed (evidence namespace)
          authorityLane: "adapt",
          sourceType: "corpus-entry",
          sourceArtifactId: "corpus",
          rank: 1,
          score: 0.9,
        }),
      ],
      corpusSha256: SHA_64,
      retrievalIndexSha256: SHA_64,
      retrieval: {
        query: "stablecoin home audience",
        configurationSha256: SHA_64,
        rankedResult: [
          { entryId: "entry-a", rank: 1, score: 0.9, contentSha256: SHA_64 },
        ],
        // selectedEntryIds uses the SAME raw id as rankedResult.entryId.
        selectedEntryIds: ["entry-a"],
      },
      sourceSnapshotRefs: [],
      inputSha256: SHA_64,
    };
    expect(() => C2ConditionInputSchema.parse(input)).not.toThrow();
  });

  it("rejects a current-grounded input where selectedEntryIds uses a corpus: prefix that rankedResult lacks", () => {
    // Inverse characterization: if someone re-introduces the prefix mismatch
    // (rankedResult raw, selectedEntryIds prefixed), the schema MUST reject it.
    const input = {
      ...currentGroundedInput(),
      evidence: [
        evidenceRecord({
          id: "corpus:entry-a",
          authorityLane: "adapt",
          sourceType: "corpus-entry",
          sourceArtifactId: "corpus",
          rank: 1,
          score: 0.9,
        }),
      ],
      retrieval: {
        query: "stablecoin home audience",
        configurationSha256: SHA_64,
        rankedResult: [
          { entryId: "entry-a", rank: 1, score: 0.9, contentSha256: SHA_64 },
        ],
        selectedEntryIds: ["corpus:entry-a"], // mismatched prefix — must fail superRefine
      },
    };
    expect(C2ConditionInputSchema.safeParse(input).success).toBe(false);
  });

  it("parses a valid gold-evidence input with a bound packet", () => {
    expect(C2ConditionInputSchema.safeParse(goldEvidenceInput()).success).toBe(true);
  });

  it("requires a bound packet for gold-evidence input", () => {
    const { goldPacketRef: _omit, ...withoutPacket } = goldEvidenceInput();
    expect(C2ConditionInputSchema.safeParse(withoutPacket).success).toBe(false);
  });

  it("requires every gold ID resolved against evidence", () => {
    expect(
      C2ConditionInputSchema.safeParse({ ...goldEvidenceInput(), resolvedGoldIds: ["gold.missing"] }).success,
    ).toBe(false);
  });

  it("rejects an unknown top-level field", () => {
    expect(
      C2ConditionInputSchema.safeParse({ ...briefOnlyInput(), surprise: 1 }).success,
    ).toBe(false);
  });

  it("requires unique evidence IDs", () => {
    const dup = {
      ...currentGroundedInput(),
      evidence: [evidenceRecord({ id: "dup" }), evidenceRecord({ id: "dup", rank: 2 })],
    };
    expect(C2ConditionInputSchema.safeParse(dup).success).toBe(false);
  });

  it("requires unique selected result ranks and entry IDs", () => {
    const input = {
      ...currentGroundedInput(),
      retrieval: {
        ...currentGroundedInput().retrieval,
        rankedResult: [
          { entryId: "dup", rank: 1, score: 0.9, contentSha256: SHA_64 },
          { entryId: "dup", rank: 1, score: 0.8, contentSha256: SHA_64 },
        ],
        selectedEntryIds: ["dup"],
      },
    };
    expect(C2ConditionInputSchema.safeParse(input).success).toBe(false);
  });
});

describe("C2EvidenceRecordSchema", () => {
  it("parses a complete evidence record", () => {
    expect(C2EvidenceRecordSchema.safeParse(evidenceRecord()).success).toBe(true);
  });

  it("rejects an unknown field", () => {
    expect(
      C2EvidenceRecordSchema.safeParse({ ...evidenceRecord(), surprise: 1 }).success,
    ).toBe(false);
  });
});

describe("C2CampaignConfigSchema", () => {
  it("parses a valid pinned campaign config", () => {
    expect(C2CampaignConfigSchema.safeParse(campaign()).success).toBe(true);
  });

  it("rejects a maxRunCostUsd above the fixed ceiling", () => {
    expect(
      C2CampaignConfigSchema.safeParse({ ...campaign(), maxRunCostUsd: 0.51 }).success,
    ).toBe(false);
  });

  it("rejects a maxCampaignCostUsd above the fixed ceiling", () => {
    expect(
      C2CampaignConfigSchema.safeParse({ ...campaign(), maxCampaignCostUsd: 5.01 }).success,
    ).toBe(false);
  });

  it("rejects plannedRunCount other than 12", () => {
    expect(
      C2CampaignConfigSchema.safeParse({ ...campaign(), plannedRunCount: 11 }).success,
    ).toBe(false);
  });

  it("rejects retrievalMode other than keyword-only", () => {
    expect(
      C2CampaignConfigSchema.safeParse({ ...campaign(), retrievalMode: "vector" }).success,
    ).toBe(false);
  });

  it("rejects conditions tuple that omits a required condition", () => {
    expect(
      C2CampaignConfigSchema.safeParse({
        ...campaign(),
        conditions: ["brief-only", "current-grounded"],
      }).success,
    ).toBe(false);
  });

  it("requires apiKeyEnv to be a non-empty environment-variable NAME (never a secret value)", () => {
    // The campaign stores env-var NAMES only. The schema structurally requires
    // a non-empty value; verifying the value is a name rather than a leaked
    // secret value is a procedural boundary check at freeze time.
    expect(
      C2CampaignConfigSchema.safeParse({
        ...campaign(),
        primary: { ...campaign().primary, apiKeyEnv: "" },
      }).success,
    ).toBe(false);
    expect(
      C2CampaignConfigSchema.safeParse({
        ...campaign(),
        primary: { ...campaign().primary, apiKeyEnv: "   " },
      }).success,
    ).toBe(false);
  });

  it("rejects a non-finite sampling parameter", () => {
    expect(
      C2CampaignConfigSchema.safeParse({
        ...campaign(),
        primary: {
          ...campaign().primary,
          samplingParameters: { temperature: Number.NaN },
        },
      }).success,
    ).toBe(false);
  });

  it("the production pilot-campaign.json pins maxOutputTokens at 4096 for the primary lane and 8192 for the independent lane", () => {
    // Issue B (retry3): candidates were truncated at 2048 output tokens, producing
    // unparseable JSON. The production config pinned 4096 for both lanes so the
    // rich candidate schema (globalDirection + screenBlueprints + sourceDecisions
    // + authorityLanes + acceptanceCriteria + assumptions) had room to complete.
    // Task A1 (Pass 3): the independent (Claude) lane is raised to 8192 after the
    // thinking-disable fix (commit 905fdb6) — a bounded capacity increase to stop
    // Claude Sonnet 5 from truncating the stablecoin current-grounded candidate
    // at 4096. The primary OpenAI lane stays at 4096.
    const cfg = JSON.parse(
      readFileSync("eval/c2/config/pilot-campaign.json", "utf-8"),
    );
    expect(C2CampaignConfigSchema.safeParse(cfg).success).toBe(true);
    expect(cfg.primary.maxOutputTokens).toBe(4096);
    expect(cfg.independent.maxOutputTokens).toBe(8192);
  });
});

describe("C2PricingTableSchema", () => {
  it("parses a valid pricing table", () => {
    expect(C2PricingTableSchema.safeParse(pricingTable()).success).toBe(true);
  });

  it("rejects a pricing table missing a source URL", () => {
    expect(C2PricingTableSchema.safeParse(pricingWithoutSourceUrl()).success).toBe(false);
  });

  it("rejects a non-finite price", () => {
    const entries = pricingTable().entries.map((entry) => ({
      ...entry,
      inputTokenPriceUsdPerMillion: Number.POSITIVE_INFINITY,
    }));
    expect(C2PricingTableSchema.safeParse({ ...pricingTable(), entries }).success).toBe(false);
  });

  it("rejects duplicate provider/model entries", () => {
    const dup = [pricingEntry(), pricingEntry()];
    expect(C2PricingTableSchema.safeParse({ ...pricingTable(), entries: dup }).success).toBe(false);
  });

  it("rejects a verifiedAt older than 30 days before campaign start", () => {
    const entries = pricingTable().entries.map((entry) => ({
      ...entry,
      verifiedAt: "2026-06-01T00:00:00.000Z",
    }));
    expect(C2PricingTableSchema.safeParse({ ...pricingTable(), entries }).success).toBe(false);
  });

  it("rejects an unknown field on a pricing entry", () => {
    const entries = pricingTable().entries.map((entry) => ({ ...entry, extra: 1 }));
    expect(C2PricingTableSchema.safeParse({ ...pricingTable(), entries }).success).toBe(false);
  });
});

describe("C2CalibrationProposalSchema", () => {
  it("parses a valid proposal that does not select thresholds", () => {
    expect(C2CalibrationProposalSchema.safeParse(calibrationProposal()).success).toBe(true);
  });

  it("rejects a proposal that selects a threshold automatically", () => {
    expect(
      C2CalibrationProposalSchema.safeParse({
        ...calibrationProposal(),
        selectedMaterialBenefitMinimum: 0.3,
      }).success,
    ).toBe(false);
  });

  it("rejects an unknown field", () => {
    expect(
      C2CalibrationProposalSchema.safeParse({ ...calibrationProposal(), bonus: true }).success,
    ).toBe(false);
  });
});

describe("C2FrozenCalibrationSchema", () => {
  it("parses a valid frozen calibration", () => {
    expect(C2FrozenCalibrationSchema.safeParse(frozenCalibration()).success).toBe(true);
  });

  it("rejects a CLI-style threshold override field", () => {
    expect(
      C2FrozenCalibrationSchema.safeParse({
        ...frozenCalibration(),
        maxRunCostOverrideUsd: 0.6,
      }).success,
    ).toBe(false);
  });

  it("rejects a non-canonical frozenAt timestamp", () => {
    expect(
      C2FrozenCalibrationSchema.safeParse({ ...frozenCalibration(), frozenAt: "yesterday" }).success,
    ).toBe(false);
  });

  it("rejects a maxRunCostUsd that diverges from the fixed $0.50 ceiling", () => {
    expect(
      C2FrozenCalibrationSchema.safeParse({ ...frozenCalibration(), maxRunCostUsd: 0.6 }).success,
    ).toBe(false);
  });

  it("rejects a negative regression tolerance", () => {
    expect(
      C2FrozenCalibrationSchema.safeParse({ ...frozenCalibration(), regressionTolerance: -0.1 }).success,
    ).toBe(false);
  });

  it("rejects a non-positive material-benefit minimum", () => {
    expect(
      C2FrozenCalibrationSchema.safeParse({ ...frozenCalibration(), materialBenefitMinimum: 0 }).success,
    ).toBe(false);
  });
});

// ===========================================================================
// Task A1 (Pass 3): reviewed Claude remediation configuration.
//
// The Pass 2 pilot had Claude Sonnet 5 truncating at 4096 output tokens on the
// stablecoin current-grounded case. The thinking-disable fix (commit 905fdb6)
// already prevents thinking tokens from consuming the output budget. Task A1
// raises the independent (Claude) lane's `maxOutputTokens` from 4096 to 8192 as
// a bounded capacity increase, leaving the primary (OpenAI) lane unchanged and
// preserving every other matrix field, cap, and ceiling. These tests pin the
// reviewed remediation against future drift and prove the pricing table binds
// the exact pinned models (so a stale `claude-sonnet-4-5` or `gpt-5.4-mini`
// name cannot silently survive in production).
// ===========================================================================

const PILOT_CONFIG_PATH = "eval/c2/config/pilot-campaign.json";
const PRICING_PATH = "eval/c2/config/pricing.json";

describe("Task A1 — reviewed Claude remediation configuration", () => {
  it("parses the remediation config and pins the reviewed ceilings, caps, and matrix", () => {
    const raw = readFileSync(PILOT_CONFIG_PATH, "utf-8");
    const cfg = JSON.parse(raw);

    // The config must be schema-valid as-pinned (the schema pins the literal
    // ceilings and plannedRunCount, so this also guards those literals).
    const parsed = C2CampaignConfigSchema.safeParse(cfg);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.format(), null, 2)).toBe(true);

    // Independent lane: 8192 after the bounded capacity increase. The plan's
    // acceptance criteria require the independent output ceiling to be at
    // least 8192.
    expect(cfg.independent.provider).toBe("claude");
    expect(cfg.independent.maxOutputTokens).toBe(8192);

    // Primary lane: unchanged at 4096.
    expect(cfg.primary.provider).toBe("openai");
    expect(cfg.primary.maxOutputTokens).toBe(4096);

    // Fixed cost ceilings (pinned literals in the schema).
    expect(cfg.maxRunCostUsd).toBe(0.5);
    expect(cfg.maxCampaignCostUsd).toBe(5);

    // Pinned run count.
    expect(cfg.plannedRunCount).toBe(12);

    // All matrix fields unchanged.
    expect(cfg.cases).toEqual([
      "named-inspiration-safety",
      "public-marketing-migration",
      "stablecoin-home",
    ]);
    expect(cfg.conditions).toEqual(["brief-only", "current-grounded", "gold-evidence"]);
    expect(cfg.independentConditions).toEqual(["current-grounded"]);
    expect(cfg.retrievalMode).toBe("keyword-only");
  });

  it("pricing entries exactly match the config's pinned provider/model for both lanes", () => {
    const cfg = JSON.parse(readFileSync(PILOT_CONFIG_PATH, "utf-8"));
    const pricing = JSON.parse(readFileSync(PRICING_PATH, "utf-8"));

    // Pricing table must be schema-valid as-pinned.
    const parsed = C2PricingTableSchema.safeParse(pricing);
    expect(parsed.success, parsed.success ? "" : JSON.stringify(parsed.error.format(), null, 2)).toBe(true);

    // Every config lane (primary + independent) must have an EXACT
    // (provider, model) pricing entry. A stale alias (e.g.
    // `claude-sonnet-4-5`, `gpt-5.4-mini`) must not survive.
    for (const lane of [cfg.primary, cfg.independent]) {
      const match = pricing.entries.find(
        (entry: { provider: string; model: string }) =>
          entry.provider === lane.provider && entry.model === lane.model,
      );
      expect(
        match,
        `no pricing entry exactly matches config lane (${lane.provider}, ${lane.model})`,
      ).toBeDefined();
    }
  });

  it("findPricingEntry resolves the exact Claude independent model and rejects a stale/different name", () => {
    const cfg = JSON.parse(readFileSync(PILOT_CONFIG_PATH, "utf-8"));
    const pricing = C2PricingTableSchema.parse(
      JSON.parse(readFileSync(PRICING_PATH, "utf-8")),
    );

    // The exact pinned independent model resolves.
    const resolved = findPricingEntry({
      pricingTable: pricing,
      provider: cfg.independent.provider,
      model: cfg.independent.model,
    });
    expect(resolved.found).toBe(true);
    if (resolved.found) {
      expect(resolved.value.provider).toBe("claude");
      expect(resolved.value.model).toBe(cfg.independent.model);
    }

    // A stale/differently named Claude model (the old Pass 2 alias) must be
    // rejected — fail closed with a structured missing-entry reason.
    const stale = findPricingEntry({
      pricingTable: pricing,
      provider: "claude",
      model: "claude-sonnet-4-5",
    });
    expect(stale.found).toBe(false);
    if (!stale.found) {
      expect(stale.reason).toBe("missing-pricing-entry");
      expect(stale.provider).toBe("claude");
      expect(stale.model).toBe("claude-sonnet-4-5");
    }
  });
});
