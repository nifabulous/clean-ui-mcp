# Agent Readiness Phases 0–1C Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Freeze a trustworthy baseline, establish an independently labeled quality contract, migrate the MCP and companion skill as one beta contract, dogfood all workflows, and approve exactly one corpus disposition without mutating the corpus.

**Architecture:** Phase 0 verifies an immutable SHA without touching the developer's dirty workspace. Phase 1A produces private evaluation evidence plus tracked, sanitized contracts. Phase 1B ships one atomic agent-facing contract migration. Phase 1C combines the terminal quality outcome and dogfood evidence into Replacement, Fill-only, or Deferred; corpus mutation remains Phase 2+.

**Tech stack:** TypeScript 5.9, Node.js 22.14+, Vitest 4, Zod 4, MCP SDK 1.29, JSON artifacts, existing tagger/provider adapters.

**Design authority:** `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md` is authoritative. This plan restores its exact tool names, uniform result envelope, workflow routing, and Build handoff. Task 2 makes one explicit factual amendment: retrieval mode adds `hybrid` and a typed `fallbackReason`, because the current private search already has a hybrid path.

## Global Constraints

- No task writes to `corpus/entries.json`, `corpus/decisions.json`, or private screenshots.
- Publication state and retag quality remain independent.
- The taxonomy is frozen from Checkpoint C0 through the final Phase 4 audit. Any enum change requires a new selection/baseline version.
- Gold labels are frozen before candidate outputs are revealed. Calibration implementers cannot edit labels.
- Hard safety gates never move. At most two scoped calibration cycles are allowed.
- The MCP rename, envelopes, skill, documentation, and removed-name tests merge and release atomically; no aliases ship.
- `content[0].text` is rendered from validated `structuredContent`; legacy clients receive the complete result.
- Tests use temporary corpora or injected readers. Normal CI cannot make external provider calls.
- Raw screenshots, prompts, detailed annotations, provider payloads, private entry IDs, and operator identity remain under ignored `eval/agent-readiness/` or an access-controlled artifact store.
- Tracked contracts contain sanitized aggregates and hashes only and are excluded from the future npm `files` allowlist.
- Hard machine accessibility/safety rules constrain every result and are never overridable. Within those constraints: existing team design system > explicit approved project constraints > cited corpus proposals > editorial defaults. Conflicts become unresolved warnings.
- After every task: run its focused tests, request task-level review, commit only owned files, and write the required `.zcode` task review artifact. Before push: run a holistic branch review.

## Scope and checkpoints

```text
C0 Foundation freeze
  ↓
C1 Agent contract lock
  ├───────────────┐
C2 Gold readiness │  C3 MCP + create_ui_spec + skill
  ↓               │   ↓
C4 terminal 1A outcome + approved/hash-bound 1B dogfood
  ↓
C5 corpus disposition (Replacement | Fill-only | Deferred)
```

Approvers:

| Checkpoint | Required approval |
|---|---|
| C0 | Repository Maintainer + PM |
| C1 | Product + Engineering |
| C2 | Gold Label Owner + QA |
| C3 | Product + QA + Engineering |
| C4 | Evaluation Owner + Product + QA |
| C5 | PM + Corpus Owner |

No checkpoint passes because a file merely exists. Its schema, hashes, tests, and approval fields must all validate.

One worker may implement tasks serially, but cannot self-supply independent labels, adjudication, task review, or checkpoint approvals. Execution pauses at C0–C5 until the named human roles respond.

## Artifact boundary

Tracked and safe to review:

```text
quality-contracts/agent-readiness/
├── artifact-index-v1.json
├── phase0-summary-v1.json
├── diagnostic-summary-v1.json
├── gold-manifest-v1.json
├── quality-contract-v1.json
├── dogfood-summary-v1.json
├── approval-actor-registry-v1.json
├── checkpoint-approvals-v1.json
└── disposition-v1.json
```

Private and already covered by the ignored `eval/` boundary:

```text
eval/agent-readiness/runs/<run-id>/
├── manifest.json
├── ownership-map.json
├── phase0-tool-smoke-matrix.json
├── live-cost-approval.json
├── selection.json
├── annotations/<labeler-id>.json
├── adjudication.json
├── raw-output.json
├── sanitized-output.json
├── scores.json
└── dogfood-details.json
```

Tracked manifests reference private artifacts by SHA-256, schema version, and opaque artifact ID—never by private path, screenshot, URL, prompt, or entry ID. Clean-clone CI validates tracked contracts and synthetic fixtures. The authorized private gate additionally verifies referenced private artifacts.

The artifact index indexes evidence artifacts but does not hash the mutable approval ledger, and approval records do not approve the index or ledger itself. They bind the immutable evidence artifact set directly, avoiding any approval/hash cycle.

## File map

| File | Responsibility |
|---|---|
| `src/tool-catalog.ts` | Canonical 12-name catalog and removed-name set |
| `src/tool-result.ts` | Canonical Zod envelope, retrieval, warning, and evidence schemas; inferred TS types; text renderer |
| `src/corpus-reader.ts` | Truthful search/similarity metadata for private and public readers |
| `src/server-factory.ts` | Tool registration, advertised output schemas, handlers |
| `src/ui-spec.ts` | `create_ui_spec` input/output schemas and synthesis |
| `src/readiness/contracts.ts` | Zod schemas and hash validation for tracked/private readiness artifacts |
| `src/scripts/retag-gold-select.mts` | Deterministic marginal-coverage selector |
| `scripts/eval-scorer.mjs` | Raw and sanitized metrics |
| `scripts/eval-gold-baseline.mjs` | Offline-injectable/live-opt-in gold runner |
| `skill/clean-ui-design/**` | One router skill and three workflow modules |

---

## Task 0: Establish an isolated, owned foundation

**Files:**
- Create: `quality-contracts/agent-readiness/phase0-summary-v1.json`
- Create: `quality-contracts/agent-readiness/diagnostic-summary-v1.json`
- Create: `quality-contracts/agent-readiness/approval-actor-registry-v1.json`
- Create: `quality-contracts/agent-readiness/ownership-map-v1.json`
- Create: `scripts/run-no-egress.mjs`
- Create: `scripts/run-no-egress.test.mjs`
- Modify: none of the currently dirty or untracked user files

**Produces:** Checkpoint C0 with a frozen SHA and separate clean-clone/private-workspace evidence.

- [ ] **Step 1: Resolve prerequisite ownership without mutation**

The Repository Maintainer records each dirty path in the private ownership map as `{ path, classification, ownerOrDecision }`, where classification is `owned-by-current-increment`, `owned-by-other-work`, or `needs-user-decision`. The tracked Phase-0 summary contains only its SHA-256. Explicitly record whether every `feat/critique-quality-wiring` change is merged into the frozen base or deliberately deferred. Do not delete, stash, relocate, stage, or commit `CLAUDE.md`, `src/GBP movement.xlsx`, `scripts/run-exporter.mts`, the design spec, or any other existing change as part of this task.

Before C0, use a separate clean temporary worktree from `origin/main` to apply only the reviewed plan, authoritative spec, and the TDD-built credential-scrubbed harness, verify their hashes, and land them through a foundation-only commit/PR. The harness (`scripts/run-no-egress.mjs`) removes provider credentials and sets `RUN_LIVE_INTEGRATION=0`, but does not block unauthenticated network traffic; true network isolation remains a Gate 2/npm-release prerequisite, not a C0 claim. Fetch the resulting commit and assert the plan/spec/harness hashes at `FROZEN_SHA` exactly match the reviewed hashes. Never bootstrap these files by staging from the dirty implementation workspace.

The Repository Maintainer creates `approval-actor-registry-v1.json` mapping opaque actor IDs to allowed roles (with an `actorKind` of `"human"` or `"agent"`). No cryptographic keys are stored. The registry is an immutable versioned snapshot: a role addition or removal creates the next ordinal snapshot (e.g., `approval-actor-registry-v2.json`); the previous file is never overwritten. Each new snapshot records its `previousRegistry` (version + SHA-256 of the prior file). Approvals resolve the exact registry version and file SHA-256 they recorded. Identity mapping remains private; only opaque IDs, roles, and actor kinds are tracked. Record the registry hash/version in the frozen foundation.

- [ ] **Step 2: establish the real base**

The roadmap/spec commit containing this plan and its authoritative design must first land on `origin/main`. Then:

```bash
git fetch origin
FROZEN_SHA="$(git rev-parse origin/main)"
git worktree add .worktrees/agent-readiness-phase-0-1c -b feat/agent-readiness-phase-0-1c "$FROZEN_SHA"
cd .worktrees/agent-readiness-phase-0-1c
test "$(git rev-parse --show-toplevel)" = "$(pwd -P)"
test "$(git status --porcelain)" = ""
test "$(shasum -a 256 docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md | cut -d' ' -f1)" = "$APPROVED_PLAN_SHA256"
test "$(shasum -a 256 docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md | cut -d' ' -f1)" = "$APPROVED_SPEC_SHA256"
```

Do not describe historical diagnostic SHA `fdd74d1` as `main`; retain it only as provenance for the already-recorded 15-image diagnostic.

- [ ] **Step 3: verify a credential-scrubbed clean clone**

```bash
(
  REPO_ROOT="$(pwd -P)"
  ROOT="$(mktemp -d)"
  unset OPENAI_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY MISTRAL_API_KEY
  unset MINIMAX_API_KEY XAI_API_KEY VOYAGE_API_KEY IMAGE_EMBEDDING_API_KEY
  export RUN_LIVE_INTEGRATION=0
  : "${CREDENTIAL_SCRUBBED_RUNNER:?absolute fail-closed credential-scrubbed runner required}"
  : "${SMOKE_MATRIX:?checkpoint-specific tool smoke matrix required}"
  export CREDENTIAL_SCRUBBED_RUNNER SMOKE_MATRIX
  git clone --no-local "$REPO_ROOT" "$ROOT/repo"
  git -C "$ROOT/repo" checkout --detach "$FROZEN_SHA"
  cd "$ROOT/repo"
  test ! -e corpus/entries.json
  npm ci
  "$CREDENTIAL_SCRUBBED_RUNNER" --self-test # removes provider credentials and disables live integration
  # The helper removes API keys and sets RUN_LIVE_INTEGRATION=0. It does not
  # block unauthenticated network traffic; true no-egress requires a network
  # namespace or container at Gate 2/npm release.
  "$CREDENTIAL_SCRUBBED_RUNNER" npm run build
  "$CREDENTIAL_SCRUBBED_RUNNER" npm test
  "$CREDENTIAL_SCRUBBED_RUNNER" npm run validate-references
  "$CREDENTIAL_SCRUBBED_RUNNER" npm run validate-corpus
  "$CREDENTIAL_SCRUBBED_RUNNER" npm run doctor
  "$CREDENTIAL_SCRUBBED_RUNNER" npm pack --dry-run --json
  PACK_DIR="$(mktemp -d)"
  INSTALL_DIR="$(mktemp -d)"
  PACK_JSON="$("$CREDENTIAL_SCRUBBED_RUNNER" npm pack --pack-destination "$PACK_DIR" --json)"
  TARBALL="$(node -e 'const fs=require("fs"); const x=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(x[0].filename)' <<<"$PACK_JSON")"
  cp "$PACK_DIR/$TARBALL" "$INSTALL_DIR/package.tgz"
  cp "$SMOKE_MATRIX" "$INSTALL_DIR/smoke-matrix.json"
  cd "$INSTALL_DIR"
  export SMOKE_MATRIX="$INSTALL_DIR/smoke-matrix.json"
  "$CREDENTIAL_SCRUBBED_RUNNER" npm init -y >/dev/null
  "$CREDENTIAL_SCRUBBED_RUNNER" npm install --offline --no-audit --no-fund ./package.tgz
  "$CREDENTIAL_SCRUBBED_RUNNER" node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const command = resolve("node_modules/.bin/clean-ui-mcp");
const transport = new StdioClientTransport({ command });
const client = new Client({ name: "phase0-tarball-smoke", version: "1.0.0" });
await client.connect(transport);
const listed = await client.listTools();
const matrix = JSON.parse(readFileSync(process.env.SMOKE_MATRIX, "utf8"));
const actualNames = listed.tools.map((tool) => tool.name).sort();
const expectedNames = matrix.tools.map((row) => row.name).sort();
if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) throw new Error("catalog mismatch");
for (const row of matrix.tools) {
  const definition = listed.tools.find((tool) => tool.name === row.name);
  if (matrix.requireOutputSchema && !definition?.outputSchema) throw new Error(`missing outputSchema: ${row.name}`);
  const result = await client.callTool({ name: row.name, arguments: row.arguments });
  if (Boolean(result.isError) !== (row.expected === "typed-error")) throw new Error(`unexpected outcome: ${row.name}`);
}
await client.close();
NODE
)
```

Record each command, exit code, per-tool outcome, named skips, Node/npm versions, absence of `.env`/private corpus, the runner SHA-256, and the successful credential-scrubbed preflight. The frozen C0 matrix names the exact legacy catalog; the final branch-HEAD matrix names the exact 12-tool catalog, requires non-null output schemas, rejects removed names, and invokes every offline-safe tool class. Do not reduce this to a skip count.

- [ ] **Step 4: verify the authorized private workspace offline**

```bash
RUN_LIVE_INTEGRATION=0 npm run build
RUN_LIVE_INTEGRATION=0 npm test
RUN_LIVE_INTEGRATION=0 npm run validate-corpus
RUN_LIVE_INTEGRATION=0 npm run doctor
```

Require 787 schema-valid entries and 0 doctor FAIL. Record private details only in the ignored run; put hashes and aggregate counts in the tracked summary.

- [ ] **Step 5: reuse or rerun the 15-image diagnostic deliberately**

Reuse the run recorded at `fdd74d1` only when corpus, image, prompt, model, provider, rules, and reference hashes match. Otherwise require a validated private Budget Owner approval bound to the run/config/model/maximum cost before these unlock flags are accepted:

```bash
RUN_LIVE_INTEGRATION=1 LIVE_COST_APPROVED=1 MAX_COST_USD=25 \
  npm run eval-baseline
```

The tracked summary records the known 2026-07-14 diagnostic—15/15 completed, 80% pattern accuracy, zero raw icon-only claims, zero raw banned phrases, 6,553 ms mean extraction latency—and states that recommendation/citation quality was not scorable.

- [ ] **Step 6: derive taxonomy identity from code**

Never hand-copy counts. Import `PatternType`, `Category`, `StyleTag`, `Component`, and `DomainTag`, record their option arrays and SHA-256, and verify current counts (21, 18, 14, 35, 15). Freeze the resulting taxonomy hash through Phase 4.

- [ ] **Step 7: preserve C0 evidence for Task 1 validation**

Do not stage unvalidated summaries. Task 1 supplies their schemas and validator, then validates and commits the two summaries with the artifact index. The manifest records `FROZEN_SHA` as the baseline Git identity used by every comparable future run. Task 0 and Task 1 together close C0.

**C0 evidence gate:** owned workspace disposition recorded; immutable base identified; full clean-clone and private-offline matrices pass; diagnostic identity is recorded; taxonomy hash is frozen. C0 closes after Task 1 validates and records this evidence.

---

## Task 1: Add artifact schemas and consistency validation

**Files:**
- Create: `src/readiness/contracts.ts`
- Create: `src/readiness/contracts.test.ts`
- Create: `src/scripts/validate-readiness-artifacts.ts`
- Create: `quality-contracts/agent-readiness/artifact-index-v1.json`
- Validate only: `quality-contracts/agent-readiness/approval-actor-registry-v1.json`
- Create: `quality-contracts/agent-readiness/checkpoint-approvals-v1.json`
- Modify: `package.json`

**Produces:** `ArtifactHeader`, tracked/private schemas, `npm run validate-readiness-artifacts`.

- [ ] **Step 1: write failing schema tests**

Tests cover required header fields, SHA-256 format, immutable artifact IDs, predecessor hashes, environment/network mode, private-path/URL/prompt rejection in tracked files, and public versus private validation modes.

```ts
export const BaseArtifactHeader = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.string().min(1),
  artifactId: z.string().min(1),
  createdAt: z.string().datetime(),
  createdByRole: z.string().min(1),
  sourceGitSha: z.string().regex(/^[a-f0-9]{40}$/),
  inputHashes: z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/)),
}).strict();

export const CorpusBoundHeader = BaseArtifactHeader.extend({
  corpusSha256: z.string().regex(/^[a-f0-9]{64}$/),
  corpusEntryCount: z.number().int().nonnegative(),
  taxonomySha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const CheckpointApproval = z.object({
  approvalId: z.string().min(1),
  approvalKind: z.enum(["artifact-review", "checkpoint"]),
  checkpoint: z.enum(["C0", "C1", "C2", "C3", "C4", "C5"]),
  decision: z.enum(["approved", "rejected"]),
  actorId: z.string().min(1), // stable opaque pseudonym; identity map stays private
  role: z.string().min(1),
  actorKind: z.enum(["human", "agent"]),
  actorRegistryVersion: z.string().min(1),
  actorRegistrySha256: z.string().regex(/^[a-f0-9]{64}$/),
  checkpointTargetSha256: z.string().regex(/^[a-f0-9]{64}$/),
  approvedArtifacts: z.array(z.object({
    artifactId: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })).min(1),
  planSha256: z.string().regex(/^[a-f0-9]{64}$/),
  specSha256: z.string().regex(/^[a-f0-9]{64}$/),
  contractHashes: z.record(z.string().min(1), z.string().regex(/^[a-f0-9]{64}$/)),
  decidedAt: z.string().datetime(),
  rationale: z.string().optional(),
}).strict();

export const LiveCostApproval = z.object({
  approvalId: z.string().min(1),
  actorId: z.string().min(1),
  role: z.literal("Budget Owner"),
  actorKind: z.literal("human"),
  actorRegistryVersion: z.string().min(1),
  actorRegistrySha256: z.string().regex(/^[a-f0-9]{64}$/),
  runId: z.string().min(1),
  runConfigSha256: z.string().regex(/^[a-f0-9]{64}$/),
  provider: z.string().min(1),
  model: z.string().min(1),
  maxCostUsd: z.number().positive(),
  decidedAt: z.string().datetime(),
});
```

Approvals live in a separate append-only ledger. The validator recomputes every approved artifact hash, requires the exact role set for C0–C5, rejects duplicate/conflicting approvals, and prevents one `actorId` — including the implementation worker — from satisfying roles declared independent. Every checkpoint approval must bind one identical `checkpointTargetSha256` so all required approvers attest the same evidence/plan/spec/registry/contract/input set. `artifact-review` records attest one prerequisite; only `checkpoint` records bound to the complete checkpoint artifact set can close C0–C5. `actorKind: "human"` is required for Budget Owner and final disposition roles; other checkpoint roles may be independent human or agent actors. Live-cost approvals remain private and are referenced by hash. Real identity mapping remains private; opaque actor IDs, roles, and actor kinds are tracked.

`BaseArtifactHeader` is the common header; `CorpusBoundHeader` extends it with corpus identity. Implement a discriminated union keyed by `artifactType`; do not treat `inputHashes` as a substitute for type-specific provenance:

- Phase-0 summaries require every command/exit pair, named skip IDs, environment versions, and corpus/network mode; command fields do not appear on artifact types that do not execute commands.
- Selection and gold artifacts require algorithm/rubric versions plus selection and annotation/adjudication hashes; label-owner approvals bind through the ledger.
- Live diagnostic and gold-run artifacts require pinned provider, base URL, model, positive approved cost ceiling, prompt/rule/reference hashes, and telemetry completeness.
- Dogfood artifacts require the atomic Phase 1B contract-bundle hash, scenario/rubric/harness versions, dogfood-specific cost-approval hash, measured cost/token usage, and telemetry completeness.
- Quality and disposition artifacts require explicit predecessor artifact IDs/hashes; their approvals are bound through the separate ledger.

- [ ] **Step 2: implement schemas and public/private validation modes**

`--mode public` validates tracked schemas and hashes without requiring private files. `--mode private --corpus-path <path>` additionally verifies the supplied private corpus identity; `--private-artifact-root <path>` resolves opaque private artifact IDs when present.

- [ ] **Step 3: add the command and prove failures are visible**

```json
"validate-readiness-artifacts": "tsc && node dist/scripts/validate-readiness-artifacts.js"
```

Run tests with a missing private artifact, hash mismatch, corpus mismatch, taxonomy mismatch, leaked private path, mutated approved artifact, registry hash mismatch, stale registry version, duplicate actor, actor role mismatch, divergent checkpoint targets, implementer self-approval, prior-ledger mutation/deletion, and incomplete checkpoint role set; each must fail with a specific reason.

- [ ] **Step 4: validate and commit the C0 contract**

Validate the two Task 0 summaries in public mode, update the artifact index, collect C0 approval records from Repository Maintainer and PM against the exact summary/plan/spec/harness hashes, validate the ledger, request review, and commit only `src/readiness/**`, the validator, package script, and `quality-contracts/agent-readiness/**`.

**C0 gate:** Task 0 evidence is schema-valid and hash-linked; Repository Maintainer and PM approvals are recorded; no pre-existing dirty path was mutated.

---

## Task 2: Lock the exact MCP and workflow contract

**Files:**
- Modify: `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md`
- Create: `src/tool-catalog.ts`
- Create: `src/tool-catalog.test.ts`
- Create: `src/tool-contracts.ts`
- Create: `src/tool-contracts.test.ts`
- Create: `src/readiness/checkpoint-policy.ts`
- Create: `src/readiness/checkpoint-policy.test.ts`
- Modify: `src/readiness/contracts.ts`
- Modify: `src/readiness/contracts.test.ts`
- Modify: `src/readiness/validator.ts`
- Modify: `src/scripts/validate-readiness-artifacts.ts`
- Modify: `src/scripts/validate-readiness-artifacts.test.ts`
- Create: `quality-contracts/agent-readiness/checkpoint-recipe-c0-v1.json`
- Create: `quality-contracts/agent-readiness/checkpoint-recipe-c1-v1.json`
- Create: `quality-contracts/agent-readiness/approval-actor-registry-v2.json`
- Create: `quality-contracts/agent-readiness/artifact-index-v2.json`
- Create: `quality-contracts/agent-readiness/checkpoint-approvals-v2.json`

**Produces:** Checkpoint C1, one executable 12-tool contract, and historically reproducible C0/C1 approval chains.

- [ ] **Step 1: write the failing C1 integrity matrix first**

Extend the readiness fixtures from one valid C0 graph into a C0→C1 history. Tests must fail before implementation and cover:

- exact 12-name order, uniqueness, legacy-name mapping, and removed-name derivation;
- every catalog descriptor has exactly one strict input schema, output-data schema, and renderer key;
- one valid and representative invalid input/output for all 12 tools;
- unknown-field rejection for every persisted and MCP contract object;
- every allowed retrieval state and representative impossible combinations;
- success/error envelope invariants, evidence eligibility, tool discriminator, and `UiSpec` completeness/sparse states;
- recomputation of checkpoint targets from resolved bytes rather than approval claims;
- one-byte mutations to catalog, contracts, parent plan, design spec, recipes, registries, indexes, and ledgers;
- C0 remains closed after the working-tree parent plan/spec change for C1;
- C0 fails when its recorded historical Git source, path, or content hash is changed;
- registry/index/ledger fork, duplicate head, skipped ordinal, missing predecessor, predecessor-hash mismatch, renamed-path mismatch, and stale-head cases;
- each approval resolves its own recorded registry version/hash;
- missing and unexpected C0/C1 policy keys both fail;
- ledger v2 preserves every canonical v1 approval byte-for-byte and cannot validate without its predecessor;
- Product and Engineering use distinct authorized actors outside `implementationActorIds` and bind one identical target;
- public/private CLI output reports both C0 and C1 accurately;
- the runtime still advertises the legacy 14-tool catalog at C1, proving the checkpoint did not prematurely perform Task 6.

- [ ] **Step 2: define one catalog descriptor table**

`TOOL_DEFINITIONS` is an ordered readonly descriptor array. Derive `TOOL_CATALOG`, `REMOVED_TOOL_NAMES`, the legacy→beta map, tool-name types, schema maps, renderer-key coverage, and the canonical catalog digest from it. Never maintain a second hand-written name or removed-name list.

Retain these approved beta names:

```ts
export const TOOL_CATALOG = [
  "search_ui_references",
  "get_ui_reference",
  "find_similar_ui_references",
  "compare_ui_references",
  "get_ui_taxonomy",
  "browse_ui_patterns",
  "plan_ui_direction",
  "create_ui_spec",
  "research_ui_anti_patterns",
  "research_ui_palettes",
  "research_ui_techniques",
  "critique_ui",
] as const;
```

No `aggregate_*`, `browse_ui_references`, or compatibility aliases. A future pre-1.0 revision requires a new design decision and coordinated skill migration.

- [ ] **Step 3: make C1 the executable Zod contract**

`src/tool-contracts.ts` is canonical. TypeScript types use `z.infer`; the design spec documents these schemas and Tasks 6–9 consume them rather than redefining them. Define:

- strict input and output-data schemas for all 12 tools;
- the complete versioned `UiSpec` schema, including sparse/unavailable states, evidence lanes, acceptance criteria, and authority precedence;
- a common envelope with canonical `tool`, `schemaVersion`, `status`, `summary`, `data`, `referenceIds`, `retrieval`, `warnings`, optional typed `evidence`, and optional typed `error`;
- `status: "ok"` requiring non-null tool data and no error;
- `status: "error"` requiring `data: null`, `{ code, message, retryable }`, and MCP `isError: true` at the runtime boundary;
- SDK argument/schema failures as protocol errors, distinct from application errors such as `NOT_FOUND`;
- claim-level evidence only for tools whose descriptor declares it; `plan_ui_direction`, `create_ui_spec`, and `critique_ui` always include an evidence array, with insufficiency warnings when empty.

Every result also preserves complete human-readable `content[0]`; runtime rendering is implemented later by the exhaustive descriptor-keyed registry in Task 7.

- [ ] **Step 4: define retrieval as a strict state matrix**

Amend §5.3 and encode the same matrix in Zod:

```ts
type RetrievalMode = "hybrid" | "vector" | "keyword" | "structured-fallback" | "none";
type RetrievalModality = "text" | "image" | "metadata" | "none";
type FallbackReason =
  | "missing-index"
  | "incompatible-index"
  | "missing-provider-key"
  | "community-edition"
  | "provider-error"
  | "no-image-evidence";
```

`modality` describes the query modality, not every internal candidate source. Image retrieval is `mode: "vector", modality: "image"`, never an undeclared `image-vector` mode. `fallbackUsed` is true only when an alternate path produced the returned result; the reason records why the preferred path was unavailable or failed. Attempted-but-unsuccessful paths remain in `attemptedModes`; terminal failure belongs in `error`, not `fallbackReason`.

Define allowed combinations per tool. At minimum, reject `none` with fallback, `vector` with `missing-index`, `structured-fallback` without a reason, and impossible modality/mode pairs. Distinguish intentional keyword operation from degraded keyword operation.

- [ ] **Step 5: lock exact per-tool and workflow behavior in the design spec**

For every tool, document exact inputs, defaults, constraints, output-data fields, evidence eligibility, empty behavior, partial behavior, application errors, retrieval states, and legacy behavior intentionally changed or retained. Explicitly define the three-list consolidation input/output for `get_ui_taxonomy`, all renamed argument compatibility, and the versioned `create_ui_spec` artifact.

- Research: taxonomy/browse as useful → search → inspect → compare/research aggregations.
- Build: `plan_ui_direction` → inspect cited references → `create_ui_spec` → implement.
- Review: `critique_ui` first → inspect cited references → prioritized fix queue → re-check.
- Routing suggests exactly one starting workflow but never restricts tool access.
- Build requires `create_ui_spec` unless an existing versioned artifact satisfies the same section/evidence/acceptance schema.
- Never require Search + two Gets before screenshot critique. If fewer than two relevant references exist, continue and disclose sparse coverage.

- [ ] **Step 6: add immutable checkpoint recipes and closed-world policies**

`CHECKPOINT_POLICIES` is code-owned and strict. Implement C0 and C1 now; Tasks 3–11 add C2–C5 policies with their schemas. Each policy enumerates exact required artifact types, source keys, contract keys, input keys, and approval roles. Missing, duplicate, and unexpected entries fail.

Each persisted checkpoint recipe records:

```ts
interface CheckpointSourceBinding {
  key: string;
  repositoryPath: string; // normalized repository-relative path
  gitCommit: string;      // exact 40-hex commit containing approved bytes
  sha256: string;         // SHA-256 of bytes resolved from that commit/path
}
```

The CLI supplies a Git-source resolver; the pure validator receives an injected resolver and never shells out. Resolution must use the exact recorded commit/path bytes, not the working tree. The validator then rebuilds the canonical target under the checkpoint policy and compares its SHA-256 with every approval.

Create a C0 recipe that reproduces the already-approved C0 target from its original Git-bound inputs. Prove that C1 edits to the live parent plan/spec do not reopen C0, while altered historical identity does fail.

- [ ] **Step 7: implement deterministic registry, index, and ledger chains**

Add explicit ordinal version and predecessor version/source/hash fields to registry, index, and ledger snapshots. Require exact `v1 → v2` progression, resolve predecessor bytes, reject forks, and require exactly one terminal head for each chain. Filenames never select authority.

- Preserve registry v1 for C0. Create registry v2 only after independent Product and Engineering actor assignments are supplied; neither may be an implementation actor.
- Resolve every approval against the exact registry version and SHA it records, never a global selected registry.
- Preserve index v1. Index v2 becomes the unique head and inventories all required evidence and registry snapshots under the v2 schema.
- Preserve ledger v1. Ledger v2 contains canonical byte-equivalent copies of every v1 approval plus the new C1 approvals and binds the exact v1 predecessor. Normal validation always verifies the full ledger chain; remove optional prior-ledger behavior.

- [ ] **Step 8: harden target and approval verification**

For every approval, validate the exact approved-artifact set, plan/spec/source/contract/input hashes, actor ID/kind/role, registry version/hash, checkpoint policy, common target SHA, and implementer independence. Only `decision: "approved"` plus `approvalKind: "checkpoint"` counts toward closure. Invalid approvals produce issues and cannot contribute roles.

Hash each resolved file/blob once per validation run. JSON and human CLI output must report the same checkpoint states. Exit codes remain `0` valid, `1` integrity failure, and `2` usage/configuration failure.

- [ ] **Step 9: review and commit the executable contract before approvals**

Run focused tests, the full suite, build, doctor, corpus/reference validation, and public/private readiness validation. Request the required task review, write its review artifact, and commit the spec, catalog, executable contracts, policy, validator, CLI, and tests. Record this commit as `C1_CONTRACT_SHA`; every C1 source binding resolves from it.

- [ ] **Step 10: create and approve the C1 history**

Pause for actor assignments and independent decisions. Create registry/index/ledger v2 and the C0/C1 recipes. Product and Engineering create separate C1 records bound to the exact catalog, tool-contract schemas, retrieval matrix, parent plan, design spec, readiness policy/validator, and `C1_CONTRACT_SHA`. The implementation worker may prepare draft records but may not create approved decisions for either actor.

Run both modes:

```bash
npm run validate-readiness-artifacts -- --mode public
npm run validate-readiness-artifacts -- --mode private --corpus-path corpus/entries.json
```

Expected: C0 and C1 both report `closed`; the private run also verifies corpus identity. Request a second task review over the governance artifacts, write its artifact, and commit only the owned C1 quality-contract files.

**C1 gate:** exact 12-tool executable contracts and workflows are approved; C0 remains historically reproducible; registry, index, and ledger chains have unique validated heads; Product and Engineering independently bind the same closed-world C1 target; runtime handlers still expose the legacy catalog until the atomic Phase 1B branch begins.

---

## Task 3: Select 35 reproducible entries and five challenge cases

**Files:**
- Create: `src/scripts/retag-gold-select.mts`
- Create: `src/scripts/retag-gold-select.test.mts`
- Create private: `eval/agent-readiness/runs/<run-id>/selection.json`
- Create tracked: `quality-contracts/agent-readiness/gold-manifest-v1.json`

**Produces:** exactly 35 algorithmic slots, five auditable challenge entries, reserves, hashes.

- [ ] **Step 1: test infeasible and sparse corpora first**

Fixtures must include more marginal values than slots, jointly incompatible marginal quotas, a greedy trap, singleton buckets, structurally dominant products, case/Unicode variants of the same product, absent DOM sidecars, tied gains, and removal/substitution.

- [ ] **Step 2: implement marginal quotas—not Cartesian strata**

Dimensions: pattern type, platform including `unknown`, quality tier, provenance, spacing density, DOM-sidecar availability, and separate coverage flags for components, domain tags, color scheme, mood, industry, and responsive behavior.

For dimension `d` with observed values `V_d`, mark the dimension infeasible when `|V_d| > 35`. Otherwise reserve one target credit per value, then Hamilton-allocate the remaining `35 - |V_d|` target credits using `w(d,v) = sqrt(population(d,v))`. These are best-effort marginal targets, not a false claim that independently allocated cross-dimension quotas are jointly feasible or that greedy selection finds a feasible solution.

At selection state `S`, define:

```text
quotaGain(e,S) = sum over each (d,v) on e of max(0, quota(d,v)-count(S,d,v)) / quota(d,v)
productPenalty(e,S) = 0.25 * count(S, product(e)) / 35
score(e,S) = quotaGain(e,S) - productPenalty(e,S)
```

Choose maximum score, then tie-break only with `SHA-256("clean-ui-retag-v1:<entry-id>")`. Report every unmet target and the entries/correlations that prevented the greedy choice; make no assertion that the target was mathematically impossible. The joint-infeasibility and greedy-trap fixtures must remain visibly unmet rather than being reported as covered. Normalize product identity with Unicode NFC, trim, and locale-independent lowercase. Cap a normalized product at four of 35 entries; exceeding the cap requires an explicit exception with corpus counts and Gold Label Owner + QA approval.

- [ ] **Step 3: make substitution local**

Persist 35 ordered slots. Assign each slot to the lowest-population marginal bucket whose unmet target that selection reduced, tie-breaking by dimension then value. Let each component of the deficit vector be `max(0, target(d,v) - count(S,d,v))`. A reserve is eligible only when the post-substitution deficit vector is component-wise no worse than before removal and the product ceiling still holds; order eligible reserves by score against `S` without the slot and then stable hash. If no reserve qualifies, do not claim local stability: re-run selection as a new artifact version, report every changed slot, and require Gold Label Owner approval.

- [ ] **Step 4: add five challenge entries before predictions exist**

Each contains an ambiguity class, rationale, curator role, image hash, and proof it does not duplicate the 35. Cover ambiguous pattern, compound layout, deceptive component boundary, rare pattern, and low-confidence evidence.

- [ ] **Step 5: assert the output contract**

Exactly 35 + 5 unique IDs; byte-identical output for the same seed/corpus SHA/algorithm version; explicit marginal coverage report; explicit infeasible exceptions; no private IDs in the tracked manifest. Record a reproducible selection rationale containing the dimensions, populations, quota math, per-slot gain/penalty/tie-break, challenge-case criteria, and algorithm version so a comparable set can be regenerated without curator memory.

---

## Task 4: Create independent annotations and adjudicated gold truth

**Files:**
- Create: `src/readiness/gold-labels.ts`
- Create: `src/readiness/gold-labels.test.ts`
- Create private: `eval/agent-readiness/runs/<run-id>/annotations/*.json`
- Create private: `eval/agent-readiness/runs/<run-id>/adjudication.json`
- Modify tracked: `quality-contracts/agent-readiness/gold-manifest-v1.json`

**Produces:** Checkpoint C2 with frozen rubric and adjudication hash.

- [ ] **Step 1: define the complete label schema**

Labels cover pattern type, categories, components, domain tags, visual fields, claim grounding, accessibility evidence, critique quality, and expected protected-field behavior. Every field declares scalar, multi-label, evidence, or editorial semantics.

- [ ] **Step 2: enforce independence**

Two pseudonymous labelers annotate all 40 images independently through a view that hides current corpus labels and all tagger output. Neither is the Tagger/Calibration Lead. The Gold Label Owner freezes the rubric and challenge set before annotation begins.

- [ ] **Step 3: adjudicate without rewriting history**

Raw annotations remain immutable. A separate adjudication records both annotation hashes, every disagreement, resolution, rationale, adjudicator role, and timestamps. Calibration code can read only the adjudicated artifact and cannot write annotations.

- [ ] **Step 4: measure label reliability**

Report scalar exact agreement and multi-label Jaccard/F1 agreement. Below 0.80 scalar agreement or 0.70 mean multi-label Jaccard triggers rubric review and a new annotation version before any provider baseline.

**C2 gate:** selection and rubric frozen; two blinded annotations complete; adjudication and reliability report validated; Gold Label Owner and QA approval records validate against the exact artifacts; only hashes/aggregates tracked.

## Amendment (2026-07-18): C2 grounded-design-handoff authority

This amendment references `docs/superpowers/specs/2026-07-18-grounded-design-workspace-design.md` and refines what the C2 (Gold readiness) checkpoint authorizes. It does not edit or rewrite the existing C1 sections of this plan; C1 tool-contract bytes remain historical authority.

C2 evaluates whether gold evidence supports safe, coherent, implementation-ready UiSpec decisions and live-source migration decisions. C2 does not implement hosted synthesis, persist customer projects, publish the private corpus, or permit project inspection to ingest corpus entries. Existing C1 tool-contract bytes remain historical authority; any executable contract change follows the repository checkpoint process rather than editing prior approvals.

The grounded-design workspace (source snapshot artifact at Task 2, bounded public-crawl planner and hosted SSRF guard at Task 3, ephemeral session/consent policy at Task 4, and the deterministic design-handoff scorer with its 12 briefs and 12 labels at Task 5) lands as **pre-C2 foundation work** only. The hosted generator, Playground conversion, Decision Lab integration, Curator Scout, authenticated capture, BYOK, and framework adapters are explicitly future plans and are not part of C2 completion. C2 itself remains open pending gold execution and the Gold Label Owner + QA approvals named above.

---

## Task 5: Implement dual-channel scoring and the live-safe runner

**Files:**
- Modify: `scripts/eval-scorer.mjs`
- Modify: `scripts/eval-scorer.test.mjs`
- Create: `scripts/eval-gold-baseline.mjs`
- Create: `scripts/eval-gold-baseline.test.mjs`
- Modify: `src/tagger.ts` only to add optional telemetry callbacks without changing normal output
- Modify: `package.json`

**Produces:** raw diagnostics, sanitized release metrics, gate-effect metrics, offline CI path, live opt-in path.

- [ ] **Step 1: lock corpus-level formulas**

For each label `l`: `TP`, `FP`, and `FN` are summed over entries; `F1_l = 2TP/(2TP+FP+FN)`. Undefined denominators are `null`. Macro-F1 averages labels with gold or predicted support; an empty supported-label set is `notScorable`, never a pass. Emit support counts and micro metrics. Per-entry empty/empty F1 may equal 1 only in diagnostic output, never in promotion floors.

- [ ] **Step 2: preserve both channels**

```ts
interface GoldRunScore {
  raw: {
    schemaParseSucceeded: boolean;
    bannedPhraseCount: number;
    unsupportedClaimCount: number;
    invalidEvidenceIdCount: number;
    invalidWcagIdCount: number;
  };
  sanitized: {
    schemaValid: boolean;
    patternExact: boolean;
    categories: MultiLabelScore;
    components: MultiLabelScore;
    domainTags: MultiLabelScore;
    visualFields: Record<string, boolean | "notScorable">;
    protectedFieldDiffs: string[];
  };
  gateEffect: {
    removedBannedPhrases: number;
    removedUnsupportedClaims: number;
    removedInvalidEvidenceIds: number;
  };
}
```

Only sanitized metrics authorize replacement/fill. Raw metrics expose model quality and reliance on enforcement. A sanitized failure remains in the 40-entry denominator.

- [ ] **Step 3: make Fill-only gates executable**

For each optional missing field: at least 10 positive and 10 negative opportunities, precision ≥0.95, FPR ≤0.05, 100% schema validity, and zero hard-gate failures. Zero prediction denominator is `notScorable` and cannot authorize automation.

- [ ] **Step 4: isolate CI from paid providers**

The runner accepts injected `tagImageFn`, corpus root, clock, and telemetry collector. CI uses deterministic fake outputs and tiny fixture images. Install a fetch guard that throws on non-loopback URLs. Provider-contract tests use a local fake HTTP server.

- [ ] **Step 5: instrument optional telemetry**

An optional callback records request count, retry count, latency, and provider usage when returned. Live runs require explicit per-million-token prices to forecast and enforce `MAX_COST_USD`; unavailable actual token usage remains `null` with `telemetryCompleteness`, never a fabricated zero.

- [ ] **Step 6: add the live command**

```json
"eval-gold-baseline": "tsc && node scripts/eval-gold-baseline.mjs"
```

It refuses to call the network unless all are present: `RUN_LIVE_INTEGRATION=1`, `LIVE_COST_APPROVED=1`, positive `MAX_COST_USD`, explicit provider/base URL/model, expected corpus SHA, gold selection hash, adjudication hash, and a validated private Budget Owner approval bound to the run ID, exact config hash, model/provider, and maximum cost. Environment flags merely unlock execution after that record validates; they are not approval evidence.

- [ ] **Step 7: implement the bounded calibration state machine**

Preserve the unchanged baseline. Permit at most two cycles. Each cycle records one scoped hypothesis/change set, owner, prompt/rule/reference hashes, cost ceiling, before/after scores, and decision. Gold labels and hard gates stay frozen. A threshold may change only for documented label disagreement, a demonstrated metric defect, or a revised product requirement—never to make a run pass. It requires a new quality-contract version, Product+QA approval, and an unchanged-tagger rebaseline before calibration continues. After cycle two, output is exactly `Qualified` or `Replacement not justified`; `Improvement required` is never terminal.

Define a material regression as a drop greater than five percentage points from the unchanged baseline for any tracked field-category metric, or any new hard-gate failure. Stop the cycle automatically on either condition; exceptions require a revised product requirement and a new contract version, not an in-run waiver.

---

## Task 6: Rename the catalog as the first commit of an atomic Phase 1B branch

**Files:**
- Modify: `src/server-factory.ts`
- Modify: `src/mcp-smoke.test.ts`
- Modify: `src/public-mcp-contract.test.ts`
- Modify: relevant docs/tests containing old names

**Produces:** renamed internal branch commit; not independently mergeable or releasable.

- [ ] **Step 1: write exact-catalog and stale-name tests**

Assert `tools/list` equals `TOOL_CATALOG`, every removed name is absent, and all 12 tools accept a valid fixture invocation. Scan server titles/descriptions/errors, skill files, workflows, references, README, and docs for removed names.

- [ ] **Step 2: consolidate taxonomy safely**

`get_ui_taxonomy` returns full schema values grouped as `availableValues` and `knownButUnrepresentedValues`, with counts computed through the injected reader. Public mode must never disclose private counts. Index health is a typed warning, not prose-only advice.

- [ ] **Step 3: derive server version from package metadata**

Add a tested helper that reads the root `package.json` relative to the compiled module. Initialization version must equal package version.

- [ ] **Step 4: rename handlers and descriptions**

Descriptions state “use when,” “do not use when,” output, fallback, and evidence limitations. Metadata-only users are never told to build a repository index.

**Interim rule:** this commit stays on the unreleased Phase 1B branch until Tasks 7–9 pass together.

---

## Task 7: Implement truthful retrieval metadata and the uniform envelope

**Files:**
- Create: `src/tool-result.ts`
- Create: `src/tool-result.test.ts`
- Create: `src/tool-renderers.ts`
- Create: `src/tool-renderers.test.ts`
- Create: `src/mcp-contract-matrix.test.ts`
- Modify: `src/corpus-reader.ts`
- Modify: `src/corpus-reader.test.ts`
- Modify: `src/corpus.ts`
- Modify: `src/corpus.test.ts`
- Modify: `src/critique-retrieval.ts`
- Modify: `src/critique-retrieval.test.ts`
- Modify: `src/server-factory.ts`
- Modify: `src/mcp-smoke.test.ts`
- Modify: `src/public-mcp-contract.test.ts`

**Interfaces:** Import the approved schemas from `src/tool-contracts.ts`; Task 7 must not redefine them. Zod remains canonical and TypeScript types use `z.infer`.

The retrieval layer—not the handler—owns operation metadata, including empty and failure paths:

```ts
interface RetrievalMeta {
  mode: RetrievalMode;
  modality: RetrievalModality;
  resultCount: number;
  fallbackUsed: boolean;
  fallbackReason?: FallbackReason;
  attemptedModes: RetrievalMode[];
  attemptedCount: number;
}

type RetrievalOutcome<T> =
  | { ok: true; items: T[]; meta: RetrievalMeta }
  | {
      ok: false;
      items: [];
      meta: RetrievalMeta;
      error: { code: string; retryable: boolean };
    };
```

Each reader exposes one ranked, metadata-bearing search operation rather than parallel `search()` and `searchRanked()` outcome builders. MCP callers derive plain entries from its items when needed; lower-level corpus scoring stays internal for Decision Lab and other non-MCP consumers. Similarity, plan, and critique retrieval return the same shape. Terminal failure cause lives in `error`, never in `fallbackReason`. `fallbackUsed` is true only when an alternate path actually produced the returned outcome; attempted-but-failed paths remain in `attemptedModes`. Handlers copy `meta` and `error` unchanged into the envelope; they never infer mode from the first result or fabricate it after an empty result/provider failure.

- [ ] **Step 1: implement the pre-approved uniform schema**

Use the exact C1 tool discriminator, success/error envelope, per-tool data schemas, retrieval matrix, and evidence rules. Register the matching non-null MCP `outputSchema` for all 12 tools. Any desired schema change reopens C1 rather than drifting here.

SDK argument-validation failures remain protocol errors. Search with no matches is a successful empty result with a typed warning. An unknown single `get_ui_reference` ID is a typed non-retryable `NOT_FOUND` application error. Compare returns `foundIds`, `missingIds`, and a warning for partial success; when every requested ID is missing it returns `NOT_FOUND`. An exhausted provider failure returns `data: null`, `isError: true`, and the approved typed error; it must not fabricate a partial artifact.

- [ ] **Step 2: implement the per-tool truth matrix**

| Tool | Mode/basis |
|---|---|
| taxonomy, get, compare, browse, research aggregations, create spec | `none`; direct/aggregation details live in data |
| search | `hybrid` when current combined path runs; otherwise `vector`, `keyword`, or `structured-fallback` |
| similar | `vector`; otherwise tag/text `structured-fallback` with warning—never “visually similar” |
| plan | `hybrid` preferred; keyword/structured fallback; absence of index is not an error |
| critique | `vector` + `image` modality when available; otherwise `structured-fallback` with caller-screen evidence kept separate |

`resultCount` is defined per primary payload: taxonomy `0`; get `0|1`; search/similar the number of references; compare the number of requested IDs found; browse the number of pattern groups; each research aggregation the number of aggregate rows; plan/spec/critique `1` only when a complete primary artifact exists, otherwise `0`. `referenceIds` are unique stable IDs represented in data/evidence. The C1 state matrix decides whether a fallback reason is allowed or required; do not reduce validation to a boolean-presence check.

- [ ] **Step 3: render legacy text through an exhaustive registry**

Every structured result carries its canonical tool discriminator. Implement a `Record<ToolName, ToolRenderer>` so TypeScript fails when a catalog entry lacks a renderer. Handlers parse structured output, then set:

```ts
content[0].text = renderToolResult(parsedStructuredContent.tool, parsedStructuredContent);
```

Tests cover every tool's success, empty, warning, partial, and error variants. Assert exact renderer equality and that summary, error, every warning, reference ID, acceptance criterion, and externally relevant fact appears in text. A client that ignores `structuredContent` must receive the complete experience.

- [ ] **Step 4: run the same matrix against three readers**

Use private fixture, asset-bearing public snapshot fixture, and metadata-only fixture (`resolveImagePath()`/`getImageIndex()` return `null`). Cover success, empty result, invalid input, single-ID `NOT_FOUND`, compare partial/all-missing, missing image, missing index, primary-failure/fallback-success, and terminal provider failure. Assert retrieval metadata originates in `RetrievalOutcome` and survives unchanged end to end for zero-result/failure paths, with no private/global fallback or fabricated image description.

---

## Task 8: Build `create_ui_spec` as a typed implementation handoff

**Files:**
- Create: `src/ui-spec.ts`
- Create: `src/ui-spec.test.ts`
- Modify: `src/server-factory.ts`
- Modify: `src/design-prompt.ts` only to delegate or remove superseded rendering

**Produces:** Checkpoint C3 acceptance model and complete handoff.

- [ ] **Step 1: implement the C1-approved input and output schemas**

Input: 0–5 `referenceIds`, required `productContext`, optional platform, `implementationFramework`, constraints, and design-system status/registry/library. Keep serialization format separate from implementation framework. With zero or one reference, return a schema-valid evidence-limited spec, emit typed `sparseCoverage`/`insufficientCorpusEvidence` warnings, mark unsupported decisions `unavailable`, and never invent corpus-backed claims.

Output sections: version/context; direction plus rejected defaults; layout regions and responsive rules; component inventory; tokens with authority; interactions; motion; accessibility; content/voice; techniques; anti-patterns; framework notes; acceptance criteria; source provenance.

Import `CreateUiSpecInput`, `UiSpec`, `CitedDecision`, and `AcceptanceCriterion` from `src/tool-contracts.ts`. Do not restate or widen them in `src/ui-spec.ts`. Task 8 implements the producer, authority resolver, and acceptance-criteria builder behind those schemas. Any contract change requires a revised catalog contract and C1 approval. The existing strict constraints remain: a manual criterion requires non-empty steps; automated criteria require the applicable selector or command; and `tokens.authority: "mixed"` is valid only when child decisions contain multiple actual authority lanes.

- [ ] **Step 2: define executable criteria**

Each criterion contains stable ID, subject, assertion (`exists`, `equals`, `uses-token`, `meets-contrast`, `keyboard-operable`, `has-accessible-name`, `responsive-at`, or `motion-respects-preference`), expected value, verifier (`axe`, `playwright`, `static-analysis`, or `manual`), selector/command/steps as applicable, `must|should`, and evidence IDs. Manual criteria require explicit steps and expected outcome.

- [ ] **Step 3: enforce evidence lanes**

Use the spec's exact evidence schema. IDs are response-scoped; cross-tool identity uses `referenceId`. `create_ui_spec` accepts IDs, not a screenshot, so it cannot emit screen or DOM evidence. Without persistent corpus motion metadata, motion is editorial and warning `motionEvidenceUnavailable` is mandatory.

- [ ] **Step 4: enforce token authority**

Hard machine accessibility and safety rules are non-overridable constraints. Within that boundary, precedence is team design system > explicit project constraints > corpus proposals > editorial defaults. Conflicts become structured warnings; neither a design system nor a project constraint may suppress a hard rule. With a team system, return semantic mappings/unresolved warnings, never paste-ready corpus hex/component authority. Without one, corpus-derived values are `proposed` and cited. Missing evidence returns unavailable/warnings, not current hard-coded fallback colors.

- [ ] **Step 5: test complete and sparse fixtures**

Separate tests cover every section, rejected defaults, content/voice, 0/1/2/5 references, source provenance, evidence combinations, motion warning, metadata-only operation, and at least layout/responsive, accessibility, and token acceptance criteria. Add partial-system and authority-conflict fixtures: unsafe team token versus hard rule, project constraint versus corpus proposal, and a missing team token filled by a cited proposal. Assert hard rules win, conflicts are typed, unsafe values are not implementation-ready, and every resolved value retains its real authority.

---

## Task 9: Rewrite and validate the single companion skill

**Files:**
- Modify: `skill/clean-ui-design/SKILL.md`
- Modify: `skill/clean-ui-design/agents/openai.yaml`
- Create: `skill/clean-ui-design/workflows/research.md`
- Create: `skill/clean-ui-design/workflows/build.md`
- Create: `skill/clean-ui-design/workflows/review.md`
- Modify: `skill/clean-ui-design/references/design-engineering.md`
- Modify: `skill/clean-ui-design/references/material-design-3.md`
- Create: `src/skill-catalog-wiring.test.ts`

- [ ] **Step 1: write discovery and wiring tests**

Assert exactly one discoverable skill, valid `agents/openai.yaml`, all workflow/reference files present, every explicit invocation belongs to `TOOL_CATALOG`, and every removed name fails even in prose. Define an explicit invocation syntax and test fenced calls, inline backticks, workflow tables, YAML, prose-only mentions, unknown tools, and removed aliases.

- [ ] **Step 2: implement workflow-specific grounding**

Use the Task 2 flows. Build must use `create_ui_spec` unless it loads an existing artifact through the same canonical `UiSpec` Zod parser and validates a supported `specVersion`, current product/context and constraint identity, every required section, unresolved required decisions, source/evidence-reference integrity, and acceptance criteria. Tests accept a valid equivalent and reject stale-version, malformed, context-mismatched, unresolved-required, and evidence-broken artifacts. Review starts with critique. Zero/one-reference sparse cases continue with typed disclosure rather than failing.

- [ ] **Step 3: document authority and degradation at first relevance**

Explain metadata-only distribution, optional `source.url`, provenance weighting, keyword/tag fallback versus visual similarity, missing image behavior, selective tagging, and design-system precedence. Never call `auto` material human-vetted.

- [ ] **Step 4: preserve reference integrity**

When reference Markdown changes, increment its positive revision ordinal, regenerate hashes/artifacts, and run `npm run validate-references`. The MCP rename and skill update remain one release unit.

- [ ] **Step 5: compute the atomic Phase 1B contract-bundle hash**

Build and pack the server once, then hash the exact tarball plus a canonical manifest containing source Git SHA; exact tool catalog; envelope and UiSpec schema versions; skill/router/workflow hashes; and reference-manifest hash. The tarball closes over all transitive runtime code, including `corpus.ts`, `corpus-reader.ts`, critique retrieval, handlers, schemas, and renderer. Install this exact tarball into the dogfood harness; do not dogfood the mutable source tree. C3, dogfood, and disposition reference the tarball and bundle hashes. Any runtime/skill/reference change requires a new artifact and invalidates prior dogfood.

**C3 gate:** all 12 registrations advertise output schemas; private/public/metadata-only matrices pass; `create_ui_spec` is complete; exactly one skill routes all workflows; no stale names remain; Product, QA, and Engineering ledger records validate against the atomic Phase 1B contract-bundle hash.

---

## Task 10: Dogfood fixed workflows with a versioned rubric

**Files:**
- Create: `src/readiness/dogfood.ts`
- Create: `src/readiness/dogfood.test.ts`
- Create: `scripts/dogfood-agent-harness.mjs`
- Create: `scripts/dogfood-agent-harness.test.mjs`
- Create private: `eval/agent-readiness/runs/<run-id>/dogfood-details.json`
- Create tracked: `quality-contracts/agent-readiness/dogfood-summary-v1.json`

- [ ] **Step 1: define fixed cases**

Run the real single-skill router and an MCP client against the authorized 787-entry private reader for private scenarios, and against the metadata-only fixture for distribution scenarios. The versioned harness loads the actual skill Markdown as its routing instruction, starts the exact installed Phase 1B tarball over stdio with the authorized reader configuration, and pins agent/provider/base URL/model, temperature/seed where supported, initial scenario prompt, tool-trace format, tarball hash, and contract-bundle hash. Review uses a fixed caller-provided screenshot kept in the ignored run. Include supported cases (normal, zero/one-reference sparse, no-index, missing-image/source, keyword fallback, partial-design-system conflict) plus invalid-equivalent-spec recovery and provider failure injected at Research, Build, and Review boundaries. Do not store screenshots, source code, prompts, URLs, or private bytes in the tracked summary.

Offline tests inject a deterministic fake agent and provider. The decision-grade dogfood run uses three repetitions per scenario and requires its own validated `LiveCostApproval`, bound to the dogfood run ID, harness/model/provider configuration hash, complete repetition matrix, and total maximum cost; Task 5's gold-run approval cannot authorize it. Its frozen prompt/model/config hashes remain private while sanitized hashes are tracked.

- [ ] **Step 2: score the workflow—not just field coverage**

Each run records scenario ID/hash, workflow, environment, tool trace, retrieval modes/modalities, warnings, reference count, artifact type, completion, selected recovery action, authority/evidence violations, degraded fields with severity, call count, reviewer usefulness rating, dogfood cost-approval hash, measured cost/token usage, and telemetry completeness. Version and freeze a five-point anchored rubric before execution across task completion, correctness/grounding, actionability, recovery clarity, and implementation readiness: `1` unsafe/unusable, `2` major recovery required, `3` safely usable with material gaps, `4` complete with minor gaps, `5` complete and independently actionable. Two reviewers score independently; a difference greater than one point or a pass/fail disagreement is adjudicated and both raw ratings remain immutable. Fixed cases, expected recovery actions, and screenshot hashes are frozen before execution.

- [ ] **Step 3: enforce the gate**

All three workflows complete in both environments for normal and supported-degradation cases; all 12 tools are exercised across cases; Build produces a schema-valid UiSpec; Review produces a prioritized fix queue; no false visual/image claim, stale tool name, evidence-lane collapse, or design-system authority violation occurs in any repetition. Normal cases require median ≥4/5 on every rubric dimension with no repetition below 3; supported-degradation cases require median ≥3/5 with no repetition below 2. Sparse and motion cases emit expected warnings. Invalid-spec and provider-failure injections pass only when the workflow selects the frozen safe recovery action, returns the specified typed warning/error, produces no fabricated artifact, and does not claim completion when completion is unsafe.

- [ ] **Step 4: validate and index dogfood evidence**

Validate the private run hashes and tracked summary, bind them to the exact Phase 1B bundle, update the artifact index, and collect Product+QA dogfood review records. This prepares but does not close C4; combined C4 approval occurs only after the terminal quality contract and identity joins validate.

Dogfood may prioritize fields for Phase 1C. It cannot change taxonomy, gold labels, hard gates, or thresholds.

---

## Task 11: Record the terminal quality outcome and corpus disposition

**Files:**
- Create: `src/readiness/disposition.ts`
- Create: `src/readiness/disposition.test.ts`
- Create tracked: `quality-contracts/agent-readiness/quality-contract-v1.json`
- Create tracked: `quality-contracts/agent-readiness/disposition-v1.json`
- Update: `quality-contracts/agent-readiness/artifact-index-v1.json`

- [ ] **Step 1: materialize and approve the terminal quality contract**

Derive the terminal contract from Task 5's unchanged baseline and bounded calibration history. Validate it and add it to the artifact index. The contract records its gold selection/adjudication hashes, prompt/rule/reference versions, model/provider identity, thresholds, raw/sanitized scores, and terminal outcome. It does not close C4 by itself.

- [ ] **Step 2: validate the applicable identity joins**

Gold, quality, and dogfood artifacts must share the frozen corpus and taxonomy identities. The quality contract must reference the exact selection and adjudication hashes it scored. Dogfood must reference the exact Phase 1B contract-bundle hash it exercised. Git, prompt, provider, rule, reference, and scenario identities are recorded per execution and are compared only where they are actual predecessor dependencies; they are not required to be globally equal. Missing dogfood, a broken predecessor hash, a stale bundle, or a corpus/taxonomy mismatch is invalid.

- [ ] **Step 3: close combined C4**

Create Eval Owner, Product, and QA ledger records bound to the terminal quality contract, validated dogfood summary, exact Phase 1B contract bundle, identity-join report, plan, and spec hashes. C4 becomes immutable only when all three approvals validate. C5 disposition evaluation must not begin earlier.

- [ ] **Step 4: enforce the decision table**

| Quality outcome | Field gates | Dogfood | Allowed disposition |
|---|---|---|---|
| Qualified | every replacement field has explicit passing floor | complete | Replacement |
| Qualified | any proposed replacement field lacks a floor | any | invalid |
| Replacement not justified | at least one optional missing field passes every Fill-only gate | complete | Fill-only or Deferred, chosen explicitly by PM + Corpus Owner with rationale |
| Replacement not justified | no field passes Fill-only gates | complete | Deferred |
| Improvement required | any | any | invalid/non-terminal |
| any identity mismatch | any | any | invalid |

- [ ] **Step 5: require an exhaustive field matrix**

Every candidate-writable field appears exactly once as `replace`, `fill`, `preserve`, or `protected`, with its metric/gate reference. Deferred has zero writable fields. Fill-only cannot name populated fields and cannot replace prose/classification. Replacement cannot name a field without a specific passing floor.

- [ ] **Step 6: record decision authority**

The tracked decision includes outcome, rationale, corpus and taxonomy hashes, Phase 1B bundle hash, field matrix, dogfood hash, quality-contract hash, and handoff plan. PM and Corpus Owner then create distinct C5 ledger approvals bound to the exact disposition hash.

- [ ] **Step 7: make the downstream path accurate**

This plan ends at approval, not corpus completion:

- Replacement → separate Phase 2–4 plan → replacement audit → Phase 5.
- Fill-only → separate Phase 2–4 reduced plan → reduced audit → Phase 5.
- Deferred → separate Phase 4 no-mutation completion plan producing the private 787-ID deferral artifact and tracked hash/aggregate → Phase 5.

Never route Deferred directly from Phase 1C to Phase 5.

**C4 gate:** terminal quality contract, approved/hash-bound dogfood, Phase 1B bundle, and identity joins are validated and indexed; Eval Owner, Product, and QA approvals bind the combined record.

**C5 gate:** 1A is terminal; atomic 1B contracts and dogfood pass; exactly one disposition validates; PM and Corpus Owner approve the exact target; no corpus mutation occurred.

---

## Final verification

```bash
npm run build
npx vitest run \
  src/readiness/contracts.test.ts \
  src/scripts/retag-gold-select.test.mts \
  src/readiness/gold-labels.test.ts \
  scripts/eval-scorer.test.mjs \
  scripts/eval-gold-baseline.test.mjs \
  scripts/dogfood-agent-harness.test.mjs \
  src/tool-catalog.test.ts \
  src/tool-contracts.test.ts \
  src/tool-result.test.ts \
  src/tool-renderers.test.ts \
  src/mcp-contract-matrix.test.ts \
  src/readiness/checkpoint-policy.test.ts \
  src/ui-spec.test.ts \
  src/skill-catalog-wiring.test.ts \
  src/readiness/dogfood.test.ts \
  src/readiness/disposition.test.ts
npm test
npm run validate-references
npm run validate-corpus
npm run doctor
npm run validate-readiness-artifacts -- --mode public
npm run validate-readiness-artifacts -- --mode private --corpus-path corpus/entries.json --private-artifact-root "$PRIVATE_ARTIFACT_ROOT"
```

Then run the C0 clean-clone matrix again at branch HEAD, request holistic review against this plan and the design spec, and write the branch review artifact before push.

## What already exists

- `src/readiness/contracts.ts` already provides strict artifact headers, canonical JSON/SHA-256 helpers, checkpoint-target construction, registry validation, and append-only comparison. Task 2 extends these rather than creating a second integrity system.
- `src/readiness/validator.ts` and the readiness CLI already parse the artifact graph, support public/private modes, validate C0 roles, and report checkpoint states. Task 2 hardens this shared boundary for C0–C1.
- Registry v1, artifact index v1, approval ledger v1, and the four C0 evidence artifacts already exist and remain immutable historical inputs.
- `src/server-factory.ts` registers the current 14 handlers through one injected `CorpusReader`; Task 6 renames those registrations after C1.
- `src/synthesis/contracts.ts` and `critique_ui` already prove MCP `outputSchema` plus `structuredContent` and complete legacy text. C1 generalizes that pattern without discarding the working critique path.
- `PrivateCorpusReader` and `PublicCorpusReader` already enforce corpus isolation and keyword-only public behavior. Task 7 adds truthful operation metadata at that boundary.
- `searchRanked`, keyword, vector, hybrid, and critique structured-fallback paths already exist. The work is to expose their actual outcomes, not invent another retrieval engine.
- `src/wiring-verification.test.ts`, `src/mcp-smoke.test.ts`, and `src/public-mcp-contract.test.ts` already enforce production wiring, catalog visibility, and public leak safety; the new tests extend these patterns.
- `skill/clean-ui-design/SKILL.md` is already the single discoverable skill. Task 9 rewrites its internal workflows in the same release as the runtime migration.
- Git-native task and branch review gates already enforce per-task and holistic review artifacts.

## C1 failure modes

| Failure | Handling | Required proof |
|---|---|---|
| C1 edits a plan/spec previously approved by C0 | Resolve C0 bytes from its recorded Git commit/path, never the working tree | C0 stays closed after a live-file edit |
| Historical Git object is unavailable in a shallow clone | Fail with the missing commit/path and remediation; CI checkout uses history deep enough to resolve every active recipe | shallow/missing-object fixture plus clean-clone CI |
| Approval omits the catalog or adds an unrelated contract | Closed-world checkpoint policy rejects missing and extra keys | one mutation per required key class |
| Registry, index, or ledger has two terminal heads | Reject the entire chain; filenames never choose authority | fork and duplicate-head fixtures |
| Predecessor file is renamed, missing, or altered | Resolve exact recorded version/source/hash and fail specifically | rename/missing/hash mutation tests |
| Ledger v2 deletes or changes a C0 approval | Reject v2 before any checkpoint can close | deletion and byte-mutation tests |
| Approver uses the wrong registry snapshot | Resolve that approval's recorded version/hash and reject mismatch | mixed v1/v2 approval fixture |
| Tool schema changes after C1 approval | Catalog/contract source hash and checkpoint target change; C1 reopens | one-byte contract mutation |
| Retrieval metadata expresses an impossible state | Strict Zod state matrix rejects it before response construction | allowed/forbidden combination table |
| Legacy-only client loses facts or errors | Exhaustive per-tool renderer includes all externally relevant structured fields | content/structured parity for every result variant |
| Runtime names change during contract-only C1 | Transitional MCP assertion fails | `tools/list` remains the legacy 14 at C1 |
| Implementation worker supplies an approval | Actor/implementation-set intersection rejects it | Product and Engineering self-approval fixtures |

No failure mode above may degrade silently. Integrity/configuration failures name the checkpoint, source key, expected identity, actual identity when safe, and recovery action.

## Worktree parallelization

| Lane | Work | Modules | Depends on |
|---|---|---|---|
| A | C1 executable contract and historical validator hardening | `docs/superpowers/specs/`, `src/tool-*`, `src/readiness/`, `src/scripts/` | C0 |
| B | C1 recipes, registry/index/ledger v2, independent approvals | `quality-contracts/agent-readiness/` | Lane A committed as `C1_CONTRACT_SHA` |
| C | Gold selection and labels | `src/scripts/`, `src/readiness/`, private eval artifacts | C1 |
| D | Atomic MCP/skill migration | `src/server-factory.ts`, readers/retrieval, tool result/renderers, `skill/` | C1 |

Lane A must remain sequential because contracts, policy, validator, and spec share hashes and interfaces. Lane B starts only after Lane A's reviewed commit supplies immutable Git source identities. After C1 closes, launch C and D in parallel worktrees; they share no primary module until later disposition/dogfood joins. Tasks 6–9 remain sequential inside Lane D because the unreleased runtime, envelope, `UiSpec`, and skill form one atomic release unit.

## Implementation Tasks

Synthesized from the C1 engineering review. Execute through Task 2 and its named downstream handoffs.

- [~] **T1 (P1, human: ~1 day / Codex: ~75 min)** — readiness integrity — Recompute checkpoints from immutable Git-bound recipes under closed-world C0/C1 policies.
  - Surfaced by: Architecture and outside review — current validation compares claimed target strings without resolving approved bytes.
  - Files: `src/readiness/contracts.ts`, `src/readiness/checkpoint-policy.ts`, `src/readiness/validator.ts`, readiness CLI/tests.
  - Verify: C0 stays closed after C1 live-file edits; historical source and policy mutations fail.
  - **Status (2026-07-16): C0-recipe core delivered by R0** (`dbcb06e`, see
    [`docs/AGENT_READINESS_STATUS.md`](../../AGENT_READINESS_STATUS.md)). The
    validator recomputes the canonical C0 target from Git-bound recorded-commit
    bytes, verifies every approval claim, and is fail-closed; C1 live-file edits
    leave C0 closed and tampered history reopens it. The broader closed-world
    C0/C1 policies and registry v2 chains remain under T2.
- [ ] **T2 (P1, human: ~1 day / Codex: ~75 min)** — governance chains — Add deterministic registry/index/ledger snapshot chains and per-approval registry resolution.
  - Surfaced by: Architecture and outside review — `.find()`/enumeration order cannot select version authority.
  - Files: readiness schemas/validator and `quality-contracts/agent-readiness/` v2 artifacts.
  - Verify: fork, duplicate-head, missing-predecessor, stale-head, ledger deletion, and mixed-registry tests.
- [ ] **T3 (P1, human: ~1.5 days / Codex: ~2 h)** — MCP contracts — Create one descriptor table and strict Zod input/output contracts for all 12 tools.
  - Surfaced by: Architecture/code quality — names alone do not lock behavior and three prose/schema copies had drifted.
  - Files: `src/tool-catalog.ts`, `src/tool-contracts.ts`, design spec, tests.
  - Verify: exact catalog, strict per-tool fixtures, success/error invariants, and catalog digest tests.
- [ ] **T4 (P1, human: ~5 h / Codex: ~45 min)** — retrieval truth — Encode the complete mode/modality/fallback state matrix.
  - Surfaced by: Architecture — independent enums permit contradictory retrieval claims.
  - Files: `src/tool-contracts.ts`, design spec, contract tests.
  - Verify: table-driven allowed and forbidden combination tests.
- [ ] **T5 (P2, human: ~1 day / Codex: ~75 min)** — reader boundary — Replace duplicate MCP reader search outcomes with one metadata-bearing operation.
  - Surfaced by: Code quality — parallel search wrappers would duplicate and drift metadata.
  - Files: Task 7 reader, corpus, critique retrieval, handler, and test files.
  - Verify: private/public/metadata-only contract matrix preserves exact retrieval metadata.
- [ ] **T6 (P2, human: ~1 day / Codex: ~60 min)** — compatibility rendering — Add the tool discriminator and exhaustive renderer registry.
  - Surfaced by: Code quality — a generic renderer cannot format twelve unrelated payloads.
  - Files: `src/tool-renderers.ts`, `src/tool-result.ts`, handlers/tests.
  - Verify: every success/empty/warning/partial/error result has exact text/structured parity.
- [ ] **T7 (P1, human: ~1.5 days / Codex: ~2 h)** — C1 test gate — Implement the complete catalog, contract, history, CLI, and C0-regression matrix before approval.
  - Surfaced by: Test review — the original Task 2 named only one catalog test.
  - Files: catalog/contracts/readiness unit and integration tests.
  - Verify: focused C1 matrix, full suite, build, doctor, corpus/reference checks, and both readiness modes.

## Explicitly out of scope

- Handler renaming, runtime envelope wiring, and skill migration during C1; Tasks 6–9 ship these atomically after contract approval.
- Compatibility aliases for the removed 14-tool names.
- A second retrieval engine, vector index, reranker, or persistent corpus motion schema.
- Cryptographic signatures, public keys, admin-root trust, or key rotation.
- Phase 2 shadow runs, direct-write route retirement, promotion, rollback, canary, and staged corpus mutation;
- Phase 4 Deferred 787-ID artifact execution;
- publication curation, `CommunityCorpusReader`, npm projection/publishing, and hosted infrastructure; the later Gate-2 release plan must use manual 2FA for the first `next` publish, then configure trusted-publishing/OIDC for subsequent publishes and promote the exact tested artifact;
- gold screenshot redistribution or public reproducibility from private bytes;
- persistent corpus motion schema;
- `review_ui_implementation`, multi-screen consistency, and design-system derivation;
- resumable orchestration and latency promotion gates.

## Execution handoff

Tasks 0–1 execute inside the isolated worktree and jointly close C0; Tasks 2 onward begin only after C0. Recommended execution is subagent-driven, one task at a time, with the repository-required review between tasks. The worker must pause for the named human labelers, adjudicator, and checkpoint approvers—it may prepare evidence but may not self-approve or impersonate independent roles. Do not start Task 3 or Task 6 until C1 is independently approved; do not run live gold calls until C2 is independently approved and explicit cost approval is present.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|---|---|---|---:|---|---|
| CEO Review | `/plan-ceo-review` | Scope and strategy | 0 | — | Not required for this contract-hardening increment |
| Codex Review | `/codex review` | Independent second opinion | 0 | — | Independent engineering subagent reviewed C1 instead |
| Eng Review | `/plan-eng-review` | Architecture and tests (required) | 1 | CLEAR | 10 engineering issues resolved; 0 critical gaps remain |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | No UI implementation in C1 |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | Not required for this internal contract gate |

**OUTSIDE VOICE:** Approved the ten engineering decisions and added four accepted mechanics: immutable historical byte resolution, deterministic registry/index heads, closed-world checkpoint policies, and mandatory versioned ledger history.

**VERDICT:** ENG CLEARED — C1 is implementation-ready after all accepted findings were incorporated.

NO UNRESOLVED DECISIONS
