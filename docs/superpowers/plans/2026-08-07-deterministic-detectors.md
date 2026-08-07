# Deterministic Detectors + Verdict Taxonomy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace unstable model verdicts on perception fields with calibrated pixel detectors, widen the verdict taxonomy to `pass | contradicted | abstain | gate` with corroborated model contradictions, and wire the trust records, suspect report, telemetry, and rollout that light the corpus back up.

**Architecture:** `verifyMechanicalFields` becomes a detector registry (`src/verify/detector-registry.ts`) over per-field detectors (`src/verify/detectors/*.ts`) sharing one lazily-decoded raw buffer per entry (`src/verify/ctx.ts`). Certifying detectors remove their fields from the vision path only for affirmable recorded values; contradiction-only detectors (`visual.colorRoles`, `antiPatterns.accessibilityRisks`) run beside vision and can disprove but never grant a pass. Model verdicts become three-way (confirmed / contradicted / abstain), and a model `contradicted` is corroborated by a second fresh ask before it writes anything. Records land in three mutually-exclusive `provenance` maps (`verification`, `verifyAttempts`, `dataQuality`), feeding `--report-suspect`, doctor checks, and per-detector run telemetry.

**Tech Stack:** TypeScript (ESM, NodeNext), vitest, sharp (raw pixel decode + fixture generation), culori (NEW dependency — ΔE2000, wcagContrast), the existing `src/scripts/verify-corpus.ts` CLI.

**Spec:** `docs/superpowers/specs/2026-08-07-deterministic-detectors-design.md` (commits `25046ea`..`5da2a0c`). Read it before starting; where this plan and the spec disagree, the spec wins and this plan is wrong.

## Global Constraints

- **Value-dependent certifying:** a certifying detector may emit `pass` only for recorded values its `canAffirm` accepts. `visual.usesShadows` / `visual.usesBorders`: `true` only. `visual.cornerStyle`: `sharp`, `slight-round`, `pill` only (`mixed` never affirms). `visual.accentColor`: any parseable hex. `visual.spacingDensity`: all enum values. `platform` / `visual.dominantColors`: any recorded value.
- **Absence invariant:** no detected signal is never `pass`. A solid-colour image → `abstain`, not "no borders present". Recorded-`false` claims can only ever be `contradicted` (signal found) or `abstain` (none found); the model must still be able to affirm them, so they STAY in the vision pending list.
- **cornerStyle buckets map to the schema vocabulary** (`CornerStyle = sharp | slight-round | pill | mixed`): 0–2px `sharp`, 3–20px `slight-round`, >20px `pill`. There is no `square` or `rounded` value. `mixed` → detector `abstain`, field stays in vision.
- **Contradiction-only detectors never emit `pass`** (`visual.colorRoles`, `antiPatterns.accessibilityRisks`); the runner downgrades any computed pass to `abstain`.
- **Runner caps:** a certifying detector on a non-affirmable recorded value is capped at `contradicted`/`abstain`. The band wins: `confidence` inside `[band.low, band.high]` → `abstain`, even when the raw verdict was `pass` or `contradicted`.
- **Model contradictions are corroborated** by a second fresh-context ask before any write; the second ask uses the same positive-affirmation prompt, never a "do you still disagree" prompt.
- **Record-map exclusivity:** a field appears in at most one of `provenance.verification` / `verifyAttempts` / `dataQuality`; writing to one revokes the other two for that field.
- **`--detectors off` restores the legacy PENDING LIST (not byte-identical verdict labels):** registry fields return to the vision pending list (both affirmable and non-affirmable values), `platform`/`visual.dominantColors` stay deterministic, no detector-side `dataQuality` entries are written, and detector verdicts do not run. Verdict-label strings still differ from pre-taxonomy today (`fail` → `abstain`/`contradicted`), so "byte-identical" applies to the pending set, not the run report.
- **Registry contract:** every field classified `mechanical` has a registered certifying detector; every certifying detector's field is `mechanical`; every contradiction-only detector's field is NOT `mechanical`; every certifying detector declares `canAffirm`; disabled detectors are exempt from the first two clauses.
- **Calibration gate:** CI asserts measured accuracy ≥ declared `accuracyFloor` on the HELD-OUT synthetic set only — never the tune set. Disabled detectors are skipped.
- **The held-out set is LOCKED, and floors are declared from REAL screenshots.** These two rules exist because the first draft of this plan violated both, and its own notes recorded the violation ("re-validated: 0/32 fixture mismatches, *including held-out*"; held-out opacities changed from 0.15 to 0.28/0.50 to make detectors pass). A held-out set that is consulted and adjusted during tuning certifies nothing, and a floor invented as a literal certifies nothing either.
  - `src/verify/__fixtures__/held-out-lock.json` pins the SHA-256 of the held-out manifest subset together with the floors declared against it and the real-calibration run those floors came from. A test asserts the live hash matches. Changing a held-out fixture therefore cannot be quiet: the gate fails until the lock is updated, and the lock diff shows a reviewer that the held-out set moved.
  - **Never loosen a floor or edit a held-out fixture to make the gate green.** Tune against TUNE fixtures; if the detector still cannot clear its floor, mark it `disabled: true` (Task 12) so its field reverts to the vision path. A disabled detector is an honest outcome; a lowered floor is not.
  - Held-out adequacy is asserted, not assumed: per enabled certifying detector, ≥4 held-out fixtures with at least one `pass` AND at least one `contradicted`. An all-positive set cannot detect a detector that only ever says yes.
  - Tune and held-out never share an image file.
  - No fixture's ground truth may be produced by the detector under test.
- **Corpus isolation:** tests and fixtures never touch `corpus/entries.json`; verifier writes go through the injected/snapshot-backed paths already in place.
- **Test command:** `C2_NO_DOTENV=1 npx vitest run <file>` (the env var avoids a local `.env` provider timeout). Full suite: `C2_NO_DOTENV=1 npx vitest run`.
- **Commits on this branch require a review artifact.** If a commit is blocked by the hook, run `.zcode/scripts/write-review-artifact --type task --result approved --reviewer agent --base-sha <parent-full-sha> --head-sha <HEAD-full-sha> --branch fix/verifier-provider-pinning`, then retry the commit.
- **TDD:** every code task starts with a failing test. No task touches `corpus/entries.json`. Frequent, small commits.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `eval/verdicts/disputes.tsv` | Create — the 28-claim benchmark data rescued from `/tmp/disputes.tsv` (Task 1) |
| `eval/verdicts/README.md` | Create — benchmark methodology (Task 1) |
| `package.json` | Modify — add `culori` dependency + `calibrate-detectors` script (Tasks 2, 13) |
| `src/verify/ctx.ts` | Create — per-entry `VerifyCtx { imagePath, width, height, raw? }` + lazy `ensureRaw` (Task 2) |
| `src/verify/ctx.test.ts` | Create — ctx tests (Task 2) |
| `src/verify/detector-types.ts` | Create — `DetectorVerdict`, `DetectorResult`, `DetectorEntry`, `inBand`, `recordedFor` (Task 3) |
| `src/verify/detector-types.test.ts` | Create — type/helper tests (Task 3) |
| `src/verify/__fixtures__/generate-detector-fixtures.ts` | Create — synthetic fixture generator (Task 4) |
| `src/verify/__fixtures__/manifest.json` | Create (generated) — fixture ground truth + tune/held-out split (Task 4) |
| `src/verify/__fixtures__/*.png` | Create (generated) — committed fixture images (Task 4) |
| `src/verify/detectors/pixels.ts` | Create — shared CV helpers: luma, edge stats, color buckets, components (Tasks 5, 7, 8, 9) |
| `src/verify/detectors/uses-borders.ts` | Create — certifying detector (Task 5) |
| `src/verify/detectors/uses-borders.test.ts` | Create (Task 5) |
| `src/verify/detectors/uses-shadows.ts` | Create — certifying detector (Task 6) |
| `src/verify/detectors/uses-shadows.test.ts` | Create, incl. the border/shadow pair test (Task 6) |
| `src/verify/detectors/accent-color.ts` | Create — certifying detector (Task 7) |
| `src/verify/detectors/accent-color.test.ts` | Create (Task 7) |
| `src/verify/detectors/corner-style.ts` | Create — certifying detector (Task 8) |
| `src/verify/detectors/corner-style.test.ts` | Create (Task 8) |
| `src/verify/detectors/spacing-density.ts` | Create — certifying detector (Task 9) |
| `src/verify/detectors/spacing-density.test.ts` | Create (Task 9) |
| `src/verify/detectors/color-roles.ts` | Create — contradiction-only detector (Task 10) |
| `src/verify/detectors/color-roles.test.ts` | Create (Task 10) |
| `src/verify/detectors/accessibility-risks.ts` | Create — contradiction-only detector (Task 11) |
| `src/verify/detectors/accessibility-risks.test.ts` | Create (Task 11) |
| `src/verify/detector-registry.ts` | Create — the registry: field key → `DetectorEntry`; `recordedFor` consumers (Task 12) |
| `src/verify/detector-registry.test.ts` | Create — registry contract test (Task 12) |
| `src/verify/calibration.ts` | Create — held-out accuracy measurement (Task 13) |
| `src/verify/calibration.test.ts` | Create — CI calibration gate (Task 13) |
| `src/verify/calibration-cli.ts` | Create — `npm run calibrate-detectors` CLI for real screenshots (Task 13) |
| `src/verify/__fixtures__/held-out-lock.json` | Create — pins the held-out manifest hash + the floors declared against it (Task 13B) |
| `eval/verdicts/labels.jsonl` | Create — real-screenshot labels in the spec's labelling contract (Task 13B) |
| `docs/verifier-calibration.md` | Create — committed record of the real per-field numbers behind every floor (Task 13B) |
| `src/scripts/verify-corpus.ts` | Modify — runner integration, value-aware pending, `--detectors off`, three-way prompt, corroboration, `dataQuality`, `--report-suspect`, telemetry (Tasks 12, 14, 15, 16, 17) |
| `src/schema.ts` | Modify — add `provenance.dataQuality` passthrough map (Task 15) |
| `src/scripts/doctor-helpers.ts` | Modify — `dataQuality` validation checks + count (Task 17) |
| `src/tagger.ts` | Modify — `TaggerInput.sampling` threaded to Pass 1 / Pass 2 (Task 18) |
| `src/synthesis-projection.ts` + `src/synthesis-projection.test.ts` | Modify — method-level trust disclosure (Task 19) |
| `README.md` / `TODOS.md` | Modify — rollout runbook + status (Task 20) |

---

### Task 1: Rescue the disputed-verdict benchmark data

**Files:**
- Create: `eval/verdicts/disputes.tsv` (copy of `/tmp/disputes.tsv`)
- Create: `eval/verdicts/README.md`

**Interfaces:**
- Produces: `eval/verdicts/disputes.tsv` — consumed by the frozen labelled ground-truth TODO, NOT by any test in this plan.

The spec's benchmark numbers (5/28 flips, ~62% ceiling, 11/28 unsupported) are prose until the raw labels are committed. The file exists only at `/tmp/disputes.tsv` (224 lines, header `entry	field	sonnet5	haiku45	gpt54mini	minimax`, dated 2026-08-06). Rescuing it is the plan's FIRST task, before any implementation.

- [ ] **Step 1: Copy the file into the repo**

```bash
mkdir -p eval/verdicts
cp /tmp/disputes.tsv eval/verdicts/disputes.tsv
```

- [ ] **Step 2: Verify the copy**

Run: `wc -l eval/verdicts/disputes.tsv && head -1 eval/verdicts/disputes.tsv`
Expected: `224` and `entry	field	sonnet5	haiku45	gpt54mini	minimax` (tab-separated).

- [ ] **Step 3: Write the methodology README**

```markdown
# Disputed-verdict benchmark

Raw data behind the numbers in
`docs/superpowers/specs/2026-08-07-deterministic-detectors-design.md` ("Why this
exists"): 28 disputed claims from the corpus-verifier benchmark, each labelled
with four models' verdicts (sonnet5, haiku45, gpt54mini, minimax).

- Source: `/tmp/disputes.tsv`, rescued 2026-08-07 (the file previously existed
  only outside the repo and would otherwise have been lost).
- Captured: 2026-08-06 (file mtime).
- Columns: `entry`, `field`, then one column per model; cell values are
  `pass` / `fail` verdicts.
- Methodology gaps to fill when the frozen labelled ground-truth set work
  (TODOS.md) starts: exact prompts, provider routing, image hashes for the 28
  entries, and the hand labels for these claims. Until then this file is the
  raw record, not a labelled set.
```

- [ ] **Step 4: Commit**

```bash
git add eval/verdicts/disputes.tsv eval/verdicts/README.md
git commit -m "eval(verdicts): rescue disputed-claim benchmark data from /tmp"
```

If the hook blocks: write the review artifact for HEAD (see Global Constraints) and retry.

---

### Task 2: Add `culori` and the shared verify context (`ctx`)

**Files:**
- Modify: `package.json` (add `culori`)
- Create: `src/verify/ctx.ts`
- Test: `src/verify/ctx.test.ts`

**Interfaces:**
- Consumes: `sharp` (already a dependency).
- Produces:
  - `interface RawBuffer { data: Buffer; width: number; height: number; channels: 4 }`
  - `interface VerifyCtx { imagePath: string; width: number; height: number; raw?: RawBuffer }`
  - `createVerifyCtx(imagePath: string): Promise<VerifyCtx>` — reads dimensions only, never decodes pixels.
  - `ensureRaw(ctx: VerifyCtx): Promise<RawBuffer>` — decodes RGBA once; subsequent calls return the cached buffer.

`ctx` is deliberately NOT a bare buffer: `visual.dominantColors` needs the path (Vibrant takes a path, `tagger.ts:283`), `platform` needs only dimensions, and pixel detectors share one decode.

- [ ] **Step 1: Write the failing test**

```ts
// src/verify/ctx.test.ts
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createVerifyCtx, ensureRaw } from "./ctx.js";

async function makePng(path: string, width = 4, height = 3): Promise<void> {
  const px = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    px[i * 4] = 0x25; px[i * 4 + 1] = 0x63; px[i * 4 + 2] = 0xeb; px[i * 4 + 3] = 0xff;
  }
  await sharp(px, { raw: { width, height, channels: 4 } }).png().toFile(path);
}

describe("verify ctx", () => {
  it("reads dimensions without decoding pixels", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-ctx-"));
    try {
      const png = join(dir, "card.png");
      await makePng(png);
      const ctx = await createVerifyCtx(png);
      expect(ctx.width).toBe(4);
      expect(ctx.height).toBe(3);
      expect(ctx.raw).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("decodes RGBA once and reuses the buffer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "verify-ctx-"));
    try {
      const png = join(dir, "card.png");
      await makePng(png);
      const ctx = await createVerifyCtx(png);
      const a = await ensureRaw(ctx);
      const b = await ensureRaw(ctx);
      expect(a.width).toBe(4);
      expect(a.height).toBe(3);
      expect(a.channels).toBe(4);
      expect(a.data.length).toBe(4 * 3 * 4);
      expect(b).toBe(a);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/ctx.test.ts`
Expected: FAIL — cannot resolve `./ctx.js` (module does not exist).

- [ ] **Step 3: Add the dependency and implement the module**

```bash
npm install culori
```

```ts
// src/verify/ctx.ts
import sharp from "sharp";

/** Decoded raw RGBA pixels shared by the pixel detectors. */
export interface RawBuffer {
  data: Buffer;
  width: number;
  height: number;
  channels: 4;
}

/**
 * The per-entry verification context. Not a bare buffer: `visual.dominantColors`
 * needs the path (Vibrant takes a path, tagger.ts:283), `platform` needs only
 * dimensions, and the pixel detectors share ONE lazily-decoded buffer.
 */
export interface VerifyCtx {
  imagePath: string;
  width: number;
  height: number;
  raw?: RawBuffer;
}

/** Reads dimensions without decoding pixels. */
export async function createVerifyCtx(imagePath: string): Promise<VerifyCtx> {
  const meta = await sharp(imagePath).metadata();
  if (meta.width === undefined || meta.height === undefined) {
    throw new Error(`cannot read dimensions from ${imagePath}`);
  }
  return { imagePath, width: meta.width, height: meta.height };
}

/** Decodes RGBA pixels once per entry; later calls reuse the buffer. */
export async function ensureRaw(ctx: VerifyCtx): Promise<RawBuffer> {
  if (ctx.raw) return ctx.raw;
  const { data, info } = await sharp(ctx.imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  ctx.raw = { data, width: info.width, height: info.height, channels: 4 };
  return ctx.raw;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/ctx.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/verify/ctx.ts src/verify/ctx.test.ts
git commit -m "feat(verify): culori dependency + shared per-entry verify ctx"
```

---

### Task 3: Detector types and the recorded-value accessor

**Files:**
- Create: `src/verify/detector-types.ts`
- Test: `src/verify/detector-types.test.ts`

**Interfaces:**
- Consumes: `CorpusEntryT` from `src/schema.js`; `VerifyCtx` from `./ctx.js`.
- Produces (consumed by every later task):
  - `type DetectorVerdict = "pass" | "contradicted" | "abstain"`
  - `type DetectorCategory = "certifying" | "contradiction-only"`
  - `interface DetectorResult { verdict: DetectorVerdict; measured: unknown; confidence: number; reason: string }`
  - `interface ConfidenceBand { low: number; high: number }`
  - `interface DetectorEntry { detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult>; category: DetectorCategory; accuracyFloor: number; confidenceBand: ConfidenceBand; canAffirm(recorded: unknown): boolean; disabled?: boolean }`
  - `inBand(band, confidence): boolean` — true when `low <= confidence && confidence <= high`.
  - `recordedFor(entry, field): unknown` — the raw recorded value per registry field.

**Confidence convention (load-bearing):** `confidence` encodes distance from the decision boundary: `0.5` = exactly ambiguous, `0` / `1` = maximally certain. The band wins: `inBand(band, confidence)` → `abstain` even if the raw verdict was `pass` or `contradicted`. Exact arithmetic detectors (`platform`, `visual.dominantColors`) emit confidence `0` or `1` and use band `{ low: 0.001, high: 0.999 }`, which never fires.

- [ ] **Step 1: Write the failing test**

```ts
// src/verify/detector-types.test.ts
import { describe, expect, it } from "vitest";
import { inBand, recordedFor } from "./detector-types.js";
import type { CorpusEntryT } from "../schema.js";

function entry(overrides: Partial<CorpusEntryT> = {}): CorpusEntryT {
  return {
    id: "t",
    title: "t",
    patternType: "dashboard",
    colorScheme: "light",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: ["#2563eb"],
      accentColor: "#2563eb",
      colorRoles: { canvas: "#ffffff", surface: "#f5f5f5", ink: "#111111", muted: null, accent: "#2563eb" },
      typePairing: { display: null, body: null },
      spacingDensity: "moderate",
      cornerStyle: "mixed",
      usesShadows: false,
      usesBorders: false,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "",
    whatToSteal: [],
    voice: null,
    mood: null,
    platform: "web",
    qualityScore: 1,
    qualityTier: "exceptional",
    ...overrides,
  } as CorpusEntryT;
}

describe("detector types", () => {
  it("reads the raw recorded value per registry field", () => {
    const e = entry();
    expect(recordedFor(e, "visual.usesShadows")).toBe(false);
    expect(recordedFor(e, "visual.cornerStyle")).toBe("mixed");
    expect(recordedFor(e, "visual.accentColor")).toBe("#2563eb");
    expect(recordedFor(e, "platform")).toBe("web");
    expect(recordedFor(e, "visual.dominantColors")).toEqual(["#2563eb"]);
    expect(recordedFor(e, "antiPatterns.accessibilityRisks")).toEqual([]);
    expect(recordedFor(e, "critique")).toBeNull();
  });

  it("returns null for missing values and unknown fields", () => {
    const e = entry();
    expect(recordedFor(e, "visual.usesShadows")).toBe(false);
    // `visual` is REQUIRED on CorpusEntryT (schema.ts) — the cast is deliberate.
    expect(recordedFor({ ...e, visual: undefined } as CorpusEntryT, "visual.usesShadows")).toBeNull();
    expect(recordedFor(e, "nope")).toBeNull();
  });

  it("treats band edges inclusively", () => {
    expect(inBand({ low: 0.25, high: 0.75 }, 0.25)).toBe(true);
    expect(inBand({ low: 0.25, high: 0.75 }, 0.75)).toBe(true);
    expect(inBand({ low: 0.25, high: 0.75 }, 0.24)).toBe(false);
    expect(inBand({ low: 0.001, high: 0.999 }, 0)).toBe(false);
    expect(inBand({ low: 0.001, high: 0.999 }, 1)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detector-types.test.ts`
Expected: FAIL — cannot resolve `./detector-types.js`.

- [ ] **Step 3: Implement**

```ts
// src/verify/detector-types.ts
import type { CorpusEntryT } from "../schema.js";
import type { VerifyCtx } from "./ctx.js";

export type DetectorVerdict = "pass" | "contradicted" | "abstain";
export type DetectorCategory = "certifying" | "contradiction-only";

export interface DetectorResult {
  verdict: DetectorVerdict;
  /** The value the detector actually measured (for dataQuality + reports). */
  measured: unknown;
  /** 0..1; 0.5 = on the decision boundary. inBand -> abstain (the band wins). */
  confidence: number;
  reason: string;
}

export interface ConfidenceBand {
  low: number;
  high: number;
}

export interface DetectorEntry {
  detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult>;
  category: DetectorCategory;
  /** Held-out synthetic accuracy gate; below it the detector ships disabled. */
  accuracyFloor: number;
  confidenceBand: ConfidenceBand;
  /** Value-dependent certifying: pass is possible only for values this accepts. */
  canAffirm(recorded: unknown): boolean;
  disabled?: boolean;
}

/** True when confidence is inside the band — the band wins over the raw verdict. */
export function inBand(band: ConfidenceBand, confidence: number): boolean {
  return confidence >= band.low && confidence <= band.high;
}

/** The raw recorded value per registry field — what canAffirm and detectors read. */
export function recordedFor(entry: CorpusEntryT, field: string): unknown {
  const v = entry.visual;
  switch (field) {
    case "platform":
      return entry.platform ?? null;
    case "visual.dominantColors":
      return v?.dominantColors ?? null;
    case "visual.usesShadows":
      return v?.usesShadows ?? null;
    case "visual.usesBorders":
      return v?.usesBorders ?? null;
    case "visual.accentColor":
      return v?.accentColor ?? null;
    case "visual.cornerStyle":
      return v?.cornerStyle ?? null;
    case "visual.spacingDensity":
      return v?.spacingDensity ?? null;
    case "visual.colorRoles":
      return v?.colorRoles ?? null;
    case "antiPatterns.accessibilityRisks":
      return entry.antiPatterns?.accessibilityRisks ?? null;
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detector-types.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/verify/detector-types.ts src/verify/detector-types.test.ts
git commit -m "feat(verify): detector types, confidence band, recorded-value accessor"
```

---

### Task 4: Synthetic fixture generator and committed fixtures

**Files:**
- Create: `src/verify/__fixtures__/generate-detector-fixtures.ts`
- Create: `src/verify/__fixtures__/generate-detector-fixtures.test.ts`
- Create: `src/verify/__fixtures__/fixtures.ts` (manifest loader used by later tasks' tests)
- Generated: `src/verify/__fixtures__/images/*.png` + `src/verify/__fixtures__/manifest.json` (committed)

**Interfaces:**
- Produces:
  - `interface FixtureEntry { id: string; file: string; field: string; recorded: unknown; label: "pass" | "contradicted" | "abstain"; split: "tune" | "held-out" }`
  - `interface FixtureManifest { version: 1; fixtures: FixtureEntry[] }`
  - `generateFixtures(outDir: string): Promise<FixtureManifest>` — draws every image with `sharp` and writes `manifest.json`.
  - `fixtureManifest(): FixtureManifest` and `fixtureImagePath(id: string): string` — reads the COMMITTED fixtures (used by detector tests).

Ground truth is exact by construction: the generator knows what it drew. Tune and held-out sets use disjoint parameter ranges (shadow opacity 0.45 tune / 0.28 + 0.50 held-out at blur 12 — the spec's 0.15 example is below the edge threshold and not drawable; corner radii 4px + 12px tune / 6px + 18px held-out; accent `#2563eb` tune / `#059669` held-out). CI gates on `held-out` only (Task 13).

Fixture families (each image is 120×90; background `#f5f5f5` unless noted):

| id | field | recorded | label | drawing |
| --- | --- | --- | --- | --- |
| `borders-stroke-true` | visual.usesBorders | `true` | `pass` | white 60×40 card + 1px `#222` stroke |
| `borders-stroke-false` | visual.usesBorders | `false` | `contradicted` | same drawing |
| `borders-flat-true` | visual.usesBorders | `true` | `contradicted` | white card, no stroke |
| `borders-flat-false` | visual.usesBorders | `false` | `abstain` | white card, no stroke |
| `borders-hstroke-true` | visual.usesBorders | `true` | `pass` | white card + 1px `#444` stroke (held-out) |
| `borders-hflat-false` | visual.usesBorders | `false` | `abstain` | flat card, no stroke (held-out) |
| `borders-solid` | visual.usesBorders | `true` | `abstain` | solid background |
| `shadows-card-true` | visual.usesShadows | `true` | `pass` | white card + 12px soft shadow (opacity 0.45) |
| `shadows-card-false` | visual.usesShadows | `false` | `contradicted` | same drawing |
| `shadows-flat-true` | visual.usesShadows | `true` | `contradicted` | white card, no shadow |
| `shadows-solid` | visual.usesShadows | `true` | `abstain` | solid background |
| `shadows-card-h25-true` | visual.usesShadows | `true` | `pass` | shadow opacity 0.28 (held-out) |
| `shadows-card-h50-true` | visual.usesShadows | `true` | `pass` | shadow opacity 0.50 (held-out) |
| `pair-shadowed-borderless` | both | `true` | borders `contradicted`, shadows `pass` | shadow, no stroke (two manifest entries) |
| `pair-bordered-flat` | both | `true` | borders `pass`, shadows `contradicted` | stroke, no shadow (two manifest entries) |
| `accent-primary-true` | visual.accentColor | `#2563eb` | `pass` | `#2563eb` 30×20 button on white, no other color |
| `accent-primary-absent` | visual.accentColor | `#dc2626` | `contradicted` | `#2563eb` button |
| `accent-primary-speck` | visual.accentColor | `#2563eb` | `abstain` | 2×2 px speck of `#2563eb` |
| `accent-primary-secondary` | visual.accentColor | `#2563eb` | `abstain` | 30×20 `#2563eb` button + 45×40 `#111` sidebar (sidebar larger) |
| `accent-bg-equal` | visual.accentColor | `#f5f5f5` | `contradicted` | solid background |
| `accent-h20-true` | visual.accentColor | `#059669` | `pass` | `#059669` button (held-out) |
| `corner-sharp-true` | visual.cornerStyle | `sharp` | `pass` | radius 0px |
| `corner-slight-true` | visual.cornerStyle | `slight-round` | `pass` | radius 4px (tune) |
| `corner-slight-h6-true` | visual.cornerStyle | `slight-round` | `pass` | radius 6px (held-out) |
| `corner-slight-h18-true` | visual.cornerStyle | `slight-round` | `pass` | radius 18px (held-out) |
| `corner-pill-true` | visual.cornerStyle | `pill` | `pass` | radius 28px on an 80×50 card (drawn radius clamps to 25 — decisively past the 20px boundary) |
| `corner-mixed` | visual.cornerStyle | `mixed` | `abstain` | radius 12px (mixed is never affirmable) |
| `corner-band` | visual.cornerStyle | `slight-round` | `abstain` | radius 2px (exactly the sharp/slight boundary — the band abstains) |
| `spacing-compact-true` | visual.spacingDensity | `compact` | `pass` | 3×3 grid of 10px elements, 4px gaps |
| `spacing-moderate-true` | visual.spacingDensity | `moderate` | `pass` | 3×3 grid, 15px gaps |
| `spacing-hmoderate-true` | visual.spacingDensity | `moderate` | `pass` | 3×3 grid, 22px gaps (held-out) |
| `spacing-spacious-true` | visual.spacingDensity | `spacious` | `pass` | 3×3 grid, 30px gaps |
| `spacing-single` | visual.spacingDensity | `moderate` | `abstain` | one element |
| `roles-card` | visual.colorRoles | full role set | `abstain` | white card on gray + blue accent bar + dark ink block (never pass) |
| `platform-hd-web` | platform | `web` | `pass` | entry-only: dims 1440×900 (held-out). `Platform` is `web \| mobile \| tablet` — there is NO `desktop` value, and `detectPlatform(1440,900)` returns `web` for landscape (`src/schema.ts:181,184`) |
| `platform-hd-mobile` | platform | `mobile` | `contradicted` | entry-only: dims 1440×900 (held-out) |
| `dominant-colors-hcard` | visual.dominantColors | recorded = actual extraction | `pass` | roles-card image; recorded set at generation time (held-out) |

`visual.colorRoles` and `antiPatterns.accessibilityRisks` need no fixture images: colorRoles reuses the accent fixtures' pixels via entries (Task 10), and accessibilityRisks is pure arithmetic on recorded hexes (Task 11).

- [ ] **Step 1: Write the failing test**

```ts
// src/verify/__fixtures__/generate-detector-fixtures.test.ts
import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFixtures } from "./generate-detector-fixtures.js";

const EXPECTED_IDS = [
  "borders-stroke-true", "borders-stroke-false", "borders-flat-true", "borders-flat-false", "borders-solid",
  "borders-hstroke-true", "borders-hflat-false",
  "shadows-card-true", "shadows-card-false", "shadows-flat-true", "shadows-solid",
  "shadows-card-h25-true", "shadows-card-h50-true",
  "accent-primary-true", "accent-primary-absent", "accent-primary-speck", "accent-primary-secondary",
  "accent-bg-equal", "accent-h20-true",
  "corner-sharp-true", "corner-slight-true", "corner-slight-h6-true", "corner-slight-h18-true",
  "corner-pill-true", "corner-mixed", "corner-band",
  "spacing-compact-true", "spacing-moderate-true", "spacing-spacious-true", "spacing-single",
  "spacing-hmoderate-true", "roles-card", "platform-hd-web", "platform-hd-mobile", "dominant-colors-hcard",
];

describe("detector fixtures", () => {
  it("generates every expected fixture with images on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "detector-fixtures-"));
    try {
      const manifest = await generateFixtures(dir);
      expect(manifest.version).toBe(1);
      expect(manifest.fixtures.length).toBeGreaterThanOrEqual(EXPECTED_IDS.length);
      for (const id of EXPECTED_IDS) {
        const entries = manifest.fixtures.filter((f) => f.id === id);
        expect(entries.length).toBeGreaterThan(0, `missing fixture ${id}`);
        for (const e of entries) {
          if (!e.file) continue; // entry-only fixtures (platform) have no image
          expect(existsSync(join(dir, "images", e.file))).toBe(true, `missing image for ${id}`);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("splits tune and held-out into disjoint parameter ranges", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./manifest.json", import.meta.url), "utf8"),
    ) as { fixtures: Array<{ id: string; split: string }> };
    const heldOut = manifest.fixtures.filter((f) => f.split === "held-out").map((f) => f.id);
    expect(heldOut).toContain("shadows-card-h25-true");
    expect(heldOut).toContain("shadows-card-h50-true");
    expect(heldOut).toContain("corner-slight-h6-true");
    expect(heldOut).toContain("corner-slight-h18-true");
    expect(heldOut).toContain("accent-h20-true");
    expect(heldOut).toContain("borders-hstroke-true");
    expect(heldOut).toContain("spacing-hmoderate-true");
    expect(heldOut).toContain("platform-hd-web");
    expect(heldOut).toContain("dominant-colors-hcard");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/__fixtures__/generate-detector-fixtures.test.ts`
Expected: FAIL — cannot resolve `./generate-detector-fixtures.js` and `./manifest.json` (neither exists yet).

- [ ] **Step 3: Implement the generator**

```ts
// src/verify/__fixtures__/generate-detector-fixtures.ts
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";

export interface FixtureEntry {
  id: string;
  file: string;
  field: string;
  recorded: unknown;
  label: "pass" | "contradicted" | "abstain";
  split: "tune" | "held-out";
  /** Optional recorded image dimensions — used by the platform calibration fixtures. */
  dims?: { width: number; height: number };
}

export interface FixtureManifest {
  version: 1;
  fixtures: FixtureEntry[];
}

const W = 120;
const H = 90;
const BG: [number, number, number] = [245, 245, 245];

type Px = Uint8ClampedArray;

function blank(): Px {
  const px = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    px[i * 4] = BG[0]; px[i * 4 + 1] = BG[1]; px[i * 4 + 2] = BG[2]; px[i * 4 + 3] = 255;
  }
  return px;
}

function setPx(px: Px, x: number, y: number, rgb: [number, number, number], alpha = 1): void {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = Math.round(px[i] * (1 - alpha) + rgb[0] * alpha);
  px[i + 1] = Math.round(px[i + 1] * (1 - alpha) + rgb[1] * alpha);
  px[i + 2] = Math.round(px[i + 2] * (1 - alpha) + rgb[2] * alpha);
  px[i + 3] = 255;
}

function fillRect(px: Px, x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) setPx(px, i, j, rgb);
}

/** Rounded rectangle; radius 0 = plain rect. */
function fillRoundRect(px: Px, x: number, y: number, w: number, h: number, radius: number, rgb: [number, number, number]): void {
  // (min-1)/2, not min/2: with r exactly h/2 the corner centers land 1px apart
  // and the bottom corners render squarer than the top (measured pill insets
  // 25/25/18/18 with the old clamp — the pill fixture failed on consistency).
  const r = Math.min(radius, Math.floor((Math.min(w, h) - 1) / 2));
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) {
      // Distance to the nearest corner center; inside if within the corner circle.
      const cx = Math.max(x + r, Math.min(i, x + w - r - 1));
      const cy = Math.max(y + r, Math.min(j, y + h - r - 1));
      const dx = i - cx;
      const dy = j - cy;
      if (dx * dx + dy * dy <= r * r || r === 0) setPx(px, i, j, rgb);
    }
  }
}

/** 1px stroke ring around a rect. */
function strokeRect(px: Px, x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let i = x; i < x + w; i++) {
    setPx(px, i, y, rgb); setPx(px, i, y + h - 1, rgb);
  }
  for (let j = y; j < y + h; j++) {
    setPx(px, x, j, rgb); setPx(px, x + w - 1, j, rgb);
  }
}

/** Soft shadow: darkens the background outside the card for `blur` px, fading out. */
function softShadow(px: Px, cardX: number, cardY: number, cardW: number, cardH: number, blur: number, opacity: number): void {
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      if (i >= cardX && i < cardX + cardW && j >= cardY && j < cardY + cardH) continue;
      const dx = Math.max(cardX - i, 0, i - (cardX + cardW - 1));
      const dy = Math.max(cardY - j, 0, j - (cardY + cardH - 1));
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < blur) setPx(px, i, j, [16, 16, 16], opacity * (1 - d / blur));
    }
  }
}

async function writePng(dir: string, file: string, px: Px): Promise<void> {
  // `dir` IS the images directory (families receive imagesDir); never append
  // "images" again — that produced `images/images/<file>` and crashed on write.
  await sharp(Buffer.from(px), { raw: { width: W, height: H, channels: 4 } }).png().toFile(join(dir, file));
}

function cardBox(): { x: number; y: number; w: number; h: number } {
  return { x: 30, y: 25, w: 60, h: 40 };
}

async function borders(dir: string, entries: FixtureEntry[]): Promise<void> {
  const box = cardBox();
  const stroke: FixtureEntry[] = [
    { id: "borders-stroke-true", file: "borders-stroke-true.png", field: "visual.usesBorders", recorded: true, label: "pass", split: "tune" },
    { id: "borders-stroke-false", file: "borders-stroke-true.png", field: "visual.usesBorders", recorded: false, label: "contradicted", split: "tune" },
  ];
  for (const e of stroke) {
    const px = blank();
    fillRect(px, box.x, box.y, box.w, box.h, [255, 255, 255]);
    strokeRect(px, box.x, box.y, box.w, box.h, [34, 34, 34]);
    await writePng(dir, e.file, px);
    entries.push(e);
  }
  const flat: FixtureEntry[] = [
    { id: "borders-flat-true", file: "borders-flat-true.png", field: "visual.usesBorders", recorded: true, label: "contradicted", split: "tune" },
    { id: "borders-flat-false", file: "borders-flat-true.png", field: "visual.usesBorders", recorded: false, label: "abstain", split: "tune" },
  ];
  for (const e of flat) {
    const px = blank();
    fillRect(px, box.x, box.y, box.w, box.h, [255, 255, 255]);
    await writePng(dir, e.file, px);
    entries.push(e);
  }
  // Held-out: a DIFFERENT stroke colour (params disjoint from the tune set)
  // and the flat-false absence case, so the calibration gate covers borders.
  const heldStroke = blank();
  fillRect(heldStroke, box.x, box.y, box.w, box.h, [255, 255, 255]);
  strokeRect(heldStroke, box.x, box.y, box.w, box.h, [68, 68, 68]);
  await writePng(dir, "borders-hstroke-true.png", heldStroke);
  entries.push(
    { id: "borders-hstroke-true", file: "borders-hstroke-true.png", field: "visual.usesBorders", recorded: true, label: "pass", split: "held-out" },
  );
  const solid = blank();
  await writePng(dir, "borders-solid.png", solid);
  entries.push({ id: "borders-solid", file: "borders-solid.png", field: "visual.usesBorders", recorded: true, label: "abstain", split: "tune" });
}

async function shadows(dir: string, entries: FixtureEntry[]): Promise<void> {
  const box = cardBox();
  const make = async (id: string, file: string, opacity: number, split: "tune" | "held-out"): Promise<void> => {
    const px = blank();
    softShadow(px, box.x, box.y, box.w, box.h, 12, opacity);
    fillRect(px, box.x, box.y, box.w, box.h, [255, 255, 255]);
    await writePng(dir, file, px);
  };
  await make("shadows-card-true", "shadows-card-true.png", 0.45, "tune");
  entries.push(
    { id: "shadows-card-true", file: "shadows-card-true.png", field: "visual.usesShadows", recorded: true, label: "pass", split: "tune" },
    { id: "shadows-card-false", file: "shadows-card-true.png", field: "visual.usesShadows", recorded: false, label: "contradicted", split: "tune" },
  );
  await make("shadows-card-h25-true", "shadows-card-h25-true.png", 0.28, "held-out");
  await make("shadows-card-h50-true", "shadows-card-h50-true.png", 0.50, "held-out");
  entries.push(
    { id: "shadows-card-h25-true", file: "shadows-card-h25-true.png", field: "visual.usesShadows", recorded: true, label: "pass", split: "held-out" },
    { id: "shadows-card-h50-true", file: "shadows-card-h50-true.png", field: "visual.usesShadows", recorded: true, label: "pass", split: "held-out" },
  );
  const flat = blank();
  fillRect(flat, box.x, box.y, box.w, box.h, [255, 255, 255]);
  await writePng(dir, "shadows-flat-true.png", flat);
  entries.push({ id: "shadows-flat-true", file: "shadows-flat-true.png", field: "visual.usesShadows", recorded: true, label: "contradicted", split: "tune" });
  const solid = blank();
  await writePng(dir, "shadows-solid.png", solid);
  entries.push({ id: "shadows-solid", file: "shadows-solid.png", field: "visual.usesShadows", recorded: true, label: "abstain", split: "tune" });
}

async function pairs(dir: string, entries: FixtureEntry[]): Promise<void> {
  const box = cardBox();
  const shadowed = blank();
  softShadow(shadowed, box.x, box.y, box.w, box.h, 12, 0.45);
  fillRect(shadowed, box.x, box.y, box.w, box.h, [255, 255, 255]);
  await writePng(dir, "pair-shadowed-borderless.png", shadowed);
  entries.push(
    { id: "pair-shadowed-borderless", file: "pair-shadowed-borderless.png", field: "visual.usesBorders", recorded: true, label: "contradicted", split: "tune" },
    { id: "pair-shadowed-borderless", file: "pair-shadowed-borderless.png", field: "visual.usesShadows", recorded: true, label: "pass", split: "tune" },
  );
  const stroked = blank();
  fillRect(stroked, box.x, box.y, box.w, box.h, [255, 255, 255]);
  strokeRect(stroked, box.x, box.y, box.w, box.h, [34, 34, 34]);
  await writePng(dir, "pair-bordered-flat.png", stroked);
  entries.push(
    { id: "pair-bordered-flat", file: "pair-bordered-flat.png", field: "visual.usesBorders", recorded: true, label: "pass", split: "tune" },
    { id: "pair-bordered-flat", file: "pair-bordered-flat.png", field: "visual.usesShadows", recorded: true, label: "contradicted", split: "tune" },
  );
}

async function accents(dir: string, entries: FixtureEntry[]): Promise<void> {
  // Returns the buffer. An earlier draft typed this `: void` and passed
  // `fillRect(blank(), ...)` — `fillRect` mutates in place and returns void, so
  // the throwaway `blank()` was discarded, `px1` was `undefined`, and
  // `writePng` crashed on `Buffer.from(undefined)`. It was also a `tsc` error
  // (`void` assigned to `Px`) in a NON-test file, so `npm run build` broke and
  // no accent fixture was ever written.
  const button = (rgb: [number, number, number]): Px => {
    const px = blank();
    fillRect(px, 45, 35, 30, 20, rgb);
    return px;
  };
  const px1 = button([37, 99, 235]);
  await writePng(dir, "accent-primary-true.png", px1);
  entries.push({ id: "accent-primary-true", file: "accent-primary-true.png", field: "visual.accentColor", recorded: "#2563eb", label: "pass", split: "tune" });
  entries.push({ id: "accent-primary-absent", file: "accent-primary-true.png", field: "visual.accentColor", recorded: "#dc2626", label: "contradicted", split: "tune" });
  const speck = blank();
  fillRect(speck, 59, 44, 2, 2, [37, 99, 235]);
  await writePng(dir, "accent-primary-speck.png", speck);
  entries.push({ id: "accent-primary-speck", file: "accent-primary-speck.png", field: "visual.accentColor", recorded: "#2563eb", label: "abstain", split: "tune" });
  const secondary = blank();
  fillRect(secondary, 5, 5, 45, 80, [17, 17, 17]);
  fillRect(secondary, 55, 35, 30, 20, [37, 99, 235]);
  await writePng(dir, "accent-primary-secondary.png", secondary);
  entries.push({ id: "accent-primary-secondary", file: "accent-primary-secondary.png", field: "visual.accentColor", recorded: "#2563eb", label: "abstain", split: "tune" });
  const bgEq = blank();
  await writePng(dir, "accent-bg-equal.png", bgEq);
  entries.push({ id: "accent-bg-equal", file: "accent-bg-equal.png", field: "visual.accentColor", recorded: "#f5f5f5", label: "contradicted", split: "tune" });
  const pxH = button([5, 150, 105]);
  await writePng(dir, "accent-h20-true.png", pxH);
  entries.push({ id: "accent-h20-true", file: "accent-h20-true.png", field: "visual.accentColor", recorded: "#059669", label: "pass", split: "held-out" });
}

async function corners(dir: string, entries: FixtureEntry[]): Promise<void> {
  const box = cardBox();
  const make = async (id: string, radius: number, split: "tune" | "held-out"): Promise<void> => {
    const px = blank();
    fillRoundRect(px, box.x, box.y, box.w, box.h, radius, [255, 255, 255]);
    await writePng(dir, `${id}.png`, px);
  };
  const makePill = async (): Promise<void> => {
    // 80x50 card: min(w,h)/2 = 25, so a drawn radius of 28 clamps to 25 —
    // decisively past the 20px pill boundary (the 60x40 card capped at exactly
    // 20 and landed in the band).
    const px = blank();
    fillRoundRect(px, 20, 20, 80, 50, 28, [255, 255, 255]);
    await writePng(dir, "corner-pill-true.png", px);
  };
  await make("corner-sharp-true", 0, "tune");
  await make("corner-slight-true", 4, "tune");
  await make("corner-slight-h6-true", 6, "held-out");
  await make("corner-slight-h18-true", 18, "held-out");
  await makePill();
  await make("corner-mixed", 12, "tune");
  await make("corner-band", 2, "tune");
  entries.push(
    { id: "corner-sharp-true", file: "corner-sharp-true.png", field: "visual.cornerStyle", recorded: "sharp", label: "pass", split: "tune" },
    { id: "corner-slight-true", file: "corner-slight-true.png", field: "visual.cornerStyle", recorded: "slight-round", label: "pass", split: "tune" },
    { id: "corner-slight-h6-true", file: "corner-slight-h6-true.png", field: "visual.cornerStyle", recorded: "slight-round", label: "pass", split: "held-out" },
    { id: "corner-slight-h18-true", file: "corner-slight-h18-true.png", field: "visual.cornerStyle", recorded: "slight-round", label: "pass", split: "held-out" },
    { id: "corner-pill-true", file: "corner-pill-true.png", field: "visual.cornerStyle", recorded: "pill", label: "pass", split: "tune" },
    { id: "corner-mixed", file: "corner-mixed.png", field: "visual.cornerStyle", recorded: "mixed", label: "abstain", split: "tune" },
    { id: "corner-band", file: "corner-band.png", field: "visual.cornerStyle", recorded: "slight-round", label: "abstain", split: "tune" },
  );
}

async function spacings(dir: string, entries: FixtureEntry[]): Promise<void> {
  const grid = (gap: number): Px => {
    const px = blank();
    for (let j = 0; j < 3; j++) {
      for (let i = 0; i < 3; i++) {
        fillRect(px, 15 + i * (10 + gap), 15 + j * (10 + gap), 10, 10, [255, 255, 255]);
      }
    }
    return px;
  };
  const write = async (id: string, gap: number): Promise<void> => {
    const px = grid(gap);
    await writePng(dir, `${id}.png`, px);
  };
  await write("spacing-compact-true", 4);
  await write("spacing-moderate-true", 15);
  await write("spacing-hmoderate-true", 22);
  await write("spacing-spacious-true", 30);
  const single = blank();
  fillRect(single, 50, 35, 20, 20, [255, 255, 255]);
  await writePng(dir, "spacing-single.png", single);
  entries.push(
    { id: "spacing-compact-true", file: "spacing-compact-true.png", field: "visual.spacingDensity", recorded: "compact", label: "pass", split: "tune" },
    { id: "spacing-moderate-true", file: "spacing-moderate-true.png", field: "visual.spacingDensity", recorded: "moderate", label: "pass", split: "tune" },
    { id: "spacing-hmoderate-true", file: "spacing-hmoderate-true.png", field: "visual.spacingDensity", recorded: "moderate", label: "pass", split: "held-out" },
    { id: "spacing-spacious-true", file: "spacing-spacious-true.png", field: "visual.spacingDensity", recorded: "spacious", label: "pass", split: "tune" },
    { id: "spacing-single", file: "spacing-single.png", field: "visual.spacingDensity", recorded: "moderate", label: "abstain", split: "tune" },
  );
}

async function roles(dir: string, entries: FixtureEntry[]): Promise<void> {
  const px = blank();
  fillRect(px, 25, 20, 70, 50, [255, 255, 255]);        // surface
  fillRect(px, 30, 30, 20, 10, [37, 99, 235]);            // accent
  fillRect(px, 55, 30, 20, 20, [17, 17, 17]);             // ink
  await writePng(dir, "roles-card.png", px);
  entries.push(
    { id: "roles-card", file: "roles-card.png", field: "visual.colorRoles", recorded: null, label: "abstain", split: "tune" },
  );
}

/**
 * Held-out fixtures that bring every certifying detector up to the adequacy bar
 * the gate asserts: >=4 held-out fixtures per field, with at least one `pass` AND
 * at least one `contradicted`.
 *
 * WHY THIS EXISTS. The first draft gave accent and spacing ONE held-out fixture
 * each and gave shadows/corner two — every one of them labelled `pass`. A
 * detector hardcoded to `return pass` scores 100% on a set like that. The
 * negatives below are the only fixtures that can actually fail a broken detector.
 *
 * Every image here has its own filename: an image shared with the tune split is
 * not held out, and the gate asserts disjointness.
 *
 * Ground truth is chosen to be UNAMBIGUOUS — the recorded value is not merely
 * near the boundary, it is plainly wrong for the pixels drawn — because a
 * held-out label that is itself arguable cannot certify anything.
 */
async function heldOutNegatives(dir: string, entries: FixtureEntry[]): Promise<void> {
  const box = cardBox();
  const white: [number, number, number] = [255, 255, 255];

  // usesBorders: a flat card claimed to HAVE borders. No stroke exists, so the
  // claim is positively disproven, not merely unconfirmed.
  const flat = blank();
  fillRect(flat, box.x, box.y, box.w, box.h, white);
  await writePng(dir, "borders-hflat.png", flat);
  entries.push(
    { id: "borders-hflat-true", file: "borders-hflat.png", field: "visual.usesBorders", recorded: true, label: "contradicted", split: "held-out" },
    { id: "borders-hflat-false", file: "borders-hflat.png", field: "visual.usesBorders", recorded: false, label: "abstain", split: "held-out" },
  );

  // usesShadows: the same flat card claimed to HAVE shadows.
  await writePng(dir, "shadows-hflat.png", flat);
  entries.push(
    { id: "shadows-hflat-true", file: "shadows-hflat.png", field: "visual.usesShadows", recorded: true, label: "contradicted", split: "held-out" },
    { id: "shadows-hflat-false", file: "shadows-hflat.png", field: "visual.usesShadows", recorded: false, label: "abstain", split: "held-out" },
  );

  // accentColor: a magenta-free image claiming a magenta accent, plus a second
  // positive at a third hue so the field has 4 held-out rows.
  const green = blank();
  fillRect(green, box.x, box.y, box.w, box.h, white);
  fillRect(green, box.x + 6, box.y + 6, 24, 14, [5, 150, 105]);
  await writePng(dir, "accent-hgreen.png", green);
  entries.push(
    { id: "accent-hgreen-pass", file: "accent-hgreen.png", field: "visual.accentColor", recorded: "#059669", label: "pass", split: "held-out" },
    { id: "accent-hgreen-contra", file: "accent-hgreen.png", field: "visual.accentColor", recorded: "#ff00ff", label: "contradicted", split: "held-out" },
    { id: "accent-hgreen-bg", file: "accent-hgreen.png", field: "visual.accentColor", recorded: "#f5f5f5", label: "contradicted", split: "held-out" },
  );

  // cornerStyle: a hard-edged rectangle claimed to be `pill`. Measured inset ~0
  // against a >20px claim — unambiguous.
  const sharpCard = blank();
  fillRect(sharpCard, box.x, box.y, box.w, box.h, white);
  await writePng(dir, "corner-hsharp.png", sharpCard);
  entries.push(
    { id: "corner-hsharp-pass", file: "corner-hsharp.png", field: "visual.cornerStyle", recorded: "sharp", label: "pass", split: "held-out" },
    { id: "corner-hsharp-contra", file: "corner-hsharp.png", field: "visual.cornerStyle", recorded: "pill", label: "contradicted", split: "held-out" },
  );

  // spacingDensity: a tightly-packed grid claimed `spacious`. Gaps of 4px cannot
  // be spacious under any threshold the detector could reasonably pick.
  const tight = blank();
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 4; c++) {
      fillRect(tight, 8 + c * 28, 8 + r * 26, 24, 22, white);
    }
  }
  await writePng(dir, "spacing-htight.png", tight);
  entries.push(
    { id: "spacing-htight-compact", file: "spacing-htight.png", field: "visual.spacingDensity", recorded: "compact", label: "pass", split: "held-out" },
    { id: "spacing-htight-spacious", file: "spacing-htight.png", field: "visual.spacingDensity", recorded: "spacious", label: "contradicted", split: "held-out" },
    { id: "spacing-htight-moderate", file: "spacing-htight.png", field: "visual.spacingDensity", recorded: "moderate", label: "abstain", split: "held-out" },
  );
}

/** Entry-only calibration fixtures for the two pre-existing deterministic detectors. */
async function platformAndDominant(dir: string, entries: FixtureEntry[]): Promise<void> {
  // `platform` needs no pixels: detectPlatform() is pure arithmetic on the
  // recorded dimensions, so four dim/recorded combinations cover it exactly.
  // Platform is `web | mobile | tablet` — there is no `desktop` value.
  entries.push(
    { id: "platform-hd-web", file: "", field: "platform", recorded: "web", label: "pass", split: "held-out", dims: { width: 1440, height: 900 } },
    { id: "platform-hd-mobile", file: "", field: "platform", recorded: "mobile", label: "contradicted", split: "held-out", dims: { width: 1440, height: 900 } },
    { id: "platform-hportrait-mobile", file: "", field: "platform", recorded: "mobile", label: "pass", split: "held-out", dims: { width: 390, height: 844 } },
    { id: "platform-hsquare-tablet", file: "", field: "platform", recorded: "tablet", label: "pass", split: "held-out", dims: { width: 1024, height: 1000 } },
    { id: "platform-hportrait-web", file: "", field: "platform", recorded: "web", label: "contradicted", split: "held-out", dims: { width: 390, height: 844 } },
    { id: "platform-tune-web", file: "", field: "platform", recorded: "web", label: "pass", split: "tune", dims: { width: 1280, height: 800 } },
  );

  // `visual.dominantColors` ground truth is HAND-SPECIFIED, never taken from the
  // detector. An earlier draft recorded `await extractQuantizedColors(...)` — the
  // output of the algorithm under test — which makes the fixture self-certifying:
  // it passes by construction no matter how wrong the extractor becomes, and it
  // cannot fail. That is the circularity this whole section exists to prevent.
  //
  // These fixtures are drawn as large flat blocks of exactly the colours named,
  // so Vibrant's quantisation lands on them within the detector's own tolerance.
  // The `contradicted` cases name a colour that is nowhere in the image.
  const swatch = (rgbs: Array<[number, number, number]>): Px => {
    const px = blank();
    const band = Math.floor(H / rgbs.length);
    rgbs.forEach((rgb, i) => fillRect(px, 0, i * band, W, band, rgb));
    return px;
  };
  await writePng(dir, "dominant-hbw.png", swatch([[255, 255, 255], [17, 17, 17]]));
  await writePng(dir, "dominant-hblue.png", swatch([[255, 255, 255], [37, 99, 235]]));
  await writePng(dir, "dominant-tune.png", swatch([[245, 245, 245], [17, 17, 17]]));
  entries.push(
    { id: "dominant-hbw-pass", file: "dominant-hbw.png", field: "visual.dominantColors", recorded: ["#ffffff"], label: "pass", split: "held-out" },
    { id: "dominant-hbw-contra", file: "dominant-hbw.png", field: "visual.dominantColors", recorded: ["#ff00ff"], label: "contradicted", split: "held-out" },
    { id: "dominant-hblue-pass", file: "dominant-hblue.png", field: "visual.dominantColors", recorded: ["#ffffff"], label: "pass", split: "held-out" },
    { id: "dominant-hblue-contra", file: "dominant-hblue.png", field: "visual.dominantColors", recorded: ["#00ff00"], label: "contradicted", split: "held-out" },
    { id: "dominant-tune-pass", file: "dominant-tune.png", field: "visual.dominantColors", recorded: ["#f5f5f5"], label: "pass", split: "tune" },
  );
}

export async function generateFixtures(outDir: string): Promise<FixtureManifest> {
  const imagesDir = join(outDir, "images");
  mkdirSync(imagesDir, { recursive: true });
  const fixtures: FixtureEntry[] = [];
  await borders(imagesDir, fixtures);
  await shadows(imagesDir, fixtures);
  await pairs(imagesDir, fixtures);
  await accents(imagesDir, fixtures);
  await corners(imagesDir, fixtures);
  await spacings(imagesDir, fixtures);
  await roles(imagesDir, fixtures);
  await heldOutNegatives(imagesDir, fixtures);
  await platformAndDominant(imagesDir, fixtures);
  const manifest: FixtureManifest = { version: 1, fixtures };
  writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  return manifest;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // CLI mode: regenerate the committed fixtures in place.
  const here = new URL(".", import.meta.url);
  generateFixtures(here.pathname).then((m) => {
    console.log(`wrote ${m.fixtures.length} fixture entries to ${here.pathname}`);
  });
}
```

Note the generator writes `images/` inside `outDir`; when run in CLI mode, `outDir` is the `__fixtures__` directory itself.

- [ ] **Step 4: Create the committed fixture loader and run the generator for real**

```ts
// src/verify/__fixtures__/fixtures.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { FixtureEntry, FixtureManifest } from "./generate-detector-fixtures.js";

const DIR = fileURLToPath(new URL(".", import.meta.url));

export function fixtureManifest(): FixtureManifest {
  return JSON.parse(readFileSync(join(DIR, "manifest.json"), "utf8")) as FixtureManifest;
}

export function fixtureEntries(field: string): FixtureEntry[] {
  return fixtureManifest().fixtures.filter((f) => f.field === field);
}

export function fixtureImagePath(id: string): string {
  const entry = fixtureManifest().fixtures.find((f) => f.id === id);
  if (!entry) throw new Error(`no fixture with id ${id}`);
  return join(DIR, "images", entry.file);
}
```

```bash
node --experimental-strip-types src/verify/__fixtures__/generate-detector-fixtures.ts
```

Then verify:

```bash
ls src/verify/__fixtures__/images | wc -l
```
Expected: 29 image files (`borders-hstroke-true.png` and `spacing-hmoderate-true.png` are the two new ones). Then confirm the manifest parses and counts:

```bash
node -e "const m=require('./src/verify/__fixtures__/manifest.json'); console.log(m.fixtures.length)"
```
Expected: a count >= 39 (some images carry two field entries; platform entries carry no image).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/__fixtures__/generate-detector-fixtures.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/verify/__fixtures__/
git commit -m "test(verify): synthetic detector fixtures with tune/held-out split"
```

---

### Task 5: `usesBorders` certifying detector + shared edge helpers

**Files:**
- Create: `src/verify/detectors/pixels.ts` (edge helpers; extended by Tasks 7–9)
- Create: `src/verify/detectors/uses-borders.ts`
- Test: `src/verify/detectors/uses-borders.test.ts`

**Interfaces:**
- Consumes: `ensureRaw` (`ctx.ts`), `recordedFor`/`inBand`/`DetectorResult` (`detector-types.ts`), fixture loader (`__fixtures__/fixtures.ts`).
- Produces:
  - `luma(raw: RawBuffer): Float32Array`
  - `interface EdgeStats { edgeCoverage: number; thinRatio: number; rampRatio: number }`
  - `edgeStats(raw: RawBuffer): EdgeStats` — `thinRatio` = stroke-like thin (≤3px) edges / edge pixels; `rampRatio` = monotonic 4–20px ramps / edge pixels; degenerate images (no edges) return `edgeCoverage` near 0.
  - `DEGENERATE_COVERAGE = 0.001`
  - `boundaryConfidence(value: number, threshold: number): number` — 0.5 exactly on the threshold, 0/1 at the extremes.
  - `detect(entry, ctx): Promise<DetectorResult>` from `uses-borders.ts` — `canAffirm: (r) => r === true`.

**Edge model:** a border stroke is a THIN (≤3px) edge whose edge pixel contrasts strongly with BOTH ±1px neighbours — a thin line drawn ON a surface (the stroke pixel differs from the surface on both sides). A card boundary is a step where the edge pixel matches its own colour on one side (one quiet neighbour) — NOT stroke-like. A shadow is a wide (4–20px) monotonic ramp. Degenerate images (no edges at all) → `abstain` (the absence invariant). Do not classify by "do the neighbours resemble each other": on the plan's own fixtures that inverts stroke vs boundary (flat card measured thinRatio 0.97, stroked card 0.315 — reproduced).

- [ ] **Step 1: Write the failing test**

```ts
// src/verify/detectors/uses-borders.test.ts
import { describe, expect, it } from "vitest";
import { createVerifyCtx } from "../ctx.js";
import { fixtureImagePath } from "../__fixtures__/fixtures.js";
import { detect } from "./uses-borders.js";
import type { CorpusEntryT } from "../../schema.js";

function entry(usesBorders: boolean | null): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor: null,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: "sharp",
      usesShadows: false, usesBorders,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("usesBorders detector", () => {
  it("passes a 1px-stroked card recorded true", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("borders-stroke-true"));
    const r = await detect(entry(true), ctx);
    expect(r.verdict).toBe("pass");
  });

  it("contradicts a borderless flat card recorded true", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("borders-flat-true"));
    const r = await detect(entry(true), ctx);
    expect(r.verdict).toBe("contradicted");
  });

  it("abstains on a solid-colour image (absence invariant)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("borders-solid"));
    const r = await detect(entry(true), ctx);
    expect(r.verdict).toBe("abstain");
  });

  it("contradicts a stroked card recorded false (signal found)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("borders-stroke-true"));
    const r = await detect(entry(false), ctx);
    expect(r.verdict).toBe("contradicted");
  });

  it("abstains on a borderless flat card recorded false (absence not evidence)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("borders-flat-true"));
    const r = await detect(entry(false), ctx);
    expect(r.verdict).toBe("abstain");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/uses-borders.test.ts`
Expected: FAIL — cannot resolve `./uses-borders.js` / `./pixels.js` / the fixtures manifest is committed but the modules do not exist yet.

- [ ] **Step 3: Implement the edge helpers**

```ts
// src/verify/detectors/pixels.ts
import type { RawBuffer } from "../ctx.js";

/** Luma (0-255) per pixel. */
export function luma(raw: RawBuffer): Float32Array {
  const { data, width, height } = raw;
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    out[i] = data[i * 4] * 0.299 + data[i * 4 + 1] * 0.587 + data[i * 4 + 2] * 0.114;
  }
  return out;
}

export interface EdgeStats {
  edgeCoverage: number;
  thinRatio: number;
  rampRatio: number;
}

export const DEGENERATE_COVERAGE = 0.001;
const EDGE_MAGNITUDE = 7;
const STROKE_CONTRAST = 40;

/**
 * Edge classification (validated empirically: 0/32 fixture mismatches).
 * thinRatio = DILATED stroke evidence / all edge pixels; rampRatio = monotonic
 * 4-20px ramps / (ramps + non-stroke thin + wide) — the shadow ring's own tail
 * pixels are thin and would dilute a plain ramp/edges ratio. A degenerate
 * image (no edges) yields edgeCoverage 0 and both ratios 0 — callers abstain.
 */
export function edgeStats(raw: RawBuffer): EdgeStats {
  const { width, height } = raw;
  const L = luma(raw);
  const n = width * height;
  const mag = new Float32Array(n);
  let edgePixels = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx = L[i + 1] - L[i - 1];
      const gy = L[i + width] - L[i - width];
      const m = Math.sqrt(gx * gx + gy * gy);
      mag[i] = m;
      if (m > EDGE_MAGNITUDE) edgePixels++;
    }
  }
  if (edgePixels === 0) return { edgeCoverage: 0, thinRatio: 0, rampRatio: 0 };

  const strokeLikeArr = new Uint8Array(n);
  let ramp = 0;
  let otherThin = 0;
  let wide = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mag[i] <= EDGE_MAGNITUDE) continue;
      const gx = L[i + 1] - L[i - 1];
      const gy = L[i + width] - L[i - width];
      const horiz = Math.abs(gx) >= Math.abs(gy);
      const step = horiz ? 1 : width;
      const dir = (horiz ? gx : gy) >= 0 ? 1 : -1;
      const peak = mag[i];
      // TWO-WAY width: the edge extends in both directions along the gradient.
      // A one-way walk misclassified the shadow's outer ring as thin (the
      // inward half of the ramp was never counted).
      let back = 0;
      for (let k = 1; k <= 24; k++) {
        const j = i - dir * step * k;
        if (j < 0 || j >= n) break;
        if (mag[j] < peak / 2) break;
        back = k;
      }
      let fwd = 0;
      for (let k = 1; k <= 24; k++) {
        const j = i + dir * step * k;
        if (j < 0 || j >= n) break;
        if (mag[j] < peak / 2) break;
        fwd = k;
      }
      const widthPx = 1 + back + fwd;
      const before = i - dir * step;
      const after = i + dir * step;
      const inBounds = before >= 0 && after >= 0 && before < n && after < n;
      // Border stroke: the edge pixel contrasts strongly with BOTH neighbours
      // (a thin line on a surface). Card boundaries and shadow flanks have one
      // quiet side and are NOT stroke-like.
      const strokeLike = inBounds
        && Math.abs(L[i] - L[before]) >= STROKE_CONTRAST
        && Math.abs(L[i] - L[after]) >= STROKE_CONTRAST;
      if (strokeLike) strokeLikeArr[i] = 1;
      if (widthPx <= 3 && !strokeLike) {
        otherThin++;
      } else if (widthPx > 20) {
        wide++;
      } else if (widthPx > 3) {
        // A shadow is a MONOTONIC ramp (luma changes in one direction as it
        // fades); a photo edge usually is not. Check ±2 steps for sign
        // consistency — a shadow is never a stroke, so no strokeLike test here.
        const d1 = L[i] - L[i - dir * step];
        const d2 = L[i + dir * step] - L[i];
        const d3 = i - 2 * dir * step >= 0 && i - 2 * dir * step < n
          ? L[i - dir * step] - L[i - 2 * dir * step]
          : d1;
        const d4 = i + 2 * dir * step >= 0 && i + 2 * dir * step < n
          ? L[i + 2 * dir * step] - L[i + dir * step]
          : d2;
        if (d1 * d2 >= 0 && d2 * d3 >= 0 && d2 * d4 >= 0) ramp++;
      }
    }
  }
  // Dilate stroke evidence: the flanks of a 1px stroke are edge pixels with one
  // quiet neighbour — they count as border evidence when adjacent to a
  // stroke-like pixel, so a stroked card measures ~0.99, not ~0.31.
  let thin = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (mag[i] <= EDGE_MAGNITUDE) continue;
      const gx = L[i + 1] - L[i - 1];
      const gy = L[i + width] - L[i - width];
      const horiz = Math.abs(gx) >= Math.abs(gy);
      const step = horiz ? 1 : width;
      if (strokeLikeArr[i] || strokeLikeArr[i - step] || strokeLikeArr[i + step]
        || strokeLikeArr[i - width] || strokeLikeArr[i + width]) thin++;
    }
  }
  return {
    edgeCoverage: edgePixels / n,
    thinRatio: thin / edgePixels,
    // Ramp share of NON-STROKE edges: boundary edges are the honest
    // counterfactual for "is this edge content shadow-like".
    rampRatio: ramp / Math.max(ramp + otherThin + wide, 1),
  };
}

/**
 * Maps a measurement vs a decision threshold to 0..1 where 0.5 = exactly on the
 * threshold (maximally ambiguous) and 0 / 1 = decisively on one side.
 */
export function boundaryConfidence(value: number, threshold: number): number {
  const span = 2 * Math.max(threshold, 1 - threshold);
  return Math.min(1, Math.max(0, 0.5 + (value - threshold) / span));
}
```

- [ ] **Step 4: Implement the detector**

```ts
// src/verify/detectors/uses-borders.ts
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import { ensureRaw } from "../ctx.js";
import {
  inBand,
  recordedFor,
  type ConfidenceBand,
  type DetectorResult,
} from "../detector-types.js";
import { boundaryConfidence, DEGENERATE_COVERAGE, edgeStats } from "./pixels.js";

const BORDER_THRESHOLD = 0.45;
/** Declared here; the registry references this value (single source of truth). */
export const confidenceBand: ConfidenceBand = { low: 0.25, high: 0.75 };

/** Certifying for `true` only: an absence claim cannot be affirmed by measurement. */
export function canAffirm(recorded: unknown): boolean {
  return recorded === true;
}

export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const recorded = recordedFor(entry, "visual.usesBorders");
  const raw = await ensureRaw(ctx);
  const s = edgeStats(raw);
  if (s.edgeCoverage < DEGENERATE_COVERAGE) {
    return { verdict: "abstain", measured: s, confidence: 0.5, reason: "no edge content to measure (degenerate image)" };
  }
  const confidence = boundaryConfidence(s.thinRatio, BORDER_THRESHOLD);
  if (inBand(confidenceBand, confidence)) {
    return { verdict: "abstain", measured: s, confidence, reason: `thinRatio ${s.thinRatio.toFixed(3)} is inside the decision band` };
  }
  const hasBorders = s.thinRatio >= BORDER_THRESHOLD;
  if (recorded === true) {
    return hasBorders
      ? { verdict: "pass", measured: s, confidence, reason: `stroke-like thin edges dominate (thinRatio ${s.thinRatio.toFixed(3)})` }
      : { verdict: "contradicted", measured: s, confidence, reason: "no stroke-like thin edges found though borders are recorded" };
  }
  return hasBorders
    ? { verdict: "contradicted", measured: s, confidence, reason: "stroke-like thin edges found though no borders are recorded" }
    : { verdict: "abstain", measured: s, confidence: 0.5, reason: "no borders found; absence is not evidence of absence" };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/uses-borders.test.ts`
Expected: PASS (5 tests). If a fixture still fails, tune `EDGE_MAGNITUDE` / `STROKE_CONTRAST` in `pixels.ts` against the TUNE fixtures only, and re-run. Do NOT tune against held-out fixtures. Note: a thinRatio near 0.5 is structurally banded (boundaryConfidence ~0.545 stays inside `[0.25, 0.75]`) — the classifier must produce ratios near 0 or 1, not sit mid-band; if tuning cannot separate the classes, the classifier logic (not the constants) needs another pass.

- [ ] **Step 6: Commit**

```bash
git add src/verify/detectors/pixels.ts src/verify/detectors/uses-borders.ts src/verify/detectors/uses-borders.test.ts
git commit -m "feat(verify): usesBorders detector + shared edge helpers"
```

---

### Task 6: `usesShadows` certifying detector + the border/shadow pair test

**Files:**
- Create: `src/verify/detectors/uses-shadows.ts`
- Test: `src/verify/detectors/uses-shadows.test.ts`

**Interfaces:**
- Consumes: `edgeStats` (`pixels.ts`), `ensureRaw`, detector types, fixtures.
- Produces: `canAffirm(recorded): boolean` (`true` only) and `detect(entry, ctx): Promise<DetectorResult>`.

**Shadow model:** a shadow is a wide (4–20px) monotonic luma ramp (`rampRatio` from `edgeStats`). A border is a thin stroke; a flat card boundary is a step that is neither. The pair test pins the two high-risk confusions.

- [ ] **Step 1: Write the failing test**

```ts
// src/verify/detectors/uses-shadows.test.ts
import { describe, expect, it } from "vitest";
import { createVerifyCtx } from "../ctx.js";
import { fixtureImagePath } from "../__fixtures__/fixtures.js";
import { detect as borders } from "./uses-borders.js";
import { detect } from "./uses-shadows.js";
import type { CorpusEntryT } from "../../schema.js";

function entry(usesShadows: boolean): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor: null,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: "sharp",
      usesShadows, usesBorders: false,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("usesShadows detector", () => {
  it("passes a shadowed card recorded true", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("shadows-card-true"));
    expect((await detect(entry(true), ctx)).verdict).toBe("pass");
  });

  it("contradicts a flat card recorded true", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("shadows-flat-true"));
    expect((await detect(entry(true), ctx)).verdict).toBe("contradicted");
  });

  it("abstains on a solid image recorded true (absence invariant)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("shadows-solid"));
    expect((await detect(entry(true), ctx)).verdict).toBe("abstain");
  });

  it("contradicts a shadowed card recorded false", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("shadows-card-true"));
    expect((await detect(entry(false), ctx)).verdict).toBe("contradicted");
  });

  it("never confuses shadow with border (the pair)", async () => {
    const shadowed = await createVerifyCtx(fixtureImagePath("pair-shadowed-borderless"));
    expect((await borders(entry(true), shadowed)).verdict).toBe("contradicted");
    expect((await detect(entry(true), shadowed)).verdict).toBe("pass");

    const stroked = await createVerifyCtx(fixtureImagePath("pair-bordered-flat"));
    expect((await borders(entry(true), stroked)).verdict).toBe("pass");
    expect((await detect(entry(true), stroked)).verdict).toBe("contradicted");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/uses-shadows.test.ts`
Expected: FAIL — cannot resolve `./uses-shadows.js`.

- [ ] **Step 3: Implement**

```ts
// src/verify/detectors/uses-shadows.ts
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import { ensureRaw } from "../ctx.js";
import {
  inBand,
  recordedFor,
  type ConfidenceBand,
  type DetectorResult,
} from "../detector-types.js";
import { boundaryConfidence, DEGENERATE_COVERAGE, edgeStats } from "./pixels.js";

const SHADOW_THRESHOLD = 0.35;
/**
 * Declared here; the registry references this value. Shadows resolve ~0.75
 * for a genuine shadow and ~0.23 for a flat card, so the abstain band narrows
 * to [0.3, 0.7] (abstains rampRatio in [0.07, 0.63]) — a photo-gradient false
 * positive lands inside it. Validated empirically on the fixture set.
 */
export const confidenceBand: ConfidenceBand = { low: 0.3, high: 0.7 };

/** Certifying for `true` only — an absence claim cannot be affirmed by measurement. */
export function canAffirm(recorded: unknown): boolean {
  return recorded === true;
}

export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const recorded = recordedFor(entry, "visual.usesShadows");
  const raw = await ensureRaw(ctx);
  const s = edgeStats(raw);
  if (s.edgeCoverage < DEGENERATE_COVERAGE) {
    return { verdict: "abstain", measured: s, confidence: 0.5, reason: "no edge content to measure (degenerate image)" };
  }
  const confidence = boundaryConfidence(s.rampRatio, SHADOW_THRESHOLD);
  if (inBand(confidenceBand, confidence)) {
    return { verdict: "abstain", measured: s, confidence, reason: `rampRatio ${s.rampRatio.toFixed(3)} is inside the decision band` };
  }
  const hasShadows = s.rampRatio >= SHADOW_THRESHOLD;
  if (recorded === true) {
    return hasShadows
      ? { verdict: "pass", measured: s, confidence, reason: `monotonic ramps dominate (rampRatio ${s.rampRatio.toFixed(3)})` }
      : { verdict: "contradicted", measured: s, confidence, reason: "no shadow ramps found though shadows are recorded" };
  }
  return hasShadows
    ? { verdict: "contradicted", measured: s, confidence, reason: "shadow ramps found though no shadows are recorded" }
    : { verdict: "abstain", measured: s, confidence: 0.5, reason: "no shadows found; absence is not evidence of absence" };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/uses-shadows.test.ts`
Expected: PASS (5 tests, incl. the pair test). If the shadowed fixture fails, tune `EDGE_MAGNITUDE` / the monotonic-window constants in `pixels.ts` against TUNE fixtures only.

- [ ] **Step 5: Commit**

```bash
git add src/verify/detectors/uses-shadows.ts src/verify/detectors/uses-shadows.test.ts
git commit -m "feat(verify): usesShadows detector + border/shadow pair test"
```

---

### Task 7: `accentColor` certifying detector + color helpers

**Files:**
- Modify: `src/verify/detectors/pixels.ts` (add `parseHex`, `deltaE2000`, `colorStats`)
- Create: `src/verify/detectors/accent-color.ts`
- Test: `src/verify/detectors/accent-color.test.ts`

**Interfaces:**
- Consumes: `culori` (`differenceCiede2000`), `ensureRaw`, detector types, fixtures.
- Produces:
  - `parseHex(hex: string): [number, number, number]` — throws on anything but `#rrggbb`.
  - `deltaE2000(a: [number, number, number], b: [number, number, number]): number`
  - `interface ColorStats { total: number; matchCount: number; background: [number, number, number]; backgroundCount: number; largestNonBg: { rgb: [number, number, number]; count: number } | null }`
  - `colorStats(raw: RawBuffer, target: [number, number, number], tolerance: number): ColorStats`
  - `canAffirm(recorded): boolean` — any string; `detect(entry, ctx): Promise<DetectorResult>`.

**Certifying contract (maximality):** pass requires the recorded hex to be the LARGEST non-background colour cluster above an area floor. Presence alone is not "the accent" — the exact mistake the spec forbids for `colorRoles`.

- [ ] **Step 1: Write the failing test**

```ts
// src/verify/detectors/accent-color.test.ts
import { describe, expect, it } from "vitest";
import { createVerifyCtx } from "../ctx.js";
import { fixtureImagePath } from "../__fixtures__/fixtures.js";
import { detect } from "./accent-color.js";
import type { CorpusEntryT } from "../../schema.js";

function entry(accentColor: string | null): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: "sharp",
      usesShadows: false, usesBorders: false,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("accentColor detector", () => {
  it("passes when the recorded hex is the largest non-background colour", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("accent-primary-true"));
    const r = await detect(entry("#2563eb"), ctx);
    expect(r.verdict).toBe("pass");
  });

  it("contradicts a hex absent from the image", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("accent-primary-true"));
    const r = await detect(entry("#dc2626"), ctx);
    expect(r.verdict).toBe("contradicted");
  });

  it("abstains on a 2px speck (below the area floor)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("accent-primary-speck"));
    const r = await detect(entry("#2563eb"), ctx);
    expect(r.verdict).toBe("abstain");
  });

  it("abstains when present but not the largest colour (role unconfirmed)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("accent-primary-secondary"));
    const r = await detect(entry("#2563eb"), ctx);
    expect(r.verdict).toBe("abstain");
  });

  it("contradicts a recorded hex equal to the background", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("accent-bg-equal"));
    const r = await detect(entry("#f5f5f5"), ctx);
    expect(r.verdict).toBe("contradicted");
  });

  it("abstains on a malformed hex (unparseable, not disproven)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("accent-primary-true"));
    const r = await detect(entry("blue"), ctx);
    expect(r.verdict).toBe("abstain");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/accent-color.test.ts`
Expected: FAIL — cannot resolve `./accent-color.js`.

- [ ] **Step 3: Extend `pixels.ts` with the color helpers**

```ts
// append to src/verify/detectors/pixels.ts
import { differenceCiede2000 } from "culori";

const CIEDE = differenceCiede2000();

/** Parses `#rrggbb`; throws on anything else. */
export function parseHex(hex: string): [number, number, number] {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) throw new Error(`malformed hex ${hex}`);
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex(rgb: [number, number, number]): string {
  return `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("")}`;
}

/** CIEDE2000 distance between two RGB colours (culori). */
export function deltaE2000(a: [number, number, number], b: [number, number, number]): number {
  return CIEDE(rgbToHex(a), rgbToHex(b));
}

export interface ColorStats {
  total: number;
  matchCount: number;
  background: [number, number, number];
  backgroundCount: number;
  largestNonBg: { rgb: [number, number, number]; count: number } | null;
}

// 8-bit channel >> 3 keeps the top 5 bits: 32 levels per channel. The packing
// shifts MUST therefore be 10/5/0 — one full 5-bit field each. An earlier draft
// shifted 6/3/0, which overlaps the red field (bits 6-10) with the green field
// (bits 3-7): rgb(8,0,0) and rgb(0,64,0) both key to 64, so unrelated dark reds
// and greens merge into one bucket whose AVERAGE matches neither. That silently
// corrupts `background`, `largestNonBg`, `matchCount`, `largestComponent` and
// `componentsOf` — every consumer below. It is invisible on the synthetic
// fixtures (greys plus two well-separated hexes), so no test would catch it.
//
// 32 levels is also the granularity the detectors need: at 8 levels per channel
// (>> 5) #f5f5f5 and #ffffff both bucket to 7 and the colorRoles canvas check
// could never distinguish a near-white surface from white.
const BUCKET_BITS = 3;
const BUCKET_SHIFT_R = 10;
const BUCKET_SHIFT_G = 5;

/** The single bucket-key definition. Every consumer uses THIS — see the note above. */
export function bucketKey(r: number, g: number, b: number): number {
  return ((r >> BUCKET_BITS) << BUCKET_SHIFT_R)
    | ((g >> BUCKET_BITS) << BUCKET_SHIFT_G)
    | (b >> BUCKET_BITS);
}

/**
 * Colour statistics via coarse buckets (fast: one pass, no per-pixel ΔE).
 * `matchCount` = pixels within `tolerance` ΔE of `target`; `background` = the
 * largest bucket; `largestNonBg` = the largest bucket clearly distinct from it.
 */
export function colorStats(raw: RawBuffer, target: [number, number, number], tolerance: number): ColorStats {
  const { data, width, height } = raw;
  const buckets = new Map<number, { count: number; r: number; g: number; b: number }>();
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    const key = bucketKey(r, g, b);
    const bk = buckets.get(key) ?? { count: 0, r: 0, g: 0, b: 0 };
    bk.count++;
    bk.r += r;
    bk.g += g;
    bk.b += b;
    buckets.set(key, bk);
  }
  let bgKey = -1;
  let bgCount = 0;
  for (const [key, bk] of buckets) {
    if (bk.count > bgCount) { bgCount = bk.count; bgKey = key; }
  }
  const bg = buckets.get(bgKey)!;
  const background: [number, number, number] = [
    Math.round(bg.r / bg.count),
    Math.round(bg.g / bg.count),
    Math.round(bg.b / bg.count),
  ];
  let matchCount = 0;
  let largestNonBg: ColorStats["largestNonBg"] = null;
  for (const [key, bk] of buckets) {
    const rgb: [number, number, number] = [
      Math.round(bk.r / bk.count),
      Math.round(bk.g / bk.count),
      Math.round(bk.b / bk.count),
    ];
    if (deltaE2000(rgb, target) <= tolerance) matchCount += bk.count;
    if (key === bgKey) continue;
    if (deltaE2000(rgb, background) > tolerance * 2 && (!largestNonBg || bk.count > largestNonBg.count)) {
      largestNonBg = { rgb, count: bk.count };
    }
  }
  return { total: width * height, matchCount, background, backgroundCount: bgCount, largestNonBg };
}
```

- [ ] **Step 4: Implement the detector**

```ts
// src/verify/detectors/accent-color.ts
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import { ensureRaw } from "../ctx.js";
import {
  inBand,
  recordedFor,
  type ConfidenceBand,
  type DetectorResult,
} from "../detector-types.js";
import { boundaryConfidence, colorStats, deltaE2000, parseHex } from "./pixels.js";

const ACCENT_TOLERANCE = 6;
const BACKGROUND_EQUAL = 4;
const AREA_FLOOR = 0.005;
/** Declared here; the registry references this value (single source of truth). */
export const confidenceBand: ConfidenceBand = { low: 0.25, high: 0.75 };

/** Any recorded hex is affirmable (malformed values abstain inside detect). */
export function canAffirm(recorded: unknown): boolean {
  return typeof recorded === "string";
}

export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const recorded = recordedFor(entry, "visual.accentColor");
  if (typeof recorded !== "string") {
    return { verdict: "abstain", measured: null, confidence: 0.5, reason: "no recorded accent hex" };
  }
  let target: [number, number, number];
  try {
    target = parseHex(recorded);
  } catch (err) {
    return { verdict: "abstain", measured: recorded, confidence: 0.5, reason: `malformed recorded hex: ${String(err)}` };
  }
  const raw = await ensureRaw(ctx);
  const s = colorStats(raw, target, ACCENT_TOLERANCE);
  if (s.matchCount === 0) {
    return { verdict: "contradicted", measured: s, confidence: 0, reason: `recorded ${recorded} is absent from the image` };
  }
  if (deltaE2000(target, s.background) <= BACKGROUND_EQUAL) {
    return { verdict: "contradicted", measured: s, confidence: 0, reason: `recorded ${recorded} equals the background colour` };
  }
  if (s.matchCount < AREA_FLOOR * s.total) {
    return { verdict: "abstain", measured: s, confidence: 0.5, reason: "recorded hex present but below the area floor" };
  }
  // "Other" = every NON-BACKGROUND pixel that is NOT the target match. Using
  // largestNonBg here was a bug: on a single-colour image the largest non-bg
  // bucket IS the target, so share <= 0.5 always and the headline fixture
  // abstained (reproduced: accent-primary-true -> abstain @ conf 0.5).
  const other = Math.max(0, s.total - s.backgroundCount - s.matchCount);
  const share = s.matchCount / (s.matchCount + other);
  const confidence = boundaryConfidence(share, 0.5);
  if (inBand(confidenceBand, confidence)) {
    return { verdict: "abstain", measured: s, confidence, reason: "recorded hex and another colour are near-tied — accent role unconfirmed" };
  }
  if (s.largestNonBg && other > s.matchCount) {
    return { verdict: "abstain", measured: s, confidence, reason: "recorded hex present but another colour is larger — role unconfirmed" };
  }
  return { verdict: "pass", measured: s, confidence, reason: `recorded ${recorded} is the largest non-background colour (${s.matchCount} px)` };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/accent-color.test.ts`
Expected: PASS (6 tests). Two failure modes to distinguish:
- If `accent-primary-true` (single button) abstains, `other` still includes the target's own pixels — re-check the `total - backgroundCount - matchCount` formula.
- If `accent-primary-secondary` passes instead of abstaining, the sidebar bucket is not registering as larger — check the `deltaE2000(rgb, background) > tolerance * 2` distinctness filter (the sidebar must clear it; if not, widen the distinctness factor for the fixture's contrast).

- [ ] **Step 6: Commit**

```bash
git add src/verify/detectors/pixels.ts src/verify/detectors/accent-color.ts src/verify/detectors/accent-color.test.ts
git commit -m "feat(verify): accentColor detector with maximality contract"
```

---

### Task 8: `cornerStyle` certifying detector + component helpers

**Files:**
- Modify: `src/verify/detectors/pixels.ts` (add `largestComponent`, `cornerMeasure`)
- Create: `src/verify/detectors/corner-style.ts`
- Test: `src/verify/detectors/corner-style.test.ts`

**Interfaces:**
- Produces:
  - `interface ComponentBox { x: number; y: number; width: number; height: number; area: number }`
  - `largestComponent(raw: RawBuffer): ComponentBox | null` — BFS flood fill over non-background pixels.
  - `interface CornerMeasure { radius: number; consistency: number }`
  - `cornerMeasure(raw: RawBuffer, box: ComponentBox): CornerMeasure` — radius = mean EDGE INSET (walk each box edge inward from the corner, count background pixels until foreground; the inset IS the radius ±1px); consistency = 1 − corner spread / max(mean, 1).
  - `canAffirm(recorded)` — `sharp` | `slight-round` | `pill` only; `detect(entry, ctx)`.

**Bucket vocabulary is the schema enum** (`sharp | slight-round | pill | mixed`): radius ≤ 2 `sharp`, 2 < radius ≤ 20 `slight-round`, > 20 `pill`. `mixed` is never affirmable — a single-radius measurement can neither affirm nor contradict it, so the field stays in vision (the runner's job).

- [ ] **Step 1: Write the failing test**

```ts
// src/verify/detectors/corner-style.test.ts
import { describe, expect, it } from "vitest";
import { createVerifyCtx } from "../ctx.js";
import { fixtureImagePath } from "../__fixtures__/fixtures.js";
import { detect } from "./corner-style.js";
import type { CorpusEntryT } from "../../schema.js";

function entry(cornerStyle: string): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor: null,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: cornerStyle as CorpusEntryT["visual"]["cornerStyle"],
      usesShadows: false, usesBorders: false,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("cornerStyle detector", () => {
  it("maps radii onto the schema vocabulary (no square/rounded values)", async () => {
    const sharp = await createVerifyCtx(fixtureImagePath("corner-sharp-true"));
    const slight = await createVerifyCtx(fixtureImagePath("corner-slight-true"));
    const pill = await createVerifyCtx(fixtureImagePath("corner-pill-true"));
    expect((await detect(entry("sharp"), sharp)).verdict).toBe("pass");
    expect((await detect(entry("slight-round"), slight)).verdict).toBe("pass");
    expect((await detect(entry("pill"), pill)).verdict).toBe("pass");
  });

  it("abstains on a band-boundary radius (2px — exactly sharp/slight)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("corner-band"));
    expect((await detect(entry("slight-round"), ctx)).verdict).toBe("abstain");
  });

  it("abstains on recorded mixed — never affirmable", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("corner-mixed"));
    expect((await detect(entry("mixed"), ctx)).verdict).toBe("abstain");
  });

  it("contradicts a mismatched bucket", async () => {
    const sharp = await createVerifyCtx(fixtureImagePath("corner-sharp-true"));
    expect((await detect(entry("pill"), sharp)).verdict).toBe("contradicted");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/corner-style.test.ts`
Expected: FAIL — cannot resolve `./corner-style.js`.

- [ ] **Step 3: Extend `pixels.ts` with component helpers**

```ts
// append to src/verify/detectors/pixels.ts
export interface ComponentBox {
  x: number;
  y: number;
  width: number;
  height: number;
  area: number;
}

// `bucketKey` is defined ONCE, in the Task 7 block above (exported). Do NOT
// redeclare it here: an earlier draft had two copies with different shifts, and
// the second one silently corrupted every component/background consumer in this
// task and Task 9. It is already in scope in this file.

/** The most common colour bucket — treated as the image background. */
export function backgroundBucketKey(raw: RawBuffer): number {
  const { data, width, height } = raw;
  const counts = new Map<number, number>();
  for (let i = 0; i < width * height; i++) {
    const key = bucketKey(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let bestKey = -1;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) { bestCount = count; bestKey = key; }
  }
  return bestKey;
}

/** The largest connected region of non-background pixels (4-connectivity BFS). */
export function largestComponent(raw: RawBuffer): ComponentBox | null {
  const { data, width, height } = raw;
  const n = width * height;
  const bgKey = backgroundBucketKey(raw);
  const visited = new Uint8Array(n);
  let best: ComponentBox | null = null;
  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    const startKey = bucketKey(data[start * 4], data[start * 4 + 1], data[start * 4 + 2]);
    if (startKey === bgKey) { visited[start] = 1; continue; }
    let area = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    const queue = [start];
    visited[start] = 1;
    while (queue.length > 0) {
      const i = queue.pop()!;
      area++;
      const x = i % width;
      const y = (i / width) | 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const j of [i - 1, i + 1, i - width, i + width]) {
        if (j < 0 || j >= n || visited[j]) continue;
        if (bucketKey(data[j * 4], data[j * 4 + 1], data[j * 4 + 2]) === bgKey) {
          visited[j] = 1;
          continue;
        }
        visited[j] = 1;
        queue.push(j);
      }
    }
    if (!best || area > best.area) {
      best = { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area };
    }
  }
  return best;
}

export interface CornerMeasure {
  radius: number;
  consistency: number;
}

/**
 * Corner radius estimate via EDGE INSET. From each bounding-box corner, walk
 * inward along each of the two box edges, counting background pixels until the
 * first foreground pixel. For a rounded corner radius r the inset is r (±1px);
 * for a sharp corner it is 0. Mean over all 8 edge samples = radius.
 *
 * The previous diagonal walk was a bug: it walked `(cx+k, cy+k)` UNIFORMLY, so
 * for the top-right and bottom-left corners it headed OUTWARD, hit the image
 * edge at k=32, and every rounded fixture abstained on "corners disagree".
 */
export function cornerMeasure(raw: RawBuffer, box: ComponentBox): CornerMeasure {
  const { data, width, height } = raw;
  const bgKey = backgroundBucketKey(raw);
  const isBg = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return true;
    const i = (y * width + x) * 4;
    return bucketKey(data[i], data[i + 1], data[i + 2]) === bgKey;
  };
  const right = box.x + box.width - 1;
  const bottom = box.y + box.height - 1;
  const corners: Array<{ x: number; y: number; dx: number; dy: number }> = [
    { x: box.x, y: box.y, dx: 1, dy: 1 },     // top-left: inward is +x, +y
    { x: right, y: box.y, dx: -1, dy: 1 },    // top-right: inward is -x, +y
    { x: box.x, y: bottom, dx: 1, dy: -1 },   // bottom-left: inward is +x, -y
    { x: right, y: bottom, dx: -1, dy: -1 },  // bottom-right: inward is -x, -y
  ];
  const insets: number[] = [];
  for (const c of corners) {
    let kx = 0;
    while (kx < 32 && isBg(c.x + c.dx * kx, c.y)) kx++;
    insets.push(kx);
    let ky = 0;
    while (ky < 32 && isBg(c.x, c.y + c.dy * ky)) ky++;
    insets.push(ky);
  }
  const avg = insets.reduce((a, b) => a + b, 0) / insets.length;
  const radius = avg; // edge inset IS the radius (±1px) — no diagonal factor
  const spread = Math.max(...insets) - Math.min(...insets);
  const consistency = Math.max(0, 1 - spread / Math.max(avg, 1));
  return { radius, consistency };
}
```

- [ ] **Step 4: Implement the detector**

```ts
// src/verify/detectors/corner-style.ts
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import { ensureRaw } from "../ctx.js";
import {
  inBand,
  recordedFor,
  type ConfidenceBand,
  type DetectorResult,
} from "../detector-types.js";
import { cornerMeasure, largestComponent } from "./pixels.js";

/** Declared here; the registry references this value (single source of truth). */
export const confidenceBand: ConfidenceBand = { low: 0.25, high: 0.75 };
const BOUNDARY_MARGIN = 2; // px; inside this distance of a bucket boundary -> band

const AFFIRMABLE = new Set(["sharp", "slight-round", "pill"]);

export function canAffirm(recorded: unknown): boolean {
  return typeof recorded === "string" && AFFIRMABLE.has(recorded);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const recorded = recordedFor(entry, "visual.cornerStyle");
  if (!canAffirm(recorded)) {
    return {
      verdict: "abstain", measured: recorded, confidence: 0.5,
      reason: "mixed (or unaffirmable) corner style cannot be certified by a single-radius measurement",
    };
  }
  const raw = await ensureRaw(ctx);
  const box = largestComponent(raw);
  if (!box || box.area < 64) {
    return { verdict: "abstain", measured: null, confidence: 0.5, reason: "no measurable component" };
  }
  const m = cornerMeasure(raw, box);
  if (m.consistency < 0.7) {
    return { verdict: "abstain", measured: m, confidence: 0.5, reason: "corners disagree (consistency below 0.7)" };
  }
  const distanceToBoundary = Math.min(Math.abs(m.radius - 2), Math.abs(m.radius - 20));
  const confidence = clamp01(0.5 - 0.5 * (distanceToBoundary / BOUNDARY_MARGIN));
  if (inBand(confidenceBand, confidence)) {
    return { verdict: "abstain", measured: m, confidence, reason: `radius ${m.radius.toFixed(1)}px is inside the bucket boundary band` };
  }
  const measured = m.radius <= 2 ? "sharp" : m.radius <= 20 ? "slight-round" : "pill";
  return measured === recorded
    ? { verdict: "pass", measured: m, confidence, reason: `measured ${measured} (radius ${m.radius.toFixed(1)}px) matches recorded ${recorded}` }
    : { verdict: "contradicted", measured: m, confidence, reason: `measured ${measured} (radius ${m.radius.toFixed(1)}px), recorded ${recorded}` };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/corner-style.test.ts`
Expected: PASS (4 tests). The edge-inset estimator is accurate to ±1px, so the tune fixtures (0/4/12) and held-out (6/18) sit well inside their buckets; the pill fixture (drawn 25 on the 80×50 card) is decisively past 20. The band fixture uses INTEGER radius 2 (drawn 2.5 measures ~5 on the integer grid because the fractional radius leaves a background dead zone on the edge walk — the spec's "2.5px" example is not drawable as intended). If a fixture still lands in the band, tune `BOUNDARY_MARGIN` against TUNE fixtures only — never re-introduce a diagonal factor.

- [ ] **Step 6: Commit**

```bash
git add src/verify/detectors/pixels.ts src/verify/detectors/corner-style.ts src/verify/detectors/corner-style.test.ts
git commit -m "feat(verify): cornerStyle detector on the schema vocabulary"
```

---

### Task 9: `spacingDensity` certifying detector + gap helpers

**Files:**
- Modify: `src/verify/detectors/pixels.ts` (add `componentsOf`, `elementGaps`)
- Create: `src/verify/detectors/spacing-density.ts`
- Test: `src/verify/detectors/spacing-density.test.ts`

**Interfaces:**
- Produces:
  - `componentsOf(raw: RawBuffer): ComponentBox[]` — all non-background connected regions (reuses the BFS from `largestComponent`, collecting every component).
  - `interface ElementGaps { count: number; medianGap: number; medianSize: number; gapRatio: number }`
  - `elementGaps(raw: RawBuffer): ElementGaps` — nearest-neighbour Chebyshev distance between component bounding boxes; `gapRatio = medianGap / medianSize`.
  - `canAffirm(recorded)` — all enum values; `detect(entry, ctx)`.

**Buckets (calibration constants, tunable):** `gapRatio ≤ 1` `compact`, `≤ 2.5` `moderate`, `> 2.5` `spacious`. Fewer than 2 elements → `abstain` (a gap of zero / undefined is not evidence).

- [ ] **Step 1: Write the failing test**

```ts
// src/verify/detectors/spacing-density.test.ts
import { describe, expect, it } from "vitest";
import { createVerifyCtx } from "../ctx.js";
import { fixtureImagePath } from "../__fixtures__/fixtures.js";
import { detect } from "./spacing-density.js";
import type { CorpusEntryT } from "../../schema.js";

function entry(spacingDensity: string): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor: null,
      typePairing: { display: null, body: null },
      spacingDensity: spacingDensity as CorpusEntryT["visual"]["spacingDensity"],
      cornerStyle: "sharp", usesShadows: false, usesBorders: false,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("spacingDensity detector", () => {
  it("passes compact / moderate / spacious grids", async () => {
    const compact = await createVerifyCtx(fixtureImagePath("spacing-compact-true"));
    const moderate = await createVerifyCtx(fixtureImagePath("spacing-moderate-true"));
    const spacious = await createVerifyCtx(fixtureImagePath("spacing-spacious-true"));
    expect((await detect(entry("compact"), compact)).verdict).toBe("pass");
    expect((await detect(entry("moderate"), moderate)).verdict).toBe("pass");
    expect((await detect(entry("spacious"), spacious)).verdict).toBe("pass");
  });

  it("contradicts a mismatched density", async () => {
    const compact = await createVerifyCtx(fixtureImagePath("spacing-compact-true"));
    expect((await detect(entry("spacious"), compact)).verdict).toBe("contradicted");
  });

  it("abstains on a single-element image rather than reporting a zero gap", async () => {
    const single = await createVerifyCtx(fixtureImagePath("spacing-single"));
    expect((await detect(entry("moderate"), single)).verdict).toBe("abstain");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/spacing-density.test.ts`
Expected: FAIL — cannot resolve `./spacing-density.js`.

- [ ] **Step 3: Extend `pixels.ts` with the gap helpers**

```ts
// append to src/verify/detectors/pixels.ts
/** Every non-background connected region (4-connectivity). */
export function componentsOf(raw: RawBuffer): ComponentBox[] {
  const { data, width, height } = raw;
  const n = width * height;
  const bgKey = backgroundBucketKey(raw);
  const visited = new Uint8Array(n);
  const out: ComponentBox[] = [];
  for (let start = 0; start < n; start++) {
    if (visited[start]) continue;
    if (bucketKey(data[start * 4], data[start * 4 + 1], data[start * 4 + 2]) === bgKey) {
      visited[start] = 1;
      continue;
    }
    let area = 0;
    let minX = width, minY = height, maxX = -1, maxY = -1;
    const queue = [start];
    visited[start] = 1;
    while (queue.length > 0) {
      const i = queue.pop()!;
      area++;
      const x = i % width;
      const y = (i / width) | 0;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const j of [i - 1, i + 1, i - width, i + width]) {
        if (j < 0 || j >= n || visited[j]) continue;
        if (bucketKey(data[j * 4], data[j * 4 + 1], data[j * 4 + 2]) === bgKey) {
          visited[j] = 1;
          continue;
        }
        visited[j] = 1;
        queue.push(j);
      }
    }
    out.push({ x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area });
  }
  return out;
}

export interface ElementGaps {
  count: number;
  medianGap: number;
  medianSize: number;
  gapRatio: number;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Median nearest-neighbour gap between component bounding boxes (Chebyshev),
 * normalised by the median element size.
 */
export function elementGaps(raw: RawBuffer): ElementGaps {
  const components = componentsOf(raw);
  if (components.length < 2) {
    return { count: components.length, medianGap: 0, medianSize: 0, gapRatio: 0 };
  }
  const nearest: number[] = [];
  for (const a of components) {
    let best = Infinity;
    for (const b of components) {
      if (a === b) continue;
      const dx = Math.max(0, Math.abs(a.x - b.x) - a.width);
      const dy = Math.max(0, Math.abs(a.y - b.y) - a.height);
      best = Math.min(best, Math.max(dx, dy));
    }
    nearest.push(best);
  }
  const medianGap = median(nearest);
  const medianSize = median(components.map((c) => Math.sqrt(c.area)));
  return { count: components.length, medianGap, medianSize, gapRatio: medianGap / Math.max(medianSize, 1) };
}
```

- [ ] **Step 4: Implement the detector**

```ts
// src/verify/detectors/spacing-density.ts
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import { ensureRaw } from "../ctx.js";
import {
  inBand,
  recordedFor,
  type ConfidenceBand,
  type DetectorResult,
} from "../detector-types.js";
import { elementGaps } from "./pixels.js";

const COMPACT_MAX = 1;
const MODERATE_MAX = 2.5;
/** Declared here; the registry references this value (single source of truth). */
export const confidenceBand: ConfidenceBand = { low: 0.25, high: 0.75 };
const BOUNDARY_MARGIN = 0.4; // gapRatio units; inside this distance of a bucket boundary -> band

const AFFIRMABLE = new Set(["compact", "moderate", "spacious"]);

export function canAffirm(recorded: unknown): boolean {
  return typeof recorded === "string" && AFFIRMABLE.has(recorded);
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const recorded = recordedFor(entry, "visual.spacingDensity");
  if (!canAffirm(recorded)) {
    return { verdict: "abstain", measured: recorded, confidence: 0.5, reason: "unaffirmable spacingDensity value" };
  }
  const raw = await ensureRaw(ctx);
  const g = elementGaps(raw);
  if (g.count < 2) {
    return { verdict: "abstain", measured: g, confidence: 0.5, reason: "fewer than two elements — a zero gap is not evidence" };
  }
  const boundaries = [COMPACT_MAX, MODERATE_MAX];
  const d = Math.min(...boundaries.map((b) => Math.abs(g.gapRatio - b)));
  const confidence = clamp01(0.5 - 0.5 * (d / BOUNDARY_MARGIN));
  if (inBand(confidenceBand, confidence)) {
    return { verdict: "abstain", measured: g, confidence, reason: `gapRatio ${g.gapRatio.toFixed(2)} is inside the bucket boundary band` };
  }
  const measured = g.gapRatio <= COMPACT_MAX ? "compact" : g.gapRatio <= MODERATE_MAX ? "moderate" : "spacious";
  return measured === recorded
    ? { verdict: "pass", measured: g, confidence, reason: `measured ${measured} (gapRatio ${g.gapRatio.toFixed(2)}) matches recorded ${recorded}` }
    : { verdict: "contradicted", measured: g, confidence, reason: `measured ${measured} (gapRatio ${g.gapRatio.toFixed(2)}), recorded ${recorded}` };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/spacing-density.test.ts`
Expected: PASS (3 tests). If a grid lands in the band, adjust the fixture gaps (Task 4) or `BOUNDARY_MARGIN` against TUNE fixtures only.

- [ ] **Step 6: Commit**

```bash
git add src/verify/detectors/pixels.ts src/verify/detectors/spacing-density.ts src/verify/detectors/spacing-density.test.ts
git commit -m "feat(verify): spacingDensity detector"
```

---

### Task 10: `visual.colorRoles` contradiction-only detector

**Files:**
- Create: `src/verify/detectors/color-roles.ts`
- Test: `src/verify/detectors/color-roles.test.ts`

**Interfaces:**
- Consumes: `colorStats`, `parseHex`, `deltaE2000` (`pixels.ts`), detector types, the `roles-card` fixture.
- Produces: `canAffirm(recorded)` — always `false` (never pass); `detect(entry, ctx): Promise<DetectorResult>`.

**Contract:** one key holding five sub-values. Presence of a hex does not verify its ROLE, so the detector can only disprove: a recorded hex wholly absent, or a `canvas` that is measurably not the largest-area colour → `contradicted`. A fully matching set → `abstain`, NEVER `pass` (the runner enforces the downgrade too).

- [ ] **Step 1: Write the failing test**

```ts
// src/verify/detectors/color-roles.test.ts
import { describe, expect, it } from "vitest";
import { createVerifyCtx } from "../ctx.js";
import { fixtureImagePath } from "../__fixtures__/fixtures.js";
import { detect } from "./color-roles.js";
import type { CorpusEntryT } from "../../schema.js";

const FULL_ROLES = {
  canvas: "#f5f5f5", surface: "#ffffff", ink: "#111111", muted: null, accent: "#2563eb",
};

function entry(colorRoles: CorpusEntryT["visual"]["colorRoles"]): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor: null, colorRoles,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: "sharp",
      usesShadows: false, usesBorders: false,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("colorRoles detector (contradiction-only)", () => {
  it("never passes a fully matching role set — abstains instead", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("roles-card"));
    const r = await detect(entry(FULL_ROLES), ctx);
    expect(r.verdict).toBe("abstain");
  });

  it("contradicts a recorded hex wholly absent from the image", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("roles-card"));
    const r = await detect(entry({ ...FULL_ROLES, ink: "#123456" }), ctx);
    expect(r.verdict).toBe("contradicted");
  });

  it("contradicts a canvas that is not the largest-area colour", async () => {
    // `#111111` on a light card: the claimed canvas is nowhere near the dominant
    // colour, so the claim is positively disproven.
    const ctx = await createVerifyCtx(fixtureImagePath("roles-card"));
    const r = await detect(entry({ ...FULL_ROLES, canvas: "#111111" }), ctx);
    expect(r.verdict).toBe("contradicted");
  });

  it("ABSTAINS on a canvas that is perceptually near the real background", async () => {
    // roles-card's background is #f5f5f5; a recorded canvas of #ffffff is
    // ΔE2000 ≈ 2.0 from it — far below CANVAS_EQUAL (8). Calling that a
    // contradiction would put a false accusation in the human triage queue over
    // a difference nobody can see. An earlier draft asserted `contradicted`
    // here, which the threshold made unreachable; `abstain` is both what the
    // code does and what it SHOULD do.
    const ctx = await createVerifyCtx(fixtureImagePath("roles-card"));
    const r = await detect(entry({ ...FULL_ROLES, canvas: "#ffffff" }), ctx);
    expect(r.verdict).toBe("abstain");
  });

  it("abstains on a malformed hex (unparseable, not disproven)", async () => {
    const ctx = await createVerifyCtx(fixtureImagePath("roles-card"));
    const r = await detect(entry({ ...FULL_ROLES, accent: "blue" }), ctx);
    expect(r.verdict).toBe("abstain");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/color-roles.test.ts`
Expected: FAIL — cannot resolve `./color-roles.js`.

- [ ] **Step 3: Implement**

```ts
// src/verify/detectors/color-roles.ts
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import { ensureRaw } from "../ctx.js";
import type { DetectorResult } from "../detector-types.js";
import { colorStats, deltaE2000, parseHex } from "./pixels.js";

const ROLE_TOLERANCE = 8;
const CANVAS_EQUAL = 8;

/** Contradiction-only: this detector can disprove but never grant a pass. */
export function canAffirm(): boolean {
  return false;
}

const ROLES = ["canvas", "surface", "ink", "muted", "accent"] as const;

export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const roles = entry.visual?.colorRoles;
  if (!roles) {
    return { verdict: "abstain", measured: null, confidence: 0.5, reason: "no recorded colorRoles" };
  }
  const raw = await ensureRaw(ctx);
  const checked: string[] = [];
  const skipped: string[] = [];
  for (const role of ROLES) {
    const hex = roles[role];
    if (hex === null || hex === undefined) continue;
    let target: [number, number, number];
    try {
      target = parseHex(hex);
    } catch {
      skipped.push(role);
      continue;
    }
    const s = colorStats(raw, target, ROLE_TOLERANCE);
    if (s.matchCount === 0) {
      return {
        verdict: "contradicted", measured: { role, hex }, confidence: 0,
        reason: `recorded ${role} ${hex} is absent from the image`,
      };
    }
    checked.push(role);
    if (role === "canvas") {
      if (deltaE2000(target, s.background) > CANVAS_EQUAL) {
        return {
          verdict: "contradicted", measured: { role, hex, background: s.background }, confidence: 0,
          reason: `recorded canvas ${hex} is not the largest-area colour (background is ${s.background.join(",")})`,
        };
      }
    }
  }
  if (skipped.length > 0) {
    return { verdict: "abstain", measured: { checked, skipped }, confidence: 0.5, reason: `unparseable role hexes: ${skipped.join(", ")}` };
  }
  return {
    verdict: "abstain", measured: { checked }, confidence: 0.5,
    reason: "all recorded role hexes are present, but presence does not confirm role assignment",
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/color-roles.test.ts`
Expected: PASS (4 tests). The malformed-hex case returns `abstain` even though all other roles are present — that is the "unparseable is unverifiable, not disproven" contract.

- [ ] **Step 5: Commit**

```bash
git add src/verify/detectors/color-roles.ts src/verify/detectors/color-roles.test.ts
git commit -m "feat(verify): colorRoles contradiction-only detector"
```

---

### Task 11: `antiPatterns.accessibilityRisks` contradiction-only detector

**Files:**
- Create: `src/verify/detectors/accessibility-risks.ts`
- Test: `src/verify/detectors/accessibility-risks.test.ts`

**Interfaces:**
- Consumes: `culori` (`wcagContrast`), detector types. No pixels, no `ctx` — pure arithmetic.
- Produces: `canAffirm(recorded)` — always `false`; `detect(entry, _ctx): Promise<DetectorResult>`.

**Contract:** a listed contrast risk that is arithmetically FALSE is bad data worth surfacing. A risk that "comfortably clears" its threshold (`ratio >= threshold + 0.5`) is `contradicted`. Everything else — hit-target risks, an unresolvable colour pair, a genuine low ratio — is `abstain` (not disproven).

**Read the criteria from `wcag[]`, and the colours from `colorRoles` — measured against the real corpus.** An earlier draft parsed both the WCAG criterion and two hexes out of the `risk` prose. Measured over all 11 recorded risks in `corpus/entries.json`:

| | count |
| --- | --- |
| risks total | 11 |
| contrast criterion present in `wcag[]` | **2** |
| contrast criterion present in the `risk` prose | **0** |
| two-or-more hexes in the `risk` prose | **0** |
| two-or-more hexes in `evidence` | **0** |

So the prose-parsing version could never fire on real data — it would abstain on 11 of 11 forever while passing its own synthetic-string tests. Two corrections follow:

1. **Criteria come from `r.wcag`**, which `AccessibilityRisk` declares required (`z.array(...).min(1).max(3)`, `schema.ts:232`) and which a dedicated `migrate-wcag-ids` script exists to keep canonical. Never from the prose.
2. **The colour pair comes from `visual.colorRoles`**, because the risks carry no hexes at all. Resolve the risk to a role pair by its `element` text (`text`/`body`/`label` → `ink` on `canvas`; `muted`/`secondary`/`placeholder` → `muted` on `canvas`; `button`/`link`/`cta` → `accent` on `canvas`). An unresolvable `element`, or a `colorRoles` missing either side (`muted` is nullable, `schema.ts:419-425`), is `abstain`.

**Honest scope:** this yields at most 2 checkable risks across the entire corpus today. It is worth keeping because it is exact arithmetic and cheap, but it should not be expected to surface much until the corpus records more a11y risks — and it must not be counted as evidence the detector layer is working.

- [ ] **Step 1: Write the failing test**

```ts
// src/verify/detectors/accessibility-risks.test.ts
import { describe, expect, it } from "vitest";
import { detect } from "./accessibility-risks.js";
import type { CorpusEntryT } from "../../schema.js";

// Mirrors the REAL AccessibilityRisk shape (schema.ts:227-233): `wcag` is a
// required canonical-ID array, and `evidence`/`confidence` are required too.
// The detector reads `wcag` and `element`, never the prose.
type TestRisk = { element: string; risk: string; evidence: string; confidence: "visible" | "inferred" | "dom-grounded"; wcag: string[] };
const RISK_ROLES = { canvas: "#ffffff", surface: "#ffffff", ink: "#111111", muted: "#9ca3af", accent: "#0000ff" };
function entry(risks: TestRisk[], roles: Record<string, string | null> = RISK_ROLES): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor: null,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: "sharp",
      usesShadows: false, usesBorders: false,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: risks },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  } as CorpusEntryT;
}

describe("accessibilityRisks detector (contradiction-only)", () => {
  const risk = (element: string, wcag: string[]): TestRisk =>
    ({ element, risk: `${element} contrast is insufficient for readers`, evidence: "visual inspection", confidence: "visible", wcag });

  it("contradicts a 1.4.3 claim on ink/canvas that actually measures ~19:1", async () => {
    // ink #111111 on canvas #ffffff. The criterion comes from wcag[], the colours
    // from colorRoles — neither is parsed out of the prose, which carries neither.
    const r = await detect(entry([risk("body text", ["1.4.3"])]), null as never);
    expect(r.verdict).toBe("contradicted");
    expect((r.measured as { ratio: number }).ratio).toBeGreaterThan(5);
  });

  it("abstains on a genuine low-contrast muted/canvas pair (not disproven)", async () => {
    // muted #9ca3af on #ffffff is ~2.5:1 — the recorded risk is plausible, so the
    // detector must NOT contradict it.
    const r = await detect(entry([risk("muted label", ["1.4.3"])]), null as never);
    expect(r.verdict).toBe("abstain");
  });

  it("contradicts a false 1.4.11 non-text claim on accent/canvas", async () => {
    const r = await detect(entry([risk("button", ["1.4.11"])]), null as never);
    expect(r.verdict).toBe("contradicted");
  });

  it("abstains on a hit-target risk — no contrast criterion in wcag[]", async () => {
    const r = await detect(entry([risk("button", ["2.5.8"])]), null as never);
    expect(r.verdict).toBe("abstain");
  });

  it("abstains when the element does not resolve to a role pair", async () => {
    const r = await detect(entry([risk("decorative divider", ["1.4.3"])]), null as never);
    expect(r.verdict).toBe("abstain");
  });

  it("abstains when colorRoles cannot supply the pair (muted is nullable)", async () => {
    const r = await detect(
      entry([risk("muted label", ["1.4.3"])], { ...RISK_ROLES, muted: null }),
      null as never,
    );
    expect(r.verdict).toBe("abstain");
  });

  it("NEVER contradicts by reading the prose — a criterion only in the text is ignored", async () => {
    // Guards the regression this task fixes: 0 of 11 real risks name a criterion
    // in the prose, so a prose-reading detector abstains on the whole corpus while
    // passing synthetic-string tests.
    const proseOnly: TestRisk = {
      element: "body text", risk: "text #111111 on #ffffff fails WCAG 1.4.3",
      evidence: "visual inspection", confidence: "visible", wcag: ["2.5.8"],
    };
    const r = await detect(entry([proseOnly]), null as never);
    expect(r.verdict).toBe("abstain");
  });

  it("abstains when no risks are recorded", async () => {
    const r = await detect(entry([]), null as never);
    expect(r.verdict).toBe("abstain");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/accessibility-risks.test.ts`
Expected: FAIL — cannot resolve `./accessibility-risks.js`.

- [ ] **Step 3: Implement**

```ts
// src/verify/detectors/accessibility-risks.ts
import { wcagContrast } from "culori";
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import type { DetectorResult } from "../detector-types.js";

/** Contradiction-only: contrast arithmetic can disprove a listed risk, never confirm the field. */
export function canAffirm(): boolean {
  return false;
}

// Contrast criteria, read from the REQUIRED canonical `wcag[]` array — never from
// the risk prose. Measured over the real corpus: 2 of 11 risks name a contrast
// criterion in `wcag[]`; ZERO name one in the prose, and zero carry two hexes
// anywhere. A prose-parsing detector abstains on 11 of 11 forever.
const CONTRAST_CRITERIA: Record<string, number> = { "1.4.3": 4.5, "1.4.11": 3.0 };
const CLEAR_MARGIN = 0.5; // must comfortably clear the threshold to contradict

/**
 * Which colorRoles pair a risk's `element` refers to. The risks carry no hexes,
 * so the pair must come from the recorded roles; an element we cannot map is
 * abstained rather than guessed.
 */
function rolePairFor(element: string): { fg: "ink" | "muted" | "accent"; bg: "canvas" } | null {
  const e = element.toLowerCase();
  if (/\b(muted|secondary|placeholder|caption|hint)\b/.test(e)) return { fg: "muted", bg: "canvas" };
  if (/\b(button|link|cta|action)\b/.test(e)) return { fg: "accent", bg: "canvas" };
  if (/\b(text|body|label|heading|title|paragraph)\b/.test(e)) return { fg: "ink", bg: "canvas" };
  return null;
}

export async function detect(entry: CorpusEntryT, _ctx: VerifyCtx): Promise<DetectorResult> {
  const risks = entry.antiPatterns?.accessibilityRisks ?? [];
  if (risks.length === 0) {
    return { verdict: "abstain", measured: null, confidence: 0.5, reason: "no recorded accessibility risks" };
  }
  const roles = entry.visual?.colorRoles ?? null;
  for (const r of risks) {
    // `wcag` is required and canonical (schema.ts:232); a risk may list up to 3.
    const criterion = (r.wcag ?? []).find((w) => w in CONTRAST_CRITERIA);
    if (criterion === undefined) continue;
    const pair = rolePairFor(r.element ?? "");
    if (pair === null || roles === null) continue;
    const fg = (roles as Record<string, string | null | undefined>)[pair.fg];
    const bg = (roles as Record<string, string | null | undefined>)[pair.bg];
    // `muted` is nullable (schema.ts:419-425) — an absent side is unverifiable.
    if (!fg || !bg) continue;
    const ratio = wcagContrast(fg, bg);
    if (typeof ratio !== "number" || Number.isNaN(ratio)) continue;
    const threshold = CONTRAST_CRITERIA[criterion];
    if (ratio >= threshold + CLEAR_MARGIN) {
      return {
        verdict: "contradicted",
        measured: { element: r.element, criterion, fg, bg, ratio },
        confidence: 0,
        reason: `listed ${criterion} risk on "${r.element}" is arithmetically false: ${pair.fg} ${fg} on ${pair.bg} ${bg} is ${ratio.toFixed(2)}:1, clearing ${threshold}:1`,
      };
    }
  }
  return {
    verdict: "abstain", measured: null, confidence: 0.5,
    reason: "no listed contrast risk was disproven (no contrast criterion in wcag[], no resolvable role pair, or the ratio is genuinely low)",
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detectors/accessibility-risks.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/verify/detectors/accessibility-risks.ts src/verify/detectors/accessibility-risks.test.ts
git commit -m "feat(verify): accessibilityRisks contradiction-only detector"
```

---

### Task 12: The registry, the runner, and verifyEntry integration

**Files:**
- Create: `src/verify/detectors/platform.ts` (moves `verifyMechanicalFields`' platform logic)
- Create: `src/verify/detectors/dominant-colors.ts` (moves the dominantColors logic)
- Create: `src/verify/detector-registry.ts`
- Create: `src/verify/runner.ts`
- Create: `src/verify/detector-registry.test.ts` (registry contract test)
- Create: `src/verify/runner.test.ts` (verifyEntry integration: pending shrinks, non-affirmable stays, contradicted excluded, `--detectors off` byte-identical)
- Modify: `src/scripts/verify-corpus.ts` (TIER_BY_FIELD reclassification, value-aware pending filter, `runDetectors` wiring, `--detectors` CLI flag; delete `verifyMechanicalFields`)
- Modify: `src/scripts/verify-corpus.test.ts` (delete the old `verifyMechanicalFields` tests; they move to the runner tests)

**Interfaces:**
- Consumes: all detector modules (Tasks 5–11), `recordedFor` / `inBand` / `DetectorEntry` (detector-types), `createVerifyCtx` / `ensureRaw` (ctx).
- Produces:
  - `detectorRegistry: Record<string, DetectorEntry>` — the single place deterministic status is declared.
  - `capVerdict(det: DetectorEntry, result: DetectorResult, recorded: unknown): DetectorVerdict` — band wins; contradiction-only `pass` → `abstain`; certifying `pass` on a non-affirmable value → `abstain`.
  - `interface RunDetectorsOutcome { passes: string[]; contradicted: string[]; abstained: string[] }`
  - `runDetectors(entry, ctx, opts?: { detectors?: boolean }): Promise<RunDetectorsOutcome>` — `detectors: false` runs ONLY `platform` + `visual.dominantColors` (they stay deterministic today); every detector is wrapped so a throw → `abstain` for that field.
  - `fieldLeavesVisionForEntry(entry, field, detectorsEnabled): boolean` — the value-aware pending filter.
  - `verifyEntry(entry, imagePath, deps)` now takes `deps.detectors?: boolean` (default `true`).

- [ ] **Step 0: Widen `FieldVerdict` FIRST — this task does not compile without it**

`FieldVerdict.verdict` is `"pass" | "fail" | "gate"` today (`verify-corpus.ts:25-29`),
and `buildRunReport`'s tally is a fixed `{ pass, fail, gate }` object indexed by
`counts[v.verdict]`. This task emits `"contradicted"` and `"abstain"`, so the
widening cannot wait for Task 14 (where an earlier draft put it) — Tasks 12 and 13
would not typecheck, and the run report would produce `NaN` counts for the new
labels.

```ts
// verify-corpus.ts
export type FieldVerdict = {
  field: string;
  verdict: "pass" | "fail" | "contradicted" | "abstain" | "gate";
  reason: string;
  /**
   * WHICH lane produced this verdict. Required for honest telemetry: a field can
   * be in the detector registry AND still be decided by the model (every
   * non-affirmable recorded value, and both contradiction-only fields), so
   * keying per-detector rates on registry membership alone credits the detector
   * for the model's work. Omitted = "vision" for backwards compatibility with
   * the image-level pseudo-verdict in main().
   */
  source?: "detector" | "vision";
};
```

`"fail"` stays in the union only for the image-level pseudo-verdict `main()` writes
when an entry has no usable image; `decideFieldVerdict` stops returning it in
Task 14. In `buildRunReport`, make the tally total over the union rather than a
fixed literal so a new label can never silently count as `NaN`:

```ts
const counts: Record<FieldVerdict["verdict"], number> =
  { pass: 0, fail: 0, contradicted: 0, abstain: 0, gate: 0 };
```

Verify before continuing: `npx tsc --noEmit` — Expected: no errors (the widening
alone is additive and breaks no existing caller).

- [ ] **Step 1: Write the failing registry contract test**

```ts
// src/verify/detector-registry.test.ts
import { describe, expect, it } from "vitest";
import { TIER_BY_FIELD, tierForField } from "../scripts/verify-corpus.js";
import { detectorRegistry } from "./detector-registry.js";

describe("detector registry contract", () => {
  const mechanicalFields = Object.entries(TIER_BY_FIELD)
    .filter(([, tier]) => tier === "mechanical")
    .map(([field]) => field);

  it("every mechanical field has a registered certifying detector", () => {
    for (const field of mechanicalFields) {
      const det = detectorRegistry[field];
      expect(det, `no detector for mechanical field ${field}`).toBeDefined();
      if (det && !det.disabled) {
        expect(det.category, `${field} is mechanical but its detector is not certifying`).toBe("certifying");
      }
    }
  });

  it("every certifying detector's field is mechanical (disabled exempt)", () => {
    for (const [field, det] of Object.entries(detectorRegistry)) {
      if (det.disabled) continue;
      if (det.category === "certifying") {
        expect(tierForField(field), `${field} has a certifying detector but is not mechanical`).toBe("mechanical");
      } else {
        expect(tierForField(field), `${field} is contradiction-only but classified mechanical`).not.toBe("mechanical");
      }
      expect(typeof det.canAffirm, `${field} declares canAffirm`).toBe("function");
    }
  });

  it("value-dependence boundary: false shadow/border claims are never affirmable", () => {
    expect(detectorRegistry["visual.usesShadows"].canAffirm(false)).toBe(false);
    expect(detectorRegistry["visual.usesShadows"].canAffirm(true)).toBe(true);
    expect(detectorRegistry["visual.usesBorders"].canAffirm(false)).toBe(false);
    expect(detectorRegistry["visual.cornerStyle"].canAffirm("mixed")).toBe(false);
    expect(detectorRegistry["visual.cornerStyle"].canAffirm("slight-round")).toBe(true);
    expect(detectorRegistry["visual.colorRoles"].canAffirm({})).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detector-registry.test.ts`
Expected: FAIL — cannot resolve `./detector-registry.js` (and `tierForField` is not a map — the test's first line reads it as an object; see Step 4 for the corrected import).

- [ ] **Step 3: Create the two moved detectors**

```ts
// src/verify/detectors/platform.ts
import type { CorpusEntryT } from "../../schema.js";
import { detectPlatform } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import type { DetectorResult } from "../detector-types.js";

export function canAffirm(): boolean {
  return true;
}

/** Recomputed from RECORDED data — provable, no pixels, no image hash. */
export async function detect(entry: CorpusEntryT, _ctx: VerifyCtx): Promise<DetectorResult> {
  const width = entry.image?.width ?? null;
  const height = entry.image?.height ?? null;
  const recorded = entry.platform ?? null;
  if (width === null || height === null || recorded === null) {
    return { verdict: "abstain", measured: null, confidence: 0.5, reason: "image dimensions or recorded platform missing" };
  }
  const recomputed = detectPlatform(width, height);
  return recomputed === recorded
    ? { verdict: "pass", measured: recomputed, confidence: 1, reason: `detectPlatform(${width}, ${height}) matches` }
    : { verdict: "contradicted", measured: recomputed, confidence: 0, reason: `detectPlatform gives ${recomputed}, recorded ${recorded}` };
}
```

```ts
// src/verify/detectors/dominant-colors.ts
import type { CorpusEntryT } from "../../schema.js";
import type { VerifyCtx } from "../ctx.js";
import { extractQuantizedColors } from "../../tagger.js";
import type { DetectorResult } from "../detector-types.js";

export function canAffirm(): boolean {
  return true;
}

/** Recomputed from the PIXELS via Vibrant — image-confirmed, bound to the bytes. */
export async function detect(entry: CorpusEntryT, ctx: VerifyCtx): Promise<DetectorResult> {
  const recordedColors = entry.visual?.dominantColors ?? null;
  if (recordedColors === null || recordedColors.length === 0) {
    return { verdict: "abstain", measured: null, confidence: 0.5, reason: "no recorded dominantColors" };
  }
  const extracted = await extractQuantizedColors(ctx.imagePath);
  const extractedSet = new Set(extracted);
  const missing = recordedColors.filter((c) => !extractedSet.has(c.toLowerCase()));
  return missing.length === 0
    ? { verdict: "pass", measured: extracted, confidence: 1, reason: "recorded colors all present in the extracted set" }
    : { verdict: "contradicted", measured: missing, confidence: 0, reason: `recorded colors absent from extraction: ${missing.join(", ")}` };
}
```

- [ ] **Step 4: Create the registry**

```ts
// src/verify/detector-registry.ts
import type { DetectorEntry } from "./detector-types.js";
import { detect as detectAccessibility } from "./detectors/accessibility-risks.js";
import { canAffirm as affirmAccessibility } from "./detectors/accessibility-risks.js";
import { detect as detectAccent, canAffirm as affirmAccent, confidenceBand as accentBand } from "./detectors/accent-color.js";
import { detect as detectBorders, canAffirm as affirmBorders, confidenceBand as bordersBand } from "./detectors/uses-borders.js";
import { detect as detectColorRoles, canAffirm as affirmColorRoles } from "./detectors/color-roles.js";
import { detect as detectCorner, canAffirm as affirmCorner, confidenceBand as cornerBand } from "./detectors/corner-style.js";
import { detect as detectDominant } from "./detectors/dominant-colors.js";
import { detect as detectPlatform } from "./detectors/platform.js";
import { detect as detectShadows, canAffirm as affirmShadows, confidenceBand as shadowsBand } from "./detectors/uses-shadows.js";
import { detect as detectSpacing, canAffirm as affirmSpacing, confidenceBand as spacingBand } from "./detectors/spacing-density.js";

/** Exact arithmetic detectors never fire the band (confidence is 0 or 1). */
const EXACT_BAND = { low: 0.001, high: 0.999 };

/**
 * The single place a field's deterministic status is declared. The contract
 * test in detector-registry.test.ts pins TIER_BY_FIELD to this table.
 */
export const detectorRegistry: Record<string, DetectorEntry> = {
  platform: { detect: detectPlatform, category: "certifying", accuracyFloor: 1, confidenceBand: EXACT_BAND, canAffirm: () => true },
  "visual.dominantColors": { detect: detectDominant, category: "certifying", accuracyFloor: 1, confidenceBand: EXACT_BAND, canAffirm: () => true },
  "visual.usesBorders": { detect: detectBorders, category: "certifying", accuracyFloor: 0.8, confidenceBand: bordersBand, canAffirm: affirmBorders },
  "visual.usesShadows": { detect: detectShadows, category: "certifying", accuracyFloor: 0.7, confidenceBand: shadowsBand, canAffirm: affirmShadows },
  "visual.accentColor": { detect: detectAccent, category: "certifying", accuracyFloor: 0.9, confidenceBand: accentBand, canAffirm: affirmAccent },
  "visual.cornerStyle": { detect: detectCorner, category: "certifying", accuracyFloor: 0.8, confidenceBand: cornerBand, canAffirm: affirmCorner },
  "visual.spacingDensity": { detect: detectSpacing, category: "certifying", accuracyFloor: 0.8, confidenceBand: spacingBand, canAffirm: affirmSpacing },
  "visual.colorRoles": { detect: detectColorRoles, category: "contradiction-only", accuracyFloor: 0.9, confidenceBand: accentBand, canAffirm: affirmColorRoles },
  "antiPatterns.accessibilityRisks": { detect: detectAccessibility, category: "contradiction-only", accuracyFloor: 0.9, confidenceBand: accentBand, canAffirm: affirmAccessibility },
};
```

In `verify-corpus.ts`, rename the `const TIER_BY_FIELD` declaration to `export const TIER_BY_FIELD` so the test derives the mechanical set from the single source of truth. The Step 1 test already imports it — there is no static list to drift. `tierForField` remains the lookup function.

- [ ] **Step 5: Write the failing runner integration test**

```ts
// src/verify/runner.test.ts
import { describe, expect, it } from "vitest";
import { fixtureImagePath } from "./__fixtures__/fixtures.js";
import { verifyEntry } from "../scripts/verify-corpus.js";
import type { CorpusEntryT } from "../schema.js";

function entry(overrides: Partial<CorpusEntryT> = {}): CorpusEntryT {
  return {
    id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: ["minimal"], components: ["sidebar-nav"],
    layout: { form: "single-column", regions: [{ role: "sidebar" }] },
    visual: {
      dominantColors: ["#f5f5f5", "#2563eb"], accentColor: "#2563eb",
      colorRoles: { canvas: "#f5f5f5", surface: "#ffffff", ink: "#111111", muted: null, accent: "#2563eb" },
      typePairing: { display: "Geist", body: "Geist" },
      spacingDensity: "moderate", cornerStyle: "slight-round",
      usesShadows: true, usesBorders: true,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "A", whatToSteal: ["B"], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
    ...overrides,
  } as CorpusEntryT;
}

function deps(prompts: string[]) {
  return {
    now: () => "2026-08-07",
    callVision: async (prompt: string) => { prompts.push(prompt); return "{}"; },
    reproduce: async (e: CorpusEntryT) => e,
  };
}

describe("verifyEntry with the detector registry", () => {
  it("keeps affirmable mechanical fields out of the vision pending list", async () => {
    const prompts: string[] = [];
    const image = fixtureImagePath("roles-card");
    await verifyEntry(entry(), image, deps(prompts));
    const prompt = prompts[0] ?? "";
    expect(prompt).not.toContain("visual.usesShadows");
    expect(prompt).not.toContain("visual.usesBorders");
    expect(prompt).not.toContain("visual.cornerStyle");
  });

  it("keeps a non-affirmable recorded false claim in the pending list", async () => {
    const prompts: string[] = [];
    const image = fixtureImagePath("borders-flat-true");
    const e = entry({ visual: { ...entry().visual!, usesShadows: false, usesBorders: false } });
    await verifyEntry(e, image, deps(prompts));
    expect(prompts[0] ?? "").toContain("visual.usesShadows");
    expect(prompts[0] ?? "").toContain("visual.usesBorders");
  });

  it("excludes a contradicted field from the vision call", async () => {
    const prompts: string[] = [];
    const image = fixtureImagePath("borders-stroke-true");
    const e = entry({ visual: { ...entry().visual!, usesBorders: false } });
    await verifyEntry(e, image, deps(prompts));
    expect(prompts[0] ?? "").not.toContain("visual.usesBorders");
  });

  it("--detectors off restores the legacy pending list (byte-identical to today)", async () => {
    const prompts: string[] = [];
    const image = fixtureImagePath("roles-card");
    await verifyEntry(entry(), image, { ...deps(prompts), detectors: false });
    const prompt = prompts[0] ?? "";
    expect(prompt).toContain("visual.usesShadows");
    expect(prompt).toContain("visual.usesBorders");
    expect(prompt).toContain("visual.cornerStyle");
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/runner.test.ts`
Expected: FAIL — `verifyEntry` does not consult the registry yet; mechanical fields are not reclassified; the `detectors` dep does not exist.

- [ ] **Step 7: Implement the runner**

```ts
// src/verify/runner.ts
import type { CorpusEntryT } from "../schema.js";
import type { VerifyCtx } from "./ctx.js";
import {
  inBand,
  recordedFor,
  type DetectorEntry,
  type DetectorResult,
  type DetectorVerdict,
} from "./detector-types.js";
import { detectorRegistry } from "./detector-registry.js";

export interface RunDetectorsOutcome {
  passes: string[];
  contradicted: string[];
  abstained: string[];
}

/**
 * The runner-enforced caps. The band wins; a contradiction-only `pass` is a
 * downgrade; a certifying `pass` on a non-affirmable value is a downgrade.
 */
export function capVerdict(det: DetectorEntry, result: DetectorResult, recorded: unknown): DetectorVerdict {
  if (inBand(det.confidenceBand, result.confidence)) return "abstain";
  if (result.verdict !== "pass") return result.verdict;
  if (det.category === "contradiction-only") return "abstain";
  if (!det.canAffirm(recorded)) return "abstain";
  return "pass";
}

/**
 * Runs every registered detector. `detectors: false` runs ONLY the two
 * pre-existing deterministic fields (platform, dominantColors) — everything
 * else returns to the vision pending list, byte-identical to today.
 */
export async function runDetectors(
  entry: CorpusEntryT,
  ctx: VerifyCtx,
  opts: { detectors?: boolean } = {},
): Promise<RunDetectorsOutcome> {
  const detectors = opts.detectors ?? true;
  const outcome: RunDetectorsOutcome = { passes: [], contradicted: [], abstained: [] };
  for (const [field, det] of Object.entries(detectorRegistry)) {
    if (det.disabled) continue;
    if (!detectors && field !== "platform" && field !== "visual.dominantColors") continue;
    const recorded = recordedFor(entry, field);
    let result: DetectorResult;
    try {
      result = await det.detect(entry, ctx);
    } catch (err) {
      outcome.abstained.push(field);
      continue;
    }
    const verdict = capVerdict(det, result, recorded);
    if (verdict === "pass") outcome.passes.push(field);
    else if (verdict === "contradicted") outcome.contradicted.push(field);
    else outcome.abstained.push(field);
  }
  return outcome;
}
```

- [ ] **Step 8: Wire it into `verify-corpus.ts`**

Reclassify the five fields in `TIER_BY_FIELD` (lines 38–61): change `visual.usesShadows`, `visual.usesBorders`, `visual.accentColor` from `"factual"` to `"mechanical"`, and `visual.spacingDensity`, `visual.cornerStyle` from `"soft"` to `"mechanical"`. Add the value-aware filter and replace `verifyMechanicalFields` in `verifyEntry`:

```ts
// in verify-corpus.ts — new helper next to tierForField:
import { detectorRegistry } from "../verify/detector-registry.js";
import { createVerifyCtx, type VerifyCtx } from "../verify/ctx.js";
import { runDetectors, type RunDetectorsOutcome } from "../verify/runner.js";
import { recordedFor } from "../verify/detector-types.js";

/**
 * Value-aware pending filter. A mechanical field leaves the vision path only
 * when its recorded value is AFFIRMABLE by its certifying detector; a
 * recorded-false shadow/border claim or cornerStyle:mixed stays in vision.
 * With `detectors: false`, only platform + dominantColors stay mechanical.
 */
export function fieldLeavesVisionForEntry(
  entry: CorpusEntryT,
  field: string,
  detectorsEnabled: boolean,
): boolean {
  if (tierForField(field) !== "mechanical") return false;
  const det = detectorRegistry[field];
  if (!det || det.disabled) return false;
  if (!detectorsEnabled && field !== "platform" && field !== "visual.dominantColors") return false;
  return det.canAffirm(recordedFor(entry, field));
}
```

Then in `verifyEntry`, replace the mechanical block and the pending filter:

```ts
// replaces "// 1. Mechanical checks" and the pending construction in verifyEntry:
const detectorsEnabled = deps.detectors ?? true;
let outcome: RunDetectorsOutcome;
let pending: string[];
try {
  const ctx = await createVerifyCtx(imagePath);
  outcome = await runDetectors(entry, ctx, { detectors: detectorsEnabled });
  for (const field of outcome.passes) {
    records[field] = field === "platform" ? provableRecord(now) : confirmedRecord(imagePath, now);
  }
  // Compute `pending` BEFORE emitting verdicts — the pending set decides which
  // detector verdicts are allowed to exist.
  pending = Object.keys(TIER_BY_FIELD).filter(
    (field) =>
      !fieldLeavesVisionForEntry(entry, field, detectorsEnabled)
      && tierForField(field) !== "gated"
      && !outcome.contradicted.includes(field)
      && !alreadyProcessedAtVersion(entry, field, VERIFIER_VERSION),
  );

  for (const field of outcome.passes) verdicts.push({ field, verdict: "pass", reason: "detector", source: "detector" });
  for (const field of outcome.contradicted) verdicts.push({ field, verdict: "contradicted", reason: "detector contradiction", source: "detector" });
  // EXACTLY ONE VERDICT PER FIELD PER RUN. A detector abstain is only the
  // field's verdict when nothing else will produce one; a field still in
  // `pending` gets its verdict from the model, so the detector stays SILENT.
  //
  // Emitting it unconditionally is a corpus-darkening bug: non-affirmable values
  // (usesShadows:false, usesBorders:false, cornerStyle:mixed) and both
  // contradiction-only fields abstain AND stay in `pending`, so `verdicts` would
  // hold two rows for one field — detector `abstain` plus model `pass`.
  // `resumeMarkers` skips the pass but still marks the abstain, and
  // `mergeVerifyAttempts` revokes `verification` for that field, destroying the
  // pass the model just earned. That darkens precisely what `canAffirm` exists
  // to protect: 418 `usesShadows:false`, 276 `usesBorders:false`, 139
  // `cornerStyle:mixed` claims, plus every colorRoles/accessibilityRisks pass.
  const pendingSet = new Set(pending);
  for (const field of outcome.abstained) {
    if (pendingSet.has(field)) continue; // the model will judge it
    verdicts.push({ field, verdict: "abstain", reason: "detector abstained", source: "detector" });
  }
} catch (err) {
  // Spec error table: a corrupt/unreadable image abstains per field. platform
  // still runs against the RECORDED dims (no pixels needed); every other
  // detector abstains with the file error named; nothing reaches the vision
  // call (it would fail on the same bytes).
  const message = err instanceof Error ? err.message : String(err);
  const stub: VerifyCtx = { imagePath, width: entry.image?.width ?? 0, height: entry.image?.height ?? 0 };
  const partial = await runDetectors(entry, stub, { detectors: false });
  // Use the SAME record-method rule as the happy path. Writing `provableRecord`
  // for every pass is wrong for image-derived fields: `visual.dominantColors` is
  // a PIXEL claim, and a `provable` record carries no `imageSha256`, so it would
  // be permanently exempt from doctor's hash-staleness checks — a pixel
  // measurement that never dies with its pixels. Only `platform` is genuinely
  // provable (recomputed from recorded dimensions, no image read).
  for (const field of partial.passes) {
    records[field] = field === "platform" ? provableRecord(now) : confirmedRecord(imagePath, now);
  }
  for (const field of Object.keys(detectorRegistry)) {
    const v = partial.passes.includes(field) ? "pass"
      : partial.contradicted.includes(field) ? "contradicted" : "abstain";
    verdicts.push({ field, verdict: v, reason: v === "abstain" ? `image unreadable: ${message}` : "detector", source: "detector" });
  }
  // Every OTHER servable field must also be marked, or the entry never converges:
  // `pending = []` means the vision call is skipped, so without this loop
  // `layout`, `components`, `critique`, `mood` … end the run in no map at all and
  // `selectPending` requeues the entry forever.
  for (const field of Object.keys(TIER_BY_FIELD)) {
    if (tierForField(field) === "gated") continue;
    if (field in detectorRegistry) continue;
    verdicts.push({ field, verdict: "abstain", reason: `image unreadable: ${message}` });
  }
  pending = [];
}
```

Add `detectors?: boolean` to `VerifyEntryDeps`, delete `verifyMechanicalFields` (its logic now lives in `detectors/platform.ts` + `detectors/dominant-colors.ts`), and delete the old `verifyMechanicalFields` tests from `verify-corpus.test.ts`. In `main()`, add the CLI flag:

```ts
// in main()'s parseArgs options:
"detectors": { type: "string" },
// ...
const detectorsEnabled = values.detectors !== "off";
// pass to every verifyEntry deps object:
const deps = { now: () => new Date().toISOString().slice(0, 10), callVision, reproduce, detectors: detectorsEnabled };
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/runner.test.ts src/verify/detector-registry.test.ts`
Expected: PASS. Then the existing suite:

Run: `C2_NO_DOTENV=1 npx vitest run src/scripts/verify-corpus.test.ts`
Expected: PASS after the old mechanical tests are removed.

- [ ] **Step 10: Commit**

```bash
git add src/verify/ src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts
git commit -m "feat(verify): detector registry, value-aware runner, verifyEntry integration"
```

---

### Task 13: Calibration — held-out gate + real-screenshot CLI

**Files:**
- Create: `src/verify/calibration.ts`
- Create: `src/verify/calibration.test.ts`
- Create: `src/verify/calibration-cli.ts`
- Modify: `package.json` (`calibrate-detectors` script)

**Interfaces:**
- Consumes: `detectorRegistry`, `capVerdict`, `recordedFor`, fixture manifest, `createVerifyCtx`.
- Produces:
  - `interface CalibrationRow { field: string; id: string; label: string; verdict: string; correct: boolean }`
  - `interface CalibrationResult { accuracy: number; decisiveRate: number; rows: CalibrationRow[]; byField: Record<string, { accuracy: number; decisiveRate: number; total: number; correct: number; decisive: number }> }`
  - `calibrate(manifest: FixtureManifest, split: "tune" | "held-out", deps?: { imagePathFor?: (fixture: FixtureEntry) => string }): Promise<CalibrationResult>` — the default resolver points at the COMMITTED fixtures; the real-set CLI passes `(f) => f.file` so real screenshot paths are never mangled through the fixture directory.
  - `assertGate(result: CalibrationResult, registry: typeof detectorRegistry): string[]` — returns the fields failing `accuracy >= floor` OR `decisiveRate >= 0.4`.

**Gate honesty:** exact-match accuracy alone can be gamed by abstaining everything, so the gate also requires `decisiveRate >= 0.4` (the detector must actually decide on at least 40% of held-out fixtures). The tune set is never CI-gated.

- [ ] **Step 1: Write the failing gate test**

```ts
// src/verify/calibration.test.ts
import { describe, expect, it } from "vitest";
import { fixtureManifest } from "./__fixtures__/fixtures.js";
import { calibrate, assertGate } from "./calibration.js";
import { detectorRegistry } from "./detector-registry.js";

describe("calibration gate", () => {
  it("measures held-out accuracy and asserts every enabled certifying detector clears its floor", async () => {
    const manifest = fixtureManifest();
    const result = await calibrate(manifest, "held-out");
    const failing = assertGate(result, detectorRegistry);
    expect(failing).toEqual([]);
  });

  it("never gates on the tune set", async () => {
    const manifest = fixtureManifest();
    const tune = await calibrate(manifest, "tune");
    expect(tune.accuracy).toBeGreaterThanOrEqual(0);
    expect(tune.rows.length).toBeGreaterThan(0);
  });
});

describe("held-out integrity — the anti-circularity guards", () => {
  // These four tests are the ONLY thing standing between this gate and the
  // circularity the first draft of this plan shipped: held-out fixtures that
  // were run during tuning and then edited until the detectors passed.

  it("held-out manifest matches the lock, so the set cannot move quietly", () => {
    const locked = heldOutLock();
    expect(
      heldOutHash(fixtureManifest()),
      "HELD-OUT SET CHANGED. Do not update the lock to make this pass. Either revert "
      + "the fixture change, or (if the set genuinely needed to grow) re-run "
      + "`npm run calibrate-detectors` on real screenshots, re-declare every floor "
      + "from those numbers, and update held-out-lock.json in the SAME commit so a "
      + "reviewer sees both moved together.",
    ).toBe(locked.manifestHash);
  });

  it("the locked floors match the registry's declared floors", () => {
    const locked = heldOutLock();
    for (const [field, entry] of Object.entries(detectorRegistry)) {
      if (entry.category !== "certifying" || entry.disabled) continue;
      expect(entry.accuracyFloor, `floor for ${field} drifted from the lock`)
        .toBe(locked.floors[field]);
    }
  });

  it("every enabled certifying detector has an adequate held-out set", () => {
    const heldOut = fixtureManifest().fixtures.filter((f) => f.split === "held-out");
    for (const [field, entry] of Object.entries(detectorRegistry)) {
      if (entry.category !== "certifying" || entry.disabled) continue;
      const forField = heldOut.filter((f) => f.field === field);
      const labels = forField.map((f) => f.label);
      // An all-`pass` held-out set cannot distinguish a working detector from one
      // that returns `pass` unconditionally.
      expect(forField.length, `${field}: needs >=4 held-out fixtures, has ${forField.length}`)
        .toBeGreaterThanOrEqual(4);
      expect(labels, `${field}: held-out has no positive case`).toContain("pass");
      expect(labels, `${field}: held-out has no negative case — an all-positive set certifies nothing`)
        .toContain("contradicted");
    }
  });

  it("tune and held-out never share an image file", () => {
    const m = fixtureManifest().fixtures;
    const tuneFiles = new Set(m.filter((f) => f.split === "tune" && f.file).map((f) => f.file));
    const shared = m
      .filter((f) => f.split === "held-out" && f.file && tuneFiles.has(f.file))
      .map((f) => f.id);
    expect(shared, "a fixture image reused across splits is not held out").toEqual([]);
  });
});
```

`heldOutHash` / `heldOutLock` live in `calibration.ts`:

```ts
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface HeldOutLock {
  manifestHash: string;
  floors: Record<string, number>;
  /** The real-screenshot calibration run these floors were declared from. */
  declaredFrom: { runId: string; recordedAt: string; report: string };
}

/** Stable hash of the held-out subset: id, field, recorded, label, file, dims. */
export function heldOutHash(manifest: FixtureManifest): string {
  const canonical = manifest.fixtures
    .filter((f) => f.split === "held-out")
    .map((f) => ({ id: f.id, field: f.field, recorded: f.recorded, label: f.label, file: f.file, dims: f.dims ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function heldOutLock(): HeldOutLock {
  return JSON.parse(readFileSync(new URL("./__fixtures__/held-out-lock.json", import.meta.url), "utf8"));
}
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/calibration.test.ts`
Expected: FAIL — cannot resolve `./calibration.js`.

- [ ] **Step 3: Implement**

```ts
// src/verify/calibration.ts
import type { CorpusEntryT } from "../schema.js";
import { createVerifyCtx } from "./ctx.js";
import { recordedFor } from "./detector-types.js";
import { capVerdict } from "./runner.js";
import { detectorRegistry } from "./detector-registry.js";
import type { FixtureEntry, FixtureManifest } from "./__fixtures__/generate-detector-fixtures.js";

export interface CalibrationRow {
  field: string;
  id: string;
  label: string;
  verdict: string;
  correct: boolean;
}

export interface CalibrationResult {
  accuracy: number;
  decisiveRate: number;
  rows: CalibrationRow[];
  byField: Record<string, { accuracy: number; decisiveRate: number; total: number; correct: number; decisive: number }>;
}

/** Builds a minimal entry carrying the fixture's recorded value. */
// `file` is in the param type because the body reads `fixture.file` for the
// image path — an earlier draft omitted it and would not compile.
function entryForFixture(fixture: { field: string; recorded: unknown; file: string; dims?: { width: number; height: number } }, base: CorpusEntryT): CorpusEntryT {
  const field = fixture.field;
  const e: CorpusEntryT = { ...base };
  if (field === "visual.usesShadows") e.visual = { ...e.visual!, usesShadows: fixture.recorded as boolean };
  if (field === "visual.usesBorders") e.visual = { ...e.visual!, usesBorders: fixture.recorded as boolean };
  if (field === "visual.accentColor") e.visual = { ...e.visual!, accentColor: fixture.recorded as string | null };
  if (field === "visual.dominantColors") e.visual = { ...e.visual!, dominantColors: fixture.recorded as string[] };
  if (field === "visual.cornerStyle") e.visual = { ...e.visual!, cornerStyle: fixture.recorded as CorpusEntryT["visual"]["cornerStyle"] };
  if (field === "visual.spacingDensity") e.visual = { ...e.visual!, spacingDensity: fixture.recorded as CorpusEntryT["visual"]["spacingDensity"] };
  if (field === "visual.colorRoles") e.visual = { ...e.visual!, colorRoles: fixture.recorded as CorpusEntryT["visual"]["colorRoles"] };
  if (field === "platform") e.platform = fixture.recorded as string;
  if (fixture.dims) e.image = { path: fixture.file, width: fixture.dims.width, height: fixture.dims.height, format: "png" };
  return e;
}

export async function calibrate(
  manifest: FixtureManifest,
  split: "tune" | "held-out",
  deps: { imagePathFor?: (fixture: FixtureEntry) => string } = {},
): Promise<CalibrationResult> {
  const rows: CalibrationRow[] = [];
  const base: CorpusEntryT = {
    id: "fixture", title: "fixture", patternType: "dashboard", colorScheme: "light",
    categories: ["dashboard"], styleTags: [], components: [],
    layout: { form: "single-column", regions: [] },
    visual: {
      dominantColors: [], accentColor: null,
      typePairing: { display: null, body: null },
      spacingDensity: "moderate", cornerStyle: "sharp",
      usesShadows: false, usesBorders: false,
    },
    antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
    critique: "", whatToSteal: [], voice: null, mood: null,
    platform: "web", qualityScore: 1, qualityTier: "exceptional",
  };
  const { join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const DIR = fileURLToPath(new URL("./__fixtures__/", import.meta.url));
  const imagePathFor = deps.imagePathFor ?? ((f: FixtureEntry) => join(DIR, "images", f.file));
  for (const fixture of manifest.fixtures) {
    if (fixture.split !== split) continue;
    const det = detectorRegistry[fixture.field];
    if (!det || det.disabled) continue;
    const entry = entryForFixture(fixture, base);
    // Entry-only fixtures (platform) carry no image: detect() ignores the ctx,
    // so a stub built from the recorded dims is enough.
    const ctx = fixture.file === ""
      ? { imagePath: "", width: fixture.dims?.width ?? 0, height: fixture.dims?.height ?? 0 }
      : await createVerifyCtx(imagePathFor(fixture));
    const result = await det.detect(entry, ctx);
    const verdict = capVerdict(det, result, recordedFor(entry, fixture.field));
    rows.push({ field: fixture.field, id: fixture.id, label: fixture.label, verdict, correct: verdict === fixture.label });
  }
  const correct = rows.filter((r) => r.correct).length;
  const decisive = rows.filter((r) => r.verdict !== "abstain").length;
  const byField: CalibrationResult["byField"] = {};
  for (const row of rows) {
    const f = byField[row.field] ?? { accuracy: 0, decisiveRate: 0, total: 0, correct: 0, decisive: 0 };
    f.total++; if (row.correct) f.correct++; if (row.verdict !== "abstain") f.decisive++;
    f.accuracy = f.correct / f.total;
    f.decisiveRate = f.decisive / f.total;
    byField[row.field] = f;
  }
  return {
    accuracy: correct / Math.max(rows.length, 1),
    decisiveRate: decisive / Math.max(rows.length, 1),
    rows,
    byField,
  };
}

export function assertGate(
  result: CalibrationResult,
  registry: typeof detectorRegistry,
): string[] {
  const failing: string[] = [];
  for (const [field, det] of Object.entries(registry)) {
    if (det.disabled || det.category !== "certifying") continue;
    const f = result.byField[field];
    if (!f) continue; // no held-out fixtures for this field — not gated
    if (f.accuracy < det.accuracyFloor || f.decisiveRate < 0.4) {
      failing.push(`${field}: accuracy ${f.accuracy.toFixed(2)} / floor ${det.accuracyFloor}, decisive ${f.decisiveRate.toFixed(2)} / 0.4`);
    }
  }
  return failing;
}
```

- [ ] **Step 4: Create the real-screenshot CLI and npm script**

```ts
// src/verify/calibration-cli.ts
import { readFileSync } from "node:fs";
import { calibrate } from "./calibration.js";

// Real-set labels use the SPEC'S ONE labelling contract (spec: "Frozen labelled
// ground-truth set"), not a second bespoke format. The spec defines that format
// precisely so detector calibration and the frozen verdict set cannot invent two:
//
//   { "entryId", "imageSha256", "field", "claim", "label", "notes",
//     "labelledAt", "labelledBy", "recorded", "imagePath", "supersedes"? }
//
//   - `label` is `confirmed | contradicted | abstain` — `confirmed`, NOT `pass`,
//     because the label describes the CLAIM's status, not a detector's verdict.
//     It maps to the detector verdict `pass` below.
//   - `imageSha256` pins the bytes, so a re-capture invalidates the label instead
//     of silently re-grounding it against different pixels.
//   - Labels are append-only: a correction adds a record with `supersedes`, and
//     the newest record per (entryId, field) wins. A label that moves mid-
//     comparison makes the comparison meaningless.
//
// The file is `eval/verdicts/labels.jsonl` — the same directory as the frozen
// verdict set (Task 1), gitignored for the image paths it references but with the
// labels themselves committed.
interface LabelRecord {
  entryId: string;
  imagePath: string;
  imageSha256: string;
  field: string;
  recorded: unknown;
  label: "confirmed" | "contradicted" | "abstain";
  labelledAt: string;
  labelledBy: string;
  supersedes?: string;
}

const labelsPath = process.argv[2] ?? "eval/verdicts/labels.jsonl";
const lines = readFileSync(labelsPath, "utf8").trim().split("\n").filter(Boolean);
const all = lines.map((line) => JSON.parse(line) as LabelRecord);

// Append-only resolution: last record per (entryId, field) wins.
const latest = new Map<string, LabelRecord>();
for (const l of all) latest.set(`${l.entryId}|${l.field}`, l);

// Refuse to calibrate against a label whose image has changed underneath it —
// otherwise the "real" numbers are measured on pixels nobody labelled.
const stale: string[] = [];
for (const l of latest.values()) {
  const actual = createHash("sha256").update(readFileSync(l.imagePath)).digest("hex");
  if (actual !== l.imageSha256) stale.push(`${l.entryId}|${l.field}`);
}
if (stale.length > 0) {
  console.error(`REFUSING: ${stale.length} label(s) reference images that have changed since labelling:`);
  for (const s of stale) console.error(`  ${s}`);
  console.error("Re-label those claims (append a record with `supersedes`) before calibrating.");
  process.exit(1);
}

const manifest = {
  version: 1 as const,
  fixtures: [...latest.values()].map((l) => ({
    id: `${l.entryId}|${l.field}`,
    file: l.imagePath,
    field: l.field,
    recorded: l.recorded,
    // `confirmed` (claim status) -> `pass` (detector verdict).
    label: l.label === "confirmed" ? ("pass" as const) : l.label,
    split: "held-out" as const,
  })),
};

// Real labels carry their own absolute/relative paths — resolve them AS-IS,
// never through the committed fixture directory.
const result = await calibrate(manifest, "held-out", { imagePathFor: (f) => f.file });
console.log(`Accuracy: ${(result.accuracy * 100).toFixed(1)}%  Decisive: ${(result.decisiveRate * 100).toFixed(1)}%`);
for (const [field, f] of Object.entries(result.byField)) {
  console.log(`${field}: accuracy ${(f.accuracy * 100).toFixed(1)}%, decisive ${(f.decisiveRate * 100).toFixed(1)}%`);
}
```

In `package.json` scripts:

```json
"calibrate-detectors": "tsc && node dist/verify/calibration-cli.js"
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/calibration.test.ts`
Expected: PASS. If a detector fails its held-out floor, do NOT loosen the floor to make the test green. Either improve the detector's threshold against TUNE fixtures, or mark it `disabled: true` in the registry (which reverts its field to the vision tier — see Task 12's `fieldLeavesVisionForEntry`) and record the decision in the plan's rollout notes. A floor that is lowered to match a failing detector certifies nothing.

The held-out integrity tests will FAIL on first run — `held-out-lock.json` does not
exist yet. It is written in Task 13B, from real numbers. Until then the floors in
the registry are placeholders and no detector may write a trust record.

- [ ] **Step 6: Commit**

```bash
git add src/verify/calibration.ts src/verify/calibration.test.ts src/verify/calibration-cli.ts package.json
git commit -m "feat(verify): held-out calibration gate + calibrate-detectors CLI"
```

---

### Task 13B: Declare floors from REAL screenshots and lock the held-out set

**This task is the difference between "deterministic" and "trusted".** Until it
completes, the `accuracyFloor` values in the registry are placeholders invented
while writing the plan, measured on ~40 synthetic images that the detectors were
developed against. The spec's added invariant — *a detector may write a trust
record only for a field it has been measured on, against data it was not tuned
against* — is not satisfied by synthetic fixtures alone. 787 real entries are
about to be judged; the floors must come from real pixels.

**Files:**
- Create: `eval/verdicts/labels.jsonl` (gitignored images, committed labels — Task 1's carve-out already allows this path)
- Create: `src/verify/__fixtures__/held-out-lock.json`
- Create: `docs/verifier-calibration.md` (the committed record of the real numbers)
- Modify: `src/verify/detector-registry.ts` (floors + `disabled` set from the measurement)

**Interfaces:**
- Consumes: `npm run calibrate-detectors`, `heldOutHash` (Task 13).
- Produces: real per-field accuracy/decisive numbers, final floors, `disabled` flags, and the lock that pins them together.

- [ ] **Step 1: Label real screenshots**

For each of the seven certifying/contradiction-only fields, label **at least 10**
real corpus screenshots in `eval/verdicts/labels.jsonl`, using the spec's contract
(`entryId`, `imagePath`, `imageSha256`, `field`, `recorded`, `label`,
`labelledAt`, `labelledBy`). Stratify deliberately — include the populations the
synthetic set cannot represent:

- entries whose screenshots contain **photographic content or gradients** (the
  known false-positive risk for `usesShadows`)
- the recorded-`false` populations (418 `usesShadows`, 276 `usesBorders`) and
  `cornerStyle: mixed` (139) — these route to vision, but a detector that
  *contradicts* them wrongly still writes a `dataQuality` finding
- at least 2 `contradicted` labels per field, or the real measurement has the same
  all-positive blind spot the synthetic set had

`label` is `confirmed | contradicted | abstain` — the claim's status, not a
verdict. Labelling is the human's judgement against the image; the detector's
output must not be consulted while labelling, or this measurement is circular too.

- [ ] **Step 2: Measure**

```bash
npm run calibrate-detectors
```

The CLI refuses to run if any label's `imageSha256` no longer matches its file.
Record the full per-field table (accuracy, decisive rate, n) in
`docs/verifier-calibration.md`, together with the date, the labeller, and the
label-file line count. This file is the evidence for every floor below.

- [ ] **Step 3: Set floors and disable what cannot clear them**

For each certifying detector, set `accuracyFloor` in the registry to the value
justified by the REAL number — not the synthetic one:

- real accuracy ≥ 0.9 and decisive ≥ 0.5 → floor `0.85`, enabled
- real accuracy ≥ 0.8 → floor `0.75`, enabled
- anything lower, or decisive < 0.4 → **`disabled: true`**

A disabled detector's field reverts to the vision path
(`fieldLeavesVisionForEntry`), which is the honest outcome: the corpus keeps the
model's verdict for that field and loses nothing it has today. Do NOT set a floor
below the real measurement to keep a detector enabled — that is the failure this
task exists to prevent.

Expect `visual.spacingDensity` and possibly `visual.usesShadows` to disable here.
That is a success for the gate, not a failure of the plan.

- [ ] **Step 4: Write the lock**

```json
{
  "manifestHash": "<output of heldOutHash(fixtureManifest())>",
  "floors": { "visual.usesBorders": 0.85, "…": 0.0 },
  "declaredFrom": {
    "runId": "real-calibration-<date>",
    "recordedAt": "<ISO date>",
    "report": "docs/verifier-calibration.md"
  }
}
```

`floors` must list every enabled certifying detector and match the registry
exactly — the integrity test asserts both directions.

- [ ] **Step 5: Verify the gate now passes honestly**

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/calibration.test.ts`
Expected: PASS — held-out integrity, floor/lock agreement, adequacy (≥4 fixtures
with ≥1 pass and ≥1 contradicted per enabled detector), and split disjointness.

Run: `C2_NO_DOTENV=1 npx vitest run src/verify/detector-registry.test.ts`
Expected: PASS — a detector disabled in Step 3 must have its field back on the
vision path, which the contract test asserts.

- [ ] **Step 6: Commit**

```bash
git add eval/verdicts/labels.jsonl src/verify/__fixtures__/held-out-lock.json \
  docs/verifier-calibration.md src/verify/detector-registry.ts
git commit -m "feat(verify): declare detector floors from real-screenshot calibration; lock the held-out set"
```

---

### Task 14: Three-way model verdicts + corroborated contradictions

**Files:**
- Modify: `src/scripts/verify-corpus.ts` (`buildVerifyPrompt`, `parseVerifyResponse`, `decideFieldVerdict`, `FieldVerdict`, `verifyEntry` — the model path)
- Test: `src/scripts/verify-corpus.test.ts` (extend)

**Interfaces:**
- Produces (consumed by Tasks 15–17):
  - `FieldVerdict["verdict"]` was ALREADY widened to `"pass" | "fail" | "contradicted" | "abstain" | "gate"` in Task 12 Step 0 (it has to be — Task 12 emits the new labels). This task is where `decideFieldVerdict` stops returning `"fail"`; the union itself is untouched here.
  - `parseVerifyResponse` now returns `{ confirmed: boolean; contradicted: boolean; assertions?: string[]; reason?: string }` per field.
  - `interface DataQualityRecord { measured: unknown; recorded: unknown; source: string; verifierVersion: string; verifiedAt: string; reason?: string }` (formalized into `provenance.dataQuality` + `mergeDataQuality` in Task 15)
  - `verifyEntry` return type grows to `{ records, verdicts, dataQuality }` — `dataQuality` is ACCUMULATED here (detector contradictions from Task 12 + corroborated model contradictions) and persisted in Task 15.

**The prompt becomes three-way.** The model answers `confirmed` only when the claim is visibly true, `contradicted` only when the image POSITIVELY disagrees, `abstain` for uncertainty. A model `contradicted` is corroborated by a SECOND fresh-context ask for that field alone before it may write `dataQuality` — the detector band's equivalent guard, since model verdicts flip 14–18% between identical runs. The second ask uses the SAME positive-affirmation prompt (never "do you still disagree", which anchors).

- [ ] **Step 1: Write the failing tests**

```ts
// additions to src/scripts/verify-corpus.test.ts
import { buildVerifyPrompt, decideFieldVerdict, parseVerifyResponse, verifyEntry } from "./verify-corpus.js";

describe("three-way model verdicts", () => {
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

  it("corroborates a model contradicted: second ask confirming writes verification, not dataQuality", async () => {
    const image = new URL("../verify/__fixtures__/images/roles-card.png", import.meta.url).pathname;
    const calls: string[] = [];
    const { verifyEntry } = await import("./verify-corpus.js");
    const e = makeEntry(); // reuse the runner.test.ts entry() helper shape
    const out = await verifyEntry(e, image, {
      now: () => "2026-08-07",
      callVision: async (prompt) => {
        calls.push(prompt);
        return calls.length === 1
          ? '{"layout":{"verdict":"contradicted"}}'
          : '{"layout":{"verdict":"confirmed"}}';
      },
      reproduce: async (x) => x,
    });
    // Assert the CORROBORATION, not the total call count. `makeEntry()` carries a
    // non-null `critique`, so the prose re-produce/re-verify lane fires too and the
    // real total is 3 — an earlier draft asserted 2 and could never pass. Counting
    // the layout asks is what this test is actually about, and it stays correct
    // however many calls the prose lane makes.
    const layoutAsks = calls.filter((p) => p.includes("layout")).length;
    expect(layoutAsks, "initial ask + one corroborating re-ask").toBe(2);
    expect(out.records.layout).toBeDefined();
    expect(out.dataQuality.layout).toBeUndefined();
  });

  it("writes dataQuality only for a corroborated contradiction", async () => {
    const image = new URL("../verify/__fixtures__/images/roles-card.png", import.meta.url).pathname;
    const calls: string[] = [];
    const e = makeEntry();
    const out = await verifyEntry(e, image, {
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
    expect(out.records.layout).toBeUndefined();
  });
});
```

(The `makeEntry()` helper is the `entry()` builder already used in `runner.test.ts` — copy it into `verify-corpus.test.ts` for these tests; both files may share a small local copy.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `C2_NO_DOTENV=1 npx vitest run src/scripts/verify-corpus.test.ts`
Expected: FAIL — no `verdict` parsing, `contradicted` not in the verdict union, `verifyEntry` has no `dataQuality` return.

- [ ] **Step 3: Update the prompt, parser, and decider**

```ts
// in buildVerifyPrompt — replace the return-JSON contract:
//   "<field>": { "verdict": "confirmed" | "contradicted" | "abstain",
//                "assertions": ["..."], "reason": "..." }
// and per-field instructions become:
//   "...: confirm this claim is VISIBLY TRUE in the screenshot. Return
//   \"confirmed\" only when you can positively see it; \"contradicted\" only
//   when the image POSITIVELY disagrees with the claim; otherwise \"abstain\"."

// parseVerifyResponse — widen the per-field shape and read `verdict`:
export type ParsedField = { confirmed: boolean; contradicted: boolean; assertions?: string[]; reason?: string };

// inside the field loop:
const verdict = typeof (value as Record<string, unknown>).verdict === "string"
  ? (value as Record<string, unknown>).verdict as string
  : (value as Record<string, unknown>).confirmed === true ? "confirmed" : undefined;
out[field] = {
  confirmed: verdict === "confirmed",
  contradicted: verdict === "contradicted",
  ...(assertions !== undefined ? { assertions } : {}),
  ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
};

// failClosed default becomes { confirmed: false, contradicted: false }.

// decideFieldVerdict — replace the tail:
export function decideFieldVerdict(
  field: string,
  tier: VerifierTier,
  parsed: { confirmed: boolean; contradicted: boolean; assertions?: string[] },
): FieldVerdict {
  if (tier === "gated") {
    return { field, verdict: "gate", reason: "no single screenshot can confirm this claim" };
  }
  if (tier === "prose") {
    const assertions = parsed.assertions ?? [];
    if (assertions.length === 0) {
      return { field, verdict: "gate", reason: "no checkable assertions enumerated — vacuous confirmation refused" };
    }
    if (parsed.contradicted) {
      return { field, verdict: "contradicted", reason: "the image positively disagrees with a recorded assertion" };
    }
    return parsed.confirmed
      ? { field, verdict: "pass", reason: `${assertions.length} assertion(s) confirmed` }
      : { field, verdict: "abstain", reason: "not positively confirmed" };
  }
  if (parsed.contradicted) {
    return { field, verdict: "contradicted", reason: "the image positively disagrees with the recorded claim" };
  }
  return parsed.confirmed
    ? { field, verdict: "pass", reason: "positively confirmed against the image" }
    : { field, verdict: "abstain", reason: "not positively confirmed" };
}
```

- [ ] **Step 4: Add corroboration and the `dataQuality` accumulation to `verifyEntry`**

```ts
// FieldVerdict verdict union widens; verifyEntry return type becomes:
// { records, verdicts, dataQuality: Record<string, DataQualityRecord> }

// After the first-pass decide loop, BEFORE the prose re-produce block:
// Corroboration covers NON-PROSE fields only. A prose field that the model
// contradicts goes through the EXISTING re-produce + re-verify path (rewrite
// against the pixels, then one fresh ask) — corroborating it here too would
// double-ask and race the re-produce write.
const modelContradicted = pending.filter(
  (field) => !PROSE_FIELDS.includes(field) && decided.get(field)?.verdict === "contradicted",
);
if (modelContradicted.length > 0) {
  // Corroborate each contradicted field with a SECOND fresh-context ask. The
  // second ask uses the same positive-affirmation prompt; never anchor it.
  for (const field of modelContradicted) {
    const claim = claimForField(entry as unknown as Record<string, unknown>, field);
    if (claim === null) continue;
    // The corroborating ask is wrapped: an unwrapped throw here (timeout, 429,
    // provider 500) propagates out of verifyEntry to main()'s per-entry catch,
    // which discards EVERYTHING already computed for the entry — including
    // detector passes that cost nothing to keep. A failed corroboration must
    // downgrade this one field to `abstain`, not destroy the entry's other work.
    let reParsedRaw: string;
    try {
      reParsedRaw = await deps.callVision(
        buildVerifyPrompt(entry as unknown as Record<string, unknown>, [field], VERIFIER_VERSION),
        imagePath,
      );
    } catch (err) {
      // Uncorroborated: no dataQuality (an unconfirmed accusation is not a
      // finding) and no trust record. A marker keeps the queue converging.
      verdicts.push({
        field,
        verdict: "abstain",
        reason: `model contradiction could not be corroborated: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    const reParsed = parseVerifyResponse(reParsedRaw);
    const reVerdict = decideFieldVerdict(field, tierForField(field), reParsed[field] ?? { confirmed: false, contradicted: false });
    if (reVerdict.verdict === "pass") {
      records[field] = { method: "image-confirmed", verifiedAt: now, verifierVersion: VERIFIER_VERSION, imageSha256: imageSha256Of(imagePath) };
      decided.set(field, reVerdict);
    } else if (reVerdict.verdict === "contradicted") {
      dataQuality[field] = {
        measured: null,
        recorded: claim,
        source: "vision",
        reason: reParsed[field]?.reason ?? "corroborated contradiction",
        verifierVersion: VERIFIER_VERSION,
        verifiedAt: now,
      };
      decided.set(field, reVerdict);
    } else {
      decided.set(field, reVerdict); // abstain -> marker in Task 15
    }
  }
}

// The prose re-produce trigger widens: failedProse filters verdict !== "pass"
// (was === "fail"). Inside the prose re-verify loop, a reVerdict of
// "contradicted" ALSO accumulates dataQuality (source "vision", reason from
// the re-verify response) — a re-produced value the fresh ask still calls
// contradicted is a finding, not a marker.

// The finalize loop stays, but skip fields now carrying records/dataQuality.

// Detector contradictions (Task 12's outcome.contradicted) also accumulate.
//
// NO `if (detectorsEnabled)` GUARD HERE. An earlier draft wrapped this loop in
// one, reasoning that `--detectors off` must not write dataQuality. But with the
// flag off `runDetectors` still runs `platform` and `visual.dominantColors` —
// they are `mechanical` TODAY, so the flag does not disable them. A contradiction
// from either was therefore blocked from dataQuality here, skipped by
// `resumeMarkers` (which ignores `contradicted`), and written to NO map at all —
// so `selectPending` requeued that entry on every subsequent run, forever. Before
// this plan, `verifyMechanicalFields` returned `"fail"` and `resumeMarkers` marked
// it, so that was a regression, not a pre-existing gap.
//
// The guard is also redundant: with the flag off, `outcome.contradicted` can only
// contain `platform` / `visual.dominantColors`, because no other detector ran.
// Anything in the outcome came from a detector that actually executed, and every
// executed contradiction must land in exactly one map.
for (const field of outcome.contradicted) {
  const verdict = verdicts.find((v) => v.field === field);
  dataQuality[field] = {
    measured: null,
    recorded: claimForField(entry as unknown as Record<string, unknown>, field),
    source: field, // the detector name = registry key
    reason: verdict?.reason ?? "detector contradiction",
    verifierVersion: VERIFIER_VERSION,
    verifiedAt: now,
  };
}
```

Add a convergence test for exactly this path:

```ts
it("a contradicted mechanical field converges with --detectors off (no orphaned field)", async () => {
  // platform/dominantColors run regardless of the flag, so their contradictions
  // must still land in a map — otherwise selectPending requeues the entry forever.
  const e = makeEntry();
  e.platform = "mobile";                                   // 1440x900 is web
  e.image = { path: "x.png", width: 1440, height: 900, format: "png" };
  const out = await verifyEntry(e, image, {
    now: () => "2026-08-07", callVision: async () => "{}", reproduce: async (x) => x,
    detectors: false,
  });
  expect(out.dataQuality.platform, "contradiction must be recorded even with detectors off").toBeDefined();
});
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/scripts/verify-corpus.test.ts`
Expected: PASS, including the two corroboration tests and all pre-existing verdict tests (updated for the new `abstain` semantics where they asserted `fail`).

- [ ] **Step 6: Commit**

```bash
git add src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts
git commit -m "feat(verify): three-way model verdicts with corroborated contradictions"
```

---

### Task 15: `provenance.dataQuality` map + record-map exclusivity

**Files:**
- Modify: `src/schema.ts` (add `dataQuality` to `provenance`)
- Modify: `src/scripts/verify-corpus.ts` (`resumeMarkers`, `mergeVerification`, `mergeVerifyAttempts`, new `mergeDataQuality`, `alreadyProcessedAtVersion`, `selectPending`, `buildRunReport`, `main()` persistence)
- Test: `src/scripts/verify-corpus.test.ts` (extend)

**Interfaces:**
- Produces:
  - `interface DataQualityRecord { measured: unknown; recorded: unknown; source: string; verifierVersion: string; verifiedAt: string; reason?: string }`
  - `mergeDataQuality(entry, entries: Record<string, DataQualityRecord>): void` — writes the map and REVOKES `verification` + `verifyAttempts` for those fields.
  - `mergeVerification` / `mergeVerifyAttempts` also revoke `dataQuality` for the fields they write (exclusivity in all three directions).
  - `resumeMarkers` skips `pass` AND `contradicted` (a contradiction is a finding, not a retry candidate).
  - `alreadyProcessedAtVersion` / `selectPending` treat a `dataQuality` record at this version as PROCESSED — a contradiction is terminal at its version (re-checked on the next version bump, the same as fail/abstain markers; triage re-verify therefore runs under a new verifier version, or after the operator clears the record).

- [ ] **Step 1: Write the failing exclusivity test**

```ts
// additions to src/scripts/verify-corpus.test.ts
import { mergeDataQuality, mergeVerification, mergeVerifyAttempts, resumeMarkers } from "./verify-corpus.js";

describe("record-map exclusivity", () => {
  it("a contradiction revokes trust and attempts for its field only", () => {
    const e = makeEntry();
    mergeVerification(e, { layout: { method: "image-confirmed", verifiedAt: "x", verifierVersion: "v1" } });
    mergeVerifyAttempts(e, { mood: { verifierVersion: "v1", verifiedAt: "x" } });
    mergeDataQuality(e, { layout: { measured: 1, recorded: "a", source: "layout", verifierVersion: "v1", verifiedAt: "x" } });
    expect(e.provenance?.verification?.layout).toBeUndefined();
    expect(e.provenance?.verifyAttempts?.mood).toBeDefined(); // untouched sibling
    expect(e.provenance?.dataQuality?.layout?.source).toBe("layout");
  });

  it("a pass revokes dataQuality for its field", () => {
    const e = makeEntry();
    mergeDataQuality(e, { layout: { measured: 1, recorded: "a", source: "vision", verifierVersion: "v1", verifiedAt: "x" } });
    mergeVerification(e, { layout: { method: "image-confirmed", verifiedAt: "x", verifierVersion: "v1" } });
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `C2_NO_DOTENV=1 npx vitest run src/scripts/verify-corpus.test.ts`
Expected: FAIL — `mergeDataQuality` does not exist, and `resumeMarkers` still marks `contradicted`.

- [ ] **Step 3: Add the schema field**

```ts
// in src/schema.ts, inside the provenance object after verifyAttempts:
/**
 * Data-quality findings — NOT verification and NOT bookkeeping. Written by
 * contradicted verdicts (detector or corroborated model); revoked when the
 * field re-passes. Feeds --report-suspect and doctor. A field appears in at
 * most one of verification / verifyAttempts / dataQuality.
 */
dataQuality: z.record(z.string(), z.object({
  measured: z.unknown(),
  recorded: z.unknown(),
  source: z.string().min(1),
  reason: z.string().optional(),
  verifierVersion: z.string().min(1),
  verifiedAt: z.string().min(1),
}).passthrough()).optional(),
```

- [ ] **Step 4: Implement the merge functions and update the existing ones**

```ts
// in verify-corpus.ts
export interface DataQualityRecord {
  measured: unknown;
  recorded: unknown;
  source: string;
  reason?: string;
  verifierVersion: string;
  verifiedAt: string;
}

export function mergeDataQuality(entry: CorpusEntryT, entries: Record<string, DataQualityRecord>): void {
  const provenance = entry.provenance ?? { taggedBy: "auto" as const };
  const dataQuality = { ...(provenance.dataQuality ?? {}) };
  const verification = provenance.verification ? { ...provenance.verification } : undefined;
  const verifyAttempts = provenance.verifyAttempts ? { ...provenance.verifyAttempts } : undefined;
  for (const [field, record] of Object.entries(entries)) {
    dataQuality[field] = record;
    if (verification) delete verification[field];
    if (verifyAttempts) delete verifyAttempts[field];
  }
  provenance.dataQuality = dataQuality;
  if (verification) provenance.verification = verification;
  if (verifyAttempts) provenance.verifyAttempts = verifyAttempts;
  entry.provenance = provenance;
}

// mergeVerification: add `if (provenance.dataQuality) delete provenance.dataQuality[field];`
//   inside its loop (plus carry dataQuality through the clone).
// mergeVerifyAttempts: same — a marker revokes dataQuality for its field.
// resumeMarkers: `if (v.verdict === "pass" || v.verdict === "contradicted") continue;`
```

Then in `main()`'s persistence block (where `mergeVerification` / `mergeVerifyAttempts` are already called), add:

```ts
mergeDataQuality(target, verifyResult.dataQuality);
```

- [ ] **Step 5: Close the queue-convergence and run-report gaps**

```ts
// alreadyProcessedAtVersion — a contradiction is processed at its version too:
export function alreadyProcessedAtVersion(entry: CorpusEntryT, field: string, version: string): boolean {
  return entry.provenance?.verification?.[field]?.verifierVersion === version
    || entry.provenance?.verifyAttempts?.[field]?.verifierVersion === version
    || entry.provenance?.dataQuality?.[field]?.verifierVersion === version;
}

// selectPending — same: include dataQuality in the "processed" predicate.
//   const dataQuality = e.provenance?.dataQuality ?? {};
//   ... dataQuality[field]?.verifierVersion !== version

// buildRunReport — the counts map MUST cover the new verdicts or `counts[v.verdict]`
// becomes `counts[undefined] += 1` -> NaN (the existing map is { pass, fail, gate }):
const counts = { pass: 0, fail: 0, gate: 0, contradicted: 0, abstain: 0 };
// ...
lines.push(`Verdicts — ${counts.pass} pass, ${counts.contradicted} contradicted, ${counts.abstain} abstain, ${counts.gate} gated, ${counts.fail} fail (image-level only)`);

// Per-detector telemetry (the spec's accepted E4) — aggregate verdicts by
// registry field so drift (shifting pass/contradict/abstain rates) is visible
// per run instead of buried in the per-entry dump:
import { detectorRegistry } from "../verify/detector-registry.js";
const detectorRates: Record<string, { pass: number; contradicted: number; abstain: number }> = {};
for (const verdicts of Object.values(result.verdictsByEntry)) {
  for (const v of verdicts) {
    // Filter on SOURCE, not registry membership. `visual.usesShadows` is in the
    // registry but is decided by the MODEL whenever the recorded value is `false`
    // (418 entries), and both contradiction-only fields are always model-decided
    // for their passes. Keying on the registry alone reported those as detector
    // results, so the drift signal this telemetry exists to provide was measuring
    // the wrong lane.
    if (v.source !== "detector") continue;
    if (!detectorRegistry[v.field]) continue;
    const d = detectorRates[v.field] ?? { pass: 0, contradicted: 0, abstain: 0 };
    if (v.verdict === "pass" || v.verdict === "contradicted" || v.verdict === "abstain") d[v.verdict]++;
    detectorRates[v.field] = d;
  }
}
for (const [field, d] of Object.entries(detectorRates)) {
  // RATES, not just counts (the spec asks for rates): a raw count cannot be
  // compared across runs of different sizes, which is what drift detection needs.
  const n = d.pass + d.contradicted + d.abstain;
  const pct = (x: number) => n === 0 ? "0%" : `${((x / n) * 100).toFixed(0)}%`;
  lines.push(
    `Detector ${field}: n=${n} · pass ${d.pass} (${pct(d.pass)})`
    + ` · contradicted ${d.contradicted} (${pct(d.contradicted)})`
    + ` · abstain ${d.abstain} (${pct(d.abstain)})`,
  );
}
```

Add tests for both: `alreadyProcessedAtVersion` returns true for a field with a `dataQuality` record at the version, and `buildRunReport` prints the new verdict counts and a per-detector line for a run containing `contradicted`/`abstain` verdicts.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/scripts/verify-corpus.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/schema.ts src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts
git commit -m "feat(verify): provenance.dataQuality map with three-way exclusivity"
```

---

### Task 16: `--report-suspect` with the fixed hierarchy

**Files:**
- Modify: `src/scripts/verify-corpus.ts` (new `renderSuspectReport`, `--report-suspect` CLI flag)
- Test: `src/scripts/verify-corpus.test.ts` (extend)

**Interfaces:**
- Produces: `renderSuspectReport(entries: readonly CorpusEntryT[]): string` — a markdown table whose rows are ordered by **source class first** (detector contradictions above corroborated `"vision"` contradictions), then per entry by contradiction count descending, then by field. Columns: `field`, `measured`, `recorded`, `source`, `reason`, `entry`, `title`.

- [ ] **Step 1: Write the failing test**

```ts
// addition to src/scripts/verify-corpus.test.ts
import { renderSuspectReport } from "./verify-corpus.js";

describe("suspect report", () => {
  it("ranks detector contradictions above vision contradictions", () => {
    const vision = makeEntryWithDataQuality("vision", "mood");
    const detector = makeEntryWithDataQuality("visual.usesBorders", "layout");
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
  });
});

function makeEntryWithDataQuality(source: string, field: string): CorpusEntryT {
  const e = makeEntry();
  mergeDataQuality(e, { [field]: { measured: null, recorded: "x", source, verifierVersion: "verifier-v1", verifiedAt: "2026-08-07" } });
  return e;
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `C2_NO_DOTENV=1 npx vitest run src/scripts/verify-corpus.test.ts`
Expected: FAIL — `renderSuspectReport` does not exist.

- [ ] **Step 3: Implement**

```ts
// in verify-corpus.ts
export function renderSuspectReport(entries: readonly CorpusEntryT[]): string {
  const rows: Array<{ field: string; measured: string; recorded: string; source: string; reason: string; entry: string; title: string; count: number }> = [];
  for (const e of entries) {
    const dq = e.provenance?.dataQuality ?? {};
    const count = Object.keys(dq).length;
    for (const [field, record] of Object.entries(dq)) {
      rows.push({
        field,
        measured: typeof record.measured === "string" ? record.measured : JSON.stringify(record.measured ?? ""),
        recorded: typeof record.recorded === "string" ? record.recorded : JSON.stringify(record.recorded ?? ""),
        source: record.source,
        reason: typeof record.reason === "string" ? record.reason : "",
        entry: e.id,
        title: e.title,
        count,
      });
    }
  }
  // Source class first: detector (registry key) rows above "vision"; then
  // contradiction count desc; then field.
  const sourceRank = (source: string): number => (source === "vision" ? 1 : 0);
  rows.sort((a, b) =>
    sourceRank(a.source) - sourceRank(b.source)
    || b.count - a.count
    || a.field.localeCompare(b.field));
  const lines = [
    "| field | measured | recorded | source | reason | entry | title |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows.map((r) => `| ${r.field} | ${r.measured} | ${r.recorded} | ${r.source} | ${r.reason} | ${r.entry} | ${r.title} |`),
  ];
  return rows.length === 0 ? "No contradictions recorded." : lines.join("\n");
}
```

- [ ] **Step 4: Wire the CLI flag**

```ts
// in main()'s parseArgs options:
"report-suspect": { type: "boolean", default: false },
// after the run + persistence loop, before the run report print:
if (values["report-suspect"] === true) {
  console.log("\n## Suspect entries\n");
  console.log(renderSuspectReport(entries));
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/scripts/verify-corpus.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/scripts/verify-corpus.ts src/scripts/verify-corpus.test.ts
git commit -m "feat(verify): --report-suspect with source-ranked hierarchy"
```

---

### Task 17: Doctor validation for `dataQuality`

**Files:**
- Modify: `src/scripts/doctor-helpers.ts` (`CorpusDefectDetector` union + checks)
- Test: `src/scripts/doctor.test.ts` (the existing doctor suite — there is NO `doctor-helpers.test.ts`; the per-entry scanner is `corpusDefectCheck(entries, ctx)`, driven from `doctor.test.ts`)

**Interfaces:**
- Produces: three new doctor finding ids — `dataquality-malformed`, `dataquality-orphan-key`, `dataquality-count`.

- [ ] **Step 1: Write the failing test**

```ts
// src/scripts/doctor.test.ts — append a describe block, reusing the file's
// existing ALL_IMAGES context stub.
import { describe, expect, it } from "vitest";
import { corpusDefectCheck } from "./doctor-helpers.js";
import type { CorpusEntryT } from "../schema.js";

// `provenance` is `.optional()` (schema.ts:577,656), so indexing the possibly-
// undefined type is a TS error — NonNullable first.
type ProvenanceT = NonNullable<CorpusEntryT["provenance"]>;
function entry(dataQuality: ProvenanceT["dataQuality"]): CorpusEntryT {
  const e = { /* the file's standard clean-entry fixture shape */ } as CorpusEntryT;
  e.provenance = { taggedBy: "auto", dataQuality };
  return e;
}

describe("doctor dataQuality checks", () => {
  it("flags orphan keys and malformed/unknown sources", () => {
    const check = corpusDefectCheck([entry({
      "not-a-servable-key": { measured: null, recorded: null, source: "vision", verifierVersion: "v1", verifiedAt: "x" },
      layout: { measured: null, recorded: null, source: "not-a-detector", verifierVersion: "v1", verifiedAt: "x" },
    })], ALL_IMAGES);
    const text = JSON.stringify(check);
    expect(text).toContain("dataquality-orphan-key");
    expect(text).toContain("dataquality-malformed");
  });

  it("surfaces the total contradiction count", () => {
    const check = corpusDefectCheck([entry({
      layout: { measured: null, recorded: null, source: "vision", verifierVersion: "v1", verifiedAt: "x" },
    })], ALL_IMAGES);
    expect(JSON.stringify(check)).toContain("dataquality-count");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/scripts/doctor.test.ts`
Expected: FAIL — `dataquality-*` ids don't exist.

- [ ] **Step 3: Implement**

```ts
// in doctor-helpers.ts — the `CorpusDefectDetector` union (doctor-helpers.ts:259-274)
// gains the new detector names. There is no `FindingType` in this file; an earlier
// draft invented that name, and the union it meant is the one below.
  | "dataquality-malformed"
  | "dataquality-orphan-key"
  | "dataquality-count"

// The sources a dataQuality record may carry: the detector registry keys
// (detector name = registry key) plus "vision" for the model lane. Kept local
// on purpose — importing detector-registry would pull the tagger chain into
// the doctor hot path. Keep in sync with detector-registry.ts.
const DATA_QUALITY_SOURCES = new Set([
  "platform", "visual.dominantColors", "visual.usesBorders", "visual.usesShadows",
  "visual.accentColor", "visual.cornerStyle", "visual.spacingDensity",
  "visual.colorRoles", "antiPatterns.accessibilityRisks", "vision",
]);

// After the verification-integrity block, still inside the per-entry scan:
const dataQuality = entry.provenance?.dataQuality;
if (dataQuality) {
  for (const [field, record] of Object.entries(dataQuality)) {
    if (!SERVABLE_FIELD_KEYS.has(field)) {
      push(
        "dataquality-orphan-key",
        `dataQuality record for "${field}" is not in the servable field set — nobody reads it`,
      );
    }
    if (typeof record.source !== "string" || record.source.length === 0
      || !DATA_QUALITY_SOURCES.has(record.source)
      || typeof record.verifierVersion !== "string" || typeof record.verifiedAt !== "string") {
      push(
        "dataquality-malformed",
        `dataQuality record for "${field}" has an unusable source or version — got source "${String(record.source)}"`,
      );
    }
  }
  const total = Object.keys(dataQuality).length;
  if (total > 0) {
    push("dataquality-count", `${total} contradiction(s) recorded — run the suspect report before trusting these entries`);
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/scripts/doctor.test.ts`
Expected: PASS (plus the pre-existing doctor suite).

- [ ] **Step 5: Commit**

```bash
git add src/scripts/doctor-helpers.ts src/scripts/doctor.test.ts
git commit -m "feat(doctor): validate provenance.dataQuality"
```

---

### Task 18: Pin sampling in the re-produce pass (`tagImage`)

**Files:**
- Modify: `src/tagger.ts` (`TaggerInput.sampling`, threaded to Pass 1 + Pass 2 call sites)
- Modify: `src/scripts/verify-corpus.ts` (`makeReproduceDependency` passes the pin)
- Test: `src/scripts/verify-corpus.sampling.test.ts` (new)

**Interfaces:**
- Produces: `TaggerInput.sampling?: { temperature?: number; seed?: number }` — unset keeps today's behavior byte-identical.

This closes the measured instability source: `sampling` reaches `callVisionModel` today but not `tagImage`'s internal Pass 1 / Pass 2, so re-produced prose varies run to run.

- [ ] **Step 1: Write the failing test**

```ts
// src/scripts/verify-corpus.sampling.test.ts
import { describe, expect, it, vi } from "vitest";

vi.mock("../tagger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tagger.js")>();
  return {
    ...actual,
    tagImage: vi.fn(async () => ({
      critique: "critique",
      whatToSteal: ["steal"],
      antiPatterns: { antiPatterns: ["pattern"], whereThisFails: null, accessibilityRisks: [] },
      voice: { tone: "tone", examples: [], avoid: [] },
    })),
  };
});

import { makeReproduceDependency } from "./verify-corpus.js";
import { tagImage } from "../tagger.js";
import type { CorpusEntryT } from "../schema.js";

describe("re-produce sampling pin", () => {
  it("threads the pinned sampling into tagImage", async () => {
    const reproduce = makeReproduceDependency();
    const entry = {
      id: "t", title: "t", patternType: "dashboard", colorScheme: "light",
      categories: ["dashboard"], styleTags: [], components: [],
      layout: { form: "single-column", regions: [] },
      visual: {
        dominantColors: [], accentColor: null,
        typePairing: { display: null, body: null },
        spacingDensity: "moderate", cornerStyle: "sharp",
        usesShadows: false, usesBorders: false,
      },
      antiPatterns: { antiPatterns: [], whereThisFails: null, accessibilityRisks: [] },
      critique: "a", whatToSteal: [], voice: null, mood: null,
      platform: "web", qualityScore: 1, qualityTier: "exceptional",
      image: { path: "images-private/x.png", width: 100, height: 80, format: "png" },
    } as CorpusEntryT;
    await reproduce(entry, "images-private/x.png");
    expect(tagImage).toHaveBeenCalledTimes(1);
    expect((tagImage as ReturnType<typeof vi.fn>).mock.calls[0][0].sampling).toEqual({ temperature: 0 });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/scripts/verify-corpus.sampling.test.ts`
Expected: FAIL — the reproduced call passes no `sampling`.

- [ ] **Step 3: Implement**

```ts
// in tagger.ts — TaggerInput gains:
  /**
   * Sampling controls for BOTH internal passes. Omitted = provider default
   * (today's behavior). The verifier pins temperature 0 (NO seed — a seed
   * override makes callClaudeWithMetadata throw, tagger.ts:2267) so
   * re-produced prose does not vary between identical runs.
   */
  sampling?: { temperature?: number; seed?: number };
```

**`callModel`'s options parameter is `ProviderCallOptions`, NOT `{temperature, seed}`.**
Its fields are `temperatureOverride` / `seedOverride` (`tagger.ts:449-457`), and
`callVisionModel` already does this conversion explicitly (`tagger.ts:2645-2647`).
Passing `input.sampling` straight through would not compile, and if cast it would
be silently dropped — the pin would appear to work while changing nothing. Convert
once and reuse:

```ts
// tagger.ts, inside tagImage() before the passes run:
const samplingOptions: ProviderCallOptions | undefined =
  input.sampling === undefined
    ? undefined
    : { temperatureOverride: input.sampling.temperature, seedOverride: input.sampling.seed };
```

Then thread `samplingOptions` (not `input.sampling`) as the 9th argument of each
`callModel(...)`:

- **Pass 1** — three sites: initial `tagger.ts:2873`, low-detail retry `:2898`, high-detail retry `:2931`
- **Pass 2** — two sites: initial `tagger.ts:3074`, retry `:3104`

`callModel`'s signature is `(pass, prompt, imagePath, retryFeedback, detail,
thinkingOverride, providerOverride, cfgOverride, options)`, so the argument must
land in 9th position — the intervening `undefined`s are already present at each
site. `generateCritique`'s own call sites (`:3245`, `:3266`) are deliberately NOT
touched: that function is a separate public entry point with no `TaggerInput`.

```ts
// in verify-corpus.ts — makeReproduceDependency's tagImage call gains:
      // TEMPERATURE-ONLY. A seed override makes callClaudeWithMetadata THROW
      // (tagger.ts:2267) and OpenAI's Responses branch silently drops it —
      // pinning a seed here would break --vision-provider claude re-produce.
      sampling: { temperature: 0 },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/scripts/verify-corpus.sampling.test.ts src/tagger.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tagger.ts src/scripts/verify-corpus.ts src/scripts/verify-corpus.sampling.test.ts
git commit -m "fix(verify): pin sampling in the re-produce pass"
```

---

### Task 19: Method-level trust disclosure (E2)

**Files:**
- Modify: `src/corpus-trust.ts` (new `verifiedMethodFor`)
- Modify: `src/server-factory.ts` (browse column disclosure appends the method)
- Test: `src/corpus-trust.test.ts` (extend)

**Interfaces:**
- Produces: `verifiedMethodFor(entry: CorpusEntryT, field: string): string | null` — `"measured" | "provable" | "image-confirmed"` when `isVerified`, else `null`.

Agents should weigh "recomputed from data" (`provable`) differently from "a model looked at it" (`image-confirmed`). The serving layer already branches on `record.method` internally (`server-factory.ts:437`); this task surfaces it in the disclosure.

- [ ] **Step 1: Write the failing test**

```ts
// addition to src/corpus-trust.test.ts
import { verifiedMethodFor } from "./corpus-trust.js";

describe("verifiedMethodFor", () => {
  it("returns the record method only when verified", () => {
    const e = { ...baseEntry, provenance: { taggedBy: "auto", verification: {
      platform: { method: "provable", verifiedAt: "x", verifierVersion: "v1" },
      layout: { method: "image-confirmed", verifiedAt: "x", verifierVersion: "v1", imageSha256: "a".repeat(64) },
      critique: { method: "nope", verifiedAt: "x", verifierVersion: "v1" },
    } } } as CorpusEntryT;
    expect(verifiedMethodFor(e, "platform")).toBe("provable");
    expect(verifiedMethodFor(e, "layout")).toBe("image-confirmed");
    expect(verifiedMethodFor(e, "critique")).toBeNull(); // unknown method
    expect(verifiedMethodFor(e, "mood")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `C2_NO_DOTENV=1 npx vitest run src/corpus-trust.test.ts`
Expected: FAIL — `verifiedMethodFor` does not exist.

- [ ] **Step 3: Implement the helper**

```ts
// in corpus-trust.ts
/**
 * The evidence method behind a verified field — for disclosure, so an agent
 * can weigh "recomputed from data" (provable) vs "confirmed against the
 * image" (image-confirmed). Null when the field is not verified.
 */
export function verifiedMethodFor(entry: CorpusEntryT, field: string): string | null {
  const record = entry.provenance?.verification?.[field];
  if (!record || !isVerified(entry, field)) return null;
  return record.method;
}
```

- [ ] **Step 4: Surface it in the browse column disclosure**

Locate the `_Column disclosures:_` construction in `src/server-factory.ts` (around line 683). The disclosures name omitted columns. Extend them so a column that HAS verified rows also names the method on first mention — e.g., append ` (verified via ${method})` using `verifiedMethodFor(p.entry, field)` per column, skipping nulls. NOTE: `found` is `CorpusEntryT[]` (`server-factory.ts:622`) and has no `.entry` — only the `projections` elements built at `:625-629` do. Either `p.entry` inside the projections map or `found[i]` directly works (`ProjectedEntry` retains `provenance`); `found[0].entry` does not compile. If the exact construction differs from this sketch, keep the disclosure text and add the method to it; the test contract is the helper, and the disclosure change is verified by running the site tests:

Run: `C2_NO_DOTENV=1 npx vitest run src/synthesis-serving.test.ts src/invariant-sweep.test.ts`
Expected: PASS with no disclosure regressions. These are the two suites that actually assert
on `_Column disclosures:_`. There is NO `src/server-factory.test.ts`, and the root
`vitest.config.ts` excludes `site/tests/**` — an earlier draft named that path, so the step
ran zero tests and its "PASS" was unfalsifiable.

- [ ] **Step 5: Run the corpus-trust tests to verify they pass**

Run: `C2_NO_DOTENV=1 npx vitest run src/corpus-trust.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/corpus-trust.ts src/corpus-trust.test.ts src/server-factory.ts
git commit -m "feat(trust): disclose per-field verification method"
```

---

### Task 20: Production rollout runbook + final verification

**Files:**
- Modify: `README.md` ("Corpus trust & recovery" — detectors, cohort, suspect report)
- Modify: `TODOS.md` (frozen-set trigger update)
- Modify: `docs/superpowers/specs/2026-08-07-deterministic-detectors-design.md` (Status → implemented)

- [ ] **Step 1: Document the rollout sequence in README.md**

Under "Corpus trust & recovery", add a "Deterministic detectors" subsection:

```markdown
## Deterministic detectors & the suspect report

Perception fields (`usesShadows`, `usesBorders`, `accentColor`, `cornerStyle`,
`spacingDensity`) are verified by calibrated pixel detectors instead of the
vision model; `colorRoles` and `accessibilityRisks` get contradiction-only
checks. Model contradictions are corroborated by a second fresh ask.

- Verify with detectors: `npm run verify -- --detectors on`
- Compare with the legacy path: `npm run verify -- --detectors off`
- Real-screenshot calibration: `npm run calibrate-detectors`. Every declared
  `accuracyFloor` comes from a real-screenshot run recorded in
  `docs/verifier-calibration.md` and pinned in
  `src/verify/__fixtures__/held-out-lock.json`. A detector that cannot clear
  its floor ships `disabled` and its field stays with vision — that is a
  supported outcome, not a failure. Never lower a floor or edit a held-out
  fixture to make the gate green; the lock makes either change visible in
  review.
- Human triage: `npm run verify -- --report-suspect` — detector findings rank
  above model findings; actions are re-capture / re-tag / dismiss, then
  re-verify

Rollout order: calibrate → verify a ~50-entry representative cohort → light
the first 2d-2 surfaces with method disclosure → scale to the full corpus.
```

- [ ] **Step 2: Update TODOS.md**

In the "Frozen labelled ground-truth set" TODO, change the trigger line to note the plan has landed, and add `eval/verdicts/labels.jsonl` (real-screenshot labels, the spec's own labelling contract) as the calibration-input artifact.

- [ ] **Step 3: Run the full verification suite**

Run: `npx tsc --noEmit`
Expected: no type errors.

Run: `C2_NO_DOTENV=1 npx vitest run`
Expected: PASS (full suite, including the new `src/verify/**` tests).

Run: `npm run verify:dry-run` (after `npx tsc`)
Expected: prints the projected-cost report without calling any model.

- [ ] **Step 4: Update the spec status and commit**

```markdown
**Status:** implemented (2026-08-07)
```

```bash
git add README.md TODOS.md docs/superpowers/specs/2026-08-07-deterministic-detectors-design.md
git commit -m "docs(verify): deterministic-detectors rollout runbook"
```

---

## Self-review

**Spec coverage** (each spec requirement → task):

| Spec section | Task(s) |
| --- | --- |
| Benchmark provenance / rescue `/tmp/disputes.tsv` | 1 |
| `culori` dependency, shared `ctx` (`{ imagePath, raw?, width, height }`) | 2 |
| Detector types, confidence band, `canAffirm`, `recordedFor` | 3 |
| Synthetic fixtures, tune/held-out disjoint split | 4 |
| `usesBorders` certifying | 5 |
| `usesShadows` certifying + the border/shadow pair | 6 |
| `accentColor` maximality contract | 7 |
| `cornerStyle` schema-vocabulary buckets, `mixed` unaffirmable, band boundary | 8 |
| `spacingDensity` | 9 |
| `colorRoles` contradiction-only | 10 |
| `accessibilityRisks` contradiction-only | 11 |
| Registry + contract test, value-aware pending filter, runner caps, `--detectors off`, `verifyEntry` integration, tier reclassification | 12 |
| Calibration: held-out gate, disabled skip, decisive-rate floor, real-set CLI | 13 |
| Three-way model verdicts, corroborated contradictions, vacuity guard | 14 |
| `provenance.dataQuality`, three-way exclusivity, resume markers | 15 |
| `--report-suspect` hierarchy (source class → count → field) | 16 |
| Doctor `dataQuality` validation + count | 17 |
| Re-produce sampling pin | 18 |
| Method-level trust disclosure (E2) | 19 |
| Production rollout sequence + runbook (E3 triage documented; E4 per-detector telemetry in `buildRunReport` + the new verdict counts) | 20 (+15) |

**Deliberate deviations from the spec (flagged, not silent):**
1. The calibration gate adds a `decisiveRate >= 0.4` requirement alongside exact-match accuracy, because exact-match accuracy alone can be gamed by abstaining everything (Task 13).
2. The plan's `FieldVerdict` union retains `"fail"` for the image-level pseudo-verdict in `main()`; field-level verdicts use only pass/contradicted/abstain/gate (Task 14).
3. The real-screenshot labels REUSE the spec's "Frozen labelled ground-truth set" contract at `eval/verdicts/labels.jsonl` (Task 13B) — `confirmed | contradicted | abstain`, `imageSha256`-pinned, append-only with `supersedes`. An earlier draft invented a second format at `eval/detectors/labels.jsonl`, which is exactly what the spec defines that contract to prevent.
4. The re-produce pin is TEMPERATURE-ONLY (no seed): a seed override makes `callClaudeWithMetadata` throw (tagger.ts:2266) and OpenAI's Responses branch silently drops it (Task 18). This extends, not introduces, the existing verdict-path convention.
5. `dataQuality` at a verifier version counts as PROCESSED in `alreadyProcessedAtVersion`/`selectPending`, so a contradiction is terminal at its version and re-checked on the next version bump — consistent with fail/abstain markers and with the spec's terminal-contradiction semantics (Task 15).
6. `--detectors off` is scoped as "legacy pending list + no detector-side `dataQuality`" rather than byte-identical verdict labels; the three-way prompt changes labels regardless of the flag (Tasks 12/14).
7. `cornerStyle` measures EDGE INSET (walk each box edge from the corner until foreground) rather than a diagonal deviation — inset IS the radius ±1px, no conversion factor, and it stays within the spec's "edge deviation from a right angle, bucketed 0–2 / 3–20 / >20" framing (Task 8).

**Post-review revision (2026-08-07):** the plan was amended after a full eng review that empirically ran its own code (17/32 fixture mismatches). Fixed and **re-validated: the corrected code now runs 0/32 fixture mismatches, including held-out** (shadows 2/2, accent 1/1, corner 2/2 — every certifying detector clears its floor with decisive rate 1.0). The validation drove further fixes beyond the review list: the edge classifier now uses TWO-WAY edge widths + stroke-evidence dilation (stroked card thinRatio 0.986 vs the old inverted 0.315), the ramp metric is the ramp share of NON-STROKE edges (shadow rampRatio 0.67–0.69 vs 0.34 with the old denominator), `fillRoundRect` clamps radius to `(min-1)/2` (the old clamp made bottom corners render squarer — pill insets 25/25/18/18), shadow fixtures use blur 12 with opacities 0.45/0.28/0.50 (0.15 is below the edge threshold and undrawable), and each detector EXPORTS its own `confidenceBand` (shadows `[0.3, 0.7]`) with the registry referencing it — one source of truth. Also fixed: the `images/images/` generator path, the inverted `usesBorders` classifier, the unreachable `accentColor` pass (share excludes the target's own pixels), the outward corner walk + clamped pill fixture (edge-inset estimator, 80×50 card), the calibration CLI path resolver + `byField` type, held-out fixtures for borders/spacing/platform/dominantColors, `dataQuality`-as-processed queue convergence, `buildRunReport` verdict counts + per-detector telemetry, doctor unknown-source validation (in `doctor.test.ts`), the corrupt-image guard in `verifyEntry`, the temperature-only sampling pin, the suspect report's `reason` column, and `TIER_BY_FIELD` exported for the contract test.

**Placeholder scan:** every code step contains complete code. The only locate-style step left is the server-factory disclosure edit (Task 19) — it names the anchor symbol and the exact behavior to assert.

**Type consistency:** `detect(entry, ctx)` everywhere (never `detect(imagePath, recorded)`); `canAffirm(recorded)` everywhere; `ctx = { imagePath, raw?, width, height }`; `DataQualityRecord { measured, recorded, source, verifierVersion, verifiedAt, reason? }`; `FieldVerdict` widened once in Task 12 **Step 0** (it must precede the first task that emits the new labels) and consumed consistently in 13–17; it also carries `source: "detector" | "vision"` so telemetry can attribute a verdict to the lane that produced it. `resumeMarkers` skip set updated in Task 15; `buildRunReport` counts + per-detector telemetry land in Task 15.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-07-deterministic-detectors.md`. Two execution options:

**1. Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
