import { createHash } from "node:crypto";
import { z } from "zod";
import {
  COLOR_SCHEME_DETECTOR_VERSION,
  COLOR_SCHEME_MARGIN,
  COLOR_SCHEME_MAX_DIMENSION,
  COLOR_SCHEME_THRESHOLD,
  type ColorScheme,
  type ColorSchemeDetection,
} from "./color-scheme.js";

export const COLOR_SCHEME_AUDIT_SCHEMA_VERSION = "1.0" as const;
export const COLOR_SCHEME_AUDIT_ARTIFACT_TYPE = "deterministic-color-scheme-audit" as const;
export const COLOR_SCHEME_AUDIT_ARTIFACT_ID = "deterministic-color-scheme-audit-v1" as const;

export type ColorSchemeAuditStatus = "propose" | "unchanged" | "conflict" | "abstain" | "missing-image" | "error";

const HashSchema = z.string().regex(/^[a-f0-9]{64}$/, "expected a lowercase SHA-256 hash");
const ColorSchemeSchema = z.enum(["light", "dark"]);
const ColorSchemeAuditStatusSchema = z.enum(["propose", "unchanged", "conflict", "abstain", "missing-image", "error"]);

export type ColorSchemeAuditInput = {
  entryId: string;
  imagePath: string | null;
  imageSha256: string | null;
  existingColorScheme: string | null;
  loadImage?: () => Uint8Array;
};

export type ColorSchemeAuditEntry = {
  entryId: string;
  imagePath: string | null;
  imageSha256: string | null;
  existingColorScheme: string | null;
  detectedColorScheme: ColorScheme | null;
  medianLuma: number | null;
  threshold: number;
  margin: number;
  status: ColorSchemeAuditStatus;
  error?: string;
};

export type ColorSchemeAuditReport = {
  schemaVersion: typeof COLOR_SCHEME_AUDIT_SCHEMA_VERSION;
  artifactType: typeof COLOR_SCHEME_AUDIT_ARTIFACT_TYPE;
  artifactId: typeof COLOR_SCHEME_AUDIT_ARTIFACT_ID;
  generatedAt: string | null;
  corpusSha256: string;
  detector: {
    source: "src/color-scheme.ts";
    algorithmVersion: typeof COLOR_SCHEME_DETECTOR_VERSION;
    maxDimension: number;
    threshold: number;
    margin: number;
  };
  summary: { entries: number; proposed: number; unchanged: number; conflicts: number; abstained: number; missingImages: number; errors: number };
  entries: ColorSchemeAuditEntry[];
};

const ColorSchemeAuditEntrySchema = z.object({
  entryId: z.string().trim().min(1),
  imagePath: z.string().trim().min(1).nullable(),
  imageSha256: HashSchema.nullable(),
  existingColorScheme: z.string().trim().min(1).nullable(),
  detectedColorScheme: ColorSchemeSchema.nullable(),
  medianLuma: z.number().finite().nullable(),
  threshold: z.number().finite(),
  margin: z.number().finite().nonnegative(),
  status: ColorSchemeAuditStatusSchema,
  error: z.string().trim().min(1).optional(),
}).strict();

const ColorSchemeAuditReportBaseSchema = z.object({
  schemaVersion: z.literal(COLOR_SCHEME_AUDIT_SCHEMA_VERSION),
  artifactType: z.literal(COLOR_SCHEME_AUDIT_ARTIFACT_TYPE),
  artifactId: z.literal(COLOR_SCHEME_AUDIT_ARTIFACT_ID),
  generatedAt: z.string().datetime({ offset: true }).nullable(),
  corpusSha256: HashSchema,
  detector: z.object({
    source: z.literal("src/color-scheme.ts"),
    algorithmVersion: z.literal(COLOR_SCHEME_DETECTOR_VERSION),
    maxDimension: z.number().int().positive(),
    threshold: z.number().finite(),
    margin: z.number().finite().nonnegative(),
  }).strict(),
  summary: z.object({
    entries: z.number().int().nonnegative(),
    proposed: z.number().int().nonnegative(),
    unchanged: z.number().int().nonnegative(),
    conflicts: z.number().int().nonnegative(),
    abstained: z.number().int().nonnegative(),
    missingImages: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  }).strict(),
  entries: z.array(ColorSchemeAuditEntrySchema),
}).strict();

export const ColorSchemeAuditReportSchema = ColorSchemeAuditReportBaseSchema.superRefine((report, ctx) => {
  const ids = report.entries.map((entry) => entry.entryId);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: "custom", path: ["entries"], message: "audit entry IDs must be unique" });
  for (const [index, entry] of report.entries.entries()) {
    if (entry.imagePath && entry.status !== "missing-image" && !entry.imageSha256) {
      ctx.addIssue({ code: "custom", path: ["entries", index, "imageSha256"], message: "audited image rows require an image SHA-256" });
    }
  }
  const count = (status: ColorSchemeAuditStatus) => report.entries.filter((entry) => entry.status === status).length;
  const expected = {
    entries: report.entries.length,
    proposed: count("propose"),
    unchanged: count("unchanged"),
    conflicts: count("conflict"),
    abstained: count("abstain"),
    missingImages: count("missing-image"),
    errors: count("error"),
  };
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (report.summary[key] !== expected[key]) ctx.addIssue({ code: "custom", path: ["summary", key], message: `summary.${key} does not match entries` });
  }
});

export function validateColorSchemeAuditReport(value: unknown): ColorSchemeAuditReport {
  return ColorSchemeAuditReportSchema.parse(value);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isMissingFile(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ENOENT";
}

export async function buildColorSchemeAuditReport(options: {
  corpusSha256: string;
  entries: readonly ColorSchemeAuditInput[];
  detect: (imagePath: string, imageBytes?: Uint8Array) => Promise<ColorSchemeDetection>;
  generatedAt?: string | null;
  concurrency?: number;
}): Promise<ColorSchemeAuditReport> {
  const audited = new Array<ColorSchemeAuditEntry>(options.entries.length);
  let nextIndex = 0;
  const auditOne = async (input: ColorSchemeAuditInput): Promise<ColorSchemeAuditEntry> => {
    const base = {
      entryId: input.entryId,
      imagePath: input.imagePath,
      imageSha256: input.imageSha256,
      existingColorScheme: input.existingColorScheme,
      detectedColorScheme: null as ColorScheme | null,
      medianLuma: null as number | null,
      threshold: COLOR_SCHEME_THRESHOLD,
      margin: COLOR_SCHEME_MARGIN,
    };
    if (!input.imagePath) return { ...base, status: "missing-image" };
    let imageSha256 = input.imageSha256;
    try {
      const imageBytes = input.loadImage?.();
      imageSha256 = imageBytes ? sha256(imageBytes) : input.imageSha256;
      if (imageBytes && input.imageSha256 && input.imageSha256 !== imageSha256) {
        return { ...base, imageSha256, status: "error", error: "image changed while building the audit input" };
      }
      const detection = await options.detect(input.imagePath, imageBytes);
      const detectedColorScheme = detection.colorScheme;
      const status: ColorSchemeAuditStatus = detectedColorScheme === null
        ? "abstain"
        : input.existingColorScheme === null
          ? "propose"
          : input.existingColorScheme === detectedColorScheme
            ? "unchanged"
            : "conflict";
      return { ...base, imageSha256, detectedColorScheme, medianLuma: detection.medianLuma, threshold: detection.threshold, margin: detection.margin, status };
    } catch (error) {
      if (isMissingFile(error)) return { ...base, status: "missing-image" };
      return { ...base, imageSha256, status: "error", error: error instanceof Error ? error.message : String(error) };
    }
  };
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= options.entries.length) return;
      audited[index] = await auditOne(options.entries[index]!);
    }
  };
  const concurrency = Math.max(1, Math.min(options.concurrency ?? 4, options.entries.length || 1));
  await Promise.all(Array.from({ length: concurrency }, worker));
  const completed = audited.filter((entry): entry is ColorSchemeAuditEntry => entry !== undefined);
  const count = (status: ColorSchemeAuditStatus) => completed.filter((entry) => entry.status === status).length;
  return validateColorSchemeAuditReport({
    schemaVersion: COLOR_SCHEME_AUDIT_SCHEMA_VERSION,
    artifactType: COLOR_SCHEME_AUDIT_ARTIFACT_TYPE,
    artifactId: COLOR_SCHEME_AUDIT_ARTIFACT_ID,
    generatedAt: options.generatedAt ?? null,
    corpusSha256: options.corpusSha256,
    detector: {
      source: "src/color-scheme.ts",
      algorithmVersion: COLOR_SCHEME_DETECTOR_VERSION,
      maxDimension: COLOR_SCHEME_MAX_DIMENSION,
      threshold: COLOR_SCHEME_THRESHOLD,
      margin: COLOR_SCHEME_MARGIN,
    },
    summary: {
      entries: completed.length,
      proposed: count("propose"),
      unchanged: count("unchanged"),
      conflicts: count("conflict"),
      abstained: count("abstain"),
      missingImages: count("missing-image"),
      errors: count("error"),
    },
    entries: completed,
  });
}
