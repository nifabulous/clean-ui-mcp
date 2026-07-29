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
  buildSemanticSpecInput,
  buildArtifactIdentityInput,
  sha256Canonical,
  CANONICAL_WEB_TARGET_PROFILES,
  type CreateUiSpecAdapterResult,
  type DesignArtifactEnvelope,
} from "./create-ui-spec-contracts.js";
import { parseDesignHandoff } from "./design-target-contracts.js";
import { renderDesignHandoffMarkdown, renderDesignHandoffJson } from "./design-handoff.js";
import { sha256Hex } from "./readiness/contracts.js";
import { ERROR_RETRYABLE, ToolResultSchemas } from "./tool-contracts.js";
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

// ---------------------------------------------------------------------------
// The reference/evidence ID-shape gate — the SAME rules as MCP, on this
// transport. Both adapters publish the same `spec` object; before this gate ran
// here, Global Constraints 19 and 20 (no raw corpus id / url / path in a
// reference position; the evidence-id and reference-id domains stay disjoint)
// were enforced on MCP only, because the only caller of the leaf gate was
// `parseToolResult` and this adapter does not serve a tool result. The mirror
// cases are `create-ui-spec-mcp.test.ts` § "the contract gate runs before
// anything is served".
//
// The mutations below also break the envelope hashes, so each of them WOULD be
// refused by the integrity re-check. That is exactly why the ID-shape gate runs
// first and carries its own message: the assertions below discriminate between
// "refused because a reference was unsafe" and "refused because a hash moved".
// ---------------------------------------------------------------------------
/** Module-scoped so both this describe block and the m3(r4) block below can pin it. */
const ID_SHAPE_REFUSAL = /failed the reference\/evidence ID-shape gate and was not served/;

describe("create_ui_spec HTTP reference/evidence ID-shape gate", () => {

  it("REFUSES to serve a spec whose citedReferences carry a raw private path", async () => {
    const poison = "/Users/secret/corpus/images-private/leak.png";
    spyState.mutate = (result) => ({
      ...result,
      envelope: {
        ...result.envelope,
        spec: { ...result.envelope.spec, citedReferences: [poison] },
      },
    });
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    await expect(
      handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus)),
    ).rejects.toThrow(ID_SHAPE_REFUSAL);
  });

  it("REFUSES to serve a spec whose citedReferences carry a raw corpus id", async () => {
    // The scenario in the finding: a producer regression puts the corpus entry id
    // itself in a reference position. `containsPrivateMarker` does not catch it
    // (it is a fixed marker list) and `UiSpec.citedReferences` is
    // `z.array(z.string())`, so the ID-shape rule is the only thing that does.
    spyState.mutate = (result) => ({
      ...result,
      envelope: {
        ...result.envelope,
        spec: { ...result.envelope.spec, citedReferences: ["stripe-pricing-2024"] },
      },
    });
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    await expect(
      handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus)),
    ).rejects.toThrow(ID_SHAPE_REFUSAL);
  });

  it("REFUSES a response-scoped evidence id substituted into a reference position", async () => {
    // The two ID domains must stay disjoint on both transports.
    spyState.mutate = (result) => ({
      ...result,
      envelope: {
        ...result.envelope,
        spec: { ...result.envelope.spec, citedReferences: ["evidence-1"] },
      },
    });
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    await expect(
      handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus)),
    ).rejects.toThrow(ID_SHAPE_REFUSAL);
  });

  it("REFUSES a safe reference digest substituted into an evidence-id position", async () => {
    // The other direction of the same disjointness rule.
    spyState.mutate = (result) => ({
      ...result,
      envelope: {
        ...result.envelope,
        spec: {
          ...result.envelope.spec,
          provenance: {
            ...result.envelope.spec.provenance,
            evidenceIds: [`ref-${"a".repeat(64)}`],
          },
        },
      },
    });
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    await expect(
      handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus)),
    ).rejects.toThrow(ID_SHAPE_REFUSAL);
  });

  it("the refusal names positions only — never the offending value or the brief", async () => {
    const poison = "/Users/secret/corpus/images-private/leak.png";
    spyState.mutate = (result) => ({
      ...result,
      envelope: {
        ...result.envelope,
        spec: { ...result.envelope.spec, citedReferences: [poison] },
      },
    });
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    let message = "";
    try {
      await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(ID_SHAPE_REFUSAL);
    expect(message).toContain("data.citedReferences[]");
    expect(message).not.toContain(poison);
    expect(message).not.toContain("images-private");
    expect(message).not.toContain("analytics dashboard for a fintech");
  });

  it("serves the unmutated producer output — the gate is not refusing everything", async () => {
    // The control. Without this, every assertion above would also pass against a
    // gate that threw unconditionally.
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    const result = await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus));
    expect(result.status).toBe(200);
    const served = parseDesignArtifactEnvelope(JSON.parse(result.body));
    for (const ref of served.spec.citedReferences) {
      expect(ref).toMatch(/^ref-[0-9a-f]{64}$/);
    }
  });

  it("refuses the same shapes the MCP adapter refuses (no transport drift)", async () => {
    // Both adapters publish the same `spec`. This asserts they agree on the
    // VERDICT for the same poisoned spec, which is the property that was broken:
    // MCP refused, HTTP served 200.
    //
    // The regex below pins the SPECIFIC gate that must fire on each side, not
    // the generic `/was not served/` substring every refusal message shares —
    // including the HTTP envelope-integrity refusal
    // (`create-ui-spec-http.ts:277`), which this same mutation also trips
    // (mutating `spec` after the producer hashed it moves `specSha256`). A
    // generic match here would still pass with the ID-shape gate deleted
    // entirely, because `assertServedBytesAreEnvelope` falls through to the
    // integrity re-check, whose message ALSO matches `/was not served/` — so
    // this test could not have caught the transport drift it is named for
    // (m2, round 4). Each assertion must name its own gate.
    const poison = "https://private.example.com/secret";
    spyState.mutate = (result) => ({
      ...result,
      envelope: {
        ...result.envelope,
        spec: { ...result.envelope.spec, citedReferences: [poison] },
      },
    });
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    await expect(
      handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus)),
    ).rejects.toThrow(ID_SHAPE_REFUSAL);
    spyState.mutate = (result) => ({
      ...result,
      envelope: {
        ...result.envelope,
        spec: { ...result.envelope.spec, citedReferences: [poison] },
      },
    });
    await expect(handleCreateUiSpec(validBody(), makeReader(corpus, corpus))).rejects.toThrow(
      /create_ui_spec result failed the contract gate/,
    );
  });
});

// ---------------------------------------------------------------------------
// m3(r4): a SELF-CONSISTENT poisoned envelope.
//
// Every case above mutates the envelope AFTER the producer computed its
// hashes, so `specSha256` (and the rest) has already moved off the poisoned
// spec — the design-artifact integrity re-check would refuse every one of them
// even with the ID-shape gate deleted; only the REFUSAL MESSAGE discriminates.
// That is not the scenario the finding names. The scenario is a PRODUCER
// regression: a poisoned `spec` whose stored hashes and renderings are
// mutually consistent WITH the poison, because they were computed over it.
// There, the integrity re-check has nothing to catch, and the ID-shape gate is
// the only screen — which is exactly why Global Constraints 19/20 needed their
// own gate instead of resting on envelope integrity.
//
// `rebuildEnvelopeAroundSpec` mirrors the producer's own `buildEnvelope`
// (create-ui-spec.ts, not exported) using only the exported building blocks
// `parseDesignArtifactEnvelope` itself calls: `parseDesignHandoff`,
// `renderDesignHandoffMarkdown`/`Json`, `buildSemanticSpecInput`,
// `buildArtifactIdentityInput`, `sha256Canonical` and `CANONICAL_WEB_TARGET_
// PROFILES`. It recomputes every hash and rendering from the POISONED spec, so
// the returned envelope passes `parseDesignArtifactEnvelope` end to end.
// ---------------------------------------------------------------------------
/**
 * Rebuild every hash-derived and rendered field of `envelope` around a
 * (possibly poisoned) spec, using the SAME exported building blocks
 * `parseDesignArtifactEnvelope` uses to verify them (design-target-
 * contracts.ts's `parseDesignHandoff`, design-handoff.ts's two renderers,
 * and create-ui-spec-contracts.ts's `buildSemanticSpecInput` /
 * `buildArtifactIdentityInput` / `sha256Canonical`). The result is a
 * self-consistent envelope: it passes `parseDesignArtifactEnvelope` even
 * though `spec` may carry a poisoned leaf, because every stored hash and
 * rendering was recomputed FROM that same poisoned spec — exactly the
 * producer-regression scenario m3(r4) names.
 */
function rebuildEnvelopeAroundSpec(
  envelope: DesignArtifactEnvelope,
  poisonSpec: (spec: DesignArtifactEnvelope["spec"]) => DesignArtifactEnvelope["spec"],
): DesignArtifactEnvelope {
  const spec = poisonSpec(envelope.spec);
  const targetProfile = CANONICAL_WEB_TARGET_PROFILES[envelope.handoff.target];
  const handoff = parseDesignHandoff({
    spec,
    target: targetProfile,
    motionIntents: envelope.handoff.motionIntents,
    generatedAt: envelope.generatedAt,
  });
  const designMarkdown = renderDesignHandoffMarkdown(handoff);
  const designJson = renderDesignHandoffJson(handoff);
  const semanticSpecSha256 = sha256Canonical(buildSemanticSpecInput(spec));
  const artifactId = `uispec-${sha256Canonical(
    buildArtifactIdentityInput({
      producerVersion: envelope.producerVersion,
      assemblyRulesSha256: envelope.assemblyRulesSha256,
      semanticSpecSha256,
      target: envelope.handoff.target,
      motionIntents: envelope.handoff.motionIntents,
    }),
  )}`;
  return {
    ...envelope,
    spec,
    designMarkdown,
    designJson,
    specSha256: sha256Canonical(spec),
    semanticSpecSha256,
    designMarkdownSha256: sha256Hex(Buffer.from(designMarkdown, "utf-8")),
    designJsonSha256: sha256Hex(Buffer.from(designJson, "utf-8")),
    artifactId,
  };
}

describe("create_ui_spec — a self-consistent poisoned envelope (m3(r4))", () => {
  it("sanity check: the rebuild helper reproduces the UNPOISONED envelope byte-for-byte", async () => {
    // Proves the helper is a faithful reconstruction, not a stand-in that
    // happens to satisfy the schema — before trusting it to build a poisoned
    // one. If this fails, the poisoned-envelope test below proves nothing.
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus));
    const produced = spyState.produced[0]!.envelope;
    const rebuilt = rebuildEnvelopeAroundSpec(produced, (spec) => spec);
    expect(rebuilt).toEqual(produced);
    expect(() => parseDesignArtifactEnvelope(rebuilt)).not.toThrow();
  });

  it("REFUSES a self-consistent envelope whose poisoned citedReferences survive the integrity re-check", async () => {
    // The producer-regression scenario: hashes and renderings are recomputed
    // OVER the poisoned spec, so `parseDesignArtifactEnvelope` (specSha256,
    // semanticSpecSha256, the two rendering hashes, the re-rendered bytes, and
    // the recomputed artifactId) all agree with the poison. Only the ID-shape
    // gate can refuse this.
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus));
    const produced = spyState.produced[0]!.envelope;
    const poisoned = rebuildEnvelopeAroundSpec(produced, (spec) => ({
      ...spec,
      citedReferences: ["stripe-pricing-2024"],
    }));
    // Control: the self-consistent envelope passes the integrity re-check on
    // its own — the ID-shape gate is genuinely the only screen for it here,
    // not a second independent check that would have caught it anyway.
    expect(() => parseDesignArtifactEnvelope(poisoned)).not.toThrow();

    spyState.mutate = (result) => ({ ...result, envelope: poisoned });
    await expect(
      handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus)),
    ).rejects.toThrow(ID_SHAPE_REFUSAL);

    spyState.mutate = (result) => ({ ...result, envelope: poisoned });
    await expect(handleCreateUiSpec(validBody(), makeReader(corpus, corpus))).rejects.toThrow(
      /create_ui_spec result failed the contract gate/,
    );
  });
});

// ---------------------------------------------------------------------------
// I3(r5): WHICH ENVELOPE CHECKS THIS TRANSPORT DOES NOT PERFORM.
//
// The `create_ui_spec` descriptor's `refineEnvelope` block (tool-contracts.ts)
// is invoked only from `makeEnvelope`, reachable only through `parseToolResult`
// — i.e. only on the MCP path. This adapter imports exactly two symbols from
// that module (`CreateUiSpecInput`, `findUnsafeCreateUiSpecLeaves`) and never
// calls it. The ID-SHAPE subset of that block is recovered here by the leaf
// gate (the Task-5 fix). SIX CITATION-CONSISTENCY CHECKS ARE NOT, even though
// every input they read is present in the body this route serves.
//
// This block pins the asymmetry rather than asserting parity that does not
// exist. For each of the six rules it proves three things on the SAME poison:
//
//   1. CONTROL — `parseDesignArtifactEnvelope` accepts the poisoned envelope on
//      its own, so no other HTTP screen would have caught it anyway. Without
//      this the rest would prove nothing.
//   2. MCP REFUSES, and refuses for THE NAMED RULE — asserted against
//      `ToolResultSchemas.create_ui_spec`, the same schema object
//      `parseToolResult` dispatches to (create-ui-spec-mcp.ts), with the exact
//      message, not a generic gate failure. Each poison is constructed to leave
//      every OTHER rule satisfied, so the message list is exactly one entry.
//   3. HTTP SERVES IT — `handleCreateUiSpecHttp` resolves, i.e. a dangling or
//      duplicate citation link reaches the operator with 200.
//
// WHAT IS AND IS NOT AT STAKE. No private data escapes: the leaf gate still
// enforces `ref-<sha256>` shape on all eight reference positions and
// `containsPrivateMarker` still sweeps the whole body — both poisoned refs
// below are well-formed `ref-` digests precisely so the leaf gate cannot be
// the thing that catches them. What escapes is PROVENANCE INTEGRITY: a
// technique or component that cites a source the artifact does not cite.
//
// IF A FUTURE CHANGE CLOSES THE GAP, THESE ASSERTIONS MUST BE INVERTED, NOT
// DELETED. `expect(...).resolves` becoming a rejection is the signal that HTTP
// started validating; flip it to a refusal assertion and update the docblock in
// create-ui-spec-http.ts. Deleting the block would remove the only record that
// the transports ever differed here.
// ---------------------------------------------------------------------------
describe("create_ui_spec HTTP — the six refineEnvelope citation checks are MCP-only (I3(r5))", () => {
  /** Well-formed public reference digests: correct SHAPE, wrong MEMBERSHIP. */
  const CITED_REF = `ref-${"a".repeat(64)}`;
  const UNCITED_REF = `ref-${"b".repeat(64)}`;

  type SpecT = DesignArtifactEnvelope["spec"];

  /**
   * One row per `refineEnvelope` rule that does not run on this transport. Each
   * poison changes exactly what its rule reads and leaves the other five rules
   * satisfied, so `message` below is the COMPLETE issue list on MCP — that is
   * what makes "this specific check is the one missing here" a measurement
   * rather than a claim.
   */
  const MCP_ONLY_CITATION_CHECKS: ReadonlyArray<{
    readonly message: string;
    readonly poison: (spec: SpecT) => SpecT;
  }> = [
    {
      message: "citedReferences must be unique",
      poison: (spec) => ({
        ...spec,
        citedReferences: [CITED_REF, CITED_REF],
        provenance: { ...spec.provenance, sourceReferences: [CITED_REF] },
      }),
    },
    {
      message: "provenance.sourceReferences must be unique",
      poison: (spec) => ({
        ...spec,
        citedReferences: [CITED_REF],
        provenance: { ...spec.provenance, sourceReferences: [CITED_REF, CITED_REF] },
      }),
    },
    {
      message: "provenance.sourceReferences must exactly match citedReferences",
      poison: (spec) => ({
        ...spec,
        citedReferences: [CITED_REF],
        provenance: { ...spec.provenance, sourceReferences: [] },
      }),
    },
    {
      message: "techniques[].sourceIds[] not in citedReferences (value withheld)",
      poison: (spec) => ({
        ...spec,
        citedReferences: [CITED_REF],
        provenance: { ...spec.provenance, sourceReferences: [CITED_REF] },
        techniques: [{ text: "8pt baseline grid across all regions", sourceIds: [UNCITED_REF] }],
      }),
    },
    {
      message: "antiPatterns[].sourceIds[] not in citedReferences (value withheld)",
      poison: (spec) => ({
        ...spec,
        citedReferences: [CITED_REF],
        provenance: { ...spec.provenance, sourceReferences: [CITED_REF] },
        antiPatterns: [{ text: "low-contrast secondary text", sourceIds: [UNCITED_REF] }],
      }),
    },
    {
      message: "componentInventory[].sourceId not in citedReferences (value withheld)",
      poison: (spec) => ({
        ...spec,
        citedReferences: [CITED_REF],
        provenance: { ...spec.provenance, sourceReferences: [CITED_REF] },
        componentInventory: [{ name: "MetricCard", pattern: "surface", sourceId: UNCITED_REF }],
      }),
    },
  ];

  it.each(MCP_ONLY_CITATION_CHECKS.map((c) => [c.message, c] as const))(
    "MCP refuses %s and HTTP serves it",
    async (_message, check) => {
      const corpus = [fixtureEntry("internal-1", "product-Alpha")];

      // Baseline production, then the MCP envelope for the same request. Both
      // are UNPOISONED here; the poison is applied to each below.
      await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus));
      const produced = spyState.produced[0]!.envelope;
      const mcpResult = await handleCreateUiSpec(validBody(), makeReader(corpus, corpus));
      const mcpEnvelope = (mcpResult as { structuredContent: Record<string, unknown> })
        .structuredContent;

      // ── 2. MCP refuses, for the named rule ────────────────────────────────
      // `data` is the spec (identical key set), so the same poison drives both
      // transports. `referenceIds` is re-derived because the envelope-level
      // rule "referenceIds must exactly match data IDs (as sets)" is a
      // DIFFERENT check that DOES have an HTTP counterpart — leaving it stale
      // would let that unrelated rule supply the refusal and make this test a
      // fiction.
      const poisonedData = check.poison(
        mcpEnvelope.data as SpecT,
      ) as unknown as Record<string, unknown>;
      const parsedMcp = ToolResultSchemas.create_ui_spec.safeParse({
        ...mcpEnvelope,
        data: poisonedData,
        referenceIds: [...new Set(poisonedData.citedReferences as string[])],
      });
      expect(parsedMcp.success).toBe(false);
      expect(
        parsedMcp.success ? [] : parsedMcp.error.issues.map((i) => i.message),
      ).toEqual([check.message]);

      // ── 1. CONTROL: HTTP's own envelope screen accepts the poison ─────────
      const poisonedEnvelope = rebuildEnvelopeAroundSpec(produced, check.poison);
      expect(() => parseDesignArtifactEnvelope(poisonedEnvelope)).not.toThrow();

      // ── 3. HTTP serves it ─────────────────────────────────────────────────
      spyState.mutate = (result) => ({ ...result, envelope: poisonedEnvelope });
      const served = await handleCreateUiSpecHttp(validBody(), makeReader(corpus, corpus));
      expect(served.status).toBe(200);
      // And the defective citation graph really is in the BYTES the route
      // writes, not merely tolerated by an in-memory object: the served spec is
      // the poisoned spec, field for field.
      const servedSpec = (JSON.parse(served.body) as DesignArtifactEnvelope).spec;
      expect(servedSpec).toEqual(poisonedEnvelope.spec);
    },
  );
});
