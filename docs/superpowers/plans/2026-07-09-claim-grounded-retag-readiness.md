# Claim-Grounded Retag Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make auto-tagged critique output trustworthy before bulk retagging by grounding generated claims in visible observations, DOM facts, or explicit extraction evidence.

**Architecture:** Treat fake accessibility risks as one instance of a broader unsupported-claim problem. Add a structured evidence gate for accessibility risks, strip palette data from the critique pass, tighten claim-grounding instructions for critique/anti-pattern/voice/business rationale, add the `calculator` pattern, and add id-only entry rename support. Keep legacy corpus entries valid with lazy migration.

**Tech Stack:** TypeScript, Zod, Vitest, vanilla JS curator SPA, MCP SDK, existing two-pass tagger.

## Global Constraints

- Do not run the full corpus retag until the smoke retag gates at the end of this plan pass.
- Preserve legacy `antiPatterns.accessibilityRisks: string[]` entries; new auto-tagged entries should emit structured objects.
- `dom-grounded` confidence is code-owned. Models may emit only `visible` or `inferred`.
- Palette values are extraction facts, not critique evidence. The critique pass must not receive `dominantColors`, `accentColor`, or `colorRoles`.
- Entry rename is id-only. Do not rename image files in the normal rename flow.
- No destructive cleanup of capture directories during this work.

---

## Files And Responsibilities

- `src/schema.ts` — schema union for legacy/new accessibility risks, exported helpers for text extraction and markdown formatting, `calculator` pattern enum, persisted `patternDiscovery` metadata.
- `src/tagger.ts` — critique-safe extraction, evidence-gated a11y sanitizer, claim-grounded critique prompt, structured a11y merge output, calculator calibration, persisted suggested-pattern output.
- `src/server.ts` — MCP rendering of structured a11y risks.
- `src/embeddings.ts` — type compatibility for structured a11y risks, still excluded from embedding text unless deliberately changed.
- `src/scripts/ui-server.ts` — draft-marker stripping for structured a11y objects, id-only rename endpoint.
- `src/scripts/pattern-discovery.ts` — summarizes persisted `patternDiscovery.suggestedPatternType` values, with legacy `_raw` fallback only for old local artifacts.
- `ui/app.js` — structured a11y rendering, object-aware draft stripping, id-only rename control.
- `ui/classic-app.js` — structured a11y rendering and object-safe display.
- `src/schema.test.ts` — schema compatibility tests.
- `src/tagger.test.ts` — sanitizer, palette-stripping, and claim-grounding regression tests.
- `src/scripts/ui-server.test.ts` — rename endpoint and draft stripping tests.
- `src/scripts/ui-browser.test.ts` — object-aware draft hygiene fixture updates.
- `README.md`, `skill/clean-ui-design/SKILL.md`, `docs/ROADMAP.md` — update only after code behavior is settled.

---

### Task 1: Schema And Shared A11y Risk Helpers

**Files:**
- Modify: `src/schema.ts`
- Test: `src/schema.test.ts`

**Interfaces:**
- Produces:
  - `AccessibilityRisk` Zod schema accepting legacy strings and structured objects.
  - `type AccessibilityRiskT`
  - `accessibilityRiskTextFields(risk: AccessibilityRiskT): string[]`
  - `formatAccessibilityRisk(risk: AccessibilityRiskT, opts?: { includeEvidence?: boolean }): string`
- Consumes: existing `AntiPatterns` schema and `findDraftMarkers`.

- [ ] **Step 1: Write failing schema tests**

Add tests that assert:

```ts
it("accepts legacy string accessibility risks", () => {
  const result = CorpusEntry.safeParse({
    ...validEntry,
    antiPatterns: {
      ...validEntry.antiPatterns,
      accessibilityRisks: ["[inferred] sidebar: possible contrast issue"],
    },
  });
  expect(result.success).toBe(true);
});

it("accepts structured accessibility risks with evidence", () => {
  const result = CorpusEntry.safeParse({
    ...validEntry,
    antiPatterns: {
      ...validEntry.antiPatterns,
      accessibilityRisks: [{
        element: "left sidebar navigation",
        risk: "Icon labels may be difficult to scan for low-vision users at small sizes.",
        evidence: "visible labels: Home, Cards, Transactions, Balance",
        confidence: "visible",
        wcag: "1.4.3 Contrast (Minimum)",
      }],
    },
  });
  expect(result.success).toBe(true);
});

it("rejects structured accessibility risks without evidence", () => {
  const result = CorpusEntry.safeParse({
    ...validEntry,
    antiPatterns: {
      ...validEntry.antiPatterns,
      accessibilityRisks: [{
        element: "sidebar",
        risk: "Icon-only controls may lack accessible names.",
        evidence: "",
        confidence: "inferred",
      }],
    },
  });
  expect(result.success).toBe(false);
});

it("findDraftMarkers scans structured accessibility risk text fields", () => {
  const entry = CorpusEntry.parse({
    ...validEntry,
    antiPatterns: {
      ...validEntry.antiPatterns,
      accessibilityRisks: [{
        element: "status row",
        risk: "[DRAFT] Color-only status may fail for color-blind users.",
        evidence: "8px red dot next to Failed row",
        confidence: "visible",
      }],
    },
  });
  expect(findDraftMarkers(entry)).toContain("antiPatterns.accessibilityRisks[0].risk");
});
```

- [ ] **Step 2: Implement schema union and helpers**

Change `AntiPatterns.accessibilityRisks` to:

```ts
export const AccessibilityRisk = z.union([
  z.string().min(10),
  z.object({
    element: z.string().min(3),
    risk: z.string().min(10),
    evidence: z.string().min(8),
    confidence: z.enum(["visible", "inferred", "dom-grounded"]),
    wcag: z.string().optional(),
  }),
]);

export type AccessibilityRiskT = z.infer<typeof AccessibilityRisk>;
```

Add helpers:

```ts
export function accessibilityRiskTextFields(risk: AccessibilityRiskT): string[] {
  if (typeof risk === "string") return [risk];
  return [risk.element, risk.risk, risk.evidence, risk.wcag ?? ""].filter(Boolean);
}

export function formatAccessibilityRisk(
  risk: AccessibilityRiskT,
  opts: { includeEvidence?: boolean } = {},
): string {
  if (typeof risk === "string") return risk;
  const wcag = risk.wcag ? ` (${risk.wcag})` : "";
  const base = `[${risk.confidence}] ${risk.element}: ${risk.risk}${wcag}`;
  return opts.includeEvidence ? `${base}\n  Evidence: ${risk.evidence}` : base;
}
```

Update `findDraftMarkers` / `entryTextFields` to use `accessibilityRiskTextFields`.

- [ ] **Step 3: Run schema tests**

Run: `npm test -- src/schema.test.ts`

Expected: schema tests pass.

---

### Task 2: Evidence-Gated A11y Sanitizer

**Files:**
- Modify: `src/tagger.ts`
- Test: `src/tagger.test.ts`

**Interfaces:**
- Consumes: structured a11y risk shape from Task 1.
- Produces: `sanitizeAccessibilityRisks()` returns only evidence-backed risk objects.

- [ ] **Step 1: Write failing sanitizer regression tests**

Add tests for the exact false-positive classes:

```ts
it("drops icon-only risks when evidence names visible text labels", () => {
  const sanitized = sanitizeTaggerPayload({
    draftAccessibilityRisks: [{
      element: "sidebar icons",
      risk: "Icon-only controls may lack accessible names.",
      evidence: "visible labels: Home, Cards, Transactions, Balance",
      confidence: "inferred",
      wcag: "1.1.1 Non-text Content",
    }],
  });
  expect(sanitized.draftAccessibilityRisks).toEqual([]);
});

it("drops color-only risks when evidence is only a palette color", () => {
  const sanitized = sanitizeTaggerPayload({
    draftAccessibilityRisks: [{
      element: "status chips",
      risk: "Purple is used as the sole status differentiator.",
      evidence: "#7464a4 from dominant color palette",
      confidence: "inferred",
      wcag: "1.4.1 Use of Color",
    }],
  });
  expect(sanitized.draftAccessibilityRisks).toEqual([]);
});

it("keeps visible color-only risks with concrete UI evidence", () => {
  const sanitized = sanitizeTaggerPayload({
    draftAccessibilityRisks: [{
      element: "payment status dot",
      risk: "State is communicated by color alone, which color-blind users may miss.",
      evidence: "8px red/green dots beside Paid and Failed rows with no text status label",
      confidence: "visible",
      wcag: "1.4.1 Use of Color",
    }],
  });
  expect(sanitized.draftAccessibilityRisks).toHaveLength(1);
});

it("caps non-DOM accessibility risks to two", () => {
  const risks = [1, 2, 3].map((n) => ({
    element: `visible control ${n}`,
    risk: `Risk ${n} with enough specific detail for validation.`,
    evidence: `top-right region ${n} with visible control and label`,
    confidence: "visible",
  }));
  const sanitized = sanitizeTaggerPayload({ draftAccessibilityRisks: risks });
  expect(sanitized.draftAccessibilityRisks).toHaveLength(2);
});
```

- [ ] **Step 2: Implement evidence quality gates**

In `src/tagger.ts`, replace the current sanitizer with these rules:

- Drop missing/short evidence.
- Drop evidence that is only a generic component name: `sidebar`, `buttons`, `icons`, `cards`, `text`, `layout`.
- Drop evidence that is only a hex, palette mention, or color word.
- Drop icon-only risks if evidence contains visible label language or quoted labels.
- Drop color-only/status risks unless evidence names a concrete visible state/status/control or cites a DOM metric.
- Downgrade model-emitted `dom-grounded` to `inferred`; only code may upgrade later.
- Cap non-DOM risks at two.

Keep backward-compatible plain strings by converting them to legacy inferred objects only if they contain enough concrete evidence is impossible. For new model output, prefer dropping plain strings so the new prompt cannot bypass evidence.

- [ ] **Step 3: Run tagger sanitizer tests**

Run: `npm test -- src/tagger.test.ts`

Expected: sanitizer tests pass.

---

### Task 3: Claim-Grounded Critique Prompt And Palette Stripping

**Files:**
- Modify: `src/tagger.ts`
- Test: `src/tagger.test.ts`

**Interfaces:**
- Produces: `critiqueSafeExtraction(extraction: Record<string, unknown>): Record<string, unknown>`
- Consumes: existing `buildCritiquePrompt()`.

- [ ] **Step 1: Write failing Pass 2 prompt tests**

Add a test that mocks two-pass tagging and captures the Pass 2 prompt:

```ts
it("does not pass palette fields into the critique prompt", async () => {
  const prompts: string[] = [];
  let callCount = 0;
  globalThis.fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const text = String(body.input?.[1]?.content?.[0]?.text ?? "");
    prompts.push(text);
    callCount++;
    const response = callCount === 1
      ? JSON.stringify({
          patternType: "dashboard",
          categories: ["dashboard"],
          styleTags: ["minimal"],
          dominantColors: ["#7464a4", "#ffffff"],
          accentColor: "#7464a4",
          colorRoles: { canvas: "#ffffff", surface: "#f8f8f8", ink: "#111111", muted: "#777777", accent: "#7464a4" },
          spacingDensity: "moderate",
          cornerStyle: "slight-round",
          usesShadows: false,
          usesBorders: true,
        })
      : JSON.stringify({
          observations: ["left sidebar includes Home, Cards, Transactions labels", "calculator input area", "computed fee output", "primary action button", "exchange-rate note"],
          typographyNotes: "Specific hierarchy note.",
          draftCritique: "The calculator layout keeps inputs and computed outputs close together, reducing back-and-forth scanning for people comparing transfer cost before committing.",
          draftWhatToSteal: ["Keep numeric inputs adjacent to computed outputs when users are comparing cost before deciding."],
          draftAntiPatterns: ["Avoid separating fee results from the amount input; that forces users to memorize numbers across regions."],
          draftAccessibilityRisks: [],
          qualityTier: "exceptional",
        });
    return new Response(JSON.stringify({ output_text: response }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  await tagImage({ imagePath: testImage, productName: "Wise", url: null });
  const pass2Prompt = prompts[1];
  expect(pass2Prompt).not.toContain("dominantColors");
  expect(pass2Prompt).not.toContain("accentColor");
  expect(pass2Prompt).not.toContain("colorRoles");
  expect(pass2Prompt).not.toContain("#7464a4");
});
```

- [ ] **Step 2: Add critique-safe extraction helper**

Implement:

```ts
function critiqueSafeExtraction(extraction: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...extraction };
  delete copy.dominantColors;
  delete copy.accentColor;
  delete copy.colorRoles;
  return copy;
}
```

Use it in both:

- `tagImage()` before `buildCritiquePrompt(...)`
- `generateCritique()` before `buildCritiquePrompt(...)`

- [ ] **Step 3: Broaden prompt from a11y grounding to claim grounding**

Update the critique prompt rules:

- `draftCritique`, `draftWhatToSteal`, and `draftAntiPatterns` must trace to the observations list.
- `voiceExamples` must be exact visible copy only; omit voice when copy is not visible.
- `businessRationale` must be `null` unless visible product context supports the intent.
- `draftAccessibilityRisks` must include `evidence`.
- Palette values are not evidence.
- Component/category norms are not evidence.
- Absent states are not evidence.

Replace the a11y JSON schema with:

```json
"draftAccessibilityRisks": [
  {
    "element": "specific visible element",
    "risk": "what fails and for whom",
    "evidence": "quote visible text, name exact screen region, or cite DOM metric proving the risk exists",
    "confidence": "visible | inferred",
    "wcag": "criterion if known"
  }
]
```

- [ ] **Step 4: Run tagger tests**

Run: `npm test -- src/tagger.test.ts`

Expected: tests pass and Pass 2 prompt excludes palette fields.

---

### Task 4: Structured Risk Rendering Across MCP And UIs

**Files:**
- Modify: `src/server.ts`
- Modify: `src/embeddings.ts`
- Modify: `ui/app.js`
- Modify: `ui/classic-app.js`
- Test: relevant existing tests

**Interfaces:**
- Consumes: `formatAccessibilityRisk()` from `src/schema.ts`.
- Produces: object-aware display everywhere a11y risks are shown.

- [ ] **Step 1: Update MCP rendering**

In `src/server.ts`:

- import `formatAccessibilityRisk`
- render `get_ui_example` a11y risks with `includeEvidence: true`
- update `compare_ui_examples` `top()` helper to accept mixed arrays by formatting first

- [ ] **Step 2: Update `src/embeddings.ts` types**

Change the local entry type from:

```ts
accessibilityRisks?: string[];
```

to:

```ts
accessibilityRisks?: Array<string | { element: string; risk: string; evidence: string; confidence: string; wcag?: string }>;
```

Keep accessibility risks excluded from embedding text unless a separate search-quality decision is made.

- [ ] **Step 3: Update SPA rendering**

In `ui/app.js`:

- Add `formatA11yRisk(r)`:
  - legacy string: render as current list item
  - object: render `[confidence] element: risk` plus muted second line `Evidence: ...`
- Update draft-marker stripping around lines currently doing `.map(stripDraftMarker)` so object fields are stripped field-by-field.

- [ ] **Step 4: Update classic UI rendering**

In `ui/classic-app.js`, add the same legacy/object rendering helper.

- [ ] **Step 5: Run browser/UI tests**

Run: `npm test -- src/scripts/ui-browser.test.ts src/scripts/ui-server.test.ts`

Expected: tests pass.

---

### Task 5: Add `calculator` Pattern Type

**Files:**
- Modify: `src/schema.ts`
- Modify: `src/tagger.ts`
- Modify: `src/scripts/migrate-v1-to-v2.ts`
- Modify: `src/scripts/ui-browser.test.ts`
- Test: `src/schema.test.ts`, `src/tagger.test.ts`

**Interfaces:**
- Produces: new `patternType: "calculator"`.

- [ ] **Step 1: Add schema test**

Update the valid PatternType list in `src/schema.test.ts` to include `"calculator"`.

- [ ] **Step 2: Add enum value**

In `src/schema.ts`, add `"calculator"` to the full-page pattern group:

```ts
"calculator", // numeric inputs -> live-computed outputs: transfer fees, ROI, pricing estimators, mortgage/loan
```

- [ ] **Step 3: Add tagger constant and calibration**

In `src/tagger.ts`, add `"calculator"` to `PATTERN_TYPES`.

Update the extraction prompt calibration:

```text
Use calculator for tools where the primary screen pattern is entering numeric
or business variables and seeing computed results: fees, ROI, savings, loan
payments, pricing estimates, mortgage calculators. Do not default these to
dashboard unless the primary experience is monitoring many existing metrics.
```

- [ ] **Step 4: Update legacy migration list and UI test schema fixture**

Add `"calculator"` to:

- `src/scripts/migrate-v1-to-v2.ts`
- `src/scripts/ui-browser.test.ts` mock `/api/schema` patternTypes

- [ ] **Step 5: Run tests**

Run: `npm test -- src/schema.test.ts src/tagger.test.ts src/scripts/ui-browser.test.ts`

Expected: tests pass.

---

### Task 6: Id-Only Rename Endpoint And UI Control

**Files:**
- Modify: `src/scripts/ui-server.ts`
- Modify: `ui/app.js`
- Test: `src/scripts/ui-server.test.ts`

**Interfaces:**
- Produces: `POST /api/entries/:id/rename` with body `{ newId: string }`.

- [ ] **Step 1: Add server tests**

Add tests for:

- successful rename preserves `image.path`
- duplicate id rejected
- empty/no-op/non-slug id rejected or normalized consistently
- returned entry uses new id

- [ ] **Step 2: Implement endpoint**

Endpoint behavior:

- path: `POST /api/entries/:id/rename`
- body: `{ newId: string }`
- normalize with the existing slug logic if available, otherwise reject non-slug input
- reject empty id
- reject same id
- reject duplicate id
- update only `entry.id`
- save entries
- return `{ ok: true, entry }`
- do not rename image files

- [ ] **Step 3: Add SPA control**

In `ui/app.js` detail rail:

- Add a small rename affordance near the id/title area.
- Use `prompt()` with current id as the default.
- On success, replace the local entry object, preserve detail selection by switching to the new id, update favorites if favorites are id-based, and re-render.
- Show a toast on success/failure.

- [ ] **Step 4: Run tests**

Run: `npm test -- src/scripts/ui-server.test.ts src/scripts/ui-browser.test.ts`

Expected: tests pass.

---

### Task 7: Retag Readiness Smoke Gates

**Files:**
- No code required unless tests reveal missing coverage.
- Optional docs update after behavior is verified.

**Interfaces:**
- Consumes all previous tasks.
- Produces a clear go/no-go decision before full retag.

- [ ] **Step 1: Run full verification**

Run:

```bash
npm run build
npm test
npm run validate-corpus
```

Expected:

- build succeeds
- tests pass
- corpus validates

- [ ] **Step 2: Targeted Wise retag**

Retag the Wise sample that previously produced:

- fake icon-only sidebar risk
- fake purple status chip risk
- wrong `dashboard` pattern

Expected:

- fabricated icon-only sidebar risk is absent
- fabricated purple/status-chip risk is absent
- `patternType` is `calculator`
- `accessibilityRisks` is either `[]` or contains structured objects with concrete `evidence`
- `businessRationale` is plausible and tied to visible calculator/transfer context, or absent
- `voiceExamples` contain only visible copy

- [ ] **Step 3: Ten-entry mixed smoke retag**

Retag a small mixed set before bulk spend:

- 2 dashboards
- 2 pricing pages
- 1 calculator
- 1 onboarding/auth screen
- 1 landing/marketing page
- 1 mobile screen
- 1 cautionary/bad example
- 1 dense data/table screen

Inspect only these fields:

- `patternType`
- `components`
- `domainTags`
- `businessRationale`
- `voice`
- `antiPatterns.accessibilityRisks`

Expected:

- no invented components
- no palette-only a11y claims
- no fake voice quotes
- no business rationale for isolated snippets
- no default-to-dashboard for calculator/form-like tools

- [ ] **Step 4: Rebuild index only after accepted smoke results**

Run:

```bash
npm run pattern-discovery
npm run build-index
npm run corpus-stats
```

Expected:

- pattern-discovery reports any real open-vocabulary pattern candidates before enum promotion
- index has no missing/stale/content-stale entries
- `calculator` appears in pattern distribution once entries are retagged

- [ ] **Step 5: Bulk retag go/no-go**

Proceed to full corpus retag only if:

- all automated tests pass
- targeted Wise retag is clean
- ten-entry smoke retag is clean
- pattern-discovery has been reviewed and any high-count real gaps have been promoted before the expensive retag
- index rebuild works

If any smoke entry has unsupported claims, fix prompt/sanitizer first and rerun the smoke set. Do not bulk retag through known hallucination modes.

---

## Commit Plan

Use small commits:

1. `feat(schema): support structured accessibility evidence`
2. `fix(tagger): gate unsupported accessibility risks`
3. `fix(tagger): strip palette from critique grounding`
4. `feat(schema): add calculator pattern type`
5. `feat(ui): add id-only entry rename`
6. `fix(tagger): persist pattern discovery metadata`
7. `docs: document retag readiness gates`

---

## Self-Review

- Spec coverage: Covers a11y evidence, broader unsupported claims, palette stripping, calculator pattern, pattern discovery persistence, id-only rename, and retag spend gates.
- Migration posture: Lazy migration keeps legacy corpus valid and avoids lossy parsing.
- Main risk: Prompt-only grounding for prose fields is not perfectly enforceable. The plan mitigates this with observation tracing, sanitizer gates for the highest-risk structured field, and smoke retag inspection before bulk spend.
- Retag safety: Full retag is explicitly blocked until targeted and mixed smoke retags pass.
