# TODOS

Deferred work with enough context to pick up later. Each entry states what, why,
and the trigger that makes it worth doing.

---

## Python sidecar for eval/metrics

**What:** Extract the C2 metric + label-agreement computation from TypeScript
into a small Python process called from the TS harness. Not a rewrite — the
MCP server, image toolchain (sharp/playwright/node-vibrant), and corpus site
stay in TypeScript. Only the eval/metrics math moves.

**Why:** The eval harness currently hand-rolls metric math in TypeScript
(`src/c2/label-agreement.ts:186`, `computeMetrics`). This works at 40-entry
scale but the eval will grow substantially. The cost of hand-rolling
numerical/statistical work already produced one bug: the empty-set recall
semantics at `label-agreement.ts:241-248` skip the denominator (inflating
recall), contradicting the "empty-set entries contribute 0" comment at line
184. That's the kind of edge case `sklearn.metrics` handles correctly by
default.

Python would also bring: `pandas` for scorecard analysis, mature inter-annotator
agreement tooling (Cohen's κ, Krippendorff's α) once the labeling pool grows
beyond two reviewers, and `scipy` for any significance testing.

**Trigger (build when EITHER is true):**
- Eval grows past ~hundreds of entries (current scale: 40-entry baseline +
  12-run pilot).
- A second statistical metric is needed that TS would require hand-rolling
  (e.g. confidence intervals, κ, significance tests).

**Until then:** the TS implementation is sufficient. The helper script
`scripts/compute-baseline-metrics.mjs` is parity-tested against production
`computeLabelAgreement` and covers the current baseline-production workflow.

**Scope when triggered:**
- New `eval-sidecar/` (or `python-eval/`) directory: a small Python package
  exposing metric computation over two label files.
- TS harness calls it via `execFile` or a thin HTTP/stdio boundary.
- Migrate `computeMetrics` (`label-agreement.ts:186-265`) + the four
  baseline-bound metrics. Keep the TS schema validation (Zod) as the source of
  truth for artifact shape — Python receives validated inputs.
- Fix the empty-set recall bug as part of the migration (count empty-set
  entries as 0 recall, not skip from denominator).
- Re-run the parity test against the new Python implementation.

**Depends on / blocked by:** Nothing. Self-contained. The TS harness continues
to own schema validation, artifact hashing, and the MCP/corpus surface.

**Also tracked at:** `ROADMAP.md` → "🔴 Deferred" → "Python sidecar for
eval/metrics (gated on eval growth)".

---

## C3 create_ui_spec — Phase 2 hardening (post-core-slice)

**What:** Address the P2/P3 findings from the 2026-07-27 plan-eng-review + codex
outside-voice pass over the shipped C3 core slice (`e9ff3be..c0dc2e4`). The two
P1s (envelope `artifactId`/`assemblyRulesSha256` verification; typed-error
contract) were fixed in `c0dc2e4`. The items below are real but did not block
the core slice; most are explicitly Phase-2 (deferred-adapter) work.

**Why:** Each is a correctness, privacy, or forward-compat gap the reviews
caught that the internal per-task reviews missed. Captured here so Phase 2
(MCP / HTTP / Playground / live provider) picks them up with full context
rather than rediscovering them.

**Findings to address (severity, file:line):**

- **P2 — Private-marker lists drifted.** `PRIVATE_MARKERS` in
  `src/create-ui-spec-contracts.ts:~780` and the marker list in
  `scripts/c3-runtime-probe.mjs:~58` are independently authored and no longer
  agree. The probe checks `private.example.com`, `secret`,
  `"critique prose must never leak"`, `"stealable prose"` — the contract's set
  does not. A real leak of `private.example.com` would pass the envelope's
  `superRefine` but fail the probe. Fix: unify on one shared list (export from
  contracts, import in probe).

- **P2 — `publicEvidenceIds` not bound to the spec.**
  `parseDesignArtifactEnvelope` checks uniqueness of `publicEvidenceIds` only;
  it does not require equality with `spec.provenance.evidenceIds` or membership
  in `authorityLanes.corpusEvidence`/`citedDecisions[].evidenceIds`. A
  self-consistent envelope could carry an orphan evidence id. Add an
  envelope-level membership check (mirror the existing
  `validateEvidenceReferences` helper in `tool-contract-integrity.ts`).

- **P2 — Limit literals duplicated across schema + producer.** `8`, `2000`,
  `1000`, `20`, `5`, `32`, `120`, `500` appear as bare literals in both
  `create-ui-spec-contracts.ts` (schema `.max()`) and `create-ui-spec.ts`
  (producer `.slice()`/`substring()`). If a schema limit changes, the
  producer's hard-coded slices silently diverge and start emitting values the
  schema rejects (caught by `UiSpec.safeParse`, but as an opaque
  `INVALID_INPUT`). Fix: export named constants from the contracts module and
  import them in the producer.

- **P2 — Recipe shape drift is silent.** `safe-aggregator.ts:~30-53` projects
  the JSON import through a manual structural type (`recipe as unknown as
  FallbackRecipe`). If the recipe gains a field, the projection ignores it; if
  it drops a field the aggregator reads, you get `undefined` at runtime, not a
  compile error. The `fallback-recipe-v1.test.ts` pins version + SHA only.
  Fix: add a test asserting `Object.keys(recipe)` equals the `FallbackRecipe`
  surface (or a `.strict()` runtime schema for the recipe).

- **P2 — Explicit-reference privacy depends on adapter discipline.** If
  `resolveReferenceToken()` resolves a private-looking token, the producer
  copies the original token verbatim into `publicReference`,
  `citedReferences`, `provenance.sourceReferences`, `DESIGN.md`, and JSON
  (`create-ui-spec.ts:~179,200`). There is no `SafePublicReference` schema.
  Fix: add a URL/reference-format schema at the boundary (reject
  private-looking or non-public tokens at resolution time).

- **P2 — Candidate spine is incomplete for Phase 2.** `buildFallbackCandidate`
  emits only `designDirection` + 7 fixed-empty array fields + optional
  `frameworkNotes`; `mapCandidateToSpecFields` reads 9 fields but the
  deterministic path never produces `colorTokens`/`typographyTokens`/
  `motionGuidance`/`contentVoiceGuidance`/`acceptanceCriteria`/
  `rejectedDefaults` candidates. When the Phase-2 live provider emits those
  variants, the mapping code for them is unexercised. Proven-ness gap, not a
  bug today. Address as part of the live-provider plan.

- **P3 — `buildFallbackCandidate`'s `recipe` param is discarded** (`void
  recipe`). Either thread it through or drop the param.

- **P3 — `recipeSha256()` recomputed per `createUiSpec` call**; hoist to a
  module-load `const` (the recipe is a frozen import).

- **P3 — `FixedEmptyArrays.citedDecisions` / `.citedReferences` are dead**
  (`safe-aggregator.ts`); `buildFixedEmptyArrays` exists essentially to
  produce `rejectedDefaults: []`. Collapse to a one-liner.

- **P3 — Deferred-MCP descriptor mismatch.** The existing
  `create_ui_spec` descriptor in `tool-contracts.ts:~688,1089` still uses
  `serializationFormat: "brief" | "tokens"`, retrieval only `none/none`, and
  only `INVALID_INPUT`. The new core returns `DesignArtifactEnvelope`, emits
  `keyword/metadata` + `structured-fallback/metadata`, and can surface
  `RETRIEVAL_UNAVAILABLE`. This is the explicitly-deferred Phase-2 MCP
  migration — not a regression, just naming it so the MCP plan inherits it.

**Trigger (build when):** starting Phase 2 (MCP / HTTP / Playground / live
provider). The P2 privacy items (marker list, explicit-reference schema,
evidence-id binding) should land before any adapter exposes the producer to
untrusted transport input.

**Until then:** the core slice is merge-ready. The P1 integrity and
typed-error contracts are fixed; the privacy boundary for the fields the
sanitizer covers is verified airtight; all gates green (2421/2421 tests,
typecheck, build, compiled probe).

**Source:** plan-eng-review + codex outside-voice, 2026-07-27. Artifacts:
`~/.gstack/projects/<slug>/` eng-review test plan + tasks JSONL.

---

## C2 external-QA enforceability

**What:** Strengthen the C2 closure gate so the "external human QA reviewer"
requirement is machine-verifiable, not merely asserted. The validator currently
enforces distinct, non-implementation actor IDs and surfaces a
`c2-external-qa-unverifiable` non-blocking caveat on every C2 closure
(`src/readiness/validator.ts`, `docs/superpowers/specs/2026-07-19-c2-gold-readiness-design.md:11`),
but a sole operator can still create two human actor IDs and close C2.

**Why:** The design spec requires "QA approval by an external human who is
registered truthfully and is not an implementation actor." Externality is a
real governance property; the current caveat makes the gap visible but does
not close it.

**Candidate approaches:**
- Require distinct git commit authors for the Gold vs QA approval artifacts
  (weak but real signal available in the local validator).
- Require a signed attestation (e.g. GPG/Sigstore) from the QA actor that
  binds their identity to the approval.
- Bind actor IDs to distinct GitHub accounts verified via the GitHub API
  (requires network access; out of scope for the offline validator).

**Trigger (build when):** C2 closure becomes a release gate for a multi-person
team, OR when an auditor challenges the externality claim. Until then the
caveat is honest and the closure is provisional-on-trust.

**Scope when triggered:** extend `validateApprovalsAndCheckpoint` in
`src/readiness/validator.ts`; likely add an attestation artifact type to the
readiness contracts. The caveat (`c2-external-qa-unverifiable`) stays as the
fallback when the stronger check is not yet configured.

---

## Approval provenance holes the content-only validator cannot close

**What:** Three known gaps in the approval checks of
`src/readiness/validator.ts`. Each hole is back-linked from the exact comment
that describes it in the code (and each of those comments links here):

| Hole | Code back-link |
|---|---|
| 1 | the `NOTE ON TAINTING` comment above the supersession loop in `validateApprovalsAndCheckpoint` |
| 2 | the "What this does NOT detect" section of the `verifyApprovalArtifactTimestamps` docstring |
| 3 | the "SUPERSEDED approvals keep the plain skip" paragraph of the same docstring |

1. **`ledger-invalid-supersession` does not taint its approval.** The two
   structural supersession pushes make `ok` false without calling
   `noteApprovalIssue`, so the taint map does not record them.
   `ledger-supersession-not-later` (the temporal check) does taint. Pre-existing
   behaviour, deliberately left unchanged rather than widened without a decision.
   **No longer a `checkpointStatus` hole:** the closure gate reads the issue list
   as well as the taint map, so a blocking finding on a checkpoint-kind approval
   holds its checkpoint `open` whether or not the emitting check tainted. What
   remains is that a downstream consumer of the taint map itself (rather than of
   `checkpointStatus` or `ok`) still would not see these two codes.
2. **`checkpointTargetSha256` provenance is unverifiable from content.** A target
   hash carries no timestamp, and the artifacts it is computed over need not have
   existed when it was computed, so nothing in the artifact graph establishes when
   a target hash first existed. Relatedly, `createdAt` is self-declared: an
   artifact rewritten in a later commit without bumping `createdAt` still declares
   the old time, so an approval binding freshly-rewritten bytes with no
   supersession relation is caught by nothing.
3. **A SUPERSEDED approval's unresolvable binding is reported by nothing.** When
   a bound `(artifactId, sha256)` row of a superseded approval names no on-disk
   artifact version, `verifyApprovalArtifactTimestamps` skips it (there is no
   version-correct `createdAt` to compare against) and every other
   `approvedArtifacts` check sits behind `if (isSuperseded) continue;`. Active
   approvals are fully covered — `approved-artifact-hash-mismatch` /
   `approved-artifact-unknown` / `checkpoint-target-mismatch` for checkpoints
   with a recipe, `approved-artifact-version-unresolved` for those without — so
   this is a historical-record gap, not a closure gap: a superseded approval
   cannot contribute to closure. Closing it needs the historical bytes, which the
   on-disk graph does not retain.

**Live instance of (2):** `artifact-index-v3.json` (`index-c1-v3`) and
`c2-evidence-manifest-v1.json` (`c2-evidence-v1`) were rewritten in commit
`e176e85` on 2026-07-28 but still declare
`createdAt: 2026-07-26T20:15:01.000Z`. Both are published on `origin/main`, so
correcting them requires new artifact versions rather than an in-place edit.

**Why it matters:** holes 1 and 2 are the ones through which the withdrawn
`c2-*-v2` approvals passed content validation while claiming a decision made
before their target existed. Hole 3 blocks no closure; it only limits how much
of the historical record the validator can re-verify.

**Candidate approaches (holes 1–2):** commit/authoring-date evidence from git, signed
attestations binding a decision to a time, or a countersigned timestamp
authority. All require an out-of-band provenance source, which is why a
content-only validator cannot close them.

## Approval retraction vocabulary (the ledger cannot say "withdrawn")

**What:** Give the readiness governance ledger a way to record that a prior
approval is retracted — by whom, when, and why — without editing or deleting the
retracted record.

**Why:** On 2026-07-28 the repository owner decided to withdraw
`c2-gold-reviewer-gold-v2` and `c2-qa-reviewer-qa-v2` from
`checkpoint-approvals-v5.json` (their `decidedAt` predates the target they
bind). The withdrawal could not be represented:

- `validateLedgerAppendOnly` (`src/readiness/contracts.ts`) enforces append-only
  as an unchanged PREFIX, so appending a `v6` ledger that omits the two records
  emits `ledger-approval-deleted` twice. A bad record can never leave the chain.
- `decision` (`src/readiness/contracts.ts:122`) admits only
  `"approved" | "rejected"`. "Rejected" is wrong semantics — the reviewers did
  not reject the target, they never decided on it.

So the withdrawal is currently *implied by a blocking invariant*
(`ledger-supersession-not-later` blocks, C2 reports open) rather than stated. An
operator reading the ledger sees two approved records and a red gate, with no
record of the retraction decision or its reason. Note precisely what "withdrawal"
means here: **no ledger bytes were changed and no record was removed**. The two
records still read `decision: "approved"`; the block comes entirely from a
validator check (`ledger-supersession-not-later`, added in `e373351`) that
recognises their `decidedAt` as impossible. The withdrawal exists as prose in
`docs/c2/c2-checkpoint-approval-handoff.md` and as that check — not as anything
recorded in the artifact graph.

**Scope when triggered:** decide whether retraction is a new record kind in the
approvals ledger, a separate artifact type, or a field on a successor ledger, and
justify it against the prefix rule; then teach `validateApprovalsAndCheckpoint`
(`src/readiness/validator.ts`) that a retracted approval cannot contribute to
closure. A recorded retraction should become the ONLY thing that can clear a
`ledger-supersession-not-later` finding. That check is unconditional and
blocking today: an earlier revision demoted it to a warning once the defective
record had itself been superseded, and that was removed as fail-open — a
fabricated record dated one second later was enough to flip the real gate to
`ok: true` with `issues: []` and C2 closed.

**Consequence until this lands:** the readiness gate stays `ok: false` for as
long as the defective records are in the chain — real reviewer decisions on
`cf55fee0…` are necessary but NOT sufficient to make it green, and C2 cannot be
closed on a clean gate. That is the accepted tradeoff, decided by the repository
owner on 2026-07-28: a durable record that a governance defect occurred is worth
more than a remediable gate.

**How durable, exactly — the attacks that were actually run.** Two earlier
versions of this section overstated this: first "permanently", then "durable
against any change confined to `quality-contracts/`". Both were falsified by a
reproduction. What follows is only what has been attacked, each against a
throwaway `git worktree` copy of the real artifact graph, each edit confined to
`quality-contracts/`, each now reported **blocking with every checkpoint held
open**:

1. **Drop or rewrite the defective records in a successor ledger** →
   `ledger-approval-deleted` / `ledger-approval-mutated` (`validateLedgerAppendOnly`
   requires the prior approvals as an unchanged prefix); a forked ordinal emits
   `chain-duplicate-key` / `chain-fork` / `chain-multiple-heads`.
2. **Edit the two `decidedAt` fields of the head ledger in place** →
   `ledger-approval-pin-mismatch`, from the approval-row pins in
   `src/readiness/ledger-pins.ts`. Before those pins existed this produced
   `ok: true`, `C2: closed`, `All checks passed.`, exit 0.
3. **Rename the head ledger's `artifactId` and apply the same two edits** →
   `ledger-approval-pin-missing`. Before the coverage rule (`validator.ts` step
   7c) this produced `ok: true`, `C0`/`C1`/`C2` all `closed`, zero issues, exit 0
   — the pin was keyed on a field inside the artifact it was pinning and was
   simply never consulted.
4. **Append a `checkpoint-approvals-v6.json` without registering its pin** — the
   append the handoff doc's own step 1 instructs — **and rewrite its new rows in
   place** → `ledger-approval-pin-missing`. Before the coverage rule, the edited
   and unedited v6 produced byte-identical gate output.
5. **Rename the earlier ledgers too, to disguise the chain as untracked** →
   `chain-predecessor-hash-mismatch`. Their bytes, `artifactId` included, are
   pinned by their successors' `predecessor.sha256`.

**What is not covered, stated plainly:**

- The pins are a **declaration in source, not a signature**. A change that edits
  `quality-contracts/` *and* `TRACKED_LEDGER_APPROVAL_PINS` goes green. That is a
  reviewable source diff, not a mechanical impossibility.
- Coverage recognises a tracked chain only by a pin key matching one of its
  ledgers, so attack 5 is closed by the chain being five ledgers long with four
  of them byte-pinned by successors. A **single-ledger** chain could be renamed
  wholesale and coverage would not activate. This chain is not one.
- Nothing beyond the five attacks above is claimed. Do not restate this as
  durability against "any change confined to `quality-contracts/`", and do not
  describe the block as "permanent" or "unfakeable" — each of those absolutes has
  been asserted here once and falsified once.

**Do not:** fabricate an approval, timestamp, actor, or rationale to close the
gap; retraction is a real recorded act. And do not reintroduce a supersession- or
severity-based escape hatch in `validateApprovalsAndCheckpoint` to restore
remediability — the retraction record is the mechanism.
