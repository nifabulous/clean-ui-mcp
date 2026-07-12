/**
 * public-mcp-contract.test.ts — Task 5b (D20 / F5), Gate 1A Publication Integrity.
 *
 * The RUNTIME acceptance proof that no private data leaks through public mode.
 * Where public-import-boundary.test.ts (T5a) catches import-time violations
 * statically, THIS test catches runtime leaks through formatting, aggregation,
 * fallbacks, or image-path construction — by actually invoking every tool and
 * scanning its output.
 *
 * Strategy:
 *   1. Build a MIXED fixture corpus: one eligible-public entry, one private
 *      entry, and one public-but-unapproved entry. Each carries a UNIQUE marker
 *      string in its critique so a leak is unambiguous (the marker exists for
 *      exactly one purpose: to be detectable if it escapes).
 *   2. Export a public snapshot via `exportPublicSnapshot` (Task 3). The
 *      exporter runs the publication policy, so only the eligible entry ships.
 *   3. Construct a public-mode server IN-PROCESS via `createServer(reader)`
 *      with a `PublicCorpusReader` over that snapshot. No child process — the
 *      factory (Task 4a) is a pure module with no side effects.
 *   4. Connect a real MCP `Client` over an `InMemoryTransport` linked pair.
 *      This exercises the SAME JSON-RPC request → handler → response path a
 *      real client uses, but without stdio. The client's `callTool()` invokes
 *      each registered tool handler exactly as an external caller would.
 *   5. For EVERY tool response, assert the private and unapproved markers (and
 *      their entry ids) NEVER appear anywhere in the text/structured output,
 *      and that the eligible marker DOES appear where a search-style tool would
 *      surface it.
 *
 * The marker strings are deliberately distinct from those in
 * corpus-reader.test.ts (which uses `zenithcode`/`cobaltfox`/`quartzlynx`) so a
 * coincidence in one fixture can't mask a leak in the other.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CorpusEntryT } from "./schema.js";
import { PublicCorpusReader } from "./corpus-reader.js";
import { createServer } from "./server-factory.js";
import { exportPublicSnapshot } from "./publication/exporter.js";

// ─── F3 (round 2): stub the vision/synthesis deps so critique_ui runs offline ─
//
// critique_ui is the one tool that needs external API keys to run for real
// (the vision tagger → OpenAI/Anthropic, the image-embedding provider → Voyage,
// and the critique synthesis → text LLM). Without keys the handler threw at the
// first API call and the tool was skipped in this contract suite — leaving the
// full handler path (including the F2 getImageIndex leak guard) unverified in
// public mode.
//
// The mocks below stub the THREE modules that make network calls:
//   - ./tagger.js          → tagImage returns canned tagger facts.
//   - ./image-embeddings.js → createImageEmbeddingProvider returns a STUB provider
//                            (so the handler calls reader.getImageIndex(provider.model),
//                            which the PublicCorpusReader answers with null — the
//                            exact leak guard F2 introduced). embedImage is never
//                            called because imageIndex is null (structured fallback).
//   - ./critique-synthesis.js → synthesizeCritique returns a canned draft; the real
//                            gateCritique is preserved via importOriginal (it is pure
//                            and validates citations against the evidence set).
//
// Everything else (critique-ui validation, critique-retrieval over the injected
// reader, synthesis context/render/structured-output) runs for real. This proves
// the COMPLETE handler path runs in public mode without leaking private markers,
// AND that reader.getImageIndex() returns null (so no private corpus vectors are
// loaded). The mocks are safe for the other 13 tools: none of them import these
// three modules.
const tagImageStub = vi.hoisted(() => vi.fn());
vi.mock("./tagger.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tagger.js")>();
  return {
    ...actual,
    tagImage: tagImageStub,
  };
});

const createImageEmbeddingProviderStub = vi.hoisted(() => vi.fn());
vi.mock("./image-embeddings.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./image-embeddings.js")>();
  return {
    ...actual,
    createImageEmbeddingProvider: createImageEmbeddingProviderStub,
  };
});

const synthesizeCritiqueStub = vi.hoisted(() => vi.fn());
vi.mock("./critique-synthesis.js", async (importOriginal) => {
  // Preserve gateCritique (pure) — only synthesizeCritique makes a network call.
  const actual = await importOriginal<typeof import("./critique-synthesis.js")>();
  return {
    ...actual,
    synthesizeCritique: synthesizeCritiqueStub,
  };
});

// Reset the stubs between tests so canned return values don't leak across the
// critique_ui test (and so the stubs are in a clean state if the suite grows).
beforeEach(() => {
  tagImageStub.mockReset();
  createImageEmbeddingProviderStub.mockReset();
  synthesizeCritiqueStub.mockReset();
});

// ─── unique markers (distinct from corpus-reader.test.ts) ────────────────────
//
// Each marker is unique to ONE fixture entry and appears nowhere else in the
// corpus, so detecting it in a tool response proves that specific entry leaked.
// The `_9X2` / `_4K7` / `_2R1` suffixes make them grep-friendly and collision-
// proof against any real corpus word.
const ELIGIBLE_MARKER = "ELIGIBLE_MARKER_9X2";
const PRIVATE_MARKER = "PRIVATE_MARKER_4K7";
const UNAPPROVED_MARKER = "UNAPPROVED_MARKER_2R1";

const ELIGIBLE_ID = "gate-eligible-entry";
const PRIVATE_ID = "gate-private-entry";
const UNAPPROVED_ID = "gate-unapproved-entry";

const NOW = "2026-07-12T00:00:00.000Z";

// A real (tiny) PNG so the exporter's asset copy + hash both succeed for the
// eligible entry. The signature is what makes `image/png` detection work in
// get_ui_example's mimeType branch.
const PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // PNG signature
  ...new Array(32).fill(0), // minimal body
]);

/** Eligible publication block — every clearance-evidence field present. */
const eligiblePublication = {
  visibility: "public" as const,
  clearance: "approved" as const,
  rightsBasis: "owned" as const,
  evidenceRef: "docs/rights/gate-test.md",
  reviewedAt: "2026-06-01",
  reviewedBy: "gate-tester",
};

/**
 * Build a minimal-but-valid CorpusEntryT. `critique` is where the unique marker
 * lives — it's the field most likely to be reformatted/truncated/sliced by a
 * tool handler, so a marker there catches slicing leaks as well as full-text
 * leaks. The critique is also >80 chars to satisfy content-lint if it ever runs
 * over the fixture.
 */
function baseEntry(id: string, critique: string): CorpusEntryT {
  return {
    id,
    title: `${id} title`,
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: [],
    domainTags: ["analytics"],
    source: {
      productName: `${id}-product`,
      url: "https://example.com",
      capturedAt: "2026-07-01",
      capturedBy: "self",
    },
    image: {
      visibility: "public-own",
      path: `images-public/${id}.png`,
      width: 1440,
      height: 900,
    },
    visual: {
      dominantColors: ["#ffffff", "#111111"],
      accentColor: "#635bff",
      typePairing: { display: "Inter", body: "Inter" },
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
      usesShadows: false,
      usesBorders: true,
    },
    critique,
    whatToSteal: [`${id} stealable technique for dashboards`],
    antiPatterns: {
      antiPatterns: [`${id} antipattern to avoid`],
      whereThisFails: [],
      accessibilityRisks: [],
    },
    qualityTier: "exceptional",
    qualityScore: 4,
    reviewStatus: "approved",
    addedAt: "2026-07-01",
    publication: { ...eligiblePublication },
  } as CorpusEntryT;
}

interface ContractFixture {
  /** Connected MCP client — call tools through this. */
  client: Client;
  /** Absolute path to the committed snapshot dir (for debugging). */
  snapshotPath: string;
  /** Temp root — removed in afterEach/afterAll. */
  root: string;
}

/**
 * Build the mixed fixture, export the public snapshot, construct the public-mode
 * server in-process, and connect a Client over an in-memory transport pair.
 * Returns everything the tests need.
 */
async function buildContractFixture(): Promise<ContractFixture> {
  const root = mkdtempSync(join(tmpdir(), "gate-contract-test-"));
  const imageRoot = resolve(root, "images-public");
  const snapshotDir = resolve(root, "public-snapshots");
  mkdirSync(imageRoot, { recursive: true });
  mkdirSync(snapshotDir, { recursive: true });

  // Real source images for all three entries. The exporter copies assets ONLY
  // for eligible entries, but the ineligible entries still need a present file
  // so we're testing the policy filter (not a missing-file exclusion).
  writeFileSync(resolve(imageRoot, `${ELIGIBLE_ID}.png`), PNG_BYTES);
  writeFileSync(resolve(imageRoot, `${PRIVATE_ID}.png`), PNG_BYTES);
  writeFileSync(resolve(imageRoot, `${UNAPPROVED_ID}.png`), PNG_BYTES);

  const eligible = baseEntry(
    ELIGIBLE_ID,
    `This dashboard uses calm spacing, restrained contrast, and a very clear single visual hierarchy throughout the layout. ${ELIGIBLE_MARKER}`,
  );

  // Private entry: visibility=private → entry-private (and image-private below).
  const privateEntry: CorpusEntryT = {
    ...baseEntry(
      PRIVATE_ID,
      `Confidential client financials on this screen, visible only behind a login and never intended for open redistribution. ${PRIVATE_MARKER}`,
    ),
    publication: { ...eligiblePublication, visibility: "private" },
    image: {
      visibility: "private",
      path: `images-private/${PRIVATE_ID}.png`,
      width: 1440,
      height: 900,
    },
  } as CorpusEntryT;

  // Public-but-unapproved: clearance=unreviewed → clearance-unreviewed.
  const unapproved: CorpusEntryT = {
    ...baseEntry(
      UNAPPROVED_ID,
      `Pending legal sign-off before any redistribution; the clearance review has not yet been completed by the assigned reviewer. ${UNAPPROVED_MARKER}`,
    ),
    publication: { ...eligiblePublication, clearance: "unreviewed" },
  } as CorpusEntryT;

  const result = exportPublicSnapshot({
    corpusEntries: [eligible, privateEntry, unapproved],
    snapshotDir,
    imageRoot,
    now: NOW,
  });

  // Sanity: only the eligible entry shipped. If this fails, the leak isn't in
  // the reader/server — it's in the exporter, and that's a different test's job.
  expect(result.entryCount, "exporter must ship only the eligible entry").toBe(1);

  // Construct the public-mode reader + server IN-PROCESS. createServer is the
  // pure factory from Task 4a — importing it has no side effects, and it
  // registers all 14 tools against the injected reader.
  const reader = new PublicCorpusReader(result.snapshotPath);
  const server = createServer(reader);

  // Connect a real MCP Client to the server over an in-memory transport pair.
  // This is the SDK's blessed in-process mechanism: the pair links two
  // transports so messages flow client → server → client without stdio. The
  // client's callTool() sends a real tools/call JSON-RPC request, the server's
  // registered handler runs, and the response comes back — exactly the path a
  // remote client takes.
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "gate-contract-test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return { client, snapshotPath: result.snapshotPath, root };
}

/**
 * The full text of a tool response — concatenates every content item so a single
 * marker scan covers text blocks, image captions, and any structured fields
 * surfaced as text. Also stringifies the structuredContent (if any) so the
 * critique_ui path (which returns structuredContent) is covered too.
 */
function responseText(resp: { content?: Array<{ type: string; text?: string }>; structuredContent?: unknown }): string {
  const parts: string[] = [];
  for (const c of resp.content ?? []) {
    if (typeof c.text === "string") parts.push(c.text);
  }
  if (resp.structuredContent !== undefined) {
    try {
      parts.push(JSON.stringify(resp.structuredContent));
    } catch {
      // structuredContent with a circular ref would throw; fall through. None of
      // our tools produce that, but be defensive so the scan never silently
      // misses a field because JSON.stringify blew up.
    }
  }
  return parts.join("\n");
}

/**
 * The leak detector. The MARKER strings are the canonical leak signal: each
 * exists ONLY inside the critique text of one fixture entry that the reader
 * must not serve. If a marker appears in any tool's output, private/unapproved
 * critique content has escaped — a real Gate 1A publication-integrity bug.
 *
 * The entry IDS are a SEPARATE, weaker signal and are checked narrowly (see
 * `expectNoPrivateIds`) only for tools that ENUMERATE entries — i.e. tools that
 * surface entries the caller did NOT ask about by id (search, browse, the four
 * aggregations). For tools that take an id argument (get_ui_example,
 * get_similar, compare, generate_design_prompt), the handler legitimately
 * echoes a caller-supplied id in a "not found" message; that's the caller's own
 * input being reflected, not a disclosure. The marker check still guards those
 * paths: if the handler ever returned the actual entry's critique, the marker
 * would surface and this check would fire.
 */
function expectNoPrivateMarkers(text: string, context: string): void {
  for (const needle of [PRIVATE_MARKER, UNAPPROVED_MARKER]) {
    if (text.includes(needle)) {
      throw new Error(
        `LEAK in ${context}: output contains "${needle}".\n` +
        `This is a real Gate 1A publication-integrity bug — a private or ` +
        `unapproved fixture marker surfaced through a public-mode tool.\n` +
        `--- output (truncated to 2000 chars) ---\n${text.slice(0, 2000)}`,
      );
    }
  }
}

/**
 * The enumeration-tool leak detector. For tools that list entries the caller did
 * NOT name (search, browse, aggregations), surfacing a private/unapproved id at
 * all is itself a disclosure — the caller never supplied that id, so its
 * presence means the reader served an entry it shouldn't have. This is checked
 * IN ADDITION to the marker scan, because an id can appear without its critique
 * (e.g. in a sources/exemplar column).
 */
function expectNoPrivateIds(text: string, context: string): void {
  for (const needle of [PRIVATE_ID, UNAPPROVED_ID]) {
    if (text.includes(needle)) {
      throw new Error(
        `LEAK in ${context}: output contains private/unapproved id "${needle}" ` +
        `in an enumeration result (caller did not supply it).\n` +
        `--- output (truncated to 2000 chars) ---\n${text.slice(0, 2000)}`,
      );
    }
  }
}

/** Enumeration tools: both markers AND ids must be absent. */
function expectNoPrivateData(text: string, context: string): void {
  expectNoPrivateMarkers(text, context);
  expectNoPrivateIds(text, context);
}

// ─── the contract suite ──────────────────────────────────────────────────────

describe("public MCP contract — no private marker leaks through any tool path", () => {
  let f: ContractFixture;

  beforeAll(async () => {
    f = await buildContractFixture();
  }, 30_000);

  afterAll(async () => {
    try {
      await f?.client?.close();
    } catch { /* best effort */ }
    if (f?.root) {
      try { rmSync(f.root, { recursive: true, force: true }); } catch { /* best effort */ }
    }
  });

  // Helper: call a tool by name + args and return the full response object.
  async function call(name: string, args: Record<string, unknown> = {}): Promise<{
    content?: Array<{ type: string; text?: string }>;
    structuredContent?: unknown;
    isError?: boolean;
  }> {
    const resp = await f.client.callTool({ name, arguments: args });
    return resp as {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: unknown;
      isError?: boolean;
    };
  }

  // ── 1. search_ui_examples ──────────────────────────────────────────────────
  it("search_ui_examples: no private marker; eligible marker surfaces for its query", async () => {
    // Query that should hit the eligible entry's critique (contains the marker).
    const hit = await call("search_ui_examples", { query: ELIGIBLE_MARKER, limit: 10 });
    const hitText = responseText(hit);
    expectNoPrivateData(hitText, "search_ui_examples (query=ELIGIBLE_MARKER)");
    expect(hitText).toContain(ELIGIBLE_ID);
    expect(hitText).toContain(ELIGIBLE_MARKER);

    // Query that ONLY a private/unapproved entry could match. If the reader
    // served them, the marker would surface. It must not.
    const privateQ = await call("search_ui_examples", { query: PRIVATE_MARKER, limit: 10 });
    expectNoPrivateData(responseText(privateQ), "search_ui_examples (query=PRIVATE_MARKER)");
    const unapprovedQ = await call("search_ui_examples", { query: UNAPPROVED_MARKER, limit: 10 });
    expectNoPrivateData(responseText(unapprovedQ), "search_ui_examples (query=UNAPPROVED_MARKER)");

    // A broad unfiltered search must also stay clean.
    const broad = await call("search_ui_examples", { limit: 20 });
    expectNoPrivateData(responseText(broad), "search_ui_examples (broad)");
  });

  // ── 2. get_ui_example ──────────────────────────────────────────────────────
  it("get_ui_example: eligible entry served; private/unapproved ids rejected cleanly", async () => {
    const eligible = await call("get_ui_example", { id: ELIGIBLE_ID });
    const eligibleText = responseText(eligible);
    expect(eligibleText).toContain(ELIGIBLE_MARKER);
    expectNoPrivateData(eligibleText, "get_ui_example (id=ELIGIBLE_ID)");

    // Direct lookup of a private/unapproved id must not leak the entry's
    // critique/marker. (The handler echoes the caller-supplied id in a
    // "not found" message — that's the caller's own input, not a disclosure,
    // so we check markers, not ids, for id-taking tools.)
    const privateGet = await call("get_ui_example", { id: PRIVATE_ID });
    expectNoPrivateMarkers(responseText(privateGet), "get_ui_example (id=PRIVATE_ID)");
    const unapprovedGet = await call("get_ui_example", { id: UNAPPROVED_ID });
    expectNoPrivateMarkers(responseText(unapprovedGet), "get_ui_example (id=UNAPPROVED_ID)");
  });

  // ── 3-5. list_categories / list_style_tags / list_domain_tags ──────────────
  it("list_categories: no private id leaks; reports the eligible entry's category", async () => {
    const resp = await call("list_categories", {});
    const text = responseText(resp);
    expect(text).toContain("dashboard");
    expectNoPrivateData(text, "list_categories");
  });

  it("list_style_tags: no private id leaks", async () => {
    const resp = await call("list_style_tags", {});
    expectNoPrivateData(responseText(resp), "list_style_tags");
  });

  it("list_domain_tags: no private id leaks", async () => {
    const resp = await call("list_domain_tags", {});
    expectNoPrivateData(responseText(resp), "list_domain_tags");
  });

  // ── 6. get_similar_ui_examples ─────────────────────────────────────────────
  it("get_similar_ui_examples: returns the documented unavailable message; no leaks", async () => {
    // Public mode has no embedding index (D19), so this returns the "no index"
    // message rather than similar entries. The source entry lookup goes through
    // reader.getById, so a private id is rejected before any text is formatted.
    const eligibleSrc = await call("get_similar_ui_examples", { id: ELIGIBLE_ID, limit: 5 });
    expectNoPrivateMarkers(responseText(eligibleSrc), "get_similar_ui_examples (id=ELIGIBLE_ID)");

    const privateSrc = await call("get_similar_ui_examples", { id: PRIVATE_ID, limit: 5 });
    expectNoPrivateMarkers(responseText(privateSrc), "get_similar_ui_examples (id=PRIVATE_ID)");
  });

  // ── 7. compare_ui_examples ─────────────────────────────────────────────────
  it("compare_ui_examples: comparing eligible vs private/unapproved ids leaks nothing", async () => {
    // The handler looks each id up via reader.getById; private/unapproved ids
    // are missing from the snapshot and must not appear in the error or table.
    const mixed = await call("compare_ui_examples", {
      ids: [ELIGIBLE_ID, PRIVATE_ID, UNAPPROVED_ID],
    });
    expectNoPrivateMarkers(responseText(mixed), "compare_ui_examples (mixed ids)");
  });

  // ── 8. generate_design_prompt ──────────────────────────────────────────────
  it("generate_design_prompt: synthesizing across eligible + ineligible ids leaks nothing", async () => {
    // generateBrief runs over the FOUND entries; only the eligible id resolves,
    // so the brief cites just it. The missing-ids branch must name only ids the
    // caller supplied (those are the caller's own words, not a leak), but to be
    // safe we assert no marker text escapes regardless.
    const resp = await call("generate_design_prompt", {
      ids: [ELIGIBLE_ID, PRIVATE_ID, UNAPPROVED_ID],
    });
    expectNoPrivateMarkers(responseText(resp), "generate_design_prompt (mixed ids)");
  });

  // ── 9. recommend_ui_direction ──────────────────────────────────────────────
  it("recommend_ui_direction: public mode (no index) returns the unavailable message; no leaks", async () => {
    // PublicCorpusReader.indexStatus() reports hasIndex:false, so the handler
    // short-circuits to the "index hasn't been built" message. This is the
    // correct public-mode behavior — recommend REQUIRES vector search, which
    // would disclose private neighbors, so it's unavailable.
    const resp = await call("recommend_ui_direction", {
      productContext: "a calm analytics dashboard for a fintech",
    });
    expectNoPrivateData(responseText(resp), "recommend_ui_direction");
  });

  // ── 10. get_anti_patterns ──────────────────────────────────────────────────
  it("get_anti_patterns: aggregation over the snapshot leaks nothing", async () => {
    const resp = await call("get_anti_patterns", { patternType: "dashboard", limit: 10 });
    expectNoPrivateData(responseText(resp), "get_anti_patterns");
  });

  // ── 11. get_color_palette ──────────────────────────────────────────────────
  it("get_color_palette: palette extraction over the snapshot leaks nothing", async () => {
    const resp = await call("get_color_palette", { patternType: "dashboard", limit: 10 });
    expectNoPrivateData(responseText(resp), "get_color_palette");
  });

  // ── 12. get_stealable_techniques ───────────────────────────────────────────
  it("get_stealable_techniques: technique collection over the snapshot leaks nothing", async () => {
    const resp = await call("get_stealable_techniques", { patternType: "dashboard", limit: 15 });
    expectNoPrivateData(responseText(resp), "get_stealable_techniques");
  });

  // ── 13. browse_ui_examples ─────────────────────────────────────────────────
  it("browse_ui_examples: corpus-by-pattern summary leaks nothing", async () => {
    const resp = await call("browse_ui_examples", {});
    expectNoPrivateData(responseText(resp), "browse_ui_examples");
    // The eligible entry is the only one in the snapshot, so it's the exemplar.
    expect(responseText(resp)).toContain(ELIGIBLE_ID);
  });

  // ── 14. critique_ui ────────────────────────────────────────────────────────
  //
  // F3 (round 2): critique_ui was previously SKIPPED because it needs vision API
  // keys (the tagger + synthesis deps). The vision deps are now stubbed at the
  // top of this file (tagImage, createImageEmbeddingProvider, synthesizeCritique)
  // so the COMPLETE handler path runs offline:
  //   validate → stub tagger → createImageEmbeddingProvider (stub) →
  //   reader.getImageIndex(provider.model) [returns null in public mode] →
  //   retrieveCritiqueEvidence (structured fallback over the snapshot) →
  //   stub synthesis → real gateCritique → structured output → markdown.
  //
  // The keystone assertion: the handler calls reader.getImageIndex(), the
  // PublicCorpusReader answers null (the F2 leak guard — no private corpus
  // vectors are loaded), and retrieval degrades to the structured fallback over
  // the snapshot. The output must contain no private/unapproved markers.
  it("critique_ui: full handler path runs in public mode; getImageIndex returns null; no private markers leak", async () => {
    // A real (tiny) base64 PNG so the input validator's base64 round-trip + size
    // checks pass and withValidatedImageFile can write the temp file the tagger
    // stub receives the path of.
    const imageB64 = PNG_BYTES.toString("base64");

    // Stub the tagger: return a canned TaggerOutput-shaped object. The handler
    // only reads a few fields (patternType, platform, visual.*) via
    // toNormalizedTaggerFacts, so a minimal-but-typed object suffices.
    tagImageStub.mockResolvedValue({
      id: "screenshot",
      title: "Screenshot",
      patternType: "dashboard",
      platform: "web",
      categories: ["dashboard"],
      styleTags: ["minimal"],
      components: ["sidebar"],
      domainTags: ["analytics"],
      source: { productName: "Screenshot", url: null, capturedAt: "2026-07-12", capturedBy: "self" },
      image: { visibility: "private", path: "screenshot.png", width: 1440, height: 900 },
      visual: {
        dominantColors: ["#ffffff", "#111111"],
        accentColor: "#635bff",
        colorRoles: { canvas: "#ffffff", surface: "#f5f5f5", ink: "#111111", muted: "#999999", accent: "#635bff" },
        typePairing: { display: "Inter", body: "Inter", notes: "" },
        spacingDensity: "moderate",
        cornerStyle: "slight-round",
        usesShadows: false,
        usesBorders: true,
      },
      critique: "",
      whatToSteal: [],
      antiPatterns: { antiPatterns: [], whereThisFails: [], accessibilityRisks: [] },
      qualityTier: "exceptional",
      qualityScore: 4,
      addedAt: "2026-07-12",
    });

    // Stub the image-embedding provider: return a stub provider so the handler
    // takes the `imageProvider` truthy branch and calls
    // reader.getImageIndex(provider.model). The PublicCorpusReader answers null
    // (no public corpus index), so retrieval uses the structured fallback. The
    // stub's embedImage is never called (the image branch is skipped when
    // imageIndex is null) — the provider exists solely to drive the
    // getImageIndex call, which is the F2 leak guard under test.
    createImageEmbeddingProviderStub.mockReturnValue({
      name: "stub-voyage",
      model: "voyage-multimodal-3",
      embedImage: vi.fn().mockResolvedValue([0.1, 0.2, 0.3, 0.4]),
    });

    // Stub the synthesis: return a canned draft. The real gateCritique (preserved
    // via importOriginal) validates the draft's citations against the evidence
    // set built by buildSynthesisContext, so the draft's evidence IDs must be
    // real screen: facts the context registers (patternType, components, etc.).
    synthesizeCritiqueStub.mockResolvedValue({
      summary: "A restrained dashboard with a clear hierarchy.",
      observations: ["The sidebar organizes navigation well."],
      recommendations: [
        {
          observation: "Contrast is adequate.",
          impact: "Readability.",
          recommendation: "Keep the current contrast ratio.",
          evidence: ["screen:patternType"],
        },
      ],
      accessibilityRisks: [],
      visualSlop: [],
      motion: [],
    });

    const resp = await call("critique_ui", {
      image_data: imageB64,
      image_mime_type: "image/png",
      product_context: "a calm analytics dashboard",
      platform: "web",
    });

    const text = responseText(resp);

    // The handler must NOT surface a private/unapproved marker. The retrieval
    // ran over the public snapshot (structured fallback because getImageIndex
    // returned null), so only the eligible entry could appear as evidence.
    expectNoPrivateMarkers(text, "critique_ui");

    // The handler must NOT return an error — the full path (including the
    // getImageIndex null-answer) must complete cleanly in public mode.
    expect(resp.isError, `critique_ui returned an error: ${text.slice(0, 500)}`).toBeFalsy();

    // The tagger stub WAS called (the handler reached the tagger step).
    expect(tagImageStub).toHaveBeenCalledTimes(1);
    // The provider stub WAS called (the handler reached the getImageIndex step).
    expect(createImageEmbeddingProviderStub).toHaveBeenCalledTimes(1);
    // The synthesis stub WAS called (the handler reached the synthesis step).
    expect(synthesizeCritiqueStub).toHaveBeenCalledTimes(1);

    // KEYSTONE (F2 leak guard): retrieval used the STRUCTURED FALLBACK path,
    // which only happens when reader.getImageIndex() returned null (no image
    // index available). If the public reader had leaked the private corpus
    // index, retrieval would have taken the "image" mode and ranked against
    // private vectors. Asserting fallbackUsed + structured-fallback mode here
    // proves the getImageIndex null-answer held end-to-end through the handler.
    const structured = resp.structuredContent as Record<string, unknown> | undefined;
    expect(structured, "critique_ui must return structuredContent").toBeDefined();
    expect(structured!.retrievalMode, "retrieval must be structured-fallback (imageIndex was null)").toBe("structured-fallback");
    expect(structured!.fallbackUsed, "fallbackUsed must be true (no image index in public mode)").toBe(true);
  });
});
