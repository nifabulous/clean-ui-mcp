#!/usr/bin/env node
/**
 * compute-baseline-metrics — compute the four C2 baseline-bound label-agreement
 * metrics between two independent label submissions.
 *
 * PURPOSE
 *   When producing the parent-authority baseline-metrics.json, the four metric
 *   values must be derived from real inter-reviewer agreement over the 40-entry
 *   selection. This script computes those four numbers from two label files so
 *   you don't hand-compute them. It is a measurement tool only — it does NOT
 *   author baseline-metrics.json, invent values, or write any artifact.
 *
 *   The four metrics (matching src/c2/label-agreement.ts:186-265 exactly):
 *     - pattern-type-exact-accuracy : fraction of entries where patternType agrees
 *     - categories-macro-f1         : macro-averaged per-category F1
 *     - components-recall            : macro-avg recall of gold∩qa / |qa| components
 *     - domain-tags-recall           : macro-avg recall of gold∩qa / |qa| domainTags
 *
 *   Convention (from label-agreement.ts:181-184): for set-based metrics, the
 *   first file (gold) is "predicted", the second (qa) is "reference".
 *   precision = |gold ∩ qa| / |gold|; recall = |gold ∩ qa| / |qa|.
 *
 * INPUTS
 *   Two JSON files, each a full C2IndependentLabelSubmission artifact (validated
 *   through the production schema) OR each a bare { labels: [...] } object whose
 *   labels conform to EntryLabelSchema. The script accepts either shape and
 *   validates through C2IndependentLabelSubmissionSchema when the full artifact
 *   fields are present.
 *
 *   Both files must label the SAME 40 entries (matched by entryId, order-independent).
 *
 * USAGE
 *   node scripts/compute-baseline-metrics.mjs <gold.json> <qa.json>
 *   node scripts/compute-baseline-metrics.mjs <a.json> <b.json> --json    # machine-readable
 *   node scripts/compute-baseline-metrics.mjs <a.json> <b.json> --disagree # list disagreeing entries
 *
 * OUTPUT
 *   The four metric values (0..1) to stdout. With --disagree, also lists the
 *   entryIds where ANY metric-relevant field differs. Exit 0 on success, 1 on
 *   validation/shape error, 2 on usage error.
 *
 * NOTE
 *   This script is cross-validated against production computeLabelAgreement by
 *   scripts/compute-baseline-metrics.test.mjs. If you edit the metric math here,
 *   re-run that test to confirm parity.
 */
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

// Production schema — imported from the built dist so validation is identical to
// what computeLabelAgreement enforces. This tool feeds parent-authority baseline
// values, so validation is MANDATORY: if dist is unavailable the script fails
// closed rather than computing metrics from unvalidated input.
let C2IndependentLabelSubmissionSchema;
let EntryLabelSchema;
try {
  const mod = await import("../dist/c2/evaluation-contracts.js");
  C2IndependentLabelSubmissionSchema = mod.C2IndependentLabelSubmissionSchema;
  // EntryLabelSchema is not directly exported; extract it from the submission's
  // labels array element so bare-label inputs validate through the same rules
  // (non-empty unique sets, stable IDs, enum critiqueQuality, strict object).
  EntryLabelSchema = C2IndependentLabelSubmissionSchema.shape.labels.element;
} catch (err) {
  // Fail closed: dist not built (e.g. fresh checkout). This tool's outputs can
  // feed parent-authority baseline-metrics, so computing from unvalidated input
  // is worse than refusing to run.
  console.error(`error: cannot load production schemas from dist/c2/evaluation-contracts.js — validation is mandatory for this tool.`);
  console.error(`  cause: ${err && err.message ? err.message : err}`);
  console.error(`  fix: run \`npm run build\` (or \`npx tsc\`) first, then re-run this script.`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Metric math — FAITHFUL copy of src/c2/label-agreement.ts:186-265.
// Do not diverge. The companion test asserts parity with computeLabelAgreement.
// ---------------------------------------------------------------------------

function computeFourBaselineMetrics(gold, qa) {
  if (gold.length !== qa.length) {
    throw new Error(`label count mismatch: gold has ${gold.length}, qa has ${qa.length} (expected 40 each)`);
  }
  const n = gold.length;

  // pattern-type-exact-accuracy
  let pteaMatches = 0;
  for (let i = 0; i < n; i++) {
    if (gold[i].patternType === qa[i].patternType) pteaMatches += 1;
  }
  const patternTypeExactAccuracy = n === 0 ? 0 : pteaMatches / n;

  // categories-macro-f1
  const allCategories = new Set();
  for (let i = 0; i < n; i++) {
    for (const c of gold[i].categories) allCategories.add(c);
    for (const c of qa[i].categories) allCategories.add(c);
  }
  let macroF1Sum = 0;
  let macroF1Denominator = 0;
  for (const category of allCategories) {
    let goldCount = 0;
    let qaCount = 0;
    let bothCount = 0;
    for (let i = 0; i < n; i++) {
      const g = gold[i].categories.includes(category);
      const q = qa[i].categories.includes(category);
      if (g) goldCount += 1;
      if (q) qaCount += 1;
      if (g && q) bothCount += 1;
    }
    const precision = goldCount === 0 ? 0 : bothCount / goldCount;
    const recall = qaCount === 0 ? 0 : bothCount / qaCount;
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
    macroF1Sum += f1;
    macroF1Denominator += 1;
  }
  const categoriesMacroF1 = macroF1Denominator === 0 ? 0 : macroF1Sum / macroF1Denominator;

  // components-recall + domain-tags-recall (precision computed too, for --json)
  let componentsRecallSum = 0;
  let componentsRecallDenominator = 0;
  let domainTagsRecallSum = 0;
  let domainTagsRecallDenominator = 0;
  for (let i = 0; i < n; i++) {
    const gComp = new Set(gold[i].components);
    const qComp = new Set(qa[i].components);
    const compIntersection = [...gComp].filter((c) => qComp.has(c)).length;
    if (qComp.size > 0) {
      componentsRecallSum += compIntersection / qComp.size;
      componentsRecallDenominator += 1;
    }
    const gTags = new Set(gold[i].domainTags);
    const qTags = new Set(qa[i].domainTags);
    const tagIntersection = [...gTags].filter((t) => qTags.has(t)).length;
    if (qTags.size > 0) {
      domainTagsRecallSum += tagIntersection / qTags.size;
      domainTagsRecallDenominator += 1;
    }
  }
  const componentsRecall = componentsRecallDenominator === 0 ? 0 : componentsRecallSum / componentsRecallDenominator;
  const domainTagsRecall = domainTagsRecallDenominator === 0 ? 0 : domainTagsRecallSum / domainTagsRecallDenominator;

  return {
    "pattern-type-exact-accuracy": patternTypeExactAccuracy,
    "categories-macro-f1": categoriesMacroF1,
    "components-recall": componentsRecall,
    "domain-tags-recall": domainTagsRecall,
  };
}

// ---------------------------------------------------------------------------
// Disagreement detection — checks ONLY the 4 baseline-bound fields.
// NOTE: production computeDisagreementEntryIds (label-agreement.ts) also checks
// critiqueQuality + groundedClaimIds because the full 8-metric report depends
// on them. This script measures only the 4 baseline-bound metrics, so it checks
// only those 4 fields. Disagreement ordering follows gold's input order, not
// the frozen selection order production uses.
// ---------------------------------------------------------------------------

function computeDisagreementEntryIds(gold, qa) {
  const disagreement = [];
  const n = Math.min(gold.length, qa.length);
  for (let i = 0; i < n; i++) {
    const g = gold[i];
    const q = qa[i];
    const fieldsDiffer =
      g.patternType !== q.patternType ||
      !setEquals(g.categories, q.categories) ||
      !setEquals(g.components, q.components) ||
      !setEquals(g.domainTags, q.domainTags);
    if (fieldsDiffer) disagreement.push(g.entryId);
  }
  return disagreement;
}

function setEquals(a, b) {
  const aa = a ?? [];
  const bb = b ?? [];
  if (aa.length !== bb.length) return false;
  const bs = new Set(bb);
  return aa.every((x) => bs.has(x));
}

function assertUniqueEntryIds(labels, which) {
  const seen = new Set();
  for (const l of labels) {
    if (seen.has(l.entryId)) {
      throw new Error(`${which} file has duplicate entryId "${l.entryId}" — entry labels must be unique (matches evaluation-contracts.ts:61)`);
    }
    seen.add(l.entryId);
  }
}

// ---------------------------------------------------------------------------
// Label loading + alignment
// ---------------------------------------------------------------------------

function extractLabels(filePath) {
  const raw = JSON.parse(readFileSync(filePath, "utf-8"));
  // Full submission artifact — validate through the production schema.
  if (raw.artifactType === "c2-independent-label-submission") {
    // Schema is always loaded (the loader fails closed at module init if dist
    // is missing). The guard is defensive depth against a future refactor.
    if (C2IndependentLabelSubmissionSchema) {
      const parsed = C2IndependentLabelSubmissionSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`${filePath} failed C2IndependentLabelSubmissionSchema:\n  ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("\n  ")}`);
      }
      return parsed.data.labels;
    }
    // Unreachable when the loader is intact; fail closed rather than silently
    // returning unvalidated labels.
    throw new Error(`${filePath}: schema unavailable — dist not built. Run \`npm run build\` first.`);
  }
  // Bare { labels: [...] } shape.
  const labels = Array.isArray(raw?.labels) ? raw.labels : Array.isArray(raw) ? raw : null;
  if (labels === null) {
    throw new Error(`${filePath}: expected a C2IndependentLabelSubmission artifact, { labels: [...] }, or an array of labels`);
  }
  // Validate each bare label through EntryLabelSchema so non-array categories,
  // empty/missing sets, bad enums, etc. are caught — matching what full
  // submissions get. Validation is mandatory (the loader fails closed at module
  // init if dist is missing); the guard is defensive depth.
  if (EntryLabelSchema) {
    labels.forEach((label, i) => {
      const parsed = EntryLabelSchema.safeParse(label);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`${filePath}: label[${i}] (entryId="${label?.entryId ?? "?"}") failed EntryLabelSchema: ${issue.path.join(".")}: ${issue.message}`);
      }
    });
  }
  return labels;
}

function alignByEntryId(goldLabels, qaLabels) {
  // Duplicate-entryId guard: production enforces "entry labels must be unique"
  // at evaluation-contracts.ts:61 for full submissions. Bare-label inputs skip
  // schema validation, so enforce uniqueness here too — otherwise a duplicated
  // entryId silently drops one entry in the Map and produces wrong metrics.
  assertUniqueEntryIds(goldLabels, "gold");
  assertUniqueEntryIds(qaLabels, "qa");
  const goldById = new Map(goldLabels.map((l) => [l.entryId, l]));
  const qaById = new Map(qaLabels.map((l) => [l.entryId, l]));
  const goldOnly = [...goldById.keys()].filter((id) => !qaById.has(id));
  const qaOnly = [...qaById.keys()].filter((id) => !goldById.has(id));
  if (goldOnly.length || qaOnly.length) {
    throw new Error(`entryId mismatch between files.\n  only in gold: ${goldOnly.join(", ") || "(none)"}\n  only in qa:   ${qaOnly.join(", ") || "(none)"}`);
  }
  // Align by gold's order so the metric math is order-stable.
  const alignedGold = [];
  const alignedQa = [];
  for (const l of goldLabels) {
    alignedGold.push(l);
    alignedQa.push(qaById.get(l.entryId));
  }
  return [alignedGold, alignedQa];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage() {
  console.error(`Usage: compute-baseline-metrics.mjs <gold.json> <qa.json> [options]

Computes the four C2 baseline-bound metrics between two label files.
Convention: gold = "predicted", qa = "reference" (matches label-agreement.ts).

Options:
  --json        Emit machine-readable JSON to stdout (the four metrics + counts)
  --disagree    Also list entryIds where any metric-relevant field differs

Exit codes:
  0  success
  1  validation / shape error
  2  usage error`);
}

function main() {
  const { values: flags, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json: { type: "boolean", default: false },
      disagree: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  if (positionals.length !== 2) {
    usage();
    process.exit(2);
  }

  const [goldPath, qaPath] = positionals;
  let goldLabels, qaLabels;
  try {
    goldLabels = extractLabels(goldPath);
    qaLabels = extractLabels(qaPath);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  if (goldLabels.length !== 40 || qaLabels.length !== 40) {
    console.error(`error: each file must label exactly 40 entries (gold: ${goldLabels.length}, qa: ${qaLabels.length})`);
    process.exit(1);
  }

  let alignedGold, alignedQa;
  try {
    [alignedGold, alignedQa] = alignByEntryId(goldLabels, qaLabels);
  } catch (err) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  const metrics = computeFourBaselineMetrics(alignedGold, alignedQa);
  const disagreementEntryIds = computeDisagreementEntryIds(alignedGold, alignedQa);

  if (flags.json) {
    const out = {
      ...metrics,
      entryCount: alignedGold.length,
      disagreementCount: disagreementEntryIds.length,
      ...(flags.disagree ? { disagreementEntryIds } : {}),
    };
    process.stdout.write(JSON.stringify(out, null, 2) + "\n");
  } else {
    console.log("C2 baseline-bound metrics (gold vs qa):");
    console.log(`  pattern-type-exact-accuracy : ${metrics["pattern-type-exact-accuracy"].toFixed(4)}`);
    console.log(`  categories-macro-f1         : ${metrics["categories-macro-f1"].toFixed(4)}`);
    console.log(`  components-recall           : ${metrics["components-recall"].toFixed(4)}`);
    console.log(`  domain-tags-recall          : ${metrics["domain-tags-recall"].toFixed(4)}`);
    console.log(`  entries                     : ${alignedGold.length}`);
    console.log(`  disagreeing entries         : ${disagreementEntryIds.length}`);
    if (flags.disagree && disagreementEntryIds.length) {
      console.log(`  disagreement entryIds       : ${disagreementEntryIds.join(", ")}`);
    }
  }
  process.exit(0);
}

// Export for the cross-validation test. main() only runs when this module is
// the process entry point (process.argv[1] resolves to this file), not when
// imported as a module.
export { computeFourBaselineMetrics, computeDisagreementEntryIds, alignByEntryId, extractLabels };

import { realpathSync } from "node:fs";
function isMain() {
  try {
    return realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url));
  } catch {
    return false;
  }
}
if (isMain()) {
  main();
}
