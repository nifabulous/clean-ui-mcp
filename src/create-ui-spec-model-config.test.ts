import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolve } from "node:path";
import { PROJECT_ROOT } from "./paths.js";

const storeSpy = vi.hoisted(() => ({
  roots: [] as string[],
  store: {
    save: vi.fn(),
    read: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("./model-artifact-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./model-artifact-store.js")>();
  return {
    ...actual,
    createFileModelArtifactStore: vi.fn((rootDir: string) => {
      storeSpy.roots.push(rootDir);
      return storeSpy.store;
    }),
  };
});

const { resolveCreateUiSpecModelConfig } = await import("./create-ui-spec-model-config.js");
const { callTextModelWithMetadata } = await import("./tagger.js");

const DEDICATED = {
  CREATE_UI_SPEC_MODEL_PROVIDER: "openai",
  CREATE_UI_SPEC_MODEL_BASE_URL: "https://models.example.test/v1/responses?tenant=private",
  CREATE_UI_SPEC_MODEL_API_KEY: "task-6-api-key",
  CREATE_UI_SPEC_MODEL_NAME: "pinned-ui-model",
} as const;

const DEDICATED_KEYS = Object.keys(DEDICATED) as Array<keyof typeof DEDICATED>;

beforeEach(() => {
  storeSpy.roots.length = 0;
  vi.clearAllMocks();
});

describe("resolveCreateUiSpecModelConfig", () => {
  it("resolves an entirely absent dedicated configuration to not-configured", () => {
    expect(resolveCreateUiSpecModelConfig({})).toEqual({ kind: "not-configured" });
    expect(storeSpy.roots).toEqual([]);
  });

  it("resolves every non-empty partial combination to invalid-configuration", () => {
    for (let mask = 1; mask < (1 << DEDICATED_KEYS.length) - 1; mask += 1) {
      const env: Record<string, string> = {};
      DEDICATED_KEYS.forEach((key, index) => {
        if ((mask & (1 << index)) !== 0) env[key] = DEDICATED[key];
      });
      expect(resolveCreateUiSpecModelConfig(env), JSON.stringify(Object.keys(env))).toEqual({
        kind: "invalid-configuration",
      });
    }
    expect(storeSpy.roots).toEqual([]);
  });

  it("treats present-but-blank dedicated values as invalid configuration", () => {
    for (const key of DEDICATED_KEYS) {
      expect(resolveCreateUiSpecModelConfig({ ...DEDICATED, [key]: "   " }), key).toEqual({
        kind: "invalid-configuration",
      });
    }
    expect(storeSpy.roots).toEqual([]);
  });

  it("rejects unknown providers, non-HTTPS URLs, credentials in URLs, and empty models", () => {
    const invalidEnvs = [
      { ...DEDICATED, CREATE_UI_SPEC_MODEL_PROVIDER: "bedrock" },
      { ...DEDICATED, CREATE_UI_SPEC_MODEL_BASE_URL: "http://models.example.test/v1" },
      { ...DEDICATED, CREATE_UI_SPEC_MODEL_BASE_URL: "https://user:pass@models.example.test/v1" },
      { ...DEDICATED, CREATE_UI_SPEC_MODEL_BASE_URL: "not a url" },
      { ...DEDICATED, CREATE_UI_SPEC_MODEL_NAME: "" },
    ];
    for (const env of invalidEnvs) {
      expect(resolveCreateUiSpecModelConfig(env)).toEqual({ kind: "invalid-configuration" });
    }
    expect(storeSpy.roots).toEqual([]);
  });

  it("normalizes a complete valid tuple into one pinned runtime and constructs one isolated store", () => {
    const resolved = resolveCreateUiSpecModelConfig({
      CREATE_UI_SPEC_MODEL_PROVIDER: "  OPENAI  ",
      CREATE_UI_SPEC_MODEL_BASE_URL: "  https://models.example.test/v1/responses?tenant=private  ",
      CREATE_UI_SPEC_MODEL_API_KEY: "  task-6-api-key  ",
      CREATE_UI_SPEC_MODEL_NAME: "  pinned-ui-model  ",
    });

    expect(resolved.kind).toBe("configured");
    if (resolved.kind !== "configured") throw new Error("expected configured runtime");
    expect(resolved.runtime.endpoint).toEqual({
      provider: "openai",
      baseUrl: "https://models.example.test/v1/responses?tenant=private",
      apiKey: "task-6-api-key",
      model: "pinned-ui-model",
    });
    expect(resolved.runtime.parameters).toEqual({
      temperature: 0,
      maxOutputTokens: 4_096,
      maxAttempts: 1,
      seed: null,
    });
    expect(resolved.runtime.call).toBe(callTextModelWithMetadata);
    expect(resolved.runtime.store).toBe(storeSpy.store);
    expect(storeSpy.roots).toEqual([
      resolve(PROJECT_ROOT, ".create-ui-spec-model-artifacts"),
    ]);
  });

  it("does not let generic or provider-specific ambient variables fill a missing dedicated value", () => {
    const ambient = {
      MODEL_PROVIDER: "openai",
      MODEL_BASE_URL: "https://ambient.example.test/v1",
      MODEL_API_KEY: "ambient-generic-key",
      MODEL_NAME: "ambient-generic-model",
      OPENAI_API_KEY: "ambient-openai-key",
      OPENAI_BASE_URL: "https://openai-ambient.example.test/v1",
      OPENAI_MODEL: "ambient-openai-model",
      ANTHROPIC_API_KEY: "ambient-anthropic-key",
      AUTO_TAG_PROVIDER: "openai",
      OPENAI_AUTO_TAG_MODEL: "ambient-auto-tag-model",
    };
    for (const missing of DEDICATED_KEYS) {
      const partial: Record<string, string> = { ...ambient, ...DEDICATED };
      delete partial[missing];
      expect(resolveCreateUiSpecModelConfig(partial), missing).toEqual({
        kind: "invalid-configuration",
      });
    }
    expect(storeSpy.roots).toEqual([]);
  });

  it("does not let ambient values override an explicit dedicated tuple", () => {
    const resolved = resolveCreateUiSpecModelConfig({
      ...DEDICATED,
      MODEL_PROVIDER: "claude",
      MODEL_BASE_URL: "https://ambient.example.test/v1",
      MODEL_API_KEY: "ambient-generic-key",
      MODEL_NAME: "ambient-generic-model",
      OPENAI_API_KEY: "ambient-openai-key",
      OPENAI_BASE_URL: "https://openai-ambient.example.test/v1",
      OPENAI_MODEL: "ambient-openai-model",
    });
    expect(resolved.kind).toBe("configured");
    if (resolved.kind !== "configured") throw new Error("expected configured runtime");
    expect(resolved.runtime.endpoint).toEqual({
      provider: "openai",
      baseUrl: DEDICATED.CREATE_UI_SPEC_MODEL_BASE_URL,
      apiKey: DEDICATED.CREATE_UI_SPEC_MODEL_API_KEY,
      model: DEDICATED.CREATE_UI_SPEC_MODEL_NAME,
    });
  });
});
