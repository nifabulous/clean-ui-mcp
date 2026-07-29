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
    };
    expect(parsed.ok).toBe(false);
    expect(parsed.checkpointStatus.C2).toBe("open");
    expect(
      parsed.issues.filter((i) => i.code === "ledger-supersession-not-later"),
    ).toHaveLength(2);
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
      };
      const copyResult = JSON.parse(copy.stdout) as typeof trackedResult;

      // The notice describes an INERT PIN LAYER, not a different governance
      // outcome — for byte-identical, unmodified data the checkpoint state and
      // the ledger findings must agree either way.
      expect(copyResult.ok).toBe(trackedResult.ok);
      expect(copyResult.checkpointStatus).toEqual(trackedResult.checkpointStatus);
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
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  }, SPAWN_TIMEOUT_MS);
});
