/**
 * image-embeddings.ts — pluggable multimodal image-embedding provider boundary.
 *
 * The critique_ui tool needs to embed screenshots and find visually similar
 * corpus entries. The text embedding index (Voyage voyage-4, text-only) can't
 * do this. This module provides a provider interface so the concrete hosted
 * adapter is selected AFTER benchmarking, not hard-coded.
 *
 * Configuration via env:
 *   IMAGE_EMBEDDING_PROVIDER  — "voyage" | "openai" (extensible)
 *   IMAGE_EMBEDDING_API_KEY   — provider API key
 *   IMAGE_EMBEDDING_MODEL     — override the default model (optional)
 *
 * When unconfigured, createImageEmbeddingProvider() returns null and the
 * critique_ui tool falls back to structured text retrieval.
 */
import { type SupportedMimeType } from "./critique-ui.js";

export interface ValidatedImage {
  data: Buffer;
  mimeType: SupportedMimeType;
}

export interface ImageEmbeddingProvider {
  readonly name: string;
  readonly model: string;
  /** Embed an image into a vector. Must reject non-image MIME types. */
  embedImage(image: ValidatedImage): Promise<number[]>;
}

// ─── provider defaults ─────────────────────────────────────────────────────────

// C3 fix: removed the OpenAI default — text-embedding-3-large is a text-only
// model that rejects image_url input. OpenAI does not currently offer a
// multimodal embedding model. To use an OpenAI-compatible image embedder,
// set IMAGE_EMBEDDING_PROVIDER=voyage (the only verified adapter) or extend
// this map with a verified provider.
const PROVIDER_DEFAULTS: Record<string, { model: string; api: string }> = {
  voyage: { model: "voyage-multimodal-3", api: "https://api.voyageai.com/v1/multimodalembeddings" },
};

/**
 * Factory: returns the configured image-embedding provider, or null when
 * image embeddings are not configured (the structured-fallback path).
 */
export function createImageEmbeddingProvider(): ImageEmbeddingProvider | null {
  const providerName = (process.env.IMAGE_EMBEDDING_PROVIDER ?? "").toLowerCase();
  const apiKey = process.env.IMAGE_EMBEDDING_API_KEY;

  if (!providerName || !apiKey) return null;

  const defaults = PROVIDER_DEFAULTS[providerName];
  if (!defaults) {
    console.error(`[image-embeddings] Unknown provider "${providerName}". Supported: ${Object.keys(PROVIDER_DEFAULTS).join(", ")}.`);
    return null;
  }

  const model = process.env.IMAGE_EMBEDDING_MODEL ?? defaults.model;

  return {
    name: providerName,
    model,
    embedImage: (image) => embedImageViaProvider(providerName, defaults.api, apiKey, model, image),
  };
}

// ─── provider implementations ──────────────────────────────────────────────────

/**
 * Route to the provider-specific embedding call. Provider HTTP code lives here,
 * never in server.ts or retrieval code.
 */
async function embedImageViaProvider(
  provider: string,
  api: string,
  apiKey: string,
  model: string,
  image: ValidatedImage,
): Promise<number[]> {
  if (!image.mimeType.startsWith("image/")) {
    throw new Error(`Cannot embed non-image MIME type: ${image.mimeType}`);
  }

  const maxRetries = 2;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const vec = await callProvider(provider, api, apiKey, model, image);
      if (!vec || vec.length === 0 || !vec.every(Number.isFinite)) {
        throw new Error(`Provider returned invalid vector (len=${vec?.length}, allFinite=${vec?.every(Number.isFinite)})`);
      }
      return vec;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1))); // 1s, 2s backoff
      }
    }
  }
  throw lastError ?? new Error("Image embedding failed after retries");
}

/** Provider-specific HTTP call. Returns the embedding vector. */
async function callProvider(
  provider: string,
  api: string,
  apiKey: string,
  model: string,
  image: ValidatedImage,
): Promise<number[]> {
  const base64 = image.data.toString("base64");

  if (provider === "voyage") {
    return callVoyage(api, apiKey, model, base64, image.mimeType);
  }
  throw new Error(`No HTTP implementation for provider "${provider}"`);
}

/** Voyage multimodal embeddings API. */
async function callVoyage(
  api: string,
  apiKey: string,
  model: string,
  base64: string,
  mimeType: string,
): Promise<number[]> {
  const res = await fetch(api, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      inputs: [{ type: "image", image: `data:${mimeType};base64,${base64}` }],
    }),
  });
  // I4 fix: log only the status code, not the response body — provider error
  // bodies can echo request details or auth info on 401/403.
  if (!res.ok) throw new Error(`Voyage image embedding error (HTTP ${res.status})`);
  const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const vec = data.data?.[0]?.embedding;
  if (!vec || !Array.isArray(vec)) throw new Error("Voyage returned no embedding vector");
  return vec;
}
