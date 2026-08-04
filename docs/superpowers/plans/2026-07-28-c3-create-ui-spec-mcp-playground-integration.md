# C3 `create_ui_spec` MCP and Playground Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing deterministic `createUiSpec()` producer user-testable through the public MCP tool and the local Playground/API, with one producer, one validated artifact envelope, safe response-scoped evidence, and no private corpus leakage.

**Architecture:** Keep `src/create-ui-spec.ts` as the only synthesis authority. Add thin transport adapters: MCP maps validated producer output to the standard tool envelope and requested rendering; the loopback HTTP route returns the parsed artifact envelope with both renderings; the Playground consumes that route and never imports the private corpus or assembles a `UiSpec` in the browser. Extend the shared MCP evidence contract only where required to represent the producer's already-defined response-scoped evidence vocabulary without exposing private identities.

**Tech Stack:** TypeScript, Zod, `@modelcontextprotocol/sdk`, Node HTTP server, React/Vite Playground, Vitest, Playwright/browser tests, canonical JSON/SHA-256 helpers, and the injected `CorpusReader` boundary.

## Global Constraints

- `createUiSpec()` remains the sole producer of `UiSpec`, authority lanes, retrieval metadata, warnings, artifact identity, and both handoff renderings.
- MCP and HTTP adapters may parse transport input, call the producer, and serialize validated output only. They may not construct a `UiSpec`, assign evidence authority, sanitize raw corpus entries, or render a second handoff.
- Preserve `UiSpec` 1.0 and `DesignArtifactEnvelopeSchema` field semantics. Do not add transport-only presentation fields to the persisted artifact envelope.
- MCP input uses `outputFormat: "markdown" | "json"`, defaulting to `"markdown"`; remove the legacy `serializationFormat` terminology from the beta `create_ui_spec` contract.
- MCP passes `target` and `motionIntents` through to the core request, alongside the existing brief, platform, framework, design-system, constraints, and explicit-reference fields.
- Automatic retrieval is keyword/metadata; zero matches are structured-fallback/metadata with `fallbackReason: "no-results"`; explicit references are none/none. The adapter must preserve the producer's actual state rather than normalizing it to satisfy an old descriptor.
- Raw corpus IDs, source URLs, product identities, image paths, screenshots, critiques, provider diagnostics, credentials, and filesystem paths must not appear in MCP output, HTTP responses, browser DOM, logs, analytics, or error messages.
- Public evidence IDs (`evidence-1`, `evidence-2`, ...) and safe public reference IDs remain separate domains. Never substitute one for the other.
- Public mode must continue to use only the injected `PublicCorpusReader`; private mode keeps its current reader behavior. No direct `corpus.ts` or global index import may be added to an adapter.
- Default tests, builds, MCP calls, and Playground tests make no network or paid provider calls. Live-provider enrichment remains disabled/deferred for this integration slice.
- Do not alter the C2 paid-campaign gate, baseline-metrics requirement, or readiness approval state. This work is an offline C3 product surface.

---

## File Map

### Create

- `src/create-ui-spec-dependencies.ts` — shared producer dependency factory and bounded explicit-reference resolver for MCP and HTTP.
- `src/create-ui-spec-mcp.ts` — thin MCP adapter, safe evidence projection, rendering selection, and typed error mapping.
- `src/create-ui-spec-mcp.test.ts` — in-memory MCP contract tests for success, fallback, explicit references, errors, and privacy.
- `src/create-ui-spec-http.ts` — thin HTTP adapter for the C3 request/response mapping.
- `src/create-ui-spec-http.test.ts` — loopback HTTP route tests for CSRF/origin, envelope shape, and safe failure behavior.
- `site/src/data/create-ui-spec.ts` — typed same-origin API client and download helpers.
- `site/src/pages/BrowsePage.tsx` — preserves the current corpus-search Playground surface after `/playground` becomes the C3 composer.
- `site/src/pages/BrowsePage.test.tsx` — migrated search-page component tests.

### Modify

- `src/create-ui-spec.ts` — expose an internal adapter-facing result that retains validated sanitized evidence alongside the parsed envelope without adding it to the persisted envelope schema; keep the existing envelope-only API compatible.
- `src/tool-contracts.ts` — migrate `CreateUiSpecInput` to `outputFormat`, add the core pass-through fields, add the explicit `allowNoneWithPositiveResult` descriptor capability, update retrieval policy, warning/error codes, evidence vocabulary, and strict evidence/reference invariants.
- `src/__fixtures__/tool-contract-fixtures.ts` — update valid input/result/error fixtures with the new format, retrieval states, and safe evidence rows.
- `src/tool-contracts.test.ts` — cover the migrated input, retrieval matrix, evidence-kind rules, and ID-domain separation.
- `src/tool-contract-docs.test.ts` — update exact public-tool and generated-contract assertions.
- `src/tool-catalog.test.ts` — assert `create_ui_spec` is public and `generate_design_prompt` is not an alias in the beta catalog.
- `src/server-factory.ts` — register `create_ui_spec` through the adapter and remove `generate_design_prompt` from public registration while keeping legacy helpers private.
- `src/server.ts` — use the shared C3 dependency factory when constructing the MCP server.
- `src/public-mcp-contract.test.ts` — add the new tool to the real in-memory public-reader leak suite.
- `src/mcp-smoke.test.ts` — update tool count/list and call the new tool in the compiled-server smoke test.
- `src/wiring-verification.test.ts` — replace the C3 deferred-registration assertion with a direct registration/wiring assertion.
- `src/scripts/ui-server.ts` — serve the built site, add CSRF issuance/enforcement, and route `POST /api/create-ui-spec` through the shared HTTP adapter.
- `src/scripts/ui-server.test.ts` — cover the new API route, nonce lifecycle, and production static serving while preserving existing curator API coverage.
- `ui/app.js` — send the process-local CSRF header on existing mutating curator requests.
- `ui/classic-app.js` — send the process-local CSRF header on existing mutating curator requests.
- `site/vite.config.ts` — proxy `/api` to the loopback UI server during development.
- `site/src/app/App.tsx` — route `/playground` to the C3 composer and add `/browse` for the preserved corpus-search surface.
- `site/src/app/SiteShell.tsx` — expose the intended navigation labels/routes for Playground and Browse.
- `site/src/pages/HomePage.tsx` — update entry links so the primary action opens the C3 composer and browsing remains discoverable.
- `site/src/pages/EvidencePage.tsx` — preserve the correct back-to-browse route.
- `site/src/pages/PlaygroundPage.tsx` — add the focused composer/result flow and accessible lifecycle states.
- `site/src/pages/PlaygroundPage.test.tsx` — replace search assertions with composer-state coverage.
- `site/tests/site-browser.test.ts` — test the composer, fallback result, downloads, keyboard flow, and private-marker absence.
- `site/tests/vitest.browser.config.ts` — support the production loopback-server browser fixture in addition to the existing preview fixture.
- `package.json` — add the explicit production browser-test orchestration command and keep the existing offline build/test commands intact.
- `docs/superpowers/specs/2026-07-27-c3-create-ui-spec-first-slice-design.md` — update only its mechanically generated tool-contract block after descriptor changes; do not rewrite the approved design prose.

## Phase 1: Close the MCP Contract Boundary

### Task 1: Migrate the beta descriptor and shared evidence contract

**Files:** `src/tool-contracts.ts`, `src/tool-contracts.test.ts`, `src/__fixtures__/tool-contract-fixtures.ts`, `src/tool-contract-docs.test.ts`, `src/tool-catalog.test.ts`

- [ ] Replace `serializationFormat` with `outputFormat: z.enum(["markdown", "json"]).default("markdown")`.
- [ ] Add the core pass-through fields with the same bounds as `CreateUiSpecRequestSchema`: `target` and `motionIntents`; keep the adapter schema strict and bounded.
- [ ] Add and enforce the descriptor-level `allowNoneWithPositiveResult` capability in the shared descriptor type and envelope validator, then set it for `create_ui_spec`.
- [ ] Set the descriptor retrieval policy to the exact allowed states:
  - `hybrid/text`, `keyword/metadata`, `structured-fallback/metadata` with `no-results`, and `none/none`.
  - `allowedAttemptedModes: ["keyword"]` for the automatic fallback path.
  - `allowNoneWithPositiveResult: true` for explicit-reference/one-spec results.
- [ ] Keep `dataSchema: UiSpec`, `hasEvidence: true`, and the existing typed warning/error model. Map core `RETRIEVAL_UNAVAILABLE` to the existing retryable MCP `PROVIDER_ERROR`; do not expose a new transport error code or raw core message.
- [ ] Extend the shared evidence contract without breaking legacy rows:
  - permit response-scoped `corpus-observation` rows without a private `referenceId` when the ID matches `evidence-[0-9]+`;
  - support the producer's `public-reference` and `recipe-system` kinds and `aggregate`/`user-supplied` bases with explicit kind-to-basis rules;
  - keep old non-response-scoped corpus rows subject to their existing `referenceId` requirement;
  - ensure `referenceId`, when present, is always a safe public reference and never an internal corpus ID.
- [ ] Update `evidenceKinds` for `create_ui_spec` to include exactly the kinds the adapter can emit, and preserve the authority-kind checks for cited decisions.
- [ ] Update `extractReferenceIds` to read only `UiSpec.citedReferences`; evidence IDs must never become top-level `referenceIds`.
- [ ] Update fixtures and generated contract tests to cover markdown default, JSON selection, automatic retrieval, zero-result fallback, explicit references, and no legacy beta alias.
- [ ] Add failing-then-passing tests for: stale `serializationFormat` rejection, missing `outputFormat` default, invalid retrieval states, corpus evidence without a response-scoped ID, and response evidence ID/reference ID substitution.
- [ ] Regenerate the descriptor-driven contract block using the repository's existing generation command and verify the generated block is byte-identical.

**Acceptance:** `ToolInputSchemas.create_ui_spec` and `ToolResultSchemas.create_ui_spec` describe the approved contract; all existing tool-contract tests remain green; `generate_design_prompt` is not a public catalog name.

### Task 2: Preserve safe evidence for transport adapters

**Files:** `src/create-ui-spec.ts`, `src/create-ui-spec-contracts.ts`, `src/create-ui-spec.test.ts`

- [ ] Introduce the internal `createUiSpecForAdapter()` result path returning `{ envelope, sanitizedEvidence }`, where `envelope` is the existing parsed `DesignArtifactEnvelope` and `sanitizedEvidence` is the already-schema-validated, response-scoped evidence list.
- [ ] Keep `createUiSpec()` as the existing envelope-only public core function, delegating to the internal result path so current callers and identity tests remain compatible.
- [ ] Ensure the adapter-facing evidence rows contain only the approved `SanitizedEvidence` fields. Do not return raw `CorpusEntry` values or diagnostics.
- [ ] Add a single safe projection from internal evidence to the shared MCP `Evidence` rows. The projection must preserve response-scoped IDs, kind, truthful basis, safe summaries, and only safe `publicReference` values.
- [ ] Verify that automatic corpus evidence has no `referenceId`, recipe-system evidence is clearly operator-authored, and explicit public references remain distinguishable from corpus evidence.
- [ ] Add tests that scan the serialized adapter result for private markers, source URLs, corpus IDs, image paths, and product identities while asserting all `publicEvidenceIds` are represented exactly once.

**Acceptance:** Both adapters can obtain the same validated evidence projection without duplicating retrieval, sanitization, assembly, or rendering logic; the persisted artifact envelope remains schema-compatible and unchanged in meaning.

### Task 2a: Make dependency construction and explicit references concrete

**Files:** `src/create-ui-spec-dependencies.ts`, `src/server.ts`, `src/scripts/ui-server.ts`, `src/create-ui-spec-mcp.test.ts`, `src/create-ui-spec-http.test.ts`

- [ ] Export `makeCreateUiSpecDependencies(reader, now?)` as the only adapter dependency constructor.
- [ ] Implement the explicit-reference resolver as `reader.getById(token) !== undefined ? token : undefined`. This explicitly recognizes only IDs already exposed by the current reader/tool surface; it does not accept arbitrary filesystem paths, URLs, or tokens that are absent from the active reader.
- [ ] Never include the accepted token in output or errors. The core continues to hash it into a safe `ref-*` citation and keeps private corpus identity out of public fields.
- [ ] Use the same dependency factory for MCP private/public readers and the operator HTTP server. Add tests proving raw unknown IDs fail, reader-known IDs resolve, and the public reader cannot resolve an ineligible private ID.

**Acceptance:** There is one explicit-reference policy, one resolver implementation, and no adapter can accidentally bypass the core's opaque-reference boundary.

## Phase 2: Implement the MCP Adapter

### Task 3: Add `create_ui_spec` MCP registration

**Files:** `src/create-ui-spec-mcp.ts`, `src/server-factory.ts`

- [ ] Implement `registerCreateUiSpec(server, reader)` using the existing direct `server.registerTool` style.
- [ ] Parse transport input with `CreateUiSpecInput`; map only the core request fields into `createUiSpecForAdapter()` and keep `outputFormat` adapter-local.
- [ ] Obtain dependencies from `makeCreateUiSpecDependencies(reader)` and preserve the producer's no-silent-substitution behavior: unresolved references are omitted only where the core contract permits it, and all-missing references become the typed invalid-input error.
- [ ] Return the standard MCP result with:
  - `data` equal to the validated `UiSpec`, not the artifact envelope;
  - `content[0]` equal to exactly `envelope.designMarkdown` for markdown or `envelope.designJson` for JSON;
  - `referenceIds` equal only to safe `UiSpec.citedReferences`;
  - `evidence` equal to the safe response-scoped evidence projection;
  - retrieval and warnings copied from the parsed envelope without reinterpretation;
  - a bounded summary with no brief, path, URL, corpus ID, or provider diagnostic.
- [ ] Map `INVALID_INPUT` to the existing non-retryable MCP error and `RETRIEVAL_UNAVAILABLE` to the existing retryable provider/retrieval error without exposing raw exception text.
- [ ] Return `isError` consistently for failed calls while preserving the standard error envelope shape used by the repository's contract tests.
- [ ] Register the new beta tool from `createServer()` and remove only the old public registration of `generate_design_prompt`; keep its implementation private for compatibility with internal code.

**Acceptance:** A real MCP client sees `create_ui_spec` in `tools/list`; markdown and JSON calls return the exact core renderings, structured data validates as `UiSpec`, and failures are typed and safe.

### Task 4: Prove MCP behavior end to end

**Files:** `src/create-ui-spec-mcp.test.ts`, `src/public-mcp-contract.test.ts`, `src/mcp-smoke.test.ts`, `src/wiring-verification.test.ts`

- [ ] Use `InMemoryTransport` and a fixture `CorpusReader` to test the actual registered tool, not a direct adapter function only.
- [ ] Cover automatic keyword results: `keyword/metadata`, truthful result count, response-scoped evidence, and safe output.
- [ ] Cover zero matches: `structured-fallback/metadata`, `fallbackUsed: true`, `fallbackReason: "no-results"`, attempted mode `keyword`, and the deterministic fallback warning.
- [ ] Cover explicit references: `none/none`, bounded reference handling, safe public reference IDs, and no automatic replacement of missing identities.
- [ ] Cover both `outputFormat` values and assert byte equality with `envelope.designMarkdown`/`envelope.designJson` from the same producer invocation.
- [ ] Cover invalid input and reader failure, asserting safe error messages, retryability, no raw exceptions, and no leaked request text.
- [ ] Run the public-reader marker suite with `create_ui_spec` included and assert private/unapproved IDs and marker prose never occur in either `content` or `structuredContent`.
- [ ] Update smoke expectations to the exact approved public set: keep the current 14-tool total, replace public `generate_design_prompt` with public `create_ui_spec`, and assert `generate_design_prompt` is absent from `tools/list`.

**Acceptance:** MCP contract tests prove the same producer is used for both renderings and all retrieval states; public mode has no leak; compiled-server smoke passes without credentials or network access.

## Phase 3: Add the Local User-Test Surface

### Task 5: Add the loopback HTTP adapter

**Files:** `src/create-ui-spec-http.ts`, `src/create-ui-spec-http.test.ts`, `src/scripts/ui-server.ts`, `src/scripts/ui-server.test.ts`, `ui/app.js`, `ui/classic-app.js`

- [ ] Route the handler through `src/create-ui-spec-http.ts` and `makeCreateUiSpecDependencies(new PrivateCorpusReader())`; do not create a second corpus loader or bypass the injected `CorpusReader` for the HTTP route.
- [ ] Add `POST /api/create-ui-spec` with the core request fields and no `outputFormat` field; HTTP returns exactly the parsed safe `DesignArtifactEnvelope` with both renderings and response-scoped evidence IDs.
- [ ] Add `GET /api/csrf` for an allowed same-origin caller. Generate a process-local cryptographically random nonce, keep it only in memory, and invalidate it on process restart.
- [ ] Require `X-Clean-UI-CSRF` on every mutating `/api/*` request, including existing curator POST/PUT/PATCH/DELETE routes and the new C3 route. Reject missing or incorrect nonces before reading or mutating a request body.
- [ ] Update `ui/app.js`, `ui/classic-app.js`, and the relevant HTTP tests to fetch/cache the nonce and send it on every mutation. Preserve non-browser callers only where the existing route explicitly permits them, and document the test helper that supplies the nonce.
- [ ] Do not accept browser-supplied credentials, cookies, authorization headers, screenshots, or provider configuration for the C3 route.
- [ ] Return bounded, typed JSON errors for invalid input and retrieval failures. Preserve the brief only in the client state, not in server logs or persistent storage.
- [ ] Serve `site/dist` under `/clean-ui-mcp/` when `CLEAN_UI_SITE_DIST` is set, with traversal-safe static resolution and SPA fallback; retain the existing curator UI routes when the variable is absent.
- [ ] Ensure the process binds only to `127.0.0.1`, rejects unexpected origins, and keeps `/api/*` behind the loopback server rather than the static site.
- [ ] Add tests for valid deterministic generation, zero-result fallback, invalid input, unexpected origin, missing/invalid nonce, nonce invalidation after restart, existing curator mutation compatibility, production static serving, and private-marker absence across the complete response.

**Acceptance:** The local API can produce a safe artifact from a product brief with zero network calls, and its response body passes `parseDesignArtifactEnvelope()` without any adapter-added envelope fields.

### Task 6: Build the focused Playground composer

**Files:** `site/vite.config.ts`, `site/src/data/create-ui-spec.ts`, `site/src/pages/PlaygroundPage.tsx`, `site/src/pages/PlaygroundPage.test.tsx`, `site/tests/site-browser.test.ts`, `site/src/app/App.tsx`, `site/src/app/SiteShell.tsx`, `site/src/pages/HomePage.tsx`, `site/src/pages/EvidencePage.tsx`, `site/src/pages/BrowsePage.tsx`, `site/src/pages/BrowsePage.test.tsx`

- [ ] Add a typed same-origin API client that obtains the CSRF nonce, submits the brief, and treats the server response as untrusted until the expected response shape is checked.
- [ ] Implement the focused flow from the approved design: idle, generating, success, partial/fallback success, failure, retry, download markdown, download JSON, copy markdown, and start over.
- [ ] Include the required brief minimum, optional platform/framework/design-system/constraints controls, and a collapsed advanced reference override. Keep generation disabled until the brief is valid.
- [ ] Display only safe result content: design direction, key decisions, acceptance criteria, warnings, and an aggregate evidence summary derived from response-scoped counts/retrieval metadata. Never display private IDs, source identities, screenshots, paths, or raw corpus text.
- [ ] Use real lifecycle labels and `aria-live`; disable duplicate submits while generating; preserve the brief on recoverable failure.
- [ ] Make keyboard operation complete, visible focus explicit, and mobile layout stable. Downloads must use the exact bytes and hashes returned by the API, without a second generation request.
- [ ] Configure the Vite development proxy to the loopback API while keeping production serving on the same operator-controlled process.
- [ ] Move the current search-oriented Playground implementation to `/browse` without changing its search, filters, query-string, or evidence-detail behavior. `/playground` becomes the focused C3 composer; update Home, shell navigation, Evidence back-links, and component tests accordingly.
- [ ] Add browser tests for idle validation, generation, fallback, downloads, retry, visible focus, mobile layout, and serialized private-marker absence.

**Acceptance:** An operator can open the local Playground, enter a brief, receive a deterministic result, download both handoffs, and retry safely without private corpus data entering the browser.

## Phase 4: Verification and Dogfood Gate

### Task 7: Run the complete offline verification sequence

- [ ] Run focused contract and producer tests:

```bash
npm test -- src/tool-contracts.test.ts src/tool-contract-docs.test.ts src/tool-catalog.test.ts src/create-ui-spec.test.ts src/create-ui-spec-contracts.test.ts src/create-ui-spec-mcp.test.ts src/create-ui-spec-http.test.ts
```

- [ ] Run MCP/public boundary and browser tests:

```bash
  npm test -- src/public-mcp-contract.test.ts src/mcp-smoke.test.ts src/wiring-verification.test.ts src/scripts/ui-server.test.ts
npm run site:test
```

- [ ] Run typecheck, build, and generated-contract validation:

```bash
npm run typecheck:contracts
npm run build
npm run site:build
```

- [ ] Run readiness validation from fresh public state:

```bash
npm run validate-readiness-artifacts -- --mode public --json
```

  Record any existing non-blocking C2 external-QA warning separately; do not reinterpret it as a C3 implementation failure.

- [ ] Dogfood the local process with the exact approved command:

```bash
CLEAN_UI_SITE_DIST=site/dist npm run ui
```

  Verify the Playground and `/api/create-ui-spec` are served by that loopback process, with the build SHA, reader mode, provider state, and zero-network result recorded in the handoff note.

- [ ] Run the production browser suite against the loopback `npm run ui` process, not only Vite preview, and assert `/clean-ui-mcp/playground` loads the composer while `/clean-ui-mcp/browse` preserves search.

  Use `npm run site:test:browser` for the built-site browser checks and add a production-server fixture/command for the same assertions; Vite preview alone is insufficient evidence for the loopback serving requirement.

- [ ] Verify the compiled MCP server exposes the approved tool set and that a deterministic `create_ui_spec` call succeeds with no API keys configured.
- [ ] Review the final diff for accidental changes to ignored/private C2 evidence, credentials, generated artifacts, unrelated UI flows, or legacy tool behavior.

## Definition of Done

- `create_ui_spec` is a real public MCP beta tool with no `generate_design_prompt` public alias.
- MCP markdown and JSON outputs are the exact bytes produced by the shared parsed artifact envelope.
- The MCP structured `data` is the validated `UiSpec`; the standard envelope carries safe references, response-scoped evidence, truthful retrieval, warnings, and typed errors.
- The HTTP route returns the same producer's safe artifact envelope and both handoffs.
- The Playground is usable by keyboard and on mobile, handles fallback/error/retry states, and does not expose private corpus material.
- Existing MCP tools, public reader isolation, C2 readiness gates, and default offline behavior remain intact.
- Focused tests, full tests, typecheck, build, site build/tests, readiness validation, and local dogfood all pass.
- No paid campaign, live provider call, external reviewer action, or C2 closure claim is made by this work.

## Explicitly Deferred

- Live model-provider enrichment, provider credentials, prompt/budget policy, and provider-specific resilience.
- Project persistence, immutable revisions, Decision Lab integration, critique integration, hosted multi-user support, uploads, and browser-supplied screenshots.
- Corpus-wide retagging or disposition and any C2 baseline/paid-campaign execution.

## Plan Self-Review

- The approved design's MCP requirements map to Tasks 1–4: exact input/output, `outputFormat`, standard envelope, evidence/reference separation, retrieval matrix, no legacy alias, and in-memory/public boundary tests.
- The approved design's local user-test requirements map to Tasks 5–6: one loopback API, same producer, CSRF/origin checks, focused composer states, downloads, accessibility, mobile, and no private browser output.
- The core-first implementation remains untouched as the behavioral authority; this plan adds only adapters, contract migration, and integration coverage.
- The known evidence-kind mismatch is handled explicitly in Task 1 and Task 2, including compatibility behavior for existing non-response-scoped evidence rows.
- The current search-oriented Playground is preserved at `/browse`; the C3 composer owns `/playground`, so the plan does not silently remove an existing user workflow.
- The current UI server's missing CSRF implementation and old static-serving path are covered in Task 5, including existing curator-client updates and production browser verification.
- The plan does not claim C2 closure or authorize paid execution; it only makes the deterministic C3 slice testable offline.
