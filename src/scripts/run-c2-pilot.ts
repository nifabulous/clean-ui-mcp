#!/usr/bin/env node
/**
 * run-c2-pilot — thin CLI for the C2 Pass 2 pilot harness.
 *
 * Subcommands:
 *   prepare  — offline resolution of every campaign condition input.
 *   run      — the ONLY network-capable command. Executes the campaign.
 *   propose  — calibration proposal from committed runs.
 *   freeze   — freeze a calibration under explicit authorization.
 *   validate — validate a frozen calibration artifact.
 *
 * Offline-by-default discipline:
 *   - `run` refuses to start without `--paid`, exact config, valid + fresh
 *     pricing, required credentials present, and the campaign cost preflight
 *     passing. Every other command is offline.
 *   - When `C2_NETWORK_AUDIT` names a file, the CLI appends one line per
 *     attempted provider request to it. A test that sees the audit file empty
 *     after a subprocess exits has proven zero egress.
 *
 * Exit codes: 0 = success, 1 = operational failure, 2 = usage/config error.
 */
import { parseArgs } from "node:util";
import { readFileSync, existsSync, appendFileSync, readdirSync } from "node:fs";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  C2CampaignConfigSchema,
  C2PricingTableSchema,
  C2CalibrationProposalSchema,
  C2FrozenCalibrationSchema,
  C2ConditionInputSchema,
  type C2CampaignConfig,
  type C2PricingTable,
  type C2ConditionInput,
  type C2CalibrationProposal,
  type C2FrozenCalibration,
} from "../c2/condition-contracts.js";
import { C2CaseBriefSchema, C2DecisionLabelSchema, C2GoldEvidenceDescriptorSchema, type C2CaseBrief, type C2DecisionLabel, type C2GoldEvidenceDescriptor } from "../c2/case-contracts.js";
import { resolveConditionInput } from "../c2/condition-resolver.js";
import { preflightCampaignCosts, findPricingEntry } from "../c2/cost-policy.js";
import { executeC2Run, type CampaignState, type C2RunStore, type ExecuteC2RunRequest } from "../c2/harness.js";
import { writePrivateArtifact, writeDurableArtifact, type BoundaryScanConfig } from "../c2/private-artifacts.js";
import { callTextModelWithMetadata, type Provider } from "../tagger.js";
import { sha256Hex, canonicalJsonStringify } from "../readiness/contracts.js";
import { PrivateCorpusReader } from "../corpus-reader.js";
import {
  buildCalibrationProposal,
  freezeCalibration,
  evaluateIndependentCompatibility,
  STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION,
  type CalibrationRun,
  type CalibrationScorecard,
  type FreezeAuthorization,
  type CompatibilityChecklistInput,
  type IndependentCompatibility,
} from "../c2/calibration.js";
import { C2EvaluationRunManifestV2Schema, C2HumanScorecardSchema } from "../c2/evaluation-contracts.js";
import { C2DeterministicScoreSchema } from "../c2/candidate-contracts.js";

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function usage(): never {
  console.error(`Usage: run-c2-pilot <subcommand> [options]

Subcommands:
  prepare  --config <campaign.json> [--pricing <pricing.json>]
                              Offline. Resolve every campaign condition input.
  run      --config <campaign.json> [--pricing <pricing.json>] --paid
                              Network. Execute the campaign. Requires --paid,
                              valid config, fresh pricing, credentials, and
                              campaign cost preflight.
  propose  --runs <dir>       Offline. Calibration proposal (Task 8).
  freeze   --proposal <proposal.json> --authorization <review.json>
                              Offline. Freeze calibration (Task 8).
  validate --calibration <frozen.json>
                              Offline. Validate frozen calibration (Task 8).

Environment:
  C2_NETWORK_AUDIT=<path>     If set, the CLI appends one line per attempted
                              provider request to this file. Used by no-egress
                              tests to prove zero network calls.`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Entry — runs only when this module is the process entry point, not when
// imported (e.g. by tests importing buildModelEndpoint).
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const { values: args, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      config: { type: "string" },
      pricing: { type: "string" },
      paid: { type: "boolean", default: false },
      runs: { type: "string" },
      proposal: { type: "string" },
      authorization: { type: "string" },
      calibration: { type: "string" },
      "private-root": { type: "string" },
      "runs-root": { type: "string" },
    },
    allowPositionals: true,
  });

  const subcommand = positionals[0];
  if (!subcommand) usage();
  switch (subcommand) {
    case "prepare":
      return runPrepare(args);
    case "run":
      return runRun(args);
    case "propose":
      return await runPropose(args);
    case "freeze":
      return await runFreeze(args);
    case "validate":
      return runValidate(args);
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
    throw new Error(`config file not found: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8"));
}

function loadCampaign(path: string): C2CampaignConfig {
  const raw = readJson(path);
  return C2CampaignConfigSchema.parse(raw);
}

function loadPricing(path: string): C2PricingTable {
  const raw = readJson(path);
  return C2PricingTableSchema.parse(raw);
}

/** Default pricing path: sibling of the campaign config named pricing.json. */
function defaultPricingPath(campaignPath: string): string {
  return join(dirname(campaignPath), "pricing.json");
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

/** Resolve the repo's harness git sha for manifest binding. */
function harnessGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    return "0".repeat(40);
  }
}

/** SHA-256 of a file's bytes (matches the readiness canonical hex helper). */
function fileSha256(path: string): string {
  return sha256Hex(readFileSync(path));
}

/**
 * Load a prepared condition input from disk, validate it through the Zod schema
 * (NOT a TypeScript cast), and verify the recomputed `inputSha256` matches the
 * persisted value before returning. The condition input file lives under the
 * gitignored `.c2-private/` tree, so the threat surface is operator/attacker
 * editing it between `prepare` and `run`. The schema parse catches shape drift;
 * the hash check catches any in-place mutation (including ones that preserve the
 * shape). Throws an actionable error if the hash mismatches.
 */
function loadValidatedConditionInput(conditionInputPath: string): C2ConditionInput {
  const raw = JSON.parse(readFileSync(conditionInputPath, "utf-8"));
  const conditionInput = C2ConditionInputSchema.parse(raw) as C2ConditionInput;
  // Recompute the canonical inputSha256 (over every model-visible field EXCEPT
  // the hash itself) and refuse to run if it doesn't match the persisted value.
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

// ---------------------------------------------------------------------------
// prepare — offline condition input resolution
// ---------------------------------------------------------------------------

async function runPrepare(args: Record<string, unknown>): Promise<number> {
  if (!args.config) {
    console.error("error: prepare requires --config <campaign.json>");
    return 2;
  }
  const configPath = resolve(args.config as string);
  const campaign = loadCampaign(configPath);

  const privateRoot = (args["private-root"] as string) ?? ".c2-private";
  const manifestPath = "eval/c2/pilot/manifest.json";
  if (!existsSync(manifestPath)) {
    console.error(`error: pilot manifest not found at ${manifestPath}`);
    return 1;
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    packages: Array<{
      caseId: string;
      family: string;
      brief: { artifactId: string; path: string; sha256: string };
      label: { artifactId: string; path: string; sha256: string };
      sourceSnapshot: { artifactId: string; path: string; sha256: string } | null;
    }>;
  };

  const reader = new PrivateCorpusReader();
  let resolvedCount = 0;

  for (const pkg of manifest.packages) {
    if (!campaign.cases.includes(pkg.caseId)) continue;
    const brief = C2CaseBriefSchema.parse(JSON.parse(readFileSync(pkg.brief.path, "utf-8")));
    const label = C2DecisionLabelSchema.parse(JSON.parse(readFileSync(pkg.label.path, "utf-8")));
    const casePackageRef = {
      artifactId: `c2-package-${pkg.caseId}-v1`,
      path: manifestPath,
      sha256: fileSha256(manifestPath),
    };
    const briefRef = { artifactId: pkg.brief.artifactId, path: pkg.brief.path, sha256: pkg.brief.sha256 };

    for (const condition of campaign.conditions) {
      const r = await resolveConditionInput(
        {
          casePackageRef,
          briefRef,
          brief,
          condition,
          label: condition === "gold-evidence" ? label : undefined,
          // The brief carries the typed sourceSnapshotRef (with artifactType).
          sourceSnapshotRef: brief.sourceSnapshotRef,
          goldEvidenceDescriptor: condition === "gold-evidence"
            ? tryReadGoldDescriptor(pkg.caseId)
            : undefined,
          goldDescriptorRef: condition === "gold-evidence"
            ? tryReadGoldDescriptorRef(pkg.caseId)
            : undefined,
        },
        {
          reader,
          readArtifact: (p) => readFileSync(p),
          writePrivate: async (relPath, bytes) => { await writePrivateArtifact(privateRoot, relPath, bytes); },
          now: () => new Date().toISOString(),
        },
      );

      const outRelDir = "c2/condition-inputs";
      await writePrivateArtifact(privateRoot, join(outRelDir, `${pkg.caseId}-${condition}.json`), Buffer.from(canonicalJsonStringify(r.metadata), "utf-8"));
      await writePrivateArtifact(privateRoot, join(outRelDir, `${pkg.caseId}-${condition}.private.json`), Buffer.from(r.privatePayload, "utf-8"));
      resolvedCount += 1;
    }
  }

  console.error(`[c2-prepare] resolved ${resolvedCount} primary condition inputs under ${privateRoot}/c2/condition-inputs/`);
  return 0;
}

function tryReadGoldDescriptor(caseId: string): C2GoldEvidenceDescriptor | undefined {
  const path = `eval/c2/pilot/evidence/${caseId}.json`;
  if (!existsSync(path)) return undefined;
  return C2GoldEvidenceDescriptorSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
}

function tryReadGoldDescriptorRef(caseId: string): { artifactId: string; path: string; sha256: string } | undefined {
  const path = `eval/c2/pilot/evidence/${caseId}.json`;
  if (!existsSync(path)) return undefined;
  return {
    artifactId: `c2-gold-evidence-${caseId}-v1`,
    path,
    sha256: fileSha256(path),
  };
}

// ---------------------------------------------------------------------------
// run — the ONLY network-capable command
// ---------------------------------------------------------------------------

async function runRun(args: Record<string, unknown>): Promise<number> {
  if (!args.config) {
    console.error("error: run requires --config <campaign.json>");
    return 2;
  }
  if (!args.paid) {
    console.error("error: run requires --paid to make any provider call. Without --paid the campaign is a dry-run that exits without egress.");
    return 2;
  }
  const configPath = resolve(args.config as string);
  const campaign = loadCampaign(configPath);
  const pricingPath = resolve((args.pricing as string) ?? defaultPricingPath(configPath));
  const pricing = loadPricing(pricingPath);

  // Preflight: credentials present. This is a hard gate on the only network
  // command — the absence of OPENAI_API_KEY / ANTHROPIC_API_KEY in the live
  // process env must refuse the run before any provider call. (The .env
  // auto-load satisfies this for normal operators; C2_NO_DOTENV=1 disables
  // that auto-load so the no-egress test suite can prove the gate is real.)
  for (const slot of [campaign.primary, campaign.independent]) {
    const value = process.env[slot.apiKeyEnv];
    if (!value || value.trim().length === 0) {
      console.error(`error: missing credentials: environment variable ${slot.apiKeyEnv} is not set. Required for ${slot.provider}/${slot.model}.`);
      return 1;
    }
  }

  // Preflight: campaign cost reserve.
  const preflight = preflightCampaignCosts({
    campaign,
    pricingTable: pricing,
    primaryPromptTokens: 1000,
    independentPromptTokens: 1000,
  });
  if (!preflight.allowed) {
    console.error(`error: campaign cost preflight failed: ${preflight.reason}`);
    return 1;
  }

  // Preflight: pricing fresh. (The schema already enforces 30-day freshness
  // against campaignStartsAt, so parse success implies fresh. We re-assert
  // here defensively.)
  const nowMs = Date.now();
  for (const entry of pricing.entries) {
    if (Date.parse(entry.verifiedAt) < nowMs - 30 * 24 * 60 * 60 * 1000) {
      console.error(`error: pricing entry ${entry.provider}/${entry.model} verified more than 30 days ago (${entry.verifiedAt})`);
      return 1;
    }
  }

  // Build the campaign state. The pricing entry for the primary lane is the
  // billing basis for primary runs; the independent lane is billed via its
  // own entry.
  const runsRoot = (args["runs-root"] as string) ?? "eval/c2/runs";
  const privateRoot = (args["private-root"] as string) ?? ".c2-private";
  const gitSha = harnessGitSha().slice(0, 40);

  const primaryPricing = findPricingEntry({ pricingTable: pricing, provider: campaign.primary.provider, model: campaign.primary.model });
  if (!primaryPricing.found) {
    console.error(`error: no pricing entry for primary ${campaign.primary.provider}/${campaign.primary.model}`);
    return 1;
  }
  const independentPricing = findPricingEntry({ pricingTable: pricing, provider: campaign.independent.provider, model: campaign.independent.model });
  if (!independentPricing.found) {
    console.error(`error: no pricing entry for independent ${campaign.independent.provider}/${campaign.independent.model}`);
    return 1;
  }

  const campaignState: CampaignState = {
    spentUsd: 0,
    stopped: false,
    stopReason: null,
    // The harness keys cost off this single pricing entry. For the pilot we
    // execute the primary lane first (12 planned runs: 3 cases x 3 conditions
    // + 3 independent). We swap the entry when we cross to the independent lane.
    pricingEntry: primaryPricing.value,
  };

  const store = makeFilesystemStore(privateRoot, runsRoot);
  const manifestPath = "eval/c2/pilot/manifest.json";
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as {
    packages: Array<{
      caseId: string;
      family: string;
      brief: { artifactId: string; path: string; sha256: string };
      label: { artifactId: string; path: string; sha256: string };
      sourceSnapshot: { artifactId: string; path: string; sha256: string } | null;
    }>;
  };

  const results: Array<{ runId: string; status: string; terminalReason: string | null; costUsd: number }> = [];
  let runCounter = 0;

  // Iterate the campaign matrix: every case × every primary condition, then
  // every case × every independent condition. The campaign state is shared; a
  // cost-blocked or run-budget-exceeded terminal stops the matrix.
  for (const pkg of manifest.packages) {
    if (!campaign.cases.includes(pkg.caseId)) continue;
    if (campaignState.stopped) break;

    const brief = C2CaseBriefSchema.parse(JSON.parse(readFileSync(pkg.brief.path, "utf-8")));
    const label = C2DecisionLabelSchema.parse(JSON.parse(readFileSync(pkg.label.path, "utf-8")));
    const casePackageRef = {
      artifactId: `c2-package-${pkg.caseId}-v1`,
      path: manifestPath,
      sha256: fileSha256(manifestPath),
    };

    for (const condition of campaign.conditions) {
      if (campaignState.stopped) break;
      runCounter += 1;

      const conditionInputPath = join(privateRoot, "c2/condition-inputs", `${pkg.caseId}-${condition}.json`);
      if (!existsSync(conditionInputPath)) {
        console.error(`error: condition input not prepared. Run 'prepare' first. Missing: ${conditionInputPath}`);
        return 1;
      }
      let conditionInput: C2ConditionInput;
      try {
        conditionInput = loadValidatedConditionInput(conditionInputPath);
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
      const privatePayloadPath = join(privateRoot, "c2/condition-inputs", `${pkg.caseId}-${condition}.private.json`);
      const evidenceContent = loadEvidenceContent(conditionInput, privatePayloadPath);

      const request: ExecuteC2RunRequest = {
        casePackageRef,
        brief,
        label,
        conditionInput,
        conditionInputRef: {
          artifactId: conditionInput.artifactId,
          path: logicalConditionInputPath(relPathFromRepo(conditionInputPath)),
          sha256: fileSha256(conditionInputPath),
        },
        scorerRef: {
          artifactId: "c2-scorer-v1",
          path: "src/c2/scorer.ts",
          sha256: fileSha256("src/c2/scorer.ts"),
        },
        model: {
          provider: campaign.primary.provider,
          model: campaign.primary.model,
          apiKeyEnv: campaign.primary.apiKeyEnv,
          maxOutputTokens: campaign.primary.maxOutputTokens,
          samplingParameters: campaign.primary.samplingParameters,
        },
        maxRunCostUsd: campaign.maxRunCostUsd,
        maxCampaignCostUsd: campaign.maxCampaignCostUsd,
        evidenceContent,
        harnessGitSha: gitSha,
        sourceSnapshotIds: pkg.sourceSnapshot ? [pkg.sourceSnapshot.artifactId] : [],
        predecessorRunId: null,
      };

      // Swap the pricing entry to the lane we're about to call.
      campaignState.pricingEntry = primaryPricing.value;

      const result = await executeC2RunWithAudit(request, store, campaignState, runCounter, "primary");
      results.push(result);
    }
  }

  // Independent lane: every case × every independent condition.
  for (const pkg of manifest.packages) {
    if (!campaign.cases.includes(pkg.caseId)) continue;
    if (campaignState.stopped) break;

    const brief = C2CaseBriefSchema.parse(JSON.parse(readFileSync(pkg.brief.path, "utf-8")));
    const label = C2DecisionLabelSchema.parse(JSON.parse(readFileSync(pkg.label.path, "utf-8")));
    const casePackageRef = {
      artifactId: `c2-package-${pkg.caseId}-v1`,
      path: manifestPath,
      sha256: fileSha256(manifestPath),
    };

    for (const condition of campaign.independentConditions) {
      if (campaignState.stopped) break;
      runCounter += 1;

      const conditionInputPath = join(privateRoot, "c2/condition-inputs", `${pkg.caseId}-${condition}.json`);
      if (!existsSync(conditionInputPath)) {
        console.error(`error: condition input not prepared. Run 'prepare' first. Missing: ${conditionInputPath}`);
        return 1;
      }
      let conditionInput: C2ConditionInput;
      try {
        conditionInput = loadValidatedConditionInput(conditionInputPath);
      } catch (err) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
      const privatePayloadPath = join(privateRoot, "c2/condition-inputs", `${pkg.caseId}-${condition}.private.json`);
      const evidenceContent = loadEvidenceContent(conditionInput, privatePayloadPath);

      const request: ExecuteC2RunRequest = {
        casePackageRef,
        brief,
        label,
        conditionInput,
        conditionInputRef: {
          artifactId: conditionInput.artifactId,
          path: logicalConditionInputPath(relPathFromRepo(conditionInputPath)),
          sha256: fileSha256(conditionInputPath),
        },
        scorerRef: {
          artifactId: "c2-scorer-v1",
          path: "src/c2/scorer.ts",
          sha256: fileSha256("src/c2/scorer.ts"),
        },
        model: {
          provider: campaign.independent.provider,
          model: campaign.independent.model,
          apiKeyEnv: campaign.independent.apiKeyEnv,
          maxOutputTokens: campaign.independent.maxOutputTokens,
          samplingParameters: campaign.independent.samplingParameters,
        },
        maxRunCostUsd: campaign.maxRunCostUsd,
        maxCampaignCostUsd: campaign.maxCampaignCostUsd,
        evidenceContent,
        harnessGitSha: gitSha,
        sourceSnapshotIds: pkg.sourceSnapshot ? [pkg.sourceSnapshot.artifactId] : [],
        predecessorRunId: null,
      };

      campaignState.pricingEntry = independentPricing.value;

      const result = await executeC2RunWithAudit(request, store, campaignState, runCounter, "independent");
      results.push(result);
    }
  }

  const succeeded = results.filter((r) => r.status === "succeeded").length;
  const failed = results.filter((r) => r.status === "failed").length;
  const blocked = results.filter((r) => r.status === "cost-blocked").length;
  // eslint-disable-next-line no-console
  console.error(
    `[c2-run] campaign complete: ${succeeded} succeeded, ${failed} failed, ${blocked} cost-blocked. `
    + `Total spend: $${campaignState.spentUsd.toFixed(6)}${campaignState.stopped ? ` (stopped: ${campaignState.stopReason})` : ""}`,
  );
  return campaignState.stopped ? 1 : 0;
}

/**
 * Build the pinned endpoint for a model call by resolving the apiKey from the
 * env-var name carried on the request (`apiKeyEnv`). The CLI's credential
 * preflight already guarantees the env var is set and non-empty for every
 * network-capable run, so the fallback to "" is only a defensive default for
 * callers that bypass the preflight. Exposed as a named helper so tests can
 * pin it without spawning the compiled CLI.
 */
export function buildModelEndpoint(req: {
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
 * Generate a lane-namespaced runId. Primary and independent lanes for the same
 * case+condition receive distinct IDs (e.g. `...-primary-1` vs `...-independent-1`)
 * so the immutability guard never blocks an independent run with a primary run's ID.
 */
export function c2RunId(caseId: string, condition: string, laneLabel: string, attempt: number): string {
  const base = `c2-run-${caseId}-${condition}-${laneLabel}-${attempt}`;
  return base.slice(0, 64);
}

/**
 * Wrap executeC2Run with a network-audit hook. The audit fires immediately
 * BEFORE the provider call (inside the injected callModel) so the no-egress
 * guarantee is observable from a subprocess.
 */
async function executeC2RunWithAudit(
  request: ExecuteC2RunRequest,
  store: C2RunStore,
  campaign: CampaignState,
  attempt: number,
  laneLabel: string,
): Promise<{ runId: string; status: string; terminalReason: string | null; costUsd: number }> {
  let audited = false;
  const manifest = await executeC2Run(request, {
    callModel: async (req) => {
      // The audit happens here, immediately before the real provider request.
      // If the forecast blocked, the harness never calls callModel, so the
      // audit stays empty — proving zero egress for offline paths.
      if (!audited) {
        auditNetworkEgress(req.provider, req.model, `attempt-${attempt}`);
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
    runId: (caseId, condition, n) => c2RunId(caseId, condition, laneLabel, n),
    scorerSha256: () => {
      try {
        return fileSha256("src/c2/scorer.ts");
      } catch {
        return createHash("sha256").update("c2-scorer-fallback").digest("hex");
      }
    },
    store,
    campaign,
    boundaryScan: { secretValues: collectSecretValues(), secretEnvNames: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] },
  });
  return {
    runId: manifest.runId,
    status: manifest.status,
    terminalReason: manifest.terminalReason,
    costUsd: manifest.costUsd,
  };
}

function collectSecretValues(): string[] {
  const values: string[] = [];
  for (const name of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"]) {
    const v = process.env[name];
    if (v && v.length > 0) values.push(v);
  }
  return values;
}

/**
 * Boundary-scan config for the proposal/freeze durable writes. Mirrors the
 * config the harness threads into executeC2Run: the resolved API-key values +
 * the secret env-var names. writeDurableArtifact runs this scan BEFORE the
 * atomic write so a calibration artifact carrying any secret material, a
 * forbidden content field, or a private path is rejected with no file on disk.
 */
function durableBoundaryScan(): BoundaryScanConfig {
  return {
    secretValues: collectSecretValues(),
    secretEnvNames: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
  };
}

function loadEvidenceContent(conditionInput: C2ConditionInput, privatePayloadPath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(privatePayloadPath)) return map;
  try {
    const payload = JSON.parse(readFileSync(privatePayloadPath, "utf-8")) as { evidenceContent?: Record<string, string> };
    if (payload.evidenceContent) {
      for (const [id, content] of Object.entries(payload.evidenceContent)) {
        map.set(id, content);
      }
    }
  } catch {
    // best effort — brief-only has no evidence content
  }
  void conditionInput;
  return map;
}

function makeFilesystemStore(privateRoot: string, runsRoot: string): C2RunStore {
  return {
    // Private writes (raw responses, private payloads) use the atomic
    // fsync+rename primitive. No boundary scan — everything under the private
    // root is private by construction.
    async writePrivate(relPath, bytes) {
      await writePrivateArtifact(privateRoot, relPath, bytes);
    },
    // Durable writes (manifests, scores) are ALREADY boundary-scanned by the
    // harness's writeManifestDurable / writeScoreDurable (scanDurableArtifact
    // runs before the store is called). The store only needs the atomic
    // fsync+rename lifecycle, so it routes through writePrivateArtifact against
    // the durable root. The boundary scan config stays owned by the harness.
    async writeDurableManifest(runId, manifestJson) {
      await writePrivateArtifact(runsRoot, join(runId, "manifest.json"), Buffer.from(manifestJson, "utf-8"));
    },
    async writeDurableScore(runId, scoreJson) {
      await writePrivateArtifact(runsRoot, join(runId, "score.json"), Buffer.from(scoreJson, "utf-8"));
    },
    hasTerminalRun(runId) {
      return existsSync(join(runsRoot, runId, "manifest.json"));
    },
  };
}

function relPathFromRepo(absOrRel: string): string {
  if (!isAbsolute(absOrRel)) return absOrRel;
  // Make a best-effort repo-relative path for the manifest's ref.
  return absOrRel.replace(process.cwd() + "/", "");
}

/**
 * Convert a private condition-input execution path into the logical path
 * recorded in durable run metadata. The descriptor remains private on disk;
 * only its SHA-256 binds the run to the exact bytes.
 */
export function logicalConditionInputPath(executionPath: string): string {
  const normalized = executionPath.replaceAll("\\", "/");
  const marker = "/c2/condition-inputs/";
  const markerIndex = normalized.lastIndexOf(marker);

  if (markerIndex >= 0) {
    const fileName = normalized.slice(markerIndex + marker.length);
    if (fileName.length > 0 && !fileName.includes("/")) {
      return `eval/c2/condition-inputs/${fileName}`;
    }
  }

  if (normalized.startsWith("eval/c2/condition-inputs/")) {
    return normalized;
  }

  throw new Error(
    `[c2-cli] cannot normalize condition-input path: ${executionPath}`,
  );
}

// ---------------------------------------------------------------------------
// propose / freeze / validate — offline calibration (Task 8)
//
// These three commands remain OFFLINE. Only `run` is network-capable. They
// read committed run manifests + scorecards + the pilot manifest, reduce a
// calibration proposal, freeze it under explicit authorization, and validate
// the frozen artifact. None of them imports the provider call path.
// ---------------------------------------------------------------------------

const PILOT_MANIFEST_PATH = "eval/c2/pilot/manifest.json";
const SCORECARDS_DIR = "eval/c2/scorecards";
const CALIBRATION_DIR = "eval/c2/calibration";

interface PilotManifestPackage {
  caseId: string;
  family: "product" | "migration" | "safety";
}

function loadPilotPackages(): PilotManifestPackage[] {
  if (!existsSync(PILOT_MANIFEST_PATH)) {
    throw new Error(`[c2-propose] pilot manifest not found at ${PILOT_MANIFEST_PATH}`);
  }
  const raw = JSON.parse(readFileSync(PILOT_MANIFEST_PATH, "utf-8")) as { packages: Array<{ caseId: string; family: string }> };
  return raw.packages.map((p) => ({
    caseId: p.caseId,
    family: p.family as PilotManifestPackage["family"],
  }));
}

function loadCalibrationRuns(runsDir: string): CalibrationRun[] {
  if (!existsSync(runsDir)) {
    throw new Error(`[c2-propose] runs directory not found: ${runsDir}`);
  }
  const packages = loadPilotPackages();
  const familyByCase = new Map(packages.map((p) => [p.caseId, p.family]));
  const entries = readdirSync(runsDir, { withFileTypes: true });
  const runs: CalibrationRun[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = join(runsDir, entry.name, "manifest.json");
    const scorePath = join(runsDir, entry.name, "score.json");
    if (!existsSync(manifestPath) || !existsSync(scorePath)) continue;
    const manifest = C2EvaluationRunManifestV2Schema.parse(JSON.parse(readFileSync(manifestPath, "utf-8")));
    const score = C2DeterministicScoreSchema.parse(JSON.parse(readFileSync(scorePath, "utf-8")));
    // Derive the caseId from the runId pattern `c2-run-<caseId>-<condition>-<n>`.
    // The manifest itself carries the casePackageRef but not the bare caseId;
    // the runId is the canonical binding.
    const caseId = deriveCaseId(manifest.runId, packages);
    const family = familyByCase.get(caseId);
    if (!family) {
      throw new Error(`[c2-propose] run ${manifest.runId} caseId ${caseId} has no pilot family mapping`);
    }
    runs.push({ manifest, score, caseId, family });
  }
  return runs;
}

function deriveCaseId(runId: string, packages: PilotManifestPackage[]): string {
  // runId shape: c2-run-<caseId>-<condition>-<n>. The caseId may itself contain
  // hyphens, so match against the known pilot caseIds first.
  for (const p of packages) {
    if (runId.includes(`-${p.caseId}-`)) return p.caseId;
  }
  // Fallback: strip the known prefix and trailing `-<condition>-<n>` segments.
  const stripped = runId.replace(/^c2-run-/, "");
  const parts = stripped.split("-");
  if (parts.length >= 3) return parts.slice(0, -2).join("-");
  return stripped;
}

function loadCalibrationScorecards(runs: CalibrationRun[]): CalibrationScorecard[] {
  if (!existsSync(SCORECARDS_DIR)) {
    throw new Error(`[c2-propose] scorecards directory not found at ${SCORECARDS_DIR}`);
  }
  const runsByRunId = new Map(runs.map((r) => [r.manifest.runId, r]));
  const files = readdirSync(SCORECARDS_DIR).filter((f) => f.endsWith(".json"));
  const scorecards: CalibrationScorecard[] = [];
  for (const file of files) {
    const path = join(SCORECARDS_DIR, file);
    const sc = C2HumanScorecardSchema.parse(JSON.parse(readFileSync(path, "utf-8")));
    const run = runsByRunId.get(sc.runId);
    if (!run) {
      throw new Error(`[c2-propose] scorecard ${sc.artifactId} references unknown runId ${sc.runId}`);
    }
    scorecards.push({
      scorecard: sc,
      family: run.family,
      caseId: run.caseId,
      condition: run.manifest.condition,
    });
  }
  return scorecards;
}

/**
 * Build a SYNTHESIZED compatibility-checklist input for the OpenAI primary vs
 * Claude independent lanes. The campaign's real critical-decision IDs are NOT
 * enumerable from the run artifacts alone, so this helper cannot perform a
 * genuine OpenAI-vs-Claude evaluation. Instead it fabricates a conservative
 * checklist from the deterministic-score signal (complete ⇒ all required
 * decisions covered) so `propose` can emit a structurally-complete proposal:
 * a complete primary score and a complete independent score ⇒ full coverage,
 * no contradictions detectable from hashes alone, constraints respected,
 * safety compliant.
 *
 * The result is a placeholder, NOT a measured compatibility evaluation.
 * `runPropose` marks the resulting `IndependentCompatibility` with
 * `cliSynthesized: true` so `proposal.json` is self-describing. The
 * authoritative compatibility evaluation is the human-judgment step performed
 * during freeze authorization; a future consumer reading `proposal.json` MUST
 * NOT treat a `cliSynthesized` compatibility as evidence the evaluation was
 * performed.
 */
function buildCompatibilityInput(runs: CalibrationRun[]): CompatibilityChecklistInput {
  const openaiPrimary = runs.find((r) => r.manifest.provider === "openai");
  const claudeIndependent = runs.find((r) => r.manifest.provider === "claude");
  const primaryComplete = openaiPrimary?.score.complete ?? false;
  const independentComplete = claudeIndependent?.score.complete ?? false;
  // The pilot manifest's critical decision IDs are not enumerable from the run
  // artifacts alone; the checklist records the deterministic-score signal.
  // The authorization artifact's human-authored checklist is the binding
  // authority at freeze time.
  const criticalDecisionIds = ["decision:critical-1"];
  return {
    criticalDecisionIds,
    openaiPrimary: {
      caseId: openaiPrimary?.caseId ?? "unknown",
      coveredCriticalDecisionIds: primaryComplete ? criticalDecisionIds : [],
      criticalDecisionLanes: primaryComplete ? { "decision:critical-1": "adapt" } : {},
      constraintsRespected: primaryComplete ? ["constraint:1"] : [],
      forbiddenClaimsRespected: primaryComplete,
      safetyCompliant: primaryComplete,
    },
    claudeIndependent: {
      caseId: claudeIndependent?.caseId ?? "unknown",
      coveredCriticalDecisionIds: independentComplete ? criticalDecisionIds : [],
      criticalDecisionLanes: independentComplete ? { "decision:critical-1": "adapt" } : {},
      constraintsRespected: independentComplete ? ["constraint:1"] : [],
      forbiddenClaimsRespected: independentComplete,
      safetyCompliant: independentComplete,
    },
  };
}

async function runPropose(args: Record<string, unknown>): Promise<number> {
  if (!args.runs) {
    console.error("error: propose requires --runs <dir>");
    return 2;
  }
  const runsDir = resolve(args.runs as string);
  try {
    const runs = loadCalibrationRuns(runsDir);
    if (runs.length === 0) {
      console.error(`[c2-propose] no completed runs found under ${runsDir} (expected <runId>/manifest.json + <runId>/score.json)`);
      return 1;
    }
    const scorecards = loadCalibrationScorecards(runs);
    // The CLI cannot enumerate the campaign's critical-decision IDs from run
    // artifacts alone, so `buildCompatibilityInput` synthesizes a conservative
    // checklist from the deterministic `score.complete` signals and the
    // resulting compatibility is a placeholder, not a measured evaluation.
    // Mark it `cliSynthesized: true` so `proposal.json` is self-describing:
    // the authoritative compatibility evaluation is a human-judgment step that
    // happens during freeze authorization, not a CLI-synthesized artifact.
    const compatibility: IndependentCompatibility = {
      ...evaluateIndependentCompatibility(buildCompatibilityInput(runs)),
      cliSynthesized: true,
    };

    const proposal = buildCalibrationProposal({
      runs,
      scorecards,
      compatibility,
      campaignConfigRef: {
        artifactId: "c2-campaign-config-pilot-v1",
        path: "eval/c2/config/pilot-campaign.json",
        sha256: fileSha256("eval/c2/config/pilot-campaign.json"),
      },
      pricingTableRef: {
        artifactId: "c2-pricing-table-pilot-v1",
        path: "eval/c2/config/pricing.json",
        sha256: fileSha256("eval/c2/config/pricing.json"),
      },
      artifactId: "c2-calibration-proposal-pilot-v1",
      // The documented Claude truncation exception for the product family
      // (stablecoin-home) current-grounded independent run. Permits ONLY this
      // exact missing pair; every other gap still fails closed.
      claudeCoverageExceptions: [STABLECOIN_CLAUDE_TRUNCATION_EXCEPTION],
    });

    // Durable write under eval/c2/calibration/ — runs the boundary scan FIRST
    // (no secret values, no private paths, no content fields) then writes
    // atomically with fsync+rename.
    await writeDurableArtifact(CALIBRATION_DIR, "proposal.json", canonicalJsonStringify(proposal), durableBoundaryScan());
    const proposalPath = join(CALIBRATION_DIR, "proposal.json");
    console.error(`[c2-propose] wrote ${proposalPath} (proposalSha256=${proposal.proposalSha256.slice(0, 12)}…)`);
    return 0;
  } catch (err) {
    console.error(`[c2-propose] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function runFreeze(args: Record<string, unknown>): Promise<number> {
  if (!args.proposal || !args.authorization) {
    console.error("error: freeze requires --proposal <proposal.json> --authorization <review.json>");
    return 2;
  }
  const proposalPath = resolve(args.proposal as string);
  const authorizationPath = resolve(args.authorization as string);
  try {
    if (!existsSync(proposalPath)) {
      console.error(`[c2-freeze] proposal not found: ${proposalPath}`);
      return 1;
    }
    if (!existsSync(authorizationPath)) {
      console.error(`[c2-freeze] authorization not found: ${authorizationPath}`);
      return 1;
    }
    const proposal = C2CalibrationProposalSchema.parse(JSON.parse(readFileSync(proposalPath, "utf-8"))) as C2CalibrationProposal;
    const authorization = JSON.parse(readFileSync(authorizationPath, "utf-8")) as FreezeAuthorization;

    // The freeze binds the proposal's compatibility. The authorization's
    // checklist MUST match it; the freeze validates that.
    const compatibility = proposal.measurements.independentCompatibility;

    // Reject CLI-synthesized compatibility at freeze time. A `cliSynthesized:
    // true` marker means the compatibility was fabricated from score-completeness
    // signals, not measured against real independent evidence. The freeze gate
    // requires a genuine human-authored compatibility evaluation.
    if (compatibility.cliSynthesized === true) {
      console.error(
        "[c2-freeze] rejected: proposal carries cliSynthesized compatibility (a fabricated placeholder). "
        + "The freeze gate requires a genuine independent-compatibility evaluation, not a CLI-synthesized one. "
        + "Review the proposal's independent evidence and author a real compatibility evaluation in the authorization.",
      );
      return 1;
    }

    const frozen = freezeCalibration({
      proposal,
      compatibility,
      authorization,
      campaignConfigRef: proposal.campaignConfigRef,
      pricingTableRef: proposal.pricingTableRef,
      artifactId: "c2-frozen-calibration-pilot-v1",
    });

    // Durable write under eval/c2/calibration/ — boundary scan FIRST, then
    // atomic fsync+rename.
    await writeDurableArtifact(CALIBRATION_DIR, "frozen.json", canonicalJsonStringify(frozen), durableBoundaryScan());
    const frozenPath = join(CALIBRATION_DIR, "frozen.json");
    console.error(`[c2-freeze] wrote ${frozenPath} (frozenAt=${frozen.frozenAt})`);
    return 0;
  } catch (err) {
    console.error(`[c2-freeze] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function runValidate(args: Record<string, unknown>): number {
  if (!args.calibration) {
    console.error("error: validate requires --calibration <frozen.json>");
    return 2;
  }
  const calibrationPath = resolve(args.calibration as string);
  try {
    if (!existsSync(calibrationPath)) {
      console.error(`[c2-validate] frozen calibration not found: ${calibrationPath}`);
      return 1;
    }
    const raw = JSON.parse(readFileSync(calibrationPath, "utf-8"));
    const frozen = C2FrozenCalibrationSchema.parse(raw) as C2FrozenCalibration;
    // Re-validate byte-identical re-freeze determinism: the canonical JSON of
    // the parsed artifact is stable (sorted keys) so a re-freeze with the same
    // authorization + timestamp produces the same bytes.
    const canonical = canonicalJsonStringify(frozen);
    console.error(`[c2-validate] OK: ${calibrationPath} (artifactId=${frozen.artifactId}, frozenAt=${frozen.frozenAt}, ${canonical.length} bytes canonical)`);
    return 0;
  } catch (err) {
    console.error(`[c2-validate] ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// ---------------------------------------------------------------------------
// Entry point — MUST be at the end of the file, after all module-level const
// declarations (PILOT_MANIFEST_PATH, SCORECARDS_DIR, CALIBRATION_DIR). Placing
// this block earlier triggers a temporal-dead-zone error: main() calls
// runPropose() → loadCalibrationRuns() → loadPilotPackages(), which references
// PILOT_MANIFEST_PATH before its declaration is reached. The `import.meta.url`
// guard ensures tests importing this module never trigger the auto-run.
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
