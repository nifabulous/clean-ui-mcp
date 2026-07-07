import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_ENV_PATH = resolve(__dirname, "..", ".env");
export const DEFAULT_OPENAI_AUTO_TAG_MODEL = "gpt-5.4-nano";
export const DEFAULT_CLEAN_UI_PORT = 3131;

export interface EnvStatus {
  envPath: string;
  envFileLoaded: boolean;
  openaiKeyConfigured: boolean;
  anthropicKeyConfigured: boolean;
  geminiKeyConfigured: boolean;
  mistralKeyConfigured: boolean;
  voyageKeyConfigured: boolean;
  autoTagProvider: string;
  openaiAutoTagModel: string;
  cleanUiPort: number;
}

function present(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

export function getEnvStatus(envPath = DEFAULT_ENV_PATH): EnvStatus {
  return {
    envPath,
    envFileLoaded: existsSync(envPath),
    openaiKeyConfigured: present(process.env.OPENAI_API_KEY),
    anthropicKeyConfigured: present(process.env.ANTHROPIC_API_KEY),
    geminiKeyConfigured: present(process.env.GEMINI_API_KEY),
    mistralKeyConfigured: present(process.env.MISTRAL_API_KEY),
    voyageKeyConfigured: present(process.env.VOYAGE_API_KEY),
    autoTagProvider: process.env.AUTO_TAG_PROVIDER || "openai",
    openaiAutoTagModel: process.env.OPENAI_AUTO_TAG_MODEL || DEFAULT_OPENAI_AUTO_TAG_MODEL,
    cleanUiPort: Number(process.env.CLEAN_UI_PORT ?? DEFAULT_CLEAN_UI_PORT),
  };
}

export function loadEnv(options: { path?: string; override?: boolean } = {}): EnvStatus {
  const envPath = options.path ?? DEFAULT_ENV_PATH;
  if (existsSync(envPath)) {
    config({ path: envPath, override: options.override ?? true, quiet: true });
  }
  return getEnvStatus(envPath);
}

loadEnv();
