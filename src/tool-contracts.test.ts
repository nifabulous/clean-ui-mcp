import { describe, expect, it } from "vitest";
import {
  RetrievalState, Evidence, ToolError,
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
// Retrieval matrix
// ---------------------------------------------------------------------------

describe("RetrievalState", () => {
  const ok = (m: string, mod: string, rc = 5) =>
    RetrievalState.safeParse({ mode: m, modality: mod, resultCount: rc, fallbackUsed: false }).success;

  it("accepts allowed pairs", () => {
    expect(ok("hybrid", "text")).toBe(true);
    expect(ok("vector", "text")).toBe(true);
    expect(ok("vector", "image")).toBe(true);
    expect(ok("keyword", "text")).toBe(true);
    expect(ok("keyword", "metadata")).toBe(true);
    expect(ok("none", "none", 0)).toBe(true);
  });
  it("rejects forbidden pairs", () => {
    expect(ok("none", "text")).toBe(false);
    expect(ok("keyword", "image")).toBe(false);
    expect(ok("hybrid", "image")).toBe(false);
    expect(ok("structured-fallback", "text")).toBe(false);
  });
  it("requires resultCount", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "text", fallbackUsed: false }).success).toBe(false);
  });
  it("rejects attemptedModes containing current mode", () => {
    expect(RetrievalState.safeParse({
      mode: "keyword", modality: "text", resultCount: 3, fallbackUsed: true,
      fallbackReason: "missing-index", attemptedModes: ["keyword"],
    }).success).toBe(false);
  });
  it("rejects empty/duplicate/none attemptedModes", () => {
    const base = { mode: "keyword", modality: "text", resultCount: 3, fallbackUsed: true, fallbackReason: "missing-index" as const };
    expect(RetrievalState.safeParse({ ...base, attemptedModes: [] }).success).toBe(false);
    expect(RetrievalState.safeParse({ ...base, attemptedModes: ["none"] }).success).toBe(false);
    expect(RetrievalState.safeParse({ ...base, attemptedModes: ["vector", "vector"] }).success).toBe(false);
    expect(RetrievalState.safeParse({ ...base, attemptedModes: ["vector"] }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-tool retrieval states
// ---------------------------------------------------------------------------

describe("ALLOWED_RETRIEVAL_STATES", () => {
  it("critique allows vector+image", () => {
    expect(ALLOWED_RETRIEVAL_STATES["critique_ui"].some(s => s.mode === "vector" && s.modality === "image")).toBe(true);
  });
  it("find_similar does NOT allow vector+image (text embeddings only)", () => {
    expect(ALLOWED_RETRIEVAL_STATES["find_similar_ui_references"].some(s => s.mode === "vector" && s.modality === "image")).toBe(false);
  });
  it("every tool has states", () => {
    for (const t of TOOL_CATALOG) expect(ALLOWED_RETRIEVAL_STATES[t]?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Evidence discriminated lanes
// ---------------------------------------------------------------------------

describe("Evidence", () => {
  const ev = (kind: string, basis: string, extra: Record<string, unknown> = {}) =>
    Evidence.safeParse({ id: "e1", kind, summary: "x", basis, ...extra }).success;

  it("corpus-observation requires referenceId", () => {
    expect(ev("corpus-observation", "visible")).toBe(false);
    expect(ev("corpus-observation", "visible", { referenceId: "r1" })).toBe(true);
  });
  it("corpus-observation rejects editorial/dom-grounded basis", () => {
    expect(ev("corpus-observation", "editorial", { referenceId: "r1" })).toBe(false);
    expect(ev("corpus-observation", "dom-grounded", { referenceId: "r1" })).toBe(false);
  });
  it("screen-observation rejects editorial/dom-grounded", () => {
    expect(ev("screen-observation", "visible")).toBe(true);
    expect(ev("screen-observation", "editorial")).toBe(false);
  });
  it("dom-signal rejects editorial/inferred", () => {
    expect(ev("dom-signal", "dom-grounded")).toBe(true);
    expect(ev("dom-signal", "editorial")).toBe(false);
  });
  it("editorial-guidance requires editorial", () => {
    expect(ev("editorial-guidance", "editorial")).toBe(true);
    expect(ev("editorial-guidance", "visible")).toBe(false);
  });
  it("machine-rule rejects visible", () => {
    expect(ev("machine-rule", "editorial")).toBe(true);
    expect(ev("machine-rule", "visible")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Input contracts
// ---------------------------------------------------------------------------

describe("inputs", () => {
  it("plan requires productContext min 8", () => {
    const s = ToolInputSchemas["plan_ui_direction"];
    expect(s.safeParse({ productContext: "short" }).success).toBe(false);
    expect(s.safeParse({ productContext: "a dashboard for analytics" }).success).toBe(true);
  });
  it("create_ui_spec enforces unique referenceIds", () => {
    const s = ToolInputSchemas["create_ui_spec"];
    expect(s.safeParse({ productContext: "dashboard", referenceIds: ["r1", "r1"] }).success).toBe(false);
    expect(s.safeParse({ productContext: "dashboard", referenceIds: ["r1", "r2"] }).success).toBe(true);
  });
  it("create_ui_spec allows 0 references", () => {
    expect(ToolInputSchemas["create_ui_spec"].safeParse({ productContext: "a dashboard" }).success).toBe(true);
  });
  it("compare enforces unique ids", () => {
    const s = ToolInputSchemas["compare_ui_references"];
    expect(s.safeParse({ ids: ["a", "a"] }).success).toBe(false);
    expect(s.safeParse({ ids: ["a", "b"] }).success).toBe(true);
  });
  it("research_ui_techniques limit max 30", () => {
    expect(ToolInputSchemas["research_ui_techniques"].safeParse({ limit: 30 }).success).toBe(true);
    expect(ToolInputSchemas["research_ui_techniques"].safeParse({ limit: 31 }).success).toBe(false);
  });
  it("research_ui_palettes does NOT accept category", () => {
    expect(ToolInputSchemas["research_ui_palettes"].safeParse({ category: "dashboard" }).success).toBe(false);
  });
  it("critique includes framework", () => {
    expect(ToolInputSchemas["critique_ui"].safeParse({ image_data: "x", image_mime_type: "image/png", framework: "md3" }).success).toBe(true);
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
        id: "ac1", subject: "contrast", assertion: "meets WCAG AA",
        expectedOutcome: "4.5:1", verifier: "axe", priority: "must", evidenceIds: [],
      }],
      citedReferences: [], citedDecisions: [],
      authorityLanes: { corpusEvidence: [], machineRules: [], editorialGuidance: [] },
      provenance: { generatedAt: "2026-07-15T00:00:00Z", toolVersion: "0.2.0" },
    };
  }
  it("accepts complete valid spec", () => { expect(UiSpec.safeParse(valid()).success).toBe(true); });
  it("requires specVersion", () => { const b = valid(); delete b.specVersion; expect(UiSpec.safeParse(b).success).toBe(false); });
  it("requires provenance", () => { const b = valid(); delete b.provenance; expect(UiSpec.safeParse(b).success).toBe(false); });
  it("strict-rejects unknown keys", () => { const b = valid(); b.x = 1; expect(UiSpec.safeParse(b).success).toBe(false); });
});

// ---------------------------------------------------------------------------
// Envelope invariant bypass tests
// ---------------------------------------------------------------------------

describe("envelope invariants", () => {
  it("rejects ok+null data", () => {
    expect(ToolResultSchemas["get_ui_taxonomy"].safeParse({
      tool: "get_ui_taxonomy", schemaVersion: "1.0", status: "ok", summary: "x",
      data: null, referenceIds: [],
      retrieval: { mode: "structured-fallback", modality: "metadata", resultCount: 0, fallbackUsed: false },
      warnings: [],
    }).success).toBe(false);
  });
  it("rejects error+resultCount:5 (must be 0)", () => {
    expect(ToolResultSchemas["search_ui_references"].safeParse({
      tool: "search_ui_references", schemaVersion: "1.0", status: "error", summary: "x",
      data: null, referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 5, fallbackUsed: false },
      warnings: [], error: { code: "NOT_FOUND", message: "x", retryable: false },
    }).success).toBe(false);
  });
  it("rejects non-evidence tool with evidence", () => {
    expect(ToolResultSchemas["search_ui_references"].safeParse({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { results: [] }, referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 0, fallbackUsed: false },
      warnings: [],
      evidence: [{ id: "e1", kind: "corpus-observation", summary: "x", basis: "visible", referenceId: "r1" }],
    }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseToolResult — integrity checks
// ---------------------------------------------------------------------------

describe("parseToolResult integrity", () => {
  it("rejects mismatched resultCount", () => {
    expect(parseToolResult({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { results: [] }, referenceIds: [],
      retrieval: { mode: "hybrid", modality: "text", resultCount: 9, fallbackUsed: false },
      warnings: [],
    }).ok).toBe(false);
  });
  it("rejects duplicate referenceIds", () => {
    expect(parseToolResult({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { results: [{ id: "a", product: "x", patternType: "dashboard", categories: [], styleTags: [], qualityScore: 5, qualityTier: "exceptional", source: { productName: "x", url: null, imageAvailable: false }, critique: "x", topTechniques: [], antiPatterns: [] }] },
      referenceIds: ["a", "a"],
      retrieval: { mode: "hybrid", modality: "text", resultCount: 1, fallbackUsed: false },
      warnings: [],
    }).ok).toBe(false);
  });
  it("rejects duplicate evidence IDs", () => {
    expect(parseToolResult({
      tool: "plan_ui_direction", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { direction: "calm", rejectedDefaults: [], recommendation: "x", rationale: "x", evidenceContributions: [], structuredDecisions: [] },
      referenceIds: [], warnings: ["insufficient"],
      evidence: [
        { id: "dup", kind: "editorial-guidance", summary: "x", basis: "editorial" },
        { id: "dup", kind: "editorial-guidance", summary: "y", basis: "editorial" },
      ],
      retrieval: { mode: "hybrid", modality: "text", resultCount: 0, fallbackUsed: false },
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
  it("rejects data id not in referenceIds", () => {
    expect(parseToolResult({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { results: [{ id: "actual", product: "x", patternType: "dashboard", categories: [], styleTags: [], qualityScore: 5, qualityTier: "exceptional", source: { productName: "x", url: null, imageAvailable: false }, critique: "x", topTechniques: [], antiPatterns: [] }] },
      referenceIds: ["different"],
      retrieval: { mode: "hybrid", modality: "text", resultCount: 1, fallbackUsed: false },
      warnings: [],
    }).ok).toBe(false);
  });
  it("rejects screen evidence from create_ui_spec", () => {
    const uiSpec = {
      specVersion: "1.0", context: { productContext: "x" }, designDirection: "x", rejectedDefaults: [],
      layoutRegions: [], responsiveBehavior: [], componentInventory: [],
      colorTokens: { primary: "#000", surface: "#fff", ink: "#000", muted: "#666", accent: "#3b82f6" },
      colorTokenAuthority: "editorial",
      typographyTokens: { heading: "a", body: "b", mono: "c" }, typographyTokenAuthority: "editorial",
      interactions: [], motionGuidance: { notes: [], evidenceUnavailable: true },
      accessibilityConstraints: [], techniques: [], antiPatterns: [], unavailableDecisions: [],
      acceptanceCriteria: [{ id: "ac1", subject: "x", assertion: "x", expectedOutcome: "x", verifier: "manual", priority: "must", evidenceIds: [] }],
      citedReferences: [], citedDecisions: [],
      authorityLanes: { corpusEvidence: [], machineRules: [], editorialGuidance: [] },
      provenance: { generatedAt: "2026-07-15T00:00:00Z", toolVersion: "0.2.0" },
    };
    expect(parseToolResult({
      tool: "create_ui_spec", schemaVersion: "1.0", status: "ok", summary: "x",
      data: uiSpec, referenceIds: [], warnings: ["insufficient"],
      evidence: [{ id: "e1", kind: "screen-observation", summary: "x", basis: "visible" }],
      retrieval: { mode: "none", modality: "none", resultCount: 0, fallbackUsed: false },
    }).ok).toBe(false);
  });
  it("accepts critique with vector+image", () => {
    expect(parseToolResult({
      tool: "critique_ui", schemaVersion: "1.0", status: "ok", summary: "x",
      data: {
        platform: "web", retrievalMode: "image", fallbackUsed: false, coverage: "full",
        summary: "good", observations: [], recommendations: [], accessibilityRisks: [],
        visualSlop: [], motion: [], appliedReferences: [], evidenceIds: [], confidence: "high",
      },
      referenceIds: [], warnings: ["insufficient"], evidence: [],
      retrieval: { mode: "vector", modality: "image", resultCount: 0, fallbackUsed: false },
    }).errors.filter(e => e.includes("retrieval"))).toEqual([]);
  });
  it("rejects empty evidence without warning", () => {
    expect(parseToolResult({
      tool: "plan_ui_direction", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { direction: "x", rejectedDefaults: [], recommendation: "x", rationale: "x", evidenceContributions: [], structuredDecisions: [] },
      referenceIds: [], warnings: [], evidence: [],
      retrieval: { mode: "hybrid", modality: "text", resultCount: 0, fallbackUsed: false },
    }).ok).toBe(false);
  });
  it("accepts error envelope with resultCount 0", () => {
    expect(parseToolResult({
      tool: "search_ui_references", schemaVersion: "1.0", status: "error", summary: "x",
      data: null, referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 0, fallbackUsed: false },
      warnings: [],
      error: { code: "NOT_FOUND", message: "x", retryable: false },
    }).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ToolResultSchemas typed data
// ---------------------------------------------------------------------------

describe("ToolResultSchemas typed data", () => {
  it("search rejects wrong data shape", () => {
    expect(ToolResultSchemas["search_ui_references"].safeParse({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { wrong: true }, referenceIds: [],
      retrieval: { mode: "hybrid", modality: "text", resultCount: 0, fallbackUsed: false },
      warnings: [],
    }).success).toBe(false);
  });
  it("create_ui_spec rejects non-UiSpec data", () => {
    expect(ToolResultSchemas["create_ui_spec"].safeParse({
      tool: "create_ui_spec", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { foo: "bar" }, referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 0, fallbackUsed: false },
      warnings: ["insufficient"], evidence: [],
    }).success).toBe(false);
  });
  it("critique_ui accepts StructuredCritique-shaped data", () => {
    expect(ToolResultSchemas["critique_ui"].safeParse({
      tool: "critique_ui", schemaVersion: "1.0", status: "ok", summary: "x",
      data: {
        platform: "web", retrievalMode: "vector", fallbackUsed: false, coverage: "full",
        summary: "good", observations: [], recommendations: [], accessibilityRisks: [],
        visualSlop: [], motion: [], appliedReferences: [], evidenceIds: [], confidence: "high",
      },
      referenceIds: [],
      retrieval: { mode: "vector", modality: "image", resultCount: 0, fallbackUsed: false },
      warnings: ["insufficient"], evidence: [],
    }).success).toBe(true);
  });
});
