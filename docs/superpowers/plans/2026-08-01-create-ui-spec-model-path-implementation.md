# `create_ui_spec` Proposal-Only Model Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional, explicitly pinned model path to `create_ui_spec` that returns a clearly labeled proposal, preserves deterministic evidence authority, fails atomically to the deterministic scaffold, and records successful generation in a corpus-isolated artifact history.

**Architecture:** Keep deterministic retrieval and assembly as the authority-bearing baseline. Resolve model configuration only at composition roots, pass it through injected dependencies, call exactly one pinned provider, strictly parse a bounded proposal, and attach that proposal to `UiSpec` without promoting it into accepted token fields. Put safe execution status beside the envelope rather than inside semantic content, while storing the full validated proposal plus execution integrity metadata in a separate gitignored store keyed by `artifactId`.

**Tech Stack:** TypeScript, Zod, Vitest, Node filesystem APIs, existing `callTextModelWithMetadata`, MCP SDK, React/Vite, npm scripts.

## Global Constraints

- Preserve the C3 anchor/recipe contract and all deterministic evidence/ranking behavior.
- Model output is `proposal-only`. It must never become `corpus-observation`, an accepted token authority, or a corpus write.
- Keep `colorTokens` and `typographyTokens` `null`, their authorities `editorial`, and the corresponding unavailable decisions present until a caller or design system accepts exact values in a later feature.
- The public request schemas must not accept provider, URL, model, API key, prompt, or generation parameters.
- A configured call uses exactly `{ provider, baseUrl, apiKey, model }`; no ambient credential fallback and no provider/model fallback.
- First-slice generation parameters are pinned to `temperature: 0`, `maxOutputTokens: 4096`, `maxAttempts: 1`, and `seed: null`. These values are recorded; deterministic reproducibility is never claimed.
- Reject model responses larger than 32 KiB before `JSON.parse`, reject Markdown fences and non-JSON prose, and validate the parsed object with a strict Zod schema.
- Never expose API keys, raw provider bodies, local paths, raw corpus records, or private markers through MCP, HTTP, site projection, logs, warnings, or stored records.
- A visible proposal must affect `semanticSpecSha256` and `artifactId`; timestamps and execution metadata must not.
- The generated-artifact store retains records until explicit deletion. It has its own schema, reader, and delete operation and is never imported by corpus readers or ranking code.
- Any call, validation, authority, integrity, or persistence failure discards the entire proposal and returns a freshly validated deterministic scaffold with a safe, distinct execution state — **whenever the deterministic path itself would have succeeded**. If the deterministic rebuild *also* fails, the request errors as it does today; the model path must not convert a genuine deterministic failure into a silent success. See Task 5 Step 4a.
- Use `apply_patch` for edits. Preserve unrelated worktree changes.
- After every task: run focused tests, commit, request code review, resolve findings, and write the required `.zcode` review artifact before beginning the next commit.
- **Every commit leaves the whole suite green, not just the task's focused tests.** Any gate a task turns red is regenerated or fixed *in that task*, never deferred to Task 8. See the docs drift gate in Task 2.
- **Leaf annotations are part of the honesty invariant, not documentation.** `CREATE_UI_SPEC_FREE_TEXT_LEAVES` is a machine-readable claim about who authored each string position, and nothing at runtime validates its text. Any new proposal leaf must be annotated as model-generated and never-accepted.

---

## Prerequisite: settle C3 before Task 1

**This plan must not start until the C3 question is answered, because the answer is not reversible after the fact.**

`C3_CONTRACT_BINDINGS` (`src/readiness/checkpoint-policy.ts:476-483`) pins exactly the files this plan modifies: `src/tool-contracts.ts`, `src/create-ui-spec.ts`, `src/create-ui-spec-contracts.ts`, `src/server-factory.ts`, `src/scripts/ui-server.ts`. The pins are by **git commit, not live bytes**, so editing those files does not retroactively break anything — the readiness gate stays green throughout this plan.

The sequencing decision is now recorded: **option (a), close C3 first**. PR #87
merged the deterministic baseline and the readiness validator reports `C3:
closed` with no blocking issues. This implementation therefore adds the model
path after the deterministic baseline was signed; it does not silently reopen
that checkpoint or claim that the model path was part of the signed baseline.

No alternative remains open for Task 1. The model path is intentionally a
separate, proposal-only capability layered on the closed deterministic anchor.

---

## Task 1: Make the pinned text-model call truly explicit for every provider

**Files:**

- Modify: `src/tagger.ts`
- Modify: `src/c2/model-telemetry.test.ts`
- Add: `src/create-ui-spec-model-client.test.ts`

**The leak is real — verified.** `callTextModelWithMetadata` (`src/tagger.ts:2562`) validates the endpoint for OpenAI-compatible providers but explicitly falls back to ambient credentials for the two native ones:

```ts
} else if (provider === "claude") {
  if (!process.env.ANTHROPIC_API_KEY) { throw ... }   // src/tagger.ts:2584
} else if (provider === "gemini") {
  if (!process.env.GEMINI_API_KEY) { throw ... }      // src/tagger.ts:2588
```

**⚠ THIS IS THE C2 CALL PATH, AND C2 IS CLOSED.** `src/tagger.ts:2596`: "The C2 path must be reproducible from the request alone."

**C2 contract amendment approved 2026-08-01:** the stale telemetry assertion
that intentionally expected Claude to ignore `endpoint.apiKey` is updated in
this task. The explicit endpoint tuple is now authoritative for the C2 path;
legacy callers without an explicit endpoint may retain their established
ambient configuration behavior.

**Resolved: the change is additive.** Traced rather than assumed:

- The only production callers are `src/scripts/run-c2-pilot.ts:616` and `src/scripts/run-c2-baseline.ts:1472`. Both build the endpoint with `buildModelEndpoint` (`run-c2-pilot.ts:572-582`), which sets `apiKey: process.env[req.apiKeyEnv] ?? ""`.
- Every C2 case config uses `apiKeyEnv: "ANTHROPIC_API_KEY"` or `"OPENAI_API_KEY"`. For claude that is **the same variable `callClaudeWithMetadata` already reads**, so forwarding `request.endpoint.apiKey` as an override supplies a byte-identical value and the request body does not change.
- **No C2 case targets gemini**, so the gemini half of this task cannot affect C2 at all.

Two conditions must hold for that to stay true. Both are cheap and both need an explicit test:

1. **`undefined` base URL must mean "keep the current default", not "empty string".** `buildModelEndpoint` returns **no** `baseUrl`, so C2 requests carry `baseUrl: undefined`. If `baseUrlOverride` is threaded with `||` or coerced to `""`, every C2 claude run breaks. Use `??` against the existing default and add a case asserting an absent `baseUrl` produces the same URL as today.
2. **An empty-string `apiKey` must not silently become a request with no credential.** `buildModelEndpoint` falls back to `""` when the env var is unset. Today that empty value is ignored for claude (env is read directly) and the existing pre-flight throws if `ANTHROPIC_API_KEY` is missing. Preserve that fail-closed throw; do not let `apiKeyOverride: ""` reach a provider as a blank `Authorization` header.

`src/c2/model-telemetry.test.ts` must still pass **unmodified** apart from genuinely new cases. If an existing C2 assertion has to change, the additive reading is wrong for that path — stop and escalate it as a checkpoint matter, exactly like the C3 prerequisite above.

Note also that `ProviderCallOptions` **already exists** (`src/tagger.ts:428-432`) carrying `modelOverride`, `maxOutputTokens`, and `maxAttempts`. Task 1 extends that interface; it does not introduce it.

- [ ] **Step 1: Write failing credential and endpoint pinning tests**

Add tests that set conflicting ambient `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `GEMINI_API_KEY` values, invoke `callTextModelWithMetadata` with an explicit endpoint, and inspect mocked requests. Cover OpenAI-compatible, Claude, and Gemini providers.

```ts
expect(request.headers.authorization).toBe("Bearer request-key");
// NOT `toStartWith` — that is jest-extended, not Vitest, and appears nowhere
// in this repo. Vitest has no built-in prefix matcher.
expect(request.url.startsWith("https://pinned.example/")).toBe(true);
expect(JSON.stringify(request)).not.toContain("ambient-key");
```

Also prove one failed request produces one provider attempt and never changes provider or model.

- [ ] **Step 2: Run the focused tests and confirm the current native-provider leak**

Run: `npx vitest run src/c2/model-telemetry.test.ts src/create-ui-spec-model-client.test.ts`

Expected: FAIL because Claude/Gemini still read ambient credentials and/or ignore the explicit base URL.

- [ ] **Step 3: Thread explicit overrides through provider calls**

Extend the internal provider options without changing legacy `callModel` behavior:

Extend the **existing** `ProviderCallOptions` (`src/tagger.ts:428-432`, currently `modelOverride` / `maxOutputTokens` / `maxAttempts`; note it is module-private, so exporting it or keeping the new members internal is a deliberate choice) with the four new optional members:

```ts
interface ProviderCallOptions {
  modelOverride?: string;      // already present
  maxOutputTokens?: number;    // already present
  maxAttempts?: number;        // already present
  apiKeyOverride?: string;     // new
  baseUrlOverride?: string;    // new
  temperatureOverride?: number;// new
  seedOverride?: number;       // new
}
```

Resolve each new member with `??` against today's default so that `undefined` means "unchanged" — see condition 1 above. The call sites to thread are `callClaudeWithMetadata(prompt, null, undefined, "high", callOptions)` and `callGeminiWithMetadata(prompt, null, undefined, "high", "critique", undefined, callOptions)`.

`callTextModelWithMetadata` must always pass `request.endpoint.apiKey` and `request.endpoint.baseUrl` as overrides. Native Claude/Gemini functions use overrides when supplied; only legacy callers without an explicit endpoint may read their established environment variables. OpenAI-compatible calls continue to use the explicit endpoint object. Reject a non-null seed for a provider that cannot honor it instead of silently dropping it.

- [ ] **Step 4: Verify pinning and legacy compatibility**

Run: `npx vitest run src/c2/model-telemetry.test.ts src/create-ui-spec-model-client.test.ts`

Expected: PASS, including existing C2 telemetry behavior.

- [ ] **Step 5: Commit and review**

```bash
git add src/tagger.ts src/c2/model-telemetry.test.ts src/create-ui-spec-model-client.test.ts
git commit -m "fix: honor pinned model endpoints"
```

Review the commit against the no-ambient-fallback rule and record the review artifact before the next task.

---

## Task 2: Define proposal-only and execution-integrity contracts

**Files:**

- Modify: `src/tool-contracts.ts`
- Modify: `src/tool-contracts.test.ts`
- Add: `src/create-ui-spec-model-contracts.ts`
- Add: `src/create-ui-spec-model-contracts.test.ts`
- Modify: `src/create-ui-spec-contracts.ts`
- Modify: `src/create-ui-spec-contracts.test.ts`
- Modify: `src/tool-contract-docs.test.ts` (verify only — see Step 6)
- Modify: `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md` (regenerated block — see Step 6)

**Real symbol names (verified against the repo).** The first draft of this plan named four schemas that do not exist. Use these:

| Use | Not |
|---|---|
| `UiSpec` (`src/tool-contracts.ts:666`) | `UiSpecSchema` |
| `ColorTokens` (`:557`), `TypographyTokens` (`:565`) | `ColorTokensSchema`, `TypographyTokensSchema` |
| `Sha256` (`src/readiness/contracts.ts:24`) | `Sha256Schema` |

`ColorTokens` and `TypographyTokens` are module-private `const`s, **not exported**. That is why `ModelProposalSchema` must be defined in `src/tool-contracts.ts` alongside them — moving it to a new module would require exporting them or duplicating their bounds.

- [ ] **Step 1: Write failing proposal-authority tests**

Test that a proposal can contain suggested colors, typography, motion, and voice while the accepted token fields stay unavailable. Test rejection of unknown keys, empty proposals, oversized strings/arrays, private markers, accepted-authority fields, evidence kinds, and corpus IDs.

```ts
expect(parsed.spec.modelProposal?.status).toBe("proposal-only");
expect(parsed.spec.colorTokens).toBeNull();
expect(parsed.spec.colorTokenAuthority).toBe("editorial");
// The unavailableDecisions row field is `field`, NOT `decisionType`
// (src/tool-contracts.ts:697-705 refines on `d.field`).
expect(parsed.spec.unavailableDecisions).toContainEqual(
  expect.objectContaining({ field: "colorTokens" }),
);
```

- [ ] **Step 2: Add the semantic proposal schema to `UiSpec`**

Define and export this shape next to the existing token schemas so it can reuse their validation without a circular import:

```ts
export const ModelProposalSchema = z.object({
  status: z.literal("proposal-only"),
  disclaimer: z.literal("Proposal only; not accepted into token authority."),
  designDirection: z.string().trim().min(1).max(2_000),
  colorTokens: ColorTokens.optional(),
  typographyTokens: TypographyTokens.optional(),
  motionNotes: z.array(z.string().trim().min(1).max(500)).max(8).default([]),
  contentVoiceGuidance: z.string().trim().min(1).max(1_000).optional(),
}).strict();
```

Add `modelProposal: ModelProposalSchema.optional()` to `UiSpec`. Keep every existing accepted-token refinement unchanged — in particular the null-token superRefine at `src/tool-contracts.ts:697-710` reads the **root** `colorTokens`/`typographyTokens`, so a proposal carrying suggested tokens must not satisfy it.

- [ ] **Step 2a: Extend the leaf-classification MAP, not only its tests**

`classifyCreateUiSpecLeaf` (`src/tool-contracts.ts`) fail-closes: a string at a position no map entry names is **refused**, so every new proposal leaf needs an entry in `CREATE_UI_SPEC_FREE_TEXT_LEAVES`:

```
data.modelProposal.designDirection
data.modelProposal.disclaimer
data.modelProposal.motionNotes[]
data.modelProposal.contentVoiceGuidance
data.modelProposal.colorTokens.*        (five members)
data.modelProposal.typographyTokens.*   (three members)
data.modelProposal.status               (closed proposal-only literal)
```

**The annotation text is the point, not the key.** The gate returns immediately for the `free-text` class, so nothing at runtime ever reads these strings — an annotation that says "recipe-owned" over a position carrying model output is an authority upgrade that passes every test. This exact defect shipped once already: `data.acceptanceCriteria[].subject` was annotated "recipe-owned subject label" after it began carrying caller prose. Each new entry must name the model lane explicitly, e.g. *"model-generated proposal text; never accepted into token authority"*.

Add a guard test asserting every `data.modelProposal.*` annotation matches `/model-generated|proposal/i` and matches neither `/recipe-owned/i` nor `/caller-supplied/i`.

- [ ] **Step 3: Define safe execution metadata separately from semantic content**

In `src/create-ui-spec-model-contracts.ts`, add strict schemas/types for:

```ts
type ModelExecution =
  | { state: "invalid-configuration" }
  | { state: "call-failed" }
  | { state: "proposal-rejected" }
  | { state: "persistence-failed" }
  | {
      state: "succeeded";
      provider: Provider;
      model: string;
      promptSha256: string;
      parametersSha256: string;
      reproducibility: "conditional";
    };
```

Do not emit a `not-configured` object: absence of `modelExecution` is the backward-compatible no-model state. Define `PinnedModelEndpointSchema`, fixed `ModelGenerationParametersSchema`, and `ModelArtifactRecordSchema`. The stored record contains the validated proposal, artifact/spec/proposal hashes, safe endpoint origin, parameters, usage/attempt count/latency, `storedAt`, and `retention: "until-explicit-delete"`; it must have no raw prompt, raw response, credential, request headers, or provider error body.

- [ ] **Step 4: Bind execution metadata to its own hash**

Extend `DesignArtifactEnvelopeSchema` with an all-or-none pair:

```ts
modelExecution: ModelExecutionSchema.optional(),
modelExecutionSha256: Sha256.optional(),   // `Sha256`, not `Sha256Schema`
```

Recompute `modelExecutionSha256` during parsing. Do not include it in `semanticSpecSha256` or `artifactId`. Add tests proving:

- proposal content changes semantic hash and artifact ID;
- timestamp-only changes do not;
- execution metadata changes only its own hash;
- either missing member of the pair is rejected.

- [ ] **Step 5: Run contract tests**

Run: `npx vitest run src/tool-contracts.test.ts src/create-ui-spec-model-contracts.test.ts src/create-ui-spec-contracts.test.ts`

Expected: PASS.

- [ ] **Step 6: Regenerate the tool-contract docs — IN THIS TASK, not Task 8**

Adding `modelProposal` to `UiSpec` turns `src/tool-contract-docs.test.ts` **red immediately**. The "Success data" row is derived from the Zod schema at render time (`src/tool-contract-docs.ts:97`) and compared byte-for-byte against the generated block in `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md`.

The first draft deferred this to Task 8. That would leave the gate red across Tasks 2–7 — six commits and six review artifacts written against a failing suite, with the breakage surfacing only at the final `ci:local`. Regenerate here, in the commit that breaks it.

Splice `renderToolContractReference()` between the `GENERATED_TOOL_CONTRACTS_START` / `_END` markers, preserving the existing single-newline padding so the diff stays one line. Then hand-update the **ungated** duplicate Input/Output prose earlier in the same file — nothing catches its omission.

Run: `npx vitest run src/tool-contract-docs.test.ts`

Expected: PASS.

- [ ] **Step 7: Confirm no other gate went red**

Run the full suite once before committing — a contract change is exactly the kind that breaks a test no focused list names:

```bash
npx tsc && npx vitest run
```

Expected: PASS. If `src/wiring-verification.test.ts` flags a new export with no production caller, either wire it or allowlist it with a reason; do not defer.

- [ ] **Step 8: Commit and review**

```bash
git add src/tool-contracts.ts src/tool-contracts.test.ts src/create-ui-spec-model-contracts.ts src/create-ui-spec-model-contracts.test.ts src/create-ui-spec-contracts.ts src/create-ui-spec-contracts.test.ts docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md
git commit -m "feat: define proposal-only model contracts"
```

Review schema bounds, authority invariants, hash separation, and **leaf-annotation truthfulness**; write the review artifact.

---

## Task 3: Build a corpus-isolated generated-artifact store

**Files:**

- Add: `src/model-artifact-store.ts`
- Add: `src/model-artifact-store.test.ts`
- Modify: `.gitignore`
- **Add** (does not exist): `docs/security.md`

- [ ] **Step 1: Write failing lifecycle and isolation tests**

Cover atomic save, schema validation on read, explicit delete, missing record, traversal rejection, corrupt JSON rejection, and retention metadata.

**First resolve a contradiction in the original requirements.** The draft asked for both "duplicate-id idempotence" and "conflicting duplicate rejection". Those cannot both hold, because the key and the payload disagree by design:

`artifactId` is derived from `semanticSpecSha256` and deliberately **excludes** execution metadata, while a stored record deliberately **includes** it (usage, attempts, latency, `storedAt`). So two calls with the same brief and the same proposal produce the **same id** and **legitimately different records**. Every save after the first is therefore a "conflicting duplicate", and a naive check-then-rename lets a later write silently overwrite an earlier record — breaking `retention: "until-explicit-delete"`, which promises the opposite.

Pick one and write it into the store's contract:

- **(a) First write wins — recommended.** `save` is idempotent on `artifactId`: if a record exists, keep it and return without error. Retention holds, concurrent writers cannot clobber, and the stored execution metadata describes the run that first produced this artifact. Enforce with `wx` (exclusive create) on the temp-to-final rename rather than `existsSync` + rename, which races.
- **(b) Append a run history per artifact.** `<artifactId>/<runSha>.json`. Keeps every execution, costs a directory per artifact and a more complex reader.

Do **not** ship "last write wins": it contradicts the retention guarantee this store exists to provide.

Add a concurrency test — two `save` calls for the same `artifactId` with different execution metadata, awaited together — asserting the chosen rule actually holds under interleaving, not just sequentially.

**Corpus-unchanged assertion lives here, inline.** The first draft referenced `src/corpus-freeze.test.ts`; no such file exists. Snapshot the corpus tree (hash `corpus/entries.json` and `corpus/decisions.json`) before and after a save inside this test file and assert byte-for-byte equality. Do not point at a freeze suite that has to be invented elsewhere.

Also add an import-boundary assertion: `src/model-artifact-store.ts` must not import `src/persistence.ts`, corpus readers, ranking, or discovery.

- [ ] **Step 2: Implement the dedicated store**

```ts
export interface ModelArtifactStore {
  save(record: ModelArtifactRecord): Promise<void>;
  read(artifactId: string): Promise<ModelArtifactRecord | null>;
  delete(artifactId: string): Promise<boolean>;
}

export function createFileModelArtifactStore(rootDir: string): ModelArtifactStore;
```

Use one validated `<artifactId>.json` file per record, a temp file in the same directory, `fsync`, atomic rename, and mode `0o600`. Default production root is `.create-ui-spec-model-artifacts/`, but only the composition root selects that path. Do not add a `create_ui_spec` read path.

- [ ] **Step 3: Document retention/deletion and ignore the store**

Add `.create-ui-spec-model-artifacts/` to `.gitignore`. Document that records persist until `ModelArtifactStore.delete(artifactId)` is invoked, deletion is permanent, and this storage is neither corpus data nor retrieval input.

- [ ] **Step 4: Verify store behavior**

Run: `npx vitest run src/model-artifact-store.test.ts src/wiring-verification.test.ts`

Expected: PASS and no corpus fixture changes (`git status --short corpus/` empty).

`wiring-verification` is in that list deliberately. This task adds `createFileModelArtifactStore` with **no production caller until Task 6**, and that test requires every `src/*.ts` export to be referenced by a non-test production file. If it goes red, allowlist the export with a comment naming Task 6 as the pending consumer — do not leave the suite red between tasks.

- [ ] **Step 5: Commit and review**

```bash
git add .gitignore docs/security.md src/model-artifact-store.ts src/model-artifact-store.test.ts
git commit -m "feat: add isolated model artifact history"
```

Review path safety, atomicity, permissions, and corpus isolation; write the review artifact.

---

## Task 4: Implement the bounded proposal runner

**Files:**

- Add: `src/create-ui-spec-model.ts`
- Add: `src/create-ui-spec-model.test.ts`
- Modify (only if a new marker is genuinely needed): `src/create-ui-spec-contracts.ts`

**There is no `src/private-markers.ts`.** The first draft named one. The real screening surface is `PRIVATE_MARKERS` exported from `src/create-ui-spec-contracts.ts:1166`, plus its path-form regex just below and the `SanitizedEvidenceSchema` superRefine that applies them. Import `PRIVATE_MARKERS` and reuse the existing scan; prefer adding no new markers at all, since the list is also mirrored by `scripts/c3-runtime-probe.mjs` and the two must not drift.

- [ ] **Step 1: Write failing prompt-boundary tests**

Test that the prompt contains only caller context, intent, constraints, and already-sanitized evidence summaries. Assert it contains no corpus file path, source-private ID, response-scoped evidence ID, API key, endpoint URL, or private marker. Assert prompts above 32 KiB cause a safe rejection without a provider call.

- [ ] **Step 2: Write failing response-policy tests**

Cover valid JSON, malformed JSON, fenced JSON, trailing prose, unknown keys, over-32-KiB output, private markers, proposal authority escalation, empty proposal, provider refusal, provider exception, usage metadata, and exact single-attempt behavior.

- [ ] **Step 3: Implement the injected runtime and outcome union**

```ts
export interface CreateUiSpecModelRuntime {
  endpoint: PinnedModelEndpoint;
  parameters: ModelGenerationParameters;
  call: typeof callTextModelWithMetadata;
  store: ModelArtifactStore;
}

export type ModelPathOutcome =
  | { kind: "accepted"; proposal: ModelProposal; execution: ModelExecution; recordInput: ModelRecordInput }
  | { kind: "fallback"; execution: Exclude<ModelExecution, { state: "succeeded" }> };
```

Build the prompt as canonical JSON with a versioned policy, hash the exact prompt and parameters, and call one endpoint once. Parse `raw.trim()` directly with `JSON.parse`; do not strip fences or recover substrings. Validate with `ModelProposalSchema`, scan every string with the existing private-marker policy, and construct the fixed disclaimer in code rather than trusting model copy.

- [ ] **Step 4: Implement honest reproducibility metadata**

Record provider, model, endpoint origin, temperature, max output, max attempts, null seed, attempts, reported usage, and latency in the private record input. Public success metadata exposes only provider/model and hashes and says `reproducibility: "conditional"`.

- [ ] **Step 5: Run runner tests**

Run: `npx vitest run src/create-ui-spec-model.test.ts src/create-ui-spec-contracts.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit and review**

```bash
git add src/create-ui-spec-model.ts src/create-ui-spec-model.test.ts
git commit -m "feat: add bounded ui proposal runner"
```

Review prompt minimization, parser strictness, and failure-state mapping; write the review artifact.

---

## Task 5: Integrate proposals atomically into `create_ui_spec`

**Files:**

- Modify: `src/create-ui-spec.ts`
- Modify: `src/create-ui-spec-dependencies.ts`
- Modify: `src/design-handoff.ts`
- Modify: `src/design-handoff.test.ts`
- Modify: `src/create-ui-spec.test.ts`
- Add: `src/create-ui-spec-model-path.test.ts`

- [ ] **Step 1: Write failing end-to-end core tests**

Test five paths: no runtime, valid proposal, call failure, proposal rejection, and store failure.

For every fallback, compare `spec`, handoff, rendering, semantic hash, and artifact ID with the deterministic baseline. Only safe execution status may differ.

**Pin the clock when comparing renderings.** `specSha256` and `designJsonSha256` both embed `generatedAt` (the JSON renderer writes the timestamp; the markdown renderer does not). Drive both the baseline and the fallback through the same injected `now`, or the comparison fails on timestamps and says nothing about the fallback.

For success assert:

```ts
expect(result.spec.modelProposal?.status).toBe("proposal-only");
expect(result.spec.colorTokens).toBeNull();
expect(result.spec.typographyTokens).toBeNull();
// `UiSpec` has NO `evidence` field — the first draft asserted on one. Evidence
// lives on the adapter result (`sanitizedEvidence`) and in the spec only as
// id lanes. Assert the proposal never reached either:
expect(sanitizedEvidence.every(e => e.kind !== "model-output")).toBe(true);
expect(result.spec.authorityLanes.corpusEvidence).not.toContain("model-output");
expect(await store.read(result.artifactId)).not.toBeNull();
```

Also assert the corpus is unchanged (hash `corpus/entries.json` before/after) and that a second run with a different timestamp but identical semantic input yields the same `semanticSpecSha256` and `artifactId` — verified true of the current producer, so a regression here is a real one.

- [ ] **Step 2: Extend the sole dependency constructor**

Add a discriminated injected model state to `makeCreateUiSpecDependencies`:

```ts
type CreateUiSpecModelDependency =
  | { kind: "not-configured" }
  | { kind: "invalid-configuration" }
  | { kind: "configured"; runtime: CreateUiSpecModelRuntime };
```

Default to `not-configured` so direct callers and existing deterministic tests retain their current output shape.

- [ ] **Step 3: Run the model after deterministic evidence resolution**

Keep request parsing, evidence selection, authority resolution, and deterministic assembly in their current order. Pass only the sanitized resolved summaries into `runCreateUiSpecModel`. Add `proposal?: ModelProposal` to `assembleSpec`; do not alter deterministic candidates, accepted tokens, unavailable decisions, or evidence.

- [ ] **Step 4: Build and validate before persistence**

For a valid proposal:

1. build the spec with `modelProposal`;
2. build/render/hash the envelope;
3. parse the entire envelope through `DesignArtifactEnvelopeSchema` and private-marker gates;
4. form a store record using the resulting `artifactId`;
5. persist it;
6. return the validated envelope.

If step 3, 4, or 5 fails, discard the proposal, rebuild from the deterministic scaffold, attach `proposal-rejected` or `persistence-failed`, validate again, and return that fallback. Never mutate a partially built envelope.

- [ ] **Step 4a: Decide what happens when the FALLBACK fails**

"Always returns a validated deterministic scaffold" is not literally achievable, and the plan must say so rather than imply a guarantee the code cannot keep. The rebuild runs the same throwing code as the normal path: `assembleSpec` throws `invalidInput("assembled spec failed UiSpec validation")` (`src/create-ui-spec.ts:826`), and `parseDesignArtifactEnvelope` has seven throw sites. A double failure therefore propagates and the request errors.

That is the **correct** behavior — a deterministic failure is real and must not be masked — but it has to be explicit:

- the fallback is attempted exactly once; do not loop;
- if the rebuild throws, let the original deterministic error propagate unchanged. Do **not** wrap it in a model-flavoured error, and do **not** substitute a partially built envelope;
- the model path must never turn a deterministic failure into a success, nor a deterministic error into a different error code than the no-model path would have produced.

Add a test: force the model path on, and independently force the deterministic assembly to fail. Assert the thrown error is byte-identical to the error the same request produces with no model runtime configured.

- [ ] **Step 5: Render an unmistakable proposal section**

In `src/design-handoff.ts`, add a section headed `Model proposal — not accepted` only when `modelProposal` exists. Render the fixed disclaimer and proposed values separately from accepted/unavailable decisions. Ensure the model section participates in `designMarkdownSha256` and `designJsonSha256` (the field is `designMarkdownSha256`; `designMdSha256` does not exist).

Note the consequence for the integrity panel: `designMarkdownSha256` is currently timestamp-independent and the playground's copy says so. Adding a proposal changes that hash **by content**, which is correct and does not falsify the copy — but confirm `site/src/pages/PlaygroundPage.test.tsx`'s exact-text assertion on the integrity note still passes, since that note is pinned verbatim.

- [ ] **Step 6: Run core and integrity tests**

Run: `npx vitest run src/create-ui-spec.test.ts src/create-ui-spec-model-path.test.ts src/create-ui-spec-contracts.test.ts src/design-handoff.test.ts`

Expected: PASS.

- [ ] **Step 7: Commit and review**

```bash
git add src/create-ui-spec.ts src/create-ui-spec-dependencies.ts src/design-handoff.ts src/design-handoff.test.ts src/create-ui-spec.test.ts src/create-ui-spec-model-path.test.ts
git commit -m "feat: integrate proposal-only model path"
```

Review fallback atomicity, identity behavior, and authority preservation; write the review artifact.

---

## Task 6: Resolve configuration at composition roots and wire both transports

**Files:**

- Add: `src/create-ui-spec-model-config.ts`
- Add: `src/create-ui-spec-model-config.test.ts`
- Modify: `src/server-factory.ts`
- Modify: `src/server.ts`
- Modify: `src/create-ui-spec-mcp.ts`
- Modify: `src/create-ui-spec-http.ts`
- Modify: `src/scripts/ui-server.ts`
- Modify: `src/create-ui-spec-mcp.test.ts`
- Modify: `src/create-ui-spec-http.test.ts`
- Modify: `src/served-tool-surface.test.ts`

- [ ] **Step 1: Write failing closed-configuration tests**

Use only these dedicated variables:

```text
CREATE_UI_SPEC_MODEL_PROVIDER
CREATE_UI_SPEC_MODEL_BASE_URL
CREATE_UI_SPEC_MODEL_API_KEY
CREATE_UI_SPEC_MODEL_NAME
```

Assert all absent resolves to `not-configured`; all present and valid resolves to one pinned runtime; every non-empty partial combination resolves to `invalid-configuration`. Assert generic or provider-specific ambient variables cannot fill a missing value or override an explicit value.

- [ ] **Step 2: Implement a pure resolver**

```ts
export function resolveCreateUiSpecModelConfig(
  env: Readonly<Record<string, string | undefined>>,
): ResolvedCreateUiSpecModelConfig;
```

Normalize and validate provider, HTTPS URL, non-empty API key, and model. Do not include missing field names or secret values in public execution metadata. Build the file store only for a fully valid configuration.

- [ ] **Step 3: Preserve pure factories through option injection**

Change `createServer(reader)` to `createServer(reader, options = {})`, and pass the resolved model dependency through `registerCreateUiSpec`, the HTTP handler, and `makeCreateUiSpecDependencies`. `src/server.ts` and `src/scripts/ui-server.ts` are the only production files allowed to read `process.env`; tests inject explicit config/runtime objects.

- [ ] **Step 4: Add transport leakage tests**

For MCP and HTTP, exercise success and every fallback state. Search serialized bytes for the API key, endpoint path/query, raw provider body, private marker, local store path, and raw corpus record fields. Assert public input schemas reject provider/config keys as unknown.

- [ ] **Step 5: Verify transport parity**

Run: `npx vitest run src/create-ui-spec-model-config.test.ts src/create-ui-spec-mcp.test.ts src/create-ui-spec-http.test.ts src/served-tool-surface.test.ts`

Expected: PASS with semantically identical MCP and HTTP envelopes for the same injected runtime outcome.

- [ ] **Step 6: Commit and review**

```bash
git add src/create-ui-spec-model-config.ts src/create-ui-spec-model-config.test.ts src/server-factory.ts src/server.ts src/create-ui-spec-mcp.ts src/create-ui-spec-http.ts src/scripts/ui-server.ts src/create-ui-spec-mcp.test.ts src/create-ui-spec-http.test.ts src/served-tool-surface.test.ts
git commit -m "feat: wire pinned ui model configuration"
```

Review composition-root boundaries and served-byte secrecy; write the review artifact.

---

## Task 7: Present proposal authority and failure states in the playground

**Files:**

- Modify: `site/src/data/create-ui-spec.ts`
- Modify: `site/src/data/create-ui-spec.test.ts`
- Modify: `site/src/pages/PlaygroundPage.tsx`
- Modify: `site/src/pages/PlaygroundPage.test.tsx`
- Modify: `site/src/styles/playground.css` (there is no `site/src/styles.css`; stylesheets are per-page under `site/src/styles/`)

- [ ] **Step 1: Write failing safe-projection tests**

Test projection of proposal content and the four execution states. Assert secrets, endpoint URLs, store paths, raw bodies, and unknown model fields are dropped even when hostile fixture input contains them.

- [ ] **Step 2: Extend the safe site model**

Project only the validated proposal fields plus safe execution state/provider/model. Reuse the fixed disclaimer. Do not project record history, endpoint origin, prompt content, usage, or diagnostics.

- [ ] **Step 3: Add distinct UI states**

Render:

- no model section when not configured;
- `Model proposal — not accepted` for success;
- distinct neutral notices for invalid configuration, call failure, proposal rejection, and persistence failure;
- proposed colors/type/motion/voice in a visually separated card that never uses the accepted-token labels.

Keep deterministic evidence, decisions, and unavailable values visible regardless of model state.

- [ ] **Step 4: Verify rendering and accessibility**

Run: `npx vitest run site/src/data/create-ui-spec.test.ts site/src/pages/PlaygroundPage.test.tsx`

Expected: PASS. Tests query headings/status text by accessible role and verify the disclaimer appears exactly once.

- [ ] **Step 5: Commit and review**

```bash
git add site/src/data/create-ui-spec.ts site/src/data/create-ui-spec.test.ts site/src/pages/PlaygroundPage.tsx site/src/pages/PlaygroundPage.test.tsx site/src/styles/playground.css
git commit -m "feat: display unaccepted model proposals"
```

Review disclosure clarity, failure-state honesty, and safe projection; write the review artifact.

---

## Task 8: Dogfood, document, and run the landing gate

**Files:**

- Modify: `scripts/dogfood-createuispec.mjs`
- Modify: `README.md`
- Modify: `docs/security.md` (created in Task 3)
- Modify: `CHANGELOG.md`

**There is no `docs/tool-contracts.md`.** Generated contract documentation lives in the marker-delimited block of `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md`, and it is regenerated in **Task 2 Step 6**, not here. This task only verifies it is still current.

- [ ] **Step 1: Expand dogfood coverage**

Add deterministic/no-config, successful proposal, malformed response, provider failure, partial config, and persistence failure cases. The script must assert:

- deterministic fallback equivalence;
- proposal changes semantic identity;
- timestamp stability;
- accepted tokens remain unavailable;
- successful record exists only in the generated-artifact store;
- corpus fixtures remain byte-for-byte unchanged;
- served bytes contain none of the forbidden secret/private/path fixtures.

- [ ] **Step 2: Document exact operating behavior**

Document the four required environment variables, fixed generation parameters, no-fallback behavior, proposal-only authority, distinct public failure states, separate history/retention/deletion policy, conditional reproducibility, and the fact that model history is not readable through `create_ui_spec`.

Verify — do not regenerate — the contract documentation: `npx vitest run src/tool-contract-docs.test.ts` must already pass because Task 2 Step 6 regenerated it. If it is red here, Task 2 was landed incorrectly. Confirm the new proposal leaves are classified and the public input schema is unchanged.

- [ ] **Step 3: Run focused security and architecture checks**

```bash
node scripts/dogfood-createuispec.mjs
npx vitest run src/create-ui-spec-model-path.test.ts src/model-artifact-store.test.ts src/create-ui-spec-http.test.ts src/create-ui-spec-mcp.test.ts
git status --short corpus/
```

Expected: PASS, and `git status --short corpus/` empty. (`npm run dogfood:create-ui-spec` does not exist — invoke the script directly, or add the npm alias in this task and use it consistently. `src/corpus-freeze.test.ts` does not exist either; the corpus-unchanged assertion lives in `src/model-artifact-store.test.ts` per Task 3.)

- [ ] **Step 4: Run the full local CI contract**

Run: `npm run ci:local`

**What it actually runs**, in this order — it mirrors `.github/workflows/ci.yml` and nothing else:

```
validate-references → build → validate-corpus → test → test:critique-quality
→ site:test → site:build → site:test:browser → site:test:browser:production
→ check-site-budget
```

The first draft described it as covering "lint, typecheck, build, unit/integration tests, site checks, dogfood, and dependency audit". It runs **no lint, no dogfood, and no dependency audit**, and no `lint` or `audit` script exists in `package.json`. Typecheck happens inside `build` (`tsc`). Dogfood is Step 3 above and stays there.

Expected: PASS. If a jsdom step fails but passes standalone, that is local contention (issue #84, macOS Spotlight indexing after the build), not a regression — `ci:local` prints this itself. Do not relabel a genuine provider or model failure as #84.

- [ ] **Step 5: Inspect the final diff for placeholders and accidental scope**

```bash
rg -n "TODO|TBD|FIXME" src site scripts docs README.md CHANGELOG.md
git diff --check
git status --short
```

Expected: no implementation placeholders, no whitespace errors, no corpus files, no generated-artifact records, and only planned project files plus pre-existing user changes.

- [ ] **Step 6: Commit documentation and dogfood**

```bash
git add scripts/dogfood-createuispec.mjs README.md docs/security.md CHANGELOG.md
git commit -m "docs: document proposal-only model path"
```

- [ ] **Step 7: Request branch-level review**

Review the complete branch against `docs/superpowers/specs/2026-08-01-create-ui-spec-model-path-design.md`. Resolve every P0/P1/P2 finding, rerun `npm run ci:local`, and write the final `.zcode` review artifact.

---

## Spec Coverage Checklist

- [ ] **C3 sequencing decided and recorded** before Task 1: Prerequisite section.
- [ ] **C2 impact of the Task 1 credential change established as additive**, with `src/c2/model-telemetry.test.ts` passing unmodified: Task 1.
- [ ] Explicit endpoint/model/credential pinning and no ambient/provider fallback: Tasks 1 and 6.
- [ ] Deterministic scaffold precedes and survives model work: Tasks 4 and 5.
- [ ] Strict bounded proposal parser and private-marker policy (`PRIVATE_MARKERS`, `src/create-ui-spec-contracts.ts:1166`): Tasks 2 and 4.
- [ ] Proposal-only authority with accepted tokens still unavailable: Tasks 2, 5, and 7.
- [ ] **Leaf-classification map extended with truthful model-lane annotations**, plus the guard test: Task 2 Step 2a.
- [ ] **Generated contract docs regenerated in the commit that breaks them**: Task 2 Step 6.
- [ ] Proposal participates in semantic identity; execution does not: Tasks 2 and 5.
- [ ] Distinct configuration/call/schema-authority/persistence states: Tasks 2, 5, 6, and 7.
- [ ] **Duplicate-save rule chosen and enforced under concurrency** (first-write-wins vs per-run history), resolving the key/payload mismatch: Task 3 Step 1.
- [ ] **Fallback-of-the-fallback behavior explicit**: a deterministic failure propagates unchanged and is never masked as a model state: Task 5 Step 4a.
- [ ] Separate artifact history with reader, integrity, retention, deletion, and corpus isolation: Task 3.
- [ ] No model history read path in `create_ui_spec`: Tasks 3 and 6.
- [ ] Safe HTTP/MCP/site bytes: Tasks 6 and 7.
- [ ] Corpus unchanged, dogfood, documentation, and `ci:local`: Tasks 3 and 8.

## Dependency Order

Prerequisite (C3 sequencing) precedes everything. Tasks 1–4 establish reusable boundaries and must land in order. Task 5 consumes all four. Task 6 wires Task 5 into production adapters. Task 7 consumes the final envelope contract. Task 8 is the landing gate. Do not parallelize tasks that touch `src/tool-contracts.ts`, `src/create-ui-spec-contracts.ts`, or `src/create-ui-spec.ts`.

**Every task ends green.** Two tasks make a change whose blast radius is wider than their own focused test list, and each repairs it in the same commit rather than deferring:

- **Task 2** breaks `src/tool-contract-docs.test.ts` the moment `modelProposal` joins `UiSpec`, because the Success-data row is derived from the Zod schema at render time (`src/tool-contract-docs.ts:97`). It regenerates the block in Step 6 and runs the full suite in Step 7.
- **Task 3** adds an export with no production caller until Task 6, which `src/wiring-verification.test.ts` may flag. It resolves that in Step 4, by wiring or by an allowlist entry naming Task 6.

A task that leaves the suite red is not done, regardless of its own tests passing.
