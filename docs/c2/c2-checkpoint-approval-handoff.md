# C2 Checkpoint Approval Handoff

## Current Evidence

The final independent Gold/QA pair is strict-schema valid and the production
agreement report is `Qualified`. The agreement pair and the parent-authority
baseline source pair are distinct, so the baseline is not silently derived
from the agreement submissions:

| Artifact | Path | SHA-256 |
|---|---|---|
| Gold submission | `eval/c2/label-integrity/parent-evidence/reviewer-gold-pass3.json` | `616cf46a502eb7be96937c1d93926be5d2fdf0676160ff01ea0b29cb0a275d45` |
| QA submission | `eval/c2/label-integrity/parent-evidence/reviewer-qa-pass3.json` | `2f23f41e881fbc910f8c0b2bf1dca4ff582786345241cb1c2cb45b58706a65e7` |
| Parent baseline Gold | `eval/c2/label-integrity/parent-evidence/reviewer-gold.json` | `05996321da048abc5c900d51b51c001cf4a14282ca7fd8d0ef4931edabae7af3` |
| Parent baseline QA | `eval/c2/label-integrity/parent-evidence/reviewer-qa.json` | `31d4c668912f89e0c042e89fb10af5a2305288e80ea03ae0fcc8c30d7d4edd57` |
| Baseline metrics | `eval/c2/label-integrity/baseline-metrics.json` | `1eb7d808c54ac8332671ff671d66681fd0c7434d56ab182ea1e9e8d6be903c25` |
| Adjudication record | `eval/c2/label-integrity/adjudication.json` | `6992be78c7908e766807611313a4175f2e56e9678af0d2ce8b7bfe3873421f6a` |
| Agreement report | `eval/c2/label-integrity/agreement-report.json` | `ce879914eb818233e18b58cf30f608c9b9bafa2f5eede72077c909964d5272e4` |

The report contains nine disagreement entries, all metrics pass, and all eight
hard gates pass. The adjudication record states that the independent labels
were preserved and not rewritten after sealing.

## Required Approvals

The readiness validator requires the active C2 approvals to bind the target
below. Do **not** edit the immutable earlier ledgers — every ledger from v1
through v5 is published on `origin/main` and must stay byte-identical.

`checkpoint-approvals-v5.json` does contain two records that bind the corrected
target, but neither is a valid decision and C2 is **open** — see "Current ledger
state" below before acting on anything in this section. The human-readable
review packet is `docs/c2/c2-approval-target-v1.md`.

- `checkpoint: "C2"`, `approvalKind: "checkpoint"`, `decision: "approved"`,
  `role: "Gold Label Owner"`
- `checkpoint: "C2"`, `approvalKind: "checkpoint"`, `decision: "approved"`,
  `role: "QA"`

Each approval must use the real approver actor ID from
`approval-actor-registry-v3.json` and bind this exact target:

```text
checkpointTargetSha256: cf55fee06a3a1f34da7d90672c3f62d3704fbda7026cf0de2de9c2aba3c78ac0
actorRegistryVersion: 3.0
actorRegistrySha256: 1757976d564265a93faeee51548d9268694e6487b748d5b5d327aa4ee65719c6
planSha256: 09253f91cd90a540eee3cc41200f5c0b4384bd07b897d586f95c83598b4360a1
specSha256: d1634c683ea1f14a520371d31c1ef1841fb603280329dc728470d66016c1b1f9
```

The contract-hash map and approved-artifact hashes are defined by the C2
recipe in `src/readiness/checkpoint-policy.ts` and the tracked
`c2-evidence-manifest-v1.json`. Do not invent actor IDs, registry hashes,
target hashes, or approval timestamps.

The C2 contract hashes currently bound by that recipe are:

| Contract | SHA-256 |
|---|---|
| `src/c2/candidate-contracts.ts` | `3c4585a79b3026e5c819c011d6528115c553faf827c37201c805b85a42d6655b` |
| `src/c2/case-contracts.ts` | `c15cdca193567f814d2d9c83e32d556604b596066ef1ea665272c346e0f6e0a9` |
| `src/c2/condition-contracts.ts` | `17fc64391fdff8eb176a63d1e31ec3ead77402859069f5de0e43a77b2db916a2` |
| `src/c2/evaluation-contracts.ts` | `302c31b2b55b6d00931ac8358bf72e9a2d8e7c179409d702ab6c8466e1645ded` |
| `src/c2/governance-contracts.ts` | `f5ccfe331a4ab0b9accdab683bc198d6cc76ba66117ce17a3baf02de98229710` |
| `src/c2/remediation-contracts.ts` | `275bb9a0eb84b397d1441c8c68ff755883d7ad7526e1cae297a8bd64feca333d` |
| `src/c2/closure-evaluator.ts` | `7eac377a286a283e900699a307c78ecba9ad8efa12d5823730902d3f83a5fc10` |
| `src/c2/label-agreement.ts` | `2ddc8533a27fdb6b99189a1e231b979bfaaf8279cea19ba8e46e5c441904e07b` |

The approvals should explicitly accept the nine disagreements as recorded
agreement evidence. No labels should be changed as part of checkpoint approval.

## Current ledger state — C2 is OPEN

`checkpoint-approvals-v5.json` contains two effective C2 records,
`c2-gold-reviewer-gold-v2` (`reviewer-gold`) and `c2-qa-reviewer-qa-v2`
(`reviewer-qa`). Each supersedes its earlier v1 approval and binds the corrected
target `cf55fee06a3a1f34da7d90672c3f62d3704fbda7026cf0de2de9c2aba3c78ac0`.

**Neither record is a valid decision.** Each copied its `decidedAt` verbatim
from the v1 approval it supersedes (`2026-07-26T21:18:07.000Z` and
`2026-07-26T21:20:11.000Z`), while the target it binds first came into existence
in commit `e176e85` on 2026-07-28. Both therefore claim a decision taken before
the thing decided existed, and no documented reviewer decision for
`cf55fee0…` exists anywhere in the repository.

Readiness validation in both public and private modes reports:

```text
ok: false
checkpointStatus: { C0: closed, C1: closed, C2: open, C3: open, C4: open, C5: open }
issues:
  ledger-supersession-not-later  c2-gold-reviewer-gold-v2
  ledger-supersession-not-later  c2-qa-reviewer-qa-v2
warnings: (none)
```

The external-QA unverifiability caveat is **not** emitted, because it is raised
only when C2 actually closes.

### Withdrawal is recorded here, not in the ledger

The repository owner's decision is to **withdraw** both v2 approvals. That
withdrawal could not be expressed in the ledger itself, for two independent
reasons:

1. **The ledger is append-only by prefix.** `validateLedgerAppendOnly`
   (`src/readiness/contracts.ts`) requires every approval of a predecessor
   ledger to survive at the same index with the same canonical bytes in its
   successor. A `checkpoint-approvals-v6.json` that omitted the two v2 records
   was tested and produces two `ledger-approval-deleted` issues. The records
   cannot be removed from the chain.
2. **There is no withdrawal state.** `CheckpointApproval.decision` admits only
   `approved` or `rejected`. The reviewers did not *reject* the target — they
   never decided on it, so recording `rejected` would be a false statement. A
   superseding record would additionally require the same `actorId` and `role`
   plus a strictly-later `decidedAt`, i.e. a reviewer decision that was never
   made. Nothing was invented to work around this.

So the withdrawal stands as documentation plus a **permanently** failing gate:
the approvals remain on disk as the historical record of an invalid append, C2
reports open, and `ok` stays false even after real decisions replace them — see
"What would close C2" below.

### What would close C2 — two things, not one

**1. Real reviewer decisions.** `reviewer-gold` and `reviewer-qa` must each
independently review the target and evidence above and record a **real**
decision, with the actual wall-clock time of that decision as `decidedAt`,
appended as `checkpoint-approvals-v6.json` (`ordinalVersion: 6`,
`predecessor: { version: "5", sha256: <v5 digest> }`) carrying all eight v5
approvals forward unchanged and appending `c2-gold-reviewer-gold-v3` /
`c2-qa-reviewer-qa-v3` that supersede the v2 records. Do not invent actor IDs,
registry hashes, target hashes, or approval timestamps.

**2. A retraction mechanism, which does not exist yet.** Real decisions alone
will NOT return the gate to `ok: true`. `ledger-supersession-not-later` is
unconditional and blocking: it reports the two defective v2 records whether or
not something later supersedes them, and `validateLedgerAppendOnly` keeps those
records in the chain forever. The check is deliberately unconditional — a
supersession-based demotion was implemented and then removed, because a
fabricated record dated one second after a defective one was enough to flip the
real gate to `ok: true` with `issues: []` and C2 closed, which reduced the cost
of hiding a governance defect from "impossible" to "append one record".

So until the ledger can record a retraction, the readiness gate stays red
permanently and C2 cannot be closed on a clean gate. This is the accepted
tradeoff, decided by the repository owner on 2026-07-28. Tracked in
`TODOS.md` § "Approval retraction vocabulary (the ledger cannot say
'withdrawn')". Do not restore remediability by weakening the check.

### Known open provenance defect (out of scope here)

`artifact-index-v3.json` (`index-c1-v3`) and `c2-evidence-manifest-v1.json`
(`c2-evidence-v1`) were both rewritten in commit `e176e85` on 2026-07-28 but
still declare `createdAt: 2026-07-26T20:15:01.000Z`. Both files are published on
`origin/main`. The declared timestamps are therefore earlier than the bytes they
describe.

This is **not** corrected here. Editing the declared timestamps in place would
newly fail the historically legitimate `c2-*-v1` approvals against the
`approved-artifact-created-after-decision` invariant. Correcting it properly
requires issuing new artifact versions — a decision that has not been made.

## After Approval

Run the readiness validator in both public and private modes. If C2 closes,
recheck credentials, freeze authorization, migration-snapshot/hash-drift
status, and paid-campaign authorization separately. This document does not
authorize paid calls.
