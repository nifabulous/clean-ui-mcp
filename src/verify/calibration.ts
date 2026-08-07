// src/verify/calibration.ts
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
  // The plan's verbatim `as string` widened the recorded value out of the
  // `"web" | "mobile" | "tablet" | undefined` union; cast to the entry's own
  // platform type instead (same indexed-access style as the visual fields above).
  if (field === "platform") e.platform = fixture.recorded as CorpusEntryT["platform"];
  // The plan's literal carried `format: "png"`, which does not exist on the
  // image ref schema (visibility/path/width/height only) — dropped, nothing reads it.
  // The schema also requires `visibility`; the stub never carries one and no
  // detector reads it (platform detect() is pure dimension arithmetic), so one
  // cast at the boundary instead of an invented value.
  if (fixture.dims) e.image = { path: fixture.file, width: fixture.dims.width, height: fixture.dims.height } as unknown as CorpusEntryT["image"];
  return e;
}

export async function calibrate(
  manifest: FixtureManifest,
  split: "tune" | "held-out",
  deps: { imagePathFor?: (fixture: FixtureEntry) => string } = {},
): Promise<CalibrationResult> {
  const rows: CalibrationRow[] = [];
  // The stub is built with `null` for optional fields whose declared types do
  // not admit null (`whereThisFails: string[]`, `voice`, `mood`) and omits
  // `source`/`image`; the plan typed this literal `CorpusEntryT` directly and
  // tsc rejected it. One cast at the boundary (per the fix brief's preference)
  // keeps the runtime stub byte-identical — no value changes.
  const base = {
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
  } as unknown as CorpusEntryT;
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
