import { COLOR_SCHEME_MARGIN, COLOR_SCHEME_THRESHOLD, type ColorScheme, type ColorSchemeDetection } from "./color-scheme.js";

export type ColorSchemeAuditStatus = "propose" | "unchanged" | "conflict" | "abstain" | "missing-image" | "error";

export type ColorSchemeAuditInput = {
  entryId: string;
  imagePath: string | null;
  imageSha256: string | null;
  existingColorScheme: string | null;
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
  schemaVersion: "1.0";
  artifactType: "deterministic-color-scheme-audit";
  artifactId: "deterministic-color-scheme-audit-v1";
  generatedAt: string | null;
  corpusSha256: string;
  detector: { source: "src/color-scheme.ts"; threshold: number; margin: number };
  summary: { entries: number; proposed: number; unchanged: number; conflicts: number; abstained: number; missingImages: number; errors: number };
  entries: ColorSchemeAuditEntry[];
};

export async function buildColorSchemeAuditReport(options: {
  corpusSha256: string;
  entries: readonly ColorSchemeAuditInput[];
  detect: (imagePath: string) => Promise<ColorSchemeDetection>;
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
    if (!input.imagePath) {
      return { ...base, status: "missing-image" };
    }
    try {
      const detection = await options.detect(input.imagePath);
      const detectedColorScheme = detection.colorScheme;
      const status: ColorSchemeAuditStatus = detectedColorScheme === null
        ? "abstain"
        : input.existingColorScheme === null
          ? "propose"
          : input.existingColorScheme === detectedColorScheme
            ? "unchanged"
            : "conflict";
      return { ...base, detectedColorScheme, medianLuma: detection.medianLuma, threshold: detection.threshold, margin: detection.margin, status };
    } catch (error) {
      return { ...base, status: "error", error: error instanceof Error ? error.message : String(error) };
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
  return {
    schemaVersion: "1.0",
    artifactType: "deterministic-color-scheme-audit",
    artifactId: "deterministic-color-scheme-audit-v1",
    generatedAt: options.generatedAt ?? null,
    corpusSha256: options.corpusSha256,
    detector: { source: "src/color-scheme.ts", threshold: COLOR_SCHEME_THRESHOLD, margin: COLOR_SCHEME_MARGIN },
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
  };
}
