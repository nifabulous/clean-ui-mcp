# Critique-Quality Evaluation Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the deterministic `scoreCritiqueQuality` scorer into the eval pipeline (runner, baseline, matrix), make it a CI gate, move Grok provider cases into the matrix config system, and delete `grok-eval.mjs`.

**Architecture:** A lightweight converter in `eval-runner.mjs` maps the raw critique blob returned by `generateCritique` into a `StructuredCritique`-shaped object that the scorer can consume. The eval-set fixture IDs join to gold labels via `eval/critique-quality-labels.json`. The baseline and matrix runners add critique-quality fields to their summary and comparison table. CI runs the offline scorer test as a gate. Grok/deepseek provider lanes move to `eval/configs/*.json` before `grok-eval.mjs` is deleted.

**Tech Stack:** TypeScript, Vitest, Node ESM, existing eval pipeline modules.

## Global Constraints

- `npm test` stays credential-free — the scorer is offline and deterministic.
- The eval pipeline continues to require provider keys for live runs (via `eval-baseline` / `eval-matrix`).
- The inline converter is best-effort: it maps what the legacy shape provides. Missing fields (`basis`, `visualSlop`, `motion`) are defaulted — the scorer reports their absence, not crashes.
- Evidence ID generation must NOT be duplicated inline. Export a `buildScreenEvidenceIds(extraction)` helper from `synthesis/context.ts` and reuse it in the eval pipeline.
- `grok-eval.mjs`'s `SELF_REFERENTIAL` detector is intentionally dropped from eval scoring. Production sanitization already handles self-referential claims at `tagger.ts:1187` — eval scoring doesn't need to re-enforce it. The canonical `eval-scorer.mjs` detectors (banned phrases, pixel measurement, unlabeled control) cover the eval-side hallucination counting.
- `recommendations: []` from the legacy shape means the citation score is **not scorable**, not a pass. The scorer must report `notScorable` for zero-recommendation cases, not `citationRate: 1.0`.
- DeepSeek config already exists at `eval/configs/deepseek-nim.json` — do not duplicate it. Only add `eval/configs/grok.json`.
- `grok-eval.mjs`'s private 9-image EVAL_SET is abandoned — the canonical 15-image set is the only one.
- No changes to `src/tagger.ts` or `src/server.ts` in this milestone.

---

## File Structure

- Modify: `scripts/eval-runner.mjs` — add inline converter, load gold labels, call scorer, add `critiqueQuality` to result
- Modify: `src/synthesis/context.ts` — export `buildScreenEvidenceIds(extraction)` helper for reuse by eval pipeline
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

- [ ] **Step 2: Export buildScreenEvidenceIds helper from synthesis/context.ts**

In `src/synthesis/context.ts`, extract the screen-evidence-ID-generation logic from `buildSynthesisContext` into a reusable exported function:

```ts
/** Build screen:* evidence IDs from extraction keys. Shared by buildSynthesisContext and the eval pipeline. */
export function buildScreenEvidenceIds(extraction: Record<string, unknown>): string[] {
  const ids: string[] = [];
  for (const key of CITABLE_KEYS) {
    if (extraction[key] != null) ids.push(`screen:${key}`);
  }
  // Visual evidence
  const visual = registerVisualEvidence({
    dominantColors: extraction.dominantColors as string[] | undefined,
    accentColor: extraction.accentColor as string | null | undefined,
    colorRoles: extraction.colorRoles as Record<string, unknown> | null | undefined,
    usesShadows: extraction.usesShadows as boolean | null | undefined,
    usesBorders: extraction.usesBorders as boolean | null | undefined,
    typePairing: extraction.typePairing as Record<string, unknown> | null | undefined,
    spacingDensity: extraction.spacingDensity as string | null | undefined,
    cornerStyle: extraction.cornerStyle as string | null | undefined,
  });
  ids.push(...visual.map(e => e.id));
  return ids;
}
```

Then refactor `buildSynthesisContext` to call `buildScreenEvidenceIds` instead of the inline loop — keeps the two paths from drifting.

- [ ] **Step 3: Implement the inline converter using the shared helper**

```js
function critiqueToStructured(rawCritique, extraction) {
  // Map legacy raw blob to partial StructuredCritique shape.
  // The legacy shape has: draftCritique, draftWhatToSteal, draftAntiPatterns,
  // draftAccessibilityRisks, businessRationale, qualityTier.
  // Evidence IDs are generated via the shared buildScreenEvidenceIds helper —
  // NOT duplicated inline, to prevent drift from context.ts.

  const draftAntiPatterns = Array.isArray(rawCritique.draftAntiPatterns) ? rawCritique.draftAntiPatterns : [];
  const draftCritique = typeof rawCritique.draftCritique === "string" ? rawCritique.draftCritique : "";
  const draftA11yRisks = Array.isArray(rawCritique.draftAccessibilityRisks) ? rawCritique.draftAccessibilityRisks : [];

  // Import the shared helper from the compiled output
  const { buildScreenEvidenceIds } = await import("../dist/synthesis/context.js");
  const evidenceIds = buildScreenEvidenceIds(extraction);

  return {
    schemaVersion: "1.0",
    platform: "web",
    retrievalMode: "structured-fallback",
    fallbackUsed: true,
    coverage: "moderate",
    summary: draftCritique.slice(0, 500),
    observations: draftAntiPatterns.filter(s => typeof s === "string"),
    // Legacy shape has no structured recommendations — the scorer reports
    // citationRate as "notScorable" (not 1.0) for zero recommendations.
    recommendations: [],
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

- [ ] **Step 4: Call scorer in runEvalCase and add critiqueQuality to result**

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

**Critical scorer change:** The scorer must report `citationRate: "notScorable"` (not 1.0) when `recommendations.length === 0`. A zero-recommendation case should NOT contribute to `overallPassRate` — it should be counted as `notScorableCount` in the summary. This prevents "no citation-bearing recommendations were produced" from looking like "all recommendations were grounded."

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
  if (valid.length === 0) return { schemaValidRate: 0, avgCitationRate: 0, overallPassRate: 0, notScorableCount: 0, scorableCount: 0, totalBannedPhrases: 0, totalInvalidWcag: 0 };
  const schemaValid = valid.filter(s => s.schemaValid).length;
  const notScorable = valid.filter(s => s.citationRate === "notScorable");
  const scorable = valid.filter(s => s.citationRate !== "notScorable");
  // overallPassRate counts only scorable cases — notScorable is reported separately
  const passCount = scorable.filter(s => s.overallPass).length;
  const avgCitation = scorable.length > 0
    ? scorable.reduce((sum, s) => sum + (s.citationRate ?? 0), 0) / scorable.length
    : 0;
  const banned = valid.reduce((sum, s) => sum + (s.bannedPhraseCount ?? 0), 0);
  const invalidWcag = valid.reduce((sum, s) => sum + (s.invalidWcagCount ?? 0), 0);
  return {
    schemaValidRate: schemaValid / valid.length,
    avgCitationRate: avgCitation,
    overallPassRate: scorable.length > 0 ? passCount / scorable.length : 0,
    notScorableCount: notScorable.length,
    scorableCount: scorable.length,
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
- Delete: `scripts/grok-eval.mjs`
- Modify: `package.json` (remove any grok-eval references if any)

Note: `eval/configs/deepseek-nim.json` already exists and covers the DeepSeek-via-NIM lane. Do NOT create a duplicate.

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

- [ ] **Step 2: Delete grok-eval.mjs**

```bash
git rm scripts/grok-eval.mjs
```

Note: grok-eval.mjs's `SELF_REFERENTIAL` detector is intentionally dropped. Production sanitization at `tagger.ts:1187` handles self-referential claims at runtime — eval scoring doesn't need to re-enforce it. The canonical eval-scorer.mjs detectors (banned phrases, pixel measurement, unlabeled control) cover the eval-side hallucination counting that matters.

- [ ] **Step 3: Verify no references to grok-eval remain**

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
- Modify: `README.md`

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

- [ ] **Step 4: Update README**

Remove or fix the stale `eval-critique-quality` reference in README.md. Replace with documentation of the new `test:critique-quality` script and the critique-quality columns in eval-matrix output.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/ci.yml package.json README.md
git commit -m "ci: gate critique-quality scorer tests + update docs"
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

**Known gap:** The inline converter maps legacy fields to StructuredCritique but `recommendations` is always empty (legacy shape doesn't have structured recommendations). The scorer reports `citationRate: "notScorable"` for zero recommendations, and the summary reports `notScorableCount` separately from `overallPassRate`. This means the deterministic gate honestly reports "not scorable for citation grounding" rather than pretending zero recommendations is a pass. The gate still catches banned phrases, WCAG validity, forbidden claims, and schema validity. Full citation scoring requires the StructuredCritique synthesis path, which is a future milestone — at which point `notScorableCount` drops to 0 and `overallPassRate` becomes meaningful for all fixtures.
