# Model-Lane Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the `create_ui_spec` model lane observable, retry-recoverable, honest about grounding, and measurably more concise.

**Architecture:** Four changes in one code path: (1) `maxAttempts` becomes `1 | 2` and `createUiSpecModel` retries only JSON-parse failures; (2) the shared result envelope gains a conditional `modelExecutionState` key (one descriptor flag, one tool) plus an operator channel (boot warnings, `check:model-lane` script, `.env.example`, logs); (3) the model prompt stops carrying the `evidenceSummaries` key entirely; (4) the prompt is tightened and `POLICY_VERSION` bumps to v5.

**Tech Stack:** TypeScript, Zod, Vitest, node:http (dogfood), MCP SDK.

## Global Constraints

- Governing invariant (from the spec): "Nothing the product serves or sends to the model carries evidence or authority it did not actually derive — and every served response still passes the fail-closed gate." Check every change against both halves.
- Retry is parse-failure-only. Schema rejections, byte-limit hits, private-marker hits, and `runtime.call` throws never retry.
- Each generation runs at HTTP-level `maxAttempts: 1`; the two retry domains must not tangle.
- The MCP payload gains exactly ONE new top-level key (`modelExecutionState`); `modelExecution` itself stays unprojected; no raw provider data on the wire.
- `maxAttempts` default is `1`. The operator opt-in is `CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS=2` (absent or `"1"` keeps `1`; any other value is `invalid-configuration`).
- The `evidenceSummaries` key is removed from the prompt UNCONDITIONALLY in this plan (Plan 2 reintroduces it with a non-empty guard).
- `POLICY_VERSION` bumps exactly once: `c3-model-proposal-v4` → `c3-model-proposal-v5`.
- All served responses must still pass `assertPassesContractGate`; an unknown top-level key on any tool's envelope is refused (that property must be pinned, not assumed).
- Every task is TDD: failing test → minimal implementation → passing test → commit.

## Task 1: Retry on parse failure — contracts, loop, operator opt-in

**Files:**
- Modify: `src/create-ui-spec-model-contracts.ts:70` and `:124`
- Modify: `src/create-ui-spec-model.ts:60` and `:114-196`
- Modify: `src/create-ui-spec-model-config.ts` (parameters construction)
- Test: `src/create-ui-spec-model-contracts.test.ts` (new describe)
- Test: `src/create-ui-spec-model.test.ts` (new describe)
- Test: `src/create-ui-spec-model-config.test.ts` (new it)

**Interfaces:**
- Consumes: `ModelGenerationParametersSchema` (existing callers), `ModelRecordInput` (`src/create-ui-spec-model.ts:47-62`), `runtime.call` (existing shape).
- Produces: `ModelGenerationParameters.maxAttempts: 1 | 2`; `ModelArtifactRecord.attempts: 1 | 2`; `ModelRecordInput.attempts: 1 | 2`; `createUiSpecModel` retry loop with `attempts`, summed `usage`, and wall-clock `latencyMs` on the record; resolver env opt-in `CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS`.

- [ ] **Step 1: Write the failing contract test**

Append to `src/create-ui-spec-model-contracts.test.ts`:

```ts
describe("generation parameter contract — maxAttempts 1|2", () => {
  it("accepts maxAttempts 2", () => {
    const parsed = ModelGenerationParametersSchema.parse({
      temperature: 0,
      maxOutputTokens: 4096,
      maxAttempts: 2,
      seed: null,
    });
    expect(parsed.maxAttempts).toBe(2);
  });

  it("still accepts maxAttempts 1", () => {
    expect(ModelGenerationParametersSchema.parse({
      temperature: 0, maxOutputTokens: 4096, maxAttempts: 1, seed: null,
    }).maxAttempts).toBe(1);
  });
});
```

And a record test: `ModelArtifactRecordSchema` accepts a valid record whose `attempts` is `2` (copy an existing valid record fixture from the same file and set `attempts: 2`; if no fixture exists, build a minimal valid record via the schema's own field list at `src/create-ui-spec-model-contracts.ts:98-125`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/create-ui-spec-model-contracts.test.ts`
Expected: FAIL — `maxAttempts: 2` rejected (literal `1`) and the `attempts: 2` record rejected.

- [ ] **Step 3: Implement the unions**

In `src/create-ui-spec-model-contracts.ts`:

```ts
  maxAttempts: z.union([z.literal(1), z.literal(2)]),
```

and:

```ts
  attempts: z.union([z.literal(1), z.literal(2)]),
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/create-ui-spec-model-contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing retry test**

Append to `src/create-ui-spec-model.test.ts`:

```ts
describe("createUiSpecModel parse-failure retry", () => {
  const RETRY_PARAMS = ModelGenerationParametersSchema.parse({
    temperature: 0,
    maxOutputTokens: 4096,
    maxAttempts: 2,
    seed: null,
  });

  function retryRuntime(): CreateUiSpecModelRuntime & { call: ReturnType<typeof vi.fn> } {
    return { ...buildRuntime(), parameters: RETRY_PARAMS };
  }

  it("retries once on JSON.parse failure and records the second attempt", async () => {
    const runtime = retryRuntime();
    let calls = 0;
    runtime.call.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return {
        content: "{not valid json",
        provider: "openai",
        model: "gpt-5-mini",
        usage: { promptTokens: 100, completionTokens: 10, raw: { prompt_tokens: 100, completion_tokens: 10 } },
        attempts: 1,
        latencyMs: 400,
        providerRequestId: "req_1",
      };
      return {
        content: JSON.stringify(buildProposal()),
        provider: "openai",
        model: "gpt-5-mini",
        usage: { promptTokens: 123, completionTokens: 45, raw: { prompt_tokens: 123, completion_tokens: 45 } },
        attempts: 1,
        latencyMs: 789,
        providerRequestId: "req_2",
      };
    });

    const result = await createUiSpecModel(buildInput(), runtime);

    expect(result.kind).toBe("accepted");
    expect(calls).toBe(2);
    if (result.kind !== "accepted") return;
    expect(result.recordInput.attempts).toBe(2);
    expect(result.recordInput.usage).toEqual({ promptTokens: 223, completionTokens: 55 });
    expect(result.recordInput.latencyMs).toBe(1189);
    // Identical prompt on both generations; HTTP retry stays pinned to 1.
    expect(runtime.call.mock.calls[0]![0].prompt).toBe(runtime.call.mock.calls[1]![0].prompt);
    expect(runtime.call.mock.calls[0]![0].maxAttempts).toBe(1);
    expect(runtime.call.mock.calls[1]![0].maxAttempts).toBe(1);
  });
});
```

- [ ] **Step 6: Run to verify it fails**

Run: `npx vitest run src/create-ui-spec-model.test.ts -t "retries once"`
Expected: FAIL — exactly one call happens; the result is `proposal-rejected`.

- [ ] **Step 7: Implement the retry loop**

Replace the body of `createUiSpecModel` from the `let modelResult` declaration through the accepted return (`src/create-ui-spec-model.ts:114-195`) with:

```ts
  // Parse-failure retry, and nothing else. JSON.parse failures of the
  // UNWRAPPED content are the measured recoverable class (malformed JSON);
  // schema rejections, byte-limit hits, private-marker hits, and call errors
  // are single-attempt, exactly as before. Each generation runs at
  // HTTP-level maxAttempts 1 so the two retry domains do not tangle.
  let attempts = 0;
  let totalLatencyMs = 0;
  let usageAccum: ModelRecordInput["usage"] | null = null;

  for (let generation = 1; generation <= parameters.maxAttempts; generation++) {
    attempts = generation;

    let modelResult: ModelCallResult;
    try {
      modelResult = await runtime.call({
        prompt,
        endpoint,
        maxOutputTokens: parameters.maxOutputTokens,
        maxAttempts: 1,
        temperature: parameters.temperature,
      });
    } catch {
      return fallback("call-failed");
    }

    if (
      modelResult.provider !== endpoint.provider
      || modelResult.model !== endpoint.model
      || modelResult.attempts !== 1
      || !Number.isInteger(modelResult.latencyMs)
      || modelResult.latencyMs < 0
    ) {
      return fallback("call-failed");
    }

    totalLatencyMs += modelResult.latencyMs;

    const generationUsage = normalizeUsage(modelResult.usage);
    if (!generationUsage) {
      return fallback("call-failed");
    }
    // Summed across generations: the discarded attempt's tokens were billed,
    // and a lane whose purpose is auditability must not drop them.
    usageAccum = {
      promptTokens: (usageAccum?.promptTokens ?? 0) + generationUsage.promptTokens,
      completionTokens: (usageAccum?.completionTokens ?? 0) + generationUsage.completionTokens,
    };

    if (byteLength(modelResult.content) > MAX_MODEL_TEXT_BYTES) {
      return fallback("proposal-rejected");
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(unwrapExactCodeFence(modelResult.content.trim()));
    } catch {
      // The ONLY retryable failure class: structurally invalid JSON.
      if (generation < parameters.maxAttempts) continue;
      return fallback("proposal-rejected");
    }

    const proposalParsed = ModelProposalSchema.safeParse(parsedJson);
    if (!proposalParsed.success) {
      return fallback("proposal-rejected");
    }

    const proposal = ModelProposalSchema.parse({
      ...proposalParsed.data,
      status: "proposal-only",
      disclaimer: FIXED_DISCLAIMER,
    });
    if (containsPrivateMarkerDeep(proposal)) {
      return fallback("proposal-rejected");
    }

    const proposalSha256 = sha256Hex(
      Buffer.from(canonicalJsonStringify(proposal), "utf-8"),
    );

    return {
      kind: "accepted",
      proposal,
      execution: ModelExecutionSchema.parse({
        state: "succeeded",
        provider: endpoint.provider,
        model: endpoint.model,
        promptSha256,
        parametersSha256,
        reproducibility: "conditional",
      }),
      recordInput: {
        proposalSha256,
        promptSha256,
        parametersSha256,
        proposal,
        provider: endpoint.provider,
        model: endpoint.model,
        endpointOrigin: new URL(endpoint.baseUrl).origin,
        parameters,
        usage: usageAccum!,
        attempts,
        latencyMs: totalLatencyMs,
      },
    };
  }

  // Unreachable: maxAttempts is always >= 1 and every iteration returns or
  // continues. Kept so the function's return type is total without a cast.
  return fallback("proposal-rejected");
```

- [ ] **Step 8: Run to verify it passes**

Run: `npx vitest run src/create-ui-spec-model.test.ts -t "retries once"`
Expected: PASS.

- [ ] **Step 9: Add the negative retry tests**

Append to the same describe block:

```ts
  it("does not retry when the final parse attempt also fails", async () => {
    const runtime = retryRuntime();
    runtime.call.mockImplementation(async () => ({
      content: "{still not json",
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 100, completionTokens: 10, raw: { prompt_tokens: 100, completion_tokens: 10 } },
      attempts: 1,
      latencyMs: 400,
      providerRequestId: "req_x",
    }));
    const result = await createUiSpecModel(buildInput(), runtime);
    expect(result).toEqual({ kind: "fallback", execution: { state: "proposal-rejected" } });
    expect(runtime.call).toHaveBeenCalledTimes(2);
  });

  it("does not retry when maxAttempts is 1", async () => {
    const runtime = buildRuntime();
    runtime.call.mockImplementation(async () => ({
      content: "{not json",
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 100, completionTokens: 10, raw: { prompt_tokens: 100, completion_tokens: 10 } },
      attempts: 1,
      latencyMs: 400,
      providerRequestId: "req_x",
    }));
    const result = await createUiSpecModel(buildInput(), runtime);
    expect(result).toEqual({ kind: "fallback", execution: { state: "proposal-rejected" } });
    expect(runtime.call).toHaveBeenCalledTimes(1);
  });

  it("does not retry schema rejections or call errors", async () => {
    const runtime = retryRuntime();
    runtime.call.mockImplementation(async () => ({
      content: JSON.stringify({ ...buildProposal(), designDirection: 42 }),
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 100, completionTokens: 10, raw: { prompt_tokens: 100, completion_tokens: 10 } },
      attempts: 1,
      latencyMs: 400,
      providerRequestId: "req_x",
    }));
    const schemaRejected = await createUiSpecModel(buildInput(), runtime);
    expect(schemaRejected).toEqual({ kind: "fallback", execution: { state: "proposal-rejected" } });
    expect(runtime.call).toHaveBeenCalledTimes(1);

    runtime.call.mockReset();
    runtime.call.mockImplementation(async () => {
      throw new Error("provider down");
    });
    const callFailed = await createUiSpecModel(buildInput(), runtime);
    expect(callFailed).toEqual({ kind: "fallback", execution: { state: "call-failed" } });
    expect(runtime.call).toHaveBeenCalledTimes(1);
  });

  it("does not retry byte-limit hits or private-marker hits at maxAttempts 2", async () => {
    // MAX_MODEL_TEXT_BYTES is 32 * 1024 (internal, src/create-ui-spec-model.ts:23);
    // the byte-limit check runs BEFORE JSON.parse, so it must never continue
    // the retry loop. Private markers are checked after a successful parse and
    // are also single-attempt (mirror the marker fixture from the existing
    // "rejects private markers anywhere" test at :486).
    const byteRuntime = retryRuntime();
    byteRuntime.call.mockImplementation(async () => ({
      content: "x".repeat(32 * 1024 + 1),
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 100, completionTokens: 10, raw: { prompt_tokens: 100, completion_tokens: 10 } },
      attempts: 1,
      latencyMs: 400,
      providerRequestId: "req_x",
    }));
    const byteRejected = await createUiSpecModel(buildInput(), byteRuntime);
    expect(byteRejected).toEqual({ kind: "fallback", execution: { state: "proposal-rejected" } });
    expect(byteRuntime.call).toHaveBeenCalledTimes(1);

    const markerRuntime = retryRuntime();
    markerRuntime.call.mockImplementation(async () => ({
      content: JSON.stringify({
        ...buildProposal(),
        designDirection: "Contains " + PRIVATE_MARKER_FIXTURE, // see :486 fixture
      }),
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 100, completionTokens: 10, raw: { prompt_tokens: 100, completion_tokens: 10 } },
      attempts: 1,
      latencyMs: 400,
      providerRequestId: "req_x",
    }));
    const markerRejected = await createUiSpecModel(buildInput(), markerRuntime);
    expect(markerRejected).toEqual({ kind: "fallback", execution: { state: "proposal-rejected" } });
    expect(markerRuntime.call).toHaveBeenCalledTimes(1);
  });
```

- [ ] **Step 10: Run the full model test files**

Run: `npx vitest run src/create-ui-spec-model.test.ts src/create-ui-spec-model-path.test.ts src/create-ui-spec-model-contracts.test.ts`
Expected: PASS (all existing tests plus the new ones).

- [ ] **Step 11: Write the failing resolver opt-in test**

Append to `src/create-ui-spec-model-config.test.ts`:

```ts
it("opts into two generation attempts via CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS=2", () => {
  const env = {
    CREATE_UI_SPEC_MODEL_PROVIDER: "openai",
    CREATE_UI_SPEC_MODEL_BASE_URL: "https://api.openai.com/v1",
    CREATE_UI_SPEC_MODEL_API_KEY: "sk-test",
    CREATE_UI_SPEC_MODEL_NAME: "gpt-test",
    CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS: "2",
  };
  const cfg = resolveCreateUiSpecModelConfig(env);
  expect(cfg.kind).toBe("configured");
  if (cfg.kind === "configured") expect(cfg.runtime.parameters.maxAttempts).toBe(2);
});

it("rejects an invalid maxAttempts value as invalid-configuration", () => {
  const env = {
    CREATE_UI_SPEC_MODEL_PROVIDER: "openai",
    CREATE_UI_SPEC_MODEL_BASE_URL: "https://api.openai.com/v1",
    CREATE_UI_SPEC_MODEL_API_KEY: "sk-test",
    CREATE_UI_SPEC_MODEL_NAME: "gpt-test",
    CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS: "3",
  };
  expect(resolveCreateUiSpecModelConfig(env).kind).toBe("invalid-configuration");
});
```

- [ ] **Step 12: Run to verify it fails**

Run: `npx vitest run src/create-ui-spec-model-config.test.ts -t "MAX_ATTEMPTS"`
Expected: FAIL — the resolver ignores the extra env key, so `maxAttempts` is `1` and `"3"` still resolves `configured`.

- [ ] **Step 13: Implement the opt-in in the resolver**

In `src/create-ui-spec-model-config.ts`, after the raw-tuple checks and before the endpoint parse, add:

```ts
  // Operator opt-in for parse-failure retry. Absent or "1" keeps the
  // single-attempt default; "2" enables one retry on JSON.parse failure. Any
  // other value is a misconfiguration and must not silently degrade.
  const maxAttemptsRaw = env.CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS ?? "1";
  if (maxAttemptsRaw !== "1" && maxAttemptsRaw !== "2") {
    return { kind: "invalid-configuration" };
  }
  const maxAttempts = maxAttemptsRaw === "2" ? 2 : 1;
```

and change the parameters construction to:

```ts
      parameters: ModelGenerationParametersSchema.parse({
        temperature: 0,
        maxOutputTokens: 4_096,
        maxAttempts,
        seed: null,
      }),
```

- [ ] **Step 14: Run to verify it passes**

Run: `npx vitest run src/create-ui-spec-model-config.test.ts`
Expected: PASS.

- [ ] **Step 15: Commit**

```bash
git add src/create-ui-spec-model-contracts.ts src/create-ui-spec-model.ts src/create-ui-spec-model-config.ts src/create-ui-spec-model-contracts.test.ts src/create-ui-spec-model.test.ts src/create-ui-spec-model-config.test.ts
git commit -m "feat(model-lane): retry JSON.parse failures via maxAttempts 1|2

maxAttempts becomes 1|2 in the generation-parameter and artifact-record
contracts; createUiSpecModel retries ONLY JSON.parse failures with the
identical prompt, at HTTP-level maxAttempts 1 per generation, and records
the actual attempt count with summed usage and wall-clock latency. The
operator opts in via CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS=2; anything else is
invalid-configuration."
```

## Task 2: `modelExecutionState` — shared contract + adapter projection

**Files:**
- Modify: `src/tool-contracts.ts` (shared building blocks, `ToolDescriptor`, `makeEnvelope`, `create_ui_spec` descriptor)
- Modify: `src/create-ui-spec-mcp.ts` (success payload + `errorResult`)
- Test: `src/create-ui-spec-mcp.test.ts` (`ENVELOPE_KEYS`, pinned projection test, new negative gate test)
- Test: `src/create-ui-spec-http.test.ts` (parity suite)
- Test: `src/tool-contracts.test.ts` (enum-sync test)

**Interfaces:**
- Consumes: `DesignArtifactEnvelope.modelExecution` (existing), `ToolDescriptor` (existing), `parseToolResult` (existing export).
- Produces: `ModelExecutionStateSchema` (exported from `tool-contracts.ts`); `ToolDescriptor.hasModelExecutionState?: boolean`; `makeEnvelope` conditional key `modelExecutionState`; adapter field on success (`envelope.modelExecution?.state ?? null`) and error (`null`) branches.

- [ ] **Step 1: Write the failing projection test**

Update the pinned test at `src/create-ui-spec-mcp.test.ts:595` — rename it and change its assertions:

```ts
  it("projects modelExecutionState and nothing else over MCP", async () => {
    const fixture = modelFixture("succeeded");
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    const result = await handleCreateUiSpec(
      validArgs(),
      makeReader(corpus, corpus),
      undefined,
      fixture.dependency,
    );
    expect(spyState.produced[0]!.envelope.modelExecution?.state).toBe("succeeded");
    expect((result.structuredContent.data as { modelProposal?: unknown }).modelProposal).toBeDefined();
    expect((result.structuredContent as Record<string, unknown>).modelExecutionState).toBe("succeeded");
    expect((result.structuredContent as Record<string, unknown>).modelExecution).toBeUndefined();
  });
```

Run: `npx vitest run src/create-ui-spec-mcp.test.ts -t "projects modelExecutionState"`
Expected: FAIL — `modelExecutionState` is `undefined`.

- [ ] **Step 2: Add the state enum to the shared building blocks**

In `src/tool-contracts.ts`, in the "1. Shared Zod building blocks" section, after `RetrievalState`, add:

```ts
/**
 * The safe public model-execution states a model-lane tool may project.
 * Mirrors the `state` discriminants of ModelExecutionSchema in
 * create-ui-spec-model-contracts.ts; a sync test in tool-contracts.test.ts
 * pins the two enums to the same member set. `null` means "no model ran".
 * No provider data (key, URL, response bytes, request id) is representable.
 */
export const ModelExecutionStateSchema = z.enum([
  "invalid-configuration",
  "call-failed",
  "proposal-rejected",
  "persistence-failed",
  "succeeded",
]);
```

- [ ] **Step 3: Add the descriptor flag**

In `ToolDescriptor` (`src/tool-contracts.ts:1497`), directly after `allowNoneWithPositiveResult`:

```ts
  /**
   * Tools whose result may carry a model-execution state. Set ONLY for a tool
   * with a model lane. Omitted (or false) keeps the original key set exactly.
   */
  readonly hasModelExecutionState?: boolean;
```

- [ ] **Step 4: Add the conditional key in `makeEnvelope`**

In `makeEnvelope` (`src/tool-contracts.ts:2363`), immediately after the `evidence` line:

```ts
    modelExecutionState: desc.hasModelExecutionState
      ? ModelExecutionStateSchema.nullable()
      : z.never().optional(),
```

- [ ] **Step 5: Set the flag on the `create_ui_spec` descriptor only**

In the `create_ui_spec` descriptor (`src/tool-contracts.ts:1835`), after `allowNoneWithPositiveResult: true`:

```ts
    // The model lane projects its safe execution state; no other tool does.
    hasModelExecutionState: true,
```

- [ ] **Step 6: Project the field in the adapter**

In `src/create-ui-spec-mcp.ts`, in the success payload (between `data` and `referenceIds`):

```ts
    // Safe execution-state enum (or null when no model ran). The full
    // envelope — modelExecution included — is already served by the HTTP
    // adapter, so this projects strictly less than another transport
    // publishes; the secrecy invariant kept here is "no raw provider data".
    modelExecutionState: produced.envelope.modelExecution?.state ?? null,
```

In `errorResult`, after `status: "error"`:

```ts
    // No model ran on a failed request; the key stays present on both
    // branches so the envelope key set is branch-independent.
    modelExecutionState: null,
```

- [ ] **Step 7: Update the key-set tests**

In `src/create-ui-spec-mcp.test.ts`, add `"modelExecutionState"` to `ENVELOPE_KEYS` and re-run:

Run: `npx vitest run src/create-ui-spec-mcp.test.ts`
Expected: PASS — the success-key-set test and the error-key-set test both follow from the constant.

Add the explicit error-branch VALUE assertion next to the error-key-set test (the key-set test proves presence; this proves the value is `null` — no model ran):

```ts
  it("projects modelExecutionState null on the error branch", async () => {
    const result = await handleCreateUiSpec(
      { ...validArgs(), productContext: "bad" }, // fails CreateUiSpecInput validation
      makeReader([], []),
    );
    expect((result.structuredContent as Record<string, unknown>).modelExecutionState).toBeNull();
    expect((result.structuredContent as Record<string, unknown>).status).toBe("error");
  });
```

- [ ] **Step 8: Write the negative gate test (regression pin)**

Append to the success-path describe in `src/create-ui-spec-mcp.test.ts`:

```ts
  it("refuses an unknown top-level key through the shared gate", async () => {
    const result = await call();
    const payload = { ...(result.structuredContent as Record<string, unknown>), unknownKey: "x" };
    const gate = parseToolResult(payload);
    expect(gate.ok).toBe(false);
  });

  it("refuses modelExecutionState on tools without the descriptor flag", async () => {
    // critique_ui has hasEvidence but no model lane; its envelope's
    // modelExecutionState slot is z.never().optional(), so the key must be
    // refused, not ignored. Uses the existing makeValidSuccess("critique_ui")
    // fixture in tool-contracts.test.ts (clone, inject, expect fail).
    const other = cloneToolResult(makeValidSuccess("critique_ui")) as Record<string, unknown>;
    const payload = { ...other, modelExecutionState: "succeeded" };
    const gate = parseToolResult(payload);
    expect(gate.ok).toBe(false);
  });
```

`parseToolResult` is already exported from `tool-contracts.js`; add it to the test file's imports if not present.
`cloneToolResult` and `makeValidSuccess` live in `src/tool-contracts.test.ts` (used at :720, :900-915) — import them from the test-file-local helpers, or replicate the fixture via `parseDesignArtifactEnvelope`-style construction if this test lands in a different file.

Run: `npx vitest run src/create-ui-spec-mcp.test.ts -t "unknown top-level key"`
Expected: PASS immediately — this pins the fail-closed property that made the original draft of this section unshippable.

- [ ] **Step 9: Extend the HTTP/MCP parity suite**

In `src/create-ui-spec-http.test.ts` (the `it.each(states)` secrecy/parity test), after the `expect((mcp.structuredContent as { data: unknown }).data).toEqual(httpEnvelope.spec);` assertion, add:

```ts
    expect((mcp.structuredContent as { modelExecutionState?: string | null }).modelExecutionState)
      .toBe(fixture.expectedExecution ?? null);
```

The `?? null` matters: for the `not-configured` fixture `expectedExecution` is `undefined` (no `modelExecution` on the envelope), while the projected field is `null` by design — the projection is `envelope.modelExecution?.state ?? null`.

- [ ] **Step 10: Add the enum-sync test**

In `src/tool-contracts.test.ts`, add:

```ts
it("ModelExecutionStateSchema matches the model contracts' states", async () => {
  const { ModelExecutionSchema } = await import("./create-ui-spec-model-contracts.js");
  const modelStates = new Set(
    ModelExecutionSchema.options.map((o) => (o.shape as { state: { value: string } }).state.value),
  );
  const sharedStates = new Set(ModelExecutionStateSchema.options);
  expect(sharedStates).toEqual(modelStates);
});
```

- [ ] **Step 11: Run the affected suites**

Run: `npx vitest run src/create-ui-spec-mcp.test.ts src/create-ui-spec-http.test.ts src/tool-contracts.test.ts`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add src/tool-contracts.ts src/create-ui-spec-mcp.ts src/create-ui-spec-mcp.test.ts src/create-ui-spec-http.test.ts src/tool-contracts.test.ts
git commit -m "feat(model-lane): project modelExecutionState on the shared envelope

ToolDescriptor gains hasModelExecutionState (create_ui_spec only);
makeEnvelope adds the conditional modelExecutionState key (enum or null)
so the MCP payload is distinguishable per state while modelExecution stays
unprojected and the fail-closed gate still refuses any unknown key."
```

## Task 3: Operator channel — boot warnings, check script, env docs, logs

**Files:**
- Modify: `src/create-ui-spec-model-config.ts` (warnings)
- Create: `src/model-lane-check.ts` + `src/model-lane-check.test.ts`
- Create: `scripts/check-model-lane.mjs`
- Modify: `package.json` (script)
- Modify: `.env.example`
- Modify: `src/create-ui-spec.ts` (invalid-configuration log), `src/create-ui-spec-model.ts` (fallback log)
- Test: `src/create-ui-spec-model-config.test.ts` (warning spy)

**Interfaces:**
- Consumes: `resolveCreateUiSpecModelConfig` (existing), `CreateUiSpecModelDependency` (`create-ui-spec.ts`), `loadEnv` (`src/env.ts`).
- Produces: `runModelLaneCheck(config)` → `ModelLaneCheckResult` (exported from `src/model-lane-check.ts`); `scripts/check-model-lane.mjs` wrapper with exit codes; `"check:model-lane"` npm script.

- [ ] **Step 1: Write the failing warning tests**

Append to `src/create-ui-spec-model-config.test.ts`:

```ts
describe("boot-time config warnings", () => {
  function envFor(over: Record<string, string>): Record<string, string> {
    return {
      CREATE_UI_SPEC_MODEL_PROVIDER: "claude",
      CREATE_UI_SPEC_MODEL_BASE_URL: "https://api.anthropic.com/v1/messages",
      CREATE_UI_SPEC_MODEL_API_KEY: "sk-ant-test",
      CREATE_UI_SPEC_MODEL_NAME: "claude-sonnet-4-5-20250929",
      ...over,
    };
  }

  it("warns when the claude base URL has no /v1/messages path", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveCreateUiSpecModelConfig(envFor({ CREATE_UI_SPEC_MODEL_BASE_URL: "https://api.anthropic.com" }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("/v1/messages"));
    warn.mockRestore();
  });

  it("warns when the claude model name is an alias without a dated ID", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveCreateUiSpecModelConfig(envFor({ CREATE_UI_SPEC_MODEL_NAME: "claude-sonnet-4-5" }));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exact API model ID"));
    warn.mockRestore();
  });

  it("does not warn for a dated ID or for non-claude providers", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    resolveCreateUiSpecModelConfig(envFor({}));
    resolveCreateUiSpecModelConfig(envFor({
      CREATE_UI_SPEC_MODEL_PROVIDER: "openai",
      CREATE_UI_SPEC_MODEL_BASE_URL: "https://api.openai.com/v1",
    }));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
```

Run: `npx vitest run src/create-ui-spec-model-config.test.ts -t "boot-time"`
Expected: FAIL — no warnings are emitted.

- [ ] **Step 2: Implement the warnings**

In `src/create-ui-spec-model-config.ts`, in the `configured` return path, before the return statement add:

```ts
  // Advisory boot-time checks for the two measured misconfiguration classes.
  // Warnings only — proxies legitimately vary, so neither is a hard error.
  if (providerRaw.trim().toLowerCase() === "claude" && !/\/v1\/messages\/?$/.test(baseUrl)) {
    console.warn(
      `[create-ui-spec-model] claude provider: CREATE_UI_SPEC_MODEL_BASE_URL (${baseUrl}) does not end in /v1/messages; the tagger POSTs to the base URL verbatim and will 404.`,
    );
  }
  if (providerRaw.trim().toLowerCase() === "claude" && !/^[A-Za-z0-9._-]+-\d{8}$/.test(modelRaw.trim())) {
    console.warn(
      `[create-ui-spec-model] claude provider: model name "${modelRaw.trim()}" does not match the dated-ID shape; aliases resolve server-side and the fail-closed model-substitution check rejects them. Use the exact API model ID (e.g. claude-sonnet-4-5-20250929).`,
    );
  }
```

- [ ] **Step 3: Run to verify it passes**

Run: `npx vitest run src/create-ui-spec-model-config.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the check module**

Create `src/model-lane-check.ts`:

```ts
import type { CreateUiSpecModelDependency } from "./create-ui-spec.js";

/** Structured result of one operator-side lane check. Never throws. */
export interface ModelLaneCheckResult {
  configured: boolean;
  provider?: string;
  model?: string;
  resolvedModelId?: string | null;
  reachable?: boolean;
  error?: string;
}

/**
 * One tiny live call through the exact pinned runtime. `resolvedModelId` is
 * the model the provider actually served (catches the alias-vs-dated-ID
 * class); `error` is a safe message with no key, URL, or raw body.
 */
export async function runModelLaneCheck(
  model: CreateUiSpecModelDependency,
): Promise<ModelLaneCheckResult> {
  if (model.kind !== "configured") {
    return { configured: false };
  }
  const { endpoint, call } = model.runtime;
  try {
    const result = await call({
      prompt: "Reply with the single word: ok",
      endpoint,
      maxOutputTokens: 16,
      maxAttempts: 1,
      temperature: 0,
    });
    return {
      configured: true,
      provider: endpoint.provider,
      model: endpoint.model,
      resolvedModelId: result.model,
      reachable: true,
    };
  } catch (error) {
    // Safe message: strip anything that looks like a URL, key, or raw body.
    const raw = error instanceof Error ? error.message : String(error);
    const safe = raw
      .replace(/https?:\/\/\S+/gi, "<endpoint>")
      .replace(/sk-[A-Za-z0-9_-]+/gi, "<key>")
      .slice(0, 300);
    return {
      configured: true,
      provider: endpoint.provider,
      model: endpoint.model,
      resolvedModelId: null,
      reachable: false,
      error: safe,
    };
  }
}
```

- [ ] **Step 5: Write the module test**

Create `src/model-lane-check.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { runModelLaneCheck } from "./model-lane-check.js";
import { PinnedModelEndpointSchema, ModelGenerationParametersSchema } from "./create-ui-spec-model-contracts.js";

const ENDPOINT = PinnedModelEndpointSchema.parse({
  provider: "openai",
  baseUrl: "https://api.openai.com/v1/responses",
  apiKey: "runtime-secret-key",
  model: "gpt-5-mini",
});

const PARAMS = ModelGenerationParametersSchema.parse({
  temperature: 0, maxOutputTokens: 4096, maxAttempts: 1, seed: null,
});

describe("runModelLaneCheck", () => {
  it("reports not-configured without calling anything", async () => {
    const result = await runModelLaneCheck({ kind: "not-configured" });
    expect(result).toEqual({ configured: false });
  });

  it("makes one tiny call and reports the resolved model", async () => {
    const call = vi.fn(async () => ({
      content: "ok",
      provider: "openai",
      model: "gpt-5-mini",
      usage: { promptTokens: 1, completionTokens: 1, raw: { prompt_tokens: 1, completion_tokens: 1 } },
      attempts: 1,
      latencyMs: 42,
      providerRequestId: "req_1",
    }));
    const result = await runModelLaneCheck({
      kind: "configured",
      runtime: { endpoint: ENDPOINT, parameters: PARAMS, call, store: {} as never },
    });
    expect(result.reachable).toBe(true);
    expect(result.resolvedModelId).toBe("gpt-5-mini");
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]![0].maxOutputTokens).toBe(16);
    expect(call.mock.calls[0]![0].maxAttempts).toBe(1);
  });

  it("reports reachable:false with a safe error when the call throws", async () => {
    const call = vi.fn(async () => {
      throw new Error("Claude API error 404: https://api.anthropic.com sk-real-key");
    });
    const result = await runModelLaneCheck({
      kind: "configured",
      runtime: { endpoint: ENDPOINT, parameters: PARAMS, call, store: {} as never },
    });
    expect(result.reachable).toBe(false);
    expect(result.error).not.toContain("sk-real-key");
    expect(result.error).not.toContain("https://");
  });
});
```

Run: `npx vitest run src/model-lane-check.test.ts`
Expected: PASS.

- [ ] **Step 6: Create the npm script wrapper**

Create `scripts/check-model-lane.mjs`:

```js
#!/usr/bin/env node
/**
 * Operator-side model-lane health check. Resolves config through the SAME
 * create-ui-spec-model-config path the server uses, then makes one tiny call.
 * Exit 0 when reachable (or not configured); exit 1 when configured but
 * unreachable, so CI or a boot script can gate on it.
 */
import { loadEnv } from "../dist/env.js";
import { resolveCreateUiSpecModelConfig } from "../dist/create-ui-spec-model-config.js";
import { runModelLaneCheck } from "../dist/model-lane-check.js";

loadEnv();
const config = resolveCreateUiSpecModelConfig(process.env);
const result = await runModelLaneCheck(config);
console.log(JSON.stringify(result, null, 2));
if (result.configured && result.reachable === false) {
  process.exit(1);
}
```

In `package.json` scripts, add:

```json
    "check:model-lane": "node scripts/check-model-lane.mjs",
```

Build first so the script resolves: `npx tsc`, then:

Run: `npm run check:model-lane`
Expected (with the current `.env`): `configured: true`, `reachable: true`, `resolvedModelId: "claude-sonnet-4-5-20250929"`, exit 0.

- [ ] **Step 7: Document the env keys**

Append to `.env.example`:

```text
# Optional proposal-only model lane for create_ui_spec. Setting ALL four keys
# enables the lane; a PARTIAL set is refused (invalid-configuration).
CREATE_UI_SPEC_MODEL_PROVIDER=
# claude: must be the full messages endpoint (the tagger POSTs verbatim).
#   https://api.anthropic.com/v1/messages
# openai/gemini/mistral/minimax/grok: the provider's chat-completions URL.
CREATE_UI_SPEC_MODEL_BASE_URL=
CREATE_UI_SPEC_MODEL_API_KEY=
# claude: the EXACT API model ID (aliases like claude-sonnet-4-5 resolve
# server-side and are rejected by the fail-closed substitution check).
#   claude-sonnet-4-5-20250929
CREATE_UI_SPEC_MODEL_NAME=
# Optional: "1" (default) or "2" — one retry on JSON.parse failure.
# Enabling "2" roughly doubles worst-case call latency (2 x ~30s); retries
# cost tokens only on the discarded generation.
#CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS=1
```

- [ ] **Step 8: Add operator-facing log lines**

In `src/create-ui-spec-model.ts`, at the top of `fallback()`:

```ts
function fallback(
  state: Extract<ModelExecution["state"], "invalid-configuration" | "call-failed" | "proposal-rejected" | "persistence-failed">,
): ModelPathOutcome {
  // Operator channel: one concise line per non-success. No prompt, no
  // response bytes, no key material.
  console.error(`[create-ui-spec-model] lane fallback: ${state}`);
  return {
    kind: "fallback",
    execution: ModelExecutionSchema.parse({ state }) as Exclude<ModelExecution, { state: "succeeded" }>,
  };
}
```

In `src/create-ui-spec.ts`, in the `model.kind === "invalid-configuration"` branch, before the `attachModelExecution` return:

```ts
    console.error("[create-ui-spec] model lane not usable: invalid-configuration");
```

- [ ] **Step 9: Run the affected suites**

Run: `npx vitest run src/create-ui-spec-model-config.test.ts src/model-lane-check.test.ts src/create-ui-spec-model.test.ts src/create-ui-spec-model-path.test.ts`
Expected: PASS. (Existing tests that assert `fallback` results are unaffected; the log line is additive.)

- [ ] **Step 10: Commit**

```bash
git add src/create-ui-spec-model-config.ts src/model-lane-check.ts src/model-lane-check.test.ts scripts/check-model-lane.mjs package.json .env.example src/create-ui-spec.ts src/create-ui-spec-model.ts src/create-ui-spec-model-config.test.ts
git commit -m "feat(model-lane): operator channel — boot warnings, check:model-lane, logs

resolveCreateUiSpecModelConfig warns on the two measured claude
misconfiguration classes; runModelLaneCheck + the check:model-lane npm
script do one tiny call through the pinned runtime and gate CI on
reachability; .env.example documents the four lane keys and the maxAttempts
opt-in; every non-success lane path logs one concise operator line."
```

## Task 4: Grounding honesty — remove `evidenceSummaries` from the prompt

**Files:**
- Modify: `src/create-ui-spec-model.ts` (`buildPrompt` signature + body, call site)
- Test: `src/create-ui-spec-model.test.ts` (prompt boundary tests)

**Interfaces:**
- Consumes: `buildPrompt(request, sanitizedEvidence)` (current), `SanitizedEvidence` (current).
- Produces: `buildPrompt(request)` — the `sanitizedEvidence` parameter is removed; the prompt never contains an `evidenceSummaries` key.

- [ ] **Step 1: Write the failing tests**

Append to `src/create-ui-spec-model.test.ts`:

```ts
describe("createUiSpecModel grounding honesty", () => {
  it("does not put an evidenceSummaries key in the prompt, even with evidence present", async () => {
    const runtime = buildRuntime();
    const result = await createUiSpecModel(buildInput(), runtime);
    expect(result.kind).toBe("accepted");
    const [request] = runtime.call.mock.calls[0] as [Parameters<CreateUiSpecModelRuntime["call"]>[0]];
    expect(request.prompt).not.toContain("evidenceSummaries");
    expect(request.prompt).not.toContain("reference with");
    expect(request.prompt).not.toContain("c3-fallback-v1");
  });
});
```

Run: `npx vitest run src/create-ui-spec-model.test.ts -t "grounding honesty"`
Expected: FAIL — the prompt currently contains `evidenceSummaries`.

- [ ] **Step 2: Implement the removal**

In `src/create-ui-spec-model.ts`:

- Change the `buildPrompt` signature to `function buildPrompt(request: CreateUiSpecRequest): string`.
- Delete the `evidenceSummaries: sanitizedEvidence.map((row) => row.summary),` line.
- Update the call site: `const prompt = buildPrompt(request, sanitizedEvidence);` → `const prompt = buildPrompt(request);`
- Add a comment at the old key position:

```ts
    // NO evidenceSummaries key in this plan: every value the key could hold is
    // a recipe stub or a content-free pattern label ("<pattern> reference with
    // N regions"), and sending those as grounding is worse than sending none.
    // Plan 2 reintroduces the key with a non-empty guard over real derived
    // summaries, and bumps the policy version again at that point.
```

- [ ] **Step 3: Fix the existing prompt-boundary test**

The first test in `src/create-ui-spec-model.test.ts` asserts `expect(request.prompt).toContain("Favor compact hierarchy, restrained emphasis, and stable column alignment.")` — that string exists ONLY in the `evidence-1` summary of `buildInput()`. Delete that assertion. The constraint-derived assertion ("Prioritize dense scanability…") stays; it comes from `request.constraints`, which the prompt still carries.

Run: `npx vitest run src/create-ui-spec-model.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/create-ui-spec-model.ts src/create-ui-spec-model.test.ts
git commit -m "fix(model-lane): stop sending content-free evidence to the model

The evidenceSummaries key is removed from the prompt unconditionally; its
values were recipe stubs or pattern-label strings that steered thin briefs
toward the retrieved label class. Plan 2 reintroduces the key with real
derived summaries and a non-empty guard."
```

## Task 5: Prompt conciseness + `POLICY_VERSION` v5

**Files:**
- Modify: `src/create-ui-spec-model.ts` (`POLICY_VERSION`, task instruction)
- Test: `src/create-ui-spec-model.test.ts` (prompt boundary test)

**Interfaces:**
- Consumes: `POLICY_VERSION` (current `c3-model-proposal-v4`).
- Produces: `c3-model-proposal-v5`; the task instruction gains the conciseness sentence.

- [ ] **Step 1: Write the failing assertions**

In the prompt-boundary test, change the version assertion and add the conciseness assertion:

```ts
    expect(request.prompt).toContain("\"policyVersion\":\"c3-model-proposal-v5\"");
    expect(request.prompt).not.toContain("c3-model-proposal-v4");
    expect(request.prompt).toContain("Be concise. State each decision once");
```

Run: `npx vitest run src/create-ui-spec-model.test.ts -t "builds a prompt"`
Expected: FAIL — version is v4 and the phrase is absent.

- [ ] **Step 2: Implement**

In `src/create-ui-spec-model.ts`:

```ts
const POLICY_VERSION = "c3-model-proposal-v5";
```

and change the task line:

```ts
    task: "Produce a bounded UI-spec proposal as one JSON object and nothing else. "
      + "Be concise. State each decision once, with one sentence of rationale. "
      + "Drop the DECISION/EFFECT/REJECTS scaffolding where it adds no information.",
```

- [ ] **Step 3: Run to verify it passes**

Run: `npx vitest run src/create-ui-spec-model.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/create-ui-spec-model.ts src/create-ui-spec-model.test.ts
git commit -m "feat(model-lane): tighten prompt conciseness; policy v5

The prompt now asks for one sentence of rationale per decision and drops
the DECISION/EFFECT/REJECTS scaffolding where it adds nothing, and
POLICY_VERSION bumps to c3-model-proposal-v5 so promptSha256 stays honest."
```

## Task 6: Dogfood retry coverage + full verification

**Files:**
- Modify: `scripts/dogfood-createuispec.mjs` (fake-provider behavior + new case)

**Interfaces:**
- Consumes: the dogfood fake provider's behavior switch (`fakeProvider.setBehavior(...)`), `withModelServer`, `baseModelEnv`.
- Produces: a `"malformed-once"` fake-provider behavior (first request → `RAW_MODEL_BODY_FIXTURE`, subsequent → success proposal) and a dogfood case that runs the lane with `CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS=2` and asserts `attempts: 2` on the record.

- [ ] **Step 1: Add the fake-provider behavior**

In `scripts/dogfood-createuispec.mjs`, find the fake provider's behavior switch (the handler that maps `setBehavior` values like `"malformed"` and `"success"` to response bodies). Add a `"malformed-once"` branch: a module-level counter resets when the behavior is set; the first request returns the raw body `RAW_MODEL_BODY_FIXTURE` (status 200, the same body the `"malformed"` behavior serves), every subsequent request returns the success proposal body (the same body `"success"` serves).

- [ ] **Step 2: Add the dogfood case**

Immediately after the existing `malformed-response` case, add:

```js
    // Parse-failure retry: with the operator opt-in set, the first generation
    // returns the malformed body and the second succeeds. The record must
    // carry attempts: 2 and the served envelope must show proposal-only with
    // accepted tokens null.
    resetStore();
    assertStoreEmpty();
    fakeProvider.setBehavior("malformed-once");
    await withModelServer({ ...baseModelEnv, CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS: "2" }, async (modelServer, modelNonce) => {
      const envelope = requireEnvelope(await postJson(modelServer.baseUrl, modelNonce, INTENT_BRIEF));
      assert(envelope.modelExecution?.state === "succeeded", "retry did not surface succeeded");
      assert(envelope.spec.modelProposal?.status === "proposal-only", "retry proposal not proposal-only");
      assertTokensUnavailable(envelope);
    });
    const records = readdirSync(MODEL_ARTIFACT_STORE_ROOT);
    assert(records.length === 1, "retry wrote exactly one record");
    const record = JSON.parse(readFileSync(join(MODEL_ARTIFACT_STORE_ROOT, records[0]), "utf8"));
    assert(record.attempts === 2, "retry record did not carry attempts 2");
    console.log("dogfood-createuispec: PASS parse-failure-retry");
```

`readdirSync`, `readFileSync`, and `join` are already imported at the top of the script.

- [ ] **Step 3: Run the dogfood script**

Run: `npx tsc && node scripts/dogfood-createuispec.mjs`
Expected: PASS, including the new `parse-failure-retry` line.

- [ ] **Step 4: Full verification**

Run:

```bash
npx tsc --noEmit
npx vitest run
node scripts/dogfood-createuispec.mjs
npm run check:model-lane
```

Expected: tsc clean; full suite green (the known `dom-motion-capture` load flake, issue #84, may appear and passes standalone — note it if it does); dogfood PASS; check:model-lane reports `reachable: true` with the real `.env`.

- [ ] **Step 5: Live campaign (manual, documented, not CI)**

Using the MCP stdio harness from the 2026-08-02 live test, run the 10-brief probe (or at minimum the login, finance, and habit-tracker briefs) against the real provider and record: median `designDirection` length (target ≤ ~1,000 vs the 1,272 baseline), max (target ≤ ~1,400 vs 1,789), accept rate (no regression), and one `"Make it better."` run whose proposal must NOT describe an editor canvas or marketing hero. Record the numbers in the PR description.

- [ ] **Step 6: Commit**

```bash
git add scripts/dogfood-createuispec.mjs
git commit -m "test(model-lane): dogfood the parse-failure retry path

The fake provider gains a malformed-once behavior; with
CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS=2 the dogfood harness asserts a
succeeded envelope, exactly one store record, and attempts: 2."
```

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | interrupted | no findings returned |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 6 issues, all folded |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** dispatched via requesting-code-review; the subagent chain ran a nested deep-dive for ~30 minutes and was interrupted before returning findings, so this plan set has no outside-voice pass. Recommend a bounded re-run before implementation if cross-model review is wanted.

**VERDICT:** ENG CLEARED — ready to implement. Six review fixes folded into the plans (see below); scope accepted as-is per user decision; TODOs.md gained three deferred items.

Eng-review findings (all fixed in the plan files, user blanket-approved):
1. [P1] Plan 2 colorRoles shape mismatched the corpus schema (canvas/muted-nullable) — fixed to mirror `src/schema.ts:420-426` and reuse the `design-prompt.ts` merge mapping.
2. [P1] Synthesized direction cited corpus ids without updating `citedDecisions`/authority — fixed with a corpus-authority designDirection decision replacing the recipe's.
3. [P1] Synthesis applied on the model-proposal path — gated behind `proposal === undefined`.
4. [P1] `Math.min` over empty role arrays fabricated default tokens — fixed with a `withRoles.length >= 3` guard + tests.
5. [P2] Test gaps — embeddings fallback, error-branch `modelExecutionState: null`, model-path gating, citation ledger; all added.
6. [P3] Retry worst-case latency undocumented — `.env.example` comment added.

NO UNRESOLVED DECISIONS

## Implementation Tasks

- [ ] **T1 (P1, human: ~30min / CC: ~5min)** — apply the two verified plan fixes — Plan 2 Task 3 authority token `"corpusEvidence"` → `"corpus-evidence"`; Plan 2 Task 0 audit fixture `primary` → `canvas`. DONE in this review (already applied to the plan files).
  - Surfaced by: Architecture review — D3 authority-enum cross-check (tool-contracts.ts:537, :853); D2 corpus-schema cross-check (schema.ts:418-424).
  - Files: `docs/superpowers/plans/2026-08-02-deterministic-body-grounding.md`, `docs/superpowers/plans/2026-08-02-model-lane-reliability.md`
  - Verify: `rg -n "corpusEvidence|corpus-evidence" docs/superpowers/plans/2026-08-02-deterministic-body-grounding.md` and `rg -n "canvas" docs/superpowers/plans/2026-08-02-deterministic-body-grounding.md | head -3`
- [ ] **T2 (P2, human: ~2h / CC: ~15min)** — request code review — dispatch the requesting-code-review subagent on both plan commits before implementation begins (per the requesting-code-review skill; mandatory before implementing major plans).
  - Surfaced by: requesting-code-review skill — mandatory before implementing major plans.
  - Files: `docs/superpowers/plans/2026-08-02-model-lane-reliability.md`, `docs/superpowers/plans/2026-08-02-deterministic-body-grounding.md`
  - Verify: review feedback triaged (Critical fixed, Important fixed, Minor noted).

_No new tasks from Code Quality._ _No new tasks from Performance beyond the documented latency note (retry doubles worst-case to ~60-70s; default stays 1 attempt)._

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 4 | CLEAR | 2 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** (not run — requesting-code-review dispatch is separate; see Implementation Tasks)
- **CROSS-MODEL:** (not run)
- **VERDICT:** ENG CLEARED — ready to implement. Joint plan-set review, second pass (2026-08-02, commit 4f4574e). Two verified findings folded: (1) Plan 2 Task 3 `citedDecisions.authority` corrected to `"corpus-evidence"` — the plan used the camelCase lane name, which is not in the CitedDecision enum (tool-contracts.ts:537) and would fail the strict parse while silently bypassing the consistency gate at :853; (2) Plan 2 Task 0 audit fixture `colorRoles` corrected to `canvas` (corpus schema at schema.ts:418-424). This plan also gained the byte-limit / private-marker no-retry pins at maxAttempts=2 (Task 1 Step 9). Every other architecture claim was verified against code: retry loop shape, makeEnvelope conditional-key idiom (:2374), `hasEvidence`/`allowNoneWithPositiveResult` precedent (:1517), `runtime.call` signature, `CorpusReader.searchRanked`/`findSimilar` (corpus-reader.ts:69-71), `pickDiverse` at create-ui-spec.ts:482, warning-code list at tool-contracts.ts:1857, `corpusEvidenceIds`/`buildCitedDecisions` (create-ui-spec.ts:813-847), `buildInput` overrides (model.test.ts:11), ranked `makeReader` helper (create-ui-spec.test.ts:124), `plurality` currently private (design-prompt.ts:45), `HexColor` not exported (schema.ts:418, plan's conditional covers it), and `MAX_MODEL_TEXT_BYTES = 32 * 1024` (model.ts:23).

NO UNRESOLVED DECISIONS
