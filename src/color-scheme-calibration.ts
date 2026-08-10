import { createHash } from "node:crypto";
import { z } from "zod";
import {
  COLOR_SCHEME_DETECTOR_VERSION,
  COLOR_SCHEME_MARGIN,
  COLOR_SCHEME_MAX_DIMENSION,
  COLOR_SCHEME_THRESHOLD,
  type ColorScheme,
} from "./color-scheme.js";
import {
  ColorSchemeAuditReportSchema,
  type ColorSchemeAuditEntry,
  type ColorSchemeAuditReport,
} from "./color-scheme-audit.js";

export const COLOR_SCHEME_CALIBRATION_SCHEMA_VERSION = "1.0" as const;
export const COLOR_SCHEME_CALIBRATION_PACKET_TYPE = "color-scheme-calibration-packet" as const;
export const COLOR_SCHEME_CALIBRATION_SUBMISSION_TYPE = "color-scheme-calibration-submission" as const;
export const COLOR_SCHEME_CALIBRATION_REPORT_TYPE = "color-scheme-calibration-report" as const;

export type ColorSchemeCalibrationValue = ColorScheme | "abstain";
export type ColorSchemeCalibrationStratum = "threshold-near" | "existing-value" | "luma-tail";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/, "expected a lowercase SHA-256 hash");
const ColorSchemeSchema = z.enum(["light", "dark"]);
const CalibrationValueSchema = z.enum(["light", "dark", "abstain"]);
const StratumSchema = z.enum(["threshold-near", "existing-value", "luma-tail"]);

const PacketEntrySchema = z.object({
  entryId: z.string().trim().min(1),
  imagePath: z.string().trim().min(1),
  imageSha256: Sha256Schema,
  existingColorScheme: z.string().trim().min(1).nullable(),
  detectedColorScheme: ColorSchemeSchema,
  medianLuma: z.number().finite(),
  stratum: StratumSchema,
}).strict();

export const ColorSchemeCalibrationPacketSchema = z.object({
  schemaVersion: z.literal(COLOR_SCHEME_CALIBRATION_SCHEMA_VERSION),
  artifactType: z.literal(COLOR_SCHEME_CALIBRATION_PACKET_TYPE),
  artifactId: z.string().trim().min(1),
  auditArtifactId: z.string().trim().min(1),
  auditSha256: Sha256Schema,
  selectionSha256: Sha256Schema,
  detector: z.object({
    source: z.literal("src/color-scheme.ts"),
    algorithmVersion: z.literal(COLOR_SCHEME_DETECTOR_VERSION),
    maxDimension: z.number().int().positive(),
    threshold: z.number().finite(),
    margin: z.number().finite().nonnegative(),
  }).strict(),
  instructions: z.array(z.string().trim().min(1)).min(1),
  entries: z.array(PacketEntrySchema).min(1),
}).strict().superRefine((packet, ctx) => {
  if (new Set(packet.entries.map((entry) => entry.entryId)).size !== packet.entries.length) {
    ctx.addIssue({ code: "custom", path: ["entries"], message: "calibration packet entry IDs must be unique" });
  }
  if (packet.detector.maxDimension !== COLOR_SCHEME_MAX_DIMENSION) {
    ctx.addIssue({ code: "custom", path: ["detector", "maxDimension"], message: `detector.maxDimension must equal ${COLOR_SCHEME_MAX_DIMENSION}` });
  }
  if (packet.detector.threshold !== COLOR_SCHEME_THRESHOLD) {
    ctx.addIssue({ code: "custom", path: ["detector", "threshold"], message: `detector.threshold must equal ${COLOR_SCHEME_THRESHOLD}` });
  }
  if (packet.detector.margin !== COLOR_SCHEME_MARGIN) {
    ctx.addIssue({ code: "custom", path: ["detector", "margin"], message: `detector.margin must equal ${COLOR_SCHEME_MARGIN}` });
  }
});

const CalibrationLabelSchema = z.object({
  entryId: z.string().trim().min(1),
  imageSha256: Sha256Schema,
  value: CalibrationValueSchema,
  note: z.string().trim().min(1).max(500).optional(),
}).strict().superRefine((label, ctx) => {
  if (label.value === "abstain" && !label.note) {
    ctx.addIssue({ code: "custom", path: ["note"], message: "abstain labels require a reason" });
  }
  if (label.value !== "abstain" && label.note) {
    ctx.addIssue({ code: "custom", path: ["note"], message: "notes are only allowed for abstain labels" });
  }
});

export const ColorSchemeCalibrationSubmissionSchema = z.object({
  schemaVersion: z.literal(COLOR_SCHEME_CALIBRATION_SCHEMA_VERSION),
  artifactType: z.literal(COLOR_SCHEME_CALIBRATION_SUBMISSION_TYPE),
  artifactId: z.string().trim().min(1),
  packetArtifactId: z.string().trim().min(1),
  packetSha256: Sha256Schema,
  reviewerId: z.string().trim().min(1).max(120),
  sealedAt: z.string().datetime({ offset: true }),
  labels: z.array(CalibrationLabelSchema).min(1),
}).strict().superRefine((submission, ctx) => {
  if (new Set(submission.labels.map((label) => label.entryId)).size !== submission.labels.length) {
    ctx.addIssue({ code: "custom", path: ["labels"], message: "calibration labels must be unique" });
  }
});

const ConfusionRowSchema = z.object({ light: z.number().int().nonnegative(), dark: z.number().int().nonnegative() }).strict();

export const ColorSchemeCalibrationReportSchema = z.object({
  schemaVersion: z.literal(COLOR_SCHEME_CALIBRATION_SCHEMA_VERSION),
  artifactType: z.literal(COLOR_SCHEME_CALIBRATION_REPORT_TYPE),
  artifactId: z.string().trim().min(1),
  auditArtifactId: z.string().trim().min(1),
  auditSha256: Sha256Schema,
  packetArtifactId: z.string().trim().min(1),
  packetSha256: Sha256Schema,
  submissionArtifactId: z.string().trim().min(1),
  reviewerId: z.string().trim().min(1),
  detector: z.object({
    source: z.literal("src/color-scheme.ts"),
    algorithmVersion: z.literal(COLOR_SCHEME_DETECTOR_VERSION),
    maxDimension: z.number().int().positive(),
    threshold: z.number().finite(),
    margin: z.number().finite().nonnegative(),
  }).strict(),
  minimumScoredLabels: z.number().int().positive(),
  minimumAccuracy: z.number().finite().min(0).max(1),
  counts: z.object({ selected: z.number().int().nonnegative(), scored: z.number().int().nonnegative(), correct: z.number().int().nonnegative(), incorrect: z.number().int().nonnegative(), abstained: z.number().int().nonnegative() }).strict(),
  accuracy: z.number().finite().min(0).max(1).nullable(),
  confusion: z.object({ expectedLight: ConfusionRowSchema, expectedDark: ConfusionRowSchema }).strict(),
  status: z.enum(["pass", "fail", "insufficient"]),
  decisions: z.array(z.object({ entryId: z.string().trim().min(1), human: CalibrationValueSchema, detected: ColorSchemeSchema }).strict()),
}).strict().superRefine((report, ctx) => {
  if (report.counts.scored !== report.counts.correct + report.counts.incorrect) ctx.addIssue({ code: "custom", path: ["counts", "scored"], message: "scored count must equal correct plus incorrect" });
  if (report.counts.selected !== report.counts.scored + report.counts.abstained) ctx.addIssue({ code: "custom", path: ["counts", "selected"], message: "selected count must equal scored plus abstained" });
  const expectedAccuracy = report.counts.scored ? report.counts.correct / report.counts.scored : null;
  if (report.accuracy !== expectedAccuracy) ctx.addIssue({ code: "custom", path: ["accuracy"], message: "accuracy does not match counts" });
  if (report.status === "pass" && (report.counts.scored < report.minimumScoredLabels || report.accuracy === null || report.accuracy < report.minimumAccuracy)) {
    ctx.addIssue({ code: "custom", path: ["status"], message: "passing calibration reports must satisfy their configured gate" });
  }
});

export type ColorSchemeCalibrationPacket = z.infer<typeof ColorSchemeCalibrationPacketSchema>;
export type ColorSchemeCalibrationLabel = z.infer<typeof CalibrationLabelSchema>;
export type ColorSchemeCalibrationSubmission = z.infer<typeof ColorSchemeCalibrationSubmissionSchema>;
export type ColorSchemeCalibrationReport = z.infer<typeof ColorSchemeCalibrationReportSchema>;
export type ColorSchemeCalibrationPacketEntry = z.infer<typeof PacketEntrySchema>;

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function entryRank(seed: string, entryId: string): string {
  return sha256(`${seed}:${entryId}`);
}

function validAuditEntries(report: ColorSchemeAuditReport): ColorSchemeAuditEntry[] {
  return report.entries.filter((entry) => entry.status !== "missing-image" && entry.status !== "error" && entry.imagePath !== null && entry.imageSha256 !== null && entry.detectedColorScheme !== null && entry.medianLuma !== null);
}

function pushFirst(out: ColorSchemeCalibrationPacketEntry[], seen: Set<string>, entries: readonly ColorSchemeAuditEntry[], stratum: ColorSchemeCalibrationStratum): boolean {
  const entry = entries.find((candidate) => !seen.has(candidate.entryId));
  if (!entry || entry.imagePath === null || entry.imageSha256 === null || entry.detectedColorScheme === null || entry.medianLuma === null) return false;
  seen.add(entry.entryId);
  out.push({
    entryId: entry.entryId,
    imagePath: entry.imagePath,
    imageSha256: entry.imageSha256,
    existingColorScheme: entry.existingColorScheme,
    detectedColorScheme: entry.detectedColorScheme,
    medianLuma: entry.medianLuma,
    stratum,
  });
  return true;
}

export function selectColorSchemeCalibrationEntries(report: ColorSchemeAuditReport, size = 12): ColorSchemeCalibrationPacketEntry[] {
  if (!Number.isInteger(size) || size < 1) throw new Error("calibration selection size must be a positive integer");
  const candidates = validAuditEntries(report);
  const byNear = [...candidates].sort((a, b) => Math.abs(a.medianLuma! - COLOR_SCHEME_THRESHOLD) - Math.abs(b.medianLuma! - COLOR_SCHEME_THRESHOLD) || a.entryId.localeCompare(b.entryId));
  const byExisting = candidates.filter((entry) => entry.existingColorScheme !== null).sort((a, b) => entryRank("existing", a.entryId).localeCompare(entryRank("existing", b.entryId)));
  const byLuma = [...candidates].sort((a, b) => a.medianLuma! - b.medianLuma! || a.entryId.localeCompare(b.entryId));
  const tails: ColorSchemeAuditEntry[] = [];
  for (let low = 0, high = byLuma.length - 1; low <= high; low += 1, high -= 1) {
    if (byLuma[low]) tails.push(byLuma[low]!);
    if (high !== low && byLuma[high]) tails.push(byLuma[high]!);
  }
  const selected: ColorSchemeCalibrationPacketEntry[] = [];
  const seen = new Set<string>();
  const target = Math.min(size, candidates.length);
  const sources: Array<[readonly ColorSchemeAuditEntry[], ColorSchemeCalibrationStratum]> = [
    [byNear, "threshold-near"],
    [byExisting, "existing-value"],
    [tails, "luma-tail"],
  ];
  while (selected.length < target) {
    let progressed = false;
    for (const [source, stratum] of sources) {
      if (selected.length >= target) break;
      progressed = pushFirst(selected, seen, source, stratum) || progressed;
    }
    if (!progressed) break;
  }
  if (selected.length < target) {
    pushFirst(selected, seen, byNear, "threshold-near");
  }
  return selected.slice(0, target);
}

export function buildColorSchemeCalibrationPacket(report: ColorSchemeAuditReport, auditSha256: string, size = 12): ColorSchemeCalibrationPacket {
  const parsed = ColorSchemeAuditReportSchema.parse(report);
  const entries = selectColorSchemeCalibrationEntries(parsed, size);
  if (entries.length === 0) throw new Error("color-scheme audit has no valid rows for calibration");
  const selectionSha256 = sha256(JSON.stringify(entries));
  return ColorSchemeCalibrationPacketSchema.parse({
    schemaVersion: COLOR_SCHEME_CALIBRATION_SCHEMA_VERSION,
    artifactType: COLOR_SCHEME_CALIBRATION_PACKET_TYPE,
    artifactId: `${parsed.artifactId}-calibration-packet-v1`,
    auditArtifactId: parsed.artifactId,
    auditSha256,
    selectionSha256,
    detector: parsed.detector,
    instructions: [
      "Judge only the screenshot and any explicitly supplied evidence; do not use the existing corpus value or a model prediction.",
      "Choose light or dark for the dominant canvas and surface theme. Use abstain only when the screenshot is genuinely ambiguous.",
      "An abstain decision requires a short reason. This packet calibrates a deterministic detector and does not itself authorize corpus writes.",
    ],
    entries,
  });
}

function assertPacketBindsToAudit(audit: ColorSchemeAuditReport, auditSha256: string, packet: ColorSchemeCalibrationPacket, packetSha256: string): void {
  if (packet.auditArtifactId !== audit.artifactId) throw new Error("calibration packet belongs to a different audit artifact");
  if (packet.auditSha256 !== auditSha256) throw new Error("calibration packet audit hash does not match");
  if (sha256(JSON.stringify(packet.entries)) !== packet.selectionSha256) throw new Error("calibration packet selection hash is invalid");
  if (sha256(JSON.stringify(packet)) !== packetSha256) throw new Error("calibration packet hash does not match");
  const byId = new Map(audit.entries.map((entry) => [entry.entryId, entry]));
  for (const selected of packet.entries) {
    const entry = byId.get(selected.entryId);
    if (!entry || entry.imagePath !== selected.imagePath || entry.imageSha256 !== selected.imageSha256 || entry.detectedColorScheme !== selected.detectedColorScheme || entry.medianLuma !== selected.medianLuma) {
      throw new Error(`calibration packet row does not match audit for ${selected.entryId}`);
    }
  }
}

export function evaluateColorSchemeCalibration(
  audit: ColorSchemeAuditReport,
  auditSha256: string,
  packet: ColorSchemeCalibrationPacket,
  submission: ColorSchemeCalibrationSubmission,
  options: { packetSha256: string; minimumScoredLabels?: number; minimumAccuracy?: number } = { packetSha256: "" },
): ColorSchemeCalibrationReport {
  const parsedAudit = ColorSchemeAuditReportSchema.parse(audit);
  const parsedPacket = ColorSchemeCalibrationPacketSchema.parse(packet);
  const parsedSubmission = ColorSchemeCalibrationSubmissionSchema.parse(submission);
  const packetSha256 = options.packetSha256;
  assertPacketBindsToAudit(parsedAudit, auditSha256, parsedPacket, packetSha256);
  if (parsedSubmission.packetArtifactId !== parsedPacket.artifactId) throw new Error("submission belongs to a different calibration packet");
  if (parsedSubmission.packetSha256 !== packetSha256) throw new Error("submission packet hash does not match");
  const packetById = new Map(parsedPacket.entries.map((entry) => [entry.entryId, entry]));
  if (parsedSubmission.labels.length !== packetById.size || parsedSubmission.labels.some((label) => !packetById.has(label.entryId))) throw new Error("submission labels must exactly match the calibration packet");
  let correct = 0;
  let incorrect = 0;
  let abstained = 0;
  const confusion = { expectedLight: { light: 0, dark: 0 }, expectedDark: { light: 0, dark: 0 } };
  const decisions = parsedSubmission.labels.map((label) => {
    const selected = packetById.get(label.entryId)!;
    if (label.imageSha256 !== selected.imageSha256) throw new Error(`calibration label image hash mismatch for ${label.entryId}`);
    if (label.value === "abstain") {
      abstained += 1;
    } else {
      const expected = label.value;
      const detected = selected.detectedColorScheme;
      confusion[expected === "light" ? "expectedLight" : "expectedDark"][detected] += 1;
      if (expected === detected) correct += 1;
      else incorrect += 1;
    }
    return { entryId: label.entryId, human: label.value, detected: selected.detectedColorScheme };
  });
  const scored = correct + incorrect;
  const minimumScoredLabels = options.minimumScoredLabels ?? 12;
  const minimumAccuracy = options.minimumAccuracy ?? 1;
  if (!Number.isInteger(minimumScoredLabels) || minimumScoredLabels < 1) throw new Error("minimumScoredLabels must be a positive integer");
  if (!Number.isFinite(minimumAccuracy) || minimumAccuracy < 0 || minimumAccuracy > 1) throw new Error("minimumAccuracy must be between 0 and 1");
  const accuracy = scored ? correct / scored : null;
  const status = scored < minimumScoredLabels ? "insufficient" : accuracy !== null && accuracy >= minimumAccuracy ? "pass" : "fail";
  return ColorSchemeCalibrationReportSchema.parse({
    schemaVersion: COLOR_SCHEME_CALIBRATION_SCHEMA_VERSION,
    artifactType: COLOR_SCHEME_CALIBRATION_REPORT_TYPE,
    artifactId: `${parsedSubmission.artifactId}-report-v1`,
    auditArtifactId: parsedAudit.artifactId,
    auditSha256,
    packetArtifactId: parsedPacket.artifactId,
    packetSha256,
    submissionArtifactId: parsedSubmission.artifactId,
    reviewerId: parsedSubmission.reviewerId,
    detector: parsedAudit.detector,
    minimumScoredLabels,
    minimumAccuracy,
    counts: { selected: parsedPacket.entries.length, scored, correct, incorrect, abstained },
    accuracy,
    confusion,
    status,
    decisions,
  });
}
