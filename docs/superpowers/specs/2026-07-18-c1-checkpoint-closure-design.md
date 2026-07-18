# C1 Checkpoint Closure Design

## Purpose

Close readiness checkpoint C1 using the governance infrastructure already merged at `11864827f05e415c07d68f595f95f01f3ee801e2`. This pass creates only the authorized v2 governance artifacts and records two explicit human approvals. It does not modify validator source code or begin Lane C or Lane D.

## Governing Invariant

C1 closes only when two distinct, non-implementation human actors independently approve the same immutable C1 target:

- `repo-maintainer-1` acting as `Product`; and
- `engineering-1` acting as `Engineering`.

Automation may construct artifacts, calculate hashes, and validate the result. Automation must not infer, fabricate, or silently record either human decision.

## Scope

Create exactly these tracked files under `quality-contracts/agent-readiness/`:

- `approval-actor-registry-v2.json` with artifact ID `actors-c1-v2`;
- `artifact-index-v2.json` with artifact ID `index-c1-v2`; and
- `checkpoint-approvals-v2.json` with artifact ID `approvals-c1-v2`.

The registry and index are prepared before human signoff. The ledger is created only after both actors explicitly authorize approval records binding the finalized closure manifest.

## Actor Authorization

Registry v2 contains the complete v1 actor set plus the approved role changes:

| Actor | Kind | Roles | Implementation actor |
|---|---|---|---|
| `impl-agent-1` | agent | `Engineering` | yes |
| `repo-maintainer-1` | human | `Repository Maintainer`, `Product` | no |
| `pm-1` | human | `PM` | no |
| `engineering-1` | human | `Engineering` | no |

`implementationActorIds` remains exactly `["impl-agent-1"]`. The two C1 approvers are distinct, human, authorized for their recorded roles, and absent from that implementation set.

## Artifact Chain

### Registry v2

`approval-actor-registry-v2.json` uses `registryVersion: "2.0"` and references registry v1 through `previousRegistry.registryVersion: "1.0"` plus the SHA-256 of the exact v1 file bytes. Its `sourceGitSha` is the closure branch base, `11864827f05e415c07d68f595f95f01f3ee801e2`.

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

Both humans must review the same closure manifest and explicitly authorize their own record. Each authorization supplies or affirms:

- actor ID and role;
- `decision: "approved"`;
- the manifest's canonical target and artifact hashes;
- an ISO-8601 decision timestamp; and
- a rationale attributable to that actor.

No ledger containing C1 approvals is written before both authorizations exist. If either actor rejects, requests changes, or does not respond, execution stops with C1 open. A later manifest change invalidates prior authorization and requires both actors to review the newly computed manifest.

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
- distinct approval IDs, actors, roles, timestamps, and actor-authored rationales.

The Product record uses `repo-maintainer-1`; the Engineering record uses `engineering-1`.

## Validation Flow

1. Confirm the branch starts at `1186482` and the three v2 paths do not exist.
2. Build and run the existing public validator; expect C0 closed and C1 open.
3. Create registry v2 and validate its schema, chain, roles, and digest.
4. Create index v2 and validate its exact inventory, chain, paths, and digest.
5. Compute the closure manifest twice and require byte-identical output.
6. Obtain Product and Engineering authorization against that exact manifest.
7. Copy the v1 approval prefix without mutation and append the two authorized C1 records.
8. Run the public validator; require zero issues with C0 and C1 closed.
9. Run targeted readiness/adversarial tests, contract typechecking, build, and the full offline suite.
10. Confirm the diff contains only the three v2 artifacts and approved status documentation, if status documentation is explicitly included in the implementation plan.

## Failure Handling

Execution stops without creating or committing the v2 ledger when:

- any predecessor digest differs from the current v1 file bytes;
- the registry or index fails validation;
- closure-manifest recomputation is nondeterministic;
- reviewed and merged C1 source bytes differ;
- either human authorization is absent or refers to another manifest;
- the v1 approval prefix changes in content or order; or
- final validation reports an issue or leaves C0/C1 open.

Generated partial files may be removed and regenerated before approval. Once humans approve a manifest, changes to registry v2 or index v2 require discarding the pending ledger and obtaining fresh approvals.

## Out of Scope

- Modifying files under `src/`, `scripts/`, or package configuration.
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
- Product and Engineering approvals come from distinct authorized humans outside `implementationActorIds`.
- Public readiness validation reports zero issues, C0 closed, and C1 closed.
- Targeted adversarial tests, typechecking, build, and the full offline suite pass.
- No source code changes or Lane C/Lane D artifacts are present.
