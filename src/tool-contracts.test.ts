import { describe, expect, it } from "vitest";
import {
  RetrievalState, Evidence, ToolError,
  ToolInputSchemas, ToolDataSchemas, ToolResultSchemas,
  parseToolResult, UiSpec, ALLOWED_RETRIEVAL_STATES,
} from "./tool-contracts.js";
import { TOOL_CATALOG } from "./tool-catalog.js";

// ---------------------------------------------------------------------------
// Schema coverage — exact key equality with TOOL_CATALOG
// ---------------------------------------------------------------------------

describe("schema key coverage", () => {
  it("ToolInputSchemas keys == TOOL_CATALOG", () => {
    expect(Object.keys(ToolInputSchemas).sort()).toEqual([...TOOL_CATALOG].sort());
  });
  it("ToolDataSchemas keys == TOOL_CATALOG", () => {
    expect(Object.keys(ToolDataSchemas).sort()).toEqual([...TOOL_CATALOG].sort());
  });
  it("ToolResultSchemas keys == TOOL_CATALOG", () => {
    expect(Object.keys(ToolResultSchemas).sort()).toEqual([...TOOL_CATALOG].sort());
  });
});

// ---------------------------------------------------------------------------
// RetrievalState — complete matrix
// ---------------------------------------------------------------------------

describe("RetrievalState mode × modality", () => {
  const ok = (m: string, mod: string, rc = 5) =>
    RetrievalState.safeParse({ mode: m, modality: mod, resultCount: rc, fallbackUsed: false }).success;
  const bad = (m: string, mod: string, rc = 5) =>
    !RetrievalState.safeParse({ mode: m, modality: mod, resultCount: rc, fallbackUsed: false }).success;

  it("accepts allowed pairs", () => {
    expect(ok("hybrid", "text")).toBe(true);
    expect(ok("vector", "text")).toBe(true);
    expect(ok("vector", "image")).toBe(true);
    expect(ok("keyword", "text")).toBe(true);
    expect(ok("keyword", "metadata")).toBe(true);
    expect(ok("structured-fallback", "metadata")).toBe(false); // needs fallbackUsed+reason+attemptedModes
    expect(RetrievalState.safeParse({
      mode: "structured-fallback", modality: "metadata", resultCount: 5, fallbackUsed: true,
      fallbackReason: "community-edition", attemptedModes: ["vector"],
    }).success).toBe(true);
    expect(ok("none", "none", 0)).toBe(true);
  });
  it("rejects forbidden pairs", () => {
    expect(bad("none", "text")).toBe(true);
    expect(bad("keyword", "image")).toBe(true);
    expect(bad("hybrid", "image")).toBe(true);
    expect(bad("hybrid", "none")).toBe(true);
    expect(bad("vector", "none")).toBe(true);
    expect(bad("structured-fallback", "text")).toBe(true);
    expect(bad("structured-fallback", "none")).toBe(true);
  });
  it("requires resultCount", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "text", fallbackUsed: false }).success).toBe(false);
  });
  it("rejects bad attemptedModes", () => {
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
  it("taxonomy does not allow vector+image", () => {
    expect(ALLOWED_RETRIEVAL_STATES["get_ui_taxonomy"].some(s => s.mode === "vector" && s.modality === "image")).toBe(false);
  });
  it("every tool has states", () => {
    for (const t of TOOL_CATALOG) expect(ALLOWED_RETRIEVAL_STATES[t]?.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Evidence discriminated lanes
// ---------------------------------------------------------------------------

describe("Evidence constraints", () => {
  const ev = (kind: string, basis: string, extra: Record<string, unknown> = {}) =>
    Evidence.safeParse({ id: "e1", kind, summary: "x", basis, ...extra }).success;
  it("corpus-observation requires referenceId", () => {
    expect(ev("corpus-observation", "visible")).toBe(false);
    expect(ev("corpus-observation", "visible", { referenceId: "r1" })).toBe(true);
  });
  it("screen-observation rejects editorial/dom-grounded", () => {
    expect(ev("screen-observation", "visible")).toBe(true);
    expect(ev("screen-observation", "inferred")).toBe(true);
    expect(ev("screen-observation", "editorial")).toBe(false);
    expect(ev("screen-observation", "dom-grounded")).toBe(false);
  });
  it("dom-signal rejects editorial/inferred", () => {
    expect(ev("dom-signal", "dom-grounded")).toBe(true);
    expect(ev("dom-signal", "editorial")).toBe(false);
    expect(ev("dom-signal", "inferred")).toBe(false);
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

describe("input contracts", () => {
  it("plan_ui_direction requires productContext min 8", () => {
    const s = ToolInputSchemas["plan_ui_direction"];
    expect(s.safeParse({ productContext: "short" }).success).toBe(false);
    expect(s.safeParse({ productContext: "a dashboard for analytics" }).success).toBe(true);
  });
  it("plan_ui_direction accepts qualityTier and framework", () => {
    const s = ToolInputSchemas["plan_ui_direction"];
    expect(s.safeParse({ productContext: "dashboard", qualityTier: "cautionary", framework: "tokens" }).success).toBe(true);
  });
  it("create_ui_spec uses referenceIds (not references) and allows 0", () => {
    const s = ToolInputSchemas["create_ui_spec"];
    expect(s.safeParse({ productContext: "a dashboard" }).success).toBe(true);
    expect(s.safeParse({ productContext: "a dashboard", referenceIds: ["r1", "r2"] }).success).toBe(true);
    expect(s.safeParse({ productContext: "a dashboard", referenceIds: ["r1", "r2", "r3", "r4", "r5", "r6"] }).success).toBe(false);
  });
  it("create_ui_spec accepts implementationFramework and serializationFormat", () => {
    const s = ToolInputSchemas["create_ui_spec"];
    expect(s.safeParse({ productContext: "a dashboard", implementationFramework: "react", serializationFormat: "tokens" }).success).toBe(true);
  });
  it("research_ui_techniques limit max 30", () => {
    const s = ToolInputSchemas["research_ui_techniques"];
    expect(s.safeParse({ limit: 30 }).success).toBe(true);
    expect(s.safeParse({ limit: 31 }).success).toBe(false);
  });
  it("research_ui_* limit max 20 for anti_patterns/palettes", () => {
    expect(ToolInputSchemas["research_ui_anti_patterns"].safeParse({ limit: 20 }).success).toBe(true);
    expect(ToolInputSchemas["research_ui_anti_patterns"].safeParse({ limit: 21 }).success).toBe(false);
  });
  it("critique_ui includes framework", () => {
    const s = ToolInputSchemas["critique_ui"];
    expect(s.safeParse({ image_data: "x", image_mime_type: "image/png", framework: "md3" }).success).toBe(true);
  });
  it("compare requires 2-3 unique ids", () => {
    const s = ToolInputSchemas["compare_ui_references"];
    expect(s.safeParse({ ids: ["a"] }).success).toBe(false);
    expect(s.safeParse({ ids: ["a", "b"] }).success).toBe(true);
    expect(s.safeParse({ ids: ["a", "b", "c", "d"] }).success).toBe(false);
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
      designDirection: "Calm, data-dense layout",
      rejectedDefaults: [],
      layoutRegions: [],
      responsiveBehavior: [],
      componentInventory: [],
      colorTokens: { primary: "#3b82f6", surface: "#fff", ink: "#1e293b", muted: "#64748b", accent: "#3b82f6" },
      colorTokenAuthority: "corpus-evidence",
      typographyTokens: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
      typographyTokenAuthority: "corpus-evidence",
      interactions: [],
      motionGuidance: { notes: [], evidenceUnavailable: true },
      accessibilityConstraints: [],
      techniques: [],
      antiPatterns: [],
      unavailableDecisions: [],
      acceptanceCriteria: [{
        id: "ac1", subject: "contrast", assertion: "meets WCAG AA",
        expectedOutcome: "4.5:1 ratio", verifier: "axe", priority: "must", evidenceIds: [],
      }],
      citedReferences: [], citedDecisions: [],
      authorityLanes: { corpusEvidence: [], machineRules: [], editorialGuidance: [] },
      provenance: { generatedAt: "2026-07-15T00:00:00Z", toolVersion: "0.2.0" },
    };
  }
  it("accepts complete valid spec", () => { expect(UiSpec.safeParse(valid()).success).toBe(true); });
  it("requires specVersion", () => { const b = valid(); delete b.specVersion; expect(UiSpec.safeParse(b).success).toBe(false); });
  it("requires context.productContext", () => { const b = valid(); b.context = {}; expect(UiSpec.safeParse(b).success).toBe(false); });
  it("requires colorTokenAuthority", () => { const b = valid(); delete b.colorTokenAuthority; expect(UiSpec.safeParse(b).success).toBe(false); });
  it("accepts structured acceptanceCriteria", () => { expect(UiSpec.safeParse(valid()).success).toBe(true); });
  it("requires provenance", () => { const b = valid(); delete b.provenance; expect(UiSpec.safeParse(b).success).toBe(false); });
  it("strict-rejects unknown keys", () => { const b = valid(); b.x = 1; expect(UiSpec.safeParse(b).success).toBe(false); });
});

// ---------------------------------------------------------------------------
// ToolResultSchemas — per-tool data typing
// ---------------------------------------------------------------------------

describe("ToolResultSchemas typed data", () => {
  it("search rejects wrong data shape", () => {
    const s = ToolResultSchemas["search_ui_references"];
    expect(s.safeParse({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { wrong: true }, referenceIds: [],
      retrieval: { mode: "hybrid", modality: "text", resultCount: 0, fallbackUsed: false },
      warnings: [],
    }).success).toBe(false);
  });
  it("create_ui_spec rejects non-UiSpec data", () => {
    const s = ToolResultSchemas["create_ui_spec"];
    expect(s.safeParse({
      tool: "create_ui_spec", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { foo: "bar" }, referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 0, fallbackUsed: false },
      warnings: ["insufficient"], evidence: [],
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
      data: { results: [{ id: "a", product: "x", patternType: "dashboard", categories: [], styleTags: [], qualityScore: 5, qualityTier: "exceptional", source: { productName: "x", url: null }, critique: "x", topTechniques: [] }] },
      referenceIds: ["a", "a"],
      retrieval: { mode: "hybrid", modality: "text", resultCount: 1, fallbackUsed: false },
      warnings: [],
    }).ok).toBe(false);
  });
  it("rejects duplicate evidence IDs", () => {
    expect(parseToolResult({
      tool: "plan_ui_direction", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { direction: "calm", rejectedDefaults: [], recommendation: "x", rationale: "x", evidenceContributions: [] },
      referenceIds: [], warnings: ["insufficient"],
      evidence: [
        { id: "dup", kind: "editorial-guidance", summary: "x", basis: "editorial" },
        { id: "dup", kind: "editorial-guidance", summary: "y", basis: "editorial" },
      ],
      retrieval: { mode: "hybrid", modality: "text", resultCount: 0, fallbackUsed: false },
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
  it("accepts valid search", () => {
    expect(parseToolResult({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok", summary: "1",
      data: { results: [{ id: "r1", product: "x", patternType: "dashboard", categories: [], styleTags: [], qualityScore: 5, qualityTier: "exceptional", source: { productName: "x", url: null }, critique: "x", topTechniques: [] }] },
      referenceIds: ["r1"],
      retrieval: { mode: "hybrid", modality: "text", resultCount: 1, fallbackUsed: false },
      warnings: [],
    }).ok).toBe(true);
  });
  it("accepts critique with vector+image", () => {
    expect(parseToolResult({
      tool: "critique_ui", schemaVersion: "1.0", status: "ok", summary: "x",
      data: {
        critique: "good", observations: [], recommendations: [], accessibilityRisks: [],
        visualSlop: [], motion: [], appliedReferences: [], evidenceIds: [], confidence: "high",
      },
      referenceIds: [], warnings: ["insufficient"], evidence: [],
      retrieval: { mode: "vector", modality: "image", resultCount: 3, fallbackUsed: false },
    }).errors.filter(e => e.includes("retrieval"))).toEqual([]);
  });
  it("rejects empty evidence without warning", () => {
    expect(parseToolResult({
      tool: "plan_ui_direction", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { direction: "x", rejectedDefaults: [], recommendation: "x", rationale: "x", evidenceContributions: [] },
      referenceIds: [], warnings: [], evidence: [],
      retrieval: { mode: "hybrid", modality: "text", resultCount: 0, fallbackUsed: false },
    }).ok).toBe(false);
  });
  it("accepts error envelope", () => {
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
// Envelope invariant bypass tests
// ---------------------------------------------------------------------------

describe("envelope invariants via ToolResultSchemas", () => {
  it("rejects ok+null data", () => {
    const s = ToolResultSchemas["get_ui_taxonomy"];
    expect(s.safeParse({
      tool: "get_ui_taxonomy", schemaVersion: "1.0", status: "ok", summary: "x",
      data: null, referenceIds: [],
      retrieval: { mode: "structured-fallback", modality: "metadata", resultCount: 0, fallbackUsed: false },
      warnings: [],
    }).success).toBe(false);
  });
  it("rejects ok+error", () => {
    const s = ToolResultSchemas["get_ui_taxonomy"];
    expect(s.safeParse({
      tool: "get_ui_taxonomy", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { patternTypes: { count: 0, values: [] }, categories: { count: 0, values: [] }, styleTags: { count: 0, values: [] } },
      referenceIds: [],
      retrieval: { mode: "structured-fallback", modality: "metadata", resultCount: 0, fallbackUsed: false },
      warnings: [],
      error: { code: "X", message: "x", retryable: false },
    }).success).toBe(false);
  });
  it("rejects error+non-null data", () => {
    const s = ToolResultSchemas["get_ui_taxonomy"];
    expect(s.safeParse({
      tool: "get_ui_taxonomy", schemaVersion: "1.0", status: "error", summary: "x",
      data: { patternTypes: { count: 0, values: [] }, categories: { count: 0, values: [] }, styleTags: { count: 0, values: [] } },
      referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 0, fallbackUsed: false },
      warnings: [],
      error: { code: "X", message: "x", retryable: false },
    }).success).toBe(false);
  });
  it("rejects non-evidence tool with evidence", () => {
    const s = ToolResultSchemas["search_ui_references"];
    expect(s.safeParse({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok", summary: "x",
      data: { results: [] }, referenceIds: [],
      retrieval: { mode: "none", modality: "none", resultCount: 0, fallbackUsed: false },
      warnings: [],
      evidence: [{ id: "e1", kind: "corpus-observation", summary: "x", basis: "visible", referenceId: "r1" }],
    }).success).toBe(false);
  });
});
