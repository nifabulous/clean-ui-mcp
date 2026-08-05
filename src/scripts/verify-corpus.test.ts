import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tierForField, verifyMechanicalFields, type VerificationRecord, type VerifierTier } from "./verify-corpus.js";
import { buildVerifyPrompt, parseVerifyResponse, decideFieldVerdict } from "./verify-corpus.js";
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

describe("buildVerifyPrompt — adversarial positive affirmation, per class", () => {
  it("asks the model to CONFIRM factual claims with a default of false", () => {
    const e = entry({
      visual: {
        ...entry().visual,
        colorRoles: { canvas: "#ffffff", surface: "#f8fafc", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
        usesShadows: false,
      },
    });
    const prompt = buildVerifyPrompt(e, ["visual.colorRoles", "visual.usesShadows"], "verifier-v1");
    expect(prompt).toContain("confirm");
    expect(prompt).toContain("default false");
    expect(prompt).toContain("canvas #ffffff");
    expect(prompt).toContain("no shadows");
    expect(prompt).toContain("verifier-v1");
  });

  it("asks prose fields to enumerate checkable assertions and confirm EACH, empty list is not confirmed", () => {
    const e = entry({ critique: "The left navigation rail groups the metrics by row." });
    const prompt = buildVerifyPrompt(e, ["critique"], "verifier-v1");
    expect(prompt).toContain("enumerate");
    expect(prompt).toContain("left navigation rail");
    expect(prompt).toContain('"assertions": []');
    expect(prompt).toContain('"confirmed": false');
  });

  it("never asks about responsiveBehavior — it has no verifiable claim", () => {
    const e = entry({ responsiveBehavior: "responsive" });
    const prompt = buildVerifyPrompt(e, ["responsiveBehavior"], "verifier-v1");
    expect(prompt).not.toContain("responsiveBehavior");
  });
});

describe("parseVerifyResponse — fail-closed", () => {
  it("parses per-field confirmations", () => {
    const parsed = parseVerifyResponse(
      JSON.stringify({
        "visual.usesShadows": { confirmed: true },
        critique: { confirmed: true, assertions: ["a left navigation rail exists"] },
      }),
    );
    expect(parsed["visual.usesShadows"]?.confirmed).toBe(true);
    expect(parsed.critique?.assertions).toEqual(["a left navigation rail exists"]);
  });

  it("treats a field ABSENT from the response as not confirmed", () => {
    const parsed = parseVerifyResponse(JSON.stringify({ "visual.usesShadows": { confirmed: true } }));
    expect(parsed["visual.colorRoles"]?.confirmed).toBe(false);
  });

  it("returns all-false for unparseable or non-JSON output", () => {
    const parsed = parseVerifyResponse("the model rambled");
    expect(parsed["visual.colorRoles"]?.confirmed).toBe(false);
  });
});

describe("decideFieldVerdict", () => {
  it("passes a confirmed factual claim", () => {
    const v = decideFieldVerdict("visual.usesShadows", "factual", { confirmed: true });
    expect(v.verdict).toBe("pass");
  });

  it("fails an unconfirmed claim", () => {
    const v = decideFieldVerdict("visual.usesShadows", "factual", { confirmed: false });
    expect(v.verdict).toBe("fail");
  });

  it("GATES a prose field whose assertion list is empty — the vacuity fix", () => {
    const v = decideFieldVerdict("critique", "prose", { confirmed: false, assertions: [] });
    expect(v.verdict).toBe("gate");
  });

  it("passes a prose field whose assertions were all confirmed", () => {
    const v = decideFieldVerdict("critique", "prose", { confirmed: true, assertions: ["a left navigation rail exists"] });
    expect(v.verdict).toBe("pass");
  });

  it("gates a gated-tier field (responsiveBehavior) whatever the response says", () => {
    const v = decideFieldVerdict("responsiveBehavior", "gated", { confirmed: true });
    expect(v.verdict).toBe("gate");
  });
});
