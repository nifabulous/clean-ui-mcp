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

const VOCAB = {
  patternType:
    "auth calculator chat-interface checkout command-palette dashboard data-table editor-canvas empty-state forms gallery interstitial landing-page marketing-hero mobile-nav modal navigation notifications onboarding pricing profile search settings".split(" "),
  categories:
    "auth chat-interface checkout dashboard data-table editor-canvas empty-state forms landing-page marketing-hero mobile-nav navigation notifications onboarding pricing profile search settings".split(" "),
  components:
    "area-chart avatar avatar-group badge banner bar-chart bottom-nav carousel card-list chart checklist command-palette cta-button data-table donut-chart drawer empty-state feed-list filter-controls form-controls icon-button illustration kpi-card line-chart list-row media-grid metric-grid modal-dialog notification-bell pricing-card primary-button progress-bar report-list search-command search-input segmented-control sidebar-nav status-chip stepper summary-card tab-nav timeline toggle-switch top-nav".split(" "),
  domainTags:
    "ai-ml analytics banking communication crypto developer-tools ecommerce education enterprise-saas fintech healthcare hr infrastructure insurance investing marketing media payments productivity recruiting security social".split(" "),
};
const LIMITS = { categories: 4, components: 8, domainTags: 4 };
const VISUAL_KEYS = ["density", "color-scheme", "typography", "layout"];
// visualFields entries that are closed lists rather than free text.
// `layout` mirrors the corpus snapshot's own `layout.form` taxonomy.
const VISUAL_VOCAB = {
  density: ["sparse", "moderate", "dense"],
  "color-scheme": ["light", "dark", "mixed"],
  layout: ["single-column", "two-column", "three-column", "modal-overlay"],
};

const [, , inputArg, ...rest] = process.argv;
if (!inputArg) {
  console.error("usage: validate-reviewer-file.mjs <filled.json> [--out <clean.json>] [--gaps <gaps.json>]");
  process.exit(2);
}
const outIndex = rest.indexOf("--out");
const outPath = outIndex === -1 ? null : rest[outIndex + 1];
const gapsIndex = rest.indexOf("--gaps");
const gapsPath = gapsIndex === -1 ? null : rest[gapsIndex + 1];

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

const reviewer = (raw.reviewer ?? "").toString().trim();
if (!reviewer || reviewer.startsWith("<FILL")) {
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

/* Vocabulary-gap flags: validated for shape, then kept OUT of the clean label
   file. They are evidence for a later corpus-enrichment pass, not label data,
   and must never reach the agreement computation. */
const GAP_FIELDS = new Set([
  "patternType", "categories", "components", "domainTags",
  "layout", "density", "color-scheme", "critiqueQuality",
]);
const gaps = [];
if (raw.vocabularyGaps !== undefined) {
  if (!Array.isArray(raw.vocabularyGaps)) {
    errors.push("`vocabularyGaps` must be an array");
  } else {
    raw.vocabularyGaps.forEach((gap, i) => {
      const at = `vocabularyGaps[${i}]`;
      if (!expectedIds.includes(gap.entryId)) errors.push(`${at}: unknown entryId "${gap.entryId}"`);
      if (!GAP_FIELDS.has(gap.field)) errors.push(`${at}: field "${gap.field}" is not a closed-list field`);
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

console.log(`OK — 40 labels, reviewer "${reviewer}", vocabulary and schema clean.`);
if (gaps.length) {
  const byField = {};
  for (const g of gaps) byField[g.field] = (byField[g.field] || 0) + 1;
  const summary = Object.entries(byField).map(([f, n]) => `${f} ${n}`).join(", ");
  console.log(`${gaps.length} vocabulary gap(s) flagged — ${summary}`);
  console.log("  (kept out of the label file; they do not affect the metrics)");
}
if (outPath) {
  const out = {
    labelingMethod: raw.labelingMethod ?? "independent-human-review",
    parentAuthority: raw.parentAuthority ?? false,
    provenanceDoc: "eval/c2/label-integrity/PROVENANCE.md",
    reviewer,
    selectionArtifactId: selection.artifactId,
    selectionSha256: PINNED_SELECTION_SHA,
    labels: clean,
  };
  fs.writeFileSync(outPath, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`wrote clean file: ${outPath}`);
}
if (gapsPath) {
  fs.writeFileSync(
    gapsPath,
    `${JSON.stringify({ reviewer, selectionArtifactId: selection.artifactId, gaps }, null, 2)}\n`,
  );
  console.log(`wrote gaps report: ${gapsPath} (${gaps.length} flag(s))`);
}
