/**
 * Approval-row pins — the anchor that attests EVERY ledger in the tracked
 * chain, including the head that nothing else attests.
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
 * Consequence, reproduced end to end against the real artifact graph: editing
 * two `decidedAt` fields in place in `checkpoint-approvals-v5.json` flipped the
 * gate from `ok: false` / `C2: open` / two blocking
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
 * ─── WHY COVERAGE, NOT JUST COMPARISON ──────────────────────────────────────
 *
 * A pin looked up by a key the edit controls fails open. An earlier revision of
 * this module pinned only the head and keyed the lookup on the ledger's own
 * `artifactId`, skipping any ledger with no matching entry. That was evaded end
 * to end by one data-only edit: renaming the head's `artifactId` — a field
 * nothing else in the graph constrains for a ledger — meant the pin was never
 * consulted, and the same two `decidedAt` edits then turned the gate green with
 * zero issues. Appending a new head with no pin registered was the same shape:
 * the new head's own rows were attested by nothing and could be rewritten in
 * place with byte-identical gate output.
 *
 * So the invariant is COVERAGE, checked before comparison:
 *
 *   once ANY ledger in the resolved chain matches a pin key, EVERY ledger in
 *   that chain must have one; an unpinned chain ledger is itself blocking.
 *
 * A rename can then only convert a comparison failure into a coverage failure,
 * and every ledger except the head is additionally nailed down by its
 * successor's `predecessor.sha256` (which covers the whole file, `artifactId`
 * included), so renaming the earlier ledgers to disguise the chain as untracked
 * breaks the chain instead. `validator.ts` step 7c owns both halves.
 *
 * ─── WHAT THE PINS ARE AND ARE NOT DURABLE AGAINST ──────────────────────────
 *
 * Each of the following was attacked against a worktree copy of the real
 * artifact graph and is reported blocking, with every checkpoint held open:
 *
 *   - an in-place edit, deletion, reordering or insertion inside a pinned
 *     ledger's approval rows → `ledger-approval-pin-mismatch`;
 *   - renaming the head ledger's `artifactId` (with or without a row edit in
 *     the same change) → `ledger-approval-pin-missing`;
 *   - appending a successor ledger without registering its pin → the same.
 *
 * NOT durable against: a change that edits the ledger AND edits the literals
 * below. That is deliberate and unavoidable — a pin is a declaration, not a
 * signature — and it is the property that makes the control real: the cost of
 * hiding a governance defect goes from "edit one field in one data file" to
 * "edit a data file and a source constant, both visible in the diff, with the
 * readiness tests naming the file that changed". Nothing here claims
 * cryptographic non-repudiation, and no claim is made about changes that reach
 * outside `quality-contracts/`. What is claimed, and tested, is the three
 * attacks above.
 */
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
 * The pinned approval rows of the tracked ledger chain, keyed by `artifactId`.
 *
 * EVERY LEDGER IN THE CHAIN NEEDS AN ENTRY — root to head, no gaps. Coverage is
 * the invariant (see the module docblock): the check is only evadable by a
 * rename if some chain member may legitimately be unpinned. Pinning the whole
 * chain is also what makes the earlier ledgers' `predecessor.sha256` links do
 * double duty — an attacker who renames the earlier ledgers to disguise the
 * chain as untracked breaks those links.
 *
 * WHEN A SUCCESSOR LEDGER IS APPENDED, ADD ITS PIN HERE IN THE SAME CHANGE and
 * leave every existing entry in place. Neither half is housekeeping: without the
 * new entry the gate emits `ledger-approval-pin-missing` and holds every
 * checkpoint open; dropping an old entry is what a "remediation" would do to
 * rewrite the defective rows while appending. Recompute with
 * `ledgerApprovalRowsDigest(JSON.parse(readFileSync(<ledger>, "utf-8")).approvals)`.
 *
 * The chain is `quality-contracts/agent-readiness/checkpoint-approvals-v1..v5.json`.
 * `approvals-c2-v5` is the head: eight approvals, of which
 * `c2-gold-reviewer-gold-v2` and `c2-qa-reviewer-qa-v2` carry the temporal defect
 * that holds C2 open. Pinning them is what makes that block survive an edit to
 * the file.
 *
 * These ids name THIS repository's governance chain. A fixture graph must not
 * reuse them (see `buildValidGraph` in
 * `src/scripts/validate-readiness-artifacts.test.ts`, whose ledgers are prefixed
 * `fixture-`) — a synthetic ledger carrying a tracked id would be compared
 * against real rows and fail.
 */
export const TRACKED_LEDGER_APPROVAL_PINS: Readonly<Record<string, string>> = Object.freeze({
  "approvals-20260714": "733b43d5afbfcfe1472501c68f08135d51490da7f6f7ad44fb7f04ce3444a8ab",
  "approvals-c1-v2": "d2125790159ec4329e63d085a359696941eb177ad33c5f61fc401135b1302e77",
  "approvals-c2-v3": "02c23f9965aec162a1d858ca8b45e5e8de37bc8bba101032fe599854d3ed2e6d",
  "approvals-c2-v4": "2449a51c6c6decf49415104bbe0fd85ebd44b1429b6258f36b3fd84646f33a26",
  "approvals-c2-v5": "180d1c451a38b3def1371a0d4ddb41e6534bbd8d2df325ac0787af220b17b8ec",
});

/**
 * Merge caller-supplied pins with the tracked table, TRACKED LAST.
 *
 * The `additionalLedgerApprovalPins` option exists so fixture graphs (whose
 * ledgers carry synthetic artifact ids) can exercise this check end to end. The
 * merge order makes it structurally incapable of doubling as a bypass: a caller
 * can add a pin for an id the tracked table does not name, but a value it
 * supplies for a tracked id is discarded. Do not reverse the spread.
 *
 * Coverage (validator.ts step 7c) keys off the MERGED map, so a fixture that
 * pins one of its ledgers must pin all of them — the same rule the tracked chain
 * lives under, exercised on synthetic data. A fixture that pins none is not a
 * tracked chain and coverage is inert for it.
 */
export function resolveLedgerApprovalPins(
  additional?: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...additional, ...TRACKED_LEDGER_APPROVAL_PINS };
}
