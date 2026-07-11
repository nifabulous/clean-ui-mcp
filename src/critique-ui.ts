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
  framework?: string;
}

export interface CritiqueEvidence {
  id: string;
  source: "screen" | "corpus";
  label: string;
  detail?: string;
}

export interface CritiqueRecommendation {
  observation: string;
  impact: string;
  recommendation: string;
  evidence: string[]; // evidence IDs
  uncertain?: boolean;
}

export interface CritiqueUiResult {
  summary: string;
  observations: string[];
  recommendations: CritiqueRecommendation[];
  accessibilityRisks: Array<{ element: string; risk: string; evidence: string; wcag: string[] }>;
  evidence: CritiqueEvidence[];
  confidence: "high" | "medium" | "low";
  fallbackUsed: boolean;
  provider: {
    embedding?: string;
    synthesis?: string;
  };
}

export type ValidationResult =
  | { valid: true; input: CritiqueUiInput }
  | { valid: false; error: string };

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

  if (obj.framework !== undefined && typeof obj.framework !== "string") {
    return { valid: false, error: "framework must be a string if provided." };
  }

  return {
    valid: true,
    input: {
      image: { data: img.data as string, mimeType: img.mimeType as SupportedMimeType },
      productContext: obj.productContext as string | undefined,
      platform: obj.platform as CritiqueUiInput["platform"],
      framework: obj.framework as string | undefined,
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
