import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  buildColorSchemeCalibrationPacket,
  canonicalArtifactJson,
  COLOR_SCHEME_CALIBRATION_PROMOTION_FLOOR,
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
  return createHash("sha256").update(canonicalArtifactJson(audit)).digest("hex");
}

function artifactHash(artifact: object): string {
  return createHash("sha256").update(canonicalArtifactJson(artifact)).digest("hex");
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
    const packetSha256 = artifactHash(packet);
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
    const packetSha256 = artifactHash(packet);
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
    const packetSha256 = artifactHash(packet);
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
    const riggedSha256 = artifactHash(rigged);
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
    const relabelledSha256 = artifactHash(relabelled);
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
    const packetSha256 = artifactHash(packet);
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
    const packetSha256 = artifactHash(packet);
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
    const packetSha256 = artifactHash(packet);
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
    expect(report.submissionSha256).toBe(artifactHash(ColorSchemeCalibrationSubmissionSchema.parse(submission)));
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
      counts: { selected: 12, scored: 12, correct: 12, incorrect: 0, abstained: 0, scoredByHumanValue: { light: 6, dark: 6 } },
      accuracy: 1,
      confusion: { expectedLight: { light: 0, dark: 0 }, expectedDark: { light: 0, dark: 0 } },
      status: "pass",
      decisions: [],
    };
    const parsed = ColorSchemeCalibrationReportSchema.safeParse(forged);
    expect(parsed.success).toBe(false);
  });

  it("marks a report below the promotion floor as not promotion eligible", async () => {
    const audit = await auditFixture();
    const auditSha256 = auditHash(audit);
    const packet = buildColorSchemeCalibrationPacket(audit, auditSha256, 1);
    const packetSha256 = artifactHash(packet);
    const flip = (value: "light" | "dark") => (value === "light" ? "dark" as const : "light" as const);
    const submission: ColorSchemeCalibrationSubmission = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-submission",
      artifactId: "submission-lax-v1",
      packetArtifactId: packet.artifactId,
      packetSha256,
      reviewerId: "lax",
      sealedAt: "2026-08-10T10:00:00.000Z",
      labels: packet.entries.map((entry) => ({ entryId: entry.entryId, imageSha256: entry.imageSha256, value: flip(entry.detectedColorScheme) })),
    };
    // A caller-chosen gate of one label at zero accuracy still computes a real
    // `pass`, so the artifact must say out loud that it cannot gate a promotion.
    const lax = evaluateColorSchemeCalibration(audit, auditSha256, packet, submission, { packetSha256, minimumScoredLabels: 1, minimumAccuracy: 0 });
    expect(lax.status).toBe("pass");
    expect(lax.counts.correct).toBe(0);
    expect(lax.promotionEligible).toBe(false);
    expect(COLOR_SCHEME_CALIBRATION_PROMOTION_FLOOR).toEqual({ minimumScoredLabels: 12, minimumAccuracy: 1, minimumPerClass: 1 });
  });

  it("marks a report at the promotion floor as promotion eligible", async () => {
    const audit = await auditFixture();
    const auditSha256 = auditHash(audit);
    const packet = buildColorSchemeCalibrationPacket(audit, auditSha256, 6);
    const packetSha256 = artifactHash(packet);
    const submission: ColorSchemeCalibrationSubmission = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-submission",
      artifactId: "submission-floor-v1",
      packetArtifactId: packet.artifactId,
      packetSha256,
      reviewerId: "floor",
      sealedAt: "2026-08-10T10:00:00.000Z",
      labels: packet.entries.map((entry) => ({ entryId: entry.entryId, imageSha256: entry.imageSha256, value: entry.detectedColorScheme })),
    };
    // Only six rows exist in the fixture, so the floor's label minimum cannot be
    // met here; the accuracy half of the floor is what this asserts.
    const report = evaluateColorSchemeCalibration(audit, auditSha256, packet, submission, { packetSha256, minimumScoredLabels: 6, minimumAccuracy: 1 });
    expect(report.status).toBe("pass");
    expect(report.promotionEligible).toBe(false);
    expect(report.minimumScoredLabels).toBeLessThan(COLOR_SCHEME_CALIBRATION_PROMOTION_FLOOR.minimumScoredLabels);
  });

  it("refuses a report whose promotionEligible flag disagrees with its thresholds", () => {
    const base = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-report",
      artifactId: "claims-eligible-v1",
      auditArtifactId: "deterministic-color-scheme-audit-v1",
      auditSha256: hash("a"),
      packetArtifactId: "p",
      packetSha256: hash("b"),
      submissionArtifactId: "s",
      submissionSha256: hash("c"),
      reviewerId: "ghost",
      detector: { source: "src/color-scheme.ts", algorithmVersion: "color-scheme-v1", maxDimension: COLOR_SCHEME_MAX_DIMENSION, threshold: COLOR_SCHEME_THRESHOLD, margin: COLOR_SCHEME_MARGIN },
      minimumScoredLabels: 1,
      minimumAccuracy: 0,
      counts: { selected: 1, scored: 1, correct: 0, incorrect: 1, abstained: 0, scoredByHumanValue: { light: 1, dark: 0 } },
      accuracy: 0,
      confusion: { expectedLight: { light: 0, dark: 1 }, expectedDark: { light: 0, dark: 0 } },
      status: "pass",
      decisions: [{ entryId: "one", human: "light" as const, detected: "dark" as const }],
      promotionEligible: true,
    };
    expect(ColorSchemeCalibrationReportSchema.safeParse(base).success).toBe(false);
    expect(ColorSchemeCalibrationReportSchema.safeParse({ ...base, promotionEligible: false }).success).toBe(true);
  });

  it("rejects a submission carrying a label outside the packet", async () => {
    const audit = await auditFixture();
    const auditSha256 = auditHash(audit);
    const packet = buildColorSchemeCalibrationPacket(audit, auditSha256, 3);
    const packetSha256 = artifactHash(packet);
    const labels = packet.entries.map((entry) => ({ entryId: entry.entryId, imageSha256: entry.imageSha256, value: entry.detectedColorScheme }));
    labels[0] = { ...labels[0]!, entryId: "not-in-this-packet" };
    const submission = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-submission",
      artifactId: "submission-unknown-v1",
      packetArtifactId: packet.artifactId,
      packetSha256,
      reviewerId: "unknown",
      sealedAt: "2026-08-10T10:00:00.000Z",
      labels,
    } as ColorSchemeCalibrationSubmission;
    expect(() => evaluateColorSchemeCalibration(audit, auditSha256, packet, submission, { packetSha256 })).toThrow(/exactly match/);
  });

  it("rejects a submission that labels the same entry twice", async () => {
    const audit = await auditFixture();
    const auditSha256 = auditHash(audit);
    const packet = buildColorSchemeCalibrationPacket(audit, auditSha256, 2);
    const first = packet.entries[0]!;
    const submission = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-submission",
      artifactId: "submission-dupe-v1",
      packetArtifactId: packet.artifactId,
      packetSha256: artifactHash(packet),
      reviewerId: "dupe",
      sealedAt: "2026-08-10T10:00:00.000Z",
      labels: [
        { entryId: first.entryId, imageSha256: first.imageSha256, value: first.detectedColorScheme },
        { entryId: first.entryId, imageSha256: first.imageSha256, value: first.detectedColorScheme },
      ],
    };
    expect(ColorSchemeCalibrationSubmissionSchema.safeParse(submission).success).toBe(false);
  });

  it("rejects an audit hash that does not hash the supplied audit", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 2);
    const packetSha256 = artifactHash(packet);
    const submission: ColorSchemeCalibrationSubmission = {
      schemaVersion: "1.0",
      artifactType: "color-scheme-calibration-submission",
      artifactId: "submission-audit-swap-v1",
      packetArtifactId: packet.artifactId,
      packetSha256,
      reviewerId: "swap",
      sealedAt: "2026-08-10T10:00:00.000Z",
      labels: packet.entries.map((entry) => ({ entryId: entry.entryId, imageSha256: entry.imageSha256, value: entry.detectedColorScheme })),
    };
    // The caller-supplied audit hash must actually hash the caller-supplied
    // audit, otherwise "bound to the audit" means only "bound to a string".
    const doctored = { ...audit, artifactId: audit.artifactId } as ColorSchemeAuditReport;
    expect(() => evaluateColorSchemeCalibration(doctored, hash("7"), packet, submission, { packetSha256 })).toThrow(/audit hash/);
  });

  it("hashes artifacts as the exact bytes the CLI writes to disk", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 2);
    // sha256sum on the written file must reproduce the digest the artifact
    // family records, or the provenance is unverifiable outside this codebase.
    const fileBytes = canonicalArtifactJson(packet);
    expect(artifactHash(packet)).toBe(createHash("sha256").update(fileBytes).digest("hex"));
    expect(canonicalArtifactJson(packet)).toBe(fileBytes);
  });

  it("orders cohort tie-breaks by code unit, independent of host locale", async () => {
    const audit = await buildColorSchemeAuditReport({
      corpusSha256: hash("a"),
      entries: [
        { entryId: "B-upper", imagePath: "images-private/b-upper.png", imageSha256: hash("b"), existingColorScheme: null },
        { entryId: "a-lower", imagePath: "images-private/a-lower.png", imageSha256: hash("c"), existingColorScheme: null },
        { entryId: "_underscore", imagePath: "images-private/underscore.png", imageSha256: hash("d"), existingColorScheme: null },
      ],
      // Identical luma on every row forces every comparison through the
      // tie-break, where localeCompare and code-unit order disagree.
      detect: async () => ({ colorScheme: "light", medianLuma: 200, threshold: COLOR_SCHEME_THRESHOLD, margin: COLOR_SCHEME_MARGIN }),
    });
    const ids = selectColorSchemeCalibrationEntries(audit, 3).map((entry) => entry.entryId);
    const byCodeUnit = ["B-upper", "a-lower", "_underscore"].sort();
    expect(ids[0]).toBe(byCodeUnit[0]);
  });
});

describe("color scheme calibration error paths", () => {
  const okSubmission = (packet: { artifactId: string; entries: ReadonlyArray<{ entryId: string; imageSha256: string; detectedColorScheme: "light" | "dark" }> }, packetSha256: string, over: Record<string, unknown> = {}) => ({
    schemaVersion: "1.0", artifactType: "color-scheme-calibration-submission", artifactId: "s-v1",
    packetArtifactId: packet.artifactId, packetSha256, reviewerId: "probe", sealedAt: "2026-08-10T10:00:00.000Z",
    labels: packet.entries.map((e) => ({ entryId: e.entryId, imageSha256: e.imageSha256, value: e.detectedColorScheme })),
    ...over,
  }) as ColorSchemeCalibrationSubmission;

  it("refuses a selection size that is not a positive integer", async () => {
    const audit = await auditFixture();
    expect(() => selectColorSchemeCalibrationEntries(audit, 0)).toThrow(/positive integer/);
    expect(() => selectColorSchemeCalibrationEntries(audit, 1.5)).toThrow(/positive integer/);
  });

  it("refuses to build a packet from an audit with no valid rows", async () => {
    const empty = await buildColorSchemeAuditReport({
      corpusSha256: hash("a"),
      entries: [{ entryId: "only", imagePath: null, imageSha256: null, existingColorScheme: null }],
      detect: async () => ({ colorScheme: "light", medianLuma: 200, threshold: COLOR_SCHEME_THRESHOLD, margin: COLOR_SCHEME_MARGIN }),
    });
    expect(() => buildColorSchemeCalibrationPacket(empty, auditHash(empty), 4)).toThrow(/no valid rows/);
  });

  it("refuses a packet whose recorded packet hash does not match", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 4);
    expect(() => evaluateColorSchemeCalibration(audit, auditHash(audit), packet, okSubmission(packet, hash("9")), { packetSha256: hash("9") }))
      .toThrow(/packet hash does not match/);
  });

  it("refuses a packet claiming a different audit artifact", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 4);
    const foreign = { ...packet, auditArtifactId: "some-other-audit" };
    const sha = artifactHash(foreign);
    expect(() => evaluateColorSchemeCalibration(audit, auditHash(audit), foreign as never, okSubmission(foreign, sha), { packetSha256: sha }))
      .toThrow(/different audit artifact/);
  });

  it("refuses a packet whose recorded audit hash disagrees with the caller's", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 4);
    const swapped = { ...packet, auditSha256: hash("5") };
    const sha = artifactHash(swapped);
    expect(() => evaluateColorSchemeCalibration(audit, auditHash(audit), swapped as never, okSubmission(swapped, sha), { packetSha256: sha }))
      .toThrow(/audit hash does not match/);
  });

  it("refuses a packet row that disagrees with the audit", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 4);
    const tampered = { ...packet, entries: packet.entries.map((e, i) => (i === 0 ? { ...e, imageSha256: hash("7") } : e)) };
    const sha = artifactHash(tampered);
    // The per-row check runs before the selection hash, so the error names the row.
    expect(() => evaluateColorSchemeCalibration(audit, auditHash(audit), tampered as never, okSubmission(tampered, sha), { packetSha256: sha }))
      .toThrow(/row does not match audit for/);
  });

  it("refuses a submission bound to a different packet", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 4);
    const sha = artifactHash(packet);
    expect(() => evaluateColorSchemeCalibration(audit, auditHash(audit), packet, okSubmission(packet, sha, { packetArtifactId: "elsewhere" }), { packetSha256: sha }))
      .toThrow(/different calibration packet/);
  });

  it("refuses a submission carrying a stale packet hash", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 4);
    const sha = artifactHash(packet);
    expect(() => evaluateColorSchemeCalibration(audit, auditHash(audit), packet, okSubmission(packet, hash("6")), { packetSha256: sha }))
      .toThrow(/submission packet hash does not match/);
  });

  it("refuses gate thresholds outside their valid range", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 4);
    const sha = artifactHash(packet);
    const sub = okSubmission(packet, sha);
    expect(() => evaluateColorSchemeCalibration(audit, auditHash(audit), packet, sub, { packetSha256: sha, minimumScoredLabels: 0 }))
      .toThrow(/minimumScoredLabels must be a positive integer/);
    expect(() => evaluateColorSchemeCalibration(audit, auditHash(audit), packet, sub, { packetSha256: sha, minimumAccuracy: 1.5 }))
      .toThrow(/minimumAccuracy must be between 0 and 1/);
  });

  it("refuses an abstain label with no reason, and a note on a decided label", () => {
    const base = { entryId: "one", imageSha256: hash("b") };
    expect(ColorSchemeCalibrationSubmissionSchema.safeParse({
      schemaVersion: "1.0", artifactType: "color-scheme-calibration-submission", artifactId: "s", packetArtifactId: "p",
      packetSha256: hash("c"), reviewerId: "r", sealedAt: "2026-08-10T10:00:00.000Z",
      labels: [{ ...base, value: "abstain" }],
    }).success).toBe(false);
    expect(ColorSchemeCalibrationSubmissionSchema.safeParse({
      schemaVersion: "1.0", artifactType: "color-scheme-calibration-submission", artifactId: "s", packetArtifactId: "p",
      packetSha256: hash("c"), reviewerId: "r", sealedAt: "2026-08-10T10:00:00.000Z",
      labels: [{ ...base, value: "light", note: "not allowed here" }],
    }).success).toBe(false);
  });

  it("refuses a packet whose detector constants drift from the compiled detector", async () => {
    const audit = await auditFixture();
    const packet = buildColorSchemeCalibrationPacket(audit, auditHash(audit), 4);
    for (const drift of [{ threshold: 99 }, { margin: 99 }, { maxDimension: 99 }]) {
      expect(ColorSchemeCalibrationPacketSchema.safeParse({ ...packet, detector: { ...packet.detector, ...drift } }).success).toBe(false);
    }
  });
});
