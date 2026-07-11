# Reference Integrity and Synthesis Wiring Design

**Date:** 2026-07-11

**Status:** Approved for implementation planning

**Scope:** Build-order steps 5–10

## Objective

Turn the companion skill's design references into verified, purpose-selected,
traceable inputs to the LLM-backed `critique_ui` synthesis path. Preserve
existing MCP text responses while adding structured provenance,
critique-quality evaluation, DOM motion facts, and conservative Material Design
3 resemblance classification.

No runtime code currently reads the reference Markdown files. The tagger and
evaluation scripts instead contain manually transcribed enforcement constants,
including three divergent copies of banned-phrase and hallucination detectors.
Phase A is therefore a net-new runtime integration and a consolidation of
existing enforcement rules, not merely hardening an existing loader.

The work ships as three independently useful phases:

1. Reference-aware synthesis: build-order steps 5–8.
2. Critique-quality evaluation: build-order step 9.
3. Observable motion signals and optional MD3 classification: build-order step 10.

## Constraints

- Existing MCP tool names and human-readable text responses remain compatible.
- New response data is additive and carries an explicit schema version.
- Phase A changes the LLM-backed `critique_ui` path. The deterministic
  `generate_design_prompt` and `recommend_ui_direction` aggregators remain
  unchanged.
- Static screenshots cannot establish motion behavior.
- Editorial references may guide recommendations but cannot prove observations.
- MD3 output describes resemblance supported by evidence, never compliance.
- Deterministic validation is required in CI; model-judge evaluation is initially
  reporting-only.
- Reference files are selected from a checked-in manifest. Callers cannot provide
  arbitrary filesystem paths.

## Architecture

```text
Reference manifest + canonical machine rules + Markdown files
              |
              v
 Integrity validation (path, metadata, SHA-256)
              |
              v
 Purpose-based reference selection
              |
              v
 Typed synthesis context
   | evidence | machine rules | editorial guidance |
              |
              v
 Critique synthesis -> structural gates -> compatible MCP rendering
              |
              +----> structured output + applied-reference metadata

Gold labels -> deterministic scorer -> baseline/diff -> CI gates

Browser capture -> normalized DOM motion facts -> evidence lane
                                            -> optional MD3 resemblance result
```

The shared abstractions are reference identity, authority, purpose, claim
provenance, and versioned output. The evaluation and DOM phases reuse these
contracts rather than creating parallel evidence systems.

## Phase A: Reference-Aware Synthesis

### A1. Reference registry and integrity

Add a checked-in reference manifest. Every reference descriptor contains:

```ts
type ReferenceAuthority =
  | "machine-rule"
  | "editorial"
  | "external-standard";

type ReferencePurpose =
  | "critique-structure"
  | "text-anti-slop"
  | "visual-anti-slop"
  | "motion-guidance"
  | "design-taxonomy";

interface ReferenceDescriptor {
  id: string;
  version: number;
  path: string;
  sha256: string;
  authority: ReferenceAuthority;
  purposes: ReferencePurpose[];
  sourceUrl: string;
  sourceCommit: string;
  license: string;
}
```

Store descriptors in
`skill/clean-ui-design/references/manifest.json`, parsed with native JSON support
and no new dependency. The initial registry covers:

- `banned-phrases`
- `decision-effect-rejection`
- `design-engineering`
- `material-design-3`

Reference reconciliation is complete on `main` through PR #17. Canonical MD3
verification is complete in commit `53de323`. Any future third-party adaptation
that differs from canonical MD3 must say so explicitly.

The loader verifies descriptor shape, unique IDs and paths, file existence,
SHA-256 content hashes, allowed repository-relative paths, source commit format,
and required provenance fields. Missing files and hash mismatches are fatal
integrity errors. The loader never silently skips or substitutes a reference.

`version` is a positive revision ordinal. It increments for every content
change, whether caused by an upstream resync or a local edit. A changed SHA-256
with an unchanged version fails validation; changing a version without changing
content also fails validation against the previous manifest recorded in git.

Add a deterministic `validate-references` command and run it in CI. It also
checks that references named in the companion `SKILL.md` exist in the manifest.

### A2. Machine-rule single source of truth

Store code-enforced detectors in
`skill/clean-ui-design/references/machine-rules.json`. This file is the canonical
machine-readable source for banned text phrases, vague content-lint phrases,
unlabeled-control and pixel-measurement regular expressions, and their allowed
exemptions.

The loader validates this JSON and compiles immutable string and regular
expression values. `src/tagger.ts`, `src/content-lint.ts`, and
`scripts/eval-scorer.mjs` consume one generated TypeScript artifact; none keeps a
private copy. The human-readable lists in `banned-phrases.md` are generated from,
or structurally validated against, the same JSON during `validate-references`,
so prose and enforcement cannot drift silently.

The first loader increment must replace the existing hardcoded
`BANNED_PHRASES`, `VAGUE_PHRASES`, `UNLABELED_CONTROL`, and
`PIXEL_MEASUREMENT` copies. Production requests must not read repository files at
runtime; the build produces a typed module included in `dist`.

### A3. Purpose-based selection

Consumers request references by purpose rather than filename. The selector
returns bounded reference sections plus descriptor metadata. It does not append
all reference text to every prompt.

Selection policy:

| Reference purpose | `critique_ui` selection | Authority |
|---|---:|---|
| Critique structure | Always | Editorial format |
| Text anti-slop | Always | Machine-enforced rule |
| Visual anti-slop | Always | Editorial detection rubric |
| Motion guidance | Only for relevant components/context | Editorial recommendation |
| Design taxonomy | When requested or supported by signals | External standard |

Reference selection is deterministic from tool intent and available facts. A
model cannot promote editorial guidance into evidence by choosing a reference.

The deterministic design-brief tools continue aggregating curated corpus fields.
Adding MD3 terminology to their templates, if later desired, is a separate
bounded deterministic change rather than part of the LLM synthesis context.

### A4. Typed synthesis context

Replace undifferentiated prompt inputs with three authority lanes:

```ts
interface SynthesisContext {
  evidence: EvidenceInput[];
  rules: MachineRule[];
  guidance: EditorialGuidance[];
}
```

- `evidence` contains screenshot extraction facts, corpus entries, and later DOM
  facts. It may support observations and recommendations.
- `rules` contains validators and hard output restrictions. It can reject or
  transform output but does not become a factual citation.
- `guidance` contains reference-backed recommendations. It may shape advice but
  cannot support claims about what a screenshot or live page does.

Prompt builders render these lanes under separate headings and state their
permitted uses. Evidence IDs use stable namespaces such as `screen:*`,
`corpus:*`, and `dom:*`. Guidance cites stable reference IDs.

Screenshot evidence expands beyond the current seven-key allowlist. Visual facts
use registered IDs including `screen:visual:dominantColors`,
`screen:visual:accentColor`, `screen:visual:colorRoles`,
`screen:visual:usesShadows`, `screen:visual:usesBorders`, and
`screen:visual:typePairing`. Visual-slop findings may cite only registered
evidence IDs; free-form IDs remain invalid.

### A5. Unified claim provenance and structured additive output

All finding types share one evidence-basis vocabulary:

```ts
type ClaimBasis = "visible" | "inferred" | "dom-grounded" | "editorial";
```

Accessibility risks retain their existing `visible | inferred | dom-grounded`
subset. Visual-slop findings use that same subset. Motion recommendations use
`editorial`, while captured motion declarations use `dom-grounded`. The existing
overall result confidence (`high | medium | low`) remains a coverage summary,
not claim provenance. The dead `CritiqueRecommendation.uncertain` field is
removed after compatibility tests confirm it is never serialized.

The first structured schema version is `1.0` and includes applied references:

```ts
interface SynthesisMetadata {
  schemaVersion: "1.0";
  references: Array<{
    id: string;
    version: number;
    sha256: string;
    authority: ReferenceAuthority;
  }>;
}
```

Visual anti-slop findings use:

```ts
interface VisualSlopFinding {
  patternId: string;
  severity: "critical" | "major" | "minor";
  basis: Extract<ClaimBasis, "visible" | "inferred" | "dom-grounded">;
  evidenceIds: string[];
  effect: string;
  recommendation: string;
  exceptionApplied?: string;
}
```

Every finding needs at least one valid screenshot or DOM evidence ID. The gate
removes unknown IDs. A finding with no remaining evidence is downgraded to a
non-actionable diagnostic or omitted; it is never retained as observed.

Editorial motion recommendations use:

```ts
interface MotionGuidance {
  element: string;
  trigger: string;
  recommendation: string;
  rationale: string;
  referenceIds: string[];
  basis: "editorial";
}
```

In Phase A, motion guidance always has `basis: "editorial"`. This makes the
screenshot limitation machine-visible rather than relying on prose disclaimers.

Existing MCP responses continue returning their current readable text sections
in `content[0]`. The `critique_ui` registration adds an `outputSchema`, and the
same call result adds the protocol-supported `structuredContent` object carrying
the versioned result. The text is rendered from that object. No JSON text block
is appended to the Markdown, no current tool is renamed, and no current text
section is removed. Compatibility tests assert both the legacy `content[0]`
shape and the new `structuredContent` schema.

### A6. Phase A acceptance criteria

- Reference reconciliation and MD3 verification remain intact.
- Reference provenance, license, version, and SHA-256 metadata are checked in.
- Missing, modified, or undeclared references fail validation and CI.
- Tagger, content lint, and evaluation share one generated machine-rule source;
  duplicated phrase and hallucination detectors are removed.
- `critique_ui` selects references by purpose.
- Evidence, rules, and guidance remain distinct through prompting and gating.
- Visual-slop findings and motion guidance are structured and provenance-aware.
- Unknown evidence and reference citations cannot survive the gate.
- Existing MCP clients continue receiving the expected human-readable output,
  while schema-aware clients receive `structuredContent`.

## Phase B: Critique-Quality Evaluation

### B1. Gold-label format

Extend the existing 15-image evaluation set with critique-quality labels for all
15 images. If those images do not cover every negative and exception category,
add at most six focused fixtures, for a final set of 15–21 images. The set must
cover:

- an obvious visual-slop pattern;
- a plausible pattern with a legitimate exception;
- a screen without the target anti-patterns;
- appropriate and inappropriate motion recommendations;
- MD3-like tonal treatment;
- superficial MD3 resemblance that must not classify;
- unsupported accessibility and interaction claims.

Labels use a structured contract:

```ts
interface CritiqueGoldLabel {
  fixtureId: string;
  expectedObservations: string[];
  expectedVisualSlop: {
    required: string[];
    forbidden: string[];
    allowedExceptions?: string[];
  };
  motionGuidance: "required" | "allowed" | "forbidden";
  forbiddenClaims: string[];
  requiredEvidenceIds?: string[];
  md3Classification?: "supported" | "insufficient-evidence" | "not-md3";
}
```

Gold labels identify concepts and IDs rather than requiring exact prose matches.
Fixture images remain in the existing eval fixture location; labels live in a
versioned adjacent JSON file so extraction and critique evaluation share IDs.

### B2. Scoring

Deterministic scoring reports:

- output-schema validity;
- valid evidence-citation rate;
- unknown reference and evidence counts;
- banned-phrase violations;
- visual-slop precision, recall, and exception accuracy;
- unsupported motion claims with `visible` or `dom-grounded` basis;
- MD3 false-positive rate;
- required and forbidden claim matches.

`scripts/grok-eval.mjs` is deprecated when this scorer lands. Any still-useful
provider matrix is migrated to the unified runner; its private nine-image set
and duplicated detector regexes are removed rather than maintained as a fourth
evaluation path.

An optional model judge scores specificity, usefulness, contradictions, and
DECISION + EFFECT + REJECTION completeness. Judge prompts and model identity are
versioned in reports. Judge scores do not initially fail CI.

### B3. Baseline and CI policy

The baseline records model/provider identity, reference versions and hashes,
schema version, fixture-set version, and all deterministic metrics. CI fails on:

- schema validity below 100%;
- any unknown citation;
- any unsupported motion claim whose basis is `visible` or `dom-grounded`;
- MD3 false-positive rate above the checked-in threshold;
- a material precision or recall regression beyond the checked-in tolerance.

Provider-dependent live evaluation remains a separate command. Deterministic
scorer tests run without credentials.

### B4. Phase B acceptance criteria

- Gold fixtures cover positive, negative, and exception cases.
- The scorer is independently unit-tested with synthetic outputs.
- Baselines include reference and schema versions.
- Deterministic metrics can run offline and gate CI.
- Model-judge failures do not block deterministic evaluation.
- The legacy Grok evaluator is removed or reduced to a thin caller of the
  unified evaluation infrastructure with no private fixtures or detectors.

## Phase C: DOM Motion Signals and MD3 Resemblance

### C1. DOM motion-signal capture

Browser capture inspects computed styles and relevant stylesheet rules for a
bounded set of interactive elements. It records declarations, not claims that
an animation ran:

```ts
interface DomMotionSignal {
  selectorHint: string;
  elementRole?: string;
  property:
    | "transition"
    | "animation"
    | "transform"
    | "opacity"
    | "scroll-behavior";
  durationMs?: number;
  delayMs?: number;
  easing?: string;
  iterationCount?: number | "infinite";
  triggerEvidence?: "computed-style" | "stylesheet-rule";
  reducedMotionOverride: boolean | "unknown";
}
```

Normalization must:

- discard zero-duration defaults;
- normalize seconds and milliseconds into integer milliseconds;
- cap recorded elements and declarations;
- avoid generated or unstable selectors in persisted data;
- separate transitions from keyframe animations;
- identify `transition: all` explicitly;
- detect observable `prefers-reduced-motion` overrides;
- treat cross-origin stylesheet access failures as partial data, not fatal errors.

Normalized facts receive `dom:*` evidence IDs. If DOM capture is unavailable,
the pipeline continues screenshot-only and reports motion evidence as
unavailable.

### C2. Motion synthesis after DOM capture

Observed DOM declarations and editorial motion recommendations remain separate:

- A declaration such as `transition-duration: 200ms` is DOM evidence.
- Whether 200ms is appropriate is editorial guidance.
- A stylesheet declaration does not prove the transition was triggered or
  perceptually smooth.

Structured output therefore records both the observed declaration and the
reference-backed recommendation when applicable.

### C3. Optional MD3 resemblance classification

MD3 classification is conservative and additive:

```ts
interface DesignSystemClassification {
  system: "material-design-3";
  status: "supported" | "insufficient-evidence";
  confidence: number;
  matchedSignals: string[];
  conflictingSignals: string[];
  evidenceIds: string[];
}
```

`supported` requires multiple independent signals, such as tonal surface
hierarchy, role-compatible color relationships, type-role hierarchy, shape
treatment, and recognizable component or state treatment. One rounded card,
pill, shadowless surface, or tonal background is insufficient. The classifier
must expose conflicting as well as supporting signals.

The product never emits `MD3-compliant`; available evidence can support only
resemblance. When the threshold is not met, return `insufficient-evidence` or
omit MD3-specific recommendations.

### C4. Phase C acceptance criteria

- DOM capture produces bounded, normalized, privacy-conscious motion facts.
- Cross-origin and unavailable-DOM cases degrade gracefully.
- Motion declarations enter synthesis as evidence without being described as
  observed runtime behavior.
- MD3 classification requires multiple evidence categories and records
  conflicts.
- Negative fixtures protect against superficial MD3 false positives.
- Existing screenshot-only workflows remain functional.

## Error Handling

| Failure | Required behavior |
|---|---|
| Reference missing or hash mismatch | Fail validation; reject synthesis startup with an integrity error |
| Manifest malformed | Report the exact descriptor and field; do not load a partial registry |
| Machine-rule source differs from generated artifact or prose list | Fail reference validation and show the divergent rule ID |
| Reference selection empty | Continue only when the purpose is optional; record no applied references |
| Model output malformed | Retry once, then return a valid partial result with diagnostics |
| Unknown evidence/reference ID | Strip it; downgrade or omit the unsupported claim |
| DOM capture unavailable | Continue screenshot-only and mark DOM evidence unavailable |
| Cross-origin stylesheet inaccessible | Preserve computed-style facts and report partial coverage |
| MD3 signals insufficient | Return `insufficient-evidence`; do not assume MD3 recommendations |
| Eval judge unavailable | Run deterministic scoring and mark judge scoring skipped |

## Testing Strategy

Implementation follows test-driven development at each boundary:

1. Manifest schema, version policy, and hash-validation unit tests.
2. Machine-rule generation and drift tests covering every current consumer.
3. Purpose-selector unit tests proving irrelevant references stay excluded.
4. Prompt-context tests proving evidence, rules, and guidance are separated.
5. Gate tests for fabricated evidence, reference IDs, visual-slop findings, and
   motion provenance.
6. Backward-compatibility tests for MCP text and `structuredContent` rendering.
7. Offline scorer tests using synthetic perfect, partial, and invalid outputs.
8. Capture normalization tests for CSS time lists, zero-duration declarations,
   `transition: all`, reduced-motion rules, and cross-origin failures.
9. MD3 classifier positive, ambiguous, and false-positive tests.
10. Integration tests covering reference selection through rendered MCP output.
11. Full TypeScript build, test suite, corpus validation, and reference validation.

Live provider evaluation is not required for ordinary unit tests. Provider-based
baseline generation is an explicit development/release action.

## Delivery Order and Release Gates

1. Record the already-reconciled references and verified MD3 source in the
   manifest.
2. Ship registry, loader, validation command, and CI gate.
3. Replace hardcoded tagger, content-lint, and eval detectors with generated
   machine-rule output.
4. Ship typed `critique_ui` synthesis lanes and purpose selection.
5. Ship structured visual-slop/motion output and compatible rendering.
6. Establish the critique-quality gold set and deterministic baseline; retire
   the divergent Grok evaluator.
7. Ship DOM motion capture and synthesis integration.
8. Enable conservative MD3 resemblance classification after its negative-set
   false-positive threshold passes.

Phase B begins only after Phase A output contracts stabilize. Phase C can be
developed after those contracts stabilize, but MD3 classification is not enabled
by default until the Phase B evaluation proves its false-positive behavior.

## Out of Scope

- Adding more editorial reference documents.
- Rebuilding or redesigning the curator dashboard.
- Automatic claims of standards compliance.
- Runtime animation playback quality measurement.
- General-purpose design-system recognition beyond MD3.
- Breaking MCP response changes or renaming existing tools.
- Injecting editorial guidance into deterministic design-brief aggregation.
