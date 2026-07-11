# Screenshot Critique (`critique_ui`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an MCP tool that accepts a screenshot and optional product context, retrieves visually and structurally relevant corpus evidence, and returns an observation-grounded critique with cited recommendations.

**Architecture:** The tool uses a hybrid pipeline. A screenshot is validated and normalized, written to a short-lived temp file for the existing path-based two-pass tagger, and removed after extraction. A pluggable image-embedding provider retrieves approved corpus candidates; when unavailable, the tool falls back to the existing text embedding index using the normalized extraction. Critique-specific evidence assembly, synthesis, and citation gating are implemented for this output shape, following the trust-boundary pattern established by Decision Lab without reusing its comparative-rubric code.

**Tech Stack:** TypeScript, Zod, MCP SDK, existing tagger/corpus/Decision Lab modules, `fetch`, Vitest, and the selected hosted multimodal embedding API behind a provider interface.

## Global Constraints

- Do not accept filesystem paths or URLs as image input; accept only bounded base64 image data plus an explicit MIME type.
- Maximum decoded image payload is 10 MiB; reject unsupported MIME types before any provider call.
- Only `reviewStatus: "approved"` corpus entries may be retrieved as evidence.
- Raw model output is audit data only; synthesis receives sanitized extraction facts and gated corpus evidence.
- Every recommendation must cite at least one allowed evidence ID or be labeled uncertain and omitted from the actionable recommendations list.
- No corpus mutation occurs during `critique_ui`.
- Existing tools and text-only retrieval continue to work when no image-embedding credentials are configured.
- Provider/model identity, latency, fallback use, and citation coverage are logged without logging image bytes or API keys.

---

### Task 1: Define the critique contract, image bridge, and deterministic fixtures

**Files:**
- Create: `src/critique-ui.ts`
- Create: `src/critique-ui.test.ts`
- Modify: `src/schema.ts` only if a reusable response type is needed
- Create: `eval/critique-fixtures.json`

**Interfaces:**
- Produces `CritiqueUiInput`, `CritiqueUiResult`, `CritiqueEvidence`, and `CritiqueRecommendation` types consumed by later tasks.
- `CritiqueUiInput` is `{ image: { data: string; mimeType: "image/png" | "image/jpeg" | "image/webp" }; productContext?: string; platform?: "web" | "mobile" | "tablet"; framework?: string }`.
- `CritiqueUiResult` contains `summary`, `observations`, `recommendations`, `accessibilityRisks`, `evidence`, `confidence`, `fallbackUsed`, and `provider` metadata.
- `withValidatedImageFile(input, callback)` writes the decoded bytes to a uniquely named file under the OS temp directory, invokes `callback(imagePath)`, and removes the file in a `finally` block.

- [ ] **Step 1: Write failing contract tests** for invalid MIME types, malformed base64, payloads over 10 MiB, empty product context, and a valid fixture preserving the supplied platform.
- [ ] **Step 2: Run the focused tests** with `npm test -- src/critique-ui.test.ts`; expected: failures because the contract validator does not exist.
- [ ] **Step 3: Implement `validateCritiqueUiInput`** with exact MIME, base64, size, and optional-field checks.
- [ ] **Step 4: Implement `withValidatedImageFile`** as the required bridge into `tagImage(imagePath, ...)`: decode only after validation, use a random temp filename with the validated extension, invoke the callback, and remove the file on success, tagger failure, or timeout. Never accept a caller-supplied path.
- [ ] **Step 5: Add three deterministic fixtures**: a desktop dashboard, a portrait mobile flow, and a screenshot with no strong corpus match. Store only test metadata and a small local image fixture, never provider responses.
- [ ] **Step 6: Re-run the focused tests** and commit as `test: define critique-ui input and output contract`.

### Task 2: Add the image-embedding provider boundary and selection gate

**Files:**
- Create: `src/image-embeddings.ts`
- Create: `src/image-embeddings.test.ts`
- Modify: `src/env.ts` and `.env.example`
- Create: `scripts/benchmark-image-embeddings.mjs`

**Interfaces:**
- `ImageEmbeddingProvider` exposes `name`, `model`, and `embedImage(image: ValidatedImage): Promise<number[]>`.
- `createImageEmbeddingProvider()` returns the configured adapter or `null` when image embeddings are not configured.
- `ImageEmbeddingProvider` must reject non-image MIME types, return a non-empty finite vector, and expose provider/model metadata.

- [ ] **Step 1: Write contract tests** using a fake provider for dimension validation, provider errors, missing configuration, and no image-byte logging.
- [ ] **Step 2: Run `npm test -- src/image-embeddings.test.ts`**; expected: failures for the missing factory and contract checks.
- [ ] **Step 3: Implement the provider interface, configuration parsing, timeout, and bounded retry policy.** Keep provider-specific HTTP code inside this module; never leak it into `server.ts` or retrieval code.
- [ ] **Step 4: Implement the benchmark script** against the deterministic fixtures. It must report latency, vector dimension, error rate, and a simple nearest-neighbor stability score, without writing corpus state.
- [ ] **Step 5: Select the first hosted adapter only if it passes:** 100% fixture completion, finite vectors with one stable dimension, p95 latency under 8 seconds, and no image bytes in logs. Record the selected provider/model in `docs/` and `.env.example`.
- [ ] **Step 6: Re-run focused tests and commit as `feat: add pluggable image embedding provider`**.

### Task 3: Build hybrid evidence retrieval and a separate image index

**Files:**
- Create: `src/critique-retrieval.ts`
- Create: `src/critique-retrieval.test.ts`
- Create: `src/image-index.ts`
- Create: `src/image-index.test.ts`
- Modify: `src/corpus.ts` only to expose an approved-entry vector search helper if required

**Interfaces:**
- `retrieveCritiqueEvidence(input, extraction, provider): Promise<RetrievalResult>`.
- `RetrievalResult` contains up to five approved corpus entries, similarity scores, retrieval mode (`image`, `hybrid`, or `structured-fallback`), and a coverage classification.
- `ImageIndex` has its own file path, model name, dimension validation, load/save functions, and status reporting; it must never load or overwrite `corpus/embeddings.json`.

- [ ] **Step 1: Write failing tests** for image retrieval, draft exclusion, platform filtering, no-index fallback, and no-match behavior.
- [ ] **Step 2: Run `npm test -- src/critique-retrieval.test.ts`**; expected: failures before the retrieval module exists.
- [ ] **Step 3: Implement the new image-index infrastructure** in `src/image-index.ts`: use the dedicated gitignored path `corpus/image-embeddings.json`, persist `{ version, model, dimension, entries }`, reject model/dimension mismatches explicitly, and expose `loadImageIndex`, `saveImageIndex`, and `imageIndexStatus`.
- [ ] **Step 4: Implement image retrieval** through the new index and provider interface; do not modify the text index loader's Voyage-only validation.
- [ ] **Step 5: Implement structured fallback** by serializing the normalized extraction and product context into the existing text-query path. Return `fallbackUsed: true` and explain the mode in metadata.
- [ ] **Step 6: Rely on `searchRanked`'s existing default `reviewStatus: "approved"` filter**, then apply platform-aware filtering before evidence reaches synthesis. Add a regression test that a draft never appears even when it is the nearest vector.
- [ ] **Step 7: Add a corpus image-index build script** (`src/scripts/build-image-index.ts` + `npm run build-image-index` in package.json) analogous to `npm run build-index` for text. It embeds approved corpus images using the selected image-embedding provider, writes to `corpus/image-embeddings.json`, and is incremental (skip entries whose image hash hasn't changed). Without this script the image index is always empty and the tool always falls back to structured retrieval.
- [ ] **Step 8: Run focused tests plus the existing corpus tests and commit as `feat: add hybrid critique evidence retrieval`**.

### Task 4: Write critique-specific synthesis and citation gating

**Files:**
- Create: `src/critique-synthesis.ts`
- Create: `src/critique-synthesis.test.ts`

**Interfaces:**
- `buildCritiqueEvidence(extraction, retrieval, productContext)` returns stable evidence IDs such as `screen:patternType`, `screen:layout`, and `corpus:<entryId>`.
- `synthesizeCritique(evidence, options): Promise<CritiqueUiDraft>` calls the existing text-model pathway with a rubric requiring observation, impact, recommendation, and evidence IDs.
- `gateCritique(draft, evidenceIds): CritiqueUiResult` removes unsupported claims, rejects unknown citations, and converts uncited recommendations into `uncertain` observations.
- The module may follow Decision Lab's trust-boundary pattern, but it must not call `assembleEvidence`, `synthesize`, `buildSynthesisPrompt`, or `gateCitations`; those functions are coupled to `DecisionT` and the comparative-rubric `SynthesisOutput` shape.

- [ ] **Step 1: Write failing tests** for valid citations, unknown citation removal, unsupported exact measurements, accessibility risks without evidence, and the no-corpus-evidence case.
- [ ] **Step 2: Run `npm test -- src/critique-synthesis.test.ts`**; expected: failures before the new rubric/gate exists.
- [ ] **Step 3: Implement critique-specific evidence assembly** using normalized extraction facts only; raw extraction and raw critique remain outside the synthesis prompt.
- [ ] **Step 4: Implement the critique rubric** with bounded output: 3–7 observations, 3–5 recommendations, and WCAG IDs only when supported by visible evidence.
- [ ] **Step 5: Implement the post-hoc citation gate** and one bounded retry on invalid JSON or unsupported citations, matching Decision Lab behavior.
- [ ] **Step 6: Add fixture-based scoring** for citation precision, evidence coverage, and recommendation count. Commit as `feat: add grounded screenshot critique synthesis`.

### Task 5: Register the `critique_ui` MCP tool

**Files:**
- Modify: `src/server.ts`
- Create: `src/server-critique-ui.test.ts` or extend the existing MCP server contract test file

**Interfaces:**
- Register `critique_ui` with the input schema from Task 1.
- The handler calls `validateCritiqueUiInput` → `withValidatedImageFile(..., imagePath => tagImage(imagePath, ...))` (extraction only) → `retrieveCritiqueEvidence` → `synthesizeCritique` → `gateCritique`.

- [ ] **Step 1: Write failing MCP contract tests** for valid input, invalid payloads, missing image provider fallback, provider failure, and stable `isError` responses.
- [ ] **Step 2: Run the focused server tests**; expected: failure because `critique_ui` is not registered.
- [ ] **Step 3: Register the tool** with an explicit description explaining image privacy, fallback behavior, evidence citations, and the no-mutation guarantee.
- [ ] **Step 4: Add request-scoped timeout and error mapping** so provider failures return a useful fallback/error message without exposing upstream response bodies or secrets.
- [ ] **Step 5: Log only query metadata** (`provider`, `model`, `retrievalMode`, `latencyMs`, `evidenceCount`, `citationCoverage`), never image content.
- [ ] **Step 6: Run MCP contract tests and the full existing test suite; commit as `feat: expose critique_ui MCP tool`**.

### Task 6: Add end-user documentation and operational checks

**Files:**
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `.env.example`
- Create: `scripts/critique-fixture.mjs`

- [ ] **Step 1: Document the tool** with a request example, response shape, privacy limits, provider configuration, and structured-only fallback behavior.
- [ ] **Step 2: Add `npm run critique-fixture`** to run the deterministic fixture set without requiring a live provider; it must report citation coverage, unsupported-claim count, and fallback mode.
- [ ] **Step 3: Update the roadmap** to mark `critique_ui` shipped only after the provider benchmark, fixture score gate, and MCP contract tests pass.
- [ ] **Step 4: Run `npm run build`, `npm run validate-corpus`, `npm test`, and `npm run critique-fixture`.
- [ ] **Step 5: Commit as `docs: document screenshot critique workflow`**.

## Verification Gate

Before merging the milestone:

```bash
npm run build
npm run validate-corpus
npm test
npm run critique-fixture
```

The milestone is not complete unless the deterministic fixtures pass with zero unsupported actionable recommendations, all retrieved entries are approved, and the no-image-provider path returns a clearly labeled structured fallback.

## Self-review

- The plan covers input validation, provider isolation, retrieval, synthesis, citation gating, MCP exposure, fallback behavior, privacy, tests, and documentation.
- No task mutates the corpus or mixes image and text embedding indexes.
- The provider choice is gated by a concrete benchmark rather than hard-coded before latency/error evidence exists.
- Existing Decision Lab and tagger trust boundaries are followed, not duplicated; the critique modules use their own synthesis and gate code.
