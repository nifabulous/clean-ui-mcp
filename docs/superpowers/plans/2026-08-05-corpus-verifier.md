# Corpus Verifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Stage 2c verifier that writes per-field `provenance.verification` records — independent of the corpus producer and positive-affirming — so the dark corpus starts lighting up with values that were actually checked.

**Architecture:** One CLI (`src/scripts/verify-corpus.ts`) with pure, unit-tested helpers and an injected-dependency orchestrator. Mechanical fields (`platform`, `visual.dominantColors`) are recomputed from the image via the existing `detectPlatform` / `extractQuantizedColors` and written as `image-confirmed` records bound to the image hash. All other fields go through one adversarial vision verify pass (`callVisionModel`), then failed prose fields are re-produced by the tagger's now-seeing Pass 2 (`TaggerInput.critiqueImagePath`) and re-verified in a fresh call. Records merge into `provenance.verification[fieldKey]`, never clobbering other keys, and persist through the snapshot-backed `persistEntries` path.

**Tech Stack:** TypeScript, Vitest, node-vibrant (existing), Playwright-free (no new deps).

**Spec:** `docs/superpowers/specs/2026-08-05-corpus-verifier-design.md`

## Global Constraints

- **The verifier is independent of the producer.** The pass that writes a claim can never be the pass that certifies it. Re-verify (step 4) is a separate call, fresh context, adversarial prompt.
- **Verification is positive affirmation, not refutation-survival.** Every verify prompt asks the model to CONFIRM the described element exists, default false. "Failed to find a problem" never grants trust.
- **Fail-closed everywhere.** A field absent from the verify response is not confirmed. A prose field whose extracted checkable-assertion set is EMPTY is NOT granted ("every assertion holds" is vacuously true over the empty set).
- **Pixel evidence is `image-confirmed`, never `measured`.** The record shape binds `imageSha256` only to `image-confirmed` (`corpus-trust.ts:82`), and the doctor's staleness checks run only for that method (`doctor-helpers.ts:540-576`). `platform` and `visual.dominantColors` are image-derived, so their records use `method: "image-confirmed"` WITH the hash even though the check is mechanical.
- **Merge, never clobber.** The verifier writes `provenance.verification[fieldKey]`; existing records under other keys are untouched. Re-running is idempotent for fields that still pass.
- **Every record carries `verifierVersion`** (a module constant) and `verifiedAt`. Selective re-verification scans for `verifierVersion < N` (or absent).
- **`responsiveBehavior` is never granted** — a single screenshot cannot confirm cross-viewport behaviour. No code path may write a record for it.
- **Writes go through the persistence path** (`persistEntries`/`writableLoadedCorpus` in `src/persistence.ts`), never a raw file write. A `--dry-run` writes nothing.
- **Resume key is (entry id, field key):** a field whose record already carries the current `verifierVersion` is skipped.
- **Re-derivation semantics:** `visual.dominantColors` reuses `extractQuantizedColors(imagePath)` (`tagger.ts:272`); match is an order-insensitive SET match (every recorded color must appear in the extracted set). `platform` recomputes via `detectPlatform(width, height)` (`schema.ts:184`) against the entry's recorded image dimensions; missing dimensions fail the field.
- TDD: failing test first, minimal implementation, passing test, commit. Write a review artifact before each push (see `CLAUDE.md`):
  ```bash
  .zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
    --base-sha <parent-sha> --head-sha <task-commit-sha> --branch <branch>
  ```

---

## File Structure

| File | Responsibility |
|---|---|
| `src/scripts/verify-corpus.ts` | **Create.** Tier table, mechanical verification, verify-prompt builders, response parser, verdict decision, per-entry orchestrator, record merge, resume, report, CLI. |
| `src/scripts/verify-corpus.test.ts` | **Create.** Unit tests for every pure helper; orchestrator tests with injected stubs and a real tiny PNG. |
| `src/tagger.ts` | **Modify.** `TaggerInput.critiqueImagePath?: string`; Pass 2 (initial + retry) passes the image instead of `null` when set. |
| `src/tagger.test.ts` | **Modify.** The pinned "Pass 2 has no image input" test gains the `critiqueImagePath` variant. |
| `package.json` | **Modify.** `verify` and `verify:dry-run` scripts. |
| `.env.example` | **Modify.** `VERIFY_VISION_*` env block. |

---

## Task 1: The tier table and mechanical verification

**Files:**
- Create: `src/scripts/verify-corpus.ts` (tiers + mechanical verification only)
- Create: `src/scripts/verify-corpus.test.ts`

**Interfaces:**
- Consumes: `detectPlatform` from `./schema.js`, `extractQuantizedColors` from `../tagger.js`, `fromCorpusRelativeImagePath` from `../paths.js`, `createHash` from `node:crypto`.
- Produces: `type VerifierTier = "mechanical" | "factual" | "a11y" | "prose" | "soft" | "gated"`; `tierForField(field: string): VerifierTier`; `type VerificationRecord = { method: string; verifiedAt: string; verifierVersion: string; imageSha256?: string }`; `verifyMechanicalFields(entry, imagePath): { records: Record<string, VerificationRecord>; verdicts: FieldVerdict[] }`. Task 2 consumes `tierForField`; Task 4 consumes `verifyMechanicalFields`.

- [ ] **Step 1: Write the failing tests**

Create `src/scripts/verify-corpus.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tierForField, verifyMechanicalFields, type VerificationRecord } from "./verify-corpus.js";
import type { CorpusEntryT } from "../schema.js";

// A real 1x1 PNG (same bytes the tagger tests use) so extractQuantizedColors
// has actual pixels to read.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+P+/HgAFeAJ5fVqRtwAAAABJRU5ErkJggg==",
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

describe("verifyMechanicalFields — re-derivable values, image-confirmed records", () => {
  it("writes image-confirmed records with the image hash when the recorded values match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-mech-"));
    const imagePath = join(dir, "e1.png");
    writeFileSync(imagePath, PNG_BYTES);
    try {
      const e = entry({
        platform: "mobile", // detectPlatform(390, 844) === "mobile"
        visual: { dominantColors: ["#ffffff", "#111111"], accentColor: null, typePairing: { display: null, body: null, notes: "" }, spacingDensity: "moderate", cornerStyle: "slight-round", usesShadows: false, usesBorders: true },
      });
      const { records, verdicts } = await verifyMechanicalFields(e, imagePath);
      for (const field of ["platform", "visual.dominantColors"]) {
        const record = records[field];
        expect(record, field).toBeDefined();
        expect(record!.method).toBe("image-confirmed");
        expect(record!.imageSha256).toMatch(/^[0-9a-f]{64}$/);
        expect(record!.verifierVersion).toMatch(/^verifier-v\d+$/);
      }
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
      const e = entry({ platform: "mobile", image: { visibility: "private", path: "images-private/e1.png" } });
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
```

Import `type VerifierTier` and `type FieldVerdict` alongside the values at the top of the test.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/scripts/verify-corpus.test.ts`
Expected: FAIL — `verify-corpus.js` does not exist (module not found).

- [ ] **Step 3: Write the minimal implementation**

Create `src/scripts/verify-corpus.ts`:

```ts
#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { detectPlatform } from "../schema.js";
import { extractQuantizedColors } from "../tagger.js";
import { fromCorpusRelativeImagePath } from "../paths.js";

/** The verifier's own version — stamped on every record and the resume key. */
export const VERIFIER_VERSION = "verifier-v1";

export type VerifierTier = "mechanical" | "factual" | "a11y" | "prose" | "soft" | "gated";

export type VerificationRecord = {
  method: string;
  verifiedAt: string;
  verifierVersion: string;
  imageSha256?: string;
};

export type FieldVerdict = {
  field: string;
  verdict: "pass" | "fail" | "gate";
  reason: string;
};

/**
 * The spec's classification table as code. A key added to SERVABLE_FIELD_KEYS
 * later must be classified here too, or tierForField returns "gated" and the
 * key is silently unverifiable — the doctor's verification-orphan-key detector
 * already catches keys nothing reads; this catches servable keys nothing
 * verifies.
 */
const TIER_BY_FIELD: Readonly<Record<string, VerifierTier>> = {
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

export function tierForField(field: string): VerifierTier {
  return TIER_BY_FIELD[field] ?? "gated";
}

export function imageSha256Of(imagePath: string): string {
  return createHash("sha256").update(readFileSync(imagePath)).digest("hex");
}

/** A fresh image-confirmed record bound to the image the verifier saw. */
function confirmedRecord(imagePath: string, now: string): VerificationRecord {
  return {
    method: "image-confirmed",
    verifiedAt: now,
    verifierVersion: VERIFIER_VERSION,
    imageSha256: imageSha256Of(imagePath),
  };
}

/**
 * Re-derivable fields — no model. Both records are `image-confirmed` (with the
 * hash) even though the check is mechanical: the evidence IS the image, and
 * only image-confirmed records carry the binding the doctor's staleness checks
 * read (`doctor-helpers.ts:540-576`).
 */
export async function verifyMechanicalFields(
  entry: { platform?: string | null; image?: { width?: number | null; height?: number | null } | null; visual?: { dominantColors?: string[] | null } | null },
  imagePath: string,
  now = new Date().toISOString().slice(0, 10),
): Promise<{ records: Record<string, VerificationRecord>; verdicts: FieldVerdict[] }> {
  const records: Record<string, VerificationRecord> = {};
  const verdicts: FieldVerdict[] = [];

  const width = entry.image?.width ?? null;
  const height = entry.image?.height ?? null;
  const recordedPlatform = entry.platform ?? null;
  if (width === null || height === null || recordedPlatform === null) {
    verdicts.push({
      field: "platform",
      verdict: "fail",
      reason: width === null || height === null ? "image dimensions missing" : "no recorded platform",
    });
  } else {
    const recomputed = detectPlatform(width, height);
    if (recomputed === recordedPlatform) {
      records.platform = confirmedRecord(imagePath, now);
      verdicts.push({ field: "platform", verdict: "pass", reason: `detectPlatform(${width}, ${height}) matches` });
    } else {
      verdicts.push({ field: "platform", verdict: "fail", reason: `detectPlatform gives ${recomputed}, recorded ${recordedPlatform}` });
    }
  }

  const recordedColors = entry.visual?.dominantColors ?? null;
  if (recordedColors === null || recordedColors.length === 0) {
    verdicts.push({ field: "visual.dominantColors", verdict: "fail", reason: "no recorded dominantColors" });
  } else {
    const extracted = await extractQuantizedColors(imagePath);
    const extractedSet = new Set(extracted);
    const missing = recordedColors.filter((c) => !extractedSet.has(c.toLowerCase()));
    if (missing.length === 0) {
      records["visual.dominantColors"] = confirmedRecord(imagePath, now);
      verdicts.push({ field: "visual.dominantColors", verdict: "pass", reason: "recorded colors all present in the extracted set" });
    } else {
      verdicts.push({ field: "visual.dominantColors", verdict: "fail", reason: `recorded colors absent from extraction: ${missing.join(", ")}` });
    }
  }

  return { records, verdicts };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/scripts/verify-corpus.test.ts`
Expected: PASS. If `extractQuantizedColors` on the 1x1 PNG returns a set that does not include the recorded colors, update the test's recorded colors to the actual extraction output of that PNG (the match rule is set-membership against whatever the shared extractor returns — the assertion that matters is the fail direction and the record shape).

- [ ] **Step 5: Commit**

```bash
git add src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts
git commit -m "feat(verify): tier table and mechanical verification — platform and dominantColors re-derived as image-confirmed records"
```

---

## Task 2: The vision verify pass — prompts, response parsing, verdicts

**Files:**
- Modify: `src/scripts/verify-corpus.ts` (append)
- Modify: `src/scripts/verify-corpus.test.ts`

**Interfaces:**
- Consumes: `tierForField`, `VerificationRecord`, `FieldVerdict` from Task 1.
- Produces: `buildVerifyPrompt(entry, fields, verifierVersion): string`; `parseVerifyResponse(raw): Record<string, { confirmed: boolean; assertions?: string[]; reason?: string }>`; `decideFieldVerdict(field, tier, parsed): FieldVerdict`. Task 4 consumes all three.

- [ ] **Step 1: Write the failing tests**

Append to `src/scripts/verify-corpus.test.ts`:

```ts
import { buildVerifyPrompt, parseVerifyResponse, decideFieldVerdict } from "./verify-corpus.js";

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
    expect(prompt).toContain("assertions: []");
    expect(prompt).toContain("confirmed: false");
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/scripts/verify-corpus.test.ts`
Expected: FAIL — the three functions are not defined.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/scripts/verify-corpus.ts`:

```ts
/** A precise, checkable claim per servable field, built from the RECORDED value. */
function claimForField(entry: Record<string, unknown>, field: string): string | null {
  const v = entry.visual as Record<string, unknown> | undefined;
  switch (field) {
    case "visual.colorRoles": {
      const roles = v?.colorRoles as Record<string, string | null> | undefined;
      if (!roles) return null;
      return `canvas ${roles.canvas}, surface ${roles.surface}, ink ${roles.ink}, muted ${roles.muted ?? "(none)"}, accent ${roles.accent}`;
    }
    case "visual.accentColor":
      return v?.accentColor ? `the accent color is ${v.accentColor}` : null;
    case "layout": {
      const form = (entry.layout as { form?: string } | undefined)?.form;
      const regions = (entry.layout as { regions?: Array<{ role: string }> } | undefined)?.regions ?? [];
      if (!form && regions.length === 0) return null;
      return `a ${form ?? "multi-region"} layout with regions: ${regions.map((r) => r.role).join(", ") || "none named"}`;
    }
    case "components": {
      const components = entry.components as string[] | undefined;
      return components && components.length > 0 ? `components present: ${components.join(", ")}` : null;
    }
    case "visual.usesShadows":
      return v?.usesShadows === true ? "soft shadows are used" : "no shadows are used";
    case "visual.usesBorders":
      return v?.usesBorders === true ? "hairline borders are used" : "no borders are used";
    case "visual.typePairing": {
      const p = v?.typePairing as { display?: string | null; body?: string | null } | undefined;
      return p?.display && p.body ? `a ${p.display} + ${p.body} type pairing` : null;
    }
    case "antiPatterns.accessibilityRisks": {
      const risks = (entry.antiPatterns as { accessibilityRisks?: Array<{ element?: string; risk?: string }> } | undefined)?.accessibilityRisks ?? [];
      return risks.length > 0
        ? risks.map((r) => `risk on "${r.element ?? "an element"}": ${r.risk}`).join("; ")
        : null;
    }
    case "critique":
      return typeof entry.critique === "string" && entry.critique.length > 0 ? entry.critique : null;
    case "whatToSteal": {
      const items = entry.whatToSteal as string[] | undefined;
      return items && items.length > 0 ? items.join("; ") : null;
    }
    case "antiPatterns": {
      const items = (entry.antiPatterns as { antiPatterns?: string[] } | undefined)?.antiPatterns ?? [];
      return items.length > 0 ? items.join("; ") : null;
    }
    case "voice": {
      const voice = entry.voice as { tone?: string; examples?: string[]; avoid?: string[] } | undefined;
      return voice?.tone ? `${voice.tone}. Examples: ${(voice.examples ?? []).join("; ")}. Avoid: ${(voice.avoid ?? []).join("; ")}` : null;
    }
    case "mood":
      return typeof entry.mood === "string" ? entry.mood : null;
    case "colorScheme":
      return typeof entry.colorScheme === "string" ? entry.colorScheme : null;
    case "visual.spacingDensity":
      return typeof v?.spacingDensity === "string" ? v.spacingDensity : null;
    case "visual.cornerStyle":
      return typeof v?.cornerStyle === "string" ? v.cornerStyle : null;
    case "styleTags":
      return (entry.styleTags as string[] | undefined)?.length ? `style tags: ${(entry.styleTags as string[]).join(", ")}` : null;
    case "categories":
      return (entry.categories as string[] | undefined)?.length ? `categories: ${(entry.categories as string[]).join(", ")}` : null;
    case "domainTags":
      return (entry.domainTags as string[] | undefined)?.length ? `domain tags: ${(entry.domainTags as string[]).join(", ")}` : null;
    case "patternType":
      return typeof entry.patternType === "string" ? entry.patternType : null;
    default:
      return null;
  }
}

/**
 * One adversarial, positive-affirmation verify prompt for a set of fields.
 * Prose fields first enumerate their checkable factual assertions, then confirm
 * EACH; an empty assertion list is explicitly not confirmed (the vacuity fix).
 */
export function buildVerifyPrompt(
  entry: Record<string, unknown>,
  fields: readonly string[],
  verifierVersion: string,
): string {
  const lines: string[] = [];
  for (const field of fields) {
    const tier = tierForField(field);
    if (tier === "gated") continue;
    const claim = claimForField(entry, field);
    if (claim === null) continue;
    if (tier === "prose") {
      lines.push(`- ${field}: enumerate the CHECKABLE FACTUAL assertions in this text (named colours, regions, components, layout features): "${claim}". Then confirm EACH against the screenshot. If the text contains no checkable factual assertions, return "assertions": [] and "confirmed": false.`);
    } else {
      lines.push(`- ${field}: confirm this claim is VISIBLY TRUE in the screenshot — default false if you cannot positively see it: "${claim}".`);
    }
  }
  if (lines.length === 0) return "";
  return `You are an independent verifier (${verifierVersion}), NOT the producer. For each field below, POSITIVELY CONFIRM the claim against the screenshot (default false). A missing element returns false. Never guess.
Return ONLY valid JSON, no fences:
{
  "<field>": { "confirmed": true|false, "assertions": ["..."], "reason": "..." }
}
${lines.join("\n")}`;
}

export function parseVerifyResponse(raw: string): Record<string, { confirmed: boolean; assertions?: string[]; reason?: string }> {
  const out: Record<string, { confirmed: boolean; assertions?: string[]; reason?: string }> = {};
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return out;
  }
  if (typeof parsed !== "object" || parsed === null) return out;
  for (const [field, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      out[field] = { confirmed: false };
      continue;
    }
    const v = value as Record<string, unknown>;
    const assertions = Array.isArray(v.assertions)
      ? v.assertions.filter((a): a is string => typeof a === "string")
      : undefined;
    out[field] = {
      confirmed: v.confirmed === true,
      ...(assertions !== undefined ? { assertions } : {}),
      ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
    };
  }
  return out;
}

export function decideFieldVerdict(
  field: string,
  tier: VerifierTier,
  parsed: { confirmed: boolean; assertions?: string[] },
): FieldVerdict {
  if (tier === "gated") {
    return { field, verdict: "gate", reason: "no single screenshot can confirm this claim" };
  }
  if (tier === "prose") {
    const assertions = parsed.assertions ?? [];
    if (assertions.length === 0) {
      return { field, verdict: "gate", reason: "no checkable assertions enumerated — vacuous confirmation refused" };
    }
    if (!parsed.confirmed) {
      return { field, verdict: "fail", reason: "at least one assertion was not confirmed" };
    }
    return { field, verdict: "pass", reason: `${assertions.length} assertion(s) confirmed` };
  }
  return parsed.confirmed
    ? { field, verdict: "pass", reason: "positively confirmed against the image" }
    : { field, verdict: "fail", reason: "not positively confirmed" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/scripts/verify-corpus.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts
git commit -m "feat(verify): adversarial positive-affirmation verify prompts and fail-closed response parsing"
```

---

## Task 3: The seeing re-produce path — `TaggerInput.critiqueImagePath`

**Files:**
- Modify: `src/tagger.ts` (the `TaggerInput` interface and the two Pass-2 `callModel` sites, currently `:3024-3032` and the retry around `:3054-3062`)
- Modify: `src/tagger.test.ts` (the pinned "Pass 2 has no image input" test around `:660-705`)

**Interfaces:**
- Consumes: `tagImage` as it exists today.
- Produces: `TaggerInput.critiqueImagePath?: string` — when set, Pass 2 (initial and retry) passes the image to `callModel` instead of `null`, so the critique pass finally SEES the screenshot. When unset, behavior is byte-identical (the existing test pins this). Task 4 calls `tagImage` with this option to re-produce failed prose fields.

- [ ] **Step 1: Write the failing test**

In `src/tagger.test.ts`, extend the pinned Pass-2 test with a seeing variant. Find the existing test that asserts `pass2Image` is `undefined` (around `:660-705`) and add, in the same describe block:

```ts
it("passes the image to Pass 2 when critiqueImagePath is set", async () => {
  const calls: Array<{ body: { input?: Array<{ content?: Array<Record<string, unknown>> }> } }> = [];
  let callCount = 0;
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    calls.push({ body });
    callCount++;
    const response = callCount === 1
      ? JSON.stringify({
          patternType: "dashboard", categories: ["dashboard"], styleTags: ["minimal"],
          components: ["sidebar-nav", "kpi-card"], domainTags: ["integrations"],
          dominantColors: ["#ffffff", "#111111"], accentColor: null,
          displayFont: null, bodyFont: null, spacingDensity: "moderate", cornerStyle: "slight-round",
          usesShadows: false, usesBorders: true,
        })
      : JSON.stringify({
          observations: ["a"], typographyNotes: "notes",
          draftCritique: "A seeing critique that describes the visible layout.",
          draftWhatToSteal: ["Use quiet grouping."],
          draftAntiPatterns: ["Avoids card shadows."],
          businessRationale: { businessGoal: "x", targetUser: "y", rationale: "z", confirmed: false },
          qualityTier: "exceptional",
        });
    return new Response(JSON.stringify({ output_text: response }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const entry = await tagImage({
    imagePath: testImage,
    productName: "Test",
    url: null,
    critiqueImagePath: testImage,
  });

  expect(entry.critique).toContain("seeing critique");
  const pass2Image = calls[1]?.body.input?.[1]?.content?.find((c) => c.type === "input_image");
  expect(pass2Image, "Pass 2 must receive the image when critiqueImagePath is set").toBeDefined();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tagger.test.ts -t "critiqueImagePath"`
Expected: FAIL — `TaggerInput` has no `critiqueImagePath` member (compile error) and Pass 2 still sends no image.

- [ ] **Step 3: Write the minimal implementation**

In `src/tagger.ts`:

Add to `TaggerInput` (after `critiqueOverride`):

```ts
  /**
   * When set, Pass 2 (the critique pass) receives the IMAGE instead of null.
   * The corpus verifier (Stage 2c) uses this to re-produce prose fields that
   * failed verification: the original fabrication root cause is Pass 2 running
   * text-only (`tagger.ts:3026`), and re-producing against the pixels is the
   * fix. Unset keeps the historical text-only behaviour byte-identical.
   */
  critiqueImagePath?: string;
```

Replace the two Pass-2 `callModel` image arguments (currently `null, // no image — pure reasoning from facts` and the retry's `null`):

```ts
    input.critiqueImagePath ?? null, // seeing Pass 2 when the verifier re-produces
```

and

```ts
      input.critiqueImagePath ?? null,
```

Update the Pass-2 comment above the first call to note the option:

```ts
  // ── PASS 2: critique (judgment, fed validated extraction as fact) ──────────
  // Text-only by default — the model reasons from the validated extraction.
  // `critiqueImagePath` (the verifier's re-produce path) lets it see the pixels
  // instead, closing the fabrication root cause this pass's null image created.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tagger.test.ts`
Expected: PASS — the new seeing variant passes AND the existing "Pass 2 has no image input" pin still passes (unset = null image, byte-identical).

- [ ] **Step 5: Commit**

```bash
git add src/tagger.ts src/tagger.test.ts
git commit -m "feat(tagger): TaggerInput.critiqueImagePath — the seeing Pass 2 the verifier's re-produce path needs"
```

---

## Task 4: Per-entry orchestration and record merging

**Files:**
- Modify: `src/scripts/verify-corpus.ts` (append)
- Modify: `src/scripts/verify-corpus.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 (`verifyMechanicalFields`, `buildVerifyPrompt`, `parseVerifyResponse`, `decideFieldVerdict`, `VERIFIER_VERSION`, `tagImage`'s `critiqueImagePath`).
- Produces: `verifyEntry(entry, imagePath, deps): Promise<{ records: Record<string, VerificationRecord>; verdicts: FieldVerdict[] }>` where `deps = { callVision, reproduce, now }`; `mergeVerification(entry, records): void` (mutates `provenance.verification`, never clobbering other keys); `alreadyVerifiedAtVersion(entry, field, version): boolean` (the resume check). Task 5 consumes all.

- [ ] **Step 1: Write the failing tests**

Append to `src/scripts/verify-corpus.test.ts`:

```ts
import { verifyEntry, mergeVerification, alreadyVerifiedAtVersion } from "./verify-corpus.js";

describe("alreadyVerifiedAtVersion — the resume key", () => {
  it("skips a field whose record carries the current version", () => {
    const e = entry({
      provenance: {
        taggedBy: "auto",
        verification: { critique: { method: "image-confirmed", verifiedAt: "2026-08-05", verifierVersion: "verifier-v1", imageSha256: "a".repeat(64) } },
      },
    });
    expect(alreadyVerifiedAtVersion(e, "critique", "verifier-v1")).toBe(true);
    expect(alreadyVerifiedAtVersion(e, "critique", "verifier-v2")).toBe(false);
    expect(alreadyVerifiedAtVersion(e, "voice", "verifier-v1")).toBe(false);
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
```

Note the orchestration contract encoded in the tests: a prose field that fails vision is re-produced once and re-verified; a re-verify that still fails leaves the field with NO record and verdict `fail`. Non-prose failures (factual/soft/a11y) also get no record (there is no seeing Pass 2 for them) but are NOT re-produced — the re-produce path covers only the four prose fields the tagger's Pass 2 writes.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/scripts/verify-corpus.test.ts`
Expected: FAIL — the four functions are not defined.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/scripts/verify-corpus.ts`:

```ts
import type { CorpusEntryT } from "../schema.js";
import { tagImage } from "../tagger.js";

export function alreadyVerifiedAtVersion(entry: CorpusEntryT, field: string, version: string): boolean {
  return entry.provenance?.verification?.[field]?.verifierVersion === version;
}

/** Write records into `provenance.verification`, never clobbering other keys. */
export function mergeVerification(entry: CorpusEntryT, records: Record<string, VerificationRecord>): void {
  const provenance = entry.provenance ?? { taggedBy: "auto" as const };
  const verification = { ...(provenance.verification ?? {}) };
  for (const [field, record] of Object.entries(records)) verification[field] = record;
  provenance.verification = verification;
  entry.provenance = provenance;
}

const PROSE_FIELDS: readonly string[] = ["critique", "whatToSteal", "antiPatterns", "voice"];

export interface VerifyEntryDeps {
  now: () => string;
  callVision: (prompt: string, imagePath: string) => Promise<string>;
  reproduce: (entry: CorpusEntryT, imagePath: string) => Promise<CorpusEntryT>;
}

export async function verifyEntry(
  entry: CorpusEntryT,
  imagePath: string,
  deps: VerifyEntryDeps,
): Promise<{ records: Record<string, VerificationRecord>; verdicts: FieldVerdict[] }> {
  const now = deps.now();
  const records: Record<string, VerificationRecord> = {};
  const verdicts: FieldVerdict[] = [];

  // 1. Mechanical checks — always run, never skipped (they are free).
  const mechanical = await verifyMechanicalFields(entry, imagePath, now);
  for (const [field, record] of Object.entries(mechanical.records)) records[field] = record;
  verdicts.push(...mechanical.verdicts);

  // 2. The fields left to verify — those not already stamped at this version.
  const pending = Object.keys(TIER_BY_FIELD).filter(
    (field) => tierForField(field) !== "mechanical" && tierForField(field) !== "gated"
      && !alreadyVerifiedAtVersion(entry, field, VERIFIER_VERSION),
  );
  if (pending.length > 0) {
    const prompt = buildVerifyPrompt(entry, pending, VERIFIER_VERSION);
    const raw = await deps.callVision(prompt, imagePath);
    const parsed = parseVerifyResponse(raw);
    for (const field of pending) {
      const tier = tierForField(field);
      const claim = claimForField(entry as unknown as Record<string, unknown>, field);
      if (claim === null) {
        verdicts.push({ field, verdict: "gate", reason: "no recorded value to verify" });
        continue;
      }
      let verdict = decideFieldVerdict(field, tier, parsed[field] ?? { confirmed: false });
      // 3. Re-produce failed PROSE fields with the seeing Pass 2; non-prose
      // failures stay gated (the tagger's Pass 2 does not write them).
      if (verdict.verdict === "fail" && PROSE_FIELDS.includes(field)) {
        const reproduced = await deps.reproduce(entry, imagePath);
        const reproClaim = claimForField(reproduced as unknown as Record<string, unknown>, field);
        if (reproClaim === null) {
          verdicts.push({ field, verdict: "gate", reason: "re-production wrote no value for this field" });
          continue;
        }
        // 4. Re-verify the re-produced value in a FRESH independent call.
        const rePrompt = buildVerifyPrompt(reproduced as unknown as Record<string, unknown>, [field], VERIFIER_VERSION);
        const reRaw = await deps.callVision(rePrompt, imagePath);
        const reParsed = parseVerifyResponse(reRaw);
        verdict = decideFieldVerdict(field, tier, reParsed[field] ?? { confirmed: false });
        if (verdict.verdict === "pass") {
          // The re-produced value replaces the fabricated one only after it
          // passed; merge it into the entry so the record and the value agree.
          const value = (reproduced as unknown as Record<string, unknown>)[field];
          (entry as unknown as Record<string, unknown>)[field] = value;
        }
      }
      if (verdict.verdict === "pass") {
        records[field] = { method: "image-confirmed", verifiedAt: now, verifierVersion: VERIFIER_VERSION, imageSha256: imageSha256Of(imagePath) };
      }
      verdicts.push(verdict);
    }
  }
  return { records, verdicts };
}

/**
 * The real re-produce dependency: tag the image with the SEEING Pass 2 and
 * return the produced entry. Only the failed fields' values are read by the
 * caller; Pass 1 re-runs internally as the extraction input Pass 2 requires.
 */
export function makeReproduceDependency(provider?: string): VerifyEntryDeps["reproduce"] {
  return async (entry: CorpusEntryT, imagePath: string): Promise<CorpusEntryT> => {
    const tagged = await tagImage({
      imagePath,
      productName: entry.source?.productName ?? "Untitled",
      url: entry.source?.url ?? null,
      critiqueImagePath: imagePath,
      critiqueProvider: provider as Parameters<typeof tagImage>[0]["critiqueProvider"],
    });
    return {
      ...entry,
      critique: tagged.critique,
      whatToSteal: tagged.whatToSteal,
      antiPatterns: tagged.antiPatterns,
      voice: tagged.voice,
    } as CorpusEntryT;
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/scripts/verify-corpus.test.ts`
Expected: PASS. Fix the fixture `entry()` helper's provenance typing if the compiler complains (the helper casts through `as unknown as CorpusEntryT`, so add `provenance` to the base object as needed).

- [ ] **Step 5: Commit**

```bash
git add src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts
git commit -m "feat(verify): per-entry orchestration — mechanical, vision, seeing re-produce, re-verify, merge-never-clobber"
```

---

## Task 5: The CLI — dry-run, resume, report, persistence

**Files:**
- Modify: `src/scripts/verify-corpus.ts` (append the CLI)
- Modify: `src/scripts/verify-corpus.test.ts`
- Modify: `package.json`, `.env.example`

**Interfaces:**
- Consumes: Task 4 (`verifyEntry`, `mergeVerification`, `alreadyVerifiedAtVersion`, `makeReproduceDependency`, `VERIFIER_VERSION`).
- Produces: `buildRunReport(results, opts): string` (the curator report); `selectPending(entries, version, opts): CorpusEntryT[]` (the resume selection); `main()` with `--dry-run`, `--limit`, `--sample-size`, `--corpus`, `--out`, `--vision-provider`. Persistence via `loadCorpus()` / `persistEntries(writableLoadedCorpus(entries), entries)`.

- [ ] **Step 1: Write the failing tests**

Append to `src/scripts/verify-corpus.test.ts`:

```ts
import { buildRunReport, selectPending } from "./verify-corpus.js";

describe("selectPending — the resume selection", () => {
  it("includes entries missing a current-version record on ANY servable field, excludes fully-verified ones", () => {
    const fresh = entry({ id: "fresh", provenance: { taggedBy: "auto" } });
    const partial = entry({
      id: "partial",
      provenance: { taggedBy: "auto", verification: { critique: { method: "image-confirmed", verifiedAt: "2026-08-05", verifierVersion: "verifier-v1", imageSha256: "a".repeat(64) } } },
    });
    const record = { method: "image-confirmed", verifiedAt: "2026-08-05", verifierVersion: "verifier-v1", imageSha256: "a".repeat(64) };
    const verification: Record<string, typeof record> = {};
    for (const field of ["platform", "visual.dominantColors", "visual.colorRoles", "visual.accentColor",
      "layout", "components", "visual.usesShadows", "visual.usesBorders", "visual.typePairing",
      "antiPatterns.accessibilityRisks", "critique", "whatToSteal", "antiPatterns", "voice",
      "mood", "colorScheme", "visual.spacingDensity", "visual.cornerStyle", "styleTags",
      "categories", "domainTags", "patternType"]) {
      verification[field] = record;
    }
    const done = entry({ id: "done", provenance: { taggedBy: "auto", verification } });
    const pending = selectPending([fresh, partial, done], "verifier-v1");
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/scripts/verify-corpus.test.ts`
Expected: FAIL — the two functions are not defined.

- [ ] **Step 3: Write the minimal implementation**

Append to `src/scripts/verify-corpus.ts`:

```ts
import { loadCorpus } from "../corpus.js";
import { persistEntries, writableLoadedCorpus } from "../persistence.js";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { callVisionModel } from "../tagger.js";
import { parseArgs } from "node:util";

export interface RunResult {
  entries: number;
  verdictsByEntry: Record<string, FieldVerdict[]>;
}

export function selectPending(entries: readonly CorpusEntryT[], version: string): CorpusEntryT[] {
  return entries.filter((e) => {
    const verification = e.provenance?.verification ?? {};
    // Pending when ANY VERIFIABLE servable field lacks a current-version
    // record. Gated fields (responsiveBehavior) never count — they can never
    // carry a record, so they must not keep an otherwise-finished entry in the
    // queue.
    return Object.keys(TIER_BY_FIELD)
      .filter((field) => tierForField(field) !== "gated")
      .some((field) => verification[field]?.verifierVersion !== version);
  });
}

export function buildRunReport(result: RunResult, opts: { dryRun: boolean; verifierVersion: string; sampleSize: number }): string {
  const lines: string[] = [];
  lines.push(`# Corpus verification ${opts.dryRun ? "(DRY-RUN)" : "run"} — ${opts.verifierVersion}`);
  lines.push("");
  lines.push(`Entries scanned: ${result.entries}`);
  const counts = { pass: 0, fail: 0, gate: 0 };
  let zeroAssertion = 0;
  for (const verdicts of Object.values(result.verdictsByEntry)) {
    for (const v of verdicts) {
      counts[v.verdict] += 1;
      if (v.verdict === "gate" && /vacuous|no checkable assertions/i.test(v.reason)) zeroAssertion += 1;
    }
  }
  lines.push(`Verdicts — ${counts.pass} pass, ${counts.fail} fail, ${counts.gate} gated`);
  lines.push(`Zero-assertion prose fields: ${zeroAssertion} (report per prose field before trusting a run)`);
  lines.push("");
  for (const [id, verdicts] of Object.entries(result.verdictsByEntry)) {
    lines.push(`## ${id}`);
    for (const v of verdicts) lines.push(`- ${v.field}: ${v.verdict} — ${v.reason}`);
  }
  lines.push("");
  if (opts.dryRun) {
    lines.push("Next: verify a stratified sample of 30 by eye (10 known-bad, 10 typical, 10 unknown)");
    lines.push("before the full run. Acceptance: >=95% agreement, ZERO missed assertions.");
  }
  return lines.join("\n");
}

function resolveVisionProvider(): string | undefined {
  const provider = (process.env.VERIFY_VISION_PROVIDER ?? "").trim();
  return provider || undefined;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      "limit": { type: "string" },
      "sample-size": { type: "string" },
      "corpus": { type: "string" },
      "out": { type: "string" },
      "vision-provider": { type: "string" },
    },
  });
  const dryRun = values["dry-run"] === true;
  const limit = Number(values.limit);
  const sampleSize = Number(values["sample-size"]) || 30;
  const corpusPath = values.corpus;
  const entries = corpusPath ? JSON.parse((await import("node:fs/promises")).readFile(corpusPath, "utf8")).entries : loadCorpus();
  const pending = selectPending(entries, VERIFIER_VERSION).slice(0, Number.isFinite(limit) && limit > 0 ? limit : undefined);
  const reproduce = makeReproduceDependency(values["vision-provider"] ?? resolveVisionProvider());
  const results: RunResult = { entries: pending.length, verdictsByEntry: {} };
  // The verified map keyed by entry id; non-pending entries are preserved
  // untouched, so persistence below never drops an entry.
  const verifiedById = new Map<string, CorpusEntryT>();
  for (const entry of pending) {
    const imagePath = entry.image?.path ? fromCorpusRelativeImagePath(entry.image.path) : null;
    if (imagePath === null) {
      results.verdictsByEntry[entry.id] = [{ field: "image", verdict: "fail", reason: "no image path" }];
      continue;
    }
    const { records, verdicts } = await verifyEntry(entry, imagePath, {
      now: () => new Date().toISOString().slice(0, 10),
      callVision: async (prompt, image) =>
        callVisionModel(prompt, image, values["vision-provider"] as never, undefined, undefined, "low"),
      reproduce,
    });
    if (!dryRun) mergeVerification(entry, records);
    results.verdictsByEntry[entry.id] = verdicts;
    verifiedById.set(entry.id, entry);
  }
  if (!dryRun) {
    const updated = entries.map((e) => verifiedById.get(e.id) ?? e);
    persistEntries(writableLoadedCorpus(updated), updated);
    console.log(`[verify] persisted ${entries.length} entries (${verifiedById.size} verified)`);
  }
  const report = buildRunReport(results, { dryRun, verifierVersion: VERIFIER_VERSION, sampleSize });
  const outDir = values.out ?? process.cwd();
  writeFileSync(resolve(outDir, "verify-report.md"), report);
  console.log(report);
}

const isMain = (() => {
  const here = process.argv[1] && resolve(process.argv[1]);
  const me = fileURLToPath(import.meta.url);
  return here === me;
})();

if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
```

In `package.json`, add the scripts after `scout:no-vision`:

```json
    "verify": "tsc && node dist/scripts/verify-corpus.js",
    "verify:dry-run": "tsc && node dist/scripts/verify-corpus.js --dry-run",
```

In `.env.example`, add after the scout block:

```bash
# Corpus verifier (npm run verify) — vision verification uses the same
# provider abstraction as the scout; unset values fall back to ambient routing.
#VERIFY_VISION_PROVIDER=openai
#VERIFY_VISION_MODEL=
#VERIFY_VISION_BASE_URL=
#VERIFY_VISION_API_KEY=
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx tsc`
Run: `npx vitest run src/scripts/verify-corpus.test.ts src/wiring-verification.test.ts`
Expected: clean compile; PASS. (The `isMain` guard uses top-level await — confirm the tsconfig module target supports it, as `scout-sources.ts` already uses `import.meta.url` and top-level await patterns; if the linter objects, move the two dynamic imports to the top of the file.)

- [ ] **Step 5: Commit**

```bash
git add src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts package.json .env.example
git commit -m "feat(verify): CLI — dry-run, resume by verifierVersion, report, snapshot-backed persistence"
```

---

## Task 6: Whole-change verification and rollout docs

**Files:**
- Modify: `README.md` (a "Verifying the corpus" section)
- No production code unless a check finds a gap — a found gap is fixed in this task with its own test first.

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: a green full suite, a measured dry-run on the real corpus with sane verdicts, and the operator rollout checklist.

- [ ] **Step 1: Run the full suite and tsc**

Run:
```bash
npx tsc
C2_NO_DOTENV=1 npx vitest run
```
Expected: clean compile; all tests PASS.

- [ ] **Step 2: Run the dry-run over the real corpus and check the sanity signals**

Run: `npm run verify:dry-run`
Expected: the report's verdicts must include FAIL for the audit's known-bad entries (e.g. `alan-alan-ios-screens-5`'s critique must not be confirmed). If a known-bad critique PASSES, the verify prompt or parser is too lenient — fix with a test first. Also read the zero-assertion rate: if it is high (most prose fields gate on empty assertions), the assertion-extraction instructions in `buildVerifyPrompt` are too restrictive — recalibrate and re-measure.

- [ ] **Step 3: Verify resume and idempotence on a small slice**

Run: `npm run verify -- --limit 3` then the same command again.
Expected: the second run re-verifies nothing for the fields stamped in the first (the resume key holds) and the corpus's other keys are untouched.

- [ ] **Step 4: Run the doctor and confirm the standing checks**

Run: `node dist/scripts/doctor.js 2>&1 | grep -i verification`
Expected: verified-field counts appear; any `verification-malformed` / `verification-orphan-key` / `verified-hash-stale` finding from a real run is a bug in this change (the records the verifier writes must satisfy the shipped detectors).

- [ ] **Step 5: Add the README section and the operator rollout checklist**

In `README.md`, after the scout section, add:

```markdown
## Verifying the corpus (Stage 2c)

```bash
npm run verify:dry-run   # reports per-field verdicts, writes nothing
npm run verify           # writes per-field verification records (snapshot-backed)
```

The verifier is independent of the tagger and positively affirms every claim
(default false). Mechanical fields (platform, dominantColors) are recomputed
from the image; everything else goes through an adversarial vision pass.
Failed prose fields are re-produced by the seeing Pass 2 and re-verified. The
doctor is the standing check after any run.

**Before the first full run:** verify a stratified sample of 30 entries by eye
(10 known-bad, 10 typical, 10 unknown) against the actual images. Acceptance:
at least 95% agreement with human verdicts and ZERO missed assertions. A large
day-one pass rate on the known-defective corpus is a failure signal, not a
success — investigate before writing any record.
```

- [ ] **Step 6: Commit**

```bash
git add README.md
git commit -m "docs: verifier rollout checklist and README section"
```

---

## Self-review

**1. Spec coverage:**

- Independence + positive affirmation (invariants) → Task 2 prompt builders, Task 4 fresh re-verify call, Global Constraints.
- Tier table, all 23 keys, `responsiveBehavior` gated → Task 1 `tierForField` (+ test pins all 23).
- `image-confirmed` for pixel evidence with hash → Task 1 (`confirmedRecord` always image-confirmed), Task 4 records.
- Re-derivation semantics (extractQuantizedColors set-match, detectPlatform, missing dimensions) → Task 1.
- Prose assertion enumeration + fail-closed empty set → Task 2 (`decideFieldVerdict` gate on empty assertions) + Task 4 orchestration.
- `layout` checkable subset (count/form/roles with visual descriptions) → Task 2 `claimForField` for `layout` (the prompt lists the role vocabulary); the strict count/form gate is the operator-measured calibration step in Task 6 Step 2.
- Recovery path (verify-first, re-produce only failures, re-verify, fail-again = gated) → Task 4.
- Merge-never-clobber, verifierVersion/verifiedAt, imageSha256 binding → Task 4 (`mergeVerification`, `confirmedRecord`).
- Dry-run first, sample of 30 / >=95% / zero missed assertions, resume key, doctor standing check → Task 5 (report) + Task 6 (rollout).
- Cross-model limitation + shared-context caveat → documented in the spec; the verifier is provider-parameterized (`makeReproduceDependency`, `--vision-provider`) so cross-model is a config change.
- Out of scope respected: no DOM/re-capture tier, no per-entry field-set gating change.

**2. Placeholder scan:** every code step carries complete code. The two deliberately open spots are calibration points, not placeholders: Task 1 Step 4 allows the dominantColors fixture values to be set to the actual `extractQuantizedColors` output of the 1x1 PNG (the assertion that matters is the fail direction), and Task 6 Step 2's zero-assertion rate is a measured bar, not a guessed number.

**3. Type consistency:**

- `VerificationRecord` — Task 1, used in Tasks 1, 4, 5.
- `FieldVerdict` — Task 1, used in Tasks 2, 4, 5.
- `tierForField(field): VerifierTier` — Task 1, used in Tasks 2 and 4.
- `buildVerifyPrompt` / `parseVerifyResponse` / `decideFieldVerdict` — Task 2, used in Task 4.
- `verifyEntry(entry, imagePath, deps)` with `deps = { now, callVision, reproduce }` — Task 4, used in Task 5 with `makeReproduceDependency`.
- `mergeVerification` / `alreadyVerifiedAtVersion` — Task 4, used in Tasks 4 and 5.
- `TaggerInput.critiqueImagePath` — Task 3, used by `makeReproduceDependency` in Task 4.

**Known deliberate reading (flag for reviewers):** non-prose field failures (factual/soft/a11y) are NOT re-produced — the tagger's Pass 2 writes only the four prose fields, so there is no seeing re-producer for them; they stay gated. The spec's "re-produce ONLY the failed fields (the fixed seeing Pass 2)" is read as prose-scoped, and Task 4's tests pin that reading.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-05-corpus-verifier.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
