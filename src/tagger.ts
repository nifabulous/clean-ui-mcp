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
import { detectPlatform } from "./schema.js";
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

const SPACING_DENSITIES = ["compact", "moderate", "spacious"] as const;
const CORNER_STYLES = ["sharp", "slight-round", "pill", "mixed"] as const;

const PATTERN_TYPES = [
  "dashboard","landing-page","pricing","onboarding","auth","settings",
  "search","checkout","profile","marketing-hero",
  "data-table","empty-state","navigation","forms","mobile-nav",
  "notifications","editor-canvas","chat-interface","command-palette","modal",
] as const;

const LAYOUT_FORMS = ["single-column", "two-column", "three-column", "modal-overlay"] as const;
const LAYOUT_REGION_ROLES = [
  "primary-nav","icon-nav","summary-strip","main-canvas",
  "detail-rail","form-panel","visual-panel","overlay-card",
] as const;

const QUALITY_TIERS = ["exceptional", "cautionary"] as const;

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
}

export interface TaggerOutput {
  id:             string;
  title:          string;
  patternType:    string;
  platform?:      "web" | "mobile" | "tablet";
  categories:     string[];
  styleTags:      string[];
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
    accessibilityRisks: string[];
  };
  layout?: {
    form: string;
    regions: Array<{ role: string; width?: string }>;
  };
  voice?: {
    tone: string;
    examples: string[];
    avoid: string[];
  };
  qualityTier:     string;
  qualityScore:    number;
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

const OPENAI_AUTO_TAG_MODEL = process.env.OPENAI_AUTO_TAG_MODEL ?? "gpt-5.4-nano";
const CLAUDE_AUTO_TAG_MODEL = process.env.CLAUDE_AUTO_TAG_MODEL ?? "claude-haiku-4-5";
const GEMINI_AUTO_TAG_MODEL = process.env.GEMINI_AUTO_TAG_MODEL ?? "gemini-2.5-flash";

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

type Provider = "openai" | "claude" | "gemini";
type TaggerPass = "extraction" | "critique";

/** Resolve which provider to use for a given pass, with auto-fallback. */
function resolveProvider(pass: TaggerPass): Provider {
  const envVar = pass === "extraction" ? "AUTO_TAG_PROVIDER_EXTRACTION" : "AUTO_TAG_PROVIDER_CRITIQUE";
  const preferred = (process.env[envVar] ?? process.env.AUTO_TAG_PROVIDER ?? "openai").toLowerCase() as Provider;
  // OpenAI keys may be set per-pass (OPENAI_API_KEY_EXTRACTION / _CRITIQUE) for
  // split-provider setups — e.g. real OpenAI for extraction (vision) and NIM
  // for critique (writing). Honor the per-pass variant when checking presence.
  const tier = pass.toUpperCase();
  const has = {
    openai: !!(process.env[`OPENAI_API_KEY_${tier}`] ?? process.env.OPENAI_API_KEY),
    claude: !!process.env.ANTHROPIC_API_KEY,
    gemini: !!process.env.GEMINI_API_KEY,
  };
  if (has[preferred]) return preferred;
  for (const p of ["openai", "claude", "gemini"] as const) {
    if (has[p]) {
      console.error(`[tagger] ${envVar}="${preferred}" but no key set — falling back to ${p} for ${pass}.`);
      return p;
    }
  }
  return preferred;
}

/** Check if ANY vision provider key is configured. */
export function hasVisionKey(): boolean {
  // Per-pass OpenAI variants (OPENAI_API_KEY_EXTRACTION / _CRITIQUE) count too —
  // a split-provider setup using only OPENAI_API_KEY_CRITIQUE (NIM/DeepSeek for
  // critique + real OpenAI for extraction) was falsely reporting "no vision
  // key" here, mirroring the per-pass resolution already in resolveProvider.
  const hasOpenAI = !!(
    process.env.OPENAI_API_KEY ||
    process.env.OPENAI_API_KEY_EXTRACTION ||
    process.env.OPENAI_API_KEY_CRITIQUE
  );
  return !!(hasOpenAI || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY);
}

const PROVIDER_NAMES: Record<Provider, string> = { openai: "OpenAI", claude: "Claude", gemini: "Gemini" };
const PROVIDER_MODELS: Record<Provider, string> = { openai: OPENAI_AUTO_TAG_MODEL, claude: CLAUDE_AUTO_TAG_MODEL, gemini: GEMINI_AUTO_TAG_MODEL };

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
  return PROVIDER_MODELS[provider];
}

// ─── PASS 1: extraction prompt (facts + geometry) ────────────────────────────

function buildExtractionPrompt(
  productName: string,
  url: string | null | undefined,
  quantizedColors: string[],
): string {
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
  return `${lead}
Return a JSON object with exactly these fields.
This is an EXTRACTION pass — factual/structural fields only, no critique yet.

VERIFIED GROUND TRUTH — treat every value below as fact, do not re-derive or contradict it:
${JSON.stringify({ quantizedColors }, null, 2)}

{
${nameField}  "patternType": "",       // ONE from: ${PATTERN_TYPES.join(", ")}
  "categories": [],        // 1-3 from: ${CATEGORIES.join(", ")}
  "styleTags": [],         // 1-3 from: ${STYLE_TAGS.join(", ")}
  "dominantColors": [],    // copy from quantizedColors verbatim — do not invent hex values not in that list
  "accentColor": null,     // pick the primary interactive/brand color FROM quantizedColors only
  "displayFont": null,     // name if you're confident; null beats a wrong guess
  "bodyFont": null,        // name if identifiable; else null
  "spacingDensity": "",    // one of: compact, moderate, spacious
  "cornerStyle": "",       // one of: sharp, slight-round, pill, mixed
  "usesShadows": false,    // true if box-shadow is visible and doing structural work
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
- Return ONLY the JSON object. No explanation, no markdown.`;
}

// ─── PASS 2: critique prompt (judgment + design intent) ──────────────────────

function buildCritiquePrompt(
  productName: string,
  extraction: Record<string, unknown>,
): string {
  return `Here is the VALIDATED structural extraction for ${productName} (treat every value as
established fact — do not re-describe or contradict it):
${JSON.stringify(extraction, null, 2)}

Step 1 — Observe first. Before writing anything else, list exactly 5 specific, concrete visual
elements you can point to on screen (an icon color, an italic word, a specific spacing value, a
copy choice, an interaction affordance). Put this list in "observations". Each item must be a
single, pointable thing — not generic ("the layout").

Step 2 — Critique using ONLY items from your observations list. Return this JSON:

{
  "observations": [],          // exactly 5 specific, pointable visual elements (required)
  "typographyNotes": "",       // 1-2 sentences on how the type choices create hierarchy
  "draftCritique": "",         // 3-5 sentences: for EACH notable decision name DECISION + EFFECT + REJECTION
  "draftWhatToSteal": [],      // 3-5 specific, copyable techniques with reasoning attached. Each is a string.
  "draftAntiPatterns": [],     // REQUIRED, at least 1. Must describe a DIFFERENT decision than draftCritique.
  "voiceTone": "",             // omit entirely if no notable copy is visible
  "voiceExamples": [],         // real copy visible on screen, verbatim
  "voiceAvoid": [],            // what voice this design does NOT use
  "qualityTier": ""            // ONE from: ${QUALITY_TIERS.join(", ")}. Default exceptional. Only mark
                               // "cautionary" if the screenshot shows clear, teachable problems.
}

Rules:
- Every draftCritique/draftWhatToSteal claim must trace back to something in "observations".
- draftAntiPatterns must not restate draftCritique's decision from the opposite angle.
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
  categories: string[];
  styleTags: string[];
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
  layout?: { form: string; regions: Array<{ role: string; width?: string }> };
  voice?: { tone: string; examples: string[]; avoid: string[] };
  qualityTier: string;
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

  return {
    patternType: oneFromAllowed(parsed.patternType, PATTERN_TYPES, "dashboard"),
    categories: listFromAllowed(parsed.categories, CATEGORIES, ["dashboard"]),
    styleTags: listFromAllowed(parsed.styleTags, STYLE_TAGS, ["minimal"]),
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
    draftWhatToSteal: textList(parsed.draftWhatToSteal).length
      ? textList(parsed.draftWhatToSteal)
      : ["Review the screenshot and extract one concrete interface technique before saving."],
    draftAntiPatterns: textList(parsed.draftAntiPatterns).length
      ? textList(parsed.draftAntiPatterns)
      : ["[DRAFT] Review the screenshot and name one common UI mistake this design avoids."],
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
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((c) => typeof c.text === "string").map((c) => c.text ?? "").join("");
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
): Promise<string> {
  const provider = resolveProvider(pass);
  switch (provider) {
    case "claude":  return callClaude(prompt, imagePath, retryFeedback, detail);
    case "gemini":  return callGemini(prompt, imagePath, retryFeedback, detail, pass, thinkingOverride);
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
    buildExtractionPrompt(input.productName, input.url, quantizedColors),
    input.imagePath,
    undefined,
    requestedDetail,
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
        buildExtractionPrompt(input.productName, input.url, quantizedColors),
        input.imagePath,
        undefined,
        "high",
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
        buildExtractionPrompt(input.productName, input.url, quantizedColors),
        input.imagePath,
        undefined,
        requestedDetail === "low" ? "high" : requestedDetail,
        "HIGH",
      );
      extractionParsed = parseExtraction(extractionRawText);
    }
  }

  const extraction = sanitizeTaggerPayload(extractionParsed);
  // Override dominantColors with the ground-truth quantized set when available,
  // so even if the model ignored instructions, we get deterministic colors.
  if (quantizedColors.length) {
    extraction.dominantColors = quantizedColors;
  }

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
      platform,
      categories: extraction.categories,
      styleTags:  extraction.styleTags,
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
      voice:           undefined,
      qualityTier:     "exceptional",
      qualityScore:    3,
      addedAt:         today,
      provenance:      { taggedBy: "auto" }, // tagger produced; flips to auto-reviewed when a human edits+approves
      _raw: {
        extractionProvider: resolveProvider("extraction"),
        critiqueProvider: null,
        extractionModel: activeModelName("extraction"),
        critiqueModel: null,
        extraction: extractionParsed,
        critique: null,
        quantizedColors,
        extractionOnly: true,
      },
    };
  }

  // ── PASS 2: critique (judgment, fed validated extraction as fact) ──────────
  // Pass 2 is text-only — the model reasons from the validated extraction, not
  // by re-looking at pixels. This is the spec's core architecture choice.
  let critiqueRawText = await callModel(
    "critique",
    buildCritiquePrompt(effectiveName, extractionParsed),
    null, // no image — pure reasoning from facts
  );

  let critiqueParsed: Record<string, unknown>;
  try {
    critiqueParsed = JSON.parse(stripFences(critiqueRawText));
  } catch {
    throw new Error(`Pass 2 (critique) returned non-JSON:\n${critiqueRawText}`);
  }
  let critique = sanitizeTaggerPayload(critiqueParsed);

  // ── Banned-phrase gate: retry once with error feedback ─────────────────────
  const bannedErrors = validateNoBannedPhrases(critiqueParsed);
  if (bannedErrors.length > 0) {
    const feedback = `\n\nYour previous response was rejected — fix these and return the full JSON again:\n${bannedErrors.join("\n")}`;
    const retryText = await callModel(
      "critique",
      buildCritiquePrompt(effectiveName, extractionParsed),
      null,
      feedback,
    );
    try {
      critiqueParsed = JSON.parse(stripFences(retryText));
      critique = sanitizeTaggerPayload(critiqueParsed);
    } catch {
      // Retry failed to parse — keep the original (flagged) critique; the human will rewrite it.
    }
  }

  // ── Merge passes into TaggerOutput ─────────────────────────────────────────
  return {
    id:         autoId,
    title:      `${effectiveName} — (add descriptive subtitle)`,
    patternType: extraction.patternType,
    platform,
    categories: extraction.categories,
    styleTags:  extraction.styleTags,
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
      accessibilityRisks: [],
    },
    layout:          extraction.layout,
    voice:           critique.voice,
    qualityTier:     critique.qualityTier,
    qualityScore:    critique.qualityTier === "cautionary" ? 2 : 3,
    addedAt:         today,
    provenance:      { taggedBy: "auto" }, // two-pass tagger output; human review flips to auto-reviewed
    _raw: {
      extractionProvider: resolveProvider("extraction"),
      critiqueProvider: resolveProvider("critique"),
      extractionModel: activeModelName("extraction"),
      critiqueModel: activeModelName("critique"),
      extraction: extractionParsed,
      critique: critiqueParsed,
      quantizedColors,
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
): Promise<{
  critique: string;
  whatToSteal: string[];
  antiPatterns: { antiPatterns: string[]; whereThisFails: string[]; accessibilityRisks: string[] };
  voice?: { tone: string; examples: string[]; avoid: string[] };
  qualityTier: string;
  qualityScore: number;
  typographyNotes: string;
}> {
  if (!hasVisionKey()) throw new Error("No vision provider key set. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in .env.");
  const stripFences = (s: string) => s.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();

  let critiqueRawText = await callModel(
    "critique",
    buildCritiquePrompt(productName, extractionParsed),
    null,
  );
  let critiqueParsed: Record<string, unknown>;
  try { critiqueParsed = JSON.parse(stripFences(critiqueRawText)); }
  catch { throw new Error(`Pass 2 (critique) returned non-JSON:\n${critiqueRawText}`); }
  let critique = sanitizeTaggerPayload(critiqueParsed);

  const bannedErrors = validateNoBannedPhrases(critiqueParsed);
  if (bannedErrors.length > 0) {
    const feedback = `\n\nYour previous response was rejected — fix these and return the full JSON again:\n${bannedErrors.join("\n")}`;
    const retryText = await callModel("critique", buildCritiquePrompt(productName, extractionParsed), null, feedback);
    try { critiqueParsed = JSON.parse(stripFences(retryText)); critique = sanitizeTaggerPayload(critiqueParsed); } catch { /* keep flagged original */ }
  }

  return {
    critique: `[DRAFT — REWRITE] ${critique.draftCritique}`,
    whatToSteal: critique.draftWhatToSteal.map((t) => `[DRAFT] ${t}`),
    antiPatterns: {
      antiPatterns: critique.draftAntiPatterns.map((t) => `[DRAFT] ${t}`),
      whereThisFails: [],
      accessibilityRisks: [],
    },
    voice: critique.voice,
    qualityTier: critique.qualityTier,
    qualityScore: critique.qualityTier === "cautionary" ? 2 : 3,
    typographyNotes: critique.typographyNotes || "",
  };
}
