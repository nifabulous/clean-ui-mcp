# C2 Checkpoint Approval Handoff

## Current Evidence

The final independent Gold/QA pair is strict-schema valid and the production
agreement report is `Qualified`:

| Artifact | Path | SHA-256 |
|---|---|---|
| Gold submission | `eval/c2/label-integrity/parent-evidence/reviewer-gold-pass3.json` | `616cf46a502eb7be96937c1d93926be5d2fdf0676160ff01ea0b29cb0a275d45` |
| QA submission | `eval/c2/label-integrity/parent-evidence/reviewer-qa-pass3.json` | `2f23f41e881fbc910f8c0b2bf1dca4ff582786345241cb1c2cb45b58706a65e7` |
| Baseline metrics | `eval/c2/label-integrity/baseline-metrics.json` | `d7100f324352ab8b7b96be0c364f3f5bfb6274e384a98ce1c529ff1a57f66e94` |
| Adjudication record | `eval/c2/label-integrity/adjudication.json` | `6992be78c7908e766807611313a4175f2e56e9678af0d2ce8b7bfe3873421f6a` |
| Agreement report | `eval/c2/label-integrity/agreement-report.json` | `1bb34cc7476d9d37bfe1ab11f0f075f1a6e2016773831f6a5df28d583ae3a047` |

The report contains nine disagreement entries, all metrics pass, and all eight
hard gates pass. The adjudication record states that the independent labels
were preserved and not rewritten after sealing.

## Required Approvals

The readiness validator still reports C2 as open because the checkpoint ledger
has no C2 checkpoint approvals. Do **not** edit the immutable v2 ledger. Create
an append-only `checkpoint-approvals-v3.json` after both reviewers explicitly
approve the target below. The human-readable review packet is
`docs/c2/c2-approval-target-v1.md`.

- `checkpoint: "C2"`, `approvalKind: "checkpoint"`, `decision: "approved"`,
  `role: "Gold Label Owner"`
- `checkpoint: "C2"`, `approvalKind: "checkpoint"`, `decision: "approved"`,
  `role: "QA"`

Each approval must use the real approver actor ID from
`approval-actor-registry-v3.json` and bind this exact target:

```text
checkpointTargetSha256: 5aed64c695cab715b853ba2219df8b72fffee822607179eea51a488217b4ffed
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

Current ledger state: both `reviewer-gold` and `reviewer-qa` have approved the
same target in `checkpoint-approvals-v4.json`. Public and private readiness
validation now report C2 closed with no issues.

## After Approval

Run the readiness validator in both public and private modes. If C2 closes,
recheck credentials, freeze authorization, migration-snapshot/hash-drift
status, and paid-campaign authorization separately. This document does not
authorize paid calls.
