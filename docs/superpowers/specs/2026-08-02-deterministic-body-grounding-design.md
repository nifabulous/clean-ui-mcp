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
  exist.

**Out:** model-lane fixes (Plan 1), provenance governance, coarse
`design_solution` tool, learning loop.

## Design

### Task 0 — Field-coverage audit

Before any synthesis, an audit snapshot is committed. A small script
(`scripts/audit-corpus-coverage.mjs`, modeled on `corpus-stats`) emits the
coverage table above from `corpus/entries.json` and fails if any field used by
the deterministic synthesizer has coverage below its declared floor:
`visual.colorRoles` ≥ 600, `layout` ≥ 600, `voice` ≥ 500. The audit is checked
into the repo (e.g. `docs/superpowers/specs/coverage-2026-08-02.md`) and
re-run on demand. It defines what "filled" can honestly mean.

### Auto-retrieval (shared grounding)

**Where:** `src/create-ui-spec.ts` evidence resolution. Today, a request with
no `referenceIds` resolves to the recipe-only evidence set. Change:

- When `referenceIds` is empty, run brief-similarity retrieval over the corpus:
  keyword search first (existing `CorpusReader.searchRanked`), falling back to
  embeddings (`findSimilar`) when available, capped at top N=3 entries.
- Each matched entry becomes a `corpus-observation` evidence row whose summary
  is the entry's real `critique`/`whatToSteal` content (sanitized), never a
  stub.
- No match at all → zero evidence rows; both the deterministic body and the
  model prompt then omit evidence rather than fabricate it (the Plan 1
  grounding rule becomes the general rule).

This makes the deterministic body and the model lane share one grounding path.

### Deterministic synthesis

New module `src/create-ui-spec-deterministic.ts` (pure, deterministic,
fixture-testable) that consumes the resolved evidence and the request, and
produces the non-model spec body. Rules:

- **`designDirection`:** synthesized from the top matched entry's
  `visual`/`layout`/`voice` fields plus the request context, written in the
  recipe's own voice (operator content, `recipe-system` authority), citing the
  evidence ids it draws from. If no entry matched the brief class, the section
  states that explicitly ("no corpus match for this brief class") instead of
  generating direction.
- **`rejectedDefaults`:** the recurring `antiPatterns` from matched entries,
  capped at 3, each cited to its evidence id.
- **`colorTokens`:** plurality merge of `visual.colorRoles` across matched
  entries (the existing `design-prompt.ts` merge logic is extracted and
  reused). Populated only when ≥ 3 matched entries contribute; otherwise the
  token remains `unavailable` with an explicit reason in
  `unavailableDecisions`.
- **`typographyTokens`:** same plurality rule over `visual.typePairing`.
- **`layoutRegions` / `responsiveBehavior`:** from the matched entries'
  `layout` field when present.
- **`voice` / `mood`:** from matched entries; mood is populated only when
  coverage exists (currently 22 entries), otherwise unavailable.
- **Authority:** everything above is `recipe-system`/`editorial` authority.
  `proposalOnly` stays `false` — the deterministic body is not model output.
  Accepted-token positions remain null; no authority promotion.

### Contracts

- UiSpec fields already exist; the deterministic synthesizer populates them.
- `EvidenceKindSchema` already has `recipe-system`; auto-retrieved rows are
  `corpus-observation` (existing kind). No new evidence kinds.
- New warning code `noCorpusMatch` when retrieval returns zero rows.
- The corpus-freeze invariant is preserved: nothing writes to
  `corpus/entries.json`; auto-retrieval only reads.

## Data flow

```
create_ui_spec (no model)
  → resolveEvidence
      referenceIds non-empty → resolved references (unchanged)
      referenceIds empty → brief-similarity top-3 (keyword → embeddings)
      zero matches → no evidence rows, warning noCorpusMatch
  → createUiSpecDeterministic(evidence, request)
      → designDirection / rejectedDefaults / tokens / layout / voice
      → unavailableDecisions for fields without coverage
  → envelope (recipe authority, proposalOnly false)
```

The model path consumes the same resolved evidence via the Plan 1 grounding
filter, so a no-reference request with matches now reaches the model with real
summaries instead of stubs.

## Error handling

- Retrieval failure (reader throws) → zero evidence rows + `noCorpusMatch`
  warning; the deterministic body degrades to explicit unavailability, never
  fabricated content.
- Coverage below floor for a field → that field is `unavailable` with a reason
  in `unavailableDecisions`; the audit script enforces the global floor.
- No corpus mutation possible: all reads, no writes.

## Testing

- **Audit:** `scripts/audit-corpus-coverage.mjs` passes on the current corpus
  and fails when a field drops below its floor (fixture corpus).
- **Auto-retrieval:** no references + fixture corpus → top-3 evidence rows with
  real summaries; zero-match brief → zero rows + `noCorpusMatch`; references
  non-empty → unchanged path.
- **Synthesis:** fixture corpus → deterministic `designDirection`,
  `rejectedDefaults`, token plurality, and explicit unavailability; assertions
  that authority stays `recipe-system`, `proposalOnly` false, accepted tokens
  null.
- **Freeze:** corpus bytes unchanged before/after every test (existing pattern
  in `create-ui-spec-model-path.test.ts`).
- **Regression:** full `vitest` suite; the Plan 1 grounding tests now assert
  that a no-reference request WITH matches carries real summaries to the model
  prompt.

## Success criteria

For the three session briefs (login, finance analytics, habit tracker) with no
model configured and no references: `create_ui_spec` returns a populated
`designDirection` with cited evidence for brief classes the corpus covers,
populated tokens where ≥ 3 matched entries contribute, and explicit honest
unavailability elsewhere. No stub strings appear in the served spec, evidence,
or (via Plan 1) the model prompt.

## Non-goals

- Model-lane changes (Plan 1).
- Provenance governance, coarse `design_solution` tool, learning loop.
