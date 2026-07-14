#!/usr/bin/env node
/**
 * validate-readiness-artifacts — thin CLI for the pure readiness validator.
 *
 * Usage:
 *   npm run validate-readiness-artifacts -- --mode public
 *   npm run validate-readiness-artifacts -- --mode public --json
 *   npm run validate-readiness-artifacts -- --mode private --corpus-path corpus/entries.json
 *
 * Exit codes: 0 = valid, 1 = validation failures, 2 = usage/config error.
 */
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { validateReadinessArtifacts } from "../readiness/validator.js";

const CHECKPOINTS = ["C0", "C1", "C2", "C3", "C4", "C5"] as const;

function usage(): never {
  console.error(`Usage: validate-readiness-artifacts -- --mode public|private [options]

Options:
  --mode public|private         Validation mode (required)
  --corpus-path <path>          Path to corpus/entries.json (required for --mode private)
  --artifact-root <path>        Path to quality-contracts/agent-readiness/ (default: inferred)
  --private-artifact-root <path> Path to eval/agent-readiness/ (optional)
  --previous-ledger <path>      Path to a prior checkpoint-approvals ledger (optional)
  --json                        Output machine-readable JSON to stdout`);
  process.exit(2);
}

const { values: args } = parseArgs({
  args: process.argv.slice(2),
  options: {
    mode: { type: "string" },
    "corpus-path": { type: "string" },
    "artifact-root": { type: "string" },
    "private-artifact-root": { type: "string" },
    "previous-ledger": { type: "string" },
    json: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

// Validate args
if (!args.mode) {
  console.error("error: --mode is required");
  usage();
}

if (args.mode !== "public" && args.mode !== "private") {
  console.error(`error: --mode must be 'public' or 'private', got '${args.mode}'`);
  usage();
}

if (args.mode === "private" && !args["corpus-path"]) {
  console.error("error: --mode private requires --corpus-path");
  usage();
}

if (args.mode === "public" && args["corpus-path"]) {
  console.error("error: --mode public does not accept --corpus-path");
  usage();
}

// Infer default artifact root: quality-contracts/agent-readiness/ relative to CWD
const artifactRoot = args["artifact-root"]
  ? resolve(args["artifact-root"])
  : resolve(process.cwd(), "quality-contracts", "agent-readiness");

const result = validateReadinessArtifacts({
  artifactRoot,
  mode: args.mode as "public" | "private",
  corpusPath: args["corpus-path"] ? resolve(args["corpus-path"]) : undefined,
  privateArtifactRoot: args["private-artifact-root"] ? resolve(args["private-artifact-root"]) : undefined,
  previousLedgerPath: args["previous-ledger"] ? resolve(args["previous-ledger"]) : undefined,
});

if (args.json) {
  // Machine-readable JSON to stdout, diagnostics to stderr
  console.log(JSON.stringify(result, null, 2));
} else {
  // Human-readable output
  console.log(`Checked ${result.checkedArtifacts} artifact(s).`);
  console.log("");

  for (const cp of CHECKPOINTS) {
    const status = result.checkpointStatus[cp] ?? "open";
    const symbol = status === "closed" ? "✓" : "○";
    console.log(`  ${symbol} ${cp}: ${status}`);
  }
  console.log("");

  if (result.issues.length === 0) {
    console.log("All checks passed.");
  } else {
    console.log(`${result.issues.length} issue(s) found:`);
    for (const issue of result.issues) {
      const loc = [issue.artifactId, issue.path].filter(Boolean).join(" @ ");
      console.log(`  [${issue.code}]${loc ? ` ${loc}` : ""}: ${issue.message}`);
    }
  }
}

process.exit(result.ok ? 0 : 1);
