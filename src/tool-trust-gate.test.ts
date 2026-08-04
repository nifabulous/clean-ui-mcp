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
            verification: {
              method: "image-confirmed",
              verifiedAt: "2026-08-04",
              verifierVersion: "tool-gate-fixture",
              imageSha256: "a".repeat(64),
            },
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
  { tool: "search_ui_examples", args: { query: "dashboard", limit: 3 }, needle: "gate-tool-entry" },
  // The needle is CORPUS CONTENT, never the caller's own input: these two echo
  // the requested id back in their not-found message, so an id needle would
  // report a leak that is just the argument coming home.
  { tool: "get_ui_example", args: { id: "gate-tool-entry" }, needle: "restrained dashboard" },
  { tool: "get_anti_patterns", args: { limit: 5 }, needle: "shadow depths" },
  { tool: "get_color_palette", args: { limit: 5 }, needle: "#2563eb" },
  { tool: "browse_ui_examples", args: {}, needle: "gate-tool-entry" },
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
  it("distinguishes 'nothing verified' from 'your filters were too narrow'", async () => {
    // Same false-reason class as create_ui_spec's unavailableDecisions: blaming
    // the caller's filters when the real cause is that nothing is verified sends
    // them off to broaden a query that was never the problem.
    const served = await callTool(false, "get_stealable_techniques", { limit: 5 });
    expect(served).toMatch(/verif/i);
    expect(served).toMatch(/0 of 1/);
  });
});
