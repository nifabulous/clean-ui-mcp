import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tierForField, verifyMechanicalFields, type VerificationRecord, type VerifierTier } from "./verify-corpus.js";
import { extractQuantizedColors, type TaggerOutput } from "../tagger.js";
import type { CorpusEntryT } from "../schema.js";

// A real 32x32 PNG with four solid color quadrants (white / near-black / blue /
// red) so extractQuantizedColors returns a NON-EMPTY palette. A 1x1 PNG yields
// an empty Vibrant palette, which makes the dominantColors pass-direction test
// unsatisfiable — the recorded colors must be derived FROM the extractor (below),
// because Vibrant quantizes (e.g. #2563eb -> #2464ec), so hard-coding the input
// colors would not match the output.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAPklEQVR4nO3OMREAIAwAMSxUBDWGbRwgoojo0CV/93tWNYuI1gsAAAAAAABgHLDPq843szUAAAAAAADAOOADax/HiLLmZmkAAAAASUVORK5CYII=",
  "base64",
);

function entry(over: Partial<CorpusEntryT> = {}): CorpusEntryT {
  return {
    id: "e1",
    image: { visibility: "private", path: "images-private/e1.png", width: 390, height: 844 },
    visual: { dominantColors: ["#ffffff", "#111111"], accentColor: null, typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true },
    ...over,
  } as unknown as CorpusEntryT;
}

describe("tierForField — the spec's classification table", () => {
  it("classifies every SERVABLE_FIELD_KEYS key into exactly one tier", () => {
    const expected: Record<string, VerifierTier> = {
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
    for (const [field, tier] of Object.entries(expected)) {
      expect(tierForField(field), field).toBe(tier);
    }
  });
});

describe("verifyMechanicalFields — re-derivable values, evidence-appropriate tiers", () => {
  it("writes a provable platform record (no hash) and an image-confirmed dominantColors record (with hash) when both match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-mech-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      // Derive the recorded colors FROM the extractor so the SET match holds
      // regardless of how Vibrant quantizes this build's pixels. The palette
      // must be non-empty or the pass direction is untestable (guards the PNG).
      const extracted = await extractQuantizedColors(imagePath);
      expect(extracted.length, "fixture PNG must yield a non-empty Vibrant palette").toBeGreaterThan(0);
      const e = entry({
        platform: "mobile", // detectPlatform(390, 844) === "mobile"
        visual: { dominantColors: [extracted[0]], accentColor: null, typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true },
      });
      const { records, verdicts } = await verifyMechanicalFields(e, imagePath);

      // platform: recomputed from recorded dimensions (DATA) — provable, no hash.
      const platform = records.platform;
      expect(platform, "platform").toBeDefined();
      expect(platform!.method).toBe("provable");
      expect(platform!.imageSha256).toBeUndefined();
      expect(platform!.verifierVersion).toMatch(/^verifier-v\d+$/);

      // dominantColors: read from PIXELS — image-confirmed, bound to the hash.
      const colors = records["visual.dominantColors"];
      expect(colors, "visual.dominantColors").toBeDefined();
      expect(colors!.method).toBe("image-confirmed");
      expect(colors!.imageSha256).toMatch(/^[0-9a-f]{64}$/);

      expect(verdicts.map((v) => v.field).sort()).toEqual(["platform", "visual.dominantColors"]);
      expect(verdicts.every((v) => v.verdict === "pass")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails platform when the recorded value disagrees with the image dimensions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-mech-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      const e = entry({ platform: "web" }); // 390x844 is mobile
      const { records, verdicts } = await verifyMechanicalFields(e, imagePath);
      expect(records.platform).toBeUndefined();
      expect(verdicts.find((v) => v.field === "platform")?.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails platform when image dimensions are missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-mech-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      // width/height deliberately omitted to exercise the missing-dimensions
      // path; cast because ImageRef requires the keys (schema.ts:355).
      const e = entry({ platform: "mobile", image: { visibility: "private", path: "images-private/e1.png" } as CorpusEntryT["image"] });
      const { records, verdicts } = await verifyMechanicalFields(e, imagePath);
      expect(records.platform).toBeUndefined();
      expect(verdicts.find((v) => v.field === "platform")?.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails dominantColors when a recorded color is absent from the extracted set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-mech-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      const e = entry({
        visual: { dominantColors: ["#123456", "#111111"], accentColor: null, typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true },
      });
      const { records, verdicts } = await verifyMechanicalFields(e, imagePath);
      expect(records["visual.dominantColors"]).toBeUndefined();
      expect(verdicts.find((v) => v.field === "visual.dominantColors")?.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never writes a record for responsiveBehavior — it stays gated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-mech-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      const e = entry({ responsiveBehavior: "responsive" });
      const { records } = await verifyMechanicalFields(e, imagePath);
      expect(records.responsiveBehavior).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
