#!/usr/bin/env tsx
/**
 * collect-label-submissions — C2 Pass 3 workflow helper (Task A3).
 *
 * This is a WORKFLOW HELPER, NOT a label generator. It collects the two
 * independent 40-entry label submissions required by the C2 label-integrity
 * gate (Gold Label Owner + external QA), validates each one against the
 * frozen selection, and confirms they are ready to feed `computeLabelAgreement`.
 *
 * CRITICAL CONSTRAINT (spec-lock FLAG 7.1/7.3 + the curation plan):
 *   This script MUST REFUSE to synthesize a missing external QA submission.
 *   Independent labels must come from independent humans — the script never
 *   copies, fabricates, or auto-fills labels. If either submission file is
 *   missing or fails validation, the script exits non-zero with a clear
 *   instruction; it does NOT fall back to synthesizing labels from the other
 *   submission, the selection, or the corpus.
 *
 * Inputs (paths relative to repo root):
 *   --selection <path>           frozen selection artifact (default:
 *                                 eval/c2/label-integrity/selection.json)
 *   --gold <path>                Gold Label Owner submission JSON
 *   --qa <path>                  external QA submission JSON
 *   --baseline-metrics <path>    baseline-metrics artifact (optional — when
 *                                 supplied, validated for selection-hash
 *                                 consistency)
 *   --sole-operator-review       allow the SAME actorId for both submissions
 *                                 (the same human performs both passes). The
 *                                 distinct-ROLE check still fires. Off by default.
 *
 * Modes:
 *   default     validate both submissions + selection (+ baseline if given).
 *   --list      print the expected entry IDs from the selection (so the two
 *               labelers can independently confirm the 40 entries they must
 *               label).
 *
 * Exit codes:
 *   0  every submission parses and matches the selection (ready for agreement).
 *   1  a submission file is missing, fails schema validation, or does not
 *      match the selection. NEVER recovered by synthesizing labels.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  C2LabelIntegritySelectionSchema,
  C2IndependentLabelSubmissionSchema,
  C2LabelIntegrityBaselineMetricsSchema,
  assertSubmissionMatchesSelection,
} from "../c2/evaluation-contracts.js";

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface Args {
  selectionPath: string;
  goldPath: string;
  qaPath: string;
  baselineMetricsPath: string | null;
  list: boolean;
  soleOperatorReview: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    selectionPath: "eval/c2/label-integrity/selection.json",
    goldPath: "",
    qaPath: "",
    baselineMetricsPath: null,
    list: false,
    soleOperatorReview: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v === undefined) fail(`flag ${a} requires a value`);
      i += 1;
      return v;
    };
    switch (a) {
      case "--selection":
        args.selectionPath = next();
        break;
      case "--gold":
        args.goldPath = next();
        break;
      case "--qa":
        args.qaPath = next();
        break;
      case "--baseline-metrics":
        args.baselineMetricsPath = next();
        break;
      case "--list":
        args.list = true;
        break;
      case "--sole-operator-review":
        args.soleOperatorReview = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        fail(`unknown argument: ${a} (see --help)`);
    }
  }
  return args;
}

function printHelp(): void {
  console.error(`collect-label-submissions — collect + validate the two C2 independent label submissions.

This is a WORKFLOW HELPER. It does NOT generate labels. If a submission is
missing or invalid, the script fails — it never copies one submission into
the other or synthesizes labels from the corpus/selection.

Usage:
  collect-label-submissions.mts [flags]

Flags:
  --selection <path>           selection artifact (default: eval/c2/label-integrity/selection.json)
  --gold <path>                Gold Label Owner submission JSON (required unless --list)
  --qa <path>                  external QA submission JSON (required unless --list)
  --baseline-metrics <path>    optional baseline-metrics artifact to validate
  --list                       print the selection's entry IDs and exit
  --sole-operator-review       sole-operator review mode: allow the SAME actorId
                               for both submissions (the same human performs both
                               the Gold Label Owner and QA passes). The distinct-
                               ROLE check still fires. Use ONLY when a single
                               operator is reviewing both passes.
  -h, --help                   print this help

Exit codes:
  0  every submission parses and matches the selection (ready for agreement).
  1  a submission is missing or invalid; agreement is NOT synthesized.`);
}

function fail(message: string): never {
  console.error(`collect-label-submissions: ${message}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Distinct-actor / distinct-role cross-check (extracted for testing).
//
// `computeActorRoleErrors` is a PURE function: given the two parsed submissions
// and the sole-operator-review flag, it returns the list of structural errors
// (empty = OK). It never reads files, never exits. The same-actor check is
// skipped when `soleOperatorReview` is true; the distinct-ROLE check ALWAYS
// fires regardless of the flag. `checkDistinctActorAndRole` is the operational
// wrapper that converts a non-empty error list into a `fail` (process.exit 1).
// ---------------------------------------------------------------------------

/**
 * Structural shape of a parsed submission for the actor/role cross-check.
 * `--sole-operator-review` does NOT relax the role requirement: a sole
 * operator still submits one pass as "Gold Label Owner" and the other as "QA".
 */
type SubmissionLike = {
  actorId: string;
  reviewerRole: string;
};

export function computeActorRoleErrors(
  gold: SubmissionLike,
  qa: SubmissionLike,
  soleOperatorReview: boolean,
): string[] {
  const errors: string[] = [];
  if (!soleOperatorReview && gold.actorId === qa.actorId) {
    errors.push(
      `independent submissions must come from distinct actors: both carry actorId "${gold.actorId}". ` +
        `A missing external QA submission CANNOT be substituted with the Gold Label Owner's labels — ` +
        `collect a fresh independent QA submission and re-run, OR pass --sole-operator-review if the ` +
        `same human is performing both passes.`,
    );
  }
  if (gold.reviewerRole === qa.reviewerRole) {
    errors.push(
      `independent submissions must use distinct reviewer roles: both are "${gold.reviewerRole}". ` +
        `The Gold Label Owner submission must use role "Gold Label Owner" and the QA submission "QA".`,
    );
  }
  // Canonical role order: gold MUST be "Gold Label Owner" and qa MUST be "QA".
  // This is required for metric computation (precision/recall convention treats
  // gold as predicted and qa as reference). computeLabelAgreement enforces this
  // too, but surfacing it early gives the operator an actionable error before
  // the agreement reducer runs.
  if (gold.reviewerRole !== "Gold Label Owner") {
    errors.push(
      `the gold submission must use reviewerRole "Gold Label Owner", got "${gold.reviewerRole}".`,
    );
  }
  if (qa.reviewerRole !== "QA") {
    errors.push(
      `the qa submission must use reviewerRole "QA", got "${qa.reviewerRole}".`,
    );
  }
  return errors;
}

function checkDistinctActorAndRole(
  gold: SubmissionLike,
  qa: SubmissionLike,
  soleOperatorReview: boolean,
): void {
  const errors = computeActorRoleErrors(gold, qa, soleOperatorReview);
  if (errors.length > 0) fail(errors.join(" "));
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

function readJson<T>(label: string, path: string): T {
  const abs = resolve(REPO_ROOT, path);
  if (!existsSync(abs)) {
    fail(`${label} not found: ${path}`);
  }
  let bytes: Buffer;
  try {
    bytes = readFileSync(abs);
  } catch (err) {
    fail(`${label} could not be read (${path}): ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return JSON.parse(bytes.toString("utf8")) as T;
  } catch (err) {
    fail(`${label} is not valid JSON (${path}): ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // 1. Load + validate the selection.
  const selectionRaw = readJson<unknown>("selection", args.selectionPath);
  const selectionParsed = C2LabelIntegritySelectionSchema.safeParse(selectionRaw);
  if (!selectionParsed.success) {
    const issues = selectionParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    fail(`selection failed schema validation (${args.selectionPath}): ${issues}`);
  }
  const selection = selectionParsed.data;

  // 2. --list mode: print the 40 expected entry IDs so the two independent
  //    labelers can confirm the set they must label.
  if (args.list) {
    console.log(`collect-label-submissions: ${selection.entries.length} entries from ${selection.artifactId}`);
    for (const entry of selection.entries) {
      console.log(`  ${entry.cohort}\t${entry.entryId}\t${entry.stratum}`);
    }
    return;
  }

  // 3. Both submission paths must be supplied. A missing path is a hard error;
  //    we never synthesize labels from the selection or the other submission.
  if (!args.goldPath) fail("--gold <path> is required (the Gold Label Owner submission)");
  if (!args.qaPath) fail("--qa <path> is required (the external QA submission)");

  const goldRaw = readJson<unknown>("gold submission", args.goldPath);
  const qaRaw = readJson<unknown>("qa submission", args.qaPath);

  // 4. Parse both submissions through their schema. A parse failure is a hard
  //    error — we never copy one submission into the other or fabricate fields.
  const goldParsed = C2IndependentLabelSubmissionSchema.safeParse(goldRaw);
  const qaParsed = C2IndependentLabelSubmissionSchema.safeParse(qaRaw);
  if (!goldParsed.success) {
    const issues = goldParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    fail(`gold submission failed schema validation (${args.goldPath}): ${issues}`);
  }
  if (!qaParsed.success) {
    const issues = qaParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    fail(`qa submission failed schema validation (${args.qaPath}): ${issues}`);
  }
  const gold = goldParsed.data;
  const qa = qaParsed.data;

  // 5. Cross-check each submission against the selection. We pass the
  //    selection's recorded hash from the selection file itself; the agreement
  //    computation will later verify the hash against the canonical bytes.
  //    `assertSubmissionMatchesSelection` verifies entry IDs match exactly.
  try {
    assertSubmissionMatchesSelection(selection, gold);
    assertSubmissionMatchesSelection(selection, qa);
  } catch (err) {
    fail(`${err instanceof Error ? err.message : String(err)}`);
  }

  // 6. The two submissions must be from distinct actors in distinct roles.
  //    (computeLabelAgreement re-checks this; we surface it early here so the
  //    collection error message is operational rather than algorithmic.)
  //    In sole-operator-review mode (same human performs both passes) the
  //    distinct-ACTOR check is relaxed, but the distinct-ROLE check ALWAYS fires.
  checkDistinctActorAndRole(gold, qa, args.soleOperatorReview);
  if (gold.selectionSha256 !== qa.selectionSha256) {
    fail(
      `independent submissions must bind the SAME selection hash: gold.selectionSha256=${gold.selectionSha256} ` +
        `!= qa.selectionSha256=${qa.selectionSha256}. Both labelers must label against the same frozen selection.`,
    );
  }

  // 7. If a baseline-metrics artifact is supplied, validate it parses and binds
  //    the same selection hash. (computeLabelAgreement also enforces this; we
  //    surface it early.)
  if (args.baselineMetricsPath) {
    const baselineRaw = readJson<unknown>("baseline-metrics", args.baselineMetricsPath);
    const baselineParsed = C2LabelIntegrityBaselineMetricsSchema.safeParse(baselineRaw);
    if (!baselineParsed.success) {
      const issues = baselineParsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      fail(`baseline-metrics failed schema validation (${args.baselineMetricsPath}): ${issues}`);
    }
    const baseline = baselineParsed.data;
    if (baseline.selectionSha256 !== gold.selectionSha256) {
      fail(
        `baseline-metrics.selectionSha256 (${baseline.selectionSha256}) does not match the submissions' selectionSha256 (${gold.selectionSha256}). ` +
          `The baseline MUST be derived from the same selection revision.`,
      );
    }
    if (baseline.selectionArtifactId !== selection.artifactId) {
      fail(
        `baseline-metrics.selectionArtifactId (${baseline.selectionArtifactId}) does not match the selection artifactId (${selection.artifactId}).`,
      );
    }
  }

  // 8. Ready. Print a one-line readiness summary so the operator can confirm
  //    both submissions are present + distinct + selection-bound. In
  //    sole-operator-review mode, flag that the same human performed both
  //    passes (the agreement computation will record this on its report).
  const modeTag = args.soleOperatorReview ? " [SOLE-OPERATOR REVIEW]" : "";
  console.log(
    `collect-label-submissions: READY${modeTag} — gold actor ${gold.actorId} (${gold.labels.length} labels) + ` +
      `qa actor ${qa.actorId} (${qa.labels.length} labels), selection ${selection.artifactId}`,
  );
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
if (isMain) {
  main().catch((err) => {
    fail(err instanceof Error ? err.message : String(err));
  });
}
