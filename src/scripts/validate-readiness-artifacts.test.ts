import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateReadinessArtifacts } from "../readiness/validator.js";
import {
  computeTaxonomyDigest,
  buildCheckpointTarget,
  computeCheckpointTargetSha256,
  sha256Hex,
} from "../readiness/contracts.js";
import {
  C0_RECIPE,
  type GitSourceResolver,
} from "../readiness/checkpoint-policy.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FROZEN_SHA = "374f72073c81ea7901696333cd875fe75b348e6b";
const SHA_A = "a".repeat(64);

// Synthetic commits used by the in-memory resolver. These need not be real
// git SHAs — the fake resolver is keyed by (commit, path). They only need to
// match the recipe's recorded commits so the validator asks for them.
const SYNTH_SOURCE_COMMIT = C0_RECIPE.sourceGitSha;
const SYNTH_CONTRACTS_COMMIT = C0_RECIPE.contractBindings.find(
  (b) => b.key === "src/readiness/contracts.ts",
)!.gitCommit;

// ---------------------------------------------------------------------------
// In-memory git resolver (no real git)
// ---------------------------------------------------------------------------

/**
 * Fake GitSourceResolver backed by an in-memory map keyed by `${commit}:${path}`.
 * Tests populate this with synthetic file bytes; no real git is invoked, so
 * the tests are independent of the working tree.
 */
class FakeGitResolver implements GitSourceResolver {
  private readonly bytes = new Map<string, Uint8Array>();

  put(commit: string, path: string, data: Uint8Array | string): this {
    const u8 = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
    this.bytes.set(`${commit}:${path}`, u8);
    return this;
  }

  resolve(commit: string, repositoryPath: string): Uint8Array {
    const key = `${commit}:${repositoryPath}`;
    const found = this.bytes.get(key);
    if (!found) {
      throw new Error(`FakeGitResolver: no bytes for ${key}`);
    }
    return found;
  }
}

// ---------------------------------------------------------------------------
// Fixture builder
// ---------------------------------------------------------------------------

interface FixtureRoot {
  root: string;
  artifactRoot: string;
  repoRoot: string;
}

function createArtifactRoot(): FixtureRoot {
  const root = mkdtempSync(join(tmpdir(), "readiness-validator-"));
  // Synthesize a repo layout: <root>/quality-contracts/agent-readiness is the
  // artifact root; <root> stands in for the git toplevel.
  const repoRoot = root;
  const artifactRoot = join(root, "quality-contracts", "agent-readiness");
  mkdirSync(artifactRoot, { recursive: true });
  return { root, artifactRoot, repoRoot };
}

function cleanup(root: string) {
  rmSync(root, { recursive: true, force: true });
}

function writeArtifact(dir: string, filename: string, obj: unknown) {
  writeFileSync(join(dir, filename), JSON.stringify(obj, null, 2) + "\n", "utf-8");
}

function fileSha(filePath: string): string {
  return sha256Hex(readFileSync(filePath));
}

interface SyntheticSources {
  resolver: FakeGitResolver;
  planSha: string;
  specSha: string;
  parentPlanSha: string;
  contractsSha: string;
  runNoEgressSha: string;
}

/**
 * Write synthetic plan / spec / contracts / run-no-egress files into the
 * synthetic repo root AND register their bytes in the fake resolver at the
 * recipe's recorded commits. This makes the recipe resolve deterministic,
 * synthetic bytes instead of shelling out to real git.
 */
function writeSyntheticSources(repoRoot: string): SyntheticSources {
  const resolver = new FakeGitResolver();

  const planContent = "# Task 1 Readiness Contracts (synthetic)\n\nPlan body.\n";
  const specContent = "# Agent Readiness Design Spec (synthetic)\n\nSpec body.\n";
  const parentPlanContent =
    "# Phase 0-1c Implementation Plan (synthetic)\n\nParent plan body.\n";
  const contractsContent =
    "// synthetic contracts.ts\nexport const X = 1;\n";
  const runNoEgressContent =
    "// synthetic run-no-egress.mjs\nconsole.log('no egress');\n";

  // Mirror each synthetic file under its repo-relative path inside the
  // synthetic repo root, so the repoRoot layout is realistic.
  const planPath = join(repoRoot, ...C0_RECIPE.planBinding.repositoryPath.split("/"));
  const specPath = join(repoRoot, ...C0_RECIPE.specBinding.repositoryPath.split("/"));
  const parentPlanPath = join(
    repoRoot,
    ...C0_RECIPE.contractBindings[0]!.repositoryPath.split("/"),
  );
  const contractsPath = join(
    repoRoot,
    ...C0_RECIPE.contractBindings[1]!.repositoryPath.split("/"),
  );
  const runNoEgressPath = join(
    repoRoot,
    ...C0_RECIPE.inputHashBindings.find((b) => b.key === "run-no-egress.mjs")!
      .repositoryPath.split("/"),
  );
  for (const p of [planPath, specPath, parentPlanPath, contractsPath, runNoEgressPath]) {
    mkdirSync(join(p, ".."), { recursive: true });
  }
  writeFileSync(planPath, planContent);
  writeFileSync(specPath, specContent);
  writeFileSync(parentPlanPath, parentPlanContent);
  writeFileSync(contractsPath, contractsContent);
  writeFileSync(runNoEgressPath, runNoEgressContent);

  // Register bytes in the resolver at the recipe's recorded commits.
  resolver.put(C0_RECIPE.planBinding.gitCommit, C0_RECIPE.planBinding.repositoryPath, planContent);
  resolver.put(C0_RECIPE.specBinding.gitCommit, C0_RECIPE.specBinding.repositoryPath, specContent);
  resolver.put(
    C0_RECIPE.contractBindings[0]!.gitCommit,
    C0_RECIPE.contractBindings[0]!.repositoryPath,
    parentPlanContent,
  );
  resolver.put(
    C0_RECIPE.contractBindings[1]!.gitCommit,
    C0_RECIPE.contractBindings[1]!.repositoryPath,
    contractsContent,
  );
  const runBinding = C0_RECIPE.inputHashBindings.find((b) => b.key === "run-no-egress.mjs")!;
  resolver.put(runBinding.gitCommit, runBinding.repositoryPath, runNoEgressContent);

  return {
    resolver,
    planSha: sha256Hex(Buffer.from(planContent, "utf-8")),
    specSha: sha256Hex(Buffer.from(specContent, "utf-8")),
    parentPlanSha: sha256Hex(Buffer.from(parentPlanContent, "utf-8")),
    contractsSha: sha256Hex(Buffer.from(contractsContent, "utf-8")),
    runNoEgressSha: sha256Hex(Buffer.from(runNoEgressContent, "utf-8")),
  };
}

/**
 * Build a complete, internally-consistent C0 artifact graph with REAL
 * checkpoint-target hashes computed from synthetic-resolved bytes. The valid
 * graph actually closes C0 when a resolver is supplied.
 */
function buildValidGraph(opts?: {
  withApprovals?: boolean;
  resolver?: FakeGitResolver;
}): FixtureRoot & {
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
  targetSha256: string;
  resolver: FakeGitResolver;
  sources: SyntheticSources;
} {
  const { root, artifactRoot, repoRoot } = createArtifactRoot();
  const sources = writeSyntheticSources(repoRoot);
  const resolver = opts?.resolver ?? sources.resolver;

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

  const corpusSha256 = SHA_A;

  // phase0-summary inputHashes: keys must equal the recipe inputHashKeys.
  // Artifact-root aliases resolve from in-memory .sha; git-file aliases from
  // the resolver.
  const inputHashes: Record<string, string> = {
    "ownership-map-v1.json": fileSha(ownershipPath),
    "taxonomy-digest-v1.json": fileSha(taxonomyPath),
    "parent-plan.md": sources.parentPlanSha,
    "task1-plan.md": sources.planSha,
    "design-spec.md": sources.specSha,
    "run-no-egress.mjs": sources.runNoEgressSha,
  };

  // Phase 0 summary
  const phase0 = {
    ...baseHeader,
    artifactType: "phase0-summary",
    artifactId: "phase0-20260714",
    corpusSha256,
    corpusEntryCount: 787,
    taxonomySha256: taxonomyAggregate,
    inputHashes,
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

  // Artifact index. Paths are repo-relative (quality-contracts/agent-readiness/...).
  const indexArtifacts = [
    { artifactId: "phase0-20260714", artifactType: "phase0-summary", sha256: fileSha(phase0Path), path: "quality-contracts/agent-readiness/phase0-summary-v1.json" },
    { artifactId: "ownership-20260714", artifactType: "ownership-map", sha256: fileSha(ownershipPath), path: "quality-contracts/agent-readiness/ownership-map-v1.json" },
    { artifactId: "taxonomy-20260714", artifactType: "taxonomy-digest", sha256: fileSha(taxonomyPath), path: "quality-contracts/agent-readiness/taxonomy-digest-v1.json" },
    { artifactId: "actors-20260714", artifactType: "approval-actor-registry", sha256: registrySha, path: "quality-contracts/agent-readiness/approval-actor-registry-v1.json" },
  ];
  writeArtifact(artifactRoot, "artifact-index-v1.json", {
    ...baseHeader,
    artifactType: "artifact-index",
    artifactId: "index-20260714",
    artifacts: indexArtifacts,
    implementationActorIds: ["impl-1"],
  });
  const indexPath = join(artifactRoot, "artifact-index-v1.json");

  // Compute the REAL canonical checkpoint target over synthetic-resolved bytes.
  const contractHashes: Record<string, string> = {
    "parent-plan.md": sources.parentPlanSha,
    "src/readiness/contracts.ts": sources.contractsSha,
  };
  const targetArtifacts = [
    { artifactId: "actors-20260714", artifactType: "approval-actor-registry", sha256: registrySha },
    { artifactId: "ownership-20260714", artifactType: "ownership-map", sha256: fileSha(ownershipPath) },
    { artifactId: "phase0-20260714", artifactType: "phase0-summary", sha256: fileSha(phase0Path) },
    { artifactId: "taxonomy-20260714", artifactType: "taxonomy-digest", sha256: fileSha(taxonomyPath) },
  ];
  const target = buildCheckpointTarget({
    checkpoint: "C0",
    baselineGitSha: C0_RECIPE.baselineGitSha,
    artifacts: targetArtifacts,
    planSha256: sources.planSha,
    specSha256: sources.specSha,
    actorRegistryVersion: "1.0",
    actorRegistrySha256: registrySha,
    contractHashes,
    inputHashes: {}, // recipe.targetIncludesInputHashes === false
  });
  const targetSha256 = computeCheckpointTargetSha256(target);

  // Approval ledger (optional)
  let ledgerPath: string | undefined;
  if (opts?.withApprovals) {
    const approvedArtifacts = targetArtifacts.map((a) => ({
      artifactId: a.artifactId,
      sha256: a.sha256,
    }));
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
          checkpointTargetSha256: targetSha256,
          approvedArtifacts,
          planSha256: sources.planSha,
          specSha256: sources.specSha,
          contractHashes,
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
          checkpointTargetSha256: targetSha256,
          approvedArtifacts,
          planSha256: sources.planSha,
          specSha256: sources.specSha,
          contractHashes,
          decidedAt: "2026-07-14T10:01:00Z",
        },
      ],
    });
    ledgerPath = join(artifactRoot, "checkpoint-approvals-v1.json");
  }

  return {
    root, artifactRoot, repoRoot, phase0Path, ownershipPath, taxonomyPath,
    registryPath, indexPath, ledgerPath,
    corpusSha256, taxonomyAggregate,
    planSha: sources.planSha, specSha: sources.specSha, registrySha,
    targetSha256, resolver, sources,
  };
}

/** Read+parse+rewrite a JSON artifact file (helper for mutation tests). */
function mutateJson<T = unknown>(path: string, fn: (data: T) => T): void {
  const data = JSON.parse(readFileSync(path, "utf-8"));
  writeFileSync(path, JSON.stringify(fn(data), null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Tests — public mode (no approvals)
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
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
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
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "missing-artifact" || i.code === "index-mismatch")).toBe(true);
  });

  it("reports a hash mismatch when artifact bytes change", () => {
    mutateJson<Record<string, unknown>>(fixture.phase0Path, (d) => ({ ...d, c0Note: "CHANGED" }));
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "hash-mismatch")).toBe(true);
  });

  it("reports stale taxonomySha256 in phase0 summary", () => {
    mutateJson<Record<string, unknown>>(fixture.phase0Path, (d) => ({ ...d, taxonomySha256: "0".repeat(64) }));
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.message.includes("taxonomy"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — leak detection
// ---------------------------------------------------------------------------

describe("validateReadinessArtifacts — leak detection", () => {
  let fixture: ReturnType<typeof buildValidGraph>;

  beforeEach(() => {
    fixture = buildValidGraph();
  });

  afterEach(() => {
    cleanup(fixture.root);
  });

  it("reports public structural leak: prompt key in tracked artifact", () => {
    mutateJson<Record<string, unknown>>(fixture.phase0Path, (d) => ({ ...d, prompt: "system prompt text" }));
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    // .strict() schema rejects unknown keys (stronger guarantee than leak detection)
    expect(result.issues.some((i) => i.code === "schema-error" || i.code === "leak")).toBe(true);
  });

  it("reports public structural leak: eval/agent-readiness path", () => {
    mutateJson<Record<string, unknown>>(fixture.ownershipPath, (d) => {
      d.entries[0].path = "eval/agent-readiness/runs/run-1/secret.json";
      return d;
    });
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "leak")).toBe(true);
  });

  it("allows repository-relative paths in ownership map", () => {
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.issues.filter((i) => i.code === "leak")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Tests — approvals and C0 closure (git-bound recomputation)
// ---------------------------------------------------------------------------

describe("validateReadinessArtifacts — approvals and C0 closure", () => {
  let fixture: ReturnType<typeof buildValidGraph>;

  afterEach(() => {
    if (fixture) cleanup(fixture.root);
  });

  it("closes C0 with both required approvals and a real recomputed target", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checkpointStatus.C0).toBe("closed");
  });

  it("stays open with only Repository Maintainer approval", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<{ approvals: { role: string }[] }>(fixture.ledgerPath!, (d) => ({
      ...d,
      approvals: d.approvals.filter((a) => a.role === "Repository Maintainer"),
    }));
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.checkpointStatus.C0).toBe("open");
  });

  it("rejects implementer self-approval and keeps C0 open", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<{ approvals: { actorId: string }[] }>(fixture.ledgerPath!, (d) => {
      d.approvals[0]!.actorId = "impl-1";
      return d;
    });
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "implementer-self-approval")).toBe(true);
    expect(result.checkpointStatus.C0).toBe("open");
  });

  it("rejects divergent checkpoint targets", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<{ approvals: { checkpointTargetSha256: string }[] }>(fixture.ledgerPath!, (d) => {
      d.approvals[0]!.checkpointTargetSha256 = "c".repeat(64);
      d.approvals[1]!.checkpointTargetSha256 = "d".repeat(64);
      return d;
    });
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "divergent-targets")).toBe(true);
  });

  it("rejects rejected approval counting toward closure", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<{ approvals: { decision: string }[] }>(fixture.ledgerPath!, (d) => {
      d.approvals[1]!.decision = "rejected";
      return d;
    });
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.checkpointStatus.C0).toBe("open");
  });

  // -----------------------------------------------------------------
  // THE EXPLOIT — the merge-blocking P0 fix proof
  // -----------------------------------------------------------------

  it("REJECTS the reproduced exploit: corrupted target/artifacts/plan/spec/contract → C0 open", () => {
    fixture = buildValidGraph({ withApprovals: true });
    // Corrupt BOTH approvals exactly as the reproduction: fabricated
    // checkpointTargetSha256, approvedArtifacts, planSha256, specSha256,
    // and contractHashes.
    mutateJson<{
      approvals: Array<{
        checkpointTargetSha256: string;
        approvedArtifacts: { artifactId: string; sha256: string }[];
        planSha256: string;
        specSha256: string;
        contractHashes: Record<string, string>;
      }>;
    }>(fixture.ledgerPath!, (d) => {
      for (const a of d.approvals) {
        a.checkpointTargetSha256 = "f".repeat(64);
        a.approvedArtifacts = [{ artifactId: "nonexistent", sha256: "e".repeat(64) }];
        a.planSha256 = "1".repeat(64);
        a.specSha256 = "2".repeat(64);
        a.contractHashes = { x: "3".repeat(64) };
      }
      return d;
    });

    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });

    // The validator MUST fail and C0 MUST stay open.
    expect(result.ok).toBe(false);
    expect(result.checkpointStatus.C0).toBe("open");

    // Each new closure-completeness code must appear at least once.
    const codes = new Set(result.issues.map((i) => i.code));
    expect(codes.has("checkpoint-target-mismatch")).toBe(true);
    expect(codes.has("plan-hash-mismatch")).toBe(true);
    expect(codes.has("spec-hash-mismatch")).toBe(true);
    expect(codes.has("contract-hash-mismatch")).toBe(true);
    expect(codes.has("approved-artifact-set-mismatch")).toBe(true);
    expect(codes.has("approved-artifact-unknown")).toBe(true);
  });

  // -----------------------------------------------------------------
  // THE HISTORICAL DRIFT INVARIANT — decisive proof that C1 edits to the
  // live parent plan / spec do NOT reopen C0.
  // -----------------------------------------------------------------

  it("KEEPS C0 closed when the working-tree plan/spec drift (recorded-commit bytes win)", () => {
    fixture = buildValidGraph({ withApprovals: true });

    // Simulate C1 edits: rewrite the LIVE working-tree plan + spec + parent
    // plan + contracts files. The resolver still serves the ORIGINAL bytes
    // at the recorded commit, so the recomputed target is unchanged.
    const planPath = join(fixture.repoRoot, ...C0_RECIPE.planBinding.repositoryPath.split("/"));
    const specPath = join(fixture.repoRoot, ...C0_RECIPE.specBinding.repositoryPath.split("/"));
    writeFileSync(planPath, "# DRIFTED task1 plan — C1 edits\n");
    writeFileSync(specPath, "# DRIFTED design spec — C1 edits\n");
    const parentPlanPath = join(
      fixture.repoRoot,
      ...C0_RECIPE.contractBindings[0]!.repositoryPath.split("/"),
    );
    writeFileSync(parentPlanPath, "# DRIFTED parent plan — C1 edits\n");

    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });

    // C0 must remain closed — resolution used the recorded-commit bytes,
    // not the drifted working tree.
    expect(result.ok).toBe(true);
    expect(result.checkpointStatus.C0).toBe("closed");
    expect(result.issues).toEqual([]);
  });

  it("REOPENS C0 when the recorded-commit bytes themselves change", () => {
    fixture = buildValidGraph({ withApprovals: true });

    // Now corrupt the resolver's recorded-commit bytes (simulating history
    // rewrite). The recomputed target changes and C0 must reopen.
    fixture.resolver.put(
      C0_RECIPE.planBinding.gitCommit,
      C0_RECIPE.planBinding.repositoryPath,
      "# tampered task1 plan\n",
    );

    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });

    expect(result.ok).toBe(false);
    expect(result.checkpointStatus.C0).toBe("open");
    expect(result.issues.some((i) => i.code === "checkpoint-target-mismatch")).toBe(true);
    expect(result.issues.some((i) => i.code === "plan-hash-mismatch")).toBe(true);
  });

  // -----------------------------------------------------------------
  // FAIL-CLOSED — a fabricated ledger must NOT pass when resolution fails.
  // The resolver is a security boundary; absence/throwing must reject, not
  // silently trust the ledger.
  // -----------------------------------------------------------------

  it("FAILS CLOSED: fabricated ledger with a throwing resolver → C0 open", () => {
    fixture = buildValidGraph({ withApprovals: true });
    // Corrupt both approvals exactly as the reproduced exploit.
    mutateJson<{
      approvals: Array<{
        checkpointTargetSha256: string;
        approvedArtifacts: { artifactId: string; sha256: string }[];
        planSha256: string;
        specSha256: string;
        contractHashes: Record<string, string>;
      }>;
    }>(fixture.ledgerPath!, (d) => {
      for (const a of d.approvals) {
        a.checkpointTargetSha256 = "f".repeat(64);
        a.approvedArtifacts = [{ artifactId: "nonexistent", sha256: "e".repeat(64) }];
        a.planSha256 = "1".repeat(64);
        a.specSha256 = "2".repeat(64);
        a.contractHashes = { x: "3".repeat(64) };
      }
      return d;
    });

    // Resolver throws on every resolution (e.g. shallow clone missing the commit).
    const throwingResolver: GitSourceResolver = {
      resolve: () => {
        throw new Error("commit not found in shallow clone");
      },
    };

    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: throwingResolver,
      mode: "public",
    });

    // MUST fail closed — no silent trust of the fabricated ledger.
    expect(result.ok).toBe(false);
    expect(result.checkpointStatus.C0).toBe("open");
    expect(result.issues.some((i) => i.code === "checkpoint-recompute-failed")).toBe(true);
  });

  it("FAILS CLOSED: valid ledger with a throwing resolver → C0 open (no silent closure)", () => {
    fixture = buildValidGraph({ withApprovals: true });

    // Resolver throws even though the ledger is valid — resolution failure can
    // never close a checkpoint, regardless of the ledger's contents.
    const throwingResolver: GitSourceResolver = {
      resolve: () => {
        throw new Error("git unavailable");
      },
    };

    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: throwingResolver,
      mode: "public",
    });

    expect(result.ok).toBe(false);
    expect(result.checkpointStatus.C0).toBe("open");
    expect(result.issues.some((i) => i.code === "checkpoint-recompute-failed")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — closure-completeness (each rejection in isolation)
// ---------------------------------------------------------------------------

describe("validateReadinessArtifacts — closure completeness", () => {
  let fixture: ReturnType<typeof buildValidGraph>;

  afterEach(() => {
    if (fixture) cleanup(fixture.root);
  });

  it("rejects actor-kind mismatch and keeps C0 open", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<{ approvals: { actorKind: string }[] }>(fixture.ledgerPath!, (d) => {
      d.approvals[0]!.actorKind = "agent"; // registry says human
      return d;
    });
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "actor-kind-mismatch")).toBe(true);
    expect(result.checkpointStatus.C0).toBe("open");
  });

  it("rejects actor-role mismatch (unauthorized role) and keeps C0 open", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<{ approvals: { role: string }[] }>(fixture.ledgerPath!, (d) => {
      // pm-1 is not authorized for "Engineering"
      d.approvals[1]!.role = "Engineering";
      return d;
    });
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "actor-role-mismatch")).toBe(true);
    expect(result.checkpointStatus.C0).toBe("open");
  });

  it("rejects a missing approved artifact", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<{ approvals: { approvedArtifacts: { artifactId: string; sha256: string }[] }[] }>(
      fixture.ledgerPath!,
      (d) => {
        // Drop one artifact from the first approval.
        d.approvals[0]!.approvedArtifacts = d.approvals[0]!.approvedArtifacts.slice(0, 3);
        return d;
      },
    );
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "approved-artifact-set-mismatch")).toBe(true);
    expect(result.checkpointStatus.C0).toBe("open");
  });

  it("rejects an extra approved artifact", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<{ approvals: { approvedArtifacts: { artifactId: string; sha256: string }[] }[] }>(
      fixture.ledgerPath!,
      (d) => {
        d.approvals[0]!.approvedArtifacts = [
          ...d.approvals[0]!.approvedArtifacts,
          { artifactId: "extra-one", sha256: "a".repeat(64) },
        ];
        return d;
      },
    );
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "approved-artifact-set-mismatch")).toBe(true);
    expect(result.checkpointStatus.C0).toBe("open");
  });

  it("rejects a duplicate approved artifact id", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<{ approvals: { approvedArtifacts: { artifactId: string; sha256: string }[] }[] }>(
      fixture.ledgerPath!,
      (d) => {
        const list = d.approvals[0]!.approvedArtifacts;
        d.approvals[0]!.approvedArtifacts = [...list, { ...list[0]! }];
        return d;
      },
    );
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "approved-artifact-set-mismatch")).toBe(true);
    expect(result.checkpointStatus.C0).toBe("open");
  });

  it("rejects an approved-artifact hash mismatch", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<{ approvals: { approvedArtifacts: { artifactId: string; sha256: string }[] }[] }>(
      fixture.ledgerPath!,
      (d) => {
        d.approvals[0]!.approvedArtifacts[0]!.sha256 = "b".repeat(64);
        return d;
      },
    );
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "approved-artifact-hash-mismatch")).toBe(true);
    expect(result.checkpointStatus.C0).toBe("open");
  });

  it("rejects duplicate parsed artifact ids across files", () => {
    fixture = buildValidGraph({ withApprovals: true });
    // Write a second file claiming the same artifactId as the registry.
    const dupe = JSON.parse(readFileSync(fixture.registryPath, "utf-8"));
    writeArtifact(fixture.artifactRoot, "duplicate-registry.json", dupe);
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "duplicate-artifact-id")).toBe(true);
  });

  it("rejects index path mismatch (recorded path != resolved path)", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<{ artifacts: { artifactId: string; path: string }[] }>(fixture.indexPath, (d) => {
      d.artifacts[0]!.path = "quality-contracts/wrong-place/phase0-summary-v1.json";
      return d;
    });
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "index-path-mismatch")).toBe(true);
  });

  it("rejects duplicate index paths", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<{ artifacts: { artifactId: string; path: string }[] }>(fixture.indexPath, (d) => {
      // Make two rows share the same path.
      d.artifacts[1]!.path = d.artifacts[0]!.path;
      return d;
    });
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "index-duplicate-path")).toBe(true);
  });

  it("rejects phase0-summary inputHash key set mismatch", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<Record<string, unknown>>(fixture.phase0Path, (d) => {
      const ih = d.inputHashes as Record<string, string>;
      delete ih["run-no-egress.mjs"];
      ih["bogus-key"] = "a".repeat(64);
      return d;
    });
    // Re-pin the phase0 index hash after mutation.
    mutateJson<{ artifacts: { artifactId: string; sha256: string }[] }>(fixture.indexPath, (d) => {
      d.artifacts.find((a) => a.artifactId === "phase0-20260714")!.sha256 = fileSha(fixture.phase0Path);
      return d;
    });
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "summary-input-hash-mismatch")).toBe(true);
  });

  it("rejects phase0-summary inputHash value mismatch", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<Record<string, unknown>>(fixture.phase0Path, (d) => {
      const ih = d.inputHashes as Record<string, string>;
      ih["parent-plan.md"] = "0".repeat(64); // wrong value
      return d;
    });
    mutateJson<{ artifacts: { artifactId: string; sha256: string }[] }>(fixture.indexPath, (d) => {
      d.artifacts.find((a) => a.artifactId === "phase0-20260714")!.sha256 = fileSha(fixture.phase0Path);
      return d;
    });
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "public",
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "summary-input-hash-mismatch")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — private mode
// ---------------------------------------------------------------------------

describe("validateReadinessArtifacts — private mode", () => {
  let fixture: ReturnType<typeof buildValidGraph>;
  let corpusPath: string;

  beforeEach(() => {
    fixture = buildValidGraph();
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
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "private",
      corpusPath,
    });
    expect(result.ok).toBe(false);
    expect(result.issues.some((i) => i.code === "corpus-hash-mismatch")).toBe(true);
  });

  it("reports corpus entry count mismatch", () => {
    const realSha = fileSha(corpusPath);
    mutateJson<Record<string, unknown>>(fixture.phase0Path, (d) => ({ ...d, corpusSha256: realSha }));
    mutateJson<{ artifacts: { artifactId: string; sha256: string }[] }>(fixture.indexPath, (d) => {
      d.artifacts.find((a) => a.artifactId === "phase0-20260714")!.sha256 = fileSha(fixture.phase0Path);
      return d;
    });

    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: fixture.resolver,
      mode: "private",
      corpusPath,
    });
    expect(result.issues.some((i) => i.code === "corpus-count-mismatch")).toBe(true);
  });
});
