#!/usr/bin/env node
/**
 * run-c2-pilot — thin CLI for the C2 Pass 2 pilot harness.
 *
 * Subcommands:
 *   prepare  — offline resolution of every campaign condition input.
 *   run      — the ONLY network-capable command. Executes the campaign.
 *   propose  — calibration proposal from committed runs (Task 8 stub).
 *   freeze   — freeze a calibration under explicit authorization (Task 8 stub).
 *   validate — validate a frozen calibration artifact (Task 8 stub).
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
import { readFileSync, writeFileSync, mkdirSync, existsSync, appendFileSync } from "node:fs";
import { resolve, dirname, join, isAbsolute } from "node:path";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";

import {
  C2CampaignConfigSchema,
  C2PricingTableSchema,
  type C2CampaignConfig,
  type C2PricingTable,
  type C2ConditionInput,
} from "../c2/condition-contracts.js";
import { C2CaseBriefSchema, C2DecisionLabelSchema, C2GoldEvidenceDescriptorSchema, type C2CaseBrief, type C2DecisionLabel, type C2GoldEvidenceDescriptor } from "../c2/case-contracts.js";
import { resolveConditionInput } from "../c2/condition-resolver.js";
import { preflightCampaignCosts, findPricingEntry } from "../c2/cost-policy.js";
import { executeC2Run, type CampaignState, type C2RunStore, type ExecuteC2RunRequest } from "../c2/harness.js";
import { callTextModelWithMetadata, type Provider } from "../tagger.js";
import { sha256Hex, canonicalJsonStringify } from "../readiness/contracts.js";
import { PrivateCorpusReader } from "../corpus-reader.js";

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
      return runPropose(args);
    case "freeze":
      return runFreeze(args);
    case "validate":
      return runValidate(args);
    default:
      console.error(`error: unknown subcommand '${subcommand}'`);
      usage();
  }
}

// Run only when this module is the entry point (not when imported by tests).
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
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
          writePrivate: (relPath, bytes) => {
            const abs = join(privateRoot, relPath);
            mkdirSync(dirname(abs), { recursive: true });
            writeFileSync(abs, bytes);
          },
          now: () => new Date().toISOString(),
        },
      );

      const outDir = join(privateRoot, "c2/condition-inputs");
      mkdirSync(outDir, { recursive: true });
      const outFile = join(outDir, `${pkg.caseId}-${condition}.json`);
      writeFileSync(outFile, canonicalJsonStringify(r.metadata));
      const payloadFile = join(outDir, `${pkg.caseId}-${condition}.private.json`);
      writeFileSync(payloadFile, r.privatePayload);
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
      const conditionInput = JSON.parse(readFileSync(conditionInputPath, "utf-8")) as C2ConditionInput;
      const privatePayloadPath = join(privateRoot, "c2/condition-inputs", `${pkg.caseId}-${condition}.private.json`);
      const evidenceContent = loadEvidenceContent(conditionInput, privatePayloadPath);

      const request: ExecuteC2RunRequest = {
        casePackageRef,
        brief,
        label,
        conditionInput,
        conditionInputRef: {
          artifactId: conditionInput.artifactId,
          path: relPathFromRepo(conditionInputPath),
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
        evidenceContent,
        harnessGitSha: gitSha,
        sourceSnapshotIds: pkg.sourceSnapshot ? [pkg.sourceSnapshot.artifactId] : [],
        predecessorRunId: null,
      };

      // Swap the pricing entry to the lane we're about to call.
      campaignState.pricingEntry = primaryPricing.value;

      const result = await executeC2RunWithAudit(request, store, campaignState, runCounter);
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
      const conditionInput = JSON.parse(readFileSync(conditionInputPath, "utf-8")) as C2ConditionInput;
      const privatePayloadPath = join(privateRoot, "c2/condition-inputs", `${pkg.caseId}-${condition}.private.json`);
      const evidenceContent = loadEvidenceContent(conditionInput, privatePayloadPath);

      const request: ExecuteC2RunRequest = {
        casePackageRef,
        brief,
        label,
        conditionInput,
        conditionInputRef: {
          artifactId: conditionInput.artifactId,
          path: relPathFromRepo(conditionInputPath),
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
        evidenceContent,
        harnessGitSha: gitSha,
        sourceSnapshotIds: pkg.sourceSnapshot ? [pkg.sourceSnapshot.artifactId] : [],
        predecessorRunId: null,
      };

      campaignState.pricingEntry = independentPricing.value;

      const result = await executeC2RunWithAudit(request, store, campaignState, runCounter);
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
 * Wrap executeC2Run with a network-audit hook. The audit fires immediately
 * BEFORE the provider call (inside the injected callModel) so the no-egress
 * guarantee is observable from a subprocess.
 */
async function executeC2RunWithAudit(
  request: ExecuteC2RunRequest,
  store: C2RunStore,
  campaign: CampaignState,
  attempt: number,
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
    runId: (caseId, condition, n) => `c2-run-${caseId}-${condition}-${n}`.slice(0, 64),
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
    async writePrivate(relPath, bytes) {
      const abs = join(privateRoot, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
    },
    async writeDurableManifest(runId, manifestJson) {
      const abs = join(runsRoot, runId, "manifest.json");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, manifestJson, "utf-8");
    },
    async writeDurableScore(runId, scoreJson) {
      const abs = join(runsRoot, runId, "score.json");
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, scoreJson, "utf-8");
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

// ---------------------------------------------------------------------------
// propose / freeze / validate — Task 8 stubs (offline)
// ---------------------------------------------------------------------------

function runPropose(args: Record<string, unknown>): number {
  if (!args.runs) {
    console.error("error: propose requires --runs <dir>");
    return 2;
  }
  // Task 8 implements the calibration reducer. Until then, this command is a
  // placeholder that reads the runs dir and reports what it found, making no
  // network calls.
  const runsDir = resolve(args.runs as string);
  if (!existsSync(runsDir)) {
    console.error(`[c2-propose] runs directory not found: ${runsDir}`);
    return 1;
  }
  console.error(`[c2-propose] Task 8 stub: scanned ${runsDir}. Calibration proposal generation is implemented in Task 8.`);
  return 0;
}

function runFreeze(args: Record<string, unknown>): number {
  if (!args.proposal || !args.authorization) {
    console.error("error: freeze requires --proposal <proposal.json> --authorization <review.json>");
    return 2;
  }
  // Task 8 implements the explicit freeze. The freeze command must verify the
  // authorization artifact's proposal hash matches exactly; that logic lands
  // with the calibration reducer.
  console.error("[c2-freeze] Task 8 stub: explicit calibration freeze is implemented in Task 8.");
  return 0;
}

function runValidate(args: Record<string, unknown>): number {
  if (!args.calibration) {
    console.error("error: validate requires --calibration <frozen.json>");
    return 2;
  }
  // Task 8 implements frozen-calibration validation.
  console.error("[c2-validate] Task 8 stub: frozen calibration validation is implemented in Task 8.");
  return 0;
}
