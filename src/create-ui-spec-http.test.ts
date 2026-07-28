/**
 * create-ui-spec-http.test.ts — TDD for the `create_ui_spec` loopback HTTP
 * adapter (Task 5 of the C3 slice).
 *
 * The module under test is a THIN transport adapter, exactly like the MCP
 * adapter. It may parse transport input, call the sole producer
 * (`createUiSpecForAdapter`), and serialize a VALIDATED result. It may NOT
 * construct a UiSpec, assign evidence authority, sanitize raw corpus entries,
 * render a second handoff, or author its own dependency value.
 *
 * The shape difference from MCP is the whole point of a separate adapter:
 *  - MCP returns the standard tool envelope (`content` + `structuredContent`),
 *    validated by `parseToolResult`.
 *  - HTTP returns the parsed `DesignArtifactEnvelope` ITSELF, with both
 *    renderings and the response-scoped evidence ids, validated by
 *    `parseDesignArtifactEnvelope`.
 *
 * The properties pinned here:
 *  1. The served BYTES re-parse through `parseDesignArtifactEnvelope()`. Not the
 *     in-memory object — the actual JSON string the route writes.
 *  2. There is NO adapter-added envelope field. The envelope schema is
 *     `.strict()`, so (1) already refuses an extra top-level field; this is
 *     asserted directly too, against the producer's own key set.
 *  3. The request contract carries the CORE fields and NO `outputFormat`.
 *  4. Dependencies come from `makeCreateUiSpecDependencies` BY IDENTITY (an
 *     inline hand-rolled resolver would be observationally identical, so
 *     provenance is asserted, not inferred).
 *  5. Zero-result retrieval still produces a servable artifact
 *     (structured-fallback), not an error.
 *  6. Typed, bounded errors, and the code/message/retryable triple is the SAME
 *     mapping the MCP adapter serves — asserted against `handleCreateUiSpec`'s
 *     own output so the two transports cannot drift.
 *  7. No raw caller token (accepted OR refused), no `omittedReferenceTokens`
 *     signal, and no private corpus marker reaches the response.
 */
import { describe, expect, it, beforeEach, vi } from "vitest";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";
import {
  parseDesignArtifactEnvelope,
  containsPrivateMarker,
  type CreateUiSpecAdapterResult,
} from "./create-ui-spec-contracts.js";
import { ERROR_RETRYABLE } from "./tool-contracts.js";
import {
  createUiSpecIntegrityRefusalError,
  createUiSpecTransportError,
} from "./create-ui-spec-transport-errors.js";

// ---------------------------------------------------------------------------
// Spy over the ONE dependency factory. Same rationale as the MCP suite: "the
// dependencies come from makeCreateUiSpecDependencies" is a PROVENANCE claim,
// and an inline `{ reader, resolveReferenceToken: t => reader.getById(t) ? t :
// undefined }` would pass every behavioural probe. So the factory's return
// value is recorded and identity-checked against what the producer received.
// ---------------------------------------------------------------------------
const depsSpyState = vi.hoisted(() => ({ returned: [] as unknown[] }));

vi.mock("./create-ui-spec-dependencies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./create-ui-spec-dependencies.js")>();
  return {
    ...actual,
    makeCreateUiSpecDependencies: vi.fn((reader: never, now?: () => Date) => {
      const deps = actual.makeCreateUiSpecDependencies(reader, now);
      depsSpyState.returned.push(deps);
      return deps;
    }),
  };
});

// Spy over the SOLE producer so the served bytes can be compared against the
// exact envelope object the adapter consumed (a second producer call would
// carry a different generatedAt, so re-calling proves nothing).
const spyState = vi.hoisted(() => ({
  produced: [] as CreateUiSpecAdapterResult[],
  /** Optional mutation applied after the REAL producer finished (gate tests). */
  mutate: undefined as
    | ((result: CreateUiSpecAdapterResult) => CreateUiSpecAdapterResult)
    | undefined,
}));

vi.mock("./create-ui-spec.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./create-ui-spec.js")>();
  return {
    ...actual,
    createUiSpecForAdapter: vi.fn(async (input: unknown, dependencies: never) => {
      const result = await actual.createUiSpecForAdapter(input, dependencies);
      spyState.produced.push(result);
      return spyState.mutate ? spyState.mutate(result) : result;
    }),
  };
});

const core = await import("./create-ui-spec.js");
const {
  handleCreateUiSpecHttp,
  CreateUiSpecHttpRequestSchema,
} = await import("./create-ui-spec-http.js");
const { handleCreateUiSpec } = await import("./create-ui-spec-mcp.js");

// ---------------------------------------------------------------------------
// Fixtures — distinctive private markers so a leak is visible.
// ---------------------------------------------------------------------------

const RAW_TOKEN_RESOLVED = "known-reference-token";
const RAW_TOKEN_REFUSED = "refused-reference-token-4711";

function fixtureEntry(id: string, productName: string): CorpusEntryT {
  return {
    id,
    title: "Untitled",
    patternType: "dashboard",
    source: {
      productName,
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
  } as unknown as CorpusEntryT;
}

function makeReader(
  corpus: CorpusEntryT[],
  ranked: CorpusEntryT[] = [],
  over: Partial<Record<keyof CorpusReader, unknown>> = {},
): CorpusReader {
  return {
    search: vi.fn(async () => ranked),
    searchRanked: vi.fn(async () =>
      ranked.map((entry) => ({ entry, score: 5, searchMode: "keyword" as const })),
    ),
    getById: vi.fn((id: string) => corpus.find((e) => e.id === id)),
    findSimilar: vi.fn(() => []),
    listCategories: vi.fn(() => []),
    listStyleTags: vi.fn(() => []),
    listDomainTags: vi.fn(() => []),
    indexStatus: vi.fn(() => ({ indexed: 0, total: corpus.length, hasIndex: false, missing: corpus.length, stale: 0, contentStale: 0 })),
    entriesForAggregation: vi.fn(() => corpus),
    resolveImagePath: vi.fn(() => null),
    getImageIndex: vi.fn(async () => null),
    ...over,
  } as unknown as CorpusReader;
}

function validBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { productContext: "A calm analytics dashboard for a fintech", ...over };
}

/** Markers that must never appear anywhere in a served response. */
const BANNED = [
  "private-corpus-id",
  "images-private/",
  "internal-1",
  "internal-2",
  "product-Alpha",
  "product-Bravo",
  "https://private.example.com/secret",
  "secret.png",
  "critique prose must never leak",
  "stealable prose",
  RAW_TOKEN_RESOLVED,
  RAW_TOKEN_REFUSED,
];

beforeEach(() => {
  spyState.produced.length = 0;
  spyState.mutate = undefined;
  depsSpyState.returned.length = 0;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. The request contract
// ---------------------------------------------------------------------------

describe("create_ui_spec HTTP request contract", () => {
  it("accepts the core request fields", () => {
    const parsed = CreateUiSpecHttpRequestSchema.safeParse(
      validBody({ platform: "web", constraints: ["dark mode only"], target: "astro-react" }),
    );
    expect(parsed.success).toBe(true);
  });

  it("has NO outputFormat field and REJECTS one (HTTP returns both renderings)", () => {
    // The route returns the envelope, which carries designMarkdown AND
    // designJson, so there is nothing for a format selector to select. An
    // accepted-but-ignored field would be a silent lie in the contract.
    expect(Object.keys(CreateUiSpecHttpRequestSchema.shape)).not.toContain("outputFormat");
    const parsed = CreateUiSpecHttpRequestSchema.safeParse(validBody({ outputFormat: "json" }));
    expect(parsed.success).toBe(false);
  });

  it("rejects an unknown field (no screenshots, credentials, or provider config)", () => {
    for (const extra of [
      { screenshot: "data:image/png;base64,AAAA" },
      { apiKey: "sk-live-not-a-real-key" },
      { provider: "openai" },
      { critiqueProvider: "claude" },
      { authorization: "Bearer x" },
    ]) {
      const parsed = CreateUiSpecHttpRequestSchema.safeParse(validBody(extra));
      expect(parsed.success, `extra field accepted: ${Object.keys(extra)[0]}`).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. The success response IS the envelope
// ---------------------------------------------------------------------------

describe("create_ui_spec HTTP success response", () => {
  it("serves 200 with bytes that re-parse through parseDesignArtifactEnvelope()", async () => {
    const corpus = [fixtureEntry("internal-1", "product-Alpha"), fixtureEntry("internal-2", "product-Bravo")];
    const result = await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus));
    expect(result.status).toBe(200);
    // The BYTES, not the in-memory object — this is what the route writes.
    const reparsed = parseDesignArtifactEnvelope(JSON.parse(result.body));
    expect(reparsed.artifactVersion).toBe("1.0");
  });

  it("serves both renderings, byte-identical to the producer's own envelope", async () => {
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    const result = await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus));
    const served = JSON.parse(result.body) as Record<string, unknown>;
    const envelope = spyState.produced[0]!.envelope;
    expect(served.designMarkdown).toBe(envelope.designMarkdown);
    expect(served.designJson).toBe(envelope.designJson);
    expect((served.designMarkdown as string).length).toBeGreaterThan(0);
    expect((served.designJson as string).length).toBeGreaterThan(0);
  });

  it("serves the response-scoped evidence ids and nothing else evidence-shaped", async () => {
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    const result = await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus));
    const served = JSON.parse(result.body) as { publicEvidenceIds: string[] };
    expect(served.publicEvidenceIds.length).toBeGreaterThan(0);
    for (const id of served.publicEvidenceIds) expect(id).toMatch(/^evidence-[0-9]+$/);
    expect(served.publicEvidenceIds).toEqual([...spyState.produced[0]!.envelope.publicEvidenceIds]);
  });

  it("adds NO envelope field — the served key set is exactly the producer's", async () => {
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    const result = await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus));
    const served = JSON.parse(result.body) as Record<string, unknown>;
    const envelope = spyState.produced[0]!.envelope as unknown as Record<string, unknown>;
    expect(Object.keys(served).sort()).toEqual(Object.keys(envelope).sort());
    // Explicitly: no transport-only field leaked into the artifact.
    for (const forbidden of ["summary", "tool", "schemaVersion", "status", "data", "evidence", "referenceIds", "sanitizedEvidence", "error", "isError", "content", "structuredContent", "outputFormat"]) {
      expect(Object.keys(served)).not.toContain(forbidden);
    }
  });

  it("uses makeCreateUiSpecDependencies BY IDENTITY (no inline resolver)", async () => {
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus));
    expect(depsSpyState.returned.length).toBe(1);
    const producerCall = vi.mocked(core.createUiSpecForAdapter).mock.calls[0]!;
    expect(producerCall[1]).toBe(depsSpyState.returned[0]);
  });

  it("passes ONLY core request fields to the producer", async () => {
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    await handleCreateUiSpecHttp(validBody({ platform: "web" }), makeReader(corpus, corpus));
    const request = vi.mocked(core.createUiSpecForAdapter).mock.calls[0]![0] as Record<string, unknown>;
    expect(Object.keys(request)).not.toContain("outputFormat");
    expect(request.productContext).toBe("A calm analytics dashboard for a fintech");
    expect(request.platform).toBe("web");
  });

  it("produces a servable artifact on ZERO retrieval results (structured fallback, not an error)", async () => {
    const result = await handleCreateUiSpecHttp(validBody(), makeReader([], []));
    expect(result.status).toBe(200);
    const served = JSON.parse(result.body) as { retrieval: { mode: string; modality: string; resultCount: number } };
    expect(served.retrieval.mode).toBe("structured-fallback");
    expect(served.retrieval.modality).toBe("metadata");
    parseDesignArtifactEnvelope(JSON.parse(result.body));
  });

  it("is deterministic for the same request + clock (same bytes twice)", async () => {
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    const fixedClock = () => new Date("2026-07-28T00:00:00.000Z");
    const a = await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus), fixedClock);
    const b = await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus), fixedClock);
    expect(a.body).toBe(b.body);
  });
});

// ---------------------------------------------------------------------------
// 3. Privacy — nothing corpus-derived, nothing token-derived
// ---------------------------------------------------------------------------

describe("create_ui_spec HTTP privacy", () => {
  it("leaks no private marker, product identity, url, path or raw token", async () => {
    const corpus = [
      fixtureEntry("internal-1", "product-Alpha"),
      fixtureEntry("internal-2", "product-Bravo"),
      fixtureEntry(RAW_TOKEN_RESOLVED, "product-Alpha"),
    ];
    for (const body of [
      validBody(),
      validBody({ referenceIds: [RAW_TOKEN_RESOLVED] }),
      validBody({ referenceIds: [RAW_TOKEN_RESOLVED, RAW_TOKEN_REFUSED] }),
    ]) {
      const result = await handleCreateUiSpecHttp(body, makeReader(corpus, corpus));
      expect(result.status).toBe(200);
      for (const marker of BANNED) {
        expect(result.body.includes(marker), `served response contains ${marker}`).toBe(false);
      }
      expect(containsPrivateMarker(result.body)).toBe(false);
    }
  });

  it("publishes no per-token success/failure signal beyond citedReferences", async () => {
    const corpus = [fixtureEntry(RAW_TOKEN_RESOLVED, "product-Alpha")];
    const result = await handleCreateUiSpecHttp(
      validBody({ referenceIds: [RAW_TOKEN_RESOLVED, RAW_TOKEN_REFUSED] }),
      makeReader(corpus, []),
    );
    const served = JSON.parse(result.body) as Record<string, unknown>;
    // No field named after the refused-token bookkeeping, at any depth.
    const keys = JSON.stringify(served);
    for (const forbidden of ["omittedReferenceTokens", "omittedTokens", "refusedReferences", "resolvedTokenCount"]) {
      expect(keys.includes(forbidden), `response carries ${forbidden}`).toBe(false);
    }
  });

  it("reflects the caller's brief ONLY where the producer already does on MCP (no new position)", async () => {
    // The brief is the caller's OWN request data reflected back to the caller,
    // not corpus data — and the PRODUCER, not this adapter, puts it in
    // `spec.context.productContext` and `spec.designDirection` (the fallback
    // recipe's echo-product-context strategy). Both positions are already
    // published over MCP as `structuredContent.data`. What must be true is that
    // this transport adds no NEW position carrying it: outside `spec` and the two
    // spec-derived renderings, the brief must not appear anywhere in the
    // envelope. This is the assertion that would break if a future change put the
    // brief into, say, an artifact id or a warning message.
    const brief = "zq-unique-brief-marker-8823 dashboard for a fintech";
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    const reader = makeReader(corpus, corpus);
    const result = await handleCreateUiSpecHttp(validBody({ productContext: brief }), reader);

    const served = JSON.parse(result.body) as Record<string, unknown> & {
      spec: { context: { productContext: string } };
    };
    expect(served.spec.context.productContext).toBe(brief);

    const { spec: _spec, designMarkdown: _md, designJson: _json, ...rest } = served;
    expect(JSON.stringify(rest).includes("zq-unique-brief-marker-8823")).toBe(false);

    // Same position on the MCP surface — so this route widens nothing.
    const mcp = await handleCreateUiSpec(validBody({ productContext: brief }), makeReader(corpus, corpus));
    const mcpData = (mcp.structuredContent as { data: { context: { productContext: string } } }).data;
    expect(mcpData.context.productContext).toBe(brief);
  });

  it("writes nothing to the server console — not the brief, not an exception", async () => {
    // "The brief stays in client state only, never in server logs" is a property
    // of code, not of intent: one `console.error(err)` on the failure path would
    // put the caller's brief (and a filesystem path) into the operator terminal.
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const corpus = [fixtureEntry("internal-1", "product-Alpha")];
      // Success path, transport-input failure path, and producer-failure path.
      await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus));
      await handleCreateUiSpecHttp({ productContext: "tiny" }, makeReader([], []));
      await handleCreateUiSpecHttp(
        validBody(),
        makeReader([], [], {
          searchRanked: vi.fn(async () => {
            throw new Error("/Users/someone/corpus/private/entries.json exploded");
          }),
        }),
      );
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Typed errors — the SAME mapping the MCP adapter serves
// ---------------------------------------------------------------------------

describe("create_ui_spec HTTP typed errors", () => {
  it("maps invalid input to 400 INVALID_INPUT (non-retryable)", async () => {
    const result = await handleCreateUiSpecHttp({ productContext: "tiny" }, makeReader([], []));
    expect(result.status).toBe(400);
    const body = JSON.parse(result.body) as { error: { code: string; message: string; retryable: boolean } };
    expect(body.error.code).toBe("INVALID_INPUT");
    expect(body.error.retryable).toBe(false);
    expect(body.error.retryable).toBe(ERROR_RETRYABLE.INVALID_INPUT);
    expect(body.error.message.length).toBeLessThan(300);
  });

  it("maps a retrieval failure to 503 PROVIDER_ERROR (retryable)", async () => {
    const reader = makeReader([], [], {
      searchRanked: vi.fn(async () => {
        throw new Error("/Users/someone/corpus/private/entries.json exploded");
      }),
    });
    const result = await handleCreateUiSpecHttp(validBody(), reader);
    expect(result.status).toBe(503);
    const body = JSON.parse(result.body) as { error: { code: string; message: string; retryable: boolean } };
    expect(body.error.code).toBe("PROVIDER_ERROR");
    expect(body.error.retryable).toBe(true);
    expect(body.error.retryable).toBe(ERROR_RETRYABLE.PROVIDER_ERROR);
    // The raw exception text carried a filesystem path — it must be gone.
    expect(result.body.includes("/Users/")).toBe(false);
    expect(result.body.includes("entries.json")).toBe(false);
  });

  it("serves the SAME code/message/retryable triple as the MCP adapter (no drift)", async () => {
    // The two transports share ONE core→transport error mapping. If Task 5 had
    // re-implemented it, this assertion is what breaks when one side changes.
    const cases: Array<{ body: unknown; reader: () => CorpusReader }> = [
      { body: { productContext: "tiny" }, reader: () => makeReader([], []) },
      {
        body: validBody(),
        reader: () =>
          makeReader([], [], {
            searchRanked: vi.fn(async () => {
              throw new Error("boom");
            }),
          }),
      },
    ];
    for (const c of cases) {
      const http = await handleCreateUiSpecHttp(c.body, c.reader());
      const mcp = await handleCreateUiSpec(c.body, c.reader());
      const httpError = (JSON.parse(http.body) as { error: unknown }).error;
      const mcpError = (mcp.structuredContent as { error: unknown }).error;
      expect(httpError).toEqual(mcpError);
    }
  });

  it("carries no field beyond `error` on the error branch", async () => {
    const result = await handleCreateUiSpecHttp({ productContext: "tiny" }, makeReader([], []));
    const body = JSON.parse(result.body) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["error"]);
    expect(Object.keys(body.error as Record<string, unknown>).sort()).toEqual(["code", "message", "retryable"]);
  });

  it("REFUSES to serve an envelope that fails the integrity re-check", async () => {
    // A producer/adapter defect must be refused, never served. Mutating the
    // envelope after the producer validated it simulates exactly that.
    spyState.mutate = (result) => ({
      ...result,
      envelope: { ...result.envelope, designMarkdown: "tampered" },
    });
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    await expect(handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus))).rejects.toThrow(
      /was not served/,
    );
  });

  it("publishes the integrity refusal as a NON-retryable PROVIDER_ERROR", () => {
    // The integrity re-check fails only when the producer's own output is
    // malformed — DETERMINISTIC for the same request, so a client that honours
    // `retryable` and retries would fail identically forever. The code and message
    // stay the shared PROVIDER_ERROR pair (a caller must not learn it was a
    // producer defect); only the flag differs, and it differs deliberately from
    // the shared ERROR_RETRYABLE default.
    const integrity = createUiSpecIntegrityRefusalError();
    const generic = createUiSpecTransportError("PROVIDER_ERROR");
    expect(integrity.code).toBe(generic.code);
    expect(integrity.message).toBe(generic.message);
    expect(generic.retryable).toBe(ERROR_RETRYABLE.PROVIDER_ERROR);
    expect(generic.retryable).toBe(true);
    expect(integrity.retryable).toBe(false);
    expect(Object.keys(integrity).sort()).toEqual(["code", "message", "retryable"]);
  });

  it("names no value in the refusal message (positions only)", async () => {
    spyState.mutate = (result) => ({
      ...result,
      envelope: { ...result.envelope, designMarkdown: "zq-tamper-marker-5541" },
    });
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    await expect(
      handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus)),
    ).rejects.toThrow(/^(?!.*zq-tamper-marker-5541)/s);
  });
});
