# C2 Pass 2 Harness and Pilot Calibration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build and calibrate an offline-by-default C2 evaluation harness that runs the three pilot cases under brief-only, current-grounded, and gold-evidence controls with immutable evidence, strict budgets, deterministic scoring, metadata-blinded human review, and a reviewed frozen calibration artifact.

**Architecture:** TypeScript modules under `src/c2/` own strict contracts, condition resolution, scoring, cost policy, immutable execution, and calibration. A thin `src/scripts/run-c2-pilot.ts` CLI coordinates offline preparation and explicitly authorized paid calls. The existing text-search capability (`CorpusReader.searchRanked`) and model routing are reused through narrow adapters; the image eval runner and v1 scorer remain separate regression authorities.

**Tech Stack:** TypeScript 5.9, Zod 4, Vitest 4, Node.js ESM, existing `CorpusReader`, existing tagger provider clients, canonical JSON/SHA-256 helpers.

## Global Constraints

- C0 and C1 must remain closed; C2 must remain open at the end of Pass 2.
- Default commands and tests must make zero network or paid provider calls.
- Live execution requires `--paid`, exact provider/model pins, reviewed configuration, current credentials, and current pricing.
- Maximum forecast and actual cost is **$0.50 per run** and **$5.00 per campaign**.
- OpenAI is the primary provider; Claude is the independent provider and runs all three pilot families.
- Reviewer-only labels, rubric anchors, adjudication notes, gold IDs, and expected decisions must never enter retrieval or provider prompts.
- Current-grounded retrieval must reuse `CorpusReader.searchRanked()` against a content-addressed production-corpus snapshot; no pilot-only corpus or new search engine.
- Pilot retrieval is pinned to `keyword-only`; it must not depend on `VOYAGE_API_KEY`, the vector index, Voyage embeddings, or Voyage reranking.
- Raw responses, parsed candidates, evidence content, and full condition inputs stay under `.c2-private/`, which is gitignored.
- Durable artifacts may contain hashes and permitted metadata only; never prompts, evidence content, raw outputs, API keys, authorization headers, private corpus paths, or private markers.
- Existing `callTextModel(): Promise<string>`, the v1 scorer, and the 12 v1 labels remain compatible.
- Pass 2 does not retag, mutate the corpus, close C2, or ship C3 product functionality.

---

## File Structure

| Path | Responsibility |
|---|---|
| `src/c2/candidate-contracts.ts` | Strict C2 candidate and deterministic-score schemas |
| `src/c2/condition-contracts.ts` | Evidence, condition-input, campaign, pricing, proposal, and frozen-calibration schemas |
| `src/c2/evaluation-contracts.ts` | Preserve V1 manifest contract; add V2 manifest and lifecycle assertions |
| `src/c2/scorer.ts` | Pure condition-aware C2 scorer |
| `src/c2/prompt-builder.ts` | Model-visible prompt construction without label access |
| `src/c2/cost-policy.ts` | Forecasting, actual-cost calculation, and budget decisions |
| `src/c2/condition-resolver.ts` | Standalone offline resolution of all three condition inputs |
| `src/c2/harness.ts` | Paid-call preflight and immutable single-run state machine |
| `src/c2/calibration.ts` | Comparison reducer, compatibility evaluator, and freeze validation |
| `src/c2/private-artifacts.ts` | Atomic private/durable writes and boundary scanning |
| `src/scripts/run-c2-pilot.ts` | Thin CLI with `prepare`, `run`, `propose`, `freeze`, and `validate` commands |
| `eval/c2/config/pilot-campaign.json` | Non-secret provider/model, sampling, budget, and run-matrix configuration |
| `eval/c2/config/pricing.json` | Versioned provider pricing with provenance and verification dates |
| `eval/c2/pilot/evidence/*.json` | Reviewed gold-evidence descriptors referencing exact brief/source fragments |
| `eval/c2/runs/<runId>/` | Durable metadata-only manifests and deterministic scores |
| `eval/c2/scorecards/` | Boundary-checked metadata-blinded human scorecards bound to candidate hashes |
| `eval/c2/calibration/` | Review-safe proposal and frozen calibration artifacts |
| `.c2-private/` | Gitignored prompts, resolved inputs, raw responses, candidates, and review packets |

---

## Shipping Strategy

The scope remains the complete approved Pass 2 design, but it ships through two sequential PRs:

1. **PR 1 — Offline harness (Slices A–C, Tasks 1–9):** contracts, native scoring, prompt isolation, pinned provider telemetry, cost policy, real text retrieval, immutable runner, metadata-blinded calibration machinery, offline preparation, and all no-egress/full-suite gates. Merge this PR before making paid pilot calls.
2. **PR 2 — Paid pilot and calibration freeze (Slice D, Task 10):** rebase from the merged PR 1, revalidate official model pricing, obtain explicit campaign authorization, execute immutable OpenAI/Claude runs, collect metadata-blinded human scorecards, approve numeric calibration, and commit only boundary-safe evidence.

PR 2 must not begin from an unmerged PR 1 branch. This prevents paid evidence from binding code that changes during code review, gives reviewers a code-only security and no-egress surface first, and keeps operational artifacts out of implementation churn. The split changes shipping order only; it does not defer or remove any Pass 2 requirement.

---

### Task 1: Candidate, condition, campaign, and manifest contracts

**Files:**
- Create: `src/c2/candidate-contracts.ts`
- Create: `src/c2/condition-contracts.ts`
- Create: `src/c2/candidate-contracts.test.ts`
- Create: `src/c2/condition-contracts.test.ts`
- Modify: `src/c2/evaluation-contracts.ts`
- Modify: `src/c2/evaluation-contracts.test.ts`
- Modify: `src/c2/index.ts`

**Interfaces:**
- Produces: `C2CandidateArtifactSchema`, `C2DeterministicScoreSchema`, `C2ConditionInputSchema`, `C2CampaignConfigSchema`, `C2PricingTableSchema`, `C2BlindScoreSubmissionSchema`, `C2CalibrationProposalSchema`, `C2FrozenCalibrationSchema`.
- Produces: `C2EvaluationRunManifestV1Schema`, compatibility alias `C2EvaluationRunManifestSchema`, and `C2EvaluationRunManifestV2Schema`.
- Consumes: `StableId`, `ArtifactFileRefSchema`, `C2ControlConditionSchema`, `Sha256`, and `GitSha`.

- [ ] **Step 1: Write failing contract tests**

Add focused fixtures proving strict parsing, unique IDs, exact screen/state/mobile shapes, non-empty accessibility/failure-recovery requirements, optional inspected URL metadata, evidence provenance, campaign limits, pricing provenance, and distinct V1/V2 manifests:

```ts
expect(C2CandidateArtifactSchema.safeParse(validCandidate()).success).toBe(true);
expect(C2CandidateArtifactSchema.safeParse({ ...validCandidate(), reviewerLabel: {} }).success).toBe(false);
expect(C2CandidateArtifactSchema.safeParse({ ...validCandidate(), screenBlueprints: [{ ...validCandidate().screenBlueprints[0], accessibility: [] }] }).success).toBe(false);
expect(C2CandidateArtifactSchema.safeParse({ ...validCandidate(), screenBlueprints: [{ ...validCandidate().screenBlueprints[0], failureAndRecovery: [] }] }).success).toBe(false);
expect(C2CandidateArtifactSchema.safeParse({ ...validCandidate(), screenBlueprints: [{ ...validCandidate().screenBlueprints[0], inspectedUrls: [] }] }).success).toBe(true);
expect(C2ConditionInputSchema.safeParse(briefOnlyWithEvidence()).success).toBe(false);
expect(C2CampaignConfigSchema.safeParse({ ...campaign(), maxRunCostUsd: 0.51 }).success).toBe(false);
expect(C2PricingTableSchema.safeParse(pricingWithoutSourceUrl()).success).toBe(false);
expect(C2EvaluationRunManifestV1Schema.safeParse(v1Run()).success).toBe(true);
expect(C2EvaluationRunManifestV2Schema.safeParse(v1Run()).success).toBe(false);
```

- [ ] **Step 2: Run the tests and confirm missing exports fail**

Run: `npx vitest run src/c2/candidate-contracts.test.ts src/c2/condition-contracts.test.ts src/c2/evaluation-contracts.test.ts`

Expected: FAIL because the new schemas and V2 manifest do not exist.

- [ ] **Step 3: Implement the candidate and score contracts**

Use strict nested schemas. The required public shape is:

```ts
const C2ScreenBlueprintSchema = z.object({
  id: StableId,
  summary: NonEmptyText,
  requiredStates: UniqueNonEmptyStrings,
  mobileRules: UniqueNonEmptyStrings,
  accessibility: UniqueNonEmptyStrings,
  failureAndRecovery: UniqueNonEmptyStrings,
  inspectedUrls: z.array(z.string().url()).default([]),
}).strict();

const C2CandidateDecisionSchema = z.object({
  id: StableId,
  lane: AuthorityLaneSchema,
  rationale: NonEmptyText,
  evidenceIds: z.array(StableId).refine(hasUniqueStrings, "evidence IDs must be unique"),
}).strict();

const C2CandidateCriterionSchema = z.object({ id: StableId, statement: NonEmptyText }).strict();

export const C2CandidateArtifactSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-candidate-design"),
  artifactId: StableId,
  caseId: StableId,
  globalDirection: z.object({ summary: NonEmptyText, principles: UniqueNonEmptyStrings }).strict(),
  screenBlueprints: z.array(C2ScreenBlueprintSchema).min(1),
  sourceDecisions: z.array(C2CandidateDecisionSchema).min(1),
  authorityLanes: z.object({
    retain: z.array(StableId),
    adapt: z.array(StableId),
    reject: z.array(StableId),
  }).strict(),
  acceptanceCriteria: z.array(C2CandidateCriterionSchema).min(1),
  assumptions: UniqueNonEmptyStrings,
  accessibilityAndRecovery: UniqueNonEmptyStrings,
  provenance: z.object({ conditionInputSha256: Sha256 }).strict(),
}).strict().superRefine((candidate, ctx) => {
  for (const [path, ids] of [
    ["screenBlueprints", candidate.screenBlueprints.map((item) => item.id)],
    ["sourceDecisions", candidate.sourceDecisions.map((item) => item.id)],
    ["acceptanceCriteria", candidate.acceptanceCriteria.map((item) => item.id)],
  ] as const) {
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: [path], message: `${path} IDs must be unique` });
  }
});

export const C2DeterministicScoreSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-deterministic-score"),
  artifactId: StableId,
  runId: StableId,
  runOutputSha256: Sha256,
  scorerSha256: Sha256,
  complete: z.boolean(),
  requiredSectionCoverage: z.number().min(0).max(1),
  requiredDecisionCoverage: z.number().min(0).max(1),
  acceptanceCriterionCoverage: z.number().min(0).max(1),
  missingScreenRequirements: z.array(NonEmptyText),
  unsupportedClaimCount: z.number().int().nonnegative(),
  forbiddenDisclosureCount: z.number().int().nonnegative(),
  unresolvedEvidenceCount: z.number().int().nonnegative(),
  provenanceMismatch: z.boolean(),
}).strict();
```

- [ ] **Step 4: Implement condition, pricing, campaign, and calibration contracts**

Define discriminated condition inputs so brief-only forbids evidence/corpus hashes, current-grounded requires corpus metadata plus the complete ranked result, and gold-evidence requires a bound packet:

```ts
const C2PinnedModelSchema = z.object({
  provider: z.enum(["openai", "claude"]),
  model: NonEmptyText,
  apiKeyEnv: NonEmptyText,
  maxOutputTokens: z.number().int().positive(),
  samplingParameters: z.record(StableId, z.union([z.string(), z.number().finite(), z.boolean()])),
}).strict();

export const C2EvidenceRecordSchema = z.object({
  id: StableId,
  authorityLane: AuthorityLaneSchema,
  sourceType: z.enum(["brief-fragment", "corpus-entry", "source-snapshot"]),
  sourceArtifactId: StableId,
  sourceSha256: Sha256,
  contentSha256: Sha256,
  rank: z.number().int().positive().nullable(),
  score: z.number().finite().nullable(),
}).strict();

export const C2CampaignConfigSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-campaign-config"),
  artifactId: StableId,
  primary: C2PinnedModelSchema,
  independent: C2PinnedModelSchema,
  maxRunCostUsd: z.literal(0.5),
  maxCampaignCostUsd: z.literal(5),
  maxAttempts: z.number().int().min(1).max(3),
  cases: UniqueNonEmptyStrings,
  conditions: z.tuple([z.literal("brief-only"), z.literal("current-grounded"), z.literal("gold-evidence")]),
  independentConditions: z.tuple([z.literal("current-grounded")]),
  plannedRunCount: z.literal(12),
  retrievalMode: z.literal("keyword-only"),
}).strict();
```

The frozen calibration schema must bind proposal, run, scorecard, pricing, campaign, and reviewer hashes and must reject any CLI-style override fields.

It also includes `frozenAt: z.string().datetime()` and requires the freeze command to pass one canonical timestamp into the reducer. A second freeze of the same proposal with the same authorization and timestamp must be byte-identical; a different timestamp intentionally produces a different artifact hash.

In `src/c2/evaluation-contracts.ts`, immediately before `C2HumanScorecardSchema`, add a reviewer-facing submission contract that reuses the existing six-dimension score schema and intentionally omits run and candidate identifiers:

```ts
export const C2BlindScoreSubmissionSchema = z.object({
  schemaVersion: z.literal("1.0"),
  artifactType: z.literal("c2-blind-score-submission"),
  reviewId: z.string().uuid(),
  reviewerActorId: StableId,
  reviewerActorKind: z.literal("human"),
  scores: z.array(DimensionScoreSchema).length(6).refine(
    (scores) => hasUniqueStrings(scores.map((score) => score.dimension)),
    "dimensions must be unique",
  ),
  submittedAt: z.string().datetime(),
}).strict();
```

The reviewer never receives or submits `runId`, `runOutputSha256`, provider, model, condition, campaign ordering, or a candidate-derived identifier. Those fields enter the canonical `C2HumanScorecard` only during the post-submission unblinding step.

- [ ] **Step 5: Version the run manifest accurately**

Rename the existing declaration without changing its object body or validation, then add the compatibility alias immediately after the completed schema expression:

```diff
-export const C2EvaluationRunManifestSchema = z.object({
+export const C2EvaluationRunManifestV1Schema = z.object({
```

After the existing schema's closing `superRefine`, add:

```ts
export const C2EvaluationRunManifestSchema = C2EvaluationRunManifestV1Schema;
```

Do not edit the existing V1 fields or refinements. Verify that constraint with the pre-existing tests plus an equality test comparing representative parse results through both V1 export names.

Add V2 with explicit `conditionInputRef`, `scorerRef`, `attemptCount`, `providerLatencyMs`, `terminalReason`, `validationErrors`, and `sourceSnapshotIds`. Require detailed terminal reason/status consistency and zero execution fields for `cost-blocked`.

- [ ] **Step 6: Run focused tests**

Run: `npx vitest run src/c2/candidate-contracts.test.ts src/c2/condition-contracts.test.ts src/c2/evaluation-contracts.test.ts`

Expected: PASS.

- [ ] **Step 7: Keep the C2 barrel collision-free**

`candidate-contracts.ts` and `condition-contracts.ts` must import `StableId`, `NonEmptyText`, `UniqueNonEmptyStrings`, `AuthorityLaneSchema`, `ArtifactFileRefSchema`, `Sha256`, and `GitSha` from their defining modules; they must not re-export those primitives. `src/c2/index.ts` may re-export each new public schema/type exactly once. Add a compile test that imports `src/c2/index.ts` and fails on duplicate export names.

- [ ] **Step 8: Commit**

```bash
git add src/c2/candidate-contracts.ts src/c2/candidate-contracts.test.ts src/c2/condition-contracts.ts src/c2/condition-contracts.test.ts src/c2/evaluation-contracts.ts src/c2/evaluation-contracts.test.ts src/c2/index.ts
git commit -m "feat(c2): define Pass 2 evaluation contracts"
```

---

### Task 2: C2-native scorer and v1 golden regression

**Files:**
- Create: `src/c2/scorer.ts`
- Create: `src/c2/scorer.test.ts`
- Create: `scripts/design-handoff-v1-regression.test.mjs`
- Create: `eval/design-handoff-v1-candidates.json`
- Create: `eval/design-handoff-v1-score-baseline.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: `C2CandidateArtifact`, `C2CaseBrief`, `C2DecisionLabel`, and `C2ConditionInput`.
- Produces: `scoreC2Candidate(input): C2DeterministicScore`.
- `ScoreC2CandidateInput` also carries `artifactId`, `runId`, `runOutputSha256`, and `scorerSha256` so the returned score is fully bound.

The scorer boundary accepts unknown candidate JSON, parses it through `C2CandidateArtifactSchema`, and refuses to score a parse failure. Thus the schema's non-empty accessibility and failure-recovery requirements are part of the deterministic gate even though the scorer does not semantically judge prose quality. `inspectedUrls` defaults to an empty array because C2 labels do not yet carry the inaccessible-URL/source-access outcome contract required to score it.

- [ ] **Step 1: Write adversarial scorer tests**

Cover every closure rule with one mutation from a complete fixture:

```ts
expect(scoreC2Candidate(completeInput()).complete).toBe(true);
expect(scoreC2Candidate(mutate("missing-required-state")).complete).toBe(false);
expect(scoreC2Candidate(mutate("missing-mobile-rule")).complete).toBe(false);
expect(scoreC2Candidate(mutate("missing-decision-id")).requiredDecisionCoverage).toBeLessThan(1);
expect(scoreC2Candidate(mutate("ghost-evidence")).unresolvedEvidenceCount).toBe(1);
expect(scoreC2Candidate(mutate("wrong-lane")).unsupportedClaimCount).toBe(1);
expect(scoreC2Candidate(mutate("nested-private-marker")).forbiddenDisclosureCount).toBe(1);
expect(scoreC2Candidate(mutate("wrong-input-hash")).provenanceMismatch).toBe(true);
```

Also prove brief-only accepts brief-grounded decisions without corpus citations while grounded conditions accept only supplied evidence IDs.

Add the direct boundary regression: passing a candidate with an empty `accessibility` or `failureAndRecovery` array throws before a score is returned; passing an empty `inspectedUrls` array succeeds and normalizes it to `[]`.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/c2/scorer.test.ts`

Expected: FAIL because `scoreC2Candidate` does not exist.

- [ ] **Step 3: Implement the pure scorer**

Use exact-set membership and explicit counters. Required screens, states, and mobile rules come from the brief; decision/criterion requirements and forbidden material come from the label; valid citations come exclusively from the condition input.

```ts
export function scoreC2Candidate(input: ScoreC2CandidateInput): C2DeterministicScore {
  const { artifactId, runId, runOutputSha256, scorerSha256, candidate, brief, label, conditionInput } = input;
  const suppliedEvidence = new Set(conditionInput.evidence.map((item) => item.id));
  const requiredDecisions = new Set(label.requiredDecisionIds);
  const requiredCriteria = new Set(label.requiredAcceptanceCriteria);
  const requiredSectionCoverage = label.requiredSections.filter((name) => sectionPresent(candidate, name)).length / label.requiredSections.length;
  const decisionCoverage = [...requiredDecisions].filter((id) => candidate.sourceDecisions.some((item) => item.id === id)).length / requiredDecisions.size;
  const criterionCoverage = [...requiredCriteria].filter((id) => candidate.acceptanceCriteria.some((item) => item.id === id)).length / requiredCriteria.size;
  const missingScreenRequirements = findMissingScreenRequirements(candidate.screenBlueprints, brief.requiredScreens);
  const unresolvedEvidenceCount = candidate.sourceDecisions.flatMap((item) => item.evidenceIds).filter((id) => !suppliedEvidence.has(id)).length;
  const unsupportedClaimCount = countUnsupportedClaims(candidate.sourceDecisions, label.permittedAuthorityLanes);
  const forbiddenDisclosureCount = countForbiddenText(candidate, [...label.forbiddenClaims, ...label.privateMarkers]);
  const provenanceMismatch = candidate.provenance.conditionInputSha256 !== conditionInput.inputSha256;
  const complete = requiredSectionCoverage === 1 && decisionCoverage === 1 && criterionCoverage === 1 && missingScreenRequirements.length === 0 && unsupportedClaimCount === 0 && forbiddenDisclosureCount === 0 && unresolvedEvidenceCount === 0 && !provenanceMismatch;
  return C2DeterministicScoreSchema.parse({ schemaVersion: "1.0", artifactType: "c2-deterministic-score", artifactId, runId, runOutputSha256, scorerSha256, requiredSectionCoverage, requiredDecisionCoverage: decisionCoverage, acceptanceCriterionCoverage: criterionCoverage, missingScreenRequirements, unsupportedClaimCount, forbiddenDisclosureCount, unresolvedEvidenceCount, provenanceMismatch, complete });
}
```

Define the four local helpers with these exact signatures: `sectionPresent(candidate, section): boolean`, `findMissingScreenRequirements(blueprints, requirements): string[]`, `countUnsupportedClaims(decisions, permittedLanes): number`, and `countForbiddenText(candidate, markers): number`. `countForbiddenText` serializes canonical JSON and counts each configured marker once; the other helpers use exact ID/string membership and never fuzzy matching.

Do not import or call `scripts/design-handoff-scorer.mjs` from this module.

- [ ] **Step 4: Add the 12-label v1 regression matrix**

Load `eval/design-handoff-labels.json` and author `eval/design-handoff-v1-candidates.json` as deterministic synthetic candidates. Each candidate must contain the v1 scorer's actual required shape: `screenBlueprints` with `requiredStates` and `mobileRules`, `sourceDecisions` with valid lanes/rationales/evidence, `sourceObservations`, `authorityLanes`, acceptance criteria, and every required top-level section. Construct one satisfiable candidate and the same fixed failure mutations for every label. Write the complete expected score matrix to `eval/design-handoff-v1-score-baseline.json`; the test compares canonical JSON and reports the first case/mutation difference.

Run: `npx vitest run scripts/design-handoff-v1-regression.test.mjs scripts/design-handoff-scorer.test.mjs`

Expected: PASS for all 12 labels and existing scorer tests.

- [ ] **Step 5: Add the focused npm command and rerun**

Add: `"test:c2-scoring": "vitest run src/c2/scorer.test.ts scripts/design-handoff-v1-regression.test.mjs scripts/design-handoff-scorer.test.mjs"`.

Run: `npm run test:c2-scoring`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/c2/scorer.ts src/c2/scorer.test.ts scripts/design-handoff-v1-regression.test.mjs eval/design-handoff-v1-score-baseline.json package.json
git commit -m "feat(c2): add native scoring and v1 regression gate"
```

---

### Task 3: Prompt boundary and gold-evidence descriptors

**Files:**
- Create: `src/c2/prompt-builder.ts`
- Create: `src/c2/prompt-builder.test.ts`
- Create: `eval/c2/pilot/evidence/named-inspiration-safety.json`
- Create: `eval/c2/pilot/evidence/public-marketing-migration.json`
- Create: `eval/c2/pilot/evidence/stablecoin-home.json`
- Modify: `scripts/build-c2-pilot-manifest.mjs`
- Modify: `scripts/build-c2-pilot-manifest.test.mjs`

**Interfaces:**
- Consumes: a parsed `C2CaseBrief` plus a resolved condition-input payload containing evidence content.
- Produces: `buildC2Prompt({ brief, conditionInput }): { prompt: string; promptSha256: string }`.
- The function signature intentionally has no label parameter.

- [ ] **Step 1: Write prompt-leakage tests**

Use unique sentinels for every reviewer-only field and assert none appears in the serialized prompt. Assert evidence order is stable and changing evidence bytes changes `promptSha256`.

```ts
expect(prompt).not.toContain("RUBRIC_SENTINEL");
expect(prompt).not.toContain("ADJUDICATION_SENTINEL");
expect(prompt).not.toContain("GOLD_ID_SENTINEL");
expect(buildC2Prompt(input).promptSha256).toBe(buildC2Prompt(input).promptSha256);
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/c2/prompt-builder.test.ts`

Expected: FAIL because the builder does not exist.

- [ ] **Step 3: Implement canonical prompt construction**

The prompt contains a fixed system instruction, canonical model-visible brief JSON, ordered evidence blocks, and the candidate JSON schema summary. It tells the model to return one JSON object and forbids claims beyond the brief/evidence. Hash exact UTF-8 prompt bytes with `sha256Hex`.

- [ ] **Step 4: Author resolvable gold-evidence descriptors**

Each descriptor maps every label `goldEvidenceId` to exact source JSON pointers and source hashes rather than duplicating prose:

```json
{
  "schemaVersion": "1.0",
  "artifactType": "c2-gold-evidence-descriptor",
  "artifactId": "c2-gold-evidence-stablecoin-home-v1",
  "caseId": "stablecoin-home",
  "records": [{
    "id": "evidence:brief:audience-hierarchy",
    "sourceArtifactId": "c2-brief-stablecoin-home-v1",
    "jsonPointers": ["/users", "/constraints/1"]
  }]
}
```

Include every gold ID exactly once. The manifest builder resolves pointers, hashes the resulting bytes, rejects unknown pointers/IDs, and binds descriptor hashes without copying reviewer fields into the brief.

- [ ] **Step 5: Verify pilot integrity**

Run: `npm run generate:c2-pilot && npm run validate:c2-pilot && npx vitest run scripts/build-c2-pilot-manifest.test.mjs src/c2/pilot-fixtures.test.ts`

Expected: PASS; two manifest generations are byte-identical.

- [ ] **Step 6: Commit**

```bash
git add src/c2/prompt-builder.ts src/c2/prompt-builder.test.ts eval/c2/pilot/evidence scripts/build-c2-pilot-manifest.mjs scripts/build-c2-pilot-manifest.test.mjs eval/c2/pilot/manifest.json
git commit -m "feat(c2): bind condition-safe pilot prompts and gold evidence"
```

---

### Task 4: Additive provider telemetry without breaking existing callers

**Files:**
- Modify: `src/tagger.ts`
- Modify: `src/tagger.test.ts`
- Create: `src/c2/model-telemetry.test.ts`

**Interfaces:**
- Produces: `callTextModelWithMetadata(request: TextModelRequest): Promise<ModelCallResult>`.
- Preserves: `callTextModel(prompt, providerOverride?, retryFeedback?, endpointOverride?): Promise<string>`.

- [ ] **Step 1: Write compatibility and telemetry tests**

Mock OpenAI Responses and Claude Messages responses with exact usage blocks. Assert resolved identity, normalized usage, attempts, latency, and that the legacy wrapper returns only content.

```ts
expect(await callTextModel("hello", "openai")).toBe("candidate-json");
expect(result).toMatchObject({
  content: "candidate-json",
  provider: "openai",
  model: "gpt-pinned",
  usage: { promptTokens: 120, completionTokens: 80 },
  attempts: 1,
});
```

Add negative tests for missing usage, model mismatch, missing key, and attempted fallback.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/c2/model-telemetry.test.ts src/tagger.test.ts`

Expected: FAIL only on the missing telemetry API tests.

- [ ] **Step 3: Introduce internal metadata results**

Add:

```ts
export interface TextModelRequest {
  prompt: string;
  endpoint: EndpointOverride & { model: string };
  maxOutputTokens: number;
  maxAttempts: number;
}

export interface ModelCallResult {
  content: string;
  provider: Provider;
  model: string;
  usage: { promptTokens: number; completionTokens: number; raw: Record<string, number> };
  attempts: number;
  latencyMs: number;
  providerRequestId: string | null;
}
```

Refactor provider response parsing so internal clients can return metadata while existing image/tagger call paths continue consuming `.content`. Do not change public tagger outputs.

- [ ] **Step 4: Enforce exact C2 pinning**

`callTextModelWithMetadata` must require an explicit endpoint and model, bypass ambient routing, reject a response that identifies a different model when the provider exposes identity, and never call another provider when credentials or quota fail.

- [ ] **Step 5: Run focused and existing tagger tests**

Run: `npx vitest run src/c2/model-telemetry.test.ts src/tagger.test.ts src/critique-synthesis.test.ts`

Expected: PASS; existing string-returning consumers remain unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/tagger.ts src/tagger.test.ts src/c2/model-telemetry.test.ts
git commit -m "feat(c2): expose pinned text-model telemetry"
```

---

### Task 5: Pricing and cost policy

**Files:**
- Create: `src/c2/cost-policy.ts`
- Create: `src/c2/cost-policy.test.ts`
- Create: `eval/c2/config/pilot-campaign.json`
- Create: `eval/c2/config/pricing.json`

**Interfaces:**
- Produces: `forecastRunCost`, `calculateActualCost`, `assertRunBudget`, and `assertCampaignBudget`.
- Consumes: parsed campaign, pricing, prompt token estimate, maximum output tokens, and actual provider usage.

- [ ] **Step 1: Write boundary tests**

Use integer token quantities and decimal USD results. Test exactly-at-limit, one-unit-over, missing model, duplicate price, non-finite price, missing source URL, and a `verifiedAt` older than 30 days.

```ts
expect(assertRunBudget({ forecastUsd: 0.5, ceilingUsd: 0.5 }).allowed).toBe(true);
expect(assertRunBudget({ forecastUsd: 0.500001, ceilingUsd: 0.5 }).allowed).toBe(false);
expect(assertCampaignBudget({ spentUsd: 4.8, forecastUsd: 0.21, ceilingUsd: 5 }).allowed).toBe(false);
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/c2/cost-policy.test.ts`

Expected: FAIL because the policy does not exist.

- [ ] **Step 3: Implement pure cost decisions**

Normalize provider prices to USD per million tokens and round persisted cost to six decimal places only after calculation. Return structured denial reasons rather than booleans alone.

Compute the effective campaign reserve as `$5 / 12 = $0.4166666667` per planned run. Preflight must calculate a full-prompt/full-`maxOutputTokens` forecast for both `gpt-5.4-mini` and `claude-sonnet-4-5` using their configured sampling parameters and reject a campaign if either exceeds the effective reserve. The nominal per-run ceiling remains `$0.50` for actual accounting, but reserving `$0.4166666667` prevents an early expensive run from making the remaining 12-run campaign impossible to complete.

Add tests for both model configs: a forecast at `$0.4166666667` is allowed, a forecast one cent above it is rejected with `campaign-reserve-exceeded`, and a campaign with fewer planned runs derives its reserve from its exact `plannedRunCount` rather than assuming 12.

- [ ] **Step 4: Add reviewed non-secret configuration**

`pilot-campaign.json` pins `gpt-5.4-mini` for the OpenAI primary lane and `claude-sonnet-4-5` for the Claude independent lane, matching the repository's current evaluated/configured model families. It also pins sampling parameters, maximum output tokens, three cases, all three conditions for OpenAI, current-grounded for all three Claude family cases, and the two fixed ceilings. It stores `apiKeyEnv`, never a key. Before paid execution, preflight must verify both IDs are still returned/accepted by their official provider APIs; a retired model requires a reviewed campaign-config revision, not silent substitution.

`pricing.json` records authoritative provider pricing URLs and `verifiedAt`. Verify current prices from official provider sources immediately before the eventual paid campaign; do not guess or copy values from this plan.

- [ ] **Step 5: Run focused tests**

Run: `npx vitest run src/c2/cost-policy.test.ts src/c2/condition-contracts.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/c2/cost-policy.ts src/c2/cost-policy.test.ts eval/c2/config
git commit -m "feat(c2): enforce campaign pricing and cost ceilings"
```

---

### Task 6: Offline condition resolver using the real text-search path

**Files:**
- Create: `src/c2/condition-resolver.ts`
- Create: `src/c2/condition-resolver.test.ts`
- Create: `src/c2/private-artifacts.ts`
- Create: `src/c2/private-artifacts.test.ts`
- Modify: `src/corpus.ts`
- Modify: `src/corpus.test.ts`
- Modify: `.gitignore`

**Interfaces:**
- Produces: `resolveConditionInput(request, deps): Promise<ResolvedConditionInput>`.
- `deps.reader` is a `CorpusReader`; `deps.readArtifact`, `deps.writePrivate`, and `deps.now` are injected.
- The returned value separates a metadata-safe `C2ConditionInput` from private `evidencePayloads`.

- [ ] **Step 1: Write condition and boundary tests**

Use an injected fake reader with stable ranked results. Assert:

```ts
expect(reader.searchRanked).toHaveBeenCalledWith({ query: expectedBriefQuery, limit: 10, reviewStatus: "approved", rerank: false, searchMode: "keyword-only" });
expect(current.metadata.evidence.map(e => e.id)).toEqual(["corpus:entry-a", "corpus:entry-b"]);
expect(current.privatePayload).not.toContain("RUBRIC_SENTINEL");
expect(briefOnly.metadata.evidence).toEqual([]);
expect(gold.metadata.evidence.map(e => e.id)).toEqual(label.goldEvidenceIds);
```

Mutating a corpus entry, ranking order, source snapshot, or descriptor pointer must change `inputSha256`. Gold-label mutations must not change a current-grounded query or ranking.

Add a production search regression with `VOYAGE_API_KEY` set and an index present: `searchMode: "keyword-only"` must make no Voyage request and must never return a result whose `searchMode` is `"hybrid"`. Existing callers that omit the option must retain today's environment-sensitive `"auto"` behavior.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/c2/condition-resolver.test.ts src/c2/private-artifacts.test.ts`

Expected: FAIL because the resolver and writer do not exist.

- [ ] **Step 3: Make the shipped search dispatch explicit and add a keyword-only mode**

This is a compatibility-sensitive change to the shipped `SearchOptions` contract and `searchRanked` dispatch used by `critique-retrieval.ts`, not an extension of an existing named `"auto"` mode. Today, omitting a mode implicitly means “use hybrid when the query, index, and `VOYAGE_API_KEY` are present; otherwise use keyword.” The new `"auto"` name formalizes that implicit behavior; it must not alter it.

Extend `SearchOptions` in `src/corpus.ts`:

```ts
searchMode?: "auto" | "keyword-only";
```

At the start of the ranking branch, derive `const keywordOnly = opts.searchMode === "keyword-only"`. Require `!keywordOnly` in both the existing hybrid-vector predicate and the optional Voyage-rerank predicate. Keep an omitted option equivalent to the pre-change implicit dispatch, preserving existing callers.

Add an integration regression that exercises the existing `critique-retrieval.ts` call path with no `searchMode` field: with a Voyage key and index it remains hybrid, and without them it remains keyword-only. The same test then passes `searchMode: "keyword-only"` under both environments and proves the result is keyword-only in both cases. This guards the shipped behavior while making C2's pin explicit.

- [ ] **Step 4: Implement deterministic query and evidence mapping**

Derive the search query from ordered brief fields only: title, product context, users, jobs, platform, journeys, constraints, and required-screen IDs. Before querying, copy the exact `corpus/entries.json` bytes into the private campaign directory and record their SHA-256. Call `reader.searchRanked({ query, limit: 10, reviewStatus: "approved", rerank: false, searchMode: "keyword-only" })`. Re-hash `corpus/entries.json` after ranking and abort if it changed during resolution. Convert results to `corpus:<entry-id>` evidence records with canonical content hashes and preserve the full ranking and private corpus-snapshot path privately. The durable condition metadata records the corpus hash, entry count, and literal retrieval mode `keyword-only`.

- [ ] **Step 5: Implement brief-only and gold resolution**

Brief-only produces no evidence. Gold resolution verifies the descriptor hash, resolves every JSON pointer against the bound source artifact, requires exact equality with `label.goldEvidenceIds`, and rejects duplicate or unresolvable pointers before any run can begin.

- [ ] **Step 6: Implement atomic private and durable writes**

Write through the opened file descriptor, `fsync`, close, and atomically rename. Wrap the entire lifecycle in cleanup. Add a boundary scanner that rejects durable JSON containing configured secret values, prompt/evidence/raw fields, `.c2-private` paths, corpus private paths, or case private markers.

Add `.c2-private/` to `.gitignore` and test `git check-ignore .c2-private/probe` succeeds.

- [ ] **Step 7: Run focused tests and public boundary**

Run: `npx vitest run src/c2/condition-resolver.test.ts src/c2/private-artifacts.test.ts src/corpus.test.ts && npm run check-public-site-boundary`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/c2/condition-resolver.ts src/c2/condition-resolver.test.ts src/c2/private-artifacts.ts src/c2/private-artifacts.test.ts src/corpus.ts src/corpus.test.ts .gitignore
git commit -m "feat(c2): resolve immutable pilot condition inputs"
```

---

### Task 7: Immutable harness and offline-by-default CLI

**Files:**
- Create: `src/c2/harness.ts`
- Create: `src/c2/harness.test.ts`
- Create: `src/scripts/run-c2-pilot.ts`
- Create: `src/scripts/run-c2-pilot.test.ts`
- Modify: `package.json`

**Interfaces:**
- Produces: `executeC2Run(request, deps): Promise<C2EvaluationRunManifestV2>`.
- Consumes: an already resolved condition input, pinned model request, pricing/campaign state, scorer, and private artifact store.
- CLI subcommands: `prepare`, `run`, `propose`, `freeze`, `validate`.

- [ ] **Step 1: Write the run-state matrix tests**

Test success, provider failure, parse failure, validation failure, cost-blocked, run-budget-exceeded, campaign-stopped, atomic-write failure, and predecessor behavior. Assert actual cost persists after any paid response.

```ts
expect(model).not.toHaveBeenCalled(); // forecast blocked
expect(blocked).toMatchObject({ status: "cost-blocked", attemptCount: 0, costUsd: 0 });
expect(parseFailed).toMatchObject({ status: "failed", terminalReason: "parse-failed", costUsd: 0.0012 });
expect(actualOverage).toMatchObject({ status: "failed", terminalReason: "run-budget-exceeded", costUsd: 0.6 });
expect(campaignAfterOverage).toMatchObject({ stopped: true, stopReason: "run-budget-exceeded" });
expect(model).toHaveBeenCalledTimes(1); // the next scheduled run never reaches the provider
expect(second.predecessorRunId).toBe(first.runId);
```

Construct `actualOverage` with a fake model response that succeeds and reports token usage priced to exactly `$0.60`, despite a preflight forecast below `$0.50`. Assert the raw-output hash and actual usage remain recorded for audit, parsing is skipped and `parsedOutputSha256` stays null, the terminal manifest is not `succeeded`, the campaign stops immediately, and executing the next queued request performs no provider call. This test is fully offline; it uses the injected model and pricing table.

- [ ] **Step 2: Write CLI no-egress tests**

Spawn the compiled CLI with no args, `prepare`, `run` without `--paid`, missing config, stale pricing, and missing credentials. Inject or proxy a model sentinel and assert zero requests.

- [ ] **Step 3: Run and confirm failure**

Run: `npx vitest run src/c2/harness.test.ts src/scripts/run-c2-pilot.test.ts`

Expected: FAIL because the runner does not exist.

- [ ] **Step 4: Implement the immutable run engine**

Apply the exact lifecycle from the design. Write the running manifest before egress, finalize it once, reject an existing terminal run directory, and assign a new ID for every retry. Parse one JSON object from the raw response; do not repair or make a second model call.

- [ ] **Step 5: Implement the thin CLI**

Commands:

```text
npm run c2:pilot -- prepare --config eval/c2/config/pilot-campaign.json
npm run c2:pilot -- run --config eval/c2/config/pilot-campaign.json --paid
npm run c2:pilot -- propose --runs eval/c2/runs
npm run c2:pilot -- freeze --proposal eval/c2/calibration/proposal.json --authorization <review-file>
npm run c2:pilot -- validate --calibration eval/c2/calibration/frozen.json
```

`run` is the only network-capable command and refuses to start without every preflight condition. `freeze` requires a separate authorization artifact whose proposal hash matches exactly.

- [ ] **Step 6: Add npm command and run tests**

Add: `"c2:pilot": "tsc && node dist/scripts/run-c2-pilot.js"`.

Run: `npx vitest run src/c2/harness.test.ts src/scripts/run-c2-pilot.test.ts && npm run build`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/c2/harness.ts src/c2/harness.test.ts src/scripts/run-c2-pilot.ts src/scripts/run-c2-pilot.test.ts package.json
git commit -m "feat(c2): add immutable offline-first pilot harness"
```

---

### Task 8: Calibration reducer, metadata-blinded packets, and explicit freeze

**Files:**
- Create: `src/c2/calibration.ts`
- Create: `src/c2/calibration.test.ts`
- Create: `src/c2/review-packets.ts`
- Create: `src/c2/review-packets.test.ts`
- Modify: `src/scripts/run-c2-pilot.ts`

**Interfaces:**
- Produces: `createBlindAssignment`, `buildBlindedReviewPacket`, `finalizeBlindScorecard`, `buildCalibrationProposal`, `evaluateIndependentCompatibility`, and `freezeCalibration`.
- Consumes: immutable run manifests, private candidates, deterministic scores, human scorecards, campaign/pricing hashes, and authorization.

- [ ] **Step 1: Write blinding and comparison tests**

Assert review packets omit provider, model, condition, run ID, output hash, run ordering, prompt, evidence source labels, and private paths. The packet carries only a cryptographically random UUID `reviewId` and the candidate content required for scoring. Test mean deltas, per-dimension regressions, readiness transitions, safety non-inferiority, gold headroom, and compatible/incompatible critical decisions.

Test that two assignments of the same candidate produce different UUIDs; UUIDs do not contain a candidate-hash prefix; a submission cannot include run/hash/condition fields; and finalization refuses an unknown, reused, or already-finalized review ID.

- [ ] **Step 2: Write freeze-negative tests**

Reject missing scorecards, changed candidate hashes, missing family/provider coverage, a proposal with fewer than all required primary runs, a Claude set missing any pilot family, threshold overrides, proposal-hash mismatch, and absent human authorization.

- [ ] **Step 3: Run and confirm failure**

Run: `npx vitest run src/c2/calibration.test.ts src/c2/review-packets.test.ts`

Expected: FAIL because the reducers do not exist.

- [ ] **Step 4: Implement random assignments and metadata-blinded packets**

Generate every `reviewId` with `crypto.randomUUID()` after the complete review batch exists, then shuffle packet order with `crypto.randomInt()` using rejection sampling. Store the only reversible map under `.c2-private/c2/blind-map.json` as `{ reviewId, runId, runOutputSha256, assignedReviewerActorId, state: "assigned" | "finalized" }`. The map never appears in durable artifacts, logs, packet filenames beyond the UUID itself, or reviewer-visible output.

`buildBlindedReviewPacket` receives a private assignment and candidate content and returns `{ reviewId, candidate }` only. `finalizeBlindScorecard` accepts a strict `C2BlindScoreSubmission`, resolves the private map after submission, verifies the assigned reviewer, atomically changes the map entry from `assigned` to `finalized`, and creates the canonical `C2HumanScorecard` with `blindedCondition: true`, `runId`, and `runOutputSha256`. Reuse or double-finalization fails closed.

The guarantee is procedural and system-enforced: a reviewer using only issued packets and the submission interface cannot correlate conditions from identifiers or metadata before submitting. It does not claim to erase clues inherent in the candidate prose, or protection if the reviewer independently opens `.c2-private/`, durable run manifests, or operator logs; the campaign instructions must keep those unavailable during review. The public-safe proposal contains aggregates and hashes, not candidate prose or the reversible map.

- [ ] **Step 5: Implement pure proposal reduction**

Reduce only finalized canonical scorecards. Reject blind submissions that have not passed `finalizeBlindScorecard`, and reject any scorecard whose run/output binding differs from the private assignment or immutable manifest.

- [ ] **Step 6: Implement explicit freeze validation**

`freezeCalibration` copies no thresholds automatically. It validates that the authorization selects a positive material-benefit minimum, a finite regression tolerance, the fixed six rubric dimensions, the independent checklist, and the exact $0.50/$5 budgets, then binds the proposal and all evidence hashes.

- [ ] **Step 7: Run focused tests**

Run: `npx vitest run src/c2/calibration.test.ts src/c2/review-packets.test.ts src/c2/evaluation-contracts.test.ts`

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/c2/calibration.ts src/c2/calibration.test.ts src/c2/review-packets.ts src/c2/review-packets.test.ts src/scripts/run-c2-pilot.ts
git commit -m "feat(c2): add blinded calibration and freeze gate"
```

---

### Task 9: Offline preparation and implementation verification

**Files:**
- Modify: `docs/AGENT_READINESS_STATUS.md`
- Create: `.zcode/reviews/tasks/<task-head-sha>.json` through the sanctioned writer after each reviewed task

**Interfaces:**
- Consumes: the complete Tasks 1–8 implementation.
- Produces: prepared private condition inputs, a synthetic end-to-end calibration proof, durable metadata manifests, and an implementation-ready status record. No paid calls occur in this task.

**Additional test file:** `src/c2/calibration.e2e.test.ts`

- [ ] **Step 1: Build and prepare all condition inputs offline**

Run:

```bash
npm run build
npm run c2:pilot -- prepare --config eval/c2/config/pilot-campaign.json
```

Expected: nine primary condition inputs plus the configured three Claude inputs are resolved; zero provider calls; every artifact hash validates.

- [ ] **Step 2: Inspect the preparation boundary report**

Confirm current-grounded records identify production corpus entries as `corpus:<entry-id>`, complete rankings remain private, gold records resolve every label gold ID, and no reviewer-only sentinel appears in prompts or retrieval queries.

- [ ] **Step 3: Exercise the complete calibration flow offline**

Add `src/c2/calibration.e2e.test.ts` with deterministic fake run manifests, fake candidate outputs, fake human score submissions, a fake campaign/pricing configuration, and an injected private blind-map store. Execute the real functions in order:

```ts
const assignments = createBlindAssignment(fakeRuns, fakeCandidates, deps);
const packets = assignments.map((assignment) => buildBlindedReviewPacket(assignment, deps));
const canonicalScorecards = packets.map((packet) => finalizeBlindScorecard(
  makeValidSubmission(packet.reviewId), deps,
));
const proposal = buildCalibrationProposal({ runs: fakeRuns, scorecards: canonicalScorecards, ...fakeCalibrationInputs });
const compatibility = evaluateIndependentCompatibility(fakeRuns, canonicalScorecards, fakeChecklist);
const frozen = freezeCalibration({ proposal, compatibility, authorization: makeMatchingAuthorization(proposal), ...fakeCalibrationInputs });
expect(frozen.proposalSha256).toBe(sha256Hex(Buffer.from(canonicalJsonStringify(proposal), "utf8")));
expect(frozen.compatibility.passed).toBe(true);
```

The test must also prove an unknown/reused `reviewId`, a proposal-hash mismatch, and a changed scorecard output hash fail before freeze. It must make zero network calls and write only under the injected temporary private store.

Run: `npx vitest run src/c2/calibration.e2e.test.ts`

Expected: PASS before any paid campaign is authorized.

- [ ] **Step 4: Run focused and full gates**

```bash
npm run test:c2-scoring
npx vitest run src/c2 scripts/build-c2-pilot-manifest.test.mjs
npm test
npm run typecheck:contracts
npm run build
npm run check-public-site-boundary
npm run validate:c2-pilot
npm run validate-readiness-artifacts -- --mode public
```

Expected: all commands pass; readiness reports C0 closed, C1 closed, C2 open.

- [ ] **Step 5: Verify scope containment**

```bash
git diff --exit-code origin/main -- quality-contracts/agent-readiness corpus/entries.json src/readiness
git status --short
```

Expected: no readiness-governance or corpus mutation; `.c2-private/` does not appear as untracked; only intended Pass 2 files differ.

- [ ] **Step 6: Update readiness status**

Document that the harness implementation and offline preparation are complete, paid pilot calibration remains an explicit operational gate, C2 remains open, and no retagging is authorized.

- [ ] **Step 7: Commit**

```bash
git add docs/AGENT_READINESS_STATUS.md
git commit -m "docs(c2): record Pass 2 harness readiness"
```

- [ ] **Step 8: Open and merge PR 1 before paid work**

Run the repository's holistic review against `origin/main`, resolve every P0/P1 issue, push the offline-harness branch, and open PR 1 with Tasks 1–9 only. Merge it after approval. Record the merge SHA; Task 10's branch must start from that exact post-merge `origin/main` state.

---

### Task 10: Authorized paid pilot and calibration freeze

**Files:**
- Generate: `eval/c2/runs/<runId>/manifest.json`
- Generate: `eval/c2/runs/<runId>/score.json`
- Generate: `eval/c2/scorecards/<reviewId>.json`
- Generate: `eval/c2/calibration/proposal.json`
- Generate after approval: `eval/c2/calibration/frozen.json`
- Keep private: `.c2-private/c2/**`
- Modify: `docs/AGENT_READINESS_STATUS.md`

**Interfaces:**
- Consumes: the merged PR 1 implementation, freshly verified official pricing, valid OpenAI/Claude credentials, human scorecards, and explicit freeze authorization.
- Produces: immutable pilot evidence and frozen calibration for Pass 3.

- [ ] **Step 0: Create the Slice D branch from merged PR 1**

```bash
git fetch origin
git switch -c codex/c2-pass2-calibration origin/main
```

Verify `origin/main` contains PR 1's merge SHA before continuing. Do not cherry-pick or run the campaign from the pre-merge implementation branch.

- [ ] **Step 1: Re-verify official prices and update only the pricing artifact**

Use official OpenAI and Anthropic pricing pages on the campaign date. Record exact URLs and `verifiedAt`. Review the diff before any paid command.

- [ ] **Step 2: Dry-run preflight**

Run: `npm run c2:pilot -- run --config eval/c2/config/pilot-campaign.json`

Expected: exits non-zero explaining that `--paid` is required; zero provider calls and zero cost.

- [ ] **Step 3: Obtain explicit campaign authorization**

The authorization must bind the campaign-config and pricing hashes and approve ceilings of $0.50/run and $5/campaign. Stop if either hash changes afterward.

- [ ] **Step 4: Execute the paid pilot**

Run: `npm run c2:pilot -- run --config eval/c2/config/pilot-campaign.json --paid`

Expected: all configured OpenAI runs and all three Claude family runs terminate immutably; the campaign never exceeds either ceiling. Any block or failure remains evidence and is rerun only with a new run ID after review.

- [ ] **Step 5: Generate metadata-blinded packets and collect human score submissions**

Reviewers score all six dimensions through `C2BlindScoreSubmission` without run, hash, condition, or provider metadata. After submission, run the trusted finalizer to resolve the private assignment and create the canonical scorecard; reviewers cannot edit a finalized submission. Persist the canonical scorecard under `eval/c2/scorecards/` only after the boundary scanner confirms it contains no blind-map secret, provider/condition disclosure, prompt, evidence payload, private path, or candidate prose beyond the reviewer's dimension rationale.

- [ ] **Step 6: Generate and review the calibration proposal**

Run: `npm run c2:pilot -- propose --runs eval/c2/runs`

Expected: proposal reports condition deltas, regressions, readiness transitions, safety results, gold headroom, independent compatibility, and costs; it does not select thresholds automatically.

- [ ] **Step 7: Author the freeze authorization**

Record the selected positive material-benefit minimum, regression tolerance, independent checklist, rationale, reviewer identity, timestamp, and exact proposal hash. If the pilot evidence does not support defensible values, do not freeze; revise the design or cases explicitly.

- [ ] **Step 8: Freeze and prove determinism**

```bash
npm run c2:pilot -- freeze --proposal eval/c2/calibration/proposal.json --authorization .c2-private/c2/freeze-authorization.json
cp eval/c2/calibration/frozen.json /tmp/c2-frozen-first.json
npm run c2:pilot -- freeze --proposal eval/c2/calibration/proposal.json --authorization .c2-private/c2/freeze-authorization.json
cmp /tmp/c2-frozen-first.json eval/c2/calibration/frozen.json
npm run c2:pilot -- validate --calibration eval/c2/calibration/frozen.json
```

Expected: byte-identical frozen output and successful validation.

- [ ] **Step 9: Rerun the full gate and record final Pass 2 status**

Run the complete Task 9 gate again. Update readiness status to say Pass 2 calibration is frozen, Pass 3 may consume its exact hash, and C2 remains open.

- [ ] **Step 10: Commit only review-safe artifacts**

```bash
git add eval/c2/runs eval/c2/scorecards eval/c2/calibration docs/AGENT_READINESS_STATUS.md
git diff --cached --check
git commit -m "eval(c2): freeze Pass 2 pilot calibration"
```

Before committing, run the durable-artifact boundary scanner and manually confirm no prompt, evidence payload, raw response, candidate prose, secret, or private corpus path is staged.

- [ ] **Step 11: Open PR 2 for operational evidence**

Run the holistic review against the post-PR-1 `origin/main` base. The PR contains Task 10 evidence, scorecards, frozen calibration, and readiness documentation only; any code change requires returning to a separately reviewed implementation task before rerunning affected paid cases.

---

## Final Review Gate

PR 1 is ready for holistic review when Tasks 1–9 are complete, every offline/no-egress gate passes, and no paid artifacts exist. PR 2 is ready for holistic review when Task 10 is complete and its artifacts bind the merged PR 1 code.

Pass 2 is complete only when:

- Tasks 1–9 are merged through PR 1.
- Task 10 is complete with explicit human authorization and reviewed through PR 2.
- Every persisted artifact resolves by exact hash.
- The v1 scorer golden regression passes all 12 labels and fixed mutations.
- OpenAI and Claude model identity and usage are exact and auditable.
- Paid costs remain at or below $0.50 per run and $5 per campaign.
- No durable artifact contains private evaluation payloads.
- C0 and C1 remain closed; C2 remains open.
- The diff contains no retagging, corpus mutation, C2 approvals, or C3 product work.

After implementation, use the repository's holistic review workflow against `origin/main` and address every P0/P1 finding before opening the PR.

## What already exists

Reused, not rebuilt. Pass 2 layers the C2 harness **on top of** these existing systems.

| Existing artifact | Reuse in Pass 2 | Not rebuilt |
|---|---|---|
| `src/tagger.ts:2097 callTextModel` + `callOpenAI`/`callClaude`/`callGemini`/`callOpenAICompatible` | Widened additively via `callTextModelWithMetadata` to surface `usage`; legacy 4-arg signature preserved as compat wrapper | No new provider HTTP clients; no new retry/backoff (`fetchWithRetry:477` reused) |
| `src/corpus.ts:319 searchRanked` + `src/corpus-reader.ts CorpusReader` | Called directly from `condition-resolver.ts` via injected reader; new `searchMode: "keyword-only"` option pins retrieval determinism | No new search engine; no image-embeddings path (`retrieveCritiqueEvidence` untouched except via the regression test that proves omitted-option behavior is unchanged) |
| `src/c2/evaluation-contracts.ts:173 C2EvaluationRunManifestSchema` | Renamed to `V1Schema` with `C2EvaluationRunManifestSchema` compat alias; V2 added alongside | V1 fields and refinements untouched (verified by equality test) |
| `src/c2/case-contracts.ts C2CaseBriefSchema`/`C2DecisionLabelSchema` | Consumed by scorer, prompt-builder, condition-resolver | Pass 1 pilot briefs/labels untouched |
| `src/readiness/contracts.ts:43 canonicalJsonStringify` + `:34 sha256Hex` | Consumed by manifest emission, condition-input hashing, scorecard binding | No new canonicalization |
| `scripts/build-c2-pilot-manifest.mjs:454-470` atomic-write pattern | Copied into `private-artifacts.ts` for run-manifest emission | No new atomic-write primitive |
| `scripts/design-handoff-scorer.mjs:152 scoreDesignHandoff` | Untouched; v1 regression matrix proves it stays unchanged across 12 labels + mutations | No competing v1 scorer; C2-native scorer is separate (`src/c2/scorer.ts`) |
| `eval/design-handoff-labels.json` (12 v1 labels) | Loaded by v1 regression test; never modified | v1 fixtures stay frozen |
| `eval/c2/pilot/` (3 Pass 1 pilot packages) | Consumed by condition-resolver; manifest re-bound when evidence descriptors land | Pilot briefs/labels untouched |
| `npm run check-public-site-boundary` | Must stay green — pilot run artifacts live under `eval/c2/runs/` and `.c2-private/` (gitignored) | No new boundary check |

**Reuse discipline:** the only change to a shipped function's *contract* is `SearchOptions.searchMode` (Task 6 Step 3), explicitly flagged as compatibility-sensitive with an integration regression protecting `critique-retrieval.ts`. Every other existing system is treated as a frozen input.

## NOT in scope

- **40-entry gold selection, independent external labeling, 25-case authoring** — Pass 3. Pass 2 runs exactly 3 pilot cases (12 runs).
- **Retag generation, corpus mutation, canary promotion, rollback** — Pass 5. Pass 2 defines no remediation path.
- **Failure adjudication, corrected-label shadow runs** — Pass 4. Pass 2's `corrected-label-shadow` condition type exists in the schema but is never resolved or executed.
- **C2 checkpoint recipe/policy/registry/index/ledger/approvals, validator activation** — Pass 6. Pass 2 adds no governance artifacts.
- **Real text/vector retrieval at scale** — the pilot pins `searchMode: "keyword-only"` for determinism. Hybrid vector retrieval stays the production default for non-C2 callers.
- **Content-redacted candidate views for stronger blinding** — Pass 2 acknowledges metadata-blinding cannot hide condition-inferable prose clues. Stronger redaction is a future enhancement if calibration credibility requires it.

## Failure modes

For each new codepath, one realistic production failure and its coverage:

| Codepath | Failure mode | Test? | Error handling? | User-visible? |
|---|---|---|---|---|
| Cost forecast (pre-call) | Forecast exceeds effective reserve ($0.42) | ✓ Task 5 Step 1 | ✓ `campaign-reserve-exceeded` terminal | Clear — CLI exits non-zero |
| Cost actual (post-call) | Actual > $0.50 after successful response | ✓ Task 7 Step 1 (run-budget-exceeded test) | ✓ terminal + campaign stops | Clear — run manifest records actual cost |
| Provider pinning | Provider returns different model than pinned | ✓ Task 4 Step 4 | ✓ fails closed | Clear — run fails |
| Retrieval determinism | `VOYAGE_API_KEY` set, mode not pinned | ✓ Task 6 Step 3 (regression under both envs) | ✓ `searchMode: "keyword-only"` overrides env | Clear — result `searchMode` field asserts keyword |
| Blinding | Reviewer submits identifying field | ✓ Task 8 Step 1 (`C2BlindScoreSubmission` rejects) | ✓ schema `.strict()` | Clear — submission rejected |
| Freeze determinism | Re-freeze produces different bytes | ✓ Task 10 Step 8 (`cmp` byte-identical) | ✓ explicit `frozenAt` timestamp passed in | Clear — `cmp` fails |
| V1 scorer regression | Scorer behavior drifts on existing labels | ✓ Task 2 Step 4 (12-label matrix) | ✓ test fails with per-case diff | Clear — `test:c2-scoring` fails |
| Barrel exports | New modules re-export primitives → collision | ✓ Task 1 Step 7 (collision compile test) | ✓ TypeScript duplicate-export error | Clear — build fails |
| Calibration end-to-end | Integration bug in propose/freeze flow | ✓ Task 9 (`calibration.e2e.test.ts` synthetic) | ✓ test fails before paid execution | Clear — PR 1 gate fails |

**No critical gaps.** Every failure mode has a test AND error handling AND surfaces clearly. The two-PR split + Task 9 synthetic e2e test ensures no integration bug survives into paid execution.

## Worktree parallelization strategy

**Sequential implementation within PR 1; no parallelization opportunity.** The 9 tasks form a strict dependency chain:
- Task 1 (contracts) → Task 2 (scorer, consumes contracts) → Task 3 (prompt, consumes briefs)
- Task 4 (telemetry) is independent of Tasks 2-3 but unblocks Task 7
- Task 5 (cost) consumes Task 1's pricing schema
- Task 6 (resolver) consumes Tasks 1+3
- Task 7 (harness) consumes Tasks 4+5+6
- Task 8 (calibration) consumes Tasks 1+7
- Task 9 (verification) consumes Tasks 1-8

Two theoretical parallel lanes (Tasks 2+3 vs Task 4) share no modules, but the coordination overhead exceeds the time saved for a plan this size. Single-threaded implementation is simpler and matches the sequential commit cadence.

**PR 2 (Task 10) is strictly sequential after PR 1 merges** — by design.

## Post-implementation amendments (2026-07-20, retroactive)

A post-implementation `/plan-eng-review` against the shipped Tasks 1-9 (branch `codex/c2-pass2-harness-pr1`, commits `3db1a29`..`4e44f51`) found 8 places where the implementation diverged from the plan's described steps. None changes the architecture; all are correctness fixes, integration discoveries, or clarifications that Pass 3's planner needs. Backfilled here so the plan is an accurate standalone artifact.

### P1 — correctness fixes caught by two-stage review

1. **V2 manifest `terminalReason` is nullable.** Task 1 Step 5 says "Add V2 with explicit `terminalReason`" without specifying nullability. The shipped V2 schema (`src/c2/evaluation-contracts.ts:260`) makes `terminalReason: C2TerminalReasonSchema.nullable()` because running-state manifests (written before the provider call) have no terminal reason yet. The `statusReasonOk` check (`:273`) has a `run.status === "running" && run.terminalReason === null` branch. Without this, running manifests cannot parse as V2 and Task 7's lifecycle step 5 (write running manifest before egress) is impossible. Caught by code-quality review of Task 1.

2. **Claude/Gemini model pinning threads `modelOverride` as a function argument.** Task 4 doesn't mention the env-mutation issue. The initial implementation used `process.env.CLAUDE_AUTO_TAG_MODEL = model` mutation, which was **dead code** — `callClaudeWithMetadata` reads the module-level constant captured at load (`CLAUDE_AUTO_TAG_MODEL` at `src/tagger.ts:560`), not the live `process.env` value. The shipped fix (`src/tagger.ts:2188`) adds `options?.modelOverride ?? CLAUDE_AUTO_TAG_MODEL` and removes the env mutation entirely. Same pattern for Gemini (`:2278`, `:2312`). Caught by code-quality review of Task 4; would have shipped a broken C2 pinning contract for 2 of 3 providers without the review.

3. **OpenAI `apiKey` resolved from `apiKeyEnv` at the CLI layer.** Task 4 implies `endpoint.apiKey` is honored. The initial CLI implementation (`src/scripts/run-c2-pilot.ts:526`) constructed `endpoint: { provider, model }` with NO `apiKey`, causing `callTextModelWithMetadata` to throw `endpoint.apiKey is required for provider "openai"` before any fetch — every primary-lane live run would have failed with a misleading `provider-failed`. The shipped fix adds `buildModelEndpoint` (`:511`) which resolves `apiKey: process.env[req.apiKeyEnv] ?? ""`. Claude/Gemini documented as env-only (they read their own env vars inside the call functions). Caught by code-quality review of Task 7; invisible to the test suite because no test reaches a live provider.

### P2 — integration fixes

4. **Boundary scanner uses exact-name matching, not prefix matching.** Task 6 Step 6 describes the scanner but not the matching strategy. The initial implementation (`src/c2/private-artifacts.ts:144`) used a prefix regex `"prompt[A-Za-z0-9_]*"` which false-positive-matched legitimate V2 manifest fields (`promptSha256`, `promptTokens`). The shipped fix (`:144`) uses exact-name matching against `FORBIDDEN_CONTENT_FIELDS` so hash/count fields are not rejected. Required when Task 7 wired the scanner into `writeManifestDurable`.

5. **CLI entry-point guard.** Task 7 doesn't mention module-load side effects. The initial `run-c2-pilot.ts` ran `parseArgs` + `main()` at module scope, so importing the module (which tests do for `buildModelEndpoint`) executed the CLI and called `process.exit(2)`. The shipped fix wraps the entry block in `if (import.meta.url === \`file://${process.argv[1]}\`)` and moves `parseArgs`/`subcommand` inside `main()`.

6. **`C2_NO_DOTENV` escape hatch in `src/env.ts`.** Task 7 doesn't mention env auto-load. The repo's `src/env.ts` auto-loads `.env` with `override: true` (intentional per commit `04208fb`), which defeated the CLI's credential preflight in tests (the subprocess re-acquired real `OPENAI_API_KEY` from `.env` even when the test stripped it). The shipped fix adds `C2_NO_DOTENV=1` (`src/env.ts:63`) which skips the auto-load; the CLI's `spawnCli` test helper sets it. Production behavior unchanged (auto-load runs by default).

7. **`cliSynthesized` marker on CLI-produced compatibility.** Task 8 describes `evaluateIndependentCompatibility` as a real evaluation. The CLI's `buildCompatibilityInput` (`src/scripts/run-c2-pilot.ts:760`) fabricates a "compatible" result from score-completeness signals because the run artifacts don't enumerate per-decision lanes. The shipped fix adds `cliSynthesized: z.boolean().optional()` to `IndependentCompatibilitySchema` (`src/c2/condition-contracts.ts:353`) so the proposal artifact is self-describing. The human-authored freeze authorization is the binding authority.

### P3 — clarifications

8. **Task 9 resolves 9 unique condition-input files, not 12.** The plan's Step 1 says "nine primary condition inputs plus the configured three Claude inputs." The implementation resolves 9 primary files (3 cases × 3 OpenAI conditions); the 3 Claude runs reuse the same `current-grounded` files because Claude's `independentConditions: ["current-grounded"]` is a subset of OpenAI's `conditions`. Total runs = 12, but only 9 unique condition-input files on disk. Plus: `entryToContent` (`src/c2/condition-resolver.ts:505`) was fixed to coerce `entry.platform ?? null` because 340/787 corpus entries omit the optional `platform` field — without this, `prepare` fails with `undefined is not canonical JSON`. Caught by the OV7 synthetic e2e test before any paid execution.

### Deferred to PR 2 (10 Minor debt items)

The holistic final reviewer captured 10 Minor items that are not blockers for PR 1 but should be addressed before PR 2 (Task 10, paid pilot):

- **M1:** CLI `run` should re-parse the prepared condition input through `C2ConditionInputSchema` and verify `inputSha256` round-trips (currently loaded via `JSON.parse(...) as C2ConditionInput` cast).
- **M2:** `freezeCalibration` should refuse an authorization whose `independentChecklist` carries `cliSynthesized: true` (require explicit human-authored compatibility at freeze time).
- **M3:** `forecastUsd` is dead code on the manifest-build path (`void input.forecastUsd` at `harness.ts:726`) — either drop from `BuildManifestInput` or persist via a V2.1 schema extension.
- **M4:** CLI uses plain `writeFileSync` in `prepare` and `makeFilesystemStore` rather than the atomic `writePrivateArtifact` primitive. Boundary scan still runs before durable writes; atomicity missing.
- **M5:** `run-c2-pilot.test.ts`'s `prepare` test times out at 15s under parallel load (passes in 3.8s in isolation). Raise `testTimeout` for CLI-spawning describes.
- **M6:** Harness pins literal `ceilingUsd: 0.5` / `5` rather than threading `campaign.maxRunCostUsd` / `maxCampaignCostUsd`. Duplicates the schema literals.
- **M7:** `runId` template `c2-run-${caseId}-${condition}-${n}`.slice(0, 64)` could truncate mid-token for longer caseIds.
- **M8:** `entryToContent` hardcodes the model-visible subset of a corpus entry. Consider deriving from a schema-driven projection.
- **M9:** `wiring-verification.test.ts` allowlist grew by 6 entries for Task 6-8 symbols. PR 2 should wire real CLI callers and remove them from the allowlist.
- **M10:** `roundPersistedCost` uses `Math.round` (half-up); the doc comment is more careful than the code.

### OV7 proof caught a real bug

The synthetic end-to-end calibration test (`src/c2/calibration.e2e.test.ts`, mandated by OV7) caught the `entry.platform ?? null` bug (delta #8) during Task 9's `npm run c2:pilot -- prepare` step. This is exactly the failure mode OV7 was designed to surface: an integration issue caught by the synthetic run before any paid execution. Without OV7, this bug would have surfaced during Task 10's paid pilot with real money spent.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | NOT RUN | Scope settled in approved C2 design + Pass 1 issue #39 |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | NOT RUN | Codex not installed; Claude subagent used instead (see below) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 3 my-review findings + 10 outside-voice findings; all 13 folded |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | NOT APPLICABLE | Pass 2 changes evaluation artifacts, not UI |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | NOT RUN | `tsc &&` prefix on every CLI invocation is a known DX wart (P3); offline `propose`/`validate`/`freeze` commands don't need fresh compilation. Tracked as minor; defer to post-merge polish. |

**VERDICT:** ENG CLEARED — ready to implement PR 1 (Tasks 1-9, offline harness) after the 13 review findings above are folded into the plan.

### Review findings summary (13 total)

**Architecture (1 finding, folded):**
- Retrieval mode not pinned → `SearchOptions.searchMode: "keyword-only"` + regression test

**Code quality (1 finding, folded):**
- Blinding under-specified → random UUIDs + two-stage `C2BlindScoreSubmission` → `finalizeBlindScorecard` flow + honest "metadata-blinded" terminology

**Test review (1 finding, folded):**
- `run-budget-exceeded` named but untested → concrete $0.60-actual-overage test with campaign-stop + next-run-blocked assertions

**Outside voice — 10 findings, all folded:**
- OV1 (P1): `SearchOptions.searchMode` flagged as compatibility-sensitive contract change + regression protecting `critique-retrieval.ts`
- OV2 (P1): `inspectedUrls` made optional; scorer parses through candidate schema first (so accessibility/failureRecovery non-empty constraints become deterministic gate)
- OV7 (P1): synthetic end-to-end calibration test (`calibration.e2e.test.ts`) in Task 9, exercising real propose/freeze/blinding functions before PR 1 merges
- OV3 (P2): effective campaign reserve arithmetic ($5/12 = $0.4167) with preflight checking both models fit
- OV4 (P2): v1 candidate fixtures explicitly authored under `eval/design-handoff-v1-candidates.json`
- OV5 (P2): barrel-export hygiene step + collision compile test
- OV6 (P2): "metadata-blinded" terminology replaces "blinded" throughout
- OV8 (P2): `frozenAt` as passed-in canonical timestamp; byte-identical re-freeze test
- OV9 (P3, deferred): Slice D operational risks (model retirement, partial campaign, reviewer unavailability) — defer to execution discipline
- OV10 (P3, settled): harness sizing — scope challenge already accepted this as the spec decomposed

NO UNRESOLVED DECISIONS
