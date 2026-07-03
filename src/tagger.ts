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
 * Env: OPENAI_API_KEY
 * Optional: OPENAI_AUTO_TAG_MODEL (default: gpt-5.4-nano)
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { toCorpusRelativePath } from "./paths.js";
import { Vibrant } from "node-vibrant/node";

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
}

export interface TaggerOutput {
  id:             string;
  title:          string;
  patternType:    string;
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
    width:      null;
    height:     null;
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
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta/models";

const OPENAI_AUTO_TAG_MODEL = process.env.OPENAI_AUTO_TAG_MODEL ?? "gpt-5.4-nano";
const CLAUDE_AUTO_TAG_MODEL = process.env.CLAUDE_AUTO_TAG_MODEL ?? "claude-haiku-4-5";
const GEMINI_AUTO_TAG_MODEL = process.env.GEMINI_AUTO_TAG_MODEL ?? "gemini-2.5-flash";

const MAX_OUTPUT_TOKENS = 4200;

/** Resolve which provider to use, with auto-fallback if the preferred key is missing. */
function resolveProvider(): "openai" | "claude" | "gemini" {
  const preferred = (process.env.AUTO_TAG_PROVIDER ?? "openai").toLowerCase() as "openai" | "claude" | "gemini";
  const has = { openai: !!process.env.OPENAI_API_KEY, claude: !!process.env.ANTHROPIC_API_KEY, gemini: !!process.env.GEMINI_API_KEY };
  if (has[preferred]) return preferred;
  // Auto-fallback to whichever key is present.
  for (const p of ["openai", "claude", "gemini"] as const) {
    if (has[p]) {
      console.error(`[tagger] AUTO_TAG_PROVIDER="${preferred}" but no key set — falling back to ${p}.`);
      return p;
    }
  }
  return preferred; // no keys at all — the builder will throw with a clear message
}

/** Check if ANY vision provider key is configured. */
export function hasVisionKey(): boolean {
  return !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY);
}

/** Human-readable provider name for UI display. */
export function activeProviderName(): string {
  const p = resolveProvider();
  return { openai: "OpenAI", claude: "Claude", gemini: "Gemini" }[p];
}

/** Active model name for UI display. */
export function activeModelName(): string {
  const p = resolveProvider();
  return { openai: OPENAI_AUTO_TAG_MODEL, claude: CLAUDE_AUTO_TAG_MODEL, gemini: GEMINI_AUTO_TAG_MODEL }[p];
}

// ─── PASS 1: extraction prompt (facts + geometry) ────────────────────────────

function buildExtractionPrompt(
  productName: string,
  url: string | null | undefined,
  quantizedColors: string[],
): string {
  const source = url ? `${productName} (${url})` : `${productName} (uploaded screenshot; no source URL provided)`;
  return `Analyse this screenshot of ${source} and return a JSON object with exactly these fields.
This is an EXTRACTION pass — factual/structural fields only, no critique yet.

VERIFIED GROUND TRUTH — treat every value below as fact, do not re-derive or contradict it:
${JSON.stringify({ quantizedColors }, null, 2)}

{
  "patternType": "",       // ONE from: ${PATTERN_TYPES.join(", ")}
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

async function callOpenAI(
  prompt: string,
  imagePath: string | null,
  retryFeedback?: string,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const userContent: Array<Record<string, unknown>> = [{ type: "input_text", text: prompt }];
  if (imagePath) {
    const ext = extname(imagePath).toLowerCase();
    const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const imageData = readFileSync(imagePath).toString("base64");
    userContent.push({ type: "input_image", image_url: `data:${mimeType};base64,${imageData}`, detail: "high" });
  }

  const response = await fetch(OPENAI_RESPONSES_API, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_AUTO_TAG_MODEL,
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

async function callClaude(
  prompt: string,
  imagePath: string | null,
  retryFeedback?: string,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");

  // Claude content blocks: image uses raw base64 (no data-URI prefix).
  const content: Array<Record<string, unknown>> = [];
  if (imagePath) {
    const ext = extname(imagePath).toLowerCase();
    const mediaType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const imageData = readFileSync(imagePath).toString("base64");
    content.push({ type: "image", source: { type: "base64", media_type: mediaType, data: imageData } });
  }
  content.push({ type: "text", text: prompt });
  if (retryFeedback) content.push({ type: "text", text: retryFeedback });

  const response = await fetch(ANTHROPIC_API, {
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
): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set");

  // Gemini parts: inlineData uses raw base64 (no prefix), camelCase.
  const parts: Array<Record<string, unknown>> = [];
  if (imagePath) {
    const ext = extname(imagePath).toLowerCase();
    const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
    const imageData = readFileSync(imagePath).toString("base64");
    parts.push({ inlineData: { mimeType, data: imageData } });
  }
  parts.push({ text: prompt });
  if (retryFeedback) parts.push({ text: retryFeedback });

  const endpoint = `${GEMINI_API_BASE}/${GEMINI_AUTO_TAG_MODEL}:generateContent`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
    body: JSON.stringify({
      systemInstruction: SYSTEM,
      contents: [{ role: "user", parts }],
      generationConfig: { maxOutputTokens: MAX_OUTPUT_TOKENS },
    }),
  });

  if (!response.ok) throw new Error(`Gemini API error ${response.status}: ${await response.text()}`);

  const data = await response.json() as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const parts_out = data.candidates?.[0]?.content?.parts ?? [];
  return parts_out.filter((p) => typeof p.text === "string").map((p) => p.text ?? "").join("");
}

/** Route to the active provider. Auto-falls back if the preferred key is missing. */
async function callModel(
  prompt: string,
  imagePath: string | null,
  retryFeedback?: string,
): Promise<string> {
  const provider = resolveProvider();
  const fullPrompt = prompt; // prompt already contains the per-pass instructions
  switch (provider) {
    case "claude":  return callClaude(fullPrompt, imagePath, retryFeedback);
    case "gemini":  return callGemini(fullPrompt, imagePath, retryFeedback);
    default:        return callOpenAI(fullPrompt, imagePath, retryFeedback);
  }
}

// ─── core two-pass orchestration ─────────────────────────────────────────────

export async function tagImage(input: TaggerInput): Promise<TaggerOutput> {
  if (!hasVisionKey()) throw new Error("No vision provider key set. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or GEMINI_API_KEY in .env.");

  const corpusPath = toCorpusRelativePath(input.imagePath);
  const today = new Date().toISOString().slice(0, 10);
  const autoId = input.id
    ?? `${input.productName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${today}`;

  // ── Deterministic color extraction (code-level, not model-guessed) ─────────
  let quantizedColors: string[] = [];
  try {
    quantizedColors = await extractQuantizedColors(input.imagePath);
  } catch (err) {
    console.error("[tagger] Color extraction failed, falling back to model-guessed colors:", err instanceof Error ? err.message : err);
  }

  // ── PASS 1: extraction (facts + geometry, with ground-truth colors) ────────
  const extractionRawText = await callModel(
    buildExtractionPrompt(input.productName, input.url, quantizedColors),
    input.imagePath,
  );

  let extractionParsed: Record<string, unknown>;
  try {
    extractionParsed = JSON.parse(extractionRawText.trim());
  } catch {
    throw new Error(`Pass 1 (extraction) returned non-JSON:\n${extractionRawText}`);
  }
  const extraction = sanitizeTaggerPayload(extractionParsed);
  // Override dominantColors with the ground-truth quantized set when available,
  // so even if the model ignored instructions, we get deterministic colors.
  if (quantizedColors.length) {
    extraction.dominantColors = quantizedColors;
  }

  // ── PASS 2: critique (judgment, fed validated extraction as fact) ──────────
  // Pass 2 is text-only — the model reasons from the validated extraction, not
  // by re-looking at pixels. This is the spec's core architecture choice.
  let critiqueRawText = await callModel(
    buildCritiquePrompt(input.productName, extractionParsed),
    null, // no image — pure reasoning from facts
  );

  let critiqueParsed: Record<string, unknown>;
  try {
    critiqueParsed = JSON.parse(critiqueRawText.trim());
  } catch {
    throw new Error(`Pass 2 (critique) returned non-JSON:\n${critiqueRawText}`);
  }
  let critique = sanitizeTaggerPayload(critiqueParsed);

  // ── Banned-phrase gate: retry once with error feedback ─────────────────────
  const bannedErrors = validateNoBannedPhrases(critiqueParsed);
  if (bannedErrors.length > 0) {
    const feedback = `\n\nYour previous response was rejected — fix these and return the full JSON again:\n${bannedErrors.join("\n")}`;
    const retryText = await callModel(
      buildCritiquePrompt(input.productName, extractionParsed),
      null,
      feedback,
    );
    try {
      critiqueParsed = JSON.parse(retryText.trim());
      critique = sanitizeTaggerPayload(critiqueParsed);
    } catch {
      // Retry failed to parse — keep the original (flagged) critique; the human will rewrite it.
    }
  }

  // ── Merge passes into TaggerOutput ─────────────────────────────────────────
  return {
    id:         autoId,
    title:      `${input.productName} — (add descriptive subtitle)`,
    patternType: extraction.patternType,
    categories: extraction.categories,
    styleTags:  extraction.styleTags,
    source: {
      productName: input.productName,
      url:         input.url ?? null,
      capturedAt:  today,
      capturedBy:  "self",
    },
    image: {
      visibility: "private",
      path:       corpusPath,
      width:      null,
      height:     null,
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
    _raw: {
      provider: resolveProvider(),
      model: activeModelName(),
      extraction: extractionParsed,
      critique: critiqueParsed,
      quantizedColors,
    },
  };
}
