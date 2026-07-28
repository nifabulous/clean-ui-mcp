/**
 * create-ui-spec-dependencies.test.ts — TDD for Task 2a of the C3 slice.
 *
 * Task 2a gives BOTH forthcoming transport adapters (the MCP adapter, Task 3;
 * the loopback HTTP adapter, Task 5) exactly ONE dependency constructor and
 * exactly ONE explicit-reference policy, so neither can drift from the other or
 * bypass the core's opaque-reference boundary.
 *
 * What is pinned here:
 *  1. `makeCreateUiSpecDependencies(reader, now?)` injects the reader VERBATIM
 *     (no wrapping, no substitution, no second reader) and threads the optional
 *     clock through unchanged.
 *  2. The explicit-reference resolver is exactly
 *     `reader.getById(token) !== undefined ? token : undefined` — it recognizes
 *     ONLY ids the ACTIVE reader already exposes. An arbitrary filesystem path,
 *     a URL, a case-shifted or whitespace-padded variant, and any token absent
 *     from the active reader all resolve to `undefined`. The token is never
 *     normalized or repaired before the lookup.
 *  3. The PUBLIC reader cannot resolve an INELIGIBLE PRIVATE id. This is proved
 *     against a REAL `PublicCorpusReader` over a REAL exported snapshot built
 *     from a mixed fixture (one eligible entry, one entry-private entry, one
 *     unapproved entry) — not against a hand-rolled stand-in that merely
 *     imitates the reader's filtering.
 *  4. An ACCEPTED token never reaches output, the preserved evidence rows, or an
 *     error message. The core hashes it into the safe `ref-<sha256>` citation;
 *     that boundary is verified end-to-end through `createUiSpecForAdapter`,
 *     not assumed.
 *
 * No network and no paid-provider call: the reader is either a local fake or a
 * `PublicCorpusReader` over a temp-dir snapshot produced by the local exporter.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { CorpusEntryT } from "./schema.js";
import type { CorpusReader, ReaderImageIndex } from "./corpus-reader.js";
import { PublicCorpusReader } from "./corpus-reader.js";
import { exportPublicSnapshot } from "./publication/exporter.js";
import { makeCreateUiSpecDependencies } from "./create-ui-spec-dependencies.js";
import { createUiSpec, createUiSpecForAdapter } from "./create-ui-spec.js";
import { parseDesignArtifactEnvelope } from "./create-ui-spec-contracts.js";
import { sha256Hex } from "./readiness/contracts.js";

// ---------------------------------------------------------------------------
// A minimal local CorpusReader fake. `getById` is the ONLY method the resolver
// may consult, so every other method is a spy that fails the test if the
// resolver reaches for it.
// ---------------------------------------------------------------------------

// An intersection (not `interface extends`): the vitest `Mock` type is not
// assignable to the reader's precise method signatures, so declaring the
// override with `extends` would be an "incorrectly extends" type error. The
// intersection keeps the value usable as a real `CorpusReader` while exposing
// the mock API for call assertions.
type FakeReader = CorpusReader & {
  getById: ReturnType<typeof vi.fn>;
  searchRanked: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
};

function fakeEntry(id: string): CorpusEntryT {
  return {
    id,
    title: `${id} title`,
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    source: {
      productName: `${id}-product`,
      url: "https://private.example.com/secret",
      capturedAt: "2026-07-01",
      capturedBy: "self",
    },
    image: { visibility: "private", path: "images-private/secret.png", width: 100, height: 100 },
    visual: {},
    critique: "private-corpus-id critique prose must never leak",
    whatToSteal: ["private-corpus-id stealable prose"],
    antiPatterns: { antiPatterns: [], whereThisFails: [], accessibilityRisks: [] },
    qualityTier: "exceptional",
    qualityScore: 4,
    reviewStatus: "approved",
    addedAt: "2026-07-01",
  } as unknown as CorpusEntryT;
}

function makeFakeReader(ids: readonly string[]): FakeReader {
  const entries = ids.map((id) => fakeEntry(id));
  return {
    getById: vi.fn((id: string) => entries.find((e) => e.id === id)),
    searchRanked: vi.fn(async () => []),
    search: vi.fn(async () => []),
    findSimilar: vi.fn(() => []),
    listCategories: vi.fn(() => []),
    listStyleTags: vi.fn(() => []),
    listDomainTags: vi.fn(() => []),
    indexStatus: vi.fn(() => ({
      indexed: 0, total: entries.length, hasIndex: false, missing: 0, stale: 0, contentStale: 0,
    })),
    entriesForAggregation: vi.fn(() => entries as readonly CorpusEntryT[]),
    resolveImagePath: vi.fn(() => null),
    getImageIndex: vi.fn(async (): Promise<ReaderImageIndex | null> => null),
  } as unknown as FakeReader;
}

function validInput(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productContext: "A calm analytics dashboard for a fintech",
    referenceIds: [],
    constraints: [],
    motionIntents: [],
    ...over,
  };
}

const FIXED_NOW = (): Date => new Date("2026-07-28T00:00:00.000Z");

// ---------------------------------------------------------------------------
// 1. Construction — the reader and the clock are injected verbatim
// ---------------------------------------------------------------------------

describe("makeCreateUiSpecDependencies — construction", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("injects the passed reader verbatim (no wrapping, no substitution)", () => {
    const reader = makeFakeReader(["known-1"]);
    const deps = makeCreateUiSpecDependencies(reader);
    expect(deps.reader).toBe(reader);
  });

  it("threads the injected clock through unchanged", () => {
    const reader = makeFakeReader([]);
    const deps = makeCreateUiSpecDependencies(reader, FIXED_NOW);
    expect(deps.now).toBe(FIXED_NOW);
  });

  it("omits `now` when the caller supplies none (core default clock applies)", () => {
    const reader = makeFakeReader([]);
    const deps = makeCreateUiSpecDependencies(reader);
    expect(deps.now).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(deps, "now")).toBe(false);
  });

  it("supplies the resolver — adapters never author their own", () => {
    const deps = makeCreateUiSpecDependencies(makeFakeReader([]));
    expect(typeof deps.resolveReferenceToken).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// 2. The ONE explicit-reference policy
// ---------------------------------------------------------------------------

describe("makeCreateUiSpecDependencies — explicit-reference resolver", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("resolves an id the ACTIVE reader exposes to that same token", () => {
    const reader = makeFakeReader(["known-1"]);
    const deps = makeCreateUiSpecDependencies(reader);
    expect(deps.resolveReferenceToken("known-1")).toBe("known-1");
    expect(reader.getById).toHaveBeenCalledWith("known-1");
  });

  it("rejects a raw token the active reader does not expose", () => {
    const reader = makeFakeReader(["known-1"]);
    const deps = makeCreateUiSpecDependencies(reader);
    expect(deps.resolveReferenceToken("unknown-9")).toBeUndefined();
  });

  it("rejects an arbitrary filesystem path", () => {
    const reader = makeFakeReader(["known-1"]);
    const deps = makeCreateUiSpecDependencies(reader);
    for (const token of [
      "corpus/entries.json",
      "/etc/passwd",
      "../../corpus/images-private/secret.png",
      "images-private/secret.png",
    ]) {
      expect(deps.resolveReferenceToken(token), token).toBeUndefined();
      // Passed through to the reader EXACTLY as supplied — no normalization,
      // no path repair, no prefix stripping before the lookup.
      expect(reader.getById).toHaveBeenCalledWith(token);
    }
  });

  it("rejects a URL", () => {
    const reader = makeFakeReader(["known-1"]);
    const deps = makeCreateUiSpecDependencies(reader);
    for (const token of [
      "https://private.example.com/secret",
      "file:///Users/secret/corpus/entries.json",
    ]) {
      expect(deps.resolveReferenceToken(token), token).toBeUndefined();
    }
  });

  it("rejects an absent token without any fallback lookup", () => {
    const reader = makeFakeReader(["known-1"]);
    const deps = makeCreateUiSpecDependencies(reader);
    expect(deps.resolveReferenceToken("")).toBeUndefined();
    // Exactly one lookup per call, and NO other reader method is consulted —
    // there is no second/fallback resolution path to bypass the boundary with.
    expect(reader.getById).toHaveBeenCalledTimes(1);
    expect(reader.search).not.toHaveBeenCalled();
    expect(reader.searchRanked).not.toHaveBeenCalled();
    expect(reader.findSimilar).not.toHaveBeenCalled();
    expect(reader.entriesForAggregation).not.toHaveBeenCalled();
    expect(reader.resolveImagePath).not.toHaveBeenCalled();
  });

  it("does not normalize or repair the token before the lookup", () => {
    const reader = makeFakeReader(["known-1"]);
    const deps = makeCreateUiSpecDependencies(reader);
    // A case-shifted, whitespace-padded, or suffixed variant of a known id is a
    // DIFFERENT token. Repairing it would let a caller reach an entry the active
    // reader did not name.
    for (const token of ["KNOWN-1", " known-1", "known-1 ", "known-1/", "known-1.json"]) {
      expect(deps.resolveReferenceToken(token), token).toBeUndefined();
      expect(reader.getById).toHaveBeenCalledWith(token);
    }
  });

  it("re-reads the ACTIVE reader on every call (no memoized resolution table)", () => {
    const reader = makeFakeReader(["known-1"]);
    const deps = makeCreateUiSpecDependencies(reader);
    expect(deps.resolveReferenceToken("known-1")).toBe("known-1");
    reader.getById.mockImplementation(() => undefined);
    expect(deps.resolveReferenceToken("known-1")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Public-reader isolation — proved against a REAL PublicCorpusReader
// ---------------------------------------------------------------------------

const NOW_DATE = "2026-07-12T00:00:00.000Z";
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

function snapshotEntry(id: string, critique: string): CorpusEntryT {
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
    antiPatterns: {
      antiPatterns: [`${id} antipattern`],
      whereThisFails: [],
      accessibilityRisks: [],
      legacyAccessibilityNotes: [],
    },
    qualityTier: "exceptional",
    qualityScore: 4,
    reviewStatus: "approved",
    addedAt: "2026-07-01",
    publication: { ...eligiblePublication },
  } as CorpusEntryT;
}

describe("makeCreateUiSpecDependencies — public-reader isolation (real snapshot)", () => {
  let root: string;
  let reader: PublicCorpusReader;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "c3-deps-public-"));
    const imageRoot = resolve(root, "images-public");
    const snapshotDir = resolve(root, "public-snapshots");
    mkdirSync(imageRoot, { recursive: true });
    mkdirSync(snapshotDir, { recursive: true });
    for (const id of [ELIGIBLE_ID, PRIVATE_ID, UNAPPROVED_ID]) {
      writeFileSync(resolve(imageRoot, `${id}.png`), PNG_BYTES);
    }
    const eligible = snapshotEntry(
      ELIGIBLE_ID,
      "This dashboard uses calm spacing, restrained color, and a clear visual hierarchy.",
    );
    const privateEntry = {
      ...snapshotEntry(PRIVATE_ID, "Confidential client financial details behind a login, not for redistribution."),
      publication: { ...eligiblePublication, visibility: "private" },
    } as CorpusEntryT;
    const unapproved = {
      ...snapshotEntry(UNAPPROVED_ID, "Pending legal review and sign-off before it may be redistributed openly."),
      publication: { ...eligiblePublication, clearance: "unreviewed" },
    } as CorpusEntryT;
    const result = exportPublicSnapshot({
      corpusEntries: [eligible, privateEntry, unapproved],
      snapshotDir,
      imageRoot,
      now: NOW_DATE,
    });
    // Sanity: only the eligible entry shipped into the snapshot.
    expect(result.entryCount).toBe(1);
    reader = new PublicCorpusReader(result.snapshotPath, "2026-07-12");
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("cannot resolve an INELIGIBLE PRIVATE id through the public reader", () => {
    const deps = makeCreateUiSpecDependencies(reader);
    expect(deps.resolveReferenceToken(PRIVATE_ID)).toBeUndefined();
  });

  it("cannot resolve an unapproved (clearance-pending) id through the public reader", () => {
    const deps = makeCreateUiSpecDependencies(reader);
    expect(deps.resolveReferenceToken(UNAPPROVED_ID)).toBeUndefined();
  });

  it("resolves the eligible snapshot id (the policy is narrow, not broken)", () => {
    const deps = makeCreateUiSpecDependencies(reader);
    expect(deps.resolveReferenceToken(ELIGIBLE_ID)).toBe(ELIGIBLE_ID);
  });

  it("raises INVALID_INPUT when a public-mode caller supplies only an ineligible private id", async () => {
    const deps = makeCreateUiSpecDependencies(reader, FIXED_NOW);
    const err = await createUiSpec(validInput({ referenceIds: [PRIVATE_ID] }), deps)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "INVALID_INPUT", retryable: false });
    // The refused token is not echoed back to the caller.
    expect((err as { message?: string }).message ?? "").not.toContain(PRIVATE_ID);
  });
});

// ---------------------------------------------------------------------------
// 4. The accepted token never reaches output, evidence rows, or an error
// ---------------------------------------------------------------------------

describe("makeCreateUiSpecDependencies — the accepted token stays out of every surface", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  // A distinctive private-looking corpus id: in PRIVATE mode the resolver
  // legitimately accepts it (the active reader exposes it), so the ONLY thing
  // keeping it out of public output is the core's `ref-<sha256>` hashing.
  const TOKEN = "internal-secret-entry-4711";

  it("publishes only the ref-<sha256> digest of an accepted token", async () => {
    const reader = makeFakeReader([TOKEN]);
    const deps = makeCreateUiSpecDependencies(reader, FIXED_NOW);
    const env = await createUiSpec(validInput({ referenceIds: [TOKEN] }), deps);
    const parsed = parseDesignArtifactEnvelope(env);
    const expected = `ref-${sha256Hex(Buffer.from(TOKEN, "utf-8"))}`;
    expect(parsed.spec.citedReferences).toEqual([expected]);
    expect(parsed.spec.provenance.sourceReferences).toEqual([expected]);
  });

  it("never leaks the accepted token into the envelope", async () => {
    const reader = makeFakeReader([TOKEN]);
    const deps = makeCreateUiSpecDependencies(reader, FIXED_NOW);
    const env = await createUiSpec(validInput({ referenceIds: [TOKEN] }), deps);
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain(TOKEN);
    expect(serialized).not.toContain("images-private/");
    expect(serialized).not.toContain("private.example.com");
  });

  it("never leaks the accepted token into the preserved evidence rows", async () => {
    const reader = makeFakeReader([TOKEN]);
    const deps = makeCreateUiSpecDependencies(reader, FIXED_NOW);
    const { sanitizedEvidence } = await createUiSpecForAdapter(
      validInput({ referenceIds: [TOKEN] }),
      deps,
    );
    const serialized = JSON.stringify(sanitizedEvidence);
    expect(serialized).not.toContain(TOKEN);
    const publicRef = sanitizedEvidence.find((e) => e.kind === "public-reference");
    expect(publicRef?.publicReference).toMatch(/^ref-[0-9a-f]{64}$/);
  });

  it("keeps evidence-N and ref-<sha256> in separate domains", async () => {
    const reader = makeFakeReader([TOKEN]);
    const deps = makeCreateUiSpecDependencies(reader, FIXED_NOW);
    const { envelope, sanitizedEvidence } = await createUiSpecForAdapter(
      validInput({ referenceIds: [TOKEN] }),
      deps,
    );
    for (const id of envelope.publicEvidenceIds) {
      expect(id).toMatch(/^evidence-[0-9]+$/);
      expect(id).not.toMatch(/^ref-/);
    }
    for (const row of sanitizedEvidence) {
      if (row.publicReference !== undefined) {
        expect(row.publicReference).not.toMatch(/^evidence-/);
      }
    }
  });

  it("never echoes a REFUSED token in the INVALID_INPUT message", async () => {
    const reader = makeFakeReader([]);
    const deps = makeCreateUiSpecDependencies(reader, FIXED_NOW);
    const err = await createUiSpec(
      validInput({ referenceIds: ["/Users/secret/corpus/images-private/leak.png"] }),
      deps,
    ).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "INVALID_INPUT", retryable: false });
    const msg = (err as { message?: string }).message ?? "";
    expect(msg).not.toContain("/Users/secret");
    expect(msg).not.toContain("images-private");
    expect(msg).not.toContain("leak.png");
  });

  it("wraps a reader.getById failure as RETRIEVAL_UNAVAILABLE with a safe message", async () => {
    const reader = makeFakeReader([TOKEN]);
    reader.getById.mockImplementation(() => {
      throw new Error("disk read failed /Users/secret/corpus/images-private/leak.png");
    });
    const deps = makeCreateUiSpecDependencies(reader, FIXED_NOW);
    const err = await createUiSpec(validInput({ referenceIds: [TOKEN] }), deps)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "RETRIEVAL_UNAVAILABLE", retryable: true });
    const msg = (err as { message?: string }).message ?? "";
    expect(msg).not.toContain("/Users/secret");
    expect(msg).not.toContain("images-private");
  });
});
