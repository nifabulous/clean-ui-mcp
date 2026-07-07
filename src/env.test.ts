import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv } from "./env.js";

const original = {
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  OPENAI_AUTO_TAG_MODEL: process.env.OPENAI_AUTO_TAG_MODEL,
  VOYAGE_API_KEY: process.env.VOYAGE_API_KEY,
  CLEAN_UI_PORT: process.env.CLEAN_UI_PORT,
};

afterEach(() => {
  for (const key of Object.keys(original) as Array<keyof typeof original>) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("env loading", () => {
  it("loads local .env values for app secrets", () => {
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_AUTO_TAG_MODEL;
    delete process.env.CLEAN_UI_PORT;

    const dir = mkdtempSync(join(tmpdir(), "clean-ui-env-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "OPENAI_API_KEY=sk-test-local\nOPENAI_AUTO_TAG_MODEL=test-model\nCLEAN_UI_PORT=4242\n");

    try {
      const status = loadEnv({ path: envPath });

      expect(status.envFileLoaded).toBe(true);
      expect(status.openaiKeyConfigured).toBe(true);
      expect(status.openaiAutoTagModel).toBe("test-model");
      expect(status.cleanUiPort).toBe(4242);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(".env file overrides stale shell values by default", () => {
    process.env.OPENAI_API_KEY = "sk-shell";

    const dir = mkdtempSync(join(tmpdir(), "clean-ui-env-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "OPENAI_API_KEY=sk-file\n");

    try {
      loadEnv({ path: envPath });

      // .env should win — the file is the source of truth, not stale shell exports.
      expect(process.env.OPENAI_API_KEY).toBe("sk-file");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("respects explicit override:false to keep shell values", () => {
    process.env.OPENAI_API_KEY = "sk-shell";

    const dir = mkdtempSync(join(tmpdir(), "clean-ui-env-"));
    const envPath = join(dir, ".env");
    writeFileSync(envPath, "OPENAI_API_KEY=sk-file\n");

    try {
      loadEnv({ path: envPath, override: false });

      expect(process.env.OPENAI_API_KEY).toBe("sk-shell");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
