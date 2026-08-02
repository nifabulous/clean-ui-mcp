# Deterministic Body + Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the deterministic `create_ui_spec` body from measured corpus facts and give both the deterministic and model paths real, shared grounding.

**Architecture:** Task 0 locks the coverage audit; Task 1 widens the closed `structuredFacts` allowlist and the recipe-owned summary builder; Task 2 changes automatic retrieval from a diversity-picked 5 to the top 3 ranked matches and adds the `noCorpusMatch` warning; Task 3 adds a pure `createUiSpecDeterministic` synthesizer (direction sentence, color-token plurality, layout regions) and wires it into `assembleSpec`; Task 4 reintroduces the model prompt's `evidenceSummaries` key (with a non-empty guard) under `POLICY_VERSION` v6.

**Tech Stack:** TypeScript, Zod, Vitest, node:fs (audit script).

## Global Constraints

- C3 served-content posture (product decision, 2026-08-02): served `evidence[].summary` and the model prompt both use ONE derived structured summary builder. No verbatim `critique`/`whatToSteal`/`voice` prose on the wire or in the prompt. `rejectedDefaults`, `voice`, and `mood` stay `unavailable` with reasons until the provenance-governance flip.
- The registered `create_ui_spec` tool description is unchanged ("No corpus content, path, url or product identity is ever returned").
- Corpus freeze invariant: nothing writes to `corpus/entries.json`; every test asserts corpus bytes unchanged.
- Token population rule: `colorTokens` are populated only when ≥ 3 matched entries contribute `visual.colorRoles`; otherwise `null` + an `unavailableDecisions` reason. `typographyTokens` stays `null` (the corpus records no mono role; see Task 3 deviation note).
- Model path invariant: whenever `spec.modelProposal` is present, root `colorTokens`/`typographyTokens` stay `null` and authority stays `editorial` (existing UiSpec superRefine — the synthesizer must NOT run against model proposals).
- `POLICY_VERSION` bumps exactly once in this plan: `c3-model-proposal-v5` → `c3-model-proposal-v6` (Task 4).
- Auto-retrieval caps at N=3. Zero matches → zero corpus evidence rows + `noCorpusMatch` warning; never fabricated content.
- Coverage floors enforced by the audit script: `visual.colorRoles` ≥ 600, `layout` ≥ 600.
- Every task is TDD: failing test → minimal implementation → passing test → commit.

## Task 0: Field-coverage audit + committed snapshot

**Files:**
- Create: `scripts/audit-corpus-coverage.mjs`
- Create: `scripts/audit-corpus-coverage.test.mjs`
- Create: `docs/superpowers/specs/coverage-2026-08-02.md` (snapshot output)

**Interfaces:**
- Consumes: `corpus/entries.json` (or an explicit corpus path argument).
- Produces: exit 0 + printed coverage table when floors hold; exit 1 + FAIL lines otherwise; the snapshot document committed from the script's output.

- [ ] **Step 1: Write the failing test**

Create `scripts/audit-corpus-coverage.test.mjs`:

```js
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, expect } from "vitest";

const SCRIPT = resolve(import.meta.dirname, "audit-corpus-coverage.mjs");

function fixtureCorpus(colorRoles, layout) {
  const root = mkdtempSync(join(tmpdir(), "audit-corpus-"));
  const entries = Array.from({ length: 10 }, (_, i) => ({
    id: `entry-${i}`,
    patternType: "dashboard",
    visual: {
      dominantColors: ["#000000"],
      accentColor: "#2563eb",
      typePairing: { display: "Inter", body: "Inter" },
      spacingDensity: "compact",
      cornerStyle: "slight-round",
      usesShadows: false,
      usesBorders: true,
      colorRoles: colorRoles ? {
        primary: "#2563eb", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb",
      } : undefined,
    },
    layout: layout ? { form: "two-column", regions: [{ role: "main-canvas" }] } : undefined,
  }));
  const path = join(root, "entries.json");
  writeFileSync(path, JSON.stringify({ version: "1", entries }));
  return { root, path };
}

test("audit passes when floors hold", () => {
  const { root, path } = fixtureCorpus(true, true);
  try {
    const out = execFileSync("node", [SCRIPT, path], { encoding: "utf8" });
    expect(out).toContain("colorRoles");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("audit fails when colorRoles coverage drops below the floor", () => {
  const { root, path } = fixtureCorpus(false, true);
  try {
    expect(() => execFileSync("node", [SCRIPT, path], { encoding: "utf8" })).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
```

Run: `npx vitest run scripts/audit-corpus-coverage.test.mjs`
Expected: FAIL — `audit-corpus-coverage.mjs` does not exist.

- [ ] **Step 2: Implement the audit script**

Create `scripts/audit-corpus-coverage.mjs`:

```js
#!/usr/bin/env node
/**
 * Field-coverage audit for the deterministic synthesizer. Prints the coverage
 * table over corpus/entries.json and exits 1 when any synthesis floor fails.
 * Usage: node scripts/audit-corpus-coverage.mjs [corpusPath]
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const corpusPath = process.argv[2] ?? resolve(process.cwd(), "corpus/entries.json");
const data = JSON.parse(readFileSync(corpusPath, "utf8"));
const entries = Array.isArray(data.entries) ? data.entries : data.entries ?? [];
const n = entries.length;

const count = (pred) => entries.filter(pred).length;
const nonEmpty = (v) => v !== undefined && v !== null && (!Array.isArray(v) ? String(v).trim().length > 0 : v.length > 0);

const rows = [
  ["visual.* (structured fields)", count((e) => Boolean(e.visual))],
  ["visual.colorRoles", count((e) => nonEmpty(e.visual?.colorRoles))],
  ["layout", count((e) => nonEmpty(e.layout))],
  ["voice", count((e) => nonEmpty(e.voice))],
  ["mood", count((e) => nonEmpty(e.mood))],
  ["top-level colorScheme", count((e) => nonEmpty(e.colorScheme))],
  ["whatToSteal / antiPatterns / critique", count((e) => nonEmpty(e.whatToSteal) && nonEmpty(e.antiPatterns) && nonEmpty(e.critique))],
];

console.log(`Coverage audit (${n} entries, ${corpusPath})`);
for (const [field, covered] of rows) {
  console.log(`${field}: ${covered}/${n}`);
}

const FLOORS = { "visual.colorRoles": 600, layout: 600 };
let failed = false;
for (const [field, floor] of Object.entries(FLOORS)) {
  const row = rows.find(([f]) => f === field);
  const covered = row ? row[1] : 0;
  if (covered < floor) {
    console.error(`FAIL: ${field} coverage ${covered} < floor ${floor}`);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 3: Run to verify it passes**

Run: `npx vitest run scripts/audit-corpus-coverage.test.mjs`
Expected: PASS.

- [ ] **Step 4: Generate and commit the snapshot**

Run: `node scripts/audit-corpus-coverage.mjs | tee docs/superpowers/specs/coverage-2026-08-02.md`
Expected: the table for the live 787-entry corpus, with `visual.colorRoles: 688/787` and `layout: 704/787`, exit 0.

```bash
git add scripts/audit-corpus-coverage.mjs scripts/audit-corpus-coverage.test.mjs docs/superpowers/specs/coverage-2026-08-02.md
git commit -m "feat(corpus): field-coverage audit with committed snapshot

audit-corpus-coverage.mjs prints the synthesis coverage table and fails
when colorRoles < 600 or layout < 600; the 2026-08-02 snapshot locks the
measured 688/787 colorRoles and 704/787 layout baselines."
```

## Task 1: Widen `structuredFacts` + richer derived summaries

**Files:**
- Modify: `src/create-ui-spec-contracts.ts` (`StructuredFactsSchema`)
- Modify: `src/c3/safe-aggregator.ts` (`buildCorpusObservationSummary`)
- Modify: `src/create-ui-spec.ts` (`sanitizeCorpusObservation` projection)
- Test: `src/create-ui-spec-contracts.test.ts` + `src/c3/safe-aggregator.test.ts` (or the nearest existing test for each)

**Interfaces:**
- Consumes: `SanitizedEvidence` (existing), `entry.visual` / `entry.layout` (existing `CorpusEntryT`).
- Produces: `structuredFacts` gains `spacingDensity`, `cornerStyle`, `usesShadows`, `usesBorders`, `accentColor`, `colorRoles`, `typePairing`, `layoutForm`, `layoutRoles`; `buildCorpusObservationSummary` emits the richer derived sentence. Both remain closed/allowlisted.

- [ ] **Step 1: Write the failing summary test**

In the test file that covers `buildCorpusObservationSummary` (create it at `src/c3/safe-aggregator.test.ts` if none exists, following the repo's test naming), add:

```ts
import { describe, expect, it } from "vitest";
import { buildCorpusObservationSummary } from "./safe-aggregator.js";

describe("buildCorpusObservationSummary", () => {
  it("builds a derived sentence from every populated structured fact", () => {
    const summary = buildCorpusObservationSummary({
      id: "evidence-2",
      kind: "corpus-observation",
      basis: "visible",
      summary: "",
      structuredFacts: {
        pattern: "dashboard",
        regionCount: 3,
        spacingDensity: "compact",
        cornerStyle: "slight-round",
        usesShadows: false,
        usesBorders: true,
        accentColor: "#2563eb",
        typePairing: "Inter / Inter",
      },
    } as never);
    expect(summary).toContain("dashboard reference");
    expect(summary).toContain("3 regions");
    expect(summary).toContain("compact spacing");
    expect(summary).toContain("slight-round corners");
    expect(summary).toContain("no shadows");
    expect(summary).toContain("borders");
    expect(summary).toContain("accent #2563eb");
    expect(summary).toContain("Inter / Inter");
    expect(summary.length).toBeLessThanOrEqual(500);
  });
});
```

Run: `npx vitest run src/c3/safe-aggregator.test.ts`
Expected: FAIL — the template emits only the pattern/regions sentence.

- [ ] **Step 2: Extend `StructuredFactsSchema`**

In `src/create-ui-spec-contracts.ts`, update the import from `./schema.js` to also bring `SpacingDensity`, `CornerStyle`, `HexColor`, `LayoutRegion`, and `LayoutStructure` (all are exported), then replace `StructuredFactsSchema`:

```ts
const LayoutFormEnum = z.enum(["single-column", "two-column", "three-column", "modal-overlay"]);
const LayoutRoleEnum = z.enum([
  "primary-nav", "icon-nav", "summary-strip", "main-canvas",
  "detail-rail", "form-panel", "visual-panel", "overlay-card",
]);

/**
 * The allowlist of structured-facts keys the recipe may populate. Closed set
 * of enum/count/boolean/hex fields — NO free-form prose. Every row is typed so
 * a stray private excerpt cannot sneak in. `colorRoles` mirrors the CORPUS
 * schema exactly — `canvas/surface/ink/muted/accent` with `muted` NULLABLE
 * (src/schema.ts:420-426) — NOT UiSpec's five-token vocabulary; the
 * synthesizer maps roles into UiSpec ColorTokens via the existing
 * design-prompt.ts merge semantics (see Task 3). `typePairing` is the DERIVED
 * "display / body" string; `layoutForm`/`layoutRoles` are the wireframe's
 * closed tokens.
 */
const StructuredFactsSchema = z
  .object({
    pattern: PatternType.optional(),
    regionCount: z.number().int().nonnegative().max(50).optional(),
    columnCount: z.number().int().nonnegative().max(20).optional(),
    usesStickyHeader: z.boolean().optional(),
    usesIconography: z.boolean().optional(),
    spacingDensity: SpacingDensity.optional(),
    cornerStyle: CornerStyle.optional(),
    usesShadows: z.boolean().optional(),
    usesBorders: z.boolean().optional(),
    accentColor: HexColor.optional(),
    colorRoles: z.object({
      canvas: HexColor,
      surface: HexColor,
      ink: HexColor,
      muted: HexColor.nullable(),
      accent: HexColor,
    }).optional(),
    typePairing: z.string().trim().min(1).max(120).optional(),
    layoutForm: LayoutFormEnum.optional(),
    layoutRoles: z.array(LayoutRoleEnum).max(8).optional(),
  })
  .strict();
```

If `HexColor`, `SpacingDensity`, `CornerStyle`, `LayoutRegion`, or `LayoutStructure` are not exported from `schema.js`, export them there first (they are defined at `src/schema.ts:135-136`, `:316`, `:405`; the plan assumes exports exist — if not, add `export` in the same commit).

- [ ] **Step 3: Rewrite `buildCorpusObservationSummary`**

In `src/c3/safe-aggregator.ts`, replace the function body:

```ts
export function buildCorpusObservationSummary(evidence: SanitizedEvidence): string {
  const f = evidence.structuredFacts;
  const parts: string[] = [];
  if (f.pattern) parts.push(`${f.pattern} reference`);
  if (typeof f.regionCount === "number") parts.push(`${f.regionCount} regions`);
  if (f.spacingDensity) parts.push(`${f.spacingDensity} spacing`);
  if (f.cornerStyle) parts.push(`${f.cornerStyle} corners`);
  if (f.usesShadows === true) parts.push("shadows");
  if (f.usesShadows === false) parts.push("no shadows");
  if (f.usesBorders === true) parts.push("borders");
  if (f.usesBorders === false) parts.push("no borders");
  if (f.accentColor) parts.push(`accent ${f.accentColor}`);
  if (f.typePairing) parts.push(f.typePairing);
  if (f.layoutForm) parts.push(`layout ${f.layoutForm}`);
  return parts.length > 0 ? parts.join(", ") : "Corpus observation reference";
}
```

This stays recipe-owned: every fragment interpolates a closed token; no prose field is ever read.

- [ ] **Step 4: Extend the projection**

In `src/create-ui-spec.ts`, in `sanitizeCorpusObservation`, after the existing `regionCount` block, add:

```ts
  const visual = entry.visual;
  if (visual?.spacingDensity) structuredFacts.spacingDensity = visual.spacingDensity;
  if (visual?.cornerStyle) structuredFacts.cornerStyle = visual.cornerStyle;
  if (typeof visual?.usesShadows === "boolean") structuredFacts.usesShadows = visual.usesShadows;
  if (typeof visual?.usesBorders === "boolean") structuredFacts.usesBorders = visual.usesBorders;
  if (visual?.accentColor) structuredFacts.accentColor = visual.accentColor;
  if (visual?.colorRoles) structuredFacts.colorRoles = {
    canvas: visual.colorRoles.canvas,
    surface: visual.colorRoles.surface,
    ink: visual.colorRoles.ink,
    muted: visual.colorRoles.muted, // nullable per the corpus schema
    accent: visual.colorRoles.accent,
  };
  const pairing = visual?.typePairing;
  if (pairing?.display && pairing.body) {
    structuredFacts.typePairing = `${pairing.display} / ${pairing.body}`;
  }
  const layoutStructure = entry.layout;
  if (layoutStructure?.form) structuredFacts.layoutForm = layoutStructure.form;
  const roles = layoutStructure?.regions?.map((r) => r.role).filter(Boolean);
  if (roles && roles.length > 0) structuredFacts.layoutRoles = roles.slice(0, 8);
```

(`visual` is non-optional on `CorpusEntryT`; the optional chaining is defensive only.)

- [ ] **Step 5: Write the real-corpus round-trip test**

Append to `src/create-ui-spec.test.ts`:

```ts
it("round-trips a real-shaped corpus entry through the widened projection", async () => {
  // The exact bug class this pins: a `primary`-shaped fact (the old draft)
  // made every real entry fail SanitizedEvidenceSchema and look like a
  // retrieval failure. A real-shaped entry — canvas/surface/ink/muted/accent,
  // muted nullable (src/schema.ts:420-426) — must survive with colorRoles
  // intact and a summary that includes the derived accent.
  const entry = {
    patternType: "dashboard",
    layout: { form: "three-column", regions: [{ role: "primary-nav" }, { role: "main-canvas" }] },
    visual: {
      colorRoles: { canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: null, accent: "#2563eb" },
      spacingDensity: "compact", cornerStyle: "slight-round",
      usesShadows: false, usesBorders: true,
      accentColor: "#2563eb", typePairing: { display: "Inter", body: "Inter" },
    },
  } as unknown as CorpusEntryT;
  const out = await createUiSpecForAdapter(
    { productContext: "A dashboard", referenceIds: [], constraints: [], motionIntents: [] },
    makeCreateUiSpecDependencies(makeReaderWithRanked([entry])),
  );
  const row = out.sanitizedEvidence.find((e) => e.kind === "corpus-observation");
  expect(row).toBeDefined();
  if (!row) return;
  expect(SanitizedEvidenceSchema.safeParse(row).success).toBe(true);
  expect(row.structuredFacts.colorRoles).toEqual({
    canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: null, accent: "#2563eb",
  });
  expect(row.summary).toContain("accent #2563eb");
});
```

`SanitizedEvidenceSchema` and `CorpusEntryT` are already imported in
`src/create-ui-spec.test.ts`; `makeReaderWithRanked` is the Task 2 reader helper
(or the existing ranked helper in the same file).

Run: `npx vitest run src/create-ui-spec.test.ts -t "round-trips"`
Expected: FAIL — the current projection drops colorRoles/spacingDensity/corners.

- [ ] **Step 6: Update the pinned production-template fixtures (required, not conditional)**

The old `buildCorpusObservationSummary` template (`"<pattern> reference with N
regions"`) is pinned verbatim in fixtures that will NOT fail on their own — the
content screen accepts any string, so a stale pin is silent. Both must be
updated to the new derived sentence:

- `src/create-ui-spec-contracts.test.ts:349` ("still accepts every summary the
  production templates emit") — replace `"dashboard reference with 3 regions"`
  with the new derived form (e.g. `"dashboard reference, 3 regions, compact
  spacing, slight-round corners, no shadows, borders, accent #2563eb, Inter /
  Inter, layout three-column"`) and update the "three real producer templates"
  comment.
- `src/create-ui-spec.test.ts` — any assertion or comment matching the old
  template must be updated; verify none remain with
  `rg -n "reference with" src/` (expected: no matches).

- [ ] **Step 7: Run the affected suites**

Run: `npx vitest run src/c3/safe-aggregator.test.ts src/create-ui-spec-contracts.test.ts src/create-ui-spec.test.ts src/create-ui-spec-model-path.test.ts`
Expected: PASS, with no fixture or comment pinning the old template.

- [ ] **Step 8: Commit**

```bash
git add src/schema.ts src/create-ui-spec-contracts.ts src/c3/safe-aggregator.ts src/create-ui-spec.ts src/c3/safe-aggregator.test.ts
git commit -m "feat(corpus): widen structuredFacts and derived summary builder

structuredFacts gains the closed visual/layout tokens (density, corners,
shadow/border flags, accent, colorRoles, typePairing, layout form/roles);
buildCorpusObservationSummary emits one derived sentence from those tokens
only, keeping the recipe-owned no-prose invariant."
```

## Task 2: Auto-retrieval top-3 + `noCorpusMatch` warning

**Files:**
- Modify: `src/create-ui-spec.ts` (`resolveAutomaticRetrieval`)
- Modify: `src/tool-contracts.ts` (`create_ui_spec` descriptor warning codes)
- Test: `src/create-ui-spec.test.ts` (retrieval-state tests) + `src/create-ui-spec-mcp.test.ts` (warning fixtures, if any assert the exact code set)

**Interfaces:**
- Consumes: `dependencies.reader.searchRanked` (existing), `dependencies.reader.search` (existing, zero-match seed path), `RetrievalState` (existing).
- Produces: top-3 ranked corpus observations (no diversity pick); `noCorpusMatch` warning code; zero-match path unchanged in retrieval state (`structured-fallback`).

**Prerequisite (required):** the similarity fallback in Step 3 depends on the
embedding index. `findSimilarEntries` returns `[]` when the index is missing
(`src/corpus.ts:414-419` — documented "caller tells the user to run
build-index"), so a fresh checkout silently falls through to `noCorpusMatch`
even when the corpus has matches. Run `npm run build-index` once before Step 3
and include it in the task's verification in Step 5.

- [ ] **Step 1: Write the failing retrieval test**

In `src/create-ui-spec.test.ts`, add a fixture reader whose `searchRanked` returns 5 ranked entries and assert the resolved evidence carries exactly 3 corpus observations:

```ts
it("automatic retrieval caps at the top 3 ranked matches", async () => {
  const reader = makeReaderWithRanked(5); // helper: searchRanked resolves 5 entries, ranked 0..4
  const out = await createUiSpecForAdapter(
    { productContext: "A dashboard for finance ops", referenceIds: [], constraints: [], motionIntents: [] },
    makeCreateUiSpecDependencies(reader),
  );
  const corpusRows = out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation");
  expect(corpusRows).toHaveLength(3);
  expect(out.envelope.retrieval.resultCount).toBe(3);
});
```

Use the existing test-file reader helpers (mirror `makeReader` / `searchRanked` stubs already in `src/create-ui-spec.test.ts`; if the file lacks a ranked helper, add one returning `SearchResult[]` with `{ entry, score, ... }` per the `SearchResult` shape from `src/corpus-reader.ts`).

Run: `npx vitest run src/create-ui-spec.test.ts -t "caps at the top 3"`
Expected: FAIL — the current code picks 5 via `pickDiverse`.

- [ ] **Step 2: Implement the top-3 slice**

In `src/create-ui-spec.ts`, in `resolveAutomaticRetrieval`, replace the `diverse` selection:

```ts
  // Plan 2: top-3 by rank — no product-diversity pick. A diverse-but-
  // irrelevant slice was the original sin: it traded relevance for coverage
  // and left thin briefs steered by label classes. The corpus long tail is
  // honest about weak matches instead.
  const top = results.slice(0, 3);
```

and replace the `for (const r of diverse)` loop with `for (const r of top)`, keeping the `sanitizeCorpusObservation` call and `corpusCount` accounting identical. Delete the now-unused `pickDiverse` call and its import if the helper is not used elsewhere.

- [ ] **Step 3: Embeddings fallback on zero keyword matches**

Still in `resolveAutomaticRetrieval`, make the selection fall back to the id-based similarity index when keyword returns nothing:

```ts
  // Keyword search first; when it matches nothing, seed the id-based
  // similarity index (findSimilar) from the plain search's top hit.
  let top = results.slice(0, 3);
  if (top.length === 0) {
    const seeded = await dependencies.reader.search({
      query: request.productContext,
      platform: request.platform,
      limit: 1,
    });
    const seed = seeded[0];
    if (seed) {
      const similar = dependencies.reader.findSimilar(seed.id, 3);
      // SimilarResult is { entry: CorpusEntryT, score: number } —
      // src/corpus.ts:414-427. The entry is always present.
      top = similar.map((s) => ({ entry: s.entry }));
    }
  }
```

`CorpusEntryT` is already imported in `src/create-ui-spec.ts`. The retrieval-state accounting stays: a successful similarity expansion reports `mode: "keyword"` with `corpusCount` rows (the state machine is unchanged); zero rows still lands in the `structured-fallback` branch.

Add the matching test to `src/create-ui-spec.test.ts`:

```ts
it("falls back to the similarity index when keyword search matches nothing", async () => {
  const reader = {
    ...baseReader(), // existing helper: searchRanked resolves []
    search: vi.fn(async () => [seedEntry()]),        // one seed
    findSimilar: vi.fn(() => [similarResult(seedEntry()), similarResult(entryB()), similarResult(entryC())]),
  } as unknown as CorpusReader;
  const out = await createUiSpecForAdapter(noRefRequest(), makeCreateUiSpecDependencies(reader));
  const corpusRows = out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation");
  expect(corpusRows).toHaveLength(3);
  expect(out.envelope.retrieval.resultCount).toBe(3);
});

it("reports noCorpusMatch when both keyword and similarity return nothing", async () => {
  const reader = {
    ...baseReader(),
    search: vi.fn(async () => []),
    findSimilar: vi.fn(() => []),
  } as unknown as CorpusReader;
  const out = await createUiSpecForAdapter(noRefRequest(), makeCreateUiSpecDependencies(reader));
  expect(out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation")).toHaveLength(0);
  expect(out.envelope.warnings.map((w) => w.code)).toContain("noCorpusMatch");
});
```

`baseReader`, `seedEntry`, `similarResult`, and `noRefRequest` are helpers to add in the same test file following its existing reader-fixture pattern. `CorpusReader` and `vi` are already imported there.

- [ ] **Step 4: Add the `noCorpusMatch` warning code**

In `src/tool-contracts.ts`, in the `create_ui_spec` descriptor's `warningSchema`, add `"noCorpusMatch"` to the list:

```ts
    warningSchema: makeWarningSchema(["sparseCoverage", "insufficientCorpusEvidence", "motionEvidenceUnavailable", "authorityConflict", "noCorpusMatch"]),
```

In `src/create-ui-spec.ts`, in `buildWarnings`, inside the `structured-fallback` branch, after the `sparseCoverage` push:

```ts
    warnings.push({
      code: "noCorpusMatch",
      message: "No corpus entry matched this brief; no grounding evidence is served.",
    });
```

- [ ] **Step 5: Run the affected suites**

Run: `npx vitest run src/create-ui-spec.test.ts src/create-ui-spec-mcp.test.ts`
Expected: PASS. If a fixture asserts the exact warning-code set (search for `sparseCoverage` in `src/**/*.test.ts`), add `noCorpusMatch` to that fixture.

- [ ] **Step 6: Commit**

```bash
git add src/create-ui-spec.ts src/tool-contracts.ts
git commit -m "feat(create-ui-spec): top-3 ranked auto-retrieval + noCorpusMatch

Automatic retrieval keeps the 3 highest-ranked matches instead of a
diversity-picked 5, and a zero-match request reports the new
noCorpusMatch warning alongside sparseCoverage."
```

## Task 3: Deterministic synthesis — new module + `assembleSpec` wiring

**Files:**
- Create: `src/create-ui-spec-deterministic.ts`
- Create: `src/create-ui-spec-deterministic.test.ts`
- Modify: `src/create-ui-spec.ts` (`assembleSpec`)
- Test: `src/create-ui-spec.test.ts` (deterministic-body assertions that pin token-null / echo-direction behavior)
- Test: `scripts/dogfood-createuispec.mjs` (`assertTokensUnavailable` usage on non-model envelopes)

**Interfaces:**
- Consumes: `SanitizedEvidence` (existing), `CreateUiSpecRequest` (existing), `UiSpec` shapes (`ColorTokens` five-string, `LayoutRegion` `{name,type,components,responsive}`).
- Produces: `createUiSpecDeterministic(evidence, request): DeterministicSynthesis` with `designDirection: string | null`, `colorTokens: ColorTokens | null`, `layoutRegions: LayoutRegion[]`, `responsiveBehavior: string[]`.

**Deviation note (flagged for the reviewer):** `typographyTokens` stays `null` with an `unavailableDecisions` reason — the corpus records only a display/body pairing (`TypePairing` at `src/schema.ts:405`), and `UiSpec.TypographyTokens` requires a `mono` member; deriving one would be invention under the governing invariant. The plurality logic for heading/body is implemented anyway (see Step 2) so the moment a mono source exists the output can light up.

- [ ] **Step 1: Write the failing synthesis test**

Create `src/create-ui-spec-deterministic.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createUiSpecDeterministic } from "./create-ui-spec-deterministic.js";

function observation(id: string, facts: Record<string, unknown>): never {
  return { id, kind: "corpus-observation", basis: "visible", summary: "derived", structuredFacts: facts } as never;
}

const REQUEST = { productContext: "Internal analytics workspace for finance operators", constraints: [], motionIntents: [] } as never;

describe("createUiSpecDeterministic", () => {
  it("synthesizes direction, token plurality, and layout regions from matched facts", () => {
    const evidence = [
      observation("evidence-2", {
        pattern: "dashboard", spacingDensity: "compact", cornerStyle: "slight-round",
        usesShadows: false, usesBorders: true, accentColor: "#2563eb",
        colorRoles: { canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
        layoutForm: "three-column", layoutRoles: ["primary-nav", "main-canvas", "detail-rail"],
      }),
      observation("evidence-3", {
        pattern: "dashboard", spacingDensity: "compact", cornerStyle: "sharp",
        usesShadows: false, usesBorders: true,
        colorRoles: { canvas: "#f8fafc", surface: "#ffffff", ink: "#0f172a", muted: "#64748b", accent: "#1d4ed8" },
      }),
      observation("evidence-4", {
        pattern: "data-table", spacingDensity: "compact", cornerStyle: "slight-round",
        usesShadows: false, usesBorders: true,
        colorRoles: { canvas: "#f8fafc", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
      }),
    ] as never;

    const out = createUiSpecDeterministic(evidence, REQUEST);

    expect(out.designDirection).toContain("evidence-2");
    expect(out.designDirection).toContain("compact");
    // UiSpec primary and accent both resolve to the corpus accent plurality
    // (the corpus records ONE interactive color; the vocabulary split is a
    // documented mapping, not an invention).
    expect(out.colorTokens).toEqual({
      primary: "#2563eb", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb",
    });
    expect(out.layoutRegions.map((r) => r.name)).toEqual(["primary-nav", "main-canvas", "detail-rail"]);
    expect(out.responsiveBehavior).toContain("form: three-column");
  });

  it("returns nulls and empty arrays when no corpus observation matched", () => {
    const out = createUiSpecDeterministic([], REQUEST);
    expect(out.designDirection).toBeNull();
    expect(out.colorTokens).toBeNull();
    expect(out.layoutRegions).toEqual([]);
  });

  it("never populates tokens from fewer than three contributing entries", () => {
    const evidence = [
      observation("evidence-2", { pattern: "dashboard", colorRoles: { canvas: "#fff", surface: "#fff", ink: "#111", muted: "#666", accent: "#2563eb" } }),
      observation("evidence-3", { pattern: "dashboard" }),
    ] as never;
    expect(createUiSpecDeterministic(evidence, REQUEST).colorTokens).toBeNull();
  });

  it("never fabricates default tokens when no entry has colorRoles", () => {
    const evidence = [
      observation("evidence-2", { pattern: "dashboard", spacingDensity: "compact" }),
      observation("evidence-3", { pattern: "dashboard", spacingDensity: "compact" }),
      observation("evidence-4", { pattern: "dashboard", spacingDensity: "compact" }),
    ] as never;
    expect(createUiSpecDeterministic(evidence, REQUEST).colorTokens).toBeNull();
  });
});
```

Run: `npx vitest run src/create-ui-spec-deterministic.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 2: Implement the module**

First, export the existing module-local `plurality` helper from
`src/design-prompt.ts` (it already implements the majority-vote counting used
by `generateBrief`) so the new module reuses it instead of duplicating the
function:

```ts
export function plurality<T>(values: readonly T[]): T | undefined { /* existing body, unchanged */ }
```

The role MAPPING stays per-consumer — `generateBrief` emits `canvas` while the
deterministic synthesizer emits UiSpec `primary = accent` (the corpus records
one interactive color; the plan's documented mapping) — but the counting logic
is shared, so there is exactly one `plurality` in the codebase.

Create `src/create-ui-spec-deterministic.ts`:

```ts
import type { SanitizedEvidence } from "./create-ui-spec-contracts.js";
import type { CreateUiSpecRequest } from "./create-ui-spec-contracts.js";
import { plurality } from "./design-prompt.js";

export interface DeterministicColorTokens {
  primary: string;
  surface: string;
  ink: string;
  muted: string;
  accent: string;
}

export interface DeterministicLayoutRegion {
  name: string;
  type: string;
  components: readonly string[];
  responsive: readonly string[];
}

export interface DeterministicSynthesis {
  /** null → keep the recipe's brief echo (no corpus match). */
  designDirection: string | null;
  /** null → tokens stay unavailable (fewer than 3 contributing entries). */
  colorTokens: DeterministicColorTokens | null;
  layoutRegions: readonly DeterministicLayoutRegion[];
  responsiveBehavior: readonly string[];
}

function majority(values: readonly boolean[]): boolean | undefined {
  const yes = values.filter(Boolean).length;
  const no = values.length - yes;
  if (yes === no) return undefined;
  return yes > no;
}

/**
 * Pure, deterministic body synthesis from matched corpus observations.
 * Reads ONLY closed structuredFacts tokens — never critique/whatToSteal/voice
 * prose (C3 served-content posture). Cited evidence ids are the response-
 * scoped ids already in the sanitized rows.
 */
export function createUiSpecDeterministic(
  evidence: readonly SanitizedEvidence[],
  request: CreateUiSpecRequest,
): DeterministicSynthesis {
  const observations = evidence.filter((e) => e.kind === "corpus-observation" && e.structuredFacts);
  if (observations.length === 0) {
    return { designDirection: null, colorTokens: null, layoutRegions: [], responsiveBehavior: [] };
  }

  const ids = observations.map((o) => o.id);
  const facts = observations.map((o) => o.structuredFacts);

  // Color-token plurality over the CORPUS role shape (canvas/surface/ink/
  // muted/accent, muted nullable — src/schema.ts:420-426), then mapped into
  // UiSpec ColorTokens with the same defaults the existing design-prompt.ts
  // merge uses. NEVER run on fewer than 3 contributing entries, and never when
  // zero entries have colorRoles (Math.min over empty arrays is Infinity —
  // that bug would fabricate a default palette).
  const withRoles = facts.filter((f) => f.colorRoles);
  const colorTokens = withRoles.length >= 3
    ? {
        primary: plurality(withRoles.map((f) => f.colorRoles!.accent)) ?? "#3b82f6",
        surface: plurality(withRoles.map((f) => f.colorRoles!.surface)) ?? "#f8f8f8",
        ink: plurality(withRoles.map((f) => f.colorRoles!.ink)) ?? "#111111",
        muted: plurality(withRoles.map((f) => f.colorRoles!.muted).filter((v): v is string => v !== null)) ?? "#888888",
        accent: plurality(withRoles.map((f) => f.colorRoles!.accent)) ?? "#3b82f6",
      }
    : null;

  // Layout regions from the wireframe roles (closed enum), deduped in order.
  const seen = new Set<string>();
  const layoutRegions: DeterministicLayoutRegion[] = [];
  for (const f of facts) {
    for (const role of f.layoutRoles ?? []) {
      if (seen.has(role)) continue;
      seen.add(role);
      layoutRegions.push({ name: role, type: role, components: [], responsive: [] });
    }
  }
  const layoutForms = facts.map((f) => f.layoutForm).filter((v): v is NonNullable<typeof v> => Boolean(v));
  const layoutForm = plurality(layoutForms);
  const responsiveBehavior = layoutForm ? [`form: ${layoutForm}`] : [];

  // Direction: one recipe-voice sentence built ONLY from pluralities of the
  // closed facts, citing the evidence ids it draws from.
  const density = plurality(facts.map((f) => f.spacingDensity).filter((v): v is NonNullable<typeof v> => Boolean(v)));
  const corners = plurality(facts.map((f) => f.cornerStyle).filter((v): v is NonNullable<typeof v> => Boolean(v)));
  const shadows = majority(facts.filter((f) => typeof f.usesShadows === "boolean").map((f) => f.usesShadows as boolean));
  const borders = majority(facts.filter((f) => typeof f.usesBorders === "boolean").map((f) => f.usesBorders as boolean));
  const pairings = facts.map((f) => f.typePairing).filter((v): v is NonNullable<typeof v> => Boolean(v));
  const pairing = plurality(pairings);

  const clauses: string[] = [];
  if (density) clauses.push(`${density} spacing`);
  if (corners) clauses.push(`${corners} corner treatment`);
  if (shadows !== undefined) clauses.push(shadows ? "soft shadows" : "no shadows");
  if (borders !== undefined) clauses.push(borders ? "hairline borders" : "no borders");
  if (layoutForm) clauses.push(`a ${layoutForm} layout`);
  if (pairing) clauses.push(`${pairing} typography`);

  const designDirection = clauses.length > 0
    ? `Ground this ${request.productContext} in the matched corpus references (${ids.join(", ")}): `
      + `the strongest shared signals are ${clauses.join(", ")}. `
      + `Let those signals lead the layout before adding anything not evidenced by the matched examples.`
    : null;

  return { designDirection, colorTokens, layoutRegions, responsiveBehavior };
}
```

If `SanitizedEvidence`'s `structuredFacts` typing rejects `layoutRoles`/`colorRoles` access, the Task 1 schema change is the fix (it widened the same allowlist); re-run after Task 1 completes.

- [ ] **Step 3: Run to verify it passes**

Run: `npx vitest run src/create-ui-spec-deterministic.test.ts`
Expected: PASS.

- [ ] **Step 4: Wire into `assembleSpec`**

In `src/create-ui-spec.ts`, in `assembleSpec`, after `const specFields = mapCandidateToSpecFields(parsedCandidate);` add:

```ts
  // Deterministic synthesis (Plan 2): corpus-grounded direction, token
  // plurality, and layout regions — ONLY on the no-model path. When a model
  // proposal is present, NONE of the synthesis applies: the root direction
  // keeps the recipe echo, root tokens stay null (UiSpec superRefine), and
  // the proposal is the only direction content. Gating the whole synthesis
  // object (not just the token fields) is deliberate — a corpus-synthesized
  // root direction on the model path would be a behavior change the spec
  // never approved.
  const synthesis = proposal === undefined
    ? createUiSpecDeterministic(evidence, request)
    : null;
```

Then change the spec assembly:

```ts
    designDirection: synthesis?.designDirection ?? specFields.designDirection,
    rejectedDefaults: specFields.rejectedDefaults,
    layoutRegions: synthesis && synthesis.layoutRegions.length > 0
      ? synthesis.layoutRegions
      : specFields.layoutRegions,
    responsiveBehavior: synthesis && synthesis.responsiveBehavior.length > 0
      ? synthesis.responsiveBehavior
      : specFields.responsiveBehavior,
    componentInventory: specFields.componentInventory,
    colorTokens: synthesis?.colorTokens ?? null,
    colorTokenAuthority: "editorial",
    typographyTokens: null,
    typographyTokenAuthority: "editorial",
```

and replace the `citedDecisions` construction with a synthesis-aware version.
The synthesized direction text cites the corpus observation ids, so the
citation ledger must match: the recipe's editorial `designDirection` decision
is REPLACED (not augmented) by a corpus-authority decision citing those ids,
when synthesis supplied the direction. Without this, the direction text cites
`evidence-2..4` while `citedDecisions` claims the recipe id — a citation-
consistency violation that would fail the shared gate's authority checks
(`src/tool-contracts.ts:816-848`) and break the honesty invariant:

```ts
  const recipeDecisions = buildCitedDecisions(editorialLane);
  const citedDecisions = synthesis?.designDirection
    ? [
        ...recipeDecisions.filter((d) => d.field !== "designDirection"),
        {
          id: "designDirection-corpus-synthesis",
          field: "designDirection",
          // The authority token must match the CitedDecision authority enum
          // (the corpusEvidence lane's token — see tool-contracts.ts).
          authority: "corpusEvidence",
          evidenceIds: corpusEvidenceIds,
          readiness: "available",
        },
      ]
    : recipeDecisions;
```

`corpusEvidenceIds` already contains exactly the corpus observation ids in
response order (it is also the `corpusLane`), so the new decision cites the
same ids the direction text names and the lane already carries them.

and extend `unavailableDecisions` (before the UiSpec parse) with the C3-excluded fields:

```ts
  // C3 served-content posture: prose-judgment fields stay unavailable with
  // recipe-owned reasons until the provenance-governance flip permits them.
  const c3Unavailable: UiSpecT["unavailableDecisions"] = [
    { field: "rejectedDefaults", reason: "Anti-pattern prose is not served; derived from corpus judgments after governance." },
    { field: "voice", reason: "Voice analysis prose is not served until provenance governance lands." },
    { field: "mood", reason: "Mood is not served until provenance governance lands." },
  ];
  const unavailableDecisions: UiSpecT["unavailableDecisions"] = [
    ...RECIPE.unavailableDecisions.map((d) => ({ field: d.field, reason: d.reason })),
    ...(synthesis !== null && synthesis.colorTokens === null
      ? [{ field: "colorTokens", reason: "Fewer than 3 matched entries contribute color roles." }]
      : []),
    ...c3Unavailable,
  ];
```

Add the import at the top of `src/create-ui-spec.ts`: `import { createUiSpecDeterministic } from "./create-ui-spec-deterministic.js";`

Note: `rejectedDefaults` stays the recipe's empty array per C3 (the field is NOT populated); the `unavailableDecisions` row explains why.

- [ ] **Step 5: Update deterministic-body assertions**

Run: `npx vitest run src/create-ui-spec.test.ts src/create-ui-spec-model-path.test.ts src/create-ui-spec-mcp.test.ts`
Expected: FAILS where tests pin the old deterministic body — token-null, echo-only direction, or exact `unavailableDecisions`. Update those fixtures:
- Assertions of the form `colorTokens === null` on the NO-MODEL path become "populated when the fixture corpus provides ≥ 3 colorRole entries, else null + reason"; the fixture corpus in each test file is small, so expect `null` with the `colorTokens` reason row in most unit fixtures.
- Tests that assert `unavailableDecisions` by exact array must add the new `rejectedDefaults`/`voice`/`mood` rows (and the conditional `colorTokens` row).
- `expectDeterministicIdentity` baselines in `create-ui-spec-model-path.test.ts` recompute `deterministicBaseline()` with the same synthesis, so identity assertions still hold unchanged.
- In `scripts/dogfood-createuispec.mjs`, `assertTokensUnavailable` is called on non-model envelopes; change it to assert `envelope.spec.colorTokenAuthority === "editorial"` and that any non-null `colorTokens` values are hex-shaped (`/^#[0-9a-fA-F]{3,8}$/`), and keep the model-proposal cases asserting null tokens (the UiSpec refinement already enforces that).

**New tests required by the review fixes (add to the Step 5 test updates):**

1. **Model-path gating (D4):** in `src/create-ui-spec-model-path.test.ts` add a fixture where the reader returns 3 corpus observations with `colorRoles`; assert (a) no-model run: root `designDirection` contains the corpus evidence ids and `colorTokens` is populated; (b) model-success run with the same reader: root `designDirection` is the recipe echo (NOT corpus-synthesized), root `colorTokens`/`typographyTokens` are null, and `modelProposal` is present.
2. **Citation ledger (D3):** in `src/create-ui-spec.test.ts` (deterministic path with a 3-observation fixture), assert `citedDecisions` contains `designDirection-corpus-synthesis` with `evidenceIds` equal to the corpus observation ids, contains NO `designDirection-editorial-1`, and `parseToolResult` / the envelope parse passes the citation-consistency gate.
3. **No-fabrication (D5):** already added to `create-ui-spec-deterministic.test.ts` in Step 1 (the "never fabricates default tokens" case); also assert the `colorTokens` unavailableDecision row is present when it fires.

- [ ] **Step 6: Run the affected suites**

Run: `npx vitest run src/create-ui-spec-deterministic.test.ts src/create-ui-spec.test.ts src/create-ui-spec-model-path.test.ts src/create-ui-spec-mcp.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/create-ui-spec-deterministic.ts src/create-ui-spec-deterministic.test.ts src/create-ui-spec.ts scripts/dogfood-createuispec.mjs
git commit -m "feat(create-ui-spec): corpus-grounded deterministic body

createUiSpecDeterministic synthesizes direction, color-token plurality,
and layout regions from closed structuredFacts on the no-model path;
rejectedDefaults/voice/mood stay unavailable per the C3 posture, and
token population requires >= 3 contributing entries."
```

## Task 4: Reintroduce `evidenceSummaries` (v6) + rewrite the Plan 1 grounding test

**Files:**
- Modify: `src/create-ui-spec-model.ts` (`buildPrompt` — reintroduce key with guard, `POLICY_VERSION` v6)
- Test: `src/create-ui-spec-model.test.ts` (rewrite the Plan 1 grounding-honesty test)

**Interfaces:**
- Consumes: `SanitizedEvidence` (now with derived summaries from Task 1).
- Produces: `evidenceSummaries` present only when non-recipe rows with non-empty summaries exist; `c3-model-proposal-v6`.

- [ ] **Step 1: Rewrite the grounding test**

In `src/create-ui-spec-model.test.ts`, replace the Plan 1 `grounding honesty` describe (the "no evidenceSummaries key" test) with:

```ts
describe("createUiSpecModel grounding honesty", () => {
  it("includes evidenceSummaries only when real (non-recipe) summaries exist", async () => {
    const runtime = buildRuntime();
    const result = await createUiSpecModel(buildInput(), runtime);
    expect(result.kind).toBe("accepted");
    const [request] = runtime.call.mock.calls[0] as [Parameters<CreateUiSpecModelRuntime["call"]>[0]];
    // buildInput carries recipe-system + public-reference rows; the recipe
    // row is excluded, the public-reference summary is real.
    expect(request.prompt).toContain("evidenceSummaries");
    expect(request.prompt).toContain("User-supplied public reference.");
    expect(request.prompt).not.toContain("c3-fallback-v1");
  });

  it("omits the key when only recipe rows exist", async () => {
    const runtime = buildRuntime();
    const input = buildInput({
      sanitizedEvidence: [{
        id: "evidence-1",
        kind: "recipe-system",
        basis: "aggregate",
        summary: "Deterministic c3-fallback-v1 recipe",
        structuredFacts: {},
      }],
    });
    const result = await createUiSpecModel(input, runtime);
    expect(result.kind).toBe("accepted");
    const [request] = runtime.call.mock.calls[0] as [Parameters<CreateUiSpecModelRuntime["call"]>[0]];
    expect(request.prompt).not.toContain("evidenceSummaries");
  });
});
```

Run: `npx vitest run src/create-ui-spec-model.test.ts -t "grounding honesty"`
Expected: FAIL — the key is absent unconditionally after Plan 1.

- [ ] **Step 2: Implement the reintroduction**

In `src/create-ui-spec-model.ts`, restore the `sanitizedEvidence` parameter on `buildPrompt` and add the guarded key:

```ts
function buildPrompt(request: CreateUiSpecRequest, sanitizedEvidence: readonly SanitizedEvidence[]): string {
  ...
    // Plan 2: real derived summaries only. recipe-system rows are operator
    // scaffolding, never evidence. Omit the key when nothing real exists.
    ...(evidenceSummaries(sanitizedEvidence).length > 0
      ? { evidenceSummaries: evidenceSummaries(sanitizedEvidence) }
      : {}),
```

with a small helper above `buildPrompt`:

```ts
function evidenceSummaries(rows: readonly SanitizedEvidence[]): string[] {
  return rows
    .filter((row) => row.kind !== "recipe-system" && row.summary.trim().length > 0)
    .map((row) => row.summary);
}
```

Update the call site back to `const prompt = buildPrompt(request, sanitizedEvidence);` and bump:

```ts
const POLICY_VERSION = "c3-model-proposal-v6";
```

- [ ] **Step 3: Update the prompt-boundary assertions**

In the prompt-boundary test, change `c3-model-proposal-v5` → `c3-model-proposal-v6` and `not.toContain("c3-model-proposal-v4")` → `not.toContain("c3-model-proposal-v5")`. The evidence-derived assertion deleted in Plan 1 Task 4 stays deleted (the summary text is now the derived sentence, not the fixture prose).

Run: `npx vitest run src/create-ui-spec-model.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/create-ui-spec-model.ts src/create-ui-spec-model.test.ts
git commit -m "feat(model-lane): reintroduce evidenceSummaries with derived content; v6

The prompt carries evidenceSummaries only when non-recipe rows with real
derived summaries exist (recipe stubs stay out), and POLICY_VERSION bumps
to c3-model-proposal-v6 because the prompt changed again."
```

## Task 5: Full verification + live campaign

**Files:** none (verification only).

- [ ] **Step 1: Full suite**

Run:

```bash
npx tsc --noEmit
npx vitest run
node scripts/dogfood-createuispec.mjs
```

Expected: tsc clean; full suite green (known `dom-motion-capture` load flake #84 may appear and passes standalone); dogfood PASS.

- [ ] **Step 2: Coverage audit re-run**

Run: `node scripts/audit-corpus-coverage.mjs`
Expected: exit 0 with `colorRoles: 688/787`, `layout: 704/787`.

- [ ] **Step 3: Deterministic live check (manual, documented)**

Using the MCP stdio harness from the 2026-08-02 session, run the three briefs (login, finance analytics, habit tracker) with NO model env (unset the four lane keys) and no references. Record:
- `designDirection` is populated with cited evidence ids for brief classes the corpus covers;
- `colorTokens` populated (≥ 3 matched entries with colorRoles) or null with the reason row;
- no stub strings and no verbatim corpus prose anywhere in the served spec or evidence;
- `modelExecutionState: null` (no model configured).

Record the results in the PR description.

- [ ] **Step 4: Model lane cross-check**

Run one model-lane call (lane configured, `"Make it better."` brief): the prompt now carries derived summaries when matches exist, and the proposal must not be steered by label classes. Record the outcome.

- [ ] **Step 5: Commit any doc/verification artifacts**

```bash
git add docs/superpowers/specs/coverage-2026-08-02.md
git commit -m "docs(corpus): refresh coverage snapshot after Plan 2 verification"  # only if the audit output changed
```

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 4 issues (D3–D7), all folded |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **VERDICT:** ENG CLEARED — ready to implement. D2 (ColorRoles shape) confirmed already applied in the working tree; D3–D7 folded in this review (build-index prerequisite, `findSimilar` type cleanup, shared `plurality`, unconditional fixture updates, real-corpus round-trip test).

NO UNRESOLVED DECISIONS
