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
  C1_RECIPE,
  C1_CONTRACT_SHA,
  C1_MERGE_SHA,
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

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf-8")) as T;
}

function writeRegistryV2(fixture: ReturnType<typeof buildValidGraph>, overrides: Record<string, unknown> = {}) {
  const previous = readJson<{ registryVersion: string }>(fixture.registryPath);
  const registry = {
    ...previous,
    artifactId: "actors-c1-v2",
    registryVersion: "2.0",
    previousRegistry: { registryVersion: "1.0", sha256: fileSha(fixture.registryPath) },
    actors: [
      ...previous.actors,
      { actorId: "product-1", actorKind: "human", roles: ["Product"] },
      { actorId: "engineering-1", actorKind: "human", roles: ["Engineering"] },
    ],
    ...overrides,
  };
  // Derive the filename from the artifactId so a second v2 registry with a
  // distinct id lands in its own file (otherwise the fixed name would
  // silently overwrite the first and defeat the duplicate-key/fork tests).
  const filename = `${registry.artifactId}.json`;
  const path = join(fixture.artifactRoot, filename);
  writeArtifact(fixture.artifactRoot, filename, registry);
  return { path, data: registry };
}

function writeLedgerV2(fixture: ReturnType<typeof buildValidGraph>, approvals: unknown[], overrides: Record<string, unknown> = {}) {
  const v1 = readJson<Record<string, unknown>>(fixture.ledgerPath!);
  const ledger = {
    ...v1,
    artifactId: "approvals-c1-v2",
    ordinalVersion: 2,
    predecessor: { version: "1", sha256: fileSha(fixture.ledgerPath!) },
    approvals,
    ...overrides,
  };
  // Derive the filename from the artifactId so a second v2 ledger with a
  // distinct id lands in its own file (see writeRegistryV2).
  const filename = `${ledger.artifactId}.json`;
  const path = join(fixture.artifactRoot, filename);
  writeArtifact(fixture.artifactRoot, filename, ledger);
  return { path, data: ledger };
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
// Test-only C1 fixture builder (Task 5)
// ---------------------------------------------------------------------------

/**
 * Options that mutate the synthetic C1 governance snapshot. When omitted the
 * fixture produces the original separation-of-duties graph (two distinct
 * human actors Product + Engineering), preserving the regression test.
 *
 * - `governanceMode` / `bootstrapOwnerActorId` add the corresponding fields to
 *   registry v2 so a pinned bootstrap declaration can be exercised.
 * - `sharedApprovalActorId`, when present, collapses both C1 approvals onto a
 *   single actor (still authorized for both Product and Engineering) so the
 *   actor-cardinality check is the only thing that decides closure.
 * - `bootstrapOwnerKind` controls the actorKind of the shared actor (default
 *   "human"); used to exercise the implementer-self-approval path with an
 *   agent actor.
 */
type SyntheticC1Options = {
  governanceMode?: "separation-of-duties" | "sole-maintainer-bootstrap";
  bootstrapOwnerActorId?: string;
  sharedApprovalActorId?: string;
  bootstrapOwnerKind?: "human" | "agent";
};

/**
 * Write a complete, valid v2 governance snapshot (registry + index + ledger)
 * carrying synthetic C1 approvals, and register every C1 source binding at
 * both the reviewed commit (C1_CONTRACT_SHA) and the merge commit
 * (C1_MERGE_SHA) so integration provenance passes. The C0 approvals already
 * in the fixture's v1 ledger are carried forward unchanged into the v2 ledger
 * (append-only), and both v1 and v2 registries remain on disk so per-approval
 * registry resolution finds each version.
 *
 * Files are created ONLY below the fixture's temp root; the tracked repository
 * receives no v2 artifact files. Returns the three v2 paths so mutation tests
 * can edit one property without rebuilding the whole graph.
 */
function addValidSyntheticC1Approvals(
  fixture: ReturnType<typeof buildValidGraph>,
  options: SyntheticC1Options = {},
): { registryPath: string; indexPath: string; ledgerPath: string } {
  const {
    governanceMode,
    bootstrapOwnerActorId,
    sharedApprovalActorId,
    bootstrapOwnerKind = "human",
  } = options;
  // 1. Register synthetic C1 source bytes at BOTH the reviewed commit and the
  //    merge commit so the integration-provenance check (reviewed == merged)
  //    passes. Distinct, deterministic content per file.
  const c1Sources: Record<string, string> = {
    [C1_RECIPE.planBinding.repositoryPath]: "# C1 reviewed parent plan (synthetic)\n",
    [C1_RECIPE.specBinding.repositoryPath]: "# C1 reviewed design spec (synthetic)\n",
  };
  for (const b of C1_RECIPE.contractBindings) {
    c1Sources[b.repositoryPath] = `// C1 reviewed ${b.key} (synthetic)\nexport const X = 1;\n`;
  }
  for (const [repoPath, content] of Object.entries(c1Sources)) {
    fixture.resolver.put(C1_CONTRACT_SHA, repoPath, content);
    fixture.resolver.put(C1_MERGE_SHA, repoPath, content);
  }

  const planSha = sha256Hex(Buffer.from(c1Sources[C1_RECIPE.planBinding.repositoryPath]!, "utf-8"));
  const specSha = sha256Hex(Buffer.from(c1Sources[C1_RECIPE.specBinding.repositoryPath]!, "utf-8"));
  const contractHashes: Record<string, string> = {};
  const inputHashes: Record<string, string> = {};
  for (const b of C1_RECIPE.contractBindings) {
    const h = sha256Hex(Buffer.from(c1Sources[b.repositoryPath]!, "utf-8"));
    contractHashes[b.key] = h;
    inputHashes[b.key] = h;
  }
  inputHashes[C1_RECIPE.planBinding.key] = planSha;
  inputHashes[C1_RECIPE.specBinding.key] = specSha;

  // 2. Write the v2 actor registry (head). Adds Product and Engineering
  //    actors authorized for C1. previousRegistry pins the v1 registry.
  //    When `sharedApprovalActorId` is present, collapse both roles onto a
  //    single shared actor; otherwise emit the two distinct actors so the
  //    default separation-of-duties regression test stays intact.
  const v1Registry = readJson<{ actors: Array<{ actorId: string; actorKind: string; roles: string[] }> }>(fixture.registryPath);
  // Build the v2 actor list. In the default separation-of-duties case we append
  // distinct Product + Engineering actors. When a shared bootstrap actor is
  // requested we collapse both C1 roles onto that single actor; if it already
  // exists in v1 (e.g. repo-maintainer-1) we merge Product + Engineering into
  // its existing entry rather than duplicating it, so the registry stays
  // duplicate-free.
  let v2Actors: Array<{ actorId: string; actorKind: string; roles: string[] }>;
  if (sharedApprovalActorId !== undefined) {
    const sharedRoles = ["Product", "Engineering"];
    const existing = v1Registry.actors.find((a) => a.actorId === sharedApprovalActorId);
    if (existing) {
      v2Actors = v1Registry.actors.map((a) =>
        a.actorId === sharedApprovalActorId
          ? {
              actorId: sharedApprovalActorId,
              actorKind: bootstrapOwnerKind,
              roles: Array.from(new Set([...a.roles, ...sharedRoles])),
            }
          : a,
      );
    } else {
      v2Actors = [
        ...v1Registry.actors,
        { actorId: sharedApprovalActorId, actorKind: bootstrapOwnerKind, roles: sharedRoles },
      ];
    }
    // When a distinct bootstrap owner is declared (e.g. to prove a shared
    // actor that is NOT the owner is rejected) ensure it exists as a human
    // actor in the registry so the registry itself stays valid and the
    // actor-cardinality check is the deciding rule.
    if (
      bootstrapOwnerActorId !== undefined &&
      bootstrapOwnerActorId !== sharedApprovalActorId &&
      !v2Actors.some((a) => a.actorId === bootstrapOwnerActorId)
    ) {
      v2Actors = [
        ...v2Actors,
        { actorId: bootstrapOwnerActorId, actorKind: "human", roles: ["Product", "Engineering"] },
      ];
    }
  } else {
    v2Actors = [
      ...v1Registry.actors,
      { actorId: "product-1", actorKind: "human", roles: ["Product"] },
      { actorId: "engineering-1", actorKind: "human", roles: ["Engineering"] },
    ];
  }
  const v2Registry = {
    ...v1Registry,
    artifactId: "actors-c1-v2",
    registryVersion: "2.0",
    previousRegistry: { registryVersion: "1.0", sha256: fileSha(fixture.registryPath) },
    actors: v2Actors,
    ...(governanceMode !== undefined ? { governanceMode } : {}),
    ...(bootstrapOwnerActorId !== undefined ? { bootstrapOwnerActorId } : {}),
  };
  const v2RegistryFilename = "approval-actor-registry-v2.json";
  const v2RegistryPath = join(fixture.artifactRoot, v2RegistryFilename);
  writeArtifact(fixture.artifactRoot, v2RegistryFilename, v2Registry);
  const v2RegistrySha = fileSha(v2RegistryPath);

  // 3. Write the v2 artifact index (head). Lists every non-index/non-ledger
  //    artifact so the head-index completeness check passes, including both
  //    the v1 and v2 registries.
  const v2IndexArtifacts = [
    { artifactId: "phase0-20260714", artifactType: "phase0-summary", sha256: fileSha(fixture.phase0Path), path: "quality-contracts/agent-readiness/phase0-summary-v1.json" },
    { artifactId: "ownership-20260714", artifactType: "ownership-map", sha256: fileSha(fixture.ownershipPath), path: "quality-contracts/agent-readiness/ownership-map-v1.json" },
    { artifactId: "taxonomy-20260714", artifactType: "taxonomy-digest", sha256: fileSha(fixture.taxonomyPath), path: "quality-contracts/agent-readiness/taxonomy-digest-v1.json" },
    { artifactId: "actors-20260714", artifactType: "approval-actor-registry", sha256: fileSha(fixture.registryPath), path: "quality-contracts/agent-readiness/approval-actor-registry-v1.json" },
    { artifactId: "actors-c1-v2", artifactType: "approval-actor-registry", sha256: v2RegistrySha, path: `quality-contracts/agent-readiness/${v2RegistryFilename}` },
  ];
  const v1Index = readJson<{ implementationActorIds?: string[] } & Record<string, unknown>>(fixture.indexPath);
  // When exercising the implementer-self-approval path with an agent bootstrap
  // owner, register the shared actor as an implementation actor in the v2
  // index so the validator's implementationActorIds set contains it. Human
  // owners are left untouched.
  const v1Implementers = v1Index.implementationActorIds ?? [];
  const extraImplementers =
    bootstrapOwnerKind === "agent" && sharedApprovalActorId !== undefined
      ? [sharedApprovalActorId]
      : [];
  const implementationActorIds = Array.from(new Set([...v1Implementers, ...extraImplementers]));
  const { implementationActorIds: _drop, ...v1IndexRest } = v1Index;
  void _drop;
  const v2Index = {
    ...v1IndexRest,
    artifactId: "index-c1-v2",
    ordinalVersion: 2,
    predecessor: { version: "1", sha256: fileSha(fixture.indexPath) },
    artifacts: v2IndexArtifacts,
    implementationActorIds,
  };
  const v2IndexFilename = "artifact-index-v2.json";
  const v2IndexPath = join(fixture.artifactRoot, v2IndexFilename);
  writeArtifact(fixture.artifactRoot, v2IndexFilename, v2Index);
  const v2IndexSha = fileSha(v2IndexPath);

  // 4. Compute the REAL canonical C1 target over synthetic-resolved bytes.
  //    C1 approvals reference the v2 registry, so the target uses version
  //    "2.0" and the v2 registry sha.
  const c1TargetArtifacts = [
    { artifactId: "actors-c1-v2", artifactType: "approval-actor-registry", sha256: v2RegistrySha },
    { artifactId: "index-c1-v2", artifactType: "artifact-index", sha256: v2IndexSha },
  ];
  const c1Target = buildCheckpointTarget({
    checkpoint: "C1",
    baselineGitSha: C1_RECIPE.baselineGitSha,
    artifacts: c1TargetArtifacts,
    planSha256: planSha,
    specSha256: specSha,
    actorRegistryVersion: "2.0",
    actorRegistrySha256: v2RegistrySha,
    contractHashes,
    inputHashes, // C1_RECIPE.targetIncludesInputHashes === true
  });
  const c1TargetSha = computeCheckpointTargetSha256(c1Target);

  // 5. Write the v2 ledger (head). Carries the v1 C0 approvals unchanged
  //    (append-only) plus two C1 approvals. By default the approvals come
  //    from distinct Product + Engineering actors; when `sharedApprovalActorId`
  //    is present both approvals reuse the single shared actor (still with
  //    the two required roles) so actor-cardinality is the deciding check.
  const v1Ledger = readJson<{ approvals: unknown[]; schemaVersion?: string; createdAt?: string; createdByRole?: string; sourceGitSha?: string }>(fixture.ledgerPath!);
  const c1ApprovedArtifacts = c1TargetArtifacts.map((a) => ({
    artifactId: a.artifactId,
    sha256: a.sha256,
  }));
  const productActor =
    sharedApprovalActorId !== undefined
      ? {
          approvalId: "c1-product",
          actorId: sharedApprovalActorId,
          actorKind: bootstrapOwnerKind,
        }
      : { approvalId: "c1-product", actorId: "product-1", actorKind: "human" as const };
  const engineeringActor =
    sharedApprovalActorId !== undefined
      ? {
          approvalId: "c1-engineering",
          actorId: sharedApprovalActorId,
          actorKind: bootstrapOwnerKind,
        }
      : { approvalId: "c1-engineering", actorId: "engineering-1", actorKind: "human" as const };
  const c1Approvals = [
    {
      approvalKind: "checkpoint",
      checkpoint: "C1",
      decision: "approved",
      role: "Product",
      actorRegistryVersion: "2.0",
      actorRegistrySha256: v2RegistrySha,
      checkpointTargetSha256: c1TargetSha,
      approvedArtifacts: c1ApprovedArtifacts,
      planSha256: planSha,
      specSha256: specSha,
      contractHashes,
      decidedAt: "2026-07-15T10:00:00Z",
      ...productActor,
    },
    {
      approvalKind: "checkpoint",
      checkpoint: "C1",
      decision: "approved",
      role: "Engineering",
      actorRegistryVersion: "2.0",
      actorRegistrySha256: v2RegistrySha,
      checkpointTargetSha256: c1TargetSha,
      approvedArtifacts: c1ApprovedArtifacts,
      planSha256: planSha,
      specSha256: specSha,
      contractHashes,
      decidedAt: "2026-07-15T10:01:00Z",
      ...engineeringActor,
    },
  ];
  const v2Ledger = {
    ...v1Ledger,
    artifactId: "approvals-c1-v2",
    ordinalVersion: 2,
    predecessor: { version: "1", sha256: fileSha(fixture.ledgerPath!) },
    approvals: [...v1Ledger.approvals, ...c1Approvals],
  };
  const v2LedgerFilename = "checkpoint-approvals-v2.json";
  const v2LedgerPath = join(fixture.artifactRoot, v2LedgerFilename);
  writeArtifact(fixture.artifactRoot, v2LedgerFilename, v2Ledger);

  return { registryPath: v2RegistryPath, indexPath: v2IndexPath, ledgerPath: v2LedgerPath };
}

/**
 * Append a registry v3 + index v3 pair on top of an existing v2 governance
 * snapshot. Registry v3 declares `governanceMode: "separation-of-duties"` and
 * pins registry v2 as its predecessor; index v3 carries ordinal `3`, pins
 * index v2 as its predecessor, and adds a row indexing registry v3.
 *
 * This advances the chain head to the separation-of-duties registry WITHOUT
 * touching the ledger, so existing C1 approvals remain pinned to registry v2.
 * Used to prove actor-cardinality is evaluated against each approval's pinned
 * registry rather than the current head.
 *
 * `v2RegistryPath` is the path returned by `addValidSyntheticC1Approvals`.
 */
function writeRegistryAndIndexV3(
  fixture: ReturnType<typeof buildValidGraph>,
  v2RegistryPath: string,
): void {
  // The v2 index path by sibling filename convention. The v2 snapshot was
  // written as artifact-index-v2.json next to the v2 registry.
  const v2IndexPath = join(fixture.artifactRoot, "artifact-index-v2.json");

  const v2Registry = readJson<Record<string, unknown>>(v2RegistryPath);
  // Strip any bootstrapOwnerActorId carried over from v2 so v3 is a clean
  // separation-of-duties declaration (bootstrapOwnerActorId is only valid in
  // sole-maintainer-bootstrap mode per validateRegistry).
  const { bootstrapOwnerActorId: _omit, ...v2RegistryRest } = v2Registry;
  void _omit;
  const v3Registry = {
    ...v2RegistryRest,
    artifactId: "actors-c1-v3",
    registryVersion: "3.0",
    previousRegistry: { registryVersion: "2.0", sha256: fileSha(v2RegistryPath) },
    // v3 reverts to separation-of-duties so the head registry no longer
    // authorizes a sole maintainer.
    governanceMode: "separation-of-duties",
  };
  const v3RegistryFilename = "approval-actor-registry-v3.json";
  const v3RegistryPath = join(fixture.artifactRoot, v3RegistryFilename);
  writeArtifact(fixture.artifactRoot, v3RegistryFilename, v3Registry);
  const v3RegistrySha = fileSha(v3RegistryPath);

  const v2Index = readJson<{ artifacts: unknown[] }>(v2IndexPath);
  const v3IndexArtifacts = [
    ...v2Index.artifacts,
    {
      artifactId: "actors-c1-v3",
      artifactType: "approval-actor-registry",
      sha256: v3RegistrySha,
      path: `quality-contracts/agent-readiness/${v3RegistryFilename}`,
    },
  ];
  const v3Index = {
    ...v2Index,
    artifactId: "index-c1-v3",
    ordinalVersion: 3,
    predecessor: { version: "2", sha256: fileSha(v2IndexPath) },
    artifacts: v3IndexArtifacts,
  };
  const v3IndexFilename = "artifact-index-v3.json";
  writeArtifact(fixture.artifactRoot, v3IndexFilename, v3Index);
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

// ---------------------------------------------------------------------------
// Tests — governance snapshot chains (Task 4 integration)
// ---------------------------------------------------------------------------

describe("governance snapshot chains", () => {
  let fixture: ReturnType<typeof buildValidGraph>;

  afterEach(() => {
    if (fixture) cleanup(fixture.root);
  });

  function validate(f: ReturnType<typeof buildValidGraph>) {
    return validateReadinessArtifacts({
      artifactRoot: f.artifactRoot,
      repoRoot: f.repoRoot,
      gitSourceResolver: f.resolver,
      mode: "public",
    });
  }

  it("rejects two registry snapshots with the same version", () => {
    fixture = buildValidGraph({ withApprovals: true });
    writeRegistryV2(fixture);
    writeRegistryV2(fixture, { artifactId: "actors-c1-v2-fork" });
    const result = validate(fixture);
    expect(result.issues.some((i) => i.code === "chain-duplicate-key")).toBe(true);
  });

  it("rejects a ledger successor whose predecessor is missing", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const v1 = readJson<{ approvals: unknown[] }>(fixture.ledgerPath!);
    writeLedgerV2(fixture, v1.approvals, {
      predecessor: { version: "1", sha256: "f".repeat(64) },
    });
    rmSync(fixture.ledgerPath!);
    const result = validate(fixture);
    expect(result.issues.some((i) => i.code === "chain-missing-predecessor")).toBe(true);
  });

  it("rejects a ledger fork with two terminal successors", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const v1 = readJson<{ approvals: unknown[] }>(fixture.ledgerPath!);
    writeLedgerV2(fixture, v1.approvals);
    writeLedgerV2(fixture, v1.approvals, { artifactId: "approvals-c1-v2-fork" });
    const result = validate(fixture);
    expect(result.issues.some((i) => i.code === "chain-duplicate-key" || i.code === "chain-fork")).toBe(true);
  });

  it.each([
    ["deletion", (approvals: unknown[]) => approvals.slice(1), "ledger-approval-deleted"],
    ["mutation", (approvals: { rationale?: string }[]) => [{ ...approvals[0]!, rationale: "rewritten" }, ...approvals.slice(1)], "ledger-approval-mutated"],
    ["reordering", (approvals: unknown[]) => [...approvals].reverse(), "ledger-approval-reordered"],
  ])("rejects predecessor approval %s", (_label, mutate, code) => {
    fixture = buildValidGraph({ withApprovals: true });
    const v1 = readJson<{ approvals: unknown[] }>(fixture.ledgerPath!);
    writeLedgerV2(fixture, mutate(v1.approvals));
    const result = validate(fixture);
    expect(result.issues.some((i) => i.code === code)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Tests — per-approval registry resolution and closed-world policy (Task 5)
// ---------------------------------------------------------------------------

describe("per-approval registry resolution and closed-world policy", () => {
  let fixture: ReturnType<typeof buildValidGraph>;

  afterEach(() => {
    if (fixture) cleanup(fixture.root);
  });

  function validate(f: ReturnType<typeof buildValidGraph>) {
    return validateReadinessArtifacts({
      artifactRoot: f.artifactRoot,
      repoRoot: f.repoRoot,
      gitSourceResolver: f.resolver,
      mode: "public",
    });
  }

  it("resolves an older approval against the registry version it recorded", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const v1Ledger = readJson<{ approvals: unknown[] }>(fixture.ledgerPath!);
    writeRegistryV2(fixture);
    writeLedgerV2(fixture, v1Ledger.approvals);
    const result = validate(fixture);
    expect(result.issues.some((i) => i.code === "registry-hash-mismatch")).toBe(false);
    expect(result.checkpointStatus.C0).toBe("closed");
  });

  it("rejects an approval whose recorded registry digest does not match that version", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const v1Ledger = readJson<any>(fixture.ledgerPath!);
    v1Ledger.approvals[0].actorRegistrySha256 = "f".repeat(64);
    writeRegistryV2(fixture);
    writeLedgerV2(fixture, v1Ledger.approvals);
    const result = validate(fixture);
    expect(result.issues.some((i) => i.code === "registry-hash-mismatch")).toBe(true);
  });

  it("rejects an extra C0 contract key", () => {
    fixture = buildValidGraph({ withApprovals: true });
    mutateJson<any>(fixture.ledgerPath!, (ledger) => {
      ledger.approvals[0].contractHashes.unexpected = "a".repeat(64);
      return ledger;
    });
    const result = validate(fixture);
    expect(result.issues.some((i) => i.code === "policy-unexpected-contract-key")).toBe(true);
  });

  it("does not resolve C1 recipe bytes when no C1 approval exists", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const resolver: GitSourceResolver = {
      resolve(commit, path) {
        if (commit === C1_RECIPE.sourceGitSha) throw new Error(`C1 should not resolve: ${path}`);
        return fixture.resolver.resolve(commit, path);
      },
    };
    const result = validateReadinessArtifacts({
      artifactRoot: fixture.artifactRoot,
      repoRoot: fixture.repoRoot,
      gitSourceResolver: resolver,
      mode: "public",
    });
    expect(result.ok).toBe(true);
    expect(result.checkpointStatus).toMatchObject({ C0: "closed", C1: "open" });
  });

  it("fails when reviewed and merged C1 source bytes differ", () => {
    fixture = buildValidGraph({ withApprovals: true });
    addValidSyntheticC1Approvals(fixture);
    fixture.resolver.put(
      C1_MERGE_SHA,
      C1_RECIPE.contractBindings[0]!.repositoryPath,
      "tampered merge bytes",
    );
    const result = validate(fixture);
    expect(result.issues.some((i) => i.code === "checkpoint-provenance-mismatch")).toBe(true);
    expect(result.checkpointStatus.C1).toBe("open");
  });

  it("rejects a missing C1 contract key", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const c1 = addValidSyntheticC1Approvals(fixture);
    mutateJson<any>(c1.ledgerPath, (ledger) => {
      delete ledger.approvals.find((a: any) => a.checkpoint === "C1").contractHashes["tool-catalog.ts"];
      return ledger;
    });
    expect(validate(fixture).issues.some((i) => i.code === "policy-missing-contract-key")).toBe(true);
  });

  it("rejects duplicate checkpoint roles", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const c1 = addValidSyntheticC1Approvals(fixture);
    mutateJson<any>(c1.ledgerPath, (ledger) => {
      const product = ledger.approvals.find((a: any) => a.checkpoint === "C1" && a.role === "Product");
      ledger.approvals.push({ ...product, approvalId: "c1-product-duplicate", actorId: "product-2" });
      return ledger;
    });
    expect(validate(fixture).issues.some((i) => i.code === "policy-duplicate-role")).toBe(true);
  });

  it("closes C1 when valid synthetic C1 approvals are present", () => {
    fixture = buildValidGraph({ withApprovals: true });
    addValidSyntheticC1Approvals(fixture);
    const result = validate(fixture);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checkpointStatus).toMatchObject({ C0: "closed", C1: "closed" });
  });

  it("closes C1 for the human owner of a pinned bootstrap registry", () => {
    fixture = buildValidGraph({ withApprovals: true });
    addValidSyntheticC1Approvals(fixture, {
      governanceMode: "sole-maintainer-bootstrap",
      bootstrapOwnerActorId: "repo-maintainer-1",
      sharedApprovalActorId: "repo-maintainer-1",
    });
    const result = validate(fixture);
    expect(result.issues).toEqual([]);
    expect(result.checkpointStatus.C1).toBe("closed");
  });

  it("rejects the same actor outside bootstrap mode", () => {
    fixture = buildValidGraph({ withApprovals: true });
    addValidSyntheticC1Approvals(fixture, {
      governanceMode: "separation-of-duties",
      sharedApprovalActorId: "repo-maintainer-1",
    });
    const result = validate(fixture);
    expect(result.issues.some((i) => i.code === "checkpoint-actor-separation-violation")).toBe(true);
    expect(result.checkpointStatus.C1).toBe("open");
  });

  it("rejects a shared actor that is not the pinned bootstrap owner", () => {
    fixture = buildValidGraph({ withApprovals: true });
    addValidSyntheticC1Approvals(fixture, {
      governanceMode: "sole-maintainer-bootstrap",
      bootstrapOwnerActorId: "product-1",
      sharedApprovalActorId: "repo-maintainer-1",
    });
    const result = validate(fixture);
    expect(result.issues.some((i) => i.code === "checkpoint-actor-separation-violation")).toBe(true);
    expect(result.checkpointStatus.C1).toBe("open");
  });

  it("rejects an implementation actor as bootstrap approver", () => {
    fixture = buildValidGraph({ withApprovals: true });
    addValidSyntheticC1Approvals(fixture, {
      governanceMode: "sole-maintainer-bootstrap",
      bootstrapOwnerActorId: "impl-agent-1",
      sharedApprovalActorId: "impl-agent-1",
      bootstrapOwnerKind: "agent",
    });
    const result = validate(fixture);
    expect(result.issues.some((i) => i.code === "implementer-self-approval")).toBe(true);
    expect(result.checkpointStatus.C1).toBe("open");
  });

  it("uses each approval's pinned registry mode instead of the current head", () => {
    fixture = buildValidGraph({ withApprovals: true });
    const c1 = addValidSyntheticC1Approvals(fixture, {
      governanceMode: "sole-maintainer-bootstrap",
      bootstrapOwnerActorId: "repo-maintainer-1",
      sharedApprovalActorId: "repo-maintainer-1",
    });
    writeRegistryAndIndexV3(fixture, c1.registryPath);
    const result = validate(fixture);
    expect(result.issues).toEqual([]);
    expect(result.checkpointStatus.C1).toBe("closed");
  });
});
