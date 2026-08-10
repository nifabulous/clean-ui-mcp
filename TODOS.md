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

---

## Wiring-verification allowlist: redundant `validateReferenceRegistry` entry

**What:** `"validateReferenceRegistry"` in the `ALLOWLIST` of
`src/wiring-verification.test.ts` is not load-bearing. `isReferencedInProduction`
in that file deliberately includes the defining file and treats `>= 2`
word-boundary matches there as wired; `src/references/loader.ts` has exactly two
(the `export function validateReferenceRegistry` declaration, and the call inside
its `import.meta.url === pathToFileURL(process.argv[1]).href` CLI main block).
The scan therefore already returns `true` for this symbol and it would pass the
check with the allowlist entry removed.

**Why it is still there:** removing an allowlist entry changes what the test
asserts, which is out of scope for a doc/comment-only branch. The entry's comment
was corrected in place instead — it previously claimed the scan "does not count"
the in-file CLI call, which was false and which also contradicted the
`createUiSpec` entry in the same file, whose retained rationale depends on
in-file/doc-comment mentions satisfying the same scan.

**Scope when triggered:** drop the entry, confirm the suite stays green (the
symbol must still be found by the defining-file rule), and keep a short comment
at the removal site recording why no allowlist entry is needed — otherwise the
next author re-adds it. If the CLI main block in `loader.ts` is ever deleted, the
symbol drops to one match and genuinely does need an entry again.

---

## Query-based embedding search on CorpusReader

**What:** Add a query-first embedding/vector search method to `CorpusReader`
(e.g. `searchEmbedded(query, limit)`), so brief-similarity retrieval no longer
needs the seed-then-`findSimilar(id)` hack the Plan 2 auto-retrieval fallback
uses.

**Why:** `findSimilar` is id-based only (`src/corpus-reader.ts:71`), so the
2026-08-02 deterministic-grounding plan's "fall back to embeddings when
keyword returns zero" path seeds from the same keyword engine that just
returned nothing — a weak recovery. A real query embedding gives the long-tail
briefs a second, independent retrieval axis.

**Trigger:** when Plan 2 (deterministic body + grounding) lands and the
embeddings fallback proves too weak in the live campaign, or when a
`VOYAGE_API_KEY`-backed embedding index is already present at runtime.

**Depends on:** the embeddings index (`corpus/embeddings.json`) being loadable
through the reader in both private and public modes.

---

## Corpus schema: mono role for typography

**What:** Add a `mono` role to `TypePairing` (or a sibling field) in
`src/schema.ts` so `UiSpec.typographyTokens` can be populated by the
deterministic synthesizer.

**Why:** Plan 2 keeps `typographyTokens` null because the corpus records only
display/body pairing and UiSpec requires a `mono` member; deriving one would be
invention. With a mono role captured at tagging time, the plurality logic
already built in `create-ui-spec-deterministic.ts` lights up immediately.

**Trigger:** a tagging-pipeline change that can populate the mono role from
real screenshots, or a corpus backfill.

**Depends on:** the two-pass tagger accepting a third type-pairing field and
re-tagging (or backfilling) entries.

---

## Corpus trust gate: Stage 2 — the verifier that lets entries pass it

**What:** Build the verifier that writes `provenance.verification`. Stage 1
(shipped, `docs/superpowers/plans/2026-08-04-corpus-trust-gate.md`) added the
fail-closed gate: `isVerified` in `src/corpus-trust.ts` reads that record,
`createUiSpecDeterministic` shadows its `matchedEntries` parameter with the
trusted subset, and `TrustGatedCorpusReader` (`src/corpus-trust-reader.ts`) wraps
the reader every OTHER corpus-reading tool sees. **Zero of 787 entries carry the
record**, so the whole server serves nothing corpus-derived today.

Stage 2a (shipped, `docs/superpowers/plans/2026-08-05-per-field-verification.md`)
corrected Stage 1's entry-level record before any entry carried one:
`provenance.verification` is now a per-field map, `isVerified(entry, field)`
requires the field, the deterministic body selects per field
(`verifiedFor(field)`), the evidence projection strips each row to its verified
facts, and `TrustGatedCorpusReader` gates on a per-tool field set declared at
wiring time in `createServer`. The corpus browser stays dark (zero records), and
the "0 of 787" messages name the field set the tool serves.

**The corpus browser is dark until this ships.** `search_ui_examples`,
`get_ui_example`, `browse_ui_examples`, `get_stealable_techniques`,
`get_anti_patterns`, `get_color_palette`, `get_similar_ui_examples`,
`compare_ui_examples`, `recommend_ui_direction` and `critique_ui` all return an
honest "0 of 787 carry a recorded verification" message; `create_ui_spec` ships
reason rows plus the `insufficientCorpusEvidence` warning. This was a deliberate
scope choice (the strictest reading of the invariant), not an accident — the first
verified entries light the surface back up one at a time.

Stage 2's own tooling is unaffected: the tagger, `doctor.ts` and every script read
`corpus/entries.json` directly, never through the MCP tools.

Stage 2 makes entries eligible by re-tagging against evidence that can be
checked, per the three tiers in
`docs/superpowers/specs/2026-08-04-corpus-trust-gate-design.md`:
`measured` (read off the page), `provable` (derivable from recorded data), and
`image-confirmed` (a verifier that ACTUALLY SAW the image agreed, bound to the
bytes via `imageSha256`).

**Why:** This replaces the human-signature framing this TODO used to carry. The
corpus is ~700 entries and growing, and agents — not a curator — have to be able
to clear it, so the bar is checkable evidence, not a signature. The audit that
motivated the gate found 733 of 787 entries defective, with critiques that were
wholly fabricated; root cause is `src/tagger.ts:3026`, where Pass 2 (critique)
runs with `null` for the image and is told to "treat every value below as fact",
so it elaborates confidently on whatever Pass 1 produced. Fixing the blind pass
is Stage 2's first job — re-tagging with the same blind critique step would just
mint verified fabrications.

**Do NOT:** grant `verification` from `doctor.ts`'s defect scan. Mechanical
cleanliness is necessary and not sufficient — the worst entry in the audit trips
zero of the eight detectors.

**Depends on:** Stage 1 (shipped). Stage 2 owns `src/tagger.ts`, which had
uncommitted third-party edits in the working tree as of 2026-08-04 — reconcile
those before editing it.

---

## Frozen labelled ground-truth set (verdict labels)

**What:** Build and freeze a hand-labelled verdict set: one JSONL record per
labelled claim (`entryId`, `imageSha256`, `field`, `claim`, `label`, `notes`,
`labelledAt`, `labelledBy`; `label` ∈ `confirmed | contradicted | abstain`).
The set is frozen — corrections append a `supersedes` record, never edit in
place. Fixture format and labelling contract are defined in
`docs/superpowers/specs/2026-08-07-deterministic-detectors-design.md`
("Frozen labelled ground-truth set"); this TODO owns the labelling run and the
comparison harness.

**Why:** The deterministic-detectors spec's benchmark (5/28 flips, ~62% model
ceiling, 11/28 unsupported) and the fields that remain model-verified
(`layout`, `components`, `visual.typePairing`, prose, soft) are both
unmeasurable without labels. Detector calibration and the frozen set share the
same labelling infrastructure, so the format is defined now rather than
invented twice.

**Trigger (build when):** the deterministic-detectors plan has landed — the 28
disputed claims plus a ~10-per-field stratified sample are the initial scope,
so detector and model lanes compare against the same ground truth. NOTE: the
raw 28-claim rows (`eval/verdicts/disputes.tsv`) were LOST before commit — the
plan's Task 1 rescue never landed and `/tmp/disputes.tsv` is gone (see
`eval/verdicts/README.md`). The 28-claim comparison must be re-run and
committed under that name as part of this TODO's scope; the 82
real-screenshot labels at `eval/verdicts/labels.jsonl` (the spec's labelling
contract) survive and are the calibration input artifact the detectors'
declared `accuracyFloor`s depend on.

**Scope when triggered:** labelling run + `eval/verdicts/` fixture commit +
promptfoo/OpenRouter comparison harness for the remaining subjective fields.
The harness is the "separate spec" referenced in the deterministic-detectors
spec's Out of scope.

**Depends on / blocked by:** the deterministic-detectors plan
(`docs/superpowers/plans/2026-08-07-deterministic-detectors.md` when written);
real-screenshot detector calibration uses the same label-format tooling.

---

## Capture-time measurement lane (producer-side detectors)

**What:** Reuse the deterministic detectors in the capture pipeline so values
the verifier currently infers are recorded at capture time with checkable
evidence, in the `measured` trust tier the schema reserves and no path writes
today (`VERIFICATION_METHODS` in `corpus-trust.ts` already includes it):
`visual.usesShadows`, `visual.usesBorders`, `visual.accentColor`, plus
DOM-derived `layout` / `components` from capture `domSignals`.

**Why:** Today the tagger guesses these fields and the verifier re-measures
them later ("verify-time inference"). Measuring at capture flips the economics
to "measure once, verify cheaply forever", and it covers `layout` and
`components`, which no pixel detector can fully check but a DOM snapshot can.

**Trigger (build when):** the deterministic-detectors plan lands — its detector
implementations and provenance shapes are the same ones the capture lane
reuses.

**Scope when triggered:** capture-side module reusing `src/verify/detectors/*`
plus `domSignals` extraction wired into `src/scripts/capture.ts`; `measured`
record shape; migration/backfill decision for existing entries. The
producer/verifier independence boundary is the first decision in this work:
whether a producer-written `measured` record satisfies the independence
invariant on its own, or only feeds the verifier's provable checks.

**Depends on / blocked by:** the deterministic-detectors plan; the capture
pipeline currently collects no `domSignals` (verified 2026-08-07).

---

## Prompt-change eval gate for the model lane

**What:** A small eval harness that runs the live brief set (login, finance,
habit, "Make it better.", checkout, empty-state) against the configured lane
and fails when median `designDirection` length exceeds the 1000 target, max
exceeds 1400, or the first-try accept rate drops below the measured baseline.

**Why:** Task 4C changed the model prompt and the only quality measurement is
the manual live campaign (2026-08-02/03: median 1107 vs target 1000, max 1233
vs 1400, first-try accept 3/6 with retry recovery verified). Prompt edits are
the highest-leverage, least-guarded change class; a future prompt change could
ship with no regression signal.

**Trigger:** the next prompt edit, or when the `check:model-lane` script is
extended with a length/accept assertion mode.

**Depends on:** the lane staying configured with the real provider; the campaign
numbers recorded in `.superpowers/sdd/progress.md`.

---

## Coarse `design_solution` tool (single-call synthesis entry point)

**What:** Ship one MCP tool, `design_solution(productContext, ...)`, that runs
retrieval → compare → aggregate → spec internally and returns the spec with a
cited "sources" block. Keep the fine-grained tools (retrieval, compare,
aggregate, critique) for power users; the coarse tool becomes the default
entry point and the `clean-ui-design` design/derived layer routes to it unless
an agent opts into the lower level.

**Why:** The current 16-tool surface forces every agent to orchestrate
retrieval (8) → aggregation (3) → synthesis (2) → critique correctly, and each
tool boundary is a place the design dies. One coarse entry removes the
route-dependence failure mode for the common case.

**Trigger (build when):** Plan 2 (deterministic-body grounding) lands — the
coarse tool's synthesis reuses its retrieval (top-3 auto-retrieval) and
deterministic synthesizer directly. Building it before Plan 2 would mean two
ad-hoc retrieval paths.

**Scope when triggered:** one new tool descriptor in `tool-contracts.ts` +
server wiring; orchestrates the existing `resolveAutomaticRetrieval` /
`sanitizeCorpusObservation` / deterministic synthesis pipeline and adds the
cited sources block. Fine-grained tools unchanged.

**Depends on / blocked by:** Plan 2 (`docs/superpowers/plans/2026-08-02-deterministic-body-grounding.md`).

---

## Learning loop / outcome store (design → result → corpus growth)

**What:** A write path so the corpus "learns taste": when an agent builds from
a spec, the outcome (design worked for this kind of user / palette did not) is
recorded and later surfaced to the same synthesis path. Because
`corpus/entries.json` is byte-frozen by design (freeze tests), the write path
must be a separate outcome store (mirroring the model-artifact store) or the
freeze invariant changes — that fork is the first decision in this work.

**Why:** The product's edge is "a taste library," and today it cannot grow in
taste: nothing learns from what worked. `critique_ui` exists but its output
does not flow back into entries.

**Trigger (build when):** Plan 2 ships and at least one team is building
specs end-to-end (so there are real outcomes to record).

**Scope when triggered:** outcome-store schema + record path from
`critique_ui`/completion flows; a derived-summary feed that folds measured
outcomes into retrieval ranking or synthesis; corpus freeze invariant either
preserved (separate store) or amended (documented).

**Depends on / blocked by:** Plan 2 (retrieval + deterministic body are the
consumers that make recorded outcomes useful).

---

## Model-lane calibration harness (repeatable 10-brief probe)

**What:** Formalize the manual 10-brief live probe (2026-08-02 session and
Plan 1 Task 5) into a repeatable script: fixed brief set, configurable
provider, outputs median/max `designDirection` length, accept rate, retry
recovery rate, and per-brief latency; records results for the PR description
without manual transcription.

**Why:** Plan 1's success criteria are measured against a live campaign that
is currently manual and only re-run when someone remembers. A script makes the
86% → ~98% retry claim and the ≤1,000-char median verifiable on every
release, not just this one.

**Trigger (build when):** Plan 1 lands — the probe then covers the retry path
(`CREATE_UI_SPEC_MODEL_MAX_ATTEMPTS=2`) and the v5 prompt in one command.

**Scope when triggered:** `scripts/probe-model-lane.mjs` driving the stdio
harness over the 10 briefs; JSON output + markdown summary; wired into the
plan's verification step as an optional `--live` flag (never CI default — it
spends tokens).

**Depends on / blocked by:** Plan 1 (`docs/superpowers/plans/2026-08-02-model-lane-reliability.md`).

## C3 Phase 1: public-mode denied-name manifest

**What:** At public-snapshot export time, ship the full corpus's distinctive
product-name list (all distinct `source.productName` values minus the six
dictionary-word exclusions, as `buildDeniedNames` computes them) as a manifest
the `PublicCorpusReader` serves, so the identity screen in public mode screens
against private-corpus product names too.

**Why:** `entriesForAggregation()` in public mode returns only the eligible
snapshot, so the denied-name set is built from eligible names only. If an
eligible entry's prose names a *private*-corpus product (one absent from the
snapshot), the screen would not catch it. Bounded today — the public contract
test pins private markers and ids, but not private product names in prose.
The public mode cannot see private data by design, so the list must ride the
snapshot rather than be derived at read time.

**Trigger (build when):** Public-mode `create_ui_spec` serves prose (it
already does after Phase 1) and the snapshot exporter next changes, or a
private product name is observed in eligible prose.

**Scope when triggered:** Extend the public snapshot manifest
(`src/publication/manifest.ts`) with the denied-name list; `PublicCorpusReader`
exposes it; `createUiSpecForAdapter` uses it for the denied set in public mode;
extend `public-mcp-contract.test.ts` with a private-product-name-in-eligible-
prose case.

**Depends on / blocked by:** None. Follow-up to
`2026-08-03-c3-serve-corpus-prose-phase1.md` Tasks 3/7.

## C3 Phase 1: screen the sanitized evidence-summary channel

**What:** Extend the identity screen to the `evidence[].summary` rows produced
by `sanitizeCorpusObservation`. The summary is recipe-template prose that
interpolates `structuredFacts`, including `typePairing` font names — the
"Alan" product's font is "Alan Sans", so its served summary contains the
product name (PR review finding #4). The summary channel predates the C3
screen and typePairing is an intended served signal, but the served bytes
still carry the name.

**Why:** The C3 prose screen covers the six UiSpec fields and the direction;
the sanitized summary is a separate served surface that can carry product
names via font names, and the full-corpus leak sweep excludes it for exactly
this reason. Closing it makes the "no product name in served prose" claim
hold on every served surface.

**Trigger (build when):** The evidence summary is next touched, or a served
summary's font name is observed to carry a product name beyond "Alan Sans".

**Scope when triggered:** Screen the composed summary per entry against the
corpus-wide denied set (own-entry + global names); drop whole, never redact.
Extend `src/full-corpus-leak-sweep.test.ts` to include the summary channel and
remove the scope note that excludes it.

**Depends on / blocked by:** None. Follow-up to
`2026-08-03-c3-serve-corpus-prose-phase1.md` Tasks 3/7.

---

## Corpus backfill: the 298 gated fields

**What:** Re-run the tagger to populate the five fields that are recorded on
almost no entries, so the verifier has something to verify.

**Why:** The 2026-08-08 diagnosis measured 298 `gate — no recorded value to
verify` verdicts, 28% of all verdicts in the 50-entry cohort. They concentrate in
five fields whose corpus coverage is ~3%:

| field | recorded / 787 |
|---|---|
| domainTags | 14 |
| mood | 22 |
| colorScheme | 22 |
| components | 23 |
| typePairing | 0 usable (`display`/`body` null on all 787) |

This is the single largest number on the verification board — larger than the 244
model-lane abstains and far larger than the 85 abstains element detection could
ever have reached. Verifying a field the corpus does not have is free and
worthless.

**Why deferred:** It is tagger work, not verifier work. Nothing in the abstain
diagnosis or the element-box probe touches it, and folding it into either would
have made both results uninterpretable — the same reason the diagnosis spec put
it out of scope. It deserves its own cycle with its own before/after measurement.

**Trigger:** Next verification cycle after the follow-up plan's workstreams land.
Nothing blocks it; it is sequenced, not gated.

**Model choice settled 2026-08-09** — `docs/backfill-model-pilot.md`. A 3-arm,
25-image pilot (`src/scripts/backfill-pilot.ts`, no corpus writes) ranked
`gemini-3.5-flash-lite` first: 25/25 completion, 3.4× faster than
`claude-haiku-4-5`, and 71% vs 50% correct on hand-adjudicated disputed tags.
Two things the pilot changed about the plan above:

- **`colorScheme` comes out of the backfill entirely.** All 787 images measured
  for luminance (`eval/backfill-pilot/measure-luminance.mjs`): median 253, only
  35 of 787 below threshold — the corpus is **95.6% light**, and
  both models returned identical values on 25/25. It should be a deterministic
  pixel computation — filling it closes the cohort's **41** `colorScheme` gates
  and computing it at verify time makes the field `provable`. Zero API calls.
- **`mood` cannot be filled by the same call.** It is a Pass 2 prose field;
  `extractionOnly` never emits it. It needs a second call per image and is the
  one target field with no controlled vocabulary to score against.

**Blocker on the configured provider:** `AUTO_TAG_PROVIDER_EXTRACTION=minimax`
failed 13 of 25 calls (`fetch failed`) in the pilot. Do not launch a 787-image
run on the current default without changing it or accepting resume passes.

---

## Deterministic color-scheme audit promotion handoff

**What:** Connect the image-hash-bound color-scheme audit report to the reviewed
retag-promotion workflow without allowing detector output to write the corpus
directly.

**Why:** The audit produces image-hash-bound deterministic proposals, conflicts,
and abstentions, but it is not ground truth until colorScheme gold labels clear
the calibration gate. `retag-promote` currently consumes shadow candidates plus
explicit decisions and gold scores. Without a handoff, operators must
manually translate a 787-entry report before any reviewed promotion.

**Trigger (build when):** The deterministic audit has passed the gold/calibration
gate and the next color-scheme cohort is ready for reviewed promotion.

**Scope when triggered:** Add a decision/import shape that requires the audit's
corpus hash, entry image SHA-256, detector provenance, and an explicit reviewer
decision. Preserve `conflict`, `abstain`, missing-image, and error rows as
non-promotable; emit a draft promotion artifact for the existing review path.

**Depends on / blocked by:** The runtime audit report schema and provenance in
PR #107, plus a private calibration report from `color-scheme-calibrate
evaluate` whose `promotionEligible` field is `true`. Read that field, not
`status`: `status` reflects whatever thresholds the caller configured, while
`promotionEligible` is derived against the fixed promotion floor (12 scored
labels at accuracy 1), so a deliberately lax run cannot be mistaken for a
promotion-grade one. The calibration packet is human-filled and image-hash
bound; even `promotionEligible: true` is necessary but not sufficient for
promotion. Never promote directly from detector output.

**Current status: blocked on the detector, not on the harness.** The first
calibration run (2026-08-10, reviewer `Gold`, packet `1110270c94eb4f68...`)
returned `status: fail`, `accuracy: 0.75`, `promotionEligible: false`, and all
three disagreements were detector errors on review, not reviewer errors.
`color-scheme-v1` reads a whole-frame median luma, so a light-mode screen behind
a dark photographic modal classifies as `dark` (median luma 0.00 and 1.21), and
white-on-saturated-blue classifies as `dark` (91.35). Both were outside the
abstention band, so the detector was confident and wrong. A replacement estimator
has to sample UI chrome rather than the whole frame and carry a chroma term. See
`docs/RETAG_PROGRAM.md` for the full result, including why that packet also
proves nothing about dark detection (every gold label was `light`).

---

## Consensus ask for the model lane (Rule 2 branch 2, second half)

**What:** A second independent ask for fields the model declines to confirm,
resolving agreement/disagreement rather than accepting a single abstain.

**Why:** The diagnosis's Rule 2 identified two levers for model-lane headroom:
the prompt contract (being fixed in follow-up Workstream B1) and consensus. Only
the first is in scope there.

**Why deferred:** Its cost/benefit is not yet priceable. Workstream B2 re-measures
the cohort after the prompt fix; the size of that delta determines whether
consensus is worth ~2× the per-field call cost. Deciding before the number exists
would be guessing, and the diagnosis exists precisely to stop that.

**Trigger:** B2 reports. If the prompt fix closes most of the 50 `verdict-missing`
first causes, consensus is likely not worth it. If it closes few, the residue is
genuine model uncertainty and consensus becomes the live option.

**Evidence arrived from an unplanned direction, 2026-08-09.** The backfill pilot
was not designed to price consensus, but it measured the thing consensus depends
on. Two independent models on the same 25 screenshots agree on only **57%** of
proposed component tags (median per-image Jaccard 0.56); hand adjudication of the
disputed set put each model at 50–71% correct on the tags the other did not
propose. So the intersection of two models is a materially higher-confidence set
than either alone — 4.0 tags/image both models back, versus 5.0–5.9 with a
~30–50% wrong tail.

This is measured on the **backfill (write) path**, not the verify path, and the
two are not interchangeable — but it removes the "not priceable" reason for the
deferral on at least one side. Consensus for corpus writes is now a live
cost/confidence trade: 2× calls and Haiku's latency, in exchange for parking the
43% disagreement set for review instead of serving it. That trade is a human's
to make. Details in `docs/backfill-model-pilot.md`.

---

## Labelled container boxes on the corpus (recall check + any web-trained detector)

**What:** Human-labelled bounding boxes for UI containers (cards, panels,
surfaces) on corpus screenshots — starting with the 46 already carrying
element-field labels.

**Why:** It is the one artifact that unblocks two separate things at once.

1. **The probe's missing recall check.** `docs/element-box-probe.md` records that
   all four rubric checks are precision-flavoured: they ask whether the boxes a
   proposer returned are geometrically clean, never whether the containers were
   found. A proposer returning nothing but word-boxes can score well — rung 1
   scored 23.9% with 96% of its boxes being text. The rubric can rule out; it
   cannot rule in, *even when the numbers look good*. Fixing that needs ground
   truth, not a fifth precision check.
2. **Fine-tuning a detector for web.** Rung 3c (deki-yolo) has the right class
   (`View` containers) but is trained on 486 MOBILE screenshots, and 67.5% of its
   `View` boxes on web screenshots are text. Adapting it needs web-labelled
   container boxes — the same artifact.

**Why deferred:** It is a real labelling investment and should be a deliberate
bet, not a side effect of closing a probe. The element-detection line is closed
under its pre-registered rule, and the cheaper unexplored option (the deki-recall
+ 3a-precision box-refinement hybrid, `docs/element-box-probe.md`) needs **no
labels at all**. Spending the labelling budget before trying the free thing is
the wrong order.

**Trigger:** Either the box-refinement hybrid is tried and shows the geometry can
work (making labels worth buying), or element detection is reopened for a reason
independent of this probe. Not before.
