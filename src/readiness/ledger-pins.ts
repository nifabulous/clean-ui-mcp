/**
 * Approval-row pins — the anchor that attests EVERY ledger file in the tracked
 * chain, including the head that nothing inside the artifact graph attests.
 *
 * ─── THE HOLE THIS CLOSES (VERIFIED, NOT THEORISED) ─────────────────────────
 *
 * `validateLedgerAppendOnly` (contracts.ts) requires every approval in a ledger
 * to survive unchanged as a PREFIX of its successor. That makes historical rows
 * immutable — but only historical ones. Three facts compose into a hole at the
 * head:
 *
 *   1. the append-only check iterates `previous.approvals`, so rows the HEAD
 *      appended beyond its predecessor's length are compared against nothing;
 *   2. the index-membership check exempts the `checkpoint-approvals` family
 *      (validator.ts), and no `artifact-index` row lists a ledger — so no
 *      artifact hash-pins the ledger's bytes;
 *   3. a ledger's `predecessor.sha256` pins its PREDECESSOR, never itself.
 *
 * Consequence, reproduced end to end against a copy of the real artifact graph:
 * editing two `decidedAt` fields in place in `checkpoint-approvals-v5.json`
 * flipped the gate from `ok: false` / `C2: open` / two blocking
 * `ledger-supersession-not-later` issues to `ok: true` / `C2: closed` /
 * `All checks passed.` / exit 0. A governance ledger whose decision timestamps
 * can be edited freely is the defect class the whole readiness gate exists to
 * prevent.
 *
 * ─── WHY THE ANCHOR IS IN SOURCE AND NOT IN THE ARTIFACT GRAPH ──────────────
 *
 * Any anchor stored under `quality-contracts/` is reachable by the same edit it
 * is meant to catch: a hand that can rewrite a `decidedAt` can rewrite an index
 * row's `sha256` in the commit. The anchor has to sit somewhere the ledger's own
 * author cannot reach as DATA — i.e. in code, where it shows up in a source diff
 * and passes through review as code rather than as governance data. Adding the
 * ledger to `artifact-index-v3.json` was the other candidate and was rejected:
 * besides being inside the graph, that file's bytes are themselves pinned by
 * `approvedArtifacts` entries in the ledger (`index-c1-v3`), so editing it emits
 * `approved-artifact-hash-mismatch` and changes the gate's published issue set.
 *
 * This follows a convention the repository already uses rather than inventing a
 * parallel one: `RECIPE_SHA256` in `src/create-ui-spec-contracts.ts` is a frozen
 * canonical-JSON SHA-256 literal in source, declared as the single source of
 * truth for checked-in bytes, with recompute instructions on the constant. The
 * digest is composed from the same two helpers the append-only check already
 * uses — `sha256Hex` ∘ `canonicalJsonStringify` — so no second hash or second
 * canonical form enters the codebase.
 *
 * ─── WHY THE TABLE IS KEYED ON THE FILE PATH ────────────────────────────────
 *
 * Two earlier revisions of this module keyed the lookup on the ledger's own
 * `artifactId`, and both were evaded by editing that field. Revision 1 pinned
 * only the head: renaming the head's `artifactId` meant the pin was never
 * consulted, and two `decidedAt` edits then produced `ok: true`, every
 * checkpoint closed, zero issues. Revision 2 added a coverage rule — "once ANY
 * ledger in the chain matches a pin key, EVERY ledger must" — and asserted that
 * renaming the earlier ledgers to escape the table "breaks the chain instead".
 * That assertion was false, and the evasion was reproduced: `predecessor` is
 * `{ version, sha256 }` where `version` is the chain ORDINAL, not the
 * predecessor's `artifactId` (contracts.ts), so an attacker renames v1, hashes
 * the new v1 file, writes that hash into v2's `predecessor.sha256`, renames v2,
 * and walks the cascade to the head — whose file digest nothing pins. Five
 * renames plus four hash repairs plus two `decidedAt` edits, all inside
 * `quality-contracts/`, produced `ok: true` and `C2: closed` with zero issues.
 * Chain length was not a defence: the repair is a loop.
 *
 * The lesson is not "add another self-declared field to the key". It is that a
 * lookup key which lives INSIDE the file being pinned can always be edited by
 * the same hand that edits the rows. So the key is now the ledger's PATH within
 * the artifact root (`checkpoint-approvals-v5.json`) — a name held by the
 * directory, not by the file's contents. Renaming an `artifactId` no longer
 * changes which pin applies; it is simply inert.
 *
 * ─── AND WHY COVERAGE RUNS IN BOTH DIRECTIONS ───────────────────────────────
 *
 * A table consulted only where the graph offers a match fails open. The
 * one-directional form of this check (iterate the chain, require each member to
 * have a pin) never iterated the table, so pins for absent files were silent:
 * `rm checkpoint-approvals-v{3,4,5}.json` erased both blocking findings and
 * produced `ok: true` with zero issues (reproduced). Three rules now run
 * whenever the table is in force, and each is blocking on its own:
 *
 *   A. every `checkpoint-approvals` file under the root must have a pin for its
 *      path            → `ledger-approval-pin-missing`
 *   B. every pinned path must resolve to a parsed `checkpoint-approvals` file
 *                      → `ledger-approval-pin-absent`
 *   C. a pinned file's approval rows must digest to its pinned value
 *                      → `ledger-approval-pin-mismatch`
 *
 * WHEN THE TABLE IS IN FORCE — decided outside the artifact graph, which is what
 * makes rule B meaningful. The tracked table applies when the directory being
 * validated IS this repository's own artifact root ({@link TRACKED_ARTIFACT_ROOT},
 * derived from this module's location on disk, not from any file's contents or
 * any caller argument). A caller may additionally supply pins for a graph this
 * repository does not track (fixtures), in which case its table is in force for
 * that root. With neither, there is nothing to check and the rules are inert.
 *
 * That scoping also makes fixture/tracked key collision structurally impossible
 * rather than conventional: a fixture root is never the tracked root, so the
 * tracked table is not merged into its pins even when a fixture file happens to
 * be named `checkpoint-approvals-v1.json`.
 *
 * ─── WHAT WAS ATTACKED, AND WHAT HAPPENED ───────────────────────────────────
 *
 * Each of the following was run against a `git worktree` copy of the real
 * artifact graph, driving that worktree's own compiled CLI, and each is reported
 * blocking with every checkpoint held open. These are outcomes observed, not a
 * class generalised from them:
 *
 *   - two `decidedAt` fields edited in place in `checkpoint-approvals-v5.json`
 *     → 1 x `ledger-approval-pin-mismatch` (rule C);
 *   - the head ledger's `artifactId` renamed AND the same two `decidedAt` edits
 *     → 1 x `ledger-approval-pin-mismatch` (rule C; the rename is inert);
 *   - all five `artifactId`s renamed, all four `predecessor.sha256` values
 *     repaired, plus the same two `decidedAt` edits
 *     → 1 x `ledger-approval-pin-mismatch` (rule C; renames and repairs inert);
 *   - `rm checkpoint-approvals-v{3,4,5}.json`
 *     → 3 x `ledger-approval-pin-absent` (rule B) beside the chain's own
 *       structural findings;
 *   - `checkpoint-approvals-v5.json` renamed to another filename
 *     → `ledger-approval-pin-absent` for the pinned path AND
 *       `ledger-approval-pin-missing` for the new one (rules B + A);
 *   - a sixth ledger appended without registering its pin
 *     → `ledger-approval-pin-missing` (rule A).
 *
 * NOT durable against, and deliberately so:
 *
 *   - a change that edits a ledger AND edits the literals below. A pin is a
 *     declaration, not a signature. This is the property that makes the control
 *     real rather than absolute: the cost of hiding a governance defect goes
 *     from "edit one field in one data file" to "edit a data file and a source
 *     constant, both visible in the diff, with the readiness tests naming the
 *     file that changed".
 *   - validating a COPY of the graph at a path that is not the tracked artifact
 *     root (`--artifact-root /tmp/copy/...`). The tracked table is not in force
 *     there, by the scoping rule above; the CLI says so on stderr AND the result
 *     carries `ledgerPinScope` ("tracked" | "caller" | "none"), so a machine
 *     consumer of `--json` can tell an attested run from an unpinned one without
 *     parsing stderr. This is a change to the invocation, not a change confined
 *     to `quality-contracts/` — and since the CLI now DEFAULTS to
 *     {@link TRACKED_ARTIFACT_ROOT}, it is an explicit opt-out rather than
 *     something a different working directory can cause by accident.
 *
 *     THE "SAYS SO" HALF OF THAT WAS FALSE FOR ONE FORM OF COPY, AND IT IS THE
 *     COMMON ONE. The CLI resolves the git toplevel with `cwd` set to the
 *     artifact root and hard-stops when that fails, and the stop used to precede
 *     both the `notice:` and any `--json` output — so a plain directory copy
 *     outside every git worktree exited 1 with zero bytes of stdout and no
 *     `notice:`, announcing neither channel. Every copy the suite exercised
 *     carried git context (in-repo, injected `GIT_DIR`, or a `git worktree`), so
 *     nothing failed. Both channels now precede the hard stop: the `notice:` is
 *     printed first, and with `--json` the failure path emits a complete result
 *     carrying `ledgerPinScope` before exiting 1. The git requirement is
 *     untouched — such a run recomputes no checkpoint target and closes nothing.
 *     Regression cover: `validate-readiness-artifacts-cli.test.ts`, "publishes
 *     the pin scope on BOTH channels for a plain directory copy that carries no
 *     git context, then still fails hard" — the only test that supplies NO git
 *     context, which is why the others could not catch this.
 *
 *     THE EXACT BOUND, ENUMERATED FROM THE CALL GRAPH — this bullet has been
 *     wrong five times, in both directions, every time by reasoning from a grep
 *     for a COMMAND NAME to a conclusion about what EXECUTES.
 *
 *     A NOTE ON THE CITATIONS BELOW. They used to be line numbers, and six of
 *     them were found stale in a single review — one of them made stale by the
 *     very commit that wrote it, and one pointing into the middle of a comment
 *     block where a reader would look for an assertion. Every reference here is
 *     now a SYMBOL or a test TITLE, which the tooling can locate and which a
 *     merge cannot silently shift. Keep it that way: if you need to point at
 *     something, name it. The same applies to COUNTS: the first version of this
 *     rewrite said the readiness suite asserts these claims "across four `it`
 *     blocks" and the real number was five, so the count is gone — the suite is
 *     identified by its `describe` title and each claim by the `it` title that
 *     carries it. Do not reintroduce a block count; it goes stale the moment
 *     someone adds a case.
 *
 *     The comparison is performed in exactly one place, `validator.ts` step 7c
 *     (its `resolveLedgerApprovalPins` call, then `ledgerApprovalRowsDigest` per
 *     ledger), and `validateReadinessArtifacts` has exactly one production
 *     caller — the sole `validateReadinessArtifacts({...})` call in
 *     `src/scripts/validate-readiness-artifacts.ts`. So:
 *
 *       * THE CLI INVOCATION DEFAULTS TO THE TRACKED ROOT. The
 *         `validate-readiness-artifacts` script in `package.json` still names no
 *         root, but the CLI's own `artifactRoot` const now defaults to
 *         {@link TRACKED_ARTIFACT_ROOT} rather than to
 *         `resolve(process.cwd(), "quality-contracts", "agent-readiness")`. That
 *         former default landed on the tracked root only because `npm run` sets
 *         cwd to the package directory — a property of npm, not something the
 *         command states — so the pins engaged by accident of invocation and went
 *         inert whenever the same CLI was run from anywhere else. They are now in
 *         force for every default invocation regardless of cwd
 *         (`validate-readiness-artifacts-cli.test.ts`, "engages the pins from a
 *         working directory that is NOT the repository root"). `--artifact-root`
 *         still overrides outright, so an operator can still point the CLI at a
 *         copy — that is now a stated opt-out, signalled BOTH by the stderr
 *         `notice:` above and by `ledgerPinScope` in the result.
 *       * `npm test` DOES re-derive these pins against the tracked root, and
 *         `.github/workflows/ci.yml` runs `npm test` (its `- run: npm test`
 *         step). Three suites reach the tracked root with no argument, env var,
 *         or fixture indirection that could redirect them:
 *           - `tracked-artifacts-readiness.test.ts` hardcodes its module-level
 *             `artifactRoot` as `resolve(repoRoot, "quality-contracts/agent-readiness")`
 *             and asserts, in its `describe("tracked readiness artifacts (real
 *             data, read-only)")` suite: the checkpoint map ("reports the
 *             checkpoint state the documentation claims") and `ok:false` with
 *             exactly the two `ledger-supersession-not-later` issues ("reports
 *             exactly the two known governance-provenance issues"); each pinned
 *             path's digest re-derived from the file on disk
 *             ("holds every tracked ledger's approval rows to its source pin");
 *             both coverage directions and the exact five-key table ("has a pin
 *             registered for every tracked ledger FILE, and a file for every
 *             pin"); and `isTrackedArtifactRoot(artifactRoot) === true` ("runs
 *             with the tracked pin table in force for this root");
 *           - `validate-readiness-artifacts-cli.test.ts` spawns the COMPILED
 *             CLI's default invocation at the repo root and asserts an EMPTY
 *             stderr — i.e. that the pins were in force — beside `ok:false` /
 *             `C2:"open"` / exactly two of those issues / `ledgerPinScope:
 *             "tracked"` ("emits no pins-inert notice for the tracked root —
 *             pins are engaged in the shipped dist CLI"), and repeats the same
 *             assertions with the child's cwd set to the OS temp directory
 *             ("engages the pins from a working directory that is NOT the
 *             repository root");
 *           - `ledger-pins.test.ts` asserts `scope === "tracked"` and the exact
 *             table for `TRACKED_ARTIFACT_ROOT` ("puts the tracked table in
 *             force for the tracked root").
 *         So "validate a copy instead" does not escape mechanical detection: it
 *         escapes the CLI run, not the suite that CI runs.
 *
 *     What remains true is narrow and it is only this: no script or workflow
 *     pins the CLI INVOCATION's root — `--artifact-root` can still send any run
 *     at a copy. The two halves of round-4 m5 / triage row 14 that were true when
 *     it was written are now closed: the default root no longer depends on cwd,
 *     and `--json` carries `ledgerPinScope`, so a machine consumer can tell
 *     whether the pins were in force. Do not restate any of this as "nothing
 *     mechanical runs this gate" — `npm test` does, transitively, and a grep of
 *     `.github/` for `validate-readiness` being empty is evidence about naming,
 *     not about execution. Round-1 M11 / triage row 33 in
 *     review-branch-final-round3.md rests on the same inverted inference and
 *     should be re-derived before it is acted on.
 *
 * No claim is made here about changes that reach outside `quality-contracts/`,
 * and none about attacks not listed above.
 */
import { realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJsonStringify, sha256Hex } from "./contracts.js";

/**
 * Canonical-JSON SHA-256 of a ledger's `approvals` array.
 *
 * The pin is over the approval ROWS, at exactly the granularity
 * `validateLedgerAppendOnly` compares them — not over the file's raw bytes. So
 * re-indenting the file, or reordering keys inside a row, is not a false
 * positive, while every semantic change to a row (an edited timestamp, a dropped
 * record, a reordering, an inserted record) changes the digest.
 */
export function ledgerApprovalRowsDigest(approvals: unknown): string {
  return sha256Hex(Buffer.from(canonicalJsonStringify(approvals), "utf-8"));
}

/**
 * This repository's own artifact root, resolved from THIS MODULE's location.
 *
 * `src/readiness/ledger-pins.ts` and `dist/readiness/ledger-pins.js` are both
 * two directories below the repository toplevel, so the same expression serves
 * the TypeScript and compiled forms. Deriving it from the module rather than
 * from an argument or a data file is the point: it is the one part of the pin
 * machinery an edit inside `quality-contracts/` cannot influence, and it is what
 * lets a pin for a DELETED file still be checked (rule B).
 */
export const TRACKED_ARTIFACT_ROOT: string = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "quality-contracts",
  "agent-readiness",
);

/** `realpathSync` when the path exists, plain resolution when it does not. */
function realOrResolved(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * True when `absArtifactRoot` is this repository's tracked artifact root.
 *
 * Both sides go through `realpathSync` because the validator resolves its root
 * that way (on macOS `/tmp` → `/private/tmp`), so a raw string comparison would
 * miss a match that is really the same directory.
 */
export function isTrackedArtifactRoot(absArtifactRoot: string): boolean {
  return realOrResolved(absArtifactRoot) === realOrResolved(TRACKED_ARTIFACT_ROOT);
}

/**
 * The pinned approval rows of the tracked ledger chain, keyed by the ledger's
 * PATH WITHIN THE ARTIFACT ROOT.
 *
 * The key is the filename because a filename is held by the directory, not by
 * the file's contents: the two prior `artifactId`-keyed revisions of this table
 * were both evaded by editing that field (see the module docblock). A rename of
 * a ledger's `artifactId` is now inert; a rename of its FILE is `rule B` plus
 * `rule A`, both blocking.
 *
 * EVERY LEDGER FILE IN THE CHAIN NEEDS AN ENTRY — root to head, no gaps — and
 * every entry must name a file that exists. Both directions are enforced
 * (validator.ts step 7c) and both are blocking.
 *
 * WHEN A SUCCESSOR LEDGER IS APPENDED, ADD ITS PIN HERE IN THE SAME CHANGE and
 * leave every existing entry in place. Neither half is housekeeping: without the
 * new entry the gate emits `ledger-approval-pin-missing` and holds every
 * checkpoint open; dropping an old entry is what a "remediation" would do to
 * rewrite the defective rows while appending, and it now also emits
 * `ledger-approval-pin-absent` if the file is removed with it. Recompute with
 * `ledgerApprovalRowsDigest(JSON.parse(readFileSync(<ledger>, "utf-8")).approvals)`.
 *
 * The chain is `quality-contracts/agent-readiness/checkpoint-approvals-v1..v5.json`
 * (artifact ids `approvals-20260714`, `approvals-c1-v2`, `approvals-c2-v3`,
 * `approvals-c2-v4`, `approvals-c2-v5`). `checkpoint-approvals-v5.json` is the
 * head: eight approvals, of which `c2-gold-reviewer-gold-v2` and
 * `c2-qa-reviewer-qa-v2` carry the temporal defect that holds C2 open. Pinning
 * them is what makes that block survive an edit to the file.
 */
export const TRACKED_LEDGER_APPROVAL_PINS: Readonly<Record<string, string>> = Object.freeze({
  "checkpoint-approvals-v1.json":
    "733b43d5afbfcfe1472501c68f08135d51490da7f6f7ad44fb7f04ce3444a8ab",
  "checkpoint-approvals-v2.json":
    "d2125790159ec4329e63d085a359696941eb177ad33c5f61fc401135b1302e77",
  "checkpoint-approvals-v3.json":
    "02c23f9965aec162a1d858ca8b45e5e8de37bc8bba101032fe599854d3ed2e6d",
  "checkpoint-approvals-v4.json":
    "2449a51c6c6decf49415104bbe0fd85ebd44b1429b6258f36b3fd84646f33a26",
  "checkpoint-approvals-v5.json":
    "180d1c451a38b3def1371a0d4ddb41e6534bbd8d2df325ac0787af220b17b8ec",
});

/**
 * Which table is in force for a root, and why.
 *
 *  - `"tracked"` — the root IS this repository's artifact root, so the tracked
 *    table applies (merged with any caller additions, tracked last).
 *  - `"caller"`  — an untracked root for which the caller supplied pins.
 *  - `"none"`    — an untracked root with no caller pins. All three rules are
 *    inert; there is nothing declared to check against.
 */
export type LedgerPinScope = "tracked" | "caller" | "none";

export interface ResolvedLedgerApprovalPins {
  /** Pins keyed by path within the artifact root. */
  readonly pins: Readonly<Record<string, string>>;
  readonly scope: LedgerPinScope;
}

/**
 * Resolve the pin table for one artifact root.
 *
 * The tracked table is included ONLY for the tracked root, and is spread LAST so
 * a caller-supplied value for a tracked path is discarded. Both properties are
 * fail-closed and neither depends on the contents of any artifact:
 *
 *  - `additionalLedgerApprovalPins` exists so fixture graphs can exercise all
 *    three rules end to end on synthetic data. It cannot weaken a tracked pin
 *    (merge order) and cannot be used to declare the tracked root untracked
 *    (the scope decision ignores it when the root is tracked).
 *  - A fixture file named like a tracked ledger is harmless, because the tracked
 *    table is not in force for a fixture root.
 */
export function resolveLedgerApprovalPins(args: {
  absArtifactRoot: string;
  additional?: Readonly<Record<string, string>>;
}): ResolvedLedgerApprovalPins {
  const additional = args.additional ?? {};
  if (isTrackedArtifactRoot(args.absArtifactRoot)) {
    return {
      pins: { ...additional, ...TRACKED_LEDGER_APPROVAL_PINS },
      scope: "tracked",
    };
  }
  if (Object.keys(additional).length > 0) {
    return { pins: { ...additional }, scope: "caller" };
  }
  return { pins: {}, scope: "none" };
}
