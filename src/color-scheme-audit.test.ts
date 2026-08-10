import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { buildColorSchemeAuditReport, validateColorSchemeAuditReport } from "./color-scheme-audit.js";
import { COLOR_SCHEME_MARGIN, COLOR_SCHEME_MAX_DIMENSION, COLOR_SCHEME_THRESHOLD } from "./color-scheme.js";

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("color scheme audit", () => {
  it("reports deterministic proposals, conflicts, abstentions, and missing images without mutating entries", async () => {
    const report = await buildColorSchemeAuditReport({
      corpusSha256: "a".repeat(64),
      entries: [
        { entryId: "new-light", imagePath: "images/new-light.png", imageSha256: "b".repeat(64), existingColorScheme: null },
        { entryId: "matching-dark", imagePath: "images/matching-dark.png", imageSha256: "c".repeat(64), existingColorScheme: "dark" },
        { entryId: "conflict", imagePath: "images/conflict.png", imageSha256: "d".repeat(64), existingColorScheme: "light" },
        { entryId: "ambiguous", imagePath: "images/ambiguous.png", imageSha256: "e".repeat(64), existingColorScheme: null },
        { entryId: "missing", imagePath: null, imageSha256: null, existingColorScheme: null },
      ],
      detect: async (imagePath) => ({
        colorScheme: imagePath.includes("new-light") ? "light" : imagePath.includes("matching-dark") ? "dark" : imagePath.includes("conflict") ? "dark" : null,
        medianLuma: imagePath.includes("matching-dark") ? 20 : imagePath.includes("conflict") ? 20 : 128,
        threshold: 110,
        margin: 12,
      }),
    });

    expect(report.artifactType).toBe("deterministic-color-scheme-audit");
    expect(report.summary).toEqual({ entries: 5, proposed: 1, unchanged: 1, conflicts: 1, abstained: 1, missingImages: 1, errors: 0 });
    expect(report.entries.map((entry) => entry.status)).toEqual(["propose", "unchanged", "conflict", "abstain", "missing-image"]);
    expect(report.entries[0]?.existingColorScheme).toBeNull();
    expect(report.entries[0]?.detectedColorScheme).toBe("light");
  });

  it("records detector failures as auditable errors", async () => {
    const report = await buildColorSchemeAuditReport({
      corpusSha256: "a".repeat(64),
      entries: [{ entryId: "broken", imagePath: "broken.png", imageSha256: "b".repeat(64), existingColorScheme: null }],
      detect: async () => { throw new Error("decode failed"); },
    });
    expect(report.summary.errors).toBe(1);
    expect(report.entries[0]).toMatchObject({ status: "error", error: "decode failed" });
  });

  it("binds the detector result to the same loaded bytes as the image hash", async () => {
    const bytes = Uint8Array.from([1, 2, 3, 4]);
    const report = await buildColorSchemeAuditReport({
      corpusSha256: "a".repeat(64),
      entries: [{ entryId: "same-bytes", imagePath: "images/same.png", imageSha256: null, existingColorScheme: null, loadImage: () => bytes }],
      detect: async (_path, detectedBytes) => {
        expect(detectedBytes).toBe(bytes);
        return { colorScheme: "light", medianLuma: 220, threshold: 110, margin: 12 };
      },
    });
    expect(report.entries[0]).toMatchObject({ status: "propose", imageSha256: hash(bytes) });
  });

  it("classifies a missing raster separately from a decoder error", async () => {
    const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
    const report = await buildColorSchemeAuditReport({
      corpusSha256: "a".repeat(64),
      entries: [{ entryId: "missing-file", imagePath: "images/missing.png", imageSha256: null, existingColorScheme: null, loadImage: () => { throw missing; } }],
      detect: async () => ({ colorScheme: "light", medianLuma: 220, threshold: 110, margin: 12 }),
    });
    expect(report.entries[0]).toMatchObject({ status: "missing-image", imageSha256: null });
    expect(report.summary).toMatchObject({ missingImages: 1, errors: 0 });
  });

  it("preserves input order when concurrent detections finish out of order", async () => {
    const report = await buildColorSchemeAuditReport({
      corpusSha256: "a".repeat(64),
      concurrency: 2,
      entries: [
        { entryId: "first", imagePath: "first.png", imageSha256: "1".repeat(64), existingColorScheme: null },
        { entryId: "second", imagePath: "second.png", imageSha256: "2".repeat(64), existingColorScheme: null },
        { entryId: "third", imagePath: "third.png", imageSha256: "3".repeat(64), existingColorScheme: null },
      ],
      detect: async (path) => {
        await new Promise((resolve) => setTimeout(resolve, path === "first.png" ? 20 : 1));
        return { colorScheme: "light", medianLuma: 220, threshold: 110, margin: 12 };
      },
    });
    expect(report.entries.map((entry) => entry.entryId)).toEqual(["first", "second", "third"]);
  });

  it("normalizes non-Error detector failures and empty input", async () => {
    const broken = await buildColorSchemeAuditReport({
      corpusSha256: "a".repeat(64),
      entries: [{ entryId: "broken", imagePath: "broken.png", imageSha256: "b".repeat(64), existingColorScheme: null }],
      detect: async () => { throw "decode failed"; },
    });
    const empty = await buildColorSchemeAuditReport({ corpusSha256: "a".repeat(64), entries: [], detect: async () => ({ colorScheme: null, medianLuma: 0, threshold: 110, margin: 12 }) });
    expect(broken.entries[0]).toMatchObject({ status: "error", error: "decode failed" });
    expect(empty.summary).toEqual({ entries: 0, proposed: 0, unchanged: 0, conflicts: 0, abstained: 0, missingImages: 0, errors: 0 });
  });

  it("rejects duplicate report IDs and summary drift at the runtime boundary", async () => {
    const report = await buildColorSchemeAuditReport({
      corpusSha256: "a".repeat(64),
      entries: [{ entryId: "one", imagePath: "one.png", imageSha256: "b".repeat(64), existingColorScheme: null }],
      detect: async () => ({ colorScheme: "light", medianLuma: 220, threshold: 110, margin: 12 }),
    });
    expect(() => validateColorSchemeAuditReport({
      ...report,
      entries: [report.entries[0], report.entries[0]],
      summary: { ...report.summary, entries: 2, proposed: 2 },
    })).toThrow(/unique/);
    expect(() => validateColorSchemeAuditReport({
      ...report,
      entries: [{ ...report.entries[0], imageSha256: null }],
    })).toThrow(/image SHA-256/);
    expect(report.detector).toMatchObject({ algorithmVersion: "color-scheme-v1", maxDimension: 256 });
  });

  it("rejects semantically contradictory statuses and detector provenance", async () => {
    const report = await buildColorSchemeAuditReport({
      corpusSha256: "a".repeat(64),
      entries: [{ entryId: "one", imagePath: "one.png", imageSha256: "b".repeat(64), existingColorScheme: null }],
      detect: async () => ({ colorScheme: "light", medianLuma: 220, threshold: COLOR_SCHEME_THRESHOLD, margin: COLOR_SCHEME_MARGIN }),
    });
    const cases = [
      { name: "abstain with a detection", value: { ...report, entries: [{ ...report.entries[0], status: "abstain" as const }] }, message: /abstain rows cannot contain a detected color scheme/ },
      { name: "propose without a detection", value: { ...report, entries: [{ ...report.entries[0], detectedColorScheme: null }] }, message: /propose rows require a detected color scheme/ },
      { name: "unchanged without an existing value", value: { ...report, entries: [{ ...report.entries[0], status: "unchanged" as const }] }, message: /unchanged rows require existingColorScheme/ },
      { name: "conflict without a disagreement", value: { ...report, entries: [{ ...report.entries[0], status: "conflict" as const, existingColorScheme: "light" }] }, message: /conflict rows require different/ },
      { name: "error without an error payload", value: { ...report, entries: [{ ...report.entries[0], status: "error" as const }] }, message: /error rows require an error message/ },
      { name: "detector threshold drift", value: { ...report, detector: { ...report.detector, threshold: 9999 } }, message: /detector\.threshold/ },
      { name: "detector margin drift", value: { ...report, detector: { ...report.detector, margin: 0 } }, message: /detector\.margin/ },
      { name: "detector dimension drift", value: { ...report, detector: { ...report.detector, maxDimension: 64 } }, message: /detector\.maxDimension/ },
      { name: "row threshold drift", value: { ...report, entries: [{ ...report.entries[0], threshold: 9999 }] }, message: /threshold must match detector/ },
    ];
    for (const testCase of cases) {
      const entries = testCase.value.entries;
      const count = (status: string) => entries.filter((entry) => entry.status === status).length;
      const value = {
        ...testCase.value,
        summary: {
          entries: entries.length,
          proposed: count("propose"),
          unchanged: count("unchanged"),
          conflicts: count("conflict"),
          abstained: count("abstain"),
          missingImages: count("missing-image"),
          errors: count("error"),
        },
      };
      expect(() => validateColorSchemeAuditReport(value), testCase.name).toThrow(testCase.message);
    }
    expect(COLOR_SCHEME_MAX_DIMENSION).toBe(report.detector.maxDimension);
  });
});
