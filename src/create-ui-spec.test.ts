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
import {
  SanitizedEvidenceSchema,
  containsPrivateMarker,
  projectSanitizedEvidenceToMcpEvidence,
  projectRetrievalStateForTransport,
  type CreateUiSpecAdapterResult,
} from "./create-ui-spec-contracts.js";
import { canonicalJsonStringify, sha256Hex } from "./readiness/contracts.js";
import { createUiSpec, createUiSpecForAdapter, buildFallbackCandidate, RECIPE_EVIDENCE_ID, type CreateUiSpecDependencies } from "./create-ui-spec.js";
import recipe from "./c3/fallback-recipe-v1.json" with { type: "json" };
import type { SanitizedEvidence } from "./create-ui-spec-contracts.js";
import type { DesignArtifactEnvelope } from "./create-ui-spec-contracts.js";
import { Evidence, ToolResultSchemas, findUnsafeCreateUiSpecLeaves } from "./tool-contracts.js";
import type { UiSpecT } from "./tool-contracts.js";

// ---------------------------------------------------------------------------
// Frozen recipe identity (mirrors fallback-recipe-v1.test.ts).
// ---------------------------------------------------------------------------

const EXPECTED_RECIPE_VERSION = "c3-fallback-v1";
const EXPECTED_RECIPE_SHA256 =
  "4c78f2f261b5d1e988e692d3b32a19762991a4eee0789734a54b3d6029d510f3";

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
  voice?: { tone: string; examples: string[]; avoid?: string[] };
  responsiveBehavior?: string;
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

/**
 * Build a fixture entry with the given product + pattern. `patternType` is
 * genuinely applied (it used to be ignored, so every caller silently got
 * "dashboard"); `extra.patternType` still wins, which is how the out-of-enum
 * leak case injects a value the closed PatternType enum does not contain.
 */
function entry(id: string, productName: string, patternType = "dashboard", extra: Partial<FixtureEntry> = {}): FixtureEntry {
  return makeFixture({ id, patternType, ...extra, source: { ...makeFixture({ id }).source, productName, ...extra.source } });
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

function noRefRequest(): Record<string, unknown> {
  return validInput();
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
    // 8 diverse-product entries — only 5 corpus observations kept. The recipe/
    // system evidence (evidence-1) is ALWAYS emitted first, so the envelope
    // carries 1 recipe id + at most 5 corpus ids.
    const corpus: FixtureEntry[] = [];
    const ranked: { entry: FixtureEntry; score: number }[] = [];
    for (let i = 0; i < 8; i++) {
      const e = entry(`e${i}`, `product-${i}`);
      corpus.push(e);
      ranked.push({ entry: e, score: 5 - i / 10 });
    }
    const env = await createUiSpec(validInput(), deps(corpus, ranked));
    const parsed = parseDesignArtifactEnvelope(env);
    // At most 5 CORPUS evidence ids (the recipe id is separate).
    const corpusIds = parsed.publicEvidenceIds.filter((id) => id !== RECIPE_EVIDENCE_ID);
    expect(corpusIds.length).toBeLessThanOrEqual(5);
    // The recipe/system evidence id is always present (editorial grounding).
    expect(parsed.publicEvidenceIds).toContain(RECIPE_EVIDENCE_ID);
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

  it("keeps the top 3 ranked matches regardless of product diversity", async () => {
    // 6 entries: 3 from product-A (top scores), 1 each from B, C, D. Plan 2
    // dropped the product-diversity pick; automatic retrieval keeps the top 3
    // by rank. The recipe/system evidence (evidence-1) is always emitted
    // first, so the envelope carries 1 recipe id + 3 corpus ids.
    const corpus: FixtureEntry[] = [];
    const ranked: { entry: FixtureEntry; score: number }[] = [];
    const eA1 = entry("a1", "product-A", "dashboard"); corpus.push(eA1); ranked.push({ entry: eA1, score: 5.0 });
    const eA2 = entry("a2", "product-A", "data-table"); corpus.push(eA2); ranked.push({ entry: eA2, score: 4.9 });
    const eA3 = entry("a3", "product-A", "forms"); corpus.push(eA3); ranked.push({ entry: eA3, score: 4.8 });
    const eB = entry("b1", "product-B", "modal"); corpus.push(eB); ranked.push({ entry: eB, score: 4.7 });
    const eC = entry("c1", "product-C", "auth"); corpus.push(eC); ranked.push({ entry: eC, score: 4.6 });
    const eD = entry("d1", "product-D", "onboarding"); corpus.push(eD); ranked.push({ entry: eD, score: 4.5 });
    const env = await createUiSpec(validInput(), deps(corpus, ranked));
    const parsed = parseDesignArtifactEnvelope(env);
    const corpusIds = parsed.publicEvidenceIds.filter((id) => id !== RECIPE_EVIDENCE_ID);
    expect(corpusIds.length).toBe(3);
  });

  it("keeps all matches when fewer than three are available", async () => {
    // 2 entries with DISTINCT patterns — fewer than the top-3 cap, so both
    // are kept. The recipe/system evidence (evidence-1) is always emitted
    // first, so the envelope carries 1 recipe id + 2 corpus ids.
    const corpus: FixtureEntry[] = [];
    const ranked: { entry: FixtureEntry; score: number }[] = [];
    const e1 = entry("a1", "product-A", "dashboard"); corpus.push(e1); ranked.push({ entry: e1, score: 5 });
    const e2 = entry("a2", "product-A", "forms"); corpus.push(e2); ranked.push({ entry: e2, score: 4 });
    const env = await createUiSpec(validInput(), deps(corpus, ranked));
    const parsed = parseDesignArtifactEnvelope(env);
    const corpusIds = parsed.publicEvidenceIds.filter((id) => id !== RECIPE_EVIDENCE_ID);
    expect(corpusIds.length).toBe(2);
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
    // Honest zero-match state: the query SUCCEEDED but returned zero results,
    // so fallbackReason is the truthful "no-results", NOT "missing-index"
    // (nothing was missing — the index was queried and simply had no hits).
    expect(parsed.retrieval.fallbackReason).toBe("no-results");
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
    expect(parsed.spec.citedReferences[0]).toMatch(/^ref-[0-9a-f]{64}$/);
    expect(JSON.stringify(parsed)).not.toContain("opaque-token-1");
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
      const e = entry(`e${i}`, `product-${i}`, ["dashboard", "forms", "modal"][i]!);
      corpus.push(e);
      ranked.push({ entry: e, score: 5 - i });
    }
    const env = await createUiSpec(validInput(), deps(corpus, ranked));
    const parsed = parseDesignArtifactEnvelope(env);
    // The recipe/system evidence is always evidence-1 (emitted first); the
    // three corpus observations follow at evidence-2, evidence-3, evidence-4.
    expect(parsed.publicEvidenceIds.slice(0, 4)).toEqual(["evidence-1", "evidence-2", "evidence-3", "evidence-4"]);
  });

  it("never projects matchedEntries or raw corpus identity to a transport", async () => {
    const corpus = [corpusEntryWithRoles("internal-a", "#2563eb", "dashboard")];
    // give the entry unmistakable identity to hunt for
    (corpus[0] as unknown as Record<string, unknown>).title = "ZZTITLEZZ";
    (corpus[0] as unknown as Record<string, unknown>).source = { productName: "ZZPRODZZ" };
    const out = await createUiSpecForAdapter(noRefRequest(), deps(corpus, corpus.map(e => ({ entry: e, score: 5 }))));
    const served = JSON.stringify({ envelope: out.envelope, evidence: out.sanitizedEvidence });
    expect(served).not.toContain("ZZTITLEZZ");
    expect(served).not.toContain("ZZPRODZZ");
    expect(served).not.toContain("matchedEntries");
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
    expect(envA.modelExecution).toBeUndefined();
    expect(envA.modelExecutionSha256).toBeUndefined();
    expect(envA.spec.modelProposal).toBeUndefined();
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

  it("buildFallbackCandidate cites ONLY the recipe/system evidence id for designDirection (echo direction is editorial, not corpus-grounded)", () => {
    // The designDirection echoes the requester's brief under the deterministic
    // fallback recipe — it cites ONLY the recipe/system evidence id (editorial
    // authority), NEVER corpus ids. Corpus observations are retrieved and
    // recorded in provenance/lanes but do NOT ground the echo-only direction.
    const recipeEvidence: SanitizedEvidence = {
      id: RECIPE_EVIDENCE_ID,
      kind: "recipe-system",
      basis: "aggregate",
      summary: "Deterministic c3-fallback-v1 recipe",
      structuredFacts: {},
    };
    const corpusEvidence: SanitizedEvidence = {
      id: "evidence-2",
      kind: "corpus-observation",
      basis: "visible",
      summary: "dashboard reference",
      structuredFacts: { pattern: "dashboard" },
    };
    const req = CreateUiSpecRequestSchema.parse(validInput());
    const candidate = buildFallbackCandidate(req, [recipeEvidence, corpusEvidence], recipe);
    // The designDirection decision cites ONLY the recipe/system evidence id.
    const dd = candidate.decisions.find((d) => d.field === "designDirection");
    expect(dd?.evidenceIds).toContain(RECIPE_EVIDENCE_ID);
    expect(dd?.evidenceIds).not.toContain("evidence-2");
    // Parses clean when the recipe id is in the allowed set.
    expect(() => parseCreateUiSpecCandidate(candidate, new Set([RECIPE_EVIDENCE_ID, "evidence-2"]))).not.toThrow();
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

// ---------------------------------------------------------------------------
// P1 provenance-truthfulness: editorial authority for the echo-only direction
// + an honest zero-match retrieval state. These cover the controller-specified
// assertions for both fixes.
// ---------------------------------------------------------------------------

describe("create-ui-spec producer — provenance truthfulness (echo direction is editorial, not corpus-grounded)", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it("designDirection is NEVER corpus-evidence authority when corpus results exist (it echoes the brief)", async () => {
    // Corpus results are present, yet the direction is an echo of the requester's
    // brief — it MUST be editorial authority, never corpus-evidence authority.
    const e = entry("e1", "product-A");
    const env = await createUiSpec(validInput(), deps([e], [{ entry: e, score: 5 }]));
    const parsed = parseDesignArtifactEnvelope(env);
    const dd = parsed.spec.citedDecisions.find((d) => d.field === "designDirection");
    expect(dd).toBeDefined();
    expect(dd?.authority).toBe("editorial");
    expect(dd?.authority).not.toBe("corpus-evidence");
  });

  it("the echo-only designDirection cites ONLY the recipe/system evidence id (never a corpus evidence-N id)", async () => {
    const e1 = entry("e1", "product-A", "dashboard");
    const e2 = entry("e2", "product-B", "forms");
    const env = await createUiSpec(validInput(), deps([e1, e2], [
      { entry: e1, score: 5 },
      { entry: e2, score: 4 },
    ]));
    const parsed = parseDesignArtifactEnvelope(env);
    const dd = parsed.spec.citedDecisions.find((d) => d.field === "designDirection");
    expect(dd?.evidenceIds).toContain(RECIPE_EVIDENCE_ID);
    // No corpus evidence-N id grounds the direction. The corpus observations
    // are recorded in the corpusEvidence lane + provenance, but NOT cited here.
    for (const eid of dd?.evidenceIds ?? []) {
      expect(eid).not.toMatch(/^evidence-[2-9][0-9]*$/);
    }
    // The retrieved corpus observations still appear in the corpusEvidence lane
    // and provenance (they were retrieved; they just don't ground the direction).
    expect(parsed.spec.authorityLanes.corpusEvidence.length).toBe(2);
    for (const cid of parsed.spec.authorityLanes.corpusEvidence) {
      expect(parsed.spec.provenance.evidenceIds).toContain(cid);
    }
  });

  it("editorial authority passes schema validation (the full envelope parses through parseDesignArtifactEnvelope without throwing)", async () => {
    // With corpus results present, the editorial-authority direction + the
    // recipe/system evidence in the editorial lane must round-trip the
    // re-render/re-hash verification.
    const e = entry("e1", "product-A");
    const env = await createUiSpec(validInput(), deps([e], [{ entry: e, score: 5 }]));
    expect(() => parseDesignArtifactEnvelope(env)).not.toThrow();
  });

  it("the recipe/system evidence id is in authorityLanes.editorialGuidance and NO corpus-observation sits in the editorial lane (cross-lane integrity)", async () => {
    const e = entry("e1", "product-A");
    const env = await createUiSpec(validInput(), deps([e], [{ entry: e, score: 5 }]));
    const parsed = parseDesignArtifactEnvelope(env);
    expect(parsed.spec.authorityLanes.editorialGuidance).toContain(RECIPE_EVIDENCE_ID);
    // The editorial lane must not contain any corpus-observation id — those sit
    // ONLY in the corpusEvidence lane.
    const corpusSet = new Set(parsed.spec.authorityLanes.corpusEvidence);
    for (const eid of parsed.spec.authorityLanes.editorialGuidance) {
      expect(corpusSet.has(eid)).toBe(false);
    }
  });
});

describe("create-ui-spec producer — honest zero-match retrieval state (no fabricated evidence, no false labels)", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it("zero automatic results emit ONLY the recipe/system evidence (no fake user-supplied public-reference)", async () => {
    const env = await createUiSpec(validInput(), deps([], []));
    const parsed = parseDesignArtifactEnvelope(env);
    // The ONLY emitted evidence is the recipe/system item.
    expect(parsed.publicEvidenceIds).toEqual([RECIPE_EVIDENCE_ID]);
    // No public-reference evidence was fabricated on the automatic path (the
    // requester supplied nothing). The serialized envelope carries no
    // publicReference field and no "user-supplied" basis claim.
    const serialized = JSON.stringify(env);
    expect(serialized).not.toContain("user-supplied");
    expect(serialized).not.toContain("publicReference");
  });

  it("zero-match retrieval state is honest: fallbackReason is 'no-results' (the query succeeded; nothing was missing)", async () => {
    const env = await createUiSpec(validInput(), deps([], []));
    const parsed = parseDesignArtifactEnvelope(env);
    expect(parsed.retrieval.mode).toBe("structured-fallback");
    expect(parsed.retrieval.modality).toBe("metadata");
    expect(parsed.retrieval.resultCount).toBe(0);
    expect(parsed.retrieval.fallbackUsed).toBe(true);
    // NOT "missing-index" — the index was queried successfully and returned zero
    // matches. The truthful reason is "no-results".
    expect(parsed.retrieval.fallbackReason).toBe("no-results");
    expect(parsed.retrieval.fallbackReason).not.toBe("missing-index");
    // The sparse-evidence warning still fires (the honest user-facing signal).
    expect(parsed.warnings.some((w) => w.code === "sparseCoverage")).toBe(true);
    // The recipe/system evidence grounds the echo direction editorially.
    expect(parsed.spec.authorityLanes.editorialGuidance).toContain(RECIPE_EVIDENCE_ID);
  });

  it("the zero-match spec still parses (re-render + re-hash verification passes)", async () => {
    const env = await createUiSpec(validInput(), deps([], []));
    expect(() => parseDesignArtifactEnvelope(env)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Task 1b: the MCP structural leaf gate must accept the REAL producer's output.
//
// The producer is the definition of correct: if the gate rejects genuine
// createUiSpec() output, the gate is wrong. These tests run the real producer
// (no hand-written envelope) and check its output twice:
//
//   1. directly against the gate — every string leaf of the real spec must be a
//      CLASSIFIED position carrying a value of that position's shape; and
//   2. through the full MCP envelope schema.
//
// The evidence-row projection below is TEST-LOCAL on purpose, and stays so now
// that Task 2 has landed the production projection
// (`projectSanitizedEvidenceToMcpEvidence`). It asserts a DIFFERENT property:
// that `createUiSpec()`'s envelope-only output is by itself sufficient to derive
// gate-clean evidence rows, reconstructed from the spec's own authority lanes
// exactly as the producer partitions them (editorialGuidance =
// [recipe, ...publicReferences], corpusEvidence = corpus observations). The
// production projection — which reads the preserved `sanitizedEvidence` rows
// rather than reconstructing them — is exercised over the same three producer
// states by the Task 2 block below.
// ---------------------------------------------------------------------------

describe("create-ui-spec producer — MCP leaf gate accepts real producer output", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  function projectEvidenceRows(spec: UiSpecT): Array<Record<string, unknown>> {
    const corpusLane = new Set(spec.authorityLanes.corpusEvidence);
    const citedReferences = [...spec.citedReferences];
    return spec.provenance.evidenceIds.map((id) => {
      if (id === RECIPE_EVIDENCE_ID)
        return { id, kind: "recipe-system", basis: "aggregate", summary: "Deterministic recipe row." };
      if (corpusLane.has(id))
        return { id, kind: "corpus-observation", basis: "visible", summary: "Sanitized corpus observation." };
      return {
        id, kind: "public-reference", basis: "user-supplied",
        summary: "User-supplied public reference.",
        referenceId: citedReferences.shift(),
      };
    });
  }

  function projectMcpEnvelope(env: DesignArtifactEnvelope): Record<string, unknown> {
    const spec = env.spec;
    return {
      tool: "create_ui_spec",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Design spec produced.",
      data: spec,
      modelExecutionState: env.modelExecution?.state ?? null,
      referenceIds: [...spec.citedReferences],
      // resultCount is the ARTIFACT count (one spec), not the retrieval match
      // count the core records — the adapter concern Task 3 owns.
      retrieval: { ...env.retrieval, resultCount: 1 },
      warnings: env.warnings.map((w) => ({ code: w.code, message: w.message })),
      evidence: projectEvidenceRows(spec),
    };
  }

  const CASES: Array<[string, () => Promise<DesignArtifactEnvelope>]> = [
    ["automatic retrieval with matches", async () => {
      const corpus = [entry("internal-1", "product-A"), entry("internal-2", "product-B")];
      return createUiSpec(validInput(), deps(corpus, corpus.map((e) => ({ entry: e, score: 5 }))));
    }],
    ["zero-match structured fallback", async () => createUiSpec(validInput(), deps([], []))],
    ["explicit public references", async () => {
      const e = entry("internal-1", "product-A");
      return createUiSpec(
        validInput({ referenceIds: ["opaque-token-1"] }),
        deps([e], [], (t: string) => (t === "opaque-token-1" ? "internal-1" : undefined)),
      );
    }],
  ];

  for (const [label, produce] of CASES) {
    it(`gate finds no unclassified or unsafe leaf in real output: ${label}`, async () => {
      const env = parseDesignArtifactEnvelope(await produce());
      const evidence = projectEvidenceRows(env.spec);
      const found = findUnsafeCreateUiSpecLeaves({
        data: env.spec,
        referenceIds: [...env.spec.citedReferences],
        evidence,
      });
      expect(found.map((v) => `${v.position}: ${v.message}`)).toEqual([]);
    });

    it(`the full MCP envelope built from real output validates: ${label}`, async () => {
      const env = parseDesignArtifactEnvelope(await produce());
      const r = ToolResultSchemas.create_ui_spec.safeParse(projectMcpEnvelope(env));
      expect(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2)).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Task 2 — the adapter-facing evidence result path.
//
// Both transport adapters (MCP, Task 3; loopback HTTP, Task 5) need the SAME
// validated, response-scoped evidence without re-running retrieval,
// sanitization, assembly or rendering. `createUiSpecForAdapter()` is that
// internal result path and `projectSanitizedEvidenceToMcpEvidence()` is the one
// safe projection onto the shared MCP `Evidence` rows.
//
// `createUiSpec()` must keep its exact current behavior: it delegates to the
// adapter path and returns only the envelope.
// ---------------------------------------------------------------------------

describe("create-ui-spec producer — Task 2 adapter-facing evidence result path", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  /** The exact SanitizedEvidence field set the core approves. */
  const APPROVED_SANITIZED_FIELDS = new Set([
    "id", "kind", "basis", "summary", "structuredFacts", "publicReference",
  ]);
  /** The exact shared MCP `Evidence` field set. */
  const APPROVED_MCP_EVIDENCE_FIELDS = new Set([
    "id", "referenceId", "kind", "summary", "basis",
  ]);
  const RESPONSE_SCOPED_ID_RE = /^evidence-[0-9]+$/;
  const SAFE_PUBLIC_REFERENCE_RE = /^ref-[0-9a-f]{64}$/;

  /**
   * The three real producer states. Three corpus entries (not two) in the
   * automatic case and two tokens (not one) in the explicit case, so an
   * ordering or off-by-one defect in the id→referenceId mapping is detectable.
   */
  const ADAPTER_CASES: Array<[string, () => Promise<CreateUiSpecAdapterResult>]> = [
    ["automatic retrieval with matches", async () => {
      // Three genuinely different patternTypes, so the three rows' structuredFacts
      // (and therefore their recipe-owned summaries) differ and an ordering slip
      // in the id→row mapping is detectable.
      const corpus = [
        entry("internal-1", "product-Alpha", "dashboard"),
        entry("internal-2", "product-Bravo", "landing-page"),
        entry("internal-3", "product-Charlie", "settings"),
      ];
      return createUiSpecForAdapter(
        validInput(),
        deps(corpus, corpus.map((e) => ({ entry: e, score: 5 }))),
      );
    }],
    ["zero-match structured fallback", async () =>
      createUiSpecForAdapter(validInput(), deps([], []))],
    ["explicit public references", async () => {
      const corpus = [entry("internal-1", "product-Alpha"), entry("internal-2", "product-Bravo")];
      const map: Record<string, string> = {
        "opaque-token-alpha": "internal-1",
        "opaque-token-bravo": "internal-2",
      };
      return createUiSpecForAdapter(
        validInput({ referenceIds: ["opaque-token-alpha", "opaque-token-bravo"] }),
        deps(corpus, [], (t: string) => map[t]),
      );
    }],
  ];

  // --- createUiSpec() behavior preservation ---------------------------------

  it("createUiSpec returns exactly the envelope the adapter path produces", async () => {
    const corpus = [entry("internal-1", "product-Alpha"), entry("internal-2", "product-Bravo")];
    const ranked = corpus.map((e) => ({ entry: e, score: 5 }));
    const viaPublic = await createUiSpec(validInput(), deps(corpus, ranked));
    const viaAdapter = await createUiSpecForAdapter(validInput(), deps(corpus, ranked));
    expect(viaAdapter.envelope).toEqual(viaPublic);
    // The public function returns the envelope itself — not a wrapper.
    expect((viaPublic as unknown as Record<string, unknown>).sanitizedEvidence).toBeUndefined();
  });

  it("the adapter path raises the same typed errors as createUiSpec", async () => {
    await expect(
      createUiSpecForAdapter(validInput({ productContext: "short" }), deps([], [])),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", retryable: false });
    await expect(
      createUiSpecForAdapter(validInput({ referenceIds: ["nope"] }), deps([], [])),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", retryable: false });
  });

  for (const [label, produce] of ADAPTER_CASES) {
    // --- the internal result path -----------------------------------------

    it(`adapter evidence rows carry only approved SanitizedEvidence fields: ${label}`, async () => {
      const { sanitizedEvidence } = await produce();
      expect(sanitizedEvidence.length).toBeGreaterThan(0);
      for (const row of sanitizedEvidence) {
        for (const key of Object.keys(row))
          expect(APPROVED_SANITIZED_FIELDS.has(key), `unexpected field "${key}"`).toBe(true);
        // The schema is NOT an identity function by construction — `summary` and
        // `publicReference` are `z.string().trim()` and `structuredFacts` has
        // `.default({})`, so a re-parse CAN repair a row. What this asserts is
        // that the producer's rows are already in that normal form, so the
        // projection's inbound re-parse changes nothing on the production path.
        expect(SanitizedEvidenceSchema.parse(row)).toEqual(row);
        expect(row.id).toMatch(RESPONSE_SCOPED_ID_RE);
      }
    });

    it(`adapter evidence ids equal envelope.publicEvidenceIds in order: ${label}`, async () => {
      const { envelope, sanitizedEvidence } = await produce();
      expect(sanitizedEvidence.map((e) => e.id)).toEqual([...envelope.publicEvidenceIds]);
    });

    // --- the single safe projection ----------------------------------------

    it(`projection preserves ids, kind and truthful basis: ${label}`, async () => {
      const { sanitizedEvidence } = await produce();
      const rows = projectSanitizedEvidenceToMcpEvidence(sanitizedEvidence);
      expect(rows.length).toBe(sanitizedEvidence.length);
      rows.forEach((row, i) => {
        const src = sanitizedEvidence[i];
        expect(row.id).toBe(src.id);
        expect(row.kind).toBe(src.kind);
        expect(row.basis).toBe(src.basis);
        expect(row.summary).toBe(src.summary);
        for (const key of Object.keys(row))
          expect(APPROVED_MCP_EVIDENCE_FIELDS.has(key), `unexpected field "${key}"`).toBe(true);
        // Each projected row is a valid shared MCP Evidence row.
        expect(Evidence.safeParse(row).success).toBe(true);
      });
    });

    it(`every publicEvidenceId appears exactly once in the projection: ${label}`, async () => {
      const { envelope, sanitizedEvidence } = await produce();
      const rows = projectSanitizedEvidenceToMcpEvidence(sanitizedEvidence);
      for (const id of envelope.publicEvidenceIds)
        expect(rows.filter((r) => r.id === id).length, `id ${id}`).toBe(1);
      expect(rows.length).toBe(envelope.publicEvidenceIds.length);
    });

    it(`recipe-system evidence is operator-authored and carries no referenceId: ${label}`, async () => {
      const { sanitizedEvidence } = await produce();
      const rows = projectSanitizedEvidenceToMcpEvidence(sanitizedEvidence);
      const recipeRows = rows.filter((r) => r.id === RECIPE_EVIDENCE_ID);
      expect(recipeRows.length).toBe(1);
      expect(recipeRows[0].kind).toBe("recipe-system");
      expect(recipeRows[0].basis).toBe("aggregate");
      expect(recipeRows[0].referenceId).toBeUndefined();
    });

    // --- leak scan over the serialized adapter result ----------------------

    it(`the serialized adapter result carries no private markers: ${label}`, async () => {
      const { envelope, sanitizedEvidence } = await produce();
      const serialized = JSON.stringify({
        envelope,
        sanitizedEvidence,
        evidence: projectSanitizedEvidenceToMcpEvidence(sanitizedEvidence),
      });
      const banned = [
        // private corpus identity markers
        "private-corpus-id", "images-private/",
        // raw corpus entry ids
        "internal-1", "internal-2", "internal-3",
        // product identities
        "product-Alpha", "product-Bravo", "product-Charlie",
        // source urls + image paths + critique/steal prose
        "https://private.example.com/secret", "secret.png",
        "critique prose must never leak", "stealable prose",
        // the caller's raw reference tokens (only the digest is public)
        "opaque-token-alpha", "opaque-token-bravo",
      ];
      for (const marker of banned)
        expect(serialized.includes(marker), `leaked marker "${marker}"`).toBe(false);
      for (const s of [...sanitizedEvidence.map((e) => e.summary)])
        expect(containsPrivateMarker(s)).toBe(false);
    });

    // --- the structural leaf gate accepts the production projection -------

    it(`the leaf gate accepts the production projection: ${label}`, async () => {
      const { envelope, sanitizedEvidence } = await produce();
      const found = findUnsafeCreateUiSpecLeaves({
        data: envelope.spec,
        referenceIds: [...envelope.spec.citedReferences],
        evidence: projectSanitizedEvidenceToMcpEvidence(sanitizedEvidence),
      });
      expect(found.map((v) => `${v.position}: ${v.message}`)).toEqual([]);
    });

    it(`the full MCP result built from the production projection validates: ${label}`, async () => {
      const { envelope, sanitizedEvidence } = await produce();
      const r = ToolResultSchemas.create_ui_spec.safeParse({
        tool: "create_ui_spec",
        schemaVersion: "1.0",
        status: "ok",
        summary: "Design spec produced.",
        data: envelope.spec,
        modelExecutionState: envelope.modelExecution?.state ?? null,
        referenceIds: [...envelope.spec.citedReferences],
        // NOT `envelope.retrieval`: its resultCount counts retrieved corpus
        // observations, while the published create_ui_spec contract documents
        // resultCount as the artifact count ("1 when a complete spec artifact
        // exists, otherwise 0"). The shared mapping re-scopes exactly that one
        // field and preserves every other state value.
        retrieval: projectRetrievalStateForTransport(envelope),
        warnings: envelope.warnings.map((w) => ({ code: w.code, message: w.message })),
        evidence: projectSanitizedEvidenceToMcpEvidence(sanitizedEvidence),
      });
      expect(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2)).toBe(true);
    });
  }

  // --- corpus vs. explicit-reference distinguishability --------------------

  it("automatic corpus evidence carries no referenceId and no publicReference", async () => {
    const corpus = [
      entry("internal-1", "product-Alpha"),
      // "landing-page", not "landing" — `entry` now really applies patternType,
      // and only closed PatternType tokens survive SanitizedEvidenceSchema.
      entry("internal-2", "product-Bravo", "landing-page"),
      entry("internal-3", "product-Charlie", "settings"),
    ];
    const { sanitizedEvidence } = await createUiSpecForAdapter(
      validInput(),
      deps(corpus, corpus.map((e) => ({ entry: e, score: 5 }))),
    );
    const rows = projectSanitizedEvidenceToMcpEvidence(sanitizedEvidence);
    const corpusRows = rows.filter((r) => r.kind === "corpus-observation");
    expect(corpusRows.length).toBe(3);
    for (const row of corpusRows) {
      expect(row.referenceId).toBeUndefined();
      expect(row.basis).toBe("visible");
    }
    for (const src of sanitizedEvidence.filter((e) => e.kind === "corpus-observation"))
      expect(src.publicReference).toBeUndefined();
    // No public-reference row exists on the automatic path.
    expect(rows.some((r) => r.kind === "public-reference")).toBe(false);
  });

  it("explicit public references stay distinguishable from corpus evidence", async () => {
    const corpus = [entry("internal-1", "product-Alpha"), entry("internal-2", "product-Bravo")];
    const map: Record<string, string> = {
      "opaque-token-alpha": "internal-1",
      "opaque-token-bravo": "internal-2",
    };
    const { envelope, sanitizedEvidence } = await createUiSpecForAdapter(
      validInput({ referenceIds: ["opaque-token-alpha", "opaque-token-bravo"] }),
      deps(corpus, [], (t: string) => map[t]),
    );
    const rows = projectSanitizedEvidenceToMcpEvidence(sanitizedEvidence);
    // Nothing on the explicit path is a corpus observation.
    expect(rows.some((r) => r.kind === "corpus-observation")).toBe(false);
    const publicRows = rows.filter((r) => r.kind === "public-reference");
    expect(publicRows.length).toBe(2);
    for (const row of publicRows) {
      expect(row.basis).toBe("user-supplied");
      expect(row.referenceId).toMatch(SAFE_PUBLIC_REFERENCE_RE);
      // The two ID domains are never substituted for one another.
      expect(row.referenceId).not.toMatch(RESPONSE_SCOPED_ID_RE);
      expect(row.id).not.toMatch(SAFE_PUBLIC_REFERENCE_RE);
    }
    // Order-preserving: the projected referenceIds are the spec's citedReferences
    // in the same order (a two-token case, so a swap is detectable).
    expect(publicRows.map((r) => r.referenceId)).toEqual([...envelope.spec.citedReferences]);
    expect(new Set(publicRows.map((r) => r.referenceId)).size).toBe(2);
  });

  it("a corpus patternType outside the closed enum cannot reach evidence[].summary", async () => {
    // The adapter result path is what PUBLISHES evidence[].summary — the persisted
    // envelope carries only `publicEvidenceIds`. The recipe-owned summary template
    // interpolates structuredFacts.pattern verbatim (`"<pattern>" reference, N
    // regions, ...`), so an entry whose patternType is not a closed PatternType token
    // would publish that raw string. Every sanitized row is therefore parsed
    // through SanitizedEvidenceSchema at construction, whose StructuredFacts pins
    // `pattern` to PatternType — so this is refused, not published.
    const bogus = entry("internal-1", "product-Alpha", "dashboard", {
      patternType: "private-corpus-id-leak-pattern",
    });
    await expect(
      createUiSpecForAdapter(validInput(), deps([bogus], [{ entry: bogus, score: 5 }])),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", retryable: false });
    // Same for the envelope-only public function — one pipeline, one outcome.
    await expect(
      createUiSpec(validInput(), deps([bogus], [{ entry: bogus, score: 5 }])),
    ).rejects.toMatchObject({ code: "INVALID_INPUT", retryable: false });
  });

  it("the projection refuses a row that is not approved SanitizedEvidence", () => {
    // A defective row: kind says recipe-system (operator content) but a
    // publicReference is present. The core forbids that combination, so the
    // projection refuses the row rather than silently dropping the field —
    // fail-closed, and the message never reproduces the value.
    const bad = {
      id: "evidence-1", kind: "recipe-system", basis: "aggregate",
      summary: "Deterministic recipe row.", structuredFacts: {},
      publicReference: `ref-${"a".repeat(64)}`,
    } as SanitizedEvidence;
    expect(() => projectSanitizedEvidenceToMcpEvidence([bad])).toThrow(/not an approved SanitizedEvidence row/);
    try {
      projectSanitizedEvidenceToMcpEvidence([bad]);
    } catch (err) {
      expect(String((err as Error).message)).not.toContain("a".repeat(64));
    }
    // A row carrying a field outside the approved allowlist is refused too.
    expect(() => projectSanitizedEvidenceToMcpEvidence([
      {
        id: "evidence-1", kind: "corpus-observation", basis: "visible",
        summary: "Sanitized corpus observation.", structuredFacts: {},
        privateCorpusId: "internal-1",
      } as unknown as SanitizedEvidence,
    ])).toThrow(/not an approved SanitizedEvidence row/);
  });

  it("the projection refuses a publicReference that is not a safe public reference", () => {
    expect(() => projectSanitizedEvidenceToMcpEvidence([
      {
        id: "evidence-1", kind: "public-reference", basis: "user-supplied",
        summary: "User-supplied public reference.", structuredFacts: {},
        publicReference: "https://private.example.com/secret",
      } as SanitizedEvidence,
    ])).toThrow();
  });

  // --- evidence[].summary is a PUBLISHED channel and must be screened --------
  //
  // Task 2 makes `evidence[].summary` the first published string that does NOT
  // pass DesignArtifactEnvelopeSchema's containsPrivateMarker sweep (the rows
  // travel beside the envelope), and the create_ui_spec leaf gate classifies the
  // position as free text, so it checks nothing. Screened at construction by
  // SanitizedEvidenceSchema; the projection inherits the screen through its
  // inbound re-parse.

  it("the projection refuses a poisoned summary instead of publishing it verbatim", () => {
    // The exact probe from the Task 2 review (§4, poisoned row 8): before the
    // screen this row was ACCEPTED and its summary published verbatim.
    const poisoned = {
      id: "evidence-1", kind: "corpus-observation", basis: "visible",
      summary: "private-corpus-id internal-1 images-private/secret.png https://private.example.com/secret",
      structuredFacts: {},
    } as unknown as SanitizedEvidence;
    expect(() => projectSanitizedEvidenceToMcpEvidence([poisoned]))
      .toThrow(/not an approved SanitizedEvidence row/);
    try {
      projectSanitizedEvidenceToMcpEvidence([poisoned]);
    } catch (err) {
      // The refusal must not become the channel the value escapes through.
      expect(String((err as Error).message)).not.toContain("images-private/");
      expect(String((err as Error).message)).not.toContain("private-corpus-id");
      expect(String((err as Error).message)).not.toContain("private.example.com");
    }
  });

  it("each private-content class in a summary is refused on its own", () => {
    // Not just the combined probe: a raw corpus id marker, a private image path
    // and a source URL each individually make the row unpublishable.
    for (const summary of [
      "dashboard reference private-corpus-id-7",
      "dashboard reference images-private/secret.png",
      "dashboard reference https://private.example.com/secret",
    ]) {
      expect(() => projectSanitizedEvidenceToMcpEvidence([
        {
          id: "evidence-1", kind: "corpus-observation", basis: "visible",
          summary, structuredFacts: {},
        } as unknown as SanitizedEvidence,
      ]), summary).toThrow(/not an approved SanitizedEvidence row/);
    }
  });

  it("the projection refuses duplicate evidence ids across rows", () => {
    // The brief requires every publicEvidenceId to be represented EXACTLY once.
    // `Evidence` is applied per row, so uniqueness has to be checked here.
    const rows = [
      { id: "evidence-2", kind: "corpus-observation", basis: "visible", summary: "dashboard reference", structuredFacts: {} },
      { id: "evidence-2", kind: "corpus-observation", basis: "visible", summary: "settings reference", structuredFacts: {} },
    ] as unknown as SanitizedEvidence[];
    expect(() => projectSanitizedEvidenceToMcpEvidence(rows)).toThrow(/duplicate/i);
  });

  // --- the ONE transport retrieval mapping ---------------------------------
  //
  // `envelope.retrieval.resultCount` counts retrieved CORPUS OBSERVATIONS; the
  // published create_ui_spec contract documents `resultCount` as "1 when a
  // complete spec artifact exists, otherwise 0" (tool-contracts.ts descriptor).
  // An adapter that writes `retrieval: envelope.retrieval` therefore contradicts
  // the descriptor. One shared mapping, so neither adapter can diverge.

  it("the transport retrieval mapping preserves the producer's real retrieval state", async () => {
    for (const [label, produce] of ADAPTER_CASES) {
      const { envelope } = await produce();
      const mapped = projectRetrievalStateForTransport(envelope);
      // Truthfulness: every state field is the producer's own value.
      expect(mapped.mode, label).toBe(envelope.retrieval.mode);
      expect(mapped.modality, label).toBe(envelope.retrieval.modality);
      expect(mapped.fallbackUsed, label).toBe(envelope.retrieval.fallbackUsed);
      expect(mapped.fallbackReason, label).toBe(envelope.retrieval.fallbackReason);
      expect(mapped.attemptedCount, label).toBe(envelope.retrieval.attemptedCount);
      expect(mapped.attemptedModes, label).toEqual([...envelope.retrieval.attemptedModes]);
      // Only resultCount is re-scoped, to the documented artifact semantics.
      expect(mapped.resultCount, label).toBe(1);
    }
  });

  it("the three real retrieval states are preserved, not normalized", async () => {
    const states = [] as Array<{ mode: string; modality: string; fallbackReason?: string }>;
    for (const [, produce] of ADAPTER_CASES) {
      const { envelope } = await produce();
      const m = projectRetrievalStateForTransport(envelope);
      states.push({ mode: m.mode, modality: m.modality, fallbackReason: m.fallbackReason });
    }
    expect(states).toEqual([
      { mode: "keyword", modality: "metadata", fallbackReason: undefined },
      { mode: "structured-fallback", modality: "metadata", fallbackReason: "no-results" },
      { mode: "none", modality: "none", fallbackReason: undefined },
    ]);
  });

  it("an adapter that passes envelope.retrieval through unchanged is refused by the published contract", async () => {
    const corpus = [
      entry("internal-1", "product-Alpha", "dashboard"),
      entry("internal-2", "product-Bravo", "landing-page"),
      entry("internal-3", "product-Charlie", "settings"),
    ];
    const { envelope, sanitizedEvidence } = await createUiSpecForAdapter(
      validInput(),
      deps(corpus, corpus.map((e) => ({ entry: e, score: 5 }))),
    );
    // The two meanings genuinely differ on this input.
    expect(envelope.retrieval.resultCount).toBe(3);
    const mapped = projectRetrievalStateForTransport(envelope);
    expect(mapped.resultCount).toBe(1);
    expect(mapped).not.toEqual(envelope.retrieval);

    const build = (retrieval: unknown) => ({
      tool: "create_ui_spec",
      schemaVersion: "1.0",
      status: "ok",
      summary: "Design spec produced.",
      data: envelope.spec,
      modelExecutionState: envelope.modelExecution?.state ?? null,
      referenceIds: [...envelope.spec.citedReferences],
      retrieval,
      warnings: envelope.warnings.map((w) => ({ code: w.code, message: w.message })),
      evidence: projectSanitizedEvidenceToMcpEvidence(sanitizedEvidence),
    });
    // Raw pass-through: rejected, and rejected FOR the resultCount contradiction
    // (not incidentally for some other field).
    const raw = ToolResultSchemas.create_ui_spec.safeParse(build(envelope.retrieval));
    expect(raw.success).toBe(false);
    if (!raw.success) {
      const resultCountIssues = raw.error.issues.filter((i) => i.path.includes("resultCount"));
      expect(resultCountIssues.length, JSON.stringify(raw.error.issues)).toBeGreaterThan(0);
    }
    // Shared mapping: accepted.
    const ok = ToolResultSchemas.create_ui_spec.safeParse(build(mapped));
    expect(ok.success, ok.success ? "" : JSON.stringify(ok.error.issues, null, 2)).toBe(true);
  });
});

describe("create-ui-spec producer — caller constraints become manual acceptance criteria", () => {
  it("turns each caller constraint into a manual acceptance criterion", async () => {
    const res = await createUiSpecForAdapter(
      validInput({
        productContext: "A settings screen for two-factor setup",
        constraints: ["AA contrast", "primary action always visible"],
      }),
      deps([], []),
    );
    const criteria = res.envelope.spec.acceptanceCriteria;
    const ids = criteria.map((c) => c.id);
    expect(ids).toContain("caller-constraint-1");
    expect(ids).toContain("caller-constraint-2");
    expect(ids).toContain("fallback-manual-spec-review"); // recipe criterion survives
    // Appended, not prepended: client-bounds tests read acceptanceCriteria[0].
    expect(criteria[0]?.id).toBe("fallback-manual-spec-review");
    const first = criteria.find((c) => c.id === "caller-constraint-1")!;
    expect(first.verifier).toBe("manual");
    expect(first.priority).toBe("should"); // NOT "must" — caller stated no priority
    expect(first.subject).toBe("AA contrast");
    expect(first.evidenceIds).toEqual([]);
    expect(first.manualSteps.length).toBeGreaterThan(0);
  });

  it("adds no caller criteria when the caller supplied no constraints", async () => {
    const res = await createUiSpecForAdapter(validInput({ constraints: [] }), deps([], []));
    const ids = res.envelope.spec.acceptanceCriteria.map((c) => c.id);
    expect(ids).toEqual(["fallback-manual-spec-review"]);
  });
});

describe("create-ui-spec producer — structured design intent reaches spec.context and identity", () => {
  it("gives two requests differing only in colorIntent distinct artifactIds", async () => {
    const base = validInput({ productContext: "A settings screen for two-factor setup" });
    const a = await createUiSpecForAdapter(
      { ...base, colorIntent: { accentPreference: "light blue" } },
      deps([], []),
    );
    const b = await createUiSpecForAdapter(
      { ...base, colorIntent: { accentPreference: "warm red" } },
      deps([], []),
    );
    expect(a.envelope.spec.context.colorIntent).toEqual({ accentPreference: "light blue" });
    expect(b.envelope.spec.context.colorIntent).toEqual({ accentPreference: "warm red" });
    expect(a.envelope.semanticSpecSha256).not.toBe(b.envelope.semanticSpecSha256);
    expect(a.envelope.artifactId).not.toBe(b.envelope.artifactId);
  });

  it("records typeIntent without materializing tokens", async () => {
    const res = await createUiSpecForAdapter(
      validInput({ typeIntent: { voice: "plainspoken", density: "compact" } }),
      deps([], []),
    );
    expect(res.envelope.spec.context.typeIntent).toEqual({
      voice: "plainspoken",
      density: "compact",
    });
    // Intent is RECORDED, not materialized — the null-token contract holds.
    expect(res.envelope.spec.typographyTokens).toBeNull();
    expect(res.envelope.spec.colorTokens).toBeNull();
    expect(res.envelope.spec.typographyTokenAuthority).toBe("editorial");
  });

  it("omits both intent keys entirely when the caller supplied neither", async () => {
    const res = await createUiSpecForAdapter(validInput(), deps([], []));
    expect(Object.keys(res.envelope.spec.context)).not.toContain("colorIntent");
    expect(Object.keys(res.envelope.spec.context)).not.toContain("typeIntent");
  });
});

describe("create-ui-spec producer — which digests move with generation time", () => {
  // The playground renders four hashes side by side and its integrity note tells
  // the operator which of them are comparable across two runs. That claim is
  // about the PRODUCER's output, so it has to be pinned against the producer —
  // a renderer-level test cannot see `specSha256`, and a test that injects its
  // own timestamp into a reconstructed spec would pass even if the producer
  // stopped embedding `generatedAt` at all.
  const digestsAt = async (iso: string) => {
    const res = await createUiSpecForAdapter(
      validInput({ productContext: "A settings screen for two-factor setup" }),
      {
        reader: makeReader([], []),
        resolveReferenceToken: () => undefined,
        now: () => new Date(iso),
      },
    );
    return res.envelope;
  };

  it("moves specSha256 and designJsonSha256 with the clock, but not the semantic hash, artifactId, or designMarkdownSha256", async () => {
    const early = await digestsAt("2026-08-01T00:00:00.000Z");
    const late = await digestsAt("2030-12-31T23:59:59.000Z");

    // Stable across runs — safe for the operator to compare.
    expect(late.semanticSpecSha256).toBe(early.semanticSpecSha256);
    expect(late.artifactId).toBe(early.artifactId);
    expect(late.designMarkdownSha256).toBe(early.designMarkdownSha256);

    // Timestamp-bearing — a mismatch across runs proves nothing about the design.
    expect(late.specSha256).not.toBe(early.specSha256);
    expect(late.designJsonSha256).not.toBe(early.designJsonSha256);

    // And the reason, so a future reader does not have to infer it: the rendered
    // markdown carries no timestamp while the JSON does.
    expect(early.designMarkdown).not.toContain("2026-08-01T00:00:00");
    expect(early.designJson).toContain("2026-08-01T00:00:00");
  });
});

describe("create-ui-spec producer — an intent object with no members is not intent", () => {
  // `colorIntent: {}` was schema-legal because every member is optional, so the
  // producer recorded an empty object in `spec.context` and the site rendered an
  // empty "Design intent" panel. Unreachable from the composer (its request
  // builder omits the key when no member is set) but reachable from MCP and the
  // HTTP route, which is exactly the surface a caller drives programmatically.
  //
  // Refusing it beats normalizing it away: silently dropping a key the caller
  // sent is the kind of quiet rewrite the honesty invariant exists to prevent,
  // and an empty object is far more likely a serialization bug on the caller's
  // side than a deliberate statement of "no intent".
  it("rejects an empty colorIntent instead of recording it", async () => {
    await expect(
      createUiSpecForAdapter(validInput({ colorIntent: {} }), deps([], [])),
    ).rejects.toThrow();
  });

  it("rejects an empty typeIntent instead of recording it", async () => {
    await expect(
      createUiSpecForAdapter(validInput({ typeIntent: {} }), deps([], [])),
    ).rejects.toThrow();
  });

  it("still accepts an intent carrying a single member", async () => {
    const res = await createUiSpecForAdapter(
      validInput({ colorIntent: { mood: "calm" }, typeIntent: { density: "compact" } }),
      deps([], []),
    );
    expect(res.envelope.spec.context.colorIntent).toEqual({ mood: "calm" });
    expect(res.envelope.spec.context.typeIntent).toEqual({ density: "compact" });
  });
});

it("round-trips a real-shaped corpus entry through the widened projection", async () => {
  // The exact bug class this pins: a `primary`-shaped fact (the old draft)
  // made every real entry fail SanitizedEvidenceSchema and look like a
  // retrieval failure. A real-shaped entry — canvas/surface/ink/muted/accent,
  // muted nullable (src/schema.ts:420-426) — must survive with colorRoles
  // intact and a summary that includes the derived accent.
  const entryData = entry("internal-1", "product-Alpha", "dashboard", {
    layout: { form: "three-column", regions: [{ role: "primary-nav" }, { role: "main-canvas" }] },
    visual: {
      colorRoles: { canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: null, accent: "#2563eb" },
      spacingDensity: "compact", cornerStyle: "slight-round",
      usesShadows: false, usesBorders: true,
      accentColor: "#2563eb", typePairing: { display: "Inter", body: "Inter" },
    },
  });
  const out = await createUiSpecForAdapter(
    { productContext: "A dashboard", referenceIds: [], constraints: [], motionIntents: [] },
    deps([entryData], [{ entry: entryData, score: 5 }]),
  );
  const row = out.sanitizedEvidence.find((e) => e.kind === "corpus-observation");
  expect(row).toBeDefined();
  if (!row) return;
  expect(SanitizedEvidenceSchema.safeParse(row).success).toBe(true);
  expect(row.structuredFacts.colorRoles).toEqual({
    canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: null, accent: "#2563eb",
  });
  expect(row.summary).toContain("accent #2563eb");
});

it("automatic retrieval caps at the top 3 ranked matches", async () => {
  const patterns = ["dashboard", "onboarding", "modal", "forms", "auth"];
  const corpus = Array.from({ length: 5 }, (_, i) => entry(`internal-${i}`, `product-${i}`, patterns[i]!));
  const ranked = corpus.map((e) => ({ entry: e, score: 5 - Number((e.id as string).slice(-1)) }));
  const out = await createUiSpecForAdapter(
    { productContext: "A dashboard for finance ops", referenceIds: [], constraints: [], motionIntents: [] },
    deps(corpus, ranked),
  );
  const corpusRows = out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation");
  expect(corpusRows).toHaveLength(3);
  expect(out.envelope.retrieval.resultCount).toBe(3);
});

it("pattern-dedupes the top 3 so a repeated pattern class cannot crowd out diversity", async () => {
  // Measured case: a habit brief returned onboarding twice in the top 3. The
  // first entry per patternType wins in rank order, filling up to 3 distinct
  // patterns.
  const eOn1 = entry("internal-1", "product-A", "onboarding");
  const eNav = entry("internal-2", "product-B", "navigation");
  const eOn2 = entry("internal-3", "product-C", "onboarding");
  const eForm = entry("internal-4", "product-D", "forms");
  const ranked = [
    { entry: eOn1, score: 5 }, { entry: eNav, score: 4 },
    { entry: eOn2, score: 3 }, { entry: eForm, score: 2 },
  ];
  const out = await createUiSpecForAdapter(
    { productContext: "A dashboard", referenceIds: [], constraints: [], motionIntents: [] },
    deps([eOn1, eNav, eOn2, eForm], ranked),
  );
  const rows = out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation");
  expect(rows.map((r) => r.structuredFacts.pattern)).toEqual(["onboarding", "navigation", "forms"]);
  expect(out.envelope.retrieval.resultCount).toBe(3);
});

it("falls back to the similarity index when keyword search matches nothing", async () => {
  const seed = entry("internal-seed", "product-seed");
  const similar = ["a", "b", "c"].map((k, i) => entry(`internal-${k}`, `product-${k}`, ["dashboard", "forms", "modal"][i]!));
  const reader = {
    ...makeReader([], []),
    search: vi.fn(async () => [seed]),
    findSimilar: vi.fn(() => similar.map((e) => ({ entry: e, score: 1 }))),
  } as unknown as CorpusReader;
  const out = await createUiSpecForAdapter(
    { productContext: "A dashboard", referenceIds: [], constraints: [], motionIntents: [] },
    { reader, resolveReferenceToken: () => undefined },
  );
  const corpusRows = out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation");
  expect(corpusRows).toHaveLength(3);
  expect(out.envelope.retrieval.resultCount).toBe(3);
});

it("reports sparseCoverage when both keyword and similarity return nothing", async () => {
  const reader = {
    ...makeReader([], []),
    search: vi.fn(async () => []),
    findSimilar: vi.fn(() => []),
  } as unknown as CorpusReader;
  const out = await createUiSpecForAdapter(
    { productContext: "A dashboard", referenceIds: [], constraints: [], motionIntents: [] },
    { reader, resolveReferenceToken: () => undefined },
  );
  expect(out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation")).toHaveLength(0);
  // The EXISTING zero-match warning (create-ui-spec.ts:1159-1164). No new code.
  expect(out.envelope.warnings.map((w) => w.code)).toContain("sparseCoverage");
  expect(out.envelope.retrieval.mode).toBe("structured-fallback");
});

it("reports truthful counts when the similarity fallback returns fewer than three matches", async () => {
  const seed = entry("internal-seed", "product-seed", "dashboard");
  const similar = ["a", "b"].map((k, i) => entry(`internal-${k}`, `product-${k}`, ["forms", "modal"][i]!));
  const reader = {
    ...makeReader([], []),
    search: vi.fn(async () => [seed]),
    findSimilar: vi.fn(() => similar.map((e) => ({ entry: e, score: 1 }))),
  } as unknown as CorpusReader;
  const out = await createUiSpecForAdapter(
    { productContext: "A dashboard", referenceIds: [], constraints: [], motionIntents: [] },
    { reader, resolveReferenceToken: () => undefined },
  );
  const corpusRows = out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation");
  expect(corpusRows).toHaveLength(2);
  expect(out.envelope.retrieval.resultCount).toBe(2);
  expect(out.envelope.retrieval.mode).toBe("keyword");
});

function corpusEntryWithRoles(id: string, accent: string, pattern = "dashboard"): FixtureEntry {
  return entry(id, `product-${id}`, pattern, {
    layout: { form: "three-column", regions: [{ role: "main-canvas" }] },
    visual: {
      colorRoles: { canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent },
      spacingDensity: "compact", cornerStyle: "slight-round",
      usesShadows: false, usesBorders: true,
      accentColor: accent, typePairing: { display: "Inter", body: "Inter" },
    },
  });
}

function mcqPayload(out: Awaited<ReturnType<typeof createUiSpecForAdapter>>): Record<string, unknown> {
  const spec = out.envelope.spec;
  return {
    tool: "create_ui_spec", schemaVersion: "1.0", status: "ok", summary: "Design spec produced.",
    data: spec, modelExecutionState: null,
    referenceIds: [...spec.citedReferences],
    retrieval: { ...out.envelope.retrieval, resultCount: 1 },
    warnings: out.envelope.warnings.map((w) => ({ code: w.code, message: w.message })),
    evidence: projectSanitizedEvidenceToMcpEvidence(out.sanitizedEvidence),
  };
}

it("ledgers the synthesized direction against the corpus evidence ids", async () => {
  const patterns = ["dashboard", "data-table", "forms"];
  const ids = ["a", "b", "c"];
  const corpus = patterns.map((p, i) => corpusEntryWithRoles(`internal-${ids[i]!}`, i === 2 ? "#1d4ed8" : "#2563eb", p));
  // The default fixture prose carries the private-corpus marker on purpose;
  // the whole-direction identity screen would drop the synthesized direction
  // (correct fail-closed behavior), so give these entries clean prose to pin
  // the ledger instead.
  for (const e of corpus) {
    e.critique = "Clean critique prose about the dashboard layout and its use of a three-column grid.";
    e.whatToSteal = ["Clean stealable technique about grouping metrics by row."];
  }
  const ranked = corpus.map((e, i) => ({ entry: e, score: 5 - i }));
  const out = await createUiSpecForAdapter(
    { productContext: "A dashboard", referenceIds: [], constraints: [], motionIntents: [] },
    deps(corpus, ranked),
  );
  const spec = out.envelope.spec;
  const ledger = spec.citedDecisions.find((d) => d.id === "designDirection-evidence-synthesis");
  expect(ledger).toBeDefined();
  expect(ledger!.authority).toBe("corpus-evidence");
  expect(ledger!.evidenceIds).toEqual(["evidence-2", "evidence-3", "evidence-4"]);
  expect(spec.citedDecisions.some((d) => d.id === "designDirection-editorial-1")).toBe(false);
  // The full produced envelope passes the shared gate with tokens POPULATED.
  const r = ToolResultSchemas.create_ui_spec.safeParse(mcqPayload(out));
  expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
  expect(spec.colorTokens).not.toBeNull();
  expect(spec.unavailableDecisions.some((d) => d.field === "colorTokens")).toBe(false);
});

it("ledgers synthesized color tokens against the corpus evidence ids", async () => {
  // The palette is a plurality vote over visual.colorRoles across the matched
  // entries — corpus-evidence authorship, not editorial. Declaring it
  // "editorial" with no citedDecision is the same authority misstatement this
  // file already pins for designDirection, one field over: the governing
  // invariant forbids carrying authority the product did not derive, and an
  // uncited palette loses the trace back to the entries that produced it.
  const patterns = ["dashboard", "data-table", "forms"];
  const ids = ["a", "b", "c"];
  const corpus = patterns.map((p, i) => corpusEntryWithRoles(`internal-${ids[i]!}`, i === 2 ? "#1d4ed8" : "#2563eb", p));
  const ranked = corpus.map((e, i) => ({ entry: e, score: 5 - i }));
  const out = await createUiSpecForAdapter(
    { productContext: "A dashboard", referenceIds: [], constraints: [], motionIntents: [] },
    deps(corpus, ranked),
  );
  const spec = out.envelope.spec;
  expect(spec.colorTokens).not.toBeNull();
  expect(spec.colorTokenAuthority).toBe("corpus-evidence");
  const ledger = spec.citedDecisions.find((d) => d.id === "colorTokens-evidence-synthesis");
  expect(ledger).toBeDefined();
  expect(ledger!.field).toBe("colorTokens");
  expect(ledger!.authority).toBe("corpus-evidence");
  expect(ledger!.evidenceIds).toEqual(["evidence-2", "evidence-3", "evidence-4"]);
  // The authority-prerequisite gate (tool-contracts.ts) requires a
  // corpus-evidence decision to cite the corpusEvidence lane; prove the whole
  // envelope still passes with the non-editorial token authority.
  const r = ToolResultSchemas.create_ui_spec.safeParse(mcqPayload(out));
  expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
});

it("keeps editorial token authority and no token ledger row when tokens stay null", async () => {
  const corpus = [corpusEntryWithRoles("internal-a", "#2563eb", "dashboard")];
  const ranked = corpus.map((e) => ({ entry: e, score: 5 }));
  const out = await createUiSpecForAdapter(
    { productContext: "A dashboard", referenceIds: [], constraints: [], motionIntents: [] },
    deps(corpus, ranked),
  );
  const spec = out.envelope.spec;
  expect(spec.colorTokens).toBeNull();
  expect(spec.colorTokenAuthority).toBe("editorial");
  expect(spec.citedDecisions.some((d) => d.id === "colorTokens-evidence-synthesis")).toBe(false);
});

it("passes the gate with tokens unavailable and exactly one colorTokens row", async () => {
  // Two observations only — below the >= 3 token threshold. The recipe's
  // colorTokens row is replaced by exactly ONE conditional row; a duplicate
  // would fail the gate's uniqueness check.
  const ids = ["a", "b"];
  const patterns = ["dashboard", "forms"];
  const corpus = patterns.map((p, i) => corpusEntryWithRoles(`internal-${ids[i]!}`, "#2563eb", p));
  const ranked = corpus.map((e, i) => ({ entry: e, score: 5 - i }));
  const out = await createUiSpecForAdapter(
    { productContext: "A dashboard", referenceIds: [], constraints: [], motionIntents: [] },
    deps(corpus, ranked),
  );
  const spec = out.envelope.spec;
  const rows = spec.unavailableDecisions.filter((d) => d.field === "colorTokens");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.reason).toContain("Fewer than 3");
  const r = ToolResultSchemas.create_ui_spec.safeParse(mcqPayload(out));
  expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
});

it("serves corpus judgment into the six UiSpec fields, evidence-cited and gate-clean", async () => {
  const corpus = [entry("internal-1", "ProductA", "dashboard", {
    whatToSteal: ["Group metrics by row", "Right-side callout anchored to chart regions"],
    antiPatterns: {
      antiPatterns: ["Avoids heavy chart chrome"],
      whereThisFails: [],
      accessibilityRisks: [
        { element: "Secondary text", risk: "Low contrast on secondary text", evidence: "visible", confidence: "visible", wcag: ["1.4.3"] },
      ],
    },
    voice: {
      tone: "Restrained, confident",
      examples: ["Confidence intervals plotted as soft bands"],
      avoid: [],
    },
    components: ["kpi-card"],
    responsiveBehavior: "responsive",
  })];
  const out = await createUiSpecForAdapter(
    { productContext: "A dashboard", referenceIds: [], constraints: [], motionIntents: [] },
    deps(corpus, [{ entry: corpus[0], score: 5 }]),
  );
  const spec = out.envelope.spec;
  // The recipe/system evidence is evidence-1; the matched corpus entry is
  // evidence-2, which is what every served row must cite.
  expect(spec.techniques).toEqual([
    { text: "Group metrics by row", sourceIds: ["evidence-2"] },
    { text: "Right-side callout anchored to chart regions", sourceIds: ["evidence-2"] },
  ]);
  expect(spec.antiPatterns).toEqual([
    { text: "Avoids heavy chart chrome", sourceIds: ["evidence-2"] },
  ]);
  expect(spec.contentVoiceGuidance).toBe(
    "Restrained, confident. Examples: Confidence intervals plotted as soft bands.",
  );
  expect(spec.accessibilityConstraints).toEqual(["Low contrast on secondary text"]);
  expect(spec.componentInventory).toEqual([{ name: "kpi-card", pattern: "kpi-card" }]);
  expect(spec.responsiveBehavior).toContain("mode: responsive");
  // The composed voice cites the entry that supplied it.
  expect(spec.citedDecisions.find((d) => d.field === "contentVoiceGuidance")?.evidenceIds)
    .toEqual(["evidence-2"]);
  // So do the served accessibility-risk rows (governing invariant: every
  // served observation is attributed to a response-scoped evidence id).
  expect(spec.citedDecisions.find((d) => d.field === "accessibilityConstraints")?.evidenceIds)
    .toEqual(["evidence-2"]);
  // The full MCP envelope schema (leaf gate + evidence membership + authority
  // prerequisites) accepts the produced envelope.
  const r = ToolResultSchemas.create_ui_spec.safeParse(mcqPayload(out));
  expect(r.success, r.success ? "" : JSON.stringify(r.error.issues)).toBe(true);
});
