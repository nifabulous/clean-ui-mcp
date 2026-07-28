/**
 * Head-ledger approval-row pins — the anchor that terminates the append-only
 * chain at its newest end.
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
 * ─── WHAT THE PIN IS AND IS NOT DURABLE AGAINST ─────────────────────────────
 *
 * Durable against: any in-place edit, deletion, reordering, or insertion within
 * a pinned ledger's approval rows, made in `quality-contracts/` alone. Such an
 * edit produces `ledger-approval-pin-mismatch` — blocking — no matter what else
 * the graph says, and no successor ledger can clear it (a successor must
 * reproduce the pinned rows as its prefix or emit `ledger-approval-*`).
 *
 * NOT durable against: a change that edits the ledger AND updates the literal
 * below in the same change. That is deliberate and unavoidable — a pin is a
 * declaration, not a signature — and it is the property that makes the control
 * real: the cost of hiding a governance defect goes from "edit one field in one
 * data file" to "edit a data file and a source constant, both visible in the
 * diff, with the readiness tests naming the file that changed". Nothing here
 * claims cryptographic non-repudiation; the claim is that a data-only edit is
 * mechanically detected.
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
 * ONLY THE CHAIN HEAD NEEDS AN ENTRY. Every earlier ledger's rows are already
 * attested twice over — by its successor's `predecessor.sha256` and by the
 * append-only prefix check — so pinning them here would be redundant. The head
 * is the one ledger nothing else attests.
 *
 * WHEN A SUCCESSOR LEDGER IS APPENDED, ADD ITS PIN HERE IN THE SAME CHANGE and
 * leave the existing entries in place. Keeping the old entry is not
 * housekeeping: it is what stops a "remediation" from quietly rewriting the
 * defective rows while appending, and it is what makes the chain's prefix check
 * terminate in an anchor rather than in nothing. Recompute with
 * `ledgerApprovalRowsDigest(JSON.parse(readFileSync(<ledger>, "utf-8")).approvals)`.
 *
 * `approvals-c2-v5` — `quality-contracts/agent-readiness/checkpoint-approvals-v5.json`,
 * eight approvals, of which `c2-gold-reviewer-gold-v2` and `c2-qa-reviewer-qa-v2`
 * carry the temporal defect that holds C2 open. Pinning them is what makes that
 * block survive an edit to the file.
 */
export const TRACKED_LEDGER_APPROVAL_PINS: Readonly<Record<string, string>> = Object.freeze({
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
 */
export function resolveLedgerApprovalPins(
  additional?: Readonly<Record<string, string>>,
): Record<string, string> {
  return { ...additional, ...TRACKED_LEDGER_APPROVAL_PINS };
}
