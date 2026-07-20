import { describe, expect, it } from "vitest";
import {
  C2ConditionInputSchema,
  C2EvidenceRecordSchema,
  C2CampaignConfigSchema,
  C2PricingTableSchema,
  C2CalibrationProposalSchema,
  C2FrozenCalibrationSchema,
} from "./condition-contracts.js";

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
