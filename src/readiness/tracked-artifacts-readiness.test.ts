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
 * THREE BLOCKS, AND THE THIRD EXISTS BECAUSE THE FIRST TWO HAD A BLIND SPOT.
 * The public-mode block is unconditional. The private-mode block is conditional
 * on the private inputs being present, because `corpus/entries.json` and seven
 * of the eight `eval/c2/label-integrity/**` evidence files are gitignored and
 * therefore absent from a fresh clone and from CI; see the docstring on that
 * block for why that is a data-availability gate and not a relaxed expectation.
 * That gate is also a hole: the configuration it skips — private mode with the
 * evidence ABSENT — is a real configuration that CI and every fresh clone run,
 * and a closure-attribution regression that only appears there was invisible to
 * both blocks. The third block covers it unconditionally, against a copy of the
 * real artifact root under a repo root that carries none of the private inputs.
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
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { validateReadinessArtifacts } from "./validator.js";
import { validateLedgerAppendOnly } from "./contracts.js";
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
    // C2 is OPEN, cleanly. `checkpoint-approvals-v6.json` (appended by Task 5)
    // validly retracts both defective v2 approvals (`c2-gold-reviewer-gold-v2`,
    // `c2-qa-reviewer-qa-v2` — each had copied the `decidedAt` of the v1
    // approval it superseded, claiming a decision taken before the target it
    // binds, cf55fee0…, existed). The retractions are authorized by the same
    // human Repository Maintainer binding recorded on `c0-repo-maintainer`, so
    // both temporal findings that used to hold C2 open are now suppressed for
    // those two approval ids (see the next test).
    //
    // C2 does not flip to "closed" as a side effect of the retraction, though.
    // Model B (validator.ts, `computeRetractedApprovalIds`) never resurrects an
    // approval a later approval superseded: retracting `c2-gold-reviewer-gold-v2`
    // removes IT from the effective set, but `c2-gold-reviewer-gold-v1` stays
    // excluded too, because `c2-gold-reviewer-gold-v2`'s own
    // `supersedesApprovalId` still names it (retracting a superseder does not
    // undo the supersession). Same for QA. So neither role has ANY approval left
    // in the effective set, and C2 is open for the honest reason — no valid
    // reviewer decision exists for the target — not because of a lingering
    // blocking issue.
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

  it("reports zero blocking issues now that the two defective C2 approvals are validly retracted", () => {
    // Before v6 (Task 5), this asserted exactly the two
    // `ledger-supersession-not-later` issues on `c2-gold-reviewer-gold-v2` and
    // `c2-qa-reviewer-qa-v2`. Appending v6's two valid retractions is the
    // legitimate governance event that clears them (Task 4's suppression path),
    // and no NEW issue code (in particular no `retraction-*` code, which would
    // mean the retractions themselves were rejected as unauthorized,
    // out-of-order, or malformed) takes their place. `ok: true` here reflects
    // "no blocking issue", not "every checkpoint closed" — C2 is still "open"
    // per the test above, honestly, because no valid approval exists for it.
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports no checkpoint-actor-separation-violation finding on the real gate", () => {
    // The actor-separation check (validator.ts) now runs over the
    // retracted-INCLUSIVE `cpStructural` set (structural-monotonicity fix, see
    // `docs/superpowers/plans/2026-07-31-retraction-structural-monotonicity-followup.md`),
    // so a valid retraction of a duplicate-actor approval can only ADD this
    // finding, never erase one that already fired. This assertion is implied
    // by the empty `result.issues` above, but is asserted explicitly here
    // because it is the one finding the structural-monotonicity fix is about:
    // if it ever reappears while the rest of this suite stays green, the
    // regression is specifically in the actor-separation channel, not the
    // policy-role channel the "codex regression" tests already cover.
    expect(result.issues.some((i) => i.code === "checkpoint-actor-separation-violation")).toBe(
      false,
    );
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
      "checkpoint-approvals-v6.json",
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

  it("reports ledgerPinScope: tracked for the tracked artifact root", () => {
    // THE SAME FACT AS THE BLOCK ABOVE, BUT ON THE CHANNEL A CONSUMER READS.
    // `isTrackedArtifactRoot` is a helper only this suite calls; `ledgerPinScope`
    // travels in the RESULT, so it is what `--json` publishes and what any
    // programmatic caller of `validateReadinessArtifacts` can act on. Before it
    // existed, an attested run and a run with the pins inert produced
    // indistinguishable JSON and the only difference was a stderr `notice:` no
    // machine reads.
    //
    // This is the only place the value "tracked" can be produced honestly for
    // the in-process validator — a fixture root can never yield it — so a
    // hardcoded field would have to disagree with either
    // `validate-readiness-artifacts.test.ts` ("reports ledgerPinScope: caller
    // …" / "… none …") or with this.
    expect(result.ledgerPinScope).toBe("tracked");
  });
});

/**
 * Task 5's own tripwire: v6 is the real ledger that appends the two retractions
 * of `c2-gold-reviewer-gold-v2` and `c2-qa-reviewer-qa-v2`. Unlike the block
 * above (which reads the CURRENT gate result), this block asserts the two
 * properties that make v6 a LEGITIMATE append rather than a rewrite:
 *
 *   1. v6's approvals are v5's approvals UNCHANGED, plus new rows after them
 *      (`validateLedgerAppendOnly` reports no deletion/mutation/reorder of the
 *      v5 prefix — the same check the real gate runs at every ledger boundary).
 *   2. The v6 PIN in `TRACKED_LEDGER_APPROVAL_PINS` is the thing that actually
 *      guards the two newly-appended retraction rows, NOT append-only.
 *      `validateLedgerAppendOnly` only ever compares a ledger against its
 *      PREDECESSOR's rows, so it can never see v6's own tail — exactly the hole
 *      `ledger-pins.ts`'s module docblock documents for the head of the chain.
 *      Once v6 has a real successor (v7+), append-only will start guarding v6's
 *      full row set including the retractions; until then, the path-keyed pin
 *      is the ONLY thing an editor of v6's retraction rows has to also edit
 *      (and that edit shows up as a source diff in `ledger-pins.ts`, not as
 *      silent governance data). So the control below is asserted against the
 *      PIN, not against `validateLedgerAppendOnly` — asserting the latter here
 *      would pass for the wrong reason and stop meaning anything the day v6
 *      stops being the head.
 */
describe("checkpoint-approvals-v6.json (Task 5's retraction ledger)", () => {
  const v5 = JSON.parse(
    readFileSync(resolve(artifactRoot, "checkpoint-approvals-v5.json"), "utf-8"),
  ) as { approvals: unknown[] };
  const v6 = JSON.parse(
    readFileSync(resolve(artifactRoot, "checkpoint-approvals-v6.json"), "utf-8"),
  ) as { approvals: Record<string, unknown>[] };

  it("carries v5's approvals unchanged as its prefix, with no deletion/mutation/reorder", () => {
    expect(v6.approvals.slice(0, v5.approvals.length)).toEqual(v5.approvals);
    expect(validateLedgerAppendOnly(v6 as never, v5 as never)).toEqual([]);
  });

  it("appends exactly the two expected retraction rows after the v5 prefix", () => {
    const appended = v6.approvals.slice(v5.approvals.length);
    expect(appended.map((r) => r["retractsApprovalId"])).toEqual([
      "c2-gold-reviewer-gold-v2",
      "c2-qa-reviewer-qa-v2",
    ]);
    expect(appended.every((r) => r["recordKind"] === "retraction")).toBe(true);
  });

  it("digests to exactly its registered pin", () => {
    expect(ledgerApprovalRowsDigest(v6.approvals)).toBe(
      TRACKED_LEDGER_APPROVAL_PINS["checkpoint-approvals-v6.json"],
    );
  });

  it("CORRECT CONTROL: the v6 PIN — not append-only — is what would catch a mutated or dropped retraction", () => {
    // A newly-appended row has no predecessor ledger to compare it against, so
    // `validateLedgerAppendOnly` cannot see a mutation or deletion inside v6's
    // own tail (see the block comment above). The path-keyed pin is the
    // mechanism that actually holds these two rows immutable right now.
    const pinEntry = TRACKED_LEDGER_APPROVAL_PINS["checkpoint-approvals-v6.json"];

    const withReasonMutated = {
      ...v6,
      approvals: v6.approvals.map((r, i) =>
        i === v6.approvals.length - 1 ? { ...r, reason: "a different reason" } : r,
      ),
    };
    expect(ledgerApprovalRowsDigest(withReasonMutated.approvals)).not.toBe(pinEntry);

    const withRetractionDropped = {
      ...v6,
      approvals: v6.approvals.slice(0, -1),
    };
    expect(ledgerApprovalRowsDigest(withRetractionDropped.approvals)).not.toBe(pinEntry);
  });

  it("leaves v5's own pin and digest untouched by the v6 migration", () => {
    // Digest stability: appending v6 must not change what v5's rows digest to,
    // or what pin they are held against.
    expect(ledgerApprovalRowsDigest(v5.approvals)).toBe(
      TRACKED_LEDGER_APPROVAL_PINS["checkpoint-approvals-v5.json"],
    );
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
      // must agree with public mode: same checkpoint status, same (now empty)
      // blocking issues, same (empty) warnings — v6's two valid retractions
      // clear the temporal findings in both modes identically. A private-only
      // issue code appearing here is a real regression in the evidence or
      // corpus data.
      expect(privateResult!.checkpointStatus).toEqual({
        C0: "closed",
        C1: "closed",
        C2: "open",
        C3: "open",
        C4: "open",
        C5: "open",
      });
      expect(privateResult!.issues).toEqual([]);
      expect(privateResult!.ok).toBe(true);
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

/**
 * THE CLEAN-CHECKOUT CONDITION, ASSERTED UNCONDITIONALLY. This block exists
 * because the two blocks above could not see the regression it pins.
 *
 * WHAT WENT WRONG. Closure attribution treats an issue it cannot tie to a
 * checkpoint as blocking EVERY checkpoint (fail-closed — see the attribution
 * comment in `validator.ts`). `verifyPrivateC2Evidence` keys its findings to the
 * evidence MANIFEST's artifactId, which is neither a checkpoint name nor an
 * approvalId, so before those findings were stamped `checkpoint: "C2"` a
 * checkout that merely LACKED the untracked evidence reported **C0 and C1
 * open** — checkpoints nothing in the run impeached, contradicting
 * `docs/AGENT_READINESS_STATUS.md`. Measured on clean per-commit worktrees,
 * private mode, the SAME ten issues in each: `origin/main` {C0 closed, C1
 * closed, C2 open}; the commit that widened attribution {C0 open, C1 open, C2
 * open}.
 *
 * WHY NEITHER BLOCK ABOVE CATCHES IT. The public-mode block never runs
 * `verifyPrivateC2Evidence` at all. The private-mode block is `skipIf`-gated on
 * the private inputs being PRESENT — which is precisely the negation of the
 * condition that triggers the defect. So the one configuration that reproduces
 * it (evidence absent) was the one configuration with no assertions, and the
 * full suite stayed green on the author's machine and on CI alike.
 *
 * HOW THIS REPRODUCES A CLEAN CHECKOUT WITHOUT ONE. The tracked artifact root is
 * copied to `<tmp>/quality-contracts/agent-readiness` and validated with
 * `repoRoot: <tmp>`. The governance data is the real data byte-for-byte, the git
 * resolver still serves the real recorded commits, and the recorded index paths
 * still resolve (the copy keeps its `quality-contracts/agent-readiness` suffix
 * under the new root, so no `index-path-mismatch` is manufactured) — but every
 * path the evidence manifest declares under `eval/` is ABSENT, exactly as on a
 * fresh clone, and so is the corpus. This runs everywhere, including CI, because
 * it needs no private inputs; it is therefore unconditional, unlike the block
 * above. Strictly read-only with respect to the repository: it copies out and
 * writes only under its own temp dir.
 *
 * WHAT IT PINS, AND HOW TO NEUTER IT. Remove the `checkpoint: "C2"` stamp in
 * `verifyPrivateC2Evidence` and the C0/C1 assertions fail while the issue-code
 * assertion still passes. Change the stamp to any other checkpoint and the
 * `checkpoint` assertion fails. The point is NOT that these findings are
 * harmless — they still hold C2 open and still force `ok: false`; the point is
 * that a C2-evidence problem must not be reported as a C0 or C1 problem.
 */
describe("tracked readiness artifacts, private mode with the private inputs ABSENT (clean-checkout condition)", () => {
  const tmpRepoRoot = mkdtempSync(join(tmpdir(), "readiness-clean-checkout-"));
  const tmpArtifactRoot = join(tmpRepoRoot, "quality-contracts", "agent-readiness");
  cpSync(artifactRoot, tmpArtifactRoot, { recursive: true });

  const cleanCheckoutResult = validateReadinessArtifacts({
    artifactRoot: tmpArtifactRoot,
    repoRoot: tmpRepoRoot,
    gitSourceResolver,
    mode: "private",
    // Absent, as on a fresh clone (`corpus/entries.json` is gitignored).
    corpusPath: join(tmpRepoRoot, "corpus", "entries.json"),
  });

  afterAll(() => {
    rmSync(tmpRepoRoot, { recursive: true, force: true });
  });

  it("holds C2 open and leaves C0 and C1 CLOSED when the private evidence is absent", () => {
    expect(cleanCheckoutResult.checkpointStatus).toEqual({
      C0: "closed",
      C1: "closed",
      C2: "open",
      C3: "open",
      C4: "open",
      C5: "open",
    });
  });

  it("reports every declared evidence path as unavailable, each attributed to C2", () => {
    const manifest = JSON.parse(
      readFileSync(resolve(artifactRoot, "c2-evidence-manifest-v1.json"), "utf-8"),
    ) as { evidence: Array<{ path: string }> };
    const unavailable = cleanCheckoutResult.issues.filter(
      (i) => i.code === "c2-evidence-unavailable",
    );
    // Every row, not "at least one": a partial resolution would mean the copy
    // accidentally carried some evidence and the condition is not the one named.
    expect(unavailable.map((i) => i.path).sort()).toEqual(
      manifest.evidence.map((row) => row.path).sort(),
    );
    // THE ATTRIBUTION ITSELF. Keyed to the manifest for identity, attributed to
    // C2 for closure — the two are different fields on purpose.
    expect(unavailable.map((i) => i.artifactId)).toEqual(unavailable.map(() => "c2-evidence-v1"));
    expect(unavailable.map((i) => i.checkpoint)).toEqual(unavailable.map(() => "C2"));
  });

  it("leaves `corpus-unreadable` wholly UNATTRIBUTED, and C0/C1 close anyway only because it is emitted after closure", () => {
    // THE SENTENCE THIS PINS, AND WHY IT NEEDED PINNING.
    // `docs/AGENT_READINESS_STATUS.md` said the absent-input rows were "all
    // attributed to C2, so C0 and C1 still close". Two reviewers caught that,
    // and the reason it survived is that this suite asserted the C2 stamp for
    // `c2-evidence-unavailable` (test above) and asserted `corpus-unreadable`
    // only as a COUNT in the code-multiset test below — nothing anywhere read
    // its attribution fields. They are empty: not `checkpoint`, not even
    // `artifactId`.
    //
    // WHY THAT IS COMPATIBLE WITH C0/C1 CLOSING, WHICH IS THE WHOLE POINT. An
    // issue the run cannot attribute holds EVERY checkpoint open (the widening
    // documented in `validator.ts`), so on the face of it this row should hold
    // C0 and C1 open on every clean clone. It does not, because the corpus check
    // is step 9 and `checkpointStatus` is already final when step 8's
    // `validateApprovalsAndCheckpoint` returns. Ordering is the mechanism, not
    // attribution.
    //
    // BOTH HALVES ARE ASSERTED TOGETHER DELIBERATELY. Separately, each is
    // satisfiable by a wrong implementation: the empty fields alone are also
    // consistent with C0/C1 being held open, and closed C0/C1 alone is also
    // consistent with someone having stamped a false `checkpoint: "C2"` here.
    // Only the pair states the real invariant.
    //
    // NEUTER CHECK (verified): move the step-9 corpus block ahead of the step-8
    // `validateApprovalsAndCheckpoint` call in `validator.ts` — the row's fields
    // are unchanged, but the C0/C1 assertions below fail. Alternatively stamp
    // `checkpoint: "C2"` on the push site and the `toBeUndefined()` assertion
    // fails, which is the guard against "correcting" the doc in the code by
    // asserting a Phase-0 input is C2 evidence.
    const corpus = cleanCheckoutResult.issues.filter((i) => i.code === "corpus-unreadable");
    expect(corpus).toHaveLength(1);
    expect(corpus[0]!.checkpoint).toBeUndefined();
    expect(corpus[0]!.artifactId).toBeUndefined();
    expect(cleanCheckoutResult.checkpointStatus.C0).toBe("closed");
    expect(cleanCheckoutResult.checkpointStatus.C1).toBe("closed");
  });

  it("runs with the tracked pin table INERT, and is not evidence about the pins", () => {
    // Stated so this block is not misread as pin coverage. The copy is not this
    // repository's artifact root, so `TRACKED_LEDGER_APPROVAL_PINS` is out of
    // force here and `ledgerPinScope` is "none" — which is why the two blocks
    // above, which DO run at the tracked root, are the pin tripwires and this one
    // is not. It is evidence about closure attribution only. The pin rules are
    // unaffected by that: the two `ledger-supersession-not-later` findings below
    // come from the ledger data itself, not from the pin table.
    expect(cleanCheckoutResult.ledgerPinScope).toBe("none");
  });

  it("still fails the gate, with no issue code beyond the absent private inputs and the known C2 provenance defect", () => {
    // The gate must stay RED. Restoring C0/C1 precision is not permission for
    // anything to go green: `ok` is still false, and the exact code multiset is
    // enumerated so a new code cannot appear here unnoticed.
    expect(cleanCheckoutResult.ok).toBe(false);
    const counts = new Map<string, number>();
    for (const issue of cleanCheckoutResult.issues) {
      counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
    }
    // The two `ledger-supersession-not-later` rows are gone here too — v6's
    // retractions clear them regardless of mode or of whether the private
    // evidence is present, since they are evaluated purely from the ledger
    // data. `ok` stays false on the strength of the absent-input rows alone.
    expect([...counts.entries()].sort()).toEqual([
      ["c2-evidence-unavailable", 8],
      ["corpus-unreadable", 1],
    ]);
    expect((cleanCheckoutResult.warnings ?? []).map((w) => w.code)).toEqual([]);
  });
});

/**
 * FACTUAL STATE CHECK for the presence-only checkpoints (C3–C5, no
 * `CHECKPOINT_POLICIES` entry). This USED to be a tripwire guarding an
 * unreachable-but-unfixed channel: the actor-separation check used to run over
 * the retracted-EXCLUDED closure set, so on a presence-only checkpoint a valid
 * retraction of an extra duplicate-actor approval could ERASE
 * `checkpoint-actor-separation-violation` and manufacture closure. That channel
 * is now CLOSED structurally — the actor-separation check runs over the
 * retracted-INCLUSIVE `cpStructural` set regardless of whether a C3+ approval
 * exists (see
 * `docs/superpowers/plans/2026-07-31-retraction-structural-monotonicity-followup.md`
 * and the channel-agnostic monotonicity guard-test in
 * `validate-readiness-artifacts.test.ts`), so this precondition is no longer
 * load-bearing for that bug. It is kept as a plain factual record of today's
 * tracked ledger contents, not as a guard.
 */
describe("presence-only checkpoints (C3-C5): tracked ledger state", () => {
  it("has no C3/C4/C5 approval in the tracked ledger today", () => {
    const head = JSON.parse(
      readFileSync(resolve(artifactRoot, "checkpoint-approvals-v6.json"), "utf-8"),
    ) as { approvals: Array<{ recordKind?: string; checkpoint?: string }> };
    const presenceOnlyApprovalCheckpoints = head.approvals
      .filter((row) => row.recordKind !== "retraction")
      .map((row) => row.checkpoint)
      .filter((cp): cp is string => cp === "C3" || cp === "C4" || cp === "C5");
    expect(presenceOnlyApprovalCheckpoints).toEqual([]);
  });
});
