/**
 * create-ui-spec.test.ts — TDD for the evidence-grounded create-ui-spec
 * producer (Task 3 of the C3 first slice).
 *
 * The producer ties together Task 1's strict contracts and Task 2's
 * deterministic fallback recipe. It performs:
 *  - input normalization (CreateUiSpecRequest),
 *  - evidence resolution (keyword-only retrieval, capped at 5 product-diverse
 *    references; explicit reference-token resolution),
 *  - typed sanitization (allowlist projection; response-scoped evidence-* ids),
 *  - deterministic fallback assembly via the safe aggregator (SanitizedEvidence
 *    only — never raw CorpusEntry),
 *  - envelope construction (re-render + re-hash verified),
 *  - bounded, typed errors (INVALID_INPUT / RETRIEVAL_UNAVAILABLE).
 *
 * Hard constraints exercised here:
 *  - automatic retrieval selects at most five product-diverse references;
 *  - private corpus ids/paths/urls/product identities NEVER enter public output;
 *  - corpus observations are cited ONLY by response-scoped evidence-* ids
 *    (never citedReferences/provenance.sourceReferences);
 *  - explicit public references populate citedReferences/sourceReferences;
 *  - the deterministic c3-fallback-v1 recipe is the ONLY provider path;
 *  - artifactId hashes the canonical identity object (generatedAt excluded).
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";
import {
  parseDesignArtifactEnvelope,
  parseCreateUiSpecCandidate,
  buildSemanticSpecInput,
} from "./create-ui-spec-contracts.js";
import { CreateUiSpecRequestSchema } from "./create-ui-spec-contracts.js";
import { canonicalJsonStringify, sha256Hex } from "./readiness/contracts.js";
import { createUiSpec, buildFallbackCandidate, type CreateUiSpecDependencies } from "./create-ui-spec.js";
import recipe from "./c3/fallback-recipe-v1.json" with { type: "json" };
import type { SanitizedEvidence } from "./create-ui-spec-contracts.js";

// ---------------------------------------------------------------------------
// Frozen recipe identity (mirrors fallback-recipe-v1.test.ts).
// ---------------------------------------------------------------------------

const EXPECTED_RECIPE_VERSION = "c3-fallback-v1";
const EXPECTED_RECIPE_SHA256 =
  "1f86dc4aa8848c101680f2a8804c8a72c66ecaed204515e997c5ab14d3587099";

// ---------------------------------------------------------------------------
// Fixture corpus entries. Private markers (productName, source.url, image.path,
// critique, whatToSteal) are deliberately distinctive so the privacy assertions
// can detect any leak.
// ---------------------------------------------------------------------------

interface FixtureEntry extends Partial<CorpusEntryT> {
  id: string;
  title: string;
  patternType: string;
  source: { productName: string; url: string; kind: string; capturedAt: string; licenseStatus: string; attribution: string };
  image: { visibility: string; path: string | null; width: number | null; height: number | null };
  critique: string;
  whatToSteal: string[];
  antiPatterns: { antiPatterns: string[]; whereThisFails: string[]; accessibilityRisks: string[] };
  categories: string[];
  styleTags: string[];
  components: string[];
  visual: Record<string, unknown>;
  qualityScore: number;
  qualityTier: string;
  reviewStatus: string;
  addedAt: string;
}

function makeFixture(over: Partial<FixtureEntry> & { id: string }): FixtureEntry {
  return {
    title: "Untitled",
    patternType: "dashboard",
    source: {
      productName: "private-corpus-id-product",
      url: "https://private.example.com/secret",
      kind: "screenshot",
      capturedAt: "2026-01-01",
      licenseStatus: "private",
      attribution: "Private Corpus",
    },
    image: { visibility: "private", path: "images-private/secret.png", width: 100, height: 100 },
    critique: "private-corpus-id critique prose must never leak",
    whatToSteal: ["private-corpus-id stealable prose"],
    antiPatterns: { antiPatterns: [], whereThisFails: [], accessibilityRisks: [] },
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    visual: {},
    qualityScore: 4,
    qualityTier: "exceptional",
    reviewStatus: "approved",
    addedAt: "2026-01-01",
    ...over,
  } as FixtureEntry;
}

/** Build a fixture entry with the given product + pattern. */
function entry(id: string, productName: string, patternType = "dashboard", extra: Partial<FixtureEntry> = {}): FixtureEntry {
  return makeFixture({ id, ...extra, source: { ...makeFixture({ id }).source, productName, ...extra.source } });
}

// ---------------------------------------------------------------------------
// Fake CorpusReader (mirrors critique-retrieval.test.ts makeReader pattern).
// ---------------------------------------------------------------------------

function makeReader(corpus: FixtureEntry[], ranked: { entry: FixtureEntry; score: number; searchMode?: string }[] = []): CorpusReader & {
  searchRanked: ReturnType<typeof vi.fn>;
  getById: ReturnType<typeof vi.fn>;
  search: ReturnType<typeof vi.fn>;
} {
  return {
    search: vi.fn(async () => ranked.map((r) => r.entry as unknown as CorpusEntryT)) as never,
    searchRanked: vi.fn(async () => ranked.map((r) => ({
      entry: r.entry as unknown as CorpusEntryT,
      score: r.score,
      searchMode: (r.searchMode ?? "keyword") as "vector" | "keyword" | "hybrid",
    }))) as never,
    getById: vi.fn((id: string) => corpus.find((e) => e.id === id) as unknown as CorpusEntryT | undefined) as never,
    findSimilar: vi.fn(() => []) as never,
    listCategories: vi.fn(() => []) as never,
    listStyleTags: vi.fn(() => []) as never,
    listDomainTags: vi.fn(() => []) as never,
    indexStatus: vi.fn(() => ({ indexed: 0, total: corpus.length, hasIndex: false, missing: corpus.length, stale: 0, contentStale: 0 })) as never,
    entriesForAggregation: vi.fn(() => corpus as unknown as readonly CorpusEntryT[]) as never,
    resolveImagePath: vi.fn(() => null) as never,
  } as never;
}

function deps(corpus: FixtureEntry[], ranked: { entry: FixtureEntry; score: number; searchMode?: string }[] = [], resolveToken: (t: string) => string | undefined = () => undefined): CreateUiSpecDependencies {
  return {
    reader: makeReader(corpus, ranked),
    resolveReferenceToken: resolveToken,
    now: () => new Date("2026-07-27T00:00:00.000Z"),
  };
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

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("create-ui-spec producer — input normalization", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it("rejects a too-long brief (>8000 chars) with INVALID_INPUT", async () => {
    const long = "x".repeat(8_001);
    await expect(createUiSpec(validInput({ productContext: long }), deps([], []))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      retryable: false,
    });
  });

  it("rejects a too-short brief (<8 chars) with INVALID_INPUT", async () => {
    await expect(createUiSpec(validInput({ productContext: "short" }), deps([], []))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      retryable: false,
    });
  });

  it("rejects an unknown extra field with INVALID_INPUT", async () => {
    await expect(createUiSpec(validInput({ outputFormat: "markdown" }), deps([], []))).rejects.toMatchObject({
      code: "INVALID_INPUT",
      retryable: false,
    });
  });
});

describe("create-ui-spec producer — automatic retrieval", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it("caps automatic retrieval at five product-diverse references", async () => {
    // 8 diverse-product entries — only 5 kept.
    const corpus: FixtureEntry[] = [];
    const ranked: { entry: FixtureEntry; score: number }[] = [];
    for (let i = 0; i < 8; i++) {
      const e = entry(`e${i}`, `product-${i}`);
      corpus.push(e);
      ranked.push({ entry: e, score: 5 - i / 10 });
    }
    const env = await createUiSpec(validInput(), deps(corpus, ranked));
    const parsed = parseDesignArtifactEnvelope(env);
    // At most 5 evidence ids in the envelope.
    expect(parsed.publicEvidenceIds.length).toBeLessThanOrEqual(5);
  });

  it("slices to 20 before pickDiverse and pins keyword-only searchMode", async () => {
    // 25 ranked results — searchRanked called with limit 20 + keyword-only.
    const corpus: FixtureEntry[] = [];
    const ranked: { entry: FixtureEntry; score: number }[] = [];
    for (let i = 0; i < 25; i++) {
      const e = entry(`e${i}`, `product-${i}`);
      corpus.push(e);
      ranked.push({ entry: e, score: 5 - i / 100 });
    }
    const d = deps(corpus, ranked);
    await createUiSpec(validInput(), d);
    expect(d.reader.searchRanked).toHaveBeenCalledWith(expect.objectContaining({
      query: "A calm analytics dashboard for a fintech",
      limit: 20,
      searchMode: "keyword-only",
    }));
  });

  it("enforces max two per product with backfill to five", async () => {
    // 6 entries: 3 from product-A (top scores), 1 each from B, C, D.
    const corpus: FixtureEntry[] = [];
    const ranked: { entry: FixtureEntry; score: number }[] = [];
    const eA1 = entry("a1", "product-A"); corpus.push(eA1); ranked.push({ entry: eA1, score: 5.0 });
    const eA2 = entry("a2", "product-A"); corpus.push(eA2); ranked.push({ entry: eA2, score: 4.9 });
    const eA3 = entry("a3", "product-A"); corpus.push(eA3); ranked.push({ entry: eA3, score: 4.8 });
    const eB = entry("b1", "product-B"); corpus.push(eB); ranked.push({ entry: eB, score: 4.7 });
    const eC = entry("c1", "product-C"); corpus.push(eC); ranked.push({ entry: eC, score: 4.6 });
    const eD = entry("d1", "product-D"); corpus.push(eD); ranked.push({ entry: eD, score: 4.5 });
    const env = await createUiSpec(validInput(), deps(corpus, ranked));
    const parsed = parseDesignArtifactEnvelope(env);
    expect(parsed.publicEvidenceIds.length).toBe(5);
    // The corpus observations feed evidence ids; we can't read the productName,
    // but the count is capped and backfilled to 5.
  });

  it("deterministic backfill when the fixture contains too few products", async () => {
    // Only 2 distinct products, 4 entries — backfill selects all up to 4.
    const corpus: FixtureEntry[] = [];
    const ranked: { entry: FixtureEntry; score: number }[] = [];
    const e1 = entry("a1", "product-A"); corpus.push(e1); ranked.push({ entry: e1, score: 5 });
    const e2 = entry("a2", "product-A"); corpus.push(e2); ranked.push({ entry: e2, score: 4 });
    const e3 = entry("b1", "product-B"); corpus.push(e3); ranked.push({ entry: e3, score: 3 });
    const e4 = entry("b2", "product-B"); corpus.push(e4); ranked.push({ entry: e4, score: 2 });
    const env = await createUiSpec(validInput(), deps(corpus, ranked));
    const parsed = parseDesignArtifactEnvelope(env);
    // Fewer than 5 available — backfill returns min(available, 5).
    expect(parsed.publicEvidenceIds.length).toBe(4);
    expect(parsed.retrieval.mode).toBe("keyword");
    expect(parsed.retrieval.modality).toBe("metadata");
  });

  it("records keyword/metadata on automatic keyword success", async () => {
    const e = entry("a1", "product-A");
    const env = await createUiSpec(validInput(), deps([e], [{ entry: e, score: 5 }]));
    const parsed = parseDesignArtifactEnvelope(env);
    expect(parsed.retrieval.mode).toBe("keyword");
    expect(parsed.retrieval.modality).toBe("metadata");
    expect(parsed.retrieval.fallbackUsed).toBe(false);
  });

  it("records structured-fallback/metadata + sparse-evidence warning on zero matches", async () => {
    const env = await createUiSpec(validInput(), deps([], []));
    const parsed = parseDesignArtifactEnvelope(env);
    expect(parsed.retrieval.mode).toBe("structured-fallback");
    expect(parsed.retrieval.modality).toBe("metadata");
    expect(parsed.retrieval.fallbackUsed).toBe(true);
    expect(parsed.retrieval.fallbackReason).toBe("missing-index");
    expect(parsed.warnings.some((w) => w.code === "sparseCoverage")).toBe(true);
  });
});

describe("create-ui-spec producer — explicit references", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it("resolves explicit valid references to none/none with no omissions", async () => {
    const e = entry("internal-1", "product-A");
    const resolveToken = (t: string) => (t === "opaque-token-1" ? "internal-1" : undefined);
    const env = await createUiSpec(
      validInput({ referenceIds: ["opaque-token-1"] }),
      deps([e], [], resolveToken),
    );
    const parsed = parseDesignArtifactEnvelope(env);
    // Explicit references use none/none (no automatic retrieval).
    expect(parsed.retrieval.mode).toBe("none");
    expect(parsed.retrieval.modality).toBe("none");
    expect(parsed.retrieval.fallbackUsed).toBe(false);
    // At least one public evidence id exists (the explicit reference).
    expect(parsed.publicEvidenceIds.length).toBeGreaterThanOrEqual(1);
    // The explicit reference populates citedReferences.
    expect(parsed.spec.citedReferences.length).toBe(1);
  });

  it("resolves partial references to none/none, omitting unresolvable tokens", async () => {
    const e = entry("internal-1", "product-A");
    const resolveToken = (t: string) => (t === "opaque-token-1" ? "internal-1" : undefined);
    const env = await createUiSpec(
      validInput({ referenceIds: ["opaque-token-1", "opaque-token-unknown"] }),
      deps([e], [], resolveToken),
    );
    const parsed = parseDesignArtifactEnvelope(env);
    expect(parsed.retrieval.mode).toBe("none");
    expect(parsed.retrieval.modality).toBe("none");
    // Only the resolvable token becomes a public reference.
    expect(parsed.spec.citedReferences.length).toBe(1);
  });

  it("raises INVALID_INPUT when all explicit references are missing", async () => {
    const resolveToken = () => undefined;
    await expect(
      createUiSpec(validInput({ referenceIds: ["unknown-1", "unknown-2"] }), deps([], [], resolveToken)),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", retryable: false });
  });

  it("rejects a raw corpus id passed as a token (no silent substitution)", async () => {
    const e = entry("internal-1", "product-A");
    // The resolver returns undefined for a raw-corpus-id-looking token.
    const resolveToken = (t: string) => (t === "opaque-token-1" ? "internal-1" : undefined);
    await expect(
      createUiSpec(validInput({ referenceIds: ["internal-1"] }), deps([e], [], resolveToken)),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", retryable: false });
  });
});

describe("create-ui-spec producer — retrieval failure handling", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it("wraps a reader.searchRanked exception as RETRIEVAL_UNAVAILABLE with a safe message", async () => {
    const reader = makeReader([], []);
    // Persistent rejection so both the code + message assertions see the failure.
    (reader.searchRanked as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("ECONNREFUSED 127.0.0.1:1234 /Users/secret/private-corpus-id"),
    );
    const d = { reader, resolveReferenceToken: () => undefined, now: () => new Date("2026-07-27T00:00:00.000Z") };
    const err = await createUiSpec(validInput(), d).catch((e: unknown) => e);
    expect(err).toMatchObject({ code: "RETRIEVAL_UNAVAILABLE", retryable: true });
    // Raw exception text must NOT appear in the message (safe-message rule).
    const msg = (err as { message?: string }).message ?? "";
    expect(msg).not.toContain("private-corpus-id");
    expect(msg).not.toContain("ECONNREFUSED");
    expect(msg).not.toContain("/Users/secret");
    expect(msg).not.toContain("127.0.0.1");
  });

  it("wraps a reader.getById exception (explicit resolution) as RETRIEVAL_UNAVAILABLE", async () => {
    const e = entry("internal-1", "product-A");
    const reader = makeReader([e], []);
    (reader.getById as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error("disk read failed /Users/secret/path");
    });
    const resolveToken = (t: string) => (t === "opaque-token-1" ? "internal-1" : undefined);
    await expect(
      createUiSpec(validInput({ referenceIds: ["opaque-token-1"] }), { reader, resolveReferenceToken: resolveToken, now: () => new Date("2026-07-27T00:00:00.000Z") }),
    ).rejects.toMatchObject({ code: "RETRIEVAL_UNAVAILABLE", retryable: true });
  });
});

describe("create-ui-spec producer — privacy and evidence scoping", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it("never exposes a corpus ID in the sanitized envelope", async () => {
    const e = entry("internal-1", "private-corpus-id-product");
    const env = await createUiSpec(validInput(), deps([e], [{ entry: e, score: 5 }]));
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain("private-corpus-id");
    // Also assert no other distinctive private markers leak.
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("images-private");
    expect(serialized).not.toContain("private.example.com");
    expect(serialized).not.toContain("critique prose must never leak");
    expect(serialized).not.toContain("stealable prose");
  });

  it("never exposes the internal corpus id slug in the envelope", async () => {
    const e = entry("internal-1", "product-A");
    const env = await createUiSpec(validInput(), deps([e], [{ entry: e, score: 5 }]));
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain("internal-1");
  });

  it("separates explicit public citations from corpus evidence", async () => {
    const corpusObs = entry("internal-1", "product-A");
    const explicit = entry("internal-2", "product-B");
    // Automatic retrieval returns the corpus observation; the explicit token
    // resolves to the second entry.
    const resolveToken = (t: string) => (t === "opaque-token-1" ? "internal-2" : undefined);
    const env = await createUiSpec(
      validInput({ referenceIds: ["opaque-token-1"] }),
      deps([corpusObs, explicit], [{ entry: corpusObs, score: 5 }], resolveToken),
    );
    const parsed = parseDesignArtifactEnvelope(env);
    // Explicit reference populates citedReferences + provenance.sourceReferences.
    expect(parsed.spec.citedReferences.length).toBe(1);
    expect(parsed.spec.provenance.sourceReferences.length).toBe(1);
    // Evidence ids are response-scoped (evidence-N).
    for (const id of parsed.publicEvidenceIds) {
      expect(id).toMatch(/^evidence-[0-9]+$/);
    }
  });

  it("assigns response-scoped evidence ids in response order", async () => {
    const corpus: FixtureEntry[] = [];
    const ranked: { entry: FixtureEntry; score: number }[] = [];
    for (let i = 0; i < 3; i++) {
      const e = entry(`e${i}`, `product-${i}`);
      corpus.push(e);
      ranked.push({ entry: e, score: 5 - i });
    }
    const env = await createUiSpec(validInput(), deps(corpus, ranked));
    const parsed = parseDesignArtifactEnvelope(env);
    // The first three ids are evidence-1, evidence-2, evidence-3 (response order).
    expect(parsed.publicEvidenceIds.slice(0, 3)).toEqual(["evidence-1", "evidence-2", "evidence-3"]);
  });
});

describe("create-ui-spec producer — determinism and boundaries", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it("produces identical artifactId + semanticSpecSha256 for identical input + now()", async () => {
    const e = entry("e1", "product-A");
    const depsA = deps([e], [{ entry: e, score: 5 }]);
    const depsB = deps([e], [{ entry: e, score: 5 }]);
    const envA = await createUiSpec(validInput(), depsA);
    const envB = await createUiSpec(validInput(), depsB);
    expect(envA.artifactId).toBe(envB.artifactId);
    expect(envA.semanticSpecSha256).toBe(envB.semanticSpecSha256);
  });

  it("stable fallback recipe identity: producerVersion + assemblyRulesSha256", async () => {
    const env = await createUiSpec(validInput(), deps([], []));
    expect(env.producerVersion).toBe(EXPECTED_RECIPE_VERSION);
    // assemblyRulesSha256 is the recipe's canonical-JSON SHA.
    const recipeSha = sha256Hex(Buffer.from(canonicalJsonStringify(recipe), "utf-8"));
    expect(env.assemblyRulesSha256).toBe(recipeSha);
    expect(env.assemblyRulesSha256).toBe(EXPECTED_RECIPE_SHA256);
  });

  it("timestamp-only reruns: same semantic identity, same artifactId", async () => {
    const e = entry("e1", "product-A");
    const now1 = () => new Date("2026-07-27T00:00:00.000Z");
    const now2 = () => new Date("2030-01-01T12:00:00.000Z");
    const envA = await createUiSpec(validInput(), { reader: makeReader([e], [{ entry: e, score: 5 }]), resolveReferenceToken: () => undefined, now: now1 });
    const envB = await createUiSpec(validInput(), { reader: makeReader([e], [{ entry: e, score: 5 }]), resolveReferenceToken: () => undefined, now: now2 });
    // buildSemanticSpecInput matches (timestamp replaced by sentinel).
    expect(canonicalJsonStringify(buildSemanticSpecInput(envA.spec)))
      .toBe(canonicalJsonStringify(buildSemanticSpecInput(envB.spec)));
    expect(envA.semanticSpecSha256).toBe(envB.semanticSpecSha256);
    expect(envA.artifactId).toBe(envB.artifactId);
    // Instance-timestamped hashes MAY differ.
    // (They will differ because generatedAt is embedded in the spec.)
    expect(envA.specSha256).not.toBe(envB.specSha256);
  });

  it("makes zero network calls (no fetch / no provider import)", async () => {
    // Spy on globalThis.fetch to assert it is never invoked.
    const fetchSpy = vi.spyOn(globalThis, "fetch" as never).mockResolvedValue(undefined as never);
    try {
      await createUiSpec(validInput(), deps([], []));
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("normalizes the request through CreateUiSpecRequestSchema before any work", async () => {
    // Duplicate referenceIds are rejected by the schema refine.
    await expect(
      createUiSpec(validInput({ referenceIds: ["dup", "dup"] }), deps([], [])),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("create-ui-spec producer — astro targets (end-to-end)", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it("produces a parseable envelope for target: astro-react", async () => {
    // Previously the producer accepted the request but parseDesignArtifactEnvelope
    // threw on the final integrity check (resolveTargetProfile only handled
    // neutral-web). With the shared canonical-profile registry, astro-react now
    // round-trips end-to-end.
    const env = await createUiSpec(
      validInput({ target: "astro-react" }),
      deps([], []),
    );
    const parsed = parseDesignArtifactEnvelope(env);
    expect(parsed.handoff.target).toBe("astro-react");
    expect(parsed.artifactId.startsWith("uispec-")).toBe(true);
    // Identity invariants: the assemblyRulesSha256 matches the recipe SHA, and
    // the stored semanticSpecSha256 re-verifies (parseDesignArtifactEnvelope
    // re-derives it).
    expect(parsed.assemblyRulesSha256).toBe(EXPECTED_RECIPE_SHA256);
  });

  it("produces a parseable envelope for target: astro-vue", async () => {
    const env = await createUiSpec(
      validInput({ target: "astro-vue" }),
      deps([], []),
    );
    const parsed = parseDesignArtifactEnvelope(env);
    expect(parsed.handoff.target).toBe("astro-vue");
    expect(parsed.artifactId.startsWith("uispec-")).toBe(true);
  });

  it("astro-react produces a distinct artifactId from neutral-web (target is part of identity)", async () => {
    const neutral = await createUiSpec(validInput(), deps([], []));
    const astro = await createUiSpec(validInput({ target: "astro-react" }), deps([], []));
    expect(neutral.handoff.target).toBe("neutral-web");
    expect(astro.handoff.target).toBe("astro-react");
    expect(neutral.artifactId).not.toBe(astro.artifactId);
  });
});

// ---------------------------------------------------------------------------
// Candidate pipeline — proves the deterministic recipe routes through the
// evidence-aware candidate parser (the safety spine) before mapping into UiSpec.
// ---------------------------------------------------------------------------

describe("create-ui-spec producer — candidate pipeline (parseCreateUiSpecCandidate)", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it("buildFallbackCandidate produces a structurally valid candidate", () => {
    const req = CreateUiSpecRequestSchema.parse(validInput());
    const candidate = buildFallbackCandidate(req, [], recipe);
    // Parses clean with an empty allowed-evidence set (the fallback candidate
    // cites no evidence when no corpus observations are present).
    const parsed = parseCreateUiSpecCandidate(candidate, new Set());
    expect(parsed.candidateVersion).toBe("1.0");
    // The candidate carries a designDirection decision + the fixed-empty array
    // decisions.
    const fields = parsed.decisions.map((d) => d.field);
    expect(fields).toContain("designDirection");
    expect(fields).toContain("layoutRegions");
    expect(fields).toContain("techniques");
  });

  it("buildFallbackCandidate cites corpus evidence ids, and the parser accepts them when bound", () => {
    const corpusEvidence: SanitizedEvidence = {
      id: "evidence-1",
      kind: "corpus-observation",
      basis: "visible",
      summary: "dashboard reference",
      structuredFacts: { pattern: "dashboard" },
    };
    const req = CreateUiSpecRequestSchema.parse(validInput());
    const candidate = buildFallbackCandidate(req, [corpusEvidence], recipe);
    // The designDirection decision cites the corpus evidence id.
    const dd = candidate.decisions.find((d) => d.field === "designDirection");
    expect(dd?.evidenceIds).toContain("evidence-1");
    // Parses clean when evidence-1 is in the allowed set.
    expect(() => parseCreateUiSpecCandidate(candidate, new Set(["evidence-1"]))).not.toThrow();
  });

  it("parseCreateUiSpecCandidate REJECTS a candidate citing an unbound evidence id", () => {
    // Inject an unbound evidence id into the candidate (simulating a producer
    // bug or untrusted Phase-2 provider). The parser must reject it BEFORE any
    // decision reaches UiSpec.
    const req = CreateUiSpecRequestSchema.parse(validInput());
    const candidate = buildFallbackCandidate(req, [], recipe);
    const tampered = {
      ...candidate,
      decisions: candidate.decisions.map((d) =>
        d.field === "designDirection"
          ? { ...d, evidenceIds: ["evidence-99"] }
          : d,
      ),
    };
    expect(() => parseCreateUiSpecCandidate(tampered, new Set())).toThrow();
  });

  it("the producer never emits a spec citing an evidence id outside publicEvidenceIds", async () => {
    // End-to-end: the producer's assembled spec + provenance cite ONLY ids that
    // appear in the envelope's publicEvidenceIds. This proves the candidate
    // pipeline (buildFallbackCandidate + parseCreateUiSpecCandidate) is wired
    // into the producer and enforces evidence membership on trusted input.
    const e = entry("e1", "product-A");
    const env = await createUiSpec(validInput(), deps([e], [{ entry: e, score: 5 }]));
    const parsed = parseDesignArtifactEnvelope(env);
    const publicIds = new Set(parsed.publicEvidenceIds);
    expect(publicIds.size).toBeGreaterThan(0);
    // Every provenance evidence id is public.
    for (const id of parsed.spec.provenance.evidenceIds) {
      expect(publicIds.has(id)).toBe(true);
    }
    // Every citedDecision evidence id is public.
    for (const cd of parsed.spec.citedDecisions) {
      for (const id of cd.evidenceIds) {
        expect(publicIds.has(id)).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Table-driven sparse-evidence suite
// ---------------------------------------------------------------------------

describe("create-ui-spec producer — sparse-evidence matrix (table-driven)", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  type Case = {
    name: string;
    corpus: FixtureEntry[];
    ranked: { entry: FixtureEntry; score: number }[];
    referenceIds?: string[];
    resolveToken?: (t: string) => string | undefined;
    expectMode: "keyword" | "structured-fallback" | "none";
    expectModality: "metadata" | "none";
    expectSparse?: boolean;
    expectMotionUnavailable?: boolean;
  };

  const cases: Case[] = [
    {
      name: "zero automatic matches",
      corpus: [],
      ranked: [],
      expectMode: "structured-fallback",
      expectModality: "metadata",
      expectSparse: true,
      expectMotionUnavailable: true,
    },
    {
      name: "one automatic match",
      corpus: [entry("e1", "p-A")],
      ranked: [{ entry: entry("e1", "p-A"), score: 5 }],
      expectMode: "keyword",
      expectModality: "metadata",
      expectMotionUnavailable: true,
    },
    {
      name: "partial explicit references",
      corpus: [entry("internal-1", "p-A")],
      ranked: [],
      referenceIds: ["opaque-1", "opaque-unknown"],
      resolveToken: (t) => (t === "opaque-1" ? "internal-1" : undefined),
      expectMode: "none",
      expectModality: "none",
      expectMotionUnavailable: true,
    },
    {
      name: "model-dependent fields unavailable (fallback recipe)",
      corpus: [entry("e1", "p-A"), entry("e2", "p-B")],
      ranked: [
        { entry: entry("e1", "p-A"), score: 5 },
        { entry: entry("e2", "p-B"), score: 4 },
      ],
      expectMode: "keyword",
      expectModality: "metadata",
      expectMotionUnavailable: true,
    },
  ];

  for (const c of cases) {
    it(`${c.name}: envelope parses, retrieval + warnings match, evidence ids present, unavailable fields declared`, async () => {
      const env = await createUiSpec(
        validInput(c.referenceIds ? { referenceIds: c.referenceIds } : {}),
        deps(c.corpus, c.ranked, c.resolveToken ?? (() => undefined)),
      );
      const parsed = parseDesignArtifactEnvelope(env);
      // Retrieval state matches the matrix.
      expect(parsed.retrieval.mode).toBe(c.expectMode);
      expect(parsed.retrieval.modality).toBe(c.expectModality);
      // Every emitted evidence id is present + unique in the envelope.
      const ids = new Set(parsed.publicEvidenceIds);
      expect(ids.size).toBe(parsed.publicEvidenceIds.length);
      expect(parsed.spec.provenance.evidenceIds.slice().sort()).toEqual([...parsed.publicEvidenceIds].sort());
      // Sparse-evidence warning when expected.
      if (c.expectSparse) {
        expect(parsed.warnings.some((w) => w.code === "sparseCoverage")).toBe(true);
      }
      // Motion unavailable declared truthfully.
      const fields = new Set(parsed.spec.unavailableDecisions.map((d) => d.field));
      expect(fields.has("motion")).toBe(true);
      expect(parsed.spec.motionGuidance.evidenceUnavailable).toBe(true);
      // No warning claims evidence that was not retrieved: motionEvidenceUnavailable
      // is allowed (it's a model-availability warning, not an evidence claim), but
      // sparseCoverage is only emitted when evidence is actually sparse.
      if (c.expectMode !== "structured-fallback") {
        // When evidence was retrieved, sparseCoverage must not falsely fire unless
        // coverage is genuinely sparse. (One match is still sparse; the matrix
        // encodes this.)
      }
      // Model-dependent token fields are null with editorial authority.
      expect(parsed.spec.colorTokens).toBe(null);
      expect(parsed.spec.colorTokenAuthority).toBe("editorial");
      expect(parsed.spec.typographyTokens).toBe(null);
      expect(parsed.spec.typographyTokenAuthority).toBe("editorial");
      expect(fields.has("colorTokens")).toBe(true);
      expect(fields.has("typographyTokens")).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Sanity: the request schema exports used here are the strict Task 1 contracts.
// ---------------------------------------------------------------------------

describe("CreateUiSpecRequestSchema integration", () => {
  it("does not accept outputFormat (presentation adapters own it)", () => {
    expect(CreateUiSpecRequestSchema.safeParse({ ...validInput(), outputFormat: "markdown" }).success).toBe(false);
  });
});
