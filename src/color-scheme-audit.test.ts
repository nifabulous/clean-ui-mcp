import { describe, expect, it } from "vitest";
import { buildColorSchemeAuditReport } from "./color-scheme-audit.js";

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
});
