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
