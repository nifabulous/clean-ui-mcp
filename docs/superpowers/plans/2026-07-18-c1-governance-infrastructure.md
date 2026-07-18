# C1 Governance Infrastructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add deterministic, closed-world C0/C1 governance validation without creating v2 governance artifacts or human C1 approvals.

**Architecture:** Readiness artifacts are parsed first, then registry/index/ledger candidates are converted into a shared chain graph whose unique terminal head—not filename order—selects authority. Checkpoint policy and Git-bound recipes remain declarative; approval validation resolves the registry recorded by each approval, enforces exact policy sets, and recomputes only checkpoints that have approvals.

**Tech Stack:** TypeScript 5.9, Node.js 22+, Zod 4, Vitest 4, Git-backed historical byte resolution.

## Global Constraints

- Work on `feat/c1-governance`, based on `origin/main` at `7609e3c14daddd4448d6bdf37c9a6a337a7241d0`.
- Use `022a3f2` as `C1_CONTRACT_SHA`; record `7609e3c` separately as `C1_MERGE_SHA`.
- Do not create or modify v2 registry, index, ledger, actor, or approval JSON artifacts.
- Do not invent Product or Engineering actors and do not mark C1 closed.
- Exclude the checkpoint ledger from its own `approvedArtifacts`; ledger integrity is enforced only through its chain.
- Preserve all existing v1 artifacts and keep them schema-valid.
- C0 must remain historically reproducible and closed in public validation.
- With no C1 approvals, C1 recomputation is skipped and C1 remains open without an issue.
- Use exact set equality for closed-world policies: missing and extra values both fail.
- Emit stable issue codes; tests assert codes rather than prose.
- Keep unrelated user files and changes untouched.

## File Structure

- Create `src/readiness/chains.ts`: generic chain-node normalization, graph validation, ordered-chain construction, and unique-head selection.
- Create `src/readiness/chains.test.ts`: focused unit tests for graph invariants independent of artifact parsing.
- Create `src/readiness/checkpoint-policy.test.ts`: immutable C0/C1 recipe and policy assertions, including historical byte identity.
- Modify `src/readiness/checkpoint-policy.ts`: widen recipe types, add C1 constants/recipe, and export closed-world policies.
- Modify `src/readiness/contracts.ts`: add backward-compatible chain metadata schemas and retain canonical append-only comparison.
- Modify `src/readiness/contracts.test.ts`: schema compatibility and chain-field validation tests.
- Modify `src/readiness/validator.ts`: discover all chain candidates, select heads, validate transitions, resolve per-approval registries, enforce policies, and conditionally recompute C1.
- Modify `src/scripts/validate-readiness-artifacts.test.ts`: synthetic multi-version artifact graphs and adversarial integration tests.
- Create `src/scripts/validate-readiness-artifacts-cli.test.ts`: built-CLI argument regression tests.
- Modify `src/scripts/validate-readiness-artifacts.ts`: remove the dead `--previous-ledger` option and `previousLedgerPath` plumbing.
- Modify `docs/AGENT_READINESS_STATUS.md`: record Lane B code completion while keeping C1 open and artifact/approval work deferred.

---

### Task 1: Declare C1 Recipe and Closed-World Policies

**Files:**
- Modify: `src/readiness/checkpoint-policy.ts`
- Create: `src/readiness/checkpoint-policy.test.ts`

**Interfaces:**
- Consumes: existing `CheckpointSourceBinding`, `C0_RECIPE`, and historical Git paths.
- Produces: `CheckpointId`, widened `CheckpointRecipe`, `CheckpointPolicy`, `C1_CONTRACT_SHA`, `C1_MERGE_SHA`, `C1_RECIPE`, `CHECKPOINT_RECIPES`, and `CHECKPOINT_POLICIES`.

- [ ] **Step 1: Write failing tests for immutable C1 bindings and exact policies**

Create `src/readiness/checkpoint-policy.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  C0_RECIPE,
  C1_CONTRACT_SHA,
  C1_MERGE_SHA,
  C1_RECIPE,
  CHECKPOINT_POLICIES,
  CHECKPOINT_RECIPES,
} from "./checkpoint-policy.js";

describe("checkpoint recipes", () => {
  it("records reviewed C1 content separately from merge provenance", () => {
    expect(C1_CONTRACT_SHA).toBe("022a3f229a4aeba74b9b140142fd2d3a0aa6c4be");
    expect(C1_MERGE_SHA).toBe("7609e3c14daddd4448d6bdf37c9a6a337a7241d0");
    expect(C1_RECIPE.sourceGitSha).toBe(C1_CONTRACT_SHA);
    expect(CHECKPOINT_RECIPES).toEqual({ C0: C0_RECIPE, C1: C1_RECIPE });
  });

  it("binds every C1 contract source to the reviewed commit", () => {
    expect(C1_RECIPE.contractBindings.map((b) => b.repositoryPath)).toEqual([
      "src/tool-contracts.ts",
      "src/tool-contract-integrity.ts",
      "src/tool-contract-docs.ts",
      "src/tool-catalog.ts",
    ]);
    expect(C1_RECIPE.contractBindings.every((b) => b.gitCommit === C1_CONTRACT_SHA)).toBe(true);
  });

  it("keeps reviewed and merged source bytes identical", () => {
    const paths = [
      C1_RECIPE.planBinding.repositoryPath,
      C1_RECIPE.specBinding.repositoryPath,
      ...C1_RECIPE.contractBindings.map((b) => b.repositoryPath),
    ];
    for (const path of paths) {
      const reviewed = execFileSync("git", ["show", `${C1_CONTRACT_SHA}:${path}`]);
      const merged = execFileSync("git", ["show", `${C1_MERGE_SHA}:${path}`]);
      expect(merged.equals(reviewed), path).toBe(true);
    }
  });

  it("declares exact closed-world policies", () => {
    expect(CHECKPOINT_POLICIES.C0.requiredRoles).toEqual(["Repository Maintainer", "PM"]);
    expect(CHECKPOINT_POLICIES.C1.requiredRoles).toEqual(["Product", "Engineering"]);
    expect(CHECKPOINT_POLICIES.C1.requiredContractKeys).toEqual(
      C1_RECIPE.contractBindings.map((b) => b.key),
    );
    expect(CHECKPOINT_POLICIES.C1.requiredArtifactTypes).toEqual([
      "approval-actor-registry",
      "artifact-index",
    ]);
  });
});
```

- [ ] **Step 2: Run the new test and verify exports are missing**

Run:

```bash
npx vitest run src/readiness/checkpoint-policy.test.ts
```

Expected: FAIL because the C1 constants, recipe, and policies do not exist.

- [ ] **Step 3: Widen recipe types and add the C1 recipe**

In `src/readiness/checkpoint-policy.ts`, introduce these types and constants:

```ts
export type CheckpointId = "C0" | "C1";

export interface CheckpointRecipe {
  readonly checkpoint: CheckpointId;
  readonly baselineGitSha: string;
  readonly sourceGitSha: string;
  readonly integrationGitSha?: string;
  readonly artifacts: ReadonlyArray<{ artifactId: string; artifactType: string }>;
  readonly planBinding: CheckpointSourceBinding;
  readonly specBinding: CheckpointSourceBinding;
  readonly contractBindings: ReadonlyArray<CheckpointSourceBinding>;
  readonly inputHashKeys: ReadonlyArray<string>;
  readonly inputHashBindings: ReadonlyArray<CheckpointSourceBinding>;
  readonly targetIncludesInputHashes: boolean;
}

export interface CheckpointPolicy {
  readonly requiredArtifactTypes: readonly string[];
  readonly requiredSourceKeys: readonly string[];
  readonly requiredContractKeys: readonly string[];
  readonly requiredInputHashKeys: readonly string[];
  readonly requiredRoles: readonly string[];
}

export const C1_CONTRACT_SHA = "022a3f229a4aeba74b9b140142fd2d3a0aa6c4be";
export const C1_MERGE_SHA = "7609e3c14daddd4448d6bdf37c9a6a337a7241d0";
```

Declare semantic future artifact IDs and reusable bindings first; actor identity remains deferred:

```ts
export const C1_ARTIFACTS = [
  { artifactId: "actors-c1-v2", artifactType: "approval-actor-registry" },
  { artifactId: "index-c1-v2", artifactType: "artifact-index" },
] as const;

const C1_PLAN_BINDING: CheckpointSourceBinding = {
  key: "task1-plan.md",
  repositoryPath: "docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md",
  gitCommit: C1_CONTRACT_SHA,
};
const C1_SPEC_BINDING: CheckpointSourceBinding = {
  key: "design-spec.md",
  repositoryPath: "docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md",
  gitCommit: C1_CONTRACT_SHA,
};
const C1_CONTRACT_BINDINGS: readonly CheckpointSourceBinding[] = [
  { key: "tool-contracts.ts", repositoryPath: "src/tool-contracts.ts", gitCommit: C1_CONTRACT_SHA },
  { key: "tool-contract-integrity.ts", repositoryPath: "src/tool-contract-integrity.ts", gitCommit: C1_CONTRACT_SHA },
  { key: "tool-contract-docs.ts", repositoryPath: "src/tool-contract-docs.ts", gitCommit: C1_CONTRACT_SHA },
  { key: "tool-catalog.ts", repositoryPath: "src/tool-catalog.ts", gitCommit: C1_CONTRACT_SHA },
];

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
  targetIncludesInputHashes: true,
};
```

- [ ] **Step 4: Add closed-world policies without duplicating recipe keys**

Add:

```ts
const sourceKeys = (recipe: CheckpointRecipe): readonly string[] => [
  recipe.planBinding.key,
  recipe.specBinding.key,
];
const contractKeys = (recipe: CheckpointRecipe): readonly string[] =>
  recipe.contractBindings.map((b) => b.key);
const artifactTypes = (recipe: CheckpointRecipe): readonly string[] =>
  [...new Set(recipe.artifacts.map((a) => a.artifactType))];

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
};

export const CHECKPOINT_RECIPES: Record<CheckpointId, CheckpointRecipe> = {
  C0: C0_RECIPE,
  C1: C1_RECIPE,
};
```

- [ ] **Step 5: Run policy tests and the historical C0 tests**

Run:

```bash
npx vitest run src/readiness/checkpoint-policy.test.ts src/scripts/validate-readiness-artifacts.test.ts --maxWorkers=1
```

Expected: PASS; C0 historical target tests remain green.

- [ ] **Step 6: Commit Task 1**

```bash
git add src/readiness/checkpoint-policy.ts src/readiness/checkpoint-policy.test.ts
git commit -m "feat(readiness): declare C1 recipe and policies"
```

---

### Task 2: Add Backward-Compatible Chain Metadata

**Files:**
- Modify: `src/readiness/contracts.ts`
- Modify: `src/readiness/contracts.test.ts`

**Interfaces:**
- Consumes: `Sha256`, `ArtifactIndex`, and `CheckpointApprovals`.
- Produces: exported `SnapshotPredecessor`, optional `ordinalVersion`/`predecessor` fields, and unchanged v1 parsing.

- [ ] **Step 1: Write failing schema tests**

Append to `src/readiness/contracts.test.ts`:

```ts
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
```

Update the test imports to include `ArtifactIndex` and `CheckpointApprovals`.

- [ ] **Step 2: Run the schema tests and verify they fail**

Run:

```bash
npx vitest run src/readiness/contracts.test.ts
```

Expected: FAIL because strict schemas reject `ordinalVersion` and `predecessor`.

- [ ] **Step 3: Add the shared predecessor schema and optional fields**

In `src/readiness/contracts.ts`, add:

```ts
export const SnapshotPredecessor = z.object({
  version: z.string().trim().min(1),
  sha256: Sha256,
}).strict();

const VersionedSnapshotFields = {
  ordinalVersion: z.number().int().min(1).optional(),
  predecessor: SnapshotPredecessor.nullable().optional(),
};
```

Extend both schemas:

```ts
export const CheckpointApprovals = BaseArtifactHeader.extend({
  artifactType: z.literal("checkpoint-approvals"),
  ...VersionedSnapshotFields,
  approvals: z.array(CheckpointApproval),
}).strict();

export const ArtifactIndex = BaseArtifactHeader.extend({
  artifactType: z.literal("artifact-index"),
  ...VersionedSnapshotFields,
  artifacts: z.array(/* existing row schema */),
  implementationActorIds: z.array(z.string().min(1)).min(1),
}).strict();
```

Do not add defaults: absence is how historical v1 snapshots remain distinguishable.

- [ ] **Step 4: Run contract tests**

Run:

```bash
npx vitest run src/readiness/contracts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/readiness/contracts.ts src/readiness/contracts.test.ts
git commit -m "feat(readiness): add snapshot chain metadata"
```

---

### Task 3: Build the Shared Chain Graph Engine

**Files:**
- Create: `src/readiness/chains.ts`
- Create: `src/readiness/chains.test.ts`

**Interfaces:**
- Consumes: parsed artifacts with a SHA-256 digest and either registry string versions or numeric snapshot ordinals.
- Produces: `ChainKey`, `ChainNode<T>`, `ChainIssue`, `ChainSelection<T>`, `selectChain`, `registryChainNode`, and `ordinalChainNode`.

- [ ] **Step 1: Write failing graph tests**

Create `src/readiness/chains.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { selectChain, type ChainNode } from "./chains.js";

const sha = (c: string) => c.repeat(64);
const node = (
  id: string,
  key: string | number,
  digest: string,
  predecessor: { key: string | number; sha256: string } | null,
): ChainNode<{ id: string }> => ({ id, key, sha256: digest, predecessor, value: { id } });

describe("selectChain", () => {
  it("selects the unique terminal head and returns root-to-head order", () => {
    const v1 = node("v1", 1, sha("a"), null);
    const v2 = node("v2", 2, sha("b"), { key: 1, sha256: v1.sha256 });
    const selected = selectChain("ledger", [v2, v1]);
    expect(selected.issues).toEqual([]);
    expect(selected.head?.id).toBe("v2");
    expect(selected.ordered.map((n) => n.id)).toEqual(["v1", "v2"]);
  });

  it.each([
    ["duplicate ordinal", [node("a", 2, sha("a"), null), node("b", 2, sha("b"), null)], "chain-duplicate-key"],
    ["missing predecessor", [node("v2", 2, sha("b"), { key: 1, sha256: sha("a") })], "chain-missing-predecessor"],
    ["predecessor digest mismatch", [node("v1", 1, sha("a"), null), node("v2", 2, sha("b"), { key: 1, sha256: sha("c") })], "chain-predecessor-hash-mismatch"],
    ["multiple heads", [node("v1", 1, sha("a"), null), node("v2a", 2, sha("b"), { key: 1, sha256: sha("a") }), node("v2b", 3, sha("c"), { key: 1, sha256: sha("a") })], "chain-fork"],
  ])("rejects %s", (_label, nodes, code) => {
    const selected = selectChain("ledger", nodes as ChainNode<{ id: string }>[]);
    expect(selected.issues.some((i) => i.code === code)).toBe(true);
    expect(selected.head).toBeUndefined();
  });

  it("rejects a skipped numeric ordinal", () => {
    const v1 = node("v1", 1, sha("a"), null);
    const v3 = node("v3", 3, sha("b"), { key: 1, sha256: v1.sha256 });
    expect(selectChain("index", [v1, v3]).issues.some((i) => i.code === "chain-skipped-ordinal")).toBe(true);
  });

  it("supports registry string versions through the same graph", () => {
    const v1 = node("registry-v1", "1.0", sha("a"), null);
    const v2 = node("registry-v2", "2.0", sha("b"), { key: "1.0", sha256: v1.sha256 });
    expect(selectChain("registry", [v2, v1]).head?.id).toBe("registry-v2");
  });

  it("rejects a cycle", () => {
    const a = node("a", 1, sha("a"), { key: 2, sha256: sha("b") });
    const b = node("b", 2, sha("b"), { key: 1, sha256: sha("a") });
    expect(selectChain("ledger", [a, b]).issues.some((i) => i.code === "chain-cycle")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the graph tests and verify the module is missing**

Run:

```bash
npx vitest run src/readiness/chains.test.ts
```

Expected: FAIL because `chains.ts` does not exist.

- [ ] **Step 3: Implement the chain types and validation result**

Create `src/readiness/chains.ts` with:

```ts
export type ChainKey = string | number;

export interface ChainNode<T> {
  readonly id: string;
  readonly key: ChainKey;
  readonly sha256: string;
  readonly predecessor: { key: ChainKey; sha256: string } | null;
  readonly value: T;
}

export interface ChainIssue {
  readonly code:
    | "chain-duplicate-key"
    | "chain-missing-predecessor"
    | "chain-predecessor-hash-mismatch"
    | "chain-skipped-ordinal"
    | "chain-fork"
    | "chain-cycle"
    | "chain-multiple-heads";
  readonly family: string;
  readonly nodeId?: string;
  readonly message: string;
}

export interface ChainSelection<T> {
  readonly head?: ChainNode<T>;
  readonly ordered: readonly ChainNode<T>[];
  readonly issues: readonly ChainIssue[];
}

const keyToken = (key: ChainKey): string => `${typeof key}:${String(key)}`;
```

Implement `selectChain<T>(family, nodes)` so it:

1. returns an empty selection for zero nodes;
2. rejects duplicate `keyToken` values;
3. resolves every predecessor by both key and digest;
4. requires numeric successors to equal predecessor ordinal + 1;
5. records child counts and rejects a predecessor with more than one child as `chain-fork`;
6. finds exactly one node with no child;
7. walks predecessor links from head to root with a visited set;
8. rejects cycles and disconnected nodes; and
9. returns `ordered` root-to-head only when there are no issues.

Use this complete return gate:

```ts
if (issues.length > 0) return { ordered: [], issues };
return { head, ordered: [...reversed].reverse(), issues: [] };
```

- [ ] **Step 4: Add adapters for asymmetric artifact representations**

Add adapters whose input type is structural, avoiding a dependency cycle back to validator types:

```ts
export interface ParsedChainArtifact {
  readonly data: Record<string, unknown>;
  readonly sha: string;
}

export function registryChainNode<T extends ParsedChainArtifact>(entry: T): ChainNode<T> {
  const previous = entry.data.previousRegistry as { registryVersion: string; sha256: string } | null;
  return {
    id: String(entry.data.artifactId),
    key: String(entry.data.registryVersion),
    sha256: entry.sha,
    predecessor: previous ? { key: previous.registryVersion, sha256: previous.sha256 } : null,
    value: entry,
  };
}

export type ChainNodeResult<T> =
  | { readonly ok: true; readonly node: ChainNode<T> }
  | { readonly ok: false; readonly issue: ChainIssue };

export function ordinalChainNode<T extends ParsedChainArtifact>(entry: T): ChainNodeResult<T> {
  const ordinal = typeof entry.data.ordinalVersion === "number" ? entry.data.ordinalVersion : 1;
  const previous = entry.data.predecessor as { version: string; sha256: string } | null | undefined;
  const previousOrdinal = previous ? Number(previous.version) : null;
  if (previous && (!Number.isInteger(previousOrdinal) || previousOrdinal! < 1)) {
    return {
      ok: false,
      issue: {
        code: "chain-missing-predecessor",
        family: "ordinal",
        nodeId: String(entry.data.artifactId),
        message: `invalid predecessor ordinal: ${previous.version}`,
      },
    };
  }
  return { ok: true, node: {
    id: String(entry.data.artifactId),
    key: ordinal,
    sha256: entry.sha,
    predecessor: previous ? { key: previousOrdinal!, sha256: previous.sha256 } : null,
    value: entry,
  } };
}
```

Update integration code to collect adapter issues before calling `selectChain`; pass only successful `.node` values into the graph.

- [ ] **Step 5: Run graph tests and typecheck**

Run:

```bash
npx vitest run src/readiness/chains.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/readiness/chains.ts src/readiness/chains.test.ts
git commit -m "feat(readiness): validate governance snapshot chains"
```

---

### Task 4: Integrate Chain Selection and Always-On Ledger History

**Files:**
- Modify: `src/readiness/validator.ts`
- Modify: `src/scripts/validate-readiness-artifacts.test.ts`

**Interfaces:**
- Consumes: `selectChain`, `registryChainNode`, `ordinalChainNode`, and `validateLedgerAppendOnly`.
- Produces: `GovernanceChains`, deterministic registry/index/ledger heads, chain issues mapped to `ValidationIssue`, and automatic append-only verification.

- [ ] **Step 1: Extend the synthetic fixture with versioned artifact writers**

In `src/scripts/validate-readiness-artifacts.test.ts`, add helpers after `writeArtifact`:

```ts
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
  const path = join(fixture.artifactRoot, "approval-actor-registry-v2.json");
  writeArtifact(fixture.artifactRoot, "approval-actor-registry-v2.json", registry);
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
  const path = join(fixture.artifactRoot, "checkpoint-approvals-v2.json");
  writeArtifact(fixture.artifactRoot, "checkpoint-approvals-v2.json", ledger);
  return { path, data: ledger };
}
```

The v2 actors in tests are fixtures only; no tracked artifact is created.

- [ ] **Step 2: Add failing integration tests for chain selection**

Add a new `describe("governance snapshot chains", ...)` covering:

```ts
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
  ["mutation", (approvals: any[]) => [{ ...approvals[0], rationale: "rewritten" }, ...approvals.slice(1)], "ledger-approval-mutated"],
  ["reordering", (approvals: unknown[]) => [...approvals].reverse(), "ledger-approval-reordered"],
])("rejects predecessor approval %s", (_label, mutate, code) => {
  fixture = buildValidGraph({ withApprovals: true });
  const v1 = readJson<{ approvals: unknown[] }>(fixture.ledgerPath!);
  writeLedgerV2(fixture, mutate(v1.approvals));
  const result = validate(fixture);
  expect(result.issues.some((i) => i.code === code)).toBe(true);
});
```

Add a local `validate(fixture)` helper that passes `artifactRoot`, `repoRoot`, `gitSourceResolver`, and `mode: "public"` exactly as existing tests do.

- [ ] **Step 3: Run the new integration tests and verify current `.find()` behavior fails them**

Run:

```bash
npx vitest run src/scripts/validate-readiness-artifacts.test.ts --maxWorkers=1
```

Expected: FAIL because enumeration order still selects a single registry/index/ledger and append-only validation is not wired.

- [ ] **Step 4: Discover and validate all three chains before index validation**

In `src/readiness/validator.ts`, replace the mutable `.find()`/last-assignment selection with a helper:

```ts
interface GovernanceChains {
  registries: readonly ParsedArtifact[];
  indexes: readonly ParsedArtifact[];
  ledgers: readonly ParsedArtifact[];
  registryHead?: ParsedArtifact;
  indexHead?: ParsedArtifact;
  ledgerHead?: ParsedArtifact;
  registryByVersion: ReadonlyMap<string, ParsedArtifact>;
  orderedLedgers: readonly ParsedArtifact[];
}
```

Import chain functions and implement `resolveGovernanceChains(artifacts, issues)`:

```ts
const registries = [...artifacts.values()].filter((a) => a.type === "approval-actor-registry");
const indexes = [...artifacts.values()].filter((a) => a.type === "artifact-index");
const ledgers = [...artifacts.values()].filter((a) => a.type === "checkpoint-approvals");

const registrySelection = selectChain("registry", registries.map(registryChainNode));
const indexAdapted = indexes.map(ordinalChainNode);
const ledgerAdapted = ledgers.map(ordinalChainNode);
for (const result of [...indexAdapted, ...ledgerAdapted]) {
  if (!result.ok) issues.push({ ...result.issue, artifactId: result.issue.nodeId });
}
const indexSelection = selectChain("index", indexAdapted.filter((r) => r.ok).map((r) => r.node));
const ledgerSelection = selectChain("ledger", ledgerAdapted.filter((r) => r.ok).map((r) => r.node));
```

Map every `ChainIssue` directly to a `ValidationIssue`, retaining `code`, `nodeId` as `artifactId`, and `message`. If any family has issues, do not select a head for that family.

Construct `registryByVersion` from every validated registry node, not only the head. Use `indexSelection.head?.value` and `ledgerSelection.head?.value` for current-state validation.

- [ ] **Step 5: Wire append-only verification across every ledger edge**

First tighten `validateLedgerAppendOnly` in `src/readiness/contracts.ts` so predecessor approvals must remain an unchanged prefix:

```ts
export function validateLedgerAppendOnly(
  current: { approvals: z.infer<typeof CheckpointApproval>[] },
  previous: { approvals: z.infer<typeof CheckpointApproval>[] },
): string[] {
  const issues: string[] = [];
  for (let i = 0; i < previous.approvals.length; i++) {
    const prior = previous.approvals[i]!;
    const next = current.approvals[i];
    if (!next) {
      issues.push(`prior approval deleted: ${prior.approvalId}`);
    } else if (next.approvalId !== prior.approvalId) {
      const moved = current.approvals.some((a) => a.approvalId === prior.approvalId);
      issues.push(`${moved ? "prior approval reordered" : "prior approval deleted"}: ${prior.approvalId}`);
    } else if (canonicalJsonStringify(next) !== canonicalJsonStringify(prior)) {
      issues.push(`prior approval mutated: ${prior.approvalId}`);
    }
  }
  return issues;
}
```

Then iterate adjacent root-to-head ledger nodes:

```ts
for (let i = 1; i < ledgerSelection.ordered.length; i++) {
  const previous = CheckpointApprovals.parse(ledgerSelection.ordered[i - 1]!.value.data);
  const current = CheckpointApprovals.parse(ledgerSelection.ordered[i]!.value.data);
  for (const message of validateLedgerAppendOnly(current, previous)) {
    const deleted = message.startsWith("prior approval deleted:");
    const reordered = message.startsWith("prior approval reordered:");
    issues.push({
      code: deleted ? "ledger-approval-deleted" : reordered ? "ledger-approval-reordered" : "ledger-approval-mutated",
      artifactId: String(current.artifactId),
      message,
    });
  }
}
```

Do not read a ledger from an external path. The selected chain is the authority.

- [ ] **Step 6: Update index exclusions for versioned governance snapshots**

The head index still excludes all artifact-index and checkpoint-approvals files. Ensure the “every artifact is indexed” loop excludes every artifact whose type is one of those two, not only selected heads. Registry snapshots remain indexable evidence and every registry version present must appear in the head index once v2 artifacts are created.

- [ ] **Step 7: Run chain integration tests**

Run:

```bash
npx vitest run src/readiness/chains.test.ts src/scripts/validate-readiness-artifacts.test.ts --maxWorkers=1
```

Expected: PASS.

- [ ] **Step 8: Commit Task 4**

```bash
git add src/readiness/validator.ts src/scripts/validate-readiness-artifacts.test.ts
git commit -m "feat(readiness): enforce governance chains"
```

---

### Task 5: Resolve Registries Per Approval and Enforce Closed-World Policies

**Files:**
- Modify: `src/readiness/validator.ts`
- Modify: `src/scripts/validate-readiness-artifacts.test.ts`

**Interfaces:**
- Consumes: `GovernanceChains.registryByVersion`, `CHECKPOINT_POLICIES`, `CHECKPOINT_RECIPES`, and selected ledger head.
- Produces: `resolveApprovalRegistry`, `verifyCheckpointPolicy`, conditional checkpoint recomputation, and policy-specific issue codes.

- [ ] **Step 1: Add failing mixed-registry and closed-world tests**

Add tests that create a valid v2 registry and a v2 ledger containing canonical v1 approvals:

```ts
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
```

Implement `addValidSyntheticC1Approvals` as a test-only fixture builder that writes v2 registry/index/ledger snapshots, registers every C1 binding at both `C1_CONTRACT_SHA` and `C1_MERGE_SHA`, and creates distinct Product and Engineering approvals against the computed target. It returns `{ registryPath, indexPath, ledgerPath }` so mutation tests edit one property without rebuilding the graph. Add these mutations:

```ts
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
```

The helper creates files only below the synthetic temporary root; the tracked repository receives no v2 artifact files.

- [ ] **Step 2: Run tests and verify mixed registry/policy/activation failures**

Run:

```bash
npx vitest run src/scripts/validate-readiness-artifacts.test.ts --maxWorkers=1
```

Expected: FAIL because approvals still use only the selected registry head, policies are not explicit, and all recipes recompute eagerly.

- [ ] **Step 3: Resolve each approval's recorded registry**

Change `validateApprovalsAndCheckpoint` to accept `registryByVersion` rather than one registry. Add:

```ts
function resolveApprovalRegistry(
  approval: z.infer<typeof CheckpointApproval>,
  registryByVersion: ReadonlyMap<string, ParsedArtifact>,
  issues: ValidationIssue[],
  note: (approvalId: string, code: string) => void,
): z.infer<typeof ApprovalActorRegistry> | undefined {
  const entry = registryByVersion.get(approval.actorRegistryVersion);
  if (!entry) {
    issues.push({
      code: "registry-version-not-found",
      artifactId: approval.approvalId,
      message: `registry version ${approval.actorRegistryVersion} not found`,
    });
    note(approval.approvalId, "registry-version-not-found");
    return undefined;
  }
  if (entry.sha !== approval.actorRegistrySha256) {
    issues.push({
      code: "registry-hash-mismatch",
      artifactId: approval.approvalId,
      message: `registry ${approval.actorRegistryVersion} digest does not match recorded digest`,
    });
    note(approval.approvalId, "registry-hash-mismatch");
    return undefined;
  }
  return ApprovalActorRegistry.parse(entry.data);
}
```

Build the actor map from this resolved registry for every approval. Keep implementer-self-approval independent of registry resolution so all applicable errors are reported.

- [ ] **Step 4: Add exact set comparison and policy issue codes**

Add a reusable helper:

```ts
function comparePolicySet(
  approvalId: string,
  category: "artifact-type" | "source-key" | "contract-key" | "input-hash-key" | "role",
  expected: readonly string[],
  actual: readonly string[],
  issues: ValidationIssue[],
  note: (approvalId: string, code: string) => void,
): void {
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  if (expectedSet.size !== expected.length) {
    const code = `policy-duplicate-${category}`;
    issues.push({ code, artifactId: approvalId, message: `policy declares duplicate ${category}` });
    note(approvalId, code);
  }
  if (actualSet.size !== actual.length) {
    const code = `policy-duplicate-${category}`;
    issues.push({ code, artifactId: approvalId, message: `approval contains duplicate ${category}` });
    note(approvalId, code);
  }
  for (const value of expectedSet) {
    if (!actualSet.has(value)) {
      const code = `policy-missing-${category}`;
      issues.push({ code, artifactId: approvalId, message: `missing ${category}: ${value}` });
      note(approvalId, code);
    }
  }
  for (const value of actualSet) {
    if (!expectedSet.has(value)) {
      const code = `policy-unexpected-${category}`;
      issues.push({ code, artifactId: approvalId, message: `unexpected ${category}: ${value}` });
      note(approvalId, code);
    }
  }
}
```

For each approval with a known C0/C1 policy, compare:

- `approvedArtifacts` resolved to their parsed artifact types against `requiredArtifactTypes`;
- `[recipe.planBinding.key, recipe.specBinding.key]` against `requiredSourceKeys`;
- `Object.keys(approval.contractHashes)` against `requiredContractKeys`;
- `recipe.inputHashKeys` against `requiredInputHashKeys`; and
- checkpoint approval roles as a group against `requiredRoles` after the per-approval loop.

Unknown approved artifact IDs must continue to emit `approved-artifact-unknown`; do not convert them into an empty type that could mask the error.

- [ ] **Step 5: Recompute only active checkpoint recipes**

Before `computeCanonicalTargets`, derive:

```ts
const activeCheckpoints = new Set(approvals.map((approval) => approval.checkpoint));
```

Change `computeCanonicalTargets` to accept `activeCheckpoints` and skip recipe entries not present in that set:

```ts
for (const [cp, recipe] of Object.entries(CHECKPOINT_RECIPES)) {
  recipes[cp] = recipe;
  if (!activeCheckpoints.has(cp)) continue;
  // existing fail-closed resolution and target construction
}
```

Before hashing an active target, verify integration provenance for recipes that declare `integrationGitSha`:

```ts
const allBindings = [recipe.planBinding, recipe.specBinding, ...recipe.contractBindings];
if (recipe.integrationGitSha) {
  for (const binding of allBindings) {
    const reviewed = resolver.resolve(binding.gitCommit, binding.repositoryPath);
    const merged = resolver.resolve(recipe.integrationGitSha, binding.repositoryPath);
    if (sha256Hex(reviewed) !== sha256Hex(merged)) {
      throw new CheckpointRecomputeError(
        "checkpoint-provenance-mismatch",
        `${binding.repositoryPath} differs between ${binding.gitCommit} and ${recipe.integrationGitSha}`,
      );
    }
  }
}
```

Add the typed failure carrier:

```ts
class CheckpointRecomputeError extends Error {
  constructor(readonly issueCode: "checkpoint-provenance-mismatch", message: string) {
    super(message);
  }
}
```

Change `recomputeFailures` to store `{ code, message }`. A `CheckpointRecomputeError` keeps its specific code; all resolver/parsing exceptions map to `checkpoint-recompute-failed`.

When constructing a canonical target, resolve the registry entry matching the approval's recorded version instead of a global registry. Because all valid approvals for one checkpoint must bind the same target, first reject divergent registry version/digest pairs for that checkpoint, then pass the unique pair into recomputation.

- [ ] **Step 6: Keep closure role checks policy-driven**

Remove the local `CHECKPOINT_ROLES` table. For C0/C1 use `CHECKPOINT_POLICIES[cp].requiredRoles`; keep the existing role table only for C2–C5 in a `FUTURE_CHECKPOINT_ROLES` constant. Reject extra checkpoint roles as well as missing roles for policy-backed checkpoints. Distinct actors remain mandatory.

- [ ] **Step 7: Run the full readiness test set**

Run:

```bash
npx vitest run src/readiness/ src/scripts/validate-readiness-artifacts.test.ts --maxWorkers=1
npm run typecheck:contracts
```

Expected: PASS.

- [ ] **Step 8: Commit Task 5**

```bash
git add src/readiness/validator.ts src/scripts/validate-readiness-artifacts.test.ts
git commit -m "feat(readiness): enforce closed-world checkpoint policy"
```

---

### Task 6: Remove Dead CLI Prior-Ledger Plumbing

**Files:**
- Modify: `src/readiness/validator.ts`
- Modify: `src/scripts/validate-readiness-artifacts.ts`
- Create: `src/scripts/validate-readiness-artifacts-cli.test.ts`

**Interfaces:**
- Consumes: automatic ledger-chain discovery from Task 4.
- Produces: `ValidateReadinessOptions` without `previousLedgerPath` and a CLI that rejects the removed flag.

- [ ] **Step 1: Add a CLI regression test for the removed option**

Create `src/scripts/validate-readiness-artifacts-cli.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

describe("validate-readiness-artifacts CLI", () => {
  it("rejects the removed --previous-ledger option", () => {
    expect(() => execFileSync(process.execPath, [
      resolve("dist/scripts/validate-readiness-artifacts.js"),
      "--mode", "public",
      "--previous-ledger", "old.json",
    ], { cwd: process.cwd(), encoding: "utf-8", stdio: "pipe" })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test and verify the old option is accepted**

Run:

```bash
npm run build
npx vitest run src/scripts/validate-readiness-artifacts-cli.test.ts
```

Expected: FAIL because the CLI still declares `--previous-ledger`.

- [ ] **Step 3: Remove the option completely**

Delete from `ValidateReadinessOptions`:

```ts
previousLedgerPath?: string;
```

Delete from the CLI usage text, `parseArgs` options, and validator call:

```ts
"previous-ledger": { type: "string" },
previousLedgerPath: args["previous-ledger"] ? resolve(args["previous-ledger"]) : undefined,
```

Do not retain a deprecated alias: accepting an external predecessor path would reintroduce two competing authorities.

- [ ] **Step 4: Run CLI and readiness tests**

Run:

```bash
npm run build
npx vitest run src/scripts/validate-readiness-artifacts-cli.test.ts src/scripts/validate-readiness-artifacts.test.ts --maxWorkers=1
```

Expected: PASS.

- [ ] **Step 5: Commit Task 6**

```bash
git add src/readiness/validator.ts src/scripts/validate-readiness-artifacts.ts src/scripts/validate-readiness-artifacts-cli.test.ts
git commit -m "refactor(readiness): remove prior-ledger CLI override"
```

---

### Task 7: Final Status, Adversarial Gate, and Verification

**Files:**
- Modify: `docs/AGENT_READINESS_STATUS.md`
- Verify: all files changed by Tasks 1–6

**Interfaces:**
- Consumes: completed code-only Lane B infrastructure.
- Produces: honest status documentation and a clean verification record; no governance artifacts or approvals.

- [ ] **Step 1: Update status without claiming C1 closure**

Add a Lane B note to `docs/AGENT_READINESS_STATUS.md`:

```markdown
### Lane B governance infrastructure

The code-only governance pass is complete: C0/C1 closed-world policies, the Git-bound C1 recipe, deterministic registry/index/ledger chains, per-approval registry resolution, and automatic append-only ledger validation are implemented. No v2 governance artifacts or C1 approvals were created. C1 remains open pending authorized Product and Engineering actor assignments and independent approvals.
```

Keep the checkpoint table at `C1: open`/`in progress`; do not mark it closed.

- [ ] **Step 2: Run formatting and static checks**

Run:

```bash
git diff --check origin/main...HEAD
npm run build
npm run typecheck:contracts
```

Expected: all commands exit 0.

- [ ] **Step 3: Run targeted readiness tests serially**

Run:

```bash
npx vitest run src/readiness/ src/scripts/validate-readiness-artifacts.test.ts src/scripts/validate-readiness-artifacts-cli.test.ts --maxWorkers=1
```

Expected: PASS with no skipped governance-chain tests.

- [ ] **Step 4: Run public readiness validation**

Run:

```bash
npm run validate-readiness-artifacts -- --mode public
```

Expected:

```text
✓ C0: closed
○ C1: open
All checks passed.
```

- [ ] **Step 5: Run private readiness validation**

Run:

```bash
npm run validate-readiness-artifacts -- --mode private --corpus-path corpus/entries.json
```

Expected: exit 0 with C0 closed and C1 open. If the private corpus is intentionally unavailable in this checkout, record the exact missing prerequisite and run this gate in the authorized private-corpus environment before merge; do not weaken the validator or fabricate a corpus.

- [ ] **Step 6: Run corpus, reference, and doctor gates**

Run:

```bash
npm run validate-corpus
npm run validate-references
npx tsc && node dist/scripts/doctor.js
```

Expected: validation commands exit 0; doctor reports zero failures.

- [ ] **Step 7: Run the complete credential-scrubbed offline suite**

Run:

```bash
node scripts/run-no-egress.mjs -- npm test -- --maxWorkers=1
```

Expected: exit 0. Live-provider tests may skip only through their documented gates; no provider credential may appear in the child environment.

- [ ] **Step 8: Re-run every required exploit as a named test**

Run:

```bash
npx vitest run src/readiness/chains.test.ts src/scripts/validate-readiness-artifacts.test.ts --maxWorkers=1 -t "duplicate|skipped|cycle|fork|missing predecessor|predecessor digest|deleted|mutated|reordering|older approval|extra C0 contract|missing C1 contract|provenance|does not resolve C1"
```

Expected: all named adversarial tests PASS.

- [ ] **Step 9: Confirm scope containment**

Run:

```bash
git diff --name-only origin/main...HEAD
find quality-contracts/agent-readiness -maxdepth 1 -type f -name '*v2*.json' -print
```

Expected: only the source, test, design, plan, and status files named in this plan are changed; the `find` command prints nothing newly created by this branch.

- [ ] **Step 10: Commit Task 7**

```bash
git add docs/AGENT_READINESS_STATUS.md
git commit -m "docs: record C1 governance infrastructure status"
```

- [ ] **Step 11: Request final code review**

Review the full range:

```bash
BASE=$(git merge-base origin/main HEAD)
git diff --stat "$BASE"...HEAD
git diff "$BASE"...HEAD -- src/readiness src/scripts/validate-readiness-artifacts.ts src/scripts/validate-readiness-artifacts.test.ts
```

Acceptance criteria: zero Critical and zero Important findings; C0 remains closed; C1 remains open; no v2 artifacts or approvals exist.

---

## Deferred Follow-Up

After authorized humans choose Product and Engineering actors, a separate artifact plan must:

1. create `actors-c1-v2` with the approved identities;
2. create `index-c1-v2` and its predecessor chain;
3. create ledger v2 as an append-only successor to v1;
4. produce independent Product and Engineering C1 approvals against the same recomputed target; and
5. close C1 only after the validator reports a unique valid head for every chain.

That follow-up must use the interfaces and semantic artifact IDs declared here and must not change the closed-world policies to fit the artifacts.
