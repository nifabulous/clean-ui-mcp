#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { type CorpusEntryT } from "../schema.js";
import { tagImage, callVisionModel, resolvedProviderAndModel, type TaggerOutput, type Provider } from "../tagger.js";
import { fromCorpusRelativeImagePath } from "../paths.js";
import { loadCorpus } from "../corpus.js";
import { persistEntries, writableLoadedCorpus } from "../persistence.js";
import { detectorRegistry } from "../verify/detector-registry.js";
import { createVerifyCtx, type VerifyCtx } from "../verify/ctx.js";
import { runDetectors, type RunDetectorsOutcome } from "../verify/runner.js";
import { recordedFor } from "../verify/detector-types.js";

/** The verifier's own version — stamped on every record and the resume key. */
export const VERIFIER_VERSION = "verifier-v1";

export type VerifierTier = "mechanical" | "factual" | "a11y" | "prose" | "soft" | "gated";

export type VerificationRecord = {
  method: string;
  verifiedAt: string;
  verifierVersion: string;
  imageSha256?: string;
};

/**
 * A data-quality finding: the record claims X but the evidence (a detector or
 * a corroborated model judgement) disagrees. This is NOT a trust record — it
 * lives OUTSIDE `provenance.verification` (Task 15 formalizes it into
 * `provenance.dataQuality`) and never serves a value. `measured` is what the
 * evidence found (null when the evidence only contradicts without measuring);
 * `source` names the lane: the detector name (= registry key) or "vision".
 * `imageSha256` pins the bytes a pixel-based finding was measured against,
 * exactly as image-confirmed verification records do; `platform` is recomputed
 * from recorded dimensions and reads no pixels, so it carries no hash.
 */
export type DataQualityRecord = {
  measured: null | string;
  recorded: string | null;
  source: string;
  reason?: string;
  verifierVersion: string;
  verifiedAt: string;
  imageSha256?: string;
};

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

/**
 * The spec's classification table as code. A key added to SERVABLE_FIELD_KEYS
 * later must be classified here too, or tierForField returns "gated" and the
 * key is silently unverifiable — the doctor's verification-orphan-key detector
 * already catches keys nothing reads; this catches servable keys nothing
 * verifies.
 */
export const TIER_BY_FIELD: Readonly<Record<string, VerifierTier>> = {
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

export function tierForField(field: string): VerifierTier {
  return TIER_BY_FIELD[field] ?? "gated";
}

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
      lines.push(`- ${field}: confirm this claim is VISIBLY TRUE in the screenshot. Return "confirmed" only when you can positively see it; "contradicted" only when the image POSITIVELY disagrees with the claim; otherwise "abstain": "${claim}".`);
    }
  }
  if (lines.length === 0) return "";
  return `You are an independent verifier (${verifierVersion}), NOT the producer. For each field below, judge the claim against the screenshot: "confirmed" only when you can positively SEE it; "contradicted" only when the image POSITIVELY disagrees; otherwise "abstain". Never guess.
Return ONLY valid JSON, no fences:
{
  "<field>": { "verdict": "confirmed" | "contradicted" | "abstain", "assertions": ["..."], "reason": "..." }
}
${lines.join("\n")}`;
}

/**
 * A parsed per-field model answer. `contradicted` is the THIRD state: the image
 * POSITIVELY disagrees with the claim. Failing closed (a missing field, an
 * unparseable response) means neither confirmed nor contradicted.
 */
export type ParsedField = {
  confirmed: boolean;
  contradicted: boolean;
  assertions?: string[];
  reason?: string;
};

/**
 * Wraps a parsed-response map so any key NOT explicitly present — an absent
 * field, an unparseable response, a non-object payload — reads back as
 * `{ confirmed: false, contradicted: false }` rather than `undefined`. This is
 * the fail-closed contract: a missing key must fail the same way an explicit
 * silence would, not silently short-circuit an optional-chained caller into
 * `undefined`.
 */
function failClosed(
  out: Record<string, ParsedField>,
): Record<string, ParsedField> {
  return new Proxy(out, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && !(prop in target)) {
        return { confirmed: false, contradicted: false };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}

export function parseVerifyResponse(raw: string): Record<string, ParsedField> {
  const out: Record<string, ParsedField> = {};
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
      out[field] = { confirmed: false, contradicted: false };
      continue;
    }
    const v = value as Record<string, unknown>;
    const assertions = Array.isArray(v.assertions)
      ? v.assertions.filter((a): a is string => typeof a === "string")
      : undefined;
    // The three-way verdict, with the legacy confirmed-boolean shape as a
    // fallback: a `verdict` string wins; otherwise an explicit `confirmed: true`
    // still counts as confirmed.
    const verdict = typeof v.verdict === "string"
      ? (v.verdict as string)
      : v.confirmed === true ? "confirmed" : undefined;
    out[field] = {
      confirmed: verdict === "confirmed",
      contradicted: verdict === "contradicted",
      ...(assertions !== undefined ? { assertions } : {}),
      ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
    };
  }
  return failClosed(out);
}

export function decideFieldVerdict(
  field: string,
  tier: VerifierTier,
  parsed: ParsedField,
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
  detectors?: boolean;
}

export async function verifyEntry(
  entry: CorpusEntryT,
  imagePath: string,
  deps: VerifyEntryDeps,
): Promise<{ records: Record<string, VerificationRecord>; verdicts: FieldVerdict[]; dataQuality: Record<string, DataQualityRecord> }> {
  const now = deps.now();
  const records: Record<string, VerificationRecord> = {};
  const verdicts: FieldVerdict[] = [];
  // Accumulated here (detector contradictions + corroborated model
  // contradictions) and persisted into `provenance.dataQuality` in Task 15.
  const dataQuality: Record<string, DataQualityRecord> = {};

  const detectorsEnabled = deps.detectors ?? true;
  let outcome: RunDetectorsOutcome;
  let detectorContradictions: string[] = [];
  let pending: string[];
  try {
    const ctx = await createVerifyCtx(imagePath);
    outcome = await runDetectors(entry, ctx, { detectors: detectorsEnabled });
    detectorContradictions = outcome.contradicted;
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
    detectorContradictions = partial.contradicted;
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

  // Detector-side contradictions must land in EXACTLY ONE map, whichever way
  // they are resolved:
  //   - detectors ON: every contradiction becomes a `dataQuality` finding —
  //     with `--detectors off` the two always-on detectors (platform,
  //     visual.dominantColors) still RUN (they are `mechanical` today, so the
  //     flag cannot disable them); their contradictions must not be dropped
  //     from every map, or `selectPending` requeues that entry forever.
  //   - detectors OFF: the flag's contract is NO detector-side dataQuality
  //     (Task 20's A/B comparison needs flag-off to be a genuine legacy
  //     baseline), so the same contradictions emit the LEGACY `fail` verdict,
  //     which `resumeMarkers` marks. Convergence holds with zero findings.
  if (detectorsEnabled) {
    for (const field of detectorContradictions) {
      const verdict = verdicts.find((v) => v.field === field);
      dataQuality[field] = {
        measured: null,
        recorded: claimForField(entry as unknown as Record<string, unknown>, field),
        source: field, // the detector name = registry key
        reason: verdict?.reason ?? "detector contradiction",
        verifierVersion: VERIFIER_VERSION,
        verifiedAt: now,
        // Pixel-based findings pin the bytes they were measured against. Only
        // `platform` is recomputed from recorded dimensions (no pixels), so it
        // carries no hash — the same discriminator used to choose
        // provableRecord vs confirmedRecord.
        ...(field === "platform" ? {} : { imageSha256: imageSha256Of(imagePath) }),
      };
    }
  } else {
    for (const field of detectorContradictions) {
      const i = verdicts.findIndex((v) => v.field === field);
      if (i >= 0) verdicts[i] = { ...verdicts[i], verdict: "fail" };
    }
  }

  // 2. The fields left to verify — those not already stamped at this version.
  if (pending.length > 0) {
    const parsed = parseVerifyResponse(await deps.callVision(buildVerifyPrompt(entry, pending, VERIFIER_VERSION), imagePath));

    // First pass: an initial verdict per pending field, from the ONE combined call.
    const decided = new Map<string, FieldVerdict>();
    for (const field of pending) {
      const claim = claimForField(entry as unknown as Record<string, unknown>, field);
      decided.set(
        field,
        claim === null
          ? { field, verdict: "gate", reason: "no recorded value to verify", source: "vision" }
          : { ...decideFieldVerdict(field, tierForField(field), parsed[field] ?? { confirmed: false, contradicted: false }), source: "vision" },
      );
    }

    // Corroboration covers NON-PROSE fields only. A prose field the model
    // contradicts goes through the EXISTING re-produce + re-verify path
    // (rewrite against the pixels, then one fresh ask) — corroborating it here
    // too would double-ask and race the re-produce write. A model `contradicted`
    // is corroborated by a SECOND fresh-context ask for that field alone; the
    // second ask uses the SAME positive-affirmation prompt, never an anchored
    // "do you still disagree". Model verdicts flip 14-18% between identical
    // runs, so a split is that instability manifesting and grants NEITHER a
    // trust record NOR a finding.
    const modelContradicted = pending.filter(
      (field) => !PROSE_FIELDS.includes(field) && decided.get(field)?.verdict === "contradicted",
    );
    for (const field of modelContradicted) {
      const claim = claimForField(entry as unknown as Record<string, unknown>, field);
      if (claim === null) continue;
      let reParsedRaw: string;
      try {
        reParsedRaw = await deps.callVision(
          buildVerifyPrompt(entry as unknown as Record<string, unknown>, [field], VERIFIER_VERSION),
          imagePath,
        );
      } catch (err) {
        // Uncorroborated: no dataQuality (an unconfirmed accusation is not a
        // finding) and no trust record. The abstain marker keeps the queue
        // converging. A throw here must NOT destroy the entry's other work
        // (detector passes already computed), so it is caught, not propagated.
        decided.set(field, {
          field,
          verdict: "abstain",
          reason: `model contradiction could not be corroborated: ${err instanceof Error ? err.message : String(err)}`,
          source: "vision",
        });
        continue;
      }
      const reParsed = parseVerifyResponse(reParsedRaw);
      const reVerdict = decideFieldVerdict(field, tierForField(field), reParsed[field] ?? { confirmed: false, contradicted: false });
      if (reVerdict.verdict === "pass") {
        // DISAGREEMENT, NOT CONFIRMATION. The first ask said `contradicted` and
        // the second says `confirmed` — that split IS the instability
        // corroboration exists to catch, the LEAST trustworthy state available.
        // Resolve to `abstain`: no trust record, no finding, just a marker so
        // the queue converges. The next verifier version re-asks.
        decided.set(field, {
          field,
          verdict: "abstain",
          reason: "model disagreed with itself across two fresh asks (contradicted, then confirmed) — neither verdict is corroborated",
          source: "vision",
        });
      } else if (reVerdict.verdict === "contradicted") {
        // Corroborated: both fresh asks positively disagree. A finding, not a
        // marker — but never a trust record.
        dataQuality[field] = {
          measured: null,
          recorded: claim,
          source: "vision",
          reason: reParsed[field]?.reason ?? "corroborated contradiction",
          verifierVersion: VERIFIER_VERSION,
          verifiedAt: now,
          // The model judged these exact pixels; pin them, as image-confirmed
          // verification records do. Without this the `imageSha256` field is
          // declared but never populated, and every staleness rule built on it
          // is dead code.
          imageSha256: imageSha256Of(imagePath),
        };
        decided.set(field, { ...reVerdict, source: "vision" });
      } else {
        decided.set(field, { ...reVerdict, source: "vision" }); // abstain -> marker in Task 15
      }
    }

    // 3. Re-produce ONCE if any prose field failed. The seeing Pass 2 rewrites
    // ALL prose fields in a single tagImage call — never re-tag per field — and
    // the failed ones are re-verified in ONE fresh independent call (step 4).
    // The trigger WIDENED from `=== "fail"` (a verdict decideFieldVerdict no
    // longer emits) to the abstain/contradicted states that replaced it. Gated
    // prose stays out of the lane: an absent value or a vacuous assertion list
    // is nothing re-production can fix.
    const failedProse = PROSE_FIELDS.filter((f) => {
      const verdict = decided.get(f)?.verdict;
      return pending.includes(f) && (verdict === "abstain" || verdict === "contradicted");
    });
    if (failedProse.length > 0) {
      const reproduced = await deps.reproduce(entry, imagePath);
      const reFields = failedProse.filter(
        (f) => claimForField(reproduced as unknown as Record<string, unknown>, f) !== null,
      );
      const reParsed: Record<string, ParsedField> = reFields.length > 0
        ? parseVerifyResponse(await deps.callVision(buildVerifyPrompt(reproduced as unknown as Record<string, unknown>, reFields, VERIFIER_VERSION), imagePath))
        : {};
      for (const field of failedProse) {
        if (!reFields.includes(field)) {
          decided.set(field, { field, verdict: "gate", reason: "re-production wrote no value for this field" });
          continue;
        }
        const reVerdict = decideFieldVerdict(field, "prose", reParsed[field] ?? { confirmed: false, contradicted: false });
        decided.set(field, reVerdict);
        if (reVerdict.verdict === "pass") {
          // The re-produced value replaces the fabricated one only after it
          // passed, so the stored value and the record agree.
          (entry as unknown as Record<string, unknown>)[field] = (reproduced as unknown as Record<string, unknown>)[field];
        } else if (reVerdict.verdict === "contradicted") {
          // A re-produced value the fresh ask STILL calls contradicted is a
          // finding, not a marker.
          dataQuality[field] = {
            measured: null,
            recorded: claimForField(entry as unknown as Record<string, unknown>, field),
            source: "vision",
            reason: reParsed[field]?.reason ?? "re-produced value contradicted by fresh ask",
            verifierVersion: VERIFIER_VERSION,
            verifiedAt: now,
            imageSha256: imageSha256Of(imagePath),
          };
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
  return { records, verdicts, dataQuality };
}

/**
 * The real re-produce dependency: tag the image with the SEEING Pass 2 and
 * return the produced entry. Only the failed fields' values are read by the
 * caller; Pass 1 re-runs internally as the extraction input Pass 2 requires.
 */
/**
 * Reject after `ms` unless `work` settles first. The timer is always cleared, so
 * a resolved promise never leaves a pending handle holding the process open.
 *
 * NOTE: this bounds the WAIT, not the work — the underlying HTTP request is not
 * aborted (the provider clients own their sockets). That is enough for the
 * failure this guards: the run stops being blocked and proceeds to the next
 * entry, recording the timeout as that entry's verdict.
 */
export async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${Math.round(ms / 1000)}s — ${label}`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The vision-capable OpenAI triple, used to override BOTH passes when the caller
 * selects `openai`. Reads the EXTRACTION tier deliberately: the critique tier is
 * commonly pinned to a text-only OpenAI-compatible endpoint (e.g. DeepSeek) for
 * cheap prose-only critique elsewhere, and the verifier's Pass 2 receives the
 * image, so that routing 400s on `unknown variant image_url`.
 *
 * Exported so the run report can name the model the re-produce step will ACTUALLY
 * use. The report resolved Pass 2 from the environment, which reads
 * OPENAI_AUTO_TAG_MODEL_CRITIQUE — so it printed `pass 2: deepseek-chat` for a run
 * whose Pass 2 was overridden to this config. Naming a model the run never called
 * is the same defect as naming none.
 */
export function openaiVisionConfig(): { provider: "openai"; baseUrl: string; apiKey: string; model: string } {
  return {
    provider: "openai",
    baseUrl: process.env.OPENAI_BASE_URL_EXTRACTION ?? process.env.OPENAI_BASE_URL ?? "",
    apiKey: process.env.OPENAI_API_KEY_EXTRACTION ?? process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_AUTO_TAG_MODEL_EXTRACTION ?? process.env.OPENAI_AUTO_TAG_MODEL ?? "gpt-5.4-nano",
  };
}

/**
 * The model the re-produce step's Pass 2 will actually call — override-aware, so
 * it agrees with `makeReproduceDependency` rather than with the raw environment.
 */
export function reproduceCritiqueModel(provider: string | undefined, envResolved: string): string {
  return provider === "openai" ? openaiVisionConfig().model : envResolved;
}

export function makeReproduceDependency(provider?: string): VerifyEntryDeps["reproduce"] {
  return async (entry: CorpusEntryT, imagePath: string): Promise<CorpusEntryT> => {
    // The verifier's Pass 2 (critique) receives the IMAGE (via critiqueImagePath),
    // so the critique lane MUST be vision-capable. A common .env setup pins
    // OPENAI_BASE_URL_CRITIQUE at a text-only OpenAI-compatible endpoint
    // (e.g. DeepSeek) for cheap prose-only critique elsewhere. That routing
    // would 400 here on `unknown variant image_url`. When the caller chose
    // openai as vision provider, force critique to use the extraction-tier
    // config (real OpenAI, vision-capable) via an explicit override.
    const openaiVisionCfg = provider === "openai" ? openaiVisionConfig() : undefined;
    // BOTH passes must be pinned to the caller's provider, not just critique.
    // `resolveProvider` honours an explicit override and otherwise falls through
    // to AUTO_TAG_PROVIDER_<PASS>. Passing only `critiqueProvider` therefore left
    // Pass 1 (extraction) resolving from AUTO_TAG_PROVIDER_EXTRACTION — so a run
    // invoked as `--vision-provider claude` re-produced its prose with whatever
    // that env var named (measured: minimax), while the verdict pass genuinely
    // used claude. Prose-tier fields (critique/whatToSteal/antiPatterns/voice)
    // are the ones re-produced, so a provider comparison silently scored the
    // same extraction model for every provider on exactly those fields.
    const tagged = await tagImage({
      imagePath,
      productName: entry.source?.productName ?? "Untitled",
      url: entry.source?.url ?? null,
      critiqueImagePath: imagePath,
      extractionProvider: provider as Parameters<typeof tagImage>[0]["extractionProvider"],
      critiqueProvider: provider as Parameters<typeof tagImage>[0]["critiqueProvider"],
      extractionOverride: openaiVisionCfg,
      critiqueOverride: openaiVisionCfg,
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

export function buildRunReport(
  result: RunResult,
  opts: {
    dryRun: boolean;
    verifierVersion: string;
    sampleSize: number;
    /** The provider/model/detail the run ACTUALLY used — see the note below. */
    resolved?: {
      provider: string;
      model: string;
      /** Pass 2's model, which can differ from Pass 1's via *_AUTO_TAG_MODEL_CRITIQUE. */
      critiqueModel?: string;
      imageDetail: string;
      sampling: string;
    };
  },
): string {
  const lines: string[] = [];
  lines.push(`# Corpus verification ${opts.dryRun ? "(DRY-RUN)" : "run"} — ${opts.verifierVersion}`);
  lines.push("");
  // Record the RESOLVED model, not the requested one. `loadEnv()` calls dotenv
  // with `override: true` (src/env.ts), so `.env` beats a shell variable: a run
  // invoked as `CLAUDE_AUTO_TAG_MODEL=claude-sonnet-5 npm run verify` silently
  // used whatever `.env` pinned instead. Two runs intended as different models
  // were measured as the same one, and nothing in the output revealed it —
  // the discrepancy only surfaced in the provider's billing dashboard. A run
  // report that cannot name the model it used is not a measurement.
  if (opts.resolved) {
    const r = opts.resolved;
    const pass2 = r.critiqueModel && r.critiqueModel !== r.model ? ` (pass 2: ${r.critiqueModel})` : "";
    lines.push(
      `Model: ${r.provider}/${r.model}${pass2}`
      + ` · image detail: ${r.imageDetail}`
      + ` · sampling: ${r.sampling}`,
    );
  }
  lines.push(`Entries scanned: ${result.entries}`);
  const counts: Record<FieldVerdict["verdict"], number> =
    { pass: 0, fail: 0, contradicted: 0, abstain: 0, gate: 0 };
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
/** The providers `callModelWithMetadata` can actually route to. */
const VALID_VISION_PROVIDERS = ["openai", "claude", "gemini", "mistral", "minimax", "grok"] as const;

export function resolveConfiguredVisionProvider(flag: string | undefined): string | undefined {
  const resolved = flag ?? resolveVisionProvider();
  // Reject an unrecognised name instead of passing it through. `resolveProvider`
  // returns any non-mistral override verbatim and `callModelWithMetadata`'s
  // `default:` branch routes everything it doesn't recognise to OpenAI — so
  // `--vision-provider Claude` (capitalised) silently benchmarked OpenAI while
  // the run report printed "Claude". Fail loudly: this is the one flag whose
  // entire purpose is pinning the provider.
  if (resolved !== undefined && !(VALID_VISION_PROVIDERS as readonly string[]).includes(resolved)) {
    throw new Error(
      `unknown vision provider "${resolved}" — expected one of: ${VALID_VISION_PROVIDERS.join(", ")}`,
    );
  }
  return resolved;
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
      "image-detail": { type: "string" },
      "entry-timeout": { type: "string" },
      "sampling": { type: "string" },
      "detectors": { type: "string" },
    },
  });
  const dryRun = values["dry-run"] === true;
  const estimate = values.estimate === true;
  const limit = Number(values.limit);
  const sampleSize = Number(values["sample-size"]) || 30;
  const corpusPath = values.corpus;
  const detectorsEnabled = values.detectors !== "off";

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
  // The VERDICT pass's image fidelity. Historically pinned to "low" (a ~512px
  // downsample) to cut tokens — but the verdicts it produces are fine visual
  // judgements ("does this use shadows", "is #04a4fc the accent") on 1440x900
  // screenshots, where a thumbnail may not carry the evidence. Note the
  // asymmetry this exposes: the re-produce pass (tagImage) has always run at
  // "high". Exposed as a flag so the low-vs-high accuracy question is
  // measurable rather than assumed; "low" stays the default so this change
  // alters no existing behaviour.
  const rawDetail = (values["image-detail"] ?? "low").trim();
  if (rawDetail !== "low" && rawDetail !== "high") {
    throw new Error(`--image-detail must be "low" or "high" (got "${rawDetail}")`);
  }
  const imageDetail: "low" | "high" = rawDetail;
  // Per-entry wall-clock ceiling, in seconds. Default 300s: an entry legitimately
  // costs up to ~4 model calls (verify + re-produce's two passes + re-verify), so
  // the bound has to sit well above a slow-but-healthy entry while still cutting
  // off a hung one.
  const rawTimeout = Number(values["entry-timeout"] ?? 300);
  if (!Number.isFinite(rawTimeout) || rawTimeout <= 0) {
    throw new Error(`--entry-timeout must be a positive number of seconds (got "${values["entry-timeout"]}")`);
  }
  const entryTimeoutMs = rawTimeout * 1000;
  // Sampling for the verdict pass. A verdict is a pass/fail judgement about a
  // FIXED image, so there is no reason to sample: any variance is pure verdict
  // instability. Measured before this existed: 5 of 28 disputed verdicts (18%)
  // flipped between two runs with identical configuration, because nothing set
  // temperature and the providers default to 1 (the OpenAI-compatible branch
  // defaults to 1 explicitly, tagger.ts). Default now pins temperature 0 with a
  // fixed seed; `--sampling default` restores the old unpinned behaviour so the
  // noise floor stays measurable.
  const samplingMode = (values.sampling ?? "pinned").trim();
  if (samplingMode !== "pinned" && samplingMode !== "default") {
    throw new Error(`--sampling must be "pinned" or "default" (got "${samplingMode}")`);
  }
  const sampling = samplingMode === "pinned" ? { temperature: 0, seed: 20260806 } : undefined;
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
      // verifyEntry MUTATES its entry (value replacement on the re-verify pass), so
      // it ALWAYS gets a clone — never the live object from loadCorpus()'s cache.
      //
      // Cloning unconditionally is what makes the per-entry timeout below safe.
      // `withTimeout` bounds the WAIT, not the work: a timed-out verifyEntry keeps
      // running and can perform its value-replacement write minutes later. When
      // that write landed on the live entry, the abandoned call could substitute an
      // entry's prose AFTER the catch had already recorded the entry as failed —
      // so persistence (which falls back to the live object for any entry absent
      // from `verifiedById`) would write replaced, unverified prose carrying no
      // verification record and no resume marker. Exactly the "serve a value
      // nothing vouched for" failure the trust gate exists to prevent.
      //
      // Now the zombie can only ever scribble on a clone that no one reads, and
      // the live entry is updated below solely on the success path.
      const target = structuredClone(entry);
      // Per-entry wall-clock bound. A provider that accepts the request and then
      // never answers otherwise stalls the whole run indefinitely — observed: a
      // high-detail claude run sat at 0% CPU for 38 minutes having emitted zero
      // verdicts, because nothing here bounded a single hung HTTP call. The
      // rejection lands in the per-entry catch below, so the entry records a
      // failure and the run moves on rather than hanging forever.
      const { records, verdicts } = await withTimeout(
        verifyEntry(target, imagePath, {
          now: () => now,
          callVision: async (prompt, image) =>
            // Use the SAME resolved provider as `reproduce` above (the flag, else
            // VERIFY_VISION_PROVIDER, else callModel's ambient routing) — never
            // `values["vision-provider"]` directly, or an env-only override would
            // route this call and the re-produce pass to different providers.
            callVisionModel(prompt, image, visionProvider as Provider | undefined, undefined, undefined, imageDetail, sampling),
          reproduce,
          detectors: detectorsEnabled,
        }),
        entryTimeoutMs,
        `entry "${entry.id}"`,
      );
      if (!dryRun) {
        // Passes earn trust records in `verification`; every other evaluated field
        // earns a resume marker in `verifyAttempts` (a SIBLING map) so the queue
        // converges without polluting the trust map or tripping the doctor. A
        // pass revokes a stale marker and a fail revokes a stale record, so the
        // two maps stay mutually exclusive per field across version bumps.
        //
        // Merged into `target` (the clone verifyEntry actually wrote to) so its
        // value replacements travel with the records that vouch for them. Reached
        // only on the success path: a timed-out or throwing entry never registers,
        // so its partial work cannot reach persistence.
        mergeVerification(target, records);
        mergeVerifyAttempts(target, resumeMarkers(verdicts, now, VERIFIER_VERSION));
      }
      results.verdictsByEntry[entry.id] = verdicts;
      verifiedById.set(entry.id, target);
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
  const report = buildRunReport(results, {
    dryRun,
    verifierVersion: VERIFIER_VERSION,
    sampleSize,
    resolved: {
      ...resolvedProviderAndModel("extraction", visionProvider as Provider | undefined),
      // The re-produce step's Pass 2 can resolve a DIFFERENT model from Pass 1:
      // grokConfigForPass / minimaxConfigForPass read MINIMAX_AUTO_TAG_MODEL_CRITIQUE
      // and friends. Report it too — Pass 2 is the pass that writes the prose being
      // benchmarked, so omitting it reproduces the "cannot name the model it used"
      // defect one tier over.
      critiqueModel: reproduceCritiqueModel(
        visionProvider,
        resolvedProviderAndModel("critique", visionProvider as Provider | undefined).model,
      ),
      imageDetail,
      sampling: sampling ? `temperature=${sampling.temperature} seed=${sampling.seed}` : "provider default",
    },
  });
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
