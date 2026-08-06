import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "./server-factory.js";
import type { CorpusReader } from "./corpus-reader.js";
import type { CorpusEntryT } from "./schema.js";

// Every gated field value carries its own sentinel so the sweep can tell WHICH
// field leaked. Enum/boolean leaves (patternType, categories, styleTags,
// spacingDensity, cornerStyle, usesShadows, usesBorders) cannot carry sentinels
// (schema-enforced enums) — the sweep asserts their SECTIONS are absent instead.
const S = {
  critique: "SENTINEL_CRITIQUE",
  whatToSteal: "SENTINEL_STEAL",
  antiPatterns: "SENTINEL_ANTI",
  antiPatternsAccessibilityRisks: "SENTINEL_A11Y",
  voice: "SENTINEL_VOICE",
  visualDominantColors: "SENTINEL_DOMINANT",
  visualAccentColor: "SENTINEL_ACCENT",
  visualColorRoles: "SENTINEL_ROLES",
  visualTypePairing: "SENTINEL_TYPE",
} as const;

const RECORD = { method: "image-confirmed", verifiedAt: "2026-08-05", verifierVersion: "sweep", imageSha256: "a".repeat(64) };

function entry(verifiedFor: readonly string[]): CorpusEntryT {
  const verification: Record<string, unknown> = {};
  for (const field of verifiedFor) verification[field] = RECORD;
  return {
    id: "sweep-entry",
    title: "SweepCo",
    patternType: "dashboard",
    categories: ["dashboard"],
    styleTags: ["minimal"],
    components: ["kpi-card"],
    domainTags: ["analytics"],
    source: { productName: "SweepCo", url: "https://sweep.example.com", capturedAt: "2026-07-01", capturedBy: "self" },
    image: { visibility: "private", path: "images-private/sweep.png", width: 1440, height: 900 },
    visual: {
      dominantColors: [S.visualDominantColors],
      accentColor: S.visualAccentColor,
      colorRoles: { canvas: S.visualColorRoles, surface: S.visualColorRoles, ink: S.visualColorRoles, muted: S.visualColorRoles, accent: S.visualColorRoles },
      typePairing: { display: S.visualTypePairing, body: S.visualTypePairing },
      spacingDensity: "moderate", cornerStyle: "slight-round",
      usesShadows: false, usesBorders: true,
    },
    critique: S.critique,
    whatToSteal: [S.whatToSteal],
    antiPatterns: {
      antiPatterns: [S.antiPatterns],
      whereThisFails: [],
      accessibilityRisks: [{ element: "button", risk: S.antiPatternsAccessibilityRisks, evidence: "measured", wcag: ["1.4.3"] }],
    },
    voice: { tone: S.voice, examples: ["example"], avoid: [] },
    qualityTier: "exceptional", qualityScore: 4, reviewStatus: "approved", addedAt: "2026-07-01",
    provenance: { taggedBy: "auto", verification },
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
    indexStatus: () => ({ indexed: 0, total: 1, hasIndex: true, missing: 1, stale: 0, contentStale: 0 }),
    entriesForAggregation: () => [e],
    resolveImagePath: () => null,
    getImageIndex: async () => null,
  } as unknown as CorpusReader;
}

async function callTool(name: string, args: Record<string, unknown>, e: CorpusEntryT): Promise<string> {
  const server = createServer(readerWith(e));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "sweep-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
    return content.map((c) => c.text ?? "").join("\n");
  } finally {
    await client.close();
  }
}

// Verification: core + ONE enrichment field (whatToSteal). Every other
// enrichment field the split tools render is unverified and must not appear.
const VERIFIED = ["critique", "whatToSteal", "visual.colorRoles"];

// Sentinel fields each tool renders, in its gate set (marker-capable only).
const TOOL_MARKER_FIELDS: Record<string, readonly string[]> = {
  get_ui_example: ["whatToSteal", "antiPatterns", "antiPatterns.accessibilityRisks", "voice", "visual.dominantColors", "visual.accentColor", "visual.colorRoles", "visual.typePairing"],
  search_ui_examples: ["whatToSteal", "antiPatterns"],
  get_similar_ui_examples: ["whatToSteal"],
};

// Section substrings that must be ABSENT when the corresponding leaf is
// unverified (enum/boolean leaves the sentinels cannot reach).
const TOOL_ABSENT_SECTIONS: Record<string, readonly string[]> = {
  // "Color roles" excluded: the 2d-2 sweep verifies visual.colorRoles, so the
  // section legitimately renders (see VERIFIED below).
  get_ui_example: ["Dominant colors", "Accent:", "Type pairing", "Spacing density", "Corners:", "Shadows:", "Borders:"],
  search_ui_examples: ["### "],
  // The similar tool ALWAYS prints a "### ..." header; the projected header
  // falls back to "corpus example", so assert the unverified enum VALUE
  // (patternType/categories) never appears instead.
  get_similar_ui_examples: ["dashboard"],
};

const TOOL_ARGS: Record<string, Record<string, unknown>> = {
  get_ui_example: { id: "sweep-entry" },
  search_ui_examples: { query: "dashboard", limit: 3 },
  get_similar_ui_examples: { id: "sweep-entry", limit: 5 },
  get_stealable_techniques: { limit: 5 },
  get_anti_patterns: { limit: 5 },
  get_color_palette: { limit: 5 },
  browse_ui_examples: {},
  compare_ui_examples: { ids: ["sweep-entry", "sweep-entry"] },
};

describe("cross-tool invariant sweep — no emitted field is unverified", () => {
  it("never emits an unverified field value from any gated tool", async () => {
    const e = entry(VERIFIED);
    const allSentinels = Object.values(S);
    for (const [tool, args] of Object.entries(TOOL_ARGS)) {
      const text = await callTool(tool, args, e);
      const markerFields = TOOL_MARKER_FIELDS[tool] ?? [];
      for (const sentinel of allSentinels) {
        const field = Object.keys(S).find((k) => S[k as keyof typeof S] === sentinel)!;
        const gatedKey =
          field === "antiPatternsAccessibilityRisks" ? "antiPatterns.accessibilityRisks"
          : field === "visualDominantColors" ? "visual.dominantColors"
          : field === "visualAccentColor" ? "visual.accentColor"
          : field === "visualColorRoles" ? "visual.colorRoles"
          : field === "visualTypePairing" ? "visual.typePairing"
          : field;
        const shouldAppear = VERIFIED.includes(gatedKey) && markerFields.includes(gatedKey);
        if (shouldAppear) {
          expect(text, `${tool} should serve verified ${gatedKey}`).toContain(sentinel);
        } else if (markerFields.includes(gatedKey)) {
          expect(text, `${tool} leaked unverified ${gatedKey}`).not.toContain(sentinel);
        }
      }
      for (const section of TOOL_ABSENT_SECTIONS[tool] ?? []) {
        expect(text, `${tool} rendered unverified section "${section}"`).not.toContain(section);
      }
      // The disclosure is the sole "exists but unverified" signal.
      if ((TOOL_MARKER_FIELDS[tool] ?? []).length > 0) {
        expect(text).toContain("Unverified fields omitted");
      }
    }
  });
});

describe("2d-2 synthesis tools serve partial entries with disclosure, never unverified values", () => {
  it("compare, palette and recommend serve a partial entry and disclose, with no sentinel leak", async () => {
    const e = entry(VERIFIED);
    const cases: Array<{ tool: string; args: Record<string, unknown> }> = [
      { tool: "compare_ui_examples", args: { ids: ["sweep-entry", "sweep-entry"] } },
      { tool: "get_color_palette", args: { limit: 5 } },
      { tool: "recommend_ui_direction", args: { productContext: "A calm analytics dashboard", count: 1 } },
    ];
    // Sentinel fields each tool actually RENDERS from verified values. A verified
    // field the tool never renders (e.g. critique in a palette) must not be
    // required to appear.
    const TOOL_VERIFIED_CONTAINS: Record<string, readonly string[]> = {
      compare_ui_examples: ["critique", "whatToSteal", "visual.colorRoles"],
      get_color_palette: ["visual.colorRoles"],
      recommend_ui_direction: ["whatToSteal", "visual.colorRoles"],
    };
    for (const { tool, args } of cases) {
      const text = await callTool(tool, args, e);
      for (const [field, sentinel] of Object.entries(S)) {
        const gatedKey =
          field === "antiPatternsAccessibilityRisks" ? "antiPatterns.accessibilityRisks"
          : field === "visualDominantColors" ? "visual.dominantColors"
          : field === "visualAccentColor" ? "visual.accentColor"
          : field === "visualColorRoles" ? "visual.colorRoles"
          : field === "visualTypePairing" ? "visual.typePairing"
          : field;
        const shouldAppear = (TOOL_VERIFIED_CONTAINS[tool] ?? []).includes(gatedKey);
        if (shouldAppear) {
          expect(text, `${tool} should serve verified ${gatedKey}`).toContain(sentinel);
        } else {
          expect(text, `${tool} leaked unverified or non-rendered ${gatedKey}`).not.toContain(sentinel);
        }
      }
      expect(text, `${tool} served a partial entry without disclosing`).toMatch(
        /Unverified fields omitted|Drawn from|Pattern label omitted|Column disclosures/,
      );
    }
  });

  it("byte-identical pin: a fully-verified fixture renders today's output with no disclosure artifacts", async () => {
    // The pin is palette-scoped: verify colorRoles (core) AND patternType (the
    // only palette enrichment) so the label renders exactly as it did pre-2d-2.
    const e = entry(["visual.colorRoles", "patternType"]);
    const text = await callTool("get_color_palette", { limit: 5 }, e);
    expect(text).toContain("**dashboard**");
    expect(text).not.toContain("Pattern label omitted");
    expect(text).not.toContain("Drawn from");
    expect(text).not.toContain("Column disclosures");
  });
});
