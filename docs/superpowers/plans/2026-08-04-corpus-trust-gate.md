# Corpus Trust Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop serving corpus-derived values that nothing verified, by gating every one of them behind a single fail-closed predicate that reads how a value was checked.

**Architecture:** One new pure module (`src/corpus-trust.ts`) exports `isVerified(entry)`, reading a new optional `provenance.verification` record. `createUiSpecDeterministic` filters its `matchedEntries` parameter **once, by shadowing it**, so all 14 downstream selector sites and any future one are gated by construction rather than by discipline. `colorTokens`/`layoutRegions` come from `SanitizedEvidence`, so they are gated through a derived `trustedEvidenceIds` set applied to the same `observations` filter that already early-returns on empty. Day one no entry qualifies, so the zero-verified path is the default and gets the deepest tests.

**Tech Stack:** TypeScript, Zod, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-corpus-trust-gate-design.md`

## Global Constraints

- **Governing invariant:** a corpus-derived value is servable only when grounded in evidence that can be checked — measured from the page, provable from the data, or confirmed against the image by a verifier that saw it. An unverifiable assertion is never served.
- **Fail-closed everywhere.** Any missing, malformed, or unrecognised `verification` record reads as not verified. No default grants trust.
- `isVerified` is **pure and synchronous. No I/O, no injection, no filesystem access.** Image existence and hash staleness belong to `doctor.ts`, not to the gate.
- **The gate never consults `provenance.taggedBy` or `reviewStatus`** in any combination. Those record who touched an entry, not what was checked.
- **No feature flag.** A flag whose off-position re-enables serving fabrications is a footgun. Rollback is `git revert`.
- **`corpusEntries` is NOT gated.** It feeds `buildDeniedNames` for the identity screen, which must stay corpus-wide — narrowing it would shrink the denied-name set and weaken identity screening.
- **Trust and identity stay independent.** The trust gate runs first; `screenProse` is unchanged and still drops identity-bearing prose from trusted entries.
- **Thresholds count trusted contributors, never matched ones.** Deriving a token from one verified entry while claiming three backed it is the over-claim this whole change exists to stop.
- **Existing suites that assert the current served posture are updated in the same task that changes it**, never in a follow-up.
- TDD: failing test first, minimal implementation, passing test, commit. Write a review artifact before the next task's commit (see `CLAUDE.md`).

---

## File Structure

| File | Responsibility |
|---|---|
| `src/corpus-trust.ts` | **Create.** The predicate and the accepted-method set. Pure, no imports beyond the entry type. |
| `src/corpus-trust.test.ts` | **Create.** One case per predicate-table row. |
| `src/schema.ts` | **Modify** (`provenance` object, ~`:577-600`). Add the optional `verification` record. |
| `src/create-ui-spec-deterministic.ts` | **Modify** (`:118-125`). Shadow `matchedEntries`, narrow `observations`. The deterministic gate site. |
| `src/create-ui-spec-deterministic.test.ts` | **Modify.** Trusted-subset vote behaviour. |
| `src/create-ui-spec.ts` | **Modify** (model-call site `:254`, `c3Unavailable` ~`:1061`, docblock `:12`). Model-lane prompt-grounding filter (Task 2); reason rows for the five array fields; stale docblock. |
| `src/create-ui-spec.test.ts` | **Modify.** Zero-verified default path assertions. |
| `src/create-ui-spec-model-path.test.ts` | **Modify.** Prompt-grounding filter assertions. |
| `src/scripts/doctor.ts` | **Modify.** The eight detectors as a standing health check. |

---

## Task 1: `provenance.verification` and the `isVerified` predicate

**Files:**
- Create: `src/corpus-trust.ts`
- Create: `src/corpus-trust.test.ts`
- Modify: `src/schema.ts` (the `provenance` object, currently `taggedBy` / `reviewedBy` / `capture`)

**Interfaces:**
- Consumes: `CorpusEntryT` from `./schema.js`.
- Produces: `isVerified(entry: CorpusEntryT): boolean`, `trustedEvidenceIdsOf(matchedEntries): Set<string>`, and `VERIFICATION_METHODS: ReadonlySet<string>`. Task 2 imports `trustedEvidenceIdsOf` (the deterministic filter and the model-lane prompt filter both call it); Task 4 reuses the Task 2 import in `create-ui-spec.ts`; Task 5 imports `VERIFICATION_METHODS`.

- [ ] **Step 1: Write the failing test**

Create `src/corpus-trust.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isVerified, trustedEvidenceIdsOf } from "./corpus-trust.js";
import type { CorpusEntryT } from "./schema.js";

/** A minimal entry. Only `provenance` matters to the predicate. */
function entry(provenance?: unknown): CorpusEntryT {
  return { id: "e1", provenance } as unknown as CorpusEntryT;
}

const VALID = {
  method: "image-confirmed",
  verifiedAt: "2026-08-04",
  verifierVersion: "verifier-v1",
  imageSha256: "a".repeat(64),
};

describe("isVerified — fail-closed predicate", () => {
  it("verifies a well-formed image-confirmed record", () => {
    expect(isVerified(entry({ taggedBy: "auto", verification: VALID }))).toBe(true);
  });

  it("verifies measured and provable records with no imageSha256", () => {
    for (const method of ["measured", "provable"]) {
      const v = { method, verifiedAt: "2026-08-04", verifierVersion: "verifier-v1" };
      expect(isVerified(entry({ taggedBy: "auto", verification: v })), method).toBe(true);
    }
  });

  it("refuses an entry with no verification record", () => {
    expect(isVerified(entry({ taggedBy: "auto" }))).toBe(false);
  });

  it("refuses an entry with no provenance at all", () => {
    expect(isVerified(entry(undefined))).toBe(false);
  });

  it("refuses an unrecognised method (a newer verifier's tier)", () => {
    const v = { ...VALID, method: "vibes-confirmed" };
    expect(isVerified(entry({ taggedBy: "auto", verification: v }))).toBe(false);
  });

  it("refuses image-confirmed with no imageSha256 — malformed record", () => {
    const { imageSha256: _drop, ...noHash } = VALID;
    expect(isVerified(entry({ taggedBy: "auto", verification: noHash }))).toBe(false);
  });

  // The two fields that look like trust signals and are not.
  it("never consults taggedBy or reviewStatus", () => {
    for (const taggedBy of ["auto", "auto-reviewed", "human"]) {
      expect(isVerified(entry({ taggedBy, reviewedBy: "someone" })), taggedBy).toBe(false);
      expect(
        isVerified(entry({ taggedBy, reviewedBy: "someone", verification: VALID })),
        taggedBy,
      ).toBe(true);
    }
  });

  it("performs no I/O — a bogus image path changes nothing", () => {
    const e = { id: "e1", image: { path: "images-private/gone.png" }, provenance: { taggedBy: "auto", verification: VALID } };
    expect(isVerified(e as unknown as CorpusEntryT)).toBe(true);
  });

  it("trustedEvidenceIdsOf returns only verified entries' ids", () => {
    const pairs = [
      { evidenceId: "evidence-2", entry: entry({ taggedBy: "auto", verification: VALID }) },
      { evidenceId: "evidence-3", entry: entry({ taggedBy: "auto" }) },
      { evidenceId: "evidence-4", entry: entry({ taggedBy: "auto", verification: { ...VALID, method: "measured" } }) },
    ];
    expect(trustedEvidenceIdsOf(pairs)).toEqual(new Set(["evidence-2", "evidence-4"]));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/corpus-trust.test.ts`
Expected: FAIL — `Failed to resolve import "./corpus-trust.js"`.

- [ ] **Step 3: Write the module**

Create `src/corpus-trust.ts`:

```ts
/**
 * corpus-trust.ts — the trust gate for corpus-derived values.
 *
 * The corpus records who TOUCHED an entry (`provenance.taggedBy`) and never what
 * was CHECKED. `taggedBy: "auto-reviewed"` is machine-stamped (`ui/app.js:1375`,
 * `:1488`) and `reviewStatus` is `approved` on 787/787 entries, so neither field
 * carries trust information. This module reads a different record —
 * `provenance.verification` — which states HOW a value was checked.
 *
 * PURE AND SYNCHRONOUS BY DESIGN. It performs no I/O. An earlier draft took a
 * `resolveImagePath` so it could refuse entries whose image had gone missing;
 * that resolver validates path SHAPE only (`paths.ts:132`), and more importantly
 * a missing image does not invalidate a past verification — the record attests a
 * claim was checked when the image existed, and the caller never sees the
 * screenshot. Image existence and hash staleness are corpus-integrity checks and
 * live in `doctor.ts`.
 */
import type { CorpusEntryT } from "./schema.js";

/**
 * The evidence tiers a verification record may claim. Anything else — including a
 * tier a NEWER verifier introduces — reads as not verified, so an old build can
 * never serve a value it does not understand.
 */
export const VERIFICATION_METHODS: ReadonlySet<string> = new Set([
  "measured",
  "provable",
  "image-confirmed",
]);

/**
 * True when the entry carries a verification record this build understands.
 *
 * Fail-closed on every other input: no provenance, no verification, an
 * unrecognised method, or an `image-confirmed` record missing the image hash that
 * binds it to the bytes the verifier saw.
 */
export function isVerified(entry: CorpusEntryT): boolean {
  const verification = entry.provenance?.verification;
  if (!verification) return false;
  if (!VERIFICATION_METHODS.has(verification.method)) return false;
  // `imageSha256` is optional on the type and mandatory by method: the measured
  // tier's evidence is the live DOM, not the pixels, so binding it to an image
  // hash would tie the record to the wrong artifact.
  if (verification.method === "image-confirmed" && !verification.imageSha256) return false;
  return true;
}

/**
 * The evidence ids of the matched entries that pass the gate. Shared by BOTH
 * consumers — the model lane's prompt-grounding filter (create-ui-spec.ts) and
 * the deterministic synthesizer (create-ui-spec-deterministic.ts) — so trust is
 * defined in exactly one place and the two paths cannot drift.
 */
export function trustedEvidenceIdsOf(
  matchedEntries: readonly { readonly evidenceId: string; readonly entry: CorpusEntryT }[],
): Set<string> {
  return new Set(matchedEntries.filter((m) => isVerified(m.entry)).map((m) => m.evidenceId));
}
```

- [ ] **Step 4: Add `verification` to the schema**

In `src/schema.ts`, inside the `provenance: z.object({ ... })` block (alongside `taggedBy`, `reviewedBy`, `capture`), add:

```ts
    /**
     * HOW this entry's values were checked, as opposed to who touched them.
     * Absent on every entry that predates the trust gate, which is why the gate
     * is fail-closed: absent means not verified.
     *
     * `imageSha256` binds an image-confirmed record to the exact bytes the
     * verifier saw, so re-capturing the screenshot makes the record stale rather
     * than valid (checked by `doctor.ts`, never on the serve path). It is
     * REQUIRED when `method` is "image-confirmed" and omitted for `measured`,
     * whose evidence is the live DOM rather than the pixels.
     */
    verification: z.object({
      method: z.enum(["measured", "provable", "image-confirmed"]),
      verifiedAt: z.string().min(1),
      verifierVersion: z.string().min(1),
      imageSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    }).strict().optional(),
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/corpus-trust.test.ts && npx tsc --noEmit`
Expected: PASS, 8 tests. `tsc` clean.

- [ ] **Step 6: Confirm no real entry qualifies**

Run:
```bash
node -e 'const {readFileSync}=require("fs");const j=JSON.parse(readFileSync("corpus/entries.json","utf8"));const E=Array.isArray(j)?j:(j.entries||[]);console.log("entries with a verification record:",E.filter(e=>e.provenance&&e.provenance.verification).length,"of",E.length);'
```
Expected: `entries with a verification record: 0 of 787`. If this is not 0, stop — something already writes the field and the gate's day-one behaviour is not what the spec assumes.

- [ ] **Step 7: Commit**

```bash
git add src/corpus-trust.ts src/corpus-trust.test.ts src/schema.ts
git commit -m "feat(corpus): fail-closed trust predicate reading provenance.verification"
```

---

## Task 2: Gate every corpus-derived value at one site

**Files:**
- Modify: `src/create-ui-spec-deterministic.ts` (signature `:118-125`, `observations` filter `:124`)
- Modify: `src/create-ui-spec-deterministic.test.ts`
- Modify: `src/create-ui-spec.ts` (model-call site `:254`) and `src/create-ui-spec-model-path.test.ts`

**Interfaces:**
- Consumes: `isVerified` from Task 1.
- Produces: no signature change. `createUiSpecDeterministic(evidence, matchedEntries, corpusEntries, request)` keeps its four parameters and its `DeterministicSynthesis` return type, so no caller changes.

- [ ] **Step 1: Write the failing tests**

Append to `src/create-ui-spec-deterministic.test.ts`. `proseEntry`, `matched`, `entriesOf`, `observation` and `REQUEST` already exist in that file.

```ts
// ---------------------------------------------------------------------------
// Trust gate (Stage 1)
// ---------------------------------------------------------------------------

/** A verification record the gate accepts. */
const VERIFIED = {
  taggedBy: "auto",
  verification: {
    method: "image-confirmed",
    verifiedAt: "2026-08-04",
    verifierVersion: "verifier-v1",
    imageSha256: "a".repeat(64),
  },
};

function verifiedProseEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return proseEntry({ provenance: VERIFIED, ...over });
}

const GATE_FACTS = {
  pattern: "dashboard", spacingDensity: "compact", cornerStyle: "sharp",
  usesShadows: false, usesBorders: true, layoutForm: "two-column",
  colorRoles: { canvas: "#ffffff", surface: "#f8fafc", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
};

describe("createUiSpecDeterministic — trust gate", () => {
  it("serves nothing corpus-derived when no entry is verified", () => {
    const matches = [2, 3, 4].map((n) => matched(`evidence-${n}`, proseEntry({ id: `u-${n}` })));
    const evidence = [2, 3, 4].map((n) => observation(`evidence-${n}`, GATE_FACTS));
    const out = createUiSpecDeterministic(evidence as never, matches, entriesOf(matches), REQUEST);

    expect(out.designDirection).toBeNull();
    expect(out.colorTokens).toBeNull();
    expect(out.layoutRegions).toEqual([]);
    expect(out.responsiveBehavior).toEqual([]);
    expect(out.techniques).toEqual([]);
    expect(out.antiPatterns).toEqual([]);
    expect(out.contentVoiceGuidance).toBeNull();
    expect(out.accessibilityConstraints).toEqual([]);
    expect(out.componentInventory).toEqual([]);
  });

  it("is a filter, not an off switch — verified entries still serve", () => {
    const matches = [
      matched("evidence-2", verifiedProseEntry({ id: "v-2" })),
      matched("evidence-3", proseEntry({ id: "u-3" })),
    ];
    const evidence = [
      observation("evidence-2", GATE_FACTS),
      observation("evidence-3", GATE_FACTS),
    ];
    const out = createUiSpecDeterministic(evidence as never, matches, entriesOf(matches), REQUEST);

    expect(out.techniques.length).toBeGreaterThan(0);
    // Every citation points at the verified entry only.
    for (const t of out.techniques) expect(t.sourceIds).toEqual(["evidence-2"]);
    expect(out.designDirection).toContain("evidence-2");
    expect(out.designDirection).not.toContain("evidence-3");
  });

  // The three-contributor colorTokens guard must count TRUSTED contributors.
  // Counting matches while voting over the trusted subset would derive a token
  // from one entry while claiming three backed it.
  it("counts trusted contributors, not matched ones, for the token threshold", () => {
    const matches = [
      matched("evidence-2", verifiedProseEntry({ id: "v-2" })),
      matched("evidence-3", proseEntry({ id: "u-3" })),
      matched("evidence-4", proseEntry({ id: "u-4" })),
    ];
    const evidence = [2, 3, 4].map((n) => observation(`evidence-${n}`, GATE_FACTS));
    const out = createUiSpecDeterministic(evidence as never, matches, entriesOf(matches), REQUEST);
    expect(out.colorTokens).toBeNull();
  });

  it("populates tokens once three entries are verified", () => {
    const matches = [2, 3, 4].map((n) => matched(`evidence-${n}`, verifiedProseEntry({ id: `v-${n}` })));
    const evidence = [2, 3, 4].map((n) => observation(`evidence-${n}`, GATE_FACTS));
    const out = createUiSpecDeterministic(evidence as never, matches, entriesOf(matches), REQUEST);
    expect(out.colorTokens).not.toBeNull();
    expect(out.colorTokens?.accent).toBe("#2563eb");
  });

  // Verifying one more entry can move a plurality. That is correct — the
  // evidence base changed — but a 2-1 becoming 2-2 must yield no winner rather
  // than silently keeping the old one.
  it("a newly verified entry can flip a vote to a tie, which yields no token", () => {
    const withAccent = (accent: string) => ({
      ...GATE_FACTS,
      colorRoles: { canvas: "#ffffff", surface: "#f8fafc", ink: "#111827", muted: "#6b7280", accent },
    });
    const matches = [2, 3, 4, 5].map((n) => matched(`evidence-${n}`, verifiedProseEntry({ id: `v-${n}` })));
    const evidence = [
      observation("evidence-2", withAccent("#2563eb")),
      observation("evidence-3", withAccent("#2563eb")),
      observation("evidence-4", withAccent("#dc2626")),
      observation("evidence-5", withAccent("#dc2626")),
    ];
    const out = createUiSpecDeterministic(evidence as never, matches, entriesOf(matches), REQUEST);
    expect(out.colorTokens).toBeNull();
  });

  it("gates layoutRegions through the same evidence-id bridge", () => {
    const matches = [matched("evidence-2", proseEntry({ id: "u-2" }))];
    const evidence = [observation("evidence-2", {
      ...GATE_FACTS, layoutRoles: ["primary-nav", "main-canvas"],
    })];
    const out = createUiSpecDeterministic(evidence as never, matches, entriesOf(matches), REQUEST);
    expect(out.layoutRegions).toEqual([]);
  });

  it("keeps trust and identity independent", () => {
    // A verified entry whose prose names its own product is still dropped by the
    // identity screen. Trust does not buy an identity exemption.
    const named = verifiedProseEntry({
      id: "v-2",
      source: { productName: "Trustworthy" },
      whatToSteal: ["Copy the way Trustworthy anchors its filter rail."],
    });
    const matches = [matched("evidence-2", named)];
    const evidence = [observation("evidence-2", GATE_FACTS)];
    const out = createUiSpecDeterministic(evidence as never, matches, entriesOf(matches), REQUEST);
    expect(out.techniques).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/create-ui-spec-deterministic.test.ts -t "trust gate"`
Expected: FAIL — the first test finds `designDirection` non-null and `techniques` populated, because nothing gates yet.

- [ ] **Step 3: Gate by shadowing the parameter**

In `src/create-ui-spec-deterministic.ts`, add the import:

```ts
import { trustedEvidenceIdsOf } from "./corpus-trust.js";
```

Then rename the parameter and shadow it. Replace the function's opening — currently:

```ts
export function createUiSpecDeterministic(
  evidence: readonly SanitizedEvidence[],
  matchedEntries: readonly { readonly evidenceId: string; readonly entry: CorpusEntryT }[],
  corpusEntries: readonly CorpusEntryT[],
  request: CreateUiSpecRequest,
): DeterministicSynthesis {
  const observations = evidence.filter((e) => e.kind === "corpus-observation" && e.structuredFacts);
```

with:

```ts
export function createUiSpecDeterministic(
  evidence: readonly SanitizedEvidence[],
  allMatchedEntries: readonly { readonly evidenceId: string; readonly entry: CorpusEntryT }[],
  corpusEntries: readonly CorpusEntryT[],
  request: CreateUiSpecRequest,
): DeterministicSynthesis {
  // ----- C3 trust gate (Stage 1) -------------------------------------------
  // ONE filter, and it works by SHADOWING: the ungated parameter is
  // `allMatchedEntries` and the name the body uses is the trusted view. Every
  // existing selector and every future one therefore reads gated entries
  // without needing its own guard — the ungated list is not in scope below.
  //
  // `corpusEntries` is deliberately NOT gated. It feeds `buildDeniedNames` for
  // the identity screen, which must stay corpus-wide; narrowing it would shrink
  // the denied-name set and weaken screening.
  const matchedEntries = allMatchedEntries.filter((m) => isVerified(m.entry));
  // `colorTokens` and `layoutRegions` derive from SanitizedEvidence rows, which
  // do not carry their entry. Bridge the same filter through the evidence id so
  // the plurality votes run over trusted observations only — which also means
  // the existing three-contributor guard counts TRUSTED contributors.
  const trustedEvidenceIds = trustedEvidenceIdsOf(matchedEntries);
  const observations = evidence.filter(
    (e) => e.kind === "corpus-observation" && e.structuredFacts && trustedEvidenceIds.has(e.id),
  );
```

Leave the rest of the function untouched: the existing `if (observations.length === 0)` early return now fires whenever nothing is trusted, which is what makes every field null or empty at once.

- [ ] **Step 3b: Gate the model lane's prompt grounding (review finding D1)**

The deterministic body is gated, but the model lane builds its prompt from
`resolved.sanitized` BEFORE the synthesizer runs (`create-ui-spec.ts:254-255`),
so an unverified entry's derived summary would still reach the model. The
served `evidence[]` rows stay UNGATED (they are response-scoped, carry no
authority claim, and are returned from the adapter result path), but what the
model sees must be trusted.

In `src/create-ui-spec.ts`, replace the model-call block:

```ts
  const outcome = await createUiSpecModel(
    { request, sanitizedEvidence: resolved.sanitized },
    model.runtime,
  );
```

with:

```ts
  // C3 trust gate: what the MODEL sees must be trusted, even though the served
  // evidence[] rows stay ungated (response-scoped, no authority claim). An
  // unverified entry's derived summary must not steer a proposal.
  //
  // Narrow ONLY corpus observations, exactly like the deterministic filter does.
  // `resolved.sanitized[0]` is the recipe/system row from
  // `buildRecipeSystemEvidence()` (kind "recipe-system", evidence-1): it has no
  // `matchedEntries` pair, so a flat `trustedEvidenceIds.has(row.id)` filter
  // would drop it. That row carries no corpus claim at all, so dropping it is
  // over-gating -- it would remove recipe context the trust gate has no reason
  // to touch. Zero verified corpus entries therefore leaves the recipe row and
  // no corpus grounding, which is the intended state.
  const trustedEvidenceIds = trustedEvidenceIdsOf(resolved.matchedEntries);
  const outcome = await createUiSpecModel(
    {
      request,
      sanitizedEvidence: resolved.sanitized.filter(
        (row) => row.kind !== "corpus-observation" || trustedEvidenceIds.has(row.id),
      ),
    },
    model.runtime,
  );
```

`SanitizedEvidenceSchema.array()` carries no `.min(1)`
(`create-ui-spec-model.ts:87`), so a corpus-free list parses rather than
rejecting the proposal.

This step adds the `trustedEvidenceIdsOf` import to `src/create-ui-spec.ts`.
Task 4's disclosure step additionally needs `isVerified` from the same module --
import both in one statement here so Task 4 adds nothing:

```ts
import { isVerified, trustedEvidenceIdsOf } from "./corpus-trust.js";
```

Add the failing test to `src/create-ui-spec-model-path.test.ts`:

```ts
it("keeps unverified entries' derived summaries out of the model prompt", async () => {
  // Two matched entries: one verified (dashboard), one not (forms). The
  // prompt's evidenceSummaries must carry only the verified row's derived
  // summary; the served evidence rows still include both (ungated).
  const verified = {
    id: "internal-v",
    patternType: "dashboard",
    provenance: {
      taggedBy: "auto",
      verification: {
        method: "image-confirmed",
        verifiedAt: "2026-08-04",
        verifierVersion: "verifier-v1",
        imageSha256: "a".repeat(64),
      },
    },
    visual: {
      colorRoles: { canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
      spacingDensity: "compact", cornerStyle: "slight-round",
      usesShadows: false, usesBorders: true,
      accentColor: "#2563eb", typePairing: { display: "Inter", body: "Inter" },
    },
  } as unknown as CorpusEntryT;
  const unverified = {
    id: "internal-u",
    patternType: "forms",
    visual: {
      colorRoles: { canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
      spacingDensity: "compact", cornerStyle: "slight-round",
      usesShadows: false, usesBorders: true,
      accentColor: "#2563eb", typePairing: { display: "Inter", body: "Inter" },
    },
  } as unknown as CorpusEntryT;
  const reader = {
    ...makeReader(),
    searchRanked: vi.fn(async () => [
      { entry: verified, score: 5, searchMode: "keyword" },
      { entry: unverified, score: 4, searchMode: "keyword" },
    ]),
  } as unknown as CorpusReader;

  const runtime = makeRuntime();
  const out = await createUiSpecForAdapter(
    REQUEST,
    makeCreateUiSpecDependencies(reader, FIXED_NOW, { kind: "configured", runtime }),
  );
  expect(out.envelope.modelExecution?.state).toBe("succeeded");
  const [callArgs] = runtime.call.mock.calls[0] as [Parameters<CreateUiSpecModelRuntime["call"]>[0]];
  expect(callArgs.prompt).toContain("dashboard reference");
  expect(callArgs.prompt).not.toContain("forms reference");
  // Served evidence still reports both rows (ungated, no authority claim).
  expect(out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation")).toHaveLength(2);
});
```

`makeReader`, `makeRuntime`, `FIXED_NOW`, `REQUEST`, `CorpusEntryT`,
`CorpusReader`, `vi`, `makeCreateUiSpecDependencies` and
`CreateUiSpecModelRuntime` are already imported in that file.

Run: `npx vitest run src/create-ui-spec-model-path.test.ts -t "model prompt"`
Expected: FAIL — the prompt currently contains both summaries.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/create-ui-spec-deterministic.test.ts && npx tsc --noEmit`
Expected: PASS, all tests including the pre-existing ones. `tsc` clean.

- [ ] **Step 5: Prove the shadowing left no ungated read**

Run: `grep -n "allMatchedEntries" src/create-ui-spec-deterministic.ts`
Expected: exactly two lines — the parameter declaration and the filter. Any third occurrence is an ungated read and must be changed to `matchedEntries`.

- [ ] **Step 6: Update the suites that assert the old served posture**

Run: `npx vitest run src/create-ui-spec.test.ts src/full-corpus-leak-sweep.test.ts src/create-ui-spec-http.test.ts src/design-handoff.test.ts`
Expected: failures wherever a test asserts corpus prose is served. For each, add `provenance: VERIFIED` to the fixture entry when the test's subject is the serving behaviour, or update the expectation to the gated posture when its subject is the default path. Do not delete a leak-sweep assertion — the sweep's synthetic arm must keep proving the identity screen works, so its entries need the verification record added.

- [ ] **Step 7: Run the full suite**

Run: `npm run build && npx vitest run`
Expected: PASS, 0 failed.

- [ ] **Step 8: Commit**

```bash
git add src/create-ui-spec-deterministic.ts src/create-ui-spec-deterministic.test.ts src/create-ui-spec.test.ts src/full-corpus-leak-sweep.test.ts src/create-ui-spec-http.test.ts src/design-handoff.test.ts
git commit -m "feat(create-ui-spec): gate every corpus-derived value behind the trust predicate"
```

---

## Task 3: Honest reason rows for the five gated array fields, and the stale docblock

**Files:**
- Modify: `src/create-ui-spec.ts` (`c3Unavailable` ~`:1061`; docblock `:12`)
- Modify: `src/create-ui-spec.test.ts`

**Interfaces:**
- Consumes: the gated `DeterministicSynthesis` from Task 2. No new exports.

`techniques`, `antiPatterns`, `componentInventory`, `responsiveBehavior` and `accessibilityConstraints` fall back to the recipe's fixed-empty arrays (`create-ui-spec.ts:1143-1170`). Gated without a reason row they are indistinguishable from "the corpus had nothing to say". `UnavailableDecision.field` is an open `z.string()` (`tool-contracts.ts:701`), so no enum change is needed — but `unavailableDecisions` fields must be UNIQUE (`tool-contracts.ts:793-796`), so each row is added exactly once and only when the field is actually empty.

`colorTokenAuthority` and the `colorTokens` citedDecision need **no change**: `:1158` already derives authority from `synthesis?.colorTokens`, and `:983` only adds the corpus-evidence row when `synthesis?.colorTokens` is truthy. Gating makes those null at the source, so both revert on their own. Task 3 tests that rather than implementing it.

- [ ] **Step 1: Write the failing test**

Append to `src/create-ui-spec.test.ts`:

```ts
describe("create_ui_spec — gated fields carry honest reasons", () => {
  it("emits one unavailable row per gated field and keeps them unique", async () => {
    const corpus = [corpusEntryWithRoles("gate-a", "#2563eb", "dashboard")];
    const out = await createUiSpecForAdapter(
      noRefRequest(),
      deps(corpus, corpus.map((e) => ({ entry: e, score: 5 }))),
    );
    const rows = out.envelope.spec.unavailableDecisions;
    const fields = rows.map((r) => r.field);

    for (const field of [
      "techniques", "antiPatterns", "componentInventory",
      "responsiveBehavior", "accessibilityConstraints",
    ]) {
      expect(fields, `missing reason row for ${field}`).toContain(field);
      const row = rows.find((r) => r.field === field);
      expect(row?.reason).toMatch(/verified|verification/i);
    }
    // The UiSpec gate requires uniqueness; assert it directly so a duplicate is
    // caught here rather than as an opaque parse failure.
    expect(new Set(fields).size).toBe(fields.length);
  });

  it("reverts colour authority with no extra code when tokens are gated", async () => {
    const corpus = [corpusEntryWithRoles("gate-b", "#2563eb", "dashboard")];
    const out = await createUiSpecForAdapter(
      noRefRequest(),
      deps(corpus, corpus.map((e) => ({ entry: e, score: 5 }))),
    );
    const spec = out.envelope.spec;
    expect(spec.colorTokens).toBeNull();
    expect(spec.colorTokenAuthority).toBe("editorial");
    expect(spec.citedDecisions.some((d) => d.field === "colorTokens" && d.authority === "corpus-evidence")).toBe(false);
    expect(spec.citedDecisions.some((d) => d.authority === "corpus-evidence")).toBe(false);
    expect(spec.designDirection).not.toMatch(/evidence-\d/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/create-ui-spec.test.ts -t "gated fields carry honest reasons"`
Expected: FAIL on the first test — no reason row exists for `techniques`.

- [ ] **Step 3: Add the reason rows**

In `src/create-ui-spec.ts`, extend the `c3Unavailable` array. Each row is conditional on the field actually being empty, so a partially-verified response does not claim a field is unavailable while serving it:

```ts
  // Gated-by-trust reasons. A gated array is otherwise indistinguishable from
  // "the corpus had nothing to say", which is the presence-vs-truth confusion
  // this whole change exists to remove. Each row is conditional on the SERVED
  // value being empty — not on `synthesis` being non-null — so the MODEL path
  // (synthesis === null, specFields fixed-empty) carries the same honest rows,
  // and a partially-verified response never claims a field is unavailable
  // while serving it. Each appears at most once (uniqueness is enforced by
  // tool-contracts.ts:793-796).
  const gatedReason =
    "Corpus judgment is served only from entries with a recorded verification; none of the matched entries carry one.";
  const gatedEmpty = (field: "techniques" | "antiPatterns" | "componentInventory" | "responsiveBehavior" | "accessibilityConstraints"): boolean =>
    ((synthesis?.[field] ?? specFields[field]) as readonly unknown[]).length === 0;
  const c3TrustGated: UiSpecT["unavailableDecisions"] = [
    ...(gatedEmpty("techniques") ? [{ field: "techniques", reason: gatedReason }] : []),
    ...(gatedEmpty("antiPatterns") ? [{ field: "antiPatterns", reason: gatedReason }] : []),
    ...(gatedEmpty("componentInventory") ? [{ field: "componentInventory", reason: gatedReason }] : []),
    ...(gatedEmpty("responsiveBehavior") ? [{ field: "responsiveBehavior", reason: gatedReason }] : []),
    ...(gatedEmpty("accessibilityConstraints") ? [{ field: "accessibilityConstraints", reason: gatedReason }] : []),
  ];
```

Add one assertion to the Task 3 Step 1 test's "keeps them unique" case: run the
same corpus through the MODEL path (configured runtime) and assert the five
reason rows are present there too, so the served-value condition is pinned on
the path it was written for.

Then include `...c3TrustGated` in the `unavailableDecisions` array built immediately below `c3Unavailable`, alongside the existing spreads.

- [ ] **Step 4: Fix the stale docblock**

In `src/create-ui-spec.ts`, the module docblock at `:12` claims retrieval is "product-diverse selection of at most five". The implementation at `:509` is top-3 by rank with `patternType` dedupe. Replace that bullet's wording:

```
 *  2. Evidence resolution — keyword-only retrieval capped at 20 then sliced to
 *     the top 3 by rank, deduped so one patternType cannot take two slots (there
 *     is NO product-diversity pick — see the note at the `distinctPatterns`
 *     helper); explicit reference-token resolution through an injected resolver.
 *     The core NEVER dispatches to a network-backed search path.
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/create-ui-spec.test.ts && npx tsc --noEmit`
Expected: PASS. `tsc` clean.

- [ ] **Step 6: Commit**

```bash
git add src/create-ui-spec.ts src/create-ui-spec.test.ts
git commit -m "feat(create-ui-spec): reason rows for trust-gated fields; fix stale retrieval docblock"
```

---

## Task 4: Disclose the verified-source count

**Files:**
- Modify: `src/create-ui-spec.ts` (warning construction)
- Modify: `src/create-ui-spec.test.ts`

**Interfaces:**
- Consumes: the trusted count. No new exports.

**Design decision, recorded per the spec's constraint.** The spec requires disclosing a verified-source count and warns that the leaf gate is fail-closed over every served position. Verified against the code (2026-08-04): the leaf gate walks **string leaves only** — "It walks EVERY string leaf reachable under `data`, `referenceIds` and `evidence`" (`tool-contracts.ts`) — so a NUMERIC field needs no leaf classification. The real constraint on any new field is the strict Zod envelope/data schemas: it must be declared in `makeEnvelope` / the data schema or the response is refused. With that corrected, three options were checked against the code:

1. A new `retrieval.verifiedCount` numeric field — no leaf classification needed, but it must be declared in the strict `RetrievalState` schema (a contract change rippling through every transport fixture), and it is per-response while the spec's disclosure is per-response too. Viable, but the most invasive option.
2. An `unavailableDecisions` reason mentioning the count — already classified free text, but reason strings are per-field and the count is per-response.
3. **The existing `insufficientCorpusEvidence` warning code** — already in `create_ui_spec`'s allowed set (`tool-contracts.ts:1894`), `WarningSchema.message` is already-classified bounded free text (`max(500)`, `create-ui-spec-contracts.ts:601`), and warnings are already served on both transports.

Option 3 is chosen: zero new leaf classification, zero schema change, and the code already means "the corpus did not sufficiently ground this".

- [ ] **Step 1: Write the failing test**

Append to `src/create-ui-spec.test.ts`:

```ts
describe("create_ui_spec — trust disclosure", () => {
  it("warns with the verified-source count when matches were found but none trusted", async () => {
    const corpus = [corpusEntryWithRoles("disc-a", "#2563eb", "dashboard")];
    const out = await createUiSpecForAdapter(
      noRefRequest(),
      deps(corpus, corpus.map((e) => ({ entry: e, score: 5 }))),
    );
    const warning = out.envelope.warnings.find((w) => w.code === "insufficientCorpusEvidence");
    expect(warning, "expected an insufficientCorpusEvidence warning").toBeDefined();
    expect(warning?.message).toMatch(/0 of 1/);
    // Retrieval is still reported truthfully: matches were found.
    expect(out.envelope.retrieval.resultCount).toBeGreaterThan(0);
  });

  it("emits no such warning when there were no matches at all", async () => {
    const out = await createUiSpecForAdapter(noRefRequest(), deps([], []));
    const warning = out.envelope.warnings.find(
      (w) => w.code === "insufficientCorpusEvidence" && /verified/.test(w.message),
    );
    expect(warning).toBeUndefined();
  });

  it("warns with N of M when SOME matched entries are verified", async () => {
    // The partial case is the branch that distinguishes "trusted some" from
    // "trusted none": one verified + one unverified entry must report "1 of 2".
    const verified = corpusEntryWithRoles("disc-v", "#2563eb", "dashboard");
    verified.provenance = {
      taggedBy: "auto",
      verification: {
        method: "image-confirmed",
        verifiedAt: "2026-08-04",
        verifierVersion: "verifier-v1",
        imageSha256: "a".repeat(64),
      },
    };
    const unverified = corpusEntryWithRoles("disc-u", "#dc2626", "forms");
    const corpus = [verified, unverified];
    const out = await createUiSpecForAdapter(
      noRefRequest(),
      deps(corpus, corpus.map((e) => ({ entry: e, score: 5 }))),
    );
    const warning = out.envelope.warnings.find((w) => w.code === "insufficientCorpusEvidence");
    expect(warning).toBeDefined();
    expect(warning?.message).toMatch(/1 of 2/);
  });

  it("emits no trust warning when every matched entry is verified", async () => {
    const corpus = ["a", "b"].map((k, i) => corpusEntryWithRoles(`disc-${k}`, "#2563eb", i === 0 ? "dashboard" : "forms"));
    for (const e of corpus) {
      e.provenance = {
        taggedBy: "auto",
        verification: {
          method: "image-confirmed",
          verifiedAt: "2026-08-04",
          verifierVersion: "verifier-v1",
          imageSha256: "a".repeat(64),
        },
      };
    }
    const out = await createUiSpecForAdapter(
      noRefRequest(),
      deps(corpus, corpus.map((e) => ({ entry: e, score: 5 }))),
    );
    const warning = out.envelope.warnings.find(
      (w) => w.code === "insufficientCorpusEvidence" && /verified/.test(w.message),
    );
    expect(warning).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/create-ui-spec.test.ts -t "trust disclosure"`
Expected: FAIL — no `insufficientCorpusEvidence` warning is emitted.

- [ ] **Step 3: Emit the warning**

The site is `buildWarnings` in `src/create-ui-spec.ts:1400`, which already takes
`resolved: ResolvedEvidence` — and `ResolvedEvidence.matchedEntries` is exactly
the ungated list. So this needs no new plumbing and no signature change.

`isVerified` was already imported into `src/create-ui-spec.ts` in Task 2 (the
model-lane prompt-grounding filter). Do not add a second import.

Then insert this block into `buildWarnings`, before the `motionEvidenceUnavailable`
push:

```ts
  // Trust disclosure. "We found matches and did not trust them" is a truthful
  // state and must be distinguishable from "we found nothing", so the message
  // carries both numbers. Reuses the already-classified
  // insufficientCorpusEvidence code rather than introducing a numeric leaf that
  // the fail-closed leaf gate would then have to classify.
  const matchedCount = resolved.matchedEntries.length;
  const verifiedCount = resolved.matchedEntries.filter((m) => isVerified(m.entry)).length;
  if (matchedCount > 0 && verifiedCount < matchedCount) {
    warnings.push({
      code: "insufficientCorpusEvidence",
      message:
        `${verifiedCount} of ${matchedCount} matched corpus entries carry a recorded ` +
        `verification; corpus judgment is served only from verified entries.`,
    });
  }
```

Note the guard is `matchedCount > 0`: with zero matches the existing
`sparseCoverage` warning already tells the truth, and adding a second warning
would double-report the same fact.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/create-ui-spec.test.ts && npx tsc --noEmit`
Expected: PASS. `tsc` clean.

- [ ] **Step 5: Verify both transports still accept the envelope**

Run: `npx vitest run src/create-ui-spec-http.test.ts src/create-ui-spec-mcp.test.ts src/public-mcp-contract.test.ts src/tool-contracts.test.ts`
Expected: PASS. A failure here means the warning was not accepted by the leaf gate or the descriptor's warning set, which is the exact failure mode option 3 was chosen to avoid.

- [ ] **Step 6: Commit**

```bash
git add src/create-ui-spec.ts src/create-ui-spec.test.ts
git commit -m "feat(create-ui-spec): disclose the verified-source count via insufficientCorpusEvidence"
```

---

## Task 5: The defect detectors as a standing corpus health check

**Files:**
- Modify: `src/scripts/doctor.ts`
- Modify: `src/scripts/doctor.test.ts`

**Interfaces:**
- Consumes: `VERIFICATION_METHODS` from Task 1 (for the stale/missing-image checks that only apply to verified entries).
- Produces: no new exports beyond whatever `doctor.ts` already exposes for its checks.

These detectors found 733 of 787 entries defective. They belong in `doctor.ts` so a regression surfaces without a one-off script. **They report only** — they must not write `verification` and must not un-gate anything. Alan's critique is entirely fabricated and trips zero mechanical detectors, so mechanical cleanliness is necessary and not sufficient; granting trust from these checks would re-ship the same fabrication class with a trust label attached.

- [ ] **Step 1: Read the existing check structure**

Run: `grep -n "function\|check" src/scripts/doctor.ts | head -40`

Follow whatever shape the existing checks use — same reporting helper, same severity vocabulary, same output format. Do not introduce a second reporting convention.

- [ ] **Step 2: Write the failing test**

Add to `src/scripts/doctor.test.ts`, using the synthetic corpus helper already built for `full-corpus-leak-sweep.test.ts` (a 12-entry in-memory corpus with known-bad rows). Assert each detector fires on a planted defect and stays silent on a clean entry:

```ts
it("reports role collapse, accent disagreement and fabricated hex", () => {
  const entries = [
    // canvas === ink: text the same colour as its background
    synthetic({ id: "bad-roles", visual: { colorRoles: { canvas: "#403c44", surface: "#808080", ink: "#403c44", muted: "#808080", accent: "#d25859" } } }),
    // the two accent fields disagree
    synthetic({ id: "bad-accent", visual: { accentColor: "#403c44", colorRoles: { canvas: "#fff", surface: "#fff", ink: "#111", muted: "#666", accent: "#d25859" } } }),
    // critique cites a hex present in no colour field
    synthetic({ id: "bad-hex", critique: "The deep plum-gray #90b5e8 canvas reduces eye strain across long sessions.", visual: { accentColor: "#2563eb", colorRoles: { canvas: "#fff", surface: "#fff", ink: "#111", muted: "#666", accent: "#2563eb" } } }),
  ];
  const findings = runCorpusHealthChecks(entries);
  expect(findings.map((f) => f.id)).toEqual(
    expect.arrayContaining(["bad-roles", "bad-accent", "bad-hex"]),
  );
});

it("reports a verified entry whose image file is missing", () => {
  // The serve-path gate is pure and cannot see this; doctor.ts owns it.
  const entries = [synthetic({
    id: "verified-no-image",
    image: { visibility: "private", path: "images-private/definitely-absent.png", width: 10, height: 10 },
    provenance: { taggedBy: "auto", verification: { method: "image-confirmed", verifiedAt: "2026-08-04", verifierVersion: "v1", imageSha256: "a".repeat(64) } },
  })];
  const findings = runCorpusHealthChecks(entries);
  expect(findings.some((f) => f.id === "verified-no-image" && /image/i.test(f.message))).toBe(true);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/scripts/doctor.test.ts`
Expected: FAIL — `runCorpusHealthChecks` is not defined.

- [ ] **Step 4: Implement the eight detectors**

Add them following the existing check shape. The eight, with the counts they produced on the real corpus so a future run can be compared:

| detector | real-corpus count |
|---|---|
| role collapse across `canvas`/`surface`/`ink`/`muted`/`accent` pairs (excluding the legitimate `canvas`==`surface`) | 81 |
| `ink`-on-`canvas` contrast below 3:1 | 65 |
| critique cites a hex absent from every colour field | 65 |
| `accentColor` ≠ `colorRoles.accent` | 27 |
| rail region (`primary-nav` / `detail-rail`) on a portrait or mobile entry | 90 |
| monospace claimed in prose with no mono face recorded | 25 |
| `soft-neumorphic` styleTag with `usesShadows: false` | 24 |
| unassessed quality defaults (`qualityScore: 3` + `qualityTier: "exceptional"` + not `auto-reviewed`) | 725 |

Plus the two the trust gate deliberately omits from the serve path: a verified entry whose image file is missing, and a verified `image-confirmed` entry whose `imageSha256` no longer matches the bytes on disk (reuse the `createHash("sha256")` approach from `dedup.ts:112`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/scripts/doctor.test.ts && npx tsc --noEmit`
Expected: PASS. `tsc` clean.

- [ ] **Step 6: Run against the real corpus and compare to the recorded counts**

Run: `npm run build && node dist/scripts/doctor.js 2>&1 | tail -40`
Expected: the counts in the table above, ±small drift. A large divergence means a detector is mis-implemented; investigate before committing.

- [ ] **Step 7: Commit**

```bash
git add src/scripts/doctor.ts src/scripts/doctor.test.ts
git commit -m "feat(doctor): standing corpus health checks for the eight defect classes"
```

---

## Task 6: Whole-change verification and TODOS reconciliation

**Files:**
- Modify: `TODOS.md`

- [ ] **Step 1: Remove the TODO this change's predecessor already closed**

`TODOS.md` → "C3 Phase 1: cap the synthesized direction length" describes work already implemented in `2ab7ffe` (budget plus per-signal caps, drop-whole, measured). Delete the section. A stale TODO invites the work twice.

- [ ] **Step 2: Update the governance TODO that this change satisfies**

`TODOS.md` → "Provenance governance flip (serve signed prose)" stated the bar that Phase 1 bypassed. Rewrite it to point at the shipped gate and at the Stage 2 verifier as the thing that lets entries pass it, so the next reader does not re-derive the human-signature framing this spec replaced.

- [ ] **Step 3: Run every CI step locally**

```bash
npx tsc --noEmit
npm run build
npm test
npm run validate-corpus
npm run validate-references
npm run test:critique-quality
npm run site:test
npm run site:build
npm run site:test:browser
npm run site:test:browser:production
node scripts/check-site-budget.mjs
```
Expected: all green. The site browser suites assert served content, so a failure there means the gate changed the playground's rendered output — update those assertions to the gated posture in this task rather than leaving CI red.

- [ ] **Step 4: Verify the day-one claim end to end**

Run:
```bash
node -e 'const {readFileSync}=require("fs");const j=JSON.parse(readFileSync("corpus/entries.json","utf8"));const E=Array.isArray(j)?j:(j.entries||[]);console.log("verified entries:",E.filter(e=>e.provenance&&e.provenance.verification).length);'
```
Expected: `verified entries: 0`. Then run the dogfood script and confirm the served body carries no corpus prose and every gated field has a reason row:

Run: `node scripts/dogfood-createuispec.mjs 2>&1 | tail -30`
Expected: a direction with no `evidence-N` citation, empty `techniques` / `antiPatterns`, null `colorTokens`, and the `insufficientCorpusEvidence` warning present.

- [ ] **Step 5: Write the branch review artifact and commit**

```bash
.zcode/scripts/write-review-artifact --type branch --result approved --reviewer agent \
  --base-sha $(git merge-base origin/main HEAD) --head-sha $(git rev-parse HEAD) \
  --branch $(git branch --show-current)
git add TODOS.md
git commit -m "docs(todos): reconcile the direction-cap and governance-flip entries with the shipped gate"
```

---

## Self-review

**Spec coverage.** Predicate and `verification` schema → Task 1. Single-site filter, `trustedEvidenceIds` bridge, trusted-contributor thresholds, vote-flip behaviour, and the model lane's prompt-grounding filter (review finding D1) → Task 2. Five reason rows, `colorTokenAuthority` revert (tested, not implemented — existing code already derives it), stale docblock → Task 3. Disclosure with the leaf-classification constraint resolved and recorded → Task 4. Detectors, report-only boundary, plus the two checks the pure gate omits → Task 5. No feature flag: nowhere in the plan. Regression suites updated in the same task that breaks them: Task 2 Step 6, Task 6 Step 3.

**Two spec items intentionally NOT implemented here**, both listed in the spec as out of scope: write-time `verification` invalidation on image replacement belongs to the capture path (Stage 3 owns `domSignals` and touches the same code), and `evidence[]` "marked untrusted" is satisfied without new code — no `citedDecision` cites the corpus lane once `synthesis` is empty, which Task 3 Step 1 asserts directly.

**Placeholder scan.** No TBDs. Every code step carries the code; every run step carries the command and expected output. Task 5 Step 1 reads the existing check shape before writing rather than inventing a convention, and Step 4 gives the eight detectors with their real-corpus counts as the acceptance target.

**Type consistency.** `isVerified(entry: CorpusEntryT): boolean` in Task 1 is the signature used in Tasks 2, 4 and 5. `VERIFICATION_METHODS` is `ReadonlySet<string>` in both Task 1 and Task 5. The `verification` record's four fields match the Zod schema in Task 1 Step 4, the test fixtures in Tasks 1/2/5, and the spec. `createUiSpecDeterministic` keeps its four-parameter signature, so no caller in Task 3 or 4 changes.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | CLEAR | HOLD_SCOPE, prior |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | blocked | subagent dispatch broken in this environment |
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 5 findings, all folded |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | — | — |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | — | — |

**CODEX:** requesting-code-review was invoked for prior reviews; subagent dispatch is empirically broken in this environment (five consecutive spawn attempts returned generic greetings), so this review's independent pass was performed inline with fresh code verification.

**VERDICT:** ENG CLEARED — ready to implement. Review of `2026-08-04-corpus-trust-gate.md` against the design spec and the current tree (2026-08-04). Every load-bearing claim verified against the repo: tagger blindness (`tagger.ts:3026`), the `auto-reviewed` machine stamp (`ui/app.js:1375`/`:1488`, `classic-app.js:635`), the stale `create-ui-spec.ts:12` docblock, the four-parameter `createUiSpecDeterministic` shape, `ResolvedEvidence.matchedEntries`, the `insufficientCorpusEvidence` warning code, and the corpus defect counts (contrast 65 and accent mismatch 27 reproduced exactly). Five findings folded with the user's approval:
1. [P1] D1 — the model lane's prompt grounding was ungated (prompt built from `resolved.sanitized` before the synthesizer filter); added Task 2 Step 3b filtering the model input to trusted evidence ids, with a prompt-content test.
2. [P2] D2 — Task 4's recorded decision claimed new numeric fields need leaf classification; the leaf gate walks string leaves only, so the rationale was corrected (strict Zod schema is the real constraint).
3. [P2] D3 — the five trust reason rows were conditioned on `synthesis` being non-null and never fired on the model path; now conditioned on the served field being empty.
4. [P3] D4 — `trustedEvidenceIdsOf` centralized in `corpus-trust.ts` with one unit test (imports reconciled at both call sites).
5. [P3] D6 — trust-disclosure tests extended to the partial (N of M) and all-verified cases.

**Not implemented (deliberate):** write-time verification invalidation (Stage 3 owns the capture path), per-row `evidence[]` untrusted marking (satisfied by no corpus-lane citedDecision), verification-recency enforcement (doctor/Stage 2 concern).

NO UNRESOLVED DECISIONS
