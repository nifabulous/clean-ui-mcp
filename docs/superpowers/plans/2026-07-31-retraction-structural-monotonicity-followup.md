# Follow-up: retraction structural monotonicity (close the actor-separation manufacture-closure channel)

> **Status:** DEFERRED from PR `feat/approval-retraction-vocabulary`. The branch
> shipped with the policy-role channel fixed (commit `cb69e96`) and this
> presence-only actor-separation channel documented + tripwired but NOT fixed,
> by owner decision (unreachable today — zero C3/C4/C5 approvals). This doc is
> the turnkey spec for the hardening PR.

**Goal:** make retraction *structurally* monotonic toward open so a valid
retraction can never manufacture checkpoint closure through ANY channel, not
just the closed-world role check already fixed in `cb69e96`.

## Background — the invariant and the two channels
Governing invariant: a valid retraction may only REMOVE an approval from
role-satisfaction; it must NEVER remove a blocking finding (other than the two
temporal findings it is built to clear) or move a checkpoint open→closed.

- **Channel 1 (FIXED in `cb69e96`):** `comparePolicySet` (closed-world
  missing/unexpected/duplicate role check) ran over the retracted-excluded set,
  so retracting an extra unexpected-role approval on a policy-backed checkpoint
  (C0/C1/C2) erased `policy-unexpected-role` and the checkpoint closed. Fixed by
  making `activeApprovals` exclude SUPERSEDED only (retracted approvals stay
  visible to `allCpApproved` → `comparePolicySet`), while `cpApprovals` (role
  satisfaction) additionally excludes retracted.
- **Channel 2 (THIS follow-up):** the actor-separation check
  (`approvalsSatisfyActorCardinality`, validator.ts ~1765) is still fed the
  retracted-EXCLUDED `cpApprovals`. On PRESENCE-ONLY checkpoints (C3–C5, no
  `CHECKPOINT_POLICIES` entry, so `comparePolicySet` never runs), a valid
  retraction of an extra duplicate-actor approval erases
  `checkpoint-actor-separation-violation` while required roles stay satisfied →
  the checkpoint closes. Found by independent cross-model (/codex) re-review AND
  independently flagged by the opus branch review.

Why deferred: unreachable with current data (v6 ledger has zero C3/C4/C5
approvals; the tripwire in `tracked-artifacts-readiness.test.ts` fails loudly the
day a C3+ approval lands). Not a regression against `origin/main`. Owner chose
ship-now-harden-later.

## The fix — clean two-set split (closes the whole CLASS, not one channel)
Enforce the invariant structurally: a retracted approval is excluded from
**exactly ONE** computation — the `allRolesPresent` role-satisfaction test — and
**included in every** structural/blocker computation (`comparePolicySet`,
actor-separation, `computeCanonicalTargets`, and the taint loops). Rationale:
including a retracted approval can only ADD a blocker (push open); excluding it
from role-satisfaction can only REMOVE satisfaction (push open). Both edges are
monotonic toward open, so no retraction can manufacture closure via ANY channel.

In the closure loop (validator.ts ~1747-1781), replace the single `cpApprovals`
with two named sets and route every use:
```ts
// STRUCTURAL set: clean (untainted) approvals INCLUDING retracted. Every
// structural blocker runs over this (actor-separation here; the role-set check
// already runs over `allCpApproved`). A retracted approval can only ADD a blocker.
const cpStructural = allCpApproved.filter((a) => !approvalIssueCodes.has(a.approvalId));
// CLOSURE-CONTRIBUTING set: structural MINUS retracted. ONLY these satisfy roles.
const cpClosureContributors = cpStructural.filter((a) => !retractedApprovalIds.has(a.approvalId));
const cleanRoles = new Set<string>(cpClosureContributors.map((a) => a.role));
const allRolesPresent = required.every((r) => cleanRoles.has(r));
const actorCardinalityValid = approvalsSatisfyActorCardinality(cpStructural, resolvedRegistryByApprovalId, implementationActorIds);
if (allRolesPresent && cpStructural.length > 0 && !actorCardinalityValid) {
  const code = "checkpoint-actor-separation-violation";
  issues.push({ code, artifactId: cp, message: /* unchanged */ });
  for (const approval of cpStructural) noteApprovalIssue(approval.approvalId, code);
}
```
After the edit there must be NO `cpApprovals` identifier left in the loop (rename
fully so a future reader can't reintroduce the bug). Leave `activeApprovals`
(superseded-only excluded, from `cb69e96`), the two temporal gates, and
`computeRetractedApprovalIds` untouched.

## Ready-made reference implementation
A complete, RED-verified implementation of exactly this fix + guard-test was
produced during the original branch (before deferral) and is saved as a patch:
`docs/c2/followups/2026-07-31-retraction-structural-monotonicity.patch`
(against `cb69e96`). Re-implement or apply-and-re-verify; do NOT trust the patch
blind — re-run the RED/GREEN and the real gate.

## Tests (TDD, RED first)
1. **Actor-separation regression (RED before fix):** a presence-only checkpoint
   (C3, `FUTURE_CHECKPOINT_ROLES = {Product, QA, Engineering}`) with its roles
   satisfied by clean DISTINCT-actor approvals PLUS an extra approval that
   duplicates one actor (so `approvalsSatisfyActorCardinality` returns false →
   `checkpoint-actor-separation-violation`, C3 open), then a VALID
   Repository-Maintainer retraction of ONLY that extra approval. Assert: the
   separation violation STILL present, `checkpointStatus.C3 === "open"`,
   `ok === false`. Must FAIL pre-fix (C3 closes / violation gone).
2. Keep the round-1 C1 `policy-unexpected-role` regression test green.
3. **Monotonicity guard-test (channel-agnostic):** parameterized property test
   over a table of adversarial fixtures (policy unexpected-role, policy
   duplicate-role, presence-only actor-separation, real v6-vs-v5, Model B). For
   each, compare `effective` (retractions applied) vs `baseline` (retraction rows
   removed) and assert: (a) NO checkpoint flips open→closed; (b) no blocking
   issue present in baseline is missing from effective EXCEPT
   `ledger-supersession-not-later` / `approved-artifact-created-after-decision`
   on a retracted approval. Show it goes RED under the channel-2 defect (route
   actor-separation back to the retracted-excluded set → the presence-only
   fixture fails property (a)).
4. **Real-gate non-regression (MANDATORY):** private+public must stay `ok:true`,
   `{C0 closed, C1 closed, C2 open, C3-5 open}`, ZERO issues, no `retraction-*`,
   `ledgerPinScope: tracked`, empty stderr — byte-identical to today.
5. Remove the KNOWN-RESIDUAL comment block at the actor-cardinality site and the
   tripwire's "deferred" framing once this lands; full readiness suite + `tsc`
   green.

## Commit
```
fix(readiness): retracted approvals stay visible to ALL structural blockers + monotonicity guard-test (close manufacture-closure class)
```
