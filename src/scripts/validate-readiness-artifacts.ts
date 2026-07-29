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
import type { ValidationResult } from "../readiness/validator.js";
import {
  TRACKED_ARTIFACT_ROOT,
  isTrackedArtifactRoot,
  resolveLedgerApprovalPins,
} from "../readiness/ledger-pins.js";
import type { GitSourceResolver } from "../readiness/checkpoint-policy.js";

const CHECKPOINTS = ["C0", "C1", "C2", "C3", "C4", "C5"] as const;

function usage(): never {
  console.error(`Usage: validate-readiness-artifacts -- --mode public|private [options]

Options:
  --mode public|private         Validation mode (required)
  --corpus-path <path>          Path to corpus/entries.json (required for --mode private)
  --artifact-root <path>        Path to quality-contracts/agent-readiness/
                                (default: this repository's own tracked root, so
                                 the ledger approval pins are always in force
                                 unless you opt out here)
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

// DEFAULT TO THE TRACKED ROOT, SO VALIDATING A COPY IS AN EXPLICIT OPT-OUT.
//
// This used to be `resolve(process.cwd(), "quality-contracts", "agent-readiness")`,
// which lands on this repository's tracked artifact root ONLY because `npm run`
// happens to set the child's cwd to the package directory — a property of npm,
// not a property of the command. Run the same CLI from any other directory
// (`node dist/scripts/validate-readiness-artifacts.js` from a subdirectory, a
// CI step with a different `working-directory`, a shell alias) and the inferred
// root was some other path: `TRACKED_LEDGER_APPROVAL_PINS` went inert and the
// only signal was the `notice:` below, which an operator reading stdout never
// sees. The pins are the anchor that holds the governance ledger's approval rows
// from outside the artifact graph, so "engaged by accident of cwd" is not an
// acceptable default.
//
// `TRACKED_ARTIFACT_ROOT` is derived from the compiled module's own location on
// disk (see ledger-pins.ts), so it names the same directory no matter where the
// process was started. The pins are therefore in force for every default
// invocation, and running the gate WITHOUT them now requires stating a root
// explicitly. `--artifact-root` is unchanged: it still overrides outright, still
// resolves relative to cwd, and still trips the notice when it points anywhere
// other than the tracked root.
const artifactRoot = args["artifact-root"]
  ? resolve(args["artifact-root"])
  : TRACKED_ARTIFACT_ROOT;

// SAY SO WHEN THE LEDGER PINS ARE NOT IN FORCE. `TRACKED_LEDGER_APPROVAL_PINS`
// is a statement about THIS repository's governance chain, so it applies to this
// repository's artifact root and to no other directory (see
// `isTrackedArtifactRoot`). Validating a copy of the graph somewhere else is a
// legitimate thing to do — and it is also the one way left to run this gate with
// the pins inert, so it must not be silent. Diagnostics go to stderr, leaving
// `--json` stdout and the human report byte-identical for the tracked root.
//
// WHY THIS RUNS BEFORE THE GIT RESOLUTION BELOW AND NOT AFTER IT. It used to sit
// after, which made the documented claim — "pointing the gate at a copy is an
// explicit opt-out, announced by a `notice:` on stderr and by
// `"ledgerPinScope"` in `--json`" — false for the commonest form of copy: a
// plain directory copy that carries no git context at all. Such a run hit the
// `git rev-parse` hard stop first and exited 1 having written ZERO bytes of
// stdout and no `notice:`, so the operator learned that git was missing and
// never learned that the pins would have been inert anyway. Reproduced: a byte
// copy of `quality-contracts/agent-readiness` under `/tmp` gave `exit=1`,
// `stdout bytes: 0`, no `notice:`, no `ledgerPinScope`. The pin scope depends on
// NOTHING but the resolved root (`resolveLedgerApprovalPins` consults no file
// and no git state), so there is no reason for it to wait behind a check that
// can fail — and a caller who learns the pins are inert has learned the
// governance-relevant fact even when the run then fails for lack of git context.
if (!isTrackedArtifactRoot(artifactRoot)) {
  console.error(
    `notice: ${artifactRoot} is not this repository's tracked artifact root ` +
      `(${TRACKED_ARTIFACT_ROOT}), so TRACKED_LEDGER_APPROVAL_PINS is NOT in force ` +
      `for this run: the ledger approval rows are not checked against their source ` +
      `pins, and a deleted or renamed ledger file is not reported. Run against the ` +
      `tracked root for the attested result.`,
  );
}

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
  const message =
    `could not resolve git repository root from ${artifactRoot} (${(e as Error).message}). ` +
    `The readiness gate requires git to recompute checkpoint targets; it will not run without it.`;
  console.error(`error: ${message}`);

  // THE HARD STOP STAYS HARD — `ok` is false, every checkpoint is open, and the
  // exit code is 1. What is added is the pin scope, on the machine channel, for
  // the same reason the `notice:` above now precedes this block: a `--json`
  // consumer must not have to infer from an empty stdout whether the pins were
  // in force. The shape emitted here is a complete `ValidationResult`, not a
  // partial one — identical in structure to the validator's own
  // `artifact-root-missing` early return, which reports `checkedArtifacts: 0`,
  // an all-open checkpoint map, and the resolved scope. `config-error` is the
  // validator's existing code for "this run was not configured such that it
  // could validate anything", so nothing here invents vocabulary.
  //
  // `resolveLedgerApprovalPins` is the SAME function the validator would have
  // called, so the scope reported on this path cannot drift from the scope a
  // successful run would have reported. The CLI passes no fixture pins, so the
  // value is `"tracked"` for the tracked root and `"none"` for anywhere else.
  if (args.json) {
    const failure: ValidationResult = {
      ok: false,
      checkpointStatus: { C0: "open", C1: "open", C2: "open", C3: "open", C4: "open", C5: "open" },
      checkedArtifacts: 0,
      issues: [{ code: "config-error", path: artifactRoot, message }],
      warnings: [],
      ledgerPinScope: resolveLedgerApprovalPins({ absArtifactRoot: artifactRoot }).scope,
    };
    console.log(JSON.stringify(failure, null, 2));
  }
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
