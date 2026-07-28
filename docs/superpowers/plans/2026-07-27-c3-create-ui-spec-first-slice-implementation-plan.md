# C3 `create_ui_spec` First Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and verify the C3 core producer that turns a normalized product brief into a validated, evidence-grounded `UiSpec`, deterministic `DESIGN.md` and JSON handoffs, and a parsed integrity envelope ready for later adapters.

**Architecture:** A shared `createUiSpec()` service owns retrieval, typed evidence sanitization, deterministic assembly, candidate validation, envelope construction, and rendering. The core returns only a parsed `DesignArtifactEnvelope`; MCP, HTTP, live-provider enrichment, and the Playground are follow-up adapters over this boundary.

**Tech Stack:** TypeScript, Zod, Vitest, existing `UiSpec` 1.0, corpus reader, canonical JSON helpers, and design-handoff renderers.

## Global Constraints

- Keep `UiSpec` 1.0 unchanged; wrap it in `DesignArtifactEnvelope`.
- Adapter presentation selection is deferred; the core returns both deterministic renderings.
- Automatic retrieval selects at most five product-diverse references.
- Private corpus IDs, paths, source URLs, product identities, screenshots, and raw excerpts never enter public output, DOM, logs, or analytics.
- Corpus observations are represented only by response-scoped `evidence-*` IDs. They may populate `authorityLanes.corpusEvidence`, `provenance.evidenceIds`, and decision `evidenceIds`, but never `citedReferences`, `provenance.sourceReferences`, `ComponentEntry.sourceId`, `TechniqueEntry.sourceIds`, or `AntiPatternEntry.sourceIds`.
- `citedReferences` and source-bearing `UiSpec` fields are populated only from explicit user-supplied public references that pass URL/reference validation; private corpus IDs are never transformed into public-looking references.
- Corpus sanitization is an allowlist projection: only approved closed-vocabulary tokens and bounded aggregate counts cross the boundary. Human-readable corpus summaries come from fixed recipe templates, never from `critique`, voice text, product names, URLs, screenshots, or arbitrary corpus prose.
- Providers receive only branded `SanitizedEvidence`, never raw `CorpusEntry` values.
- Model output is an untrusted `CreateUiSpecCandidate`; it never assigns authority or evidence membership.
- The deterministic `c3-fallback-v1` recipe always produces the base candidate.
- The deterministic `c3-fallback-v1` path is the only provider path in this milestone; live-provider calls are deferred.
- `artifactId` hashes exactly the canonical identity object defined in the design spec; `generatedAt` is excluded from identity.
- Envelope parsing recomputes hashes and re-renders both handoffs, requiring exact byte equality.
- The fallback recipe is loaded through a NodeNext-compatible JSON import with `with { type: "json" }`; the compiled runtime probe executes the producer so typechecking cannot mask an ESM loading failure.
- No HTTP server, MCP registration, browser route, Vite proxy, or credential path is changed in this milestone.

---

## File Map

### Create

- `src/create-ui-spec-contracts.ts` — strict sanitized-evidence, candidate, artifact-envelope, metadata, and canonical-hash contracts.
- `src/c3/fallback-recipe-v1.json` — checked-in deterministic assembly rules and recipe identity.
- `src/c3/fallback-recipe-v1.test.ts` — canonical recipe bytes and expected SHA tests.
- `scripts/c3-runtime-probe.mjs` — isolated compiled-runtime probe that imports and invokes the producer with a fixture reader.
- `src/create-ui-spec.ts` — shared producer service, retrieval, sanitization, deterministic assembly, and envelope construction.
- `src/create-ui-spec.test.ts` — producer behavior, privacy, fallback, opaque-reference resolution, and deterministic identity tests.
- `src/create-ui-spec-contracts.test.ts` — candidate/envelope parser and hash-boundary tests.

- `src/c3/safe-aggregator.ts` — pure fallback aggregation over `SanitizedEvidence` only; no raw `CorpusEntry` or free-form corpus prose crosses this boundary.
- `src/c3/safe-aggregator.test.ts` — closed-vocabulary aggregation, deterministic ordering, and raw-corpus type-boundary tests.

### Modify

- `src/tool-contracts.ts` — rename/export the existing schema as `DesignSystemIdentitySchema` and export `type DesignSystemIdentity = z.infer<typeof DesignSystemIdentitySchema>`; update the two existing internal references to use the exported schema so the core request shares one validator with `UiSpec`.

### Existing contract modules to reuse

- `src/design-target-contracts.ts` and `src/design-handoff.ts` — validated handoff input and deterministic renderers.
- `src/corpus-reader.ts` — injected `CorpusReader.searchRanked()` and `getById()` access.
- `src/recommend.ts` — existing `pickDiverse()` selector for automatic product-diverse evidence selection; do not reuse its private-data renderer.
- `src/tool-contract-integrity.ts` — retrieval/evidence envelope invariants.

---

## Phase 1: Core Contract and Producer

### Task 1: Establish the strict C3 contracts

**Files:**
- Create: `src/create-ui-spec-contracts.ts`
- Create: `src/create-ui-spec-contracts.test.ts`
- Modify: `src/tool-contracts.ts`

**Interfaces:**
- Produces `CreateUiSpecRequest`, `SanitizedEvidence`, `CreateUiSpecCandidate`, `CreateUiSpecError`, `ArtifactMetadata`, `DesignArtifactEnvelope`, `buildSemanticSpecInput()`, `buildArtifactIdentityInput()`, `sha256Canonical()`, `parseCreateUiSpecCandidate()`, and `parseDesignArtifactEnvelope()`.
- Produces a strict `RetrievalState` with the exact state matrix: automatic keyword results use `keyword/metadata`; automatic zero-match uses `structured-fallback/metadata` plus a sparse-evidence warning; explicit valid or partially valid references use `none/none` plus bounded omitted-reference metadata; explicit all-missing references and reader/search failures raise typed retrieval/input errors.
- `parseDesignArtifactEnvelope(raw: unknown): DesignArtifactEnvelope` throws a contract error for invalid data and returns only parsed, re-render-verified envelopes.

- [ ] **Step 1: Write failing schema tests.** Cover strict unknown-key rejection, private-marker rejection, response-scoped evidence IDs, the exact candidate variant table, duplicate decision IDs, and the envelope fields. Add `parseCreateUiSpecCandidate(raw, allowedEvidenceIds)` tests for evidence membership, duplicate decision IDs, and bounded safe errors. Cover the core error union (`INVALID_INPUT` and `RETRIEVAL_UNAVAILABLE` with bounded safe messages and `retryable`) and the fact that `CreateUiSpecRequestSchema.designSystem` accepts/rejects exactly the exported `DesignSystemIdentitySchema` values.

```ts
it("rejects a candidate with an unbound evidence ID", () => {
  const result = CreateUiSpecCandidateSchema.safeParse({
    candidateVersion: "1.0",
    decisions: [{
      field: "designDirection",
      id: "direction-1",
      value: "Clear hierarchy",
      rationale: "Supported by the visible evidence.",
      evidenceIds: ["evidence-99"],
    }],
  });
  expect(result.success).toBe(false);
});
```

- [ ] **Step 2: Run the focused test to verify failure.**

Run: `npm test -- src/create-ui-spec-contracts.test.ts`

Expected: FAIL because the new schemas and parser do not exist.

- [ ] **Step 3: Implement strict schemas.** Use `.strict()` for every object. Define `SanitizedEvidenceSchema` with response-scoped `id`, allowed `kind`, allowed `basis`, a bounded recipe-owned summary, an allowlisted structured-facts object, optional `publicReference` that is accepted only for explicit user/public input, and no private identity fields. The schema and assembler must distinguish `corpus-observation` evidence from public references: corpus observations receive fresh `evidence-*` IDs and cannot populate any public `sourceId`/`sourceIds` or citation field. Define the candidate as a discriminated union with these variants and limits:

The core request contract is separate from the deferred MCP input contract:

```ts
export const CreateUiSpecRequestSchema = z.object({
  productContext: z.string().trim().min(8).max(8_000),
  referenceIds: z.array(z.string().trim().min(1).max(200)).max(5)
    .default([]).refine((ids) => new Set(ids).size === ids.length),
  platform: z.enum(["web", "mobile", "tablet"]).optional(),
  implementationFramework: z.string().trim().min(1).max(120).optional(),
  designSystem: DesignSystemIdentity.optional(),
  constraints: z.array(z.string().trim().min(1).max(500)).max(12).default([]),
  target: WebTargetId.optional(),
  motionIntents: z.array(MotionIntentSchema).max(8).default([]),
}).strict();
```

`target` is optional and is passed to the existing handoff parser, which applies
the canonical `neutral-web` default. `motionIntents` are already structured;
the core never parses motion out of free-form prose.

```ts
const CandidateDecisionSchema = z.discriminatedUnion("field", [
  DesignDirectionDecisionSchema,
  RejectedDefaultsDecisionSchema,
  LayoutRegionsDecisionSchema,
  ResponsiveBehaviorDecisionSchema,
  ComponentInventoryDecisionSchema,
  ColorTokensDecisionSchema,
  TypographyTokensDecisionSchema,
  InteractionsDecisionSchema,
  MotionGuidanceDecisionSchema,
  AccessibilityConstraintsDecisionSchema,
  ContentVoiceGuidanceDecisionSchema,
  TechniquesDecisionSchema,
  AntiPatternsDecisionSchema,
  FrameworkNotesDecisionSchema,
  AcceptanceCriteriaDecisionSchema,
]);

export const CreateUiSpecCandidateSchema = z.object({
  candidateVersion: z.literal("1.0"),
  decisions: z.array(CandidateDecisionSchema).max(32),
}).strict();
```

Define `CreateUiSpecErrorSchema` as a strict discriminated union:

```ts
const CreateUiSpecErrorSchema = z.discriminatedUnion("code", [
  z.object({ code: z.literal("INVALID_INPUT"), message: SafeErrorMessage, retryable: z.literal(false) }).strict(),
  z.object({ code: z.literal("RETRIEVAL_UNAVAILABLE"), message: SafeErrorMessage, retryable: z.literal(true) }).strict(),
]);
```

`SafeErrorMessage` is a bounded operator-safe message that excludes stack traces, file paths, corpus IDs, URLs, credentials, and raw reader/provider text. The producer wraps all reader exceptions in `RETRIEVAL_UNAVAILABLE`; adapters map these core errors to their own transport error unions later.

Each decision requires a unique non-empty `id`, bounded rationale, and at most eight `evidenceIds`. Implement the exact value shapes and limits below; do not replace them with a generic record:

| `field` variants | Value shape | Limits |
| --- | --- | --- |
| `designDirection`, `rejectedDefaults`, `contentVoiceGuidance`, `frameworkNotes` | bounded text | 2,000 characters |
| `layoutRegions`, `responsiveBehavior`, `componentInventory`, `techniques`, `antiPatterns`, `acceptanceCriteria` | bounded string arrays or strict structured rows | 12 rows; 500 characters per item |
| `colorTokens`, `typographyTokens` | strict token rows with `name`, `value`, and `rationale` | 24 rows; 120 characters per scalar |
| `interactions`, `motionGuidance`, `accessibilityConstraints` | strict rows with required `category` and `statement` | 16 rows; 500 characters per statement |

All row objects are strict; arrays reject duplicates where the destination contract requires uniqueness. Reject structural Markdown, private-path markers, empty IDs, unbound evidence IDs, duplicate decision IDs, and more than 32 decisions. The candidate-to-`UiSpec` mapping is fixed and exhaustive:

| Candidate `field` | `UiSpec` destination | Assembly rule |
| --- | --- | --- |
| `designDirection` | `designDirection` | use the bounded text decision |
| `rejectedDefaults` | `rejectedDefaults` | use the bounded list |
| `layoutRegions` | `layoutRegions` | parse destination rows through the existing `UiSpec` schema |
| `responsiveBehavior` | `responsiveBehavior` | use the bounded list |
| `componentInventory` | `componentInventory` | public `sourceId` remains empty for corpus evidence |
| `colorTokens` | `colorTokens` | if unsupported, emit `null` plus the required unavailable decision |
| `typographyTokens` | `typographyTokens` | if unsupported, emit `null` plus the required unavailable decision |
| `interactions` | `interactions` | retain only approved categories/statements |
| `motionGuidance` | `motionGuidance` | preserve `evidenceUnavailable` truthfully |
| `accessibilityConstraints` | `accessibilityConstraints` | use the bounded list/rows |
| `contentVoiceGuidance` | `contentVoiceGuidance` | recipe-owned text only for corpus-backed fallback |
| `techniques` | `techniques` | corpus `sourceIds` remain empty |
| `antiPatterns` | `antiPatterns` | corpus `sourceIds` remain empty |
| `frameworkNotes` | `frameworkNotes` | only normalized request/recipe content |
| `acceptanceCriteria` | `acceptanceCriteria` | every emitted criterion must satisfy the existing contract |

Candidate evidence IDs are checked against the sanitized set before assembly. Unmapped, unsupported, or structurally invalid proposals are discarded with a typed warning; they are never accepted through a type assertion.

- [ ] **Step 4: Implement exact identity and metadata schemas.** Add `ArtifactMetadataSchema` and `DesignArtifactEnvelopeSchema`. Add `buildSemanticSpecInput(spec)` that deep-copies the parsed `UiSpec` and replaces only `provenance.generatedAt` with the fixed schema-valid sentinel `"1970-01-01T00:00:00.000Z"`; it must not omit fields or normalize any other value. Hash `canonicalJsonStringify(buildSemanticSpecInput(spec))` for `semanticSpecSha256`. Add `buildArtifactIdentityInput()` that returns exactly:

```ts
{
  artifactVersion: "1.0",
  producerVersion,
  assemblyRulesSha256,
  semanticSpecSha256,
  handoffInputs: { target, motionIntents },
  renderingFormatVersion: "web-1.0",
}
```

The helper must reject or ignore no fields silently: callers pass the exact typed object, and tests prove `generatedAt`, provider diagnostics, renderings, and timestamps cannot enter it.

- [ ] **Step 5: Implement parser re-render verification.** `parseDesignArtifactEnvelope()` must validate nested `UiSpec` and handoff, recompute `specSha256`, semantic hash, identity hash, and all rendering hashes, call `renderDesignHandoffMarkdown()` and `renderDesignHandoffJson()`, and require exact equality with stored rendering bytes before returning.

- [ ] **Step 6: Implement the evidence-aware candidate parser.** Keep `CreateUiSpecCandidateSchema` structural and add `parseCreateUiSpecCandidate(raw, allowedEvidenceIds)`. It must parse the candidate, enforce that every decision `evidenceId` belongs to the supplied sanitized set, reject duplicate decision IDs and private markers, and return only the parsed candidate. The assembler must call this parser before mapping any decision into `UiSpec`.

- [ ] **Step 7: Run the focused tests to verify they pass.**

Run: `npm test -- src/create-ui-spec-contracts.test.ts`

Expected: PASS, including tampered-rendering, timestamp-identity, private-marker, and re-render mismatch cases.

- [ ] **Step 8: Commit the contract boundary.**

```bash
git add src/create-ui-spec-contracts.ts src/create-ui-spec-contracts.test.ts src/tool-contracts.ts
git commit -m "feat(c3): add strict create-ui-spec artifact contracts"
```

### Task 2: Add the deterministic fallback recipe

**Files:**
- Create: `src/c3/fallback-recipe-v1.json`
- Create: `src/c3/fallback-recipe-v1.test.ts`

**Interfaces:**
- Produces a checked-in JSON recipe imported by the producer.
- Recipe identity is `c3-fallback-v1` plus a SHA over canonical JSON bytes.

- [ ] **Step 1: Write the recipe identity test.** The test imports the JSON, canonicalizes it with the repository canonical JSON helper, hashes it, and asserts the expected version and SHA constants.

```ts
it("has stable canonical bytes and recipe identity", () => {
  expect(recipe.recipeVersion).toBe("c3-fallback-v1");
  expect(sha256Canonical(recipe)).toBe(EXPECTED_RECIPE_SHA256);
});
```

- [ ] **Step 2: Run the test to verify failure.**

Run: `npm test -- src/c3/fallback-recipe-v1.test.ts`

Expected: FAIL because the recipe and expected identity do not exist.

- [ ] **Step 3: Add the recipe.** Encode field-by-field fallback rules, warning codes, unavailable model-dependent decisions, allowed evidence kinds, and the one machine-rule acceptance criterion. Do not encode provider responses, corpus IDs, timestamps, or raw prose from corpus entries.

- [ ] **Step 4: Freeze the expected canonical SHA.** Compute it once from the checked-in bytes, place the literal in the test, and ensure the producer imports the recipe rather than reading from `process.cwd()`.

- [ ] **Step 5: Verify recipe source and built-runtime loading.** Use a NodeNext-compatible import with `with { type: "json" }` in the producer. After compilation, run an isolated recipe-only probe that imports `dist/c3/fallback-recipe-v1.json`, asserts `recipeVersion` and the expected SHA, and confirms the recipe can be loaded without `process.cwd()` or a source-tree lookup. The producer invocation probe belongs to Task 3/Core Milestone Gate.

Run: `npm test -- src/c3/fallback-recipe-v1.test.ts && npm run typecheck:contracts && npx tsc --pretty false && node --input-type=module -e 'import recipe from "./dist/c3/fallback-recipe-v1.json" with { type: "json" }; if (recipe.recipeVersion !== "c3-fallback-v1") process.exit(1)'`

Expected: PASS; the recipe import is typed, the compiled JSON asset loads through Node ESM, and no source-tree runtime lookup is used.

- [ ] **Step 6: Commit the recipe.**

```bash
git add src/c3/fallback-recipe-v1.json src/c3/fallback-recipe-v1.test.ts
git commit -m "feat(c3): pin deterministic create-ui-spec fallback recipe"
```

### Task 3: Implement retrieval, sanitization, deterministic assembly, and envelope construction

**Files:**
- Create: `src/create-ui-spec.ts`
- Create: `src/create-ui-spec.test.ts`

**Interfaces:**

```ts
export interface CreateUiSpecDependencies {
  readonly reader: CorpusReader;
  /** Resolve an opaque caller token to an internal corpus entry ID. Raw corpus IDs are not valid public tokens. */
  readonly resolveReferenceToken: (token: string) => string | undefined;
  readonly now?: () => Date;
}

export function createUiSpec(
  input: CreateUiSpecRequest,
  dependencies: CreateUiSpecDependencies,
): Promise<DesignArtifactEnvelope>;
```

- [ ] **Step 1: Write failing producer tests.** Cover automatic retrieval capped at five, a spy reader returning more than 20 ranked results and the producer slicing to 20 before `pickDiverse()`/sanitization, product diversity with more than two high-ranked entries from one product, deterministic backfill when the fixture contains too few products, automatic keyword success (`keyword/metadata`), automatic zero-match (`structured-fallback/metadata` plus sparse warning), explicit valid and partial references (`none/none` with bounded omissions), explicit all-missing rejection, typed reader/search failure, opaque reference-token resolution, rejection of a raw corpus ID passed as a token, separation of explicit public citations from corpus evidence, response-scoped evidence IDs, raw corpus privacy, deterministic output, and empty/partial evidence handling.

Add a table-driven sparse-evidence suite for zero automatic matches, one automatic match, partial explicit references, and model-dependent fields unavailable. For every allowed case, assert that the envelope parses; retrieval state and warning codes match the matrix; every emitted evidence ID is present in the envelope; unavailable fields have the required `unavailableDecisions`; and no warning claims evidence that was not retrieved.

```ts
it("never exposes a corpus ID in the sanitized envelope", async () => {
  const envelope = await createUiSpec(validInput, { reader: fixtureReader });
  const serialized = JSON.stringify(envelope);
  expect(serialized).not.toContain("private-corpus-id");
  expect(envelope.publicEvidenceIds).toEqual(["evidence-1"]);
});
```

- [ ] **Step 2: Add deterministic-boundary tests.** Verify the normalized brief limit, no provider dependency, stable fallback recipe identity, and that timestamp-only reruns produce the same `buildSemanticSpecInput()`, `semanticSpecSha256`, and `artifactId` while `specSha256`, `designMarkdownSha256`, and `designJsonSha256` may change with the instance timestamp.

- [ ] **Step 3: Run the focused tests to verify failure.**

Run: `npm test -- src/create-ui-spec.test.ts`

Expected: FAIL because the producer service is absent.

- [ ] **Step 4: Implement input normalization and evidence resolution.** Parse `CreateUiSpecRequest`, whose exact fields are `productContext`, `referenceIds`, `platform`, `implementationFramework`, `designSystem`, `constraints`, `target`, and `motionIntents`. For automatic selection, call `CorpusReader.searchRanked({ query: productContext, platform, limit: 20, searchMode: "keyword-only" })`, then reuse `pickDiverse(results, 5)` before sanitization. Record `retrievalMode: "keyword"` and the actual fallback reason in `RetrievalState`; the core must never dispatch to Voyage or another network-backed search path. For explicit references, call `getById()` for each requested ID and preserve only the requested identities. `outputFormat` is deliberately absent because adapters own presentation selection later.
- [ ] **Step 4: Implement input normalization and evidence resolution.** Parse `CreateUiSpecRequest`, whose exact fields are `productContext`, `referenceIds`, `platform`, `implementationFramework`, `designSystem`, `constraints`, `target`, and `motionIntents`. For automatic selection, call `CorpusReader.searchRanked({ query: productContext, platform, limit: 20, searchMode: "keyword-only" })`, immediately slice the returned list to `results.slice(0, 20)`, then reuse `pickDiverse(results, 5)` before sanitization. Record `keyword/metadata` on success; record `structured-fallback/metadata` and a sparse-evidence warning for zero matches. The core must never dispatch to Voyage or another network-backed search path. For explicit references, resolve each opaque `referenceId` through `dependencies.resolveReferenceToken()` and then call `reader.getById()` on the internal ID. Raw corpus IDs are rejected as tokens unless the resolver explicitly recognizes them as an approved opaque token. Valid and partially valid requests use `none/none` with bounded omitted tokens, while an all-missing request raises `CreateUiSpecError` with `INVALID_INPUT`. A reader/search exception is wrapped as `RETRIEVAL_UNAVAILABLE` with a safe message and never silently substitutes another identity. `outputFormat` is deliberately absent because adapters own presentation selection later.

- [ ] **Step 5: Implement the typed sanitizer.** Construct `SanitizedEvidence` only through one function that performs an allowlist projection from `CorpusEntry`: retain only approved enum tokens, bounded counts, and booleans needed by the fallback recipe. Generate the summary from a fixed recipe template keyed by those tokens. Never pass `critique`, voice text, product names, source URLs, image paths, screenshots, or other free-form corpus fields to the candidate builder or renderer. Assign `evidence-1`, `evidence-2`, etc. in response order. Do not copy or hash the private source identity into a public field. For explicit user/public references, retain the validated public reference in the separate cited-reference domain and preserve its approved identity without mixing it with corpus evidence.

- [ ] **Step 6: Implement the safe aggregator and deterministic provider.** Add `src/c3/safe-aggregator.ts` with functions that accept only `SanitizedEvidence` and return closed-vocabulary aggregates plus recipe-owned summaries. Do not call `generateBrief()`, `renderBrief()`, or any helper that consumes raw `CorpusEntry` prose; sanitizing after raw-corpus synthesis is explicitly out of bounds. Use the imported recipe and the safe aggregator to build the fallback candidate. The assembler assigns `authorityLanes`, `CitedDecision.authority`, readiness, warnings, and unavailable decisions. Corpus-derived decisions may reference only the response-scoped evidence IDs. Only explicit public references may populate `citedReferences`, `provenance.sourceReferences`, `ComponentEntry.sourceId`, `TechniqueEntry.sourceIds`, or `AntiPatternEntry.sourceIds`; private corpus observations leave those fields empty. Candidate evidence IDs are checked against the sanitized evidence set before any field is copied into `UiSpec`; parse the final result through the existing `UiSpec` schema.

- [ ] **Step 7: Keep live enrichment outside this milestone.** Do not add a live provider interface, credentials, retries, network calls, timeout orchestration, or single-flight state to the core producer. Implement one deterministic `buildFallbackCandidate()` function backed by the recipe; its boundary is covered by the recipe and contract tests.

- [ ] **Step 8: Build the envelope.** Generate one `generatedAt`, build the validated handoff, render both handoff formats, compute exact instance hashes and stable semantic identity, then call `parseDesignArtifactEnvelope()` before returning.

- [ ] **Step 9: Run focused tests and typecheck.**

Run: `npm test -- src/create-ui-spec.test.ts src/create-ui-spec-contracts.test.ts && npm run typecheck:contracts`

Expected: PASS with zero network calls and no private markers in serialized results.

- [ ] **Step 10: Run the compiled producer probe.** After the producer exists, run `npx tsc --pretty false && node scripts/c3-runtime-probe.mjs` with an in-memory fixture reader. The probe imports and invokes the compiled producer, checks the fallback recipe version/identity, parses the returned envelope, and fails if any source-tree lookup or private marker appears.

- [ ] **Step 11: Commit the producer.**

```bash
git add src/create-ui-spec.ts src/create-ui-spec.test.ts
git commit -m "feat(c3): add evidence-grounded create-ui-spec producer"
```

### Core Milestone Gate

- [ ] `npm test -- src/create-ui-spec-contracts.test.ts src/create-ui-spec.test.ts src/c3/fallback-recipe-v1.test.ts`
- [ ] `npm run typecheck:contracts`
- [ ] A clean compiled-runtime probe imports and invokes the producer, loading the fallback recipe from `dist`.
No adapter or site changes are merged until this gate passes.

---

## Deferred Follow-ups

These are deliberately not part of the core milestone and require a fresh plan
after the core envelope is accepted:

- MCP contract migration and public registration, including
  `outputFormat`, retrieval policy, and safe `structuredContent` metadata.
- Loopback HTTP adapter with Origin allowlist, CSRF nonce, redacted errors, and
  production static serving.
- Optional live provider with strict JSON parsing, 30-second timeout, 4,096
  output-token cap, 24,000-character prompt cap, abort handling, and a
  single-flight guard.
- Focused Playground composer, API client, Vite proxy, download flow, and
  browser accessibility/privacy tests.

## Final Core Verification Checklist

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck:contracts`.
- [ ] Run `npm run build`.
- [ ] Run `npm run check-public-site-boundary` through the normal build gate.
- [ ] Verify the compiled runtime imports and uses `dist/c3/fallback-recipe-v1.json` without reading from the source tree.
- [ ] Verify `artifactId` and `semanticSpecSha256` remain stable across timestamp-only reruns while `specSha256`, `designMarkdownSha256`, and `designJsonSha256` may change.
- [ ] Verify tampered `designMarkdown` and `designJson` are rejected by the envelope parser even when their supplied hashes are self-consistent.
- [ ] Verify no private corpus ID, path, URL, product identity, screenshot, raw excerpt, provider diagnostic, or credential appears in the serialized core envelope or producer diagnostics.
- [ ] Record the core producer commit SHA and fallback recipe SHA.

## Delivery Handoff

Core-first plan saved to `docs/superpowers/plans/2026-07-27-c3-create-ui-spec-first-slice-implementation-plan.md`. Execute it only after the engineering review is complete, using one of these paths:

1. **Subagent-driven:** dispatch a fresh implementation worker per task and review each task before proceeding.
2. **Inline execution:** execute the tasks in this session with checkpoints after each phase gate.

## NOT in scope

- MCP contract migration and public tool registration; deferred until the core envelope is accepted so transport cannot become a second producer.
- Loopback HTTP, CSRF/origin controls, static serving, and browser lifecycle behavior; these require a separate adapter plan.
- Live provider calls, credentials, retries, timeouts, abort handling, single-flight state, and model-quality evaluation; the first slice is deterministic and offline.
- Playground/Vite composer work, download UX, and browser accessibility/privacy tests; no user-facing route changes are part of this milestone.
- Corpus-wide retagging, source-snapshot promotion, or baseline/evaluation work; C3 consumes the existing reader and does not change corpus governance.
- Changes to `UiSpec` 1.0 semantics or the existing handoff renderer contract; the new envelope wraps and validates those contracts.

## What already exists

- `src/design-target-contracts.ts` and `src/design-handoff.ts` already provide the fail-closed handoff parser plus deterministic Markdown/JSON renderers; C3 calls them after assembling `UiSpec`.
- `src/corpus-reader.ts` already provides injected ranked search and ID lookup; C3 pins keyword-only search and adds only an opaque-token resolver dependency.
- `src/recommend.ts` already provides `pickDiverse()`; C3 reuses the selector after a bounded 20-result slice and does not reuse its private-data renderer.
- `src/readiness/contracts.ts` already provides canonical JSON and SHA-256 helpers; C3 reuses the canonicalization behavior rather than introducing a second hash implementation.
- `src/tool-contracts.ts` already owns `UiSpec` and `DesignSystemIdentity`; C3 exports the existing schema/type and reuses it rather than duplicating validation.
- `src/design-prompt.ts` is intentionally not reused because it consumes raw corpus prose and product identities; the new safe aggregator accepts only `SanitizedEvidence`.

## C3 Test Coverage Diagram

```text
CODE PATHS                                                   USER / OPERATOR FLOWS

[+] createUiSpec(request, dependencies)                      [+] Submit normalized product brief
  |                                                           |   `referenceIds` empty
  +-- parse request                                            |     +-- keyword-only search
  |     +-- invalid shape -> INVALID_INPUT                    |     +-- slice 20 -> pickDiverse(5)
  |                                                            |     +-- allowlist sanitize
  +-- referenceIds present?                                   |     +-- safe aggregate -> fallback candidate
  |     +-- resolve opaque tokens                              |     +-- validate -> render -> envelope
  |     |     +-- missing all -> INVALID_INPUT                 |     +-- [★★★ TESTED] success + stable identity
  |     |     +-- partial -> none/none + omissions              |
  |     |     +-- valid -> none/none                            +-- Submit with zero keyword matches
  |     +-- reader.getById()                                    |     +-- structured-fallback/metadata
  |           +-- reader failure -> RETRIEVAL_UNAVAILABLE       |     +-- sparse warning + unavailable fields
  |                                                            |     +-- [★★★ TESTED] valid fallback
  +-- automatic keyword-only search                           |
  |     +-- reader failure -> RETRIEVAL_UNAVAILABLE            +-- Submit explicit references
  |     +-- zero results -> structured-fallback/metadata       |     +-- token resolution, partial omission
  |     +-- results -> slice(0,20) -> pickDiverse               |     +-- raw corpus ID rejected
  |                                                            |     +-- [★★★ TESTED] no identity substitution
  +-- sanitize CorpusEntry                                     |
  |     +-- allowlisted enums/counts only                       +-- Candidate / envelope tampering probe
  |     +-- fixed recipe summary                                |     +-- unbound evidence -> parser error
  |     +-- private prose/IDs -> never copied                    |     +-- changed bytes -> parser error
  |                                                            |     +-- [★★★ TESTED] no public leakage
  +-- safe-aggregator(SanitizedEvidence)                       |
  |     +-- deterministic candidate from recipe                  +-- Compiled runtime execution
  |     +-- model-dependent fields unavailable                    |     +-- import JSON from dist
  |                                                            |     +-- invoke producer with fixture reader
  +-- parseCreateUiSpecCandidate(candidate, evidenceIds)        |     +-- [★★★ TESTED] no source-tree lookup
  |     +-- structural schema                                   |
  |     +-- evidence membership                                +-- [→E2E DEFERRED] MCP/HTTP/Playground
  |     +-- private-marker rejection                            |     adapters are intentionally out of scope
  |                                                            |
  +-- assemble UiSpec                                          LLM/eval: none in this slice; live provider
  |     +-- authority lanes + warnings                           and prompt-quality eval are deferred.
  |     +-- unavailableDecision coupling
  |     +-- explicit public citations only
  |                                                            |
  +-- build handoff -> render Markdown + JSON
  |     +-- one generatedAt
  |     +-- instance hashes
  |     +-- semantic sentinel hash
  |                                                            |
  +-- parseDesignArtifactEnvelope
        +-- nested schema validation
        +-- recompute all hashes
        +-- rerender exact bytes
        +-- return parsed envelope / reject

COVERAGE TARGET: all planned branches have unit/contract tests; compiled
producer invocation is a smoke/integration probe; adapters are deferred.
QUALITY TARGET: behavior + edge + error tests for every core branch.
```

## Failure Modes

| Failure mode | Test | Handling | User-visible result |
|---|---|---|---|
| Malformed request or invalid design-system shape | Contract tests | Zod parse returns `INVALID_INPUT` | Safe actionable error from future adapter |
| Raw corpus ID supplied as explicit token | Opaque-token test | Resolver rejects without lookup/substitution | Safe invalid-input error |
| All explicit tokens missing | Partial/all-missing table test | `INVALID_INPUT`; no alternate identity selected | Clear correction path |
| Reader/search throws or returns inaccessible data | Reader-failure test | Wrap as `RETRIEVAL_UNAVAILABLE`; raw exception stays private | Retryable safe error |
| Automatic search returns zero results | Sparse table test | Deterministic recipe output plus `structured-fallback/metadata` and warning | Valid fallback artifact with truthful warning |
| Sanitizer accidentally receives free-form corpus prose | Type boundary + distinctive-marker tests | Safe aggregator accepts only `SanitizedEvidence`; fixed templates | No silent public leak; test fails before ship |
| Candidate references unknown evidence | Evidence-aware parser test | Reject candidate before assembly | No artifact returned from invalid candidate |
| Candidate proposal is unsupported or malformed | Variant/mapping tests | Discard with bounded warning; unavailable field remains explicit | Honest partial artifact |
| Recipe JSON fails in compiled ESM runtime | Recipe probe + producer probe | Build/gate fails before release | No runtime fallback to source tree |
| Handoff rendering or stored bytes are tampered | Envelope parser tests | Recompute hashes/rerender and reject mismatch | Integrity error, no corrupted artifact accepted |
| Timestamp-only rerun changes semantic identity | Hash stability test | Sentinel normalization keeps semantic hash and artifact ID stable | Reproducible identity with new instance hashes |
| Ranked reader returns an unexpectedly large list | Spy-reader cap test | C3 slices to 20 before diversity/sanitization | Bounded producer working set |

No critical silent failure gaps remain after the accepted decisions.

## Parallelization

| Step | Modules touched | Depends on |
|---|---|---|
| Task 1: contracts | `src/` contract modules | existing `UiSpec`/handoff contracts |
| Task 2: fallback recipe | `src/c3/`, compiled recipe probe | existing canonical hash helper; producer probe waits for Task 3 |
| Task 3: producer and safe aggregator | `src/`, `scripts/` | Tasks 1 and 2 |
| Core milestone gate | repository-wide build/test commands | Tasks 1-3 |

Lane A: Task 1 (independent contract work)

Lane B: Task 2 (independent recipe work; recipe-only runtime check)

Lane C: Task 3 (sequential after A + B; owns the producer probe)

Execution order: launch Lane A and Lane B in parallel worktrees if desired; merge both, then run Lane C; run the repository-wide milestone gate last. Lane A and Lane B do not share new modules. Lane C touches `src/` modules changed by both earlier lanes, so it should be sequential after their merge.

## Implementation Tasks

Synthesized from this review's findings. Each task derives from a specific
finding above. Checkbox these as the plan is implemented.

- [ ] **T1 (P1, human: ~1h / CC: ~10min)** — Core contracts — add `CreateUiSpecError`, evidence-aware candidate parsing, and exact candidate mapping contracts.
  - Surfaced by: Architecture D10/D11/D12; Code Quality C3; Test T1.
  - Files: `src/create-ui-spec-contracts.ts`, `src/create-ui-spec-contracts.test.ts`, `src/tool-contracts.ts`.
  - Verify: `npm test -- src/create-ui-spec-contracts.test.ts && npm run typecheck:contracts`.
- [ ] **T2 (P1, human: ~45min / CC: ~8min)** — Retrieval boundary — pin keyword-only mode, opaque-token resolution, 20-result slicing, and exact retrieval/error matrix.
  - Surfaced by: Architecture D5/D8/D12; Performance P1; Test T2/T3.
  - Files: `src/create-ui-spec.ts`, `src/create-ui-spec.test.ts`.
  - Verify: focused producer tests cover mode, token, cap, diversity, sparse, and failure branches.
- [ ] **T3 (P1, human: ~1h / CC: ~10min)** — Privacy boundary — implement allowlist projection and the `SanitizedEvidence`-only safe aggregator with recipe-owned summaries.
  - Surfaced by: Architecture D4/D7/D9; Test T3.
  - Files: `src/c3/safe-aggregator.ts`, `src/c3/safe-aggregator.test.ts`, `src/create-ui-spec.ts`, `src/create-ui-spec.test.ts`.
  - Verify: distinctive corpus-marker fixtures never appear in the envelope, Markdown, JSON, diagnostics, or candidate input.
- [ ] **T4 (P2, human: ~45min / CC: ~8min)** — Runtime and identity integrity — use NodeNext JSON import attributes, sentinel semantic hashing, and compiled producer probe.
  - Surfaced by: Architecture D6/D11; Code Quality C2; parallelization review.
  - Files: `src/c3/fallback-recipe-v1.json`, `src/create-ui-spec.ts`, `scripts/c3-runtime-probe.mjs`, focused tests.
  - Verify: `npx tsc --pretty false && node scripts/c3-runtime-probe.mjs` plus timestamp-only identity tests.
- [ ] **T5 (P2, human: ~30min / CC: ~5min)** — Verification boundaries — keep Task 1 commit scope complete and reserve the full repository build for the milestone gate.
  - Surfaced by: Code Quality C1/C2.
  - Files: plan task boundaries and package verification commands.
  - Verify: focused commands pass independently; final `npm run build` is run once at the core gate.

## Review Summary

- Scope challenge: scope reduced to the deterministic core-first slice; MCP, HTTP, live-provider, and Playground work remain deferred.
- Architecture review: 11 issues found and resolved through explicit decisions.
- Code Quality review: 3 issues found and resolved.
- Test review: coverage diagram produced; 3 gaps found and resolved.
- Performance review: 1 issue found and resolved.
- NOT in scope: written above.
- What already exists: written above.
- TODOS.md updates: no new TODO proposed; deferred work is already captured in the plan and requires a fresh plan rather than a vague backlog item.
- Failure modes: 0 critical silent gaps flagged.
- Outside voice: skipped; no external plan-review model was requested.
- Parallelization: 3 implementation lanes; 2 parallel, 1 sequential.
- Lake Score: 20/20 recommendations chose the complete/recommended option.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | NOT RUN | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | NOT RUN | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 18 issues, 0 critical gaps; all decisions folded into the plan |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | NOT RUN | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | NOT RUN | — |

**VERDICT:** ENG CLEARED — core-first C3 plan is ready to implement; deferred adapters require their own review.

NO UNRESOLVED DECISIONS
