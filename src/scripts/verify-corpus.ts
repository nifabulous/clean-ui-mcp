#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { detectPlatform } from "../schema.js";
import { extractQuantizedColors } from "../tagger.js";
import { fromCorpusRelativeImagePath } from "../paths.js";

/** The verifier's own version — stamped on every record and the resume key. */
export const VERIFIER_VERSION = "verifier-v1";

export type VerifierTier = "mechanical" | "factual" | "a11y" | "prose" | "soft" | "gated";

export type VerificationRecord = {
  method: string;
  verifiedAt: string;
  verifierVersion: string;
  imageSha256?: string;
};

export type FieldVerdict = {
  field: string;
  verdict: "pass" | "fail" | "gate";
  reason: string;
};

/**
 * The spec's classification table as code. A key added to SERVABLE_FIELD_KEYS
 * later must be classified here too, or tierForField returns "gated" and the
 * key is silently unverifiable — the doctor's verification-orphan-key detector
 * already catches keys nothing reads; this catches servable keys nothing
 * verifies.
 */
const TIER_BY_FIELD: Readonly<Record<string, VerifierTier>> = {
  platform: "mechanical",
  "visual.dominantColors": "mechanical",
  "visual.colorRoles": "factual",
  "visual.accentColor": "factual",
  layout: "factual",
  components: "factual",
  "visual.usesShadows": "factual",
  "visual.usesBorders": "factual",
  "visual.typePairing": "factual",
  "antiPatterns.accessibilityRisks": "a11y",
  critique: "prose",
  whatToSteal: "prose",
  antiPatterns: "prose",
  voice: "prose",
  mood: "soft",
  colorScheme: "soft",
  "visual.spacingDensity": "soft",
  "visual.cornerStyle": "soft",
  styleTags: "soft",
  categories: "soft",
  domainTags: "soft",
  patternType: "soft",
  responsiveBehavior: "gated",
};

export function tierForField(field: string): VerifierTier {
  return TIER_BY_FIELD[field] ?? "gated";
}

export function imageSha256Of(imagePath: string): string {
  return createHash("sha256").update(readFileSync(imagePath)).digest("hex");
}

/** A fresh image-confirmed record bound to the exact bytes the verifier read. */
function confirmedRecord(imagePath: string, now: string): VerificationRecord {
  return {
    method: "image-confirmed",
    verifiedAt: now,
    verifierVersion: VERIFIER_VERSION,
    imageSha256: imageSha256Of(imagePath),
  };
}

/**
 * A fresh `provable` record — recomputable from recorded DATA, not pixels, so it
 * carries NO image hash (the schema reserves the hash for image-confirmed, whose
 * evidence is the bytes seen; `schema.ts:611-615`).
 */
function provableRecord(now: string): VerificationRecord {
  return { method: "provable", verifiedAt: now, verifierVersion: VERIFIER_VERSION };
}

/**
 * Re-derivable fields — no model — at DIFFERENT tiers because their evidence
 * differs. `platform` is recomputed from recorded dimensions → `provable`, no
 * hash. `visual.dominantColors` is read from pixels → `image-confirmed` bound to
 * the hash the doctor's staleness checks read (`doctor-helpers.ts:561-588`).
 */
export async function verifyMechanicalFields(
  entry: { platform?: string | null; image?: { width?: number | null; height?: number | null } | null; visual?: { dominantColors?: string[] | null } | null },
  imagePath: string,
  now = new Date().toISOString().slice(0, 10),
): Promise<{ records: Record<string, VerificationRecord>; verdicts: FieldVerdict[] }> {
  const records: Record<string, VerificationRecord> = {};
  const verdicts: FieldVerdict[] = [];

  const width = entry.image?.width ?? null;
  const height = entry.image?.height ?? null;
  const recordedPlatform = entry.platform ?? null;
  if (width === null || height === null || recordedPlatform === null) {
    verdicts.push({
      field: "platform",
      verdict: "fail",
      reason: width === null || height === null ? "image dimensions missing" : "no recorded platform",
    });
  } else {
    const recomputed = detectPlatform(width, height);
    if (recomputed === recordedPlatform) {
      records.platform = provableRecord(now);
      verdicts.push({ field: "platform", verdict: "pass", reason: `detectPlatform(${width}, ${height}) matches` });
    } else {
      verdicts.push({ field: "platform", verdict: "fail", reason: `detectPlatform gives ${recomputed}, recorded ${recordedPlatform}` });
    }
  }

  const recordedColors = entry.visual?.dominantColors ?? null;
  if (recordedColors === null || recordedColors.length === 0) {
    verdicts.push({ field: "visual.dominantColors", verdict: "fail", reason: "no recorded dominantColors" });
  } else {
    const extracted = await extractQuantizedColors(imagePath);
    const extractedSet = new Set(extracted);
    const missing = recordedColors.filter((c) => !extractedSet.has(c.toLowerCase()));
    if (missing.length === 0) {
      records["visual.dominantColors"] = confirmedRecord(imagePath, now);
      verdicts.push({ field: "visual.dominantColors", verdict: "pass", reason: "recorded colors all present in the extracted set" });
    } else {
      verdicts.push({ field: "visual.dominantColors", verdict: "fail", reason: `recorded colors absent from extraction: ${missing.join(", ")}` });
    }
  }

  return { records, verdicts };
}
