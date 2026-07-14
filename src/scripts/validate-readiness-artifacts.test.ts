import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReadinessArtifacts } from "../readiness/validator.js";
import { computeTaxonomyDigest } from "../readiness/contracts.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FROZEN_SHA = "374f72073c81ea7901696333cd875fe75b348e6b";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

// ---------------------------------------------------------------------------
// Fixture builder: a minimal valid C0 artifact graph
// ---------------------------------------------------------------------------

interface FixtureRoot {
  root: string;
  artifactRoot: string;
}

function createArtifactRoot(): FixtureRoot {
  const root = mkdtempSync(join(tmpdir(), "readiness-validator-"));
  const artifactRoot = join(root, "quality-contracts", "agent-readiness");
  mkdirSync(artifactRoot, { recursive: true });
  return { root, artifactRoot };
}

function cleanup(root: string) {
  rmSync(root, { recursive: true, force: true });
}

function writeArtifact(dir: string, filename: string, obj: unknown) {
  writeFileSync(join(dir, filename), JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

/** Compute SHA-256 of file bytes — used to build hash-consistent fixtures. */
function fileSha(filePath: string): string {
  const { createHash } = require("node:crypto");
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

/**
 * Build a complete, internally-consistent C0 artifact graph.
 * Returns the artifactRoot path and key hashes for assertions.
 */
function buildValidGraph(opts?: { withApprovals?: boolean }): FixtureRoot & {
  phase0Path: string;
  ownershipPath: string;
  taxonomyPath: string;
  registryPath: string;
  indexPath: string;
  ledgerPath?: string;
  corpusSha256: string;
  taxonomyAggregate: string;
  planSha: string;
  specSha: string;
  registrySha: string;
} {
  const { root, artifactRoot } = createArtifactRoot();

  const baseHeader = {
    schemaVersion: "1.0",
    createdAt: "2026-07-14T09:30:00Z",
    createdByRole: "repository-maintainer",
    sourceGitSha: FROZEN_SHA,
    inputHashes: {} as Record<string, string>,
  };

  // Taxonomy digest — use real values from computeTaxonomyDigest so recompute passes
  const computed = computeTaxonomyDigest();
  const taxonomyAggregate = computed.aggregateSha256;
  const taxonomy = {
    ...baseHeader,
    artifactType: "taxonomy-digest",
    artifactId: "taxonomy-20260714",
    taxonomies: {
      PatternType: { count: computed.perEnum.PatternType!.values.length, values: computed.perEnum.PatternType!.values, sha256: computed.perEnum.PatternType!.sha256, serialization: "JSON array, compact, no whitespace" },
      Category: { count: computed.perEnum.Category!.values.length, values: computed.perEnum.Category!.values, sha256: computed.perEnum.Category!.sha256, serialization: "JSON array, compact, no whitespace" },
      StyleTag: { count: computed.perEnum.StyleTag!.values.length, values: computed.perEnum.StyleTag!.values, sha256: computed.perEnum.StyleTag!.sha256, serialization: "JSON array, compact, no whitespace" },
      Component: { count: computed.perEnum.Component!.values.length, values: computed.perEnum.Component!.values, sha256: computed.perEnum.Component!.sha256, serialization: "JSON array, compact, no whitespace" },
      DomainTag: { count: computed.perEnum.DomainTag!.values.length, values: computed.perEnum.DomainTag!.values, sha256: computed.perEnum.DomainTag!.sha256, serialization: "JSON array, compact, no whitespace" },
    },
    aggregateSha256: taxonomyAggregate,
  };
  writeArtifact(artifactRoot, "taxonomy-digest-v1.json", taxonomy);
  const taxonomyPath = join(artifactRoot, "taxonomy-digest-v1.json");

  // Ownership map
  const ownership = {
    ...baseHeader,
    artifactType: "ownership-map",
    artifactId: "ownership-20260714",
    entries: [
      { path: "src/stray.xlsx", classification: "needs-user-decision", decision: "remove", sha256: SHA_A },
    ],
    critiqueQualityBranchDisposition: { branch: "feat/x", status: "merged", note: "done" },
  };
  writeArtifact(artifactRoot, "ownership-map-v1.json", ownership);
  const ownershipPath = join(artifactRoot, "ownership-map-v1.json");

  // Plan + spec hashes (simulated)
  const planSha = SHA_B;
  const specSha = SHA_B;

  // Corpus identity (simulated for private mode)
  const corpusSha256 = SHA_A;

  // Phase 0 summary
  const phase0 = {
    ...baseHeader,
    artifactType: "phase0-summary",
    artifactId: "phase0-20260714",
    corpusSha256,
    corpusEntryCount: 787,
    taxonomySha256: taxonomyAggregate,
    inputHashes: {
      "ownership-map-v1.json": SHA_A,
      "taxonomy-digest-v1.json": SHA_A,
    },
    environment: {
      nodeVersion: "v24.17.0",
      npmVersion: "11.13.0",
      platform: "Darwin arm64",
      corpusMode: "private",
      networkMode: "credential-scrubbed",
    },
    commandMatrix: [
      { command: "npm test", exitCode: 0, runner: "credential-scrubbed", result: "pass" },
    ],
    skipGates: [],
    doctorResult: { pass: 10, warn: 2, fail: 0 },
    validateCorpusResult: { valid: true, entryCount: 787, uniqueIds: 787 },
    packAnalysis: { totalFiles: 274, potentialLeaks: [], note: "ok" },
    credentialScrubbedRunner: { script: "scripts/run-no-egress.mjs", approach: "shell-level", limitations: "not cryptographic", redactedKeys: ["OPENAI_API_KEY"] },
    diagnosticBaseline: {
      gitSha: "fdd74d1", date: "2026-07-14", imageCount: 15, patternTypeAccuracy: 0.80,
      rawBannedPhrases: 0, rawIconOnlyClaims: 0, meanExtractionLatencyMs: 6553,
      citationScorable: false, extractionProvider: "MiniMax", extractionModel: "MiniMax-M3",
      critiqueProvider: "OpenAI", critiqueModel: "deepseek-chat", modelPinned: true,
      systemPromptSha256: SHA_A, referenceManifestSha256: SHA_A, machineRulesSha256: SHA_A,
      note: "historical", reusable: false, nonReusableReasons: ["corpus SHA not recoverable"],
    },
    ownershipMapRef: "ownership-map-v1.json",
    taxonomyDigestRef: "taxonomy-digest-v1.json",
    c0Status: "evidence-gathered-pending-validation",
    c0Note: "awaiting Task 1",
  };
  writeArtifact(artifactRoot, "phase0-summary-v1.json", phase0);
  const phase0Path = join(artifactRoot, "phase0-summary-v1.json");

  // Actor registry v1
  const registry = {
    ...baseHeader,
    artifactType: "approval-actor-registry",
    artifactId: "actors-20260714",
    registryVersion: "1.0",
    previousRegistry: null,
    actors: [
      { actorId: "repo-maintainer-1", actorKind: "human", roles: ["Repository Maintainer"] },
      { actorId: "pm-1", actorKind: "human", roles: ["PM"] },
    ],
  };
  writeArtifact(artifactRoot, "approval-actor-registry-v1.json", registry);
  const registryPath = join(artifactRoot, "approval-actor-registry-v1.json");
  const registrySha = fileSha(registryPath);

  // Artifact index (excludes itself and ledger)
  writeArtifact(artifactRoot, "artifact-index-v1.json", {
    ...baseHeader,
    artifactType: "artifact-index",
    artifactId: "index-20260714",
    artifacts: [
      { artifactId: "phase0-20260714", artifactType: "phase0-summary", sha256: fileSha(phase0Path), path: "quality-contracts/agent-readiness/phase0-summary-v1.json" },
      { artifactId: "ownership-20260714", artifactType: "ownership-map", sha256: fileSha(ownershipPath), path: "quality-contracts/agent-readiness/ownership-map-v1.json" },
      { artifactId: "taxonomy-20260714", artifactType: "taxonomy-digest", sha256: fileSha(taxonomyPath), path: "quality-contracts/agent-readiness/taxonomy-digest-v1.json" },
      { artifactId: "actors-20260714", artifactType: "approval-actor-registry", sha256: registrySha, path: "quality-contracts/agent-readiness/approval-actor-registry-v1.json" },
    ],
    implementationActorIds: ["impl-1"],
  });
  const indexPath = join(artifactRoot, "artifact-index-v1.json");

  // Approval ledger (optional)
  let ledgerPath: string | undefined;
  if (opts?.withApprovals) {
    const targetSha = SHA_A; // simplified — real implementation would compute from target
    writeArtifact(artifactRoot, "checkpoint-approvals-v1.json", {
      ...baseHeader,
      artifactType: "checkpoint-approvals",
      artifactId: "approvals-20260714",
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
          actorRegistrySha256: registrySha,
          checkpointTargetSha256: targetSha,
          approvedArtifacts: [
            { artifactId: "phase0-20260714", sha256: fileSha(phase0Path) },
            { artifactId: "ownership-20260714", sha256: fileSha(ownershipPath) },
            { artifactId: "taxonomy-20260714", sha256: fileSha(taxonomyPath) },
            { artifactId: "actors-20260714", sha256: fileSha(registryPath) },
          ],
          planSha256: planSha,
          specSha256: specSha,
          contractHashes: {},
          decidedAt: "2026-07-14T10:00:00Z",
        },
        {
          approvalId: "c0-pm",
          approvalKind: "checkpoint",
          checkpoint: "C0",
          decision: "approved",
          actorId: "pm-1",
          role: "PM",
          actorKind: "human",
          actorRegistryVersion: "1.0",
          actorRegistrySha256: registrySha,
          checkpointTargetSha256: targetSha,
          approvedArtifacts: [
            { artifactId: "phase0-20260714", sha256: fileSha(phase0Path) },
            { artifactId: "ownership-20260714", sha256: fileSha(ownershipPath) },
            { artifactId: "taxonomy-20260714", sha256: fileSha(taxonomyPath) },
            { artifactId: "actors-20260714", sha256: fileSha(registryPath) },
          ],
          planSha256: planSha,
          specSha256: specSha,
          contractHashes: {},
          decidedAt: "2026-07-14T10:01:00Z",
        },
      ],
    });
    ledgerPath = join(artifactRoot, "checkpoint-approvals-v1.json");
  }

  return {
    root, artifactRoot, phase0Path, ownershipPath, taxonomyPath,
    registryPath, indexPath, ledgerPath,
    corpusSha256, taxonomyAggregate, planSha, specSha, registrySha,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("validateReadinessArtifacts — public mode", () => {
  let fixture: ReturnType<typeof buildValidGraph>;

  beforeEach(() => {
    fixture = buildValidGraph();
  });

  afterEach(() => {
    cleanup(fixture.root);
  });

  it("validates a complete graph without approvals — C0 stays open", () => {
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "public",
    });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checkpointStatus.C0).toBe("open");
  });

  it("reports a missing evidence artifact", () => {
    rmSync(fixture.taxonomyPath, { force: true });
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-artifact" || i.code === "index-mismatch")).toBe(true);
  });

  it("reports a hash mismatch when artifact bytes change", () => {
    writeFileSync(fixture.phase0Path, JSON.stringify({ ...JSON.parse(readFileSync(fixture.phase0Path, "utf-8")), c0Note: "CHANGED" }, null, 2));
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "hash-mismatch")).toBe(true);
  });

  it("reports stale taxonomySha256 in phase0 summary", () => {
    const content = JSON.parse(readFileSync(fixture.phase0Path, "utf-8"));
    content.taxonomySha256 = "0".repeat(64);
    writeFileSync(fixture.phase0Path, JSON.stringify(content, null, 2));
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("taxonomy"))).toBe(true);
  });
});

describe("validateReadinessArtifacts — leak detection", () => {
  let fixture: ReturnType<typeof buildValidGraph>;

  beforeEach(() => {
    fixture = buildValidGraph();
  });

  afterEach(() => {
    cleanup(fixture.root);
  });

  it("reports public structural leak: prompt key in tracked artifact", () => {
    const content = JSON.parse(readFileSync(fixture.phase0Path, "utf-8"));
    (content as Record<string, unknown>).prompt = "system prompt text";
    writeFileSync(fixture.phase0Path, JSON.stringify(content, null, 2));
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    // .strict() schema rejects unknown keys (stronger guarantee than leak detection)
    expect(result.issues.some((i) => i.code === "schema-error" || i.code === "leak")).toBe(true);
  });

  it("reports public structural leak: eval/agent-readiness path", () => {
    const content = JSON.parse(readFileSync(fixture.ownershipPath, "utf-8"));
    content.entries[0].path = "eval/agent-readiness/runs/run-1/secret.json";
    writeFileSync(fixture.ownershipPath, JSON.stringify(content, null, 2));
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "leak")).toBe(true);
  });

  it("allows repository-relative paths in ownership map", () => {
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "public",
    });
    // The ownership map contains "src/stray.xlsx" — should not be flagged
    expect(result.issues.filter((i) => i.code === "leak")).toEqual([]);
  });
});

describe("validateReadinessArtifacts — approvals", () => {
  let fixture: ReturnType<typeof buildValidGraph>;

  afterEach(() => {
    if (fixture) cleanup(fixture.root);
  });

  it("closes C0 with both required approvals", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "public",
    });
    expect(result.checkpointStatus.C0).toBe("closed");
  });

  it("stays open with only Repository Maintainer approval", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const content = JSON.parse(readFileSync(fixture.ledgerPath!, "utf-8"));
    content.approvals = content.approvals.filter((a: { role: string }) => a.role === "Repository Maintainer");
    writeFileSync(fixture.ledgerPath!, JSON.stringify(content, null, 2));
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "public",
    });
    expect(result.checkpointStatus.C0).toBe("open");
  });

  it("rejects implementer self-approval", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const content = JSON.parse(readFileSync(fixture.ledgerPath!, "utf-8"));
    // Make an approver use the implementer's actor ID
    content.approvals[0].actorId = "impl-1";
    writeFileSync(fixture.ledgerPath!, JSON.stringify(content, null, 2));
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "implementer-self-approval")).toBe(true);
  });

  it("rejects divergent checkpoint targets", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const content = JSON.parse(readFileSync(fixture.ledgerPath!, "utf-8"));
    // Give the two approvals different target SHAs
    content.approvals[0].checkpointTargetSha256 = "c".repeat(64);
    content.approvals[1].checkpointTargetSha256 = "d".repeat(64);
    writeFileSync(fixture.ledgerPath!, JSON.stringify(content, null, 2));
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "divergent-targets")).toBe(true);
  });

  it("rejects rejected approval counting toward closure", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const content = JSON.parse(readFileSync(fixture.ledgerPath!, "utf-8"));
    content.approvals[1].decision = "rejected";
    writeFileSync(fixture.ledgerPath!, JSON.stringify(content, null, 2));
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "public",
    });
    expect(result.checkpointStatus.C0).toBe("open");
  });
});

describe("validateReadinessArtifacts — private mode", () => {
  let fixture: ReturnType<typeof buildValidGraph>;
  let corpusPath: string;

  beforeEach(() => {
    fixture = buildValidGraph();
    // Create a minimal fake corpus
    corpusPath = join(fixture.root, "corpus", "entries.json");
    mkdirSync(join(fixture.root, "corpus"), { recursive: true });
    writeFileSync(corpusPath, JSON.stringify({ version: 2, entries: [{ id: "e1" }, { id: "e2" }] }));
  });

  afterEach(() => {
    cleanup(fixture.root);
  });

  it("reports corpus hash mismatch", () => {
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "private",
      corpusPath,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "corpus-hash-mismatch")).toBe(true);
  });

  it("reports corpus entry count mismatch", () => {
    // Fix the corpusSha256 to match the actual file first
    const realSha = fileSha(corpusPath);
    const phase0Content = JSON.parse(readFileSync(fixture.phase0Path, "utf-8"));
    phase0Content.corpusSha256 = realSha;
    writeFileSync(fixture.phase0Path, JSON.stringify(phase0Content, null, 2));
    // Update index hash for phase0
    const indexContent = JSON.parse(readFileSync(fixture.indexPath, "utf-8"));
    indexContent.artifacts[0].sha256 = fileSha(fixture.phase0Path);
    writeFileSync(fixture.indexPath, JSON.stringify(indexContent, null, 2));

    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      mode: "private",
      corpusPath,
    });
    // corpus has 2 entries, phase0 claims 787
    expect(result.issues.some((i) => i.code === "corpus-count-mismatch")).toBe(true);
  });
});
