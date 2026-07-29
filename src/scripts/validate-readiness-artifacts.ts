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
import { execFileSync } from "node:child_process";
import { validateReadinessArtifacts } from "../readiness/validator.js";
import { TRACKED_ARTIFACT_ROOT, isTrackedArtifactRoot } from "../readiness/ledger-pins.js";
import type { GitSourceResolver } from "../readiness/checkpoint-policy.js";

const CHECKPOINTS = ["C0", "C1", "C2", "C3", "C4", "C5"] as const;

function usage(): never {
  console.error(`Usage: validate-readiness-artifacts -- --mode public|private [options]

Options:
  --mode public|private         Validation mode (required)
  --corpus-path <path>          Path to corpus/entries.json (required for --mode private)
  --artifact-root <path>        Path to quality-contracts/agent-readiness/ (default: inferred)
  --private-artifact-root <path> Path to eval/agent-readiness/ (optional)
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

// Resolve the git repo toplevel once. The artifact root is a subdirectory of
// the repo (quality-contracts/agent-readiness), NOT the repo root — do not
// repeat the prior mistake of treating the parent of artifactRoot as the
// repo root. The git-bound resolver is REQUIRED for the checkpoint security
// gate: if git is unavailable or this is not a git checkout, we must fail
// hard rather than silently trust the ledger.
let repoRoot: string;
try {
  repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    cwd: artifactRoot,
    encoding: "utf-8",
  }).trim();
} catch (e) {
  console.error(
    `error: could not resolve git repository root from ${artifactRoot} (${(e as Error).message}). ` +
      `The readiness gate requires git to recompute checkpoint targets; it will not run without it.`,
  );
  process.exit(1);
}

/**
 * Git-backed resolver: returns the exact file bytes at (commit, repoPath) by
 * shelling out to `git show <commit>:<path>`. The validator itself never
 * shells out — only this injected resolver does. Repository root is fixed at
 * call time (the repo containing the artifact root) so historical bytes are
 * always resolved from the same repo, regardless of the working-tree state.
 */
function makeGitSourceResolver(repoCwd: string): GitSourceResolver {
  return {
    resolve(commit: string, repositoryPath: string): Uint8Array {
      return execFileSync("git", ["show", `${commit}:${repositoryPath}`], {
        cwd: repoCwd,
        maxBuffer: 64 * 1024 * 1024,
      });
    },
  };
}

// SAY SO WHEN THE LEDGER PINS ARE NOT IN FORCE. `TRACKED_LEDGER_APPROVAL_PINS`
// is a statement about THIS repository's governance chain, so it applies to this
// repository's artifact root and to no other directory (see
// `isTrackedArtifactRoot`). Validating a copy of the graph somewhere else is a
// legitimate thing to do — and it is also the one way left to run this gate with
// the pins inert, so it must not be silent. Diagnostics go to stderr, leaving
// `--json` stdout and the human report byte-identical for the tracked root.
if (!isTrackedArtifactRoot(artifactRoot)) {
  console.error(
    `notice: ${artifactRoot} is not this repository's tracked artifact root ` +
      `(${TRACKED_ARTIFACT_ROOT}), so TRACKED_LEDGER_APPROVAL_PINS is NOT in force ` +
      `for this run: the ledger approval rows are not checked against their source ` +
      `pins, and a deleted or renamed ledger file is not reported. Run against the ` +
      `tracked root for the attested result.`,
  );
}

const result = validateReadinessArtifacts({
  artifactRoot,
  mode: args.mode as "public" | "private",
  corpusPath: args["corpus-path"] ? resolve(args["corpus-path"]) : undefined,
  privateArtifactRoot: args["private-artifact-root"] ? resolve(args["private-artifact-root"]) : undefined,
  repoRoot,
  gitSourceResolver: makeGitSourceResolver(repoRoot),
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

  // Non-blocking caveats: surfaced so the closure claim is honest, but they do
  // not affect the exit code (the validator cannot enforce what they describe).
  const warnings = result.warnings ?? [];
  if (warnings.length > 0) {
    console.log("");
    console.log(`${warnings.length} caveat(s) (non-blocking):`);
    for (const w of warnings) {
      const loc = [w.artifactId, w.path].filter(Boolean).join(" @ ");
      console.log(`  [${w.code}]${loc ? ` ${loc}` : ""}: ${w.message}`);
    }
  }
}

process.exit(result.ok ? 0 : 1);
