# Operational Readiness Gate 1A: Publication Integrity Design

**Date:** 2026-07-12

**Status:** Proposed for user review

**Supersedes:** The Gate 1A portion of the pasted “clean-ui-mcp — Operational
Readiness Plan (v2)”

**Scope:** Version-aware corpus loading, corpus schema v3, publication policy,
public snapshot generation, and mode-aware corpus-reader wiring

## Objective

Make publication safety a permanent, mechanically enforced property of the
corpus before any npm or hosted distribution work begins.

Gate 1A must ensure that:

1. upgrading from corpus schema v2 to v3 cannot replace, truncate, or silently
   reinterpret the curator's working corpus;
2. publication permission and publication intent are recorded separately;
3. an entry is publishable only when both its entry metadata and image metadata
   permit redistribution;
4. public artifacts are generated from an explicit allow-set and never contain
   the private source corpus; and
5. every MCP tool and internal retrieval path reads through a construction-time
   corpus mode instead of selecting visibility ad hoc.

This gate produces a validated, non-empty public corpus snapshot as proof that
the full publication path works. It does not publish an npm package or add a
hosted MCP transport.

## Why Gate 1A Comes First

The current corpus durability layer parses files through the current `Corpus`
schema. Changing `Corpus` directly from v2 to v3 would make the existing v2
`entries.json` and v2 snapshots appear corrupt. If `seed.json` were already v3,
fallback could load the one-entry seed; a later save could then overwrite the
curator's working corpus.

Accordingly, the version-aware loader is the P0 first task. No v3 schema change,
migration, public exporter, or reader refactor may land before the loader can
distinguish a missing file from a supported older version, corrupt data, and an
unsupported future version.

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
                 v2 entries / v3 entries / snapshots
                              |
                              v
                   version-aware corpus decoder
             missing | v2 | v3 | corrupt | future-version
                              |
                 +------------+-------------+
                 |                          |
                 v                          v
       private CorpusReader          explicit v2 -> v3 migrator
                 |                          |
                 |                          v
                 |                    validated v3 corpus
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
restoration, migration, and corpus scripts. It parses the JSON envelope before
selecting a version-specific schema.

```ts
type CorpusDecodeResult =
  | { kind: "missing"; path: string }
  | { kind: "v2"; path: string; corpus: CorpusV2 }
  | { kind: "v3"; path: string; corpus: CorpusV3 }
  | { kind: "corrupt"; path: string; error: string }
  | { kind: "unsupported-version"; path: string; version: unknown };
```

`missing` applies only when no file exists at the requested path. Invalid JSON,
invalid schema data, and an unknown version are never collapsed into `missing`.

### 1.2 Safe-load behavior

The safe loader follows this decision tree:

```text
primary missing?
  yes -> try seed -> return seed or empty, without creating entries.json
  no  -> decode primary
           v3 -> return v3
           v2 -> return read-only migration-required result
           corrupt -> inspect snapshots of supported versions
           future version -> fail visibly; do not inspect seed or rewrite
```

Snapshot recovery may restore only a schema version the loader explicitly
supports. Recovery preserves the recovered envelope version; it must not
serialize a recovered v2 corpus as v3 without running the migrator.

### 1.3 Write protection

The loader exposes whether returned entries came from the primary corpus, a
snapshot, or the seed. Callers may not persist seed-derived or read-only v2 data
through a normal save path. The curator UI must show an actionable error for a
v2 corpus requiring migration instead of opening it as editable v3 state.

Unknown newer versions are fatal and untouched. The error identifies the path
and encountered version without printing corpus content.

## 2. Corpus Schema v3

### 2.1 Publication block

Every v3 entry contains:

```ts
publication: {
  visibility: "private" | "public";
  clearance: "unreviewed" | "approved" | "rejected";
  rightsBasis?: "owned" | "license" | "permission" | "public-domain";
  evidenceRef?: string;
  reviewedAt?: string;   // YYYY-MM-DD
  reviewedBy?: string;
  expiresAt?: string;    // YYYY-MM-DD; absent means no recorded expiry
}
```

The schema validates representation:

- enum membership;
- date format;
- bounded, non-empty reviewer and evidence references;
- clearance-dependent field shape; and
- rejection/unreviewed states not carrying misleading approval metadata.

The schema does not decide whether an entry may be published. That decision
belongs to the shared policy evaluator so `doctor` can report stable policy
reasons rather than only generic parse errors.

### 2.2 v2 to v3 migration

The explicit migrator adds this block to every v2 entry:

```ts
publication: {
  visibility: "private",
  clearance: "unreviewed"
}
```

Migration requirements:

- take a raw pre-migration snapshot before writing;
- preserve every existing entry field byte-semantically after JSON parsing;
- preserve entry count and IDs;
- validate the complete v3 result before replacing the primary file;
- write atomically;
- be idempotent when the input is already v3;
- refuse unsupported future versions; and
- never infer clearance from `image.visibility`, source URL, tags, or provenance.

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
- `image.visibility` is `public-thumb` or `public-own`;
- the image path is non-null and starts with `images-public/`;
- width and height are present; and
- the resolved image file exists under the public image root.

The evaluator receives the current date and image-resolution capability through
an explicit context, making expiry and file checks deterministic in tests. It
returns all applicable reasons in stable order.

## 4. Immutable Public Snapshot

### 4.1 Export shape

The exporter consumes a validated v3 corpus and produces a versioned directory:

```text
corpus/public-snapshots/<snapshot-id>/
  manifest.json
  entries.json
  images/
```

The manifest contains:

```ts
interface PublicSnapshotManifest {
  schemaVersion: 1;
  corpusVersion: 3;
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

### 4.3 Non-empty proof set

Gate 1A includes a deliberately small set of entries whose clearance evidence
is reviewed by a human and whose images already satisfy the public-image
contract. The exporter must produce at least one eligible entry in the Gate 1A
acceptance run.

Tests also cover a valid zero-eligible-entry corpus. Empty output is a successful
snapshot with `entryCount: 0`, not an exporter crash or permission bypass.

## 5. Mode-Aware CorpusReader

### 5.1 Interface

All MCP corpus access flows through an injected reader. The reader exposes the
operations needed by tools rather than a mutable entries array.

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
}
```

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
dependencies. No public tool-registration module may import the unrestricted
working-corpus loader.

Migration scope is determined by production call sites, not by counting tool
handlers. Implementation planning must inventory direct and indirect
`loadCorpus()` uses, including aggregation and critique-retrieval paths.

## 6. Error Handling

| Condition | Required behavior |
|---|---|
| Primary corpus absent | Seed may be used read-only; never create or overwrite the primary |
| Primary corpus is valid v2 | Report migration required; do not open writable v3 state |
| Primary corpus is valid v3 | Load normally |
| Primary corpus JSON/schema corrupt | Attempt supported-version snapshot recovery |
| Primary has unsupported newer version | Fail visibly; do not fall back, recover, or rewrite |
| Snapshot is v2 | Recover only as v2 read-only data; require explicit migration |
| Publication entry is ineligible | Exclude it and report deterministic reason codes |
| Eligible entry image disappears | Exclude entry; exporter fails the requested non-empty proof run |
| Export staging copy fails | Leave no final snapshot; retain or clean isolated staging safely |
| Final snapshot ID already exists | Refuse overwrite; verify existing snapshot separately |
| Public reader sees invalid manifest/hash | Refuse startup; never serve a partial snapshot |
| Private reader is used by public registration | Static architecture test and CI fail |

## 7. Testing Strategy

### 7.1 Loader and migration

- missing primary with valid seed;
- corrupt primary with valid snapshot;
- valid v2 primary with v3 seed does not fall back;
- unsupported future primary does not fall back or rewrite;
- v2 snapshot recovery preserves v2 status;
- v2 to v3 migration preserves IDs, count, and all prior fields;
- migration writes a pre-migration snapshot;
- migration is idempotent on v3;
- failed v3 validation leaves the v2 primary unchanged; and
- seed-derived data cannot pass a writable save guard.

### 7.2 Publication policy and exporter

- table-driven coverage of every reason code and eligible combination;
- entry approval cannot override private image visibility;
- public image visibility cannot override private entry visibility;
- expiry uses an injected date;
- missing image and path escape attempts fail;
- one source asset cannot escape the public image root through traversal or
  symlink resolution;
- generated entry and asset hashes match bytes on disk;
- exporter interruption before directory rename exposes no final snapshot;
- existing immutable snapshot is never overwritten;
- zero-entry export succeeds; and
- the reviewed proof set exports at least one entry.

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

Leak enforcement runs in two layers:

1. **Source import graph (developer feedback).** Static analysis of the
   TypeScript import graph verifies that no public tool-registration module
   imports the unrestricted working-corpus loader. This gives fast feedback
   during development and catches direct imports.
2. **Built-artifact scan (enforceable gate).** After `npm run build`, scan the
   compiled `dist/` output transitively reachable from the public reader's entry
   point and assert it does not reference the unrestricted loader — by symbol,
   re-export, or dynamic import. Source-graph analysis alone cannot see through
   barrel re-exports, renamed bindings, or future dynamic imports; the
   artifact scan is the gate that catches what survives the build, matching
   design principle 6 (physical isolation beats filtering).

Both layers run in CI. The artifact scan is the one that matters for the npm
package boundary; the source graph exists to fail fast in the editor before a
build is needed.

## 8. Delivery Order

Gate 1A is implemented in this order:

1. Add version-specific v2/v3 envelope types and the shared decoder.
2. Harden `loadCorpusSafe` and all other corpus load paths with write-protected,
   version-aware results.
3. Add regression tests proving a v2 working corpus cannot fall through to a v3
   seed or be overwritten through normal save paths.
4. Add the v3 publication schema and explicit v2-to-v3 migrator.
5. Add migration safety, idempotency, and unsupported-version tests.
6. Add the shared publication policy evaluator.
7. Curate the initial non-empty cleared proof set.
8. Add the immutable public snapshot exporter and manifest verification.
9. Introduce mode-aware `CorpusReader` construction.
10. Inject the reader through every production corpus call site and all fourteen
    current MCP tools.
11. Add dynamic MCP leak contracts and static import-boundary enforcement.
12. Extend `doctor` with schema-version and publication-policy diagnostics.
13. Run the full Gate 1A verification and holistic branch review.

Every implementation task follows TDD and the repository's task-review gate.
Structural loader/schema work lands before reader rewiring so regressions remain
bisectable.

## 9. Gate 1A Acceptance Criteria

- A valid v2 primary can never be mistaken for missing or corrupt data.
- Seed fallback occurs only when the primary is absent.
- No ordinary load or save path silently migrates or rewrites a corpus version.
- The explicit migrator converts the working corpus to v3 without losing entry
  IDs, entries, or existing fields.
- Every v3 entry has an explicit publication block.
- The shared policy evaluator is the only source of publication eligibility.
- Eligibility requires both entry clearance and redistributable image state.
- A finalized public snapshot contains only eligible entries and public assets,
  with verified hashes and no private-source paths.
- The acceptance snapshot contains at least one human-cleared entry; empty-corpus
  behavior is also tested.
- Private reader mode preserves existing tool behavior.
- Public reader mode cannot reveal marker data from private or unapproved
  entries through search, retrieval, similarity, critique, metadata listing, or
  aggregation.
- Architecture tests prevent new unrestricted-loader bypasses.
- `doctor`, corpus validation, build, offline tests, MCP smoke tests, and wiring
  verification pass without relying on a historical test-count assertion.
- Task-level reviews and a final holistic review are approved according to
  `CLAUDE.md`.

## 10. Explicitly Not in Scope

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

Gate 1B may begin only after Gate 1A stabilizes the v3 schema and shared corpus
loading boundary. Its future design must include:

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
