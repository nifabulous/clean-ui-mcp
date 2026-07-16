# Changelog

## Unreleased — C1 executable-contract rework (branch `feat/agent-readiness-phase-0-1c`)

An external adversarial review of the initial C1 closure reproduced seven
contract/readiness holes that prior review had missed. All were independently
re-verified (one reviewer over-claim refuted) and are being closed task-by-task
with mandatory exploit reproduction in review. See
[`docs/AGENT_READINESS_STATUS.md`](docs/AGENT_READINESS_STATUS.md) for the full
scorecard and per-task status.

### Fixed
- **Readiness validator no longer trusts fabricated checkpoint approvals.** The C0 gate now recomputes the canonical checkpoint target from Git-bound historical bytes (recorded commit/path, not the working tree) and verifies every approval's target, `approvedArtifacts`, plan/spec/contract hashes, actor kind, index paths, and summary input hashes. Resolution failure is fail-closed (`checkpoint-recompute-failed`); the resolver is required, not optional. C1 edits to the live spec/plan do not reopen C0. (`src/readiness/validator.ts`, new `src/readiness/checkpoint-policy.ts`)
- **String length now validated after trim.** All 68 `z.string().min(N).trim()` fields reordered to `.trim().min(N)`; whitespace-only values no longer pass and normalize to empty.
- **`community-edition` fallback reason allowed** for `find_similar_ui_references`, `plan_ui_direction`, and `critique_ui` structured-fallback (per the retrieval reason matrix).
- **Descriptor-driven primary/reference ID semantics.** Replaced the single `extractRefs` + hard-coded primary-tool list with per-descriptor `extractPrimaryIds` / `extractReferenceIds`; `browse_ui_patterns` `patternType` is now enforced as a primary key. Routed `plan structuredDecisions[].evidenceIds` through the shared dedup validator and added explicit `provenance.sourceReferences` dedup.
- **UiSpec authority now verifies envelope evidence kind.** A `corpus-evidence` decision must reference a `corpus-observation`-kind evidence item (and `editorial` → `editorial-guidance`), not merely sit in the matching authority lane. Same-field authority conflicts require an `authorityConflict` warning.
- **Exact per-tool TypeScript inference preserved.** `ToolResultByName<N>` resolves to the real per-tool envelope; error `code`↔`retryable` is literal-bound (`NOT_FOUND` ⇒ `retryable:false` is a compile error, proven by `@ts-expect-error` in `src/tool-contract-types.test.ts`).

### In progress
- Derive the documentation drift-lock input/default rows from `z.toJSONSchema` instead of handwritten `contractDocs` prose (R6).
- Full-range holistic review over `git merge-base origin/main HEAD..HEAD` and the final C1 gate (R7).

## 0.2.0 (2026-07-12)

### Added
- **`critique_ui` MCP tool** (14th tool) — upload a UI screenshot and receive a grounded critique with cited recommendations. Bounded base64 image input, hybrid image + structured retrieval, citation-gated synthesis.
- **Synthesis authority lanes** — three separated input lanes (evidence / machine rules / editorial guidance) with trust-boundary enforcement.
- **Structured critique output** — Zod-validated `StructuredCritique` schema (v1.0) with `ClaimBasis`, `VisualSlopFinding`, `MotionGuidance`, `AppliedReference`. Both legacy text and `structuredContent` returned.
- **DOM motion capture** — `normalizeMotionDeclarations` wired to the capture pipeline via pre-freeze authored stylesheet rule collection. Per-root scoping, `@media` nesting, reduced-motion-safe.
- **MD3 resemblance classifier** — conservative multi-signal classifier (5 categories, threshold 0.6). Never uses "compliant." Disabled by default, enabled via `framework:"md3"`.
- **Critique-quality scorer** — deterministic offline scorer with `notScorable` handling for zero-recommendation cases. Wired into eval-baseline and eval-matrix with comparison columns.
- **Per-call endpoint-config override** — `EndpointOverride` type reaches `openaiConfigForPass` for DeepSeek V4 Pro comparison via the eval matrix.
- **Review enforcement hooks** — git-native `prepare-commit-msg` and `pre-push` hooks requiring task and branch review artifacts. Bypass via `ZCODE_BYPASS_REVIEW=1` with audit log.
- **Wiring verification test** — mechanically verifies every exported symbol in `src/*.ts` is referenced by a production file.
- **Enhanced reviewer template** (`.zcode/code-reviewer.md`) — four mandatory review dimensions.
- **Reference integrity registry** — manifest with SHA-256 hashes, machine-rules generator, anti-duplication test.
- **Integration test harness** — Voyage protocol contract test with request-body spy, hermetic E2E pipeline. Gated behind `RUN_LIVE_INTEGRATION=1`.
- **CI workflow** — `validate-references` before build, `test:critique-quality` deterministic gate, manual + weekly integration tests.

### Changed
- Split `settlePage` into `waitAndLazyLoadPage` + `freezePageMotion` for motion collection ordering.
- Tagger provider override extended with `extractionOverride`/`critiqueOverride` (config triples).
- Eval baseline pins explicit configs from env, bypassing peak-hour routing for determinism.
- All enforcement detectors (BANNED_PHRASES, VAGUE_PHRASES, UNLABELED_CONTROL, PIXEL_MEASUREMENT, EXEMPTION_PATTERNS) consolidated into generated `machine-rules.json` — no hand-maintained duplicates.

### Removed
- `grok-eval.mjs` — migrated to `eval/configs/grok.json` matrix config.
- 10 dead exported functions identified by wiring verification test.

## 0.1.0

Initial release.
