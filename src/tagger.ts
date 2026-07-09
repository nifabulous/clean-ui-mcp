import "./env.js";

/**
 * tagger.ts — two-pass auto-tagging pipeline
 * ───────────────────────────────────────────
 * Pass 1 (extraction): factual/structural fields. Uses deterministic color
 *   quantization (node-vibrant) so the model never guesses hex values — it
 *   maps the extracted swatches to semantic roles.
 * Pass 2 (critique): judgment fields, fed Pass 1's *validated* output as
 *   established fact. Forces an observation step before critique to reduce
 *   generic-first-plausible-answer drift.
 *
 * Env: one of OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY
 * Optional: provider/model env vars (see README)
 */

import { readFileSync } from "node:fs";
import { extname, basename } from "node:path";
import { toCorpusRelativePath } from "./paths.js";
import { Component, DomainTag, detectPlatform } from "./schema.js";
import { isWcagCriterion, extractAllWcagIds } from "./wcag/registry.js";
import { Vibrant } from "node-vibrant/node";
import sharp from "sharp";

// ─── vocab (mirrors schema.ts — keep in sync) ─────────────────────────────────

const CATEGORIES = [
  "dashboard","landing-page","pricing","onboarding","auth","settings",
  "empty-state","navigation","data-table","forms","mobile-nav","notifications",
  "search","checkout","profile","marketing-hero","editor-canvas","chat-interface",
] as const;

const STYLE_TAGS = [
  "minimal","dense-data","editorial","brutalist","playful","monochrome",
  "high-contrast","soft-neumorphic","glassmorphic","retro","technical-mono",
  "warm-tactile","luxury-quiet","bold-color",
] as const;

const COMPONENTS = Component.options;

const DOMAIN_TAGS = DomainTag.options;

const SPACING_DENSITIES = ["compact", "moderate", "spacious"] as const;
const CORNER_STYLES = ["sharp", "slight-round", "pill", "mixed"] as const;

const PATTERN_TYPES = [
  "dashboard","landing-page","pricing","onboarding","auth","settings",
  "search","checkout","profile","marketing-hero","calculator",
  "data-table","empty-state","navigation","forms","mobile-nav",
  "notifications","editor-canvas","chat-interface","command-palette","modal",
] as const;

const LAYOUT_FORMS = ["single-column", "two-column", "three-column", "modal-overlay"] as const;
const LAYOUT_REGION_ROLES = [
  "primary-nav","icon-nav","summary-strip","main-canvas",
  "detail-rail","form-panel","visual-panel","overlay-card",
] as const;

const QUALITY_TIERS = ["exceptional", "cautionary"] as const;
const BUSINESS_GOALS = [
  "increase-conversion",
  "reduce-support-load",
  "build-trust",
  "drive-habitual-use",
  "reduce-cognitive-load-at-decision-point",
  "surface-upsell-opportunity",
  "reduce-churn-risk",
  "establish-credibility",
  "other",
] as const;

// Trust-boundary gates shared by accessibility-risk sanitization and prose
// scrubbing. Pixels can establish visible presence; they cannot prove absence
// of labels/accessibility names or exact measurements.
const PIXEL_MEASUREMENT = /\b\d+(?:\.\d+)?\s*-?\s*(?:px|pixel[s]?|pt|rem|em)\b/i;
const DOM_GROUND_TRUTH = /\b(?:dom|computed|contrast[\s-]*ratio|accessibility\s+tree|aria-|offsetwidth|offsetheight|getboundingclientrect|measured\s+(?:from|via))\b/i;
const UNLABELED_CONTROL_RISK = new RegExp(
  "\\bicon[\\s-]*only" +
  "|icons?\\s+(?:alone|symbols?\\s+alone)" +
  "|icons?\\s+without\\s+(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|represented\\s+(?:solely\\s+)?by\\s+icons?" +
  "|(?:icon|glyph|symbol|button|control)\\s+with\\s+(?:no|without)\\s+(?:a\\s+)?(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|(?:icon|glyph|symbol|button|control)\\s+(?:has|have|having)\\s+no\\s+(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|(?:icon|glyph|symbol|button|control)\\s+lack(?:s|ing)?\\s+(?:a\\s+)?(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|no\\s+(?:visible\\s+)?(?:text\\s+)?labels?\\s+(?:beside|next to|on|for|is visible)" +
  "|no\\s+(?:visible\\s+)?(?:text\\s+)?labels?\\s+(?:are\\s+)?visible" +
  "|(?:has|have)\\s+no\\s+(?:accompanying\\s+)?(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|no\\s+accompanying\\s+(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|lack(?:s|ing)?\\s+(?:an?\\s+|a\\s+)?(?:accompanying\\s+)?(?:visible\\s+)?(?:text\\s+)?labels?" +
  "|no\\s+(?:visible\\s+)?accessible\\s+name" +
  "|unlabeled\\s+(?:icon|button|control|nav)" +
  "|rel(?:iance|ies|y)\\s+on\\s+(?:memorized\\s+)?(?:icon\\s+)?shapes?" +
  "|\\bnaked\\s+icons?\\b" +
  "|lacks?\\s+(?:an?\\s+)?accessible\\s+name" +
  "|without\\s+(?:an?\\s+)?accessible\\s+name" +
  "\\b",
  "i",
);
const LOW_CONTRAST_RISK = /\b(?:low|poor|insufficient|fail(?:s|ing)?|below|under|not enough|too little)\b.{0,60}\bcontrast\b|\bcontrast\b.{0,60}\b(?:low|poor|insufficient|fail(?:s|ing)?|below|under|ratio|threshold|4\.5)\b/i;
// A risk list must only contain confirmed failures. Models occasionally emit a
// useful observation followed by "likely accessible" / "no risk confirmed";
// that commentary belongs in critique prose, never in accessibilityRisks.
const NON_RISK_ASSERTION = /\b(?:no (?:accessibility )?risk (?:is )?(?:confirmed|identified)|likely accessible|text (?:label|labels?|content)?\s*(?:provides?|conveys?)\s+redundant (?:information|state)|(?:is|are)\s+(?:fully\s+)?accessible)\b/i;

// ─── banned phrases — enforced in-prompt AND as a post-hoc code-level gate ───

const BANNED_PHRASES = [
  "clean layout", "modern design", "user-friendly", "intuitive", "sleek",
  "minimalist", "good spacing", "nice typography", "visually appealing",
  "easy to use", "well-organized", "polished look",
];

// ─── types ────────────────────────────────────────────────────────────────────

export interface TaggerInput {
  imagePath:   string;
  productName: string;
  url?:        string | null;
  id?:         string;
  /**
   * Image fidelity for the vision pass. "high" (default) = best extraction.
   * "low" = cheapest; the adaptive path re-runs at "high" only when "low"
   * produced a weak result. Bulk imports pass "low" to cut token cost.
   */
  imageDetail?: "low" | "high";
  /**
   * Run only Pass 1 (extraction). Critique/steals/antiPatterns come back as
   * [DRAFT — critique deferred] placeholders; the client runs Pass 2 later via
   * /api/auto-critique. Halves per-image cost for bulk batches.
   */
  extractionOnly?: boolean;
  /**
   * Per-call provider overrides (used by /api/auto-retag to route a specific
   * run through a chosen provider without mutating process.env, which would
   * race across concurrent requests). Falls back to resolveProvider() when
   * unset. Mistral/DeepSeek are text-only — if chosen for extraction, the
   * resolver falls back to a vision provider with a console warning.
   */
  extractionProvider?: Provider;
  critiqueProvider?: Provider;
  /**
   * DOM signals from the capture pipeline (dom-signals.json sidecar). When
   * present, injected into the extraction prompt as VERIFIED GROUND TRUTH so
   * the model gets real computed styles/a11y/structure instead of guessing
   * from pixels. The bodyFont is also overridden post-hoc (first family name
   * parsed from fontFamily). Copy/outline/childCount excluded — copy risks
   * prompt injection, outline/childCount are low-signal noise.
   */
  domSignals?: {
    styles: { fontFamily: string | null; fontSize: string | null; fontWeight: string | null;
              borderRadius: string | null; boxShadow: string | null; color: string | null;
              background: string | null; letterSpacing: string | null };
    accessibility: { contrastRatio: number | null; headingLevels: number[];
                     imagesMissingAlt: number; unlabeledInteractive: number; hasSkipLink: boolean };
    structure: { display: string | null; flexDirection: string | null;
                 gridTemplateColumns: string | null; gap: string | null };
  } | null;
}

export interface TaggerOutput {
  id:             string;
  title:          string;
  patternType:    string;
  patternDiscovery?: { suggestedPatternType: string };
  platform?:      "web" | "mobile" | "tablet";
  categories:     string[];
  styleTags:      string[];
  components:     string[];
  domainTags?:    string[];
  colorScheme?:   string;
  industryVertical?: string;
  responsiveBehavior?: string;
  source: {
    productName: string;
    url:         string | null;
    capturedAt:  string;
    capturedBy:  "self" | "automated-collection";
  };
  image: {
    visibility: "private";
    path:       string;
    width:      number | null;
    height:     number | null;
  };
  visual: {
    dominantColors: string[];
    accentColor:    string | null;
    colorRoles?: {
      canvas:  string;
      surface: string;
      ink:     string;
      muted:   string | null;
      accent:  string;
    };
    typePairing: {
      display: string | null;
      body:    string | null;
      notes:   string;
    };
    spacingDensity: string;
    cornerStyle:    string;
    usesShadows:    boolean;
    usesBorders:    boolean;
  };
  critique:        string;
  whatToSteal:     string[];
  antiPatterns: {
    antiPatterns:       string[];
    whereThisFails:     string[];
    accessibilityRisks: Array<{ element: string; risk: string; evidence: string; confidence: string; wcag: string[] }>;
  };
  layout?: {
    form: string;
    regions: Array<{ role: string; width?: string }>;
  };
  businessRationale?: {
    businessGoal: string;
    targetUser: string;
    rationale: string;
    confirmed: boolean;
  };
  voice?: {
    tone: string;
    examples: string[];
    avoid: string[];
  };
  mood?:           string;
  qualityTier:     string;
  qualityScore:    number;
  tierChangeJustification?: string;
  addedAt:         string;
  provenance?:     { taggedBy: "human" | "auto" | "auto-reviewed"; reviewedBy?: string };
  _raw?: Record<string, unknown>;
}

// ─── deterministic color extraction (node-vibrant) ───────────────────────────

/**
 * Extract dominant colors via pixel quantization — deterministic, code-level,
 * not model-guessed. The model receives these as ground truth and maps them to
 * semantic roles; it never invents hex values.
 */
export async function extractQuantizedColors(imagePath: string): Promise<string[]> {
  const palette = await Vibrant.from(imagePath).getPalette();
  return Object.values(palette)
    .filter((s): s is NonNullable<typeof s> => s !== null)
    .sort((a, b) => b.population - a.population)
    .slice(0, 6)
    .map((s) => s.hex.toLowerCase());
}

// ─── system prompt (shared across both passes) ───────────────────────────────

const SYSTEM = `You are a senior UI/UX designer writing critiques for a curated design corpus.
The corpus's entire value is in SPECIFIC, ACCURATE design reasoning — not generic descriptions
any screenshot could earn. Never use these banned phrases or close paraphrases of them:
${BANNED_PHRASES.map((p) => `"${p}"`).join(", ")}.

For every notable decision, name three things:
1. The DECISION (the specific, reproducible choice — a property, a value, a rule)
2. The EFFECT (why it works — what it does perceptually or functionally)
3. The REJECTION (the conventional default it deliberately avoids, and why that default is worse here)

Rules that apply to every field you write:
- If a value was supplied to you as ground truth (from deterministic color extraction), treat it as
  fact. Do not re-guess, contradict, or "round" it.
- Two different fields must never restate the same single observation from two angles.
- Prefer the most specific thing visible on screen over the first plausible-sounding observation.
- Before returning, re-read your own output against the banned-phrase list. Rewrite any field that
  contains one, or a close paraphrase of one.

Return ONLY valid JSON, no markdown fences, no extra keys beyond what's requested.`;

const OPENAI_RESPONSES_API = "https://api.openai.com/v1/responses";

/**
 * Per-pass OpenAI-compatible provider config. Supports a split setup where
 * extraction and critique use different OpenAI-compatible endpoints — e.g.
 * real OpenAI for extraction (vision) and NVIDIA NIM's DeepSeek V4 for
 * critique (writing). Resolution order per field:
 *
 *   OPENAI_BASE_URL_<PASS>     → OPENAI_BASE_URL     → "" (real OpenAI)
 *   OPENAI_API_KEY_<PASS>      → OPENAI_API_KEY      → (error if missing)
 *   OPENAI_AUTO_TAG_MODEL_<PASS> → OPENAI_AUTO_TAG_MODEL → "gpt-5.4-nano"
 *
 * Where <PASS> is EXTRACTION or CRITIQUE. So the split-provider DeepSeek setup
 * is just:
 *
 *   AUTO_TAG_PROVIDER_EXTRACTION=openai
 *   AUTO_TAG_PROVIDER_CRITIQUE=openai
 *   OPENAI_API_KEY=<real openai key>
 *   OPENAI_AUTO_TAG_MODEL=gpt-5.4-mini
 *   OPENAI_BASE_URL_CRITIQUE=https://integrate.api.nvidia.com/v1
 *   OPENAI_API_KEY_CRITIQUE=nvapi-...
 *   OPENAI_AUTO_TAG_MODEL_CRITIQUE=deepseek-ai/deepseek-v4-pro
 *
 * When OPENAI_BASE_URL (or the per-pass variant) is set, calls route to the
 * /chat/completions path (the universal OpenAI-compatible format that NIM,
 * OpenRouter, Together, Groq, vLLM all speak). When unset, real OpenAI keeps
 * the native /v1/responses path — untouched behavior.
 */
interface OpenAIConfig { baseUrl: string; apiKey: string; model: string; }
function openaiConfigForPass(pass: TaggerPass): OpenAIConfig {
  const tier = pass.toUpperCase(); // "EXTRACTION" | "CRITIQUE"
  const baseUrl = (process.env[`OPENAI_BASE_URL_${tier}`] ?? process.env.OPENAI_BASE_URL ?? "").replace(/\/+$/, "");
  const apiKey = process.env[`OPENAI_API_KEY_${tier}`] ?? process.env.OPENAI_API_KEY ?? "";
  const model = process.env[`OPENAI_AUTO_TAG_MODEL_${tier}`] ?? process.env.OPENAI_AUTO_TAG_MODEL ?? "gpt-5.4-nano";
  return { baseUrl, apiKey, model };
}
// Mistral config — same shape as OpenAIConfig since Mistral's API is
// OpenAI-compatible. Points at La Plateforme by default; override the base
// URL with MISTRAL_BASE_URL to route through a compatible gateway/router.
function mistralConfigForPass(pass: TaggerPass): OpenAIConfig {
  const tier = pass.toUpperCase();
  const model = process.env[`MISTRAL_AUTO_TAG_MODEL_${tier}`] ?? MISTRAL_AUTO_TAG_MODEL;
  const baseUrl = (process.env.MISTRAL_BASE_URL ?? MISTRAL_API_BASE).replace(/\/+$/, "");
  return { baseUrl, apiKey: process.env.MISTRAL_API_KEY ?? "", model };
}
// MiniMax config — same shape (OpenAI-compatible API). Unlike Mistral, M3 is
// native multimodal so it handles BOTH passes including vision extraction.
function minimaxConfigForPass(pass: TaggerPass): OpenAIConfig {
  const tier = pass.toUpperCase();
  const model = process.env[`MINIMAX_AUTO_TAG_MODEL_${tier}`] ?? MINIMAX_AUTO_TAG_MODEL;
  const baseUrl = (process.env.MINIMAX_BASE_URL ?? MINIMAX_API_BASE).replace(/\/+$/, "");
  return { baseUrl, apiKey: process.env.MINIMAX_API_KEY ?? "", model };
}
// Grok config — same shape (OpenAI-compatible API at api.x.ai). Native
// multimodal so it handles BOTH passes including vision extraction.
function grokConfigForPass(pass: TaggerPass): OpenAIConfig {
  const tier = pass.toUpperCase();
  const model = process.env[`XAI_AUTO_TAG_MODEL_${tier}`] ?? XAI_AUTO_TAG_MODEL;
  const baseUrl = (process.env.XAI_BASE_URL ?? XAI_API_BASE).replace(/\/+$/, "");
  return { baseUrl, apiKey: process.env.XAI_API_KEY ?? "", model };
}
// Some OpenAI-compatible providers expose a thinking toggle via the
// `chat_template_kwargs` extension. NVIDIA NIM's DeepSeek V4 takes
// {"chat_template_kwargs": {"thinking": false}}. Default: thinking ON for the
// critique pass (DeepSeek's strength is reasoning), OFF for extraction
// (deterministic fields don't benefit, and reasoning can push responses
// toward max_tokens truncation on long outputs). Override globally with
// OPENAI_THINKING_DISABLED=1 (forces OFF for both passes).
// NOTE: the regex matches the truthy values ("1"/"true") so the constant is
// true when the user asks to disable thinking. (An earlier version matched
// "0"/"false", which inverted the flag — setting =1 silently did nothing.)
const OPENAI_THINKING_DISABLED = /^(1|true)$/i.test(process.env.OPENAI_THINKING_DISABLED ?? "");
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";
// Mistral's chat API is OpenAI-compatible: Bearer auth, /v1/chat/completions.
const MISTRAL_API_BASE = "https://api.mistral.ai/v1";
// MiniMax M3 — native multimodal MoE (428B total / 23B activated), 1M context.
// OpenAI-compatible API. Can do BOTH passes (vision extraction + critique),
// unlike Mistral (text-only). Cheaper than Claude for critique ($0.30/$1.20 vs
// $3/$15 per M tokens). Override the base URL via MINIMAX_BASE_URL to route
// through a gateway.
const MINIMAX_API_BASE = "https://api.minimax.io/v1";
// xAI Grok — native multimodal, OpenAI-compatible API at api.x.ai/v1.
// Handles BOTH passes (vision extraction + critique). Priced at $2/$6 per M
// tokens. Override the base URL via XAI_BASE_URL to route through a gateway.
const XAI_API_BASE = "https://api.x.ai/v1";

const OPENAI_AUTO_TAG_MODEL = process.env.OPENAI_AUTO_TAG_MODEL ?? "gpt-5.4-nano";
const CLAUDE_AUTO_TAG_MODEL = process.env.CLAUDE_AUTO_TAG_MODEL ?? "claude-haiku-4-5";
const GEMINI_AUTO_TAG_MODEL = process.env.GEMINI_AUTO_TAG_MODEL ?? "gemini-2.5-flash";
// Mistral Large — text-only flagship. Critique-only (no vision). Override the
// base URL via MISTRAL_BASE_URL to route through a compatible gateway.
const MISTRAL_AUTO_TAG_MODEL = process.env.MISTRAL_AUTO_TAG_MODEL ?? "mistral-large-latest";
// MiniMax M3 — native multimodal, both passes. Cheaper critique alternative to
// Claude; also vision-capable for extraction. Override via MINIMAX_BASE_URL.
const MINIMAX_AUTO_TAG_MODEL = process.env.MINIMAX_AUTO_TAG_MODEL ?? "MiniMax-M3";
// Grok 4.5 — xAI's flagship, multimodal. Override via XAI_AUTO_TAG_MODEL.
const XAI_AUTO_TAG_MODEL = process.env.XAI_AUTO_TAG_MODEL ?? "grok-4.5";

// Set DEBUG_TAGGER=1 to print per-call provider config and token usage to stderr.
// Quiet by default so production logs (npm run ui, bulk-import) stay clean.
const DEBUG_TAGGER = /^(1|true)$/i.test(process.env.DEBUG_TAGGER ?? "");

// 8192 fits all three providers comfortably. Gemini/Claude critiques rarely
// exceed ~700 tokens; DeepSeek V4 Pro on NIM (with thinking=true) routinely
// runs longer — its reasoning tokens come out of the same max_tokens budget,
// so a 4200 cap truncated critiques mid-stream and broke JSON parsing
// (the same failure mode that prompted thinkingBudget:0 on Gemini 2.5).
// 8192 is well under DeepSeek's 16384 hard limit and adds negligible cost.
const MAX_OUTPUT_TOKENS = 8192;

// Transient provider errors (502/503/504, "overloaded", "high demand", network
// resets) are common under load — Gemini in particular returns 503 "This model
// is currently experiencing high demand" during peak hours. Retrying with
// backoff turns a batch-killing transient into a brief delay.
//
// 429 rate-limit responses are ALSO retried, but only when the provider gives a
// retry hint — Gemini embeds `retryDelay: "12s"` in the error body, OpenAI and
// Anthropic use the `Retry-After` header. Free-tier per-minute quotas (e.g.
// Gemini 3.5 Flash at 5 RPM) reset every 60s, so the hint is the right wait.
// Capped at MAX_429_WAIT_MS so a daily-quota "retry in 1h" surfaces to the user
// instead of hanging the batch. Without a hint, surface the error (let the user
// decide whether to wait or switch keys) — same behavior as before.
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 800;
// Upper bound on how long to wait for a 429 retry. Long enough to ride out a
// per-minute quota reset (~60s worst case); a longer hint usually means the
// daily/project quota is exhausted and the batch should stop, not stall.
const MAX_429_WAIT_MS = 30_000;
// Fallback wait when a 429 carries no retry hint but doesn't look like a hard
// quota error either (e.g. NVIDIA NIM returns a bare {"status":429,"title":"Too
// Many Requests"} with no Retry-After header). Per-minute quotas on most
// providers (NIM, OpenRouter free tier, Groq) reset within ~60s, so waiting a
// bit past that window turns a batch-killing burst of 429s into a brief pause.
// Tuned slightly above 60s to be safe against clock skew on the provider side.
const FALLBACK_429_WAIT_MS = 65_000;

/**
 * fetch() wrapper that retries transient failures with exponential backoff.
 * Retries on: 502/503/504, network errors (ECONNRESET, fetch TypeError), and
 * provider bodies mentioning "overloaded"/"high demand"/"temporarily".
 * Does NOT retry 4xx (auth/validation/quota) — those are deterministic.
 */
async function fetchWithRetry(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const response = await fetch(input, init);
      // 429 with a retry hint (per-minute quota reset) — wait and retry. The
      // hint may be in the Retry-After header (OpenAI/Anthropic) or in the
      // error body (Gemini). Free-tier per-minute limits reset quickly, so this
      // turns a batch-killing rate-limit into a brief delay.
      if (response.status === 429 && attempt < MAX_RETRIES) {
        const text = await response.text().catch(() => "");
        const wait = extract429Wait(response.headers, text);
        if (wait !== null) {
          await sleep(wait);
          continue; // re-fetch with a fresh Request body
        }
        // No explicit hint. Distinguish "hard quota exhausted" (prepaid depleted,
        // daily cap reached — surface to caller) from "transient per-minute limit
        // with no hint provided" (NIM, some OpenRouter routes — wait and retry).
        // The signal: hard-quota bodies typically say "quota"/"billing"/"credit"/
        // "prepay"/"depleted"; a bare "Too Many Requests" with no such language
        // is almost always a per-minute throttle that resets in ~60s.
        const looksLikeHardQuota = /quota|billing|credit|prepay|deplet|exhausted|plan.*limit/i.test(text);
        if (!looksLikeHardQuota) {
          if (DEBUG_TAGGER) console.error(`[tagger] 429 with no retry hint — waiting ${FALLBACK_429_WAIT_MS}ms (transient per-minute limit suspected)`);
          await sleep(FALLBACK_429_WAIT_MS);
          continue;
        }
        // Hard quota → surface to the caller (don't stall the batch).
        return new Response(text, { status: response.status, headers: response.headers });
      }
      // Peek at the body once for the transient check; re-wrap for the caller.
      if (response.status >= 500 && response.status <= 599 && attempt < MAX_RETRIES) {
        const text = await response.text().catch(() => "");
        if (transientServerError(response.status, text)) {
          await sleep(RETRY_BASE_MS * 2 ** attempt);
          continue; // re-fetch with a fresh Request body
        }
        // Non-transient 5xx or out of retries — return the original error shape.
        return new Response(text, { status: response.status, headers: response.headers });
      }
      return response;
    } catch (error) {
      lastError = error;
      // Network-level errors (DNS, connection reset, abort) are transient.
      if (attempt < MAX_RETRIES && isNetworkError(error)) {
        await sleep(RETRY_BASE_MS * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Provider request failed after retries");
}

/**
 * Extract a 429 retry delay (ms, capped at MAX_429_WAIT_MS) from a provider
 * response. Returns null if no actionable hint is present — in that case the
 * caller should surface the error rather than guess a wait time.
 *
 * Sources, in priority order:
 *   1. Gemini error body: `"retryDelay": "12s"` (or `Please retry in 12.9s.`)
 *   2. Retry-After header (OpenAI/Anthropic): seconds, or HTTP-date
 *   3. OpenAI's non-standard x-ratelimit-reset-requests / x-ratelimit-reset-tokens
 *      headers. OpenAI does NOT send Retry-After on 429s — without parsing
 *      these, every OpenAI rate-limit surfaced to the user as a hard error
 *      instead of retrying. Format: "<N>s", "<N>m", "<N>ms", "<N>h", or the
 *      literal "≤1s" for sub-second windows.
 *
 * If the hint exceeds MAX_429_WAIT_MS, returns null — a long hint typically
 * means the daily/project quota is exhausted, and the batch should stop rather
 * than stall for an hour.
 */
function extract429Wait(headers: Headers, body: string): number | null {
  // Gemini-style: parse "retryDelay":"12s" or "Please retry in 12.915582564s"
  const bodyMatch = body.match(/(?:retryDelay"?\s*:\s*"|Please retry in\s*)(\d+(?:\.\d+)?)s/i);
  if (bodyMatch) {
    const ms = Math.ceil(parseFloat(bodyMatch[1]) * 1000);
    return ms <= MAX_429_WAIT_MS ? ms : null;
  }
  // Header-style: Retry-After (seconds or HTTP-date)
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const asSeconds = parseInt(retryAfter, 10);
    if (!Number.isNaN(asSeconds)) {
      const ms = asSeconds * 1000;
      return ms <= MAX_429_WAIT_MS ? ms : null;
    }
    // HTTP-date form — compute delta, still cap it.
    const dateMs = Date.parse(retryAfter);
    if (!Number.isNaN(dateMs)) {
      const ms = Math.max(0, dateMs - Date.now());
      return ms <= MAX_429_WAIT_MS ? ms : null;
    }
  }
  // OpenAI's non-standard reset headers. They return BOTH — one for the
  // requests-per-minute window, one for the tokens-per-minute window. Take
  // the LONGER of the two, since we need both to reset before retry succeeds.
  const resetRequests = parseOpenAIResetHeader(headers.get("x-ratelimit-reset-requests"));
  const resetTokens = parseOpenAIResetHeader(headers.get("x-ratelimit-reset-tokens"));
  if (resetRequests !== null || resetTokens !== null) {
    const ms = Math.max(resetRequests ?? 0, resetTokens ?? 0);
    if (ms > 0) return ms <= MAX_429_WAIT_MS ? ms : null;
  }
  return null;
}

/**
 * Parse OpenAI's x-ratelimit-reset-* header values into milliseconds.
 * Format: "<N>s" | "<N>m" | "<N>ms" | "<N>h" | "≤1s" (the literal sub-second
 * sentinel OpenAI uses when the window resets in under a second). Returns
 * null for unrecognized/absent values — the caller treats null as "no hint."
 */
function parseOpenAIResetHeader(value: string | null): number | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  // Sub-second sentinel: "≤1s" or "<=1s" — treat as 1s minimum wait.
  if (/^[≤<]=?\s*1s$/.test(v)) return 1000;
  // "<N>ms" — must check before "<N>s" so the suffix matches correctly.
  const msMatch = v.match(/^(\d+(?:\.\d+)?)ms$/);
  if (msMatch) return Math.ceil(parseFloat(msMatch[1]));
  // "<N>s"
  const sMatch = v.match(/^(\d+(?:\.\d+)?)s$/);
  if (sMatch) return Math.ceil(parseFloat(sMatch[1]) * 1000);
  // "<N>m" (minutes)
  const mMatch = v.match(/^(\d+(?:\.\d+)?)m$/);
  if (mMatch) return Math.ceil(parseFloat(mMatch[1]) * 60_000);
  // "<N>h" (hours — rare on rate limits, usually means quota exhaustion)
  const hMatch = v.match(/^(\d+(?:\.\d+)?)h$/);
  if (hMatch) return Math.ceil(parseFloat(hMatch[1]) * 3_600_000);
  return null;
}

function transientServerError(status: number, body: string): boolean {
  if (status === 502 || status === 503 || status === 504) return true;
  return /overloaded|high demand|temporarily|try again|service unavailable/i.test(body);
}

function isNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  // fetch() throws TypeError on network failures; Node adds codes for resets.
  const anyError = error as Error & { code?: string };
  if (anyError.code && /ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|UND_ERR_SOCKET/.test(anyError.code)) return true;
  return error instanceof TypeError; // fetch() network failure
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Provider = "openai" | "claude" | "gemini" | "mistral" | "minimax" | "grok";
type TaggerPass = "extraction" | "critique";

// ─── peak-hour DeepSeek → MiniMax/Claude routing ────────────────────────────
// DeepSeek adopts peak-valley pricing starting mid-July 2026: peak UTC windows
// 1:00–4:00 AM and 6:00–10:00 AM are 2× the regular price. During these windows
// we auto-route critique to MiniMax (cheaper, similar quality) or Claude (the
// quality benchmark) to avoid paying double. Extraction is unaffected (different
// provider). Explicit per-call overrides bypass this entirely.
const DEEPSEEK_PEAK_HOURS: ReadonlyArray<[number, number]> = [[1, 4], [6, 10]];

/** True when the current UTC hour falls within a DeepSeek peak pricing window. */
export function isDeepSeekPeakHour(now = new Date()): boolean {
  const h = now.getUTCHours();
  return DEEPSEEK_PEAK_HOURS.some(([start, end]) => h >= start && h < end);
}

/** True when the critique pass would run on DeepSeek (reached through the
 *  "openai" provider via OPENAI_AUTO_TAG_MODEL_CRITIQUE or the fallback model). */
export function isDeepSeekCritique(): boolean {
  const model = openaiConfigForPass("critique").model;
  return /deepseek/i.test(model);
}

/** Resolve which provider to use for a given pass, with auto-fallback.
 *  Optional `override` (from /api/auto-retag or the SPA dropdown) short-circuits
 *  env resolution — used for per-run provider selection without mutating process.env. */
function resolveProvider(pass: TaggerPass, override?: Provider): Provider {
  // Explicit override from the caller (bulk re-tag, SPA dropdown). Validate capability:
  // extraction needs vision, so mistral (text-only) falls back with a warning.
  if (override) {
    if (pass === "extraction" && override === "mistral") {
      console.error("[tagger] mistral cannot do extraction (text-only) — falling back to env resolver for extraction.");
    } else if (override === "mistral" && !process.env.MISTRAL_API_KEY) {
      console.error("[tagger] override=mistral but MISTRAL_API_KEY not set — falling back to env resolver.");
    } else {
      return override;
    }
  }
  const envVar = pass === "extraction" ? "AUTO_TAG_PROVIDER_EXTRACTION" : "AUTO_TAG_PROVIDER_CRITIQUE";
  let preferred = (process.env[envVar] ?? process.env.AUTO_TAG_PROVIDER ?? "openai").toLowerCase() as Provider;
  // Capability guard for the ENV path (mirrors the override guard above):
  // Mistral is text-only and cannot do the vision extraction pass. If the env
  // resolves to mistral for extraction, log + fall through to the fallback
  // search rather than sending an image to a text-only model.
  if (pass === "extraction" && preferred === "mistral") {
    console.error(`[tagger] ${envVar}="mistral" but Mistral is text-only (no vision) — falling back to a vision provider for extraction.`);
    preferred = "openai"; // will fall through to the has-check + fallback loop below
  }
  // OpenAI keys may be set per-pass (OPENAI_API_KEY_EXTRACTION / _CRITIQUE) for
  // split-provider setups — e.g. real OpenAI for extraction (vision) and NIM
  // for critique (writing). Honor the per-pass variant when checking presence.
  const tier = pass.toUpperCase();
  const has = {
    openai: !!(process.env[`OPENAI_API_KEY_${tier}`] ?? process.env.OPENAI_API_KEY),
    claude: !!process.env.ANTHROPIC_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
    mistral: !!process.env.MISTRAL_API_KEY,
    minimax: !!process.env.MINIMAX_API_KEY,
    grok: !!process.env.XAI_API_KEY,
  };
  // Peak-hour routing: if the critique pass resolved to "openai" AND the
  // configured critique model is DeepSeek AND we're in a peak window, swap to
  // MiniMax (or Claude as fallback) to avoid 2× pricing. Only applies when no
  // explicit override was given (override wins, user chose deliberately).
  if (pass === "critique" && !override && preferred === "openai" && isDeepSeekCritique() && isDeepSeekPeakHour()) {
    if (has.minimax) {
      console.error(`[tagger] Peak-hour routing: DeepSeek → MiniMax (UTC ${new Date().getUTCHours()}:00) to avoid 2× peak pricing.`);
      return "minimax";
    }
    if (has.claude) {
      console.error(`[tagger] Peak-hour routing: DeepSeek → Claude (UTC ${new Date().getUTCHours()}:00) — MiniMax key not set.`);
      return "claude";
    }
    console.error(`[tagger] Peak-hour warning: DeepSeek is 2× price now (UTC ${new Date().getUTCHours()}:00) but no MiniMax/Claude key set — using DeepSeek anyway.`);
  }
  if (has[preferred]) return preferred;
  for (const p of ["openai", "claude", "gemini", "mistral", "minimax", "grok"] as const) {
    if (has[p]) {
      console.error(`[tagger] ${envVar}="${preferred}" but no key set — falling back to ${p} for ${pass}.`);
      return p;
    }
  }
  return preferred;
}

/** Check if ANY vision-capable provider key is configured.
 *  Counts ONLY extraction-capable keys — OPENAI_API_KEY_CRITIQUE is text-only
 *  (NIM/DeepSeek for critique) and must NOT satisfy this gate, or the UI will
 *  advertise auto-tagging and then fail at the vision extraction pass. */
export function hasVisionKey(): boolean {
  const hasOpenAIExtraction = !!(
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY_EXTRACTION
  );
  // MiniMax M3 and Grok 4.5 are native multimodal (unlike Mistral which is
  // text-only), so they qualify as vision-capable providers for extraction.
  return !!(hasOpenAIExtraction || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY || process.env.MINIMAX_API_KEY || process.env.XAI_API_KEY);
}

/** Check if ANY critique-capable provider key is configured.
 *  Broader than hasVisionKey: includes text-only keys (MISTRAL_API_KEY,
 *  OPENAI_API_KEY_CRITIQUE for NIM/DeepSeek). Used by critique-only paths
 *  (generateCritique, /api/auto-critique) that don't need vision.
 *  Does NOT count OPENAI_API_KEY_EXTRACTION — openaiConfigForPass("critique")
 *  reads OPENAI_API_KEY_CRITIQUE or bare OPENAI_API_KEY, not the extraction
 *  variant, so counting it here would pass the gate then fail at the call. */
export function hasCritiqueKey(): boolean {
  return !!(
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY_CRITIQUE ||
    process.env.ANTHROPIC_API_KEY ||
    process.env.GEMINI_API_KEY ||
    process.env.MISTRAL_API_KEY ||
    process.env.MINIMAX_API_KEY ||
    process.env.XAI_API_KEY
  );
}

const PROVIDER_NAMES: Record<Provider, string> = { openai: "OpenAI", claude: "Claude", gemini: "Gemini", mistral: "Mistral", minimax: "MiniMax", grok: "Grok" };
const PROVIDER_MODELS: Record<Provider, string> = { openai: OPENAI_AUTO_TAG_MODEL, claude: CLAUDE_AUTO_TAG_MODEL, gemini: GEMINI_AUTO_TAG_MODEL, mistral: MISTRAL_AUTO_TAG_MODEL, minimax: MINIMAX_AUTO_TAG_MODEL, grok: XAI_AUTO_TAG_MODEL };

/** Human-readable provider name for UI display. */
export function activeProviderName(pass?: TaggerPass): string {
  return PROVIDER_NAMES[resolveProvider(pass ?? "extraction")];
}

/** Active model name for UI display. */
export function activeModelName(pass?: TaggerPass): string {
  const resolvedPass = pass ?? "extraction";
  const provider = resolveProvider(resolvedPass);
  // For the OpenAI path, the static PROVIDER_MODELS map reports the OpenAI
  // default even when a per-pass override (OPENAI_AUTO_TAG_MODEL_CRITIQUE etc.)
  // routes the call to a different endpoint — e.g. critique actually running on
  // NVIDIA NIM's DeepSeek V4 while /api/config reported "gpt-5.4-mini". Resolve
  // through openaiConfigForPass so the reported model matches the call.
  if (provider === "openai") return openaiConfigForPass(resolvedPass).model;
  if (provider === "grok") return grokConfigForPass(resolvedPass).model;
  return PROVIDER_MODELS[provider];
}

// ─── PASS 1: extraction prompt (facts + geometry) ────────────────────────────

function buildExtractionPrompt(
  productName: string,
  url: string | null | undefined,
  quantizedColors: string[],
  platform: string,
  domSignals?: TaggerInput["domSignals"],
): string {
  // Platform instruction — the model can't reliably infer "this is a phone"
  // from pixels alone, and hallucinates desktop side rails on portrait mobile.
  const platformInstruction = platform === "mobile"
    ? `DETECTED PLATFORM: mobile (portrait phone). Do NOT propose desktop-only components like sidebar-nav — a phone screen cannot contain a side rail. Use bottom-nav for the bottom tab bar, action-list for stacked action/funding-option rows, and tab-nav for segmented tabs. Only include components that have a visible instance on screen.`
    : platform === "web"
      ? `DETECTED PLATFORM: web (landscape/desktop). Do NOT propose mobile-only components like bottom-nav.`
      : ""; // tablet — ambiguous, let the model decide
  // When no product name was supplied, ask the model to read it off the page
  // (wordmark/logo/branding are almost always visible). Empty name must NOT
  // block import — the upload already happened; gating on a manual field wastes
  // that work. The model fills `productName` below; we use it in pass 2 + output.
  const supplied = (productName || "").trim();
  const lead = supplied
    ? `Analyse this screenshot of ${url ? `${supplied} (${url})` : `${supplied} (uploaded screenshot; no source URL provided)`}.`
    : `Analyse this screenshot. No product name was supplied — identify the product from its wordmark / logo / branding and put it in the \`productName\` field. If genuinely unidentifiable, use "Untitled".${url ? ` Source URL for context: ${url}` : ""}`;
  const nameField = supplied
    ? ""
    : `  "productName": "",       // the product name read from the page (wordmark/logo). Required when no name was supplied.\n`;
  // DOM-signal ground truth block (mirrors the quantizedColors pattern).
  // Only styles/accessibility/structure injected — copy excluded (prompt-injection
  // risk), outline/childCount excluded (low signal). The model is told to treat
  // these as fact for bodyFont/usesShadows/spacingDensity and not contradict.
  const domSignalsBlock = domSignals
    ? `\nVERIFIED DOM SIGNALS — computed-style ground truth from the live page:\n${JSON.stringify({
        styles: domSignals.styles,
        accessibility: domSignals.accessibility,
        structure: domSignals.structure,
      }, null, 2)}\n`
    : "";

  return `${lead}
Return a JSON object with exactly these fields.
This is an EXTRACTION pass — factual/structural fields only, no critique yet.

A supplied product name is a provenance label, not visual evidence; URLs can be generic, stale, or
misleading too. The screenshot always wins. Do not infer a typical product shell, page type, or component
from the product name, industry, filename, or URL when it is not visibly present.
${platformInstruction ? `\n${platformInstruction}\n` : ""}
VERIFIED GROUND TRUTH — treat every value below as fact, do not re-derive or contradict it:
${JSON.stringify({ quantizedColors }, null, 2)}
${domSignalsBlock}
{
${nameField}  "patternType": "",       // ONE from: ${PATTERN_TYPES.join(", ")}. If none fit well, use
                           // the closest match AND set suggestedPatternType below.
  "suggestedPatternType": null, // DISCOVERY LANE — when patternType is a forced/closest fit, name
                           // what the pattern REALLY is in kebab-case (e.g. "kanban-board",
                           // "activity-feed", "monitoring-console", "calendar-view"). Null when
                           // patternType is accurate. This goes into _raw for the curator to
                           // review — it never replaces the canonical patternType.
  "categories": [],        // 1-3 from: ${CATEGORIES.join(", ")}
  "styleTags": [],         // 1-3 from: ${STYLE_TAGS.join(", ")}
  "components": [],        // 3-10 visible UI building blocks from: ${COMPONENTS.join(", ")}
  "domainTags": [],        // 0-4 from: ${DOMAIN_TAGS.join(", ")}. The BUSINESS context of the
                           // page — read it off nav labels, breadcrumbs, headings, page titles
                           // (e.g. a "Settings / Billing and Usage" breadcrumb → billing, usage).
                           // Example: "Settings / Integrations" -> domainTags:["integrations"].
                           // Leave [] if there's no clear business-domain signal.
  "colorScheme": "",       // ONE from: light, dark. The page-level background theme.
  "industryVertical": "",  // ONE industry the product belongs to (fintech, devtools, healthcare,
                           // e-commerce, media, education, enterprise-saas, consumer-social,
                           // productivity, security, ai-ml, crypto, real-estate, legal, travel).
                           // Infer from product name, copy, visual language. Leave "" if unclear.
  "responsiveBehavior": "",// ONE from: responsive, fixed-width, adaptive. Whether the layout
                           // adapts to viewport. "responsive" = fluid grid that reflows; "fixed-width"
                           // = centered max-width container that doesn't reflow; "adaptive" =
                           // distinct layouts per breakpoint. Infer from visible container behavior.
  "dominantColors": [],    // copy from quantizedColors verbatim — do not invent hex values not in that list
  "accentColor": null,     // pick the primary interactive/brand color FROM quantizedColors only
  "displayFont": null,     // name if you're confident; null beats a wrong guess
  "bodyFont": null,        // if DOM signals provide fontFamily, use that name — do not contradict
  "spacingDensity": "",    // one of: compact, moderate, spacious. If DOM signals provide fontSize/gap, use them to inform density.
  "cornerStyle": "",       // one of: sharp, slight-round, pill, mixed. If DOM signals provide borderRadius, use it.
  "usesShadows": false,    // if DOM signals provide boxShadow, non-null = shadows present
  "usesBorders": false,    // true if borders/dividers are used for layout structure
  "colorRoles": null,      // {canvas, surface, ink, muted, accent} — map dominantColors to semantic
                           // roles (what each is FOR). This IS a judgment call. Omit if unsure.
  "layoutForm": "",        // ONE from: ${LAYOUT_FORMS.join(", ")}. Omit if not structural.
  "layoutRegions": [],     // ordered {role, width}. role from: ${LAYOUT_REGION_ROLES.join(", ")}.
                           // width from: fixed-narrow, flex, fixed-wide. Only if layoutForm is set.
}

Rules:
- dominantColors and accentColor MUST come from the supplied quantizedColors list. Never invent a hex.
- If any enum field's correct value isn't listed, choose the closest listed value — never invent.
- Components are visible evidence, not product intent. Include chart/card/list/navigation controls
  actually present in the screenshot. Prefer specific tags (donut-chart, line-chart, kpi-card)
  over generic chart/card terms when the specific component is visible. Do not add a component just
  because it is common for that product type; every component must have a visible instance on screen.
- domainTags describes the page's business purpose, not its visual pattern — a billing page is
  still categories:["settings","dashboard"] AND domainTags:["billing","usage"]. Don't let one
  replace the other. Leave [] if no clear business-domain signal is visible.
- Settings subpages with explicit page subjects must preserve that subject in domainTags:
  "Settings / Integrations" or a page title "Integrations" -> domainTags:["integrations"].
- If DOM signals are provided, treat them as ground truth for bodyFont, usesShadows, and
  spacingDensity. Do not contradict the computed values. Note significant a11y issues
  (low contrastRatio, high unlabeledInteractive, imagesMissingAlt) in your assessment.
- Categorization calibration: before choosing "dashboard" or "onboarding", check whether the
  screen is actually one of these commonly-missed patterns — a chat interface (message bubbles,
  conversation history, composer), a pricing table (tier comparison, price+features matrix), a
  command palette (search-driven action list, keyboard-invoked), an empty state (illustration +
  first-action prompt with no data), a calculator (numeric/business inputs producing immediate
  computed results — fees, ROI, savings, loan payments, pricing estimates), or a settings screen
  (densely grouped toggles/fields/forms). These are frequently misclassified as "dashboard" when
  they are narrower patterns. Use "calculator" for tools where the primary screen pattern is entering
  numeric variables and seeing computed results. Do not default these to "dashboard" unless the primary
  experience is monitoring many existing metrics. Prefer the specific pattern over the generic one.
- Use navigation only when the primary job is moving between destinations. Do not classify a screen
  as navigation merely because it has a top nav, sidebar, tabs, search bar, bell, avatar, or icon row.
  If the screen shows balance, transactions, money movement, account state, recent payments, or add-money
  flows, choose the primary work pattern (dashboard, checkout, calculator, or forms as appropriate) and
  set suggestedPatternType when the enum is too coarse; do not classify it as navigation.
- Return ONLY the JSON object. No explanation, no markdown.`;
}

// ─── PASS 2: critique prompt (judgment + design intent) ──────────────────────

/**
 * Strip color palette fields from the extraction object before it reaches the
 * critique prompt. The critique model was turning palette hex values into fake
 * UI state ("purple status chips" fabricated from a dominant color). Colors
 * are extraction facts — they belong in Pass 1, not in the critique's reasoning
 * context. Structural tags, components, layout, and typography stay.
 */
function critiqueSafeExtraction(extraction: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...extraction };
  delete copy.dominantColors;
  delete copy.accentColor;
  delete copy.colorRoles;
  return copy;
}

function buildCritiquePrompt(
  productName: string,
  extraction: Record<string, unknown>,
  domSignals?: TaggerInput["domSignals"],
): string {
  // Inject accessibility ground truth from DOM signals when available. This is
  // the key addition: real contrastRatio / unlabeledInteractive / imagesMissingAlt
  // data the model can't read from pixels alone, enabling it to populate
  // draftAccessibilityRisks with concrete findings instead of empty [].
  const a11yBlock = domSignals?.accessibility
    ? `\nACCESSIBILITY GROUND TRUTH — computed from the live DOM (treat as fact):\n${JSON.stringify(domSignals.accessibility, null, 2)}\n`
    : "";

  return `Here is the VALIDATED structural extraction for ${productName} (treat every value as
established fact — do not re-describe or contradict it):
${JSON.stringify(extraction, null, 2)}
${a11yBlock}
Step 1 — Observe first. Before writing anything else, list exactly 5 specific, concrete visual
elements you can point to on screen. Each observation should be a DESIGN DECISION you can see
evidence of, not just a description of what's there. Think about WHO the user is (first-time vs
returning, mobile vs desktop, expert vs novice, users with disabilities) and HOW they interact
(muscle memory, scanning patterns, error recovery, decision-making under time pressure).
Examples of good observations:
- "The submit button uses text-only styling with no fill or border, relying on color alone for affordance"
- "Status indicators are small naked color circles with no labels — readable by hue alone at a glance"
- "The 'FOLLOWING' button uses all-caps verb tense to make the reversible action obvious"
- "Image thumbnails are cropped to 1:1 squares, forcing compositional discipline over landscape realism"
Do NOT write generic observations like "the layout is clean" or "there is a sidebar." Each item
must name a SPECIFIC, DEFENSIBLE choice the designer made and why it works or doesn't.
Do NOT invent pixel dimensions (e.g. "8px dots", "3px badge") — you cannot measure pixels reliably
from an image. Describe size relatively ("small", "narrow") or omit it.

CRITICAL — icon-only claims: Most sidebars and nav rails have BOTH icons AND text labels.
Before claiming "icon-only navigation" or "icon-only buttons," verify that you genuinely
cannot see ANY text labels beside the icons. If labels ARE visible (even small ones), do
NOT report an icon-only risk — that is a fabrication. The #1 a11y hallucination is claiming
icon-only nav when text labels are clearly present.

QUALITY BAR — bad vs good examples for each field:
draftCritique:
  Bad:  "Uses whitespace to keep things clean."
  Good: "The wide gutter between the form and preview separates editing from review, so users can
        change fields without losing the confirmation context. Rejects the common default of
        stacking form and preview vertically, which forces scroll-back after every edit."
draftWhatToSteal:
  Bad:  "Avoids clutter."
  Good: "Avoids showing all account settings at once; grouped panels keep admin scanning local to
        one decision area at a time. Use this when settings exceed 12 items — below that, a flat
        list is faster. Do NOT use for simple 3-4 item settings."
draftAntiPatterns:
  Bad:  "Doesn't use too many colors."
  Good: "Avoids loading every chart series with a distinct hue — a lazy approach would create a
        6-color legend that forces users to cross-reference. This design sticks to one accent so
        the scanning path stays linear."

Step 2 — Critique using ONLY items from your observations list. Return this JSON:

{
  "observations": [],          // exactly 5 specific, pointable visual elements (required)
  "typographyNotes": "",       // 1-2 sentences on how the type choices create hierarchy
  "mood": "",                  // one phrase: the emotional register of the design. Read from color
                               // choices, typography weight, whitespace, and copy tone. Examples:
                               // "playful and approachable", "clinical and data-forward",
                               // "confident and restrained", "warm and tactile", "authoritative".
  "draftCritique": "",         // 3-5 sentences. For EACH decision: name the DECISION (what was chosen),
                               // the EFFECT (what perceptual/functional/behavioral outcome it creates for
                               // the user — think about HOW the user interacts, not just what it looks like),
                               // and the REJECTION (what conventional default it replaces). Write about the
                               // USER'S EXPERIENCE, not the pixels — "muscle memory" beats "color coding,"
                               // "reduces cognitive load at decision point" beats "clean grouping."
                               // Name the SPECIFIC USER TYPE affected: "returning users scan faster"
                               // beats "users scan faster," "first-time users may feel lost" beats
                               // "users may feel lost."
  "draftWhatToSteal": [],      // 3-5 SPECIFIC, COPYABLE techniques a developer could reproduce. Each must
                               // include the reasoning: not "use whitespace" but "reserve the brightest
                               // accent color for the single element that must win attention so state
                               // and action remain unmistakable." Name the technique, the constraint it
                               // satisfies, and when NOT to use it.
  "draftAntiPatterns": [],     // REQUIRED, at least 2. Each must describe a DIFFERENT decision than
                               // draftCritique and teach a SPECIFIC lesson: "what this design avoids
                               // doing, and why avoiding it matters for this user/task type." Think
                               // about what conventional approaches would have FAILED here — what
                               // would a lazy designer have done that this designer deliberately rejected?
  "draftAccessibilityRisks": [], // accessibility risks found on this screen. Each entry is an object:
                               // { "element": "the specific UI element (e.g. 'payment status dot', 'sidebar icons')",
                               //   "risk": "what fails and for whom (e.g. 'state is communicated by color alone')",
                               //   "evidence": "quote the visible text label, name the exact screen region, or cite
                               //                the DOM metric that PROVES this risk exists. If you cannot point to
                               //                something concrete, do not include the risk — return [] instead.",
                               //   "confidence": "visible" | "inferred",
                               //   "wcag": ["1.4.1"] — REQUIRED array of 1-3 canonical WCAG 2.2 success-criterion
                               //           IDs (bare numbers, e.g. "1.4.1", "1.4.3", "2.4.7"). No title text. If you
                               //           cannot recall the exact criterion number, do NOT include the risk — return
                               //           [] instead. A risk with no valid canonical ID is dropped. }
                               //
                               // EVIDENCE IS THE GATE. Risks without concrete evidence will be rejected.
                               // Palette hex values are NOT evidence. Generic component names are NOT evidence.
                               // Absent states you cannot see are NOT evidence. [] is the correct answer
                               // when you cannot point to something specific on screen or recall the WCAG ID.
                               //
                               // Common a11y failures — ONLY include if you can cite concrete evidence:
                               // - Color-only differentiation: name the exact status indicator and what states
                               //   it shows (e.g. "small red/green dots beside Paid and Failed rows, no text
                               //   status label"). Do NOT invent pixel dimensions — describe size relatively.
                               // - DO NOT report unlabeled-control / icon-only risks. The model cannot
                               //   reliably tell whether an accessible name exists beside an icon — this has
                               //   been the #1 false positive. Pixels cannot establish the ABSENCE of a label
                               //   or accessible name. Only DOM ground truth (unlabeledInteractive) can
                               //   establish this, and that is handled in code, not by you. This covers
                               //   "icon-only", "icon with no text label", "glyph with no label",
                               //   "unlabeled button", "no accessible name" — ALL absence-of-label claims.
                               // - Low contrast: only if DOM ground truth provides a contrastRatio below 4.5:1
                               // - Tiny touch targets: name the specific control; describe size relatively,
                               //   do NOT invent exact pixel sizes unless a DOM signal provides them
  "businessRationale": null,   // null if isolated component crop/no product context; otherwise object below
                               // { "businessGoal": ONE from: ${BUSINESS_GOALS.join(", ")},
                               //   "targetUser": "short phrase, <=80 chars",
                               //   "rationale": "one sentence, <=280 chars",
                               //   "confirmed": false }
  "voiceTone": "",             // omit entirely if no notable copy is visible
  "voiceExamples": [],         // real copy visible on screen, verbatim
  "voiceAvoid": [],            // what voice this design does NOT use
  "qualityTier": "",            // ONE from: ${QUALITY_TIERS.join(", ")}. Default to "exceptional".
                               // Use "cautionary" only when the screen's PRIMARY teaching value is
                               // failure: severe unreadability, deceptive patterns, broken task
                               // completion, or multiple compounding issues that make the design a
                               // better "what not to do" specimen than a pattern to emulate.
                               // Keep otherwise strong designs exceptional even when they have
                               // isolated flaws, dense professional UI, secondary-label contrast
                               // concerns, missing states not visible in the screenshot, or minor
                               // spacing/alignment issues. Put those caveats in draftAntiPatterns
  "tierChangeJustification": null, // If this screen was previously tagged "cautionary" and you are
                               // now returning "exceptional" (or vice versa), explain WHY in one
                               // sentence. Null when keeping the same tier. This prevents silent
                               // tier laundering during bulk retags.
                               // or draftAccessibilityRisks instead of demoting the whole entry.
}

Rules:
- Every draftCritique/draftWhatToSteal/draftAntiPatterns claim must trace back to something in
  "observations". Do not make claims about UI elements you cannot point to on screen.
- draftAntiPatterns must not restate draftCritique's decision from the opposite angle. Each should
  teach a distinct lesson about what the design deliberately avoids and why that avoidance matters.
- voiceExamples must be EXACT visible copy from the screen, quoted verbatim. Do not invent copy,
  paraphrase, or include copy you think might be there. If no notable copy is visible, omit voice entirely.
- businessRationale must be null unless the screenshot shows visible product context (page title,
  navigation, copy) that supports the intent. Do not invent business goals for isolated components.
- draftAccessibilityRisks: each risk MUST include concrete "evidence" — quote the visible text label,
  name the exact screen region, or cite a DOM metric. Palette hex values are NOT evidence. Generic
  component names are NOT evidence. Absent states are NOT evidence. Return [] when you cannot point
  to something specific. Maximum 2 risks — [] is the correct answer for a clean screen.
  Set confidence to "inferred" when guessing from pixels. Do NOT use "dom-grounded" — code sets that.
  Do NOT report unlabeled-control or icon-only risks of any kind — pixels cannot establish the absence
  of an accessible name. Do NOT invent pixel dimensions — describe size relatively unless a DOM signal
  provides exact measurements.
- Quality tier calibration: "exceptional" means worth learning from, not flawless.
  "cautionary" is rare and reserved for screens whose main lesson is the failure itself.
- No banned phrases (${BANNED_PHRASES.slice(0, 4).map((p) => `"${p}"`).join(", ")}, ...). Re-check before returning.
- Return ONLY the JSON object.`;
}

// ─── sanitizer helpers (unchanged from the single-pass era) ──────────────────

function listFromAllowed(value: unknown, allowed: readonly string[], fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => allowed.includes(item));
  return [...new Set(normalized)].slice(0, 3).length ? [...new Set(normalized)].slice(0, 3) : fallback;
}

function componentsFromAllowed(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = COMPONENTS as readonly string[];
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => allowed.includes(item));
  return [...new Set(normalized)].slice(0, 10);
}

// ─── platform normalization ──────────────────────────────────────────────────
// Components that imply a desktop side rail — physically impossible on a
// portrait phone screenshot. Removed from mobile extraction output.
const DESKTOP_ONLY_COMPONENTS: ReadonlySet<string> = new Set(["sidebar-nav"]);
// Components that only appear on mobile UIs — removed from web screenshots so
// the model can't retroactively add a bottom-nav to a desktop page.
const MOBILE_ONLY_COMPONENTS: ReadonlySet<string> = new Set(["bottom-nav"]);
// Layout region roles that imply a desktop nav rail. Stripped from mobile.
const DESKTOP_NAV_ROLES: ReadonlySet<string> = new Set(["primary-nav", "icon-nav"]);

/**
 * Normalize extraction facts by detected platform. Mobile screenshots lose
 * desktop side-rail components/layout; web screenshots lose mobile-only
 * components. Tablet (ambiguous aspect ratio) is left unchanged.
 *
 * Returns a NEW extraction object; the original `_raw.extraction` is preserved
 * unmodified for auditability.
 */
export function normalizeExtractionByPlatform(
  extraction: { components?: string[]; layout?: { form: string; regions: Array<{ role: string; width?: string }> } },
  platform: string,
): { components: string[]; layout: { form: string; regions: Array<{ role: string; width?: string }> } | undefined } {
  const components = extraction.components ?? [];
  const filteredComponents = components.filter((c) => {
    if (platform === "mobile" && DESKTOP_ONLY_COMPONENTS.has(c)) return false;
    if (platform === "web" && MOBILE_ONLY_COMPONENTS.has(c)) return false;
    return true;
  });
  let layout = extraction.layout;
  if (platform === "mobile" && layout) {
    const filteredRegions = layout.regions.filter((r) => !DESKTOP_NAV_ROLES.has(r.role));
    layout = filteredRegions.length ? { ...layout, regions: filteredRegions } : undefined;
  }
  return { components: filteredComponents, layout };
}

function domainTagsFromAllowed(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = DOMAIN_TAGS as readonly string[];
  const normalized = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => allowed.includes(item));
  return [...new Set(normalized)].slice(0, 4);
}

/**
 * Sanitize accessibility risks from the critique model output.
 *
 * EVIDENCE GATE — the core defense against fabricated risks. Each risk must
 * cite observable UI evidence or computed DOM evidence. The following are
 * rejected:
 *   - Missing or too-short evidence (<8 chars)
 *   - Evidence that is only a generic component name (sidebar, buttons, icons)
 *   - Evidence that is only a hex value or palette mention
 *   - Self-referential evidence (citing the extraction output, not the screenshot)
 *   - Fabricated pixel measurements (8px, 3px) unless DOM/computed ground truth cited
 *   - Unlabeled-control risks (icon-only, icon with no label, unlabeled button —
 *     pixels cannot establish absence of an accessible name; only DOM ground truth can)
 *   - Color-only risks where evidence doesn't name a concrete visible state/control
 *   - More than 2 non-DOM risks (quota cap — [] is honest when guessing)
 *
 * Confidence "dom-grounded" is NEVER accepted from the model — it's downgraded
 * to "inferred". Only code (DOM-signals injection) may set "dom-grounded".
 */
function sanitizeAccessibilityRisks(value: unknown): Array<{ element: string; risk: string; evidence: string; confidence: string; wcag: string[] }> {
  if (!Array.isArray(value)) return [];

  // Evidence that is just a generic component name with no visible detail.
  const GENERIC_EVIDENCE = /^(sidebar|buttons?|icons?|cards?|text|layout|navigation|form|chart|table|menu|header|footer|modal|overlay|inputs?)\s*$/i;
  // Evidence that is only a hex color or palette-derivation phrase.
  const PALETTE_EVIDENCE = /^#?[0-9a-f]{6}$/i;
  const PALETTE_WORDS = /\b(palette|dominant color|accent color|color palette|extracted color|from (?:the )?color)\b/i;
  const VISIBLE_LABEL_LANG = /\b(label|labels?|text|caption|word|named|home|cards?|settings?|transactions?|balance|account|profile|menu)\b/i;
  // Color-only / status risk where evidence must name a concrete visible state/control.
  const COLOR_ONLY_RISK = /\b(color[\s-]*only|sole (?:status )?differentiator|color alone|status (?:indicator|chip|dot|badge))\b/i;
  const CONCRETE_STATE_LANG = /\b(dot|chip|badge|row|column|cell|button|indicator|status|state|paid|failed|pending|active|inactive|success|error|warning|danger|stop|go)\b/i;
  // Self-referencing evidence: the model citing its OWN extraction output (the
  // component inventory, the layoutRegions, "the extraction shows") as evidence
  // instead of something visible on the screenshot. This is reasoning from the
  // prompt, not observation — reject it.
  const SELF_REFERENTIAL_EVIDENCE = /\b(component inventory|component list|extraction (?:shows|lists|describes|states)|layout region (?:is )?described|the (?:above|validated) (?:extraction|inventory))\b/i;

  const result: Array<{ element: string; risk: string; evidence: string; confidence: string; wcag: string[] }> = [];

  for (const item of value) {
    if (typeof item === "string" && item.trim()) {
      // Legacy plain strings from old model output can't satisfy the evidence
      // gate — drop them rather than invent evidence. New prompts emit objects.
      continue;
    }
    if (!item || typeof item !== "object") continue;

    const obj = item as Record<string, unknown>;
    const risk = typeof obj.risk === "string" ? obj.risk.trim() : "";
    const evidence = typeof obj.evidence === "string" ? obj.evidence.trim() : "";
    if (!risk) continue;

    // A model sometimes appends a non-finding such as "likely accessible" to
    // the risk array. Keep the observation out of this machine-queryable list
    // rather than presenting it to curators as an issue to resolve.
    if (NON_RISK_ASSERTION.test(`${risk}\n${evidence}`)) continue;

    // Gate 1: evidence must exist and be substantive
    if (evidence.length < 8) continue;

    // Gate 2: reject generic component-name-only evidence
    if (GENERIC_EVIDENCE.test(evidence)) continue;

    // Gate 3: reject palette-only evidence
    if (PALETTE_EVIDENCE.test(evidence) || PALETTE_WORDS.test(evidence)) continue;

    // Gate 3b: reject self-referential evidence — the model citing its own
    // extraction output ("component inventory lists icon-button") instead of a
    // visible screenshot detail. Reasoning from the prompt is not observation.
    if (SELF_REFERENTIAL_EVIDENCE.test(evidence)) continue;

    // Gate 3c: reject fabricated pixel measurements. The model cannot measure
    // pixels from an image — "8px dots", "3px badge", "12-pixel" are invented
    // precision. Only allowed when DOM/computed ground truth is cited (e.g.
    // "contrastRatio 2.8:1", "computed from the DOM"). Relative size words
    // ("small", "narrow") are fine.
    if (PIXEL_MEASUREMENT.test(evidence) && !DOM_GROUND_TRUTH.test(evidence)) continue;

    // Gate 3d: contrast failures require computed contrast data. A screenshot
    // can suggest "this looks muted", but it cannot prove WCAG contrast failure.
    // Check raw citation (string or array) for 1.4.3 before validation normalizes it.
    const rawCitations = extractAllWcagIds(Array.isArray(obj.wcag) ? obj.wcag.join(", ") : String(obj.wcag ?? ""));
    if ((LOW_CONTRAST_RISK.test(risk) || LOW_CONTRAST_RISK.test(evidence) || rawCitations.includes("1.4.3")) && !DOM_GROUND_TRUTH.test(evidence)) continue;

    // Gate 4: unlabeled-control risks are the #1 hallucination class. The model
    // CANNOT reliably establish the absence of a text label or accessible name
    // from pixels — it hallucinated "no visible text labels" on multiple entries
    // where labels were clearly visible, and "icon with no text label" /
    // "glyph with no label" / "unlabeled button" are the same failure. Policy:
    // drop ALL model-generated unlabeled-control risks. Only DOM ground truth
    // (unlabeledInteractive count from the capture pipeline) can produce one,
    // and that is code-injected, not model-generated. Pixels cannot establish
    // absence.
    if (UNLABELED_CONTROL_RISK.test(risk) || UNLABELED_CONTROL_RISK.test(evidence)) continue;

    // Gate 5: color-only risk must name a concrete visible state/control
    if (COLOR_ONLY_RISK.test(risk) && !CONCRETE_STATE_LANG.test(evidence)) continue;

    const element = typeof obj.element === "string" ? obj.element.trim() : "—";
    // Model can only emit "visible" or "inferred". "dom-grounded" is reserved
    // for code-side injection — downgrade if the model tries to emit it.
    let confidence = typeof obj.confidence === "string" ? obj.confidence.trim().toLowerCase() : "inferred";
    if (confidence !== "visible" && confidence !== "inferred" && confidence !== "dom-grounded") confidence = "inferred";
    if (confidence === "dom-grounded") confidence = "inferred";

    // WCAG citation gate: every active risk must carry at least one canonical
    // WCAG 2.2 ID. Extract IDs from whatever shape the model emitted (string,
    // array of strings, comma-joined multi-citation), validate each against the
    // registry, deduplicate. A risk with no valid citation is DROPPED — "no
    // valid citation means no risk." This is referential integrity, not proof
    // of a WCAG violation; the evidence gate above remains the authority on that.
    const emitted = Array.isArray(obj.wcag)
      ? obj.wcag.flatMap((w) => (typeof w === "string" ? extractAllWcagIds(w) : []))
      : typeof obj.wcag === "string"
        ? extractAllWcagIds(obj.wcag)
        : [];
    const wcag = [...new Set(emitted)].filter((id) => isWcagCriterion(id)).slice(0, 3);
    if (wcag.length === 0) continue; // no valid canonical ID → drop the risk

    result.push({ element, risk, evidence, confidence, wcag });
  }

  // Gate 6: cap non-DOM risks at 2. DOM-injected risks (confidence "dom-grounded")
  // bypass the cap since they're computed facts, not guesses. But since the
  // sanitizer only processes model output (which can't be dom-grounded after
  // the downgrade above), this effectively caps all risks at 2.
  return result.slice(0, 2);
}

function hexColors(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const colors = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => /^#[0-9a-fA-F]{6}$/.test(item))
    .map((item) => item.toLowerCase());
  const unique = [...new Set(colors)].slice(0, 6);
  return unique.length ? unique : fallback;
}

function oneFromAllowed(value: unknown, allowed: readonly string[], fallback: string): string {
  return typeof value === "string" && allowed.includes(value) ? value : fallback;
}

function normalizeSuggestedPatternType(value: unknown, currentPatternType: string): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  if (!normalized || normalized === currentPatternType) return undefined;
  if ((PATTERN_TYPES as readonly string[]).includes(normalized)) return undefined;
  return normalized;
}

function nullableHex(value: unknown): string | null {
  return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function booleanValue(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function textList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 4);
}

export function sanitizeTaggerPayload(parsed: Record<string, unknown>): {
  patternType: string;
  suggestedPatternType?: string;
  categories: string[];
  styleTags: string[];
  components: string[];
  domainTags: string[];
  colorScheme: string;
  industryVertical: string;
  responsiveBehavior: string;
  mood: string;
  dominantColors: string[];
  accentColor: string | null;
  colorRoles?: { canvas: string; surface: string; ink: string; muted: string | null; accent: string };
  displayFont: string | null;
  bodyFont: string | null;
  typographyNotes: string;
  spacingDensity: string;
  cornerStyle: string;
  usesShadows: boolean;
  usesBorders: boolean;
  draftCritique: string;
  draftWhatToSteal: string[];
  draftAntiPatterns: string[];
  draftAccessibilityRisks: Array<{ element: string; risk: string; evidence: string; confidence: string; wcag: string[] }>;
  layout?: { form: string; regions: Array<{ role: string; width?: string }> };
  businessRationale?: { businessGoal: string; targetUser: string; rationale: string; confirmed: boolean };
  voice?: { tone: string; examples: string[]; avoid: string[] };
  qualityTier: string;
  tierChangeJustification?: string;
} {
  const layoutForm = oneFromAllowed(parsed.layoutForm, LAYOUT_FORMS, "");
  const rawRegions = Array.isArray(parsed.layoutRegions) ? parsed.layoutRegions : [];
  const regions = rawRegions
    .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
    .map((r) => ({
      role: oneFromAllowed(r.role, LAYOUT_REGION_ROLES, ""),
      width: oneFromAllowed(r.width, ["fixed-narrow", "flex", "fixed-wide"] as const, ""),
    }))
    .filter((r) => r.role)
    .slice(0, 6);
  const layout = layoutForm && regions.length ? { form: layoutForm, regions } : undefined;

  const rawColorRoles = parsed.colorRoles && typeof parsed.colorRoles === "object" ? parsed.colorRoles as Record<string, unknown> : {};
  const roleHex = (k: string) => {
    const v = rawColorRoles[k];
    return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
  };
  const crCanvas = roleHex("canvas"), crSurface = roleHex("surface"), crInk = roleHex("ink"), crAccent = roleHex("accent");
  const colorRoles = (crCanvas && crSurface && crInk && crAccent)
    ? { canvas: crCanvas, surface: crSurface, ink: crInk, muted: roleHex("muted"), accent: crAccent }
    : undefined;

  const voiceTone = text(parsed.voiceTone);
  const voiceExamples = textList(parsed.voiceExamples);
  const voice = voiceTone && voiceExamples.length
    ? { tone: voiceTone, examples: voiceExamples, avoid: textList(parsed.voiceAvoid) }
    : undefined;

  const rawBusinessRationale = parsed.businessRationale && typeof parsed.businessRationale === "object"
    ? parsed.businessRationale as Record<string, unknown>
    : null;
  const businessGoal = rawBusinessRationale
    ? oneFromAllowed(rawBusinessRationale.businessGoal, BUSINESS_GOALS, "other")
    : "";
  const targetUser = rawBusinessRationale ? text(rawBusinessRationale.targetUser).slice(0, 80) : "";
  const rationale = rawBusinessRationale ? text(rawBusinessRationale.rationale).slice(0, 280) : "";
  const businessRationale = rawBusinessRationale && targetUser && rationale
    ? {
        businessGoal,
        targetUser,
        rationale,
        confirmed: booleanValue(rawBusinessRationale.confirmed, false),
      }
    : undefined;

  const patternType = oneFromAllowed(parsed.patternType, PATTERN_TYPES, "dashboard");
  const suggestedPatternType = normalizeSuggestedPatternType(parsed.suggestedPatternType, patternType);

  return {
    patternType,
    suggestedPatternType,
    categories: listFromAllowed(parsed.categories, CATEGORIES, ["dashboard"]),
    styleTags: listFromAllowed(parsed.styleTags, STYLE_TAGS, ["minimal"]),
    components: componentsFromAllowed(parsed.components),
    domainTags: domainTagsFromAllowed(parsed.domainTags),
    colorScheme: oneFromAllowed(parsed.colorScheme, ["light", "dark"], ""),
    industryVertical: text(parsed.industryVertical).slice(0, 40),
    responsiveBehavior: oneFromAllowed(parsed.responsiveBehavior, ["responsive", "fixed-width", "adaptive"], ""),
    mood: text(parsed.mood).slice(0, 60),
    dominantColors: hexColors(parsed.dominantColors, ["#ffffff", "#111111"]),
    accentColor: nullableHex(parsed.accentColor),
    colorRoles,
    displayFont: stringOrNull(parsed.displayFont),
    bodyFont: stringOrNull(parsed.bodyFont),
    typographyNotes: text(parsed.typographyNotes),
    spacingDensity: oneFromAllowed(parsed.spacingDensity, SPACING_DENSITIES, "moderate"),
    cornerStyle: oneFromAllowed(parsed.cornerStyle, CORNER_STYLES, "slight-round"),
    usesShadows: booleanValue(parsed.usesShadows, false),
    usesBorders: booleanValue(parsed.usesBorders, true),
    draftCritique: text(parsed.draftCritique, "This UI needs a human review, but the screenshot shows a clear structure worth cataloging for future design reference."),
    layout,
    voice,
    qualityTier: oneFromAllowed(parsed.qualityTier, QUALITY_TIERS, "exceptional"),
    tierChangeJustification: typeof parsed.tierChangeJustification === "string" && parsed.tierChangeJustification.trim()
      ? parsed.tierChangeJustification.trim()
      : undefined,
    draftWhatToSteal: textList(parsed.draftWhatToSteal).length
      ? textList(parsed.draftWhatToSteal)
      : ["Review the screenshot and extract one concrete interface technique before saving."],
    draftAntiPatterns: textList(parsed.draftAntiPatterns).length
      ? textList(parsed.draftAntiPatterns)
      : ["[DRAFT] Review the screenshot and name one common UI mistake this design avoids."],
    draftAccessibilityRisks: sanitizeAccessibilityRisks(parsed.draftAccessibilityRisks),
    businessRationale,
  };
}

// ─── banned-phrase code-level gate ───────────────────────────────────────────

function validateNoBannedPhrases(obj: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const haystack = JSON.stringify(obj).toLowerCase();
  for (const phrase of BANNED_PHRASES) {
    if (haystack.includes(phrase.toLowerCase())) {
      errors.push(`Contains banned phrase: "${phrase}". Rewrite that field in specific terms.`);
    }
  }
  return errors;
}

// ─── unsupported prose gate (stops hallucinations migrating to prose) ─────────
//
// The a11y sanitizer empties model-generated unsupported risks from the
// accessibilityRisks array, but those same hallucinations were migrating into
// critique, whatToSteal, antiPatterns, businessRationale, and typographyNotes
// unchecked. This gate scans prose fields for unsupported absence-of-label
// claims and fabricated exact measurements, rejects the whole critique with a
// retry (mirroring the banned-phrase gate), then scrubs surviving assertions as
// a safety net.
//
// Key nuance: we preserve sentences that CONTRAST or REJECT icon-only nav
// ("the sidebar keeps icons paired with text labels instead of going icon-only"
// is a correct observation, not a hallucination). Only assertion sentences are
// treated as errors.

// Broader than the a11y ICON_ONLY_RISK: catches "icon-only" + absence-of-label
// phrasings across prose. Anchored on the noun phrase, not the full risk.
const ICON_ONLY_PROSE = /\bicon[\s-]*only|icons?\s+(?:alone|symbols?\s+alone|without\s+(?:visible\s+)?(?:text\s+)?labels?)|represented\s+(?:solely\s+)?by\s+icons?|reli(?:ance|es)\s+on\s+(?:memorized\s+)?(?:icon\s+)?shapes?\b/i;
// Contrast/rejection clause markers — if a sentence both mentions icon-only and
// one of these, it's describing what the design AVOIDS or negating icon-only,
// not asserting it. NOTE: bare "no" and "not" are excluded — "no text labels"
// is the absence claim itself, and "not" is too broad. We require explicit
// negation verbs (are not / is not / do not) or comparison conjunctions.
const CONTRAST_CLAUSE = /\b(?:instead\s+of|rather\s+than|avoids?|rejects?|unlike|in\s+contrast\s+to|could\s+have|might\s+(?:have\s+)?(?:used|gone)|do\s+not|does\s+not|are\s+not|is\s+not|not\s+(?:icon|going))\b/i;
const POSITIVE_LABEL_PAIRING = /\b(?:paired?\s+with|keeps?\s+icons?\s+paired|icons?\s+(?:and|with)\s+(?:text\s+)?labels?|(?:text\s+)?labels?\s+(?:beside|next to|alongside)|instead\s+of\s+going\s+icon[\s-]*only)\b/i;

function isAllowedIconOnlyContrast(sentence: string): boolean {
  return ICON_ONLY_PROSE.test(sentence) && CONTRAST_CLAUSE.test(sentence) && POSITIVE_LABEL_PAIRING.test(sentence);
}

function unsupportedProseReason(sentence: string): string | null {
  if (PIXEL_MEASUREMENT.test(sentence) && !DOM_GROUND_TRUTH.test(sentence)) {
    return "fabricated pixel measurement";
  }
  if (UNLABELED_CONTROL_RISK.test(sentence) && !isAllowedIconOnlyContrast(sentence)) {
    return "unsupported absence-of-label claim";
  }
  return null;
}

/**
 * Scan critique prose fields for unsupported assertions.
 * Returns a list of rejection reasons for the retry-feedback path. Empty when
 * the model is clean or only used icon-only in a supported contrast/rejection
 * sense.
 */
export function validateNoIconOnlyClaims(parsed: Record<string, unknown>): string[] {
  const errors: string[] = [];
  const hits: Array<{ field: string; sentence: string; reason: string }> = [];

  for (const field of PROSE_FIELDS) {
    const value = collectProseValue(parsed, field);
    for (const sentence of splitSentences(value)) {
      const reason = unsupportedProseReason(sentence);
      if (reason) hits.push({ field, sentence, reason });
    }
  }

  if (hits.length) {
    errors.push(
      `Unsupported prose claims found: pixels cannot prove absence of labels/accessibility names or exact dimensions. ` +
      `Found ${hits.length} unsupported assertion(s):\n` +
      hits.map((h) => `  [${h.field}] ${h.reason}: "${h.sentence.trim().slice(0, 140)}"`).join("\n"),
    );
  }
  return errors;
}

// Pass 2 does not see the image. It may reason from Pass 1's facts, but it
// must not grow a new product shell around them. We only guard components that
// make a concrete claim about the current screen; anti-patterns can still name
// alternatives the screen deliberately avoids.
const COMPONENT_CLAIM_RULES: Array<{ label: string; pattern: RegExp; components: readonly string[] }> = [
  { label: "sidebar", pattern: /\b(?:sidebar|side rail)\b/i, components: ["sidebar-nav"] },
  { label: "top navigation", pattern: /\b(?:top nav(?:igation)?|header bar)\b/i, components: ["top-nav"] },
  { label: "tab bar", pattern: /\b(?:tab bar|tabs?)\b/i, components: ["tab-nav"] },
  { label: "line chart", pattern: /\bline chart\b/i, components: ["line-chart"] },
  { label: "bar chart", pattern: /\bbar chart\b/i, components: ["bar-chart"] },
  { label: "area chart", pattern: /\barea chart\b/i, components: ["area-chart"] },
  { label: "circular chart", pattern: /\b(?:circular progress|radial progress|donut chart|pie chart|gauge chart)\b/i, components: ["donut-chart", "pie-chart", "gauge-chart"] },
  { label: "summary card", pattern: /\bsummary cards?\b/i, components: ["summary-card"] },
  { label: "KPI card", pattern: /\b(?:kpi|metric) cards?\b/i, components: ["kpi-card", "metric-grid", "stat-card"] },
  { label: "search command", pattern: /\b(?:command[- ]bar|command search|search command)\b/i, components: ["search-command", "command-palette"] },
];
const COMPONENT_ALTERNATIVE_CLAUSE = /\b(?:instead of|rather than|avoids?|rejects?|unlike|without|does(?: not|n't) use|could have|would have|might have)\b/i;

function unsupportedComponentClaimReason(sentence: string, components: readonly string[]): string | null {
  const observed = new Set(components);
  for (const rule of COMPONENT_CLAIM_RULES) {
    if (
      rule.pattern.test(sentence)
      && !COMPONENT_ALTERNATIVE_CLAUSE.test(sentence)
      && !rule.components.some((component) => observed.has(component))
    ) {
      return `mentions ${rule.label}, but extraction did not observe ${rule.components.join(" or ")}`;
    }
  }
  return null;
}

/**
 * Reject concrete component claims in critique/technique prose unless Pass 1
 * observed the corresponding component. This is a consistency gate, not image
 * verification: it prevents Pass 2 from inventing a sidebar, tab bar, or chart
 * that the extraction never supplied.
 */
export function validateCritiqueComponentClaims(parsed: Record<string, unknown>, components: readonly string[]): string[] {
  const hits: Array<{ field: string; sentence: string; reason: string }> = [];
  for (const field of COMPONENT_GROUNDED_PROSE_FIELDS) {
    const value = collectProseValue(parsed, field);
    for (const sentence of splitSentences(value)) {
      const reason = unsupportedComponentClaimReason(sentence, components);
      if (reason) hits.push({ field, sentence, reason });
    }
  }
  if (!hits.length) return [];
  return [
    `Unsupported component claims found: critique may only describe components present in the validated extraction. ` +
    `Found ${hits.length} unsupported assertion(s):\n` +
    hits.map((hit) => `  [${hit.field}] ${hit.reason}: "${hit.sentence.trim().slice(0, 140)}"`).join("\n"),
  ];
}

/** Prose fields scanned by the icon-only gate + scrubber. */
const PROSE_FIELDS = [
  "draftCritique",
  "typographyNotes",
  "voiceTone",
  "draftWhatToSteal",
  "draftAntiPatterns",
  "voiceExamples",
  "voiceAvoid",
  "businessRationale.rationale",
] as const;

/** Fields that must describe the actual current screen, not an alternative. */
const COMPONENT_GROUNDED_PROSE_FIELDS = [
  "draftCritique",
  "draftWhatToSteal",
  "businessRationale.rationale",
] as const;

/** Collect a prose value (string or array element) as a single string. */
function collectProseValue(obj: Record<string, unknown>, field: string): string {
  // draftWhatToSteal / draftAntiPatterns / voiceExamples / voiceAvoid are arrays.
  if (field === "draftWhatToSteal" || field === "draftAntiPatterns" || field === "voiceExamples" || field === "voiceAvoid") {
    const arr = obj[field];
    return Array.isArray(arr) ? arr.filter((s): s is string => typeof s === "string").join(". ") : "";
  }
  // businessRationale is a nested object.
  if (field === "businessRationale.rationale") {
    const br = obj.businessRationale;
    return br && typeof br === "object" ? text((br as Record<string, unknown>).rationale) : "";
  }
  const v = obj[field];
  return typeof v === "string" ? v : "";
}

/** Split prose into sentence-ish units (period + space, or bullet boundaries). */
function splitSentences(value: string): string[] {
  if (!value) return [];
  return value
    .replace(/\.\s+/g, ".\n")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Safety-net scrubber: strip unsupported assertion sentences from prose fields
 * after the retry. Preserves supported contrast/rejection sentences. Called on
 * the sanitized critique object (not the raw parse) so it runs even if the
 * retry fails or the model persists the claim.
 *
 * Mutates and returns the critique object. Operates on the post-sanitize shape
 * (draftCritique, draftWhatToSteal, etc. have been validated already).
 */
export function scrubProseIconOnly(critique: {
  draftCritique: string;
  draftWhatToSteal: string[];
  draftAntiPatterns: string[];
  typographyNotes: string;
  businessRationale?: { businessGoal: string; targetUser: string; rationale: string; confirmed: boolean };
  voice?: { tone: string; examples: string[]; avoid: string[] };
}): void {
  const filterSentences = (text: string): string => {
    const kept = splitSentences(text).filter((s) => {
      return unsupportedProseReason(s) === null;
    });
    return kept.join(" ");
  };

  critique.draftCritique = filterSentences(critique.draftCritique);
  critique.typographyNotes = filterSentences(critique.typographyNotes);
  critique.draftWhatToSteal = critique.draftWhatToSteal
    .map((t) => filterSentences(t).trim())
    .filter((t) => t.length > 0);
  critique.draftAntiPatterns = critique.draftAntiPatterns
    .map((t) => filterSentences(t).trim())
    .filter((t) => t.length > 0);
  if (critique.businessRationale?.rationale) {
    critique.businessRationale.rationale = filterSentences(critique.businessRationale.rationale);
  }
  if (critique.voice?.examples) {
    critique.voice.examples = critique.voice.examples
      .map((t) => filterSentences(t).trim())
      .filter((t) => t.length > 0);
  }

  // Post-scrub fallback: sanitizeTaggerPayload guarantees non-empty
  // draftWhatToSteal / draftAntiPatterns (schema requires min(1)), but the
  // scrubber can empty them if every entry contained an icon-only assertion.
  // Restore a neutral placeholder so a successful model call doesn't become a
  // validation failure downstream. The human reviewer will rewrite these.
  if (critique.draftWhatToSteal.length === 0) {
    critique.draftWhatToSteal = ["Review the screenshot and extract one concrete interface technique before saving."];
  }
  if (critique.draftAntiPatterns.length === 0) {
    critique.draftAntiPatterns = ["[DRAFT] Review the screenshot and name one common UI mistake this design avoids."];
  }
}

/**
 * Safety net for the component-consistency retry. Deliberately leaves
 * anti-patterns untouched because they are allowed to describe absent,
 * conventional alternatives (for example, "avoid a tab bar here").
 */
function scrubUnsupportedComponentClaims(critique: {
  draftCritique: string;
  draftWhatToSteal: string[];
  draftAntiPatterns: string[];
  typographyNotes: string;
  businessRationale?: { businessGoal: string; targetUser: string; rationale: string; confirmed: boolean };
  voice?: { tone: string; examples: string[]; avoid: string[] };
}, components: readonly string[]): void {
  const filterSentences = (value: string): string => splitSentences(value)
    .filter((sentence) => unsupportedComponentClaimReason(sentence, components) === null)
    .join(" ");

  critique.draftCritique = filterSentences(critique.draftCritique);
  critique.draftWhatToSteal = critique.draftWhatToSteal
    .map((value) => filterSentences(value).trim())
    .filter((value) => value.length > 0);
  if (critique.businessRationale?.rationale) {
    critique.businessRationale.rationale = filterSentences(critique.businessRationale.rationale);
  }
  if (critique.draftWhatToSteal.length === 0) {
    critique.draftWhatToSteal = ["Review the screenshot and extract one concrete interface technique before saving."];
  }
  // CorpusEntry requires a substantive critique. A scrubbed draft must remain
  // visibly review-only instead of becoming an invalid empty entry.
  if (critique.draftCritique.length < 80) {
    critique.draftCritique = "This critique contained unsupported component claims and needs a human rewrite based on the screenshot.";
  }
}

// ─── model call helpers (multi-provider) ─────────────────────────────────────

/**
 * Read an image as base64, honoring the detail level.
 *
 * - detail "high": raw bytes (provider downsamples per its own tiling). Most
 *   accurate, most tokens.
 * - detail "low": pre-resize to 512px on the long edge via sharp before
 *   base64. OpenAI's `detail:"low"` does this server-side anyway; for Claude
 *   and Gemini (no detail knob) this is how "low" actually saves tokens —
 *   a 1920×1200 PNG drops from ~600KB to ~30KB, roughly 20× fewer bytes.
 *
 * Returns { data, mimeType }. mimeType reflects the source (no re-encoding).
 */
/** Read image dimensions via sharp. Returns {width, height} or nulls on failure. */
async function readImageDimensions(imagePath: string): Promise<{ width: number | null; height: number | null }> {
  try {
    const meta = await sharp(imagePath).metadata();
    return { width: meta.width ?? null, height: meta.height ?? null };
  } catch { return { width: null, height: null }; }
}

async function readImageForDetail(
  imagePath: string,
  detail: "low" | "high",
): Promise<{ data: string; mimeType: string }> {
  const ext = extname(imagePath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  if (detail === "high") {
    return { data: readFileSync(imagePath).toString("base64"), mimeType };
  }
  // low: downscale to 512px long edge, keep format. Sharp handles png/jpeg/webp.
  const buf = await sharp(imagePath).resize(512, 512, { fit: "inside", withoutEnlargement: true }).toBuffer();
  return { data: buf.toString("base64"), mimeType };
}

async function callOpenAI(
  prompt: string,
  imagePath: string | null,
  retryFeedback?: string,
  detail: "low" | "high" = "high",
  pass: TaggerPass = "extraction",
): Promise<string> {
  const cfg = openaiConfigForPass(pass);
  if (!cfg.apiKey) throw new Error("OPENAI_API_KEY not set");

  // If a base URL is set for this pass, route to the universal OpenAI-compatible
  // chat completions path (NVIDIA NIM, OpenRouter, Together, Groq, vLLM, etc.).
  // Otherwise use OpenAI's native Responses API (untouched behavior).
  if (cfg.baseUrl) return callOpenAICompatible(prompt, imagePath, retryFeedback, detail, pass, cfg);

  const userContent: Array<Record<string, unknown>> = [{ type: "input_text", text: prompt }];
  if (imagePath) {
    const { data: imageData, mimeType } = await readImageForDetail(imagePath, detail);
    userContent.push({ type: "input_image", image_url: `data:${mimeType};base64,${imageData}`, detail });
  }

  const response = await fetchWithRetry(OPENAI_RESPONSES_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      max_output_tokens: MAX_OUTPUT_TOKENS,
      input: [
        { role: "system", content: [{ type: "input_text", text: SYSTEM }] },
        { role: "user", content: retryFeedback ? [...userContent, { type: "input_text", text: retryFeedback }] : userContent },
      ],
    }),
  });

  if (!response.ok) throw new Error(`OpenAI API error ${response.status}: ${await response.text()}`);

  const data = await response.json() as {
    output_text?: string;
    output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
  };
  return data.output_text
    ?? data.output?.flatMap((item) => item.content ?? [])
      .filter((c) => c.type === "output_text" || c.type === "text")
      .map((c) => c.text ?? "").join("")
    ?? "";
}

/**
 * OpenAI-compatible chat completions path. Activated when a base URL is set
 * for the pass (via OPENAI_BASE_URL or OPENAI_BASE_URL_<PASS>).
 *
 * Targets providers that mimic OpenAI's API shape but only expose
 * /v1/chat/completions (not /v1/responses): NVIDIA NIM, OpenRouter, Together,
 * Groq, vLLM, etc. Request/response shapes are the universal OpenAI format:
 *
 *   POST {baseUrl}/chat/completions
 *   { model, messages, max_tokens, temperature, chat_template_kwargs }
 *   → { choices: [{ message: { content } }] }
 *
 * Vision (when the underlying model supports it) uses OpenAI's standard
 * chat-completions image_url part. NIM endpoints generally accept it natively.
 *
 * Thinking toggle: NVIDIA NIM accepts `chat_template_kwargs.thinking` to
 * enable/disable reasoning on models that support it (DeepSeek V4, etc.).
 * Defaults to ON for the critique pass, OFF for extraction — matches the
 * per-pass thinking policy already in place for Gemini 3.5. Override globally
 * with OPENAI_THINKING_DISABLED=1.
 */
async function callOpenAICompatible(
  prompt: string,
  imagePath: string | null,
  retryFeedback?: string,
  detail: "low" | "high" = "high",
  pass: TaggerPass = "extraction",
  cfg: OpenAIConfig = openaiConfigForPass(pass),
): Promise<string> {
  if (!cfg.apiKey) throw new Error(`OPENAI_API_KEY${pass === "extraction" ? "" : `_${pass.toUpperCase()}`} not set`);

  // Build the user message. Vision via image_url part when the model supports
  // it (NIM endpoints generally do; OpenRouter routes it correctly). The
  // detail field is honored by OpenAI and ignored gracefully elsewhere.
  const userParts: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (imagePath) {
    const { data: imageData, mimeType } = await readImageForDetail(imagePath, detail);
    userParts.push({ type: "image_url", image_url: { url: `data:${mimeType};base64,${imageData}`, detail } });
  }
  if (retryFeedback) userParts.push({ type: "text", text: retryFeedback });

  // Per-pass thinking policy: critique ON (DeepSeek's strength is reasoning),
  // extraction OFF (deterministic fields, avoid truncation). Overrideable.
  const thinkingEnabled = !OPENAI_THINKING_DISABLED && pass === "critique";

  const body: Record<string, unknown> = {
    model: cfg.model,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: userParts },
    ],
    max_tokens: MAX_OUTPUT_TOKENS,
    // Modest temperature — the tagger's quality bar comes from the prompt +
    // banned-phrase gate, not from creative sampling. Matches NVIDIA's
    // documented default for DeepSeek V4 Pro.
    temperature: 1,
    top_p: 0.95,
    // Reasoning toggle for NIM-style endpoints. Non-NIM providers ignore
    // unknown fields silently, so this is safe to send unconditionally.
    chat_template_kwargs: { thinking: thinkingEnabled },
  };

  // MiniMax M3: thinking is ON by default and wraps content in <think> tags.
  // Disable thinking for BOTH passes:
  //   - Extraction: deterministic fields, thinking adds noise + truncation risk
  //   - Critique: the critique prompt is ~1500 tokens of structured instructions.
  //     With thinking ON, MiniMax burns 800-2500 reasoning tokens and sometimes
  //     (1 in 5 runs) produces truncated/corrupted JSON or a lazy minimal
  //     response. Disabling thinking makes the output deterministic and reliable
  //     without sacrificing quality (the prompt itself drives the reasoning).
  // Also switch to max_completion_tokens (excludes any residual reasoning tokens).
  const isMiniMax = cfg.baseUrl.includes("minimax");
  if (isMiniMax) {
    body.thinking = { type: "disabled" };
    body.max_completion_tokens = MAX_OUTPUT_TOKENS;
    delete body.max_tokens;
  }

  const endpoint = `${cfg.baseUrl}/chat/completions`;
  if (DEBUG_TAGGER) {
    console.error(`[openai-compat] model=${cfg.model} pass=${pass} base=${cfg.baseUrl} thinking=${thinkingEnabled}`);
  }
  const response = await fetchWithRetry(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`OpenAI-compatible API error ${response.status}: ${await response.text()}`);

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string | Array<{ type?: string; text?: string }> } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };
  if (DEBUG_TAGGER) {
    const u = data.usage;
    console.error(`[openai-compat] pass=${pass} usage in=${u?.prompt_tokens ?? "?"} out=${u?.completion_tokens ?? "?"} total=${u?.total_tokens ?? "?"}`);
  }
  const content = data.choices?.[0]?.message?.content;
  // MiniMax M3 sometimes includes <think>...</think> tags in content even with
  // reasoning_split. Strip them so JSON parsing doesn't break.
  const stripThinkTags = (s: string) => s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  if (typeof content === "string") return stripThinkTags(content);
  if (Array.isArray(content)) {
    return stripThinkTags(content.filter((c) => typeof c.text === "string").map((c) => c.text ?? "").join(""));
  }
  return "";
}

async function callClaude(
  prompt: string,
  imagePath: string | null,
  retryFeedback?: string,
  detail: "low" | "high" = "high",
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  // Claude content blocks: image uses raw base64 (no data-URI prefix). Claude
  // has no detail knob, so "low" pre-resizes via sharp to cut token count.
  const content: Array<Record<string, unknown>> = [];
  if (imagePath) {
    const { data: imageData, mimeType: mediaType } = await readImageForDetail(imagePath, detail);
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: imageData } });
  }
  content.push({ type: "text", text: prompt });
  if (retryFeedback) content.push({ type: "text", text: retryFeedback });

  const response = await fetchWithRetry(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: CLAUDE_AUTO_TAG_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: SYSTEM,
      messages: [{ role: "user", content }],
    }),
  });

  if (!response.ok) throw new Error(`Claude API error ${response.status}: ${await response.text()}`);

  const data = await response.json() as { content?: Array<{ type?: string; text?: string }> };
  return (data.content ?? [])
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "").join("");
}

async function callGemini(
  prompt: string,
  imagePath: string | null,
  retryFeedback?: string,
  detail: "low" | "high" = "high",
  pass: TaggerPass = "extraction",
  /**
   * Override the per-pass default thinking level. Used by the adaptive
   * escalation path: a weak extraction at MINIMAL re-runs at HIGH. Without an
   * override, the level is derived from `pass` (extraction=MINIMAL, critique=HIGH).
   * Only meaningful for 3.5 models; ignored on 2.5 (which uses thinkingBudget).
   */
  thinkingOverride?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH",
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  // Gemini parts: inlineData uses raw base64 (no prefix), camelCase. Like
  // Claude, no detail knob — "low" pre-resizes via sharp to cut token count.
  const parts: Array<Record<string, unknown>> = [];
  if (imagePath) {
    const { data: imageData, mimeType } = await readImageForDetail(imagePath, detail);
    parts.push({ inlineData: { mimeType, data: imageData } });
  }
  parts.push({ text: prompt });
  if (retryFeedback) parts.push({ text: retryFeedback });

  // Gemini thinking control differs by model generation:
  //   - 2.5 Flash/Pro: reasoning tokens draw from the SAME maxOutputTokens
  //     budget. On structured extraction the model routinely spent 1500–2500
  //     tokens "thinking" and truncated the JSON mid-stream → non-JSON →
  //     "unusable draft". Disable via thinkingBudget: 0. Critique is left on
  //     (default) because it benefits from reasoning.
  //   - 3.5 Flash: reasoning runs in a SEPARATE budget (no truncation risk) and
  //     is controlled via thinkingLevel: MINIMAL/LOW/MEDIUM/HIGH (default
  //     MEDIUM). Extraction gets MINIMAL (deterministic fields, no judgment to
  //     reason over — preserves the speed/cost win the 2.5 disable wanted).
  //     Critique gets HIGH — this is the pass where deep reasoning most closes
  //     the gap on Claude Sonnet's writing quality.
  const generationConfig: Record<string, unknown> = { maxOutputTokens: MAX_OUTPUT_TOKENS };
  const is35Model = /3\.5|3-5/i.test(GEMINI_AUTO_TAG_MODEL);
  if (is35Model) {
    const level = thinkingOverride ?? (pass === "extraction" ? "MINIMAL" : "HIGH");
    generationConfig.thinkingConfig = { thinkingLevel: level };
  } else if (pass === "extraction") {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }

  const endpoint = `${GEMINI_API_BASE}/${GEMINI_AUTO_TAG_MODEL}:generateContent`;
  if (DEBUG_TAGGER) {
    const escalation = thinkingOverride ? ` (escalated from ${pass} default)` : "";
    console.error(`[gemini] model=${GEMINI_AUTO_TAG_MODEL} pass=${pass}${escalation} thinkingConfig=${JSON.stringify(generationConfig.thinkingConfig)}`);
  }
  const response = await fetchWithRetry(endpoint, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM }] },
      contents: [{ role: "user", parts }],
      generationConfig,
    }),
  });

  if (!response.ok) throw new Error(`Gemini API error ${response.status}: ${await response.text()}`);

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    promptFeedback?: { blockReason?: string };
    // usageMetadata carries token accounting. On 3.5 thinking models, reasoning
    // tokens are reported in `thoughtsTokenCount` — a non-zero value there is
    // the proof that thinkingLevel was actually applied by the API, not just
    // accepted silently. (2.5 reported the same field; older models omit it.)
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
      thoughtsTokenCount?: number;
    };
  };
  // Surface safety blocks and truncation explicitly — both produced cryptic
  // "unusable draft" errors before. A MAX_TOKENS finish means the JSON was cut
  // mid-stream; SAFETY means the image was blocked. Both are actionable.
  const candidate = data.candidates?.[0];
  const blockReason = data.promptFeedback?.blockReason;
  if (blockReason) throw new Error(`Gemini blocked the request (${blockReason}). Try a different screenshot.`);
  const finishReason = candidate?.finishReason;
  if (finishReason && finishReason !== "STOP") {
    throw new Error(`Gemini stopped early (${finishReason}). ${finishReason === "MAX_TOKENS" ? "Output was truncated before the JSON closed — raise MAX_OUTPUT_TOKENS or simplify the request." : "Try Auto-fill again."}`);
  }
  const parts_out = candidate?.content?.parts ?? [];
  // Confirm the thinkingConfig was actually applied, not silently ignored.
  // thoughtsTokenCount > 0 means reasoning tokens were generated for this call.
  // Extraction should be ~0 (MINIMAL); critique should be materially > 0 (HIGH).
  if (DEBUG_TAGGER) {
    const u = data.usageMetadata;
    console.error(`[gemini] pass=${pass} usage thoughts=${u?.thoughtsTokenCount ?? "?"} out=${u?.candidatesTokenCount ?? "?"} in=${u?.promptTokenCount ?? "?"}`);
  }
  return parts_out.filter((p) => typeof p.text === "string").map((p) => p.text ?? "").join("");
}

/** Route to the active provider. Auto-falls back if the preferred key is missing. */
async function callModel(
  pass: TaggerPass,
  prompt: string,
  imagePath: string | null,
  retryFeedback?: string,
  detail: "low" | "high" = "high",
  /**
   * Gemini 3.5 only: escalate the thinking level above the pass default. Used by
   * the adaptive extraction path when the MINIMAL result came back weak. Ignored
   * by OpenAI/Claude and by 2.5 Gemini models.
   */
  thinkingOverride?: "MINIMAL" | "LOW" | "MEDIUM" | "HIGH",
  /** Per-call provider override (from /api/auto-retag). Bypasses env resolution. */
  providerOverride?: Provider,
): Promise<string> {
  const provider = resolveProvider(pass, providerOverride);
  switch (provider) {
    case "claude":  return callClaude(prompt, imagePath, retryFeedback, detail);
    case "gemini":  return callGemini(prompt, imagePath, retryFeedback, detail, pass, thinkingOverride);
    case "mistral": return callOpenAICompatible(prompt, imagePath, retryFeedback, detail, pass, mistralConfigForPass(pass));
    case "minimax": return callOpenAICompatible(prompt, imagePath, retryFeedback, detail, pass, minimaxConfigForPass(pass));
    case "grok":    return callOpenAICompatible(prompt, imagePath, retryFeedback, detail, pass, grokConfigForPass(pass));
    default:        return callOpenAI(prompt, imagePath, retryFeedback, detail, pass);
  }
}

// ─── core two-pass orchestration ─────────────────────────────────────────────

export async function tagImage(input: TaggerInput): Promise<TaggerOutput> {
  if (!hasVisionKey()) throw new Error("No vision provider key set. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in .env.");

  const corpusPath = toCorpusRelativePath(input.imagePath);
  const today = new Date().toISOString().slice(0, 10);
  const { width: imgWidth, height: imgHeight } = await readImageDimensions(input.imagePath);
  const platform = detectPlatform(imgWidth, imgHeight);

  // ── Deterministic color extraction (code-level, not model-guessed) ─────────
  let quantizedColors: string[] = [];
  try {
    quantizedColors = await extractQuantizedColors(input.imagePath);
  } catch (err) {
    console.error("[tagger] Color extraction failed, falling back to model-guessed colors:", err instanceof Error ? err.message : err);
  }

  // ── PASS 1: extraction (facts + geometry, with ground-truth colors) ────────
  // Adaptive detail: bulk imports pass imageDetail:"low" to cut tokens. If the
  // low-detail result is weak (blank patternType, "Untitled" name, no
  // categories), re-run at "high" — pays for fidelity only when it's needed.
  const requestedDetail: "low" | "high" = input.imageDetail === "low" ? "low" : "high";

  // Some providers (Claude) wrap JSON in markdown fences — strip them before parsing.
  const stripFences = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const parseExtraction = (text: string): Record<string, unknown> => {
    try { return JSON.parse(stripFences(text)); }
    catch { throw new Error(`Pass 1 (extraction) returned non-JSON:\n${text}`); }
  };

  let extractionRawText = await callModel(
    "extraction",
    buildExtractionPrompt(input.productName, input.url, quantizedColors, platform, input.domSignals),
    input.imagePath,
    undefined,
    requestedDetail,
    undefined,
    input.extractionProvider,
  );
  let extractionParsed = parseExtraction(extractionRawText);

  // Adaptive re-run: if we asked for low and the model clearly couldn't read the
  // page, retry once at high. Probe the RAW extraction output — sanitizeTaggerPayload
  // applies defaults (patternType → "dashboard") that mask the very weakness we're
  // detecting, making the !probe.patternType check never fire. Read the raw fields
  // directly so a genuinely-empty result is detected as weak.
  if (requestedDetail === "low") {
    const rawType = typeof extractionParsed.patternType === "string" ? (extractionParsed.patternType as string).trim() : "";
    const rawCats = Array.isArray(extractionParsed.categories) ? (extractionParsed.categories as unknown[]).length : 0;
    const probeName = (typeof extractionParsed.productName === "string" ? extractionParsed.productName.trim() : "");
    const weak = !rawType
      && !rawCats
      && (!probeName || probeName.toLowerCase() === "untitled");
    if (weak) {
      extractionRawText = await callModel(
        "extraction",
        buildExtractionPrompt(input.productName, input.url, quantizedColors, platform, input.domSignals),
        input.imagePath,
        undefined,
        "high",
        undefined,
        input.extractionProvider,
      );
      extractionParsed = parseExtraction(extractionRawText);
    }
  }

  // Adaptive thinking (Gemini 3.5 only): if the MINIMAL extraction came back
  // weak on the same signals the detail escalation uses, the model likely
  // couldn't resolve the page in low-reasoning mode. Re-run once at HIGH — the
  // same image, same detail level, more reasoning budget. Targets the rare
  // ambiguous/hybrid layout where perception genuinely benefits from chain of
  // thought. Cost-free on the common case (strong first result → no re-run).
  // Skipped if we already escalated detail above (the weak-result probe runs
  // against the latest extractionParsed, so this naturally composes with it).
  if (resolveProvider("extraction") === "gemini" && /3\.5|3-5/i.test(GEMINI_AUTO_TAG_MODEL)) {
    // Same raw-probe fix as the detail-escalation block above — sanitizeTaggerPayload's
    // defaults mask the weakness we're detecting.
    const rawType = typeof extractionParsed.patternType === "string" ? (extractionParsed.patternType as string).trim() : "";
    const rawCats = Array.isArray(extractionParsed.categories) ? (extractionParsed.categories as unknown[]).length : 0;
    const probeName = (typeof extractionParsed.productName === "string" ? extractionParsed.productName.trim() : "");
    const weak = !rawType
      && !rawCats
      && (!probeName || probeName.toLowerCase() === "untitled");
    if (weak) {
      if (DEBUG_TAGGER) console.error("[tagger] weak extraction at MINIMAL — re-running at thinkingLevel HIGH");
      extractionRawText = await callModel(
        "extraction",
        buildExtractionPrompt(input.productName, input.url, quantizedColors, platform, input.domSignals),
        input.imagePath,
        undefined,
        requestedDetail === "low" ? "high" : requestedDetail,
        "HIGH",
        input.extractionProvider,
      );
      extractionParsed = parseExtraction(extractionRawText);
    }
  }

  const extraction = sanitizeTaggerPayload(extractionParsed);
  const patternDiscovery = extraction.suggestedPatternType
    ? { suggestedPatternType: extraction.suggestedPatternType }
    : undefined;
  // Override dominantColors with the ground-truth quantized set when available,
  // so even if the model ignored instructions, we get deterministic colors.
  if (quantizedColors.length) {
    extraction.dominantColors = quantizedColors;
  }
  // Override bodyFont with the DOM-signal computed fontFamily when available.
  // Parse to the first family name (e.g. "Verdana, Geneva, sans-serif" → "Verdana")
  // so the entry stores a clean font name. Body-only override: the DOM computed
  // style is the body font, not the display font (which is often a different,
  // decorative face the body element's computed style can't see).
  if (input.domSignals?.styles?.fontFamily) {
    const firstFamily = input.domSignals.styles.fontFamily.split(",")[0].trim().replace(/['"]/g, "");
    if (firstFamily) extraction.bodyFont = firstFamily;
  }

  // Platform normalization: strip desktop-only components/layout from mobile
  // screenshots and vice versa. This runs AFTER sanitization so the enum
  // filter already removed unknown values. `_raw.extraction` (the raw model
  // response) is preserved unmodified below for auditability.
  const normalized = normalizeExtractionByPlatform(extraction, platform);
  extraction.components = normalized.components;
  extraction.layout = normalized.layout;

  // Build the platform-scoped critique context: the normalized extraction with
  // palette fields stripped (so the critique model can't infer color risks).
  // Using the normalized (not raw) extraction here means Pass 2 never sees the
  // desktop sidebar that was stripped from a mobile screenshot — preventing it
  // from re-inventing it in critique prose.
  const critiqueExtraction = critiqueSafeExtraction(extraction);

  // ── Resolve the effective product name ───────────────────────────────────
  // If the caller supplied one, use it verbatim. Otherwise take the name the
  // model read off the page (Pass 1 fills `productName` when none was supplied).
  // This lets bulk/single import run with no manual name — the upload is the
  // expensive part; a missing name must not block it.
  const suppliedName = (input.productName || "").trim();
  const inferredName = typeof extractionParsed.productName === "string"
    ? extractionParsed.productName.trim()
    : "";
  const effectiveName = suppliedName || inferredName || "Untitled";
  // Auto-id must be unique per IMAGE, not per product — otherwise every image
  // of the same product gets the same id (`alan-2026-07-05` × 127), which the
  // corpus validator rejects as duplicates. Fold the image filename stem in so
  // each entry has a distinct, human-meaningful id like
  // `alan-ios-screens-42-2026-07-05`. The stem is slugified to match the id
  // charset (lowercase, hyphens, no version noise like "-2-2" suffixes).
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  const imageStem = basename(input.imagePath, extname(input.imagePath));
  const autoId = input.id
    ?? `${slug(effectiveName)}-${slug(imageStem)}-${today}`;

  // ── extractionOnly: skip Pass 2 entirely. Bulk imports use this to defer the
  // critique pass (a full text-only model call per image) until the user
  // explicitly asks for it via /api/auto-critique. Halves per-image cost.
  // The critique fields come back as [DRAFT — critique deferred] placeholders,
  // which the validator's draft-marker gate blocks from committing — so a
  // deferred row can be staged but not saved until critique runs.
  if (input.extractionOnly) {
    return {
      id:         autoId,
      title:      `${effectiveName} — (add descriptive subtitle)`,
      patternType: extraction.patternType,
      patternDiscovery,
      platform,
      categories: extraction.categories,
      styleTags:  extraction.styleTags,
      components: extraction.components,
    domainTags: extraction.domainTags.length ? extraction.domainTags : undefined,
    colorScheme: extraction.colorScheme || undefined,
    industryVertical: extraction.industryVertical || undefined,
    responsiveBehavior: extraction.responsiveBehavior || undefined,
      source: {
        productName: effectiveName,
        url:         input.url ?? null,
        capturedAt:  today,
        capturedBy:  "self",
      },
      image: {
        visibility: "private",
        path:       corpusPath,
        width:      imgWidth,
        height:     imgHeight,
      },
      visual: {
        dominantColors: extraction.dominantColors,
        accentColor:    extraction.accentColor,
        colorRoles:     extraction.colorRoles,
        typePairing: { display: extraction.displayFont, body: extraction.bodyFont, notes: extraction.typographyNotes || "" },
        spacingDensity: extraction.spacingDensity,
        cornerStyle:    extraction.cornerStyle,
        usesShadows:    extraction.usesShadows,
        usesBorders:    extraction.usesBorders,
      },
      critique:        "[DRAFT — critique deferred] Run 'Generate critique' to draft this.",
      whatToSteal:     ["[DRAFT — critique deferred]"],
      antiPatterns: {
        antiPatterns:       ["[DRAFT — critique deferred]"],
        whereThisFails:     [],
        accessibilityRisks: [],
      },
      layout:          extraction.layout,
      businessRationale: undefined,
      voice:           undefined,
      qualityTier:     "exceptional",
      qualityScore:    3,
      addedAt:         today,
      provenance:      { taggedBy: "auto" }, // tagger produced; flips to auto-reviewed when a human edits+approves
      _raw: {
        extractionProvider: resolveProvider("extraction", input.extractionProvider),
        critiqueProvider: null,
        extractionModel: activeModelName("extraction"),
        critiqueModel: null,
        extraction: extractionParsed,
        critique: null,
        quantizedColors,
        domSignals: input.domSignals ?? null,
        extractionOnly: true,
      },
    };
  }

  // ── PASS 2: critique (judgment, fed validated extraction as fact) ──────────
  // Pass 2 is text-only — the model reasons from the validated extraction, not
  // by re-looking at pixels. This is the spec's core architecture choice.
  let critiqueRawText = await callModel(
    "critique",
    buildCritiquePrompt(effectiveName, critiqueExtraction, input.domSignals),
    null, // no image — pure reasoning from facts
    undefined,
    "high",
    undefined,
    input.critiqueProvider,
  );

  let critiqueParsed: Record<string, unknown>;
  try {
    critiqueParsed = JSON.parse(stripFences(critiqueRawText));
  } catch {
    throw new Error(`Pass 2 (critique) returned non-JSON:\n${critiqueRawText}`);
  }
  let critique = sanitizeTaggerPayload(critiqueParsed);

  // ── Combined critique gates ────────────────────────────────────────────────
  // Retry once with explicit feedback, then scrub surviving unsupported prose
  // as a safety net (the retry may fail, the model may persist the claim, or it
  // may not parse). Component consistency keeps Pass 2 from inventing structure
  // that Pass 1 did not observe.
  const bannedErrors = validateNoBannedPhrases(critiqueParsed);
  const iconOnlyErrors = validateNoIconOnlyClaims(critiqueParsed);
  const componentErrors = validateCritiqueComponentClaims(critiqueParsed, extraction.components);
  const gateErrors = [...bannedErrors, ...iconOnlyErrors, ...componentErrors];
  if (gateErrors.length > 0) {
    const feedback = `\n\nYour previous response was rejected — fix these and return the full JSON again:\n${gateErrors.join("\n")}`;
    const retryText = await callModel(
      "critique",
      buildCritiquePrompt(effectiveName, critiqueExtraction, input.domSignals),
      null,
      feedback,
      "high",
      undefined,
      input.critiqueProvider,
    );
    try {
      critiqueParsed = JSON.parse(stripFences(retryText));
      critique = sanitizeTaggerPayload(critiqueParsed);
    } catch {
      // Retry failed to parse — keep the original (flagged) critique; the human will rewrite it.
    }
  }

  // Safety nets run on the sanitized critique object so they cover both a retry
  // result and the original (when the retry failed or persisted a bad claim).
  scrubProseIconOnly(critique);
  scrubUnsupportedComponentClaims(critique, extraction.components);

  // ── Merge passes into TaggerOutput ─────────────────────────────────────────
  return {
    id:         autoId,
    title:      `${effectiveName} — (add descriptive subtitle)`,
    patternType: extraction.patternType,
    patternDiscovery,
    platform,
    categories: extraction.categories,
    styleTags:  extraction.styleTags,
    components: extraction.components,
    domainTags: extraction.domainTags.length ? extraction.domainTags : undefined,
    colorScheme: extraction.colorScheme || undefined,
    industryVertical: extraction.industryVertical || undefined,
    responsiveBehavior: extraction.responsiveBehavior || undefined,
    source: {
      productName: effectiveName,
      url:         input.url ?? null,
      capturedAt:  today,
      capturedBy:  "self",
    },
    image: {
      visibility: "private",
      path:       corpusPath,
      width:      imgWidth,
      height:     imgHeight,
    },
    visual: {
      dominantColors: extraction.dominantColors,
      accentColor:    extraction.accentColor,
      colorRoles:     extraction.colorRoles,
      typePairing: {
        display: extraction.displayFont,
        body:    extraction.bodyFont,
        notes:   critique.typographyNotes || extraction.typographyNotes,
      },
      spacingDensity: extraction.spacingDensity,
      cornerStyle:    extraction.cornerStyle,
      usesShadows:    extraction.usesShadows,
      usesBorders:    extraction.usesBorders,
    },
    critique:        `[DRAFT — REWRITE] ${critique.draftCritique}`,
    whatToSteal:     critique.draftWhatToSteal.map((t) => `[DRAFT] ${t}`),
    antiPatterns: {
      antiPatterns:       critique.draftAntiPatterns.map((t) => `[DRAFT] ${t}`),
      whereThisFails:     [],
      // Pass structured objects directly — the evidence gate already ran in the
      // sanitizer. No flattening to strings; the schema accepts the union type.
      accessibilityRisks: critique.draftAccessibilityRisks,
    },
    layout:          extraction.layout,
    businessRationale: critique.businessRationale,
    voice:           critique.voice,
    mood:            critique.mood || undefined,
    qualityTier:     critique.qualityTier,
    qualityScore:    critique.qualityTier === "cautionary" ? 2 : 3,
    tierChangeJustification: critique.tierChangeJustification,
    addedAt:         today,
    provenance:      { taggedBy: "auto" }, // two-pass tagger output; human review flips to auto-reviewed
    _raw: {
      extractionProvider: resolveProvider("extraction", input.extractionProvider),
      critiqueProvider: resolveProvider("critique", input.critiqueProvider),
      extractionModel: activeModelName("extraction"),
      critiqueModel: activeModelName("critique"),
      extraction: extractionParsed,
      critique: critiqueParsed,
      quantizedColors,
      domSignals: input.domSignals ?? null,
    },
  };
}

/**
 * Deferred Pass 2 (critique only). Used by /api/auto-critique to fill in the
 * critique/steals/antiPatterns on a row that was staged extraction-only.
 *
 * Takes the already-validated extraction object (the `_raw.extraction` from a
 * prior tagImage call) plus the product name, runs Pass 2 + the banned-phrase
 * retry, and returns just the critique-shaped fields to merge onto the entry.
 * No image is re-sent — Pass 2 reasons from facts.
 */
export async function generateCritique(
  productName: string,
  extractionParsed: Record<string, unknown>,
  critiqueProvider?: Provider,
  domSignals?: TaggerInput["domSignals"],
  platform?: "web" | "mobile" | "tablet",
): Promise<{
  critique: string;
  whatToSteal: string[];
  antiPatterns: { antiPatterns: string[]; whereThisFails: string[]; accessibilityRisks: Array<{ element: string; risk: string; evidence: string; confidence: string; wcag: string[] }> };
  businessRationale?: { businessGoal: string; targetUser: string; rationale: string; confirmed: boolean };
  voice?: { tone: string; examples: string[]; avoid: string[] };
  mood?: string;
  qualityTier: string;
  qualityScore: number;
  typographyNotes: string;
}> {
  if (!hasCritiqueKey()) throw new Error("No provider key set. Critique needs at least one of OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or MISTRAL_API_KEY in .env.");
  const stripFences = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  // Normalize extraction by platform (same as the immediate tagImage path) so
  // deferred critique doesn't re-introduce desktop sidebar claims on mobile.
  const extraction = sanitizeTaggerPayload(extractionParsed);
  if (platform) {
    const normalized = normalizeExtractionByPlatform(extraction, platform);
    extraction.components = normalized.components;
    extraction.layout = normalized.layout;
  }
  const critiqueExtraction = critiqueSafeExtraction(extraction);

  let critiqueRawText = await callModel(
    "critique",
    buildCritiquePrompt(productName, critiqueExtraction, domSignals),
    null,
    undefined,
    "high",
    undefined,
    critiqueProvider,
  );
  let critiqueParsed: Record<string, unknown>;
  try { critiqueParsed = JSON.parse(stripFences(critiqueRawText)); }
  catch { throw new Error(`Pass 2 (critique) returned non-JSON:\n${critiqueRawText}`); }
  let critique = sanitizeTaggerPayload(critiqueParsed);

  const bannedErrors = validateNoBannedPhrases(critiqueParsed);
  const iconOnlyErrors = validateNoIconOnlyClaims(critiqueParsed);
  const componentErrors = validateCritiqueComponentClaims(critiqueParsed, extraction.components);
  const gateErrors = [...bannedErrors, ...iconOnlyErrors, ...componentErrors];
  if (gateErrors.length > 0) {
    const feedback = `\n\nYour previous response was rejected — fix these and return the full JSON again:\n${gateErrors.join("\n")}`;
    const retryText = await callModel("critique", buildCritiquePrompt(productName, critiqueExtraction, domSignals), null, feedback, "high", undefined, critiqueProvider);
    try { critiqueParsed = JSON.parse(stripFences(retryText)); critique = sanitizeTaggerPayload(critiqueParsed); } catch { /* keep flagged original */ }
  }
  scrubProseIconOnly(critique);
  scrubUnsupportedComponentClaims(critique, extraction.components);

  return {
    critique: `[DRAFT — REWRITE] ${critique.draftCritique}`,
    whatToSteal: critique.draftWhatToSteal.map((t) => `[DRAFT] ${t}`),
    antiPatterns: {
      antiPatterns: critique.draftAntiPatterns.map((t) => `[DRAFT] ${t}`),
      whereThisFails: [],
      accessibilityRisks: critique.draftAccessibilityRisks,
    },
    businessRationale: critique.businessRationale,
    voice: critique.voice,
    qualityTier: critique.qualityTier,
    qualityScore: critique.qualityTier === "cautionary" ? 2 : 3,
    typographyNotes: critique.typographyNotes || "",
    mood: critique.mood || undefined,
  };
}
