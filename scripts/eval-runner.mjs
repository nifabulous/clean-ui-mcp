/**
 * eval-runner.mjs
 * ───────────────
 * Shared single-image eval orchestration. Both the CLI baseline runner
 * (eval-baseline.mjs) and the provider/model matrix runner (eval-matrix.mjs)
 * call this so they share the same scoring path — no parallel truth model.
 *
 * runEvalCase does: one extraction pass (+ optional critique pass) against a
 * single fixture image, scoring the RAW pre-sanitize output. Returns a result
 * object with extraction/critique scores + latency + traceability metadata.
 *
 * The extractionOverride/critiqueOverride params (OpenAIConfig triples from
 * Task 3's endpoint-config override) let the matrix pin exact endpoints per
 * run. They are forwarded to tagImage/generateCritique; when undefined, the
 * tagger falls back to env-driven resolution (current behavior).
 */
import { resolve } from "node:path";

import { tagImage, generateCritique, activeModelName, activeProviderName } from "../dist/tagger.js";
import { scoreExtraction, scoreCritique } from "./eval-scorer.mjs";

/**
 * @typedef {Object} EvalCaseInput
 * @property {string} imagePath     - corpus-relative image path
 * @property {string} productName
 * @property {string} platform      - "web" | "mobile" | "tablet"
 * @property {string} goldPatternType
 * @property {boolean} runCritique  - whether to run the critique pass
 * @property {string} projectRoot   - absolute path to repo root (for resolving imagePath)
 * @property {object} [extractionOverride] - EndpointOverride triple (added in Task 3); when undefined, tagger uses env defaults
 * @property {object} [critiqueOverride]   - EndpointOverride triple (added in Task 3); when undefined, tagger uses env defaults
 */

/**
 * Run a single-image eval case: extraction (+ optional critique), scored.
 *
 * @param {EvalCaseInput} input
 * @returns {Promise<Object>} result with extraction/critique scores + latency
 */
export async function runEvalCase(input) {
  const { imagePath, productName, platform, goldPatternType, runCritique, projectRoot } = input;
  const fullPath = resolve(projectRoot, "corpus", imagePath);

  const result = {
    imageId: null, // caller sets from fixture id
    goldPatternType,
    platform,
    extractionModel: null,
    extractionLatencyMs: null,
    extraction: null,
    critique: null,
    critiqueLatencyMs: null,
    error: null,
  };

  const t0 = Date.now();
  try {
    const entry = await tagImage({
      imagePath: fullPath,
      productName,
      url: null,
      imageDetail: "low",
      extractionOnly: true,
      extractionOverride: input.extractionOverride,
    });
    const latencyMs = Date.now() - t0;
    const rawExtraction = entry._raw?.extraction ?? {};
    const exScore = scoreExtraction(rawExtraction, goldPatternType);

    result.extractionModel = entry._raw?.extractionModel ?? activeModelName("extraction");
    result.extractionLatencyMs = latencyMs;
    result.extraction = exScore;

    if (runCritique) {
      const tc0 = Date.now();
      try {
        const critique = await generateCritique(
          productName,
          rawExtraction,
          undefined,
          undefined,
          platform,
          input.critiqueOverride,
        );
        result.critiqueLatencyMs = Date.now() - tc0;
        const rawCritique = critique._raw?.critique ?? {};
        result.critique = scoreCritique(rawCritique);
      } catch (e) {
        result.critiqueLatencyMs = Date.now() - tc0;
        // Critique failure is non-fatal for the extraction score; record the error.
        result.critique = { error: e.message };
      }
    }
  } catch (e) {
    result.extractionLatencyMs = Date.now() - t0;
    result.error = e.message;
  }

  return result;
}

/**
 * Build an EndpointOverride from env vars for a given pass. Used by the
 * baseline runner to pin explicit configs at startup (bypasses peak-hour
 * routing for determinism). For OpenAI-compatible providers, reads the
 * per-pass env vars that openaiConfigForPass would have read at call time —
 * but resolves them ONCE here so they're frozen for the entire run.
 *
 * CRITICAL: reads provider from env DIRECTLY, NOT via activeProviderName().
 * activeProviderName() → resolveProvider() runs the peak-hour DeepSeek→MiniMax
 * swap. At peak hours that would return "minimax" instead of "openai", causing
 * this function to return undefined and the eval to fall back to ambient
 * routing — defeating the determinism this function exists to enforce.
 *
 * Returns undefined for non-OpenAI providers (claude, gemini, etc.) — those
 * are provider-pinned but not model-pinned this milestone.
 *
 * @param {"extraction" | "critique"} pass
 * @returns {object | undefined} EndpointOverride, or undefined if the env
 *   provider is not openai
 */
export function buildEnvOverride(pass) {
  // Read provider from env directly — mirrors resolveProvider's env path but
  // WITHOUT the peak-hour swap, capability fallback, or key-presence search.
  const envVar = pass === "extraction" ? "AUTO_TAG_PROVIDER_EXTRACTION" : "AUTO_TAG_PROVIDER_CRITIQUE";
  const provider = (process.env[envVar] ?? process.env.AUTO_TAG_PROVIDER ?? "openai").toLowerCase();

  // Only pin OpenAI-compatible providers (the override reaches openaiConfigForPass).
  // Claude/Gemini are provider-only lanes — model stays env-driven this milestone.
  if (provider !== "openai") return undefined;

  const tier = pass.toUpperCase();
  const baseUrl = (process.env[`OPENAI_BASE_URL_${tier}`] ?? process.env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "");
  const apiKey = process.env[`OPENAI_API_KEY_${tier}`] ?? process.env.OPENAI_API_KEY ?? "";
  const model = process.env[`OPENAI_AUTO_TAG_MODEL_${tier}`] ?? process.env.OPENAI_AUTO_TAG_MODEL ?? "gpt-5.4-nano";

  return { provider: "openai", baseUrl, apiKey, model };
}
