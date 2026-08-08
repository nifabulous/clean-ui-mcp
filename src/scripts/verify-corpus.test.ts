import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tierForField, type VerifierTier } from "./verify-corpus.js";
import { buildVerifyPrompt, parseVerifyResponse, decideFieldVerdict } from "./verify-corpus.js";
import { verifyEntry, mergeVerification, alreadyProcessedAtVersion, applyReproducedProse, VERIFIER_VERSION } from "./verify-corpus.js";
import { buildRunReport, selectPending, resumeMarkers, mergeVerifyAttempts, buildEstimate } from "./verify-corpus.js";
import { mergeDataQuality, retriageDataQuality, dismissDataQuality, renderSuspectReport } from "./verify-corpus.js";
import { withTimeout, reproduceCritiqueModel } from "./verify-corpus.js";
import { resolveConfiguredVisionProvider } from "./verify-corpus.js";
import type { TaggerOutput } from "../tagger.js";
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
      "visual.accentColor": "mechanical",
      layout: "factual",
      components: "factual",
      "visual.usesShadows": "mechanical",
      "visual.usesBorders": "mechanical",
      "visual.typePairing": "factual",
      "antiPatterns.accessibilityRisks": "a11y",
      critique: "prose",
      whatToSteal: "prose",
      antiPatterns: "prose",
      voice: "prose",
      mood: "soft",
      colorScheme: "soft",
      "visual.spacingDensity": "mechanical",
      "visual.cornerStyle": "mechanical",
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
    expect(prompt).toContain('otherwise "abstain"');   // the three-way contract
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

  it("abstains an unconfirmed claim that the image does not contradict", () => {
    const v = decideFieldVerdict("visual.usesShadows", "factual", { confirmed: false });
    expect(v.verdict).toBe("abstain");
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
      expect(verdicts.find((v) => v.field === "critique")?.verdict).toBe("abstain");
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
      expect(verdicts.find((v) => v.field === "visual.usesShadows")?.verdict).toBe("abstain");
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
      // pending set is empty and the vision dependency must never be called
      // (callVision above throws if it is).
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
      // The vision lane must stay silent for a fully-processed entry. Detector
      // verdicts may still be emitted (the registry runs unconditionally), but
      // nothing may carry a MODEL verdict — `source` is omitted for vision.
      expect(verdicts.filter((v) => v.source !== "detector")).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("three-way model verdicts", () => {
  function entryWithImage(over: Partial<CorpusEntryT> = {}): CorpusEntryT {
    return entry({
      provenance: { taggedBy: "auto" },
      // layout must carry a claim (claimForField returns null for a bare entry,
      // which gates the field before the model verdict can exist).
      layout: { form: "single-column", regions: [{ role: "sidebar" }] },
      ...over,
    });
  }

  it("parses the verdict field and fails closed on absence", () => {
    const parsed = parseVerifyResponse(
      '{"visual.accentColor":{"verdict":"confirmed"},"layout":{"verdict":"contradicted"},"mood":{"verdict":"abstain"}}',
    );
    expect(parsed["visual.accentColor"].confirmed).toBe(true);
    expect(parsed["visual.accentColor"].contradicted).toBe(false);
    expect(parsed.layout.contradicted).toBe(true);
    expect(parsed.mood.confirmed).toBe(false);
    expect(parsed.mood.contradicted).toBe(false);
    expect(parsed.critique.confirmed).toBe(false); // absent -> fail closed
  });

  it("keeps the legacy confirmed-boolean shape working", () => {
    const parsed = parseVerifyResponse('{"layout":{"confirmed":true}}');
    expect(parsed.layout.confirmed).toBe(true);
  });

  it("decides pass / contradicted / abstain / gate", () => {
    expect(decideFieldVerdict("layout", "factual", { confirmed: true, contradicted: false }).verdict).toBe("pass");
    expect(decideFieldVerdict("layout", "factual", { confirmed: false, contradicted: true }).verdict).toBe("contradicted");
    expect(decideFieldVerdict("layout", "factual", { confirmed: false, contradicted: false }).verdict).toBe("abstain");
    expect(decideFieldVerdict("responsiveBehavior", "gated", { confirmed: true, contradicted: false }).verdict).toBe("gate");
  });

  it("keeps the vacuity guard for prose fields", () => {
    const r = decideFieldVerdict("critique", "prose", { confirmed: false, contradicted: false, assertions: [] });
    expect(r.verdict).toBe("gate");
  });

  it("a model that disagrees with itself grants NOTHING — no trust record and no finding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-threeway-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      const calls: string[] = [];
      // critique carries a value, so the prose re-produce/re-verify lane can fire
      // too — the assertion counts ONLY the layout asks, so it stays correct
      // however many calls the prose lane makes.
      const e = entryWithImage({ critique: "The metrics are grouped in a single column card." });
      const out = await verifyEntry(e, imagePath, {
        now: () => "2026-08-07",
        callVision: async (prompt) => {
          calls.push(prompt);
          return calls.length === 1
            ? '{"layout":{"verdict":"contradicted"}}'
            : '{"layout":{"verdict":"confirmed"}}';
        },
        reproduce: async (x) => x,
      });
      // The two asks split. Corroboration exists because these verdicts flip
      // 14-18% between identical runs, so a split is the instability itself — it
      // must grant neither trust nor a finding.
      const layoutAsks = calls.filter((p) => p.includes("layout")).length;
      expect(layoutAsks, "initial ask + one corroborating re-ask").toBe(2);
      expect(out.records.layout, "a disagreement must not grant trust").toBeUndefined();
      expect(out.dataQuality.layout, "an uncorroborated accusation is not a finding").toBeUndefined();
      expect(out.verdicts.find((v) => v.field === "layout")?.verdict).toBe("abstain");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes dataQuality only for a corroborated contradiction", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-threeway-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      const calls: string[] = [];
      const e = entryWithImage({ critique: "The metrics are grouped in a single column card." });
      const out = await verifyEntry(e, imagePath, {
        now: () => "2026-08-07",
        callVision: async (prompt) => {
          calls.push(prompt);
          return '{"layout":{"verdict":"contradicted"}}';
        },
        reproduce: async (x) => x,
      });
      // Both asks said contradicted, so the contradiction is corroborated.
      expect(calls.filter((p) => p.includes("layout")).length).toBe(2);
      expect(out.dataQuality.layout).toBeDefined();
      expect(out.dataQuality.layout.source).toBe("vision");
      expect(out.dataQuality.layout.imageSha256).toBeDefined(); // the model judged these exact pixels
      expect(out.records.layout).toBeUndefined();
      expect(out.verdicts.filter((v) => v.field === "layout")).toHaveLength(1); // exactly one verdict per field
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a contradicted mechanical field converges with --detectors off, as a legacy fail", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-threeway-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      // platform runs regardless of the flag, so its contradiction must land in
      // SOME map or selectPending requeues the entry forever. Under the flag it
      // takes the LEGACY route — `fail` + resume marker — because the flag's
      // contract is no detector-side dataQuality, and Task 20's A/B comparison
      // needs flag-off to be a genuine baseline rather than a hybrid.
      const e = entryWithImage({ platform: "mobile" });
      e.image = { visibility: "private", path: "images-private/x.png", width: 1440, height: 900 }; // web vs recorded mobile
      const out = await verifyEntry(e, imagePath, {
        now: () => "2026-08-07",
        callVision: async () => "{}",
        reproduce: async (x) => x,
        detectors: false,
      });
      expect(out.dataQuality.platform, "the flag's contract is no detector-side dataQuality").toBeUndefined();
      expect(out.verdicts.find((v) => v.field === "platform")?.verdict).toBe("fail");
      // The marker is what actually stops the requeue loop.
      expect(resumeMarkers(out.verdicts, "2026-08-07", VERIFIER_VERSION).platform).toBeDefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the same contradiction becomes a dataQuality finding with detectors ON", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-threeway-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      const e = entryWithImage({ platform: "mobile" });
      e.image = { visibility: "private", path: "images-private/x.png", width: 1440, height: 900 };
      const out = await verifyEntry(e, imagePath, {
        now: () => "2026-08-07",
        callVision: async () => "{}",
        reproduce: async (x) => x,
      });
      expect(out.dataQuality.platform).toBeDefined();
      // platform reads no pixels, so its finding carries no image hash.
      expect(out.dataQuality.platform.imageSha256).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unanswerable corroboration ask downgrades ONLY that field to abstain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-threeway-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      const calls: string[] = [];
      const e = entryWithImage({ layout: { form: "single-column", regions: [{ role: "sidebar" }] } });
      const out = await verifyEntry(e, imagePath, {
        now: () => "2026-08-07",
        callVision: async (prompt) => {
          calls.push(prompt);
          if (calls.length === 1) return '{"layout":{"verdict":"contradicted"}}';
          throw new Error("provider 500 on the corroborating ask");
        },
        reproduce: async (x) => x,
      });
      expect(calls.filter((p) => p.includes("layout")).length).toBe(2);
      expect(out.records.layout).toBeUndefined();
      expect(out.dataQuality.layout, "an unconfirmed accusation is not a finding").toBeUndefined();
      expect(out.verdicts.find((v) => v.field === "layout")?.verdict).toBe("abstain");
      expect(out.verdicts.filter((v) => v.field === "layout")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a prose value that still contradicts on the fresh ask is a finding", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-threeway-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      const calls: string[] = [];
      const e = entryWithImage({ critique: "The left navigation rail groups the metrics by row." });
      const out = await verifyEntry(e, imagePath, {
        now: () => "2026-08-07",
        callVision: async (prompt) => {
          calls.push(prompt);
          return JSON.stringify({ critique: { verdict: "contradicted", assertions: ["a left navigation rail exists"] } });
        },
        reproduce: async (x) => x,
      });
      // Pass 1 says contradicted -> prose lane -> the fresh ask on the
      // re-produced value STILL contradicts -> a finding, not a marker.
      expect(out.dataQuality.critique).toBeDefined();
      expect(out.dataQuality.critique.source).toBe("vision");
      expect(out.dataQuality.critique.imageSha256).toBeDefined();
      expect(out.records.critique).toBeUndefined();
      expect(out.verdicts.find((v) => v.field === "critique")?.verdict).toBe("contradicted");
      expect(out.verdicts.filter((v) => v.field === "critique")).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("record-map exclusivity", () => {
  it("a contradiction revokes trust and attempts for its field only", () => {
    const e = entry();
    mergeVerification(e, { layout: { method: "image-confirmed", verifiedAt: "x", verifierVersion: "v1" } });
    mergeVerifyAttempts(e, { mood: { verifierVersion: "v1", verifiedAt: "x" } });
    mergeDataQuality(e, { layout: { measured: null, recorded: "a", source: "layout", verifierVersion: "v1", verifiedAt: "x" } });
    expect(e.provenance?.verification?.layout).toBeUndefined();
    expect(e.provenance?.verifyAttempts?.mood).toBeDefined(); // untouched sibling
    expect(e.provenance?.dataQuality?.layout?.source).toBe("layout");
  });

  it("a pass revokes dataQuality for its field", () => {
    const e = entry();
    mergeDataQuality(e, { layout: { measured: null, recorded: "a", source: "vision", verifierVersion: "v1", verifiedAt: "x" } });
    mergeVerification(e, { layout: { method: "image-confirmed", verifiedAt: "x", verifierVersion: "v1" } });
    expect(e.provenance?.dataQuality?.layout).toBeUndefined();
  });

  it("an attempt marker revokes dataQuality for its field", () => {
    const e = entry();
    mergeDataQuality(e, { layout: { measured: null, recorded: "a", source: "vision", verifierVersion: "v1", verifiedAt: "x" } });
    mergeVerifyAttempts(e, { layout: { verifierVersion: "v1", verifiedAt: "x" } });
    expect(e.provenance?.dataQuality?.layout).toBeUndefined();
  });

  it("resume markers skip pass and contradicted", () => {
    const markers = resumeMarkers(
      [
        { field: "layout", verdict: "pass", reason: "" },
        { field: "mood", verdict: "contradicted", reason: "" },
        { field: "critique", verdict: "abstain", reason: "" },
      ],
      "2026-08-07",
      "verifier-v1",
    );
    expect(markers.layout).toBeUndefined();
    expect(markers.mood).toBeUndefined();
    expect(markers.critique).toBeDefined();
  });
});

describe("triage actions", () => {
  function entryWithFindings(): CorpusEntryT {
    const e = entry();
    mergeDataQuality(e, {
      layout: { measured: null, recorded: "a", source: "vision", verifierVersion: "verifier-v1", verifiedAt: "x" },
      mood: { measured: null, recorded: "b", source: "vision", verifierVersion: "verifier-v1", verifiedAt: "x" },
    });
    return e;
  }

  it("retriage deletes the named finding so the field is re-offered", () => {
    const e = entryWithFindings();
    retriageDataQuality(e, ["layout"]);
    expect(e.provenance?.dataQuality?.layout).toBeUndefined();
    expect(e.provenance?.dataQuality?.mood, "untargeted findings survive").toBeDefined();
    expect(alreadyProcessedAtVersion(e, "layout", "verifier-v1"), "re-offered").toBe(false);
  });

  it("retriage with no field clears every finding on the entry", () => {
    const e = entryWithFindings();
    retriageDataQuality(e, undefined);
    expect(Object.keys(e.provenance?.dataQuality ?? {})).toEqual([]);
  });

  it("dismiss KEEPS the record but stamps it, and the field stays processed", () => {
    const e = entryWithFindings();
    dismissDataQuality(e, "layout", "measurement artefact — antialiasing", "2026-08-07");
    // Dismissing is NOT deleting: the audit trail is the point.
    expect(e.provenance?.dataQuality?.layout).toBeDefined();
    expect(e.provenance?.dataQuality?.layout?.dismissed?.reason).toContain("antialiasing");
    expect(alreadyProcessedAtVersion(e, "layout", "verifier-v1"), "dismissed stays processed").toBe(true);
  });

  it("dismiss refuses a field with no finding, rather than inventing one", () => {
    const e = entry();
    expect(() => dismissDataQuality(e, "layout", "why", "2026-08-07")).toThrow(/no dataQuality finding/i);
  });

  it("the suspect report hides dismissed rows unless asked", () => {
    const e = entryWithFindings();
    dismissDataQuality(e, "layout", "artefact", "2026-08-07");
    expect(renderSuspectReport([e], { includeDismissed: false })).not.toContain("layout");
    expect(renderSuspectReport([e], { includeDismissed: true })).toContain("layout");
  });
});

describe("suspect report", () => {
  function makeEntryWithDataQuality(source: string, field: string): CorpusEntryT {
    const e = entry();
    mergeDataQuality(e, { [field]: { measured: null, recorded: "x", source, verifierVersion: "verifier-v1", verifiedAt: "2026-08-07" } });
    return e;
  }

  it("ranks detector contradictions above vision contradictions", () => {
    const vision = makeEntryWithDataQuality("vision", "mood");
    const detector = makeEntryWithDataQuality("detector", "visual.usesBorders");
    const report = renderSuspectReport([vision, detector]);
    const visionIdx = report.indexOf("mood");
    const detectorIdx = report.indexOf("visual.usesBorders");
    expect(detectorIdx).toBeGreaterThan(-1);
    expect(visionIdx).toBeGreaterThan(detectorIdx);
  });

  it("emits the fixed columns", () => {
    const report = renderSuspectReport([makeEntryWithDataQuality("vision", "layout")]);
    expect(report).toContain("| field |");
    expect(report).toContain("| measured |");
    expect(report).toContain("| recorded |");
    expect(report).toContain("| source |");
    expect(report).toContain("| reason |");
    expect(report).toContain("| entry |");
    expect(report).toContain("| title |");
  });
});

describe("dataQuality is processed at its version — queue + report", () => {
  it("alreadyProcessedAtVersion treats a contradiction as processed", () => {
    const e = entry();
    mergeDataQuality(e, { layout: { measured: null, recorded: "a", source: "vision", verifierVersion: "verifier-v1", verifiedAt: "x" } });
    expect(alreadyProcessedAtVersion(e, "layout", "verifier-v1")).toBe(true);
    expect(alreadyProcessedAtVersion(e, "layout", "verifier-v2")).toBe(false);
  });

  it("buildRunReport counts the new verdicts and prints per-detector rates by SOURCE", () => {
    const report = buildRunReport(
      {
        entries: 1,
        verdictsByEntry: {
          e1: [
            { field: "visual.usesBorders", verdict: "contradicted", reason: "detector contradiction", source: "detector" },
            { field: "visual.dominantColors", verdict: "pass", reason: "detector", source: "detector" },
            { field: "mood", verdict: "abstain", reason: "not positively confirmed", source: "vision" },
            { field: "critique", verdict: "contradicted", reason: "corroborated", source: "vision" },
          ],
        },
      },
      { dryRun: true, verifierVersion: "verifier-v1", sampleSize: 30 },
    );
    // A vision-source contradicted must NOT be credited to the detector lane.
    expect(report).toContain("Detector visual.usesBorders: n=1 · pass 0 (0%) · contradicted 1 (100%) · abstain 0 (0%)");
    expect(report).toContain("Detector visual.dominantColors: n=1 · pass 1 (100%) · contradicted 0 (0%) · abstain 0 (0%)");
    expect(report).not.toContain("Detector mood");
    expect(report).toContain("Verdicts — 1 pass, 2 contradicted, 1 abstain, 0 gated, 0 fail (image-level only)");
  });

  it("buildRunReport never prints NaN% — a flag-off fail rewrite on a detector source is not a rate", () => {
    // Under --detectors off, detector contradictions are rewritten to legacy
    // "fail" PRESERVING source ("detector") — the telemetry must not measure
    // the rewritten lane at all, and n=0 must render 0%, not NaN%.
    const report = buildRunReport(
      {
        entries: 1,
        verdictsByEntry: {
          e1: [
            { field: "platform", verdict: "fail", reason: "legacy flag-off rewrite", source: "detector" },
          ],
        },
      },
      { dryRun: true, verifierVersion: "verifier-v1", sampleSize: 30 },
    );
    expect(report).not.toContain("NaN");
    expect(report).toContain("Detector platform: n=0 · pass 0 (0%) · contradicted 0 (0%) · abstain 0 (0%)");
  });
});

describe("resumeMarkers — converge the resume queue on failed/gated fields", () => {
  it("marks every non-pass, non-gated verdict at the version, never a pass or a gated field", () => {
    const markers = resumeMarkers(
      [
        { field: "platform", verdict: "pass", reason: "" },
        { field: "critique", verdict: "fail", reason: "" },
        { field: "whatToSteal", verdict: "gate", reason: "no checkable assertions" },
        { field: "responsiveBehavior", verdict: "gate", reason: "gated" },
      ],
      "2026-08-05",
      "verifier-v1",
    );
    expect(markers.platform).toBeUndefined();           // a pass earns a real record, not a marker
    expect(markers.responsiveBehavior).toBeUndefined(); // gated is never persisted
    expect(markers.critique?.verifierVersion).toBe("verifier-v1");
    expect(markers.critique?.verifiedAt).toBe("2026-08-05");
    expect(markers.whatToSteal?.verifierVersion).toBe("verifier-v1");
  });

  it("mergeVerifyAttempts writes into provenance.verifyAttempts, NOT verification, and never clobbers", () => {
    const e = entry({ provenance: { taggedBy: "auto", verification: { platform: { method: "provable", verifiedAt: "x", verifierVersion: "verifier-v1" } } } });
    mergeVerifyAttempts(e, { critique: { verifierVersion: "verifier-v1", verifiedAt: "2026-08-05" } });
    const prov = (e as unknown as { provenance: { verification: Record<string, unknown>; verifyAttempts: Record<string, unknown> } }).provenance;
    expect(prov.verifyAttempts.critique).toBeDefined();
    expect(prov.verification.critique).toBeUndefined();  // markers never land in the trust map
    expect(prov.verification.platform).toBeDefined();    // existing trust record untouched
  });

  it("a fail/gate marker REVOKES a stale passing record for the same field (version-bump safety)", () => {
    // isVerified ignores verifierVersion, so a v1 pass that fails at v2 must be
    // DELETED, not left behind to keep serving.
    const e = entry({ provenance: { taggedBy: "auto", verification: { critique: { method: "image-confirmed", verifiedAt: "old", verifierVersion: "verifier-v1", imageSha256: "a".repeat(64) } } } });
    mergeVerifyAttempts(e, { critique: { verifierVersion: "verifier-v2", verifiedAt: "new" } });
    const prov = (e as unknown as { provenance: { verification: Record<string, unknown>; verifyAttempts: Record<string, unknown> } }).provenance;
    expect(prov.verification.critique).toBeUndefined();   // stale pass revoked
    expect(prov.verifyAttempts.critique).toBeDefined();
  });

  it("a passing record REVOKES a stale attempt marker for the same field", () => {
    const e = entry({ provenance: { taggedBy: "auto", verifyAttempts: { critique: { verifierVersion: "verifier-v1", verifiedAt: "old" } } } });
    mergeVerification(e, { critique: { method: "image-confirmed", verifiedAt: "new", verifierVersion: "verifier-v2", imageSha256: "a".repeat(64) } });
    const prov = (e as unknown as { provenance: { verification: Record<string, unknown>; verifyAttempts: Record<string, unknown> } }).provenance;
    expect(prov.verifyAttempts.critique).toBeUndefined();  // stale marker revoked
    expect(prov.verification.critique).toBeDefined();
  });
});

describe("buildEstimate — projected cost without calling the model", () => {
  it("counts pending entries and prose re-verify passes, calls no model", () => {
    const withProse = entry({ id: "p", critique: "The rail groups the metrics by row.", provenance: { taggedBy: "auto" } });
    const noProse = entry({ id: "n", provenance: { taggedBy: "auto" } });
    const est = buildEstimate([withProse, noProse]);
    expect(est).toContain("entries pending: 2");
    expect(est).toMatch(/vision verify calls: 2-3/); // 2 combined + up to 1 prose re-verify
  });
});

describe("resolveConfiguredVisionProvider — one resolved value feeds both the re-produce and verify passes", () => {
  const ORIGINAL_ENV = process.env.VERIFY_VISION_PROVIDER;
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.VERIFY_VISION_PROVIDER;
    else process.env.VERIFY_VISION_PROVIDER = ORIGINAL_ENV;
  });

  it("prefers the flag over the env var when both are set", () => {
    process.env.VERIFY_VISION_PROVIDER = "openai";
    // "claude", not "anthropic": the provider NAME this codebase routes on is
    // `claude` (see Provider in tagger.ts). The fixture previously used
    // "anthropic" — a natural thing to type and a value that would have been
    // passed straight through to the OpenAI default branch.
    expect(resolveConfiguredVisionProvider("claude")).toBe("claude");
  });

  it("rejects an unroutable provider name instead of silently falling back to OpenAI", () => {
    delete process.env.VERIFY_VISION_PROVIDER;
    // `resolveProvider` returns any non-mistral override verbatim and
    // callModelWithMetadata's `default:` routes the unrecognised name to OpenAI,
    // so without this guard `--vision-provider Claude` benchmarks OpenAI while the
    // report claims Claude. Both a wrong-case name and a wrong vendor name fail.
    expect(() => resolveConfiguredVisionProvider("Claude")).toThrow(/unknown vision provider "Claude"/);
    expect(() => resolveConfiguredVisionProvider("anthropic")).toThrow(/expected one of/);
  });

  it("rejects an unroutable name coming from the env var, not just the flag", () => {
    process.env.VERIFY_VISION_PROVIDER = "gpt5";
    expect(() => resolveConfiguredVisionProvider(undefined)).toThrow(/unknown vision provider "gpt5"/);
  });

  it("falls back to VERIFY_VISION_PROVIDER when the flag is unset — the bug this closes: reproduce and callVision must agree here", () => {
    process.env.VERIFY_VISION_PROVIDER = "openai";
    expect(resolveConfiguredVisionProvider(undefined)).toBe("openai");
  });

  it("returns undefined when neither the flag nor the env var is set", () => {
    delete process.env.VERIFY_VISION_PROVIDER;
    expect(resolveConfiguredVisionProvider(undefined)).toBeUndefined();
  });

  it("treats a blank env var the same as unset", () => {
    process.env.VERIFY_VISION_PROVIDER = "   ";
    expect(resolveConfiguredVisionProvider(undefined)).toBeUndefined();
  });
});

describe("selectPending — the resume selection", () => {
  const ALL_NON_GATED = ["platform", "visual.dominantColors", "visual.colorRoles", "visual.accentColor",
    "layout", "components", "visual.usesShadows", "visual.usesBorders", "visual.typePairing",
    "antiPatterns.accessibilityRisks", "critique", "whatToSteal", "antiPatterns", "voice",
    "mood", "colorScheme", "visual.spacingDensity", "visual.cornerStyle", "styleTags",
    "categories", "domainTags", "patternType"];

  it("excludes an entry whose fields are ALL current — whether by pass record OR attempt marker; also excludes no-image entries", () => {
    const fresh = entry({ id: "fresh", provenance: { taggedBy: "auto" } });
    const partial = entry({
      id: "partial",
      provenance: { taggedBy: "auto", verification: { critique: { method: "image-confirmed", verifiedAt: "2026-08-05", verifierVersion: "verifier-v1", imageSha256: "a".repeat(64) } } },
    });
    const record = { method: "image-confirmed", verifiedAt: "2026-08-05", verifierVersion: "verifier-v1", imageSha256: "a".repeat(64) };
    const attempt = { verifierVersion: "verifier-v1", verifiedAt: "2026-08-05" };
    // "done" mixes real records (passes) and verifyAttempts (fails) across the
    // field set — the realistic converged state — and must NOT re-select.
    const verification: Record<string, typeof record> = {};
    const verifyAttempts: Record<string, typeof attempt> = {};
    ALL_NON_GATED.forEach((f, i) => {
      if (i % 2 === 0) verification[f] = record;
      else verifyAttempts[f] = attempt;
    });
    const done = entry({ id: "done", provenance: { taggedBy: "auto", verification, verifyAttempts } });
    // A no-image entry can never be verified — it must not sit in the queue forever.
    const noImage = entry({ id: "noimg", image: { visibility: "private", path: "" } as CorpusEntryT["image"], provenance: { taggedBy: "auto" } });

    const pending = selectPending([fresh, partial, done, noImage], "verifier-v1");
    expect(pending.map((e) => e.id).sort()).toEqual(["fresh", "partial"]);
  });
});

describe("buildRunReport", () => {
  it("reports accepted/rejected/gated counts and the zero-assertion rate", () => {
    const report = buildRunReport(
      {
        entries: 2,
        verdictsByEntry: {
          e1: [{ field: "critique", verdict: "gate", reason: "no checkable assertions enumerated" }],
          e2: [{ field: "platform", verdict: "pass", reason: "matches" }],
        },
      },
      { dryRun: true, verifierVersion: "verifier-v1", sampleSize: 30 },
    );
    expect(report).toContain("DRY-RUN");
    expect(report).toContain("1 gated");
    expect(report).toMatch(/zero-assertion/i);
  });
});

describe("withTimeout — bounds the wait so one hung provider call can't stall the run", () => {
  it("resolves normally when the work finishes first", async () => {
    await expect(withTimeout(Promise.resolve("ok"), 1000, "fast")).resolves.toBe("ok");
  });

  it("rejects with the label when the work outlasts the bound", async () => {
    const never = new Promise<string>(() => {});
    await expect(withTimeout(never, 20, 'entry "x"')).rejects.toThrow(/timed out after 0s — entry "x"/);
  });

  it("propagates the work's own rejection rather than masking it as a timeout", async () => {
    const boom = Promise.reject(new Error("provider 400"));
    await expect(withTimeout(boom, 1000, "fast")).rejects.toThrow("provider 400");
  });

  it("does not leave the event loop blocked after resolving (timer is cleared)", async () => {
    // A leaked timer would keep the process alive for the full duration. Racing a
    // resolved withTimeout against a short sleep proves the handle was cleared:
    // if the 60s timer were still pending, vitest would hang on teardown.
    await withTimeout(Promise.resolve(1), 60_000, "cleared");
    await new Promise((r) => setTimeout(r, 5));
    expect(true).toBe(true);
  });

  it("swallows a LATE rejection from abandoned work instead of crashing the process", async () => {
    // The abandoned verifyEntry can reject after the timeout already fired. Because
    // Promise.race attached a handler, that late rejection must not surface as an
    // unhandledRejection and kill the run mid-corpus.
    let rejectLate: (e: Error) => void = () => {};
    const late = new Promise<string>((_, rej) => { rejectLate = rej; });
    await expect(withTimeout(late, 10, "late")).rejects.toThrow(/timed out/);
    rejectLate(new Error("arrived after the bound"));
    await new Promise((r) => setTimeout(r, 10));
    expect(true).toBe(true);
  });
});

describe("buildRunReport — run provenance names what actually ran", () => {
  const empty = { entries: 0, verdictsByEntry: {} };

  it("records the RESOLVED provider/model, so an overridden request can't be misreported", () => {
    // The bug this closes: dotenv runs with override:true (src/env.ts), so a run
    // invoked as CLAUDE_AUTO_TAG_MODEL=claude-sonnet-5 actually used .env's pin.
    // Two runs intended as different models were measured as the same one and
    // nothing in the output said so.
    const report = buildRunReport(empty, {
      dryRun: true,
      verifierVersion: "verifier-v1",
      sampleSize: 30,
      resolved: {
        provider: "claude",
        model: "claude-sonnet-4-5",
        imageDetail: "low",
        sampling: "temperature=0 seed=1",
      },
    });
    expect(report).toContain("Model: claude/claude-sonnet-4-5");
    expect(report).toContain("image detail: low");
    expect(report).toContain("sampling: temperature=0 seed=1");
  });

  it("names Pass 2's model when it differs from Pass 1's", () => {
    const report = buildRunReport(empty, {
      dryRun: true, verifierVersion: "v", sampleSize: 1,
      resolved: {
        provider: "minimax", model: "MiniMax-M3", critiqueModel: "MiniMax-Text",
        imageDetail: "high", sampling: "provider default",
      },
    });
    expect(report).toContain("(pass 2: MiniMax-Text)");
  });

  it("omits the Pass 2 note when both passes share a model", () => {
    const report = buildRunReport(empty, {
      dryRun: true, verifierVersion: "v", sampleSize: 1,
      resolved: {
        provider: "claude", model: "claude-sonnet-4-5", critiqueModel: "claude-sonnet-4-5",
        imageDetail: "low", sampling: "provider default",
      },
    });
    expect(report).not.toContain("pass 2:");
  });

  it("omits the provenance line entirely when no resolution is supplied", () => {
    expect(buildRunReport(empty, { dryRun: true, verifierVersion: "v", sampleSize: 1 }))
      .not.toContain("Model:");
  });
});

describe("reproduceCritiqueModel — the report names the model Pass 2 actually calls", () => {
  const ORIGINAL = process.env.OPENAI_AUTO_TAG_MODEL;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.OPENAI_AUTO_TAG_MODEL;
    else process.env.OPENAI_AUTO_TAG_MODEL = ORIGINAL;
  });

  it("reports the OVERRIDE model for openai, not the env-resolved critique model", () => {
    // The bug: makeReproduceDependency overrides Pass 2 to the extraction-tier
    // OpenAI config, but the report resolved Pass 2 from
    // OPENAI_AUTO_TAG_MODEL_CRITIQUE — printing `pass 2: deepseek-chat` for a run
    // that actually called the override.
    process.env.OPENAI_AUTO_TAG_MODEL = "gpt-5.4-mini";
    expect(reproduceCritiqueModel("openai", "deepseek-chat")).toBe("gpt-5.4-mini");
  });

  it("reports the env-resolved model for providers that get no override", () => {
    // claude/gemini/minimax/grok receive no critiqueOverride, so environment
    // resolution IS what the call uses and must be reported verbatim.
    expect(reproduceCritiqueModel("minimax", "MiniMax-Text")).toBe("MiniMax-Text");
    expect(reproduceCritiqueModel("claude", "claude-sonnet-4-5")).toBe("claude-sonnet-4-5");
    expect(reproduceCritiqueModel(undefined, "gpt-5.4-nano")).toBe("gpt-5.4-nano");
  });
});
