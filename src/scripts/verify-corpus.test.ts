import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tierForField, verifyMechanicalFields, type VerificationRecord, type VerifierTier } from "./verify-corpus.js";
import { buildVerifyPrompt, parseVerifyResponse, decideFieldVerdict } from "./verify-corpus.js";
import { verifyEntry, mergeVerification, alreadyProcessedAtVersion, applyReproducedProse } from "./verify-corpus.js";
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

describe("alreadyProcessedAtVersion — the resume key (pass OR attempt)", () => {
  it("skips a field carrying the current version in EITHER verification or verifyAttempts", () => {
    const e = entry({
      provenance: {
        taggedBy: "auto",
        verification: { critique: { method: "image-confirmed", verifiedAt: "2026-08-05", verifierVersion: "verifier-v1", imageSha256: "a".repeat(64) } },
        verifyAttempts: { layout: { verifierVersion: "verifier-v1", verifiedAt: "2026-08-05" } },
      },
    });
    expect(alreadyProcessedAtVersion(e, "critique", "verifier-v1")).toBe(true);  // a pass
    expect(alreadyProcessedAtVersion(e, "layout", "verifier-v1")).toBe(true);    // a recorded failure
    expect(alreadyProcessedAtVersion(e, "critique", "verifier-v2")).toBe(false);
    expect(alreadyProcessedAtVersion(e, "voice", "verifier-v1")).toBe(false);
  });
});

describe("applyReproducedProse — strip [DRAFT] markers, preserve antiPatterns siblings", () => {
  it("stores clean prose and never clobbers accessibilityRisks / whereThisFails", () => {
    const original = entry({
      antiPatterns: {
        antiPatterns: ["old prose"],
        whereThisFails: ["small screens"],
        accessibilityRisks: [{ element: "cta", risk: "low contrast", evidence: "text on bg", wcag: ["1.4.3"] }],
      },
    });
    const tagged = {
      critique: "[DRAFT — REWRITE] A grounded critique.",
      whatToSteal: ["[DRAFT] Quiet grouping."],
      antiPatterns: { antiPatterns: ["[DRAFT] Avoids shadows."], whereThisFails: [], accessibilityRisks: [] },
      voice: { tone: "confident", examples: ["Ship it."], avoid: ["synergy"] },
    } as unknown as Pick<TaggerOutput, "critique" | "whatToSteal" | "antiPatterns" | "voice">;
    const out = applyReproducedProse(original, tagged) as unknown as {
      critique: string; whatToSteal: string[];
      antiPatterns: { antiPatterns: string[]; whereThisFails: string[]; accessibilityRisks: unknown[] };
    };
    expect(out.critique).toBe("A grounded critique.");           // marker stripped
    expect(out.whatToSteal).toEqual(["Quiet grouping."]);        // marker stripped
    expect(out.antiPatterns.antiPatterns).toEqual(["Avoids shadows."]);
    expect(out.antiPatterns.whereThisFails).toEqual(["small screens"]);       // PRESERVED from original
    expect(out.antiPatterns.accessibilityRisks).toHaveLength(1);              // NOT clobbered
  });
});

describe("mergeVerification — merge, never clobber", () => {
  it("writes new keys and leaves existing ones untouched", () => {
    const e = entry({
      provenance: {
        taggedBy: "auto",
        verification: { critique: { method: "image-confirmed", verifiedAt: "old", verifierVersion: "verifier-v0", imageSha256: "a".repeat(64) } },
      },
    });
    mergeVerification(e, {
      platform: { method: "image-confirmed", verifiedAt: "new", verifierVersion: "verifier-v1", imageSha256: "b".repeat(64) },
    });
    const v = (e as unknown as { provenance: { verification: Record<string, unknown> } }).provenance.verification;
    expect(v.platform).toBeDefined();
    expect((v.critique as { verifierVersion: string }).verifierVersion).toBe("verifier-v0");
  });
});

describe("verifyEntry — mechanical + vision + re-produce + re-verify", () => {
  it("merges mechanical records and vision verdicts; re-produces failed prose and re-verifies", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-entry-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      const e = entry({
        platform: "mobile",
        critique: "The left navigation rail groups the metrics by row.",
        whatToSteal: ["Group metrics by row."],
        provenance: { taggedBy: "auto" },
      });
      let critiqueCalls = 0;
      const deps = {
        now: () => "2026-08-05",
        // Vision: the FIRST critique prompt fails (the rail is a fabrication);
        // re-production fixes the prose; the SECOND critique prompt (the fresh
        // re-verify) confirms the fixed version.
        callVision: async (prompt: string) => {
          const wantsCritique = prompt.includes("critique:");
          if (wantsCritique) {
            critiqueCalls += 1;
            return critiqueCalls === 1
              ? JSON.stringify({ critique: { confirmed: false, assertions: ["a left navigation rail exists"], reason: "no rail visible" } })
              : JSON.stringify({ critique: { confirmed: true, assertions: ["metrics grouped in a single column card"] } });
          }
          return JSON.stringify({ "visual.usesBorders": { confirmed: true } });
        },
        reproduce: async () => ({ ...e, critique: "The metrics are grouped in a single column card." }),
      };
      const { records, verdicts } = await verifyEntry(e, imagePath, deps);
      expect(records.platform).toBeDefined();
      expect(records.critique).toBeDefined();
      expect(verdicts.find((v) => v.field === "critique")?.verdict).toBe("pass");
      expect(verdicts.find((v) => v.field === "whatToSteal")?.verdict).toBe("gate");
      expect(records["responsiveBehavior"]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves a field gated (no record) when re-production fails re-verification", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-entry-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      const e = entry({ critique: "The left navigation rail groups the metrics by row.", provenance: { taggedBy: "auto" } });
      const deps = {
        now: () => "2026-08-05",
        callVision: async () => JSON.stringify({ critique: { confirmed: false, assertions: ["a left navigation rail exists"] } }),
        reproduce: async () => ({ ...e, critique: "Still claims the rail." }),
      };
      const { records, verdicts } = await verifyEntry(e, imagePath, deps);
      expect(records.critique).toBeUndefined();
      expect(verdicts.find((v) => v.field === "critique")?.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("re-produces ONCE for N failing prose fields — not once per field (pins the hoist)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-entry-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      const e = entry({
        platform: "mobile",
        critique: "The left navigation rail groups the metrics by row.",
        voice: { tone: "confident", examples: ["Ship it."], avoid: ["synergy"] },
        provenance: { taggedBy: "auto" },
      });
      let reproduceCalls = 0, visionCalls = 0;
      const deps = {
        now: () => "2026-08-05",
        callVision: async (_prompt: string) => {
          visionCalls += 1;
          // Call 1 = the ONE combined verify (critique + voice both fail, non-empty
          // assertions). Call 2 = the ONE batched re-verify (both pass).
          return visionCalls === 1
            ? JSON.stringify({
                critique: { confirmed: false, assertions: ["a rail exists"] },
                voice: { confirmed: false, assertions: ["tone is confident"] },
              })
            : JSON.stringify({
                critique: { confirmed: true, assertions: ["single-column card"] },
                voice: { confirmed: true, assertions: ["tone reads confident"] },
              });
        },
        reproduce: async () => {
          reproduceCalls += 1;
          return {
            ...e,
            critique: "Metrics in one column.",
            voice: { tone: "confident", examples: ["x"], avoid: [] },
          } as CorpusEntryT;
        },
      };
      const { verdicts } = await verifyEntry(e, imagePath, deps);
      expect(reproduceCalls).toBe(1);  // ONE re-produce for N failing prose fields
      expect(visionCalls).toBe(2);     // ONE combined verify + ONE batched re-verify, never 1 + N
      expect(verdicts.find((v) => v.field === "critique")?.verdict).toBe("pass");
      expect(verdicts.find((v) => v.field === "voice")?.verdict).toBe("pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does NOT re-produce a failing FACTUAL field — only prose is re-produced", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-entry-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      // usesShadows is a factual field with a value; it fails vision and must
      // stay gated with NO record and NO re-produce (the tagger's Pass 2 does
      // not write factual fields).
      const e = entry({ platform: "mobile", provenance: { taggedBy: "auto" } }); // base visual.usesShadows=false → claim "no shadows are used"
      let reproduceCalls = 0;
      const deps = {
        now: () => "2026-08-05",
        callVision: async () => JSON.stringify({ "visual.usesShadows": { confirmed: false } }),
        reproduce: async () => { reproduceCalls += 1; return e; },
      };
      const { records, verdicts } = await verifyEntry(e, imagePath, deps);
      expect(reproduceCalls).toBe(0);
      expect(records["visual.usesShadows"]).toBeUndefined();
      expect(verdicts.find((v) => v.field === "visual.usesShadows")?.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips fields already carrying the current verifierVersion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-entry-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      // Every servable field already carries a current-version record, so the
      // pending set is empty and the vision dependency must never be called.
      const record = { method: "image-confirmed", verifiedAt: "2026-08-01", verifierVersion: "verifier-v1", imageSha256: "a".repeat(64) };
      const verification: Record<string, typeof record> = {};
      for (const field of ["platform", "visual.dominantColors", "visual.colorRoles", "visual.accentColor",
        "layout", "components", "visual.usesShadows", "visual.usesBorders", "visual.typePairing",
        "antiPatterns.accessibilityRisks", "critique", "whatToSteal", "antiPatterns", "voice",
        "mood", "colorScheme", "visual.spacingDensity", "visual.cornerStyle", "styleTags",
        "categories", "domainTags", "patternType"]) {
        verification[field] = record;
      }
      const e = entry({ provenance: { taggedBy: "auto", verification } });
      const callVision = async () => { throw new Error("vision must not run for skipped fields"); };
      const { verdicts } = await verifyEntry(e, imagePath, { now: () => "2026-08-05", callVision, reproduce: async () => e });
      expect(verdicts.filter((v) => v.field !== "platform" && v.field !== "visual.dominantColors")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
