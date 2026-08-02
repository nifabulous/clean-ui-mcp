# Task 1 Report — pinned text-model endpoints for every provider

Date: 2026-08-01
Worktree: `/Users/olaniyi.oladokun/Downloads/clean-ui-mcp/.worktrees/c3-model-path`
Commit: `ef2521f`

## Scope completed

- Modified `src/tagger.ts`
- Modified `src/c2/model-telemetry.test.ts`
- Added `src/create-ui-spec-model-client.test.ts`

## RED evidence

Command:

```bash
npx vitest run src/c2/model-telemetry.test.ts src/create-ui-spec-model-client.test.ts
```

Observed failure excerpts before the production change:

```text
FAIL  src/create-ui-spec-model-client.test.ts > ... > pins the explicit endpoint for OpenAI-compatible, Claude, and Gemini requests
AssertionError: expected 'ambient-anthropic-key' to be 'request-key'
```

```text
FAIL  src/create-ui-spec-model-client.test.ts > ... > makes one failed pinned request without switching provider or model
AssertionError: expected false to be true
```

```text
FAIL  src/create-ui-spec-model-client.test.ts > ... > rejects a pinned Claude seed because the provider cannot honor it
AssertionError: expected [Function] to throw error matching /seed/i but got 'fetch should not run'
```

```text
FAIL  src/c2/model-telemetry.test.ts > ... > honors endpoint.apiKey for Claude when the request pins explicit credentials
AssertionError: expected 'anthropic-test' to be 'caller-supplied-key'
```

Interpretation:

- Claude still preferred ambient credentials over the explicit request key.
- Gemini still ignored the explicit pinned base URL.
- Claude silently dropped `seed` instead of rejecting it.

## GREEN evidence

Focused command:

```bash
npx vitest run src/c2/model-telemetry.test.ts src/create-ui-spec-model-client.test.ts
```

Focused result:

```text
Test Files  2 passed (2)
Tests  23 passed (23)
Duration  1.26s
```

Build / broader gate:

```bash
npm run build
```

Build result:

```text
check-public-site-boundary: PASS
validate:c2-pilot: manifest up to date
validate:c2-label-selection:schema: OK
validate:c2-baseline: OK
validate:c2-baseline-cases: All 22 baseline case packages passed
generate-references: completed
exit code: 0
```

## Implementation summary

- Extended `ProviderCallOptions` with `apiKeyOverride`, `baseUrlOverride`, `temperatureOverride`, and `seedOverride`.
- Extended `TextModelRequest` with optional `temperature` and `seed`.
- Threaded explicit `endpoint.apiKey` and `endpoint.baseUrl` through the Claude and Gemini native call paths.
- Preserved `undefined` base URL behavior via `??`, so omitted native base URLs still use their existing defaults.
- Made blank explicit native API keys fail closed before any provider request succeeds with a blank credential.
- Rejected pinned Claude `seed` values instead of silently dropping them.
- Added focused tests for OpenAI-compatible, Claude, and Gemini request pinning plus the no-fallback failure case.

## Self-review

- The change stays additive to the production dispatch path: legacy `callTextModel` / `callModel` callers still fall back to provider env/default behavior when they do not supply explicit endpoint overrides.
- The explicit C2-style path now pins credentials and base URLs for native providers the same way it already pinned model names and retry budgets.
- I changed one existing C2 telemetry assertion because this branch still encoded the old ambient-key Claude behavior; the new assertion now matches the task brief's required contract.

## Concerns

- None blocking. The only notable wrinkle is the existing C2 test that had to be updated from the pre-task ambient-key expectation to the new explicit-pin contract.

---

# Task 1 Follow-up Fix Report — fail closed for missing native C2 credentials

Date: 2026-08-01
Fix commit: `6c982ee`

## Scope completed

- Modified `src/tagger.ts`
- Modified `src/create-ui-spec-model-client.test.ts`
- Preserved the approved C2 Claude assertion change in `src/c2/model-telemetry.test.ts` without changing any other existing C2 assertion

## RED evidence

Command:

```bash
npx vitest run src/c2/model-telemetry.test.ts src/create-ui-spec-model-client.test.ts
```

Observed failure excerpts before the production fix:

```text
FAIL  src/create-ui-spec-model-client.test.ts > ... > fails closed on a missing explicit Claude apiKey without sending a request
AssertionError: expected [Function] to throw error matching /api|key|ANTHROPIC/i but got 'fetch should not run'
```

```text
FAIL  src/create-ui-spec-model-client.test.ts > ... > fails closed on a missing explicit Gemini apiKey without sending a request
AssertionError: expected [Function] to throw error matching /api|key|GEMINI/i but got 'fetch should not run'
```

Interpretation:

- `callTextModelWithMetadata` still allowed the native Claude/Gemini branch to fall back to ambient credentials when the explicit request omitted `endpoint.apiKey`.
- That violated the approved C2 contract for the explicit path.

## GREEN evidence

Focused command:

```bash
npx vitest run src/c2/model-telemetry.test.ts src/create-ui-spec-model-client.test.ts
```

Focused result:

```text
Test Files  2 passed (2)
Tests  25 passed (25)
Duration  1.28s
```

Build / broader gate:

```bash
npm run build
```

Build result:

```text
check-public-site-boundary: PASS
validate:c2-pilot: manifest up to date
validate:c2-label-selection:schema: OK
validate:c2-baseline: OK
validate:c2-baseline-cases: All 22 baseline case packages passed
generate-references: completed
exit code: 0
```

## Implementation summary

- Tightened `callTextModelWithMetadata` so every provider in the explicit C2 path requires `endpoint.apiKey`.
- Removed native-provider ambient fallback from the explicit path while leaving legacy non-C2 callers unchanged.
- Strengthened the no-ambient-leak assertions to check the concrete seeded ambient values directly.
- Added focused missing-key coverage for both Claude and Gemini, asserting failure before `fetch`.

## Self-review

- The fix is closely scoped to the explicit C2 entry point; it does not change legacy `callTextModel` ambient behavior.
- The approved C2 Claude assertion remains intact, and no other existing C2 assertion changed.
- The new tests now cover both the “ambient values do not leak into requests” and “missing native explicit credentials fail before fetch” cases.

## Concerns

- None blocking.
