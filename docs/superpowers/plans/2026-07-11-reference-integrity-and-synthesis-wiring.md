# Reference Integrity and Synthesis Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `critique_ui` consume verified, purpose-selected references with single-source machine rules, structured provenance, measurable critique quality, DOM motion evidence, and conservative MD3 resemblance classification.

**Architecture:** A checked-in JSON manifest and canonical machine-rule JSON generate typed build artifacts before TypeScript compilation. `critique_ui` receives three authority-separated input lanes and returns unchanged Markdown plus MCP `structuredContent`; the existing eval and DOM-sidecar pipelines are extended to score and supply the new contracts.

**Tech Stack:** TypeScript 5.9, Node.js 22 ESM, Zod 4, MCP SDK 1.29, Vitest 4, Playwright 1.61, JSON/Markdown reference assets.

## Global Constraints

- Existing MCP tool names and the complete human-readable `content[0]` response remain backward-compatible.
- Phase A changes only the LLM-backed `critique_ui` path; deterministic design-brief aggregators remain unchanged.
- `machine-rules.json` is the only authored source for duplicated phrase and hallucination detectors.
- Production requests do not read repository reference files; generation runs before `tsc` and output ships in `dist`.
- Editorial guidance cannot serve as screenshot or DOM evidence.
- Motion declarations do not prove an animation ran.
- MD3 output describes resemblance, never compliance.
- Deterministic evaluation gates CI; model-judge evaluation is reporting-only.

---

## File Map

- Create `skill/clean-ui-design/references/manifest.json`: versioned provenance and hashes for the four Markdown references.
- Create `skill/clean-ui-design/references/machine-rules.json`: canonical phrase lists, regex sources/flags, and exemptions.
- Create `scripts/generate-reference-artifacts.mjs`: validate authored JSON and emit the runtime artifact.
- Create `src/references/generated.ts`: generated immutable descriptors and machine rules; never hand-edit.
- Create `src/references/types.ts`: authority, purpose, loaded-reference, machine-rule, and claim-basis contracts.
- Create `src/references/loader.ts`: manifest integrity validation and purpose selection.
- Create `src/references/loader.test.ts`: manifest, hash, version, path, and selector tests.
- Create `src/references/generated.test.ts`: parity tests for all machine-rule consumers and Markdown.
- Create `src/synthesis/context.ts`: evidence/rules/guidance lanes and registered evidence IDs.
- Create `src/synthesis/contracts.ts`: structured critique schema and provenance types.
- Create `src/synthesis/render.ts`: complete legacy Markdown renderer from structured output.
- Modify `src/tagger.ts`, `src/content-lint.ts`, `scripts/eval-scorer.mjs`: consume generated rules.
- Modify `src/critique-ui.ts`, `src/critique-synthesis.ts`, `src/server.ts`: typed context, gates, output schema, and `structuredContent`.
- Create `eval/critique-quality-labels.json`: versioned labels keyed to the existing eval IDs.
- Create `scripts/critique-quality-scorer.mjs` and test: offline deterministic scoring.
- Modify `scripts/eval-set.mjs`, `scripts/eval-runner.mjs`, `scripts/eval-baseline.mjs`, `scripts/eval-matrix.mjs`: unified critique-quality reporting.
- Delete `scripts/grok-eval.mjs` after its useful provider cases move to the unified runner.
- Create `src/dom-motion.ts` and test: normalized motion declarations.
- Modify `src/scripts/capture.ts`, `src/tagger.ts`: motion sidecar capture and input transport.
- Create `src/md3-classifier.ts` and test: conservative multi-signal resemblance classifier.
- Modify `package.json`, `.github/workflows/ci.yml`, and `README.md`: generation, validation, commands, and contracts.

---

### Task 1: Author and Validate the Reference Registry

**Files:**
- Create: `skill/clean-ui-design/references/manifest.json`
- Create: `src/references/types.ts`
- Create: `src/references/loader.ts`
- Create: `src/references/loader.test.ts`

**Interfaces:**
- Produces: `validateReferenceRegistry(root: string): ReferenceDescriptor[]`
- Produces: `selectReferences(descriptors, purposes): ReferenceDescriptor[]`
- Produces: `npm run validate-references`

- [ ] **Step 1: Write failing loader tests**

Test four valid descriptors, duplicate IDs/paths, traversal paths, missing files, wrong SHA-256, malformed source SHA, and purpose filtering. Use a temporary directory and assert error messages include the descriptor ID and failing field.

```ts
expect(() => validateReferenceRegistry(root)).toThrow(/material-design-3.*sha256/i);
expect(selectReferences(valid, ["motion-guidance"]).map((r) => r.id))
  .toEqual(["design-engineering"]);
```

- [ ] **Step 2: Run the tests and confirm failure**

Run: `npx vitest run src/references/loader.test.ts`

Expected: FAIL because `src/references/loader.ts` does not exist.

- [ ] **Step 3: Add types, manifest, and loader**

Define the approved `ReferenceAuthority`, `ReferencePurpose`, and descriptor interface. Resolve paths beneath the repository root, reject absolute/traversal paths, hash bytes with `createHash("sha256")`, validate 40-character source SHAs, and return frozen descriptors. Populate the manifest using the four files already on `main`, their exact upstream data from `VENDORED_SOURCES.md`, and freshly calculated hashes.

- [ ] **Step 4: Add version-policy validation**

Compare the current manifest with `git show HEAD^:<manifest path>` when available: changed content hash requires `version = previous.version + 1`; unchanged hash requires unchanged version. Skip historical comparison only when the prior manifest does not exist.

- [ ] **Step 5: Verify the loader directly**

Run: `npx vitest run src/references/loader.test.ts`

Expected: PASS without requiring a generator that Task 2 has not introduced yet.

- [ ] **Step 6: Commit**

```bash
git add skill/clean-ui-design/references/manifest.json src/references
git commit -m "feat(references): add integrity registry"
```

### Task 2: Generate One Machine-Rule Artifact Before TypeScript Build

**Files:**
- Create: `skill/clean-ui-design/references/machine-rules.json`
- Create: `scripts/generate-reference-artifacts.mjs`
- Create: `src/references/generated.ts`
- Create: `src/references/generated.test.ts`
- Modify: `package.json`
- Modify: `skill/clean-ui-design/references/banned-phrases.md`

**Interfaces:**
- Produces: `BANNED_PHRASES`, `VAGUE_PHRASES`, `UNLABELED_CONTROL_RISK`, `PIXEL_MEASUREMENT`, and exemptions from `src/references/generated.ts`.
- Produces: `npm run generate-references` and a build chain that runs generation before `tsc`.

- [ ] **Step 1: Write failing generation/parity tests**

Assert JSON schema validity, regex compilation, deterministic generated output, exact Markdown phrase-list parity, and failure when a generated file differs from expected content.

```ts
expect(BANNED_PHRASES).toContain("clean layout");
expect(UNLABELED_CONTROL_RISK.test("icon-only button without a label")).toBe(true);
expect(PIXEL_MEASUREMENT.test("a 12px radius")).toBe(true);
```

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/references/generated.test.ts`

Expected: FAIL because the canonical JSON and generated module do not exist.

- [ ] **Step 3: Author canonical rules and generator**

Transcribe every current detector and exemption once into `machine-rules.json`. The generator validates known keys, compiles every regex as a smoke test, reads the validated manifest, and writes deterministic TypeScript containing `Object.freeze` arrays and `new RegExp(source, flags)` expressions. `--check` compares expected bytes without writing and exits nonzero on drift.

- [ ] **Step 4: Wire generation before compilation**

Update scripts exactly as follows:

```json
"generate-references": "node scripts/generate-reference-artifacts.mjs",
"validate-references": "node scripts/generate-reference-artifacts.mjs --check",
"build": "npm run generate-references && tsc"
```

This explicitly resolves the approved N2 concern; plain `tsc` is no longer the project build command.

- [ ] **Step 5: Generate and verify idempotence**

Run: `npm run generate-references && git diff --exit-code src/references/generated.ts && npm run validate-references`

Expected: generation succeeds, a second check produces no diff, validation passes.

- [ ] **Step 6: Commit**

```bash
git add skill/clean-ui-design/references scripts/generate-reference-artifacts.mjs src/references package.json
git commit -m "feat(references): generate canonical machine rules"
```

### Task 3: Remove All Private Detector Copies

**Files:**
- Modify: `src/tagger.ts`
- Modify: `src/content-lint.ts`
- Modify: `src/content-lint.test.ts`
- Modify: `scripts/eval-scorer.mjs`
- Modify: `scripts/eval-scorer.test.mjs`

**Interfaces:**
- Consumes: generated exports from Task 2.
- Produces: identical sanitizer/lint/scorer behavior without local constants.

- [ ] **Step 1: Add a no-duplicate characterization test**

Add a test that scans the three consumer sources and asserts they import generated rules and do not declare `const BANNED_PHRASES`, `const VAGUE_PHRASES`, `const UNLABELED_CONTROL`, or `const PIXEL_MEASUREMENT`.

- [ ] **Step 2: Run existing characterization tests**

Run: `npx vitest run src/content-lint.test.ts src/tagger.test.ts scripts/eval-scorer.test.mjs`

Expected: existing behavior passes; new no-duplicate test fails.

- [ ] **Step 3: Replace constants with imports**

Import generated strings/regexes in all consumers. Preserve regex semantics by generating fresh non-global regex objects; do not share stateful `/g` instances. Replace the content-lint exact-length assertion with parity against the generated array.

- [ ] **Step 4: Verify behavior and repository-wide uniqueness**

Run the tests above, then:

```bash
rg -n "const (BANNED_PHRASES|VAGUE_PHRASES|UNLABELED_CONTROL|PIXEL_MEASUREMENT)" src scripts
```

Expected: tests PASS; `rg` returns only generated declarations.

- [ ] **Step 5: Commit**

```bash
git add src/tagger.ts src/content-lint.ts src/content-lint.test.ts scripts/eval-scorer.mjs scripts/eval-scorer.test.mjs
git commit -m "refactor(rules): remove duplicated enforcement detectors"
```

### Task 4: Build Typed Synthesis Lanes and Expanded Evidence

**Files:**
- Create: `src/synthesis/context.ts`
- Create: `src/synthesis/context.test.ts`
- Modify: `src/critique-ui.ts`
- Modify: `src/critique-ui.test.ts`
- Modify: `src/critique-synthesis.ts`
- Modify: `src/critique-synthesis.test.ts`

**Interfaces:**
- Produces: `SynthesisContext { evidence, rules, guidance }`.
- Produces: registered `screen:visual:*` evidence.
- Consumes: `selectReferences()` and generated machine rules.

- [ ] **Step 1: Write failing context tests**

Assert lane separation, deterministic purpose selection, no editorial IDs in valid evidence IDs, and evidence creation for dominant colors, accent, color roles, shadows, borders, and type pairing.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/synthesis/context.test.ts src/critique-synthesis.test.ts`

Expected: FAIL on missing context module and visual evidence IDs.

- [ ] **Step 3: Implement context and evidence registry**

Move fixed citable-key mapping into `context.ts`. Serialize bounded values deterministically; cap arrays and object detail lengths. Build rules from generated exports and guidance from selected references. Keep `CritiqueEvidence.source` backward-compatible while extending it to support `dom` in Task 9.

- [ ] **Step 4: Refactor critique prompt**

Change `synthesizeCritique(context, options)` to render separate `Evidence`, `Machine rules`, and `Editorial guidance` headings. State that only evidence IDs support observations, while editorial IDs support recommendations only.

- [ ] **Step 5: Verify**

Run: `npx vitest run src/critique-ui.test.ts src/critique-synthesis.test.ts src/synthesis/context.test.ts`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/synthesis src/critique-ui.ts src/critique-ui.test.ts src/critique-synthesis.ts src/critique-synthesis.test.ts
git commit -m "feat(critique): separate synthesis authority lanes"
```

### Task 5: Add Structured Findings, Provenance Gates, and MCP Structured Content

**Files:**
- Create: `src/synthesis/contracts.ts`
- Create: `src/synthesis/render.ts`
- Create: `src/synthesis/render.test.ts`
- Modify: `src/critique-ui.ts`
- Modify: `src/critique-synthesis.ts`
- Modify: `src/critique-synthesis.test.ts`
- Modify: `src/server.ts`
- Modify: `src/critique-ui.integration.test.ts`

**Interfaces:**
- Produces: schema `1.0`, `ClaimBasis`, `VisualSlopFinding`, `MotionGuidance`, applied-reference metadata.
- Produces: `renderCritiqueMarkdown(result): string`.
- Produces: MCP `structuredContent` matching the registered `outputSchema`.

- [ ] **Step 1: Write failing contract and gate tests**

Cover valid visible findings, inferred exceptions, editorial motion, fabricated evidence/reference IDs, missing citations, invalid claim bases, and removal of the dead `uncertain` field.

- [ ] **Step 2: Write backward-compatibility tests**

Assert a legacy consumer that reads only `content[0].text` receives platform, retrieval, coverage, summary, observations, recommendations, accessibility risks, visual findings, and motion guidance. Separately assert `structuredContent` parses against the output schema and contains data matching the text. This explicitly resolves approved N1.

- [ ] **Step 3: Run and confirm failure**

Run: `npx vitest run src/synthesis/render.test.ts src/critique-synthesis.test.ts src/critique-ui.integration.test.ts`

Expected: FAIL because structured contracts and output do not exist.

- [ ] **Step 4: Implement schemas, gates, and renderer**

Use Zod for the MCP output schema. Gate evidence IDs against the context registry and reference IDs against applied descriptors. Findings with no valid evidence are omitted; editorial motion with no valid reference is omitted. Render the complete Markdown from the gated object.

- [ ] **Step 5: Register structured output**

Add `outputSchema` to `critique_ui`; return:

```ts
return {
  content: [{ type: "text", text: renderCritiqueMarkdown(result) }],
  structuredContent: result,
};
```

- [ ] **Step 6: Verify and commit**

Run: `npm run build && npx vitest run src/critique-ui.test.ts src/critique-synthesis.test.ts src/synthesis`

```bash
git add src/synthesis src/critique-ui.ts src/critique-synthesis.ts src/server.ts src/critique-ui.integration.test.ts
git commit -m "feat(critique): return provenance-aware structured output"
```

### Task 6: Add Offline Critique-Quality Gold Labels and Scoring

**Files:**
- Create: `eval/critique-quality-labels.json`
- Create: `scripts/critique-quality-scorer.mjs`
- Create: `scripts/critique-quality-scorer.test.mjs`
- Modify: `scripts/eval-set.mjs`
- Modify: `scripts/eval-runner.mjs`
- Modify: `scripts/eval-baseline.mjs`
- Modify: `scripts/eval-matrix.mjs`
- Delete: `scripts/grok-eval.mjs`

**Interfaces:**
- Produces: `scoreCritiqueQuality(output, label)` and aggregate deterministic metrics.
- Consumes: schema `1.0`, eval IDs, reference hashes.

- [ ] **Step 1: Write scorer tests with synthetic perfect, partial, and invalid outputs**

Assert schema validity, citation rate, unknown IDs, banned phrases, visual-slop precision/recall, exception accuracy, unsupported motion basis, forbidden claims, and MD3 false positives.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run scripts/critique-quality-scorer.test.mjs`

Expected: FAIL because scorer and labels do not exist.

- [ ] **Step 3: Label the existing 15 fixtures**

Create versioned labels for every ID in `EVAL_SET`. Include required/forbidden pattern IDs, allowed exceptions, motion policy, forbidden claims, required evidence prefixes, and MD3 expectation. Add up to six fixtures only if a listed category remains uncovered; verify every label ID has exactly one eval item and vice versa.

- [ ] **Step 4: Implement offline scoring and baseline metadata**

Make deterministic scoring credential-free. Include schema version, label-set version, provider/model when present, manifest versions/hashes, and threshold results in baseline JSON. Model-judge fields are nullable and never determine process exit status.

- [ ] **Step 5: Consolidate the legacy evaluator**

Move any unique Grok provider configuration into `eval-matrix.mjs`, delete `grok-eval.mjs`, and assert `rg` finds no private detector regexes or nine-image list.

- [ ] **Step 6: Verify and commit**

Run: `npx vitest run scripts/eval-scorer.test.mjs scripts/critique-quality-scorer.test.mjs && node -e "import('./scripts/eval-set.mjs').then(m => { if (m.EVAL_SET.length < 15) process.exit(1) })"`

```bash
git add eval scripts
git commit -m "feat(eval): score structured critique quality"
```

### Task 7: Add CI Gates and Documentation for Phases A–B

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Produces: CI sequence `generate/check references → tsc → validate corpus → deterministic tests`.

- [ ] **Step 1: Add package scripts**

Add `test:critique-quality` for offline scorer tests and `eval-critique-quality` for live/baseline runs. Keep `npm test` credential-free.

- [ ] **Step 2: Add explicit CI integrity gate**

After `npm ci`, run `npm run validate-references`; retain `npm run build` so generation-before-tsc is independently exercised. Do not require provider secrets.

- [ ] **Step 3: Document contracts and workflows**

Document authored versus generated files, version-bump policy, build generation, legacy text plus `structuredContent`, deterministic thresholds, and how to regenerate a live baseline.

- [ ] **Step 4: Verify and commit**

Run: `npm run validate-references && npm run build && npm run validate-corpus && npm test`

Expected: all commands exit 0 without prompting for input.

```bash
git add .github/workflows/ci.yml package.json README.md
git commit -m "ci: gate reference integrity and critique quality"
```

### Task 8: Normalize DOM Motion Declarations

**Files:**
- Create: `src/dom-motion.ts`
- Create: `src/dom-motion.test.ts`
- Modify: `src/scripts/capture.ts`

**Interfaces:**
- Produces: `DomMotionSignal[]` and `normalizeMotionDeclarations(raw)`.
- Extends: `DomSignals` with `motion: { signals, coverage, inaccessibleStylesheets }`.

- [ ] **Step 1: Write normalization tests**

Cover `0s`, mixed `s/ms` lists, property/duration list cycling, delays, easing, infinite iterations, `transition: all`, reduced-motion overrides, unstable selector redaction, caps, and inaccessible stylesheets.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/dom-motion.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement pure normalization**

Return no zero-duration signals; normalize time to integer milliseconds; cap at 50 elements and 100 signals; emit semantic selector hints from tag/role/test-id without class hashes or text; return partial coverage instead of throwing.

- [ ] **Step 4: Extend capture evaluation**

For visible interactive elements, collect computed transition/animation fields and same-origin stylesheet rules. Detect `@media (prefers-reduced-motion: reduce)` when readable. Catch `SecurityError` per stylesheet and increment `inaccessibleStylesheets`.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run src/dom-motion.test.ts src/scripts/ui-browser.test.ts && npm run build`

```bash
git add src/dom-motion.ts src/dom-motion.test.ts src/scripts/capture.ts
git commit -m "feat(capture): record normalized DOM motion signals"
```

### Task 9: Feed DOM Motion Evidence into Critique Synthesis

**Files:**
- Modify: `src/critique-ui.ts`
- Modify: `src/critique-synthesis.ts`
- Modify: `src/synthesis/context.ts`
- Modify: `src/synthesis/context.test.ts`
- Modify: `src/tagger.ts`
- Modify: `src/scripts/ui-server.ts`

**Interfaces:**
- Adds: `CritiqueEvidence.source = "dom"` and stable `dom:motion:<index>` IDs.
- Keeps: editorial recommendation basis distinct from DOM declaration basis.

- [ ] **Step 1: Write failing evidence tests**

Assert motion declarations become bounded `dom:*` evidence, stylesheet declarations never become `visible`, and absent DOM input produces no motion evidence or failure.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/synthesis/context.test.ts src/critique-synthesis.test.ts`

Expected: FAIL on unsupported DOM source.

- [ ] **Step 3: Transport motion sidecars through existing paths**

Extend existing `DomSignals` types in capture, tagger input, UI server sidecar loading, and critique context. Do not persist these private facts into public corpus entries.

- [ ] **Step 4: Gate factual versus editorial motion output**

DOM declarations use `basis: "dom-grounded"` with `dom:*` IDs. Appropriateness advice uses `basis: "editorial"` with reference IDs. Prompt rules prohibit “ran,” “felt,” or “performed smoothly” claims from stylesheet declarations alone.

- [ ] **Step 5: Verify and commit**

Run: `npx vitest run src/synthesis src/critique-synthesis.test.ts src/scripts/ui-server.test.ts && npm run build`

```bash
git add src/critique-ui.ts src/critique-synthesis.ts src/synthesis src/tagger.ts src/scripts/ui-server.ts
git commit -m "feat(critique): ground motion guidance in DOM declarations"
```

### Task 10: Add Conservative MD3 Resemblance Classification

**Files:**
- Create: `src/md3-classifier.ts`
- Create: `src/md3-classifier.test.ts`
- Modify: `src/synthesis/contracts.ts`
- Modify: `src/synthesis/context.ts`
- Modify: `src/critique-synthesis.ts`
- Modify: `scripts/critique-quality-scorer.mjs`

**Interfaces:**
- Produces: `classifyMd3Resemblance(evidence): DesignSystemClassification`.
- Requires: at least three independent signal categories and no hard conflict for `supported`.

- [ ] **Step 1: Write positive, ambiguous, and negative tests**

Positive requires tonal surfaces plus compatible type hierarchy plus component/state or shape evidence. Negative proves a rounded card, pill, or tonal background alone returns `insufficient-evidence`. Assert `conflictingSignals` and evidence IDs are preserved.

- [ ] **Step 2: Run and confirm failure**

Run: `npx vitest run src/md3-classifier.test.ts`

Expected: FAIL because classifier does not exist.

- [ ] **Step 3: Implement deterministic classifier**

Score independent categories, not raw signal count. Return `supported` only when three categories match, confidence meets the checked-in threshold, and no hard conflict exists. Never emit the word `compliant` in types, prompt, renderer, or result.

- [ ] **Step 4: Integrate behind an explicit option**

Default classification to disabled until the checked-in negative-set threshold passes. When enabled, apply the MD3 reference only if classification is supported or the user explicitly requests MD3; otherwise return `insufficient-evidence` without MD3 recommendations.

- [ ] **Step 5: Verify threshold and commit**

Run: `npx vitest run src/md3-classifier.test.ts scripts/critique-quality-scorer.test.mjs && npm run build`

```bash
git add src/md3-classifier.ts src/md3-classifier.test.ts src/synthesis src/critique-synthesis.ts scripts/critique-quality-scorer.mjs
git commit -m "feat(critique): classify conservative MD3 resemblance"
```

### Task 11: Full-System Verification and Release Gate

**Files:**
- Modify if required by verified behavior: `README.md`
- Do not modify unrelated untracked files.

**Interfaces:**
- Verifies every acceptance criterion from the approved design.

- [ ] **Step 1: Run integrity and generated-artifact checks**

Run: `npm run validate-references && npm run generate-references && git diff --exit-code src/references/generated.ts`

Expected: all exit 0 and generation is idempotent.

- [ ] **Step 2: Run build, corpus validation, and full offline tests**

Run: `npm run build && npm run validate-corpus && npm test`

Expected: all exit 0 without provider credentials or interactive prompts.

- [ ] **Step 3: Run focused contract tests**

Run: `npx vitest run src/references src/synthesis src/dom-motion.test.ts src/md3-classifier.test.ts scripts/eval-scorer.test.mjs scripts/critique-quality-scorer.test.mjs`

Expected: all PASS.

- [ ] **Step 4: Audit forbidden drift and language**

```bash
rg -n "const (BANNED_PHRASES|VAGUE_PHRASES|UNLABELED_CONTROL|PIXEL_MEASUREMENT)" src scripts
rg -ni "md3.compliant|material design 3 compliant" src scripts
```

Expected: detector declarations exist only in the generated module; compliance search returns no result.

- [ ] **Step 5: Confirm backward compatibility manually**

Invoke `critique_ui` with mocked providers through its integration harness. Confirm a consumer reading only `content[0]` gets the complete critique and a schema-aware consumer gets matching `structuredContent`.

- [ ] **Step 6: Commit final documentation corrections, if any**

```bash
git add README.md
git diff --cached --quiet || git commit -m "docs: finalize reference-aware critique workflow"
```

---

## Phase Release Gates

- **Phase A gate after Task 7:** reference checks, generated-rule parity, build, corpus validation, all offline tests, and legacy/structured MCP compatibility pass.
- **Phase B gate after Task 7:** all 15–21 fixtures have labels; deterministic scoring is offline; Grok divergence is gone; checked-in thresholds pass.
- **Phase C motion gate after Task 9:** screenshot-only behavior still passes; DOM failures degrade gracefully; no declaration is described as runtime behavior.
- **Phase C MD3 gate after Task 10:** negative-set false-positive threshold passes before classification is enabled by default.
