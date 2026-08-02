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
2. **Parse-failure flake.** 3 of 22 live first attempts across three
   independent runs returned structurally invalid JSON — an unescaped `"`
   inside a string value, and a stray trailing `}` — rejected by design. No
   retry exists; `maxAttempts` is pinned to `1`. Re-running the two
   reproducible failures at the identical prompt and `temperature: 0`
   recovered 4 of 4, so the malformation is a low-probability sampling event,
   not an attractor state.
3. **Content-free evidence steers the model.** The model prompt receives
   `evidenceSummaries` for every request, including reference-less ones. Two
   classes reach it: the `recipe-system` stub
   (`"Deterministic c3-fallback-v1 recipe"`) and — the load-bearing one —
   `corpus-observation` summaries from `buildCorpusObservationSummary`
   (`src/c3/safe-aggregator.ts:171`), whose entire content is a pattern label
   and a region count (`"editor-canvas reference with 3 regions"`). These are
   `corpus-observation` rows, NOT recipe stubs: filtering by evidence `kind`
   does not remove them.

   Measured: all 10 briefs in the live probe retrieved 5 corpus observations,
   so the list is never empty in practice. On a thin brief the labels become
   the brief — `"Make it better."` retrieved `editor-canvas ×4, marketing-hero`
   and produced a proposal describing drag-and-drop snap points, "hero and
   editor zones", and marketing conversion. A second reviewer's independent
   run on the same one-liner invented a three-column editor. The summaries
   carry almost no information and dominate exactly where the brief carries
   least.
4. **Verbose output.** Across the 8 accepted proposals in the 10-brief probe,
   `designDirection` ran 1,011–1,789 chars against a 1,000-char prompt figure
   (median 1,272), with mechanically repeated DECISION/EFFECT/REJECTS
   scaffolding. Every value is inside the 2,500 schema cap, so this is a
   quality and cost concern, not a rejection risk.

## Governing invariant

> Nothing the product serves or sends to the model carries evidence or
> authority it did not actually derive — and every served response still
> passes the fail-closed gate.

Both halves are load-bearing, and each has already caught a defect in this
spec. The honesty half killed the kind-filter in §3 (it left the content-free
labels in the prompt). The fail-closed half killed the original §2 (two
untaught top-level keys would have made `assertPassesContractGate` throw on
every response). Check each change against both halves before implementing it.

## Scope

**In (Plan 1):**
- Retry on JSON parse failure only, via a `maxAttempts` contract amendment.
- Operator channel: `modelExecutionState` on the MCP payload, boot-time config
  warnings, a `check:model-lane` npm script, `.env.example` documentation, and
  operator-facing log lines.
- Grounding honesty: the `evidenceSummaries` key is removed from the model
  prompt entirely. Plan 2 reintroduces it once retrieval produces summaries
  with real derived content.
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

**Why this is not a new disclosure class.** The HTTP adapter already serves the
entire `DesignArtifactEnvelope`, `modelExecution` included — pinned by
`expect(httpEnvelope).toEqual(httpProduced)` in
`src/create-ui-spec-http.test.ts:456`. Projecting a bare state enum over MCP
publishes strictly less than what one transport already publishes today. The
secrecy invariant worth keeping is "no raw provider data on the wire" (key,
URL, response bytes, provider request id), and the enum carries none of it.

**Payload projection — this is a SHARED CONTRACT change, not an adapter edit.**
The result envelope is built by `makeEnvelope` (`src/tool-contracts.ts:2364`),
which is `.strict()` over a fixed key set and generic across every tool in
`TOOL_CATALOG`. `assertPassesContractGate` runs `parseToolResult` on BOTH the
success and error branches before serving, and refuses rather than serves. An
untaught top-level key therefore does not degrade — it throws, on every
response. The adapter's own header comment names this: the envelope's
`.strict()` shape is what "stops this adapter introducing an untaught
top-level field."

- **`proposalOnly` is cut.** It was defined as exactly
  `envelope.spec.modelProposal !== undefined`, and `data.modelProposal` is
  already on the wire — the flag costs a shared-contract amendment and carries
  no signal a client cannot already compute. The client-side hard-reject rule
  is documented against `data.modelProposal` instead.
- Add ONE optional descriptor flag to `ToolDescriptor`
  (`src/tool-contracts.ts:1497`), following the `allowNoneWithPositiveResult?`
  precedent — omitted or `false` preserves every other tool's contract exactly:

  ```ts
  /**
   * Tools whose result may carry a model-execution state. Set ONLY for a tool
   * with a model lane. Omitted (or false) keeps the original key set.
   */
  readonly hasModelExecutionState?: boolean;
  ```

- In `makeEnvelope`, mirror the existing conditional-key idiom one line below
  `evidence`:

  ```ts
  modelExecutionState: desc.hasModelExecutionState
    ? ModelExecutionStateSchema.nullable()
    : z.never().optional(),
  ```

  where `ModelExecutionStateSchema` is the enum
  `invalid-configuration | call-failed | proposal-rejected |
  persistence-failed | succeeded`. `null` means no model configured.
- Set `hasModelExecutionState: true` on the `create_ui_spec` descriptor only.
- The key is present on BOTH branches, like `data`. On the error branch it is
  `null` (the request failed before any model ran), which keeps one key set
  across branches and avoids a second conditional in the error envelope.
- The leaf gate is unaffected: it walks `data` / `referenceIds` / `evidence`
  only, and this is a top-level key outside all three. No new leaf
  classification is required — which is the reason to project it at top level
  rather than inside `data`, where a string token WOULD need one.
- `modelExecution` itself remains unprojected.

**Three test sites, not one** (the pinned test's own comment says the key set
and the parity suite must change together with it):

1. `src/create-ui-spec-mcp.test.ts:452` — add `"modelExecutionState"` to
   `ENVELOPE_KEYS`. It is asserted for the success envelope at :590 (filtered
   for `error`) and for the error envelope at :905; both follow from the
   constant.
2. `src/create-ui-spec-mcp.test.ts:595-615` — the "deliberately does not
   project the execution state" test. Its assertion becomes: states are
   distinguishable via `modelExecutionState`, `modelExecution` stays
   `undefined`, and no raw provider data appears. Rewrite the comment too; it
   currently documents the opposite decision.
3. `src/create-ui-spec-http.test.ts:430` — the injected-model-outcome secrecy
   and parity suite already enumerates all six states. Add
   `modelExecutionState === fixture.expectedExecution` to the MCP side and
   keep the existing leak-marker sweep unchanged, so the enum is proven to
   travel without dragging provider data with it.

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

**`check:model-lane` npm script (new) — operator-side, not caller-side:**
- The premise of this whole section is that the operator and the MCP caller are
  different people. A health check registered as an MCP tool sits on the
  caller's side of that boundary and hands an untrusted client a probe of the
  operator's provider. It is a script.
- New `scripts/check-model-lane.mjs`, wired as `"check:model-lane"` in
  `package.json`. Resolves config through the same
  `create-ui-spec-model-config.ts` path the server uses, so the script cannot
  pass while the server's resolution fails.
- Not configured → prints `configured: false`, exits 0.
- Configured → ONE tiny call through the exact pinned runtime
  (`maxOutputTokens: 16`, `maxAttempts: 1`, `temperature: 0`, prompt
  `"Reply with the single word: ok"`), prints
  `{ configured, provider, model, resolvedModelId, reachable, error? }`, and
  exits non-zero when `reachable` is false so CI or a boot script can gate on
  it. `resolvedModelId` comes from the call metadata and is what catches the
  alias-vs-dated-ID class; `error` is a safe message (no key, no URL, no raw
  body).
- Cost is roughly $0.001 per invocation. Both config bugs in the Context
  section would have been caught by it.

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

**`src/create-ui-spec-model.ts` `buildPrompt` — remove the key, do not filter
it.**

An earlier draft of this section filtered `sanitizedEvidence` by `kind`,
keeping `corpus-observation` and `public-reference` and dropping
`recipe-system`. That does not fix the failure in Context §3: the harmful
strings ARE `corpus-observation` rows, so they survive a kind filter. It also
leaves a dead branch — "omit the key when the filtered list is empty" never
fires, because retrieval returned 5 observations on all 10 measured briefs.
The filtered version would have shipped green while changing nothing the
Context section complains about.

- Delete the `evidenceSummaries` key from `buildPrompt`
  (`src/create-ui-spec-model.ts:244`). Not conditionally — the key does not
  appear in the prompt at all in Plan 1.
- Rationale: today every value that key can hold is either a recipe stub or a
  pattern label with a region count. Neither is evidence. Sending nothing is
  honest; sending a label the model will treat as a brief is not.
- Plan 2 reintroduces the key once auto-retrieval produces summaries with real
  derived content, and re-adds a non-empty guard at that point — where the
  guard has a live path to protect.
- The deterministic envelope and its served spec are unchanged; the recipe and
  observation rows remain in the fallback body and in `evidence[]` (Plan 2's
  domain).

**Success criterion (measured, not CI):** re-run the `"Make it better."` brief
against the real corpus. The proposal must stop describing an editor canvas
and a marketing hero — the invention traceable to the retrieved labels — and
the prompt must contain none of the `"<pattern> reference with <n> regions"`
strings. This is a behavioral check; the unit test below pins the prompt shape
only.

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

**Success criteria (measured, not CI):** re-run the same 10-brief probe that
produced the baseline, not a 3-brief subset — a 3-brief median is too noisy to
read a ~10% shift, and the baseline itself came from 8 accepted proposals.
Target: median `designDirection` ≤ ~1,000 chars against the measured baseline
median of **1,272** (NOT ≈1,600, which was one reviewer's smaller sample), max
≤ ~1,400 against a baseline max of 1,789, and zero accept-rate regression —
every response parses and validates, and the hard-limits consistency
assertions still hold.

## Data flow

```
create_ui_spec call
  → resolve config (warnings at boot)
  → resolveEvidence (unchanged; recipe rows stay in the deterministic body)
  → createUiSpecModel (loop ≤ maxAttempts; retry only on JSON.parse failure)
      → buildPrompt (no evidenceSummaries key; concise instruction; v5)
      → runtime.call (HTTP maxAttempts 1 per generation)
      → accept | fallback
  → envelope + payload projection (modelExecutionState; null when no model ran)
  → log line on non-success
```

## Error handling

- Parse failure with attempts remaining → second generation, identical prompt.
- Parse failure on final attempt → `proposal-rejected` fallback (unchanged
  shape), `modelExecutionState: "proposal-rejected"` on the wire.
- All other rejections → single attempt, same states as today.
- **Both attempts fail → `proposal-rejected`, and NO artifact record is
  written.** An earlier revision of this section promised `attempts: 2` plus
  summed usage on this path. That was wrong and is corrected here: `fallback()`
  returns `{ kind: "fallback", execution }` with no `recordInput`, and the
  store is written only on the accepted branch — so on double failure the
  billed tokens go unrecorded, exactly as a single-attempt rejection's do
  today. Persisting a usage-only record would be a
  `ModelArtifactRecordSchema` change (every field except `usage`/`attempts`
  describes an ACCEPTED proposal) and is out of scope. This is a known,
  accepted audit gap; retry widens it by at most one discarded generation.
- Accepted after retry → the record carries `attempts: 2`, usage SUMMED across
  both generations (the discarded attempt was billed), and wall-clock
  `latencyMs` across attempts. Summed usage applies only here, because this is
  the only branch that writes a record.
- `check:model-lane` → never throws; prints structured status with a safe
  message; exit code non-zero on `reachable: false`.
- Boot warnings → advisory; no startup failure for valid-but-odd proxies.
- Error-branch responses (`INVALID_INPUT` and friends) →
  `modelExecutionState: null`; no model ran.

## Testing

Each change is TDD with a failing test first:

1. **Retry:** fake runtime returning malformed JSON then a valid proposal →
   accepted, exactly 2 calls, record `attempts: 2`, SUMMED usage across both
   calls, total latency. Malformed twice → fallback, 2 calls, summed usage.
   `maxAttempts: 1` → no retry. Valid JSON with schema rejection → 1 call.
   `runtime.call` throw → `call-failed`, 1 call. Contract tests for the `1 | 2`
   unions.
2. **Payload projection:** `modelExecutionState` correct for each of the five
   states; `null` when no model is configured AND on the error branch;
   `modelExecution` still undefined; contract-gate passes on both branches.
   Add a NEGATIVE test: a payload carrying an unknown top-level key is refused
   by the gate — this is the property that made the original draft of §2
   unshippable, and it should be pinned rather than assumed.
3. **Envelope key set:** `ENVELOPE_KEYS` includes `modelExecutionState`;
   every other tool's envelope does NOT (the descriptor flag is
   `create_ui_spec`-only). This is the test that proves the shared contract
   was widened for one tool and not for all of them.
4. **`check:model-lane`:** not configured → `configured: false`, exit 0;
   configured-success (fake runtime records the tiny call params);
   configured-throw → `reachable: false`, non-zero exit.
5. **Config warnings:** claude base URL without `/v1/messages` warns; dated-ID
   model name does not warn; non-claude providers do not warn.
6. **Grounding:** the prompt contains no `evidenceSummaries` key at all — for a
   no-reference request AND for a request with resolved references (Plan 1
   removes the key unconditionally). Assert absence of the
   `"<pattern> reference with <n> regions"` shape and of the recipe stub
   string.
7. **Conciseness:** prompt boundary tests assert `c3-model-proposal-v5` and the
   new instruction; `not.toContain("c3-model-proposal-v4")`.

Update the pinned tests listed in §2. **The dogfood script needs less than it
looks like:** `scripts/dogfood-createuispec.mjs` drives the HTTP route, asserts
private-marker absence and artifact-store behavior, and pins only RELATIVE
hashes (`baseSemantic` computed at runtime, `first.semanticSpecSha256 ===
second.semanticSpecSha256`). It asserts neither `attempts` nor the MCP envelope
key set, and the `POLICY_VERSION` bump does not break it because no absolute
prompt hash is pinned. One genuine addition: it already has a
malformed-response case (line 571) that asserts the scaffold is unchanged —
add a `maxAttempts: 2` variant so the retry path gets dogfood coverage, since
the operator-facing resolver keeps `maxAttempts: 1` and nothing else would
exercise it end-to-end.

Verification: `npx tsc --noEmit`, full `vitest` suite,
`node scripts/dogfood-createuispec.mjs` (no npm alias exists; invoke the script
directly), then `npm run check:model-lane` against the real `.env`, the live
3-brief conciseness campaign, and the `"Make it better."` grounding re-run
from §3.

## Non-goals

- Deterministic body content (Plan 2).
- Auto-retrieval / brief-similarity grounding (Plan 2).
- Corpus provenance governance, coarse `design_solution` tool, learning loop
  (separate future plans).
