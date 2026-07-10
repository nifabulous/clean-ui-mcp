# Per-Call Endpoint Override + CLI Eval Matrix

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-call endpoint-config override (`{provider, baseUrl, apiKey, model}`) to the tagger, then extend the existing CLI eval baseline with a deterministic provider/model matrix. This answers the concrete project question — which provider/model/base-URL combo performs best on the fixed eval set — without adding a new dependency or a second execution surface.

**Scope of "deterministic" this milestone:** The endpoint-config override is structurally OpenAI-compatible-only — it threads through `callModel` → `callOpenAI` → `openaiConfigForPass`, which is the path DeepSeek/GPT/MiniMax all share. OpenAI-compatible lanes are fully pinned (`{provider, baseUrl, apiKey, model}`). Non-OpenAI providers (Claude, Gemini) are **provider-pinned but NOT model-pinned** this milestone — their model still resolves from env (`CLAUDE_AUTO_TAG_MODEL`, `GEMINI_AUTO_TAG_MODEL`) because `callClaude`/`callGemini` don't have the same config-override path yet. So the matrix has two comparison classes: (1) fully-pinned OpenAI-compatible lanes (reproducible across machines/time), and (2) provider-only lanes (reproducible only if you also pin the model env var). The plan documents this distinction explicitly rather than over-promising determinism for Claude/Gemini rows. Extending the override to those providers is a follow-up if those comparisons need model-pinning.

**What changed from the first draft (Promptfoo → CLI matrix):** The original plan added a full Promptfoo harness (custom provider, YAML configs, JS assertion DSL, new npm dep). An engineering review + independent outside-voice challenge found that Promptfoo is a presentation layer over a capability (per-call endpoint override) the tagger doesn't yet expose, and that its scoring would just call the same `scoreExtraction`/`scoreCritique` functions the existing CLI already runs. The revised plan ships the actual capability gap first, then uses the existing CLI to answer the DeepSeek V4 Pro decision. Promptfoo is explicitly deferred to a follow-up milestone if the CLI matrix proves insufficient.

**Architecture:** The tagger's provider/model selection is env-driven via `openaiConfigForPass(pass)` which reads `process.env`. There is no per-call override that reaches the config-reading layer — the existing `extractionProvider`/`critiqueProvider` overrides select a provider *name* (a switch arm in `callModel`), not a config *triple*. This plan adds an `OpenAIConfig` override that threads through `callModel` → `callOpenAI`, bypasses peak-hour routing, and lets the eval harness pin exact endpoints per run. The CLI matrix then loops over a config array, emitting one baseline artifact per provider triple.

```
BEFORE (env-driven, no per-call config override):

  tagImage({ extractionProvider?: Provider })
    └─ callModel(pass, ..., providerOverride)
         └─ resolveProvider(pass, override) → "openai"
              └─ callOpenAI(prompt, image, ..., pass)
                   └─ openaiConfigForPass(pass)  ← reads process.env, no override reaches here
                        └─ { baseUrl, apiKey, model } from env vars


AFTER (per-call endpoint-config override):

  tagImage({ extractionOverride?: EndpointOverride })
    └─ callModel(pass, ..., providerOverride, cfgOverride?)
         └─ resolveProvider(pass, override, cfgOverride) → "openai"   ← bypasses peak-hour swap
              └─ callOpenAI(prompt, image, ..., pass, cfg?)            ← new cfg? param
                   └─ cfg ?? openaiConfigForPass(pass)                 ← override wins, env is default
                        └─ { baseUrl, apiKey, model }


EVAL MATRIX (CLI, no Promptfoo):

  npm run eval-matrix -- --configs matrix/openai.json,matrix/deepseek.json,matrix/claude.json
    └─ for each config triple:
         run 15-image eval with pinned {provider, baseUrl, apiKey, model}
         emit eval/baseline-{config-name}.json
         print per-config summary row
    └─ print comparison table across all configs
```

**Tech Stack:** TypeScript, Vitest, existing `src/tagger.ts` pipeline, existing `scripts/eval-*.mjs` modules (kept as `.mjs` — no TS migration this milestone).

## Global Constraints

- **Capability-first:** the per-call endpoint override (Task 2) is the load-bearing change. The CLI matrix (Task 3) depends on it. Do not start Task 3 until Task 2 ships and its tests pass.
- **Determinism over production mirroring:** eval runs must be deterministic. Peak-hour routing (DeepSeek→MiniMax auto-swap) is a production feature, NOT an eval feature. Every eval mode pins explicit configs and bypasses peak-hour routing. Production tagging keeps peak-hour routing unchanged.
- **Keep `.mjs`:** the existing `scripts/eval-set.mjs` and `scripts/eval-scorer.mjs` stay as `.mjs`. No TS migration, no `src/eval/*.ts` extraction this milestone. The regex DRY violation (scorer copies of tagger sanitizer regexes) is deferred to a separate cleanup commit.
- **No new dependencies:** no Promptfoo, no new npm packages this milestone. The CLI matrix uses only the existing eval infrastructure.
- **Preserve raw-output scoring:** `_raw.extraction` and `_raw.critique` stay the scored layer. The scorer counts what the model TRIED to emit before gates caught it — this non-circular contract is unchanged.
- **Don't touch unrelated work:** the working tree has in-flight Decision Lab and UI-server changes. This milestone touches only `src/tagger.ts`, `src/tagger.test.ts`, `scripts/eval-*.mjs`, `package.json`, `README.md`, and `ROADMAP.md`.

---

## File Structure

- Create: `scripts/eval-runner.mjs` — shared orchestration extracted from `eval-baseline.mjs` (single-image eval case + scoring, callable by both the CLI baseline and the matrix loop)
- Create: `scripts/eval-matrix.mjs` — CLI matrix runner: loops over config triples, emits per-config baselines, prints comparison table
- Modify: `src/tagger.ts` — add `OpenAIConfig` override plumbing (new `cfg?` param on `callOpenAI`, 8th param on `callModel`, `extractionOverride`/`critiqueOverride` on `TaggerInput`, peak-hour bypass for config overrides)
- Modify: `src/tagger.test.ts` — tests for the endpoint-config override (4 cases: default-env fallback, DeepSeek config reaches critique, per-pass independence, no leak)
- Modify: `scripts/eval-baseline.mjs` — pin explicit configs (bypass peak-hour routing), consume `eval-runner.mjs` for shared orchestration
- Modify: `package.json` — add `eval-matrix` script
- Modify: `README.md` — document baseline-vs-matrix split, deterministic-eval rationale
- Modify: `ROADMAP.md` — move "provider/model matrix" from deferred to shipped; keep Promptfoo + ScreenSpot IoU deferred

**NOT created (deferred):** `promptfoo/` directory, custom provider/assertion modules, YAML configs. No `src/eval/*.ts` migration.

---

### Task 1: Extract Shared Eval Orchestration Without Changing Behavior

**Files:**
- Create: `scripts/eval-runner.mjs`
- Modify: `scripts/eval-baseline.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `tagImage`, `generateCritique` from `dist/tagger.js`; `EVAL_SET`, `scoreExtraction`, `scoreCritique`, `summarizeScores` from existing `.mjs` modules
- Produces:
  - `runEvalCase(input: EvalCaseInput): Promise<EvalCaseResult>` — single-image eval (extraction + optional critique), scored
  - `EvalCaseInput`: `{ imagePath, productName, platform, goldPatternType, runCritique, extractionOverride?, critiqueOverride? }`
  - `EvalCaseResult`: `{ imageId, goldPatternType, platform, extractionModel, extractionLatencyMs, extraction: Score, critique: Score | null, critiqueLatencyMs, error? }`

- [ ] **Step 1: Write characterization tests for the scorer**

Before extracting anything, lock the current scorer behavior so the extraction can't drift silently. The existing `eval-scorer.mjs` has no tests. Add a `scripts/eval-scorer.test.mjs` (or `.test.ts` if the vitest config picks up `scripts/`) that covers:

```js
// scripts/eval-scorer.test.mjs
import { describe, expect, it } from "vitest";
import { scoreExtraction, scoreCritique, summarizeScores } from "./eval-scorer.mjs";

describe("scoreExtraction", () => {
  it("scores patternType correctness against the gold label", () => {
    const score = scoreExtraction({ patternType: "pricing" }, "pricing");
    expect(score.patternTypeCorrect).toBe(true);
    expect(score.patternTypeRaw).toBe("pricing");
  });
  it("counts icon-only hallucinations in raw prose", () => {
    const score = scoreExtraction({ patternType: "dashboard", typographyNotes: "icon-only button with no label" }, "dashboard");
    expect(score.iconOnlyRaw).toBeGreaterThan(0);
  });
  it("returns zeros for null/undefined input", () => {
    expect(scoreExtraction(null, "pricing")).toMatchObject({ patternTypeCorrect: false, iconOnlyRaw: 0, pixelRaw: 0, bannedPhrasesRaw: 0 });
  });
});

describe("scoreCritique", () => {
  it("counts banned phrases + a11y risks + critique word count", () => {
    const score = scoreCritique({ draftCritique: "clean layout, nice typography", draftAccessibilityRisks: [{ risk: "x" }] });
    expect(score.bannedPhrasesRaw).toBe(2);
    expect(score.a11yRiskCount).toBe(1);
    expect(score.critiqueWords).toBe(4);
  });
});

describe("summarizeScores", () => {
  it("preserves the existing baseline metric math", () => {
    expect(
      summarizeScores(
        [{ patternTypeCorrect: true, iconOnlyRaw: 1, bannedPhrasesRaw: 0 }],
        [{ bannedPhrasesRaw: 2, iconOnlyRaw: 0, pixelRaw: 0, a11yRiskCount: 1, critiqueWords: 42 }],
      ),
    ).toMatchObject({ patternTypeAccuracy: 1, avgIconOnlyRaw: 1, avgBannedPhrasesRaw: 2, avgCritiqueWords: 42 });
  });
});
```

These protect `scoreExtraction` and `scoreCritique` — the two functions the original plan left unguarded.

- [ ] **Step 2: Run tests to verify they pass against current behavior**

Run: `npx vitest run scripts/eval-scorer.test.mjs -v`
Expected: PASS (characterization — locking current behavior, not testing new code)

- [ ] **Step 3: Extract `runEvalCase` into `scripts/eval-runner.mjs`**

Pull the single-image eval logic (lines 70-133 of `eval-baseline.mjs`) into a reusable `runEvalCase` function in `scripts/eval-runner.mjs`. This is the extraction pass + optional critique pass + scoring, returning an `EvalCaseResult`. The orchestrator (image iteration, summary, baseline write/diff) stays in `eval-baseline.mjs`.

Implementation notes:
- `runEvalCase` accepts optional `extractionOverride` and `critiqueOverride` (the `OpenAIConfig` triples from Task 2) and forwards them to `tagImage`/`generateCritique`. For Task 1 these are `undefined` — Task 2 adds the override support to the tagger, Task 3 uses it in the matrix.
- `eval-baseline.mjs` imports `runEvalCase` from `eval-runner.mjs` and calls it in its image loop.
- Keep CLI output and `baseline.json` shape identical so existing diffs remain comparable.
- The auth/quota short-circuit (line 129 of current `eval-baseline.mjs`) stays in the orchestrator, not in `runEvalCase` — it's a process-level decision, not a per-image one.

- [ ] **Step 4: Run focused verification**

Run: `npm run build`
Expected: PASS

Run: `npm run eval-baseline -- --images 2 --extraction-only`
Expected: PASS with the same summary fields and baseline/diff behavior as before

Run: `npx vitest run scripts/eval-scorer.test.mjs -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add scripts/eval-runner.mjs scripts/eval-baseline.mjs scripts/eval-scorer.test.mjs package.json
git commit -m "refactor(eval): extract shared runner, add scorer characterization tests"
```

---

### Task 2: Add Per-Call Endpoint-Config Override To The Tagger

This is the load-bearing task. The existing `extractionProvider`/`critiqueProvider` overrides select a provider *name* — they do not reach `openaiConfigForPass`, which reads `process.env` directly. DeepSeek V4 Pro is a different endpoint (NVIDIA NIM or DeepSeek's own API), not just a different model on the same endpoint. This task adds the `OpenAIConfig` triple override that reaches the config-reading layer.

**Files:**
- Modify: `src/tagger.ts`
- Modify: `src/tagger.test.ts`

**Interfaces:**
- Consumes: existing `openaiConfigForPass`, `callOpenAI`, `callModel`, `resolveProvider`, `tagImage`, `generateCritique`
- Produces:
  - `type EndpointOverride = { provider: Provider; baseUrl?: string; apiKey?: string; model?: string }`
  - `TaggerInput["extractionOverride"]?: EndpointOverride`
  - `TaggerInput["critiqueOverride"]?: EndpointOverride`
  - New `cfg?` param on `callOpenAI`
  - New 8th param `cfgOverride?` on `callModel`

**Threading path (the part the review corrected):**

```
tagImage({ extractionOverride?: EndpointOverride })
  └─ callModel(pass, ..., providerOverride, cfgOverride?)         ← new 8th param
       └─ resolveProvider(pass, override, cfgOverride) → provider  ← bypass peak-hour when cfgOverride set
            └─ callOpenAI(prompt, image, ..., pass, cfg?)          ← new cfg? param
                 └─ cfg ?? openaiConfigForPass(pass)               ← override wins, env is default
```

- [ ] **Step 1: Write the failing tests**

```ts
// src/tagger.test.ts — add to the existing "tagImage two-pass request shape" describe block

describe("endpoint-config override", () => {
  it("uses default env config when no override is passed", async () => {
    // tagImage with no extractionOverride → fetch call uses OPENAI_BASE_URL / OPENAI_AUTO_TAG_MODEL from env
    // assert the resolved baseUrl/model in the fetch mock match the env defaults
  });

  it("routes critique to the overridden endpoint config (DeepSeek via NIM)", async () => {
    // tagImage with critiqueOverride: { provider: "openai", baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: "nvapi-test", model: "deepseek-ai/deepseek-v4-pro" }
    // assert the critique fetch call hits the NIM base URL with the DeepSeek model
    // assert extraction still uses env defaults (per-pass independence)
  });

  it("extraction and critique can use different overrides independently", async () => {
    // extractionOverride: real OpenAI, critiqueOverride: NIM/DeepSeek
    // assert extraction fetch → OpenAI base URL + gpt model
    // assert critique fetch → NIM base URL + deepseek model
  });

  it("does not leak the override into subsequent calls with no override", async () => {
    // call tagImage with override, then call tagImage without override
    // assert the second call reverts to env defaults (no stale config)
  });

  it("bypasses peak-hour routing when a config override is set", async () => {
    // set env so peak-hour routing would swap DeepSeek→MiniMax
    // pass critiqueOverride for DeepSeek
    // assert the call still hits DeepSeek, not MiniMax
  });

  it("rejects a malformed config with a clear error before reaching callOpenAI", async () => {
    // pass critiqueOverride with missing required fields (e.g. { provider: "openai", baseUrl: undefined, apiKey: "", model: "" })
    // assert tagImage throws a validation error naming the bad field
    // assert no fetch call is made (fail fast at the boundary, not inside the HTTP call)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/tagger.test.ts -t "endpoint-config override" -v`
Expected: FAIL — `TaggerInput` and `callModel` have no endpoint-config override

- [ ] **Step 3: Implement the override plumbing**

Implementation notes (follow the order — each layer depends on the previous):

1. **`callOpenAI`** (`tagger.ts`, currently ~7 params, internally calls `openaiConfigForPass(pass)`): add a `cfg?: OpenAIConfig` param. When provided, use `cfg` instead of `openaiConfigForPass(pass)`. When `undefined`, fall back to `openaiConfigForPass(pass)` — byte-for-byte current behavior.

2. **`callModel`** (`tagger.ts:1974`): add an 8th param `cfgOverride?: OpenAIConfig`. In the `openai` branch, pass it to `callOpenAI`. Other branches (claude/gemini/mistral/minimax/grok) ignore it — endpoint-config override only applies to the OpenAI-compatible path where DeepSeek lives. (If later needed for other OpenAI-compatible providers, extend then.)

3. **`resolveProvider`** (`tagger.ts:594`): the peak-hour bypass currently keys off `!override` where `override` is a `Provider`. Add awareness: when a `cfgOverride` is present, bypass peak-hour routing (the caller chose an endpoint deliberately). Minimal change: thread a `hasConfigOverride: boolean` or check the override presence.

4. **`TaggerInput`** (`tagger.ts:115`): add `extractionOverride?: EndpointOverride` and `critiqueOverride?: EndpointOverride`. Resolve these into `{ provider, cfg }` and forward to `callModel` at the 6 extraction/critique call sites (`tagger.ts:2052, 2076, 2108` for extraction; `2249, 2278` for critique).

5. **`generateCritique`** (`tagger.ts:2373`): add a `critiqueOverride?: EndpointOverride` param, forward to its `buildCritiquePrompt`/`callModel` sites (`2406, 2424`).

6. **`_raw` metadata** (`tagger.ts:2225` extractionOnly, `2351` full): record the resolved `extractionModel`/`critiqueModel` from the override (or env default) so eval results are traceable to the exact endpoint used.

7. **Config-shape validation at the boundary** (the matrix runner's primary input is these config files — malformed input must fail fast with a named-field error, not produce a confusing runtime failure inside the HTTP call). Add a `validateEndpointOverride(cfg)` function that checks: `provider` is a valid `Provider` enum member; for OpenAI-compatible providers, `apiKey` and `model` are non-empty strings (baseUrl may be empty = real OpenAI). Throw a descriptive error naming the bad field. Call it in `tagImage`/`generateCritique` before forwarding to `callModel`. The test in Step 1 ("rejects a malformed config") guards this.

8. **`"default"` is byte-for-byte current behavior** — every code path where the override is `undefined` must produce identical output to today. This is non-negotiable; the existing 219 tests must pass unchanged.

- [ ] **Step 4: Run focused verification**

Run: `npx vitest run src/tagger.test.ts -t "endpoint-config override" -v`
Expected: PASS

Run: `npm test -- --runInBand`
Expected: PASS (including all existing tests — the override must be additive)
Note: the `activeModelName per-pass resolution` test (`tagger.test.ts:538`) is known env/time-sensitive. If it flakes, investigate whether it's the pre-existing peak-hour/MINIMAX leak (not caused by this change) before proceeding.

- [ ] **Step 5: Commit**

```bash
git add src/tagger.ts src/tagger.test.ts
git commit -m "feat(tagger): add per-call endpoint-config override for eval matrix"
```

---

### Task 3: Add The CLI Eval Matrix

**Files:**
- Create: `scripts/eval-matrix.mjs`
- Modify: `scripts/eval-baseline.mjs` — pin explicit configs (bypass peak-hour routing)
- Modify: `package.json` — add `eval-matrix` script

**Interfaces:**
- Consumes: `runEvalCase` from `scripts/eval-runner.mjs`, `EVAL_SET` from `scripts/eval-set.mjs`
- Produces: `npm run eval-matrix -- --configs <comma-separated-config-files>` → one `eval/baseline-{name}.json` per config + a printed comparison table

**Config file shape** (JSON, one per endpoint). Two classes, documented explicitly:

Class 1 — **fully-pinned OpenAI-compatible lanes** (reproducible across machines/time):

```json
// eval/configs/openai-gpt54.json
{
  "name": "openai-gpt54",
  "extraction": { "provider": "openai", "baseUrl": "", "apiKey": "${OPENAI_API_KEY}", "model": "gpt-5.4-mini" },
  "critique":   { "provider": "openai", "baseUrl": "", "apiKey": "${OPENAI_API_KEY}", "model": "gpt-5.4-mini" }
}

// eval/configs/deepseek-nim.json
{
  "name": "deepseek-nim",
  "extraction": { "provider": "openai", "baseUrl": "", "apiKey": "${OPENAI_API_KEY}", "model": "gpt-5.4-mini" },
  "critique":   { "provider": "openai", "baseUrl": "https://integrate.api.nvidia.com/v1", "apiKey": "${OPENAI_API_KEY_CRITIQUE}", "model": "deepseek-ai/deepseek-v4-pro" }
}
```

Class 2 — **provider-only lanes** (provider is pinned, model resolves from env — NOT model-pinned this milestone):

```json
// eval/configs/claude.json — model comes from CLAUDE_AUTO_TAG_MODEL env var
{
  "name": "claude",
  "extraction": { "provider": "claude" },
  "critique":   { "provider": "claude" },
  "modelPinned": false   // explicit flag: this lane is NOT model-reproducible across envs
}
```

The `modelPinned` field makes the comparison-class distinction machine-readable: the matrix runner stamps each baseline artifact with `modelPinned: true|false`, and the comparison table groups fully-pinned lanes separately from provider-only lanes. To make a Claude/Gemini lane model-pinned, set the model env var before the run (documented in README) — the follow-up to extend the override path to those providers is out of scope this milestone.

- [ ] **Step 1: Make eval-baseline pin explicit configs**

Update `scripts/eval-baseline.mjs` so that every run resolves explicit `extractionOverride`/`critiqueOverride` (from env, resolved once at startup) and passes them to `runEvalCase`. This bypasses peak-hour routing in the eval path — eval runs are deterministic regardless of wall-clock time. Production tagging (the MCP server, `tag-image` CLI, bulk-import) keeps peak-hour routing unchanged.

The config override here is constructed from env at startup — same endpoints as today, but explicitly pinned rather than rediscovered per call. `baseline.json` records the pinned `extractionModel`/`critiqueModel`/`baseUrl` in its header.

- [ ] **Step 2: Write the matrix runner**

`scripts/eval-matrix.mjs`:
- Reads a comma-separated list of config files from `--configs`
- For each config: runs the full 15-image eval (via `runEvalCase` with that config's overrides), writes `eval/baseline-{config-name}.json`, collects the summary row
- Prints a comparison table across all configs: `patternTypeAccuracy`, `avgIconOnlyRaw`, `avgBannedPhrasesRaw`, `avgCritiqueWords`, `avgExtractionLatencyMs`, `errorCount`
- If a config's API key is missing, skip that config with a clear message (do NOT silently reroute to another provider — that would defeat the pinning)

~40-60 lines of orchestration over the existing `runEvalCase`.

- [ ] **Step 3: Run focused verification**

Run: `npm run build`
Expected: PASS

Run: `npm run eval-baseline -- --images 2 --extraction-only`
Expected: PASS, deterministic (pinned config, no peak-hour swap)

Run: `npm run eval-matrix -- --configs eval/configs/openai-gpt54.json`
Expected: PASS, writes `eval/baseline-openai-gpt54.json`, prints summary

- [ ] **Step 4: Commit**

```bash
git add scripts/eval-matrix.mjs scripts/eval-baseline.mjs eval/configs/*.json package.json
git commit -m "feat(eval): add CLI provider/model matrix with pinned configs"
```

---

### Task 4: Document Baseline vs Matrix + Deterministic Eval Rationale

**Files:**
- Modify: `README.md`
- Modify: `ROADMAP.md`

- [ ] **Step 1: Write the documentation delta**

README updates:
- `npm run eval-baseline` remains the deterministic regression contract — now pins explicit configs and bypasses peak-hour routing so `--diff` comparisons are stable across wall-clock time
- `npm run eval-matrix` runs comparison matrices across provider/model/base-URL triples; emits one `baseline-{name}.json` per config and a comparison table
- Both use the same scorer (`scoreExtraction`/`scoreCritique`) — no parallel truth model
- `--diff` remains the quickest single-run regression check
- Missing API keys cause a clean skip, not a silent reroute — the matrix only compares configs that are actually runnable
- Why eval bypasses peak-hour routing: determinism. Production keeps it.

ROADMAP updates:
- Move "provider/model matrix (CLI)" from deferred to shipped
- Keep "Promptfoo harness" deferred — revisit once the CLI matrix has been used to settle the DeepSeek decision; only add if the CLI proves insufficient for ongoing prompt/variant experimentation
- Keep ScreenSpot IoU and token-usage capture deferred

- [ ] **Step 2: Verify docs match the code**

Run: `rg -n "eval-baseline|eval-matrix|peak.hour|provider matrix|--diff" README.md ROADMAP.md`
Expected: all references agree on commands, scope, and the deterministic-eval rationale

- [ ] **Step 3: Commit**

```bash
git add README.md ROADMAP.md
git commit -m "docs(eval): document CLI matrix and deterministic-eval rationale"
```

---

### Task 5: Full Verification And Handoff

**Files:**
- No new files; verification only

- [ ] **Step 1: Run the verification suite**

Run: `npm run build`
Expected: PASS

Run: `npm run validate-corpus`
Expected: PASS

Run: `npm test`
Expected: PASS (including the endpoint-override tests from Task 2 and the scorer characterization tests from Task 1). Note the known env/time-sensitive `activeModelName per-pass resolution` test — if it flakes, confirm it's the pre-existing peak-hour/MINIMAX vector, not this change.

Run: `npm run eval-baseline -- --images 5 --diff`
Expected: PASS with no regression. Deterministic — same result regardless of wall-clock time (peak-hour routing bypassed in eval path).

Run: `npm run eval-matrix -- --configs eval/configs/openai-gpt54.json,eval/configs/deepseek-nim.json`
Expected: PASS (or clean skip for deepseek-nim if its key isn't set), with a comparison table

- [ ] **Step 2: Record known non-goals**

Not in this milestone:
- Promptfoo harness (deferred — revisit after CLI matrix settles the DeepSeek decision)
- Blocking CI enforcement for eval
- ScreenSpot/IoU scoring
- Token accounting / spend dashboards
- Automatic prompt search or optimizer loops
- promptProfile / prompt-variant comparison (the strict-wcag profile is redundant with the output sanitizer at `tagger.ts:1185`; prompt variants are deferred until there's a concrete variant to test)
- Regex DRY fix (eval-scorer.mjs copies of tagger.ts sanitizer regexes) — separate cleanup commit

- [ ] **Step 3: Final commit if verification required doc/code touchups**

```bash
git add README.md ROADMAP.md package.json src/tagger.ts src/tagger.test.ts scripts/eval-baseline.mjs scripts/eval-runner.mjs scripts/eval-matrix.mjs scripts/eval-scorer.test.mjs eval/configs/
git commit -m "chore(eval): finalize CLI matrix rollout verification"
```

---

## Self-Review

**Spec coverage:** The plan covers the actual capability gap (per-call endpoint-config override, properly threaded through `callModel` → `callOpenAI`), the CLI matrix that uses it, scorer characterization tests that protect the extraction, determinism fixes (peak-hour bypass in eval), and documentation. Promptfoo, ScreenSpot IoU, token accounting, prompt profiles, and the regex DRY fix are explicitly deferred with rationale.

**What the review corrected:**
1. The on-disk plan contradicted the reviewed decisions (original had promptProfile + TS migration). Rewritten to match.
2. "Mirror the existing provider-override pattern" was false — the existing pattern overrides a provider *name*, not a config *triple*. The endpoint override needs a new `cfg?` param on `callOpenAI` + an 8th param on `callModel`. Task 2 reflects this.
3. Peak-hour routing made `--diff` non-deterministic. Task 1+3 pin configs in eval runs.
4. Promptfoo was the wrong first step — it's a presentation layer over a capability gap. CLI matrix ships first; Promptfoo deferred.

**Placeholder scan:** No `TODO`/`TBD` placeholders. Open choices are explicitly constrained (config file shape, matrix comparison table format).

**Type consistency:** One override type (`EndpointOverride`) threads through `TaggerInput` → `callModel` → `callOpenAI`. `runEvalCase` is the single orchestration path for both baseline and matrix.

## NOT in scope

| Item | Rationale |
|------|-----------|
| Promptfoo harness | Presentation layer over the capability gap; CLI matrix answers the DeepSeek question without a new dependency. Revisit if CLI proves insufficient. |
| promptProfile / prompt variants | `strict-wcag` is redundant with the output sanitizer (`tagger.ts:1185`); no concrete variant to test yet. |
| `src/eval/*.ts` migration | Working `.mjs` stays; TS migration bundles unrelated risk with the Promptfoo introduction. |
| Regex DRY fix (scorer copies) | Good change, but separate from this milestone's scope. Separate cleanup commit. |
| ScreenSpot IoU / token accounting | Unchanged from prior deferral — not needed to answer the provider/model question. |
| Blocking CI gate for eval | Eval stays manual/non-blocking this milestone. |

## What already exists

| Existing | Plan action |
|----------|-------------|
| `scripts/eval-baseline.mjs` (202 lines, working orchestrator) | Wraps it around shared `runEvalCase`; pins configs for determinism |
| `scripts/eval-scorer.mjs` (159 lines, `scoreExtraction`/`scoreCritique`/`summarizeScores`) | Kept as-is; characterization tests added |
| `scripts/eval-set.mjs` (15-image gold-label set) | Kept as-is |
| `TaggerInput.extractionProvider`/`critiqueProvider` (provider-name override) | Extended with `extractionOverride`/`critiqueOverride` (config-triple override) |
| `callModel` 7th param (`providerOverride`) | Extended with 8th param (`cfgOverride`) |
| `_raw.extractionModel`/`critiqueModel` traceability | Extended to record resolved override config |

## Failure modes

| Failure | Test covers? | Error handling? | User-visible? |
|---------|-------------|-----------------|---------------|
| Missing API key for a matrix config | No (precondition) | Yes — skip with clear message | Yes — explicit skip message |
| Endpoint override leaks into next call | Yes (Task 2 test 4) | No (test prevents it) | Would be silent if it leaked — test is the guard |
| Peak-hour swap overrides the pinned config | Yes (Task 2 test 5) | Yes — bypass in `resolveProvider` | N/A (bypassed) |
| DeepSeek endpoint returns auth error mid-matrix | No | Partial — auth short-circuit in baseline; matrix should skip-and-continue | Yes — error logged, config skipped |
| `callOpenAI` receives cfg but it's malformed | Yes (Task 2 Step 1 test 6) | Yes — `validateEndpointOverride` fails fast at the boundary | Yes — named-field error before any fetch call |

## Implementation Tasks

Synthesized from this review's findings. Run with subagent-driven-development or executing-plans; checkbox as you ship.

- [ ] **T1 (P1, human: ~1h / CC: ~10min)** — eval scorer — add characterization tests for scoreExtraction/scoreCritique
  - Surfaced by: Test Review — original plan's Task 1 only guarded summarizeScores, leaving the two scoring functions unprotected during the extraction
  - Files: `scripts/eval-scorer.test.mjs`
  - Verify: `npx vitest run scripts/eval-scorer.test.mjs`

- [ ] **T2 (P1, human: ~1.5h / CC: ~15min)** — eval orchestration — extract runEvalCase into scripts/eval-runner.mjs
  - Surfaced by: Architecture Review — shared orchestration lets both baseline and matrix use the same scoring path
  - Files: `scripts/eval-runner.mjs`, `scripts/eval-baseline.mjs`
  - Verify: `npm run eval-baseline -- --images 2 --extraction-only`

- [ ] **T3 (P1, human: ~3.5h / CC: ~30min)** — tagger — add per-call endpoint-config override + config-shape validation (cfg param on callOpenAI, 8th param on callModel, EndpointOverride on TaggerInput, peak-hour bypass, validateEndpointOverride boundary check)
  - Surfaced by: Architecture Review + Outside Voice — the existing provider-override pattern doesn't reach openaiConfigForPass; this is the load-bearing capability gap. Config validation folded in because the matrix runner's primary input is these configs — malformed input must fail fast at the boundary, not inside the HTTP call.
  - Files: `src/tagger.ts`, `src/tagger.test.ts`
  - Verify: `npx vitest run src/tagger.test.ts -t "endpoint-config override"` + `npm test`

- [ ] **T4 (P1, human: ~1.5h / CC: ~15min)** — eval matrix + determinism — add CLI matrix runner with pinned configs + comparison table; pin explicit configs in eval-baseline to bypass peak-hour routing (determinism prerequisite, merged into this task to avoid scheduling the same work twice)
  - Surfaced by: Architecture Review + Outside Voice Finding #5 — answers the DeepSeek question via the existing CLI (no new dependency), and peak-hour routing made --diff non-deterministic across wall-clock time
  - Files: `scripts/eval-matrix.mjs`, `scripts/eval-baseline.mjs`, `eval/configs/*.json`
  - Verify: `npm run eval-matrix -- --configs eval/configs/openai-gpt54.json`; run eval-baseline at two different times, confirm identical critiqueModel in baseline.json

- [ ] **T5 (P2, human: ~1h / CC: ~10min)** — docs — document baseline-vs-matrix split + deterministic-eval rationale + the two comparison classes (fully-pinned vs provider-only lanes) in README + ROADMAP
  - Surfaced by: plan documentation requirement + Issue 1 (over-promised determinism for Claude/Gemini lanes)
  - Files: `README.md`, `ROADMAP.md`
  - Verify: `rg -n "eval-baseline|eval-matrix|peak.hour|modelPinned" README.md ROADMAP.md`

## Completion summary

- Step 0: Scope Challenge — scope reduced (Promptfoo deferred, CLI matrix instead; .mjs kept, no TS migration)
- Architecture Review: 4 issues found (undefined profiles, no model override, endpoint-config vs model-name, peak-hour flake)
- Code Quality Review: 1 issue found (regex DRY — deferred to separate commit)
- Test Review: diagram produced, 2 gaps identified (scorer characterization, override shape validation — both folded into tasks)
- Performance Review: 0 issues found
- NOT in scope: written (7 items)
- What already exists: written (6 items)
- TODOS.md updates: 0 (all deferred items captured in NOT in scope)
- Failure modes: 0 critical gaps remaining (malformed cfg was the one flagged — resolved by folding config validation into Task 2)
- Outside voice: ran (Claude subagent) — 7 findings, 3 accepted as corrections, 1 strategic challenge accepted (Promptfoo → CLI matrix), 3 collapsed into accepted findings
- Post-review pass: 3 issues raised and fixed — (1) over-promised determinism for non-OpenAI lanes, now two explicit comparison classes with `modelPinned` flag; (2) config-shape validation moved from P2 follow-up into Task 2; (3) determinism work de-duplicated (merged T5 into T4)
- Parallelization: 2 lanes possible (Lane A: T1→T2→T4 sequential, shared scripts/; Lane B: T3 independent, src/tagger.ts only). Merge both, then T5.
- Lake Score: 5/5 recommendations chose the complete option (config validation folded in, not deferred)

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-10-promptfoo-provider-matrix.md`.

Recommended execution: subagent-driven, task by task with review gates between tasks. Task 3 (the override) is the critical path — do not start Task 4 until Task 3's tests pass.
