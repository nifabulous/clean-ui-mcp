/**
 * Unit tests for the ledger approval-row pins.
 *
 * WHY THIS MODULE EXISTS AT ALL — the defect it closes was reproduced end to
 * end. The append-only chain check (`validateLedgerAppendOnly`) iterates the
 * PREDECESSOR's approvals, so the chain HEAD's own appended suffix is compared
 * against nothing until a successor pins it. Combined with the fact that the
 * ledger family is exempt from index membership (so no `artifact-index` row
 * hash-pins the ledger bytes) and that a ledger's `predecessor.sha256` pins its
 * PREDECESSOR rather than itself, the head ledger's rows were attested by
 * nothing at all: editing two `decidedAt` fields in
 * `checkpoint-approvals-v5.json` flipped the real gate from `ok: false` /
 * `C2: open` to `ok: true` / `C2: closed` / no issues.
 *
 * The anchor therefore has to live OUTSIDE the artifact graph — any anchor
 * inside `quality-contracts/` is reachable by the same edit it is meant to
 * catch. It follows the `RECIPE_SHA256` convention already in the repo
 * (`src/create-ui-spec-contracts.ts`): a frozen canonical-JSON SHA-256 literal
 * in source, single source of truth, recomputed and replaced deliberately.
 *
 * Pinning the head alone was not enough. The lookup key is a field inside the
 * artifact being pinned, so an unpinned ledger was skipped and a rename released
 * the chain. The table now covers the chain root to head and `validator.ts` step
 * 7c treats an unpinned chain ledger as blocking; the coverage rule itself is
 * exercised end to end in `src/scripts/validate-readiness-artifacts.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  TRACKED_LEDGER_APPROVAL_PINS,
  ledgerApprovalRowsDigest,
  resolveLedgerApprovalPins,
} from "./ledger-pins.js";

const rows = [
  { approvalId: "a", decidedAt: "2026-07-14T10:00:00Z", note: "x" },
  { approvalId: "b", decidedAt: "2026-07-14T10:00:01Z" },
];

describe("ledgerApprovalRowsDigest", () => {
  it("is a 64-char hex digest", () => {
    expect(ledgerApprovalRowsDigest(rows)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable under key reordering and whitespace (canonical JSON, not raw bytes)", () => {
    // The pin is over the approval ROWS in canonical form, at the same
    // granularity `validateLedgerAppendOnly` compares them. Re-indenting the
    // file or reordering keys within a row is therefore NOT a false positive,
    // while any semantic change to a row is caught.
    const reordered = [
      { note: "x", decidedAt: "2026-07-14T10:00:00Z", approvalId: "a" },
      { decidedAt: "2026-07-14T10:00:01Z", approvalId: "b" },
    ];
    expect(ledgerApprovalRowsDigest(reordered)).toBe(ledgerApprovalRowsDigest(rows));
  });

  it("changes when a single decidedAt is edited — the exact defect class", () => {
    const edited = [{ ...rows[0]!, decidedAt: "2026-07-28T10:00:00Z" }, rows[1]!];
    expect(ledgerApprovalRowsDigest(edited)).not.toBe(ledgerApprovalRowsDigest(rows));
  });

  it("changes when rows are reordered (order is part of the ledger's meaning)", () => {
    expect(ledgerApprovalRowsDigest([rows[1]!, rows[0]!])).not.toBe(
      ledgerApprovalRowsDigest(rows),
    );
  });

  it("changes when a row is dropped", () => {
    expect(ledgerApprovalRowsDigest([rows[0]!])).not.toBe(ledgerApprovalRowsDigest(rows));
  });
});

describe("TRACKED_LEDGER_APPROVAL_PINS", () => {
  it("pins every ledger in the tracked chain, root to head", () => {
    // COVERAGE IS THE INVARIANT. A pin table with a gap is evadable by rename:
    // the validator can only tell a tracked chain from an untracked one by a
    // pin key matching, so a chain in which some member may legitimately be
    // unpinned cannot distinguish "renamed" from "not ours". If a successor
    // ledger is appended, its entry belongs here in the same change.
    expect(Object.keys(TRACKED_LEDGER_APPROVAL_PINS).sort()).toEqual([
      "approvals-20260714",
      "approvals-c1-v2",
      "approvals-c2-v3",
      "approvals-c2-v4",
      "approvals-c2-v5",
    ]);
    for (const digest of Object.values(TRACKED_LEDGER_APPROVAL_PINS)) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("resolveLedgerApprovalPins", () => {
  it("returns the tracked pins when no additions are supplied", () => {
    expect(resolveLedgerApprovalPins()).toEqual({ ...TRACKED_LEDGER_APPROVAL_PINS });
  });

  it("admits pins for artifact ids the tracked table does not name", () => {
    const resolved = resolveLedgerApprovalPins({ "approvals-fixture-v1": "a".repeat(64) });
    expect(resolved["approvals-fixture-v1"]).toBe("a".repeat(64));
    expect(resolved["approvals-c2-v5"]).toBe(TRACKED_LEDGER_APPROVAL_PINS["approvals-c2-v5"]);
  });

  it("CANNOT be used to weaken or redefine a tracked pin (fail-closed merge order)", () => {
    // The option exists so fixture graphs can exercise the check with synthetic
    // artifact ids. It must not double as a bypass: the tracked table is spread
    // LAST, so a caller-supplied value for a tracked id is discarded.
    const resolved = resolveLedgerApprovalPins({ "approvals-c2-v5": "f".repeat(64) });
    expect(resolved["approvals-c2-v5"]).toBe(TRACKED_LEDGER_APPROVAL_PINS["approvals-c2-v5"]);
  });
});
