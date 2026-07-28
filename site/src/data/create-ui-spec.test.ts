/**
 * create-ui-spec.test.ts — the browser-side `create_ui_spec` client (C3 Task 6).
 *
 * The properties pinned here are the ones the C3 surface-control model depends
 * on at the BROWSER boundary:
 *
 *  1. Two same-origin, relative requests and no more: `GET /api/csrf` then
 *     `POST /api/create-ui-spec` carrying the nonce in `X-Clean-UI-CSRF`.
 *  2. The response is UNTRUSTED until the expected shape is checked. A response
 *     that is missing a field the composer displays, or whose evidence-id
 *     positions do not positively match `evidence-<n>`, is refused whole — the
 *     client returns a failure and no partial artifact.
 *  3. The value handed to the UI is an explicit ALLOWLIST projection, not the
 *     server object. Nothing outside the projection can reach the DOM even if a
 *     future producer adds a field, because the projected object does not carry
 *     it. Notably: no `sourceId`, no `sourceReferences`, no `citedReferences`,
 *     no `evidenceIds`, no `imagePath`, no `productContext` echo.
 *  4. `designMarkdown` / `designJson` are carried through as the EXACT strings
 *     the response contained, so a download reuses the reviewed bytes.
 *  5. Failures are described by a CLIENT-authored code, never by server free
 *     text. The server's `error.message` is never surfaced.
 *  6. The client writes nothing to localStorage/sessionStorage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BRIEF_MAX_LENGTH,
  BRIEF_MIN_LENGTH,
  CSRF_HEADER,
  DESIGN_JSON_FILENAME,
  DESIGN_MARKDOWN_FILENAME,
  briefValidationMessage,
  downloadExactBytes,
  requestDesignArtifact,
  resetCachedNonce,
  type LifecyclePhase,
} from "./create-ui-spec";

// ---------------------------------------------------------------------------
// A response fixture with the shape the loopback adapter actually serves:
// the parsed DesignArtifactEnvelope itself, both renderings, response-scoped
// evidence ids. Private-shaped fields are deliberately present in the nested
// spec so the projection test has something real to drop.
// ---------------------------------------------------------------------------

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const HASH_C = "c".repeat(64);
const HASH_D = "d".repeat(64);
const HASH_E = "e".repeat(64);

const MARKDOWN_BYTES = "# DESIGN\n\nDeterministic markdown handoff.\n";
const JSON_BYTES = '{"specVersion":"1.0","designDirection":"Direction"}';

function envelopeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactVersion: "1.0",
    artifactId: `uispec-${HASH_A}`,
    generatedAt: "2026-07-28T10:00:00.000Z",
    producerVersion: "create-ui-spec/1.0.0",
    assemblyRulesSha256: HASH_B,
    spec: {
      specVersion: "1.0",
      context: {
        // The producer echoes the caller's own brief here. It is the caller's
        // data, not corpus content — but the projection still drops it, because
        // showing an operator their own brief back is not a result.
        productContext: "A pricing page for a developer tool",
        platform: "web",
        constraints: ["No dark patterns"],
      },
      designDirection: "Lead with the plan comparison; defer the FAQ.",
      rejectedDefaults: [],
      layoutRegions: [],
      responsiveBehavior: [],
      componentInventory: [{ name: "PlanCard", pattern: "pricing", sourceId: "corpus-1234" }],
      colorTokens: null,
      colorTokenAuthority: "editorial",
      typographyTokens: null,
      typographyTokenAuthority: "editorial",
      interactions: [],
      motionGuidance: { notes: [], evidenceUnavailable: true },
      accessibilityConstraints: [],
      techniques: [{ text: "Anchor the primary plan", sourceIds: ["corpus-1234"] }],
      antiPatterns: [],
      unavailableDecisions: [
        { field: "colorTokens", reason: "No design-system tokens were supplied." },
        { field: "typographyTokens", reason: "No design-system tokens were supplied." },
        { field: "motion", reason: "No motion evidence was available." },
      ],
      acceptanceCriteria: [
        {
          id: "ac-1",
          subject: "Primary call to action",
          assertion: "has-accessible-name",
          expectedOutcome: "The primary action exposes an accessible name.",
          verifier: "axe",
          priority: "must",
          evidenceIds: ["evidence-1"],
        },
      ],
      citedReferences: ["ref-digest-1"],
      citedDecisions: [
        {
          id: "cd-1",
          field: "layoutRegions",
          authority: "corpus-evidence",
          evidenceIds: ["evidence-1"],
          readiness: "available",
          sourceId: "corpus-1234",
        },
      ],
      authorityLanes: { corpusEvidence: ["cd-1"], machineRules: [], editorialGuidance: [] },
      provenance: {
        generatedAt: "2026-07-28T10:00:00.000Z",
        toolVersion: "create-ui-spec/1.0.0",
        sourceReferences: ["https://private.example.com/secret"],
        evidenceIds: ["evidence-1"],
      },
    },
    handoff: { target: "neutral-web", motionIntents: [] },
    designMarkdown: MARKDOWN_BYTES,
    designJson: JSON_BYTES,
    specSha256: HASH_C,
    designMarkdownSha256: HASH_D,
    designJsonSha256: HASH_E,
    semanticSpecSha256: HASH_B,
    publicEvidenceIds: ["evidence-1"],
    retrieval: {
      mode: "keyword",
      modality: "metadata",
      resultCount: 3,
      fallbackUsed: false,
      attemptedCount: 0,
      attemptedModes: [],
    },
    warnings: [{ code: "sparseCoverage", message: "Corpus coverage for this pattern is sparse." }],
    ...overrides,
  };
}

const NONCE = "f".repeat(64);

interface StubCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
  readonly credentials: RequestCredentials | undefined;
}

interface StubResponse {
  readonly status: number;
  readonly json: unknown;
}

/** A fetch stub that records every call and replays a scripted queue. */
function stubFetch(queue: readonly StubResponse[]): {
  readonly calls: StubCall[];
  readonly fetchImpl: typeof fetch;
} {
  const calls: StubCall[] = [];
  let index = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const rawHeaders = (init?.headers ?? {}) as Record<string, string>;
    for (const [key, value] of Object.entries(rawHeaders)) headers[key.toLowerCase()] = value;
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      credentials: init?.credentials,
    });
    const scripted = queue[Math.min(index, queue.length - 1)];
    index += 1;
    return {
      ok: scripted.status >= 200 && scripted.status < 300,
      status: scripted.status,
      json: async () => scripted.json,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

function okQueue(envelope: Record<string, unknown> = envelopeFixture()): readonly StubResponse[] {
  return [
    { status: 200, json: { nonce: NONCE } },
    { status: 200, json: envelope },
  ];
}

const BRIEF = { productContext: "A pricing page for a developer tool" };

describe("briefValidationMessage", () => {
  it("refuses a brief shorter than the required minimum", () => {
    expect(briefValidationMessage({ productContext: "short" })).toMatch(
      new RegExp(String(BRIEF_MIN_LENGTH)),
    );
  });

  it("accepts a brief at the minimum length", () => {
    expect(briefValidationMessage({ productContext: "a".repeat(BRIEF_MIN_LENGTH) })).toBeNull();
  });

  it("refuses a brief longer than the maximum length", () => {
    expect(
      briefValidationMessage({ productContext: "a".repeat(BRIEF_MAX_LENGTH + 1) }),
    ).not.toBeNull();
  });

  it("refuses more constraints than the contract allows", () => {
    const constraints = Array.from({ length: 13 }, (_, i) => `constraint ${i}`);
    expect(briefValidationMessage({ ...BRIEF, constraints })).not.toBeNull();
  });

  it("refuses more explicit references than the contract allows", () => {
    const referenceIds = ["a", "b", "c", "d", "e", "f"];
    expect(briefValidationMessage({ ...BRIEF, referenceIds })).not.toBeNull();
  });

  it("refuses duplicate explicit references", () => {
    expect(briefValidationMessage({ ...BRIEF, referenceIds: ["a", "a"] })).not.toBeNull();
  });
});

describe("requestDesignArtifact — transport", () => {
  // The nonce is cached in module scope for the life of a page. Each test is a
  // fresh page, so the cache must be cleared or a later test would skip its
  // GET /api/csrf and consume the wrong scripted response.
  beforeEach(() => {
    resetCachedNonce();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches the nonce, then posts the brief same-origin with the CSRF header", async () => {
    const { calls, fetchImpl } = stubFetch(okQueue());
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ url: "/api/csrf", method: "GET" });
    expect(calls[1].url).toBe("/api/create-ui-spec");
    expect(calls[1].method).toBe("POST");
    expect(calls[1].headers[CSRF_HEADER.toLowerCase()]).toBe(NONCE);
    // Relative URLs only — never an absolute origin.
    for (const call of calls) expect(call.url.startsWith("/api/")).toBe(true);
  });

  it("omits every optional request field the operator left blank", async () => {
    const { calls, fetchImpl } = stubFetch(okQueue());
    await requestDesignArtifact(BRIEF, { fetchImpl });
    expect(calls[1].body).toEqual({ productContext: BRIEF.productContext });
  });

  it("sends the optional controls the operator did fill in", async () => {
    const { calls, fetchImpl } = stubFetch(okQueue());
    await requestDesignArtifact(
      {
        ...BRIEF,
        platform: "mobile",
        implementationFramework: "React",
        designSystem: { status: "identified", library: "internal-kit" },
        constraints: ["No dark patterns"],
        referenceIds: ["public-ref-1"],
      },
      { fetchImpl },
    );
    expect(calls[1].body).toEqual({
      productContext: BRIEF.productContext,
      platform: "mobile",
      implementationFramework: "React",
      designSystem: { status: "identified", library: "internal-kit" },
      constraints: ["No dark patterns"],
      referenceIds: ["public-ref-1"],
    });
  });

  it("never attaches credentials, cookies, or an authorization header", async () => {
    const { calls, fetchImpl } = stubFetch(okQueue());
    await requestDesignArtifact(BRIEF, { fetchImpl });
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers.authorization).toBeUndefined();
      expect(call.headers.cookie).toBeUndefined();
      // `credentials: "omit"` is explicit, not left to fetch's default. The
      // default is `same-origin`, which WOULD attach a cookie another local
      // server left on this host — cookies are host-scoped, not port-scoped.
      expect(call.credentials).toBe("omit");
    }
  });

  it("reports the real client lifecycle phases in order", async () => {
    const { fetchImpl } = stubFetch(okQueue());
    const phases: LifecyclePhase[] = [];
    await requestDesignArtifact(BRIEF, { fetchImpl, onPhase: (p) => phases.push(p) });
    expect(phases).toEqual(["authorizing", "submitting", "validating"]);
  });

  it("writes nothing to localStorage or sessionStorage", async () => {
    const { fetchImpl } = stubFetch(okQueue());
    const localSpy = vi.spyOn(window.localStorage, "setItem");
    const sessionSpy = vi.spyOn(window.sessionStorage, "setItem");
    await requestDesignArtifact(BRIEF, { fetchImpl });
    expect(localSpy).not.toHaveBeenCalled();
    expect(sessionSpy).not.toHaveBeenCalled();
  });
});

describe("requestDesignArtifact — safe projection", () => {
  beforeEach(() => {
    resetCachedNonce();
  });

  it("carries the returned renderings through byte-for-byte", async () => {
    const { fetchImpl } = stubFetch(okQueue());
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    if (!result.ok) throw new Error("expected success");
    expect(result.artifact.designMarkdown).toBe(MARKDOWN_BYTES);
    expect(result.artifact.designJson).toBe(JSON_BYTES);
    expect(result.artifact.designMarkdownSha256).toBe(HASH_D);
    expect(result.artifact.designJsonSha256).toBe(HASH_E);
  });

  it("projects only the display-safe fields and drops every private-shaped one", async () => {
    const { fetchImpl } = stubFetch(okQueue());
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    if (!result.ok) throw new Error("expected success");

    const serialized = JSON.stringify(result.artifact);
    // Source identities and raw corpus ids never survive the projection.
    expect(serialized).not.toContain("sourceId");
    expect(serialized).not.toContain("sourceIds");
    expect(serialized).not.toContain("sourceReferences");
    expect(serialized).not.toContain("citedReferences");
    expect(serialized).not.toContain("evidenceIds");
    expect(serialized).not.toContain("corpus-1234");
    expect(serialized).not.toContain("private.example.com");
    // The producer's echo of the caller's own brief is not a result either.
    expect(serialized).not.toContain("productContext");
    // Per-id evidence is aggregated to a count; the ids themselves are not carried.
    expect(serialized).not.toContain("evidence-1");
    expect(result.artifact.evidence.evidenceCount).toBe(1);
  });

  it("keeps the display-safe content the composer renders", async () => {
    const { fetchImpl } = stubFetch(okQueue());
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    if (!result.ok) throw new Error("expected success");
    const artifact = result.artifact;

    expect(artifact.designDirection).toMatch(/plan comparison/);
    expect(artifact.decisions).toEqual([
      { id: "cd-1", field: "layoutRegions", authority: "corpus-evidence", readiness: "available" },
    ]);
    expect(artifact.acceptanceCriteria).toEqual([
      {
        id: "ac-1",
        subject: "Primary call to action",
        assertion: "has-accessible-name",
        expectedOutcome: "The primary action exposes an accessible name.",
        verifier: "axe",
        priority: "must",
      },
    ]);
    expect(artifact.warnings).toEqual([
      { code: "sparseCoverage", message: "Corpus coverage for this pattern is sparse." },
    ]);
    expect(artifact.unavailableDecisions.map((d) => d.field)).toEqual([
      "colorTokens",
      "typographyTokens",
      "motion",
    ]);
    expect(artifact.evidence).toEqual({
      evidenceCount: 1,
      retrievalMode: "keyword",
      retrievalModality: "metadata",
      corpusResultCount: 3,
      attemptedCount: 0,
      fallbackUsed: false,
      fallbackReason: null,
    });
  });

  it("flags a structured-fallback artifact as partial rather than fully generated", async () => {
    const envelope = envelopeFixture({
      retrieval: {
        mode: "structured-fallback",
        modality: "metadata",
        resultCount: 0,
        fallbackUsed: true,
        fallbackReason: "no-results",
        attemptedCount: 1,
        attemptedModes: ["keyword"],
      },
    });
    const { fetchImpl } = stubFetch(okQueue(envelope));
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    if (!result.ok) throw new Error("expected success");
    expect(result.artifact.partial).toBe(true);
    expect(result.artifact.evidence.fallbackUsed).toBe(true);
    expect(result.artifact.evidence.fallbackReason).toBe("no-results");
  });
});

describe("requestDesignArtifact — untrusted response handling", () => {
  beforeEach(() => {
    resetCachedNonce();
  });

  it("refuses a response missing a field the composer displays", async () => {
    const envelope = envelopeFixture();
    delete envelope.designJson;
    const { fetchImpl } = stubFetch(okQueue(envelope));
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    expect(result).toEqual({ ok: false, failure: { code: "MALFORMED_RESPONSE", retryable: false } });
  });

  it("refuses a response whose evidence-id positions are not response-scoped", async () => {
    // A filesystem path sitting where an `evidence-<n>` id must be is exactly the
    // shape the fail-closed server gate screens. The client checks it again on
    // its own side rather than trusting that it ran.
    const envelope = envelopeFixture({
      publicEvidenceIds: ["corpus/images-private/secret.png"],
    });
    const { fetchImpl } = stubFetch(okQueue(envelope));
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    expect(result.ok).toBe(false);
  });

  it("refuses a response whose hashes are not 64-hex digests", async () => {
    const { fetchImpl } = stubFetch(okQueue(envelopeFixture({ designMarkdownSha256: "nope" })));
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    expect(result.ok).toBe(false);
  });

  it("refuses a response whose artifactVersion is not the supported one", async () => {
    const { fetchImpl } = stubFetch(okQueue(envelopeFixture({ artifactVersion: "2.0" })));
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    expect(result.ok).toBe(false);
  });

  it("drops a warning whose code is outside the closed set", async () => {
    const { fetchImpl } = stubFetch(
      okQueue(
        envelopeFixture({
          warnings: [
            { code: "sparseCoverage", message: "Known." },
            { code: "somethingNew", message: "Unknown code — not rendered." },
          ],
        }),
      ),
    );
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    if (!result.ok) throw new Error("expected success");
    expect(result.artifact.warnings.map((w) => w.code)).toEqual(["sparseCoverage"]);
  });
});

describe("requestDesignArtifact — failures", () => {
  beforeEach(() => {
    resetCachedNonce();
  });

  it("maps a 400 to a non-retryable input failure and never surfaces server text", async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, json: { nonce: NONCE } },
      {
        status: 400,
        json: {
          error: {
            code: "INVALID_INPUT",
            message: "server text that must not be rendered",
            retryable: false,
          },
        },
      },
    ]);
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    expect(result).toEqual({ ok: false, failure: { code: "INVALID_INPUT", retryable: false } });
    expect(JSON.stringify(result)).not.toContain("server text");
  });

  it("maps a 503 to a retryable unavailable failure", async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, json: { nonce: NONCE } },
      {
        status: 503,
        json: { error: { code: "PROVIDER_ERROR", message: "Assembly is unavailable.", retryable: true } },
      },
    ]);
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    expect(result).toEqual({ ok: false, failure: { code: "PROVIDER_ERROR", retryable: true } });
  });

  it("honours a non-retryable 503 (the integrity refusal) as non-retryable", async () => {
    const { fetchImpl } = stubFetch([
      { status: 200, json: { nonce: NONCE } },
      {
        status: 503,
        json: { error: { code: "PROVIDER_ERROR", message: "Refused.", retryable: false } },
      },
    ]);
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    expect(result).toEqual({ ok: false, failure: { code: "PROVIDER_ERROR", retryable: false } });
  });

  it("re-mints the nonce and retries once when the server rejects it", async () => {
    // The nonce is process-local: an operator restart invalidates the cached one.
    const { calls, fetchImpl } = stubFetch([
      { status: 200, json: { nonce: NONCE } },
      { status: 403, json: { code: "CSRF_REQUIRED", error: "Missing or invalid header." } },
      { status: 200, json: { nonce: "9".repeat(64) } },
      { status: 200, json: envelopeFixture() },
    ]);
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    expect(result.ok).toBe(true);
    expect(calls.map((c) => c.url)).toEqual([
      "/api/csrf",
      "/api/create-ui-spec",
      "/api/csrf",
      "/api/create-ui-spec",
    ]);
    expect(calls[3].headers[CSRF_HEADER.toLowerCase()]).toBe("9".repeat(64));
  });

  it("gives up after one nonce re-mint rather than looping", async () => {
    const { calls, fetchImpl } = stubFetch([
      { status: 200, json: { nonce: NONCE } },
      { status: 403, json: { code: "CSRF_REQUIRED" } },
      { status: 200, json: { nonce: NONCE } },
      { status: 403, json: { code: "CSRF_REQUIRED" } },
    ]);
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    expect(result).toEqual({ ok: false, failure: { code: "CSRF_REJECTED", retryable: true } });
    expect(calls).toHaveLength(4);
  });

  it("maps a transport failure to a retryable network failure", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("Failed to fetch");
    }) as unknown as typeof fetch;
    const result = await requestDesignArtifact(BRIEF, { fetchImpl });
    expect(result).toEqual({ ok: false, failure: { code: "NETWORK", retryable: true } });
  });

  it("refuses the request client-side when the brief is too short", async () => {
    const { calls, fetchImpl } = stubFetch(okQueue());
    const result = await requestDesignArtifact({ productContext: "no" }, { fetchImpl });
    expect(result).toEqual({ ok: false, failure: { code: "INVALID_INPUT", retryable: false } });
    // Nothing left the browser.
    expect(calls).toHaveLength(0);
  });
});

describe("downloadExactBytes", () => {
  let created: string[] = [];
  let revoked: string[] = [];
  let blobs: Blob[] = [];

  beforeEach(() => {
    created = [];
    revoked = [];
    blobs = [];
    // jsdom cannot navigate, and a real anchor click would try. The click is the
    // save gesture, not the thing under test — the blob contents are.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function env(): Parameters<typeof downloadExactBytes>[3] {
    return {
      createObjectURL: (blob: Blob) => {
        blobs.push(blob);
        const url = `blob:${blobs.length}`;
        created.push(url);
        return url;
      },
      revokeObjectURL: (url: string) => {
        revoked.push(url);
      },
    };
  }

  it("writes the exact bytes it was handed and makes no network request", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const anchor = downloadExactBytes(DESIGN_MARKDOWN_FILENAME, MARKDOWN_BYTES, "text/markdown", env());

    expect(anchor.download).toBe(DESIGN_MARKDOWN_FILENAME);
    expect(created).toHaveLength(1);
    expect(revoked).toEqual(created);
    expect(await blobs[0].text()).toBe(MARKDOWN_BYTES);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("uses the JSON filename and type for the JSON handoff", async () => {
    const anchor = downloadExactBytes(DESIGN_JSON_FILENAME, JSON_BYTES, "application/json", env());
    expect(anchor.download).toBe(DESIGN_JSON_FILENAME);
    expect(blobs[0].type).toContain("application/json");
    expect(await blobs[0].text()).toBe(JSON_BYTES);
  });
});
