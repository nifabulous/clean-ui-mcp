# Web Design Target Profiles and Deterministic Handoff Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Build the web adapter foundation and explicit integration API that renders one validated UiSpec 1.0 artifact into neutral web, Astro + React, and Astro + Vue handoffs without changing the historical contract or assuming React by default.

**Architecture:** Keep UiSpec 1.0 as the semantic source of truth and introduce a separately versioned DesignHandoff envelope containing a validated web target profile, dependency/source manifest, semantic token projections, structured motion intents, and deterministic DESIGN.md output. A closed capability registry resolves only supported combinations; unsupported combinations fail closed. The plan delivers the pure integration API; a later create_ui_spec producer supplies the validated UiSpec and structured motion intents. Provider-backed synthesis and native-platform adapters remain separate workstreams.

**Tech Stack:** TypeScript, Zod 4, Vitest, existing UiSpec contracts, deterministic Markdown/JSON renderers, no new runtime dependencies.

## Global Constraints

- Preserve UiSpec specVersion 1.0 and historical tool-contract bytes; do not edit the 1.0 schema in place.
- Use handoffVersion web-1.0 for the new envelope.
- Neutral web is the fallback; an omitted target never becomes React.
- Support exactly neutral-web, astro-react, and astro-vue in this slice.
- Model Astro as host/site framework and React/Vue as separate UI runtimes.
- Require a version plus versionPolicy exact, range, or unversioned for every dependency and target reference. Install dependencies must use exact versions.
- Require source snapshots to declare captured with a SHA-256 or not-captured with a reason; never invent a hash.
- Fail closed on unknown IDs, incompatible combinations, native runtimes, and malformed provenance.
- Keep renderers pure, deterministic, offline, and free of private corpus material or copied third-party source.

## File Map

Create:

- src/design-target-contracts.ts and src/design-target-contracts.test.ts
- src/design-adapter-registry.ts and src/design-adapter-registry.test.ts
- src/design-source-registry.ts and src/design-source-registry.test.ts
- src/design-token-adapters.ts and src/design-token-adapters.test.ts
- src/design-motion-adapters.ts and src/design-motion-adapters.test.ts
- src/design-handoff.ts and src/design-handoff.test.ts
- docs/design-targets.md

Modify only where required:

- src/tool-contracts.ts — do not change the existing public tool contract in this plan; re-export handoff types only if a later contract checkpoint approves it.
- src/design-prompt.test.ts — preserve legacy brief/tokens output while adding no hidden target default.
- src/server-factory.ts — unchanged in this adapter-only plan; create_ui_spec wiring is a later producer task.
- docs/superpowers/specs/2026-07-18-grounded-design-workspace-design.md — document the adapter boundary.

## Task 1: Define the versioned web handoff contract

**Files:** Create src/design-target-contracts.ts and src/design-target-contracts.test.ts.

**Produces:** WebTargetProfile, VersionedRef, DependencyRef, SourceRef, MotionIntent, DesignHandoffInput, DesignHandoff, and inferred types.

- [ ] Write tests requiring neutral-web to parse; a Flutter runtime, unknown component, empty version, malformed hash, package dependency with a range policy, and captured source without a hash to fail; motion intents to require reduced-motion behavior; and not-captured sources to require a reason.
- [ ] Run npx vitest run src/design-target-contracts.test.ts and verify failure.
- [ ] Implement these closed values:

~~~text
WebTargetId: neutral-web | astro-react | astro-vue
WebSiteFramework: none | astro
WebRuntime: none | react | vue
WebStyling: vanilla-css | tailwind | css-modules
WebComponentSource: native-html | custom | shadcn | kumo | base-ui | radix | react-aria | mui
WebMotion: css | view-transitions | css-view-transitions | vue-transition | motion | gsap
~~~

WebTargetProfile contains id, platform web, siteFramework, runtime, styling, componentSource, motion, and optional islandStrategy. Each VersionedRef contains id, version, and versionPolicy exact, range, or unversioned. Package dependencies use exact; target profiles may use range; browser APIs use unversioned.

DependencyRef contains packageName, version, versionPolicy, required, purpose, and nullable docsUrl. SourceRef contains sourceId, kind, URL, snapshotStatus captured or not-captured, optional 64-character lowercase snapshotSha256, optional snapshotReason when not-captured, licenseStatus, and attribution. MotionIntent contains id, trigger, properties, durationToken, easingToken, interruptible, and reducedMotion.

DesignHandoffInput is the untrusted shape { spec: unknown; target: unknown; motionIntents: unknown; generatedAt: string }. generatedAt must be an ISO-8601 UTC datetime. parseDesignHandoff validates spec with UiSpec.safeParse, target with WebTargetProfile, motionIntents with MotionIntent, then resolves the registry before returning DesignHandoffT. The parser, not a type assertion, is the only constructor for DesignHandoffT.

- [ ] Run npx vitest run src/design-target-contracts.test.ts and npm run typecheck:contracts. Expected: PASS.
- [ ] Commit: git add src/design-target-contracts.ts src/design-target-contracts.test.ts && git commit -m "feat: add versioned web design handoff contracts".

## Task 2: Build the closed web capability registry

**Files:** Create src/design-adapter-registry.ts, src/design-adapter-registry.test.ts, src/design-source-registry.ts, and src/design-source-registry.test.ts.

**Produces:** WEB_TARGET_PROFILES, resolveWebTarget(profile), buildDependencyManifest(profile), and buildSourceManifest(profile).

- [ ] Write a complete matrix test. neutral-web permits only native-html or custom components and css, view-transitions, or css-view-transitions. astro-react requires Astro, React, a non-none islandStrategy, and permits React-compatible sources. astro-vue requires Astro, Vue, a non-none islandStrategy, native-html or custom components, and css, css-view-transitions, or vue-transition motion. Every other combination fails.
- [ ] Run npx vitest run src/design-adapter-registry.test.ts and verify failure.
- [ ] Implement rules:

1. neutral-web requires no site framework and no runtime.
2. astro-react requires Astro plus React.
3. astro-vue requires Astro plus Vue.
4. shadcn, Kumo, Base UI, Radix, React Aria, and MUI are React-only.
5. neutral-web cannot select a JavaScript motion runtime or an island strategy.
6. Astro targets require a non-none island strategy when runtime is React or Vue.
7. Native runtimes and unknown IDs are rejected.

Registry entries include package names, documentation URLs, setup notes, and source references. Add src/design-source-registry.ts and its test with these checked-in source IDs and URLs: astro-official (https://docs.astro.build/pl/guides/framework-components/), vue-official (https://vuejs.org/guide/built-ins/transition.html), tailwind-official (https://tailwindcss.com/docs/functions-and-directives), shadcn-official (https://ui.shadcn.com/docs/installation/manual), kumo-official (https://kumo-ui.com/installation/), transitions-dev (https://transitions.dev/), and 21st-community (https://21st.dev/). In this offline slice every entry starts as not-captured with the fixed reason source bytes are not vendored; a later source-snapshot task may promote an entry to captured only when bytes and hash are checked in. No hash may be fabricated. Never use latest; package dependencies require exact versions, while target compatibility may use ranges.

- [ ] Run npx vitest run src/design-adapter-registry.test.ts src/design-source-registry.test.ts; expected: PASS.
- [ ] Commit: git add src/design-adapter-registry.ts src/design-adapter-registry.test.ts src/design-source-registry.ts src/design-source-registry.test.ts && git commit -m "feat: add closed web target capability registry".

## Task 3: Add semantic token projections

**Files:** Create src/design-token-adapters.ts and src/design-token-adapters.test.ts.

**Produces:** normalizeSemanticTokens(spec), renderCssTokens(tokens), and renderTailwindTheme(tokens).

- [ ] Write tests using the existing valid UiSpec fixture. Assert stable semantic names, deterministic CSS root output, deterministic Tailwind theme output, and identical repeated renders.
- [ ] Add injection tests for newline, backtick, and declaration-terminator token values. Nullable tokens render an explicit unavailable decision.
- [ ] Run npx vitest run src/design-token-adapters.test.ts and verify failure.
- [ ] Implement the current UiSpec 1.0 mapping exactly: bg.canvas from colorTokens.primary, bg.surface from colorTokens.surface, text.primary from colorTokens.ink, text.muted from colorTokens.muted, action.accent from colorTokens.accent, and font.heading/body/mono from typographyTokens.heading/body/mono. Keep this compatibility mapping in one named function so a future UiSpec schema can add a real canvas token without changing the renderer.

Do not infer missing values from corpus data. CSS emits stable custom properties. Tailwind emits theme variables only, not utility classes.

- [ ] Run the focused token tests; expected: PASS.
- [ ] Commit: git add src/design-token-adapters.ts src/design-token-adapters.test.ts && git commit -m "feat: render semantic web design tokens".

## Task 4: Add semantic motion mappings

**Files:** Create src/design-motion-adapters.ts and src/design-motion-adapters.test.ts.

**Produces:** validateMotionIntents, renderWebMotionGuidance, and motionSourceRefs. Motion intents are explicit input; this task must not parse free-form UiSpec motion notes.

- [ ] Write tests requiring reduced-motion guidance, Vue Transition and TransitionGroup guidance for Vue, CSS/View Transitions distinction between local state and route/layout changes, and proof that registry references do not become install dependencies.
- [ ] Run npx vitest run src/design-motion-adapters.test.ts and verify failure.
- [ ] Implement mappings:

~~~text
Vue: Transition for enter/exit and TransitionGroup for list changes.
CSS/View Transitions: CSS for local state and View Transitions for route/layout changes.
Neutral CSS: CSS transitions and data-state selectors.
All profiles: prefers-reduced-motion fallback.
~~~

Source references retain URL, snapshotStatus, hash when captured, reason when not-captured, attribution, and license status.

- [ ] Run the focused motion tests; expected: PASS.
- [ ] Commit: git add src/design-motion-adapters.ts src/design-motion-adapters.test.ts && git commit -m "feat: map semantic motion to web runtimes".

## Task 5: Build the deterministic DESIGN.md handoff renderer

**Files:** Create src/design-handoff.ts and src/design-handoff.test.ts.

**Produces:** parseDesignHandoff, buildDesignHandoff, renderDesignHandoffMarkdown, renderDesignHandoffJson, and renderDesignHandoff.

- [ ] Write fixtures for neutral-web, astro-react, and astro-vue. Assert the existing 19-section DESIGN.md outline, handoff version, target profile, implementation guidance, interaction/motion, acceptance criteria, and byte-identical repeated rendering.
- [ ] Assert neutral output has CSS variables and no React/Astro setup; Astro + React has island and React setup; Astro + Vue has island and Vue motion guidance with no React-only recommendation.
- [ ] Run npx vitest run src/design-handoff.test.ts and verify failure.
- [ ] Implement parseDesignHandoff(input: DesignHandoffInput): DesignHandoffT as the fail-closed boundary: parse target, parse UiSpec, validate explicit motionIntents, resolve registry profile, build dependency/source manifests, sort manifests without mutation, and return typed data. No type assertion may bypass parsing. The output must preserve not-captured source reasons.
- [ ] Render frontmatter fields:

~~~yaml
spec_version: "1.0"
handoff_version: "web-1.0"
target_profile: "astro-vue"
platform: "web"
site_framework: "astro@5.x"
site_framework_version_policy: "range"
ui_runtime: "vue@3.x"
ui_runtime_version_policy: "range"
styling: "tailwind@4.x"
styling_version_policy: "range"
component_source: "custom@unversioned"
motion: "vue-transition@unversioned"
~~~

Section 14 must contain setup, dependencies, component-role mapping, token filenames, island strategy, motion adapter, source-attribution rules, and an explicit warning for every not-captured source. Never include raw corpus records or copied third-party source.

JSON output uses stable key order and a final newline. Dispatch accepts only markdown or json.

- [ ] Run all adapter tests; expected: PASS.
- [ ] Commit: git add src/design-handoff.ts src/design-handoff.test.ts && git commit -m "feat: render deterministic web design handoffs".

## Task 6: Document web profile selection

**Files:** Create docs/design-targets.md; modify docs/superpowers/specs/2026-07-18-grounded-design-workspace-design.md.

- [ ] Document that no target means neutral web, never implicit React, and list only neutral-web, astro-react, and astro-vue.
- [ ] Explain site framework, UI runtime, styling, component source, and motion adapter as separate choices.
- [ ] Include Astro + React and Astro + Vue examples and unsupported-combination behavior.
- [ ] State that UiSpec remains canonical, DESIGN.md is derived, and the handoff envelope is a renderer concern until a future contract checkpoint approves embedding profiles directly in UiSpec.
- [ ] Commit: git add docs/design-targets.md docs/superpowers/specs/2026-07-18-grounded-design-workspace-design.md && git commit -m "docs: define web design target profiles".

## Task 7: Publish the explicit integration API without weakening legacy output

**Files:** Modify src/design-prompt.test.ts; modify src/design-handoff.ts from Task 5. Do not modify src/design-prompt.ts or src/server-factory.ts in this adapter-only plan.

- [ ] Add regression tests proving legacy brief and tokens output is unchanged and omitted target produces no React/Astro/Tailwind assumption.
- [ ] Export the concrete producer-facing function buildDesignHandoff(input: DesignHandoffInput): DesignHandoffT from src/design-handoff.ts. A future create_ui_spec implementation must call this function after producing a schema-valid UiSpec and structured MotionIntent array; it must not construct DesignHandoff directly.
- [ ] Do not overload legacy framework brief/tokens output and do not infer a profile from prose. A future public handoffProfileId requires a separate contract-checkpoint change with tool fixtures and catalog digest updates.
- [ ] Run npx vitest run src/design-prompt.test.ts src/design-handoff.test.ts; expected: PASS.
- [ ] Commit: git add src/design-prompt.test.ts src/design-handoff.ts && git commit -m "feat: publish web handoff integration API".

## Task 8: Close boundaries and release gates

**Files:** Create src/design-handoff-boundary.test.ts; include src/design-source-registry.test.ts from Task 2; modify contract tests only if the handoff becomes a public tool result.

- [ ] Add tests proving private .c2-private paths cannot appear; unknown sources fail; Vue cannot receive React-only sources; native runtimes fail; URLs are preserved but source code is not embedded; unavailable decisions remain explicit; identical input produces identical bytes.
- [ ] Run npm test, npm run typecheck:contracts, and npm run build. Expected: all existing C1/C2 validation gates remain green. This plan does not claim create_ui_spec MCP wiring; that is the next producer plan.
- [ ] Record in the PR description that UiSpec 1.0 bytes were not changed. A future move of target profiles into UiSpec requires a separate schema-version and contract-checkpoint change.
- [ ] Commit: git add src/design-handoff-boundary.test.ts && git commit -m "test: close web handoff boundaries".

## Definition of Done

- Only neutral-web, astro-react, and astro-vue are accepted.
- No omitted target defaults to React.
- Astro host/runtime separation appears in JSON and Markdown.
- Vue output contains Vue-compatible guidance and no React-only recommendation.
- Tokens are semantic and render to CSS variables or Tailwind theme directives.
- Motion includes intent, implementation mapping, and reduced-motion behavior.
- Registry references include URL, snapshot status, hash when captured, reason when not-captured, attribution, and license status.
- Dependency manifests contain concrete versions or explicit unversioned status.
- Package dependencies use exact versions; target compatibility may use ranges; browser APIs use unversioned with an explicit policy.
- Every source is either hash-captured or emitted as not-captured with a reason; no source hash is invented.
- DESIGN.md follows the existing 19-section outline and is deterministic.
- buildDesignHandoff accepts only untrusted input through parseDesignHandoff and is the documented integration boundary for the future create_ui_spec producer.
- Legacy generate_design_prompt output remains unchanged without explicit handoff request.
- Unsupported combinations fail closed.
- No private corpus material or third-party source code is copied into output.
- npm test, npm run typecheck:contracts, and npm run build pass.
- Native support is explicitly deferred.
- This plan does not claim a public create_ui_spec MCP route; that requires a separate provider/contract integration plan.

## Self-Review

- Tasks 1–2 cover contracts, version policies, source provenance, and compatibility.
- Tasks 3–4 cover semantic tokens and motion.
- Task 5 covers deterministic DESIGN.md.
- Task 6 covers documentation.
- Task 7 publishes the concrete producer-facing integration API and preserves legacy compatibility; public MCP wiring is explicitly deferred.
- Task 8 covers fail-closed boundaries and release gates.
- No task changes UiSpec 1.0 in place.
- No task introduces a hidden React default.
- Provider-backed synthesis and native adapters remain separate workstreams.

Plan complete and saved to docs/superpowers/plans/2026-07-22-web-design-adapters.md.
