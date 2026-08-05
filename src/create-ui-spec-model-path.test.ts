import { readFile, readdir } from "node:fs/promises";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CorpusReader } from "./corpus-reader.js";
import { SERVABLE_FIELD_KEYS } from "./corpus-trust.js";
import { makeCreateUiSpecDependencies } from "./create-ui-spec-dependencies.js";
import {
  createUiSpecForAdapter,
  type CreateUiSpecDependencies,
} from "./create-ui-spec.js";
import {
  ModelGenerationParametersSchema,
  PinnedModelEndpointSchema,
  type ModelArtifactRecord,
} from "./create-ui-spec-model-contracts.js";
import type { CreateUiSpecModelRuntime } from "./create-ui-spec-model.js";
import { createFileModelArtifactStore, type ModelArtifactStore } from "./model-artifact-store.js";
import { sha256Hex } from "./readiness/contracts.js";
import type { CorpusEntryT } from "./schema.js";
import { UiSpec } from "./tool-contracts.js";

const FIXED_NOW = (): Date => new Date("2026-08-01T12:00:00.000Z");
const LATER_NOW = (): Date => new Date("2026-08-02T12:00:00.000Z");
const FIXED_DISCLAIMER = "Proposal only; not accepted into token authority.";

const REQUEST = {
  productContext: "A calm analytics dashboard for finance operators",
  referenceIds: [],
  constraints: ["Keep dense tables easy to scan."],
  motionIntents: [],
};

const PROPOSAL = {
  status: "proposal-only" as const,
  disclaimer: FIXED_DISCLAIMER,
  designDirection: "Use compact grouping, restrained emphasis, and stable alignment.",
  colorTokens: {
    primary: "#2563eb",
    surface: "#ffffff",
    ink: "#111827",
    muted: "#6b7280",
    accent: "#f59e0b",
  },
  typographyTokens: {
    heading: "Inter",
    body: "Inter",
    mono: "JetBrains Mono",
  },
  motionNotes: ["Keep transitions brief and interruptible."],
  contentVoiceGuidance: "Direct, calm, and operational.",
};

const tempRoots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeReader(): CorpusReader {
  return {
    search: vi.fn(async () => []),
    searchRanked: vi.fn(async () => []),
    getById: vi.fn(() => undefined),
    findSimilar: vi.fn(() => []),
    listCategories: vi.fn(() => []),
    listStyleTags: vi.fn(() => []),
    listDomainTags: vi.fn(() => []),
    indexStatus: vi.fn(() => ({
      indexed: 0,
      total: 0,
      hasIndex: false,
      missing: 0,
      stale: 0,
      contentStale: 0,
    })),
    entriesForAggregation: vi.fn(() => [] as readonly CorpusEntryT[]),
    resolveImagePath: vi.fn(() => null),
  } as unknown as CorpusReader;
}

function validModelResponse() {
  return {
    content: JSON.stringify(PROPOSAL),
    provider: "openai" as const,
    model: "gpt-5-mini",
    usage: {
      promptTokens: 123,
      completionTokens: 45,
      raw: { prompt_tokens: 123, completion_tokens: 45 },
    },
    attempts: 1,
    latencyMs: 17,
    providerRequestId: "req-private-provider-id",
  };
}

function makeRuntime(options: {
  call?: CreateUiSpecModelRuntime["call"];
  store?: ModelArtifactStore;
} = {}): CreateUiSpecModelRuntime {
  return {
    endpoint: PinnedModelEndpointSchema.parse({
      provider: "openai",
      baseUrl: "https://api.openai.com/v1/responses",
      apiKey: "runtime-secret-key",
      model: "gpt-5-mini",
    }),
    parameters: ModelGenerationParametersSchema.parse({
      temperature: 0,
      maxOutputTokens: 4096,
      maxAttempts: 1,
      seed: null,
    }),
    call: options.call ?? vi.fn(async () => validModelResponse()),
    store: options.store ?? memoryStore(),
  };
}

function memoryStore(): ModelArtifactStore {
  const records = new Map<string, ModelArtifactRecord>();
  return {
    save: vi.fn(async (record: ModelArtifactRecord) => {
      if (!records.has(record.artifactId)) records.set(record.artifactId, record);
    }),
    read: vi.fn(async (artifactId: string) => records.get(artifactId) ?? null),
    delete: vi.fn(async (artifactId: string) => records.delete(artifactId)),
  };
}

function dependencies(
  now: () => Date,
  model?: Parameters<typeof makeCreateUiSpecDependencies>[2],
): CreateUiSpecDependencies {
  return makeCreateUiSpecDependencies(makeReader(), now, model);
}

/** A reader whose ranked search returns 3 corpus observations with colorRoles. */
function rankedCorpusReader(): CorpusReader {
  const reader = makeReader();
  const entries = [
    { id: "internal-A", patternType: "dashboard" },
    { id: "internal-B", patternType: "data-table" },
    { id: "internal-C", patternType: "forms" },
  ].map(({ id, patternType }) => ({
    id,
    patternType,
    // Verified: this fixture's subject is the SERVING behaviour (no-model path
    // synthesizes, model path does not), so the C3 trust gate must let it
    // through. The gate's own refusal behaviour is covered by the
    // trust-gated-prompt-grounding suite below and by corpus-trust.test.ts.
    provenance: {
      taggedBy: "auto",
      verification: allKeysVerified(),
    },
    visual: {
      colorRoles: { canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: id === "internal-C" ? "#1d4ed8" : "#2563eb" },
      spacingDensity: "compact",
      cornerStyle: "slight-round",
      usesShadows: false,
      usesBorders: true,
      accentColor: "#2563eb",
      typePairing: { display: "Inter", body: "Inter" },
    },
  })) as unknown as CorpusEntryT[];
  (reader.searchRanked as ReturnType<typeof vi.fn>).mockResolvedValue(
    entries.map((entry, i) => ({ entry, score: 5 - i, searchMode: "keyword" })),
  );
  return reader;
}

async function deterministicBaseline() {
  return createUiSpecForAdapter(REQUEST, dependencies(FIXED_NOW));
}

function expectDeterministicIdentity(
  actual: Awaited<ReturnType<typeof createUiSpecForAdapter>>["envelope"],
  baseline: Awaited<ReturnType<typeof createUiSpecForAdapter>>["envelope"],
): void {
  expect(actual.spec).toEqual(baseline.spec);
  expect(actual.handoff).toEqual(baseline.handoff);
  expect(actual.designMarkdown).toBe(baseline.designMarkdown);
  expect(actual.designJson).toBe(baseline.designJson);
  expect(actual.specSha256).toBe(baseline.specSha256);
  expect(actual.designMarkdownSha256).toBe(baseline.designMarkdownSha256);
  expect(actual.designJsonSha256).toBe(baseline.designJsonSha256);
  expect(actual.semanticSpecSha256).toBe(baseline.semanticSpecSha256);
  expect(actual.artifactId).toBe(baseline.artifactId);
}

describe("createUiSpec proposal-only model path", () => {
  it("applies corpus synthesis on the no-model path but NOT on the model path", async () => {
    const noModel = await createUiSpecForAdapter(
      REQUEST,
      makeCreateUiSpecDependencies(rankedCorpusReader(), FIXED_NOW),
    );
    // (a) no-model: root direction cites the matched corpus ids and tokens are
    // populated from the accent plurality.
    expect(noModel.envelope.spec.designDirection).toContain("evidence-2");
    expect(noModel.envelope.spec.colorTokens).not.toBeNull();
    expect(noModel.envelope.spec.colorTokens?.primary).toBe("#2563eb");

    // (b) model-success with the SAME reader: root direction keeps the recipe
    // echo, root tokens stay null, and the proposal is the only direction
    // content — the whole synthesis object is gated on proposal === undefined.
    const withModel = await createUiSpecForAdapter(
      REQUEST,
      makeCreateUiSpecDependencies(rankedCorpusReader(), FIXED_NOW, {
        kind: "configured",
        runtime: makeRuntime(),
      }),
    );
    expect(withModel.envelope.spec.designDirection).toBe(REQUEST.productContext);
    expect(withModel.envelope.spec.colorTokens).toBeNull();
    expect(withModel.envelope.spec.typographyTokens).toBeNull();
    expect(withModel.envelope.spec.modelProposal?.status).toBe("proposal-only");
    // The corpusEvidence lane is populated for provenance, but nothing cites
    // the corpus on the model path (synthesis is gated off), so the handoff
    // must not print a "Grounded in corpus evidence" claim.
    expect(withModel.envelope.designMarkdown).not.toContain("Grounded in corpus evidence");
    expect(withModel.envelope.spec.citedDecisions.some((d) => d.authority === "corpus-evidence")).toBe(false);
  });

  it("keeps the deterministic envelope shape when no model runtime is configured", async () => {
    const baseline = await deterministicBaseline();
    const result = await createUiSpecForAdapter(
      REQUEST,
      dependencies(FIXED_NOW, { kind: "not-configured" }),
    );

    expectDeterministicIdentity(result.envelope, baseline.envelope);
    expect(result.envelope.modelExecution).toBeUndefined();
    expect(result.envelope.modelExecutionSha256).toBeUndefined();
  });

  it("integrates a valid proposal without granting token or evidence authority and persists only the validated artifact", async () => {
    const baseline = await deterministicBaseline();
    const root = mkdtempSync(join(tmpdir(), "create-ui-spec-model-path-"));
    tempRoots.push(root);
    const store = createFileModelArtifactStore(root);
    const runtime = makeRuntime({ store });
    const entriesPath = join(process.cwd(), "corpus", "entries.json");
    const corpusPath = existsSync(entriesPath)
      ? entriesPath
      : join(process.cwd(), "corpus", "seed.json");
    const corpusBefore = sha256Hex(await readFile(corpusPath));

    const result = await createUiSpecForAdapter(
      REQUEST,
      dependencies(FIXED_NOW, { kind: "configured", runtime }),
    );

    expect(result.envelope.spec.modelProposal?.status).toBe("proposal-only");
    expect(result.envelope.spec.colorTokens).toBeNull();
    expect(result.envelope.spec.typographyTokens).toBeNull();
    expect(result.envelope.spec.colorTokenAuthority).toBe("editorial");
    expect(result.envelope.spec.typographyTokenAuthority).toBe("editorial");
    expect(result.envelope.modelExecution).toMatchObject({
      state: "succeeded",
      provider: "openai",
      model: "gpt-5-mini",
      reproducibility: "conditional",
    });
    expect(result.envelope.modelExecutionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.sanitizedEvidence.every((e) => e.kind !== "model-output")).toBe(true);
    expect(result.envelope.spec.authorityLanes.corpusEvidence).not.toContain("model-output");
    expect(result.envelope.designMarkdown).toContain("## Model proposal — not accepted");
    expect(await store.read(result.envelope.artifactId)).not.toBeNull();
    expect(sha256Hex(await readFile(corpusPath))).toBe(corpusBefore);
    expect(result.envelope.semanticSpecSha256).not.toBe(baseline.envelope.semanticSpecSha256);
    expect(result.envelope.artifactId).not.toBe(baseline.envelope.artifactId);
    expect(result.envelope.designMarkdownSha256).not.toBe(
      baseline.envelope.designMarkdownSha256,
    );
    expect(result.envelope.designJsonSha256).not.toBe(baseline.envelope.designJsonSha256);

    const later = await createUiSpecForAdapter(
      REQUEST,
      dependencies(LATER_NOW, { kind: "configured", runtime }),
    );
    expect(later.envelope.semanticSpecSha256).toBe(result.envelope.semanticSpecSha256);
    expect(later.envelope.artifactId).toBe(result.envelope.artifactId);
    expect(later.envelope.specSha256).not.toBe(result.envelope.specSha256);
    expect(later.envelope.designJsonSha256).not.toBe(result.envelope.designJsonSha256);
  });

  it("falls back byte-for-byte after a provider call failure", async () => {
    const baseline = await deterministicBaseline();
    const runtime = makeRuntime({
      call: vi.fn(async () => {
        throw new Error("private provider failure");
      }),
    });

    const result = await createUiSpecForAdapter(
      REQUEST,
      dependencies(FIXED_NOW, { kind: "configured", runtime }),
    );

    expectDeterministicIdentity(result.envelope, baseline.envelope);
    expect(result.envelope.modelExecution).toEqual({ state: "call-failed" });
  });

  it("surfaces invalid-configuration end to end without calling a provider", async () => {
    // The only ModelExecution state with no end-to-end coverage, and the one an
    // operator is most likely to hit first: set three of the four
    // CREATE_UI_SPEC_MODEL_* variables and the resolver returns
    // invalid-configuration rather than falling back to determinism. It must
    // reach the envelope as its own distinct state — reporting it as
    // "not-configured" (i.e. omitting modelExecution) would tell the operator
    // no model was attempted, which is false and would send them looking in the
    // wrong place. No provider is contacted, so this needs no runtime at all.
    const baseline = await deterministicBaseline();

    const result = await createUiSpecForAdapter(
      REQUEST,
      dependencies(FIXED_NOW, { kind: "invalid-configuration" }),
    );

    expectDeterministicIdentity(result.envelope, baseline.envelope);
    expect(result.envelope.modelExecution).toEqual({ state: "invalid-configuration" });
    // Distinct from the unconfigured case, which carries no execution at all.
    expect(baseline.envelope.modelExecution).toBeUndefined();
  });

  it("falls back byte-for-byte after proposal rejection", async () => {
    const baseline = await deterministicBaseline();
    const runtime = makeRuntime({
      call: vi.fn(async () => ({
        ...validModelResponse(),
        content: "{not valid proposal json",
      })),
    });

    const result = await createUiSpecForAdapter(
      REQUEST,
      dependencies(FIXED_NOW, { kind: "configured", runtime }),
    );

    expectDeterministicIdentity(result.envelope, baseline.envelope);
    expect(result.envelope.modelExecution).toEqual({ state: "proposal-rejected" });
  });

  it("rolls back a newly published record and falls back byte-for-byte when post-publication sync fails", async () => {
    const baseline = await deterministicBaseline();
    const accepted = await createUiSpecForAdapter(
      REQUEST,
      dependencies(FIXED_NOW, { kind: "configured", runtime: makeRuntime() }),
    );
    const root = mkdtempSync(join(tmpdir(), "create-ui-spec-model-path-sync-failure-"));
    tempRoots.push(root);
    let syncCalls = 0;
    const store = createFileModelArtifactStore(root, {
      syncDirectory: vi.fn(async () => {
        syncCalls += 1;
        if (syncCalls === 1) throw new Error("post-publication sync failed");
      }),
    });
    const runtime = makeRuntime({ store });

    const result = await createUiSpecForAdapter(
      REQUEST,
      dependencies(FIXED_NOW, { kind: "configured", runtime }),
    );

    expectDeterministicIdentity(result.envelope, baseline.envelope);
    expect(result.envelope.modelExecution).toEqual({ state: "persistence-failed" });
    expect(result.envelope.spec.modelProposal).toBeUndefined();
    expect(await store.read(accepted.envelope.artifactId)).toBeNull();
    expect(await readdir(root)).toEqual([]);
  });

  it("rejects with a bounded error when proposal-record rollback cannot complete", async () => {
    const root = mkdtempSync(join(tmpdir(), "create-ui-spec-model-path-rollback-incomplete-"));
    tempRoots.push(root);
    const store = createFileModelArtifactStore(root, {
      syncDirectory: vi.fn(async () => {
        throw new Error(`raw sync failure at ${root}`);
      }),
    });
    const runtime = makeRuntime({ store });

    const error = await captureError(
      createUiSpecForAdapter(
        REQUEST,
        dependencies(FIXED_NOW, { kind: "configured", runtime }),
      ),
    );

    expect(error).toEqual({
      code: "INVALID_INPUT",
      message: "Model artifact persistence rollback did not complete.",
      retryable: false,
    });
    expect(JSON.stringify(error)).not.toContain(root);
    expect(JSON.stringify(error)).not.toContain("raw sync failure");
  });

  it("validates deterministic assembly before the provider call and preserves its exact error", async () => {
    const failedParse = { success: false } as ReturnType<typeof UiSpec.safeParse>;
    vi.spyOn(UiSpec, "safeParse").mockReturnValue(failedParse);
    const noModelError = await captureError(
      createUiSpecForAdapter(REQUEST, dependencies(FIXED_NOW)),
    );
    const call = vi.fn(async () => validModelResponse());
    const runtime = makeRuntime({ call });
    const modelError = await captureError(
      createUiSpecForAdapter(
        REQUEST,
        dependencies(FIXED_NOW, { kind: "configured", runtime }),
      ),
    );

    expect(call).not.toHaveBeenCalled();
    expect(JSON.stringify(modelError)).toBe(JSON.stringify(noModelError));
  });
});

async function captureError(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected promise to reject");
}

// ---------------------------------------------------------------------------
// C3 trust gate — the model lane's prompt grounding (Stage 1, Task 2)
// ---------------------------------------------------------------------------

const GATE_ROLES = {
  canvas: "#ffffff", surface: "#ffffff", ink: "#111827", muted: "#6b7280", accent: "#2563eb",
};

/** A verification map valid for EVERY servable key — the serving-behaviour default. */
function allKeysVerified(): Record<string, unknown> {
  const record = {
    method: "image-confirmed",
    verifiedAt: "2026-08-04",
    verifierVersion: "verifier-v1",
    imageSha256: "a".repeat(64),
  };
  const verification: Record<string, unknown> = {};
  for (const key of SERVABLE_FIELD_KEYS) verification[key] = record;
  return verification;
}

function gateEntry(id: string, patternType: string, verified: boolean): CorpusEntryT {
  return {
    id,
    patternType,
    ...(verified
      ? {
          provenance: {
            taggedBy: "auto",
            verification: allKeysVerified(),
          },
        }
      : {}),
    visual: {
      colorRoles: GATE_ROLES,
      spacingDensity: "compact", cornerStyle: "slight-round",
      usesShadows: false, usesBorders: true,
      accentColor: "#2563eb", typePairing: { display: "Inter", body: "Inter" },
    },
  } as unknown as CorpusEntryT;
}

describe("create_ui_spec model lane — trust-gated prompt grounding", () => {
  it("keeps unverified entries' derived summaries out of the model prompt", async () => {
    // Two matched entries: one verified (dashboard), one not (forms). The
    // prompt's evidence summaries must carry only the verified row's derived
    // summary; the unverified row is dropped at construction by the per-field
    // strip.
    const verified = gateEntry("internal-v", "dashboard", true);
    const unverified = gateEntry("internal-u", "forms", false);
    const reader = {
      ...makeReader(),
      searchRanked: vi.fn(async () => [
        { entry: verified, score: 5, searchMode: "keyword" },
        { entry: unverified, score: 4, searchMode: "keyword" },
      ]),
    } as unknown as CorpusReader;

    const call = vi.fn(async () => validModelResponse());
    const runtime = makeRuntime({ call: call as unknown as CreateUiSpecModelRuntime["call"] });
    const out = await createUiSpecForAdapter(
      REQUEST,
      makeCreateUiSpecDependencies(reader, FIXED_NOW, { kind: "configured", runtime }),
    );
    expect(out.envelope.modelExecution?.state).toBe("succeeded");
    const prompt = (call.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("dashboard reference");
    expect(prompt).not.toContain("forms reference");
    // The per-field strip is the model-lane gate now: the unverified row was
    // dropped at construction, so the served evidence reports one row.
    expect(out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation")).toHaveLength(1);
  });

  it("feeds the model exactly the verified facts of a partially-verified row", async () => {
    // Entry verified for patternType ONLY: the row survives with the pattern
    // fact and none of the colour/layout/typography facts.
    const verified = {
      ...gateEntry("internal-v", "dashboard", true),
      provenance: {
        taggedBy: "auto",
        verification: { patternType: { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "v1" } },
      },
    } as unknown as CorpusEntryT;
    const reader = {
      ...makeReader(),
      searchRanked: vi.fn(async () => [{ entry: verified, score: 5, searchMode: "keyword" }]),
    } as unknown as CorpusReader;

    const call = vi.fn(async () => validModelResponse());
    const runtime = makeRuntime({ call: call as unknown as CreateUiSpecModelRuntime["call"] });
    const out = await createUiSpecForAdapter(
      REQUEST,
      makeCreateUiSpecDependencies(reader, FIXED_NOW, { kind: "configured", runtime }),
    );
    expect(out.envelope.modelExecution?.state).toBe("succeeded");
    const prompt = (call.mock.calls[0][0] as { prompt: string }).prompt;
    expect(prompt).toContain("dashboard reference");
    const rows = out.sanitizedEvidence.filter((e) => e.kind === "corpus-observation");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.structuredFacts.pattern).toBe("dashboard");
    expect(rows[0]!.structuredFacts.colorRoles).toBeUndefined();
    expect(rows[0]!.structuredFacts.layoutForm).toBeUndefined();
  });
});
