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
import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from "vitest";
import { SERVABLE_FIELD_KEYS } from "./corpus-trust.js";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CorpusReader } from "./corpus-reader.js";
import {
  applyStructuralFilters,
  keywordSearch,
  type SearchOptions,
  type SearchResult,
} from "./corpus.js";
import type { CorpusEntryT } from "./schema.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  projectSanitizedEvidenceToMcpEvidence,
  projectRetrievalStateForTransport,
  containsPrivateMarker,
  type CreateUiSpecAdapterResult,
} from "./create-ui-spec-contracts.js";
import { parseToolResult, CreateUiSpecInput, ERROR_RETRYABLE } from "./tool-contracts.js";
import { CreateUiSpecRequestSchema } from "./create-ui-spec-contracts.js";
import { z } from "zod";
import type { CreateUiSpecModelDependency } from "./create-ui-spec.js";
import type { CreateUiSpecModelRuntime } from "./create-ui-spec-model.js";
import type { ModelArtifactRecord, ModelExecution } from "./create-ui-spec-model-contracts.js";

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

// ---------------------------------------------------------------------------
// Spy over the ONE dependency factory (Task 3 review, Important 2).
//
// "the dependencies come from makeCreateUiSpecDependencies" is a PROVENANCE
// claim, and provenance cannot be established behaviourally: an adapter that
// hand-rolled `{ reader, resolveReferenceToken: t => reader.getById(t) ? t :
// undefined }` inline would be observationally identical to the factory's output,
// so every behavioural probe would still pass while the "one explicit-reference
// policy" constraint was violated. (The wiring guard only catches that
// substitution if the now-dead import is also removed, which `tsc` does not force
// — `noUnusedLocals` is off.)
//
// So the factory is wrapped and its RETURN VALUE recorded. The test then asserts
// the object handed to the producer IS that object, by identity. An inline
// replacement fails that immediately.
// ---------------------------------------------------------------------------
const depsSpyState = vi.hoisted(() => ({
  /** Every dependency object the REAL factory returned, in call order. */
  returned: [] as unknown[],
}));

vi.mock("./create-ui-spec-dependencies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./create-ui-spec-dependencies.js")>();
  return {
    ...actual,
    makeCreateUiSpecDependencies: vi.fn((
      reader: never,
      now?: () => Date,
      model?: CreateUiSpecModelDependency,
    ) => {
      const deps = actual.makeCreateUiSpecDependencies(reader, now, model);
      depsSpyState.returned.push(deps);
      return deps;
    }),
  };
});

const dependencyFactory = await import("./create-ui-spec-dependencies.js");
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

const MODEL_API_KEY = "task-6-mcp-secret-key";
const MODEL_BASE_URL = "https://models.example.test/private/endpoint?account=47";
const MODEL_STORE_PATH = "/Users/operator/private/model-artifact-store";
const MODEL_RAW_REJECTED_BODY =
  "raw-provider-body-zq private-corpus-id /Users/operator/private/provider-response.json";
const MODEL_RAW_SUCCESS_BODY = `{
  "status": "proposal-only",
  "disclaimer": "Proposal only; not accepted into token authority.",
  "designDirection": "Use a measured grid with clear hierarchy.",
  "motionNotes": []
}`;

type ModelFixtureState =
  | "not-configured"
  | "invalid-configuration"
  | "succeeded"
  | "call-failed"
  | "proposal-rejected"
  | "persistence-failed";

function modelFixture(state: ModelFixtureState): {
  dependency: CreateUiSpecModelDependency;
  runtime?: CreateUiSpecModelRuntime;
  expectedExecution?: ModelExecution["state"];
  rawProviderBody?: string;
} {
  if (state === "not-configured") return { dependency: { kind: "not-configured" } };
  if (state === "invalid-configuration") {
    return {
      dependency: { kind: "invalid-configuration" },
      expectedExecution: "invalid-configuration",
    };
  }

  const rawProviderBody = state === "proposal-rejected"
    ? MODEL_RAW_REJECTED_BODY
    : MODEL_RAW_SUCCESS_BODY;
  const store = {
    save: vi.fn(async (_record: ModelArtifactRecord) => {
      if (state === "persistence-failed") {
        throw new Error(`persistence failed at ${MODEL_STORE_PATH}`);
      }
    }),
    read: vi.fn(async () => null),
    delete: vi.fn(async () => false),
  };
  const call = vi.fn(async () => {
    if (state === "call-failed") {
      throw new Error(`provider failed: ${MODEL_RAW_REJECTED_BODY}; key=${MODEL_API_KEY}`);
    }
    return {
      content: rawProviderBody,
      provider: "openai" as const,
      model: "pinned-ui-model",
      usage: { promptTokens: 37, completionTokens: 19, raw: { input_tokens: 37, output_tokens: 19 } },
      attempts: 1,
      latencyMs: 8,
      providerRequestId: "private-provider-request-id",
    };
  }) as unknown as CreateUiSpecModelRuntime["call"];
  const runtime: CreateUiSpecModelRuntime = {
    endpoint: {
      provider: "openai",
      baseUrl: MODEL_BASE_URL,
      apiKey: MODEL_API_KEY,
      model: "pinned-ui-model",
    },
    parameters: { temperature: 0, maxOutputTokens: 4_096, maxAttempts: 1, seed: null },
    call,
    store,
  };
  return {
    dependency: { kind: "configured", runtime },
    runtime,
    expectedExecution: state,
    rawProviderBody,
  };
}

beforeEach(() => {
  spyState.mutate = undefined;
  spyState.produced.length = 0;
  depsSpyState.returned.length = 0;
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

  it("rejects model provider/configuration keys as unknown public input", () => {
    for (const key of ["provider", "baseUrl", "apiKey", "model", "modelConfig", "modelRuntime"]) {
      expect(CreateUiSpecInput.safeParse(validArgs({ [key]: "hostile-browser-value" })).success, key)
        .toBe(false);
    }
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
  "data", "error", "evidence", "modelExecutionState", "referenceIds", "retrieval",
  "schemaVersion", "status", "summary", "tool", "warnings",
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
    // The reader the TEST constructed — the comparison target has to come from
    // outside the recorded call, or the assertion compares a value with itself.
    const reader = state.reader();
    await handleCreateUiSpec(state.args(), reader);
    const [, dependencies] = vi.mocked(core.createUiSpecForAdapter).mock.calls[0]!;
    const deps = dependencies as unknown as {
      reader: CorpusReader;
      resolveReferenceToken: (t: string) => string | undefined;
      now?: () => Date;
    };

    // PROVENANCE, by identity: the object handed to the producer IS the object the
    // one factory returned. A hand-rolled inline deps literal — behaviourally
    // indistinguishable — fails here.
    expect(vi.mocked(dependencyFactory.makeCreateUiSpecDependencies)).toHaveBeenCalledTimes(1);
    expect(depsSpyState.returned.length).toBe(1);
    expect(deps).toBe(depsSpyState.returned[0]);
    // The factory was called with the injected reader and no adapter clock.
    expect(vi.mocked(dependencyFactory.makeCreateUiSpecDependencies).mock.calls[0]).toEqual([reader]);

    // The injected reader is forwarded VERBATIM (compared against the test's own
    // reader, not against the recorded argument).
    expect(deps.reader).toBe(reader);
    // The policy is the reader's `getById`, in both directions.
    expect(deps.resolveReferenceToken(RAW_TOKEN_REFUSED)).toBeUndefined();
    expect(deps.resolveReferenceToken("/Users/secret/corpus/images-private/leak.png")).toBeUndefined();
    // No adapter-supplied clock (the core's own `new Date()` default applies).
    expect(deps.now).toBeUndefined();
    expect(Object.keys(deps).sort()).toEqual(["reader", "resolveReferenceToken"]);
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

  it("projects modelExecutionState and nothing else over MCP", async () => {
    const fixture = modelFixture("succeeded");
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    const result = await handleCreateUiSpec(
      validArgs(),
      makeReader(corpus, corpus),
      undefined,
      fixture.dependency,
    );
    expect(spyState.produced[0]!.envelope.modelExecution?.state).toBe("succeeded");
    expect((result.structuredContent.data as { modelProposal?: unknown }).modelProposal).toBeDefined();
    expect((result.structuredContent as Record<string, unknown>).modelExecutionState).toBe("succeeded");
    expect((result.structuredContent as Record<string, unknown>).modelExecution).toBeUndefined();
  });

  it("projects modelExecutionState null on the error branch", async () => {
    const result = await handleCreateUiSpec(
      { ...validArgs(), productContext: "bad" }, // fails CreateUiSpecInput validation
      makeReader([], []),
    );
    expect((result.structuredContent as Record<string, unknown>).modelExecutionState).toBeNull();
    expect((result.structuredContent as Record<string, unknown>).status).toBe("error");
  });

  it("refuses an unknown top-level key through the shared gate", async () => {
    const result = await call();
    const payload = { ...(result.structuredContent as Record<string, unknown>), unknownKey: "x" };
    const gate = parseToolResult(payload);
    expect(gate.ok).toBe(false);
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
// 2b. Injected model outcomes stay bounded on the served MCP bytes
// ---------------------------------------------------------------------------

describe("create_ui_spec MCP registration — injected model outcome secrecy", () => {
  const states: readonly ModelFixtureState[] = [
    "not-configured",
    "invalid-configuration",
    "succeeded",
    "call-failed",
    "proposal-rejected",
    "persistence-failed",
  ];

  it.each(states)("serves bounded bytes for %s", async (state) => {
    const fixture = modelFixture(state);
    const corpus = [fixtureEntry("internal-1", "product-Alpha")];
    const result = await handleCreateUiSpec(validArgs(), makeReader(corpus, corpus), undefined, fixture.dependency);
    const produced = spyState.produced[0]!.envelope;

    expect(produced.modelExecution?.state).toBe(fixture.expectedExecution);
    expect(produced.spec.modelProposal !== undefined).toBe(state === "succeeded");

    const bytes = JSON.stringify(result);
    for (const marker of [
      MODEL_API_KEY,
      "/private/endpoint?account=47",
      MODEL_BASE_URL,
      MODEL_RAW_REJECTED_BODY,
      MODEL_STORE_PATH,
      "private-provider-request-id",
      ...(fixture.rawProviderBody === MODEL_RAW_SUCCESS_BODY ? [MODEL_RAW_SUCCESS_BODY] : []),
      ...BANNED,
    ]) {
      expect(bytes.includes(marker), `${state} leaked ${JSON.stringify(marker)}`).toBe(false);
    }
    expect(containsPrivateMarker(bytes)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2b. The dependency factory and the core request mapping
// ---------------------------------------------------------------------------

describe("create_ui_spec MCP registration — the one dependency factory and the core request", () => {
  it("the resolver returns a known id VERBATIM, so the ref-<sha256> digest is the caller's own token", async () => {
    // The positive direction of the policy. If the resolver ever normalized,
    // trimmed or repaired the token, the digest published in `citedReferences`
    // would stop being the digest of what the caller sent — a silent contract
    // break the negative direction cannot see.
    const reader = makeReader([fixtureEntry(RAW_TOKEN_RESOLVED, "product-Alpha")], []);
    await handleCreateUiSpec(validArgs({ referenceIds: [RAW_TOKEN_RESOLVED] }), reader);
    const [, dependencies] = vi.mocked(core.createUiSpecForAdapter).mock.calls[0]!;
    const deps = dependencies as unknown as { resolveReferenceToken: (t: string) => string | undefined };
    expect(deps.resolveReferenceToken(RAW_TOKEN_RESOLVED)).toBe(RAW_TOKEN_RESOLVED);
  });

  /**
   * Every optional core-request field populated with a valid value. The point of
   * the test below is COMPLETENESS: the adapter maps the core request field by
   * field (deliberately — a spread would let a future MCP-only field reach the
   * core's strict schema), which trades a spread's automatic completeness for a
   * hand-maintained list. Without this test, deleting the `platform` /
   * `designSystem` / `target` lines leaves the whole suite green and a caller's
   * `platform: "mobile"` is silently dropped — the caller gets a confidently wrong
   * spec with no warning.
   */
  const FULL_TRANSPORT_ARGS: Record<string, unknown> = {
    productContext: "A calm analytics dashboard for a fintech",
    referenceIds: [RAW_TOKEN_RESOLVED],
    platform: "mobile",
    implementationFramework: "SwiftUI",
    designSystem: { status: "identified", library: "material-3" },
    constraints: ["single column below 640px", "no dark mode in v1"],
    target: "astro-react",
    motionIntents: [{
      id: "card-press",
      trigger: "press",
      properties: ["opacity", "transform"],
      durationToken: "motion.duration.short",
      easingToken: "motion.easing.standard",
      interruptible: true,
      reducedMotion: "no-transform",
    }],
    colorIntent: { accentPreference: "muted teal", mood: "calm", contrastFloor: "AA" },
    typeIntent: { voice: "plainspoken", density: "compact" },
    outputFormat: "json",
  };

  it("forwards EVERY core request field, and only those, to the producer", async () => {
    const reader = makeReader([fixtureEntry(RAW_TOKEN_RESOLVED, "product-Alpha")], []);
    await handleCreateUiSpec(FULL_TRANSPORT_ARGS, reader);
    const [request] = vi.mocked(core.createUiSpecForAdapter).mock.calls[0]!;
    const recorded = request as Record<string, unknown>;

    // Value fidelity: the forwarded request deep-equals the parsed transport input
    // with ONLY the adapter-local presentation field removed. Nothing renamed,
    // nothing defaulted differently, nothing dropped.
    const parsed = CreateUiSpecInput.parse(FULL_TRANSPORT_ARGS) as Record<string, unknown>;
    const { outputFormat: _dropped, ...expected } = parsed;
    expect(recorded).toEqual(expected);

    // COMPLETENESS, derived from the core schema rather than from a second
    // hand-written list: with every optional field supplied, the forwarded key set
    // must be exactly the core request schema's own key set. Add a field to both
    // schemas and forget the mapping line, and this is what goes red.
    expect(Object.keys(recorded).sort()).toEqual(
      Object.keys(CreateUiSpecRequestSchema.shape).sort(),
    );
    // …and `outputFormat` is still not among them.
    expect(Object.keys(recorded)).not.toContain("outputFormat");
  });

  it("omits an optional core field entirely when the caller did not supply it", async () => {
    // The other half of the mapping: the adapter must not materialize
    // `platform: undefined` (the core schema is `.strict()` and an explicit
    // undefined key changes what `Object.keys` reports downstream).
    const reader = makeReader([], []);
    await handleCreateUiSpec(validArgs(), reader);
    const [request] = vi.mocked(core.createUiSpecForAdapter).mock.calls[0]!;
    expect(Object.keys(request as Record<string, unknown>).sort()).toEqual(
      ["constraints", "motionIntents", "productContext", "referenceIds"],
    );
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

  it("refuses to serve an ERROR envelope that violates the gate (the error branch is gated too)", async () => {
    // The error branch has its own `assertPassesContractGate` call inside
    // `errorResult`, and until this test it was UNPINNED: deleting that call left
    // the entire suite green (Task 3 review, perturbation P3). Running
    // `parseToolResult` over the envelope in `expectStandardErrorEnvelope` proves
    // the envelope is gate-VALID; it does not prove the adapter would refuse an
    // invalid one.
    //
    // To exercise the refusal, the mapped envelope has to violate a gate rule. The
    // reachable lever is the shared `ERROR_RETRYABLE` table the adapter reads at
    // call time: the descriptor's error schema is a union of per-code LITERAL
    // variants, so `INVALID_INPUT` + `retryable: true` is a contradiction the gate
    // rejects. Mutating the shared table is heavy-handed, so it is restored in a
    // `finally` and the restoration is re-verified by a real call below.
    //
    // This mutate-then-restore pattern is only safe under two invariants this
    // file does not otherwise state: (1) tests within a file run SERIALLY
    // (vitest.config.ts documents this, and nothing here uses `.concurrent`),
    // so no other test can observe the table between the mutation and the
    // `finally`; and (2) vitest isolates the module graph PER FILE, so the
    // mutation cannot bleed into other test files. If this file ever adds
    // `.concurrent` or a config flip sets `isolate: false`, this test would
    // need a different lever — the window described here would become real.
    const original = ERROR_RETRYABLE.INVALID_INPUT;
    expect(original).toBe(false);
    let message = "";
    try {
      ERROR_RETRYABLE.INVALID_INPUT = true;
      await handleCreateUiSpec(validArgs({ referenceIds: [RAW_TOKEN_REFUSED] }), makeReader([], []));
      throw new Error("expected the error envelope to be REFUSED by the gate, but it was served");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    } finally {
      ERROR_RETRYABLE.INVALID_INPUT = original!;
    }
    expect(message).toMatch(/create_ui_spec result failed the contract gate/);
    // The refusal names positions only — no offending value, no caller brief, no
    // refused token.
    expect(message).not.toContain(RAW_TOKEN_REFUSED);
    expect(message).not.toContain("analytics dashboard for a fintech");

    // The table is restored: the same call now yields the normal typed envelope.
    const restored = (await handleCreateUiSpec(
      validArgs({ referenceIds: [RAW_TOKEN_REFUSED] }),
      makeReader([], []),
    )) as McpResult;
    expect(restored.structuredContent.error).toMatchObject({ code: "INVALID_INPUT", retryable: false });
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
    // Pinned to the RENDERING screen specifically. The earlier alternation
    // (`…contract gate|…rendering`) did not say which screen refused, so it would
    // have stayed green if the rendering screen were deleted and the leaf gate
    // happened to refuse for an unrelated reason.
    await expect(handleCreateUiSpec(validArgs(), makeReader([], []))).rejects.toThrow(
      /create_ui_spec rendering carried a private corpus marker/,
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

// ===========================================================================
// 6. OVER A REAL MCP TRANSPORT — the ACTUALLY REGISTERED tool (Task 4)
// ===========================================================================
//
// Everything above calls `handleCreateUiSpec` directly. That proves the adapter
// function, not the SERVED tool: it skips `registerCreateUiSpec`, the SDK's own
// input normalization, the JSON-RPC round trip, and JSON serialization of the
// envelope. This section closes that gap by driving the tool the way a client
// does — `createServer(reader)` → `InMemoryTransport.createLinkedPair()` → a real
// MCP `Client` → `client.callTool({ name: "create_ui_spec", … })`.
//
// TWO PROPERTIES THIS LAYER ADDS THAT A DIRECT CALL CANNOT:
//  1. The tool is reachable under its registered name from `createServer`. A
//     rename, a missing registration, or a schema the SDK cannot normalize fails
//     here and nowhere else in this file.
//  2. The response survives JSON serialization. `structuredContent` crosses the
//     wire as JSON, so an `undefined`, a `Date`, a `Buffer` or a non-enumerable
//     field would change shape in transit. The gate runs BEFORE serialization, so
//     only a transport test can observe what the caller actually receives.
//
// RETRIEVAL STATES ARE DRIVEN BY REAL FIXTURE CONDITIONS, NOT BY HAND. The
// reader below runs the REAL `keywordSearch` scorer from corpus.ts over real
// fixture entries (exactly as `PublicCorpusReader.searchRanked` does), so:
//   - `keyword/metadata` comes from a productContext whose terms genuinely score
//     against the fixture entries;
//   - `structured-fallback/metadata` + `no-results` comes from a NON-EMPTY corpus
//     and a productContext whose terms genuinely score nothing (stronger than an
//     empty corpus: it proves the query ran and had no hits, which is exactly
//     what `fallbackReason: "no-results"` claims);
//   - `none/none` comes from real `getById` resolution of a caller-supplied
//     token.
// No `retrieval` object is constructed by any test in this section.

/**
 * A FULL-SHAPE fixture entry. `fixtureEntry` above carries `visual: {}`, which is
 * enough for the hand-wired `searchRanked` stub but NOT for the real
 * `keywordSearch` scorer (it reads `visual.dominantColors`,
 * `visual.typePairing.display`, …). This variant is what makes the real scorer
 * usable, and it keeps every private marker from `fixtureEntry` so a leak through
 * the served response is still unambiguous.
 */
function keywordFixtureEntry(id: string, productName: string, patternType: string = "dashboard"): CorpusEntryT {
  const record = {
    method: "image-confirmed",
    verifiedAt: "2026-08-04",
    verifierVersion: "mcp-fixture",
    imageSha256: "a".repeat(64),
  };
  const verification: Record<string, unknown> = {};
  for (const key of SERVABLE_FIELD_KEYS) verification[key] = record;
  return {
    ...fixtureEntry(id, productName),
    provenance: { taggedBy: "auto", verification },
    patternType,
    domainTags: ["analytics"],
    visual: {
      dominantColors: ["#ffffff", "#101010"],
      accentColor: "#635bff",
      typePairing: { display: "Inter", body: "Inter", notes: "" },
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
      usesShadows: false,
      usesBorders: true,
    },
  } as unknown as CorpusEntryT;
}

/**
 * A reader whose search is the REAL keyword scorer over `corpus`. Structural
 * filters then scoring then descending sort — the same two shared helpers
 * `PublicCorpusReader` uses, so match/zero-match is decided by production code,
 * not by a stub returning a canned list.
 */
function makeRealKeywordReader(
  corpus: CorpusEntryT[],
  over: Partial<Record<keyof CorpusReader, unknown>> = {},
): CorpusReader {
  const ranked = (opts: SearchOptions): SearchResult[] =>
    keywordSearch(applyStructuralFilters(corpus, opts), opts).sort((a, b) => b.score - a.score);
  return makeReader(corpus, [], {
    search: vi.fn(async (opts: SearchOptions) => ranked(opts).slice(0, opts.limit ?? 5).map((r) => r.entry)),
    searchRanked: vi.fn(async (opts: SearchOptions) => ranked(opts)),
    ...over,
  });
}

/** A productContext whose terms genuinely score against the fixture entries. */
const MATCHING_CONTEXT = "A calm analytics dashboard for a fintech team";
/**
 * A productContext whose terms genuinely score NOTHING against the fixture
 * entries. Every term is nonsense: it appears in no title, category, styleTag,
 * component, domainTag, visual field, critique, whatToSteal or productName, so
 * `keywordSearch` returns zero rows and the producer reaches its real
 * structured-fallback state.
 */
const NON_MATCHING_CONTEXT = "Zyrblex qwintaph vundrelic morvath keplunx";

/** The opaque public citation the core derives from a caller token. */
function expectedPublicReference(token: string): string {
  return `ref-${createHash("sha256").update(Buffer.from(token.trim(), "utf-8")).digest("hex")}`;
}

interface TransportResult {
  content?: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** Open sockets are closed in afterAll so a leaked client cannot hang the run. */
const openClients: Client[] = [];

/**
 * Connect a real MCP client to a real server built by `createServer(reader)`.
 * Returns a `callCreateUiSpec` bound to the registered tool NAME — nothing here
 * can reach the handler except through the registration.
 */
async function connectTransport(reader: CorpusReader): Promise<{
  client: Client;
  callCreateUiSpec: (args: Record<string, unknown>) => Promise<TransportResult>;
  callByName: (name: string, args: Record<string, unknown>) => Promise<TransportResult>;
  listToolNames: () => Promise<string[]>;
}> {
  const server = createServer(reader);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "create-ui-spec-transport-test", version: "0.0.0" });
  openClients.push(client);
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const callByName = async (name: string, args: Record<string, unknown>): Promise<TransportResult> =>
    (await client.callTool({ name, arguments: args })) as TransportResult;
  return {
    client,
    callByName,
    callCreateUiSpec: (args) => callByName("create_ui_spec", args),
    listToolNames: async () => (await client.listTools()).tools.map((t) => t.name),
  };
}

afterAll(async () => {
  for (const client of openClients) {
    try { await client.close(); } catch { /* best effort */ }
  }
  openClients.length = 0;
});

/** The text surface only — `content[*].text` joined, never structuredContent. */
function contentText(resp: TransportResult): string {
  return (resp.content ?? []).map((c) => (typeof c.text === "string" ? c.text : "")).join("\n");
}

/** The structured surface only — never `content`. */
function structuredText(resp: TransportResult): string {
  return resp.structuredContent === undefined ? "" : JSON.stringify(resp.structuredContent);
}

/**
 * Assert every banned marker is absent from BOTH served surfaces, checked
 * SEPARATELY. A combined scan would let a leak in one surface be reported against
 * the other, and `content` is the one surface the leaf gate does not walk — so the
 * two must be asserted independently or the weaker surface hides behind the
 * stronger one.
 */
function expectBothSurfacesClean(resp: TransportResult, context: string, banned: readonly string[] = BANNED): void {
  const surfaces: Array<[string, string]> = [
    ["content", contentText(resp)],
    ["structuredContent", structuredText(resp)],
  ];
  for (const [surface, text] of surfaces) {
    for (const marker of banned) {
      expect(text.includes(marker), `${context}: leaked "${marker}" through ${surface}`).toBe(false);
    }
    expect(containsPrivateMarker(text), `${context}: private marker in ${surface}`).toBe(false);
  }
}

describe("create_ui_spec over a real MCP transport — the registered tool", () => {
  it("is discoverable in tools/list under its registered name, and generate_design_prompt is not", async () => {
    const t = await connectTransport(makeRealKeywordReader([]));
    const names = await t.listToolNames();
    expect(names).toContain("create_ui_spec");
    expect(names).not.toContain("generate_design_prompt");
    expect(names.length).toBe(14);
  });

  // ── retrieval state 1: real keyword matches ───────────────────────────────
  it("automatic keyword retrieval: keyword/metadata, truthful counts, response-scoped evidence, safe output", async () => {
    const corpus = [
      keywordFixtureEntry("internal-1", "product-Alpha", "dashboard"),
      keywordFixtureEntry("internal-2", "product-Bravo", "forms"),
    ];
    const reader = makeRealKeywordReader(corpus);
    const t = await connectTransport(reader);
    const resp = await t.callCreateUiSpec({ productContext: MATCHING_CONTEXT });

    expect(resp.isError).toBeFalsy();
    // The state is the PRODUCER's, and the producer got it from the real scorer:
    // the reader really was queried and really returned rows.
    expect(vi.mocked(reader.searchRanked)).toHaveBeenCalledTimes(1);
    const produced = spyState.produced[0]!;
    expect(produced.envelope.retrieval.mode).toBe("keyword");
    expect((await reader.searchRanked({ query: MATCHING_CONTEXT, limit: 20 })).length).toBe(2);

    const env = resp.structuredContent!;
    const retrieval = env.retrieval as Record<string, unknown>;
    expect(retrieval.mode).toBe("keyword");
    expect(retrieval.modality).toBe("metadata");
    expect(retrieval.fallbackUsed).toBe(false);
    expect(retrieval.fallbackReason).toBeUndefined();
    expect(retrieval.attemptedCount).toBe(0);
    expect(retrieval.attemptedModes).toEqual([]);
    // TRUTHFUL COUNTS, two different meanings, both checked:
    //  - the transport `resultCount` is the ARTIFACT count the descriptor
    //    documents (1 complete spec), through the ONE shared projection;
    //  - the producer's own corpus-observation count is 2 (the real match count),
    //    and it is NOT overwritten in the envelope.
    expect(retrieval.resultCount).toBe(1);
    expect(produced.envelope.retrieval.resultCount).toBe(2);
    expect(retrieval).toEqual(projectRetrievalStateForTransport(produced.envelope));

    // RESPONSE-SCOPED evidence: evidence-1 is the recipe/system row, evidence-2..3
    // are the two real matches. Ids are a dense evidence-N sequence scoped to this
    // response — never a corpus id, never a ref-<sha256>.
    const evidence = env.evidence as Array<Record<string, unknown>>;
    expect(evidence.length).toBe(3);
    expect(evidence.map((e) => e.id)).toEqual(["evidence-1", "evidence-2", "evidence-3"]);
    for (const row of evidence) {
      expect(row.referenceId).toBeUndefined(); // no explicit references in this state
      expect(String(row.summary).length).toBeGreaterThan(0);
    }
    // Automatic retrieval cites no explicit reference.
    expect(env.referenceIds).toEqual([]);
    expect(env.status).toBe("ok");
    expect(env.tool).toBe("create_ui_spec");
    expect(parseToolResult(env).ok).toBe(true);
    expectBothSurfacesClean(resp, "keyword state");
  });

  // ── retrieval state 2: real zero matches ──────────────────────────────────
  it("zero matches: structured-fallback/metadata, fallbackUsed, no-results, attempted keyword, deterministic warning", async () => {
    // A NON-EMPTY corpus with a query that genuinely scores nothing. This is the
    // condition `fallbackReason: "no-results"` asserts — the index was queried and
    // simply had no hits — so it must be driven that way, not by an empty reader.
    const corpus = [
      keywordFixtureEntry("internal-1", "product-Alpha"),
      keywordFixtureEntry("internal-2", "product-Bravo"),
    ];
    const reader = makeRealKeywordReader(corpus);
    const t = await connectTransport(reader);

    // Precondition, proved with the real scorer rather than assumed: this corpus
    // is non-empty AND this query scores zero rows against it.
    expect((await reader.searchRanked({ query: MATCHING_CONTEXT, limit: 20 })).length).toBe(2);
    expect((await reader.searchRanked({ query: NON_MATCHING_CONTEXT, limit: 20 })).length).toBe(0);

    const resp = await t.callCreateUiSpec({ productContext: NON_MATCHING_CONTEXT });
    expect(resp.isError).toBeFalsy();

    const env = resp.structuredContent!;
    const retrieval = env.retrieval as Record<string, unknown>;
    expect(retrieval.mode).toBe("structured-fallback");
    expect(retrieval.modality).toBe("metadata");
    expect(retrieval.fallbackUsed).toBe(true);
    expect(retrieval.fallbackReason).toBe("no-results");
    expect(retrieval.attemptedModes).toEqual(["keyword"]);
    expect(retrieval.attemptedCount).toBe(1);
    // A complete artifact still exists, so the ARTIFACT count is 1 even though
    // zero corpus observations were retrieved (the producer's own count is 0).
    expect(retrieval.resultCount).toBe(1);
    expect(spyState.produced[0]!.envelope.retrieval.resultCount).toBe(0);

    // The DETERMINISTIC fallback warning, copied from the producer verbatim.
    const warnings = env.warnings as Array<{ code: string; message: string }>;
    expect(warnings.map((w) => w.code)).toContain("sparseCoverage");
    expect(warnings).toEqual(
      spyState.produced[0]!.envelope.warnings.map((w) => ({ code: w.code, message: w.message })),
    );
    const sparse = warnings.find((w) => w.code === "sparseCoverage")!;
    expect(sparse.message).toContain("zero matches");
    expect(sparse.message).toContain("deterministic fallback");

    // The corpus is NOT cited: only the recipe/system row is emitted.
    const evidence = env.evidence as Array<Record<string, unknown>>;
    expect(evidence.length).toBe(1);
    expect(evidence[0]!.id).toBe("evidence-1");
    expect(env.referenceIds).toEqual([]);
    expect(parseToolResult(env).ok).toBe(true);
    expectBothSurfacesClean(resp, "structured-fallback state");
  });

  // ── retrieval state 3: real explicit references ───────────────────────────
  it("explicit references: none/none, safe public reference ids, no evidence-N in a reference position", async () => {
    const reader = makeRealKeywordReader([
      keywordFixtureEntry(RAW_TOKEN_RESOLVED, "product-Alpha"),
      keywordFixtureEntry("internal-1", "product-Bravo"),
    ]);
    const t = await connectTransport(reader);
    const resp = await t.callCreateUiSpec({
      productContext: MATCHING_CONTEXT,
      referenceIds: [RAW_TOKEN_RESOLVED],
    });

    expect(resp.isError).toBeFalsy();
    const env = resp.structuredContent!;
    const retrieval = env.retrieval as Record<string, unknown>;
    expect(retrieval.mode).toBe("none");
    expect(retrieval.modality).toBe("none");
    expect(retrieval.fallbackUsed).toBe(false);
    expect(retrieval.attemptedCount).toBe(0);
    expect(retrieval.attemptedModes).toEqual([]);
    // Explicit references SUPPRESS automatic retrieval entirely — the reader's
    // search is never consulted even though this corpus would have matched.
    expect(vi.mocked(reader.searchRanked)).not.toHaveBeenCalled();

    // SAFE PUBLIC REFERENCE IDS: the opaque digest of the caller's own token, in
    // a domain disjoint from evidence-N.
    expect(env.referenceIds).toEqual([expectedPublicReference(RAW_TOKEN_RESOLVED)]);
    for (const ref of env.referenceIds as string[]) {
      expect(ref).toMatch(/^ref-[0-9a-f]{64}$/);
      expect(ref).not.toMatch(/^evidence-/);
    }
    // The reference row carries the digest; the recipe row carries none. No
    // evidence id ever appears in a referenceId position and vice versa.
    const evidence = env.evidence as Array<Record<string, unknown>>;
    expect(evidence.length).toBe(2);
    expect(evidence[0]!.id).toBe("evidence-1");
    expect(evidence[0]!.referenceId).toBeUndefined();
    expect(evidence[1]!.id).toBe("evidence-2");
    expect(evidence[1]!.kind).toBe("public-reference");
    expect(evidence[1]!.referenceId).toBe(expectedPublicReference(RAW_TOKEN_RESOLVED));
    const evidenceIds = new Set(evidence.map((e) => String(e.id)));
    for (const ref of env.referenceIds as string[]) expect(evidenceIds.has(ref)).toBe(false);

    expect(parseToolResult(env).ok).toBe(true);
    expectBothSurfacesClean(resp, "explicit-reference state");
  });

  it("explicit references are bounded: five resolve, a sixth is refused before the handler runs", async () => {
    // Deliberately NOT named `ref-a`…`ref-f`: those are substrings of the served
    // `ref-<sha256>` digests, so the raw-token leak scan below would fire on the
    // legitimate citation. A token must be distinguishable from its own digest for
    // the scan to mean anything.
    const tokens = [
      "bounded-token-one", "bounded-token-two", "bounded-token-three",
      "bounded-token-four", "bounded-token-five", "bounded-token-six",
    ];
    const reader = makeRealKeywordReader(tokens.map((t, i) => keywordFixtureEntry(t, `product-${i}`)));
    const t = await connectTransport(reader);

    const five = await t.callCreateUiSpec({
      productContext: MATCHING_CONTEXT,
      referenceIds: tokens.slice(0, 5),
    });
    expect(five.isError).toBeFalsy();
    expect(five.structuredContent!.referenceIds).toEqual(tokens.slice(0, 5).map(expectedPublicReference));
    // 1 recipe row + 5 reference rows.
    expect((five.structuredContent!.evidence as unknown[]).length).toBe(6);
    expectBothSurfacesClean(five, "five explicit references", [
      ...BANNED, ...tokens,
    ]);

    // Six exceeds the declared max(5). The SDK's own normalization refuses it
    // before the handler is entered, so the producer is never invoked.
    spyState.produced.length = 0;
    vi.mocked(core.createUiSpecForAdapter).mockClear();
    const six = await t.callCreateUiSpec({ productContext: MATCHING_CONTEXT, referenceIds: tokens });
    expect(six.isError).toBe(true);
    expect(vi.mocked(core.createUiSpecForAdapter)).not.toHaveBeenCalled();
    expect(spyState.produced.length).toBe(0);
  });

  it("a missing identity is never automatically replaced — an all-unresolvable list is rejected, not substituted", async () => {
    // The corpus WOULD have matched MATCHING_CONTEXT, so a silent substitution
    // would look like a successful spec. It must not happen: the request is
    // rejected instead.
    const reader = makeRealKeywordReader([
      keywordFixtureEntry("internal-1", "product-Alpha"),
      keywordFixtureEntry("internal-2", "product-Bravo"),
    ]);
    const t = await connectTransport(reader);
    const resp = await t.callCreateUiSpec({
      productContext: MATCHING_CONTEXT,
      referenceIds: [RAW_TOKEN_REFUSED],
    });

    expect(resp.isError).toBe(true);
    const env = resp.structuredContent!;
    expect(env.status).toBe("error");
    expect(env.data).toBe(null);
    expect(env.referenceIds).toEqual([]);
    expect(env.evidence).toEqual([]);
    expect(env.error).toMatchObject({ code: "INVALID_INPUT", retryable: false });
    // Automatic retrieval was NOT run as a fallback for the unresolvable token.
    expect(vi.mocked(reader.searchRanked)).not.toHaveBeenCalled();
    expectBothSurfacesClean(resp, "all-unresolvable references");
  });

  it("a partially resolvable list omits the refused token and still cites only the resolved one", async () => {
    const reader = makeRealKeywordReader([keywordFixtureEntry(RAW_TOKEN_RESOLVED, "product-Alpha")]);
    const t = await connectTransport(reader);
    const resp = await t.callCreateUiSpec({
      productContext: MATCHING_CONTEXT,
      referenceIds: [RAW_TOKEN_RESOLVED, RAW_TOKEN_REFUSED],
    });
    expect(resp.isError).toBeFalsy();
    expect(resp.structuredContent!.referenceIds).toEqual([expectedPublicReference(RAW_TOKEN_RESOLVED)]);
    // No per-token outcome channel at any depth of the served envelope.
    for (const key of collectKeys(resp.structuredContent))
      expect(key, `refused-token channel key "${key}"`).not.toMatch(/omit|refus|unresolv/i);
    expectBothSurfacesClean(resp, "partially resolvable references");
  });

  // ── both output formats, byte equality from the SAME invocation ────────────
  describe.each([
    { format: "markdown" as const, field: "designMarkdown" as const },
    { format: "json" as const, field: "designJson" as const },
  ])("outputFormat $format over the transport", ({ format, field }) => {
    it.each([
      { label: "keyword", context: MATCHING_CONTEXT, args: {} as Record<string, unknown> },
      { label: "structured-fallback", context: NON_MATCHING_CONTEXT, args: {} as Record<string, unknown> },
      { label: "explicit-reference", context: MATCHING_CONTEXT, args: { referenceIds: [RAW_TOKEN_RESOLVED] } },
    ])(`content[0] is byte-identical to envelope.${field} from the SAME invocation ($label state)`, async ({ context, args }) => {
      const reader = makeRealKeywordReader([
        keywordFixtureEntry(RAW_TOKEN_RESOLVED, "product-Alpha"),
        keywordFixtureEntry("internal-1", "product-Bravo"),
      ]);
      const t = await connectTransport(reader);
      const resp = await t.callCreateUiSpec({ productContext: context, outputFormat: format, ...args });

      // ONE producer invocation for this call, so "the same invocation" is not
      // ambiguous. The comparison target is the envelope object THAT invocation
      // returned, captured by the spy — NOT a separately computed rendering. A
      // fresh call would carry a different `generatedAt`, so re-rendering and
      // comparing would prove nothing about what was served.
      expect(spyState.produced.length).toBe(1);
      const envelope = spyState.produced[0]!.envelope;

      expect(resp.content!.length).toBe(1);
      expect(resp.content![0]!.type).toBe("text");
      expect(resp.content![0]!.text).toBe(envelope[field]);
      // Byte-for-byte, not merely "equal after normalization": same length, same
      // trailing whitespace, same code units.
      expect(resp.content![0]!.text!.length).toBe(envelope[field].length);
      expect(Buffer.from(resp.content![0]!.text!, "utf-8").equals(Buffer.from(envelope[field], "utf-8"))).toBe(true);
      // The OTHER rendering is not what was served (the two differ, and the
      // format selection is real).
      const other = field === "designMarkdown" ? envelope.designJson : envelope.designMarkdown;
      expect(envelope.designMarkdown).not.toBe(envelope.designJson);
      expect(resp.content![0]!.text).not.toBe(other);
      // json really is JSON, markdown really is not.
      if (format === "json") {
        expect(() => JSON.parse(resp.content![0]!.text!)).not.toThrow();
      }
      expectBothSurfacesClean(resp, `outputFormat ${format}`);
    });

    it("the structured envelope is identical across formats except for nothing at all", async () => {
      // `outputFormat` is presentation-only: it must change `content[0]` and
      // NOTHING in `structuredContent`. Compared against the same-state markdown
      // call with `provenance.generatedAt` normalized (the only field that legally
      // differs between two invocations).
      const readerFor = (): CorpusReader => makeRealKeywordReader([
        keywordFixtureEntry("internal-1", "product-Alpha"),
      ]);
      const md = await (await connectTransport(readerFor())).callCreateUiSpec({
        productContext: MATCHING_CONTEXT, outputFormat: "markdown",
      });
      const other = await (await connectTransport(readerFor())).callCreateUiSpec({
        productContext: MATCHING_CONTEXT, outputFormat: format,
      });
      const strip = (resp: TransportResult): string => {
        const clone = JSON.parse(JSON.stringify(resp.structuredContent)) as {
          data: { provenance: Record<string, unknown> };
        };
        clone.data.provenance.generatedAt = "NORMALIZED";
        return JSON.stringify(clone);
      };
      expect(strip(other)).toBe(strip(md));
    });
  });

  // ── failure paths ─────────────────────────────────────────────────────────
  it("reader failure: retryable PROVIDER_ERROR with no raw exception text and no leaked request text", async () => {
    const RAW_EXCEPTION = "ENOENT: no such file or directory, open '/Users/secret/corpus/images-private/index.json'";
    const reader = makeRealKeywordReader([keywordFixtureEntry("internal-1", "product-Alpha")], {
      searchRanked: vi.fn(async () => { throw new Error(RAW_EXCEPTION); }),
    });
    const t = await connectTransport(reader);
    const resp = await t.callCreateUiSpec({ productContext: MATCHING_CONTEXT });

    expect(resp.isError).toBe(true);
    const env = resp.structuredContent!;
    expect(env.status).toBe("error");
    expect(env.data).toBe(null);
    // CORRECT RETRYABILITY: a transient dependency failure is retryable, and the
    // code↔retryable pair comes from the shared table.
    expect(env.error).toMatchObject({ code: "PROVIDER_ERROR", retryable: true });
    expect(parseToolResult(env).ok).toBe(true);

    // NO RAW EXCEPTION TEXT, on either surface, at any granularity.
    const both = `${contentText(resp)}\n${structuredText(resp)}`;
    for (const fragment of [
      RAW_EXCEPTION, "ENOENT", "/Users/secret", "images-private", "index.json",
      "no such file", "Error:", "at Object.", "node_modules",
    ]) expect(both.includes(fragment), `leaked exception fragment "${fragment}"`).toBe(false);

    // NO LEAKED REQUEST/BRIEF TEXT: the caller's own words are not echoed back
    // (an error message that quotes the brief is a log-injection and a
    // confused-deputy surface, and it is not needed to act on the error).
    expect(both).not.toContain(MATCHING_CONTEXT);
    expect(both).not.toContain("analytics dashboard for a fintech");
    expectBothSurfacesClean(resp, "reader failure");

    // The message is bounded and free of paths/urls.
    const message = (env.error as { message: string }).message;
    expect(message.length).toBeGreaterThan(0);
    expect(message.length).toBeLessThanOrEqual(500);
    expect(message).not.toMatch(/:\/\/|[/\\]/);
  });

  it("reader failure during explicit-reference resolution is also a safe retryable PROVIDER_ERROR", async () => {
    // The second reader route the producer uses: getById, not searchRanked.
    const reader = makeRealKeywordReader([], {
      getById: vi.fn(() => { throw new Error("EACCES: /Users/secret/corpus/entries.json"); }),
    });
    const t = await connectTransport(reader);
    const resp = await t.callCreateUiSpec({
      productContext: MATCHING_CONTEXT,
      referenceIds: [RAW_TOKEN_RESOLVED],
    });
    expect(resp.isError).toBe(true);
    expect(resp.structuredContent!.error).toMatchObject({ code: "PROVIDER_ERROR", retryable: true });
    const both = `${contentText(resp)}\n${structuredText(resp)}`;
    for (const fragment of ["EACCES", "/Users/secret", "entries.json"])
      expect(both.includes(fragment), `leaked exception fragment "${fragment}"`).toBe(false);
    expect(both).not.toContain(RAW_TOKEN_RESOLVED);
  });

  it("schema-invalid input is intercepted by the SDK before the handler, and the producer never runs", async () => {
    // DOCUMENTED, NOT ASPIRATIONAL: `inputSchema` is declared, so the SDK
    // validates `arguments` and throws before `handleCreateUiSpec` is entered.
    // Over a transport the adapter's typed INVALID_INPUT envelope therefore covers
    // the CORE-level case (all references unresolvable — asserted above), not
    // schema violations. Asserting a typed envelope here would be asserting a
    // behavior the transport makes impossible; what IS assertable is that the call
    // fails, the producer is not reached, and no corpus content appears.
    const reader = makeRealKeywordReader([keywordFixtureEntry("internal-1", "product-Alpha")]);
    const t = await connectTransport(reader);
    for (const bad of [
      { productContext: "short" },
      { productContext: MATCHING_CONTEXT, unexpectedField: true },
      { productContext: MATCHING_CONTEXT, outputFormat: "yaml" },
      { productContext: MATCHING_CONTEXT, referenceIds: [RAW_TOKEN_REFUSED, RAW_TOKEN_REFUSED] },
      {},
    ]) {
      spyState.produced.length = 0;
      vi.mocked(core.createUiSpecForAdapter).mockClear();
      const resp = await t.callCreateUiSpec(bad);
      expect(resp.isError, `expected refusal for ${JSON.stringify(bad)}`).toBe(true);
      expect(vi.mocked(core.createUiSpecForAdapter)).not.toHaveBeenCalled();
      expect(spyState.produced.length).toBe(0);
      // The SDK's message may echo the caller's own field names — that is the
      // caller's input, not a disclosure. No CORPUS content may appear.
      expectBothSurfacesClean(resp, `schema-invalid ${JSON.stringify(bad)}`, [
        "private-corpus-id", "images-private/", "internal-1", "product-Alpha",
        "https://private.example.com/secret", "secret.png",
        "critique prose must never leak", "stealable prose",
      ]);
    }
  });

  it("a gate-refused payload fails the call without serving it, and leaks nothing in the refusal", async () => {
    // The gate refusal is a THROW inside the handler; the SDK converts it to an
    // isError result whose text is the thrown message. Over the transport that
    // message becomes tool output, so it must name positions only.
    const poison = "/Users/secret/corpus/images-private/leak.png";
    spyState.mutate = (result) => ({
      ...result,
      envelope: {
        ...result.envelope,
        spec: { ...result.envelope.spec, citedReferences: [poison] },
      },
    });
    const t = await connectTransport(makeRealKeywordReader([keywordFixtureEntry("internal-1", "product-Alpha")]));
    const resp = await t.callCreateUiSpec({ productContext: MATCHING_CONTEXT });

    expect(resp.isError).toBe(true);
    // Nothing was served: no structured envelope reached the caller at all.
    expect(resp.structuredContent).toBeUndefined();
    const text = contentText(resp);
    expect(text).toContain("failed the contract gate");
    expect(text).not.toContain(poison);
    expect(text).not.toContain("images-private");
    expect(text).not.toContain(MATCHING_CONTEXT);
  });
});
