# Deterministic Body + Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the deterministic `create_ui_spec` body from measured corpus facts and give both the deterministic and model paths real, shared grounding.

**Architecture:** Task 0 locks the coverage audit; Task 1 widens the closed `structuredFacts` allowlist and the recipe-owned summary builder; Task 2 changes automatic retrieval from a diversity-picked 5 to the top 3 ranked matches and adds an embeddings fallback; Task 3 adds a pure `createUiSpecDeterministic` synthesizer (direction sentence, color-token plurality, layout regions) and wires it into `assembleSpec`; the collapsed Task 4C puts the model prompt's `evidenceSummaries` key behind a non-empty guard, applies the conciseness instruction, and bumps `POLICY_VERSION` exactly once (v5 under Route A, v6 under Route B).

**Sequencing:** this plan CANNOT run in parallel with Plan 1 — see the Sequencing section in `2026-08-02-model-lane-reliability.md`. Task 0 below is the one exception: it creates three new files and can run alongside anything.

**Tech Stack:** TypeScript, Zod, Vitest, node:fs (audit script).

## Global Constraints

- C3 served-content posture (product decision, 2026-08-02): served `evidence[].summary` and the model prompt both use ONE derived structured summary builder. No verbatim `critique`/`whatToSteal`/`voice` prose on the wire or in the prompt. `rejectedDefaults`, `voice`, and `mood` stay `unavailable` with reasons until the provenance-governance flip.
- The registered `create_ui_spec` tool description is unchanged ("No corpus content, path, url or product identity is ever returned").
- Corpus freeze invariant: nothing writes to `corpus/entries.json`; every test asserts corpus bytes unchanged.
- Token population rule: `colorTokens` are populated only when ≥ 3 matched entries contribute `visual.colorRoles`; otherwise `null` + an `unavailableDecisions` reason. `typographyTokens` stays `null` (the corpus records no mono role; see Task 3 deviation note).
- Model path invariant: whenever `spec.modelProposal` is present, root `colorTokens`/`typographyTokens` stay `null` and authority stays `editorial` (existing UiSpec superRefine — the synthesizer must NOT run against model proposals).
- `POLICY_VERSION` bumps exactly once in this plan, in the collapsed Task 4C: `v4 → v5` under Route A (both plans ship together; Plan 1 Tasks 4-5 skipped) or `v5 → v6` under Route B (Plan 1 already shipped alone). Task 4C is the ONLY task in either plan that touches the prompt. See the Sequencing section in `2026-08-02-model-lane-reliability.md`.
- Auto-retrieval caps at N=3. Zero matches → zero corpus evidence rows + the EXISTING `sparseCoverage` warning; never fabricated content. NO new warning code is introduced (see the Task 2 note on the dual warning schema).
- **Warning codes live in TWO schemas.** Any new code must be added to BOTH `WarningSchema` (`src/create-ui-spec-contracts.ts:560`, the closed `z.enum` the producer's `parseDesignArtifactEnvelope` validates against at `:639`) AND the descriptor's `makeWarningSchema` (`src/tool-contracts.ts:1857`). There is no drift gate between them — `tool-contracts.test.ts:40` only asserts `warningSchema` is defined — so a one-sided addition fails at runtime in the producer, before the descriptor gate is ever reached. This plan adds no code and therefore touches neither.
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
        canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb",
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

## Task 2: Auto-retrieval top-3 + embeddings fallback

**Files:**
- Modify: `src/create-ui-spec.ts` (`resolveAutomaticRetrieval`)
- Test: `src/create-ui-spec.test.ts` (retrieval-state tests)

**Interfaces:**
- Consumes: `dependencies.reader.searchRanked` (existing), `dependencies.reader.search` (existing, zero-match seed path), `RetrievalState` (existing).
- Produces: top-3 ranked corpus observations (no diversity pick); zero-match path unchanged in retrieval state (`structured-fallback`) and in warnings (`sparseCoverage`, already emitted).

**No new warning code (review finding P1-A).** An earlier draft added
`noCorpusMatch`. Two reasons it is gone:

1. **It was wired to the wrong schema and would have failed at runtime.** The
   draft added the code only to the descriptor's `makeWarningSchema`
   (`src/tool-contracts.ts:1857`). But `buildWarnings` pushes into the
   ENVELOPE, which `parseDesignArtifactEnvelope` validates against
   `warnings: z.array(WarningSchema)` (`src/create-ui-spec-contracts.ts:639`)
   — a closed `z.enum` of four codes at `:560`. The producer parse would have
   thrown before the descriptor gate saw the payload, and no drift gate exists
   to catch the one-sided edit.
2. **It is redundant.** `buildWarnings` ALREADY pushes `sparseCoverage` on the
   `structured-fallback` branch (`src/create-ui-spec.ts:1159-1164`) with the
   message "automatic retrieval returned zero matches; the deterministic
   fallback recipe was used." That is precisely the zero-match condition the
   new code was going to report.

So the zero-match assertion in Step 3 asserts `sparseCoverage`, and Step 4 (the
warning-code addition) is deleted.

**Prerequisite (required):** the similarity fallback in Step 3 depends on the
embedding index. `findSimilarEntries` returns `[]` when the index is missing
(`src/corpus.ts:414-419` — documented "caller tells the user to run
build-index"), so a fresh checkout silently falls through to the zero-match
branch even when the corpus has matches. Run `npm run build-index` once before
Step 3 and include it in the task's verification in Step 5. Note the unit tests
stub `findSimilar`, so CI covers the branch logic without an index — only the
live path needs the index built.

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
  // SearchResult requires `score` and `searchMode` (src/corpus.ts:116-120);
  // the similarity fallback yields { entry } rows, so the declared type is the
  // common { entry } shape and the ranked slice is structurally assignable.
  let top: { entry: CorpusEntryT }[] = results.slice(0, 3);
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

it("reports sparseCoverage when both keyword and similarity return nothing", async () => {
  const reader = {
    ...baseReader(),
    search: vi.fn(async () => []),
    findSimilar: vi.fn(() => []),
  } as unknown as CorpusReader;
  const out = await createUiSpecForAdapter(noRefRequest(), makeCreateUiSpecDependencies(reader));
  expect(out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation")).toHaveLength(0);
  // The EXISTING zero-match warning (create-ui-spec.ts:1159-1164). No new code.
  expect(out.envelope.warnings.map((w) => w.code)).toContain("sparseCoverage");
  expect(out.envelope.retrieval.mode).toBe("structured-fallback");
});
```

`baseReader`, `seedEntry`, `similarResult`, and `noRefRequest` are helpers to add in the same test file following its existing reader-fixture pattern. `CorpusReader` and `vi` are already imported there.

- [ ] **Step 4: Confirm no warning-schema change is needed**

Deliberately empty — see the "No new warning code" note at the top of this
task. `buildWarnings` and both warning schemas are UNCHANGED by Task 2. Verify
with `rg -n "noCorpusMatch" src/` (expected: no matches) so a stale draft
cannot reintroduce the one-sided edit.

- [ ] **Step 5: Run the affected suites**

Run: `npx vitest run src/create-ui-spec.test.ts src/create-ui-spec-mcp.test.ts`
Expected: PASS. No warning-code fixture needs updating — the emitted code set
is identical to today's.

- [ ] **Step 6: Commit**

```bash
git add src/create-ui-spec.ts
git commit -m "feat(create-ui-spec): top-3 ranked auto-retrieval with similarity fallback

Automatic retrieval keeps the 3 highest-ranked matches instead of a
diversity-picked 5 and seeds the similarity index when keyword search
returns nothing. Zero matches keep the existing sparseCoverage warning and
the structured-fallback retrieval state; no new warning code is added."
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
          // ("corpus-evidence", NOT the camelCase lane field name — the enum
          // at tool-contracts.ts:537 is team-design-system /
          // project-constraint / corpus-evidence / editorial, and the
          // consistency gate at :853 only fires for "corpus-evidence").
          authority: "corpus-evidence",
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
  // The recipe ALREADY declares a colorTokens unavailableDecision
  // (fallback-recipe-v1.json); the UiSpec gate requires unavailableDecisions
  // fields to be UNIQUE (tool-contracts.ts:778-781) and forbids a colorTokens
  // row when tokens are available (:803-804). So: when synthesis runs, drop
  // the recipe's colorTokens row and re-add exactly ONE row only when the
  // synthesis leaves tokens null. When synthesis did not run (no corpus match
  // or model path), the recipe's row survives untouched.
  const unavailableDecisions: UiSpecT["unavailableDecisions"] = [
    ...RECIPE.unavailableDecisions
      .filter((d) => synthesis === null || d.field !== "colorTokens")
      .map((d) => ({ field: d.field, reason: d.reason })),
    ...(synthesis !== null && synthesis.colorTokens === null
      ? [{ field: "colorTokens", reason: "Fewer than 3 matched entries contribute color roles." }]
      : []),
    ...c3Unavailable,
  ];
```

Add the import at the top of `src/create-ui-spec.ts`: `import { createUiSpecDeterministic } from "./create-ui-spec-deterministic.js";`

Note: `rejectedDefaults` stays the recipe's empty array per C3 (the field is NOT populated); the `unavailableDecisions` row explains why.

- [ ] **Step 4b: Correct the `data.designDirection` leaf annotation (review finding P1-B)**

`CREATE_UI_SPEC_FREE_TEXT_LEAVES` is the product's own machine-readable claim
about who authored each served string. Today it says
(`src/tool-contracts.ts:1155`):

```ts
  "data.designDirection": "under the deterministic recipe this restates the caller's own brief",
```

Step 4 makes that position corpus-synthesized text citing evidence ids on the
no-model path, so the annotation becomes FALSE. **No existing test fails** —
the guards in `src/create-ui-spec-intent-guards.test.ts:290-325` cover the
intent and acceptance-criteria positions, not this one — which is exactly the
silent-authority-drift class those guards were written to stop. Replace it:

```ts
  "data.designDirection": "recipe-owned prose: the caller's own brief restated when no corpus entry matched, or a recipe-voice sentence built from closed structuredFacts pluralities and citing the matched evidence ids; never corpus prose and never model output (a model proposal lives at data.modelProposal.designDirection)",
```

Then pin it, so the next authorship change cannot drift silently. Append to
`src/create-ui-spec-intent-guards.test.ts`:

```ts
  it("annotates designDirection as recipe-owned across BOTH deterministic sources", () => {
    // Plan 2 gave this position a second author (corpus-fact synthesis)
    // alongside the brief echo. The annotation must name both, must not
    // claim corpus prose, and must not claim model authorship.
    const note = (CREATE_UI_SPEC_FREE_TEXT_LEAVES as Record<string, string | undefined>)[
      "data.designDirection"
    ];
    expect(note, "data.designDirection has no annotation").toBeDefined();
    expect(note!).toMatch(/recipe-owned/i);
    expect(note!, "must name the brief-echo source").toMatch(/brief/i);
    expect(note!, "must name the corpus-fact source").toMatch(/structuredFacts|evidence ids/i);
    expect(note!, "must not claim corpus prose").not.toMatch(/critique|whatToSteal/i);
  });
```

Run: `npx vitest run src/create-ui-spec-intent-guards.test.ts src/tool-contracts.test.ts`
Expected: PASS (the annotation-shape test at `tool-contracts.test.ts:465`
iterates every annotation and must stay green).

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
4. **Gate-pass on BOTH token branches (D8):** in `src/create-ui-spec.test.ts`, for a deterministic path with a 3-observation fixture, assert the full produced envelope passes the shared gate (`parseToolResult` success) with `colorTokens` POPULATED, and for a 2-observation fixture assert it passes with `colorTokens` null and EXACTLY ONE `colorTokens` unavailableDecision row (the duplicate-row bug this pins: the recipe's row + a conditional row would make the gate's uniqueness check at tool-contracts.ts:778-781 fail, and a surviving recipe row with populated tokens would fail :803-804).

- [ ] **Step 6: Run the affected suites**

Run: `npx vitest run src/create-ui-spec-deterministic.test.ts src/create-ui-spec.test.ts src/create-ui-spec-model-path.test.ts src/create-ui-spec-mcp.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/create-ui-spec-deterministic.ts src/create-ui-spec-deterministic.test.ts src/create-ui-spec.ts src/tool-contracts.ts src/create-ui-spec-intent-guards.test.ts scripts/dogfood-createuispec.mjs
git commit -m "feat(create-ui-spec): corpus-grounded deterministic body

createUiSpecDeterministic synthesizes direction, color-token plurality,
and layout regions from closed structuredFacts on the no-model path;
rejectedDefaults/voice/mood stay unavailable per the C3 posture, and
token population requires >= 3 contributing entries."
```

## Task 4C (COLLAPSED): guarded `evidenceSummaries` + conciseness + ONE policy bump

**This is the only task in either plan that touches the prompt.** It replaces
Plan 1 Task 4 (remove the key), Plan 1 Task 5 (conciseness + v5), and the
original Plan 2 Task 4 (re-add the key + v6). See the Sequencing section in
`2026-08-02-model-lane-reliability.md`.

**Route check before you start:**

- **Route A (both plans ship together — recommended):** Plan 1 Tasks 4 and 5
  were SKIPPED. The prompt is still at `c3-model-proposal-v4` with the
  `evidenceSummaries` key present and `buildPrompt(request, sanitizedEvidence)`
  intact. This task adds the guard, adds the conciseness instruction, and bumps
  **v4 → v5**. There is no removal step and no v6.
- **Route B (Plan 1 already shipped alone):** Plan 1 Tasks 4 and 5 ran, so the
  key is gone, the signature is `buildPrompt(request)`, and the version is
  `v5`. Restore the parameter, add the guard, skip the conciseness instruction
  (already applied by Plan 1 Task 5), and bump **v5 → v6**.

Every step below names the route where they differ. `POLICY_VERSION` ends at
**v5 under Route A** and **v6 under Route B** — one bump either way, because
the prompt changes once per shipped release.

**Files:**
- Modify: `src/create-ui-spec-model.ts` (`buildPrompt` guard, conciseness instruction under Route A, `POLICY_VERSION`)
- Test: `src/create-ui-spec-model.test.ts` (grounding-honesty describe + prompt-boundary assertions)

**Interfaces:**
- Consumes: `SanitizedEvidence` (now with derived summaries from Task 1).
- Produces: `evidenceSummaries` present only when non-recipe rows with non-empty summaries exist; the conciseness instruction in the task line; `c3-model-proposal-v5` (Route A) or `v6` (Route B).

- [ ] **Step 1: Write / rewrite the grounding test**

Under Route A this describe does not exist yet — ADD it. Under Route B, replace
the Plan 1 `grounding honesty` describe (the "no evidenceSummaries key" test)
with it:

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

Expected FAIL, for a different reason per route:
- **Route A:** the "omits the key when only recipe rows exist" case fails — the
  key is currently emitted unconditionally, recipe rows included.
- **Route B:** the "includes evidenceSummaries" case fails — the key is absent
  unconditionally after Plan 1 Task 4.

- [ ] **Step 2: Implement the guard**

In `src/create-ui-spec-model.ts`, add the helper above `buildPrompt`:

```ts
function evidenceSummaries(rows: readonly SanitizedEvidence[]): string[] {
  return rows
    .filter((row) => row.kind !== "recipe-system" && row.summary.trim().length > 0)
    .map((row) => row.summary);
}
```

**Route B only:** restore the parameter —
`function buildPrompt(request: CreateUiSpecRequest, sanitizedEvidence: readonly SanitizedEvidence[]): string` —
and the call site, `const prompt = buildPrompt(request, sanitizedEvidence);`.
Under Route A both are already in place; do not touch them.

**Both routes:** replace the unconditional key (Route A) or add it back
(Route B) with the guarded form:

```ts
    // Real derived summaries only. recipe-system rows are operator
    // scaffolding, never evidence. Omit the key when nothing real exists —
    // a content-free label is worse than no grounding at all.
    ...(evidenceSummaries(sanitizedEvidence).length > 0
      ? { evidenceSummaries: evidenceSummaries(sanitizedEvidence) }
      : {}),
```

- [ ] **Step 2b: Conciseness instruction (ROUTE A ONLY)**

Under Route B this already landed in Plan 1 Task 5 — skip. Under Route A,
change the task line:

```ts
    task: "Produce a bounded UI-spec proposal as one JSON object and nothing else. "
      + "Be concise. State each decision once, with one sentence of rationale. "
      + "Drop the DECISION/EFFECT/REJECTS scaffolding where it adds no information.",
```

- [ ] **Step 3: Bump `POLICY_VERSION` exactly once**

```ts
// Route A:
const POLICY_VERSION = "c3-model-proposal-v5";
// Route B:
const POLICY_VERSION = "c3-model-proposal-v6";
```

Then update the prompt-boundary assertions to match the route:

- **Route A:** assert `"policyVersion":"c3-model-proposal-v5"`,
  `not.toContain("c3-model-proposal-v4")`, and
  `toContain("Be concise. State each decision once")`. Also DELETE the
  assertion `expect(request.prompt).toContain("Favor compact hierarchy, restrained emphasis, and stable column alignment.")`
  — that string lives only in the `evidence-1` recipe summary of `buildInput()`,
  which the new guard now filters out of the prompt. (Under Route B this
  deletion already happened in Plan 1 Task 4 Step 3.)
- **Route B:** assert `c3-model-proposal-v6` and
  `not.toContain("c3-model-proposal-v5")`. The conciseness assertion is
  already present from Plan 1 Task 5.

Run: `npx vitest run src/create-ui-spec-model.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/create-ui-spec-model.ts src/create-ui-spec-model.test.ts
git commit -m "feat(model-lane): guarded evidenceSummaries + concise prompt; policy v5

The prompt carries evidenceSummaries only when non-recipe rows with real
derived summaries exist, so a content-free label can never reach the model
as grounding, and asks for one sentence of rationale per decision instead
of the DECISION/EFFECT/REJECTS scaffolding. POLICY_VERSION bumps once."
```

(Route B: retitle to `policy v6` and drop the conciseness sentence — Plan 1
Task 5 already shipped it.)

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

- [ ] **Step 4: Model-lane campaign — THIS IS A GATE, NOT A NOTE**

Task 4C changed the prompt, so this is where the length and grounding targets
are measured. Under Route A this is the ONLY place they are measured at all
(Plan 1's campaign deliberately records no length numbers — the prompt had not
changed yet, so any movement there is provider noise and would create a false
baseline).

Run the 10-brief probe with the lane configured and record:

- **Length:** median `designDirection` ≤ ~1,000 chars against the measured
  1,272 baseline; max ≤ ~1,400 against 1,789.
- **Accept rate:** no regression against the 8/10 baseline.
- **Grounding — the gate.** One `"Make it better."` run. The proposal must NOT
  describe an editor canvas or a marketing hero.

**If the grounding check fails, Task 1 made things worse and must be
reconsidered before merge.** The reasoning matters: Task 1's derived sentence
(`"dashboard reference, 3 regions, compact spacing, slight-round corners, no
shadows, borders, accent #2563eb, Inter / Inter, layout three-column"`) is MORE
specific than the label it replaces, not less. The thing expected to fix the
thin-brief hijack is Task 2's top-3 ranked retrieval — better relevance — not
Task 1's richer text. If a thin brief still inherits the retrieved pattern
class after both land, the correct response is a brief-thinness guard (refuse
or ask), not more summary detail. Record which way it went.

- [ ] **Step 5: Commit any doc/verification artifacts**

```bash
git add docs/superpowers/specs/coverage-2026-08-02.md
git commit -m "docs(corpus): refresh coverage snapshot after Plan 2 verification"  # only if the audit output changed
```

## Implementation Tasks

- [ ] **T1 (P1, human: ~30min / CC: ~5min)** — apply the two verified plan fixes — Task 3 authority token `"corpusEvidence"` → `"corpus-evidence"`; Task 0 audit fixture `primary` → `canvas`. DONE in this review (already applied to the plan files).
  - Surfaced by: Architecture review — D3 authority-enum cross-check (tool-contracts.ts:537, :853); D2 corpus-schema cross-check (schema.ts:418-424).
  - Files: `docs/superpowers/plans/2026-08-02-deterministic-body-grounding.md`, `docs/superpowers/plans/2026-08-02-model-lane-reliability.md`
  - Verify: `rg -n "corpusEvidence|corpus-evidence" docs/superpowers/plans/2026-08-02-deterministic-body-grounding.md` and `rg -n "canvas" docs/superpowers/plans/2026-08-02-deterministic-body-grounding.md | head -3`
- [ ] **T2 (P2, human: ~2h / CC: ~15min)** — request code review — dispatch the requesting-code-review subagent on both plan commits before implementation begins (per the requesting-code-review skill; mandatory before implementing major plans).
  - Surfaced by: requesting-code-review skill — mandatory before implementing major plans.
  - Files: `docs/superpowers/plans/2026-08-02-model-lane-reliability.md`, `docs/superpowers/plans/2026-08-02-deterministic-body-grounding.md`
  - Verify: review feedback triaged (Critical fixed, Important fixed, Minor noted).
- [ ] **T3 (P1, human: ~30min / CC: ~5min)** — apply the duplicate-colorTokens fix in Task 3 Step 4 — the recipe ALREADY declares a `colorTokens` unavailableDecision (fallback-recipe-v1.json), so the old spread+conditional produced two rows (or a stale row with populated tokens), failing the uniqueness gate at tool-contracts.ts:778-781 and the available-token gate at :803-804. DONE in this review (already applied to the plan file).
  - Surfaced by: Architecture review — D8 gate-rule cross-check (tool-contracts.ts:778-804, fallback-recipe-v1.json).
  - Files: `docs/superpowers/plans/2026-08-02-deterministic-body-grounding.md`
  - Verify: `rg -n "filter\(\(d\) => synthesis === null" docs/superpowers/plans/2026-08-02-deterministic-body-grounding.md`
- [ ] **T4 (P2, human: ~15min / CC: ~5min)** — annotate the retrieval `top` variable as `{ entry: CorpusEntryT }[]` — `SearchResult` requires `score` and `searchMode` (corpus.ts:116-120), so the similarity fallback's `{ entry }` rows would not type-check. DONE in this review (already applied to the plan file).
  - Surfaced by: Code quality review — type-level cross-check (corpus.ts:116-120).
  - Files: `docs/superpowers/plans/2026-08-02-deterministic-body-grounding.md`
  - Verify: `rg -n "let top: \{ entry: CorpusEntryT \}\[\]" docs/superpowers/plans/2026-08-02-deterministic-body-grounding.md`

_No new tasks from Code Quality._ _No new tasks from Performance beyond the documented latency note (retry doubles worst-case to ~60-70s; default stays 1 attempt)._

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 0 | — | — |
| Codex Review | `/codex review` | Independent 2nd opinion | 1 | interrupted | no findings returned |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 6 | CLEAR | 10 issues, 0 critical gaps |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

- **CODEX:** dispatched via requesting-code-review twice; both subagent chains ran nested deep-dives and were interrupted before returning findings, so this plan set still has no outside-voice pass. Re-run with a hard timebox before implementation if cross-model review is wanted.
- **CROSS-MODEL:** (not run)
- **VERDICT:** ENG CLEARED — ready to implement. Joint plan-set review, third pass (2026-08-02). Six prior findings were folded in earlier passes (commits 4f4574e, 3d17ea6, 636ccdd): colorRoles shape, citation-ledger authority, model-path gating, token-fabrication guard, test gaps, latency docs. Four fresh findings folded in this pass, all verified against repo code:
1. [P1] Duplicate `colorTokens` unavailableDecision — the recipe (fallback-recipe-v1.json) already declares one, so the plan's spread + conditional produced two rows (uniqueness gate, tool-contracts.ts:778-781) or a stale row with populated tokens (:803-804). Fixed: filter the recipe row when synthesis runs and re-add exactly one only when tokens are null.
2. [P2] Retrieval `top` type — `SearchResult` requires `score`/`searchMode` (corpus.ts:116-120), so the similarity fallback's `{ entry }` rows would not compile. Fixed: annotate as `{ entry: CorpusEntryT }[]`.
3. [P2] Cross-tool gate test — the descriptor-conditional `modelExecutionState` key needs a pin that OTHER tools reject the key; added a critique_ui fixture test (makeValidSuccess/cloneToolResult pattern).
4. [P2] D8 gate-pass test — the duplicate-row bug would have been caught by asserting the full envelope passes the gate on BOTH token branches (populated and null); added to Task 3 Step 5.

Verified claims from earlier passes still hold: `findSimilarEntries` no-index behavior (corpus.ts:414-419), `pickDiverse` at create-ui-spec.ts:482, warning-code list (tool-contracts.ts:1857), `makeReader(corpus, ranked)` helper (create-ui-spec.test.ts:124), `plurality` export step needed (design-prompt.ts:45), `HexColor` export step needed (schema.ts:418), `buildInput` overrides (model.test.ts:11), `corpusEvidenceIds`/`buildCitedDecisions` (create-ui-spec.ts:813-847), retry loop shape, makeEnvelope conditional-key idiom (:2374), and `MAX_MODEL_TEXT_BYTES = 32 * 1024` (model.ts:23).

NO UNRESOLVED DECISIONS
