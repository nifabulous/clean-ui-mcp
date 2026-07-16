# Agent Readiness, Retagging, and Distribution Design

**Status:** Approved design, revised after implementation-readiness review
**Date:** 2026-07-14
**Primary user:** AI coding agents using Codex, Claude Code, Cursor, and comparable MCP clients

## 1. Objective

Prepare `clean-ui-mcp` for its first external users without allowing distribution work to outrun corpus quality or publication safety.

The program has four joined outcomes:

1. Resolve the retagging disposition of all 787 corpus entries and migrate only fields whose measured quality justifies replacement or fill.
2. Replace the pre-release 14-tool MCP surface with a beta-stable 12-tool, agent-oriented contract.
3. Turn `clean-ui-design` into one discoverable skill with explicit research, build, and review workflows.
4. Publish a safe metadata-only community edition to npm, then recruit a small coding-agent beta.

The program does not pre-commit the project to hosted infrastructure, billing, accounts, multi-region delivery, or a public screenshot library.

## 2. Current State

### 2.1 What exists

The repository already contains:

- a two-pass vision tagger with provider/model overrides;
- a single-entry, direct-write `/api/auto-retag` route; it is not a bulk shadow-retag controller;
- claim-grounding, accessibility, banned-phrase, WCAG, and citation gates;
- a 15-image evaluator that measures pattern-type accuracy, hallucination counters, latency, and deterministic critique-policy checks; its legacy critique adapter emits no structured recommendations, so recommendation citation quality is not scorable;
- browser-side DOM motion capture stored as capture-time sidecar data, not as a persistent `CorpusEntry` field;
- reference integrity and synthesis authority lanes;
- private/public corpus readers and directory-atomic public snapshots containing eligible records plus explicitly public raster assets;
- raw corpus snapshots, restore tooling, incremental index rebuilds, and doctor checks;
- one broad companion skill, `clean-ui-design`.

### 2.2 What this program must build

The following are greenfield work, not extensions that should be assumed cheap:

- the human-labeled 40-entry gold set and multi-label precision/recall scoring;
- non-mutating batch candidate generation, review diffs, and exact-ID promotion;
- a run manifest that derives prompt, corpus, reference, and machine-rule identities at run time;
- provider HTTP contract fixtures;
- structured response envelopes for the tools that are currently text-only;
- the research/build/review skill rewrite;
- a separate npm projection that packages eligible metadata without copying the public snapshot's raster assets;
- corpus-grounded persistent motion metadata, if later evidence shows it is worth adding.

The corpus is usable but uneven:

- 787 entries and 787 valid image references;
- 477 entries tagged `auto`, 298 with unknown provenance, and 12 `auto-reviewed`;
- component coverage around 3%;
- domain-tag coverage around 2%;
- color scheme, mood, industry, and responsive-behavior coverage around 3%;
- 0 pinned entries;
- 0 publication-eligible entries in the private working corpus;
- the intended npm distribution is metadata-only, but the existing public snapshot exporter also copies eligible `images-public/` raster assets; private screenshot bytes remain excluded by policy.

The tagger is ready to be baselined, not yet proven ready to retag the corpus. The direct-write endpoint is not an adequate controller for a 787-entry migration. Retagging must be treated as a measured corpus migration.

## 3. Program Architecture

Two lanes start after the current foundation is frozen:

```text
Foundation freeze
├─ MCP rename + skill migration → workflow dogfood ──────────────┐
└─ Gold baseline → bounded calibration → quality outcome ────────┴─ disposition
     ├─ replacement → shadow → canary → staged retag → audit ───────┐
     ├─ fill-only   → field canary → staged fill → reduced audit ──┤
     └─ deferred    → corpus-wide deferral record ─────────────────┤
                                                                  └─ publication curation → npm release
```

The MCP rename is a pure contract refactor and may land while the gold set and shadow-retag infrastructure are being built. It must be complete before npm publication, but it does not need to wait for corpus migration.

Within the chosen retagging disposition, work remains sequential:

```text
Gold set → current baseline → quality contract → contract dogfood
→ disposition-specific field matrix → shadow infrastructure → canary/audit
→ publication curation
```

This ordering creates visible progress without weakening the evaluation discipline.

## 4. Retagging Model

### 4.1 Lean shadow runs

Every retag starts as a non-mutating shadow run. The tagger produces candidates, never direct corpus writes.

```text
corpus/retag-runs/<run-id>/
├── manifest.json
├── candidates.json
├── diffs.json
└── scores.json
```

These artifacts are private curator state and are excluded from public packages.

Failures and review decisions are fields in these artifacts rather than separate operational subsystems. A failed run is immutable and starts a new run ID; the first implementation does not build resumable job orchestration.

The manifest records:

- run schema version and run ID;
- frozen baseline git SHA;
- corpus version and SHA-256;
- selected entry IDs and their original hashes;
- provider, base URL, model, and model-pinning status;
- a run-level pipeline fingerprint derived from the effective prompt text, reference manifest, and generated machine-rule artifact;
- start/end timestamps and status;
- token counts, retries, measured latency, measured cost, and required `maxCostUsd`;
- candidate, accepted, rejected, failed, promoted, and rolled-back counts.

These hashes and the pipeline fingerprint are new run-manifest capabilities; they are not existing corpus fields and require no 787-entry backfill. Candidate generation verifies its inputs before starting. Promotion verifies the original entry hashes and the candidate run identity. A mismatch creates a new run rather than a resume/refusal state machine.

### 4.2 Gold set and baseline

The evaluation set contains 40 entries. The existing 15-image set is a diagnostic seed, not the final quality authority. Thirty-five entries are algorithmically reproducible using `retag-gold-v1` with seed `clean-ui-retag-v1`; five are versioned, auditable curator-selected challenge cases with recorded rationale.

Selection balances:

- common and rare pattern types;
- desktop and mobile;
- exceptional and cautionary examples;
- dense and sparse layouts;
- entries with and without DOM sidecars;
- `auto`, `unknown`, and `auto-reviewed` provenance;
- currently absent or low-coverage component/domain/style values;
- product diversity, with no product dominating a stratum.

Challenge cases deliberately cover taxonomically ambiguous screens, compound layouts, deceptive component boundaries, rare patterns, and cases where a reasonable reviewer might choose more than one label. They prevent reproducibility from excluding the failures most worth measuring.

Selection and curation are reproducible or auditable as appropriate:

1. Compute each candidate's strata from the frozen corpus.
2. Sort within each stratum by SHA-256 of `<seed>:<entry-id>`.
3. Select the required count from each stratum.
4. Add five challenge entries that do not duplicate the algorithmic set and record why each tests a specific ambiguity.
5. Record entry IDs, strata, selection reason, image hash, and corpus SHA.
6. If an algorithmic entry later disappears, replace it with the next hash-ordered entry in the same stratum. Replace a challenge entry only with another documented challenge case. Record every substitution.

Human labels cover pattern type, categories, components, domain tags, visual fields, claim grounding, accessibility evidence, critique quality, and expected protected-field behavior.

First run the unchanged current evaluator against its existing 15 images to establish a diagnostic result and expose provider/configuration failures. Then independently label and score the 40-entry gold set before prompts, taxonomies, or release thresholds change. The 15-image result must not be represented as macro-F1 or as a structured-recommendation citation baseline.

The diagnostic run at git SHA `fdd74d1` on 2026-07-14 completed 15/15 cases with 80% pattern-type accuracy, zero raw icon-only claims, zero raw banned phrases, and 6,553 ms average extraction latency. All 15 fixtures have deterministic critique-policy labels, but the legacy critique adapter emits no structured recommendations. The scorer therefore reported every citation result as not scorable, producing 0% aggregate critique pass/citation summaries that provide no recommendation-quality baseline.

### 4.3 Quality contract

Hard gates are absolute:

- 100% schema-valid candidate output;
- 0 protected-field changes;
- 0 invalid evidence IDs;
- 0 banned phrases after machine enforcement;
- 0 unsupported accessibility, absence, or icon-only claims;
- 0 invalid WCAG identifiers;
- 100% valid publication metadata preservation;
- 100% reproducible provider/model/prompt/rule/reference identity.

The following are target floors for authorizing a full replacement retag, not assumptions that Phase 1A must already satisfy:

- pattern-type exact accuracy: at least 90% and no lower than baseline;
- categories macro F1: at least 0.85 and no lower than baseline;
- components precision: at least 0.90, with recall no lower than baseline;
- domain-tag precision: at least 0.90, with recall no lower than baseline;
- structured critique schema validity: 100%;
- scorable recommendation citation rate: at least 90%.

A regression is material when any of these is true:

- a hard gate fails once;
- a tracked accuracy, precision, recall, citation, or human-acceptance metric drops by more than 5 absolute percentage points from the frozen baseline or previous accepted batch;
- the canary or sampled batch contains any critical error;
- more than 5% of the reviewed sample contains a major semantic error;
- actual cost exceeds `maxCostUsd` or the remaining forecast exceeds the approved run budget.

Any material regression stops the run before promotion.

#### Baseline outcomes and escape hatch

Phase 1A may enter one non-terminal calibration state and must end with one of two terminal outcomes:

1. **Qualified:** the unchanged or calibrated tagger meets the target floors. Proceed to full shadow retag.
2. **Replacement not justified:** after calibration, a replacement field still misses its floor or labels reveal taxonomy disagreement. After workflow dogfooding, the disposition checkpoint chooses Deferred or Fill-only. Existing classifications and prose remain unchanged.

**Improvement required** is the non-terminal state: hard gates pass and quality is measurable, but one or more replacement-field floors miss. Run at most two scoped prompt/taxonomy calibration cycles, preserving the original baseline. The loop must then terminate as Qualified or Replacement not justified.

A Fill-only disposition is limited to optional fields that are currently absent; it cannot replace existing classifications or prose. Each field must have a versioned label definition, at least 10 positive and 10 negative gold opportunities, precision of at least 0.95, false-positive rate no greater than 0.05, 100% schema validity, and no hard-gate failures. Recall is recorded but is not a promotion floor because low recall leaves coverage unchanged rather than corrupting existing data. A field without minimum label support may be filled only through 100% human review and is not eligible for automatic batch promotion. The approved field list and rules form the reduced field matrix.

Hard safety gates are never lowered. A target floor may change only through a versioned decision that documents label disagreement, metric defects, or a revised product requirement—not simply to make a run pass. MCP/package work may continue on the current validated corpus while retagging is deferred; release notes must state the corpus coverage actually shipped.

### 4.4 Field authority and merging

Protected fields never change during retagging:

- `id`;
- `source`;
- `image` identity/path/visibility;
- `addedAt`;
- capture metadata;
- publication metadata;
- provenance ownership/reviewer fields.

Candidate treatment depends on provenance:

| Field lane | `auto` | `unknown` | `auto-reviewed` |
|---|---|---|---|
| Code-derived visual facts | Replace only when the producing pipeline fingerprint is recorded and that field's gold gate passes | Candidate + review | Replace only with evidence and explicit approval |
| Model classifications | Replace when gold/eval gates pass | Candidate + review | Human value wins; record disagreement |
| Missing modern fields | Fill only when named by the approved Phase 1C matrix and its field gate passes | Fill only through the matrix's required review path | Fill only through the matrix; never replace existing values |
| Critique/editorial prose | Replace after quality gates | Full review | Human text wins; show candidate alongside |
| Protected fields | Never change | Never change | Never change |

Promotion stores the accepted candidate, rejected fields, reviewer identity, and decision timestamp.

The existing direct-write `/api/auto-retag` route is a migration bypass. Phase 2 replaces it with candidate-only generation or retires it; after that point no retag API may persist canonical corpus changes outside exact-ID promotion. Contract tests must prove that multi-entry retagging cannot reach a direct-write path.

### 4.5 Promotion, rollback, and batching

Retagging changes the canonical corpus JSON only. Images do not move. Therefore promotion uses the existing raw snapshot/restore mechanism plus the existing atomic corpus write. The larger multi-file journaled import transaction layer remains a separate import concern.

Before each batch:

1. Write and verify a raw corpus snapshot.
2. Confirm selected entry hashes and the candidate pipeline fingerprint still match the run artifact.
3. Forecast cost and enforce `maxCostUsd`.

After each accepted batch:

1. Atomically write the corpus.
2. Validate schema, protected fields, and hashes.
3. Rebuild the embedding index.
4. Run search, synthesis, doctor, and corpus smoke tests.
5. Record the resulting corpus and index hashes.

Run order:

1. 40-entry gold baseline: never promoted as part of calibration.
2. 25-entry stratified canary drawn from the `auto` and `unknown` queues: 100% human review. Accepted canary entries count as processed and are removed from their later queues.
3. Remaining entries from the 477-entry `auto` population: batches of 50, review all failures plus a deterministic 20% sample.
4. Remaining entries from the 298-entry `unknown` population: batches of 25–50, review all failures plus a deterministic 40% sample.
5. 12 `auto-reviewed` entries: complete field-level review.
6. Final audit across all 787 entries.

Gold entries remain ordinary members of their provenance queues and receive a migration outcome when their queue is processed. Gold-set evaluation itself never promotes them.

The first canary promotion must demonstrate restore and re-promotion before later batches may start. Ordinary safety uses the existing atomic write, raw snapshot/restore, a feature branch, and reviewable corpus diffs; no general job scheduler or multi-file transaction engine is added.

## 5. MCP Contract Redesign

### 5.1 Beta tool catalog

The pre-release 14-tool surface becomes this 12-tool surface:

| Current | Beta name |
|---|---|
| `search_ui_examples` | `search_ui_references` |
| `get_ui_example` | `get_ui_reference` |
| `get_similar_ui_examples` | `find_similar_ui_references` |
| `compare_ui_examples` | `compare_ui_references` |
| `list_categories` | `get_ui_taxonomy` |
| `list_style_tags` | `get_ui_taxonomy` |
| `list_domain_tags` | `get_ui_taxonomy` |
| `browse_ui_examples` | `browse_ui_patterns` |
| `recommend_ui_direction` | `plan_ui_direction` |
| `generate_design_prompt` | `create_ui_spec` |
| `get_anti_patterns` | `research_ui_anti_patterns` |
| `get_color_palette` | `research_ui_palettes` |
| `get_stealable_techniques` | `research_ui_techniques` |
| `critique_ui` | `critique_ui` |

There are no compatibility aliases. Contract tests assert the exact 12 names and assert that removed names are absent.

These names are stable throughout the 0.x beta. Beta telemetry and agent dogfooding may justify one explicit contract revision before 1.0; such a revision requires migration notes and a coordinated skill update. At 1.0, freeze the catalog and use additive optional inputs, versioned outputs, and explicit deprecation windows. Existing names are never silently reused for different semantics.

### 5.2 Agent workflows

The catalog exposes three clear paths:

```text
Research: get_ui_taxonomy → search_ui_references → get_ui_reference
          → compare_ui_references

Plan:     plan_ui_direction → inspect cited references → create_ui_spec

Review:   critique_ui → inspect cited references → prioritized fixes
```

Targeted aggregation tools support research but do not replace `plan_ui_direction` when an agent needs a complete direction.

### 5.3 Standard response envelope

Every tool returns complete human-readable `content[0]` plus matching `structuredContent`. The structured envelope is the source of truth; `content[0].text` is rendered exclusively from it. No fact may exist only in handwritten text.

**Two validation levels (derived from the same descriptor):**

- **`outputSchema` (MCP-advertised JSON Schema):** structural contract — fields, types, enums, required properties. MCP converts the Zod schema to JSON Schema; `.superRefine()` semantics are not expressible in JSON Schema.
- **Canonical Zod parsing (`safeParse`):** semantic contract — counts, cross-references, conditional integrity, code↔retryable binding, exact reference-set equality, evidence membership. These are enforced at runtime but not fully representable in JSON Schema.

Both levels derive from `TOOL_DESCRIPTORS`. No handwritten second authority exists.

```ts
interface CleanUiToolResult<T> {
  schemaVersion: "1.0";
  tool: string;               // discriminator matching the catalog name
  status: "ok" | "error";     // success vs application error
  summary: string;
  data: T | null;             // typed per-tool; null only on error
  referenceIds: string[];     // stable corpus entry IDs in the result
  evidence?: Evidence[];      // required for plan/spec/critique; forbidden otherwise
  retrieval: RetrievalState;  // truthful operation metadata
  warnings: Warning[];        // typed warnings: { code, message } with per-tool code enums
  error?: ToolError;          // discriminated union; present only on error
}

interface Warning {
  code: string;               // per-tool enum (sparseCoverage, insufficientCorpusEvidence, etc.)
  message: string;
}

interface ToolError {
  code: "NOT_FOUND" | "INDEX_UNAVAILABLE" | "PROVIDER_ERROR" | "INVALID_INPUT";
  message: string;
  retryable: boolean;         // bound to code: NOT_FOUND/INVALID_INPUT → false, others → true
}

interface RetrievalState {
  mode: "hybrid" | "vector" | "keyword" | "structured-fallback" | "none";
  modality: "text" | "image" | "metadata" | "none";
  resultCount: number;        // must equal actual result count in data
  fallbackUsed: boolean;      // true only when an alternate path produced results
  attemptedCount: number;     // must equal attemptedModes.length; 0 when no fallback
  fallbackReason?: "missing-index" | "incompatible-index" | "missing-provider-key" | "community-edition" | "provider-error" | "no-image-evidence";
  attemptedModes: RetrievalMode[]; // empty on ok+non-fallback; non-empty on ok+fallback or error+terminal-failure; no "none", no current mode, no duplicates always
}

interface Evidence {
  id: string;                 // response-scoped, unique within the result
  referenceId?: string;       // required for corpus-observation; must appear in referenceIds
  kind: "corpus-observation" | "screen-observation" | "dom-signal" | "machine-rule" | "editorial-guidance";
  summary: string;
  basis: "visible" | "inferred" | "dom-grounded" | "editorial";
}
```

**Envelope invariants:**

- `status: "ok"` requires non-null typed `data`, no `error`.
- `status: "error"` requires `data: null`, a typed `error`, `resultCount: 0`, and MCP `isError: true`.
- `resultCount` must equal the actual number of items in `data` for list-returning tools.
- `referenceIds` must be unique and must exactly match the IDs represented in `data`/`evidence`.
- `evidence` IDs must be unique. Only `plan_ui_direction`, `create_ui_spec`, and `critique_ui` include evidence; all other tools reject it.
- `fallbackUsed` ↔ `fallbackReason` consistency: fallback requires a reason; a reason requires fallback.
- `fallbackUsed` requires `attemptedModes` (non-empty, no `"none"`, no duplicates).

**Evidence lane discrimination:**

| Kind | Allowed basis | referenceId | Allowed tools |
|---|---|---|---|
| `corpus-observation` | visible, inferred | required (must be in `referenceIds`) | plan, spec, critique |
| `screen-observation` | visible, inferred | optional | critique only |
| `dom-signal` | dom-grounded, visible | optional | critique only |
| `machine-rule` | inferred, editorial | optional | plan, spec, critique |
| `editorial-guidance` | editorial | optional | plan, spec, critique |

`create_ui_spec` and `plan_ui_direction` may not emit `screen-observation` or `dom-signal` evidence — they synthesize from corpus references, not screenshots.

**Retrieval truth (authoritative — follows the implementation plan §Task 7 Step 2):**

Retrieval metadata originates at the CorpusReader boundary as a `RetrievalOutcome<T>`. Handlers copy it unchanged into the envelope. Missing index, missing key, missing image, provider failure, zero results, and fallback success are all distinguishable states.

| Tool | Mode/basis |
|---|---|
| taxonomy, get, compare, browse, research aggregations, create spec | `none`; direct/aggregation details live in data |
| search | `hybrid` when combined path runs; otherwise `vector`, `keyword`, or `structured-fallback` |
| similar | `vector` + text; otherwise structured-fallback—never "visually similar" or image |
| plan | `hybrid` preferred; keyword/structured fallback; absence of index is not an error |
| critique | `vector` + `image` modality when available; otherwise `structured-fallback` with caller-screen evidence kept separate |

`resultCount` is defined per primary payload: taxonomy `0`; get `0|1`; search/similar the number of references; compare the number of requested IDs found; browse the number of pattern groups; each research aggregation the number of aggregate rows; plan/spec/critique `1` only when a complete primary artifact exists, otherwise `0`. `referenceIds` are unique stable IDs represented in data/evidence and must exactly match the IDs in the result data.

Workflow routing and next-tool suggestions belong to the skill layer, not MCP responses.

### 5.4 `create_ui_spec`

`create_ui_spec` becomes the primary implementation handoff. The versioned `UiSpec` artifact encodes:

**Input (`CreateUiSpecInput`):**

| Field | Type | Required | Bounds |
|---|---|---|---|
| `productContext` | string | required | min 8 chars |
| `referenceIds` | string[] | optional | 0–5 unique non-empty IDs (0 = sparse/editorial-only) |
| `platform` | enum web/mobile/tablet | optional | — |
| `implementationFramework` | string | optional | e.g. "react", "swiftui" |
| `serializationFormat` | enum brief/tokens | optional | default "brief" |
| `designSystem` | `{ status: "none"\|"identified", registry?, library? }` | optional | Design-system identity; "identified" requires registry or library |
| `constraints` | string[] | optional | explicit project constraints |

**Output sections (each is a typed schema, not `z.unknown()`):**

- `specVersion: "1.0"` and `context` (productContext, platform, framework, designSystem)
- `designDirection` and `rejectedDefaults`
- `layoutRegions` (typed) and `responsiveBehavior`
- `componentInventory` (typed)
- `colorTokens` (primary/surface/ink/muted/accent) with `colorTokenAuthority`
- `typographyTokens` (heading/body/mono) with `typographyTokenAuthority`
- `interactions` and `motionGuidance` (with `evidenceUnavailable` flag)
- `accessibilityConstraints`
- `contentVoiceGuidance`
- `techniques` and `antiPatterns` (typed, evidence-backed)
- `frameworkNotes`
- `unavailableDecisions` (field + reason) — sparse evidence must produce unavailable/proposed decisions with typed warnings, never fabricated values
- `acceptanceCriteria` — structured `{id, subject, assertion, expectedOutcome, verifier: axe|playwright|static-analysis|manual, priority, evidenceIds, manualSteps?, selector?, command?}`
- `citedReferences` and `citedDecisions` (with authority lane, evidence IDs, readiness, provenance)
- `authorityLanes` (corpusEvidence, machineRules, editorialGuidance)
- `provenance` (generatedAt, toolVersion)

Token authority precedence: `team-design-system` > `project-constraint` > `corpus-evidence` > `editorial`. Mixed authority is derived from actual child decisions.

Motion guidance obeys the available evidence boundary:

- DOM motion signals may support `dom-grounded` guidance for the UI currently being reviewed;
- metadata-only corpus references do not prove that motion occurred and must not be described as observed motion;
- when no DOM or persistent corpus motion evidence exists, `create_ui_spec` may provide clearly labeled `editorial` guidance from the design-engineering reference lane and must emit a `motionEvidenceUnavailable` warning;
- adding persistent corpus motion metadata is a separate, evidence-driven schema decision, not a prerequisite for the npm edition.

### 5.5 Per-tool contract reference

These tables are the authoritative source for executable Zod schemas. The block below is generated from `TOOL_DESCRIPTORS` by `renderToolContractReference()`; the drift test in `src/tool-contract-docs.test.ts` locks it byte-for-byte. Do not edit by hand.

<!-- GENERATED_TOOL_CONTRACTS_START -->
#### `search_ui_references`

| Aspect | Contract |
|---|---|
| Input | query?, category?, styleTag?, patternType?, minQuality (1-5)?, qualityTier?, reviewStatus?, platform?, limit (1-20, default 5)?, responseFormat? |
| Success data | `results: ReferenceSummary[]` — each with id, title, product, patternType, categories, styleTags, qualityScore, qualityTier, source (productName, url required-but-nullable, imageAvailable), critique excerpt, topTechniques, antiPatterns |
| Empty | `results: []`, retrieval none, resultCount 0, summary guidance |
| Partial | sparseCoverage / keywordFallback typed warnings on degraded retrieval |
| Errors | NOT_FOUND (non-retryable), PROVIDER_ERROR (retryable) |
| Warnings | sparseCoverage, keywordFallback |
| Retrieval | hybrid/text; vector/text; keyword/text (reasons: missing-index, incompatible-index, missing-provider-key, provider-error); keyword/metadata (reasons: missing-index, incompatible-index, missing-provider-key, provider-error); structured-fallback/metadata (reasons: missing-index, incompatible-index, missing-provider-key, community-edition, provider-error); none/none |
| Evidence | forbidden (none) |
| resultCount | `results.length` |
| referenceIds | unique `result.id` values |
| Legacy names | search_ui_examples |

#### `get_ui_reference`

| Aspect | Contract |
|---|---|
| Input | id (required) |
| Success data | full reference record: id, title, product, patternType, categories, styleTags, qualityScore, qualityTier, platform, layout, visual attributes, accessibility, critique, techniques, antiPatterns, source, image availability |
| Empty | n/a — single-id lookup |
| Partial | n/a — single-id lookup |
| Errors | NOT_FOUND (non-retryable) |
| Warnings | none |
| Retrieval | none/none |
| Evidence | forbidden (none) |
| resultCount | 1 on success, 0 on error |
| referenceIds | `[id]` on success, `[]` on error |
| Legacy names | get_ui_example |

#### `find_similar_ui_references`

| Aspect | Contract |
|---|---|
| Input | id (required), limit (1-20, default 5)? |
| Success data | `results: SimilarReference[]` — each with id, title, product, patternType, categories, styleTags, score, basis, critique, techniques |
| Empty | `results: []` when no index or source not found |
| Partial | keywordFallback / sparseCoverage typed warnings on degraded retrieval |
| Errors | NOT_FOUND (non-retryable), PROVIDER_ERROR (retryable) |
| Warnings | keywordFallback, sparseCoverage |
| Retrieval | vector/text; structured-fallback/metadata (reasons: missing-index, incompatible-index, missing-provider-key, community-edition, provider-error); none/none |
| Evidence | forbidden (none) |
| resultCount | `results.length` |
| referenceIds | unique `result.id` values |
| Legacy names | get_similar_ui_examples |

#### `compare_ui_references`

| Aspect | Contract |
|---|---|
| Input | ids (required, 2-3 unique), responseFormat? |
| Success data | `entries: ComparisonRow[]`, `foundIds`, `missingIds` — each row with id, title, product, patternType, categories, styleTags, platform, layout, accent, density, corners, quality, critiqueAngle, topTechnique, antiPatterns, whereItFails, accessibility |
| Empty | n/a — all IDs missing is an error (NOT_FOUND), not an empty success |
| Partial | `missingIds` non-empty + typed partialResult warning when some IDs not found |
| Errors | NOT_FOUND (non-retryable) |
| Warnings | partialResult |
| Retrieval | none/none |
| Evidence | forbidden (none) |
| resultCount | `foundIds.length` |
| referenceIds | `foundIds` |
| Legacy names | compare_ui_examples |

#### `get_ui_taxonomy`

| Aspect | Contract |
|---|---|
| Input | none |
| Success data | `patternTypes`, `categories`, `styleTags` (each `{count, values}`), optional `components`, `domainTags` |
| Empty | n/a — always returns the taxonomy |
| Partial | n/a |
| Errors | none |
| Warnings | none |
| Retrieval | none/none |
| Evidence | forbidden (none) |
| resultCount | 0 (not a search tool) |
| referenceIds | `[]` |
| Legacy names | list_categories, list_style_tags, list_domain_tags |

#### `browse_ui_patterns`

| Aspect | Contract |
|---|---|
| Input | styleTag? |
| Success data | `patterns: PatternGroup[]` — each with patternType, count, topProducts (array), exemplar (id, title, product, qualityScore, critique) |
| Empty | `patterns: []` |
| Partial | sparseCoverage typed warning on thin coverage |
| Errors | none |
| Warnings | sparseCoverage |
| Retrieval | none/none |
| Evidence | forbidden (none) |
| resultCount | number of rows returned (`patterns.length`) |
| referenceIds | exemplar IDs |
| Legacy names | browse_ui_examples |

#### `plan_ui_direction`

| Aspect | Contract |
|---|---|
| Input | productContext (required, min 8), category?, styleTag?, platform?, qualityTier? (default exceptional), framework? (brief/tokens), count (1-5, default 3)? |
| Success data | `direction`, `rejectedDefaults`, `recommendation`, `rationale`, `evidenceContributions`, `structuredDecisions` |
| Empty | n/a — absence of index degrades through fallback, not an empty success |
| Partial | sparseCoverage / insufficientCorpusEvidence / noCorpusIndex typed warnings on sparse results |
| Errors | PROVIDER_ERROR (retryable) |
| Warnings | sparseCoverage, insufficientCorpusEvidence, noCorpusIndex |
| Retrieval | hybrid/text; keyword/text (reasons: missing-index, incompatible-index, missing-provider-key, provider-error); keyword/metadata (reasons: missing-index, incompatible-index, missing-provider-key, provider-error); structured-fallback/metadata (reasons: missing-index, incompatible-index, missing-provider-key, community-edition, provider-error); none/none |
| Evidence | required (plan/spec/critique) (corpus-observation, machine-rule, editorial-guidance) |
| resultCount | 1 when a complete plan artifact exists, otherwise 0 |
| referenceIds | grounding entry IDs (`evidenceContributions`) |
| Legacy names | recommend_ui_direction |

#### `create_ui_spec`

| Aspect | Contract |
|---|---|
| Input | productContext (required, min 8), referenceIds? (max 5), platform?, implementationFramework?, serializationFormat (default brief)?, designSystem?, constraints? |
| Success data | see §5.4 — UiSpec with layoutRegions, colorTokens, typographyTokens, acceptanceCriteria (verifiers: axe, playwright, static-analysis, manual), citedReferences, citedDecisions, authorityLanes, provenance |
| Empty | n/a — synthesis produces one spec artifact or errors |
| Partial | sparseCoverage / insufficientCorpusEvidence / motionEvidenceUnavailable typed warnings; null tokens require editorial authority + unavailableDecision |
| Errors | INVALID_INPUT (non-retryable) |
| Warnings | sparseCoverage, insufficientCorpusEvidence, motionEvidenceUnavailable |
| Retrieval | none/none |
| Evidence | required (plan/spec/critique) (corpus-observation, machine-rule, editorial-guidance) |
| resultCount | 1 when a complete spec artifact exists, otherwise 0 |
| referenceIds | `citedReferences` |
| Legacy names | generate_design_prompt |

#### `research_ui_anti_patterns`

| Aspect | Contract |
|---|---|
| Input | patternType?, category?, limit (1-20, default 10)? |
| Success data | `results: AntiPatternRow[]` — each with text, sourceIds, count |
| Empty | `results: []` |
| Partial | sparseCoverage typed warning on thin coverage |
| Errors | none |
| Warnings | sparseCoverage |
| Retrieval | none/none |
| Evidence | forbidden (none) |
| resultCount | number of rows returned (`results.length`) |
| referenceIds | unique sourceIds across all rows |
| Legacy names | get_anti_patterns |

#### `research_ui_palettes`

| Aspect | Contract |
|---|---|
| Input | patternType?, styleTag?, limit (1-20, default 10)? |
| Success data | `results: PaletteRecord[]` — each with tokens (canvas, surface, ink, muted, accent), accentHue, product, sourceId, patternType |
| Empty | `results: []` |
| Partial | sparseCoverage typed warning on thin coverage |
| Errors | none |
| Warnings | sparseCoverage |
| Retrieval | none/none |
| Evidence | forbidden (none) |
| resultCount | number of rows returned (`results.length`) |
| referenceIds | unique sourceId values |
| Legacy names | get_color_palette |

#### `research_ui_techniques`

| Aspect | Contract |
|---|---|
| Input | patternType?, styleTag?, limit (1-30, default 15)? |
| Success data | `results: TechniqueRow[]` — each with text, source (id, product) |
| Empty | `results: []` |
| Partial | sparseCoverage typed warning on thin coverage |
| Errors | none |
| Warnings | sparseCoverage |
| Retrieval | none/none |
| Evidence | forbidden (none) |
| resultCount | number of rows returned (`results.length`) |
| referenceIds | unique source IDs |
| Legacy names | get_stealable_techniques |

#### `critique_ui`

| Aspect | Contract |
|---|---|
| Input | image_data (required), image_mime_type (required), product_context?, platform?, framework? — reuses `CRITIQUE_UI_INPUT_SCHEMA` from `synthesis/contracts.ts` |
| Success data | reuses `StructuredCritique` fields: observations, recommendations, accessibilityRisks, visualSlop, motion, appliedReferences, evidenceIds, confidence, md3? |
| Empty | n/a — synthesis produces one critique artifact or errors |
| Partial | insufficientCorpusEvidence / providerDegraded typed warnings; may include screen-observation and dom-signal evidence |
| Errors | PROVIDER_ERROR (retryable), INVALID_INPUT (non-retryable) |
| Warnings | insufficientCorpusEvidence, providerDegraded |
| Retrieval | vector/image; structured-fallback/metadata (reasons: missing-index, incompatible-index, missing-provider-key, community-edition, provider-error, no-image-evidence); none/none |
| Evidence | required (plan/spec/critique) (corpus-observation, screen-observation, dom-signal, machine-rule, editorial-guidance) |
| resultCount | 1 when a complete critique artifact exists, otherwise 0 |
| referenceIds | appliedReference IDs |
| Legacy names | (none — critique_ui unchanged) |
<!-- GENERATED_TOOL_CONTRACTS_END -->

## 6. Companion Skill

Only `clean-ui-design` is discoverable before recruitment.

```text
skill/clean-ui-design/
├── SKILL.md
├── agents/openai.yaml
├── workflows/
│   ├── research.md
│   ├── build.md
│   └── review.md
└── references/
```

The router maps user intent to exactly one workflow:

| Intent | Workflow |
|---|---|
| Pattern exploration, comparison, alternatives | Research |
| Build or redesign | Build |
| Critique or improve an existing UI | Review |

Behavioral requirements:

- use MCP synthesis instead of hand-synthesis when a matching tool exists;
- preserve corpus evidence, machine rules, and editorial guidance as separate authority lanes;
- cite reference IDs;
- convert references into reusable decisions, not copied appearance;
- require `create_ui_spec` before substantial implementation unless an equivalent spec exists;
- request a screenshot and use `critique_ui` after implementation;
- disclose keyword fallback and missing image/source evidence;
- never present `auto` provenance as human-vetted authority;
- produce a versioned spec in Build and a prioritized fix queue in Review.

The skill explains the distribution model:

- the npm corpus is metadata-only;
- private screenshot bytes do not ship;
- `source.url` may link to the original but is optional;
- provenance controls how strongly an agent should weight analysis;
- keyword fallback finds tag-similar, not visually similar, references.

The MCP rename and skill update are a hard same-release dependency.

CI adds structural tests that:

1. extract tool names referenced under `skill/**/*.md` and require every name to exist in the registered catalog;
2. maintain a removed-name set and fail when any removed tool appears under `skill/`.

Research/build/review entry conditions, exit conditions, and failure behavior remain documented workflow requirements rather than pretending prompt behavior can be proven by a grep test.

## 7. Publication and npm Distribution

Retagging quality and publication permission remain independent.

After one of the three corpus-disposition paths completes—replacement audit, fill-only reduced audit, or recorded corpus-wide deferral—a human publication-curation pass:

1. selects the community corpus;
2. reviews entry-level rights, attribution, evidence, and editorial suitability;
3. sets publication metadata manually;
4. derives an npm-specific metadata projection from publication-eligible records without copying snapshot raster assets;
5. runs leak-prevention and public-reader contract tests;
6. verifies private entries, all raster/image bytes, internal snapshot manifests, curator state, and secrets are absent.

The existing public snapshot remains an internal/public-asset-capable integrity artifact and may contain explicitly public raster files. The npm projection is a separate packaging boundary. Package tests fail on raster extensions, image magic bytes, or an asset-bearing snapshot directory anywhere in the tarball.

The installed package consumes this explicit projection contract:

```text
community-corpus/
├── manifest.json
└── entries.json
```

`manifest.json` contains `schemaVersion`, `corpusVersion`, `generatedAt`, `sourceSnapshotId`, the source snapshot manifest SHA-256, `entryCount`, `entriesSha256`, and `assetsIncluded: false`. A new `CommunityCorpusReader` implements the existing `CorpusReader` interface without opening the asset-bearing snapshot or any private path. At construction it validates the manifest and entries schemas, re-hashes `entries.json`, confirms the count and `assetsIncluded: false`, and applies a shared metadata-only publication check for visibility, rights status, expiry, and public image classification. The projection builder may consume only a fully verified public snapshot and records the source snapshot identity as provenance.

Runtime degradation is part of the contract, not an accident:

- keyword and structured search, taxonomy, aggregation, planning, and specification tools operate on packaged metadata;
- `resolveImagePath` always returns `null`, `getImageIndex` returns `null`, and no private/global index may load;
- retrieval that would otherwise use image embeddings reports keyword or structured fallback and must not claim visual similarity;
- reference detail returns metadata and `source.url` when present, plus `image-unavailable-in-community-edition`; it never fabricates an image description;
- critique uses caller-provided screen evidence plus keyword/structured corpus retrieval and reports the fallback;
- installed-tarball contract tests invoke every tool class and assert both useful text output and accurate warnings without repository files.

The package must add:

- explicit `files` allowlist;
- package `repository.url` matching the GitHub repository;
- intentional `publishConfig`;
- runtime `engines.node` set to `>=22.14.0`;
- package-content policy and secret scanning;
- installed-tarball MCP smoke tests;
- skill/workflow/reference presence checks.

### 7.1 First npm release

Current npm rules require the package to exist before trusted publishing can be configured. Staged publishing also cannot create a brand-new package.

Therefore:

1. Check package-name availability and account 2FA.
2. Pack and test the actual tarball locally.
3. Directly publish the first version manually with 2FA to `next`.
4. Install the real registry version in an empty directory and run all 12 tool smokes.
5. Promote that exact immutable version from `next` to `latest` if it passes.
6. Configure the GitHub Actions trusted publisher for the now-existing package.
7. Use OIDC for subsequent versions.
8. After verifying OIDC, disallow traditional publish tokens.

The OIDC workflow uses a GitHub-hosted runner, Node 22.14.0 or newer, npm 11.5.1 or newer, `id-token: write`, no release dependency cache, and an exact workflow filename matching npm configuration.

Bad immutable versions are deprecated; dist-tags roll back to the prior known-good version.

## 8. Delivery Phases and Gates

### Phase 0: Freeze the foundation

- Land the current pipeline-verification fixes.
- Verify critique-quality work is present on `main` (PR #23 is already merged).
- Run `npm run doctor` and require 0 FAIL.
- From a fresh public clone with no private corpus, re-verify `npm ci`, full tests, build, seed/reference validation, public contract tests, package dry run, and installed-tarball smoke tests. Corpus-dependent tests already self-skip without private entries; this records existing behavior against the frozen SHA rather than treating it as new implementation.
- Separately, against the private 787-entry corpus workspace identified by its corpus SHA, run full corpus validation, doctor, index verification, and retag baseline checks. A public clone cannot reproduce private ignored corpus bytes and must not pretend to do so.
- Record baseline git SHA and all version/hash inputs.
- Freeze taxonomy changes until final retag audit.
- With explicit operator approval for provider cost, run the current 15-image evaluator and preserve its result as a diagnostic artifact. Do not lock multi-label thresholds from this run.

**Gate:** reproducible green result from a clean checkout.

### Phase 1A: Gold baseline and quality contract

- Select and independently label the 35 reproducible plus 5 challenge entries.
- Score the unchanged tagger.
- Pin the chosen provider/model configuration.
- Record quality, tokens, latency, retries, and cost.
- Implement the missing multi-label scorer, then version the thresholds in section 4.3.
- If needed, run the bounded Improvement-required loop, then record the terminal quality outcome as Qualified or Replacement not justified.

**Gate:** reproducible baseline artifact, independent labels, versioned thresholds, and a terminal quality outcome. No corpus mutation is authorized yet.

### Phase 1B: MCP and skill contract migration

This lane may run in parallel with Phases 1A and 2.

- Land the exact 12-tool catalog.
- Add standard structured responses.
- Upgrade `create_ui_spec`.
- Split the skill into internal workflows.
- Add structural CI checks and update all documentation/contracts.

**Gate:** private/public MCP contract tests pass and old tool names are absent.

After this gate, dogfood all three workflows on the current corpus before freezing retag priorities. Record which missing or unreliable fields materially degrade `create_ui_spec` and critique output. This report informs field priority but does not silently change the gold labels or taxonomy.

### Phase 1C: Corpus disposition checkpoint

- Combine the terminal Phase 1A quality outcome with the Phase 1B dogfood report.
- If Qualified, approve the replacement field matrix.
- If Replacement not justified, choose Deferred or approve a Fill-only reduced matrix using section 4.3's field-specific gates.
- Version the decision, rationale, field matrix, corpus SHA, owner, and date.

**Gate:** exactly one disposition—Replacement, Fill-only, or Deferred—is approved. Replacement and Fill-only identify every writable field; Deferred authorizes no corpus mutation.

### Phase 2: Shadow-retag infrastructure

This generic infrastructure may be built in parallel with Phases 1A–1C, but it cannot promote anything before the Phase 1C gate.

- Add the four immutable run artifacts, cost ceiling, scoring, diffs, review decisions, exact-ID promotion, and rollback.
- Reuse atomic corpus writes and raw snapshot/restore.
- Replace or retire the direct-write `/api/auto-retag` route so it can produce candidates but cannot persist canonical entries. Remove bulk UI callers that fan out direct writes.
- Simulate generation failure, stale-entry rejection, promotion failure, and rollback. A failed generation starts a new run ID; deterministic resume is out of scope for the first implementation.

**Gate:** shadow runs cannot mutate the corpus; no retag call site bypasses exact-ID promotion; promotion and rollback are reproducible.

### Phase 3: Canary

- Enter only after the Phase 1C disposition and Phase 2 gates pass. Skip this phase for Deferred.
- For Qualified, run a 25-entry replacement canary with complete human review.
- For Fill-only, run a 25-entry canary limited to the reduced field matrix with complete field-level review.
- Promote, rebuild, smoke, restore, and re-promote.

**Gate:** hard gates pass, no material regression occurs, and measured cost stays within budget. Qualified requires at least 90% overall human acceptance. Fill-only requires at least 95% acceptance for every promoted field and zero overwrites of populated values.

### Phase 4: Disposition execution and audit

- **Qualified:** process `auto`, then `unknown`, then `auto-reviewed` entries using section 4.5; stop on any material regression and rebuild/validate after every accepted batch.
- **Fill-only:** process only the reduced field matrix in staged batches; record every populated field as preserved and every unsupported field as deferred; stop on a field-specific or hard-gate failure.
- **Deferred:** do not run providers or mutate entries. Write a corpus-disposition artifact containing the frozen corpus SHA, all 787 entry IDs, current coverage, deferral reason, and decision owner/date.

**Gate:** exactly one disposition path is complete, all 787 entries have an explicit outcome, and the applicable full, reduced, or no-mutation audit passes. This gate converges all paths into Phase 5.

### Phase 5: Publication curation

- Review and set publication state independently of retagging.
- Build the npm-specific metadata projection, manifest, and `CommunityCorpusReader`; leak-test the community corpus.
- Run all 12 tools against the raster-free projection and verify the documented fallback/warning behavior.

**Gate:** every exported entry independently passes publication policy; the npm projection contains no raster assets or internal snapshot tree; every tool remains useful or degrades explicitly through the community reader.

### Phase 6: npm bootstrap and release

- Complete package allowlisting and tarball tests.
- Publish the first `next` version manually with 2FA.
- Registry-smoke, promote the exact version, then configure OIDC for future versions.

**Gate:** registry-installed behavior matches local behavior; no private bytes, raster assets, or internal snapshot tree ships.

### Phase 7: Coding-agent beta

Recruit a small set of design partners and measure:

- installation and MCP initialization success;
- time to first useful reference;
- time to first usable `create_ui_spec`;
- tool failure and fallback rates;
- research/build/review workflow completion;
- citation/reference inspection;
- user-rated usefulness;
- missing taxonomy and capability requests.

Do not log screenshots, source code, prompts, secrets, or image bytes.

### Phase 8: Evidence-driven expansion

Only after beta evidence:

1. design `review_ui_implementation`;
2. decide whether specialist discoverable skills are needed;
3. separately design multi-image `review_ui_consistency`;
4. consider `derive_ui_system` after retagged field coverage proves adequate.

## 9. Error Handling

| Failure | Required behavior |
|---|---|
| Run inputs differ from candidate manifest | Reject generation or promotion; require a new run ID |
| Budget forecast exceeds ceiling | Stop before provider call |
| Candidate violates hard gate | Reject candidate; do not partially promote |
| A retag caller attempts a direct canonical write | Reject the request; only exact-ID promotion may persist retag candidates |
| Batch crosses material-regression threshold | Stop batch; preserve artifacts for review |
| Promotion write fails | Restore verified pre-batch snapshot |
| Index rebuild fails | Keep corpus promotion recorded but mark run incomplete; public/release gates remain closed |
| Removed MCP name remains in skill/docs | CI failure |
| Legacy-only MCP client ignores `structuredContent` | `content[0]` remains complete |
| Public export includes ineligible/private state | Export fails; package cannot be built |
| npm projection contains raster bytes or a snapshot asset tree | Package policy fails before `npm pack` |
| Community projection manifest/hash/schema is invalid | Installed server refuses to start in community mode |
| First npm publish fails | No retry with changed bytes under the same version; diagnose and bump if registry accepted the version |
| Registry smoke fails | Keep version on `next` or deprecate it; do not promote to `latest` |

## 10. Verification Strategy

The implementation plans must include:

- unit tests for selection, pipeline fingerprinting, merge policy, scoring, budget enforcement, and exact-ID promotion;
- red/green tests for every migration invariant;
- integration tests using temporary corpora, never `corpus/entries.json`;
- call-site/contract tests proving retag APIs cannot persist outside exact-ID promotion;
- new provider contract tests with pinned request/response shapes;
- gold-set baseline and batch-diff tests;
- rollback tests that compare original bytes and hashes;
- exact 12-tool catalog tests;
- text-only and structured MCP response equivalence tests;
- private/public reader contract suites for every tool;
- community-reader contract tests for metadata-only policy, missing-image warnings, and keyword/structured fallback;
- skill/catalog wiring and removed-name CI tests;
- clean-clone `npm ci` verification;
- actual tarball installation and registry-installed smoke tests;
- tarball scans for raster extensions, image magic bytes, and snapshot asset directories;
- task-level review and a holistic review before each release gate; routine doc-only or mechanical commits do not require a separate institutional review ceremony.

## 11. Explicitly Out of Scope

- hosted HTTP product infrastructure;
- accounts, billing, entitlements, or multi-region delivery;
- public redistribution of private screenshot bytes;
- automatic publication clearance during retagging;
- full multi-file import transaction state machine as part of retag promotion;
- resumable retag job orchestration;
- latency as a promotion stop gate (record it for provider decisions instead);
- multi-screen consistency review in the MCP rename increment;
- separate accessibility, motion, copy, or token tools;
- design-system derivation before retag coverage is measured;
- three separately discoverable broad companion skills before usage evidence.

## 12. Success Definition

The project is ready to recruit coding-agent users when:

1. Phase 1C records Replacement, Fill-only, or Deferred, and the corresponding full, reduced, or no-mutation audit is complete with current field coverage disclosed;
2. publication-selected metadata-only entries pass the public policy and leak suite;
3. the beta-stable 12-tool catalog and skill workflows pass private/public contracts;
4. the actual npm package installs and works outside the repository;
5. the first registry version has been smoked and promoted deliberately;
6. rollback procedures for corpus and npm distribution have been exercised;
7. beta telemetry is privacy-safe and limited to operational/product metrics.
