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
 * THIS TEST REQUIRES FULL GIT HISTORY, AND FULL HISTORY IS NOT ENOUGH. The
 * public-mode block is unconditional, but it is NOT environment-independent: the
 * checkpoint recipes bind historical commits (~325 commits back at the deepest)
 * and the resolver above shells out to `git show <commit>:<path>` to recompute
 * canonical targets. Two distinct environment failures follow, and they are
 * often confused because both surface as `checkpoint-recompute-failed`:
 *
 *   DEPTH. In a shallow clone the bound objects are absent, the resolver throws,
 *   and `validator.ts` fails closed for every active checkpoint — C0 AND C1 both
 *   reported open, ~14 issues. `.github/workflows/ci.yml` therefore checks out
 *   with `fetch-depth: 0`. Measured: that alone closes C1 and takes the count to
 *   10.
 *
 *   REACHABILITY. `fetch-depth: 0` fetches every REMOTE ref and cannot conjure
 *   an object no remote ref reaches. C0's recipe binds `C0_SOURCE_GIT_SHA`
 *   (checkpoint-policy.ts), which at the time of writing is reachable only from
 *   the UNPUSHED local branch `Website-design`. So C0 recomputes locally and not
 *   on CI, and stays open there with two `checkpoint-recompute-failed` rows and
 *   six `summary-input-hash-mismatch` rows, every one naming that one commit.
 *   The fix is to push a ref that reaches it — a maintainer's publish decision,
 *   not a test or workflow change.
 *
 * The tests are deliberately NOT guarded on either condition: a self-skip would
 * make the only mechanical enforcement of C2-open silently inert exactly where it
 * matters most.
 *
 * WHEN THIS TEST FAILS, THE FIX IS NEVER THE ASSERTION ALONE. Work out which of
 * three things happened before touching anything:
 *
 *   (a) A REGRESSION — the validator changed behaviour against unchanged data.
 *       Fix the validator. Do not relax the expectation.
 *   (b) THE TRACKED GOVERNANCE DATA CHANGED. Then the question is whether the
 *       change was legitimate. The ONLY legitimate way this chain grows is by
 *       APPENDING a successor ledger, which leaves every existing approval row
 *       byte-identical; that is a real governance event, and it is updated here
 *       AND in every document that states the checkpoint state, in the same
 *       change, together with the new ledger's entry in
 *       `TRACKED_LEDGER_APPROVAL_PINS`. An in-place edit to an existing row is
 *       NOT legitimate, and the per-test docstring at the pin tripwire below
 *       spells out the consequence: do not update the pinned digest to match
 *       edited data.
 *   (c) THE ENVIRONMENT CANNOT RESOLVE THE BOUND COMMITS — a shallow clone, a
 *       checkout with no `.git`, or a bound commit that no fetched ref reaches.
 *       The tell is `checkpoint-recompute-failed` in the issue list together with
 *       a checkpoint open that no data edit inside `quality-contracts/` could
 *       open: C0 and C1 both open means DEPTH; C0 alone open with every failing
 *       row naming one commit means REACHABILITY (see above). Fix the checkout —
 *       `git fetch --unshallow` / `fetch-depth: 0` for the first, pushing a ref
 *       that reaches the commit for the second. Do not skip the test and do not
 *       relax the expectation.
 *
 * No branch is "make the suite green". Nothing here is a literal to be refreshed
 * until it stops complaining.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateReadinessArtifacts } from "./validator.js";
import {
  TRACKED_LEDGER_APPROVAL_PINS,
  isTrackedArtifactRoot,
  ledgerApprovalRowsDigest,
} from "./ledger-pins.js";
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

  it("holds every tracked ledger's approval rows to its source pin", () => {
    // THE TRIPWIRE FOR AN IN-PLACE LEDGER EDIT. Editing two `decidedAt` fields
    // in `checkpoint-approvals-v5.json` used to flip this whole gate from
    // `ok: false` / `C2: open` to `ok: true` / `C2: closed` / no issues, because
    // the append-only check compares each ledger against its PREDECESSOR's rows
    // and the head's own rows were attested by nothing in the artifact graph.
    // `TRACKED_LEDGER_APPROVAL_PINS` anchors them from outside the graph.
    //
    // IF THIS FAILS, DO NOT UPDATE THE LITERAL TO MATCH THE DATA. A diff here
    // means the tracked ledger's approval rows changed. The only legitimate way
    // to change them is to APPEND a successor ledger (the chain's append-only
    // growth), which leaves these rows byte-identical and this assertion green.
    // A mismatch means rows were edited in place — the defect class this pin
    // exists to catch.
    // Re-derived from the file at each PINNED PATH — the same lookup the
    // validator performs. Keying on the path rather than on the ledger's own
    // `artifactId` is what makes a rename inert: the digest below is unchanged by
    // any edit to the file's header.
    for (const [pinnedPath, digest] of Object.entries(TRACKED_LEDGER_APPROVAL_PINS)) {
      const ledger = JSON.parse(
        readFileSync(resolve(artifactRoot, pinnedPath), "utf-8"),
      ) as { artifactId: string; approvals: unknown[] };
      expect(digest).toBe(ledgerApprovalRowsDigest(ledger.approvals));
    }
    expect(result.issues.some((i) => i.code === "ledger-approval-pin-mismatch")).toBe(false);
  });

  it("has a pin registered for every tracked ledger FILE, and a file for every pin", () => {
    // COVERAGE, IN BOTH DIRECTIONS. Comparison alone failed open twice, and each
    // failure was reproduced against a worktree copy of this graph:
    //
    //   - the lookup key used to be a field inside the artifact being pinned, so
    //     renaming `artifactId` skipped the pin (and renaming ALL FIVE ids with
    //     the four `predecessor.sha256` values repaired defeated the chain
    //     coverage rule added to catch that). The key is now the file path.
    //   - coverage used to iterate the chain and never the table, so `rm` of the
    //     three newest ledgers erased both blocking findings and produced
    //     `ok: true` with zero issues. Rule B now iterates the table.
    //
    // The assertions below are those two rules read from the data side: every
    // tracked ledger file is pinned, every pin names a file that exists, and the
    // gate reports neither coverage failure. IF A NEW LEDGER IS APPENDED, add its
    // pin — do not delete these assertions or drop a ledger from the table.
    expect(result.issues.some((i) => i.code === "ledger-approval-pin-missing")).toBe(false);
    expect(result.issues.some((i) => i.code === "ledger-approval-pin-absent")).toBe(false);
    for (const pinnedPath of Object.keys(TRACKED_LEDGER_APPROVAL_PINS)) {
      expect(existsSync(resolve(artifactRoot, pinnedPath))).toBe(true);
    }
    expect(Object.keys(TRACKED_LEDGER_APPROVAL_PINS).sort()).toEqual([
      "checkpoint-approvals-v1.json",
      "checkpoint-approvals-v2.json",
      "checkpoint-approvals-v3.json",
      "checkpoint-approvals-v4.json",
      "checkpoint-approvals-v5.json",
    ]);
  });

  it("runs with the tracked pin table in force for this root", () => {
    // The one thing that makes rule B (a pin whose file is gone is blocking)
    // meaningful: the table is in force because the directory being validated IS
    // this repository's artifact root, decided from the module's own location and
    // from no file's contents. If this ever reports false, every pin rule above
    // is inert and the two assertions in this block prove nothing.
    expect(isTrackedArtifactRoot(artifactRoot)).toBe(true);
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
