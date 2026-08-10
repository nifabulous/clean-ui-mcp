import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildColorSchemeCalibrationPacket,
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
});
