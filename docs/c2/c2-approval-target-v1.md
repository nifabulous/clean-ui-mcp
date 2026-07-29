# C2 Approval Target v1

This is the human-reviewable document for the C2 checkpoint approval. The
approval binds the exact target object below and the evidence manifest it names.
It does **not** authorize paid model calls, corpus mutation, retagging, or C3
product work.

## Target Identity

```text
checkpointTargetSha256: cf55fee06a3a1f34da7d90672c3f62d3704fbda7026cf0de2de9c2aba3c78ac0
sourceGitSha: fcc21fc803863ad19686044f8a1ae01b384546cf
actorRegistryVersion: 3.0
actorRegistrySha256: 1757976d564265a93faeee51548d9268694e6487b748d5b5d327aa4ee65719c6
```

The target SHA is the SHA-256 of the canonical serialization of the complete
target object below. Whitespace and presentation formatting in this document
are not part of the target hash.

## Canonical Target

```json
{
  "checkpoint": "C2",
  "baselineGitSha": "374f72073c81ea7901696333cd875fe75b348e6b",
  "artifacts": [
    {
      "artifactId": "actors-c1-v3",
      "artifactType": "approval-actor-registry",
      "sha256": "1757976d564265a93faeee51548d9268694e6487b748d5b5d327aa4ee65719c6"
    },
    {
      "artifactId": "c2-evidence-v1",
      "artifactType": "c2-evidence-manifest",
      "sha256": "c4e4b0402c23c1c701369c89450c5c2e89b029d37451939a7a1d257525387cb7"
    },
    {
      "artifactId": "index-c1-v3",
      "artifactType": "artifact-index",
      "sha256": "c60390e01de336ba4bc4f6ec4a5f18bfa39af1e6b7ff8a969b0d518113c37445"
    }
  ],
  "planSha256": "09253f91cd90a540eee3cc41200f5c0b4384bd07b897d586f95c83598b4360a1",
  "specSha256": "d1634c683ea1f14a520371d31c1ef1841fb603280329dc728470d66016c1b1f9",
  "actorRegistryVersion": "3.0",
  "actorRegistrySha256": "1757976d564265a93faeee51548d9268694e6487b748d5b5d327aa4ee65719c6",
  "contractHashes": {
    "src/c2/candidate-contracts.ts": "3c4585a79b3026e5c819c011d6528115c553faf827c37201c805b85a42d6655b",
    "src/c2/case-contracts.ts": "c15cdca193567f814d2d9c83e32d556604b596066ef1ea665272c346e0f6e0a9",
    "src/c2/condition-contracts.ts": "17fc64391fdff8eb176a63d1e31ec3ead77402859069f5de0e43a77b2db916a2",
    "src/c2/evaluation-contracts.ts": "302c31b2b55b6d00931ac8358bf72e9a2d8e7c179409d702ab6c8466e1645ded",
    "src/c2/governance-contracts.ts": "f5ccfe331a4ab0b9accdab683bc198d6cc76ba66117ce17a3baf02de98229710",
    "src/c2/remediation-contracts.ts": "275bb9a0eb84b397d1441c8c68ff755883d7ad7526e1cae297a8bd64feca333d",
    "src/c2/closure-evaluator.ts": "7eac377a286a283e900699a307c78ecba9ad8efa12d5823730902d3f83a5fc10",
    "src/c2/label-agreement.ts": "2ddc8533a27fdb6b99189a1e231b979bfaaf8279cea19ba8e46e5c441904e07b"
  },
  "inputHashes": {}
}
```

## Evidence Being Approved

The target approves the hash-only manifest
`quality-contracts/agent-readiness/c2-evidence-manifest-v1.json`, which binds
these eight artifacts — the enumeration below must match the manifest's
`evidence` array exactly, in order:

| # | Artifact ID | Path | What it is |
|---|---|---|---|
| 1 | `c2-label-integrity-selection-v1` | `eval/c2/label-integrity/selection.json` | The 40-entry selection. |
| 2 | `c2-submission-reviewer-gold-v1` | `eval/c2/label-integrity/parent-evidence/reviewer-gold-pass3.json` | The strict-valid Gold Pass-3 submission (agreement pair). |
| 3 | `c2-submission-reviewer-qa-v1` | `eval/c2/label-integrity/parent-evidence/reviewer-qa-pass3.json` | The strict-valid QA Pass-3 submission (agreement pair). |
| 4 | `c2-parent-baseline-reviewer-gold-v1` | `eval/c2/label-integrity/parent-evidence/reviewer-gold.json` | The Gold parent-authority baseline submission. |
| 5 | `c2-parent-baseline-reviewer-qa-v1` | `eval/c2/label-integrity/parent-evidence/reviewer-qa.json` | The QA parent-authority baseline submission. |
| 6 | `c2-label-integrity-baseline-metrics-v1` | `eval/c2/label-integrity/baseline-metrics.json` | Parent-authority baseline metrics. |
| 7 | `c2-adjudication-v1` | `eval/c2/label-integrity/adjudication.json` | The adjudication record. |
| 8 | `c2-label-agreement-report-v1` | `eval/c2/label-integrity/agreement-report.json` | The agreement report and its nine recorded disagreements. |

Rows 4 and 5 are the distinct baseline source pair — the baseline is not derived
from the agreement submissions in rows 2 and 3. An earlier version of this packet
listed only six bindings and omitted that distinction.

The underlying reviewer files remain private. Private readiness validation
recomputes their SHA-256 values and checks their artifact identities against the
manifest.

## Human Sign-Off

Each reviewer should confirm the target and evidence independently before that
reviewer's entry is appended to the immutable ledger:

| Role | Actor | Decision | Decided at | Signature / confirmation |
|---|---|---|---|---|
| Gold Label Owner | `reviewer-gold` | **Not decided** | — | Pending. `c2-gold-reviewer-gold-v2` is withdrawn (see the note below on what "withdrawn" means here). |
| QA | `reviewer-qa` | **Not decided** | — | Pending. `c2-qa-reviewer-qa-v2` is withdrawn (see the note below). |

**Neither reviewer has approved this target.** The two ledger records that bind
it (`c2-gold-reviewer-gold-v2`, `c2-qa-reviewer-qa-v2`) each copied the
`decidedAt` of the earlier v1 approval they supersede, so each asserts a decision
made before this target existed. Both are withdrawn; C2 is open.

**"Withdrawn" here means invalidated by a validator check, not removed from the
ledger.** Both records are still present in
`quality-contracts/agent-readiness/checkpoint-approvals-v5.json` and still read
`decision: "approved"`; no `quality-contracts/` bytes were changed. What withdraws
them is the `ledger-supersession-not-later` check, which reports their `decidedAt`
as temporally impossible and blocks the gate. The ledger has no vocabulary for
recording a retraction yet — tracked in `TODOS.md` § "Approval retraction
vocabulary". Do not fill in a
`Decided at` value that is not the actual wall-clock time of a real review. See
`docs/c2/c2-checkpoint-approval-handoff.md` for the ledger mechanics and what
would close C2.

Approval means: “I reviewed this exact C2 evidence target and accept it for the
C2 readiness checkpoint.” It does not mean that C2 has authorized paid
execution or that the partial compatibility result has been promoted.
