# Deterministic Body + Grounding — Design (Plan 2)

**Status:** Proposed
**Date:** 2026-08-02
**Scope:** Fill the deterministic `create_ui_spec` body from measured corpus
content and introduce auto-retrieval as the shared grounding mechanism for the
deterministic and model paths. Plan 2 of the two-plan sequence; Plan 1
(model-lane reliability) is specified in
`2026-08-02-model-lane-reliability-design.md`.

## Context

A probe of the default (no-model) path showed the largest promise/delivery gap
in the product: `create_ui_spec` returns a 4KB scaffold whose design surface is
entirely unpopulated — `## Direction` echoes the brief verbatim, every color
token is `unavailable`, rejected defaults and sources are empty, and the
evidence rows feeding both the served spec and (today) the model prompt are
recipe stubs.

Measured corpus coverage (2026-08-02, `corpus/entries.json`, 787 entries):

| Field | Coverage |
|---|---|
| `whatToSteal` / `antiPatterns` / `critique` | 787 / 787 |
| `visual.*` (dominantColors, accentColor, typePairing, spacingDensity, cornerStyle, usesShadows, usesBorders) | 787 |
| `visual.colorRoles` | 688 |
| `layout` | 704 |
| `voice` | 600 |
| `mood` | 22 |
| top-level `colorScheme` | 22 |
| `patternType` | 21 distinct values, heavily skewed (dashboard 210 … calculator 1) |

The deterministic body can only honestly draw on what this table shows: rich
visual/layout/voice coverage, thin mood/colorScheme coverage, and a long-tail
pattern gap.

## Scope

**In:**
- Field-coverage audit locked in as a committed artifact (Task 0).
- Auto-retrieval: when the caller passes no `referenceIds`, retrieve the top
  N=3 corpus entries by brief similarity and use their real content as
  response-scoped evidence, for the deterministic body AND the model prompt
  (closing the Plan 1 grounding gap for reference-less requests).
- Deterministic synthesis: populate `designDirection`, `rejectedDefaults`,
  `colorTokens`, `typographyTokens`, `layoutRegions`, and related spec fields
  from matched entries, with honest unavailability where coverage does not
  exist. (`rejectedDefaults` is excluded by the served-content posture —
  see below — and stays `unavailable`.)

**Out:** model-lane fixes (Plan 1), provenance governance, coarse
`design_solution` tool, learning loop.

## Design

### Task 0 — Field-coverage audit

Before any synthesis, an audit snapshot is committed. A small script
(`scripts/audit-corpus-coverage.mjs`, modeled on `corpus-stats`) emits the
coverage table above from `corpus/entries.json` and fails if any field used by
the deterministic synthesizer has coverage below its declared floor:
`visual.colorRoles` ≥ 600, `layout` ≥ 600. (`voice` stays in the coverage
table for awareness but is not a synthesis floor — the served-content posture
excludes written-analysis fields.) The audit is checked into the repo (e.g.
`docs/superpowers/specs/coverage-2026-08-02.md`) and re-run on demand. It
defines what "filled" can honestly mean.

### Auto-retrieval (shared grounding)

**Where:** `src/create-ui-spec.ts` evidence resolution. Today, a request with
no `referenceIds` resolves to the recipe-only evidence set. Change:

- When `referenceIds` is empty, run brief-similarity retrieval over the corpus:
  keyword search first (existing `CorpusReader.searchRanked`), falling back to
  embeddings (`findSimilar`) when available, capped at top N=3 entries.
- Each matched entry becomes a `corpus-observation` evidence row whose summary
  is a DERIVED STRUCTURED description built by one shared summary builder
  (`src/create-ui-spec-deterministic.ts`): patternType, region count,
  spacingDensity, cornerStyle, usesShadows/usesBorders flags, dominant/accent
  colors, and typePairing. Never verbatim `critique`/`whatToSteal` prose, and
  never a stub.
- No match at all → zero evidence rows; both the deterministic body and the
  model prompt then omit evidence rather than fabricate it (the Plan 1
  grounding rule becomes the general rule).

This makes the deterministic body and the model lane share one grounding path.

### Served-content posture (C3 resolution — product decision, 2026-08-02)

The registered `create_ui_spec` tool description promises "No corpus content,
path, url or product identity is ever returned — corpus grounding appears only
as opaque evidence ids." Serving real `critique`/`whatToSteal` prose as
`evidence[].summary` would break that promise with auto-tagger output that has
zero human provenance (measured: 787 auto/auto-reviewed, 0 human). Resolved:

1. **Served summaries are derived structured facts only** — synthesized by the
   one summary builder above, which is the same builder that feeds the model
   prompt. Served bytes and prompt content stay consistent; there is no
   divergence to explain.
2. **`antiPatterns` prose is not served and not sent to the model.**
   `rejectedDefaults` therefore stays `unavailable` with a reason in
   `unavailableDecisions` (see Deterministic synthesis).
3. **`voice`/`mood` are not served.** Both are written-analysis fields with
   thinner coverage; they stay `unavailable` until the governance flip below.
4. **Upgrade path:** when provenance governance lands (human-signed entries),
   revisit option 1 as a deliberate contract change — update the tool
   description, then serve signed prose. Until then, prose is never on the
   wire. This is a gated decision, not an omission.

The tool description is preserved unchanged; derived structured summaries are
synthesized content, not corpus content.

### Deterministic synthesis

New module `src/create-ui-spec-deterministic.ts` (pure, deterministic,
fixture-testable) that consumes the resolved evidence and the request, and
produces the non-model spec body. Rules:

- **`designDirection`:** synthesized from the top matched entry's
  `visual`/`layout` STRUCTURED fields (colors, density, corner style, shadow/
  border flags, spacing, type pairing) plus the request context, written in
  the recipe's own voice (operator content, `recipe-system` authority), citing
  the evidence ids it draws from. No `critique`/`whatToSteal`/`voice` prose is
  quoted or paraphrased into it. If no entry matched the brief class, the
  section states that explicitly ("no corpus match for this brief class")
  instead of generating direction.
- **`rejectedDefaults`:** the recurring `antiPatterns` from matched entries,
  capped at 3, each cited to its evidence id — NOT in this plan. `antiPatterns`
  is prose and is excluded by the served-content posture above. `rejectedDefaults`
  stays `unavailable` with a reason in `unavailableDecisions` until the
  governance flip permits serving signed prose.
- **`colorTokens`:** plurality merge of `visual.colorRoles` across matched
  entries (the existing `design-prompt.ts` merge logic is extracted and
  reused). Populated only when ≥ 3 matched entries contribute; otherwise the
  token remains `unavailable` with an explicit reason in
  `unavailableDecisions`.
- **`typographyTokens`:** same plurality rule over `visual.typePairing`.
- **`layoutRegions` / `responsiveBehavior`:** from the matched entries'
  `layout` field when present.
- **`voice` / `mood`:** stay `unavailable` with reasons — both are
  written-analysis fields excluded by the served-content posture (mood also
  has only 22-entry coverage).
- **Authority:** everything above is `recipe-system`/`editorial` authority.
  `spec.modelProposal` stays absent on this path — the deterministic body is
  not model output. (Plan 1 cut its proposed `proposalOnly` flag as redundant
  with `data.modelProposal`, which is already on the wire; assert against
  `modelProposal` directly.) Accepted-token positions remain null; no
  authority promotion.

### Contracts

- UiSpec fields already exist; the deterministic synthesizer populates them.
- `EvidenceKindSchema` already has `recipe-system`; auto-retrieved rows are
  `corpus-observation` (existing kind). No new evidence kinds.
- **The `data.designDirection` leaf annotation must change with it.**
  `CREATE_UI_SPEC_FREE_TEXT_LEAVES` is the product's own machine-readable claim
  about who authored each served string, and today it reads "under the
  deterministic recipe this restates the caller's own brief"
  (`src/tool-contracts.ts:1155`). Synthesis gives that position a SECOND
  author, so the annotation must name both sources (brief echo when nothing
  matched; recipe-voice sentence over closed `structuredFacts` pluralities
  citing evidence ids when something did), and must still deny corpus prose and
  model authorship. No existing test catches this — the guards at
  `src/create-ui-spec-intent-guards.test.ts:290-325` cover the intent and
  acceptance-criteria positions only — so the change ships green while the
  claim is false unless a guard is added alongside it. Add one.
- **No new warning code.** An earlier revision added `noCorpusMatch`; it is
  cut for two reasons. (1) It is redundant: `buildWarnings` already pushes
  `sparseCoverage` on the `structured-fallback` branch
  (`src/create-ui-spec.ts:1159-1164`) with the message "automatic retrieval
  returned zero matches; the deterministic fallback recipe was used" — exactly
  the zero-match condition. (2) Adding one is a two-schema change with no
  drift gate: codes live in BOTH `WarningSchema`
  (`src/create-ui-spec-contracts.ts:560`, the closed enum the producer's
  `parseDesignArtifactEnvelope` validates at `:639`) and the descriptor's
  `makeWarningSchema` (`src/tool-contracts.ts:1857`), and
  `tool-contracts.test.ts:40` only asserts the descriptor field is defined.
  A one-sided addition fails at runtime in the producer, before the descriptor
  gate is reached.
- The registered `create_ui_spec` tool description is unchanged (see
  Served-content posture).
- The corpus-freeze invariant is preserved: nothing writes to
  `corpus/entries.json`; auto-retrieval only reads.

## Data flow

```
create_ui_spec (no model)
  → resolveEvidence
      referenceIds non-empty → resolved references (unchanged)
      referenceIds empty → brief-similarity top-3 (keyword → embeddings)
      zero matches → no evidence rows, existing sparseCoverage warning
  → createUiSpecDeterministic(evidence, request)
      → designDirection / colorTokens / typographyTokens / layoutRegions
      → unavailableDecisions for fields without coverage
        (rejectedDefaults, voice, mood — excluded by the served-content posture)
  → envelope (recipe authority, no modelProposal)
```

**The prompt changes exactly once per shipped release, in Plan 2's collapsed
Task 4C.** Plan 2 puts `evidenceSummaries` behind a non-empty guard over real
derived summaries (recipe rows excluded; key omitted when nothing real exists)
and applies the conciseness instruction, under ONE `POLICY_VERSION` bump.

Which bump depends on how the two plans ship:

- **Route A — both together (recommended).** Plan 1 Tasks 4 and 5 are SKIPPED,
  so the key was never removed and the prompt is still at v4. Task 4C adds the
  guard plus the conciseness instruction and bumps **v4 → v5**. Removing the
  key in Plan 1 and restoring it in Plan 2 within one release is pure churn:
  two bumps and two test rewrites for a net prompt that has the key with
  better content than today.
- **Route B — Plan 1 ships to production alone first.** Its Task 4 removal is
  then the honest interim state, and Task 4C restores the parameter, adds the
  guard, and bumps **v5 → v6**.

Either way `POLICY_VERSION` moves once per release, and Task 4C is the only
task in either plan that touches `buildPrompt`.

## Error handling

- Retrieval failure (reader throws) → zero evidence rows + the existing
  `sparseCoverage` warning; the deterministic body degrades to explicit
  unavailability, never fabricated content.
- Coverage below floor for a field → that field is `unavailable` with a reason
  in `unavailableDecisions`; the audit script enforces the global floor.
- No corpus mutation possible: all reads, no writes.

## Testing

- **Audit:** `scripts/audit-corpus-coverage.mjs` passes on the current corpus
  and fails when a field drops below its floor (fixture corpus).
- **Auto-retrieval:** no references + fixture corpus → top-3 evidence rows with
  derived structured summaries; zero-match brief → zero rows +
  `sparseCoverage`; references non-empty → unchanged path. Assert that no
  verbatim `critique`/`whatToSteal`/`voice` prose appears in any served summary
  or in the model prompt (fixture strings are planted in the corpus to prove
  exclusion).
- **Synthesis:** fixture corpus → deterministic `designDirection`,
  token plurality, layout regions, and explicit unavailability (including
  `rejectedDefaults`, `voice`, and `mood`); assertions that authority stays
  `recipe-system`, `spec.modelProposal` absent, accepted tokens null.
- **Freeze:** corpus bytes unchanged before/after every test (existing pattern
  in `create-ui-spec-model-path.test.ts`).
- **Regression:** full `vitest` suite. Plan 1's grounding test asserts the
  `evidenceSummaries` key is absent UNCONDITIONALLY; Plan 2 must REWRITE it,
  not extend it — the new assertions are "present with real summaries when
  retrieval matched" and "absent when it did not". Leaving the Plan 1
  assertion in place would fail the moment Plan 2 lands, which is the intended
  signal that the two plans are coupled here.

## Success criteria

For the three session briefs (login, finance analytics, habit tracker) with no
model configured and no references: `create_ui_spec` returns a populated
`designDirection` with cited evidence for brief classes the corpus covers,
populated tokens where ≥ 3 matched entries contribute, and explicit honest
unavailability elsewhere (including `rejectedDefaults`, `voice`, `mood`). No
stub strings and no verbatim corpus prose appear in the served spec, evidence,
or (via Plan 1) the model prompt.

## Non-goals

- Model-lane changes (Plan 1).
- Provenance governance, coarse `design_solution` tool, learning loop.
