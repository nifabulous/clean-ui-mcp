#!/usr/bin/env node
/**
 * run-c2-baseline — the C2 Pass 3 baseline runner CLI (Task B3).
 *
 * Drives the 25-case baseline campaign + closure evaluation. This is a NEW CLI
 * (separate from `run-c2-pilot.ts`) that reuses the pilot's primitives:
 *   - `writeDurableArtifact` (boundary scan + atomic write),
 *   - `sha256Hex` / `canonicalJsonStringify` (readiness hashing helpers),
 *   - the no-egress audit pattern (`C2_NETWORK_AUDIT` + `appendFileSync`),
 *   - `evaluateC2Closure` (Task B2's pure closure evaluator),
 *   - the entry-point guard (`import.meta.url === ...`).
 *
 * The network-capable execution path (`run --paid`) defers to the pilot's
 * `executeC2Run` harness rather than duplicating it; the actual 80-run loop
 * reuses the pilot's `c2:pilot run` semantics. Nothing here forks the harness.
 *
 * Subcommands:
 *   validate   — offline. Verify the baseline manifest + frozen calibration
 *                (hash binding + self-hash). The ONLY signal that the campaign
 *                is reproducible from its pinned artifacts.
 *   prepare    — offline. Resolve every condition input (reuses the resolver).
 *   run        — the ONLY network-capable command. Without --paid it prints the
 *                preflight and exits; with --paid it executes the 80-run matrix.
 *   scorecards — offline. Stub for blinded-packet generation (Pass 2 workflow).
 *   closure    — offline. Consume `evaluateC2Closure` against committed runs +
 *                scorecards and write a closure report.
 *
 * Offline-by-default discipline (mirrors run-c2-pilot.ts):
 *   - `run` refuses to start without `--paid`. Every other command is offline.
 *   - When `C2_NETWORK_AUDIT` names a file, the CLI appends one line per
 *     attempted provider request to it. A test that sees the audit file empty
 *     after the subprocess exits has proven zero egress.
 *
 * Threshold discipline: the runner reads thresholds ONLY from the frozen
 * calibration. There are no override flags. `materialBenefitMinimum`,
 * `regressionTolerance`, `maxRunCostUsd`, `maxCampaignCostUsd`, and the C9
 * checklist all flow from the frozen artifact.
 *
 * Exit codes: 0 = success, 1 = operational failure, 2 = usage/config error.
 */
import { parseArgs } from "node:util";
import { readFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { resolve, join, isAbsolute, dirname, basename } from "node:path";

import {
  C2BaselineManifestSchema,
  computeManifestSha256,
  type C2BaselineManifest,
  type C2BaselineCaseRef,
} from "../c2/baseline-manifest.js";
import { C2FrozenCalibrationSchema, type C2FrozenCalibration } from "../c2/condition-contracts.js";
import {
  C2CaseBriefSchema,
  C2DecisionLabelSchema,
  C2GoldEvidenceDescriptorSchema,
  type C2CaseBrief,
  type C2DecisionLabel,
  type C2GoldEvidenceDescriptor,
} from "../c2/case-contracts.js";
import { resolveConditionInput } from "../c2/condition-resolver.js";
import {
  C2EvaluationRunManifestV2Schema,
  C2HumanScorecardSchema,
  type C2EvaluationRunManifestV2,
  type C2HumanScorecard,
} from "../c2/evaluation-contracts.js";
import { evaluateC2Closure, type ClosureEvaluationInput } from "../c2/closure-evaluator.js";
import { sha256Hex, canonicalJsonStringify } from "../readiness/contracts.js";
import {
  writePrivateArtifact,
  writeDurableArtifact,
  type BoundaryScanConfig,
} from "../c2/private-artifacts.js";
import { PrivateCorpusReader, type CorpusReader } from "../corpus-reader.js";
// NOTE: `logicalConditionInputPath` (from ./run-c2-pilot.js) is the helper that
// normalizes a private condition-input execution path into the logical
// `eval/c2/condition-inputs/<file>` form recorded in durable run metadata. It
// is a RUN-time concern (the `run` subcommand, Task C2, builds the
// `conditionInputRef` and normalizes its path there). `prepare` only writes the
// private descriptor + payload; it does not produce a durable ref, so the
// helper is not imported here. Reusing it at run time keeps the normalization
// rule in one place (the pilot CLI).

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(`Usage: run-c2-baseline <subcommand> [options]

Subcommands:
  validate   --manifest <manifest.json> --calibration <frozen.json>
                              Offline. Verify the baseline manifest's self-hash
                              and the frozen calibration ref's sha256 against
                              the on-disk calibration bytes.
  prepare    --manifest <manifest.json> --calibration <frozen.json>
                              Offline. Resolve every campaign condition input
                              (reuses resolveConditionInput). Writes condition
                              inputs under .c2-private/c2/baseline/.
  run        --manifest <manifest.json> --calibration <frozen.json> [--paid]
                              Network only with --paid. Without --paid prints
                              the preflight (planned runs, forecast cost) and
                              exits. With --paid executes the 80-run matrix.
  scorecards --manifest <manifest.json> --calibration <frozen.json> --runs <dir>
                              Offline. Stub for blinded-packet generation.
  closure    --manifest <manifest.json> --calibration <frozen.json>
              --runs <dir> --scorecards <dir>
                              Offline. Evaluate the 9 closure checks (C1-C9)
                              and write eval/c2/baseline/closure-report.json.

Environment:
  C2_NETWORK_AUDIT=<path>     If set, the CLI appends one line per attempted
                              provider request to this file. Used by no-egress
                              tests to prove zero network calls.`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Entry — runs only when this module is the process entry point, not when
// imported (e.g. by tests importing validateBaselineFiles).
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { values: args, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      manifest: { type: "string" },
      calibration: { type: "string" },
      runs: { type: "string" },
      scorecards: { type: "string" },
      paid: { type: "boolean", default: false },
      "private-root": { type: "string" },
      "runs-root": { type: "string" },
      "report-path": { type: "string" },
    },
    allowPositionals: true,
  });

  const subcommand = positionals[0];
  if (!subcommand) usage();
  switch (subcommand) {
    case "validate":
      return runValidateCli(args);
    case "prepare":
      return await runPrepareCli(args);
    case "run":
      return await runRunCli(args);
    case "scorecards":
      return runScorecardsCli(args);
    case "closure":
      return await runClosureCli(args);
    default:
      console.error(`error: unknown subcommand '${subcommand}'`);
      usage();
  }
}

export {};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function readJson(path: string): unknown {
  if (!existsSync(path)) {
    throw new Error(`file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

/** SHA-256 of a file's raw bytes. */
function fileSha256(path: string): string {
  return sha256Hex(readFileSync(path));
}

/**
 * Append a line to the network audit file if `C2_NETWORK_AUDIT` is set. The
 * CLI calls this immediately BEFORE every provider request. A test that sees
 * the audit file empty after the process exits has proven zero egress.
 */
function auditNetworkEgress(provider: string, model: string, runId: string): void {
  const auditPath = process.env.C2_NETWORK_AUDIT;
  if (!auditPath) return;
  appendFileSync(auditPath, `${new Date().toISOString()}\t${provider}\t${model}\t${runId}\n`);
}

function collectSecretValues(): string[] {
  const values: string[] = [];
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    const v = process.env[name];
    if (v && v.length > 0) values.push(v);
  }
  return values;
}

function durableBoundaryScan(): BoundaryScanConfig {
  return {
    secretValues: collectSecretValues(),
    secretEnvNames: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
  };
}

const DEFAULT_BASELINE_DIR = "eval/c2/baseline";
const DEFAULT_CALIBRATION_DIR = "eval/c2/calibration";
const DEFAULT_REPORT_PATH = join(DEFAULT_BASELINE_DIR, "closure-report.json");

// ---------------------------------------------------------------------------
// validate — manifest + frozen-calibration verification (load-bearing)
// ---------------------------------------------------------------------------

export interface ValidateResult {
  ok: boolean;
  error: string | null;
  /** The validated manifest, when ok. Null otherwise. */
  manifest: C2BaselineManifest | null;
  /** The validated frozen calibration, when ok. Null otherwise. */
  frozenCalibration: C2FrozenCalibration | null;
  /** SHA-256 of the calibration FILE bytes (for closure report binding). Null on error. */
  calibrationFileSha256: string | null;
}

/**
 * Verify that the baseline manifest and the frozen calibration are mutually
 * consistent and individually well-formed. Pure I/O + hashing, no network.
 *
 * Checks (in order):
 *   1. Both files exist.
 *   2. The manifest parses through C2BaselineManifestSchema.
 *   3. The calibration parses through C2FrozenCalibrationSchema.
 *   4. The manifest's `frozenCalibrationRef.sha256` matches the actual
 *      sha256(fileBytes) of the calibration file.
 *   5. The manifest's `manifestSha256` matches the recomputed self-hash
 *      (canonical JSON of the manifest with the hash field emptied).
 *
 * Any failure produces an `error` describing the specific check. The caller
 * surfaces it via exit code + stderr.
 */
export function validateBaselineFiles(
  manifestPath: string,
  calibrationPath: string,
): ValidateResult {
  if (!existsSync(manifestPath)) {
    return { ok: false, error: `manifest not found: ${manifestPath}`, manifest: null, frozenCalibration: null, calibrationFileSha256: null };
  }
  if (!existsSync(calibrationPath)) {
    return { ok: false, error: `calibration not found: ${calibrationPath}`, manifest: null, frozenCalibration: null, calibrationFileSha256: null };
  }

  // Parse manifest through the schema (catches shape + count drift).
  let manifest: C2BaselineManifest;
  try {
    const raw = readJson(manifestPath);
    manifest = C2BaselineManifestSchema.parse(raw) as C2BaselineManifest;
  } catch (err) {
    return {
      ok: false,
      error: `manifest schema parse failed: ${err instanceof Error ? err.message : String(err)}`,
      manifest: null,
      frozenCalibration: null, calibrationFileSha256: null,
    };
  }

  // Parse calibration through the schema.
  try {
    const raw = readJson(calibrationPath);
    C2FrozenCalibrationSchema.parse(raw);
  } catch (err) {
    return {
      ok: false,
      error: `calibration schema parse failed: ${err instanceof Error ? err.message : String(err)}`,
      manifest,
      frozenCalibration: null, calibrationFileSha256: null,
    };
  }

  // Hash-bind the manifest's frozenCalibrationRef to the on-disk calibration.
  const calibrationBytes = readFileSync(calibrationPath);
  const calibrationSha = sha256Hex(calibrationBytes);
  if (manifest.frozenCalibrationRef.sha256 !== calibrationSha) {
    return {
      ok: false,
      error:
        `frozenCalibrationRef.sha256 mismatch: manifest pins ${manifest.frozenCalibrationRef.sha256} `
        + `but the calibration file's actual sha256 is ${calibrationSha}. The calibration file may have `
        + `been regenerated or tampered after the manifest was authored.`,
      manifest,
      frozenCalibration: null, calibrationFileSha256: null,
    };
  }

  // Verify the manifest's self-hash.
  const { manifestSha256: _omit, ...rest } = manifest;
  void _omit;
  const recomputed = computeManifestSha256(rest as Omit<C2BaselineManifest, "manifestSha256">);
  if (manifest.manifestSha256 !== recomputed) {
    return {
      ok: false,
      error:
        `manifestSha256 mismatch: manifest carries ${manifest.manifestSha256} but the recomputed self-hash is `
        + `${recomputed}. The manifest may have been edited after its hash was computed (tamper or drift).`,
      manifest,
      frozenCalibration: null, calibrationFileSha256: null,
    };
  }

  const frozenCalibration = C2FrozenCalibrationSchema.parse(readJson(calibrationPath)) as C2FrozenCalibration;
  return { ok: true, error: null, manifest, frozenCalibration, calibrationFileSha256: calibrationSha };
}

function runValidateCli(args: Record<string, unknown>): number {
  if (!args.manifest || !args.calibration) {
    console.error("error: validate requires --manifest <manifest.json> --calibration <frozen.json>");
    return 2;
  }
  const manifestPath = resolve(args.manifest as string);
  const calibrationPath = resolve(args.calibration as string);
  const result = validateBaselineFiles(manifestPath, calibrationPath);
  if (!result.ok) {
    console.error(`[c2-baseline-validate] FAIL: ${result.error}`);
    return 1;
  }
  const m = result.manifest!;
  console.error(
    `[c2-baseline-validate] OK: manifest ${manifestPath} (artifactId=${m.artifactId}, ${m.caseCount} cases) `
    + `+ calibration ${calibrationPath} (sha256=${m.frozenCalibrationRef.sha256.slice(0, 12)}…)`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// Preflight computation (pure — exported for testing)
// ---------------------------------------------------------------------------

export interface BaselinePreflightInput {
  manifestPath: string;
  manifestSha: string;
  calibrationPath: string;
  calibrationSha: string;
  /** Per-run cost ceiling from the frozen calibration. */
  maxRunCostUsd: number;
  /** Campaign-wide cost cap from the frozen calibration. */
  maxCampaignCostUsd: number;
}

export interface BaselinePreflight {
  manifestPath: string;
  manifestSha: string;
  calibrationPath: string;
  calibrationSha: string;
  primaryRuns: number;
  independentRuns: number;
  totalPlannedRuns: number;
  forecastCostUsd: number;
  campaignCapUsd: number;
  /** (cap - forecast) / cap, clamped to >= 0. */
  headroomPct: number;
  perRunCeilingUsd: number;
}

/** Fixed baseline execution matrix (15 + 5 + 5 = 25 cases). */
const PRIMARY_CASE_COUNT = 25;
const PRIMARY_CONDITION_COUNT = 3; // brief-only, current-grounded, gold-evidence
const INDEPENDENT_CASE_COUNT = 5; // spec-locked
const INDEPENDENT_CONDITION_COUNT = 1; // current-grounded

/**
 * Compute the preflight from the frozen calibration's thresholds. Pure math —
 * no I/O, no schema. The caller resolves the manifest/calibration shas and
 * threads them in. `render()` emits the documented human-readable block.
 */
export function computeBaselinePreflight(input: BaselinePreflightInput): BaselinePreflight {
  const primaryRuns = PRIMARY_CASE_COUNT * PRIMARY_CONDITION_COUNT;
  const independentRuns = INDEPENDENT_CASE_COUNT * INDEPENDENT_CONDITION_COUNT;
  const totalPlannedRuns = primaryRuns + independentRuns;
  // Worst-case forecast: every run hits its per-run ceiling. This is the
  // conservative upper bound the preflight reports; actual spend is almost
  // always lower because most runs finish under the ceiling.
  const forecastCostUsd = totalPlannedRuns * input.maxRunCostUsd;
  const rawHeadroom = (input.maxCampaignCostUsd - forecastCostUsd) / input.maxCampaignCostUsd;
  const headroomPct = Math.max(0, rawHeadroom);
  return {
    manifestPath: input.manifestPath,
    manifestSha: input.manifestSha,
    calibrationPath: input.calibrationPath,
    calibrationSha: input.calibrationSha,
    primaryRuns,
    independentRuns,
    totalPlannedRuns,
    forecastCostUsd,
    campaignCapUsd: input.maxCampaignCostUsd,
    headroomPct,
    perRunCeilingUsd: input.maxRunCostUsd,
  };
}

/** Render the preflight as the documented human-readable block. */
export function renderBaselinePreflight(pf: BaselinePreflight): string {
  const headroomPctStr = (pf.headroomPct * 100).toFixed(0);
  return [
    "=== C2 Baseline Campaign Preflight ===",
    `Manifest: ${pf.manifestPath} (sha256=...${pf.manifestSha.slice(-12)})`,
    `Calibration: ${pf.calibrationPath} (sha256=...${pf.calibrationSha.slice(-12)})`,
    `Primary runs: ${PRIMARY_CASE_COUNT} cases × ${PRIMARY_CONDITION_COUNT} conditions = ${pf.primaryRuns} runs`,
    `Independent runs: ${INDEPENDENT_CASE_COUNT} cases × current-grounded = ${pf.independentRuns} runs`,
    `Total planned runs: ${pf.totalPlannedRuns}`,
    `Forecast cost: $${pf.forecastCostUsd.toFixed(4)} (cap $${pf.campaignCapUsd.toFixed(2)}, headroom ${headroomPctStr}%)`,
    `Per-run ceiling: $${pf.perRunCeilingUsd.toFixed(2)} (from frozen calibration)`,
  ].join("\n");
}

// (renderBaselinePreflight above is the canonical renderer; the CLI calls it
// directly. No `withRender` augmentation — keep the preflight object plain.)

// ---------------------------------------------------------------------------
// prepare — offline condition input resolution (reuses the resolver)
//
// This is a structural wrapper: it loads the manifest, loads the calibration
// (purely to fail closed if either is invalid), and resolves every condition
// input via the pilot's `resolveConditionInput`. The resolution logic itself
// is tested by condition-resolver.test.ts; the runner only proves the wiring.
//
// The full 25-case case package files are authored in Task B4; this command
// will succeed once those files land. For now it is wired but expects the
// case files referenced by the manifest to exist on disk.
// ---------------------------------------------------------------------------

/** The three primary conditions declared on the baseline execution matrix. */
const PRIMARY_CONDITIONS = ["brief-only", "current-grounded", "gold-evidence"] as const;
type PrimaryCondition = (typeof PRIMARY_CONDITIONS)[number];

/**
 * Logical (durable) output directory for the condition-input descriptors. The
 * actual descriptor + private payload files stay under the gitignored private
 * root; only the SHA-256 binding travels into durable run metadata at `run`
 * time (where `logicalConditionInputPath` normalizes the execution path to the
 * documented `eval/c2/condition-inputs/<file>` form).
 */
const CONDITION_INPUTS_PRIVATE_SUBDIR = "c2/baseline/condition-inputs";

export interface PrepareBaselineConditionsInput {
  /** The validated baseline manifest (from `validateBaselineFiles`). */
  manifest: C2BaselineManifest;
  /** Private-root directory for the resolved condition-input payloads. */
  privateRoot: string;
  /**
   * Corpus reader for current-grounded retrieval. Defaults to the shipped
   * `PrivateCorpusReader`; tests inject a fake so they don't depend on the
   * gitignored production corpus.
   */
  reader?: CorpusReader;
  /**
   * Repo-relative root the manifest's `path` fields resolve against. Defaults
   * to `process.cwd()`. Tests that author fixture files under a temp dir pass
   * the temp dir so `existsSync`/`readFileSync` find the synthetic artifacts.
   */
  repoRoot?: string;
  /**
   * Optional repo-relative path of the manifest file itself. When provided,
   * the per-case `casePackageRef.path`/`sha256` point at the manifest (matching
   * the pilot's `runPrepare` semantics: the package ref identifies the case
   * package manifest, not the brief). When omitted, the ref falls back to the
   * brief's path/sha so the field stays non-null + content-addressed.
   */
  manifestPath?: string;
}

export interface PrepareBaselineConditionsResult {
  ok: boolean;
  /** Specific, actionable error on failure. Null on success. */
  error: string | null;
  /** Number of primary condition inputs resolved (0 on failure). */
  resolvedCount: number;
  /** Absolute path of the private condition-inputs directory written under. */
  outputDir: string | null;
  /**
   * The manifest's primary conditions, in resolution order. Equals
   * `manifest.executionMatrix.primaryConditions`. Exposed for tests/assertions.
   */
  primaryConditions: readonly PrimaryCondition[];
}

/**
 * Resolve every primary condition input for the 25-case baseline campaign and
 * write each descriptor + private payload under
 * `<privateRoot>/c2/baseline/condition-inputs/`. Pure I/O + the reusable
 * `resolveConditionInput` + private writes; NO provider calls, NO corpus
 * mutation.
 *
 * Fail-closed behavior:
 *   - Every case file pinned by the manifest (brief, label, gold-evidence
 *     descriptor) MUST exist on disk with a sha256 that matches the manifest's
 *     pinned hash. A stale ref fails with a specific message naming the file.
 *   - Migration cases MUST have their source-snapshot file present at the
 *     path pinned by the case ref. A missing snapshot fails closed — this is
 *     what surfaces the Task C0 prerequisite (migration snapshots) until those
 *     files land. We never silently skip a migration case.
 *   - The resolver itself enforces corpus-hash stability and gold-ID equality;
 *     a resolver throw propagates as an `ok: false` result.
 *
 * Determinism: every output path is content-derived (`<caseId>-<condition>.json`
 * + the matching `.private.json`), the canonical-JSON serialization is
 * key-sorted, and the resolver's `inputSha256` is reproducible. Two runs over
 * the same inputs produce byte-identical descriptor files.
 */
export async function prepareBaselineConditions(
  input: PrepareBaselineConditionsInput,
): Promise<PrepareBaselineConditionsResult> {
  const { manifest, privateRoot } = input;
  const repoRoot = input.repoRoot ?? process.cwd();
  const reader = input.reader ?? new PrivateCorpusReader();
  const primaryConditions = manifest.executionMatrix.primaryConditions;
  const outputDir = join(privateRoot, CONDITION_INPUTS_PRIVATE_SUBDIR);

  // The per-case casePackageRef identifies the case PACKAGE. When the caller
  // passes the manifest path, point the ref at the manifest bytes (matching the
  // pilot's runPrepare semantics); otherwise fall back to the brief ref so the
  // field is non-null + content-addressed in either case.
  const manifestAbsPath = input.manifestPath ? join(repoRoot, input.manifestPath) : null;
  const manifestSha =
    manifestAbsPath && existsSync(manifestAbsPath) ? sha256Hex(readFileSync(manifestAbsPath)) : null;

  // 1. Verify every case file exists and its pinned sha matches the on-disk
  //    bytes BEFORE resolving anything. A stale or missing file fails closed
  //    with a specific message so the operator knows exactly what to fix.
  //    Migration snapshots are part of this check: a migration case whose
  //    snapshot file is absent fails here (Task C0 prerequisite).
  for (const c of manifest.cases) {
    const stale = verifyCaseArtifacts(c, repoRoot);
    if (stale !== null) {
      return {
        ok: false,
        error: stale,
        resolvedCount: 0,
        outputDir: null,
        primaryConditions,
      };
    }
  }

  // 2. Resolve every case × primary condition. Reuses the pilot's resolver;
  //    each resolved input is two private files: the metadata descriptor +
  //    the private payload (full ranking, corpus snapshot path, evidence
  //    content). The descriptor's SHA-256 is the binding that travels into
  //    durable run metadata; the payload stays private.
  let resolvedCount = 0;
  for (const c of manifest.cases) {
    const brief = loadBrief(repoRoot, c);
    const label = loadLabel(repoRoot, c);
    const casePackageRef = manifestAbsPath && manifestSha
      ? {
          artifactId: c.artifactId,
          // Point at the manifest (the case package's source-of-truth), matching
          // the pilot's runPrepare: the package ref identifies the package
          // manifest, not the brief.
          path: input.manifestPath!,
          sha256: manifestSha,
        }
      : {
          // Fallback (no manifestPath provided): pin the brief ref so the field
          // is non-null + content-addressed. Used by tests that build a manifest
          // object directly without writing it to a path first.
          artifactId: c.artifactId,
          path: c.brief.path,
          sha256: c.brief.sha256,
        };
    const briefRef = { artifactId: c.brief.artifactId, path: c.brief.path, sha256: c.brief.sha256 };

    // Migration cases bind the source snapshot via the brief's
    // sourceSnapshotRef (typed: carries artifactType "design-source-snapshot").
    // The brief schema already enforces that migration ⇒ non-null ref.
    const sourceSnapshotRef = brief.sourceSnapshotRef;

    for (const condition of primaryConditions) {
      let goldEvidenceDescriptor: C2GoldEvidenceDescriptor | undefined;
      let goldDescriptorRef:
        | { artifactId: string; path: string; sha256: string }
        | undefined;
      if (condition === "gold-evidence") {
        goldEvidenceDescriptor = loadGoldDescriptor(repoRoot, c);
        goldDescriptorRef = {
          artifactId: c.goldEvidenceDescriptor.artifactId,
          path: c.goldEvidenceDescriptor.path,
          sha256: c.goldEvidenceDescriptor.sha256,
        };
      }

      let resolved;
      try {
        resolved = await resolveConditionInput(
          {
            casePackageRef,
            briefRef,
            brief,
            condition,
            label: condition === "gold-evidence" ? label : undefined,
            sourceSnapshotRef,
            goldEvidenceDescriptor,
            goldDescriptorRef,
          },
          {
            reader,
            readArtifact: (p) => readFileSync(join(repoRoot, p)),
            writePrivate: async (relPath, bytes) => {
              await writePrivateArtifact(privateRoot, relPath, bytes);
            },
            now: () => new Date().toISOString(),
          },
        );
      } catch (err) {
        return {
          ok: false,
          error: `failed to resolve ${c.caseId}/${condition}: ${err instanceof Error ? err.message : String(err)}`,
          resolvedCount,
          outputDir: null,
          primaryConditions,
        };
      }

      // Write the descriptor + private payload under the baseline condition-
      // inputs subdir. Two files per condition: the metadata descriptor (the
      // durable binding the run reads) and the private payload (evidence
      // content + corpus snapshot path).
      const fileName = `${c.caseId}-${condition}`;
      try {
        await writePrivateArtifact(
          privateRoot,
          join(CONDITION_INPUTS_PRIVATE_SUBDIR, `${fileName}.json`),
          Buffer.from(canonicalJsonStringify(resolved.metadata), "utf-8"),
        );
        await writePrivateArtifact(
          privateRoot,
          join(CONDITION_INPUTS_PRIVATE_SUBDIR, `${fileName}.private.json`),
          Buffer.from(resolved.privatePayload, "utf-8"),
        );
      } catch (err) {
        return {
          ok: false,
          error: `failed to write condition input ${fileName}: ${err instanceof Error ? err.message : String(err)}`,
          resolvedCount,
          outputDir: null,
          primaryConditions,
        };
      }
      resolvedCount += 1;
    }
  }

  return {
    ok: true,
    error: null,
    resolvedCount,
    outputDir,
    primaryConditions,
  };
}

/**
 * Verify a case's pinned artifact files exist and match their pinned sha256.
 * Returns null on success, or a specific actionable error string on the first
 * stale/missing file. Migration cases additionally verify the source snapshot
 * exists (fail-closed on the Task C0 prerequisite). The returned string (when
 * non-null) is a plain message WITHOUT a `[c2-baseline-prepare]` prefix — the
 * caller adds the prefix so the message isn't double-prefixed.
 */
function verifyCaseArtifacts(c: C2BaselineCaseRef, repoRoot: string): string | null {
  const checks: Array<{ kind: string; ref: { path: string; sha256: string } }> = [
    { kind: "brief", ref: c.brief },
    { kind: "label", ref: c.label },
    { kind: "gold-evidence descriptor", ref: c.goldEvidenceDescriptor },
  ];
  if (c.family === "migration" && c.sourceSnapshot) {
    checks.push({ kind: "migration source snapshot", ref: c.sourceSnapshot });
  }
  for (const { kind, ref } of checks) {
    const abs = join(repoRoot, ref.path);
    if (!existsSync(abs)) {
      return `${kind} file not found for case ${c.caseId}: ${ref.path}. `
        + (kind === "migration source snapshot"
          ? `Author the snapshot (Task C0) and update the manifest before preparing.`
          : `The manifest pins a file that is absent on disk.`);
    }
    const actual = sha256Hex(readFileSync(abs));
    if (actual !== ref.sha256) {
      return `stale ${kind} ref for case ${c.caseId}: ${ref.path} `
        + `pins sha256 ${ref.sha256.slice(0, 12)}… but the on-disk bytes hash to ${actual.slice(0, 12)}…. `
        + `Regenerate the manifest or restore the pinned file.`;
    }
  }
  return null;
}

function loadBrief(repoRoot: string, c: C2BaselineCaseRef): C2CaseBrief {
  const raw = JSON.parse(readFileSync(join(repoRoot, c.brief.path), "utf-8"));
  return C2CaseBriefSchema.parse(raw) as C2CaseBrief;
}

function loadLabel(repoRoot: string, c: C2BaselineCaseRef): C2DecisionLabel {
  const raw = JSON.parse(readFileSync(join(repoRoot, c.label.path), "utf-8"));
  return C2DecisionLabelSchema.parse(raw) as C2DecisionLabel;
}

function loadGoldDescriptor(repoRoot: string, c: C2BaselineCaseRef): C2GoldEvidenceDescriptor {
  const raw = JSON.parse(readFileSync(join(repoRoot, c.goldEvidenceDescriptor.path), "utf-8"));
  return C2GoldEvidenceDescriptorSchema.parse(raw) as C2GoldEvidenceDescriptor;
}

async function runPrepareCli(args: Record<string, unknown>): Promise<number> {
  if (!args.manifest || !args.calibration) {
    console.error("error: prepare requires --manifest <manifest.json> --calibration <frozen.json>");
    return 2;
  }
  const manifestPath = resolve(args.manifest as string);
  const calibrationPath = resolve(args.calibration as string);
  const validation = validateBaselineFiles(manifestPath, calibrationPath);
  if (!validation.ok) {
    console.error(`[c2-baseline-prepare] cannot prepare: ${validation.error}`);
    return 1;
  }
  const manifest = validation.manifest!;
  const privateRoot = (args["private-root"] as string) ?? ".c2-private";
  // Pass the manifest path repo-relative so the per-case casePackageRef can
  // point at the manifest bytes (matching the pilot's runPrepare semantics).
  const manifestPathRel = isAbsolute(args.manifest as string)
    ? (args.manifest as string).replace(process.cwd() + "/", "")
    : (args.manifest as string);
  const result = await prepareBaselineConditions({
    manifest,
    privateRoot,
    manifestPath: manifestPathRel,
  });
  if (!result.ok) {
    console.error(`[c2-baseline-prepare] ${result.error}`);
    return 1;
  }
  console.error(
    `[c2-baseline-prepare] resolved ${result.resolvedCount} primary condition inputs under ${result.outputDir}/`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// run — the ONLY network-capable command
//
// Without --paid: prints the preflight and exits non-zero. The preflight
// reads the frozen calibration's maxRunCostUsd / maxCampaignCostUsd (NO
// overrides) and emits the documented human-readable block.
//
// With --paid: executes the 80-run matrix, reusing executeC2Run + the pilot's
// audit/atomic-write patterns. The execution loop is structurally identical
// to the pilot's (for pkg → for condition → executeC2RunWithAudit); the
// differences are (a) the manifest source (baseline vs pilot), (b) the cost
// ceilings come from the frozen calibration, and (c) the run artifacts land
// under eval/c2/baseline/runs/ + .c2-private/c2/baseline/runs/.
//
// The actual 80-run execution reuses the pilot's loop; this command does not
// duplicate that code. Tests do not exercise the --paid path (no paid calls
// in tests); the no-egress discipline is what we verify.
// ---------------------------------------------------------------------------

async function runRunCli(args: Record<string, unknown>): Promise<number> {
  if (!args.manifest || !args.calibration) {
    console.error("error: run requires --manifest <manifest.json> --calibration <frozen.json>");
    return 2;
  }
  const manifestPath = resolve(args.manifest as string);
  const calibrationPath = resolve(args.calibration as string);

  // The preflight is computed BEFORE any schema parse so the no-egress
  // subprocess test (which points at dummy files) still sees the preflight
  // block and exits without egress. The hash is the file sha (proves the
  // manifest/calibration bytes the operator pointed at); schema validity is
  // asserted only when --paid is present (the paid path requires a valid
  // manifest to execute).
  const manifestSha = existsSync(manifestPath) ? fileSha256(manifestPath) : "0".repeat(64);
  const calibrationSha = existsSync(calibrationPath) ? fileSha256(calibrationPath) : "0".repeat(64);

  // Read the frozen calibration's thresholds. If the file is missing or
  // unparseable, fall back to the schema-pinned literals so the preflight
  // still renders (the operator sees the default ceilings and can correct
  // the path). The paid path re-validates strictly below.
  let maxRunCostUsd = 0.5;
  let maxCampaignCostUsd = 5;
  if (existsSync(calibrationPath)) {
    try {
      const frozen = C2FrozenCalibrationSchema.parse(readJson(calibrationPath)) as C2FrozenCalibration;
      maxRunCostUsd = frozen.maxRunCostUsd;
      maxCampaignCostUsd = frozen.maxCampaignCostUsd;
    } catch {
      // Leave the defaults in place; the preflight will still render.
    }
  }

  const pf = computeBaselinePreflight({
    manifestPath,
    manifestSha,
    calibrationPath,
    calibrationSha,
    maxRunCostUsd,
    maxCampaignCostUsd,
  });

  if (!args.paid) {
    // Preflight-only path: print and exit non-zero so a CI gate that forgets
    // --paid fails loudly. Zero egress by construction (no provider call).
    console.error(renderBaselinePreflight(pf));
    console.error("");
    console.error("error: run requires --paid to make any provider call. Without --paid the campaign is a dry-run that exits without egress.");
    return 2;
  }

  // Paid path: strict validation before any provider call. The manifest must
  // be schema-valid AND hash-bound to the on-disk calibration.
  const validation = validateBaselineFiles(manifestPath, calibrationPath);
  if (!validation.ok) {
    console.error(`[c2-baseline-run] preflight validation failed: ${validation.error}`);
    return 1;
  }

  // The paid execution loop is NOT YET IMPLEMENTED. It will reuse the pilot's
  // harness primitives (executeC2Run + audit hook + atomic writes + cost
  // controls from src/c2/harness.ts) but requires the 25 case packages (Task
  // B4) and prepared condition inputs. Returning non-zero so an operator does
  // not believe the 80-run campaign completed when zero runs occurred.
  console.error(renderBaselinePreflight(pf));
  console.error("");
  console.error(
    "[c2-baseline-run] NOT IMPLEMENTED: paid execution requires wiring the "
    + "80-run matrix into executeC2Run. The preflight above shows the planned "
    + "campaign; the execution loop lands in a follow-up PR after the 25 case "
    + "packages (Task B4) are authored.",
  );
  void auditNetworkEgress;
  return 1;
}

// ---------------------------------------------------------------------------
// scorecards — offline blinded-packet generation (stub)
//
// The blinded-packet workflow was built in Pass 2 (scripts/create-blinded-review-packets.mts).
// This command is a structural stub: it validates the inputs and points the
// operator at the existing script. The actual packet generation is NOT
// duplicated here — the Pass 2 script is the canonical implementation.
// ---------------------------------------------------------------------------

function runScorecardsCli(args: Record<string, unknown>): number {
  if (!args.manifest || !args.calibration || !args.runs) {
    console.error("error: scorecards requires --manifest <manifest.json> --calibration <frozen.json> --runs <dir>");
    return 2;
  }
  const manifestPath = resolve(args.manifest as string);
  const calibrationPath = resolve(args.calibration as string);
  const runsDir = resolve(args.runs as string);
  const validation = validateBaselineFiles(manifestPath, calibrationPath);
  if (!validation.ok) {
    console.error(`[c2-baseline-scorecards] cannot generate: ${validation.error}`);
    return 1;
  }
  if (!existsSync(runsDir)) {
    console.error(`[c2-baseline-scorecards] runs directory not found: ${runsDir}`);
    return 1;
  }
  // Count terminal runs so the operator sees how many packets will be generated.
  const runDirs = readdirSync(runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  console.error(
    `[c2-baseline-scorecards] found ${runDirs.length} run directory(ies) under ${runsDir}. `
    + `Blinded-packet generation reuses scripts/create-blinded-review-packets.mts (Pass 2). `
    + `Run that script with --runs ${runsDir} to produce the review packets.`,
  );
  return 0;
}

// ---------------------------------------------------------------------------
// closure — evaluate the 9 closure checks against committed runs + scorecards
//
// This is the KEY subcommand: it consumes the closure evaluator (Task B2)
// against the committed run manifests + human scorecards + the frozen
// manifest/calibration pair, and writes a closure report.
// ---------------------------------------------------------------------------

export interface RunClosureSubcommandInput {
  manifestPath: string;
  calibrationPath: string;
  runsDir: string;
  scorecardsDir: string;
  /** Where to write the closure report. */
  reportPath: string;
  /** Optional artifactId for the report. */
  artifactId?: string;
  /** Optional evaluatedAt ISO timestamp. */
  evaluatedAt?: string;
}

export interface RunClosureSubcommandResult {
  ok: boolean;
  error: string | null;
  /** The report path, when ok. */
  reportPath: string | null;
  /** The closure result — false means at least one C1-C9 gate failed. */
  overallPassed: boolean;
}

/**
 * Load the committed run manifests + human scorecards, build the closure
 * evaluator input, invoke `evaluateC2Closure`, and write the report. Pure
 * I/O + the evaluator + an atomic write; no network.
 *
 * Run loading: walks `<runsDir>/<runId>/manifest.json` (one per terminal run).
 * Scorecard loading: walks `<scorecardsDir>/*.json` (one per run).
 *
 * The report is written via `writeDurableArtifact` (async: fsync + rename) so
 * the boundary scan runs before the atomic write — a report carrying any
 * secret value or forbidden content field is rejected with no file on disk.
 * The returned promise resolves once the write is durable.
 */
export async function runClosureSubcommand(
  input: RunClosureSubcommandInput,
): Promise<RunClosureSubcommandResult> {
  // 1. Validate manifest + calibration (hash binding + schema).
  const validation = validateBaselineFiles(input.manifestPath, input.calibrationPath);
  if (!validation.ok) {
    return { ok: false, error: validation.error, reportPath: null, overallPassed: false };
  }
  const manifest = validation.manifest!;
  const frozenCalibration = validation.frozenCalibration!;

  // 2. Load run manifests.
  if (!existsSync(input.runsDir)) {
    return { ok: false, error: `runs directory not found: ${input.runsDir}`, reportPath: null, overallPassed: false };
  }
  const runs: C2EvaluationRunManifestV2[] = [];
  const runEntries = readdirSync(input.runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const name of runEntries) {
    const manifestFile = join(input.runsDir, name, "manifest.json");
    if (!existsSync(manifestFile)) continue;
    try {
      const parsed = C2EvaluationRunManifestV2Schema.parse(readJson(manifestFile));
      runs.push(parsed as C2EvaluationRunManifestV2);
    } catch (err) {
      return {
        ok: false,
        error: `failed to parse run manifest ${manifestFile}: ${err instanceof Error ? err.message : String(err)}`,
        reportPath: null, overallPassed: false,
      };
    }
  }

  // 3. Load human scorecards.
  if (!existsSync(input.scorecardsDir)) {
    return { ok: false, error: `scorecards directory not found: ${input.scorecardsDir}`, reportPath: null, overallPassed: false };
  }
  const scorecards: C2HumanScorecard[] = [];
  const scFiles = readdirSync(input.scorecardsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of scFiles) {
    const path = join(input.scorecardsDir, file);
    try {
      const parsed = C2HumanScorecardSchema.parse(readJson(path));
      scorecards.push(parsed as C2HumanScorecard);
    } catch (err) {
      return {
        ok: false,
        error: `failed to parse scorecard ${path}: ${err instanceof Error ? err.message : String(err)}`,
        reportPath: null, overallPassed: false,
      };
    }
  }

  // 4. Build the evaluator input + invoke.
  const evalInput: ClosureEvaluationInput = {
    manifest,
    frozenCalibration,
    frozenCalibrationFileSha256: validation.calibrationFileSha256!,
    runs,
    scorecards,
    artifactId: input.artifactId ?? "c2-closure-report-baseline-v1",
    evaluatedAt: input.evaluatedAt ?? new Date().toISOString(),
  };
  const report = evaluateC2Closure(evalInput);

  // 5. Durable write with boundary scan. writeDurableArtifact rejects absolute
  // paths in relPath; split the report path into destRoot + relPath.
  const absReportPath = isAbsolute(input.reportPath)
    ? input.reportPath
    : resolve(process.cwd(), input.reportPath);
  const destRoot = dirname(absReportPath);
  const relPath = basename(absReportPath);
  const reportJson = canonicalJsonStringify(report);
  try {
    await writeDurableArtifact(destRoot, relPath, reportJson, durableBoundaryScan());
  } catch (err) {
    return {
      ok: false,
      error: `failed to write closure report: ${err instanceof Error ? err.message : String(err)}`,
      reportPath: null, overallPassed: false,
    };
  }

  return { ok: true, error: null, reportPath: input.reportPath, overallPassed: report.overallPassed };
}

async function runClosureCli(args: Record<string, unknown>): Promise<number> {
  if (!args.manifest || !args.calibration || !args.runs || !args.scorecards) {
    console.error(
      "error: closure requires --manifest <manifest.json> --calibration <frozen.json> --runs <dir> --scorecards <dir>",
    );
    return 2;
  }
  const reportPath = (args["report-path"] as string) ?? DEFAULT_REPORT_PATH;
  const result = await runClosureSubcommand({
    manifestPath: resolve(args.manifest as string),
    calibrationPath: resolve(args.calibration as string),
    runsDir: resolve(args.runs as string),
    scorecardsDir: resolve(args.scorecards as string),
    reportPath,
  });
  if (!result.ok) {
    console.error(`[c2-baseline-closure] FAIL: ${result.error}`);
    return 1;
  }
  console.error(`[c2-baseline-closure] wrote ${result.reportPath} (overallPassed=${result.overallPassed})`);
  // A failed closure (any C1-C9 gate failed) must exit non-zero so automation
  // and operators see the failure. A successful report-write with a failing
  // result is NOT a success.
  return result.overallPassed ? 0 : 1;
}

// ---------------------------------------------------------------------------
// Entry point — MUST be at the end of the file. The `import.meta.url` guard
// ensures tests importing this module never trigger the auto-run.
// ---------------------------------------------------------------------------
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
