# Field-set gating 2d-2 — synthesis + aggregation tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the three synthesis/aggregation tools (`compare_ui_examples`, `get_color_palette`, `recommend_ui_direction`) into core + enrichment exactly like 2d-1 did for the render tools, by making their pure consumers (`generateBrief`, `contributionNote`, `collectPalettes`, the compare renderer) absent-enrichment-safe through a non-mutating projection layer, so the invariant extends to derived output.

**Architecture:** A new `synthesis-projection.ts` layer sits between the reader and the pure functions: `projectEntryForSynthesis` returns a NEW entry object with unverified enrichment stripped (new nested containers for `visual`/`antiPatterns` — never mutating the cached corpus), typed as the concrete `ProjectedEntry`. Consumers take `ProjectedEntry[]`, guard every enrichment read, and the renderers append per-entry / per-section disclosures (`_Unverified fields omitted: X._` for direct-echo, `_Drawn from K of N verified entries._` for brief clauses). The verified-only `patternType` filter is PALETTE-LOCAL (not in shared `filterEntries`), and `generate_design_prompt`'s private handler is hardened for defense-in-depth only (it is not publicly registered).

**Tech Stack:** TypeScript (Node ESM), Zod, vitest, MCP SDK. `npm test` = `vitest run`; typecheck via `npx tsc --noEmit`.

## Global Constraints

- **Invariant (spec, verbatim):** "A tool never emits a field value that is not `isVerified` for that entry. An entry appears in a tool only when ALL of that tool's **core** fields are verified. A dropped enrichment field is disclosed as unverified — never silently absent, never a stale value." Extended surface: covers derived output (brief clauses, contribution notes, palette rows, compare cells).
- **`ProjectedEntry` is the concrete top-level-optionalized type from Locked decision 5** — NOT a `Pick` of dotted keys. `visual` / `antiPatterns` are `Partial` containers; the other seven keys are leaf-optional. The optionalized set is the union of the three tools' enrichment keys.
- **`projectEntryForSynthesis` never mutates the source entry or its nested objects** — `loadCorpus()` caches entry objects at module level.
- **Non-mutating projection, guarded consumers, disclosures at the render boundary.** Omit, never null; never a stale value.
- **Filter asymmetry is palette-local:** verified-only `patternType` matching applies ONLY inside `collectPalettes`; the shared `filterEntries` stays behavior-identical for `get_anti_patterns`, `get_stealable_techniques`, `browse_ui_examples`.
- **Byte-identical pin:** for a fully-verified fixture, the three tools' output must be byte-identical to today (no disclosure artifacts appear).
- **`generate_design_prompt` is NOT MCP-handler-tested** (not publicly registered). Its hardening is verified by typecheck + the shared `generateBrief` tests.
- **Union(core, enrichment) for each tool equals today's full-AND set.**
- **Tests use injected readers + in-memory fixtures only; real `provenance.verification` records; no mocks at the `isVerified` boundary.**
- **Every task ends with its tests green and a commit.**

---

### Task 1: `synthesis-projection.ts` — ProjectedEntry, projection, coverage disclosure

**Files:**
- Create: `src/synthesis-projection.ts`
- Test: `src/synthesis-projection.test.ts`

**Interfaces:**
- Consumes: `CorpusEntryT` from `./schema.js`, `isVerified` from `./corpus-trust.js`.
- Produces: `ProjectedEntry`, `projectEntryForSynthesis(entry: CorpusEntryT, enrichment: readonly string[]): ProjectedEntry` (non-mutating), `renderCoverageDisclosure(args: { used: number; total: number; dropped: readonly string[] }): string`. Tasks 2-7 consume these.

- [ ] **Step 1: Write the failing tests**

Create `src/synthesis-projection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CorpusEntryT } from "./schema.js";
import {
  projectEntryForSynthesis,
  renderCoverageDisclosure,
  PROJECTED_TOP_LEVEL_KEYS,
  type ProjectedEntry,
} from "./synthesis-projection.js";
import {
  COMPARE_UI_EXAMPLES_ENRICHMENT,
  GET_COLOR_PALETTE_ENRICHMENT,
  RECOMMEND_UI_DIRECTION_ENRICHMENT,
} from "./server-factory.js";

const RECORD = { method: "measured", verifiedAt: "2026-08-06", verifierVersion: "v1" };

function entryWith(verifiedFor: readonly string[]): CorpusEntryT {
  const verification: Record<string, unknown> = {};
  for (const field of verifiedFor) verification[field] = RECORD;
  return {
    id: "e1",
    title: "E1",
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    source: { productName: "P", url: null, capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "", width: null, height: null },
    visual: {
      dominantColors: ["#ffffff"],
      accentColor: "#3b82f6",
      colorRoles: { canvas: "#ffffff", surface: "#f8f8f8", ink: "#111111", muted: "#888888", accent: "#3b82f6" },
      typePairing: { display: "Inter", body: "Inter", notes: "Clear hierarchy." },
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
      usesShadows: false,
      usesBorders: true,
    },
    antiPatterns: { antiPatterns: ["Avoid heavy shadows."], whereThisFails: [], accessibilityRisks: [] },
    voice: { tone: "Restrained", examples: ["Hello"], avoid: [] },
    whatToSteal: ["Steal this."],
    qualityScore: 4,
    qualityTier: "exceptional",
    reviewStatus: "approved",
    addedAt: "2026-07-01",
    provenance: { taggedBy: "auto", verification },
  } as unknown as CorpusEntryT;
}

const ALL = [
  "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks", "voice",
  "layout", "patternType", "styleTags", "categories", "platform",
  "visual.colorRoles", "visual.typePairing", "visual.spacingDensity",
  "visual.cornerStyle", "visual.accentColor", "visual.usesShadows",
  "visual.usesBorders",
] as const;

describe("projectEntryForSynthesis", () => {
  it("returns the entry untouched when nothing is omitted (no clone churn)", () => {
    const e = entryWith([...ALL]);
    const p = projectEntryForSynthesis(e, [...ALL]);
    expect(p).toBe(e);
  });

  it("strips unverified top-level enrichment and keeps verified + core", () => {
    const e = entryWith(["whatToSteal", "voice"]);
    const p = projectEntryForSynthesis(e, ["whatToSteal", "voice", "antiPatterns", "patternType"]);
    expect(p.whatToSteal).toEqual(["Steal this."]);
    expect(p.voice?.tone).toBe("Restrained");
    expect(p.antiPatterns).toBeUndefined();
    expect(p.patternType).toBeUndefined();
    expect((p as ProjectedEntry).source.productName).toBe("P");
  });

  it("strips nested visual leaves per key without touching verified leaves", () => {
    const e = entryWith(["visual.colorRoles", "visual.spacingDensity"]);
    const p = projectEntryForSynthesis(e, [
      "visual.colorRoles", "visual.typePairing", "visual.spacingDensity", "visual.cornerStyle",
    ]);
    expect(p.visual?.colorRoles?.accent).toBe("#3b82f6");
    expect(p.visual?.spacingDensity).toBe("moderate");
    expect(p.visual?.typePairing).toBeUndefined();
    expect(p.visual?.cornerStyle).toBeUndefined();
  });

  it("does NOT mutate the source entry or its nested objects", () => {
    const e = entryWith(["visual.colorRoles"]);
    const visualRef = e.visual;
    projectEntryForSynthesis(e, ["visual.colorRoles", "visual.typePairing", "antiPatterns"]);
    expect(e.visual).toBe(visualRef);
    expect(e.visual.typePairing?.display).toBe("Inter");
    expect(e.antiPatterns?.antiPatterns[0]).toBe("Avoid heavy shadows.");
  });

  it("strips the antiPatterns leaf independently of the parent", () => {
    const e = entryWith(["antiPatterns"]);
    const p = projectEntryForSynthesis(e, ["antiPatterns", "antiPatterns.accessibilityRisks"]);
    expect(p.antiPatterns?.antiPatterns).toEqual(["Avoid heavy shadows."]);
    expect(p.antiPatterns?.accessibilityRisks).toBeUndefined();
  });

  it("returns an entry with only core filled when enrichment is empty", () => {
    const e = entryWith(["critique"]);
    const p = projectEntryForSynthesis(e, ["voice", "patternType", "styleTags"]);
    expect(p.voice).toBeUndefined();
    expect(p.patternType).toBeUndefined();
    expect(p.styleTags).toBeUndefined();
  });
});

describe("renderCoverageDisclosure", () => {
  it("returns empty when used equals total", () => {
    expect(renderCoverageDisclosure({ used: 3, total: 3, dropped: [] })).toBe("");
  });

  it("renders K-of-N when partial", () => {
    const d = renderCoverageDisclosure({ used: 1, total: 3, dropped: ["visual.colorRoles"] });
    expect(d).toBe("_Drawn from 1 of 3 verified entries (missing: visual.colorRoles)._");
  });

  it("renders K-of-N with dropped fields named when none used", () => {
    const d = renderCoverageDisclosure({ used: 0, total: 2, dropped: ["voice"] });
    expect(d).toBe("_Drawn from 0 of 2 verified entries (missing: voice)._");
  });
});

describe("whitelist contract — every 2d-2 enrichment key maps to an optionalized slot", () => {
  it("covers the union of the three tools' enrichment sets", () => {
    const union = [
      ...COMPARE_UI_EXAMPLES_ENRICHMENT,
      ...GET_COLOR_PALETTE_ENRICHMENT,
      ...RECOMMEND_UI_DIRECTION_ENRICHMENT,
    ];
    for (const key of union) {
      const top = key.split(".")[0];
      expect(PROJECTED_TOP_LEVEL_KEYS.has(top), `no optionalized slot for ${key}`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/synthesis-projection.test.ts`
Expected: FAIL — module `./synthesis-projection.js` cannot be resolved, and the whitelist test fails until Task 1 Step 5 exports the server-factory constants.

- [ ] **Step 3: Implement the module**

Create `src/synthesis-projection.ts`:

```ts
/**
 * synthesis-projection.ts — the projection layer for synthesis/aggregation tools.
 *
 * 2d-2 invariant, synthesis half: a pure consumer (generateBrief, contributionNote,
 * collectPalettes, the compare renderer) may only ever read enrichment fields that
 * `isVerified` for the entry. The reader gates on CORE only; this layer strips
 * unverified enrichment BEFORE the pure functions see the entry, so a guarded read
 * becomes a compile-time requirement via the ProjectedEntry type.
 *
 * NEVER MUTATES THE SOURCE. `loadCorpus()` caches entry objects at module level and
 * `entriesForAggregation` hands those same objects to every handler, so stripping a
 * leaf in place would corrupt the shared corpus for all subsequent calls. This module
 * returns NEW entry objects and NEW containers for any nested object it touches.
 */
import type { CorpusEntryT } from "./schema.js";
import { isVerified } from "./corpus-trust.js";

/**
 * The top-level entry keys that any 2d-2 tool's enrichment set can strip. Nested
 * paths (`visual.*`, `antiPatterns.*`) map to their container, which becomes Partial.
 * Derived from the union of the three tools' enrichment keys — a contract test in
 * synthesis-projection.test.ts asserts the mapping stays complete.
 */
export const PROJECTED_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "visual", "antiPatterns", "voice", "layout", "patternType",
  "styleTags", "categories", "platform", "whatToSteal",
]);

/**
 * An entry after 2d-2 projection: core + metadata untouched; every enrichment
 * container/leaf optional. `visual` and `antiPatterns` are Partial so verified
 * leaves survive while unverified leaves are stripped.
 */
export type ProjectedEntry = Omit<
  CorpusEntryT,
  "visual" | "antiPatterns" | "voice" | "layout" | "patternType"
    | "styleTags" | "categories" | "platform" | "whatToSteal"
> & {
  visual?: Partial<CorpusEntryT["visual"]>;
  antiPatterns?: Partial<CorpusEntryT["antiPatterns"]>;
  voice?: CorpusEntryT["voice"];
  layout?: CorpusEntryT["layout"];
  patternType?: CorpusEntryT["patternType"];
  styleTags?: CorpusEntryT["styleTags"];
  categories?: CorpusEntryT["categories"];
  platform?: CorpusEntryT["platform"];
  whatToSteal?: CorpusEntryT["whatToSteal"];
};

const NESTED_ENRICHMENT_KEYS = ["visual", "antiPatterns"] as const;

/**
 * Returns a NEW entry with unverified enrichment removed (nested where relevant).
 * When nothing is omitted, returns the SAME entry (no clone churn — callers never
 * mutate). When something is omitted, builds a new entry object and NEW `visual` /
 * `antiPatterns` containers so the source and its nested objects are untouched.
 */
export function projectEntryForSynthesis(
  entry: CorpusEntryT,
  enrichment: readonly string[],
): ProjectedEntry {
  const omitted = enrichment.filter((field) => !isVerified(entry, field));
  if (omitted.length === 0) return entry;

  const projected = { ...entry } as ProjectedEntry;

  for (const container of NESTED_ENRICHMENT_KEYS) {
    const keys = enrichment.filter((k) => k.startsWith(`${container}.`));
    const containerOmitted = keys.some((k) => omitted.includes(k));
    const sourceContainer = (entry as unknown as Record<string, unknown>)[container];
    if (containerOmitted && sourceContainer && typeof sourceContainer === "object") {
      const copy = { ...(sourceContainer as Record<string, unknown>) };
      for (const k of keys) {
        const leaf = k.slice(container.length + 1);
        if (omitted.includes(k)) delete copy[leaf];
      }
      (projected as unknown as Record<string, unknown>)[container] = copy;
    }
  }

  for (const key of PROJECTED_TOP_LEVEL_KEYS) {
    if (omitted.includes(key)) {
      (projected as unknown as Record<string, unknown>)[key] = undefined;
    }
  }

  return projected;
}

/**
 * The K-of-N brief-clause disclosure. Empty string when nothing was dropped —
 * a fully-verified brief renders byte-identically to today.
 */
export function renderCoverageDisclosure(args: {
  used: number;
  total: number;
  dropped: readonly string[];
}): string {
  if (args.used >= args.total) return "";
  const tail = args.dropped.length > 0 ? ` (missing: ${args.dropped.join(", ")})` : "";
  return `_Drawn from ${args.used} of ${args.total} verified entries${tail}._`;
}
```

- [ ] **Step 4: Run the projection tests (partial pass expected)**

Run: `npx vitest run src/synthesis-projection.test.ts`
Expected: the `projectEntryForSynthesis` / `renderCoverageDisclosure` tests PASS; the whitelist contract test still FAILS until Step 5.

- [ ] **Step 5: Export the three field-set constants from `server-factory.ts`**

In `src/server-factory.ts`, ADD the exported 2d-2 constant pairs (they do not exist yet; the `COMPARE_UI_EXAMPLES_FULL_SET` / `RECOMMEND_UI_DIRECTION_FULL_SET` constants remain in use until Task 5 removes them):

```ts
export const COMPARE_UI_EXAMPLES_CORE = ["critique"] as const;
export const COMPARE_UI_EXAMPLES_ENRICHMENT = [
  "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks",
  "categories", "styleTags", "patternType", "platform", "layout",
  "visual.accentColor", "visual.colorRoles", "visual.spacingDensity",
  "visual.cornerStyle", "visual.usesShadows", "visual.usesBorders",
] as const;

export const GET_COLOR_PALETTE_CORE = ["visual.colorRoles"] as const;
export const GET_COLOR_PALETTE_ENRICHMENT = ["patternType"] as const;

export const RECOMMEND_UI_DIRECTION_CORE = ["whatToSteal"] as const;
export const RECOMMEND_UI_DIRECTION_ENRICHMENT = [
  "antiPatterns", "voice", "visual.colorRoles", "visual.typePairing",
  "visual.spacingDensity", "visual.cornerStyle", "layout", "patternType", "styleTags",
] as const;

// Same field set as recommend — shared generateBrief.
export const GENERATE_DESIGN_PROMPT_CORE = RECOMMEND_UI_DIRECTION_CORE;
export const GENERATE_DESIGN_PROMPT_ENRICHMENT = RECOMMEND_UI_DIRECTION_ENRICHMENT;
```

- [ ] **Step 6: Run the full test file to verify it passes**

Run: `npx vitest run src/synthesis-projection.test.ts`
Expected: PASS (11 tests, including the whitelist contract test).

- [ ] **Step 7: Commit**

```bash
git add src/synthesis-projection.ts src/synthesis-projection.test.ts src/server-factory.ts
git commit -m "feat(trust): synthesis projection layer — ProjectedEntry, non-mutating projection, coverage disclosure"
```

---

### Task 2: `design-prompt.ts` — guarded reads + `DesignBrief.coverage`

**Files:**
- Modify: `src/design-prompt.ts`
- Test: `src/design-prompt.test.ts` (extend + update the legacy-shape regression test)

**Interfaces:**
- Consumes: `ProjectedEntry` (Task 1).
- Produces: `BriefSection`, `BriefCoverage`, `DesignBrief.coverage: Record<BriefSection, BriefCoverage>`; `generateBrief(entries: ProjectedEntry[], input)` with every enrichment read guarded; `renderBrief` appending `renderCoverageDisclosure` output per section when `used < total`.

- [ ] **Step 1: Write the failing tests**

Append to `src/design-prompt.test.ts`:

```ts
import { projectEntryForSynthesis } from "./synthesis-projection.js";
import type { CorpusEntryT } from "./schema.js";

const COVERAGE_RECORD = { method: "measured", verifiedAt: "2026-08-06", verifierVersion: "v1" };

function coveredEntry(id: string, verifiedFor: readonly string[]): ProjectedEntry {
  const verification: Record<string, unknown> = {};
  for (const field of verifiedFor) verification[field] = COVERAGE_RECORD;
  const full = {
    id,
    source: { productName: `Product ${id}`, url: null, capturedAt: "2026-07-01", capturedBy: "self" },
    visual: {
      colorRoles: { canvas: "#ffffff", surface: "#f8f8f8", ink: "#111111", muted: "#888888", accent: "#3b82f6" },
      typePairing: { display: "Inter", body: "Inter", notes: "Clear hierarchy with restrained type weights." },
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
    },
    antiPatterns: { antiPatterns: ["Avoid heavy shadows."] },
    voice: { tone: "Restrained and confident", examples: ["Hello"], avoid: [] },
    whatToSteal: ["Group metric tiles on one baseline."],
    patternType: "dashboard",
    styleTags: ["minimal"],
    layout: { form: "sidebar", regions: [{ role: "primary-nav", width: "240px" }] },
    provenance: { taggedBy: "auto", verification },
  } as unknown as CorpusEntryT;
  return projectEntryForSynthesis(full, [
    "visual.colorRoles", "visual.typePairing", "layout", "voice",
    "antiPatterns", "patternType", "styleTags",
  ]);
}

describe("generateBrief — 2d-2 projected entries", () => {
  it("reports coverage counts per section over mixed entries", () => {
    const full = coveredEntry("a", ["visual.colorRoles", "visual.typePairing", "layout", "voice", "antiPatterns", "whatToSteal", "patternType", "styleTags"]);
    const partial = coveredEntry("b", ["whatToSteal"]);
    const brief = generateBrief([full, partial], { ids: ["a", "b"] });
    expect(brief.coverage.colorTokens).toEqual({ used: 1, total: 2, droppedFields: ["visual.colorRoles"] });
    expect(brief.coverage.voice).toEqual({ used: 1, total: 2, droppedFields: ["voice"] });
    expect(brief.coverage.techniques).toEqual({ used: 2, total: 2, droppedFields: [] });
  });

  it("does not throw on a fully-projected entry and falls back honestly", () => {
    const bare = coveredEntry("c", []);
    const brief = generateBrief([bare], { ids: ["c"] });
    expect(brief.coverage.voice.used).toBe(0);
    expect(brief.voice).toContain("No voice data");
    expect(brief.layout).toContain("moderate");
  });

  it("renders per-section Drawn-from disclosures only when coverage is partial", () => {
    const full = coveredEntry("a", ["visual.colorRoles", "visual.typePairing", "layout", "voice", "antiPatterns", "whatToSteal", "patternType", "styleTags"]);
    const partial = coveredEntry("b", ["whatToSteal"]);
    const brief = generateBrief([full, partial], { ids: ["a", "b"] });
    const md = renderBrief(brief);
    expect(md).toContain("_Drawn from 1 of 2 verified entries (missing: visual.colorRoles)._");
    expect(md).toContain("_Drawn from 1 of 2 verified entries (missing: voice)._");
  });

  it("renders a K=0-of-N disclosure when no entry carries the section's field", () => {
    const bare = coveredEntry("c", []);
    const brief = generateBrief([bare], { ids: ["c"] });
    const md = renderBrief(brief);
    expect(md).toContain("_Drawn from 0 of 1 verified entries (missing: voice)._");
  });

  it("renders byte-identically for a fully-verified brief (no disclosure artifacts)", () => {
    const full = coveredEntry("a", ["visual.colorRoles", "visual.typePairing", "layout", "voice", "antiPatterns", "whatToSteal", "patternType", "styleTags"]);
    const brief = generateBrief([full], { ids: ["a"] });
    const md = renderBrief(brief);
    expect(md).not.toContain("Drawn from");
    expect(md).toContain("--canvas:  #ffffff");
  });
});
```

Update the existing `"legacy brief output regression (Task 7)"` test: its assertion is `expect(Object.keys(brief).sort()).toEqual([...])` — add `"coverage"` to the expected sorted key array. (The other legacy tests in that describe are `toContain`/`not.toContain` style and survive unchanged: the coverage note contains no `---` or adapter vocabulary.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/design-prompt.test.ts`
Expected: FAIL — `DesignBrief` has no `coverage`, `ProjectedEntry` import unresolved, and the legacy-shape test fails.

- [ ] **Step 3: Implement the guarded `generateBrief` + coverage**

In `src/design-prompt.ts`, add the import:

```ts
import { renderCoverageDisclosure } from "./synthesis-projection.js";
import type { ProjectedEntry } from "./synthesis-projection.js";
```

Replace the `DesignBrief` interface and add the new types:

```ts
export type BriefSection = "colorTokens" | "typography" | "layout" | "voice" | "techniques" | "avoid";

export interface BriefCoverage {
  used: number;
  total: number;
  droppedFields: string[];
}

export interface DesignBrief {
  direction: string;
  sources: { id: string; product: string; contributes: string }[];
  colorTokens: { canvas: string; surface: string; ink: string; muted: string; accent: string };
  typography: string;
  layout: string;
  voice: string;
  techniques: string[];
  avoid: string[];
  framework: BriefFramework;
  context?: string;
  coverage: Record<BriefSection, BriefCoverage>;
}
```

Replace the `generateBrief` body with the guarded version (every enrichment read uses `?.` or a filtered fallback; coverage is computed from field PRESENCE on the projected entries):

```ts
export function generateBrief(entries: ProjectedEntry[], input: GenerateBriefInput): DesignBrief {
  const framework = input.framework ?? "brief";
  const total = entries.length;

  const withColors = entries.filter((e) => e.visual?.colorRoles);
  const colorTokens = withColors.length
    ? {
        canvas:  plurality(withColors.map((e) => e.visual!.colorRoles!.canvas))  ?? "#ffffff",
        surface: plurality(withColors.map((e) => e.visual!.colorRoles!.surface)) ?? "#f8f8f8",
        ink:     plurality(withColors.map((e) => e.visual!.colorRoles!.ink))     ?? "#111111",
        muted:   plurality(withColors.map((e) => e.visual!.colorRoles!.muted))   ?? "#888888",
        accent:  plurality(withColors.map((e) => e.visual!.colorRoles!.accent))  ?? "#3b82f6",
      }
    : { canvas: "#ffffff", surface: "#f8f8f8", ink: "#111111", muted: "#888888", accent: "#3b82f6" };

  const typeNotes = entries
    .map((e) => e.visual?.typePairing?.notes)
    .filter((n): n is string => !!n && n.trim().length > 20);
  const typography = typeNotes.length
    ? [...new Set(typeNotes)].slice(0, 3).join(" ")
    : "No specific typography notes in the selected entries — choose a clear hierarchy with restrained weights.";

  const layoutForms = entries.map((e) => e.layout?.form).filter((f) => f !== undefined);
  const form = plurality(layoutForms);
  const richestLayout = entries
    .filter((e) => e.layout?.regions?.length)
    .sort((a, b) => (b.layout?.regions?.length ?? 0) - (a.layout?.regions?.length ?? 0))[0];
  const regions = richestLayout?.layout?.regions ?? [];
  const regionDesc = regions.length
    ? regions.map((r) => `${r.role} (${r.width})`).join(" → ")
    : "standard content flow";
  const density = plurality(entries.map((e) => e.visual?.spacingDensity)) ?? "moderate";
  const corners = plurality(entries.map((e) => e.visual?.cornerStyle)) ?? "slight-round";
  const layout = form
    ? `${form} layout: ${regionDesc}. Density: ${density}, corners: ${corners}.`
    : `Density: ${density}, corners: ${corners}.`;

  const voices = entries
    .map((e) => e.voice?.tone)
    .filter((t): t is string => !!t && t.trim().length > 10);
  const voice = voices.length
    ? [...new Set(voices)].slice(0, 2).join(" ")
    : "No voice data in the selected entries.";

  const techniques = entries
    .map((e) => topSteal(e))
    .filter((t): t is string => !!t);

  const avoidKey = (s: string) => s.toLowerCase().slice(0, 50);
  const avoidCounts = new Map<string, number>();
  for (const e of entries) {
    for (const ap of e.antiPatterns?.antiPatterns ?? []) {
      const key = avoidKey(ap);
      avoidCounts.set(key, (avoidCounts.get(key) ?? 0) + 1);
    }
  }
  const seenKeys = new Set<string>();
  const deduped: string[] = [];
  for (const ap of entries.flatMap((e) => e.antiPatterns?.antiPatterns ?? [])) {
    const key = avoidKey(ap);
    if (!seenKeys.has(key)) { seenKeys.add(key); deduped.push(ap); }
  }
  const avoid = deduped
    .sort((a, b) => (avoidCounts.get(avoidKey(b)) ?? 0) - (avoidCounts.get(avoidKey(a)) ?? 0))
    .slice(0, 5);

  const sources = entries.map((e) => ({
    id: e.id,
    product: e.source.productName,
    contributes: e.visual?.colorRoles ? "color palette"
      : (e.visual?.typePairing?.notes && e.visual.typePairing.notes.length > 30) ? "typography hierarchy"
      : e.voice?.tone ? "voice & copy"
      : (e.layout?.regions?.length ?? 0) > 0 ? "layout structure"
      : "pattern example",
  }));

  const pattern = plurality(entries.map((e) => e.patternType));
  const contextClause = input.context ? ` for ${input.context}` : "";
  const voiceClause = voice.split(/[.,;—]/)[0].trim().toLowerCase() || "clear, direct";
  const direction = `Build a ${pattern ?? "UI"}${contextClause}. ` +
    `The throughline is ${plurality(entries.map((e) => e.styleTags).flat()) ?? "restraint"}: ` +
    `${form ? `a ${form} structure` : "a clear structure"} with ${density} spacing, ` +
    `an accent reserved for interactive elements, and a ${voiceClause} voice. ` +
    `The brief below distills the concrete decisions — each grounded in a specific entry you can inspect with get_ui_example.`;

  const countPresent = (pred: (e: ProjectedEntry) => boolean): number =>
    entries.filter(pred).length;
  const typePairingUsed = countPresent((e) => !!e.visual?.typePairing);
  const avoidUsed = countPresent((e) => (e.antiPatterns?.antiPatterns?.length ?? 0) > 0);

  const coverage: Record<BriefSection, BriefCoverage> = {
    colorTokens: { used: withColors.length, total, droppedFields: withColors.length < total ? ["visual.colorRoles"] : [] },
    typography: { used: typePairingUsed, total, droppedFields: typePairingUsed < total ? ["visual.typePairing"] : [] },
    layout: { used: layoutForms.length, total, droppedFields: layoutForms.length < total ? ["layout"] : [] },
    voice: { used: voices.length, total, droppedFields: voices.length < total ? ["voice"] : [] },
    techniques: { used: techniques.length, total, droppedFields: techniques.length < total ? ["whatToSteal"] : [] },
    avoid: { used: avoidUsed, total, droppedFields: avoidUsed < total ? ["antiPatterns"] : [] },
  };

  return { direction, sources, colorTokens, typography, layout, voice, techniques, avoid, framework, context: input.context, coverage };
}
```

Update `topSteal` to accept a projected entry:

```ts
function topSteal(entry: ProjectedEntry): string | undefined {
  if (!entry.whatToSteal?.length) return undefined;
  return [...entry.whatToSteal].sort((a, b) => b.length - a.length)[0];
}
```

Replace `renderBriefMarkdown` and `renderBriefTokens`:

```ts
function sectionNote(coverage: BriefCoverage): string {
  return renderCoverageDisclosure({
    used: coverage.used,
    total: coverage.total,
    dropped: coverage.droppedFields,
  });
}

export function renderBriefMarkdown(brief: DesignBrief): string {
  const lines: string[] = [];
  lines.push("# Design brief");
  if (brief.context) lines.push(`\n*Context: ${brief.context}*\n`);
  lines.push(`\n${brief.direction}\n`);
  lines.push(`\n## Sources\n`);
  brief.sources.forEach((s) => lines.push(`- Contributes: ${s.contributes}`));

  lines.push(`\n## Color tokens (paste-ready)`);
  lines.push("```css");
  lines.push(`:root {`);
  lines.push(`  --canvas:  ${brief.colorTokens.canvas};`);
  lines.push(`  --surface: ${brief.colorTokens.surface};`);
  lines.push(`  --ink:     ${brief.colorTokens.ink};`);
  lines.push(`  --muted:   ${brief.colorTokens.muted};`);
  lines.push(`  --accent:  ${brief.colorTokens.accent};`);
  lines.push(`}`);
  lines.push("```");
  const colorNote = sectionNote(brief.coverage.colorTokens);
  if (colorNote) lines.push(colorNote);

  lines.push(`\n## Typography`);
  lines.push(brief.typography);
  const typeNote = sectionNote(brief.coverage.typography);
  if (typeNote) lines.push(typeNote);

  lines.push(`\n## Layout`);
  lines.push(brief.layout);
  const layoutNote = sectionNote(brief.coverage.layout);
  if (layoutNote) lines.push(layoutNote);

  lines.push(`\n## Voice & copy`);
  lines.push(brief.voice);
  const voiceNote = sectionNote(brief.coverage.voice);
  if (voiceNote) lines.push(voiceNote);

  if (brief.techniques.length || brief.coverage.techniques.used < brief.coverage.techniques.total) {
    lines.push(`\n## Techniques to borrow`);
    brief.techniques.forEach((t, i) => lines.push(`${i + 1}. ${t}`));
    const techniquesNote = sectionNote(brief.coverage.techniques);
    if (techniquesNote) lines.push(techniquesNote);
  }

  if (brief.avoid.length || brief.coverage.avoid.used < brief.coverage.avoid.total) {
    lines.push(`\n## Avoid (anti-patterns consensus)`);
    brief.avoid.forEach((a) => lines.push(`- ${a}`));
    const avoidNote = sectionNote(brief.coverage.avoid);
    if (avoidNote) lines.push(avoidNote);
  }
  return lines.join("\n");
}

export function renderBriefTokens(brief: DesignBrief): string {
  const coverageEntries = Object.entries(brief.coverage).filter(([, c]) => c.used < c.total);
  const out: Record<string, unknown> = {
    direction: brief.direction,
    context: brief.context ?? null,
    sources: brief.sources.map((s) => ({ contributes: s.contributes })),
    tokens: {
      color: brief.colorTokens,
      spacing: brief.layout,
      typography: brief.typography,
      voice: brief.voice,
    },
    techniques: brief.techniques,
    avoid: brief.avoid,
  };
  if (coverageEntries.length) {
    out.coverage = Object.fromEntries(
      coverageEntries.map(([section, c]) => [section, { used: c.used, total: c.total, droppedFields: c.droppedFields }]),
    );
  }
  return JSON.stringify(out, null, 2);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/design-prompt.test.ts`
Expected: PASS — new coverage tests + updated legacy-shape test + pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add src/design-prompt.ts src/design-prompt.test.ts
git commit -m "feat(trust): generateBrief guards enrichment + DesignBrief.coverage with per-section disclosures"
```

---

### Task 3: `recommend.ts` — projected search results + guarded contributionNote

**Files:**
- Modify: `src/recommend.ts`
- Test: `src/recommend.test.ts` (extend)

**Interfaces:**
- Consumes: `ProjectedEntry` (Task 1).
- Produces: `ProjectedSearchResult = Omit<SearchResult, "entry"> & { entry: ProjectedEntry }`; `pickDiverse<T extends { entry: ProjectedEntry }>(...)`; `buildRecommendation(results: ProjectedSearchResult[], input)`; `contributionNote(entry: ProjectedEntry)`.

- [ ] **Step 1: Write the failing tests**

Append to `src/recommend.test.ts`:

```ts
import { projectEntryForSynthesis } from "./synthesis-projection.js";

const REC = { method: "measured", verifiedAt: "2026-08-06", verifierVersion: "v1" };

function projectedResult(id: string, product: string, score: number, verifiedFor: readonly string[]): ProjectedSearchResult {
  const verification: Record<string, unknown> = {};
  for (const field of verifiedFor) verification[field] = REC;
  const base = entry(id, product, score);
  return {
    score: base.score,
    searchMode: base.searchMode,
    entry: projectEntryForSynthesis(
      { ...base.entry, provenance: { taggedBy: "auto", verification } } as CorpusEntryT,
      ["visual.colorRoles", "voice", "layout", "antiPatterns", "patternType", "styleTags", "visual.typePairing", "visual.spacingDensity", "visual.cornerStyle"],
    ),
  };
}

describe("contributionNote — 2d-2 projected entries", () => {
  it("falls through to corpus example when every distinctive signal is unverified", () => {
    const r = projectedResult("a1", "Cash App", 0.9, ["whatToSteal"]);
    expect(contributionNote(r.entry)).toBe("corpus example");
  });

  it("does not leak an unverified patternType into a color contribution note", () => {
    const r = projectedResult("a1", "Cash App", 0.9, ["whatToSteal", "visual.colorRoles"]);
    expect(contributionNote(r.entry)).toBe("color palette + UI");
  });
});

describe("buildRecommendation — 2d-2 projected entries", () => {
  it("builds a recommendation from projected entries without crashing", () => {
    const results = [
      projectedResult("a1", "Cash App", 0.9, ["whatToSteal", "visual.colorRoles"]),
      projectedResult("b1", "Linear", 0.85, ["whatToSteal"]),
    ];
    const rec = buildRecommendation(results, { productContext: "A calm analytics dashboard", count: 2 });
    expect(rec.rationale.length).toBe(2);
    expect(rec.brief.coverage.voice.used).toBe(0);
  });
});
```

Update the import block at the top of `recommend.test.ts` to also import `contributionNote` and `type ProjectedSearchResult`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/recommend.test.ts`
Expected: FAIL — `contributionNote` / `ProjectedSearchResult` not exported; `buildRecommendation` does not accept projected entries.

- [ ] **Step 3: Implement the projected types + guarded functions**

In `src/recommend.ts`, replace the import and add:

```ts
import type { CorpusEntryT } from "./schema.js";
import type { SearchResult } from "./corpus.js";
import type { ProjectedEntry } from "./synthesis-projection.js";
import { generateBrief, renderBrief, type DesignBrief, type BriefFramework } from "./design-prompt.js";

export type ProjectedSearchResult = Omit<SearchResult, "entry"> & { entry: ProjectedEntry };
```

Replace `pickDiverse` and `contributionNote`:

```ts
export function pickDiverse<T extends { entry: ProjectedEntry }>(results: T[], count: number, maxPerProduct = 2): T[] {
  const ranked = [...results].sort((a, b) => b.score - a.score);
  const selected: T[] = [];
  const perProduct = new Map<string, number>();
  for (const r of ranked) {
    if (selected.length >= count) break;
    const product = r.entry.source.productName;
    const have = perProduct.get(product) ?? 0;
    if (have >= maxPerProduct) continue;
    selected.push(r);
    perProduct.set(product, have + 1);
  }
  if (selected.length < count) {
    const have = new Set(selected.map((s) => s.entry.id));
    for (const r of ranked) {
      if (selected.length >= count) break;
      if (!have.has(r.entry.id)) selected.push(r);
    }
  }
  return selected.slice(0, count);
}

function contributionNote(entry: ProjectedEntry): string {
  if (entry.visual?.colorRoles) return `color palette + ${entry.patternType ?? "UI"}`;
  if (entry.voice?.tone) return `voice/copy + ${entry.patternType ?? "UI"}`;
  if (entry.layout?.regions?.length) return `layout structure (${entry.layout.form ?? "standard"})`;
  return entry.patternType ? `${entry.patternType} example` : "corpus example";
}
```

Replace `buildRecommendation`:

```ts
export function buildRecommendation(results: ProjectedSearchResult[], input: RecommendInput): Recommendation {
  const count = Math.min(Math.max(input.count ?? 3, 1), 5);
  const selected = pickDiverse(results, count);

  const rationale = selected.map((r, i) => ({
    id: r.entry.id,
    product: r.entry.source.productName,
    score: Number(r.score.toFixed(3)),
    rank: i + 1,
    note: contributionNote(r.entry),
  }));

  const brief = generateBrief(selected.map((s) => s.entry), {
    ids: selected.map((s) => s.entry.id),
    framework: input.framework ?? "brief",
    context: input.productContext,
  });

  return { brief, rationale, productContext: input.productContext };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/recommend.test.ts`
Expected: PASS — new tests + pre-existing `pickDiverse` / `buildRecommendation` cases (their `SearchResult[]` fixtures are structurally assignable to `ProjectedSearchResult[]`).

- [ ] **Step 5: Commit**

```bash
git add src/recommend.ts src/recommend.test.ts
git commit -m "feat(trust): recommend consumes ProjectedEntry — guarded contributionNote, projected search results"
```

---

### Task 4: `aggregations.ts` — palette-local verified filter + `patternType: string | null`

**Files:**
- Modify: `src/aggregations.ts`
- Test: `src/aggregations.test.ts` (extend)

**Interfaces:**
- Consumes: `ProjectedEntry`, `isVerified`.
- Produces: `collectPalettes(entries: ProjectedEntry[], opts, limit): PaletteResult[]` where `PaletteResult.patternType: string | null`; the verified-only `patternType` match applies ONLY inside `collectPalettes`; shared `filterEntries` becomes generic and type-safe but behavior-identical.

- [ ] **Step 1: Write the failing tests**

Append to `src/aggregations.test.ts`:

```ts
import { projectEntryForSynthesis } from "./synthesis-projection.js";

const PAL_RECORD = { method: "measured", verifiedAt: "2026-08-06", verifierVersion: "v1" };

function paletteEntry(id: string, patternType: string | undefined, verifiedFor: readonly string[]): CorpusEntryT {
  const verification: Record<string, unknown> = {};
  for (const field of verifiedFor) verification[field] = PAL_RECORD;
  return {
    id,
    source: { productName: `Product ${id}`, url: null, capturedAt: "2026-07-01", capturedBy: "self" },
    patternType,
    visual: { colorRoles: { canvas: "#ffffff", surface: "#f8f8f8", ink: "#111111", muted: "#888888", accent: "#3b82f6" } },
    styleTags: ["minimal"],
    reviewStatus: "approved",
    provenance: { taggedBy: "auto", verification },
  } as unknown as CorpusEntryT;
}

describe("collectPalettes — 2d-2 projected entries", () => {
  it("emits patternType null when the label is unverified", () => {
    const e = projectEntryForSynthesis(paletteEntry("p1", "dashboard", ["visual.colorRoles"]), ["patternType"]);
    const results = collectPalettes([e], {}, 10);
    expect(results[0].patternType).toBeNull();
  });

  it("narrows a patternType filter to VERIFIED matches only", () => {
    const verified = paletteEntry("p1", "dashboard", ["visual.colorRoles", "patternType"]);
    const unverifiedLabel = projectEntryForSynthesis(paletteEntry("p2", "dashboard", ["visual.colorRoles"]), ["patternType"]);
    const results = collectPalettes([verified, unverifiedLabel], { patternType: "dashboard" }, 10);
    expect(results.map((r) => r.id)).toEqual(["p1"]);
  });

  it("keeps raw-value matching in shared filterEntries for tools that do not render patternType", () => {
    const unverifiedLabel = projectEntryForSynthesis(paletteEntry("p2", "dashboard", ["visual.colorRoles"]), ["patternType"]);
    const filtered = filterEntries([unverifiedLabel], { patternType: "dashboard" });
    expect(filtered.map((e) => e.id)).toEqual(["p2"]);
  });
});
```

The test file's import list gains `filterEntries` and `ProjectedEntry` (type) alongside the existing imports.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/aggregations.test.ts`
Expected: FAIL — `filterEntries` not exported, `PaletteResult.patternType` is `string` (not nullable), and the palette-null test fails.

- [ ] **Step 3: Implement the changes**

In `src/aggregations.ts`, replace the import:

```ts
import type { CorpusEntryT } from "./schema.js";
import type { ProjectedEntry } from "./synthesis-projection.js";
import { isVerified } from "./corpus-trust.js";
```

Replace `filterEntries` with the generic, type-safe version (behavior identical — optional chaining is a no-op for callers that pass fully-populated entries):

```ts
export function filterEntries<T extends ProjectedEntry>(entries: readonly T[], opts: FilterOpts): T[] {
  const statusFilter = opts.reviewStatus ?? "approved";
  return entries.filter((e) => {
    if (statusFilter === "approved" && e.reviewStatus === "draft") return false;
    if (statusFilter === "draft" && e.reviewStatus !== "draft") return false;
    if (opts.patternType && e.patternType !== opts.patternType) return false;
    if (opts.category && !e.categories?.includes(opts.category as never)) return false;
    if (opts.styleTag && !e.styleTags?.includes(opts.styleTag as never)) return false;
    return true;
  });
}
```

Replace `PaletteResult` and `collectPalettes`:

```ts
export interface PaletteResult {
  id: string;
  product: string;
  patternType: string | null; // null when the label was unverified and omitted
  tokens: { canvas: string; surface: string; ink: string; muted: string | null; accent: string };
  accentHue: number; // 0-360, for grouping
}

export function collectPalettes(entries: ProjectedEntry[], opts: FilterOpts, limit = 10): PaletteResult[] {
  // Palette rows PUBLISH the filter key as a label, so a patternType-scoped
  // request matches only entries whose patternType is VERIFIED — the caller
  // never sees an unverified label. This is palette-LOCAL: get_anti_patterns /
  // get_stealable_techniques / browse_ui_examples filter on patternType without
  // rendering it and keep raw-value matching via shared filterEntries.
  const filtered = filterEntries(entries, opts).filter(
    (e) => e.visual?.colorRoles && (!opts.patternType || isVerified(e as CorpusEntryT, "patternType")),
  );
  return filtered
    .map((e) => {
      const cr = e.visual!.colorRoles!;
      return {
        id: e.id,
        product: e.source.productName,
        patternType: e.patternType ?? null,
        tokens: { canvas: cr.canvas, surface: cr.surface, ink: cr.ink, muted: cr.muted, accent: cr.accent },
        accentHue: hexToHue(cr.accent),
      };
    })
    .sort((a, b) => a.accentHue - b.accentHue)
    .slice(0, limit);
}
```

The other aggregation functions (`aggregateAntiPatterns`, `collectTechniques`, `browseByPattern`) keep `CorpusEntryT[]` parameters — `CorpusEntryT` is assignable to `ProjectedEntry`, so the shared `filterEntries` call still typechecks and their own enrichment reads stay non-optional.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/aggregations.test.ts`
Expected: PASS — new tests + pre-existing cases.

- [ ] **Step 5: Commit**

```bash
git add src/aggregations.ts src/aggregations.test.ts
git commit -m "feat(trust): collectPalettes projects entries — palette-local verified patternType filter, nullable label"
```

---

### Task 5: Server wiring + `compare_ui_examples` renderer

**Files:**
- Modify: `src/server-factory.ts` (constants block, `createServer` registrations, `registerCompareUiExamples`)
- Test: `src/synthesis-serving.test.ts` (create)

**Interfaces:**
- Consumes: `ProjectedEntry`, `projectEntryForSynthesis` (Task 1); `projectForServing` (2d-1, already imported).
- Produces: the three tools wired `(core, enrichment)`; compare renders projected cells with `—` for unverified fields, the platform `"web"` default only for verified-absent platform, and a per-column disclosure block.

- [ ] **Step 1: Write the failing tests**

Create `src/synthesis-serving.test.ts` (the shared fixture file for Tasks 5-7; Tasks 6 and 7 append to it):

```ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server-factory.js";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";

const RECORD = { method: "image-confirmed", verifiedAt: "2026-08-06", verifierVersion: "fixture", imageSha256: "a".repeat(64) };

function verificationFor(fields: readonly string[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const field of fields) map[field] = RECORD;
  return map;
}

export function synthEntry(id: string, verifiedFor: readonly string[]): CorpusEntryT {
  return {
    id,
    title: `${id} title`,
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    source: { productName: `Product ${id}`, url: "https://example.com", capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "", width: 1440, height: 900 },
    visual: {
      dominantColors: ["#ffffff"],
      accentColor: "#2563eb",
      colorRoles: { canvas: "#ffffff", surface: "#f8fafc", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
      typePairing: { display: "Inter", body: "Inter", notes: "Clear hierarchy with restrained type weights." },
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
      usesShadows: false,
      usesBorders: true,
    },
    layout: { form: "sidebar", regions: [{ role: "primary-nav", width: "240px" }] },
    platform: "web",
    critique: "SYNTH_CRITIQUE — a restrained layout that stays readable.",
    whatToSteal: ["SYNTH_STEAL — group metric tiles on one baseline."],
    // One a11y risk present so the FULLY-VERIFIED compare test can assert the
    // a11y row renders a value (an empty list would render "—" and break
    // `not.toContain("—")`).
    antiPatterns: { antiPatterns: ["SYNTH_ANTI — avoid stacking two shadow depths."], whereThisFails: [], accessibilityRisks: [{ element: "button", risk: "SYNTH_A11Y — low contrast", evidence: "measured", wcag: ["1.4.3"] }] },
    voice: { tone: "SYNTH_VOICE — restrained and confident", examples: ["Example"], avoid: [] },
    qualityTier: "exceptional",
    qualityScore: 4,
    reviewStatus: "approved",
    addedAt: "2026-07-01",
    provenance: { taggedBy: "auto", verification: verificationFor(verifiedFor) },
  } as unknown as CorpusEntryT;
}

export function synthReaderWith(e: CorpusEntryT): CorpusReader {
  return {
    search: async () => [e],
    searchRanked: async () => [{ entry: e, score: 5, searchMode: "vector" as const }],
    getById: (id: string) => (id === e.id ? e : undefined),
    findSimilar: () => [{ entry: e, score: 1 }],
    listCategories: () => ["dashboard"],
    listStyleTags: () => ["minimal"],
    listDomainTags: () => ["analytics"],
    indexStatus: () => ({ indexed: 1, total: 1, hasIndex: true, missing: 0, stale: 0, contentStale: 0 }),
    entriesForAggregation: () => [e],
    resolveImagePath: () => null,
    getImageIndex: async () => null,
  } as unknown as CorpusReader;
}

export async function callTool(name: string, args: Record<string, unknown>, e: CorpusEntryT): Promise<string> {
  const server = createServer(synthReaderWith(e));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synthesis-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    return content.map((c) => c.text ?? "").join("\n");
  } finally {
    await client.close();
  }
}

describe("compare_ui_examples — 2d-2 projected cells", () => {
  it("renders — for unverified cells, never the 'web' platform default", async () => {
    const e = synthEntry("entry-a", ["critique", "whatToSteal"]);
    const text = await callTool("compare_ui_examples", { ids: ["entry-a", "entry-a"] }, e);
    expect(text).toContain("SYNTH_CRITIQUE");
    expect(text).not.toContain("SYNTH_ANTI");
    expect(text).not.toContain("SYNTH_VOICE");
    expect(text).not.toContain("web");
    expect(text).toContain("—");
    expect(text).toContain("_Column disclosures:_");
    expect(text).toContain("**entry-a**: Unverified fields omitted:");
  });

  it("renders byte-identically for a fully-verified entry (no disclosure block)", async () => {
    const all = [
      "critique", "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks",
      "categories", "styleTags", "patternType", "platform", "layout",
      "visual.accentColor", "visual.colorRoles", "visual.spacingDensity",
      "visual.cornerStyle", "visual.usesShadows", "visual.usesBorders",
    ];
    const e = synthEntry("entry-a", all);
    const text = await callTool("compare_ui_examples", { ids: ["entry-a", "entry-a"] }, e);
    expect(text).toContain("| web |");
    expect(text).not.toContain("Column disclosures");
    expect(text).not.toContain("—");
  });

  it("renders projected rows in concise mode with the column disclosure", async () => {
    const e = synthEntry("entry-a", ["critique", "whatToSteal"]);
    const text = await callTool("compare_ui_examples", { ids: ["entry-a", "entry-a"], responseFormat: "concise" }, e);
    expect(text).toContain("| platform |"); // concise keeps the platform row
    expect(text).toContain("_Column disclosures:_");
    expect(text).not.toContain("top steal"); // concise drops the detailed rows
    expect(text).not.toContain("a11y risks");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/synthesis-serving.test.ts`
Expected: FAIL — compare still renders unverified `platform` as "web" and has no column disclosure.

- [ ] **Step 3: Rewire `createServer` and rewrite the compare renderer**

In `src/server-factory.ts`, delete `COMPARE_UI_EXAMPLES_FULL_SET` and `RECOMMEND_UI_DIRECTION_FULL_SET`, then update the registrations:

```ts
  registerCompareUiExamples(
    server,
    new TrustGatedCorpusReader(reader, COMPARE_UI_EXAMPLES_CORE, COMPARE_UI_EXAMPLES_ENRICHMENT),
  );
```

```ts
  registerRecommendUiDirection(
    server,
    new TrustGatedCorpusReader(reader, RECOMMEND_UI_DIRECTION_CORE, RECOMMEND_UI_DIRECTION_ENRICHMENT),
  );
```

```ts
  registerGetColorPalette(server, new TrustGatedCorpusReader(reader, GET_COLOR_PALETTE_CORE, GET_COLOR_PALETTE_ENRICHMENT));
```

Add the import:

```ts
import { projectEntryForSynthesis } from "./synthesis-projection.js";
```

Replace the body of `registerCompareUiExamples`'s handler (after the `found` / `concise` setup) with:

```ts
      const projections = found.map((e) => ({
        id: e.id,
        entry: projectEntryForSynthesis(e, COMPARE_UI_EXAMPLES_ENRICHMENT),
        omitted: projectForServing(e, COMPARE_UI_EXAMPLES_ENRICHMENT).omitted,
      }));

      const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
      const firstSentence = (s: string) => cell(s.split(/[.!?]/)[0] || s);
      const top = (arr: string[]) => cell(arr[0] ?? "—");
      const topRisk = (risks: AccessibilityRiskT[]) =>
        cell(risks.length ? formatAccessibilityRisk(risks[0]) : "—");
      // A cell renders "—" when its driving field was omitted (unverified); the
      // platform "web" default applies ONLY to a verified-but-absent platform,
      // never to an unverified one (that would emit a value never seen verified).
      const fieldCell = (p: (typeof projections)[number], field: string, render: () => string): string =>
        p.omitted.includes(field) ? "—" : cell(render());
      const accentCell = (p: (typeof projections)[number]): string => {
        if (!p.omitted.includes("visual.accentColor")) {
          return cell(p.entry.visual?.accentColor ?? p.entry.visual?.colorRoles?.accent ?? "—");
        }
        return p.omitted.includes("visual.colorRoles")
          ? "—"
          : cell(p.entry.visual?.colorRoles?.accent ?? "—");
      };

      const header = `| Field | ${projections.map((p) => cell(
        [
          p.entry.patternType,
          ...(p.entry.categories ?? []),
          ...(p.entry.styleTags ?? []),
        ].filter(Boolean).join(" — ") || "corpus example",
      )).join(" | ")} |`;
      const divider = `| --- | ${projections.map(() => "---").join(" | ")} |`;
      const rows = [
        `| categories | ${projections.map((p) => fieldCell(p, "categories", () => (p.entry.categories ?? []).join(", "))).join(" | ")} |`,
        `| styleTags | ${projections.map((p) => fieldCell(p, "styleTags", () => (p.entry.styleTags ?? []).join(", "))).join(" | ")} |`,
        `| platform | ${projections.map((p) => fieldCell(p, "platform", () => p.entry.platform ?? "web")).join(" | ")} |`,
        `| layout | ${projections.map((p) => fieldCell(p, "layout", () => p.entry.layout?.form ?? "—")).join(" | ")} |`,
        `| accent | ${projections.map((p) => accentCell(p)).join(" | ")} |`,
        `| density / corners | ${projections.map((p) => cell(
          `${p.omitted.includes("visual.spacingDensity") ? "—" : p.entry.visual?.spacingDensity ?? "—"} / ${p.omitted.includes("visual.cornerStyle") ? "—" : p.entry.visual?.cornerStyle ?? "—"}`,
        )).join(" | ")} |`,
        `| shadows / borders | ${projections.map((p) => cell(
          `${p.omitted.includes("visual.usesShadows") ? "—" : p.entry.visual?.usesShadows ? "yes" : "no"} / ${p.omitted.includes("visual.usesBorders") ? "—" : p.entry.visual?.usesBorders ? "yes" : "no"}`,
        )).join(" | ")} |`,
        ...(concise ? [] : [
          `| critique angle | ${projections.map((p) => firstSentence(p.entry.critique)).join(" | ")} |`,
          `| top steal | ${projections.map((p) => fieldCell(p, "whatToSteal", () => top(p.entry.whatToSteal ?? []))).join(" | ")} |`,
          `| anti-patterns | ${projections.map((p) => fieldCell(p, "antiPatterns", () => top(p.entry.antiPatterns?.antiPatterns ?? []))).join(" | ")} |`,
          `| a11y risks | ${projections.map((p) => fieldCell(p, "antiPatterns.accessibilityRisks", () => topRisk(p.entry.antiPatterns?.accessibilityRisks ?? []))).join(" | ")} |`,
        ]),
      ];

      const table = [header, divider, ...rows];
      const columnDisclosures = projections
        .filter((p) => p.omitted.length > 0)
        .map((p) => `- **${p.id}**: Unverified fields omitted: ${p.omitted.join(", ")}.`);
      if (columnDisclosures.length) {
        table.push("", "_Column disclosures:_", ...columnDisclosures);
      }

      return { content: [{ type: "text", text: table.join("\n") }] };
```

Note: the old handler's closing `return { content: ... }` for the rows array is replaced by the `table` join above — delete the old `[header, divider, ...rows].join("\n")` return.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/synthesis-serving.test.ts`
Expected: PASS (compare cases). Then `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server-factory.ts src/synthesis-serving.test.ts
git commit -m "feat(trust): compare_ui_examples projects cells — — for unverified, column disclosures, no web default"
```

---

### Task 6: `get_color_palette` renderer — nullable label + filter-aware empty message

**Files:**
- Modify: `src/server-factory.ts` (`registerGetColorPalette`)
- Test: `src/synthesis-serving.test.ts` (append)

**Interfaces:**
- Consumes: `collectPalettes` with nullable `patternType` (Task 4), `projectEntryForSynthesis` (Task 1).
- Produces: palette rows that omit the label when unverified (with `_Pattern label omitted (unverified)._`), and a filter-aware empty message for verified-only `patternType` matches.

- [ ] **Step 1: Write the failing tests**

Append to `src/synthesis-serving.test.ts`:

```ts
describe("get_color_palette — 2d-2 nullable label", () => {
  it("serves the palette with the label omitted+disclosed when patternType is unverified", async () => {
    const e = synthEntry("pal-1", ["visual.colorRoles", "critique"]);
    const text = await callTool("get_color_palette", { limit: 5 }, e);
    expect(text).toContain("--accent:#2563eb");
    expect(text).not.toContain("**dashboard**");
    expect(text).toContain("_Pattern label omitted (unverified)._");
  });

  it("narrows a patternType filter to verified matches and names the filter key when empty", async () => {
    const e = synthEntry("pal-1", ["visual.colorRoles"]); // patternType unverified
    const text = await callTool("get_color_palette", { patternType: "dashboard", limit: 5 }, e);
    expect(text).not.toContain("#2563eb");
    expect(text).toMatch(/VERIFIED patternType/i);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/synthesis-serving.test.ts`
Expected: FAIL — the palette handler still renders `**dashboard**` from the raw entry and the empty message is the generic core-posture one.

- [ ] **Step 3: Implement the projected palette handler**

Replace the body of `registerGetColorPalette`'s handler:

```ts
    async ({ patternType, styleTag, limit }) => {
      const entries = [...reader.entriesForAggregation()]
        .map((e) => projectEntryForSynthesis(e, GET_COLOR_PALETTE_ENRICHMENT));
      const results = collectPalettes(entries, { patternType: patternType as string | undefined, styleTag: styleTag as string | undefined }, limit ?? 10);
      if (!results.length) {
        if (patternType) {
          // The verified-only patternType match is the cause — name it, not the
          // generic core posture (entries may be verified for colorRoles but not
          // for the de-facto patternType filter key).
          return {
            content: [{
              type: "text",
              text: `No palettes available for patternType '${patternType}': palettes are matched only from entries whose patternType label is VERIFIED, and none matched.`,
            }],
          };
        }
        return { content: [{ type: "text", text: emptyCorpusMessage(reader, "palettes") }] };
      }
      const lines = [`# Color palettes (${results.length})\n`];
      let lastBand = "";
      for (const p of results) {
        const band = hueBand(p.accentHue);
        if (band !== lastBand) { lines.push(`\n## ${band} accents\n`); lastBand = band; }
        if (p.patternType === null) {
          lines.push(`_Pattern label omitted (unverified)._`);
        } else {
          lines.push(`**${p.patternType}**`);
        }
        lines.push("```css");
        lines.push(`  --canvas:${p.tokens.canvas}; --surface:${p.tokens.surface}; --ink:${p.tokens.ink}; --muted:${p.tokens.muted ?? "inherit"}; --accent:${p.tokens.accent};`);
        lines.push("```\n");
      }
      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/synthesis-serving.test.ts`
Expected: PASS (compare + palette cases). Then `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server-factory.ts src/synthesis-serving.test.ts
git commit -m "feat(trust): get_color_palette projects entries — nullable row label + filter-aware empty message"
```

---

### Task 7: `recommend_ui_direction` + `generate_design_prompt` handlers

**Files:**
- Modify: `src/server-factory.ts` (`registerRecommendUiDirection`, `registerGenerateDesignPrompt`)
- Test: `src/synthesis-serving.test.ts` (append)

**Interfaces:**
- Consumes: `buildRecommendation(results: ProjectedSearchResult[], ...)` (Task 3), `projectEntryForSynthesis` (Task 1).
- Produces: recommend serves projected entries through `searchRanked`; the private `generate_design_prompt` handler projects with `GENERATE_DESIGN_PROMPT_ENRICHMENT`.

- [ ] **Step 1: Write the failing tests**

Append to `src/synthesis-serving.test.ts`:

```ts
describe("recommend_ui_direction — 2d-2 projected brief", () => {
  it("serves a brief with coverage disclosures and no unverified enrichment", async () => {
    const e = synthEntry("rec-1", ["critique", "whatToSteal", "visual.colorRoles"]);
    const text = await callTool("recommend_ui_direction", { productContext: "A calm analytics dashboard", count: 1 }, e);
    expect(text).toContain("SYNTH_STEAL"); // verified core-derived technique
    expect(text).not.toContain("SYNTH_ANTI"); // unverified — absent
    expect(text).not.toContain("SYNTH_VOICE"); // unverified — absent
    expect(text).toContain("Drawn from"); // coverage disclosure present
  });

  it("does not leak an unverified patternType into the contribution note", async () => {
    const e = synthEntry("rec-1", ["critique", "whatToSteal", "visual.colorRoles"]);
    const text = await callTool("recommend_ui_direction", { productContext: "A calm analytics dashboard", count: 1 }, e);
    expect(text).not.toContain("color palette + dashboard"); // patternType unverified
  });

  it("renders byte-identically for a fully-verified entry (no coverage disclosures)", async () => {
    const all = [
      "critique", "whatToSteal", "visual.colorRoles", "visual.typePairing",
      "visual.spacingDensity", "visual.cornerStyle", "layout", "voice",
      "antiPatterns", "patternType", "styleTags",
    ];
    const e = synthEntry("rec-1", all);
    const text = await callTool("recommend_ui_direction", { productContext: "A calm analytics dashboard", count: 1 }, e);
    expect(text).toContain("SYNTH_STEAL");
    expect(text).not.toContain("Drawn from");
  });
});
```

Note: the contribution note for a color-only entry renders `color palette + UI` (Task 3), so the second assertion is `not.toContain("color palette + dashboard")`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/synthesis-serving.test.ts`
Expected: FAIL — the recommend handler passes raw entries into `buildRecommendation`, so unverified `SYNTH_ANTI`/`SYNTH_VOICE` leak into the brief (or the brief reads unverified fields) and the coverage disclosures are absent.

- [ ] **Step 3: Implement the projected handlers**

Replace the recommendation assembly in `registerRecommendUiDirection`:

```ts
      const results = await reader.searchRanked({ query: productContext, category: category as string | undefined, qualityTier: qualityTier as string | undefined, platform: platform as "web" | "mobile" | "tablet" | undefined, limit: 20 });
      if (!results.length) {
        const scope = qualityTier === "cautionary" ? " cautionary" : "";
        return { content: [{ type: "text", text: emptyCorpusMessage(reader, `${scope} corpus entries matching "${productContext}"`.trim()) }] };
      }
      const projectedResults = results.map((r) => ({
        ...r,
        entry: projectEntryForSynthesis(r.entry, RECOMMEND_UI_DIRECTION_ENRICHMENT),
      }));
      const rec = buildRecommendation(projectedResults, { productContext, count, category: category as string | undefined, framework: framework ?? "brief" });
```

Replace the entry fetch in `registerGenerateDesignPrompt`:

```ts
      const found = entries.filter((e): e is NonNullable<typeof e> => !!e);
      const projected = found.map((e) => projectEntryForSynthesis(e, GENERATE_DESIGN_PROMPT_ENRICHMENT));
      const brief = generateBrief(projected, { ids, framework: framework ?? "brief", context });
      return { content: [{ type: "text", text: renderBrief(brief) }] };
```

**Residual (documented):** `registerGenerateDesignPrompt` is never invoked, so no reader is gated today and the projection above enforces ENRICHMENT only. If the tool is ever re-registered, it must be wired with `new TrustGatedCorpusReader(reader, GENERATE_DESIGN_PROMPT_CORE, GENERATE_DESIGN_PROMPT_ENRICHMENT)` so the `whatToSteal` core gate applies — the constants are already exported for that.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/synthesis-serving.test.ts`
Expected: PASS (compare + palette + recommend cases). Then `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server-factory.ts src/synthesis-serving.test.ts
git commit -m "feat(trust): recommend + generate_design_prompt serve projected entries with coverage disclosures"
```

---

### Task 8: Cross-tool invariant sweep — partial-serves + byte-identical pin

**Files:**
- Modify: `src/invariant-sweep.test.ts`

**Interfaces:**
- Consumes: the full 2d-2 wiring (Tasks 5-7).
- Produces: the sweep now drives all three synthesis tools with a partially-verified entry (served, not refused), asserts no unverified sentinel appears, and pins fully-verified output as disclosure-free.

- [ ] **Step 1: Write the failing tests**

In `src/invariant-sweep.test.ts`:

1. Change the fixture verification so all three synthesis cores verify: `const VERIFIED = ["critique", "whatToSteal", "visual.colorRoles"];`
2. Update the sweep's `readerWith` `indexStatus` so recommend reaches the corpus: `hasIndex: true` (replace `hasIndex: false` in the fixture reader).
3. Replace the `"holds the deferred synthesis tools at full-AND — no partial entry serves"` test with:

```ts
describe("2d-2 synthesis tools serve partial entries with disclosure, never unverified values", () => {
  it("compare, palette and recommend serve a partial entry and disclose, with no sentinel leak", async () => {
    const e = entry(VERIFIED);
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: "compare_ui_examples", args: { ids: ["sweep-entry", "sweep-entry"] } },
      { tool: "get_color_palette", args: { limit: 5 } },
      { tool: "recommend_ui_direction", args: { productContext: "A calm analytics dashboard", count: 1 } },
    ];
    // Sentinel fields each tool actually RENDERS from verified values. A verified
    // field the tool never renders (e.g. critique in a palette) must not be
    // required to appear.
    const TOOL_VERIFIED_CONTAINS: Record<string, readonly string[]> = {
      compare_ui_examples: ["critique", "whatToSteal", "visual.colorRoles"],
      get_color_palette: ["visual.colorRoles"],
      recommend_ui_direction: ["whatToSteal", "visual.colorRoles"],
    };
    for (const { tool, args } of cases) {
      const text = await callTool(tool, args, e);
      for (const [field, sentinel] of Object.entries(S)) {
        const gatedKey =
          field === "antiPatternsAccessibilityRisks" ? "antiPatterns.accessibilityRisks"
          : field === "visualDominantColors" ? "visual.dominantColors"
          : field === "visualAccentColor" ? "visual.accentColor"
          : field === "visualColorRoles" ? "visual.colorRoles"
          : field === "visualTypePairing" ? "visual.typePairing"
          : field;
        const shouldAppear = (TOOL_VERIFIED_CONTAINS[tool] ?? []).includes(gatedKey);
        if (shouldAppear) {
          expect(text, `${tool} should serve verified ${gatedKey}`).toContain(sentinel);
        } else {
          expect(text, `${tool} leaked unverified or non-rendered ${gatedKey}`).not.toContain(sentinel);
        }
      }
      expect(text, `${tool} served a partial entry without disclosing`).toMatch(
        /Unverified fields omitted|Drawn from|Pattern label omitted|Column disclosures/,
      );
    }
  });

  it("byte-identical pin: a fully-verified fixture renders today's output with no disclosure artifacts", async () => {
    // The pin is palette-scoped: verify colorRoles (core) AND patternType (the
    // only palette enrichment) so the label renders exactly as it did pre-2d-2.
    const e = entry(["visual.colorRoles", "patternType"]);
    const text = await callTool("get_color_palette", { limit: 5 }, e);
    expect(text).toContain("**dashboard**");
    expect(text).not.toContain("Pattern label omitted");
    expect(text).not.toContain("Drawn from");
    expect(text).not.toContain("Column disclosures");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/invariant-sweep.test.ts`
Expected: FAIL — the old full-AND assertion no longer holds (tools serve partial entries), and the new assertions catch sentinel leaks until Tasks 5-7 land.

- [ ] **Step 3: Implement**

No production code changes — this task only rewrites the sweep. Tasks are sequential; the sweep must be run after Tasks 5-7.

- [ ] **Step 4: Run the full sweep to verify it passes**

Run: `npx vitest run src/invariant-sweep.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/invariant-sweep.test.ts
git commit -m "test(trust): sweep covers synthesis tools — partial-serves with disclosure, byte-identical fully-verified pin"
```

---

### Task 9: Final verification + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-08-06-field-set-gating-2d2-design.md` — status to "**Status:** implemented" only after 2d-2 ships.

- [ ] **Step 1: Full-suite verification**

Run: `npm test`
Expected: PASS except the known environmental `ui-browser` Playwright launch failure (unrelated to this branch).
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Update the spec status**

Set the 2d-2 spec's status line to:

```md
**Status:** implemented
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-06-field-set-gating-2d2-design.md
git commit -m "docs(spec): field-set gating 2d-2 implemented"
```

---

## Self-Review

**Spec coverage (2d-2):**
- ProjectedEntry concrete type + non-mutating projection + coverage disclosure → Task 1 (including the whitelist contract test).
- Guarded `generateBrief` with the full guard inventory (`typePairing.notes`, `spacingDensity`/`cornerStyle`, `voice.tone`, `antiPatterns.antiPatterns`, `patternType`, `styleTags`, `layout.form`/`regions`) + `DesignBrief.coverage` + renderers → Task 2.
- `contributionNote` guarded + `buildRecommendation` over `ProjectedSearchResult` → Task 3.
- Palette-local verified `patternType` filter (NOT shared `filterEntries`) + `patternType: string | null` + styleTags/categories guards → Task 4.
- Wiring `(core, enrichment)` for all three tools + compare cells (`—`, no `"web"` default for unverified platform, per-column disclosure) → Task 5.
- Palette renderer (nullable label + disclosure + filter-aware empty message) → Task 6.
- Recommend + `generate_design_prompt` handlers project entries; recommend tested via stubbed `searchRanked` + `hasIndex: true` → Task 7.
- Sweep: partial-serves with disclosure, no sentinel leak, byte-identical fully-verified pin; old full-AND test removed → Task 8.
- Spec status flip → Task 9.

**Placeholder scan:** no TBD/TODO; every code step carries complete code; every test names exact commands and expected results.

**Type consistency:** `ProjectedEntry` defined once in Task 1 and consumed in Tasks 2-7; `projectEntryForSynthesis(entry, enrichment): ProjectedEntry`; `renderCoverageDisclosure({ used, total, dropped })`; `ProjectedSearchResult` in Task 3; `collectPalettes(entries: ProjectedEntry[], opts, limit): PaletteResult[]` with `patternType: string | null`; constants `*_CORE`/`*_ENRICHMENT` exported in Task 1 and referenced in Tasks 5-7. `projectForServing` (2d-1) reused for per-entry omitted lists.

**Edge cases covered:** empty projection (only core), fully-unverified enrichment (fallbacks + K=0-of-N), platform `—` vs verified-absent `"web"`, palette filter with zero verified matches (filter-aware message), shared `filterEntries` behavior preserved for non-rendering tools, fully-verified byte-identical output (palette + compare + recommend), compare concise-mode projection, legacy `DesignBrief` key-set test updated for `coverage`.
