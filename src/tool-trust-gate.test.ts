/**
 * tool-trust-gate.test.ts — every corpus-reading tool refuses unverified entries.
 *
 * A review found the C3 trust gate held for `create_ui_spec` alone: eleven
 * sibling tools served the same corpus fabrications untouched. Nothing in the
 * suite noticed, because no test asserted what those tools actually serve — so
 * gating them broke nothing and would have un-gated just as quietly.
 *
 * This file is that missing assertion. It drives the real `createServer` with a
 * one-entry corpus and checks BOTH directions per tool: unverified serves
 * nothing, verified serves. A regression (wiring a tool to the ungated `reader`)
 * fails here loudly.
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server-factory.js";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";

const MARKER = "STEALABLE_MARKER_7Q4";

function verificationFor(fields: readonly string[]): Record<string, unknown> {
  const record = { method: "measured", verifiedAt: "2026-08-04", verifierVersion: "tool-gate-fixture" };
  const map: Record<string, unknown> = {};
  for (const field of fields) map[field] = record;
  return map;
}

const ALL_SERVABLE_FIELDS = [
  "critique", "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks",
  "voice", "visual.dominantColors", "visual.accentColor", "visual.colorRoles",
  "visual.typePairing", "visual.spacingDensity", "visual.cornerStyle",
  "visual.usesShadows", "visual.usesBorders", "layout", "patternType",
  "platform", "categories", "styleTags", "domainTags",
] as const;

function entry(verified: boolean): CorpusEntryT {
  return {
    id: "gate-tool-entry",
    title: "GateCo — dashboard",
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: ["kpi-card"],
    domainTags: ["analytics"],
    source: { productName: "GateCo", url: "https://gateco.example.com", capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "images-private/gate.png", width: 1440, height: 900 },
    visual: {
      dominantColors: ["#ffffff", "#111111"],
      accentColor: "#2563eb",
      colorRoles: { canvas: "#ffffff", surface: "#f8fafc", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
      typePairing: { display: "Inter", body: "Inter" },
      spacingDensity: "moderate", cornerStyle: "slight-round",
      usesShadows: false, usesBorders: true,
    },
    critique: "A restrained dashboard that leans on quiet borders and a tight type scale to keep a dense layout readable.",
    whatToSteal: [`Group the metric tiles on one baseline. ${MARKER}`],
    antiPatterns: { antiPatterns: ["Avoid stacking two shadow depths."], whereThisFails: [], accessibilityRisks: [] },
    qualityTier: "exceptional", qualityScore: 4, reviewStatus: "approved", addedAt: "2026-07-01",
    ...(verified
      ? {
          provenance: {
            taggedBy: "auto",
            verification: verificationFor(ALL_SERVABLE_FIELDS),
          },
        }
      : {}),
  } as unknown as CorpusEntryT;
}

function readerWith(e: CorpusEntryT): CorpusReader {
  return {
    search: async () => [e],
    searchRanked: async () => [{ entry: e, score: 5, searchMode: "keyword" as const }],
    getById: (id: string) => (id === e.id ? e : undefined),
    findSimilar: () => [{ entry: e, score: 1 }],
    listCategories: () => ["dashboard"],
    listStyleTags: () => ["minimal"],
    listDomainTags: () => ["analytics"],
    indexStatus: () => ({ indexed: 0, total: 1, hasIndex: false, missing: 1, stale: 0, contentStale: 0 }),
    entriesForAggregation: () => [e],
    resolveImagePath: () => null,
    getImageIndex: async () => null,
  } as unknown as CorpusReader;
}

async function callTool(verified: boolean, name: string, args: Record<string, unknown>): Promise<string> {
  const server = createServer(readerWith(entry(verified)));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "trust-gate-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    return content.map((c) => c.text ?? "").join("\n");
  } finally {
    await client.close();
  }
}

/**
 * Each case: the tool, its arguments, and a needle that appears ONLY when corpus
 * content is served. The needle is what an unverified corpus must never produce.
 */
const CASES: ReadonlyArray<{ tool: string; args: Record<string, unknown>; needle: string }> = [
  { tool: "get_stealable_techniques", args: { limit: 5 }, needle: MARKER },
  { tool: "search_ui_examples", args: { query: "dashboard", limit: 3 }, needle: "restrained dashboard" },
  // The needle is CORPUS CONTENT, never the caller's own input: these two echo
  // the requested id back in their not-found message, so an id needle would
  // report a leak that is just the argument coming home.
  { tool: "get_ui_example", args: { id: "gate-tool-entry" }, needle: "restrained dashboard" },
  { tool: "get_anti_patterns", args: { limit: 5 }, needle: "shadow depths" },
  { tool: "get_color_palette", args: { limit: 5 }, needle: "#2563eb" },
  { tool: "browse_ui_examples", args: {}, needle: "dashboard" },
  { tool: "get_similar_ui_examples", args: { id: "gate-tool-entry" }, needle: "restrained dashboard" },
];

// `recommend_ui_direction` is covered by the reader unit tests instead: its
// handler requires a built embedding index and returns a build-the-index message
// before it reaches the corpus, so a served-content needle cannot distinguish
// gated from index-missing here. Its corpus access is `searchRanked`, which
// TrustGatedCorpusReader filters (see corpus-trust-reader.test.ts).

describe("every corpus-reading tool refuses an unverified entry", () => {
  it.each(CASES)("$tool serves nothing corpus-derived", async ({ tool, args, needle }) => {
    const served = await callTool(false, tool, args);
    expect(served, `${tool} served corpus content from an UNVERIFIED entry`).not.toContain(needle);
  });

  // The other half of the gate. Without these, every assertion above would pass
  // with the tools simply broken, and un-gating would go unnoticed exactly as it
  // did before this file existed.
  it.each(CASES)("$tool DOES serve once the entry is verified", async ({ tool, args, needle }) => {
    const served = await callTool(true, tool, args);
    expect(served, `${tool} served nothing even though the entry is VERIFIED`).toContain(needle);
  });
});

describe("the identity leak the review found", () => {
  it("never prints a product name or entry id, verified or not", async () => {
    // get_stealable_techniques printed `source.product` and `source.id` beside
    // every technique — the exact identity every other served path withholds.
    // Trust does not buy an identity exemption, so this holds in BOTH directions.
    for (const verified of [false, true]) {
      const served = await callTool(verified, "get_stealable_techniques", { limit: 5 });
      expect(served, `verified=${verified}`).not.toContain("GateCo");
      expect(served, `verified=${verified}`).not.toContain("gate-tool-entry");
    }
  });
});

describe("gated tools say WHY, not 'no matches'", () => {
  // Every gated tool, not just the aggregation ones. Four tools reported "No
  // entry found with id X" about an entry that EXISTS — asserting non-existence
  // rather than withholding, which is a different and false claim.
  it.each([
    { tool: "get_stealable_techniques", args: { limit: 5 } },
    { tool: "get_ui_example", args: { id: "gate-tool-entry" } },
    { tool: "get_similar_ui_examples", args: { id: "gate-tool-entry" } },
    { tool: "compare_ui_examples", args: { ids: ["gate-tool-entry", "gate-tool-entry"] } },
    { tool: "search_ui_examples", args: { query: "dashboard" } },
    { tool: "get_anti_patterns", args: { limit: 5 } },
    { tool: "get_color_palette", args: { limit: 5 } },
    { tool: "browse_ui_examples", args: {} },
  ])("$tool names verification as the cause", async ({ tool, args }) => {
    const served = await callTool(false, tool, args);
    expect(served, `${tool} did not name verification`).toMatch(/verif/i);
    expect(served, `${tool} did not report the verified-of-total count`).toMatch(/0 of 1/);
  });

  it("never claims an entry does not exist when it exists but is unverified", async () => {
    for (const [tool, args] of [
      ["get_ui_example", { id: "gate-tool-entry" }],
      ["get_similar_ui_examples", { id: "gate-tool-entry" }],
      ["compare_ui_examples", { ids: ["gate-tool-entry", "gate-tool-entry"] }],
    ] as const) {
      const served = await callTool(false, tool, args as Record<string, unknown>);
      expect(served, tool).not.toMatch(/no entr(y|ies) found/i);
    }
  });

  it("distinguishes 'nothing verified' from 'your filters were too narrow'", async () => {
    // Same false-reason class as create_ui_spec's unavailableDecisions: blaming
    // the caller's filters when the real cause is that nothing is verified sends
    // them off to broaden a query that was never the problem.
    const served = await callTool(false, "get_stealable_techniques", { limit: 5 });
    expect(served).toMatch(/verif/i);
    expect(served).toMatch(/0 of 1/);
  });
});

describe("wiring regression detection", () => {
  it("every corpus-reading tool is wired to the GATED reader", async () => {
    // emptyCorpusMessage and unresolvedIdsMessage both branch on
    // `reader instanceof TrustGatedCorpusReader`, so a tool accidentally wired to
    // the plain reader would keep serving AND lose its honest message — a silent
    // revert. This asserts the wiring itself, from the outside: with an unverified
    // corpus, no gated tool may emit corpus content.
    for (const { tool, args, needle } of CASES) {
      const served = await callTool(false, tool, args);
      expect(served, `${tool} appears to be wired to the UNGATED reader`).not.toContain(needle);
    }
  });

  it("gates each tool on exactly the fields it renders", async () => {
    // `get_color_palette` serves colorRoles + patternType; an entry verified for
    // critique only must NOT reach it, while `get_stealable_techniques` must
    // still serve from the same entry (whatToSteal verified).
    const fixture = {
      ...entry(true),
      provenance: {
        taggedBy: "auto",
        verification: verificationFor(["critique", "whatToSteal"]),
      },
    };
    const server = createServer(readerWith(fixture));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "field-set-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const palette = await client.callTool({ name: "get_color_palette", arguments: { limit: 5 } });
      const paletteText = ((palette.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
      expect(paletteText).not.toContain("#2563eb");
      expect(paletteText).toMatch(/verif/i);
      const steal = await client.callTool({ name: "get_stealable_techniques", arguments: { limit: 5 } });
      const stealText = ((steal.content ?? []) as Array<{ text?: string }>).map((c) => c.text ?? "").join("\n");
      expect(stealText).toContain(MARKER);
    } finally {
      await client.close();
    }
  });
});

describe("the refusal messages read as English", () => {
  it("agrees in number for one id and for several", async () => {
    // Template rendering with REAL inputs, per CLAUDE.md: the first version of
    // this message served 'Entry "x" exist but carry no recorded verification'.
    const one = await callTool(false, "get_ui_example", { id: "gate-tool-entry" });
    expect(one).toMatch(/Entry "gate-tool-entry" exists but is not verified for every field this tool serves/);
    expect(one).toMatch(/visual\.colorRoles/);
    const many = await callTool(false, "compare_ui_examples", {
      ids: ["gate-tool-entry", "gate-tool-entry"],
    });
    expect(many).not.toMatch(/exist but carries|exists but carry/);
  });
});

describe("keyless redaction — retrieval tools", () => {
  // A verified-content entry must render its content and NOT its identity:
  // productName, url, id and title appear nowhere in the served bytes. The
  // redaction is a rendering property, not a trust field — this holds for the
  // VERIFIED direction, which is the only direction that returns content.
  it.each([
    { tool: "search_ui_examples", args: { query: "dashboard", limit: 3 }, content: "restrained dashboard" },
    { tool: "get_similar_ui_examples", args: { id: "gate-tool-entry" }, content: "restrained dashboard" },
    { tool: "compare_ui_examples", args: { ids: ["gate-tool-entry", "gate-tool-entry"] }, content: "restrained dashboard" },
  ])("$tool renders content without identity", async ({ tool, args, content }) => {
    const served = await callTool(true, tool, args);
    expect(served, `${tool} must still serve keyed content`).toContain(content);
    expect(served, `${tool} leaked productName`).not.toContain("GateCo");
    expect(served, `${tool} leaked source url`).not.toContain("gateco.example.com");
    expect(served, `${tool} leaked entry id`).not.toContain("gate-tool-entry");
    expect(served, `${tool} leaked title`).not.toContain("GateCo — dashboard");
  });
});
