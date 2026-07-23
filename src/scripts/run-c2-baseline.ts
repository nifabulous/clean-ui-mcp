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
 *   - `executeC2Run` (the harness; the `run --paid` loop calls it directly),
 *   - the blinded-packet generator (the `scorecards` subcommand reuses it),
 *   - the entry-point guard (`import.meta.url === ...`).
 *
 * The network-capable execution path (`run --paid`) drives the 80-run matrix
 * (75 primary + 5 independent) by calling `executeC2Run` for every slot. It
 * does NOT duplicate the harness — prompt building, provider calls, scoring,
 * cost accounting, audit logging, and immutable writes all flow through
 * `executeC2Run`. The matrix comes EXCLUSIVELY from
 * `C2BaselineManifest.executionMatrix`; model/pricing config comes from the
 * frozen calibration's `campaignConfigRef` + `pricingTableRef` (both
 * hash-verified before any provider call).
 *
 * Subcommands:
 *   validate   — offline. Verify the baseline manifest + frozen calibration
 *                (hash binding + self-hash). The ONLY signal that the campaign
 *                is reproducible from its pinned artifacts.
 *   prepare    — offline. Resolve every condition input (reuses the resolver).
 *   run        — the ONLY network-capable command. Without --paid it prints the
 *                preflight and exits; with --paid it executes the 80-run matrix.
 *   scorecards — offline. Generate metadata-blinded review packets from the
 *                successful baseline runs (reuses the Pass 2 packet generator).
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
import { execSync } from "node:child_process";

import {
  C2BaselineManifestSchema,
  computeManifestSha256,
  type C2BaselineManifest,
  type C2BaselineCaseRef,
} from "../c2/baseline-manifest.js";
import {
  C2FrozenCalibrationSchema,
  C2CampaignConfigSchema,
  C2PricingTableSchema,
  C2ConditionInputSchema,
  type C2FrozenCalibration,
  type C2CampaignConfig,
  type C2PricingTable,
  type C2ConditionInput,
} from "../c2/condition-contracts.js";
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
import { findPricingEntry } from "../c2/cost-policy.js";
import {
  executeC2Run,
  type CampaignState,
  type C2RunStore,
  type ExecuteC2RunRequest,
} from "../c2/harness.js";
import { callTextModelWithMetadata, type Provider } from "../tagger.js";


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
                              Offline. Generate metadata-blinded review packets
                              from the successful baseline runs.
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
      return await runScorecardsCli(args);
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

/**
 * Resolve the repo's harness git sha for manifest binding. Falls back to a
 * 40-zero literal when git is unavailable (e.g. in a shallow checkout).
 */
function harnessGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim().slice(0, 40);
  } catch {
    return "0".repeat(40);
  }
}

/**
 * Build the pinned model endpoint: resolve the apiKey from the env-var name
 * the request carries. The paid path's credential preflight already guarantees
 * the env var is set and non-empty for both lanes before any provider call.
 */
function buildModelEndpoint(req: {
  provider: Provider;
  model: string;
  apiKeyEnv: string;
}): { provider: Provider; model: string; apiKey: string } {
  return {
    provider: req.provider,
    model: req.model,
    apiKey: process.env[req.apiKeyEnv] ?? "",
  };
}

/**
 * Normalize a private baseline condition-input execution path into the logical
 * `eval/c2/condition-inputs/<file>` form recorded in durable run metadata. The
 * descriptor stays private on disk; only its SHA-256 binds the run.
 *
 * Mirrors the pilot's `logicalConditionInputPath` but handles the baseline's
 * distinct `c2/baseline/condition-inputs/` subdir. The logical durable path is
 * the SAME as the pilot's (`eval/c2/condition-inputs/<file>`) so the closure
 * evaluator and scorecard machinery treat baseline + pilot runs uniformly.
 */
function logicalBaselineConditionInputPath(executionPath: string): string {
  const normalized = executionPath.replaceAll("\\", "/");
  const marker = "/c2/baseline/condition-inputs/";
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex >= 0) {
    const fileName = normalized.slice(markerIndex + marker.length);
    if (fileName.length > 0 && !fileName.includes("/")) {
      return `eval/c2/condition-inputs/${fileName}`;
    }
  }
  // Accept an already-logical path as a passthrough.
  if (normalized.startsWith("eval/c2/condition-inputs/")) {
    return normalized;
  }
  throw new Error(
    `[c2-baseline-run] cannot normalize condition-input path: ${executionPath}`,
  );
}

/** Repo-relative path from an absolute-or-relative path (best-effort). */
function relPathFromRepo(absOrRel: string): string {
  if (!isAbsolute(absOrRel)) return absOrRel;
  return absOrRel.replace(process.cwd() + "/", "");
}

/**
 * Load a prepared condition input from disk, validate it through the Zod schema
 * (NOT a TypeScript cast), and verify the recomputed `inputSha256` matches the
 * persisted value before returning. Mirrors the pilot's
 * `loadValidatedConditionInput` exactly. The condition-input file lives under
 * the gitignored private tree, so the threat surface is operator/attacker
 * editing it between `prepare` and `run`; the hash check catches any mutation.
 */
function loadValidatedConditionInput(conditionInputPath: string): C2ConditionInput {
  const raw = JSON.parse(readFileSync(conditionInputPath, "utf-8"));
  const conditionInput = C2ConditionInputSchema.parse(raw) as C2ConditionInput;
  const { inputSha256: _omit, ...rest } = conditionInput;
  void _omit;
  const recomputed = sha256Hex(Buffer.from(canonicalJsonStringify(rest), "utf-8"));
  if (recomputed !== conditionInput.inputSha256) {
    throw new Error(
      "condition input hash mismatch: the loaded inputSha256 does not match the recomputed hash. "
        + "The condition input file may have been corrupted or tampered.",
    );
  }
  return conditionInput;
}

/** Read the evidence content map from a private condition-input payload file. */
function loadEvidenceContent(privatePayloadPath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(privatePayloadPath)) return map;
  try {
    const payload = JSON.parse(readFileSync(privatePayloadPath, "utf-8")) as {
      evidenceContent?: Record<string, string>;
    };
    if (payload.evidenceContent) {
      for (const [id, content] of Object.entries(payload.evidenceContent)) {
        map.set(id, content);
      }
    }
  } catch {
    // best effort — brief-only has no evidence content
  }
  return map;
}

/**
 * Build the baseline's private + durable store. The harness writes private
 * artifacts (raw responses) as `runs/<runId>/raw-response.json` relative to
 * `privateRoot`. To land them at `.c2-private/c2/baseline/runs/<runId>/`
 * (where the scorecards CLI expects to find them), we pass a privateRoot that
 * already includes the `c2/baseline` suffix.
 *
 * Durable writes (manifests, scores) go to `runsRoot` under `eval/c2/baseline/`.
 * Score writes use `writeDurableArtifact` (boundary-scanned) because scores are
 * committable artifacts that must pass the no-private-content guarantee.
 */
function makeBaselineStore(privateRoot: string, runsRoot: string): C2RunStore {
  const baselinePrivateRoot = join(privateRoot, "c2", "baseline");
  return {
    async writePrivate(relPath, bytes) {
      await writePrivateArtifact(baselinePrivateRoot, relPath, bytes);
    },
    async writeDurableManifest(runId, manifestJson) {
      await writeDurableArtifact(
        runsRoot,
        join(runId, "manifest.json"),
        manifestJson,
        durableBoundaryScan(),
      );
    },
    async writeDurableScore(runId, scoreJson) {
      await writeDurableArtifact(
        runsRoot,
        join(runId, "score.json"),
        scoreJson,
        durableBoundaryScan(),
      );
    },
    hasTerminalRun(runId) {
      return existsSync(join(runsRoot, runId, "manifest.json"));
    },
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

  // Deep-hash check: verify the frozen calibration's campaignConfigRef and
  // pricingTableRef against the on-disk files. This catches the drift that
  // occurs when a config edit (e.g. A1's 8192 change) invalidates the frozen
  // binding before a re-freeze (A3) has run.
  const driftWarnings: string[] = [];
  const repoRoot = process.cwd();
  for (const [refName, ref] of [
    ["campaignConfigRef", frozenCalibration.campaignConfigRef],
    ["pricingTableRef", frozenCalibration.pricingTableRef],
  ] as const) {
    const refPath = resolve(repoRoot, ref.path);
    if (existsSync(refPath)) {
      const actualSha = sha256Hex(readFileSync(refPath));
      if (actualSha !== ref.sha256) {
        driftWarnings.push(
          `${refName}: frozen pins ${ref.sha256.slice(0, 12)}… but on-disk ${ref.path} is ${actualSha.slice(0, 12)}…. ` +
          `The config/pricing was edited after the calibration was frozen. Re-run the pilot campaign and re-freeze (Tasks A2-A3) before paid execution.`,
        );
      }
    }
  }
  if (driftWarnings.length > 0) {
    // Don't fail validate (the manifest + calibration binding is still valid);
    // but warn loudly so the operator knows run --paid will fail closed.
    console.error(`[c2-baseline-validate] WARNING: calibration refs have drifted:`);
    for (const w of driftWarnings) console.error(`  - ${w}`);
  }

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
  /**
   * The 5 spec-locked independent case IDs (from
   * `manifest.executionMatrix.independentCaseIds`). Optional: when omitted the
   * preflight reports the canonical constant set; when provided it is echoed
   * in the report so an operator can verify the manifest pins the right cases.
   */
  independentCaseIds?: readonly string[];
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
  /** The 5 spec-locked independent case IDs the matrix will run. */
  independentCaseIds: readonly string[];
}

/** Fixed baseline execution matrix (15 + 5 + 5 = 25 cases). */
const PRIMARY_CASE_COUNT = 25;
const PRIMARY_CONDITION_COUNT = 3; // brief-only, current-grounded, gold-evidence
const INDEPENDENT_CASE_COUNT = 5; // spec-locked
const INDEPENDENT_CONDITION_COUNT = 1; // current-grounded

/** The 5 spec-locked independent case IDs (mirrors the manifest schema). */
const CANONICAL_INDEPENDENT_CASE_IDS = [
  "stablecoin-home",
  "finance-news-story-detail",
  "public-marketing-migration",
  "safety-conflicting-evidence",
  "named-inspiration-safety",
] as const;

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
    independentCaseIds: input.independentCaseIds ?? CANONICAL_INDEPENDENT_CASE_IDS,
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
    `Independent IDs: ${pf.independentCaseIds.join(", ")}`,
    `Total planned runs: ${pf.totalPlannedRuns}`,
    `Forecast cost: $${pf.forecastCostUsd.toFixed(4)} (cap $${pf.campaignCapUsd.toFixed(2)}, headroom ${headroomPctStr}%)`,
    `Per-run ceiling: $${pf.perRunCeilingUsd.toFixed(2)} (from frozen calibration)`,
  ].join("\n");
}

// (renderBaselinePreflight above is the canonical renderer; the CLI calls it
// directly. No `withRender` augmentation — keep the preflight object plain.)

// ---------------------------------------------------------------------------
// Execution matrix construction (Task C2).
//
// The paid execution loop's load-bearing spec logic is the MATRIX CONSTRUCTION:
// exactly 75 primary slots (25 cases × 3 conditions) + 5 independent slots (5
// spec-locked cases × current-grounded), drawn EXCLUSIVELY from
// `C2BaselineManifest.executionMatrix`. The run IDs are namespaced with
// `baseline` so they cannot collide with pilot run IDs (which would otherwise
// shadow a baseline run as "already terminal" in a shared runs directory).
//
// `buildBaselineExecutionMatrix` is PURE: it takes the validated manifest and
// returns the ordered list of slots. The actual execution loop (the `run`
// subcommand) wires each slot into `executeC2Run`, but the matrix shape — the
// part the spec freezes — is testable here without any provider call.
// ---------------------------------------------------------------------------

/** Condition-inputs subdirectory under the private root (matches `prepare`). */
const BASELINE_CONDITION_INPUTS_SUBDIR = "c2/baseline/condition-inputs";

/** One execution slot in the 80-run baseline matrix. */
export interface BaselineExecutionSlot {
  /** Case ID (one of the manifest's 25). */
  caseId: string;
  /** Condition name (brief-only | current-grounded | gold-evidence). */
  condition: "brief-only" | "current-grounded" | "gold-evidence";
  /** Lane: "primary" (OpenAI) or "independent" (Claude). */
  laneLabel: "primary" | "independent";
  /**
   * Run number within this (case, condition, lane) group. The baseline matrix
   * is single-attempt by default (attempt 1); retries increment this and are
   * bound via `predecessorRunId` in the harness request, not here.
   */
  attempt: number;
  /**
   * The namespaced run ID: `c2-run-baseline-{caseId}-{condition}-{laneLabel}-{n}`.
   * Cannot collide with pilot run IDs (which lack the `baseline` segment).
   */
  runId: string;
  /**
   * Absolute-ish path (relative to the private root) of the prepared condition
   * input descriptor. The `prepare` subcommand writes this file; the `run`
   * subcommand loads + hash-validates it before building the harness request.
   */
  conditionInputPath: string;
  /** Source-snapshot artifact IDs the run binds (empty for non-migration cases). */
  sourceSnapshotIds: readonly string[];
}

/**
 * Generate a baseline-namespaced run ID. Primary and independent lanes for the
 * same case+condition receive distinct IDs (`...-primary-1` vs
 * `...-independent-1`) AND both carry the `baseline` segment so they cannot
 * collide with pilot run IDs (`c2-run-{case}-{condition}-{lane}-{n}`).
 *
 * Unlike the pilot's `c2RunId` we do NOT truncate to 64 chars: the added
 * `baseline` segment plus long baseline case IDs (e.g.
 * `safety-conflicting-evidence`) would push a name past 64 and the truncation
 * would erase the lane/attempt suffix, breaking uniqueness across the 80-run
 * matrix. There is no schema length constraint on `runId`; uniqueness is the
 * only binding requirement, and truncation is the latent collision risk.
 */
export function c2BaselineRunId(
  caseId: string,
  condition: string,
  laneLabel: string,
  attempt: number,
): string {
  return `c2-run-baseline-${caseId}-${condition}-${laneLabel}-${attempt}`;
}

/**
 * Build the ordered 80-run execution matrix from the manifest's
 * `executionMatrix`. Pure: no I/O, no schema (the caller passes a
 * schema-validated manifest).
 *
 * The matrix is emitted in execution order: the 75 primary slots first (every
 * case × every primary condition), then the 5 independent slots (the 5
 * spec-locked independent IDs × current-grounded). This mirrors the pilot's
 * lane ordering (primary lane before independent lane) and lets a campaign
 * stop during the independent lane without wasting primary runs.
 *
 * The condition-input path is repo-relative to the private root: it matches
 * the path `prepareBaselineConditions` writes
 * (`<privateRoot>/c2/baseline/condition-inputs/<caseId>-<condition>.json`).
 */
export function buildBaselineExecutionMatrix(
  manifest: C2BaselineManifest,
): BaselineExecutionSlot[] {
  const slots: BaselineExecutionSlot[] = [];
  const snapshotByCase = new Map<string, readonly string[]>();
  for (const c of manifest.cases) {
    snapshotByCase.set(
      c.caseId,
      c.family === "migration" && c.sourceSnapshot ? [c.sourceSnapshot.artifactId] : [],
    );
  }

  // Primary lane: every case × every primary condition = 75 slots.
  for (const c of manifest.cases) {
    for (const condition of manifest.executionMatrix.primaryConditions) {
      slots.push({
        caseId: c.caseId,
        condition,
        laneLabel: "primary",
        attempt: 1,
        runId: c2BaselineRunId(c.caseId, condition, "primary", 1),
        conditionInputPath: join(
          BASELINE_CONDITION_INPUTS_SUBDIR,
          `${c.caseId}-${condition}.json`,
        ),
        sourceSnapshotIds: snapshotByCase.get(c.caseId) ?? [],
      });
    }
  }

  // Independent lane: every independent case × every independent condition = 5 slots.
  for (const caseId of manifest.executionMatrix.independentCaseIds) {
    for (const condition of manifest.executionMatrix.independentConditions) {
      slots.push({
        caseId,
        condition,
        laneLabel: "independent",
        attempt: 1,
        runId: c2BaselineRunId(caseId, condition, "independent", 1),
        conditionInputPath: join(
          BASELINE_CONDITION_INPUTS_SUBDIR,
          `${caseId}-${condition}.json`,
        ),
        sourceSnapshotIds: snapshotByCase.get(caseId) ?? [],
      });
    }
  }

  return slots;
}

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
// overrides) and echoes the 80-run matrix shape + 5 independent IDs.
//
// With --paid: executes the 80-run matrix via `executeBaselineCampaign`. The
// loop resolves the frozen calibration's config/pricing refs (hash-verified),
// builds the matrix from the manifest, and reuses `executeC2Run` for every
// slot. The run artifacts land under eval/c2/baseline/runs/ (durable) +
// .c2-private/c2/baseline/runs/ (private raw responses). Run IDs are
// baseline-namespaced so they cannot collide with pilot run IDs.
//
// Tests do not exercise the --paid egress path (no paid calls in tests); the
// matrix construction, the fail-closed gates, and the no-egress discipline
// are what we verify.
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

  // Best-effort read of the manifest's independent case IDs so the preflight
  // echoes the exact 5 IDs the matrix will run. Falls back to the canonical
  // constant when the manifest doesn't parse (the no-egress subprocess test
  // points at dummy files).
  let independentCaseIds: readonly string[] | undefined;
  if (existsSync(manifestPath)) {
    try {
      const parsedManifest = C2BaselineManifestSchema.parse(readJson(manifestPath)) as C2BaselineManifest;
      independentCaseIds = parsedManifest.executionMatrix.independentCaseIds;
    } catch {
      // Leave undefined; the canonical constant is used.
    }
  }

  const pf = computeBaselinePreflight({
    manifestPath,
    manifestSha,
    calibrationPath,
    calibrationSha,
    maxRunCostUsd,
    maxCampaignCostUsd,
    independentCaseIds,
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

  const result = await executeBaselineCampaign({
    manifest: validation.manifest!,
    frozenCalibration: validation.frozenCalibration!,
    repoRoot: process.cwd(),
    privateRoot: (args["private-root"] as string) ?? ".c2-private",
    runsRoot: (args["runs-root"] as string) ?? "eval/c2/baseline/runs",
    manifestPath: relPathFromRepo(manifestPath),
    preflight: pf,
  });
  if (!result.ok) {
    console.error(`[c2-baseline-run] ${result.error}`);
    return 1;
  }
  console.error(
    `[c2-baseline-run] campaign complete: ${result.succeeded} succeeded, ${result.failed} failed, `
      + `${result.costBlocked} cost-blocked. Total spend: $${result.spentUsd.toFixed(6)}`
      + `${result.stopped ? ` (stopped: ${result.stopReason})` : ""}`,
  );
  return result.stopped ? 1 : 0;
}

// ---------------------------------------------------------------------------
// executeBaselineCampaign — the 80-run execution loop (Task C2)
//
// Reuses `executeC2Run` (the pilot's harness) for every slot. The matrix comes
// EXCLUSIVELY from `buildBaselineExecutionMatrix(manifest)`. Model/pricing
// config comes from the frozen calibration's `campaignConfigRef` +
// `pricingTableRef` — BOTH file hashes are verified before any provider call.
//
// The loop mirrors the pilot's `runRun` shape (build request → executeC2Run →
// collect) but draws its matrix + ceilings from the baseline manifest instead
// of the pilot campaign config. Run IDs are baseline-namespaced so they cannot
// collide with pilot run IDs in a shared filesystem.
// ---------------------------------------------------------------------------

export interface ExecuteBaselineCampaignInput {
  manifest: C2BaselineManifest;
  frozenCalibration: C2FrozenCalibration;
  /** Repo root the manifest's repo-relative paths resolve against. */
  repoRoot: string;
  /** Private root for condition inputs + raw responses. */
  privateRoot: string;
  /** Durable runs root (one subdir per runId). */
  runsRoot: string;
  /** Repo-relative path of the baseline manifest (for casePackageRef binding). */
  manifestPath: string;
  /** The computed preflight (for the pre-egress console report). */
  preflight?: BaselinePreflight;
}

export interface ExecuteBaselineCampaignResult {
  ok: boolean;
  error: string | null;
  succeeded: number;
  failed: number;
  costBlocked: number;
  spentUsd: number;
  stopped: boolean;
  stopReason: "run-budget-exceeded" | "campaign-budget-exceeded" | null;
}

/**
 * Execute the 80-run baseline matrix. Resolves the frozen calibration's config
 * + pricing refs, builds the matrix from the manifest, and reuses
 * `executeC2Run` for every slot. Returns aggregate terminal counts.
 *
 * Fail-closed gates (before any provider call):
 *   - The frozen calibration's `campaignConfigRef` + `pricingTableRef` files
 *     MUST exist and their sha256 MUST match the pinned ref. A stale or
 *     missing file fails with a specific message naming the file.
 *   - BOTH API-key env vars (`primary.apiKeyEnv`, `independent.apiKeyEnv`)
 *     MUST be set and non-empty.
 *   - BOTH lanes' (provider, model) MUST have a pricing entry.
 *   - EVERY prepared condition-input file MUST exist with a matching
 *     `inputSha256`. A missing or tampered file fails closed.
 *
 * Campaign state: shared across every slot. A `run-budget-exceeded` terminal
 * stops the campaign so subsequent slots perform no provider call.
 */
async function executeBaselineCampaign(
  input: ExecuteBaselineCampaignInput,
): Promise<ExecuteBaselineCampaignResult> {
  const { manifest, frozenCalibration, repoRoot, privateRoot, runsRoot, manifestPath } = input;
  if (input.preflight) {
    console.error(renderBaselinePreflight(input.preflight));
    console.error("");
  }

  // 1. Resolve + hash-verify the frozen calibration's config + pricing refs.
  //    These two files are the ONLY source of model/pricing config for the
  //    baseline; the pilot's `cases`/`conditions`/`plannedRunCount` are NOT
  //    consulted (the baseline matrix comes from the manifest).
  const configRef = frozenCalibration.campaignConfigRef;
  const pricingRef = frozenCalibration.pricingTableRef;
  const configAbs = join(repoRoot, configRef.path);
  const pricingAbs = join(repoRoot, pricingRef.path);
  if (!existsSync(configAbs)) {
    return fail(`campaignConfigRef file not found: ${configRef.path}`);
  }
  if (!existsSync(pricingAbs)) {
    return fail(`pricingTableRef file not found: ${pricingRef.path}`);
  }
  if (sha256Hex(readFileSync(configAbs)) !== configRef.sha256) {
    return fail(
      `campaignConfigRef.sha256 mismatch: ${configRef.path} has drifted from the pinned hash. `
        + `Re-freeze the calibration or restore the pinned file.`,
    );
  }
  if (sha256Hex(readFileSync(pricingAbs)) !== pricingRef.sha256) {
    return fail(
      `pricingTableRef.sha256 mismatch: ${pricingRef.path} has drifted from the pinned hash. `
        + `Re-freeze the calibration or restore the pinned file.`,
    );
  }

  let campaignConfig: C2CampaignConfig;
  let pricingTable: C2PricingTable;
  try {
    campaignConfig = C2CampaignConfigSchema.parse(JSON.parse(readFileSync(configAbs, "utf-8")));
  } catch (err) {
    return fail(
      `campaignConfigRef did not parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    pricingTable = C2PricingTableSchema.parse(JSON.parse(readFileSync(pricingAbs, "utf-8")));
  } catch (err) {
    return fail(
      `pricingTableRef did not parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Credential preflight: both lanes' apiKey env vars must be set.
  for (const slot of [campaignConfig.primary, campaignConfig.independent]) {
    const value = process.env[slot.apiKeyEnv];
    if (!value || value.trim().length === 0) {
      return fail(
        `missing credentials: environment variable ${slot.apiKeyEnv} is not set. `
          + `Required for ${slot.provider}/${slot.model}.`,
      );
    }
  }

  // 3. Resolve the pricing entries for both lanes.
  const primaryPricing = findPricingEntry({
    pricingTable,
    provider: campaignConfig.primary.provider,
    model: campaignConfig.primary.model,
  });
  if (!primaryPricing.found) {
    return fail(
      `no pricing entry for primary ${campaignConfig.primary.provider}/${campaignConfig.primary.model}`,
    );
  }
  const independentPricing = findPricingEntry({
    pricingTable,
    provider: campaignConfig.independent.provider,
    model: campaignConfig.independent.model,
  });
  if (!independentPricing.found) {
    return fail(
      `no pricing entry for independent ${campaignConfig.independent.provider}/${campaignConfig.independent.model}`,
    );
  }

  // 4. Build the matrix from the manifest (the ONLY source of the 80-run shape).
  const slots = buildBaselineExecutionMatrix(manifest);

  // 5. Verify every prepared condition input exists BEFORE any provider call.
  //    A missing input fails closed with a specific message naming the file so
  //    the operator knows to run `prepare` first.
  for (const slot of slots) {
    const conditionInputPath = join(privateRoot, slot.conditionInputPath);
    if (!existsSync(conditionInputPath)) {
      return fail(
        `condition input not prepared: ${conditionInputPath}. Run 'prepare' first.`,
      );
    }
  }

  // 6. Shared campaign state. The harness keys cost off `pricingEntry`; we swap
  //    it to the lane we're about to call (primary vs independent).
  const campaignState: CampaignState = {
    spentUsd: 0,
    stopped: false,
    stopReason: null,
    pricingEntry: primaryPricing.value,
  };
  const store = makeBaselineStore(privateRoot, runsRoot);
  const gitSha = harnessGitSha();
  const scorerSha = (() => {
    try {
      return fileSha256("src/c2/scorer.ts");
    } catch {
      return "0".repeat(64);
    }
  })();
  const manifestAbs = join(repoRoot, manifestPath);
  const casePackageSha = existsSync(manifestAbs) ? fileSha256(manifestAbs) : "0".repeat(64);

  // Index the cases so we can load the brief + label per slot without re-scanning.
  const caseByCaseId = new Map(manifest.cases.map((c) => [c.caseId, c] as const));

  let succeeded = 0;
  let failed = 0;
  let costBlocked = 0;

  for (const slot of slots) {
    if (campaignState.stopped) break;

    const c = caseByCaseId.get(slot.caseId);
    if (!c) {
      return fail(`matrix slot references unknown case ${slot.caseId}`);
    }
    const brief = loadBrief(repoRoot, c);
    const label = loadLabel(repoRoot, c);

    const conditionInputPath = join(privateRoot, slot.conditionInputPath);
    let conditionInput: C2ConditionInput;
    try {
      conditionInput = loadValidatedConditionInput(conditionInputPath);
    } catch (err) {
      return fail(
        `${slot.runId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const privatePayloadPath = join(
      privateRoot,
      slot.conditionInputPath.replace(/\.json$/, ".private.json"),
    );
    const evidenceContent = loadEvidenceContent(privatePayloadPath);

    const laneModel =
      slot.laneLabel === "primary" ? campaignConfig.primary : campaignConfig.independent;
    const lanePricing =
      slot.laneLabel === "primary" ? primaryPricing.value : independentPricing.value;

    const request: ExecuteC2RunRequest = {
      casePackageRef: {
        artifactId: c.artifactId,
        path: manifestPath,
        sha256: casePackageSha,
      },
      brief,
      label,
      conditionInput,
      conditionInputRef: {
        artifactId: conditionInput.artifactId,
        path: logicalBaselineConditionInputPath(relPathFromRepo(conditionInputPath)),
        sha256: fileSha256(conditionInputPath),
      },
      scorerRef: {
        artifactId: "c2-scorer-v1",
        path: "src/c2/scorer.ts",
        sha256: scorerSha,
      },
      model: {
        provider: laneModel.provider,
        model: laneModel.model,
        apiKeyEnv: laneModel.apiKeyEnv,
        maxOutputTokens: laneModel.maxOutputTokens,
        samplingParameters: laneModel.samplingParameters,
      },
      maxRunCostUsd: frozenCalibration.maxRunCostUsd,
      maxCampaignCostUsd: frozenCalibration.maxCampaignCostUsd,
      evidenceContent,
      harnessGitSha: gitSha,
      sourceSnapshotIds: slot.sourceSnapshotIds,
      predecessorRunId: null,
    };

    // Swap the campaign's pricing entry to the lane we're about to call. The
    // harness's `assertPinnedModel` verifies (provider, model) matches.
    campaignState.pricingEntry = lanePricing;

    // Audit + execute. The audit fires immediately before the provider call
    // inside the injected callModel, so a no-egress test sees an empty audit
    // file when the campaign fails closed before egress.
    let audited = false;
    const manifestResult = await executeC2Run(request, {
      callModel: async (req) => {
        if (!audited) {
          auditNetworkEgress(req.provider, req.model, slot.runId);
          audited = true;
        }
        return callTextModelWithMetadata({
          prompt: req.prompt,
          endpoint: buildModelEndpoint({
            provider: req.provider,
            model: req.model,
            apiKeyEnv: req.apiKeyEnv,
          }),
          maxOutputTokens: req.maxOutputTokens,
          maxAttempts: req.maxAttempts,
        });
      },
      now: () => new Date().toISOString(),
      runId: (_caseId, _condition, _attempt) => slot.runId,
      scorerSha256: () => scorerSha,
      store,
      campaign: campaignState,
      boundaryScan: durableBoundaryScan(),
    });

    if (manifestResult.status === "succeeded") succeeded += 1;
    else if (manifestResult.status === "cost-blocked") costBlocked += 1;
    else failed += 1;
  }

  return {
    ok: true,
    error: null,
    succeeded,
    failed,
    costBlocked,
    spentUsd: campaignState.spentUsd,
    stopped: campaignState.stopped,
    stopReason: campaignState.stopReason,
  };
}

/** Build a failed result with the preflight already rendered (if provided). */
function fail(error: string): ExecuteBaselineCampaignResult {
  return {
    ok: false,
    error,
    succeeded: 0,
    failed: 0,
    costBlocked: 0,
    spentUsd: 0,
    stopped: false,
    stopReason: null,
  };
}

// ---------------------------------------------------------------------------
// scorecards — offline metadata-blinded review packet generation (Task C3)
//
// Reuses the Pass 2 blinded-packet primitives (createBlindAssignment +
// buildBlindedReviewPacket + the file blind-map store + shufflePackets). The
// baseline command is a thin, canonical wrapper:
//   1. Walk the baseline runs directory for successful scored runs.
//   2. For each, load the private raw response, parse the candidate, mint a
//      private blind assignment (reviewId ↔ runId binding), and write the
//      reviewer-visible packet (ONLY { reviewId, candidate }).
//   3. Shuffle the packets so the reviewer sees them in random order.
//   4. Write the private blind map + a provenance manifest.
//
// The blinding guarantee (spec §10): provider, model, condition, family, run
// ID, and case mapping NEVER reach the packet. Terminal failures are preserved
// in provenance but produce no packet (no fabricated scorecard).
// ---------------------------------------------------------------------------

import {
  createBlindAssignment,
  buildBlindedReviewPacket,
  createFileBlindMapStore,
  shufflePackets,
} from "../c2/review-packets.js";
import { C2CandidateArtifactSchema } from "../c2/candidate-contracts.js";

export interface GenerateBaselineScorecardsInput {
  /** Durable runs root: one subdir per runId, each with manifest.json + score.json. */
  runsDir: string;
  /** Private runs root: <privateRoot>/c2/baseline/runs/<runId>/raw-response.json. */
  privateRunsDir: string;
  /** Where to write the blinded-packet files (one per successful run). */
  packetsDir: string;
  /** Where to write the private blind map (reviewId ↔ runId binding). */
  blindMapDir: string;
  /** Where to write the provenance manifest. */
  provenancePath: string;
  /** The reviewer the packets are assigned to. */
  reviewerActorId: string;
}

export interface GenerateBaselineScorecardsResult {
  ok: boolean;
  error: string | null;
  /** Number of packets generated (one per successful run). */
  packetCount: number;
  /** The packets directory (when ok). */
  packetsDir: string | null;
  /** The private blind-map directory (when ok). */
  blindMapDir: string | null;
  /** The provenance manifest path (when ok). */
  provenancePath: string | null;
}

/**
 * Generate metadata-blinded review packets from the successful baseline runs.
 * Reuses the Pass 2 packet primitives; does NOT duplicate the blinding logic.
 *
 * A run qualifies for a packet when its manifest has `status: "succeeded"` AND
 * `parsedOutputSha256` (a successful run always has both). The raw candidate is
 * loaded from the private raw-response file and parsed through the candidate
 * schema; an unparseable raw response is skipped (not a packet), preserving the
 * rule that scorecards are never fabricated. Failed / cost-blocked runs produce
 * no packet at all.
 *
 * The reviewer-visible packet is EXACTLY `{ reviewId, candidate }`. The
 * reversible binding (reviewId → runId + runOutputSha256) lives only in the
 * private blind map. The packets are shuffled before write so the reviewer sees
 * them in a random order, defeating ordering bias.
 */
export async function generateBaselineScorecards(
  input: GenerateBaselineScorecardsInput,
): Promise<GenerateBaselineScorecardsResult> {
  if (!existsSync(input.runsDir)) {
    return {
      ok: false,
      error: `runs directory not found: ${input.runsDir}`,
      packetCount: 0,
      packetsDir: null,
      blindMapDir: null,
      provenancePath: null,
    };
  }
  if (!existsSync(input.privateRunsDir)) {
    return {
      ok: false,
      error: `private runs directory not found: ${input.privateRunsDir}`,
      packetCount: 0,
      packetsDir: null,
      blindMapDir: null,
      provenancePath: null,
    };
  }

  // Discover successful scored runs.
  const runDirs = readdirSync(input.runsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter(
      (name) =>
        existsSync(join(input.runsDir, name, "manifest.json")) &&
        existsSync(join(input.runsDir, name, "score.json")),
    )
    .sort();

  const store = createFileBlindMapStore(input.blindMapDir);
  const packets: Array<{ reviewId: string; packet: unknown; runId: string }> = [];
  const stochasticFailures: Array<{ runId: string; reason: string }> = [];

  for (const runDir of runDirs) {
    const manifestPath = join(input.runsDir, runDir, "manifest.json");
    let manifest: C2EvaluationRunManifestV2;
    try {
      manifest = C2EvaluationRunManifestV2Schema.parse(
        JSON.parse(readFileSync(manifestPath, "utf-8")),
      ) as C2EvaluationRunManifestV2;
    } catch (err) {
      return {
        ok: false,
        error: `failed to parse run manifest ${manifestPath}: ${err instanceof Error ? err.message : String(err)}`,
        packetCount: 0,
        packetsDir: null,
        blindMapDir: null,
        provenancePath: null,
      };
    }
    // Only successful runs with a parsed output qualify for a packet.
    if (manifest.status !== "succeeded" || !manifest.parsedOutputSha256) {
      continue;
    }
    // Load the raw candidate from the private raw-response file.
    const rawPath = join(input.privateRunsDir, runDir, "raw-response.json");
    if (!existsSync(rawPath)) {
      stochasticFailures.push({
        runId: manifest.runId,
        reason: "no raw-response.json under the private runs root",
      });
      continue;
    }
    const raw = readFileSync(rawPath, "utf-8");
    let candidateJson: unknown;
    try {
      const trimmed = raw.trim();
      const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```/);
      const body = fenced ? fenced[1]! : trimmed;
      candidateJson = JSON.parse(body);
    } catch (err) {
      stochasticFailures.push({
        runId: manifest.runId,
        reason: `raw response not parseable JSON (${err instanceof Error ? err.message : err})`,
      });
      continue;
    }
    let candidate;
    try {
      candidate = C2CandidateArtifactSchema.parse(candidateJson);
    } catch (err) {
      stochasticFailures.push({
        runId: manifest.runId,
        reason: `raw response failed candidate schema (${err instanceof Error ? err.message : err})`,
      });
      continue;
    }

    const assignment = await createBlindAssignment(
      {
        runId: manifest.runId,
        runOutputSha256: manifest.parsedOutputSha256,
        candidate,
        assignedReviewerActorId: input.reviewerActorId,
      },
      { store },
    );
    const packet = buildBlindedReviewPacket(assignment, candidate);
    packets.push({ reviewId: assignment.reviewId, packet, runId: manifest.runId });
  }

  // Shuffle so the reviewer sees packets in a random order, not filesystem order.
  const shuffled = shufflePackets(packets);

  // Ensure the packets directory exists, then write one packet per file.
  // writeDurableArtifact handles the atomic fsync+rename; we route through it so
  // the boundary scan runs before each write (a packet must never carry a secret
  // value or a forbidden content field).
  for (const { reviewId, packet } of shuffled) {
    const packetJson = canonicalJsonStringify(packet);
    try {
      await writeDurableArtifact(input.packetsDir, `${reviewId}.json`, packetJson, durableBoundaryScan());
    } catch (err) {
      return {
        ok: false,
        error: `failed to write packet ${reviewId}: ${err instanceof Error ? err.message : String(err)}`,
        packetCount: packets.length,
        packetsDir: null,
        blindMapDir: null,
        provenancePath: null,
      };
    }
  }

  // Provenance manifest: documents the campaign state (packet count, the
  // blinded-packets directory, any skipped runs). Durable artifacts must pass
  // the boundary scan, which rejects any content field that references the
  // private root. The private blind-map location is therefore recorded as a
  // logical convention marker (not the literal private path); the CLI logs the
  // actual private path to stderr separately for the operator.
  const provenance = {
    schemaVersion: "1.0",
    artifactType: "c2-blinded-review-provenance",
    artifactId: "c2-baseline-blinded-review-provenance-v1",
    generatedAt: new Date().toISOString(),
    reviewerActorId: input.reviewerActorId,
    packetCount: packets.length,
    packetsDir: relPathFromRepo(input.packetsDir),
    // Logical convention: the reversible blind map lives under the private
    // root at the documented baseline subdir. The literal path is operator-
    // private and is logged to stderr, never embedded in a durable artifact.
    blindMapConvention: "c2/baseline/blind-map (under the private root)",
    selectionRule: "one packet per successful scored baseline run (status=succeeded + parsedOutputSha256)",
    stochasticFailuresRecorded: stochasticFailures,
  };
  const provenanceDir = dirname(input.provenancePath);
  const provenanceFile = basename(input.provenancePath);
  try {
    await writeDurableArtifact(
      provenanceDir,
      provenanceFile,
      canonicalJsonStringify(provenance),
      durableBoundaryScan(),
    );
  } catch (err) {
    return {
      ok: false,
      error: `failed to write provenance: ${err instanceof Error ? err.message : String(err)}`,
      packetCount: packets.length,
      packetsDir: null,
      blindMapDir: null,
      provenancePath: null,
    };
  }

  return {
    ok: true,
    error: null,
    packetCount: packets.length,
    packetsDir: input.packetsDir,
    blindMapDir: input.blindMapDir,
    provenancePath: input.provenancePath,
  };
}

async function runScorecardsCli(args: Record<string, unknown>): Promise<number> {
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
  // Default output locations mirror the pilot's: packets under the scorecards
  // dir, private blind map under .c2-private/c2/baseline/blind-map.
  const privateRoot = (args["private-root"] as string) ?? ".c2-private";
  const packetsDir = (args["packets-dir"] as string) ?? join(runsDir, "..", "blinded-packets");
  const blindMapDir = join(privateRoot, "c2/baseline/blind-map");
  const provenancePath = join(runsDir, "..", "blinded-review-provenance.json");
  const reviewerActorId =
    validation.frozenCalibration!.reviewerActorId;
  const result = await generateBaselineScorecards({
    runsDir,
    privateRunsDir: join(privateRoot, "c2/baseline/runs"),
    packetsDir: resolve(packetsDir),
    blindMapDir,
    provenancePath: resolve(provenancePath),
    reviewerActorId,
  });
  if (!result.ok) {
    console.error(`[c2-baseline-scorecards] ${result.error}`);
    return 1;
  }
  console.error(
    `[c2-baseline-scorecards] generated ${result.packetCount} blinded review packet(s) under ${result.packetsDir}`,
  );
  console.error(
    `[c2-baseline-scorecards] private blind map under ${result.blindMapDir}`,
  );
  console.error(
    `[c2-baseline-scorecards] provenance: ${result.provenancePath}`,
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
