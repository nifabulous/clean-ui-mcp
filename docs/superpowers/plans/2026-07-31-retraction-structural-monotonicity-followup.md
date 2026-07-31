# Follow-up: retraction structural monotonicity (landed in PR #72)

> **Status:** LANDED in PR #72 (`fix/retraction-structural-monotonicity`).
> This was deferred from PR #71 after the policy-role channel was fixed in
> `cb69e96`; PR #72 closed the presence-only actor-separation channel and the
> later-discovered actor-separation emission-gate channel. This document is now
> the landed design record, not an open implementation plan.

**Goal:** make retraction *structurally* monotonic toward open so a valid
retraction can never manufacture checkpoint closure through ANY channel, not
just the closed-world role check already fixed in `cb69e96`.

## Background — the invariant and the channels
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
- **Channel 2 (FIXED in PR #72):** the actor-separation check
  (`approvalsSatisfyActorCardinality`, validator.ts closure loop) was fed the
  retracted-EXCLUDED closure set. On PRESENCE-ONLY checkpoints (C3-C5, no
  `CHECKPOINT_POLICIES` entry, so `comparePolicySet` never runs), a valid
  retraction of an extra duplicate-actor approval erased
  `checkpoint-actor-separation-violation` while required roles stayed satisfied,
  closing the checkpoint. Fixed by feeding actor-separation from the
  retracted-INCLUDED `cpStructural` set.
- **Channel #4 (FIXED in PR #72):** fixing the actor-separation input set was
  not enough. Its emission gate still read `allRolesPresent`, computed from the
  retracted-EXCLUDED role-satisfaction set. Retracting the sole provider of a
  required role while a separate separation offender remained live suppressed
  the violation and flipped `ok` from false to true. Fixed by gating emission on
  `allRolesPresentStructural`, computed from `cpStructural`.

## The Fix — Clean Two-Set Split
Enforce the invariant structurally: a retracted approval is excluded from
**exactly ONE** computation — the `allRolesPresent` role-satisfaction test — and
**included in every** structural/blocker computation (`comparePolicySet`,
actor-separation, `computeCanonicalTargets`, and the taint loops). Rationale:
including a retracted approval can only ADD a blocker (push open); excluding it
from role-satisfaction can only REMOVE satisfaction (push open). Both edges are
monotonic toward open, so no retraction can manufacture closure via ANY channel.

In the closure loop, the old single `cpApprovals` set was replaced with two
named sets:
```ts
// STRUCTURAL set: clean (untainted) approvals INCLUDING retracted. Every
// structural blocker runs over this (actor-separation here; the role-set check
// already runs over `allCpApproved`). A retracted approval can only ADD a blocker.
const cpStructural = allCpApproved.filter((a) => !approvalIssueCodes.has(a.approvalId));
// CLOSURE-CONTRIBUTING set: structural MINUS retracted. ONLY these satisfy roles.
const cpClosureContributors = cpStructural.filter((a) => !retractedApprovalIds.has(a.approvalId));
const cleanRoles = new Set<string>(cpClosureContributors.map((a) => a.role));
const allRolesPresent = required.every((r) => cleanRoles.has(r));
const allRolesPresentStructural = required.every((r) =>
  cpStructural.some((a) => a.role === r),
);
const actorCardinalityValid = approvalsSatisfyActorCardinality(cpStructural, resolvedRegistryByApprovalId, implementationActorIds);
if (allRolesPresentStructural && cpStructural.length > 0 && !actorCardinalityValid) {
  const code = "checkpoint-actor-separation-violation";
  issues.push({ code, artifactId: cp, message: /* unchanged */ });
  for (const approval of cpStructural) noteApprovalIssue(approval.approvalId, code);
}
```

`activeApprovals` still excludes only superseded approvals. The two temporal
gates and `computeRetractedApprovalIds` stay unchanged.

## Landed Tests
PR #72 added or updated:

1. **Policy-role regression:** C1 unexpected-role retraction cannot erase
   `policy-unexpected-role` or close C1.
2. **Presence-only actor-separation regression:** C3 duplicate-actor retraction
   cannot erase `checkpoint-actor-separation-violation` or close C3.
3. **Channel #4 regression:** retracting the sole QA provider while a separate
   actor-separation offender remains live still emits
   `checkpoint-actor-separation-violation` and keeps `ok: false`.
4. **Channel-agnostic monotonicity guard-test:** table covers policy
   unexpected-role, policy duplicate-role, presence-only actor-separation,
   channel #4, real v6-vs-v5, and Model B. Its properties are general, but its
   coverage is only as strong as the fixture shapes in the table.
5. **Mirror-image role-satisfaction test:** retracting the sole QA approval on
   a clean C3 opens the checkpoint honestly instead of letting a retracted
   approval satisfy roles.
6. **Real-gate non-regression:** public/private tracked readiness remains
   `ok:true`, `{C0 closed, C1 closed, C2 open, C3-C5 open}`, zero issues,
   `ledgerPinScope: tracked`.

## Commit
```
fix(readiness): close C3-C5 actor-separation manufacture-closure channel
```
