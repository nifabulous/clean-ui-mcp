import { resolve } from "node:path";
import type { CreateUiSpecModelDependency } from "./create-ui-spec.js";
import {
  ModelGenerationParametersSchema,
  PinnedModelEndpointSchema,
} from "./create-ui-spec-model-contracts.js";
import { callTextModelWithMetadata } from "./tagger.js";
import { createFileModelArtifactStore } from "./model-artifact-store.js";
import { PROJECT_ROOT } from "./paths.js";

const CONFIG_KEYS = [
  "CREATE_UI_SPEC_MODEL_PROVIDER",
  "CREATE_UI_SPEC_MODEL_BASE_URL",
  "CREATE_UI_SPEC_MODEL_API_KEY",
  "CREATE_UI_SPEC_MODEL_NAME",
] as const;

const MODEL_ARTIFACT_STORE_ROOT = resolve(
  PROJECT_ROOT,
  ".create-ui-spec-model-artifacts",
);

export type ResolvedCreateUiSpecModelConfig = CreateUiSpecModelDependency;

/** Resolve only the dedicated create_ui_spec model tuple supplied by a composition root. */
export function resolveCreateUiSpecModelConfig(
  env: Readonly<Record<string, string | undefined>>,
): ResolvedCreateUiSpecModelConfig {
  const raw = CONFIG_KEYS.map((key) => env[key]);
  if (raw.every((value) => value === undefined)) return { kind: "not-configured" };
  if (raw.some((value) => value === undefined)) return { kind: "invalid-configuration" };

  const [providerRaw, baseUrlRaw, apiKeyRaw, modelRaw] = raw as [string, string, string, string];
  const baseUrl = baseUrlRaw.trim();
  if (!isCredentialFreeHttpsUrl(baseUrl)) return { kind: "invalid-configuration" };

  const endpoint = PinnedModelEndpointSchema.safeParse({
    provider: providerRaw.trim().toLowerCase(),
    baseUrl,
    apiKey: apiKeyRaw.trim(),
    model: modelRaw.trim(),
  });
  if (!endpoint.success) return { kind: "invalid-configuration" };

  return {
    kind: "configured",
    runtime: {
      endpoint: endpoint.data,
      parameters: ModelGenerationParametersSchema.parse({
        temperature: 0,
        maxOutputTokens: 4_096,
        maxAttempts: 1,
        seed: null,
      }),
      call: callTextModelWithMetadata,
      store: createFileModelArtifactStore(MODEL_ARTIFACT_STORE_ROOT),
    },
  };
}

function isCredentialFreeHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "";
  } catch {
    return false;
  }
}
