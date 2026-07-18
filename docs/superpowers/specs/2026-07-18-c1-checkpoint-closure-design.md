# C1 Checkpoint Closure Design

## Purpose

Close readiness checkpoint C1 using the governance infrastructure already merged at `11864827f05e415c07d68f595f95f01f3ee801e2`, extended with an explicit sole-maintainer bootstrap mode. This pass adds the narrowly scoped schema, validator, and test changes for that mode; creates the authorized v2 governance artifacts; and records two explicit role-specific approvals from the sole maintainer. It does not begin Lane C or Lane D.

## Governing Invariant

C1 closes only when authorized, non-implementation human governance approves the same immutable C1 target for both required roles. The normal mode requires distinct Product and Engineering actors. The explicit sole-maintainer bootstrap mode permits one transparently identified human to approve in both roles while the registry declares that mode.

For this closure, `repo-maintainer-1` acts as both `Product` and `Engineering`. The ledger records two role-specific decisions under that one truthful actor ID; it does not invent a second person or actor identity.

Automation may construct artifacts, calculate hashes, and validate the result. Automation must not infer, fabricate, or silently record either human decision.

## Scope

Add the smallest governance source-code extension required to represent and validate a state-bound sole-maintainer bootstrap, then create exactly these tracked files under `quality-contracts/agent-readiness/`:

- `approval-actor-registry-v2.json` with artifact ID `actors-c1-v2`;
- `artifact-index-v2.json` with artifact ID `index-c1-v2`; and
- `checkpoint-approvals-v2.json` with artifact ID `approvals-c1-v2`.

The registry and index are prepared before human signoff. The ledger is created only after the sole maintainer explicitly authorizes both role-specific approval records binding the finalized closure manifest.

## Governance Modes

Actor registries declare one of two strict modes:

- `separation-of-duties`: every required checkpoint role must be approved by a distinct human actor; or
- `sole-maintainer-bootstrap`: one named human bootstrap owner may satisfy multiple required roles, provided that actor is authorized for every recorded role and is not an implementation actor.

Registry v1 remains backward compatible: absence of the new governance fields is interpreted as `separation-of-duties`. Registry v2 explicitly declares `sole-maintainer-bootstrap` and `bootstrapOwnerActorId: "repo-maintainer-1"`.

The exception is resolved from the registry version pinned by each approval, not from the current registry head. A future registry v3 exits bootstrap by declaring `separation-of-duties` and omitting the bootstrap owner. Approvals issued under registry v3 must then use distinct actors; the transition does not retroactively invalidate approvals correctly issued under registry v2.

Schema and semantic validation enforce these closed combinations:

- `sole-maintainer-bootstrap` requires exactly one non-empty `bootstrapOwnerActorId` naming a human registry actor;
- `separation-of-duties` forbids `bootstrapOwnerActorId`;
- legacy registries may omit both fields and retain separation-of-duties behavior;
- the bootstrap owner must hold every role they approve; and
- no actor in `implementationActorIds` may contribute to checkpoint closure in either mode.

## Actor Authorization

Registry v2 contains the complete v1 actor set plus the approved role changes:

| Actor | Kind | Roles | Implementation actor |
|---|---|---|---|
| `impl-agent-1` | agent | `Engineering` | yes |
| `repo-maintainer-1` | human | `Repository Maintainer`, `Product`, `Engineering` | no |
| `pm-1` | human | `PM` | no |

`implementationActorIds` remains exactly `["impl-agent-1"]`. The C1 approver is human, authorized for both recorded roles, is the registry-declared bootstrap owner, and is absent from that implementation set.

## Artifact Chain

### Registry v2

`approval-actor-registry-v2.json` uses `registryVersion: "2.0"`, declares `governanceMode: "sole-maintainer-bootstrap"` and `bootstrapOwnerActorId: "repo-maintainer-1"`, and references registry v1 through `previousRegistry.registryVersion: "1.0"` plus the SHA-256 of the exact v1 file bytes. Its `sourceGitSha` is the reviewed bootstrap-policy implementation commit created in the first increment, so the governance artifact binds the exact source behavior under which it was issued.

### Index v2

`artifact-index-v2.json` uses `ordinalVersion: 2` and references index v1 through predecessor version `"1"` plus the SHA-256 of the exact v1 file bytes. It indexes every non-index, non-ledger artifact on disk exactly once: the four v1 evidence/registry artifacts and `actors-c1-v2`. Its row for `actors-c1-v2` records the finalized registry v2 digest. It excludes both index snapshots and both ledger snapshots.

### Ledger v2

`checkpoint-approvals-v2.json` uses `ordinalVersion: 2` and references ledger v1 through predecessor version `"1"` plus the SHA-256 of the exact v1 file bytes. Its approvals array begins with the two v1 C0 records copied byte-for-byte and in their original order, followed by exactly two C1 checkpoint approvals.

The ledger is excluded from the C1 target, preventing a self-referential hash cycle. Its integrity is enforced by chain and append-only validation.

## Deterministic Closure Manifest

Before either approval is recorded, an untracked, deterministic Node command computes and prints a closure manifest from finalized tracked inputs. The command imports the built repository functions rather than reimplementing canonicalization.

The manifest contains:

- registry v1, index v1, and ledger v1 SHA-256 values;
- registry v2 and index v2 SHA-256 values;
- `C1_CONTRACT_SHA` and `C1_MERGE_SHA`;
- plan and spec SHA-256 values resolved with `git show` at `C1_CONTRACT_SHA`;
- all four exact contract hashes resolved at `C1_CONTRACT_SHA`;
- all six C1 input hashes;
- actor registry version `2.0` and registry v2 digest;
- the exact approved artifact list (`actors-c1-v2`, `index-c1-v2`); and
- the canonical C1 target SHA-256 produced by `buildCheckpointTarget` and `computeCheckpointTargetSha256`.

The manifest is review material, not a fourth tracked governance artifact. The implementation records its terminal output in the task review evidence and independently recomputes the same values after ledger creation.

## Human Signoff Gate

The sole maintainer must review the closure manifest and explicitly authorize two role-specific records. Each authorization supplies or affirms:

- actor ID and role;
- `decision: "approved"`;
- the manifest's canonical target and artifact hashes;
- an ISO-8601 decision timestamp; and
- a rationale attributable to that actor.

No ledger containing C1 approvals is written before both role-specific authorizations exist. If either role decision is rejected, deferred, or refers to another manifest, execution stops with C1 open. A later manifest change invalidates prior authorization and requires both role decisions to be made again.

## Approval Records

Both new records use:

- `approvalKind: "checkpoint"`;
- `checkpoint: "C1"`;
- `decision: "approved"`;
- `actorKind: "human"`;
- `actorRegistryVersion: "2.0"`;
- the registry v2 digest;
- the same canonical C1 target digest;
- exactly `actors-c1-v2` and `index-c1-v2` with their real digests;
- the same plan, spec, and four contract hashes from the manifest; and
- distinct approval IDs, roles, timestamps, and actor-authored rationales, while truthfully retaining the same actor ID.

Both records use `repo-maintainer-1`; one records role `Product` and the other records role `Engineering`. Their shared actor ID is accepted only because their pinned registry v2 explicitly declares that actor as the sole-maintainer bootstrap owner.

## Validation Flow

1. Confirm the branch starts at `1186482` and the three v2 paths do not exist.
2. Add backward-compatible registry governance-mode fields and semantic validation.
3. Update closure logic to apply actor cardinality from each approval's pinned registry.
4. Add adversarial tests for forged owners, implementation-actor owners, unauthorized roles, legacy separation-of-duties, same-actor rejection outside bootstrap, and same-owner acceptance inside bootstrap.
5. Review and commit the bootstrap-policy increment; use that reviewed commit as registry v2 `sourceGitSha`.
6. Build and run the public validator; expect C0 closed and C1 open.
7. Create registry v2 and validate its schema, chain, roles, mode, owner, and digest.
8. Create index v2 and validate its exact inventory, chain, paths, and digest.
9. Compute the closure manifest twice and require byte-identical output.
10. Obtain Product and Engineering role authorizations from the sole maintainer against that exact manifest.
11. Copy the v1 approval prefix without mutation and append the two authorized C1 records.
12. Run the public validator; require zero issues with C0 and C1 closed.
13. Run targeted readiness/adversarial tests, contract typechecking, build, and the full offline suite.
14. Confirm the diff contains only the reviewed bootstrap-policy source/tests, three v2 artifacts, design/plan documents, and approved status documentation included by the implementation plan.

## Failure Handling

Execution stops without creating or committing the v2 ledger when:

- any predecessor digest differs from the current v1 file bytes;
- the registry or index fails validation;
- closure-manifest recomputation is nondeterministic;
- reviewed and merged C1 source bytes differ;
- either role-specific human authorization is absent or refers to another manifest;
- the registry's bootstrap owner is missing, non-human, unauthorized, or an implementation actor;
- the v1 approval prefix changes in content or order; or
- final validation reports an issue or leaves C0/C1 open.

Generated partial files may be removed and regenerated before approval. Once the sole maintainer approves a manifest in both roles, changes to registry v2 or index v2 require discarding the pending ledger and obtaining fresh role-specific approvals.

## Out of Scope

- Unrelated modifications under `src/`, `scripts/`, or package configuration.
- Creating a permanent artifact generator.
- Inventing or delegating human approval.
- Lane C gold-label work.
- Lane D MCP migration.
- Changing C0 evidence or approvals.

## Acceptance Criteria

- Exactly three v2 governance JSON artifacts are added.
- Registry, index, and ledger chains each have a unique valid head.
- Ledger v2 preserves the complete v1 approvals as an unchanged prefix.
- Both C1 approvals bind the same independently recomputed target.
- In normal mode, required roles come from distinct authorized humans.
- In sole-maintainer bootstrap mode, the same registry-declared human owner may satisfy Product and Engineering while remaining outside `implementationActorIds`.
- Legacy registries continue to enforce separation of duties without artifact changes.
- Public readiness validation reports zero issues, C0 closed, and C1 closed.
- Targeted adversarial tests, typechecking, build, and the full offline suite pass.
- No source changes beyond the reviewed bootstrap-mode schema, validator, and tests are present; no Lane C/Lane D artifacts are added.
