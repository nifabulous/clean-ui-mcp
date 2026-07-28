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
