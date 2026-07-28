#!/usr/bin/env node
// Validates one filled reviewer label file and emits a clean, schema-valid copy.
//
//   node eval/c2/label-integrity/packet/validate-reviewer-file.mjs <filled.json> \
//     [--out <clean.json>] [--gaps <gaps.json>]
//
// Checks: entryId set + order against the frozen selection, closed-vocabulary
// membership, per-label parse through the production EntryLabelSchema, and the
// selection hash binding. Strips the packet-only `_image` / `_cohort` /
// `_width` / `_height` viewing aids (the production schema is .strict() and
// would reject them).
//
// Requires `npm run build` — validation goes through dist/, fail-closed.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../../..");
const SELECTION = path.join(REPO_ROOT, "eval/c2/label-integrity/selection.json");
const PINNED_SELECTION_SHA =
  "9ed6ff2d74c0078706c67037910a8f3fcd3c519d9f0d724902022ac2acbe00b7";

import { VOCAB, VISUAL_VOCAB, LIMITS, VISUAL_KEYS, GAP_FIELDS } from "./vocabulary.mjs";

const [, , inputArg, ...rest] = process.argv;
if (!inputArg) {
  console.error("usage: validate-reviewer-file.mjs <filled.json> [--out <clean.json>] [--gaps <gaps.json>] [--verify-images] [--strict]");
  console.error("");
  console.error("  --strict    require a complete C2IndependentLabelSubmission envelope");
  console.error("              (actorId, actorKind, reviewerRole, sealedAt, etc.). Without");
  console.error("              --strict, only the labels are validated (legacy/diagnostic mode).");
  console.error("              --strict is REQUIRED when --out is used: a clean artifact cannot");
  console.error("              be emitted from a file that is not a valid submission.");
  process.exit(2);
}
const outIndex = rest.indexOf("--out");
const outPath = outIndex === -1 ? null : rest[outIndex + 1];
const gapsIndex = rest.indexOf("--gaps");
const gapsPath = gapsIndex === -1 ? null : rest[gapsIndex + 1];
const hasOutput = Boolean(outPath || gapsPath);
const strictMode = rest.includes("--strict");
const verifyImages = rest.includes("--verify-images") || hasOutput;

// --strict is required when emitting output: a clean artifact must be a valid
// submission, not just well-formed labels.
if (hasOutput && !strictMode) {
  console.error("error: --strict is required when using --out or --gaps.");
  console.error("       A clean artifact can only be emitted from a complete");
  console.error("       C2IndependentLabelSubmission, not from labels alone.");
  process.exit(2);
}

const distPath = path.join(REPO_ROOT, "dist/c2/evaluation-contracts.js");
if (!fs.existsSync(distPath)) {
  console.error("dist/ is missing — run `npm run build` first. Refusing to validate.");
  process.exit(1);
}
const { C2IndependentLabelSubmissionSchema } = await import(pathToFileURL(distPath).href);
// EntryLabelSchema is not exported. Rather than reach into Zod internals (which
// differ across major versions), validate the 40 labels by wrapping them in a
// synthetic submission and parsing that through the exported public schema.
// Only `labels` carries reviewer data; the envelope fields are fixed probes.
function parseLabels(labels, selectionArtifactId) {
  return C2IndependentLabelSubmissionSchema.safeParse({
    schemaVersion: "1.0",
    artifactType: "c2-independent-label-submission",
    artifactId: "c2-packet-validation-probe-v1",
    selectionArtifactId,
    selectionSha256: PINNED_SELECTION_SHA,
    submissionVersion: 1,
    actorId: "packet-validation-probe",
    actorKind: "human",
    reviewerRole: "Gold Label Owner",
    sealedAt: "2026-01-01T00:00:00.000Z",
    labels,
  });
}

const selection = JSON.parse(fs.readFileSync(SELECTION, "utf8"));
const selectionSha = crypto
  .createHash("sha256")
  .update(fs.readFileSync(SELECTION))
  .digest("hex");
const expectedIds = selection.entries.map((e) => e.entryId);

const raw = JSON.parse(fs.readFileSync(inputArg, "utf8"));
const labelsIn = Array.isArray(raw) ? raw : raw.labels;
const errors = [];
const warnings = [];

if (selectionSha !== PINNED_SELECTION_SHA) {
  errors.push(`selection.json hash drifted (${selectionSha}) — stop and re-pin before labeling`);
}
if (!Array.isArray(labelsIn)) {
  console.error("input has no `labels` array");
  process.exit(1);
}
if (labelsIn.length !== 40) errors.push(`expected 40 labels, found ${labelsIn.length}`);

const reviewer = (raw.reviewer ?? raw.actorId ?? "").toString().trim();
if (!strictMode && (!reviewer || reviewer.startsWith("<FILL"))) {
  errors.push("`reviewer` is unset — each reviewer needs a distinct id");
}
if (raw.selectionSha256 && raw.selectionSha256 !== PINNED_SELECTION_SHA) {
  errors.push("`selectionSha256` does not match the pinned selection");
}

const clean = [];
labelsIn.forEach((label, i) => {
  const where = `label[${i}] ${label.entryId ?? "(no entryId)"}`;
  // Every underscore-prefixed key is a packet-side annotation, never label
  // data: viewing aids (_image, _cohort, _width, _height) and draft notes
  // (_rationale, _confidence). The production schema is .strict(), so all of
  // them must go before the parse.
  const rest = Object.fromEntries(
    Object.entries(label).filter(([key]) => !key.startsWith("_")),
  );

  for (const [field, allowed] of Object.entries(VOCAB)) {
    const value = rest[field];
    if (field === "patternType") {
      if (!value) errors.push(`${where}: patternType is empty`);
      else if (!allowed.includes(value)) errors.push(`${where}: patternType "${value}" off-vocabulary`);
      continue;
    }
    if (!Array.isArray(value) || value.length === 0) {
      errors.push(`${where}: ${field} is empty (min 1)`);
      continue;
    }
    if (new Set(value).size !== value.length) errors.push(`${where}: ${field} has duplicates`);
    for (const v of value) {
      if (!allowed.includes(v)) errors.push(`${where}: ${field} value "${v}" off-vocabulary`);
    }
    if (value.length > LIMITS[field]) {
      warnings.push(`${where}: ${field} has ${value.length} values (guidance max ${LIMITS[field]})`);
    }
  }

  for (const key of VISUAL_KEYS) {
    const v = rest.visualFields?.[key];
    if (!v || !v.toString().trim()) {
      errors.push(`${where}: visualFields.${key} is empty`);
      continue;
    }
    const allowed = VISUAL_VOCAB[key];
    if (allowed && !allowed.includes(v)) {
      errors.push(`${where}: visualFields.${key} "${v}" off-vocabulary (expected one of ${allowed.join(", ")})`);
    }
  }
  if (!rest.critiqueQuality) errors.push(`${where}: critiqueQuality is empty`);
  if (rest.protectedFieldExpectation !== "unchanged") {
    errors.push(`${where}: protectedFieldExpectation must be "unchanged"`);
  }

  clean.push(rest);
});

// Production-schema parse over the whole set (envelope fields are fixed probes;
// any issue under `labels.<i>` is a real defect in the reviewer's data).
if (clean.length === 40) {
  const parsed = parseLabels(clean, selection.artifactId);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const at = issue.path.join(".");
      if (!at.startsWith("labels")) continue;
      const index = Number(issue.path[1]);
      const entryId = Number.isInteger(index) ? clean[index]?.entryId : "?";
      errors.push(`label[${index}] ${entryId}: schema ${issue.path.slice(2).join(".")}: ${issue.message}`);
    }
  }
}

// Strict envelope validation: parse the reviewer's ACTUAL file (not a synthetic
// probe) through the production schema. Catches missing/invalid envelope fields
// — actorId, actorKind, reviewerRole, sealedAt, submissionVersion, artifactId,
// artifactType — that the label-only parse above cannot see. Required when
// --strict is passed, and enforced above when --out is used.
const ENVELOPE_FIELDS = [
  "schemaVersion", "artifactType", "artifactId", "selectionArtifactId",
  "selectionSha256", "submissionVersion", "actorId", "actorKind",
  "reviewerRole", "sealedAt",
];
let strictSubmission = null;
if (strictMode) {
  // `vocabularyGaps` is a sibling of `labels` in the exported file (see
  // label.html), kept out of the clean label data and validated separately
  // below. The production submission schema is strict, so it would reject the
  // unknown `vocabularyGaps` key before the gap-extraction step ever runs —
  // breaking the documented `--strict --gaps` workflow. Strip it here and let
  // the dedicated gap validation below handle it.
  const { vocabularyGaps: _gapsForSeparateValidation, ...strictInput } = raw;
  const strictResult = C2IndependentLabelSubmissionSchema.safeParse(strictInput);
  if (!strictResult.success) {
    for (const issue of strictResult.error.issues) {
      const at = issue.path.join(".") || "(root)";
      // Distinguish envelope-field errors from label errors (already reported
      // above) so the reviewer knows where to fix.
      const isEnvelope = ENVELOPE_FIELDS.some((f) => at === f || at.startsWith(f + "."));
      const prefix = isEnvelope ? "envelope" : "schema";
      errors.push(`${prefix} ${at}: ${issue.message}`);
    }
  }
  // Also check for missing envelope fields explicitly (clearer than zod's
  // generic "Required" message for the reviewer).
  for (const field of ENVELOPE_FIELDS) {
    if (raw[field] === undefined) {
      errors.push(`envelope ${field}: MISSING — required for a complete C2IndependentLabelSubmission`);
    }
  }
  if (strictResult.success) strictSubmission = strictResult.data;
}

/* Vocabulary-gap flags: validated for shape, then kept OUT of the clean label
   file. They are evidence for a later corpus-enrichment pass, not label data,
   and must never reach the agreement computation. */
const gaps = [];
if (raw.vocabularyGaps !== undefined) {
  if (!Array.isArray(raw.vocabularyGaps)) {
    errors.push("`vocabularyGaps` must be an array");
  } else {
    raw.vocabularyGaps.forEach((gap, i) => {
      const at = `vocabularyGaps[${i}]`;
      if (!expectedIds.includes(gap.entryId)) errors.push(`${at}: unknown entryId "${gap.entryId}"`);
      if (!GAP_FIELDS.includes(gap.field)) errors.push(`${at}: field "${gap.field}" is not a closed-list field`);
      if (!gap.wanted || !gap.wanted.toString().trim()) errors.push(`${at}: "wanted" is empty`);
      gaps.push({
        entryId: gap.entryId,
        field: gap.field,
        wanted: (gap.wanted ?? "").toString().trim(),
        note: (gap.note ?? "").toString().trim(),
      });
    });
  }
}

const actualIds = clean.map((l) => l.entryId);
if (JSON.stringify(actualIds) !== JSON.stringify(expectedIds)) {
  const missing = expectedIds.filter((id) => !actualIds.includes(id));
  const extra = actualIds.filter((id) => !expectedIds.includes(id));
  if (missing.length) errors.push(`missing entryIds: ${missing.join(", ")}`);
  if (extra.length) errors.push(`unexpected entryIds: ${extra.join(", ")}`);
  if (!missing.length && !extra.length) errors.push("entryIds are correct but out of selection order");
}

for (const w of warnings) console.log(`warn  ${w}`);
if (errors.length) {
  console.error(`\n${errors.length} error(s):`);
  for (const e of errors.slice(0, 40)) console.error(`  - ${e}`);
  if (errors.length > 40) console.error(`  … and ${errors.length - 40} more`);
  process.exit(1);
}

// Image-bundle preflight: verify every PNG against selection.json's imageSha256.
// A reviewer artifact must never be emitted without this binding. Diagnostic
// validation without --out/--gaps may omit the check when the private bundle is
// unavailable (for example, in CI); any command that writes output verifies it.
if (verifyImages) {
  const { spawnSync } = await import("node:child_process");
  const preflightExe = path.join(REPO_ROOT, "eval/c2/label-integrity/packet/verify-image-bundle.mjs");
  const preflight = spawnSync("node", [preflightExe], { encoding: "utf-8" });
  if (preflight.status !== 0) {
    console.error(`\nimage-bundle preflight failed (exit ${preflight.status ?? "unknown"}) — refusing to emit reviewer artifacts:`);
    for (const line of `${preflight.stdout || ""}\n${preflight.stderr || ""}`.trim().split("\n")) if (line) console.error(`  ${line}`);
    console.error("  Run: node eval/c2/label-integrity/packet/verify-image-bundle.mjs");
    process.exit(1);
  }
}

console.log(`OK — 40 labels, reviewer "${reviewer}", vocabulary and schema clean.`);
if (gaps.length) {
  const byField = {};
  for (const g of gaps) byField[g.field] = (byField[g.field] || 0) + 1;
  const summary = Object.entries(byField).map(([f, n]) => `${f} ${n}`).join(", ");
  console.log(`${gaps.length} vocabulary gap(s) flagged — ${summary}`);
  console.log("  (kept out of the label file; they do not affect the metrics)");
}
if (outPath) {
  if (!strictSubmission) {
    console.error("strict validation did not produce a submission — refusing to write output");
    process.exit(1);
  }
  fs.writeFileSync(outPath, `${JSON.stringify(strictSubmission, null, 2)}\n`);
  console.log(`wrote clean file: ${outPath}`);
}
if (gapsPath) {
  fs.writeFileSync(
    gapsPath,
    `${JSON.stringify({ reviewer, selectionArtifactId: selection.artifactId, gaps }, null, 2)}\n`,
  );
  console.log(`wrote gaps report: ${gapsPath} (${gaps.length} flag(s))`);
}
