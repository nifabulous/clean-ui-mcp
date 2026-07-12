# Gate 1A Implementation Plan (Revised after two review rounds)

**Date:** 2026-07-12
**Design doc:** `docs/superpowers/specs/2026-07-12-operational-readiness-gate-1a-design.md` (kept in sync with this plan per D21)
**Review decisions:** D1–D13 (first session), D14–D16 (3-agent review), D17–D21 (document-review pass)

## How this plan evolved

The original 10-task plan went through two review rounds:

**Round 1 (three independent agents):** found three structural defects. (1) Wrong-loader P0 — hardened the curator-UI loader while the MCP server uses a different unhardened one. (2) REQUIRED publication field drove 5 unnecessary tasks. (3) Acceptance blocked on image-rights procurement that hadn't started.

**Round 2 (document review):** found five implementation-blocking defects in the revised plan. (F1) Loader provenance can't enforce write protection — `persistEntries` takes a bare array. (F2) Dropping version detection recreates the future-version data-loss class. (F3) Exporter image layout is incompatible with entry paths and server resolution. (F4) Public reader can't delegate to the private global embedding index. (F5) Source-grep leak test can't prove the runtime acceptance claim. Plus: (F6) `.default()` materializes on save, defeating the zero-churn goal; (F7) factory module has import-time side effects; (F8) doctor changes lack TDD.

## Decisions locked

- **D14/D17** — `publication` is `.optional()` with NO default. `evaluatePublication` interprets absence as private/unreviewed. True zero-churn: old entries stay byte-identical through normal saves (matches `pinned` precedent at schema.ts:516).
- **D15** — Consolidate the two loaders into one before hardening.
- **D16** — Fixture-based acceptance. Real image clearance is a deferred "Gate 1A-content" follow-up.
- **D18** — Preserve `images-public/` tree inside the snapshot; inject an asset resolver rooted at the snapshot dir into public-mode server registration (F3 fix).
- **D19** — Keyword-only public mode for Gate 1A (F4 fix). `findSimilar` returns unavailable; `indexStatus` reports a public-mode state that doesn't disclose private totals.
- **D20** — Add an MCP contract suite that invokes all 14 tools against a mixed fixture and scans output for private markers (F5 fix). Source-grep stays as fast DX feedback.
- **D21** — Design doc updated to match this plan. One source of truth.

Folds (correctness fixes, not scope tradeoffs):
- **F1** — `LoadedCorpus` result object (`{source, writable, version, entries}`) at persistence boundaries; `persistEntries` requires it and refuses read-only data.
- **F2** — Version detection kept: `missing | current | supported-old | corrupt | unsupported-newer` even though v2 stays current.
- **F7** — Split pure factory/registration from executable entry point so tests import the factory without opening stdio.
- **F8** — Extract doctor checks into testable functions with fixtures (primary/snapshot/seed/zero-eligible/expired/rejected/missing-evidence) and assert JSON-output stability.

## Sequencing (7 tasks)

```
T1  Consolidate to one loader + harden it (P0, D15) + LoadedCorpus provenance (F1) + version detection (F2)
 ↓
T2  Add optional (no-default) publication field + policy evaluator (D14/D17, D7)
 ↓
T3  Public snapshot exporter: preserve images-public/ tree (D5, D18)
 ↓
T4a CorpusReader: private reader + createServer factory, split from executable entry (D6, D9, F7)
T4b CorpusReader: public reader — keyword-only (D19), re-implements against injected array, needs T2+T3
 ↓
T5  Leak enforcement: source-grep boundary test + MCP contract suite invoking all 14 tools (D20)
 ↓
T6  Doctor diagnostics — testable functions + fixtures (F8)
 ↓
T7  Fixture-based acceptance + holistic review (D16)
```

**Gate 1A-content (deferred, procurement-dependent):** clear ≥1 real image into `images-public/`. Tracked separately.

Gate 1B (transaction layer) is out of scope — handoff constraints in design doc §11.

---

## Task 1 — Consolidate to one loader + harden it (P0, D15, F1, F2)

**Root cause:** two loaders (`corpus.ts:19 loadCorpus` cached/no-fallback/blind-parse, used by all 14 MCP tools; `persistence.ts:57 loadCorpusSafe` snapshot-fallback, used by curator UI). The MCP path is unhardened. Consolidating eliminates the duplication.

### Step 1a — Consolidate

- `corpus.ts:loadCorpus` delegates to `loadCorpusSafe` for the actual read, then caches. Preserve the module-level `cached` let + `setCorpusForTesting` test seam (many tests depend on both).
- All callers (server.ts, corpus.ts internal fns at 232/322/339/344/350/356/379, critique-retrieval.ts, ui-server.ts, scripts) get the same hardened behavior automatically.

### Step 1b — Version-aware decoder + LoadedCorpus (F1, F2)

**`decodeCorpusFile(path)`** returns a discriminated result (F2 — version detection kept even though v2 stays current, so a future `{version:3}` file is distinguished from corrupt):

```ts
type CorpusDecodeResult =
  | { kind: "missing"; path: string }
  | { kind: "current"; path: string; entries: CorpusEntryT[] }      // v2 today
  | { kind: "supported-old"; path: string; entries: CorpusEntryT[] } // a prior version we can still read
  | { kind: "corrupt"; path: string; error: string }
  | { kind: "unsupported-newer"; path: string; version: unknown };   // future version — fail visibly
```

**`LoadedCorpus` result object (F1)** — carries provenance so persistence can enforce write protection:

```ts
type LoadedCorpus = {
  entries: CorpusEntryT[];
  source: "primary" | "snapshot" | "seed" | "empty";
  writable: boolean;   // false for snapshot/seed/empty
  version: number;
};
```

- `tryReadCorpus` returns `LoadedCorpus | null` (or the decode result). No more conflating missing/corrupt into `null`.
- `loadCorpusSafe` returns a `LoadedCorpus`. Seed/snapshot fallbacks are `writable: false`.
- `persistEntries(loaded: LoadedCorpus, ...)` refuses when `loaded.writable === false` — structurally prevents the seed/snapshot → save → clobber path.

### Step 1c — Harden the fallback chain

- **`loadCorpusSafe`** (57-79): seed fallback is READ-ONLY (never restore primary from seed). Snapshot recovery preserves content but does NOT auto-rewrite the primary (remove the `writeAtomic` side effect at line 64). Missing primary → return seed read-only.
- `unsupported-newer` is fatal and untouched — no snapshot/seed fallback, no rewrite.
- Remove hardcoded `{version:2}` at lines 64/102/116 where they cause the overwrite bug; the serialized version comes from the parsed input.

### TDD (`src/persistence.test.ts`, new)

- corrupt primary + valid snapshot → recovers from snapshot, does NOT rewrite primary.
- missing primary + valid seed → returns seed read-only (`writable:false`), does NOT create entries.json.
- unsupported-newer version → fails visibly, does not fall to seed.
- `persistEntries` on a read-only LoadedCorpus → throws (write-protect).
- Future-version file (`{version:3}`) → `unsupported-newer`, not `corrupt`.
- Regression: `setCorpusForTesting` still works (test seam preserved through consolidation).

**Files:** `src/persistence.ts`, `src/corpus.ts`, `src/corpus-version.ts` (new — the decoder), `src/persistence.test.ts` (new).

**Verify:** `npx vitest run src/persistence.test.ts src/corpus.test.ts src/critique-ui.integration.test.ts`

---

## Task 2 — Optional (no-default) publication field + policy evaluator (D14/D17, D7)

### 2a. Schema (`src/schema.ts`)

Add `Publication` as `.optional()` (NO default — F6 fix for true zero-churn):

```ts
export const Publication = z.object({
  visibility: z.enum(["private", "public"]),
  clearance: z.enum(["unreviewed", "approved", "rejected"]),
  rightsBasis: z.enum(["owned", "license", "permission", "public-domain"]).optional(),
  evidenceRef: z.string().min(1).max(200).optional(),
  reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  reviewedBy: z.string().min(1).max(80).optional(),
  expiresAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),  // absent = no recorded expiry
});
// On CorpusEntry:  publication: Publication.optional()
```

Corpus stays `version: z.literal(2)`. Existing 787 entries parse unchanged; a normal save does NOT materialize the field (absent in → absent out). Matches the `pinned` precedent (schema.ts:516). Add `Publication` to `wiring-verification.test.ts` ALLOWLIST.

### 2b. Policy evaluator (`src/publication/policy.ts`, new)

```ts
export function evaluatePublication(
  entry: CorpusEntryT,
  ctx: { now: string; imageExists: (path: string) => boolean }
): PublicationDecision;
```

13 stable reason codes. Eligibility requires ALL: `publication.visibility==="public"` (absent publication → `entry-private`); `clearance==="approved"`; rightsBasis + evidenceRef + reviewer + reviewDate present; `expiresAt` absent or `>= ctx.now`; `image.visibility` is `public-thumb`/`public-own`; image path non-null + starts with `images-public/`; width+height present; resolved image file exists. Returns all applicable reasons in stable order. Mode-agnostic.

### TDD

`schema.test.ts` publication section (valid block accepts; bad enum/date rejects; absent field parses fine — no default materialized). `policy.test.ts` table-driven per reason code + 2 cross-axis tests. Expiry uses injected `now`.

**Files:** `src/schema.ts`, `src/publication/policy.ts` (new), `src/publication/policy.test.ts` (new), `src/wiring-verification.test.ts`.

**Verify:** `npx vitest run src/schema.test.ts src/publication/policy.test.ts src/wiring-verification.test.ts`

---

## Task 3 — Public snapshot exporter (D5, D18)

**New files:** `src/publication/exporter.ts`, `src/publication/manifest.ts`, `src/paths.ts` (add `PUBLIC_SNAPSHOT_DIR`).

**Layout fix (D18/F3):** the snapshot preserves the `images-public/` tree, NOT a flat `images/` dir. Entry paths stay schema-valid (`images-public/foo.png`); no path rewriting.

```
corpus/public-snapshots/<snapshot-id>/
  manifest.json
  entries.json
  images-public/<asset>    ← preserves the path the entry references
```

`exportPublicSnapshot({ corpusEntries, snapshotDir, imageRoot, now })`:
1. Evaluate each entry via `evaluatePublication` → collect eligible.
2. Staging dir `public-snapshots/.staging-<pid>-<rand>/` on the SAME filesystem as destination.
3. Copy eligible assets into `staging/images-public/<asset>` (preserve path structure); resolve symlinks; reject path-traversal that escapes the public image root.
4. Write `entries.json` (eligible only) + the `images-public/` tree.
5. SHA-256 every entry JSON + every asset file. Write `manifest.json` (`schemaVersion:1, corpusVersion:2, snapshotId, generatedAt, entryCount, entriesSha256, assets[]`).
6. Verify hashes match bytes before commit.
7. Directory-atomic `renameSync(stagingDir, finalDir)`. Crash before rename → no visible snapshot.
8. Refuse overwrite of existing snapshot ID.

**Asset resolver (D18):** the exporter produces the snapshot; T4b's `PublicCorpusReader` constructs an asset resolver rooted at the snapshot dir, injected into server registration so `get_ui_example` resolves `images-public/foo.png` against the snapshot root, not the repo corpus root (server.ts:226 today).

Empty-eligible = successful snapshot with `entryCount: 0`.

### TDD (`src/publication/exporter.test.ts`)

FIXTURE corpus (D16) — synthetic eligible entry with a real test image in a temp `images-public/`. Tests: zero-eligible succeeds; one-eligible → snapshot has exactly that entry + asset at `images-public/<asset>` (path preserved); approved-but-image-missing → excluded; interrupt before rename → no final dir; existing snapshot ID → refused; path-traversal/symlink → rejected; hashes match bytes.

**Files:** `src/publication/exporter.ts` (new), `src/publication/manifest.ts` (new), `src/publication/exporter.test.ts` (new), `src/paths.ts`.

**Verify:** `npx vitest run src/publication/exporter.test.ts`

---

## Task 4 — CorpusReader + createServer factory (D6, D9, F7; D19 for public mode)

### T4a — Private reader + factory, split from executable entry (F7)

**`src/corpus-reader.ts`:** `CorpusReader` interface + `PrivateCorpusReader`. PrivateCorpusReader wraps existing corpus.ts functions (which read via the consolidated hardened loader from T1). Private mode preserves current behavior exactly.

```ts
export type CorpusMode = "private" | "public";
export interface CorpusReader {
  search(options: SearchOptions): Promise<CorpusEntryT[]>;
  searchRanked(options: SearchOptions): Promise<SearchResult[]>;
  getById(id: string): CorpusEntryT | undefined;
  findSimilar(id: string, limit?: number): SimilarResult[];
  listCategories(): string[]; listStyleTags(): string[]; listDomainTags(): string[];
  indexStatus(): IndexStatus;
  entriesForAggregation(): readonly CorpusEntryT[];
  resolveImagePath(path: string): string | null;   // D18: roots at the reader's data source
}
```

**F7 module split:**
- `src/server-factory.ts` — `export function createServer(reader: CorpusReader): McpServer` + the `registerXxx` functions. Pure; no side effects on import. Unit + contract tests import THIS.
- `src/server.ts` — the executable entry: `main()` picks mode from `CLEAN_UI_MODE` env (default `"private"`), constructs the reader, calls `createServer(reader)`, connects stdio, logs readiness. The `bin` entry and `mcp-smoke.test.ts` (which spawns `dist/server.js` expecting auto-start) keep working.

The four aggregation handlers (547/583/622/655) use `reader.entriesForAggregation()`. `critique-retrieval.ts` threads a `reader` parameter (replaces `loadCorpus` at 78; `searchRanked` at 121 delegates via reader).

### TDD for T4a

`corpus-reader.test.ts` — private-mode regression: the four aggregation tools + search + retrieval return identical results to pre-refactor. `mcp-smoke.test.ts` still passes (14 tools, readiness signal). `critique-retrieval.test.ts` vi.mock pattern (5 sites) updates to inject reader.

**Files:** `src/corpus-reader.ts` (new), `src/server-factory.ts` (new), `src/server.ts` (slim executable), `src/critique-retrieval.ts`, `src/critique-retrieval.test.ts`.

**Verify:** `npx vitest run src/corpus-reader.test.ts src/mcp-smoke.test.ts src/critique-retrieval.test.ts`; full suite for regressions.

### T4b — Public reader (needs T2 + T3; keyword-only per D19)

**PublicCorpusReader** loads a finalized public snapshot once at construction. **Re-implements** search/retrieval/aggregation against the injected entries array (does NOT wrap corpus.ts functions that read the global cache). `resolveImagePath` roots at the snapshot dir (D18).

**D19 keyword-only:** `searchRanked` does keyword matching only (no vector index). `findSimilar` returns an "unavailable in public mode" result (not the private global index). `indexStatus` reports a public-mode state that does NOT disclose private totals (`{indexed:0, total:<public-only count>, hasIndex:false, ...}`). No snapshot-specific embedding index is built in Gate 1A.

### TDD for T4b

Mixed fixture (eligible public entry, private entry, public-but-unapproved entry, unique marker strings). Public mode never returns private/unapproved IDs, products, image paths, critique text, palettes, tags, markers. Direct lookup of ineligible ID → undefined. `findSimilar` returns unavailable. `indexStatus` reports only public counts.

**Verify:** `npx vitest run src/corpus-reader.test.ts`

---

## Task 5 — Leak enforcement: source-grep + MCP contract suite (D20)

### T5a — Source import boundary (`src/public-import-boundary.test.ts`)

Reuse `wiring-verification.test.ts` readFileSync+regex pattern. Assert: no file under the public-tool-registration boundary (`server-factory.ts` + `corpus-reader.ts` public path) imports the unrestricted loader (`loadCorpus`/`loadCorpusSafe`/`tryReadCorpus`) or `corpus.ts` directly. Fast DX feedback.

### T5b — MCP contract suite (`src/public-mcp-contract.test.ts`, new)

The runtime acceptance proof (F5/D20). Construct a public-mode server via `createServer(new PublicCorpusReader(snapshotDir))` against the mixed fixture (eligible + private + unapproved, unique marker strings). Invoke all 14 corpus-facing tools through the MCP protocol. Scan every response — text content, structured content, image paths, metadata — for private markers (IDs, product names, critique text, palette hex codes, tag names). Assert zero matches.

This is the test that actually proves the acceptance claim. Source-grep (T5a) catches import-time violations; this catches runtime leaks through formatting, aggregation, fallbacks, or image-path construction.

**Pattern:** extends `mcp-smoke.test.ts` (in-process `createServer` invocation is simpler than child-process spawn since the factory is now importable per F7).

**TDD:** write to FAIL first (before T4b, no public reader exists), pass after T4b.

**Files:** `src/public-import-boundary.test.ts` (new), `src/public-mcp-contract.test.ts` (new).

**Verify:** `npx vitest run src/public-import-boundary.test.ts src/public-mcp-contract.test.ts`

---

## Task 6 — Doctor diagnostics (F8 — testable functions + fixtures)

Extract checks into pure, testable functions before the reporting loop (line 173):

1. **Publication-policy:** `summarizePublication(entries, {now, imageExists})` returns tallies (N eligible/private/unreviewed/rejected/missing-evidence/expired). WARN if zero eligible. Surface stable reason codes.
2. **Loader-health:** `summarizeLoaderHealth(loaded: LoadedCorpus)` reports provenance (primary/snapshot/seed) so a curator sees if they're on a fallback path.

**F8 TDD:** `doctor.test.ts` (new) — fixtures for primary/snapshot/seed/zero-eligible/expired/rejected/missing-evidence states; assert both human-readable and `--json` output stability.

**Files:** `src/scripts/doctor.ts`, `src/scripts/doctor.test.ts` (new) or extracted helpers + tests.

**Verify:** `npx vitest run src/scripts/doctor.test.ts`; `npm run doctor`; `npm run doctor -- --json`.

---

## Task 7 — Fixture-based acceptance + holistic review (D16)

1. Full suite: `npm run build && npm test && npm run validate-corpus && npm run doctor`.
2. Exporter against the fixture corpus → non-empty public snapshot with verified hashes, `images-public/` tree preserved.
3. Public-mode reader against that fixture snapshot → MCP contract suite (T5b) green: no private markers leak through any of the 14 tools.
4. Source-grep boundary test (T5a) green.
5. Holistic branch review → branch-review artifact per repo pre-push gate.
6. Task-review artifact for final commit.

---

## Gate 1A-content (deferred, procurement-dependent)

Not on the code critical path. Tracked separately:

- Procure rights for ≥1 image; place in `corpus/images-public/`.
- Set `publication` block (`visibility:"public"`, `clearance:"approved"`, `rightsBasis`, `evidenceRef`, `reviewedAt`, `reviewedBy`) and `image.visibility:"public-own"`.
- Run exporter against real corpus → confirm ≥1 entry.
- Update the tagger's hardcoded `visibility:"private"` (tagger.ts:168/2312/2432) so public entries are representable in the capture flow.
- (Later) build a snapshot-specific embedding index to enable vector search / findSimilar in public mode (D19 deferral).

---

## Acceptance criteria

- [ ] ONE loader serves both MCP and curator paths; both gain snapshot fallback + read-only seed.
- [ ] `LoadedCorpus` carries provenance; `persistEntries` refuses read-only data (F1).
- [ ] Version detection distinguishes missing/current/supported-old/corrupt/unsupported-newer (F2).
- [ ] No load/save path silently overwrites the primary from a fallback.
- [ ] `publication` is `.optional()` with no default; existing entries stay byte-identical through saves (D17/F6).
- [ ] `evaluatePublication` is the sole eligibility source; absence interpreted as private/unreviewed.
- [ ] Exporter preserves the `images-public/` tree; entry paths stay schema-valid (D18/F3).
- [ ] Public-mode server resolves image paths via an injected asset resolver rooted at the snapshot dir.
- [ ] Private reader mode preserves existing tool behavior (regression).
- [ ] Public reader mode is keyword-only (D19); `findSimilar` unavailable; `indexStatus` discloses no private totals.
- [ ] Public reader mode leaks no private/unapproved marker data through any tool path — proven by MCP contract suite invoking all 14 tools (D20/F5).
- [ ] Source-grep boundary test green (T5a).
- [ ] `doctor`, validation, build, full test suite pass.
- [ ] Holistic review approved per CLAUDE.md.

## NOT in scope

- v3 schema bump / migrator / seed migration (eliminated by D14/D17).
- Real image-rights procurement (Gate 1A-content, deferred).
- Snapshot-specific embedding index (D19 deferral — keyword-only public mode for Gate 1A).
- Gate 1B (transaction layer — design doc §11 constraints).
- Gate 2 (npm `files`/deps/publish), Gate 3 (HTTP/auth/billing/hosted).
- Database migration, multi-region infra, HA.
- Power-loss guarantees beyond documented filesystem durability.

## What already exists (reused)

| Existing | Reuse |
|---|---|
| `writeAtomic`, `writeRawSnapshot`, `writeSnapshot` (persistence.ts) | snapshot + atomic writes |
| `Corpus`/`CorpusEntry` Zod schemas (schema.ts) | extended with `.optional()` field, no version bump |
| `aggregations.ts` entries-accepting pure functions | already injectable; 4 call sites in server.ts change |
| `setCorpusForTesting` (corpus.ts:36) | test seam preserved through consolidation |
| `wiring-verification.test.ts` readFileSync+regex | template for source-grep boundary test |
| `mcp-smoke.test.ts` pattern | extended for the MCP contract suite (T5b) |
| `doctor.ts` check-array pattern | two new checks, extracted to testable functions (F8) |
| `keywordSearch` (corpus.ts:62) | public-mode search uses this path directly |

## Parallelization (corrected)

Strictly linear critical path: T1 → T2 → T3 → T4a → T4b → T5 → T7. T6 (doctor) can run parallel after T2. No other parallelism — T4b needs T2+T3, T5 needs T4b.

**Conflict flag:** T1 and T4a both touch `corpus.ts`/`persistence.ts`-adjacent surfaces. T1 (consolidation) must land before T4a starts.
