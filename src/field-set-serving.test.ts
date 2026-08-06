import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server-factory.js";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";

const RECORD = { method: "image-confirmed", verifiedAt: "2026-08-05", verifierVersion: "fixture", imageSha256: "a".repeat(64) };

function verificationFor(fields: readonly string[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const field of fields) map[field] = RECORD;
  return map;
}

function entry(id: string, verifiedFor: readonly string[]): CorpusEntryT {
  return {
    id,
    title: `${id} title`,
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
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
    // No "dashboard" in the prose: Task 6 asserts the unverified patternType/
    // categories value never renders, and the critique is core (always served),
    // so the fixture prose must not carry the same string.
    critique: "CRITIQUE_MARKER_9f — a restrained layout that stays readable.",
    whatToSteal: ["STEAL_MARKER_9f — group the metric tiles on one baseline."],
    antiPatterns: { antiPatterns: ["ANTI_MARKER_9f — avoid stacking two shadow depths."], whereThisFails: [], accessibilityRisks: [] },
    voice: { tone: "VOICE_MARKER_9f — restrained", examples: ["Example copy"], avoid: [] },
    qualityTier: "exceptional", qualityScore: 4, reviewStatus: "approved", addedAt: "2026-07-01",
    provenance: { taggedBy: "auto", verification: verificationFor(verifiedFor) },
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

async function callTool(name: string, args: Record<string, unknown>, e: CorpusEntryT): Promise<string> {
  const server = createServer(readerWith(e));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "field-set-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    return content.map((c) => c.text ?? "").join("\n");
  } finally {
    await client.close();
  }
}

describe("get_ui_example — core + enrichment serving (2d-1)", () => {
  it("serves core + verified enrichment, omits unverified enrichment, and discloses it", async () => {
    const e = entry("gate-tool-entry", ["critique", "whatToSteal", "visual.colorRoles"]);
    const text = await callTool("get_ui_example", { id: "gate-tool-entry" }, e);
    expect(text).toContain("CRITIQUE_MARKER_9f");                 // core, always
    expect(text).toContain("STEAL_MARKER_9f");                    // verified enrichment
    expect(text).toContain("Color roles");                        // verified enrichment section
    expect(text).not.toContain("ANTI_MARKER_9f");                 // unverified enrichment — absent
    expect(text).not.toContain("VOICE_MARKER_9f");                // unverified enrichment — absent
    expect(text).not.toContain("Spacing density");                // unverified visual leaf — section absent
    expect(text).not.toContain("Corners");                        // unverified visual leaf — section absent
    expect(text).toContain("Unverified fields omitted");
    expect(text).toContain("antiPatterns");
  });

  it("excludes an entry whose core (critique) is unverified", async () => {
    const e = entry("gate-tool-entry", ["whatToSteal"]);
    const text = await callTool("get_ui_example", { id: "gate-tool-entry" }, e);
    expect(text).toMatch(/verif/i);
    expect(text).not.toContain("CRITIQUE_MARKER_9f");
  });
});

describe("get_ui_example — image attaches on any served field (2d-1)", () => {
  function publicImageEntry(id: string, verification: Record<string, unknown>): CorpusEntryT {
    return {
      ...entry(id, []),
      image: { visibility: "public", path: "images-public/gate.png", width: 1440, height: 900 },
      provenance: { taggedBy: "auto", verification },
    } as unknown as CorpusEntryT;
  }

  async function callWithFile(e: CorpusEntryT, file: string): Promise<string> {
    const server = createServer({ ...readerWith(e), resolveImagePath: () => file } as CorpusReader);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "field-set-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = await client.callTool({ name: "get_ui_example", arguments: { id: "gate-tool-entry" } });
      const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
      return content.map((c) => c.text ?? "").join("\n");
    } finally {
      await client.close();
    }
  }

  it("attaches when the only image-confirmed field is a served enrichment field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "image-attach-"));
    const file = join(dir, "gate.png");
    const bytes = Buffer.from("fake-png-bytes");
    writeFileSync(file, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const e = publicImageEntry("gate-tool-entry", {
      critique: RECORD, // image-confirmed with a NON-matching hash — no attach from core
      "visual.colorRoles": { ...RECORD, imageSha256: sha }, // served enrichment — attaches
    });
    const text = await callWithFile(e, file);
    expect(text).not.toContain("Image not attached");
  });

  it("does not attach when the image-confirmed field is outside the tool's served set", async () => {
    const dir = mkdtempSync(join(tmpdir(), "image-noattach-"));
    const file = join(dir, "gate.png");
    const bytes = Buffer.from("fake-png-bytes");
    writeFileSync(file, bytes);
    const sha = createHash("sha256").update(bytes).digest("hex");
    const e = publicImageEntry("gate-tool-entry", {
      critique: RECORD, // image-confirmed with a NON-matching hash
      platform: { ...RECORD, imageSha256: sha }, // NOT in get_ui_example's core ∪ enrichment
    });
    const text = await callWithFile(e, file);
    expect(text).toContain("Image not attached");
  });
});

describe("search_ui_examples — per-result projection (2d-1)", () => {
  it("attributes each result's omitted fields to the right result", async () => {
    const rich = entry("rich-1", ["critique", "whatToSteal"]);
    const thin = entry("thin-1", ["critique"]);
    const server = createServer({
      ...readerWith(rich),
      search: async () => [rich, thin],
    } as CorpusReader);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "field-set-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = await client.callTool({ name: "search_ui_examples", arguments: { query: "dashboard", limit: 3 } });
      const text = (res.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("\n");
      // rich-1: whatToSteal verified → steal marker present, only anti/categories/styleTags omitted.
      const richBlock = text.split("---")[0];
      expect(richBlock).toContain("STEAL_MARKER_9f");
      expect(richBlock).toContain("Unverified fields omitted: antiPatterns, categories, styleTags.");
      // thin-1: only critique verified → steal marker absent, disclosure names it.
      const thinBlock = text.split("---")[1] ?? text;
      expect(thinBlock).not.toContain("STEAL_MARKER_9f");
      expect(thinBlock).toContain("Unverified fields omitted: whatToSteal, antiPatterns, categories, styleTags.");
    } finally {
      await client.close();
    }
  });
});

describe("get_similar_ui_examples — source + result projection (2d-1)", () => {
  it("projects the source header and each result, disclosing omissions per result", async () => {
    const e = entry("gate-tool-entry", ["critique", "whatToSteal"]);
    const server = createServer(readerWith(e));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "field-set-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const res = await client.callTool({ name: "get_similar_ui_examples", arguments: { id: "gate-tool-entry", limit: 5 } });
      const text = (res.content ?? []).map((c) => (c as { text?: string }).text ?? "").join("\n");
      expect(text).toContain("CRITIQUE_MARKER_9f");
      expect(text).toContain("STEAL_MARKER_9f");
      // patternType/categories/styleTags unverified → header must be the fallback label.
      expect(text).toContain("### corpus example — ");
      expect(text).not.toContain("dashboard"); // the unverified patternType/category value
      expect(text).toContain("Unverified fields omitted: categories, styleTags, patternType.");
    } finally {
      await client.close();
    }
  });
});