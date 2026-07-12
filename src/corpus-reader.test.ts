import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CorpusEntryT } from "./schema.js";
import { PrivateCorpusReader, PublicCorpusReader } from "./corpus-reader.js";
import {
  searchEntries,
  searchRanked,
  getEntryById,
  findSimilarEntries,
  listCategories,
  listStyleTags,
  listDomainTags,
  indexStatus,
  loadCorpus,
  setCorpusForTesting,
} from "./corpus.js";
import { fromCorpusRelativeImagePath } from "./paths.js";
import { fixtures } from "./scripts/__fixtures__/corpus-fixtures.js";
import { exportPublicSnapshot } from "./publication/exporter.js";
import { setImageIndexForTesting } from "./image-index.js";
import { sha256, serializeManifest, deriveSnapshotId, type PublicSnapshotManifest } from "./publication/manifest.js";

/**
 * corpus-reader.test.ts — regression guard for the PrivateCorpusReader delegate.
 *
 * Gate 1A, Task 4a. The whole point of the refactor is that private mode
 * produces IDENTICAL results to the pre-refactor code. This test asserts that
 * directly: for every CorpusReader method, the PrivateCorpusReader returns the
 * same value as the underlying corpus.ts function it wraps (when both read the
 * same fixture-backed corpus via setCorpusForTesting).
 *
 * Key regression: `entriesForAggregation()` returns the full corpus — this is
 * what the four aggregation handlers now call in place of `loadCorpus()`.
 */
describe("PrivateCorpusReader — delegates to corpus.ts (behavior-preserving)", () => {
  afterEach(() => setCorpusForTesting(null)); // restore the real corpus cache

  function withFixtures(): PrivateCorpusReader {
    setCorpusForTesting(fixtures);
    return new PrivateCorpusReader();
  }

  it("search() matches searchEntries()", async () => {
    const reader = withFixtures();
    const opts = { query: "dashboard", limit: 5 };
    const viaReader = await reader.search(opts);
    const direct = await searchEntries(opts);
    expect(viaReader).toEqual(direct);
  });

  it("search() matches searchEntries() with no query (structural filter only)", async () => {
    const reader = withFixtures();
    const opts = { limit: 100 };
    const viaReader = await reader.search(opts);
    const direct = await searchEntries(opts);
    expect(viaReader).toEqual(direct);
  });

  it("searchRanked() matches searchRanked()", async () => {
    const reader = withFixtures();
    const opts = { query: "pricing", limit: 20 };
    const viaReader = await reader.searchRanked(opts);
    const direct = await searchRanked(opts);
    expect(viaReader).toEqual(direct);
  });

  it("getById() matches getEntryById() for an existing id", () => {
    const reader = withFixtures();
    expect(reader.getById("linear-board")).toEqual(getEntryById("linear-board"));
  });

  it("getById() returns undefined for a missing id (matches getEntryById)", () => {
    const reader = withFixtures();
    expect(reader.getById("does-not-exist")).toBeUndefined();
    expect(getEntryById("does-not-exist")).toBeUndefined();
  });

  it("findSimilar() matches findSimilarEntries()", () => {
    const reader = withFixtures();
    const viaReader = reader.findSimilar("linear-board", 5);
    const direct = findSimilarEntries("linear-board", 5);
    expect(viaReader).toEqual(direct);
  });

  it("findSimilar() with default limit matches findSimilarEntries() default", () => {
    const reader = withFixtures();
    const viaReader = reader.findSimilar("linear-board");
    const direct = findSimilarEntries("linear-board");
    expect(viaReader).toEqual(direct);
  });

  it("listCategories() matches listCategories()", () => {
    const reader = withFixtures();
    expect(reader.listCategories()).toEqual(listCategories());
  });

  it("listStyleTags() matches listStyleTags()", () => {
    const reader = withFixtures();
    expect(reader.listStyleTags()).toEqual(listStyleTags());
  });

  it("listDomainTags() matches listDomainTags()", () => {
    const reader = withFixtures();
    expect(reader.listDomainTags()).toEqual(listDomainTags());
  });

  it("indexStatus() matches indexStatus()", () => {
    const reader = withFixtures();
    expect(reader.indexStatus()).toEqual(indexStatus());
  });

  // ── The keystone regression: the four aggregation handlers' data source ────

  it("entriesForAggregation() returns the full corpus (matches loadCorpus)", () => {
    const reader = withFixtures();
    const viaReader = reader.entriesForAggregation();
    const direct = loadCorpus();
    // Private mode shows EVERYTHING — no filtering. The aggregation functions
    // apply their own review-status filter internally, so the reader must hand
    // them the complete corpus, exactly as the old `loadCorpus()` call did.
    expect([...viaReader]).toEqual(direct);
    expect(viaReader.length).toBe(fixtures.length);
    // Must include the draft entry unfiltered — the aggregation layer filters,
    // not the reader.
    expect([...viaReader].some((e) => e.id === "draft-unchecked-entry")).toBe(true);
  });

  it("entriesForAggregation() returns a readonly view (caller cannot mutate the corpus via it)", () => {
    const reader = withFixtures();
    const entries = reader.entriesForAggregation();
    // The type is readonly CorpusEntryT[]; runtime check that spreading works
    // for the aggregation callers (which take mutable arrays).
    const copy = [...entries];
    expect(copy.length).toBe(fixtures.length);
  });

  // ── Image path resolution ──────────────────────────────────────────────────

  it("resolveImagePath() matches fromCorpusRelativeImagePath() for a valid path", () => {
    const reader = new PrivateCorpusReader(); // no corpus fixture needed for path math
    const rel = "images-private/origin-empty.png";
    expect(reader.resolveImagePath(rel)).toBe(fromCorpusRelativeImagePath(rel));
  });

  it("resolveImagePath() returns null for an invalid path (where the underlying helper throws)", () => {
    const reader = new PrivateCorpusReader();
    // An absolute path or traversal is rejected by assertCorpusImagePath.
    expect(reader.resolveImagePath("/etc/passwd")).toBeNull();
    expect(reader.resolveImagePath("../escape.png")).toBeNull();
    // A path that doesn't live under images-private/ or images-public/ is rejected.
    expect(reader.resolveImagePath("entries.json")).toBeNull();
  });
});

// ─── PublicCorpusReader (Task 4b) ────────────────────────────────────────────

/**
 * The leak-prevention reader. Tests build a real snapshot via the Task 3
 * exporter from a MIXED fixture corpus (one eligible public entry, one private
 * entry, one public-but-unapproved entry), then assert that NO private or
 * unapproved data — IDs, products, image paths, critique text, palettes, tags,
 * or unique marker strings — can surface through ANY reader method.
 *
 * Each entry carries a UNIQUE MARKER string in its critique so a leak is
 * detectable: "ELIGIBLE_MARKER_7Q", "PRIVATE_MARKER_3K", "UNAPPROVED_MARKER_9J".
 * If any private/unapproved marker appears in public-reader output, that's a leak.
 */
const NOW = "2026-07-12T00:00:00.000Z";

const ELIGIBLE_MARKER = "zenithcode";
const PRIVATE_MARKER = "cobaltfox";
const UNAPPROVED_MARKER = "quartzlynx";

const ELIGIBLE_ID = "public-eligible-entry";
const PRIVATE_ID = "secret-private-entry";
const UNAPPROVED_ID = "unapproved-public-entry";

const eligiblePublication = {
  visibility: "public" as const,
  clearance: "approved" as const,
  rightsBasis: "owned" as const,
  evidenceRef: "docs/rights/example.md",
  reviewedAt: "2026-06-01",
  reviewedBy: "nifabulous",
};

const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...new Array(32).fill(0),
]);

function baseEntry(id: string, critique: string): CorpusEntryT {
  return {
    id,
    title: `${id} title`,
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    domainTags: [],
    source: { productName: `${id}-product`, url: "https://example.com", capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "public-own", path: `images-public/${id}.png`, width: 1440, height: 900 },
    visual: {
      dominantColors: ["#ffffff", "#111111"],
      accentColor: "#635bff",
      typePairing: { display: "Inter", body: "Inter" },
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
      usesShadows: false,
      usesBorders: true,
    },
    critique,
    whatToSteal: [`${id} stealable technique`],
    antiPatterns: { antiPatterns: [`${id} antipattern`], whereThisFails: [], accessibilityRisks: [] },
    qualityTier: "exceptional",
    qualityScore: 4,
    reviewStatus: "approved",
    addedAt: "2026-07-01",
    publication: { ...eligiblePublication },
  } as CorpusEntryT;
}

interface PublicFixture {
  reader: PublicCorpusReader;
  snapshotPath: string;
  root: string;
}

/** Build a snapshot from a mixed fixture, return a PublicCorpusReader over it. */
function buildPublicReader(): PublicFixture {
  const root = mkdtempSync(join(tmpdir(), "public-reader-test-"));
  const imageRoot = resolve(root, "images-public");
  const snapshotDir = resolve(root, "public-snapshots");
  mkdirSync(imageRoot, { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });
  // Create real source images for all entries (the exporter copies assets for
  // eligible entries only; the ineligible ones are filtered out before copy).
  writeFileSync(resolve(imageRoot, `${ELIGIBLE_ID}.png`), PNG_BYTES);
  writeFileSync(resolve(imageRoot, `${PRIVATE_ID}.png`), PNG_BYTES);
  writeFileSync(resolve(imageRoot, `${UNAPPROVED_ID}.png`), PNG_BYTES);

  const eligible = baseEntry(ELIGIBLE_ID, `This dashboard uses calm spacing, restrained color, and a clear visual hierarchy. ${ELIGIBLE_MARKER}`);

  const privateEntry: CorpusEntryT = {
    ...baseEntry(PRIVATE_ID, `Confidential client financial details behind a login, not for redistribution. ${PRIVATE_MARKER}`),
    publication: { ...eligiblePublication, visibility: "private" }, // entry-private
  } as CorpusEntryT;

  const unapproved: CorpusEntryT = {
    ...baseEntry(UNAPPROVED_ID, `Pending legal review and sign-off before it may be redistributed openly. ${UNAPPROVED_MARKER}`),
    publication: { ...eligiblePublication, clearance: "unreviewed" }, // clearance-unreviewed
  } as CorpusEntryT;

  const result = exportPublicSnapshot({
    corpusEntries: [eligible, privateEntry, unapproved],
    snapshotDir,
    imageRoot,
    now: NOW,
  });

  // Sanity: only the eligible entry shipped.
  expect(result.entryCount).toBe(1);

  return { reader: new PublicCorpusReader(result.snapshotPath), snapshotPath: result.snapshotPath, root };
}

/** Assert the string contains no private/unapproved markers (a leak detector). */
function expectNoPrivateMarkers(text: string): void {
  expect(text).not.toContain(PRIVATE_MARKER);
  expect(text).not.toContain(UNAPPROVED_MARKER);
  expect(text).not.toContain(PRIVATE_ID);
  expect(text).not.toContain(UNAPPROVED_ID);
}

describe("PublicCorpusReader — serves only the snapshot's eligible entries", () => {
  let f: PublicFixture;
  beforeEach(() => { f = buildPublicReader(); });
  afterEach(() => {
    try { rmSync(f.root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  // ── Keystone: no private data leaks through ANY method ─────────────────────

  it("never returns private/unapproved entries via getById (direct ineligible-id lookup → undefined)", () => {
    expect(f.reader.getById(PRIVATE_ID)).toBeUndefined();
    expect(f.reader.getById(UNAPPROVED_ID)).toBeUndefined();
    // The eligible entry IS served.
    const got = f.reader.getById(ELIGIBLE_ID);
    expect(got).toBeDefined();
    expect(got!.id).toBe(ELIGIBLE_ID);
    expect(got!.source.productName).toBe(`${ELIGIBLE_ID}-product`);
  });

  it("search(keyword) returns the eligible entry, never the private/unapproved ones", async () => {
    const eligibleHit = await f.reader.search({ query: ELIGIBLE_MARKER, limit: 10 });
    expect(eligibleHit.map((e) => e.id)).toContain(ELIGIBLE_ID);
    for (const e of eligibleHit) expectNoPrivateMarkers(JSON.stringify(e));

    // A keyword ONLY in the private entry's critique → nothing.
    const privateHit = await f.reader.search({ query: PRIVATE_MARKER, limit: 10 });
    expect(privateHit).toEqual([]);

    // A keyword ONLY in the unapproved entry's critique → nothing.
    const unapprovedHit = await f.reader.search({ query: UNAPPROVED_MARKER, limit: 10 });
    expect(unapprovedHit).toEqual([]);
  });

  it("searchRanked returns the same keyword-only results as search (no vector path)", async () => {
    const viaSearch = await f.reader.search({ query: ELIGIBLE_MARKER, limit: 10 });
    const viaRanked = await f.reader.searchRanked({ query: ELIGIBLE_MARKER, limit: 10 });
    expect(viaRanked.map((r) => r.entry.id)).toEqual(viaSearch.map((e) => e.id));
    // All public-mode results are keyword mode (never vector/hybrid).
    for (const r of viaRanked) expect(r.searchMode).toBe("keyword");
    for (const r of viaRanked) expectNoPrivateMarkers(JSON.stringify(r.entry));
  });

  it("search with no query lists only the eligible entry (structural browse)", async () => {
    const all = await f.reader.search({ limit: 100 });
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(ELIGIBLE_ID);
  });

  it("findSimilar returns an empty array (unavailable in public mode, never private data)", () => {
    expect(f.reader.findSimilar(ELIGIBLE_ID, 5)).toEqual([]);
    // Even an ineligible id returns nothing — no leak via the similarity path.
    expect(f.reader.findSimilar(PRIVATE_ID, 5)).toEqual([]);
  });

  it("listCategories/listStyleTags/listDomainTags reflect ONLY the eligible entry", () => {
    const cats = f.reader.listCategories();
    expect(cats).toEqual(["dashboard"]);
    expect(cats.join(" ")).not.toContain(PRIVATE_ID);

    const styles = f.reader.listStyleTags();
    expect(styles).toEqual(["minimal"]);

    const domains = f.reader.listDomainTags();
    expect(domains).toEqual([]); // eligible entry has no domain tags
  });

  it("indexStatus reports ONLY the public snapshot count (never the private corpus total)", () => {
    const status = f.reader.indexStatus();
    expect(status.total).toBe(1); // only the one eligible entry
    expect(status.hasIndex).toBe(false);
    expect(status.indexed).toBe(0);
    expect(status.missing).toBe(0);
    expect(status.stale).toBe(0);
    expect(status.contentStale).toBe(0);
  });

  it("entriesForAggregation returns only the snapshot's eligible entries (no runtime policy needed)", () => {
    const entries = [...f.reader.entriesForAggregation()];
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(ELIGIBLE_ID);
    for (const e of entries) expectNoPrivateMarkers(JSON.stringify(e));
  });

  // ── Image path resolution ──────────────────────────────────────────────────

  it("resolveImagePath roots at the snapshot dir for an existing public asset", () => {
    const rel = `images-public/${ELIGIBLE_ID}.png`;
    const resolved = f.reader.resolveImagePath(rel);
    expect(resolved).toBe(resolve(f.snapshotPath, rel));
    expect(resolved).not.toBeNull();
  });

  it("resolveImagePath returns null for a missing file", () => {
    expect(f.reader.resolveImagePath("images-public/does-not-exist.png")).toBeNull();
  });

  it("resolveImagePath rejects paths outside images-public/ (no escape to private tree)", () => {
    expect(f.reader.resolveImagePath("entries.json")).toBeNull();
    expect(f.reader.resolveImagePath("images-private/secret.png")).toBeNull();
    expect(f.reader.resolveImagePath("../escape.png")).toBeNull();
    expect(f.reader.resolveImagePath("/etc/passwd")).toBeNull();
  });

  // ── F4: symlink escape protection ─────────────────────────────────────────

  it("resolveImagePath rejects a symlink under images-public/ that escapes the snapshot (F4)", () => {
    // Create a secret file OUTSIDE the snapshot dir, then a symlink inside
    // images-public/ pointing at it. existsSync on the symlink returns true
    // (it resolves), so the OLD code would happily return the abs path and the
    // tool handler would serve bytes from outside the snapshot. The realpath
    // containment check must catch this.
    const secretDir = mkdtempSync(join(tmpdir(), "secret-outside-"));
    try {
      const secretFile = resolve(secretDir, "secret.png");
      writeFileSync(secretFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const linkPath = resolve(f.snapshotPath, "images-public", "escape-link.png");
      symlinkSync(secretFile, linkPath);
      // The symlink resolves to a real path OUTSIDE the snapshot → must be null.
      expect(f.reader.resolveImagePath("images-public/escape-link.png")).toBeNull();
    } finally {
      try { rmSync(secretDir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("resolveImagePath still serves a legitimate (non-escaping) asset after F4", () => {
    // The happy path must still work: a regular file under images-public/ that
    // the exporter legitimately copied into the snapshot.
    const rel = `images-public/${ELIGIBLE_ID}.png`;
    const resolved = f.reader.resolveImagePath(rel);
    expect(resolved).toBe(resolve(f.snapshotPath, rel));
    expect(resolved).not.toBeNull();
  });

  it("resolveImagePath rejects a symlink pointing to a directory inside the snapshot (not a regular file)", () => {
    // A symlink whose target is a directory must be rejected by the regular-file
    // check, even if the directory is inside the snapshot.
    const dirTarget = resolve(f.snapshotPath, "images-public", "subdir");
    mkdirSync(dirTarget, { recursive: true });
    const linkPath = resolve(f.snapshotPath, "images-public", "dir-link.png");
    symlinkSync(dirTarget, linkPath);
    expect(f.reader.resolveImagePath("images-public/dir-link.png")).toBeNull();
  });

  // ── Integrity at load ──────────────────────────────────────────────────────

  it("constructor throws on a snapshot missing entries.json", () => {
    const badRoot = mkdtempSync(join(tmpdir(), "public-reader-bad-"));
    try {
      // manifest.json present but no entries.json
      writeFileSync(resolve(badRoot, "manifest.json"), "{}");
      expect(() => new PublicCorpusReader(badRoot)).toThrow(/entries\.json/);
    } finally {
      try { rmSync(badRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  it("constructor throws on a snapshot with a tampered entries.json (integrity check fails)", () => {
    // Tamper with entries.json after export: append bytes so the SHA no longer
    // matches the manifest. The reader must refuse to serve it.
    const tampered = resolve(f.snapshotPath, "entries.json");
    writeFileSync(tampered, `${readFileSync(tampered, "utf-8")}\n  {"tampered": true}\n]`);
    expect(() => new PublicCorpusReader(f.snapshotPath)).toThrow(/integrity|mismatch|sha256/i);
  });

  // ── F2: image-index boundary ──────────────────────────────────────────────

  it("getImageIndex() returns null in public mode (no path to the private corpus index)", async () => {
    // This is the keystone F2 assertion: the public reader MUST NOT expose a
    // corpus image-embedding index. The previous critique_ui handler imported
    // loadImageIndex directly and loaded the GLOBAL (private) index in public
    // mode — a leak. Routing through the reader makes this the single gate.
    expect(await f.reader.getImageIndex("any-model")).toBeNull();
    // Even with no model argument (provider absent), still null.
    expect(await f.reader.getImageIndex()).toBeNull();
  });
});

// ─── F2: PrivateCorpusReader image-index delegation ────────────────────────

describe("PrivateCorpusReader.getImageIndex (F2) — loads the global index, never leaks in public mode", () => {
  afterEach(() => setImageIndexForTesting(null));

  it("returns null when no provider model is given (no provider configured)", async () => {
    const reader = new PrivateCorpusReader();
    expect(await reader.getImageIndex()).toBeNull();
    expect(await reader.getImageIndex("")).toBeNull();
  });

  it("returns the global index for a matching model (delegates to loadImageIndex)", async () => {
    // Use the test-only override seam (mirrors setImageIndexForTesting) so the
    // test is hermetic — it doesn't depend on a real corpus/image-embeddings.json.
    const fakeIndex = {
      version: 1 as const,
      model: "voyage-multimodal-3",
      dimension: 4,
      entries: { "e1": { vector: [0.1, 0.2, 0.3, 0.4], hash: "abc" } },
    };
    setImageIndexForTesting(fakeIndex);
    const reader = new PrivateCorpusReader();
    const idx = await reader.getImageIndex("voyage-multimodal-3");
    expect(idx).not.toBeNull();
    expect(idx!.dimension).toBe(4);
    expect(idx!.entries["e1"].vector).toEqual([0.1, 0.2, 0.3, 0.4]);
  });

  it("returns null when the global index model doesn't match the provider", async () => {
    setImageIndexForTesting({
      version: 1,
      model: "some-other-model",
      dimension: 4,
      entries: {},
    });
    const reader = new PrivateCorpusReader();
    // loadImageIndex rejects a model mismatch → null (no leak of a stale index).
    expect(await reader.getImageIndex("voyage-multimodal-3")).toBeNull();
  });
});

// ─── F3: snapshot JSON validated (not trusted after hashing) ──────────────

/**
 * F3 (Gate 1A): the snapshot is an UNTRUSTED input at load. Integrity hashing
 * proves only self-consistency, so these tests craft hand-built snapshots WITH
 * valid hashes but malformed/inconsistent/ineligible contents, and assert the
 * constructor rejects (or filters) them. This is the exact attack shape the
 * finding describes: "a hand-crafted snapshot with private/unapproved entries
 * + recomputed hashes would pass integrity and be served."
 *
 * `writeSnapshot` writes entries.json + manifest.json + assets with recomputed
 * hashes so verifySnapshotIntegrity passes, then the constructor's Zod +
 * cross-check + policy layers are what catch the injected fault.
 */
const F3_NOW = "2026-07-12T00:00:00.000Z";

/** Build a snapshot dir from raw entries (recomputing all hashes). */
function writeSnapshot(
  root: string,
  entries: CorpusEntryT[],
  opts: { manifestOverride?: Partial<PublicSnapshotManifest>; assetsOverride?: string[] } = {},
): string {
  const snapshotPath = resolve(root, "handcrafted-snapshot");
  mkdirSync(snapshotPath, { recursive: true });
  const imageDir = resolve(snapshotPath, "images-public");
  mkdirSync(imageDir, { recursive: true });

  // Determine which assets to write (default: one PNG per entry's image.path).
  const assetPaths = opts.assetsOverride ?? Array.from(
    new Set(entries.map((e) => e.image.path).filter((p): p is string => typeof p === "string")),
  );
  const assets = assetPaths.map((p) => {
    const abs = resolve(snapshotPath, p);
    mkdirSync(resolve(abs, ".."), { recursive: true });
    writeFileSync(abs, PNG_BYTES);
    return { path: p, sha256: sha256(PNG_BYTES), bytes: PNG_BYTES.length };
  });

  const entriesJson = `${JSON.stringify(entries, null, 2)}\n`;
  const entriesPath = resolve(snapshotPath, "entries.json");
  writeFileSync(entriesPath, entriesJson, "utf-8");

  const entriesSha = sha256(readFileSync(entriesPath));
  const snapshotId = deriveSnapshotId(entriesSha, assets);
  const manifest: PublicSnapshotManifest = {
    schemaVersion: 1,
    corpusVersion: 2,
    snapshotId,
    generatedAt: F3_NOW,
    entryCount: entries.length,
    entriesSha256: entriesSha,
    assets,
    ...opts.manifestOverride,
  };
  writeFileSync(resolve(snapshotPath, "manifest.json"), serializeManifest(manifest), "utf-8");
  return snapshotPath;
}

describe("PublicCorpusReader (F3) — snapshot JSON is validated, not trusted after hashing", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "f3-snapshot-")); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

  it("rejects an entries.json with a schema-invalid entry (malformed shape)", () => {
    // An entry missing required fields (no critique, wrong types) — but the
    // manifest hashes are recomputed so integrity passes. Only Zod catches this.
    const badEntry = {
      ...baseEntry("bad-entry", "x".repeat(80)),
      critique: 123, // wrong type — must be string
    } as unknown as CorpusEntryT;
    const snapshotPath = writeSnapshot(root, [badEntry]);
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/schema validation/);
  });

  it("rejects a manifest with an invalid entriesSha256 (non-hex)", () => {
    const entry = baseEntry("ok-entry", "x".repeat(80));
    const snapshotPath = writeSnapshot(root, [entry], {
      manifestOverride: { entriesSha256: "not-a-real-hash" },
    });
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/schema validation/);
  });

  it("rejects an entryCount mismatch (manifest lies about its size)", () => {
    const e1 = baseEntry("e1", "x".repeat(80));
    const e2 = baseEntry("e2", "y".repeat(80));
    // Real entries.json has 2 entries; manifest claims 5.
    const snapshotPath = writeSnapshot(root, [e1, e2], {
      manifestOverride: { entryCount: 5 },
    });
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/entryCount.*does not match/);
  });

  it("rejects an eligible entry whose image.path is not a declared manifest asset (entry ⊄ manifest)", () => {
    // The entry is eligible (public + approved + image file present on disk),
    // but its image.path points at a file that is NOT in the manifest.assets
    // list. The policy passes (the file exists on disk), so only the F2
    // three-way set check catches the undeclared reference — an eligible entry
    // must not point at an asset the manifest doesn't vouch for. The set check
    // reports the discrepancy as "entry image paths ≠ manifest assets".
    const entry = baseEntry("rogue-asset", "x".repeat(80));
    entry.image.path = "images-public/undeclared.png";
    // Write BOTH the entry's actual image file AND a decoy declared asset, so
    // the entry passes the policy (its file exists) but the declared-assets set
    // does not contain the entry's path.
    const snapshotPath = writeSnapshot(root, [entry], {
      assetsOverride: ["images-public/undeclared.png", "images-public/something-else.png"],
    });
    // Rewrite the manifest so it declares ONLY the decoy (not the entry's path),
    // with a recomputed snapshotId so the entries.json hash still matches. The
    // asset file for undeclared.png is still on disk (policy passes), but the
    // manifest no longer declares it.
    const manifestPath = resolve(snapshotPath, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PublicSnapshotManifest;
    manifest.assets = manifest.assets.filter((a) => a.path === "images-public/something-else.png");
    manifest.snapshotId = deriveSnapshotId(manifest.entriesSha256, manifest.assets);
    writeFileSync(manifestPath, serializeManifest(manifest), "utf-8");
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/snapshot asset set mismatch/);
  });

  it("rejects a snapshot containing a private entry (stale — bytes must not remain packaged)", () => {
    // Round-3 F1: a snapshot containing an entry that fails publication
    // re-evaluation at load time is STALE, not filtered. The private entry's
    // image bytes are still physically in the snapshot directory; filtering
    // only the metadata leaves the bytes in the artifact. The snapshot must
    // be rejected and regenerated.
    const goodEntry = baseEntry("good-public", "A well-structured, fully-cleared public dashboard example that is safe for open redistribution everywhere. zen");
    const injectedPrivate: CorpusEntryT = {
      ...baseEntry("injected-private", "A private entry that should never have been shipped in any public snapshot at all. cob"),
      publication: { ...eligiblePublication, visibility: "private" },
      image: { visibility: "private", path: "images-private/injected-private.png", width: 1440, height: 900 },
    } as CorpusEntryT;
    const snapshotPath = writeSnapshot(root, [goodEntry, injectedPrivate], {
      assetsOverride: [`images-public/good-public.png`],
    });
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/stale/i);
  });

  it("rejects a snapshot containing an unapproved entry (stale — must regenerate)", () => {
    // Round-3 F1: same principle — an unapproved entry's bytes are still in
    // the snapshot. Reject, don't filter.
    const goodEntry = baseEntry("approved-one", "A fully cleared, reviewed, and approved public dashboard entry that is cleared for the open corpus. zen");
    const injectedUnapproved: CorpusEntryT = {
      ...baseEntry("injected-unapproved", "An unreviewed entry that was slipped into the snapshot illegally and must be filtered out. qua"),
      publication: { ...eligiblePublication, clearance: "unreviewed" },
    } as CorpusEntryT;
    // Both entries have images-public/ paths; writeSnapshot writes both assets.
    // The manifest declares both. But the unapproved entry fails policy.
    const snapshotPath = writeSnapshot(root, [goodEntry, injectedUnapproved]);
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/stale/i);
  });

  it("loads a fully valid snapshot unchanged (the happy path still works after F3)", () => {
    const entry = baseEntry("valid-entry", "A clean, eligible, fully-cleared public dashboard entry that is ready to ship in the open-source corpus. zen");
    const snapshotPath = writeSnapshot(root, [entry]);
    const reader = new PublicCorpusReader(snapshotPath);
    expect([...reader.entriesForAggregation()].map((e) => e.id)).toEqual(["valid-entry"]);
  });
});

// ─── F1 (round 2): expiry uses the current date, not the snapshot's generatedAt ─

/**
 * F1 (Gate 1A, round 2): the publication re-evaluation at load MUST use the
 * current date for the expiry check, NOT the snapshot's `generatedAt`. The bug:
 * `evaluatePublication` was called with `now: manifest.generatedAt.slice(0,10)`,
 * so an entry that expires AFTER the snapshot was created was eligible forever
 * — a snapshot generated Jan 1 with rights expiring Feb 1 was still served in
 * July. The fix injects a `now` (defaulting to today) into the reader; the
 * tests below pin both halves of the contract:
 *   - when `now` is AFTER the entry's expiresAt, the entry is filtered out;
 *   - when `now` is BEFORE (or on) the entry's expiresAt, the entry is eligible.
 *
 * The `now` argument is the only thing that varies between the two cases — the
 * snapshot on disk is IDENTICAL (same generatedAt, same expiresAt), so the test
 * proves the decision follows the injected clock, not the manifest's creation
 * timestamp.
 */
describe("PublicCorpusReader (F1) — expiry uses the injected current date, not generatedAt", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "f1-expiry-")); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

  /** An eligible entry whose clearance expires on 2026-02-01. */
  function expiringEntry(): CorpusEntryT {
    const entry = baseEntry(
      "expiring-entry",
      "A fully cleared public dashboard entry whose redistribution rights expire on a fixed date. zen",
    );
    entry.publication = { ...entry.publication!, expiresAt: "2026-02-01" };
    return entry;
  }

  it("rejects a snapshot whose entry has expired relative to the injected now (stale — must regenerate)", () => {
    // Round-3 F1: an expired entry's image bytes are still physically packaged
    // in the snapshot. Filtering only the metadata leaves the bytes in the
    // artifact. The snapshot must be rejected and regenerated.
    const snapshotPath = writeSnapshot(root, [expiringEntry()]);
    expect(() => new PublicCorpusReader(snapshotPath, "2026-07-12")).toThrow(/stale/i);
  });

  it("keeps the same entry eligible when the injected now is before the expiry", () => {
    // Identical snapshot, but the injected now is 2026-01-15 (before the
    // 2026-02-01 expiry) — clearance is still valid, so the entry is served.
    // This pins the other half: the fix doesn't over-filter entries that are
    // still within their clearance window.
    const snapshotPath = writeSnapshot(root, [expiringEntry()]);
    const reader = new PublicCorpusReader(snapshotPath, "2026-01-15");
    expect([...reader.entriesForAggregation()].map((e) => e.id)).toEqual(["expiring-entry"]);
    expect(reader.getById("expiring-entry")).toBeDefined();
  });

  it("keeps the entry eligible on the expiry day (expiresAt >= now is still valid through end-of-day)", () => {
    // Policy semantics: expiresAt >= now is still valid (clearance good through
    // end-of-day). now === expiresAt (2026-02-01) must NOT be filtered.
    const snapshotPath = writeSnapshot(root, [expiringEntry()]);
    const reader = new PublicCorpusReader(snapshotPath, "2026-02-01");
    expect([...reader.entriesForAggregation()].map((e) => e.id)).toEqual(["expiring-entry"]);
  });

  it("proves the decision follows the injected now, not generatedAt (same snapshot, different now)", () => {
    // The keystone: ONE snapshot, TWO readers with different `now`. Before
    // expiry the snapshot loads and serves the entry; after expiry the snapshot
    // is rejected as stale — driven entirely by the injected clock. generatedAt
    // is fixed in the manifest; if the reader used generatedAt, both readers
    // would behave identically.
    const snapshotPath = writeSnapshot(root, [expiringEntry()]);
    const before = new PublicCorpusReader(snapshotPath, "2026-01-15");
    expect([...before.entriesForAggregation()].map((e) => e.id)).toEqual(["expiring-entry"]);
    expect(() => new PublicCorpusReader(snapshotPath, "2026-07-12")).toThrow(/stale/i);
  });

  it("throws on a malformed injected now (not YYYY-MM-DD)", () => {
    const snapshotPath = writeSnapshot(root, [expiringEntry()]);
    expect(() => new PublicCorpusReader(snapshotPath, "not-a-date")).toThrow(/YYYY-MM-DD/);
    expect(() => new PublicCorpusReader(snapshotPath, "2026-7-12")).toThrow(/YYYY-MM-DD/);
  });

  it("rejects a manifest with a non-ISO-datetime generatedAt (schema-level guard)", () => {
    // F1 also validates generatedAt independently as an ISO 8601 datetime at the
    // Zod level (it's still used for the manifest's own field). A bare date
    // "2026-07-12" or garbage must be rejected by the schema, not accepted.
    const entry = baseEntry("ok-entry", "A clean eligible entry that ships fine. zen");
    const snapshotPath = writeSnapshot(root, [entry], {
      manifestOverride: { generatedAt: "2026-07-12" }, // missing the T-time component
    });
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/schema validation/);
  });
});

// ─── F2 (round 2): asset set consistency (eligible⊆manifest, no orphans, manifest==disk)

/**
 * F2 (Gate 1A, round 2): the asset cross-check previously verified only that
 * every surviving entry's image.path was a declared manifest asset (entries ⊆
 * manifest). It did NOT check the reverse (no orphan manifest assets) or the
 * filesystem (no unmanifested files under images-public/). So a snapshot could
 * carry extra manifest assets or arbitrary files that no entry references —
 * those would travel with a future npm artifact despite never passing
 * publication policy.
 *
 * The fix enforces three invariants at load:
 *   (1) eligible ⊆ manifest — every surviving entry's image is a declared asset;
 *   (2) manifest ⊆ all-entry-paths — no manifest asset is an orphan (an asset
 *       that NO entry in entries.json references, eligible or not);
 *   (3) manifest == disk — every declared asset exists on disk and every regular
 *       file under images-public/ is declared (no unmanifested files, no missing
 *       manifest files).
 * Each test below injects ONE discrepancy and asserts the reader throws.
 */
describe("PublicCorpusReader (F2) — asset set consistency (eligible⊆manifest, no orphans, manifest==disk)", () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "f2-assets-")); });
  afterEach(() => { try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ } });

  it("rejects an extra manifest asset not referenced by any entry (orphan manifest asset)", () => {
    // The snapshot declares TWO assets but the single eligible entry references
    // only one. The orphan manifest asset ("images-public/orphan.png") is
    // referenced by NO entry — it would ride in a future npm artifact without
    // ever passing publication policy. The manifest ⊆ all-entry-paths check
    // catches it.
    const entry = baseEntry("only-entry", "A clean eligible public dashboard entry that ships with exactly one declared asset. zen");
    const snapshotPath = writeSnapshot(root, [entry], {
      assetsOverride: ["images-public/only-entry.png", "images-public/orphan.png"],
    });
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/snapshot asset set mismatch/);
    // The error names the specific orphan path.
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/orphan\.png/);
  });

  it("rejects an extra file under images-public/ not declared in the manifest (unmanifested file)", () => {
    // The manifest declares one asset (the eligible entry's image) and that file
    // is on disk, PLUS a second arbitrary file under images-public/ that the
    // manifest does NOT declare. The unmanifested file would be packaged by a
    // naive `npm pack`. The manifest == disk check catches it.
    const entry = baseEntry("legit-entry", "A clean eligible public dashboard entry with its single declared redistributable asset. zen");
    const snapshotPath = writeSnapshot(root, [entry]);
    // Drop an extra file on disk that the manifest doesn't declare.
    writeFileSync(resolve(snapshotPath, "images-public", "stowaway.png"), PNG_BYTES);
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/snapshot asset set mismatch/);
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/stowaway\.png/);
  });

  it("rejects a manifest asset whose file is missing on disk (declared but absent)", () => {
    // The manifest declares an asset and the eligible entry references it, but
    // the file was deleted from disk after export. verifySnapshotIntegrity
    // already catches this (it re-hashes every asset), so either layer may fire
    // — assert a throw mentioning integrity or the asset set mismatch.
    const entry = baseEntry("lost-asset", "A clean eligible public dashboard entry whose declared asset file has gone missing. zen");
    const snapshotPath = writeSnapshot(root, [entry]);
    // Delete the declared asset file from disk.
    unlinkSync(resolve(snapshotPath, "images-public", "lost-asset.png"));
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/integrity|asset missing|snapshot asset set mismatch/i);
  });

  it("rejects a manifest asset with an unsafe path (images-private/ or .. traversal) at the schema level", () => {
    // The schema refine on PublicSnapshotAssetSchema rejects any asset path that
    // doesn't start with images-public/ or that contains "..". A hand-crafted
    // manifest declaring "images-private/secret.png" or "../etc/passwd" must be
    // rejected at Zod parse time, before integrity or the set check run.
    const entry = baseEntry("ok-entry", "A clean eligible public dashboard entry with one safe public asset path. zen");
    const snapshotPath = writeSnapshot(root, [entry], {
      assetsOverride: ["images-public/ok-entry.png", "images-private/secret.png"],
    });
    // The manifest fails schema validation (the asset path refine).
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/schema validation/);
    // The refine surfaces a message about the safe images-public/ requirement.
    expect(() => new PublicCorpusReader(snapshotPath)).toThrow(/images-public/);
  });

  it("walks nested subdirectories under images-public/ (nested assets count as disk files)", () => {
    // The on-disk walk is recursive. An asset in images-public/nested/sub.png is
    // a legitimate regular file and must be counted. Build a consistent snapshot
    // where the entry references the nested path, the manifest declares it, and
    // the file lives nested — all invariants hold, so it loads.
    const entry = baseEntry("nested-entry", "A clean eligible public dashboard entry with a nested asset path under images-public. zen");
    entry.image.path = "images-public/nested/nested-entry.png";
    const snapshotPath = writeSnapshot(root, [entry]);
    const reader = new PublicCorpusReader(snapshotPath);
    expect([...reader.entriesForAggregation()].map((e) => e.id)).toEqual(["nested-entry"]);
  });

  it("loads a snapshot whose three sets are consistent (the happy path still passes F2)", () => {
    // Two eligible entries, two assets declared, two files on disk — eligible ⊆
    // manifest, manifest ⊆ all-entry-paths, manifest == disk. This is the green
    // path: no discrepancy, loads cleanly.
    const e1 = baseEntry("entry-a", "A clean eligible public dashboard entry A with its own redistributable asset. zen");
    const e2 = baseEntry("entry-b", "A clean eligible public dashboard entry B with its own redistributable asset. zen");
    const snapshotPath = writeSnapshot(root, [e1, e2]);
    const reader = new PublicCorpusReader(snapshotPath);
    expect([...reader.entriesForAggregation()].map((e) => e.id).sort()).toEqual(["entry-a", "entry-b"]);
  });
});
