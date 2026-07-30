# Design: Approval retraction vocabulary

**Date:** 2026-07-30
**Status:** Approved (design), pending implementation plan
**Blocks:** closing C2 on a clean gate
**Supersedes:** `TODOS.md § "Approval retraction vocabulary (the ledger cannot say \"withdrawn\")"`

## Problem

The readiness governance ledger cannot record that a prior approval is
**retracted**. On 2026-07-28 the repository owner decided to withdraw two C2
approvals — `c2-gold-reviewer-gold-v2` and `c2-qa-reviewer-qa-v2` — whose
`decidedAt` was copied verbatim from their v1 predecessors and therefore
predates the target they bind (`cf55fee0…`, first present 2026-07-28). The
withdrawal could not be *stated*:

- `validateLedgerAppendOnly` (`src/readiness/contracts.ts:602`) enforces
  append-only as an unchanged **prefix**, so a v6 ledger that omits the two
  records emits `ledger-approval-deleted` twice. A record can never leave the
  chain.
- `decision` (`src/readiness/contracts.ts:122`) admits only
  `"approved" | "rejected"`. "Rejected" is the wrong semantics — the reviewers
  never decided on the corrected target.

So the withdrawal exists only as prose plus a blocking validator check
(`ledger-supersession-not-later`, `approved-artifact-created-after-decision`),
which hold C2 open with `ok: false`. This design gives the withdrawal a
**recorded** form.

## Governing invariant

> A retraction can only ever REMOVE an approval from the effective set. It can
> never add an approval, resurrect a superseded one, or manufacture a closure.
> Retraction is monotonic toward *open*.

Every acceptance criterion is checked against this. Because retraction only
relaxes toward open, and checkpoint closure independently requires an active
approval binding the git-recomputed canonical target
(`checkpoint-target-mismatch`, `validator.ts:1489`), a fabricated or over-broad
retraction is inherently fail-safe: the worst it can do is reopen a checkpoint.

## Design

### 1. Schema (`src/readiness/contracts.ts`)

New `CheckpointRetraction` record (`.strict()`):

- `recordKind: z.literal("retraction")`
- `retractionId: z.string().min(1)` — the retraction row's own stable id (distinct
  from any `approvalId`). Needed so append-only/pin diagnostics and validity rules
  can name the row, and so it has an identity once v6 becomes a predecessor.
- `retractsApprovalId: z.string().min(1)` — the approval being retracted
- `retractedBy`: `{ actorId, role: z.literal("Repository Maintainer"),
  actorKind: z.literal("human"), actorRegistryVersion, actorRegistrySha256 }`
- `retractedAt: z.string().datetime()`
- `reason: z.string().min(1)` — required (who/when/why is the whole point)

**`CheckpointApproval` is left UNCHANGED** (no `recordKind` field).

The ledger row type is a plain `z.union` with the approval branch FIRST — NOT a
`z.discriminatedUnion` and NOT a `z.preprocess`+`.default`. The reason (reviewer
[P1], verified): pins are computed over the *parsed* rows
(`ledgerApprovalRowsDigest(parsed.data.approvals)`), so any approach that ADDS
`recordKind` to a parsed approval row changes the canonical digest and breaks
every existing v1–v5 pin even though the files did not change. Leaving
`CheckpointApproval` untouched keeps parsed approval rows byte-identical
(**empirically verified: `CheckpointApprovals.parse(v5).approvals` deep-equals the
raw `v5.approvals`**), so the existing pins hold and only v6 gets a new pin.

```ts
// approval branch first: a legacy/normal approval row (no recordKind) matches it
// and is returned unchanged; a retraction row fails the strict approval branch
// (missing approval fields + unknown recordKind/retractionId/… keys) and routes
// to CheckpointRetraction.
export const LedgerRow = z.union([CheckpointApproval, CheckpointRetraction]);
// ledger envelope:
approvals: z.array(LedgerRow)

// discriminants (approval rows never carry recordKind):
isRetractionRow(row) = "recordKind" in row && row.recordKind === "retraction";
isApprovalRow(row)   = !isRetractionRow(row);
```

v1–v5 ledgers (no `recordKind` on any row) parse unchanged AND their parsed rows
are byte-identical to input, so `ledgerApprovalRowsDigest` is stable. Two
regression tests pin this (see Tests).

### 2. Consumer split (reviewer [P2])

`approvals` is now a mixed `(approval | retraction)[]`. Two disciplines:

- **Tamper-evidence operates over the FULL mixed row list.** `validateLedgerAppendOnly`
  (contracts.ts:602) and `ledgerApprovalRowsDigest` (`ledger-pins.ts`, consumed
  at `validator.ts:677`) must accept and cover retraction rows so the retraction
  record itself is prefix-protected and pin-covered — it lives in the same
  append-only chain, which is the whole reason for the chosen record form. Their
  type signatures widen from `CheckpointApproval[]` to the mixed row type. The
  prefix compare is unaffected in practice (retraction rows append *after* the
  prior-approval prefix), but the identity/equality logic must not assume every
  row has `approvalId`.
- **Approval semantics operate over approval rows only.** Supersession
  computation (validator.ts:1197), the timestamp invariants
  (`verifyApprovalArtifactTimestamps`), actor/role/kind checks, target
  recomputation, and the closure loop filter to `recordKind === "approval"`
  rows. Introduce a single `approvalRows`/`retractionRows` partition near the top
  of `validateApprovalsAndCheckpoint` and thread it through; no semantic loop
  iterates a retraction row as if it were an approval.

### 3. Validity of a retraction (reviewer [P2])

`retractedApprovalIds` is built from **valid** retractions only. A retraction is
valid iff ALL hold, else it is inert (suppresses nothing) AND emits a finding:

- `retraction-unauthorized` — `retractedBy.role !== "Repository Maintainer"` or
  `actorKind !== "human"`, or the actor is unresolvable / unauthorized for the
  role in the retraction's own pinned registry (same resolution path approvals
  use).
- `retraction-target-missing` — `retractsApprovalId` names no **approval** row
  present earlier in the chain than the retraction.
- `retraction-out-of-order` — the named approval appears at or after the
  retraction's own position (a retraction can only retract an *earlier* approval
  in the same chain).
- `retraction-target-not-approval` — `retractsApprovalId` names a retraction row
  (cannot retract a retraction), or the retraction's own id (cannot retract
  itself).
- `retraction-duplicate` — a second retraction naming an already-retracted
  approval is inert and flagged (duplicates are invalid/no-op, deterministic).

An inert (invalid) retraction never suppresses a finding and never removes an
approval from the active set — fail-closed.

### 4. Effect on the effective set + closure

- **Exclude** valid-retracted approval ids from `activeApprovals`
  (`validator.ts:1381`): add `&& !retractedApprovalIds.has(id)` alongside the
  existing superseded filter.
- **Model B (hard invariant, reviewer-agreed):** a retracted *superseding*
  record does **not** resurrect the record it superseded. Supersession remains
  historical once recorded; retraction removes the superseder from the effective
  set but never reverses the supersession edge. Net: the effective set only ever
  shrinks under retraction. (Prevents resurrecting an older approval that might
  bind a still-canonical target and thereby close something.)
- **Gated suppression:** `ledger-supersession-not-later` (validator.ts:1340) and
  `approved-artifact-created-after-decision` (`verifyApprovalArtifactTimestamps`)
  skip their finding for an approval **iff** that approval is validly retracted.
  A recorded, valid retraction is the ONLY thing that clears these findings —
  no other escape hatch. (The prior warning-demotion escape hatch stays deleted.)

### 5. Fail-closed proof

1. **Fabricated / unauthorized retraction** → invalid → suppresses nothing →
   the temporal findings still fire → gate red. This kills the "fabricated
   record dated one second later" attack that beat the old warning-demotion:
   supersession no longer clears the finding, and only an *authorized human
   maintainer* retraction does.
2. **Valid retraction of the two v2 records** → their temporal findings clear
   and they leave the active set. Under Model B, v1 stay superseded, so C2 now
   has **zero active C2 approvals**. With no contributing approval, C2's required
   roles are unmet and it stays **open** (reviewer [P2]: the mechanism is
   *unmet-required-roles / no active approvals*, **not**
   `checkpoint-target-mismatch` — that finding only fires for an *active* approval
   binding a wrong target, and after retraction there are none). Retraction
   reopens cleanly; it cannot close. (Independently, `checkpoint-target-mismatch`
   is the backstop if a *future* attempt makes v1 active again — Model B prevents
   that, so it never arises here.)
3. **The retraction record itself** is append-only-prefix protected and
   pin-covered (§2), so it cannot later be edited or dropped to un-retract.

### 6. The v6 ledger + retraction records (this work)

Append `quality-contracts/agent-readiness/checkpoint-approvals-v6.json`:

- Chains from v5: `ordinalVersion: 6`, `predecessor: { version: "5", sha256: <sha256 of the v5 FILE BYTES> }`. Verified: the chain content digest is `sha256Hex(readFileSync(file))` (validator.ts:201), and v5's own `predecessor.sha256` equals the sha256 of the v4 file bytes.
- Contains v5's approval rows as an **unchanged prefix**, then two appended
  `recordKind: "retraction"` rows, each with its own `retractionId`, naming
  `c2-gold-reviewer-gold-v2` and `c2-qa-reviewer-qa-v2`, `retractedBy` the repo
  maintainer (human) — reusing the C0 approval's own verified registry binding
  (`repo-maintainer-1`, registry `1.0`) — `retractedAt` an honest current UTC
  stamp (stamped at write time, not fabricated), `reason` the 2026-07-28
  provenance rationale.
- Add v6's path-keyed pin (`TRACKED_LEDGER_APPROVAL_PINS`), leaving v1–v5 pins
  unchanged. **No artifact-index entry:** verified that ledgers are discovered by
  `readdirSync` and are NOT listed in the artifact index (v5 is not), so v6 needs
  only the file + pin + a valid chain link.
- **No fabrication:** the `cf55fee0` reviewer approvals are NOT written. C2 lands
  cleanly **open** — green-able only when the real Gold Label Owner and QA
  reviewers approve `cf55fee0`.

## Tests / verification

- **Contract tests:** retraction schema (required fields incl. `retractionId`,
  role/kind literals); `z.union` back-compat — a legacy approval row (no
  `recordKind`) parses as an approval; a retraction row parses; a row with an
  unknown `recordKind` is rejected.
- **Digest-stability regression (reviewer [P1]):** `CheckpointApprovals.parse(v5)
  .approvals` deep-equals the raw `v5.approvals` (no `recordKind` added), so
  `ledgerApprovalRowsDigest` — and therefore the v1–v5 pins — do not move.
- **Legacy-parse regression:** the real tracked `checkpoint-approvals-v1..v5` all
  parse unchanged after the schema migration (read-only).
- **Append-only + pin/digest for v6:** v6 = unchanged prefix + appended retraction
  rows satisfies `validateLedgerAppendOnly` against v5 (no `ledger-approval-deleted`
  /`-mutated`), and `ledgerApprovalRowsDigest(v6.approvals)` equals the v6 pin
  entry. **Correct control (reviewer [P3]):** *mutating* a v6 retraction row (e.g.
  its `reason`) changes the rows digest → the v6 **path-keyed pin** mismatches;
  *dropping* the newly appended v6 retraction is caught by the **v6 pin** too (the
  append-only prefix check only guards v6 once v6 has a successor). Assert the
  pin, not append-only, for the drop case.
- **Validator, valid path:** a valid retraction of the two v2s clears both
  temporal findings and removes them from active; C2 reports **open** (never
  closed); the gate carries no new blocking issue.
- **Validator, fail-closed (neuter-and-restore each guard):** an unauthorized
  retractor, a non-human retractor, a retraction naming a missing / later /
  self / retraction-row target, and a duplicate retraction each (a) emit their
  specific finding and (b) suppress nothing — the temporal findings still fire,
  gate red.
- **Model-B invariant test:** retracting a superseding approval does NOT make its
  superseded predecessor active again.
- **Clean-checkout gate run** (per project memory `readiness-verify-on-clean-checkout`):
  compare `origin/main` vs HEAD in throwaway per-commit worktrees, each running
  `npx tsc` inside itself, private mode (`--corpus-path corpus/entries.json`);
  empty stderr is load-bearing (pins in force). Expect `{C0 closed, C1 closed,
  C2 open}` with the two v2 temporal findings gone and no new blocking issue.

## Documentation

- `docs/AGENT_READINESS_STATUS.md` — C2 row: state the recorded retraction and
  that C2 is open pending real `cf55fee0` approvals.
- `docs/c2/c2-checkpoint-approval-handoff.md` — replace the "withdrawal implied
  by a blocking invariant" paragraph with the recorded-retraction state.
- `TODOS.md` — strike the "Approval retraction vocabulary" section (delivered).

## Out of scope

- Writing the `cf55fee0` reviewer approvals (requires real reviewer decisions).
- Any change to `quality-contracts/checkpoint-approvals-v5.json` or earlier
  (byte-identical to origin/main — the retraction is a v6 append).
- The recipeless-checkpoint (`FUTURE_CHECKPOINT_ROLES`) closed-report decision —
  tracked separately.
- Folding the three error-descriptor sanitizers into one util (unrelated).
