# Agent Readiness — Status

Single source of truth for the Agent Readiness Phases 0–1C checkpoints, C2
Gold readiness, and the C1 executable-contract work. Updated as work lands. The product roadmap
(`ROADMAP.md`) and changelog (`CHANGELOG.md`) reference this file for the
readiness-specific stream so shipped work and priorities do not drift between
locations.

**Branch:** `feat/agent-readiness-phase-0-1c`
**Governing plans:**
- `docs/superpowers/plans/2026-07-14-agent-readiness-phase-0-1c-implementation-plan.md` (parent: phases, lanes, checkpoints, Tasks T1–T7)
- `docs/superpowers/plans/2026-07-15-c1-contract-closure-implementation-plan.md` (C1 executable-contract closure)
- `docs/superpowers/plans/2026-07-14-task1-readiness-contracts.md` (readiness artifact contracts)
**Design authority:** `docs/superpowers/specs/2026-07-13-agent-readiness-and-retagging-design.md`

## Checkpoint state

| Checkpoint | Status | Notes |
|---|---|---|
| **C0** Foundation freeze | ✅ Closed | Validated by a Git-bound checkpoint recipe that recomputes the canonical target from recorded-commit bytes (see R0). C1 working-tree edits to the live spec/plan do **not** reopen C0. |
| **C1** Agent contract lock | ✅ Closed | Closed by registry/index/ledger v2 (`quality-contracts/agent-readiness/checkpoint-approvals-v2.json`). The registry v2 declares `sole-maintainer-bootstrap` governance with owner `repo-maintainer-1`; Product and Engineering are two role-specific approvals by that single human identity (not two independent people). C0 prefix remains closed and byte-identical. Runtime still advertises **14** public tools, but the composition is no longer the legacy set it was at C1 closure: the C3 slice deregistered `generate_design_prompt` and registered `create_ui_spec` in its place, so the count is unchanged and the membership is not. `generate_design_prompt` survives as a `LEGACY_TO_BETA_MAP` migration row and as an unregistered internal function; a `tools/call` for it is rejected. |
| **C2** Gold readiness | ⬜ Open | **Reopened.** The two effective C2 records in `quality-contracts/agent-readiness/checkpoint-approvals-v5.json` (`c2-gold-reviewer-gold-v2`, `c2-qa-reviewer-qa-v2`) each bind target `cf55fee06a3a1f34da7d90672c3f62d3704fbda7026cf0de2de9c2aba3c78ac0` but copied the `decidedAt` of the v1 approval each supersedes — so each claims a decision taken before the target it approves existed. No documented reviewer decision for that target exists in the repository. Readiness validation reports `ok: false` with two `ledger-supersession-not-later` issues and `C2: open` in both modes. (The **checkpoint map** — `{C0 closed, C1 closed, C2 open, C3–C5 open}` — holds in both modes and on a clean checkout, measured in per-commit worktrees. The **issue count** is exactly two only where the gitignored private inputs are present: private mode on a fresh clone additionally reports one `corpus-unreadable` and one `c2-evidence-unavailable` per absent evidence path. **C0 and C1 still close — but not because those rows are all attributed to C2, which two rounds of this row claimed and which is false.** Only the `c2-evidence-unavailable` rows are attributed: `verifyPrivateC2Evidence` stamps `checkpoint: "C2"` on every finding it collects (`src/readiness/validator.ts`), which is what stops them holding C0 and C1 open. `corpus-unreadable` carries **neither** `checkpoint` **nor** `artifactId`, so it is fully unattributable — and under the closure gate's widening (an issue the run cannot attribute to a checkpoint holds EVERY checkpoint open) it would hold C0 and C1 open too, if the gate could see it. **It cannot, and the reason is ordering, not attribution:** the corpus check is step 9 of `validateReadinessArtifacts` and runs AFTER step 8's `validateApprovalsAndCheckpoint` has already computed `checkpointStatus`, so `corpus-unreadable` moves `ok` and the exit code and holds no checkpoint open at all. That is a bounded fail-open the validator names in its own attribution block (`config-error`, `corpus-hash-mismatch`, `corpus-count-mismatch`, the private-mode `leak` and `corpus-unreadable` are all post-snapshot), not an accident, and it is what makes `{C0 closed, C1 closed, C2 open}` hold on a clean checkout. Measured on a throwaway `git worktree` of this commit running its own `npx tsc` build, private mode, ten issues (7 x `c2-evidence-unavailable` stamped `C2`, 2 x `ledger-supersession-not-later` keyed to C2 approvalIds, 1 x `corpus-unreadable` with no attribution at all): as shipped, `{C0 closed, C1 closed, C2 open}`; with an identically-shaped unattributed `corpus-unreadable` pushed BEFORE step 8 instead, `{C0 open, C1 open, C2 open}` — the same finding, the same absent file, opposite closure, which is the proof that ordering is the mechanism. **This is a documentation correction, not a code change:** attributing `corpus-unreadable` to C2 would be false (the corpus is a Phase-0 input — it is `phase0-summary.corpusSha256` that binds it, and no C2 record mentions it) and would also be inert, since closure is already computed by the time the row is pushed; moving the check earlier so the attribution mattered would turn C0 and C1 open on every clean clone, which is the regression the `checkpoint` field was added to fix. Those rows mean "your local `eval/` and `corpus/entries.json` are absent", not an evidence-integrity failure.) **To close, two things are needed and only one is available.** (1) `reviewer-gold` and `reviewer-qa` must each record a real decision on the corrected target with a truthful `decidedAt`, appended as a new ledger. (2) The ledger must gain a way to record a **retraction** — which it does not have yet. `ledger-supersession-not-later` is unconditional and blocking, and `validateLedgerAppendOnly` keeps the defective records in the chain as long as the chain's files exist, so real decisions alone leave `ok: false`. (Not "forever": the append-only check compares ledgers that are present and cannot see one being DELETED — `rm` of the newest ledgers erased both findings, verified. What catches that is the pin table's presence rule, `ledger-approval-pin-absent`, not the append-only check.) **The withdrawal is the check, not a ledger edit:** no `quality-contracts/` bytes were changed (`git diff origin/main..HEAD -- quality-contracts/` is empty), both records still read `decision: "approved"`, and nothing in the artifact graph says "withdrawn". The gate therefore stays red until retraction exists; that is the accepted tradeoff (a supersession-based demotion was tried and removed as fail-open — one fabricated record dated a second later flipped the gate green). **How durable the red is — only what has been attacked** (this line has three times overstated it: first "**permanently**", then "durable against any change confined to `quality-contracts/`", then "attack 5 is closed by the chain being five ledgers long"; all three were falsified by a reproduction and are corrected here). The attacks below were each run against a throwaway `git worktree` copy of the real graph driving that worktree's own compiled CLI, each edit confined to `quality-contracts/`, and each is now blocking with **every checkpoint held open** and exit 1: (1) dropping or rewriting the records in a successor ledger → `ledger-approval-deleted`/`ledger-approval-mutated` (tested in an earlier round); (2) editing the two `decidedAt` fields of the head ledger in place → `ledger-approval-pin-mismatch` (before the approval-row pins in `src/readiness/ledger-pins.ts`, this yielded `ok: true`, `C2: closed`, exit 0); (3) renaming the head ledger's `artifactId` and applying the same two edits → `ledger-approval-pin-mismatch`, the rename itself now inert because the pins are keyed on the ledger's FILE PATH (against the earlier `artifactId`-keyed table: `ok: true`, C0/C1/C2 closed, zero issues, exit 0); (4) appending an unpinned `checkpoint-approvals-v6.json` → `ledger-approval-pin-missing`; (5) renaming **every** ledger's `artifactId` and repairing the four `predecessor.sha256` values in a loop plus the same two edits → `ledger-approval-pin-mismatch` — and note the correction: `predecessor.version` is the chain ORDINAL, not the predecessor's `artifactId`, so the cascade repairs cleanly, `chain-predecessor-hash-mismatch` does NOT fire, and chain length is not a defence (against the `artifactId`-keyed table this produced `ok: true`, `C2: closed`, zero issues, exit 0); (6) `rm checkpoint-approvals-v{3,4,5}.json` → 3 x `ledger-approval-pin-absent` (before coverage ran in both directions: `ok: true`, zero issues, exit 0, both `ledger-supersession-not-later` findings erased — deleting the file that holds them is not something `validateLedgerAppendOnly` can see, so it is rule B and not the append-only check that catches this); (7) renaming the head ledger FILE → `ledger-approval-pin-absent` + `ledger-approval-pin-missing`. **Not covered:** the pins are a declaration in source, not a signature, so a change that edits `quality-contracts/` **and** `TRACKED_LEDGER_APPROVAL_PINS` goes green; and the tracked table is in force only for this repository's own artifact root (derived from the module's location on disk), so it is inert when the gate is pointed at a copy of the graph elsewhere — a change to the invocation, and now an explicit one: the CLI defaults its artifact root to that tracked root (it previously inferred it from `process.cwd()`, so the pins engaged only because `npm run` sets cwd), pointing it elsewhere requires `--artifact-root`, and such a run is announced both by a `notice:` on stderr and by `"ledgerPinScope": "none"` in `--json`; neither variant of that tried reached a clean gate. **That announcement claim was false for one form of copy until this commit, and the correction is behavioural, not editorial.** The CLI resolves the git toplevel with `cwd` set to the artifact root and hard-stops when that fails, and that stop used to run BEFORE the notice and before any JSON: a plain `cp -R` of the graph to a directory outside every worktree therefore exited 1 having written zero bytes of stdout and no `notice:` — reproduced, `exit=1`, `stdout bytes: 0`, `ledgerPinScope` absent, notice absent. Only a copy that still carried git context (an in-repo copy, an injected `GIT_DIR`, or a `git worktree`) announced anything, and those were the only forms any test or verification had used, which is why the false claim survived two rounds. The pin scope now precedes the hard stop on both channels: the `notice:` is printed first, and with `--json` the failure path emits a complete result (`ok: false`, every checkpoint `open`, `checkedArtifacts: 0`, one `config-error`, and the resolved `ledgerPinScope`) before exiting 1. **The git dependency itself is unchanged and undiminished** — a run that cannot reach git recomputes no checkpoint target from recorded-commit bytes, so it still validates nothing, still closes nothing, and still exits 1. `src/scripts/validate-readiness-artifacts-cli.test.ts` covers the plain no-git-context copy specifically; the pre-existing pins-inert tests all supply git context and cannot detect its regression. Nothing beyond the attacks above is claimed, and no generalisation from them to a class is made. Tracked in `TODOS.md` § "Approval retraction vocabulary (the ledger cannot say 'withdrawn')". See `docs/c2/c2-checkpoint-approval-handoff.md`. |
| C3 MCP + create_ui_spec + skill | ⬜ Open | **Landed, not closed.** The slice shipped: `create_ui_spec` is a registered public MCP tool (`src/tool-contracts.ts`, registered by `createServer()` in `src/server-factory.ts`), `POST /api/create-ui-spec` is served by `src/scripts/ui-server.ts` behind the CSRF nonce and the `Host` loopback allowlist, the Playground composer is the `/playground` route in `site/src/app/App.tsx` with corpus search moved to `/browse`, and the `clean-ui-design` skill is bundled. **Why it reads `open`: no C3 approval exists.** Nothing else holds it open. An earlier version of this row said closing C3 requires first adding a C3 checkpoint recipe; that was false and it was false in the fail-open direction, so it is corrected here. C3 genuinely has **no recipe** — `src/readiness/checkpoint-policy.ts` declares `export type CheckpointId = "C0" | "C1" | "C2"` and types both `CHECKPOINT_RECIPES` and `CHECKPOINT_POLICIES` as `Record<CheckpointId, …>` — but a recipe is not what closure consults. `FUTURE_CHECKPOINT_ROLES` in `src/readiness/validator.ts` declares `C3: ["Product", "QA", "Engineering"]`, and the closure loop resolves `const required = policy ? policy.requiredRoles : (FUTURE_CHECKPOINT_ROLES[cp] || [])` — the table is the fallback taken whenever no `CHECKPOINT_POLICIES` entry exists. So **three approvals carrying those three roles would flip `C3: closed` with no recipe present.** The suite already asserts exactly that: `src/scripts/validate-readiness-artifacts.test.ts` builds synthetic recipeless C3 approvals (`addSyntheticC3Approvals`) and asserts `checkpointStatus.C3 === "closed"` in "closes C3 when every bound row resolves to the on-disk artifact version" and in "still skips an unresolvable binding on a SUPERSEDED approval". **This recipeless path is materially weaker than the one C0/C1/C2 take, and it is weak in the fail-open direction** — a reader deciding whether to close C3 needs to know the check does not verify what its `closed` verdict appears to verify. `verifyApprovedArtifactSet`, `verifyCheckpointPolicy` and canonical-target recomputation all sit behind `recipe && …` in the validator, so for C3 there is **no recomputation of a canonical target from recorded-commit bytes** (no `checkpoint-target-mismatch` can fire), **no verification that the approval's `approvedArtifacts` set is the right set** (no `approved-artifact-unknown`, no `approved-artifact-hash-mismatch`), and **no closed-world role check** (extra or duplicate roles are not rejected, because `comparePolicySet` is called only when a policy exists). What still applies to C3 is the checkpoint-agnostic layer: ledger/chain/pin integrity, actor separation against each approval's pinned registry, the unconditional temporal checks, and `approved-artifact-version-unresolved`, which requires any row an approval *does* bind to name an on-disk artifact version — it says nothing about which artifacts should have been bound, and cannot fire for an approval that binds nothing. Net: C3 closure is a presence check on three role-matched approvals plus the generic integrity layer. Adding a recipe is what would make a future C3 closure *verifiable*; it is not what makes it *possible*. This row states the mechanism and takes no position on whether C3 should be closed. |
| C4 Terminal 1A outcome + dogfood | ⬜ Open | Not started. |
| C5 Corpus disposition | ⬜ Open | Not started. |

## C1 executable-contract closure — rework status

An external adversarial review of the initial C1 closure (PR #30 at `308114f`)
reproduced seven real holes that the prior in-house holistic review had missed
because it never performed adversarial reproduction. All seven findings were
independently re-verified; two reviewer over-claims were refuted and dropped.
The branch is being reworked task-by-task (R0–R7) under
`superpowers:subagent-driven-development` with **mandatory exploit reproduction**
in every review.

**Rework task status:**

| Task | Finding fixed | Status | Commit |
|---|---|---|---|
| **R0** | P0 — readiness validator trusted fabricated C0 approvals (recomputed nothing) | ✅ Done | `dbcb06e` |
| **R1** | `.min(N).trim()` order let whitespace satisfy length then normalize to empty (68 fields) | ✅ Done | `768083a` |
| **R2** | `community-edition` structured-fallback reason rejected for similar/plan/critique | ✅ Done | `4da1efb` |
| **R3** | Primary/reference ID split incomplete (hard-coded list); nested evidence dedup gaps | ✅ Done | `f7635d1` |
| **R4** | UiSpec authority trusted lane membership without verifying envelope evidence `kind` | ✅ Done | `e42bdec` |
| **R5** | `ToolResultByName<N>` collapsed to `unknown`; error `retryable` not literal-bound | ✅ Done | `fb34e13` |
| **R6** | Docs drift lock derived input/default rows from handwritten prose, not Zod | ✅ Done | `9afc8ec`, `3660e3c` |
| **R7** | Full-range holistic review over `merge-base origin/main HEAD` + final gate + PR #30 | 🟡 In progress | — |

### Verification scorecard (independent reproductions)

| Finding | Claim | Verified outcome |
|---|---|---|
| P0 validator | fabricated approvals pass | **Confirmed.** Corrupting both C0 approvals' target/artifact/plan/spec/contract hashes returned `ok:true, C0:closed`. |
| R1 trim order | 8 spaces pass `productContext` | **Confirmed.** `min(1)` fields also exploitable (single space → empty). |
| R2 community-edition | rejected for similar/plan/critique | **Confirmed** against the plan Task 2 reason table. |
| R3 browse patternType | not enforced as primary key | **Confirmed** (descriptor `extractRefs` returned exemplar IDs; 4-tool hard-code). |
| R3 plan/provenance dedup | nested evidence ref duplicates accepted | **Confirmed** for `structuredDecisions[].evidenceIds` and `provenance.sourceReferences`. |
| R5 type collapse | `ToolResultByName` → `unknown` | **Confirmed** (`makeEnvelope` returned `z.ZodType`; `error` inferred `{}`). |
| R6 drift lock | input/default rows from handwritten prose | **Confirmed** (renderer read `contractDocs`, not the Zod schema). |
| Finding A (reviewer over-claim) | critique top-level `data.evidenceIds` dup accepted | **Refuted** — already rejected via size-mismatch vs envelope. No fix needed. |
| Finding B (R4) | corpus-evidence authority backed only by editorial-kind evidence accepted | **Confirmed.** Validator checked lane membership, not `evidence[].kind`. |

### What "done" requires for C1 closure

C1 is now closed. The final gate shows:
- `typecheck:contracts`, `build`, full offline suite, doctor, corpus/reference/readiness validation all green;
- the P0 fabrication exploit re-run reports `ok:false` + the new issue codes, **and** historical working-tree drift leaves C0 **closed**;
- runtime advertises 14 public tools (the count held; the C3 slice changed which 14 — see the C1 row above);
- `npm run validate-readiness-artifacts -- --mode public` reports **C0 closed, C1 closed**.

  That gate no longer exits 0, and it is not supposed to. As of the C2 withdrawal
  (see the C2 row above) a live run in either mode reports `ok: false`,
  `C2: open`, and exactly **two** `ledger-supersession-not-later` issues
  (`c2-gold-reviewer-gold-v2`, `c2-qa-reviewer-qa-v2`), with zero warnings and
  empty stderr, and exits **1**. The "zero issues" this bullet used to claim was
  true of the C1 closure run and is false of the current tree; C0 and C1 remain
  closed within that failing run. Do not read the exit code as a C0/C1
  regression, and do not "fix" the gate to exit 0.

## Honest scope note

R0 makes C0 validation **Git-bound for the C0 recipe** — it resolves approved
bytes from the recorded commit so later C1 edits do not reopen C0. This is the
parent-plan Task T1 design in miniature. The broader closed-world policies and
registry v2 snapshot chains remain parent-plan T1/T2 follow-on work.

## Lane B governance infrastructure

The governance pass is complete and C1 is closed: C0/C1 closed-world policies, the Git-bound C1 recipe, deterministic registry/index/ledger chains, per-approval registry resolution, and automatic append-only ledger validation are implemented. The registry v2 (`approval-actor-registry-v2.json`) declares `sole-maintainer-bootstrap` governance with owner `repo-maintainer-1`. The C1 ledger v2 (`checkpoint-approvals-v2.json`) appends two role-specific approvals — Product and Engineering — by that one human identity against the reviewed C1 manifest; it is **not** two independent people. C0 remains closed via its byte-identical ledger prefix. Lane C (MCP/create_ui_spec/skill) is **no longer deferred — it shipped** as the C3 slice; see the C3 row in the checkpoint table for what landed and why the checkpoint is still open. Lane D remains deferred.

## Pre-C2 grounded-design foundations

The following grounded-design workspace tasks landed on
`feat/grounded-design-pre-c2` as **pre-C2 foundation work** — they are
foundations for the C2 (Gold readiness) checkpoint, **not** C2 completion at
that historical stage. The Gold Label Owner + QA approvals named in the parent
plan were subsequently recorded. The design authority for this foundation
work is `docs/superpowers/specs/2026-07-18-grounded-design-workspace-design.md`.

| # | Commit | Description |
|---|---|---|
| Task 1 (boundary only) | `36baa83` (+ `e1ed968` symlink rejection) | Allowlist-based public-asset boundary checker (`check-public-site-boundary.mjs`) wired into `npm run build`; symlink exfiltration vector closed. The corpus removal + public-site sanctioned assets land with the public-site reconstruction PR (see note below). |
| Task 2 | `651dfae` (+ fixes `bde63c9`, `e94f826`) | `DesignSourceSnapshotSchema` and the deterministic `SOURCE-DESIGN.md` renderer; hardened cell escaping and determinism; recomputed same-origin and rejected duplicate evidence IDs (`e94f826`). |
| Task 3 | `fcad588` (+ fixes `2dcb0ab`, `55ba144`, `e1ed968`) | `planRepresentativeCrawl` and `assertSafeHostedCaptureTarget` hosted SSRF guard; percent-encoded destructive-path, NaN-budget, fractional-budget, start-URL safety, non-http(s)/userinfo rejection (`55ba144`), full `fe80::/10` IPv6 link-local (`e1ed968`), and `/api` case-insensitive matching. |
| Task 4 | `b2b8248` (+ `e1ed968`) | Ephemeral session policy: `decideCookie` + `chooseConsentAction`; bare-public-suffix parent-domain rejection (`e1ed968`). |
| Task 5 | `0118452` (+ fixes `925096e`, `e94f826`, `e1ed968`, `be6ac93`, `6bf545a`) | Deterministic grounded design-handoff gold gate scorer with 12 briefs and 12 labels; required declared blueprints, null-entry guards (`925096e`); strict malformed-label fail-closed + real fixture gating (`e94f826`); evidence-required decisions + canonicalized inaccessible-URL matching + symlink-aware boundary + label-permitted lane authority (`e1ed968`); empty-but-present-label rejection and label-specific lane enforcement (re-review, this commit); isolated evidence:[] regression test (`be6ac93`). |

Note: Task 1 split across two PRs. The **boundary checker module and its
`npm run build` wiring ship here** (`36baa83`) with a narrow allowlist (just the
corpus-free `snapshot.json`). The **corpus removal** (deleting the 787 uncleared
`site/public/entries/` images), the synthetic snapshot installation, and the
**allowlist extension** to cover the real public-site sanctioned assets
(`robots.txt`, `sitemap.xml`, the generated bundle) land with the public-site
reconstruction PR, because those assets are not on `main` yet.

### Explicitly future plans (NOT completed work)

The following are explicitly **future plans** and are not claimed as completed or
as part of C2 completion:

- the hosted design-source generator;
- Playground conversion;
- Decision Lab integration;
- Curator Scout;
- authenticated capture;
- BYOK (bring-your-own-key);
- framework adapters.

### C2 Pass 1 — contracts and pilot

This records the **provisional** C2 Pass 1 boundary. It is foundation work that
explicitly does **not** close C2.

**What landed (provisional, schema-only):**
- C2 contract schemas under `src/c2/` — case, evaluation, remediation, and
  governance contracts — plus a *provisional* evidence-manifest schema whose
  `state` is pinned to `"provisional"` and which has **no approvals field**
  (promotion to frozen/approved happens in the readiness validator, never inline
  in the artifact).
- A three-package pilot under `eval/c2/pilot/` (one case each from the
  `migration`, `product`, and `safety` families), bound into a single
  content-addressed manifest (`eval/c2/pilot/manifest.json`) by
  `scripts/build-c2-pilot-manifest.mjs`.
- A Pass 1 scope-boundary test (`src/c2/pass1-boundary.test.ts`) that asserts the
  *absence* of C2 readiness activation and that pilot files stay outside the
  browser-downloadable public assets.

**What did NOT happen in Pass 1 (these remain Pass 2+ work):**
- No provider/model run was executed.
- No 40-entry gold selection was produced (the pilot is exactly 3 packages).
- No independent external labeling occurred (labels are synthetic, internal).
- No retag generation ran.
- No corpus mutation occurred.
- No approval was issued.

**Historical checkpoint state:** **C2 was Open at Pass 1.** C0 remains Closed
and C1 remains Closed; the later C2 recipe, evidence manifest, registry/index
chain, and approval ledger are recorded in the current checkpoint summary above.

**Pass 2:** is the evaluation-harness and pilot-calibration plan and must be
designed from the Pass 1 evidence (the three pilot packages and the contract
schemas), not from any pre-emptive gold claim.

### C2 Pass 2 — harness readiness (PR 1)

This records the **Pass 2 harness implementation** landing on the PR 1 branch
(`codex/c2-pass2-harness-pr1`). It is the offline evaluation harness plus a
synthetic end-to-end calibration proof; it explicitly does **not** close C2 and
does **not** execute any paid provider call.

**What landed (implementation, offline-only):**
- The complete Tasks 1–8 harness under `src/c2/`: condition resolver
  (`condition-resolver.ts`), prompt builder (`prompt-builder.ts`), model
  telemetry (`model-telemetry.ts`), cost policy (`cost-policy.ts`), run-state
  matrix + audit (`harness.ts`), private artifacts (`private-artifacts.ts`),
  the metadata-blinding protocol (`review-packets.ts`:
  `createBlindAssignment` / `buildBlindedReviewPacket` /
  `finalizeBlindScorecard`), the calibration reducer
  (`calibration.ts`: `buildCalibrationProposal` /
  `evaluateIndependentCompatibility` / `freezeCalibration`), and the
  `c2:pilot` CLI (`src/scripts/run-c2-pilot.ts`) with its `prepare` /
  `run` / `propose` / `freeze` / `validate` subcommands.
- The CLI `prepare` command resolves every campaign condition input offline
  against the reviewed `eval/c2/config/pilot-campaign.json`: nine primary
  condition inputs (3 cases × 3 OpenAI conditions) plus the configured three
  Claude independent inputs (3 cases × `current-grounded`, reusing the same
  prepared files), with **zero provider calls**. Current-grounded records
  identify production corpus entries as `corpus:<entry-id>`; complete rankings
  stay private under `.c2-private/`; gold records resolve every label gold ID
  exactly; no reviewer-only sentinel appears in any prompt or retrieval query.
- A synthetic end-to-end calibration proof
  (`src/c2/calibration.e2e.test.ts`, OV7) that exercises the **real**
  propose → blind-score → finalize → freeze flow against **fake** fixtures
  (run manifests, candidate outputs, blind submissions, campaign/pricing refs)
  and an injected in-memory private blind-map store. It makes **zero network
  calls**, writes **only** under the injected store, and proves the three
  freeze-negative cases fail closed (unknown/reused `reviewId`, proposal-hash
  mismatch, changed scorecard output hash). This closes the loop the two-PR
  split exists to protect: the first end-to-end exercise happens here, in PR 1,
  not in PR 2 after paid runs.

**What did NOT happen in PR 1 (these remain PR 2 / Task 10 work):**
- No paid provider/model run was executed (`OPENAI_API_KEY` /
  `ANTHROPIC_API_KEY` never read; the `run` subcommand was not invoked against
  a real account).
- No canonical human scorecard was produced from a real blinded review.
- No `eval/c2/calibration/proposal.json` or `frozen.json` was authored; the
  synthetic proof exercises the reducers in-memory only.
- No approval or freeze authorization was issued against real evidence.
- No retagging is authorized; the corpus is unchanged.

**Historical checkpoint state:** **C2 was Open at PR 1.** C0 remains Closed and
C1 remains Closed; the later C2 recipe, evidence manifest, registry/index chain,
and approval ledger are recorded in the current checkpoint summary above.
**Paid pilot calibration remains an explicit operational gate** (Task 10 / PR 2):
it requires freshly verified official pricing, valid provider credentials, real
human scorecards, and an explicit freeze authorization before any frozen
calibration artifact may be produced. **No retagging is authorized** at any
point in Pass 2; corpus disposition is a separate, later checkpoint (C5).
