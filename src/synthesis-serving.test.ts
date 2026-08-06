import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server-factory.js";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";

const RECORD = { method: "image-confirmed", verifiedAt: "2026-08-06", verifierVersion: "fixture", imageSha256: "a".repeat(64) };

function verificationFor(fields: readonly string[]): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  for (const field of fields) map[field] = RECORD;
  return map;
}

export function synthEntry(id: string, verifiedFor: readonly string[]): CorpusEntryT {
  return {
    id,
    title: `${id} title`,
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    source: { productName: `Product ${id}`, url: "https://example.com", capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "", width: 1440, height: 900 },
    visual: {
      dominantColors: ["#ffffff"],
      accentColor: "#2563eb",
      colorRoles: { canvas: "#ffffff", surface: "#f8fafc", ink: "#111827", muted: "#6b7280", accent: "#2563eb" },
      typePairing: { display: "Inter", body: "Inter", notes: "Clear hierarchy with restrained type weights." },
      spacingDensity: "moderate",
      cornerStyle: "slight-round",
      usesShadows: false,
      usesBorders: true,
    },
    layout: { form: "sidebar", regions: [{ role: "primary-nav", width: "240px" }] },
    platform: "web",
    critique: "SYNTH_CRITIQUE — a restrained layout that stays readable.",
    whatToSteal: ["SYNTH_STEAL — group metric tiles on one baseline."],
    // One a11y risk present so the FULLY-VERIFIED compare test can assert the
    // a11y row renders a value (an empty list would render "—" and break
    // `not.toContain("—")`).
    antiPatterns: { antiPatterns: ["SYNTH_ANTI — avoid stacking two shadow depths."], whereThisFails: [], accessibilityRisks: [{ element: "button", risk: "SYNTH_A11Y — low contrast", evidence: "measured", wcag: ["1.4.3"] }] },
    voice: { tone: "SYNTH_VOICE — restrained and confident", examples: ["Example"], avoid: [] },
    qualityTier: "exceptional",
    qualityScore: 4,
    reviewStatus: "approved",
    addedAt: "2026-07-01",
    provenance: { taggedBy: "auto", verification: verificationFor(verifiedFor) },
  } as unknown as CorpusEntryT;
}

export function synthReaderWith(e: CorpusEntryT): CorpusReader {
  return {
    search: async () => [e],
    searchRanked: async () => [{ entry: e, score: 5, searchMode: "vector" as const }],
    getById: (id: string) => (id === e.id ? e : undefined),
    findSimilar: () => [{ entry: e, score: 1 }],
    listCategories: () => ["dashboard"],
    listStyleTags: () => ["minimal"],
    listDomainTags: () => ["analytics"],
    indexStatus: () => ({ indexed: 1, total: 1, hasIndex: true, missing: 0, stale: 0, contentStale: 0 }),
    entriesForAggregation: () => [e],
    resolveImagePath: () => null,
    getImageIndex: async () => null,
  } as unknown as CorpusReader;
}

export async function callTool(name: string, args: Record<string, unknown>, e: CorpusEntryT): Promise<string> {
  const server = createServer(synthReaderWith(e));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "synthesis-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    return content.map((c) => c.text ?? "").join("\n");
  } finally {
    await client.close();
  }
}

describe("compare_ui_examples — 2d-2 projected cells", () => {
  it("renders — for unverified cells, never the 'web' platform default", async () => {
    const e = synthEntry("entry-a", ["critique", "whatToSteal"]);
    const text = await callTool("compare_ui_examples", { ids: ["entry-a", "entry-a"] }, e);
    expect(text).toContain("SYNTH_CRITIQUE");
    expect(text).not.toContain("SYNTH_ANTI");
    expect(text).not.toContain("SYNTH_VOICE");
    expect(text).not.toContain("web");
    expect(text).toContain("—");
    expect(text).toContain("_Column disclosures:_");
    expect(text).toContain("**entry-a**: Unverified fields omitted:");
  });

  it("renders byte-identically for a fully-verified entry (no disclosure block)", async () => {
    const all = [
      "critique", "whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks",
      "categories", "styleTags", "patternType", "platform", "layout",
      "visual.accentColor", "visual.colorRoles", "visual.spacingDensity",
      "visual.cornerStyle", "visual.usesShadows", "visual.usesBorders",
    ];
    const e = synthEntry("entry-a", all);
    const text = await callTool("compare_ui_examples", { ids: ["entry-a", "entry-a"] }, e);
    expect(text).toContain("| web |");
    expect(text).not.toContain("Column disclosures");
    // No em-dash-only CELL markers ("| —"): the header's " — " join separator
    // and the fixture prose ("SYNTH_A11Y — low contrast") legitimately contain
    // em dashes, so a blanket not.toContain("—") is unsatisfiable.
    expect(text).not.toContain("| —");
  });

  it("renders projected rows in concise mode with the column disclosure", async () => {
    const e = synthEntry("entry-a", ["critique", "whatToSteal"]);
    const text = await callTool("compare_ui_examples", { ids: ["entry-a", "entry-a"], responseFormat: "concise" }, e);
    expect(text).toContain("| platform |"); // concise keeps the platform row
    expect(text).toContain("_Column disclosures:_");
    expect(text).not.toContain("top steal"); // concise drops the detailed rows
    expect(text).not.toContain("a11y risks");
  });
});

describe("get_color_palette — 2d-2 nullable label", () => {
  it("serves the palette with the label omitted+disclosed when patternType is unverified", async () => {
    const e = synthEntry("pal-1", ["visual.colorRoles", "critique"]);
    const text = await callTool("get_color_palette", { limit: 5 }, e);
    expect(text).toContain("--accent:#2563eb");
    expect(text).not.toContain("**dashboard**");
    expect(text).toContain("_Pattern label omitted (unverified)._");
  });

  it("narrows a patternType filter to verified matches and names the filter key when empty", async () => {
    const e = synthEntry("pal-1", ["visual.colorRoles"]); // patternType unverified
    const text = await callTool("get_color_palette", { patternType: "dashboard", limit: 5 }, e);
    expect(text).not.toContain("#2563eb");
    // Brief regex /VERIFIED patternType/i was unsatisfiable against the brief's own
    // message ("...whose patternType label is VERIFIED..."); pin the actual sentence.
    expect(text).toMatch(/patternType label is VERIFIED/i);
  });
});

describe("recommend_ui_direction — 2d-2 projected brief", () => {
  it("serves a brief with coverage disclosures and no unverified enrichment", async () => {
    const e = synthEntry("rec-1", ["critique", "whatToSteal", "visual.colorRoles"]);
    const text = await callTool("recommend_ui_direction", { productContext: "A calm analytics dashboard", count: 1 }, e);
    expect(text).toContain("SYNTH_STEAL"); // verified core-derived technique
    expect(text).not.toContain("SYNTH_ANTI"); // unverified — absent
    expect(text).not.toContain("SYNTH_VOICE"); // unverified — absent
    expect(text).toContain("Drawn from"); // coverage disclosure present
  });

  it("does not leak an unverified patternType into the contribution note", async () => {
    const e = synthEntry("rec-1", ["critique", "whatToSteal", "visual.colorRoles"]);
    const text = await callTool("recommend_ui_direction", { productContext: "A calm analytics dashboard", count: 1 }, e);
    expect(text).not.toContain("color palette + dashboard"); // patternType unverified
  });

  it("renders byte-identically for a fully-verified entry (no coverage disclosures)", async () => {
    const all = [
      "critique", "whatToSteal", "visual.colorRoles", "visual.typePairing",
      "visual.spacingDensity", "visual.cornerStyle", "layout", "voice",
      "antiPatterns", "patternType", "styleTags",
    ];
    const e = synthEntry("rec-1", all);
    const text = await callTool("recommend_ui_direction", { productContext: "A calm analytics dashboard", count: 1 }, e);
    expect(text).toContain("SYNTH_STEAL");
    expect(text).not.toContain("Drawn from");
  });
});
