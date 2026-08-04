# Parent-Authority Baseline-Metrics Guide

This document walks you through producing `eval/c2/label-integrity/baseline-metrics.json` — the one artifact blocking the C2 label-integrity gate. It is a **measurement + provenance** task, not a coding task. The implementation is complete; you need real label data.

**Bottom line:** get two independent reviewers to label the same 40 UI screenshots, run one script to get four numbers, paste them into a template with provenance pointing at the reviewers' label files. No inventing values.

---

## Why this artifact exists

The C2 label-integrity gate measures whether two Pass 3 label submissions (Gold + QA) agree well enough. To decide "well enough," it needs a **baseline** — the level of agreement a trusted prior labeling process achieved. The four baseline metric values become the floor that new submissions must clear.

The spec is explicit: these values must come from **parent-authority evidence** (a prior labeling), not from either Pass 3 submission. You can't set the bar by measuring the thing being tested. Source: [`src/c2/evaluation-contracts.ts:151-155`](../../src/c2/evaluation-contracts.ts) (FLAG 7.1/7.3), [`docs/c2/pass3-spec-lock.md`](../c2/pass3-spec-lock.md), [`docs/c2/pass3-external-delivery-spec.md`](../c2/pass3-external-delivery-spec.md).

---

## What the artifact contains

Schema: [`C2LabelIntegrityBaselineMetricsSchema`](../../src/c2/evaluation-contracts.ts) in `src/c2/evaluation-contracts.ts`.

| Field | What it is | Who fills it |
|---|---|---|
| `schemaVersion` | `"1.0"` | fixed |
| `artifactType` | `"c2-label-integrity-baseline-metrics"` | fixed |
| `artifactId` | stable ID, e.g. `c2-label-integrity-baseline-metrics-v1` | you choose |
| `selectionArtifactId` | **pinned** — `c2-label-integrity-selection-v1` | do not change |
| `selectionSha256` | **pinned** — `9ed6ff2d74c0078706c67037910a8f3fcd3c519d9f0d724902022ac2acbe00b7` | do not change |
| `pattern-type-exact-accuracy` | one of the four metrics (0–1) | **computed** |
| `categories-macro-f1` | one of the four metrics (0–1) | **computed** |
| `components-recall` | one of the four metrics (0–1) | **computed** |
| `domain-tags-recall` | one of the four metrics (0–1) | **computed** |
| `sourceArtifactRefs` | ≥1 ref to the parent-authority label files | you provide |
| `computedAt` | ISO-8601 datetime | you choose |
| `baselineMetricsSha256` | self-hash (compute last) | computed |

The two `selection*` fields bind this baseline to the existing 40-entry selection — they must match exactly. The four metric values are the output of measuring agreement between two labelings.

---

## The four metrics, explained

These are computed by comparing two labelings (A and B) over the 40 entries. The math lives in [`src/c2/label-agreement.ts:186-265`](../../src/c2/label-agreement.ts) (`computeMetrics`).

| Metric | What it measures | Range |
|---|---|---|
| `pattern-type-exact-accuracy` | fraction of the 40 entries where A and B agree on `patternType` | 0–1 |
| `categories-macro-f1` | macro-averaged F1 over the union of `categories` labels | 0–1 |
| `components-recall` | avg recall of the `components` set (of B's components found in A's) | 0–1 |
| `domain-tags-recall` | avg recall of the `domainTags` set | 0–1 |

**Directionality:** for the recall metrics, the first file is "predicted" (gold) and the second is "reference" (qa). Swapping the files changes the recall values. Pick an order and stick with it.

**How these become the bar:** in [`src/c2/label-agreement.ts:565-573`](../../src/c2/label-agreement.ts), the baseline value IS the required floor for the two recall metrics, and `max(fixed_floor, baseline_value)` for the other two. So higher baseline = stricter bar for Pass 3.

The fixed floors for the other metrics (for context): [`C2_REPLACEMENT_METRIC_FLOORS`](../../src/c2/evaluation-contracts.ts) in `src/c2/evaluation-contracts.ts:83-90`.

---

## Step-by-step: producing the artifact

### Step 1 — Two reviewers label the 40 entries independently

Each reviewer assigns labels to all 40 entries in the selection, **without seeing each other's work**. This is the real effort — roughly 40 screenshots × 4 fields × 2 reviewers.

**What to label (the 40 entries):** [`eval/c2/label-integrity/selection.json`](../../eval/c2/label-integrity/selection.json) — 35 reproducible + 5 challenge entries.

**The images:** each entry in the selection maps to a corpus screenshot. The selection binds to a frozen corpus snapshot at `.c2-private/corpus-snapshots/327d67aae9e1e44a834fab3cbb82acd361d98137f3efd09652cb05580e8f55dc/entries.json`. For each entry, the image lives at `corpus/<entry.image.path>` (e.g. `corpus/images-private/hume-ai-web-apr-2026-15-4.png`). All 40 resolve.

**The label fields per entry** — from [`EntryLabelSchema`](../../src/c2/evaluation-contracts.ts) in `src/c2/evaluation-contracts.ts:36-47`:

| Field | What to assign | Drives a baseline metric? |
|---|---|---|
| `patternType` | one pattern type (e.g. `dashboard`, `modal`, `landing-page`) | ✅ pattern-type-exact-accuracy |
| `categories` | set of UI categories | ✅ categories-macro-f1 |
| `components` | set of components | ✅ components-recall |
| `domainTags` | set of domain tags | ✅ domain-tags-recall |
| `visualFields` | record of visual attributes | no (required by schema) |
| `groundedClaimIds` | evidence citations | no (required by schema) |
| `accessibilityEvidenceIds` | a11y evidence | no (required by schema) |
| `critiqueQuality` | `insufficient` / `acceptable` / `strong` | no (required by schema) |
| `protectedFieldExpectation` | literal `"unchanged"` | no (invariant) |

Only four fields drive the baseline metrics. The others are required by the schema but don't affect the four numbers — assign them reasonably.

**Tip:** the corpus snapshot already has metadata for each entry (patternType, categories, components, domainTags). You can *seed* the reference labeling from the existing corpus tags rather than labeling from scratch — but recognize that makes the baseline measure "agreement with existing corpus tagging," which is a weaker (more circular) bar. For a proper independent baseline, label from the screenshots.

**Output:** two JSON files, one per reviewer. Each can be:
- a full [`C2IndependentLabelSubmission`](../../src/c2/evaluation-contracts.ts) artifact (validated through the production schema), or
- a bare `{ "labels": [...] }` object, or
- a bare array of label objects.

Each label must have `entryId` + the fields above.

### Step 2 — Compute the four metrics

Use the helper script: [`scripts/compute-baseline-metrics.mjs`](../../scripts/compute-baseline-metrics.mjs).

```bash
# Build first (dist is required for schema validation — the script fails closed without it)
npm run build

# Compute the four metrics
node scripts/compute-baseline-metrics.mjs reviewer-a.json reviewer-b.json

# Machine-readable output + list disagreeing entries
node scripts/compute-baseline-metrics.mjs reviewer-a.json reviewer-b.json --json --disagree
```

Output (example):
```
C2 baseline-bound metrics (gold vs qa):
  pattern-type-exact-accuracy : 0.9000
  categories-macro-f1         : 0.8500
  components-recall           : 0.9200
  domain-tags-recall          : 0.8800
  entries                     : 40
  disagreeing entries         : 4
```

These four numbers are your baseline values. The script is parity-tested against production `computeLabelAgreement` — see [`scripts/compute-baseline-metrics.test.mjs`](../../scripts/compute-baseline-metrics.test.mjs).

### Step 3 — Fill in the template

Use the template: [`eval/c2/label-integrity/baseline-metrics.template.json`](../../eval/c2/label-integrity/baseline-metrics.template.json) (local, gitignored — copy it to `baseline-metrics.json`).

Replace the four `<FILL>` metric values with the numbers from step 2. The two `selection*` fields are already pinned — do not change them.

### Step 4 — Point `sourceArtifactRefs` at the reviewer label files

This is the provenance. Each ref must have `artifactId`, `path` (repo-relative), and `sha256` (64-hex of the file's bytes). Point them at the two reviewer label files from step 1.

```bash
# Get the sha256 of each reviewer file
shasum -a 256 reviewer-a.json
shasum -a 256 reviewer-b.json
```

The referenced files must be present in the repo or delivered alongside the baseline-metrics packet. They must NOT be either Pass 3 submission.

### Step 5 — Compute the self-hash last

`baselineMetricsSha256` is a self-hash over the canonical artifact bytes with the field itself set to the empty string (same pattern as `proposalSha256`). Compute it after all other fields are real:

```bash
# After filling everything except baselineMetricsSha256 (leave it ""), compute:
node -e "
const fs=require('fs'); const crypto=require('crypto');
const art=JSON.parse(fs.readFileSync('eval/c2/label-integrity/baseline-metrics.json','utf8'));
art.baselineMetricsSha256='';
// canonical = sorted keys, no whitespace
function canon(o){if(o===null||typeof o!=='object')return o;if(Array.isArray(o))return o.map(canon);const out={};for(const k of Object.keys(o).sort())out[k]=canon(o[k]);return out;}
const hash=crypto.createHash('sha256').update(JSON.stringify(canon(art))).digest('hex');
console.log('baselineMetricsSha256:', hash);
"
```

Paste that hash into the field, save, and you're done.

### Step 6 — Validate + bind (the gated sequence resumes)

Once `baseline-metrics.json` exists with real values:

1. **Validate** — the label-integrity gate will parse it through `C2LabelIntegrityBaselineMetricsSchema` and check the selection hash matches.
2. **Run label agreement** with `--sole-operator-review` if one operator did both passes (documented as self-consistency, not independent validation).
3. **Recheck credentials + human governance** (incl. the post-baseline compatibility re-freeze).
4. **Reassess paid baseline authorization** only then.

---

## Key files

| File | Role |
|---|---|
| [`eval/c2/label-integrity/selection.json`](../../eval/c2/label-integrity/selection.json) | the 40 entries to label (tracked, the binding target) |
| [`eval/c2/label-integrity/baseline-metrics.template.json`](../../eval/c2/label-integrity/baseline-metrics.template.json) | fill-in template (local, gitignored) |
| [`scripts/compute-baseline-metrics.mjs`](../../scripts/compute-baseline-metrics.mjs) | computes the four metrics from two label files |
| [`scripts/compute-baseline-metrics.test.mjs`](../../scripts/compute-baseline-metrics.test.mjs) | parity test vs production |
| [`src/c2/evaluation-contracts.ts`](../../src/c2/evaluation-contracts.ts) | schema (`C2LabelIntegrityBaselineMetricsSchema`, `EntryLabelSchema`) |
| [`src/c2/label-agreement.ts`](../../src/c2/label-agreement.ts) | production metric math (`computeMetrics`) + how baselines become floors |
| [`docs/c2/pass3-spec-lock.md`](../c2/pass3-spec-lock.md) | the spec (provenance rules, parent-authority requirement) |
| [`docs/c2/pass3-external-delivery-spec.md`](../c2/pass3-external-delivery-spec.md) | delivery contract for the parent authority |
| `.c2-private/corpus-snapshots/327d67aae9e1e44a834fab3cbb82acd361d98137f3efd09652cb05580e8f55dc/entries.json` | frozen corpus snapshot the selection binds to (entry → image path) |

---

## Rules that cannot be bent

1. **No invented values.** The four metrics must come from real inter-reviewer agreement. The schema hashes the provenance; a fabricated file is forged evidence, not a missing artifact filled in. Source: [`docs/c2/pass3-spec-lock.md`](../c2/pass3-spec-lock.md), [`docs/superpowers/plans/2026-07-22-c2-pass3-execution-and-closure.md`](../superpowers/plans/2026-07-22-c2-pass3-execution-and-closure.md) line 42.
2. **`sourceArtifactRefs` must point at parent-authority artifacts**, not either Pass 3 submission. Source: [`src/c2/evaluation-contracts.ts:151-155`](../../src/c2/evaluation-contracts.ts).
3. **The two `selection*` fields are pinned** to the existing selection. A mismatch fails agreement at [`src/c2/label-agreement.ts:165-169`](../../src/c2/label-agreement.ts).
4. **Validation is mandatory.** The helper script fails closed if `dist/` is missing — run `npm run build` first.

---

## Known limitation (production bug, filed separately)

The production metric math at [`src/c2/label-agreement.ts:241-248`](../../src/c2/label-agreement.ts) skips empty QA sets from the recall denominator, contradicting the "empty-set entries contribute 0" comment at line 184. This inflates recall slightly when a reviewer leaves a component/domainTag set empty. The helper script copies this behavior faithfully (parity). Fixing it belongs in production, not the helper, and would change existing metric values — a separate scope decision.
