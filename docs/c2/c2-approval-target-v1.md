# C2 Approval Target v1

This is the human-reviewable document for the C2 checkpoint approval. The
approval binds the exact target object below and the evidence manifest it names.
It does **not** authorize paid model calls, corpus mutation, retagging, or C3
product work.

## Target Identity

```text
checkpointTargetSha256: 5aed64c695cab715b853ba2219df8b72fffee822607179eea51a488217b4ffed
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
      "sha256": "ac5b06d749b4b2f6dea4d5e06db473d4a765bbbf70720e16a08efebc1198c76e"
    },
    {
      "artifactId": "index-c1-v3",
      "artifactType": "artifact-index",
      "sha256": "4c638a9939cf954397edf3763ecc3ce3346409650f7ee391bc8ed0f9d7b08081"
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
`quality-contracts/agent-readiness/c2-evidence-manifest-v1.json`, which binds:

- The 40-entry selection.
- The strict-valid Gold submission.
- The strict-valid QA submission.
- Parent-authority baseline metrics.
- The adjudication record.
- The agreement report and its nine recorded disagreements.

The underlying reviewer files remain private. Private readiness validation
recomputes their SHA-256 values and checks their artifact identities against the
manifest.

## Human Sign-Off

Each reviewer should confirm the target and evidence independently before that
reviewer's entry is appended to the immutable ledger:

| Role | Actor | Decision | Decided at | Signature / confirmation |
|---|---|---|---|---|
| Gold Label Owner | `reviewer-gold` | Approved | `2026-07-26T21:18:07.000Z` | Recorded as `c2-gold-reviewer-gold-v1` |
| QA | `reviewer-qa` | Approved | `2026-07-26T21:20:11.000Z` | Recorded as `c2-qa-reviewer-qa-v1` |

Approval means: “I reviewed this exact C2 evidence target and accept it for the
C2 readiness checkpoint.” It does not mean that C2 has authorized paid
execution or that the partial compatibility result has been promoted.
