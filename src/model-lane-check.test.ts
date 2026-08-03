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
