/**
 * create-ui-spec-mcp.test.ts — TDD for the `create_ui_spec` MCP registration
 * (Task 3 of the C3 slice).
 *
 * The module under test is a THIN transport adapter. It may parse transport
 * input, call the sole producer (`createUiSpecForAdapter`), and serialize a
 * validated result. It may NOT construct a UiSpec, assign evidence authority,
 * sanitize raw corpus entries, or render a second handoff.
 *
 * The properties pinned here:
 *  1. THE CONTRACT GATE RUNS ON THE SERVED RESPONSE. `parseToolResult` is called
 *     before anything is returned, and a gate-violating payload is REFUSED
 *     rather than served. Without this, Tasks 1/1b/2 are decorative — nothing
 *     else in the repo routes a served MCP response through the gate.
 *  2. `content[0]` is byte-identical to `envelope.designMarkdown` /
 *     `envelope.designJson` FROM THE SAME producer invocation (proved by a spy
 *     that wraps the real producer and records the exact envelope object).
 *  3. `data` is the validated UiSpec, not the artifact envelope.
 *  4. `referenceIds` is only `UiSpec.citedReferences`; `evidence-N` ids never
 *     become referenceIds.
 *  5. retrieval + warnings are copied from the parsed envelope through the ONE
 *     shared mapping, with the producer's real state preserved.
 *  6. No raw caller token (including a REFUSED one) and no
 *     `omittedReferenceTokens`-derived signal reaches any surface.
 *  7. No top-level response field beyond the shared envelope's own key set.
 *  8. Typed errors: core INVALID_INPUT → MCP INVALID_INPUT (retryable false),
 *     core RETRIEVAL_UNAVAILABLE → MCP PROVIDER_ERROR (retryable true), both as
 *     the standard error envelope with `isError`.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  projectSanitizedEvidenceToMcpEvidence,
  projectRetrievalStateForTransport,
  containsPrivateMarker,
  type CreateUiSpecAdapterResult,
} from "./create-ui-spec-contracts.js";
import { parseToolResult, CreateUiSpecInput } from "./tool-contracts.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Spy over the SOLE producer.
//
// Two things need the real envelope object the adapter actually consumed:
//  - the byte-identity assertion on content[0] (a second invocation would carry
//    a different generatedAt, so comparing against a fresh call proves nothing);
//  - the gate test, which must hand the adapter a payload the gate refuses.
// So the module is partially mocked: `createUiSpecForAdapter` runs FOR REAL and
// its result is recorded, with an optional test-supplied mutation applied after
// the real producer has finished.
// ---------------------------------------------------------------------------

const spyState = vi.hoisted(() => ({
  /** Mutate the real producer result before the adapter sees it (gate tests). */
  mutate: undefined as
    | ((result: CreateUiSpecAdapterResult) => CreateUiSpecAdapterResult)
    | undefined,
  /** The real, unmutated results in call order. */
  produced: [] as CreateUiSpecAdapterResult[],
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
const { registerCreateUiSpec, handleCreateUiSpec } = await import("./create-ui-spec-mcp.js");
const { createServer } = await import("./server-factory.js");

// ---------------------------------------------------------------------------
// Fixtures. Private markers are deliberately distinctive so a leak is visible.
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

/**
 * Fake CorpusReader. `getById` is the ONLY resolution route the adapter's
 * dependency factory may consult, so the fake resolves exactly the ids present
 * in `corpus`.
 */
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

function validArgs(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    productContext: "A calm analytics dashboard for a fintech",
    ...over,
  };
}

/** The three real producer retrieval states, as transport calls. */
const STATES: Array<{
  label: string;
  reader: () => CorpusReader;
  args: () => Record<string, unknown>;
  expect: { mode: string; modality: string };
}> = [
  {
    label: "automatic retrieval with matches (keyword/metadata)",
    reader: () => {
      const corpus = [fixtureEntry("internal-1", "product-Alpha"), fixtureEntry("internal-2", "product-Bravo")];
      return makeReader(corpus, corpus);
    },
    args: () => validArgs(),
    expect: { mode: "keyword", modality: "metadata" },
  },
  {
    label: "zero-match structured fallback (structured-fallback/metadata)",
    reader: () => makeReader([], []),
    args: () => validArgs(),
    expect: { mode: "structured-fallback", modality: "metadata" },
  },
  {
    label: "explicit public references (none/none)",
    reader: () => makeReader([fixtureEntry(RAW_TOKEN_RESOLVED, "product-Alpha")], []),
    args: () => validArgs({ referenceIds: [RAW_TOKEN_RESOLVED] }),
    expect: { mode: "none", modality: "none" },
  },
];

/** Every object key at any depth of `value`. */
function collectKeys(value: unknown, acc: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, acc);
  } else if (value !== null && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      acc.push(k);
      collectKeys(v, acc);
    }
  }
  return acc;
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
  spyState.mutate = undefined;
  spyState.produced.length = 0;
  vi.clearAllMocks();
});
afterEach(() => {
  spyState.mutate = undefined;
});

// ---------------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------------

interface CapturedRegistration {
  name: string;
  config: { title?: string; description?: string; inputSchema?: unknown; outputSchema?: unknown };
  handler: (args: unknown) => Promise<unknown>;
}

function captureRegistrations(reader: CorpusReader): CapturedRegistration[] {
  const captured: CapturedRegistration[] = [];
  const fakeServer = {
    registerTool: (name: string, config: CapturedRegistration["config"], handler: CapturedRegistration["handler"]) => {
      captured.push({ name, config, handler });
      return { enable: () => {}, disable: () => {}, remove: () => {} };
    },
  } as unknown as McpServer;
  registerCreateUiSpec(fakeServer, reader);
  return captured;
}

describe("create_ui_spec MCP registration — registration surface", () => {
  it("registers exactly one tool, named create_ui_spec, with a title/description and an input schema", () => {
    const captured = captureRegistrations(makeReader([], []));
    expect(captured.length).toBe(1);
    expect(captured[0]!.name).toBe("create_ui_spec");
    expect(typeof captured[0]!.config.title).toBe("string");
    expect((captured[0]!.config.description ?? "").length).toBeGreaterThan(40);
    expect(captured[0]!.config.inputSchema).toBeDefined();
  });

  it("declares no outputSchema (the contract gate, not the SDK, validates the result)", () => {
    // The shared result envelope is a refined (effect-wrapped) schema, which the
    // SDK cannot normalize into an object schema for tools/list. Declaring it
    // would either be dropped silently or crash the list handler; the real
    // validation is parseToolResult, asserted below.
    const captured = captureRegistrations(makeReader([], []));
    expect(captured[0]!.config.outputSchema).toBeUndefined();
  });

  it("declares CreateUiSpecInput as the input schema and it is JSON-Schema representable", () => {
    const captured = captureRegistrations(makeReader([], []));
    expect(captured[0]!.config.inputSchema).toBe(CreateUiSpecInput);
    // tools/list converts the declared input schema to JSON Schema. If that
    // throws, EVERY tool becomes undiscoverable — so pin it here.
    const jsonSchema = z.toJSONSchema(CreateUiSpecInput, { io: "input" }) as {
      properties?: Record<string, unknown>;
    };
    expect(Object.keys(jsonSchema.properties ?? {})).toContain("productContext");
    expect(Object.keys(jsonSchema.properties ?? {})).toContain("outputFormat");
  });

  it("the SDK's own input normalization accepts a valid call and applies the outputFormat default", async () => {
    // The SDK validates `arguments` against the declared schema BEFORE the
    // handler runs (validateToolInput → normalizeObjectSchema → safeParseAsync).
    // If it could not normalize this schema, every transport call would fail with
    // an opaque SDK error, so pin the real schema against the real helpers.
    const { normalizeObjectSchema, safeParseAsync } = await import(
      "@modelcontextprotocol/sdk/server/zod-compat.js"
    );
    const normalized = normalizeObjectSchema(CreateUiSpecInput);
    expect(normalized).toBeDefined();
    const ok = await safeParseAsync(normalized ?? CreateUiSpecInput, validArgs());
    expect(ok.success).toBe(true);
    expect((ok.data as { outputFormat?: string }).outputFormat).toBe("markdown");
    const bad = await safeParseAsync(
      normalized ?? CreateUiSpecInput,
      validArgs({ productContext: "short" }),
    );
    expect(bad.success).toBe(false);
  });

  it("createServer registers create_ui_spec and no longer registers generate_design_prompt", () => {
    const server = createServer(makeReader([], []));
    // `_registeredTools` is SDK-internal. Guarded: the length assertion below
    // fails loudly if a future SDK renames it, rather than passing vacuously.
    const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
    const names = Object.keys(registered);
    expect(names.length).toBe(14);
    expect(names).toContain("create_ui_spec");
    expect(names).not.toContain("generate_design_prompt");
    // The other 13 legacy registrations are untouched.
    for (const name of [
      "search_ui_examples", "get_ui_example", "list_categories", "list_style_tags",
      "list_domain_tags", "get_similar_ui_examples", "compare_ui_examples",
      "recommend_ui_direction", "get_anti_patterns", "get_color_palette",
      "get_stealable_techniques", "browse_ui_examples", "critique_ui",
    ]) expect(names).toContain(name);
  });
});

// ---------------------------------------------------------------------------
// 2. Success path — one describe per real producer state
// ---------------------------------------------------------------------------

const ENVELOPE_KEYS = [
  "data", "error", "evidence", "referenceIds", "retrieval", "schemaVersion",
  "status", "summary", "tool", "warnings",
].sort();

interface McpResult {
  content: Array<{ type: string; text: string }>;
  structuredContent: Record<string, unknown>;
  isError?: boolean;
}

describe.each(STATES)("create_ui_spec MCP registration — success: $label", (state) => {
  async function call(over: Record<string, unknown> = {}): Promise<McpResult> {
    return (await handleCreateUiSpec({ ...state.args(), ...over }, state.reader())) as McpResult;
  }

  it("content[0] is byte-identical to envelope.designMarkdown from the same invocation", async () => {
    const result = await call();
    const produced = spyState.produced[0]!;
    expect(result.content.length).toBe(1);
    expect(result.content[0]!.type).toBe("text");
    // Identity, not equality: the served string IS the producer's rendering.
    expect(result.content[0]!.text).toBe(produced.envelope.designMarkdown);
  });

  it("outputFormat json serves envelope.designJson verbatim and nothing else changes", async () => {
    const result = await call({ outputFormat: "json" });
    const produced = spyState.produced[0]!;
    expect(result.content[0]!.text).toBe(produced.envelope.designJson);
    expect(result.content[0]!.text).not.toBe(produced.envelope.designMarkdown);
    // Same structured payload regardless of presentation format.
    expect(result.structuredContent.data).toBe(produced.envelope.spec);
  });

  it("outputFormat is adapter-local — it never reaches the core request", async () => {
    await call({ outputFormat: "json" });
    const [request] = vi.mocked(core.createUiSpecForAdapter).mock.calls[0]!;
    expect(Object.keys(request as Record<string, unknown>)).not.toContain("outputFormat");
    expect(Object.keys(request as Record<string, unknown>)).toContain("productContext");
  });

  it("the dependencies come from makeCreateUiSpecDependencies (reader-only reference policy)", async () => {
    await call();
    const [, dependencies] = vi.mocked(core.createUiSpecForAdapter).mock.calls[0]!;
    const deps = dependencies as unknown as {
      reader: CorpusReader;
      resolveReferenceToken: (t: string) => string | undefined;
      now?: () => Date;
    };
    // The injected reader is passed verbatim; the resolver is the getById policy.
    expect(deps.reader).toBe(vi.mocked(core.createUiSpecForAdapter).mock.calls[0]![1].reader);
    expect(deps.resolveReferenceToken(RAW_TOKEN_REFUSED)).toBeUndefined();
    // No adapter-supplied clock (the core's own `new Date()` default applies).
    expect(deps.now).toBeUndefined();
  });

  it("data is the validated UiSpec, not the artifact envelope", async () => {
    const result = await call();
    const produced = spyState.produced[0]!;
    expect(result.structuredContent.data).toBe(produced.envelope.spec);
    const data = result.structuredContent.data as Record<string, unknown>;
    expect(data.specVersion).toBeDefined();
    // Envelope-only fields must be absent.
    for (const k of ["artifactVersion", "artifactId", "designMarkdown", "designJson", "specSha256", "publicEvidenceIds"])
      expect(data[k]).toBeUndefined();
  });

  it("referenceIds is exactly citedReferences and carries no evidence-N id", async () => {
    const result = await call();
    const produced = spyState.produced[0]!;
    expect(result.structuredContent.referenceIds).toEqual([...produced.envelope.spec.citedReferences]);
    for (const ref of result.structuredContent.referenceIds as string[]) {
      expect(ref).not.toMatch(/^evidence-/);
      expect(ref).toMatch(/^ref-[0-9a-f]{64}$/);
    }
  });

  it("evidence is the ONE safe projection of the producer's sanitized rows", async () => {
    const result = await call();
    const produced = spyState.produced[0]!;
    expect(result.structuredContent.evidence).toEqual(
      projectSanitizedEvidenceToMcpEvidence(produced.sanitizedEvidence),
    );
  });

  it("retrieval preserves the producer's real state through the shared mapping", async () => {
    const result = await call();
    const produced = spyState.produced[0]!;
    const retrieval = result.structuredContent.retrieval as Record<string, unknown>;
    expect(retrieval).toEqual(projectRetrievalStateForTransport(produced.envelope));
    expect(retrieval.mode).toBe(state.expect.mode);
    expect(retrieval.modality).toBe(state.expect.modality);
    // The real state is never normalized: every non-resultCount field is the
    // producer's own value.
    for (const key of ["mode", "modality", "fallbackUsed", "fallbackReason", "attemptedCount", "attemptedModes"])
      expect(retrieval[key]).toEqual((produced.envelope.retrieval as Record<string, unknown>)[key]);
    // resultCount is re-scoped to the ARTIFACT count the descriptor documents.
    expect(retrieval.resultCount).toBe(1);
  });

  it("warnings are copied from the parsed envelope without reinterpretation", async () => {
    const result = await call();
    const produced = spyState.produced[0]!;
    expect(result.structuredContent.warnings).toEqual(
      produced.envelope.warnings.map((w) => ({ code: w.code, message: w.message })),
    );
  });

  it("the served result passes the fail-closed contract gate", async () => {
    const result = await call();
    const gate = parseToolResult(result.structuredContent);
    expect(gate.ok, gate.errors.join("\n")).toBe(true);
    expect(result.structuredContent.tool).toBe("create_ui_spec");
    expect(result.structuredContent.schemaVersion).toBe("1.0");
    expect(result.structuredContent.status).toBe("ok");
    expect(result.isError).toBeUndefined();
  });

  it("adds no top-level field beyond the shared envelope's key set", async () => {
    const result = await call();
    expect(Object.keys(result.structuredContent).sort()).toEqual(
      ENVELOPE_KEYS.filter((k) => k !== "error"),
    );
    expect(Object.keys(result).sort()).toEqual(["content", "structuredContent"]);
  });

  it("the summary is a bounded constant carrying no brief, path, url, corpus id or product identity", async () => {
    const result = await call();
    const summary = result.structuredContent.summary as string;
    expect(summary.length).toBeGreaterThan(0);
    expect(summary.length).toBeLessThanOrEqual(200);
    expect(summary).not.toContain("analytics dashboard for a fintech");
    for (const marker of BANNED) expect(summary).not.toContain(marker);
    expect(summary).not.toMatch(/:\/\/|[/\\]/);
  });

  it("the serialized response leaks no private marker and no raw caller token", async () => {
    const result = await call();
    const serialized = JSON.stringify(result);
    for (const marker of BANNED)
      expect(serialized.includes(marker), `leaked marker "${marker}"`).toBe(false);
    expect(containsPrivateMarker(serialized)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. The contract gate provably runs on the served response
// ---------------------------------------------------------------------------

describe("create_ui_spec MCP registration — the contract gate runs before anything is served", () => {
  it("refuses to serve a payload whose citedReferences carry a raw private path", async () => {
    // The leaf gate classifies data.citedReferences[] as a safe-public-reference
    // position. A raw path there is exactly the leak class Task 1b closed, and it
    // reaches this adapter only if the producer/adapter is buggy — so the adapter
    // must refuse rather than serve it.
    const poison = "/Users/secret/corpus/images-private/leak.png";
    spyState.mutate = (result) => ({
      ...result,
      envelope: {
        ...result.envelope,
        spec: { ...result.envelope.spec, citedReferences: [poison] },
      },
    });
    await expect(handleCreateUiSpec(validArgs(), makeReader([], []))).rejects.toThrow(
      /create_ui_spec result failed the contract gate/,
    );
  });

  it("the refusal echoes neither the offending value nor the caller's brief", async () => {
    const poison = "/Users/secret/corpus/images-private/leak.png";
    spyState.mutate = (result) => ({
      ...result,
      envelope: {
        ...result.envelope,
        spec: { ...result.envelope.spec, citedReferences: [poison] },
      },
    });
    let message = "";
    try {
      await handleCreateUiSpec(validArgs(), makeReader([], []));
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).not.toBe("");
    expect(message).not.toContain(poison);
    expect(message).not.toContain("images-private");
    expect(message).not.toContain("analytics dashboard for a fintech");
  });

  it("refuses a payload whose evidence id domain has been substituted into referenceIds", async () => {
    // evidence-N and ref-<sha256> are separate domains. A response-scoped
    // evidence id in a reference position must never be served.
    spyState.mutate = (result) => ({
      ...result,
      envelope: {
        ...result.envelope,
        spec: { ...result.envelope.spec, citedReferences: ["evidence-1"] },
      },
    });
    await expect(handleCreateUiSpec(validArgs(), makeReader([], []))).rejects.toThrow(
      /create_ui_spec result failed the contract gate/,
    );
  });

  it("refuses to serve a rendering that carries a private corpus marker", async () => {
    // content[0] is the one served string the leaf gate does not walk (the gate's
    // roots are data/referenceIds/evidence). Its control is the envelope's own
    // private-marker sweep; the adapter restates it at the transport boundary so
    // the served body cannot be the exception.
    spyState.mutate = (result) => ({
      ...result,
      envelope: {
        ...result.envelope,
        designMarkdown: `${result.envelope.designMarkdown}\n\nimages-private/secret.png`,
      },
    });
    await expect(handleCreateUiSpec(validArgs(), makeReader([], []))).rejects.toThrow(
      /create_ui_spec result failed the contract gate|create_ui_spec rendering/,
    );
  });
});

// ---------------------------------------------------------------------------
// 4. Typed, safe errors
// ---------------------------------------------------------------------------

const ERROR_RETRIEVAL = {
  mode: "none", modality: "none", resultCount: 0,
  fallbackUsed: false, attemptedCount: 0, attemptedModes: [],
};

describe("create_ui_spec MCP registration — typed errors", () => {
  function expectStandardErrorEnvelope(result: McpResult, code: string, retryable: boolean): void {
    expect(result.isError).toBe(true);
    const env = result.structuredContent;
    expect(Object.keys(env).sort()).toEqual(ENVELOPE_KEYS);
    expect(env.tool).toBe("create_ui_spec");
    expect(env.schemaVersion).toBe("1.0");
    expect(env.status).toBe("error");
    expect(env.data).toBe(null);
    expect(env.referenceIds).toEqual([]);
    expect(env.evidence).toEqual([]);
    expect(env.warnings).toEqual([]);
    expect(env.retrieval).toEqual(ERROR_RETRIEVAL);
    expect(env.error).toMatchObject({ code, retryable });
    // The error envelope is itself gate-validated before being served.
    const gate = parseToolResult(env);
    expect(gate.ok, gate.errors.join("\n")).toBe(true);
    // content[0] restates the bounded message — never a stack or a raw brief.
    expect(result.content.length).toBe(1);
    expect(result.content[0]!.text).toBe((env.error as { message: string }).message);
  }

  it("maps core INVALID_INPUT (all references unresolvable) to non-retryable INVALID_INPUT", async () => {
    const result = (await handleCreateUiSpec(
      validArgs({ referenceIds: [RAW_TOKEN_REFUSED] }),
      makeReader([], []),
    )) as McpResult;
    expectStandardErrorEnvelope(result, "INVALID_INPUT", false);
    // The refused RAW token is never echoed anywhere.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(RAW_TOKEN_REFUSED);
  });

  it("maps core RETRIEVAL_UNAVAILABLE to the existing retryable PROVIDER_ERROR", async () => {
    const reader = makeReader([], [], {
      searchRanked: vi.fn(async () => {
        throw new Error("ENOENT: /Users/secret/corpus/images-private/index.json missing");
      }),
    });
    const result = (await handleCreateUiSpec(validArgs(), reader)) as McpResult;
    expectStandardErrorEnvelope(result, "PROVIDER_ERROR", true);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("/Users/secret");
    expect(serialized).not.toContain("images-private");
    expect(serialized).not.toContain("ENOENT");
  });

  it("rejects transport input that fails CreateUiSpecInput with a typed INVALID_INPUT envelope", async () => {
    for (const bad of [
      validArgs({ productContext: "short" }),
      validArgs({ unexpectedField: true }),
      validArgs({ referenceIds: [RAW_TOKEN_REFUSED, RAW_TOKEN_REFUSED] }),
      { productContext: 42 },
      null,
    ]) {
      const result = (await handleCreateUiSpec(bad, makeReader([], []))) as McpResult;
      expectStandardErrorEnvelope(result, "INVALID_INPUT", false);
      // The producer is never invoked for input the transport schema refuses.
      expect(JSON.stringify(result)).not.toContain(RAW_TOKEN_REFUSED);
    }
    expect(vi.mocked(core.createUiSpecForAdapter)).not.toHaveBeenCalled();
  });

  it("the error message is bounded and free of paths, urls and corpus identifiers", async () => {
    const result = (await handleCreateUiSpec(
      validArgs({ referenceIds: [RAW_TOKEN_REFUSED] }),
      makeReader([], []),
    )) as McpResult;
    const message = (result.structuredContent.error as { message: string }).message;
    expect(message.length).toBeGreaterThan(0);
    expect(message.length).toBeLessThanOrEqual(500);
    expect(message).not.toMatch(/:\/\/|[/\\]|node_modules|dist\/|private|corpus-/);
  });
});

// ---------------------------------------------------------------------------
// 5. No refused-token signal beyond what citedReferences already implies
// ---------------------------------------------------------------------------

describe("create_ui_spec MCP registration — refused tokens are not surfaced", () => {
  it("a partially resolvable reference list omits the refused token with no per-token signal", async () => {
    const reader = makeReader([fixtureEntry(RAW_TOKEN_RESOLVED, "product-Alpha")], []);
    const result = (await handleCreateUiSpec(
      validArgs({ referenceIds: [RAW_TOKEN_RESOLVED, RAW_TOKEN_REFUSED] }),
      reader,
    )) as McpResult;
    const serialized = JSON.stringify(result);
    // Neither raw token appears; only the ONE digest for the resolved token.
    expect(serialized).not.toContain(RAW_TOKEN_RESOLVED);
    expect(serialized).not.toContain(RAW_TOKEN_REFUSED);
    expect(result.structuredContent.referenceIds).toHaveLength(1);
    // No omitted/refused-token channel exists at any level of the envelope. Keys,
    // not text: the recipe's own acceptance-criteria prose legitimately contains
    // the word "omitted", so a substring scan over the rendering would be a
    // meaningless assertion.
    for (const key of collectKeys(result.structuredContent))
      expect(key, `refused-token channel key "${key}"`).not.toMatch(/omit|refus|unresolv/i);
    // The gate still accepts the partial-resolution result.
    expect(parseToolResult(result.structuredContent).ok).toBe(true);
  });

  it("a fully resolvable list and a partially resolvable list are structurally identical", async () => {
    // Guard against amplifying the accepted existence oracle: the response must
    // carry no per-token success/failure list, count, or ordering signal beyond
    // `citedReferences` itself. One resolved token yields the same shape whether
    // or not a second token was refused.
    const reader = () => makeReader([fixtureEntry(RAW_TOKEN_RESOLVED, "product-Alpha")], []);
    const only = (await handleCreateUiSpec(
      validArgs({ referenceIds: [RAW_TOKEN_RESOLVED] }),
      reader(),
    )) as McpResult;
    const partial = (await handleCreateUiSpec(
      validArgs({ referenceIds: [RAW_TOKEN_RESOLVED, RAW_TOKEN_REFUSED] }),
      reader(),
    )) as McpResult;
    expect(Object.keys(partial.structuredContent).sort()).toEqual(Object.keys(only.structuredContent).sort());
    expect(partial.structuredContent.referenceIds).toEqual(only.structuredContent.referenceIds);
    expect(partial.structuredContent.retrieval).toEqual(only.structuredContent.retrieval);
    expect(partial.structuredContent.warnings).toEqual(only.structuredContent.warnings);
    expect(partial.structuredContent.summary).toEqual(only.structuredContent.summary);
    expect((partial.structuredContent.evidence as unknown[]).length).toBe(
      (only.structuredContent.evidence as unknown[]).length,
    );
  });
});
