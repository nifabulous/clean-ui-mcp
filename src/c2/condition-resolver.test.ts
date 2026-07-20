/**
 * C2 condition-resolver tests (Task 6, Step 1).
 *
 * The resolver converts a model-visible brief + a control condition into an
 * immutable, content-addressed condition input. The three control conditions
 * are exercised here:
 *   - brief-only        : no evidence, no retrieval metadata.
 *   - current-grounded  : deterministic query over the brief only, ranked
 *                          retrieval via the injected CorpusReader, with the
 *                          full ranking + corpus snapshot preserved privately.
 *   - gold-evidence     : the descriptor's JSON pointers resolved against the
 *                          bound source artifact, exact equality with the
 *                          label's goldEvidenceIds, evidence records only for
 *                          the resolved gold IDs.
 *
 * Adversarial properties (spec §5):
 *   - The current-grounded query is derived ONLY from model-visible brief
 *     fields. Reviewer-only label data (gold IDs, rubric anchors, adjudication
 *     notes) cannot influence the query or the ranking.
 *   - Mutating the corpus entries, ranking order, source snapshot bytes, or a
 *     gold-evidence descriptor pointer changes `inputSha256`. Mutating a
 *     reviewer-only gold label does NOT change a current-grounded input.
 *   - The retrieval pin is literal `searchMode: "keyword-only"` even when a
 *     Voyage key + index would otherwise enable hybrid.
 *   - The corpus hash is captured before and after ranking; a mid-resolution
 *     mutation aborts the run.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import type { CorpusReader, SearchResult } from "../corpus-reader.js";
import type { CorpusEntryT } from "../schema.js";
import {
  resolveConditionInput,
  type ResolveConditionInputRequest,
  type ResolveConditionDeps,
  type ResolvedConditionInput,
} from "./condition-resolver.js";
import type {
  C2CaseBrief,
  C2DecisionLabel,
  C2GoldEvidenceDescriptor,
} from "./case-contracts.js";
import type { C2ConditionInput } from "./condition-contracts.js";
import { canonicalJsonStringify } from "../readiness/contracts.js";

/** SHA-256 of the canonical JSON of a brief — matches what the resolver binds. */
function briefSha256(brief: C2CaseBrief): string {
  return createHash("sha256")
    .update(Buffer.from(canonicalJsonStringify(brief), "utf-8"))
    .digest("hex");
}
/** SHA-256 of a descriptor's on-disk bytes. */
function fileSha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../..");
const STABLECOIN_BRIEF_PATH = "eval/c2/pilot/briefs/stablecoin-home.json";
const STABLECOIN_LABEL_PATH = "eval/c2/pilot/labels/stablecoin-home.json";
const STABLECOIN_DESCRIPTOR_PATH = "eval/c2/pilot/evidence/stablecoin-home.json";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(join(REPO_ROOT, path), "utf-8")) as T;
}

/**
 * Build a minimal brief that parses against C2CaseBriefSchema. Uses the real
 * stablecoin brief by default (it is committed, portable, synthetic), with
 * selective overrides for tests that need to vary individual fields.
 */
function makeBrief(overrides: Partial<C2CaseBrief> = {}): C2CaseBrief {
  const base = readJson<C2CaseBrief>(STABLECOIN_BRIEF_PATH);
  return { ...base, ...overrides };
}

function makeLabel(overrides: Partial<C2DecisionLabel> = {}): C2DecisionLabel {
  const base = readJson<C2DecisionLabel>(STABLECOIN_LABEL_PATH);
  return { ...base, ...overrides };
}

function makeDescriptor(overrides: Partial<C2GoldEvidenceDescriptor> = {}): C2GoldEvidenceDescriptor {
  const base = readJson<C2GoldEvidenceDescriptor>(STABLECOIN_DESCRIPTOR_PATH);
  return { ...base, ...overrides };
}

/**
 * Construct a fake CorpusReader whose `searchRanked` returns a stable ranked
 * list. The spy lets tests assert the exact call shape (query + literal
 * `searchMode: "keyword-only"` + `reviewStatus: "approved"` + `rerank: false`).
 */
function makeFakeReader(ranked: SearchResult[]): {
  reader: CorpusReader;
  searchRanked: ReturnType<typeof vi.fn>;
} {
  const searchRanked = vi.fn(async () => ranked) as never;
  const reader = {
    searchRanked,
    search: vi.fn(async () => ranked.map((r) => r.entry)) as never,
    getById: vi.fn(() => undefined) as never,
    findSimilar: vi.fn(() => []) as never,
    listCategories: vi.fn(() => []) as never,
    listStyleTags: vi.fn(() => []) as never,
    listDomainTags: vi.fn(() => []) as never,
    indexStatus: vi.fn(() => ({
      indexed: 0, total: 0, hasIndex: false, missing: 0, stale: 0, contentStale: 0,
    })) as never,
    entriesForAggregation: vi.fn(() => []) as never,
    resolveImagePath: vi.fn(() => null) as never,
    getImageIndex: vi.fn(async () => null) as never,
  } as unknown as CorpusReader;
  return { reader, searchRanked };
}

/** Two corpus entries returned in stable order by the fake reader. */
function makeCorpusResults(): SearchResult[] {
  const entryA = {
    id: "entry-a",
    title: "Entry A",
    categories: ["dashboard"],
    styleTags: [],
    components: [],
    domainTags: [],
    patternType: "dashboard",
    critique: "alpha alpha alpha",
    whatToSteal: [],
    antiPatterns: { antiPatterns: [], whereThisFails: [] },
    qualityScore: 7,
    qualityTier: "strong",
    platform: "web" as const,
    reviewStatus: "approved" as const,
    visual: {
      dominantColors: [],
      accentColor: null,
      spacingDensity: null,
      cornerStyle: null,
      typePairing: { display: null, body: null, notes: null },
    },
    source: { productName: "Alpha", url: "https://example.com/alpha" },
    image: { path: "images-private/entry-a.png", format: "png", width: 100, height: 100 },
    businessRationale: null,
    mood: null,
    colorScheme: null,
    industryVertical: null,
    responsiveBehavior: null,
  } as unknown as CorpusEntryT;
  const entryB = { ...entryA, id: "entry-b", title: "Entry B" } as unknown as CorpusEntryT;
  return [
    { entry: entryA, score: 0.9, searchMode: "keyword" as const },
    { entry: entryB, score: 0.5, searchMode: "keyword" as const },
  ];
}

/** The deterministic query the resolver must produce from the brief fields. */
function expectedBriefQuery(brief: C2CaseBrief): string {
  return [
    brief.title,
    brief.productContext,
    ...brief.users,
    ...brief.jobs,
    brief.platform,
    ...brief.requiredJourneys,
    ...brief.constraints,
    ...brief.requiredScreens.map((s) => s.id),
  ].join(" ").trim();
}

/**
 * Build the dependency bag against a temp private directory. Each dep is a spy
 * so tests can assert what was written privately vs. durably.
 */
function makeDeps(opts: {
  privateRoot: string;
  ranked?: SearchResult[];
  readArtifact?: (path: string) => Buffer;
  writePrivate?: (relPath: string, bytes: Buffer) => void;
  now?: () => string;
}): {
  deps: ResolveConditionDeps;
  searchRanked: ReturnType<typeof vi.fn>;
  writtenPrivate: Array<{ relPath: string; bytes: Buffer }>;
} {
  const ranked = opts.ranked ?? makeCorpusResults();
  const { reader, searchRanked } = makeFakeReader(ranked);
  const writtenPrivate: Array<{ relPath: string; bytes: Buffer }> = [];
  const writePrivate =
    opts.writePrivate ??
    ((relPath: string, bytes: Buffer) => {
      const abs = join(opts.privateRoot, relPath);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, bytes);
      writtenPrivate.push({ relPath, bytes });
    });
  // Synthetic corpus bytes for tests. The real corpus/entries.json is gitignored
  // (3.6 MB, absent on clean CI), so tests must NOT depend on it. This synthetic
  // corpus provides stable bytes for the resolver's snapshot + re-hash checks.
  const SYNTHETIC_CORPUS = Buffer.from(
    JSON.stringify({ version: 2, entries: [
      { id: "synthetic-1", title: "Synthetic Entry 1", reviewStatus: "approved", source: "synthetic", image: "synthetic/1.png", addedAt: "2026-01-01T00:00:00Z" },
      { id: "synthetic-2", title: "Synthetic Entry 2", reviewStatus: "approved", source: "synthetic", image: "synthetic/2.png", addedAt: "2026-01-01T00:00:00Z" },
    ] }),
  );
  const readArtifact =
    opts.readArtifact ?? ((path: string) => {
      // Route corpus/entries.json to synthetic bytes; everything else (committed
      // pilot briefs/labels/snapshots/evidence) reads from the real repo tree.
      if (path === "corpus/entries.json") return SYNTHETIC_CORPUS;
      return readFileSync(join(REPO_ROOT, path));
    });
  const deps: ResolveConditionDeps = {
    reader,
    readArtifact,
    writePrivate,
    now: opts.now ?? (() => "2026-07-20T00:00:00.000Z"),
  };
  return { deps, searchRanked, writtenPrivate };
}

// Resolve is imported lazily through the resolve() helper so each test builds a
// fresh request object and deps bag.

function makeRequest(overrides: Partial<ResolveConditionInputRequest> = {}): ResolveConditionInputRequest {
  const brief = overrides.brief ?? readJson<C2CaseBrief>(STABLECOIN_BRIEF_PATH);
  const base: ResolveConditionInputRequest = {
    casePackageRef: {
      artifactId: "c2-package-stablecoin-home-v1",
      path: "eval/c2/pilot/manifest.json",
      sha256: "a".repeat(64),
    },
    briefRef: {
      artifactId: "c2-brief-stablecoin-home-v1",
      path: STABLECOIN_BRIEF_PATH,
      sha256: briefSha256(brief),
    },
    brief,
    condition: "brief-only",
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("resolveConditionInput", () => {
  let privateRoot: string;

  beforeEach(() => {
    privateRoot = mkdtempSync(join(tmpdir(), "c2-condition-private-"));
  });
  afterEach(() => {
    try { rmSync(privateRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // ── Brief-only ──────────────────────────────────────────────────────────────

  it("brief-only produces empty evidence and never queries the reader", async () => {
    const { deps, searchRanked } = makeDeps({ privateRoot });
    const request = makeRequest({
      condition: "brief-only",
      brief: makeBrief(),
    });
    const result = await resolveConditionInput(request, deps);

    expect(result.metadata.condition).toBe("brief-only");
    expect(result.metadata.evidence).toEqual([]);
    expect(searchRanked).not.toHaveBeenCalled();
    // The durable metadata validates against the contract schema.
    const parsed = result.metadata;
    expect(parsed.inputSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("brief-only inputSha256 is stable for the same brief and changes when the brief changes", async () => {
    const { deps: deps1 } = makeDeps({ privateRoot });
    const brief = makeBrief();
    const r1 = await resolveConditionInput(makeRequest({ condition: "brief-only", brief }), deps1);

    const { deps: deps2 } = makeDeps({ privateRoot });
    const r2 = await resolveConditionInput(makeRequest({ condition: "brief-only", brief }), deps2);
    expect(r2.metadata.inputSha256).toBe(r1.metadata.inputSha256);

    // Mutate the brief — a model-visible field. inputSha256 MUST change because
    // the resolver binds the brief's canonical hash via briefRef.sha256.
    const mutated: C2CaseBrief = { ...brief, title: `${brief.title} (edited)` };
    const { deps: deps3 } = makeDeps({ privateRoot });
    const r3 = await resolveConditionInput(
      makeRequest({
        condition: "brief-only",
        brief: mutated,
        briefRef: {
          artifactId: brief.artifactId,
          path: STABLECOIN_BRIEF_PATH,
          sha256: briefSha256(mutated),
        },
      }),
      deps3,
    );
    expect(r3.metadata.inputSha256).not.toBe(r1.metadata.inputSha256);
  });

  // ── Current-grounded ────────────────────────────────────────────────────────

  it("current-grounded derives the query from brief fields and pins keyword-only retrieval", async () => {
    const brief = makeBrief();
    // Pass the REAL production stablecoin label on the request. The resolver
    // must IGNORE it for current-grounded (the security property), so none of
    // its reviewer-only field values may reach the query, the ranking, or the
    // private payload. Asserting against a string that exists only in this
    // fixture — not a sentinel invented for the test — proves the real
    // production label cannot leak.
    const label = makeLabel();
    const { deps, searchRanked } = makeDeps({ privateRoot });
    const result = await resolveConditionInput(
      makeRequest({ condition: "current-grounded", brief, label }),
      deps,
    ) as ResolvedConditionInput & { metadata: Extract<C2ConditionInput, { condition: "current-grounded" }> };

    expect(result.metadata.condition).toBe("current-grounded");
    const expectedQuery = expectedBriefQuery(brief);
    expect(searchRanked).toHaveBeenCalledTimes(1);
    expect(searchRanked).toHaveBeenCalledWith({
      query: expectedQuery,
      limit: 10,
      reviewStatus: "approved",
      rerank: false,
      searchMode: "keyword-only",
    });

    // Evidence IDs are corpus:<entry-id>, stable order.
    expect(result.metadata.evidence.map((e) => e.id)).toEqual([
      "corpus:entry-a",
      "corpus:entry-b",
    ]);
    // Every evidence record points to a corpus source with a content hash.
    for (const rec of result.metadata.evidence) {
      expect(rec.sourceType).toBe("corpus-entry");
      expect(rec.sourceArtifactId).toBe("corpus");
      expect(rec.contentSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(rec.sourceSha256).toBe(result.metadata.corpusSha256);
    }
    // The complete ranked result is preserved.
    expect(result.metadata.retrieval.rankedResult.map((r) => r.entryId)).toEqual([
      "entry-a",
      "entry-b",
    ]);
    // The literal retrieval mode is recorded in the private payload.
    expect(result.privatePayload).toContain('"retrievalMode":"keyword-only"');
    // The private payload carries the actual evidence content bytes.
    expect(result.privatePayload).toContain("corpus:entry-a");
    // Reviewer-only values from eval/c2/pilot/labels/stablecoin-home.json must
    // never reach the private payload, even when the label is present on the
    // request. One representative value per reviewer-only field type, drawn from
    // the REAL production fixture (not an invented sentinel) so a genuine leak
    // would be caught.
    expect(result.privatePayload).not.toContain("/corpus/private/stablecoin-home/placeholder"); // privateMarker
    expect(result.privatePayload).not.toContain("licensed in every market"); // forbiddenClaim
    expect(result.privatePayload).not.toContain("request-access; do not prescribe"); // adjudicationNote
    expect(result.privatePayload).not.toContain("pre-launch B2B infrastructure brand"); // rubricAnchor.anchoredExample
  });

  it("current-grounded inputSha256 changes when the corpus ranking changes", async () => {
    const brief = makeBrief();

    const { deps: depsA } = makeDeps({ privateRoot, ranked: makeCorpusResults() });
    const r1 = await resolveConditionInput(
      makeRequest({ condition: "current-grounded", brief }),
      depsA,
    );

    // Swap the ranking order so entry-b ranks first.
    const swapped = [...makeCorpusResults()].reverse();
    const { deps: depsB } = makeDeps({ privateRoot, ranked: swapped });
    const r2 = await resolveConditionInput(
      makeRequest({ condition: "current-grounded", brief }),
      depsB,
    );
    expect(r2.metadata.inputSha256).not.toBe(r1.metadata.inputSha256);
  });

  it("current-grounded inputSha256 changes when a corpus entry's bytes change", async () => {
    const brief = makeBrief();
    const { deps: deps1 } = makeDeps({ privateRoot });
    const r1 = await resolveConditionInput(
      makeRequest({ condition: "current-grounded", brief }),
      deps1,
    );

    // Mutate a corpus entry title. The fake reader is invoked twice (two
    // independent resolutions), but the second resolution reads different
    // corpus bytes — captured into the private snapshot — so the input hash
    // must differ.
    const mutatedResults = makeCorpusResults().map((r, i) =>
      i === 0 ? { ...r, entry: { ...r.entry, title: "Mutated Title", critique: "different" } } : r,
    );
    const { deps: deps2 } = makeDeps({ privateRoot, ranked: mutatedResults });
    const r2 = await resolveConditionInput(
      makeRequest({ condition: "current-grounded", brief }),
      deps2,
    );
    expect(r2.metadata.inputSha256).not.toBe(r1.metadata.inputSha256);
  });

  it("current-grounded query is independent of reviewer-only label data (gold mutation does NOT change the query)", async () => {
    // Build two distinct labels that share the SAME brief. The resolver must
    // produce identical current-grounded inputSha256 because the query comes
    // from the brief alone and the reader's ranked results are identical.
    const brief = makeBrief();
    const labelA = makeLabel({ adjudicationNotes: ["note A"] });
    const labelB = makeLabel({ adjudicationNotes: ["note B"] });
    expect(labelA.adjudicationNotes).not.toEqual(labelB.adjudicationNotes);

    const { deps: depsA } = makeDeps({ privateRoot });
    const rA = await resolveConditionInput(
      makeRequest({ condition: "current-grounded", brief, label: labelA }),
      depsA,
    );
    const { deps: depsB } = makeDeps({ privateRoot });
    const rB = await resolveConditionInput(
      makeRequest({ condition: "current-grounded", brief, label: labelB }),
      depsB,
    );
    expect(rB.metadata.inputSha256).toBe(rA.metadata.inputSha256);
  });

  it("current-grounded aborts when corpus/entries.json changes during resolution", async () => {
    const brief = makeBrief();
    // readArtifact returns entries.json bytes that DIFFER on the second read
    // (before vs. after ranking). The resolver must detect this and throw.
    // Uses synthetic bytes — the real corpus is gitignored and absent on CI.
    const baseBytes = Buffer.from(JSON.stringify({ version: 2, entries: [{ id: "x", title: "X", reviewStatus: "approved", source: "s", image: "s/x.png", addedAt: "2026-01-01T00:00:00Z" }] }));
    const altBytes = Buffer.concat([baseBytes, Buffer.from("\n// mutated\n")]);
    let readCount = 0;
    const readArtifact = vi.fn((_path: string) => {
      readCount += 1;
      // The first read captures the pre-ranking snapshot, the second verifies
      // post-ranking. Returning different bytes forces the abort.
      return readCount === 1 ? baseBytes : altBytes;
    }) as never;
    const { deps } = makeDeps({ privateRoot, readArtifact });
    await expect(
      resolveConditionInput(makeRequest({ condition: "current-grounded", brief }), deps),
    ).rejects.toThrow(/corpus/i);
  });

  // ── Gold-evidence ───────────────────────────────────────────────────────────

  it("gold-evidence resolves descriptor pointers against the bound brief and produces evidence for every gold ID", async () => {
    const brief = makeBrief();
    const label = makeLabel();
    const descriptor = makeDescriptor();
    const { deps } = makeDeps({ privateRoot });
    const descriptorPath = join(REPO_ROOT, STABLECOIN_DESCRIPTOR_PATH);

    const result = await resolveConditionInput(
      makeRequest({
        condition: "gold-evidence",
        brief,
        label,
        goldEvidenceDescriptor: descriptor,
        goldDescriptorRef: {
          artifactId: descriptor.artifactId,
          path: STABLECOIN_DESCRIPTOR_PATH,
          sha256: fileSha256(descriptorPath),
        },
      }),
      deps,
    );

    expect(result.metadata.condition).toBe("gold-evidence");
    // Resolved gold IDs are EXACTLY the label's goldEvidenceIds.
    const gold = result.metadata as Extract<C2ConditionInput, { condition: "gold-evidence" }>;
    expect(gold.resolvedGoldIds).toEqual(label.goldEvidenceIds);
    expect(gold.evidence.map((e) => e.id)).toEqual(label.goldEvidenceIds);
    // Source artifact is the brief (stablecoin descriptor points at brief fields).
    for (const rec of gold.evidence) {
      expect(rec.sourceType).toBe("brief-fragment");
      expect(rec.sourceArtifactId).toBe(brief.artifactId);
    }
  });

  it("gold-evidence rejects a descriptor whose hash differs from the manifest binding", async () => {
    const brief = makeBrief();
    const label = makeLabel();
    const descriptor = makeDescriptor();
    const { deps } = makeDeps({ privateRoot });

    // Bind a descriptor hash that does NOT match the on-disk bytes.
    await expect(
      resolveConditionInput(
        makeRequest({
          condition: "gold-evidence",
          brief,
          label,
          goldEvidenceDescriptor: descriptor,
          goldDescriptorRef: {
            artifactId: descriptor.artifactId,
            path: STABLECOIN_DESCRIPTOR_PATH,
            sha256: "deadbeef".repeat(8),
          },
        }),
        deps,
      ),
    ).rejects.toThrow(/descriptor.*hash|hash.*descriptor/i);
  });

  it("gold-evidence rejects when the resolved gold IDs do not exactly match the label's gold IDs", async () => {
    const brief = makeBrief();
    const label = makeLabel();
    const descriptor = makeDescriptor();
    const { deps } = makeDeps({ privateRoot });
    const descriptorPath = join(REPO_ROOT, STABLECOIN_DESCRIPTOR_PATH);

    // Remove one gold ID from the label so the resolved set is a strict superset.
    const truncatedLabel: C2DecisionLabel = {
      ...label,
      goldEvidenceIds: label.goldEvidenceIds.slice(0, -1),
    };
    await expect(
      resolveConditionInput(
        makeRequest({
          condition: "gold-evidence",
          brief,
          label: truncatedLabel,
          goldEvidenceDescriptor: descriptor,
          goldDescriptorRef: {
            artifactId: descriptor.artifactId,
            path: STABLECOIN_DESCRIPTOR_PATH,
            sha256: fileSha256(descriptorPath),
          },
        }),
        deps,
      ),
    ).rejects.toThrow(/gold/i);
  });

  it("gold-evidence rejects duplicate or unresolvable JSON pointers", async () => {
    const brief = makeBrief();
    const label = makeLabel();
    const { deps } = makeDeps({ privateRoot });
    const descriptorPath = join(REPO_ROOT, STABLECOIN_DESCRIPTOR_PATH);

    // Inject a descriptor record pointing at a JSON pointer that does not exist
    // on the brief.
    const badDescriptor: C2GoldEvidenceDescriptor = {
      ...makeDescriptor(),
      records: [
        {
          id: label.goldEvidenceIds[0]!,
          sourceArtifactId: brief.artifactId,
          jsonPointers: ["/does/not/exist"],
        },
      ],
    };

    await expect(
      resolveConditionInput(
        makeRequest({
          condition: "gold-evidence",
          brief,
          label: { ...label, goldEvidenceIds: [label.goldEvidenceIds[0]!] },
          goldEvidenceDescriptor: badDescriptor,
          goldDescriptorRef: {
            artifactId: badDescriptor.artifactId,
            path: STABLECOIN_DESCRIPTOR_PATH,
            sha256: fileSha256(descriptorPath),
          },
        }),
        deps,
      ),
    ).rejects.toThrow(/pointer|unresolved|resolve/i);
  });

  it("gold-evidence inputSha256 changes when a descriptor pointer changes", async () => {
    const brief = makeBrief();
    const label = makeLabel();
    const descriptorA = makeDescriptor();
    const descriptorB: C2GoldEvidenceDescriptor = {
      ...descriptorA,
      records: descriptorA.records.map((r) =>
        r.id === descriptorA.records[0]!.id
          ? { ...r, jsonPointers: ["/title"] }
          : r,
      ),
    };
    const descriptorPath = join(REPO_ROOT, STABLECOIN_DESCRIPTOR_PATH);
    const realDescriptorSha = fileSha256(descriptorPath);
    const { deps: depsA } = makeDeps({ privateRoot });
    const rA = await resolveConditionInput(
      makeRequest({
        condition: "gold-evidence",
        brief,
        label,
        goldEvidenceDescriptor: descriptorA,
        goldDescriptorRef: { artifactId: descriptorA.artifactId, path: STABLECOIN_DESCRIPTOR_PATH, sha256: realDescriptorSha },
      }),
      depsA,
    );
    const { deps: depsB } = makeDeps({ privateRoot });
    const rB = await resolveConditionInput(
      makeRequest({
        condition: "gold-evidence",
        brief,
        label,
        goldEvidenceDescriptor: descriptorB,
        goldDescriptorRef: { artifactId: descriptorB.artifactId, path: STABLECOIN_DESCRIPTOR_PATH, sha256: realDescriptorSha },
      }),
      depsB,
    );
    expect(rB.metadata.inputSha256).not.toBe(rA.metadata.inputSha256);
  });

  // ── Source snapshot (migration) ─────────────────────────────────────────────

  it("current-grounded includes the bound source snapshot reference for migration cases", async () => {
    const brief = readJson<C2CaseBrief>("eval/c2/pilot/briefs/public-marketing-migration.json");
    const { deps } = makeDeps({ privateRoot });
    const result = await resolveConditionInput(
      makeRequest({
        condition: "current-grounded",
        brief,
        sourceSnapshotRef: brief.sourceSnapshotRef,
      }),
      deps,
    );
    const cg = result.metadata as Extract<C2ConditionInput, { condition: "current-grounded" }>;
    expect(cg.sourceSnapshotRefs).toHaveLength(1);
    expect(cg.sourceSnapshotRefs[0]!.artifactId).toBe(brief.sourceSnapshotRef!.artifactId);
    // Mutating the snapshot bytes would flip the hash. Pin the binding hash to
    // the actual file digest and verify it's recorded.
    expect(cg.sourceSnapshotRefs[0]!.sha256).toBe(brief.sourceSnapshotRef!.sha256);
  });

  it("changing the source snapshot bytes changes the inputSha256 for migration cases", async () => {
    const brief = readJson<C2CaseBrief>("eval/c2/pilot/briefs/public-marketing-migration.json");
    const { deps: deps1 } = makeDeps({ privateRoot });
    const r1 = await resolveConditionInput(
      makeRequest({ condition: "current-grounded", brief, sourceSnapshotRef: brief.sourceSnapshotRef }),
      deps1,
    );
    // Mutate the declared snapshot hash (simulates the snapshot bytes changing).
    const mutatedSnap = { ...brief.sourceSnapshotRef!, sha256: "f".repeat(64) };
    const { deps: deps2 } = makeDeps({ privateRoot });
    const r2 = await resolveConditionInput(
      makeRequest({ condition: "current-grounded", brief, sourceSnapshotRef: mutatedSnap }),
      deps2,
    );
    expect(r2.metadata.inputSha256).not.toBe(r1.metadata.inputSha256);
  });

  // ── Production search regression ────────────────────────────────────────────
  //
  // These tests use the REAL searchRanked dispatch from corpus.ts (not a fake
  // reader) to prove:
  //   - With VOYAGE_API_KEY set AND an index present, `searchMode: "keyword-only"`
  //     makes NO Voyage request and returns only keyword results.
  //   - Omitting searchMode preserves today's environment-sensitive dispatch.
  //
  // The fixture corpus is injected via setCorpusForTesting so the index lookup
  // in vectorSearch falls back to keywordSearch (no live index for fixture
  // entries), which keeps the test hermetic.

  it("production searchRanked with searchMode:keyword-only never returns hybrid results even when VOYAGE_API_KEY is set", async () => {
    const prevKey = process.env.VOYAGE_API_KEY;
    process.env.VOYAGE_API_KEY = "test-voyage-key";
    try {
      const { searchRanked, setCorpusForTesting } = await import("../corpus.js");
      setCorpusForTesting([
        {
          id: "kw-only-entry",
          title: "Keyword Only Entry",
          categories: ["dashboard"],
          styleTags: [],
          components: [],
          domainTags: [],
          patternType: "dashboard",
          critique: "",
          whatToSteal: [],
          antiPatterns: { antiPatterns: [], whereThisFails: [] },
          qualityScore: 7,
          qualityTier: "strong",
          platform: "web",
          reviewStatus: "approved",
          visual: {
            dominantColors: [],
            accentColor: null,
            spacingDensity: null,
            cornerStyle: null,
            typePairing: { display: null, body: null, notes: null },
          },
          source: { productName: "X", url: "https://example.com" },
          image: { path: "images-private/kw-only.png", format: "png", width: 1, height: 1 },
        } as unknown as CorpusEntryT,
      ]);
      const results = await searchRanked({
        query: "keyword only entry",
        limit: 5,
        searchMode: "keyword-only",
      });
      expect(results.every((r) => r.searchMode === "keyword")).toBe(true);
      expect(results.some((r) => r.searchMode === "hybrid")).toBe(false);
      setCorpusForTesting(null);
    } finally {
      if (prevKey === undefined) delete process.env.VOYAGE_API_KEY;
      else process.env.VOYAGE_API_KEY = prevKey;
    }
  });
});
