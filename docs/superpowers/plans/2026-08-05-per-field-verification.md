# Per-Field Verification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct Stage 1's entry-level trust record into a per-field map, so a verified colour claim un-gates only colour and never the unverifiable prose beside it.

**Architecture:** `provenance.verification` becomes `{ [fieldKey]: { method, verifiedAt, verifierVersion, imageSha256? } }` with the unchanged fail-closed per-record shape. `isVerified(entry, field)` gains a required field parameter; `verifiedFields(entry)` returns the valid key set. `createUiSpecDeterministic` replaces its one trusted-list shadow with per-field selectors (`verifiedFor(field)`, `observationsFor(field)`), the evidence projection strips each row per field, `TrustGatedCorpusReader` gates on a per-tool field set declared at wiring time in `createServer`, keyless fields are redacted at render, and the doctor + disclosure counts become per key.

**Tech Stack:** TypeScript, Zod 4, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-05-per-field-verification-design.md`

## Global Constraints

- **Governing invariant:** a corpus-derived VALUE is servable only when it is grounded in evidence that can be checked. The operative word is value, not entry — an entry is a bag of claims with different evidence available for each.
- **Fail-closed per field.** No provenance, no record under the key, an unrecognised method, or an `image-confirmed` record missing `imageSha256` all read **not verified for that field**. An unknown map key reads as not verified (never an error — readability and trust are different questions).
- **No wildcard key and no "all" key.** A verifier that wants to attest to ten fields writes ten records.
- **`isVerified` requires a field parameter.** A call site that cannot name its field has not understood what it gates. No optional "any field" default.
- **Thresholds count field-verified entries, never any-verified ones.** The three-contributor `colorTokens` guard counts entries verified for `visual.colorRoles` specifically.
- **Per-tool field sets are the contract between verifier and gate.** Each registration in `createServer` uses exactly the keys of the fields that tool renders — never wider (over-gating) and never narrower (over-serving).
- **Keyless fields never render:** identity (`source.productName`, `source.url`, entry `id`, `title`), editorial prose (`businessRationale`, `antiPatterns.whereThisFails`), editorial judgment (`qualityScore`, `qualityTier`). A tool that passes the gate renders keyed content only; a verified-content entry must not leak any of these in served bytes.
- **Public mode redacts too.** The MCP serving surface is gated identically in both modes; the invariant does not branch on mode.
- **No feature flag.** Rollback is `git revert`.
- **`corpusEntries` stays ungated** in `createUiSpecDeterministic` — it feeds `buildDeniedNames` and must stay corpus-wide.
- **Fixtures unverified by default**, matching production; serving tests opt in per field. Schema tests parse through real Zod, never `as unknown as CorpusEntryT`. No test asserts record presence alone.
- **Mutation bar:** patching `isVerified` to `return true` must fail **strictly more than 51 tests** — the measured Stage 1 baseline at `c6b73ba` is exactly 51, so `≥ 51` would let a refactor that retires one mutation-killed test pass the gate on bookkeeping. The per-field cross-field tests, per-tool both-directions tests, redaction tests, and doctor per-key tests added by this plan are all mutation-killed; if the count ever lands at exactly 51, a test that used to die under the mutation was retired — investigate before committing.
- **Existing suites that assert the current served posture are updated in the same task that changes it**, never in a follow-up.
- TDD: failing test first, minimal implementation, passing test, commit. Write a review artifact before each push (see `CLAUDE.md`):
  ```bash
  .zcode/scripts/write-review-artifact --type task --result approved --reviewer agent \
    --base-sha <parent-sha> --head-sha <task-commit-sha> --branch <branch>
  ```

---

## File Structure

| File | Responsibility |
|---|---|
| `src/corpus-trust.ts` | **Modify.** `isVerified(entry, field)`, `verifiedFields(entry)`, `trustedEvidenceIdsOf(entries, field)` (Task 2), `SERVABLE_FIELD_KEYS`. |
| `src/schema.ts` | **Modify** (`provenance.verification`, ~`:624`). The single record becomes a record map. |
| `src/corpus-trust.test.ts` | **Rewrite.** Per-field predicate rows, `verifiedFields`, forward compatibility through real Zod. |
| `src/create-ui-spec-deterministic.ts` | **Modify.** One trusted list → per-field selectors; direction clause id tracking; precise palette/direction evidence ids. |
| `src/create-ui-spec-deterministic.test.ts` | **Modify.** Cross-field case, per-field both-directions table, refusal semantics. |
| `src/create-ui-spec.ts` | **Modify.** `sanitizeCorpusObservation` per-field strip + null return; row-drop at the call site; model-lane filter superseded; per-field disclosure (`:1108`, `:1500`); precise citedDecisions for palette/direction. |
| `src/create-ui-spec.test.ts`, `src/create-ui-spec-model-path.test.ts` | **Modify.** Per-field fixtures; strip + disclosure assertions. |
| `src/corpus-trust-reader.ts` | **Modify.** Constructor gains a field set; every method gates on the set. |
| `src/corpus-trust-reader.test.ts` | **Modify.** Field-set semantics, empty-set guard, per-field taxonomy, per-field posture. |
| `src/server-factory.ts` | **Modify.** Per-tool `TrustGatedCorpusReader` constructions in `createServer`; posture messages name the field set; keyless render redactions; `get_ui_example` image gate + description. |
| `src/tool-trust-gate.test.ts` | **Modify.** Per-field fixtures; both-directions per tool; keyless redaction per tool. |
| `src/recommend.ts`, `src/design-prompt.ts` | **Modify.** Keyless redaction on the recommend render + brief render. |
| `src/critique-retrieval.ts`, `src/synthesis/context.ts` | **Modify.** `CritiqueEntry` projection drops id/title/reviewStatus; corpus evidence labels rebuild from keyed fields. |
| `src/scripts/doctor-helpers.ts`, `src/scripts/doctor.test.ts` | **Modify.** Per-key iteration; `verification-orphan-key` detector; `unassessed-quality` via `verifiedFields`. |
| `src/full-corpus-leak-sweep.test.ts`, `src/public-mcp-contract.test.ts` | **Modify.** Fixtures stamp per-field records; leak-sweep canary iterates `SERVABLE_FIELD_KEYS`. |

---

## Task 1: The record becomes a map; the predicate becomes field-required

**Files:**
- Modify: `src/schema.ts` (the `verification` field, ~`:600-636`)
- Modify: `src/corpus-trust.ts`
- Rewrite: `src/corpus-trust.test.ts`
- Modify (mechanical, behavior-preserving): `src/corpus-trust-reader.ts`, `src/create-ui-spec-deterministic.ts`, `src/create-ui-spec.ts` (`:1108`, `:1500`), `src/scripts/doctor-helpers.ts` (`:521-563`), and the verification fixtures in `src/create-ui-spec-deterministic.test.ts`, `src/create-ui-spec.test.ts`, `src/create-ui-spec-model-path.test.ts`, `src/corpus-trust-reader.test.ts`, `src/tool-trust-gate.test.ts`, `src/scripts/doctor.test.ts`, `src/public-mcp-contract.test.ts`, `src/full-corpus-leak-sweep.test.ts`

**Interfaces:**
- Consumes: `CorpusEntryT` from `./schema.js`.
- Produces: `isVerified(entry: CorpusEntryT, field: string): boolean`, `verifiedFields(entry: CorpusEntryT): ReadonlySet<string>`, `VERIFICATION_METHODS: ReadonlySet<string>`, `SERVABLE_FIELD_KEYS: ReadonlySet<string>`. `trustedEvidenceIdsOf` keeps its Stage 1 any-field signature in this task; Task 2 adds the required field parameter when its consumers switch to per-field.

- [ ] **Step 1: Write the failing predicate tests**

Rewrite `src/corpus-trust.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isVerified, verifiedFields, trustedEvidenceIdsOf } from "./corpus-trust.js";
import { CorpusEntry, type CorpusEntryT } from "./schema.js";

/** A minimal entry. Only `provenance` matters to the predicate. */
function entry(verification?: Record<string, unknown>): CorpusEntryT {
  return {
    id: "e1",
    provenance: verification === undefined
      ? { taggedBy: "auto" }
      : { taggedBy: "auto", verification },
  } as unknown as CorpusEntryT;
}

const VALID = {
  method: "image-confirmed",
  verifiedAt: "2026-08-04",
  verifierVersion: "verifier-v1",
  imageSha256: "a".repeat(64),
};

describe("isVerified — per-field, fail-closed", () => {
  it("verifies only the field the record names", () => {
    const e = entry({ "visual.colorRoles": VALID });
    expect(isVerified(e, "visual.colorRoles")).toBe(true);
    expect(isVerified(e, "critique")).toBe(false);
    expect(isVerified(e, "whatToSteal")).toBe(false);
  });

  it("verifies measured and provable records with no imageSha256", () => {
    for (const method of ["measured", "provable"]) {
      const e = entry({ critique: { method, verifiedAt: "2026-08-04", verifierVersion: "v1" } });
      expect(isVerified(e, "critique"), method).toBe(true);
    }
  });

  it("refuses an entry with no verification record", () => {
    expect(isVerified(entry(), "critique")).toBe(false);
  });

  it("refuses an unrecognised method (a newer verifier's tier)", () => {
    const e = entry({ critique: { ...VALID, method: "vibes-confirmed" } });
    expect(isVerified(e, "critique")).toBe(false);
  });

  it("refuses image-confirmed with no imageSha256 — malformed record", () => {
    const { imageSha256: _drop, ...noHash } = VALID;
    const e = entry({ critique: noHash });
    expect(isVerified(e, "critique")).toBe(false);
  });

  it("never consults taggedBy or reviewStatus", () => {
    for (const taggedBy of ["auto", "auto-reviewed", "human"]) {
      const e = {
        id: "e1",
        provenance: { taggedBy, reviewedBy: "someone", verification: { critique: VALID } },
      } as unknown as CorpusEntryT;
      expect(isVerified(e, "critique"), taggedBy).toBe(true);
    }
  });

  it("performs no I/O — a bogus image path changes nothing", () => {
    const e = {
      id: "e1",
      image: { path: "images-private/gone.png" },
      provenance: { taggedBy: "auto", verification: { critique: VALID } },
    };
    expect(isVerified(e as unknown as CorpusEntryT, "critique")).toBe(true);
  });
});

describe("verifiedFields", () => {
  it("returns exactly the valid keys", () => {
    const e = entry({
      "visual.colorRoles": VALID,
      critique: { ...VALID, method: "measured" },
      layout: { ...VALID, method: "vibes-confirmed" }, // invalid method
    });
    expect([...verifiedFields(e)].sort()).toEqual(["critique", "visual.colorRoles"]);
  });

  it("returns an empty set when nothing is verified", () => {
    expect([...verifiedFields(entry())]).toEqual([]);
  });
});

describe("trustedEvidenceIdsOf — Stage 1 any-field bridge (field param lands in Task 2)", () => {
  it("returns only entries with at least one valid record", () => {
    const pairs = [
      { evidenceId: "evidence-2", entry: entry({ critique: VALID }) },
      { evidenceId: "evidence-3", entry: entry() },
      { evidenceId: "evidence-4", entry: entry({ "visual.colorRoles": { ...VALID, method: "measured" } }) },
    ];
    expect(trustedEvidenceIdsOf(pairs)).toEqual(new Set(["evidence-2", "evidence-4"]));
  });
});

// ---------------------------------------------------------------------------
// Forward compatibility THROUGH Zod (review round)
// ---------------------------------------------------------------------------
describe("provenance.verification map — forward compatibility through the schema", () => {
  const base = {
    id: "schema-entry",
    title: "Example — dashboard",
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    source: { productName: "Example", url: "https://example.com", capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "images-private/e.png", width: 1440, height: 900 },
    visual: {
      dominantColors: ["#ffffff", "#111111"],
      accentColor: "#2563eb",
      typePairing: { display: "Inter", body: "Inter" },
      spacingDensity: "moderate", cornerStyle: "slight-round",
      usesShadows: false, usesBorders: true,
    },
    critique: "This example uses restrained contrast and quiet borders to keep a dense layout readable without decorative noise.",
    whatToSteal: ["Use low-contrast borders to separate dense regions."],
    antiPatterns: { antiPatterns: ["Avoids drop shadows."], whereThisFails: [], accessibilityRisks: [] },
    qualityTier: "exceptional", qualityScore: 4, reviewStatus: "approved", addedAt: "2026-07-01",
  };

  function parse(verification: unknown) {
    return CorpusEntry.safeParse({ ...base, provenance: { taggedBy: "auto", verification } });
  }

  it("accepts and verifies a per-field map this build knows", () => {
    const r = parse({ critique: { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" } });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!, "critique")).toBe(true);
    expect(isVerified(r.data!, "whatToSteal")).toBe(false);
  });

  it("LOADS a tier a newer verifier introduces, then refuses it per field", () => {
    const r = parse({ critique: { method: "dom-measured", verifiedAt: "2026-08-04", verifierVersion: "v9" } });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!, "critique")).toBe(false);
  });

  it("LOADS an unknown map key, then reads it as not verified", () => {
    const r = parse({ "visual.vibes": { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v9" } });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!, "visual.vibes")).toBe(false);
  });

  it("LOADS a record carrying an unknown field, then judges it on method alone", () => {
    const r = parse({ critique: { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v9", confidence: 0.9 } });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!, "critique")).toBe(true);
  });

  it("still refuses image-confirmed with no hash after a real parse", () => {
    const r = parse({ critique: { method: "image-confirmed", verifiedAt: "2026-08-04", verifierVersion: "v1" } });
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
    expect(isVerified(r.data!, "critique")).toBe(false);
  });

  it("still rejects a malformed imageSha256 at the schema, where shape is checked", () => {
    const r = parse({ critique: { method: "image-confirmed", verifiedAt: "2026-08-04", verifierVersion: "v1", imageSha256: "nope" } });
    expect(r.success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the predicate tests to verify they fail**

Run: `npx vitest run src/corpus-trust.test.ts`
Expected: type errors / failures — `isVerified` takes one argument today, the schema is not a map, and `verifiedFields` does not exist.

- [ ] **Step 3: Implement the schema map and the new predicate**

In `src/schema.ts`, replace ONLY the verification field — the block from the line `    verification: z.object({` through the line `    }).passthrough().optional(),` — with the following. The lines after the field (`  }).optional(),`, the closing `})` of `CorpusEntry`, and the `qualityScore ↔ qualityTier` `.refine()` at `:632-638`) are OUTSIDE the replaced region and must stay untouched:

```ts
    /**
     * HOW this entry's values were checked, as opposed to who touched them.
     * Absent on every entry that predates the trust gate, which is why the gate
     * is fail-closed: absent means not verified.
     *
     * Stage 2a corrected the Stage 1 shape: this is now a MAP from corpus field
     * key (`visual.colorRoles`, `critique`, …) to that field's own record. An
     * entry is not a unit of truth — it is a bag of claims with different
     * evidence available for each — so verification attaches where the claim
     * is. There is no wildcard key and no "all" key: a verifier that wants to
     * attest to ten fields writes ten records.
     *
     * The per-record shape is unchanged from Stage 1. `imageSha256` binds an
     * image-confirmed record to the exact bytes the verifier saw; it is
     * REQUIRED when `method` is "image-confirmed" and omitted for `measured`.
     *
     * The consequence of getting the shape wrong differs by mode, and both are
     * bad: PUBLIC mode throws (`corpus-reader.ts:332` raises on a failed parse,
     * so one unreadable record makes the whole corpus unavailable). PRIVATE
     * mode, the default, is worse and quieter — a schema-invalid corpus decodes
     * as `corrupt`, which `fromDecodeResult` maps to `null`
     * (`persistence.ts:137-139`), and the caller silently falls back to a
     * snapshot or the seed. An older build reading a newer corpus would not
     * error; it would serve stale data and say nothing.
     *
     * `method` is a plain string and unknown values pass through
     * (`passthrough`), ON PURPOSE: the accepted tiers live in
     * `corpus-trust.ts`'s VERIFICATION_METHODS, the sole authority on whether
     * a record grants trust. A `z.enum` here would defeat the forward
     * compatibility the gate documents: `corpus-reader.ts:332` THROWS on a
     * failed parse, so a corpus written by a newer verifier — one extra tier,
     * or one extra field like `confidence` — would make an older build refuse
     * the ENTIRE corpus rather than decline the rows it does not understand.
     * Readability and trust are different questions; only the second is
     * fail-closed. The map's KEYS are open by construction, so an unknown key
     * reads as NOT VERIFIED rather than as an error — the fail-closed
     * predicate gives that for free.
     */
    verification: z.record(z.string(), z.object({
      method: z.string().min(1),
      verifiedAt: z.string().min(1),
      verifierVersion: z.string().min(1),
      imageSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    }).passthrough()).optional(),
```

Replace the body of `src/corpus-trust.ts` with:

```ts
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
 * The corpus field keys the gate knows how to serve. This is the contract
 * between the verifier (Stage 2b/2c) and the gate: every served field must be
 * reachable through exactly one key, and a key names a claim a verifier can
 * check. Keys are corpus field paths (`visual.colorRoles`, `critique`, …). A
 * record written under any other key is a silent no-op; `doctor.ts` reports it
 * as `verification-orphan-key`.
 */
export const SERVABLE_FIELD_KEYS: ReadonlySet<string> = new Set([
  "visual.colorRoles",
  "visual.accentColor",
  "visual.dominantColors",
  "visual.spacingDensity",
  "visual.cornerStyle",
  "visual.usesShadows",
  "visual.usesBorders",
  "visual.typePairing",
  "layout",
  "critique",
  "whatToSteal",
  "antiPatterns",
  "antiPatterns.accessibilityRisks",
  "voice",
  "components",
  "responsiveBehavior",
  "patternType",
  "platform",
  "styleTags",
  "categories",
  "mood",
  "colorScheme",
  "domainTags",
]);

/**
 * True when the entry carries a verification record for THIS field that this
 * build understands. The field parameter is REQUIRED: every call site must
 * state which claim it is asking about, and a site that cannot name its field
 * has not understood what it gates.
 *
 * Fail-closed on every other input: no provenance, no record under the key, an
 * unrecognised method, or an `image-confirmed` record missing the image hash
 * that binds it to the bytes the verifier saw.
 */
export function isVerified(entry: CorpusEntryT, field: string): boolean {
  const record = entry.provenance?.verification?.[field];
  if (!record) return false;
  if (!VERIFICATION_METHODS.has(record.method)) return false;
  // `imageSha256` is optional on the type and mandatory by method: the measured
  // tier's evidence is the live DOM, not the pixels, so binding it to an image
  // hash would tie the record to the wrong artifact.
  if (record.method === "image-confirmed" && !record.imageSha256) return false;
  return true;
}

/**
 * The set of fields the entry is verified for. For the sites that need the set
 * rather than a single answer: the per-tool field-set wiring in `createServer`,
 * doctor's per-key reporting, and the `unassessed-quality` exemption.
 */
export function verifiedFields(entry: CorpusEntryT): ReadonlySet<string> {
  const verification = entry.provenance?.verification;
  if (!verification) return new Set();
  return new Set(Object.keys(verification).filter((field) => isVerified(entry, field)));
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
  return new Set(
    matchedEntries.filter((m) => verifiedFields(m.entry).size > 0).map((m) => m.evidenceId),
  );
}
```

- [ ] **Step 4: Run the predicate tests to verify they pass**

Run: `npx vitest run src/corpus-trust.test.ts`
Expected: PASS.

- [ ] **Step 5: Migrate every other `isVerified` caller to the field-required API (behavior-preserving)**

Every site below switches from "verified at all" to `verifiedFields(entry).size > 0` — exactly the Stage 1 semantics, now spelled through the map. Task 2+ refines each site to its actual field.

`src/corpus-trust-reader.ts` — change the import to `import { verifiedFields } from "./corpus-trust.js";` and replace every `isVerified(X)` with `verifiedFields(X).size > 0`. The call sites are `search`, `searchRanked`, `getById`, `findSimilar`, `entriesForAggregation`, `getImageIndex`, `refusedForTrust`, `trustPosture`, `listCategories`, `listStyleTags`, `listDomainTags`.

`src/create-ui-spec-deterministic.ts` — change the import to add `verifiedFields` and replace the shadow filter:

```ts
  const matchedEntries = allMatchedEntries.filter((m) => verifiedFields(m.entry).size > 0);
```

`src/create-ui-spec.ts` — change the import to `import { isVerified, verifiedFields, trustedEvidenceIdsOf } from "./corpus-trust.js";` and replace both disclosure counts:

```ts
  const verifiedForReason = resolved.matchedEntries.filter((m) => verifiedFields(m.entry).size > 0).length;
```

and

```ts
  const verifiedCount = resolved.matchedEntries.filter((m) => verifiedFields(m.entry).size > 0).length;
```

The model-lane filter at `:274` keeps `trustedEvidenceIdsOf(resolved.matchedEntries)` unchanged in this task.

`src/scripts/doctor-helpers.ts` — change the import to add `verifiedFields` and replace the block below — from the line `    // Keyed on \`isVerified\`, not on the mere PRESENCE of a record: a malformed` through the closing `    }` of the `else if (verification && isVerified(entry)) {` block (the entire unassessed-quality exemption plus the verification-integrity section; the entry-loop's closing `  }` and `return findings;` after it stay) — with this interim (per-key iteration lands in Task 9):

Before (the exact region to replace — note it is one complete unit, comment through closing brace):

```ts
    // Keyed on `isVerified`, not on the mere PRESENCE of a record: a malformed
    // record would otherwise exempt the entry here while `verification-malformed`
    // fires below, so a Stage 2 verifier writing a bad record would silence the
    // quality signal — the same predicate divergence fixed for the image checks.
    if (entry.qualityScore === 3 && entry.qualityTier === "exceptional"
      && !isVerified(entry)) {
      push("unassessed-quality", `qualityScore 3 + tier "exceptional" with no verification record — never assessed`);
    }

    // ── Verification integrity. The serve-path gate is PURE and cannot see
    // any of these three; doctor.ts owns them. Both apply only to entries that
    // actually carry a verification record.
    // Keyed on `isVerified`, the SAME predicate the serve path uses. An earlier
    // version used a bare `if (verification)`, which accepted records the gate
    // refuses: it would report "verified entry's image is missing" about an entry
    // that is not verified (a false statement), and a malformed record produced
    // no finding at all — so a Stage 2 verifier writing a bad record would get
    // silence instead of a signal that its entries were being refused.
    const verification = entry.provenance?.verification;
    if (verification && !isVerified(entry)) {
      const why = !VERIFICATION_METHODS.has(verification.method)
        ? `method "${verification.method}" is not one this build accepts (${[...VERIFICATION_METHODS].join(", ")})`
        : `method "image-confirmed" requires imageSha256, which is absent`;
      push("verification-malformed", `verification record present but refused by the trust gate: ${why}`);
    } else if (verification && isVerified(entry)) {
      const path = typeof image.path === "string" ? image.path : null;
      // `imageExists`/`imageSha256` reach the filesystem through
      // `fromCorpusRelativeImagePath`, which THROWS on any path outside
      // images-*/ (paths.ts:132). A malformed path must produce a finding, not
      // abort the whole `npm run doctor` run.
      const exists = ((): boolean => {
        if (path === null) return false;
        try { return ctx.imageExists(path); } catch { return false; }
      })();
      if (!exists) {
        push("verified-image-missing", `verified entry's image is missing or unresolvable: ${path ?? "(no path)"}`);
      } else if (verification.method === "image-confirmed" && verification.imageSha256) {
        const actual = ((): string | null => {
          try { return ctx.imageSha256(path!); } catch { return null; }
        })();
        if (actual !== null && actual !== verification.imageSha256) {
          push(
            "verified-hash-stale",
            `verification records ${verification.imageSha256.slice(0, 12)}… but ${path} now hashes to ${actual.slice(0, 12)}…`,
          );
        }
      }
    }
```

After:

```ts
    // Keyed on `verifiedFields`, not on the mere PRESENCE of a record: a
    // malformed record would otherwise exempt the entry here while
    // `verification-malformed` fires below.
    if (entry.qualityScore === 3 && entry.qualityTier === "exceptional"
      && verifiedFields(entry).size === 0) {
      push("unassessed-quality", `qualityScore 3 + tier "exceptional" with no verification record — never assessed`);
    }

    const verification = entry.provenance?.verification;
    const validKeys = verifiedFields(entry);
    if (verification && validKeys.size === 0) {
      push("verification-malformed", `verification record present but refused by the trust gate`);
    } else if (verification && validKeys.size > 0) {
      const path = typeof image.path === "string" ? image.path : null;
      const exists = ((): boolean => {
        if (path === null) return false;
        try { return ctx.imageExists(path); } catch { return false; }
      })();
      if (!exists) {
        push("verified-image-missing", `verified entry's image is missing or unresolvable: ${path ?? "(no path)"}`);
      } else {
        const imageConfirmed = Object.values(verification).find(
          (record) => record.method === "image-confirmed" && record.imageSha256,
        );
        if (imageConfirmed) {
          const actual = ((): string | null => {
            try { return ctx.imageSha256(path!); } catch { return null; }
          })();
          if (actual !== null && actual !== imageConfirmed.imageSha256) {
            push(
              "verified-hash-stale",
              `verification records ${imageConfirmed.imageSha256.slice(0, 12)}… but ${path} now hashes to ${actual.slice(0, 12)}…`,
            );
          }
        }
      }
    }
```

`src/full-corpus-leak-sweep.test.ts` — change the import to `import { isVerified, verifiedFields, SERVABLE_FIELD_KEYS } from "./corpus-trust.js";`, make `asVerified` stamp every servable key, and make the canary iterate the set:

```ts
function asVerified(entries: readonly CorpusEntryT[]): CorpusEntryT[] {
  const record = {
    method: "image-confirmed" as const,
    verifiedAt: "2026-08-04",
    verifierVersion: "leak-sweep-fixture",
    imageSha256: "a".repeat(64),
  };
  const verification: Record<string, typeof record> = {};
  for (const key of SERVABLE_FIELD_KEYS) verification[key] = record;
  const stamped = entries.map((e) => ({
    ...e,
    provenance: {
      ...(e.provenance ?? { taggedBy: "auto" as const }),
      verification,
    },
  }));
  for (const e of stamped) {
    for (const key of SERVABLE_FIELD_KEYS) {
      if (!isVerified(e, key)) {
        throw new Error(
          `asVerified produced a record the trust gate refuses for ${key} — the sweep would `
          + "pass vacuously. Reconcile the fixture with VERIFICATION_METHODS.",
        );
      }
    }
  }
  return stamped;
}
```

- [ ] **Step 6: Migrate the verification fixtures to map shapes**

Every fixture that stamped `verification: { method, verifiedAt, verifierVersion, imageSha256 }` (a single record) now stamps a per-key map. Use this helper shape everywhere (module-local copies are fine):

```ts
function allKeysVerified(): Record<string, { method: string; verifiedAt: string; verifierVersion: string; imageSha256: string }> {
  const record = {
    method: "image-confirmed",
    verifiedAt: "2026-08-04",
    verifierVersion: "fixture-v1",
    imageSha256: "a".repeat(64),
  };
  const map: Record<string, typeof record> = {};
  for (const key of ["visual.colorRoles", "visual.accentColor", "visual.dominantColors",
    "visual.spacingDensity", "visual.cornerStyle", "visual.usesShadows", "visual.usesBorders",
    "visual.typePairing", "layout", "critique", "whatToSteal", "antiPatterns",
    "antiPatterns.accessibilityRisks", "voice", "components", "responsiveBehavior",
    "patternType", "platform", "styleTags", "categories", "mood", "colorScheme", "domainTags"]) {
    map[key] = record;
  }
  return map;
}
```

Apply it at these exact sites:
- `src/create-ui-spec-deterministic.test.ts`: the `VERIFIED` const (replace `verification: { ... }` with `verification: allKeysVerified()`) and `verifiedProseEntry` (`:596`).
- `src/create-ui-spec.test.ts`: the `verify()` helper (`:1712`) — replace the single record with `verification: allKeysVerified()`.
- `src/create-ui-spec-model-path.test.ts`: `gateEntry` and `rankedCorpusReader`'s inline `provenance` — same replacement.
- `src/corpus-trust-reader.test.ts`: the `VERIFICATION` const becomes `verification: allKeysVerified()` inside `entry()` when `verified` is true.
- `src/tool-trust-gate.test.ts`: the `entry(verified)` spread — same replacement.
- `src/scripts/doctor.test.ts`: the `VERIFICATION` const usage in `provenance` objects becomes `verification: { "whatToSteal": VERIFICATION }` (a single valid key is enough for the doctor's any-field checks in this task); malformed fixtures become `{ "whatToSteal": { ...VERIFICATION, method: "vibes-confirmed" } }` and `{ "whatToSteal": { method: "image-confirmed", verifiedAt: "2026-08-04", verifierVersion: "v1" } }`.
- `src/public-mcp-contract.test.ts`: `baseEntry`'s `verification` — replace with `allKeysVerified()`.

- [ ] **Step 7: Run the affected suites to verify behavior is preserved**

Run:
```bash
npx vitest run src/corpus-trust.test.ts src/corpus-trust-reader.test.ts src/create-ui-spec-deterministic.test.ts src/create-ui-spec.test.ts src/create-ui-spec-model-path.test.ts src/tool-trust-gate.test.ts src/scripts/doctor.test.ts src/public-mcp-contract.test.ts src/full-corpus-leak-sweep.test.ts
```
Expected: all PASS. The day-one posture (zero records anywhere) is byte-identical — this task only reshapes how a record is read.

- [ ] **Step 8: Run tsc and the wiring check**

Run: `npx tsc`
Run: `npx vitest run src/wiring-verification.test.ts src/full-corpus-leak-sweep.test.ts`
Expected: clean compile; `trustedEvidenceIdsOf` still referenced by `src/create-ui-spec.ts` and `src/create-ui-spec-deterministic.ts`, so the wiring check stays green.

- [ ] **Step 9: Commit**

```bash
git add src/schema.ts src/corpus-trust.ts src/corpus-trust.test.ts src/corpus-trust-reader.ts src/create-ui-spec-deterministic.ts src/create-ui-spec.ts src/scripts/doctor-helpers.ts src/full-corpus-leak-sweep.test.ts src/create-ui-spec-deterministic.test.ts src/create-ui-spec.test.ts src/create-ui-spec-model-path.test.ts src/corpus-trust-reader.test.ts src/tool-trust-gate.test.ts src/scripts/doctor.test.ts src/public-mcp-contract.test.ts
git commit -m "fix(corpus-trust): per-field verification record map — verification attaches where the claim is"
```

---

## Task 2: `createUiSpecDeterministic` gates per field

**Files:**
- Modify: `src/corpus-trust.ts` (`trustedEvidenceIdsOf` gains the required field parameter)
- Modify: `src/create-ui-spec-deterministic.ts` (the whole synthesis body)
- Modify: `src/create-ui-spec.ts` (precise citedDecisions for the palette and direction)
- Modify: `src/corpus-trust.test.ts` (the `trustedEvidenceIdsOf` test now passes a field)
- Modify: `src/create-ui-spec-deterministic.test.ts`

**Interfaces:**
- Consumes: `isVerified(entry, field)` and `verifiedFields(entry)` from Task 1.
- Produces: `trustedEvidenceIdsOf(matchedEntries, field): Set<string>`; `DeterministicSynthesis` gains `colorRoleEvidenceIds: readonly string[]` and `designDirectionEvidenceIds: readonly string[]`; every selector in `createUiSpecDeterministic` now names the field it serves. `create-ui-spec.ts`'s `assembleSpec` cites `synthesis.colorRoleEvidenceIds` / `synthesis.designDirectionEvidenceIds` instead of the whole corpus lane.

- [ ] **Step 1: Write the failing cross-field test**

Append to `src/create-ui-spec-deterministic.test.ts`:

```ts
/**
 * The cross-field case is the reason this spec exists: one verification record
 * un-gates only the field it names. An entry verified for `visual.colorRoles`
 * and NOT for `critique` must serve the palette and withhold the critique, in
 * the same response. This test fails against the Stage 1 entry-level predicate.
 */
describe("per-field gating — the cross-field case", () => {
  it("serves the palette from a colorRoles-verified entry and withholds its critique", () => {
    // Three entries verified for `visual.colorRoles` ONLY, each carrying
    // critique + whatToSteal prose that must never reach the direction.
    const record = { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" };
    const three = [1, 2, 3].map((n) => matched(`evidence-${n + 1}`, {
      id: `fixture-${n}`,
      provenance: { taggedBy: "auto", verification: { "visual.colorRoles": record } },
      critique: `critique ${n} that must never serve`,
      whatToSteal: [`technique ${n} that must never serve`],
    }));
    const threeEvidence = [1, 2, 3].map((n) => observation(`evidence-${n + 1}`, {
      pattern: "dashboard",
      colorRoles: { canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
    }));
    const out = createUiSpecDeterministic(threeEvidence as never, three, [], REQUEST);
    expect(out.colorTokens).not.toBeNull();
    expect(out.designDirection).not.toContain("critique");
    expect(out.designDirection).not.toContain("technique");
    expect(out.techniques).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/create-ui-spec-deterministic.test.ts -t "cross-field"`
Expected: FAIL — Stage 1's `isVerified(m.entry)` un-gates everything (critique/techniques leak into the direction) and the evidence-id bridge is not per field.

- [ ] **Step 3: Change `trustedEvidenceIdsOf` to take the required field**

In `src/corpus-trust.ts`, replace `trustedEvidenceIdsOf` with:

```ts
/**
 * The evidence ids of the matched entries verified FOR THE GIVEN FIELD. Shared
 * by BOTH consumers — the model lane's prompt-grounding filter (superseded by
 * the per-field strip in Task 3) and the deterministic synthesizer — so trust
 * is defined in exactly one place and the two paths cannot drift.
 */
export function trustedEvidenceIdsOf(
  matchedEntries: readonly { readonly evidenceId: string; readonly entry: CorpusEntryT }[],
  field: string,
): Set<string> {
  return new Set(matchedEntries.filter((m) => isVerified(m.entry, field)).map((m) => m.evidenceId));
}
```

Update the `trustedEvidenceIdsOf` test in `src/corpus-trust.test.ts` to pass `"critique"` and use per-field records:

```ts
describe("trustedEvidenceIdsOf — per-field bridge", () => {
  it("returns only entries verified for the named field", () => {
    const pairs = [
      { evidenceId: "evidence-2", entry: entry({ critique: VALID }) },
      { evidenceId: "evidence-3", entry: entry({ "visual.colorRoles": VALID }) },
      { evidenceId: "evidence-4", entry: entry({ critique: { ...VALID, method: "measured" } }) },
    ];
    expect(trustedEvidenceIdsOf(pairs, "critique")).toEqual(new Set(["evidence-2", "evidence-4"]));
    expect(trustedEvidenceIdsOf(pairs, "visual.colorRoles")).toEqual(new Set(["evidence-3"]));
  });
});
```

- [ ] **Step 4: Rewrite the deterministic body with per-field selectors**

In `src/create-ui-spec-deterministic.ts`, replace the function body from the `// ----- C3 trust gate (Stage 1) ---` comment through the closing `return { ... };` with:

```ts
  // ----- C3 trust gate (Stage 2a): per-field selectors behind the same shadow -----
  // Stage 1 shadowed `allMatchedEntries` behind ONE trusted list. Stage 2a
  // corrects that shape: verification attaches to the FIELD, not the entry, and
  // the body has no single trusted list. The ungated parameter is reachable
  // ONLY through the two accessors below — `verifiedFor(field)` (the matched
  // entries verified for exactly that field) and `anyMatchedEntries` (the
  // matched/refused distinction the colorTokensRefusal reason needs). Every
  // selector below therefore names the claim it reads, and no selector can
  // silently reach the ungated list. Each selector is the only place that
  // knows which field it reads.
  //
  // `corpusEntries` is deliberately NOT gated. It feeds `buildDeniedNames` for
  // the identity screen, which must stay corpus-wide; narrowing it would shrink
  // the denied-name set and weaken identity screening.
  const anyMatchedEntries = allMatchedEntries.length > 0;
  const verifiedFor = (field: string): readonly { readonly evidenceId: string; readonly entry: CorpusEntryT }[] =>
    allMatchedEntries.filter((m) => isVerified(m.entry, field));
  // `colorTokens`, `layoutRegions` and the direction's structured clauses derive
  // from SanitizedEvidence rows, which do not carry their entry. Bridge the same
  // per-field filter through the evidence id so plurality votes run over trusted
  // observations only. The bridge reads the gated view (`verifiedFor`), never
  // the ungated parameter directly.
  const observationsFor = (field: string): readonly SanitizedEvidence[] => {
    const trustedIds = trustedEvidenceIdsOf(verifiedFor(field), field);
    return evidence.filter(
      (e) => e.kind === "corpus-observation" && e.structuredFacts && trustedIds.has(e.id),
    );
  };

  // Color-token plurality over the CORPUS role shape (canvas/surface/ink/
  // muted/accent, muted nullable — src/schema.ts:420-426), then mapped into
  // UiSpec ColorTokens with the same defaults the existing design-prompt.ts
  // merge uses. The three-contributor guard counts entries verified FOR
  // `visual.colorRoles` — counting entries verified for anything would derive a
  // palette from entries whose colour was never checked (the over-claim this
  // program exists to stop).
  const colorRoleObservations = observationsFor("visual.colorRoles");
  const colorRoleEvidenceIds = colorRoleObservations.map((o) => o.id);
  const withRoles = colorRoleObservations
    .map((o) => o.structuredFacts)
    .filter((f) => f.colorRoles && f.colorRoles.muted !== null);
  const roleVotes = withRoles.length >= 3
    ? {
        accent: strictPlurality(withRoles.map((f) => f.colorRoles!.accent)),
        surface: strictPlurality(withRoles.map((f) => f.colorRoles!.surface)),
        ink: strictPlurality(withRoles.map((f) => f.colorRoles!.ink)),
        muted: strictPlurality(
          withRoles.map((f) => f.colorRoles!.muted).filter((v): v is string => v !== null),
        ),
      }
    : null;
  const colorTokens =
    roleVotes && roleVotes.accent && roleVotes.surface && roleVotes.ink && roleVotes.muted
      ? {
          primary: roleVotes.accent,
          surface: roleVotes.surface,
          ink: roleVotes.ink,
          muted: roleVotes.muted,
          accent: roleVotes.accent,
        }
      : null;
  const colorTokensRefusal: DeterministicSynthesis["colorTokensRefusal"] =
    colorTokens !== null ? null
      : roleVotes === null
        ? (colorRoleObservations.length === 0
            ? (anyMatchedEntries ? "untrusted" : "insufficient-contributors")
            : "insufficient-contributors")
        : "no-plurality";

  // Layout regions from the wireframe roles (closed enum), deduped in order.
  // `layoutRegions` and the responsive-behavior `form` clause both read the
  // `layout` claim, so both gate on the same key.
  const layoutObservations = observationsFor("layout");
  const seen = new Set<string>();
  const layoutRegions: DeterministicLayoutRegion[] = [];
  for (const f of layoutObservations.map((o) => o.structuredFacts)) {
    for (const role of f.layoutRoles ?? []) {
      if (seen.has(role)) continue;
      seen.add(role);
      layoutRegions.push({ name: role, type: role, components: [], responsive: [] });
    }
  }
  const layoutForms = layoutObservations
    .map((o) => o.structuredFacts.layoutForm)
    .filter((v): v is NonNullable<typeof v> => Boolean(v));
  const layoutForm = strictPlurality(layoutForms);
  const responsivePairs = verifiedFor("responsiveBehavior");
  const responsiveModes = [...new Set(
    responsivePairs
      .map((m) => m.entry.responsiveBehavior)
      .filter((v): v is NonNullable<typeof v> => typeof v === "string"),
  )];
  const responsiveBehaviorEvidenceIds: string[] = [];
  for (const { evidenceId, entry } of responsivePairs) {
    if (typeof entry.responsiveBehavior === "string") responsiveBehaviorEvidenceIds.push(evidenceId);
  }
  // The layout-form clause is derived from every layout-verified observation's
  // structuredFacts, so when it contributes, every layout observation id is
  // cited.
  if (layoutForm) {
    for (const id of layoutObservations.map((o) => o.id)) {
      if (!responsiveBehaviorEvidenceIds.includes(id)) responsiveBehaviorEvidenceIds.push(id);
    }
  }
  const responsiveBehavior = [
    ...responsiveModes.map((mode) => `mode: ${mode}`),
    ...(layoutForm ? [`form: ${layoutForm}`] : []),
  ];

  // Direction: one recipe-voice sentence built from pluralities of the closed
  // facts (structured signals) plus the group-B corpus signals folded in as
  // cited signals (design spec §1B): styleTags, categories, mood, colorScheme,
  // typePairing.notes and critique. The group-B values live only in the RAW
  // matched entries — they are deliberately absent from structuredFacts — so
  // they are read through the per-field matched channel, exactly like the six
  // prose fields below. Each structured clause reads observations verified for
  // ITS OWN key (spacingDensity, cornerStyle, usesShadows, usesBorders,
  // typePairing, layout) — one claim, one selector.
  const densityObs = observationsFor("visual.spacingDensity");
  const cornersObs = observationsFor("visual.cornerStyle");
  const shadowsObs = observationsFor("visual.usesShadows");
  const bordersObs = observationsFor("visual.usesBorders");
  const pairingObs = observationsFor("visual.typePairing");
  const density = strictPlurality(
    densityObs.map((o) => o.structuredFacts.spacingDensity).filter((v): v is NonNullable<typeof v> => Boolean(v)),
  );
  const corners = strictPlurality(
    cornersObs.map((o) => o.structuredFacts.cornerStyle).filter((v): v is NonNullable<typeof v> => Boolean(v)),
  );
  const shadows = majority(
    shadowsObs.filter((o) => typeof o.structuredFacts.usesShadows === "boolean")
      .map((o) => o.structuredFacts.usesShadows as boolean),
  );
  const borders = majority(
    bordersObs.filter((o) => typeof o.structuredFacts.usesBorders === "boolean")
      .map((o) => o.structuredFacts.usesBorders as boolean),
  );
  const pairings = pairingObs
    .map((o) => o.structuredFacts.typePairing)
    .filter((v): v is NonNullable<typeof v> => Boolean(v));
  const pairing = strictPlurality(pairings);
  // Shared identity screen for every corpus-prose string (drop whole, never
  // redact). Built once so the direction's prose segments (including the
  // font-family clause, which can carry a product name) and the six prose
  // fields below use the same denied-name set.
  const deniedNames = buildDeniedNames(corpusEntries);
  const screen = (text: string, entry: CorpusEntryT): string | null =>
    screenProse(text, entry, deniedNames);

  // Every clause tracks the evidence ids of the observations/entries that
  // produced it, so the composed direction cites exactly the references that
  // grounded it — never an entry whose only verified claim did not contribute.
  const clauses: string[] = [];
  const clauseIds: string[] = [];
  const pushClause = (clause: string, ids: readonly string[]): void => {
    if (clause.length > 0) {
      clauses.push(clause);
      clauseIds.push(...ids);
    }
  };
  if (density) pushClause(`${density} spacing`, densityObs.map((o) => o.id));
  if (corners) pushClause(`${corners} corner treatment`, cornersObs.map((o) => o.id));
  if (shadows !== undefined) pushClause(shadows ? "soft shadows" : "no shadows", shadowsObs.map((o) => o.id));
  if (borders !== undefined) pushClause(borders ? "hairline borders" : "no borders", bordersObs.map((o) => o.id));
  if (layoutForm) pushClause(`a ${layoutForm} layout`, layoutObservations.map((o) => o.id));
  // The font-family clause is the ONE closed-token clause that can carry a
  // product name (the "Alan" product's font is "Alan Sans" — review finding
  // #2/#4). The pairing clause is therefore screened like prose: if it names a
  // product it is DROPPED as a clause, while the direction survives.
  const pairingClause = pairing ? `${pairing} typography` : null;
  let pairingDropped = false;
  if (pairingClause !== null) {
    for (const { entry } of verifiedFor("visual.typePairing")) {
      if (screenProse(pairingClause, entry, deniedNames) === null) {
        pairingDropped = true;
        break;
      }
    }
  }
  if (pairing && !pairingDropped) pushClause(`${pairing} typography`, pairingObs.map((o) => o.id));

  // Group-B signals (design spec §1B), distinct in rank order. Closed-token
  // signals (styleTags, categories, colorScheme, the structuredFacts clauses
  // and the typePairing font) carry no identity and are NOT screened (design
  // spec §2b). The PROSE signals (mood, typePairing.notes, critique) are
  // screened per source entry BEFORE composing. Each signal reads entries
  // verified for its own key.
  const styleTagPairs = verifiedFor("styleTags");
  const categoryPairs = verifiedFor("categories");
  const schemePairs = verifiedFor("colorScheme");
  const moodPairs = verifiedFor("mood");
  const typePairingPairs = verifiedFor("visual.typePairing");
  const critiquePairs = verifiedFor("critique");
  const styleTags = [...new Set(styleTagPairs.flatMap((m) => m.entry.styleTags ?? []))];
  const categories = [...new Set(categoryPairs.flatMap((m) => m.entry.categories ?? []))];
  const schemes = [...new Set(
    schemePairs.map((m) => m.entry.colorScheme).filter((v): v is NonNullable<typeof v> => typeof v === "string"),
  )];
  const moods = [...new Set(
    moodPairs
      .map((m) => (typeof m.entry.mood === "string" ? screen(m.entry.mood, m.entry) : null))
      .filter((v): v is string => v !== null),
  )].slice(0, MAX_DIRECTION_MOODS);
  const typeNotes = [...new Set(
    typePairingPairs
      .map((m) => {
        const note = m.entry.visual?.typePairing?.notes;
        return typeof note === "string" && note.length > 0 ? screen(note, m.entry) : null;
      })
      .filter((v): v is string => v !== null),
  )].slice(0, MAX_DIRECTION_TYPE_NOTES);
  const critiques = critiquePairs
    .map((m) => (typeof m.entry.critique === "string" ? screen(m.entry.critique, m.entry) : null))
    .filter((v): v is string => v !== null)
    .slice(0, MAX_DIRECTION_CRITIQUES);

  // Signal clauses in PRIORITY order, appended under a character budget. The
  // closed-token signals come first: they are short, dense, and cannot carry
  // identity. Then critique — the corpus's actual design judgment. typePairing
  // notes come LAST because the structural typography clause above already
  // states the pairing.
  const signalClauses: string[] = [];
  let signalChars = 0;
  const pushSignal = (clause: string, ids: readonly string[]): void => {
    const cost = clause.length + (signalClauses.length > 0 ? SIGNAL_JOIN.length : 0);
    if (signalChars + cost > MAX_DIRECTION_SIGNAL_CHARS) return;
    signalClauses.push(clause);
    clauseIds.push(...ids);
    signalChars += cost;
  };
  if (styleTags.length > 0) pushSignal(`style tags: ${styleTags.join(", ")}`, styleTagPairs.map((m) => m.evidenceId));
  if (categories.length > 0) pushSignal(`categories: ${categories.join(", ")}`, categoryPairs.map((m) => m.evidenceId));
  if (schemes.length > 0) {
    pushSignal(
      schemes.length === 1 ? `a ${schemes[0]} color scheme` : `${schemes.join(" and ")} color schemes`,
      schemePairs.map((m) => m.evidenceId),
    );
  }
  if (moods.length > 0) pushSignal(`mood: ${moods.map(withoutTrailingPeriod).join(VALUE_JOIN)}`, moodPairs.map((m) => m.evidenceId));
  if (critiques.length > 0) pushSignal(`critique: ${withoutTrailingPeriod(critiques.join(" "))}`, critiquePairs.map((m) => m.evidenceId));
  if (typeNotes.length > 0) pushSignal(`type notes: ${withoutTrailingPeriod(typeNotes.join(" "))}`, typePairingPairs.map((m) => m.evidenceId));

  // Template fix (plan Task 5 Step 2): the brief must never be spliced
  // mid-sentence. It now stands as a quoted noun phrase, so ANY brief — single
  // or multi-sentence — leaves the rest of the sentence grammatically intact.
  const designDirectionEvidenceIds = [...new Set(clauseIds)];
  const composedDirection = clauses.length > 0 || signalClauses.length > 0
    ? `For the brief "${request.productContext}", the matched corpus references (${designDirectionEvidenceIds.join(", ")})`
      + (clauses.length > 0 ? ` point to ${clauses.join(", ")}` : "")
      + ". "
      + (signalClauses.length > 0 ? `The shared signals include ${signalClauses.join(SIGNAL_JOIN)}. ` : "")
      + `Let those signals lead the layout before adding anything not evidenced by the matched examples.`
    : null;
  const designDirection: string | null = composedDirection;

  // ----- C3 Phase 1 prose selection (Task 4): six existing UiSpec fields. -----
  // Everything that carries corpus prose goes through the identity screen
  // (drop whole, never redact); closed-token fields (components,
  // responsiveBehavior) do not, per design spec §2b.

  // techniques ← whatToSteal, capped at 5 response-wide, rank order.
  const techniques: { text: string; sourceIds: string[] }[] = [];
  for (const { evidenceId, entry } of verifiedFor("whatToSteal")) {
    for (const raw of entry.whatToSteal ?? []) {
      const text = screen(raw, entry);
      if (text === null) continue;
      techniques.push({ text, sourceIds: [evidenceId] });
      if (techniques.length >= MAX_TECHNIQUES) break;
    }
    if (techniques.length >= MAX_TECHNIQUES) break;
  }

  // antiPatterns ← antiPatterns.antiPatterns, capped at 5 response-wide.
  const antiPatterns: { text: string; sourceIds: string[] }[] = [];
  for (const { evidenceId, entry } of verifiedFor("antiPatterns")) {
    for (const raw of entry.antiPatterns?.antiPatterns ?? []) {
      const text = screen(raw, entry);
      if (text === null) continue;
      antiPatterns.push({ text, sourceIds: [evidenceId] });
      if (antiPatterns.length >= MAX_ANTI_PATTERNS) break;
    }
    if (antiPatterns.length >= MAX_ANTI_PATTERNS) break;
  }

  // contentVoiceGuidance ← voice.tone + voice.avoid + voice.examples. ONE
  // composed string; each segment omitted entirely when its source is absent.
  let tone: string | undefined;
  const avoid: string[] = [];
  const examples: string[] = [];
  const voiceEvidenceIds: string[] = [];
  for (const { evidenceId, entry } of verifiedFor("voice")) {
    const voice = entry.voice;
    if (!voice) continue;
    let contributed = false;
    if (typeof voice.tone === "string" && voice.tone.length > 0) {
      const screenedTone = screen(voice.tone, entry);
      if (tone === undefined && screenedTone !== null) {
        tone = screenedTone;
        contributed = true;
      }
    }
    for (const raw of voice.avoid ?? []) {
      const text = screen(raw, entry);
      if (text !== null) {
        avoid.push(text);
        contributed = true;
      }
    }
    for (const raw of voice.examples ?? []) {
      if (examples.length >= MAX_VOICE_EXAMPLES) break;
      if (raw.length < MIN_VOICE_EXAMPLE_LENGTH || raw.length > MAX_VOICE_EXAMPLE_LENGTH) continue;
      if (DATA_ONLY_VOICE_EXAMPLE.test(raw)) continue;
      const text = screen(raw, entry);
      if (text === null) continue;
      examples.push(text);
      contributed = true;
    }
    if (contributed) voiceEvidenceIds.push(evidenceId);
  }
  const voiceSegments: string[] = [];
  if (tone !== undefined) voiceSegments.push(`${tone}.`);
  if (avoid.length > 0) voiceSegments.push(`Avoid: ${avoid.join("; ")}.`);
  if (examples.length > 0) voiceSegments.push(`Examples: ${examples.join(" · ")}.`);
  const contentVoiceGuidance = voiceSegments.length > 0 ? voiceSegments.join(" ") : null;

  // accessibilityConstraints ← accessibilityRisks (the risk statement is the
  // constraint; screened prose, all present, response-wide).
  const accessibilityConstraints: string[] = [];
  const accessibilityEvidenceIds: string[] = [];
  for (const { evidenceId, entry } of verifiedFor("antiPatterns.accessibilityRisks")) {
    for (const risk of entry.antiPatterns?.accessibilityRisks ?? []) {
      const text = screen(risk.risk, entry);
      if (text !== null) {
        accessibilityConstraints.push(text);
        if (!accessibilityEvidenceIds.includes(evidenceId)) accessibilityEvidenceIds.push(evidenceId);
      }
    }
  }

  // componentInventory ← components (closed enum tokens; deduped in order).
  const seenComponents = new Set<string>();
  const componentInventory: { name: string; pattern: string }[] = [];
  const componentInventoryEvidenceIds: string[] = [];
  for (const { evidenceId, entry } of verifiedFor("components")) {
    let contributed = false;
    for (const component of entry.components ?? []) {
      if (seenComponents.has(component)) continue;
      seenComponents.add(component);
      componentInventory.push({ name: component, pattern: component });
      contributed = true;
    }
    if (contributed) componentInventoryEvidenceIds.push(evidenceId);
  }

  return {
    designDirection,
    colorTokens,
    colorTokensRefusal,
    layoutRegions,
    responsiveBehavior,
    techniques,
    antiPatterns,
    contentVoiceGuidance,
    contentVoiceEvidenceIds: voiceEvidenceIds,
    accessibilityConstraints,
    accessibilityEvidenceIds,
    componentInventory,
    componentInventoryEvidenceIds,
    responsiveBehaviorEvidenceIds,
    colorRoleEvidenceIds,
    designDirectionEvidenceIds,
  };
```

Also add the two new fields to `DeterministicSynthesis`:

```ts
  /** Evidence ids of the entries whose colorRoles plurality produced colorTokens. */
  colorRoleEvidenceIds: readonly string[];
  /** Evidence ids of the entries whose clauses produced designDirection. */
  designDirectionEvidenceIds: readonly string[];
```

- [ ] **Step 5: Cite precisely in `assembleSpec`**

In `src/create-ui-spec.ts`, the direction decision and the colorTokens decision currently cite `corpusEvidenceIds` (the whole surviving corpus lane). Under per-field gating that over-cites: the palette must cite exactly the rows that voted, and the direction exactly the rows whose clauses composed it. Replace `evidenceIds: corpusEvidenceIds` with `evidenceIds: synthesis.designDirectionEvidenceIds` in the `directionDecisions` block (`:997-1006`) and with `evidenceIds: synthesis.colorRoleEvidenceIds` in the colorTokens decision (`:1020`).

- [ ] **Step 6: Write the per-field both-directions table test**

Append to `src/create-ui-spec-deterministic.test.ts`:

```ts
/**
 * Both directions per field: a verified claim serves, an unverified one
 * withholds. A one-direction test passes with the feature simply broken.
 */
describe("per-field gating — both directions", () => {
  const FIELDS: Array<{ field: string; serve: (out: DeterministicSynthesis) => boolean }> = [
    { field: "whatToSteal", serve: (o) => o.techniques.length > 0 },
    { field: "antiPatterns", serve: (o) => o.antiPatterns.length > 0 },
    { field: "antiPatterns.accessibilityRisks", serve: (o) => o.accessibilityConstraints.length > 0 },
    { field: "voice", serve: (o) => o.contentVoiceGuidance !== null },
    { field: "components", serve: (o) => o.componentInventory.length > 0 },
    { field: "responsiveBehavior", serve: (o) => o.responsiveBehavior.length > 0 },
    { field: "layout", serve: (o) => o.layoutRegions.length > 0 },
  ];

  it.each(FIELDS)("$field serves when verified, withholds when not", ({ field, serve }) => {
    const record = { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" };
    const content = (over: Record<string, unknown>): Record<string, unknown> => ({
      id: "fixture-entry",
      provenance: { taggedBy: "auto", verification: { [field]: record } },
      whatToSteal: ["steal me"],
      antiPatterns: { antiPatterns: ["avoid me"], whereThisFails: [], accessibilityRisks: [{ element: "x", risk: "risk me", evidence: "visible", confidence: "visible", wcag: ["1.4.3"] }] },
      voice: { tone: "Calm, direct", avoid: [], examples: [] },
      components: ["kpi-card"],
      responsiveBehavior: "responsive",
      layout: { form: "three-column", regions: [{ role: "main-canvas" }] },
      ...over,
    });
    const verified = matched("evidence-2", content({}));
    const served = createUiSpecDeterministic(
      [observation("evidence-2", { pattern: "dashboard", layoutRoles: ["main-canvas"], layoutForm: "three-column" })] as never,
      [verified],
      [],
      REQUEST,
    );
    expect(serve(served), `${field} should SERVE when verified`).toBe(true);

    const unverified = matched("evidence-2", { ...content({}), provenance: { taggedBy: "auto" } });
    const withheld = createUiSpecDeterministic(
      [observation("evidence-2", { pattern: "dashboard", layoutRoles: ["main-canvas"], layoutForm: "three-column" })] as never,
      [unverified],
      [],
      REQUEST,
    );
    expect(serve(withheld), `${field} should WITHHOLD when unverified`).toBe(false);
  });

  it("the colorTokens threshold counts visual.colorRoles-verified entries only", () => {
    // Three entries verified for OTHER fields must NOT reach the palette
    // threshold; the same three entries verified for visual.colorRoles must.
    const other = { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" };
    const pairs = [1, 2, 3].map((n) => matched(`evidence-${n + 1}`, {
      id: `e-${n}`,
      provenance: { taggedBy: "auto", verification: { critique: other } },
      visual: { colorRoles: { canvas: "#fff", surface: "#fff", ink: "#111", muted: "#666", accent: "#2563eb" } },
    }));
    const rows = [1, 2, 3].map((n) => observation(`evidence-${n + 1}`, {
      pattern: "dashboard",
      colorRoles: { canvas: "#fff", surface: "#fff", ink: "#111", muted: "#666", accent: "#2563eb" },
    }));
    const out = createUiSpecDeterministic(rows as never, pairs, [], REQUEST);
    expect(out.colorTokens).toBeNull();
    expect(out.colorTokensRefusal).toBe("untrusted");
  });
});
```

Add the import `import { createUiSpecDeterministic, type DeterministicSynthesis } from "./create-ui-spec-deterministic.js";` if `DeterministicSynthesis` is not already imported.

- [ ] **Step 7: Run the deterministic suites**

Run: `npx vitest run src/corpus-trust.test.ts src/create-ui-spec-deterministic.test.ts src/create-ui-spec.test.ts`
Expected: PASS. If an existing `create-ui-spec.test.ts` assertion pinned the old whole-lane citation sets (`evidenceIds` equal to all three evidence ids), it still holds because the Task 1 fixtures verify every key — the per-field subsets are the whole lane again. If one fails, update it to assert the per-field subset.

- [ ] **Step 8: Commit**

```bash
git add src/corpus-trust.ts src/corpus-trust.test.ts src/create-ui-spec-deterministic.ts src/create-ui-spec-deterministic.test.ts src/create-ui-spec.ts
git commit -m "fix(create-ui-spec): per-field selectors — a verified colour claim un-gates only colour"
```

---

## Task 3: The evidence projection strips per field; the model lane sees only grounded facts

**Files:**
- Modify: `src/create-ui-spec.ts` (`sanitizeCorpusObservation` `:662-712`, the retrieval loop, the model-lane filter)
- Modify: `src/create-ui-spec-deterministic.ts` (`verifiedFor` becomes citation-safe against surviving rows)
- Modify: `src/create-ui-spec.test.ts`, `src/create-ui-spec-model-path.test.ts`

**Interfaces:**
- Consumes: `isVerified(entry, field)` from Task 1, `verifiedFor`/`observationsFor` from Task 2.
- Produces: `sanitizeCorpusObservation(id, entry): SanitizedEvidence | null` — a row whose structured facts are all stripped is dropped at the call site. `verifiedFor` serves prose only from entries whose response-scoped row survived (a claim without a row cannot be cited: `techniques[].sourceIds` must be members of `spec.provenance.evidenceIds` per `refineEnvelope`).

**Scope ruling (recorded decision — this task is deliberately a served-posture change):**

The spec's out-of-scope section claims the change is "byte-identical" because zero records exist before and after. That sentence is **wrong on day one and must be corrected** (in this task's commit, per Task 11 Step 4). Stage 1 serves `evidence[]` rows whose summaries interpolate UNVERIFIED corpus facts (`sanitizeCorpusObservation`'s recipe-owned summaries); the spec's strip section explicitly supersedes Stage 1's "evidence[] rows stay ungated" note ("their facts and summary are corpus-derived values, and the invariant does not distinguish by channel"). Under this task, with zero verified entries, every corpus-observation row is dropped, so the served evidence array shrinks from `[recipe, corpus-1, ...]` to `[recipe]`.

Two consequences are owned here, not swept under the byte-identical claim:

1. **`retrieval.resultCount` stays retrieval truth.** It counts retrieved corpus observations (`create-ui-spec.test.ts:1360` documents exactly that), and the strip does not undo the retrieval. `corpusCount` keeps counting matched entries, so `resultCount` reports N even when the evidence array carries zero corpus rows — and the `insufficientCorpusEvidence` trust warning (Task 10) carries the explanation. The `corpusCount === 0` early-return path must NOT be repurposed to fire on all-unverified: its `fallbackReason: "no-results"` would claim the query had no hits when it had hits that were all refused — the false-reason class this program exists to eliminate.
2. **The invariant governs content, not row presence.** A stripped row is not "still serving nothing useful" — it is a corpus-derived value with no grounded facts, and keeping it would publish an empty summary that asserts nothing checked.

- [ ] **Step 1: Write the failing cross-field evidence-row strip test**

Append to `src/create-ui-spec.test.ts`:

```ts
describe("create_ui_spec — per-field evidence projection strip", () => {
  it("strips unverified facts from a row and drops a row with none", async () => {
    // Two matched entries. Entry A is verified for visual.colorRoles ONLY; its
    // row must carry colour facts and NOT the layout/typography facts. Entry B
    // is verified for whatToSteal only (no structured claim); its row must be
    // dropped — and its technique must be withheld, because there is no
    // response-scoped row to cite.
    const record = (field: string) => ({ taggedBy: "auto" as const, verification: { [field]: { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" } } });
    const colorOnly = {
      ...corpusEntryWithRoles("strip-a", "#2563eb", "dashboard"),
      provenance: record("visual.colorRoles"),
    };
    const proseOnly = {
      ...entry("strip-b", "ProductB", "forms", { whatToSteal: ["Prose from an entry with no structured claim."] }),
      provenance: record("whatToSteal"),
    };
    const out = await createUiSpecForAdapter(
      noRefRequest(),
      deps([colorOnly, proseOnly], [
        { entry: colorOnly, score: 5 },
        { entry: proseOnly, score: 4 },
      ]),
    );
    const rows = out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("evidence-2");
    expect(rows[0]!.structuredFacts.colorRoles).toBeDefined();
    expect(rows[0]!.structuredFacts.layoutForm).toBeUndefined();
    expect(rows[0]!.structuredFacts.typePairing).toBeUndefined();
    expect(rows[0]!.summary.length).toBeGreaterThan(0);
    expect(rows[0]!.summary).not.toMatch(/typography|layout/i); // summary regenerated from surviving facts only
    // The prose-only entry's row was dropped, so its technique is withheld.
    expect(out.envelope.spec.techniques.map((t) => t.text)).not.toContain("Prose from an entry with no structured claim.");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/create-ui-spec.test.ts -t "evidence projection strip"`
Expected: FAIL — today every fact is projected regardless of field, both rows survive, and the prose-only entry's technique serves.

- [ ] **Step 3: Make `sanitizeCorpusObservation` project per field and return null when stripped**

In `src/create-ui-spec.ts`, replace the body of `sanitizeCorpusObservation` (`:662-712`) with:

```ts
function sanitizeCorpusObservation(id: string, entry: CorpusEntryT): SanitizedEvidence | null {
  const structuredFacts: SanitizedEvidence["structuredFacts"] = {};
  // Stage 2a: a fact is projected only when ITS OWN key is verified for this
  // entry. A row whose facts are all stripped is dropped by the caller — it
  // carries no verified corpus-derived value, and serving it would publish a
  // summary that asserts nothing grounded.
  if (isVerified(entry, "patternType") && entry.patternType && typeof entry.patternType === "string") {
    structuredFacts.pattern = entry.patternType;
  }
  const regionCount = entry.layout?.regions?.length;
  if (isVerified(entry, "layout") && typeof regionCount === "number" && Number.isFinite(regionCount)) {
    structuredFacts.regionCount = Math.min(Math.max(Math.trunc(regionCount), 0), 50);
  }
  const visual = entry.visual;
  if (isVerified(entry, "visual.spacingDensity") && visual?.spacingDensity) structuredFacts.spacingDensity = visual.spacingDensity;
  if (isVerified(entry, "visual.cornerStyle") && visual?.cornerStyle) structuredFacts.cornerStyle = visual.cornerStyle;
  if (isVerified(entry, "visual.usesShadows") && typeof visual?.usesShadows === "boolean") structuredFacts.usesShadows = visual.usesShadows;
  if (isVerified(entry, "visual.usesBorders") && typeof visual?.usesBorders === "boolean") structuredFacts.usesBorders = visual.usesBorders;
  if (isVerified(entry, "visual.accentColor") && visual?.accentColor) structuredFacts.accentColor = visual.accentColor;
  if (isVerified(entry, "visual.colorRoles") && visual?.colorRoles) {
    structuredFacts.colorRoles = {
      canvas: visual.colorRoles.canvas,
      surface: visual.colorRoles.surface,
      ink: visual.colorRoles.ink,
      muted: visual.colorRoles.muted, // nullable per the corpus schema
      accent: visual.colorRoles.accent,
    };
  }
  const pairing = visual?.typePairing;
  if (isVerified(entry, "visual.typePairing") && pairing?.display && pairing.body) {
    structuredFacts.typePairing = `${pairing.display} + ${pairing.body}`;
  }
  const layoutStructure = entry.layout;
  if (isVerified(entry, "layout") && layoutStructure?.form) structuredFacts.layoutForm = layoutStructure.form;
  const roles = layoutStructure?.regions?.map((r) => r.role).filter(Boolean);
  if (isVerified(entry, "layout") && roles && roles.length > 0) structuredFacts.layoutRoles = roles.slice(0, 8);

  if (Object.keys(structuredFacts).length === 0) return null;

  const evidence: SanitizedEvidence = {
    id,
    kind: "corpus-observation",
    basis: "visible",
    summary: "", // set below from the recipe-owned template
    structuredFacts,
  };
  evidence.summary = buildCorpusObservationSummary(evidence);
  return parseSanitizedEvidence(evidence);
}
```

Update ONLY the `for (const r of top)` loop — the four declarations above it (`const sanitized`, `const matchedEntries`, `let nextId`, `let corpusCount`) and the `if (corpusCount === 0)` block below it stay untouched — so a dropped row never enters `sanitized`, while the matched entry still reaches the deterministic body (prose fields are gated independently):

Before:

```ts
  for (const r of top) {
    const id = `evidence-${nextId++}`;
    sanitized.push(sanitizeCorpusObservation(id, r.entry));
    matchedEntries.push({ evidenceId: id, entry: r.entry });
    corpusCount++;
  }
```

After:

```ts
  for (const r of top) {
    const id = `evidence-${nextId++}`;
    const row = sanitizeCorpusObservation(id, r.entry);
    if (row !== null) sanitized.push(row);
    matchedEntries.push({ evidenceId: id, entry: r.entry });
    corpusCount++;
  }
```

- [ ] **Step 4: Make the deterministic prose selectors citation-safe**

In `src/create-ui-spec-deterministic.ts`, change `verifiedFor` so it only serves entries whose response-scoped row survived the strip (the row is the citation anchor, and `techniques[].sourceIds` must be members of `spec.provenance.evidenceIds`):

```ts
  const servedRowIds = new Set(evidence.map((e) => e.id));
  const verifiedFor = (field: string): readonly { readonly evidenceId: string; readonly entry: CorpusEntryT }[] =>
    allMatchedEntries.filter((m) => isVerified(m.entry, field) && servedRowIds.has(m.evidenceId));
```

`observationsFor` is already scoped to `evidence`, so it needs no change.

- [ ] **Step 5: Supersede the model-lane filter**

In `src/create-ui-spec.ts`, replace the whole model-lane gate block — from the comment `  // C3 trust gate: what the MODEL sees must be trusted` through the closing `  );` of the `createUiSpecModel(...)` call (the `if (outcome.kind === "fallback")` line after it stays). Before:

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
  //
  // `SanitizedEvidenceSchema.array()` carries no `.min(1)`
  // (create-ui-spec-model.ts:87), so a corpus-free list parses rather than
  // rejecting the proposal.
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

After:

```ts
  // C3 trust gate (Stage 2a): the per-field evidence projection strips each
  // corpus row down to its VERIFIED facts before it reaches any consumer, so
  // the model sees exactly the grounded facts and never more. Stage 1's
  // row-level `trustedEvidenceIdsOf` narrowing is superseded by the strip — a
  // surviving corpus row carries only verified facts, and a row with none was
  // dropped at construction. The recipe/system row carries no corpus claim and
  // passes through untouched, so Stage 1's zero-verified state (recipe row
  // only, no corpus grounding) is preserved.
  const outcome = await createUiSpecModel(
    {
      request,
      sanitizedEvidence: resolved.sanitized,
    },
    model.runtime,
  );
```

Remove `trustedEvidenceIdsOf` from the `./corpus-trust.js` import in this file (it is now used only by the deterministic module).

- [ ] **Step 6: Update the model-path test for the new served-row semantics**

In `src/create-ui-spec-model-path.test.ts`, update the test "keeps unverified entries' derived summaries out of the model prompt": the served evidence now reports only the surviving (partially verified) row, so change the final assertion:

```ts
    // The per-field strip is the model-lane gate now: the unverified row was
    // dropped at construction, so the served evidence reports one row.
    expect(out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation")).toHaveLength(1);
```

Add the cross-field case the spec requires — a row verified for `visual.colorRoles` only carries colour facts and not layout/typography facts into the model prompt:

```ts
it("feeds the model exactly the verified facts of a partially-verified row", async () => {
  const verified = gateEntry("internal-v", "dashboard", true);
  const reader = {
    ...makeReader(),
    searchRanked: vi.fn(async () => [{ entry: verified, score: 5, searchMode: "keyword" }]),
  } as unknown as CorpusReader;
  const call = vi.fn(async () => validModelResponse());
  const runtime = makeRuntime({ call: call as unknown as CreateUiSpecModelRuntime["call"] });
  const out = await createUiSpecForAdapter(
    REQUEST,
    makeCreateUiSpecDependencies(reader, FIXED_NOW, { kind: "configured", runtime }),
  );
  const prompt = (call.mock.calls[0][0] as { prompt: string }).prompt;
  expect(prompt).toContain("dashboard reference");
  expect(out.envelope.modelExecution?.state).toBe("succeeded");
});
```

Then change `gateEntry` so the `verified` flag stamps only `patternType` (keep the fixture's structured facts on the entry but note that only the patternType-verified row survives with the pattern fact):

```ts
    provenance: verified
      ? { taggedBy: "auto", verification: { patternType: { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" } } }
      : undefined,
```

Run this file's trust-gated-prompt-grounding suite and adjust the "dashboard reference"/"forms reference" assertions to the actual surviving-row summaries.

- [ ] **Step 7: Run the affected suites**

Run:
```bash
npx vitest run src/create-ui-spec.test.ts src/create-ui-spec-model-path.test.ts src/create-ui-spec-deterministic.test.ts src/full-corpus-leak-sweep.test.ts
```
Expected: PASS. Update any assertion that still expects a prose-only entry's row or technique to serve.

- [ ] **Step 8: Commit**

```bash
git add src/create-ui-spec.ts src/create-ui-spec-deterministic.ts src/create-ui-spec.test.ts src/create-ui-spec-model-path.test.ts
git commit -m "fix(create-ui-spec): per-field evidence projection strip — the model and served rows see only grounded facts"
```

---

## Task 4: `TrustGatedCorpusReader` gates on a per-tool field set

**Files:**
- Modify: `src/corpus-trust-reader.ts`
- Modify: `src/corpus-trust-reader.test.ts`

**Interfaces:**
- Consumes: `isVerified(entry, field)` from Task 1.
- Produces: `new TrustGatedCorpusReader(inner, fields: readonly string[])` — an entry is returned only when EVERY field in the set is verified; `readonly fields` is exposed for the posture messages; `trustPosture()`/`refusedForTrust()` report against the reader's own field set. Task 5 constructs one reader per tool.

- [ ] **Step 1: Write the failing tests**

Append to `src/corpus-trust-reader.test.ts`:

```ts
describe("TrustGatedCorpusReader — per-field field sets", () => {
  function fieldEntry(id: string, fields: readonly string[]): CorpusEntryT {
    const verification: Record<string, unknown> = {};
    for (const field of fields) {
      verification[field] = { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" };
    }
    return {
      id,
      source: { productName: `product-${id}` },
      whatToSteal: [`${id} technique`],
      categories: [id],
      styleTags: [id],
      domainTags: [id],
      provenance: fields.length > 0 ? { taggedBy: "auto", verification } : undefined,
    } as unknown as CorpusEntryT;
  }

  const colorOnly = fieldEntry("color-1", ["visual.colorRoles"]);
  const full = fieldEntry("full-1", ["whatToSteal", "voice"]);

  function inner(): CorpusReader {
    return {
      search: async () => [colorOnly, full],
      searchRanked: async () => [colorOnly, full].map((e, i) => ({ entry: e, score: 5 - i, searchMode: "keyword" as const })),
      getById: (id: string) => [colorOnly, full].find((e) => e.id === id),
      findSimilar: () => [colorOnly, full].map((e) => ({ entry: e, score: 1 })),
      listCategories: () => ["color-1", "full-1"],
      listStyleTags: () => ["color-1", "full-1"],
      listDomainTags: () => ["color-1", "full-1"],
      indexStatus: () => ({ indexed: 0, total: 2, hasIndex: false, missing: 0, stale: 0, contentStale: 0 }),
      entriesForAggregation: () => [colorOnly, full],
      resolveImagePath: () => null,
    } as unknown as CorpusReader;
  }

  it("serves an entry only when EVERY field in the set is verified", async () => {
    const colorGate = new TrustGatedCorpusReader(inner(), ["visual.colorRoles"]);
    expect((await colorGate.search({} as never)).map((e) => e.id)).toEqual(["color-1"]);
    // The same entry is refused by a tool whose set includes an unverified field.
    const proseGate = new TrustGatedCorpusReader(inner(), ["whatToSteal", "visual.colorRoles"]);
    expect((await proseGate.search({} as never)).map((e) => e.id)).toEqual([]);
    expect(proseGate.refusedForTrust("color-1")).toBe(true);
    expect(proseGate.trustPosture()).toEqual({ verified: 0, total: 2 });
  });

  it("refuses an empty field set at construction", () => {
    expect(() => new TrustGatedCorpusReader(inner(), [])).toThrow(/at least one field/i);
  });

  it("reports the posture against its own field set", () => {
    const colorGate = new TrustGatedCorpusReader(inner(), ["visual.colorRoles"]);
    expect(colorGate.trustPosture()).toEqual({ verified: 1, total: 2 });
    const twoFieldGate = new TrustGatedCorpusReader(inner(), ["whatToSteal", "voice"]);
    expect(twoFieldGate.trustPosture()).toEqual({ verified: 1, total: 2 });
  });

  it("gates taxonomy vocabularies on the field each is drawn from", () => {
    const r = new TrustGatedCorpusReader(inner(), ["categories"]);
    expect(r.listCategories()).toEqual(["color-1"]); // only the entry verified for categories
    expect(r.listStyleTags()).toEqual([]);
    expect(r.listDomainTags()).toEqual([]);
  });

  it("narrows the image index to entries verified for every field in the set", async () => {
    const r = new TrustGatedCorpusReader(inner(), ["whatToSteal", "voice"]);
    const innerReader = {
      ...inner(),
      getImageIndex: async () => ({
        dimension: 3,
        entries: {
          "color-1": { vector: [1, 0, 0], hash: "h1" },
          "full-1": { vector: [0, 1, 0], hash: "h2" },
        },
      }),
    } as unknown as CorpusReader;
    const index = await new TrustGatedCorpusReader(innerReader, ["whatToSteal", "voice"]).getImageIndex();
    expect(Object.keys(index!.entries)).toEqual(["full-1"]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/corpus-trust-reader.test.ts`
Expected: type errors (constructor takes one argument) and FAILs (whole-entry gating lets `full-1` through a two-field gate).

- [ ] **Step 3: Implement the field-set reader**

Replace `src/corpus-trust-reader.ts` with:

```ts
/**
 * corpus-trust-reader.ts — the trust gate for every corpus-reading MCP tool.
 *
 * `create_ui_spec` gates itself (see `create-ui-spec-deterministic.ts`), but a
 * review found the same corpus fabrications flowing out of its siblings
 * untouched: `get_stealable_techniques` served an entry's `whatToSteal` prose
 * verbatim — describing a left navigation rail on a 1179x2556 portrait phone
 * screenshot — alongside `source.product` and `source.id`, the exact identity
 * every other served path is built to withhold. `recommend_ui_direction` and
 * `get_color_palette` invented hex values outright. The spec's invariant ("an
 * unverifiable assertion is never served") held for 1 tool of 12.
 *
 * This decorator closes that by construction rather than by discipline: it wraps
 * a CorpusReader and filters every content-bearing method through the per-field
 * `isVerified` predicate, against the FIELD SET the tool actually renders. An
 * entry is returned only when EVERY field in the set is verified — the
 * conservative reading, and the one that cannot over-serve. The field set is
 * declared at wiring time in `createServer`, so a tool added later is gated by
 * construction, not because someone remembered.
 *
 * ONE CONSUMER DELIBERATELY DOES NOT READ THROUGH THIS CLASS: `create_ui_spec`
 * keeps the raw reader (`server-factory.ts`). It gates itself, and it needs the
 * CORPUS-WIDE entry list to build the identity screen's denied-name set —
 * narrowing that set would let an unverified entry's product name stop being
 * screened out of served prose. Trust and identity are independent concerns.
 */
import type { CorpusReader, ReaderImageIndex } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";
import { isVerified } from "./corpus-trust.js";

export class TrustGatedCorpusReader implements CorpusReader {
  constructor(
    private readonly inner: CorpusReader,
    /** The exact keys of the fields this tool renders (wiring-time declaration). */
    readonly fields: readonly string[],
  ) {
    // Double-wrapping would make `trustPosture()` report verified === total (the
    // inner gate already filtered), so every honest "0 of N" message would
    // silently revert to "No X found for those filters". Refuse it outright.
    if (inner instanceof TrustGatedCorpusReader) {
      throw new Error(
        "TrustGatedCorpusReader is already gating this reader; double-wrapping "
        + "would make trustPosture() report everything as verified.",
      );
    }
    // An empty set would make `fields.every(...)` vacuously true and un-gate
    // the whole corpus — the exact failure this class exists to prevent.
    if (fields.length === 0) {
      throw new Error(
        "TrustGatedCorpusReader requires at least one field; an empty field set "
        + "would let every entry pass (every() over [] is true).",
      );
    }
  }

  private passes(entry: CorpusEntryT): boolean {
    return this.fields.every((field) => isVerified(entry, field));
  }

  // ----- Gated: every method whose result becomes served content -------------

  async search(...args: Parameters<CorpusReader["search"]>): ReturnType<CorpusReader["search"]> {
    return (await this.inner.search(...args)).filter((e) => this.passes(e));
  }

  async searchRanked(
    ...args: Parameters<CorpusReader["searchRanked"]>
  ): ReturnType<CorpusReader["searchRanked"]> {
    return (await this.inner.searchRanked(...args)).filter((r) => this.passes(r.entry));
  }

  getById(id: string): CorpusEntryT | undefined {
    const entry = this.inner.getById(id);
    // Refusing by id is the same answer as "no such entry" ON PURPOSE: a distinct
    // "exists but unverified" reply would confirm the entry's existence, which is
    // itself corpus information the caller has not earned.
    return entry !== undefined && this.passes(entry) ? entry : undefined;
  }

  findSimilar(...args: Parameters<CorpusReader["findSimilar"]>): ReturnType<CorpusReader["findSimilar"]> {
    return this.inner.findSimilar(...args).filter((r) => this.passes(r.entry)) as ReturnType<
      CorpusReader["findSimilar"]
    >;
  }

  entriesForAggregation(): readonly CorpusEntryT[] {
    return this.inner.entriesForAggregation().filter((e) => this.passes(e));
  }

  /**
   * The image-embedding index, narrowed to entries verified for every field in
   * this reader's set. `critique_ui` ranks visual similarity through this, so
   * leaving it whole would let an unverified entry become cited critique
   * evidence by the vector route even though every text route refuses it — the
   * gate would hold for prose and leak through pixels.
   */
  async getImageIndex(providerModel?: string): Promise<ReaderImageIndex | null> {
    const index = await this.inner.getImageIndex(providerModel);
    if (index === null) return null;
    const entries: ReaderImageIndex["entries"] = {};
    for (const [id, vector] of Object.entries(index.entries)) {
      const entry = this.inner.getById(id);
      if (entry !== undefined && this.passes(entry)) entries[id] = vector;
    }
    return { dimension: index.dimension, entries };
  }

  // ----- Ungated ------------------------------------------------------------

  /**
   * True when an entry EXISTS but the gate refused it — as opposed to not
   * existing at all. Callers need this to avoid asserting a falsehood:
   * `getById` deliberately answers `undefined` for a refused entry.
   */
  refusedForTrust(id: string): boolean {
    const entry = this.inner.getById(id);
    return entry !== undefined && !this.passes(entry);
  }

  /**
   * How much of the corpus is servable FOR THIS READER'S FIELD SET, so a caller
   * can tell "gated" from "genuinely empty". The count is per field set: a tool
   * gated on `whatToSteal` reports 0 even when 500 entries carry a colour
   * record — the honest message for the claim that tool makes.
   */
  trustPosture(): { verified: number; total: number } {
    const all = this.inner.entriesForAggregation();
    return { verified: all.filter((e) => this.passes(e)).length, total: all.length };
  }

  // Taxonomy labels ARE gated, like every content-bearing method. Each
  // vocabulary is additionally gated on the field it is drawn from
  // (`categories`, `styleTags`, `domainTags`), so a label is advertised only
  // when the entry's own tagging of that label was checked.
  listCategories(...a: Parameters<CorpusReader["listCategories"]>): ReturnType<CorpusReader["listCategories"]> {
    void a;
    return [...new Set(
      this.inner.entriesForAggregation()
        .filter((e) => this.passes(e) && isVerified(e, "categories"))
        .flatMap((e) => e.categories ?? []),
    )];
  }

  listStyleTags(...a: Parameters<CorpusReader["listStyleTags"]>): ReturnType<CorpusReader["listStyleTags"]> {
    void a;
    return [...new Set(
      this.inner.entriesForAggregation()
        .filter((e) => this.passes(e) && isVerified(e, "styleTags"))
        .flatMap((e) => e.styleTags ?? []),
    )];
  }

  listDomainTags(...a: Parameters<CorpusReader["listDomainTags"]>): ReturnType<CorpusReader["listDomainTags"]> {
    void a;
    return [...new Set(
      this.inner.entriesForAggregation()
        .filter((e) => this.passes(e) && isVerified(e, "domainTags"))
        .flatMap((e) => e.domainTags ?? []),
    )];
  }

  indexStatus(...a: Parameters<CorpusReader["indexStatus"]>): ReturnType<CorpusReader["indexStatus"]> {
    return this.inner.indexStatus(...a);
  }

  resolveImagePath(...a: Parameters<CorpusReader["resolveImagePath"]>): ReturnType<CorpusReader["resolveImagePath"]> {
    return this.inner.resolveImagePath(...a);
  }
}
```

- [ ] **Step 4: Update the existing reader tests to pass field sets**

Every existing `new TrustGatedCorpusReader(innerReader())` / `new TrustGatedCorpusReader(inner)` construction in `src/corpus-trust-reader.test.ts` becomes `new TrustGatedCorpusReader(inner, ["whatToSteal"])` (the fixture entries are verified for `whatToSteal` via the Task 1 map fixture). The taxonomy tests use `["categories"]`, `["styleTags"]`, `["domainTags"]` respectively, and the double-wrap guard test becomes `new TrustGatedCorpusReader(once, ["whatToSteal"])` (the constructor now requires the field set before it can reach the double-wrap check).

- [ ] **Step 5: Run the reader suite**

Run: `npx vitest run src/corpus-trust-reader.test.ts src/tool-trust-gate.test.ts`
Expected: `tool-trust-gate.test.ts` fails to compile — `createServer` still constructs the reader with one argument. That is Task 5's wiring; run only the reader suite here:

Run: `npx vitest run src/corpus-trust-reader.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/corpus-trust-reader.ts src/corpus-trust-reader.test.ts
git commit -m "fix(corpus-trust-reader): gate on a per-tool field set declared at wiring time"
```

---

## Task 5: Wire per-tool field sets in `createServer`; posture messages name the field set

**Files:**
- Modify: `src/server-factory.ts` (`createServer` `:96-117`, `emptyCorpusMessage` `:132-144`, `unresolvedIdsMessage` `:153-172`, `corpusEvidenceNote` `:181-195`)
- Modify: `src/tool-trust-gate.test.ts`

**Interfaces:**
- Consumes: `new TrustGatedCorpusReader(inner, fields)` from Task 4.
- Produces: eleven per-tool readers with the spec's exact field sets; the three refusal messages name the reader's field set. Task 6+ redacts the render surfaces that these verified entries now pass.

- [ ] **Step 1: Write the failing wiring tests**

In `src/tool-trust-gate.test.ts`, replace the `entry()` fixture's verification spread with a per-key map, and change the CASES needles that pointed at the entry id to content needles (the id becomes a keyless field in Task 6):

```ts
function verificationFor(fields: readonly string[]): Record<string, unknown> {
  const record = { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "tool-gate-fixture" };
  const map: Record<string, unknown> = {};
  for (const field of fields) map[field] = record;
  return map;
}

const ALL_SERVABLE_FIELDS = [
  "critique", "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks",
  "voice", "visual.dominantColors", "visual.accentColor", "visual.colorRoles",
  "visual.typePairing", "visual.spacingDensity", "visual.cornerStyle",
  "visual.usesShadows", "visual.usesBorders", "layout", "patternType",
  "platform", "categories", "styleTags", "domainTags",
] as const;

function entry(verified: boolean): CorpusEntryT {
  return {
    // ... existing fields unchanged ...
    ...(verified
      ? { provenance: { taggedBy: "auto", verification: verificationFor(ALL_SERVABLE_FIELDS) } }
      : {}),
  } as unknown as CorpusEntryT;
}
```

Change the CASES needles:
- `search_ui_examples`: needle `"gate-tool-entry"` → `"restrained dashboard"`
- `browse_ui_examples`: needle `"gate-tool-entry"` → `"dashboard"`
- `get_similar_ui_examples`: needle `"restrained dashboard"` stays

Add a wiring test that pins the per-tool field sets from the outside:

```ts
it("gates each tool on exactly the fields it renders", async () => {
  // `get_color_palette` serves colorRoles + patternType; an entry verified for
  // critique only must NOT reach it, while `get_stealable_techniques` must
  // still serve from the same entry (whatToSteal verified).
  const fixture = {
    ...entry(true),
    provenance: {
      taggedBy: "auto",
      verification: verificationFor(["critique", "whatToSteal"]),
    },
  };
  const server = createServer(readerWith(fixture));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "field-set-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const palette = await client.callTool({ name: "get_color_palette", arguments: { limit: 5 } });
    const paletteText = ((palette.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
    expect(paletteText).not.toContain("#2563eb");
    expect(paletteText).toMatch(/verif/i);
    const steal = await client.callTool({ name: "get_stealable_techniques", arguments: { limit: 5 } });
    const stealText = ((steal.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
    expect(stealText).toContain(MARKER);
  } finally {
    await client.close();
  }
});
```

Update the "refusal messages read as English" test to the new wording (exact text for `get_ui_example`'s 13-key set would be unwieldy — assert the prefix and that the message names a field):

```ts
it("agrees in number for one id and for several", async () => {
  const one = await callTool(false, "get_ui_example", { id: "gate-tool-entry" });
  expect(one).toMatch(/Entry "gate-tool-entry" exists but is not verified for every field this tool serves/);
  expect(one).toMatch(/visual\.colorRoles/);
  const many = await callTool(false, "compare_ui_examples", {
    ids: ["gate-tool-entry", "gate-tool-entry"],
  });
  expect(many).not.toMatch(/exist but carries|exists but carry/);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tool-trust-gate.test.ts`
Expected: FAIL — `createServer` still calls `new TrustGatedCorpusReader(reader)` with one argument (compile error) and the message text does not name fields.

- [ ] **Step 3: Wire the per-tool field sets**

In `src/server-factory.ts`, replace the whole wiring block — from the line `  const gated = new TrustGatedCorpusReader(reader);` through the line `  registerCritiqueUi(server, gated);` (the `registerCreateUiSpec` line inside the block moves into the new wiring, so it is part of the replaced region) — with:

```ts
  // ----- C3 trust gate (Stage 2a): per-tool field sets at wiring time --------
  // Each registration constructs a reader gated on the exact keys of the fields
  // that tool renders — never wider (over-gating) and never narrower
  // (over-serving). The field set is the contract between the verifier (Stage
  // 2b/2c) and the gate, reviewable in one place. `create_ui_spec` keeps the
  // UNGATED reader on purpose: it gates itself (create-ui-spec-deterministic.ts)
  // AND needs the corpus-wide entry list to build the identity screen's
  // denied-name set.
  registerSearchUiExamples(
    server,
    new TrustGatedCorpusReader(reader, ["critique", "whatToSteal", "antiPatterns", "categories", "styleTags"]),
  );
  registerGetUiExample(
    server,
    new TrustGatedCorpusReader(reader, [
      "critique", "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks",
      "voice", "visual.dominantColors", "visual.accentColor", "visual.colorRoles",
      "visual.typePairing", "visual.spacingDensity", "visual.cornerStyle",
      "visual.usesShadows", "visual.usesBorders",
    ]),
  );
  registerListCategories(server, new TrustGatedCorpusReader(reader, ["categories"]));
  registerListStyleTags(server, new TrustGatedCorpusReader(reader, ["styleTags"]));
  registerListDomainTags(server, new TrustGatedCorpusReader(reader, ["domainTags"]));
  registerGetSimilarUiExamples(
    server,
    new TrustGatedCorpusReader(reader, ["critique", "whatToSteal", "categories", "styleTags", "patternType"]),
  );
  registerCompareUiExamples(
    server,
    new TrustGatedCorpusReader(reader, [
      "critique", "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks",
      "categories", "styleTags", "patternType", "platform", "layout",
      "visual.accentColor", "visual.colorRoles", "visual.spacingDensity",
      "visual.cornerStyle", "visual.usesShadows", "visual.usesBorders",
    ]),
  );
  registerCreateUiSpec(server, reader, options.createUiSpecModel);
  registerRecommendUiDirection(
    server,
    new TrustGatedCorpusReader(reader, [
      "whatToSteal", "antiPatterns", "voice", "visual.colorRoles", "visual.typePairing",
      "visual.spacingDensity", "visual.cornerStyle", "layout", "patternType", "styleTags",
    ]),
  );
  registerGetAntiPatterns(server, new TrustGatedCorpusReader(reader, ["antiPatterns"]));
  registerGetColorPalette(server, new TrustGatedCorpusReader(reader, ["visual.colorRoles", "patternType"]));
  registerGetStealableTechniques(server, new TrustGatedCorpusReader(reader, ["whatToSteal"]));
  registerBrowseUiExamples(server, new TrustGatedCorpusReader(reader, ["patternType"]));
  registerCritiqueUi(server, new TrustGatedCorpusReader(reader, ["patternType", "platform"]));
```

Delete the now-unused `const gated = ...` and its `registerGenerateDesignPrompt` comment block is untouched (the private function is not registered).

- [ ] **Step 4: Name the field set in the posture messages**

Replace `emptyCorpusMessage`, `unresolvedIdsMessage`, and `corpusEvidenceNote` with:

```ts
function emptyCorpusMessage(reader: CorpusReader, noun: string): string {
  const posture = reader instanceof TrustGatedCorpusReader ? reader.trustPosture() : null;
  if (posture !== null && posture.verified < posture.total) {
    return (
      `No ${noun} available: ${posture.verified} of ${posture.total} corpus entries are verified `
      + `for every field this tool serves (${reader.fields.join(", ")}), and corpus content is `
      + `served only from verified entries. This is not a filter problem — broadening the query `
      + `will not change it.`
    );
  }
  return `No ${noun} found for those filters.`;
}
```

```ts
function unresolvedIdsMessage(reader: CorpusReader, ids: readonly string[]): string {
  const gate = reader instanceof TrustGatedCorpusReader ? reader : null;
  const refused = gate === null ? [] : ids.filter((id) => gate.refusedForTrust(id));
  const absent = ids.filter((id) => !refused.includes(id));
  const parts: string[] = [];
  if (refused.length > 0 && gate !== null) {
    const posture = gate.trustPosture();
    const one = refused.length === 1;
    parts.push(
      `${one ? "Entry" : "Entries"} ${refused.map((i) => `"${i}"`).join(", ")} `
      + `${one ? "exists" : "exist"} but ${one ? "is" : "are"} not verified for every field this `
      + `tool serves (${gate.fields.join(", ")}), and corpus content is served only from verified `
      + `entries (${posture.verified} of ${posture.total} verified).`,
    );
  }
  if (absent.length > 0) {
    parts.push(`No entry found with id ${absent.map((i) => `"${i}"`).join(", ")}.`);
  }
  return parts.join(" ");
}
```

```ts
function corpusEvidenceNote(reader: CorpusReader, evidenceCount: number): string {
  if (evidenceCount > 0) return "";
  const posture = reader instanceof TrustGatedCorpusReader ? reader.trustPosture() : null;
  if (posture === null || posture.verified >= posture.total) return "";
  return (
    `\n\n---\n_No corpus evidence backs this critique: ${posture.verified} of ${posture.total} `
    + `corpus entries are verified for every field this tool serves (${reader.fields.join(", ")}) — `
    + `corpus content is served only from verified entries. Every finding above is grounded in the `
    + `uploaded screenshot alone._`
  );
}
```

- [ ] **Step 5: Run the tool-trust-gate suite and the server suites**

Run:
```bash
npx vitest run src/tool-trust-gate.test.ts src/server.test.ts src/mcp-smoke.test.ts src/public-mcp-contract.test.ts
```
Expected: PASS (the public-contract fixture already stamps every servable key from Task 1).

- [ ] **Step 6: Commit**

```bash
git add src/server-factory.ts src/tool-trust-gate.test.ts
git commit -m "fix(server-factory): per-tool trust field sets declared at wiring time — the gate cannot over-serve"
```

---

## Task 6: Keyless redaction — the retrieval tools

**Files:**
- Modify: `src/server-factory.ts` (`registerSearchUiExamples` `:257-282`, `registerGetSimilarUiExamples` `:490-502`, `registerCompareUiExamples` `:541-566`)
- Modify: `src/tool-trust-gate.test.ts`

**Interfaces:**
- Consumes: the per-tool field sets from Task 5.
- Produces: retrieval-tool renders that serve keyed content only — no `source.productName`, `source.url`, entry `id`, or `title` anywhere in served bytes. Task 7 removes the last `cleanTitle` call site.

- [ ] **Step 1: Write the failing redaction tests**

Append to `src/tool-trust-gate.test.ts`:

```ts
describe("keyless redaction — retrieval tools", () => {
  // A verified-content entry must render its content and NOT its identity:
  // productName, url, id and title appear nowhere in the served bytes. The
  // redaction is a rendering property, not a trust field — this holds for the
  // VERIFIED direction, which is the only direction that returns content.
  it.each([
    { tool: "search_ui_examples", args: { query: "dashboard", limit: 3 }, content: "restrained dashboard" },
    { tool: "get_similar_ui_examples", args: { id: "gate-tool-entry" }, content: "restrained dashboard" },
    { tool: "compare_ui_examples", args: { ids: ["gate-tool-entry", "gate-tool-entry"] }, content: "restrained dashboard" },
  ])("$tool renders content without identity", async ({ tool, args, content }) => {
    const served = await callTool(true, tool, args);
    expect(served, `${tool} must still serve keyed content`).toContain(content);
    expect(served, `${tool} leaked productName`).not.toContain("GateCo");
    expect(served, `${tool} leaked source url`).not.toContain("gateco.example.com");
    expect(served, `${tool} leaked entry id`).not.toContain("gate-tool-entry");
    expect(served, `${tool} leaked title`).not.toContain("GateCo — dashboard");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tool-trust-gate.test.ts -t "keyless redaction"`
Expected: FAIL — today these tools render title, id, quality and source lines.

- [ ] **Step 3: Redact `search_ui_examples`**

Replace the summary render in `registerSearchUiExamples` (`:255-281`) with:

```ts
      const concise = responseFormat === "concise";
      const summary = results
        .map((e) => {
          const headerParts = [e.categories.join(", "), e.styleTags.join(", ")].filter(Boolean).join(" | ");
          const lines: string[] = [];
          if (headerParts) lines.push(`### ${headerParts}`);
          if (concise) {
            lines.push(`Critique: ${e.critique.slice(0, 120)}${e.critique.length > 120 ? "…" : ""}`);
          } else {
            lines.push(
              `Critique: ${e.critique}`,
              ``,
              `What to steal:`,
              ...e.whatToSteal.map((t) => `  - ${t}`),
              e.antiPatterns.antiPatterns.length
                ? `Anti-patterns (mistakes avoided):\n${e.antiPatterns.antiPatterns.map((t) => `  - ${t}`).join("\n")}`
                : "",
            );
          }
          return lines.filter(Boolean).join("\n");
        })
        .join("\n\n---\n\n");
```

The old header, `Quality:` line, `Source:` line, and `Image available via get_ui_example:` line are gone: `title`, `id`, `qualityScore`, `productName`, `url` and image availability are all keyless (identity / editorial judgment / an unverified promise about another tool's behaviour).

- [ ] **Step 4: Redact `get_similar_ui_examples`**

Replace the summary render (`:490-502`) with:

```ts
      const summary = [
        `Entries similar to **${source.patternType ?? "this example"}** `
        + `(${[source.categories.join(", "), source.styleTags.join(", ")].filter(Boolean).join(" | ")}), ranked by semantic similarity:`,
        ``,
        ...results.map((r) => {
          const pct = Math.round(Math.max(0, r.score) * 100);
          const header = [r.entry.patternType, r.entry.categories.join(", "), r.entry.styleTags.join(", ")]
            .filter(Boolean)
            .join(" | ");
          return [
            `### ${header} — ${pct}% similar`,
            `Critique: ${r.entry.critique}`,
            `What to steal:`,
            ...r.entry.whatToSteal.map((t) => `  - ${t}`),
          ].join("\n");
        }),
      ].join("\n\n---\n\n");
```

The intro's `(id)` suffix and the per-result title/id headers are gone; headers rebuild from the keyed fields `patternType` + `categories` + `styleTags` (all in this tool's field set).

- [ ] **Step 5: Redact `compare_ui_examples`**

Replace the header and rows (`:541-566`) with:

```ts
      const header = `| Field | ${found.map((e) => cell([e.patternType, ...e.categories, ...e.styleTags].filter(Boolean).join(" — "))).join(" | ")} |`;
      const divider = `| --- | ${found.map(() => "---").join(" | ")} |`;
      const rows = [
        `| categories | ${found.map((e) => cell(e.categories.join(", "))).join(" | ")} |`,
        `| styleTags | ${found.map((e) => cell(e.styleTags.join(", "))).join(" | ")} |`,
        `| platform | ${found.map((e) => (e as Record<string, unknown>).platform ?? "web").join(" | ")} |`,
        `| layout | ${found.map((e) => e.layout?.form ?? "—").join(" | ")} |`,
        `| accent | ${found.map((e) => e.visual.accentColor ?? e.visual.colorRoles?.accent ?? "—").join(" | ")} |`,
        `| density / corners | ${found.map((e) => `${e.visual.spacingDensity} / ${e.visual.cornerStyle}`).join(" | ")} |`,
        `| shadows / borders | ${found.map((e) => `${e.visual.usesShadows ? "yes" : "no"} / ${e.visual.usesBorders ? "yes" : "no"}`).join(" | ")} |`,
        ...(concise ? [] : [
          `| critique angle | ${found.map((e) => firstSentence(e.critique)).join(" | ")} |`,
          `| top steal | ${found.map((e) => top(e.whatToSteal)).join(" | ")} |`,
          `| anti-patterns | ${found.map((e) => top(e.antiPatterns.antiPatterns)).join(" | ")} |`,
          `| a11y risks | ${found.map((e) => topRisk(e.antiPatterns.accessibilityRisks)).join(" | ")} |`,
        ]),
      ];
```

The `id` row, `quality` row and `where it fails` row are dropped (`id` is identity, `qualityScore/qualityTier` is editorial judgment, `whereThisFails` is editorial prose).

- [ ] **Step 6: Run the redaction tests**

Run: `npx vitest run src/tool-trust-gate.test.ts -t "keyless redaction"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server-factory.ts src/tool-trust-gate.test.ts
git commit -m "fix(server-factory): retrieval tools redact identity, editorial prose and editorial judgment"
```

---

## Task 7: `get_ui_example` — redaction, image gate, and the source-URL promise

**Files:**
- Modify: `src/server-factory.ts` (`registerGetUiExample` — description `:293-304`, detail render `:310-345`, image attachment `:350-372`; remove `cleanTitle` `:52-56`)
- Modify: `src/tool-trust-gate.test.ts`
- Modify: `src/public-mcp-contract.test.ts` (image-gate hash)

**Interfaces:**
- Consumes: `verifiedFields(entry)` from Task 1; `reader.fields` from Task 4.
- Produces: `get_ui_example` renders keyed content with no identity; an image attaches only when the entry carries an `image-confirmed` record covering at least one field in the tool's set whose `imageSha256` matches the served file.

- [ ] **Step 1: Write the failing tests**

Append to `src/tool-trust-gate.test.ts`:

```ts
describe("keyless redaction — get_ui_example", () => {
  it("renders the verified record without identity and without the source-URL promise", async () => {
    const served = await callTool(true, "get_ui_example", { id: "gate-tool-entry" });
    expect(served).toContain("restrained dashboard");
    expect(served).toContain("What to steal");
    expect(served).not.toContain("GateCo");
    expect(served).not.toContain("gateco.example.com");
    expect(served).not.toContain("gate-tool-entry");
    expect(served).not.toContain("GateCo — dashboard");
    expect(served).not.toMatch(/view live at|source URL above/i);
  });

  it("attaches image bytes only under an image-confirmed record matching the file", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const root = mkdtempSync(join(tmpdir(), "tool-gate-image-"));
    const imagePath = join(root, "gate.png");
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(24).fill(0)]);
    writeFileSync(imagePath, bytes);
    const matchingSha = createHash("sha256").update(bytes).digest("hex");
    const staleSha = createHash("sha256").update(Buffer.from("different bytes")).digest("hex");

    const entryWithImage = (sha: string): CorpusEntryT => ({
      ...entry(true),
      image: { visibility: "public-own", path: imagePath, width: 1440, height: 900 },
      provenance: {
        taggedBy: "auto",
        verification: {
          ...verificationFor(ALL_SERVABLE_FIELDS),
          critique: { method: "image-confirmed", verifiedAt: "2026-08-04", verifierVersion: "tool-gate-fixture", imageSha256: sha },
        },
      },
    });

    async function callWith(sha: string) {
      const base = readerWith(entry(true));
      const reader: CorpusReader = {
        ...base,
        resolveImagePath: () => imagePath,
        getById: (id: string) => (id === "gate-tool-entry" ? entryWithImage(sha) : undefined),
      };
      const server = createServer(reader);
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "image-gate-test", version: "1.0.0" });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        const res = await client.callTool({ name: "get_ui_example", arguments: { id: "gate-tool-entry" } });
        return (res.content ?? []) as Array<{ type: string; text?: string }>;
      } finally {
        await client.close();
      }
    }

    const matching = await callWith(matchingSha);
    expect(matching.filter((c) => c.type === "image")).toHaveLength(1);
    const stale = await callWith(staleSha);
    expect(stale.filter((c) => c.type === "image")).toHaveLength(0);
    expect(stale.map((c) => c.text ?? "").join("\n")).toMatch(/Image not attached/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tool-trust-gate.test.ts -t "get_ui_example"`
Expected: FAIL — today the response renders the title header, Source line, quality tier, whereThisFails, businessRationale, and the source-URL fallback text.

- [ ] **Step 3: Redact the detail render and description**

In `registerGetUiExample`, replace the tool description's final sentence:

```ts
      description:
        "Fetch the complete record for a single UI example by id, including " +
        "full visual attributes (colors, type pairing, spacing) and the source " +
        "image if it is verified against the current file. If no image is " +
        "attached, the response serves the verified record without image bytes.",
```

Replace the detail array (`:313-345`) with:

```ts
      const detail = [
        `## Critique`,
        entry.critique,
        ``,
        `## What to steal`,
        ...entry.whatToSteal.map((t) => `- ${t}`),
        ``,
        entry.antiPatterns.antiPatterns.length
          ? `## Anti-patterns (mistakes this design avoids)\n${entry.antiPatterns.antiPatterns.map((t) => `- ${t}`).join("\n")}\n`
          : "",
        entry.antiPatterns.accessibilityRisks.length
          ? `## Accessibility risks\n${entry.antiPatterns.accessibilityRisks.map((r) => `- ${formatAccessibilityRisk(r, { includeEvidence: true })}`).join("\n")}\n`
          : "",
        entry.voice
          ? `## Voice\n- Tone: ${entry.voice.tone}\n${entry.voice.examples.map((e) => `- Example: "${e}"`).join("\n")}${entry.voice.avoid.length ? `\n${entry.voice.avoid.map((a) => `- Avoid: ${a}`).join("\n")}` : ""}\n`
          : "",
        `## Visual attributes`,
        `- Dominant colors: ${entry.visual.dominantColors.join(", ")}`,
        `- Accent: ${entry.visual.accentColor ?? "none identified"}`,
        entry.visual.colorRoles
          ? `- Color roles (paste-ready token set): canvas ${entry.visual.colorRoles.canvas}, surface ${entry.visual.colorRoles.surface}, ink ${entry.visual.colorRoles.ink}${entry.visual.colorRoles.muted ? `, muted ${entry.visual.colorRoles.muted}` : ""}, accent ${entry.visual.colorRoles.accent}`
          : "",
        `- Type pairing: ${entry.visual.typePairing.display ?? "?"} / ${entry.visual.typePairing.body ?? "?"}${entry.visual.typePairing.notes ? ` — ${entry.visual.typePairing.notes}` : ""}`,
        `- Spacing density: ${entry.visual.spacingDensity}`,
        `- Corners: ${entry.visual.cornerStyle}`,
        `- Shadows: ${entry.visual.usesShadows ? "yes" : "no"} | Borders: ${entry.visual.usesBorders ? "yes" : "no"}`,
      ]
        .filter(Boolean)
        .join("\n");
```

The title header, Source line, quality-tier line, `Where copying this fails`, and `Business rationale` sections are gone (identity + editorial prose/judgment). All remaining rows are keyed fields in this tool's field set.

- [ ] **Step 4: Gate the image attachment**

Replace the image-attachment block (`:350-372`) with:

```ts
      // Only attach actual image bytes when the entry carries an
      // image-confirmed record covering at least one field in the tool's set
      // whose imageSha256 matches the served file. A `measured` record grounds
      // DOM facts, not pixels — a measured-only entry renders text without
      // bytes, even where visibility would allow them.
      if (entry.image.visibility !== "private" && entry.image.path) {
        const fullPath = reader.resolveImagePath(entry.image.path);
        if (fullPath !== null && existsSync(fullPath)) {
          const bytes = readFileSync(fullPath);
          const data = bytes.toString("base64");
          const sha = createHash("sha256").update(bytes).digest("hex");
          const gate = reader instanceof TrustGatedCorpusReader ? reader : null;
          const imageAttach = gate !== null && [...verifiedFields(entry)].some(
            (field) => gate.fields.includes(field)
              && entry.provenance?.verification?.[field]?.method === "image-confirmed"
              && entry.provenance.verification[field].imageSha256 === sha,
          );
          const ext = entry.image.path.split(".").pop()?.toLowerCase();
          const mimeType =
            ext === "png"   ? "image/png"
            : ext === "webp" ? "image/webp"
            : "image/jpeg";
          if (imageAttach) {
            content.push({ type: "image", data, mimeType });
          } else {
            content.push({
              type: "text",
              text: "\n(Image not attached: no image-confirmed verification matching the current file covers a field this tool serves.)",
            });
          }
        } else {
          content.push({ type: "text", text: "\n(Image file not found locally.)" });
        }
      } else {
        content.push({ type: "text", text: "\n(No redistributable image for this entry.)" });
      }
```

Add the imports at the top of `src/server-factory.ts`:

```ts
import { createHash } from "node:crypto";
import { verifiedFields } from "./corpus-trust.js";
```

- [ ] **Step 5: Remove `cleanTitle`**

`cleanTitle` (`:52-56`) is now unused (Task 6 removed the other three call sites). Delete the function.

- [ ] **Step 6: Update the public-contract fixture for the image gate**

In `src/public-mcp-contract.test.ts`, compute the real hash of the fixture PNG and stamp it on the eligible entry's records so the positive image direction is exercised:

```ts
import { createHash } from "node:crypto";
const PNG_SHA = createHash("sha256").update(PNG_BYTES).digest("hex");
```

In `baseEntry`, replace `imageSha256: "a".repeat(64)` with `imageSha256: PNG_SHA`. Assert the eligible entry's `get_ui_example` response includes an image content item:

```ts
    const imageItems = (eligible.content ?? []).filter((c) => c.type === "image");
    expect(imageItems.length).toBe(1);
```

- [ ] **Step 7: Run the suites**

Run:
```bash
npx vitest run src/tool-trust-gate.test.ts src/public-mcp-contract.test.ts src/server.test.ts src/mcp-smoke.test.ts
```
Expected: PASS. If `public-mcp-contract.test.ts` previously asserted the source-URL fallback text, remove that assertion (the promise is gone by design).

- [ ] **Step 8: Commit**

```bash
git add src/server-factory.ts src/tool-trust-gate.test.ts src/public-mcp-contract.test.ts
git commit -m "fix(server-factory): get_ui_example redacts identity and attaches images only under an image-confirmed record"
```

---

## Task 8: Keyless redaction — aggregations, browse, recommend, and critique

**Files:**
- Modify: `src/server-factory.ts` (`registerGetAntiPatterns` `:705`, `registerGetColorPalette` `:741`, `registerBrowseUiExamples` `:798-825`)
- Modify: `src/recommend.ts` (`contributionNote`, `renderRecommendation` `:104-113`)
- Modify: `src/design-prompt.ts` (`generateBrief` direction/sources, `renderBriefMarkdown` `:174`, `renderBriefTokens` `:213`)
- Modify: `src/critique-retrieval.ts` (`CritiqueEntry` `:30-36`, both projections `:100-107` and `:133-140`)
- Modify: `src/synthesis/context.ts` (`buildSynthesisContext` `:251-259`)
- Modify: `src/tool-trust-gate.test.ts`, `src/recommend.test.ts`, `src/design-prompt.test.ts`, `src/critique-retrieval.test.ts`, `src/critique-ui.test.ts`, `src/critique-ui.integration.test.ts`

**Interfaces:**
- Consumes: the per-tool field sets from Task 5.
- Produces: every remaining tool surface free of `productName`, `url`, `id`, `title`, and the keyless quality tier; `CritiqueEntry` carries only `patternType`, `platform`, `score`.

- [ ] **Step 1: Write the failing redaction tests**

Append to `src/tool-trust-gate.test.ts`:

```ts
describe("keyless redaction — aggregations and browse", () => {
  it.each([
    { tool: "get_anti_patterns", args: { limit: 5 }, content: "shadow depths" },
    { tool: "get_color_palette", args: { limit: 5 }, content: "#2563eb" },
    { tool: "browse_ui_examples", args: {}, content: "dashboard" },
  ])("$tool renders keyed content without identity", async ({ tool, args, content }) => {
    const served = await callTool(true, tool, args);
    expect(served, `${tool} must still serve keyed content`).toContain(content);
    expect(served, `${tool} leaked productName`).not.toContain("GateCo");
    expect(served, `${tool} leaked entry id`).not.toContain("gate-tool-entry");
    expect(served, `${tool} leaked title`).not.toContain("GateCo — dashboard");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/tool-trust-gate.test.ts -t "aggregations and browse"`
Expected: FAIL — anti-pattern citations print ids, the palette prints product + id, and browse prints products + exemplar.

- [ ] **Step 3: Redact the aggregation renders**

In `registerGetAntiPatterns`, replace the citation line with:

```ts
        lines.push(`   _Raised by ${r.count} entr${r.count === 1 ? "y" : "ies"}._\n`);
```

In `registerGetColorPalette`, replace the header line:

```ts
        lines.push(`**${p.patternType}**`);
```

In `registerBrowseUiExamples`, replace the description and the table:

```ts
      description:
        "Summarizes what's in the corpus grouped by patternType — for each pattern, " +
        "the count of matching entries. Use this to discover what's available before " +
        "searching (search_ui_examples needs a query; this doesn't). Optional styleTag " +
        "scopes which entries count.",
```

```ts
      const lines = [`# Corpus by pattern (${results.length} patterns represented${styleTag ? `, scoped to '${styleTag}'` : ""})\n`];
      lines.push("| Pattern | Count |");
      lines.push("| --- | --- |");
      for (const r of results) {
        lines.push(`| ${r.patternType} | ${r.count} |`);
      }
```

The Top-products and Exemplar columns disappear whole (identity + editorial judgment); what remains is the per-pattern count.

- [ ] **Step 4: Redact the recommend render and the brief render**

In `src/recommend.ts`, remove the keyless `qualityTier` branch from `contributionNote` and stop claiming critique:

```ts
function contributionNote(entry: CorpusEntryT): string {
  if (entry.visual.colorRoles) return `color palette + ${entry.patternType}`;
  if (entry.voice?.tone) return `voice/copy + ${entry.patternType}`;
  if (entry.layout?.regions?.length) return `layout structure (${entry.layout.form})`;
  return `${entry.patternType} example`;
}
```

In `renderRecommendation`, drop the product and id from each rationale line:

```ts
  for (const r of rec.rationale) {
    lines.push(`${r.rank}. ${r.note} (relevance ${r.score})`);
  }
```

In `src/design-prompt.ts`, remove the products clause from the direction and redact the sources render. In `generateBrief`, delete the `products` const and change the direction line:

```ts
  const direction = `Build a ${pattern ?? "UI"}${contextClause}. ` +
    `The throughline is ${plurality(entries.map((e) => e.styleTags).flat()) ?? "restraint"}: ` +
    `${form ? `a ${form} structure` : "a clear structure"} with ${plurality(entries.map((e) => e.visual.spacingDensity)) ?? "moderate"} spacing, ` +
    `an accent reserved for interactive elements, and a ${voiceClause} voice. ` +
    `The brief below distills the concrete decisions — each grounded in a specific entry you can inspect with get_ui_example.`;
```

In `renderBriefMarkdown`, replace the sources lines:

```ts
  brief.sources.forEach((s) => lines.push(`- Contributes: ${s.contributes}`));
```

In `renderBriefTokens`, project the sources to keyed content only:

```ts
    sources: brief.sources.map((s) => ({ contributes: s.contributes })),
```

Update `src/recommend.test.ts` and `src/design-prompt.test.ts` assertions that pinned the old product/id render to the new keyed text.

- [ ] **Step 5: Redact the `critique_ui` corpus lane**

In `src/critique-retrieval.ts`, change the projection type and both projection sites:

```ts
export interface CritiqueEntry {
  patternType?: string;
  platform?: string;
  score: number;
}
```

Image mode (`:100-107`):

```ts
        .map((r) => {
          const ce = corpusById.get(r.id)!;
          return {
            score: r.score,
            patternType: ce.patternType,
            platform: ce.platform,
          };
        })
```

Structured fallback (`:133-140`):

```ts
  const entries: CritiqueEntry[] = results.map((r) => ({
    patternType: r.entry.patternType,
    platform: r.entry.platform,
    score: r.score,
  }));
```

In `src/synthesis/context.ts`, rebuild the corpus evidence with an ordinal id and a keyed label (the entry id and title are identity and must not reach served bytes):

```ts
  // ── Corpus-level evidence from retrieval ──────────────────────────────────
  // The response-scoped ordinal is the only id a corpus example may carry: the
  // entry id embeds the product name (identity) and is keyless by the spec.
  for (const [index, entry] of retrieval.entries.entries()) {
    evidence.push({
      id: `corpus:${index}`,
      source: "corpus",
      label: entry.patternType ?? "corpus example",
      detail: entry.patternType ? `Pattern: ${entry.patternType}` : undefined,
    });
  }
```

Update `src/critique-retrieval.test.ts`, `src/critique-ui.test.ts`, and `src/critique-ui.integration.test.ts` fixtures and assertions that used `CritiqueEntry.id`/`title`/`reviewStatus` — they now use the ordinal evidence ids and keyed labels.

- [ ] **Step 6: Run the affected suites**

Run:
```bash
npx vitest run src/tool-trust-gate.test.ts src/recommend.test.ts src/design-prompt.test.ts src/critique-retrieval.test.ts src/critique-ui.test.ts src/critique-ui.integration.test.ts src/public-mcp-contract.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/server-factory.ts src/recommend.ts src/design-prompt.ts src/critique-retrieval.ts src/synthesis/context.ts src/tool-trust-gate.test.ts src/recommend.test.ts src/design-prompt.test.ts src/critique-retrieval.test.ts src/critique-ui.test.ts src/critique-ui.integration.test.ts
git commit -m "fix: redact keyless fields from aggregations, browse, recommend and critique surfaces"
```

---

## Task 9: Doctor reports per key and finds orphan keys

**Files:**
- Modify: `src/scripts/doctor-helpers.ts` (`:517-563`)
- Modify: `src/scripts/doctor.test.ts`

**Interfaces:**
- Consumes: `verifiedFields(entry)` and `SERVABLE_FIELD_KEYS` from Task 1.
- Produces: `unassessed-quality` exempts when `verifiedFields(entry)` is non-empty; `verification-malformed` / `verified-image-missing` / `verified-hash-stale` iterate the record map and name the key; the new `verification-orphan-key` detector flags records under keys nothing reads.

- [ ] **Step 1: Write the failing tests**

Append to `src/scripts/doctor.test.ts`:

```ts
describe("per-key verification integrity", () => {
  it("names the malformed key when one record among several is bad", () => {
    const entry = defectEntry("mixed", {
      provenance: {
        taggedBy: "auto",
        verification: {
          "visual.colorRoles": VERIFICATION,
          critique: { ...VERIFICATION, method: "vibes-confirmed" },
        },
      },
    });
    const found = summarizeCorpusDefects([entry], ALL_IMAGES);
    const malformed = found.filter((f) => f.detector === "verification-malformed");
    expect(malformed).toHaveLength(1);
    expect(malformed[0]!.message).toContain("critique");
    expect(malformed[0]!.message).not.toContain("visual.colorRoles");
  });

  it("reports an orphan key — a record nothing reads", () => {
    const entry = defectEntry("orphan", {
      provenance: {
        taggedBy: "auto",
        verification: {
          "visual.vibes": { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" },
        },
      },
    });
    const found = summarizeCorpusDefects([entry], ALL_IMAGES);
    const orphan = found.filter((f) => f.detector === "verification-orphan-key");
    expect(orphan.length).toBe(1);
    expect(orphan[0]!.message).toContain("visual.vibes");
  });

  it("exempts unassessed-quality when any servable key is verified", () => {
    const entry = defectEntry("assessed-per-key", {
      qualityScore: 3,
      qualityTier: "exceptional",
      provenance: {
        taggedBy: "auto",
        verification: { "visual.colorRoles": VERIFICATION },
      },
    });
    const detectors = summarizeCorpusDefects([entry], ALL_IMAGES).map((f) => f.detector);
    expect(detectors).not.toContain("unassessed-quality");
  });
});
```

Update the detector union at `:267-270` to include `"verification-orphan-key"`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/scripts/doctor.test.ts -t "per-key verification"`
Expected: FAIL — `verification-orphan-key` does not exist and the malformed message does not name a key.

- [ ] **Step 3: Implement the per-key block**

In `src/scripts/doctor-helpers.ts`, change the import (currently `import { isVerified, VERIFICATION_METHODS } from "../corpus-trust.js";` at `:20`) to `import { verifiedFields, SERVABLE_FIELD_KEYS, VERIFICATION_METHODS } from "../corpus-trust.js";` (`isVerified` has no remaining use in this file after this task). Then replace the same block Task 1 replaced — the region from the `// Keyed on \`verifiedFields\`, not on the mere PRESENCE of a record:` comment through the closing `    }` of the `else if` image-check block (the interim Task 1 block) — with:

Before (the exact region to replace):

```ts
    // Keyed on `verifiedFields`, not on the mere PRESENCE of a record: a
    // malformed record would otherwise exempt the entry here while
    // `verification-malformed` fires below.
    if (entry.qualityScore === 3 && entry.qualityTier === "exceptional"
      && verifiedFields(entry).size === 0) {
      push("unassessed-quality", `qualityScore 3 + tier "exceptional" with no verification record — never assessed`);
    }

    const verification = entry.provenance?.verification;
    const validKeys = verifiedFields(entry);
    if (verification && validKeys.size === 0) {
      push("verification-malformed", `verification record present but refused by the trust gate`);
    } else if (verification && validKeys.size > 0) {
      const path = typeof image.path === "string" ? image.path : null;
      const exists = ((): boolean => {
        if (path === null) return false;
        try { return ctx.imageExists(path); } catch { return false; }
      })();
      if (!exists) {
        push("verified-image-missing", `verified entry's image is missing or unresolvable: ${path ?? "(no path)"}`);
      } else {
        const imageConfirmed = Object.values(verification).find(
          (record) => record.method === "image-confirmed" && record.imageSha256,
        );
        if (imageConfirmed) {
          const actual = ((): string | null => {
            try { return ctx.imageSha256(path!); } catch { return null; }
          })();
          if (actual !== null && actual !== imageConfirmed.imageSha256) {
            push(
              "verified-hash-stale",
              `verification records ${imageConfirmed.imageSha256.slice(0, 12)}… but ${path} now hashes to ${actual.slice(0, 12)}…`,
            );
          }
        }
      }
    }
```

After:

```ts
    // The tagger's untouched defaults: score 3 + tier "exceptional" is the
    // placeholder being read as a judgment. The exemption is a real
    // VERIFICATION record under any servable key — this is the one site where
    // any-key suffices, because it is a curation nag, not a serve gate.
    if (entry.qualityScore === 3 && entry.qualityTier === "exceptional"
      && verifiedFields(entry).size === 0) {
      push("unassessed-quality", `qualityScore 3 + tier "exceptional" with no verification record — never assessed`);
    }

    // ── Verification integrity, per key. One malformed record among ten names
    // the key that is wrong, and a record under a key nothing reads is a
    // silent no-op the serve path would never notice.
    const verification = entry.provenance?.verification;
    if (verification) {
      for (const [field, record] of Object.entries(verification)) {
        if (!VERIFICATION_METHODS.has(record.method)) {
          push(
            "verification-malformed",
            `verification record for "${field}" uses method "${record.method}", `
            + `which is not one this build accepts (${[...VERIFICATION_METHODS].join(", ")})`,
          );
          continue;
        }
        if (record.method === "image-confirmed" && !record.imageSha256) {
          push(
            "verification-malformed",
            `verification record for "${field}" is image-confirmed but has no imageSha256`,
          );
          continue;
        }
        if (!SERVABLE_FIELD_KEYS.has(field)) {
          push(
            "verification-orphan-key",
            `verification record for "${field}" is not in the servable field set — `
            + `nothing reads it, so the verifier's check is a silent no-op`,
          );
        }
        const path = typeof image.path === "string" ? image.path : null;
        // `imageExists`/`imageSha256` reach the filesystem through
        // `fromCorpusRelativeImagePath`, which THROWS on any path outside
        // images-*/ (paths.ts:132). A malformed path must produce a finding,
        // not abort the whole `npm run doctor` run.
        const exists = ((): boolean => {
          if (path === null) return false;
          try { return ctx.imageExists(path); } catch { return false; }
        })();
        if (!exists) {
          push(
            "verified-image-missing",
            `entry verified for "${field}" but its image is missing or unresolvable: ${path ?? "(no path)"}`,
          );
        } else if (record.method === "image-confirmed" && record.imageSha256) {
          const actual = ((): string | null => {
            try { return ctx.imageSha256(path!); } catch { return null; }
          })();
          if (actual !== null && actual !== record.imageSha256) {
            push(
              "verified-hash-stale",
              `verification for "${field}" records ${record.imageSha256.slice(0, 12)}… `
              + `but ${path} now hashes to ${actual.slice(0, 12)}…`,
            );
          }
        }
      }
    }
```

Update the existing malformed-record tests (`:594-616`) to the map shape (each malformed record under a key) and assert the key is named.

- [ ] **Step 4: Run the doctor suite**

Run: `npx vitest run src/scripts/doctor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scripts/doctor-helpers.ts src/scripts/doctor.test.ts
git commit -m "feat(doctor): per-key verification findings and the verification-orphan-key detector"
```

---

## Task 10: Per-field disclosure counts

**Files:**
- Modify: `src/create-ui-spec.ts` (`gatedReason` `:1108-1134`, disclosure warning `:1498-1513`)
- Modify: `src/create-ui-spec.test.ts`

**Interfaces:**
- Consumes: `isVerified(entry, field)` from Task 1.
- Produces: the disclosure warning and the `unavailableDecisions` gatedReason rows report per-field counts — one number cannot describe ten claims.

- [ ] **Step 1: Write the failing tests**

Append to `src/create-ui-spec.test.ts`:

```ts
describe("create_ui_spec — per-field disclosure counts", () => {
  it("counts a whatToSteal-only entry toward whatToSteal and no other row", async () => {
    const only = {
      ...entry("disc-wts", "ProductW", "dashboard", { whatToSteal: ["One verified technique."] }),
      provenance: {
        taggedBy: "auto",
        verification: { whatToSteal: { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" } },
      },
    };
    const out = await createUiSpecForAdapter(
      noRefRequest(),
      deps([only], [{ entry: only, score: 5 }]),
    );
    const rows = out.envelope.spec.unavailableDecisions;
    const techniquesRow = rows.find((d) => d.field === "techniques");
    const antiPatternsRow = rows.find((d) => d.field === "antiPatterns");
    expect(techniquesRow?.reason).toMatch(/1 of 1 matched entries are verified for whatToSteal/);
    // The same entry counts toward NO other row.
    expect(antiPatternsRow?.reason).toMatch(/none of the matched entries carry one/);
  });

  it("names per-field counts in the disclosure warning", async () => {
    // Verified for visual.colorRoles ONLY — the warning must report 1 for that
    // field and 0 for every prose field, in the same message.
    const verified = {
      ...corpusEntryWithRoles("disc-v", "#2563eb", "dashboard"),
      provenance: {
        taggedBy: "auto",
        verification: { "visual.colorRoles": { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" } },
      },
    };
    const unverified = corpusEntryWithRoles("disc-u", "#dc2626", "forms");
    const out = await createUiSpecForAdapter(
      noRefRequest(),
      deps([verified, unverified], [
        { entry: verified, score: 5 },
        { entry: unverified, score: 4 },
      ]),
    );
    const warning = out.envelope.warnings.find((w) => w.code === "insufficientCorpusEvidence");
    expect(warning).toBeDefined();
    expect(warning!.message).toMatch(/1 for visual\.colorRoles/);
    expect(warning!.message).toMatch(/0 for whatToSteal/);
    expect(warning!.message).toMatch(/0 for critique/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/create-ui-spec.test.ts -t "per-field disclosure"`
Expected: FAIL — today the counts average across fields ("1 of 2").

- [ ] **Step 3: Make the gatedReason rows per field**

In `src/create-ui-spec.ts`, replace the whole block below — from `  const matchedForReason = resolved.matchedEntries.length;` through the closing `  ];` of `c3TrustGated` — with the replacement that follows. The block is replaced as ONE unit so `gatedEmpty` survives (the replacement still calls it five times); do NOT delete or redefine `gatedEmpty` separately.

Before:

```ts
  const matchedForReason = resolved.matchedEntries.length;
  const verifiedForReason = resolved.matchedEntries.filter((m) => isVerified(m.entry)).length;
  const gatedReason =
    synthesis === null
      ? "Corpus judgment is not synthesized on the model lane; the proposal carries the model's own direction instead."
      : matchedForReason === 0
        // Zero-match and explicit-reference paths consult no corpus entry at all
        // (resolveExplicitReferences returns matchedEntries: [] unconditionally),
        // so a reason about what verified entries did or did not record asserts a
        // consultation that never happened.
        ? "No corpus observations were retrieved for this request, so nothing was available to serve for this field."
        : matchedForReason > 0 && verifiedForReason === 0
        ? "Corpus judgment is served only from entries with a recorded verification; none of the matched entries carry one."
        : verifiedForReason < matchedForReason
          ? `Only ${verifiedForReason} of ${matchedForReason} matched entries carry a recorded verification, and those recorded nothing servable for this field.`
          : "The verified corpus entries recorded nothing servable for this field.";
  const gatedEmpty = (
    field: "techniques" | "antiPatterns" | "componentInventory" | "responsiveBehavior" | "accessibilityConstraints",
  ): boolean =>
    ((synthesis && synthesis[field].length > 0 ? synthesis[field] : specFields[field]) as readonly unknown[])
      .length === 0;
  const c3TrustGated: UiSpecT["unavailableDecisions"] = [
    ...(gatedEmpty("techniques") ? [{ field: "techniques", reason: gatedReason }] : []),
    ...(gatedEmpty("antiPatterns") ? [{ field: "antiPatterns", reason: gatedReason }] : []),
    ...(gatedEmpty("componentInventory") ? [{ field: "componentInventory", reason: gatedReason }] : []),
    ...(gatedEmpty("responsiveBehavior") ? [{ field: "responsiveBehavior", reason: gatedReason }] : []),
    ...(gatedEmpty("accessibilityConstraints") ? [{ field: "accessibilityConstraints", reason: gatedReason }] : []),
  ];
```

After:

```ts
  const matchedForReason = resolved.matchedEntries.length;
  const GATED_FIELD_KEYS: Record<
    "techniques" | "antiPatterns" | "componentInventory" | "responsiveBehavior" | "accessibilityConstraints",
    string
  > = {
    techniques: "whatToSteal",
    antiPatterns: "antiPatterns",
    componentInventory: "components",
    responsiveBehavior: "responsiveBehavior",
    accessibilityConstraints: "antiPatterns.accessibilityRisks",
  };
  const verifiedForKey = (key: string): number =>
    resolved.matchedEntries.filter((m) => isVerified(m.entry, key)).length;
  const gatedReasonFor = (
    field: "techniques" | "antiPatterns" | "componentInventory" | "responsiveBehavior" | "accessibilityConstraints",
  ): string => {
    const key = GATED_FIELD_KEYS[field];
    const verifiedForThisField = verifiedForKey(key);
    return synthesis === null
      ? "Corpus judgment is not synthesized on the model lane; the proposal carries the model's own direction instead."
      : matchedForReason === 0
        ? "No corpus observations were retrieved for this request, so nothing was available to serve for this field."
        : matchedForReason > 0 && verifiedForThisField === 0
          ? "Corpus judgment is served only from entries with a recorded verification for this field; none of the matched entries carry one."
          : verifiedForThisField < matchedForReason
            ? `Only ${verifiedForThisField} of ${matchedForReason} matched entries are verified for ${key}, and those recorded nothing servable for this field.`
            : "The verified corpus entries recorded nothing servable for this field.";
  };
  const gatedEmpty = (
    field: "techniques" | "antiPatterns" | "componentInventory" | "responsiveBehavior" | "accessibilityConstraints",
  ): boolean =>
    ((synthesis && synthesis[field].length > 0 ? synthesis[field] : specFields[field]) as readonly unknown[])
      .length === 0;
  const c3TrustGated: UiSpecT["unavailableDecisions"] = [
    ...(gatedEmpty("techniques") ? [{ field: "techniques", reason: gatedReasonFor("techniques") }] : []),
    ...(gatedEmpty("antiPatterns") ? [{ field: "antiPatterns", reason: gatedReasonFor("antiPatterns") }] : []),
    ...(gatedEmpty("componentInventory") ? [{ field: "componentInventory", reason: gatedReasonFor("componentInventory") }] : []),
    ...(gatedEmpty("responsiveBehavior") ? [{ field: "responsiveBehavior", reason: gatedReasonFor("responsiveBehavior") }] : []),
    ...(gatedEmpty("accessibilityConstraints") ? [{ field: "accessibilityConstraints", reason: gatedReasonFor("accessibilityConstraints") }] : []),
  ];
```

- [ ] **Step 4: Make the disclosure warning per field**

In `src/create-ui-spec.ts`, replace ONLY the trust-disclosure `if` block below — from `  const matchedCount = resolved.matchedEntries.length;` through the closing `  }` of `if (matchedCount > 0 && verifiedCount < matchedCount) {` — with the replacement that follows. The `// Motion is always model-dependent + unavailable in this milestone.` comment, its `warnings.push({ code: "motionEvidenceUnavailable", ... })`, and `return warnings;` after the block are OUTSIDE the replaced region: `tool-contracts.ts:1938` enforces `motionGuidance.evidenceUnavailable ↔ motionEvidenceUnavailable` bidirectionally, and deleting the push makes `refineEnvelope` reject every envelope.

Before:

```ts
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

After:

```ts
  // Trust disclosure, per field. One number cannot describe ten claims: an
  // entry verified for `whatToSteal` only must count toward the whatToSteal
  // row and no other. The message names what was and was not verified rather
  // than reporting one count that averages incomparable things.
  const matchedCount = resolved.matchedEntries.length;
  const DISCLOSED_FIELD_KEYS = [
    "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks", "voice",
    "components", "responsiveBehavior", "visual.colorRoles", "layout",
    "visual.typePairing", "visual.spacingDensity", "visual.cornerStyle",
    "visual.usesShadows", "visual.usesBorders", "styleTags", "categories",
    "mood", "colorScheme", "critique",
  ] as const;
  const perFieldCounts = DISCLOSED_FIELD_KEYS
    .map((field) => `${resolved.matchedEntries.filter((m) => isVerified(m.entry, field)).length} for ${field}`)
    .join(", ");
  const anyShortfall = DISCLOSED_FIELD_KEYS.some((field) =>
    resolved.matchedEntries.filter((m) => isVerified(m.entry, field)).length < matchedCount);
  if (matchedCount > 0 && anyShortfall) {
    warnings.push({
      code: "insufficientCorpusEvidence",
      message:
        `${matchedCount} matched corpus entries. Verified per field — ${perFieldCounts}. ` +
        `Corpus judgment is served only from entries verified for the field that feeds it.`,
    });
  }
```

- [ ] **Step 5: Update the existing disclosure tests**

In `src/create-ui-spec.test.ts`, the three "trust disclosure" tests currently assert `/0 of 1/` and `/1 of 2/`. Update them:

```ts
    expect(warning?.message).toMatch(/0 for visual\.colorRoles/);
```

and

```ts
    expect(warning?.message).toMatch(/1 for visual\.colorRoles/);
```

The "emits no trust warning when every matched entry is verified" test stays green (all per-field counts equal the matched count → no shortfall).

- [ ] **Step 6: Run the create-ui-spec suites**

Run:
```bash
npx vitest run src/create-ui-spec.test.ts src/create-ui-spec-mcp.test.ts src/create-ui-spec-http.test.ts src/create-ui-spec-model-path.test.ts
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/create-ui-spec.ts src/create-ui-spec.test.ts
git commit -m "fix(create-ui-spec): per-field disclosure counts — an entry verified for one field counts toward that field only"
```

---

## Task 11: Whole-change verification, the selector/render sweep, and TODOS

**Files:**
- Modify: `docs/superpowers/TODOS.md` (close the Stage 1 "granting trust would re-ship the fabrication class" tracking note with the per-field correction)
- No production code unless a sweep step finds a gap — a found gap is fixed in this task with its own test first.

**Interfaces:**
- Consumes: everything from Tasks 1-10.
- Produces: a measured mutation gate, a full green suite, and a written sweep proving every served selector and render position maps to exactly one servable key.

- [ ] **Step 1: Run the full suite and tsc**

Run:
```bash
npx tsc
C2_NO_DOTENV=1 npx vitest run
```
Expected: clean compile; all tests PASS.

- [ ] **Step 2: Run the mutation gate**

Prove the per-field predicate is load-bearing across every consumer. Temporarily patch `src/corpus-trust.ts`:

```ts
export function isVerified(entry: CorpusEntryT, field: string): boolean {
  return true; // MUTATION — must fail the suite
}
```

Run: `C2_NO_DOTENV=1 npx vitest run`
Expected: **strictly more than 51 failing tests** (the Stage 1 baseline at `c6b73ba` is exactly 51 — zero margin), because the cross-field, per-tool, redaction and doctor tests added by this plan all die under the mutation. If the count equals 51, find the retired mutation-killed test before committing. Record the measured count in the task review artifact. Revert the patch and re-run: PASS.

- [ ] **Step 3: Run the selector/render sweep**

Walk the table below and confirm each selector/render position reads only through its key's gate. Mark each row `[x]`; any position with no key is a plan bug — fix it in this task with a both-directions test first.

| Served position | Key |
|---|---|
| `createUiSpecDeterministic` colorTokens + threshold | `visual.colorRoles` |
| `get_color_palette` | `visual.colorRoles`, `patternType` |
| `colorTokens` citedDecision | `colorRoleEvidenceIds` |
| `layoutRegions`, layout-form clause | `layout` |
| direction density/corners/shadows/borders clauses | `visual.spacingDensity`, `visual.cornerStyle`, `visual.usesShadows`, `visual.usesBorders` |
| direction typography clause + notes | `visual.typePairing` |
| direction styleTags/categories/mood/colorScheme signals | `styleTags`, `categories`, `mood`, `colorScheme` |
| direction critique clause | `critique` |
| `designDirection` citedDecision | `designDirectionEvidenceIds` |
| techniques + sourceIds | `whatToSteal` |
| antiPatterns + sourceIds | `antiPatterns` |
| accessibilityConstraints + citedDecision | `antiPatterns.accessibilityRisks` |
| contentVoiceGuidance + citedDecision | `voice` |
| componentInventory + citedDecision | `components` |
| responsiveBehavior + citedDecision | `responsiveBehavior` |
| `patternType` evidence fact + browse + similar/compare rows | `patternType` |
| `platform` compare row + critique lane | `platform` |
| taxonomy list tools | `categories`, `styleTags`, `domainTags` |
| `search_ui_examples` content rows | `critique`, `whatToSteal`, `antiPatterns`, `categories`, `styleTags` |
| `get_ui_example` visual rows + voice + critique + steals + a11y | its 13-key set |
| `compare_ui_examples` rows | its 15-key set |
| `critique_ui` corpus evidence | `patternType`, `platform` |

Keyless positions (must be absent from served bytes): `source.productName`, `source.url`, entry `id`, `title`, `businessRationale`, `antiPatterns.whereThisFails`, `qualityScore`, `qualityTier`, image availability promises, and the source-URL fallback text.

- [ ] **Step 4: Update TODOS and the spec status**

In `docs/superpowers/TODOS.md`, close the Stage 1 tracking note that "granting trust from these checks would re-ship the same fabrication class with a trust label attached" with the pointer to this change: per-field verification now attaches trust to the claim, not the entry. In the spec:
- set `**Status:**` from `design approved, spec under review` to `implemented`;
- correct the out-of-scope sentence — the served posture is NOT byte-identical on day one: the strip drops every corpus-observation row from `evidence[]` (they were corpus-derived values whose summaries interpolated unverified facts), while `retrieval.resultCount` keeps reporting retrieved observations and the trust warning carries the explanation. This is the intended tightening, and Task 3's scope ruling records why.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/TODOS.md docs/superpowers/specs/2026-08-05-per-field-verification-design.md
git commit -m "docs: close the Stage 1 trust-granularity note with per-field verification"
```

---

## Self-review

**1. Spec coverage:**

- The record map + per-field predicate → Task 1.
- `verifiedFields` + required field parameter → Task 1 (signature) / Task 2 (bridge).
- Per-field selectors behind the shadow, per-field evidence-id bridge, colorRoles-specific threshold → Task 2.
- The direction's structured clauses each on their own key, citation ids tracked per clause → Task 2.
- The evidence projection strips per field, summary regenerated, all-stripped rows dropped, model lane superseded, served rows' content gated → Task 3.
- `TrustGatedCorpusReader` Option 2 constructor field set, per-tool sets table, taxonomy methods, `getImageIndex`, double-wrap guard, empty-set guard → Tasks 4-5.
- Keyless fields redacted per tool, identity rule widening, public mode redacts, image gate → Tasks 6-8.
- Doctor per-key + orphan-key + `unassessed-quality` via `verifiedFields` → Task 9.
- Disclosure per-field at both call sites → Task 10.
- Testing discipline: both directions, cross-field, mutation ≥51, fixtures unverified by default, real-Zod schema tests, no presence-only assertions → encoded in Tasks 1, 2, 3, 5, 6, 7, 8, 11.
- Out of scope respected: no evidence bundle, no retag, no records written. Day-one posture is NOT byte-identical and is not claimed to be — Task 3 intentionally drops every corpus-observation row from `evidence[]` (their summaries interpolated unverified facts) and Tasks 10/11 change the disclosure warning + gatedReason text. The invariant that holds is the narrower one: no corpus-derived VALUE is served (zero records before and after). The full suite is the regression proof in Task 11; see the Task 3 scope ruling (~`:1191`) and the corrected spec out-of-scope note.
- The render/selector sweep rule (one selector or render position with no key = a plan bug) → Task 11 Step 3.

**2. Placeholder scan:** every code step carries complete code. The only intentionally open spots are assertions in existing tests that pin the old message text or template output (Task 2 Step 7, Task 3 Step 1/6, Task 5 Step 1, Task 8 Step 4, Task 10 Step 5) — each names the exact test and the new assertion to write, because the existing literal cannot be known without running the suite.

**3. Type consistency:**

- `isVerified(entry, field)` — Task 1 definition, used identically in Tasks 2-10.
- `verifiedFields(entry): ReadonlySet<string>` — Task 1, used in Tasks 1, 7, 9.
- `trustedEvidenceIdsOf(entries, field)` — Task 2 signature, used in Task 2.
- `verifiedFor(field)` / `observationsFor(field)` — Task 2, `servedRowIds` intersection added in Task 3.
- `DeterministicSynthesis.colorRoleEvidenceIds` / `.designDirectionEvidenceIds` — Task 2 adds them; `assembleSpec` consumes them in the same task.
- `new TrustGatedCorpusReader(inner, fields)` + `readonly fields` — Task 4 definition, Task 5 constructions and message helpers, Task 7 image gate.
- `sanitizeCorpusObservation(id, entry): SanitizedEvidence | null` — Task 3, call site updated in the same task.
- `CritiqueEntry { patternType?, platform?, score }` — Task 8, consumed by `applyPlatformFilter`/`classifyCoverage`/`buildSynthesisContext` in the same task.

**Two deliberate readings (flag for reviewers):**

1. **The evidence[] day-one change is intended.** Stage 1 serves corpus-observation rows whose summaries interpolate unverified facts; the spec's strip section supersedes the "evidence[] rows stay ungated" note, so dropping all-stripped rows shrinks the served evidence array from day one. `retrieval.resultCount` stays retrieval truth (it counts retrieved observations, `create-ui-spec.test.ts:1360`), and the trust warning explains the gap. The spec's "byte-identical" sentence is corrected in Task 11 Step 4.
2. **A prose field serves only when its entry's row survived the strip** — the row is the citation anchor, and `techniques[].sourceIds` must be members of `spec.provenance.evidenceIds` (`refineEnvelope`, HTTP adapter). A claim without a row cannot be attributed, so it is withheld fail-closed. Task 3 pins this with a test.

**Every replace step is text-anchored.** Where a step replaces a region, the plan quotes the exact "before" block and the complete "after" block (the Task 2 body replacement, the schema field, the retrieval loop, the model-lane block, both doctor blocks, the gatedReason block, and the disclosure block) — no step depends on a line-number range staying accurate under drift.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-05-per-field-verification.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| Eng Review | `/plan-eng-review` | Architecture & tests (required) | 1 | CLEAR | 5 issues (1 P2, 4 P3), all fixed in `0da3fb7` |
| Codex Review | `/codex review` | Independent 2nd opinion | 0 | — | — |

- **VERDICT:** ENG REVIEW CLEARED — the 5 findings landed in `0da3fb7` (per-field voice/mood reasons, redacted-citation promises removed from three tool descriptions, `contributes` fallback no longer claims critique, empty-header fallbacks in similar/compare, and a 500-char bound pin for the disclosure warning). Full suite: 3,404 passing + the new tests; mutation gate 68 > 51.
- **CODEX:** (none this run)

NO UNRESOLVED DECISIONS
