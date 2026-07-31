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
 * Pinning the head alone was not enough, and neither was keying the table on the
 * ledger's `artifactId`: that field lives inside the file being pinned, so the
 * same hand that edits a row can edit the lookup key. Renaming the head skipped
 * the pin; renaming the whole chain and repairing the four `predecessor.sha256`
 * values in a loop defeated the chain-coverage rule added to catch that. The
 * table is therefore keyed on the ledger's PATH within the artifact root, and
 * coverage runs in both directions — every ledger file needs a pin, and every
 * pin needs a ledger file. The three rules are exercised end to end in
 * `src/scripts/validate-readiness-artifacts.test.ts`; the tracked table's own
 * digests are re-derived from the real files in
 * `src/readiness/tracked-artifacts-readiness.test.ts`.
 */
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  TRACKED_ARTIFACT_ROOT,
  TRACKED_LEDGER_APPROVAL_PINS,
  isTrackedArtifactRoot,
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
  it("is keyed on the ledger's FILE PATH, not on any field the file declares", () => {
    // THE KEY IS THE POINT. An `artifactId` key was evaded twice by editing that
    // field (see the module docblock); a filename is held by the directory, so no
    // edit inside the file changes which pin applies. A key that looks like an
    // artifact id here would silently reopen both evasions.
    expect(Object.keys(TRACKED_LEDGER_APPROVAL_PINS).sort()).toEqual([
      "checkpoint-approvals-v1.json",
      "checkpoint-approvals-v2.json",
      "checkpoint-approvals-v3.json",
      "checkpoint-approvals-v4.json",
      "checkpoint-approvals-v5.json",
      "checkpoint-approvals-v6.json",
      "checkpoint-approvals-v7.json",
    ]);
    for (const key of Object.keys(TRACKED_LEDGER_APPROVAL_PINS)) {
      // A path within the artifact root: no directory component, no traversal.
      expect(key).toMatch(/^[A-Za-z0-9._-]+\.json$/);
    }
    for (const digest of Object.values(TRACKED_LEDGER_APPROVAL_PINS)) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
    }
  });
});

describe("isTrackedArtifactRoot", () => {
  it("recognises this repository's own artifact root", () => {
    expect(isTrackedArtifactRoot(TRACKED_ARTIFACT_ROOT)).toBe(true);
  });

  it("rejects a directory that merely ends in the same two path segments", () => {
    // A copy of the graph elsewhere is a DIFFERENT graph. The tracked table must
    // not attach to it on the strength of the path suffix alone, or every fixture
    // root (which synthesizes exactly this layout under a temp dir) would inherit
    // the tracked pins.
    expect(
      isTrackedArtifactRoot(resolve("/tmp/not-this-repo/quality-contracts/agent-readiness")),
    ).toBe(false);
  });

  it("rejects the repository root and the parent of the artifact root", () => {
    expect(isTrackedArtifactRoot(resolve(TRACKED_ARTIFACT_ROOT, ".."))).toBe(false);
    expect(isTrackedArtifactRoot(resolve(TRACKED_ARTIFACT_ROOT, "..", ".."))).toBe(false);
  });
});

describe("resolveLedgerApprovalPins", () => {
  const untracked = resolve("/tmp/not-this-repo/quality-contracts/agent-readiness");

  it("puts the tracked table in force for the tracked root", () => {
    const resolved = resolveLedgerApprovalPins({ absArtifactRoot: TRACKED_ARTIFACT_ROOT });
    expect(resolved.scope).toBe("tracked");
    expect(resolved.pins).toEqual({ ...TRACKED_LEDGER_APPROVAL_PINS });
  });

  it("does NOT put the tracked table in force for another root", () => {
    // Otherwise every fixture graph would be required to contain the five
    // tracked ledger files.
    const resolved = resolveLedgerApprovalPins({ absArtifactRoot: untracked });
    expect(resolved.scope).toBe("none");
    expect(resolved.pins).toEqual({});
  });

  it("admits caller pins for an untracked root, keyed by path", () => {
    const resolved = resolveLedgerApprovalPins({
      absArtifactRoot: untracked,
      additional: { "fixture-approvals-v1.json": "a".repeat(64) },
    });
    expect(resolved.scope).toBe("caller");
    expect(resolved.pins).toEqual({ "fixture-approvals-v1.json": "a".repeat(64) });
  });

  it("CANNOT be used to weaken or redefine a tracked pin (fail-closed merge order)", () => {
    // The option exists so fixture graphs can exercise the three rules on
    // synthetic data. It must not double as a bypass: the tracked table is
    // spread LAST, so a caller-supplied value for a tracked path is discarded.
    const resolved = resolveLedgerApprovalPins({
      absArtifactRoot: TRACKED_ARTIFACT_ROOT,
      additional: { "checkpoint-approvals-v5.json": "f".repeat(64) },
    });
    expect(resolved.pins["checkpoint-approvals-v5.json"]).toBe(
      TRACKED_LEDGER_APPROVAL_PINS["checkpoint-approvals-v5.json"],
    );
  });

  it("CANNOT be used to declare the tracked root untracked", () => {
    // The scope decision ignores caller input entirely: supplying additions (or
    // none) cannot move the tracked root out of "tracked", so rule B (every
    // pinned path must exist) can never be switched off from the outside.
    expect(
      resolveLedgerApprovalPins({
        absArtifactRoot: TRACKED_ARTIFACT_ROOT,
        additional: {},
      }).scope,
    ).toBe("tracked");
  });
});
