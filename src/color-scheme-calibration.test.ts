import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildColorSchemeCalibrationPacket,
  ColorSchemeCalibrationPacketSchema,
  ColorSchemeCalibrationReportSchema,
  ColorSchemeCalibrationSubmissionSchema,
  evaluateColorSchemeCalibration,
  selectColorSchemeCalibrationEntries,
  type ColorSchemeCalibrationSubmission,
} from "./color-scheme-calibration.js";
import { buildColorSchemeAuditReport, type ColorSchemeAuditReport } from "./color-scheme-audit.js";
import { COLOR_SCHEME_MARGIN, COLOR_SCHEME_MAX_DIMENSION, COLOR_SCHEME_THRESHOLD } from "./color-scheme.js";

const hash = (letter: string) => letter.repeat(64);

async function auditFixture(): Promise<ColorSchemeAuditReport> {
  return buildColorSchemeAuditReport({
    corpusSha256: hash("a"),
    entries: [
      { entryId: "near-light", imagePath: "images-private/near-light.png", imageSha256: hash("b"), existingColorScheme: null },
      { entryId: "near-dark", imagePath: "images-private/near-dark.png", imageSha256: hash("c"), existingColorScheme: "dark" },
      { entryId: "tail-light", imagePath: "images-private/tail-light.png", imageSha256: hash("d"), existingColorScheme: "light" },
      { entryId: "tail-dark", imagePath: "images-private/tail-dark.png", imageSha256: hash("e"), existingColorScheme: null },
      { entryId: "middle-light", imagePath: "images-private/middle-light.png", imageSha256: hash("f"), existingColorScheme: null },
      { entryId: "middle-dark", imagePath: "images-private/middle-dark.png", imageSha256: hash("1"), existingColorScheme: null },
      { entryId: "missing", imagePath: null, imageSha256: null, existingColorScheme: null },
    ],
    detect: async (imagePath) => {
      const medianLuma = imagePath.includes("tail-light") ? 240
        : imagePath.includes("tail-dark") ? 20
          : imagePath.includes("near") ? 116
            : imagePath.includes("middle-light") ? 190
              : 50;
      return {
        colorScheme: medianLuma >= COLOR_SCHEME_THRESHOLD ? "light" : "dark",
        medianLuma,
        threshold: COLOR_SCHEME_THRESHOLD,
        margin: COLOR_SCHEME_MARGIN,
      };
    },
  });
}

function auditHash(audit: ColorSchemeAuditReport): string {
  return createHash("sha256").update(JSON.stringify(audit)).digest("hex");
}

function packetHash(packet: object): string {
  return createHash("sha256").update(JSON.stringify(packet)).digest("hex");
}

/**
 * Mirrors the production cohort canonicalisation. An attacker reading the source
 * can do exactly this, so the cherry-pick guard must hold even when the forged
 * packet's selection hash is computed correctly.
 */
function selectionHash(entries: ReadonlyArray<{ entryId: string; imagePath: string; imageSha256: string; existingColorScheme: string | null; detectedColorScheme: "light" | "dark"; medianLuma: number; stratum: string }>): string {
  const canonical = JSON.stringify(entries.map((entry) => ([
    entry.entryId,
    entry.imagePath,
    entry.imageSha256,
    entry.existingColorScheme,
    entry.detectedColorScheme,
    entry.medianLuma,
    entry.stratum,
  ])));
  return createHash("sha256").update(canonical).digest("hex");
}

describe("color scheme calibration", () => {
  it("selects a deterministic, diverse cohort and excludes missing rows", async () => {
    const audit = await auditFixture();
    const first = selectColorSchemeCalibrationEntries(audit, 5).map((entry) => [entry.entryId, entry.stratum]);
    const second = selectColorSchemeCalibrationEntries(audit, 5).map((entry) => [entry.entryId, entry.stratum]);
    expect(first).toEqual(second);
    expect(first).toHaveLength(5);
    expect(first.map(([id]) => id)).not.toContain("missing");
    expect(new Set(first.map(([, stratum]) => stratum))).toEqual(new Set(["threshold-near", "existing-value", "luma-tail"]));
  });

  it("binds the packet to the audit and exact selected image hashes", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 4);
    expect(packet.auditArtifactId).toBe(audit.artifactId);
    expect(packet.entries).toHaveLength(4);
    for (const selected of packet.entries) {
      const audited = audit.entries.find((entry) => entry.entryId === selected.entryId);
      expect(selected.imageSha256).toBe(audited?.imageSha256);
      expect(selected.detectedColorScheme).toBe(audited?.detectedColorScheme);
    }
    expect(packet.detector).toEqual({
      source: "src/color-scheme.ts",
      algorithmVersion: "color-scheme-v1",
      maxDimension: COLOR_SCHEME_MAX_DIMENSION,
      threshold: COLOR_SCHEME_THRESHOLD,
      margin: COLOR_SCHEME_MARGIN,
    });
  });

  it("scores correct, incorrect, and abstained human decisions behind a calibration gate", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 4);
    const packetSha256 = packetHash(packet);
    const labels = packet.entries.map((entry, index) => ({
      entryId: entry.entryId,
      imageSha256: entry.imageSha256,
      value: index === 0 ? entry.detectedColorScheme! : index === 1 ? (entry.detectedColorScheme === "light" ? "dark" : "light") : "abstain" as const,
      ...(index > 1 ? { note: "The screenshot is ambiguous at this size." } : {}),
    }));
    const submission: ColorSchemeCalibrationSubmission = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-submission",
      artifactId: "submission-alice-v1",
      packetArtifactId: packet.artifactId,
      packetSha256,
      reviewerId: "alice",
      sealedAt: "2026-08-10T10:00:00.000Z",
      labels,
    };
    const report = evaluateColorSchemeCalibration(audit, auditHash(audit), packet, submission, {
      minimumScoredLabels: 2,
      minimumAccuracy: 0.5,
      packetSha256,
    });
    expect(report.counts).toMatchObject({ selected: 4, scored: 2, correct: 1, incorrect: 1, abstained: 2 });
    expect(report.accuracy).toBe(0.5);
    expect(report.status).toBe("pass");
  });

  it("reports insufficient evidence instead of passing an abstain-only packet", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 3);
    const packetSha256 = packetHash(packet);
    const submission: ColorSchemeCalibrationSubmission = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-submission",
      artifactId: "submission-bob-v1",
      packetArtifactId: packet.artifactId,
      packetSha256,
      reviewerId: "bob",
      sealedAt: "2026-08-10T10:00:00.000Z",
      labels: packet.entries.map((entry) => ({ entryId: entry.entryId, imageSha256: entry.imageSha256, value: "abstain", note: "Insufficient evidence." })),
    };
    const report = evaluateColorSchemeCalibration(audit, auditHash(audit), packet, submission, {
      minimumScoredLabels: 2,
      minimumAccuracy: 1,
      packetSha256,
    });
    expect(report.accuracy).toBeNull();
    expect(report.status).toBe("insufficient");
  });

  it("rejects labels that do not bind to the selected audit image", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 3);
    const packetSha256 = packetHash(packet);
    const submission: ColorSchemeCalibrationSubmission = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-submission",
      artifactId: "submission-stale-v1",
      packetArtifactId: packet.artifactId,
      packetSha256,
      reviewerId: "stale",
      sealedAt: "2026-08-10T10:00:00.000Z",
      labels: packet.entries.map((entry) => ({ entryId: entry.entryId, imageSha256: hash("9"), value: "light" as const })),
    };
    expect(() => evaluateColorSchemeCalibration(audit, auditHash(audit), packet, submission, { packetSha256 })).toThrow(/image hash/);
  });

  it("rejects a cherry-picked cohort that is not the deterministic selection", async () => {
    const audit = await auditFixture();
    const auditSha256 = auditHash(audit);
    const honest = buildColorSchemeCalibrationPacket(audit, auditSha256, 4);
    // Swap in four audit-consistent rows that the selector would not have chosen,
    // then recompute every hash the packet carries. Self-consistency must not be
    // mistaken for provenance.
    const riggedEntries = audit.entries
      .filter((entry) => entry.entryId !== "missing")
      .slice(-4)
      .map((entry) => ({
        entryId: entry.entryId,
        imagePath: entry.imagePath!,
        imageSha256: entry.imageSha256!,
        existingColorScheme: entry.existingColorScheme,
        detectedColorScheme: entry.detectedColorScheme!,
        medianLuma: entry.medianLuma!,
        stratum: "threshold-near" as const,
      }));
    const rigged = ColorSchemeCalibrationPacketSchema.parse({
      ...honest,
      entries: riggedEntries,
      selectionSha256: selectionHash(riggedEntries),
    });
    const riggedSha256 = packetHash(rigged);
    expect(rigged.entries.map((entry) => entry.entryId)).not.toEqual(honest.entries.map((entry) => entry.entryId));
    const submission: ColorSchemeCalibrationSubmission = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-submission",
      artifactId: "submission-rigged-v1",
      packetArtifactId: rigged.artifactId,
      packetSha256: riggedSha256,
      reviewerId: "rigged",
      sealedAt: "2026-08-10T10:00:00.000Z",
      labels: rigged.entries.map((entry) => ({ entryId: entry.entryId, imageSha256: entry.imageSha256, value: entry.detectedColorScheme })),
    };
    expect(() => evaluateColorSchemeCalibration(audit, auditSha256, rigged, submission, { packetSha256: riggedSha256, minimumScoredLabels: 4, minimumAccuracy: 1 }))
      .toThrow(/deterministic cohort/);
  });

  it("rejects a packet whose recorded stratum was relabelled", async () => {
    const audit = await auditFixture();
    const auditSha256 = auditHash(audit);
    const honest = buildColorSchemeCalibrationPacket(audit, auditSha256, 4);
    const relabelledEntries = honest.entries.map((entry) => ({ ...entry, stratum: "threshold-near" as const }));
    const relabelled = ColorSchemeCalibrationPacketSchema.parse({
      ...honest,
      entries: relabelledEntries,
      selectionSha256: selectionHash(relabelledEntries),
    });
    const relabelledSha256 = packetHash(relabelled);
    const submission: ColorSchemeCalibrationSubmission = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-submission",
      artifactId: "submission-relabelled-v1",
      packetArtifactId: relabelled.artifactId,
      packetSha256: relabelledSha256,
      reviewerId: "relabelled",
      sealedAt: "2026-08-10T10:00:00.000Z",
      labels: relabelled.entries.map((entry) => ({ entryId: entry.entryId, imageSha256: entry.imageSha256, value: entry.detectedColorScheme })),
    };
    expect(() => evaluateColorSchemeCalibration(audit, auditSha256, relabelled, submission, { packetSha256: relabelledSha256, minimumScoredLabels: 4, minimumAccuracy: 1 }))
      .toThrow(/deterministic cohort/);
  });

  it("rejects a packet presented against a different audit hash", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 3);
    const packetSha256 = packetHash(packet);
    const submission: ColorSchemeCalibrationSubmission = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-submission",
      artifactId: "submission-crossaudit-v1",
      packetArtifactId: packet.artifactId,
      packetSha256,
      reviewerId: "crossaudit",
      sealedAt: "2026-08-10T10:00:00.000Z",
      labels: packet.entries.map((entry) => ({ entryId: entry.entryId, imageSha256: entry.imageSha256, value: entry.detectedColorScheme })),
    };
    expect(() => evaluateColorSchemeCalibration(audit, hash("8"), packet, submission, { packetSha256 })).toThrow(/audit hash/);
  });

  it("returns fail when the human disagrees with the detector above the accuracy floor", async () => {
    const audit = await auditFixture();
    const auditSha256 = auditHash(audit);
    const packet = buildColorSchemeCalibrationPacket(audit, auditSha256, 4);
    const packetSha256 = packetHash(packet);
    const submission: ColorSchemeCalibrationSubmission = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-submission",
      artifactId: "submission-disagree-v1",
      packetArtifactId: packet.artifactId,
      packetSha256,
      reviewerId: "disagree",
      sealedAt: "2026-08-10T10:00:00.000Z",
      labels: packet.entries.map((entry) => ({ entryId: entry.entryId, imageSha256: entry.imageSha256, value: entry.detectedColorScheme === "light" ? "dark" as const : "light" as const })),
    };
    const report = evaluateColorSchemeCalibration(audit, auditSha256, packet, submission, { packetSha256, minimumScoredLabels: 4, minimumAccuracy: 1 });
    expect(report.counts).toMatchObject({ scored: 4, correct: 0, incorrect: 4 });
    expect(report.accuracy).toBe(0);
    expect(report.status).toBe("fail");
  });

  it("binds the report to the submission it scored", async () => {
    const audit = await auditFixture();
    const auditSha256 = auditHash(audit);
    const packet = buildColorSchemeCalibrationPacket(audit, auditSha256, 3);
    const packetSha256 = packetHash(packet);
    const submission: ColorSchemeCalibrationSubmission = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-submission",
      artifactId: "submission-bound-v1",
      packetArtifactId: packet.artifactId,
      packetSha256,
      reviewerId: "bound",
      sealedAt: "2026-08-10T10:00:00.000Z",
      labels: packet.entries.map((entry) => ({ entryId: entry.entryId, imageSha256: entry.imageSha256, value: entry.detectedColorScheme })),
    };
    const report = evaluateColorSchemeCalibration(audit, auditSha256, packet, submission, { packetSha256, minimumScoredLabels: 3, minimumAccuracy: 1 });
    expect(report.submissionSha256).toBe(createHash("sha256").update(JSON.stringify(ColorSchemeCalibrationSubmissionSchema.parse(submission))).digest("hex"));
    expect(report.decisions).toHaveLength(report.counts.selected);
  });

  it("refuses a hand-authored report whose decisions and confusion do not reconcile with its counts", () => {
    const forged = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-report",
      artifactId: "forged-v1",
      auditArtifactId: "deterministic-color-scheme-audit-v1",
      auditSha256: hash("a"),
      packetArtifactId: "nope",
      packetSha256: hash("b"),
      submissionArtifactId: "never-existed",
      submissionSha256: hash("c"),
      reviewerId: "ghost",
      detector: { source: "src/color-scheme.ts", algorithmVersion: "color-scheme-v1", maxDimension: COLOR_SCHEME_MAX_DIMENSION, threshold: COLOR_SCHEME_THRESHOLD, margin: COLOR_SCHEME_MARGIN },
      minimumScoredLabels: 12,
      minimumAccuracy: 1,
      counts: { selected: 12, scored: 12, correct: 12, incorrect: 0, abstained: 0 },
      accuracy: 1,
      confusion: { expectedLight: { light: 0, dark: 0 }, expectedDark: { light: 0, dark: 0 } },
      status: "pass",
      decisions: [],
    };
    const parsed = ColorSchemeCalibrationReportSchema.safeParse(forged);
    expect(parsed.success).toBe(false);
  });
});
