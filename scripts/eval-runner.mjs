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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { tagImage, generateCritique, activeModelName, activeProviderName } from "../dist/tagger.js";
import { buildScreenEvidenceIds } from "../dist/synthesis/context.js";
import { scoreExtraction, scoreCritique } from "./eval-scorer.mjs";
import { scoreCritiqueQuality } from "./critique-quality-scorer.mjs";

// ─── gold labels ───────────────────────────────────────────────────────────────
// Loaded once at module init. Keyed by label `id` for O(1) lookup in runEvalCase.
// Labels are offline (no credentials) and pinned per fixture.

const __dirname = dirname(fileURLToPath(import.meta.url));
const LABELS_PATH = resolve(__dirname, "..", "eval", "critique-quality-labels.json");

/**
 * Gold labels for deterministic critique-quality scoring, keyed by label `id`.
 * @type {Map<string, object>}
 */
export const critiqueQualityLabels = (() => {
  try {
    const data = JSON.parse(readFileSync(LABELS_PATH, "utf8"));
    const labels = Array.isArray(data.labels) ? data.labels : [];
    const labelVersion = typeof data.labelVersion === "number" ? data.labelVersion : 1;
    return new Map(labels.map((l) => [{ ...l, labelVersion: l.labelVersion ?? labelVersion }.id, { ...l, labelVersion: l.labelVersion ?? labelVersion }]));
  } catch {
    // Missing/corrupt labels file → empty map. Scoring is skipped when no label
    // matches, so a missing file never breaks the eval run.
    return new Map();
  }
})();

/**
 * @typedef {Object} EvalCaseInput
 * @property {string} imagePath     - corpus-relative image path
 * @property {string} productName
 * @property {string} platform      - "web" | "mobile" | "tablet"
 * @property {string} goldPatternType
 * @property {boolean} runCritique  - whether to run the critique pass
 * @property {string} projectRoot   - absolute path to repo root (for resolving imagePath)
 * @property {string} [imageId]     - fixture id; used to look up the gold label for critique-quality scoring
 * @property {object} [extractionOverride] - EndpointOverride triple (added in Task 3); when undefined, tagger uses env defaults
 * @property {object} [critiqueOverride]   - EndpointOverride triple (added in Task 3); when undefined, tagger uses env defaults
 */

/**
 * Convert the legacy raw critique blob (Pass 2 shape) into a partial
 * StructuredCritique shape for the deterministic quality scorer.
 *
 * The legacy blob has no structured recommendations — only prose
 * (draftCritique/draftWhatToSteal/draftAntiPatterns) and accessibility
 * risks. Evidence IDs are derived from the extraction via the shared
 * buildScreenEvidenceIds helper (NOT duplicated inline) so they match
 * what synthesis would produce.
 *
 * @param {Record<string, unknown>} rawCritique - the _raw.critique blob
 * @param {Record<string, unknown>} extraction  - the raw extraction (for evidence IDs)
 * @returns {Record<string, unknown>} partial StructuredCritique
 */
export function critiqueToStructured(rawCritique, extraction) {
  const c = (rawCritique && typeof rawCritique === "object") ? rawCritique : {};
  const summary = typeof c.draftCritique === "string" ? c.draftCritique : "";
  const whatToSteal = Array.isArray(c.draftWhatToSteal) ? c.draftWhatToSteal.filter((s) => typeof s === "string") : [];
  const antiPatterns = Array.isArray(c.draftAntiPatterns) ? c.draftAntiPatterns.filter((s) => typeof s === "string") : [];
  const observations = [...whatToSteal, ...antiPatterns];

  const rawRisks = Array.isArray(c.draftAccessibilityRisks) ? c.draftAccessibilityRisks : [];
  const accessibilityRisks = rawRisks
    .filter((r) => r && typeof r === "object")
    .map((r) => ({
      element: typeof r.element === "string" ? r.element : "",
      risk: typeof r.risk === "string" ? r.risk : "",
      evidence: typeof r.evidence === "string" ? r.evidence : "",
      wcag: Array.isArray(r.wcag) ? r.wcag.filter((w) => typeof w === "string") : [],
      basis: "visible",
    }));

  return {
    schemaVersion: "1.0",
    platform: typeof c.platform === "string" ? c.platform : "web",
    retrievalMode: "structured-fallback",
    fallbackUsed: true,
    coverage: "moderate",
    summary,
    observations,
    // Legacy shape has no structured recommendations — the scorer reports
    // citationRate "notScorable" for these, which is the intended signal.
    recommendations: [],
    accessibilityRisks,
    visualSlop: [],
    motion: [],
    appliedReferences: [],
    evidenceIds: buildScreenEvidenceIds(extraction ?? {}),
    confidence: "medium",
  };
}

/**
 * Run a single-image eval case: extraction (+ optional critique), scored.
 *
 * @param {EvalCaseInput} input
 * @returns {Promise<Object>} result with extraction/critique scores + latency
 */
export async function runEvalCase(input) {
  const { imagePath, productName, platform, goldPatternType, runCritique, projectRoot, imageId } = input;
  const fullPath = resolve(projectRoot, "corpus", imagePath);

  const result = {
    imageId: imageId ?? null,
    goldPatternType,
    platform,
    extractionModel: null,
    extractionLatencyMs: null,
    extraction: null,
    critique: null,
    critiqueLatencyMs: null,
    critiqueQuality: null,
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

        // Deterministic critique-quality scoring (Task 1/5 wiring). Only runs
        // when a gold label exists for this fixture id; otherwise skipped.
        const goldLabel = imageId ? critiqueQualityLabels.get(imageId) : undefined;
        if (goldLabel) {
          const structured = critiqueToStructured(rawCritique, rawExtraction);
          result.critiqueQuality = scoreCritiqueQuality(structured, goldLabel);
        }
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
