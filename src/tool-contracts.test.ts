import { describe, expect, it } from "vitest";
import {
  RetrievalState, Evidence,
  ToolInputSchemas, ToolDataSchemas, ToolResultSchemas,
  parseToolResult, UiSpec, ALLOWED_RETRIEVAL_STATES,
} from "./tool-contracts.js";
import { TOOL_CATALOG } from "./tool-catalog.js";

// ---------------------------------------------------------------------------
// Schema key coverage
// ---------------------------------------------------------------------------

describe("schema key coverage", () => {
  it("all schemas have keys == TOOL_CATALOG", () => {
    expect(Object.keys(ToolInputSchemas).sort()).toEqual([...TOOL_CATALOG].sort());
    expect(Object.keys(ToolDataSchemas).sort()).toEqual([...TOOL_CATALOG].sort());
    expect(Object.keys(ToolResultSchemas).sort()).toEqual([...TOOL_CATALOG].sort());
  });
});

// ---------------------------------------------------------------------------
// Retrieval matrix (follows plan, not spec)
// ---------------------------------------------------------------------------

describe("ALLOWED_RETRIEVAL_STATES (plan authoritative)", () => {
  it("taxonomy/get/compare/browse/research/spec: none only", () => {
    for (const t of ["get_ui_reference", "get_ui_taxonomy", "compare_ui_references", "browse_ui_patterns", "create_ui_spec", "research_ui_anti_patterns", "research_ui_palettes", "research_ui_techniques"]) {
      const states = ALLOWED_RETRIEVAL_STATES[t];
      expect(states.every(s => s.mode === "none")).toBe(true);
    }
  });
  it("similar: vector+text and structured-fallback, NO image, NO keyword", () => {
    const modes = ALLOWED_RETRIEVAL_STATES["find_similar_ui_references"].map(s => `${s.mode}/${s.modality}`);
    expect(modes).toContain("vector/text");
    expect(modes).not.toContain("vector/image");
    expect(modes).not.toContain("keyword/text");
    expect(modes).not.toContain("keyword/metadata");
  });
  it("critique: vector+image and structured-fallback, NO vector+text", () => {
    const modes = ALLOWED_RETRIEVAL_STATES["critique_ui"].map(s => `${s.mode}/${s.modality}`);
    expect(modes).toContain("vector/image");
    expect(modes).not.toContain("vector/text");
  });
  it("plan: hybrid/keyword/structured-fallback, NO direct vector", () => {
    const modes = ALLOWED_RETRIEVAL_STATES["plan_ui_direction"].map(s => `${s.mode}/${s.modality}`);
    expect(modes).toContain("hybrid/text");
    expect(modes).not.toContain("vector/text");
  });
  it("search: hybrid/vector/keyword/structured-fallback/none", () => {
    const modes = ALLOWED_RETRIEVAL_STATES["search_ui_references"].map(s => s.mode);
    expect(modes).toContain("hybrid");
    expect(modes).toContain("vector");
    expect(modes).toContain("keyword");
  });
});

describe("RetrievalState", () => {
  it("rejects structured-fallback with fallbackUsed:false", () => {
    expect(RetrievalState.safeParse({ mode: "structured-fallback", modality: "metadata", resultCount: 0, fallbackUsed: false }).success).toBe(false);
  });
  it("rejects attemptedModes containing current mode", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", resultCount: 3, fallbackUsed: true, fallbackReason: "missing-index", attemptedModes: ["keyword"] }).success).toBe(false);
  });
  it("requires resultCount", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "text", fallbackUsed: false }).success).toBe(false);
  });
  it("rejects bad attemptedModes", () => {
    const base = { mode: "keyword", modality: "text", resultCount: 3, fallbackUsed: true, fallbackReason: "missing-index" as const };
    expect(RetrievalState.safeParse({ ...base, attemptedModes: [] }).success).toBe(false);
    expect(RetrievalState.safeParse({ ...base, attemptedModes: ["none"] }).success).toBe(false);
    expect(RetrievalState.safeParse({ ...base, attemptedModes: ["vector"] }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

describe("Evidence", () => {
  const ev = (kind: string, basis: string, extra: Record<string, unknown> = {}) =>
    Evidence.safeParse({ id: "e1", kind, summary: "x", basis, ...extra }).success;

  it("corpus-observation requires referenceId", () => {
    expect(ev("corpus-observation", "visible")).toBe(false);
    expect(ev("corpus-observation", "visible", { referenceId: "r1" })).toBe(true);
  });
  it("corpus-observation rejects editorial/dom-grounded", () => {
    expect(ev("corpus-observation", "editorial", { referenceId: "r1" })).toBe(false);
    expect(ev("corpus-observation", "dom-grounded", { referenceId: "r1" })).toBe(false);
  });
  it("machine-rule rejects visible AND dom-grounded", () => {
    expect(ev("machine-rule", "editorial")).toBe(true);
    expect(ev("machine-rule", "visible")).toBe(false);
    expect(ev("machine-rule", "dom-grounded")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

describe("inputs", () => {
  it("plan requires productContext min 8", () => {
    expect(ToolInputSchemas["plan_ui_direction"].safeParse({ productContext: "short" }).success).toBe(false);
    expect(ToolInputSchemas["plan_ui_direction"].safeParse({ productContext: "a dashboard for analytics" }).success).toBe(true);
  });
  it("create_ui_spec enforces unique referenceIds", () => {
    expect(ToolInputSchemas["create_ui_spec"].safeParse({ productContext: "dashboard", referenceIds: ["r1", "r1"] }).success).toBe(false);
    expect(ToolInputSchemas["create_ui_spec"].safeParse({ productContext: "dashboard", referenceIds: ["r1", "r2"] }).success).toBe(true);
  });
  it("compare enforces unique ids", () => {
    expect(ToolInputSchemas["compare_ui_references"].safeParse({ ids: ["a", "a"] }).success).toBe(false);
    expect(ToolInputSchemas["compare_ui_references"].safeParse({ ids: ["a", "b"] }).success).toBe(true);
  });
  it("research_ui_techniques limit max 30", () => {
    expect(ToolInputSchemas["research_ui_techniques"].safeParse({ limit: 30 }).success).toBe(true);
    expect(ToolInputSchemas["research_ui_techniques"].safeParse({ limit: 31 }).success).toBe(false);
  });
  it("research_ui_palettes does NOT accept category", () => {
    expect(ToolInputSchemas["research_ui_palettes"].safeParse({ category: "dashboard" }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UiSpec
// ---------------------------------------------------------------------------

describe("UiSpec", () => {
  function valid(): Record<string, unknown> {
    return {
      specVersion: "1.0",
      context: { productContext: "A fintech dashboard" },
      designDirection: "Calm layout",
      rejectedDefaults: [], layoutRegions: [], responsiveBehavior: [],
      componentInventory: [],
      colorTokens: { primary: "#3b82f6", surface: "#fff", ink: "#1e293b", muted: "#64748b", accent: "#3b82f6" },
      colorTokenAuthority: "corpus-evidence",
      typographyTokens: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
      typographyTokenAuthority: "corpus-evidence",
      interactions: [], motionGuidance: { notes: [], evidenceUnavailable: true },
      accessibilityConstraints: [], techniques: [], antiPatterns: [],
      unavailableDecisions: [],
      acceptanceCriteria: [{
        id: "ac1", subject: "contrast", assertion: "meets-contrast",
        expectedOutcome: "4.5:1", verifier: "axe", priority: "must", evidenceIds: [],
      }],
      citedReferences: [], citedDecisions: [],
      authorityLanes: { corpusEvidence: [], machineRules: [], editorialGuidance: [] },
      provenance: { generatedAt: "2026-07-15T00:00:00Z", toolVersion: "0.2.0" },
    };
  }
  it("accepts complete valid spec", () => { expect(UiSpec.safeParse(valid()).success).toBe(true); });
  it("manual verifier requires manualSteps", () => {
    const b = valid();
    b.acceptanceCriteria = [{ id: "ac1", subject: "x", assertion: "exists", expectedOutcome: "visible", verifier: "manual", priority: "must", evidenceIds: [] }];
    expect(UiSpec.safeParse(b).success).toBe(false);
  });
  it("playwright verifier requires selector", () => {
    const b = valid();
    b.acceptanceCriteria = [{ id: "ac1", subject: "x", assertion: "exists", expectedOutcome: "visible", verifier: "playwright", priority: "must", evidenceIds: [] }];
    expect(UiSpec.safeParse(b).success).toBe(false);
  });
  it("static-analysis verifier requires command", () => {
    const b = valid();
    b.acceptanceCriteria = [{ id: "ac1", subject: "x", assertion: "exists", expectedOutcome: "visible", verifier: "static-analysis", priority: "must", evidenceIds: [] }];
    expect(UiSpec.safeParse(b).success).toBe(false);
  });
  it("rejects priority 'could'", () => {
    const b = valid();
    (b.acceptanceCriteria as Array<Record<string, unknown>>)[0].priority = "could";
    expect(UiSpec.safeParse(b).success).toBe(false);
  });
  it("accepts colorTokenAuthority 'mixed'", () => {
    const b = valid(); b.colorTokenAuthority = "mixed";
    expect(UiSpec.safeParse(b).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseToolResult
// ---------------------------------------------------------------------------

describe("parseToolResult", () => {
  it("rejects empty object", () => {
    expect(parseToolResult({}).ok).toBe(false);
  });
  it("rejects unknown tool", () => {
    expect(parseToolResult({ tool: "unknown" }).ok).toBe(false);
  });
  it("rejects error with resultCount:5 (must be 0)", () => {
    expect(parseToolResult({
      tool: "search_ui_references", schemaVersion: "1.0", status: "error", summary: "x",
      data: null, referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 5, fallbackUsed: false },
      warnings: [], error: { code: "NOT_FOUND", message: "x", retryable: false },
    }).ok).toBe(false);
  });
  it("rejects evidence referenceId not in referenceIds", () => {
    expect(parseToolResult({
      tool: "plan_ui_direction", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { direction: "calm", rejectedDefaults: [], recommendation: "x", rationale: "x", evidenceContributions: [], structuredDecisions: [] },
      referenceIds: ["r1"], warnings: [],
      evidence: [{ id: "e1", kind: "corpus-observation", referenceId: "rMISSING", summary: "x", basis: "visible" }],
      retrieval: { mode: "hybrid", modality: "text", resultCount: 1, fallbackUsed: false },
    }).ok).toBe(false);
  });
  it("rejects data IDs not matching referenceIds exactly (subset)", () => {
    expect(parseToolResult({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { results: [{ id: "a", product: "x", patternType: "dashboard", categories: [], styleTags: [], qualityScore: 5, qualityTier: "exceptional", source: { productName: "x", url: null, imageAvailable: false }, critique: "x", topTechniques: [], antiPatterns: [] }] },
      referenceIds: ["a", "ghost"], // ghost not in data
      retrieval: { mode: "hybrid", modality: "text", resultCount: 1, fallbackUsed: false },
      warnings: [],
    }).ok).toBe(false);
  });
  it("accepts valid search with exact ID match", () => {
    expect(parseToolResult({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok", summary: "1",
      data: { results: [{ id: "r1", product: "x", patternType: "dashboard", categories: [], styleTags: [], qualityScore: 5, qualityTier: "exceptional", source: { productName: "x", url: null, imageAvailable: false }, critique: "x", topTechniques: [], antiPatterns: [] }] },
      referenceIds: ["r1"],
      retrieval: { mode: "hybrid", modality: "text", resultCount: 1, fallbackUsed: false },
      warnings: [],
    }).ok).toBe(true);
  });
  it("critique_ui accepts StructuredCritique-shaped data", () => {
    expect(parseToolResult({
      tool: "critique_ui", schemaVersion: "1.0", status: "ok", summary: "x",
      data: {
        platform: "web", retrievalMode: "image", fallbackUsed: false, coverage: "full",
        summary: "good", observations: [], recommendations: [], accessibilityRisks: [],
        visualSlop: [], motion: [], appliedReferences: [], evidenceIds: [], confidence: "high",
      },
      referenceIds: [],
      retrieval: { mode: "vector", modality: "image", resultCount: 1, fallbackUsed: false },
      warnings: ["insufficient"], evidence: [],
    }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Envelope invariants via ToolResultSchemas
// ---------------------------------------------------------------------------

describe("envelope invariants", () => {
  it("rejects ok+null data", () => {
    expect(ToolResultSchemas["get_ui_taxonomy"].safeParse({
      tool: "get_ui_taxonomy", schemaVersion: "1.0", status: "ok", summary: "x",
      data: null, referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 0, fallbackUsed: false },
      warnings: [],
    }).success).toBe(false);
  });
  it("rejects error+resultCount:5", () => {
    expect(ToolResultSchemas["search_ui_references"].safeParse({
      tool: "search_ui_references", schemaVersion: "1.0", status: "error", summary: "x",
      data: null, referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 5, fallbackUsed: false },
      warnings: [], error: { code: "NOT_FOUND", message: "x", retryable: false },
    }).success).toBe(false);
  });
});
