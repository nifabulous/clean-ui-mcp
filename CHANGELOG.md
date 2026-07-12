# Changelog

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
