# C1 Checkpoint Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auditable sole-maintainer bootstrap mode, then create the v2 governance artifacts and two role-specific human approvals that close C1 without inventing a second identity.

**Architecture:** Registry snapshots declare the actor-separation mode that applies to approvals pinned to that exact registry version. Legacy and normal registries require distinct actors; a `sole-maintainer-bootstrap` registry permits its named human owner to approve multiple required roles while still forbidding implementation actors. After that source increment is reviewed, untracked deterministic Node programs use the built repository canonicalization functions to prepare registry/index artifacts and a closure manifest; ledger creation pauses until the sole maintainer explicitly authorizes both role records against that immutable manifest.

**Tech Stack:** TypeScript, Zod 4, Vitest, Node.js `crypto`/`child_process`, Git-bound source resolution, canonical JSON SHA-256, git-native review artifacts.

## Global Constraints

- Branch `feat/c1-closure` starts from `11864827f05e415c07d68f595f95f01f3ee801e2`.
- Use one truthful human identity: `repo-maintainer-1`; do not create `engineering-1` or any second identity for the same person.
- `repo-maintainer-1` receives `Repository Maintainer`, `Product`, and `Engineering`; `implementationActorIds` remains exactly `["impl-agent-1"]`.
- Registry v1 remains byte-for-byte unchanged and defaults to separation of duties when governance fields are absent.
- Bootstrap authority is resolved from each approval's pinned registry version and digest, never from registry enumeration order or the current head.
- Bootstrap requires a named human owner authorized for every claimed role and absent from `implementationActorIds`.
- The same actor may satisfy multiple required roles only when every contributing approval pins the same valid `sole-maintainer-bootstrap` registry naming that actor.
- `C1_CONTRACT_SHA` remains `022a3f229a4aeba74b9b140142fd2d3a0aa6c4be`; `C1_MERGE_SHA` remains `7609e3c14daddd4448d6bdf37c9a6a337a7241d0`.
- C1 approvals bind exactly `actors-c1-v2` and `index-c1-v2`; the ledger is excluded from its own target.
- Ledger v2 must preserve the complete v1 approval array as an unchanged prefix.
- Automation may calculate hashes and construct artifacts but must not fabricate human approval. Stop before ledger creation until the user authorizes both role records against the printed manifest.
- No Lane C gold-label work, Lane D MCP migration, permanent artifact generator, unrelated refactor, or C0 mutation.
- Review each task commit and write its task review artifact before starting the next commit; complete a holistic branch review before push.

---

## File Map

- Modify `src/readiness/contracts.ts`: add backward-compatible registry governance fields and semantic mode/owner validation.
- Modify `src/readiness/contracts.test.ts`: prove legacy compatibility and reject malformed bootstrap declarations.
- Modify `src/readiness/validator.ts`: retain each approval's resolved registry and enforce registry-pinned actor cardinality during closure.
- Modify `src/scripts/validate-readiness-artifacts.test.ts`: add bootstrap success and adversarial integration coverage.
- Create `quality-contracts/agent-readiness/approval-actor-registry-v2.json`: declare registry v2 and the sole-maintainer owner.
- Create `quality-contracts/agent-readiness/artifact-index-v2.json`: chain index v2 and index registry v2.
- Create `quality-contracts/agent-readiness/checkpoint-approvals-v2.json`: preserve C0 prefix and append the two authorized C1 role records.
- Modify `docs/AGENT_READINESS_STATUS.md`: record C1 closure only after final validation succeeds.
- Temporary, untracked `/tmp/c1-prepare.mjs`: create registry/index and compute the manifest using built repository functions.
- Temporary, untracked `/tmp/c1-finalize.mjs`: create ledger v2 only from a user-authorized manifest.
- Temporary, untracked `/tmp/c1-closure-manifest.json` and `/tmp/c1-authorizations.json`: execution evidence; never add them to Git.

---

### Task 1: Add Backward-Compatible Registry Governance Modes

**Files:**
- Modify: `src/readiness/contracts.ts:333-353,489-529`
- Modify: `src/readiness/contracts.test.ts:555-603,765-820`

**Interfaces:**
- Produces: `GovernanceMode`, optional `ApprovalActorRegistry.governanceMode`, optional `ApprovalActorRegistry.bootstrapOwnerActorId`, and semantic `validateRegistry()` errors.
- Preserves: every existing registry JSON parses unchanged and behaves as `separation-of-duties`.

- [ ] **Step 1: Add failing schema-compatibility tests**

Add these cases inside `describe("ApprovalActorRegistry", ...)` in `src/readiness/contracts.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the schema tests and verify they fail**

Run:

```bash
npx vitest run src/readiness/contracts.test.ts
```

Expected: FAIL because strict `ApprovalActorRegistry` rejects `governanceMode` and `bootstrapOwnerActorId`.

- [ ] **Step 3: Add the backward-compatible schema fields**

Immediately before `ApprovalActorRegistry`, add:

```ts
export const GovernanceMode = z.enum([
  "separation-of-duties",
  "sole-maintainer-bootstrap",
]);
```

Add these fields after `previousRegistry` in `ApprovalActorRegistry`:

```ts
  governanceMode: GovernanceMode.optional(),
  bootstrapOwnerActorId: z.string().min(1).optional(),
```

Do not default `governanceMode` in the schema; field absence must remain observable so v1 bytes and parsed shape stay backward compatible.

- [ ] **Step 4: Add failing semantic validation tests**

Add these cases inside `describe("validateRegistry", ...)`:

```ts
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
```

- [ ] **Step 5: Implement semantic governance validation**

In `validateRegistry()`, after the actor loop, add:

```ts
  const governanceMode = registry.governanceMode ?? "separation-of-duties";
  const bootstrapOwnerActorId = registry.bootstrapOwnerActorId;

  if (governanceMode === "sole-maintainer-bootstrap") {
    if (!bootstrapOwnerActorId) {
      issues.push("sole-maintainer-bootstrap requires bootstrapOwnerActorId");
    } else {
      const owner = registry.actors.find(
        (actor) => actor.actorId === bootstrapOwnerActorId,
      );
      if (!owner) {
        issues.push(`bootstrap owner ${bootstrapOwnerActorId} not found in registry`);
      } else if (owner.actorKind !== "human") {
        issues.push(`bootstrap owner ${bootstrapOwnerActorId} must be human`);
      }
    }
  } else if (bootstrapOwnerActorId !== undefined) {
    issues.push("bootstrapOwnerActorId is only valid in sole-maintainer-bootstrap mode");
  }
```

- [ ] **Step 6: Run focused tests and typechecking**

Run:

```bash
npx vitest run src/readiness/contracts.test.ts
npm run typecheck:contracts
```

Expected: all contract tests pass and both TypeScript checks exit 0.

- [ ] **Step 7: Commit and review Task 1**

```bash
git add src/readiness/contracts.ts src/readiness/contracts.test.ts
git commit -m "feat(readiness): declare registry governance modes"
```

Run the project task-level review against `HEAD^..HEAD`. If approved, write:

```bash
.zcode/scripts/write-review-artifact \
  --type task --result approved --reviewer agent \
  --base-sha "$(git rev-parse HEAD^)" --head-sha "$(git rev-parse HEAD)" \
  --branch feat/c1-closure
```

---

### Task 2: Enforce Registry-Pinned Bootstrap Cardinality

**Files:**
- Modify: `src/readiness/validator.ts:687-909`
- Modify: `src/scripts/validate-readiness-artifacts.test.ts:480-627,1354-1460`

**Interfaces:**
- Consumes: optional `governanceMode` and `bootstrapOwnerActorId` from the registry resolved for each approval.
- Produces: `checkpoint-actor-separation-violation` when contributing approvals reuse an actor without a valid pinned bootstrap declaration.
- Preserves: C0 closure and every existing distinct-actor C1 test.

- [ ] **Step 1: Extend the synthetic C1 fixture to support governance modes**

Change `addValidSyntheticC1Approvals` to accept:

```ts
type SyntheticC1Options = {
  governanceMode?: "separation-of-duties" | "sole-maintainer-bootstrap";
  bootstrapOwnerActorId?: string;
  sharedApprovalActorId?: string;
  bootstrapOwnerKind?: "human" | "agent";
};
```

When `sharedApprovalActorId` is present, add only that actor for Product and Engineering and use it in both C1 approvals. When `governanceMode` or `bootstrapOwnerActorId` is present, add the corresponding fields to registry v2. Keep the current no-options behavior unchanged so the existing distinct-actor success test remains a regression test.

- [ ] **Step 2: Add failing integration tests**

Add these tests to `describe("per-approval registry resolution and closed-world policy", ...)`:

```ts
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
```

Implement `writeRegistryAndIndexV3` beside the existing v2 fixture helpers. It must create registry v3 with `governanceMode: "separation-of-duties"`, predecessor `2.0` plus the exact registry-v2 digest, and then create index v3 with ordinal `3`, predecessor index ordinal `2` plus its exact digest, and an additional row indexing registry v3. This keeps both chains and the current-head inventory valid; do not create an unindexed registry fixture.

- [ ] **Step 3: Run the integration tests and verify failure**

Run:

```bash
npx vitest run src/scripts/validate-readiness-artifacts.test.ts
```

Expected: bootstrap success fails to close C1, and same-actor separation mode does not yet emit `checkpoint-actor-separation-violation`.

- [ ] **Step 4: Retain each approval's resolved registry**

After `approvalIssueCodes`, add:

```ts
  const resolvedRegistryByApprovalId = new Map<
    string,
    z.infer<typeof ApprovalActorRegistry>
  >();
```

Immediately after `resolveApprovalRegistry(...)`, add:

```ts
    if (resolvedRegistry) {
      resolvedRegistryByApprovalId.set(iid, resolvedRegistry);
    }
```

- [ ] **Step 5: Add a registry-pinned cardinality helper**

Add above `validateApprovalsAndCheckpoint`:

```ts
function approvalsSatisfyActorCardinality(
  approvals: readonly z.infer<typeof CheckpointApproval>[],
  resolvedRegistryByApprovalId: ReadonlyMap<
    string,
    z.infer<typeof ApprovalActorRegistry>
  >,
  implementationActorIds: ReadonlySet<string>,
): boolean {
  if (approvals.length === 0) return false;

  const actorIds = new Set(approvals.map((approval) => approval.actorId));
  if (actorIds.size === approvals.length) return true;
  if (actorIds.size !== 1) return false;

  const [sharedActorId] = actorIds;
  if (!sharedActorId || implementationActorIds.has(sharedActorId)) return false;

  return approvals.every((approval) => {
    const registry = resolvedRegistryByApprovalId.get(approval.approvalId);
    if (!registry) return false;
    if (registry.governanceMode !== "sole-maintainer-bootstrap") return false;
    if (registry.bootstrapOwnerActorId !== sharedActorId) return false;

    const owner = registry.actors.find(
      (actor) => actor.actorId === sharedActorId,
    );
    return (
      owner?.actorKind === "human" &&
      approval.actorKind === "human" &&
      owner.roles.includes(approval.role)
    );
  });
}
```

This deliberately checks every approval's resolved registry. Do not substitute `registryHead`.

- [ ] **Step 6: Replace the unconditional distinct-actor closure check**

Replace:

```ts
    const distinctActors =
      cleanActors.size === cpApprovals.length && cpApprovals.length > 0;

    if (allRolesPresent && distinctActors) {
      checkpointStatus[cp] = "closed";
    }
```

with:

```ts
    const actorCardinalityValid = approvalsSatisfyActorCardinality(
      cpApprovals,
      resolvedRegistryByApprovalId,
      implementationActorIds,
    );

    if (allRolesPresent && cpApprovals.length > 0 && !actorCardinalityValid) {
      const code = "checkpoint-actor-separation-violation";
      issues.push({
        code,
        artifactId: cp,
        message: `checkpoint ${cp} approvals do not satisfy the actor-separation mode of their pinned registries`,
      });
      for (const approval of cpApprovals) {
        noteApprovalIssue(approval.approvalId, code);
      }
    }

    if (allRolesPresent && actorCardinalityValid) {
      checkpointStatus[cp] = "closed";
    }
```

Remove the now-unused `cleanActors` declaration. Keep exact role-set enforcement unchanged.

- [ ] **Step 7: Run targeted and regression verification**

Run:

```bash
npx vitest run \
  src/readiness/contracts.test.ts \
  src/readiness/chains.test.ts \
  src/readiness/checkpoint-policy.test.ts \
  src/scripts/validate-readiness-artifacts.test.ts \
  src/scripts/validate-readiness-artifacts-cli.test.ts
npm run typecheck:contracts
npm run build
npm run validate-readiness-artifacts -- --mode public
```

Expected: all focused tests pass; build and typechecks exit 0; public validation reports zero issues with C0 closed and C1 open.

- [ ] **Step 8: Commit and review Task 2**

```bash
git add src/readiness/validator.ts src/scripts/validate-readiness-artifacts.test.ts
git commit -m "feat(readiness): support sole-maintainer checkpoint bootstrap"
```

Run the task-level review against `HEAD^..HEAD`. The review must explicitly trace cardinality from each approval through `actorRegistryVersion`/`actorRegistrySha256` to `resolvedRegistryByApprovalId`. If approved, write the task review artifact.

Record the reviewed policy commit for artifact provenance:

```bash
POLICY_SHA=$(git rev-parse HEAD)
test "$(printf '%s' "$POLICY_SHA" | wc -c | tr -d ' ')" = "40"
printf 'POLICY_SHA=%s\n' "$POLICY_SHA"
```

---

### Task 3: Prepare Registry v2, Index v2, and the Closure Manifest

**Files:**
- Create: `quality-contracts/agent-readiness/approval-actor-registry-v2.json`
- Create: `quality-contracts/agent-readiness/artifact-index-v2.json`
- Create temporarily: `/tmp/c1-prepare.mjs`
- Create temporarily: `/tmp/c1-closure-manifest.json`

**Interfaces:**
- Consumes: reviewed Task 2 `HEAD`, v1 artifact bytes, `C1_RECIPE`, `buildCheckpointTarget`, and `computeCheckpointTargetSha256`.
- Produces: finalized registry/index bytes and an immutable manifest for human review.
- Does not produce: any C1 approval or v2 ledger.

- [ ] **Step 1: Assert the artifact preconditions**

Run:

```bash
test "$(git merge-base origin/main HEAD)" = "11864827f05e415c07d68f595f95f01f3ee801e2"
test ! -e quality-contracts/agent-readiness/approval-actor-registry-v2.json
test ! -e quality-contracts/agent-readiness/artifact-index-v2.json
test ! -e quality-contracts/agent-readiness/checkpoint-approvals-v2.json
git diff --quiet
git diff --cached --quiet
```

Expected: every command exits 0. Untracked `node_modules` is allowed but must never be staged.

- [ ] **Step 2: Create the complete untracked preparation program**

Create `/tmp/c1-prepare.mjs` with this exact program using `apply_patch`:

```js
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const contractsModule = await import(
  pathToFileURL(resolve(root, "dist/readiness/contracts.js")).href
);
const policyModule = await import(
  pathToFileURL(resolve(root, "dist/readiness/checkpoint-policy.js")).href
);
const {
  buildCheckpointTarget,
  computeCheckpointTargetSha256,
} = contractsModule;
const {
  C1_CONTRACT_SHA,
  C1_MERGE_SHA,
  C1_RECIPE,
} = policyModule;

const artifactRoot = resolve(root, "quality-contracts/agent-readiness");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fileBytes = (name) => readFileSync(resolve(artifactRoot, name));
const fileSha = (name) => sha(fileBytes(name));
const readJson = (name) => JSON.parse(fileBytes(name).toString("utf8"));
const writeJson = (name, value) =>
  writeFileSync(resolve(artifactRoot, name), JSON.stringify(value, null, 2) + "\n");
const gitBytes = (commit, path) =>
  execFileSync("git", ["show", `${commit}:${path}`], { cwd: root });

const policySha = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const registryV2Path = resolve(artifactRoot, "approval-actor-registry-v2.json");
const createdAt = existsSync(registryV2Path)
  ? JSON.parse(readFileSync(registryV2Path, "utf8")).createdAt
  : new Date().toISOString();

const v1Registry = readJson("approval-actor-registry-v1.json");
const registryV2 = {
  ...v1Registry,
  artifactId: "actors-c1-v2",
  createdAt,
  sourceGitSha: policySha,
  inputHashes: {},
  registryVersion: "2.0",
  previousRegistry: {
    registryVersion: "1.0",
    sha256: fileSha("approval-actor-registry-v1.json"),
  },
  governanceMode: "sole-maintainer-bootstrap",
  bootstrapOwnerActorId: "repo-maintainer-1",
  actors: v1Registry.actors.map((actor) =>
    actor.actorId === "repo-maintainer-1"
      ? {
          ...actor,
          roles: ["Repository Maintainer", "Product", "Engineering"],
        }
      : actor,
  ),
};
writeJson("approval-actor-registry-v2.json", registryV2);
const registryV2Sha = fileSha("approval-actor-registry-v2.json");

const v1Index = readJson("artifact-index-v1.json");
const indexV2 = {
  ...v1Index,
  artifactId: "index-c1-v2",
  createdAt,
  sourceGitSha: policySha,
  inputHashes: {},
  ordinalVersion: 2,
  predecessor: {
    version: "1",
    sha256: fileSha("artifact-index-v1.json"),
  },
  artifacts: [
    ...v1Index.artifacts,
    {
      artifactId: "actors-c1-v2",
      artifactType: "approval-actor-registry",
      sha256: registryV2Sha,
      path: "quality-contracts/agent-readiness/approval-actor-registry-v2.json",
    },
  ],
  implementationActorIds: ["impl-agent-1"],
};
writeJson("artifact-index-v2.json", indexV2);
const indexV2Sha = fileSha("artifact-index-v2.json");

for (const binding of [
  C1_RECIPE.planBinding,
  C1_RECIPE.specBinding,
  ...C1_RECIPE.contractBindings,
]) {
  const reviewed = gitBytes(binding.gitCommit, binding.repositoryPath);
  const merged = gitBytes(C1_MERGE_SHA, binding.repositoryPath);
  if (sha(reviewed) !== sha(merged)) {
    throw new Error(`provenance mismatch: ${binding.repositoryPath}`);
  }
}

const planSha256 = sha(
  gitBytes(C1_RECIPE.planBinding.gitCommit, C1_RECIPE.planBinding.repositoryPath),
);
const specSha256 = sha(
  gitBytes(C1_RECIPE.specBinding.gitCommit, C1_RECIPE.specBinding.repositoryPath),
);
const contractHashes = Object.fromEntries(
  C1_RECIPE.contractBindings.map((binding) => [
    binding.key,
    sha(gitBytes(binding.gitCommit, binding.repositoryPath)),
  ]),
);
const inputHashes = Object.fromEntries(
  C1_RECIPE.inputHashBindings.map((binding) => [
    binding.key,
    sha(gitBytes(binding.gitCommit, binding.repositoryPath)),
  ]),
);
const artifacts = [
  {
    artifactId: "actors-c1-v2",
    artifactType: "approval-actor-registry",
    sha256: registryV2Sha,
  },
  {
    artifactId: "index-c1-v2",
    artifactType: "artifact-index",
    sha256: indexV2Sha,
  },
];
const target = buildCheckpointTarget({
  checkpoint: "C1",
  baselineGitSha: C1_RECIPE.baselineGitSha,
  artifacts,
  planSha256,
  specSha256,
  actorRegistryVersion: "2.0",
  actorRegistrySha256: registryV2Sha,
  contractHashes,
  inputHashes,
});

const manifest = {
  manifestVersion: "1.0",
  policySha,
  c1ContractSha: C1_CONTRACT_SHA,
  c1MergeSha: C1_MERGE_SHA,
  predecessors: {
    registryV1Sha256: fileSha("approval-actor-registry-v1.json"),
    indexV1Sha256: fileSha("artifact-index-v1.json"),
    ledgerV1Sha256: fileSha("checkpoint-approvals-v1.json"),
  },
  actorRegistryVersion: "2.0",
  actorRegistrySha256: registryV2Sha,
  artifacts,
  planSha256,
  specSha256,
  contractHashes,
  inputHashes,
  checkpointTargetSha256: computeCheckpointTargetSha256(target),
};

process.stdout.write(JSON.stringify(manifest, null, 2) + "\n");
```

- [ ] **Step 3: Build and run preparation**

Run:

```bash
npm run build
node /tmp/c1-prepare.mjs > /tmp/c1-closure-manifest.json
node /tmp/c1-prepare.mjs > /tmp/c1-closure-manifest-second.json
cmp /tmp/c1-closure-manifest.json /tmp/c1-closure-manifest-second.json
```

Expected: build exits 0 and `cmp` exits 0. The program reuses registry v2's existing `createdAt` on subsequent runs, so both tracked artifact bytes and manifest output remain stable.

- [ ] **Step 4: Validate the prepared artifact inventory**

Run:

```bash
jq -e '
  .artifactId == "actors-c1-v2" and
  .registryVersion == "2.0" and
  .governanceMode == "sole-maintainer-bootstrap" and
  .bootstrapOwnerActorId == "repo-maintainer-1" and
  ([.actors[] | select(.actorId == "repo-maintainer-1") | .roles[]] | sort) ==
    (["Repository Maintainer", "Product", "Engineering"] | sort)
' quality-contracts/agent-readiness/approval-actor-registry-v2.json

jq -e '
  .artifactId == "index-c1-v2" and
  .ordinalVersion == 2 and
  .implementationActorIds == ["impl-agent-1"] and
  ([.artifacts[].artifactId] | sort) ==
    (["actors-20260714", "ownership-20260714", "phase0-20260714", "taxonomy-20260714", "actors-c1-v2"] | sort)
' quality-contracts/agent-readiness/artifact-index-v2.json

jq -e '
  .actorRegistryVersion == "2.0" and
  ([.artifacts[].artifactId] | sort) == (["actors-c1-v2", "index-c1-v2"] | sort) and
  (.contractHashes | keys | sort) ==
    (["tool-contracts.ts", "tool-contract-integrity.ts", "tool-contract-docs.ts", "tool-catalog.ts"] | sort) and
  (.checkpointTargetSha256 | test("^[0-9a-f]{64}$"))
' /tmp/c1-closure-manifest.json
```

Expected: all three `jq` commands print `true` and exit 0.

- [ ] **Step 5: Verify C1 remains open before approvals**

Run:

```bash
npm run validate-readiness-artifacts -- --mode public --json > /tmp/c1-preapproval-validation.json
jq -e '.ok == true and .checkpointStatus.C0 == "closed" and .checkpointStatus.C1 == "open" and (.issues | length) == 0' /tmp/c1-preapproval-validation.json
```

Expected: `jq` prints `true`. Absence of the v2 ledger is valid preapproval state.

- [ ] **Step 6: Commit and review the prepared registry/index**

```bash
git add \
  quality-contracts/agent-readiness/approval-actor-registry-v2.json \
  quality-contracts/agent-readiness/artifact-index-v2.json
git commit -m "feat(readiness): prepare C1 governance snapshots"
```

Review `HEAD^..HEAD`, verify all recorded hashes against actual file bytes, then write the approved task review artifact. Do not stage `/tmp` files or `node_modules`.

After commit, rerun `/tmp/c1-prepare.mjs`; its stable timestamp logic must leave the committed registry/index bytes unchanged. Confirm:

```bash
git diff --exit-code -- \
  quality-contracts/agent-readiness/approval-actor-registry-v2.json \
  quality-contracts/agent-readiness/artifact-index-v2.json
```

---

### Task 4: Human Authorization Gate

**Files:**
- Read: `/tmp/c1-closure-manifest.json`
- Create temporarily after authorization: `/tmp/c1-authorizations.json`
- Do not create yet: `quality-contracts/agent-readiness/checkpoint-approvals-v2.json`

**Interfaces:**
- Consumes: immutable manifest produced and reviewed in Task 3.
- Produces: two explicit role-specific authorizations from `repo-maintainer-1` against the exact manifest digest.

- [ ] **Step 1: Print the immutable review packet**

Run:

```bash
MANIFEST_SHA=$(sha256sum /tmp/c1-closure-manifest.json | awk '{print $1}')
printf 'Manifest SHA-256: %s\n' "$MANIFEST_SHA"
jq . /tmp/c1-closure-manifest.json
```

On macOS without `sha256sum`, use:

```bash
MANIFEST_SHA=$(shasum -a 256 /tmp/c1-closure-manifest.json | awk '{print $1}')
```

- [ ] **Step 2: Stop and request the two human decisions**

Present the manifest and ask the user to repeat its exact printed digest and either affirm or replace these concrete rationale statements:

```text
I am repo-maintainer-1. I reviewed the manifest whose SHA-256 was printed above, and I repeat that exact digest here.
Product decision: approved|rejected
Product rationale: I approve the C1 product contract represented by this immutable manifest for the sole-maintainer bootstrap phase.
Engineering decision: approved|rejected
Engineering rationale: I approve the C1 engineering contract and governance evidence represented by this immutable manifest for the sole-maintainer bootstrap phase.
```

This is a hard stop. Do not infer approval from earlier design approval, from silence, or from the request to implement the plan. Do not create the v2 ledger unless both role decisions are exactly `approved` and the user repeats the printed manifest digest.

- [ ] **Step 3: Record the authorized input outside Git**

After valid authorization, use `apply_patch` to create `/tmp/c1-authorizations.json` containing:

```json
{
  "actorId": "repo-maintainer-1",
  "actorKind": "human",
  "manifestSha256": "the exact digest repeated by the user",
  "product": {
    "decision": "approved",
    "decidedAt": "the current ISO-8601 UTC timestamp recorded after the user response",
    "rationale": "the user's Product rationale verbatim"
  },
  "engineering": {
    "decision": "approved",
    "decidedAt": "the current ISO-8601 UTC timestamp recorded after the user response",
    "rationale": "the user's Engineering rationale verbatim"
  }
}
```

The quoted descriptions above identify required user/runtime values; they are not literal strings to write. Validate the file against the repeated manifest digest before continuing.

---

### Task 5: Finalize Ledger v2 and Close C1

**Files:**
- Create: `quality-contracts/agent-readiness/checkpoint-approvals-v2.json`
- Modify: `docs/AGENT_READINESS_STATUS.md`
- Create temporarily: `/tmp/c1-finalize.mjs`

**Interfaces:**
- Consumes: reviewed manifest, user authorization file, v1 ledger bytes, and finalized registry/index bytes.
- Produces: append-only ledger v2 with two authorized C1 records and final C1 closure evidence.

- [ ] **Step 1: Create the complete untracked ledger finalizer**

Create `/tmp/c1-finalize.mjs` with this exact program using `apply_patch`:

```js
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.cwd();
const artifactRoot = resolve(root, "quality-contracts/agent-readiness");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJsonPath = (path) => JSON.parse(readFileSync(path, "utf8"));
const readArtifact = (name) =>
  readJsonPath(resolve(artifactRoot, name));
const artifactBytes = (name) =>
  readFileSync(resolve(artifactRoot, name));

const manifestPath = "/tmp/c1-closure-manifest.json";
const manifestBytes = readFileSync(manifestPath);
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const authorizations = readJsonPath("/tmp/c1-authorizations.json");

if (sha(manifestBytes) !== authorizations.manifestSha256) {
  throw new Error("authorization manifest digest mismatch");
}
if (authorizations.actorId !== "repo-maintainer-1") {
  throw new Error("unexpected authorization actor");
}
if (
  authorizations.product.decision !== "approved" ||
  authorizations.engineering.decision !== "approved"
) {
  throw new Error("both role decisions must be approved");
}
if (
  sha(artifactBytes("approval-actor-registry-v2.json")) !==
    manifest.actorRegistrySha256
) {
  throw new Error("registry v2 changed after manifest review");
}
const indexEntry = manifest.artifacts.find(
  (artifact) => artifact.artifactId === "index-c1-v2",
);
if (
  !indexEntry ||
  sha(artifactBytes("artifact-index-v2.json")) !== indexEntry.sha256
) {
  throw new Error("index v2 changed after manifest review");
}

const v1Ledger = readArtifact("checkpoint-approvals-v1.json");
if (sha(artifactBytes("checkpoint-approvals-v1.json")) !== manifest.predecessors.ledgerV1Sha256) {
  throw new Error("ledger v1 changed after manifest review");
}

const approvedArtifacts = manifest.artifacts.map(({ artifactId, sha256 }) => ({
  artifactId,
  sha256,
}));
const common = {
  approvalKind: "checkpoint",
  checkpoint: "C1",
  decision: "approved",
  actorId: "repo-maintainer-1",
  actorKind: "human",
  actorRegistryVersion: manifest.actorRegistryVersion,
  actorRegistrySha256: manifest.actorRegistrySha256,
  checkpointTargetSha256: manifest.checkpointTargetSha256,
  approvedArtifacts,
  planSha256: manifest.planSha256,
  specSha256: manifest.specSha256,
  contractHashes: manifest.contractHashes,
};
const approvals = [
  {
    ...common,
    approvalId: "c1-product-repo-maintainer",
    role: "Product",
    decidedAt: authorizations.product.decidedAt,
    rationale: authorizations.product.rationale,
  },
  {
    ...common,
    approvalId: "c1-engineering-repo-maintainer",
    role: "Engineering",
    decidedAt: authorizations.engineering.decidedAt,
    rationale: authorizations.engineering.rationale,
  },
];
const ledgerV2 = {
  ...v1Ledger,
  artifactId: "approvals-c1-v2",
  createdAt: new Date().toISOString(),
  sourceGitSha: manifest.policySha,
  inputHashes: {},
  ordinalVersion: 2,
  predecessor: {
    version: "1",
    sha256: manifest.predecessors.ledgerV1Sha256,
  },
  approvals: [...v1Ledger.approvals, ...approvals],
};

writeFileSync(
  resolve(artifactRoot, "checkpoint-approvals-v2.json"),
  JSON.stringify(ledgerV2, null, 2) + "\n",
);
```

- [ ] **Step 2: Generate ledger v2 and verify the prefix structurally**

Run:

```bash
node /tmp/c1-finalize.mjs
jq -s -e '
  .[0].approvals as $old |
  .[1].approvals[0:($old | length)] == $old and
  (.[1].approvals | length) == (($old | length) + 2)
' \
  quality-contracts/agent-readiness/checkpoint-approvals-v1.json \
  quality-contracts/agent-readiness/checkpoint-approvals-v2.json
```

Expected: `jq` prints `true`.

- [ ] **Step 3: Run the authoritative public closure gate**

Run:

```bash
npm run build
npm run validate-readiness-artifacts -- --mode public --json > /tmp/c1-final-validation.json
jq -e '
  .ok == true and
  .checkpointStatus.C0 == "closed" and
  .checkpointStatus.C1 == "closed" and
  (.issues | length) == 0
' /tmp/c1-final-validation.json
```

Expected: `jq` prints `true`. If C1 is open or any issue exists, stop; do not update status documentation or commit the ledger.

- [ ] **Step 4: Independently recompute the approved manifest values**

Rerun the deterministic preparation program and save output to `/tmp/c1-closure-manifest-final.json`, then run:

```bash
node /tmp/c1-prepare.mjs > /tmp/c1-closure-manifest-final.json
```

Its stable timestamp logic rewrites byte-identical registry/index content. Then run:

```bash
cmp /tmp/c1-closure-manifest.json /tmp/c1-closure-manifest-final.json
jq -e --slurpfile manifest /tmp/c1-closure-manifest.json '
  [.approvals[] | select(.checkpoint == "C1")] as $c1 |
  ($c1 | length) == 2 and
  ($c1 | all(.actorId == "repo-maintainer-1")) and
  ($c1 | map(.role) | sort) == (["Product", "Engineering"] | sort) and
  ($c1 | all(.checkpointTargetSha256 == $manifest[0].checkpointTargetSha256))
' quality-contracts/agent-readiness/checkpoint-approvals-v2.json
```

Expected: `cmp` exits 0 and `jq` prints `true`.

- [ ] **Step 5: Update readiness status**

In `docs/AGENT_READINESS_STATUS.md`, change only the C1 status and closure evidence necessary to state:

- C1 is closed by registry/index/ledger v2;
- the registry declares `sole-maintainer-bootstrap` with owner `repo-maintainer-1`;
- Product and Engineering are two role-specific approvals by that one human identity;
- C0 remains closed; and
- Lane C and Lane D remain deferred.

Do not describe the approvals as independent people.

- [ ] **Step 6: Run complete verification**

Run:

```bash
npm run typecheck:contracts
npm run build
npx vitest run \
  src/readiness/contracts.test.ts \
  src/readiness/chains.test.ts \
  src/readiness/checkpoint-policy.test.ts \
  src/scripts/validate-readiness-artifacts.test.ts \
  src/scripts/validate-readiness-artifacts-cli.test.ts \
  src/wiring-verification.test.ts
npm run validate-readiness-artifacts -- --mode public
npm test
```

Expected:

- typecheck and build exit 0;
- all targeted governance/adversarial tests pass;
- public validator prints C0 closed, C1 closed, and `All checks passed.`;
- full offline suite passes with no failures.

- [ ] **Step 7: Prove scope containment**

Run:

```bash
git status --short
git diff --name-only origin/main...HEAD
git diff --name-only
find quality-contracts/agent-readiness -maxdepth 1 -name '*-v2.json' -print | sort
```

Expected source/artifact changes are limited to:

```text
docs/AGENT_READINESS_STATUS.md
docs/superpowers/plans/2026-07-18-c1-checkpoint-closure.md
docs/superpowers/specs/2026-07-18-c1-checkpoint-closure-design.md
quality-contracts/agent-readiness/approval-actor-registry-v2.json
quality-contracts/agent-readiness/artifact-index-v2.json
quality-contracts/agent-readiness/checkpoint-approvals-v2.json
src/readiness/contracts.test.ts
src/readiness/contracts.ts
src/readiness/validator.ts
src/scripts/validate-readiness-artifacts.test.ts
```

No `/tmp` file or `node_modules` entry may be staged.

- [ ] **Step 8: Commit and review Task 5**

```bash
git add \
  quality-contracts/agent-readiness/checkpoint-approvals-v2.json \
  docs/AGENT_READINESS_STATUS.md
git commit -m "feat(readiness): close C1 checkpoint"
```

Run the task-level review against `HEAD^..HEAD`, then write its approved artifact.

- [ ] **Step 9: Perform the final holistic branch review**

Review the complete range:

```bash
BASE_SHA=$(git merge-base origin/main HEAD)
git diff "$BASE_SHA"...HEAD
```

The holistic review must verify:

1. plan-step completion;
2. backward compatibility of registry v1;
3. per-approval registry-mode resolution;
4. implementation-actor exclusion;
5. exact manifest-to-ledger data flow;
6. unchanged C0 prefix and closure;
7. exact C1 closed-world roles/artifacts/contracts/input hashes;
8. no fabricated identity or approval; and
9. no Lane C/Lane D scope drift.

If approved, write the branch artifact:

```bash
.zcode/scripts/write-review-artifact \
  --type branch --result approved --reviewer agent \
  --base-sha "$(git merge-base origin/main HEAD)" \
  --head-sha "$(git rev-parse HEAD)" \
  --branch feat/c1-closure
```

Do not push or open a PR until that artifact matches the exact branch HEAD.
