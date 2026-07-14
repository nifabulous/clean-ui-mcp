# Task 1 Readiness Contracts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate the Phase 0 evidence as one strict, hash-linked artifact graph and close C0 with independent Repository Maintainer and PM approvals.

**Architecture:** A pure `validateReadinessArtifacts(options)` function owns schema, graph, integrity, leak, and approval checks; a thin CLI supplies repository paths and formats results. Evidence artifacts remain immutable, checkpoint status is derived, actor registries are immutable snapshots, and approvals bind one canonical checkpoint target without cryptographic signing.

**Tech Stack:** TypeScript 5.9, Node.js 22.14+, Zod 4, Vitest 4, ESM/NodeNext, SHA-256 from `node:crypto`.

## Global Constraints

- `374f72073c81ea7901696333cd875fe75b348e6b` is the frozen Phase 0 baseline Git SHA.
- Do not write to `corpus/entries.json`, `corpus/decisions.json`, private screenshots, or any pre-existing dirty path.
- Strip Ed25519, signing-key, admin-root, attestation, and rotation-chain requirements from the authoritative parent plan before implementing schemas.
- Keep SHA-256 content binding. Every approval records both actor-registry version and exact registry SHA-256.
- Persisted schemas are strict; unknown and removed crypto fields fail validation.
- Evidence artifacts are immutable. C0 status is derived from evidence plus approvals and is never written back into Phase 0 evidence.
- The artifact index excludes itself and the mutable checkpoint-approval ledger.
- Public validation requires no private corpus. Private validation receives an explicit corpus path and optionally a private-artifact root.
- The shell harness is credential-scrubbed/provider-disabled, not a network-isolation guarantee.
- Budget approval and final corpus disposition require human actors. Other checkpoint roles may be independent human or agent actors.
- Implementers cannot approve their own checkpoint work.
- Follow TDD and request the repository-required review after every task.

---

## Locked Decisions

| Decision | Outcome |
|---|---|
| Scope | Keep the full Task 1 artifact set; executable surface remains small |
| Approval security | Opaque actor IDs and role validation; no cryptographic signing |
| Registry binding | Keep `actorRegistryVersion` and `actorRegistrySha256` |
| Headers | Compose `BaseArtifactHeader` and `CorpusBoundHeader` |
| Validation boundary | Pure injected validator plus thin CLI |
| Artifact graph | Acyclic; index excludes itself and approval ledger |
| Leak detection | Structural public checks; corpus-aware private checks |
| Taxonomy aggregate | SHA-256 of canonical `{ enumName: values[] }` JSON |
| Zod behavior | `.strict()` on every persisted object |
| Harness claim | Rename no-egress claims to credential-scrubbed/provider-disabled |
| Actor independence | Record `implementationActorIds` and `actorKind` |
| Provenance | One frozen baseline SHA plus explicit dependency hashes |
| Diagnostic | Complete image/corpus identity or `reusable: false` |
| Tests | Whole-graph mutation matrix, not schema-only tests |
| Parent correction | Mechanically remove every stale crypto and false no-egress requirement |
| Registry evolution | Immutable versioned snapshots with historical hash resolution |
| Checkpoint agreement | All required approvers bind one `checkpointTargetSha256` |
| Ledger history | Compare against an explicit prior ledger when supplied |
| CLI | `--mode` plus named paths; exit codes 0/1/2 |
| Indexed paths | Unique, contained, non-symlinked, identity-matching files |

## Artifact Graph

```text
Frozen baseline 374f720
        │
        ├── phase0-summary-v1.json ─┐
        ├── ownership-map-v1.json  ─┼── artifact-index-v1.json
        ├── taxonomy-digest-v1.json ┤      (does not index itself)
        └── actor-registry-v1.json ─┘
                         │
                         ├── canonical CheckpointTarget(C0)
                         │       ├── evidence hashes
                         │       ├── parent/task-plan/spec hashes
                         │       ├── registry version + hash
                         │       └── contract/input hashes
                         │
                         └── checkpoint-approvals-v1.json
                                 ├── Repository Maintainer → same target SHA
                                 └── PM                    → same target SHA

C0 closed = graph valid + target valid + exact roles + independent actors
```

The approval ledger and index never hash each other. The Phase 0 summary remains `evidence-gathered-pending-validation`; the validator derives `closed` only when the complete graph passes.

## File Map

| File | Responsibility |
|---|---|
| `docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md` | Authoritative parent contract; remove stale crypto and false network-isolation requirements |
| `src/readiness/contracts.ts` | Strict schemas, canonical hashing, taxonomy computation, checkpoint-target construction, and pure validation interfaces |
| `src/readiness/contracts.test.ts` | Schema, hashing, actor, target, and ledger unit tests |
| `src/scripts/validate-readiness-artifacts.ts` | Thin CLI and repository defaults |
| `src/scripts/validate-readiness-artifacts.test.ts` | CLI, exit-code, output, path-containment, and whole-graph tests |
| `quality-contracts/agent-readiness/phase0-summary-v1.json` | Hash-linked Phase 0 summary; immutable evidence |
| `quality-contracts/agent-readiness/ownership-map-v1.json` | Safe tracked ownership classifications and file hashes |
| `quality-contracts/agent-readiness/taxonomy-digest-v1.json` | Five enum arrays, per-enum hashes, canonical aggregate |
| `quality-contracts/agent-readiness/approval-actor-registry-v1.json` | Immutable opaque actor/role snapshot |
| `quality-contracts/agent-readiness/checkpoint-approvals-v1.json` | Append-only checkpoint approval records |
| `quality-contracts/agent-readiness/artifact-index-v1.json` | Exact evidence/registry inventory and implementation actor IDs |
| `package.json` | Validator script |

---

## Task 1: Amend the Authoritative Parent Plan

**Files:**
- Modify: `docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md`
- Add: `docs/superpowers/plans/2026-07-14-task1-readiness-contracts.md`

**Produces:** A no-crypto, credential-scrubbed parent contract consistent with this plan.

- [ ] **Step 1: replace the actor-registry bootstrap**

Specify immutable snapshots:

```ts
interface ApprovalActorRegistry {
  registryVersion: string;
  previousRegistry: { registryVersion: string; sha256: string } | null;
  actors: Array<{
    actorId: string;
    actorKind: "human" | "agent";
    roles: ApprovalRole[];
  }>;
}
```

State that a role addition or removal creates the next ordinal snapshot (for example, `approval-actor-registry-v2.json` after v1); previous files are never overwritten, and approvals resolve the exact version/hash they recorded.

- [ ] **Step 2: remove crypto fields but retain integrity fields**

Remove `signingKeyId`, `signatureBase64`, `attestationSha256`, Ed25519 verification, admin-root trust, and rotation-chain requirements. Both `CheckpointApproval` and `LiveCostApproval` retain:

```ts
actorRegistryVersion: string;
actorRegistrySha256: string;
```

- [ ] **Step 3: replace the approval verification paragraph**

The parent must require:

- exact role sets per checkpoint;
- actor membership and role authorization in the bound registry snapshot;
- distinct actors for independent roles;
- no intersection between `implementationActorIds` and checkpoint approvers;
- `actorKind: "human"` for Budget Owner and final disposition roles;
- one identical `checkpointTargetSha256` for every approval closing a checkpoint;
- optional comparison with a prior committed ledger to enforce append-only history.

- [ ] **Step 4: correct the harness claim everywhere**

Replace `no-egress`, `network-scrubbed`, `networkMode: "denied"`, Docker, network namespace, and `--network none` requirements for Phase 0 with the truthful terms:

```text
credential-scrubbed
provider-disabled
```

The parent must state that `scripts/run-no-egress.mjs` removes provider credentials and sets `RUN_LIVE_INTEGRATION=0`, but does not block unauthenticated network traffic. True network isolation remains a Gate 2/npm-release prerequisite, not a C0 claim.

- [ ] **Step 5: reclassify the ownership map as tracked evidence**

Move `ownership-map.json` from the private artifact tree to the tracked tree as `ownership-map-v1.json`. State that it may contain repository-relative paths, classifications, decisions, and SHA-256 values, but never corpus entry IDs, URLs, prompts, or private bytes.

- [ ] **Step 6: update header, graph, diagnostic, CLI, and test language**

Fold in the locked decisions from this plan:

- layered base/corpus-bound headers;
- immutable evidence and derived checkpoint status;
- index exclusion of itself and approval ledger;
- canonical taxonomy aggregate;
- complete diagnostic identity or historical-only status;
- explicit `--mode` CLI with named paths;
- structural public leaks and corpus-aware private leaks;
- strict schemas and whole-graph mutation tests.

- [ ] **Step 7: verify the amendment is exhaustive**

Run:

```bash
! rg -n 'Ed25519|signingKeyId|signatureBase64|attestationSha256|admin-root|untrusted root|rotation chain' \
  docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md
rg -n 'actorRegistrySha256|checkpointTargetSha256|credential-scrubbed|implementationActorIds' \
  docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md
git diff --check -- docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md
```

Expected: first command exits 0 because no stale crypto term remains; second command finds all four replacement concepts; diff check is clean.

- [ ] **Step 8: review and commit Part A**

Run the repository-required task review, then commit the parent plan and this implementation plan together so the executable contract cannot become an untracked dependency:

```bash
git add \
  docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md \
  docs/superpowers/plans/2026-07-14-task1-readiness-contracts.md
git commit -m "docs: align readiness plan with no-crypto approvals"
```

Record this commit as `PART_A_SHA`; administrative artifacts created later use it as their `sourceGitSha`.

---

## Task 2: Implement Strict Contracts and Canonical Hashing

**Files:**
- Create: `src/readiness/contracts.ts`
- Create: `src/readiness/contracts.test.ts`

**Interfaces:**
- Produces: `BaseArtifactHeader`, `CorpusBoundHeader`, all persisted schemas, `TrackedArtifact`, `canonicalJsonStringify`, `sha256Hex`, `computeFileSha256`, `computeTaxonomyDigest`, `computeCorpusIdentity`, `buildCheckpointTarget`, `computeCheckpointTargetSha256`, and validation option/result types.
- Consumes: `PatternType`, `Category`, `StyleTag`, `Component`, and `DomainTag` from `src/schema.ts`.

- [ ] **Step 1: write failing primitive and header tests**

Tests assert:

- lowercase 64-hex SHA-256 and 40-hex Git SHA only;
- ISO datetime validation;
- strict unknown-key rejection;
- `BaseArtifactHeader` does not require corpus fields;
- `CorpusBoundHeader` requires `corpusSha256`, `corpusEntryCount`, and `taxonomySha256`;
- removed crypto fields fail instead of being stripped.

Use these exact shapes:

```ts
export const BaseArtifactHeader = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.string().min(1),
  artifactId: z.string().min(1),
  createdAt: z.string().datetime(),
  createdByRole: z.string().min(1),
  sourceGitSha: GitSha,
  inputHashes: z.record(z.string().min(1), Sha256),
}).strict();

export const CorpusBoundHeader = BaseArtifactHeader.extend({
  corpusSha256: Sha256,
  corpusEntryCount: z.number().int().nonnegative(),
  taxonomySha256: Sha256,
}).strict();
```

- [ ] **Step 2: run the focused tests and confirm failure**

```bash
npx vitest run src/readiness/contracts.test.ts
```

Expected: FAIL because `src/readiness/contracts.ts` does not exist.

- [ ] **Step 3: implement strict type-specific schemas**

Every nested persisted object is also `.strict()`.

```ts
type ApprovalRole =
  | "Repository Maintainer" | "PM" | "Product" | "Engineering"
  | "Gold Label Owner" | "QA" | "Evaluation Owner"
  | "Corpus Owner" | "Budget Owner";

interface CheckpointApproval {
  approvalId: string;
  approvalKind: "artifact-review" | "checkpoint";
  checkpoint: "C0" | "C1" | "C2" | "C3" | "C4" | "C5";
  decision: "approved" | "rejected";
  actorId: string;
  role: ApprovalRole;
  actorRegistryVersion: string;
  actorRegistrySha256: string;
  checkpointTargetSha256: string;
  approvedArtifacts: Array<{ artifactId: string; sha256: string }>;
  planSha256: string;
  specSha256: string;
  contractHashes: Record<string, string>;
  decidedAt: string;
  rationale?: string;
}
```

Persisted artifact schemas:

| Schema | Header | Required body |
|---|---|---|
| `Phase0Summary` | corpus-bound | environment, command matrix, individual skip gates, doctor/corpus/pack results, credential-scrubbed runner, diagnostic identity, ownership/taxonomy refs, pending C0 state |
| `OwnershipMap` | base | entries with path/classification/decision/hash and critique-quality disposition |
| `TaxonomyDigest` | base | exact five taxonomy rows and aggregate hash |
| `ApprovalActorRegistry` | base | version, prior snapshot or null, actors with kind and roles |
| `CheckpointApprovals` | base | approval array |
| `ArtifactIndex` | base | evidence/registry rows plus non-empty `implementationActorIds` |

`LiveCostApproval` is exported and strict but is not part of the tracked-artifact union because live approvals remain private.

- [ ] **Step 4: implement recursive canonical JSON**

`canonicalJsonStringify(value)` must:

- recursively sort object keys by code-point order;
- preserve array order;
- emit compact UTF-8 JSON;
- reject `undefined`, functions, symbols, non-finite numbers, and cyclic values.

Hash taxonomy input shaped exactly as:

```ts
{
  Category: Category.options,
  Component: Component.options,
  DomainTag: DomainTag.options,
  PatternType: PatternType.options,
  StyleTag: StyleTag.options,
}
```

The Phase 0 aggregate must become:

```text
a96fa56eed0aadb8be618ea2cb54a1be2943e58feaed31e8aba12d7d6059c2bf
```

Per-enum hashes remain SHA-256 of compact `JSON.stringify(enum.options)`.

- [ ] **Step 5: implement checkpoint-target construction**

```ts
interface CheckpointTarget {
  checkpoint: "C0" | "C1" | "C2" | "C3" | "C4" | "C5";
  baselineGitSha: string;
  artifacts: Array<{ artifactId: string; artifactType: string; sha256: string }>;
  planSha256: string;
  specSha256: string;
  actorRegistryVersion: string;
  actorRegistrySha256: string;
  contractHashes: Record<string, string>;
  inputHashes: Record<string, string>;
}
```

`buildCheckpointTarget` sorts `artifacts` by `artifactId`, sorts record keys through canonical serialization, and rejects duplicate IDs. `computeCheckpointTargetSha256` hashes the canonical UTF-8 bytes. Every checkpoint approval must repeat the exact artifact list and target SHA.

- [ ] **Step 6: implement immutable registry and ledger helpers**

Registry validation requires:

- unique registry version and file hash;
- unique actor IDs;
- non-empty, duplicate-free role arrays;
- `previousRegistry: null` only for v1;
- later snapshots reference the immediately prior version and exact file hash;
- approval actor exists and is authorized for the claimed role.

`validateLedgerAppendOnly(current, previous)` requires every previous approval ID to exist with byte-equivalent canonical content in `current`; only new unique approval IDs may be added.

- [ ] **Step 7: complete unit tests**

Add tests for canonical nested ordering, array-order sensitivity, rejected non-JSON values, exact aggregate hash, duplicate artifacts, registry evolution, actor-role mismatch, registry-hash mismatch, divergent checkpoint targets, rejected approvals, artifact-review approvals, implementer self-approval, human-only roles, and prior-ledger mutation/deletion.

- [ ] **Step 8: run focused tests**

```bash
npx vitest run src/readiness/contracts.test.ts
```

Expected: all contract tests pass.

- [ ] **Step 9: review and commit contracts**

Run the repository-required task review, then:

```bash
git add src/readiness/contracts.ts src/readiness/contracts.test.ts
git commit -m "feat: add readiness artifact contracts"
```

---

## Task 3: Implement the Injected Validator and CLI

**Files:**
- Create: `src/scripts/validate-readiness-artifacts.ts`
- Create: `src/scripts/validate-readiness-artifacts.test.ts`
- Modify: `package.json`

**Interfaces:**
- Consumes: schemas and helpers from `src/readiness/contracts.ts`.
- Produces:

```ts
interface ValidateReadinessOptions {
  artifactRoot: string;
  mode: "public" | "private";
  corpusPath?: string;
  privateArtifactRoot?: string;
  previousLedgerPath?: string;
}

interface ValidationIssue {
  code: string;
  artifactId?: string;
  path?: string;
  message: string;
}

interface ValidationResult {
  ok: boolean;
  checkpointStatus: Record<string, "open" | "closed">;
  checkedArtifacts: number;
  issues: ValidationIssue[];
}

export function validateReadinessArtifacts(options: ValidateReadinessOptions): ValidationResult;
```

- [ ] **Step 1: write the minimal valid C0 graph fixture**

In the test file, create a temporary artifact root containing strict, internally consistent Phase 0 summary, ownership map, taxonomy digest, actor registry, artifact index, and approval ledger. Create a temporary two-entry corpus for private-mode tests. Never read or write the real corpus.

- [ ] **Step 2: write failing graph and path tests**

Starting from the valid graph, mutate exactly one condition per test:

- missing or unindexed evidence artifact;
- duplicate artifact ID or index path;
- index row ID/type mismatch with parsed content;
- stale evidence, plan, spec, registry, contract, or input hash;
- absolute path, `..` traversal, root escape, or symlink;
- unknown artifact type or unknown persisted field;
- malformed JSON;
- actor absent from registry or unauthorized for role;
- same actor in two independent roles;
- implementer actor used as approver;
- rejected or `artifact-review` record counted toward checkpoint closure;
- incomplete C0 role set;
- required approvers using different checkpoint targets;
- changed/deleted prior-ledger record;
- public structural leak;
- private exact corpus entry-ID leak;
- substring resembling an entry ID without exact equality, which must pass.

- [ ] **Step 3: implement contained deterministic artifact resolution**

The validator:

1. resolves `artifactRoot` to an absolute real path;
2. enumerates JSON files in deterministic lexical order;
3. rejects absolute index paths and any `..` segment;
4. uses `lstat` to reject symlinks;
5. resolves each path and verifies it remains below the artifact root;
6. parses strict JSON and requires index ID/type to equal content ID/type;
7. hashes each file once and caches the digest;
8. requires the index to list every evidence/registry artifact exactly once;
9. excludes `artifact-index` and `checkpoint-approvals` from index membership.

- [ ] **Step 4: implement public and private leak checks**

Public mode rejects:

- forbidden keys: `prompt`, `systemPrompt`, `rawPrompt`, `providerPayload`, `imageBytes`, `entryId`;
- string values beginning with an absolute filesystem root;
- string values under `providerUrl`, `baseUrl`, or `sourceUrl`;
- any path under `eval/agent-readiness/`.

Allow repository-relative paths in the ownership map and index.

Private mode performs every public check, requires `corpusPath`, hashes its exact bytes, validates its entry count, creates a `Set` of corpus IDs, and rejects string leaf values exactly equal to an entry ID. It does not use substring matching. Resolve opaque private references beneath `privateArtifactRoot` only when such references exist.

- [ ] **Step 5: implement integrity and checkpoint closure**

Validate:

- summary input hashes match ownership map, taxonomy digest, parent plan, Task 1 plan, design spec, and credential-scrubbed runner;
- every Phase 0 evidence artifact uses frozen `sourceGitSha` `374f72073c81ea7901696333cd875fe75b348e6b`;
- taxonomy values and per-enum/aggregate hashes reproduce from `src/schema.ts`;
- index contents equal the target evidence/registry set;
- every checkpoint approval binds the registry version/hash and one common target SHA;
- approved artifact arrays equal the target artifact array;
- only `decision: "approved"` and `approvalKind: "checkpoint"` count;
- C0 requires Repository Maintainer and PM, with distinct authorized actors outside `implementationActorIds`;
- a supplied prior ledger is preserved exactly.

C1–C5 remain `open` when they have no approvals; absence is not a validation failure during Task 1.

- [ ] **Step 6: implement exact CLI parsing**

Supported commands:

```bash
npm run validate-readiness-artifacts -- --mode public
npm run validate-readiness-artifacts -- --mode public --json
npm run validate-readiness-artifacts -- --mode private --corpus-path corpus/entries.json
npm run validate-readiness-artifacts -- --mode private --corpus-path corpus/entries.json --private-artifact-root eval/agent-readiness
```

Optional flags in both modes:

```text
--artifact-root <path>
--previous-ledger <path>
--json
```

Reject unknown flags, duplicate scalar flags, missing values, missing `--corpus-path` in private mode, and `--corpus-path` in public mode. Exit codes: `0` valid, `1` validation failures, `2` usage/configuration error. JSON mode writes one JSON object to stdout and diagnostics only to stderr.

- [ ] **Step 7: write CLI behavior tests**

Spawn the compiled CLI against temporary fixtures and assert all four documented commands, exit codes 0/1/2, machine-clean JSON stdout, human output, unknown flags, missing corpus path, and invalid mode.

- [ ] **Step 8: run focused tests**

```bash
npx vitest run src/readiness/contracts.test.ts src/scripts/validate-readiness-artifacts.test.ts
```

Expected: all readiness tests pass without touching the real corpus.

- [ ] **Step 9: wire the package command**

Add:

```json
"validate-readiness-artifacts": "tsc && node dist/scripts/validate-readiness-artifacts.js"
```

- [ ] **Step 10: review and commit the validator**

Run the repository-required task review, then:

```bash
git add src/scripts/validate-readiness-artifacts.ts src/scripts/validate-readiness-artifacts.test.ts package.json
git commit -m "feat: validate readiness artifact graphs"
```

---

## Task 4: Migrate Phase 0 Evidence and Close C0

**Files:**
- Modify: `quality-contracts/agent-readiness/phase0-summary-v1.json`
- Modify: `quality-contracts/agent-readiness/ownership-map-v1.json`
- Modify: `quality-contracts/agent-readiness/taxonomy-digest-v1.json`
- Create: `quality-contracts/agent-readiness/approval-actor-registry-v1.json`
- Create: `quality-contracts/agent-readiness/checkpoint-approvals-v1.json`
- Create: `quality-contracts/agent-readiness/artifact-index-v1.json`

**Produces:** One valid C0 artifact graph and derived `C0: closed` result.

- [ ] **Step 1: migrate the three evidence artifacts to strict schemas**

For each artifact, add `createdByRole`, `sourceGitSha`, and exact `inputHashes`. Use the frozen source SHA for all Phase 0 evidence:

```text
374f72073c81ea7901696333cd875fe75b348e6b
```

The Phase 0 summary input hashes must bind:

- `ownership-map-v1.json`;
- `taxonomy-digest-v1.json`;
- the amended parent plan;
- this Task 1 plan;
- `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md`;
- `scripts/run-no-egress.mjs`.

Rename the harness evidence to `credentialScrubbedRunner`, set `environment.networkMode` to `credential-scrubbed`, and state the unauthenticated-egress limitation verbatim.

- [ ] **Step 2: replace the taxonomy aggregate**

Set both the taxonomy digest aggregate and summary taxonomy hash to:

```text
a96fa56eed0aadb8be618ea2cb54a1be2943e58feaed31e8aba12d7d6059c2bf
```

Keep the five value arrays and per-enum hashes unchanged if recomputation confirms them.

- [ ] **Step 3: complete diagnostic identity or mark it historical-only**

Derive:

- canonical SHA-256 of the ordered `EVAL_SET` metadata from `scripts/eval-set.mjs`;
- ordered image-byte SHA-256 values for all 15 cases;
- corpus SHA-256 used by the original run, if recoverable;
- prompt, reference manifest, machine rules, provider, and model identities already recorded.

Set `diagnosticBaseline.reusable: true` only when every identity is available and verified. Otherwise set `reusable: false`, add `nonReusableReasons` naming each missing identity, and retain metrics only as historical context. Never synthesize a missing hash.

- [ ] **Step 4: obtain actor inputs and create registry v1**

Pause for independent actor assignments. Record:

- all Task 1 implementer actor IDs;
- one Repository Maintainer actor ID and kind;
- one distinct PM actor ID and kind.

Create immutable registry v1 with `previousRegistry: null`. It may include other already-assigned roles, but no role may be invented for an actor. Later additions create v2 rather than modifying v1.

Use `PART_A_SHA` as `sourceGitSha` for the actor registry, artifact index, and approval ledger. These are administrative Task 1 artifacts, not Phase 0 evidence; they must not claim the frozen Phase 0 baseline as their creation commit.

- [ ] **Step 5: create the acyclic artifact index**

Index exactly:

- Phase 0 summary;
- ownership map;
- taxonomy digest;
- actor registry v1.

Sort rows by `artifactId`. Record non-empty `implementationActorIds`. Do not index the index or approval ledger.

- [ ] **Step 6: build the canonical C0 checkpoint target**

Use the production helper to compute one target over:

- checkpoint `C0`;
- frozen baseline SHA;
- the exact four indexed artifact rows;
- this plan hash;
- design spec hash;
- actor registry version/hash;
- contract hashes, including the amended parent plan and `src/readiness/contracts.ts`;
- summary input hashes.

Persist the resulting `checkpointTargetSha256` in both C0 approval records.

- [ ] **Step 7: obtain independent approvals**

The implementation worker may prepare the target and empty ledger but must not create an `approved` decision on behalf of either role. Pause until the assigned Repository Maintainer and PM each provide an approval record for the identical target. The validator must reject either actor if listed in `implementationActorIds`.

- [ ] **Step 8: validate public and private modes**

```bash
npm run validate-readiness-artifacts -- --mode public
npm run validate-readiness-artifacts -- --mode public --json
npm run validate-readiness-artifacts -- --mode private --corpus-path corpus/entries.json
```

Expected: exit 0; identical `C0: closed` semantics in human and JSON output; private mode additionally verifies 787 entries and the frozen corpus SHA.

- [ ] **Step 9: run the full verification matrix**

```bash
npm run build
npx vitest run src/readiness/contracts.test.ts src/scripts/validate-readiness-artifacts.test.ts
npm test
npm run validate-references
npm run validate-corpus
npm run doctor
git diff --check
```

Expected: build and all tests pass, four intentional live-integration skips remain individually documented, references/corpus validate, doctor has zero FAIL, and the diff check is clean.

- [ ] **Step 10: holistic review and commit**

Request task-level review against this plan and the amended parent. Fix every Critical and Important finding, then commit only owned Task 4 files:

```bash
git add \
  quality-contracts/agent-readiness/phase0-summary-v1.json \
  quality-contracts/agent-readiness/ownership-map-v1.json \
  quality-contracts/agent-readiness/taxonomy-digest-v1.json \
  quality-contracts/agent-readiness/approval-actor-registry-v1.json \
  quality-contracts/agent-readiness/checkpoint-approvals-v1.json \
  quality-contracts/agent-readiness/artifact-index-v1.json
git commit -m "chore: validate and close readiness C0"
```

Write the task-review artifact for the final commit. Before push, run the required holistic branch review and write the branch-review artifact.

**C0 gate:** Phase 0 evidence is strict-schema-valid, hash-linked, leak-safe, tied to one frozen baseline, approved by distinct authorized Repository Maintainer and PM actors over one canonical target, and reported `closed` by both public and private validation. No corpus or pre-existing dirty path changed.

---

## Test Coverage Map

```text
CLI
├── valid public/private arguments ─────────────── tested
├── JSON/human rendering parity ───────────────── tested
└── usage errors → exit 2 ─────────────────────── tested
     ↓
Injected validator
├── deterministic enumeration ─────────────────── tested
├── strict parse / malformed / unknown type ───── tested
├── containment / traversal / symlink ─────────── tested
├── index ID/type/set equality ─────────────────── tested
├── cached file hashes and dependency hashes ──── tested
├── canonical taxonomy reproduction ───────────── tested
├── public structural leak checks ─────────────── tested
├── private corpus/hash/exact-ID checks ───────── tested
├── immutable registry snapshot resolution ────── tested
├── actor role/kind/independence checks ───────── tested
├── common checkpoint target ──────────────────── tested
├── prior-ledger preservation ─────────────────── tested
└── derived C0 open/closed state ───────────────── tested
```

## Failure Modes

| Failure | Handling | Required test |
|---|---|---|
| Artifact JSON malformed or has stale field | Specific schema issue, exit 1 | malformed/unknown-field mutation |
| Index points outside root or at symlink | Reject before reading target | traversal/symlink mutation |
| Artifact bytes change | Cached recomputed hash mismatch | one-byte mutation |
| Parent plan/spec changes after approval | Checkpoint target mismatch | stale plan/spec hash |
| Registry changes | Version/hash mismatch; historical snapshot required | registry mutation and v2 chain |
| Approvers target different evidence | C0 remains open and validation fails | divergent target SHA |
| Implementer self-approves | Approval rejected | actor intersection |
| Previous approval removed | Append-only comparison fails | prior-ledger deletion |
| Public checkout lacks corpus | Public passes without corpus access | absent-corpus public fixture |
| Private corpus missing or changed | Usage error if missing; validation failure if hash differs | missing/tampered corpus |
| Diagnostic identity incomplete | `reusable: false`; metrics remain historical | missing image/corpus identity |

## Sequential Execution

This increment should remain sequential:

```text
Task 1 parent amendment
    ↓
Task 2 schemas and canonical helpers
    ↓
Task 3 validator and CLI
    ↓
Task 4 evidence migration and independent approvals
```

Parallel worktrees would create unnecessary conflicts in the parent plan, contracts, and artifact graph.

## Explicitly Out of Scope

- Ed25519 signing, public keys, admin-root trust, attestation hashes, and cryptographic rotation chains.
- True network isolation during C0. Gate 2/npm release must add and verify it separately.
- Schemas for gold manifests, quality contracts, dogfood summaries, and dispositions; their tasks extend the union later.
- Corpus mutation, retagging, promotion, rollback, npm publishing, and hosted infrastructure.
- Moving the safe tracked ownership map into ignored private storage.

## Execution Handoff

Implement Task 1 first and review/commit it before touching runtime schemas. Continue sequentially through Tasks 2–4 with a fresh task-level review after each commit. Stop at Task 4 Step 4 for actor assignments and again at Step 7 for independent approvals; the implementation worker cannot manufacture those inputs.
