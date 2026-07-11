# Critique-Quality Evaluation Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the deterministic `scoreCritiqueQuality` scorer into the eval pipeline (runner, baseline, matrix), make it a CI gate, move Grok provider cases into the matrix config system, and delete `grok-eval.mjs`.

**Architecture:** A lightweight converter in `eval-runner.mjs` maps the raw critique blob returned by `generateCritique` into a `StructuredCritique`-shaped object that the scorer can consume. The eval-set fixture IDs join to gold labels via `eval/critique-quality-labels.json`. The baseline and matrix runners add critique-quality fields to their summary and comparison table. CI runs the offline scorer test as a gate. Grok/deepseek provider lanes move to `eval/configs/*.json` before `grok-eval.mjs` is deleted.

**Tech Stack:** TypeScript, Vitest, Node ESM, existing eval pipeline modules.

## Global Constraints

- `npm test` stays credential-free — the scorer is offline and deterministic.
- The eval pipeline continues to require provider keys for live runs (via `eval-baseline` / `eval-matrix`).
- The inline converter is best-effort: it maps what the legacy shape provides. Missing fields (`evidenceIds`, `basis`, `visualSlop`, `motion`) are defaulted — the scorer reports their absence, not crashes.
- `grok-eval.mjs`'s unique detector (`SELF_REFERENTIAL`) is not needed — `eval-scorer.mjs` already has the canonical detectors via generated rules.
- `grok-eval.mjs`'s private 9-image EVAL_SET is abandoned — the canonical 15-image set is the only one.
- No changes to `src/tagger.ts` or `src/server.ts` in this milestone.

---

## File Structure

- Modify: `scripts/eval-runner.mjs` — add inline converter, load gold labels, call scorer, add `critiqueQuality` to result
- Modify: `scripts/eval-scorer.mjs` — add `summarizeCritiqueQuality()` aggregate function
- Modify: `scripts/eval-baseline.mjs` — add critique-quality fields to summary + diff table
- Modify: `scripts/eval-matrix.mjs` — add critique-quality columns to comparison table
- Modify: `package.json` — replace stub `eval-critique-quality` script
- Modify: `.github/workflows/ci.yml` — add `test:critique-quality` step
- Create: `eval/configs/grok.json` — Grok provider lane for the matrix
- Create: `eval/configs/deepseek-via-openai.json` — DeepSeek provider lane for the matrix
- Delete: `scripts/grok-eval.mjs` — after provider config migration
- Modify: `scripts/critique-quality-scorer.mjs` — implement `requiredEvidencePrefixes` check, fix typedef mismatch

---

### Task 1: Add inline legacy→structured converter + scorer call in eval-runner

**Files:**
- Modify: `scripts/eval-runner.mjs`

**Interfaces:**
- Produces: `critiqueToStructured(rawCritique, extraction)` — inline converter that maps the legacy raw critique blob fields to a partial `StructuredCritique` shape
- Produces: `critiqueQuality` field on `EvalCaseResult` — the `ScoreResult` from `scoreCritiqueQuality`
- Consumes: `eval/critique-quality-labels.json` loaded once at module level

- [ ] **Step 1: Add label loading + join map at module level**

Load `eval/critique-quality-labels.json` at the top of `eval-runner.mjs`. Build a `Map<string, GoldLabel>` keyed by `id`. Export it so baseline/matrix can access the same labels.

- [ ] **Step 2: Implement the inline converter**

```js
function critiqueToStructured(rawCritique, extraction) {
  // Map legacy raw blob to partial StructuredCritique shape.
  // The legacy shape has: draftCritique, draftWhatToSteal, draftAntiPatterns,
  // draftAccessibilityRisks, businessRationale, qualityTier.
  // The StructuredCritique scorer checks: schemaVersion, summary, observations,
  // recommendations[].evidence, accessibilityRisks[].evidence/wcag, evidenceIds, motion.

  const draftAntiPatterns = Array.isArray(rawCritique.draftAntiPatterns) ? rawCritique.draftAntiPatterns : [];
  const draftCritique = typeof rawCritique.draftCritique === "string" ? rawCritique.draftCritique : "";
  const draftA11yRisks = Array.isArray(rawCritique.draftAccessibilityRisks) ? rawCritique.draftAccessibilityRisks : [];

  // Build evidenceIds from extraction keys (same logic as buildSynthesisContext's CITABLE_KEYS)
  const evidenceIds = [];
  const citableKeys = ["patternType", "layoutForm", "spacingDensity", "cornerStyle", "components", "categories", "styleTags"];
  for (const key of citableKeys) {
    if (extraction[key] != null) evidenceIds.push(`screen:${key}`);
  }

  return {
    schemaVersion: "1.0",
    platform: "web",
    retrievalMode: "structured-fallback",
    fallbackUsed: true,
    coverage: "moderate",
    summary: draftCritique.slice(0, 500),
    observations: draftAntiPatterns.filter(s => typeof s === "string"),
    recommendations: [], // Legacy shape doesn't have structured recommendations — scorer will report citationRate as 1.0 (no recs to fail)
    accessibilityRisks: draftA11yRisks.map(r => ({
      element: r.element ?? r.risk ?? "unknown",
      risk: r.risk ?? "unknown",
      evidence: r.evidence ?? "",
      wcag: Array.isArray(r.wcag) ? r.wcag : [],
      basis: "visible",
    })),
    evidenceIds,
    confidence: "medium",
  };
}
```

- [ ] **Step 3: Call scorer in runEvalCase and add critiqueQuality to result**

In the critique path of `runEvalCase` (after `scoreCritique`), add:
```js
// Score critique quality against gold labels
let critiqueQuality = null;
try {
  const { scoreCritiqueQuality } = await import("./critique-quality-scorer.mjs");
  const label = GOLD_LABELS.get(input.imageId ?? "");
  if (label) {
    const structured = critiqueToStructured(rawCritique, rawExtraction);
    critiqueQuality = scoreCritiqueQuality(structured, label);
  }
} catch (e) {
  critiqueQuality = { error: e.message };
}
```

Add `critiqueQuality` to the result object.

- [ ] **Step 4: Pass imageId to runEvalCase**

Ensure `runEvalCase` receives the fixture `id` (from `EVAL_SET`) as `input.imageId` so the label lookup works. Check that `eval-baseline.mjs` and `eval-matrix.mjs` already pass `img.id` — they set `r.imageId = img.id` after the call, so we need to pass it IN.

- [ ] **Step 5: Build + verify**

Run: `npm run build`
Expected: PASS (eval-runner.mjs is .mjs, not compiled by tsc — but the import paths must resolve from dist/)

- [ ] **Step 6: Commit**

```bash
git add scripts/eval-runner.mjs
git commit -m "feat(eval): wire critique-quality scorer into eval-runner"
```

---

### Task 2: Add critique-quality aggregate to eval-scorer.mjs

**Files:**
- Modify: `scripts/eval-scorer.mjs`

- [ ] **Step 1: Add summarizeCritiqueQuality function**

```js
export function summarizeCritiqueQuality(scores) {
  const valid = scores.filter(s => s && !s.error);
  if (valid.length === 0) return { schemaValidRate: 0, avgCitationRate: 0, overallPassRate: 0, totalBannedPhrases: 0, totalInvalidWcag: 0 };
  const schemaValid = valid.filter(s => s.schemaValid).length;
  const passCount = valid.filter(s => s.overallPass).length;
  const avgCitation = valid.reduce((sum, s) => sum + (s.citationRate ?? 0), 0) / valid.length;
  const banned = valid.reduce((sum, s) => sum + (s.bannedPhraseCount ?? 0), 0);
  const invalidWcag = valid.reduce((sum, s) => sum + (s.invalidWcagCount ?? 0), 0);
  return {
    schemaValidRate: schemaValid / valid.length,
    avgCitationRate: avgCitation,
    overallPassRate: passCount / valid.length,
    totalBannedPhrases: banned,
    totalInvalidWcag: invalidWcag,
    critiqueQualityErrorCount: scores.filter(s => s?.error).length,
  };
}
```

- [ ] **Step 2: Run existing scorer tests**

Run: `npx vitest run scripts/eval-scorer.test.mjs`
Expected: PASS (existing tests unaffected — new function is additive)

- [ ] **Step 3: Commit**

```bash
git add scripts/eval-scorer.mjs
git commit -m "feat(eval): add summarizeCritiqueQuality aggregate"
```

---

### Task 3: Add critique-quality to eval-baseline summary + diff

**Files:**
- Modify: `scripts/eval-baseline.mjs`

- [ ] **Step 1: Add critique-quality to summary**

After the existing `summarizeScores` call, add:
```js
const critiqueQualityScores = results.filter(r => r.critiqueQuality && !r.critiqueQuality.error).map(r => r.critiqueQuality);
const critiqueQualitySummary = summarizeCritiqueQuality(critiqueQualityScores);
```

Import `summarizeCritiqueQuality` from `eval-scorer.mjs`. Merge into `summary`.

- [ ] **Step 2: Add critique-quality metrics to the diff table**

Add to the `metrics` array in the diff comparison:
```js
["overallPassRate", "%", (v) => (v * 100).toFixed(1)],
["avgCitationRate", "%", (v) => (v * 100).toFixed(1)],
["totalBannedPhrases", "", (v) => v.toFixed(0)],
```

- [ ] **Step 3: Add to the SUMMARY console output**

After existing summary lines:
```js
if (summary.overallPassRate !== undefined) {
  console.log(`  critique-quality pass:  ${(summary.overallPassRate * 100).toFixed(1)}%`);
  console.log(`  avg citation rate:      ${(summary.avgCitationRate * 100).toFixed(1)}%`);
  console.log(`  total banned phrases:   ${summary.totalBannedPhrases ?? 0}`);
}
```

- [ ] **Step 4: Commit**

```bash
git add scripts/eval-baseline.mjs
git commit -m "feat(eval): add critique-quality to baseline summary + diff"
```

---

### Task 4: Add critique-quality columns to eval-matrix

**Files:**
- Modify: `scripts/eval-matrix.mjs`

- [ ] **Step 1: Add critique-quality to per-config summary**

Same as Task 3 Step 1 — add `summarizeCritiqueQuality` call in the per-config loop.

- [ ] **Step 2: Add columns to comparison table**

Add columns to the header and row format:
```
Config | Pinned | patternAcc | iconOnly | banned | critWds | cqPass | citation | latency | errors
```

Where `cqPass` is `(s.overallPassRate * 100).toFixed(0)%` and `citation` is `(s.avgCitationRate * 100).toFixed(0)%`.

- [ ] **Step 3: Commit**

```bash
git add scripts/eval-matrix.mjs
git commit -m "feat(eval): add critique-quality columns to matrix comparison"
```

---

### Task 5: Implement requiredEvidencePrefixes check in scorer + fix typedef

**Files:**
- Modify: `scripts/critique-quality-scorer.mjs`

- [ ] **Step 1: Add the check**

After the citation-rate scoring, add:
```js
// Check required evidence prefixes
if (Array.isArray(label.requiredEvidencePrefixes)) {
  for (const rec of output.recommendations) {
    const evidence = Array.isArray(rec.evidence) ? rec.evidence : [];
    const hasRequiredPrefix = evidence.some(id =>
      label.requiredEvidencePrefixes.some(prefix => id.startsWith(prefix))
    );
    if (!hasRequiredPrefix && evidence.length > 0) {
      result.prefixViolations = (result.prefixViolations || 0) + 1;
    }
  }
}
```

- [ ] **Step 2: Add prefixViolations to overallPass gate**

```js
result.overallPass = result.schemaValid
  && result.citationRate === 1.0
  && result.unknownEvidenceIds.length === 0
  && result.bannedPhraseCount === 0
  && result.forbiddenClaimCount === 0
  && result.motionPolicyViolations === 0
  && result.emptyEvidenceRiskCount === 0
  && result.invalidWcagCount === 0
  && (result.prefixViolations || 0) === 0;
```

- [ ] **Step 3: Add prefixViolations to ScoreResult typedef and initial value**

- [ ] **Step 4: Run scorer tests**

Run: `npx vitest run scripts/critique-quality-scorer.test.mjs`
Expected: PASS (existing tests don't test prefix violations — add one)

- [ ] **Step 5: Add test for prefix violation**

Add a test case where a recommendation's evidence has no `screen:` prefix and the label requires it.

- [ ] **Step 6: Commit**

```bash
git add scripts/critique-quality-scorer.mjs scripts/critique-quality-scorer.test.mjs
git commit -m "fix(scorer): implement requiredEvidencePrefixes check"
```

---

### Task 6: Migrate Grok/DeepSeek provider config, delete grok-eval.mjs

**Files:**
- Create: `eval/configs/grok.json`
- Create: `eval/configs/deepseek-via-openai.json`
- Delete: `scripts/grok-eval.mjs`
- Modify: `package.json` (remove any grok-eval references if any)

- [ ] **Step 1: Create Grok config**

```json
{
  "_comment": "Grok (xAI) provider lane for the eval matrix",
  "name": "grok",
  "modelPinned": false,
  "extraction": { "provider": "grok" },
  "critique": { "provider": "grok" }
}
```

- [ ] **Step 2: Create DeepSeek config**

```json
{
  "_comment": "DeepSeek V4 Pro via NVIDIA NIM (OpenAI-compatible). Extraction stays on OpenAI for vision; critique routes to DeepSeek.",
  "name": "deepseek-via-openai",
  "modelPinned": true,
  "extraction": { "provider": "openai", "baseUrl": "", "apiKey": "${OPENAI_API_KEY}", "model": "gpt-5.4-mini" },
  "critique": { "provider": "openai", "baseUrl": "https://integrate.api.nvidia.com/v1", "apiKey": "${OPENAI_API_KEY_CRITIQUE}", "model": "deepseek-ai/deepseek-v4-pro" }
}
```

- [ ] **Step 3: Delete grok-eval.mjs**

```bash
git rm scripts/grok-eval.mjs
```

- [ ] **Step 4: Verify no references to grok-eval remain**

Run: `rg "grok-eval" . --glob '!node_modules' --glob '!.git'`
Expected: zero hits (or only historical plan docs)

- [ ] **Step 5: Commit**

```bash
git add eval/configs/grok.json eval/configs/deepseek-via-openai.json
git rm scripts/grok-eval.mjs
git commit -m "refactor(eval): migrate grok/deepseek to matrix configs, delete grok-eval.mjs"
```

---

### Task 7: Add CI gate for critique-quality + replace stub script

**Files:**
- Modify: `.github/workflows/ci.yml`
- Modify: `package.json`

- [ ] **Step 1: Replace the stub eval-critique-quality script**

Change `package.json`:
```json
"test:critique-quality": "vitest run scripts/critique-quality-scorer.test.mjs scripts/eval-scorer.test.mjs",
```

Remove the useless stub `eval-critique-quality` entry (or change it to a helpful message that points to `eval-matrix`).

- [ ] **Step 2: Add test:critique-quality to CI**

In `ci.yml`, after `npm test`:
```yaml
      - run: npm run test:critique-quality
```

This ensures the deterministic scorer tests run as a separate explicit CI step, even though they're already in `npm test`. Belt-and-suspenders for visibility.

- [ ] **Step 3: Verify CI sequence locally**

Run: `npm run test:critique-quality`
Expected: PASS (offline, no credentials)

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml package.json
git commit -m "ci: gate critique-quality scorer tests"
```

---

### Task 8: Full verification

- [ ] **Step 1: Run the full offline suite**

```bash
npm run validate-references && npm run build && npm run validate-corpus && npm test
```

Expected: all exit 0.

- [ ] **Step 2: Run the wiring test**

```bash
npx vitest run src/wiring-verification.test.ts
```

Expected: PASS (grok-eval.mjs deletion removes its symbols; no new orphaned exports introduced).

- [ ] **Step 3: Verify grok-eval.mjs is gone**

```bash
test ! -f scripts/grok-eval.mjs && echo "DELETED ✓" || echo "STILL EXISTS ✗"
```

- [ ] **Step 4: Final commit if needed**

```bash
git add -A
git diff --cached --quiet || git commit -m "chore(eval): finalize critique-quality wiring verification"
```

## Self-Review

**Spec coverage:** The plan covers scorer wiring (Task 1), aggregate summary (Task 2), baseline integration (Task 3), matrix integration (Task 4), scorer fix (Task 5), grok-eval deletion (Task 6), CI gate (Task 7), and full verification (Task 8).

**Placeholder scan:** No TBD/TODO. The inline converter code is complete with field mappings. The summarizeCritiqueQuality function is complete.

**Type consistency:** The `critiqueQuality` field on `EvalCaseResult` is a `ScoreResult` from `scoreCritiqueQuality`. The `summarizeCritiqueQuality` takes `ScoreResult[]`. The gold labels join on `imageId` which is the EVAL_SET `id`.

**Known gap:** The inline converter maps legacy fields to StructuredCritique but `recommendations` is always empty (legacy shape doesn't have structured recommendations). The scorer reports `citationRate: 1.0` for zero recommendations (no recs to fail). This is correct behavior — it means the deterministic gate catches banned phrases, WCAG validity, forbidden claims, and schema validity, but not citation grounding on recommendations (because the legacy critique shape doesn't produce structured recommendations). Full citation scoring requires the StructuredCritique synthesis path, which is a future milestone.
