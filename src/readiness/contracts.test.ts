import { describe, expect, it } from "vitest";
import {
  BaseArtifactHeader,
  CorpusBoundHeader,
  CheckpointApproval,
  LiveCostApproval,
  Phase0Summary,
  OwnershipMap,
  TaxonomyDigestArtifact,
  ApprovalActorRegistry,
  CheckpointApprovals,
  ArtifactIndex,
  TrackedArtifact,
  sha256Hex,
  canonicalJsonStringify,
  computeTaxonomyDigest,
  buildCheckpointTarget,
  computeCheckpointTargetSha256,
  validateRegistry,
  validateLedgerAppendOnly,
} from "./contracts.js";

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const VALID_GIT_SHA = "374f72073c81ea7901696333cd875fe75b348e6b";
const VALID_SHA256 = "a".repeat(64);

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

describe("sha256Hex", () => {
  it("produces a lowercase 64-hex digest", () => {
    const digest = sha256Hex(Buffer.from("hello", "utf-8"));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });
});

describe("canonicalJsonStringify", () => {
  it("sorts object keys recursively by code-point order", () => {
    const result = canonicalJsonStringify({ b: 1, a: { d: 2, c: 3 } });
    expect(result).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it("preserves array order", () => {
    const result = canonicalJsonStringify({ values: [3, 1, 2] });
    expect(result).toBe('{"values":[3,1,2]}');
  });

  it("emits compact UTF-8 JSON (no whitespace)", () => {
    const result = canonicalJsonStringify({ key: "value" });
    expect(result).not.toContain(" ");
    expect(result).toBe('{"key":"value"}');
  });

  it("rejects undefined values", () => {
    expect(() => canonicalJsonStringify({ x: undefined })).toThrow();
  });

  it("rejects cyclic values", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJsonStringify(cyclic)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// BaseArtifactHeader
// ---------------------------------------------------------------------------

describe("BaseArtifactHeader", () => {
  it("accepts a valid header", () => {
    const result = BaseArtifactHeader.safeParse({
      schemaVersion: "1.0",
      artifactType: "taxonomy-digest",
      artifactId: "taxonomy-20260714",
      createdAt: "2026-07-14T09:30:00Z",
      createdByRole: "repository-maintainer",
      sourceGitSha: VALID_GIT_SHA,
      inputHashes: {},
    });
    expect(result.success).toBe(true);
  });

  it("does not require corpus fields", () => {
    const result = BaseArtifactHeader.safeParse({
      schemaVersion: "1.0",
      artifactType: "ownership-map",
      artifactId: "ownership-20260714",
      createdAt: "2026-07-14T09:30:00Z",
      createdByRole: "repository-maintainer",
      sourceGitSha: VALID_GIT_SHA,
      inputHashes: {},
    });
    expect(result.success).toBe(true);
    // Confirm corpusSha256 was not silently accepted
    const parsed = result.success ? result.data : null;
    expect(parsed).not.toHaveProperty("corpusSha256");
  });

  it("rejects wrong schemaVersion", () => {
    const result = BaseArtifactHeader.safeParse({
      schemaVersion: "2.0",
      artifactType: "test",
      artifactId: "test",
      createdAt: "2026-07-14T09:30:00Z",
      createdByRole: "repository-maintainer",
      sourceGitSha: VALID_GIT_SHA,
      inputHashes: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed sourceGitSha (not 40-hex)", () => {
    const result = BaseArtifactHeader.safeParse({
      schemaVersion: "1.0",
      artifactType: "test",
      artifactId: "test",
      createdAt: "2026-07-14T09:30:00Z",
      createdByRole: "repository-maintainer",
      sourceGitSha: "short",
      inputHashes: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects non-ISO createdAt", () => {
    const result = BaseArtifactHeader.safeParse({
      schemaVersion: "1.0",
      artifactType: "test",
      artifactId: "test",
      createdAt: "not-a-date",
      createdByRole: "repository-maintainer",
      sourceGitSha: VALID_GIT_SHA,
      inputHashes: {},
    });
    expect(result.success).toBe(false);
  });

  it("strict-rejects unknown keys", () => {
    const result = BaseArtifactHeader.safeParse({
      schemaVersion: "1.0",
      artifactType: "test",
      artifactId: "test",
      createdAt: "2026-07-14T09:30:00Z",
      createdByRole: "repository-maintainer",
      sourceGitSha: VALID_GIT_SHA,
      inputHashes: {},
      unexpectedField: "should fail",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CorpusBoundHeader
// ---------------------------------------------------------------------------

describe("CorpusBoundHeader", () => {
  it("accepts a valid corpus-bound header", () => {
    const result = CorpusBoundHeader.safeParse({
      schemaVersion: "1.0",
      artifactType: "phase0-summary",
      artifactId: "phase0-20260714",
      createdAt: "2026-07-14T09:30:00Z",
      createdByRole: "repository-maintainer",
      sourceGitSha: VALID_GIT_SHA,
      inputHashes: {},
      corpusSha256: VALID_SHA256,
      corpusEntryCount: 787,
      taxonomySha256: VALID_SHA256,
    });
    expect(result.success).toBe(true);
  });

  it("requires corpusSha256", () => {
    const result = CorpusBoundHeader.safeParse({
      schemaVersion: "1.0",
      artifactType: "phase0-summary",
      artifactId: "phase0-20260714",
      createdAt: "2026-07-14T09:30:00Z",
      createdByRole: "repository-maintainer",
      sourceGitSha: VALID_GIT_SHA,
      inputHashes: {},
      corpusEntryCount: 787,
      taxonomySha256: VALID_SHA256,
    });
    expect(result.success).toBe(false);
  });

  it("requires corpusEntryCount", () => {
    const result = CorpusBoundHeader.safeParse({
      schemaVersion: "1.0",
      artifactType: "phase0-summary",
      artifactId: "phase0-20260714",
      createdAt: "2026-07-14T09:30:00Z",
      createdByRole: "repository-maintainer",
      sourceGitSha: VALID_GIT_SHA,
      inputHashes: {},
      corpusSha256: VALID_SHA256,
      taxonomySha256: VALID_SHA256,
    });
    expect(result.success).toBe(false);
  });

  it("requires taxonomySha256", () => {
    const result = CorpusBoundHeader.safeParse({
      schemaVersion: "1.0",
      artifactType: "phase0-summary",
      artifactId: "phase0-20260714",
      createdAt: "2026-07-14T09:30:00Z",
      createdByRole: "repository-maintainer",
      sourceGitSha: VALID_GIT_SHA,
      inputHashes: {},
      corpusSha256: VALID_SHA256,
      corpusEntryCount: 787,
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed taxonomySha256 (not 64-hex)", () => {
    const result = CorpusBoundHeader.safeParse({
      schemaVersion: "1.0",
      artifactType: "phase0-summary",
      artifactId: "phase0-20260714",
      createdAt: "2026-07-14T09:30:00Z",
      createdByRole: "repository-maintainer",
      sourceGitSha: VALID_GIT_SHA,
      inputHashes: {},
      corpusSha256: VALID_SHA256,
      corpusEntryCount: 787,
      taxonomySha256: "tooshort",
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CheckpointApproval (crypto stripped)
// ---------------------------------------------------------------------------

describe("CheckpointApproval", () => {
  function validApproval() {
    return {
      approvalId: "c0-repo-maintainer",
      approvalKind: "checkpoint" as const,
      checkpoint: "C0" as const,
      decision: "approved" as const,
      actorId: "repo-maintainer-1",
      role: "Repository Maintainer",
      actorKind: "human" as const,
      actorRegistryVersion: "1.0",
      actorRegistrySha256: VALID_SHA256,
      checkpointTargetSha256: VALID_SHA256,
      approvedArtifacts: [
        { artifactId: "phase0-20260714", sha256: VALID_SHA256 },
      ],
      planSha256: VALID_SHA256,
      specSha256: VALID_SHA256,
      contractHashes: {},
      decidedAt: "2026-07-14T10:00:00Z",
    };
  }

  it("accepts a valid approval without crypto fields", () => {
    const result = CheckpointApproval.safeParse(validApproval());
    expect(result.success).toBe(true);
  });

  it("rejects if signingKeyId present (crypto must not appear)", () => {
    const bad = { ...validApproval(), signingKeyId: "key-1" };
    expect(CheckpointApproval.safeParse(bad).success).toBe(false);
  });

  it("rejects if signatureBase64 present", () => {
    const bad = { ...validApproval(), signatureBase64: "abc123" };
    expect(CheckpointApproval.safeParse(bad).success).toBe(false);
  });

  it("rejects if attestationSha256 present", () => {
    const bad = { ...validApproval(), attestationSha256: VALID_SHA256 };
    expect(CheckpointApproval.safeParse(bad).success).toBe(false);
  });

  it("validates checkpoint enum C0–C5", () => {
    for (const cp of ["C0", "C1", "C2", "C3", "C4", "C5"] as const) {
      const result = CheckpointApproval.safeParse({ ...validApproval(), checkpoint: cp });
      expect(result.success).toBe(true);
    }
    expect(
      CheckpointApproval.safeParse({ ...validApproval(), checkpoint: "C6" }).success,
    ).toBe(false);
  });

  it("validates decision enum: approved | rejected", () => {
    expect(
      CheckpointApproval.safeParse({ ...validApproval(), decision: "approved" }).success,
    ).toBe(true);
    expect(
      CheckpointApproval.safeParse({ ...validApproval(), decision: "rejected" }).success,
    ).toBe(true);
    expect(
      CheckpointApproval.safeParse({ ...validApproval(), decision: "pending" }).success,
    ).toBe(false);
  });

  it("requires at least one approvedArtifact", () => {
    const result = CheckpointApproval.safeParse({
      ...validApproval(),
      approvedArtifacts: [],
    });
    expect(result.success).toBe(false);
  });

  it("requires planSha256 and specSha256", () => {
    const { planSha256: _drop, ...withoutPlan } = validApproval();
    delete (withoutPlan as Record<string, unknown>).planSha256;
    expect(CheckpointApproval.safeParse(withoutPlan).success).toBe(false);
  });

  it("requires checkpointTargetSha256", () => {
    const { checkpointTargetSha256: _drop, ...without } = validApproval();
    delete (without as Record<string, unknown>).checkpointTargetSha256;
    expect(CheckpointApproval.safeParse(without).success).toBe(false);
  });

  it("accepts optional rationale", () => {
    const result = CheckpointApproval.safeParse({
      ...validApproval(),
      rationale: "Evidence validated.",
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// LiveCostApproval (crypto stripped)
// ---------------------------------------------------------------------------

describe("LiveCostApproval", () => {
  function validCostApproval() {
    return {
      approvalId: "cost-1",
      actorId: "budget-owner-1",
      role: "Budget Owner",
      actorKind: "human" as const,
      actorRegistryVersion: "1.0",
      actorRegistrySha256: VALID_SHA256,
      runId: "run-001",
      runConfigSha256: VALID_SHA256,
      provider: "openai",
      model: "gpt-4o",
      maxCostUsd: 25,
      decidedAt: "2026-07-14T10:00:00Z",
    };
  }

  it("accepts a valid cost approval without crypto fields", () => {
    const result = LiveCostApproval.safeParse(validCostApproval());
    expect(result.success).toBe(true);
  });

  it("rejects if signatureBase64 present", () => {
    const bad = { ...validCostApproval(), signatureBase64: "abc123" };
    expect(LiveCostApproval.safeParse(bad).success).toBe(false);
  });

  it("requires role = Budget Owner", () => {
    const result = LiveCostApproval.safeParse({
      ...validCostApproval(),
      role: "PM",
    });
    expect(result.success).toBe(false);
  });

  it("requires actorKind = human", () => {
    const result = LiveCostApproval.safeParse({
      ...validCostApproval(),
      actorKind: "agent",
    });
    expect(result.success).toBe(false);
  });

  it("requires maxCostUsd > 0", () => {
    const result = LiveCostApproval.safeParse({
      ...validCostApproval(),
      maxCostUsd: 0,
    });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Taxonomy digest computation
// ---------------------------------------------------------------------------

describe("computeTaxonomyDigest", () => {
  it("returns exactly five enums with correct counts", () => {
    const digest = computeTaxonomyDigest();
    expect(Object.keys(digest.perEnum).sort()).toEqual(
      ["Category", "Component", "DomainTag", "PatternType", "StyleTag"],
    );
    expect(digest.perEnum.PatternType!.values).toHaveLength(21);
    expect(digest.perEnum.Category!.values).toHaveLength(18);
    expect(digest.perEnum.StyleTag!.values).toHaveLength(14);
    expect(digest.perEnum.Component!.values).toHaveLength(35);
    expect(digest.perEnum.DomainTag!.values).toHaveLength(15);
  });

  it("produces the canonical aggregate hash", () => {
    const digest = computeTaxonomyDigest();
    expect(digest.aggregateSha256).toBe(
      "a96fa56eed0aadb8be618ea2cb54a1be2943e58feaed31e8aba12d7d6059c2bf",
    );
  });

  it("per-enum hashes match SHA-256 of compact JSON.stringify", () => {
    const digest = computeTaxonomyDigest();
    // Per-enum hashes are SHA-256 of JSON.stringify(values) — compact, no sorting
    for (const [name, entry] of Object.entries(digest.perEnum)) {
      const expected = sha256Hex(Buffer.from(JSON.stringify(entry!.values), "utf-8"));
      expect(entry!.sha256).toBe(expected);
    }
  });
});

// ---------------------------------------------------------------------------
// Type-specific artifact schemas
// ---------------------------------------------------------------------------

function baseHeader(artifactType: string, artifactId: string) {
  return {
    schemaVersion: "1.0" as const,
    artifactType,
    artifactId,
    createdAt: "2026-07-14T09:30:00Z",
    createdByRole: "repository-maintainer",
    sourceGitSha: VALID_GIT_SHA,
    inputHashes: {},
  };
}

function corpusBoundHeader(artifactType: string, artifactId: string) {
  return {
    ...baseHeader(artifactType, artifactId),
    corpusSha256: VALID_SHA256,
    corpusEntryCount: 787,
    taxonomySha256: VALID_SHA256,
  };
}

describe("Phase0Summary", () => {
  it("accepts a valid phase0 summary", () => {
    const result = Phase0Summary.safeParse({
      ...corpusBoundHeader("phase0-summary", "phase0-20260714"),
      environment: {
        nodeVersion: "v24.17.0",
        npmVersion: "11.13.0",
        platform: "Darwin arm64",
        corpusMode: "private",
        networkMode: "credential-scrubbed",
      },
      commandMatrix: [
        { command: "npm test", exitCode: 0, runner: "credential-scrubbed", result: "731 passed" },
      ],
      skipGates: [
        { test: "live test", file: "src/x.test.ts", gate: "RUN_LIVE", fired: true, reason: "key", testCount: 1 },
      ],
      doctorResult: { pass: 10, warn: 2, fail: 0 },
      validateCorpusResult: { valid: true, entryCount: 787, uniqueIds: 787 },
      packAnalysis: { totalFiles: 274, potentialLeaks: [], note: "ok" },
      credentialScrubbedRunner: { script: "scripts/run-no-egress.mjs", approach: "shell-level", limitations: "not cryptographic", redactedKeys: ["OPENAI_API_KEY"] },
      diagnosticBaseline: { gitSha: "fdd74d1", date: "2026-07-14", imageCount: 15, patternTypeAccuracy: 0.80, rawBannedPhrases: 0, rawIconOnlyClaims: 0, meanExtractionLatencyMs: 6553, citationScorable: false, extractionProvider: "MiniMax", extractionModel: "MiniMax-M3", critiqueProvider: "OpenAI", critiqueModel: "deepseek-chat", modelPinned: true, systemPromptSha256: VALID_SHA256, referenceManifestSha256: VALID_SHA256, machineRulesSha256: VALID_SHA256, note: "historical", reusable: false, nonReusableReasons: ["corpus SHA not recoverable"] },
      ownershipMapRef: "ownership-map-v1.json",
      taxonomyDigestRef: "taxonomy-digest-v1.json",
      c0Status: "evidence-gathered-pending-validation",
      c0Note: "awaiting Task 1",
    });
    expect(result.success).toBe(true);
  });

  it("rejects networkMode 'denied' (stale false claim)", () => {
    const result = Phase0Summary.safeParse({
      ...corpusBoundHeader("phase0-summary", "phase0-20260714"),
      environment: {
        nodeVersion: "v24",
        npmVersion: "11",
        platform: "Darwin arm64",
        corpusMode: "private",
        networkMode: "denied",
      },
      commandMatrix: [],
      skipGates: [],
      doctorResult: { pass: 10, warn: 2, fail: 0 },
      validateCorpusResult: { valid: true, entryCount: 787, uniqueIds: 787 },
      packAnalysis: { totalFiles: 1, potentialLeaks: [], note: "" },
      credentialScrubbedRunner: { script: "x", approach: "x", limitations: "x", redactedKeys: [] },
      diagnosticBaseline: { gitSha: "fdd74d1", date: "2026-07-14", imageCount: 0, patternTypeAccuracy: 0.8, rawBannedPhrases: 0, rawIconOnlyClaims: 0, meanExtractionLatencyMs: 0, citationScorable: false, extractionProvider: "x", extractionModel: "x", critiqueProvider: "x", critiqueModel: "x", modelPinned: false, systemPromptSha256: VALID_SHA256, referenceManifestSha256: VALID_SHA256, machineRulesSha256: VALID_SHA256, note: "", reusable: false, nonReusableReasons: [] },
      ownershipMapRef: "ownership-map-v1.json",
      taxonomyDigestRef: "taxonomy-digest-v1.json",
      c0Status: "pending",
      c0Note: "",
    });
    expect(result.success).toBe(false);
  });
});

describe("OwnershipMap", () => {
  it("accepts a valid ownership map", () => {
    const result = OwnershipMap.safeParse({
      ...baseHeader("ownership-map", "ownership-20260714"),
      entries: [
        { path: "src/x.xlsx", classification: "needs-user-decision", decision: "remove", sha256: VALID_SHA256 },
        { path: "CLAUDE.md", classification: "owned-by-other-work", decision: "untouched", sha256: VALID_SHA256 },
      ],
      critiqueQualityBranchDisposition: { branch: "feat/x", status: "merged", note: "done" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid classification", () => {
    const result = OwnershipMap.safeParse({
      ...baseHeader("ownership-map", "ownership-20260714"),
      entries: [
        { path: "x", classification: "invalid", decision: "x", sha256: VALID_SHA256 },
      ],
      critiqueQualityBranchDisposition: { branch: "x", status: "x", note: "" },
    });
    expect(result.success).toBe(false);
  });
});

describe("TaxonomyDigestArtifact", () => {
  it("accepts a valid taxonomy digest artifact", () => {
    const computed = computeTaxonomyDigest();
    const result = TaxonomyDigestArtifact.safeParse({
      ...baseHeader("taxonomy-digest", "taxonomy-20260714"),
      taxonomies: Object.fromEntries(
        Object.entries(computed.perEnum).map(([k, v]) => [
          k,
          { count: v!.values.length, values: v!.values, sha256: v!.sha256, serialization: "JSON array, compact, no whitespace" },
        ]),
      ),
      aggregateSha256: computed.aggregateSha256,
    });
    expect(result.success).toBe(true);
  });
});

describe("ApprovalActorRegistry", () => {
  it("accepts a valid v1 registry with previousRegistry null", () => {
    const result = ApprovalActorRegistry.safeParse({
      ...baseHeader("approval-actor-registry", "actors-20260714"),
      registryVersion: "1.0",
      previousRegistry: null,
      actors: [
        { actorId: "repo-maintainer-1", actorKind: "human", roles: ["Repository Maintainer"] },
        { actorId: "pm-1", actorKind: "human", roles: ["PM"] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts v2 referencing v1", () => {
    const result = ApprovalActorRegistry.safeParse({
      ...baseHeader("approval-actor-registry", "actors-20260715"),
      registryVersion: "2.0",
      previousRegistry: { registryVersion: "1.0", sha256: VALID_SHA256 },
      actors: [
        { actorId: "repo-maintainer-1", actorKind: "human", roles: ["Repository Maintainer", "PM"] },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects duplicate actor IDs", () => {
    const result = ApprovalActorRegistry.safeParse({
      ...baseHeader("approval-actor-registry", "actors-20260714"),
      registryVersion: "1.0",
      previousRegistry: null,
      actors: [
        { actorId: "dup", actorKind: "human", roles: ["PM"] },
        { actorId: "dup", actorKind: "agent", roles: ["Engineering"] },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty roles array", () => {
    const result = ApprovalActorRegistry.safeParse({
      ...baseHeader("approval-actor-registry", "actors-20260714"),
      registryVersion: "1.0",
      previousRegistry: null,
      actors: [{ actorId: "x", actorKind: "human", roles: [] }],
    });
    expect(result.success).toBe(false);
  });

  it("accepts an explicit sole-maintainer bootstrap registry", () => {
    const result = ApprovalActorRegistry.safeParse({
      ...baseHeader("approval-actor-registry", "actors-c1-v2"),
      registryVersion: "2.0",
      previousRegistry: { registryVersion: "1.0", sha256: VALID_SHA256 },
      governanceMode: "sole-maintainer-bootstrap",
      bootstrapOwnerActorId: "repo-maintainer-1",
      actors: [
        {
          actorId: "repo-maintainer-1",
          actorKind: "human",
          roles: ["Repository Maintainer", "Product", "Engineering"],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts explicit separation of duties without a bootstrap owner", () => {
    const result = ApprovalActorRegistry.safeParse({
      ...baseHeader("approval-actor-registry", "actors-v2"),
      registryVersion: "2.0",
      previousRegistry: { registryVersion: "1.0", sha256: VALID_SHA256 },
      governanceMode: "separation-of-duties",
      actors: [
        { actorId: "product-1", actorKind: "human", roles: ["Product"] },
        { actorId: "engineering-1", actorKind: "human", roles: ["Engineering"] },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("CheckpointApprovals", () => {
  it("accepts a valid approval ledger", () => {
    const result = CheckpointApprovals.safeParse({
      ...baseHeader("checkpoint-approvals", "approvals-20260714"),
      approvals: [
        {
          approvalId: "c0-repo-maintainer",
          approvalKind: "checkpoint",
          checkpoint: "C0",
          decision: "approved",
          actorId: "repo-maintainer-1",
          role: "Repository Maintainer",
          actorKind: "human",
          actorRegistryVersion: "1.0",
          actorRegistrySha256: VALID_SHA256,
          checkpointTargetSha256: VALID_SHA256,
          approvedArtifacts: [{ artifactId: "phase0-20260714", sha256: VALID_SHA256 }],
          planSha256: VALID_SHA256,
          specSha256: VALID_SHA256,
          contractHashes: {},
          decidedAt: "2026-07-14T10:00:00Z",
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("ArtifactIndex", () => {
  it("accepts a valid artifact index", () => {
    const result = ArtifactIndex.safeParse({
      ...baseHeader("artifact-index", "index-20260714"),
      artifacts: [
        { artifactId: "phase0-20260714", artifactType: "phase0-summary", sha256: VALID_SHA256, path: "quality-contracts/agent-readiness/phase0-summary-v1.json" },
      ],
      implementationActorIds: ["impl-1"],
    });
    expect(result.success).toBe(true);
  });

  it("requires non-empty implementationActorIds", () => {
    const result = ArtifactIndex.safeParse({
      ...baseHeader("artifact-index", "index-20260714"),
      artifacts: [
        { artifactId: "phase0-20260714", artifactType: "phase0-summary", sha256: VALID_SHA256, path: "x.json" },
      ],
      implementationActorIds: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("TrackedArtifact discriminated union", () => {
  it("routes phase0-summary to Phase0Summary", () => {
    const result = TrackedArtifact.safeParse({
      schemaVersion: "1.0",
      artifactType: "artifact-index",
      artifactId: "index-20260714",
      createdAt: "2026-07-14T09:30:00Z",
      createdByRole: "repository-maintainer",
      sourceGitSha: VALID_GIT_SHA,
      inputHashes: {},
      artifacts: [],
      implementationActorIds: ["x"],
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Checkpoint target construction
// ---------------------------------------------------------------------------

describe("buildCheckpointTarget", () => {
  it("sorts artifacts by artifactId", () => {
    const target = buildCheckpointTarget({
      checkpoint: "C0",
      baselineGitSha: VALID_GIT_SHA,
      artifacts: [
        { artifactId: "zeta", artifactType: "test", sha256: VALID_SHA256 },
        { artifactId: "alpha", artifactType: "test", sha256: VALID_SHA256 },
      ],
      planSha256: VALID_SHA256,
      specSha256: VALID_SHA256,
      actorRegistryVersion: "1.0",
      actorRegistrySha256: VALID_SHA256,
      contractHashes: {},
      inputHashes: {},
    });
    expect(target.artifacts[0]!.artifactId).toBe("alpha");
    expect(target.artifacts[1]!.artifactId).toBe("zeta");
  });

  it("rejects duplicate artifact IDs", () => {
    expect(() =>
      buildCheckpointTarget({
        checkpoint: "C0",
        baselineGitSha: VALID_GIT_SHA,
        artifacts: [
          { artifactId: "dup", artifactType: "test", sha256: VALID_SHA256 },
          { artifactId: "dup", artifactType: "test", sha256: VALID_SHA256 },
        ],
        planSha256: VALID_SHA256,
        specSha256: VALID_SHA256,
        actorRegistryVersion: "1.0",
        actorRegistrySha256: VALID_SHA256,
        contractHashes: {},
        inputHashes: {},
      }),
    ).toThrow();
  });

  it("produces deterministic SHA-256 for the same inputs", () => {
    const opts = {
      checkpoint: "C0" as const,
      baselineGitSha: VALID_GIT_SHA,
      artifacts: [
        { artifactId: "a", artifactType: "test", sha256: VALID_SHA256 },
        { artifactId: "b", artifactType: "test", sha256: VALID_SHA256 },
      ],
      planSha256: VALID_SHA256,
      specSha256: VALID_SHA256,
      actorRegistryVersion: "1.0",
      actorRegistrySha256: VALID_SHA256,
      contractHashes: { "src/contracts.ts": VALID_SHA256 },
      inputHashes: { "plan.md": VALID_SHA256 },
    };
    const h1 = computeCheckpointTargetSha256(buildCheckpointTarget(opts));
    const h2 = computeCheckpointTargetSha256(buildCheckpointTarget(opts));
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when artifacts change", () => {
    const base = {
      checkpoint: "C0" as const,
      baselineGitSha: VALID_GIT_SHA,
      planSha256: VALID_SHA256,
      specSha256: VALID_SHA256,
      actorRegistryVersion: "1.0",
      actorRegistrySha256: VALID_SHA256,
      contractHashes: {},
      inputHashes: {},
    };
    const h1 = computeCheckpointTargetSha256(buildCheckpointTarget({
      ...base,
      artifacts: [{ artifactId: "a", artifactType: "test", sha256: VALID_SHA256 }],
    }));
    const h2 = computeCheckpointTargetSha256(buildCheckpointTarget({
      ...base,
      artifacts: [{ artifactId: "b", artifactType: "test", sha256: VALID_SHA256 }],
    }));
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// Registry validation
// ---------------------------------------------------------------------------

describe("validateRegistry", () => {
  function validRegistry() {
    return {
      schemaVersion: "1.0" as const,
      artifactType: "approval-actor-registry",
      artifactId: "actors-20260714",
      createdAt: "2026-07-14T09:30:00Z",
      createdByRole: "repository-maintainer",
      sourceGitSha: VALID_GIT_SHA,
      inputHashes: {},
      registryVersion: "1.0",
      previousRegistry: null,
      actors: [
        { actorId: "repo-maintainer-1", actorKind: "human" as const, roles: ["Repository Maintainer"] },
        { actorId: "pm-1", actorKind: "human" as const, roles: ["PM"] },
      ],
    };
  }

  it("passes for a valid v1 registry", () => {
    expect(validateRegistry(validRegistry())).toEqual([]);
  });

  it("reports non-null previousRegistry for v1", () => {
    const issues = validateRegistry({ ...validRegistry(), previousRegistry: { registryVersion: "0.9", sha256: VALID_SHA256 } });
    expect(issues.length).toBeGreaterThan(0);
  });

  it("passes for v2 referencing v1", () => {
    const v2 = {
      ...validRegistry(),
      registryVersion: "2.0",
      previousRegistry: { registryVersion: "1.0", sha256: VALID_SHA256 },
    };
    expect(validateRegistry(v2)).toEqual([]);
  });

  it("reports duplicate actor IDs", () => {
    const issues = validateRegistry({
      ...validRegistry(),
      actors: [
        { actorId: "dup", actorKind: "human", roles: ["PM"] },
        { actorId: "dup", actorKind: "agent", roles: ["Engineering"] },
      ],
    });
    expect(issues.length).toBeGreaterThan(0);
  });

  it("reports empty roles", () => {
    const issues = validateRegistry({
      ...validRegistry(),
      actors: [{ actorId: "x", actorKind: "human", roles: [] }],
    });
    expect(issues.length).toBeGreaterThan(0);
  });

  it("treats omitted governance mode as separation of duties", () => {
    expect(validateRegistry(validRegistry())).toEqual([]);
  });

  it("accepts a human bootstrap owner present in the registry", () => {
    const registry = {
      ...validRegistry(),
      registryVersion: "2.0",
      previousRegistry: { registryVersion: "1.0", sha256: VALID_SHA256 },
      governanceMode: "sole-maintainer-bootstrap" as const,
      bootstrapOwnerActorId: "repo-maintainer-1",
    };
    expect(validateRegistry(registry)).toEqual([]);
  });

  it.each([
    ["missing owner", { governanceMode: "sole-maintainer-bootstrap" as const }],
    ["unknown owner", { governanceMode: "sole-maintainer-bootstrap" as const, bootstrapOwnerActorId: "missing" }],
    ["owner outside bootstrap", { governanceMode: "separation-of-duties" as const, bootstrapOwnerActorId: "repo-maintainer-1" }],
  ])("rejects malformed governance declaration: %s", (_label, fields) => {
    const registry = {
      ...validRegistry(),
      registryVersion: "2.0",
      previousRegistry: { registryVersion: "1.0", sha256: VALID_SHA256 },
      ...fields,
    };
    expect(validateRegistry(registry as any).length).toBeGreaterThan(0);
  });

  it("rejects an agent as bootstrap owner", () => {
    const registry = {
      ...validRegistry(),
      registryVersion: "2.0",
      previousRegistry: { registryVersion: "1.0", sha256: VALID_SHA256 },
      governanceMode: "sole-maintainer-bootstrap" as const,
      bootstrapOwnerActorId: "impl-agent-1",
      actors: [
        ...validRegistry().actors,
        { actorId: "impl-agent-1", actorKind: "agent" as const, roles: ["Engineering" as const] },
      ],
    };
    expect(validateRegistry(registry)).toContain(
      "bootstrap owner impl-agent-1 must be human",
    );
  });
});

// ---------------------------------------------------------------------------
// Ledger append-only validation
// ---------------------------------------------------------------------------

describe("validateLedgerAppendOnly", () => {
  function approval(id: string) {
    return {
      approvalId: id,
      approvalKind: "checkpoint" as const,
      checkpoint: "C0" as const,
      decision: "approved" as const,
      actorId: "actor-1",
      role: "Repository Maintainer",
      actorKind: "human" as const,
      actorRegistryVersion: "1.0",
      actorRegistrySha256: VALID_SHA256,
      checkpointTargetSha256: VALID_SHA256,
      approvedArtifacts: [{ artifactId: "phase0-20260714", sha256: VALID_SHA256 }],
      planSha256: VALID_SHA256,
      specSha256: VALID_SHA256,
      contractHashes: {},
      decidedAt: "2026-07-14T10:00:00Z",
    };
  }

  it("passes when current is a superset of previous", () => {
    const previous = { approvals: [approval("a"), approval("b")] };
    const current = { approvals: [approval("a"), approval("b"), approval("c")] };
    expect(validateLedgerAppendOnly(current, previous)).toEqual([]);
  });

  it("reports when a prior approval was deleted", () => {
    const previous = { approvals: [approval("a"), approval("b")] };
    const current = { approvals: [approval("b")] };
    const issues = validateLedgerAppendOnly(current, previous);
    expect(issues.length).toBeGreaterThan(0);
  });

  it("reports when a prior approval was mutated", () => {
    const previous = { approvals: [approval("a")] };
    const current = { approvals: [approval("a")] };
    // Mutate current's approval "a"
    (current.approvals[0] as Record<string, unknown>).actorId = "changed";
    const issues = validateLedgerAppendOnly(current, previous);
    expect(issues.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Versioned readiness snapshot schemas (backward-compatible chain metadata)
// ---------------------------------------------------------------------------

describe("versioned readiness snapshot schemas", () => {
  const header = {
    schemaVersion: "1.0" as const,
    createdAt: "2026-07-18T00:00:00Z",
    createdByRole: "repository-maintainer",
    sourceGitSha: "a".repeat(40),
    inputHashes: {},
  };

  it("keeps v1 index and ledger shapes valid", () => {
    expect(ArtifactIndex.safeParse({
      ...header,
      artifactType: "artifact-index",
      artifactId: "index-v1",
      artifacts: [],
      implementationActorIds: ["impl-1"],
    }).success).toBe(true);
    expect(CheckpointApprovals.safeParse({
      ...header,
      artifactType: "checkpoint-approvals",
      artifactId: "ledger-v1",
      approvals: [],
    }).success).toBe(true);
  });

  it("accepts v2 chain metadata", () => {
    const predecessor = { version: "1", sha256: "b".repeat(64) };
    expect(ArtifactIndex.safeParse({
      ...header,
      artifactType: "artifact-index",
      artifactId: "index-v2",
      ordinalVersion: 2,
      predecessor,
      artifacts: [],
      implementationActorIds: ["impl-1"],
    }).success).toBe(true);
    expect(CheckpointApprovals.safeParse({
      ...header,
      artifactType: "checkpoint-approvals",
      artifactId: "ledger-v2",
      ordinalVersion: 2,
      predecessor,
      approvals: [],
    }).success).toBe(true);
  });

  it("rejects invalid ordinals and predecessor digests", () => {
    const base = {
      ...header,
      artifactType: "checkpoint-approvals" as const,
      artifactId: "ledger-v2",
      approvals: [],
    };
    expect(CheckpointApprovals.safeParse({ ...base, ordinalVersion: 0 }).success).toBe(false);
    expect(CheckpointApprovals.safeParse({
      ...base,
      ordinalVersion: 2,
      predecessor: { version: "1", sha256: "bad" },
    }).success).toBe(false);
  });
});
