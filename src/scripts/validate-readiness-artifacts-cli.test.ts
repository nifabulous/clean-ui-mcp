import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Per-test timeout for every case that SPAWNS the compiled CLI.
 *
 * The child costs ~1.1s standalone and this file spawns it several times; the
 * default 15s applies PER TEST but the suite as a whole is load-sensitive, and
 * one case here has already failed once with a vitest-timeout signature that did
 * not reproduce in three subsequent runs. A generous explicit budget removes
 * machine contention as a source of red without weakening any assertion — a real
 * hang still fails, it just takes longer to say so.
 */
const SPAWN_TIMEOUT_MS = 120_000;

describe("validate-readiness-artifacts CLI", () => {
  it("rejects the removed --previous-ledger option", () => {
    expect(() => execFileSync(process.execPath, [
      resolve("dist/scripts/validate-readiness-artifacts.js"),
      "--mode", "public",
      "--previous-ledger", "old.json",
    ], { cwd: process.cwd(), encoding: "utf-8", stdio: "pipe" })).toThrow();
  }, SPAWN_TIMEOUT_MS);
});

// ---------------------------------------------------------------------------
// m4(r4): the residual's durability — two things nothing previously asserted.
//
// 1. Nothing asserted the pins-inert `notice:` actually fires on stderr. A CLI
//    refactor could delete the `console.error` call in
//    validate-readiness-artifacts.ts and no test would fail.
// 2. Nothing asserted `TRACKED_ARTIFACT_ROOT` resolves correctly from the
//    SHIPPED `dist/` layout specifically. `ledger-pins.test.ts` only pins a
//    tautology (`isTrackedArtifactRoot(TRACKED_ARTIFACT_ROOT)`, true for any
//    value) and the `isTrackedArtifactRoot(artifactRoot)` assertion in
//    `tracked-artifacts-readiness.test.ts` ("runs with the tracked pin table in
//    force for this root") only exercises the `src/` layout vitest runs
//    against. The `npm run
//    validate-readiness-artifacts` script runs the COMPILED `dist/` output —
//    that is the exact path operators use — so a build-layout change
//    (tsconfig `rootDir`/`outDir`, or moving `ledger-pins.ts` a directory
//    deeper) that silently mis-resolves `TRACKED_ARTIFACT_ROOT` there would
//    disable the pins in production with every other test still green.
//
// Per the review's warning: running the validator proves nothing unless the
// pins are actually engaged (no `notice:` on stderr for the tracked-root run).
// Both tests below check that explicitly rather than assuming it.
// ---------------------------------------------------------------------------
describe("validate-readiness-artifacts CLI — pins-inert notice and dist-layout root resolution (m4(r4))", () => {
  const repoRoot = process.cwd();
  const trackedArtifactRoot = resolve(repoRoot, "quality-contracts", "agent-readiness");
  const cliPath = resolve("dist/scripts/validate-readiness-artifacts.js");

  /**
   * Spawn the compiled CLI and return its REAL exit status, stdout AND stderr.
   *
   * WHY `spawnSync` AND NOT `execFileSync`. `execFileSync` returns only stdout,
   * so the previous form of this helper had to fabricate `stderr: ""` on the
   * success path. Two assertions below check `stderr` is EMPTY in order to prove
   * the tracked ledger pins were in force (an empty stderr means the CLI printed
   * no pins-inert `notice:`) — and a hardcoded `""` made exactly those two
   * assertions tautologies, i.e. the load-bearing ones proved nothing. Both
   * streams are now captured from the child on both the success and the failure
   * path, so an unexpected `notice:` (or any other diagnostic) fails the test.
   *
   * `env` exists for the copy-root case only; see its call site.
   */
  function run(
    args: readonly string[],
    options: { readonly env?: NodeJS.ProcessEnv } = {},
  ): { status: number; stdout: string; stderr: string } {
    const child = spawnSync(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      encoding: "utf-8",
      env: options.env ?? process.env,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (child.error) throw child.error;
    return {
      status: child.status ?? 1,
      stdout: child.stdout ?? "",
      stderr: child.stderr ?? "",
    };
  }

  it("TRACKED_ARTIFACT_ROOT, computed from the COMPILED dist module, equals the real tracked artifact root", async () => {
    // Direct check of the dist-layout claim in ledger-pins.ts's own docblock
    // ("src/readiness/ledger-pins.ts and dist/readiness/ledger-pins.js are
    // both two directories below the repository toplevel"). This imports the
    // BUILT file, not the TypeScript source, so a tsconfig rootDir/outDir
    // change or a file move that breaks that claim fails here even though the
    // src-side test would not notice — that one is
    // `tracked-artifacts-readiness.test.ts`'s "runs with the tracked pin table
    // in force for this root", which checks the SRC-layout
    // `isTrackedArtifactRoot(artifactRoot)` and nothing about `dist/`.
    const distModule = (await import(
      pathToFileURL(resolve(repoRoot, "dist/readiness/ledger-pins.js")).href
    )) as { TRACKED_ARTIFACT_ROOT: string };
    expect(distModule.TRACKED_ARTIFACT_ROOT).toBe(trackedArtifactRoot);
  });

  it("emits no pins-inert notice for the tracked root — pins are engaged in the shipped dist CLI", () => {
    // WHICH PATH THIS TEST EXERCISES: the TRACKED ROOT, and only that. It passes
    // no `--artifact-root`, so the CLI infers
    // `resolve(cwd, "quality-contracts", "agent-readiness")` with `cwd` the repo
    // root — the real tracked root, with TRACKED_LEDGER_APPROVAL_PINS in force.
    // The empty-stderr assertion is what proves the pins engaged, and it is only
    // a real assertion now that `run()` returns the child's actual stderr.
    //
    // The default invocation (no --artifact-root): the CLI infers
    // resolve(cwd, "quality-contracts", "agent-readiness"), which is the
    // tracked root when cwd is the repo root, as it is under `npm run`. If
    // dist's TRACKED_ARTIFACT_ROOT ever resolved somewhere else, this run
    // would print the "notice:" line below and the pin rules would be inert —
    // exactly the trap the constraints in this task warn about.
    const result = run(["--mode", "public", "--json"]);
    expect(result.stderr).toBe("");
    const parsed = JSON.parse(result.stdout) as {
      ok: boolean;
      checkpointStatus: Record<string, string>;
      issues: Array<{ code: string }>;
      ledgerPinScope: string;
    };
    // v6 (checkpoint-approvals-v6.json) records the two v2 approvals as
    // validly retracted, so the temporal defect they carried no longer blocks
    // closure: `ok` is true and the two `ledger-supersession-not-later`
    // findings are gone. At v6, C2 stayed open — retracting a superseder does
    // not resurrect the approval it superseded (Model B), so neither Gold nor
    // QA had any valid approval left for C2. v7 (checkpoint-approvals-v7.json)
    // appends real gold/QA approvals of the corrected target with a truthful
    // `decidedAt` after the target existed, which pass the temporal check the
    // v2s failed — so C2 now closes.
    expect(parsed.ok).toBe(true);
    expect(parsed.checkpointStatus.C2).toBe("closed");
    expect(
      parsed.issues.filter((i) => i.code === "ledger-supersession-not-later"),
    ).toHaveLength(0);
    // The machine-readable form of the empty-stderr claim above. Both are
    // asserted deliberately: stderr proves the CLI printed no notice, the field
    // proves the VALIDATOR agreed, and a regression that desynchronised them
    // (e.g. a notice condition that stops matching the scope decision) fails
    // here rather than passing on the strength of one channel.
    expect(parsed.ledgerPinScope).toBe("tracked");
  }, SPAWN_TIMEOUT_MS);

  it("engages the pins from a working directory that is NOT the repository root", () => {
    // WHY THIS EXISTS. The CLI used to default its artifact root to
    // `resolve(process.cwd(), "quality-contracts", "agent-readiness")`, so the
    // tracked pin table engaged only because `npm run` sets the child's cwd to
    // the package directory. That is a property of npm, not of the command:
    // the same CLI run from anywhere else inferred some other root, the pins
    // went inert, and the only trace was a stderr `notice:` nobody reading
    // stdout sees. The default is now `TRACKED_ARTIFACT_ROOT`, derived from the
    // compiled module's own location, so validating anything else is an explicit
    // `--artifact-root` opt-out.
    //
    // The cwd here is the OS temp directory, which contains no
    // `quality-contracts/` at all — under the old default the run would have
    // failed outright (no artifact root, no git toplevel) rather than merely
    // losing the pins, so an empty stderr plus `ledgerPinScope: "tracked"` here
    // cannot be produced by the old behaviour.
    //
    // NEUTER CHECK: restore the cwd-relative default in
    // validate-readiness-artifacts.ts and this test is the one that fails.
    const child = spawnSync(process.execPath, [cliPath, "--mode", "public", "--json"], {
      cwd: tmpdir(),
      encoding: "utf-8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (child.error) throw child.error;
    expect(child.stderr ?? "").toBe("");
    const parsed = JSON.parse(child.stdout ?? "") as {
      ok: boolean;
      checkpointStatus: Record<string, string>;
      issues: Array<{ code: string }>;
      ledgerPinScope: string;
    };
    expect(parsed.ledgerPinScope).toBe("tracked");
    // Same post-v7 state as the previous test: v6's retraction removes the
    // temporal-defect findings, and v7's two corrected gold/QA approvals close
    // C2 — see the comment there for the full history.
    expect(parsed.ok).toBe(true);
    expect(parsed.checkpointStatus).toEqual({
      C0: "closed", C1: "closed", C2: "closed", C3: "open", C4: "open", C5: "open",
    });
    expect(
      parsed.issues.filter((i) => i.code === "ledger-supersession-not-later"),
    ).toHaveLength(0);
    expect(parsed.issues).toHaveLength(0);
  }, SPAWN_TIMEOUT_MS);

  it("emits the pins-inert notice on stderr for a byte-identical copy at a non-tracked root, with an otherwise IDENTICAL result", () => {
    // WHICH PATHS THIS TEST EXERCISES: BOTH, deliberately, and it compares them.
    // The `tracked` run below is the TRACKED-ROOT path (explicit
    // `--artifact-root <trackedArtifactRoot>`, pins in force, stderr must be
    // empty). The `copy` run is the COPY path (pins inert, `notice:` required).
    //
    // WHY THE TEMP DIRECTORY IS OUTSIDE THE REPOSITORY. It used to be
    // `mkdtempSync(resolve(repoRoot, ".readiness-cli-tmp-"))`, which
    // `git check-ignore` does NOT ignore: a SIGKILL or a `--bail` abort between
    // `cpSync` and the `finally` left an untracked duplicate of the whole
    // governance graph in the working tree. It is now under `os.tmpdir()`, the
    // convention every other suite in this repo already uses.
    //
    // WHY THE COPY RUN NEEDS AN EXPLICIT GIT CONTEXT — AND WHY THAT DOES NOT
    // CHANGE WHAT THIS TEST PROVES. The CLI resolves the repository toplevel by
    // running `git rev-parse --show-toplevel` with `cwd` set to the ARTIFACT
    // ROOT, and refuses to run at all when that fails ("the readiness gate
    // requires git to recompute checkpoint targets"). While the copy sat inside
    // the repository it inherited the repository's git context implicitly; under
    // `os.tmpdir()` it inherits none, and the CLI exits 1 with an `error:` and no
    // JSON at all. Two wrong ways to paper over that were measured and rejected:
    // leaving the copy outside git (no output to compare), and `git init`-ing the
    // temp root (its own empty object database cannot resolve the checkpoint
    // target commits, which turns C0 and C1 from `closed` to `open` and adds
    // 6 x `checkpoint-recompute-failed` + 6 x `summary-input-hash-mismatch` —
    // a DIFFERENT governance outcome, which would silently destroy the very
    // "identical result" claim this test exists to make).
    //
    // So the copy run is handed the repository's own git context explicitly. That
    // restores exactly the resolution the in-repo location used to supply
    // implicitly — verified: `ok:false`, `C0/C1 closed`, `C2 open`,
    // 7 x `index-path-mismatch`, 2 x `ledger-supersession-not-later`, identical
    // to the old in-repo copy — while leaving the ARTIFACT ROOT outside the
    // tracked root, which is the one variable under test.
    const tmpRoot = mkdtempSync(join(tmpdir(), "readiness-cli-"));
    try {
      const copyRoot = resolve(tmpRoot, "agent-readiness");
      cpSync(trackedArtifactRoot, copyRoot, { recursive: true });

      const copyEnv: NodeJS.ProcessEnv = {
        ...process.env,
        GIT_DIR: resolve(repoRoot, ".git"),
        GIT_WORK_TREE: repoRoot,
      };

      const tracked = run(["--mode", "public", "--json", "--artifact-root", trackedArtifactRoot]);
      const copy = run(["--mode", "public", "--json", "--artifact-root", copyRoot], {
        env: copyEnv,
      });

      expect(tracked.stderr).toBe("");
      expect(copy.stderr).toMatch(
        /notice: .* is not this repository's tracked artifact root/,
      );
      expect(copy.stderr).toContain("TRACKED_LEDGER_APPROVAL_PINS is NOT in force");

      const trackedResult = JSON.parse(tracked.stdout) as {
        ok: boolean;
        checkpointStatus: Record<string, string>;
        issues: Array<{ code: string; artifactId?: string }>;
        ledgerPinScope: string;
      };
      const copyResult = JSON.parse(copy.stdout) as typeof trackedResult;

      // THE SCOPE, ON THE MACHINE-READABLE CHANNEL. This is the assertion a
      // programmatic consumer needs and could not previously make: the two runs
      // differ in whether the pins were in force, and the JSON now says so.
      // Asserting BOTH values in one test is what keeps the field from being
      // hardcodable — no literal satisfies "tracked" and "none" at once.
      expect(trackedResult.ledgerPinScope).toBe("tracked");
      expect(copyResult.ledgerPinScope).toBe("none");

      // The notice describes an INERT PIN LAYER, not a different governance
      // outcome for the LEDGER content specifically — for byte-identical,
      // unmodified ledger data the LEDGER findings must agree either way,
      // regardless of pin scope (both are empty post-v6: see below).
      //
      // `ok` itself is NOT compared for equality between the two runs. Post-v6
      // the tracked run has zero issues at all (`ok: true`), but the copy still
      // carries its own `index-path-mismatch` issues (asserted below) that are
      // ORTHOGONAL to the ledger/pin question this test exists to answer — the
      // artifact index declares paths rooted at the tracked location, so any
      // copy elsewhere trips that unrelated, pre-existing check. Asserting the
      // literal values here (rather than an equality that no longer holds for
      // an unrelated reason) is the honest post-retraction expectation.
      expect(trackedResult.ok).toBe(true);
      expect(copyResult.ok).toBe(false);
      expect(
        copyResult.issues.filter((i) => i.code === "ledger-supersession-not-later"),
      ).toEqual(trackedResult.issues.filter((i) => i.code === "ledger-supersession-not-later"));

      // No PIN-related issue appears for the copy: the table is genuinely
      // inert there (as opposed to "in force but reporting nothing wrong"),
      // which is the property the notice is announcing.
      for (const code of ["ledger-approval-pin-missing", "ledger-approval-pin-absent", "ledger-approval-pin-mismatch"]) {
        expect(copyResult.issues.some((i) => i.code === code)).toBe(false);
      }

      // The copy DOES pick up `index-path-mismatch` — the artifact-index
      // declares paths rooted at `quality-contracts/agent-readiness`, so a
      // copy elsewhere trips that unrelated, pre-existing check. That is
      // orthogonal to the ledger-pins control under test here (matches the
      // round-4 review's own reproduction of the same phenomenon), so it is
      // asserted explicitly rather than folded into a "results are identical"
      // claim that would be false for reasons this test does not care about.
      expect(
        copyResult.issues.filter((i) => i.code === "index-path-mismatch").length,
      ).toBeGreaterThan(0);
      expect(trackedResult.issues.some((i) => i.code === "index-path-mismatch")).toBe(false);

      // AND THAT IS WHY THE CHECKPOINT MAPS ARE NOT COMPARED FOR EQUALITY.
      // This test used to assert `copyResult.checkpointStatus` EQUALS the
      // tracked one, which meant it was asserting that the copy printed
      // `✓ C0: closed` and `✓ C1: closed` beside `ok: false` and exit 1 — the
      // display defect, frozen into an expectation. `index-path-mismatch` is
      // keyed to an index row's artifactId, so the closure gate could not
      // attribute it to any checkpoint and it held none open; an index that does
      // not describe the files being validated attests nothing, so every
      // checkpoint is now correctly open for the copy.
      //
      // The tracked side is asserted here too, and it is the load-bearing half:
      // widening what blocks closure must NOT stop a checkpoint that legitimately
      // closes. C0/C1 close on the tracked root because it carries zero issues at
      // all post-v7 (the two `ledger-supersession-not-later` findings that v6
      // cleared are gone, and no other issue is attributable to any checkpoint),
      // and C2 now closes too — v7's two corrected gold/QA approvals pass the
      // temporal check the retracted v2s failed.
      expect(trackedResult.checkpointStatus).toEqual({
        C0: "closed", C1: "closed", C2: "closed", C3: "open", C4: "open", C5: "open",
      });
      // The copy's checkpoint map is UNCHANGED by v7: `index-path-mismatch` is an
      // issue the closure gate cannot attribute to any single checkpoint, so it
      // widens to hold EVERY checkpoint open (see the comment above) regardless
      // of what the ledger's approval rows say — C2 having two valid v7 approvals
      // does not override a global, unattributable blocking issue. Verified
      // directly against the built CLI: the copy still reports all six
      // checkpoints open.
      expect(copyResult.checkpointStatus).toEqual({
        C0: "open", C1: "open", C2: "open", C3: "open", C4: "open", C5: "open",
      });
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, SPAWN_TIMEOUT_MS);

  // ─────────────────────────────────────────────────────────────────────────────
  // THE CASE NOTHING EXERCISED, WHICH IS WHY A FALSE CLAIM SURVIVED.
  //
  // The test above hands its copy the repository's git context explicitly
  // (`GIT_DIR`/`GIT_WORK_TREE`), so it measures the FAVOURABLE form of "point the
  // gate at a copy": one that can still resolve a git toplevel. A `git worktree`
  // copy is the same favourable case. Neither is the commonest form — a plain
  // `cp -R` of `quality-contracts/agent-readiness` to a directory outside any
  // worktree, which carries no git context at all.
  //
  // For that form the CLI hit the `git rev-parse` hard stop BEFORE it printed the
  // pins-inert `notice:` and before any `--json` output, so the documented claim
  // (a copy is an explicit opt-out, "announced both by a `notice:` on stderr and
  // by `\"ledgerPinScope\": \"none\"` in `--json`") was false there: measured
  // `exit=1`, `stdout bytes: 0`, no `notice:`, no `ledgerPinScope`. Every
  // pins-inert assertion in this file passed while that was true, because every
  // one of them supplied git context.
  //
  // NEUTER CHECK: move the `notice:` block in
  // `src/scripts/validate-readiness-artifacts.ts` back below the `git rev-parse`
  // try/catch, or drop the `if (args.json)` failure payload from that catch, and
  // this test is the one that fails. No other test in the repository covers it.
  // ─────────────────────────────────────────────────────────────────────────────
  it("publishes the pin scope on BOTH channels for a plain directory copy that carries no git context, then still fails hard", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "readiness-cli-nogit-"));
    try {
      const copyRoot = resolve(tmpRoot, "agent-readiness");
      cpSync(trackedArtifactRoot, copyRoot, { recursive: true });

      // The premise of this test, asserted rather than assumed: the copy really
      // is outside every git worktree. If `TMPDIR` ever sat inside a checkout,
      // `git rev-parse` would succeed and this test would silently degrade into a
      // duplicate of the git-context case above.
      const probe = spawnSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: copyRoot,
        encoding: "utf-8",
        env: gitlessEnv(),
      });
      expect(probe.status).not.toBe(0);

      const child = spawnSync(
        process.execPath,
        [cliPath, "--mode", "public", "--json", "--artifact-root", copyRoot],
        { cwd: tmpRoot, encoding: "utf-8", env: gitlessEnv(), maxBuffer: 64 * 1024 * 1024 },
      );
      if (child.error) throw child.error;
      const stdout = child.stdout ?? "";
      const stderr = child.stderr ?? "";

      // ── CHANNEL 1: the human channel, and its ORDER ────────────────────────
      // Both lines must be present, and the notice must come FIRST: the whole
      // defect was that the hard stop pre-empted the notice. Asserting only
      // "contains both" would pass if a future change re-ordered them and left
      // the notice buried under a fatal error the operator stops reading at.
      expect(stderr).toMatch(/notice: .* is not this repository's tracked artifact root/);
      expect(stderr).toContain("TRACKED_LEDGER_APPROVAL_PINS is NOT in force");
      expect(stderr).toContain("error: could not resolve git repository root");
      expect(stderr.indexOf("notice:")).toBeLessThan(stderr.indexOf("error: could not resolve"));

      // ── CHANNEL 2: the machine channel ─────────────────────────────────────
      // Previously zero bytes. A `--json` consumer had no way to distinguish
      // "the pins were inert" from "the tool did not run", because it got
      // neither statement.
      expect(stdout).not.toBe("");
      const parsed = JSON.parse(stdout) as {
        ok: boolean;
        checkpointStatus: Record<string, string>;
        checkedArtifacts: number;
        issues: Array<{ code: string; message: string }>;
        warnings: unknown[];
        ledgerPinScope: string;
      };
      expect(parsed.ledgerPinScope).toBe("none");

      // ── AND THE HARD STOP IS STILL HARD ───────────────────────────────────
      // Surfacing the diagnostic must not soften the gate: git is required to
      // recompute checkpoint targets from recorded-commit bytes, so a run that
      // cannot reach git validated nothing. Nothing may read `closed`, no
      // artifact may be reported as checked, and the exit code stays 1.
      expect(child.status).toBe(1);
      expect(parsed.ok).toBe(false);
      expect(parsed.checkedArtifacts).toBe(0);
      expect(parsed.checkpointStatus).toEqual({
        C0: "open", C1: "open", C2: "open", C3: "open", C4: "open", C5: "open",
      });
      expect(parsed.issues).toHaveLength(1);
      expect(parsed.issues[0]!.code).toBe("config-error");
      expect(parsed.issues[0]!.message).toContain("could not resolve git repository root");
      expect(parsed.warnings).toEqual([]);
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, SPAWN_TIMEOUT_MS);
});

/**
 * `process.env` with every git-context variable stripped.
 *
 * Inheriting the ambient environment is not good enough for the no-git case: a
 * `GIT_DIR`/`GIT_WORK_TREE` exported by the surrounding shell (or by the
 * git-context test above, were it ever changed to mutate `process.env`) would
 * hand the copy a resolvable toplevel and quietly delete the condition under
 * test. `GIT_CEILING_DIRECTORIES` is not used here — the assertion on the probe
 * is what proves the copy is outside git, and it uses this same environment.
 */
function gitlessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"]) {
    delete env[key];
  }
  return env;
}
