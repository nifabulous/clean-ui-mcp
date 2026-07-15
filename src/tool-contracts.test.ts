import { describe, expect, it } from "vitest";
import {
  RetrievalState, ToolResultEnvelope, isAllowedRetrievalState,
  Evidence, EvidenceKind, EvidenceBasis, ToolError,
  ToolInputSchemas, ToolDataSchemas, ToolResultSchemas,
  getToolDataSchema, getToolEvidenceRequired,
  parseToolResult, UiSpec, ALLOWED_RETRIEVAL_STATES,
} from "./tool-contracts.js";
import { TOOL_CATALOG } from "./tool-catalog.js";

const RC = (n: number) => n; // resultCount shorthand

// ---------------------------------------------------------------------------
// RetrievalState — complete matrix
// ---------------------------------------------------------------------------

describe("RetrievalState — allowed combinations", () => {
  const ok = (mode: string, modality: string, extra: Record<string, unknown> = {}) =>
    RetrievalState.safeParse({ mode, modality, fallbackUsed: false, resultCount: RC(5), ...extra }).success;

  it("accepts all allowed pairs", () => {
    expect(ok("hybrid", "text")).toBe(true);
    expect(ok("vector", "text")).toBe(true);
    expect(ok("vector", "image")).toBe(true);
    expect(ok("keyword", "text")).toBe(true);
    expect(ok("keyword", "metadata")).toBe(true);
    expect(ok("structured-fallback", "metadata", { fallbackUsed: true, fallbackReason: "community-edition", attemptedModes: ["vector"] })).toBe(true);
    expect(ok("none", "none", { resultCount: 0 })).toBe(true);
  });
});

describe("RetrievalState — forbidden combinations", () => {
  const bad = (mode: string, modality: string) =>
    RetrievalState.safeParse({ mode, modality, fallbackUsed: false, resultCount: RC(5) }).success;

  it("rejects impossible pairs", () => {
    expect(bad("none", "text")).toBe(false);
    expect(bad("none", "image")).toBe(false);
    expect(bad("keyword", "image")).toBe(false);
    expect(bad("hybrid", "none")).toBe(false);
    expect(bad("hybrid", "image")).toBe(false);
    expect(bad("vector", "none")).toBe(false);
    expect(bad("structured-fallback", "text")).toBe(false);
    expect(bad("structured-fallback", "none")).toBe(false);
  });
});

describe("RetrievalState — fallback invariants", () => {
  it("rejects empty/duplicate/none attemptedModes", () => {
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: true, fallbackReason: "missing-index", resultCount: 3, attemptedModes: [] }).success).toBe(false);
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: true, fallbackReason: "missing-index", resultCount: 3, attemptedModes: ["none"] }).success).toBe(false);
    expect(RetrievalState.safeParse({ mode: "keyword", modality: "text", fallbackUsed: true, fallbackReason: "missing-index", resultCount: 3, attemptedModes: ["vector", "vector"] }).success).toBe(false);
  });
  it("requires resultCount", () => {
    expect(RetrievalState.safeParse({ mode: "hybrid", modality: "text", fallbackUsed: false }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Per-tool retrieval states
// ---------------------------------------------------------------------------

describe("ALLOWED_RETRIEVAL_STATES", () => {
  it("critique_ui allows vector + image (image-embedding path)", () => {
    const states = ALLOWED_RETRIEVAL_STATES["critique_ui"];
    expect(states.some((s) => s.mode === "vector" && s.modality === "image")).toBe(true);
  });
  it("get_ui_taxonomy does NOT allow vector + image", () => {
    const states = ALLOWED_RETRIEVAL_STATES["get_ui_taxonomy"];
    expect(states.some((s) => s.mode === "vector" && s.modality === "image")).toBe(false);
  });
  it("every tool has allowed states", () => {
    for (const tool of TOOL_CATALOG) {
      expect(ALLOWED_RETRIEVAL_STATES[tool]?.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// Evidence — discriminated lanes
// ---------------------------------------------------------------------------

describe("Evidence — semantic constraints", () => {
  it("rejects corpus-observation without referenceId", () => {
    expect(Evidence.safeParse({ id: "e1", kind: "corpus-observation", summary: "x", basis: "visible" }).success).toBe(false);
  });
  it("rejects screen-observation + editorial basis", () => {
    expect(Evidence.safeParse({ id: "e1", kind: "screen-observation", summary: "x", basis: "editorial" }).success).toBe(false);
  });
  it("rejects screen-observation + dom-grounded basis", () => {
    expect(Evidence.safeParse({ id: "e1", kind: "screen-observation", summary: "x", basis: "dom-grounded" }).success).toBe(false);
  });
  it("rejects dom-signal + editorial basis", () => {
    expect(Evidence.safeParse({ id: "e1", kind: "dom-signal", summary: "x", basis: "editorial" }).success).toBe(false);
  });
  it("rejects editorial-guidance + visible basis", () => {
    expect(Evidence.safeParse({ id: "e1", kind: "editorial-guidance", summary: "x", basis: "visible" }).success).toBe(false);
  });
  it("accepts machine-rule without referenceId (editorial basis)", () => {
    expect(Evidence.safeParse({ id: "e1", kind: "machine-rule", summary: "WCAG", basis: "editorial" }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Per-tool schema key coverage
// ---------------------------------------------------------------------------

describe("schema coverage", () => {
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
// UiSpec — complete versioned artifact
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
      colorTokens: { primary: "#3b82f6", surface: "#fff", ink: "#1e293b", muted: "#64748b" },
      colorTokenAuthority: "corpus-evidence",
      typographyTokens: { heading: "Inter", body: "Inter", mono: "JetBrains Mono" },
      typographyTokenAuthority: "corpus-evidence",
      interactions: [],
      motionGuidance: { notes: [], evidenceUnavailable: true },
      accessibilityConstraints: [],
      techniques: [],
      antiPatterns: [],
      unavailableDecisions: [],
      acceptanceCriteria: [{ criterion: "Contrast meets WCAG AA", type: "accessibility" }],
      citedReferences: [],
      authorityLanes: { corpusEvidence: [], machineRules: [], editorialGuidance: [] },
      provenance: { generatedAt: "2026-07-15T00:00:00Z", toolVersion: "0.2.0" },
    };
  }

  it("accepts a complete valid UiSpec", () => {
    expect(UiSpec.safeParse(valid()).success).toBe(true);
  });
  it("requires specVersion", () => {
    const bad = valid(); delete bad.specVersion;
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });
  it("requires context with productContext", () => {
    const bad = valid(); bad.context = {};
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });
  it("requires colorTokenAuthority", () => {
    const bad = valid(); delete bad.colorTokenAuthority;
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });
  it("requires structured acceptanceCriteria (not bare strings)", () => {
    const bad = valid(); bad.acceptanceCriteria = ["bare string"];
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });
  it("accepts zero citedReferences (sparse case)", () => {
    const spec = valid();
    expect(UiSpec.safeParse(spec).success).toBe(true);
  });
  it("requires provenance", () => {
    const bad = valid(); delete bad.provenance;
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });
  it("strict-rejects unknown keys", () => {
    const bad = valid(); bad.unexpected = true;
    expect(UiSpec.safeParse(bad).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CreateUiSpecInput — sparse case and context
// ---------------------------------------------------------------------------

describe("CreateUiSpecInput", () => {
  it("accepts zero references (sparse/editorial-only case)", () => {
    const schema = ToolInputSchemas["create_ui_spec"];
    expect(schema.safeParse({ productContext: "A dashboard" }).success).toBe(true);
  });
  it("accepts platform, framework, designSystem", () => {
    const schema = ToolInputSchemas["create_ui_spec"];
    expect(schema.safeParse({
      productContext: "Dashboard", references: ["ref-1"],
      platform: "web", framework: "react", designSystem: "Material 3",
    }).success).toBe(true);
  });
  it("requires productContext", () => {
    const schema = ToolInputSchemas["create_ui_spec"];
    expect(schema.safeParse({ references: ["ref-1"] }).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CritiqueInput — includes framework
// ---------------------------------------------------------------------------

describe("CritiqueInput", () => {
  it("includes framework arg", () => {
    const schema = ToolInputSchemas["critique_ui"];
    expect(schema.safeParse({
      image_data: "base64", image_mime_type: "image/png",
      framework: "md3",
    }).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseToolResult — result integrity
// ---------------------------------------------------------------------------

describe("parseToolResult — result integrity", () => {
  it("rejects mismatched resultCount", () => {
    const result = parseToolResult({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok",
      summary: "Found 3", data: { results: [] }, referenceIds: [],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 9 },
      warnings: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("resultCount"))).toBe(true);
  });
  it("rejects duplicate referenceIds", () => {
    const result = parseToolResult({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok",
      summary: "x", data: { results: [{ id: "a" }] },
      referenceIds: ["a", "a"],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 1 },
      warnings: [],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("referenceIds"))).toBe(true);
  });
  it("rejects duplicate evidence IDs", () => {
    const result = parseToolResult({
      tool: "plan_ui_direction", schemaVersion: "1.0", status: "ok",
      summary: "x", data: { direction: "calm" },
      referenceIds: [], warnings: ["insufficient evidence"],
      evidence: [
        { id: "dup", kind: "editorial-guidance", summary: "x", basis: "editorial" },
        { id: "dup", kind: "editorial-guidance", summary: "y", basis: "editorial" },
      ],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 0 },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("unique"))).toBe(true);
  });
  it("rejects screen-observation evidence from create_ui_spec (not a screen tool)", () => {
    const result = parseToolResult({
      tool: "create_ui_spec", schemaVersion: "1.0", status: "ok",
      summary: "Spec", data: {
        specVersion: "1.0", context: { productContext: "x" },
        designDirection: "x", rejectedDefaults: [], layoutRegions: [],
        responsiveBehavior: [], componentInventory: [],
        colorTokens: { primary: "#000", surface: "#fff", ink: "#000", muted: "#666" },
        colorTokenAuthority: "editorial",
        typographyTokens: { heading: "a", body: "b", mono: "c" },
        typographyTokenAuthority: "editorial",
        interactions: [], motionGuidance: { notes: [], evidenceUnavailable: true },
        accessibilityConstraints: [], techniques: [], antiPatterns: [],
        unavailableDecisions: [],
        acceptanceCriteria: [{ criterion: "x", type: "visual" }],
        citedReferences: [], authorityLanes: { corpusEvidence: [], machineRules: [], editorialGuidance: [] },
        provenance: { generatedAt: "2026-07-15T00:00:00Z", toolVersion: "0.2.0" },
      },
      referenceIds: [], warnings: ["insufficient evidence"],
      evidence: [{ id: "e1", kind: "screen-observation", summary: "seen", basis: "visible" }],
      retrieval: { mode: "structured-fallback", modality: "metadata", fallbackUsed: false, resultCount: 0 },
    });
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.includes("screen-observation"))).toBe(true);
  });
  it("accepts valid search result with matching count", () => {
    const result = parseToolResult({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok",
      summary: "1", data: { results: [{ id: "r1" }] },
      referenceIds: ["r1"],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 1 },
      warnings: [],
    });
    expect(result.ok).toBe(true);
  });
  it("accepts critique_ui with vector + image retrieval", () => {
    const result = parseToolResult({
      tool: "critique_ui", schemaVersion: "1.0", status: "ok",
      summary: "Critique", data: { critique: "good" },
      referenceIds: [], warnings: ["insufficient"],
      evidence: [],
      retrieval: { mode: "vector", modality: "image", fallbackUsed: false, resultCount: 3 },
    });
    expect(result.errors.filter((e) => e.includes("retrieval"))).toEqual([]);
  });
  it("rejects empty evidence without any warning", () => {
    const result = parseToolResult({
      tool: "plan_ui_direction", schemaVersion: "1.0", status: "ok",
      summary: "x", data: { direction: "x" },
      referenceIds: [], warnings: [],
      evidence: [],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 0 },
    });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ToolResultSchemas — descriptor-keyed complete envelopes
// ---------------------------------------------------------------------------

describe("ToolResultSchemas — per-tool data is typed (not z.unknown)", () => {
  it("search_ui_references schema rejects wrong data shape", () => {
    const schema = ToolResultSchemas["search_ui_references"];
    expect(schema.safeParse({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok",
      summary: "x", data: { wrong: true },
      referenceIds: [], retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 0 },
      warnings: [],
    }).success).toBe(false);
  });
  it("search_ui_references schema accepts correct data", () => {
    const schema = ToolResultSchemas["search_ui_references"];
    expect(schema.safeParse({
      tool: "search_ui_references", schemaVersion: "1.0", status: "ok",
      summary: "x", data: { results: [{ id: "r1" }] },
      referenceIds: ["r1"],
      retrieval: { mode: "hybrid", modality: "text", fallbackUsed: false, resultCount: 1 },
      warnings: [],
    }).success).toBe(true);
  });
  it("create_ui_spec schema rejects non-UiSpec data", () => {
    const schema = ToolResultSchemas["create_ui_spec"];
    expect(schema.safeParse({
      tool: "create_ui_spec", schemaVersion: "1.0", status: "ok",
      summary: "x", data: { foo: "bar" },
      referenceIds: [], retrieval: { mode: "none", modality: "none", fallbackUsed: false, resultCount: 0 },
      warnings: ["insufficient"], evidence: [],
    }).success).toBe(false);
  });
});
