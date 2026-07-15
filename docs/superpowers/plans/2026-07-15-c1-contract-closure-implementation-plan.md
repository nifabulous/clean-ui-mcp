# C1 Executable Contract Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close every remaining C1 executable-contract gap at `b8c754e`, prove the exact 12-tool contract with valid-fixture mutation tests, and complete one final adversarial gate before any C1 governance artifacts are created.

**Architecture:** Keep `TOOL_DESCRIPTORS` as the single code-owned catalog, but split semantic validation into focused, pure integrity helpers. Each descriptor owns its input/output schemas, retrieval policy, error and warning codes, ID extractors, result counter, and documentation metadata. One descriptor-derived Zod envelope remains canonical; MCP JSON Schema exposes its structural portion while runtime `safeParse` enforces cross-field semantics.

**Tech Stack:** TypeScript 5.9, Node.js 22.14+, Vitest 4, Zod 4, MCP SDK 1.29, Markdown contract documentation.

## Global Constraints

- Do not modify `corpus/entries.json`, `corpus/decisions.json`, private screenshots, readiness approvals, registries, indexes, ledgers, or checkpoint recipes.
- Preserve the unrelated working-tree changes in `CLAUDE.md`, `docs/superpowers/plans/2026-07-10-decision-lab-ui-redesign.md`, and `src/GBP movement.xlsx`.
- C1 remains a contract-and-governance phase: the runtime continues advertising the legacy 14-tool surface until Phase 1B Tasks 6–9.
- The exact beta catalog remains the approved 12 names in the approved order. No alias or additional tool may be introduced.
- `TOOL_DESCRIPTORS` remains the only source of tool names, legacy mappings, renderer keys, schemas, retrieval policy, evidence policy, error/warning codes, ID semantics, and documentation metadata.
- MCP `outputSchema` is the structural projection of the canonical Zod schema. Runtime `safeParse` additionally enforces semantic refinements that JSON Schema cannot express.
- `status: "error"` requires `data: null`, a typed application error, `referenceIds: []`, `resultCount: 0`, and `fallbackUsed: false`.
- `fallbackUsed: true` means an alternate path produced the returned successful result; it is never used for a terminal error or a zero-result response.
- `attemptedModes` records unsuccessful paths. A terminal error may therefore have `fallbackUsed: false` and non-empty `attemptedModes`.
- Envelope evidence IDs are authoritative. Nested data and provenance may reference them but may never create new evidence identities.
- `referenceIds` is the unique set of all corpus IDs represented by the result. Repeated use of one reference across multiple aggregation rows is valid.
- Hard machine rules remain non-overridable. Within them, authority order is team design system > project constraint > corpus evidence > editorial guidance.
- Tests must mutate one property from a known-valid fixture so a failure cannot pass for an unrelated reason.
- Normal CI remains offline and must not invoke external providers.
- Every task ends green, receives the repository-required task review, commits only its owned files, and records its review artifact. The final branch receives one holistic review.

---

## Governing invariant

For each of the exact 12 beta tools, there is exactly one descriptor-derived contract that:

1. accepts every documented valid input and result state;
2. rejects every undocumented or internally contradictory state;
3. preserves exact tool-specific TypeScript inference;
4. exposes truthful retrieval, reference, evidence, count, warning, and error metadata;
5. agrees mechanically with the human-readable §5.3–§5.5 design specification.

If a proposed fix cannot be expressed as descriptor policy, a shared pure integrity rule, or a tool-specific refinement referenced by the descriptor, stop and revise this plan rather than adding another validation path.

## Scope boundary

### In scope

- Valid input and success/error fixtures for all 12 tools.
- Retrieval state and fallback truth.
- Primary-ID versus referenced-ID semantics.
- Compare all-missing behavior.
- Plan, spec, and critique evidence-graph integrity.
- UiSpec authority, provenance, sparse-state, and motion-warning integrity.
- Critique retrieval metadata consistency.
- Executable defaults and exact per-tool TypeScript inference.
- §5.3–§5.5 documentation reconciliation and drift tests.

### Not in scope

- Runtime handler renaming or registration of the 12 beta names.
- `content[0].text` renderer implementation.
- Companion-skill migration.
- Corpus retagging, gold labels, or candidate generation.
- C1 policy, historical recipe, registry, index, ledger, or approval work.
- Changes to the corpus, public snapshot, npm package, or hosted transport.

## Planned file structure

| File | Responsibility |
|---|---|
| `src/tool-contracts.ts` | Zod schemas, descriptor declarations, descriptor-derived maps and envelope schemas |
| `src/tool-contract-integrity.ts` | Pure semantic set, retrieval, evidence, provenance, authority, and count validators |
| `src/__fixtures__/tool-contract-fixtures.ts` | One valid input, success result, and application-error result factory per tool |
| `src/tool-contracts.test.ts` | Table-driven fixture and one-mutation adversarial matrix |
| `src/tool-contract-types.test.ts` | Compile-time assertions for exact keys and inferred per-tool types |
| `src/tool-contract-docs.ts` | Deterministic renderer for the generated §5.3/§5.5 contract block |
| `src/tool-contract-docs.test.ts` | Documentation drift check against descriptor output |
| `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md` | Human contract with generated descriptor-owned matrix |

---

### Task 1: Establish valid fixtures for all 12 tools

**Files:**
- Create: `src/__fixtures__/tool-contract-fixtures.ts`
- Modify: `src/tool-contracts.test.ts`

**Interfaces:**
- Produces: `VALID_TOOL_INPUTS`, `makeValidSuccess(tool)`, `makeValidError(tool)`, and `cloneToolResult(result)`.
- Consumes: `ToolName`, `ToolInputSchemas`, `ToolResultSchemas`, and the current descriptor schemas.
- Constraint: fixtures contain synthetic IDs and no corpus/private data.

- [ ] **Step 1: Add the fixture API and exhaustive key types**

Create `src/__fixtures__/tool-contract-fixtures.ts` with this public surface:

```ts
import type { ToolName } from "../tool-contracts.js";

export type JsonObject = Record<string, unknown>;

export const VALID_TOOL_INPUTS = {
  search_ui_references: {},
  get_ui_reference: { id: "ref-a" },
  find_similar_ui_references: { id: "ref-a" },
  compare_ui_references: { ids: ["ref-a", "ref-b"] },
  get_ui_taxonomy: {},
  browse_ui_patterns: {},
  plan_ui_direction: { productContext: "A synthetic analytics dashboard" },
  create_ui_spec: { productContext: "A synthetic analytics dashboard" },
  research_ui_anti_patterns: {},
  research_ui_palettes: {},
  research_ui_techniques: {},
  critique_ui: {
    image_data: "c3ludGhldGlj",
    image_mime_type: "image/png",
  },
} as const satisfies Record<ToolName, JsonObject>;

export function makeValidSuccess(tool: ToolName): JsonObject;
export function makeValidError(tool: ToolName): JsonObject | null;
export function cloneToolResult<T>(value: T): T {
  return structuredClone(value);
}
```

Implement `makeValidSuccess` as an exhaustive `switch` over `ToolName`. Use this helper so every fixture starts from the same valid envelope fields:

```ts
function successEnvelope(
  tool: ToolName,
  data: JsonObject,
  referenceIds: string[],
  resultCount: number,
): JsonObject {
  return {
    tool,
    schemaVersion: "1.0",
    status: "ok",
    summary: "Synthetic valid result",
    data,
    referenceIds,
    retrieval: {
      mode: "none",
      modality: "none",
      resultCount,
      fallbackUsed: false,
      attemptedCount: 0,
      attemptedModes: [],
    },
    warnings: [],
  };
}
```

The exhaustive switch must use these exact fixture identities and counts:

| Tool | Synthetic data identity | `referenceIds` | `resultCount` |
|---|---|---|---|
| search | one complete `ReferenceSummary` with `id:"ref-a"` | `ref-a` | 1 |
| get | one complete `FullReference` with `id:"ref-a"` | `ref-a` | 1 |
| similar | one complete `SimilarReference` with `id:"ref-b"` | `ref-b` | 1 |
| compare | one complete row for `ref-a`, `foundIds:["ref-a"]`, `missingIds:["ref-b"]`, and `partialResult` warning | `ref-a` | 1 |
| taxonomy | one-value pattern/category/style lists with matching counts | none | 0 |
| browse | one dashboard group with exemplar `ref-a` | `ref-a` | 1 |
| plan | one complete plan, one `ref-a` contribution, and `evidence-corpus-a` | `ref-a` | 1 |
| spec | one complete UiSpec citing `ref-a`, with `evidence-corpus-a` used by decisions, criteria, lanes, and provenance | `ref-a` | 1 |
| anti-pattern research | one row sourced by `ref-a` | `ref-a` | 1 |
| palette research | one row sourced by `ref-a` | `ref-a` | 1 |
| technique research | one row sourced by `ref-a` | `ref-a` | 1 |
| critique | one complete critique applying `ref-a`, with every claim referencing `evidence-screen-a` or `evidence-corpus-a` | `ref-a` | 1 |

For plan, spec, and critique, add the required `evidence` property after calling `successEnvelope`; every nested evidence ID must point to one of those envelope items. For compare, add the required partial warning after calling the helper. `makeValidError` uses this exact table:

| Tool | Error fixture |
|---|---|
| search | `PROVIDER_ERROR`, retryable `true` |
| get | `NOT_FOUND`, retryable `false` |
| similar | `NOT_FOUND`, retryable `false` |
| compare | `NOT_FOUND`, retryable `false` |
| plan | `PROVIDER_ERROR`, retryable `true` |
| spec | `INVALID_INPUT`, retryable `false` |
| critique | `PROVIDER_ERROR`, retryable `true` |
| taxonomy/browse/research tools | `null` |

- [ ] **Step 2: Add exhaustive valid-fixture tests**

Add these tests to `src/tool-contracts.test.ts`:

```ts
describe.each(TOOL_CATALOG)("valid fixtures: %s", (tool) => {
  it("accepts its representative input", () => {
    expect(ToolInputSchemas[tool].safeParse(VALID_TOOL_INPUTS[tool]).success).toBe(true);
  });

  it("accepts its representative success result", () => {
    expect(ToolResultSchemas[tool].safeParse(makeValidSuccess(tool)).success).toBe(true);
  });

  it("accepts its representative application error when supported", () => {
    const fixture = makeValidError(tool);
    if (fixture !== null) {
      expect(ToolResultSchemas[tool].safeParse(fixture).success).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Replace tests that can pass for the wrong reason**

For each existing generic negative test, start with `cloneToolResult(makeValidSuccess(tool))` or a valid error fixture, mutate exactly one field, and assert that the issue path contains the intended property. Replace the current non-evidence assertion with a real parse:

```ts
const payload = cloneToolResult(makeValidSuccess(tool));
payload.evidence = [];
const result = ToolResultSchemas[tool].safeParse(payload);
expect(result.success).toBe(false);
if (!result.success) {
  expect(result.error.issues.some((issue) => issue.path[0] === "evidence")).toBe(true);
}
```

- [ ] **Step 4: Run the fixture matrix**

Run:

```bash
npx vitest run src/tool-contracts.test.ts --maxWorkers=1
```

Expected: all existing tests plus 24 input/success tests and every supported error fixture pass.

- [ ] **Step 5: Review and commit Task 1**

Run the required task review over only the fixture/test changes. Then commit:

```bash
git add src/__fixtures__/tool-contract-fixtures.ts src/tool-contracts.test.ts
git commit -m "test: add exhaustive tool contract fixtures"
```

---

### Task 2: Make retrieval metadata truthful and descriptor-specific

**Files:**
- Create: `src/tool-contract-integrity.ts`
- Modify: `src/tool-contracts.ts`
- Modify: `src/tool-contracts.test.ts`
- Modify: `src/__fixtures__/tool-contract-fixtures.ts`

**Interfaces:**
- Produces: `RetrievalPolicy`, `validateRetrievalState()`, and `validateEnvelopeRetrieval()`.
- Consumes: envelope `status`, descriptor retrieval policy, and `RetrievalState` structural fields.

- [ ] **Step 1: Write the retrieval regression matrix first**

Add one-mutation tests proving:

```ts
// Must reject: a fallback did not produce a result.
fallbackUsed = true;
resultCount = 0;

// Must accept: terminal failure records failed attempts without claiming fallback.
status = "error";
fallbackUsed = false;
attemptedModes = ["vector"];
attemptedCount = 1;

// Must reject: reason belongs only to critique.
tool = "search_ui_references";
fallbackReason = "no-image-evidence";

// Must reject: plan never attempts direct vector retrieval.
tool = "plan_ui_direction";
attemptedModes = ["vector"];

// Must reject: application error claims a successful fallback.
status = "error";
fallbackUsed = true;
```

Also cover intentional keyword success (`fallbackUsed:false`, no reason), degraded keyword success (`fallbackUsed:true`, allowed reason), structured fallback, normal primary success, zero-result normal success, and terminal provider failure.

- [ ] **Step 2: Define descriptor-owned retrieval policy**

Add these types to `src/tool-contract-integrity.ts`:

```ts
export type RetrievalMode = "hybrid" | "vector" | "keyword" | "structured-fallback" | "none";
export type RetrievalModality = "text" | "image" | "metadata" | "none";
export type FallbackReason =
  | "missing-index"
  | "incompatible-index"
  | "missing-provider-key"
  | "community-edition"
  | "provider-error"
  | "no-image-evidence";

export interface RetrievalPolicy {
  readonly states: readonly {
    mode: RetrievalMode;
    modality: RetrievalModality;
    fallbackReasons: readonly FallbackReason[];
  }[];
  readonly attemptedModes: readonly RetrievalMode[];
}
```

Replace each descriptor's `retrieval` array with `retrievalPolicy`. Use these exact policies:

| Tool class | Returned states | Allowed fallback reasons | Allowed attempted modes |
|---|---|---|---|
| taxonomy/get/compare/browse/research/spec | `none/none` | none | none |
| search | `hybrid/text`, `vector/text`, `keyword/text`, `keyword/metadata`, `structured-fallback/metadata`, `none/none` | all except `no-image-evidence` | hybrid, vector, keyword, structured-fallback |
| similar | `vector/text`, `structured-fallback/metadata`, `none/none` | missing/incompatible index, missing key, community edition, provider error | vector, structured-fallback |
| plan | `hybrid/text`, `keyword/text`, `keyword/metadata`, `structured-fallback/metadata`, `none/none` | missing/incompatible index, missing key, community edition, provider error | hybrid, keyword, structured-fallback |
| critique | `vector/image`, `structured-fallback/metadata`, `none/none` | all six reasons | vector, structured-fallback |

Assign reasons to returned states exactly as follows:

| Tool | Returned state | Allowed reasons |
|---|---|---|
| search | hybrid/text, vector/text, none/none | none |
| search | keyword/text or keyword/metadata | missing-index, incompatible-index, missing-provider-key, provider-error |
| search | structured-fallback/metadata | missing-index, incompatible-index, missing-provider-key, community-edition, provider-error |
| similar | vector/text, none/none | none |
| similar | structured-fallback/metadata | missing-index, incompatible-index, missing-provider-key, community-edition, provider-error |
| plan | hybrid/text, none/none | none |
| plan | keyword/text or keyword/metadata | missing-index, incompatible-index, missing-provider-key, provider-error |
| plan | structured-fallback/metadata | missing-index, incompatible-index, missing-provider-key, community-edition, provider-error |
| critique | vector/image, none/none | none |
| critique | structured-fallback/metadata | missing-index, incompatible-index, missing-provider-key, community-edition, provider-error, no-image-evidence |

- [ ] **Step 3: Separate structural and envelope retrieval validation**

Keep `RetrievalState` responsible for:

- valid field types;
- mode/modality compatibility;
- `attemptedCount === attemptedModes.length`;
- non-empty, unique attempted modes with no `"none"`;
- reason presence exactly when `fallbackUsed` is true.

Move status- and tool-dependent checks into:

```ts
export function validateEnvelopeRetrieval(
  status: "ok" | "error",
  retrieval: RetrievalStateT,
  policy: RetrievalPolicy,
  ctx: z.RefinementCtx,
): void;
```

Enforce all of the following with `ctx.addIssue({code:"custom", path, message})` at the named retrieval field:

- Error status requires `fallbackUsed:false` and no `fallbackReason`; attempted modes remain allowed.
- Fallback requires success status, positive `resultCount`, a reason allowed by the selected returned state, and at least one attempted mode.
- Successful non-fallback results require an empty attempted-mode list.
- Every attempted mode must appear in `policy.attemptedModes`.
- The returned mode/modality pair must appear in `policy.states`.

- [ ] **Step 4: Derive the public retrieval matrix from policy**

Derive `ALLOWED_RETRIEVAL_STATES` from `descriptor.retrievalPolicy.states`. Remove all independent state lists. Update fixtures so application errors use `mode:"none"` with the actual failed operations in `attemptedModes`.

- [ ] **Step 5: Run focused tests**

Run:

```bash
npx vitest run src/tool-contracts.test.ts --maxWorkers=1
```

Expected: all retrieval mutation cases pass, including terminal attempts without a fallback.

- [ ] **Step 6: Review and commit Task 2**

```bash
git add src/tool-contract-integrity.ts src/tool-contracts.ts src/tool-contracts.test.ts src/__fixtures__/tool-contract-fixtures.ts
git commit -m "fix: enforce truthful retrieval contracts"
```

---

### Task 3: Separate primary IDs from referenced IDs and close result semantics

**Files:**
- Modify: `src/tool-contract-integrity.ts`
- Modify: `src/tool-contracts.ts`
- Modify: `src/tool-contracts.test.ts`
- Modify: `src/__fixtures__/tool-contract-fixtures.ts`

**Interfaces:**
- Produces: `extractPrimaryIds`, `extractReferenceIds`, `validateUniquePrimaryIds()`, and `validateExactReferenceSet()` descriptor hooks.
- Removes: the generic assumption that every repeated referenced ID is an invalid duplicate row.

- [ ] **Step 1: Write failing ID-semantic tests**

Add these cases from valid fixtures:

```ts
// Duplicate primary search rows must fail.
search.data.results = [refA, refA];

// One reference supporting two anti-pattern rows must pass.
anti.data.results = [
  { text: "Avoid A", sourceIds: ["ref-a"], count: 1 },
  { text: "Avoid B", sourceIds: ["ref-a"], count: 1 },
];
anti.referenceIds = ["ref-a"];

// One reference supporting two technique rows must pass.
techniques.data.results = [techniqueAFromRefA, techniqueBFromRefA];
techniques.referenceIds = ["ref-a"];

// Reference IDs remain a unique exact union.
anti.referenceIds = ["ref-a", "ref-a"]; // reject
anti.referenceIds = []; // reject
anti.referenceIds = ["ref-a", "ref-ghost"]; // reject
```

Add compare cases for duplicate `foundIds`, duplicate `missingIds`, overlap, mismatched entry IDs, partial warning in both directions, and all IDs missing.

- [ ] **Step 2: Replace `extractRefs` with two explicit functions**

Update `ToolDescriptor`:

```ts
interface ToolDescriptor {
  extractPrimaryIds(data: unknown): readonly string[];
  extractReferenceIds(data: unknown): readonly string[];
  countResults(data: unknown): number;
}
```

Use these semantics:

| Tool | Primary IDs | Referenced IDs |
|---|---|---|
| search/similar | result row IDs | result row IDs |
| get | record ID | record ID |
| compare | entry IDs | `foundIds` |
| taxonomy | none | none |
| browse | pattern types | exemplar IDs |
| plan | none | `evidenceContributions` |
| spec | none | `citedReferences` |
| anti-pattern research | none | flattened `sourceIds` |
| palette research | none | `sourceId` values |
| technique research | none | `source.id` values |
| critique | none | `appliedReferences[].id` |

- [ ] **Step 3: Implement primary and reference validation**

Add:

```ts
export function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

export function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((value) => b.has(value));
}
```

The envelope validator must:

- reject duplicate `referenceIds`;
- reject duplicate non-empty `extractPrimaryIds(data)` values;
- compare `referenceIds` with `unique(extractReferenceIds(data))`;
- allow the same referenced ID to appear in multiple rows;
- require non-empty trimmed IDs at every ID-bearing schema field.

- [ ] **Step 4: Enforce compare terminal and partial states**

For successful `compare_ui_references`, add a custom issue unless `foundIds` is non-empty, entry IDs and `foundIds` are exact sets, found/missing IDs are unique and disjoint, and the `partialResult` warning is present exactly when `missingIds` is non-empty.

An all-missing result must use the valid `NOT_FOUND` error fixture. Do not accept `status:"ok"` with empty `foundIds` and non-empty `missingIds`.

- [ ] **Step 5: Reconcile critique's duplicate retrieval fields**

Keep `retrieval` on the envelope canonical. Until `StructuredCritique` is versioned to remove its legacy fields, add a critique envelope refinement that reports `data.retrievalMode` unless it equals `retrieval.mode`, and reports `data.fallbackUsed` unless it equals `retrieval.fallbackUsed`.

Pass `retrieval` into the descriptor envelope refinement context.

- [ ] **Step 6: Run focused tests and commit**

```bash
npx vitest run src/tool-contracts.test.ts src/synthesis/structured-output.test.ts --maxWorkers=1
git add src/tool-contract-integrity.ts src/tool-contracts.ts src/tool-contracts.test.ts src/__fixtures__/tool-contract-fixtures.ts
git commit -m "fix: close result and reference ID semantics"
```

Expected: repeated aggregation sources pass; duplicate primary rows and compare all-missing success fail.

---

### Task 4: Close plan, UiSpec, and critique evidence graphs

**Files:**
- Modify: `src/tool-contract-integrity.ts`
- Modify: `src/tool-contracts.ts`
- Modify: `src/tool-contracts.test.ts`
- Modify: `src/__fixtures__/tool-contract-fixtures.ts`

**Interfaces:**
- Produces: `validatePlanEvidenceGraph()`, `validateUiSpecEvidenceGraph()`, and `validateCritiqueEvidenceGraph()`.
- Authority: the envelope's `evidence[].id` set is the only valid evidence-ID namespace.

- [ ] **Step 1: Write the ghost-evidence mutation matrix**

For every path below, clone a valid success fixture, replace one real evidence ID with `"evidence-ghost"`, and assert failure at that path.

Plan paths:

- `data.structuredDecisions[].evidenceIds[]`.

UiSpec paths:

- `data.acceptanceCriteria[].evidenceIds[]`;
- `data.citedDecisions[].evidenceIds[]`;
- every `data.authorityLanes` array;
- `data.provenance.evidenceIds[]`.

Critique paths:

- `data.evidenceIds[]`;
- `data.recommendations[].evidence[]`;
- `data.accessibilityRisks[].evidence`;
- `data.visualSlop[].evidence[]`;
- `data.motion[].evidence[]`;
- `data.md3.evidenceIds[]`;
- `data.md3.conflictingSignals[].evidenceId`.

Also prove that adding `"evidence-ghost"` to provenance does not authorize it elsewhere.

- [ ] **Step 2: Implement reusable evidence-reference validation**

Add:

```ts
export function validateEvidenceReferences(
  actualEnvelopeIds: ReadonlySet<string>,
  references: readonly { path: PropertyKey[]; ids: readonly string[] }[],
  ctx: z.RefinementCtx,
): void;
```

For each reference list:

- reject empty/whitespace IDs;
- reject duplicates within that list;
- reject every ID absent from the envelope set;
- report the exact nested path.

Do not union provenance IDs into the authoritative set.

- [ ] **Step 3: Define exact provenance semantics**

For `create_ui_spec`, enforce:

```ts
sameSet(data.provenance.sourceReferences, data.citedReferences);
sameSet(data.provenance.evidenceIds, envelope.evidence.map((item) => item.id));
sameSet(referenceIds, data.citedReferences);
```

Require unique, non-empty `citedReferences`, `provenance.sourceReferences`, and `provenance.evidenceIds`.

- [ ] **Step 4: Validate source-reference paths**

Require every corpus source ID in these paths to belong to `data.citedReferences`:

- `data.citedDecisions[].sourceId` when present;
- `data.techniques[].sourceIds[]`;
- `data.antiPatterns[].sourceIds[]`;
- `data.componentInventory[].sourceId` when present.

Rename `ComponentEntry.source` to `sourceId` in the C1 contract so the field has one unambiguous meaning. Update fixtures and the design specification in Task 7.

- [ ] **Step 5: Validate critique reference paths**

Require:

- unique `data.appliedReferences[].id`;
- exact equality between `referenceIds` and applied reference IDs;
- motion `reference` values, when they use the `ref:<id>` form, to resolve to an applied reference ID;
- editorial motion without a corpus reference to use editorial evidence rather than inventing a corpus ID.

- [ ] **Step 6: Run focused tests and commit**

```bash
npx vitest run src/tool-contracts.test.ts src/synthesis/render.test.ts src/synthesis/structured-output.test.ts --maxWorkers=1
git add src/tool-contract-integrity.ts src/tool-contracts.ts src/tool-contracts.test.ts src/__fixtures__/tool-contract-fixtures.ts
git commit -m "fix: enforce closed synthesis evidence graphs"
```

Expected: every ghost evidence/source mutation fails at its own path; valid plan/spec/critique fixtures pass.

---

### Task 5: Enforce UiSpec authority, sparse-state, and motion rules

**Files:**
- Modify: `src/tool-contract-integrity.ts`
- Modify: `src/tool-contracts.ts`
- Modify: `src/tool-contracts.test.ts`
- Modify: `src/__fixtures__/tool-contract-fixtures.ts`

**Interfaces:**
- Produces: `validateUiSpecAuthority()` and `validateUiSpecAvailability()`.
- Adds warning code: `authorityConflict` for unresolved equal-field authority conflicts.

- [ ] **Step 1: Add authority and availability mutation tests**

Cover these exact cases:

| Case | Expected |
|---|---|
| non-null tokens, `team-design-system`, no identified design system | reject |
| team authority, identified registry/library, matching cited decision | accept |
| `project-constraint` authority with no preserved constraint | reject |
| `corpus-evidence` authority without corpus evidence ID | reject |
| `editorial` authority without editorial evidence ID | reject |
| one child authority lane | aggregate authority equals that lane |
| multiple child lanes across token fields | aggregate authority is `mixed` |
| conflicting lanes for the same field | require `authorityConflict` warning |
| null color/typography tokens | editorial authority plus matching unavailable decision |
| motion evidence unavailable | matching unavailable decision plus `motionEvidenceUnavailable` warning |
| motion evidence available | reject `motionEvidenceUnavailable` warning |

- [ ] **Step 2: Preserve project constraints in UiSpec context**

Add a required array to `SpecContext`:

```ts
constraints: z.array(z.string().min(1).trim()),
```

Set `CreateUiSpecInput.constraints` to the same element schema with `.default([])`. `create_ui_spec` must copy the normalized input constraints into the required artifact context during Phase 1B. For C1 fixtures, explicitly include the array so authority validation has a stable source.

- [ ] **Step 3: Implement exact token-group authority validation**

For each group (`color`, `typography`):

1. Select available/proposed cited decisions whose `field` is in that group.
2. Validate each decision's authority prerequisites:
   - `team-design-system`: `context.designSystem.status === "identified"`;
   - `project-constraint`: `context.constraints.length > 0`;
   - `corpus-evidence`: at least one referenced envelope evidence item is `corpus-observation`;
   - `editorial`: at least one referenced envelope evidence item is `editorial-guidance`.
3. Compute distinct actual lanes.
4. Require the aggregate token authority to equal the single lane or `mixed` when multiple lanes are present.
5. When the same exact field contains conflicting lanes, require `authorityConflict`; downstream implementation must not treat that field as resolved.

The precedence order selects the leading recommendation but never erases the lower-lane conflict disclosure.

- [ ] **Step 4: Implement exact sparse and motion warning rules**

Use exact normalized field identifiers instead of substring matching:

```ts
const UNAVAILABLE_FIELDS = z.enum(["colorTokens", "typographyTokens", "motion"]);
```

Require one matching unavailable decision for every null/unavailable section and reject contradictory unavailable decisions for available sections.

At envelope level, compute `hasMotionWarning` with `warnings.some((warning) => warning.code === "motionEvidenceUnavailable")` and add a custom issue unless it exactly equals `data.motionGuidance.evidenceUnavailable`.

- [ ] **Step 5: Run focused tests and commit**

```bash
npx vitest run src/tool-contracts.test.ts --maxWorkers=1
git add src/tool-contract-integrity.ts src/tool-contracts.ts src/tool-contracts.test.ts src/__fixtures__/tool-contract-fixtures.ts
git commit -m "fix: enforce UI spec authority and availability"
```

Expected: every authority source is provable; sparse and motion states have exact matching decisions and warnings.

---

### Task 6: Preserve executable defaults and exact TypeScript inference

**Files:**
- Modify: `src/tool-contracts.ts`
- Create: `src/tool-contract-types.test.ts`
- Modify: `src/tool-contracts.test.ts`
- Modify: `src/__fixtures__/tool-contract-fixtures.ts`

**Interfaces:**
- Produces: `ToolInputByName<N>`, `ToolDataByName<N>`, `ToolResultByName<N>`, and exact-key schema maps.
- Removes: exported `Record<string, z.ZodType>` widening.

- [ ] **Step 1: Write default-value tests**

Assert these exact parsed outputs:

```ts
expect(ToolInputSchemas.search_ui_references.parse({}).limit).toBe(5);
expect(ToolInputSchemas.find_similar_ui_references.parse({ id: "ref-a" }).limit).toBe(5);
expect(ToolInputSchemas.plan_ui_direction.parse({ productContext: "A dashboard" })).toMatchObject({
  qualityTier: "exceptional",
  count: 3,
});
expect(ToolInputSchemas.create_ui_spec.parse({ productContext: "A dashboard" })).toMatchObject({
  referenceIds: [],
  serializationFormat: "brief",
});
expect(ToolInputSchemas.research_ui_anti_patterns.parse({}).limit).toBe(10);
expect(ToolInputSchemas.research_ui_palettes.parse({}).limit).toBe(10);
expect(ToolInputSchemas.research_ui_techniques.parse({}).limit).toBe(15);
```

- [ ] **Step 2: Encode all documented defaults in Zod**

Use `.default()` rather than handler-owned fallback values:

```ts
limit: z.number().int().min(1).max(20).default(5);
qualityTier: z.enum(["exceptional", "cautionary"]).default("exceptional");
count: z.number().int().min(1).max(5).default(3);
```

Apply the research limits from Step 1. Preserve current optional fields without documented defaults.

- [ ] **Step 3: Introduce a const-generic descriptor definition helper**

Use:

```ts
export function defineToolDescriptors<
  const T extends readonly ToolDescriptor[],
>(descriptors: T): T {
  return descriptors;
}
```

Wrap the existing 12-element descriptor literal with this helper without copying or rebuilding the descriptor entries.

Keep `name`, `rendererKey`, `legacyNames`, input schema, data schema, warning codes, error codes, and retrieval policy literal types intact.

- [ ] **Step 4: Derive exact-key schema maps**

Add mapped types:

```ts
type Descriptor = (typeof TOOL_DESCRIPTORS)[number];
type DescriptorFor<N extends ToolName> = Extract<Descriptor, { name: N }>;

export type ToolInputSchemaMap = {
  [N in ToolName]: DescriptorFor<N>["inputSchema"];
};

export type ToolDataSchemaMap = {
  [N in ToolName]: DescriptorFor<N>["dataSchema"];
};

export type ToolInputByName<N extends ToolName> = z.infer<ToolInputSchemaMap[N]>;
export type ToolDataByName<N extends ToolName> = z.infer<ToolDataSchemaMap[N]>;
export type ToolResultByName<N extends ToolName> = z.infer<(typeof ToolResultSchemas)[N]>;
```

Use one localized, explained cast inside the descriptor-indexing helper. Do not export a string-indexed map.

- [ ] **Step 5: Build real discriminated error variants**

Define literal variants once:

```ts
const ERROR_VARIANTS = {
  NOT_FOUND: z.object({ code: z.literal("NOT_FOUND"), message: NonEmptyText, retryable: z.literal(false) }).strict(),
  INDEX_UNAVAILABLE: z.object({ code: z.literal("INDEX_UNAVAILABLE"), message: NonEmptyText, retryable: z.literal(true) }).strict(),
  PROVIDER_ERROR: z.object({ code: z.literal("PROVIDER_ERROR"), message: NonEmptyText, retryable: z.literal(true) }).strict(),
  INVALID_INPUT: z.object({ code: z.literal("INVALID_INPUT"), message: NonEmptyText, retryable: z.literal(false) }).strict(),
} as const;
```

Descriptor error schemas must be unions of the selected variants, not `{code: enum, retryable:boolean}` plus a refinement. Tools with no application errors use `z.never().optional()`.

- [ ] **Step 6: Add compile-time contract assertions**

In `src/tool-contract-types.test.ts`, use type assignments and `@ts-expect-error` assertions:

```ts
const searchInput: ToolInputByName<"search_ui_references"> = { limit: 5 };
void searchInput;

// @ts-expect-error unknown tool keys must not compile
ToolInputSchemas.not_a_tool;

const notFound: ToolResultByName<"get_ui_reference">["error"] = {
  code: "NOT_FOUND",
  message: "missing",
  retryable: false,
};
void notFound;

const invalidRetryability: ToolResultByName<"get_ui_reference">["error"] = {
  code: "NOT_FOUND",
  message: "missing",
  // @ts-expect-error NOT_FOUND is never retryable
  retryable: true,
};
void invalidRetryability;
```

Because test files are excluded from the production `tsconfig`, add a dedicated script:

```json
"typecheck:contracts": "tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --skipLibCheck src/tool-contract-types.test.ts"
```

- [ ] **Step 7: Run type and runtime tests, then commit**

```bash
npm run typecheck:contracts
npx vitest run src/tool-contracts.test.ts --maxWorkers=1
npm run build
git add package.json src/tool-contracts.ts src/tool-contracts.test.ts src/tool-contract-types.test.ts src/__fixtures__/tool-contract-fixtures.ts
git commit -m "refactor: preserve exact tool contract types"
```

Expected: unknown map keys and invalid retryability fail compilation; all documented defaults are present after parsing.

---

### Task 7: Reconcile and mechanically lock §5.3–§5.5 documentation

**Files:**
- Create: `src/tool-contract-docs.ts`
- Create: `src/tool-contract-docs.test.ts`
- Modify: `src/tool-contracts.ts`
- Modify: `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md`

**Interfaces:**
- Produces: `renderToolContractReference(TOOL_DESCRIPTORS): string`.
- Adds descriptor field: `contractDocs`, containing human descriptions that cannot be inferred reliably from Zod.

- [ ] **Step 1: Add descriptor documentation metadata**

Extend each descriptor with:

```ts
interface ToolContractDocs {
  input: string;
  successData: string;
  empty: string;
  partial: string;
  resultCount: string;
  referenceIds: string;
}
```

Derive tool name, defaults, errors, warnings, evidence eligibility, and retrieval states from executable descriptor fields. Keep only prose descriptions that Zod cannot supply in `contractDocs`.

- [ ] **Step 2: Generate the authoritative contract block**

Add the literal markers `<!-- GENERATED_TOOL_CONTRACTS_START -->` and `<!-- GENERATED_TOOL_CONTRACTS_END -->` around the descriptor-rendered §5.3 and §5.5 block in the design specification.

`renderToolContractReference()` must output, for every tool in order:

- exact input fields and defaults;
- exact success-data field summary;
- empty and partial behavior;
- exact warning and error codes with retryability;
- exact retrieval states and fallback reasons;
- evidence eligibility;
- result-count rule;
- reference-ID rule.

- [ ] **Step 3: Correct every known schema/document mismatch**

The generated block must explicitly include:

- search `ReferenceSummary.title` and `antiPatterns`;
- `source.url` as required-but-nullable in both schema and prose, so missing URLs serialize explicitly as `null`;
- search and similar `PROVIDER_ERROR`;
- `ComparisonRow.title` and `whereItFails`;
- `PaletteRecord.patternType`;
- `PatternGroup.topProducts` and exemplar critique;
- `SimilarReference.basis`;
- all executable defaults from Task 6;
- plan and critique primary-artifact result count of `1`;
- `static-analysis` verifier;
- terminal attempted-mode semantics from Task 2.

- [ ] **Step 4: Add the drift test**

`src/tool-contract-docs.test.ts` reads the Markdown file, extracts the marker-delimited block, and compares it byte-for-byte with `renderToolContractReference(TOOL_DESCRIPTORS)`:

```ts
expect(extractGeneratedBlock(specText)).toBe(
  renderToolContractReference(TOOL_DESCRIPTORS),
);
```

Also assert all 12 tool headings occur exactly once and all 13 removed names occur only in the migration table, not in the generated beta contract.

- [ ] **Step 5: Run documentation and contract tests**

```bash
npx vitest run src/tool-contract-docs.test.ts src/tool-contracts.test.ts src/tool-catalog.test.ts --maxWorkers=1
```

Expected: generated documentation matches descriptors byte-for-byte and all contract tests pass.

- [ ] **Step 6: Review and commit Task 7**

```bash
git add src/tool-contract-docs.ts src/tool-contract-docs.test.ts src/tool-contracts.ts docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md
git commit -m "docs: lock tool contract reference to descriptors"
```

---

### Task 8: Run the C1 executable-contract closure gate

**Files:**
- Modify only if verification exposes a deterministic contract defect in files owned by Tasks 1–7.
- Do not create or modify any C1 governance artifact.

**Interfaces:**
- Produces: reviewed `C1_CONTRACT_SHA`, suitable for Task 2 Step 6 governance work.
- Requires: every previous task committed and reviewed.

- [ ] **Step 1: Run static and focused verification**

```bash
npm run typecheck:contracts
npm run build
npx vitest run src/tool-contracts.test.ts src/tool-catalog.test.ts src/tool-contract-docs.test.ts src/synthesis/structured-output.test.ts src/synthesis/render.test.ts --maxWorkers=1
```

Expected: zero TypeScript errors and all focused tests pass.

- [ ] **Step 2: Run the complete offline suite**

```bash
npm test -- --maxWorkers=1
```

Expected: zero failed tests. Record the exact passed/skipped counts in the review artifact; do not copy an earlier count.

- [ ] **Step 3: Run repository health checks**

```bash
npm run doctor
npm run validate-corpus
npm run validate-references
npm run validate-readiness-artifacts -- --mode public
npm run validate-readiness-artifacts -- --mode private --corpus-path corpus/entries.json
git diff --check
```

Expected:

- doctor reports zero FAIL;
- 787 corpus entries remain valid and unchanged;
- reference validation passes;
- C0 remains closed;
- C1 is not falsely closed before its independent approvals exist;
- no whitespace errors.

- [ ] **Step 4: Prove runtime scope did not drift**

Run the existing MCP smoke assertion that the server still exposes the legacy 14-tool catalog at C1:

```bash
npx vitest run src/mcp-smoke.test.ts src/public-mcp-contract.test.ts --maxWorkers=1
```

Expected: legacy runtime tests pass; no beta registration or compatibility alias has landed.

- [ ] **Step 5: Replay the complete adversarial probe set**

The final reviewer must mutate valid fixtures and prove rejection/acceptance for:

1. wrong per-tool fallback reason;
2. fallback with zero results;
3. terminal attempted paths without fallback;
4. forbidden attempted mode;
5. duplicate primary row;
6. repeated aggregation source;
7. compare all missing as success;
8. compare partial warning in both directions;
9. ghost plan evidence;
10. ghost UiSpec evidence self-authorized through provenance;
11. one-way provenance omission;
12. ghost critique evidence in every claim family;
13. critique/envelope retrieval disagreement;
14. team authority without an identified design system;
15. project/corpus/editorial authority without its required source;
16. wrong aggregate token authority;
17. missing or contradictory motion warning;
18. missing executable defaults;
19. unknown TypeScript tool-map key;
20. invalid error retryability.

Expected: every invalid mutation fails for the intended issue path; repeated aggregation references and terminal attempted-mode metadata pass.

- [ ] **Step 6: Request one holistic independent review**

Use the repository's requesting-code-review template with:

- Base SHA: `b8c754e`;
- Head SHA: current branch head;
- Plan: this file;
- Design authority: `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md`;
- Governing invariant: the invariant in this plan;
- Scope statement: runtime remains legacy 14 and governance remains out of scope.

The review must inspect plan-step completion, exact descriptor/data flow, external MCP structural versus semantic schema boundary, and mutation-test adequacy. Any Critical or Important issue keeps C1 governance blocked.

- [ ] **Step 7: Record the approved closure commit**

After zero Critical and zero Important findings:

```bash
git rev-parse HEAD
```

Record the exact result as `C1_CONTRACT_SHA` in the subsequent governance task. Write the task and branch review artifacts required by `CLAUDE.md`. Do not create approvals in this task.

---

## Completion criteria

C1 executable contracts are closed only when all of these are true:

- [ ] Every tool has a valid input, success, and supported error fixture.
- [ ] Every adversarial test starts from a valid fixture and mutates one property.
- [ ] Retrieval state, reason, attempts, fallback, result count, and status agree.
- [ ] Primary IDs and referenced IDs use distinct semantics.
- [ ] Valid repeated aggregation sources are accepted.
- [ ] Compare all-missing success is rejected.
- [ ] Envelope evidence is the only evidence-ID authority.
- [ ] Plan, UiSpec, and critique nested evidence graphs are closed.
- [ ] UiSpec provenance source/evidence sets match exactly.
- [ ] Authority prerequisites and aggregate authority are deterministic.
- [ ] Sparse and motion states have exact decisions and warnings.
- [ ] All documented defaults are executable.
- [ ] Exact per-tool TypeScript types survive descriptor derivation.
- [ ] §5.3–§5.5 cannot drift from descriptor-owned metadata.
- [ ] Runtime still advertises the legacy 14 tools.
- [ ] Full build, offline suite, doctor, corpus, references, and readiness validation pass.
- [ ] Final independent review reports zero Critical and zero Important findings.

Only after this checklist passes should implementation return to the parent plan at Task 2 Step 6 for C1 recipes, closed-world policies, historical chains, and independent Product/Engineering approvals.
