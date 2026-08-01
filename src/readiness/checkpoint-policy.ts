/**
 * C0 checkpoint recipe and git-bound source resolver interface.
 *
 * The readiness validator computes C0 checkpoint closure by recomputing the
 * canonical `CheckpointTarget` from independently-resolved historical bytes
 * and comparing it against every approval's `checkpointTargetSha256`. To make
 * that recomputation deterministic and independent of the live working tree,
 * every input byte (plan, spec, contracts, registry, and the phase0-summary
 * `inputHashes` files) is resolved at an exact recorded Git commit.
 *
 * DESIGN INVARIANT (parent plan, line ~482): "Resolution must use the exact
 * recorded commit/path bytes, not the working tree." Subsequent C1 commits
 * are free to edit the live parent plan / spec / contracts without reopening
 * C0 — only a change to the *historical* bytes (i.e. rewriting history) would
 * invalidate an issued approval.
 *
 * The validator stays pure: it accepts a `GitSourceResolver` function and
 * never shells out itself. Only the CLI supplies a real `git show`-backed
 * resolver; tests inject an in-memory map.
 */

// ---------------------------------------------------------------------------
// Resolver interface
// ---------------------------------------------------------------------------

/**
 * A binding from a logical alias (e.g. "parent-plan.md") to an exact
 * (commit, repositoryPath) pair whose tree contains the approved bytes.
 */
export interface CheckpointSourceBinding {
  /** Logical alias used in approvals / phase0-summary inputHashes. */
  readonly key: string;
  /** Normalized repo-relative path (forward slashes, no leading slash). */
  readonly repositoryPath: string;
  /** Exact 40-hex commit whose tree contains the approved bytes. */
  readonly gitCommit: string;
}

/**
 * Pure resolver: returns the exact file bytes at a (commit, repoPath).
 *
 * Implementations MUST be deterministic and side-effect free from the
 * validator's perspective. The CLI implementation shells out to
 * `git show <commit>:<path>`; tests use an in-memory map.
 */
export interface GitSourceResolver {
  resolve(commit: string, repositoryPath: string): Uint8Array;
}

// ---------------------------------------------------------------------------
// Recipe
// ---------------------------------------------------------------------------

/** Identifier for a checkpoint whose recipe and policy are declared in code. */
export type CheckpointId = "C0" | "C1" | "C2" | "C3";

/**
 * The complete recipe for recomputing a checkpoint's canonical target.
 *
 * `baselineGitSha` is the frozen Phase-0 baseline (374f720...). `sourceGitSha`
 * is the commit at which the approved plan/spec/inputHashes bytes live. The
 * `contracts` binding may legitimately point at a later commit when the file
 * did not exist at `sourceGitSha` — see C0_RECIPE for the single such case.
 *
 * `integrationGitSha`, when set, records the merge commit at which the reviewed
 * source bytes were integrated. C1 sets this so the validator can prove the
 * reviewed commit and the merged tree carry identical bytes for every binding
 * (reviewed != merged would mean the merge changed content after review). C0
 * leaves it unset because its approvals predate this provenance check.
 */
export interface CheckpointRecipe {
  readonly checkpoint: CheckpointId;
  /** Frozen Phase-0 baseline commit. */
  readonly baselineGitSha: string;
  /** Commit whose tree holds the approved plan / spec / inputHashes bytes. */
  readonly sourceGitSha: string;
  /**
   * Merge commit whose tree must carry byte-identical copies of every bound
   * source file. Optional: only C1 (and later checkpoints with merge
   * provenance) set this.
   */
  readonly integrationGitSha?: string;
  /** Artifact set that every approval for this checkpoint must approve exactly. */
  readonly artifacts: ReadonlyArray<{ artifactId: string; artifactType: string }>;
  /** Binding for the task plan (approval.planSha256 source). */
  readonly planBinding: CheckpointSourceBinding;
  /** Binding for the design spec (approval.specSha256 source). */
  readonly specBinding: CheckpointSourceBinding;
  /**
   * Bindings for approval.contractHashes. Keys are the contract aliases
   * recorded in the ledger (e.g. "parent-plan.md",
   * "src/readiness/contracts.ts"). Each maps to an exact commit/path.
   */
  readonly contractBindings: ReadonlyArray<CheckpointSourceBinding>;
  /**
   * phase0-summary `inputHashes` keys that must be present, and whose values
   * must match the resolved historical hash of the corresponding file.
   */
  readonly inputHashKeys: ReadonlyArray<string>;
  /**
   * Per-key git bindings for the phase0-summary `inputHashes` entries that
   * alias git-tracked files (resolved at the recorded commit). Keys that alias
   * artifact-root files (e.g. "ownership-map-v1.json") are NOT listed here:
   * they resolve from the in-memory parsed artifact `.sha`, since those files
   * are already integrity-pinned by the artifact-index hash check.
   */
  readonly inputHashBindings: ReadonlyArray<CheckpointSourceBinding>;
  /**
   * Whether the canonical checkpoint target includes the `inputHashes` field.
   *
   * The historical C0 ledger (`fc74e54d...`) was computed with
   * `inputHashes: {}` — the field existed in `CheckpointTarget` at approval
   * time but the approver passed an empty record. To reproduce the
   * already-approved target exactly (and avoid reopening C0), target
   * recomputation uses an empty `inputHashes` record when this is `false`.
   * The phase0-summary input hashes are still verified independently via the
   * `summary-input-hash-mismatch` check, so coverage is not weakened.
   */
  readonly targetIncludesInputHashes: boolean;
}

/**
 * Closed-world policy for a checkpoint. Every field is an exact set: an
 * approval is valid only when its observed values match the set with no
 * missing and no extra members. Derived from the corresponding recipe so the
 * policy never drifts from the declared bindings.
 */
export interface CheckpointPolicy {
  /** Artifact types every approval's approvedArtifacts must cover exactly. */
  readonly requiredArtifactTypes: readonly string[];
  /** Source binding keys (plan + spec) every approval must carry exactly. */
  readonly requiredSourceKeys: readonly string[];
  /** Contract hash keys every approval's contractHashes must carry exactly. */
  readonly requiredContractKeys: readonly string[];
  /** phase0-summary inputHashes keys that must be present exactly. */
  readonly requiredInputHashKeys: readonly string[];
  /** Roles that must approve this checkpoint, each by a distinct actor. */
  readonly requiredRoles: readonly string[];
}

// ---------------------------------------------------------------------------
// C0 recipe — reproduces the already-approved ledger target
// ---------------------------------------------------------------------------

/**
 * Frozen Phase-0 baseline. Every C0 evidence artifact records this as its
 * `sourceGitSha` (the commit at which Phase-0 evidence was gathered).
 */
export const C0_BASELINE_GIT_SHA = "374f72073c81ea7901696333cd875fe75b348e6b";

/**
 * The commit at which the approved C0 plan / spec / inputHashes bytes live.
 * The ledger `sourceGitSha` for checkpoint-approvals and the artifact index.
 */
export const C0_SOURCE_GIT_SHA = "853151cc2b2edbc444f33100bde91dd97911638c";

/**
 * The commit at which `src/readiness/contracts.ts` was first approved.
 *
 * This file did NOT exist at C0_SOURCE_GIT_SHA (its parent is
 * C0_SOURCE_GIT_SHA). The ledger binds its tree hash at this commit
 * (ed58e90...), whose blob c28cbddf... SHA-256 is exactly
 * ed22eeed3eea99be979992109db16f3e51cea7b5103d45fdf0d2c2c6244f5f5f,
 * matching the ledger. This is the single C0 binding that legitimately uses
 * a commit later than C0_SOURCE_GIT_SHA, because the file simply did not
 * exist earlier — recording it precisely here preserves the parent-plan
 * invariant ("exact recorded commit bytes") for every other binding.
 */
export const C0_CONTRACTS_GIT_SHA = "ed58e905531cbe47e8d8c0d205c37c3d294356bd";

/**
 * The four evidence/registry artifacts every C0 approval must approve.
 * Derived from quality-contracts/agent-readiness/artifact-index-v1.json.
 */
export const C0_ARTIFACTS: ReadonlyArray<{ artifactId: string; artifactType: string }> = [
  { artifactId: "actors-20260714", artifactType: "approval-actor-registry" },
  { artifactId: "ownership-20260714", artifactType: "ownership-map" },
  { artifactId: "phase0-20260714", artifactType: "phase0-summary" },
  { artifactId: "taxonomy-20260714", artifactType: "taxonomy-digest" },
];

/** Repository-relative paths for the artifact-root files (git-tracked). */
const ARTIFACT_ROOT = "quality-contracts/agent-readiness";

/**
 * The canonical C0 checkpoint recipe. Reproduces the exact target hash
 * `fc74e54da3d6f597c5f04d88aee57ad8dbd4e18e3b985f1e7e58b9dbd7e2b2b3`
 * recorded in checkpoint-approvals-v1.json.
 */
export const C0_RECIPE: CheckpointRecipe = {
  checkpoint: "C0",
  baselineGitSha: C0_BASELINE_GIT_SHA,
  sourceGitSha: C0_SOURCE_GIT_SHA,

  artifacts: C0_ARTIFACTS,

  // approval.planSha256 — the task1 plan (the plan that produced the contracts).
  planBinding: {
    key: "task1-plan.md",
    repositoryPath:
      "docs/superpowers/plans/2026-07-14-task1-readiness-contracts.md",
    gitCommit: C0_SOURCE_GIT_SHA,
  },

  // approval.specSha256 — the agent-readiness design spec.
  specBinding: {
    key: "design-spec.md",
    repositoryPath:
      "docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md",
    gitCommit: C0_SOURCE_GIT_SHA,
  },

  // approval.contractHashes — both aliases recorded in the ledger.
  contractBindings: [
    {
      key: "parent-plan.md",
      repositoryPath:
        "docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md",
      gitCommit: C0_SOURCE_GIT_SHA,
    },
    {
      // Legitimately later commit — see C0_CONTRACTS_GIT_SHA doc above.
      key: "src/readiness/contracts.ts",
      repositoryPath: "src/readiness/contracts.ts",
      gitCommit: C0_CONTRACTS_GIT_SHA,
    },
  ],

  // phase0-summary inputHashes keys (order independent — comparison is set-wise).
  inputHashKeys: [
    "ownership-map-v1.json",
    "taxonomy-digest-v1.json",
    "parent-plan.md",
    "task1-plan.md",
    "design-spec.md",
    "run-no-egress.mjs",
  ],

  // Git-file inputHashes bindings. Artifact-root aliases
  // ("ownership-map-v1.json", "taxonomy-digest-v1.json") are intentionally
  // absent: they resolve from the in-memory parsed artifact `.sha` (already
  // integrity-pinned by the artifact-index hash check), avoiding a redundant
  // and commit-ambiguous git lookup.
  inputHashBindings: [
    {
      key: "parent-plan.md",
      repositoryPath:
        "docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md",
      gitCommit: C0_SOURCE_GIT_SHA,
    },
    {
      key: "task1-plan.md",
      repositoryPath:
        "docs/superpowers/plans/2026-07-14-task1-readiness-contracts.md",
      gitCommit: C0_SOURCE_GIT_SHA,
    },
    {
      key: "design-spec.md",
      repositoryPath:
        "docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md",
      gitCommit: C0_SOURCE_GIT_SHA,
    },
    {
      key: "run-no-egress.mjs",
      repositoryPath: "scripts/run-no-egress.mjs",
      gitCommit: C0_SOURCE_GIT_SHA,
    },
  ],

  // The historical ledger was computed with inputHashes: {} (see field doc).
  targetIncludesInputHashes: false,
};

// ---------------------------------------------------------------------------
// C1 recipe — declared ahead of any approvals; activates only on C1 approval
// ---------------------------------------------------------------------------

/**
 * The commit at which the C1 contract sources were reviewed/approved. This is
 * `022a3f2` ("fix: deterministic decision-id collision test + ..."), the
 * head of the reviewed content. The C1 recipe resolves every plan/spec/contract
 * binding at this commit.
 */
export const C1_CONTRACT_SHA = "022a3f229a4aeba74b9b140142fd2d3a0aa6c4be";

/**
 * The merge commit (`7609e3c`) that integrated `C1_CONTRACT_SHA` into main via
 * PR #30. Recorded separately from the reviewed commit so the validator can
 * prove the reviewed bytes and the merged tree are byte-identical for every
 * C1 binding — i.e. the merge did not alter reviewed content.
 */
export const C1_MERGE_SHA = "7609e3c14daddd4448d6bdf37c9a6a337a7241d0";

/**
 * Semantic artifact IDs for the future C1 governance artifacts. These names
 * pin the contract for the deferred artifact plan: actor identity remains
 * unassigned and no v2 JSON files are created by this recipe.
 */
export const C1_ARTIFACTS = [
  { artifactId: "actors-c1-v2", artifactType: "approval-actor-registry" },
  { artifactId: "index-c1-v2", artifactType: "artifact-index" },
] as const;

/** Plan binding: the phase-0/1c implementation plan, reviewed at C1_CONTRACT_SHA. */
const C1_PLAN_BINDING: CheckpointSourceBinding = {
  key: "task1-plan.md",
  repositoryPath:
    "docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md",
  gitCommit: C1_CONTRACT_SHA,
};

/** Spec binding: the agent-readiness design spec, reviewed at C1_CONTRACT_SHA. */
const C1_SPEC_BINDING: CheckpointSourceBinding = {
  key: "design-spec.md",
  repositoryPath:
    "docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md",
  gitCommit: C1_CONTRACT_SHA,
};

/**
 * Contract bindings: the four tool-contract sources introduced for C1. Every
 * binding resolves at C1_CONTRACT_SHA (the reviewed commit); the
 * `integrationGitSha` check additionally proves each is byte-identical at
 * C1_MERGE_SHA.
 */
const C1_CONTRACT_BINDINGS: readonly CheckpointSourceBinding[] = [
  { key: "tool-contracts.ts", repositoryPath: "src/tool-contracts.ts", gitCommit: C1_CONTRACT_SHA },
  { key: "tool-contract-integrity.ts", repositoryPath: "src/tool-contract-integrity.ts", gitCommit: C1_CONTRACT_SHA },
  { key: "tool-contract-docs.ts", repositoryPath: "src/tool-contract-docs.ts", gitCommit: C1_CONTRACT_SHA },
  { key: "tool-catalog.ts", repositoryPath: "src/tool-catalog.ts", gitCommit: C1_CONTRACT_SHA },
];

/**
 * The canonical C1 checkpoint recipe. Declared now so policy is closed-world
 * before any C1 approval exists. With no C1 approvals in the ledger, the
 * validator skips C1 target recomputation and C1 remains open without an
 * issue; the recipe activates only when a C1 approval appears.
 */
export const C1_RECIPE: CheckpointRecipe = {
  checkpoint: "C1",
  baselineGitSha: C0_BASELINE_GIT_SHA,
  sourceGitSha: C1_CONTRACT_SHA,
  integrationGitSha: C1_MERGE_SHA,
  artifacts: C1_ARTIFACTS,
  planBinding: C1_PLAN_BINDING,
  specBinding: C1_SPEC_BINDING,
  contractBindings: C1_CONTRACT_BINDINGS,
  inputHashKeys: [
    "task1-plan.md",
    "design-spec.md",
    "tool-contracts.ts",
    "tool-contract-integrity.ts",
    "tool-contract-docs.ts",
    "tool-catalog.ts",
  ],
  inputHashBindings: [C1_PLAN_BINDING, C1_SPEC_BINDING, ...C1_CONTRACT_BINDINGS],
  // C1 targets are recomputed with inputHashes populated (no legacy ledger to
  // reproduce byte-for-byte).
  targetIncludesInputHashes: true,
};

// ---------------------------------------------------------------------------
// C2 recipe — Gold/QA evidence and approval provenance
// ---------------------------------------------------------------------------

/**
 * C2 source bindings are anchored to the reviewed tree that already contains
 * the Pass 3 plan, gold-readiness spec, and C2 implementation. The readiness
 * recipe itself is validator policy; the bound C2 sources below are the
 * artifacts the Gold/QA approval is claiming to review.
 */
export const C2_SOURCE_GIT_SHA = "fcc21fc803863ad19686044f8a1ae01b384546cf";

const C2_PLAN_BINDING: CheckpointSourceBinding = {
  key: "c2-pass3-plan.md",
  repositoryPath: "docs/superpowers/plans/2026-07-22-c2-pass3-execution-and-closure.md",
  gitCommit: C2_SOURCE_GIT_SHA,
};

const C2_SPEC_BINDING: CheckpointSourceBinding = {
  key: "c2-gold-readiness-spec.md",
  repositoryPath: "docs/superpowers/specs/2026-07-19-c2-gold-readiness-design.md",
  gitCommit: C2_SOURCE_GIT_SHA,
};

const C2_CONTRACT_BINDINGS: readonly CheckpointSourceBinding[] = [
  { key: "src/c2/candidate-contracts.ts", repositoryPath: "src/c2/candidate-contracts.ts", gitCommit: C2_SOURCE_GIT_SHA },
  { key: "src/c2/case-contracts.ts", repositoryPath: "src/c2/case-contracts.ts", gitCommit: C2_SOURCE_GIT_SHA },
  { key: "src/c2/condition-contracts.ts", repositoryPath: "src/c2/condition-contracts.ts", gitCommit: C2_SOURCE_GIT_SHA },
  { key: "src/c2/evaluation-contracts.ts", repositoryPath: "src/c2/evaluation-contracts.ts", gitCommit: C2_SOURCE_GIT_SHA },
  { key: "src/c2/governance-contracts.ts", repositoryPath: "src/c2/governance-contracts.ts", gitCommit: C2_SOURCE_GIT_SHA },
  { key: "src/c2/remediation-contracts.ts", repositoryPath: "src/c2/remediation-contracts.ts", gitCommit: C2_SOURCE_GIT_SHA },
  { key: "src/c2/closure-evaluator.ts", repositoryPath: "src/c2/closure-evaluator.ts", gitCommit: C2_SOURCE_GIT_SHA },
  { key: "src/c2/label-agreement.ts", repositoryPath: "src/c2/label-agreement.ts", gitCommit: C2_SOURCE_GIT_SHA },
];

export const C2_ARTIFACTS = [
  { artifactId: "actors-c1-v3", artifactType: "approval-actor-registry" },
  { artifactId: "index-c1-v3", artifactType: "artifact-index" },
  { artifactId: "c2-evidence-v1", artifactType: "c2-evidence-manifest" },
] as const;

/** C2 closes only with distinct Gold Label Owner and QA actors. */
export const C2_RECIPE: CheckpointRecipe = {
  checkpoint: "C2",
  baselineGitSha: C0_BASELINE_GIT_SHA,
  sourceGitSha: C2_SOURCE_GIT_SHA,
  artifacts: C2_ARTIFACTS,
  planBinding: C2_PLAN_BINDING,
  specBinding: C2_SPEC_BINDING,
  contractBindings: C2_CONTRACT_BINDINGS,
  inputHashKeys: [],
  inputHashBindings: [],
  targetIncludesInputHashes: false,
};

// ---------------------------------------------------------------------------
// C3 recipe — create_ui_spec slice evidence and approval provenance
// ---------------------------------------------------------------------------

/**
 * The reviewed head of the C3 `create_ui_spec` first slice on main. This is
 * `5255a65` ("fix(c3): enforce the six citation-consistency rules on the HTTP
 * transport too", 2026-07-29) — the last commit that changed the slice's
 * transport/contract content before the slice concluded. Every C3 binding
 * resolves at this commit, so the validator recomputes the canonical target
 * from the reviewed bytes.
 *
 * Later main commits (e.g. the ui-server sanitization `22eb852`, the
 * mcp/decision-lab fs-path fix `a790761`) are POST-REVIEW hardening and are
 * not part of the reviewed content. Per the DESIGN INVARIANT (parent plan,
 * line ~482), subsequent edits to the live tree do not reopen a checkpoint —
 * only a change to the *historical* bytes would.
 */
export const C3_SOURCE_GIT_SHA = "5255a656cc35763b73d85c5eabb401e3bde9714d";

/** Plan binding: the C3 first-slice implementation plan, reviewed at C3_SOURCE_GIT_SHA. */
const C3_PLAN_BINDING: CheckpointSourceBinding = {
  key: "c3-first-slice-plan.md",
  repositoryPath:
    "docs/superpowers/plans/2026-07-27-c3-create-ui-spec-first-slice-implementation-plan.md",
  gitCommit: C3_SOURCE_GIT_SHA,
};

/** Spec binding: the C3 first-slice design spec, reviewed at C3_SOURCE_GIT_SHA. */
const C3_SPEC_BINDING: CheckpointSourceBinding = {
  key: "c3-first-slice-design.md",
  repositoryPath:
    "docs/superpowers/specs/2026-07-27-c3-create-ui-spec-first-slice-design.md",
  gitCommit: C3_SOURCE_GIT_SHA,
};

/**
 * Contract bindings: every source file that makes up the landed slice — both
 * the WIRING surface and the IMPLEMENTATION. A file hash covers only that file's
 * own bytes, never its imports, so binding only the wiring (tool contract,
 * server factory, HTTP transport, Playground composer, skill) would leave the
 * canonical target invariant to changes in the ~3.5k lines of core logic those
 * files call into — a C3 sign-off would then attest a fingerprint that omits the
 * code being reviewed. The recipe therefore binds the transitive slice:
 *
 *   WIRING          — tool-contracts, server-factory, ui-server, App.tsx, SKILL.md
 *   IMPLEMENTATION  — create-ui-spec{,-contracts,-mcp,-http,-dependencies,
 *                     -transport-errors}.ts, c3/safe-aggregator.ts,
 *                     c3/fallback-recipe-v1.json
 *
 * Keys are repo-relative paths (unique, stable, self-describing in the ledger's
 * contractHashes). Every binding resolves at C3_SOURCE_GIT_SHA; C3 sets no
 * `integrationGitSha` because the slice landed across multiple commits (unlike
 * C1's single merge) and later hardening legitimately diverges from the reviewed
 * bytes — so C3 is historical-only by design (the recipe attests WHAT was
 * reviewed, not that the live tree still matches it).
 */
const C3_CONTRACT_BINDINGS: readonly CheckpointSourceBinding[] = [
  // Wiring surface.
  { key: "src/tool-contracts.ts", repositoryPath: "src/tool-contracts.ts", gitCommit: C3_SOURCE_GIT_SHA },
  { key: "src/server-factory.ts", repositoryPath: "src/server-factory.ts", gitCommit: C3_SOURCE_GIT_SHA },
  { key: "src/scripts/ui-server.ts", repositoryPath: "src/scripts/ui-server.ts", gitCommit: C3_SOURCE_GIT_SHA },
  { key: "site/src/app/App.tsx", repositoryPath: "site/src/app/App.tsx", gitCommit: C3_SOURCE_GIT_SHA },
  { key: "skill/clean-ui-design/SKILL.md", repositoryPath: "skill/clean-ui-design/SKILL.md", gitCommit: C3_SOURCE_GIT_SHA },
  // create_ui_spec implementation.
  { key: "src/create-ui-spec.ts", repositoryPath: "src/create-ui-spec.ts", gitCommit: C3_SOURCE_GIT_SHA },
  { key: "src/create-ui-spec-contracts.ts", repositoryPath: "src/create-ui-spec-contracts.ts", gitCommit: C3_SOURCE_GIT_SHA },
  { key: "src/create-ui-spec-mcp.ts", repositoryPath: "src/create-ui-spec-mcp.ts", gitCommit: C3_SOURCE_GIT_SHA },
  { key: "src/create-ui-spec-http.ts", repositoryPath: "src/create-ui-spec-http.ts", gitCommit: C3_SOURCE_GIT_SHA },
  { key: "src/create-ui-spec-dependencies.ts", repositoryPath: "src/create-ui-spec-dependencies.ts", gitCommit: C3_SOURCE_GIT_SHA },
  { key: "src/create-ui-spec-transport-errors.ts", repositoryPath: "src/create-ui-spec-transport-errors.ts", gitCommit: C3_SOURCE_GIT_SHA },
  { key: "src/c3/safe-aggregator.ts", repositoryPath: "src/c3/safe-aggregator.ts", gitCommit: C3_SOURCE_GIT_SHA },
  { key: "src/c3/fallback-recipe-v1.json", repositoryPath: "src/c3/fallback-recipe-v1.json", gitCommit: C3_SOURCE_GIT_SHA },
];

/**
 * Semantic artifact IDs for the future C3 governance artifacts — a v2 actor
 * registry and v2 artifact index carrying the C3 actors. Mirrors C1's
 * declared-ahead pattern: the recipe pins the contract now so policy is
 * closed-world before any C3 approval exists; the JSON files themselves are
 * created by the C3 approvals PR, not by this recipe.
 */
export const C3_ARTIFACTS = [
  { artifactId: "actors-c3-v2", artifactType: "approval-actor-registry" },
  { artifactId: "index-c3-v2", artifactType: "artifact-index" },
] as const;

/** C3 closes only with distinct Product, QA, and Engineering actors. */
export const C3_RECIPE: CheckpointRecipe = {
  checkpoint: "C3",
  baselineGitSha: C0_BASELINE_GIT_SHA,
  sourceGitSha: C3_SOURCE_GIT_SHA,
  artifacts: C3_ARTIFACTS,
  planBinding: C3_PLAN_BINDING,
  specBinding: C3_SPEC_BINDING,
  contractBindings: C3_CONTRACT_BINDINGS,
  inputHashKeys: [],
  inputHashBindings: [],
  targetIncludesInputHashes: false,
};

// ---------------------------------------------------------------------------
// Closed-world policies — derived from recipes, no duplicated keys
// ---------------------------------------------------------------------------

/** Source binding keys (plan + spec) declared by a recipe. */
const sourceKeys = (recipe: CheckpointRecipe): readonly string[] => [
  recipe.planBinding.key,
  recipe.specBinding.key,
];

/** Contract hash keys declared by a recipe's contract bindings. */
const contractKeys = (recipe: CheckpointRecipe): readonly string[] =>
  recipe.contractBindings.map((b) => b.key);

/** Unique artifact types a recipe's approvals must cover. */
const artifactTypes = (recipe: CheckpointRecipe): readonly string[] => [
  ...new Set(recipe.artifacts.map((a) => a.artifactType)),
];

/**
 * Exact-set policies for every declared checkpoint. C0 reproduces the
 * historically approved closure; C1–C3 declare the roles and artifact/contract
 * sets required for a future authorized approval (C1 = tool contracts, C2 =
 * gold readiness, C3 = the create_ui_spec slice). All are derived from their
 * recipes so policy cannot drift from the declared bindings.
 */
export const CHECKPOINT_POLICIES: Record<CheckpointId, CheckpointPolicy> = {
  C0: {
    requiredArtifactTypes: artifactTypes(C0_RECIPE),
    requiredSourceKeys: sourceKeys(C0_RECIPE),
    requiredContractKeys: contractKeys(C0_RECIPE),
    requiredInputHashKeys: C0_RECIPE.inputHashKeys,
    requiredRoles: ["Repository Maintainer", "PM"],
  },
  C1: {
    requiredArtifactTypes: artifactTypes(C1_RECIPE),
    requiredSourceKeys: sourceKeys(C1_RECIPE),
    requiredContractKeys: contractKeys(C1_RECIPE),
    requiredInputHashKeys: C1_RECIPE.inputHashKeys,
    requiredRoles: ["Product", "Engineering"],
  },
  C2: {
    requiredArtifactTypes: artifactTypes(C2_RECIPE),
    requiredSourceKeys: sourceKeys(C2_RECIPE),
    requiredContractKeys: contractKeys(C2_RECIPE),
    requiredInputHashKeys: C2_RECIPE.inputHashKeys,
    requiredRoles: ["Gold Label Owner", "QA"],
  },
  C3: {
    requiredArtifactTypes: artifactTypes(C3_RECIPE),
    requiredSourceKeys: sourceKeys(C3_RECIPE),
    requiredContractKeys: contractKeys(C3_RECIPE),
    requiredInputHashKeys: C3_RECIPE.inputHashKeys,
    requiredRoles: ["Product", "QA", "Engineering"],
  },
};

/** All known recipes keyed by checkpoint id. */
export const CHECKPOINT_RECIPES: Record<CheckpointId, CheckpointRecipe> = {
  C0: C0_RECIPE,
  C1: C1_RECIPE,
  C2: C2_RECIPE,
  C3: C3_RECIPE,
};
