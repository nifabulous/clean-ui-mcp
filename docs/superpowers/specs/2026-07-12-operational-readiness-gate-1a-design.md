# Operational Readiness Gate 1A: Publication Integrity Design

**Date:** 2026-07-12

**Status:** Revised per implementation-plan review (decisions D14–D21, 2026-07-12). See `docs/superpowers/plans/2026-07-12-gate-1a-implementation-plan.md` for the current task-level plan; the two documents are kept in sync.

**Supersedes:** The Gate 1A portion of the pasted “clean-ui-mcp — Operational
Readiness Plan (v2)”

**Scope:** Version-aware corpus loading, optional publication metadata,
publication policy, public snapshot generation, and mode-aware corpus-reader
wiring

**Revision note (D14–D21):** Three requirements from the original version of
this doc were reversed after two review rounds and are reflected below:
- The `publication` field is **optional with no default** (not a required v3
  field). Corpus stays `version: 2`. This avoids a migrator and keeps existing
  entries byte-identical through normal saves (matches the `pinned` precedent
  at schema.ts:516). The policy evaluator interprets absence as
  private/unreviewed.
- Acceptance is **fixture-based**. The "non-empty cleared proof set" is a
  deferred "Gate 1A-content" follow-up that depends on image-rights
  procurement; it is not on the code critical path.
- The leak gate is a **source import-graph test plus a runtime MCP contract
  suite** (not a built-artifact scan). The project has no bundler and no
  barrel files, so a compiled-JS scan buys nothing over source analysis.

## Objective

Make publication safety a permanent, mechanically enforced property of the
corpus before any npm or hosted distribution work begins.

Gate 1A must ensure that:

1. loading a corrupt or unsupported-future-version corpus cannot replace,
   truncate, or silently reinterpret the curator's working corpus;
2. publication permission and publication intent are recorded separately;
3. an entry is publishable only when both its entry metadata and image metadata
   permit redistribution;
4. public artifacts are generated from an explicit allow-set and never contain
   the private source corpus; and
5. every MCP tool and internal retrieval path reads through a construction-time
   corpus mode instead of selecting visibility ad hoc.

This gate produces a validated, non-empty public corpus snapshot (from a
fixture corpus — see §4.3) as proof that the full publication path works. It
does not publish an npm package or add a hosted MCP transport.

## Why Gate 1A Comes First

The current corpus durability layer conflates several failure modes into a
single `null`: `tryReadCorpus` (persistence.ts:44-49) returns `null` for
missing, corrupt, and schema-unparseable files alike. The fallback chain then
"recovers" by rewriting the primary from a snapshot or — worse — returning the
one-entry seed, which a later save can persist over the curator's 787-entry
working corpus. A future corpus version would be indistinguishable from corrupt
data and trigger the same recovery path.

The corpus envelope stays `version: 2` for Gate 1A (there is no v3 bump — see
§2). But the loader must still distinguish missing / current / supported-old /
corrupt / unsupported-newer so that a future version is never mistaken for
corrupt data and funneled into snapshot recovery. The version-aware loader is
the P0 first task. No publication field, exporter, or reader refactor may land
before the loader can make those distinctions and refuse to overwrite a real
primary from a fallback.

## Design Principles

1. **Default deny.** Existing and unclassified entries remain private.
2. **Absence is not corruption.** Seed fallback is permitted only when the
   primary corpus is genuinely absent.
3. **Older is not corrupt.** A supported older version is loaded only through an
   explicit compatibility path and is never rewritten implicitly.
4. **Rights basis is not approval.** The reason publication may be permitted is
   recorded separately from the human clearance decision.
5. **Entry and asset must agree.** Public eligibility requires both entry-level
   clearance and a redistributable image.
6. **Physical isolation beats filtering.** Public artifacts contain only a
   generated public snapshot, never a filtered view over packaged private data.
7. **One policy function.** Runtime readers, exporters, diagnostics, and package
   checks consume the same publication decision.
8. **Mode is construction-time state.** MCP requests cannot select or override a
   private/public corpus mode.

## Existing Foundations

Gate 1A extends these existing components:

- `Corpus` and `CorpusEntry` Zod validation in `src/schema.ts`;
- `ImageRef.visibility`, including `private`, `public-thumb`, and `public-own`;
- the `images-private/` and `images-public/` path invariant;
- `loadCorpusSafe`, snapshots, and atomic single-file writes in
  `src/persistence.ts`;
- corpus search and retrieval helpers in `src/corpus.ts`;
- fourteen MCP tool registrations in `src/server.ts`;
- MCP smoke tests and production wiring verification; and
- write-time validation and `doctor` diagnostics.

The current global `loadCorpus()` call graph is a migration surface, not a new
parallel implementation. Gate 1A replaces unrestricted global access with one
reader dependency.

## Architecture

```text
                    private corpus files
              current-version entries / snapshots
                              |
                              v
                   version-aware corpus decoder
       missing | current | supported-old | corrupt | unsupported-newer
                              |
                 +------------+-------------+
                 |                          |
                 v                          v
       private CorpusReader          (no migration step —
                 |                    publication is optional)
                 |                          |
                 |                          v
                 |                 publication policy
                 |              entry clearance AND image
                 |                          |
                 |                          v
                 |               immutable public snapshot
                 |                manifest + content hashes
                 |                          |
                 +------------+-------------+
                              |
                              v
                 mode-bound MCP tool registry
                   private mode | public mode
```

## 1. Version-Aware Corpus Loading

### 1.1 Raw envelope detection

Introduce one decoder shared by production loading, safe loading, validation,
restoration, and corpus scripts. It parses the JSON envelope before selecting a
version-specific schema. Version detection is retained even though the corpus
stays at the current version (F2): a future version must be distinguishable
from corrupt data so it is never funneled into snapshot recovery.

```ts
type CorpusDecodeResult =
  | { kind: "missing"; path: string }
  | { kind: "current"; path: string; corpus: CorpusT }
  | { kind: "supported-old"; path: string; corpus: unknown }
  | { kind: "corrupt"; path: string; error: string }
  | { kind: "unsupported-newer"; path: string; version: unknown };
```

`missing` applies only when no file exists at the requested path. Invalid JSON,
invalid schema data, and an unknown version are never collapsed into `missing`.

### 1.2 Safe-load behavior

The safe loader follows this decision tree:

```text
primary missing?
  yes -> try seed -> return seed or empty (read-only), without creating entries.json
  no  -> decode primary
           current -> return (writable)
           supported-old -> return read-only (no implicit upgrade)
           corrupt -> inspect snapshots of supported versions (read-only recovery)
           unsupported-newer -> fail visibly; do not inspect seed or rewrite
```

Snapshot recovery may return only a schema version the loader explicitly
supports. Recovery preserves the recovered content; it must not rewrite the
primary. All fallback results are read-only.

### 1.3 Write protection (LoadedCorpus provenance)

The loader returns a `LoadedCorpus` object carrying `source`
(primary/snapshot/seed/empty), `writable`, `version`, and `entries`.
`persistEntries` requires a `LoadedCorpus` and refuses when `writable === false`
— structurally preventing the seed/snapshot → save → clobber path. The curator
UI must show an actionable error when the primary is unwritable (snapshot/seed
fallback) instead of opening it as editable state.

Unknown newer versions are fatal and untouched. The error identifies the path
and encountered version without printing corpus content.

## 2. Optional Publication Metadata

### 2.1 Publication block

The `publication` field is **optional with no default** on `CorpusEntry`
(D14/D17). Corpus remains `version: 2`. Existing entries parse unchanged and,
critically, a normal save does **not** materialize the field — absence in
stays absence out. This matches the `pinned` precedent (schema.ts:516) and
avoids a one-time rewrite of all 787 entries.

```ts
publication: z.object({
  visibility: "private" | "public";
  clearance: "unreviewed" | "approved" | "rejected";
  rightsBasis?: "owned" | "license" | "permission" | "public-domain";
  evidenceRef?: string;
  reviewedAt?: string;   // YYYY-MM-DD
  reviewedBy?: string;
  expiresAt?: string;    // YYYY-MM-DD; absent means no recorded expiry
}).optional()
```

The policy evaluator (§3) interprets an absent `publication` field as
`{ visibility: "private", clearance: "unreviewed" }` — the safest possible
state. No migration is required; no migrator ships in Gate 1A.

The schema validates representation when the field is present:

- enum membership;
- date format;
- bounded, non-empty reviewer and evidence references;
- clearance-dependent field shape; and
- rejection/unreviewed states not carrying misleading approval metadata.

The schema does not decide whether an entry may be published. That decision
belongs to the shared policy evaluator so `doctor` can report stable policy
reasons rather than only generic parse errors.

### 2.2 No migration step

Because the field is optional with no default, there is no v2→v3 migration.
The loader still needs version-aware decoding (§1) to distinguish a
genuinely corrupt file from an unsupported future version, but the corpus
envelope stays `version: 2` and existing writer paths are unaffected.

Image visibility and entry publication remain independent. A public image does
not make its entry public, and approving an entry does not change a private
image.

## 3. Publication Policy

Place the single evaluator in `src/publication/policy.ts`.

```ts
type PublicationReason =
  | "entry-private"
  | "clearance-unreviewed"
  | "clearance-rejected"
  | "missing-rights-basis"
  | "missing-evidence"
  | "missing-reviewer"
  | "missing-review-date"
  | "clearance-expired"
  | "image-private"
  | "image-path-missing"
  | "image-path-not-public"
  | "image-file-missing"
  | "image-metadata-missing";

type PublicationDecision =
  | { eligible: true }
  | { eligible: false; reasons: PublicationReason[] };
```

Eligibility requires all of the following:

- `publication.visibility === "public"`;
- `publication.clearance === "approved"`;
- a rights basis, evidence reference, reviewer, and review date exist;
- `expiresAt` is absent or not earlier than the evaluator's injected date;
- **one of two image modes:**
  - **Raster mode:** `image.visibility` is `public-thumb` or `public-own`,
    the image path is non-null and starts with `images-public/`, width and
    height are present, and the resolved image file exists under the public
    image root; OR
  - **Link-only mode:** `image.visibility` is `"private"` AND `image.path`
    is `null` (no image bytes ship). The entry's value is its structured analysis
    (critique, color roles, type pairings, anti-patterns) — no per-image raster
    redistribution clearance required. `source.url` is recommended (links to the
    original design) but not required; some entries lack a URL (apps with no
    public web presence, defunct products).

**Link-only limitations (tracked for Gate 2 planning):**

- *Link rot:* `source.url` points to the live product, which may change or
  disappear. In raster mode the packaged image is the snapshot-in-time record;
  in link-only mode the analysis may outlive the design it describes. Consider
  capturing an archive.org snapshot URL at curation time (future schema field).
- *Entry-level clearance still required:* metadata-only eliminates per-image
  raster redistribution clearance, but each entry still needs a human-reviewed
  `publication` block (`clearance: "approved"`, evidence, reviewer, date). The
  derived metadata (`whatToSteal`, critique) describes third-party designs — the
  derivative-work question on those descriptions is a low-but-nonzero risk that
  entry-level review addresses, not the raster exclusion alone.
- *`critique_ui` quality regression:* in public (keyword-only) mode,
  `critique_ui` finds tag-similar entries via structured fallback, not
  visually-similar entries via image embeddings. This is a real quality loss
  for the tool whose value proposition is visual similarity. A snapshot-specific
  embedding index (deferred to a future gate) restores full fidelity.

The evaluator receives the current date and image-resolution capability through
an explicit context, making expiry and file checks deterministic in tests. It
returns all applicable reasons in stable order.

## 4. Immutable Public Snapshot

### 4.1 Export shape

The exporter consumes the validated corpus and produces a versioned directory.
The `images-public/` tree is **preserved** (D18/F3) so entry paths stay
schema-valid and the public reader can resolve them via an asset resolver
rooted at the snapshot dir:

```text
corpus/public-snapshots/<snapshot-id>/
  manifest.json
  entries.json
  images-public/<asset>     ← preserves the path entries reference
```

The manifest contains:

```ts
interface PublicSnapshotManifest {
  schemaVersion: 1;
  corpusVersion: 2;          // corpus stays v2 (no v3 bump)
  snapshotId: string;
  generatedAt: string;
  entryCount: number;
  entriesSha256: string;
  assets: Array<{
    path: string;
    sha256: string;
    bytes: number;
  }>;
}
```

Snapshot IDs are content-derived or collision-resistant and immutable. The
exporter refuses to overwrite an existing snapshot ID.

### 4.2 Directory-atomic publication

The exporter writes to a unique staging directory on the same filesystem as the
snapshot destination. It copies eligible assets, writes entries and the
manifest, verifies every hash, then renames the completed staging directory to
its final versioned path.

Consumers ignore staging directories. A crash before rename leaves no visible
final snapshot. Recovery may delete an abandoned staging directory after
verifying that it is not referenced by an active operation.

The exporter never replaces a non-empty current directory. If a future consumer
needs an active snapshot, it switches a small pointer manifest atomically after
the immutable snapshot is finalized.

### 4.3 Fixture-based proof (D16)

Gate 1A acceptance is proven against a **fixture corpus** (synthetic eligible
entry with a real test image in a temp `images-public/` dir), not against
real cleared content. The exporter must produce at least one eligible entry
from that fixture in the acceptance run.

A separate **Gate 1A-content** track — deferred, procurement-dependent —
covers clearing real images into `corpus/images-public/`. It is not on the
code critical path and does not block Gate 1A acceptance.

Tests also cover a valid zero-eligible-entry corpus. Empty output is a
successful snapshot with `entryCount: 0`, not an exporter crash or permission
bypass.

## 5. Mode-Aware CorpusReader

### 5.1 Interface

All MCP corpus access flows through an injected reader. The reader exposes the
operations needed by tools rather than a mutable entries array. It also owns
image-path resolution so public mode roots at the snapshot directory (D18).

```ts
interface CorpusReader {
  search(options: SearchOptions): Promise<CorpusEntryT[]>;
  getById(id: string): CorpusEntryT | undefined;
  findSimilar(id: string, limit?: number): SimilarResult[];
  listCategories(): string[];
  listStyleTags(): string[];
  listDomainTags(): string[];
  entriesForAggregation(): readonly CorpusEntryT[];
  indexStatus(): IndexStatus;
  resolveImagePath(path: string): string | null;
}
```

Public mode is **keyword-only** for Gate 1A (D19): `findSimilar` reports
unavailable, and `indexStatus` discloses no private-corpus counts. A
snapshot-specific embedding index is deferred to Gate 1A-content.

The exact interface may be narrowed during implementation planning, but it must
cover all production call sites and may not expose mutation.

### 5.2 Construction modes

```ts
type CorpusMode = "private" | "public";
```

- Private mode reads the validated working corpus and preserves current curator
  behavior.
- Public mode reads only a finalized public snapshot.

Mode is fixed when the MCP server is constructed. Tool input, environment data
supplied by an MCP caller, and request metadata cannot change it. The npm runtime
will later construct only a public reader and will not package private corpus
paths.

### 5.3 Registration boundary

Tool registration becomes a function receiving the reader and other explicit
dependencies, split into a pure factory module (`server-factory.ts`) and a
slim executable entry (`server.ts`) so tests can import the factory without
opening stdio (F7). No public tool-registration module may import the
unrestricted working-corpus loader.

Reader-migration scope is determined by production call sites, not by counting
tool handlers. Implementation planning must inventory direct and indirect
`loadCorpus()` uses, including aggregation and critique-retrieval paths, plus
the internal `corpus.ts` calls that bypass the reader.

## 6. Error Handling

| Condition | Required behavior |
|---|---|
| Primary corpus absent | Seed may be used read-only; never create or overwrite the primary |
| Primary corpus is current version | Load normally (writable) |
| Primary corpus is a supported older version | Return read-only; no implicit upgrade |
| Primary corpus JSON/schema corrupt | Attempt supported-version snapshot recovery (read-only) |
| Primary has unsupported newer version | Fail visibly; do not fall back, recover, or rewrite |
| Snapshot is a supported version | Recover as read-only; never rewrite the primary |
| `persistEntries` receives read-only `LoadedCorpus` | Refuse (write-protect) |
| Publication entry is ineligible | Exclude it and report deterministic reason codes |
| Eligible entry image disappears | Exclude entry; exporter fails the requested non-empty proof run |
| Export staging copy fails | Leave no final snapshot; retain or clean isolated staging safely |
| Final snapshot ID already exists | Refuse overwrite; verify existing snapshot separately |
| Public reader sees invalid manifest/hash | Refuse startup; never serve a partial snapshot |
| Private reader is used by public registration | Source-boundary test and CI fail |

## 7. Testing Strategy

### 7.1 Loader (no migration — version detection only)

- missing primary with valid seed returns read-only seed, does not create entries.json;
- corrupt primary with valid snapshot recovers read-only, does not rewrite primary;
- unsupported newer version fails visibly, does not fall back or rewrite;
- supported-old version returns read-only, no implicit upgrade;
- snapshot recovery preserves content read-only;
- `persistEntries` on a read-only `LoadedCorpus` throws (write-protect); and
- `setCorpusForTesting` still works (test seam preserved through consolidation).

### 7.2 Publication policy and exporter

- table-driven coverage of every reason code and eligible combination;
- absent `publication` field is interpreted as private/unreviewed (entry-private reason);
- entry approval cannot override private image visibility;
- public image visibility cannot override private entry visibility;
- expiry uses an injected date;
- missing image and path escape attempts fail;
- one source asset cannot escape the public image root through traversal or
  symlink resolution;
- generated entry and asset hashes match bytes on disk;
- the snapshot preserves the `images-public/` tree (entry paths stay valid);
- exporter interruption before directory rename exposes no final snapshot;
- existing immutable snapshot is never overwritten;
- zero-entry export succeeds; and
- the fixture proof set exports at least one entry.

### 7.3 Reader and MCP leak contracts

Use the same fixture corpus in private and public modes. It contains an eligible
public entry, a private entry, and a public-but-unapproved entry, each with unique
marker strings.

- private mode preserves current search, retrieval, similarity, critique, and
  aggregation behavior;
- public mode never returns private or unapproved IDs, products, image paths,
  critique text, palettes, tags, or marker strings;
- direct lookup of an ineligible ID behaves as not found;
- every registered corpus-facing tool is covered through MCP contract tests;
- production source architecture forbids public tool registration from importing
  unrestricted loaders; and
- new production exports remain covered by wiring verification.

Leak enforcement runs in two layers (D20 — revised; the prior built-artifact
scan was dropped because the project has no bundler, no barrel files, and
plain `tsc`, so a compiled-JS scan buys nothing over source analysis):

1. **Source import boundary (developer feedback).** Static analysis of the
   TypeScript source verifies that no public tool-registration module imports
   the unrestricted working-corpus loader. Reuses the `wiring-verification.test.ts`
   readFileSync + regex pattern. This gives fast feedback during development
   and catches direct imports.
2. **MCP contract suite (the runtime gate).** Construct a public-mode server
   via `createServer(new PublicCorpusReader(snapshotDir))` against the mixed
   fixture (eligible + private + unapproved entries with unique marker
   strings). Invoke all fourteen corpus-facing tools through the MCP protocol
   and scan every response — text content, structured content, image paths,
   metadata — for private markers. This is the test that actually proves the
   "no marker leaks through any tool path" acceptance claim; source analysis
   alone cannot catch runtime leaks through formatting, aggregation, fallbacks,
   or image-path construction.

Both layers run in CI. The contract suite is the acceptance gate; the source
boundary exists to fail fast in the editor before a server construction is
needed.

## 8. Delivery Order

Gate 1A is implemented in this order (see the implementation plan for TDD
scopes and verify commands):

1. Consolidate the two loaders into one and harden it: version-aware decoder,
   `LoadedCorpus` provenance, write-protect, read-only fallbacks.
2. Add the optional `publication` field (no default) and the shared publication
   policy evaluator.
3. Add the immutable public snapshot exporter (preserve `images-public/` tree,
   directory-atomic commit, manifest with hashes).
4. Introduce mode-aware `CorpusReader`: private reader + `createServer` factory
   split from the executable entry; then public reader (keyword-only,
   re-implements against the snapshot's injected entries).
5. Add leak enforcement: source import-boundary test + MCP contract suite
   invoking all fourteen tools.
6. Extend `doctor` with publication-policy and loader-health diagnostics
   (extracted to testable functions).
7. Run the fixture-based Gate 1A verification and holistic branch review.

Every implementation task follows TDD and the repository's task-review gate.
Structural loader work lands before reader rewiring so regressions remain
bisectable. Real image-rights clearance is a separate, deferred
"Gate 1A-content" track.

## 9. Gate 1A Acceptance Criteria

- One loader serves both MCP and curator paths; both gain snapshot fallback
  and read-only seed.
- `LoadedCorpus` carries provenance; `persistEntries` refuses read-only data.
- Version detection distinguishes missing / current / supported-old / corrupt /
  unsupported-newer.
- No ordinary load or save path silently overwrites the primary from a fallback.
- A valid v2 primary is never mistaken for missing or corrupt data.
- Seed fallback occurs only when the primary is genuinely absent.
- `publication` is optional with no default; existing entries stay
  byte-identical through normal saves.
- The shared policy evaluator is the only source of publication eligibility;
  absence is interpreted as private/unreviewed.
- Eligibility requires both entry clearance and redistributable image state.
- A finalized public snapshot contains only eligible entries and public assets,
  with verified hashes, no private-source paths, and the `images-public/` tree
  preserved.
- Public-mode image resolution roots at the snapshot directory via an injected
  asset resolver.
- The acceptance run produces a non-empty public snapshot from the fixture
  corpus; empty-corpus behavior is also tested.
- Private reader mode preserves existing tool behavior.
- Public reader mode is keyword-only for Gate 1A (`findSimilar` unavailable,
  `indexStatus` discloses no private totals).
- Public reader mode reveals no marker data from private or unapproved entries
  through search, retrieval, critique, metadata listing, or aggregation —
  proven by the MCP contract suite invoking all fourteen tools.
- The source import-boundary test prevents new unrestricted-loader bypasses.
- `doctor`, corpus validation, build, offline tests, MCP smoke tests, and wiring
  verification pass without relying on a historical test-count assertion.
- Task-level reviews and a final holistic review are approved according to
  `CLAUDE.md`.

## 10. Explicitly Not in Scope

- v3 schema bump, migrator, or seed migration (eliminated by the optional
  no-default `publication` decision).
- Real image-rights clearance (deferred to "Gate 1A-content," a separate
  procurement-dependent track).
- A snapshot-specific embedding index (Gate 1A public mode is keyword-only).
- Transaction journals, global write locks, batch recovery, or image-first import
  commits; these belong to Gate 1B.
- npm `files` allowlists, dependency pruning, package budgets, registry
  publishing, or dist-tag promotion; these belong to optional Gate 2.
- Streamable HTTP transport, invite-token authentication, rate limiting,
  billing, accounts, or hosted operations; these belong to optional Gate 3 or a
  future hosted-product decision.
- Full clearance review of the private corpus.
- Automatic rights inference or bulk approval.
- Packaging capture, bulk import, migrations, curator UI, or Playwright in the
  future lean npm runtime.
- Database migration, multi-region infrastructure, or high availability.
- Power-loss guarantees beyond the documented durability of the underlying
  filesystem and atomic same-filesystem renames.

## 11. Gate 1B Handoff Constraints

Gate 1B may begin only after Gate 1A stabilizes the consolidated corpus-loading
boundary. Its future design must include:

- a versioned Zod journal schema;
- explicit `aborted` state and reason;
- global cross-process write locking;
- base-corpus and resulting-corpus hashes;
- image installation before the atomic corpus commit point;
- deterministic rollback before commit and roll-forward after commit;
- draft-status, dedup-cache, corpus, image, and journal reconciliation;
- injected filesystem paths and a side-effect-free transaction core;
- deterministic fault injection at every transition; and
- real child-process termination tests around the commit point.

These constraints are recorded here only to preserve the architectural boundary;
their state machine and implementation tasks require a separate Gate 1B design
and plan.
