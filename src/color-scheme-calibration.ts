import { createHash } from "node:crypto";
import { z } from "zod";
import {
  COLOR_SCHEME_DETECTOR_VERSION,
  COLOR_SCHEME_MARGIN,
  COLOR_SCHEME_MAX_DIMENSION,
  COLOR_SCHEME_THRESHOLD,
  type ColorScheme,
} from "./color-scheme.js";
import { canonicalJsonStringify } from "./readiness/contracts.js";
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

/**
 * The gate a calibration report must clear before it can be cited as evidence
 * for a corpus promotion. Callers may configure a laxer gate for experiments;
 * `promotionEligible` on the report records whether they did, so a permissive
 * run cannot be mistaken for a promotion-grade one.
 */
export const COLOR_SCHEME_CALIBRATION_PROMOTION_FLOOR = {
  minimumScoredLabels: 12,
  minimumAccuracy: 1,
  /** Scored gold labels required in EACH class; a single-class cohort proves nothing about the other. */
  minimumPerClass: 1,
} as const;

/**
 * The one serialisation used for every calibration artifact: what the CLI writes
 * to disk, and what the recorded SHA-256 digests hash. `sha256sum <file>` on a
 * packet or report therefore reproduces the digest the artifact family records.
 *
 * Delegates to the repo-wide `canonicalJsonStringify` (src/readiness/contracts.ts)
 * rather than defining a second convention. That function sorts keys, so the
 * digest is independent of construction order instead of relying on Zod emitting
 * keys in shape order. This repo has already paid for two disagreeing
 * canonicalisers once: retag-shadow and retag-diff hashed the same corpus value
 * differently on all 787 entries and made a promotion gate unsatisfiable.
 */
export function canonicalArtifactJson(artifact: unknown): string {
  return canonicalJsonStringify(artifact) + "\n";
}

/** Order IDs by UTF-16 code unit so cohort selection cannot vary with host locale or ICU version. */
function compareEntryIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function deriveCalibrationStatus(scored: number, accuracy: number | null, minimumScoredLabels: number, minimumAccuracy: number): "pass" | "fail" | "insufficient" {
  if (scored < minimumScoredLabels) return "insufficient";
  return accuracy !== null && accuracy >= minimumAccuracy ? "pass" : "fail";
}

function deriveCalibrationPromotionEligible(
  status: string,
  minimumScoredLabels: number,
  minimumAccuracy: number,
  scoredByHumanValue: { light: number; dark: number },
): boolean {
  // Class balance is part of the floor, not a footnote. A cohort whose gold
  // labels are all one class carries no evidence about the other, so a perfect
  // score on it cannot authorize a corpus-wide fill. The first real run was
  // 12 light / 0 dark, where a constant "light" would also have scored 12/12.
  return status === "pass"
    && minimumScoredLabels >= COLOR_SCHEME_CALIBRATION_PROMOTION_FLOOR.minimumScoredLabels
    && minimumAccuracy >= COLOR_SCHEME_CALIBRATION_PROMOTION_FLOOR.minimumAccuracy
    && scoredByHumanValue.light >= COLOR_SCHEME_CALIBRATION_PROMOTION_FLOOR.minimumPerClass
    && scoredByHumanValue.dark >= COLOR_SCHEME_CALIBRATION_PROMOTION_FLOOR.minimumPerClass;
}

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
  submissionSha256: Sha256Schema,
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
  counts: z.object({
    selected: z.number().int().nonnegative(),
    scored: z.number().int().nonnegative(),
    correct: z.number().int().nonnegative(),
    incorrect: z.number().int().nonnegative(),
    abstained: z.number().int().nonnegative(),
    scoredByHumanValue: z.object({ light: z.number().int().nonnegative(), dark: z.number().int().nonnegative() }).strict(),
  }).strict(),
  accuracy: z.number().finite().min(0).max(1).nullable(),
  confusion: z.object({ expectedLight: ConfusionRowSchema, expectedDark: ConfusionRowSchema }).strict(),
  status: z.enum(["pass", "fail", "insufficient"]),
  decisions: z.array(z.object({ entryId: z.string().trim().min(1), human: CalibrationValueSchema, detected: ColorSchemeSchema }).strict()),
  promotionEligible: z.boolean(),
}).strict().superRefine((report, ctx) => {
  if (report.counts.scored !== report.counts.correct + report.counts.incorrect) ctx.addIssue({ code: "custom", path: ["counts", "scored"], message: "scored count must equal correct plus incorrect" });
  if (report.counts.selected !== report.counts.scored + report.counts.abstained) ctx.addIssue({ code: "custom", path: ["counts", "selected"], message: "selected count must equal scored plus abstained" });
  const expectedAccuracy = report.counts.scored ? report.counts.correct / report.counts.scored : null;
  if (report.accuracy !== expectedAccuracy) ctx.addIssue({ code: "custom", path: ["accuracy"], message: "accuracy does not match counts" });
  // A report is only evidence if its per-row decisions reconcile with its own
  // totals. Without these checks a hand-authored report carrying nothing but
  // favourable counts validates as `pass`.
  if (report.decisions.length !== report.counts.selected) {
    ctx.addIssue({ code: "custom", path: ["decisions"], message: "decisions must cover exactly the selected calibration rows" });
  }
  if (new Set(report.decisions.map((decision) => decision.entryId)).size !== report.decisions.length) {
    ctx.addIssue({ code: "custom", path: ["decisions"], message: "calibration decisions must be unique per entry" });
  }
  const decidedAbstain = report.decisions.filter((decision) => decision.human === "abstain").length;
  if (report.decisions.length === report.counts.selected && decidedAbstain !== report.counts.abstained) {
    ctx.addIssue({ code: "custom", path: ["counts", "abstained"], message: "abstained count must equal the abstained decisions" });
  }
  const confusionTotal = report.confusion.expectedLight.light + report.confusion.expectedLight.dark + report.confusion.expectedDark.light + report.confusion.expectedDark.dark;
  if (confusionTotal !== report.counts.scored) {
    ctx.addIssue({ code: "custom", path: ["confusion"], message: "confusion cells must sum to the scored count" });
  }
  const confusionCorrect = report.confusion.expectedLight.light + report.confusion.expectedDark.dark;
  if (confusionTotal === report.counts.scored && confusionCorrect !== report.counts.correct) {
    ctx.addIssue({ code: "custom", path: ["confusion"], message: "confusion diagonal must equal the correct count" });
  }
  // Status and promotion eligibility are derived, not asserted, so a forged
  // value cannot disagree with the counts it is supposed to summarise.
  const expectedStatus = deriveCalibrationStatus(report.counts.scored, report.accuracy, report.minimumScoredLabels, report.minimumAccuracy);
  if (report.status !== expectedStatus) {
    ctx.addIssue({ code: "custom", path: ["status"], message: `status must be ${expectedStatus} for these counts and gate thresholds` });
  }
  const byClass = report.counts.scoredByHumanValue;
  if (byClass.light + byClass.dark !== report.counts.scored) {
    ctx.addIssue({ code: "custom", path: ["counts", "scoredByHumanValue"], message: "per-class scored counts must sum to the scored count" });
  }
  const expectedEligible = deriveCalibrationPromotionEligible(expectedStatus, report.minimumScoredLabels, report.minimumAccuracy, byClass);
  if (report.promotionEligible !== expectedEligible) {
    ctx.addIssue({
      code: "custom",
      path: ["promotionEligible"],
      message: `promotionEligible must be ${expectedEligible}: the promotion floor is ${COLOR_SCHEME_CALIBRATION_PROMOTION_FLOOR.minimumScoredLabels} scored labels at accuracy ${COLOR_SCHEME_CALIBRATION_PROMOTION_FLOOR.minimumAccuracy}`,
    });
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

/**
 * Serialise cohort rows in a fixed key order so `selectionSha256` never depends
 * on the incidental agreement between an object literal and a Zod shape.
 */
function canonicalEntriesJson(entries: readonly ColorSchemeCalibrationPacketEntry[]): string {
  return JSON.stringify(entries.map((entry) => ([
    entry.entryId,
    entry.imagePath,
    entry.imageSha256,
    entry.existingColorScheme,
    entry.detectedColorScheme,
    entry.medianLuma,
    entry.stratum,
  ])));
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
  const byNear = [...candidates].sort((a, b) => Math.abs(a.medianLuma! - COLOR_SCHEME_THRESHOLD) - Math.abs(b.medianLuma! - COLOR_SCHEME_THRESHOLD) || compareEntryIds(a.entryId, b.entryId));
  const byExisting = candidates.filter((entry) => entry.existingColorScheme !== null).sort((a, b) => compareEntryIds(entryRank("existing", a.entryId), entryRank("existing", b.entryId)));
  const byLuma = [...candidates].sort((a, b) => a.medianLuma! - b.medianLuma! || compareEntryIds(a.entryId, b.entryId));
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
  return selected.slice(0, target);
}

export function buildColorSchemeCalibrationPacket(report: ColorSchemeAuditReport, auditSha256: string, size = 12): ColorSchemeCalibrationPacket {
  const parsed = ColorSchemeAuditReportSchema.parse(report);
  const entries = selectColorSchemeCalibrationEntries(parsed, size);
  if (entries.length === 0) throw new Error("color-scheme audit has no valid rows for calibration");
  const selectionSha256 = sha256(canonicalEntriesJson(entries));
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
  // Recompute rather than trust: without this, "bound to the audit" would mean
  // only "bound to whatever string the caller passed as the audit hash".
  if (sha256(canonicalArtifactJson(audit)) !== auditSha256) throw new Error("supplied audit hash does not hash the supplied audit");
  if (packet.auditSha256 !== auditSha256) throw new Error("calibration packet audit hash does not match");
  const byId = new Map(audit.entries.map((entry) => [entry.entryId, entry]));
  for (const selected of packet.entries) {
    const entry = byId.get(selected.entryId);
    if (!entry || entry.imagePath !== selected.imagePath || entry.imageSha256 !== selected.imageSha256 || entry.detectedColorScheme !== selected.detectedColorScheme || entry.medianLuma !== selected.medianLuma) {
      throw new Error(`calibration packet row does not match audit for ${selected.entryId}`);
    }
  }
  if (sha256(canonicalEntriesJson(packet.entries)) !== packet.selectionSha256) throw new Error("calibration packet selection hash is invalid");
  // Self-consistency is not provenance: recomputing selectionSha256 over a
  // hand-picked cohort would satisfy the check above. Re-derive the cohort the
  // selector would have produced for this audit and require an exact match, so
  // easy rows cannot be cherry-picked and strata cannot be relabelled.
  const canonical = selectColorSchemeCalibrationEntries(audit, packet.entries.length);
  if (canonical.length !== packet.entries.length || sha256(canonicalEntriesJson(canonical)) !== packet.selectionSha256) {
    throw new Error("calibration packet is not the deterministic cohort for this audit");
  }
  if (sha256(canonicalArtifactJson(packet)) !== packetSha256) throw new Error("calibration packet hash does not match");
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
  const scoredByHumanValue = { light: 0, dark: 0 };
  for (const label of parsedSubmission.labels) if (label.value !== "abstain") scoredByHumanValue[label.value] += 1;
  const scored = correct + incorrect;
  const minimumScoredLabels = options.minimumScoredLabels ?? 12;
  const minimumAccuracy = options.minimumAccuracy ?? 1;
  if (!Number.isInteger(minimumScoredLabels) || minimumScoredLabels < 1) throw new Error("minimumScoredLabels must be a positive integer");
  if (!Number.isFinite(minimumAccuracy) || minimumAccuracy < 0 || minimumAccuracy > 1) throw new Error("minimumAccuracy must be between 0 and 1");
  const accuracy = scored ? correct / scored : null;
  const status = deriveCalibrationStatus(scored, accuracy, minimumScoredLabels, minimumAccuracy);
  return ColorSchemeCalibrationReportSchema.parse({
    schemaVersion: COLOR_SCHEME_CALIBRATION_SCHEMA_VERSION,
    artifactType: COLOR_SCHEME_CALIBRATION_REPORT_TYPE,
    artifactId: `${parsedSubmission.artifactId}-report-v1`,
    auditArtifactId: parsedAudit.artifactId,
    auditSha256,
    packetArtifactId: parsedPacket.artifactId,
    packetSha256,
    submissionArtifactId: parsedSubmission.artifactId,
    submissionSha256: sha256(canonicalArtifactJson(parsedSubmission)),
    reviewerId: parsedSubmission.reviewerId,
    detector: parsedAudit.detector,
    minimumScoredLabels,
    minimumAccuracy,
    counts: { selected: parsedPacket.entries.length, scored, correct, incorrect, abstained, scoredByHumanValue },
    accuracy,
    confusion,
    status,
    decisions,
    promotionEligible: deriveCalibrationPromotionEligible(status, minimumScoredLabels, minimumAccuracy, scoredByHumanValue),
  });
}
