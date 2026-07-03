import "./env.js";

/**
 * tagger.ts
 * ──────────
 * Core vision-tagging logic: send a screenshot to OpenAI, get back
 * structured visual attributes. Importable by any script.
 *
 * Env: OPENAI_API_KEY
 * Optional: OPENAI_AUTO_TAG_MODEL (default: gpt-5.4-nano)
 */

import { readFileSync } from "node:fs";
import { extname } from "node:path";
import { toCorpusRelativePath } from "./paths.js";

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

// Primary pattern — ONE per entry (complements the multi-tag categories).
// Mirrors PatternType in schema.ts; keep in sync.
const PATTERN_TYPES = [
  "dashboard","landing-page","pricing","onboarding","auth","settings",
  "search","checkout","profile","marketing-hero",
  "data-table","empty-state","navigation","forms","mobile-nav",
  "notifications","editor-canvas","chat-interface","command-palette","modal",
] as const;

// Layout form + region roles — mirrors LayoutStructure in schema.ts.
const LAYOUT_FORMS = ["single-column", "two-column", "three-column", "modal-overlay"] as const;
const LAYOUT_REGION_ROLES = [
  "primary-nav","icon-nav","summary-strip","main-canvas",
  "detail-rail","form-panel","visual-panel","overlay-card",
] as const;

// Quality tier — mirrors schema.ts. Default "exceptional"; "cautionary" flags a
// genuinely bad example worth teaching from.
const QUALITY_TIERS = ["exceptional", "cautionary"] as const;

// ─── types ────────────────────────────────────────────────────────────────────

export interface TaggerInput {
  imagePath:   string;   // absolute path to the screenshot
  productName: string;
  url?:        string | null;
  id?:         string;   // optional slug override
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
  critique:        string;  // prefixed [DRAFT — REWRITE]
  whatToSteal:     string[]; // prefixed [DRAFT]
  antiPatterns: {
    antiPatterns:       string[]; // prefixed [DRAFT]
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
  // Internal: the raw vision response, preserved for debugging / re-processing
  _raw?: Record<string, unknown>;
}

// ─── prompts ──────────────────────────────────────────────────────────────────

const SYSTEM = `You are a senior UI/UX designer writing critiques for a curated design corpus.
The corpus's entire value is in SPECIFIC, ACCURATE design reasoning — not generic descriptions
any screenshot could earn. A bad critique says "uses a clean layout with good spacing." A good
critique says "uses 2-3 background shades of the same hue for depth instead of box-shadow, so
cards read as layered without visual noise." Name the DECISION, the TRADEOFF, and what the
design REJECTS (the conventional approach it deliberately doesn't use). Be a designer talking
to another designer about WHY this works, not WHAT it is. Return ONLY valid JSON.`;

const OPENAI_RESPONSES_API = "https://api.openai.com/v1/responses";
const OPENAI_AUTO_TAG_MODEL = process.env.OPENAI_AUTO_TAG_MODEL ?? "gpt-5.4-nano";

function buildPrompt(productName: string, url?: string | null): string {
  const source = url ? `${productName} (${url})` : `${productName} (uploaded screenshot; no source URL provided)`;
  return `Analyse this screenshot of ${source} and return a JSON object with exactly these fields:

{
  "patternType": "",      // ONE from: ${PATTERN_TYPES.join(", ")} — the single primary pattern this exemplifies
  "categories": [],       // 1-3 from: ${CATEGORIES.join(", ")}
  "styleTags": [],        // 1-3 from: ${STYLE_TAGS.join(", ")}
  "dominantColors": [],   // 3-6 hex codes of the most-used background/text/surface colors
  "accentColor": null,    // single hex of the primary interactive/brand color, or null
  "displayFont": null,    // name of the heading/display font if you can identify it, else null
  "bodyFont": null,       // name of the body/UI font if identifiable, else null
  "typographyNotes": "",  // 1-2 sentences on how typography creates hierarchy here
  "spacingDensity": "",   // one of: compact, moderate, spacious
  "cornerStyle": "",      // one of: sharp, slight-round, pill, mixed
  "usesShadows": false,   // true if box-shadow/drop-shadow is visible and doing structural work
  "usesBorders": false,   // true if borders/dividers are used for layout structure
  "colorRoles": null,     // {canvas, surface, ink, muted, accent} hex codes by ROLE — label what each color is FOR, not just list them. muted may be null. Omit entirely if you can't confidently map roles.
  "draftCritique": "",    // 3-5 sentences of REAL design criticism. For EACH notable decision: name the specific choice (e.g. "2-3 background shades for depth, not shadows"), say WHY it works (the effect it creates), and what conventional approach it rejects ("instead of card shadows that add visual noise"). Do NOT describe what the layout IS ("uses a left sidebar") — describe why the specific execution is better than the default. Bad: "clean layout with good spacing." Good: "Hairline borders at low contrast do structural work without the visual weight of 1px black lines; the eye reads grouping without noticing the borders."
  "draftWhatToSteal": [], // 3-5 SPECIFIC, copyable techniques. Each must be a concrete decision a developer could reproduce, with the REASONING attached. Bad: "use a left nav with selected state." Good: "Mark the selected nav row with a light-gray pill background (not a colored fill) — color is reserved for actions, neutral gray for state, so the eye doesn't confuse selection with a button." Name what's visible; attach the why.
  "draftAntiPatterns": [], // 1-3 common UI/UX MISTAKES this design deliberately avoids (e.g. "no drop shadows — depth via background-color steps instead"). This is the corpus's key differentiator — be specific about what's NOT here and why that matters.
  "layoutForm": "",       // ONE from: ${LAYOUT_FORMS.join(", ")} — the overall page form. Omit if the layout isn't structural (e.g. a single centered hero).
  "layoutRegions": [],    // ordered list of {role, width} describing the page regions left-to-right / top-to-bottom. role from: ${LAYOUT_REGION_ROLES.join(", ")}. width from: fixed-narrow, flex, fixed-wide. Only include if layoutForm is set.
  "voiceTone": "",        // 1 short phrase describing the writing voice (e.g. "restrained, confident, slightly dry"). Omit if no copy is visible or notable.
  "voiceExamples": [],    // 1-2 pieces of real copy visible on screen, verbatim — the words that define the voice. Omit if voiceTone is empty.
  "voiceAvoid": [],       // what voice this design deliberately does NOT use (e.g. "no exclamation-point enthusiasm"). Omit if voiceTone is empty.
  "qualityTier": ""       // ONE from: ${QUALITY_TIERS.join(", ")}. "exceptional" = a great example worth emulating. "cautionary" = a genuinely bad example worth teaching what NOT to do. Default exceptional.
}

Rules:
- Colors: pick the actual dominant hex values visible on screen, not brand colors from memory.
- colorRoles: map the hex values to semantic roles (what each is FOR). This is more useful than a bare list.
- Fonts: only name a font if you're confident; null beats a wrong guess.
- patternType is the single best description of what KIND of screen this is; categories can be broader.
- voiceTone/examples: only fill these if the COPY itself is notable. A pricing page may have no notable voice — leave empty.
- qualityTier: only mark "cautionary" if the screenshot shows clear, teachable problems. When in doubt, "exceptional".
- draftCritique/draftWhatToSteal/draftAntiPatterns are drafts — the human will rewrite them. Be specific anyway.
- Return ONLY the JSON object. No explanation, no markdown, no extra keys.`;
}

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
  // Only keep layout if both form and at least one valid region were produced.
  const layout = layoutForm && regions.length ? { form: layoutForm, regions } : undefined;

  // colorRoles: require all of canvas/surface/ink/accent to be valid hex; muted nullable.
  const rawColorRoles = parsed.colorRoles && typeof parsed.colorRoles === "object" ? parsed.colorRoles as Record<string, unknown> : {};
  const roleHex = (k: string) => {
    const v = rawColorRoles[k];
    return typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : null;
  };
  const crCanvas = roleHex("canvas"), crSurface = roleHex("surface"), crInk = roleHex("ink"), crAccent = roleHex("accent");
  const colorRoles = (crCanvas && crSurface && crInk && crAccent)
    ? { canvas: crCanvas, surface: crSurface, ink: crInk, muted: roleHex("muted"), accent: crAccent }
    : undefined;

  // voice: require a non-empty tone + at least one example.
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

// ─── core call ────────────────────────────────────────────────────────────────

export async function tagImage(input: TaggerInput): Promise<TaggerOutput> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");

  const ext      = extname(input.imagePath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
  const imageData = readFileSync(input.imagePath).toString("base64");
  const corpusPath = toCorpusRelativePath(input.imagePath);

  const response = await fetch(OPENAI_RESPONSES_API, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type":  "application/json",
    },
    body: JSON.stringify({
      model: OPENAI_AUTO_TAG_MODEL,
      // Headroom for a full critique + 2-4 specific steal items without
      // Headroom for deeper critique (3-5 sentences of reasoning) + steal + anti-patterns + layout + voice + colorRoles.
      // Bumped 3800 → 4200 when critique guidance was deepened to demand specific decision/tradeoff/rejected-alternative.
      max_output_tokens: 4200,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: SYSTEM }],
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: buildPrompt(input.productName, input.url) },
            {
              type: "input_image",
              image_url: `data:${mimeType};base64,${imageData}`,
              // "high" lets the model resolve in-card components, small text,
              // and fine spacing — the detail "what to steal" needs. "low"
              // downsamples so aggressively that only container shapes remain.
              detail: "high",
            },
          ],
        },
      ],
      text: {
        verbosity: "low",
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${body}`);
  }

  const apiResponse = await response.json() as {
    output_text?: string;
    output?: Array<{
      type?: string;
      content?: Array<{
        type?: string;
        text?: string;
      }>;
    }>;
  };

  const rawText = apiResponse.output_text
    ?? apiResponse.output
      ?.flatMap((item) => item.content ?? [])
      .filter((content) => content.type === "output_text" || content.type === "text")
      .map((content) => content.text ?? "")
      .join("")
    ?? "";

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    throw new Error(`OpenAI returned non-JSON:\n${rawText}`);
  }

  const sanitized = sanitizeTaggerPayload(parsed);

  const today  = new Date().toISOString().slice(0, 10);
  const autoId = input.id
    ?? `${input.productName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}-${today}`;

  return {
    id:         autoId,
    title:      `${input.productName} — (add descriptive subtitle)`,
    patternType: sanitized.patternType,
    categories: sanitized.categories,
    styleTags:  sanitized.styleTags,
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
      dominantColors: sanitized.dominantColors,
      accentColor:    sanitized.accentColor,
      colorRoles:     sanitized.colorRoles,
      typePairing: {
        display: sanitized.displayFont,
        body:    sanitized.bodyFont,
        notes:   sanitized.typographyNotes,
      },
      spacingDensity: sanitized.spacingDensity,
      cornerStyle:    sanitized.cornerStyle,
      usesShadows:    sanitized.usesShadows,
      usesBorders:    sanitized.usesBorders,
    },
    critique:        `[DRAFT — REWRITE] ${sanitized.draftCritique}`,
    whatToSteal:     sanitized.draftWhatToSteal.map((t) => `[DRAFT] ${t}`),
    antiPatterns: {
      antiPatterns:       sanitized.draftAntiPatterns.map((t) => `[DRAFT] ${t}`),
      whereThisFails:     [],
      accessibilityRisks: [],
    },
    layout:          sanitized.layout,
    voice:           sanitized.voice,
    qualityTier:     sanitized.qualityTier,
    qualityScore:    sanitized.qualityTier === "cautionary" ? 2 : 3,
    addedAt:         today,
    _raw:            {
      provider: "openai",
      model: OPENAI_AUTO_TAG_MODEL,
      parsed,
    },
  };
}
