# Field-set gating 2d-1 — core + enrichment for the render tools — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `TrustGatedCorpusReader`'s single hard-gated field set into core (hard-gated) + enrichment (render-if-verified, omitted+disclosed) for exactly three tools — `get_ui_example`, `search_ui_examples`, `get_similar_ui_examples` — so an entry with a verified `critique` serves immediately with whatever else is verified, while all other tools stay byte-for-byte at full-AND.

**Architecture:** The reader takes `(inner, core[], enrichment[])`, gates inclusion on `core` only, and exposes `core`/`enrichment` accessors. A pure shared helper `projectForServing(entry, enrichment)` computes served/omitted enrichment keys; the three split tools' renderers route every emitted field through it and append a per-entry disclosure naming omitted fields. The synthesis tools (`recommend_ui_direction`, `compare_ui_examples`, `get_color_palette`) are constructed `(fullSet, [])` — byte-identical to today — and deferred to 2d-2. A cross-tool invariant sweep asserts no tool ever emits an unverified field value.

**Tech Stack:** TypeScript (Node ESM, `"type": "module"`), Zod, vitest, the MCP SDK. Tests are vitest suites under `src/`; the full command is `npm test` (`vitest run`).

## Global Constraints

- **Invariant (spec, verbatim):** "A tool never emits a field value that is not `isVerified` for that entry. An entry appears in a tool only when ALL of that tool's **core** fields are verified. A dropped enrichment field is disclosed as unverified — never silently absent, never a stale value."
- **By construction at the reader, net-enforced at the renderer:** reader gates on `core`; every render path routes through `projectForServing`; the cross-tool sweep is the backstop.
- **2d-1 splits exactly three tools** (`get_ui_example`, `search_ui_examples`, `get_similar_ui_examples`). All other tools keep today's full-AND behavior: single-field tools become `(field, [])`, `critique_ui` becomes `(["patternType", "platform"], [])`, and the three synthesis tools become `(fullCurrentSet, [])`.
- **No change to which fields a tool renders** — only the existing gated set is split.
- **Omit, never null:** an omitted enrichment field is ABSENT from the response; the disclosure is the sole "exists but unverified" signal.
- **Nested keys are independent verification keys:** `antiPatterns` unverified → whole object omitted (even if `antiPatterns.accessibilityRisks` verifies); `antiPatterns` verified + leaf unverified → serve with the a11y section stripped, disclose the leaf; `visual.*` leaves project independently.
- **Disclosure is per entry** (never aggregate counts), listing omitted field keys, at most 12 names (size of the largest enrichment set).
- **Tests use injected readers + in-memory fixtures only** — no test reads or writes the real `corpus/entries.json`.
- **Every task ends with its tests green and a commit.** TypeScript must compile (`npx tsc --noEmit`) after Task 3 and at the end.
- **Renderer output is field-identical but not byte-identical to today:** the new renderers fold multi-line sections into single joined strings and drop the old trailing blank line. No test depends on exact bytes (contract tests use `toContain`), so do not expect a clean whitespace diff.

---

### Task 1: Two-set `TrustGatedCorpusReader`

**Files:**
- Modify: `src/corpus-trust-reader.ts:34-62`
- Test: `src/corpus-trust-reader.test.ts`

**Interfaces:**
- Consumes: `isVerified(entry, field)` from `src/corpus-trust.ts` (unchanged); `CorpusReader`, `CorpusEntryT`.
- Produces: `new TrustGatedCorpusReader(inner: CorpusReader, core: readonly string[], enrichment?: readonly string[])`; read-only accessors `core: readonly string[]` and `enrichment: readonly string[]`; `passes(entry)` now evaluates `core` only. Later tasks consume the accessors (messages, image-attach) and pass two field sets at every wiring site.

- [ ] **Step 1: Write the failing tests**

Append to `src/corpus-trust-reader.test.ts` (after the existing `describe("TrustGatedCorpusReader — per-field field sets")` block):

```ts
describe("TrustGatedCorpusReader — core/enrichment split (2d-1)", () => {
  function mixedEntry(id: string, verifiedFor: readonly string[]): CorpusEntryT {
    const verification: Record<string, unknown> = {};
    for (const field of verifiedFor) {
      verification[field] = { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" };
    }
    return {
      id,
      source: { productName: `product-${id}` },
      whatToSteal: [`${id} technique`],
      critique: `${id} critique`,
      provenance: { taggedBy: "auto", verification },
    } as unknown as CorpusEntryT;
  }

  function readerOf(entries: CorpusEntryT[]): CorpusReader {
    return {
      search: async () => entries,
      searchRanked: async () => entries.map((e, i) => ({ entry: e, score: 5 - i, searchMode: "keyword" as const })),
      getById: (id: string) => entries.find((e) => e.id === id),
      findSimilar: () => entries.map((e) => ({ entry: e, score: 1 })),
      listCategories: () => ["dashboard"],
      listStyleTags: () => ["minimal"],
      listDomainTags: () => ["analytics"],
      indexStatus: () => ({ indexed: 0, total: entries.length, hasIndex: false, missing: 0, stale: 0, contentStale: 0 }),
      entriesForAggregation: () => entries,
      resolveImagePath: () => null,
    } as unknown as CorpusReader;
  }

  it("includes an entry whose core verifies even when enrichment does not", async () => {
    const partial = mixedEntry("partial-1", ["critique"]);
    const r = new TrustGatedCorpusReader(readerOf([partial]), ["critique"], ["whatToSteal", "voice"]);
    expect((await r.search({} as never)).map((e) => e.id)).toEqual(["partial-1"]);
    expect(r.getById("partial-1")?.id).toBe("partial-1");
  });

  it("excludes an entry whose core does not verify, even when enrichment does", async () => {
    const dark = mixedEntry("dark-1", ["whatToSteal"]);
    const r = new TrustGatedCorpusReader(readerOf([dark]), ["critique"], ["whatToSteal"]);
    expect(await r.search({} as never)).toEqual([]);
    expect(r.getById("dark-1")).toBeUndefined();
    expect(r.refusedForTrust("dark-1")).toBe(true);
  });

  it("exposes core and enrichment as read-only accessors", () => {
    const r = new TrustGatedCorpusReader(readerOf([]), ["critique"], ["whatToSteal", "voice"]);
    expect(r.core).toEqual(["critique"]);
    expect(r.enrichment).toEqual(["whatToSteal", "voice"]);
  });

  it("refuses an empty CORE set at construction", () => {
    expect(() => new TrustGatedCorpusReader(readerOf([]), [], ["whatToSteal"])).toThrow(/at least one core field/i);
  });

  it("behaves byte-for-byte as the old full-AND when constructed (fullSet, [])", async () => {
    const partial = mixedEntry("partial-1", ["critique", "whatToSteal"]);
    const full = mixedEntry("full-1", ["critique", "whatToSteal", "voice"]);
    const r = new TrustGatedCorpusReader(readerOf([partial, full]), ["critique", "whatToSteal", "voice"]);
    expect((await r.search({} as never)).map((e) => e.id)).toEqual(["full-1"]);
    expect(r.trustPosture()).toEqual({ verified: 1, total: 2 });
    expect(r.refusedForTrust("partial-1")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/corpus-trust-reader.test.ts`
Expected: FAIL — "Expected 1 arguments, but got 2" / "core is not defined" (constructor does not accept two field sets yet).

- [ ] **Step 3: Implement the two-set constructor**

In `src/corpus-trust-reader.ts`, replace the constructor, the `fields` field, and `passes` (lines ~34-62 — the gated methods below, starting at `async search`, stay untouched) with:

```ts
export class TrustGatedCorpusReader implements CorpusReader {
  private readonly _core: readonly string[];
  private readonly _enrichment: readonly string[];

  constructor(
    private readonly inner: CorpusReader,
    /** The exact keys of the fields this tool hard-gates on (wiring-time declaration). */
    core: readonly string[],
    /** The exact keys of the fields this tool renders only when verified; omitted+disclosed otherwise. */
    enrichment: readonly string[] = [],
  ) {
    // Double-wrapping would make `trustPosture()` report verified === total (the
    // inner gate already filtered), so every honest "0 of 787" message would
    // silently revert to "No X found for those filters". Refuse it outright rather
    // than degrade quietly.
    if (inner instanceof TrustGatedCorpusReader) {
      throw new Error(
        "TrustGatedCorpusReader is already gating this reader; double-wrapping "
        + "would make trustPosture() report everything as verified.",
      );
    }
    // An empty core would make `core.every(...)` vacuously true and un-gate
    // the whole corpus — the exact failure this class exists to prevent.
    if (core.length === 0) {
      throw new Error(
        "TrustGatedCorpusReader requires at least one core field; an empty core "
        + "set would let every entry pass (every() over [] is true).",
      );
    }
    this._core = core;
    this._enrichment = enrichment;
  }

  /** The fields an entry must verify to appear in the tool at all. */
  get core(): readonly string[] {
    return this._core;
  }

  /** The fields rendered only when verified for the entry; omitted+disclosed otherwise. */
  get enrichment(): readonly string[] {
    return this._enrichment;
  }

  private passes(entry: CorpusEntryT): boolean {
    return this._core.every((field) => isVerified(entry, field));
  }
```

Also update the class doc comment's field-set sentence to say "the CORE fields the tool hard-gates on (enrichment is projected at the render boundary)".

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/corpus-trust-reader.test.ts`
Expected: PASS (all pre-existing tests still pass — a single-arg constructor call means `enrichment` defaults to `[]` — plus the five new tests).

- [ ] **Step 5: Commit**

```bash
git add src/corpus-trust-reader.ts src/corpus-trust-reader.test.ts
git commit -m "feat(trust): two-set TrustGatedCorpusReader — core gates, enrichment deferred to renderer"
```

---

### Task 2: `projectForServing` + disclosure helper

**Files:**
- Create: `src/serving-projection.ts`
- Test: `src/serving-projection.test.ts`

**Interfaces:**
- Consumes: `isVerified(entry, field)` from `src/corpus-trust.ts`, `CorpusEntryT` from `src/schema.js`.
- Produces: `projectForServing(entry: CorpusEntryT, enrichment: readonly string[]): ServingProjection` where `ServingProjection = { served: readonly string[]; omitted: readonly string[] }`; `renderOmittedDisclosure(omitted: readonly string[]): string` ("" when nothing omitted, else a markdown note naming the omitted keys). Tasks 4-6 consume both.

- [ ] **Step 1: Write the failing tests**

Create `src/serving-projection.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { projectForServing, renderOmittedDisclosure } from "./serving-projection.js";
import type { CorpusEntryT } from "./schema.js";

const RECORD = { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" };

function entryWith(verifiedFor: readonly string[]): CorpusEntryT {
  const verification: Record<string, unknown> = {};
  for (const field of verifiedFor) verification[field] = RECORD;
  return {
    id: "e1",
    source: { productName: "P" },
    whatToSteal: ["steal"],
    antiPatterns: { antiPatterns: ["anti"], accessibilityRisks: [] },
    visual: { typePairing: { display: "Inter", body: "Inter" } },
    provenance: { taggedBy: "auto", verification },
  } as unknown as CorpusEntryT;
}

describe("projectForServing", () => {
  it("keeps verified enrichment, lists the rest, and touches nothing else", () => {
    const entry = entryWith(["whatToSteal", "voice"]);
    const p = projectForServing(entry, ["whatToSteal", "voice", "antiPatterns", "visual.colorRoles"]);
    expect(p.served).toEqual(["whatToSteal", "voice"]);
    expect(p.omitted).toEqual(["antiPatterns", "visual.colorRoles"]);
  });

  it("exercises a real split — at least two verified and two unverified", () => {
    const entry = entryWith(["whatToSteal", "antiPatterns"]);
    const p = projectForServing(entry, [
      "whatToSteal", "antiPatterns", "voice", "visual.dominantColors",
    ]);
    expect(p.served).toEqual(["whatToSteal", "antiPatterns"]);
    expect(p.omitted).toEqual(["voice", "visual.dominantColors"]);
  });

  it("projects nested keys per leaf — parent verified, leaf unverified strips the leaf", () => {
    const entry = entryWith(["antiPatterns"]);
    const p = projectForServing(entry, ["antiPatterns", "antiPatterns.accessibilityRisks"]);
    expect(p.served).toEqual(["antiPatterns"]);
    expect(p.omitted).toEqual(["antiPatterns.accessibilityRisks"]);
  });

  it("projects nested keys per leaf — parent unverified drops the child even when the leaf verifies", () => {
    const entry = entryWith(["antiPatterns.accessibilityRisks"]);
    const p = projectForServing(entry, ["antiPatterns", "antiPatterns.accessibilityRisks"]);
    expect(p.served).toEqual(["antiPatterns.accessibilityRisks"]);
    expect(p.omitted).toEqual(["antiPatterns"]);
  });

  it("returns empty lists for a fully verified entry", () => {
    const p = projectForServing(entryWith(["a", "b"]), ["a", "b"]);
    expect(p.served).toEqual(["a", "b"]);
    expect(p.omitted).toEqual([]);
  });

  it("returns empty lists when enrichment is empty", () => {
    const p = projectForServing(entryWith([]), []);
    expect(p.served).toEqual([]);
    expect(p.omitted).toEqual([]);
  });
});

describe("renderOmittedDisclosure", () => {
  it("renders nothing for an empty omitted list", () => {
    expect(renderOmittedDisclosure([])).toBe("");
  });

  it("names the omitted fields for a non-empty list", () => {
    const disclosure = renderOmittedDisclosure(["whatToSteal", "antiPatterns.accessibilityRisks"]);
    expect(disclosure).toContain("Unverified fields omitted");
    expect(disclosure).toContain("whatToSteal");
    expect(disclosure).toContain("antiPatterns.accessibilityRisks");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/serving-projection.test.ts`
Expected: FAIL — cannot resolve `./serving-projection.js`.

- [ ] **Step 3: Implement the helper**

Create `src/serving-projection.ts`:

```ts
/**
 * serving-projection.ts — the SINGLE place enrichment is dropped before serving.
 *
 * 2d-1 invariant, renderer half: a tool emits an enrichment field only when
 * `isVerified` for that entry; anything else is omitted and named in the
 * per-entry disclosure. Projection is per field KEY (nested keys like
 * `antiPatterns` and `antiPatterns.accessibilityRisks` are independent
 * verification keys), so the renderer can strip a leaf without dropping its
 * parent, and vice versa.
 */
import type { CorpusEntryT } from "./schema.js";
import { isVerified } from "./corpus-trust.js";

export interface ServingProjection {
  /** Enrichment keys verified for the entry — safe to render. */
  readonly served: readonly string[];
  /** Enrichment keys NOT verified — must be omitted from the response and disclosed. */
  readonly omitted: readonly string[];
}

export function projectForServing(
  entry: CorpusEntryT,
  enrichment: readonly string[],
): ServingProjection {
  const served: string[] = [];
  const omitted: string[] = [];
  for (const field of enrichment) {
    (isVerified(entry, field) ? served : omitted).push(field);
  }
  return { served, omitted };
}

/**
 * The per-entry disclosure: names the omitted-because-unverified fields. Empty
 * string when nothing was omitted (a fully verified entry discloses nothing).
 * Omitted fields are ABSENT from the response body; this note is the sole
 * "exists but unverified" signal.
 */
export function renderOmittedDisclosure(omitted: readonly string[]): string {
  if (omitted.length === 0) return "";
  return `\n\n_Unverified fields omitted: ${omitted.join(", ")}._`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/serving-projection.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Commit**

```bash
git add src/serving-projection.ts src/serving-projection.test.ts
git commit -m "feat(trust): projectForServing + per-entry disclosure helper (2d-1)"
```

---

### Task 3: Server wiring — two-set constructor, four consumers, message rewording

**Files:**
- Modify: `src/server-factory.ts:90-146` (registration block), `:160-170` (`emptyCorpusMessage`), `:184-201` (`unresolvedIdsMessage`), `:210-222` (`corpusEvidenceNote`), `:384-395` (image-attach), plus new field-set constants near the top.
- Test: `src/tool-trust-gate.test.ts:238-242` (message regex).

**Interfaces:**
- Consumes: `TrustGatedCorpusReader(inner, core, enrichment)` and its `core`/`enrichment` accessors (Task 1).
- Produces: the full 13-tool wiring in `createServer` with 2d-1's mapping; the four old `gate.fields` consumers rewritten. Tasks 4-6 use the new enrichment constants in renderers.

- [ ] **Step 1: Write the failing test update**

In `src/tool-trust-gate.test.ts`, update the refusal-message assertion (~line 240) to the new wording:

```ts
    expect(one).toMatch(/Entry "gate-tool-entry" exists but is not verified for every core field this tool serves/);
    // The message names the CORE set only — enrichment no longer withholds, so
    // the old /visual\.colorRoles/ assertion (a now-enrichment field) is dropped.
    expect(one).toMatch(/critique/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/tool-trust-gate.test.ts`
Expected: FAIL on the message regex (and the suite may not compile until Step 3 lands).

- [ ] **Step 3: Add the field-set constants and rewire `createServer`**

In `src/server-factory.ts`, above `createServer`, add:

```ts
// ----- 2d-1 field sets: core (hard-gated) + enrichment (render-if-verified) --
// The SAME constants feed the reader wiring AND the renderers' projection, so
// a tool's declared set can never drift from what its render path projects.
const SEARCH_UI_EXAMPLES_CORE = ["critique"] as const;
const SEARCH_UI_EXAMPLES_ENRICHMENT = ["whatToSteal", "antiPatterns", "categories", "styleTags"] as const;
const GET_UI_EXAMPLE_CORE = ["critique"] as const;
const GET_UI_EXAMPLE_ENRICHMENT = [
  "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks", "voice",
  "visual.dominantColors", "visual.accentColor", "visual.colorRoles",
  "visual.typePairing", "visual.spacingDensity", "visual.cornerStyle",
  "visual.usesShadows", "visual.usesBorders",
] as const;
const GET_SIMILAR_UI_EXAMPLES_CORE = ["critique"] as const;
const GET_SIMILAR_UI_EXAMPLES_ENRICHMENT = ["whatToSteal", "categories", "styleTags", "patternType"] as const;
// Deferred to 2d-2: constructed (fullCurrentSet, []) — byte-for-byte full-AND.
const COMPARE_UI_EXAMPLES_FULL_SET = [
  "critique", "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks",
  "categories", "styleTags", "patternType", "platform", "layout",
  "visual.accentColor", "visual.colorRoles", "visual.spacingDensity",
  "visual.cornerStyle", "visual.usesShadows", "visual.usesBorders",
] as const;
const RECOMMEND_UI_DIRECTION_FULL_SET = [
  "whatToSteal", "antiPatterns", "voice", "visual.colorRoles", "visual.typePairing",
  "visual.spacingDensity", "visual.cornerStyle", "layout", "patternType", "styleTags",
] as const;
```

Replace the registration block (`createServer`, lines ~97-148) with:

```ts
  // `create_ui_spec` keeps the UNGATED reader on purpose: it gates itself
  // (create-ui-spec-deterministic.ts) AND needs the corpus-wide entry list to
  // build the identity screen's denied-name set.
  registerSearchUiExamples(
    server,
    new TrustGatedCorpusReader(reader, SEARCH_UI_EXAMPLES_CORE, SEARCH_UI_EXAMPLES_ENRICHMENT),
  );
  registerGetUiExample(
    server,
    new TrustGatedCorpusReader(reader, GET_UI_EXAMPLE_CORE, GET_UI_EXAMPLE_ENRICHMENT),
  );
  registerListCategories(server, new TrustGatedCorpusReader(reader, ["categories"]));
  registerListStyleTags(server, new TrustGatedCorpusReader(reader, ["styleTags"]));
  registerListDomainTags(server, new TrustGatedCorpusReader(reader, ["domainTags"]));
  registerGetSimilarUiExamples(
    server,
    new TrustGatedCorpusReader(reader, GET_SIMILAR_UI_EXAMPLES_CORE, GET_SIMILAR_UI_EXAMPLES_ENRICHMENT),
  );
  registerCompareUiExamples(
    server,
    new TrustGatedCorpusReader(reader, COMPARE_UI_EXAMPLES_FULL_SET),
  );
  registerCreateUiSpec(server, reader, options.createUiSpecModel);
  registerRecommendUiDirection(
    server,
    new TrustGatedCorpusReader(reader, RECOMMEND_UI_DIRECTION_FULL_SET),
  );
  registerGetAntiPatterns(server, new TrustGatedCorpusReader(reader, ["antiPatterns"]));
  registerGetColorPalette(server, new TrustGatedCorpusReader(reader, ["visual.colorRoles", "patternType"]));
  registerGetStealableTechniques(server, new TrustGatedCorpusReader(reader, ["whatToSteal"]));
  registerBrowseUiExamples(server, new TrustGatedCorpusReader(reader, ["patternType"]));
  registerCritiqueUi(server, new TrustGatedCorpusReader(reader, ["patternType", "platform"]));
```

- [ ] **Step 4: Rewrite the four `gate.fields` consumers**

`emptyCorpusMessage` — replace the message assembly:

```ts
  if (gate !== null && posture !== null && posture.verified < posture.total) {
    return (
      `No ${noun} available: ${posture.verified} of ${posture.total} corpus entries are verified `
      + `for every core field this tool serves (${gate.core.join(", ")}), and corpus content is `
      + `served only from verified entries. This is not a filter problem — broadening the query `
      + `will not change it.`
    );
  }
```

`unresolvedIdsMessage` — replace the refused part:

```ts
    parts.push(
      `${one ? "Entry" : "Entries"} ${refused.map((i) => `"${i}"`).join(", ")} `
      + `${one ? "exists" : "exist"} but ${one ? "is" : "are"} not verified for every core field this `
      + `tool serves (${gate.core.join(", ")}), and corpus content is served only from verified `
      + `entries (${posture.verified} of ${posture.total} verified).`,
    );
```

`corpusEvidenceNote` — replace the message assembly:

```ts
  return (
    `\n\n---\n_No corpus evidence backs this critique: ${posture.verified} of ${posture.total} `
    + `corpus entries are verified for every core field this tool serves (${gate!.core.join(", ")}) — `
    + `corpus content is served only from verified entries. Every finding above is grounded in the `
    + `uploaded screenshot alone._`
  );
```

The image-attach condition in `registerGetUiExample` — replace `gate.fields.includes(field)`:

```ts
          const gate = reader instanceof TrustGatedCorpusReader ? reader : null;
          const imageAttach = gate !== null && [...verifiedFields(entry)].some(
            (field) => (gate.core.includes(field) || gate.enrichment.includes(field))
              && entry.provenance?.verification?.[field]?.method === "image-confirmed"
              && entry.provenance.verification[field].imageSha256 === sha,
          );
```

`verifiedFields` is already imported at the top of `server-factory.ts` (used by the current image-attach block) — confirm the import remains.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/tool-trust-gate.test.ts src/corpus-trust-reader.test.ts src/public-mcp-contract.test.ts`
Expected: PASS. Then run `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/server-factory.ts src/tool-trust-gate.test.ts
git commit -m "feat(trust): wire two-set gate — 3 tools split, synthesis tools held at full-AND; update message + image-attach consumers"
```

---

### Task 4: `get_ui_example` renderer — projection + disclosure

**Files:**
- Modify: `src/server-factory.ts:330-430` (`registerGetUiExample` handler body)
- Test: `src/field-set-serving.test.ts` (create)

**Interfaces:**
- Consumes: `projectForServing(entry, GET_UI_EXAMPLE_ENRICHMENT)` and `renderOmittedDisclosure(omitted)` (Task 2); `GET_UI_EXAMPLE_ENRICHMENT` (Task 3).
- Produces: a single-entry markdown render where every enrichment section is conditioned on the projection; the disclosure appended to the text detail.

- [ ] **Step 1: Write the failing test**

Create `src/field-set-serving.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server-factory.js";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";

const RECORD = { method: "image-confirmed", verifiedAt: "2026-08-05", verifierVersion: "fixture", imageSha256: "a".repeat(64) };

function verificationFor(fields: readonly string[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const field of fields) map[field] = RECORD;
  return map;
}

function entry(id: string, verifiedFor: readonly string[]): CorpusEntryT {
  return {
    id,
    title: `${id} title`,
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    source: { productName: "GateCo", url: "https://gateco.example.com", capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "images-private/gate.png", width: 1440, height: 900 },
    visual: {
      dominantColors: ["#ffffff", "#111111"],
      accentColor: "#2563eb",
      colorRoles: { canvas: "#ffffff", surface: "#f8fafc", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
      typePairing: { display: "Inter", body: "Inter" },
      spacingDensity: "moderate", cornerStyle: "slight-round",
      usesShadows: false, usesBorders: true,
    },
    // No "dashboard" in the prose: Task 6 asserts the unverified patternType/
    // categories value never renders, and the critique is core (always served),
    // so the fixture prose must not carry the same string.
    critique: "CRITIQUE_MARKER_9f — a restrained layout that stays readable.",
    whatToSteal: ["STEAL_MARKER_9f — group the metric tiles on one baseline."],
    antiPatterns: { antiPatterns: ["ANTI_MARKER_9f — avoid stacking two shadow depths."], whereThisFails: [], accessibilityRisks: [] },
    voice: { tone: "VOICE_MARKER_9f — restrained", examples: ["Example copy"], avoid: [] },
    qualityTier: "exceptional", qualityScore: 4, reviewStatus: "approved", addedAt: "2026-07-01",
    provenance: { taggedBy: "auto", verification: verificationFor(verifiedFor) },
  } as unknown as CorpusEntryT;
}

function readerWith(e: CorpusEntryT): CorpusReader {
  return {
    search: async () => [e],
    searchRanked: async () => [{ entry: e, score: 5, searchMode: "keyword" as const }],
    getById: (id: string) => (id === e.id ? e : undefined),
    findSimilar: () => [{ entry: e, score: 1 }],
    listCategories: () => ["dashboard"],
    listStyleTags: () => ["minimal"],
    listDomainTags: () => ["analytics"],
    indexStatus: () => ({ indexed: 0, total: 1, hasIndex: false, missing: 1, stale: 0, contentStale: 0 }),
    entriesForAggregation: () => [e],
    resolveImagePath: () => null,
    getImageIndex: async () => null,
  } as unknown as CorpusReader;
}

async function callTool(name: string, args: Record<string, unknown>, e: CorpusEntryT): Promise<string> {
  const server = createServer(readerWith(e));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "field-set-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    return content.map((c) => c.text ?? "").join("\n");
  } finally {
    await client.close();
  }
}

describe("get_ui_example — core + enrichment serving (2d-1)", () => {
  it("serves core + verified enrichment, omits unverified enrichment, and discloses it", async () => {
    const e = entry("gate-tool-entry", ["critique", "whatToSteal", "visual.colorRoles"]);
    const text = await callTool("get_ui_example", { id: "gate-tool-entry" }, e);
    expect(text).toContain("CRITIQUE_MARKER_9f");                 // core, always
    expect(text).toContain("STEAL_MARKER_9f");                    // verified enrichment
    expect(text).toContain("Color roles");                        // verified enrichment section
    expect(text).not.toContain("ANTI_MARKER_9f");                 // unverified enrichment — absent
    expect(text).not.toContain("VOICE_MARKER_9f");                // unverified enrichment — absent
    expect(text).not.toContain("Spacing density");                // unverified visual leaf — section absent
    expect(text).not.toContain("Corners");                        // unverified visual leaf — section absent
    expect(text).toContain("Unverified fields omitted");
    expect(text).toContain("antiPatterns");
  });

  it("excludes an entry whose core (critique) is unverified", async () => {
    const e = entry("gate-tool-entry", ["whatToSteal"]);
    const text = await callTool("get_ui_example", { id: "gate-tool-entry" }, e);
    expect(text).toMatch(/verif/i);
    expect(text).not.toContain("CRITIQUE_MARKER_9f");
  });
});

describe("get_ui_example — image attaches on any served field (2d-1)", () => {
  function publicImageEntry(id: string, verification: Record<string, unknown>): CorpusEntryT {
    return {
      ...entry(id, []),
      image: { visibility: "public", path: "images-public/gate.png", width: 1440, height: 900 },
      provenance: { taggedBy: "auto", verification },
    } as unknown as CorpusEntryT;
  }

  async function callWithFile(e: CorpusEntryT, file: string): Promise<string> {
    const server = createServer({ ...readerWith(e), resolveImagePath: () => file } as CorpusReader);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "field-set-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = await client.callTool({ name: "get_ui_example", arguments: { id: "gate-tool-entry" } });
      const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
      return content.map((c) => c.text ?? "").join("\n");
    } finally {
      await client.close();
    }
  }

  it("attaches when the only image-confirmed field is a served enrichment field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "image-attach-"));
    const file = join(dir, "gate.png");
    const bytes = Buffer.from("fake-png-bytes");
    writeFileSync(file, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const e = publicImageEntry("gate-tool-entry", {
      critique: RECORD, // image-confirmed with a NON-matching hash — no attach from core
      "visual.colorRoles": { ...RECORD, imageSha256: sha }, // served enrichment — attaches
    });
    const text = await callWithFile(e, file);
    expect(text).not.toContain("Image not attached");
  });

  it("does not attach when the image-confirmed field is outside the tool's served set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "image-noattach-"));
    const file = join(dir, "gate.png");
    const bytes = Buffer.from("fake-png-bytes");
    writeFileSync(file, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const e = publicImageEntry("gate-tool-entry", {
      critique: RECORD, // image-confirmed with a NON-matching hash
      platform: { ...RECORD, imageSha256: sha }, // NOT in get_ui_example's core ∪ enrichment
    });
    const text = await callWithFile(e, file);
    expect(text).toContain("Image not attached");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/field-set-serving.test.ts`
Expected: FAIL — unverified markers ARE present in the current renderer output (it prints every section unconditionally).

- [ ] **Step 3: Implement the projected renderer**

Replace the body of `registerGetUiExample`'s handler after the `entry` lookup (`const detail = [` through the closing `].filter(Boolean).join("\n");`) with:

```ts
      const projection = projectForServing(entry, GET_UI_EXAMPLE_ENRICHMENT);
      const served = (field: string) => projection.served.includes(field);
      const visualLines = (): string[] => {
        const lines: string[] = [];
        if (served("visual.dominantColors")) lines.push(`- Dominant colors: ${entry.visual.dominantColors.join(", ")}`);
        if (served("visual.accentColor")) lines.push(`- Accent: ${entry.visual.accentColor ?? "none identified"}`);
        if (served("visual.colorRoles") && entry.visual.colorRoles) {
          const cr = entry.visual.colorRoles;
          lines.push(`- Color roles (paste-ready token set): canvas ${cr.canvas}, surface ${cr.surface}, ink ${cr.ink}${cr.muted ? `, muted ${cr.muted}` : ""}, accent ${cr.accent}`);
        }
        if (served("visual.typePairing") && entry.visual.typePairing) {
          const tp = entry.visual.typePairing;
          lines.push(`- Type pairing: ${tp.display ?? "?"} / ${tp.body ?? "?"}${tp.notes ? ` — ${tp.notes}` : ""}`);
        }
        if (served("visual.spacingDensity")) lines.push(`- Spacing density: ${entry.visual.spacingDensity}`);
        if (served("visual.cornerStyle")) lines.push(`- Corners: ${entry.visual.cornerStyle}`);
        const shadowBorder = [
          served("visual.usesShadows") ? `Shadows: ${entry.visual.usesShadows ? "yes" : "no"}` : "",
          served("visual.usesBorders") ? `Borders: ${entry.visual.usesBorders ? "yes" : "no"}` : "",
        ].filter(Boolean).join(" | ");
        if (shadowBorder) lines.push(`- ${shadowBorder}`);
        return lines.length ? [`## Visual attributes`, ...lines] : [];
      };

      // Output-shape note: sections are folded into single strings and the old
      // trailing blank line is dropped — field-identical, not byte-identical.
      const detail = [
        `## Critique`,
        entry.critique,
        ``,
        served("whatToSteal")
          ? [`## What to steal`, ...entry.whatToSteal.map((t) => `- ${t}`)].join("\n")
          : "",
        served("antiPatterns") && entry.antiPatterns.antiPatterns.length
          ? `## Anti-patterns (mistakes this design avoids)\n${entry.antiPatterns.antiPatterns.map((t) => `- ${t}`).join("\n")}\n`
          : "",
        served("antiPatterns.accessibilityRisks") && entry.antiPatterns.accessibilityRisks.length
          ? `## Accessibility risks\n${entry.antiPatterns.accessibilityRisks.map((r) => `- ${formatAccessibilityRisk(r, { includeEvidence: true })}`).join("\n")}\n`
          : "",
        served("voice") && entry.voice
          ? `## Voice\n- Tone: ${entry.voice.tone}\n${entry.voice.examples.map((e) => `- Example: "${e}"`).join("\n")}${entry.voice.avoid.length ? `\n${entry.voice.avoid.map((a) => `- Avoid: ${a}`).join("\n")}` : ""}\n`
          : "",
        ...visualLines(),
        renderOmittedDisclosure(projection.omitted),
      ]
        .filter(Boolean)
        .join("\n");
```

Add the two imports to the top of `src/server-factory.ts`:

```ts
import { projectForServing, renderOmittedDisclosure } from "./serving-projection.js";
```

The image-attach block that follows is unchanged (Task 3 already fixed its field-set condition).

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/field-set-serving.test.ts`
Expected: PASS (both `get_ui_example` cases). Also run `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server-factory.ts src/field-set-serving.test.ts
git commit -m "feat(trust): get_ui_example projects enrichment + discloses omitted fields"
```

---

### Task 5: `search_ui_examples` renderer — per-result projection + disclosure

**Files:**
- Modify: `src/server-factory.ts:250-330` (`registerSearchUiExamples` handler)
- Test: `src/field-set-serving.test.ts` (append)

**Interfaces:**
- Consumes: `projectForServing(entry, SEARCH_UI_EXAMPLES_ENRICHMENT)` and `renderOmittedDisclosure` (Task 2); the constant from Task 3.
- Produces: per-result markdown where headers, steal items and anti-patterns render only when verified, and each result carries its OWN omitted list (not an aggregate).

- [ ] **Step 1: Write the failing test**

Append to `src/field-set-serving.test.ts`:

```ts
describe("search_ui_examples — per-result projection (2d-1)", () => {
  it("attributes each result's omitted fields to the right result", async () => {
    const rich = entry("rich-1", ["critique", "whatToSteal"]);
    const thin = entry("thin-1", ["critique"]);
    const server = createServer({
      ...readerWith(rich),
      search: async () => [rich, thin],
    } as CorpusReader);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "field-set-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = await client.callTool({ name: "search_ui_examples", arguments: { query: "dashboard", limit: 3 } });
      const text = (res.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("\n");
      // rich-1: whatToSteal verified → steal marker present, only anti/categories/styleTags omitted.
      const richBlock = text.split("---")[0];
      expect(richBlock).toContain("STEAL_MARKER_9f");
      expect(richBlock).toContain("Unverified fields omitted: antiPatterns, categories, styleTags.");
      // thin-1: only critique verified → steal marker absent, disclosure names it.
      const thinBlock = text.split("---")[1] ?? text;
      expect(thinBlock).not.toContain("STEAL_MARKER_9f");
      expect(thinBlock).toContain("Unverified fields omitted: whatToSteal, antiPatterns, categories, styleTags.");
    } finally {
      await client.close();
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/field-set-serving.test.ts`
Expected: FAIL — current renderer prints `whatToSteal`/`antiPatterns`/header labels unconditionally and has no disclosure.

- [ ] **Step 3: Implement the projected renderer**

Replace the `summary` map block in `registerSearchUiExamples`' handler:

```ts
      const summary = results
        .map((e) => {
          const projection = projectForServing(e, SEARCH_UI_EXAMPLES_ENRICHMENT);
          const served = (field: string) => projection.served.includes(field);
          const headerParts = [
            served("categories") ? e.categories.join(", ") : "",
            served("styleTags") ? e.styleTags.join(", ") : "",
          ].filter(Boolean).join(" | ");
          const lines: string[] = [];
          if (headerParts) lines.push(`### ${headerParts}`);
          if (concise) {
            lines.push(`Critique: ${e.critique.slice(0, 120)}${e.critique.length > 120 ? "…" : ""}`);
          } else {
            lines.push(
              `Critique: ${e.critique}`,
              ``,
              served("whatToSteal")
                ? ["What to steal:", ...e.whatToSteal.map((t) => `  - ${t}`)].join("\n")
                : "",
              served("antiPatterns") && e.antiPatterns.antiPatterns.length
                ? `Anti-patterns (mistakes avoided):\n${e.antiPatterns.antiPatterns.map((t) => `  - ${t}`).join("\n")}`
                : "",
            );
          }
          lines.push(renderOmittedDisclosure(projection.omitted));
          return lines.filter(Boolean).join("\n");
        })
        .join("\n\n---\n\n");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/field-set-serving.test.ts`
Expected: PASS (3 tests). Then `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server-factory.ts src/field-set-serving.test.ts
git commit -m "feat(trust): search_ui_examples projects per-result enrichment + per-result disclosure"
```

---

### Task 6: `get_similar_ui_examples` renderer — source + result projection

**Files:**
- Modify: `src/server-factory.ts:440-520` (`registerGetSimilarUiExamples` handler)
- Test: `src/field-set-serving.test.ts` (append)

**Interfaces:**
- Consumes: `projectForServing` and `renderOmittedDisclosure` (Task 2); `GET_SIMILAR_UI_EXAMPLES_ENRICHMENT` (Task 3).
- Produces: a projected source header and per-result headers/sections, each with its own disclosure.

- [ ] **Step 1: Write the failing test**

Append to `src/field-set-serving.test.ts`:

```ts
describe("get_similar_ui_examples — source + result projection (2d-1)", () => {
  it("projects the source header and each result, disclosing omissions per result", async () => {
    const e = entry("gate-tool-entry", ["critique", "whatToSteal"]);
    const server = createServer(readerWith(e));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "field-set-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = await client.callTool({ name: "get_similar_ui_examples", arguments: { id: "gate-tool-entry", limit: 5 } });
      const text = (res.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("\n");
      expect(text).toContain("CRITIQUE_MARKER_9f");
      expect(text).toContain("STEAL_MARKER_9f");
      // patternType/categories/styleTags unverified → header must be the fallback label.
      expect(text).toContain("### corpus example — ");
      expect(text).not.toContain("dashboard"); // the unverified patternType/category value
      expect(text).toContain("Unverified fields omitted: categories, styleTags, patternType.");
    } finally {
      await client.close();
    }
  });
});
```

Note: with `patternType` unverified, the result header is `### corpus example — N% similar`. The "dashboard" value (patternType/categories) must not appear anywhere — the fixture critique deliberately contains no "dashboard" (see the Task 4 `entry()` helper comment), and `title`/`product` are not rendered by this tool, so patternType/categories are the only possible sources.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/field-set-serving.test.ts`
Expected: FAIL — current renderer prints `dashboard` in headers and `whatToSteal` unconditionally.

- [ ] **Step 3: Implement the projected renderer**

Replace the `sourceHeader`/`summary` block in `registerGetSimilarUiExamples`' handler:

```ts
      const sourceProjection = projectForServing(source, GET_SIMILAR_UI_EXAMPLES_ENRICHMENT);
      const sourceServed = (field: string) => sourceProjection.served.includes(field);
      const sourceHeader = [
        sourceServed("patternType") ? source.patternType : "",
        sourceServed("categories") ? source.categories.join(", ") : "",
        sourceServed("styleTags") ? source.styleTags.join(", ") : "",
      ].filter(Boolean).join(" | ");
      const summary = [
        `Entries similar to **${sourceHeader || "corpus example"}**, ranked by semantic similarity:`,
        ``,
        ...results.map((r) => {
          const pct = Math.round(Math.max(0, r.score) * 100);
          const projection = projectForServing(r.entry, GET_SIMILAR_UI_EXAMPLES_ENRICHMENT);
          const served = (field: string) => projection.served.includes(field);
          const header = [
            served("patternType") ? r.entry.patternType : "",
            served("categories") ? r.entry.categories.join(", ") : "",
            served("styleTags") ? r.entry.styleTags.join(", ") : "",
          ].filter(Boolean).join(" | ");
          return [
            `### ${header || "corpus example"} — ${pct}% similar`,
            `Critique: ${r.entry.critique}`,
            served("whatToSteal")
              ? ["What to steal:", ...r.entry.whatToSteal.map((t) => `  - ${t}`)].join("\n")
              : "",
            renderOmittedDisclosure(projection.omitted),
          ].join("\n");
        }),
      ].join("\n\n---\n\n");
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/field-set-serving.test.ts`
Expected: PASS (4 tests). Then `npx tsc --noEmit` — Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/server-factory.ts src/field-set-serving.test.ts
git commit -m "feat(trust): get_similar_ui_examples projects source + results with per-result disclosure"
```

---

### Task 7: Canonical response schemas — enrichment optional + disclosure field

**Files:**
- Modify: `src/tool-contracts.ts:285-440` (`ReferenceSummary`, `SimilarReference`, `FullReference`)
- Modify: `src/__fixtures__/tool-contract-fixtures.ts` (no changes required — existing fixtures keep all fields, which remain valid under optional)
- Test: `src/tool-contracts.test.ts` (append round-trip cases)

**Scope note — contract hygiene, NOT runtime enforcement for these three tools.** The three split MCP tools return markdown `content: [{type:"text"}]` and never emit structured data through `parseToolResult`; the `*_references` descriptor `dataSchema`s are enforced only where `parseToolResult` runs (the `create_ui_spec` transport + contract tests). This task therefore only keeps the canonical envelope surface able to REPRESENT a projected result — it does not gate the text path. The runtime invariant for the three tools is enforced by the renderer projection (Tasks 4-6) and the cross-tool sweep (Task 8), exactly as Global Constraints state. Do not present this task as the enforcement layer.

**Interfaces:**
- Consumes: the canonical descriptor `dataSchema`s that `parseToolResult`/`ToolResultSchemas` enforce.
- Produces: for the three reference tools, enrichment fields `.optional()` and a `verification: VerificationDisclosure.optional()` block; later consumers (`makeValidSuccess` fixtures, docs) continue to pass unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `src/tool-contracts.test.ts` (after the "valid fixtures" describe.each):

```ts
describe("2d-1 schema round-trip — omitted enrichment validates", () => {
  it("accepts a search reference with omitted enrichment and a verification disclosure", () => {
    const p = cloneToolResult(makeValidSuccess("search_ui_references")) as Record<string, unknown>;
    const data = (p.data as { results: Array<Record<string, unknown>> });
    delete data.results[0].topTechniques;
    delete data.results[0].antiPatterns;
    delete data.results[0].categories;
    delete data.results[0].styleTags;
    data.results[0].verification = { omitted: ["topTechniques", "antiPatterns", "categories", "styleTags"] };
    const r = parseToolResult(p);
    expect(r.ok, r.ok ? "" : JSON.stringify(r.errors)).toBe(true);
  });

  it("accepts a similar reference with omitted enrichment and a verification disclosure", () => {
    const p = cloneToolResult(makeValidSuccess("find_similar_ui_references")) as Record<string, unknown>;
    const data = (p.data as { results: Array<Record<string, unknown>> });
    delete data.results[0].patternType;
    delete data.results[0].categories;
    delete data.results[0].styleTags;
    delete data.results[0].techniques;
    data.results[0].verification = { omitted: ["patternType", "categories", "styleTags", "techniques"] };
    const r = parseToolResult(p);
    expect(r.ok, r.ok ? "" : JSON.stringify(r.errors)).toBe(true);
  });

  it("accepts a full reference with omitted enrichment and a verification disclosure", () => {
    const p = cloneToolResult(makeValidSuccess("get_ui_reference")) as Record<string, unknown>;
    const data = p.data as Record<string, unknown>;
    for (const field of [
      "accentColor", "dominantColors", "colorRoles", "typePairing", "spacingDensity",
      "cornerStyle", "usesShadows", "usesBorders", "techniques", "antiPatterns",
      "accessibility", "voice",
    ]) {
      delete data[field];
    }
    data.verification = { omitted: ["accentColor", "techniques", "antiPatterns", "accessibility", "voice"] };
    const r = parseToolResult(p);
    expect(r.ok, r.ok ? "" : JSON.stringify(r.errors)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tool-contracts.test.ts`
Expected: FAIL on the three new cases (required fields missing / unknown `verification` key under `.strict()`).

- [ ] **Step 3: Make the enrichment fields optional and add the disclosure block**

In `src/tool-contracts.ts`, directly above `const ReferenceSummary`, add:

```ts
/**
 * 2d-1: per-entry disclosure of omitted-because-unverified enrichment fields.
 * Present only when something was omitted; the response body itself never
 * carries an unverified value.
 */
const VerificationDisclosure = z.object({
  omitted: z.array(z.string()),
}).strict();
```

`ReferenceSummary` — make `patternType`, `categories`, `styleTags`, `topTechniques`, `antiPatterns` `.optional()` and add `verification: VerificationDisclosure.optional(),`. `critique` stays REQUIRED (core). The result:

```ts
const ReferenceSummary = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().min(1),
  product: z.string().trim().min(1),
  patternType: z.string().min(1).optional(),
  categories: z.array(z.string()).optional(),
  styleTags: z.array(z.string()).optional(),
  qualityScore: z.number().int(),
  qualityTier: z.string(),
  source: SourceRef,
  critique: z.string(),
  topTechniques: z.array(z.string()).optional(),
  antiPatterns: z.array(z.string()).optional(),
  verification: VerificationDisclosure.optional(),
}).strict();
```

`SimilarReference` — make `patternType`, `categories`, `styleTags`, `techniques` `.optional()`; add `verification: VerificationDisclosure.optional(),`. `critique` stays REQUIRED.

`FullReference` — make `.optional()`: `accentColor`, `dominantColors`, `colorRoles`, `typePairing`, `spacingDensity`, `cornerStyle`, `usesShadows`, `usesBorders`, `techniques`, `antiPatterns`, `accessibility`; add `verification: VerificationDisclosure.optional(),`. `critique` stays REQUIRED. (`voice` is already optional; `patternType`, `categories`, `styleTags`, `platform`, `layout`, `whereThisFails` are NOT in `get_ui_example`'s enrichment set and stay required.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/tool-contracts.test.ts`
Expected: PASS — including the pre-existing "valid fixtures" cases (fixtures still supply every field).

- [ ] **Step 5: Commit**

```bash
git add src/tool-contracts.ts src/tool-contracts.test.ts
git commit -m "feat(trust): reference schemas accept omitted enrichment + verification disclosure (2d-1)"
```

---

### Task 8: Cross-tool invariant sweep

**Files:**
- Create: `src/invariant-sweep.test.ts`

**Interfaces:**
- Consumes: `createServer` (full wiring from Task 3) and the three projected renderers (Tasks 4-6).
- Produces: the fail-closed net — one test that walks every gated tool over a partially-verified corpus and fails if ANY emitted field value is `!isVerified`.

- [ ] **Step 1: Write the failing test**

Create `src/invariant-sweep.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server-factory.js";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";

// Every gated field value carries its own sentinel so the sweep can tell WHICH
// field leaked. Enum/boolean leaves (patternType, categories, styleTags,
// spacingDensity, cornerStyle, usesShadows, usesBorders) cannot carry sentinels
// (schema-enforced enums) — the sweep asserts their SECTIONS are absent instead.
const S = {
  critique: "SENTINEL_CRITIQUE",
  whatToSteal: "SENTINEL_STEAL",
  antiPatterns: "SENTINEL_ANTI",
  antiPatternsAccessibilityRisks: "SENTINEL_A11Y",
  voice: "SENTINEL_VOICE",
  visualDominantColors: "SENTINEL_DOMINANT",
  visualAccentColor: "SENTINEL_ACCENT",
  visualColorRoles: "SENTINEL_ROLES",
  visualTypePairing: "SENTINEL_TYPE",
} as const;

const RECORD = { method: "image-confirmed", verifiedAt: "2026-08-05", verifierVersion: "sweep", imageSha256: "a".repeat(64) };

function entry(verifiedFor: readonly string[]): CorpusEntryT {
  const verification: Record<string, unknown> = {};
  for (const field of verifiedFor) verification[field] = RECORD;
  return {
    id: "sweep-entry",
    title: "SweepCo",
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: ["kpi-card"],
    domainTags: ["analytics"],
    source: { productName: "SweepCo", url: "https://sweep.example.com", capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "images-private/sweep.png", width: 1440, height: 900 },
    visual: {
      dominantColors: [S.visualDominantColors],
      accentColor: S.visualAccentColor,
      colorRoles: { canvas: S.visualColorRoles, surface: S.visualColorRoles, ink: S.visualColorRoles, muted: S.visualColorRoles, accent: S.visualColorRoles },
      typePairing: { display: S.visualTypePairing, body: S.visualTypePairing },
      spacingDensity: "moderate", cornerStyle: "slight-round",
      usesShadows: false, usesBorders: true,
    },
    critique: S.critique,
    whatToSteal: [S.whatToSteal],
    antiPatterns: {
      antiPatterns: [S.antiPatterns],
      whereThisFails: [],
      accessibilityRisks: [{ element: "button", risk: S.antiPatternsAccessibilityRisks, evidence: "measured", wcag: ["1.4.3"] }],
    },
    voice: { tone: S.voice, examples: ["example"], avoid: [] },
    qualityTier: "exceptional", qualityScore: 4, reviewStatus: "approved", addedAt: "2026-07-01",
    provenance: { taggedBy: "auto", verification },
  } as unknown as CorpusEntryT;
}

function readerWith(e: CorpusEntryT): CorpusReader {
  return {
    search: async () => [e],
    searchRanked: async () => [{ entry: e, score: 5, searchMode: "keyword" as const }],
    getById: (id: string) => (id === e.id ? e : undefined),
    findSimilar: () => [{ entry: e, score: 1 }],
    listCategories: () => ["dashboard"],
    listStyleTags: () => ["minimal"],
    listDomainTags: () => ["analytics"],
    indexStatus: () => ({ indexed: 0, total: 1, hasIndex: false, missing: 1, stale: 0, contentStale: 0 }),
    entriesForAggregation: () => [e],
    resolveImagePath: () => null,
    getImageIndex: async () => null,
  } as unknown as CorpusReader;
}

async function callTool(name: string, args: Record<string, unknown>, e: CorpusEntryT): Promise<string> {
  const server = createServer(readerWith(e));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "sweep-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    return content.map((c) => c.text ?? "").join("\n");
  } finally {
    await client.close();
  }
}

// Verification: core + ONE enrichment field (whatToSteal). Every other
// enrichment field the split tools render is unverified and must not appear.
const VERIFIED = ["critique", "whatToSteal"];

// Sentinel fields each tool renders, in its gate set (marker-capable only).
const TOOL_MARKER_FIELDS: Record<string, readonly string[]> = {
  get_ui_example: ["whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks", "voice", "visual.dominantColors", "visual.accentColor", "visual.colorRoles", "visual.typePairing"],
  search_ui_examples: ["whatToSteal", "antiPatterns"],
  get_similar_ui_examples: ["whatToSteal"],
};

// Section substrings that must be ABSENT when the corresponding leaf is
// unverified (enum/boolean leaves the sentinels cannot reach).
const TOOL_ABSENT_SECTIONS: Record<string, readonly string[]> = {
  get_ui_example: ["Dominant colors", "Accent:", "Color roles", "Type pairing", "Spacing density", "Corners:", "Shadows:", "Borders:"],
  search_ui_examples: ["### "],
  // The similar tool ALWAYS prints a "### ..." header; the projected header
  // falls back to "corpus example", so assert the unverified enum VALUE
  // (patternType/categories) never appears instead.
  get_similar_ui_examples: ["dashboard"],
};

const TOOL_ARGS: Record<string, Record<string, unknown>> = {
  get_ui_example: { id: "sweep-entry" },
  search_ui_examples: { query: "dashboard", limit: 3 },
  get_similar_ui_examples: { id: "sweep-entry", limit: 5 },
  get_stealable_techniques: { limit: 5 },
  get_anti_patterns: { limit: 5 },
  get_color_palette: { limit: 5 },
  browse_ui_examples: {},
  compare_ui_examples: { ids: ["sweep-entry", "sweep-entry"] },
};

describe("cross-tool invariant sweep — no emitted field is unverified", () => {
  it("never emits an unverified field value from any gated tool", async () => {
    const e = entry(VERIFIED);
    const allSentinels = Object.values(S);
    for (const [tool, args] of Object.entries(TOOL_ARGS)) {
      const text = await callTool(tool, args, e);
      const markerFields = TOOL_MARKER_FIELDS[tool] ?? [];
      for (const sentinel of allSentinels) {
        const field = Object.keys(S).find((k) => S[k as keyof typeof S] === sentinel)!;
        const gatedKey =
          field === "antiPatternsAccessibilityRisks" ? "antiPatterns.accessibilityRisks"
          : field === "visualDominantColors" ? "visual.dominantColors"
          : field === "visualAccentColor" ? "visual.accentColor"
          : field === "visualColorRoles" ? "visual.colorRoles"
          : field === "visualTypePairing" ? "visual.typePairing"
          : field;
        const shouldAppear = VERIFIED.includes(gatedKey) && markerFields.includes(gatedKey);
        if (shouldAppear) {
          expect(text, `${tool} should serve verified ${gatedKey}`).toContain(sentinel);
        } else if (markerFields.includes(gatedKey)) {
          expect(text, `${tool} leaked unverified ${gatedKey}`).not.toContain(sentinel);
        }
      }
      for (const section of TOOL_ABSENT_SECTIONS[tool] ?? []) {
        expect(text, `${tool} rendered unverified section "${section}"`).not.toContain(section);
      }
      // The disclosure is the sole "exists but unverified" signal.
      if ((TOOL_MARKER_FIELDS[tool] ?? []).length > 0) {
        expect(text).toContain("Unverified fields omitted");
      }
    }
  });

  it("holds the deferred synthesis tools at full-AND — no partial entry serves", async () => {
    const e = entry(VERIFIED);
    for (const tool of ["recommend_ui_direction", "get_color_palette", "compare_ui_examples"] as const) {
      const args = tool === "compare_ui_examples"
        ? { ids: ["sweep-entry", "sweep-entry"] }
        : tool === "recommend_ui_direction"
          ? { productContext: "A calm analytics dashboard", count: 1 }
          : { limit: 5 };
      const text = await callTool(tool, args as Record<string, unknown>, e);
      for (const sentinel of Object.values(S)) {
        expect(text, `${tool} served a partial entry`).not.toContain(sentinel);
      }
      if (tool === "recommend_ui_direction") {
        // recommend checks the embedding index before touching the corpus, so
        // the honest message is about the index, not verification.
        expect(text, `${tool} did not report the missing index`).toMatch(/index/i);
      } else {
        expect(text, `${tool} did not name verification as the cause`).toMatch(/verif/i);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/invariant-sweep.test.ts`
Expected: FAIL — the sweep must pass after Tasks 4-6, so run it now against the OLD renderers to see failures on e.g. `get_ui_example` leaking `SENTINEL_ANTI`/`SENTINEL_VOICE`; if Tasks 4-6 are already merged, the sweep passes (that is the point — this test is the permanent net).

- [ ] **Step 3: Run the full suite and typecheck**

Run: `npm test`
Expected: PASS (entire vitest suite).
Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/invariant-sweep.test.ts
git commit -m "test(trust): cross-tool invariant sweep — no emitted field is unverified (2d-1)"
```

---

### Task 9: Final verification + spec status

**Files:**
- Modify: `docs/superpowers/specs/2026-08-05-field-set-gating-design.md` — status line to "**Status:** implemented" only after 2d-1 ships.

- [ ] **Step 1: Full-suite verification**

Run: `npm test`
Expected: PASS.
Run: `npx tsc --noEmit`
Expected: no errors.
Run: `npm run validate-references`
Expected: PASS (reference artifacts still validate with the optional enrichment schemas).

- [ ] **Step 2: Update the spec status**

Set the spec's status line to:

```md
**Status:** implemented
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-08-05-field-set-gating-design.md
git commit -m "docs(spec): field-set gating 2d-1 implemented"
```

---

## Self-Review

**Spec coverage (2d-1):**
- Two-set constructor, empty-CORE guard, double-wrap guard, `core`/`enrichment` accessors → Task 1.
- `projectForServing` (served/omitted, per-leaf nested keys) + per-entry disclosure → Task 2.
- All 13 registrations migrated; synthesis tools `(fullSet, [])` → Task 3.
- Four `gate.fields` consumers (messages ×3, image-attach on any served field) → Task 3.
- Image-attach tests — attaches when the only image-confirmed field is a served enrichment; no attach when it is outside the tool's set → Task 4.
- Three split renderers with projection + per-result disclosure → Tasks 4-6.
- Canonical schemas enrichment-optional + `verification` disclosure; round-trip via `parseToolResult` → Task 7.
- Cross-tool invariant sweep (render tools + deferred full-AND pin) → Task 8.
- Corpus isolation (in-memory fixtures everywhere), no `corpus/entries.json` touched → all test tasks.
- 2d-2 items explicitly NOT planned here (synthesis hardening, derived-output projection) → deferred by design.

**Placeholder scan:** no TBD/TODO; every code step carries complete code; every test step names the exact command and expected result.

**Type consistency:** `projectForServing(entry, enrichment)` returns `ServingProjection` with `served`/`omitted` — used identically in Tasks 4-6; `renderOmittedDisclosure(omitted)` returns `string` — used in the same tasks; constants `*_CORE`/`*_ENRICHMENT`/`*_FULL_SET` are defined in Task 3 and referenced verbatim in Tasks 3-6; `gate.core`/`gate.enrichment` accessors defined in Task 1 and consumed in Task 3.

**Edge cases covered:** entry with zero omitted fields (empty disclosure), empty enrichment set, parent-fail-drops-child vs parent-verified-strips-leaf, per-result attribution, image-attach served-vs-omitted field (Task 3 condition + Task 4 fixture verification), deferred tools byte-identical full-AND.
