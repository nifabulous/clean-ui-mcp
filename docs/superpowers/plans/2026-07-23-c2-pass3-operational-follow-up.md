# C2 Pass 3 Operational Follow-Up Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute the merged C2 Pass 3 workflow from fresh `main`: verify readiness, prepare baseline inputs, obtain paid-run authorization, run the 80-slot baseline, generate blinded review packets, finalize human scorecards, and run closure evaluation without leaking private evidence or prematurely closing C2.

**Architecture:** Treat this as an evidence-production runbook, not a feature build. All paid calls are gated behind zero-egress validation and an explicit private authorization artifact; all human review outputs are generated through the existing blind-map and scorecard contracts; closure is evaluated only from hash-bound durable artifacts plus private evidence kept under `.c2-private/`.

**Tech Stack:** Git, npm scripts, TypeScript, tsx, Vitest, C2 baseline CLI (`src/scripts/run-c2-baseline.ts`), C2 pilot CLI (`src/scripts/run-c2-pilot.ts`), C2 blinded packet scripts, SHA-256 artifact binding, `.c2-private/` evidence storage.

## Global Constraints

- Start from fresh `main` after PR #47 merge; do not continue operational work from `codex/c2-pass3-execution`.
- Do not delete or rewrite unrelated untracked files currently in the workspace.
- Default checks must make zero paid provider calls.
- No paid provider call may run without a private authorization artifact that names hashes, run count, cost caps, and retry policy.
- Per-run cost ceiling remains `$0.50`; campaign ceiling remains `$5.00` unless a later human freeze artifact explicitly changes the frozen contract.
- Baseline matrix is exactly 80 slots: 75 primary runs plus 5 independent current-grounded runs.
- Preserve every terminal run manifest; never overwrite a terminal run directory.
- Raw responses, blind maps, filled authorizations, and human submissions stay private unless a schema explicitly marks an artifact as durable and boundary-clean.
- The pilot freeze at `eval/c2/calibration/frozen.json` is an input to Pass 3, not the closure freeze. It currently has partial independent coverage, so it cannot satisfy C9. Do not report C2 closed until a post-baseline, human-authored compatibility evaluation is bound into a new Pass 3 freeze and the parent C2 gates also pass.
- Separate paid-run gates from closure gates. Migration source snapshots and the config/pricing hash binding block paid execution; label-integrity baseline metrics, independent label submissions, external QA, and parent-authority approvals may block closure without necessarily blocking the model run. Record each state explicitly.
- C2 remains open if any label-integrity, compatibility, baseline execution, scoring, or closure gate is blocked.

---

## Current File Responsibilities

- `eval/c2/baseline/manifest.json` pins the 25-case baseline manifest, execution matrix, and frozen calibration reference.
- `eval/c2/calibration/frozen.json` pins thresholds, campaign config ref, pricing ref, scorecard refs, and the current compatibility checklist.
- `eval/c2/config/pilot-campaign.json` and `eval/c2/config/pricing.json` define the model lanes, output ceiling, API-key env names, and pricing entries pinned by the frozen calibration.
- `src/scripts/run-c2-baseline.ts` provides `validate`, `prepare`, `run`, `scorecards`, and `closure` subcommands.
- `.c2-private/c2/baseline/` is the private baseline evidence root for condition inputs, raw responses, paid authorization, audit logs, and blind maps.
- `eval/c2/baseline/runs/` is the durable run-manifest and deterministic-score root created by the baseline paid run.
- `eval/c2/baseline/blinded-packets/` is the durable reviewer-visible packet root created by the scorecards command.
- `eval/c2/baseline/compatibility-evaluation.template.json` is the template for the post-baseline human compatibility artifact.
- `scripts/finalize-blind-scorecards.mts` currently finalizes the pilot scorecard flow under `eval/c2/scorecards`; do not assume it finalizes baseline scorecards without verifying paths first.
- `docs/c2/pass3-spec-lock.md` is the authority for the 40-entry label-integrity gates, parent baseline metrics, the 25-case allocation, and the distinction between the pilot freeze and the post-baseline freeze.
- `eval/c2/label-integrity/baseline-metrics.json`, the independent agreement artifacts, external QA review, and parent-authority approvals are upstream closure inputs even though the baseline runner does not consume them directly.

## Task 1: Fresh Main Readiness Check

**Files:**
- Read: `package.json`
- Read: `eval/c2/baseline/manifest.json`
- Read: `eval/c2/calibration/frozen.json`
- Read: `eval/c2/config/pilot-campaign.json`
- Read: `eval/c2/config/pricing.json`
- Modify: none

**Interfaces:**
- Consumes: merged PR #47 on `main`
- Produces: a readiness note naming the current commit, dirty/untracked state, validation status, and any blocker before preparation

- [ ] Confirm the branch and commit.

Run:

```bash
git status --short --branch
git rev-parse HEAD
git log --oneline -3
```

Expected: branch is `main`, `HEAD` includes the PR #47 merge, and only known unrelated untracked files appear.

- [ ] Run zero-egress validation.

Run:

```bash
npm run validate:c2-baseline
npm run validate:c2-baseline-cases
npm test -- --run src/scripts/run-c2-baseline.test.ts src/c2/baseline-compatibility.test.ts
npm run typecheck:contracts
```

Expected: validation and tests pass. If `validate:c2-baseline` warns about calibration config/pricing drift, record it as a blocker for paid execution until the remediation pilot is rerun and refrozen.

- [ ] Check paid-call credentials without printing secret values.

Run:

```bash
node -e 'for (const k of ["OPENAI_API_KEY","ANTHROPIC_API_KEY"]) console.log(`${k}=${process.env[k] ? "set" : "missing"}`)'
```

Expected: both keys are `set` before any paid run. If either is missing, stop before authorization.

- [ ] Inventory upstream human and source-data gates.

Read:

```bash
sed -n '1,180p' docs/c2/pass3-spec-lock.md
find eval/c2/label-integrity -maxdepth 2 -type f 2>/dev/null | sort
find eval/c2/baseline/source-snapshots -maxdepth 1 -type f 2>/dev/null | sort
```

Record these separately:

| Gate | Blocks paid baseline? | Blocks C2 closure? |
| --- | --- | --- |
| Four migration source snapshots | Yes, for affected slots | Yes |
| Frozen config/pricing hash agreement | Yes | Yes |
| Parent-authority label baseline metrics | No, unless the authority says otherwise | Yes, before independent agreement |
| External QA reviewer and review artifacts | No | Yes |
| Parent-authority approval/closure artifacts | No | Yes |

Do not collapse a missing upstream human artifact into a generic "scorecards pending" status.

**Acceptance:** The repo is on fresh `main`, all zero-egress checks pass or blockers are explicitly recorded, the paid-vs-closure gate table is populated, and no paid-call command has run.

## Task 2: Resolve Pre-Paid Blockers

**Files:**
- Create privately if needed: `.c2-private/c2/remediation/`
- Create privately if needed: `.c2-private/c2/freeze-authorization.json`
- Modify only after authorization: `eval/c2/calibration/proposal.json`
- Modify only after authorization: `eval/c2/calibration/frozen.json`
- Modify only after refreeze: `eval/c2/baseline/manifest.json`

**Interfaces:**
- Consumes: readiness result from Task 1
- Produces: either a refrozen calibration/manifest pair or a written blocked status explaining why paid baseline execution cannot proceed

- [ ] If the frozen calibration still pins stale config/pricing hashes, run the remediation pilot plan before baseline paid execution.

The current readiness check already reports this as a blocker: the checked-in pilot freeze pins hashes that differ from the checked-in config and pricing files. Do not treat a warning as clearance. First decide whether the files are the intended reviewed inputs; then either restore the pinned bytes or run the remediation/refreeze path below.

- [ ] Author and bind the four missing migration snapshots before preparing the baseline.

For each staged migration section, obtain the reviewed source snapshot, place it under `eval/c2/baseline/source-snapshots/`, update the corresponding brief's `sourceSnapshotRef.sha256`, and regenerate/check the manifest. The placeholder-hash state must disappear before any affected slot can run.

Run:

```bash
npx tsx src/scripts/run-c2-pilot.ts prepare \
  --config eval/c2/config/pilot-campaign.json \
  --pricing eval/c2/config/pricing.json
```

Expected: prepare succeeds without paid calls.

- [ ] Before any remediation paid run, create a private authorization file.

Create: `.c2-private/c2/remediation/paid-authorization.json`

Required fields:

```json
{
  "artifactType": "c2-paid-run-authorization",
  "scope": "c2-pilot-remediation",
  "campaignConfigPath": "eval/c2/config/pilot-campaign.json",
  "pricingPath": "eval/c2/config/pricing.json",
  "plannedRunCount": 12,
  "maxRunCostUsd": 0.5,
  "maxCampaignCostUsd": 5,
  "retryPolicy": "No unbounded retries; preserve terminal failures and stop on provider-capacity blocker.",
  "authorizedBy": "<human-actor-id>",
  "authorizedAt": "<ISO-8601 timestamp>"
}
```

Expected: file is private and not staged.

- [ ] If authorized, run the remediation pilot exactly through the reviewed CLI.

Run:

```bash
C2_NETWORK_AUDIT=.c2-private/c2/remediation/network-audit.json \
npx tsx src/scripts/run-c2-pilot.ts run \
  --config eval/c2/config/pilot-campaign.json \
  --pricing eval/c2/config/pricing.json \
  --paid
```

Expected: exactly 12 attempted provider calls, no campaign stop, and stablecoin current-grounded Claude succeeds. If it truncates again, preserve evidence and stop.

- [ ] If remediation succeeds, generate scorecards, obtain freeze authorization, refreeze, and rebind baseline manifest.

The remediation pilot writes its runs to `eval/c2/remediation-runs/` and scorecards to `eval/c2/remediation-scorecards/`. Human blind review submissions are required before finalization. The frozen calibration remains under `eval/c2/calibration/`.

Run:

```bash
# Human review must finish first:
# eval/c2/remediation-scorecards/blinded-submissions/

npx tsx scripts/finalize-baseline-blind-scorecards.mts \
  --submissions-dir eval/c2/remediation-scorecards/blinded-submissions \
  --scorecards-dir eval/c2/remediation-scorecards \
  --blind-map-dir .c2-private/c2/remediation/blind-map

node dist/scripts/run-c2-pilot.js propose \
  --runs eval/c2/remediation-runs \
  --scorecards-dir eval/c2/remediation-scorecards

node dist/scripts/run-c2-pilot.js freeze \
  --proposal eval/c2/calibration/proposal.json \
  --authorization .c2-private/c2/freeze-authorization.json \
  --runs eval/c2/remediation-runs \
  --scorecards-dir eval/c2/remediation-scorecards

node dist/scripts/run-c2-pilot.js validate \
  --calibration eval/c2/calibration/frozen.json
npm run generate:c2-baseline
npm run validate:c2-baseline
```

The frozen artifact MUST reference remediation run and scorecard paths (via `runsRoot`/`scorecardsRoot`), not the old pilot paths. These commands do NOT authorize or start the 80-run paid baseline. The 80-run campaign remains blocked until the snapshot and hash-drift gates clear.

Expected: frozen calibration and baseline manifest hashes agree. If human compatibility remains partial, record C2 as blocked instead of forcing closure.

**Acceptance:** Either baseline paid execution is unblocked by a valid frozen calibration/manifest pair and all affected migration snapshots are hash-bound, or the plan stops with a concrete external/provider/human-authorization blocker. Also record whether parent-authority label metrics, independent label agreement, external QA, and approval artifacts are merely pending closure or are required before the paid baseline.

## Task 3: Prepare Baseline Inputs

**Files:**
- Read: `eval/c2/baseline/manifest.json`
- Read: `eval/c2/calibration/frozen.json`
- Create privately: `.c2-private/c2/baseline/condition-inputs/*.json`
- Create privately: `.c2-private/c2/baseline/condition-inputs/*.private.json`

**Interfaces:**
- Consumes: valid manifest/calibration pair from Task 1 or Task 2
- Produces: 75 prepared primary condition descriptors and private payloads

- [ ] Remove only stale baseline condition inputs from a previous attempted run after confirming they are not needed.

Run only if re-preparing from scratch:

```bash
mkdir -p .c2-private/c2/baseline/attic
timestamp=$(date -u +%Y%m%dT%H%M%SZ)
if [ -d .c2-private/c2/baseline/condition-inputs ]; then
  mv .c2-private/c2/baseline/condition-inputs ".c2-private/c2/baseline/attic/condition-inputs-$timestamp"
fi
```

Expected: old private inputs are preserved in the private attic, not deleted.

- [ ] Run baseline preparation.

Run:

```bash
npm run c2:baseline -- prepare \
  --manifest eval/c2/baseline/manifest.json \
  --calibration eval/c2/calibration/frozen.json
```

Expected: output reports `resolved 75 primary condition inputs`.

- [ ] Verify prepared descriptor count.

Run:

```bash
find .c2-private/c2/baseline/condition-inputs -maxdepth 1 -name '*.json' ! -name '*.private.json' | wc -l
find .c2-private/c2/baseline/condition-inputs -maxdepth 1 -name '*.private.json' | wc -l
```

Expected: first count is `75`; second count is `75`.

**Acceptance:** All 75 primary inputs are prepared deterministically under `.c2-private/`, and no provider-call audit file changed.

## Task 4: Baseline Paid-Run Authorization

**Files:**
- Create privately: `.c2-private/c2/baseline/paid-authorization.json`
- Create privately: `.c2-private/c2/baseline/network-audit.json`
- Modify only after paid run: `eval/c2/baseline/runs/`

**Interfaces:**
- Consumes: prepared baseline inputs from Task 3
- Produces: private human authorization permitting exactly the baseline paid campaign

- [ ] Run dry preflight without `--paid`.

Run:

```bash
npm run c2:baseline -- run \
  --manifest eval/c2/baseline/manifest.json \
  --calibration eval/c2/calibration/frozen.json
```

Expected: command exits non-zero, reports `Total planned runs: 80`, lists the five independent IDs, and records zero provider calls.

- [ ] Compute current config, pricing, manifest, and calibration hashes for the authorization.

Run:

```bash
shasum -a 256 \
  eval/c2/baseline/manifest.json \
  eval/c2/calibration/frozen.json \
  eval/c2/config/pilot-campaign.json \
  eval/c2/config/pricing.json
```

Expected: four SHA-256 values are available for the private authorization.

- [ ] Create the private paid authorization file.

Create: `.c2-private/c2/baseline/paid-authorization.json`

Required fields:

```json
{
  "artifactType": "c2-paid-run-authorization",
  "scope": "c2-pass3-baseline",
  "manifestPath": "eval/c2/baseline/manifest.json",
  "manifestSha256": "<computed>",
  "calibrationPath": "eval/c2/calibration/frozen.json",
  "calibrationSha256": "<computed>",
  "campaignConfigPath": "eval/c2/config/pilot-campaign.json",
  "campaignConfigSha256": "<computed>",
  "pricingPath": "eval/c2/config/pricing.json",
  "pricingSha256": "<computed>",
  "plannedRunCount": 80,
  "independentCaseIds": [
    "stablecoin-home",
    "finance-news-story-detail",
    "public-marketing-migration",
    "safety-conflicting-evidence",
    "named-inspiration-safety"
  ],
  "maxRunCostUsd": 0.5,
  "maxCampaignCostUsd": 5,
  "retryPolicy": "Do not overwrite terminal run dirs; use predecessor-bound new run IDs only after human review.",
  "authorizedBy": "<human-actor-id>",
  "authorizedAt": "<ISO-8601 timestamp>"
}
```

Expected: file is private and not staged.

- [ ] Verify that the paid runner actually enforces this authorization.

The merged CLI currently exposes `--paid` but does not accept or validate `paid-authorization.json`. Before using `--paid`, either add a baseline-specific `--authorization`/preflight contract that verifies the file, artifact hashes, run count, independent IDs, caps, and retry policy, or record that the gate is procedural and require a separate operator check that compares every field immediately before launch. A file that merely exists is not enforcement.

**Acceptance:** Authorization exists, names the exact artifacts and cost caps, paid execution is approved by a human actor, and the authorization is either machine-enforced or explicitly verified by a recorded operator preflight.

## Task 5: Execute the 80-Slot Baseline

**Files:**
- Create privately: `.c2-private/c2/baseline/runs/`
- Create privately: `.c2-private/c2/baseline/network-audit.json`
- Create: `eval/c2/baseline/runs/<runId>/manifest.json`
- Create: `eval/c2/baseline/runs/<runId>/score.json`

**Interfaces:**
- Consumes: Task 4 authorization
- Produces: terminal durable run manifests, deterministic scores, private raw responses, and network audit lines

- [ ] Confirm no terminal baseline run directory already conflicts with the planned matrix.

Run:

```bash
find eval/c2/baseline/runs -maxdepth 2 -name manifest.json 2>/dev/null | wc -l
```

Expected: `0` for a clean first campaign. If non-zero, stop and inspect whether this is a retry/resume case.

- [ ] Run the paid baseline campaign.

Run:

```bash
C2_NETWORK_AUDIT=.c2-private/c2/baseline/network-audit.json \
npm run c2:baseline -- run \
  --manifest eval/c2/baseline/manifest.json \
  --calibration eval/c2/calibration/frozen.json \
  --private-root .c2-private \
  --runs-root eval/c2/baseline/runs \
  --paid
```

Expected: command exits `0` only if there is no campaign stop. If it exits non-zero, stop and inspect the terminal reason before retrying anything.

- [ ] Count durable terminal artifacts and private raw responses.

Run:

```bash
find eval/c2/baseline/runs -maxdepth 2 -name manifest.json | wc -l
find eval/c2/baseline/runs -maxdepth 2 -name score.json | wc -l
find .c2-private/c2/baseline/runs -maxdepth 2 -name raw-response.json | wc -l
wc -l .c2-private/c2/baseline/network-audit.json
```

Expected: manifest count is up to `80`; score/raw counts equal the number of successful runs; audit lines equal attempted provider calls. Investigate any mismatch.

- [ ] Summarize terminal statuses.

Run:

```bash
node -e 'const fs=require("fs"),p="eval/c2/baseline/runs"; const counts={}; for (const d of fs.existsSync(p)?fs.readdirSync(p):[]) { const f=`${p}/${d}/manifest.json`; if (!fs.existsSync(f)) continue; const m=JSON.parse(fs.readFileSync(f,"utf8")); const k=`${m.status}:${m.terminalReason}`; counts[k]=(counts[k]||0)+1; } console.log(JSON.stringify(counts,null,2));'
```

Expected: all terminal states are understood. Failed or cost-blocked runs remain preserved and must not be silently excluded.

**Acceptance:** The baseline campaign has immutable evidence for every attempted slot, costs remain inside the frozen caps, and any failure has a recorded terminal reason.

## Task 6: Generate Blinded Packets and Finalize Human Scorecards

**Files:**
- Create: `eval/c2/baseline/blinded-packets/`
- Create: `eval/c2/baseline/blinded-review-provenance.json`
- Create privately: `.c2-private/c2/baseline/blind-map/blind-map.json`
- Create after human review: `eval/c2/baseline/scorecards/*.json`

**Interfaces:**
- Consumes: successful baseline runs from Task 5
- Produces: reviewer-visible blinded packets and finalized human scorecards bound to run/output hashes

- [ ] Generate blinded packets.

Run:

```bash
npm run c2:baseline -- scorecards \
  --manifest eval/c2/baseline/manifest.json \
  --calibration eval/c2/calibration/frozen.json \
  --runs eval/c2/baseline/runs \
  --private-root .c2-private
```

Expected: one packet per successful run, provenance written, private blind map written under `.c2-private/c2/baseline/blind-map`.

- [ ] Confirm packets contain no run, provider, model, condition, or family metadata.

Run:

```bash
node -e 'const fs=require("fs"),p="eval/c2/baseline/blinded-packets"; for (const f of fs.readdirSync(p).filter(x=>x.endsWith(".json"))) { const j=JSON.parse(fs.readFileSync(`${p}/${f}`,"utf8")); const keys=Object.keys(j).sort().join(","); if (keys!=="candidate,reviewId") throw new Error(`${f} has keys ${keys}`); const s=JSON.stringify(j); if (/c2-run-baseline|provider|model|condition|family/.test(s)) throw new Error(`${f} leaks metadata`); } console.log("packet boundary OK");'
```

Expected: `packet boundary OK`.

- [ ] Verify the baseline scorecard finalization path before collecting submissions.

Run:

```bash
sed -n '1,140p' scripts/finalize-blind-scorecards.mts
```

Expected: if the script is still hard-coded to `eval/c2/scorecards`, do not use it for baseline scorecards until it is adapted or a baseline-specific finalizer is written and tested.

- [ ] Implement and test the baseline-aware finalizer before asking for human scoring.

The existing finalizer hard-codes the pilot submission directory, pilot scorecard directory, and pilot blind-map location. Add a baseline-specific command or parameterized finalizer that consumes `eval/c2/baseline/blinded-submissions/`, resolves `.c2-private/c2/baseline/blind-map`, writes boundary-scanned scorecards under `eval/c2/baseline/scorecards/`, and rejects duplicate/already-finalized submissions. Add an offline test that exercises one assigned submission end to end. Do not collect real human submissions until this path passes.

- [ ] Have the Gold Label Owner score every packet using the existing six dimensions.

Expected dimensions:

```text
product-appropriateness
cross-screen-coherence
implementation-clarity
originality
accessibility-and-failure-states
evidence-discipline
```

Expected: every submission references a `reviewId`, not a run ID.

- [ ] Finalize baseline scorecards through a verified baseline-aware finalizer.

Expected: every scorecard is durable, human-authored, `blindedCondition: true`, and bound to the original run/output hash through the private blind map.

**Acceptance:** Human scorecards exist for every required successful run, no blinded packet leaks lane metadata, and private blind-map state prevents duplicate finalization.

## Task 7: Author Compatibility Evaluation

**Files:**
- Read: `eval/c2/baseline/compatibility-evaluation.template.json`
- Create: `eval/c2/baseline/compatibility-evaluation.json`
- Create through a baseline-aware freeze operation: `eval/c2/calibration/frozen-pass3.json`
- Test manually through: `validateBaselineCompatibility`

**Interfaces:**
- Consumes: five independent current-grounded baseline runs and human review judgment
- Produces: one human-authored compatibility artifact

- [ ] Resolve the five independent run refs.

Run:

```bash
node -e 'const fs=require("fs"),crypto=require("crypto"); const ids=["stablecoin-home","finance-news-story-detail","public-marketing-migration","safety-conflicting-evidence","named-inspiration-safety"]; for (const id of ids) { const runId=`c2-run-baseline-${id}-current-grounded-independent-1`; const path=`eval/c2/baseline/runs/${runId}/manifest.json`; const b=fs.readFileSync(path); const m=JSON.parse(b); console.log(JSON.stringify({artifactId:m.artifactId,path,sha256:crypto.createHash("sha256").update(b).digest("hex")})); }'
```

Expected: five refs print successfully. If any is missing, compatibility is blocked.

- [ ] Copy the template to the final artifact and fill every field from human judgment.

Run:

```bash
cp eval/c2/baseline/compatibility-evaluation.template.json eval/c2/baseline/compatibility-evaluation.json
```

Expected: placeholders are replaced before staging; `cliSynthesized` is absent.

- [ ] Validate the compatibility artifact with the runtime validator.

Run:

```bash
node --input-type=module -e 'import fs from "fs"; import crypto from "crypto"; import { validateBaselineCompatibility } from "./dist/c2/baseline-compatibility.js"; const ids=["stablecoin-home","finance-news-story-detail","public-marketing-migration","safety-conflicting-evidence","named-inspiration-safety"]; const refs=ids.map(id=>{ const runId=`c2-run-baseline-${id}-current-grounded-independent-1`; const path=`eval/c2/baseline/runs/${runId}/manifest.json`; const b=fs.readFileSync(path); const m=JSON.parse(b); return {artifactId:m.artifactId,path,sha256:crypto.createHash("sha256").update(b).digest("hex")}; }); const input=JSON.parse(fs.readFileSync("eval/c2/baseline/compatibility-evaluation.json","utf8")); validateBaselineCompatibility(input, refs); console.log("compatibility OK");'
```

Expected: `compatibility OK`. If validation fails, fix the artifact or record C2 as blocked.

**Acceptance:** The compatibility artifact is human-authored, binds exactly five independent run refs, spans product/migration/safety, and passes strict validation.

- [ ] Produce a new post-baseline Pass 3 freeze that binds the compatibility artifact.

The existing `run-c2-pilot.ts freeze` path is pilot-specific and the closure evaluator reads `frozenCalibration.independentChecklist`; it will continue to fail C9 against the current pilot freeze even after the baseline compatibility JSON is authored. Add or use a baseline-aware freeze operation that preserves the pilot freeze, binds the five-run compatibility artifact and the finalized baseline evidence, and writes a distinct Pass 3 calibration artifact. If that operation does not exist, stop here as an implementation blocker rather than claiming closure is ready.

## Task 8: Run Closure Evaluation

**Files:**
- Read: `eval/c2/baseline/runs/`
- Read: `eval/c2/baseline/scorecards/`
- Read: `eval/c2/baseline/compatibility-evaluation.json`
- Read: `eval/c2/calibration/frozen-pass3.json`
- Create: `eval/c2/baseline/closure-report.json`

**Interfaces:**
- Consumes: baseline runs, scorecards, frozen calibration, and compatibility evidence
- Produces: durable closure report with overall pass/fail

- [ ] Run baseline closure.

Run:

```bash
npm run c2:baseline -- closure \
  --manifest eval/c2/baseline/manifest.json \
  --calibration eval/c2/calibration/frozen-pass3.json \
  --runs eval/c2/baseline/runs \
  --scorecards eval/c2/baseline/scorecards \
  --report-path eval/c2/baseline/closure-report.json
```

Expected: command exits `0` only if `overallPassed=true`; otherwise exits `1` while still writing the report when evaluator input is valid.

- [ ] Inspect closure result.

Run:

```bash
node -e 'const r=JSON.parse(require("fs").readFileSync("eval/c2/baseline/closure-report.json","utf8")); console.log(JSON.stringify({overallPassed:r.overallPassed, checks:r.checks?.map(c=>({id:c.id,passed:c.passed,reason:c.reason}))}, null, 2));'
```

Expected: every failed check has a concrete reason. Do not edit thresholds to pass a failed check.

- [ ] Run the parent C2 closure gates separately.

The baseline CLI reports decision-quality checks C1-C9; it does not prove the 40-entry label-integrity agreement, parent baseline-metric binding, external QA review, or role-specific parent approvals. Evaluate those artifacts against `docs/c2/pass3-spec-lock.md` and record their status beside the CLI closure report. Overall C2 closure is allowed only when both layers pass.

- [ ] If closure passes, run final zero-egress verification.

Run:

```bash
npm run validate:c2-baseline
npm run validate:c2-baseline-cases
npm test -- --run src/c2/closure-evaluator.test.ts src/scripts/run-c2-baseline.test.ts src/c2/baseline-compatibility.test.ts
npm run typecheck:contracts
```

Expected: all checks pass.

**Acceptance:** Closure status is explicit. If `overallPassed=false`, C2 remains open with preserved evidence and a clear blocker list.

## Task 9: Commit or Block

**Files:**
- Stage only durable, boundary-clean artifacts
- Never stage: `.c2-private/**`
- Never stage unless explicitly intended: unrelated untracked plan files or `src/GBP movement.xlsx`

**Interfaces:**
- Consumes: outcome from Task 8
- Produces: either an evidence commit/PR or a written blocked status

- [ ] Review staged candidates.

Run:

```bash
git status --short
git diff --stat
git diff --check
```

Expected: no `.c2-private` files appear; unrelated untracked files are left alone.

- [ ] If closure is blocked, commit only durable evidence that is useful for diagnosis and approved for commit.

Commit message:

```bash
git commit -m "evidence(c2): record pass 3 baseline blocker"
```

Expected: commit contains no private raw response, blind map, secret, or filled private authorization.

- [ ] If closure passes, commit the durable evidence.

Commit message:

```bash
git commit -m "evidence(c2): record pass 3 baseline closure"
```

Expected: commit includes validated durable run manifests/scores, scorecards, compatibility artifact, closure report, and any required manifest/calibration rebinding.

**Acceptance:** The repository history records either a clean C2 closure evidence bundle or an explicit blocked state; private materials remain private.

## Self-Review

- Spec coverage: The plan covers fresh-main sync, zero-egress readiness, migration snapshot binding, remediation/refreeze blocker handling, preparation, paid authorization enforcement, paid baseline run, baseline-aware scorecard finalization, compatibility evaluation, post-baseline refreeze, both closure layers, and commit/block handling.
- Placeholder scan: The only placeholder strings are in private artifacts that require human actor IDs, timestamps, and computed hashes at execution time. They are intentionally not durable outputs and must be replaced before use.
- Type consistency: Commands use the merged `run-c2-baseline.ts` subcommands and current npm script names from `package.json`.
