# C2 Pass 3 External Delivery Specification

This document is for the parent authority, the credential operator, and the
external QA reviewer. Do not fabricate values, use placeholders, or infer
source content from the case brief. The campaign remains blocked until the
required inputs pass the repository validators.

## 1. Parent-authority delivery

Deliver these five tracked artifacts together:

| Artifact | Required path | Required identity |
| --- | --- | --- |
| Migration snapshot | `eval/c2/baseline/source-snapshots/migration-documentation-site.json` | `artifactId: c2-snapshot-migration-documentation-site-v1`, `projectId: migration-documentation-site` |
| Migration snapshot | `eval/c2/baseline/source-snapshots/migration-saas-dashboard.json` | `artifactId: c2-snapshot-migration-saas-dashboard-v1`, `projectId: migration-saas-dashboard` |
| Migration snapshot | `eval/c2/baseline/source-snapshots/migration-content-product.json` | `artifactId: c2-snapshot-migration-content-product-v1`, `projectId: migration-content-product` |
| Migration snapshot | `eval/c2/baseline/source-snapshots/migration-regulated-service.json` | `artifactId: c2-snapshot-migration-regulated-service-v1`, `projectId: migration-regulated-service` |
| Label baseline metrics | `eval/c2/label-integrity/baseline-metrics.json` | `artifactType: c2-label-integrity-baseline-metrics` |

### Migration snapshot contract

Each snapshot must parse as `DesignSourceSnapshotSchema` from
`src/design-source/contracts.ts`. Its top-level shape is:

```json
{
  "schemaVersion": "1.0",
  "artifactType": "design-source-snapshot",
  "artifactId": "<case-specific ID above>",
  "projectId": "<case-specific project ID above>",
  "source": {
    "kind": "user-supplied-public-reference",
    "origin": "https://<same-origin-site>",
    "startingUrls": ["https://<same-origin-site>/... "]
  },
  "capturedAt": "<ISO-8601 timestamp>",
  "crawl": {
    "maxRoutes": 1,
    "sameOrigin": true,
    "authenticated": false,
    "mutationAllowed": false
  },
  "coverage": [
    {
      "url": "https://<same-origin-site>/...",
      "status": "inspected",
      "reason": "<why this route was inspected>",
      "archetype": "<route archetype>",
      "viewports": ["desktop"]
    }
  ],
  "foundations": {
    "colors": [],
    "typography": [],
    "spacing": [],
    "radii": [],
    "shadows": [],
    "layout": []
  },
  "components": [],
  "responsiveFindings": [],
  "accessibility": [],
  "motion": [],
  "voice": [],
  "evidence": [],
  "limitations": []
}
```

`coverage` must contain at least one entry. Where the source record contains
findings, every finding must reference an evidence ID, every evidence ID must
be unique, and every evidence record must be used by at least one finding.
Every URL in `source.startingUrls`, `coverage`, and `evidence` must share the
origin in `source.origin`. The crawl must be unauthenticated and mutation-free.

Finding records require:

```json
{
  "id": "<stable finding ID>",
  "value": "<observed value>",
  "role": "<semantic role>",
  "confidence": "low | medium | high",
  "evidenceIds": ["<matching evidence ID>"]
}
```

Evidence records require:

```json
{
  "id": "<unique evidence ID>",
  "kind": "dom-signal | screenshot-observation | css-declaration | machine-inference | public-content",
  "route": "https://<same-origin-site>/...",
  "summary": "<source-grounded observation>",
  "basis": "visible | dom-grounded | declared | inferred"
}
```

Do not include credentials, authenticated pages, private corpus paths, or
claims that are not supported by the supplied public source record.

### Snapshot hash handoff

The four migration briefs currently contain an all-zero placeholder SHA. After
the parent-approved files are delivered:

1. Compute SHA-256 over each exact file's bytes.
2. Replace only the matching brief's `sourceSnapshotRef.sha256` with that
   lowercase 64-hex digest. Preserve the existing `artifactType:
   "design-source-snapshot"`, `artifactId`, and `path` fields; the reference
   object is strict and deleting any of them fails validation. Do not reformat
   the snapshot after hashing.
3. Regenerate the baseline manifest.
4. Run the manifest and case validators. A hash mismatch, schema error,
   artifact-ID mismatch, project-ID mismatch, symlink, or cross-origin URL is a
   hard stop.

Expected brief references:

| Case | Brief | Snapshot |
| --- | --- | --- |
| `migration-documentation-site` | `eval/c2/baseline/briefs/migration-documentation-site.json` | `eval/c2/baseline/source-snapshots/migration-documentation-site.json` |
| `migration-saas-dashboard` | `eval/c2/baseline/briefs/migration-saas-dashboard.json` | `eval/c2/baseline/source-snapshots/migration-saas-dashboard.json` |
| `migration-content-product` | `eval/c2/baseline/briefs/migration-content-product.json` | `eval/c2/baseline/source-snapshots/migration-content-product.json` |
| `migration-regulated-service` | `eval/c2/baseline/briefs/migration-regulated-service.json` | `eval/c2/baseline/source-snapshots/migration-regulated-service.json` |

## 2. Parent-authority baseline metrics

Create `eval/c2/label-integrity/baseline-metrics.json` with this exact shape.
The four metric values must come from parent-authorized baseline evidence, not
from either Pass 3 submission:

```json
{
  "schemaVersion": "1.0",
  "artifactType": "c2-label-integrity-baseline-metrics",
  "artifactId": "<stable parent-approved ID>",
  "selectionArtifactId": "c2-label-integrity-selection-v1",
  "selectionSha256": "<hash of selection.json>",
  "pattern-type-exact-accuracy": 0.0,
  "categories-macro-f1": 0.0,
  "components-recall": 0.0,
  "domain-tags-recall": 0.0,
  "sourceArtifactRefs": [
    {
      "artifactId": "<parent evidence artifact ID>",
      "path": "<repository-relative or approved evidence path>",
      "sha256": "<exact SHA-256 of referenced bytes>"
    }
  ],
  "computedAt": "<ISO-8601 timestamp>",
  "baselineMetricsSha256": "<self-hash described below>"
}
```

Values must be finite numbers in `[0, 1]`. The four metric properties are flat
top-level fields; do not put them under `values`. `sourceArtifactRefs` must
contain at least one parent-authority artifact and must not reference either
independent Pass 3 submission. Each reference must contain exactly
`artifactId`, `path`, and `sha256`; `sha256` must match the exact bytes at that
approved parent-evidence path. The referenced artifact must already be present
in the repository or included in the separately approved delivery packet.

The current selection file is
`eval/c2/label-integrity/selection.json`. Its current SHA-256 is:

```text
9ed6ff2d74c0078706c67037910a8f3fcd3c519d9f0d724902022ac2acbe00b7
```

Recompute it at handoff time; if the selection changes, use the new hash and
stop for review. Compute `baselineMetricsSha256` over the canonical JSON with
`baselineMetricsSha256` temporarily set to the empty string, then insert the
resulting lowercase 64-hex digest into the final artifact. The final file must
still parse through `C2LabelIntegrityBaselineMetricsSchema`.

## 3. Credential operator handoff

Set these environment variables in the operator's private `.env` or process
environment. Never paste their values into chat, commits, logs, or artifacts:

```text
OPENAI_API_KEY=<private value>
ANTHROPIC_API_KEY=<private value>
```

The only acceptable confirmation is:

```text
OPENAI_API_KEY=set
ANTHROPIC_API_KEY=set
```

Credentials alone do not authorize a paid call. The operator must still create
the private paid-authorization artifact after the snapshot/hash gates clear.

## 4. External QA reviewer handoff

The reviewer must be an independent human actor, distinct from the Gold Label
Owner. The reviewer labels the frozen 40-entry selection, not a generated
subset and not the baseline metrics artifact.

Required submission properties:

- `artifactType: c2-independent-label-submission`
- `actorKind: human`
- `reviewerRole: QA`
- distinct `actorId` from the Gold Label Owner
- the exact selection artifact ID and selection SHA
- exactly 40 labels matching the frozen selection IDs
- no duplicate entry IDs
- sealed timestamp and evidence-backed labels

## 5. Acceptance packet

The resumption packet should contain only:

1. The four snapshot files and their computed SHA-256 values.
2. The updated migration brief refs and regenerated manifest hash.
3. `baseline-metrics.json`, its self-hash, and parent source references.
4. Credential presence confirmation, never credential values.
5. QA reviewer actor ID, role, and expected delivery date.

After receipt, run zero-egress validation first. Only when the snapshots and
hash-drift gate both pass may the remediation pilot authorization be prepared.
