# Model-Lane Reliability — Design (Plan 1)

**Status:** Proposed
**Date:** 2026-08-02
**Scope:** `create_ui_spec` model lane reliability. This is Plan 1 of a two-plan
sequence; Plan 2 (deterministic body + grounding) is specified separately in
`2026-08-02-deterministic-body-grounding-design.md`.

## Context

A live test of the shipped lane surfaced four failures that unit coverage could
not see:

1. **Silent misconfiguration.** The lane fell back to the deterministic
   scaffold while returning `status: ok`, twice: `CREATE_UI_SPEC_MODEL_BASE_URL`
   missing the `/v1/messages` path (404), and the model alias
   `claude-sonnet-4-5` resolving to `claude-sonnet-4-5-20250929` (fail-closed
   model-substitution check). An operator cannot distinguish a broken lane from
   a working one through the MCP payload, which intentionally projects no
   execution state.
2. **Parse-failure flake.** 1 of 4 live first attempts returned structurally
   invalid JSON (stray unescaped character), rejected by design. No retry
   exists; `maxAttempts` is pinned to `1`.
3. **Stub evidence reaches the model.** The model prompt receives
   `evidenceSummaries` containing deterministic recipe stubs
   (`"Deterministic c3-fallback-v1 recipe"`, `"profile reference with 3
   regions"`) when the caller passes no `referenceIds`. Placeholder strings
   are worse than no evidence: they read as grounding that does not exist.
4. **Verbose output.** Live outputs ran 1,222–1,673 chars of `designDirection`
   against a 1,000-char prompt figure, with mechanically repeated
   DECISION/EFFECT/REJECTS scaffolding.

## Scope

**In (Plan 1):**
- Retry on JSON parse failure only, via a `maxAttempts` contract amendment.
- Operator channel: `modelExecutionState` + `proposalOnly` on the MCP payload,
  boot-time config warnings, a `check:model-lane` MCP tool, `.env.example`
  documentation, and operator-facing log lines.
- Grounding honesty: model prompts never contain stub/recipe evidence; the
  `evidenceSummaries` key is omitted when no real evidence exists.
- Prompt conciseness: instruction tightening + `POLICY_VERSION` bump.

**Out (Plan 2 or later):** deterministic body content, auto-retrieval by brief
similarity, corpus provenance governance, coarse `design_solution` tool,
learning loop. See the Plan 2 spec for the first two.

## Design

### 1. Retry on parse failure (`maxAttempts: 1 | 2`)

**Contract changes:**
- `src/create-ui-spec-model-contracts.ts:70` —
  `maxAttempts: z.literal(1)` → `z.union([z.literal(1), z.literal(2)])` in
  `ModelGenerationParametersSchema`.
- `src/create-ui-spec-model-contracts.ts:124` — `attempts: z.literal(1)` →
  `z.union([z.literal(1), z.literal(2)])` in `ModelArtifactRecordSchema`.
- `src/create-ui-spec-model.ts:60` — `ModelRecordInput.attempts: 1` → `1 | 2`.
- The operator-facing resolver (`create-ui-spec-model-config.ts`) keeps
  `maxAttempts: 1`; nothing enables retries until an operator opts in.

**Behavior (`src/create-ui-spec-model.ts` `createUiSpecModel`):**
- The single provider call becomes a loop over `1..parameters.maxAttempts`.
- Each loop iteration calls `runtime.call` with HTTP-level `maxAttempts: 1`
  (per-generation HTTP retry stays single-attempt, so the two retry domains do
  not tangle; `fetchWithRetry` transient-error handling is unchanged).
- Retry condition: **only** a `JSON.parse` failure of the unwrapped content
  (after `unwrapExactCodeFence`) when `attempt < maxAttempts`. The identical
  prompt and parameters are reused for the second generation.
- Non-retryable outcomes, single attempt, exactly as today: `runtime.call`
  throwing (`call-failed`), schema rejection, byte-limit rejection, and
  private-marker rejection (`proposal-rejected`).
- On second-attempt success: `attempts` in the record is the actual count (2);
  usage and latency come from the successful attempt. Both-attempts-fail
  yields the same `proposal-rejected` fallback as today.

**Rationale:** parse failures are the measured recoverable class (malformed
JSON from the model); a retry on schema/length rejections would double cost
without fixing the rejection, and call errors are already covered by
`fetchWithRetry` at the HTTP layer.

### 2. Operator channel

**Payload projection (`src/create-ui-spec-mcp.ts`):**
- Add top-level `modelExecutionState` to the structured payload:
  `ModelExecution["state"] | null`. Derived from `envelope.modelExecution`
  (`undefined` → `null`). Values: `invalid-configuration`, `call-failed`,
  `proposal-rejected`, `persistence-failed`, `succeeded`, or `null` (no model
  configured).
- Add top-level `proposalOnly: boolean` to the structured payload, derived as
  `envelope.spec.modelProposal !== undefined`. This is the client-side
  hard-reject signal: `proposalOnly: true` means the spec's direction is model
  output and must not be treated as authoritative. The internal envelope keeps
  `modelProposal` as the source of truth; the flag is computed at projection
  time and is hash-stable (the `specSha256`/`artifactId` identity is spec-
  derived and does not change).
- `modelExecution` itself remains unprojected (no raw provider data on the
  wire).
- Update the pinned test at `src/create-ui-spec-mcp.test.ts:599-614`: the
  "indistinguishable" assertion becomes "states are distinguishable via
  `modelExecutionState`; `modelExecution` stays undefined."

**Boot-time config warnings (`src/create-ui-spec-model-config.ts`):**
- Keep existing hard shape validation (`https:`, no userinfo, complete tuple).
- Add non-blocking `console.warn` for the two measured failure patterns:
  - provider `claude` and `baseUrl` without a path that ends in
    `/v1/messages`;
  - provider `claude` and a model name that does not match the dated-ID shape
    (`/^[A-Za-z0-9._-]+-\d{8}$/`), which is the alias class that fails the
    model-substitution check.
- Warnings are advisory only; proxies legitimately vary, so neither is a hard
  error.

**`check:model-lane` MCP tool (new):**
- New module `src/model-lane-check.ts` exporting
  `registerModelLaneCheck(server, model)`, registered from
  `src/server-factory.ts` alongside `registerCreateUiSpec`.
- Read-only tool. When the lane is not configured: returns
  `{ configured: false }`. When configured: makes ONE tiny call through the
  exact pinned runtime (`maxOutputTokens: 16`, `maxAttempts: 1`,
  `temperature: 0`, prompt `"Reply with the single word: ok"`) and returns
  `{ configured: true, provider, model, resolvedModelId, reachable, error? }`.
  `resolvedModelId` comes from the call metadata; `error` is a safe message
  (no key, no URL, no raw body). Never throws to the client; network/API
  failures become `reachable: false`.

**`.env.example`:** add the four `CREATE_UI_SPEC_MODEL_*` keys with
provider-specific comments: Claude base URL must include `/v1/messages`;
`_NAME` must be the exact API model ID (e.g. `claude-sonnet-4-5-20250929` —
aliases resolve server-side and are rejected by the fail-closed check);
OpenAI-compatible providers need their endpoint URL; model names for
`gemini`/`mistral`/`minimax`/`grok` follow their platform IDs.

**Logs:** on each non-`succeeded` fallback in `createUiSpecModel` (and the
`invalid-configuration` path in `create-ui-spec.ts`), emit one concise
`console.error` line naming the state and, for `invalid-configuration`, the
safe reason class. No prompt, no response bytes, no key material.

### 3. Grounding honesty

**`src/create-ui-spec-model.ts` `buildPrompt`:**
- Filter `sanitizedEvidence` to rows whose `kind` is `corpus-observation` or
  `public-reference` and whose `summary` is non-empty. `recipe-system` rows are
  operator scaffolding, not evidence, and never reach the prompt.
- When the filtered list is empty, omit the `evidenceSummaries` key entirely
  (the prompt is canonical JSON; the key simply does not appear).
- The deterministic envelope and its served spec are unchanged — the recipe
  rows remain in the fallback body (Plan 2's domain).

### 4. Prompt conciseness

**`src/create-ui-spec-model.ts` `buildPrompt`:**
- Add to the task instruction: "Be concise. State each decision once, with one
  sentence of rationale. Drop the DECISION/EFFECT/REJECTS scaffolding where it
  adds no information."
- Bump `POLICY_VERSION` `c3-model-proposal-v4` → `c3-model-proposal-v5`
  (the version is hashed into `promptSha256`; the prompt changed, so the
  version must change).
- Prompt figures and schema caps are unchanged (1000/250/500 prompt; 2500/625/
  1250 schema).

**Success criteria (measured, not CI):** a 3-brief live campaign (the login,
finance, and habit-tracker briefs from this session) must show a median
`designDirection` ≤ ~1,150 chars (baseline ≈1,600) with zero accept-rate
regression — every response parses and validates, and the same hard-limits
consistency assertions hold.

## Data flow

```
create_ui_spec call
  → resolve config (warnings at boot)
  → resolveEvidence (unchanged; recipe rows stay in the deterministic body)
  → createUiSpecModel (loop ≤ maxAttempts; retry only on JSON.parse failure)
      → buildPrompt (filtered evidenceSummaries; concise instruction; v5)
      → runtime.call (HTTP maxAttempts 1 per generation)
      → accept | fallback
  → envelope + payload projection (modelExecutionState, proposalOnly)
  → log line on non-success
```

## Error handling

- Parse failure with attempts remaining → second generation, identical prompt.
- Parse failure on final attempt → `proposal-rejected` fallback (unchanged
  shape), `modelExecutionState: "proposal-rejected"` on the wire.
- All other rejections → single attempt, same states as today.
- `check:model-lane` → never throws; structured status with safe message.
- Boot warnings → advisory; no startup failure for valid-but-odd proxies.

## Testing

Each change is TDD with a failing test first:

1. **Retry:** fake runtime returning malformed JSON then a valid proposal →
   accepted, exactly 2 calls, record `attempts: 2`, usage/latency from the
   second call. Malformed twice → fallback, 2 calls. `maxAttempts: 1` → no
   retry. Valid JSON with schema rejection → 1 call. `runtime.call` throw →
   `call-failed`, 1 call. Contract tests for the `1 | 2` unions.
2. **Payload projection:** `modelExecutionState` correct per state; `null` when
   not configured; `proposalOnly` true iff `modelProposal` present;
   `modelExecution` still undefined; contract-gate passes.
3. **`check:model-lane`:** not configured; configured-success (fake runtime
   records the tiny call params); configured-throw → `reachable: false`.
4. **Config warnings:** claude base URL without `/v1/messages` warns; dated-ID
   model name does not warn; non-claude providers do not warn.
5. **Grounding:** prompt for a no-reference request contains no
   `evidenceSummaries` key and none of the recipe stub strings; prompt for a
   referenced request includes the real summaries.
6. **Conciseness:** prompt boundary tests assert `c3-model-proposal-v5` and the
   new instruction; `not.toContain("c3-model-proposal-v4")`.

Update the pinned tests listed above and the dogfood script
(`scripts/dogfood-createuispec.mjs`) for `attempts: 1 | 2` parity. Verification:
`npx tsc --noEmit`, full `vitest` suite, `node scripts/dogfood-createuispec.mjs`
(no npm alias exists; invoke the script directly), then the live 3-brief
campaign + one `check:model-lane` call against the real `.env`.

## Non-goals

- Deterministic body content (Plan 2).
- Auto-retrieval / brief-similarity grounding (Plan 2).
- Corpus provenance governance, coarse `design_solution` tool, learning loop
  (separate future plans).
