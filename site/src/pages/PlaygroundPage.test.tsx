/**
 * PlaygroundPage.test.tsx — the focused C3 `create_ui_spec` composer (Task 6).
 *
 * These tests drive the composer through the REAL client
 * (`site/src/data/create-ui-spec.ts`) with only `fetch` stubbed, so the request
 * shape, the CSRF exchange, the untrusted-response check and the projection are
 * all exercised end to end. Mocking the client instead would let the page and the
 * client drift apart at exactly the seam that matters.
 *
 * The load-bearing properties:
 *  - Generation is disabled until the brief meets the required minimum.
 *  - Real lifecycle labels, announced through a live region; duplicate submits
 *    are impossible while a generation is in flight.
 *  - A download reuses the EXACT bytes the response carried and issues NO
 *    further request (a second generation would produce a different
 *    `generatedAt`, and therefore a different artifact, than the one reviewed).
 *  - No private corpus marker, source identity, path, raw corpus id, or
 *    response-scoped evidence id reaches the DOM or web storage.
 *  - A recoverable failure preserves the brief and offers retry.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

import { resetCachedNonce } from "../data/create-ui-spec";
import { PlaygroundPage } from "./PlaygroundPage";

// ---------------------------------------------------------------------------
// Response fixtures. The nested spec deliberately carries private-shaped values
// (a raw corpus id, a private source URL, an image path) so "none of this reaches
// the DOM" is a real assertion rather than a vacuous one.
// ---------------------------------------------------------------------------

const NONCE = "f".repeat(64);

const RAW_CORPUS_ID = "corpus-9931";
const PRIVATE_URL = "https://private.example.com/secret";
const PRIVATE_IMAGE_PATH = "corpus/images-private/shot.png";

// The RENDERED markdown is not the client's projection: renderDesignHandoffMarkdown
// prints `spec.context.productContext`, `spec.citedReferences`, the profile's
// sourceId + URL lines, and `spec.techniques[].text` / `spec.antiPatterns[].text` /
// `spec.componentInventory` — exactly the positions the projection does not read.
// So the fixture's markdown carries the private markers too: any control that
// publishes these bytes into the DOM is then caught by the marker assertions
// instead of passing vacuously. (Review Important 2.)
const MARKDOWN_BYTES = [
  "# DESIGN",
  "",
  "## Direction",
  "",
  "Lead with the plan comparison.",
  "",
  "## Techniques",
  "",
  `- Anchor the primary plan (${PRIVATE_IMAGE_PATH}) — ${RAW_CORPUS_ID}`,
  "",
  "## Sources",
  "",
  `- ${PRIVATE_URL}`,
  "",
].join("\n");
const JSON_BYTES = `{"specVersion":"1.0","designDirection":"Lead with the plan comparison.","sourceId":"${RAW_CORPUS_ID}"}`;

function hash(seed: string): string {
  return seed.repeat(64).slice(0, 64);
}

function envelopeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const spec = {
    specVersion: "1.0",
    context: {
      productContext: BRIEF_TEXT,
      platform: "web",
      constraints: [],
    },
    designDirection: "Lead with the plan comparison; defer the FAQ.",
    rejectedDefaults: [],
    layoutRegions: [],
    responsiveBehavior: [],
    componentInventory: [
      { name: "PlanCard", pattern: "pricing", sourceId: RAW_CORPUS_ID },
    ],
    colorTokens: null,
    colorTokenAuthority: "editorial",
    typographyTokens: null,
    typographyTokenAuthority: "editorial",
    interactions: [],
    motionGuidance: { notes: [], evidenceUnavailable: true },
    accessibilityConstraints: [],
    techniques: [{ text: `Anchor the primary plan (${PRIVATE_IMAGE_PATH})`, sourceIds: [RAW_CORPUS_ID] }],
    antiPatterns: [],
    unavailableDecisions: [
      { field: "colorTokens", reason: "No design-system tokens were supplied." },
      { field: "motion", reason: "No motion evidence was available for this pattern." },
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
      {
        id: "ac-2",
        subject: "Plan comparison table",
        assertion: "responsive-at",
        expectedOutcome: "The comparison stays readable at 320px.",
        verifier: "playwright",
        priority: "should",
        evidenceIds: ["evidence-2"],
        selector: ".plans",
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
        sourceId: RAW_CORPUS_ID,
      },
      {
        id: "cd-2",
        field: "colorTokens",
        authority: "editorial",
        evidenceIds: ["evidence-2"],
        readiness: "unavailable",
      },
    ],
    authorityLanes: { corpusEvidence: ["cd-1"], machineRules: [], editorialGuidance: ["cd-2"] },
    provenance: {
      generatedAt: "2026-07-28T10:00:00.000Z",
      toolVersion: "create-ui-spec/1.0.0",
      sourceReferences: [PRIVATE_URL],
      evidenceIds: ["evidence-1", "evidence-2"],
    },
  };
  return {
    artifactVersion: "1.0",
    artifactId: `uispec-${hash("a")}`,
    generatedAt: "2026-07-28T10:00:00.000Z",
    producerVersion: "create-ui-spec/1.0.0",
    assemblyRulesSha256: hash("b"),
    spec,
    handoff: { target: "neutral-web", motionIntents: [] },
    designMarkdown: MARKDOWN_BYTES,
    designJson: JSON_BYTES,
    specSha256: hash("c"),
    designMarkdownSha256: hash("d"),
    designJsonSha256: hash("e"),
    semanticSpecSha256: hash("1"),
    publicEvidenceIds: ["evidence-1", "evidence-2"],
    retrieval: {
      mode: "keyword",
      modality: "metadata",
      resultCount: 4,
      fallbackUsed: false,
      attemptedCount: 0,
      attemptedModes: [],
    },
    warnings: [],
    ...overrides,
  };
}

function fallbackEnvelope(): Record<string, unknown> {
  return envelopeFixture({
    retrieval: {
      mode: "structured-fallback",
      modality: "metadata",
      resultCount: 0,
      fallbackUsed: true,
      fallbackReason: "no-results",
      attemptedCount: 1,
      attemptedModes: ["keyword"],
    },
    warnings: [
      { code: "insufficientCorpusEvidence", message: "No corpus observation matched this pattern." },
    ],
  });
}

const BRIEF_TEXT = "A pricing page for a developer tool with three plans";

// ---------------------------------------------------------------------------
// fetch harness
// ---------------------------------------------------------------------------

interface ScriptedResponse {
  readonly status: number;
  readonly json: unknown;
  /** When set, the response resolves only after this promise settles. */
  readonly gate?: Promise<void>;
}

interface FetchHarness {
  readonly calls: Array<{ url: string; method: string; body: unknown }>;
  readonly fetchMock: ReturnType<typeof vi.fn>;
}

function installFetch(queue: readonly ScriptedResponse[]): FetchHarness {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  let index = 0;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const scripted = queue[Math.min(index, queue.length - 1)];
    index += 1;
    if (scripted.gate) await scripted.gate;
    return {
      ok: scripted.status >= 200 && scripted.status < 300,
      status: scripted.status,
      json: async () => scripted.json,
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock };
}

function successQueue(envelope = envelopeFixture()): readonly ScriptedResponse[] {
  return [
    { status: 200, json: { nonce: NONCE } },
    { status: 200, json: envelope },
  ];
}

// Captured download attempts: jsdom cannot navigate, so the anchor click is
// intercepted and the blob contents recorded instead.
let downloadedBlobs: Blob[] = [];
let downloadedNames: string[] = [];

function renderComposer(): ReturnType<typeof render> {
  return render(
    <MemoryRouter initialEntries={["/playground"]}>
      <PlaygroundPage />
    </MemoryRouter>,
  );
}

/** Stands in for the real /browse route so a redirect is observable. */
function BrowseStub(): ReactElement {
  const location = useLocation();
  return <p data-testid="browse-stub">{`${location.pathname}${location.search}`}</p>;
}

function briefField(): HTMLTextAreaElement {
  return screen.getByLabelText(/what are you designing/i) as HTMLTextAreaElement;
}

function generateButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: /generate/i }) as HTMLButtonElement;
}

function typeBrief(text = BRIEF_TEXT): void {
  fireEvent.change(briefField(), { target: { value: text } });
}

// The artifact heading is queried BY LEVEL: the page H1 also contains the words
// "design handoff", so a name-only query would resolve against the header and
// every success assertion would race an unfinished generation.
async function generateSuccessfully(envelope = envelopeFixture()): Promise<FetchHarness> {
  const harness = installFetch(successQueue(envelope));
  renderComposer();
  typeBrief();
  fireEvent.click(generateButton());
  await screen.findByRole("heading", { level: 3, name: /design handoff/i });
  return harness;
}

beforeEach(() => {
  resetCachedNonce();
  downloadedBlobs = [];
  downloadedNames = [];
  // Blob URLs do not exist in jsdom; record the blob and hand back a token.
  vi.stubGlobal("URL", {
    ...URL,
    createObjectURL: vi.fn((blob: Blob) => {
      downloadedBlobs.push(blob);
      return `blob:${downloadedBlobs.length}`;
    }),
    revokeObjectURL: vi.fn(),
  });
  // Intercept the anchor click so jsdom does not attempt a navigation.
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloadedNames.push(this.download);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PlaygroundPage — idle", () => {
  it("keeps generation disabled until the brief meets the required minimum", () => {
    installFetch(successQueue());
    renderComposer();

    expect(generateButton()).toBeDisabled();
    fireEvent.change(briefField(), { target: { value: "short" } });
    expect(generateButton()).toBeDisabled();
    typeBrief();
    expect(generateButton()).toBeEnabled();
  });

  it("announces the idle lifecycle stage through a live region", () => {
    installFetch(successQueue());
    renderComposer();
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status.textContent ?? "").toMatch(/idle/i);
  });

  it("offers the optional controls and a collapsed advanced reference override", () => {
    installFetch(successQueue());
    renderComposer();

    expect(screen.getByLabelText(/platform/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/implementation framework/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/design system/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/constraints/i)).toBeInTheDocument();

    // The advanced override is present but collapsed by default.
    const advanced = screen.getByText(/advanced/i).closest("details");
    expect(advanced).not.toBeNull();
    expect((advanced as HTMLDetailsElement).open).toBe(false);
    expect(screen.getByLabelText(/explicit reference/i)).toBeInTheDocument();
  });

  it("links to the corpus-search surface that moved to /browse", () => {
    installFetch(successQueue());
    renderComposer();
    const link = screen.getByRole("link", { name: /browse the corpus/i });
    expect(link.getAttribute("href")).toBe("/browse");
  });

  it("points explicit-reference users to browse without enumerating reference ids", () => {
    installFetch(successQueue());
    renderComposer();
    fireEvent.click(screen.getByText(/advanced: explicit reference override/i));

    const hint = screen.getByText(/automatic retrieval off/i);
    expect(hint.textContent ?? "").toMatch(/browse/i);
    const link = within(hint).getByRole("link", { name: /browse/i });
    expect(link.getAttribute("href")).toBe("/browse");
    expect(hint.textContent ?? "").not.toMatch(/corpus-|public-ref-|decision-/i);
  });

  it("sends only the fields the operator filled in", async () => {
    const harness = installFetch(successQueue());
    renderComposer();
    typeBrief();
    fireEvent.click(generateButton());
    await screen.findByRole("heading", { level: 3, name: /design handoff/i });

    expect(harness.calls[1].body).toEqual({ productContext: BRIEF_TEXT });
  });

  it("sends the optional controls once the operator fills them in", async () => {
    const harness = installFetch(successQueue());
    renderComposer();
    typeBrief();
    fireEvent.change(screen.getByLabelText(/platform/i), { target: { value: "mobile" } });
    fireEvent.change(screen.getByLabelText(/implementation framework/i), {
      target: { value: "React" },
    });
    fireEvent.change(screen.getByLabelText(/design system/i), { target: { value: "identified" } });
    fireEvent.change(screen.getByLabelText(/component library/i), {
      target: { value: "internal-kit" },
    });
    fireEvent.change(screen.getByLabelText(/constraints/i), {
      target: { value: "No dark patterns\n\nMust ship in two weeks" },
    });
    fireEvent.change(screen.getByLabelText(/explicit reference/i), {
      target: { value: "public-ref-1\npublic-ref-2" },
    });
    fireEvent.click(generateButton());
    await screen.findByRole("heading", { level: 3, name: /design handoff/i });

    expect(harness.calls[1].body).toEqual({
      productContext: BRIEF_TEXT,
      platform: "mobile",
      implementationFramework: "React",
      designSystem: { status: "identified", library: "internal-kit" },
      // Blank lines are dropped; order preserved.
      constraints: ["No dark patterns", "Must ship in two weeks"],
      referenceIds: ["public-ref-1", "public-ref-2"],
    });
  });
});

describe("PlaygroundPage — generating", () => {
  it("disables duplicate submits while a generation is in flight", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = installFetch([
      { status: 200, json: { nonce: NONCE } },
      { status: 200, json: envelopeFixture(), gate },
    ]);
    renderComposer();
    typeBrief();
    fireEvent.click(generateButton());

    await waitFor(() => expect(generateButton()).toBeDisabled());
    // A second and third click while pending must not start another generation.
    fireEvent.click(generateButton());
    fireEvent.click(generateButton());

    release();
    await screen.findByRole("heading", { level: 3, name: /design handoff/i });

    const posts = harness.calls.filter((c) => c.url === "/api/create-ui-spec");
    expect(posts).toHaveLength(1);
  });

  it("reports real lifecycle stages, never a fabricated percentage", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    installFetch([
      { status: 200, json: { nonce: NONCE } },
      { status: 200, json: envelopeFixture(), gate },
    ]);
    renderComposer();
    typeBrief();
    fireEvent.click(generateButton());

    await waitFor(() =>
      expect(screen.getByRole("status").textContent ?? "").toMatch(/submitting the brief/i),
    );
    expect(screen.getByRole("status").textContent ?? "").not.toMatch(/\d+\s?%/);

    release();
    await screen.findByRole("heading", { level: 3, name: /design handoff/i });
  });
});

describe("PlaygroundPage — success", () => {
  it("announces a complete generation and shows the safe result content", async () => {
    await generateSuccessfully();

    expect(screen.getByRole("status").textContent ?? "").toMatch(/complete design handoff/i);

    // Design direction.
    expect(screen.getByText(/lead with the plan comparison/i)).toBeInTheDocument();

    // Key decisions — structured positions only.
    const decisions = screen.getByRole("list", { name: /key decisions/i });
    expect(within(decisions).getAllByRole("listitem")).toHaveLength(2);
    expect(decisions.textContent ?? "").toMatch(/corpus-evidence/);

    // Acceptance criteria.
    const criteria = screen.getByRole("list", { name: /acceptance criteria/i });
    expect(within(criteria).getAllByRole("listitem")).toHaveLength(2);
    expect(criteria.textContent ?? "").toMatch(/accessible name/i);

    // Aggregate evidence summary — counts, not identities.
    const evidence = screen.getByRole("region", { name: /evidence summary/i });
    expect(evidence.textContent ?? "").toMatch(/2/);
    expect(evidence.textContent ?? "").toMatch(/keyword/);
  });

  it("never puts a private marker, source identity, path, or evidence id in the DOM", async () => {
    await generateSuccessfully();
    const dom = document.body.textContent ?? "";
    const html = document.body.innerHTML;

    for (const marker of [RAW_CORPUS_ID, PRIVATE_URL, PRIVATE_IMAGE_PATH, "images-private"]) {
      expect(dom).not.toContain(marker);
      expect(html).not.toContain(marker);
    }
    // Response-scoped evidence ids are aggregated to a count, never listed.
    expect(dom).not.toMatch(/evidence-\d/);
    // The producer's echo of the caller's own brief is not presented as a result.
    expect(screen.queryByText(/product context/i)).toBeNull();
  });

  it("writes nothing to localStorage or sessionStorage", async () => {
    const localSpy = vi.spyOn(window.localStorage, "setItem");
    const sessionSpy = vi.spyOn(window.sessionStorage, "setItem");
    await generateSuccessfully();
    expect(localSpy).not.toHaveBeenCalled();
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it("logs nothing to the console", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const infos = vi.spyOn(console, "info").mockImplementation(() => {});
    const warns = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await generateSuccessfully();
    expect(logs).not.toHaveBeenCalled();
    expect(infos).not.toHaveBeenCalled();
    expect(warns).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("PlaygroundPage — downloads reuse the returned bytes", () => {
  it("downloads markdown and JSON without a second generation request", async () => {
    const harness = await generateSuccessfully();
    const callsAfterGenerate = harness.calls.length;
    expect(callsAfterGenerate).toBe(2); // GET /api/csrf + POST /api/create-ui-spec

    fireEvent.click(screen.getByRole("button", { name: /download design\.md/i }));
    fireEvent.click(screen.getByRole("button", { name: /download design\.json/i }));

    // THE critical property: no further request of any kind.
    expect(harness.calls).toHaveLength(callsAfterGenerate);

    expect(downloadedNames).toEqual(["DESIGN.md", "DESIGN.json"]);
    expect(await downloadedBlobs[0].text()).toBe(MARKDOWN_BYTES);
    expect(await downloadedBlobs[1].text()).toBe(JSON_BYTES);
  });

  it("repeated downloads keep producing the same reviewed bytes", async () => {
    const harness = await generateSuccessfully();
    const markdownButton = screen.getByRole("button", { name: /download design\.md/i });
    fireEvent.click(markdownButton);
    fireEvent.click(markdownButton);
    fireEvent.click(markdownButton);

    expect(harness.calls).toHaveLength(2);
    expect(await downloadedBlobs[0].text()).toBe(MARKDOWN_BYTES);
    expect(await downloadedBlobs[2].text()).toBe(MARKDOWN_BYTES);
  });

  it("shows the returned hashes so the operator can verify the saved bytes", async () => {
    await generateSuccessfully();
    const integrity = screen.getByRole("region", { name: /artifact integrity/i });
    expect(integrity.textContent ?? "").toContain(hash("d"));
    expect(integrity.textContent ?? "").toContain(hash("e"));
  });

  it("leads the integrity panel with the run-stable semantic hash", async () => {
    await generateSuccessfully();
    const region = screen.getByRole("region", { name: /artifact integrity/i });
    const terms = within(region).getAllByRole("term").map((term) => term.textContent ?? "");

    expect(terms[0]).toMatch(/semantic spec sha-256/i);
    expect(within(region).getByText(/include generation time/i)).toBeInTheDocument();
  });

  it("offers a copy-markdown action alongside the downloads", async () => {
    await generateSuccessfully();
    expect(screen.getByRole("button", { name: /copy markdown/i })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Review Important 2. The rendered markdown is NOT the allowlist projection, so
// no copy control may publish it into the DOM as selectable text. Both clipboard
// failure modes are exercised: the API rejecting (Chrome's "Document is not
// focused") and the API being absent entirely (no async clipboard).
// ---------------------------------------------------------------------------

describe("PlaygroundPage — copying the handoff never publishes it", () => {
  function installClipboard(writeText: ((data: string) => Promise<void>) | null): void {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      writable: true,
      value: writeText === null ? undefined : { writeText },
    });
  }

  afterEach(() => {
    installClipboard(null);
  });

  function expectNoHandoffBytesInTheDom(): void {
    const dom = document.body.textContent ?? "";
    const html = document.body.innerHTML;
    for (const marker of [RAW_CORPUS_ID, PRIVATE_URL, PRIVATE_IMAGE_PATH, "images-private"]) {
      expect(dom).not.toContain(marker);
      expect(html).not.toContain(marker);
    }
    // Not even a fragment of the rendering: the bytes are a clipboard/download
    // payload, never displayable content.
    expect(dom).not.toContain("## Techniques");
    expect(dom).not.toContain("Anchor the primary plan");
  }

  it("publishes nothing when the clipboard write REJECTS", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("Document is not focused");
    });
    installClipboard(writeText);
    await generateSuccessfully();

    fireEvent.click(screen.getByRole("button", { name: /copy markdown/i }));
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));

    expectNoHandoffBytesInTheDom();
    // The operator is told what to do instead, and the same bytes stay saveable.
    await waitFor(() =>
      expect(document.body.textContent ?? "").toMatch(/clipboard|download design\.md/i),
    );
    expect(screen.getByRole("button", { name: /download design\.md/i })).toBeEnabled();
  });

  it("publishes nothing when the async Clipboard API is absent", async () => {
    installClipboard(null);
    await generateSuccessfully();

    fireEvent.click(screen.getByRole("button", { name: /copy markdown/i }));
    await waitFor(() =>
      expect(document.body.textContent ?? "").toMatch(/clipboard|download design\.md/i),
    );

    expectNoHandoffBytesInTheDom();
  });

  it("copies the exact returned bytes when the clipboard works, and issues no request", async () => {
    const written: string[] = [];
    installClipboard(async (data: string) => {
      written.push(data);
    });
    const harness = await generateSuccessfully();
    const callsAfterGenerate = harness.calls.length;

    fireEvent.click(screen.getByRole("button", { name: /copy markdown/i }));
    await waitFor(() => expect(written).toEqual([MARKDOWN_BYTES]));

    expect(harness.calls).toHaveLength(callsAfterGenerate);
    expectNoHandoffBytesInTheDom();
  });
});

describe("PlaygroundPage — partial / fallback success", () => {
  it("discloses the deterministic producer even when retrieval succeeded", async () => {
    await generateSuccessfully(envelopeFixture({ producerVersion: "c3-fallback-v1" }));

    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toMatch(/no model attached/i);
    expect(status).toMatch(/declined by design/i);
  });

  it("names the fallback honestly and still offers both downloads", async () => {
    await generateSuccessfully(fallbackEnvelope());

    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toMatch(/fallback/i);
    expect(status).not.toMatch(/complete design handoff/i);

    // The unavailable fields are named, with the producer's reason.
    const unavailable = screen.getByRole("list", { name: /unavailable/i });
    expect(unavailable.textContent ?? "").toMatch(/colorTokens/);
    expect(unavailable.textContent ?? "").toMatch(/no motion evidence/i);

    // Warnings are surfaced.
    expect(screen.getByRole("list", { name: /warnings/i }).textContent ?? "").toMatch(
      /no corpus observation/i,
    );

    // Downloads remain available for a fallback artifact.
    expect(screen.getByRole("button", { name: /download design\.md/i })).toBeEnabled();
    expect(screen.getByRole("button", { name: /download design\.json/i })).toBeEnabled();
  });
});

describe("PlaygroundPage — warnings without a fallback", () => {
  // The REAL producer emits `motionEvidenceUnavailable` on essentially every run
  // that supplies no motion intents, while `fallbackUsed` stays false whenever
  // keyword retrieval matched. Collapsing "has warnings" into "used the
  // deterministic fallback" would therefore mislabel almost every genuine
  // keyword-matched artifact as a fallback.
  it("reports warnings without claiming the deterministic fallback ran", async () => {
    await generateSuccessfully(
      envelopeFixture({
        warnings: [
          {
            code: "motionEvidenceUnavailable",
            message: "Motion guidance is model-dependent; no motion direction was invented.",
          },
        ],
      }),
    );

    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toMatch(/warning/i);
    expect(status).not.toMatch(/fallback/i);
    expect(status).not.toMatch(/complete design handoff/i);
  });
});

describe("PlaygroundPage — an unmapped warning code still counts", () => {
  // Review Important 3: `successLabel` branches on the warning COUNT, so a future
  // producer code emitted alone must not make the live region announce a
  // "complete" handoff for an artifact the producer flagged as degraded.
  it("announces the warning even when its code is not in the client's closed set", async () => {
    await generateSuccessfully(
      envelopeFixture({
        warnings: [{ code: "imageEvidenceUnavailable", message: "A future producer code." }],
      }),
    );

    const status = screen.getByRole("status").textContent ?? "";
    expect(status).toMatch(/1 warning/);
    expect(status).not.toMatch(/complete design handoff/i);
    // The unmapped token itself is never rendered.
    expect(document.body.textContent ?? "").not.toContain("imageEvidenceUnavailable");
  });
});

describe("PlaygroundPage — the retrieval labels match the retrieval state", () => {
  // Review Minor 3: in the explicit-reference path `retrieval.resultCount` counts
  // RESOLVED REFERENCE TOKENS, not corpus observations — so "Corpus observations
  // retrieved: 2" beside "Retrieval: none / none" would be false.
  it("labels resolved reference tokens as such in the none/none state", async () => {
    await generateSuccessfully(
      envelopeFixture({
        retrieval: {
          mode: "none",
          modality: "none",
          resultCount: 2,
          fallbackUsed: false,
          attemptedCount: 0,
          attemptedModes: [],
        },
      }),
    );

    const evidence = screen.getByRole("region", { name: /evidence summary/i });
    expect(evidence.textContent ?? "").toMatch(/explicit references resolved/i);
    expect(evidence.textContent ?? "").not.toMatch(/corpus observations retrieved/i);
  });

  it("keeps the corpus label for a retrieved artifact", async () => {
    await generateSuccessfully();
    const evidence = screen.getByRole("region", { name: /evidence summary/i });
    expect(evidence.textContent ?? "").toMatch(/corpus observations retrieved/i);
  });
});

describe("PlaygroundPage — the local-server requirement", () => {
  // Review Important 4b. Static, always present, no probe and no extra request:
  // a hosted copy of this page has no `/api` to call, and the surface must say so
  // BEFORE the operator writes a brief and presses Generate.
  it("states the loopback-server requirement before any submission", () => {
    installFetch(successQueue());
    renderComposer();

    const requirement = screen.getByTestId("playground-requirement");
    expect(requirement.textContent ?? "").toMatch(/npm run ui/);
    expect(requirement.textContent ?? "").toMatch(/cannot generate/i);
  });

  // Review Important 4a. On a hosted copy `GET /api/csrf` answers with the host's
  // 404 (or its SPA fallback), which used to be reported as CSRF_REJECTED —
  // "the local server may have restarted", about a server that never existed.
  it("names the real cause when no local API answers at all", async () => {
    installFetch([{ status: 404, json: { message: "Not found" } }]);
    renderComposer();
    typeBrief();
    fireEvent.click(generateButton());

    await waitFor(() =>
      expect(screen.getByRole("status").textContent ?? "").toMatch(/npm run ui/),
    );
    const status = screen.getByRole("status").textContent ?? "";
    expect(status).not.toMatch(/restarted/i);
    expect(status).toMatch(/own machine|hosted copy/i);
  });
});

describe("PlaygroundPage — previously-shareable search URLs", () => {
  // Review Minor 4: `/playground?q=…` was a canonical shareable corpus-search URL
  // before the migration. Landing on the composer silently discarded the
  // parameters, so those URLs are forwarded to /browse with the query intact.
  function renderRoutes(entry: string): void {
    render(
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/playground" element={<PlaygroundPage />} />
          <Route path="/browse" element={<BrowseStub />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("forwards a search-bearing /playground URL to /browse with its query intact", () => {
    installFetch(successQueue());
    renderRoutes("/playground?q=pricing&category=pricing&platform=web");
    const stub = screen.getByTestId("browse-stub");
    expect(stub.textContent).toBe("/browse?q=pricing&category=pricing&platform=web");
  });

  it("keeps a plain /playground on the composer", () => {
    installFetch(successQueue());
    renderRoutes("/playground");
    expect(screen.queryByTestId("browse-stub")).toBeNull();
    expect(briefField()).toBeInTheDocument();
  });

  it("keeps /playground with an unrelated query on the composer", () => {
    installFetch(successQueue());
    renderRoutes("/playground?utm_source=newsletter");
    expect(screen.queryByTestId("browse-stub")).toBeNull();
    expect(briefField()).toBeInTheDocument();
  });
});

describe("PlaygroundPage — failure and retry", () => {
  it("gives explicit-reference 400s the automatic-retrieval remedy without rendering server text", async () => {
    installFetch([
      { status: 200, json: { nonce: NONCE } },
      {
        status: 400,
        json: {
          error: {
            code: "INVALID_INPUT",
            message: "server-only-diagnostic missing-reference-token",
            retryable: false,
          },
        },
      },
    ]);
    renderComposer();
    typeBrief();
    fireEvent.click(screen.getByText(/advanced: explicit reference override/i));
    fireEvent.change(screen.getByLabelText(/explicit reference/i), {
      target: { value: "missing-reference-token" },
    });
    fireEvent.click(generateButton());

    await waitFor(() =>
      expect(screen.getByRole("status").textContent ?? "").toMatch(
        /omit them to use automatic retrieval/i,
      ),
    );
    expect(screen.getByRole("status").textContent ?? "").not.toMatch(/missing-reference-token/i);
  });

  it("preserves the brief and offers retry on a retryable failure", async () => {
    installFetch([
      { status: 200, json: { nonce: NONCE } },
      {
        status: 503,
        json: { error: { code: "PROVIDER_ERROR", message: "server text", retryable: true } },
      },
    ]);
    renderComposer();
    typeBrief();
    fireEvent.click(generateButton());

    await waitFor(() => expect(screen.getByRole("status").textContent ?? "").toMatch(/could not/i));
    // The brief is intact.
    expect(briefField().value).toBe(BRIEF_TEXT);
    // Retry is offered, and the server's own message is never rendered.
    expect(screen.getByRole("button", { name: /try again/i })).toBeInTheDocument();
    expect(document.body.textContent ?? "").not.toContain("server text");
  });

  it("retries with the preserved brief and succeeds", async () => {
    // A 503 does not invalidate the nonce, so the retry re-uses the cached one
    // and issues a POST only — no second GET /api/csrf.
    const harness = installFetch([
      { status: 200, json: { nonce: NONCE } },
      { status: 503, json: { error: { code: "PROVIDER_ERROR", message: "x", retryable: true } } },
      { status: 200, json: envelopeFixture() },
    ]);
    renderComposer();
    typeBrief();
    fireEvent.click(generateButton());
    const retry = await screen.findByRole("button", { name: /try again/i });

    fireEvent.click(retry);
    await screen.findByRole("heading", { level: 3, name: /design handoff/i });
    expect(harness.calls.filter((c) => c.url === "/api/create-ui-spec")).toHaveLength(2);
  });

  it("offers no retry for a non-retryable input failure but keeps the brief", async () => {
    installFetch([
      { status: 200, json: { nonce: NONCE } },
      { status: 400, json: { error: { code: "INVALID_INPUT", message: "y", retryable: false } } },
    ]);
    renderComposer();
    typeBrief();
    fireEvent.click(generateButton());

    await waitFor(() =>
      expect(screen.getByRole("status").textContent ?? "").toMatch(/could not be accepted/i),
    );
    expect(screen.queryByRole("button", { name: /try again/i })).toBeNull();
    expect(briefField().value).toBe(BRIEF_TEXT);
  });

  it("refuses a response whose shape does not check out, and shows no artifact", async () => {
    const broken = envelopeFixture();
    delete broken.designJson;
    installFetch(successQueue(broken));
    renderComposer();
    typeBrief();
    fireEvent.click(generateButton());

    await waitFor(() =>
      expect(screen.getByRole("status").textContent ?? "").toMatch(/did not match/i),
    );
    expect(screen.queryByRole("heading", { level: 3, name: /design handoff/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /download design\.md/i })).toBeNull();
  });
});

describe("PlaygroundPage — start over", () => {
  it("clears the result and the brief and returns to the idle stage", async () => {
    await generateSuccessfully();

    fireEvent.click(screen.getByRole("button", { name: /start over/i }));

    expect(screen.queryByRole("heading", { level: 3, name: /design handoff/i })).toBeNull();
    expect(briefField().value).toBe("");
    expect(generateButton()).toBeDisabled();
    expect(screen.getByRole("status").textContent ?? "").toMatch(/idle/i);
  });
});
