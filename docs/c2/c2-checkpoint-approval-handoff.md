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
below. Do **not** edit the immutable earlier ledgers — every ledger up to and
including the current head, `checkpoint-approvals-v6.json`, must stay
byte-identical once published; only a new successor ledger may add rows.

`checkpoint-approvals-v5.json` (carried forward unchanged into v6) does contain
two records that bind the corrected target, but neither is a valid decision;
`checkpoint-approvals-v6.json` records both as retracted. C2 is **open** — see
"Current ledger state" below before acting on anything in this section. The
human-readable review packet is `docs/c2/c2-approval-target-v1.md`.

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

The C2 contract hashes currently bound by that recipe are listed below. **They are
Git-bound, not working-tree hashes.** `C2_CONTRACT_BINDINGS` in
`src/readiness/checkpoint-policy.ts` resolves every one of them at
`C2_SOURCE_GIT_SHA` (`fcc21fc803863ad19686044f8a1ae01b384546cf`), so the value to
compare against is `git show <that sha>:<path> | shasum -a 256`, not
`shasum -a 256 <path>`. Those two already differ for
`src/c2/evaluation-contracts.ts` — the working-tree file has changed since the
approvals were recorded, the Git-bound bytes have not, and the gate is unaffected
because it never reads the working tree for these. Do not "correct" the table to
working-tree values: that would falsify the approvals it exists to describe.

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

`checkpoint-approvals-v6.json` (`ordinalVersion: 6`, predecessor v5) carries all
eight v5 approvals forward byte-identical and appends two **retraction**
records: `retraction-c2-gold-v2` retracts `c2-gold-reviewer-gold-v2`,
`retraction-c2-qa-v2` retracts `c2-qa-reviewer-qa-v2`. Both are authorized by
`repo-maintainer-1` (Repository Maintainer — the same identity bound on
`c0-repo-maintainer`), dated `2026-07-31T00:09:24.579Z`, and each gives the
same reason: the retracted approval's `decidedAt` predates the target it binds,
so no reviewer decision on `cf55fee0…` exists.

Readiness validation in both public and private modes now reports:

```text
ok: true
checkpointStatus: { C0: closed, C1: closed, C2: open, C3: open, C4: open, C5: open }
issues: (none)
warnings: (none)
ledgerPinScope: tracked
```

The two `ledger-supersession-not-later` findings that used to hold the gate at
`ok: false` are gone — a validly-authorized retraction of an approval suppresses
the temporal finding attached to it (`src/readiness/validator.ts`, the
suppression path added alongside the retraction vocabulary). No `retraction-*`
issue appears, meaning both retraction records themselves passed validation
(authorized by an actor empowered to retract, correctly ordered after the
approval they target, targeting an actual approval and not another retraction,
and not a duplicate). The external-QA unverifiability caveat is **still not**
emitted, because it is raised only when C2 actually closes, and C2 has not.

### Withdrawal is now recorded in the ledger (v6), not implied by a blocking check

Earlier revisions of this document described the withdrawal as something the
ledger vocabulary could not express — only a failing gate implied it, with no
record in the artifact graph saying "withdrawn". That has changed:
`checkpoint-approvals-v6.json`'s two retraction records ARE the recorded
withdrawal. `recordKind: "retraction"` is a real, schema-validated ledger row
(`src/readiness/contracts.ts`), distinct from an `approved`/`rejected`
`CheckpointApproval`, so the repository owner's decision to withdraw
`c2-gold-reviewer-gold-v2` and `c2-qa-reviewer-qa-v2` no longer stands as
documentation plus a failing gate — it stands as two rows in
`quality-contracts/agent-readiness/checkpoint-approvals-v6.json`, authorized by
`repo-maintainer-1`, that the validator checks and accepts.

**Retracting a superseding approval does not resurrect what it superseded.**
This is why C2 stays open rather than flipping to closed the moment the
retractions land: `computeRetractedApprovalIds` (`src/readiness/validator.ts`,
Model B) removes a retracted approval from the effective set, but the approval
it superseded (`c2-gold-reviewer-gold-v1` / `c2-qa-reviewer-qa-v1`) stays
excluded too, because the retracted record's own `supersedesApprovalId` still
names it. Neither Gold Label Owner nor QA has any valid approval left in the
effective set for C2 as a result — C2 is open because no valid reviewer
decision exists for its target, not because of a lingering blocking finding.
That distinction — zero issues, still open, for an honest reason — is the
state this document now describes, and it is verified by a read-only test in
`src/readiness/tracked-artifacts-readiness.test.ts`.

**How durable that block is — the attacks that were actually run.** Three earlier
versions of this section overstated it: first "permanently", then "durable
against any change confined to `quality-contracts/`", then "case 5 is closed by
the chain being five ledgers long". Each was falsified by a reproduction, so what
follows is only what has been attacked. Every case below was run against a
throwaway `git worktree` copy of the real artifact graph, driving that worktree's
own compiled CLI, with every edit confined to `quality-contracts/`, and every case
is now reported **blocking, with all six checkpoints held open and exit 1**:

1. **Drop or rewrite the records in a successor ledger** → `ledger-approval-deleted`
   / `ledger-approval-mutated` (the prefix rule above); a forked ordinal →
   `chain-duplicate-key` / `chain-fork` / `chain-multiple-heads`. (Tested in an
   earlier round and unaffected by the pin re-keying; not re-run.)
2. **Edit the two `decidedAt` fields of the head ledger in place** → 1 x
   `ledger-approval-pin-mismatch`, from the approval-row pins in
   `src/readiness/ledger-pins.ts`. The pins have to exist: the append-only check
   iterates the *predecessor's* approvals, no `artifact-index` row lists a
   ledger, and `predecessor.sha256` pins the predecessor rather than the file
   declaring it — so before them, this edit yielded `ok: true`, `C2: closed`,
   `All checks passed.`, exit 0.
3. **Rename the head ledger's `artifactId`, then apply the same two edits** → 1 x
   `ledger-approval-pin-mismatch`. The rename is now INERT: the pins are keyed on
   the ledger's FILE PATH, a name held by the directory rather than by the file's
   contents, so renaming the id moves no lookup key and the row edit is caught by
   the digest. Against the earlier `artifactId`-keyed table the rename skipped the
   pin entirely and produced `ok: true`, `C0`/`C1`/`C2` all `closed`, zero issues,
   exit 0.
4. **Append a `checkpoint-approvals-v6.json` without registering its pin**
   (tested in an earlier round, before the real `v6` retraction ledger existed —
   "v6" here names the hypothetical next ledger under test, not the retraction
   ledger this document now describes, which IS pinned; see "What would close
   C2" below for the current next-ledger guidance, now `v7`) → 1 x
   `ledger-approval-pin-missing`, with the two `ledger-supersession-not-later`
   findings still reported beside it. Before coverage existed, an edited and an
   unedited v6 produced byte-identical
   gate output; nothing told the operator the new head was unattested.
5. **Rename EVERY ledger's `artifactId` and repair the four `predecessor.sha256`
   values in a loop, plus the same two `decidedAt` edits** → 1 x
   `ledger-approval-pin-mismatch`. This case previously claimed
   `chain-predecessor-hash-mismatch`, and that was wrong: `predecessor` is
   `{ version, sha256 }` where `version` is the chain ORDINAL, not the
   predecessor's `artifactId`, so the attacker renames v1, hashes the new v1 file,
   writes that hash into v2's `predecessor.sha256`, and walks the cascade up to
   the head, whose file digest is pinned by nothing. The repair is a loop, so
   chain length is not a defence. `chain-predecessor-hash-mismatch` fires only for
   the NAIVE form (renaming without repairing the digests). Against the
   `artifactId`-keyed table with a chain-coverage rule, the repaired form produced
   `ok: true`, `C2: closed`, zero issues, exit 0.
6. **`rm checkpoint-approvals-v{3,4,5}.json`** → 3 x `ledger-approval-pin-absent`.
   Before coverage ran in both directions this produced `ok: true`, zero issues,
   exit 0, with both `ledger-supersession-not-later` findings erased. Those
   findings are still absent under the new code — they live in files that no
   longer exist — but the pinned files' absence is itself blocking, so the gate
   does not go green and no checkpoint closes.
7. **Rename the head ledger FILE**, leaving its `artifactId` alone → 1 x
   `ledger-approval-pin-absent` for the vacated path plus 1 x
   `ledger-approval-pin-missing` for the new one. Under the `artifactId`-keyed
   table this was invisible: C0/C1 stayed closed and only the two pre-existing
   findings were reported.

**What is not covered, stated plainly.** The pins are a **declaration in source,
not a signature**: a change that edits `quality-contracts/` *and*
`TRACKED_LEDGER_APPROVAL_PINS` goes green, and that is a reviewable source diff
rather than a mechanical impossibility. The tracked table is also in force only
for **this repository's own artifact root**, which `ledger-pins.ts` derives from
the module's location on disk — so it is inert when the gate is pointed at a copy
of the graph somewhere else (`--artifact-root <copy>`), which is a change to the
invocation rather than a change confined to `quality-contracts/`. That is now an
explicit opt-out rather than an accident of the working directory: the CLI
defaults its artifact root to the tracked root derived from the module's own
location on disk (it used to infer `resolve(process.cwd(), …)`, which landed on
the tracked root only because `npm run` sets cwd). When a run IS pointed
elsewhere the CLI prints a `notice:` on stderr and the `--json` result carries
`"ledgerPinScope": "none"` (or `"caller"`), so a machine consumer can tell an
attested run from an unpinned one.

**One form of copy did not get that announcement until this commit.** The CLI
resolves the git toplevel with `cwd` set to the artifact root and hard-stops when
that fails, and the stop used to precede both the `notice:` and any JSON output.
A plain directory copy outside every git worktree — the commonest way to point the
gate at a copy — therefore exited 1 with zero bytes of stdout and no `notice:` at
all (reproduced: `exit=1`, `stdout bytes: 0`, no `ledgerPinScope`), so the
sentence above was false exactly where an operator was least likely to notice.
Every copy previously exercised carried git context (an in-repo copy, an injected
`GIT_DIR`/`GIT_WORK_TREE`, or a `git worktree`), which is why nothing caught it.
The pin scope now precedes the hard stop on both channels: the `notice:` prints
first, and with `--json` the failure path emits a complete result — `ok: false`,
every checkpoint `open`, `checkedArtifacts: 0`, a single `config-error`, and the
resolved `ledgerPinScope` — before exiting 1. **The git requirement is not
weakened by this.** A run that cannot reach git cannot recompute any checkpoint
target from recorded-commit bytes, so it validates nothing, closes nothing, and
exits 1; all that changed is that it now says whether the pins would have been in
force. The plain no-git copy is covered by
`src/scripts/validate-readiness-artifacts-cli.test.ts`; the other pins-inert
tests all supply git context and cannot detect a regression here. What was observed on trying it: validating an
edited copy still failed (exit 1, 7 x `index-path-mismatch`) and, at the time,
printed `C2: closed` beside the failure — that display defect is fixed, because
`index-path-mismatch` is keyed to an index row's artifactId and so could not be
attributed to any checkpoint; an issue the run cannot attribute to a checkpoint
now holds every checkpoint open. Repairing those index rows to make the copy
self-consistent then produced 2 x `checkpoint-target-mismatch` + 2 x
`approved-artifact-hash-mismatch` with C2 back to `open`. Neither variant reached
a clean gate; no claim is made that no variant can. Nothing beyond the cases above
is claimed, and no generalisation from them to a class of attacks is made — that
generalisation has been made three times on this control and was wrong each time.
Do not restate the block as durable against "any change confined to
`quality-contracts/`", "permanent", or "unfakeable".

### What would close C2 — one thing remains

Two things used to stand between here and closure. The second — a way for the
ledger to record a retraction — has landed: `checkpoint-approvals-v6.json` now
carries `retraction-c2-gold-v2` and `retraction-c2-qa-v2`, and the readiness
gate reports `ok: true` with zero issues (see "Current ledger state" above).
That was never going to be sufficient on its own — see "Retracting a
superseding approval does not resurrect what it superseded" above — and it
was not meant to be: it clears the false record, it does not supply the real
decision the false record was standing in for.

**What remains: real reviewer decisions.** `reviewer-gold` and `reviewer-qa`
must each independently review the target and evidence above and record a
**real** decision, with the actual wall-clock time of that decision as
`decidedAt`, appended as `checkpoint-approvals-v7.json` (`ordinalVersion: 7`,
`predecessor: { version: "6", sha256: <v6 digest> }`) carrying all ten v6 rows
forward unchanged (eight approvals plus the two retraction records) and
appending `c2-gold-reviewer-gold-v3` / `c2-qa-reviewer-qa-v3` that supersede
the v2 records. Do not invent actor IDs, registry hashes, target hashes, or
approval timestamps.

**Add the new head's approval-row pin in the same change — the gate requires
it.** A ledger's rows are attested only by `TRACKED_LEDGER_APPROVAL_PINS`
(`src/readiness/ledger-pins.ts`), and `validator.ts` step 7c requires **every**
`checkpoint-approvals` FILE under the artifact root to have an entry. Appending
v7 without one emits a blocking `ledger-approval-pin-missing` and holds every
checkpoint open. Keep every existing entry, including v6's (which is what
stops the two retraction rows being rewritten while appending), and add a new
entry KEYED ON THE FILE PATH — `"checkpoint-approvals-v7.json"`, not the
artifact id — with
`ledgerApprovalRowsDigest(JSON.parse(readFileSync("quality-contracts/agent-readiness/checkpoint-approvals-v7.json", "utf-8")).approvals)`.

If `c2-gold-reviewer-gold-v3` and `c2-qa-reviewer-qa-v3` are both genuine,
correctly-bound decisions, this is the change that closes C2 — no further
mechanism is outstanding. **The unconditional temporal check is not weakened by
any of this.** `ledger-supersession-not-later` still fires on any future
approval whose `decidedAt` predates the target it binds, retracted or not; what
changed is that a validly-authorized retraction now removes a specific
already-flagged approval from the *effective* set instead of leaving no way to
express "this one was withdrawn". A fabricated or backdated v3 approval is
still caught by the same check that caught v2 — retraction authorizes
withdrawing a named prior approval, it does not authorize a new one that lies
about its own `decidedAt`.

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
