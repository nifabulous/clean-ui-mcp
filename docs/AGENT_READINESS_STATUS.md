# Agent Readiness — Status

Single source of truth for the Agent Readiness Phases 0–1C checkpoints and the
C1 executable-contract work. Updated as work lands. The product roadmap
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
| **C1** Agent contract lock | ✅ Closed | Closed by registry/index/ledger v2 (`quality-contracts/agent-readiness/checkpoint-approvals-v2.json`). The registry v2 declares `sole-maintainer-bootstrap` governance with owner `repo-maintainer-1`; Product and Engineering are two role-specific approvals by that single human identity (not two independent people). C0 prefix remains closed and byte-identical. Runtime still advertises the legacy 14-tool surface by design until Phase 1B. |
| C2 Gold readiness | ⬜ Open | Pre-C2 grounded-design foundations have landed (see "Pre-C2 grounded-design foundations" below); C2 itself remains open pending gold execution and Gold Label Owner + QA approval. |
| C3 MCP + create_ui_spec + skill | ⬜ Open | Not started (gated on C1). |
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
- runtime still advertises the legacy 14 tools;
- `npm run validate-readiness-artifacts -- --mode public` reports **C0 closed, C1 closed** with zero issues.

## Honest scope note

R0 makes C0 validation **Git-bound for the C0 recipe** — it resolves approved
bytes from the recorded commit so later C1 edits do not reopen C0. This is the
parent-plan Task T1 design in miniature. The broader closed-world policies and
registry v2 snapshot chains remain parent-plan T1/T2 follow-on work.

## Lane B governance infrastructure

The governance pass is complete and C1 is closed: C0/C1 closed-world policies, the Git-bound C1 recipe, deterministic registry/index/ledger chains, per-approval registry resolution, and automatic append-only ledger validation are implemented. The registry v2 (`approval-actor-registry-v2.json`) declares `sole-maintainer-bootstrap` governance with owner `repo-maintainer-1`. The C1 ledger v2 (`checkpoint-approvals-v2.json`) appends two role-specific approvals — Product and Engineering — by that one human identity against the reviewed C1 manifest; it is **not** two independent people. C0 remains closed via its byte-identical ledger prefix. Lane C (MCP/create_ui_spec/skill) and Lane D remain deferred, gated on this C1 closure.

## Pre-C2 grounded-design foundations

The following grounded-design workspace tasks landed on
`feat/grounded-design-pre-c2` as **pre-C2 foundation work** — they are
foundations for the C2 (Gold readiness) checkpoint, **not** C2 completion. C2
itself remains open pending gold execution and the Gold Label Owner + QA
approvals named in the parent plan. The design authority for this foundation
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

**Checkpoint state:** **C2 remains Open.** C0 remains Closed and C1 remains
Closed; Pass 1 added no checkpoint recipe, policy, approval, registry, index, or
ledger artifact for C2.

**Pass 2:** is the evaluation-harness and pilot-calibration plan and must be
designed from the Pass 1 evidence (the three pilot packages and the contract
schemas), not from any pre-emptive gold claim.
