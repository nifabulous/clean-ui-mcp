/**
 * Readiness validation of the REAL tracked governance artifacts.
 *
 * Every other readiness test builds a synthetic artifact graph in a temp dir.
 * That is correct for exercising validator logic, but it left a gap: the suite
 * could be fully green while `validate-readiness-artifacts` failed on the
 * artifacts actually committed to `quality-contracts/agent-readiness/`. A
 * governance-data defect (a ledger claiming a decision that predates the target
 * it binds) is invisible to fixture-based tests by construction.
 *
 * This test closes that gap by asserting the real gate result against the state
 * the documentation claims, in BOTH modes the CLI supports. It is STRICTLY
 * READ-ONLY: it resolves the tracked artifact root, runs the pure validator, and
 * asserts. It never writes to `quality-contracts/`, `corpus/entries.json`, or
 * `corpus/decisions.json`.
 *
 * The public-mode block below is unconditional. The private-mode block is
 * conditional on the private inputs being present, because `corpus/entries.json`
 * and seven of the eight `eval/c2/label-integrity/**` evidence files are
 * gitignored and therefore absent from a fresh clone and from CI; see the
 * docstring on that block for why that is a data-availability gate and not a
 * relaxed expectation.
 *
 * WHEN THIS TEST FAILS, THE FIX IS ALMOST NEVER THE ASSERTION. A diff here
 * means either (a) the tracked governance data changed, in which case update
 * the expectations AND every document that states the checkpoint state, or
 * (b) a real regression. Do not relax an expectation to make the suite green.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateReadinessArtifacts } from "./validator.js";
import type { GitSourceResolver } from "./checkpoint-policy.js";

const repoRoot = resolve(__dirname, "../..");
const artifactRoot = resolve(repoRoot, "quality-contracts/agent-readiness");
const corpusPath = resolve(repoRoot, "corpus/entries.json");

/**
 * Git-backed resolver, mirroring the CLI's. The checkpoint recipes recompute
 * canonical targets from recorded-commit bytes, so real git is required — the
 * fake in-memory resolver used by the fixture tests cannot serve real commits.
 */
const gitSourceResolver: GitSourceResolver = {
  resolve(commit: string, repositoryPath: string): Uint8Array {
    return execFileSync("git", ["show", `${commit}:${repositoryPath}`], {
      cwd: repoRoot,
      maxBuffer: 64 * 1024 * 1024,
    });
  },
};

describe("tracked readiness artifacts (real data, read-only)", () => {
  const result = validateReadinessArtifacts({
    artifactRoot,
    repoRoot,
    gitSourceResolver,
    mode: "public",
  });

  it("reports the checkpoint state the documentation claims", () => {
    // C2 is OPEN. The two effective C2 approvals in checkpoint-approvals-v5.json
    // (`c2-gold-reviewer-gold-v2`, `c2-qa-reviewer-qa-v2`) each copied the
    // `decidedAt` of the v1 approval they supersede, so each claims a decision
    // taken before the target it binds (cf55fee0…) existed. No valid reviewer
    // decision for that target is recorded anywhere in the repository.
    //
    // C2 closes only when `reviewer-gold` and `reviewer-qa` each record a real
    // decision on the corrected target with a truthful `decidedAt`. See
    // docs/c2/c2-checkpoint-approval-handoff.md.
    expect(result.checkpointStatus).toEqual({
      C0: "closed",
      C1: "closed",
      C2: "open",
      C3: "open",
      C4: "open",
      C5: "open",
    });
  });

  it("reports exactly the two known governance-provenance issues", () => {
    // Blocking issues are enumerated exactly — a NEW issue code appearing here
    // is a regression, and a missing one means the governance data changed.
    expect(
      result.issues.map((i) => ({ code: i.code, artifactId: i.artifactId })).sort((a, b) =>
        `${a.code}${a.artifactId}`.localeCompare(`${b.code}${b.artifactId}`),
      ),
    ).toEqual([
      { code: "ledger-supersession-not-later", artifactId: "c2-gold-reviewer-gold-v2" },
      { code: "ledger-supersession-not-later", artifactId: "c2-qa-reviewer-qa-v2" },
    ]);
    expect(result.ok).toBe(false);
  });

  it("emits no external-QA closure caveat while C2 is open", () => {
    // `c2-external-qa-unverifiable` is emitted only when C2 actually closes.
    // Asserting its ABSENCE pins the coupling: if this warning reappears while
    // the C2 expectation above still says "open", the two have drifted apart.
    expect((result.warnings ?? []).map((w) => w.code)).toEqual([]);
  });
});

/**
 * The same tripwire in PRIVATE mode. Private mode adds two things public mode
 * never touches: corpus identity (`corpusSha256` / `corpusEntryCount` / the
 * exact entry-ID leak scan) and `verifyPrivateC2Evidence`, which hashes and
 * schema-validates all eight `eval/c2/label-integrity/**` evidence files named
 * by `c2-evidence-manifest-v1.json`. Without this block a private-only drift
 * (an evidence byte change, a corpus re-export) leaves the suite green while
 * `validate-readiness-artifacts --mode private` fails.
 *
 * WHY THIS IS CONDITIONAL. `corpus/entries.json` is gitignored (`.gitignore:35`)
 * and seven of the eight evidence files are untracked, so a fresh clone and CI
 * simply do not have the private inputs. Asserting unconditionally would make
 * the suite fail on every checkout that lacks them — a false red, not a
 * tripwire. So the private inputs are probed for presence and the assertions
 * skip when they are absent. This is a data-availability gate, NOT a relaxation:
 * wherever the private inputs exist (any maintainer working tree — the only
 * place `--mode private` can be run at all), the expectations below are exactly
 * as strict as the public ones. Read-only throughout: the corpus and the
 * manifest are read to probe presence, nothing is written.
 */
const privateEvidencePaths: readonly string[] = (() => {
  try {
    const manifest = JSON.parse(
      readFileSync(resolve(artifactRoot, "c2-evidence-manifest-v1.json"), "utf-8"),
    ) as { evidence?: Array<{ path: string }> };
    return (manifest.evidence ?? []).map((row) => resolve(repoRoot, row.path));
  } catch {
    return [];
  }
})();

const privateInputsPresent =
  existsSync(corpusPath) &&
  privateEvidencePaths.length > 0 &&
  privateEvidencePaths.every((path) => existsSync(path));

describe("tracked readiness artifacts, private mode (real data, read-only)", () => {
  const privateResult = privateInputsPresent
    ? validateReadinessArtifacts({
        artifactRoot,
        repoRoot,
        gitSourceResolver,
        mode: "private",
        corpusPath,
      })
    : undefined;

  it.skipIf(!privateInputsPresent)(
    "reports the same checkpoint state and issues as public mode",
    () => {
      // The documentation states one C2 state, not one per mode. Private mode
      // must agree with public mode: same checkpoint status, same blocking
      // issues, same (empty) warnings. A private-only issue code appearing here
      // is a real regression in the evidence or corpus data.
      expect(privateResult!.checkpointStatus).toEqual({
        C0: "closed",
        C1: "closed",
        C2: "open",
        C3: "open",
        C4: "open",
        C5: "open",
      });
      expect(
        privateResult!.issues.map((i) => ({ code: i.code, artifactId: i.artifactId })).sort((a, b) =>
          `${a.code}${a.artifactId}`.localeCompare(`${b.code}${b.artifactId}`),
        ),
      ).toEqual([
        { code: "ledger-supersession-not-later", artifactId: "c2-gold-reviewer-gold-v2" },
        { code: "ledger-supersession-not-later", artifactId: "c2-qa-reviewer-qa-v2" },
      ]);
      expect(privateResult!.ok).toBe(false);
      expect((privateResult!.warnings ?? []).map((w) => w.code)).toEqual([]);
    },
  );

  it.skipIf(!privateInputsPresent)(
    "surfaces no corpus-identity or private-evidence issue",
    () => {
      // Explicitly enumerate the private-only codes so a corpus re-export or an
      // evidence rewrite names itself here rather than hiding inside a generic
      // count assertion.
      const privateOnlyCodes = [
        "config-error",
        "corpus-unreadable",
        "corpus-hash-mismatch",
        "corpus-count-mismatch",
        "leak",
        "c2-evidence-unavailable",
        "c2-evidence-hash-mismatch",
        "c2-evidence-identity-mismatch",
        "c2-evidence-schema-invalid",
        "c2-evidence-set-mismatch",
        "c2-evidence-duplicate-id",
        "c2-evidence-duplicate-path",
        "c2-evidence-path-escape",
      ];
      expect(
        privateResult!.issues
          .filter((i) => privateOnlyCodes.includes(i.code))
          .map((i) => `${i.code}:${i.path ?? i.artifactId ?? ""}`),
      ).toEqual([]);
    },
  );
});
