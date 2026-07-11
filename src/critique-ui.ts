/**
 * critique-ui.ts — input validation and image bridge for the `critique_ui` MCP tool.
 *
 * The tool accepts a bounded base64 image (no filesystem paths or URLs), validates
 * MIME type + size, writes the bytes to a short-lived temp file for the existing
 * path-based two-pass tagger, and removes the file after extraction.
 *
 * The temp-file bridge exists because the tagger pipeline (extractQuantizedColors,
 * readImageDimensions, readImageForDetail) is file-path-based throughout — it reads
 * via Vibrant.from(path), sharp(path), and readFileSync(path). Refactoring those to
 * accept buffers is a larger change with regression risk; a temp file is the clean
 * integration seam.
 */
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { TaggerInput, TaggerOutput } from "./tagger.js";

/** Maximum decoded image payload: 10 MiB. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const SUPPORTED_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const SUPPORTED_PLATFORMS = ["web", "mobile", "tablet"] as const;

export type SupportedMimeType = (typeof SUPPORTED_MIME_TYPES)[number];

export interface CritiqueUiInput {
  image: {
    data: string; // base64-encoded image bytes
    mimeType: SupportedMimeType;
  };
  productContext?: string;
  platform?: (typeof SUPPORTED_PLATFORMS)[number];
  /** Internal capture-pipeline injection; screenshot-only MCP calls omit this. */
  domSignals?: TaggerInput["domSignals"];
}

export interface CritiqueEvidence {
  id: string;
  source: "screen" | "corpus" | "dom";
  label: string;
  detail?: string;
}

export interface CritiqueRecommendation {
  observation: string;
  impact: string;
  recommendation: string;
  evidence: string[]; // evidence IDs
}

export type ValidationResult =
  | { valid: true; input: CritiqueUiInput }
  | { valid: false; error: string };

function isStringOrNull(value: unknown): boolean {
  return value === null || (typeof value === "string" && value.length <= 500);
}

/** Bound the opt-in DOM handoff before it can reach prompts or evidence. */
function isValidDomSignals(value: unknown): value is NonNullable<TaggerInput["domSignals"]> {
  if (!value || typeof value !== "object") return false;
  const dom = value as Record<string, unknown>;
  const styles = dom.styles as Record<string, unknown> | undefined;
  const accessibility = dom.accessibility as Record<string, unknown> | undefined;
  const structure = dom.structure as Record<string, unknown> | undefined;
  if (!styles || !accessibility || !structure) return false;
  if (!["fontFamily", "fontSize", "fontWeight", "borderRadius", "boxShadow", "color", "background", "letterSpacing"].every((key) => isStringOrNull(styles[key]))) return false;
  if (!(accessibility.contrastRatio === null || (typeof accessibility.contrastRatio === "number" && accessibility.contrastRatio >= 0 && accessibility.contrastRatio <= 100))
    || !Array.isArray(accessibility.headingLevels) || accessibility.headingLevels.length > 64 || !accessibility.headingLevels.every((level) => Number.isInteger(level) && level >= 1 && level <= 6)
    || !["imagesMissingAlt", "unlabeledInteractive"].every((key) => typeof accessibility[key] === "number" && (accessibility[key] as number) >= 0 && (accessibility[key] as number) <= 100_000)
    || typeof accessibility.hasSkipLink !== "boolean") return false;
  if (!["display", "flexDirection", "gridTemplateColumns", "gap"].every((key) => isStringOrNull(structure[key]))) return false;
  if (dom.motion === undefined || dom.motion === null) return true;
  if (typeof dom.motion !== "object") return false;
  const motion = dom.motion as Record<string, unknown>;
  if (!Array.isArray(motion.signals) || motion.signals.length > 100
    || !["full", "partial", "none"].includes(String(motion.coverage))
    || typeof motion.inaccessibleStylesheets !== "number" || !Number.isInteger(motion.inaccessibleStylesheets) || motion.inaccessibleStylesheets < 0 || motion.inaccessibleStylesheets > 10_000
    || typeof motion.prefersReducedMotion !== "boolean") return false;
  return motion.signals.every((signal) => {
    if (!signal || typeof signal !== "object") return false;
    const item = signal as Record<string, unknown>;
    return typeof item.selector === "string" && item.selector.length <= 200
      && typeof item.property === "string" && item.property.length <= 120
      && typeof item.durationMs === "number" && Number.isInteger(item.durationMs) && item.durationMs >= 0 && item.durationMs <= 60_000
      && typeof item.delayMs === "number" && Number.isInteger(item.delayMs) && item.delayMs >= 0 && item.delayMs <= 60_000
      && (item.iterationCount === undefined || (typeof item.iterationCount === "string" && item.iterationCount.length <= 32))
      && (item.timingFunction === undefined || (typeof item.timingFunction === "string" && item.timingFunction.length <= 64));
  });
}

/**
 * Project only the tagger's sanitized, platform-normalized fields into the
 * evidence shape used by critique retrieval and synthesis. `_raw` is
 * intentionally excluded: it contains the untrusted model response.
 */
export function toNormalizedTaggerFacts(tagged: Pick<TaggerOutput,
  "patternType" | "platform" | "categories" | "styleTags" | "components" |
  "domainTags" | "layout" | "visual">, domSignals?: TaggerInput["domSignals"]): Record<string, unknown> {
  return {
    patternType: tagged.patternType,
    platform: tagged.platform,
    categories: tagged.categories,
    styleTags: tagged.styleTags,
    components: tagged.components,
    domainTags: tagged.domainTags,
    layoutForm: tagged.layout?.form,
    layout: tagged.layout,
    // I1 fix: project the visual fields needed by buildSynthesisContext for
    // screen:visual:colors / accentColor / colorRoles / typePairing evidence.
    dominantColors: tagged.visual.dominantColors,
    accentColor: tagged.visual.accentColor,
    colorRoles: tagged.visual.colorRoles,
    typePairing: tagged.visual.typePairing,
    spacingDensity: tagged.visual.spacingDensity,
    cornerStyle: tagged.visual.cornerStyle,
    usesShadows: tagged.visual.usesShadows,
    usesBorders: tagged.visual.usesBorders,
    // DOM signals are passed explicitly from a trusted capture caller, never
    // inferred from the screenshot or model output.
    ...(domSignals ? { domSignals } : {}),
  };
}

/**
 * Validate a critique_ui input payload. Checks MIME type, base64 decodability,
 * decoded size, and optional field formats. Does NOT decode or persist the image.
 */
export function validateCritiqueUiInput(raw: unknown): ValidationResult {
  if (!raw || typeof raw !== "object") {
    return { valid: false, error: "Input must be an object with an 'image' field." };
  }
  const obj = raw as Record<string, unknown>;

  // ── image ──────────────────────────────────────────────────────────────────
  if (!obj.image || typeof obj.image !== "object") {
    return { valid: false, error: "Missing required 'image' field." };
  }
  const img = obj.image as Record<string, unknown>;

  if (!img.mimeType || typeof img.mimeType !== "string") {
    return { valid: false, error: "image.mimeType is required." };
  }
  if (!SUPPORTED_MIME_TYPES.includes(img.mimeType as SupportedMimeType)) {
    return { valid: false, error: `Unsupported MIME type "${img.mimeType}". Supported: ${SUPPORTED_MIME_TYPES.join(", ")}.` };
  }

  if (!img.data || typeof img.data !== "string") {
    return { valid: false, error: "image.data (base64 string) is required." };
  }

  // Validate base64 decodability + decoded size.
  let decoded: Buffer;
  try {
    decoded = Buffer.from(img.data, "base64");
  } catch {
    return { valid: false, error: "image.data is not valid base64." };
  }
  // Buffer.from doesn't throw on invalid base64 — it silently strips. Check
  // round-trip to catch corruption.
  if (decoded.length === 0 && img.data.length > 0) {
    return { valid: false, error: "image.data decoded to zero bytes — likely malformed base64." };
  }
  // Re-encode check: the base64 should round-trip (ignoring padding whitespace).
  const reEncoded = decoded.toString("base64").replace(/=+$/, "");
  const originalStripped = (img.data as string).replace(/=+$/, "").replace(/\s/g, "");
  if (reEncoded !== originalStripped) {
    return { valid: false, error: "image.data failed base64 round-trip validation — likely malformed." };
  }

  if (decoded.length > MAX_IMAGE_BYTES) {
    return { valid: false, error: `Decoded image is ${(decoded.length / 1024 / 1024).toFixed(1)} MiB — maximum is 10 MiB.` };
  }

  // ── optional fields ─────────────────────────────────────────────────────────
  if (obj.platform !== undefined) {
    if (typeof obj.platform !== "string" || !SUPPORTED_PLATFORMS.includes(obj.platform as (typeof SUPPORTED_PLATFORMS)[number])) {
      return { valid: false, error: `Invalid platform "${obj.platform}". Supported: ${SUPPORTED_PLATFORMS.join(", ")}.` };
    }
  }

  if (obj.productContext !== undefined && typeof obj.productContext !== "string") {
    return { valid: false, error: "productContext must be a string if provided." };
  }

  if (obj.domSignals !== undefined && !isValidDomSignals(obj.domSignals)) {
    return { valid: false, error: "domSignals must be a bounded trusted capture object if provided." };
  }

  return {
    valid: true,
    input: {
      image: { data: img.data as string, mimeType: img.mimeType as SupportedMimeType },
      productContext: obj.productContext as string | undefined,
      platform: obj.platform as CritiqueUiInput["platform"],
      // The public screenshot-only MCP schema does not expose this field. It is
      // retained solely for internal capture callers that already possess DOM
      // ground truth, so we never fabricate it from image analysis.
      domSignals: obj.domSignals as TaggerInput["domSignals"] | undefined,
    },
  };
}

/** Map MIME type to file extension for the temp file. */
function mimeToExt(mimeType: SupportedMimeType): string {
  switch (mimeType) {
    case "image/png": return "png";
    case "image/jpeg": return "jpg";
    case "image/webp": return "webp";
  }
}

/**
 * Write validated image bytes to a uniquely named temp file, invoke the callback
 * with the file path, and remove the file in a `finally` block — even on failure.
 *
 * The temp file exists only for the duration of the callback. Never accepts a
 * caller-supplied path.
 */
export async function withValidatedImageFile<T>(
  input: CritiqueUiInput,
  callback: (imagePath: string) => Promise<T>,
): Promise<T> {
  const ext = mimeToExt(input.image.mimeType);
  const tempPath = join(tmpdir(), `critique-ui-${randomBytes(8).toString("hex")}.${ext}`);
  const decoded = Buffer.from(input.image.data, "base64");

  writeFileSync(tempPath, decoded);
  try {
    return await callback(tempPath);
  } finally {
    if (existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    }
  }
}
