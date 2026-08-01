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
| **C2** Gold readiness | ✅ Closed | **Closed — v7 records the real Gold Label Owner and QA approvals of cf55fee0.** `quality-contracts/agent-readiness/checkpoint-approvals-v6.json` first appended two retraction records, `retraction-c2-gold-v2` and `retraction-c2-qa-v2`, authorized by `repo-maintainer-1` (the same Repository Maintainer binding recorded on `c0-repo-maintainer`), formally withdrawing `c2-gold-reviewer-gold-v2` and `c2-qa-reviewer-qa-v2` — both had copied their v1 predecessor's `decidedAt`, so each claimed a decision taken before the target it binds (`cf55fee06a3a1f34da7d90672c3f62d3704fbda7026cf0de2de9c2aba3c78ac0`) existed. That retraction cleared the two `ledger-supersession-not-later` findings but did not itself close C2: retracting a superseder does not resurrect the approval it superseded (Model B, `computeRetractedApprovalIds` in `src/readiness/validator.ts`), so neither Gold nor QA had any valid approval left for the target. `quality-contracts/agent-readiness/checkpoint-approvals-v7.json` now appends the real decisions: `c2-gold-reviewer-gold-v3` (`reviewer-gold`, Gold Label Owner, `decidedAt: 2026-07-31T19:10:32Z`) and `c2-qa-reviewer-qa-v3` (`reviewer-qa`, QA, `decidedAt: 2026-07-31T19:15:32Z`), each approving the corrected target `cf55fee0…` with a `decidedAt` strictly after the target first existed — passing the temporal check that caught and retracted the v2s. Distinct human actor IDs satisfy actor-separation, and the closed-world C2 role set `{Gold Label Owner, QA}` is met, so **C2 now closes**. Readiness validation reports `ok: true` with **zero** issues in both modes (`ledgerPinScope: tracked`, empty stderr, exit 0) and **one** non-blocking warning, `c2-external-qa-unverifiable`: the validator enforces distinct, non-implementation actor IDs but cannot verify that `reviewer-qa`'s actor ID is a genuinely external human — that must be established out-of-band (a signed attestation, distinct GitHub accounts, etc.), and the warning exists so the report stays honest about that limit rather than silently asserting an externality it never checked. The **checkpoint map** at C2 closure was `{C0 closed, C1 closed, C2 closed, C3–C5 open}`, holding in both modes. (C3 has since closed; see the C3 row for the current map.) See `docs/c2/c2-checkpoint-approval-handoff.md` for the full retraction + closure record and prior-round history (the retraction vocabulary itself, the pin-robustness attack catalog run against v1–v5, and the reasoning that ruled out a supersession-based demotion). |
| **C3** MCP + create_ui_spec + skill | ✅ Closed | **Closed by registry/index/ledger v4/v4/v8 against the recipe target at `5255a65`.** `approval-actor-registry-v4.json` (`actors-c3-v2`, registry 4.0) and `artifact-index-v4.json` (`index-c3-v2`) supply the artifact set `CHECKPOINT_RECIPES.C3` declares; `checkpoint-approvals-v8.json` appends the three closed-world role approvals: `c3-product` (`pm-1`, Product), `c3-qa` (`reviewer-qa`, QA), and `c3-engineering` (`repo-maintainer-1`, Engineering). Three distinct human actor IDs under `separation-of-duties` governance, none of them the recorded implementer (`impl-agent-1`), so actor separation and the `implementer-self-approval` rule both hold. **`pm-1` gained the `Product` role in registry v4** — it previously held only `PM`, and `validator.ts` requires an approver's registry roles to include the role approved; that grant is durable and not scoped to C3. The ledger head is pinned by its approval-rows digest in `TRACKED_LEDGER_APPROVAL_PINS`, and both hardcoded pin lists in the test suite were extended rather than relaxed. Readiness reports `ok: true` with zero issues in both modes (`ledgerPinScope: tracked`); the checkpoint map is now `{C0 closed, C1 closed, C2 closed, C3 closed, C4-C5 open}`. C3 remains **historical-only by design** — it sets no `integrationGitSha`, so the recipe attests what was reviewed at `5255a65`, not that the live tree still matches it; later hardening is correctly excluded. The same externality limit noted for C2 applies: the validator enforces distinct, non-implementation actor IDs but cannot verify the three are independent people. **Closed before the proposal-only model path begins**, so the signature covers the deterministic baseline rather than a tree containing a model path.|
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

  That gate exits 0 again. As of v7's recorded gold/QA approvals (see the C2
  row above), a live run in either mode reports `ok: true`, `C2: closed`, zero
  issues, **one** warning (`c2-external-qa-unverifiable`, non-blocking),
  empty stderr, `ledgerPinScope: tracked`, and exits **0**. Read `ok: true` /
  exit 0 together with `checkpointStatus.C2: "closed"` as "C2 is approved by
  the real gold and QA reviewers on the ledger" — but note the warning: the
  validator verified the approvals' structure, hashes, ordering, actor
  distinctness, and temporal validity, not the reviewers' real-world identity
  or independence, which remains an operator attestation outside what the
  gate can machine-verify. C0 and C1 remain closed.

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
