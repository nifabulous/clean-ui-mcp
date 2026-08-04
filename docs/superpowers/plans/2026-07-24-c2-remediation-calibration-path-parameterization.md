# C2 Remediation Calibration Path Parameterization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable the remediation pilot's offline finalize → propose → freeze → validate sequence to consume remediation-specific artifacts while preserving existing pilot behavior and producing correct hash-bound evidence references.

**Architecture:** The CLI accepts an optional scorecard directory for proposal and freeze loading. Calibration freezing accepts repository-relative evidence roots so generated runManifestRefs and scorecardRefs describe the files actually used. The blind-scorecard finalizer accepts three path overrides while retaining baseline defaults. The implementation remains offline; human submissions and freeze authorization remain explicit gates.

**Tech Stack:** TypeScript, Node parseArgs, Vitest, tsx, Zod contracts, canonical JSON, SHA-256 artifact binding, and the existing C2 calibration/finalization modules.

## Global Constraints

- No schema changes.
- No calibration threshold or scoring logic changes.
- No changes to CALIBRATION_DIR; proposals and frozen calibrations remain under eval/c2/calibration.
- Omitting every new flag must preserve current pilot behavior and paths.
- Artifact reference paths must be repository-relative, slash-normalized, and point to the evidence actually consumed.
- Tests must run offline and must not write to the working tree's proposal, frozen calibration, scorecard, or private-artifact paths.
- Do not create, modify, or commit credentials, raw provider responses, blind maps, human submissions, or freeze authorizations as part of implementation.
- Do not run the paid remediation or baseline campaign during implementation.
- The remediation run set is expected to use the existing pilot case-family mapping from eval/c2/pilot/manifest.json; the implementation must verify that assumption rather than silently replacing the mapping.

## Decision D4: Keep Resolution State Private

Do not accept the current resolution artifact location. writePrivateArtifact()
provides atomic writing but does not make an arbitrary directory private. A
blind-resolution.json written under eval/c2/.../blinded-submissions is
trackable unless that path is explicitly ignored, and it contains the
reviewId-to-runId resolution that should remain private.

Keep the public submissions directory limited to reviewer submissions. Store the
resolution manifest beside the private blind map:

~~~text
baseline:
.c2-private/c2/baseline/blind-resolution.json

remediation:
.c2-private/c2/remediation/blind-resolution.json
~~~

Derive this location from the supplied blindMapDir, or add an explicit private
resolution directory to the internal finalizer input while keeping the CLI
surface small. The resolution-path guard and recovery logic must use this
private path.

Use a generic resolution identity for new writes, such as
c2-blind-resolution / c2-blind-resolution-v1, unless preserving the existing
baseline identity is required for compatibility. The artifact is private
bookkeeping, but its storage location is the non-negotiable fix.



## Decision D3: Preserve the Actual Scorecard Filename

Capture the direct JSON filename during scorecard loading and use it when
building frozen scorecard references. Do not enforce an artifactId-based naming
convention, because the loader already accepts any direct JSON filename and the
durable contract is the file's bytes plus its internal artifact identity.

Add an optional internal field to CalibrationScorecard:

~~~ts
scorecardFileName?: string;
~~~

The CLI loader sets it to the actual directory entry name. The reference builder
uses that name and falls back to the artifact's internal ID plus .json for
existing synthetic/direct callers that do not carry filesystem metadata.

The filename must be a single direct JSON filename. Reject path separators,
parent-directory segments, empty values, and non-JSON suffixes before including
it in a durable reference. This keeps the reference repository-relative and
prevents a caller from injecting a nested or absolute path.



## Decision D2: Preserve Repository-Root Execution Convention

Keep repoRelativeEvidenceRoot based on process.cwd(), matching the existing
relPathFromRepo behavior and the CLI's current repository-root convention.

All pilot commands already resolve hardcoded paths such as
eval/c2/pilot/manifest.json and eval/c2/calibration relative to process.cwd().
Changing only evidence-root normalization to use Git's toplevel would create
partial support for subdirectory execution while the rest of the command still
fails or resolves a different project tree.

The operational contract is therefore:

- Run propose and freeze from the repository root.
- Relative paths are interpreted relative to the repository root.
- Absolute paths inside the repository are accepted when invoked from the repository root.
- An invocation from a subdirectory is outside the supported contract and must fail closed with a clear path/root error.
- Do not add a Git subprocess or a cwd assertion in this change.
- Add a short repository-root precondition to the runbook and verify the supported root invocation in tests.



## Decision D1: Remediation Replaces the Canonical Calibration Slot

The remediation calibration intentionally replaces the current pilot calibration
at these canonical paths:

~~~text
eval/c2/calibration/proposal.json
eval/c2/calibration/frozen.json
~~~

The existing paths and artifact IDs remain unchanged:

~~~text
c2-calibration-proposal-pilot-v1
c2-frozen-calibration-pilot-v1
~~~

This is a replacement of the current calibration slot, not a second parallel
calibration. The baseline manifest already points at the canonical frozen path,
and introducing a second output path would require unrelated changes to the
baseline manifest generator, validation commands, and runner contract.

The replacement must still be auditable:

- Before remediation writes, record the current proposal and frozen-file SHA-256 values in the operator's run notes.
- Refuse to proceed if either canonical file has uncommitted changes; the prior committed bytes must be recoverable from Git history.
- Do not create .bak files or commit private backups.
- After freeze, verify the new frozen file binds the remediation runs and scorecards, and then regenerate/rebind the baseline manifest in the same tracked change.
- The old pilot calibration remains recoverable from the prior committed revision; the new calibration becomes the sole canonical input for the next baseline validation.



## File Map

- Modify src/c2/calibration.ts to parameterize frozen evidence-reference roots.
- Modify src/scripts/run-c2-pilot.ts to parse and thread --scorecards-dir and pass remediation evidence roots into freezing.
- Modify scripts/finalize-baseline-blind-scorecards.mts to parse three optional directory flags.
- Modify src/c2/calibration.test.ts to test custom and default frozen reference paths.
- Modify src/scripts/run-c2-pilot.test.ts to test the compiled CLI's custom scorecard flow in an isolated fixture repository.
- Modify scripts/finalize-baseline-blind-scorecards.test.mts to test custom finalizer directories and CLI defaults.
- Modify docs/superpowers/plans/2026-07-23-c2-pass3-operational-follow-up.md to replace stale remediation commands and references.
- Modify docs/c2/pass3-spec-lock.md to distinguish the pre-campaign remediation replacement from the calibration that becomes immutable during baseline execution.

## Task 1: Add Failing Tests for Evidence-Root Binding

**Files:**
- Modify: src/c2/calibration.test.ts
- Read: src/c2/calibration.ts

**Interfaces:**
- Consumes: existing synthetic calibration proposal, run, scorecard, and authorization fixtures.
- Produces: tests that distinguish correct remediation references from the current hardcoded pilot references.

- [ ] **Step 1: Add a custom-root freeze test.**

Extend the existing freeze tests with a valid FreezeCalibrationInput that supplies:

~~~ts
runsRoot: "eval/c2/remediation-runs",
scorecardsRoot: "eval/c2/remediation-scorecards",
~~~

Assert that every generated runManifestRef.path begins with eval/c2/remediation-runs/ and every generated scorecardRef.path begins with eval/c2/remediation-scorecards/.

- [ ] **Step 2: Add a backward-compatibility test.**

Call freezeCalibration() without either optional root and assert that generated paths remain:

~~~text
eval/c2/runs/${runDir}/manifest.json
eval/c2/scorecards/${artifactId}.json
~~~

- [ ] **Step 3: Run the focused tests and confirm the new custom-root test fails.**

Run:

~~~bash
npm test -- --run src/c2/calibration.test.ts
~~~

Expected: existing tests pass, while the new custom-root assertion fails because the current implementation still hardcodes pilot paths.

## Task 2: Parameterize Frozen Evidence References

**Files:**
- Modify: src/c2/calibration.ts
- Test: src/c2/calibration.test.ts

**Interfaces:**
- Consumes: optional repository-relative roots from FreezeCalibrationInput.
- Produces: frozen artifacts whose evidence references point to the actual run and scorecard roots.

- [ ] **Step 1: Extend FreezeCalibrationInput.**

Add optional fields:

~~~ts
runsRoot?: string;
scorecardsRoot?: string;
~~~

Use these defaults inside freezeCalibration():

~~~ts
const runsRoot = input.runsRoot ?? "eval/c2/runs";
const scorecardsRoot = input.scorecardsRoot ?? "eval/c2/scorecards";
~~~

- [ ] **Step 2: Update the reference builders.**

Change the internal helpers to accept the selected roots:

~~~ts
function manifestRef(run: CalibrationRun, runsRoot: string): ArtifactFileRef
function scorecardRef(scorecard: C2HumanScorecard, scorecardsRoot: string): ArtifactFileRef
~~~

Construct paths from those roots and normalize separators to /. Do not accept absolute paths in resulting artifact references.

- [ ] **Step 3: Use the roots when building the frozen artifact.**

Pass the selected roots when building runManifestRefs and scorecardRefs. Keep proposal references, campaign config references, pricing references, schemas, hashes, and artifact IDs unchanged.

- [ ] **Step 4: Preserve the scorecard filename.**

Extend CalibrationScorecard with optional scorecardFileName metadata. Update scorecardRef() to use the actual filename when present and to fall back to the existing artifact-ID filename for synthetic/direct callers. Validate that the selected filename is a single non-empty .json filename with no slash, backslash, or parent-directory segment before constructing the reference path.

- [ ] **Step 5: Run the focused tests.**

Run:

~~~bash
npm test -- --run src/c2/calibration.test.ts src/c2/calibration.e2e.test.ts
~~~

Expected: both custom-root and default-root assertions pass.

## Task 3: Add --scorecards-dir to the Pilot CLI

**Files:**
- Modify: src/scripts/run-c2-pilot.ts
- Test: src/scripts/run-c2-pilot.test.ts

**Interfaces:**
- Consumes: optional --scorecards-dir <dir> on propose and freeze.
- Produces: scorecard loading and frozen references bound to the selected repository-relative roots.

- [ ] **Step 1: Add the parse option and usage text.**

Add:

~~~ts
"scorecards-dir": { type: "string" },
~~~

Document it for both propose and freeze. Do not rename or remove SCORECARDS_DIR.

- [ ] **Step 2: Parameterize scorecard loading.**

Change:

~~~ts
function loadCalibrationScorecards(
  runs: CalibrationRun[],
  scorecardsDir = SCORECARDS_DIR,
): CalibrationScorecard[]
~~~

Use the supplied directory for existence checks, file enumeration, reads, and error messages. Continue reading only direct .json files so nested blinded-packets/ directories are ignored. Set scorecardFileName to the actual direct directory-entry name for every loaded scorecard.

- [ ] **Step 3: Thread the resolved directory through runPropose().**

Resolve the supplied path once:

~~~ts
const scorecardsDir = resolve(
  (args["scorecards-dir"] as string | undefined) ?? SCORECARDS_DIR,
);
~~~

Pass it to loadCalibrationScorecards(). runPropose() continues writing its proposal to CALIBRATION_DIR.

- [ ] **Step 4: Thread both evidence roots through runFreeze().**

Resolve runsDir and scorecardsDir for filesystem reads. Convert them back to repository-relative, slash-normalized paths before passing them to freezeCalibration():

~~~ts
const runsRoot = repoRelativePath(runsDir);
const scorecardsRoot = repoRelativePath(scorecardsDir);
~~~

This prevents absolute machine paths from entering durable artifacts while still allowing absolute CLI inputs when the command is invoked from the repository root. Keep the existing cwd-based convention; do not add a Git toplevel lookup in this change.

- [ ] **Step 5: Preserve the pilot case-family invariant.**

Leave loadPilotPackages() unchanged. Add a test fixture assertion that the 12 remediation run IDs resolve to the known pilot case IDs and families before scorecard reduction proceeds.

- [ ] **Step 6: Add isolated compiled-CLI coverage.**

Extend src/scripts/run-c2-pilot.test.ts with a temporary fixture repository:

1. Copy the pilot manifest, campaign config, pricing file, pilot runs, and valid pilot scorecards into the temporary root.
2. Copy at least one scorecard into a second temporary directory representing eval/c2/remediation-scorecards under a deliberately different filename such as review-123.json.
3. Spawn the compiled CLI with propose --runs ... --scorecards-dir ... from the temporary root.
4. Create a matching offline freeze authorization from the proposal output.
5. Spawn freeze with the same custom scorecard directory.
6. Assert the generated frozen artifact contains only custom remediation run and scorecard paths, and that the mismatched scorecard reference ends in review-123.json rather than being reconstructed from its artifact ID.
7. Assert the temporary root contains the only generated proposal and frozen artifacts.

Do not point this test at the real eval/c2/calibration directory.

- [ ] **Step 7: Run the CLI tests.**

Run:

~~~bash
npm test -- --run src/scripts/run-c2-pilot.test.ts
~~~

Expected: custom-path propose/freeze coverage passes, default pilot coverage remains green, and the network audit remains empty.

## Task 4: Parameterize the Blind-Scorecard Finalizer Entry Point

**Files:**
- Modify: scripts/finalize-baseline-blind-scorecards.mts
- Test: scripts/finalize-baseline-blind-scorecards.test.mts

**Interfaces:**
- Consumes: optional --submissions-dir, --scorecards-dir, and --blind-map-dir flags.
- Produces: the same finalized scorecards under the selected scorecards directory and a private resolution artifact beside the selected blind map.

- [ ] **Step 1: Add Node argument parsing to main().**

Import parseArgs from node:util. Parse the three string options. Preserve these defaults relative to the repository root:

~~~text
eval/c2/baseline/blinded-submissions
eval/c2/baseline/scorecards
.c2-private/c2/baseline/blind-map
~~~

- [ ] **Step 2: Resolve custom paths against the repository root.**

Use the existing repository-root calculation. Relative arguments resolve from the repository root; absolute arguments remain absolute. Pass the resulting paths into finalizeBaselineBlindScorecards().

- [ ] **Step 3: Preserve finalizer behavior.**

Do not change the exported function's finalization semantics, schemas, blind-map transitions, staging recovery, durable boundary scan, or overwrite guard. Change resolution-path calculation so the guard and recovery marker are private beside blindMapDir rather than inside submissionsDir. Use the generic private identity c2-blind-resolution / c2-blind-resolution-v1 for both baseline and remediation writes; this removes the misleading baseline label without adding a scope-specific schema.

- [ ] **Step 4: Add custom-directory test coverage.**

Extend the finalizer tests with temporary remediation directories. Verify:

- A valid submission is finalized under the supplied scorecards directory.
- The blind map is read from the supplied private directory.
- blind-resolution.json is written beside the supplied private blind map.
- No blind-resolution.json is written under the public submissions directory.
- No scorecard is written to the baseline directory.
- .staging is removed after success.

- [ ] **Step 5: Add default-path coverage.**

Exercise the CLI entry point without flags in an isolated repository fixture and verify it resolves the original baseline paths.

- [ ] **Step 6: Run finalizer tests.**

Run:

~~~bash
npm test -- --run scripts/finalize-baseline-blind-scorecards.test.mts
~~~

## Task 5: Update the Operational Runbook

**File:**
- Modify: docs/superpowers/plans/2026-07-23-c2-pass3-operational-follow-up.md

Replace stale remediation instructions that point at pilot paths. Document this exact gated sequence:

The operator must run the sequence from the repository root. The commands do
not promise subdirectory execution because the existing pilot CLI resolves
hardcoded manifest and calibration paths from process.cwd().

Before the first remediation write, record the current canonical calibration
hashes and confirm the files are clean:

~~~bash
shasum -a 256 eval/c2/calibration/proposal.json eval/c2/calibration/frozen.json
git diff --exit-code -- eval/c2/calibration/proposal.json eval/c2/calibration/frozen.json
~~~

The remediation proposal and freeze intentionally overwrite those two
canonical files. After freezing, regenerate the baseline manifest and validate
the manifest-to-calibration hash binding before committing the replacement.

~~~bash
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
~~~

The runbook must state that:

- Human submissions are required before finalization.
- Freeze authorization remains a separate human gate.
- The frozen calibration remains under eval/c2/calibration.
- The frozen artifact must reference remediation paths, not pilot paths.
- The blind-resolution manifest must remain under .c2-private beside the remediation blind map.
- These commands do not authorize or start the 80-run paid baseline.
- The 80-run campaign remains blocked until the snapshot and hash-drift gates are cleared.

Update the normative spec-lock wording so that "pilot freeze remains immutable"
means immutable once the snapshot/hash gates clear and baseline execution begins.
The pre-campaign remediation re-freeze is the explicitly authorized exception
that replaces stale config/pricing bindings before the baseline manifest is
rebound. Do not imply that the post-baseline Pass 3 closure freeze is replaced
by this remediation operation.

## Task 6: Full Verification

- [ ] Run focused tests:

~~~bash
npm test -- --run \
  src/c2/calibration.test.ts \
  src/c2/calibration.e2e.test.ts \
  src/scripts/run-c2-pilot.test.ts \
  scripts/finalize-baseline-blind-scorecards.test.mts
~~~

- [ ] Run contract typechecking:

~~~bash
npm run typecheck:contracts
~~~

- [ ] Run the full build:

~~~bash
npm run build
~~~

- [ ] Confirm no paid calls occurred.

Check only test audit files and confirm they are absent or empty. Do not invoke the paid run --paid command.

- [ ] Perform a reference-integrity review.

Confirm that:

- Default pilot freeze output still references eval/c2/runs and eval/c2/scorecards.
- Custom remediation freeze output references eval/c2/remediation-runs and eval/c2/remediation-scorecards.
- No frozen artifact contains an absolute local filesystem path.
- No generated test artifact exists in the real calibration or private directories.

## Acceptance Criteria

The implementation is complete only when all of the following are true:

1. propose accepts --scorecards-dir and reads the requested scorecards.
2. freeze accepts --scorecards-dir and binds both requested evidence roots.
3. Frozen run and scorecard references match the actual remediation directories.
4. Omitting the new flags preserves existing pilot behavior.
5. The finalizer accepts all three custom directory flags and retains baseline defaults.
6. Existing schemas, artifact IDs, hashes, calibration logic, and private-boundary behavior remain unchanged.
7. Focused tests, typechecking, and build pass.
8. No paid provider call is made.
9. The next operational step after merge is human review of the 12 remediation packets, not the 80-run baseline campaign.

## Plan Self-Review

- **Spec coverage:** CLI loading, frozen reference binding, finalizer paths, tests, documentation, and offline verification are covered.
- **Path coverage:** Both read paths and emitted durable artifact-reference paths are parameterized.
- **Filename coverage:** Frozen scorecard references preserve actual loaded filenames rather than guessing from artifact IDs.
- **Privacy coverage:** Resolution state is written under .c2-private, not beside reviewer submissions in eval/c2.
- **Backward compatibility:** All defaults remain the current pilot paths.
- **Safety:** Human review, authorization, credential handling, and paid execution remain outside implementation.
- **Isolation:** CLI integration tests write only to temporary fixture repositories.
- **No schema drift:** The change affects path construction and CLI plumbing only.
- **Execution convention:** Supported CLI tests and documented operations run from the repository root; subdirectory execution is explicitly out of scope.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 2 | issues_found | Pass 1: 4 findings (3 fixed). Pass 2: 6 findings (2 new P1: containment bypass + empty scorecards; 2 pre-existing deferred: lock/race + duplicate reviewId; 2 already fixed) |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 2 | issues_found | Pass 1: 4 issues (T1-T3 fixed). Pass 2: 2 new P1 (A5 containment, A6 empty scorecards), both resolved as fix-now |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** Pass 2 found 6 findings. 2 are new P1 actionable (containment bypass, empty scorecards). 2 are pre-existing (finalizer lock/race, duplicate reviewId preflight) — not introduced by this diff. 2 were already fixed in pass 1.
- **CROSS-MODEL:** Both reviewers independently identified the same 2 new P1 issues (containment + empty scorecards). Strong agreement signal.
- **VERDICT:** T1-T3 (pass 1) are FIXED and committed. T4 (containment) and T5 (empty scorecards) are the 2 remaining P1 tasks from pass 2. Both are silent-failure gaps. Branch should not merge until T4+T5 land.

**UNRESOLVED DECISIONS:**
- T4 (P1): Replace substring `.c2-private` check with resolve-based path containment — bypass vectors (../traversal, symlinks, external /tmp/.c2-private roots) can leak the unblinding map.
- T5 (P1): Reject empty/incomplete scorecards at freeze time — empty `--scorecards-dir` silently produces a frozen calibration with no human-review evidence binding.
