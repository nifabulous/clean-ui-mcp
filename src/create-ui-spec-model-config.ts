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
  // ALL unset ⇔ operator deliberately wants the deterministic runner
  // (not-configured); a PARTIAL tuple ⇔ operator misconfigured a provisioned
  // intent and must not silently fall back to determinism (invalid-configuration).
  // The all-unset case is therefore NOT a validation failure: the composition
  // root legitimately runs with zero dedicated variables set. (Unset means
  // `undefined`; present-but-blank values like "" or whitespace fall through
  // to invalid-configuration, as the whitespace tests assert.)
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

  // Operator opt-in for parse-failure retry. Absent or "1" keeps the
  // single-attempt default; "2" enables one retry on JSON.parse failure. Any
  // other value is a misconfiguration and must not silently degrade.
  const maxAttemptsRaw = env.CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS ?? "1";
  if (maxAttemptsRaw !== "1" && maxAttemptsRaw !== "2") {
    return { kind: "invalid-configuration" };
  }
  const maxAttempts = maxAttemptsRaw === "2" ? 2 : 1;

  return {
    kind: "configured",
    runtime: {
      endpoint: endpoint.data,
      parameters: ModelGenerationParametersSchema.parse({
        temperature: 0,
        maxOutputTokens: 4_096,
        maxAttempts,
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
