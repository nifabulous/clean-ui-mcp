# Corpus Verifier Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Stage 2c verifier that writes per-field `provenance.verification` records — independent of the corpus producer and positive-affirming — so the dark corpus starts lighting up with values that were actually checked.

**Architecture:** One CLI (`src/scripts/verify-corpus.ts`) with pure, unit-tested helpers and an injected-dependency orchestrator. Two mechanical fields are recomputed with no model, but at DIFFERENT tiers because their evidence differs: `platform` is `detectPlatform(recorded width, height)` — recomputed from recorded DATA, not pixels — so it is a `provable` record with NO image hash; `visual.dominantColors` is `extractQuantizedColors(image)` — read from PIXELS — so it is an `image-confirmed` record bound to the image hash. All other fields go through one adversarial vision verify pass (`callVisionModel`); if any of the four prose fields fails, the tagger's now-seeing Pass 2 (`TaggerInput.critiqueImagePath`) re-produces ALL prose fields in ONE call and the failed ones are re-verified in a single fresh call. Records merge into `provenance.verification[fieldKey]`, never clobbering other keys, and persist through the snapshot-backed `persistEntries` path.

**Tech Stack:** TypeScript, Vitest, node-vibrant (existing), Playwright-free (no new deps).

**Spec:** `docs/superpowers/specs/2026-08-05-corpus-verifier-design.md`

## Global Constraints

- **The verifier is independent of the producer.** The pass that writes a claim can never be the pass that certifies it. Re-verify (step 4) is a separate call, fresh context, adversarial prompt.
- **Verification is positive affirmation, not refutation-survival.** Every verify prompt asks the model to CONFIRM the described element exists, default false. "Failed to find a problem" never grants trust.
- **Fail-closed everywhere.** A field absent from the verify response is not confirmed. A prose field whose extracted checkable-assertion set is EMPTY is NOT granted ("every assertion holds" is vacuously true over the empty set).
- **Tier by EVIDENCE, not by whether a model ran.** The record shape binds `imageSha256` only to `image-confirmed` (`corpus-trust.ts:82`), and the doctor's staleness checks run only for that method (`doctor-helpers.ts:561-588`). `visual.dominantColors` is read from PIXELS → `method: "image-confirmed"` WITH the hash, so a re-capture trips `verified-hash-stale`. `platform` is `detectPlatform` over recorded `image.width`/`height` — DATA, not pixels; the schema's own definition reserves `image-confirmed`+hash for "the exact bytes the verifier saw" (`schema.ts:611-615`), so binding a dimension check to the pixel hash would attest to bytes it never read. `platform` is therefore `method: "provable"` with NO `imageSha256`. (This refines the spec's looser "measured" label for both: `measured` means live-DOM evidence, which neither has.)
- **Merge, never clobber.** The verifier writes `provenance.verification[fieldKey]`; existing records under other keys are untouched. Re-running is idempotent for fields that still pass.
- **Every record carries `verifierVersion`** (a module constant) and `verifiedAt`. Selective re-verification scans for `verifierVersion < N` (or absent).
- **`responsiveBehavior` is never granted** — a single screenshot cannot confirm cross-viewport behaviour. No code path may write a record for it.
- **Writes go through the persistence path** (`persistEntries`/`writableLoadedCorpus` in `src/persistence.ts`) for the default corpus, or back to the `--corpus` file when that isolation seam is used — never a raw write to the real store while a `--corpus` override is active. A `--dry-run` writes nothing; a `--estimate` calls no model at all.
- **Resume key is (entry id, field key) and MUST converge.** A field that PASSES earns an `image-confirmed`/`provable` record in `provenance.verification`; a field that FAILS or gates earns a marker in `provenance.verifyAttempts` (a SIBLING map, `{verifierVersion, verifiedAt}`, no method, no hash). A field is "processed at this version" when it carries the current `verifierVersion` in EITHER map. The two maps are **mutually exclusive per field**: a pass revokes any stale `verifyAttempts` marker, and a fail/gate DELETES any stale `verification` record (not just shadows it). Revocation is load-bearing because `isVerified` ignores `verifierVersion` (`corpus-trust.ts:75`) — so a field that passed at v1 but fails at a bumped v2 would keep serving its stale v1 record unless the v2 fail deletes it. Resume markers live OUTSIDE `verification` on purpose: `verification` is the trust contract (`isVerified` serves only its records; the doctor's `verification-malformed` detector rejects any non-`VERIFICATION_METHODS` method there), so a non-trust marker written into it would fail-close on serving but ALSO flood the doctor with malformed findings across a 93%-defective corpus. `isVerified` never reads `verifyAttempts`, so a failed field is never served. Without this convergence, any entry with a permanently-failing field would re-run the full vision cost every invocation. **Limitation:** a `verifyAttempts` marker suppresses re-verification of a later curator edit to that field until `verifierVersion` is bumped — the accepted cost of convergence, visible because a bump re-verifies everything below it.
- **Re-derivation semantics:** `visual.dominantColors` reuses `extractQuantizedColors(imagePath)` (`tagger.ts:272`, which lower-cases and caps at 6 swatches); match is an order-insensitive SET match (every recorded color must appear in the extracted set). This holds because the tagger overwrites `dominantColors` with the verbatim quantized set (`tagger.ts:2903`) — the recorded value IS a prior extraction of the same bytes. Entries tagged before that override, or where extraction returned empty (fell back to the `["#ffffff","#111111"]` default), will legitimately FAIL the mechanical check and drop to gated — the safe direction. `platform` recomputes via `detectPlatform(width, height)` (`schema.ts:184`) against the entry's recorded image dimensions; missing dimensions fail the field.
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
| `src/schema.ts` | **Modify.** Add `provenance.verifyAttempts` — the resume-marker namespace, sibling to `verification`. |
| `package.json` | **Modify.** `verify`, `verify:dry-run`, and `verify:estimate` scripts. |
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
```

(`type VerifierTier` is already imported at the top of the test for the `expected` map's annotation.)

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

/** A fresh image-confirmed record bound to the exact bytes the verifier read. */
function confirmedRecord(imagePath: string, now: string): VerificationRecord {
  return {
    method: "image-confirmed",
    verifiedAt: now,
    verifierVersion: VERIFIER_VERSION,
    imageSha256: imageSha256Of(imagePath),
  };
}

/**
 * A fresh `provable` record — recomputable from recorded DATA, not pixels, so it
 * carries NO image hash (the schema reserves the hash for image-confirmed, whose
 * evidence is the bytes seen; `schema.ts:611-615`).
 */
function provableRecord(now: string): VerificationRecord {
  return { method: "provable", verifiedAt: now, verifierVersion: VERIFIER_VERSION };
}

/**
 * Re-derivable fields — no model — at DIFFERENT tiers because their evidence
 * differs. `platform` is recomputed from recorded dimensions → `provable`, no
 * hash. `visual.dominantColors` is read from pixels → `image-confirmed` bound to
 * the hash the doctor's staleness checks read (`doctor-helpers.ts:561-588`).
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
      records.platform = provableRecord(now);
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
Expected: PASS. The pass-direction test derives its recorded color from `extractQuantizedColors(imagePath)` at runtime and guards `extracted.length > 0`, so it is robust to Vibrant quantization and version drift — no hand-tuning of hex values. If the guard fails, the fixture PNG is too small to yield a palette; enlarge it, do not weaken the guard.

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
- Modify: `src/tagger.ts` (the `TaggerInput` interface and the two Pass-2 `callModel` sites in `tagImage`: `:3023-3032` with the `null` image at `:3026`, and the retry `:3053-3062` with `null` at `:3056`)
- Modify: `src/tagger.test.ts` (the pinned "Pass 2 has no image input" test around `:660-705`)

**Interfaces:**
- Consumes: `tagImage` as it exists today.
- Produces: `TaggerInput.critiqueImagePath?: string` — when set, Pass 2 (initial and retry) passes the image to `callModel` instead of `null`, so the critique pass finally SEES the screenshot. When unset, behavior is byte-identical (the existing test pins this). Task 4 calls `tagImage` with this option to re-produce failed prose fields.
- Scope note: this closes the blind Pass 2 in `tagImage` only. The deferred `generateCritique` path (`tagger.ts:3156`, used by `/api/auto-critique`) still runs Pass 2 text-only (`null` image at `:3197`, retry `:3215`). The verifier's re-produce goes through `tagImage` (`makeReproduceDependency`), so it always sees the image; `generateCritique` is out of scope here and left as-is deliberately.

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
   * failed verification: the fabrication source for the existing corpus is
   * `tagImage`'s Pass 2 running text-only (`tagger.ts:3026`), and re-producing
   * against the pixels is the fix for those entries. (The deferred
   * `generateCritique` path stays text-only — see the scope note above — so
   * this closes the source for tagImage-produced entries, not every path.)
   * Unset keeps the historical text-only behaviour byte-identical.
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
- Modify: `src/schema.ts` (add `provenance.verifyAttempts` — the resume-marker namespace)

**Interfaces:**
- Consumes: Tasks 1-3 (`verifyMechanicalFields`, `buildVerifyPrompt`, `parseVerifyResponse`, `decideFieldVerdict`, `VERIFIER_VERSION`, `tagImage`'s `critiqueImagePath`).
- Produces: `verifyEntry(entry, imagePath, deps): Promise<{ records: Record<string, VerificationRecord>; verdicts: FieldVerdict[] }>` where `deps = { callVision, reproduce, now }`; `mergeVerification(entry, records): void` (mutates `provenance.verification`, never clobbering other keys); `alreadyProcessedAtVersion(entry, field, version): boolean` (the resume check — true for a pass OR a recorded attempt); `applyReproducedProse(entry, tagged): CorpusEntryT` (strip `[DRAFT]` markers, preserve antiPatterns siblings). Task 5 consumes all. Also **modifies `src/schema.ts`** to add `provenance.verifyAttempts` (below).

- [ ] **Step 1: Write the failing tests**

Append to `src/scripts/verify-corpus.test.ts`:

```ts
import { verifyEntry, mergeVerification, alreadyProcessedAtVersion, applyReproducedProse } from "./verify-corpus.js";

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
```

Note the orchestration contract encoded in the tests: re-production runs at most ONCE per entry (not once per field) — the seeing Pass 2 rewrites all four prose fields together, so an entry with N failing prose fields still costs one `reproduce` call plus one batched re-verify call, never N of each. A re-verify that still fails leaves the field with NO record and verdict `fail`. Non-prose failures (factual/soft/a11y) also get no record (there is no seeing Pass 2 for them) but are NOT re-produced — the re-produce path covers only the four prose fields the tagger's Pass 2 writes, and a dedicated test pins that a failing factual field is neither re-produced nor recorded. Every non-pass field is later stamped with a resume marker in `provenance.verifyAttempts` by Task 5 (`resumeMarkers`/`mergeVerifyAttempts`) so the resume queue converges. The re-produce path stores its result through `applyReproducedProse`, which strips the tagger's `[DRAFT]` markers and preserves `antiPatterns`' non-prose siblings — the raw tagImage prose is never stored.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/scripts/verify-corpus.test.ts`
Expected: FAIL — the four functions are not defined.

- [ ] **Step 3: Write the minimal implementation**

First, add the resume-marker namespace to `src/schema.ts` — a SIBLING of `verification`, not a member of it. Only trust-granting records live in `provenance.verification` (that is the contract the doctor's `verification-malformed` detector and `isVerified` enforce, `corpus-trust.ts:75` / `doctor-helpers.ts:531`); a resume marker is bookkeeping, not evidence, so it must live outside. Zod strips unknown keys by default, so without this field the markers would silently vanish on the next `loadCorpus` parse. In the `provenance: z.object({ … })` block, after the `verification` record (currently ending `}).passthrough()).optional(),`), add:

```ts
    /**
     * Resume bookkeeping for the Stage 2c verifier — NOT verification. Maps a
     * field key to the verifierVersion at which the field was EVALUATED and did
     * not earn trust (failed or gated). A re-run skips it instead of re-spending
     * the vision cost; `isVerified` never reads this map, so an attempted field
     * is never served. Kept out of `verification` so that map stays trust-only
     * and the doctor's malformed-method detector stays strict.
     */
    verifyAttempts: z.record(z.string(), z.object({
      verifierVersion: z.string().min(1),
      verifiedAt: z.string().min(1),
    }).passthrough()).optional(),
```

Then append to `src/scripts/verify-corpus.ts`:

```ts
import type { CorpusEntryT } from "../schema.js";
import { tagImage, type TaggerOutput } from "../tagger.js";

/**
 * A field is "processed at this version" if it carries EITHER a trust record
 * (`provenance.verification` — a pass) OR a resume marker
 * (`provenance.verifyAttempts` — a fail/gate). Both stop re-verification; only
 * the first is served by `isVerified`.
 */
export function alreadyProcessedAtVersion(entry: CorpusEntryT, field: string, version: string): boolean {
  return entry.provenance?.verification?.[field]?.verifierVersion === version
    || entry.provenance?.verifyAttempts?.[field]?.verifierVersion === version;
}

/**
 * Write trust records into `provenance.verification`, never clobbering OTHER
 * fields' keys. A pass also REVOKES any stale `verifyAttempts` marker for the
 * same field, so the two maps stay mutually exclusive per field.
 */
export function mergeVerification(entry: CorpusEntryT, records: Record<string, VerificationRecord>): void {
  const provenance = entry.provenance ?? { taggedBy: "auto" as const };
  const verification = { ...(provenance.verification ?? {}) };
  const verifyAttempts = provenance.verifyAttempts ? { ...provenance.verifyAttempts } : undefined;
  for (const [field, record] of Object.entries(records)) {
    verification[field] = record;
    if (verifyAttempts) delete verifyAttempts[field];
  }
  provenance.verification = verification;
  if (verifyAttempts) provenance.verifyAttempts = verifyAttempts;
  entry.provenance = provenance;
}

const PROSE_FIELDS: readonly string[] = ["critique", "whatToSteal", "antiPatterns", "voice"];

/**
 * Map a re-produced tagImage result onto the entry's prose fields, ready to
 * REPLACE the fabricated values. Two things the raw tagImage output would break
 * if stored verbatim (both invisible to the stubbed unit tests, so this is its
 * own pure, tested helper):
 *   1. tagImage prefixes prose with `[DRAFT — REWRITE]` / `[DRAFT] ` markers
 *      (`tagger.ts:3116-3123`). Storing them and stamping `image-confirmed`
 *      would serve "rewrite me" text as verified. Strip them.
 *   2. `antiPatterns` is an OBJECT `{ antiPatterns, whereThisFails,
 *      accessibilityRisks }`. `antiPatterns.accessibilityRisks` is its OWN
 *      servable field, verified independently. Replacing the whole object would
 *      clobber it (and reset whereThisFails). Swap ONLY the inner prose array.
 */
export function applyReproducedProse(
  entry: CorpusEntryT,
  // `tagged` is a tagImage result (TaggerOutput), NOT a CorpusEntryT — its
  // antiPatterns lacks legacyAccessibilityNotes and types accessibilityRisks'
  // confidence as string, so a CorpusEntryT Pick would not accept it. The body
  // reads only `tagged.antiPatterns.antiPatterns` (+ voice/critique/whatToSteal),
  // all of which assign cleanly into CorpusEntryT.
  tagged: Pick<TaggerOutput, "critique" | "whatToSteal" | "antiPatterns" | "voice">,
): CorpusEntryT {
  const stripDraft = (s: string): string => s.replace(/^\[DRAFT[^\]]*\]\s*/, "");
  return {
    ...entry,
    critique: stripDraft(tagged.critique),
    whatToSteal: tagged.whatToSteal.map(stripDraft),
    antiPatterns: { ...entry.antiPatterns, antiPatterns: tagged.antiPatterns.antiPatterns.map(stripDraft) },
    voice: tagged.voice,
  };
}

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
      && !alreadyProcessedAtVersion(entry, field, VERIFIER_VERSION),
  );
  if (pending.length > 0) {
    const parsed = parseVerifyResponse(await deps.callVision(buildVerifyPrompt(entry, pending, VERIFIER_VERSION), imagePath));

    // First pass: an initial verdict per pending field, from the ONE combined call.
    const decided = new Map<string, FieldVerdict>();
    for (const field of pending) {
      const claim = claimForField(entry as unknown as Record<string, unknown>, field);
      decided.set(
        field,
        claim === null
          ? { field, verdict: "gate", reason: "no recorded value to verify" }
          : decideFieldVerdict(field, tierForField(field), parsed[field] ?? { confirmed: false }),
      );
    }

    // 3. Re-produce ONCE if any prose field failed. The seeing Pass 2 rewrites
    // ALL prose fields in a single tagImage call — never re-tag per field — and
    // the failed ones are re-verified in ONE fresh independent call (step 4).
    const failedProse = PROSE_FIELDS.filter((f) => decided.get(f)?.verdict === "fail");
    if (failedProse.length > 0) {
      const reproduced = await deps.reproduce(entry, imagePath);
      const reFields = failedProse.filter(
        (f) => claimForField(reproduced as unknown as Record<string, unknown>, f) !== null,
      );
      const reParsed: Record<string, { confirmed: boolean; assertions?: string[]; reason?: string }> = reFields.length > 0
        ? parseVerifyResponse(await deps.callVision(buildVerifyPrompt(reproduced as unknown as Record<string, unknown>, reFields, VERIFIER_VERSION), imagePath))
        : {};
      for (const field of failedProse) {
        if (!reFields.includes(field)) {
          decided.set(field, { field, verdict: "gate", reason: "re-production wrote no value for this field" });
          continue;
        }
        const reVerdict = decideFieldVerdict(field, "prose", reParsed[field] ?? { confirmed: false });
        decided.set(field, reVerdict);
        if (reVerdict.verdict === "pass") {
          // The re-produced value replaces the fabricated one only after it
          // passed, so the stored value and the record agree.
          (entry as unknown as Record<string, unknown>)[field] = (reproduced as unknown as Record<string, unknown>)[field];
        }
      }
    }

    // Finalize: a passed field earns an image-confirmed record; the caller adds
    // resume markers for the rest (see Task 5 `resumeMarkers`/`mergeVerifyAttempts`).
    for (const field of pending) {
      const verdict = decided.get(field)!;
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
    // Strip [DRAFT] markers and preserve antiPatterns' non-prose siblings —
    // NEVER return raw tagImage prose for storage. See applyReproducedProse.
    return applyReproducedProse(entry, tagged);
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
- Consumes: Task 4 (`verifyEntry`, `mergeVerification`, `makeReproduceDependency`, `VERIFIER_VERSION`).
- Produces: `buildRunReport(results, opts): string` (the curator report); `selectPending(entries, version): CorpusEntryT[]` (the resume selection); `resumeMarkers(verdicts, now, version): Record<string, VerifyAttempt>` + `mergeVerifyAttempts(entry, attempts): void` (the convergence markers, written to `provenance.verifyAttempts`); `buildEstimate(pending): string` (cost projection, no model); `main()` with `--dry-run`, `--estimate`, `--limit`, `--sample-size`, `--corpus`, `--out`, `--vision-provider`. Persistence via `loadCorpus()` / `persistEntries(writableLoadedCorpus(entries), entries)` for the default corpus, or a synchronous write-back to the `--corpus` file when that seam is active.

- [ ] **Step 1: Write the failing tests**

Append to `src/scripts/verify-corpus.test.ts`:

```ts
import { buildRunReport, selectPending, resumeMarkers, mergeVerifyAttempts, buildEstimate } from "./verify-corpus.js";

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
import { callVisionModel, type Provider } from "../tagger.js";
import { parseArgs } from "node:util";

export interface RunResult {
  entries: number;
  verdictsByEntry: Record<string, FieldVerdict[]>;
}

export function selectPending(entries: readonly CorpusEntryT[], version: string): CorpusEntryT[] {
  return entries.filter((e) => {
    // No image reference → nothing this stage can verify → never pending (else
    // it sits in the queue forever). main()'s no-image guard writes no marker.
    if (!e.image?.path) return false;
    const verification = e.provenance?.verification ?? {};
    const attempts = e.provenance?.verifyAttempts ?? {};
    // Pending when ANY VERIFIABLE servable field is not yet PROCESSED at this
    // version — neither a trust record (a pass) NOR an attempt marker (a
    // recorded fail/gate). Gated fields (responsiveBehavior) never count — they
    // can never carry a record, so they must not keep a finished entry queued.
    return Object.keys(TIER_BY_FIELD)
      .filter((field) => tierForField(field) !== "gated")
      .some((field) => verification[field]?.verifierVersion !== version
        && attempts[field]?.verifierVersion !== version);
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

/** A resume marker — bookkeeping, NOT a trust record. Lives in `verifyAttempts`. */
export type VerifyAttempt = { verifierVersion: string; verifiedAt: string };

/**
 * Markers for the fields a run evaluated but did not pass, so the resume queue
 * converges instead of re-spending the full vision cost on every run. A pass
 * earns its own image-confirmed/provable record instead; a gated-tier field
 * (responsiveBehavior — and any non-servable stray, which `tierForField` maps to
 * "gated") is never persisted. These go into `provenance.verifyAttempts`, NOT
 * `provenance.verification`: `isVerified` never reads verifyAttempts, so a failed
 * field is never served, and the doctor's `verification-malformed` detector
 * never sees a non-trust method.
 */
export function resumeMarkers(
  verdicts: readonly FieldVerdict[],
  now: string,
  version: string,
): Record<string, VerifyAttempt> {
  const out: Record<string, VerifyAttempt> = {};
  for (const v of verdicts) {
    if (v.verdict === "pass") continue;
    if (tierForField(v.field) === "gated") continue;
    out[v.field] = { verifierVersion: version, verifiedAt: now };
  }
  return out;
}

/**
 * Write attempt markers into `provenance.verifyAttempts`, never clobbering OTHER
 * fields' keys. A fail/gate also REVOKES any stale `verification` trust record
 * for the same field — critical because `isVerified` ignores `verifierVersion`
 * (`corpus-trust.ts:75`), so on a version bump a field that passed at v1 but
 * fails at v2 would otherwise keep serving its stale v1 record. The record must
 * be DELETED, not shadowed.
 */
export function mergeVerifyAttempts(entry: CorpusEntryT, attempts: Record<string, VerifyAttempt>): void {
  const provenance = entry.provenance ?? { taggedBy: "auto" as const };
  const verifyAttempts = { ...(provenance.verifyAttempts ?? {}) };
  const verification = provenance.verification ? { ...provenance.verification } : undefined;
  for (const [field, attempt] of Object.entries(attempts)) {
    verifyAttempts[field] = attempt;
    if (verification) delete verification[field];
  }
  provenance.verifyAttempts = verifyAttempts;
  if (verification) provenance.verification = verification;
  entry.provenance = provenance;
}

/**
 * Projected model cost for a pending set — NO model is called. One combined
 * verify per entry, plus at most one batched prose re-verify per entry that has
 * any prose value, plus the two-pass tagImage re-produce for those entries.
 */
export function buildEstimate(pending: readonly CorpusEntryT[]): string {
  const n = pending.length;
  const withProse = pending.filter((e) =>
    PROSE_FIELDS.some((f) => claimForField(e as unknown as Record<string, unknown>, f) !== null),
  ).length;
  const maxVision = n + withProse;   // combined verify per entry + one re-verify per prose entry
  const maxTag = withProse * 2;      // reproduce = 2 tagger passes, once per prose entry
  return [
    "Projected cost (no model called):",
    `  entries pending: ${n}`,
    `  vision verify calls: ${n}-${maxVision}`,
    `  re-produce tagger passes (worst case): ${maxTag}`,
    `  total model calls (worst case): ${maxVision + maxTag}`,
  ].join("\n");
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
      "estimate": { type: "boolean", default: false },
      "limit": { type: "string" },
      "sample-size": { type: "string" },
      "corpus": { type: "string" },
      "out": { type: "string" },
      "vision-provider": { type: "string" },
    },
  });
  const dryRun = values["dry-run"] === true;
  const estimate = values.estimate === true;
  const limit = Number(values.limit);
  const sampleSize = Number(values["sample-size"]) || 30;
  const corpusPath = values.corpus;

  // --corpus is the isolation seam. Read it SYNCHRONOUSLY (the earlier
  // `JSON.parse(readFile(...))` never awaited the promise) and write results
  // back to the SAME file so a run against a temp corpus can never touch the
  // real corpus/entries.json.
  const rawCorpus = corpusPath ? JSON.parse(readFileSync(corpusPath, "utf8")) : null;
  const entries: CorpusEntryT[] = rawCorpus ? (rawCorpus.entries as CorpusEntryT[]) : loadCorpus();
  const pending = selectPending(entries, VERIFIER_VERSION).slice(0, Number.isFinite(limit) && limit > 0 ? limit : undefined);

  // --estimate: project the model cost and exit WITHOUT calling any model.
  if (estimate) {
    console.log(buildEstimate(pending));
    return;
  }

  const reproduce = makeReproduceDependency(values["vision-provider"] ?? resolveVisionProvider());
  const results: RunResult = { entries: pending.length, verdictsByEntry: {} };
  // The verified map keyed by entry id; non-pending entries are preserved
  // untouched, so persistence below never drops an entry.
  const verifiedById = new Map<string, CorpusEntryT>();
  for (const entry of pending) {
    // Per-entry try/catch: a malformed image path (fromCorpusRelativeImagePath
    // THROWS, paths.ts:142) or a vision/tag error records a per-entry failure and
    // the run CONTINUES, instead of propagating to main().catch and aborting
    // every remaining entry mid-run.
    try {
      const imagePath = entry.image?.path ? fromCorpusRelativeImagePath(entry.image.path) : null;
      if (imagePath === null) {
        results.verdictsByEntry[entry.id] = [{ field: "image", verdict: "fail", reason: "no image path" }];
        continue;
      }
      const now = new Date().toISOString().slice(0, 10);
      // verifyEntry MUTATES its entry (value replacement on re-verify pass). Under
      // --dry-run, clone so the cached loadCorpus() array is never mutated in place.
      const target = dryRun ? structuredClone(entry) : entry;
      const { records, verdicts } = await verifyEntry(target, imagePath, {
        now: () => now,
        callVision: async (prompt, image) =>
          // `--vision-provider` is an operator-supplied provider name; an unset
          // value resolves through callModel's ambient routing.
          callVisionModel(prompt, image, values["vision-provider"] as Provider | undefined, undefined, undefined, "low"),
        reproduce,
      });
      if (!dryRun) {
        // Passes earn trust records in `verification`; every other evaluated field
        // earns a resume marker in `verifyAttempts` (a SIBLING map) so the queue
        // converges without polluting the trust map or tripping the doctor. A
        // pass revokes a stale marker and a fail revokes a stale record, so the
        // two maps stay mutually exclusive per field across version bumps.
        mergeVerification(entry, records);
        mergeVerifyAttempts(entry, resumeMarkers(verdicts, now, VERIFIER_VERSION));
      }
      results.verdictsByEntry[entry.id] = verdicts;
      verifiedById.set(entry.id, entry);
    } catch (err) {
      results.verdictsByEntry[entry.id] = [{ field: "entry", verdict: "fail", reason: err instanceof Error ? err.message : String(err) }];
    }
  }
  if (!dryRun) {
    const updated = entries.map((e) => verifiedById.get(e.id) ?? e);
    if (corpusPath) {
      writeFileSync(resolve(corpusPath), JSON.stringify({ ...rawCorpus, entries: updated }, null, 2));
      console.log(`[verify] wrote ${updated.length} entries to ${corpusPath} (${verifiedById.size} verified)`);
    } else {
      persistEntries(writableLoadedCorpus(updated), updated);
      console.log(`[verify] persisted ${entries.length} entries (${verifiedById.size} verified)`);
    }
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
    "verify:estimate": "tsc && node dist/scripts/verify-corpus.js --estimate",
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
Expected: clean compile; PASS. All imports are static top-level (the corpus file is read synchronously via `readFileSync`, so there is no dynamic `import()` and no top-level await); the `isMain` block is a synchronous IIFE. `scout-sources.ts` is the precedent for the `import.meta.url` main-guard pattern.

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
- Produces: a green full suite, a cost estimate plus a bounded dry-run with sane verdicts, and the operator rollout checklist.

- [ ] **Step 1: Run the full suite and tsc**

Run:
```bash
npx tsc
C2_NO_DOTENV=1 npx vitest run
```
Expected: clean compile; all tests PASS.

- [ ] **Step 2: Estimate first, then a BOUNDED dry-run, and check the sanity signals**

`--dry-run` spends the full model budget (it makes every call, only withholding writes), so estimate first and bound the calibration run:

```bash
npm run verify:estimate                        # projected call count, spends nothing
npm run verify:dry-run -- --limit 20           # a bounded calibration slice
```
Expected: the report's verdicts must include FAIL for the audit's known-bad entries (e.g. `alan-alan-ios-screens-5`'s critique must not be confirmed — include it in the slice). If a known-bad critique PASSES, the verify prompt or parser is too lenient — fix with a test first. Also read the zero-assertion rate: if it is high (most prose fields gate on empty assertions), the assertion-extraction instructions in `buildVerifyPrompt` are too restrictive — recalibrate and re-measure. A large day-one PASS rate on the known-defective corpus is a failure signal, not success.

- [ ] **Step 3: Verify resume and idempotence on an ISOLATED copy**

Never run the writing verifier against the real corpus in a test step. Copy it first, then drive the run through the `--corpus` seam:

```bash
cp corpus/entries.json /tmp/verify-corpus-copy.json
npm run verify -- --corpus /tmp/verify-corpus-copy.json --limit 3
npm run verify -- --corpus /tmp/verify-corpus-copy.json --limit 3   # second run
git diff --quiet -- corpus/entries.json   # MUST pass: the real corpus was never touched
```
Expected: `corpus/entries.json` is byte-identical (the isolation seam holds). The second run re-verifies nothing — passed fields carry image-confirmed/provable records and FAILED fields carry `attempted` markers, both at the current `verifierVersion`, so `selectPending` finds the slice done. Also run `npm run verify:estimate` and confirm it prints a projected call count and makes NO network call.

- [ ] **Step 4: Run the doctor and confirm the standing checks**

Run: `node dist/scripts/doctor.js 2>&1 | grep -i verification`
Expected: verified-field counts appear; any `verification-malformed` / `verification-orphan-key` / `verified-hash-stale` finding from a real run is a bug in this change (the records the verifier writes must satisfy the shipped detectors). Resume markers are INERT to the doctor because they live in `provenance.verifyAttempts`, NOT `provenance.verification` — the doctor's per-record loop (`doctor-helpers.ts:531`) only iterates `verification`, so it never sees them, and the `verification-malformed` detector stays strict for real trust records. Confirm the doctor reports no `verification-malformed` flood after a real run (the failure mode if markers had been written into `verification`).

- [ ] **Step 5: Add the README section and the operator rollout checklist**

In `README.md`, after the scout section, add:

```markdown
## Verifying the corpus (Stage 2c)

```bash
npm run verify:estimate  # projects the model-call count, calls NOTHING
npm run verify:dry-run    # runs the full verify (spends model budget), writes nothing
npm run verify            # writes per-field verification records (snapshot-backed)
```

Note the difference: `--estimate` is the cheap projection to run FIRST; `--dry-run`
makes the real model calls and only withholds the writes, so it costs a full run.

The verifier is independent of the tagger and positively affirms every claim
(default false). `platform` is recomputed from recorded dimensions (a `provable`
record, no image hash); `dominantColors` is re-extracted from the pixels (an
`image-confirmed` record bound to the hash). Everything else goes through an
adversarial vision pass; failed prose fields are re-produced ONCE by the seeing
Pass 2 and re-verified. Failed/gated fields get an inert `attempted` marker so
re-runs converge instead of re-spending the vision cost. The doctor is the
standing check after any run.

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
- Tier by EVIDENCE: `visual.dominantColors` pixels → `image-confirmed`+hash (`confirmedRecord`); `platform` recorded dimensions → `provable`, no hash (`provableRecord`). Refines the spec's looser "measured" label for both (neither is live-DOM). → Task 1.
- Re-derivation semantics (extractQuantizedColors set-match, `dominantColors` override at `tagger.ts:2903`, detectPlatform, missing dimensions) → Task 1 + Global Constraints.
- Prose assertion enumeration + fail-closed empty set → Task 2 (`decideFieldVerdict` gate on empty assertions) + Task 4 orchestration.
- `layout` checkable subset (count/form/roles with visual descriptions) → Task 2 `claimForField` for `layout` (the prompt lists the role vocabulary); the strict count/form gate is the operator-measured calibration step in Task 6 Step 2.
- Recovery path (verify-first, re-produce ONCE per entry for all failed prose, re-verify batched, fail-again = gated) → Task 4. Re-produced values stored via `applyReproducedProse`: `[DRAFT]` markers stripped, `antiPatterns` non-prose siblings (incl. the separately-verified `accessibilityRisks`) preserved. Pinned by an `applyReproducedProse` test and a reproduce-once counter test.
- Resume CONVERGENCE: pass → trust record in `verification`; fail/gate → marker in the SIBLING `provenance.verifyAttempts` (`resumeMarkers`/`mergeVerifyAttempts`) so re-runs skip evaluated fields. Kept out of `verification` so `isVerified`, the doctor's malformed detector, and serving all stay strict → Task 5. Doctor-inert by construction (Task 6 Step 4). The two maps are mutually exclusive per field — a fail/gate REVOKES (deletes) a stale passing record because `isVerified` ignores `verifierVersion`; pinned by version-bump revocation tests.
- Cost honesty: `--estimate` projects the call count with NO model call (`buildEstimate`); `--dry-run` runs the full verify without writing → Task 5, README (Task 6 Step 5).
- Isolation seam: `--corpus` reads synchronously and writes back to the same file, never the real store → Task 5 `main`, exercised in Task 6 Step 3.
- Merge-never-clobber, verifierVersion/verifiedAt, imageSha256 binding → Task 4 (`mergeVerification`, `confirmedRecord`).
- Sample of 30 / >=95% / zero missed assertions, resume key, doctor standing check → Task 5 (report) + Task 6 (rollout).
- Cross-model limitation + shared-context caveat → documented in the spec; the verifier is provider-parameterized (`makeReproduceDependency`, `--vision-provider`) so cross-model is a config change.
- Out of scope respected: no DOM/re-capture tier, no per-entry field-set gating change; the deferred `generateCritique` blind path is left as-is deliberately (Task 3 scope note).

**2. Placeholder scan:** every code step carries complete code. The one deliberately open spot is a calibration point, not a placeholder: Task 6 Step 2's zero-assertion rate is a measured bar, not a guessed number. Task 1's dominantColors pass test derives its recorded color from `extractQuantizedColors` at runtime and guards a non-empty palette, so there are no hand-tuned hex fixtures.

**3. Type consistency:**

- `VerificationRecord` — Task 1, used in Tasks 1, 4, 5.
- `FieldVerdict` — Task 1, used in Tasks 2, 4, 5.
- `tierForField(field): VerifierTier` — Task 1, used in Tasks 2 and 4.
- `buildVerifyPrompt` / `parseVerifyResponse` / `decideFieldVerdict` — Task 2, used in Task 4.
- `verifyEntry(entry, imagePath, deps)` with `deps = { now, callVision, reproduce }` — Task 4, used in Task 5 with `makeReproduceDependency`.
- `mergeVerification` / `alreadyProcessedAtVersion` / `applyReproducedProse` — Task 4, used in Tasks 4 and 5.
- `resumeMarkers(verdicts, now, version): Record<string, VerifyAttempt>` / `mergeVerifyAttempts(entry, attempts)` / `buildEstimate(pending)` — Task 5, used in `main` and pinned by Task 5 tests. `VerifyAttempt` shape matches the `provenance.verifyAttempts` schema record added in Task 4.
- `TaggerInput.critiqueImagePath` — Task 3, used by `makeReproduceDependency` in Task 4.

**Known deliberate reading (flag for reviewers):** non-prose field failures (factual/soft/a11y) are NOT re-produced — the tagger's Pass 2 writes only the four prose fields, so there is no seeing re-producer for them; they stay gated. The spec's "re-produce ONLY the failed fields (the fixed seeing Pass 2)" is read as prose-scoped, and Task 4's tests pin that reading.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-05-corpus-verifier.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
