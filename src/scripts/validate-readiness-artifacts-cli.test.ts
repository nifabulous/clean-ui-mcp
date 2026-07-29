import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

describe("validate-readiness-artifacts CLI", () => {
  it("rejects the removed --previous-ledger option", () => {
    expect(() => execFileSync(process.execPath, [
      resolve("dist/scripts/validate-readiness-artifacts.js"),
      "--mode", "public",
      "--previous-ledger", "old.json",
    ], { cwd: process.cwd(), encoding: "utf-8", stdio: "pipe" })).toThrow();
  });
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
//    value) and `tracked-artifacts-readiness.test.ts:185` only exercises the
//    `src/` layout vitest runs against. The `npm run
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

  function run(
    args: readonly string[],
  ): { status: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync(process.execPath, [cliPath, ...args], {
        cwd: repoRoot,
        encoding: "utf-8",
        stdio: "pipe",
      });
      return { status: 0, stdout, stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { status: err.status ?? 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
    }
  }

  it("TRACKED_ARTIFACT_ROOT, computed from the COMPILED dist module, equals the real tracked artifact root", async () => {
    // Direct check of the dist-layout claim in ledger-pins.ts's own docblock
    // ("src/readiness/ledger-pins.ts and dist/readiness/ledger-pins.js are
    // both two directories below the repository toplevel"). This imports the
    // BUILT file, not the TypeScript source, so a tsconfig rootDir/outDir
    // change or a file move that breaks that claim fails here even though the
    // src-side test (tracked-artifacts-readiness.test.ts:185) would not
    // notice.
    const distModule = (await import(
      pathToFileURL(resolve(repoRoot, "dist/readiness/ledger-pins.js")).href
    )) as { TRACKED_ARTIFACT_ROOT: string };
    expect(distModule.TRACKED_ARTIFACT_ROOT).toBe(trackedArtifactRoot);
  });

  it("emits no pins-inert notice for the tracked root — pins are engaged in the shipped dist CLI", () => {
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
  });

  it("emits the pins-inert notice on stderr for a byte-identical copy at a non-tracked root, with an otherwise IDENTICAL result", () => {
    const tmpRoot = mkdtempSync(resolve(repoRoot, ".readiness-cli-tmp-"));
    try {
      const copyRoot = resolve(tmpRoot, "agent-readiness");
      cpSync(trackedArtifactRoot, copyRoot, { recursive: true });

      const tracked = run(["--mode", "public", "--json", "--artifact-root", trackedArtifactRoot]);
      const copy = run(["--mode", "public", "--json", "--artifact-root", copyRoot]);

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
  });
});
