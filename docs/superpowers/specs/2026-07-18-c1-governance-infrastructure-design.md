# C1 Governance Infrastructure Design

## Purpose

Lane B code establishes the governance machinery required to close C1 later, without creating Product or Engineering actors, v2 governance artifacts, or human approvals in this pass. The validator must continue to report C0 as closed and C1 as open until valid C1 approvals are added through the deferred human process.

## Scope

This pass implements:

- C1 checkpoint recipe metadata bound to reviewed contract commit `022a3f2` and merged provenance commit `7609e3c`.
- Closed-world C0 and C1 checkpoint policies.
- Backward-compatible chain metadata for registry, artifact-index, and approval-ledger schemas.
- Deterministic chain validation, unique-head selection, and predecessor enforcement.
- Per-approval actor-registry resolution by recorded version and SHA-256.
- Always-on append-only ledger validation when a predecessor chain exists.
- Conditional C1 target recomputation when C1 approvals are present.
- Adversarial tests for forks, stale or missing predecessors, approval deletion or mutation, mixed registry versions, and closed-world policy violations.

This pass does not create actor registry v2, artifact index v2, checkpoint approvals v2, Product or Engineering identities, or C1 approvals. It also excludes Lane C gold-label work and Lane D MCP migration.

## Checkpoint Target Boundary

The C1 checkpoint target binds reviewable evidence, not its governance transport. Future C1 approvals will bind:

- actor registry v2;
- artifact index v2; and
- C1 contract evidence artifacts declared by the recipe.

The checkpoint ledger is excluded from its own approvals' `approvedArtifacts`. Including it would create a hash cycle: approvals bind a target, the target binds the ledger, and the ledger contains the approvals. Ledger integrity is instead established independently through its ordinal, predecessor, unique-head, and append-only invariants.

## Historical Git Bindings

`C1_CONTRACT_SHA` is `022a3f229a4aeba74b9b140142fd2d3a0aa6c4be`, the reviewed PR #30 branch head containing the approved C1 contract bytes. `C1_MERGE_SHA` is `7609e3c14daddd4448d6bdf37c9a6a337a7241d0`, the merge commit proving those bytes landed on `main`. Recipe source resolution uses `C1_CONTRACT_SHA`; `C1_MERGE_SHA` is recorded as integration provenance. Runtime validation resolves every bound source at both commits and compares SHA-256 digests. Any difference fails closed with `checkpoint-provenance-mismatch`.

The C1 recipe resolves the parent plan, design specification, and these contract sources from `022a3f2`:

- `src/tool-contracts.ts`
- `src/tool-contract-integrity.ts`
- `src/tool-contract-docs.ts`
- `src/tool-catalog.ts`

The normative C1 recipe is:

| Field | Exact value |
|---|---|
| checkpoint | `C1` |
| baselineGitSha | `374f72073c81ea7901696333cd875fe75b348e6b` |
| sourceGitSha | `022a3f229a4aeba74b9b140142fd2d3a0aa6c4be` |
| integrationGitSha | `7609e3c14daddd4448d6bdf37c9a6a337a7241d0` |
| plan binding | key `task1-plan.md`, path `docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md` |
| spec binding | key `design-spec.md`, path `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md` |
| contract keys | `tool-contracts.ts`, `tool-contract-integrity.ts`, `tool-contract-docs.ts`, `tool-catalog.ts` |
| future artifact IDs/types | `actors-c1-v2` / `approval-actor-registry`; `index-c1-v2` / `artifact-index` |
| input-hash keys | plan key, spec key, and all four contract keys |
| required roles | `Product`, `Engineering` |

The C0 policy is derived from `C0_RECIPE`: its exact artifact types, plan/spec keys, contract keys, input-hash keys, and roles `Repository Maintainer` and `PM`. C1 uses the exact members in the table. Policy definitions must contain no duplicates.

## Architecture

### Schema evolution

The artifact index and checkpoint ledger gain optional `ordinalVersion` and `predecessor` fields. Optionality preserves parsing of existing v1 artifacts. The actor registry retains its existing `registryVersion` and `previousRegistry` representation. Schema parsing establishes shape compatibility; validator policy establishes when chain fields are required.

### Chain model

Each artifact family is loaded as a version graph before a current artifact is selected. A valid graph has:

- one node per ordinal/version;
- no duplicate ordinal;
- every non-root predecessor resolving to exactly one artifact of the same family;
- predecessor version and SHA-256 matching the referenced artifact;
- numeric successors advancing exactly one ordinal (`successor = predecessor + 1`);
- no cycles or forks; and
- exactly one terminal head.

Enumeration order never determines the selected artifact. The unique terminal head is the current registry, index, or ledger.

### Approval registry resolution

Each approval is validated against the actor registry identified by its own `actorRegistryVersion` and `actorRegistrySha256`. Older approvals remain valid against an older registry after a newer registry becomes the head. A missing version, ambiguous version, or hash mismatch fails closed.

### Ledger append-only enforcement

Every successor ledger must retain the predecessor's canonical approval sequence as an unchanged prefix. Deletion, mutation, duplication, and reordering are rejected; new approvals may only follow the preserved prefix. Chain discovery makes this verification automatic, replacing the optional CLI `previousLedgerPath` input and removing that option from `ValidateReadinessOptions` and the CLI.

### Closed-world checkpoint policies

`CHECKPOINT_POLICIES` defines exact required sets for each checkpoint:

- artifact types;
- plan/spec source keys;
- contract keys;
- input-hash keys; and
- approval roles.

Validation checks uniqueness/cardinality before exact set equality. Duplicate, missing, and unexpected members are errors. C0 policy is derived from the historical C0 recipe and must preserve the existing approved target. C1 requires Product and Engineering roles but does not invent the actors that will eventually occupy those roles.

### Conditional C1 activation

The validator recomputes a checkpoint when the selected ledger contains any schema-valid record for that checkpoint, including rejected or artifact-review records. This fail-closed activation prevents malformed governance attempts from bypassing historical resolution. Only issue-free records with `decision: approved` and `approvalKind: checkpoint` contribute to closure. With no C1 records, C1 recomputation is skipped and the checkpoint remains open.

## Validation Flow

1. Parse all readiness artifacts under the configured roots.
2. Group registry, index, and ledger candidates by artifact family.
3. Build and validate each family graph.
4. Select the unique terminal head for current-state checks.
5. Verify every ledger transition is append-only.
6. Resolve each approval's recorded actor registry version and digest.
7. Apply exact checkpoint policy sets.
8. Resolve recipe inputs from their recorded Git commits.
9. Compare every C1 binding at the reviewed and integration commits.
10. Recompute and compare targets only for checkpoints represented by records.
11. Report checkpoint state; absent C1 records leave C1 open.

## Errors

Chain and policy failures emit stable issue codes with artifact family, version or ordinal, expected predecessor, and relevant path. Required categories include duplicate ordinal, skipped ordinal, missing predecessor, predecessor digest mismatch, fork, cycle, multiple heads, ledger deletion, ledger mutation, ledger reordering, registry resolution failure, registry digest mismatch, duplicate policy member, missing policy member, unexpected policy member, and checkpoint provenance mismatch.

Malformed chains fail closed. Absence of deferred C1 artifacts and approvals is not malformed state and must not create an issue by itself.

## Testing Strategy

Tests use the existing synthetic repository and `FakeGitResolver`. Each adversarial test changes exactly one property from a valid fixture and asserts the precise issue code. Required scenarios are:

- duplicate registry ordinal;
- skipped numeric ordinal;
- chain cycle;
- multiple ledger heads;
- index predecessor digest without a matching predecessor;
- registry predecessor referencing a nonexistent v1 artifact;
- deleted or mutated predecessor approval;
- reordered predecessor approvals;
- approval bound to v1 while registry v2 is the current head;
- unexpected C0 contract key;
- missing C1 contract key;
- duplicate policy members;
- reviewed/merge source-byte mismatch;
- no C1 records leaves C1 open; and
- valid C1 approvals trigger historical recomputation from `022a3f2`.

The final verification runs the build, contract typechecks, targeted readiness tests serially, public and private readiness validation, and the full offline suite. Expected public state is C0 closed and C1 open.

## Deferred Closure Work

C1 closes only after authorized humans decide the Product and Engineering actors and create the v2 registry, index, ledger, and approvals through this infrastructure. That later pass must not weaken chain or closed-world validation to accommodate artifact creation.
