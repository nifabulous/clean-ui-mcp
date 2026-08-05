#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { detectPlatform, type CorpusEntryT } from "../schema.js";
import { extractQuantizedColors, tagImage, callVisionModel, type TaggerOutput, type Provider } from "../tagger.js";
import { fromCorpusRelativeImagePath } from "../paths.js";
import { loadCorpus } from "../corpus.js";
import { persistEntries, writableLoadedCorpus } from "../persistence.js";

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

/**
 * Wraps a parsed-response map so any key NOT explicitly present — an absent
 * field, an unparseable response, a non-object payload — reads back as
 * `{ confirmed: false }` rather than `undefined`. This is the fail-closed
 * contract: a missing key must fail the same way an explicit `false` would,
 * not silently short-circuit an optional-chained caller into `undefined`.
 */
function failClosed(
  out: Record<string, { confirmed: boolean; assertions?: string[]; reason?: string }>,
): Record<string, { confirmed: boolean; assertions?: string[]; reason?: string }> {
  return new Proxy(out, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        return { confirmed: false };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function parseVerifyResponse(raw: string): Record<string, { confirmed: boolean; assertions?: string[]; reason?: string }> {
  const out: Record<string, { confirmed: boolean; assertions?: string[]; reason?: string }> = {};
  const stripped = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped);
  } catch {
    return failClosed(out);
  }
  if (typeof parsed !== "object" || parsed === null) return failClosed(out);
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
  return failClosed(out);
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

/**
 * The single source of truth for which vision provider a run uses: the
 * `--vision-provider` flag if given, else the `VERIFY_VISION_PROVIDER` env
 * fallback. Pulled out as its own pure function (rather than inlined at each
 * call site) so `main()` can pass ONE resolved value to both the re-produce
 * dependency and the verify/re-verify vision calls — previously they resolved
 * independently and could disagree when the flag was unset but the env var
 * was set, silently routing the two passes to different providers.
 */
export function resolveConfiguredVisionProvider(flag: string | undefined): string | undefined {
  return flag ?? resolveVisionProvider();
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

  // Resolve the vision provider ONCE — the flag if given, else the env
  // fallback — and feed the SAME value to both the re-produce dependency and
  // the verify/re-verify calls below. Previously `reproduce` used
  // `values["vision-provider"] ?? resolveVisionProvider()` while `callVision`
  // passed `values["vision-provider"]` directly, so VERIFY_VISION_PROVIDER set
  // without `--vision-provider` routed the re-produce pass and the verify
  // passes to DIFFERENT providers. One resolved value now feeds both.
  const visionProvider = resolveConfiguredVisionProvider(values["vision-provider"]);
  const reproduce = makeReproduceDependency(visionProvider);
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
          // Use the SAME resolved provider as `reproduce` above (the flag, else
          // VERIFY_VISION_PROVIDER, else callModel's ambient routing) — never
          // `values["vision-provider"]` directly, or an env-only override would
          // route this call and the re-produce pass to different providers.
          callVisionModel(prompt, image, visionProvider as Provider | undefined, undefined, undefined, "low"),
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
